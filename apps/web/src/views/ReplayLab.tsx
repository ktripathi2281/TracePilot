import { useMemo, useState } from 'react';
import type {
  KnobCatalog,
  Patch,
  RecommendationComparison,
  ReplayRun,
  Sweep,
} from '@tracepilot/server/api-types';
import { api } from '../api.ts';
import { fmtCount, fmtDur, fmtKnobValue, fmtPct, fmtRate, fmtT, fmtUnit } from '../format.ts';
import { Chart, type Line } from '../ui/Chart.tsx';
import {
  Chip,
  ErrorLine,
  Loading,
  Notice,
  Panel,
  Stat,
  cx,
  useLoad,
  type Tone,
} from '../ui/parts.tsx';

const VERDICT_TONE: Record<string, Tone> = {
  resolves: 'good',
  improves: 'good',
  mixed: 'warn',
  no_change: 'mute',
  worsens: 'bad',
  not_replayable: 'mute',
};
type Knob = KnobCatalog['knobs'][number];

/** Inputs show durations in ms and sizes in MiB. */
const SCALE: Record<string, number> = { us: 1_000, bytes: 1_048_576, count: 1 };
const UNIT_LABEL: Record<string, string> = { us: ' (ms)', bytes: ' (MiB)', count: '' };
const toInput = (k: Knob, v: number): string => String(v / (SCALE[k.unit] ?? 1));
const fromInput = (k: Knob, s: string): number => Math.round(Number(s) * (SCALE[k.unit] ?? 1));

function patchFromParam(raw: string | null): Patch | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Patch;
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

function Headline({ run }: { run: ReplayRun }) {
  const d = (key: string) => run.headline.find((x) => x.key === key);
  const tone = (key: string): Tone => {
    const x = d(key);
    return x === undefined
      ? 'mute'
      : x.direction === 'better'
        ? 'good'
        : x.direction === 'worse'
          ? 'bad'
          : 'mute';
  };
  const p99 = d('p99Us');
  const failed = d('requestsFailed');
  const good = d('goodputPerS');
  return (
    <div className="grid grid-cols-3 gap-3" data-testid="replay-headline">
      <Stat
        label="p99 latency"
        value={fmtDur(p99?.replay)}
        sub={`original ${fmtDur(p99?.original)}`}
        tone={tone('p99Us')}
        testId="delta-p99"
      />
      <Stat
        label="failed requests"
        value={fmtCount(failed?.replay)}
        sub={`original ${fmtCount(failed?.original)}`}
        tone={tone('requestsFailed')}
        testId="delta-failures"
      />
      <Stat
        label="throughput (ok)"
        value={fmtRate(good?.replay)}
        sub={`original ${fmtRate(good?.original)}`}
        tone={tone('goodputPerS')}
        testId="delta-throughput"
      />
    </div>
  );
}

