// `tracepilot replay` and `tracepilot sweep` (brief §7, §9).
//
//   replay --incident <id> [--patch <target>=<n>]... [--revert <changeEventId>]...
//          [--variant <variant>:<service>]... [--out <dir>] [--json]
//   replay --incident <id> --diagnosis <investigation.json> [--recommendation <rc_id>]...
//   sweep  --incident <id> --param <target> --range <from>:<to>:<step> [--patch ...] [--out <dir>]
//
// Replay works on simulated incidents: it needs the private recording written by `sim run`
// (<out>/sim/<id>.json) and checks that the store holds the same telemetry. Results are saved to
// <out>/replays/. Every output starts and ends with the "simulated model" notice.
//
// Exit codes (exit.ts): 0 done; 1 the replay could not be trusted (identity replay not exact);
// 64 bad input (unknown incident, no recording, a patch that does not apply).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fmtDur, fmtT } from '@tracepilot/agents';
import {
  DiagnosisFileError,
  IdentityReplayError,
  REPLAY_NOTICE,
  Replayer,
  parseRange,
  readRecommendations,
  readSimRecording,
  simRecordingPath,
  type Delta,
  type RecommendationComparison,
  type ReplayRun,
  type Sweep,
} from '@tracepilot/replay';
import {
  PatchTarget,
  RevertPatch,
  formatPatch,
  parsePatchArg,
  parseVariantArg,
  type Patch,
} from '@tracepilot/schema';
import { UnsupportedKnobError } from '@tracepilot/sim';
import { TelemetryStore } from '@tracepilot/store';
import { z } from 'zod';
import { EXIT } from './exit.ts';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const REPLAYS_DIR = 'replays';
const STORE_FILE = 'telemetry.db';

export const replayPath = (outDir: string, id: string): string =>
  join(outDir, REPLAYS_DIR, `${id}.json`);

class InputError extends Error {}

// ---- rendering ------------------------------------------------------------------------------

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

function fmtValue(unit: Delta['unit'], v: number): string {
  if (unit === 'ratio') return pct(v);
  if (unit === 'us') return fmtDur(v);
  if (unit === 'req/s') return `${v.toFixed(1)}/s`;
  return String(Math.round(v));
}

function fmtChange(d: Delta): string {
  if (d.direction === 'same') return 'same';
  const sign = d.change > 0 ? '+' : '−';
  const abs = Math.abs(d.change);
  const v =
    d.unit === 'ratio'
      ? `${(100 * abs).toFixed(1)} pts`
      : d.unit === 'us'
        ? fmtDur(abs)
        : d.unit === 'req/s'
          ? `${abs.toFixed(1)}/s`
          : String(Math.round(abs));
  return `${sign}${v} (${d.direction})`;
}

const pad = (s: string, n: number): string => s.padEnd(n);
const lpad = (s: string, n: number): string => s.padStart(n);

/** The analysis windows, inferred from the recorded telemetry and used for both runs. */
export const windowLine = (w: ReplayRun['windows']): string =>
  `  analysis windows (inferred from the recorded telemetry, same for every run): baseline ${fmtT(w.baseline.fromUs)} – ${fmtT(w.baseline.toUs)}, incident ${fmtT(w.incident.fromUs)} – ${fmtT(w.incident.toUs)}`;

