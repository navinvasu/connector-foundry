// CD-02: the served OpenAPI document must cover every endpoint tabled in
// backend/README.md (with request/response examples), stay structurally
// valid, and never carry secret-shaped example values.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { buildControlPlaneOpenApi, renderApiReferenceHtml, apiDocsRouter, API_DOCS_VERSION } from './api-docs.js';

type Spec = ReturnType<typeof buildControlPlaneOpenApi>;
const spec = buildControlPlaneOpenApi() as unknown as {
  openapi: string;
  info: { title: string; version: string };
  security: unknown[];
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
  paths: Record<string, Record<string, {
    operationId?: string; summary?: string; security?: unknown[];
    parameters?: unknown[]; requestBody?: { content?: Record<string, { example?: unknown }> };
    responses: Record<string, { content?: Record<string, { example?: unknown }> }>;
  }>>;
};

function operations(s: typeof spec) {
  const out: { method: string; path: string; op: (typeof s.paths)[string][string] }[] = [];
  for (const [path, item] of Object.entries(s.paths)) {
    for (const [method, op] of Object.entries(item)) out.push({ method, path, op });
  }
  return out;
}

/** `:id` (README) → `{id}` (OpenAPI) so tabled paths compare equal. */
function normalizePath(p: string): string {
  return p.replace(/:([A-Za-z]+)/g, '{$1}').replace(/\/+$/, '') || '/';
}

/**
 * Every endpoint the README promises, extracted from its tables:
 * backticked `METHOD /path` cells (incl. `·`-joined pairs and the
 * `/reactivate` fragment) plus `METHOD[/METHOD] | /path` reference rows.
 */
