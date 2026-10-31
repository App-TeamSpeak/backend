export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'TeamSpeak Realtime Gateway',
    version: '0.1.0',
    description: 'Health check HTTP del gateway y referencia de eventos Socket.IO/WebRTC.',
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
