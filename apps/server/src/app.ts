// The TracePilot API (brief §9): REST over the telemetry store and the saved investigation and
// replay records, SSE for running an investigation, and the built web UI.
//
// Information boundary: everything served comes from telemetry (the store), from records the
// tools wrote (investigations, replays), or from replays computed here. The simulator recording
// (<data>/sim/) is read in-process by the Replayer and never served; eval ground truth is never
// read (lint forbids the import). Responses that echo the recording are impossible by
// construction: no route reads <data>/sim/ except through the Replayer, whose outputs are
// simulator-computed summaries.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  Investigation,
  ToolContext,
  createLlmClient,
  investigate,
  llmConfigFromEnv,
  type InvestigationEvent,
  type LlmClient,
} from '@tracepilot/agents';
import { ScriptedLlm, protocolScript } from '@tracepilot/agents/testing';
import type { Sweep } from '@tracepilot/replay';
import {
  DiagnosisFileError,
  IdentityReplayError,
  REPLAY_NOTICE,
  ReplayRun,
  Replayer,
  readRecommendations,
  readSimRecording,
  simRecordingPath,
} from '@tracepilot/replay';
import {
  GLOBAL_KNOBS,
  IncidentId,
  MODEL_VARIANTS,
  Patch,
  PatchTarget,
  TraceId,
} from '@tracepilot/schema';
import { MODELED_VARIANTS, UnsupportedKnobError } from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { overview, serviceDetail, timeline } from './views.ts';

export const INVESTIGATIONS_DIR = 'investigations';
export const REPLAYS_DIR = 'replays';
export const STORE_FILE = 'telemetry.db';
/** Recorded as the model of a scripted-fixture run: no model answered. */
export const FIXTURE_MODEL = 'none (scripted fixture)';

