// Central error handling (BE-05): every API error leaves the process in a
// consistent, safe shape — { error, code, request_id }. Stack traces and
// internal messages never reach clients; 5xx are logged server-side with the
// correlation ID. Request IDs come from req.id (BE-06's requestMiddleware
// sets one on every request); a fallback UUID is minted only if the
// middleware somehow didn't run.
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { logger } from './logger.js';

/** An error with an explicit HTTP status, machine-readable code, and a
 *  client-safe message. Throw these for every expected failure; anything
 *  else becomes a generic 500. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage?: string;
  /** Client-safe structured detail merged into the error body (IA-04 issue lists). */
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, publicMessage?: string, details?: Record<string, unknown>) {
    super(publicMessage ?? code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
    this.details = details;
  }
}

const DEFAULT_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  422: 'Unprocessable entity',
  429: 'Too many requests',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Gateway timeout',
};

function defaultMessage(status: number): string {
  return DEFAULT_MESSAGES[status] ?? (status >= 500 ? 'Internal server error' : 'Request failed');
}

/**
 * Wrap an async Express handler so rejected promises reach the central
 * error middleware. Express 4 does NOT do this on its own — without the
 * wrapper a thrown async error leaves the request hanging forever.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function requestIdOf(req: Request): string {
  return req.id ?? randomUUID();
}

/**
 * Terminal error middleware — mount AFTER all routers (and after the JSON
 * 404 handler). Never sends err.stack or raw internal messages to clients.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = requestIdOf(req);
  res.setHeader('X-Request-Id', requestId);
  if (res.headersSent) {
    // Too late to respond; just make sure the failure is on record.
    logger.error({ msg: 'error after headers sent', request_id: requestId, error: err instanceof Error ? err.message : String(err) });
    return;
  }

  let status = 500;
  let code = 'internal_error';
  let message = defaultMessage(500);

  if (err instanceof HttpError) {
    status = err.status;
    code = err.code;
    message = err.publicMessage ?? defaultMessage(err.status);
  } else if (
    typeof err === 'object' && err !== null &&
    typeof (err as any).status === 'number' &&
    (err as any).status >= 400 && (err as any).status < 600
  ) {
    // Legacy deliberate errors: thrown as Object.assign(new Error(msg), { status }).
    // All such throw sites are ours (auth, billing) with client/operator-safe
    // messages; library errors (pg, Stripe) don't carry a numeric .status.
    // New code should prefer HttpError; this keeps the old throw sites working.
    status = (err as any).status;
    code = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'request_error';
    message = err instanceof Error ? err.message : String(err);
  }

  const detail = err instanceof Error ? err.message : String(err);
  if (status >= 500) {
    logger.error({
      msg: detail, request_id: requestId, status, code,
      stack: err instanceof Error ? err.stack : undefined,
    });
  } else {
    logger.warn({ msg: detail, request_id: requestId, status, code });
  }
  res.status(status).json({
    error: message, code, request_id: requestId,
    ...(err instanceof HttpError && err.details ? err.details : {}),
  });
}

/** JSON 404 for unmatched routes — mount after all routers, before errorHandler. */
export function notFoundHandler(req: Request, res: Response): void {
  const requestId = requestIdOf(req);
  res.setHeader('X-Request-Id', requestId);
  res.status(404).json({ error: 'Not found', code: 'not_found', request_id: requestId });
}
