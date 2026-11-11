const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const project = 'demo-teamspeak-tests';
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js >=24 is required.');
const template = JSON.parse(readFileSync(path.join(__dirname, '..', 'firebase.emulator.json'), 'utf8'));
const port = process.env.TEAMSPEAK_FIRESTORE_PORT ?? String(template.emulators.firestore.port);
if (!/^[0-9]+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('Invalid emulator port.');
const host = `127.0.0.1:${Number(port)}`;
const root = path.resolve(__dirname, '..');
const withAuth = process.argv.includes('--with-auth') || process.argv.includes('--run-with-auth');
const runOnly = process.argv.includes('--run') || process.argv.includes('--run-with-auth');
const authPort = process.env.TEAMSPEAK_AUTH_PORT ?? String(template.emulators.auth.port);
if (!/^[0-9]+$/.test(authPort) || Number(authPort) < 1024 || Number(authPort) > 65535 || (withAuth && Number(authPort) === Number(port))) throw new Error('Invalid auth emulator port.');
const authHost = `127.0.0.1:${Number(authPort)}`;
if (withAuth && ((process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST !== authHost)
  || (runOnly && (process.env.FIREBASE_AUTH_EMULATOR_HOST !== authHost || process.env.TEAMSPEAK_ENABLE_DELETE_TESTS !== 'true')))) throw new Error('Unsafe Authentication Emulator configuration.');
if ((process.env.FIRESTORE_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST !== host)
  || (runOnly && (process.env.FIRESTORE_EMULATOR_HOST !== host || process.env.GCLOUD_PROJECT !== project))) {
  throw new Error('Unsafe emulator configuration. Only demo-teamspeak-tests at the selected loopback port is allowed.');
}
// Allowlist: no Firebase tokens, ADC configuration, NODE_OPTIONS or dotenv files inherited.
const isolatedConfig = mkdtempSync(path.join(tmpdir(), 'teamspeak-firebase-config-'));
const emulatorCache = path.join(tmpdir(), 'teamspeak-integration-tools', 'emulators');
mkdirSync(emulatorCache, { recursive: true });
const env = {
  XDG_CONFIG_HOME: isolatedConfig, FIREBASE_EMULATORS_PATH: emulatorCache,
  PATH: process.env.PATH,
  ...(process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : {}),
  NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', TEAMSPEAK_FIRESTORE_PORT: String(Number(port)),
  FIRESTORE_EMULATOR_HOST: host, GCLOUD_PROJECT: project, FIREBASE_PROJECT_ID: project,
  ...(withAuth ? { FIREBASE_AUTH_EMULATOR_HOST: authHost, TEAMSPEAK_AUTH_PORT: String(Number(authPort)), TEAMSPEAK_ENABLE_DELETE_TESTS: 'true' } : {}),
  CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
};
let result;
if (runOnly) {
  result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', withAuth ? 'vitest.deletion.config.ts' : 'vitest.integration.config.ts'], { cwd: root, env, stdio: 'inherit' });
} else {
  const directory = mkdtempSync(path.join(tmpdir(), 'teamspeak-emulator-'));
  const config = template;
  config.emulators.firestore = { host: '127.0.0.1', port: Number(port) };
  config.emulators.auth = { host: '127.0.0.1', port: Number(authPort) };
  config.firestore.rules = path.resolve(root, config.firestore.rules);
  const configPath = path.join(directory, 'firebase.json');
  writeFileSync(configPath, JSON.stringify(config));
  // Resolve before replacing PATH/environment. Logs and hub files stay outside the repository.
  const cli = process.env.TEAMSPEAK_FIREBASE_CLI || 'firebase';
  const command = `"${process.execPath}" "${__filename}" ${withAuth ? '--run-with-auth' : '--run'}`;
  result = spawnSync(cli, ['emulators:exec', '--only', withAuth ? 'firestore,auth' : 'firestore', '--project', project, '--config', configPath, '--non-interactive', command], { cwd: directory, env, stdio: 'inherit' });
}
if (result.error) console.error('Integration launcher failed:', result.error.code);
process.exitCode = result.status ?? 1;