function readmeEndpoints(): { method: string; path: string }[] {
  const text = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
  const found = new Map<string, { method: string; path: string }>();
  const add = (method: string, path: string) => {
    const clean = path.split('?')[0].replace(/[`.,;]+$/, '');
    if (!clean.startsWith('/')) return;
    found.set(`${method} ${normalizePath(clean)}`, { method, path: normalizePath(clean) });
  };
  // Backticked METHOD+path tokens, in document order (for fragments).
  // Line-aware: fenced code blocks (```) must not pair backticks across
  // the document, so only inline spans within one non-fence line count.
  const tokens: { text: string; line: number }[] = [];
  let inFence = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) tokens.push({ text: m[1], line: i });
  }
  let previousPath: string | null = null;
  let previousLine = -1;
  for (const { text: token, line } of tokens) {
    const full = token.match(/^(GET|POST|PATCH|DELETE|PUT)\s+(\/\S+)$/);
    if (full) {
      add(full[1], full[2]);
      previousPath = full[2];
      previousLine = line;
      continue;
    }
    // Fragment like `/reactivate` after `POST /v1/admin/customers/:id/suspend`
    // on the same line (`·`-joined) expands against that endpoint's parent.
    if (/^\/[a-z-]+$/.test(token) && previousPath && line === previousLine) {
      const parent = previousPath.slice(0, previousPath.lastIndexOf('/'));
      add('POST', `${parent}${token}`);
    }
  }
  // Reference-table rows: | GET/POST | `/v1/projects` | …
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const methods = cells[1].match(/^(GET|POST|PATCH|DELETE|PUT)(\/(GET|POST|PATCH|DELETE|PUT))*$/);
    const pathCell = cells[2].replace(/`/g, '');
    if (methods && pathCell.startsWith('/')) {
      for (const method of cells[1].split('/')) add(method, pathCell);
    }
  }
  return [...found.values()];
}

describe('CD-02 control-plane OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 skeleton with auth schemes and error schema', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.version).toBe(API_DOCS_VERSION);
    expect(spec.security).toEqual([{ BearerAuth: [] }]);
    expect(Object.keys(spec.components.securitySchemes).sort()).toEqual(['BearerAuth', 'GatewayBearer', 'GatewayKey']);
    expect(spec.components.schemas.Error).toBeDefined();
    expect(operations(spec).length).toBeGreaterThanOrEqual(60);
  });

  it('gives every operation a unique operationId, a summary, and an exemplified 2xx', () => {
    const ids = new Set<string>();
    for (const { method, path, op } of operations(spec)) {
      expect(op.operationId, `${method} ${path}`).toBeTruthy();
      expect(ids.has(op.operationId!), `${method} ${path} duplicate operationId`).toBe(false);
      ids.add(op.operationId!);
      expect(op.summary!.length, `${method} ${path}`).toBeGreaterThan(0);
      const success = Object.entries(op.responses).find(([s]) => s.startsWith('2'));
      expect(success, `${method} ${path} needs a 2xx`).toBeDefined();
      expect(success![1].content?.['application/json']?.example, `${method} ${path} 2xx example`).toBeDefined();
      if (op.requestBody) {
        expect(
          op.requestBody.content?.['application/json']?.example,
          `${op.operationId} request example`,
        ).toBeDefined();
      }
    }
  });

  it('covers every endpoint tabled in backend/README.md, each with examples', () => {
    const wanted = readmeEndpoints();
    // Guard the extractor itself: the README tables are the AC source.
    expect(wanted.length).toBeGreaterThanOrEqual(40);
    const missing: string[] = [];
    for (const { method, path } of wanted) {
      const op = spec.paths[path]?.[method.toLowerCase()];
      if (!op) {
        missing.push(`${method} ${path}`);
        continue;
      }
      const success = Object.entries(op.responses).find(([s]) => s.startsWith('2'));
      if (success?.[1].content?.['application/json']?.example === undefined) {
        missing.push(`${method} ${path} (no response example)`);
      }
      if (op.requestBody && op.requestBody.content?.['application/json']?.example === undefined) {
        missing.push(`${method} ${path} (no request example)`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('also documents implemented surfaces beyond the README tables', () => {
    for (const [method, path] of [
      ['get', '/v1/me'], ['post', '/v1/me/organization'],
      ['get', '/v1/jobs/{jobId}'], ['get', '/v1/releases/{releaseId}/promotion-readiness'],
      ['post', '/v1/projects/{id}/credentials'], ['post', '/v1/projects/{id}/api-keys'],
      ['get', '/v1/invites/{token}'], ['post', '/v1/invites/{token}/redeem'],
      ['patch', '/v1/admin/customers/{id}/seats'], ['get', '/v1/customers/{id}/usage'],
    ] as const) {
      expect(spec.paths[path]?.[method], `${method} ${path}`).toBeDefined();
    }
  });

  it('keeps public endpoints public and human endpoints behind BearerAuth', () => {
    for (const path of ['/health', '/v1/openapi.json', '/v1/docs', '/v1/invites/{token}', '/v1/billing/webhook']) {
      const op = Object.values(spec.paths[path] ?? {})[0];
      expect(op?.security, path).toEqual([]);
    }
    // Data-plane surfaces accept gateway keys as well as human JWTs.
    for (const path of ['/v1/runtime/invoke', '/v1/mcp/{projectId}', '/v1/gpt-actions/{projectId}/{version}/{toolName}']) {
      expect(JSON.stringify(spec.paths[path]?.post?.security), path).toContain('GatewayKey');
    }
  });

  it('never embeds a secret-shaped example value', () => {
    const serialized = JSON.stringify(spec);
    expect(serialized).not.toMatch(/cf_live_[A-Za-z0-9_-]{16,}/);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(serialized).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it('renders an HTML reference from the same document', () => {
    const html = renderApiReferenceHtml(spec as unknown as Spec);
    expect(html).toContain('/v1/openapi.json');
    expect(html).toContain('invokeTool');
    expect(html).toContain('/v1/runtime/invoke');
    expect(html).not.toContain('<script');
  });
});

describe('CD-02 docs routes (public, no DB)', () => {
  function app() {
    const a = express();
    a.use('/v1', apiDocsRouter);
    return a;
  }

  it('serves the OpenAPI document without credentials', async () => {
    const res = await request(app()).get('/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/v1/runtime/invoke'].post.operationId).toBe('invokeTool');
  });

  it('serves the HTML reference', async () => {
    const res = await request(app()).get('/v1/docs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/v1/openapi.json');
    expect(res.text).toContain('getHealth');
  });
});
