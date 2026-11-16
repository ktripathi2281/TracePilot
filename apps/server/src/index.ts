/**
 * @tracepilot/server — REST + SSE API and the web UI (brief §9).
 */
import { serve } from '@hono/node-server';
import { createApp, type AppOptions } from './app.ts';

export * from './app.ts';

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

/** Starts the server. Port 0 picks a free port. */
export function startServer(
  options: AppOptions & { port: number; host?: string },
): Promise<RunningServer> {
  const { app, close: closeApp } = createApp(options);
  const host = options.host ?? '127.0.0.1';
  return new Promise((resolveStart) => {
    const server = serve({ fetch: app.fetch, port: options.port, hostname: host }, (info) => {
      resolveStart({
        url: `http://${host}:${String(info.port)}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((e) => {
              closeApp();
              if (e === undefined) done();
              else fail(e);
            });
          }),
      });
    });
  });
}
