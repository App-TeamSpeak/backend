# US-01 — Registro manual: decisiones y contrato backend

## Alcance y decisiones definitivas

Se reutiliza TS-01 integrada por PR #5 en `18d1de2156bf70941f9eba257b707c7a4609dde2`.
Este ajuste no crea un servicio de identidad, envío de correos ni contraseñas propios.

| Requisito | Decisión y responsabilidad |
|---|---|
| Nombres/apellidos | `nombre` y `apellido`: obligatorios, trim, 1–100 caracteres |
| Username | 8–30 caracteres ASCII, números, guion/guion bajo; clave única en minúsculas y presentación conservada |
| Avatar | Predeterminado en frontend cuando `avatarUrl` sea null; selección inicial opcional |
| Avatar personalizado | URL HTTPS hasta 2048 caracteres; no upload ni almacenamiento de imagen predeterminada |
| Dominios | Cualquier correo válido aceptado por Firebase, sin whitelist institucional |
| Verificación de propiedad del correo | Obligatoria para acceso privado; enlace nativo de Firebase Authentication |
| Contraseña | Firebase Authentication: mínimo 8, mayúscula, minúscula, número y símbolo; modo obligatorio |
| Incorporación | GET y POST del perfil permitidos con identidad válida aunque el correo esté sin verificar |
| Acceso privado | Requiere claim confiable email_verified=true, además de los controles existentes |

La decisión sobre dominios sustituye el requisito previo de correo institucional.
La obligatoriedad de verificación y las reglas de avatar están acordadas; no son
ya decisiones funcionales pendientes. Falta acreditar la configuración real de
contraseñas y realizar la integración frontend. No se cambió Jira.

## Autenticación, verificación y perfil

Son condiciones diferentes:

- Autenticación: Firebase Admin acepta el ID token e identifica su UID.
- Verificación de correo: el token aceptado contiene exactamente `email_verified: true`.
- Perfil completo: existen los datos válidos del perfil; no acredita por sí mismo
  la propiedad del correo ni cambia el claim.

`requireAuth` conserva identidad y traduce únicamente el claim verdadero a una
propiedad interna `emailVerified`. `requireVerifiedEmail` la exige en PATCH del
perfil y en las demás rutas privadas posteriores al router de usuarios, incluidas
salas/mensajes. GET/POST del perfil conservan autenticación y bloqueo por marcador.
La comprobación de eliminación permanece anterior a la autorización de correo.
DELETE y su autenticación específica test-only no se modificaron ni se habilitan
públicamente. Salud y documentación permanecen públicas.

Socket.IO exige `email_verified === true` después de verificar el token con el
control de revocación existente, antes de admitir la conexión. No se acepta una
bandera del handshake, del cuerpo HTTP ni del proveedor Google como excepción.
Los ocho eventos conservan autorización y límites existentes; no se añade polling
del estado de correo a sesiones ya admitidas ni se implementa login Google.

## Contratos y compatibilidad

- POST `/api/users/me`: cuerpo estricto `nombre`, `apellido`, `username`,
  `avatarUrl` opcional. Omisión/null representa avatar predeterminado. UID/correo
  proceden del token. 201 nuevo; 200 repetición equivalente o recuperación.
- GET `/api/users/me`: 200 con perfil completo o estado incomplete y profile null.
  No se añade el estado de verificación al documento Firestore ni a este contrato.
- PATCH `/api/users/me`: ahora exige correo verificado. Omisión de avatar conserva
  el valor; una URL válida personaliza y null elimina la personalización.
- Sin token: 401 AUTH_REQUIRED; token inválido: 401 AUTH_INVALID.
- Token válido sin claim verdadero para acceso privado: 403 EMAIL_NOT_VERIFIED.
- Se conservan 400 VALIDATION_ERROR, 409 USERNAME_TAKEN y bloqueos por eliminación.
- `emailVerified`, `email_verified`, UID, correo o contraseña aportados como campos
  de perfil no pueden suplir datos confiables de Firebase; el cuerpo sigue estricto.

