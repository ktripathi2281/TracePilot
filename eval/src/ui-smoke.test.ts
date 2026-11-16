// UI smoke test (Phase 5): build the web UI, start the server on scenario A with a saved
// scripted-fixture investigation and NO API key, and click through all four views in a real
// browser.
//
// The browser is the system's Edge or Chrome, driven by playwright-core (no browser download).
// Set TRACEPILOT_BROWSER to a browser executable to use another one. Set TRACEPILOT_SMOKE_SHOTS
// to a directory to keep a screenshot of each view.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { investigate } from '@tracepilot/agents';
import { ScriptedLlm, protocolScript } from '@tracepilot/agents/testing';
import { REPLAY_NOTICE, simRecordingPath, type SimRecordingFile } from '@tracepilot/replay';
import { startServer, type RunningServer } from '@tracepilot/server';
import { hashTelemetry, recordPoolExhaustion, runSimulation } from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';
import type { Browser, Page } from 'playwright-core';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './ui-kit.ts';

const WEB_ROOT = fileURLToPath(new URL('../../apps/web', import.meta.url));
const SHOTS = process.env['TRACEPILOT_SMOKE_SHOTS'];

let dir: string;
let incidentId: string;
let server: RunningServer;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

async function shot(name: string): Promise<void> {
  if (SHOTS === undefined || SHOTS === '') return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tracepilot-ui-'));
  // Data as `tracepilot sim run` writes it.
  const recording = recordPoolExhaustion(42);
  const { telemetry } = runSimulation(recording.config, recording.workload);
  const store = new TelemetryStore(join(dir, 'telemetry.db'));
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
  mkdirSync(join(dir, 'sim'));
  writeFileSync(simRecordingPath(dir, incidentId), JSON.stringify(file));
  // A saved investigation, as `investigate` saves it; here played by the scripted fixture.
  const inv = await investigate({
    store,
    incidentId,
    llm: new ScriptedLlm(protocolScript()),
    model: 'none (scripted fixture)',
    maxTokens: 1e6,
  });
  store.close();
  mkdirSync(join(dir, 'investigations'));
  writeFileSync(join(dir, 'investigations', `${incidentId}.json`), JSON.stringify(inv));

  const webDist = join(dir, 'web');
  await build({
    root: WEB_ROOT,
    configFile: join(WEB_ROOT, 'vite.config.ts'),
    logLevel: 'error',
    build: { outDir: webDist, emptyOutDir: true },
  });
  server = await startServer({ dataDir: dir, webDist, port: 0, env: {} });
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
}, 300_000);

