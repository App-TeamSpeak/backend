# TeamSpeak Realtime Backend

Gateway Socket.IO para presencia de participantes, chat en tiempo real y señalización WebRTC.

## Eventos

| Dirección | Evento | Payload mínimo |
| --- | --- | --- |
| cliente → servidor | `room:join` | `{ roomId }` |
| cliente → servidor | `room:leave` | — |
| cliente → servidor | `chat:send` | `{ text }` |
| servidor → cliente | `room:joined` | `{ roomId }` |
| servidor → cliente | `room:participant-joined` | `{ userId }` |
| servidor → cliente | `room:participant-left` | `{ userId }` |
| bidireccional | `webrtc:offer`, `webrtc:answer`, `webrtc:ice-candidate` | señal WebRTC |
| bidireccional | `media:state`, `screen:state` | estado del usuario |

La conexión requiere `socket.handshake.auth.token` con un Firebase ID token. La persistencia del historial queda en `backend-api`.

## TS-01.4D.1: infraestructura Firebase propia

`src/config/firebase.ts` es el único propietario de la aplicación estable
`teamspeak-realtime`. Expone `initializeFirebase()`, `verifyFirebaseIdToken(token)`, `getFirebaseInfo()`,
`getFirestoreDb()` y `closeFirebase()`. Los getters son perezosos y reutilizan
los clientes del servicio; no crean una aplicación por conexión Socket.IO.
Importar el módulo no construye clientes ni hace solicitudes.

No se selecciona la primera aplicación registrada ni se adopta una aplicación
externa, aunque tenga el nombre o proyecto correctos. El nombre está reservado
al módulo propietario; una aplicación preexistente cuya procedencia no puede
acreditarse se rechaza con FIREBASE_APPLICATION_COLLISION. Las llamadas repetidas
al mismo módulo reutilizan sus recursos. Si desaparece su registro se rechaza
FIREBASE_APPLICATION_OWNERSHIP_LOST, en vez de mezclar generaciones de clientes.

### Configuración normal y proyecto compartido

Se conservan las cuentas de servicio: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL
y FIREBASE_PRIVATE_KEY. Los saltos de línea escapados de la clave siguen siendo
admitidos. Los campos Firebase opcionales vacíos se consideran ausentes. No se
introduce un fallback a Application Default Credentials.

FIREBASE_EXPECTED_PROJECT_ID expresa el proyecto esperado por el despliegue:
si se proporciona debe coincidir con FIREBASE_PROJECT_ID; es obligatorio en
producción y opcional en desarrollo. El despliegue debe proporcionar el mismo
valor compartido a:

- backend-api: FIREBASE_PROJECT_ID.
- backend-realtime: FIREBASE_PROJECT_ID y FIREBASE_EXPECTED_PROJECT_ID.

Ambos clientes Firestore usan la base `(default)`. La comparación local de las
variables de realtime no verifica por red la configuración efectiva de backend-api
ni sus permisos IAM. No se confirmó un proyecto real compartido: queda como
verificación operacional previa al despliegue. No se inventa un identificador
real ni se modifican archivos `.env`. No deben publicarse credenciales en logs.

El modo normal rechaza variables de emulador heredadas, en lugar de permitir que
el SDK cambie de destino implícitamente. Una configuración inválida devuelve
FirebaseConfigurationError con código controlado. Los errores de parseo de la
cuenta de servicio se traducen sin incluir la clave ni mensajes internos del SDK.

### Modo aislado de pruebas

Solo está permitido con todas estas condiciones simultáneas:

- NODE_ENV=test.
- TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS=true.
- FIREBASE_PROJECT_ID, FIREBASE_EXPECTED_PROJECT_ID y GCLOUD_PROJECT exactamente
  `demo-teamspeak-tests`.
- DOTENV_CONFIG_PATH=/dev/null.
- FIREBASE_AUTH_EMULATOR_HOST y FIRESTORE_EMULATOR_HOST como `127.0.0.1:<puerto>`,
  sin protocolo, con puertos distintos y comprendidos entre 1024 y 65535.
