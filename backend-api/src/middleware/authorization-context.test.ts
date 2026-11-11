import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { authorizationContext } from './authorization-context';
import { authorizationReadScope, readAuthorizationDocument } from '../services/authorization-read.service';
import { errorHandler } from './errors';
afterEach(() => vi.useRealTimers());
function fixture() {
  const req = Object.assign(new EventEmitter(), { aborted: false });
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false });
  return { req, res, run: (next: () => void) => authorizationContext(req as Request, res as unknown as Response, next) };
}
it('does not confuse a fully received request close with client abandonment', () => {
  const f = fixture(); let signal!: AbortSignal; f.run(() => { signal = authorizationReadScope.getStore()!.signal; });
  f.req.emit('close'); expect(signal.aborted).toBe(false); f.res.writableFinished = true; f.res.emit('finish');
  expect(f.req.listenerCount('aborted')).toBe(0); expect(f.res.listenerCount('close')).toBe(0);
});
it('cancels authorization on premature response close and removes all own listeners', async () => {
  const f = fixture(); const stop = vi.fn(); let read!: Promise<unknown>;
  f.run(() => { read = readAuthorizationDocument({ onSnapshot: () => stop } as never); });
  const rejected = expect(read).rejects.toMatchObject({ code: 'FIRESTORE_UNAVAILABLE' }); f.res.emit('close'); await rejected;
  expect(stop).toHaveBeenCalledOnce(); expect(f.res.eventNames()).toEqual([]); expect(f.req.eventNames()).toEqual([]);
});
it('returns a controlled timeout within budget while the client remains connected', async () => {
  vi.useFakeTimers(); const f = fixture(); const stop = vi.fn(); let read!: Promise<unknown>;
  f.run(() => { read = readAuthorizationDocument({ onSnapshot: () => stop } as never); });
  const result = expect(read).rejects.toMatchObject({ statusCode: 503, code: 'FIRESTORE_UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(5000); await result; expect(stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  f.res.writableFinished = true; f.res.emit('finish'); expect(f.res.eventNames()).toEqual([]);
});
it.each(['aborted', 'destroyed'])('does not admit an already %s HTTP request', state => {
  const f = fixture(); if (state === 'aborted') f.req.aborted = true; else f.res.destroyed = true;
  const next = vi.fn(); f.run(next); expect(next).not.toHaveBeenCalled(); expect(f.res.eventNames()).toEqual([]);
});
it('does not write an error response after the client has gone or a response ended', () => {
  for (const state of [{ destroyed: true }, { writableEnded: true }]) {
    const res = { ...state, status: vi.fn(), json: vi.fn() };
    errorHandler(new Error('late'), {} as never, res as never, vi.fn()); expect(res.status).not.toHaveBeenCalled(); expect(res.json).not.toHaveBeenCalled();
  }
});
