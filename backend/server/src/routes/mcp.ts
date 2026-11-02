// Hosted MCP endpoint (RL-03): POST /v1/mcp/:projectId
//
// Streamable-HTTP transport for the MCP server in src/mcp.ts. Machine
// clients only: a DP-07 gateway key (`Authorization: Bearer cf_live_…`
// or `X-API-Key`) is the credential — a key presented for another
// project answers the outsider 404 (BE-09), unknown/revoked/expired
// keys one generic 401, and a non-writable customer's key 403, exactly
// like the invoke dispatcher. The release served is selected by
// `?version=` (pinned version or the `staging`/`prod` channel alias),
// falling back to the `x-connector-version` header, then `prod`.
//
// This router parses its own JSON bodies (mounted ahead of the global
// parser in app.ts) so a malformed body answers with a JSON-RPC -32700
// parse error instead of the platform error envelope.

import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { extractGatewayKey, authenticateGatewayKey, touchGatewayKey, gatewayActor } from '../gateway-keys.js';
import { clientIpOf } from '../rate-limit.js';
import { handleMcpBody, type McpContext } from '../mcp.js';
import { one, exec, uid } from '../db.js';

const KEY_WRITABLE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export const mcpRouter = Router();

mcpRouter.use(express.json({ limit: '5mb' }));

async function mcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const presented = extractGatewayKey(req.headers ?? {});
  if (!presented) {
    res.status(401).json({
      error: 'A gateway API key is required (Authorization: Bearer cf_live_… or X-API-Key)',
      code: 'invalid_api_key', request_id: (req as any).id ?? null,
    });
    return;
  }
  try {
    const key = await authenticateGatewayKey(presented);
    if (!key) {
      res.status(401).json({
        error: 'Invalid or expired API key', code: 'invalid_api_key', request_id: (req as any).id ?? null,
      });
      return;
    }
    if (key.project_id !== req.params.projectId) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (key.customer_status && !KEY_WRITABLE_STATUSES.has(key.customer_status)) {
      res.status(403).json({ error: `Customer is ${key.customer_status} — writes are disabled` });
      return;
    }
    (req as any).gatewayKey = key;
    await touchGatewayKey(key.id);
    next();
  } catch (e) {
    next(e);
  }
}

function requestedVersion(req: Request): string {
  const fromQuery = typeof req.query.version === 'string' ? req.query.version : null;
  const fromHeader = typeof req.headers['x-connector-version'] === 'string'
    ? (req.headers['x-connector-version'] as string) : null;
  const v = (fromQuery ?? fromHeader ?? 'prod').trim();
  return v.length > 0 && v.length <= 64 ? v : 'prod';
}

/** True when the body is a single `initialize` request. */
function isInitialize(body: unknown): body is { params?: { clientInfo?: { name?: unknown; version?: unknown } } } {
  return !!body && typeof body === 'object' && !Array.isArray(body) && (body as any).method === 'initialize';
}

function clip(v: unknown, max = 120): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/**
 * D-89: sessions. `initialize` gets an Mcp-Session-Id that records the
 * client's self-reported name; later requests carrying it are attributed
 * to that client. An unknown or foreign session id is ignored (the call
 * still runs, just unattributed) — sessions are telemetry, not auth.
 */
async function sessionFor(req: Request, projectId: string): Promise<McpContext['session']> {
  const sid = clip(req.headers['mcp-session-id'], 64);
  if (!sid) return undefined;
  const row = await one<any>(
    `SELECT s.id, s.client_name,
            (SELECT MAX(created_at) FROM telemetry_events WHERE session_id = s.id) AS last_call_at
       FROM mcp_sessions s WHERE s.id = $1 AND s.project_id = $2`, [sid, projectId]);
  if (!row) return undefined;
  await exec(`UPDATE mcp_sessions SET last_seen_at = now() WHERE id = $1`, [sid]);
  return { id: row.id, clientName: row.client_name ?? null, lastCallAt: row.last_call_at ? new Date(row.last_call_at) : null };
}

mcpRouter.post('/:projectId', mcpAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = (req as any).gatewayKey;
    const projectId = req.params.projectId;
    let session = await sessionFor(req, projectId);
    if (isInitialize(req.body)) {
      const info = req.body.params?.clientInfo ?? {};
      const id = uid();
      await exec(
        `INSERT INTO mcp_sessions (id, project_id, client_name, client_version, actor) VALUES ($1, $2, $3, $4, $5)`,
        [id, projectId, clip(info.name), clip(info.version, 40), key ? gatewayActor(key) : null]);
      session = { id, clientName: clip(info.name), lastCallAt: null };
      res.setHeader('Mcp-Session-Id', id);
    }
    const out = await handleMcpBody(req.body, {
      projectId,
      version: requestedVersion(req),
      actor: key ? gatewayActor(key) : undefined,
      clientIp: clientIpOf(req as any),
      session,
      keyLabel: key?.label,
    });
    if (out === null) {
      // Notification(s) only — Streamable HTTP answers 202 with no body.
      res.status(202).end();
      return;
    }
    res.status(200).json(out);
  } catch (e) {
    next(e);
  }
});

// Streamable HTTP without an SSE stream: GET/DELETE are not offered.
mcpRouter.all('/:projectId', (_req: Request, res: Response) => {
  res.set('Allow', 'POST').status(405).json({
    jsonrpc: '2.0', id: null,
    error: { code: -32000, message: 'Method not allowed: this MCP server is POST-only (no SSE stream).' },
  });
});

// Body-parser failures on this router are protocol parse errors.
mcpRouter.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof SyntaxError || err?.type === 'entity.parse.failed') {
    res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  next(err);
});
