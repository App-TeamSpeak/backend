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

En esta base aún no se implementaba eliminación irreversible ni conciliación. Antes de
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
se prueban con mocks. En TS-01.4B las identidades solo se limpiaban mediante el reset de fixtures
del emulador; el endpoint nunca llama deleteUser ni elimina documentos.

Resultado TS-01.4B (Node 24.18.0, 9 de noviembre de 2026): lint/build correctos;
227/227 pruebas unitarias/HTTP, 31/31 Firestore anteriores y 12/12 conjuntas,
270 casos aprobados en total, incluidos los 208 previos. Nuevos: 50 casos
unitarios/HTTP/contrato y 12 de integración conjunta. Cobertura: instrucciones y
líneas 96,68 %, ramas 91,17 %, funciones 78,43 %. Ambos emuladores se detuvieron
mediante emulators:exec. No se modificaron dependencias ni se realizaron commits.

## TS-01.4C.1: procesador interno, exclusivamente con fixtures de emuladores

La suite conjunta del comando `npm run test:integration:deletion` incluye ahora
el procesador. Conserva los requisitos, puertos configurables y aislamiento de
TS-01.4B. Ejecutar las dos suites de integración secuencialmente: reinician el
mismo proyecto demo entre casos. No se requieren dependencias adicionales.

Las pruebas crean identidades ficticias, registran la intención mediante DELETE
y llaman internamente a `processAccountDeletion(uid)` (con hooks locales para los fallos controlados).
Ambos clientes son SDK reales de los emuladores. La función repite las protecciones
de `deletion-test.ts` y verifica ambos project IDs antes de operar, incluso cuando
se invoca directamente. No acepta reservas del cliente ni crea intenciones.
No se importa desde el controlador: DELETE sigue devolviendo 202 pending y
permanece deshabilitado públicamente. No existe endpoint para procesar un UID.

Combinaciones válidas y avance permitido:

| Estado/fase | Comportamiento |
| --- | --- |
| pending/auth | Eliminar identidad; user-not-found también satisface el paso. |
| pending/firestore | Limpiar recursos propios y completar atómicamente, sin repetir Auth. |
| completed/done | Terminal: no escribir ni eliminar nada. |
| blocked/auth o blocked/firestore | Terminal para el procesador; requiere intervención. |

`completed` exige `completedAt`; los demás estados no lo admiten. Un marcador
ausente o malformado se rechaza antes de operaciones destructivas; no se repara
automáticamente. El flujo normal es pending/auth → pending/firestore →
completed/done. Nunca se retrocede de fase ni se reinician estados terminales.

Una transacción de admisión lee y valida marcador, perfil y reservas. Rechaza
propietarios contradictorios y claves propias no capturadas por la intención,
antes de eliminar Auth. `deleteUser(uid)` ocurre fuera de las transacciones.
Después de confirmar eliminación o ausencia se persiste la fase firestore.
La limpieza vuelve a comprobar todo con lecturas previas a las escrituras:
perfil, consulta de reservas por UID y cada clave histórica. Solo elimina
documentos propios; las ausencias coherentes se toleran, incluso con perfil
incompleto. Perfil, reservas y marcador completed se confirman en una única
transacción. No se realiza compensación ni se recrean identidades.

Cada ejecución admitida incrementa `attempts` transaccionalmente; los reintentos
internos del SDK no duplican ese incremento. No se incrementa al encontrar
completed, blocked, marcador inválido o `nextAttemptAt` aún futuro. Si Firestore
falla antes de confirmar admisión, no hay operaciones Auth ni incremento durable.
Timeouts, indisponibilidad y resultados desconocidos conservan pending y guardan
un código controlado, sin mensajes SDK. La espera es 30, 60, 120, 240, 480, 960,
1920 y como máximo 3600 segundos. No hay temporizador, cola ni conciliador.
Una nueva invocación después de ese instante reanuda desde el marcador persistido.
Si Firestore sigue inaccesible tampoco puede persistirse el diagnóstico: la
invocación falla y el siguiente ejecutor vuelve a leer el último estado durable.

Contradicciones de propiedad o claves inesperadas producen blocked con
PROFILE_INCONSISTENT. Permisos denegados conocidos producen
AUTH_CONFIGURATION_ERROR o FIRESTORE_PERMISSION_DENIED. Un marcador corrupto
se rechaza con ACCOUNT_DELETION_INCONSISTENT sin modificarlo. Ninguno autoriza
limpieza automática. No se interpreta un resultado incierto como error permanente.

