import type { Server } from 'node:http';
import { app, setApiAcceptingRequests } from './app';
import { waitForFirestoreIdle } from './services/firestore.service';
import { env } from './config/env';
import { closeFirebase } from './config/firebase';
import { AppError } from './middleware/errors';
import { createAccountDeletionReconciler } from './services/account-deletion.reconciler';

// Authorization reads allow 5s. HTTP gets 1s extra to deliver their final response.
export const apiShutdownGraceMs = 6000;
export const firebaseShutdownGraceMs = 5000;
export const apiShutdownHardLimitMs = 25000; // Above the sum of bounded shutdown stages.
class ShutdownTimeout extends Error {}
async function within(operation: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ShutdownTimeout('SHUTDOWN_TIMEOUT')), ms); })]); }
  finally { clearTimeout(timer); }
}
// Importing this module never starts HTTP, Firebase work or timers.
export function startApiServer(onFatal: () => void = () => undefined) {
  const reconciler = createAccountDeletionReconciler(); // Validate before opening HTTP.
  setApiAcceptingRequests(true);
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
    setApiAcceptingRequests(false);
    closing = (async () => {
      let cleanupFailed = false;
      let reconcilerDrained = true;
      try { await within(reconciler.stop(), firebaseShutdownGraceMs); }
      catch (error) { reconcilerDrained = !(error instanceof ShutdownTimeout); cleanupFailed = true; report('reconciler_shutdown_failed'); }
      let httpDrained = !server;
      try {
        if (server) {
          const httpClosed = new Promise<void>((resolve, reject) => {
            server!.close((error?: Error) => {
              if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error);
              else resolve();
            });
          });
          try { await within(httpClosed, apiShutdownGraceMs); httpDrained = true; }
          catch (error) {
            if (!(error instanceof ShutdownTimeout)) throw error;
            cleanupFailed = true; report('http_shutdown_failed');
            server.closeAllConnections(); // After grace, not on the first stop request.
            await within(httpClosed, 1000);
            httpDrained = true;
          }
        }
      } catch { cleanupFailed = true; report('http_shutdown_failed'); }
      finally {
        process.removeListener('SIGTERM', shutdown);
        process.removeListener('SIGINT', shutdown);
        if (httpDrained) server?.removeListener('error', httpError);
        else server?.once('close', () => server?.removeListener('error', httpError));
      }
      const firestoreIdle = await waitForFirestoreIdle(firebaseShutdownGraceMs);
      if (reconcilerDrained && httpDrained && firestoreIdle) {
        try { await within(closeFirebase(), firebaseShutdownGraceMs); }
        catch { cleanupFailed = true; report('firebase_api_shutdown_failed'); }
      } else {
        cleanupFailed = true; report('firebase_operations_still_pending');
      }
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

// Process-owner policy is separate from the embeddable runtime's bounded stop().
export function startApiProcess() {
  let hardDeadline: ReturnType<typeof setTimeout> | undefined;
  const armHardDeadline = () => {
    if (hardDeadline) return;
    hardDeadline = setTimeout(() => {
      console.error({ event: 'api_shutdown_hard_deadline', code: 'SERVER_SHUTDOWN_FAILED' });
      process.exit(1); // CLI owner only: report failure; do not claim SDK cleanup succeeded.
    }, apiShutdownHardLimitMs);
    hardDeadline.unref();
  };
  process.once('SIGINT', armHardDeadline); process.once('SIGTERM', armHardDeadline);
  try {
    const runtime = startApiServer(() => { process.exitCode = 1; armHardDeadline(); });
    void runtime.ready.catch(() => { process.exitCode = 1; });
    return runtime;
  } catch {
    console.error({ event: 'server_configuration_failed', code: 'SERVER_STARTUP_FAILED' });
    process.exitCode = 1;
  }
}

if (require.main === module) startApiProcess();
