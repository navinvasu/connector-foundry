// GPT Actions execution surface (RL-04): POST /v1/gpt-actions/:projectId/:version/:toolName
//
// The OpenAPI document generated per release points its operations
// here. Machine clients only: a DP-07 gateway key (`Authorization:
// Bearer cf_live_…` or `X-API-Key`) is the credential — an unknown /
// expired / revoked key answers one generic 401, a key for another
// project the outsider 404, and a non-writable customer's key 403,
// exactly like the MCP endpoint and the invoke dispatcher. Each call
// delegates to the data plane (runtime.invoke), so signature checks,
// credential injection (AB-02), egress policy (SE-08), rate limits
// (BE-07/SE-09), redaction (DP-05), and telemetry apply unchanged —
// there is no parallel execution path.
//
// The request body IS the tool's argument object (the generated
// operation's requestBody schema is the tool's input schema). Invoke
// failures map to honest HTTP statuses for the GPT caller: unknown
// project/release/tool 404, credential/policy refusals 403, rate
// limits 429, everything else 502 with the invoke condition named.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { extractGatewayKey, authenticateGatewayKey, touchGatewayKey, gatewayActor } from '../gateway-keys.js';
import { clientIpOf } from '../rate-limit.js';
import { invoke, type InvokeResult } from '../runtime.js';
import { inferTrigger } from '../attribution.js';
import { one } from '../db.js';

const KEY_WRITABLE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export const gptActionsRouter = Router();

async function gptActionsAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
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

const NOT_FOUND_CONDITIONS = new Set(['UNKNOWN_RELEASE', 'UNKNOWN_TOOL', 'RELEASE_CHANNEL_EMPTY']);
const FORBIDDEN_CONDITIONS = new Set(['CREDENTIAL_REQUIRED', 'CREDENTIAL_STORAGE_NOT_CONFIGURED', 'EGRESS_BLOCKED']);

/** Map a failed invoke onto the status the GPT caller should see. */
export function statusForInvokeFailure(res: InvokeResult): number {
  const condition = res.error?.condition ?? '';
  if (condition === 'RATE_LIMITED') return 429;
  if (NOT_FOUND_CONDITIONS.has(condition)) return 404;
  if (FORBIDDEN_CONDITIONS.has(condition)) return 403;
  return 502;
}

gptActionsRouter.post('/:projectId/:version/:toolName', gptActionsAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = (req as any).gatewayKey;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
    // D-89: ChatGPT sends its conversation id on action calls; it is the
    // session, and call timing within it separates user turns from follow-ups.
    const conversation = typeof req.headers['openai-conversation-id'] === 'string'
      ? req.headers['openai-conversation-id'].slice(0, 120) : null;
    const last = conversation
      ? await one<any>(`SELECT MAX(created_at) AS at FROM telemetry_events WHERE session_id = $1 AND project_id = $2`,
        [conversation, req.params.projectId])
      : null;
    const result = await invoke({
      project_id: req.params.projectId,
      version: req.params.version,
      tool_name: req.params.toolName,
      args: body,
      client_ip: clientIpOf(req as any),
      actor: key ? gatewayActor(key) : undefined,
      attribution: {
        channel: 'openai_actions',
        client: 'chatgpt',
        trigger: conversation ? inferTrigger(last?.at ? new Date(last.at) : null) : 'unknown',
        trigger_source: 'inferred',
        session_id: conversation,
      },
    });
    if (result.ok) {
      res.status(200).json(result.result ?? null);
      return;
    }
    res.status(statusForInvokeFailure(result)).json({
      error: {
        condition: result.error?.condition ?? 'INVOKE_FAILED',
        message: result.error?.message ?? 'The tool call failed.',
      },
    });
  } catch (e) {
    next(e);
  }
});