export function renderReplay(run: ReplayRun): string[] {
  const lines: string[] = [REPLAY_NOTICE, ''];
  const patches =
    run.patches.length === 0 ? '(none: identity replay)' : run.patches.map(formatPatch).join(', ');
  lines.push(`REPLAY ${run.id} of ${run.incidentId}   patches: ${patches}`);
  if (run.source.kind === 'diagnosis')
    lines.push(
      `  from ${run.source.recommendationId} [addresses ${run.source.addresses}] "${run.source.title}" in ${run.source.file}`,
    );
  if (run.pins.length > 0) lines.push(`  pinned for the whole run: ${run.pins.join(', ')}`);
  lines.push(
    `  identity replay exact: telemetry ${run.identity.replayedHash.slice(0, 12)} = recorded ${run.identity.recordedHash.slice(0, 12)}`,
    windowLine(run.windows),
    `  compared on requests that finished in the incident window; (run) = whole run`,
    '',
    `  ${pad('', 34)}${lpad('original', 12)}${lpad('replay', 12)}   change`,
  );
  for (const d of run.headline)
    lines.push(
      `  ${pad(d.label, 34)}${lpad(fmtValue(d.unit, d.original), 12)}${lpad(fmtValue(d.unit, d.replay), 12)}   ${fmtChange(d)}`,
    );
  lines.push('', `VERDICT ${run.verdict}`);
  lines.push('', 'SIDE EFFECTS (saturation analyzer on the replayed telemetry)');
  if (run.sideEffects.length === 0) lines.push('  none');
  for (const s of run.sideEffects)
    lines.push(`  ${s.kind === 'relieved' ? '✓' : '!'} ${s.message}`);
  lines.push('', 'FAILURES BY SERVICE (errors, original → replay; first failing sample)');
  const before = new Map(run.original.failures.map((f) => [f.service, f]));
  for (const f of run.replay.failures) {
    const o = before.get(f.service);
    const at = (us: number | null | undefined): string =>
      us === null || us === undefined ? '—' : fmtT(us);
    lines.push(
      `  ${pad(f.service, 13)} ${lpad(String(o?.errors ?? 0), 7)} → ${lpad(String(f.errors), 7)}   ${at(o?.firstFailingUs)} → ${at(f.firstFailingUs)}`,
    );
  }
  const changes = run.changeEvents;
  if (changes.length > 0) {
    lines.push('', 'CHANGE EVENTS IN THE REPLAY');
    for (const c of changes) {
      const pinned = Object.entries(c.pinned ?? {});
      lines.push(
        `  ${c.id} ${c.kind} ${c.service} at ${fmtT(c.ts)}${pinned.length === 0 ? '' : `: ${pinned.map(([k, v]) => `${k} pinned at ${String(v)} (recorded diff ${String(c.diff[k]?.from)} → ${String(c.diff[k]?.to)} not applied)`).join('; ')}`}`,
      );
    }
  }
  const reverted = run.patches.flatMap((p) => ('revert' in p ? [p.revert] : []));
  if (reverted.length > 0)
    lines.push(`  reverted (removed from the replay): ${reverted.join(', ')}`);
  return lines;
}

export function renderComparison(c: RecommendationComparison): string[] {
  const lines: string[] = [REPLAY_NOTICE, '', 'RECOMMENDATIONS REPLAYED ONE BY ONE'];
  lines.push(
    `  ${pad('id', 6)}${pad('addresses', 10)}${pad('patch', 30)}${pad('verdict', 10)}${lpad('errors', 9)}${lpad('p99', 10)}  new pressure`,
  );
  for (const r of c.rows)
    lines.push(
      r.run === null
        ? `  ${pad(r.recommendationId, 6)}${pad(r.addresses, 10)}${pad(r.patch, 30)}not replayable: ${r.reason ?? ''}`
        : `  ${pad(r.recommendationId, 6)}${pad(r.addresses, 10)}${pad(r.patch, 30)}${pad(r.verdict, 10)}${lpad(pct(r.run.replay.incident.errorRate), 9)}${lpad(fmtDur(r.run.replay.incident.p99Us), 10)}  ${r.newBottlenecks.join(', ') || '—'}`,
    );
  const first = c.rows.find((r) => r.run !== null)?.run ?? null;
  if (first !== null) lines.splice(2, 0, windowLine(first.windows));
  if (first !== null)
    lines.push(
      `  ${pad('orig', 6)}${pad('', 10)}${pad('(no patch)', 30)}${pad('', 10)}${lpad(pct(first.original.incident.errorRate), 9)}${lpad(fmtDur(first.original.incident.p99Us), 10)}`,
    );
  lines.push('', ...c.findings.map((f) => `  - ${f}`));
  return lines;
}

