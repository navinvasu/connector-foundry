// ─── Projects ────────────────────────────────────────────────────────────────
// The customer can own several projects (one source API → one or more agent
// connectors). The registry comes from GET /v1/projects (store.loadProjects).

export type ProjectStatus = 'draft' | 'in_review' | 'evaluating' | 'ready' | 'published';

/** Connector targets a customer can pick per project. */
export type ConnectorTarget = 'mcp' | 'openai' | 'muse';

export interface TargetOption {
  id: ConnectorTarget;
  label: string;
  desc: string;
  /** Short note shown on the option, e.g. availability. */
  badge?: string;
  /** Not selectable yet — shown greyed out until its adapter ships. */
  disabled?: boolean;
}

export const TARGET_OPTIONS: TargetOption[] = [
  {
    id: 'mcp',
    label: 'MCP',
    desc: 'Model Context Protocol server — runs on Claude and any MCP client.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    desc: 'Function-calling schemas plus GPT Actions artifacts.',
  },
  {
    id: 'muse',
    label: 'Meta Muse',
    desc: 'Muse connector adapter.',
  },
];

export const targetLabel = (t: ConnectorTarget): string =>
  TARGET_OPTIONS.find((o) => o.id === t)?.label ?? t;

/** 'MCP + OpenAI' — used wherever a project's target set is displayed. */
export const formatTargets = (targets: ConnectorTarget[]): string =>
  targets.length > 0 ? targets.map(targetLabel).join(' + ') : 'No targets';

/** How the connector authenticates to the upstream API. `access_token` is the
 *  browser-login OAuth path (AB-03) — visible but disabled for the demo,
 *  which supports API keys only. */
export type UpstreamAuthMode = 'api_key' | 'access_token';

export interface UpstreamAuthOption {
  id: UpstreamAuthMode;
  label: string;
  desc: string;
  /** Not selectable yet — shown greyed out until its broker ships. */
  disabled?: boolean;
  disabledNote?: string;
}

export const UPSTREAM_AUTH_OPTIONS: UpstreamAuthOption[] = [
  {
    id: 'api_key',
    label: 'Upstream API key',
    desc: 'A static key saved to the server vault. Sent on every upstream call.',
  },
  {
    id: 'access_token',
    label: 'Access token (browser login)',
    desc: 'Log in through the upstream login page; the connector uses the access token instead of a key.',
    disabled: true,
    disabledNote: 'Disabled for the demo — API keys only for now.',
  },
];

/** How end users authenticate to the connector itself. Auth-based login is
 *  the future OAuth path — visible but disabled for the demo. */
export type EndUserAuthMode = 'gateway_key' | 'auth_login';

export interface EndUserAuthOption {
  id: EndUserAuthMode;
  label: string;
  desc: string;
  disabled?: boolean;
  disabledNote?: string;
}

export const ENDUSER_AUTH_OPTIONS: EndUserAuthOption[] = [
  {
    id: 'gateway_key',
    label: 'Gateway API key',
    desc: 'Scripts and agent clients call the released connector with a project gateway key.',
  },
  {
    id: 'auth_login',
    label: 'Auth-based login',
    desc: 'End users sign in and the connector calls upstream as them.',
    disabled: true,
    disabledNote: 'Disabled for the demo — gateway keys only for now.',
  },
];

export interface ProjectSummary {
  id: string;
  name: string;
  /** Customer-selected connector targets; editable after creation. */
  targets: ConnectorTarget[];
  status: ProjectStatus;
  version: string;
  toolsApproved: number;
  toolsTotal: number;
  /** Imported operations (real registry rows). */
  operationsCount?: number;
  evalPassRate: number | null;
  evalSummary: string;
  blockerCount: number;
  openQuestions: number;
  updatedAt: string;
  blurb: string;
  /** How the customer supplied their API (wizard input). */
  sourceKind?: 'openapi-url' | 'upload' | 'postman' | 'docs';
  sourceDetail?: string;
  /** Owning workspace (real registry rows). */
  customerId?: string;
  customerName?: string | null;
}

export const statusTone: Record<ProjectStatus, 'green' | 'amber' | 'blue' | 'gray'> = {
  published: 'green',
  ready: 'green',
  in_review: 'amber',
  evaluating: 'blue',
  draft: 'gray',
};

export const statusLabel: Record<ProjectStatus, string> = {
  published: 'Published',
  ready: 'Ready to publish',
  in_review: 'In review',
  evaluating: 'Evaluating',
  draft: 'Draft',
};
