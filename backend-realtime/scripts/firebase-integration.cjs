const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js >=24 is required.');
const project = 'demo-teamspeak-tests';
const root = path.resolve(__dirname, '..');
const config = JSON.parse(readFileSync(path.join(root, 'firebase.emulator.json'), 'utf8'));
function port(value) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Invalid local emulator port.');
  return Number(value);
}
const firestorePort = port(process.env.TEAMSPEAK_FIRESTORE_PORT ?? config.emulators.firestore.port);
const authPort = port(process.env.TEAMSPEAK_AUTH_PORT ?? config.emulators.auth.port);
if (firestorePort === authPort) throw new Error('Emulator ports must differ.');
const firestoreHost = `127.0.0.1:${firestorePort}`;
const authHost = `127.0.0.1:${authPort}`;
for (const [key, required] of Object.entries({ FIRESTORE_EMULATOR_HOST: firestoreHost, FIREBASE_AUTH_EMULATOR_HOST: authHost,
  FIREBASE_PROJECT_ID: project, FIREBASE_EXPECTED_PROJECT_ID: project, GCLOUD_PROJECT: project })) {
  if (process.env[key] && process.env[key] !== required) throw new Error('Unsafe inherited emulator/project configuration.');
}
const runOnly = process.argv.includes('--run');
if (runOnly && (process.env.FIRESTORE_EMULATOR_HOST !== firestoreHost || process.env.FIREBASE_AUTH_EMULATOR_HOST !== authHost
  || process.env.TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS !== 'true')) throw new Error('Use the full realtime integration launcher.');
const directory = mkdtempSync(path.join(tmpdir(), 'teamspeak-realtime-emulators-'));
const cache = path.join(tmpdir(), 'teamspeak-integration-tools', 'emulators');
mkdirSync(cache, { recursive: true });
// Explicit allowlist: no real credentials, ADC paths, saved CLI login, dotenv files or NODE_OPTIONS.
const isolated = {
  PATH: process.env.PATH, ...(process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : {}),
  XDG_CONFIG_HOME: directory, FIREBASE_EMULATORS_PATH: cache, NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null',
  FIREBASE_PROJECT_ID: project, FIREBASE_EXPECTED_PROJECT_ID: project, GCLOUD_PROJECT: project,
  FIRESTORE_EMULATOR_HOST: firestoreHost, FIREBASE_AUTH_EMULATOR_HOST: authHost,
  TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS: 'true',
  TEAMSPEAK_FIRESTORE_PORT: String(firestorePort), TEAMSPEAK_AUTH_PORT: String(authPort),
  CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
};
let result;
if (runOnly) {
  result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.integration.config.ts'], { cwd: root, env: isolated, stdio: 'inherit' });
} else {
  config.emulators.firestore = { host: '127.0.0.1', port: firestorePort };
  config.emulators.auth = { host: '127.0.0.1', port: authPort };
  config.firestore.rules = path.join(root, 'firestore.emulator.rules');
  const filename = path.join(directory, 'firebase.json'); writeFileSync(filename, JSON.stringify(config));
  const quote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const command = `${quote(process.execPath)} ${quote(__filename)} --run`;
  result = spawnSync(process.env.TEAMSPEAK_FIREBASE_CLI || 'firebase', ['emulators:exec', '--only', 'firestore,auth', '--project', project,
    '--config', filename, '--non-interactive', command], { cwd: directory, env: isolated, stdio: 'inherit' });
}
if (result.error) console.error({ event: 'realtime_integration_launcher_failed', code: result.error.code });
process.exitCode = result.status ?? 1;
