/**
 * @tracepilot/cli — the `tracepilot` command (brief §9).
 * `sim run`, `investigate`, `replay` and `sweep`. `eval` arrives with Phase 6.
 */
export {
  SIM_DIR,
  STORE_FILE,
  SimRecordingFile,
  main,
  readSimRecording,
  simRecordingPath,
  type Io,
} from './main.ts';
export {
  INVESTIGATIONS_DIR,
  investigateCommand,
  investigationPath,
  renderInvestigation,
  type InvestigateDeps,
} from './investigate.ts';
export {
  REPLAYS_DIR,
  renderComparison,
  renderReplay,
  renderSweep,
  replayCommand,
  replayPath,
  sweepCommand,
} from './replay.ts';
