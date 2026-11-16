// LLM configuration from the environment (brief §1, §8).

import { join } from 'node:path';
import { AnthropicLlm } from './anthropic.ts';
import { CassetteLlm } from './cassette.ts';
import type { Effort, LlmClient } from './types.ts';

export interface LlmConfig {
  /** TRACEPILOT_LLM: live | record | replay. Default live. */
  mode: 'live' | 'record' | 'replay';
  /** TRACEPILOT_MODEL. Default claude-sonnet-5-5 (brief §1). */
  model: string;
  /** TRACEPILOT_VERIFIER_MODEL: model for the verifier's logic pass. Default: the main model. */
  verifierModel: string;
  /** TRACEPILOT_EFFORT. Default medium. */
  effort: Effort;
  /** MAX_TOKENS_PER_INVESTIGATION. Default 1,500,000 (all tokens read or written, cached included). */
  maxTokensPerInvestigation: number;
  /** TRACEPILOT_CASSETTE_DIR. Default <dataDir>/cassettes. */
  cassetteDir: string;
  /** TRACEPILOT_LLM_FALLBACKS: on | off. Default off: every answer comes from the requested model. */
  fallbacks: boolean;
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_TOKEN_BUDGET = 1_500_000;

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function llmConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  dataDir: string,
): LlmConfig {
  const mode = env['TRACEPILOT_LLM'] ?? 'live';
  if (mode !== 'live' && mode !== 'record' && mode !== 'replay') {
    throw new Error(`TRACEPILOT_LLM must be live, record or replay, got "${mode}"`);
  }
  const effort = env['TRACEPILOT_EFFORT'] ?? 'medium';
  if (!EFFORTS.includes(effort as Effort))
    throw new Error(`TRACEPILOT_EFFORT must be one of ${EFFORTS.join(', ')}, got "${effort}"`);
  const rawBudget = env['MAX_TOKENS_PER_INVESTIGATION'];
  const budget =
    rawBudget === undefined || rawBudget === '' ? DEFAULT_TOKEN_BUDGET : Number(rawBudget);
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error(
      `MAX_TOKENS_PER_INVESTIGATION must be a positive integer, got "${String(rawBudget)}"`,
    );
  }
  const fallbacks = env['TRACEPILOT_LLM_FALLBACKS'] || 'off';
  if (fallbacks !== 'on' && fallbacks !== 'off')
    throw new Error(`TRACEPILOT_LLM_FALLBACKS must be on or off, got "${fallbacks}"`);
  const model = env['TRACEPILOT_MODEL'] || DEFAULT_MODEL;
  return {
    mode,
    model,
    verifierModel: env['TRACEPILOT_VERIFIER_MODEL'] || model,
    effort: effort as Effort,
    maxTokensPerInvestigation: budget,
    cassetteDir: env['TRACEPILOT_CASSETTE_DIR'] || join(dataDir, 'cassettes'),
    fallbacks: fallbacks === 'on',
  };
}

/** One cassette per incident: `<cassetteDir>/<incidentId>.json`. */
export const cassettePath = (config: LlmConfig, incidentId: string): string =>
  join(config.cassetteDir, `${incidentId}.json`);

export function createLlmClient(config: LlmConfig, incidentId: string): LlmClient {
  if (config.mode === 'replay') return new CassetteLlm('replay', cassettePath(config, incidentId));
  const live = new AnthropicLlm({ fallbacks: config.fallbacks });
  return config.mode === 'record'
    ? new CassetteLlm('record', cassettePath(config, incidentId), live)
    : live;
}
