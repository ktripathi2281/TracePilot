// Number grounding: "numbers never come from the LLM" (brief §0, rule 1), enforced on prose.
//
// LLM roles write statements (inferences, diagnosis text, challenges). They may only REPEAT
// numbers the deterministic tools produced in the facts they cite. A number is checked as a
// quantity, not as bare digits: value, UNIT and, where the text names one, FIELD.
//
// Every cited fact offers a set of anchors. Each anchor is one quantity with a source
// (`evidenceId` + field for a value quoted from telemetry, fact ID + name for a derived value or a
// number printed in the statement), a dimension and an optional statistic label:
//
//   dimension  time (µs, ms, s, min) | clock (T+m:ss) | share (ratio, %) | rate (req/s) | plain
//   label      p50, p95, p99, median, mean, max, min — read from the words just before a number
//
// A number in the text is grounded when some anchor has the same dimension, the same label (when
// both have one), and the same value at the precision the text wrote it, after converting units
// within the dimension. So "50 connections" does not match a cited "49.7 ms", "a p95 of 7.51 s"
// does not match a cited "p50 7.51 s, p95 8.01 s", and "30%" does not match a capacity of 30.
//
// Not checked: digits inside identifiers (p99, ev_2, le_7, v2.4.1, 5xx).

import type { FactEntry } from '@tracepilot/schema';

export type Dimension = 'time' | 'clock' | 'share' | 'rate' | 'plain';

export interface Quantity {
  raw: string;
  /** In the dimension's base unit: µs for time and clock, a ratio for share. */
  value: number;
  /** Half the unit of the last written digit, in the base unit. */
  tolerance: number;
  dimension: Dimension;
  label: string | null;
}

export interface Anchor {
  /** Where the number comes from: `<evidenceId>.<field>` or `<factId>.<name>`. */
  source: string;
  value: number;
  dimension: Dimension;
  label: string | null;
}

const UNITS: Readonly<Record<string, [Dimension, number]>> = {
  us: ['time', 1],
  µs: ['time', 1],
  ms: ['time', 1_000],
  s: ['time', 1_000_000],
  sec: ['time', 1_000_000],
  seconds: ['time', 1_000_000],
  second: ['time', 1_000_000],
  min: ['time', 60_000_000],
  minutes: ['time', 60_000_000],
  minute: ['time', 60_000_000],
  '%': ['share', 0.01],
  percent: ['share', 0.01],
  'req/s': ['rate', 1],
  '/s': ['rate', 1],
};

/** Units a tool may put on a quantity, mapped to a dimension. */
export function unitDimension(unit: string): Dimension {
  if (unit === 'us') return 'time';
  if (unit === 'ratio') return 'share';
  if (unit === 'req/s') return 'rate';
  return 'plain';
}

const LABELS: readonly [RegExp, string][] = [
  [/^p(\d{1,2}(?:\.\d)?)$/i, 'p$1'],
  [/^(median|p50)$/i, 'p50'],
  [/^(mean|average|avg|averaged)$/i, 'mean'],
  [/^(max|maximum|peak|peaked)$/i, 'max'],
  [/^(min|minimum)$/i, 'min'],
];

function labelOf(word: string): string | null {
  for (const [re, out] of LABELS) {
    const m = re.exec(word);
    if (m !== null) return word.replace(re, out).toLowerCase();
  }
  return null;
}

/** A statistic label named in a derived quantity's name (holdP95Us, baselineMedian, max). */
function labelFromName(name: string): string | null {
  const p = /p(\d{1,2})(?![0-9])/i.exec(name);
  if (p !== null) return p[1] === '50' ? 'p50' : `p${p[1] as string}`;
  if (/median/i.test(name)) return 'p50';
  if (/mean|avg/i.test(name)) return 'mean';
  if (/max/i.test(name)) return 'max';
  if (/min(?!ute)/i.test(name)) return 'min';
  return null;
}

/** The label word among the (at most 4) words before `index`, within the same clause. */
function labelBefore(text: string, index: number): string | null {
  const before = text.slice(Math.max(0, index - 40), index);
  const clause =
    before.split(/[,;:()=\n]|\.\s|(?<![A-Za-z0-9_.])\d+(?:\.\d+)?(?![A-Za-z0-9_])/).at(-1) ?? '';
  const words = clause
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  for (const w of words.slice(-4).reverse()) {
    const l = labelOf(w);
    if (l !== null) return l;
  }
  return null;
}

