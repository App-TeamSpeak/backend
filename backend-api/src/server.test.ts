import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const lifecycle = vi.hoisted(() => ({ enabled: false, listen: vi.fn(), start: vi.fn(), stop: vi.fn(), create: vi.fn(), closeFirebase: vi.fn() }));
vi.mock('./app', () => ({ app: { listen: lifecycle.listen }, setApiAcceptingRequests: vi.fn() }));
vi.mock('./config/firebase', () => ({ closeFirebase: lifecycle.closeFirebase }));
vi.mock('./config/env', () => ({ env: { PORT: 10000 } }));
vi.mock('./services/account-deletion.reconciler', () => ({ createAccountDeletionReconciler: lifecycle.create }));
const spySignals = () => vi.spyOn(process, 'once').mockReturnValue(process);
let signals: ReturnType<typeof spySignals>;
let listening!: () => void;
let http: EventEmitter & { close: ReturnType<typeof makeClose> };
const makeClose = () => vi.fn((callback: (error?: Error) => void) => { http.emit('close'); callback(); });
const load = async () => (await import('./server.js')).startApiServer;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); lifecycle.enabled = false;
  vi.spyOn(console, 'error').mockImplementation(() => undefined); vi.spyOn(console, 'log').mockImplementation(() => undefined);
  lifecycle.closeFirebase.mockResolvedValue(undefined); lifecycle.start.mockResolvedValue(undefined); lifecycle.stop.mockResolvedValue(undefined);
  lifecycle.create.mockImplementation(() => ({ start: lifecycle.start, stop: lifecycle.stop, getState: () => ({ enabled: lifecycle.enabled }) }));
  http = Object.assign(new EventEmitter(), { close: makeClose() });
  lifecycle.listen.mockImplementation((_port, _host, callback) => { listening = callback; return http; });
  signals = spySignals();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('keeps ordinary HTTP startup with disabled reconciliation and has no effects on import', async () => {
  const start = await load(); expect(lifecycle.listen).not.toHaveBeenCalled();
  const runtime = start(); expect(lifecycle.start).not.toHaveBeenCalled();
  listening(); await runtime.ready; expect(lifecycle.listen).toHaveBeenCalledWith(10000, '0.0.0.0', expect.any(Function));
  expect(lifecycle.start).toHaveBeenCalledOnce(); await runtime.stop();
});
it('waits for listening before starting the enabled reconciler, exactly once', async () => {
  lifecycle.enabled = true; const runtime = (await load())(); await flush(); expect(lifecycle.start).not.toHaveBeenCalled();
  listening(); listening(); await runtime.ready; expect(lifecycle.start).toHaveBeenCalledOnce(); await runtime.stop();
});
it('does not listen when explicit configuration is unsafe', async () => {
  lifecycle.create.mockImplementation(() => { throw new Error('controlled unsafe configuration'); });
  expect(await load()).toThrow('controlled unsafe configuration'); expect(lifecycle.listen).not.toHaveBeenCalled(); expect(lifecycle.start).not.toHaveBeenCalled();
});
it('stops prepared components when listen throws synchronously (P2)', async () => {
  const failure = new Error('controlled listen failure'); lifecycle.listen.mockImplementation(() => { throw failure; });
  const fatal = vi.fn(); const runtime = (await load())(fatal);
  await expect(runtime.ready).rejects.toBe(failure); expect(lifecycle.start).not.toHaveBeenCalled(); expect(lifecycle.stop).toHaveBeenCalledOnce(); expect(fatal).toHaveBeenCalledOnce();
});
it.each(['EADDRINUSE', 'EACCES'])('handles %s before listening without starting reconciliation', async (code) => {
  const runtime = (await load())(); const failure = Object.assign(new Error('PRIVATE'), { code }); http.emit('error', failure);
  await expect(runtime.ready).rejects.toBe(failure); listening(); await flush();
  expect(lifecycle.start).not.toHaveBeenCalled(); expect(lifecycle.stop).toHaveBeenCalledOnce(); expect(http.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE');
});
it('closes HTTP and the partially initialized reconciler after start rejects', async () => {
  const failure = new Error('controlled partial initialization'); lifecycle.start.mockRejectedValue(failure);
  const runtime = (await load())(); listening(); await expect(runtime.ready).rejects.toBe(failure);
  expect(lifecycle.stop).toHaveBeenCalledOnce(); expect(http.close).toHaveBeenCalledOnce();
});
it('waits for partial startup work before closing HTTP after a fatal error', async () => {
  let release!: () => void; lifecycle.stop.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  const failure = new Error('controlled startup rejection'); lifecycle.start.mockRejectedValue(failure);
  const runtime = (await load())(); listening(); await vi.waitFor(() => expect(lifecycle.stop).toHaveBeenCalledOnce());
  expect(http.close).not.toHaveBeenCalled(); release(); await expect(runtime.ready).rejects.toBe(failure); expect(http.close).toHaveBeenCalledOnce();
});
it.each(['SIGINT', 'SIGTERM'])('waits for admitted work on %s and coalesces repeated closure', async (name) => {
  let release!: () => void; lifecycle.stop.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  const runtime = (await load())(); listening(); await runtime.ready;
  const shutdown = signals.mock.calls.find(([signal]) => signal === name)![1] as () => void;
  shutdown(); shutdown(); expect(lifecycle.stop).toHaveBeenCalledOnce(); expect(http.close).not.toHaveBeenCalled();
  release(); await runtime.stop(); expect(http.close).toHaveBeenCalledOnce();
});
it('does not start reconciliation if a signal arrives before listening', async () => {
  const runtime = (await load())(); const shutdown = signals.mock.calls.find(([name]) => name === 'SIGTERM')![1] as () => void;
  shutdown(); listening(); await expect(runtime.ready).rejects.toMatchObject({ code: 'SERVER_STOPPED' });
  expect(lifecycle.start).not.toHaveBeenCalled(); expect(lifecycle.stop).toHaveBeenCalledOnce();
});
it('stops a reconciler whose initial pass is running when shutdown arrives', async () => {
  let complete!: () => void; lifecycle.start.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
  lifecycle.stop.mockImplementation(async () => { complete(); });
  const runtime = (await load())(); listening(); await flush(); await runtime.stop();
  await expect(runtime.ready).rejects.toMatchObject({ code: 'SERVER_STOPPED' }); expect(lifecycle.start).toHaveBeenCalledOnce(); expect(http.close).toHaveBeenCalledOnce();
});
it('closes both components on a fatal HTTP error after startup', async () => {
  const fatal = vi.fn(); const runtime = (await load())(fatal); listening(); await runtime.ready;
  http.emit('error', new Error('controlled runtime error')); await runtime.stop();
  expect(lifecycle.stop).toHaveBeenCalledOnce(); expect(http.close).toHaveBeenCalledOnce(); expect(fatal).toHaveBeenCalledOnce();
});
it('preserves the initialization failure and still closes HTTP when reconciler cleanup fails', async () => {
  const original = new Error('controlled original'); lifecycle.start.mockRejectedValue(original); lifecycle.stop.mockRejectedValue(new Error('PRIVATE cleanup'));
  const runtime = (await load())(); listening(); await expect(runtime.ready).rejects.toBe(original);
  expect(lifecycle.closeFirebase).toHaveBeenCalledOnce();
  expect(http.close).toHaveBeenCalledOnce(); expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE');
});
it('reports HTTP cleanup failure without replacing the initialization error', async () => {
  const original = new Error('controlled original'); lifecycle.start.mockRejectedValue(original);
  http.close.mockImplementation((callback) => { callback(new Error('PRIVATE close')); });
  const runtime = (await load())(); listening(); await expect(runtime.ready).rejects.toBe(original);
  expect(lifecycle.stop).toHaveBeenCalledOnce(); expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE');
});

it('closes main Firebase resources after HTTP and preserves an initial failure if that close fails', async () => {
  const original = new Error('controlled original'); lifecycle.start.mockRejectedValue(original);
  lifecycle.closeFirebase.mockImplementation(async () => { expect(http.close).toHaveBeenCalledOnce(); throw new Error('PRIVATE Firebase cleanup'); });
  const runtime = (await load())(); listening(); await expect(runtime.ready).rejects.toBe(original);
  expect(lifecycle.stop).toHaveBeenCalledOnce(); expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE');
});
it('forces HTTP connections only after grace and reports the abnormal shutdown', async () => {
  vi.useFakeTimers(); const runtime = (await load())(); listening(); await runtime.ready;
  let finish!: () => void;
  http.close.mockImplementation(callback => { finish = () => callback(); });
  const closeAll = vi.fn(() => finish()); Object.assign(http, { closeAllConnections: closeAll });
  const stopped = runtime.stop(); const failed = expect(stopped).rejects.toMatchObject({ code: 'SERVER_SHUTDOWN_FAILED' });
  await flush(); expect(closeAll).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(6000); await failed;
  expect(closeAll).toHaveBeenCalledOnce(); expect(lifecycle.closeFirebase).toHaveBeenCalledOnce(); expect(runtime.stop()).toBe(stopped); expect(vi.getTimerCount()).toBe(0);
});
it('bounds a nonresponding Firebase close and handles its later rejection', async () => {
  vi.useFakeTimers(); const runtime = (await load())(); listening(); await runtime.ready;
  let fail!: (error: Error) => void;
  lifecycle.closeFirebase.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const stopped = runtime.stop(); const rejected = expect(stopped).rejects.toMatchObject({ code: 'SERVER_SHUTDOWN_FAILED' });
  await vi.advanceTimersByTimeAsync(5000); await rejected; fail(new Error('private late failure')); await flush(); expect(vi.getTimerCount()).toBe(0);
});
it('does not terminate Firebase while an admitted transaction remains in progress', async () => {
  vi.useFakeTimers(); const runtime = (await load())(); listening(); await runtime.ready;
  const { withFirestore } = await import('./services/firestore.service.js'); let complete!: () => void;
  const admitted = withFirestore(() => new Promise<void>(resolve => { complete = resolve; }), {} as never);
  const rejected = expect(runtime.stop()).rejects.toMatchObject({ code: 'SERVER_SHUTDOWN_FAILED' });
  await vi.advanceTimersByTimeAsync(5000); await rejected; expect(lifecycle.closeFirebase).not.toHaveBeenCalled(); complete(); await admitted;
  expect(vi.getTimerCount()).toBe(0);
});
it('waits for admitted work to finish before terminating Firebase', async () => {
  const runtime = (await load())(); listening(); await runtime.ready;
  const { withFirestore } = await import('./services/firestore.service.js'); let complete!: () => void;
  const work = withFirestore(() => new Promise<void>(resolve => { complete = resolve; }), {} as never);
  const stopping = runtime.stop(); await flush(); expect(lifecycle.closeFirebase).not.toHaveBeenCalled(); complete(); await work; await stopping; expect(lifecycle.closeFirebase).toHaveBeenCalledOnce();
});
it('bounds an unfinished reconciler without closing Firebase beneath it', async () => {
  vi.useFakeTimers(); const runtime = (await load())(); listening(); await runtime.ready;
  lifecycle.stop.mockReturnValue(new Promise(() => {}));
  const rejected = expect(runtime.stop()).rejects.toMatchObject({ code: 'SERVER_SHUTDOWN_FAILED' }); await vi.advanceTimersByTimeAsync(5000); await rejected;
  expect(lifecycle.closeFirebase).not.toHaveBeenCalled(); expect(http.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('preserves the original startup failure when Firebase shutdown exceeds its deadline', async () => {
  vi.useFakeTimers(); const original = new Error('original startup'); lifecycle.start.mockRejectedValue(original);
  lifecycle.closeFirebase.mockReturnValue(new Promise(() => {})); const runtime = (await load())();
  const ready = expect(runtime.ready).rejects.toBe(original); listening(); await vi.advanceTimersByTimeAsync(5000); await ready;
  await expect(runtime.stop()).rejects.toMatchObject({ code: 'SERVER_SHUTDOWN_FAILED' });
});
it('CLI owner reports and terminates with failure at the hard deadline if SDK resources never close', async () => {
  vi.useFakeTimers(); const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const previousExitCode = process.exitCode;
  try {
    const { startApiProcess } = await import('./server.js'); const runtime = startApiProcess()!; listening(); await runtime.ready;
    lifecycle.closeFirebase.mockReturnValue(new Promise(() => {}));
    const rejected = expect(runtime.stop()).rejects.toMatchObject({ code: 'SERVER_SHUTDOWN_FAILED' });
    for (const [, handler] of signals.mock.calls.filter(([signal]) => signal === 'SIGTERM')) (handler as () => void)();
    await vi.advanceTimersByTimeAsync(5000); await rejected; expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20000); expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(console.error).toHaveBeenCalledWith({ event: 'api_shutdown_hard_deadline', code: 'SERVER_SHUTDOWN_FAILED' });
  } finally { process.exitCode = previousExitCode; }
});
it('does not force connections or close Firebase immediately when HTTP close reports an error', async () => {
  const runtime = (await load())(); listening(); await runtime.ready;
  const force = vi.fn(); Object.assign(http, { closeAllConnections: force });
  http.close.mockImplementation(callback => callback(new Error('private close failure')));
  await expect(runtime.stop()).rejects.toMatchObject({ code: 'SERVER_SHUTDOWN_FAILED' });
  expect(force).not.toHaveBeenCalled(); expect(lifecycle.closeFirebase).not.toHaveBeenCalled();
  expect(http.listenerCount('error')).toBe(1); http.emit('close'); expect(http.listenerCount('error')).toBe(0);
});
