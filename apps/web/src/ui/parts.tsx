import { useEffect, useState, type ReactNode } from 'react';
import { REPLAY_NOTICE } from '../format.ts';

export const cx = (...xs: (string | false | null | undefined)[]): string =>
  xs.filter(Boolean).join(' ');

const TONES = {
  ok: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
  good: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
  warn: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
  bad: 'bg-rose-500/10 text-rose-300 ring-rose-500/30',
  info: 'bg-sky-500/10 text-sky-300 ring-sky-500/30',
  mute: 'bg-zinc-800 text-zinc-400 ring-zinc-700',
} as const;
export type Tone = keyof typeof TONES;

export function Chip(props: {
  tone?: Tone;
  children: ReactNode;
  onClick?: () => void;
  title?: string | undefined;
  testId?: string;
}) {
  const cls = cx(
    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-inset',
    TONES[props.tone ?? 'mute'],
    props.onClick !== undefined && 'cursor-pointer hover:brightness-125',
  );
  return props.onClick === undefined ? (
    <span className={cls} title={props.title} data-testid={props.testId}>
      {props.children}
    </span>
  ) : (
    <button
      type="button"
      className={cls}
      title={props.title}
      onClick={props.onClick}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}

export function Panel(props: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      className={cx('rounded-lg border border-zinc-800 bg-zinc-900/60', props.className)}
      data-testid={props.testId}
    >
      {props.title !== undefined && (
        <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
            {props.title}
          </h2>
          {props.right}
        </header>
      )}
      <div className="p-3">{props.children}</div>
    </section>
  );
}

/** A headline figure: big value, small comparison. */
export function Stat(props: {
  label: string;
  value: string;
  sub?: ReactNode;
  tone?: Tone;
  testId?: string;
}) {
  const color =
    props.tone === 'bad'
      ? 'text-rose-300'
      : props.tone === 'good'
        ? 'text-emerald-300'
        : props.tone === 'warn'
          ? 'text-amber-300'
          : 'text-zinc-100';
  return (
    <div
      className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3"
      data-testid={props.testId}
    >
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{props.label}</div>
      <div className={cx('mt-1 font-mono text-2xl', color)}>{props.value}</div>
      {props.sub !== undefined && (
        <div className="mt-1 font-mono text-[11px] text-zinc-500">{props.sub}</div>
      )}
    </div>
  );
}

/** The replay notice. Rendered wherever a replay result can be seen. */
export function Notice() {
  return (
    <div
      role="note"
      data-testid="replay-notice"
      className="sticky top-0 z-10 rounded-md border border-amber-500/30 bg-amber-950/80 px-3 py-1.5 text-[12px] text-amber-200 backdrop-blur"
    >
      {REPLAY_NOTICE}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="p-6 font-mono text-[12px] text-zinc-500">loading {what}…</div>;
}

export function ErrorLine({ error }: { error: unknown }) {
  return (
    <div className="rounded border border-rose-500/30 bg-rose-950/40 px-3 py-2 font-mono text-[12px] text-rose-200">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

/** Loads `fn()` whenever `deps` change. */
export function useLoad<T>(
  fn: () => Promise<T>,
  deps: readonly unknown[],
): { data: T | null; error: unknown; loading: boolean } {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null, loading: true });
    fn().then(
      (data) => {
        if (live) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (live) setState({ data: null, error, loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, deps);
  return state;
}

/** Right-hand drawer. */
export function Drawer(props: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  if (!props.open) return null;
  return (
    <aside
      data-testid="evidence-panel"
      className="fixed inset-y-0 right-0 z-30 flex w-[440px] max-w-full flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <div className="font-mono text-[12px] text-zinc-300">{props.title}</div>
        <button
          type="button"
          onClick={props.onClose}
          className="text-zinc-500 hover:text-zinc-200"
          aria-label="close"
        >
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-auto p-4">{props.children}</div>
    </aside>
  );
}
