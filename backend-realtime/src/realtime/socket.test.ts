import { ProfileAuthorizationError } from '../services/profile-state.service';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verifyToken: vi.fn(), requireActiveAccount: vi.fn(), startAccountAuthorization: vi.fn(), watchAccountDeletion: vi.fn(), requireCompleteProfile: vi.fn(), ensureRoomAccessible: vi.fn(), persistRoomMessage: vi.fn(), watchRoomAccess: vi.fn() }));
vi.mock('../services/profile-state.service', async original => ({ ...await original<typeof import('../services/profile-state.service')>(), requireCompleteProfile: mocks.requireCompleteProfile }));
vi.mock('../services/room-chat.service', async original => ({
  ...await original<typeof import('../services/room-chat.service')>(),
  ensureRoomAccessible: mocks.ensureRoomAccessible,
  persistRoomMessage: mocks.persistRoomMessage,
  watchRoomAccess: mocks.watchRoomAccess,
}));
vi.mock('../services/firebase-auth.service', () => ({ verifyToken: mocks.verifyToken }));
vi.mock('../services/account-state.service', async (original) => ({ ...await original<typeof import('../services/account-state.service')>(), requireActiveAccount: mocks.requireActiveAccount, startAccountAuthorization: mocks.startAccountAuthorization }));
vi.mock('../config/firebase', async (original) => ({
  ...await original<typeof import('../config/firebase')>(),
  watchAccountDeletion: mocks.watchAccountDeletion,
}));
import { AccountAuthorizationError, withAuthorizationTimeout } from '../services/account-state.service';
import { RoomChatError } from '../services/room-chat.service';
import { createRealtimeServer } from './socket';
import { TestSocketClient } from '../integration/socket-client';
let http: Server; let io: ReturnType<typeof createRealtimeServer>; let origin: string; let clients: TestSocketClient[];
beforeEach(async () => {
  vi.resetAllMocks(); clients = [];
  mocks.verifyToken.mockImplementation(async (token) => ({ uid: token, email_verified: true }));
  mocks.requireActiveAccount.mockResolvedValue(undefined);
  mocks.requireCompleteProfile.mockResolvedValue(undefined);
  mocks.ensureRoomAccessible.mockResolvedValue(undefined);
  mocks.watchRoomAccess.mockImplementation(() => vi.fn());
  mocks.persistRoomMessage.mockImplementation(async (_roomId, uid, text) => ({ messageId: 'msg-1', authorId: uid, text, createdAt: new Date().toISOString() }));
  mocks.watchAccountDeletion.mockImplementation((_uid, changed) => { queueMicrotask(() => changed(false)); return vi.fn(); });
  mocks.startAccountAuthorization.mockImplementation((uid) => {
    const authorized = mocks.requireActiveAccount(uid);
    return { authorized, settled: authorized.then(() => undefined, () => undefined) };
  });
  http = createServer(); io = createRealtimeServer(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
afterEach(async () => { await Promise.all(clients.map((client) => client.close())); await new Promise<void>((resolve) => io.close(() => resolve())); vi.restoreAllMocks(); });
function client(auth: Record<string, unknown> = { token: 'user' }) { const value = new TestSocketClient(origin, auth); clients.push(value); return value; }
async function connected(token = 'user') { const value = client({ token, uid: 'forged' }); await value.wait('connect'); return value; }
it('rejects a missing token before registering protected handlers', async () => {
  const value = client({ uid: 'forged' }); expect(await value.wait('connect_error')).toMatchObject({ message: 'AUTH_REQUIRED' });
  expect(mocks.verifyToken).not.toHaveBeenCalled(); expect(io.sockets.sockets.size).toBe(0);
});
it.each(['invalid', 'revoked', 'deleted', 'disabled'])('rejects %s identity without leaking SDK details', async (reason) => {
  mocks.verifyToken.mockRejectedValue(new Error(`PRIVATE ${reason}`));
  expect(await client().wait('connect_error')).toMatchObject({ message: 'AUTH_INVALID' });
  expect(mocks.requireActiveAccount).not.toHaveBeenCalled();
});
it('uses verified UID and explicitly checks revocation', async () => {
  await connected('trusted'); expect(mocks.verifyToken).toHaveBeenCalledWith('trusted', true);
  expect(mocks.requireActiveAccount).toHaveBeenCalledExactlyOnceWith('trusted');
});
it.each(['ACCOUNT_UNAVAILABLE', 'AUTHORIZATION_UNAVAILABLE'] as const)('denies handshake with %s and repeats checks on reconnect', async (code) => {
  mocks.requireActiveAccount.mockRejectedValue(new AccountAuthorizationError(code));
  for (let n = 0; n < 2; n++) expect(await client().wait('connect_error')).toMatchObject({ message: code, data: { code } });
  expect(mocks.requireActiveAccount).toHaveBeenCalledTimes(2); expect(io.sockets.sockets.size).toBe(0);
});
const events = ['room:join', 'room:leave', 'chat:send', 'webrtc:offer', 'webrtc:answer', 'webrtc:ice-candidate', 'media:state', 'screen:state'];
it.each(events)('blocks %s after the handshake without executing the handler', async (event) => {
  const value = await connected(); await value.request('room:join', { roomId: 'room' });
  const observer = await connected('observer'); await observer.request('room:join', { roomId: 'room' });
  mocks.requireActiveAccount.mockImplementation(async (uid) => { if (uid === 'user') throw new AccountAuthorizationError('ACCOUNT_UNAVAILABLE'); });
  const before = observer.received.length;
  expect(await value.request(event, { roomId: 'other', text: 'forbidden', uid: 'observer' })).toMatchObject({ ok: false, error: { code: 'ACCOUNT_UNAVAILABLE' } });
  await value.wait('disconnect');
  const observed = observer.received.slice(before);
  expect(observed.filter(([name]) => name !== 'room:participant-left')).toEqual([]);
  expect(io.sockets.adapter.rooms.get('room')?.size).toBe(1); expect(io.sockets.adapter.rooms.has('other')).toBe(false);
});
it('fails closed on Firestore failure without a broadcast; a later event checks again', async () => {
  const value = await connected(); await value.request('room:join', { roomId: 'room' });
  mocks.requireActiveAccount.mockRejectedValueOnce(new Error('PRIVATE'));
  expect(await value.request('chat:send', { text: 'denied' })).toMatchObject({ ok: false, error: { code: 'AUTHORIZATION_UNAVAILABLE' } });
  expect(value.received.some(([name]) => name === 'chat:message')).toBe(false);
  expect(await value.request('chat:send', { text: 'allowed' })).toEqual({ ok: true });
});
it('prevents a concurrent authorization from continuing after another detects the marker', async () => {
  const value = await connected(); await value.request('room:join', { roomId: 'room' });
  let release!: () => void; const started = new Promise<void>((resolve) => {
    mocks.requireActiveAccount.mockImplementationOnce(() => { resolve(); return new Promise<void>((done) => { release = done; }); });
  });
  value.send('chat:send', { text: 'racing' }); await started;
  expect(await value.request('media:state', {})).toEqual({ ok: true });
  mocks.requireActiveAccount.mockRejectedValueOnce(new AccountAuthorizationError('ACCOUNT_UNAVAILABLE'));
  value.send('screen:state', {}); await value.wait('disconnect'); release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(value.received.some(([event]) => event === 'chat:message')).toBe(false);
});
it('moves between rooms and cleans membership on disconnect without authorization', async () => {
  const value = await connected(); const observer = await connected('observer');
  await value.request('room:join', { roomId: 'first' });
  await value.request('room:join', { roomId: 'second' });
  await observer.request('room:join', { roomId: 'second' });
  expect(value.received.filter(([event]) => event === 'room:joined').at(-1)?.[1]).toMatchObject({ roomId: 'second', participants: ['user'] });
  expect(observer.received.filter(([event]) => event === 'room:joined').at(-1)?.[1]).toMatchObject({ roomId: 'second', participants: ['user', 'observer'] });
  expect(io.sockets.adapter.rooms.has('first')).toBe(false); expect(io.sockets.adapter.rooms.get('second')?.size).toBe(2);
  await value.request('room:join', { roomId: 'second' });
  mocks.requireActiveAccount.mockRejectedValue(new Error('unavailable'));
  const serverSocket = [...io.sockets.sockets.values()][0];
  const disconnected = new Promise<void>((resolve) => serverSocket.once('disconnect', () => resolve()));
  await value.close(); await disconnected;
  expect(io.sockets.adapter.rooms.get('second')?.size).toBe(1);
  await observer.close();
  await vi.waitFor(() => expect(io.sockets.adapter.rooms.has('second')).toBe(false));
});
it.each([null, undefined, 12, 'text', [], {}, { roomId: 2 }, { roomId: ' ' }])('handles invalid room payload %j', async (payload) => {
  const value = await connected();
  expect(await value.request('room:join', payload)).toMatchObject({ ok: false, error: { code: 'ROOM_ID_REQUIRED' } });
});
it.each([null, undefined, 12, 'text', [], {}, { text: 2 }, { text: ' ' }, { text: 'x'.repeat(2001) }])('handles invalid message payload', async (payload) => {
  const value = await connected(); await value.request('room:join', { roomId: 'room' });
  expect(await value.request('chat:send', payload)).toMatchObject({ ok: false, error: { code: 'MESSAGE_INVALID' } });
});
it.each(events.slice(3))('relays authorized %s with the verified UID', async (event) => {
  const value = await connected(); const observer = await connected('observer');
  await value.request('room:join', { roomId: 'room' }); await observer.request('room:join', { roomId: 'room' });
  expect(await value.request(event, { uid: 'forged', fixture: true })).toEqual({ ok: true });
  expect(await observer.wait(event)).toMatchObject({ fromUserId: 'user', payload: { fixture: true } });
});

it('does not publish a join that finishes after a marker was detected', async () => {
  const value = await connected(); const serverSocket = [...io.sockets.sockets.values()][0];
  const join = serverSocket.join.bind(serverSocket); let release!: () => void;
  let joining!: () => void; const started = new Promise<void>((resolve) => { joining = resolve; });
  vi.spyOn(serverSocket, 'join').mockImplementation((room) => new Promise<void>((resolve) => {
    joining(); release = () => { void join(room); resolve(); };
  }));
  value.send('room:join', { roomId: 'delayed' }); await started;
  mocks.requireActiveAccount.mockRejectedValueOnce(new AccountAuthorizationError('ACCOUNT_UNAVAILABLE'));
  value.send('chat:send', { text: 'blocked' }); await value.wait('disconnect'); release();
  await vi.waitFor(() => expect(io.sockets.adapter.rooms.has('delayed')).toBe(false));
  expect(value.received.some(([event]) => event === 'room:joined')).toBe(false);
});
it('leaves a room explicitly and sends only one participant-left notification', async () => {
  const value = await connected(); const observer = await connected('observer');
  await value.request('room:join', { roomId: 'room' }); await observer.request('room:join', { roomId: 'room' });
  expect(await value.request('room:leave')).toEqual({ ok: true });
  expect(await observer.wait('room:participant-left')).toEqual({ userId: 'user' });
  expect(await value.request('room:leave')).toEqual({ ok: true });
  await value.close();
  expect(observer.received.filter(([event, payload]) => event === 'room:participant-left' && (payload as { userId: string }).userId === 'user')).toHaveLength(1);
  expect(io.sockets.adapter.rooms.get('room')?.size).toBe(1);
});

function deferred() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
it('caps a real 1000-event burst at two reads, rejects 998 acknowledgements and never queues them', async () => {
  const actor = await connected(); const observer = await connected('observer');
  await actor.request('room:join', { roomId: 'burst' }); await observer.request('room:join', { roomId: 'burst' });
  const reads = [deferred(), deferred()];
  mocks.requireActiveAccount.mockImplementation((uid) => uid === 'user' ? reads[mocks.startAccountAuthorization.mock.calls.filter(([id]) => id === 'user').length - 1].promise : Promise.resolve());
  mocks.startAccountAuthorization.mockClear();
  const responses: any[] = [];
  const requests = Array.from({ length: 1000 }, () => actor.request('chat:send', { text: 'burst' }).then((result) => { responses.push(result); return result; }));
  await vi.waitFor(() => expect(responses).toHaveLength(998));
  expect(mocks.startAccountAuthorization.mock.calls.filter(([uid]) => uid === 'user')).toHaveLength(2);
  expect(responses.every((result) => result.error?.code === 'AUTHORIZATION_BUSY')).toBe(true);
  // Observer round-trip is a barrier for its outgoing broadcast stream.
  await observer.request('room:join', { roomId: 'burst' });
  expect(observer.received.filter(([event]) => event === 'chat:message')).toHaveLength(0);
  reads.forEach((read) => read.resolve()); await Promise.all(requests);
  await observer.request('room:join', { roomId: 'burst' });
  expect(observer.received.filter(([event]) => event === 'chat:message')).toHaveLength(2);
  expect(mocks.startAccountAuthorization.mock.calls.filter(([uid]) => uid === 'user')).toHaveLength(2);
});
it('frees one position on actual success and releases failures without executing their handlers', async () => {
  const actor = await connected(); const first = deferred(); const second = deferred();
  mocks.requireActiveAccount.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const a = actor.request('media:state', {}); const b = actor.request('screen:state', {});
  await vi.waitFor(() => expect(mocks.startAccountAuthorization).toHaveBeenCalledTimes(2));
  expect(await actor.request('chat:send', {})).toMatchObject({ error: { code: 'AUTHORIZATION_BUSY' } });
  first.resolve(); expect(await a).toEqual({ ok: true });
  expect(await actor.request('media:state', {})).toEqual({ ok: true });
  second.reject(new Error('PRIVATE')); expect(await b).toMatchObject({ error: { code: 'AUTHORIZATION_UNAVAILABLE' } });
  expect(await actor.request('screen:state', {})).toEqual({ ok: true });
});
it('retains capacity after timeout until SDK settlement, and a late resolution never runs its old handler', async () => {
  const actor = await connected(); await actor.request('room:join', { roomId: 'timeout' });
  const raw = [deferred(), deferred()];
  const set = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => set(callback, ms === 5000 ? 10 : ms, ...args)) as typeof setTimeout);
  let index = 0;
  mocks.startAccountAuthorization.mockImplementation(() => {
    const read = raw[index++];
    return { authorized: withAuthorizationTimeout(() => read.promise), settled: read.promise.then(() => undefined, () => undefined) };
  });
  const results = await Promise.all([actor.request('chat:send', { text: 'late' }), actor.request('chat:send', { text: 'late' })]);
  expect(results.every((result) => result.error.code === 'AUTHORIZATION_UNAVAILABLE')).toBe(true);
  for (let n = 0; n < 20; n++) expect(await actor.request('media:state', {})).toMatchObject({ error: { code: 'AUTHORIZATION_BUSY' } });
  expect(index).toBe(2);
  raw[0].resolve(); raw[1].reject(new Error('late SDK failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  mocks.startAccountAuthorization.mockImplementation(() => ({ authorized: Promise.resolve(), settled: Promise.resolve() }));
  expect(await actor.request('screen:state', {})).toEqual({ ok: true });
  expect(actor.received.filter(([event]) => event === 'chat:message')).toHaveLength(0);
});
it('applies the same admission gate to all eight events', async () => {
  const actor = await connected(); const reads = [deferred(), deferred()];
  mocks.requireActiveAccount.mockReturnValueOnce(reads[0].promise).mockReturnValueOnce(reads[1].promise);
  const admitted = [actor.request('media:state', {}), actor.request('screen:state', {})];
  await vi.waitFor(() => expect(mocks.startAccountAuthorization).toHaveBeenCalledTimes(2));
  for (const event of events) expect(await actor.request(event, {})).toMatchObject({ error: { code: 'AUTHORIZATION_BUSY' } });
  expect(mocks.startAccountAuthorization).toHaveBeenCalledTimes(2);
  reads.forEach((read) => read.resolve()); await Promise.all(admitted);
});
it('disconnects without resetting pending read capacity and discards late results', async () => {
  const actor = await connected(); await actor.request('room:join', { roomId: 'disconnect' });
  const read = deferred(); mocks.requireActiveAccount.mockReturnValueOnce(read.promise);
  actor.send('chat:send', { text: 'late' });
  await vi.waitFor(() => expect(mocks.startAccountAuthorization).toHaveBeenCalledTimes(2));
  const serverSocket = [...io.sockets.sockets.values()][0];
  const disconnected = new Promise<void>((resolve) => serverSocket.once('disconnect', () => resolve()));
  await actor.close(); await disconnected; expect(io.sockets.adapter.rooms.has('disconnect')).toBe(false);
  read.resolve(); await new Promise<void>((resolve) => setImmediate(resolve));
  expect(actor.received.filter(([event]) => event === 'chat:message')).toHaveLength(0);
  expect(await (await connected('other')).request('media:state', {})).toEqual({ ok: true });
});
it('keeps stuck reads in the server budget across disconnects and recovers after settlement', async () => {
  const users = await Promise.all(Array.from({ length: 32 }, (_, n) => connected('user-' + n)));
  const raw = deferred();
  mocks.startAccountAuthorization.mockImplementation(() => ({ authorized: raw.promise, settled: raw.promise.then(() => undefined, () => undefined) }));
  for (const user of users) { user.send('media:state', {}); user.send('screen:state', {}); }
  await vi.waitFor(() => expect(mocks.startAccountAuthorization).toHaveBeenCalledTimes(64));
  await Promise.all(users.map((user) => user.close()));
  const fresh = await connected('fresh');
  expect(await fresh.request('media:state', {})).toMatchObject({ error: { code: 'AUTHORIZATION_BUSY' } });
  expect(mocks.startAccountAuthorization).toHaveBeenCalledTimes(64);
  raw.resolve(); await new Promise<void>((resolve) => setImmediate(resolve));
  mocks.startAccountAuthorization.mockImplementation(() => ({ authorized: Promise.resolve(), settled: Promise.resolve() }));
  expect(await fresh.request('media:state', {})).toEqual({ ok: true });
});

it('proactively disconnects all local sessions of one UID while preserving another user and room cleanup', async () => {
  const observed = new Map<string, { changed: (exists: boolean) => void; stop: ReturnType<typeof vi.fn> }>();
  mocks.watchAccountDeletion.mockImplementation((uid, changed) => {
    const stop = vi.fn(); observed.set(uid, { changed, stop }); queueMicrotask(() => changed(false)); return stop;
  });
  const first = await connected('same'); const second = await connected('same'); const other = await connected('other');
  expect(mocks.watchAccountDeletion).toHaveBeenCalledTimes(2);
  for (const value of [first, second, other]) await value.request('room:join', { roomId: 'room' });
  const a = first.wait('disconnect'); const b = second.wait('disconnect');
  observed.get('same')!.changed(true); await Promise.all([a, b]);
  expect(await other.request('room:join', { roomId: 'room' })).toEqual({ ok: true });
  expect(io.sockets.adapter.rooms.get('room')?.size).toBe(1);
  expect(observed.get('same')!.stop).toHaveBeenCalledOnce();
  expect(observed.get('other')!.stop).not.toHaveBeenCalled();
});
it('observer denial discards an event still waiting on its SDK read', async () => {
  let changed!: (exists: boolean) => void;
  mocks.watchAccountDeletion.mockImplementation((_uid, callback) => { changed = callback; queueMicrotask(() => callback(false)); return vi.fn(); });
  const actor = await connected(); await actor.request('room:join', { roomId: 'room' });
  const read = deferred(); mocks.requireActiveAccount.mockReturnValueOnce(read.promise);
  actor.send('chat:send', { text: 'late' });
  await vi.waitFor(() => expect(mocks.startAccountAuthorization).toHaveBeenCalledTimes(2));
  changed(true); await actor.wait('disconnect'); read.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(actor.received.filter(([event]) => event === 'chat:message')).toHaveLength(0);
});
it('rejects observer initialization failure before accepting the handshake', async () => {
  mocks.watchAccountDeletion.mockImplementation(() => { throw new Error('PRIVATE'); });
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await client().wait('connect_error')).toMatchObject({ message: 'AUTHORIZATION_UNAVAILABLE' });
  expect(io.sockets.sockets.size).toBe(0); error.mockRestore();
});
it('observer failure cannot free the shared budget of outstanding SDK reads', async () => {
  const failed = new Map<string, (error: { code: string }) => void>();
  mocks.watchAccountDeletion.mockImplementation((uid, changed, error) => {
    failed.set(uid, error); queueMicrotask(() => changed(false)); return vi.fn();
  });
  const users = await Promise.all(Array.from({ length: 32 }, (_, n) => connected('observed-' + n)));
  const raw = deferred();
  mocks.startAccountAuthorization.mockImplementation(() => ({ authorized: raw.promise, settled: raw.promise.then(() => undefined, () => undefined) }));
  for (const user of users) { user.send('media:state', {}); user.send('screen:state', {}); }
  await vi.waitFor(() => expect(mocks.startAccountAuthorization).toHaveBeenCalledTimes(64));
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const closed = users.map((user) => user.wait('disconnect'));
  for (const error of failed.values()) error({ code: 'FIREBASE_OBSERVER_FAILED' });
  await Promise.all(closed);
  const fresh = await connected('fresh');
  expect(await fresh.request('media:state', {})).toMatchObject({ error: { code: 'AUTHORIZATION_BUSY' } });
  expect(mocks.startAccountAuthorization).toHaveBeenCalledTimes(64);
  raw.resolve(); await new Promise<void>((resolve) => setImmediate(resolve));
  mocks.startAccountAuthorization.mockImplementation(() => ({ authorized: Promise.resolve(), settled: Promise.resolve() }));
  expect(await fresh.request('media:state', {})).toEqual({ ok: true }); log.mockRestore();
});

it.each([false, undefined, 'true', 1])('rejects an unverified handshake despite client-supplied verification: %s', async (claim) => {
  mocks.verifyToken.mockResolvedValue({ uid: 'fixture', email_verified: claim });
  const value = client({ token: 'fixture', emailVerified: true, email_verified: true });
  expect(await value.wait('connect_error')).toMatchObject({ message: 'EMAIL_NOT_VERIFIED', data: { code: 'EMAIL_NOT_VERIFIED' } });
  expect(io.sockets.sockets.size).toBe(0);
  expect(mocks.requireCompleteProfile).not.toHaveBeenCalled();
  expect(mocks.watchAccountDeletion).not.toHaveBeenCalled();
});
it.each(['PROFILE_INCOMPLETE', 'PROFILE_INCONSISTENT', 'AUTHORIZATION_UNAVAILABLE'] as const)('rejects handshake with %s before supervision and handlers', async code => {
  mocks.requireCompleteProfile.mockRejectedValue(new ProfileAuthorizationError(code));
  expect(await client({ token: 'trusted', profileStatus: 'complete' }).wait('connect_error')).toMatchObject({ message: code, data: { code } });
  expect(mocks.requireCompleteProfile).toHaveBeenCalledExactlyOnceWith('trusted');
  expect(mocks.watchAccountDeletion).not.toHaveBeenCalled(); expect(io.sockets.sockets.size).toBe(0);
});

it.each(['nested/room', '.', '..', '__reserved__', 'a'.repeat(129)])('rejects invalid room IDs before checking Firestore (%j)', async (roomId) => {
  const guest = await connected('guest');
  expect(await guest.request('room:join', { roomId })).toMatchObject({ ok: false, error: { code: 'ROOM_ID_INVALID' } });
  expect(mocks.ensureRoomAccessible).not.toHaveBeenCalled();
});

it('tracks one participant across two connections and announces the last departure', async () => {
  const observer = await connected('observer');
  const first = await connected('guest');
  const second = await connected('guest');
  await observer.request('room:join', { roomId: 'presence' });
  await first.request('room:join', { roomId: '  presence  ' });
  expect(await observer.wait('room:participant-joined')).toEqual({ userId: 'guest' });
  expect(mocks.ensureRoomAccessible).toHaveBeenCalledWith('presence', 'guest');

  await second.request('room:join', { roomId: 'presence' });
  expect(await second.wait('room:joined')).toEqual({ roomId: 'presence', participants: ['observer', 'guest'] });
  await first.request('room:leave', {});
  // An acknowledgement to the observer flushes earlier events on its connection.
  await observer.request('room:join', { roomId: 'presence' });
  expect(observer.received.filter(([event]) => event === 'room:participant-joined')).toHaveLength(1);
  expect(observer.received.filter(([event]) => event === 'room:participant-left')).toHaveLength(0);

  await second.close();
  expect(await observer.wait('room:participant-left')).toEqual({ userId: 'guest' });
});

it.each(['ROOM_NOT_FOUND', 'ROOM_ACCESS_DENIED'] as const)('rejects room:join with %s without joining or leaving current room', async (code) => {
  const value = await connected();
  await value.request('room:join', { roomId: 'existing' });
  mocks.ensureRoomAccessible.mockRejectedValueOnce(new RoomChatError(code));
  expect(await value.request('room:join', { roomId: 'blocked' })).toMatchObject({ ok: false, error: { code } });
  expect(io.sockets.adapter.rooms.has('blocked')).toBe(false);
  expect(io.sockets.adapter.rooms.get('existing')?.size).toBe(1);
});

it('persists chat:send messages in Firestore before broadcasting and fails closed on persistence error', async () => {
  const value = await connected('sender');
  await value.request('room:join', { roomId: 'room-1' });
  expect(await value.request('chat:send', { text: 'Hola sala' })).toEqual({ ok: true });
  expect(mocks.persistRoomMessage).toHaveBeenCalledWith('room-1', 'sender', 'Hola sala');
  expect(value.received.find(([name]) => name === 'chat:message')?.[1]).toMatchObject({ messageId: 'msg-1', authorId: 'sender', text: 'Hola sala' });

  const before = value.received.length;
  mocks.persistRoomMessage.mockRejectedValueOnce(new RoomChatError('EVENT_FAILED'));
  expect(await value.request('chat:send', { text: 'No persistido' })).toMatchObject({ ok: false, error: { code: 'EVENT_FAILED' } });
  expect(value.received.slice(before).some(([name]) => name === 'chat:message')).toBe(false);
});

it('revalidates on re-joining the same roomId and kicks user if access was revoked', async () => {
  const value = await connected('member');
  expect(await value.request('room:join', { roomId: 'room-1' })).toEqual({ ok: true });
  mocks.ensureRoomAccessible.mockRejectedValueOnce(new RoomChatError('ROOM_ACCESS_DENIED'));
  expect(await value.request('room:join', { roomId: 'room-1' })).toMatchObject({ ok: false, error: { code: 'ROOM_ACCESS_DENIED' } });
  expect(value.received.some(([name, payload]) => name === 'room:access-revoked' && (payload as { code: string }).code === 'ROOM_ACCESS_DENIED')).toBe(true);
  expect(io.sockets.adapter.rooms.has('room-1')).toBe(false);
});

it('revokes live access, stops broadcasts, cleans listeners, and avoids duplicate participant-left on disconnect', async () => {
  let triggerRevoke!: (code: 'ROOM_NOT_FOUND' | 'ROOM_ACCESS_DENIED') => void;
  const stopWatcher = vi.fn();
  mocks.watchRoomAccess.mockImplementation((_roomId, uid, onRevoked) => {
    if (uid === 'target') triggerRevoke = onRevoked;
    return stopWatcher;
  });

  const observer = await connected('observer');
  const target = await connected('target');
  await observer.request('room:join', { roomId: 'room-1' });
  await target.request('room:join', { roomId: 'room-1' });

  const observerLeftBefore = observer.received.filter(([e]) => e === 'room:participant-left').length;
  triggerRevoke('ROOM_NOT_FOUND');

  await vi.waitFor(() => {
    expect(target.received.some(([e, p]) => e === 'room:access-revoked' && (p as { roomId: string; code: string }).code === 'ROOM_NOT_FOUND')).toBe(true);
  });
  expect(stopWatcher).toHaveBeenCalled();

  // Target no longer receives subsequent room broadcasts.
  const targetCountAfterRevoke = target.received.length;
  await observer.request('chat:send', { text: 'solo para miembros' });
  expect(target.received.slice(targetCountAfterRevoke).some(([e]) => e === 'chat:message')).toBe(false);

  // Subsequent disconnect or room:leave does not emit a duplicate room:participant-left.
  await target.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const observerLeftAfter = observer.received.filter(([e]) => e === 'room:participant-left').length;
  expect(observerLeftAfter - observerLeftBefore).toBe(1);
});

it('notifies every connection in the deleted room and leaves other rooms alone', async () => {
  const watchers = new Map<string, (code: 'ROOM_NOT_FOUND') => void>();
  mocks.watchRoomAccess.mockImplementation((_roomId, uid, notify) => {
    watchers.set(uid, notify);
    return vi.fn();
  });
  const host = await connected('host');
  const guest = await connected('guest');
  const unrelated = await connected('unrelated');
  await host.request('room:join', { roomId: 'deleted' });
  await guest.request('room:join', { roomId: 'deleted' });
  await unrelated.request('room:join', { roomId: 'other' });

  watchers.get('host')?.('ROOM_NOT_FOUND');
  watchers.get('guest')?.('ROOM_NOT_FOUND');

  const notice = { roomId: 'deleted', code: 'ROOM_NOT_FOUND' };
  expect(await host.wait('room:access-revoked')).toEqual(notice);
  expect(await guest.wait('room:access-revoked')).toEqual(notice);
  expect(unrelated.received.some(([event]) => event === 'room:access-revoked')).toBe(false);
  expect(io.sockets.adapter.rooms.has('deleted')).toBe(false);
  expect(io.sockets.adapter.rooms.get('other')?.size).toBe(1);
  expect(io.sockets.sockets.size).toBe(3);
});

it('revokes access if the room is deleted before the message transaction commits', async () => {
  const guest = await connected('guest');
  await guest.request('room:join', { roomId: 'deleted' });
  mocks.persistRoomMessage.mockRejectedValueOnce(new RoomChatError('ROOM_NOT_FOUND'));

  expect(await guest.request('chat:send', { text: 'Hola' })).toMatchObject({
    ok: false, error: { code: 'ROOM_NOT_FOUND' },
  });
  expect(await guest.wait('room:access-revoked')).toEqual({ roomId: 'deleted', code: 'ROOM_NOT_FOUND' });
  expect(guest.received.some(([event]) => event === 'chat:message')).toBe(false);
});

it('blocks chat:send when access is revoked before or during send', async () => {
  const value = await connected('member');
  await value.request('room:join', { roomId: 'room-1' });
  mocks.ensureRoomAccessible.mockRejectedValueOnce(new RoomChatError('ROOM_ACCESS_DENIED'));
  expect(await value.request('chat:send', { text: 'bloqueado' })).toMatchObject({ ok: false, error: { code: 'ROOM_ACCESS_DENIED' } });
  expect(mocks.persistRoomMessage).not.toHaveBeenCalled();
});

it('detaches room watcher on room:leave and disconnect', async () => {
  const stopWatcher = vi.fn();
  mocks.watchRoomAccess.mockReturnValue(stopWatcher);
  const value = await connected('member');
  await value.request('room:join', { roomId: 'room-1' });
  await value.request('room:leave', {});
  expect(stopWatcher).toHaveBeenCalledTimes(1);
});
