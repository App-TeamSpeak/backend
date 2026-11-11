# Diagnóstico local del Quality Gate — TS-01 / PR #5

Análisis remoto inspeccionado: HEAD `af2e5040118e807d9ce23d58e951cf52f0bf755b`, GitHub Actions `42952166460` y SonarCloud `App-TeamSpeak_backend`, PR 5. Solo se consultaron API de lectura; no se modificó el PR, el Quality Gate ni el estado de issues.

## Causa y configuración

Los registros de CI confirman la importación de ambos LCOV. Las rutas `SF:src/...` se resuelven por servicio; no se detectaron fuentes inexistentes al contrastarlas con su directorio de reporte. Sonar mide líneas ejecutables y condiciones de código nuevo; la cobertura global de instrucciones V8 no es esa misma métrica.

El reporte remoto contiene 2208 líneas nuevas a cubrir (789 sin cubrir) y 892 condiciones (79 sin cubrir): `(2208 - 789 + 892 - 79) / (2208 + 892) = 72 %`.

691 líneas sin cobertura corresponden a tests y utilidades de `src/integration/`, clasificados incorrectamente como fuentes productivas. Ahora se incluyen como tests de Sonar y se separan de las fuentes principales, al igual que `*.test.ts`. Siguen dentro de `sonar.tests` y del análisis de pruebas. No se añade ninguna exclusión de cobertura ni se retiran scripts ejecutables del análisis.

Sobre los contadores remotos anteriores, esa clasificación produce una estimación de 92,65 %: 1517 líneas a cubrir, 98 sin cubrir, 892 condiciones y 79 sin cubrir. Es una estimación, no un nuevo resultado Sonar ni una aprobación del Gate. Los dos lanzadores CJS conservan 75 líneas nuevas sin cobertura en el reporte anterior; no se ocultan.

## Hallazgos remotos y tratamiento

La API del Gate devuelve Reliability 4 (D), Security 3 (C), Coverage 72 %. Esto difiere de la referencia inicial a Reliability C. No se detectaron Security Hotspots (0).

| Archivo / línea original | Regla | Tipo y severidad remotos | Tratamiento local |
|---|---|---|---|
| `backend-realtime/src/integration/firebase.integration.ts:106` | `typescript:S2068` | VULNERABILITY / MAJOR | Contraseñas ficticias generadas por operación con randomUUID; suite correctamente clasificada como tests. |
| `backend-realtime/src/integration/firebase.integration.ts:109` | `typescript:S2068` | VULNERABILITY / MAJOR | Contraseñas ficticias generadas por operación con randomUUID; suite correctamente clasificada como tests. |
| `backend-realtime/src/config/firebase.ts:18` | `typescript:S7773` | CODE_SMELL / MINOR | Number.NaN; sin cambio de semántica. |
| `backend-realtime/src/integration/firebase.integration.ts:60` | `typescript:S2068` | VULNERABILITY / MAJOR | Contraseñas ficticias generadas por operación con randomUUID; suite correctamente clasificada como tests. |
| `backend-realtime/src/integration/firebase.integration.ts:62` | `typescript:S2068` | VULNERABILITY / MAJOR | Contraseñas ficticias generadas por operación con randomUUID; suite correctamente clasificada como tests. |
| `backend-realtime/src/integration/firebase.integration.ts:99` | `typescript:S5332` | VULNERABILITY / MINOR | Sonda negativa intencional: el transporte intercepta antes de transmitir. Se mantiene la aserción HTTP y se clasifica el archivo como test; no se afirma una vulnerabilidad de producción. |
| `backend-api/src/config/deletion-emulator-clients.ts:51` | `typescript:S1143` | BUG / CRITICAL | Error de cleanup fuera de finally; preserva el error original y cierra ambos recursos. Regresiones de éxito y doble fallo. |
| `backend-api/src/services/account-deletion.data.ts:62` | `typescript:S2871` | BUG / CRITICAL | Comparador explícito por unidades de código; conserva el orden anterior y añade regresión con guion/guion bajo. |
| `backend-api/src/integration/deletion.integration.ts:26` | `typescript:S2068` | VULNERABILITY / MAJOR | Contraseñas ficticias generadas por operación con randomUUID; suite correctamente clasificada como tests. |
| `backend-api/src/integration/deletion.integration.ts:28` | `typescript:S2068` | VULNERABILITY / MAJOR | Contraseñas ficticias generadas por operación con randomUUID; suite correctamente clasificada como tests. |
| `backend-api/src/integration/deletion.integration.ts:58` | `typescript:S2871` | BUG / CRITICAL | Comparador explícito por unidades de código; conserva el orden anterior y añade regresión con guion/guion bajo. |
| `backend-api/src/integration/deletion.integration.ts:58` | `typescript:S2871` | BUG / CRITICAL | Comparador explícito por unidades de código; conserva el orden anterior y añade regresión con guion/guion bajo. |