export function renderSweep(s: Sweep): string[] {
  const lines: string[] = [REPLAY_NOTICE, '', `SWEEP ${s.param} on ${s.incidentId}`];
  if (s.basePatches.length > 0) lines.push(`  with ${s.basePatches.map(formatPatch).join(', ')}`);
  lines.push(windowLine(s.windows));
  lines.push(
    `  ${lpad('value', 7)}  ${pad('verdict', 10)}${lpad('errors', 8)}${lpad('p50', 10)}${lpad('p99', 10)}${lpad('conn wait', 12)}${lpad('DB queue', 12)}  under pressure`,
  );
  lines.push(
    `  ${lpad('orig', 7)}  ${pad('', 10)}${lpad(pct(s.original.errorRate), 8)}${lpad('', 10)}${lpad(fmtDur(s.original.p99Us), 10)}${lpad('', 12)}${lpad('', 12)}  ${s.original.underPressure.join(', ') || '—'}`,
  );
  for (const p of s.points)
    lines.push(
      `  ${lpad(String(p.value), 7)}  ${pad(p.verdict, 10)}${lpad(pct(p.errorRate), 8)}${lpad(fmtDur(p.p50Us), 10)}${lpad(fmtDur(p.p99Us), 10)}${lpad(fmtDur(p.acquireWaitUs), 12)}${lpad(fmtDur(p.dbQueueWaitUs), 12)}  ${p.underPressure.join(', ') || '—'}`,
    );
  lines.push(
    '',
    s.knee === null
      ? 'KNEE none: the curve does not flatten in this range'
      : `KNEE ${String(s.knee.value)}: ${s.knee.reason}`,
    s.resolvesFrom === null
      ? 'RESOLVES never in this range'
      : `RESOLVES from ${String(s.resolvesFrom)}`,
    s.bottleneckShift === null
      ? 'BOTTLENECK SHIFT none in this range'
      : `BOTTLENECK SHIFT from ${String(s.bottleneckShift.value)}: ${s.bottleneckShift.resources.join(', ')} under pressure (not in the original run)`,
  );
  return lines;
}

// ---- commands -------------------------------------------------------------------------------

function openReplayer(outDir: string, incidentId: string): Replayer {
  const storePath = join(outDir, STORE_FILE);
  if (!existsSync(storePath)) throw new InputError(`no telemetry store at ${storePath}`);
  const store = new TelemetryStore(storePath);
  let storedHash: string;
  try {
    const incident = store.listIncidents().find((i) => i.id === incidentId);
    if (incident === undefined) throw new InputError(`no incident ${incidentId} in ${storePath}`);
    storedHash = incident.telemetryHash;
  } finally {
    store.close();
  }
  if (!existsSync(simRecordingPath(outDir, incidentId)))
    throw new InputError(
      `no simulator recording for ${incidentId} (${simRecordingPath(outDir, incidentId)}). Replay works only on incidents produced by \`sim run\`.`,
    );
  const file = readSimRecording(outDir, incidentId);
  if (file.telemetryHash !== storedHash)
    throw new InputError(
      `the recording of ${incidentId} does not match the stored telemetry (${file.telemetryHash.slice(0, 12)} vs ${storedHash.slice(0, 12)})`,
    );
  return new Replayer({ incidentId, recording: file.recording, telemetryHash: file.telemetryHash });
}

function patchesFrom(values: { patch?: string[]; revert?: string[]; variant?: string[] }): Patch[] {
  const patches: Patch[] = [];
  try {
    for (const p of values.patch ?? []) patches.push(parsePatchArg(p));
    for (const r of values.revert ?? []) patches.push(RevertPatch.parse({ revert: r }));
    for (const v of values.variant ?? []) patches.push(parseVariantArg(v));
  } catch (e) {
    throw new InputError(
      e instanceof z.ZodError
        ? e.issues.map((i) => i.message).join('; ')
        : e instanceof Error
          ? e.message
          : String(e),
    );
  }
  return patches;
}

function save(outDir: string, name: string, data: unknown): string {
  mkdirSync(join(outDir, REPLAYS_DIR), { recursive: true });
  const path = replayPath(outDir, name);
  writeFileSync(path, `${JSON.stringify(data, null, 1)}\n`);
  return path;
}

/** Errors that are the user's input, reported with exit 2. Everything else propagates. */
function asInputError(e: unknown): string | null {
  if (
    e instanceof InputError ||
    e instanceof DiagnosisFileError ||
    e instanceof UnsupportedKnobError
  )
    return e.message;
  if (e instanceof Error && /^cannot revert |^knob |^invalid sim config/.test(e.message))
    return e.message;
  return null;
}

