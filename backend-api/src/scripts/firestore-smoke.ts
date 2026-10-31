import { getFirestoreDb } from '../config/firebase';

async function main() {
  const firestore = getFirestoreDb();
  const collections = await firestore.listCollections();

  console.log(JSON.stringify({
    success: true,
    service: 'teamspeak-backend-api',
    firestore: 'connected',
    collections: collections.map((collection) => collection.id),
  }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Error desconocido';
  console.error(`Firestore smoke test failed: ${message}`);
  process.exitCode = 1;
});