Todos los issues remotos siguen abiertos hasta que se analice una revisión publicada o se revisen explícitamente por el equipo. No se marcaron falsos positivos ni resueltos desde herramientas. La sonda S5332 no se cambia a HTTPS porque dejaría de verificar el bloqueo HTTP; su contexto test es esencial. Si Sonar mantiene ese hallazgo tras reclasificarlo, debe revisarse su flujo y contexto con el equipo.

## Cobertura individual del código nuevo — reporte remoto anterior

| Archivo | Cobertura nueva % | Líneas sin cubrir / a cubrir | Condiciones sin cubrir / a cubrir |
|---|---:|---:|---:|
| `backend-realtime/src/realtime/account-access.ts` | 95.56 | 0 / 82 | 6 / 53 |
| `backend-api/src/middleware/account-active.ts` | 90.00 | 0 / 7 | 1 / 3 |
| `backend-api/src/services/account-deletion.data.ts` | 96.77 | 0 / 57 | 3 / 36 |
| `backend-api/src/services/account-deletion.processor.ts` | 94.61 | 0 / 138 | 13 / 103 |
| `backend-api/src/services/account-deletion.reconciler.ts` | 97.20 | 0 / 132 | 6 / 82 |
| `backend-api/src/services/account-deletion.service.ts` | 96.72 | 0 / 39 | 2 / 22 |
| `backend-api/src/services/account-state.service.ts` | 100.00 | 0 / 15 | 0 / 14 |
| `backend-realtime/src/services/account-state.service.ts` | 100.00 | 0 / 35 | 0 / 22 |
| `backend-api/src/routes/api.routes.ts` | 100.00 | 0 / 5 | 0 / 0 |
| `backend-api/src/middleware/deletion-auth.ts` | 93.65 | 0 / 39 | 4 / 24 |
| `backend-api/src/config/deletion-emulator-clients.ts` | 96.55 | 0 / 44 | 2 / 14 |
| `backend-api/src/config/deletion-test.ts` | 97.14 | 0 / 20 | 1 / 15 |
| `backend-api/src/integration/deletion.integration.ts` | 0.00 | 262 / 262 | 0 / 0 |
| `backend-realtime/src/config/env.ts` | 100.00 | 0 / 8 | 0 / 5 |
| `backend-api/src/middleware/errors.ts` | 100.00 | 0 / 4 | 0 / 4 |
| `backend-realtime/src/services/firebase-auth.service.ts` | 100.00 | 0 / 3 | 0 / 3 |
| `backend-realtime/scripts/firebase-integration.cjs` | 0.00 | 36 / 36 | 0 / 0 |
| `backend-realtime/src/integration/firebase.integration.ts` | 0.00 | 139 / 139 | 0 / 0 |
| `backend-api/src/config/firebase.ts` | 93.33 | 2 / 54 | 4 / 36 |
| `backend-realtime/src/config/firebase.ts` | 96.89 | 1 / 159 | 8 / 130 |
| `backend-api/scripts/firestore-integration.cjs` | 0.00 | 39 / 39 | 0 / 0 |
| `backend-api/src/services/firestore.service.ts` | 100.00 | 0 / 14 | 0 / 11 |
| `backend-api/src/docs/openapi.ts` | 100.00 | 0 / 114 | 0 / 0 |
| `backend-api/src/server.ts` | 92.06 | 8 / 79 | 2 / 47 |
| `backend-realtime/src/server.ts` | 78.05 | 12 / 57 | 6 / 25 |
| `backend-api/src/integration/setup-deletion.integration.ts` | 0.00 | 2 / 2 | 0 / 0 |
| `backend-api/src/integration/setup.integration.ts` | 0.00 | 4 / 4 | 0 / 0 |
| `backend-realtime/src/integration/setup.integration.ts` | 0.00 | 27 / 27 | 0 / 0 |
| `backend-realtime/src/integration/socket-client.ts` | 0.00 | 34 / 34 | 0 / 0 |
| `backend-realtime/src/realtime/socket.ts` | 95.34 | 0 / 144 | 11 / 92 |
| `backend-api/src/validators/user.validator.ts` | 100.00 | 0 / 20 | 0 / 6 |
| `backend-api/src/controllers/users.controller.ts` | 89.36 | 0 / 28 | 5 / 19 |
| `backend-api/src/integration/users.integration.ts` | 0.00 | 223 / 223 | 0 / 0 |
| `backend-api/src/routes/users.routes.ts` | 100.00 | 0 / 3 | 0 / 0 |
| `backend-api/src/services/users.service.ts` | 98.13 | 0 / 142 | 5 / 126 |

