import type { Server } from 'node:http';
import { app } from './app';
import { env } from './config/env';
import { closeFirebase } from './config/firebase';
import { AppError } from './middleware/errors';
import { createAccountDeletionReconciler } from './services/account-deletion.reconciler';

// Importing this module never starts HTTP, Firebase work or timers.
export function startApiServer(onFatal: () => void = () => undefined) {
  const reconciler = createAccountDeletionReconciler(); // Validate before opening HTTP.
  let server: Server | undefined;
  let closing: Promise<void> | undefined;
  let stopping = false;
  let listening = false;
  let settled = false;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined); // Callers can await the original rejection without an unhandled event.
  const report = (event: string) => console.error({ event, code: 'SERVER_LIFECYCLE_FAILED' });
  function rejectStartup(error: unknown) { if (!settled) { settled = true; rejectReady(error); } }
  function stop(): Promise<void> {
    if (closing) return closing;
    stopping = true;
    closing = (async () => {
      let cleanupFailed = false;
      try { await reconciler.stop(); }
      catch { cleanupFailed = true; report('reconciler_shutdown_failed'); }
      try {
        if (server) await new Promise<void>((resolve, reject) => {
          server!.close((error?: Error) => {
            if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error);
            else resolve();
          });
        });
      } catch { cleanupFailed = true; report('http_shutdown_failed'); }
      finally {
        process.removeListener('SIGTERM', shutdown);
        process.removeListener('SIGINT', shutdown);
        server?.removeListener('error', httpError);
      }
      try { await closeFirebase(); }
      catch { cleanupFailed = true; report('firebase_api_shutdown_failed'); }
      rejectStartup(hasPrimaryFailure ? primaryFailure : new AppError(503, 'SERVER_STOPPED', 'El servidor se detuvo durante el arranque.'));
      if (cleanupFailed) throw new AppError(500, 'SERVER_SHUTDOWN_FAILED', 'No se pudieron cerrar todos los recursos del servidor.');
    })();
    return closing;
  }
  function abort(error: unknown, event: string) {
    if (!hasPrimaryFailure) { hasPrimaryFailure = true; primaryFailure = error; report(event); onFatal(); }
    void stop().catch(() => undefined);
  }
  function shutdown() { void stop().catch(() => { onFatal(); }); }
  function httpError(error: Error) { abort(error, listening ? 'http_runtime_failed' : 'http_startup_failed'); }
  function httpListening() {
    if (listening) return;
    listening = true;
    if (stopping) return;
    console.log(`TeamSpeak API escuchando en el puerto ${env.PORT}`);
    void Promise.resolve().then(() => {
      if (!stopping) return reconciler.start();
    }).then(() => {
      if (!stopping && !settled) { settled = true; resolveReady(); }
    }).catch((error: unknown) => { abort(error, 'reconciler_startup_failed'); });
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    server = app.listen(env.PORT, '0.0.0.0', httpListening);
    server.on('error', httpError);
    server.once('close', shutdown);
  } catch (error) { abort(error, 'http_startup_failed'); }
  return { ready, stop };
}

if (require.main === module) {
  try {
    const runtime = startApiServer(() => { process.exitCode = 1; });
    void runtime.ready.catch(() => { process.exitCode = 1; });
  } catch {
    console.error({ event: 'server_configuration_failed', code: 'SERVER_STARTUP_FAILED' });
    process.exitCode = 1;
  }
}
