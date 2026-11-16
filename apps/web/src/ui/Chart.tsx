import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import { fmtT, fmtUnit } from '../format.ts';

export interface Line {
  label: string;
  points: readonly (readonly [number, number])[];
  color: string;
  dash?: boolean;
}

/** Stable default, so the chart is not rebuilt on every render. */
const NO_MARKS: readonly { x: number; label: string }[] = [];

const COLORS = { grid: '#27272a', axis: '#71717a' };

/** Merges series with different timestamps onto one x axis (missing values become null). */
function align(lines: readonly Line[]): uPlot.AlignedData {
  const xs = [...new Set(lines.flatMap((l) => l.points.map((p) => p[0])))].sort((a, b) => a - b);
  const index = new Map(xs.map((x, i) => [x, i]));
  const ys = lines.map((l) => {
    const col: (number | null)[] = xs.map(() => null);
    for (const [x, y] of l.points) col[index.get(x) ?? 0] = y;
    return col;
  });
  return [xs, ...ys];
}

/**
 * A small time-series chart (uPlot). Charts with the same `sync` key share a cursor, so before /
 * after charts in the replay lab move together.
 */
export function Chart(props: {
  title: string;
  unit: string;
  lines: readonly Line[];
  height?: number;
  sync?: string;
  /** x is virtual time (default) or a plain value (sweep). */
  x?: 'time' | 'value';
  marks?: readonly { x: number; label: string }[];
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { lines, unit, height = 150, sync, x = 'time', marks = NO_MARKS } = props;
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const fmtX = (v: number): string => (x === 'time' ? fmtT(v) : String(v));
    const opts: uPlot.Options = {
      width: Math.max(240, el.clientWidth),
      height,
      legend: { show: lines.length > 1, live: false },
      cursor: sync === undefined ? {} : { sync: { key: sync } },
      scales: { x: { time: false } },
      axes: [
        {
          stroke: COLORS.axis,
          grid: { stroke: COLORS.grid, width: 1 },
          ticks: { stroke: COLORS.grid },
          values: (_u, vals) => vals.map((v) => fmtX(v)),
          size: 28,
        },
        {
          stroke: COLORS.axis,
          grid: { stroke: COLORS.grid, width: 1 },
          ticks: { stroke: COLORS.grid },
          values: (_u, vals) => vals.map((v) => fmtUnit(unit, v)),
          size: 64,
        },
      ],
      series: [
        { label: x === 'time' ? 'time' : 'value', value: (_u, v) => (v === null ? '—' : fmtX(v)) },
        ...lines.map((l) => ({
          label: l.label,
          stroke: l.color,
          width: 1.5,
          spanGaps: true,
          ...(l.dash === true ? { dash: [4, 4] } : {}),
          value: (_u: uPlot, v: number | null) => (v === null ? '—' : fmtUnit(unit, v)),
        })),
      ],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            for (const m of marks) {
              const px = u.valToPos(m.x, 'x', true);
              ctx.save();
              ctx.strokeStyle = '#f59e0b';
              ctx.setLineDash([3, 3]);
              ctx.beginPath();
              ctx.moveTo(px, u.bbox.top);
              ctx.lineTo(px, u.bbox.top + u.bbox.height);
              ctx.stroke();
              ctx.restore();
            }
          },
        ],
      },
    };
    const plot = new uPlot(opts, align(lines), el);
    const ro = new ResizeObserver(() => {
      plot.setSize({ width: Math.max(240, el.clientWidth), height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [lines, unit, height, sync, x, marks]);
  return (
    <div className="min-w-0" data-testid={props.testId}>
      <div className="mb-1 text-[11px] uppercase tracking-wider text-zinc-500">{props.title}</div>
      <div ref={ref} className="w-full" />
    </div>
  );
}
