// Deterministic randomness (brief §3).
//
// Request-scoped draws are COUNTER-BASED, not stateful: a draw is a pure function of
// (seed, requestId, label). There is no stream state to advance, so one request's draws can never
// be shifted by what another request did, or by a config change that adds/removes steps elsewhere.
// That is what makes counterfactual comparison meaningful ("common random numbers"): differences
// between two runs of the same workload come from the config change, not from noise.
//
// Sequential streams (mulberry32) are used only where order is fixed up front and independent of
// system behavior: workload generation and background noise logs.

import type { Dist } from './model.ts';

/** murmur3 32-bit finalizer: full avalanche. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** FNV-1a over UTF-16 code units, finished with fmix32. */
export function hashString(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}

/** Second, structurally different string hash (multiply-rotate) for the 64-bit lanes. */
function hashStringB(s: string): number {
  let h = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x5bd1e995);
    h = (h << 13) | (h >>> 19);
  }
  return fmix32(h);
}

const labelHashes = new Map<string, readonly [number, number]>();

function labelHash(label: string): readonly [number, number] {
  let h = labelHashes.get(label);
  if (h === undefined) {
    h = [hashString(label, 0), hashStringB(label)];
    // Labels are step paths: a small closed set per model. Guard against unbounded growth anyway.
    if (labelHashes.size > 100_000) labelHashes.clear();
    labelHashes.set(label, h);
  }
  return h;
}

function keyed32(seed: number, requestId: number, lh: number, lane: number): number {
  let h = fmix32((seed ^ Math.imul(lane + 1, 0x9e3779b9)) >>> 0);
  h = fmix32((h ^ Math.imul(requestId + 1, 0x85ebca6b)) >>> 0);
  return fmix32((h ^ lh) >>> 0);
}

/**
 * Uniform in [0, 1) with 53 bits, a pure function of (seed, requestId, label, k).
 * `k` selects independent values for the same label (e.g. the two uniforms of Box–Muller).
 */
export function uniform(seed: number, requestId: number, label: string, k = 0): number {
  const [a, b] = labelHash(label);
  const hi = keyed32(seed, requestId, a, 2 * k);
  const lo = keyed32(seed, requestId, b, 2 * k + 1);
  return (hi * 2097152 + (lo >>> 11)) / 9007199254740992;
}

/** Standard normal via Box–Muller from two keyed uniforms. */
export function standardNormal(seed: number, requestId: number, label: string): number {
  const u1 = 1 - uniform(seed, requestId, label, 0); // (0, 1]
  const u2 = uniform(seed, requestId, label, 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Samples a duration in integer microseconds (>= 1). Pure in (dist, seed, requestId, label). */
export function sampleDist(dist: Dist, seed: number, requestId: number, label: string): number {
  let x: number;
  switch (dist.kind) {
    case 'constant':
      x = dist.valueUs;
      break;
    case 'exponential':
      x = -dist.meanUs * Math.log(1 - uniform(seed, requestId, label));
      break;
    case 'lognormal':
      x = dist.medianUs * Math.exp(dist.sigma * standardNormal(seed, requestId, label));
      break;
  }
  return Math.max(1, Math.round(x));
}

const hex32 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');

/** 16-hex span id, stable for (seed, requestId, span path) across counterfactual runs. */
export function spanIdFor(seed: number, requestId: number, path: string): string {
  const [a, b] = labelHash(path);
  return hex32(keyed32(seed, requestId, a, 100)) + hex32(keyed32(seed, requestId, b, 101));
}

/** 32-hex trace id for a request. */
export function traceIdFor(seed: number, requestId: number): string {
  const [a, b] = labelHash('trace');
  return (
    hex32(keyed32(seed, requestId, a, 200)) +
    hex32(keyed32(seed, requestId, b, 201)) +
    hex32(keyed32(seed, requestId, a, 202)) +
    hex32(keyed32(seed, requestId, b, 203))
  );
}

// ---- Path interning ----------------------------------------------------------------------------
// Step paths are the labels of draws and spans. The set of distinct paths is small and fixed by the
// model, so they are interned: the same path is always the same string object, which makes the
// hash-cache lookup above cheap (no re-hashing of a freshly concatenated string per draw).

const childPaths = new Map<string, Map<string, string>>();

/** Canonical `${parent}/${label}`. */
export function childPath(parent: string, label: string): string {
  let byLabel = childPaths.get(parent);
  if (byLabel === undefined) {
    byLabel = new Map();
    childPaths.set(parent, byLabel);
  }
  let path = byLabel.get(label);
  if (path === undefined) {
    path = `${parent}/${label}`;
    byLabel.set(label, path);
  }
  return path;
}

const indexedPaths = new Map<string, string[]>();

/** Canonical `${parent}[${index}]` (parallel branch / fan-out copy). */
export function indexedPath(parent: string, index: number): string {
  let byIndex = indexedPaths.get(parent);
  if (byIndex === undefined) {
    byIndex = [];
    indexedPaths.set(parent, byIndex);
  }
  let path = byIndex[index];
  if (path === undefined) {
    path = `${parent}[${String(index)}]`;
    byIndex[index] = path;
  }
  return path;
}

/** Small sequential PRNG. Returns uniforms in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
