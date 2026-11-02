// Structured logging + per-request tracing (BE-06).
//
// Every log line is a single JSON object on one line:
//   { timestamp, level, service, ...fields }
// `error` level goes to stderr; everything else to stdout. Fields are
// DP-05-redacted on emit, so secrets/PII in a field value can't persist.
//
// requestMiddleware() assigns req.id on EVERY request (honoring a valid
// inbound X-Request-Id so traces can cross service boundaries), mirrors it
// as the X-Request-Id response header, and emits one `request` log line per
// response so `request_id` in the logs always matches the response header.
import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { redactValue } from './redact.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id for this request, set by requestMiddleware(). */
      id?: string;
    }
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SERVICE = 'connector-foundry-server';

function emit(level: LogLevel, fields: Record<string, unknown>): void {
  // DP-05: every field is redacted before it is written — a caller logging
  // an error message or URL that embeds an email, token, or key shape can
  // never land it in the log stream. (The request line's path carries the
  // query string; sensitive params are stripped by the same pass.)
  const safe = redactValue(fields) as Record<string, unknown>;
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    ...safe,
  });
  // Single write per line keeps lines atomic on pipes.
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/** Structured JSON logger. Put context in fields; keep `msg` short. */
export const logger = {
  debug: (fields: Record<string, unknown>): void => emit('debug', fields),
  info: (fields: Record<string, unknown>): void => emit('info', fields),
  warn: (fields: Record<string, unknown>): void => emit('warn', fields),
  error: (fields: Record<string, unknown>): void => emit('error', fields),
};

const MAX_INBOUND_ID_LENGTH = 128;

/** Honor a valid inbound X-Request-Id; otherwise mint a fresh UUID. */
function resolveRequestId(req: Request): string {
  const incoming = req.header('X-Request-Id')?.trim();
  if (incoming && incoming.length <= MAX_INBOUND_ID_LENGTH && /^[\x20-\x7e]+$/.test(incoming)) {
    return incoming;
  }
  return randomUUID();
}

/**
 * Assign req.id, mirror it as the X-Request-Id response header, and log
 * one structured line per response. Mount FIRST in index.ts so 404s and
 * body-parser errors carry ids too.
 */
export function requestMiddleware(): RequestHandler {
  return (req, res, next) => {
    const id = resolveRequestId(req);
    req.id = id;
    res.setHeader('X-Request-Id', id);
    const start = Date.now();
    res.on('finish', () => {
      logger.info({
        msg: 'request',
        request_id: id,
        method: req.method,
        path: req.originalUrl ?? req.url,
        status: res.statusCode,
        duration_ms: Date.now() - start,
      });
    });
    next();
  };
}
