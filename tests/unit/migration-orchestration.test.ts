import { EventEmitter } from "events";
import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import { main as startMainTyped } from "../../start.js";
const startMain: any = startMainTyped;
import { main as runMigrationTyped } from "../../scripts/run-migration.js";
const runMigration: any = runMigrationTyped;
import { migrationsAlreadyRun } from "../../scripts/start-plan.js";
import { readSchemaState as readSchemaStateTyped } from "../../scripts/read-schema-state.js";
const readSchemaState: any = readSchemaStateTyped;

const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

function fakeProc() {
  const p: any = new EventEmitter();
  p.exit = vi.fn();
  return p;
}
function fakeSpawn() {
  const calls: string[][] = [];
  const children: any[] = [];
  const spawn = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const c: any = new EventEmitter();
    c.kill = vi.fn();
    children.push(c);
    return c;
  };
  return { spawn, calls, children };
}

describe("start.js", () => {
  it("with MIGRATIONS_ALREADY_RUN=1 never spawns run-migration, starts the server", () => {
    quiet();
    const { spawn, calls } = fakeSpawn();
    startMain({ spawn, env: { MIGRATIONS_ALREADY_RUN: "1" }, proc: fakeProc() });
    expect(calls).toEqual([["node", "server.js"]]);
  });
  it("without the marker runs run-migration first, then the server", () => {
    quiet();
    const { spawn, calls, children } = fakeSpawn();
    startMain({ spawn, env: {}, proc: fakeProc() });
    expect(calls).toEqual([["node", "scripts/run-migration.js"]]);
    children[0].emit("exit", 0);
    expect(calls[1]).toEqual(["node", "server.js"]);
  });
  it("a failing migration does not start the server", () => {
    quiet();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { spawn, calls, children } = fakeSpawn();
    const proc = fakeProc();
    startMain({ spawn, env: {}, proc });
    children[0].emit("exit", 1);
    expect(calls).toHaveLength(1);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });
  it("marker is exact '1' and the production script sets it", () => {
    expect(migrationsAlreadyRun({ MIGRATIONS_ALREADY_RUN: "true" })).toBe(false);
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["start:production"]).toMatch(/MIGRATIONS_ALREADY_RUN=1 node start\.js$/);
    expect(pkg.scripts.start).not.toContain("MIGRATIONS_ALREADY_RUN");
  });
});

const local = ["m1", "m2"];
const done = (n: string) => ({ migration_name: n, finished_at: new Date(), rolled_back_at: null });
const current = { localMigrations: local, dbRows: [done("m1"), done("m2"), { migration_name: "m3", finished_at: null, rolled_back_at: null }], invalidIndexes: [] };
const notCurrent = { localMigrations: local, dbRows: [done("m1")] };

async function runWith(opts: { deploy: boolean; env?: Record<string, string>; state: any }) {
  quiet();
  const commands: string[] = [];
  const run = (cmd: string) => {
    commands.push(cmd);
    if (cmd.includes("migrate deploy")) return opts.deploy;
    return true;
  };
  const exit = vi.fn();
  await runMigration({
    run,
    env: { DATABASE_URL: "x", ...(opts.env ?? {}) },
    exit,
    readState: async () => opts.state,
    fixFailed: async () => {},
  });
  return { commands, exit };
}
const pushed = (c: string[]) => c.some((x) => x.includes("db push"));

describe("run-migration.js after a failed migrate deploy", () => {
  it("schema current, no flag: continues, never db push", async () => {
    const { commands, exit } = await runWith({ deploy: false, state: current });
    expect(pushed(commands)).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });
  it("schema not current, no flag: aborts, never db push", async () => {
    const { commands, exit } = await runWith({ deploy: false, state: notCurrent });
    expect(pushed(commands)).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });
  it("schema current but an INVALID index: aborts, never db push, even with the flag", async () => {
    for (const env of [{}, { ALLOW_DB_PUSH_FALLBACK: "true" }] as Record<string, string>[]) {
      const { commands, exit } = await runWith({ deploy: false, state: { ...current, invalidIndexes: ["i"] }, env });
      expect(pushed(commands)).toBe(false);
      expect(exit).toHaveBeenCalledWith(1);
    }
  });
  it("state unreadable, no flag: aborts, never db push", async () => {
    const { commands, exit } = await runWith({ deploy: false, state: null });
    expect(pushed(commands)).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
  });
  it("flag + schema not current: db push may run", async () => {
    const { commands, exit } = await runWith({ deploy: false, state: notCurrent, env: { ALLOW_DB_PUSH_FALLBACK: "true" } });
    expect(pushed(commands)).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });
  it("flag + schema current: still no db push (current schema wins)", async () => {
    const { commands } = await runWith({ deploy: false, state: current, env: { ALLOW_DB_PUSH_FALLBACK: "true" } });
    expect(pushed(commands)).toBe(false);
  });
  it("successful deploy: no push", async () => {
    const { commands, exit } = await runWith({ deploy: true, state: null });
    expect(pushed(commands)).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("readSchemaState", () => {
  it("returns null when the DB cannot be read", async () => {
    const s = await readSchemaState({
      listDir: () => ["a"],
      isDir: () => true,
      makePrisma: async () => {
        throw new Error("down");
      },
    });
    expect(s).toBeNull();
  });
  it("returns folders and rows", async () => {
    const s = await readSchemaState({
      listDir: () => ["a", "b"],
      isDir: (p: string) => p.endsWith("/a"),
      makePrisma: async () => ({ $queryRawUnsafe: async () => [1], $disconnect: async () => {} }),
    });
    expect(s).toMatchObject({ localMigrations: ["a"], dbRows: [1] });
  });
  it("lists invalid indexes; a failed pg_index read is null", async () => {
    const mk = (idx: () => Promise<any[]>) => async () => ({
      $queryRawUnsafe: async (q: string) => (q.includes("pg_index") ? idx() : []),
      $disconnect: async () => {},
    });
    const base = { listDir: () => ["a"], isDir: () => true };
    expect((await readSchemaState({ ...base, makePrisma: mk(async () => [{ index_name: "x" }]) })).invalidIndexes).toEqual(["x"]);
    expect((await readSchemaState({ ...base, makePrisma: mk(async () => { throw new Error("no"); }) })).invalidIndexes).toBeNull();
  });
});

describe("no other start-path script falls back to db push", () => {
  it("none of them contains db push or migrate deploy", () => {
    for (const f of [
      "scripts/validate-env.js",
      "start.js",
      "scripts/migrate-encrypt-api-keys.ts",
      "scripts/migrate-encrypt-session-pii.ts",
      "scripts/migrate-encrypt-webhook-payloads.ts",
    ]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/db push|migrate deploy/);
    }
  });
});

describe("railway.json restart policy", () => {
  it("bounds restarts of a broken deploy", () => {
    const d = JSON.parse(readFileSync("railway.json", "utf8")).deploy;
    expect(d.restartPolicyType).toBe("ON_FAILURE");
    expect(d.restartPolicyMaxRetries).toBe(5);
  });
});
