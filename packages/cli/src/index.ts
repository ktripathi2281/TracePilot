/**
 * @tracepilot/cli — the `tracepilot` command (brief §9).
 * `sim run` and `investigate`. `replay`, `sweep` and `eval` arrive with their phases.
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
