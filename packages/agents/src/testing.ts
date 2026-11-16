// TEST DOUBLES. Not part of the product.
//
// `ScriptedLlm` answers LLM requests from code, so the orchestration (tool loop, hypothesis
// engine, skeptic rules, verifier, revision rounds, budget) can be tested without a model.
// It reports mode `scripted`: it is never a cassette and never shown as a recorded run, and a
// run with it says nothing about how a real model performs (that is what Gate 3's recorded run
// is for).
//
// `protocolScript` is one such script: a fixed procedure that follows the investigation protocol
// using only what the tools return (fact IDs by finding key). It hardcodes no numbers and no
// incident-specific IDs.

import type { LlmClient, LlmContentBlock, LlmRequest, LlmResponse, LlmUsage } from './llm/types.ts';

export interface ScriptedCall {
  name: string;
  input: unknown;
}
/** Returns the tool calls for the next assistant turn, or text for a turn without tool calls. */
export type Script = (request: LlmRequest) => ScriptedCall[] | string;

export class ScriptedLlm implements LlmClient {
  readonly mode = 'scripted' as const;
  readonly requests: LlmRequest[] = [];
  private readonly script: Script;
  private readonly usage: LlmUsage;

  constructor(script: Script, usage: Partial<LlmUsage> = {}) {
    this.script = script;
    this.usage = {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ...usage,
    };
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(request));
    const n = this.requests.length;
    const out = this.script(request);
    const content =
      typeof out === 'string'
        ? [{ type: 'text', text: out, citations: null }]
        : out.map((c, i) => ({
            type: 'tool_use',
            id: `toolu_scripted_${String(n)}_${String(i)}`,
            name: c.name,
            input: c.input,
          }));
    return Promise.resolve({
      content: content as unknown as LlmContentBlock[],
      stopReason: typeof out === 'string' ? 'end_turn' : 'tool_use',
      model: request.model,
      usage: this.usage,
    });
  }
}

export interface SeenResult {
  tool: string;
  isError: boolean;
  text: string;
  /** Parsed JSON content, when it is JSON. */
  data: unknown;
}

/** Every tool result in the conversation so far, in order, with the tool that produced it. */
export function seenResults(request: LlmRequest): SeenResult[] {
  const names = new Map<string, string>();
  const out: SeenResult[] = [];
  for (const m of request.messages) {
    if (m.content === undefined || typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name);
      if (block.type === 'tool_result') {
        const text =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        let data: unknown = null;
        try {
          data = JSON.parse(text);
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
        }
        out.push({
          tool: names.get(block.tool_use_id) ?? '?',
          isError: block.is_error === true,
          text,
          data,
        });
      }
    }
  }
  return out;
}

interface SeenFact {
  id: string;
  key: string;
  value: unknown;
}

/** Facts returned by data tools so far, by finding key (the latest wins). */
export function seenFacts(request: LlmRequest): Map<string, SeenFact> {
  const facts = new Map<string, SeenFact>();
  for (const r of seenResults(request)) {
    const list = (r.data as { facts?: SeenFact[] } | null)?.facts;
    if (Array.isArray(list)) for (const f of list) facts.set(f.key, f);
  }
  return facts;
}

const turnsSoFar = (request: LlmRequest): number =>
  request.messages.filter((m) => m.role === 'assistant').length;
const has = (request: LlmRequest, tool: string): boolean =>
  request.tools.some((t) => t.name === tool);

export interface ProtocolScriptOptions {
  /** First diagnosis contains a number that is in no cited fact, to exercise a revision round. */
  firstDraftUngrounded?: boolean;
  /** The reviewer rejects the root cause once, to exercise the LLM pass feeding a revision. */
  reviewerRejectsOnce?: boolean;
}

/**
 * A fixed procedure that plays investigator, skeptic and reviewer for an incident whose
 * telemetry shows a saturated connection pool. Everything it cites comes from tool results.
 */
export function protocolScript(options: ProtocolScriptOptions = {}): Script {
  let reviewerCalls = 0;
  return (request) => {
    if (has(request, 'submit_verdict')) {
      reviewerCalls++;
      const payload = JSON.parse(request.messages[0]?.content as string) as {
        diagnosis: {
          causalChain: unknown[];
          rejectedHypotheses: unknown[];
          recommendations: unknown[];
          followUps: unknown[];
        };
      };
      const d = payload.diagnosis;
      const locations = [
        'rootCause',
        ...d.causalChain.map((_, i) => `causalChain[${String(i)}]`),
        ...d.rejectedHypotheses.map((_, i) => `rejectedHypotheses[${String(i)}]`),
        ...d.recommendations.map((_, i) => `recommendations[${String(i)}]`),
        ...d.followUps.map((_, i) => `followUps[${String(i)}]`),
      ];
      const reject = options.reviewerRejectsOnce === true && reviewerCalls === 1;
      return [
        {
          name: 'submit_verdict',
          input: {
            claims: locations.map((location) => ({
              location,
              supported: !(reject && location === 'rootCause'),
              reason:
                reject && location === 'rootCause'
                  ? 'The cited entries show the pool was full but not why the holders were waiting.'
                  : '',
            })),
          },
        },
      ];
    }
    return has(request, 'submit_challenge')
      ? skepticTurn(request)
      : investigatorTurn(request, options);
  };
}

