# US-03 — Inicio y cierre de sesión: Backend

## Alcance y criterios encontrados

La solicitud de US-03 exige reutilizar Firebase Client SDK para Email/Password y Google, validar ID tokens en backend, conservar incorporación/autorización y documentar login/logout. No se encontró una definición completa adicional de criterios de aceptación en los documentos versionados del backend. Se consultaron README y código frontend solo como referencia: `src/services/auth.ts` es un mock local que admite correo o username, no un contrato aprobado ni autenticación Firebase real. No se implementa resolución username→correo; queda pendiente de decisión funcional expresa por sus riesgos de enumeración.

Requisitos documentados: identidad válida → cuenta activa → correo verificado → perfil completo, GET/POST de incorporación disponibles, revocación en handshake, renovación por Client SDK, logout local con desconexión explícita. Requisito técnico inferido: distinguir indisponibilidad de Auth de credenciales inválidas sin filtrar detalles. Decisiones pendientes: revocación REST en cada petición, cierre global de sesiones y login por username. No se decide ninguna de ellas implícitamente.

## Matriz previa a implementación

| Requisito | Implementación actual | Prueba existente | Falta implementar/verificar | Responsable |
|---|---|---|---|---|
| Login Email/Password | Firebase Client SDK; backend recibe Bearer | Integración US-01 | Sesión recurrente, token nuevo y logout observable | Frontend/Firebase; pruebas Backend |
| Login Google | US-02, ID token Firebase + perfil | Cuatro casos Google conjuntos | Sesiones Google en recorrido específico US-03 | Frontend/Firebase; pruebas Backend |
| Token ausente/inválido/expirado/proyecto distinto | `requireAuth` + Admin SDK | HTTP auth parcial | Matriz explícita y SDK real en emulador | API |
| Indisponibilidad Auth | Configuración→503; errores de verificación→401 indiscriminado | Configuración ausente | Mapear errores de red/cuota conocidos a `503 AUTH_UNAVAILABLE` | API |
| Revocación REST | `verifyIdToken(token)` sin flag explícito | Contrato previo | Documentar política y particularidad del emulador; no activar globalmente | Decisión de equipo / API |
| Revocación handshake | `verifyToken(token, true)` | Unitarias y emuladores TS-01 | Conservar y ampliar expiración/sesión | Realtime |
| Cuenta activa/correo/perfil | Guards US-01/02 y marcadores TS-01 | Unitarias y conjuntos | Regresiones sin debilitar excepciones | API/Realtime |
| Renovación | Firebase Client SDK | Refresh nativo US-01 | Token nuevo conserva UID/perfil sin POST | Frontend/Firebase; pruebas Backend |
| Logout | No endpoint; desconexión y limpieza Socket.IO existentes | Cierre/transporte TS-01 | Desconexión voluntaria, nueva sesión, conexión dejada activa | Frontend y pruebas Realtime |
| Ocho eventos y límites 2/64 | Guards y supervisión existentes | Ráfagas, eventos, observers | Conservar regresiones | Realtime |
| Persistencia de sesión y formularios | Mock frontend, no Firebase integrado | Pruebas UI de mock | Implementación Client SDK y coordinación | Frontend |
| Proveedores/política contraseña real | Configuración externa no acreditada | Emuladores no acreditan producción | Evidencia de Console; sin cambios aquí | Equipo Firebase Console |

## Decisiones técnicas

Se conserva `verifyIdToken(token)` en REST: no hay requisito aprobado de revocación global inmediata. Cambiar a `true` añade una consulta de estado de cuenta, latencia y dependencia de disponibilidad de Authentication por solicitud. Es una alternativa de endurecimiento a aprobar con el equipo; no equivale a logout local y no se introduce caché ni blacklist propia. Realtime conserva `true` en cada nuevo handshake.

