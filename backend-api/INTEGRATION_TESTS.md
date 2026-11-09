# TS-01: integración con Firestore Emulator

## Requisitos

- Node.js 24 o superior (versión del proyecto).
- Dependencias existentes de `backend-api` instaladas.
- Firebase CLI disponible en PATH, o ruta absoluta en `TEAMSPEAK_FIREBASE_CLI`.
- Java 21 o superior para las versiones actuales del emulador.
- Puerto local 8081 libre por defecto (configurable). El launcher inicia y detiene Firestore mediante
  `firebase emulators:exec`. La primera ejecución puede descargar el emulador.

Desde `backend-api`:

```bash
npm run test:integration
```

Para herramientas temporales, añadir sus directorios al PATH y definir
`TEAMSPEAK_FIREBASE_CLI` con la ruta absoluta del ejecutable. No hace falta login.
No se agregaron dependencias al proyecto.

## Aislamiento

El launcher crea un proceso con una lista explícita de variables permitidas:
`NODE_ENV=test`, `DOTENV_CONFIG_PATH=/dev/null`,
`FIRESTORE_EMULATOR_HOST=127.0.0.1:<puerto>` (8081 por defecto),
`GCLOUD_PROJECT=demo-teamspeak-tests` y
`FIREBASE_PROJECT_ID=demo-teamspeak-tests`.
No hereda tokens Firebase, claves de cuenta de servicio, ADC, `FIREBASE_CONFIG`
ni `NODE_OPTIONS`. La CLI usa un `XDG_CONFIG_HOME` temporal vacío para no
leer sesiones guardadas y una caché de emuladores en `/tmp`. No lee `.env` ni ejecuta comandos de despliegue.

Firebase Admin usa una aplicación nombrada del proyecto demo sin credenciales
reales. Se inyecta el cliente real de Firestore en `users.service.ts`;
no se simulan las operaciones SDK ni se cambia la configuración de producción.
Antes de las operaciones SDK se comprueba el endpoint local con timeout.
Una configuración incorrecta o un emulador ausente hacen fallar la ejecución.

La configuración específica es `firebase.emulator.json`; reutiliza las reglas
existentes. El launcher copia esa configuración a un directorio temporal,
conservando allí logs y archivos auxiliares. No altera `../firebase.json`.

Cada caso borra los documentos del **proyecto demo local** con la API REST del
emulador. No ejecutar esta suite junto a otras pruebas sobre el mismo proyecto.
El modo `npm run test:integration:run` requiere un emulador ya iniciado y
`FIRESTORE_EMULATOR_HOST=127.0.0.1:<puerto>` y `GCLOUD_PROJECT=demo-teamspeak-tests`;
si se cambia el puerto, también debe indicarse `TEAMSPEAK_FIRESTORE_PORT`. El comando recomendado es el launcher completo.

## Escenarios

- A: creación, consulta y comprobación directa de perfil y reserva.
- B/C: dos UID concurrentes con username idéntico o variante de mayúsculas.
- D: mismo UID concurrente con datos iguales o usernames diferentes.
- E: repetición después de una respuesta perdida, sin cambios de fechas.
- F: fallo real de commit del SDK por `create` de documento existente;
  comprobación de rollback de todas las escrituras. Este caso comprueba una
  transacción SDK real, no inyecta un fallo ficticio en el servicio.
- F adicional: conflicto de aplicación en el servicio sin cambios persistidos;
  se distingue del rechazo real de commit.
- G: recuperación con y sin reserva previa propia, fechas y datos conservados.
- H: reserva de otro UID, rechazo y comparación de documentos antes/después.

Las pruebas unitarias/HTTP siguen separadas en `npm run test:coverage`.
La configuración de integración no hereda mocks ni se ejecuta en la suite normal.
Los archivos de integración quedan fuera de la cobertura unitaria.

## Límites

El emulador permite comprobar persistencia y concurrencia locales. No acredita
IAM, latencia, cuotas, índices ni todos los comportamientos de producción.
La suite Firestore usa identidades controladas; la suite conjunta de TS-01.4B
verifica Authentication Emulator como se describe más abajo. DELETE permanece fuera de esta etapa.