export interface AppOptions {
  /** The data directory `tracepilot sim run` wrote (default .data). */
  dataDir: string;
  /** Built web UI to serve at `/`; omitted = API only. */
  webDist?: string;
  /** Environment for live investigations (LLM settings, credentials are read by the SDK). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Where an investigation's model turns came from, as the UI labels it. */
export type InvestigationSource = 'live' | 'recorded' | 'scripted fixture';
export const sourceOf = (inv: Investigation): InvestigationSource =>
  inv.llm.mode === 'scripted' ? 'scripted fixture' : inv.llm.recorded ? 'recorded' : 'live';

const ReplayBody = z.strictObject({ patches: z.array(Patch).max(8) });
const SweepBody = z.strictObject({
  param: PatchTarget,
  values: z.array(z.number().int().positive()).min(2).max(20),
  patches: z.array(Patch).max(8).default([]),
});
const RunBody = z.strictObject({ mode: z.enum(['fixture', 'env']) });
const ReplayId = z.string().regex(/^rp_[0-9a-f]{12}$/);

class HttpError extends Error {
  readonly status: 400 | 404 | 409 | 422 | 503;
  constructor(status: 400 | 404 | 409 | 422 | 503, message: string) {
    super(message);
    this.status = status;
  }
}

/** Knobs offered in the replay lab. Current values only where TELEMETRY shows them. */
export function knobCatalog(ctx: ToolContext) {
  const services = ctx.graph.nodes.filter((n) => n.kind === 'service').map((n) => n.service);
  const poolCapacity = ctx.series
    .find((s) => s.service === 'db' && s.name === 'pool_capacity')
    ?.points.at(-1);
  /** The latest `to` of a numeric change-event diff for this knob, if any. */
  const fromChanges = (service: string, key: string): number | null => {
    let v: number | null = null;
    for (const c of ctx.changes) {
      const d = c.service === service ? c.diff[key] : undefined;
      if (d !== undefined && typeof d.to === 'number') v = d.to;
    }
    return v;
  };
  const knob = (
    target: string,
    label: string,
    unit: 'count' | 'us',
    min: number,
    max: number,
    current: number | null,
    source: string | null,
  ) => ({
    target,
    label,
    unit,
    min,
    max,
    current,
    currentSource: source,
  });
  const knobs = [
    knob(
      'db.pool.capacity',
      'DB pool',
      'count',
      1,
      200,
      poolCapacity?.value ?? null,
      poolCapacity === undefined ? null : 'metric db pool_capacity',
    ),
    knob('db.acquireTimeoutUs', 'DB acquire timeout', 'us', 100_000, 30_000_000, null, null),
  ];
  for (const s of services) {
    for (const [key, label, unit, min, max] of [
      ['workers', 'workers', 'count', 1, 400],
      ['replicas', 'replicas', 'count', 1, 10],
      ['queueLimit', 'queue limit', 'count', 0, 4000],
      ['timeoutUs', 'timeout', 'us', 100_000, 60_000_000],
    ] as const) {
      const current = fromChanges(s, key);
      knobs.push(
        knob(
          `${s}.${key}`,
          `${s} ${label}`,
          unit,
          min,
          max,
          current,
          current === null ? null : 'change event diff',
        ),
      );
    }
  }
  return {
    notice: REPLAY_NOTICE,
    knobs: knobs.filter((k) => PatchTarget.safeParse(k.target).success),
    globalKnobs: GLOBAL_KNOBS,
    reverts: ctx.changes.map((c) => ({
      id: c.id,
      service: c.service,
      kind: c.kind,
      ts: c.ts,
      description: c.description,
    })),
    variants: MODEL_VARIANTS.map((v) => ({ variant: v, modeled: MODELED_VARIANTS.includes(v) })),
    services,
  };
}

export interface TracePilotApp {
  app: Hono;
  /** Closes the telemetry store. */
  close: () => void;
}

export function createApp(options: AppOptions): TracePilotApp {
  const dataDir = resolve(options.dataDir);
  const storePath = join(dataDir, STORE_FILE);
  if (!existsSync(storePath))
    throw new Error(`no telemetry store at ${storePath}; run \`tracepilot sim run\` first`);
  const store = new TelemetryStore(storePath);
  const contexts = new Map<string, ToolContext>();
  const replayers = new Map<string, Replayer>();

  const incidentParam = (c: Context): string => {
    const parsed = IncidentId.safeParse(c.req.param('incident'));
    if (!parsed.success || !store.listIncidents().some((i) => i.id === parsed.data))
      throw new HttpError(404, 'no such incident');
    return parsed.data;
  };
  const ctxOf = (id: string): ToolContext => {
    let ctx = contexts.get(id);
    if (ctx === undefined) contexts.set(id, (ctx = new ToolContext(store, id)));
    return ctx;
  };
  const replayerOf = (id: string): Replayer => {
    let r = replayers.get(id);
    if (r !== undefined) return r;
    if (!existsSync(simRecordingPath(dataDir, id)))
      throw new HttpError(
        409,
        'this incident has no simulator recording, so it cannot be replayed',
      );
    const file = readSimRecording(dataDir, id);
    if (file.telemetryHash !== store.getIncident(id).telemetryHash)
      throw new HttpError(409, 'the recording does not match the stored telemetry');
    r = new Replayer({
      incidentId: id,
      recording: file.recording,
      telemetryHash: file.telemetryHash,
    });
    replayers.set(id, r);
    return r;
  };
  const investigationFile = (id: string): string => join(dataDir, INVESTIGATIONS_DIR, `${id}.json`);
  const readInvestigation = (id: string): Investigation | null => {
    const path = investigationFile(id);
    return existsSync(path) ? Investigation.parse(JSON.parse(readFileSync(path, 'utf8'))) : null;
  };
  const saveReplay = (id: string, data: unknown): void => {
    mkdirSync(join(dataDir, REPLAYS_DIR), { recursive: true });
    writeFileSync(join(dataDir, REPLAYS_DIR, `${id}.json`), `${JSON.stringify(data)}\n`);
  };
  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (e) {
      if (e instanceof SyntaxError) throw new HttpError(400, 'body must be JSON');
      throw e;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      throw new HttpError(
        400,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    return parsed.data;
  };
  const replayErrors = (e: unknown): never => {
    if (e instanceof UnsupportedKnobError || e instanceof DiagnosisFileError)
      throw new HttpError(422, e.message);
    if (e instanceof IdentityReplayError) throw new HttpError(409, e.message);
    if (e instanceof Error && /^cannot revert |^knob |^invalid sim config/.test(e.message))
      throw new HttpError(422, e.message);
    throw e;
  };

  const app = new Hono();
  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    console.error(e);
    return c.json({ error: 'internal error' }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true, notice: REPLAY_NOTICE }));
  app.get('/api/incidents', (c) => c.json(store.listIncidents()));
  app.get('/api/incidents/:incident/overview', (c) => c.json(overview(ctxOf(incidentParam(c)))));
  app.get('/api/incidents/:incident/timeline', (c) => c.json(timeline(ctxOf(incidentParam(c)))));
  app.get('/api/incidents/:incident/services/:service', (c) => {
    const ctx = ctxOf(incidentParam(c));
    const service = c.req.param('service');
    if (!ctx.incident.services.includes(service)) throw new HttpError(404, 'no such service');
    return c.json(serviceDetail(ctx, service));
  });
  app.get('/api/incidents/:incident/traces/:trace', (c) => {
    const id = incidentParam(c);
    const trace = TraceId.safeParse(c.req.param('trace'));
    if (!trace.success) throw new HttpError(404, 'no such trace');
    const spans = store.getTrace(id, trace.data);
    if (spans.length === 0) throw new HttpError(404, 'no such trace');
    return c.json(spans);
  });
  app.get('/api/incidents/:incident/evidence/:evidence', (c) => {
    const ev = store.getEvidence(incidentParam(c), c.req.param('evidence'));
    if (ev === undefined) throw new HttpError(404, 'no such evidence');
    return c.json(ev);
  });

