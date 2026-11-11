# US-02 — Registro con Google: backend

## Objetivo y matriz de cobertura

Una identidad Firebase no constituye un perfil TeamSpeak. El acceso privado requiere identidad válida, cuenta activa, correo verificado y perfil completo persistido para el UID autenticado.

| Requisito | Existente al iniciar US-02 | Prueba existente | Cambio US-02 |
|---|---|---|---|
| Validar identidad Firebase | API `middleware/auth.ts`, Realtime `firebase-auth.service.ts` | Auth, HTTP, emuladores | Reutilizado; no OAuth alternativo |
| Bloquear cuentas en eliminación | Guards, observador y marcadores TS-01 | Unitarias, transporte e integración conjunta | Conservado |
| Correo verificado | Claim estricto `email_verified === true` US-01 | Middleware, handshake y enlace nativo en emulador | Conservado; antes del guard de perfil |
| Consultar incorporación | GET `/api/users/me`, `getUserProfile` | Perfiles y HTTP US-01 | Conservado sin exigir perfil completo |
| Completar incorporación | POST `/api/users/me`, validador estricto | HTTP e integración transaccional | Reutilizado |
| Username único | Transacción `users/{uid}` + `usernames/{usernameKey}` | Concurrencia Firestore | Sin nueva reserva ni esquema |
| Denegar acceso sin perfil | No había guard general | Validación de lectura sí existente | Nuevo middleware API y comprobación de handshake |
| Distinguir inconsistencia e infraestructura | API `PROFILE_INCONSISTENT`, `FIRESTORE_UNAVAILABLE` | Servicio de usuarios | Reutilizado; errores controlados equivalentes en Realtime |
| Google primer acceso y recurrente | Firebase Client SDK es responsabilidad frontend | Integración anterior con password | Nuevos casos `signInWithIdp` Google en Auth Emulator |
| Cancelación y conflicto | Identidad sin perfil permitida, transacciones existentes | Generales de perfiles | Nuevos casos específicos Google |
| Inicio interactivo Google | Firebase Authentication / frontend / Firebase Console | No es parte de este backend | Pendiente integración frontend y configuración real del proveedor |

Las rutas se evalúan en orden: autenticación, cuenta activa, correo verificado y perfil completo. GET/POST de incorporación conservan solo las dos primeras condiciones. DELETE mantiene su circuito previo, exclusivamente para pruebas aisladas.

## Flujo y contratos reutilizados

Frontend inicia Google mediante Firebase Client SDK y obtiene un **Firebase ID token**, no envía directamente un Google access token a esta API. Backend valida el token; UID y correo proceden de la identidad autenticada. Nombre/fotografía de Google pueden prellenar el formulario, pero siguen sujetos al validador del POST. No se aceptan UID, correo, contraseña o `profileStatus` en el cuerpo.

1. GET `/api/users/me`: `200`, `data: { uid, profileStatus: 'incomplete', profile: null }` si no existe perfil completo. Un documento malformado produce `409 PROFILE_INCONSISTENT`.
2. Frontend presenta nombre, apellido y username obligatorios; avatar HTTPS opcional. Username: 8–30 caracteres ASCII, letras/números/`-`/`_`. Se conserva la presentación y se reserva la clave en minúsculas transaccionalmente.
3. POST `/api/users/me`: `201` al crear, `200` para repetición idempotente o recuperación compatible; `409 USERNAME_TAKEN` ante conflicto. Omitir avatar almacena `null`. No se crea perfil ni reserva solo por autenticar Google.
4. GET confirma `complete`; PATCH y rutas privadas admiten acceso si se cumplen las demás condiciones. Las rutas REST de salas/mensajes siguen siendo provisionales (`501`); US-02 verifica autorización, sin implementar esas historias.
5. Socket.IO recibe `{ token: firebaseIdToken }`. Valida revocación, cuenta activa, correo y perfil antes de registrar sesión/observador. Username no se toma del handshake.

En una sesión recurrente, Firebase conserva el UID: GET devuelve el mismo perfil y username; no hay nuevo POST obligatorio ni reserva duplicada. Si se interrumpe la incorporación, la identidad permanece incompleta, sin acceso privado ni reserva huérfana; al regresar puede completar el POST. No se eliminan identidades automáticamente.

## Autorización y errores