La nueva restricción privada es un cambio intencional de autorización acordado en
US-01. Los clientes existentes deben refrescar credenciales y manejar ese 403.
No se modificaron esquema persistido, unicidad, transacciones ni contratos de datos.
La creación de identidad/perfil sigue siendo de dos pasos: un error de perfil no
elimina automáticamente la identidad. El onboarding de username obligatorio en
otros recursos corresponde a US-02; no se implementa en esta entrega.

## Flujo que debe integrar frontend

1. Crear identidad con Firebase Client SDK e informar/validar preventivamente la
   política de contraseñas, por ejemplo con validatePassword si está disponible.
2. Obtener ID token y usar POST/GET del perfil; no enviar contraseñas a la API.
3. Enviar enlace nativo con sendEmailVerification(user), gestionar reenvío y errores.
4. Tras abrir el enlace, ejecutar reload(user), consultar user.emailVerified y
   obtener getIdToken(user, true). Reemplazar Authorization y reconectar Socket.IO
   con el token actualizado; las conexiones rechazadas no se admiten automáticamente.
5. Mostrar avatar predeterminado si avatarUrl es null y los errores de Firebase/API.

Un token antiguo que todavía declara false continúa rechazado aunque el registro
Firebase ya esté verificado. No se confía en el estado local del formulario. No se
exige otra verificación si un token Firebase de cualquier proveedor ya acredita true.
No se modificó frontend ni se implementaron OTP ni infraestructura de correo.

## Configuración Firebase pendiente de acreditar

No se accedió ni modificó el proyecto real, Firebase Console o sus credenciales.
No hay evidencia versionada que demuestre la política efectiva de producción.
Una persona autorizada debe abrir Firebase Console → Authentication → Settings →
Password policy (sección Security) y configurar/verificar:

- Mínimo de 8 caracteres.
- Requerir minúscula, mayúscula, carácter numérico y carácter no alfanumérico.
- Modo **Require**, no Notify; guardar y registrar evidencia sin secretos.
- No introducir una longitud máxima adicional propia de TeamSpeak; revisar los
  límites inherentes del proveedor sin convertirlos en requisitos nuevos.

También debe confirmar proveedor Email/Password y configuración de la plantilla
nativa de verificación/dominios de continuación que utilizará el cliente.
La revisión y pruebas reales de configuración deben autorizarse por separado.

Fuentes oficiales:
- [Política de contraseñas Firebase](https://firebase.google.com/docs/auth/web/password-auth)
- [Verificación de correo en emulador](https://firebase.google.com/docs/emulator-suite/connect_auth)

## Evidencia y límites

Se reutiliza `integration-ts01/run.cjs`: Node 24, Java 21 y CLI/JAR existentes,
proyecto exacto demo-teamspeak-tests, loopback, dotenv deshabilitado, credenciales
sintéticas, transportes remotos bloqueados y supervisión de procesos propios.
Ejecutar desde la raíz con los requisitos de `integration-ts01/README.md`:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
PATH=/ruta/jre21/bin:$PATH TEAMSPEAK_FIREBASE_CLI=/ruta/firebase node integration-ts01/run.cjs
```

La suite conserva los diez casos anteriores y añade cinco: enlace nativo/claim
antiguo/refresco/HTTP/Socket.IO, tres dominios distintos sin avatar y una sonda de
política del emulador instalado. Se solicitan y aplican códigos únicamente mediante
endpoints locales; no se envían correos reales. Nunca publicar códigos o tokens.
Los fixtures históricos que acceden a funcionalidades privadas declaran explícitamente
correo verificado; los casos nuevos prueban identidades no verificadas.

La versión instalada de Authentication Emulator solo impone su mínimo de seis
caracteres: la sonda comprueba rechazo de una contraseña demasiado corta y acepta
una de seis caracteres sin la complejidad acordada. Es una limitación local, no
una validación ni un cambio de la política de TeamSpeak. La prueba de enlace nativo
sí comprueba el cambio durable emailVerified y la emisión de un token nuevo.

Las integraciones node:test siguen siendo ejecución local fuera del pipeline
habitual de GitHub Actions y no generan automáticamente LCOV Vitest. No se declara
aprobado un Quality Gate nuevo de PR #6 ni verificado un despliegue de producción.
