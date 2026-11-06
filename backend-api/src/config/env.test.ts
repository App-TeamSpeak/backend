import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe('Environment templates', () => {
  it('allows empty Firebase placeholders so process health and controlled errors work', async () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', ''); vi.stubEnv('FIREBASE_CLIENT_EMAIL', ''); vi.stubEnv('FIREBASE_PRIVATE_KEY', '');
    vi.resetModules();
    const { env } = await import('./env.js');
    expect(env.FIREBASE_PROJECT_ID).toBeUndefined(); expect(env.FIREBASE_CLIENT_EMAIL).toBeUndefined(); expect(env.FIREBASE_PRIVATE_KEY).toBeUndefined();
  });
  it('continues rejecting a configured invalid service email', async () => {
    vi.stubEnv('FIREBASE_CLIENT_EMAIL', 'invalid-email'); vi.resetModules();
    await expect(import('./env.js')).rejects.toThrow();
  });
});
