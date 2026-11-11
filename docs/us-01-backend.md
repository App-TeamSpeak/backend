# US-01 — Cobertura backend y contrato de registro manual

## Base y alcance

US-01 parte de main con TS-01 integrada mediante PR #5, commit
`18d1de2156bf70941f9eba257b707c7a4609dde2`. Se conserva el modelo y los contratos.
No se implementan registro/login REST propios, frontend, onboarding Google ni
cambios en eliminación. Firebase Authentication crea la identidad; la API crea
el perfil asociado al UID del ID token verificado.

## Matriz previa a la implementación

| Requisito | Implementación reutilizada | Evidencia previa | Estado / cambio necesario |
|---|---|---|---|
| Nombres y apellidos | user.validator.ts y users.service.ts | user.validator.test.ts, users.service.test.ts | Resuelto: nombre/apellido obligatorios, trim, 1–100 caracteres |
| Username | Validación 8–30 ASCII, números, guion y guion bajo | Validador, HTTP y users.integration.ts | Resuelto: presentación original y reserva en minúsculas |
| Unicidad concurrente | Transacción users + usernames | Dos UID compiten en Firestore Emulator | Resuelto; complementar evidencia a través de HTTP real |
| UID y correo confiables | requireAuth + identidad del token | users.http.test.ts | Resuelto; cuerpo estricto rechaza uid/email/password |
| Avatar | avatarUrl HTTPS hasta 2048, opcional/null | Validador y HTTP | Requiere decisión funcional si debe ser obligatorio |
| Correo institucional | Correo de identidad Firebase | Servicio exige correo válido | Requiere política formal de dominios; no se inventa una |
| Contraseña | Firebase Authentication, fuera del endpoint de perfiles | Integraciones con identidad emitida | Responsabilidad Firebase; configurar/verificar política acordada |
| Correo ya registrado | Firebase Authentication | Faltaba evidencia explícita de signUp duplicado en la suite conjunta | Añadir prueba, no otra base de identidades |
| Identidad sin perfil | GET incomplete y POST posterior | Servicio/HTTP y recuperación Firestore | Resuelto; complementar recorrido desde signUp cliente |
| Idempotencia | POST equivalente 200, sin escrituras nuevas | Servicio e integración Firestore | Resuelto; complementar recorrido HTTP real |
| Flujo completo | POST/GET de perfiles y suite conjunta | Antes la identidad del recorrido se creaba mediante Admin | Añadir casos usando accounts:signUp del emulador |
| Mensajes, formulario y sesión cliente | Firebase Client SDK y consumidor API | Frontend actual usa mock | Responsabilidad frontend/integración, sin cambios aquí |

Las referencias de archivos de la matriz están en `backend-api/src/`, salvo la
suite conjunta `integration-ts01/ts01.test.cjs`.

## Contratos reutilizados

- `POST /api/users/me`: Bearer ID token; cuerpo estricto con `nombre`, `apellido`,
  `username` y `avatarUrl` opcional. Correo y UID provienen del token. Respuesta
  201 al crear, 200 ante repetición equivalente; `data` contiene UID, estado y perfil.
- `GET /api/users/me`: Bearer ID token; 200 con estado `complete` y perfil, o
  `incomplete` y `profile: null` cuando aún no existe un perfil completo.
- Sin token: 401 `AUTH_REQUIRED`; token inválido: 401 `AUTH_INVALID`.
- Entrada inválida/campos no permitidos: 400 `VALIDATION_ERROR`.
- Username de otra cuenta: 409 `USERNAME_TAKEN`.
- Perfil completo existente con datos diferentes: 409 `PROFILE_ALREADY_EXISTS`.
- No se almacena contraseña en Firestore ni se acepta como dato de perfil.
- El avatar representa una URL, no carga de archivo. No se comprueba disponibilidad
  de la imagen remota ni se incorpora un servicio de almacenamiento.

## Evidencia nueva

Se amplía la infraestructura conjunta existente, sin crear otro lanzador ni
modificar backend-realtime. Los cuatro casos US-01 verifican:

1. Alta cliente con Authentication Emulator, token verificado, GET incompleto,
   POST con avatar, documentos/reserva persistidos, GET coincidente e idempotencia
   sin cambio de updateTime ni duplicación.
2. Otra identidad no puede enviar UID/correo/contraseña en el perfil, reclamar el
   username ni consultar un perfil ajeno mediante query. Se conserva intacto el
   perfil original y la identidad perdedora permanece existente.
3. Dos identidades, peticiones HTTP concurrentes y variantes de mayúsculas: un
   único 201, un 409, reserva correcta y ningún perfil/reserva para el perdedor.
4. Authentication Emulator devuelve EMAIL_EXISTS al repetir correo; no se crean
   perfiles/reservas como efecto de ese fallo y la identidad original puede completar
   el POST de perfil. Este error es distinto de USERNAME_TAKEN en la API.

No se simulan Authentication, transacciones ni servidor HTTP en esos casos.
Las identidades nuevas se crean mediante REST cliente accounts:signUp; Admin se
usa para verificar tokens y observar los datos de los emuladores.

## Reproducción y seguridad

Desde la raíz backend, con Node.js 24, Java 21, dependencias y herramientas
existentes según `integration-ts01/README.md`:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
PATH=/ruta/jre21/bin:$PATH TEAMSPEAK_FIREBASE_CLI=/ruta/firebase node integration-ts01/run.cjs
```

Ejecuta seis escenarios TS-01 existentes y cuatro US-01. Conserva los puertos
exclusivos y la supervisión de procesos del lanzador, proyecto exacto
`demo-teamspeak-tests`, dotenv deshabilitado, credenciales sintéticas y bloqueo
remoto. No ejecutar los casos directamente contra un emulador compartido.
El lanzador también ejecuta los escenarios históricos de eliminación test-only;
no habilita DELETE públicamente ni amplía su alcance.

Los casos nativos node:test no generan LCOV de Vitest. Su resultado no se presenta
como aumento de cobertura ni como aprobación del Quality Gate de un PR US-01.

## Decisiones que permanecen abiertas

- Avatar obligatorio o nullable: el contrato actual permite omisión/null.
- Definición verificable de correo institucional y, si corresponde, verificación
  de propiedad de correo: no se añade una política de dominios sin acuerdo.
- Aplicación efectiva de la política de contraseña acordada en Firebase
  Authentication: mínimo 8, minúscula, mayúscula, número y carácter especial.
  Un alta exitosa en emulador no demuestra esa configuración en producción.
- Creación de identidad y perfil son dos pasos. Si falla el perfil, se conserva la
  identidad y se permite completar posteriormente; no se promete atomicidad entre
  Authentication y Firestore ni se elimina automáticamente la identidad.

La lógica backend existente cubre el contrato actual; el cierre funcional de la
historia depende de estas decisiones/configuración y de la integración del cliente.
