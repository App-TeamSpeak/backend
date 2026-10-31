import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env';
import { verifyToken } from '../services/firebase-auth.service';

export function createRealtimeServer(httpServer: HttpServer): Server {
  const corsOrigin = env.CORS_ORIGINS.length
    ? env.CORS_ORIGINS
    : env.NODE_ENV === 'production' ? false : true;
  const io = new Server(httpServer, { cors: { origin: corsOrigin } });

  io.use(async (socket, next) => {
    const token = typeof socket.handshake.auth?.token === 'string'
      ? socket.handshake.auth.token
      : undefined;

    if (!token) {
      next(new Error('AUTH_REQUIRED'));
      return;
    }

    try {
      socket.data.user = await verifyToken(token);
      next();
    } catch {
      next(new Error('AUTH_INVALID'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('room:join', ({ roomId }: { roomId?: string }) => {
      if (!roomId?.trim()) {
        socket.emit('error:message', { code: 'ROOM_ID_REQUIRED', message: 'roomId es obligatorio.' });
        return;
      }

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.to(roomId).emit('room:participant-joined', { userId: socket.data.user.uid });
      socket.emit('room:joined', { roomId });
    });

    socket.on('room:leave', () => leaveRoom(socket));

    socket.on('chat:send', ({ text }: { text?: string }) => {
      const roomId = socket.data.roomId as string | undefined;
      const message = text?.trim();
      if (!roomId || !message || message.length > 2000) {
        socket.emit('error:message', { code: 'MESSAGE_INVALID', message: 'El mensaje no es válido.' });
        return;
      }

      io.to(roomId).emit('chat:message', {
        authorId: socket.data.user.uid,
        text: message,
        createdAt: new Date().toISOString(),
      });
    });

    for (const event of ['webrtc:offer', 'webrtc:answer', 'webrtc:ice-candidate', 'media:state', 'screen:state']) {
      socket.on(event, (payload: unknown) => {
        const roomId = socket.data.roomId as string | undefined;
        if (roomId) socket.to(roomId).emit(event, { fromUserId: socket.data.user.uid, payload });
      });
    }

    socket.on('disconnect', () => leaveRoom(socket));
  });

  return io;
}

function leaveRoom(socket: Parameters<Parameters<Server['on']>[1]>[0]) {
  const roomId = socket.data.roomId as string | undefined;
  if (!roomId) return;
  socket.leave(roomId);
  socket.to(roomId).emit('room:participant-left', { userId: socket.data.user.uid });
  delete socket.data.roomId;
}
