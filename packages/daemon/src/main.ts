// The daemon process: `node packages/daemon/src/main.ts`. Normally started detached by `strategos start` (cli.ts).
// Output goes to logs/daemon-YYYY-MM-DD.log (the CLI starts it with stdio ignored); a start that fails is also printed to stderr.
//
// Shutdown (SIGINT, SIGTERM, SIGBREAK, or `strategos stop`): held requests are released with no decision, every Claude
// process is stopped (Ctrl+C x2, /exit, tree kill after 2.5 s), the sessions are saved as `stopped` and stay resumable, the
// server closes, daemon.lock / daemon.json / cli.secret are removed. The daemon owns the ptys, so its exit ends them:
// closing the Strategos WINDOW does not stop sessions, but stopping the DAEMON does (resume with `session.resume`).
import { PROTOCOL } from '@strategos/shared';
import { DaemonStartError, startDaemon, type Daemon } from './daemon.ts';
import { VERSION } from './version.ts';

export { VERSION };

export function banner(): string {
  return `strategos-daemon ${VERSION} (protocol ${PROTOCOL})`;
}

export async function runMain(): Promise<void> {
  let daemon: Daemon | undefined;
  let stopping = false;
  const stop = (why: string): void => {
    if (stopping) return;
    stopping = true;
    daemon?.logger.info(`stop requested (${why})`);
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    (daemon === undefined ? Promise.resolve() : daemon.shutdown()).finally(() => process.exit(0));
  };
  try {
    daemon = await startDaemon({ agents: true, onShutdownRequested: () => { stop('control'); } });
  } catch (err) {
    console.error(err instanceof DaemonStartError ? err.message : `Strategos could not start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => { stop(sig); });
  // A daemon must outlive a bug in one handler: log and carry on.
  process.on('uncaughtException', (err) => { daemon?.logger.error('uncaught exception', err); });
  process.on('unhandledRejection', (err) => { daemon?.logger.error('unhandled rejection', err); });
  console.log(`${banner()} listening on 127.0.0.1:${daemon.port}`);
}

if (import.meta.main) {
  void runMain();
}
