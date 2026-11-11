import { AsyncLocalStorage } from 'node:async_hooks';
import type { DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import { AppError } from '../middleware/errors';

// Same authorization budget as Realtime; one shared deadline per HTTP request.
export const authorizationReadTimeoutMs = 5000;
export const maxAuthorizationReads = 64;
export interface AuthorizationReadScope { signal: AbortSignal; deadline: number }
export const authorizationReadScope = new AsyncLocalStorage<AuthorizationReadScope>();
let active = 0;
const unavailable = () => new AppError(503, 'FIRESTORE_UNAVAILABLE', 'Firestore no está disponible.');
export function assertAuthorizationActive() {
  const scope = authorizationReadScope.getStore();
  if (scope && (scope.signal.aborted || Date.now() >= scope.deadline)) throw unavailable();
}
// Public SDK cancellation: first server snapshot only, then unsubscribe. No writes here.
export function readAuthorizationDocument<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const scope = authorizationReadScope.getStore();
  const deadline = scope?.deadline ?? Date.now() + authorizationReadTimeoutMs;
  const remaining = deadline - Date.now();
  if (scope?.signal.aborted || remaining <= 0 || active >= maxAuthorizationReads) return Promise.reject(unavailable());
  active++;
  return new Promise((resolve, reject) => {
    let finished = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finish(undefined, unavailable());
    function finish(snapshot?: DocumentSnapshot<T>, error?: unknown) {
      if (finished) return;
      finished = true;
      clearTimeout(timer); scope?.signal.removeEventListener('abort', abort);
      if (scope?.signal.aborted || Date.now() >= deadline) error = unavailable();
      // Disposer is available even for synchronous test doubles (callbacks are deferred).
      let disposed = true;
      try { unsubscribe?.(); }
      catch { disposed = false; error = unavailable(); console.error({ event: 'authorization_unsubscribe_failed', code: 'FIRESTORE_UNAVAILABLE' }); }
      // A broken disposer must not create an unlimited stream leak under repeated admission.
      if (disposed) active--;
      if (error !== undefined || snapshot === undefined) reject(error ?? unavailable()); else resolve(snapshot);
    }
    timer = setTimeout(abort, remaining);
    scope?.signal.addEventListener('abort', abort, { once: true });
    try {
      unsubscribe = ref.onSnapshot(snapshot => queueMicrotask(() => finish(snapshot)), error => queueMicrotask(() => finish(undefined, error)));
    } catch (error) { finish(undefined, error); }
  });
}
