// Release manager + output adapters (OUT-01).
// Freezes approved/tested tools into an immutable, signed release snapshot,
// then renders the release manifest for the project's customer-selected targets
// (mcp, openai, muse). The adapter owns representation; the core owns meaning.
// All three targets (mcp, openai, muse) ship in the current version —
// the Meta Muse connector adapter is a v1 output, not a v2 item.

import { createHash, createHmac } from 'node:crypto';
import { one, q, exec, withTx, J, jb, uid } from './db.js';
import { HttpError } from './errors.js';
import { evaluateCertification, type CertificationCheck, type CertificationVerdict } from './certification.js';

// Connector targets a customer can pick per project.
export const CONNECTOR_TARGETS = ['mcp', 'openai', 'muse'] as const;

/** Keep only known target ids, dedupe, return in stable order. May be empty. */
export function normalizeTargets(input: unknown): string[] {
  const order = [...CONNECTOR_TARGETS];
  const set = new Set<string>();
  if (Array.isArray(input)) {
    for (const t of input) {
      if (typeof t === 'string' && (order as string[]).includes(t)) set.add(t);
    }
  }
  return order.filter((t) => set.has(t));
}

/** Default targets for a new project: all three connectors, Muse included. */
export function defaultTargets(): string[] {
  return ['mcp', 'openai', 'muse'];
}

/** Compact release key, e.g. ['openai','mcp'] -> 'mcp+openai'. */
export function targetKey(targets: string[]): string {
  return [...targets].sort().join('+');
}

/** Read the projects.targets JSONB column defensively; fall back to v1 defaults. */
export function projectTargets(raw: unknown): string[] {
  const norm = normalizeTargets(J.parse(raw, [] as unknown[]));
  return norm.length > 0 ? norm : defaultTargets();
}

const SIGNING_SECRET = process.env.CF_SIGNING_SECRET ?? 'dev-only-signing-secret';

