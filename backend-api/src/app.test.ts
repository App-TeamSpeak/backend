import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from './app';

describe('TeamSpeak API base', () => {
  it('responde al health check', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, status: 'ok' });
  });

  it('publica el contrato OpenAPI', async () => {
    const response = await request(app).get('/api/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.info.title).toBe('TeamSpeak Study Room API');
    expect(response.body.paths['/api/rooms']).toBeDefined();
  });

  it('protege las rutas privadas antes de acceder al servicio Firebase', async () => {
    const response = await request(app).get('/api/rooms');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  });
});
