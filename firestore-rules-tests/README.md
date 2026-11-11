# Verificación local de Firestore Security Rules — TS-01

La arquitectura es cliente → API → Firestore. El archivo real `../firestore.rules`
deniega toda lectura/escritura directa, incluso al dueño autenticado del perfil.
Firebase Admin omite Security Rules: su acceso exitoso no autoriza a los clientes.

## Ejecución

Requisitos: Node.js 24, dependencias existentes de backend-api, Java 21 y Firebase
CLI ya disponibles. No se requieren nuevas dependencias ni Firebase Client SDK:
la API REST cliente de Firestore aplica Security Rules al recibir un ID token de
Firebase (o ninguna autenticación). No se utiliza el token privilegiado `owner`
en las solicitudes REST que deben ser denegadas.

Desde la raíz backend:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
PATH=/ruta/jre21/bin:$PATH TEAMSPEAK_FIREBASE_CLI=/ruta/firebase node firestore-rules-tests/run.cjs
```

El lanzador reutiliza el supervisor de procesos existente. Requiere el JAR ya
almacenado en `/tmp/teamspeak-integration-tools/emulators/cloud-firestore-emulator-v1.22.0.jar`.
Se ha comprobado con Firebase CLI 15.35.0 y el JRE temporal existente; las herramientas
son externas al repositorio. No descarga componentes ni instala dependencias.

Reserva puertos loopback exclusivos: Firestore 28081, Authentication 29099,
hub 24400, logging 24500 y websocket del emulador 29150. Si alguno está ocupado,
falla antes de iniciar; no detiene procesos ajenos. No debe ejecutarse el archivo
de casos directamente: requiere el manifiesto privado creado por el lanzador.

## Aislamiento y evidencia

- Proyecto exacto `demo-teamspeak-tests`, `NODE_ENV=test`, dotenv `/dev/null`.
- Entorno hijo construido mediante lista permitida: no hereda credenciales, ADC,
  configuración Firebase real ni opciones Node del proceso invocador.
- La CLI añade sus propias variables; un segundo proceso vuelve a construir el
  entorno limpio antes de cargar el SDK. Se reutiliza `integration-ts01/isolation.cjs`
  para validar el entorno y bloquear destinos remotos HTTP, HTTPS, HTTP/2 y fetch.
  Sus flags test-only se necesitan para esa validación; la suite no importa ni
  ejecuta el endpoint, procesador o conciliador de eliminación.
- Firestore Admin se construye con endpoint local, TLS deshabilitado y credenciales
  sintéticas. Se usa exclusivamente para fixtures y para comprobar el bypass Admin.
- Authentication Emulator emite un ID token ficticio y `accounts:lookup` confirma
  que corresponde al UID empleado en los casos autenticados.
- La CLI carga la ruta absoluta del archivo real `firestore.rules`, sin reemplazarlo.
  El informe `:ruleCoverage` del emulador debe devolver exactamente su ruta y contenido.
- Cada rechazo exige HTTP 403 y estado Firestore `PERMISSION_DENIED`. Conexión fallida,
  timeout, reglas permisivas o emulador ausente hacen fallar la suite.
- No se imprimen tokens. Los fixtures propios se eliminan; Admin se termina y la CLI
  detiene sus emuladores. El supervisor espera/cierra únicamente sus grupos de procesos.
  El padre exige además un comprobante privado de finalización del runner.

## Casos

35 pruebas: 16 anónimas, 16 autenticadas, una de operaciones Admin, una de reglas
cargadas y una de bloqueo remoto. Incluyen perfiles propios/ajenos, listados,
creación, actualización, eliminación y reservas; también marcadores existentes en
el modelo y una ruta sintética anidada para comprobar el wildcard global.
Las rutas sintéticas son fixtures de reglas, no nuevas colecciones de negocio.

Las operaciones denegadas no alteran los fixtures; no dependen de la ejecución de
otro caso. Los emuladores son nuevos en cada invocación y no importan datos previos.

Esto acredita reglas **cargadas y verificadas localmente**. No acredita reglas
publicadas, proveedores Google/Email configurados ni políticas efectivas del proyecto
real. No habilita DELETE públicamente. Los resultados de esta suite se reportan por
separado de las 572 pruebas históricas; no implica que todas se hayan repetido.