// ─── RL-07: release channels ─────────────────────────────────────────────
// A release is born in `staging` and reaches `prod` only through an explicit
// promotion. Channels are an orthogonal dimension to status: status tracks
// the sign-off lifecycle (draft → approved → deprecated), channel tracks
// where the release may serve. The data plane keeps pinned-version invoke
// and additionally accepts the channel aliases `staging` / `prod`, which
// resolve to the newest approved, non-deprecated release in that channel.
export const RELEASE_CHANNELS = ['staging', 'prod'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** Version strings reserved as channel aliases — never valid release versions. */
export function isChannelAlias(version: string): version is ReleaseChannel {
  return (RELEASE_CHANNELS as readonly string[]).includes(version);
}

/** Validate an untrusted channel value; null when it isn't a channel. */
export function normalizeChannel(input: unknown): ReleaseChannel | null {
  return typeof input === 'string' && (RELEASE_CHANNELS as readonly string[]).includes(input)
    ? (input as ReleaseChannel)
    : null;
}

export interface ReleaseManifest {
  connector: { name: string; version: string; targets: string[]; description: string };
  integrity: { bundle_hash: string; signature: string; algorithm: string };
  provenance: { project_id: string; release_id: string; created_at: string; contract_status: string; channel: string;
    scope: { tool_ids: string[]; tool_count: number } | null };
  tools: Array<{
    name: string;
    description: string;
    parameters: unknown;
    side_effects: string[];
    confirmation: 'never' | 'always';
    idempotent: boolean;
    recovery: Array<{ condition: string; behavior: string; user_message: string }>;
    auth: { mode: string | null; scopes: string[] };
  }>;
  known_limitations: string[];
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(v, Object.keys(v as object).sort());
}

export async function createRelease(
  projectId: string,
  version: string,
  // Scoped release: freeze only these tools (a quick demo loop). The route
  // validates the shape; membership is checked here against the project.
  opts?: { toolIds?: string[] },
): Promise<{ id: string; manifest: ReleaseManifest }> {
  // RL-07: `staging`/`prod` are channel aliases on the data plane, so they
  // can never be pinned version names (an invoke for version `prod` must
  // never be ambiguous between a pin and an alias).
  if (isChannelAlias(version)) {
    throw new HttpError(400, 'release_version_reserved',
      `"${version}" is a reserved channel name and cannot be used as a release version`);
  }
  const project = await one(`SELECT * FROM projects WHERE id = $1`, [projectId]) as any;
  if (!project) throw new HttpError(404, 'project_not_found', 'Project not found');

  let tools = await q(
    // A released tool stays in every later release until it is edited
    // (back to candidate) and re-approved, so v2 carries all of v1's tools.
    `SELECT * FROM canonical_tools WHERE project_id = $1 AND status IN ('approved','tested','released') ORDER BY name`,
    [projectId]) as any[];
  if (opts?.toolIds && opts.toolIds.length > 0) {
    const owned = await q(
      `SELECT id FROM canonical_tools WHERE project_id = $1 AND id = ANY($2)`,
      [projectId, opts.toolIds]) as Array<{ id: string }>;
    const known = new Set(owned.map((r) => r.id));
    const unknown = opts.toolIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new HttpError(400, 'release_unknown_tools',
        `Unknown tools for this project: ${unknown.join(', ')}`);
    }
    tools = tools.filter((t) => known.has(t.id));
  }
  if (tools.length === 0) throw new HttpError(400, 'release_no_tools', 'No approved or tested tools to release');
  // AB-05 credential gate, refined by AB-02: a tool that requires a
  // credential must never freeze into a release while no credential is
  // connected — the manifest carries only the mode/scopes (never a
  // secret), and invoke refuses such tools until the broker can supply
  // one. api_key tools with an ACTIVE project credential now pass the
  // gate (the broker injects at invoke); oauth tools keep refusing until
  // AB-03. Checked before the eval gate: eval cannot pass for these tools
  // either, and "connect a credential" is the actionable root cause.
  const credTools = tools.filter((t) => t.credential_mode && t.credential_mode !== 'none');
  let apiKeyConnected = false;
  if (credTools.some((t) => t.credential_mode === 'api_key')) {
    const cred = await one(
      `SELECT id FROM project_credentials WHERE project_id = $1 AND kind = 'api_key' AND status = 'active'`,
      [projectId]);
    apiKeyConnected = !!cred;
  }
  const credBlocked = credTools.filter((t) => t.credential_mode !== 'api_key' || !apiKeyConnected);
  if (credBlocked.length > 0) {
    throw new HttpError(
      400,
      'release_credential_required',
      `Release blocked: ${credBlocked.length} tool(s) require a credential that is not connected ` +
        `(${credBlocked.map((t: any) => `${t.name} (${t.credential_mode})`).join(', ')}). ` +
        'Connect a credential before releasing.',
    );
  }
  // Release gates (EVA-01/GOV-01): every tool must have passed evaluation.
  // 'approved' without a passing eval run is not releasable; 'released'
  // tools passed it when they shipped and are unchanged since (an edit
  // sends a tool back to candidate).
  const untested = tools.filter((t) => t.status !== 'tested' && t.status !== 'released');
  if (untested.length > 0) {
    throw new HttpError(
      400,
      'release_blocked',
      `Release blocked: ${untested.length} tool(s) have not passed evaluation ` +
        `(${untested.map((t: any) => t.name).join(', ')}). Run eval first.`,
    );
  }

  const dup = await one(`SELECT id FROM releases WHERE project_id = $1 AND version = $2`, [projectId, version]);
  if (dup) throw new HttpError(409, 'release_version_exists', `Release version ${version} already exists for this project`);

  const frozen: Array<{
    tool_id: string;
    name: string;
    version: number;
    snapshot: Record<string, any>;
  }> = [];
  for (const t of tools) {
    const rules = await q(
      `SELECT condition, behavior, recovery_action, max_attempts, backoff_ms, user_message
       FROM tool_recovery_rules WHERE tool_id = $1 AND tool_version = $2`,
      [t.id, t.version]);
    frozen.push({
      tool_id: t.id,
      name: t.name,
      version: t.version,
      snapshot: {
        name: t.name,
        description: t.description,
        purpose: t.purpose,
        eligible_use: t.eligible_use,
        ineligible_use: t.ineligible_use,
        input_schema: J.parse(t.input_schema, {}),
        output_schema: J.parse(t.output_schema, {}),
        upstream: J.parse(t.upstream, {}),
        effect_classes: J.parse(t.effect_classes, []),
        confirmation_required: Boolean(t.confirmation_required),
        idempotent: Boolean(t.idempotent),
        credential_mode: t.credential_mode,
        required_scopes: J.parse(t.required_scopes, []),
        provenance: J.parse(t.provenance, []),
        recovery_rules: rules,
      },
    });
  }

  const bundleHash = createHash('sha256').update(canonicalJson(frozen)).digest('hex');
  const signature = createHmac('sha256', SIGNING_SECRET).update(`${version}:${bundleHash}`).digest('hex');
  // NOTE: prototype uses HMAC with a local secret. Production uses KMS asymmetric
  // signing (terraform module kms_signing); the data plane verifies with the public key.

  const releaseId = uid();
  // The release snapshots the project's customer-selected targets.
  const targets = projectTargets(project.targets);
  const manifest: ReleaseManifest = {
    connector: {
      name: `${project.name}-connector`,
      version,
      targets,
      description: `Agent connector for ${project.name}, generated by Connector Foundry.`,
    },
    integrity: { bundle_hash: bundleHash, signature, algorithm: 'HMAC-SHA256 (prototype; KMS in production)' },
    provenance: {
      project_id: projectId,
      release_id: releaseId,
      created_at: new Date().toISOString(),
      contract_status: 'Selected targets are self-describing bundles; no external contract verification needed',
      // RL-07: every release is born in staging; promotion to prod is a
      // separate, audited action (the frozen manifest never changes).
      channel: 'staging',
      // Scoped releases freeze a subset: record it so readers never mistake
      // a demo cut for the whole toolset.
      scope: opts?.toolIds && opts.toolIds.length > 0
        ? { tool_ids: opts.toolIds, tool_count: tools.length }
        : null,
    },
    tools: frozen.map((f) => ({
      name: f.snapshot.name,
      description: f.snapshot.description,
      parameters: f.snapshot.input_schema,
      side_effects: f.snapshot.effect_classes,
      confirmation: f.snapshot.confirmation_required ? 'always' : 'never',
      idempotent: f.snapshot.idempotent,
      recovery: (f.snapshot.recovery_rules as any[]).map((r) => ({
        condition: r.condition, behavior: r.behavior, user_message: r.user_message,
      })),
      auth: { mode: f.snapshot.credential_mode, scopes: f.snapshot.required_scopes },
    })),
    known_limitations: [
      'Generated from OpenAPI import heuristics; customer review required before production use.',
    ],
  };

  await withTx(async (t) => {
    await t.query(
      `INSERT INTO releases (id, project_id, version, bundle_hash, signature, target, status, manifest, channel)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, 'staging')`,
      [releaseId, projectId, version, bundleHash, signature, targetKey(targets), jb(manifest)]);
    for (const f of frozen) {
      await t.query(
        `INSERT INTO release_tools (release_id, tool_id, tool_version, tool_snapshot) VALUES ($1, $2, $3, $4)`,
        [releaseId, f.tool_id, f.version, jb(f.snapshot)]);
    }
    await t.query(`UPDATE canonical_tools SET status = 'released', updated_at = now()
                   WHERE project_id = $1 AND status IN ('approved','tested')`, [projectId]);
  });

  return { id: releaseId, manifest };
}

