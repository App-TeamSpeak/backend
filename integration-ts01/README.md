# Validación integral TS-01

Ejecutar desde la raíz del backend con Node 24 y dependencias ya instaladas:

    source "$HOME/.nvm/nvm.sh"
    nvm use 24.18.0
    PATH=/ruta/jre21/bin:$PATH TEAMSPEAK_FIREBASE_CLI=/ruta/firebase node integration-ts01/run.cjs

No requiere login, credenciales ni dependencias nuevas. El JAR existente
cloud-firestore-emulator-v1.22.0.jar debe estar en
/tmp/teamspeak-integration-tools/emulators; el lanzador falla si no está disponible.
Java 21 y Firebase CLI deben estar previamente disponibles. No se deben descargar
componentes como parte de esta validación sin autorización.

## Arquitectura y puertos

El lanzador compila ambos servicios con sus compiladores instalados y ejecuta
node:test nativo. Carga los módulos compilados reales de ambos backends, inicia
startApiServer y createRealtimeRuntime y usa HTTP real y el cliente WebSocket
de pruebas existente. Los procesadores/conciliadores se llaman por su interfaz
interna real, sin endpoints administrativos adicionales. No hay mocks de SDK,
Firestore, transacciones, observadores o servidores.

Ambos SDK utilizan demo-teamspeak-tests, Auth 127.0.0.1:19099 y Firestore
127.0.0.1:18081. API escucha en 19801; realtime obtiene un puerto efímero local.
El hub usa 14400, logging 14500 y el websocket de Firestore 19150.
Se verifica que los seis puertos estén libres antes de iniciar. Si están ocupados,
se rechaza la ejecución; no se detiene otro servicio ni se usa su emulador.
No ejecutar dos copias simultáneas.

Las aplicaciones teamspeak-api y teamspeak-realtime conservan su propiedad.
Las identidades se crean con una aplicación fixture aparte y credencial owner
sintética. Se verifica el proyecto efectivo de ambos clientes y una intención
escrita mediante DELETE HTTP provoca el snapshot/desconexión del otro backend.
No se adopta una aplicación ajena ni se modifica configuración de despliegue.
El conciliador automático del servidor API permanece desactivado durante los
escenarios principales para que el estado pending se pueda comprobar antes de
procesarlo. Solo el escenario de recuperación habilita su instancia test-only.

## Seguridad previa a eliminación

El proceso de pruebas carga isolation.cjs antes de cualquier SDK. Exige Node 24,
NODE_ENV=test, DOTENV_CONFIG_PATH=/dev/null, proyecto demo exacto en tres variables,
ambos hosts loopback con puertos válidos y distintos y habilitación explícita de
eliminación y emuladores realtime. Rechaza credenciales, ADC y NODE_OPTIONS.

El proceso hijo recibe una lista permitida de variables, no el entorno original.
Los transportes HTTP, HTTPS, HTTP/2, fetch y WebSocket del proceso de pruebas
rechazan destinos fuera de los emuladores y servidores locales registrados.
Las redirecciones fetch están prohibidas. Es interceptación dentro del proceso,
no un sandbox del sistema operativo para código arbitrario ni una garantía de
egress de la CLI. La CLI usa configuración temporal vacía y no recibe credenciales.

Los escenarios destructivos pasan también por las condiciones existentes de API
y su factoría segura. No se sustituye el marcador principal por una escritura
directa. No se vacía ninguna colección ni todo el proyecto: cada ejecución crea
UID/usernames ficticios únicos; el procesador solo elimina esos usuarios.
Un marcador malformado es una fixture negativa independiente, expresamente
separada del flujo principal HTTP.

## Disponibilidad y limpieza

La CLI administra exclusivamente los emuladores iniciados por esta ejecución
mediante emulators:exec. Antes de iniciar los backends se exige HTTP satisfactorio
de Auth y Firestore. Cada petición mantiene tres segundos; la ventana funcional
total es 15 segundos por servicio, con comprobaciones cada 150 ms tras un fallo.
Esto permite reintentar una primera respuesta fría sin modificar los cinco
segundos de seguridad de la aplicación ni atribuir una causa al timeout histórico.
Se registra el destino y el tiempo de disponibilidad. Una salida prematura de la
CLI impide ejecutar pruebas; una caída posterior causa fallo de sonda/SDK y código
no cero. stdout/stderr se heredan; logs y configuración de CLI se crean en un
directorio privado de /tmp que el propietario limpia al finalizar.

Los hooks cierran clientes WebSocket, ambos runtimes y la aplicación fixture.
Los fallos de limpieza se reportan como fallos de prueba. El lanzador devuelve
el código de las pruebas y la CLI detiene los emuladores. Existen límites externos
de tiempo (180 s para pruebas, 240 s para la CLI); no son cancelación de operaciones
SDK ni deben usarse como mecanismo normal de cierre. No se matan servicios ajenos.

## Escenarios y alcance comprobado

1. A–D/F/G: crear/consultar/actualizar perfil por HTTP; dos UID; handshake y chat
   reales; DELETE con token reciente; marcador persistido; desconexión sin evento
   adicional; B permanece autorizado; GET/POST/PATCH de A rechazados; reconexión
   rechazada; procesamiento real, limpieza de perfil/reserva/Auth, completed e
   idempotencia; token de identidad eliminada ya no permite acceso.
2. E: dos sesiones de A desconectadas por el DELETE de API y B en la misma sala
   permanece conectado.
3. F: marcador malformado persistido bloquea ambos backends.
4. H: hook de fallo existente antes del commit de limpieza; Auth ya eliminado,
   pending/firestore persistido, backoff respetado sin adelantar relojes ni editar
   timestamps, espera real de aproximadamente 30 s y nueva instancia de conciliador
   que completa la operación. Es reinicio de componente, no de proceso Node.