const TIME_RE = /T\+(\d+):(\d\d)(?:\.(\d{1,3}))?/g;
// A number not inside an identifier or version, optionally followed by a unit.
const NUMBER_RE =
  /(?<![A-Za-z0-9_.])(\d+(?:\.\d+)?)(?!\.\d)(?:\s?(req\/s|\/s|%|percent|µs|us|ms|seconds|second|sec|s|minutes|minute|min|x))?(?![A-Za-z0-9_])/g;

/** Every number and time in a text, as quantities. */
export function extractQuantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  const withoutTimes = text.replace(
    TIME_RE,
    (raw, m: string, s: string, frac: string | undefined) => {
      const digits = frac?.length ?? 0;
      out.push({
        raw,
        value:
          Number(m) * 60_000_000 +
          Number(s) * 1_000_000 +
          (frac === undefined ? 0 : Number(`0.${frac}`) * 1_000_000),
        tolerance: 0.5 * 10 ** (6 - digits),
        dimension: 'clock',
        label: null,
      });
      return ' '.repeat(raw.length);
    },
  );
  for (const m of withoutTimes.matchAll(NUMBER_RE)) {
    const raw = m[1] as string;
    const unit = m[2];
    const [dimension, factor] = (unit === undefined ? undefined : UNITS[unit]) ?? ['plain', 1];
    const decimals = raw.includes('.') ? raw.length - raw.indexOf('.') - 1 : 0;
    out.push({
      raw,
      value: Number(raw) * factor,
      tolerance: 0.5 * 10 ** -decimals * factor,
      dimension,
      label: labelBefore(withoutTimes, m.index),
    });
  }
  return out;
}

/** Back-compatible view: plain numbers and times. */
export function extractNumbers(text: string): { numbers: Quantity[]; times: Quantity[] } {
  const all = extractQuantities(text);
  return {
    numbers: all.filter((q) => q.dimension !== 'clock'),
    times: all.filter((q) => q.dimension === 'clock'),
  };
}

/** The quantities the given facts make available to cite. */
export function anchorsOf(facts: readonly FactEntry[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const f of facts) {
    extractQuantities(f.statement).forEach((q, i) => {
      anchors.push({
        source: `${f.id}.statement[${String(i)}]`,
        value: q.value,
        dimension: q.dimension,
        label: q.label,
      });
    });
    for (const q of f.quantities) {
      const dimension = unitDimension(q.unit);
      anchors.push({
        source: `${q.evidenceId}.${q.field}`,
        value: q.value,
        dimension,
        label: null,
      });
      if (dimension === 'time')
        anchors.push({
          source: `${q.evidenceId}.${q.field}`,
          value: q.value,
          dimension: 'clock',
          label: null,
        });
    }
    for (const q of f.derived) {
      const dimension = unitDimension(q.unit);
      const label = labelFromName(q.name);
      anchors.push({ source: `${f.id}.${q.name}`, value: q.value, dimension, label });
      if (dimension === 'time')
        anchors.push({
          source: `${f.id}.${q.name}`,
          value: q.value,
          dimension: 'clock',
          label: null,
        });
    }
    if (typeof f.value === 'number')
      anchors.push({ source: `${f.id}.value`, value: f.value, dimension: 'plain', label: null });
    if (f.occurredAt !== undefined)
      anchors.push({
        source: `${f.id}.occurredAt`,
        value: f.occurredAt.tsUs,
        dimension: 'clock',
        label: null,
      });
  }
  return anchors;
}

const EPS = 1e-9;

/** The anchor a quantity repeats, or null. */
export function groundingOf(q: Quantity, anchors: readonly Anchor[]): Anchor | null {
  return (
    anchors.find(
      (a) =>
        a.dimension === q.dimension &&
        (a.label === null || q.label === null || a.label === q.label) &&
        Math.abs(a.value - q.value) <= q.tolerance + EPS * Math.max(1, Math.abs(q.value)),
    ) ?? null
  );
}

/** Raw number/time tokens in `text` that no cited fact supports. Empty = fully grounded. */
export function ungroundedNumbers(text: string, facts: readonly FactEntry[]): string[] {
  const quantities = extractQuantities(text);
  if (quantities.length === 0) return [];
  const anchors = anchorsOf(facts);
  return [...new Set(quantities.filter((q) => groundingOf(q, anchors) === null).map((q) => q.raw))];
}

/** A patch's `from` value as a quantity: knobs ending in `Us` are durations in µs. */
export function knobQuantity(target: string, value: number): Quantity {
  return {
    raw: String(value),
    value,
    tolerance: 0.5,
    dimension: /Us$/.test(target) ? 'time' : 'plain',
    label: null,
  };
}
