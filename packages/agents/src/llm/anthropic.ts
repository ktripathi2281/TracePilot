// Live client: the Anthropic Messages API through the official SDK.
//
// Request shape notes for current models (Claude Sonnet 5.5 / Opus 5.5):
// - `tool_choice` stays `auto`: forcing a tool is rejected. The orchestrator steers with the
//   prompt and re-prompts when a turn ends without the tool call it needs.
// - Thinking is adaptive (the default when `thinking` is omitted); depth is set with
//   `output_config.effort`. Assistant content, thinking blocks included, is sent back unchanged.
// - Top-level `cache_control` caches the growing conversation prefix between tool-loop turns.
// - Server-side refusal fallback is on by default (`fallbacks: "default"`), so a policy decline
//   by the requested model is retried on its default fallback model inside the same call.

import Anthropic from '@anthropic-ai/sdk';
import { LlmRefusalError, type LlmClient, type LlmRequest, type LlmResponse } from './types.ts';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicLlmOptions {
  /** Server-side refusal fallback. Default true. */
  fallbacks?: boolean;
}

export class AnthropicLlm implements LlmClient {
  readonly mode = 'live' as const;
  private readonly client: Anthropic;
  private readonly fallbacks: boolean;

  constructor(options: AnthropicLlmOptions = {}) {
    // Credentials are resolved by the SDK from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
    // or an `ant auth login` profile). TracePilot never reads or stores a key itself.
    this.client = new Anthropic();
    this.fallbacks = options.fallbacks ?? true;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.beta.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      output_config: { effort: request.effort },
      cache_control: { type: 'ephemeral' },
      ...(this.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    });
    if (response.stop_reason === 'refusal') {
      throw new LlmRefusalError(
        `the model declined the request (category: ${response.stop_details?.category ?? 'unspecified'})`,
      );
    }
    return {
      content: response.content,
      stopReason: response.stop_reason,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

/** A one-line explanation of an API failure, most specific first; null if it is not an SDK error. */
export function describeLlmError(e: unknown): string | null {
  if (e instanceof Anthropic.AuthenticationError) {
    return 'the API rejected the credentials (set ANTHROPIC_API_KEY, or run `ant auth login`)';
  }
  if (e instanceof Anthropic.PermissionDeniedError) return `the API denied access: ${e.message}`;
  if (e instanceof Anthropic.NotFoundError)
    return `the API did not find the model or endpoint: ${e.message}`;
  if (e instanceof Anthropic.RateLimitError)
    return 'the API rate limit was hit; retry later (a recording resumes where it stopped)';
  if (e instanceof Anthropic.BadRequestError) return `the API rejected the request: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return `could not reach the API: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `API error ${String(e.status)}: ${e.message}`;
  if (e instanceof Anthropic.AnthropicError)
    return `${e.message} (set ANTHROPIC_API_KEY, or run \`ant auth login\`)`;
  // With no credentials at all the SDK throws a plain Error before sending anything.
  if (e instanceof Error && e.message.includes('Could not resolve authentication method'))
    return 'no API credentials found. Set ANTHROPIC_API_KEY in your environment (or run `ant auth login`), or replay a recorded run with TRACEPILOT_LLM=replay';
  return null;
}
