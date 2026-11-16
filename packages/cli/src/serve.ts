// `tracepilot serve [--out <dir>] [--port <n>] [--host <addr>]`: the API and the web UI.
//
// The UI is served from apps/web/dist (build it with `pnpm run web:build`); without a build the
// API still runs. Works with no API key: the UI reads saved investigation and replay records, and
// replays run in the simulator.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startServer } from '@tracepilot/server';
import { EXIT } from './exit.ts';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const WEB_DIST = fileURLToPath(new URL('../../../apps/web/dist', import.meta.url));

export async function serveCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: 'string', default: '.data' },
      port: { type: 'string', default: '4318' },
      host: { type: 'string', default: '127.0.0.1' },
    },
  });
  if (!/^\d+$/.test(values.port)) {
    io.err(`serve: --port must be a number, got "${values.port}"`);
    return EXIT.usage;
  }
  let server;
  try {
    server = await startServer({
      dataDir: values.out,
      webDist: WEB_DIST,
      port: Number(values.port),
      host: values.host,
    });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('no telemetry store')) {
      io.err(`serve: ${e.message}`);
      return EXIT.usage;
    }
    throw e;
  }
  io.out(`TracePilot  ${server.url}`);
  if (!existsSync(WEB_DIST))
    io.out('  (API only: build the UI with `corepack pnpm run web:build`)');
  io.out('  Ctrl+C to stop');
  return EXIT.ok;
}
