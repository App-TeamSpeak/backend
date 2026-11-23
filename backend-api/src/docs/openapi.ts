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

const roomResponseContent = {
  'application/json': {
    schema: {
      type: 'object',
      required: ['success', 'data'],
      properties: {
        success: { type: 'boolean', enum: [true] },
        data: { $ref: '#/components/schemas/Room' },
      },
    },
  },
} as const;

const roomAccessErrors = {
  401: { description: 'Se requiere un token Bearer válido' },
  409: { description: 'PROFILE_INCONSISTENT' },
  503: { description: 'FIRESTORE_UNAVAILABLE' },
} as const;

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'TeamSpeak Study Room API',
    version: '0.1.0',
    description: 'API REST para autenticación, perfiles, salas de estudio y mensajes persistentes. Identidad autenticada no implica cuenta activa ni perfil completo: las rutas privadas rechazan cualquier marcador accountDeletions del UID, incluso completado o bloqueado. REST valida ID tokens Firebase sin solicitar comprobación global de revocación; los errores conocidos de red o cuota de Authentication responden 503 AUTH_UNAVAILABLE. Las lecturas de autorización Firestore comparten un plazo de 5 segundos por solicitud y fallan con 503 FIRESTORE_UNAVAILABLE; ese plazo no se aplica a transacciones o escrituras. Durante el apagado se rechazan nuevas solicitudes con 503 SERVER_STOPPED. Login, renovación y logout local corresponden al Firebase Client SDK; signOut no invalida inmediatamente los ID tokens ni desconecta Socket.IO. La eliminación real aún no está implementada; DELETE solo puede registrar intenciones en pruebas explícitamente aisladas.',
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
      EmailChangeRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['newEmail'],
        properties: {
          newEmail: { type: 'string', format: 'email', description: 'Nuevo correo electrónico normalizado en minúsculas.' },
        },
      },
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
        required: ['roomId', 'name', 'ownerId', 'createdAt', 'participants', 'connected'],
        properties: {
          roomId: { type: 'string', example: 'room_01HXYZ' },
          name: { type: 'string', minLength: 1, maxLength: 80, example: 'Algoritmos' },
          ownerId: { type: 'string', example: 'firebase-user-id' },
          createdAt: { type: 'string', format: 'date-time' },
          participants: { type: 'integer', minimum: 0 },
          connected: { type: 'integer', minimum: 0, description: 'Conteo de membresías mantenido por compatibilidad.' },
        },
      },
      Message: {
        type: 'object',
        required: ['id', 'roomId', 'authorId', 'text', 'createdAt'],
        properties: {
          id: { type: 'string', example: 'message_01HXYZ' },
          roomId: { type: 'string', example: 'room_01HXYZ' },
          authorId: { type: 'string', nullable: true, example: 'firebase-user-id', description: 'null cuando el autor eliminó su cuenta (authorDeleted=true).' },
          authorDeleted: { type: 'boolean', description: 'true si el autor eliminó su cuenta. Limitación: el texto del mensaje se conserva sin redacción automática.' },
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
        description: 'Incorporación permitida con correo aún no verificado. 200 con profileStatus incomplete y profile null si falta un perfil completo. No implica token inválido. Cache-Control: no-store.',
        responses: {
          403: { description: 'ACCOUNT_DELETION_PENDING, ACCOUNT_DELETION_BLOCKED o ACCOUNT_DELETED: la cuenta no puede acceder a recursos privados.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          200: { description: 'Estado del perfil', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserResponse' } } } },
          401: { description: 'AUTH_REQUIRED o AUTH_INVALID', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'PROFILE_INCONSISTENT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          500: { description: 'INTERNAL_ERROR', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          503: { description: 'AUTH_UNAVAILABLE o FIRESTORE_UNAVAILABLE', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['Users'], security: [{ bearerAuth: [] }], summary: 'Crea el perfil y reserva el username atómicamente',
        description: 'Incorporación permitida con correo aún no verificado. UID y email proceden del token Firebase. Si avatarUrl se omite al crear el perfil, se almacena null. Reintentos con los mismos datos normalizados devuelven 200 sin escrituras. Completa perfiles recuperables sin reemplazar campos existentes; responde 200 en recuperación. No actualiza perfiles completos. Cache-Control: no-store.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UserInput' } } } },
        responses: {
          403: { description: 'ACCOUNT_DELETION_PENDING, ACCOUNT_DELETION_BLOCKED o ACCOUNT_DELETED: la cuenta no puede acceder a recursos privados.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
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
        description: 'Requiere email_verified=true en el ID token; de lo contrario 403 EMAIL_NOT_VERIFIED. Solo nombre, apellido, username y avatarUrl (no admite email; usar POST /api/users/me/email-change + verifyBeforeUpdateEmail). Campos omitidos se conservan; omitir avatarUrl conserva el avatar actual y avatarUrl null lo elimina. El cambio de username mueve la reserva atómicamente. Mayúsculas solo cambian presentación. Valores equivalentes tras normalizar no generan escrituras ni cambian updatedAt. Requiere perfil completo (403 PROFILE_INCOMPLETE si falta o está incompleto) y reserva consistente. Cache-Control: no-store.',
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
          403: { description: 'PROFILE_INCOMPLETE, EMAIL_NOT_VERIFIED o ACCOUNT_DELETION_PENDING, ACCOUNT_DELETION_BLOCKED o ACCOUNT_DELETED: la cuenta no puede acceder a recursos privados.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          200: { description: 'Perfil actualizado o repetición sin cambios', content: { 'application/json': { schema: { $ref: '#/components/schemas/UserResponse' } } } },
          400: { description: 'VALIDATION_ERROR o INVALID_JSON', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'AUTH_REQUIRED o AUTH_INVALID', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'PROFILE_NOT_FOUND: el perfil desapareció después de autorizar la solicitud; completar registro mediante POST', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'USERNAME_TAKEN o PROFILE_INCONSISTENT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          500: { description: 'INTERNAL_ERROR', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          503: { description: 'AUTH_UNAVAILABLE o FIRESTORE_UNAVAILABLE', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Users'], security: [{ bearerAuth: [] }], summary: 'Solicita y ejecuta la eliminación definitiva y recuperable de la cuenta',
        description: 'Exige revocación y auth_time <= 300s (401 AUTH_RECENT_REQUIRED) para solicitudes nuevas; reintentos de una solicitud pending no exigen reautenticación. Acepta opcionalmente el header X-Deletion-Status-Token (32–128 caracteres URL-safe) generado previamente por el cliente para sobrevivir pérdida de respuesta HTTP; almacena únicamente su hash SHA-256 y nunca sobrescribe un comprobante vigente. Ejecuta fases pending -> cleanup -> auth -> completed con lease distribuido renovable. Reconciliador productivo habilitable vía TEAMSPEAK_ENABLE_DELETION_RECONCILER=true. No admite cuerpo. Cache-Control: no-store.',
        parameters: [
          { name: 'X-Deletion-Status-Token', in: 'header', required: false, schema: { type: 'string', minLength: 32, maxLength: 128 }, description: 'Comprobante opaco pre-generado por el cliente antes de enviar DELETE.' },
        ],
        responses: {
          200: { description: 'Cuenta eliminada definitivamente', content: { 'application/json': { schema: {
            type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['completed'] }, statusToken: { type: 'string' } } } },
          }, example: { success: true, data: { status: 'completed', statusToken: 'opaque-status-token' } } } } },
          202: { description: 'Eliminación en progreso (recuperable por reintento o reconciliador)', content: { 'application/json': { schema: {
            type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['pending'] }, statusToken: { type: 'string' } } } },
          }, example: { success: true, data: { status: 'pending', statusToken: 'opaque-status-token' } } } } },
          400: { description: 'VALIDATION_ERROR (cuerpo no permitido o X-Deletion-Status-Token inválido) o INVALID_JSON' },
          401: { description: 'AUTH_REQUIRED, AUTH_INVALID, AUTH_EXPIRED, AUTH_REVOKED, AUTH_USER_DISABLED, AUTH_USER_DELETED o AUTH_RECENT_REQUIRED' },
          409: { description: 'ACCOUNT_DELETION_BLOCKED, DELETION_STATUS_TOKEN_MISMATCH, ACCOUNT_DELETION_INCONSISTENT o PROFILE_INCONSISTENT' },
          503: { description: 'AUTH_UNAVAILABLE o FIRESTORE_UNAVAILABLE' },
          500: { description: 'INTERNAL_ERROR' },
        },
      },
    },
    '/api/users/me/deletion-status': {
      get: {
        tags: ['Users'],
        summary: 'Consulta segura del estado definitivo de eliminación',
        description: 'Permite verificar el resultado tras perder la respuesta HTTP o después de eliminar la identidad en Firebase Auth usando el header X-Deletion-Status-Token (o Bearer token mientras Auth siga activo). No expone datos privados ni permite enumeración.',
        parameters: [
          { name: 'X-Deletion-Status-Token', in: 'header', required: false, schema: { type: 'string' }, description: 'Token opaco devuelto por DELETE /api/users/me.' },
        ],
        responses: {
          200: { description: 'Estado de la solicitud de eliminación', content: { 'application/json': { schema: {
            type: 'object', required: ['success', 'data'], properties: { success: { type: 'boolean', enum: [true] }, data: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['none', 'pending', 'blocked', 'completed'] } } } },
          } } } },
          401: { description: 'AUTH_REQUIRED o AUTH_INVALID' },
          404: { description: 'DELETION_STATUS_NOT_FOUND' },
        },
      },
    },
    '/api/users/me/email-change': {
      post: {
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        summary: 'Valida elegibilidad previa para cambio seguro de correo',
        description: 'Valida revocación, autenticación reciente (auth_time <= 300s), política de proveedores (requiere password vinculado; cuentas solo Google reciben 403 EMAIL_CHANGE_NOT_ALLOWED) y unicidad en Firebase Auth/Firestore. No modifica Auth ni Firestore; el frontend debe invocar luego verifyBeforeUpdateEmail(user, newEmail) y conciliar con GET /api/users/me tras la confirmación.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EmailChangeRequest' },
            },
          },
        },
        responses: {
          200: { description: 'Solicitud elegible para iniciar verifyBeforeUpdateEmail en Firebase Client SDK' },
          400: { description: 'VALIDATION_ERROR o EMAIL_UNCHANGED', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'AUTH_REQUIRED, AUTH_INVALID, AUTH_EXPIRED, AUTH_REVOKED o AUTH_RECENT_REQUIRED', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'EMAIL_CHANGE_NOT_ALLOWED, EMAIL_NOT_VERIFIED, PROFILE_INCOMPLETE o ACCOUNT_DELETION_*', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'EMAIL_TAKEN o PROFILE_INCONSISTENT', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          500: { description: 'INTERNAL_ERROR', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          503: { description: 'AUTH_UNAVAILABLE o FIRESTORE_UNAVAILABLE', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/rooms': {
      get: {
        tags: ['Rooms'],
        security: [{ bearerAuth: [] }],
        summary: 'Lista las salas del usuario',
        responses: {
          409: { description: 'PROFILE_INCONSISTENT' }, 503: { description: 'FIRESTORE_UNAVAILABLE' },
          403: { description: 'PROFILE_INCOMPLETE, EMAIL_NOT_VERIFIED o ACCOUNT_DELETION_PENDING, ACCOUNT_DELETION_BLOCKED o ACCOUNT_DELETED: la cuenta no puede acceder a recursos privados.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, 501: { description: 'Ruta preparada; Firestore pendiente' }, 401: { description: 'No autenticado' } },
      },
      post: {
        tags: ['Rooms'],
        security: [{ bearerAuth: [] }],
        summary: 'Crea una sala de estudio',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 } } } } } },
        responses: {
          409: { description: 'PROFILE_INCONSISTENT' }, 503: { description: 'FIRESTORE_UNAVAILABLE' },
          403: { description: 'PROFILE_INCOMPLETE, EMAIL_NOT_VERIFIED o ACCOUNT_DELETION_PENDING, ACCOUNT_DELETION_BLOCKED o ACCOUNT_DELETED: la cuenta no puede acceder a recursos privados.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, 201: { description: 'Sala creada' }, 400: { description: 'Datos inválidos' }, 501: { description: 'Ruta preparada; Firestore pendiente' } },
      },
    },
    '/api/rooms/{roomId}': {
      parameters: [{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } }],
      get: { tags: ['Rooms'], security: [{ bearerAuth: [] }], summary: 'Obtiene una sala', responses: {
          409: { description: 'PROFILE_INCONSISTENT' }, 503: { description: 'FIRESTORE_UNAVAILABLE' },
          403: { description: 'PROFILE_INCOMPLETE, EMAIL_NOT_VERIFIED o ACCOUNT_DELETION_PENDING, ACCOUNT_DELETION_BLOCKED o ACCOUNT_DELETED: la cuenta no puede acceder a recursos privados.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, 501: { description: 'Ruta preparada' } } },
      patch: {
        tags: ['Rooms'],
        security: [{ bearerAuth: [] }],
        summary: 'Renombra una sala propia',
        requestBody: { required: true, content: { 'application/json': {
          schema: { type: 'object', required: ['name'], properties: {
            name: { type: 'string', minLength: 1, maxLength: 80, description: 'Se recortan los espacios exteriores.' },
          } },
        } } },
        responses: {
          ...roomAccessErrors,
          200: { description: 'Sala actualizada', content: roomResponseContent },
          400: { description: 'VALIDATION_ERROR: nombre inválido' },
          403: { description: 'ROOM_OWNER_REQUIRED o cuenta sin acceso a recursos privados' },
          404: { description: 'ROOM_NOT_FOUND' },

        },
      },
      delete: {
        tags: ['Rooms'],
        security: [{ bearerAuth: [] }],
        summary: 'Elimina una sala propia',
        description: 'Elimina la sala, sus membresías y sus mensajes. Realtime notifica a las conexiones activas de esa sala mediante room:access-revoked con { roomId, code: "ROOM_NOT_FOUND" }.',
        responses: {
          200: { description: 'Sala eliminada', content: { 'application/json': { schema: {
            type: 'object', required: ['success', 'data'], properties: {
              success: { type: 'boolean', enum: [true] }, data: {
                type: 'object', required: ['roomId'], properties: { roomId: { type: 'string' } },
              },
            },
          } } } },
          401: { description: 'Se requiere un token Bearer válido' },
          403: { description: 'ROOM_OWNER_REQUIRED o cuenta sin acceso a recursos privados' },
          404: { description: 'ROOM_NOT_FOUND' },
          409: { description: 'PROFILE_INCONSISTENT' },
          503: { description: 'FIRESTORE_UNAVAILABLE' },
        },
      },
    },
    '/api/rooms/{roomId}/join': {
      post: {
        tags: ['Rooms'],
        security: [{ bearerAuth: [] }],
        summary: 'Registra el acceso a una sala por su ID',
        description: 'Requiere una cuenta activa, correo verificado y perfil completo. Crea la membresía si falta. Después, el cliente inicia presencia con room:join en Realtime.',
        parameters: [{
          name: 'roomId', in: 'path', required: true,
          description: 'Se recortan los espacios exteriores antes de validar.',
          schema: { type: 'string', minLength: 1, maxLength: 128 },
        }],
        responses: {
          ...roomAccessErrors,
          200: { description: 'Membresía disponible', content: roomResponseContent },
          400: { description: 'VALIDATION_ERROR: identificador inválido' },
          403: { description: 'La cuenta no cumple los requisitos de acceso' },
          404: { description: 'ROOM_NOT_FOUND: la sala no existe' },

        },
      },
    },
    '/api/rooms/{roomId}/messages': {
      get: { tags: ['Messages'], security: [{ bearerAuth: [] }], summary: 'Obtiene el historial de chat', parameters: [{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } }], responses: {
          409: { description: 'PROFILE_INCONSISTENT' }, 503: { description: 'FIRESTORE_UNAVAILABLE' },
          403: { description: 'PROFILE_INCOMPLETE, EMAIL_NOT_VERIFIED o ACCOUNT_DELETION_PENDING, ACCOUNT_DELETION_BLOCKED o ACCOUNT_DELETED: la cuenta no puede acceder a recursos privados.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, 501: { description: 'Ruta preparada; Firestore pendiente' } } },
      post: { tags: ['Messages'], security: [{ bearerAuth: [] }], summary: 'Guarda un mensaje', parameters: [{ name: 'roomId', in: 'path', required: true, schema: { type: 'string' } }], responses: {
          409: { description: 'PROFILE_INCONSISTENT' }, 503: { description: 'FIRESTORE_UNAVAILABLE' },
          403: { description: 'PROFILE_INCOMPLETE, EMAIL_NOT_VERIFIED o ACCOUNT_DELETION_PENDING, ACCOUNT_DELETION_BLOCKED o ACCOUNT_DELETED: la cuenta no puede acceder a recursos privados.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, 501: { description: 'Ruta preparada; Firestore pendiente' } } },
    },
  },
} as const;
