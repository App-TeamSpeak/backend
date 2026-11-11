const { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { supervise, resultCode } = require('../integration-ts01/run.cjs');
const root = path.resolve(__dirname, '..');
async function main() {
  if (+process.versions.node.split('.')[0] !== 24) throw new Error('Node 24 required');
  const internal = process.argv[2] === '--run';
  const directory = internal ? process.argv[3] : mkdtempSync(path.join(tmpdir(), 'teamspeak-rules-'));
  const nonce = internal ? process.argv[4] : randomUUID();
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const env = { PATH: process.env.PATH, XDG_CONFIG_HOME: directory, FIREBASE_EMULATORS_PATH: path.join(tmpdir(), 'teamspeak-integration-tools/emulators'),
      NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', PORT: '29801',
      FIREBASE_PROJECT_ID: 'demo-teamspeak-tests', FIREBASE_EXPECTED_PROJECT_ID: 'demo-teamspeak-tests', GCLOUD_PROJECT: 'demo-teamspeak-tests',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:29099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:28081',
      TEAMSPEAK_TS01_INTEGRATION: 'true', TEAMSPEAK_ENABLE_DELETE_TESTS: 'true', TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS: 'true',
      CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' };
    if (internal) {
      if (!directory || path.dirname(directory) !== tmpdir() || !path.basename(directory).startsWith('teamspeak-rules-')) throw new Error('INVALID_RUN_DIRECTORY');
      const stat = statSync(directory);
      if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('INVALID_RUN_OWNERSHIP');
      const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
      if (manifest.nonce !== nonce || manifest.project !== env.GCLOUD_PROJECT || existsSync(path.join(directory, 'completed.json'))) throw new Error('INVALID_RUN_MANIFEST');
      const result = await supervise(process.execPath,
        ['--test', '--test-reporter=spec', path.join(__dirname, 'rules.test.cjs')],
        { cwd: root, env: { ...env, TEAMSPEAK_RULES_RUN_DIRECTORY: directory, TEAMSPEAK_RULES_RUN_NONCE: nonce }, timeout: 60000, signal: abort.signal });
      if (resultCode(result)) throw new Error('RULES_TESTS_FAILED');
      writeFileSync(path.join(directory, 'completed.json'), JSON.stringify({ nonce, success: true }), { mode: 0o600, flag: 'wx' });
      return;
    }
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ nonce, project: env.GCLOUD_PROJECT }), { mode: 0o600, flag: 'wx' });
    for (const port of [28081, 29099, 24400, 24500, 29150]) {
      await new Promise((resolve, reject) => {
        const server = net.createServer(); server.once('error', reject);
        server.listen(port, '127.0.0.1', () => server.close(resolve));
      });
    }
    const cache = path.join(tmpdir(), 'teamspeak-integration-tools/emulators');
    if (!existsSync(path.join(cache, 'cloud-firestore-emulator-v1.22.0.jar'))) throw new Error('Existing emulator required; no automatic downloads');
    const config = path.join(directory, 'firebase.json');
    writeFileSync(config, JSON.stringify({ firestore: { rules: path.join(root, 'firestore.rules') }, emulators: {
      auth: { host: '127.0.0.1', port: 29099 }, firestore: { host: '127.0.0.1', port: 28081, websocketPort: 29150 },
      hub: { host: '127.0.0.1', port: 24400 }, logging: { host: '127.0.0.1', port: 24500 }, ui: { enabled: false }, singleProjectMode: true,
    } }));
    const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const command = [process.execPath, __filename, '--run', directory, nonce].map(quote).join(' ');
    const result = await supervise(process.env.TEAMSPEAK_FIREBASE_CLI || 'firebase',
      ['emulators:exec', '--only', 'auth,firestore', '--project', env.GCLOUD_PROJECT, '--config', config, '--non-interactive', command],
      { cwd: directory, env, timeout: 120000, signal: abort.signal });
    if (resultCode(result)) throw new Error('RULES_SUITE_FAILED');
    const receipt = JSON.parse(readFileSync(path.join(directory, 'completed.json'), 'utf8'));
    if (receipt.nonce !== nonce || receipt.success !== true) throw new Error('RULES_COMPLETION_NOT_CONFIRMED');
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (!internal) rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
