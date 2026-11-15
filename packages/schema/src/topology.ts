import { z } from 'zod';
import { ServiceName, SpanEvidenceId } from './ids.ts';
import { DurationUs } from './time.ts';

// Service dependency graph DERIVED FROM SPANS by the analysis package, never from sim config
// (brief §4.3). Built from SAMPLED traces, so counts are sampled counts, not totals.

export const DependencyNodeKind = z.enum(['service', 'database', 'external']);
export type DependencyNodeKind = z.infer<typeof DependencyNodeKind>;

/** `call`: service → service. `database`: service → DB (queries). `external`: service → peer. */
export const DependencyEdgeKind = z.enum(['call', 'database', 'external']);
export type DependencyEdgeKind = z.infer<typeof DependencyEdgeKind>;

export const DependencyNode = z.strictObject({
  service: ServiceName,
  kind: DependencyNodeKind,
  /** Server spans for services; query/attempt spans for the database; client spans for peers. */
  spanCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
});
export type DependencyNode = z.infer<typeof DependencyNode>;

export const DependencyEdge = z
  .strictObject({
    from: ServiceName,
    to: ServiceName,
    kind: DependencyEdgeKind,
    /** Operations (server span names) of `from` that make this call. */
    callerOperations: z.array(z.string().min(1)),
    callCount: z.number().int().positive(),
    errorCount: z.number().int().nonnegative(),
    latencyP50Us: DurationUs,
    latencyP95Us: DurationUs,
    /** A sample of spans backing this edge, for citation. */
    evidenceIds: z.array(SpanEvidenceId).min(1),
  })
  .refine((e) => e.errorCount <= e.callCount, {
    message: 'errorCount cannot exceed callCount',
    path: ['errorCount'],
  })
  .refine((e) => e.latencyP50Us <= e.latencyP95Us, {
    message: 'p50 cannot exceed p95',
    path: ['latencyP50Us'],
  });
export type DependencyEdge = z.infer<typeof DependencyEdge>;

export const DependencyGraph = z
  .strictObject({
    nodes: z.array(DependencyNode),
    edges: z.array(DependencyEdge),
    /** Services that own root spans (where requests enter the system). */
    entryServices: z.array(ServiceName),
  })
  .refine(
    (g) => {
      const names = new Set(g.nodes.map((n) => n.service));
      return g.edges.every((e) => names.has(e.from) && names.has(e.to));
    },
    { message: 'every edge endpoint must be a node', path: ['edges'] },
  )
  .refine((g) => g.entryServices.every((s) => g.nodes.some((n) => n.service === s)), {
    message: 'every entry service must be a node',
    path: ['entryServices'],
  });
export type DependencyGraph = z.infer<typeof DependencyGraph>;
