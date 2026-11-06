# Sprint 0 · Soporte para S0-C04 y S0-C05

Comprobado el 5 de noviembre de 2026. Rama feature, sin merge ni despliegue.

## Cambios

- Compose carga `.env` de API y realtime, sin incorporar credenciales a las imágenes.
- La API trata los placeholders vacíos de Firebase como ausentes: arranca, mantiene
  health operativo y responde 503 controlado al consultar Firestore sin credenciales.
- El endpoint demo responde `Cache-Control: no-store`, también en errores.
- Se reparó el lockfile API: faltaban dos dependencias peer opcionales yaml que
  impedían `npm ci` con las herramientas locales. No se cambiaron versiones directas.

## Resultados reales

- API: `npm run validate`, 24 pruebas, typecheck, cobertura y build correctos.
  Registro: [api-validation.txt](evidence/api-validation.txt).
- Realtime: `npm run validate`, 3 pruebas y build correctos.
  Registro: [realtime-validation.txt](evidence/realtime-validation.txt).
- Se construyeron imágenes Docker frontend, API y realtime mediante Compose.
- `docker compose -p teamspeak-sprint0-review --env-file .env.example up -d --build`:
  API y realtime healthy, frontend en 8080. Plantillas locales sin credenciales.
- Consulta real al contenedor API: 503 `FIRESTORE_UNAVAILABLE` con
  `Cache-Control: no-store`. [Cabeceras](evidence/compose-api-headers.txt),
  [respuesta](evidence/compose-api-response.json).
- Navegador contra contenedores: error y Reintentar visibles; recarga directa
  de ruta inexistente muestra 404 React. [Resultado](evidence/compose-browser.txt).
- Consulta de solo lectura a Render: HTTP 200 con el documento de demo existente.
  La evidencia de API remota, consola y capturas está en el PR frontend.

## Límites

No se usaron credenciales reales locales, no se editó Firestore y no se cambió
Render. La prueba Compose sin credenciales demuestra arranque y error controlado,
no lectura local de Firestore. Render tiene una lista de CORS: localhost:5173
está autorizado, 127.0.0.1:5174 fue rechazado en el navegador. El responsable del
despliegue debe configurar el origen exacto de Vercel y grabar el cambio real de
dato exigido por la rúbrica después de aprobar los PR.