## Puerto configurable y Node 24

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
node --version
npm --version
npm run lint
npm run build
DOTENV_CONFIG_PATH=/dev/null npm run test:coverage
npm run test:integration
# Alternativa si 8081 está ocupado:
TEAMSPEAK_FIRESTORE_PORT=8082 npm run test:integration
```

El puerto se toma de `firebase.emulator.json` (8081), o de
`TEAMSPEAK_FIRESTORE_PORT` (entero entre 1024 y 65535). Solo se permite loopback
127.0.0.1; no se permite configurar otro proyecto. El launcher aplica el mismo
puerto a Firebase CLI, al entorno Admin SDK y a las sondas REST. No detiene
contenedores ni cambia Docker Compose. Si hay un conflicto, escoger otro puerto.

El launcher y el setup rechazan Node anterior a 24. Los procesos Vitest se lanzan
con `process.execPath`; el setup imprime la versión real y el host local.
Las pruebas borran el proyecto demo antes de cada caso. Se ejecutan con orden
mezclado y semilla 42 para reproducirlo, sin depender de los casos anteriores.

## Resultado verificado — 9 de noviembre de 2026

- Node.js 24.18.0, npm 11.16.0, Java Temurin JRE 21.0.13+9.
- Firebase CLI 15.35.0, Firestore Emulator 1.22.0,
  Vitest 3.2.7 y Firebase Admin 13.10.0.
- 103/103 pruebas unitarias/HTTP y 11/11 casos reales en 8081.
- Segunda pasada real: 11/11 en 8082, orden mezclado con semilla 42.
- Al finalizar: 8081, 8082 y 9150 cerrados; sin procesos Java restantes.
  Adminer continuó activo en 8080.
- Lint, build y diff check correctos.
- Cobertura Node 24: instrucciones/líneas 95,26 %, ramas 89,47 %,
  funciones 66,66 %. El informe anterior con Node 22 daba 89,53 % de ramas y
  67,50 % de funciones. No cambió el código de producción ni la suite unitaria;
  la diferencia aparece al cambiar el runtime/V8 del proveedor de cobertura.
- La ejecución con valores sintéticos de credenciales y dotenv en el entorno
  padre pasó: no se heredaron al proceso protegido (el setup rechaza su presencia).
- Host remoto, puerto inválido y proyecto incorrecto fueron rechazados antes
  de lanzar las pruebas. Sin emulador, el sondeo local falló antes de operar con SDK.
- No se modificó lógica de negocio, dependencias, lockfiles ni configuración
  de producción. No se detuvieron contenedores ajenos en esta verificación.

La sonda REST usa la colección `users` con el marcador sintético `Bearer owner`
del emulador, sin credenciales reales. Las herramientas temporales no se incluyen
en el repositorio. Para reutilizar las herramientas de esta máquina:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
PATH=/tmp/teamspeak-integration-tools/jre21/bin:$PATH \
TEAMSPEAK_FIREBASE_CLI=/tmp/teamspeak-integration-tools/cli/node_modules/.bin/firebase \
npm run test:integration
```


## TS-01: actualización parcial (PATCH)

La suite también ejecuta PATCH a través de `updateUserProfile` con Firestore real
local: campos simples, avatar nulo y omitido, cambio de username y liberación de
su reserva, cambio de mayúsculas sin reescribir la reserva, conflicto sin cambios,
repetición con `updateTime` intacto y reserva actual inconsistente.

Concurrencia: campos independientes del mismo UID, dos cambios de username del
mismo UID, dos UID disputando una nueva clave, y renombrar mientras otro UID
intenta reservar la clave anterior. Se comprueba la propiedad de las reservas y
la ausencia de huérfanos en el estado final.

El caso de rollback de actualización usa una transacción SDK real con update,
delete y create; un create sobre una reserva existente falla en el commit y se
comprueba que ni el perfil ni las reservas cambian. Se distingue de la prueba de
conflicto del servicio, que rechaza antes de escribir.

Contrato: PATCH no crea perfiles (404 PROFILE_NOT_FOUND), no recupera perfiles
incompletos (409 PROFILE_INCOMPLETE; usar POST) y rechaza inconsistencias con
409 PROFILE_INCONSISTENT. Los campos internos no son editables. Las actualizaciones
sin cambios reales conservan updatedAt y no escriben documentos.

Resultado de PATCH (Node 24.18.0, 9 de noviembre de 2026): 158/158 pruebas
unitarias/HTTP y 22/22 de integración real aprobadas (103 y 11 anteriores
conservadas). Lint y build correctos. Cobertura unitaria: instrucciones/líneas
95,74 %, ramas 90,90 %, funciones 70 %. Integración ejecutada en 8081 con
semilla 42; emulador detenido automáticamente al finalizar.

