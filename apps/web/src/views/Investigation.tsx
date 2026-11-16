import { useState } from 'react';
import type {
  Evidence,
  Hypothesis,
  Investigation,
  InvestigationEvent,
  InvestigationSource,
  LedgerEntry,
  Patch,
} from '@tracepilot/server/api-types';
import { href } from '../App.tsx';
import { ApiError, api, runInvestigation } from '../api.ts';
import { fmtDur, fmtT } from '../format.ts';
import { Chip, Drawer, ErrorLine, Loading, Panel, cx, useLoad, type Tone } from '../ui/parts.tsx';

const SOURCE_TONE: Record<InvestigationSource, Tone> = {
  live: 'info',
  recorded: 'good',
  'scripted fixture': 'warn',
};
const STATUS_TONE: Record<Hypothesis['status'], Tone> = {
  supported: 'good',
  rejected: 'bad',
  inconclusive: 'warn',
  proposed: 'mute',
};
const RESULT_TONE: Record<string, Tone> = {
  supported: 'good',
  contradicted: 'bad',
  inconclusive: 'warn',
  pending: 'mute',
};

const patchText = (p: Patch): string =>
  'revert' in p
    ? `revert ${p.revert}`
    : 'variant' in p
      ? `${p.variant}:${p.service}`
      : `${p.target}=${String(p.to)}`;

function EvidenceItem({ incident, id }: { incident: string; id: string }) {
  const e = useLoad(() => api.evidence(incident, id), [incident, id]);
  if (e.error !== null)
    return (
      <div className="font-mono text-[11px] text-rose-300">
        {id}: {e.error instanceof ApiError ? e.error.message : 'error'}
      </div>
    );
  if (e.data === null) return <div className="font-mono text-[11px] text-zinc-600">{id}…</div>;
  return <EvidenceCard ev={e.data} />;
}

function EvidenceCard({ ev }: { ev: Evidence }) {
  const row = (k: string, v: string) => (
    <div key={k} className="grid grid-cols-[150px_1fr] gap-2">
      <span className="truncate text-zinc-500" title={k}>
        {k}
      </span>
      <span className="break-all text-zinc-300">{v}</span>
    </div>
  );
  let rows: ReturnType<typeof row>[];
  if (ev.kind === 'span') {
    const s = ev.item;
    rows = [
      row('span', `${s.service} ${s.name}`),
      row('status', s.status),
      row('start', fmtT(s.startUs, true)),
      row('duration', fmtDur(s.endUs - s.startUs)),
      ...Object.entries(s.attributes).map(([k, v]) => row(k, String(v))),
    ];
  } else if (ev.kind === 'metric') {
    const m = ev.item;
    rows = [
      row('metric', `${m.service} ${m.name}`),
      row('at', fmtT(m.ts, true)),
      row('value', String(m.value)),
    ];
  } else if (ev.kind === 'log') {
    const l = ev.item;
    rows = [
      row('log', `${l.service} ${l.level}`),
      row('at', fmtT(l.ts, true)),
      row('message', l.message),
      ...Object.entries(l.fields).map(([k, v]) => row(k, String(v))),
    ];
  } else if (ev.kind === 'change') {
    const c = ev.item;
    rows = [
      row('change', `${c.kind} ${c.service}`),
      row('at', fmtT(c.ts, true)),
      row('what', c.description),
      ...Object.entries(c.diff).map(([k, d]) => row(k, `${String(d.from)} → ${String(d.to)}`)),
    ];
  } else {
    rows = [row('pod event', ev.item.reason), row('at', fmtT(ev.item.ts, true))];
  }
  return (
    <div
      className="rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-[11px]"
      data-testid="evidence-item"
    >
      <div className="mb-1 text-sky-300">{ev.id}</div>
      <div className="grid gap-0.5">{rows}</div>
    </div>
  );
}