export async function approveRelease(releaseId: string, approver = 'prototype-user'): Promise<void> {
  const r = await one(`SELECT * FROM releases WHERE id = $1`, [releaseId]) as any;
  if (!r) throw new HttpError(404, 'release_not_found', 'Release not found');
  await exec(`UPDATE releases SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2`,
    [approver, releaseId]);
}

export async function getManifest(releaseId: string): Promise<ReleaseManifest> {
  const r = await one(`SELECT manifest FROM releases WHERE id = $1`, [releaseId]) as any;
  if (!r) throw new HttpError(404, 'release_not_found', 'Release not found');
  return J.parse(r.manifest, null as unknown as ReleaseManifest);
}

export interface RollbackResult {
  release_id: string;
  version: string;
  deprecated: true;
  /** Previous approved release the customer should pin instead, if one exists. */
  fallback: { release_id: string; version: string } | null;
}

/**
 * RL-06: roll back a bad release in one action.
 *
 * Marks the release `deprecated` — it can never be served again (see runtime.ts:
 * invoke refuses deprecated releases with RELEASE_DEPRECATED and names the
 * fallback). Returns the previous approved release as the fallback target.
 * Only an `approved` release can be rolled back; drafts were never served and
 * deprecated releases are already out.
 *
 * The status flip and the audit_events row commit in one transaction. The
 * `WHERE status = 'approved'` guard plus the rowCount check make a concurrent
 * double-rollback fail with 409 instead of double-auditing.
 */
