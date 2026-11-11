import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAccountAccess } from './account-access';
import { env } from '../config/env';
import { FirebaseConfigurationError } from '../config/firebase';
import { verifyToken } from '../services/firebase-auth.service';
import { AccountAuthorizationError, requireActiveAccount, startAccountAuthorization, withAuthorizationTimeout } from '../services/account-state.service';

const lifecycles = new WeakMap<Server, { stop(): void; drain(): Promise<void> }>();
export function getRealtimeLifecycle(io: Server) {
  const lifecycle = lifecycles.get(io);
  if (!lifecycle) throw new Error('UNKNOWN_REALTIME_SERVER');
  return lifecycle;
}

export const MAX_IN_FLIGHT_AUTHORIZATIONS_PER_SOCKET = 2;
export const MAX_IN_FLIGHT_EVENT_AUTHORIZATIONS_PER_SERVER = 64;

const messages = {
  AUTHORIZATION_BUSY: 'Hay demasiadas autorizaciones pendientes. Inténtalo más tarde.',
  AUTH_REQUIRED: 'Se requiere autenticación.',
  AUTH_INVALID: 'La autenticación no es válida.',
  ACCOUNT_UNAVAILABLE: 'La cuenta no puede realizar esta operación.',
  AUTHORIZATION_UNAVAILABLE: 'No se pudo comprobar la autorización.',
  ROOM_ID_REQUIRED: 'roomId es obligatorio.',
  MESSAGE_INVALID: 'El mensaje no es válido.',
  EVENT_FAILED: 'No se pudo completar el evento.',
};
type Code = keyof typeof messages;
type Ack = (result: { ok: boolean; error?: { code: Code; message: string } }) => void;
const codeFor = (error: unknown): Code => error instanceof AccountAuthorizationError ? error.code : 'AUTHORIZATION_UNAVAILABLE';
const field = (payload: unknown, key: string): unknown =>
  typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>)[key] : undefined;
function report(socket: Socket, code: Code, ack?: Ack) {
  const error = { code, message: messages[code] };
  socket.emit('error:message', error);
  ack?.({ ok: false, error });
}