## Base de bloqueo por eliminación de cuenta

`accountDeletions/{uid}` identifica el proceso por el UID, sin copiar el perfil.
El modelo tipado contempla status (pending/completed/blocked), phase
(auth/firestore/done), usernameKeys, requestedAt, updatedAt, completedAt opcional,
attempts, nextAttemptAt opcional y lastErrorCode opcional. Esta etapa no crea
marcadores desde endpoints ni ejecuta eliminación o conciliación.

La existencia de cualquier documento bloquea la cuenta. Los estados pending,
blocked y completed devuelven 403 ACCOUNT_DELETION_PENDING,
ACCOUNT_DELETION_BLOCKED y ACCOUNT_DELETED respectivamente. Un marcador malformado
o con estado desconocido también se rechaza (ACCOUNT_DELETION_PENDING), sin
exponer su contenido. Los fallos de lectura nunca autorizan el acceso.

Conceptos separados: requireAuth establece identidad; requireActiveAccount
comprueba acceso mediante Firestore; los servicios de perfil determinan si está
completo. Una cuenta activa puede tener perfil incompleto. Un perfil completo no
habilita acceso si existe un marcador.

Todas las rutas privadas de backend-api utilizan el middleware de cuenta activa.
GET además comprueba el marcador desde el servicio. POST y PATCH lo leen dentro
de sus propias transacciones, antes de perfiles, reservas o escrituras; no dependen
solo de una comprobación previa de middleware. No se usa una caché en memoria.
Las peticiones que ya pasaron una comprobación de lectura pueden estar en vuelo;
la garantía transaccional contra escrituras posteriores al bloqueo corresponde a
POST/PATCH. La futura creación del marcador debe ser transaccional para ordenar
esas operaciones.

Los tests insertan marcadores únicamente en el emulador demo. Comparan documentos
antes/después de rechazos; al competir POST/PATCH con el marcador, el estado final
debe coincidir con el que leyó la transacción que confirmó el bloqueo. También
comprueban operaciones confirmadas previamente y marcadores de otros UID.

La eliminación irreversible y la conciliación siguen sin implementar. Antes de
habilitar uso público será obligatorio añadir el control de estado en
backend-realtime (handshake, eventos y sockets existentes). TS-01.4B introduce una
excepción exacta para DELETE /api/users/me con autenticación propia y activación
restringida a pruebas; los recursos privados normales conservan el bloqueo.

Verificación de esta base (Node 24.18.0): 177/177 pruebas unitarias/HTTP y
31/31 de integración real, preservando las 180 anteriores. Las dos carreras
POST/PATCH contra el marcador pasaron. Cobertura: instrucciones/líneas 95,97 %,
ramas 92,05 %, funciones 72,09 %. Sin operaciones contra Firebase real.


## TS-01.4B: inicio de eliminación, exclusivamente en pruebas