| Estado | API privada | Socket.IO handshake |
|---|---|---|
| Token ausente/inválido | `401 AUTH_REQUIRED/AUTH_INVALID` | `AUTH_REQUIRED/AUTH_INVALID` |
| Cuenta en eliminación | Errores TS-01 conservados | `ACCOUNT_UNAVAILABLE` |
| Correo no verificado | `403 EMAIL_NOT_VERIFIED` | `EMAIL_NOT_VERIFIED` |
| Perfil ausente/incompleto | `403 PROFILE_INCOMPLETE` | `PROFILE_INCOMPLETE` |
| Perfil inconsistente | `409 PROFILE_INCONSISTENT` | `PROFILE_INCONSISTENT` |
| Fallo de lectura | `503 FIRESTORE_UNAVAILABLE` para fallos transitorios conocidos; otros errores internos conservan `500` | `AUTHORIZATION_UNAVAILABLE` |

PATCH sin perfil pasa a `403 PROFILE_INCOMPLETE` en la autorización, sustituyendo su anterior `404 PROFILE_NOT_FOUND` de servicio. El servicio interno sigue preservando sus errores ante carreras posteriores al guard, incluido 404 si el perfil desaparece entre autorización y transacción. OpenAPI refleja la autorización nueva. GET/POST no quedan atrapados por el guard.

API reutiliza `getUserProfile`, incluida la validación autoritativa y el bloqueo de cuenta. Esto añade la lectura de perfil y repite la lectura de marcador existente; se prioriza reutilización sobre refactorizar TS-01. Realtime usa una operación de lectura encapsulada que valida configuración antes y después de la lectura SDK; no recibe clientes arbitrarios. Su esquema persistido coincide con el contrato API, sin importar módulos del otro servicio ni crear un paquete compartido.

Solo `profileStatus: complete` no basta: se validan UID, correo, nombres, username/clave consistente, avatar y timestamps. No se consulta la reserva en cada autorización; la integridad de reservas depende de las transacciones existentes y las Security Rules cerradas para clientes.

## Conexiones establecidas

Se comprueba perfil completo en el handshake. PATCH conserva los campos obligatorios y no permite cambiar el estado a incomplete. La eliminación crea el marcador antes de limpiar el perfil y el observador desconecta sesiones. Los ocho eventos siguen sus guards TS-01, con dos autorizaciones por socket y 64 por instancia, sin cola ilimitada. No se agrega lectura de perfil por evento ni otra suscripción.

Una modificación administrativa externa que borre/corrompa un perfil sin marcador no desconecta inmediatamente una sesión existente. Se detecta en la siguiente conexión y en solicitudes HTTP privadas. Si se introduce una operación futura que pueda degradar un perfil, debe diseñar su invalidación de sesiones. El correo continúa comprobándose en handshake como en US-01.

## Responsabilidades frontend y configuración

Frontend debe integrar Firebase Client SDK Google, recuperar/refrescar ID token, consultar GET, mostrar incorporación obligatoria, enviar POST, resolver conflictos y errores, y redirigir a la aplicación solo con perfil completo. Debe presentar avatar predeterminado si `avatarUrl` es null. El enlace de verificación y actualización del token siguen el contrato US-01 cuando el correo no esté verificado. Ningún proveedor omite esa condición.

Firebase Console requiere proveedor Google habilitado y dominios autorizados. No se ha modificado ni verificado Firebase real. La política efectiva de contraseñas de US-01 sigue pendiente de evidencia de configuración y no se cambia aquí.

## Pruebas reproducibles y alcance

