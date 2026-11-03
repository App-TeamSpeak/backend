import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  applicationDefault: vi.fn(() => ({ type: 'application-default' })),
  cert: vi.fn((options: unknown) => ({ type: 'cert', options })),
  getApps: vi.fn(() => [] as unknown[]),
  initializeApp: vi.fn((options: unknown) => ({ options })),
  getAuth: vi.fn(() => ({ type: 'auth' })),
  getFirestore: vi.fn(() => ({ type: 'firestore' })),
}));

vi.mock('firebase-admin/app', () => ({
  applicationDefault: mocks.applicationDefault,
  cert: mocks.cert,
  getApps: mocks.getApps,
  initializeApp: mocks.initializeApp,
}));

vi.mock('firebase-admin/auth', () => ({ getAuth: mocks.getAuth }));
vi.mock('firebase-admin/firestore', () => ({ getFirestore: mocks.getFirestore }));

async function loadFirebase(env: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('./env', () => ({ env }));
  return import('./firebase.js');
}

describe('Firebase Admin configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApps.mockReturnValue([]);
  });

  it('initializes with service-account credentials and reuses the app', async () => {
    const firebase = await loadFirebase({
      NODE_ENV: 'development',
      FIREBASE_PROJECT_ID: 'project-id',
      FIREBASE_CLIENT_EMAIL: 'admin@example.com',
      FIREBASE_PRIVATE_KEY: 'private-key\\n',
    });

    expect(firebase.getFirebaseAuth()).toEqual({ type: 'auth' });
    expect(firebase.getFirestoreDb()).toEqual({ type: 'firestore' });
    expect(mocks.cert).toHaveBeenCalledWith({
      projectId: 'project-id',
      clientEmail: 'admin@example.com',
      privateKey: 'private-key\n',
    });
    expect(mocks.initializeApp).toHaveBeenCalledTimes(1);
  });

  it('reuses an already initialized Firebase app', async () => {
    const existingApp = { name: 'existing' };
    mocks.getApps.mockReturnValue([existingApp]);
    const firebase = await loadFirebase({ NODE_ENV: 'development' });

    firebase.getFirestoreDb();

    expect(mocks.initializeApp).not.toHaveBeenCalled();
    expect(mocks.applicationDefault).not.toHaveBeenCalled();
    expect(mocks.getFirestore).toHaveBeenCalledWith(existingApp);
  });

  it('uses application default credentials in production', async () => {
    const firebase = await loadFirebase({ NODE_ENV: 'production' });

    firebase.getFirestoreDb();

    expect(mocks.applicationDefault).toHaveBeenCalledTimes(1);
    expect(mocks.initializeApp).toHaveBeenCalledWith({
      credential: { type: 'application-default' },
    });
  });

  it('fails clearly in development when credentials are missing', async () => {
    const firebase = await loadFirebase({ NODE_ENV: 'development' });

    expect(() => firebase.getFirestoreDb()).toThrow('Firebase Admin no está configurado');
  });
});
