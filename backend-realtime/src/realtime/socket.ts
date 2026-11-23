import { requireCompleteProfile, ProfileAuthorizationError } from '../services/profile-state.service';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAccountAccess } from './account-access';
import { env } from '../config/env';
import { FirebaseConfigurationError } from '../config/firebase';
import { verifyToken } from '../services/firebase-auth.service';
import { AccountAuthorizationError, requireActiveAccount, startAccountAuthorization, withAuthorizationTimeout } from '../services/account-state.service';
import { ensureRoomAccessible, persistRoomMessage, RoomChatError, watchRoomAccess } from '../services/room-chat.service';

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
  PROFILE_INCOMPLETE: 'Completa tu perfil y selecciona un username antes de acceder.',
  PROFILE_INCONSISTENT: 'El perfil requiere revisión.',
  EMAIL_NOT_VERIFIED: 'Verifica tu correo y actualiza el ID token para acceder.',
  AUTH_INVALID: 'La autenticación no es válida.',
  ACCOUNT_UNAVAILABLE: 'La cuenta no puede realizar esta operación.',
  AUTHORIZATION_UNAVAILABLE: 'No se pudo comprobar la autorización.',
  ROOM_ID_REQUIRED: 'roomId es obligatorio.',
  ROOM_ID_INVALID: 'Ingresa un identificador de sala válido.',
  ROOM_NOT_FOUND: 'La sala no existe.',
  ROOM_ACCESS_DENIED: 'No tienes acceso a esta sala.',
  MESSAGE_INVALID: 'El mensaje no es válido.',
  EVENT_FAILED: 'No se pudo completar el evento.',
};
type Code = keyof typeof messages;
type Ack = (result: { ok: boolean; error?: { code: Code; message: string } }) => void;
const codeFor = (error: unknown): Code => error instanceof AccountAuthorizationError || error instanceof ProfileAuthorizationError ? error.code : 'AUTHORIZATION_UNAVAILABLE';
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
  const roomWatchers = new Set<() => void>();
  const closeRoomWatchers = () => {
    for (const stop of [...roomWatchers]) stop();
    roomWatchers.clear();
  };
  lifecycles.set(io, { stop: () => { stopping = true; access.close(); closeRoomWatchers(); }, drain: async () => { await Promise.all([...pendingReads]); } });
  const close = io.close.bind(io);
  io.close = ((callback?: (error?: Error) => void) => {
    stopping = true; access.close(); closeRoomWatchers();
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
      if (user.email_verified !== true) { deny('EMAIL_NOT_VERIFIED'); return; }
      await requireCompleteProfile(user.uid);
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
    function protect(event: string, handler: (payload: unknown, allowed: () => boolean, ack: Ack | undefined, receivedRoomGeneration: number | undefined) => void | Promise<void>) {
      socket.on(event, (...args: unknown[]) => {
        const receivedRoomGeneration = socket.data.roomGeneration as number | undefined;
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
          await handler(args[0], allowed, ack, receivedRoomGeneration);
        })().catch(() => { report(socket, 'EVENT_FAILED', ack); }).finally(() => {
          eventFinished = true; release();
        });
      });
    }

    const detachRoomWatcher = () => {
      const stop = socket.data.roomWatcher as (() => void) | undefined;
      delete socket.data.roomWatcher;
      if (stop) {
        roomWatchers.delete(stop);
        stop();
      }
    };
    const revokeRoomAccess = (expectedRoomId: string, generation: number, code: 'ROOM_NOT_FOUND' | 'ROOM_ACCESS_DENIED') => {
      if (socket.data.roomId !== expectedRoomId || socket.data.roomGeneration !== generation) return;
      socket.data.roomGeneration = generation + 1;
      delete socket.data.roomId;
      detachRoomWatcher();
      void (async () => {
        try { await socket.leave(expectedRoomId); }
        finally {
          if (socket.connected) {
            socket.emit('room:access-revoked', { roomId: expectedRoomId, code });
            notifyParticipantLeft(socket, expectedRoomId);
          }
        }
      })();
    };
    const attachRoomWatcher = (roomId: string, generation: number) => {
      detachRoomWatcher();
      const stop = watchRoomAccess(
        roomId,
        socket.data.user.uid,
        (code) => revokeRoomAccess(roomId, generation, code),
        () => revokeRoomAccess(roomId, generation, 'ROOM_ACCESS_DENIED'),
      );
      if (socket.data.roomId === roomId && socket.data.roomGeneration === generation && socket.connected && !stopping) {
        socket.data.roomWatcher = stop;
        roomWatchers.add(stop);
      } else {
        stop();
      }
    };

    protect('room:join', async (payload, allowed, ack) => {
      const value = field(payload, 'roomId');
      const roomId = typeof value === 'string' ? value.trim() : '';
      if (!roomId) { report(socket, 'ROOM_ID_REQUIRED', ack); return; }
      if (roomId.length > 128 || /\/|^\.{1,2}$|^__.*__$/.test(roomId)) {
        report(socket, 'ROOM_ID_INVALID', ack);
        return;
      }
      // Serialize room transitions; asynchronous adapters must not leave old memberships.
      const previous = transitions;
      let release!: () => void;
      transitions = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        if (!allowed()) { report(socket, 'ACCOUNT_UNAVAILABLE', ack); return; }
        try {
          await ensureRoomAccessible(roomId, socket.data.user.uid);
        } catch (error) {
          const code = error instanceof RoomChatError ? error.code : 'AUTHORIZATION_UNAVAILABLE';
          if (socket.data.roomId === roomId && (code === 'ROOM_NOT_FOUND' || code === 'ROOM_ACCESS_DENIED')) {
            await leaveRoom(socket, detachRoomWatcher);
            if (socket.connected) socket.emit('room:access-revoked', { roomId, code });
          }
          report(socket, code, ack);
          return;
        }
        if (!allowed()) { report(socket, 'ACCOUNT_UNAVAILABLE', ack); return; }
        if (socket.data.roomId === roomId) {
          if (!socket.data.roomWatcher) {
            attachRoomWatcher(roomId, (socket.data.roomGeneration as number | undefined) ?? 0);
          }
          socket.emit('room:joined', { roomId, participants: roomParticipants(socket, roomId) });
          ack?.({ ok: true });
          return;
        }
        await leaveRoom(socket, detachRoomWatcher);
        if (!allowed()) { report(socket, 'ACCOUNT_UNAVAILABLE', ack); return; }
        await socket.join(roomId);
        if (!allowed()) { await socket.leave(roomId); report(socket, 'ACCOUNT_UNAVAILABLE', ack); return; }
        const generation = ((socket.data.roomGeneration as number | undefined) ?? 0) + 1;
        socket.data.roomId = roomId;
        socket.data.roomGeneration = generation;
        attachRoomWatcher(roomId, generation);
        if (socket.data.roomId !== roomId || socket.data.roomGeneration !== generation) {
          report(socket, 'ROOM_ACCESS_DENIED', ack);
          return;
        }
        announceParticipant(socket, roomId);
        ack?.({ ok: true });
      } finally { release(); }
    });
    let transitions = Promise.resolve();
    protect('room:leave', async (_payload, allowed, ack) => {
      const previous = transitions;
      let release!: () => void;
      transitions = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { if (!allowed()) { report(socket, 'ACCOUNT_UNAVAILABLE', ack); return; } await leaveRoom(socket, detachRoomWatcher); ack?.({ ok: true }); }
      finally { release(); }
    });
    protect('chat:send', async (payload, allowed, ack, receivedRoomGeneration) => {
      // Bind the send to the room active when the event arrived, before authorization.
      if (socket.data.roomGeneration !== receivedRoomGeneration) {
        report(socket, 'ROOM_ACCESS_DENIED', ack);
        return;
      }
      const value = field(payload, 'text');
      const message = typeof value === 'string' ? value.trim() : '';
      const roomId = socket.data.roomId as string | undefined;
      const generation = socket.data.roomGeneration as number | undefined;
      if (!roomId || !message || message.length > 2000) { report(socket, 'MESSAGE_INVALID', ack); return; }
      try {
        await ensureRoomAccessible(roomId, socket.data.user.uid);
      } catch (error) {
        const code = error instanceof RoomChatError ? error.code : 'AUTHORIZATION_UNAVAILABLE';
        if (code === 'ROOM_NOT_FOUND' || code === 'ROOM_ACCESS_DENIED') {
          revokeRoomAccess(roomId, generation ?? 0, code);
        }
        report(socket, code, ack);
        return;
      }
      if (!allowed() || socket.data.roomId !== roomId || socket.data.roomGeneration !== generation) {
        report(socket, 'ROOM_ACCESS_DENIED', ack);
        return;
      }
      try {
        const saved = await persistRoomMessage(roomId, socket.data.user.uid, message);
        if (!allowed() || socket.data.roomId !== roomId || socket.data.roomGeneration !== generation) {
          report(socket, 'ROOM_ACCESS_DENIED', ack);
          return;
        }
        io.to(roomId).emit('chat:message', saved);
        ack?.({ ok: true });
      } catch (error) {
        const code = error instanceof RoomChatError ? error.code : 'EVENT_FAILED';
        if (code === 'ROOM_NOT_FOUND' || code === 'ROOM_ACCESS_DENIED') {
          revokeRoomAccess(roomId, generation ?? 0, code);
        }
        report(socket, code, ack);
      }
    });
    for (const event of ['webrtc:offer', 'webrtc:answer', 'webrtc:ice-candidate', 'media:state', 'screen:state']) {
      protect(event, (payload, allowed, ack) => {
        const roomId = socket.data.roomId as string | undefined;
        const generation = socket.data.roomGeneration as number | undefined;
        if (roomId && socket.data.roomGeneration === generation && allowed()) {
          socket.to(roomId).emit(event, { fromUserId: socket.data.user.uid, payload });
        }
        ack?.({ ok: true });
      });
    }
    socket.on('disconnect', () => {
      // Socket.IO removes memberships itself. Notify using retained logical room ID.
      const roomId = socket.data.roomId as string | undefined;
      socket.data.roomGeneration = ((socket.data.roomGeneration as number | undefined) ?? 0) + 1;
      delete socket.data.roomId;
      detachRoomWatcher();
      if (roomId) notifyParticipantLeft(socket, roomId);
    });
  });
  return io;
}
function roomParticipants(socket: Socket, roomId: string, excludeSocketId?: string): string[] {
  const participants = new Set<string>();
  for (const id of socket.nsp.adapter.rooms.get(roomId) ?? []) {
    if (id === excludeSocketId) continue;
    const data = socket.nsp.sockets.get(id)?.data;
    if (data?.roomId === roomId && typeof data.user?.uid === 'string') {
      participants.add(data.user.uid);
    }
  }
  return [...participants];
}

function announceParticipant(socket: Socket, roomId: string): void {
  const userId = socket.data.user.uid as string;
  const participants = roomParticipants(socket, roomId, socket.id);
  if (!participants.includes(userId)) {
    participants.push(userId);
    socket.to(roomId).emit('room:participant-joined', { userId });
  }
  socket.emit('room:joined', { roomId, participants });
}

function notifyParticipantLeft(socket: Socket, roomId: string): void {
  const userId = socket.data.user.uid as string;
  if (!roomParticipants(socket, roomId, socket.id).includes(userId)) {
    socket.to(roomId).emit('room:participant-left', { userId });
  }
}

async function leaveRoom(socket: Socket, detachWatcher?: () => void): Promise<void> {
  const roomId = socket.data.roomId as string | undefined;
  socket.data.roomGeneration = ((socket.data.roomGeneration as number | undefined) ?? 0) + 1;
  detachWatcher?.();
  if (!roomId) return;
  delete socket.data.roomId;
  await socket.leave(roomId);
  // No protected action may resume after a disconnect. Cleanup itself is unconditional.
  if (socket.connected) notifyParticipantLeft(socket, roomId);
}
