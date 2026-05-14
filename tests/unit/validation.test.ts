/**
 * Unit Tests for app/utils/validation.ts – parseJsonBody
 *
 * ✅ No database or network needed
 * ✅ Fast (<50ms per test)
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  parseJsonBody,
  SyncContentQuerySchema,
} from '~/utils/validation';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJsonRequest(body: unknown): Request {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makePlainRequest(body: string): Request {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
  });
}

// ── parseJsonBody() ──────────────────────────────────────────────────────────

describe('parseJsonBody()', () => {
  const TestSchema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  it('should return success with typed data for a valid JSON body', async () => {
    const request = makeJsonRequest({ name: 'Alice', age: 30 });
    const result = await parseJsonBody(request, TestSchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Alice');
      expect(result.data.age).toBe(30);
    }
  });

  it('should return failure when a required field is missing', async () => {
    const request = makeJsonRequest({ name: 'Bob' }); // missing age
    const result = await parseJsonBody(request, TestSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/age/);
    }
  });

  it('should return failure when a field has the wrong type', async () => {
    const request = makeJsonRequest({ name: 'Charlie', age: 'not-a-number' });
    const result = await parseJsonBody(request, TestSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(400);
    }
  });

  it('should return failure for malformed JSON', async () => {
    const request = makePlainRequest('{this is not json}');
    const result = await parseJsonBody(request, TestSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(400);
      expect(result.error).toBe('Invalid JSON body');
    }
  });

  it('should return failure for empty body (not valid JSON)', async () => {
    const request = makePlainRequest('');
    const result = await parseJsonBody(request, TestSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(400);
    }
  });
});

// ── SyncContentQuerySchema ───────────────────────────────────────────────────

describe('SyncContentQuerySchema', () => {
  it('should accept a valid comma-separated types string', () => {
    const result = SyncContentQuerySchema.safeParse({ types: 'pages,collections' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.types).toEqual(['pages', 'collections']);
    }
  });

  it('should default to all types when types is omitted', () => {
    const result = SyncContentQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.types).toContain('pages');
      expect(result.data.types).toContain('collections');
      expect(result.data.types).toContain('articles');
      expect(result.data.types).toContain('policies');
      expect(result.data.types).toContain('themes');
    }
  });

  it('should reject unknown content types', () => {
    const result = SyncContentQuerySchema.safeParse({ types: 'pages,videos' });
    expect(result.success).toBe(false);
  });

  it('should trim whitespace around type names', () => {
    const result = SyncContentQuerySchema.safeParse({ types: ' pages , articles ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.types).toEqual(['pages', 'articles']);
    }
  });
});