- Ausencia de GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY, FIREBASE_CONFIG y FIREBASE_TOKEN no vacíos.

Los clientes se construyen después de validar el entorno. Auth pertenece a la
aplicación dedicada con una credencial sintética local. El SDK instalado fija
su URL del emulador al construirlo, pero también consulta el modo emulador
al verificar tokens; por ello se revalida la configuración en cada operación. Firestore emulado se construye con la API
pública `new Firestore`, proyecto demo, host/puerto explícitos, `ssl: false` y
credenciales sintéticas sin una clave válida. El módulo posee ambos clientes;
la construcción directa evita la limitación de la factoría Firestore de Admin
con credenciales locales personalizadas. En modo normal se usa getFirestore(app).
No se accede a propiedades privadas del SDK para proteger la ejecución.

Cambiar la configuración después de cargarla, incluso antes de construir el
primer cliente, provoca FIREBASE_CONFIGURATION_CHANGED. Las comprobaciones se
repiten en los getters; no se reutilizan clientes construidos antes del modo
seguro. Este módulo no acepta instancias SDK suministradas por el llamador.
No contiene procesadores, métodos de eliminación ni privilegios especiales
para eliminación. Los SDK Admin conservan las capacidades ordinarias de sus
credenciales; los permisos reales siguen dependiendo de IAM y no se verifican
con los emuladores. Las futuras operaciones de accountDeletions serán lecturas.

### Authentication y alcance pendiente

`verifyToken(token)` usa el cliente propio y conserva verifyIdToken(token) sin
checkRevoked. No cambian el UID, AUTH_REQUIRED/AUTH_INVALID ni los eventos.
La evaluación de verifyIdToken(token, true), la consulta del marcador en el
handshake y los guards de eventos corresponden a TS-01.4D.2. Las suscripciones
y la desconexión por UID corresponden a TS-01.4D.3. Esta subetapa todavía no
bloquea conexiones por eliminación y no completa la seguridad realtime.
DELETE y el conciliador de backend-api no se modifican ni se habilitan públicamente.

### Ciclo de vida

Para un arranque explícito que necesite ambos clientes, llamar a
`await initializeFirebase()`. Si falla una inicialización parcial, se intentan
cerrar sus recursos, se conserva el error original y un fallo secundario se
registra mediante evento y código controlados. No se cambia globalmente
server.ts ni se agregan temporizadores o manejadores de señales en esta etapa.

El propietario debe llamar a `await closeFirebase()` en su cierre o finally.
Primero se intenta terminar Firestore y después eliminar únicamente su aplicación;
un error no impide el segundo intento. Las llamadas concurrentes de cierre
comparten una promesa. Una aplicación ajena con otro nombre o que reemplace el
registro propio nunca se elimina. Después del cierre los getters rechazan
FIREBASE_CLIENTS_CLOSED; no resucitan clientes durante una parada. Para un nuevo
ciclo se utiliza una nueva instancia del módulo/proceso. La conexión completa
con el cierre de sockets y futuros observadores se realizará en TS-01.4D.3.

### Pruebas

Requisitos: Node.js 24, dependencias existentes instaladas, Firebase CLI en PATH
(o ruta absoluta en TEAMSPEAK_FIREBASE_CLI) y Java 21 para los emuladores actuales.
No se necesita login. No se añadió socket.io-client ni se cambiaron dependencias.

