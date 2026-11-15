// Small deterministic data structures used by the engine.

/** A scheduled event. Cancel by calling `cancel()`; cancelled events are skipped when popped. */
export class Timer {
  readonly t: number;
  readonly seq: number;
  fn: (() => void) | null;
  constructor(t: number, seq: number, fn: () => void) {
    this.t = t;
    this.seq = seq;
    this.fn = fn;
  }
  cancel(): void {
    this.fn = null;
  }
}

/** Binary min-heap ordered by (time, insertion sequence): ties run in scheduling order. */
export class EventQueue {
  private readonly heap: Timer[] = [];
  private seq = 0;

  push(t: number, fn: () => void): Timer {
    const timer = new Timer(t, this.seq++, fn);
    const h = this.heap;
    let i = h.length;
    h.push(timer);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = h[parent] as Timer;
      if (p.t < t || (p.t === t && p.seq < timer.seq)) break;
      h[i] = p;
      i = parent;
    }
    h[i] = timer;
    return timer;
  }

  pop(): Timer | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (top === undefined || last === undefined) return undefined;
    const n = h.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        const right = child + 1;
        if (right < n) {
          const l = h[child] as Timer;
          const r = h[right] as Timer;
          if (r.t < l.t || (r.t === l.t && r.seq < l.seq)) child = right;
        }
        const c = h[child] as Timer;
        if (last.t < c.t || (last.t === c.t && last.seq < c.seq)) break;
        h[i] = c;
        i = child;
      }
      h[i] = last;
    }
    return top;
  }
}

/** FIFO queue with O(1) removal from the middle (tombstones). */
export class Fifo<T extends { active: boolean }> {
  private items: T[] = [];
  private head = 0;
  /** Number of live entries. */
  size = 0;

  push(item: T): void {
    this.items.push(item);
    this.size++;
  }

  /** Removes and returns the oldest live entry. */
  shift(): T | undefined {
    while (this.head < this.items.length) {
      const item = this.items[this.head++] as T;
      if (item.active) {
        item.active = false;
        this.size--;
        this.compact();
        return item;
      }
    }
    this.compact();
    return undefined;
  }

  remove(item: T): void {
    if (item.active) {
      item.active = false;
      this.size--;
    }
  }

  *live(): Generator<T> {
    for (let i = this.head; i < this.items.length; i++) {
      const item = this.items[i] as T;
      if (item.active) yield item;
    }
  }

  private compact(): void {
    if (this.head > 256 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }
}

/**
 * Cancellation scope. Cancelling a scope cancels its children and fires registered hooks, which
 * is how abandoned work leaves wait queues immediately.
 */
export class Scope {
  cancelled = false;
  private hooks: Set<() => void> | undefined;

  constructor(parent?: Scope) {
    if (parent !== undefined) {
      if (parent.cancelled) this.cancelled = true;
      else parent.onCancel(() => this.cancel());
    }
  }

  /** Registers a hook; returns a function that unregisters it. Do not call on a cancelled scope. */
  onCancel(fn: () => void): () => void {
    (this.hooks ??= new Set()).add(fn);
    return () => {
      this.hooks?.delete(fn);
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const hooks = this.hooks;
    this.hooks = undefined;
    if (hooks !== undefined) for (const hook of hooks) hook();
  }
}

/**
 * A gauge that also integrates itself over time. Metrics report `value` (a point sample, like a
 * scrape); `mean()` is the exact time-average since t=0, used for conservation checks.
 */
export class Gauge {
  value = 0;
  private last = 0;
  private integral = 0;

  add(now: number, delta: number): void {
    this.integral += this.value * (now - this.last);
    this.last = now;
    this.value += delta;
  }

  /** Time-average of the gauge over [0, now]. */
  mean(now: number): number {
    return now === 0 ? 0 : (this.integral + this.value * (now - this.last)) / now;
  }
}

/** Nearest-rank percentile of an ASCENDING sorted array. p in (0, 1]. */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) throw new Error('percentile of empty set');
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sorted[idx] as number;
}

export function percentile(values: readonly number[], p: number): number {
  return percentileSorted(Float64Array.from(values).sort(), p);
}

export const round3 = (x: number): number => Math.round(x * 1000) / 1000;