  // ---- investigations ----
  app.get('/api/incidents/:incident/investigation', (c) => {
    const inv = readInvestigation(incidentParam(c));
    if (inv === null) throw new HttpError(404, 'no saved investigation for this incident');
    return c.json({ source: sourceOf(inv), investigation: inv });
  });
  /**
   * Runs an investigation and streams its events (SSE). `fixture` uses the scripted test double
   * (labelled as such, no API key); `env` uses TRACEPILOT_LLM and the credentials of the server's
   * environment (live, record or replay from a cassette). The record is saved when it ends.
   */
  app.post('/api/incidents/:incident/investigation/run', async (c) => {
    const id = incidentParam(c);
    const { mode } = await body(c, RunBody);
    let llm: LlmClient;
    let config;
    try {
      config = llmConfigFromEnv(options.env ?? process.env, dataDir);
      llm = mode === 'fixture' ? new ScriptedLlm(protocolScript()) : createLlmClient(config, id);
    } catch (e) {
      throw new HttpError(503, e instanceof Error ? e.message : String(e));
    }
    return streamSSE(c, async (stream) => {
      // The engine reports events synchronously; they are written in order as it runs, and the
      // stream flushes whenever the engine waits for the model.
      let sent: Promise<unknown> = Promise.resolve();
      const send = (event: string, data: unknown): void => {
        sent = sent.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
      };
      try {
        const inv = await investigate({
          store,
          incidentId: id,
          llm,
          // A fixture run has no model; say so instead of naming the configured one.
          model: mode === 'fixture' ? FIXTURE_MODEL : config.model,
          verifierModel: mode === 'fixture' ? FIXTURE_MODEL : config.verifierModel,
          effort: config.effort,
          maxTokens: config.maxTokensPerInvestigation,
          onEvent: (e: InvestigationEvent) => {
            send('progress', e);
          },
        });
        await sent;
        mkdirSync(join(dataDir, INVESTIGATIONS_DIR), { recursive: true });
        writeFileSync(investigationFile(id), `${JSON.stringify(inv, null, 1)}\n`);
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ source: sourceOf(inv), outcome: inv.outcome }),
        });
      } catch (e) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
        });
      }
    });
  });

  // ---- replay ----
  app.get('/api/incidents/:incident/replay/knobs', (c) =>
    c.json(knobCatalog(ctxOf(incidentParam(c)))),
  );
  app.post('/api/incidents/:incident/replay', async (c) => {
    const id = incidentParam(c);
    const { patches } = await body(c, ReplayBody);
    let run: ReplayRun;
    try {
      run = replayerOf(id).replay(patches);
    } catch (e) {
      return replayErrors(e);
    }
    saveReplay(run.id, run);
    return c.json(run);
  });
  app.post('/api/incidents/:incident/replay/diagnosis', (c) => {
    const id = incidentParam(c);
    const path = investigationFile(id);
    if (!existsSync(path)) throw new HttpError(404, 'no saved investigation for this incident');
    try {
      const { recommendations } = readRecommendations(path, id);
      const comparison = replayerOf(id).replayRecommendations(
        recommendations,
        `${INVESTIGATIONS_DIR}/${id}.json`,
      );
      for (const r of comparison.rows) if (r.run !== null) saveReplay(r.run.id, r.run);
      return c.json(comparison);
    } catch (e) {
      return replayErrors(e);
    }
  });
  app.post('/api/incidents/:incident/sweep', async (c) => {
    const id = incidentParam(c);
    const { param, values, patches } = await body(c, SweepBody);
    let sweep: Sweep;
    try {
      sweep = replayerOf(id).sweep(
        param,
        [...new Set(values)].sort((a, b) => a - b),
        patches,
      );
    } catch (e) {
      return replayErrors(e);
    }
    return c.json(sweep);
  });
  app.get('/api/incidents/:incident/replays', (c) => {
    const id = incidentParam(c);
    const dir = join(dataDir, REPLAYS_DIR);
    const runs = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /^rp_[0-9a-f]{12}\.json$/.test(f))
          .flatMap((f) => {
            const r = ReplayRun.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
            return r.success && r.data.incidentId === id ? [r.data] : [];
          })
      : [];
    return c.json(
      runs.map((r) => ({
        id: r.id,
        patches: r.patches,
        verdict: r.verdict,
        source: r.source.kind,
      })),
    );
  });
  app.get('/api/replays/:replay', (c) => {
    const id = ReplayId.safeParse(c.req.param('replay'));
    const path = id.success ? join(dataDir, REPLAYS_DIR, `${id.data}.json`) : '';
    if (!id.success || !existsSync(path)) throw new HttpError(404, 'no such replay');
    return c.json(ReplayRun.parse(JSON.parse(readFileSync(path, 'utf8'))));
  });

  app.all('/api/*', () => {
    throw new HttpError(404, 'no such endpoint');
  });

  // ---- the web UI (static, built) ----
  if (options.webDist !== undefined && existsSync(options.webDist)) {
    const root = options.webDist;
    app.use('/assets/*', serveStatic({ root }));
    app.get('*', (c) => c.html(readFileSync(join(root, 'index.html'), 'utf8')));
  }
  return {
    app,
    close: () => {
      store.close();
    },
  };
}
