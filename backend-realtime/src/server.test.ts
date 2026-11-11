import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ closeFirebase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./config/firebase', async (original) => ({ ...await original<typeof import('./config/firebase')>(), closeFirebase: mocks.closeFirebase }));
import { createRealtimeRuntime } from './server';
let runtime: ReturnType<typeof createRealtimeRuntime> | undefined;
afterEach(async () => { await runtime?.stop().catch(() => undefined); runtime = undefined; mocks.closeFirebase.mockReset().mockResolvedValue(undefined); });
it('starts explicitly and closes HTTP, Socket.IO and Firebase idempotently', async () => {
  expect(mocks.closeFirebase).not.toHaveBeenCalled();
  runtime = createRealtimeRuntime(); expect(runtime.httpServer.listening).toBe(false);
  await runtime.start(0); expect(runtime.httpServer.listening).toBe(true);
  const stop = runtime.stop(); expect(runtime.stop()).toBe(stop); await stop;
  expect(runtime.httpServer.listening).toBe(false); expect(mocks.closeFirebase).toHaveBeenCalledOnce();
  await expect(runtime.start(0)).rejects.toThrow('REALTIME_STOPPING');
});
it('reports controlled Firebase cleanup failure and still closes its listener', async () => {
  runtime = createRealtimeRuntime(); await runtime.start(0);
  mocks.closeFirebase.mockRejectedValue(new Error('PRIVATE'));
  await expect(runtime.stop()).rejects.toThrow('REALTIME_SHUTDOWN_FAILED');
  expect(runtime.httpServer.listening).toBe(false);
});
it('closes a listener when shutdown races with initial startup', async () => {
  runtime = createRealtimeRuntime();
  const started = runtime.start(0); const closed = runtime.stop();
  await started; await closed; expect(runtime.httpServer.listening).toBe(false);
});
