import { z } from 'zod';
import { ChangeEventId } from './ids.ts';

// Machine-readable counterfactual patches (brief §3 knobs, §6 recommendations, §7 replay).
// The schema checks SYNTAX only; whether a target exists in a given system model is checked by
// the replay engine (Phase 4).

const SERVICE = '[a-z][a-z0-9-]*';

/** Knobs on a named service / queue. */
export const SERVICE_KNOBS = [
  'workers',
  'replicas',
  'memoryLimit',
  'cpuLimit',
  'timeoutUs',
  'queueLimit',
  'consumers',
] as const;
export type ServiceKnob = (typeof SERVICE_KNOBS)[number];

/** Fixed global knobs. */
export const GLOBAL_KNOBS = ['db.pool.capacity', 'db.acquireTimeoutUs', 'cache.capacity'] as const;

const escape = (s: string) => s.replace(/\./g, '\\.');

export const PATCH_TARGET_RE = new RegExp(
  `^(?:${GLOBAL_KNOBS.map(escape).join('|')}|${SERVICE}\\.(?:${SERVICE_KNOBS.join('|')}))$`,
);

export const PatchTarget = z
  .string()
  .regex(PATCH_TARGET_RE, 'unsupported patch target (see brief §3 knobs)');
export type PatchTarget = z.infer<typeof PatchTarget>;

/** All knobs are integer-valued (counts, microseconds, bytes, millicores). */
const KnobValue = z.number().int().nonnegative();

/** e.g. `{ target: "db.pool.capacity", from: 30, to: 64 }`. `from` is informational. */
export const SetPatch = z.strictObject({
  target: PatchTarget,
  from: KnobValue.optional(),
  to: KnobValue,
});
export type SetPatch = z.infer<typeof SetPatch>;

/** Undo a recorded deploy/config diff. */
export const RevertPatch = z.strictObject({
  revert: ChangeEventId,
});
export type RevertPatch = z.infer<typeof RevertPatch>;

/**
 * Structural model variants: changes to how a service works, not to a knob's value. Each one is a
 * code change in reality, so replaying it answers "what if we fixed it", not "what if we turned
 * a dial".
 */
//
// The list names several common structural fixes. The simulator models only some of them (see
// MODELED_VARIANTS in @tracepilot/sim); replaying another one is refused with a reason. Listing
// more than the modeled ones keeps the patch grammar from pointing at any particular fix.
export const MODEL_VARIANTS = [
  'async-downstream-calls',
  'batch-queries',
  'cache-reads',
  'circuit-breaker',
  'dedicated-connection-pool',
  'release-connection-before-calls',
] as const;
export type ModelVariant = (typeof MODEL_VARIANTS)[number];

/** e.g. `{ variant: "release-connection-before-calls", service: "checkout" }`. */
export const VariantPatch = z.strictObject({
  variant: z.enum(MODEL_VARIANTS),
  service: z.string().regex(new RegExp(`^${SERVICE}$`), 'invalid service name'),
});
export type VariantPatch = z.infer<typeof VariantPatch>;

export const Patch = z.union([SetPatch, RevertPatch, VariantPatch]);
export type Patch = z.infer<typeof Patch>;

export function isRevertPatch(p: Patch): p is RevertPatch {
  return 'revert' in p;
}

export function isVariantPatch(p: Patch): p is VariantPatch {
  return 'variant' in p;
}

export function isSetPatch(p: Patch): p is SetPatch {
  return 'target' in p;
}

/** Parses the CLI form `<variant>:<service>` (e.g. `release-connection-before-calls:checkout`). */
export function parseVariantArg(arg: string): VariantPatch {
  const colon = arg.lastIndexOf(':');
  if (colon <= 0 || colon === arg.length - 1)
    throw new Error(`variant must look like <variant>:<service>, got "${arg}"`);
  return VariantPatch.parse({ variant: arg.slice(0, colon), service: arg.slice(colon + 1) });
}

/**
 * Parses the CLI form `target=value` (e.g. `db.pool.capacity=64`). Throws a ZodError or Error
 * with a readable message on bad input.
 */
export function parsePatchArg(arg: string): SetPatch {
  const eq = arg.indexOf('=');
  if (eq <= 0 || eq === arg.length - 1) {
    throw new Error(`patch must look like <target>=<integer>, got "${arg}"`);
  }
  const target = arg.slice(0, eq).trim();
  const raw = arg.slice(eq + 1).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`patch value must be a non-negative integer, got "${raw}"`);
  }
  return SetPatch.parse({ target, to: Number(raw) });
}

export function formatPatch(p: Patch): string {
  if (isRevertPatch(p)) return `revert ${p.revert}`;
  if (isVariantPatch(p)) return `${p.variant}:${p.service}`;
  return p.from === undefined
    ? `${p.target}=${String(p.to)}`
    : `${p.target}: ${String(p.from)} → ${String(p.to)}`;
}