Desde backend-realtime:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
npm run lint
npm run typecheck
npm run build
DOTENV_CONFIG_PATH=/dev/null npm run test:coverage
node scripts/firebase-integration.cjs
# Si los puertos están ocupados, no detener servicios ajenos:
TEAMSPEAK_FIRESTORE_PORT=8082 TEAMSPEAK_AUTH_PORT=9100 node scripts/firebase-integration.cjs
```

El launcher crea un entorno mediante lista permitida, sin heredar credenciales,
ADC, NODE_OPTIONS o `.env`; fija el proyecto demo y ambos hosts coherentemente
para CLI, SDK y sondas. CLI usa configuración vacía y logs temporales; la caché
de emuladores queda en `/tmp`. Firebase emulators:exec detiene los emuladores
al finalizar. Los puertos predeterminados son Firestore 8081 y Auth 9099.
No se cambian Docker Compose ni configuraciones de otros proyectos.

Las pruebas reales usan SDK y ambos emuladores, tras sondas locales con timeout.
Crean solo identidades/documentos ficticios, verifican un token emitido y leen
marcadores presentes/ausentes sin interpretar autorización. Reinician únicamente
el proyecto demo local entre casos y cierran los recursos propios. No ejecutarlas
en paralelo con las suites de backend-api sobre el mismo proyecto demo.
La configuración de integración está separada de la unitaria y usa orden
mezclado con semilla 42. Las reglas locales deniegan acceso de clientes no Admin;
no son reglas de producción ni una prueba de IAM.

Las unitarias de construcción utilizan SDK reales sin solicitudes remotas;
las fallas parciales y errores de cierre usan mocks. Las inspecciones privadas
presentes en una regresión solo acreditan el destino antiguo; no forman parte
del mecanismo de seguridad. Los emuladores no acreditan firmas de tokens,
permisos, cuotas o conectividad de producción. Los tres casos HTTP anteriores
se conservan; no hay pruebas de transporte Socket.IO añadidas en esta etapa.


Resultado previo a la corrección P2 de TS-01.4D.1 con Node 24.18.0/npm 11.16.0: lint, typecheck y build
correctos; 47 pruebas unitarias/HTTP y 7 de integración real: 54 aprobadas.
Los tres casos HTTP existentes permanecen. Cobertura unitaria global: 70,49 %
instrucciones/líneas, 94,06 % ramas y 88,23 % funciones. El módulo Firebase
alcanza 100 % de instrucciones/líneas y 97,11 % de ramas; Socket.IO no se amplió
ni se prueba como transporte en esta subetapa. Emuladores cerrados al finalizar.

### Corrección P2: referencias Auth conservadas

Auth permanece privado. La interfaz pública de autenticación es
`verifyFirebaseIdToken(token)`; `verifyToken(token)` delega en ella sin activar
checkRevoked. Cada llamada valida la configuración vigente y llama al SDK
sin un await intermedio. Conservar la función no conserva acceso directo a Auth.
initializeFirebase devuelve void y getFirebaseInfo devuelve solamente una copia
congelada del nombre y proyecto; no devuelve App, Auth ni credenciales.

Las regresiones interceptan http.request, https.request, http2.connect y fetch
antes de transmitir. Una referencia conservada rechaza cambios de host, proyecto,
habilitación o cierre sin intentar red. La suite real permite exclusivamente los
dos destinos HTTP de emuladores configurados y bloquea esos transportes hacia
otros destinos. Los clientes usados para crear identidades ficticias pertenecen
a una aplicación separada, únicamente dentro de las pruebas.

La validación al iniciar una operación no hace transaccionales las variables
globales de Node: no garantiza aislamiento absoluto frente a código que las
modifique mientras una operación asíncrona ya está en curso. La configuración
debe permanecer inmutable durante toda la operación. La interceptación es una
defensa adicional de pruebas, no un sandbox de red del sistema operativo ni una
garantía para transportes distintos. No se modifica globalmente la red del
servicio en producción. El cierre coordinado de operaciones activas pertenece
a la integración del ciclo de vida posterior.

Resultado de la corrección P2 con Node 24.18.0/npm 11.16.0: lint, typecheck
y build correctos; 54 pruebas unitarias/HTTP y 9 de integración real aprobadas
(63 en total). Se conservan los 54 casos anteriores y se añaden 9: siete
unitarios y dos de integración. Cobertura global: 71,26 % instrucciones/líneas,
94,16 % ramas y 89,47 % funciones. firebase.ts: 100 % instrucciones/líneas,
97,16 % ramas y 92,85 % funciones. La suite real comprobó el bloqueo local
de los cuatro transportes y finalizó con el cierre de ambos emuladores.

## TS-01.4D.2: autorización de conexiones y eventos

El handshake exige un token y llama a verifyToken(token, true). La operación
encapsulada verifica el ID token y su revocación, consulta la identidad mediante
Admin y rechaza usuarios eliminados/deshabilitados cuando Firebase lo detecta.
El UID procede exclusivamente del token verificado. Antes de aceptar la conexión
se consulta accountDeletions/{uid}. Toda existencia bloquea: pending, blocked,
completed, estado desconocido o documento malformado. Nunca se recrea permiso
por interpretar el contenido. No se escribe en esa colección.

Los ocho eventos room:join, room:leave, chat:send, webrtc:offer, webrtc:answer,
webrtc:ice-candidate, media:state y screen:state comparten el mismo wrapper.
Cada evento vuelve a consultar el marcador con el UID de socket.data.user, sin
caché de ausencia. El servicio usa una lectura acotada de la infraestructura
Firebase propia, revalidando configuración antes y después de la lectura; no
conserva clientes suministrados por el llamador. Auth continúa siendo privado.
La operación de verificación revalida también al finalizar.

La espera de Authentication y la lectura Firestore tienen un límite de 5 segundos
cada una. Ante error o timeout no se acepta la conexión ni se ejecuta el evento.
El timeout no cancela la solicitud SDK subyacente; una respuesta tardía no ejecuta
el handler y su rechazo queda gestionado. El handshake completo puede esperar
hasta aproximadamente 10 segundos (dos fases). Los errores no incluyen mensajes
internos, tokens ni contenido del marcador.

| Código | Significado |
| --- | --- |
| AUTH_REQUIRED | Token ausente |
| AUTH_INVALID | Token inválido/revocado o identidad eliminada/deshabilitada |
| ACCOUNT_UNAVAILABLE | Existe un marcador de eliminación |
| AUTHORIZATION_UNAVAILABLE | No se pudo comprobar autorización, timeout o configuración insegura |
| ROOM_ID_REQUIRED | Payload de entrada a sala inválido |
| MESSAGE_INVALID | Mensaje inválido, vacío, mayor de 2000 caracteres o sin sala |
| EVENT_FAILED | Error interno al ejecutar un handler |

El rechazo del handshake conserva message con el código y añade data.code.
Los eventos rechazados emiten error:message con {code, message}. Si el cliente
suministra un acknowledgement, recibe {ok:false,error:{code,message}}; los eventos
válidos responden {ok:true}. No es obligatorio enviar acknowledgements y se
conservan los eventos existentes de respuesta/broadcast.

Detectar un marcador bloquea localmente la sesión y desconecta ese socket.
Los guards comprueban de nuevo ese bloqueo y la conexión tras la autorización y
tras esperas de las transiciones de sala, antes de nuevos efectos. Una detección
concurrente impide que otro evento pendiente continúe. Un fallo transitorio de
Firestore deniega el evento actual; el siguiente intenta autorizar nuevamente.
La limpieza interna al desconectarse nunca requiere una lectura Firestore.

Hay una sola sala de aplicación activa por socket. Cambiar de sala abandona la
anterior, mantiene roomId consistente y serializa transiciones para adaptadores
asíncronos. Repetir la misma sala no duplica la notificación de participante.
Payloads de sala y chat nulos, arrays, tipos incorrectos o campos no string se
rechazan sin destructuración insegura. Los payloads de señalización siguen
siendo opacos y no se añaden funciones ni contratos WebRTC.

No hay atomicidad entre la lectura Firestore y una emisión. Un evento autorizado
puede competir con la creación posterior del marcador. Sin un nuevo evento no
se detecta el bloqueo de un socket inactivo: onSnapshot, registro por UID y
desconexión proactiva quedan para TS-01.4D.3. Esta etapa no retira automáticamente
al usuario de todas sus sesiones ni comprueba revocación en cada evento.

Coste: aproximadamente una lectura de marcador por intento de conexión y una
por evento protegido, además de la comprobación Auth con revocación por conexión.
ICE puede producir muchas lecturas (N candidatos implican aproximadamente N
lecturas). No se añadió caché negativa, Redis ni otra infraestructura.

Las pruebas de socket usan WebSocket nativo de Node 24 y un cliente mínimo de
Engine.IO v4/Socket.IO para el namespace predeterminado, solo en tests.
No se necesita instalar socket.io-client. Se comprueba el transporte WebSocket
real; no se cubren polling, upgrade, reconexión automática del cliente oficial
ni adaptadores distribuidos. La reconexión se prueba creando una conexión nueva.
Las unitarias de guards usan servicios simulados; las integraciones conservan
los nueve casos anteriores y añaden conexiones reales a Authentication/Firestore
Emulator, marcadores de todos los tipos, revocación, aislamiento entre usuarios
y rechazo tras el handshake. Solo se conectan sockets a 127.0.0.1. Se utiliza el
mismo launcher y comandos documentados arriba, sin credenciales reales.

DELETE y el conciliador de backend-api permanecen sin cambios y sin habilitación
pública. Las limitaciones operacionales de configuración inmutable, IAM y
verificación del proyecto compartido documentadas en TS-01.4D.1 siguen vigentes.

Resultado TS-01.4D.2 con Node 24.18.0/npm 11.16.0: lint, typecheck y build
correctos; 111 pruebas unitarias/HTTP/transporte con servicios simulados y 19
integraciones con ambos emuladores aprobadas: 130 en total. Se conservan los
63 casos anteriores; se añaden 57 casos en la suite unitaria y 10 integraciones.
Cobertura global: 96,68 % instrucciones/líneas, 93,05 % ramas y 93,54 % funciones.
Firebase y socket.ts alcanzan el 100 % de instrucciones/líneas; sus coberturas de
ramas son 96,42 % y 90,41 %, respectivamente. Los puertos de los emuladores
quedaron libres al finalizar. La regresión de host Firestore conservado también
está cubierta; la restauración global de transportes del setup sigue pendiente.

### Corrección P2: admisión acotada de eventos

Cada socket admite como máximo dos eventos protegidos en vuelo
(MAX_IN_FLIGHT_AUTHORIZATIONS_PER_SOCKET). La admisión es síncrona y común a
los ocho eventos, antes de iniciar Firestore. El exceso recibe AUTHORIZATION_BUSY
por error:message y por su acknowledgement, si lo suministró. No inicia lecturas,
no ejecuta handlers y no se encola para ejecución posterior. Una ráfaga puntual
no provoca desconexión; el cliente decide si reintenta después.

startAccountAuthorization separa authorized (resultado limitado a cinco segundos)
de settled (finalización real de la lectura SDK, sin rechazo). Un timeout no
libera la posición mientras la lectura siga pendiente. La posición se libera
una sola vez cuando terminaron tanto la lectura como el evento/handler. Esto
también acota las transiciones de sala con adaptadores lentos. Las respuestas
tardías no reanudan handlers cuyo plazo expiró.

Cada instancia de createRealtimeServer tiene además un presupuesto compartido
de 64 eventos en vuelo (MAX_IN_FLIGHT_EVENT_AUTHORIZATIONS_PER_SERVER). Evita
eludir el límite individual acumulando sockets o sustituyendo conexiones con
lecturas atascadas. Las lecturas de sockets desconectados siguen contabilizadas
hasta terminar; no se mantienen registros por UID ni colas. La limpieza de salas
y desconexión no pasa por la admisión. Al agotarse el presupuesto compartido,
otros sockets reciben AUTHORIZATION_BUSY sin consultar Firestore.

No se afirma cancelación del SDK. Si las 64 lecturas quedan atascadas, los eventos
nuevos fallan cerrados hasta su finalización o hasta que se cierre el cliente SDK
durante el ciclo de vida del servicio. Es un límite de eventos por instancia,
no un rate limiter, una cuota distribuida ni una defensa general frente a
inundaciones de conexiones/handshakes o tráfico de red. El handshake conserva
su comportamiento previo y no consume este presupuesto de eventos. Dos sockets
mantienen presupuestos individuales independientes mientras exista capacidad
compartida. Una carga legítima intensa de ICE puede requerir reintentos y recibirá
rechazos explícitos en vez de una cola creciente.

Las regresiones usan consultas controladas y transporte WebSocket real:
ráfaga de 1000 eventos (dos lecturas admitidas y 998 rechazos con acknowledgement),
todos los eventos, liberación normal/error, timeout con lectura aún activa,
resultados tardíos y presupuesto compartido persistente tras desconexiones.
Los relojes del servicio comprueban el plazo exacto sin esperar cinco segundos;
la prueba de transporte acelera exclusivamente ese temporizador.

Permanecen como mejoras P3 el diagnóstico más preciso de errores de infraestructura
Authentication y la sincronización de aserciones negativas anteriores de
broadcasts. Las nuevas pruebas de ráfagas sí usan una barrera del observador.

Verificación de la corrección P2 con Node 24.18.0/npm 11.16.0: lint, typecheck y
build correctos; 119 pruebas unitarias/HTTP/transporte y 19 integraciones con
Authentication/Firestore Emulator aprobadas (138 en total). Se conservan las
130 anteriores y se añaden ocho regresiones. Cobertura global: 96,93 % de
instrucciones/líneas, 93,50 % de ramas y 93,93 % de funciones. socket.ts mantiene
100 % de instrucciones/líneas y alcanza 91,46 % de ramas. Los emuladores se
cerraron al finalizar.

## TS-01.4D.3: supervisión local de cuentas conectadas

Cada instancia Socket.IO crea un supervisor account-access con un Map local por
UID. Mantiene como máximo una suscripción a accountDeletions/{uid}, compartida por
sus sesiones y por registros todavía en handshake. Un segundo UID tiene su propia
suscripción. No hay registro distribuido, Redis ni comunicación directa con API.

El handshake conserva la comprobación Auth con revocación y la lectura existente.
A continuación registra la sesión y espera el primer snapshot del observador
(hasta cinco segundos adicionales). Solo un snapshot sin documento permite
aceptar la conexión. El primer snapshot con marcador, un error de construcción,
un error terminal o el timeout rechazan la conexión y limpian el registro.
El tiempo máximo de las tres fases puede ser aproximadamente 15 segundos.
Si el transporte se cierra durante la espera, se elimina la sesión provisional.

watchAccountDeletion en el módulo Firebase valida configuración antes de crear
la suscripción y en cada snapshot. Entrega únicamente existencia o un error
controlado, nunca el snapshot, Auth o clientes arbitrarios. El listener se crea
con el Firestore propio ya configurado. Cancelar es idempotente y bloquea callbacks
posteriores; closeFirebase cancela primero todos sus listeners y después termina
Firestore y elimina únicamente su aplicación. Los callbacks cancelados no
reactivan generaciones posteriores.

La existencia de cualquier marcador (incluido malformado, completed o desconocido)
bloquea el UID. El supervisor marca todas sus sesiones como bloqueadas antes de
desconectarlas. Las sesiones activas reciben error:message con ACCOUNT_UNAVAILABLE;
los fallos de supervisión utilizan AUTHORIZATION_UNAVAILABLE. Los diagnósticos
registran evento y código controlados, sin UID, tokens ni mensajes internos del
SDK. No se reintenta indefinidamente un listener que notifica error terminal:
una conexión nueva debe autenticarse y crear supervisión válida otra vez.

Cada socket tiene una señal de cierre que retira su registro. Al desaparecer el
último se cancela la suscripción y se elimina la entrada, sin caché permanente.
La identidad de la entrada protege contra snapshots o errores tardíos del
observador anterior. Cerrar el supervisor impide registros nuevos, bloquea las
sesiones, las desconecta y cancela todas las suscripciones.

Los ocho guards siguen consultando Firestore por evento. Además comprueban el
bloqueo del supervisor y el estado de parada después de sus esperas, incluyendo
joins asíncronos. La desconexión utiliza la limpieza interna de salas existente.
Los límites 2/socket y 64/instancia no cambian: desconectar por marcador o error
del observador no libera lecturas pendientes artificialmente. La suscripción es
un recurso adicional por UID, separado del presupuesto de consultas de eventos.

server.ts ahora expone createRealtimeRuntime(): construirlo crea HTTP/Socket.IO;
importar el módulo no crea recursos ni instala señales. start() abre el listener.
stop() devuelve una promesa compartida: detiene la admisión y actividad protegida,
bloquea/desconecta sockets, cancela observadores, cierra Socket.IO/HTTP, da un
plazo a las lecturas en vuelo y cierra los clientes Firebase propios.
Cada fase de espera tiene un límite de cinco segundos; una lectura atascada
genera diagnóstico y se intenta terminar Firebase sin resetear los contadores.
El ejecutable instala SIGINT/SIGTERM solo al arrancar directamente y termina el
proceso tras su parada, con código de error ante fallo de arranque/cierre.
El código embebido debe manejar un rechazo de stop(); no se promete cancelación
SDK efectiva ni terminación de recursos que ignoren su cierre.

Limitaciones: onSnapshot no es una transacción con Socket.IO. Existe una ventana
entre el commit y su detección; los eventos ya emitidos no se retiran. Durante
particiones o reconexiones internas de Firestore no existe una latencia máxima
estricta; un error terminal notificado sí provoca cierre de las sesiones.
Cada instancia debe supervisar sus sockets: una desconexión local no desconecta
por sí sola sesiones de otro proceso. La revocación Auth sigue comprobándose en
handshake, no mediante una nueva supervisión continua de tokens.

Las pruebas mantienen Node 24, el cliente WebSocket nativo y el launcher
node scripts/firebase-integration.cjs. Las unitarias simulan snapshots para
comprobar generaciones, primer estado, abortos, errores, cancelaciones y cierre.
Las integraciones usan onSnapshot real de Firestore Emulator, identidades
Authentication Emulator y solo demo-teamspeak-tests: crean marcadores persistidos
y comprueban desconexión sin otro evento, dos sesiones del mismo UID, aislamiento
de otro usuario y limpieza de salas. El caso anterior de creación del marcador
tras handshake se adapta a esperar desconexión proactiva, en vez de exigir un
acknowledgement de un evento enviado a una sesión que ahora puede estar cerrada.

DELETE, el procesador y el conciliador permanecen sin cambios y sin habilitación
pública. No se añadieron dependencias. Las observaciones P3 de diagnósticos Auth,
restauración de transportes y pruebas de handlers pendientes siguen pendientes;
la regresión del host Firestore conservado ya se incorporó en TS-01.4D.2.

Resultado TS-01.4D.3 con Node 24.18.0/npm 11.16.0: lint, typecheck y build
correctos; 142 pruebas unitarias/HTTP/transporte y 21 integraciones reales
aprobadas (163 en total). Se conservan los 138 casos anteriores, con la adaptación
del caso de desconexión ya descrita, y se añaden 25 casos. Cobertura global:
97,26 % instrucciones/líneas, 89,88 % ramas y 92,98 % funciones. account-access.ts
y socket.ts alcanzan 100 % de instrucciones/líneas. Los emuladores se cerraron
al finalizar.
