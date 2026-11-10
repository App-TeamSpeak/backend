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
