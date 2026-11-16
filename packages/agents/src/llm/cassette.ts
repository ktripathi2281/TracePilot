// Cassettes (brief §8): real LLM request/response pairs recorded to disk, keyed by a hash of the
// request, so tests and offline demos replay a real past run.
//
// A cassette is only ever written by `record` mode from live API responses. Never edit one by
// hand; a hand-written cassette is a hardcoded demo (brief §0, rule 3).
//
// The file records where its responses came from (`upstream`). Tests exercise this mechanism with
// a scripted test double as the upstream; such a cassette says `upstream: "scripted"` and replays
// in mode `scripted`, so it can never be presented as a recorded model run.
//
// Replay works because the whole conversation is deterministic given the telemetry: tool results
// are deterministic, and assistant turns come from the cassette. Any change to prompts, tools or
// telemetry changes the request hash and is reported as a miss, never silently papered over.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../tools/types.ts';
import type { LlmClient, LlmContentBlock, LlmMode, LlmRequest, LlmResponse } from './types.ts';

export class CassetteMissError extends Error {}

const Entry = z.strictObject({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** For humans reading the file; the hash covers the full request. */
  request: z.strictObject({
    model: z.string(),
    effort: z.string(),
    maxTokens: z.number(),
    messages: z.number(),
    tools: z.number(),
    systemChars: z.number(),
  }),
  response: z.strictObject({
    content: z.array(z.record(z.string(), z.unknown())),
    stopReason: z.string().nullable(),
    model: z.string(),
    usage: z.strictObject({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number(),
      cacheCreationTokens: z.number(),
    }),
  }),
});

const CassetteFile = z.strictObject({
  formatVersion: z.literal(1),
  note: z.string(),
  /** What answered the recorded requests: the live API, or a scripted test double. */
  upstream: z.enum(['live', 'scripted']),
  entries: z.array(Entry),
});
type CassetteFile = z.infer<typeof CassetteFile>;

export const hashRequest = (request: LlmRequest): string =>
  createHash('sha256').update(canonicalJson(request)).digest('hex');

export class CassetteLlm implements LlmClient {
  /** `record` / `replay` for a cassette of live responses; `scripted` if a test double recorded it. */
  readonly mode: LlmMode;
  private readonly replayOnly: boolean;
  private readonly file: CassetteFile;
  private readonly byHash = new Map<string, LlmResponse>();
  /** Requests answered from the cassette / from the live API in this session. */
  replayed = 0;
  recorded = 0;

  readonly path: string;
  private readonly live: LlmClient | undefined;

  constructor(mode: 'record' | 'replay', path: string, live?: LlmClient) {
    this.replayOnly = mode === 'replay';
    this.path = path;
    this.live = live;
    if (mode === 'record' && live === undefined) throw new Error('record mode needs a live client');
    const upstream = live === undefined || live.mode === 'live' ? 'live' : 'scripted';
    if (existsSync(path)) {
      this.file = CassetteFile.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (mode === 'record' && this.file.upstream !== upstream)
        throw new Error(
          `cassette ${path} was recorded from a ${this.file.upstream} upstream; refusing to add ${upstream} responses to it`,
        );
    } else if (mode === 'replay') {
      throw new CassetteMissError(
        `no cassette at ${path}. Record one with TRACEPILOT_LLM=record (needs API credentials).`,
      );
    } else {
      this.file = {
        formatVersion: 1,
        note: 'LLM responses recorded by TRACEPILOT_LLM=record. Do not edit by hand.',
        upstream,
        entries: [],
      };
    }
    this.mode = this.file.upstream === 'scripted' ? 'scripted' : mode;
    for (const e of this.file.entries) {
      this.byHash.set(e.hash, {
        ...e.response,
        content: e.response.content as unknown as LlmContentBlock[],
      });
    }
  }

  get size(): number {
    return this.byHash.size;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const hash = hashRequest(request);
    const hit = this.byHash.get(hash);
    if (hit !== undefined) {
      this.replayed++;
      return hit;
    }
    if (this.replayOnly || this.live === undefined) {
      const recordedWith = [
        ...new Set(this.file.entries.map((e) => `${e.request.model}/${e.request.effort}`)),
      ].join(', ');
      throw new CassetteMissError(
        `cassette ${this.path} has no response for request ${hash.slice(0, 12)} (model ${request.model}, effort ${request.effort}, message ${String(request.messages.length)}). ` +
          `The prompts, tools or telemetry differ from the recorded run, or the model settings do (recorded with ${recordedWith || 'nothing'}). Re-record with TRACEPILOT_LLM=record.`,
      );
    }
    const response = await this.live.complete(request);
    this.recorded++;
    this.byHash.set(hash, response);
    this.file.entries.push({
      hash,
      request: {
        model: request.model,
        effort: request.effort,
        maxTokens: request.maxTokens,
        messages: request.messages.length,
        tools: request.tools.length,
        systemChars: request.system.length,
      },
      response: { ...response, content: response.content as unknown as Record<string, unknown>[] },
    });
    // Saved after every call, so an interrupted recording resumes where it stopped.
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.file, null, 1)}\n`);
    return response;
  }
}
