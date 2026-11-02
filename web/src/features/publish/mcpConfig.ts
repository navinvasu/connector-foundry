// RL-03 (console half): how the Publish screen presents the hosted MCP
// server for a live release. Pure string builders so the exact text a
// customer pastes into their MCP client config is unit-tested — a wrong
// URL or header name here means Claude never connects.

/** Hosted MCP endpoint for one project + release selection (pinned
 *  version or the `staging`/`prod` channel alias). */
export function mcpEndpointUrl(apiBase: string, projectId: string, version: string): string {
  const base = apiBase.replace(/\/+$/, '');
  return `${base}/v1/mcp/${encodeURIComponent(projectId)}?version=${encodeURIComponent(version)}`;
}

/** Client-config server key: lowercase slug of the project name. */
export function mcpServerName(projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `connector-foundry-${slug}` : 'connector-foundry';
}

/**
 * Ready-to-paste MCP client configuration (Claude Code / Claude Desktop
 * remote-server shape). The gateway key stays a placeholder — the real
 * secret is minted in Operate and never rendered into page state.
 */
export function mcpClientConfig(serverName: string, endpointUrl: string): string {
  return JSON.stringify({
    mcpServers: {
      [serverName]: {
        url: endpointUrl,
        headers: { Authorization: 'Bearer <your-gateway-key>' },
      },
    },
  }, null, 2);
}
