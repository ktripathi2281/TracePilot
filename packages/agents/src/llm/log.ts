// Request/response log (brief §8): one JSON line per LLM call, appended to a file.
//
// For debugging and cost review only. Nothing reads it back, and it is not a cassette: a
// conversation resends its whole history on every call, so each line holds the request's hash and
// its NEWEST message rather than the full request, plus the complete response and its usage.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashRequest } from './cassette.ts';
import type { LlmClient, LlmMode, LlmRequest, LlmResponse } from './types.ts';

export class LoggingLlm implements LlmClient {
  readonly mode: LlmMode;
  readonly path: string;
  private readonly inner: LlmClient;
  private calls = 0;

  constructor(inner: LlmClient, path: string) {
    this.inner = inner;
    this.mode = inner.mode;
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  private write(record: Record<string, unknown>): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const call = ++this.calls;
    const started = Date.now();
    const head = {
      at: new Date(started).toISOString(),
      call,
      mode: this.mode,
      request: {
        hash: hashRequest(request),
        model: request.model,
        effort: request.effort,
        maxTokens: request.maxTokens,
        tools: request.tools.map((t) => t.name),
        messages: request.messages.length,
        newest: request.messages.at(-1) ?? null,
      },
    };
    try {
      const response = await this.inner.complete(request);
      this.write({ ...head, ms: Date.now() - started, response });
      return response;
    } catch (e) {
      this.write({
        ...head,
        ms: Date.now() - started,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
      throw e;
    }
  }
}
