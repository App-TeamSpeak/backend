// Executed before importing any service (which imports dotenv/config).
const port = process.env.TEAMSPEAK_FIRESTORE_PORT;
if (!port || !/^[0-9]+$/.test(port) || Number(port) < 1024 || Number(port) > 65535
  || Number(process.versions.node.split('.')[0]) < 24
  || process.env.DOTENV_CONFIG_PATH !== '/dev/null'
  || process.env.FIRESTORE_EMULATOR_HOST !== `127.0.0.1:${Number(port)}`
  || process.env.GCLOUD_PROJECT !== 'demo-teamspeak-tests'
  || process.env.FIREBASE_PROJECT_ID !== 'demo-teamspeak-tests'
  || ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN']
    .some((key) => !!process.env[key])) {
  throw new Error('Unsafe integration environment: use npm run test:integration.');
}

console.log(`Integration runtime: Node ${process.versions.node}; emulator ${process.env.FIRESTORE_EMULATOR_HOST}`);
