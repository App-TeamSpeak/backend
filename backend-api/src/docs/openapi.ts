const userInputProperties = {
          nombre: { type: 'string', description: 'Se recortan espacios exteriores. El valor recortado debe tener 1–100 caracteres y no estar vacío.' },
          apellido: { type: 'string', description: 'Se recortan espacios exteriores; el valor resultante debe tener 1–100 caracteres y no estar vacío.' },
          username: { type: 'string', pattern: '^\\s*[A-Za-z0-9_-]{8,30}\\s*$', description: 'Se recortan espacios exteriores; letras ASCII, números, - y _. Conserva mayúsculas para mostrar; unicidad sin distinguir mayúsculas mediante usernameKey.' },
          avatarUrl: { type: 'string', nullable: true, description: 'URL HTTPS válida después de recortar espacios exteriores, máximo 2048 caracteres normalizados.' },
        } as const;

const userProfileSchema = {
        type: 'object', required: ['uid', 'email', 'nombre', 'apellido', 'username', 'usernameKey', 'avatarUrl', 'profileStatus', 'createdAt', 'updatedAt'],
        properties: {
          uid: { type: 'string' }, email: { type: 'string', format: 'email' },
          nombre: { type: 'string' }, apellido: { type: 'string' },
          username: { type: 'string' }, usernameKey: { type: 'string' },
          avatarUrl: { type: 'string', nullable: true, format: 'uri' },
          profileStatus: { type: 'string', enum: ['complete'] },
          createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
        },
      } as const;

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
          details: { type: 'array', items: { type: 'object' }, description: 'Detalles de validación cuando corresponde.' },
          message: { type: 'string', example: 'Se requiere un token Bearer válido.' },
        },
      },
      UserInput: {
        type: 'object', additionalProperties: false, required: ['nombre', 'apellido', 'username'],
        properties: userInputProperties,
      },
      UserPatch: { type: 'object', additionalProperties: false, minProperties: 1, properties: userInputProperties },
      UserProfile: userProfileSchema,
      UserResponse: {
        type: 'object', required: ['success', 'data'],
        properties: {
          success: { type: 'boolean', enum: [true] },
          data: {
            type: 'object', required: ['uid', 'profileStatus', 'profile'],
            properties: {
              uid: { type: 'string' }, profileStatus: { type: 'string', enum: ['complete', 'incomplete'] },
              profile: { ...userProfileSchema, nullable: true, description: 'null si no existe un perfil completo recuperable; documentos inconsistentes producen 409.' },
            },
          },
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
        tags: ['Users'], security: [{ bearerAuth: [] }], summary: 'Consulta el perfil de la identidad autenticada',
        description: '200 con profileStatus incomplete y profile null si falta un perfil completo. No implica token inválido. Cache-Control: no-store.',
        responses: {
          200: { description: 'Estado del perfil', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserResponse' } } } },
          401: { description: 'AUTH_REQUIRED o AUTH_INVALID', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'PROFILE_INCONSISTENT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          500: { description: 'INTERNAL_ERROR', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          503: { description: 'AUTH_UNAVAILABLE o FIRESTORE_UNAVAILABLE', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['Users'], security: [{ bearerAuth: [] }], summary: 'Crea el perfil y reserva el username atómicamente',
        description: 'UID y email proceden del token Firebase. Si avatarUrl se omite al crear el perfil, se almacena null. Reintentos con los mismos datos normalizados devuelven 200 sin escrituras. Completa perfiles recuperables sin reemplazar campos existentes; responde 200 en recuperación. No actualiza perfiles completos. Cache-Control: no-store.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UserInput' } } } },
        responses: {
          201: { description: 'Perfil creado', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserResponse' } } } },
          200: { description: 'Reintento idempotente o perfil incompleto recuperado', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserResponse' } } } },
          400: { description: 'VALIDATION_ERROR, INVALID_JSON o AUTH_EMAIL_REQUIRED', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'AUTH_REQUIRED o AUTH_INVALID', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'USERNAME_TAKEN, PROFILE_ALREADY_EXISTS o PROFILE_INCONSISTENT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          500: { description: 'INTERNAL_ERROR', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          503: { description: 'AUTH_UNAVAILABLE o FIRESTORE_UNAVAILABLE', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      patch: {
        tags: ['Users'], security: [{ bearerAuth: [] }], summary: 'Actualiza parcialmente el perfil autenticado',
        description: 'Solo nombre, apellido, username y avatarUrl. Campos omitidos se conservan; omitir avatarUrl conserva el avatar actual y avatarUrl null lo elimina. El cambio de username mueve la reserva atómicamente. Mayúsculas solo cambian presentación. Valores equivalentes tras normalizar no generan escrituras ni cambian updatedAt. Requiere perfil completo y reserva consistente. Cache-Control: no-store.',
        requestBody: {
          required: true, content: { 'application/json': {
            schema: { $ref: '#/components/schemas/UserPatch' },
            examples: {
              nombre: { value: { nombre: 'Ana María' } },
              varios: { value: { nombre: 'Ana María', apellido: 'Pérez', username: 'Ana-User2', avatarUrl: null } },
              quitarAvatar: { value: { avatarUrl: null } },
            },
          } },
        },
        responses: {
          200: { description: 'Perfil actualizado o repetición sin cambios', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserResponse' } } } },
          400: { description: 'VALIDATION_ERROR o INVALID_JSON', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'AUTH_REQUIRED o AUTH_INVALID', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'PROFILE_NOT_FOUND: completar registro mediante POST', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'USERNAME_TAKEN, PROFILE_INCOMPLETE o PROFILE_INCONSISTENT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          500: { description: 'INTERNAL_ERROR', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          503: { description: 'AUTH_UNAVAILABLE o FIRESTORE_UNAVAILABLE', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
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
