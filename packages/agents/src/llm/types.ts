// Provider-facing types (brief §8). Message and content shapes are the Anthropic SDK's own.

import type Anthropic from '@anthropic-ai/sdk';

export type LlmMessage = Anthropic.Beta.BetaMessageParam;
export type LlmContentBlock = Anthropic.Beta.BetaContentBlock;
export type LlmToolUse = Anthropic.Beta.BetaToolUseBlock;
export type LlmToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; [k: string]: unknown };
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  maxTokens: number;
  effort: Effort;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface LlmResponse {
  content: LlmContentBlock[];
  stopReason: string | null;
  /** The model that actually answered (differs from the request after a server-side fallback). */
  model: string;
  usage: LlmUsage;
}

/**
 * live     every request goes to the API
 * record   requests found on the cassette are replayed, the rest go to the API and are added
 * replay   only the cassette; a missing request is an error
 * scripted a test double driven by code. Never a recorded run and never labeled as one.
 */
export type LlmMode = 'live' | 'record' | 'replay' | 'scripted';

export interface LlmClient {
  readonly mode: LlmMode;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class LlmRefusalError extends Error {}
