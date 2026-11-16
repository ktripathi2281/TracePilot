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
// A BARE COUNT (a number with no unit) must also name its subject: it is grounded only by an
// anchor that shares a content word with it. The text's words are those around the number in the
// same clause; the anchor's are the words around it in the fact statement, the fact's finding key,
// and the evidence field or derived-quantity name. So "a pool of 30 connections" matches a fact
// about the pool that says "capacity 30", but "30 requests failed" does not, and a lone "30" next
// to nothing matches nothing.
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
  /** Content words around the number (stemmed), used to tie a bare count to its subject. */
  context: string[];
}

export interface Anchor {
  /** Where the number comes from: `<evidenceId>.<field>` or `<factId>.<name>`. */
  source: string;
  value: number;
  dimension: Dimension;
  label: string | null;
  /** Content words of this anchor's subject (stemmed). */
  context: string[];
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

const STOPWORDS = new Set(
  'the a an of in on at to was were is are be been and or by for with all only from its their this that than over under about into out per each every after before while when then there here which who has have had not no any some our these those still just also more most less least other same both'.split(
    ' ',
  ),
);

/** Lowercased, crudely singular content words of a phrase or identifier. */
export function contentWords(text: string): string[] {
  const words = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && labelOf(w) === null && !(w in UNITS));
  return [
    ...new Set(
      words.map((w) =>
        w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 ? w.replace(/s$/, '') : w,
      ),
    ),
  ];
}

const CLAUSE = /[,;:()=\n]|\.\s/;

/** Content words around [start, end) of `text`, within the same clause: 4 words before, 3 after. */
function contextAround(text: string, start: number, end: number): string[] {
  const before = (
    text
      .slice(Math.max(0, start - 60), start)
      .split(CLAUSE)
      .at(-1) ?? ''
  )
    .trim()
    .split(/\s+/)
    .slice(-4)
    .join(' ');
  const after = (text.slice(end, end + 60).split(CLAUSE)[0] ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(' ');
  return contentWords(`${before} ${after}`);
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
        context: [],
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
      context: contextAround(withoutTimes, m.index, m.index + m[0].length),
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
    const key = contentWords(f.findingKey);
    const ctx = (...more: string[][]): string[] => [...new Set([...key, ...more.flat()])];
    extractQuantities(f.statement).forEach((q, i) => {
      anchors.push({
        source: `${f.id}.statement[${String(i)}]`,
        value: q.value,
        dimension: q.dimension,
        label: q.label,
        context: ctx(q.context),
      });
    });
    for (const q of f.quantities) {
      const dimension = unitDimension(q.unit);
      const source = `${q.evidenceId}.${q.field}`;
      const context = ctx(contentWords(q.evidenceId), contentWords(q.field));
      anchors.push({ source, value: q.value, dimension, label: null, context });
      if (dimension === 'time')
        anchors.push({ source, value: q.value, dimension: 'clock', label: null, context });
    }
    for (const q of f.derived) {
      const dimension = unitDimension(q.unit);
      const label = labelFromName(q.name);
      const source = `${f.id}.${q.name}`;
      const context = ctx(contentWords(q.name));
      anchors.push({ source, value: q.value, dimension, label, context });
      if (dimension === 'time')
        anchors.push({ source, value: q.value, dimension: 'clock', label: null, context });
    }
    if (typeof f.value === 'number')
      anchors.push({
        source: `${f.id}.value`,
        value: f.value,
        dimension: 'plain',
        label: null,
        context: ctx(),
      });
    if (f.occurredAt !== undefined)
      anchors.push({
        source: `${f.id}.occurredAt`,
        value: f.occurredAt.tsUs,
        dimension: 'clock',
        label: null,
        context: ctx(),
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
        (q.dimension !== 'plain' || q.context.some((w) => a.context.includes(w))) &&
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
    context: contentWords(target),
  };
}