export async function rollbackRelease(releaseId: string, actor: string, reason?: string): Promise<RollbackResult> {
  const r = await one(
    `SELECT id, project_id, version, status FROM releases WHERE id = $1`, [releaseId]) as any;
  if (!r) throw new HttpError(404, 'release_not_found', 'Release not found');
  if (r.status === 'deprecated') {
    throw new HttpError(409, 'release_already_deprecated', `Release ${r.version} is already deprecated`);
  }
  if (r.status !== 'approved') {
    throw new HttpError(409, 'release_not_rollbackable',
      `Only an approved release can be rolled back (release ${r.version} is ${r.status})`);
  }

  const prev = await one(
    `SELECT id, version FROM releases
     WHERE project_id = $1 AND status = 'approved' AND id <> $2
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [r.project_id, releaseId]) as any;

  const metadata = {
    version: r.version,
    actor,
    reason: reason ?? null,
    fallback_version: prev?.version ?? null,
  };
  await withTx(async (t) => {
    const upd = await t.query(
      `UPDATE releases
       SET status = 'deprecated', deprecated_at = now(), deprecated_by = $2, deprecate_reason = $3
       WHERE id = $1 AND status = 'approved'`,
      [releaseId, actor, reason ?? null]);
    if (upd.rowCount !== 1) {
      throw new HttpError(409, 'release_rollback_race',
        `Release ${r.version} changed while rolling back; it may already be deprecated`);
    }
    await t.query(
      `INSERT INTO audit_events (id, project_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'release.deprecated', 'release', $3, $4)`,
      [uid(), r.project_id, releaseId, jb(metadata)]);
  });

  return {
    release_id: releaseId,
    version: r.version,
    deprecated: true,
    fallback: prev ? { release_id: prev.id, version: prev.version } : null,
  };
}

export interface PromoteResult {
  release_id: string;
  version: string;
  channel: ReleaseChannel;
  /** False when the release was already in the target channel (idempotent no-op). */
  promoted: boolean;
}

/**
 * RL-07: promote an approved release between channels (staging → prod in
 * practice; prod → staging is the demote path for pulling a release back
 * without deprecating it). Only `approved` releases can move — a draft has
 * no sign-off yet, and a deprecated release is terminal (RL-06). Promotion
 * never edits the frozen snapshot or manifest; it flips the channel in one
 * transaction with an audit_events row, and the `channel <> target` guard
 * makes a concurrent double-promotion a clean 409 instead of a double audit.
 * Re-promoting to the channel the release already occupies is an idempotent
 * no-op, so retries are safe.
 */
// ─── RL-08: certification-gated prod promotion ──────────────────────────────
// Staging stays light (approve and go); prod is where customer agent
// traffic flows, so promotion requires the project's latest completed
// eval run to be EV-05 certified (D-52). The checklist below is the
// customer's path to ready: every unmet item says what is missing and
// what to do next. The console renders it verbatim on Publish.

export interface PromotionCheck extends CertificationCheck {
  action: string;
}

export interface PromotionReadiness {
  release_id: string;
  version: string;
  channel: string;
  ready: boolean;
  certified: boolean;
  run_id: string | null;
  checks: PromotionCheck[];
}

const CERT_ACTIONS: Record<string, string> = {
  run_passed: 'Run a new evaluation from Evaluate, fix any failing scenarios, and let it finish green.',
  contract_suite: 'Open the latest eval run, fix the failing contract scenarios, then re-run the evaluation.',
  behavior_suite: 'Open the latest eval run, fix the failing behavior scenarios, then re-run the evaluation.',
  recovery_suite: 'Open the latest eval run, fix the failing recovery scenarios, then re-run the evaluation.',
  auth_suite: 'Store this project’s provider API key (Credentials), then re-run the evaluation so auth is verified against the real credential.',
  safety_verified: 'Re-run the evaluation: write tools must pass the write-safety scenarios (wrong-type payload rejected, idempotent replay safe, confirmation contract present). Fix the failing scenario in the latest eval run, then re-run.',
  tool_coverage: 'Re-run the evaluation so every tool is exercised in every suite.',
};

async function readinessFor(r: any): Promise<PromotionReadiness> {
  const checks: PromotionCheck[] = [];
  const approved = r.status === 'approved';
  checks.push({
    id: 'release_approved',
    label: 'Release approved',
    status: approved ? 'pass' : 'fail',
    detail: approved ? `Release ${r.version} is approved.` : `Release ${r.version} is ${r.status}.`,
    action: 'Approve the release first — approval needs every tool approved and the latest eval passing.',
  });

  const run = await one(
    `SELECT * FROM eval_runs WHERE project_id = $1 AND status IN ('passed', 'failed')
      ORDER BY started_at DESC, id DESC LIMIT 1`,
    [r.project_id],
  ) as any;

  let verdict: CertificationVerdict | null = null;
  if (run) {
    const summary = J.parse(run.summary, {}) as Record<string, any>;
    if (summary?.certification?.checks) {
      // Judged when the run finished, under its criteria version.
      verdict = summary.certification as CertificationVerdict;
    } else {
      // 🐞 (fixed with EV-06): this queried `WHERE run_id = …`, but the
      // column is `eval_run_id` — a live legacy-run readiness check
      // would have thrown. `scenario` joins the projection because the
      // v2 safety judge verifies per-scenario write-safety coverage.
      const results = ((await q(
        `SELECT tool_id, suite, scenario, passed FROM eval_results WHERE eval_run_id = $1`, [run.id])) ?? []) as any[];
      const tools = ((await q(
        `SELECT id, credential_mode, effect_classes, idempotent FROM canonical_tools WHERE project_id = $1`,
        [r.project_id])) ?? []) as any[];
      verdict = evaluateCertification({
        runStatus: run.status,
        suites: summary?.suites,
        results: results.map((x) => ({
          tool_id: String(x.tool_id), suite: String(x.suite), scenario: String(x.scenario ?? ''), passed: x.passed === true,
        })),
        tools,
      });
    }
  }

  if (!run || !verdict) {
    checks.push({
      id: 'eval_run_present',
      label: 'Evaluation run on file',
      status: 'fail',
      detail: 'No completed evaluation run exists for this project yet — certification judges the latest run.',
      action: 'Run an evaluation from Evaluate and let it finish.',
    });
  } else {
    for (const c of verdict.checks) {
      checks.push({ ...c, action: CERT_ACTIONS[c.id] ?? 'Re-run the evaluation.' });
    }
  }

  return {
    release_id: r.id,
    version: r.version,
    channel: normalizeChannel(r.channel) ?? 'staging',
    ready: checks.every((c) => c.status === 'pass'),
    certified: verdict?.certified ?? false,
    run_id: run?.id ?? null,
    checks,
  };
}

/** The prod-promotion checklist for one release (RL-08). */
export async function promotionReadiness(releaseId: string): Promise<PromotionReadiness> {
  const r = await one(
    `SELECT id, project_id, version, status, channel FROM releases WHERE id = $1`, [releaseId]) as any;
  if (!r) throw new HttpError(404, 'release_not_found', 'Release not found');
  return readinessFor(r);
}

export async function promoteRelease(
  releaseId: string,
  actor: string,
  targetChannel: ReleaseChannel = 'prod',
): Promise<PromoteResult> {
  const r = await one(
    `SELECT id, project_id, version, status, channel FROM releases WHERE id = $1`, [releaseId]) as any;
  if (!r) throw new HttpError(404, 'release_not_found', 'Release not found');
  if (r.status === 'deprecated') {
    throw new HttpError(409, 'release_deprecated',
      `Release ${r.version} is deprecated and cannot be promoted`);
  }
  if (r.status !== 'approved') {
    throw new HttpError(409, 'release_not_promotable',
      `Only an approved release can be promoted (release ${r.version} is ${r.status}). Approve it first.`);
  }
  const from = normalizeChannel(r.channel) ?? 'staging';
  if (from === targetChannel) {
    return { release_id: releaseId, version: r.version, channel: targetChannel, promoted: false };
  }

  // RL-08 (D-52): prod requires a certified latest eval run; staging does
  // not. The 422 names the unmet items — the readiness endpoint carries
  // the per-item guidance the console renders.
  if (targetChannel === 'prod') {
    const readiness = await readinessFor(r);
    if (!readiness.ready) {
      const missing = readiness.checks.filter((c) => c.status !== 'pass').map((c) => c.label);
      throw new HttpError(422, 'promotion_blocked',
        `Not ready for prod — missing: ${missing.join('; ')}. Open promotion readiness for how to fix each item.`);
    }
  }

  await withTx(async (t) => {
    const upd = await t.query(
      `UPDATE releases
       SET channel = $2, promoted_at = now(), promoted_by = $3
       WHERE id = $1 AND status = 'approved' AND channel <> $2`,
      [releaseId, targetChannel, actor]);
    if (upd.rowCount !== 1) {
      throw new HttpError(409, 'release_promote_race',
        `Release ${r.version} changed while promoting; check its channel and retry`);
    }
    await t.query(
      `INSERT INTO audit_events (id, project_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, 'release.promoted', 'release', $3, $4)`,
      [uid(), r.project_id, releaseId, jb({
        version: r.version, actor, from_channel: from, to_channel: targetChannel,
      })]);
  });

  return { release_id: releaseId, version: r.version, channel: targetChannel, promoted: true };
}

/**
 * RL-07: resolve a channel alias for a project — the newest approved,
 * non-deprecated release in the channel, or null when the channel is empty.
 * Used by the data plane so `version: "staging"` exercises a staged release
 * while `version: "prod"` keeps serving the promoted one.
 */
export async function resolveChannelRelease(
  projectId: string,
  channel: ReleaseChannel,
): Promise<{ id: string; version: string } | null> {
  const r = await one(
    `SELECT id, version FROM releases
     WHERE project_id = $1 AND channel = $2 AND status = 'approved'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [projectId, channel]) as any;
  return r ? { id: r.id, version: r.version } : null;
}