Las transacciones coordinan ejecutores concurrentes sin leases. El contador no
retrocede; un error antiguo solo puede escribir si siguen coincidiendo fase e
intento admitido. Dos llamadas Auth concurrentes son posibles: ausencia es éxito.
La transacción final se aplica una sola vez; repetir un completed no toca una
reserva que otro usuario haya reutilizado. No se deben recrear administrativamente
identidades con el mismo UID durante ni después de una eliminación persistida:
los flujos normales ya están bloqueados por el marcador. La coordinación con
acciones administrativas externas no forma parte de esta etapa.

Al completar se conservan estado/fase, requestedAt, updatedAt, completedAt y
attempts; usernameKeys pasa a [] y desaparecen nextAttemptAt/lastErrorCode.
Las claves históricas solo se descartan después de comprobar y confirmar toda
la limpieza. El marcador mínimo sigue bloqueando el UID eliminado.

Los puntos de inyección de fallos son opciones locales de la función, sin
banderas globales ni entradas HTTP. Las pruebas unitarias usan mocks; la suite
conjunta usa transacciones y cuentas reales de los emuladores. Los hooks simulan
fallos antes de confirmar fase/limpieza o pérdida de respuesta después del commit.
Se comprueban el estado durable, rollback de escrituras encoladas, nueva
invocación tras fallo, competencia entre dos procesadores, bloqueo POST/PATCH,
propiedad ajena y reutilización del username. Estos abortos controlados del
callback no equivalen a provocar una caída real del servidor o de la red.

Los emuladores no acreditan IAM, cuotas, latencia ni firma de tokens en producción.
Continúan pendientes TS-01.4C.2 (conciliación automática) y las protecciones
realtime antes de considerar habilitación pública. Este procesador no se ejecuta
al arrancar el backend y no constituye una funcionalidad disponible en producción.

Resultado TS-01.4C.1 (Node 24.18.0, npm 11.16.0): lint/build y diff check
correctos; 261/261 unitarias/HTTP, 31/31 Firestore y 27/27 conjuntas.
Total: 319 casos, conservando los 270 anteriores y añadiendo 34 unitarios y
15 conjuntos. Cobertura unitaria: instrucciones/líneas 97,15 %, ramas 89,86 %,
funciones 82,53 %. Procesador: instrucciones/líneas y funciones 100 %, ramas
85,85 %. La cobertura global de ramas baja desde 91,17 % al incorporar las
nuevas rutas del procesador; no se retiraron pruebas anteriores. Ambos comandos
de integración finalizaron con código 0 y apagaron sus emuladores.


## Corrección P1: procedencia y destino de los clientes destructivos

El procesador ya no admite opciones `auth` ni `firestore`: las rechaza en ejecución,
además de excluirlas de su interfaz TypeScript. No reutiliza la aplicación por
omisión ni clientes de `config/firebase.ts`. Cada invocación utiliza
`withDeletionEmulatorClients`, que valida el entorno antes de construir recursos.

La factoría crea una aplicación Admin con nombre único, project ID demo y un
proveedor explícito del token sintético `owner`. Auth se construye después de
validar el host local: el SDK instalado fija esa URL al crear la instancia.
Firestore se construye directamente con la API pública `new Firestore`, proyecto
explícito, host/puerto loopback, `ssl: false` y credenciales sintéticas sin clave
válida. Esto evita ADC; la factoría Firestore de Admin instalada no admite el
proveedor de credenciales local utilizado para Auth. No se generan ni cargan
credenciales reales. El destino Firestore queda configurado en la instancia.

Los dos hosts se capturan al construir y se vuelven a comparar antes de cada
transacción y llamada Auth. Cambiar las variables después invalida la operación;
no redirige ni reutiliza los clientes. Las instancias pertenecen al ámbito de la
invocación: `finally` termina Firestore y elimina la aplicación, incluso si falla
el callback. No hay caché de clientes destructivos ni recursos permanentes nuevos.

Las pruebas unitarias del procesador sustituyen el módulo de la factoría mediante
Vitest; esto no agrega una opción de inyección a la interfaz ejecutable. Los hooks
solo controlan el tiempo o simulan fallos, y no suministran instancias SDK. Las
pruebas conjuntas usan la factoría real para eliminar fixtures y conservan la
comprobación de recuperación y concurrencia.