function ReplayResult({ run, entry }: { run: ReplayRun; entry: string[] }) {
  const series = (summary: ReplayRun['original'], service: string, metric: string) =>
    summary.series.find((s) => s.service === service && s.metric === metric)?.points ?? [];
  const charts = useMemo(() => {
    const specs: { service: string; metric: string; title: string; unit: string }[] = [
      ...entry.flatMap((s) => [
        { service: s, metric: 'latency_p99', title: `${s} p99`, unit: 'us' },
        { service: s, metric: 'error_rate', title: `${s} errors`, unit: 'ratio' },
        { service: s, metric: 'request_rate', title: `${s} requests`, unit: 'req/s' },
      ]),
      { service: 'db', metric: 'pool_in_use', title: 'db pool in use', unit: 'count' },
      { service: 'db', metric: 'pool_wait_queue', title: 'db pool wait queue', unit: 'count' },
      { service: 'db', metric: 'db_active_queries', title: 'db active queries', unit: 'count' },
      // Pods and caches, where the incident has them.
      ...run.original.series
        .filter((s) => s.metric === 'replicas_ready' || s.metric === 'cache_hit_ratio')
        .map((s) => ({
          service: s.service,
          metric: s.metric,
          title: `${s.service} ${s.metric === 'replicas_ready' ? 'ready pods' : 'cache hit ratio'}`,
          unit: s.metric === 'replicas_ready' ? 'count' : 'ratio',
        })),
    ];
    return specs.map((c) => ({
      ...c,
      lines: [
        {
          label: 'original',
          points: series(run.original, c.service, c.metric),
          color: '#71717a',
          dash: true,
        },
        { label: 'replay', points: series(run.replay, c.service, c.metric), color: '#38bdf8' },
      ] satisfies Line[],
    }));
  }, [run, entry]);
  const marks = useMemo(() => [{ x: run.windows.incident.fromUs, label: 'incident' }], [run]);
  const pinned = run.changeEvents.filter((c) => c.pinned !== undefined);
  return (
    <div className="grid gap-4" data-testid="replay-result">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={VERDICT_TONE[run.verdict] ?? 'mute'} testId="verdict">
          {run.verdict}
        </Chip>
        {run.patches.map((p, i) => (
          <Chip key={i}>
            {'revert' in p
              ? `revert ${p.revert}`
              : 'variant' in p
                ? `${p.variant}:${p.service}`
                : `${p.target}=${fmtKnobValue(p.target, p.to)}`}
          </Chip>
        ))}
        <Chip tone="good">identity replay exact</Chip>
        <span className="font-mono text-[11px] text-zinc-500" data-testid="windows">
          baseline {fmtT(run.windows.baseline.fromUs)}–{fmtT(run.windows.baseline.toUs)} · incident{' '}
          {fmtT(run.windows.incident.fromUs)}–{fmtT(run.windows.incident.toUs)}
        </span>
      </div>
      <Headline run={run} />
      {run.sideEffects.length > 0 && (
        <Panel title="Side effects" testId="side-effects">
          <ul className="grid gap-1 text-[12px]">
            {run.sideEffects.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <Chip tone={s.kind === 'relieved' ? 'good' : 'warn'}>
                  {s.kind.replace('_', ' ')}
                </Chip>
                <span className="font-mono text-[11px] text-zinc-300">{s.subject}</span>
                <span className="text-zinc-500">{s.message}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Panel title="Before / after">
        <div className="grid grid-cols-3 gap-4">
          {charts.map((c) => (
            <Chart
              key={`${c.service}-${c.metric}`}
              title={c.title}
              unit={c.unit}
              lines={c.lines}
              sync="replay"
              marks={marks}
              height={130}
              testId="replay-chart"
            />
          ))}
        </div>
      </Panel>
      <div className="grid grid-cols-2 gap-4">
        <Panel title="All deltas">
          <table className="w-full font-mono text-[11px]">
            <tbody>
              {run.headline.map((h) => (
                <tr key={h.key} className="border-b border-zinc-900">
                  <td className="py-1 text-zinc-400">{h.label}</td>
                  <td className="text-right text-zinc-500">{fmtUnit(h.unit, h.original)}</td>
                  <td className="text-right text-zinc-200">{fmtUnit(h.unit, h.replay)}</td>
                  <td
                    className={cx(
                      'pl-2 text-right',
                      h.direction === 'better'
                        ? 'text-emerald-300'
                        : h.direction === 'worse'
                          ? 'text-rose-300'
                          : 'text-zinc-600',
                    )}
                  >
                    {h.direction}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Change events in the replay">
          <ul className="grid gap-1 font-mono text-[11px]">
            {run.changeEvents.map((c) => (
              <li key={c.id} className="text-zinc-400">
                {fmtT(c.ts)} {c.id} {c.service}
                {c.pinned !== undefined && (
                  <span className="text-amber-300">
                    {' '}
                    · pinned{' '}
                    {Object.entries(c.pinned)
                      .map(([k, v]) => `${k}=${String(v)}`)
                      .join(', ')}
                  </span>
                )}
              </li>
            ))}
            {pinned.length === 0 && run.pins.length > 0 && (
              <li className="text-zinc-600">pinned: {run.pins.join(', ')}</li>
            )}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function SweepResult({ sweep }: { sweep: Sweep }) {
  const pts = sweep.points;
  const marks = useMemo(
    () => (sweep.knee === null ? [] : [{ x: sweep.knee.value, label: 'knee' }]),
    [sweep],
  );
  const p99 = useMemo(
    () => [{ label: 'p99', points: pts.map((p) => [p.value, p.p99Us] as const), color: '#38bdf8' }],
    [pts],
  );
  const err = useMemo(
    () => [
      {
        label: 'errors',
        points: pts.map((p) => [p.value, p.errorRate] as const),
        color: '#f43f5e',
      },
    ],
    [pts],
  );
  const dbq = useMemo(
    () => [
      {
        label: 'DB queue wait',
        points: pts.map((p) => [p.value, p.dbQueueWaitUs] as const),
        color: '#f59e0b',
      },
    ],
    [pts],
  );
  return (
    <div className="grid gap-3" data-testid="sweep-result">
      <div className="flex flex-wrap gap-2">
        <Chip tone="info" testId="knee">
          {sweep.knee === null ? 'no knee' : `knee ${String(sweep.knee.value)}`}
        </Chip>
        <Chip tone={sweep.resolvesFrom === null ? 'mute' : 'good'}>
          {sweep.resolvesFrom === null
            ? 'never resolves'
            : `resolves from ${String(sweep.resolvesFrom)}`}
        </Chip>
        {sweep.bottleneckShift !== null && (
          <Chip tone="warn">
            {sweep.bottleneckShift.resources.join(', ')} under pressure from{' '}
            {sweep.bottleneckShift.value}
          </Chip>
        )}
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Chart
          title={`p99 vs ${sweep.param}`}
          unit="us"
          x="value"
          lines={p99}
          marks={marks}
          height={150}
          sync="sweep"
          testId="sweep-chart"
        />
        <Chart
          title={`errors vs ${sweep.param}`}
          unit="ratio"
          x="value"
          lines={err}
          marks={marks}
          height={150}
          sync="sweep"
        />
        <Chart
          title="DB executor queue wait (run)"
          unit="us"
          x="value"
          lines={dbq}
          marks={marks}
          height={150}
          sync="sweep"
        />
      </div>
    </div>
  );
}

export function ReplayLab(props: { incident: string; params: URLSearchParams }) {
  const catalog = useLoad(() => api.knobs(props.incident), [props.incident]);
  const overview = useLoad(() => api.overview(props.incident), [props.incident]);
  const preset = patchFromParam(props.params.get('patch'));
  const [values, setValues] = useState<Record<string, string>>(() =>
    preset !== null && 'target' in preset ? { [preset.target]: String(preset.to) } : {},
  );
  const [reverts, setReverts] = useState<Set<string>>(
    () => new Set(preset !== null && 'revert' in preset ? [preset.revert] : []),
  );
  const [variant, setVariant] = useState<{ variant: string; service: string } | null>(() =>
    preset !== null && 'variant' in preset ? preset : null,
  );
  const [run, setRun] = useState<ReplayRun | null>(null);
  const [comparison, setComparison] = useState<RecommendationComparison | null>(null);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sweepParam, setSweepParam] = useState('db.pool.capacity');
  const [range, setRange] = useState({ from: '20', to: '120', step: '10' });

  const knobs = catalog.data?.knobs ?? [];
  const patches = (): Patch[] => {
    const out: Patch[] = [];
    for (const k of knobs) {
      const v = values[k.target];
      if (v !== undefined && v.trim() !== '')
        out.push({ target: k.target, to: fromInput(k, v) } as Patch);
    }
    for (const r of reverts) out.push({ revert: r } as Patch);
    if (variant !== null) out.push(variant as Patch);
    return out;
  };
  const go = async <T,>(what: string, fn: () => Promise<T>, set: (x: T) => void): Promise<void> => {
    setBusy(what);
    setError(null);
    try {
      set(await fn());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  if (catalog.error !== null)
    return (
      <div className="grid gap-4">
        <Notice />
        <ErrorLine error={catalog.error} />
      </div>
    );
  if (catalog.data === null)
    return (
      <div className="grid gap-4">
        <Notice />
        <Loading what="knobs" />
      </div>
    );
  const entry = overview.data?.entryServices ?? [];
  // Replicas matter for services that run pods; elsewhere they are hidden unless set.
  const podServices = new Set(
    knobs.filter((k) => k.target.endsWith('.memoryLimit')).map((k) => k.target.split('.')[0]),
  );
  const shown = knobs.filter(
    (k) =>
      !k.target.endsWith('.replicas') ||
      podServices.has(k.target.split('.')[0]) ||
      values[k.target] !== undefined,
  );
  const sweepValues = (): number[] => {
    const out: number[] = [];
    const [a, b, s] = [Number(range.from), Number(range.to), Number(range.step)];
    for (let v = a; s > 0 && v <= b && out.length < 20; v += s) out.push(v);
    return out;
  };

  return (
    <div className="grid gap-4" data-testid="view-replay">
      <Notice />
      <div className="grid grid-cols-[300px_1fr] gap-4">
        <div className="grid content-start gap-4">
          <Panel title="Knobs">
            <div className="grid gap-1.5">
              {shown.map((k) => (
                <label
                  key={k.target}
                  className="grid grid-cols-[1fr_90px] items-center gap-2 text-[12px] text-zinc-400"
                  title={
                    k.currentSource === null
                      ? 'current value not visible in telemetry'
                      : `current from ${k.currentSource}`
                  }
                >
                  <span className="truncate">
                    {k.label}
                    {UNIT_LABEL[k.unit] ?? ''}
                  </span>
                  <input
                    type="number"
                    min={k.min / (SCALE[k.unit] ?? 1)}
                    max={k.max / (SCALE[k.unit] ?? 1)}
                    value={values[k.target] ?? ''}
                    placeholder={k.current === null ? '—' : toInput(k, k.current)}
                    onChange={(e) => {
                      setValues({ ...values, [k.target]: e.target.value });
                    }}
                    data-testid={`knob-${k.target}`}
                    aria-label={k.label}
                    className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-[12px] text-zinc-100 placeholder:text-zinc-600"
                  />
                </label>
              ))}
            </div>
          </Panel>
          <Panel title="Revert">
            <div className="grid gap-1">
              {catalog.data.reverts.map((r) => (
                <label
                  key={r.id}
                  className="flex items-center gap-2 font-mono text-[11px] text-zinc-400"
                  title={r.description}
                >
                  <input
                    type="checkbox"
                    checked={reverts.has(r.id)}
                    onChange={(e) => {
                      const next = new Set(reverts);
                      if (e.target.checked) next.add(r.id);
                      else next.delete(r.id);
                      setReverts(next);
                    }}
                    data-testid={`revert-${r.id}`}
                  />
                  {fmtT(r.ts)} {r.id} {r.kind} {r.service}
                </label>
              ))}
            </div>
          </Panel>
          <Panel title="Structural variant">
            <div className="grid grid-cols-2 gap-2">
              <select
                value={variant?.variant ?? ''}
                onChange={(e) => {
                  setVariant(
                    e.target.value === ''
                      ? null
                      : {
                          variant: e.target.value,
                          service: variant?.service ?? catalog.data?.services[0] ?? '',
                        },
                  );
                }}
                className="rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 font-mono text-[11px]"
                data-testid="variant"
              >
                <option value="">none</option>
                {catalog.data.variants.map((v) => (
                  <option key={v.variant} value={v.variant}>
                    {v.variant}
                    {v.modeled ? '' : ' (not modeled)'}
                  </option>
                ))}
              </select>
              <select
                value={variant?.service ?? ''}
                disabled={variant === null}
                onChange={(e) => {
                  if (variant !== null) setVariant({ ...variant, service: e.target.value });
                }}
                className="rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 font-mono text-[11px]"
              >
                {catalog.data.services.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </Panel>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                void go(
                  'replay',
                  () => api.replay(props.incident, patches()),
                  (r) => {
                    setRun(r);
                    setComparison(null);
                  },
                );
              }}
              className="rounded bg-sky-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-sky-500 disabled:opacity-40"
              data-testid="run-replay"
            >
              {busy === 'replay' ? 'running…' : 'Run replay'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                void go(
                  'diagnosis',
                  () => api.replayDiagnosis(props.incident),
                  (c) => {
                    setComparison(c);
                    setRun(c.rows.find((r) => r.run !== null)?.run ?? null);
                  },
                );
              }}
              className="rounded border border-zinc-700 px-3 py-1.5 text-[12px] text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
              data-testid="run-diagnosis"
            >
              {busy === 'diagnosis' ? 'running…' : 'Replay diagnosis'}
            </button>
          </div>
        </div>
        <div className="grid content-start gap-4">
          {error !== null && <ErrorLine error={error} />}
          {comparison !== null && (
            <Panel title="Recommendations, one by one" testId="comparison">
              <div className="grid gap-1.5">
                {comparison.rows.map((r) => (
                  <button
                    key={r.recommendationId}
                    type="button"
                    disabled={r.run === null}
                    onClick={() => {
                      setRun(r.run);
                    }}
                    className={cx(
                      'grid grid-cols-[50px_70px_1fr_90px_80px_80px] items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11px]',
                      r.run !== null && run?.id === r.run.id ? 'bg-zinc-800' : 'hover:bg-zinc-900',
                    )}
                  >
                    <span className="text-zinc-500">{r.recommendationId}</span>
                    <Chip tone={r.addresses === 'cause' ? 'good' : 'warn'}>{r.addresses}</Chip>
                    <span className="truncate text-zinc-300">{r.patch}</span>
                    <Chip tone={VERDICT_TONE[r.verdict] ?? 'mute'}>{r.verdict}</Chip>
                    <span className="text-right text-zinc-400">
                      {r.run === null ? '—' : fmtPct(r.run.replay.incident.errorRate)}
                    </span>
                    <span className="text-right text-zinc-400">
                      {r.run === null ? '—' : fmtDur(r.run.replay.incident.p99Us)}
                    </span>
                  </button>
                ))}
              </div>
              <ul className="mt-2 grid gap-0.5 text-[11px] text-zinc-500">
                {comparison.findings.slice(comparison.rows.length).map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </Panel>
          )}
          {run !== null ? (
            <ReplayResult run={run} entry={entry} />
          ) : (
            <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-zinc-600">
              set knobs, then run
            </div>
          )}
          <Panel
            title="Sweep"
            right={
              <div className="flex items-center gap-1.5 font-mono text-[11px]">
                <select
                  value={sweepParam}
                  onChange={(e) => {
                    setSweepParam(e.target.value);
                  }}
                  className="rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5"
                  data-testid="sweep-param"
                >
                  {knobs
                    .filter((k) => k.unit === 'count')
                    .map((k) => (
                      <option key={k.target} value={k.target}>
                        {k.target}
                      </option>
                    ))}
                </select>
                {(['from', 'to', 'step'] as const).map((f) => (
                  <input
                    key={f}
                    type="number"
                    value={range[f]}
                    onChange={(e) => {
                      setRange({ ...range, [f]: e.target.value });
                    }}
                    aria-label={f}
                    data-testid={`sweep-${f}`}
                    className="w-14 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-right"
                  />
                ))}
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    void go(
                      'sweep',
                      () => api.sweep(props.incident, sweepParam, sweepValues()),
                      setSweep,
                    );
                  }}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
                  data-testid="run-sweep"
                >
                  {busy === 'sweep' ? 'running…' : 'Run sweep'}
                </button>
              </div>
            }
          >
            {sweep === null ? (
              <div className="text-zinc-600">pick a knob and a range</div>
            ) : (
              <SweepResult sweep={sweep} />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
