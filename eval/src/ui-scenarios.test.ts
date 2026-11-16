// UI smoke test across all four scenarios in one data directory (no API key): the incident
// switcher, each scenario's signals (pods for D, the cache for C), and their replay knobs.
// Incidents keep their neutral IDs in the UI; the test maps them to scenarios itself.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPLAY_NOTICE } from '@tracepilot/replay';
import { startServer, type RunningServer } from '@tracepilot/server';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWeb, launchBrowser, simulateInto } from './ui-kit.ts';

const SHOTS = process.env['TRACEPILOT_SMOKE_SHOTS'];
let dir: string;
let server: RunningServer;
let browser: Browser;
let page: Page;
const ids: Record<string, string> = {};
const pageErrors: string[] = [];
const byTest = (id: string) => page.getByTestId(id);
const shot = async (name: string): Promise<void> => {
  if (SHOTS === undefined || SHOTS === '') return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tracepilot-ui4-'));
  for (const s of [
    'pool-exhaustion',
    'slow-dependency-retry-storm',
    'cache-hit-rate-drop',
    'bad-rollout-oomkill',
  ])
    ids[s] = simulateInto(dir, s);
  const webDist = join(dir, 'web');
  await buildWeb(webDist);
  server = await startServer({ dataDir: dir, webDist, port: 0, env: {} });
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
}, 600_000);

afterAll(async () => {
  await browser.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the UI with all four scenarios', () => {
  it('lists every incident by its neutral ID with its own headline, and switches between them', async () => {
    await page.goto(`${server.url}/`);
    await byTest('view-overview').waitFor();
    const options = await byTest('incident-select').locator('option').allTextContents();
    expect(options).toHaveLength(4);
    for (const o of options) expect(o).toMatch(/^in_\w+ · p99 [\d.]+ (ms|s), [\d,]+ failed$/);
    expect(new Set(options.map((o) => o.split(' · ')[1])).size).toBe(4); // headlines differ
    expect(await page.content()).not.toMatch(/pool-exhaustion|retry-storm|cache-hit-rate|oomkill/);

    const headlines = new Set<string>();
    for (const id of Object.values(ids)) {
      await byTest('incident-select').selectOption(id);
      await page.waitForURL(new RegExp(`#/overview/${id}`));
      // The overview renders only once its data for this incident has arrived.
      await page.locator(`[data-testid=view-overview][data-incident=${id}]`).waitFor();
      await byTest('node-checkout').waitFor();
      headlines.add(await byTest('headline-failures').innerText());
    }
    expect(headlines.size).toBe(4);
  });

  it('D: pod events on the timeline, ready pods and restarts in the service charts', async () => {
    await page.goto(
      `${server.url}/#/incident/${ids['bad-rollout-oomkill'] ?? ''}?service=checkout`,
    );
    await byTest('service-panel').waitFor();
    expect(await byTest('tl-pod_event').count()).toBeGreaterThan(5);
    for (const m of ['replicas_ready', 'pod_restarts', 'memory_working_set'])
      expect(await byTest(`chart-${m}`).locator('canvas').count(), m).toBeGreaterThan(0);
    await shot('d-incident');
  });

  it('C: the inventory cache hit ratio in the service charts', async () => {
    await page.goto(
      `${server.url}/#/incident/${ids['cache-hit-rate-drop'] ?? ''}?service=inventory`,
    );
    await byTest('service-panel').waitFor();
    expect(await byTest('chart-cache_hit_ratio').locator('canvas').count()).toBeGreaterThan(0);
    expect(await byTest('tl-pod_event').count()).toBe(0);
    await shot('c-incident');
  });

  it('A and B show neither pods nor a cache', async () => {
    for (const s of ['pool-exhaustion', 'slow-dependency-retry-storm']) {
      await page.goto(`${server.url}/#/incident/${ids[s] ?? ''}?service=checkout`);
      await byTest('service-panel').waitFor();
      expect(await byTest('chart-replicas_ready').count(), s).toBe(0);
      expect(await byTest('chart-cache_hit_ratio').count(), s).toBe(0);
    }
  });

  it('D replay lab: a memory-limit knob in MiB; raising it resolves the incident and keeps the pods ready', async () => {
    await page.goto(`${server.url}/#/replay/${ids['bad-rollout-oomkill'] ?? ''}`);
    await byTest('view-replay').waitFor();
    expect(await byTest('replay-notice').innerText()).toBe(REPLAY_NOTICE);
    await byTest('knob-checkout.memoryLimit').fill('1024');
    expect(await byTest('knob-checkout.replicas').count()).toBe(1); // replicas matter where pods run
    expect(await byTest('knob-cache.capacity').count()).toBe(0);
    await byTest('run-replay').click();
    await byTest('replay-result').waitFor({ timeout: 60_000 });
    expect(await byTest('verdict').innerText()).toBe('resolves');
    expect(await byTest('replay-result').innerText()).toContain('checkout.memoryLimit=1,024 MiB');
    expect(await byTest('replay-chart').count()).toBe(7); // six standard charts + checkout ready pods
    await shot('d-replay');
  });

  it('C replay lab: a cache-capacity knob; no memory limit', async () => {
    await page.goto(`${server.url}/#/replay/${ids['cache-hit-rate-drop'] ?? ''}`);
    await byTest('view-replay').waitFor();
    expect(await byTest('knob-cache.capacity').count()).toBe(1);
    expect(await byTest('knob-checkout.memoryLimit').count()).toBe(0);
    await byTest('revert-ev_2').check();
    await byTest('run-replay').click();
    await byTest('replay-result').waitFor({ timeout: 60_000 });
    expect(await byTest('verdict').innerText()).toBe('resolves');
  });

  it('raised no errors in the page', () => {
    expect(pageErrors).toEqual([]);
  });
});
