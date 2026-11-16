// The API on scenario A: what it serves, and what it must never serve (brief §0, §1): ground
// truth, simulator config, the recording. Data is created the way `tracepilot sim run` creates it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Investigation } from '@tracepilot/agents';
import { investigate } from '@tracepilot/agents';
import { ScriptedLlm, protocolScript } from '@tracepilot/agents/testing';
import { REPLAY_NOTICE, simRecordingPath, type SimRecordingFile } from '@tracepilot/replay';
import { hashTelemetry, recordPoolExhaustion, runSimulation } from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_MODEL, STORE_FILE, createApp, sourceOf } from './app.ts';
import type { KnobCatalog, Overview, ServiceDetail, Timeline } from './api-types.ts';

let dir: string;
let app: Hono;
let closeApp: () => void;
let incidentId: string;
const responses: string[] = [];

async function get(path: string): Promise<{ status: number; text: string; json: unknown }> {
  const res = await app.request(path);
  const text = await res.text();
  responses.push(text);
  let json: unknown = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) json = JSON.parse(text);
  return { status: res.status, text, json };
}
async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; text: string; json: unknown }> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  responses.push(text);
  return {
    status: res.status,
    text,
    json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tracepilot-server-'));
  const recording = recordPoolExhaustion(42);
  const { telemetry } = runSimulation(recording.config, recording.workload);
  const store = new TelemetryStore(join(dir, STORE_FILE));
  const { incident } = store.ingest(telemetry, { source: 'synthetic' });
  incidentId = incident.id;
  const file: SimRecordingFile = {
    formatVersion: 1,
    incidentId,
    scenario: 'pool-exhaustion',
    seed: 42,
    telemetryHash: hashTelemetry(telemetry),
    recording,
  };
  mkdirSync(join(dir, 'sim'), { recursive: true });
  writeFileSync(simRecordingPath(dir, incidentId), JSON.stringify(file));
  store.close();
  // A fake built UI, to check that static serving cannot reach the data directory.
  mkdirSync(join(dir, 'web', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>ui</title>');
  writeFileSync(join(dir, 'web', 'assets', 'a.js'), 'console.log(1)');
  ({ app, close: closeApp } = createApp({ dataDir: dir, webDist: join(dir, 'web'), env: {} }));
}, 120_000);
afterAll(() => {
  closeApp();
  rmSync(dir, { recursive: true, force: true });
});

describe('telemetry views', () => {
  it('overview: headline p99, failures and throughput, and per-service health', async () => {
    const r = await get(`/api/incidents/${incidentId}/overview`);
    expect(r.status).toBe(200);
    const o = r.json as Overview;
    expect(o.entryServices).toEqual(['api-gateway']);
    expect(o.headline.incident.p99Us).toBeGreaterThan(10 * (o.headline.baseline.p99Us ?? Infinity));
    expect(o.headline.incident.failures).toBeGreaterThan(1000);
    expect(o.headline.baseline.failures).toBe(0);
    expect(o.headline.incident.throughputPerS).toBeLessThan(
      o.headline.baseline.throughputPerS ?? 0,
    );
    const health = Object.fromEntries(o.services.map((s) => [s.service, s.health]));
    expect(health).toMatchObject({ 'api-gateway': 'failing', checkout: 'failing', db: 'degraded' });
    expect(o.changes.map((c) => c.id)).toEqual(['ev_1', 'ev_2']);
  });

  it('timeline, service detail, trace and evidence', async () => {
    const t = (await get(`/api/incidents/${incidentId}/timeline`)).json as Timeline;
    expect(new Set(t.entries.map((e) => e.kind))).toEqual(
      new Set(['change', 'anomaly_onset', 'anomaly_recovered', 'log_burst']),
    );
    expect(t.affected).toContain('checkout');
    const s = (await get(`/api/incidents/${incidentId}/services/checkout`)).json as ServiceDetail;
    expect(s.metrics.map((m) => m.metric)).toContain('latency_p99');
    expect(s.traces.length).toBeGreaterThan(5);
    const first = s.traces[0];
    if (first === undefined) throw new Error('no traces');
    const spans = (await get(`/api/incidents/${incidentId}/traces/${first.traceId}`))
      .json as unknown[];
    expect(spans.length).toBeGreaterThan(5);
    const ev = await get(`/api/incidents/${incidentId}/evidence/ev_2`);
    expect(ev.json).toMatchObject({ kind: 'change', id: 'ev_2' });
  });

  it('answers unknown things with 404 and bad input with 400', async () => {
    expect((await get('/api/incidents/in_nope/overview')).status).toBe(404);
    expect((await get(`/api/incidents/${incidentId}/services/billing`)).status).toBe(404);
    expect((await get(`/api/incidents/${incidentId}/traces/xyz`)).status).toBe(404);
    expect((await get(`/api/incidents/${incidentId}/evidence/sp_0000000000000000`)).status).toBe(
      404,
    );
    expect((await get('/api/replays/rp_../../sim')).status).toBe(404);
    expect((await get('/api/nothing')).status).toBe(404);
    expect(
      (
        await post(`/api/incidents/${incidentId}/replay`, {
          patches: [{ target: 'db.pool.size', to: 1 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(`/api/incidents/${incidentId}/replay`, { patches: [{ revert: 'ev_9' }] })).status,
    ).toBe(422);
    const decoy = await post(`/api/incidents/${incidentId}/replay`, {
      patches: [{ variant: 'cache-reads', service: 'inventory' }],
    });
    expect(decoy.status).toBe(422);
    expect(decoy.text).toMatch(/not modeled by this simulator/);
  });
});

describe('replay lab', () => {
  it('offers knobs with current values only where telemetry shows them', async () => {
    const k = (await get(`/api/incidents/${incidentId}/replay/knobs`)).json as KnobCatalog;
    const current = (t: string) => k.knobs.find((x) => x.target === t);
    expect(current('db.pool.capacity')).toMatchObject({
      current: 30,
      currentSource: 'metric db pool_capacity',
    });
    expect(current('checkout.workers')).toMatchObject({
      current: 60,
      currentSource: 'change event diff',
    });
    expect(current('inventory.timeoutUs')).toMatchObject({ current: 8_000_000 });
    // The simulator config has these values, but telemetry does not show them: not exposed.
    expect(current('api-gateway.workers')?.current).toBeNull();
    expect(current('db.acquireTimeoutUs')?.current).toBeNull();
    expect(k.reverts.map((r) => r.id)).toEqual(['ev_1', 'ev_2']);
    expect(k.notice).toBe(REPLAY_NOTICE);
  });

  it('replays patches, a diagnosis and a sweep, every result with the notice', async () => {
    const run = await post(`/api/incidents/${incidentId}/replay`, {
      patches: [{ revert: 'ev_2' }],
    });
    expect(run.status).toBe(200);
    expect(run.json).toMatchObject({ verdict: 'resolves', notice: REPLAY_NOTICE });
    const id = (run.json as { id: string }).id;
    expect((await get(`/api/replays/${id}`)).json).toMatchObject({ id, verdict: 'resolves' });
    expect((await get(`/api/incidents/${incidentId}/replays`)).json).toContainEqual(
      expect.objectContaining({ id, verdict: 'resolves' }),
    );
    const sweep = await post(`/api/incidents/${incidentId}/sweep`, {
      param: 'db.pool.capacity',
      values: [50, 60, 70],
    });
    expect(sweep.json).toMatchObject({
      notice: REPLAY_NOTICE,
      knee: { value: 60 },
      resolvesFrom: 60,
    });
  });
});

describe('investigations', () => {
  it('has none until one is saved, then serves it with its source', async () => {
    expect((await get(`/api/incidents/${incidentId}/investigation`)).status).toBe(404);
    const res = await app.request(`/api/incidents/${incidentId}/investigation/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'fixture' }),
    });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const stream = await res.text();
    responses.push(stream);
    expect(stream).toMatch(/event: progress\ndata: \{"type":"stage","stage":"investigating"\}/);
    expect(stream).toMatch(
      /event: done\ndata: \{"source":"scripted fixture","outcome":"diagnosed"\}/,
    );
    const saved = await get(`/api/incidents/${incidentId}/investigation`);
    const body = saved.json as { source: string; investigation: Investigation };
    expect(body.source).toBe('scripted fixture');
    expect(body.investigation.llm).toMatchObject({ mode: 'scripted', model: FIXTURE_MODEL });

    const diag = await post(`/api/incidents/${incidentId}/replay/diagnosis`, {});
    expect(diag.json).toMatchObject({ notice: REPLAY_NOTICE });
  }, 120_000);

  it('labels the source of a record: live, recorded or scripted fixture', async () => {
    const store = new TelemetryStore(join(dir, STORE_FILE));
    try {
      const inv = await investigate({
        store,
        incidentId,
        llm: new ScriptedLlm(protocolScript()),
        model: 'm',
        maxTokens: 1e6,
      });
      expect(sourceOf(inv)).toBe('scripted fixture');
      expect(sourceOf({ ...inv, llm: { ...inv.llm, mode: 'replay', recorded: true } })).toBe(
        'recorded',
      );
      expect(sourceOf({ ...inv, llm: { ...inv.llm, mode: 'live', recorded: false } })).toBe('live');
      expect(sourceOf({ ...inv, llm: { ...inv.llm, mode: 'record', recorded: false } })).toBe(
        'live',
      );
    } finally {
      store.close();
    }
  }, 60_000);

  it('refuses a live run without credentials instead of hanging', async () => {
    const res = await app.request(`/api/incidents/${incidentId}/investigation/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'env' }),
    });
    const text = await res.text();
    expect(text).toMatch(/event: error\ndata: .*(no API credentials|authentication)/i);
  }, 60_000);
});

describe('information boundary', () => {
  // Things only the simulator config, the recording or the eval ground truth contain.
  const FORBIDDEN = [
    'pool-exhaustion',
    '"workload"',
    '"recording"',
    'maxParallelQueries',
    'traceSampleRate',
    'noiseLogMeanIntervalUs',
    '"disturbances"',
    '"requestTypes"',
    '"operations"',
    'payment provider degraded',
    'whyNotCausal',
    'discriminatingEvidence',
    'rejectedAlternatives',
    '"mechanism"',
    'arrivalUs',
  ];

  it('no static or API path reaches the data directory', async () => {
    const recording = readFileSync(simRecordingPath(dir, incidentId), 'utf8');
    for (const path of [
      `/sim/${incidentId}.json`,
      `/../sim/${incidentId}.json`,
      `/assets/../../sim/${incidentId}.json`,
      `/assets/..%2f..%2fsim%2f${incidentId}.json`,
      `/assets/%2e%2e/%2e%2e/sim/${incidentId}.json`,
      '/telemetry.db',
      `/investigations/${incidentId}.json`,
      `/api/incidents/${incidentId}/../../sim`,
    ]) {
      const r = await get(path);
      expect(r.text, path).not.toContain('"workload"');
      expect(r.text.length, path).toBeLessThan(recording.length / 100);
    }
    expect((await get('/assets/a.js')).text).toBe('console.log(1)');
  });

  it('no response served in this file contains simulator config or ground truth', () => {
    expect(responses.length).toBeGreaterThan(20);
    const all = responses.join('\n');
    for (const f of FORBIDDEN) expect(all, f).not.toContain(f);
  });
});