afterAll(async () => {
  await browser.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const byTest = (id: string) => page.getByTestId(id);

describe('UI smoke test on scenario A (no API key)', () => {
  it('Overview: headline p99, failures and throughput, and the service graph colored by health', async () => {
    await page.goto(`${server.url}/`);
    await byTest('view-overview').waitFor();
    await expect
      .poll(() => byTest('headline-p99').innerText())
      .toMatch(/P99 LATENCY\s+\d+\.\d+ s\s+baseline \d+ ms/i);
    expect(await byTest('headline-failures').innerText()).toMatch(
      /FAILED REQUESTS\s+[\d,]+\s+baseline 0/i,
    );
    expect(await byTest('headline-throughput').innerText()).toMatch(
      /THROUGHPUT \(OK\)\s+[\d.]+\/s\s+baseline [\d.]+\/s/i,
    );
    for (const svc of ['api-gateway', 'checkout', 'inventory', 'payment', 'db'])
      await byTest(`node-${svc}`).waitFor();
    expect(await byTest('node-checkout').getAttribute('data-health')).toBe('failing');
    expect(await byTest('node-db').getAttribute('data-health')).toBe('degraded');
    expect(await byTest('deploys').innerText()).toMatch(/ev_2/);
    await shot('1-overview');
  });

  it('Incident: timeline, then a service from the graph, its charts, a trace waterfall', async () => {
    await page.locator('.react-flow__node', { has: byTest('node-checkout') }).click();
    await byTest('view-incident').waitFor();
    expect(page.url()).toMatch(/#\/incident\/in_\w+\?service=checkout$/);
    expect(await byTest('tl-change').count()).toBe(2);
    expect(await byTest('tl-anomaly_onset').count()).toBeGreaterThan(5);
    await byTest('tl-change').last().click();
    expect(await byTest('timeline-picked').innerText()).toMatch(/T\+10:00\.000 checkout · deploy/);
    await byTest('service-panel').waitFor();
    expect(await byTest('chart-latency_p99').locator('canvas').count()).toBeGreaterThan(0);
    await byTest('traces').locator('button').first().click();
    await byTest('waterfall').waitFor();
    expect(await byTest('waterfall').innerText()).toMatch(/db\.pool\.acquire/);
    await shot('2-incident');
  });

  it('Investigation: source badge, hypothesis board, and an evidence chip opening the evidence', async () => {
    await byTest('nav-investigation').click();
    await byTest('view-investigation').waitFor();
    await byTest('hypothesis-board').waitFor();
    expect(await byTest('source-badge').innerText()).toBe('scripted fixture');
    expect(await byTest('hypothesis').count()).toBe(3);
    const board = await byTest('hypothesis-board').innerText();
    expect(board).toMatch(/hold_and_wait[\s\S]*supported/);
    expect(board).toMatch(/pool_capacity[\s\S]*rejected/);
    expect(board).toMatch(/db_slow[\s\S]*rejected/);
    expect(await byTest('diagnosis').innerText()).toMatch(/root cause[\s\S]*hold_and_wait/i);
    expect(await byTest('verifier').innerText()).toMatch(/passed/);
    await byTest('diagnosis').getByTestId('evidence-chip').first().click();
    await byTest('evidence-panel').waitFor();
    await byTest('evidence-item').first().waitFor();
    expect(await byTest('evidence-panel').innerText()).toMatch(/FACT/);
    expect(await byTest('evidence-item').first().innerText()).toMatch(/^(sp|mt|lg|ev)_/);
    await shot('3-investigation');
    await page.getByRole('button', { name: 'close' }).click();
  });

  it('Replay lab: the notice is always visible; a recommendation replays and a sweep finds the knee', async () => {
    // From the diagnosis straight into the lab with the cause patch preset.
    await byTest('replay-recommendation').first().click();
    await byTest('view-replay').waitFor();
    await expect.poll(() => byTest('replay-notice').innerText()).toBe(REPLAY_NOTICE);
    expect(await byTest('revert-ev_2').isChecked()).toBe(true);
    await byTest('run-replay').click();
    await byTest('replay-result').waitFor({ timeout: 60_000 });
    expect(await byTest('verdict').innerText()).toBe('resolves');
    expect(await byTest('delta-failures').innerText()).toMatch(
      /FAILED REQUESTS\s+0\s+original [\d,]+/i,
    );
    expect(await byTest('delta-p99').innerText()).toMatch(/P99 LATENCY\s+\d+ ms/i);
    expect(await byTest('delta-throughput').innerText()).toMatch(/THROUGHPUT/i);
    expect(await byTest('windows').innerText()).toMatch(
      /baseline T\+\d+:\d\d–T\+\d+:\d\d · incident T\+10:00–T\+15:00/,
    );
    expect(await byTest('replay-chart').count()).toBe(6);

    // The symptom patch: a knob, with its side effect.
    await byTest('revert-ev_2').uncheck();
    await byTest('knob-db.pool.capacity').fill('64');
    await byTest('run-replay').click();
    await expect
      .poll(() => byTest('side-effects').innerText(), { timeout: 60_000 })
      .toMatch(/new bottleneck\s+db\.executor/i);

    await byTest('sweep-from').fill('40');
    await byTest('sweep-to').fill('80');
    await byTest('run-sweep').click();
    await byTest('sweep-result').waitFor({ timeout: 120_000 });
    expect(await byTest('knee').innerText()).toBe('knee 60');
    expect(await byTest('sweep-chart').locator('canvas').count()).toBeGreaterThan(0);
    // Scrolled down to the sweep, the notice is still on screen.
    await byTest('sweep-result').scrollIntoViewIfNeeded();
    expect(await byTest('replay-notice').isVisible()).toBe(true);
    const box = await byTest('replay-notice').boundingBox();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    await shot('4-replay');
  });

  it('raised no errors in the page', () => {
    expect(pageErrors).toEqual([]);
  });
});
