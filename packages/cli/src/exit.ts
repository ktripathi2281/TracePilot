/**
 * Exit codes of every `tracepilot` command.
 *
 *   0   done (for investigate: a verified diagnosis)
 *   1   failed: no result (inconclusive investigation, API, budget or cassette error, a replay
 *       that cannot be trusted)
 *   2   investigate only: a diagnosis was published with unresolved verifier issues (not verified)
 *   64  bad input: unknown command, missing or invalid argument, unknown incident (EX_USAGE)
 */
export const EXIT = {
  ok: 0,
  failed: 1,
  unverified: 2,
  usage: 64,
} as const;
