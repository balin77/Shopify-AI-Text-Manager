import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('~/utils/logger.server', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { sendOpsAlert, resetOpsAlertThrottle } from '~/services/ops-alert.server';

describe('sendOpsAlert', () => {
  beforeEach(() => {
    resetOpsAlertThrottle();
    vi.stubEnv('ALERT_WEBHOOK_URL', 'https://discord.example/webhook');
    vi.stubEnv('RAILWAY_ENVIRONMENT_NAME', 'development');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('posts a Discord- and Slack-shaped body naming the environment', async () => {
    const post = vi.fn(async () => undefined);
    expect(await sendOpsAlert('k', 'model down', { post })).toBe(true);
    const [url, body] = post.mock.calls[0] as unknown as [string, string];
    expect(url).toBe('https://discord.example/webhook');
    const parsed = JSON.parse(body);
    expect(parsed.content).toBe('[ContentPilot · development] model down');
    expect(parsed.text).toBe(parsed.content);
  });

  it('throttles one key, not every key', async () => {
    const post = vi.fn(async () => undefined);
    expect(await sendOpsAlert('a', 'x', { post, now: 0 })).toBe(true);
    expect(await sendOpsAlert('a', 'x', { post, now: 60_000 })).toBe(false);
    expect(await sendOpsAlert('b', 'x', { post, now: 60_000 })).toBe(true);
    expect(await sendOpsAlert('a', 'x', { post, now: 61 * 60_000 })).toBe(true);
  });

  it('sends nothing without a webhook, and never throws when the post fails', async () => {
    vi.stubEnv('ALERT_WEBHOOK_URL', '');
    expect(await sendOpsAlert('k', 'x', { post: vi.fn() })).toBe(false);
    vi.stubEnv('ALERT_WEBHOOK_URL', 'https://discord.example/webhook');
    const failing = vi.fn(async () => {
      throw new Error('network');
    });
    await expect(sendOpsAlert('k2', 'x', { post: failing })).resolves.toBe(false);
  });

  it('keeps a message inside Discord\'s 2000-character limit', async () => {
    const post = vi.fn(async () => undefined);
    await sendOpsAlert('long', 'y'.repeat(5000), { post });
    const parsed = JSON.parse((post.mock.calls[0] as unknown as [string, string])[1]);
    expect(parsed.content.length).toBeLessThanOrEqual(2000);
  });
});

describe('a failed post does not use up the throttle', () => {
  beforeEach(() => {
    resetOpsAlertThrottle();
    vi.stubEnv('ALERT_WEBHOOK_URL', 'https://discord.example/webhook');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('a once-per-period key is retried after a failed post', async () => {
    const failing = vi.fn(async () => {
      throw new Error('503');
    });
    const ok = vi.fn(async () => undefined);
    const once = { throttleMs: Number.POSITIVE_INFINITY };
    expect(await sendOpsAlert('budget:90', 'x', { ...once, post: failing })).toBe(false);
    expect(await sendOpsAlert('budget:90', 'x', { ...once, post: ok })).toBe(true);
    expect(await sendOpsAlert('budget:90', 'x', { ...once, post: ok })).toBe(false);
  });

  it('never lets provider text ping a channel', async () => {
    const post = vi.fn(async () => undefined);
    await sendOpsAlert('k', '@everyone', { post });
    const parsed = JSON.parse((post.mock.calls[0] as unknown as [string, string])[1]);
    expect(parsed.allowed_mentions).toEqual({ parse: [] });
  });
});