5. Errores: token inválido, rechazo de transportes Auth, disponibilidad Firestore
   que falla de forma acotada, bloqueo de destinos remotos y rechazo del procesador
   con configuración incompleta, sin eliminar la identidad.

6. Cierre de realtime con un socket observado activo: desconexión, limpieza de
   salas, stop idempotente y API todavía utilizable con su aplicación propia.

Los fallos de transporte se inducen por la frontera de red de pruebas, no matando
un emulador. No equivalen a una prueba de caída real del proceso ni de partición
de red del sistema operativo. El hook del procesador inyecta un fallo controlado;
las operaciones SDK y el estado persistido son reales. No se duplican aquí todas
las unitarias, la ráfaga de 1000 eventos ni las condiciones negativas ya cubiertas
por las suites anteriores. No hay mocks en esta suite conjunta.

No se prueban polling/upgrade del cliente oficial, múltiples procesos realtime,
IAM o conectividad de producción. Las ventanas de onSnapshot, solicitudes SDK
no cancelables y restricciones destructivas siguen vigentes.
DELETE continúa deshabilitado públicamente. Esta validación no cambia esa política.

Ejecutar esta suite separadamente de los otros lanzadores. Aunque los puertos
reservados mantienen separados los datos, la CLI puede advertir sobre varias
suites con el mismo project ID porque comparte su localizador temporal de hub.
No se deben interpretar esas advertencias como una conexión entre las bases.

Verificaciones realizadas con Node 24.18.0: API lint/typecheck/build y 328 pruebas
unitarias/HTTP, 31 integraciones Firestore y 33 integraciones de eliminación;
realtime lint/typecheck/build y 142 pruebas unitarias/HTTP/transporte más 21
integraciones con ambos emuladores. La suite conjunta añade seis pruebas de
escenarios (no cuentan como pruebas unitarias individuales todas sus aserciones).

## Corrección P2 del lanzador

Para ejecutar primero las regresiones sin Firebase, red ni operaciones destructivas:

    node integration-ts01/run.test.cjs

Se añadieron once pruebas aisladas de resultados de procesos, recibos, timeout,
señales, error de ejecución, interrupción y cierre de descendientes propios.
La regresión usa spawnSync real: un hijo captura SIGTERM y sale 0, pero devuelve
ETIMEDOUT. La evaluación anterior devolvía éxito; resultCode exige ausencia de
error y señal y status exactamente 0. Se comprueba también que el padre salga 1.

Las etapas reales ahora usan spawn asíncrono supervisado para poder tramitar
SIGINT/SIGTERM mientras se ejecuta el hijo. La misma evaluación central se aplica
a compilaciones, runner y CLI. Cualquier timeout, señal, fallo de spawn o salida
no cero detiene la secuencia con error de fase. No se deduce éxito de stdout.

Cada etapa inicia su propio grupo POSIX. Un timeout o interrupción envía SIGTERM
solo a ese grupo; tras tres segundos puede escalar a SIGKILL. Después del cierre
del hijo se comprueba y limpia cualquier miembro restante del grupo. Si no se
puede confirmar su desaparición se registra CLEANUP_INCOMPLETE y se conserva
el fallo. No se buscan procesos por nombre ni se termina un grupo ajeno.
El lanzador requiere POSIX; no pretende soportar Windows sin un supervisor
equivalente de árboles de procesos.

Una CLI que sale 0 tampoco basta para declarar éxito. El lanzador crea un
directorio privado 0700 y un manifiesto por ejecución con nonce aleatorio.
El modo interno valida ese manifiesto y crea completed.json (0600) solo cuando
el runner ha salido correctamente y su grupo se ha limpiado. El padre exige
además un resultado correcto de la CLI y el recibo con el nonce actual.
Un recibo ausente, antiguo, incompleto o acompañado de timeout no acredita éxito.
El propietario elimina su directorio temporal al finalizar. Los errores de
limpieza no convierten un fallo en éxito ni sustituyen el diagnóstico principal.

Las salidas de los hooks de limpieza de ts01.test.cjs forman parte del código
de salida de node:test; si falla un hook, no se emite el recibo. Las señales
manejadas intentan cerrar todos los grupos propios. SIGKILL al lanzador, caída
del sistema o procesos que abandonen deliberadamente esos grupos no permiten
prometer limpieza absoluta; esto no se considera una finalización satisfactoria.

La compatibilidad exacta entre otras versiones de CLI y el JAR sigue siendo P3.
No se actualizó CLI ni se descargó un JAR; se conserva el requisito del artefacto
existente y la versión de herramientas ya utilizada en esta sesión.

Resultado de verificación P2 con Node 24.18.0: las 392 pruebas de API, las 163
pruebas realtime, los seis escenarios conjuntos y las once regresiones aisladas
del lanzador aprobaron (572 en total). Lint, typecheck y build de ambos backends
fueron correctos. El runner y la CLI terminaron correctamente, el padre validó
el recibo de esta ejecución y eliminó su directorio privado al finalizar.

## Evidencia adicional US-01

La misma suite incorpora cuatro casos de registro manual desde Authentication
Emulator mediante REST cliente: recorrido POST/GET y persistencia/idempotencia,
aislación de identidades y campos protegidos, competencia concurrente por username
y rechazo de correo duplicado. Se conservan los seis escenarios TS-01 anteriores;
el lanzador ejecuta diez casos en total. No se modifican contratos ni servicios.
Consulte `../docs/us-01-backend.md` para la matriz y decisiones funcionales pendientes.
