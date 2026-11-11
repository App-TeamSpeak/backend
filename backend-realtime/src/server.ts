import { createServer } from 'node:http';
import { app } from './app';
import { env } from './config/env';
import { closeFirebase } from './config/firebase';
import { createRealtimeServer, getRealtimeLifecycle } from './realtime/socket';

const shutdownGraceMs = 5000;
async function bounded(operation: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('SHUTDOWN_TIMEOUT')), shutdownGraceMs);
    })]);
  } finally { clearTimeout(timer); }
}
// Importing the module creates no sockets, Firebase clients, listeners or signal handlers.
export function createRealtimeRuntime() {
  const httpServer = createServer(app);
  const io = createRealtimeServer(httpServer);
  let closing: Promise<void> | undefined;
  let stopping = false;
  let starting: Promise<void> | undefined;
  const stop = () => {
    if (closing) return closing;
    stopping = true;
    getRealtimeLifecycle(io).stop(); // blocks admission and cancels watchers first
    closing = (async () => {
      let failed = false;
      if (starting) { try { await bounded(starting); } catch { /* admission is already stopped */ } }
      try { await bounded(new Promise<void>((resolve, reject) => io.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }))); } catch { failed = true; }
      // Give reads time to finish; never claim SDK cancellation or clear admission counters.
      try { await bounded(getRealtimeLifecycle(io).drain()); }
      catch { console.error({ event: 'realtime_shutdown_reads_pending', code: 'SHUTDOWN_TIMEOUT' }); }
      try { await bounded(closeFirebase()); } catch { failed = true; }
      if (failed) throw new Error('REALTIME_SHUTDOWN_FAILED');
    })();
    return closing;
  };
  function start(port = env.PORT) {
    if (stopping) return Promise.reject(new Error('REALTIME_STOPPING'));
    if (starting) return starting;
    starting = new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { httpServer.off('listening', listening); reject(error); };
      const listening = () => { httpServer.off('error', failed); resolve(); };
      httpServer.once('error', failed); httpServer.once('listening', listening);
      httpServer.listen(port, '0.0.0.0');
    });
    return starting;
  }
  return { httpServer, io, start, stop };
}
if (require.main === module) {
  const runtime = createRealtimeRuntime();
  let startupFailed = false;
  const shutdown = () => {
    void runtime.stop().then(() => process.exit(startupFailed ? 1 : 0), () => {
      console.error({ event: 'realtime_shutdown_failed', code: 'REALTIME_SHUTDOWN_FAILED' }); process.exit(1);
    });
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  void runtime.start().then(() => console.log('TeamSpeak realtime escuchando.'), () => {
    startupFailed = true;
    console.error({ event: 'realtime_start_failed', code: 'REALTIME_START_FAILED' }); shutdown();
  });
}
export { app };
