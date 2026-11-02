// Where an agent's tool calls go.
//
// candidate — the project's current (candidate/approved) tools, called the
//   way the eval harness calls them. Used by the agent task suite, so a
//   before/after comparison needs no release. Read tools run live; write
//   tools are NOT sent: the agent gets a dry-run result naming the request
//   it would have made (EV-06 keeps evals from mutating customer data).
//
// release — a published release through the data plane (runtime.invoke),
//   exactly as an external agent would call it, recorded in telemetry as
//   the playground. Sensitive writes are held for confirmation.

import { q, J } from '../db.js';
import { callCandidateTool, describeCandidateCall, type ToolRow } from '../eval.js';
import { resolveReleaseTools } from '../mcp.js';
import { invoke } from '../runtime.js';
import { accessClassOf, agentDescription, type AccessClass } from '../tool-text.js';
import type { AgentTool, Executor } from './runner.js';

function objectSchema(raw: unknown): Record<string, unknown> {
  const parsed = typeof raw === 'string' ? J.parse<Record<string, unknown>>(raw, {}) : raw;
  const schema: Record<string, unknown> =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
  if (schema.type === undefined) schema.type = 'object';
  if (schema.properties === undefined) schema.properties = {};
  return schema;
}

export interface CandidateToolset {
  tools: AgentTool[];
  rows: Map<string, ToolRow & Record<string, unknown>>;
}

export async function candidateToolset(projectId: string): Promise<CandidateToolset> {
  const rows = (await q(
    `SELECT * FROM canonical_tools WHERE project_id = $1 AND status IN ('candidate','approved','tested','released') ORDER BY name`,
    [projectId])) as Array<ToolRow & Record<string, unknown>>;
  return {
    rows: new Map(rows.map((r) => [r.name, r])),
    tools: rows.map((r) => ({
      name: r.name,
      description: agentDescription(r),
      inputSchema: objectSchema(r.input_schema),
      accessClass: accessClassOf(r),
    })),
  };
}

export function candidateExecutor(projectId: string, toolset: CandidateToolset): Executor {
  return async (call, tool) => {
    const row = toolset.rows.get(call.name);
    if (!row || !tool) return { ok: false, body: null, error: `Unknown tool "${call.name}"`, latencyMs: 0 };
    if (tool.accessClass !== 'read') {
      return {
        ok: true,
        dryRun: true,
        body: {
          dry_run: true,
          note: 'Write tools are not executed during evaluation. This is the request that would have been sent.',
          would_send: describeCandidateCall(row, call.args),
        },
        latencyMs: 0,
      };
    }
    const r = await callCandidateTool(projectId, row, call.args);
    const ok = r.status >= 200 && r.status < 300;
    return { ok, status: r.status, body: r.body, latencyMs: r.latencyMs, ...(ok ? {} : { error: `HTTP ${r.status}` }) };
  };
}

function accessFromAnnotations(a: Record<string, unknown> | undefined): AccessClass {
  if (a?.destructiveHint === true) return 'sensitive_write';
  if (a?.readOnlyHint === true) return 'read';
  return 'write';
}

export async function releaseToolset(projectId: string, version: string): Promise<{ version: string; tools: AgentTool[] }> {
  const resolved = await resolveReleaseTools({ projectId, version });
  return {
    version: resolved.version,
    tools: resolved.tools.map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema, accessClass: accessFromAnnotations(t.annotations),
    })),
  };
}

export function releaseExecutor(projectId: string, version: string, client = 'playground'): Executor {
  return async (call, tool, ctx) => {
    if (tool?.accessClass === 'sensitive_write') {
      return {
        ok: false, body: null, latencyMs: 0,
        error: 'This tool changes data irreversibly and needs the user to confirm first; it was not called.',
      };
    }
    const res = await invoke({
      project_id: projectId,
      version,
      tool_name: call.name,
      args: call.args,
      attribution: {
        channel: 'playground',
        client,
        trigger: ctx.step === 0 ? 'user_prompt' : 'agent_followup',
        trigger_source: 'declared',
        session_id: ctx.turnId,
        turn_id: ctx.turnId,
        prompt: ctx.prompt,
      },
    });
    return res.ok
      ? { ok: true, body: res.result, latencyMs: res.latency_ms }
      : { ok: false, body: null, error: `${res.error?.condition ?? 'INVOKE_FAILED'}: ${res.error?.message ?? ''}`, latencyMs: res.latency_ms };
  };
}
