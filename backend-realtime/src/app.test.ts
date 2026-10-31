import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from './app';

describe('TeamSpeak realtime gateway', () => {
  it('responde al health check', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, status: 'ok' });
  });

  it('publica su contrato HTTP OpenAPI', async () => {
    const response = await request(app).get('/api/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.info.title).toBe('TeamSpeak Realtime Gateway');
  });
});