## Inventario LCOV local posterior

Las listas siguientes identifican líneas instrumentadas no ejecutadas, líneas con alguna rama no ejecutada y funciones con contador cero. Incluyen código previo a TS-01; no equivalen a cobertura exclusivamente nueva. Las ramas se identifican por su línea LCOV, no se inventa una correspondencia con condiciones Sonar.

| Archivo | Líneas cubiertas / totales | Ramas cubiertas / totales | Líneas con hits 0 | Líneas con ramas sin cubrir | Funciones con hits 0 |
|---|---:|---:|---|---|---|
| `backend-api/src/app.ts` | 23 / 24 | 1 / 3 | 14 | 13, 15 | — |
| `backend-api/src/server.ts` | 74 / 82 | 45 / 47 | 79, 80, 81, 82, 83, 84, 85, 86 | 34, 78 | — |
| `backend-api/src/config/deletion-emulator-clients.ts` | 44 / 44 | 16 / 17 | — | 49 | — |
| `backend-api/src/config/deletion-test.ts` | 20 / 20 | 14 / 15 | — | 5 | — |
| `backend-api/src/config/env.ts` | 21 / 21 | 6 / 7 | — | 5 | — |
| `backend-api/src/config/firebase.ts` | 62 / 64 | 36 / 40 | 64, 65 | 19, 49, 60, 63 | getAccessToken |
| `backend-api/src/controllers/messages.controller.ts` | 3 / 3 | 0 / 0 | — | — | listMessages, createMessage |
| `backend-api/src/controllers/rooms.controller.ts` | 8 / 11 | 0 / 0 | 12, 13, 14 | — | listRooms, getRoom, updateRoom, deleteRoom, joinRoom, createRoom |
| `backend-api/src/controllers/users.controller.ts` | 28 / 28 | 14 / 19 | — | 8, 14, 20, 25, 26 | — |
| `backend-api/src/middleware/account-active.ts` | 7 / 7 | 2 / 3 | — | 7 | — |
| `backend-api/src/middleware/auth.ts` | 30 / 30 | 13 / 15 | — | 41, 42 | — |
| `backend-api/src/middleware/deletion-auth.ts` | 39 / 39 | 20 / 24 | — | 13, 33, 37, 40 | — |
| `backend-api/src/middleware/errors.ts` | 36 / 49 | 8 / 10 | 17, 18, 19, 20, 21, 22, 50, 51, 52, 53, 54, 55, 56 | 45, 48 | notFound |
| `backend-api/src/scripts/firestore-smoke.ts` | 24 / 26 | 6 / 8 | 29, 30 | 20, 28 | — |
| `backend-api/src/services/account-deletion.data.ts` | 57 / 57 | 36 / 40 | — | 42, 51, 55, 62 | — |
| `backend-api/src/services/account-deletion.processor.ts` | 138 / 138 | 90 / 103 | — | 19, 23, 27, 40, 44, 78, 82, 95, 102, 108, 113, 117, 136 | — |
| `backend-api/src/services/account-deletion.reconciler.ts` | 132 / 132 | 76 / 82 | — | 40, 73, 91, 114 | — |
| `backend-api/src/services/account-deletion.service.ts` | 39 / 39 | 20 / 22 | — | 31 | — |
| `backend-api/src/services/placeholder.service.ts` | 2 / 8 | 0 / 0 | 4, 5, 6, 7, 8, 9 | — | notImplemented |
| `backend-api/src/services/users.service.ts` | 142 / 142 | 121 / 126 | — | 71, 81, 92, 93 | — |
| `backend-realtime/src/app.ts` | 15 / 16 | 1 / 3 | 11 | 10, 12 | — |
| `backend-realtime/src/server.ts` | 52 / 65 | 25 / 29 | 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68 | 31, 33, 44, 55 | shutdown, runtime.start.then.startupFailed |
| `backend-realtime/src/config/env.ts` | 21 / 21 | 6 / 7 | — | 5 | — |
| `backend-realtime/src/config/firebase.ts` | 158 / 159 | 123 / 131 | 127 | 17, 34, 78, 111, 119, 126, 139, 158 | getAccessToken |
| `backend-realtime/src/realtime/account-access.ts` | 82 / 82 | 47 / 53 | — | 27, 35, 59, 78, 80, 84 | — |
| `backend-realtime/src/realtime/socket.ts` | 173 / 173 | 89 / 100 | — | 12, 41, 55, 69, 78, 86, 96, 142, 145, 160 | — |

