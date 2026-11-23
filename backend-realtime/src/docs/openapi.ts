export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'TeamSpeak Realtime Gateway',
    version: '0.1.0',
    description: 'Health check HTTP del gateway y referencia de eventos Socket.IO/WebRTC. Eventos Socket.IO: room:join ({ roomId }) recorta y valida roomId y revalida acceso en Firestore en cada ingreso/reingreso; room:leave (); chat:send ({ text }) revalida acceso antes de persistir; webrtc:offer/answer/ice-candidate, media:state y screen:state retransmiten solo en sala activa. Eventos emitidos al cliente: room:joined ({ roomId, participants }) con los UID únicos presentes, room:participant-joined ({ userId }), room:participant-left ({ userId }), chat:message ({ messageId, authorId, text, createdAt }), room:access-revoked ({ roomId, code: "ROOM_NOT_FOUND" | "ROOM_ACCESS_DENIED" }) cuando la sala se elimina o se revoca la membresía en vivo, y error:message ({ code, message }).',
  },
  paths: {
    '/': {
      get: {
        summary: 'Comprueba que el gateway responde en la ruta raíz',
        responses: { 200: { description: 'Servicio disponible' } },
      },
    },
    '/health': {
      get: {
        summary: 'Comprueba que el gateway responde',
        responses: { 200: { description: 'Servicio disponible' } },
      },
    },
  },
} as const;
