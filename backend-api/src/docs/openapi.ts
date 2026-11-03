export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'TeamSpeak Study Room API',
    version: '0.1.0',
    description: 'API REST para autenticación, perfiles, salas de estudio y mensajes persistentes.',
  },
  servers: [{ url: '/', description: 'Servidor actual' }],
  tags: [
    { name: 'Health', description: 'Disponibilidad del servicio' },
    { name: 'Sprint 0', description: 'Evidencia de verificación de Firestore' },
    { name: 'Users', description: 'Perfil y cuenta del estudiante' },
    { name: 'Rooms', description: 'Salas de estudio colaborativo' },
    { name: 'Messages', description: 'Historial persistente de chat' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['success', 'code', 'message'],
        properties: {
          success: { type: 'boolean', example: false },
          code: { type: 'string', example: 'AUTH_REQUIRED' },
          message: { type: 'string', example: 'Se requiere un token Bearer válido.' },
        },
      },
      Room: {
        type: 'object',
        required: ['id', 'name', 'ownerId'],
        properties: {
          id: { type: 'string', example: 'room_01HXYZ' },
          name: { type: 'string', minLength: 1, maxLength: 80, example: 'Algoritmos' },
          ownerId: { type: 'string', example: 'firebase-user-id' },
        },
      },
      Message: {
        type: 'object',
        required: ['id', 'roomId', 'authorId', 'text', 'createdAt'],
        properties: {
          id: { type: 'string', example: 'message_01HXYZ' },
          roomId: { type: 'string', example: 'room_01HXYZ' },
          authorId: { type: 'string', example: 'firebase-user-id' },
          text: { type: 'string', maxLength: 2000, example: '¿Revisamos el ejercicio 3?' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/': {
      get: {
        tags: ['Health'],
        summary: 'Comprueba que la API responde en la ruta raíz',
        responses: { 200: { description: 'Servicio disponible' } },
      },
    },
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Comprueba que la API responde',
        responses: { 200: { description: 'Servicio disponible' } },
      },
    },
    '/api/sprint0/demo': {
      get: {
        tags: ['Sprint 0'],
        summary: 'Devuelve el documento de verificación de Sprint 0',
        description: 'Consulta sprint_prueba/verificacion_sprint0 en Firestore.',
        responses: {
          200: { description: 'Documento encontrado' },
          404: { description: 'Documento no encontrado' },
          503: { description: 'Firestore no disponible' },
        },
      },
    },
    '/api/users/me': {
      get: {
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        summary: 'Obtiene el perfil autenticado',
        responses: { 501: { description: 'Ruta preparada; persistencia pendiente' }, 401: { description: 'No autenticado' } },
      },
      patch: {
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        summary: 'Actualiza el perfil autenticado',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 501: { description: 'Ruta preparada; persistencia pendiente' }, 401: { description: 'No autenticado' } },
      },
      delete: {
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        summary: 'Elimina la cuenta autenticada',
        responses: { 501: { description: 'Ruta preparada; eliminación pendiente' }, 401: { description: 'No autenticado' } },
      },
    },
    '/api/rooms': {
      get: {
        tags: ['Rooms'],
        security: [{ bearerAuth: [] }],
        summary: 'Lista las salas del usuario',
        responses: { 501: { description: 'Ruta preparada; Firestore pendiente' }, 401: { description: 'No autenticado' } },
      },
      post: {
        tags: ['Rooms'],
        security: [{ bearerAuth: [] }],
        summary: 'Crea una sala de estudio',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 } } } } } },
        responses: { 201: { description: 'Sala creada' }, 400: { description: 'Datos inválidos' }, 501: { description: 'Ruta preparada; Firestore pendiente' } },
      },
    },
    '/api/rooms/{roomId}': {
      parameters: [{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } }],
      get: { tags: ['Rooms'], security: [{ bearerAuth: [] }], summary: 'Obtiene una sala', responses: { 501: { description: 'Ruta preparada' } } },
      patch: { tags: ['Rooms'], security: [{ bearerAuth: [] }], summary: 'Edita una sala propia', responses: { 501: { description: 'Ruta preparada' }, 403: { description: 'Sin permisos' } } },
      delete: { tags: ['Rooms'], security: [{ bearerAuth: [] }], summary: 'Elimina una sala propia', responses: { 501: { description: 'Ruta preparada' }, 403: { description: 'Sin permisos' } } },
    },
    '/api/rooms/{roomId}/join': {
      post: { tags: ['Rooms'], security: [{ bearerAuth: [] }], summary: 'Se une a una sala', parameters: [{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 501: { description: 'Ruta preparada' }, 404: { description: 'Sala no encontrada' } } },
    },
    '/api/rooms/{roomId}/messages': {
      get: { tags: ['Messages'], security: [{ bearerAuth: [] }], summary: 'Obtiene el historial de chat', parameters: [{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 501: { description: 'Ruta preparada; Firestore pendiente' } } },
      post: { tags: ['Messages'], security: [{ bearerAuth: [] }], summary: 'Guarda un mensaje', parameters: [{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 501: { description: 'Ruta preparada; Firestore pendiente' } } },
    },
  },
} as const;