Importante: el SDK Admin instalado (`lib/auth/base-auth.js`, `verifyIdToken`) comprueba estado/revocación cuando `checkRevoked || isEmulator`. Por tanto, el emulador es más estricto que la política REST productiva sin flag. Un rechazo de token revocado/deshabilitado en esa integración **no demuestra** revocación REST inmediata en producción. La prueba unitaria acredita que se sigue llamando sin el segundo argumento.

Se corrige únicamente el mapeo de errores conocidos de transporte/cuota de Auth a 503. Tokens inválidos/expirados y rechazos de identidad conservan `401 AUTH_INVALID`, sin exponer códigos internos. No hay endpoints login/logout/refresh, contraseñas recibidas por perfiles, cookies, JWT ni refresh tokens propios.

## Arquitectura y contratos

Email/Password: formulario → Firebase Client SDK → Firebase ID token → `Authorization: Bearer <token>` → API. Google: Client SDK Google/Firebase → ID token Firebase → el mismo recorrido. Un access token Google no sustituye al ID token. UID/correo y `email_verified` proceden del token verificado; campos del cliente no los sustituyen.

GET `/api/users/me` devuelve el estado de incorporación; POST completa el perfil con reserva transaccional. Ambos exigen identidad y cuenta activa, aunque el correo no esté verificado o falte perfil. PATCH y salas/mensajes privados exigen además correo verificado y perfil completo. Las rutas de salas/mensajes siguen siendo provisionales; alcanzar 501 acredita haber superado sus guards, no una funcionalidad de otra historia.

Socket.IO recibe `{token: firebaseIdToken}` y comprueba revocación, cuenta activa, correo y perfil antes de admitir. Los ocho eventos mantienen guards por marcador y límites de dos operaciones por socket/64 por instancia. El observador desconecta cuentas en eliminación; no supervisa revocación global, expiración del token o cambios arbitrarios del perfil en una sesión ya admitida.

### Errores REST

- 401 `AUTH_REQUIRED`: sin credencial Bearer reconocida o vacía. El parser existente exige prefijo `Bearer ` y recorta espacios exteriores del token.
- 401 `AUTH_INVALID`: ID token inválido, vencido o de otro proyecto; rechazos de identidad emitidos por el SDK. Sin detalles de credenciales.
- 503 `AUTH_UNAVAILABLE`: configuración Auth ausente o error conocido de red/timeout/cuota durante verificación.
- 403 `EMAIL_NOT_VERIFIED`, `PROFILE_INCOMPLETE` y errores de cuenta TS-01: condiciones de autorización independientes.
- 409 `PROFILE_INCONSISTENT`: datos persistidos incoherentes.
- Fallos Firestore conservan sus errores 503/500 y nunca conceden acceso.

Handshake conserva `AUTH_REQUIRED`, `AUTH_INVALID`, `AUTHORIZATION_UNAVAILABLE`, `ACCOUNT_UNAVAILABLE`, `EMAIL_NOT_VERIFIED`, `PROFILE_INCOMPLETE` y `PROFILE_INCONSISTENT`. No se cambian sus contratos.

## Vigencia, renovación y logout

El SDK verifica vigencia, firma en modo real, audiencia e issuer. Los emuladores admiten tokens sin firma: no son evidencia de validación criptográfica real. Firebase Client SDK renueva ID tokens; backend acepta tokens válidos nuevos para el mismo UID sin recrear perfil ni reservas.

`signOut()` es local al cliente y no constituye una revocación administrativa global. Frontend debe dejar de enviar el token, desconectar Socket.IO, limpiar datos sensibles y redirigir. Backend no recibe una notificación automática de signOut; un socket dejado conectado mantiene el acceso según sus guards. No se implementa endpoint logout ni se declara invalidación inmediata de todos los ID tokens. Un token robado puede seguir siendo utilizable hasta expirar bajo la política actual; nunca debe registrarse en logs.

Desconexión voluntaria: Socket.IO elimina pertenencias y el observador se libera al salir la última sesión. Reconexión requiere token y condiciones válidas otra vez. Logout/reconexión no escribe ni duplica el perfil. Eliminación y sus marcadores son otra operación, no un mecanismo de logout; DELETE sigue restringido a pruebas y no se usa en la validación US-03.

