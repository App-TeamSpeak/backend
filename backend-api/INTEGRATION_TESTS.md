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
No se prueba Firebase Authentication: las identidades del servicio son datos
controlados. DELETE permanece fuera de esta etapa.

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
