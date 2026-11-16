import { useState } from 'react';
import type { Span, Timeline } from '@tracepilot/server/api-types';
import { navigate } from '../App.tsx';
import { api } from '../api.ts';
import { fmtDur, fmtT } from '../format.ts';
import { Chart } from '../ui/Chart.tsx';
import { Chip, ErrorLine, Loading, Panel, cx, useLoad } from '../ui/parts.tsx';

type Entry = Timeline['entries'][number];

const KIND_COLOR: Record<string, string> = {
  change: '#38bdf8',
  pod_event: '#e879f9',
  anomaly_onset: '#f59e0b',
  anomaly_recovered: '#71717a',
  log_burst: '#f43f5e',
  span_onset: '#a78bfa',
};

/** Changes, anomalies and error bursts on one time axis, with the analysis windows shaded. */
function TimelineAxis(props: {
  t: Timeline;
  fromUs: number;
  toUs: number;
  onPick: (e: Entry) => void;
  picked: Entry | null;
}) {
  const W = 1000;
  const H = 150;
  const x = (us: number): number => ((us - props.fromUs) / (props.toUs - props.fromUs)) * W;
  const lanes = ['change', 'pods', 'anomaly', 'errors'];
  const LANE: Record<string, string> = {
    change: 'change',
    pod_event: 'pods',
    anomaly_onset: 'anomaly',
    anomaly_recovered: 'anomaly',
    span_onset: 'anomaly',
    log_burst: 'errors',
  };
  const laneY = (kind: string): number => 22 + Math.max(0, lanes.indexOf(LANE[kind] ?? kind)) * 30;
  const ticks: number[] = [];
  for (let t = Math.ceil(props.fromUs / 60_000_000) * 60_000_000; t <= props.toUs; t += 60_000_000)
    ticks.push(t);
  const { baseline, incident } = props.t.windows;
  return (
    <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className="w-full" data-testid="timeline">
      <rect
        x={x(baseline.fromUs)}
        y={8}
        width={x(baseline.toUs) - x(baseline.fromUs)}
        height={122}
        fill="#10b98110"
      />
      <rect
        x={x(incident.fromUs)}
        y={8}
        width={Math.max(0, x(Math.min(incident.toUs, props.toUs)) - x(incident.fromUs))}
        height={122}
        fill="#f43f5e14"
      />
      {lanes.map((l) => (
        <g key={l}>
          <line x1={0} x2={W} y1={laneY(l)} y2={laneY(l)} stroke="#27272a" />
          <text x={4} y={laneY(l) - 5} fill="#52525b" fontSize={10} fontFamily="monospace">
            {l}
          </text>
        </g>
      ))}
      {ticks.map((t) => (
        <text
          key={t}
          x={x(t)}
          y={H - 4}
          fill="#52525b"
          fontSize={10}
          fontFamily="monospace"
          textAnchor={x(t) < 30 ? 'start' : 'middle'}
        >
          {fmtT(t)}
        </text>
      ))}
      {props.t.entries.map((e, i) => {
        const cx0 = x(e.ts);
        const cy = laneY(e.kind);
        const active = props.picked === e;
        return (
          <g
            key={`${e.kind}-${String(i)}`}
            onClick={() => {
              props.onPick(e);
            }}
            className="cursor-pointer"
            data-testid={`tl-${e.kind}`}
          >
            <title>{`${fmtT(e.ts, true)} ${e.service}: ${e.summary}`}</title>
            {e.kind === 'change' ? (
              <rect
                x={cx0 - 5}
                y={cy - 5}
                width={10}
                height={10}
                transform={`rotate(45 ${String(cx0)} ${String(cy)})`}
                fill={KIND_COLOR[e.kind]}
                stroke={active ? '#fff' : 'none'}
              />
            ) : (
              <circle
                cx={cx0}
                cy={cy}
                r={active ? 5 : 3.5}
                fill={KIND_COLOR[e.kind] ?? '#a1a1aa'}
                opacity={e.status === 'recovered' ? 0.45 : 0.9}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Waterfall({ spans }: { spans: Span[] }) {
  const start = Math.min(...spans.map((s) => s.startUs));
  const end = Math.max(...spans.map((s) => s.endUs));
  const depth = new Map<string, number>();
  const sorted = [...spans].sort((a, b) => a.startUs - b.startUs);
  for (const s of sorted)
    depth.set(s.spanId, s.parentSpanId === null ? 0 : (depth.get(s.parentSpanId) ?? 0) + 1);
  return (
    <div className="grid gap-px font-mono text-[10px]" data-testid="waterfall">
      {sorted.slice(0, 80).map((s) => {
        const left = ((s.startUs - start) / Math.max(1, end - start)) * 100;
        const width = Math.max(0.4, ((s.endUs - s.startUs) / Math.max(1, end - start)) * 100);
        const bad = s.status !== 'ok';
        return (
          <div key={s.spanId} className="grid grid-cols-[220px_1fr_70px] items-center gap-2">
            <div
              className="truncate text-zinc-400"
              style={{ paddingLeft: (depth.get(s.spanId) ?? 0) * 8 }}
              title={`${s.service} ${s.name}`}
            >
              {s.service} {s.name}
            </div>
            <div className="relative h-2.5 rounded-sm bg-zinc-900">
              <div
                className={cx(
                  'absolute h-2.5 rounded-sm',
                  bad
                    ? 'bg-rose-500/70'
                    : s.name === 'db.pool.acquire'
                      ? 'bg-amber-500/70'
                      : 'bg-sky-500/60',
                )}
                style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
              />
            </div>
            <div className={cx('text-right', bad ? 'text-rose-300' : 'text-zinc-500')}>
              {fmtDur(s.endUs - s.startUs)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const CHARTS: { metric: string; title: string; unit: string }[] = [
  { metric: 'latency_p99', title: 'p99 latency', unit: 'us' },
  { metric: 'error_rate', title: 'error rate', unit: 'ratio' },
  { metric: 'request_rate', title: 'requests', unit: 'req/s' },
  { metric: 'queue_depth', title: 'queue depth', unit: 'count' },
  { metric: 'pool_in_use', title: 'pool in use', unit: 'count' },
  { metric: 'pool_wait_queue', title: 'pool wait queue', unit: 'count' },
  { metric: 'db_active_queries', title: 'DB active queries', unit: 'count' },
  { metric: 'replicas_ready', title: 'ready pods', unit: 'count' },
  { metric: 'pod_restarts', title: 'pod restarts', unit: 'count' },
  { metric: 'memory_working_set', title: 'pod memory (max)', unit: 'bytes' },
  { metric: 'cache_hit_ratio', title: 'cache hit ratio', unit: 'ratio' },
];

function ServicePanel(props: { incident: string; service: string }) {
  const d = useLoad(
    () => api.service(props.incident, props.service),
    [props.incident, props.service],
  );
  const [trace, setTrace] = useState<string | null>(null);
  const spans = useLoad(
    () => (trace === null ? Promise.resolve(null) : api.trace(props.incident, trace)),
    [props.incident, trace],
  );
  if (d.error !== null) return <ErrorLine error={d.error} />;
  if (d.data === null) return <Loading what={props.service} />;
  const charts = CHARTS.flatMap((c) => {
    const m = d.data?.metrics.find((x) => x.metric === c.metric);
    return m === undefined ? [] : [{ ...c, points: m.points }];
  });
  return (
    <div className="grid gap-4" data-testid="service-panel">
      <Panel title={props.service}>
        <div className="grid grid-cols-3 gap-4">
          {charts.map((c) => (
            <Chart
              key={c.metric}
              title={c.title}
              unit={c.unit}
              sync="svc"
              lines={[{ label: props.service, points: c.points, color: '#38bdf8' }]}
              height={120}
              testId={`chart-${c.metric}`}
            />
          ))}
        </div>
      </Panel>
      <div className="grid grid-cols-[360px_1fr] gap-4">
        <Panel title="Slowest sampled traces">
          <ul className="grid gap-1" data-testid="traces">
            {d.data.traces.map((t) => (
              <li key={t.traceId}>
                <button
                  type="button"
                  onClick={() => {
                    setTrace(t.traceId);
                  }}
                  className={cx(
                    'grid w-full grid-cols-[60px_1fr_70px] gap-2 rounded px-1.5 py-1 text-left font-mono text-[11px] hover:bg-zinc-800',
                    trace === t.traceId && 'bg-zinc-800',
                  )}
                >
                  <span className="text-zinc-500">{fmtT(t.startUs)}</span>
                  <span className="truncate text-zinc-300">{t.root}</span>
                  <span
                    className={cx(
                      'text-right',
                      t.status === 'ok' ? 'text-zinc-400' : 'text-rose-300',
                    )}
                  >
                    {fmtDur(t.durationUs)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={trace === null ? 'Trace' : `Trace ${trace.slice(0, 12)}…`}>
          {trace === null && <div className="text-zinc-600">pick a trace</div>}
          {spans.data !== null && <Waterfall spans={spans.data} />}
        </Panel>
      </div>
    </div>
  );
}

export function IncidentView(props: { incident: string; params: URLSearchParams }) {
  const t = useLoad(() => api.timeline(props.incident), [props.incident]);
  const o = useLoad(() => api.overview(props.incident), [props.incident]);
  const [picked, setPicked] = useState<Entry | null>(null);
  const service = props.params.get('service');
  if (t.error !== null) return <ErrorLine error={t.error} />;
  if (t.data === null || o.data === null) return <Loading what="timeline" />;
  const services = o.data.services;
  return (
    <div className="grid gap-4" data-testid="view-incident">
      <Panel
        title="Timeline"
        right={
          <div className="flex gap-3 font-mono text-[10px] text-zinc-500">
            <span className="text-emerald-400/70">■ baseline</span>
            <span className="text-rose-400/70">■ incident</span>
          </div>
        }
      >
        <TimelineAxis
          t={t.data}
          fromUs={o.data.incident.startUs}
          toUs={o.data.incident.endUs}
          onPick={setPicked}
          picked={picked}
        />
        <div className="mt-2 h-5 font-mono text-[11px] text-zinc-400" data-testid="timeline-picked">
          {picked !== null && (
            <>
              <span className="text-zinc-500">{fmtT(picked.ts, true)}</span> {picked.service} ·{' '}
              {picked.summary}
            </>
          )}
        </div>
      </Panel>
      <div className="flex flex-wrap items-center gap-1.5" data-testid="affected">
        <span className="mr-1 text-[11px] uppercase tracking-wider text-zinc-500">services</span>
        {services.map((s) => (
          <Chip
            key={s.service}
            tone={s.health === 'failing' ? 'bad' : s.health === 'degraded' ? 'warn' : 'mute'}
            onClick={() => {
              navigate('incident', props.incident, { service: s.service });
            }}
            testId={`svc-${s.service}`}
          >
            {s.service}
            {service === s.service ? ' ●' : ''}
          </Chip>
        ))}
      </div>
      {service !== null && <ServicePanel incident={props.incident} service={service} />}
    </div>
  );
}
