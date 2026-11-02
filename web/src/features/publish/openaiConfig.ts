// RL-04 (console half): how the Publish screen presents the OpenAI
// artifacts for a live release. Pure string builders so the exact URLs
// and GPT-editor instructions a customer follows are unit-tested — a
// wrong path here means ChatGPT imports a dead spec.

/** Function-calling tools download for one release (backend-generated). */
export function openAiToolsUrl(apiBase: string, releaseId: string): string {
  const base = apiBase.replace(/\/+$/, '');
  return `${base}/v1/releases/${encodeURIComponent(releaseId)}/openai/tools`;
}

/** GPT Actions OpenAPI document URL for one release. */
export function gptActionsSpecUrl(apiBase: string, releaseId: string): string {
  const base = apiBase.replace(/\/+$/, '');
  return `${base}/v1/releases/${encodeURIComponent(releaseId)}/openai/actions`;
}

/**
 * Step-by-step setup for the ChatGPT GPT editor, rendered verbatim on
 * Publish. The gateway key stays a placeholder — the real secret is
 * minted in Operate and pasted into the GPT's auth field by the
 * customer, never rendered into page state.
 */
export function gptActionsSetup(specUrl: string): string {
  return [
    'In the GPT editor: Create new GPT → Configure → Actions → Create new action.',
    `Import URL: ${specUrl}`,
    'Authentication: API Key — header name X-API-Key, value <your-gateway-key> (Operate → Gateway keys).',
    'Each connector tool appears as one action; side-effecting tools ask for confirmation first.',
  ].join('\n');
}