Las regresiones crean clientes previamente configurados para destinos no locales
sin efectuar solicitudes. Las propiedades privadas del SDK solo se inspeccionan
en esas pruebas para acreditar el escenario anterior; la protección ejecutable
utiliza construcción controlada y API pública. Se verifican además configuración
insegura, cambios de hosts, rechazo directo y cierre en éxito y error. La prueba
de proyecto usa una comprobación de existencia (`'projectId' in firestore`), pues
el getter de ejecución no está declarado por el tipo Firestore instalado.

Verificación tras corregir P1: Node 24.18.0 y npm 11.16.0; lint y build
correctos; 278 pruebas unitarias/HTTP (261 anteriores más 17 regresiones de
seguridad), 31 Firestore y 27 conjuntas aprobadas: 336 en total. Se conservan
los 319 casos previos. Cobertura: instrucciones/líneas 97,25 %, ramas 90,30 %,
funciones 83,33 %. Los dos comandos de integración finalizaron correctamente
con cierre automático de los emuladores. Sin cambios de dependencias ni commits.

## TS-01.4C.2: conciliador de eliminaciones pendientes, solo emuladores

`createAccountDeletionReconciler()` expone `start()`, `runOnce()`, `stop()` y
`getState()`. Importarlo no inicia temporizadores ni abre clientes. `server.ts`
lo construye al arrancar; sin habilitación explícita, iniciar y ejecutar son
operaciones sin consultas ni temporizadores. El HTTP normal conserva su arranque.
No se agregó ningún endpoint ni se conectó DELETE al procesador.

Para activarlo en un proceso de pruebas preparado para los emuladores, definir
`TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS=true`. También son obligatorias todas
las condiciones anteriores: NODE_ENV=test, TEAMSPEAK_ENABLE_DELETE_TESTS=true,
DOTENV_CONFIG_PATH=/dev/null, ambos project IDs demo-teamspeak-tests, ambos hosts
loopback distintos y sin credenciales reales. La habilitación no permite usar
producción. Una activación explícita insegura falla antes de escuchar HTTP o
consultar trabajos. La suite conjunta activa esta bandera localmente en cada
caso y la restaura después; no es necesario modificar `.env`.

Configuración mediante opciones internas o variables de entorno (las opciones
prevalecen). Todas las cantidades deben ser enteros dentro de estos límites:

| Variable, con prefijo TEAMSPEAK_DELETION_RECONCILER_ | Predeterminado | Límites |
| --- | --- | --- |
| INTERVAL_MS | 30000 | 1000–300000 ms |
| BATCH_SIZE | 10 | 1–100 cuentas por pasada |
| PAGE_SIZE | 25 | 1–100 documentos por consulta |
| SCAN_LIMIT | 100 | 1–1000 documentos leídos por pasada |
| CONCURRENCY | 1 | Solo 1; ejecución secuencial deliberada |

Por ejemplo, con ambos emuladores demo ya iniciados y aislados, desde backend-api:

```bash
NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null \
FIREBASE_PROJECT_ID=demo-teamspeak-tests GCLOUD_PROJECT=demo-teamspeak-tests \
FIRESTORE_EMULATOR_HOST=127.0.0.1:8081 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
TEAMSPEAK_ENABLE_DELETE_TESTS=true TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS=true \
TEAMSPEAK_DELETION_RECONCILER_BATCH_SIZE=10 npm start
```

Ejecutar antes `npm run build`, usar Node 24 y un entorno sin credenciales reales.
No ejecutar este servidor a la vez que las suites que reinician las bases demo.
Este ejemplo no inicia los emuladores; el launcher de las pruebas sí lo hace.
No se requiere login ni una configuración de producción.

El descubrimiento usa `where(status == pending)`, orden por ID de documento y
`startAfter` con el último ID visitado. Conserva marcadores sin nextAttemptAt;
no ordena por ese campo opcional. El índice simple existente de status, cuyo
orden incorpora el nombre del documento, es suficiente; no se agrega un índice
compuesto. La consulta se comprueba con el emulador (que no certifica todos los
requisitos de índices de producción).