Fuentes LCOV inexistentes: 0.

## Validación y límites

- Node.js 24.18.0. API: 330 pruebas; instrucciones/líneas 97,38 %, ramas 90,88 %, funciones 87,77 %.
- Realtime: 144 pruebas; instrucciones/líneas 97,43 %, ramas 90,83 %, funciones 94,73 %.
- Cuatro regresiones nuevas: resultado y cierre de factoría; orden determinista de reservas; arranque HTTP en puerto ocupado; fallo de drenaje con cierre de Firebase.
- Lint, typecheck y build correctos en ambos servicios.
- Las pruebas de integración no generan LCOV en estas suites. Su ejecución no se suma a la cobertura instrumentada.
- No se alteró autenticación, permisos, reglas Firestore, contratos HTTP, habilitación de DELETE ni dependencias.
- La confirmación de Reliability A, Security A y cobertura nueva requiere un nuevo análisis remoto posterior a la revisión y publicación autorizadas.

- Integración API Authentication/Firestore: 33 aprobadas; integración realtime: 21 aprobadas. Total de casos distintos aprobados en esta tarea: 528 (330 + 144 + 33 + 21).
- Un intento simultáneo de emuladores produjo conflicto de infraestructura y ECONNREFUSED en realtime (21 casos no ejecutados); se repitió realtime de forma aislada y sus 21 casos aprobaron. API terminó con éxito. El Firestore huérfano de ese intento se cerró por PID identificado, sin detener servicios ajenos.
- No se ejecutaron nuevamente las 31 integraciones Firestore independientes, los seis escenarios conjuntos, las once regresiones del lanzador ni las 35 pruebas de reglas; no se cuentan en esta ejecución.
