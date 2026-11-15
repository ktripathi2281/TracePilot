// Typechecks the root project and every workspace package (each has its own tsconfig.json).
// Runs the root TypeScript directly so it needs no global pnpm/tsc on PATH.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const projects = ['.', 'eval'];
for (const group of ['packages', 'apps']) {
  for (const name of readdirSync(group).sort()) projects.push(join(group, name));
}

let failed = 0;
for (const dir of projects) {
  const config = join(dir, 'tsconfig.json');
  if (!existsSync(config)) {
    console.error(`✖ ${dir}: missing tsconfig.json`);
    failed++;
    continue;
  }
  const res = spawnSync(process.execPath, [tsc, '-p', config], { stdio: 'inherit' });
  if (res.error) throw res.error;
  if (res.status !== 0) failed++;
  console.log(`${res.status === 0 ? '✔' : '✖'} ${dir}`);
}
if (failed > 0) {
  console.error(`\n${String(failed)} project(s) failed typecheck`);
  process.exit(1);
}