Cada pasada lee páginas acotadas, valida el marcador y compara nextAttemptAt
con Timestamp del servidor: sin fecha o con fecha <= ahora es elegible. Las fechas
futuras esperan. El procesador vuelve a comprobar el backoff con su reloj real;
el reloj inyectable de selección no fuerza reintentos. Completed/blocked no
participan en la consulta; los marcadores corruptos se registran sin modificarlos.
El conciliador nunca escribe marcadores ni duplica pasos de eliminación.

El cursor avanza también sobre reintentos futuros y marcadores inválidos. Si se
alcanza el límite de lectura, la próxima pasada continúa desde allí: un elegible
posterior no queda oculto por las primeras páginas de fechas futuras. Al llegar
al final se reinicia el cursor para la siguiente pasada y se descubren también
IDs nuevos anteriores. Si se alcanza el límite de cuentas a mitad de una página,
se conserva el último ID visitado, no el último leído. La memoria contiene solo
una página; la espera máxima depende del número de pendientes, límites y duración
del procesamiento. No hay garantía de latencia estricta bajo crecimiento ilimitado.

`start()` ejecuta una pasada inicial y programa un timeout después de terminarla.
El intervalo es una espera entre pasadas, no una frecuencia que acumule trabajo.
Las llamadas simultáneas a runOnce comparten la misma promesa; no se superponen
localmente. Otras instancias/procesos siguen coordinándose mediante el procesador
idempotente; esto no es un lock distribuido. No se crea una cola externa.

Un error individual no detiene las cuentas restantes. Los fallos de consulta se
registran y se reintentan en la siguiente pasada periódica, sin bucles inmediatos.
La pérdida de aislamiento detiene nuevas operaciones y cancela la programación.
Los diagnósticos usan console.error, como el backend existente, con evento y
código controlado: no contienen UID, mensajes completos SDK ni credenciales.
El estado operativo distingue cuentas fallidas, marcadores inválidos y errores
de pasada. `processed` cuenta invocaciones resueltas, no garantiza completed:
el resultado final de cada cuenta continúa estando en su marcador persistido.

SIGINT/SIGTERM detienen admisión y timeout, esperan la pasada/operación en curso
y sus recursos, y después cierran HTTP. No se aborta una transacción para parar.
Cada consulta usa clientes dedicados de la factoría segura; el procesador crea
sus propios clientes seguros. No hay clientes arbitrarios ni reutilización de
aplicaciones predeterminadas. Ambos hosts se conservan y se verifican antes de
consultas y cuentas; el conciliador no modifica variables de entorno.

Un reinicio crea una instancia nueva y vuelve a descubrir marcadores persistidos;
el cursor en memoria solo optimiza la exploración. Las pruebas comprueban reemplazo
de instancia y recuperación de pending/firestore sin repetir deleteUser. Esto no
simula un reinicio real de Node ni SIGKILL. Si el backend está apagado no hay
procesamiento; al volver a arrancar con habilitación segura se ejecuta la pasada
inicial. Las operaciones pendientes no se pierden por detener el componente.

La observación P3 se corrigió localmente: ambos cierres se intentan; si el trabajo
falló, un fallo de cierre se registra sin sustituir su error original. Si solo
falla el cierre se devuelve DELETION_CLIENT_CLEANUP_FAILED, sin mensajes SDK.
Las pruebas comprueban ambas situaciones sin debilitar la factoría.

Para reproducir: Node 24, Java 21 y Firebase CLI disponibles, luego ejecutar
`npm run lint`, `npm run build`, `npm run test:coverage`, `npm run test:integration`
y `npm run test:integration:deletion`, estas dos últimas secuencialmente. La suite
conjunta verifica descubrimiento SDK real, límites, reintentos futuros, elegibles
tras páginas futuras, error individual, reinicio de instancia y estado durable.
Las pruebas unitarias separadas usan reloj, temporizadores y dependencias simuladas.
El launcher apaga los emuladores al finalizar; los tests cierran cada conciliador.
El conciliador sigue deshabilitado en producción y DELETE no es una funcionalidad
pública terminada. Las protecciones realtime corresponden a TS-01.4D.

