// Drift detection (TE-03) — eval-on-schedule for the prod release.
//
// A drift check re-runs the eval contract scenarios (the exact same
// probes, extracted in eval.ts) against the *frozen* tool snapshots of
// the project's current prod release. Every tool in a release passed
// eval at release time (the release gate), so a failing contract probe
// means the upstream API changed underneath the connector: a drift
// alert opens, and the next passing check auto-resolves it.
//
// Safety rules:
// - Only read-only tools are probed. A scheduled happy-path probe on a
//   write tool would fire a real mutation — write tools are skipped and
//   recorded as such (write drift detection is a documented follow-up).
// - OAuth tools are skipped: there is no per-user account on a schedule
//   (AB-03). api_key tools lease the project key through the EV-01 path;
//   a revoked key 401s the probe and correctly opens an alert.
// - Probes share the runtime egress policy (SE-08) via eval's probe path.

import { one, q, exec, jb, uid, audit } from './db.js';
import { logger } from './logger.js';
import { redactString } from './redact.js';
import {
  probeContractScenarios,
  resolveToolAuthCtx,
  isWriteTool,
  type ToolRow,
} from './eval.js';
import { resolveChannelRelease } from './release.js';
import { enqueueJob } from './queue.js';

/** Max age of a drift check before the sweeper enqueues another (AC: alert within 1 hour). */
export const DRIFT_CHECK_INTERVAL_MS = Number(process.env.CF_DRIFT_CHECK_INTERVAL_MS ?? 30 * 60 * 1000);
/** How often the sweeper looks for due projects. */
export const DRIFT_SWEEP_MS = Number(process.env.CF_DRIFT_SWEEP_MS ?? 5 * 60 * 1000);

export async function prodReleaseFor(projectId: string) {
  return resolveChannelRelease(projectId, 'prod');
}

export type DriftToolStatus = 'passed' | 'failed' | 'skipped';

export interface DriftToolOutcome {
  tool_id: string;
  tool_name: string;
  status: DriftToolStatus;
  skip_reason?: 'write_tool' | 'oauth_credential' | 'probe_error';
  failed_scenarios?: string[];
  evidence?: unknown;
}

interface FrozenTool {
  tool_id: string;
  snapshot: any;
}

function toolRowFor(projectId: string, f: FrozenTool): ToolRow {
  const snap = f.snapshot ?? {};
  return {
    id: f.tool_id,
    project_id: projectId,
    name: String(snap.name ?? f.tool_id),
    input_schema: snap.input_schema ?? {},
    upstream: snap.upstream ?? {},
    version: Number(snap.version ?? 0),
    status: 'released',
    credential_mode: snap.credential_mode ?? 'none',
    effect_classes: snap.effect_classes ?? [],
  };
}

/**
 * Reconcile one tool's outcome against its open alert:
 * - failed + no open alert → open it, audit drift.detected
 * - failed + open alert → refresh last_seen_at + evidence
 * - passed + open alert → resolve it, audit drift.resolved
 * - skipped + open alert → leave open (we simply didn't observe)
 */
async function reconcileAlert(
  projectId: string,
  releaseId: string,
  tool: ToolRow,
  outcome: DriftToolOutcome,
): Promise<void> {
  const open = (await one(
    `SELECT id FROM drift_alerts WHERE project_id = $1 AND tool_id = $2 AND status = 'open'`,
    [projectId, tool.id],
  )) as { id: string } | null;

  if (outcome.status === 'failed') {
    const evidence = {
      release_id: releaseId,
      failed_scenarios: outcome.failed_scenarios ?? [],
      probes: outcome.evidence ?? [],
    };
    if (!open) {
      const id = uid();
      await exec(
        `INSERT INTO drift_alerts (id, project_id, release_id, tool_id, tool_name, status, evidence)
         VALUES ($1, $2, $3, $4, $5, 'open', $6)`,
        [id, projectId, releaseId, tool.id, tool.name, jb(evidence)],
      );
      await audit(projectId, 'drift.detected', 'drift_alert', id, {
        tool_id: tool.id, tool_name: tool.name, release_id: releaseId,
        failed_scenarios: outcome.failed_scenarios ?? [],
      });
      logger.info({ msg: 'drift detected', project_id: projectId, tool: tool.name });
    } else {
      await exec(
        `UPDATE drift_alerts SET last_seen_at = now(), release_id = $2, evidence = $3 WHERE id = $1`,
        [open.id, releaseId, jb(evidence)],
      );
    }
  } else if (outcome.status === 'passed' && open) {
    await exec(
      `UPDATE drift_alerts SET status = 'resolved', resolved_at = now() WHERE id = $1`,
      [open.id],
    );
    await audit(projectId, 'drift.resolved', 'drift_alert', open.id, {
      tool_id: tool.id, tool_name: tool.name,
    });
    logger.info({ msg: 'drift resolved', project_id: projectId, tool: tool.name });
  }
}

