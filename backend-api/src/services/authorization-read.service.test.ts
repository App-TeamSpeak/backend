import type { DocumentReference } from 'firebase-admin/firestore';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let reads: typeof import('./authorization-read.service.js');
beforeEach(async () => { vi.resetModules(); vi.useFakeTimers(); reads = await import('./authorization-read.service.js'); });
afterEach(() => { vi.useRealTimers(); });
function fixture() {
  let next!: (value: unknown) => void; let error!: (value: unknown) => void;
  const stop = vi.fn(); const subscribe = vi.fn((n, e) => { next = n; error = e; return stop; });
  return { ref: { onSnapshot: subscribe } as unknown as DocumentReference, subscribe, stop, next: (v: unknown) => next(v), error: (e: unknown) => error(e) };
}
const snapshot = { exists: false, data: () => undefined };
it('returns the first server snapshot and cancels subscription exactly once', async () => {
  const f = fixture(); const result = reads.readAuthorizationDocument(f.ref); f.next(snapshot);
  expect(await result).toBe(snapshot); f.next({ exists: true }); expect(f.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('preserves SDK rejection and unsubscribes without logging private details', async () => {
  const f = fixture(); const error = { code: 14 }; const result = expect(reads.readAuthorizationDocument(f.ref)).rejects.toBe(error);
  f.error(error); await result; expect(f.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('times out a subscription with no result and does not accept a late authorization', async () => {
  const f = fixture(); const promise = reads.readAuthorizationDocument(f.ref); const rejected = expect(promise).rejects.toMatchObject({ statusCode: 503, code: 'FIRESTORE_UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(5000); await rejected; f.next({ exists: false }); f.error(new Error('late'));
  expect(f.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('shares a request deadline across sequential reads instead of restarting five seconds', async () => {
  const controller = new AbortController(); const scope = { signal: controller.signal, deadline: Date.now() + 5000 };
  const f = fixture(); const first = reads.authorizationReadScope.run(scope, () => reads.readAuthorizationDocument(f.ref));
  await vi.advanceTimersByTimeAsync(3000); f.next(snapshot); await first;
  const g = fixture(); const second = expect(reads.authorizationReadScope.run(scope, () => reads.readAuthorizationDocument(g.ref))).rejects.toMatchObject({ code: 'FIRESTORE_UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(2000); await second; expect(g.stop).toHaveBeenCalledOnce();
});
it('cancels only the abandoned request among concurrent readers', async () => {
  const controller = new AbortController(); const f = fixture(); const g = fixture();
  const aborted = expect(reads.authorizationReadScope.run({ signal: controller.signal, deadline: Date.now() + 5000 }, () => reads.readAuthorizationDocument(f.ref))).rejects.toMatchObject({ code: 'FIRESTORE_UNAVAILABLE' });
  const good = reads.readAuthorizationDocument(g.ref); controller.abort(); await aborted; expect(g.stop).not.toHaveBeenCalled(); g.next(snapshot); await good;
});
it('rejects an expired or aborted scope before any SDK operation', async () => {
  const controller = new AbortController(); const f = fixture(); controller.abort();
  await expect(reads.authorizationReadScope.run({ signal: controller.signal, deadline: Date.now() + 5000 }, () => reads.readAuthorizationDocument(f.ref))).rejects.toMatchObject({ code: 'FIRESTORE_UNAVAILABLE' });
  await expect(reads.authorizationReadScope.run({ signal: new AbortController().signal, deadline: Date.now() }, () => reads.readAuthorizationDocument(f.ref))).rejects.toMatchObject({ code: 'FIRESTORE_UNAVAILABLE' });
  expect(f.subscribe).not.toHaveBeenCalled();
});
it('bounds admission at 64 subscriptions and recovers after they finish', async () => {
  const fixtures = Array.from({ length: 64 }, fixture); const pending = fixtures.map(f => reads.readAuthorizationDocument(f.ref)); const overflow = fixture();
  await expect(reads.readAuthorizationDocument(overflow.ref)).rejects.toMatchObject({ code: 'FIRESTORE_UNAVAILABLE' }); expect(overflow.subscribe).not.toHaveBeenCalled();
  fixtures.forEach(f => f.next(snapshot)); await Promise.all(pending);
  const recovered = reads.readAuthorizationDocument(overflow.ref); overflow.next(snapshot); await recovered;
});
it('recovers after a transient SDK failure', async () => {
  const f = fixture(); const fail = expect(reads.readAuthorizationDocument(f.ref)).rejects.toMatchObject({ code: 14 }); f.error({ code: 14 }); await fail;
  const g = fixture(); const success = reads.readAuthorizationDocument(g.ref); g.next(snapshot); await expect(success).resolves.toBe(snapshot);
});
it('handles a synchronous SDK callback and a failing disposer without authorizing', async () => {
  const f = fixture(); f.stop.mockImplementation(() => { throw new Error('private'); });
  f.subscribe.mockImplementation(next => { next(snapshot); return f.stop; });
  await expect(reads.readAuthorizationDocument(f.ref)).rejects.toMatchObject({ code: 'FIRESTORE_UNAVAILABLE' }); expect(vi.getTimerCount()).toBe(0);
});
it('cleans the timer when subscription construction fails', async () => {
  const f = fixture(); f.subscribe.mockImplementation(() => { throw new Error('construction'); });
  await expect(reads.readAuthorizationDocument(f.ref)).rejects.toThrow('construction'); expect(vi.getTimerCount()).toBe(0);
});
it('prevents continuation after the scope has been aborted', () => {
  const controller = new AbortController(); controller.abort();
  expect(() => reads.authorizationReadScope.run({ signal: controller.signal, deadline: Date.now() + 5000 }, reads.assertAuthorizationActive)).toThrow('Firestore no está disponible.');
});
it('rejects a snapshot beyond the deadline even before the timer callback runs', async () => {
  const f = fixture(); const result = expect(reads.readAuthorizationDocument(f.ref)).rejects.toMatchObject({ code: 'FIRESTORE_UNAVAILABLE' });
  vi.setSystemTime(Date.now() + 5001); f.next(snapshot); await result; expect(f.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