function investigatorTurn(
  request: LlmRequest,
  options: ProtocolScriptOptions,
): ScriptedCall[] | string {
  const turn = turnsSoFar(request);
  if (turn === 0) {
    return [
      { name: 'get_incident_window', input: {} },
      { name: 'list_change_events', input: {} },
      { name: 'get_dependency_graph', input: {} },
      { name: 'detect_anomalies', input: { status: 'ongoing' } },
      { name: 'get_saturation', input: { window: 'incident' } },
      { name: 'analyze_hold_and_wait', input: { window: 'incident' } },
      { name: 'compare_windows', input: { subject: 'db_queries' } },
      { name: 'attribute_latency', input: { window: 'incident' } },
      { name: 'analyze_propagation', input: {} },
      { name: 'correlate_changes', input: {} },
    ];
  }
  const results = seenResults(request);
  const facts = seenFacts(request);
  const tested = results.filter((r) => r.tool === 'propose_hypotheses' && !r.isError).at(-1);
  if (tested === undefined) {
    const hw = { tool: 'analyze_hold_and_wait', args: { window: 'incident' } };
    const db = { tool: 'compare_windows', args: { subject: 'db_queries' } };
    return [
      {
        name: 'propose_hypotheses',
        input: {
          hypotheses: [
            {
              kind: 'hold_and_wait',
              title: 'Connection hold-and-wait starvation',
              statement:
                'Callers keep a pooled connection while waiting for further connections from the same pool, so the pool is full of idle connections.',
              predictions: [
                {
                  statement: 'Hold-and-wait is detected in the incident window.',
                  ...hw,
                  findingKey: 'hold_and_wait.incident.detected',
                  expected: true,
                },
                {
                  statement: 'Most in-use connections are idle-held, not executing.',
                  ...hw,
                  findingKey: 'hold_and_wait.incident.idle_held',
                  expected: true,
                },
                {
                  statement: 'Query execution time is unchanged.',
                  ...db,
                  findingKey: 'db_exec.incident.flat',
                  expected: true,
                },
              ],
            },
            {
              kind: 'pool_capacity',
              title: 'Pool too small for demand',
              statement:
                'The pool is simply too small for the query load: its connections are busy executing.',
              predictions: [
                {
                  statement: 'In-use connections are busy with database work, not idle-held.',
                  ...hw,
                  findingKey: 'hold_and_wait.incident.idle_held',
                  expected: false,
                },
                {
                  statement: 'Query execution time is unchanged.',
                  ...db,
                  findingKey: 'db_exec.incident.flat',
                  expected: true,
                },
              ],
            },
            {
              kind: 'db_slow',
              title: 'Database is slow',
              statement:
                'The database executes queries more slowly, so connections are kept longer.',
              predictions: [
                {
                  statement: 'Query execution time is not flat.',
                  ...db,
                  findingKey: 'db_exec.incident.flat',
                  expected: false,
                },
                {
                  statement: 'Latency of successful requests is dominated by query execution.',
                  tool: 'attribute_latency',
                  args: { window: 'incident' },
                  findingKey: 'attribution.incident.all.success.dominant',
                  expected: 'query_exec',
                },
                {
                  statement: 'Connections are not idle-held.',
                  ...hw,
                  findingKey: 'hold_and_wait.incident.idle_held',
                  expected: false,
                },
              ],
            },
          ],
        },
      },
    ];
  }

  // ---- diagnosis from what the tools returned ----
  interface Tested {
    id: string;
    kind: string;
    status: string;
    predictions: { result: string; fact: string | null }[];
  }
  const board = (tested.data as { tested: Tested[] }).tested;
  const root = board.find((h) => h.kind === 'hold_and_wait') as Tested;
  const id = (key: string): string => {
    const f = facts.get(key);
    if (f === undefined) throw new Error(`script: no fact with key ${key}`);
    return f.id;
  };
  const correlated = [...facts.values()].find(
    (f) => f.key.startsWith('change_correlation.') && f.value === 'correlated',
  );
  const changeId = correlated?.key.split('.')[1] ?? '';
  const entry = String(facts.get('entry_services')?.value ?? '').split(',')[0] ?? '';
  const holder = String(facts.get('hold_and_wait.incident.holder')?.value ?? '');
  const submissions = results.filter((r) => r.tool === 'submit_diagnosis').length;
  const ungrounded = options.firstDraftUngrounded === true && submissions === 0;
  return [
    {
      name: 'submit_diagnosis',
      input: {
        rootCause: {
          statement: `${holder} keeps a pooled connection inside a transaction while its downstream calls wait for further connections from the same pool, so the pool fills with idle connections and nothing can proceed${ungrounded ? ' for 98765 ms' : ''}.`,
          hypothesisId: root.id,
          ledgerEntryIds: [
            id('hold_and_wait.incident.detected'),
            id('hold_and_wait.incident.nested_wait'),
            id('hold_and_wait.incident.holder'),
          ],
        },
        causalChain: [
          {
            statement: `A change to ${holder} went live.`,
            service: holder,
            ledgerEntryIds: [
              id(`change.${changeId}`),
              id(`change_correlation.${changeId}.verdict`),
            ],
            onsetEntryId: id(`change.${changeId}`),
          },
          {
            statement: 'The connection pool filled up and requests began to wait for connections.',
            ledgerEntryIds: [id('propagation.onset.db'), id('saturation.db.pool.incident.status')],
            onsetEntryId: id('propagation.onset.db'),
          },
          {
            statement: `Requests entering through ${entry} became slow or failed.`,
            service: entry,
            ledgerEntryIds: [id(`propagation.onset.${entry}`)],
            onsetEntryId: id(`propagation.onset.${entry}`),
          },
        ],
        affectedServices: [...new Set([holder, entry])],
        rejectedHypotheses: board
          .filter((h) => h.status === 'rejected')
          .map((h) => ({
            hypothesisId: h.id,
            reason: 'A prediction of this hypothesis was contradicted by the evidence.',
            ledgerEntryIds: [h.predictions.find((p) => p.result === 'contradicted')?.fact ?? ''],
          })),
        unknowns: [],
        recommendations: [
          {
            title: 'Revert the change',
            rationale: 'The incident began right after it.',
            patch: { revert: changeId },
            addresses: 'cause',
            ledgerEntryIds: [id(`change_correlation.${changeId}.verdict`)],
          },
          {
            title: 'Enlarge the connection pool',
            rationale: 'Buys headroom but leaves the hold-and-wait pattern in place.',
            patch: { target: 'db.pool.capacity', to: 64 },
            addresses: 'symptom',
            ledgerEntryIds: [id('saturation.db.pool.incident.status')],
          },
        ],
        followUps: [
          {
            title: 'Do not hold a connection across downstream calls',
            rationale:
              'Release the transaction connection before calling services that need the same pool.',
            ledgerEntryIds: [id('hold_and_wait.incident.nested_wait')],
          },
        ],
      },
    },
  ];
}

