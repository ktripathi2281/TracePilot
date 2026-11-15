// CI entry point: `pnpm run ci`. Runs every gate check in order and stops at the first failure.
// Used locally and by .github/workflows/ci.yml so both run the exact same steps.
import { spawnSync } from 'node:child_process';

// Re-use the pnpm that launched us (works with corepack and without a global pnpm).
const pm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['pnpm'];

const steps = [
  ['format', [...pm, 'run', 'format:check']],
  ['lint', [...pm, 'run', 'lint']],
  ['typecheck', [...pm, 'run', 'typecheck']],
  ['test', [...pm, 'run', 'test']],
];

for (const [label, [cmd, ...args]] of steps) {
  console.log(`\n▶ ${label}`);
  const started = process.hrtime.bigint();
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: pm.length === 1 && process.platform === 'win32',
  });
  const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
  if (res.error) throw res.error;
  if (res.status !== 0) {
    console.error(`\n✖ ${label} failed (exit ${String(res.status)}, ${String(ms)} ms)`);
    process.exit(res.status ?? 1);
  }
  console.log(`✔ ${label} (${String(ms)} ms)`);
}
console.log('\nAll CI checks passed.');