Requisitos adicionales: Authentication Emulator local. Firebase CLI lo inicia
junto a Firestore sin nuevas dependencias del proyecto. Puerto Auth predeterminado
9099, configurable con `TEAMSPEAK_AUTH_PORT`; Firestore conserva 8081 y
`TEAMSPEAK_FIRESTORE_PORT`. Ambos deben ser distintos y estar libres.

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
npm run test:integration          # suite Firestore anterior, DELETE deshabilitado
npm run test:integration:deletion # suite conjunta, habilitación explícita de pruebas
# Puertos alternativos:
TEAMSPEAK_FIRESTORE_PORT=8082 TEAMSPEAK_AUTH_PORT=9100 npm run test:integration:deletion
```

Con herramientas temporales de esta máquina, usar el mismo PATH y
TEAMSPEAK_FIREBASE_CLI del ejemplo anterior con el nuevo comando. No se requiere
login, usuarios reales ni cambios en Firebase Console. Las sondas de ambos
emuladores deben responder antes de las operaciones SDK; la suite reinicia solo
las bases demo locales entre casos y la CLI apaga ambos emuladores al finalizar.

El launcher habilita TEAMSPEAK_ENABLE_DELETE_TESTS=true únicamente para la suite
conjunta y fija FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:<puerto>, sin protocolo.
El endpoint y el servicio verifican simultáneamente NODE_ENV=test, ambos project
IDs demo-teamspeak-tests, los dos hosts loopback válidos y distintos, ausencia de
credenciales, DOTENV_CONFIG_PATH=/dev/null y la habilitación explícita. También se
comprueba el project ID de las instancias SDK. Una variable aislada no habilita
DELETE. Fuera de estas condiciones devuelve 501 antes de usar los SDK.

Solo DELETE /api/users/me omite requireActiveAccount. Utiliza verificación propia
verifyIdToken(token, true); GET/POST/PATCH no cambian su autenticación ni acceso.
No admite cuerpo. El UID y auth_time provienen del token verificado. Una intención
nueva requiere auth_time entero positivo, no futuro, con antigüedad <=300 segundos;
iat y la simple renovación del token no satisfacen esta condición.

US-05 deberá reautenticar con EmailAuthProvider/reauthenticateWithCredential para
correo/contraseña o reauthenticateWithPopup/Redirect/Credential para Google según
el flujo del frontend, y obtener el token actualizado. No se implementan formularios.

Errores públicos de autenticación: AUTH_REQUIRED, AUTH_INVALID, AUTH_EXPIRED,
AUTH_REVOKED, AUTH_USER_DISABLED, AUTH_USER_DELETED y AUTH_RECENT_REQUIRED (401).
Errores conocidos de red/cuota son 503 AUTH_UNAVAILABLE; errores internos
inesperados son 500 INTERNAL_ERROR. No se devuelven mensajes internos del SDK.

La transacción inicial lee marcador, perfil y consulta las reservas por UID.
Valida la propiedad explícita del perfil cuando está presente, la coherencia de
username/usernameKey y la propiedad de cada reserva. Solo registra claves de
documentos propios existentes. Un perfil inexistente no se fabrica; un perfil
incompleto puede eliminarse si la propiedad es segura. Si la reserva declarada no
existe no se inventa ni se incluye; si pertenece a otro UID se rechaza con
PROFILE_INCONSISTENT. Pueden registrarse varias reservas propias verificadas para
la futura limpieza de esa cuenta; no se eliminan ni se reparan en esta etapa.

Se crea únicamente accountDeletions/{uid} con pending/auth, usernameKeys, dos
Timestamp y attempts=0. No hay llamadas Authentication dentro de la transacción.
Un pending válido se reutiliza sin exigir nueva recencia, pero siempre con token
verificado y revocación comprobada. Se vuelve a comprobar que las reservas
registradas existentes no pertenezcan a otros UID; en phase=auth deben existir.
La fase firestore puede tolerar reservas ausentes por limpieza futura. No se
reinician fechas/intentos/fases ni se sustituyen las claves. blocked/completed
válidos devuelven 409 ACCOUNT_DELETION_BLOCKED/ACCOUNT_DELETED; un marcador inválido
devuelve 409 ACCOUNT_DELETION_INCONSISTENT. Nunca devuelve 200 completed.

Respuesta: 202 { success: true, data: { status: "pending" } }. Significa intención
persistida, NO eliminación terminada. Los emuladores comprueban que identidad,
perfil y reservas siguen presentes y que las carreras capturan las reservas
vigentes. DELETE sigue deshabilitado públicamente mientras faltan procesamiento,
conciliación y protección realtime (TS-01.4C/4D).

Límite: Authentication Emulator emite tokens sin la firma criptográfica de
producción. Estas pruebas comprueban el flujo SDK/HTTP local, no la validación de
firmas reales ni el login Google real. Los fallos controlados y auth_time inválidos
se prueban con mocks. Las identidades solo se limpian mediante el reset de fixtures
del emulador; el endpoint nunca llama deleteUser ni elimina documentos.

Resultado TS-01.4B (Node 24.18.0, 9 de noviembre de 2026): lint/build correctos;
227/227 pruebas unitarias/HTTP, 31/31 Firestore anteriores y 12/12 conjuntas,
270 casos aprobados en total, incluidos los 208 previos. Nuevos: 50 casos
unitarios/HTTP/contrato y 12 de integración conjunta. Cobertura: instrucciones y
líneas 96,68 %, ramas 91,17 %, funciones 78,43 %. Ambos emuladores se detuvieron
mediante emulators:exec. No se modificaron dependencias ni se realizaron commits.
