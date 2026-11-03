import { getFirestoreDb } from '../config/firebase';

export async function runFirestoreSmoke(log: (...args: unknown[]) => void = console.log): Promise<void> {
  const firestore = getFirestoreDb();
  const collections = await firestore.listCollections();

  log(JSON.stringify({
    success: true,
    service: 'teamspeak-backend-api',
    firestore: 'connected',
    collections: collections.map((collection) => collection.id),
  }));
}

export async function main(
  log: (...args: unknown[]) => void = console.log,
  errorLog: (...args: unknown[]) => void = console.error,
): Promise<void> {
  try {
    await runFirestoreSmoke(log);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    errorLog(`Firestore smoke test failed: ${message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
