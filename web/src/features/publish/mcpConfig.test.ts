import { describe, it, expect } from 'vitest';
import { mcpEndpointUrl, mcpServerName, mcpClientConfig } from './mcpConfig';

describe('mcpEndpointUrl', () => {
  it('builds the hosted endpoint with the release selection encoded', () => {
    expect(mcpEndpointUrl('http://localhost:4000', 'p1', 'prod'))
      .toBe('http://localhost:4000/v1/mcp/p1?version=prod');
    expect(mcpEndpointUrl('https://api.example.com/', 'p 1', '1.0.0+rc'))
      .toBe('https://api.example.com/v1/mcp/p%201?version=1.0.0%2Brc');
  });
});

describe('mcpServerName', () => {
  it('slugifies the project name under the connector-foundry prefix', () => {
    expect(mcpServerName('Weather API')).toBe('connector-foundry-weather-api');
    expect(mcpServerName('  Acme—Billing!! ')).toBe('connector-foundry-acme-billing');
    expect(mcpServerName('')).toBe('connector-foundry');
  });
});

describe('mcpClientConfig', () => {
  it('renders paste-ready JSON with a key placeholder, never a secret', () => {
    const cfg = mcpClientConfig('connector-foundry-weather-api', 'http://localhost:4000/v1/mcp/p1?version=prod');
    const parsed = JSON.parse(cfg);
    expect(parsed.mcpServers['connector-foundry-weather-api'].url)
      .toBe('http://localhost:4000/v1/mcp/p1?version=prod');
    expect(parsed.mcpServers['connector-foundry-weather-api'].headers.Authorization)
      .toBe('Bearer <your-gateway-key>');
    expect(cfg).not.toContain('cf_live_');
  });
});
