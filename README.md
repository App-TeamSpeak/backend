# TeamSpeak Backend

Backend del salón de estudio colaborativo en tiempo real.

## Servicios

- `backend-api`: API REST, autenticación Firebase, Firestore y Swagger.
- `backend-realtime`: Socket.IO, presencia, chat en tiempo real y señalización WebRTC.

## Arquitectura sencilla

Cada servicio mantiene la misma separación por responsabilidades:

```text
src/
├── config/          # Variables de entorno y clientes externos
├── controllers/     # Entrada HTTP y coordinación de la respuesta
├── middleware/      # Autenticación y errores (solo backend-api)
├── routes/          # Enrutamiento HTTP
├── services/        # Lógica reutilizable e integraciones
├── validators/      # Validación de entradas (solo backend-api)
├── docs/            # Contratos OpenAPI/Swagger
└── app.ts/server.ts # Composición y arranque
```

La regla de trabajo es: las rutas no contienen lógica de negocio; los controladores
validan la entrada y delegan en servicios; los servicios acceden a Firebase o a
Socket.IO. La lógica de Firestore se agregará en `services/` cuando se implemente
cada historia.

## Desarrollo local

Cada servicio se instala y ejecuta de forma independiente:

```bash
cd backend-api
npm install
npm run dev
```

```bash
cd backend-realtime
npm install
npm run dev
```

La API publica Swagger en `/api/docs` y el contrato JSON en `/api/openapi.json`.
El gateway realtime publica los mismos endpoints para su health check y contrato.

## Ejecución local con Docker

Docker es la forma recomendada para validar localmente el mismo tipo de imagen que
se despliega en Render. Los archivos `.env` son locales y están ignorados por Git.
Si todavía no existen, créalos desde las plantillas:

```bash
cp backend-api/.env.example backend-api/.env
cp backend-realtime/.env.example backend-realtime/.env
```

Para la prueba básica de los contenedores, los archivos locales deben tener como
mínimo:

`backend-api/.env`:

```dotenv
NODE_ENV=production
PORT=10000
```

`backend-realtime/.env`:

```dotenv
NODE_ENV=production
PORT=10000
```

Construye las imágenes:

```bash
docker build -t teamspeak-backend-api:local ./backend-api
docker build -t teamspeak-backend-realtime:local ./backend-realtime
```

Levanta los servicios en puertos locales diferentes:

```bash
docker run --detach \
  --name teamspeak-backend-api-local \
  --env-file backend-api/.env \
  --publish 10000:10000 \
  teamspeak-backend-api:local

docker run --detach \
  --name teamspeak-backend-realtime-local \
  --env-file backend-realtime/.env \
  --publish 10001:10000 \
  teamspeak-backend-realtime:local
```

Verifica los servicios en:

- API: `http://localhost:10000/health`
- Swagger API: `http://localhost:10000/api/docs`
- OpenAPI API: `http://localhost:10000/api/openapi.json`
- Realtime: `http://localhost:10001/health`
- Swagger realtime: `http://localhost:10001/api/docs`

Para consultar los contenedores y sus logs:

```bash
docker ps
docker logs -f teamspeak-backend-api-local
docker logs -f teamspeak-backend-realtime-local
```

Para detenerlos y eliminarlos cuando ya no se necesiten:

```bash
docker stop teamspeak-backend-api-local teamspeak-backend-realtime-local
docker rm teamspeak-backend-api-local teamspeak-backend-realtime-local
```

## Diagnóstico de cobertura y calidad

Antes de subir cambios, ejecuta las verificaciones de cada servicio:

```bash
cd backend-api
npm run lint
npm run test:coverage
npm run build
```

```bash
cd backend-realtime
npm run lint
npm run test:coverage
npm run build
```

Cada ejecución genera `coverage/lcov.info`. Estos reportes son temporales y están
ignorados por Git; el workflow de GitHub Actions los conserva como artefactos y los
entrega a SonarQube Cloud para calcular la cobertura del análisis.

También puedes ejecutar todo el diagnóstico de un servicio con:

```bash
npm run validate
```

El análisis de SonarCloud espera el resultado del Quality Gate y falla el workflow
cuando no se cumple. La política recomendada para configurar en SonarCloud está en
`docs/sonar-quality-policy.md`.

## Variables principales

Configura en cada servicio:

```dotenv
NODE_ENV=
PORT=
CORS_ORIGINS=
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

No guardes credenciales Firebase ni claves TURN en el repositorio.