Verificación de TS-01.4C.2 con Node 24.18.0/npm 11.16.0: lint y build
correctos; 310 unitarias/HTTP, 31 Firestore y 33 conjuntas aprobadas: 374 casos.
Se conservan los 336 anteriores y se añaden 27 del conciliador, 3 del ciclo de
vida HTTP, 2 de P3 y 6 conjuntos. La suite conjunta pasó dos ejecuciones reales.
Cobertura: instrucciones/líneas 97,83 %, ramas 90,65 %, funciones 87,17 %.
El control de aislamiento también se verifica inmediatamente antes de programar
un temporizador, incluido el cambio de entorno durante el cierre de una pasada.
Los emuladores terminaron automáticamente; no hubo commits ni cambios de dependencias.

## Correcciones P2: aplicación principal y arranque HTTP

La aplicación principal se llama `teamspeak-api`. `config/firebase.ts` busca solo
ese nombre y verifica el project ID y la credencial configurada antes de reutilizarla.
No selecciona `getApps()[0]`, ni adopta aplicaciones temporales o arbitrarias.
Una colisión de nombre con otra configuración se rechaza. La configuración con
cuenta de servicio en desarrollo y ADC en producción se conserva exclusivamente
para la API principal; el procesador y conciliador no utilizan esa ruta.

Para la suite conjunta, la API principal se construye mediante sus propios getters,
con la misma validación estricta del entorno demo, credencial sintética y Firestore
local explícito. Esto sustituye la antigua dependencia de una aplicación de fixture
registrada antes que las demás; no añade credenciales reales ni ADC a las pruebas.
La suite Firestore anterior conserva sus clientes inyectados de fixture. Las 17
regresiones de P1 y los casos de P3 permanecen separados y vigentes.

La factoría temporal conserva su proyecto, credenciales, destinos y cierre propios.
Una pasada puede cerrar sus aplicaciones sin invalidar Auth/Firestore principales.
`closeFirebase()` solo cierra recursos de la aplicación principal cuya propiedad
coincide con la configuración; lo invoca el propietario HTTP después de cerrar HTTP,
nunca el conciliador. No borra documentos ni identidades.

`server.ts` exporta `startApiServer()` sin efectos al importarlo. La ejecución como
entrada Node inicia HTTP después de validar la configuración. Solo el callback
`listening` inicia el conciliador; la promesa `ready` indica que ese arranque terminó.
Los errores de consulta recuperables conservan el contrato del conciliador:
se registran y se programa otra pasada, sin fallar la inicialización HTTP. Una
configuración insegura o un rechazo de start activa la ruta fatal de cierre.

Las excepciones síncronas de listen, errores anteriores a listening (incluidos
EADDRINUSE/EACCES), rechazos durante la inicialización y errores HTTP fatales
posteriores convergen en una única parada idempotente. Se detiene y espera el
conciliador, se intenta cerrar HTTP y después los recursos principales de Firebase.
Un fallo de cierre no impide intentar los demás ni sustituye el error original de
inicialización. Si no existe un fallo original, los fallos de cierre se notifican
con SERVER_SHUTDOWN_FAILED. Los registros solo contienen eventos/códigos controlados.
La entrada Node establece una salida no exitosa ante errores fatales.

SIGINT/SIGTERM se atienden también durante el arranque. Una parada ya iniciada
impide arrancar la conciliación cuando llegue listening. Si la pasada inicial
está activa se espera el trabajo admitido. Las pruebas de ciclo de vida utilizan
eventos y dependencias controladas, sin puertos reales ni pausas arbitrarias.
Las pruebas de propiedad crean SDK reales sin solicitudes remotas y verifican
que cerrar una aplicación temporal no produce app/app-deleted en la principal.

Verificación tras ambos P2: Node 24.18.0/npm 11.16.0; lint/build correctos;
328 unitarias/HTTP, 31 Firestore y 33 conjuntas: 392 aprobadas. Se conservan
los 374 casos anteriores y se añaden 18 regresiones (5 de propiedad real del
SDK y 13 adicionales de arranque/cierre; server.test.ts contiene ahora 16 casos).
Las pruebas Firebase existentes se adaptaron al nombre y propiedad explícitos,
sin eliminar sus cuatro escenarios de credenciales, reutilización y fallo seguro.
Cobertura: instrucciones/líneas 97,38 %, ramas 90,77 %, funciones 87,77 %.
P1 conserva sus 17 regresiones y P3 sus dos casos. Los emuladores se cerraron
al terminar; no se efectuaron solicitudes a Firebase de producción ni commits.