Node.js 24 (usado: 24.18.0), dependencias ya instaladas. Por servicio: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage`.

Desde raíz: `node integration-ts01/run.cjs`. Reutiliza el lanzador existente y añade casos US-02 sin eliminar TS-01/US-01. Requiere Firebase CLI y Java 21; `TEAMSPEAK_FIREBASE_CLI` permite ruta local. El launcher reserva puertos, usa exclusivamente `demo-teamspeak-tests`, limpia el entorno, desactiva dotenv real, bloquea transportes remotos y cierra recursos propios. No ejecutar suites de emuladores simultáneamente.

Regresiones adicionales: en API `npm run test:integration` y `npm run test:integration:deletion`; en Realtime `node scripts/firebase-integration.cjs`. No se cambian dependencias, reglas, despliegue ni banderas de seguridad.

Los casos Google usan `accounts:signInWithIdp` con credencial Google sintética sin firma, aceptada exclusivamente por Authentication Emulator. Se verifica el proveedor `google.com` emitido por Firebase, UID recurrente, perfil, reservas y acceso HTTP/WebSocket reales. Esto prueba el flujo de proveedor del emulador, **no** OAuth interactivo real ni la integración frontend. Referencias: [Authentication Emulator](https://firebase.google.com/docs/emulator-suite/connect_auth), [Firebase Auth REST](https://firebase.google.com/docs/reference/rest/auth).

Las unitarias usan mocks de las operaciones SDK para errores y tiempos límite; las integraciones usan ambos SDK y emuladores reales. El nuevo Quality Gate remoto de US-02 no se ha ejecutado ni se declara aprobado.

Resultados de esta ejecución se registran al finalizar las verificaciones.

## Evidencia final local

Todas las verificaciones finales aprobaron con Node.js 24.18.0:

| Grupo | Pruebas aprobadas |
|---|---:|
| API unitarias/HTTP | 351 |
| Realtime unitarias/HTTP/transporte | 170 |
| Integración conjunta TS-01/US-01/US-02 | 19 |
| API Firestore | 31 |
| API Authentication + Firestore / eliminación | 33 |
| Realtime Authentication + Firestore | 22 |
| Security Rules | 35 |
| Total distinto, sin contar repeticiones | 661 |

Se añadieron 37 casos: 10 API, 22 Realtime unitarios, cuatro conjuntos Google y uno Realtime con emuladores. No se eliminaron pruebas anteriores. El ajuste de expectativa OpenAPI y las fixtures completas de Realtime reflejan el nuevo guard, sin eliminar las aserciones previas de acceso, eliminación o concurrencia.

| Cobertura V8 global | Instrucciones/líneas | Ramas | Funciones |
|---|---:|---:|---:|
| API | 97,43 % | 91,25 % | 88,04 % |
| Realtime | 97,61 % | 91,31 % | 95,08 % |

Lint, typecheck y build de ambos servicios: correctos. La primera ejecución API detectó una expectativa documental antigua de PATCH; se corrigió y la suite final completa aprobó. Las 19 conjuntas acreditan HTTP y WebSocket reales contra los mismos emuladores; los casos de infraestructura/timeout unitarios usan mocks. No hay evidencia de OAuth interactivo real ni análisis Sonar remoto de US-02.

## Archivos de la entrega

Nuevos:

- `backend-api/src/middleware/complete-profile.ts`
- `backend-api/src/middleware/complete-profile.test.ts`
- `backend-realtime/src/services/profile-state.service.ts`
- `backend-realtime/src/services/profile-state.service.test.ts`
- `docs/us-02-backend.md`

Modificados:

- `backend-api/src/routes/api.routes.ts`
- `backend-api/src/routes/users.routes.ts`
- `backend-api/src/controllers/users.http.test.ts`
- `backend-api/src/middleware/email-verified.test.ts`
- `backend-api/src/docs/openapi.ts`
- `backend-api/src/docs/openapi.test.ts`
- `backend-realtime/src/config/firebase.ts`
- `backend-realtime/src/config/firebase-auth-boundary.test.ts`
- `backend-realtime/src/config/firebase.lifecycle.test.ts`
- `backend-realtime/src/realtime/socket.ts`
- `backend-realtime/src/realtime/socket.test.ts`
- `backend-realtime/src/integration/firebase.integration.ts`
- `backend-realtime/README.md`
- `integration-ts01/ts01.test.cjs`

Base: `020618a4dbd5f7c44bc48103b86b6df96c29f21d`, rama `feat/us-02-registro-google`. Sin commits ni publicación. Se recomienda revisión técnica antes de autorizar el primer commit. Esquemas de lectura API/Realtime deben mantenerse alineados cuando evolucione el modelo; no se introdujo un paquete compartido para esta historia.

Cierre verificado: todos los lanzadores finalizaron con código 0; sin listeners activos en los puertos de las suites ni procesos propios de emulador/runner restantes. Una comprobación inicial mediante bind detectó una conexión residual TCP en 28081; la comprobación de listeners con conexión y `ss` confirmó que no había servidor activo. No se detuvieron contenedores ni servicios ajenos.

Estado Git final: 14 archivos modificados y cinco nuevos, sin archivos preparados. Frontend limpio; sin cambios en dependencias, lockfiles, entornos o credenciales. `git diff --check` correcto.
