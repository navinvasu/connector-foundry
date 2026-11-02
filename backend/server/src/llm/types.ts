// LLM provider seam (D-88, HK-01 A5). One small chat interface with tool
// calling; adapters translate it to a provider's wire format. Nothing above
// this layer knows which vendor answers: Bedrock (Nova 2 Lite) today, Meta
// Muse Spark (OpenAI-compatible) by config, Claude or OpenAI the same way.

import { HttpError } from '../errors.js';

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments (an object schema). */
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ChatRequest {
  system?: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  stopReason: string;
  provider: string;
  model: string;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export type LlmErrorCode = 'llm_not_configured' | 'llm_budget_exceeded' | 'llm_upstream_error' | 'llm_bad_output';

const LLM_STATUS: Record<LlmErrorCode, number> = {
  llm_not_configured: 503,
  llm_budget_exceeded: 429,
  llm_upstream_error: 502,
  llm_bad_output: 502,
};

/** An HttpError, so routes can let it propagate to the error middleware. */
export class LlmError extends HttpError {
  constructor(message: string, code: LlmErrorCode) {
    super(LLM_STATUS[code], code, message);
    this.name = 'LlmError';
  }
}