export function createRealtimeServer(httpServer: HttpServer): Server {
  const corsOrigin = env.CORS_ORIGINS.length ? env.CORS_ORIGINS : env.NODE_ENV === 'production' ? false : true;
  const io = new Server(httpServer, { cors: { origin: corsOrigin } });

  const access = createAccountAccess();
  let stopping = false;
  const pendingReads = new Set<Promise<void>>();
  lifecycles.set(io, { stop: () => { stopping = true; access.close(); }, drain: async () => { await Promise.all([...pendingReads]); } });
  const close = io.close.bind(io);
  io.close = ((callback?: (error?: Error) => void) => {
    stopping = true; access.close();
    return close(callback);
  }) as typeof io.close;

  io.use(async (socket, next) => {
    if (stopping) { next(new Error('AUTHORIZATION_UNAVAILABLE')); return; }
    const abort = new AbortController();
    const gone = () => abort.abort();
    socket.conn.once('close', gone);
    const disconnected = () => { gone(); socket.conn.off('close', gone); };
    socket.once('disconnect', disconnected);
    const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : undefined;
    const deny = (code: Code) => { gone(); socket.conn.off('close', gone); socket.off('disconnect', disconnected); next(Object.assign(new Error(code), { data: { code } })); };
    if (!token) { deny('AUTH_REQUIRED'); return; }
    try {
      // Never accept identity from the handshake payload itself.
      let user;
      try { user = await withAuthorizationTimeout(() => verifyToken(token, true)); }
      catch (error) {
        deny(error instanceof AccountAuthorizationError || error instanceof FirebaseConfigurationError ? 'AUTHORIZATION_UNAVAILABLE' : 'AUTH_INVALID');
        return;
      }
      await requireActiveAccount(user.uid);
      socket.data.user = user;
      await access.attach(user.uid, {
        block: (code) => { socket.data.accountAccessBlocked = true; socket.data.accountAccessCode = code; },
        disconnect: () => { if (socket.connected) { socket.emit('error:message', { code: socket.data.accountAccessCode, message: 'La sesión ya no está autorizada.' }); socket.disconnect(true); } },
      }, abort.signal);
      if (stopping || abort.signal.aborted || socket.data.accountAccessBlocked) { deny(socket.data.accountAccessCode ?? 'AUTHORIZATION_UNAVAILABLE'); return; }
      next();
    } catch (error) { deny(codeFor(error)); }
  });

  // Includes reads belonging to disconnected sockets until they actually settle.
  let serverInFlight = 0;
  io.on('connection', (socket) => {
    if (stopping || socket.data.accountAccessBlocked) { socket.disconnect(true); return; }
    let inFlight = 0;
    let blocked = false;
    // One wrapper covers every application handler, including room:leave.
    // Internal disconnect cleanup never passes through this authorization gate.
    function protect(event: string, handler: (payload: unknown, allowed: () => boolean, ack?: Ack) => void | Promise<void>) {
      socket.on(event, (...args: unknown[]) => {
        const last = args[args.length - 1];
        const ack = typeof last === 'function' ? last as Ack : undefined;
        const allowed = () => socket.connected && !blocked && !stopping && !socket.data.accountAccessBlocked;
        if (!allowed()) { report(socket, 'ACCOUNT_UNAVAILABLE', ack); return; }
        // Admission is synchronous, before starting the SDK read. No event queue.
        if (inFlight >= MAX_IN_FLIGHT_AUTHORIZATIONS_PER_SOCKET || serverInFlight >= MAX_IN_FLIGHT_EVENT_AUTHORIZATIONS_PER_SERVER) {
          report(socket, 'AUTHORIZATION_BUSY', ack); return;
        }
        inFlight++; serverInFlight++;
        let readSettled = false;
        let eventFinished = false;
        let released = false;
        const release = () => {
          if (!released && readSettled && eventFinished) { released = true; inFlight--; serverInFlight--; }
        };
        void (async () => {
          try {
            const operation = startAccountAuthorization(socket.data.user?.uid);
            // settled never rejects, and represents the read rather than Promise.race.
            pendingReads.add(operation.settled);
            void operation.settled.then(() => { pendingReads.delete(operation.settled); readSettled = true; release(); });
            await operation.authorized;
          }
          catch (error) {
            const code = codeFor(error);
            if (code === 'ACCOUNT_UNAVAILABLE') blocked = true;
            report(socket, code, ack);
            if (blocked) socket.disconnect(true);
            return;
          }
          // Other concurrently authorizing events may already have detected a marker.
          if (!allowed()) { report(socket, 'ACCOUNT_UNAVAILABLE', ack); return; }
          await handler(args[0], allowed, ack);
        })().catch(() => { report(socket, 'EVENT_FAILED', ack); }).finally(() => {
          eventFinished = true; release();
        });
      });
    }

    protect('room:join', async (payload, allowed, ack) => {
      const value = field(payload, 'roomId');
      const roomId = typeof value === 'string' ? value.trim() : '';
      if (!roomId) { report(socket, 'ROOM_ID_REQUIRED', ack); return; }
      // Serialize room transitions; asynchronous adapters must not leave old memberships.
      const previous = transitions;
      let release!: () => void;
      transitions = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        if (!allowed()) { report(socket, 'ACCOUNT_UNAVAILABLE', ack); return; }
        if (socket.data.roomId === roomId) { socket.emit('room:joined', { roomId }); ack?.({ ok: true }); return; }
        await leaveRoom(socket);
        if (!allowed()) { report(socket, 'ACCOUNT_UNAVAILABLE', ack); return; }
        await socket.join(roomId);
        if (!allowed()) { await socket.leave(roomId); report(socket, 'ACCOUNT_UNAVAILABLE', ack); return; }
        socket.data.roomId = roomId;
        socket.to(roomId).emit('room:participant-joined', { userId: socket.data.user.uid });
        socket.emit('room:joined', { roomId });
        ack?.({ ok: true });
      } finally { release(); }
    });
    let transitions = Promise.resolve();
    protect('room:leave', async (_payload, allowed, ack) => {
      const previous = transitions;
      let release!: () => void;
      transitions = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { if (!allowed()) { report(socket, 'ACCOUNT_UNAVAILABLE', ack); return; } await leaveRoom(socket); ack?.({ ok: true }); }
      finally { release(); }
    });
    protect('chat:send', (payload, _allowed, ack) => {
      const value = field(payload, 'text');
      const message = typeof value === 'string' ? value.trim() : '';
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId || !message || message.length > 2000) { report(socket, 'MESSAGE_INVALID', ack); return; }
      io.to(roomId).emit('chat:message', { authorId: socket.data.user.uid, text: message, createdAt: new Date().toISOString() });
      ack?.({ ok: true });
    });
    for (const event of ['webrtc:offer', 'webrtc:answer', 'webrtc:ice-candidate', 'media:state', 'screen:state']) {
      protect(event, (payload, _allowed, ack) => {
        const roomId = socket.data.roomId as string | undefined;
        if (roomId) socket.to(roomId).emit(event, { fromUserId: socket.data.user.uid, payload });
        ack?.({ ok: true });
      });
    }
    socket.on('disconnect', () => {
      // Socket.IO removes memberships itself. Notify using retained logical room ID.
      const roomId = socket.data.roomId as string | undefined;
      delete socket.data.roomId;
      if (roomId) socket.to(roomId).emit('room:participant-left', { userId: socket.data.user.uid });
    });
  });
  return io;
}
async function leaveRoom(socket: Socket): Promise<void> {
  const roomId = socket.data.roomId as string | undefined;
  if (!roomId) return;
  delete socket.data.roomId;
  await socket.leave(roomId);
  // No protected action may resume after a disconnect. Cleanup itself is unconditional.
  if (socket.connected) socket.to(roomId).emit('room:participant-left', { userId: socket.data.user.uid });
}
