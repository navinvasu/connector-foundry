// BE-06: request IDs on every request/response; structured JSON logging.
// request_id in the logs always matches the X-Request-Id response header.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { requestMiddleware } from './logger.js';
import { errorHandler, notFoundHandler, HttpError, asyncHandler } from './errors.js';

function buildApp() {
  const app = express();
  app.use(requestMiddleware());
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.get(
    '/boom',
    asyncHandler(async () => {
      throw new HttpError(500, 'boom_fail');
    }),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let stdoutLines: string[];
let stderrLines: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutLines = [];
  stderrLines = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    stdoutLines.push(String(chunk));
    return true;
  }) as any);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
    stderrLines.push(String(chunk));
    return true;
  }) as any);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function parsed(lines: string[]) {
  return lines.map((l) => JSON.parse(l.trim()));
}

function requestLogLine() {
  const lines = parsed(stdoutLines);
  const line = lines.find((l) => l.msg === 'request');
  expect(line).toBeDefined();
  return line as Record<string, any>;
}

describe('requestMiddleware', () => {
  it('sets X-Request-Id on every response and logs one structured line', async () => {
    const res = await request(buildApp()).get('/ok');
    const headerId = res.headers['x-request-id'];
    expect(headerId).toBeTruthy();
    expect(headerId).toMatch(/^[0-9a-f-]{36}$/); // UUID by default

    const line = requestLogLine();
    expect(line.request_id).toBe(headerId);
    expect(line.method).toBe('GET');
    expect(line.path).toBe('/ok');
    expect(line.status).toBe(200);
    expect(typeof line.duration_ms).toBe('number');
    // log line envelope
    expect(line.level).toBe('info');
    expect(line.service).toBe('connector-foundry-server');
    expect(new Date(line.timestamp).getTime()).not.toBeNaN();
  });

  it('honors a valid inbound X-Request-Id for cross-service tracing', async () => {
    const res = await request(buildApp()).get('/ok').set('X-Request-Id', 'trace-123');
    expect(res.headers['x-request-id']).toBe('trace-123');
    expect(requestLogLine().request_id).toBe('trace-123');
  });

  it('rejects an abusive inbound X-Request-Id and mints a fresh one', async () => {
    const evil = 'x'.repeat(500);
    const res = await request(buildApp()).get('/ok').set('X-Request-Id', evil);
    expect(res.headers['x-request-id']).not.toBe(evil);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('404 responses carry the request id in header and body', async () => {
    const res = await request(buildApp()).get('/nope');
    expect(res.status).toBe(404);
    const headerId = res.headers['x-request-id'];
    expect(headerId).toBeTruthy();
    expect(res.body.request_id).toBe(headerId);
    expect(requestLogLine().request_id).toBe(headerId);
  });

  it('500s: error body request_id matches the header and the error log line', async () => {
    const res = await request(buildApp()).get('/boom');
    expect(res.status).toBe(500);
    const headerId = res.headers['x-request-id'];
    expect(res.body.request_id).toBe(headerId);
    expect(res.body.error).not.toContain('boom'); // internals stay hidden

    const errLines = parsed(stderrLines).filter((l) => l.level === 'error' && l.request_id === headerId);
    expect(errLines.length).toBeGreaterThan(0);
    expect(errLines[0].code).toBe('boom_fail');
  });

  it('emits exactly one request log line per request', async () => {
    await request(buildApp()).get('/ok');
    await request(buildApp()).get('/ok');
    expect(parsed(stdoutLines).filter((l) => l.msg === 'request')).toHaveLength(2);
  });
});
