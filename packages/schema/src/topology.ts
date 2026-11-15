import { z } from 'zod';
import { ServiceName, SpanEvidenceId } from './ids.ts';
import { DurationUs } from './time.ts';

// Service dependency graph DERIVED FROM SPANS by the analysis package, never from sim config
// (brief §4.3). Provisional in Phase 0; the analyzer in Phase 2 is the authority on its content.

export const DependencyNode = z.strictObject({
  service: ServiceName,
  spanCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
});
export type DependencyNode = z.infer<typeof DependencyNode>;

export const DependencyEdge = z
  .strictObject({
    from: ServiceName,
    to: ServiceName,
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
  })
  .refine(
    (g) => {
      const names = new Set(g.nodes.map((n) => n.service));
      return g.edges.every((e) => names.has(e.from) && names.has(e.to));
    },
    { message: 'every edge endpoint must be a node', path: ['edges'] },
  );
export type DependencyGraph = z.infer<typeof DependencyGraph>;