function LedgerPanel({
  incident,
  entry,
  ledger,
}: {
  incident: string;
  entry: LedgerEntry;
  ledger: Map<string, LedgerEntry>;
}) {
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Chip tone={entry.type === 'FACT' ? 'info' : entry.type === 'INFERENCE' ? 'mute' : 'warn'}>
          {entry.type}
        </Chip>
        <span className="font-mono text-[11px] text-zinc-500">by {entry.author}</span>
      </div>
      <p className="text-[13px] leading-relaxed text-zinc-200">{entry.statement}</p>
      {entry.type === 'FACT' && (
        <>
          <div className="font-mono text-[11px] text-zinc-500">
            {entry.tool} · {entry.findingKey} = {JSON.stringify(entry.value)}
          </div>
          <div className="grid gap-2">
            {entry.evidenceIds.slice(0, 6).map((id) => (
              <EvidenceItem key={id} incident={incident} id={id} />
            ))}
            {entry.evidenceIds.length > 6 && (
              <div className="font-mono text-[11px] text-zinc-600">
                +{entry.evidenceIds.length - 6} more
              </div>
            )}
          </div>
        </>
      )}
      {entry.type === 'INFERENCE' && (
        <div className="grid gap-2">
          <div className="font-mono text-[11px] text-zinc-500">rule {entry.rule}</div>
          {entry.premises.map((p) => (
            <div key={p} className="rounded border border-zinc-800 p-2 text-[12px] text-zinc-300">
              <span className="font-mono text-sky-300">{p}</span> {ledger.get(p)?.statement}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stream({ events }: { events: InvestigationEvent[] }) {
  return (
    <div
      className="max-h-48 overflow-auto font-mono text-[11px] text-zinc-400"
      data-testid="stream"
    >
      {events.map((e, i) => (
        <div key={i}>
          {e.type === 'stage' && (
            <span className="text-zinc-200">
              ── {e.stage}
              {e.detail === undefined ? '' : `: ${e.detail}`}
            </span>
          )}
          {e.type === 'tool' && (
            <span>
              {e.role} {e.ok ? '✓' : '✗'} {e.tool} · {e.facts} facts
            </span>
          )}
          {e.type === 'hypotheses' && <span>{e.hypotheses.length} hypotheses tested</span>}
          {e.type === 'skeptic' && <span>skeptic: {e.report.newQueries.length} new queries</span>}
          {e.type === 'verification' && (
            <span>
              verifier round {e.round.round}: {e.accepted ? 'passed' : 'issues'}
            </span>
          )}
          {e.type === 'rejected_input' && (
            <span className="text-amber-300">
              {e.role} {e.tool} sent back
            </span>
          )}
          {e.type === 'inference' && (
            <span>
              {e.role} + {e.id}
            </span>
          )}
          {e.type === 'usage' && <span className="text-zinc-600">tokens {e.totalTokens}</span>}
        </div>
      ))}
    </div>
  );
}

export function InvestigationView({ incident }: { incident: string }) {
  const [reload, setReload] = useState(0);
  const saved = useLoad(() => api.investigation(incident), [incident, reload]);
  const [open, setOpen] = useState<string | null>(null);
  const [events, setEvents] = useState<InvestigationEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const run = (mode: 'fixture' | 'env'): void => {
    setRunning(true);
    setEvents([]);
    setRunError(null);
    void runInvestigation(incident, mode, (e) => {
      setEvents((xs) => [...xs, e]);
    }).then((r) => {
      setRunning(false);
      if (r.ok) setReload((n) => n + 1);
      else setRunError(r.error);
    });
  };

  const controls = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={running}
        onClick={() => {
          run('fixture');
        }}
        className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
        title="Scripted test double: no model, no API key"
      >
        run scripted fixture
      </button>
      <button
        type="button"
        disabled={running}
        onClick={() => {
          run('env');
        }}
        className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
        title="Uses the server's TRACEPILOT_LLM setting (live needs an API key; replay needs a cassette)"
      >
        run with server LLM settings
      </button>
    </div>
  );

  const missing = saved.error instanceof ApiError && saved.error.status === 404;
  if (saved.error !== null && !missing) return <ErrorLine error={saved.error} />;
  if (saved.loading) return <Loading what="investigation" />;
  const runPanel = (
    <Panel title="Run" right={controls}>
      {runError !== null && <ErrorLine error={runError} />}
      {events.length > 0 ? (
        <Stream events={events} />
      ) : (
        <div className="text-[12px] text-zinc-600">
          {missing
            ? 'No saved investigation for this incident.'
            : 'Showing the saved investigation.'}
        </div>
      )}
    </Panel>
  );
  if (saved.data === null)
    return (
      <div className="grid gap-4" data-testid="view-investigation">
        {runPanel}
      </div>
    );

  const { investigation: inv, source } = saved.data;
  const ledger = new Map(inv.ledger.map((e) => [e.id, e]));
  const Cite = ({ ids }: { ids: readonly string[] }) => (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => (
        <Chip
          key={id}
          tone={ledger.get(id)?.type === 'FACT' ? 'info' : 'mute'}
          onClick={() => {
            setOpen(id);
          }}
          title={ledger.get(id)?.statement}
          testId="evidence-chip"
        >
          {id}
        </Chip>
      ))}
    </span>
  );
  const d = inv.diagnosis;
  const entry = open === null ? undefined : ledger.get(open);

  return (
    <div className="grid gap-4" data-testid="view-investigation">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={SOURCE_TONE[source]} testId="source-badge">
          {source}
        </Chip>
        <Chip>{inv.llm.model}</Chip>
        <Chip tone={inv.outcome === 'diagnosed' ? 'good' : 'warn'}>{inv.outcome}</Chip>
        {inv.confidence !== null && (
          <Chip
            tone={
              inv.confidence.level === 'high'
                ? 'good'
                : inv.confidence.level === 'medium'
                  ? 'warn'
                  : 'bad'
            }
          >
            confidence {inv.confidence.level} {inv.confidence.score.toFixed(2)}
          </Chip>
        )}
        <Chip>{inv.revisionRounds} revisions</Chip>
        <Chip>{inv.ledger.length} ledger entries</Chip>
        <Chip>{inv.usage.totalTokens.toLocaleString('en-US')} tokens</Chip>
      </div>
      {runPanel}

      <Panel title="Hypotheses" testId="hypothesis-board">
        <div className="grid grid-cols-3 gap-3">
          {inv.hypotheses.map((h) => (
            <div
              key={h.id}
              className={cx(
                'rounded border p-3',
                h.id === inv.leadingHypothesisId ? 'border-emerald-500/40' : 'border-zinc-800',
              )}
              data-testid="hypothesis"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-zinc-500">
                  {h.id} · {h.kind}
                </span>
                <Chip tone={STATUS_TONE[h.status]}>{h.status}</Chip>
              </div>
              <div className="mt-1 text-[13px] text-zinc-100">{h.title}</div>
              <ul className="mt-2 grid gap-1.5">
                {h.predictions.map((p) => (
                  <li key={p.id} className="text-[12px] text-zinc-400">
                    <div className="flex items-start gap-1.5">
                      <Chip tone={RESULT_TONE[p.result] ?? 'mute'}>{p.result}</Chip>
                      <span>{p.statement}</span>
                    </div>
                    {p.ledgerEntryIds.length > 0 && (
                      <div className="mt-1 pl-1">
                        <Cite ids={p.ledgerEntryIds} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-4">
        <Panel title="Skeptic" testId="skeptic">
          {inv.skeptic === null ? (
            <div className="text-zinc-600">no valid challenge</div>
          ) : (
            <div className="grid gap-2 text-[12px]">
              <div className="font-mono text-[11px] text-zinc-500">
                {inv.skeptic.newQueries.length} new queries · alternative{' '}
                {inv.skeptic.alternativeHypothesisId}
              </div>
              {inv.skeptic.againstLeading.map((c, i) => (
                <div key={`a${String(i)}`} className="flex gap-2">
                  <Chip tone={c.verdict === 'holds' ? 'good' : 'bad'}>{c.verdict}</Chip>
                  <span className="text-zinc-300">
                    {c.statement} <Cite ids={c.ledgerEntryIds} />
                  </span>
                </div>
              ))}
              {inv.skeptic.alternativeChecks.map((c, i) => (
                <div key={`c${String(i)}`} className="flex gap-2">
                  <Chip tone={c.verdict === 'supports_alternative' ? 'bad' : 'good'}>
                    {c.verdict.replace('_', ' ')}
                  </Chip>
                  <span className="text-zinc-300">
                    {c.statement} <Cite ids={c.ledgerEntryIds} />
                  </span>
                </div>
              ))}
              <div className="flex gap-2">
                <Chip
                  tone={inv.skeptic.temporalPrecedence.verdict === 'consistent' ? 'good' : 'warn'}
                >
                  precedence {inv.skeptic.temporalPrecedence.verdict}
                </Chip>
              </div>
            </div>
          )}
        </Panel>
        <Panel title="Verifier" testId="verifier">
          <div className="grid gap-2">
            {inv.verification.map((r) => {
              const issues = [...r.deterministicIssues, ...r.llmIssues];
              return (
                <div key={r.round} className="text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-zinc-500">round {r.round}</span>
                    <Chip tone={issues.length === 0 ? 'good' : 'bad'}>
                      {issues.length === 0 ? 'passed' : `${String(issues.length)} issues`}
                    </Chip>
                    <Chip>logic pass {r.llmPass.replace('_', ' ')}</Chip>
                  </div>
                  {issues.map((x, i) => (
                    <div key={i} className="mt-1 pl-2 font-mono text-[11px] text-rose-300">
                      [{x.code}] {x.location}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      {d !== null && (
        <Panel title="Diagnosis" testId="diagnosis">
          <div className="grid gap-4">
            <div>
              <div className="mb-1 flex items-center gap-2">
                <Chip tone="bad">root cause</Chip>
                <Chip>{d.rootCause.kind}</Chip>
              </div>
              <p className="text-[14px] leading-relaxed text-zinc-100">{d.rootCause.statement}</p>
              <div className="mt-1">
                <Cite ids={d.rootCause.ledgerEntryIds} />
              </div>
            </div>
            <ol className="grid gap-1.5">
              {d.causalChain.map((s, i) => {
                const onset = ledger.get(s.onsetEntryId);
                return (
                  <li key={i} className="grid grid-cols-[70px_1fr] gap-2 text-[12px]">
                    <span className="font-mono text-zinc-500">
                      {onset?.type === 'FACT' && onset.occurredAt !== undefined
                        ? fmtT(onset.occurredAt.tsUs)
                        : '—'}
                    </span>
                    <span className="text-zinc-300">
                      {s.statement} <Cite ids={s.ledgerEntryIds} />
                    </span>
                  </li>
                );
              })}
            </ol>
            {d.rejectedHypotheses.length > 0 && (
              <div className="grid gap-1">
                {d.rejectedHypotheses.map((r) => (
                  <div
                    key={r.hypothesisId}
                    className="flex flex-wrap items-center gap-2 text-[12px]"
                  >
                    <Chip tone="bad">rejected</Chip>
                    <span className="text-zinc-300">{r.title}</span>
                    <Cite ids={r.ledgerEntryIds} />
                  </div>
                ))}
              </div>
            )}
            <div className="grid gap-1.5">
              {d.recommendations.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                  <Chip tone={r.addresses === 'cause' ? 'good' : 'warn'}>{r.addresses}</Chip>
                  <span className="text-zinc-200">{r.title}</span>
                  <code className="font-mono text-[11px] text-zinc-400">{patchText(r.patch)}</code>
                  <a
                    href={href('replay', incident, { patch: JSON.stringify(r.patch) })}
                    className="font-mono text-[11px] text-sky-300 hover:underline"
                    data-testid="replay-recommendation"
                  >
                    replay →
                  </a>
                </div>
              ))}
              {d.followUps.map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-[12px]">
                  <Chip>follow-up</Chip>
                  <span className="text-zinc-300">{f.title}</span>
                  <Cite ids={f.ledgerEntryIds} />
                </div>
              ))}
            </div>
            {d.unresolvedIssues.length > 0 && (
              <div className="rounded border border-rose-500/30 p-2 text-[12px] text-rose-200">
                published with {d.unresolvedIssues.length} unresolved verifier issue(s): not
                verified
              </div>
            )}
          </div>
        </Panel>
      )}

      <Drawer
        open={entry !== undefined}
        onClose={() => {
          setOpen(null);
        }}
        title={open ?? ''}
      >
        {entry !== undefined && <LedgerPanel incident={incident} entry={entry} ledger={ledger} />}
      </Drawer>
    </div>
  );
}

export type { Investigation };