async function guarded(name: string, io: Io, body: () => number): Promise<number> {
  try {
    return await Promise.resolve(body());
  } catch (e) {
    if (e instanceof IdentityReplayError) {
      io.err(`${name}: ${e.message}`);
      return EXIT.failed;
    }
    const input = asInputError(e);
    if (input === null) throw e;
    io.err(`${name}: ${input}`);
    return EXIT.usage;
  }
}

export function replayCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      incident: { type: 'string' },
      out: { type: 'string', default: '.data' },
      patch: { type: 'string', multiple: true },
      revert: { type: 'string', multiple: true },
      variant: { type: 'string', multiple: true },
      diagnosis: { type: 'string' },
      recommendation: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
    },
  });
  return guarded('replay', io, () => {
    if (values.incident === undefined) throw new InputError('--incident is required');
    const patches = patchesFrom(values);
    if (values.diagnosis !== undefined && patches.length > 0)
      throw new InputError(
        'give either --diagnosis or patches (--patch/--revert/--variant), not both',
      );
    if (values.diagnosis === undefined && (values.recommendation ?? []).length > 0)
      throw new InputError('--recommendation needs --diagnosis');
    const diagnosis =
      values.diagnosis === undefined
        ? null
        : readRecommendations(values.diagnosis, values.incident, values.recommendation ?? []);
    const replayer = openReplayer(values.out, values.incident);

    if (diagnosis !== null && values.diagnosis !== undefined) {
      if (diagnosis.unresolvedIssues > 0)
        io.err(
          `replay: note: this diagnosis was published with ${String(diagnosis.unresolvedIssues)} unresolved verifier issue(s)`,
        );
      const comparison = replayer.replayRecommendations(
        diagnosis.recommendations,
        values.diagnosis,
      );
      const paths = comparison.rows.flatMap((r) =>
        r.run === null ? [] : [save(values.out, r.run.id, r.run)],
      );
      if (values.json) io.out(JSON.stringify(comparison));
      else {
        for (const r of comparison.rows) {
          if (r.run === null) continue;
          for (const line of renderReplay(r.run).slice(2)) io.out(line);
          io.out('');
        }
        for (const line of renderComparison(comparison)) io.out(line);
        io.out('');
        for (const p of paths) io.out(`saved  ${p}`);
        io.out(REPLAY_NOTICE);
      }
      return 0;
    }

    const run = replayer.replay(patches);
    const path = save(values.out, run.id, run);
    if (values.json) io.out(JSON.stringify(run));
    else {
      for (const line of renderReplay(run)) io.out(line);
      io.out('');
      io.out(`saved  ${path}`);
      io.out(REPLAY_NOTICE);
    }
    return 0;
  });
}

export function sweepCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      incident: { type: 'string' },
      out: { type: 'string', default: '.data' },
      param: { type: 'string' },
      range: { type: 'string' },
      patch: { type: 'string', multiple: true },
      revert: { type: 'string', multiple: true },
      variant: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
    },
  });
  return guarded('sweep', io, () => {
    if (values.incident === undefined) throw new InputError('--incident is required');
    if (values.param === undefined) throw new InputError('--param is required');
    if (values.range === undefined)
      throw new InputError('--range is required (<from>:<to>:<step>)');
    const param = PatchTarget.safeParse(values.param);
    if (!param.success) throw new InputError(`unsupported --param "${values.param}"`);
    let range: number[];
    try {
      range = parseRange(values.range);
    } catch (e) {
      throw new InputError(e instanceof Error ? e.message : String(e));
    }
    const base = patchesFrom(values);
    const replayer = openReplayer(values.out, values.incident);
    const sweep = replayer.sweep(param.data, range, base);
    const path = save(values.out, `sweep_${values.incident}_${param.data}`, sweep);
    if (values.json) io.out(JSON.stringify(sweep));
    else {
      for (const line of renderSweep(sweep)) io.out(line);
      io.out('');
      io.out(`saved  ${path}`);
      io.out(REPLAY_NOTICE);
    }
    return 0;
  });
}