export async function runDriftCheck(
  projectId: string,
  trigger: 'schedule' | 'manual' = 'schedule',
  onProgress?: (done: number, total: number, note: string) => void | Promise<void>,
): Promise<string> {
  const checkId = uid();
  await exec(
    `INSERT INTO drift_checks (id, project_id, trigger, status) VALUES ($1, $2, $3, 'running')`,
    [checkId, projectId, trigger],
  );

  try {
    const release = await prodReleaseFor(projectId);
    if (!release) {
      // The sweeper never enqueues these; a manual trigger can race a
      // demotion. Recorded as a clean no-op, not an error.
      await exec(
        `UPDATE drift_checks SET status = 'succeeded', finished_at = now(), summary = $2 WHERE id = $1`,
        [checkId, jb({ status: 'no_prod_release', tools_checked: 0 })],
      );
      return checkId;
    }

    const frozen = (await q(
      `SELECT rt.tool_id, rt.tool_snapshot AS snapshot
         FROM release_tools rt WHERE rt.release_id = $1 ORDER BY rt.tool_id`,
      [release.id],
    )) as FrozenTool[];

    const outcomes: DriftToolOutcome[] = [];
    for (const [i, f] of frozen.entries()) {
      const tool = toolRowFor(projectId, f);
      await onProgress?.(i, frozen.length, `Drift-checking ${tool.name}`);

      // Never fire a scheduled probe that could mutate: write tools are
      // observed, not exercised.
      if (isWriteTool(tool)) {
        outcomes.push({ tool_id: tool.id, tool_name: tool.name, status: 'skipped', skip_reason: 'write_tool' });
        continue;
      }
      if (tool.credential_mode === 'oauth') {
        outcomes.push({ tool_id: tool.id, tool_name: tool.name, status: 'skipped', skip_reason: 'oauth_credential' });
        continue;
      }

      const { ctx } = await resolveToolAuthCtx(projectId, tool);
      let probeOutcomes;
      try {
        probeOutcomes = await probeContractScenarios(tool, ctx);
      } catch (e) {
        outcomes.push({
          tool_id: tool.id, tool_name: tool.name, status: 'skipped', skip_reason: 'probe_error',
          evidence: { error: redactString(e instanceof Error ? e.message : String(e)) },
        });
        continue;
      }

      const failed = probeOutcomes.filter((o) => !o.passed);
      const outcome: DriftToolOutcome =
        failed.length === 0
          ? { tool_id: tool.id, tool_name: tool.name, status: 'passed' }
          : {
              tool_id: tool.id, tool_name: tool.name, status: 'failed',
              failed_scenarios: failed.map((o) => o.scenario),
              evidence: failed.map((o) => ({ scenario: o.scenario, detail: o.detail })),
            };
      outcomes.push(outcome);
      await reconcileAlert(projectId, release.id, tool, outcome);
    }

    const failed = outcomes.filter((o) => o.status === 'failed');
    await exec(
      `UPDATE drift_checks SET status = 'succeeded', finished_at = now(), summary = $2 WHERE id = $1`,
      [checkId, jb({
        release_id: release.id,
        release_version: release.version,
        tools_checked: outcomes.filter((o) => o.status !== 'skipped').length,
        tools_passed: outcomes.filter((o) => o.status === 'passed').length,
        tools_failed: failed.map((o) => ({
          tool_id: o.tool_id, tool_name: o.tool_name, failed_scenarios: o.failed_scenarios,
        })),
        tools_skipped: outcomes
          .filter((o) => o.status === 'skipped')
          .map((o) => ({ tool_id: o.tool_id, tool_name: o.tool_name, reason: o.skip_reason })),
      })],
    );
    return checkId;
  } catch (e) {
    // DP-05: a stored check error is a log surface — redact before persisting.
    await exec(`UPDATE drift_checks SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [checkId, redactString(e instanceof Error ? e.message : String(e))]);
    return checkId;
  }
}

/**
 * Enqueue a drift check for every project whose prod release hasn't been
 * checked within the interval. enqueueJob dedups per (project, kind)
 * while a check is queued or running, so overlapping sweeps are harmless.
 */
export async function sweepDriftChecks(): Promise<number> {
  const due = (await q(
    `SELECT p.id FROM projects p
      WHERE EXISTS (
        SELECT 1 FROM releases r
         WHERE r.project_id = p.id AND r.channel = 'prod' AND r.status = 'approved'
      )
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
         WHERE j.project_id = p.id AND j.kind = 'drift' AND j.status IN ('queued', 'running')
      )
      AND COALESCE((
        SELECT max(d.started_at) FROM drift_checks d WHERE d.project_id = p.id
      ), '-infinity'::timestamptz) < now() - make_interval(secs => $1)`,
    [DRIFT_CHECK_INTERVAL_MS / 1000],
  )) as Array<{ id: string }>;
  for (const p of due) {
    await enqueueJob('drift', p.id, null);
  }
  if (due.length > 0) logger.info({ msg: 'drift sweep enqueued', projects: due.length });
  return due.length;
}

/** Start the drift sweeper alongside the job worker (index.ts). */
export function startDriftSweeper(): void {
  const sweep = () =>
    sweepDriftChecks().catch((e) =>
      logger.error({ msg: 'drift sweep failed', error: e instanceof Error ? e.message : String(e) }));
  setInterval(sweep, DRIFT_SWEEP_MS);
  void sweep();
}
