// Number grounding: "numbers never come from the LLM" (brief §0, rule 1), enforced on prose.
//
// LLM roles write statements (inferences, diagnosis text, challenges). They may only REPEAT
// numbers the deterministic tools printed in the facts they cite, possibly rounded or converted
// between ms/s or ratio/percent. This module finds every number in a text and checks it against
// the numbers of the cited facts.
//
// A number is grounded when, for some cited number c and scale k ∈ {1, 1000, 1/1000, 10⁶, 10⁻⁶,
// 100, 1/100}, it equals c·k rounded to the precision it was written with. Times written as
// `T+m:ss[.mmm]` are compared with cited times at their written precision.
//
// Not checked: digits inside identifiers (p99, ev_2, le_7, v2.4.1, 5xx). Known limitation: a small
// integer has many near matches, so the check is weak for them; it is strong for the latencies,
// shares and timestamps that matter.

import type { FactEntry } from '@tracepilot/schema';

interface NumberToken {
  raw: string;
  value: number;
  /** Half the unit of the last written digit. */
  tolerance: number;
}

const TIME_RE = /T\+(\d+):(\d\d)(?:\.(\d{1,3}))?/g;
// Not preceded by a letter, digit, underscore or dot (identifier or version); optional decimals;
// not followed by another ".digit" (version) nor by letters other than a unit.
const NUMBER_RE =
  /(?<![A-Za-z0-9_.])(\d+(?:\.\d+)?)(?!\.\d)(?=(\s?(%|ms|us|µs|s|min|x)?)(?![A-Za-z0-9_]))/g;

export function extractNumbers(text: string): { numbers: NumberToken[]; times: NumberToken[] } {
  const times: NumberToken[] = [];
  const withoutTimes = text.replace(
    TIME_RE,
    (raw, m: string, s: string, frac: string | undefined) => {
      const digits = frac?.length ?? 0;
      times.push({
        raw,
        value:
          Number(m) * 60_000_000 +
          Number(s) * 1_000_000 +
          (frac === undefined ? 0 : Number(`0.${frac}`) * 1_000_000),
        tolerance: 0.5 * 10 ** (6 - digits),
      });
      return ' ';
    },
  );
  const numbers: NumberToken[] = [];
  for (const m of withoutTimes.matchAll(NUMBER_RE)) {
    const raw = m[1] as string;
    const decimals = raw.includes('.') ? raw.length - raw.indexOf('.') - 1 : 0;
    numbers.push({ raw, value: Number(raw), tolerance: 0.5 * 10 ** -decimals });
  }
  return { numbers, times };
}

const SCALES = [1, 1_000, 0.001, 1_000_000, 0.000_001, 100, 0.01];

/** Numbers (and times, in µs) that the given facts make available to cite. */
export function citableNumbers(facts: readonly FactEntry[]): {
  numbers: number[];
  timesUs: number[];
} {
  const numbers: number[] = [];
  const timesUs: number[] = [];
  for (const f of facts) {
    const parsed = extractNumbers(f.statement);
    numbers.push(...parsed.numbers.map((n) => n.value));
    timesUs.push(...parsed.times.map((t) => t.value));
    for (const q of [...f.quantities, ...f.derived]) {
      numbers.push(q.value);
      if (q.unit === 'us') timesUs.push(q.value);
    }
    if (typeof f.value === 'number') numbers.push(f.value);
    if (f.occurredAt !== undefined) timesUs.push(f.occurredAt.tsUs);
  }
  return { numbers, timesUs };
}

/** Raw number/time tokens in `text` that no cited fact supports. Empty = fully grounded. */
export function ungroundedNumbers(text: string, facts: readonly FactEntry[]): string[] {
  const { numbers, times } = extractNumbers(text);
  if (numbers.length === 0 && times.length === 0) return [];
  const citable = citableNumbers(facts);
  const eps = 1e-9;
  const bad: string[] = [];
  for (const t of times) {
    if (!citable.timesUs.some((c) => Math.abs(c - t.value) <= t.tolerance + eps)) bad.push(t.raw);
  }
  for (const n of numbers) {
    const ok = citable.numbers.some((c) =>
      SCALES.some((k) => Math.abs(c * k - n.value) <= n.tolerance + eps),
    );
    if (!ok) bad.push(n.raw);
  }
  return [...new Set(bad)];
}
