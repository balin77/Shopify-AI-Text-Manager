import { describe, it, expect } from 'vitest';
// Plain .mjs helper module — tsc infers its types via allowJs, no .d.ts needed.
import {
  backupObjectKey,
  formatBytes,
  isDumpClientCompatible,
  parseClientMajor,
  parseServerMajor,
  pgEnvFromUrl,
  redactSecrets,
  selectPrunable,
} from '../../scripts/db-backup.lib.mjs';

const day = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-17T12:00:00Z');

/** Build a listing entry the way ListObjectsV2 returns it. */
function obj(key: string, ageDays: number) {
  return { Key: key, LastModified: new Date(NOW.getTime() - ageDays * day) };
}

describe('parseClientMajor', () => {
  it('reads the major out of a pg_dump banner', () => {
    expect(parseClientMajor('pg_dump (PostgreSQL) 17.2')).toBe(17);
  });

  it('reads the major out of a distro-suffixed psql banner', () => {
    expect(parseClientMajor('psql (PostgreSQL) 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)')).toBe(16);
  });

  it('returns null for unparseable input instead of guessing', () => {
    expect(parseClientMajor('')).toBeNull();
    expect(parseClientMajor('command not found')).toBeNull();
    expect(parseClientMajor(undefined)).toBeNull();
  });
});

describe('parseServerMajor', () => {
  it('decodes server_version_num', () => {
    expect(parseServerMajor('170004')).toBe(17);
    expect(parseServerMajor('160013\n')).toBe(16);
  });

  it('returns null on garbage', () => {
    expect(parseServerMajor('')).toBeNull();
    expect(parseServerMajor('nope')).toBeNull();
  });
});

describe('isDumpClientCompatible', () => {
  it('accepts an equal or newer client', () => {
    expect(isDumpClientCompatible(17, 17)).toBe(true);
    expect(isDumpClientCompatible(18, 17)).toBe(true);
  });

  it('rejects an older client — pg_dump cannot dump a newer server', () => {
    expect(isDumpClientCompatible(16, 17)).toBe(false);
  });

  it('treats an unknown version as incompatible, never as fine', () => {
    expect(isDumpClientCompatible(null, 17)).toBe(false);
    expect(isDumpClientCompatible(17, null)).toBe(false);
  });
});

describe('backupObjectKey', () => {
  it('partitions by UTC date and carries a sortable stamp', () => {
    expect(backupObjectKey('contentpilot', new Date('2026-08-17T11:42:05Z'))).toBe(
      'contentpilot/2026/08/17/contentpilot-20260817T114205Z.dump',
    );
  });

  it('pads single-digit components so keys sort lexicographically', () => {
    expect(backupObjectKey('cp', new Date('2026-01-02T03:04:05Z'))).toBe(
      'cp/2026/01/02/cp-20260102T030405Z.dump',
    );
  });

  it('uses UTC, not the container local zone', () => {
    // 23:30 UTC must not be filed under the next day even if TZ is ahead.
    expect(backupObjectKey('cp', new Date('2026-08-17T23:30:00Z'))).toContain('/2026/08/17/');
  });
});