function skepticTurn(request: LlmRequest): ScriptedCall[] | string {
  if (turnsSoFar(request) === 0) {
    return [
      { name: 'analyze_hold_and_wait', input: { window: 'baseline' } },
      {
        name: 'get_metric_series',
        input: { service: 'db', metric: 'db_active_queries', window: 'incident' },
      },
      { name: 'attribute_latency', input: { window: 'baseline' } },
      { name: 'analyze_propagation', input: {} },
    ];
  }
  const facts = seenFacts(request);
  const brief = JSON.parse(request.messages[0]?.content as string) as {
    otherHypotheses: { id: string; kind: string }[];
  };
  const alternative =
    brief.otherHypotheses.find((h) => h.kind === 'pool_capacity') ?? brief.otherHypotheses[0];
  const id = (key: string): string => facts.get(key)?.id ?? '';
  return [
    {
      name: 'submit_challenge',
      input: {
        againstLeading: [
          {
            statement:
              'If connections were always held this way the baseline would show it too; the same analysis on the baseline does not detect hold-and-wait, so the pattern is specific to the incident.',
            ledgerEntryIds: [id('hold_and_wait.baseline.detected')],
            verdict: 'holds',
          },
        ],
        strongestAlternative: {
          hypothesisId: alternative?.id,
          argument: 'A pool that is too small would show its connections busy with database work.',
          checks: [
            {
              statement:
                'The database executes few queries during the incident, so the pool is not full of working connections.',
              ledgerEntryIds: [id('series.db.db_active_queries.incident.median')],
              verdict: 'contradicts_alternative',
            },
          ],
        },
        redHerrings: [],
        temporalPrecedence: {
          statement:
            'Failure paths end at the database, and the hops into it are ordered callee first.',
          ledgerEntryIds: [id('propagation.origin')],
          verdict: 'consistent',
        },
      },
    },
  ];
}
