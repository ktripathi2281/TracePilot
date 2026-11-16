// Entry point: `pnpm run tracepilot -- <command>`.
import { main } from './main.ts';

try {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  });
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
}