Referencias oficiales: [verificación de ID tokens](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [sesiones y revocación](https://firebase.google.com/docs/auth/admin/manage-sessions), [Authentication Emulator](https://firebase.google.com/docs/emulator-suite/connect_auth).

## Responsabilidades frontend y configuración pendiente

Frontend implementa formularios, Email/Password y Google Client SDK, persistencia de sesión apropiada, renovación de ID token, manejo de errores, signOut, desconexión Socket.IO y redirecciones por correo/perfil. Al renovar el token debe actualizar Bearer y el token de reconexión. No se modificó frontend ni su mock; no se almacena ninguna contraseña en este backend. Configuración real de proveedores, dominios y política de contraseñas requiere evidencia autorizada externa. Recuperación de contraseña queda fuera de esta historia.

## Observaciones heredadas

Siguen presentes, sin corregirse en US-03: P3 de OpenAPI que omite `409 PROFILE_INCOMPLETE` residual de PATCH durante una carrera; P3 de fixture Realtime con reserva `{uid}` sin `usernameKey`. No afectan el alcance de sesiones ni justifican ampliar esta entrega.

## Validación

Resultados y limitaciones de ejecución se detallan a continuación. Las 661 pruebas de US-02 son solo referencia histórica; no se presentan como ejecución US-03. No se declara aprobado Sonar de US-03 sin análisis remoto.

### Ejecución reproducible

Node 24.18.0 mediante NVM, dependencias existentes, Java 21 y Firebase CLI ya disponibles. No se instaló ninguna dependencia.

Desde la raíz:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
# Con Java 21 y firebase en PATH:
node integration-ts01/run.cjs --login
node --test integration-ts01/run.test.cjs
```

`TEAMSPEAK_FIREBASE_CLI` permite seleccionar una CLI ya instalada; Java 21 puede seleccionarse mediante PATH. El JAR existente debe estar en `/tmp/teamspeak-integration-tools/emulators/cloud-firestore-emulator-v1.22.0.jar`. No hay descargas automáticas autorizadas. Para esta ejecución se usaron herramientas temporales ya disponibles en `/tmp/teamspeak-integration-tools`.

Por servicio: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage`.

El modo `--login` no cambia la suite principal: selecciona un archivo fijo de sesiones y conserva la supervisión, recibos de finalización, timeout y cierre de grupos de procesos del lanzador. Sin `--login`, la suite TS-01 conserva su comportamiento previo, incluido el procesamiento de eliminación; **no se ejecutó en US-03**.

La ejecución usa exclusivamente `demo-teamspeak-tests`, Auth `127.0.0.1:19099`, Firestore `127.0.0.1:18081`, API 19801 y Realtime en puerto efímero. El lanzador reserva sus puertos y falla si están ocupados; no usa emuladores compartidos ni detiene otros servicios. El entorno está saneado, `NODE_ENV=test`, `DOTENV_CONFIG_PATH=/dev/null`, sin credenciales reales ni ADC. Se reutilizan las banderas internas de aislamiento que requiere la inicialización Firebase existente, pero no se invoca DELETE, el procesador ni el conciliador. La suite bloquea solicitudes HTTP DELETE y transportes remotos. Solo crea/actualiza fixtures únicas; los cambios de disabled/revocación afectan exclusivamente identidades ficticias del emulador. Eliminar aplicaciones Admin en el cierre solo libera recursos locales, no identidades.

### Resultados anteriores a la corrección P2

| Grupo ejecutado en US-03 | Aprobadas |
|---|---:|
| API unitarias/HTTP | 373 |
| Realtime unitarias/HTTP/transporte | 170 |
| Integración de sesiones US-03 con ambos emuladores | 15 |
| Regresiones existentes del lanzador | 11 |
| **Total distinto ejecutado satisfactoriamente** | **569** |

Se añadieron 37 casos: 22 API y 15 integración de sesiones. Se conservaron las pruebas previas; no se eliminaron aserciones. Los 661 casos históricos de US-02 no son el total ejecutado en esta entrega. No se volvieron a ejecutar las suites históricas conjuntas, persistencia, eliminación, Realtime aislada o Security Rules que borran fixtures/identidades/documentos, para respetar la restricción de no ejecutar operaciones destructivas. Las Security Rules no se modificaron. Se ejecutaron todas las unitarias de ambos servicios, incluidas las regresiones simuladas de TS-01/US-01/US-02, y una integración nueva sin eliminación. No se presenta una regresión unitaria de eliminación como una ejecución real de su procesador.

| Cobertura global V8 | Instrucciones/líneas | Ramas | Funciones |
|---|---:|---:|---:|
| API | 97,44 % | 91,47 % | 88,04 % |
| Realtime | 97,61 % | 91,31 % | 95,08 % |

Lint, typecheck y build de ambos servicios aprobaron. No hay análisis remoto de Sonar US-03 ni afirmación de Quality Gate aprobado.

La integración real local acredita Email/Password, proveedor Google sintético, refresh nativo, sesión recurrente, rechazo de tokens vencidos/audiencia o issuer incorrectos, incorporación, cuenta marcada, desconexión voluntaria, reconexión, revocación/disabled con el matiz del emulador y parada del servidor con una sesión activa. Se comprueba persistencia del mismo perfil/reserva sin nuevo POST. La caída de Authentication se induce bloqueando localmente su transporte, sin contactar endpoints remotos; REST devuelve 503 y Socket.IO rechaza. No se ejecuta Firebase Client SDK signOut, no está instalado: se prueba la desconexión observable por backend y la ausencia de una desconexión automática cuando el cliente solo deja de usar el token. OAuth interactivo Google y frontend siguen pendientes.

### Incidencia durante el desarrollo y limitaciones

La primera versión del caso de infraestructura combinaba corte de Authentication y Firestore. El corte de Firestore dejó una solicitud sin respuesta HTTP dentro de sus 8 segundos y la ejecución no concluyó hasta el límite de 180 segundos del supervisor; el lanzador marcó fallo y cerró los emuladores. No se considera aprobada esa ejecución. La suite final mantiene el corte de Auth determinista (15/15); los fallos Firestore se cubren mediante los mocks de los guards/servicios existentes. No se afirma haber acreditado una respuesta REST acotada ante una caída real de Firestore. La auditoría posterior clasificó el riesgo como P2 operacional preexistente; la corrección se detalla en la sección siguiente; no se aumentaron timeouts ni se modificó infraestructura productiva para hacer pasar el caso.

Otros límites: REST no solicita revocación y no acredita rechazos inmediatos de cuentas deshabilitadas/eliminadas en producción. Authentication puede envolver fallos con códigos no diferenciables de errores de token; el nuevo 503 cubre únicamente códigos estables de red/cuota reconocidos. Realtime puede clasificar algunos fallos de Auth como AUTH_INVALID, pero no admite la conexión. No hay invalidación continua por expiración/revocación/cambio administrativo de perfil en sockets existentes; los guards por evento y el marcador de eliminación siguen operando. Una condición nueva de cierre global requiere criterios de producto, no una inferencia de signOut.

No hay defectos de autorización identificados en los casos ejecutados; la cobertura de aceptación completa queda condicionada a criterios originales aún no disponibles y a decisiones de producto explícitas. Se recomienda auditoría técnica antes del primer commit, especialmente de la política REST documentada y del alcance de validación sin eliminación.

Estado de la etapa anterior verificado: sin listeners en los puertos propios ni procesos del emulador/runner restantes. Git permanece en `feat/us-03-login`, HEAD/base `8ed1237b01ba410654cc2f7f841d205eb0adf565`, con cuatro archivos modificados y tres nuevos, sin índice preparado ni commits. Frontend permanece limpio. Sin cambios en dependencias, lockfiles, reglas, credenciales, despliegue o Firebase real. `git diff --check` y comprobación de sintaxis de los scripts: correctos.

## Corrección del P2 — Disponibilidad de Firestore y cierre de API

### Diagnóstico y APIs disponibles

El riesgo era preexistente: `ensureAccountActive` leía `accountDeletions/{uid}` y `getUserProfile` volvía a leer ese marcador y `users/{uid}` mediante `get()`. El abandono del cliente HTTP no cancelaba esas promesas. `withFirestore` solo clasificaba el error una vez terminado el SDK; `server.close()` y posteriormente `Firestore.terminate()` podían prolongar el apagado. No se acreditó la RPC exacta atascada en el experimento original, que interceptaba transportes y no reprodujo una caída natural.

Versiones inspeccionadas sin actualizar dependencias: Firebase Admin 13.10.0 y @google-cloud/firestore 7.11.6. La configuración instalada de BatchGetDocuments declara timeout de 300000 ms y parámetros de reintento con total de 600000 ms; no son un presupuesto HTTP por solicitud. `DocumentReference.get()` no acepta AbortSignal ni deadline en su firma pública instalada. No se inventaron parámetros ni se modificó configuración global de RPC que afectara escrituras.

La alternativa pública utilizada es `DocumentReference.onSnapshot(next, error)`, que devuelve una función para cancelar la escucha. Solo se espera el primer snapshot del servidor y se desuscribe inmediatamente. La lectura Admin no utiliza una caché offline de frontend. La semántica de perfil, sus validadores y la autoridad del marcador permanecen iguales. Referencias: [DocumentReference y onSnapshot](https://cloud.google.com/nodejs/docs/reference/firestore/latest/firestore/documentreference), [HTTP Node 24](https://nodejs.org/docs/latest-v24.x/api/http.html).

### Diseño de autorización

- `authorization-read.service.ts`: lectura de un documento por escucha cancelable, primer resultado únicamente, errores tardíos ignorados y límite de 64 suscripciones propias activas por proceso API. El límite acota admisión ante un fallo; no representa una cola ni cambia los límites de Realtime. Un fallo excepcional del disposer no libera su plaza, para no admitir fugas sin límite; requiere diagnóstico/reinicio si el SDK incumple su cierre.
- `authorization-context.ts`: presupuesto único de **5000 ms** desde el inicio de autorización Firestore del request. Se elige el mismo plazo de autorización de Realtime, por debajo del cliente de integración de 8000 ms. No implica que Authentication o la petición completa de escritura tengan un plazo de 5 segundos.
- `AsyncLocalStorage` propaga ese presupuesto y señal a las lecturas anidadas sin alterar las interfaces de servicios existentes. Es estado por request, no una bandera global compartida entre usuarios. Llamadas de lectura fuera de HTTP reciben un plazo de 5000 ms por lectura.
- Al terminar, fallar, vencer o abandonarse el request, se llama al unsubscribe público y se limpian timer/listeners propios. No es solo dejar de esperar un `get()` mediante Promise.race. Las callbacks tardías no permiten continuar ni escribir una respuesta.
- Se comprueba también el instante de finalización; una callback recibida fuera del plazo no se acepta aunque el timer todavía no haya ejecutado por congestión del event loop.
- `response.close` antes de `writableFinished` y `request.aborted` cancelan la autorización. `request.close` no se interpreta como abandono: puede significar que el cuerpo se recibió por completo. `finish` limpia el contexto.
- Los guards verifican que el contexto siga activo antes de llamar a next. GET no envía datos tras desconexión; los controladores POST/PATCH tampoco intentan responder en un transporte destruido, pero esperan la escritura ya admitida. El manejador de errores evita una respuesta tardía o duplicada después de terminar/destruirse la respuesta.

Los plazos y el límite se expresan como constantes documentadas. No se agregaron variables de entorno, dependencias ni nuevos contratos de configuración. Deben reevaluarse con mediciones de latencia del despliegue real; una conexión lenta puede obtener 503 y reintentar. Iniciar/cancelar una escucha introduce establecimiento de stream; no se mantiene una nueva supervisión permanente de perfiles.

### Escrituras y operaciones pendientes

No se modifican las lecturas transaccionales de creación/PATCH, reservas o eliminación. No se aplica un timeout genérico a `withFirestore`: únicamente cuenta operaciones reales mientras su promesa siga pendiente. El contador no se libera al desconectarse HTTP. Sirve para evitar terminar Firebase cuando una operación admitida todavía puede confirmar una escritura. No se declara cancelada una transacción por cerrar su conexión HTTP.

La cancelación de una escucha es la garantía pública del SDK; el cierre físico de canales compartidos puede completarse después. No se inspeccionan ni modifican campos privados para fingir cancelación. La prueba nueva con SDK real verifica cierre de RPC y terminación del cliente en un transporte loopback controlado. Si el SDK no termina pese a desuscribirse, el apagado informa fallo y la política del propietario del proceso constituye el último límite, no una afirmación de liberación correcta del SDK.

### Apagado

1. Se cierra admisión en Express: nuevas solicitudes reciben `503 SERVER_STOPPED` sin acceder al SDK. Esta puerta aplica también mientras se espera la parada del conciliador; no habilita endpoints.
2. El conciliador conserva su stop y trabajo admitido, con **5000 ms** de espera del controlador. Un timeout no se confunde con trabajo realmente terminado.
3. `server.close()` dispone de **6000 ms**: 5000 de autorización + 1000 para completar la respuesta. Solo si vence esa gracia se llama a `closeAllConnections()`, seguido de hasta **1000 ms** para observar el cierre. No se fuerza por un error inmediato de close.
4. Se espera hasta **5000 ms** a que las operaciones `withFirestore` terminen de verdad. Si HTTP, conciliador o esas operaciones no drenaron, no se llama prematuramente a closeFirebase. Se informa `SERVER_SHUTDOWN_FAILED`.
5. Si drenaron, se llama al cierre existente y propietario de Firebase con **5000 ms** de espera. Su orden sigue siendo `Firestore.terminate()` y `deleteApp()` de la aplicación propia. Promise.race aquí acota el controlador de cierre, no cancela esas APIs; rechazos tardíos quedan manejados.
6. `stop()` sigue siendo idempotente y conserva el error original de inicialización en ready aunque falle el apagado. Los fallos de cierre se registran con códigos/eventos sanitizados.
7. Solo el propietario del ejecutable (`startApiProcess`, usado por el entrypoint) aplica un límite total de **25000 ms** ante señal o fallo fatal: supera la suma de las etapas acotadas y deja margen de diagnóstico. Si sobreviven recursos, registra `api_shutdown_hard_deadline` y termina con código 1. No se declara un cierre satisfactorio ni que las escrituras pendientes se hayan cancelado. En un runtime embebido, startApiServer no termina el proceso anfitrión: devuelve el error y corresponde al anfitrión su política de terminación.

Los tiempos se aplican a la espera del apagado; una escritura ya admitida puede tener resultado persistente desconocido para su cliente al terminar el proceso. No se introducen escrituras compensatorias, cambios de transacciones o promesas de rollback. closeAllConnections solo cierra HTTP; no equivale a terminar el SDK. Ningún timer puede dar una garantía de tiempo real si el event loop está bloqueado; el supervisor del despliegue sigue siendo la defensa externa necesaria.

### Pruebas y resultados de la corrección

Se añadieron **30 casos** respecto a la etapa anterior: 29 unitarios/HTTP API y uno con SDK real. Incluyen éxito/error/ausencia de snapshot, resultado/rechazo tardío, deadline compartido, callbacks síncronas, error de disposer, concurrencia y saturación, recuperación, abandono HTTP real, no doble respuesta, no admisión durante cierre, gracia HTTP, SDK que no termina, operaciones de escritura admitidas, conciliador pendiente, idempotencia y conservación del error original. El límite final del propietario del proceso se comprueba con temporizadores controlados y un spy de process.exit, sin terminar el runner.

La integración nueva monta un endpoint gRPC loopback exclusivo que acepta el RPC y no envía snapshots; observa la solicitud, respeta la desuscripción, comprueba que el stream cierra, termina el cliente real y después vuelve a consultar API contra Firestore Emulator. Es una fixture de transporte controlada y supervisada, **no una reproducción de la caída natural ni del net.block original**. No se repitió esa inyección. Las 15 integraciones de sesiones anteriores permanecen intactas.

| Grupo ejecutado en esta corrección | Aprobadas |
|---|---:|
| API unitarias/HTTP | 402 |
| Realtime unitarias/HTTP/transporte | 170 |
| Sesiones/emuladores + lectura detenida SDK | 16 |
| Regresiones del lanzador | 11 |
| **Total distinto** | **599** |

| Cobertura V8 global | Líneas/instrucciones | Ramas | Funciones |
|---|---:|---:|---:|
| API | 98,00 % | 91,72 % | 88,88 % |
| Realtime | 97,61 % | 91,31 % | 95,08 % |

Lint, typecheck y build de ambos servicios aprobaron. Se mantienen los comandos de la sección de ejecución. Las fixtures de tests anteriores se adaptaron a onSnapshot conservando sus datos y aserciones; no se eliminaron pruebas. No se ejecutaron suites históricas destructivas ni se modificaron Security Rules o Realtime. No hay Quality Gate remoto US-03.

### Evaluación y riesgos residuales

El P2 queda tratado en las lecturas HTTP y el ciclo de vida del ejecutable: cancelación pública de suscripciones, espera acotada, admisión limitada, seguimiento de trabajo real y salida explícita con fallo si el SDK no libera recursos. Esto no equivale a garantizar cancelación de cualquier operación SDK, terminación correcta de Firebase en todos los fallos o confirmación negativa de escrituras. Las garantías embebidas son más limitadas que las del ejecutable, como se explica arriba. Se recomienda nueva auditoría focalizada antes del primer commit. Las políticas REST de revocación y las dos P3 heredadas siguen sin cambios.

El límite de 25 segundos es una política del ejecutable, no una garantía sobre el supervisor externo: el contenedor u orquestador puede imponer un plazo menor. No se modificó esa configuración. La imagen existente ejecuta `node dist/server.js`, por lo que utiliza el propietario de proceso descrito.

### Archivos del árbol final (US-03 y corrección P2)

Modificados (17):

- `backend-api/src/app.ts`
- `backend-api/src/controllers/users.controller.ts`
- `backend-api/src/docs/openapi.ts`
- `backend-api/src/middleware/account-active.ts`
- `backend-api/src/middleware/auth.ts`
- `backend-api/src/middleware/complete-profile.ts`
- `backend-api/src/middleware/errors.ts`
- `backend-api/src/routes/api.routes.ts`
- `backend-api/src/server.test.ts`
- `backend-api/src/server.ts`
- `backend-api/src/services/account-state.service.ts`
- `backend-api/src/services/account-state.test.ts`
- `backend-api/src/services/firestore.service.ts`
- `backend-api/src/services/users.service.test.ts`
- `backend-api/src/services/users.service.ts`
- `integration-ts01/README.md`
- `integration-ts01/run.cjs`

Nuevos (8):

- `backend-api/src/middleware/auth.test.ts`
- `backend-api/src/middleware/authorization-context.test.ts`
- `backend-api/src/middleware/authorization-context.ts`
- `backend-api/src/middleware/authorization-http.test.ts`
- `backend-api/src/services/authorization-read.service.test.ts`
- `backend-api/src/services/authorization-read.service.ts`
- `docs/us-03-backend.md`
- `integration-us03/session.test.cjs`

Los siete archivos originales de US-03 se conservaron. No se modificaron Realtime, frontend, dependencias, lockfiles, Security Rules ni configuraciones de producción. El índice permanece vacío; sin commits, push, PR ni despliegues. La última ejecución unitaria deshabilitó explícitamente dotenv mediante `DOTENV_CONFIG_PATH=/dev/null`; el lanzador sanea el entorno de sus hijos.
