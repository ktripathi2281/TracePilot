import { Background, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { useMemo } from 'react';
import type { Health, Incident, Overview } from '@tracepilot/server/api-types';
import { navigate } from '../App.tsx';
import { api } from '../api.ts';
import { fmtCount, fmtDur, fmtRate, fmtT } from '../format.ts';
import { Chip, ErrorLine, Loading, Panel, Stat, useLoad, type Tone } from '../ui/parts.tsx';

const HEALTH_TONE: Record<Health, Tone> = { ok: 'ok', degraded: 'warn', failing: 'bad' };
const HEALTH_COLOR: Record<Health, string> = {
  ok: '#10b981',
  degraded: '#f59e0b',
  failing: '#f43f5e',
};

/** Layers by call depth from the entry services, left to right. */
function layout(o: Overview): { nodes: Node[]; edges: Edge[] } {
  const depth = new Map<string, number>(o.entryServices.map((s) => [s, 0]));
  for (let changed = true, guard = 0; changed && guard < 20; guard++) {
    changed = false;
    for (const e of o.edges) {
      const d = (depth.get(e.from) ?? 0) + 1;
      if ((depth.get(e.to) ?? -1) < d) {
        depth.set(e.to, d);
        changed = true;
      }
    }
  }
  const byDepth = new Map<number, string[]>();
  for (const s of o.services) {
    const d = depth.get(s.service) ?? 0;
    byDepth.set(d, [...(byDepth.get(d) ?? []), s.service].sort());
  }
  const nodes: Node[] = o.services.map((s) => {
    const d = depth.get(s.service) ?? 0;
    const column = byDepth.get(d) ?? [];
    const row = column.indexOf(s.service);
    return {
      id: s.service,
      position: { x: d * 210, y: (row - (column.length - 1) / 2) * 90 },
      data: {
        label: (
          <div data-testid={`node-${s.service}`} data-health={s.health} className="text-left">
            <div className="font-mono text-[12px] text-zinc-100">{s.service}</div>
            <div className="font-mono text-[10px] text-zinc-400">
              {s.kind === 'external'
                ? 'external'
                : s.kind === 'database'
                  ? s.health === 'ok'
                    ? 'pool ok'
                    : 'pool saturated'
                  : `p99 ${fmtDur(s.p99Us)}`}
            </div>
          </div>
        ),
      },
      style: {
        background: '#18181b',
        border: `1px solid ${HEALTH_COLOR[s.health]}`,
        boxShadow: s.health === 'ok' ? 'none' : `0 0 0 3px ${HEALTH_COLOR[s.health]}22`,
        borderRadius: 6,
        width: 150,
        padding: 8,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });
  const edges: Edge[] = o.edges.map((e) => ({
    id: `${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    animated: e.errorCount > 0,
    style: { stroke: e.errorCount > 0 ? '#f43f5e88' : '#52525b' },
  }));
  return { nodes, edges };
}

export function OverviewView(props: { incident: string; incidents: Incident[] }) {
  const o = useLoad(() => api.overview(props.incident), [props.incident]);
  const graph = useMemo(() => (o.data === null ? null : layout(o.data)), [o.data]);
  if (o.error !== null) return <ErrorLine error={o.error} />;
  if (o.data === null || graph === null) return <Loading what="overview" />;
  const { headline, symptom, windows, changes } = o.data;
  const b = headline.baseline;
  const i = headline.incident;
  const worse = (now: number | null, before: number | null, factor: number): boolean =>
    now !== null && before !== null && now > before * factor;

  return (
    <div className="grid gap-4" data-testid="view-overview">
      <div className="grid grid-cols-3 gap-3">
        <Stat
          label="p99 latency"
          value={fmtDur(i.p99Us)}
          sub={`baseline ${fmtDur(b.p99Us)}`}
          tone={worse(i.p99Us, b.p99Us, 2) ? 'bad' : 'good'}
          testId="headline-p99"
        />
        <Stat
          label="failed requests"
          value={fmtCount(i.failures)}
          sub={`baseline ${fmtCount(b.failures)}`}
          tone={i.failures > Math.max(10, 2 * b.failures) ? 'bad' : 'good'}
          testId="headline-failures"
        />
        <Stat
          label="throughput (ok)"
          value={fmtRate(i.throughputPerS)}
          sub={`baseline ${fmtRate(b.throughputPerS)}`}
          tone={worse(b.throughputPerS, i.throughputPerS, 1.25) ? 'bad' : 'good'}
          testId="headline-throughput"
        />
      </div>
      <div className="grid grid-cols-[1fr_320px] gap-4">
        <Panel
          title="Service graph"
          right={
            <span className="font-mono text-[11px] text-zinc-500">
              incident window {fmtT(windows.incident.fromUs)} – {fmtT(windows.incident.toUs)}
            </span>
          }
        >
          <div className="h-[360px]" data-testid="service-graph">
            <ReactFlow
              nodes={graph.nodes}
              edges={graph.edges}
              colorMode="dark"
              fitView
              nodesDraggable={false}
              nodesConnectable={false}
              onNodeClick={(_e, n) => {
                navigate('incident', props.incident, { service: n.id });
              }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#27272a" gap={24} />
            </ReactFlow>
          </div>
        </Panel>
        <div className="grid content-start gap-4">
          <Panel title="Incidents">
            <ul className="grid gap-2">
              {props.incidents.map((inc) => (
                <li key={inc.id}>
                  <a
                    href={`#/incident/${inc.id}`}
                    className="block rounded border border-zinc-800 px-2 py-1.5 hover:border-zinc-600"
                  >
                    <div className="flex items-center justify-between font-mono text-[12px]">
                      <span>{inc.id}</span>
                      {inc.id === props.incident && symptom !== null && (
                        <Chip tone={symptom.status === 'ongoing' ? 'bad' : 'warn'}>
                          {symptom.status}
                        </Chip>
                      )}
                    </div>
                    {inc.id === props.incident && symptom !== null && (
                      <div className="mt-0.5 font-mono text-[11px] text-zinc-500">
                        {symptom.service} {symptom.metric} from {fmtT(symptom.onsetUs)}
                      </div>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Changes">
            <ul className="grid gap-1.5" data-testid="deploys">
              {changes.map((c) => (
                <li key={c.id} className="flex items-baseline gap-2 font-mono text-[11px]">
                  <span className="text-zinc-500">{fmtT(c.ts)}</span>
                  <Chip tone={c.kind === 'deploy' ? 'info' : 'mute'}>{c.kind}</Chip>
                  <span className="text-zinc-300">{c.service}</span>
                  <span className="truncate text-zinc-500" title={c.description}>
                    {c.id}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Health">
            <div className="flex flex-wrap gap-1.5">
              {o.data.services.map((s) => (
                <Chip key={s.service} tone={HEALTH_TONE[s.health]}>
                  {s.service} {s.health}
                </Chip>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
