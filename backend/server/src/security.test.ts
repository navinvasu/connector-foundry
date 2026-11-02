// SE-03: hardening headers on every response + CORS locked to an explicit
// allowlist outside local dev (fail-closed in production).
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import {
  applySecurity, parseOriginList, publicBaseUrl, securityConfigFromEnv, SECURITY_HEADERS,
} from './security.js';

const CONSOLE = 'https://console.connectorfoundry.com';

function app(env: NodeJS.ProcessEnv) {
  const a = express();
  applySecurity(a, env);
  a.get('/ping', (_req, res) => res.json({ pong: true }));
  return a;
}

describe('parseOriginList', () => {
  it('splits on commas, trims, and drops empties', () => {
    expect(parseOriginList(' https://a.example ,https://b.example,, ')).toEqual([
      'https://a.example', 'https://b.example',
    ]);
  });
  it('treats unset/empty as no origins', () => {
    expect(parseOriginList(undefined)).toEqual([]);
    expect(parseOriginList('')).toEqual([]);
    expect(parseOriginList(' , ')).toEqual([]);
  });
});

describe('securityConfigFromEnv', () => {
  it('an explicit allowlist always wins, in any environment', () => {
    expect(securityConfigFromEnv({ CF_CORS_ORIGINS: CONSOLE }).corsOrigins).toEqual([CONSOLE]);
    expect(securityConfigFromEnv({ CF_CORS_ORIGINS: CONSOLE, NODE_ENV: 'production' }).corsOrigins)
      .toEqual([CONSOLE]);
  });
  it('no allowlist in production fails closed (no browser origins)', () => {
    expect(securityConfigFromEnv({ NODE_ENV: 'production' }).corsOrigins).toEqual([]);
  });
  it('no allowlist outside production reflects any origin (local dev)', () => {
    expect(securityConfigFromEnv({}).corsOrigins).toBe('any');
    expect(securityConfigFromEnv({ NODE_ENV: 'development' }).corsOrigins).toBe('any');
  });
});

describe('security headers (SE-03)', () => {
  it('sets every hardening header and drops X-Powered-By', async () => {
    const res = await request(app({ CF_CORS_ORIGINS: CONSOLE })).get('/ping').set('Origin', CONSOLE);
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers[name.toLowerCase()]).toBe(value);
    }
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('applies to error responses too (mounted before routing)', async () => {
    const res = await request(app({ CF_CORS_ORIGINS: CONSOLE })).get('/missing');
    expect(res.status).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('CORS allowlist (SE-03)', () => {
  const a = () => app({ CF_CORS_ORIGINS: CONSOLE });

  it('allows a listed origin and echoes it (never *)', async () => {
    const res = await request(a()).get('/ping').set('Origin', CONSOLE);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
  });

  it('rejects an unknown origin: no CORS headers, so the browser blocks it', async () => {
    const res = await request(a()).get('/ping').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight from a listed origin with methods + headers', async () => {
    const res = await request(a())
      .options('/ping')
      .set('Origin', CONSOLE)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization, content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('answers a preflight from an unknown origin WITHOUT allow headers', async () => {
    const res = await request(a())
      .options('/ping')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
  });

  it('requests without an Origin (curl, server-to-server) are unaffected', async () => {
    const res = await request(a()).get('/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pong: true });
  });
});

describe('CORS production fail-closed (SE-03)', () => {
  it('no allowlist + production: even plausible origins get no CORS headers', async () => {
    const res = await request(app({ NODE_ENV: 'production' })).get('/ping').set('Origin', CONSOLE);
    expect(res.status).toBe(200); // server-to-server semantics stay; browsers just can't read it
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('dev default reflects any origin (local console workflow)', async () => {
    const res = await request(app({})).get('/ping').set('Origin', 'http://localhost:5174');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5174');
  });
});

describe('origin verification + public links (IN-10)', () => {
  function appWith(env: NodeJS.ProcessEnv) {
    const a = express();
    applySecurity(a, env);
    a.get('/health', (_req, res) => res.json({ ok: true }));
    a.get('/v1/x', (req, res) => res.json({ base: publicBaseUrl(req, env), ip: req.ip }));
    return a;
  }

  it('passes everything when CF_ORIGIN_SECRET is unset', async () => {
    const res = await request(appWith({})).get('/v1/x');
    expect(res.status).toBe(200);
  });

  it('403s without the CDN header, keeps /health open, passes with it', async () => {
    const a = appWith({ CF_ORIGIN_SECRET: 's3cret' });
    expect((await request(a).get('/v1/x')).status).toBe(403);
    expect((await request(a).get('/v1/x').set('x-origin-verify', 'wrong!')).status).toBe(403);
    expect((await request(a).get('/health')).status).toBe(200);
    expect((await request(a).get('/v1/x').set('x-origin-verify', 's3cret')).status).toBe(200);
  });

  it('hands out the configured public base URL, else the request host', async () => {
    const pub = await request(appWith({ CF_PUBLIC_API_BASE_URL: 'https://api.example.com/' })).get('/v1/x');
    expect(pub.body.base).toBe('https://api.example.com');
    const local = await request(appWith({})).get('/v1/x');
    expect(local.body.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('trusts the configured proxy hops for the client IP', async () => {
    const res = await request(appWith({ CF_TRUST_PROXY_HOPS: '1' })).get('/v1/x').set('x-forwarded-for', '203.0.113.9');
    expect(res.body.ip).toBe('203.0.113.9');
  });
});