describe('selectPrunable', () => {
  it('deletes dumps older than the retention window', () => {
    const objects = [
      obj('cp/a.dump', 1),
      obj('cp/b.dump', 10),
      obj('cp/c.dump', 40),
      obj('cp/d.dump', 90),
    ];
    expect(selectPrunable(objects, { now: NOW, retentionDays: 30, keepMinimum: 0 })).toEqual([
      'cp/c.dump',
      'cp/d.dump',
    ]);
  });

  it('never deletes the newest keepMinimum dumps, however old they all are', () => {
    // The cron stopped months ago: every dump is past retention. Wiping the
    // bucket would turn a stalled backup into no backup at all.
    const objects = [
      obj('cp/a.dump', 200),
      obj('cp/b.dump', 210),
      obj('cp/c.dump', 220),
      obj('cp/d.dump', 230),
    ];
    const pruned = selectPrunable(objects, { now: NOW, retentionDays: 30, keepMinimum: 3 });
    expect(pruned).toEqual(['cp/d.dump']);
  });

  it('keeps everything when retention is disabled', () => {
    const objects = [obj('cp/a.dump', 999)];
    expect(selectPrunable(objects, { now: NOW, retentionDays: 0, keepMinimum: 0 })).toEqual([]);
    expect(selectPrunable(objects, { now: NOW, retentionDays: NaN, keepMinimum: 0 })).toEqual([]);
  });

  it('ignores objects that are not dumps', () => {
    const objects = [obj('cp/README.md', 400), obj('cp/notes.txt', 400), obj('cp/a.dump', 400)];
    expect(selectPrunable(objects, { now: NOW, retentionDays: 30, keepMinimum: 0 })).toEqual([
      'cp/a.dump',
    ]);
  });

  it('skips entries without a usable timestamp rather than guessing their age', () => {
    const objects = [
      { Key: 'cp/a.dump', LastModified: undefined },
      { Key: 'cp/b.dump', LastModified: 'not-a-date' },
      obj('cp/c.dump', 400),
    ];
    expect(selectPrunable(objects, { now: NOW, retentionDays: 30, keepMinimum: 0 })).toEqual([
      'cp/c.dump',
    ]);
  });

  it('is a no-op on an empty or malformed listing', () => {
    expect(selectPrunable([], { now: NOW, retentionDays: 30 })).toEqual([]);
    expect(selectPrunable(undefined, { now: NOW, retentionDays: 30 })).toEqual([]);
  });
});

describe('pgEnvFromUrl', () => {
  it('maps a plain connection URL onto PG* variables', () => {
    expect(pgEnvFromUrl('postgresql://user:pw@db.example.com:5433/railway')).toEqual({
      PGHOST: 'db.example.com',
      PGPORT: '5433',
      PGDATABASE: 'railway',
      PGUSER: 'user',
      PGPASSWORD: 'pw',
    });
  });

  it('defaults the port when the URL omits it', () => {
    expect(pgEnvFromUrl('postgres://u:p@host/db').PGPORT).toBe('5432');
  });

  it('percent-decodes credentials', () => {
    // A Railway password routinely contains / + and @.
    const env = pgEnvFromUrl('postgresql://user%40x:p%2Fa%2Bss@host:5432/db');
    expect(env.PGUSER).toBe('user@x');
    expect(env.PGPASSWORD).toBe('p/a+ss');
  });

  it('carries sslmode through', () => {
    expect(pgEnvFromUrl('postgresql://u:p@h:5432/db?sslmode=require').PGSSLMODE).toBe('require');
  });

  it('rejects a non-postgres URL', () => {
    expect(() => pgEnvFromUrl('mysql://u:p@h/db')).toThrow(/unsupported protocol/);
    expect(() => pgEnvFromUrl('not a url')).toThrow(/not a valid URL/);
  });

  it('rejects a URL without a database name', () => {
    expect(() => pgEnvFromUrl('postgresql://u:p@host:5432/')).toThrow(/no database name/);
  });
});

describe('redactSecrets', () => {
  it('removes a verbatim secret from text', () => {
    const url = 'postgresql://u:hunter2@host:5432/db';
    expect(redactSecrets(`connection to ${url} failed`, [url])).not.toContain('hunter2');
  });

  it('redacts the password of a postgres URL it was not given explicitly', () => {
    const out = redactSecrets('psql: error: postgresql://u:s3cret@h:5432/db is unreachable', []);
    expect(out).not.toContain('s3cret');
    expect(out).toContain('«redacted»');
  });

  it('ignores short or absent secrets so it cannot blank out normal text', () => {
    expect(redactSecrets('all good', [undefined, '', 'ab'])).toBe('all good');
  });
});

describe('formatBytes', () => {
  it('scales into readable units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
  });

  it('does not invent a number for unusable input', () => {
    expect(formatBytes(undefined)).toBe('unknown');
    expect(formatBytes(-1)).toBe('unknown');
  });
});
