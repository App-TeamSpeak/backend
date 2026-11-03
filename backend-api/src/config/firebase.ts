import { applicationDefault, cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { env } from './env';

let firebaseApp: App | undefined;

function getFirebaseApp(): App {
  if (firebaseApp) return firebaseApp;

  const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey } = env;
  if (projectId && clientEmail && privateKey) {
    firebaseApp = getApps()[0] ?? initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
    });
    return firebaseApp;
  }

  if (env.NODE_ENV === 'production') {
    firebaseApp = getApps()[0] ?? initializeApp({ credential: applicationDefault() });
    return firebaseApp;
  }

  throw new Error('Firebase Admin no está configurado. Define las credenciales Firebase en el entorno.');

}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}

export function getFirestoreDb(): Firestore {
  return getFirestore(getFirebaseApp());
}
