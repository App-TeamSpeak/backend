const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const project = 'demo-teamspeak-tests';
const ports = { firestore: 18081, auth: 19099, hub: 14400, logging: 14500, websocket: 19150, api: 19801 };

// Applies equally to spawnSync regression results and supervised async children.
function resultCode(result) {
  return result && !result.error && !result.signal && result.status === 0 ? 0 : 1;
}
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function signalGroup(pid, signal) {
  if (!pid) return;
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function cleanGroup(pid, graceMs) {
  if (!pid || !groupAlive(pid)) return;
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < deadline) await delay(25);
  if (groupAlive(pid)) {
    signalGroup(pid, 'SIGKILL');
    const killedDeadline = Date.now() + 500;
    while (groupAlive(pid) && Date.now() < killedDeadline) await delay(25);
    if (groupAlive(pid)) throw Object.assign(new Error('PROCESS_GROUP_CLEANUP_INCOMPLETE'), { code: 'CLEANUP_INCOMPLETE' });
  }
}
// A separate POSIX process group per stage; never kill by executable name.
async function supervise(command, args, { cwd, env, timeout, signal, graceMs = 3000, stdio = 'inherit' }) {
  if (process.platform === 'win32') throw new Error('POSIX process groups required');
  if (signal?.aborted) return { status: null, signal: null, error: { code: 'INTERRUPTED' } };
  let failure;
  const child = spawn(command, args, { cwd, env, stdio, detached: true });
  let escalation;
  const stop = code => {
    if (failure) return;
    failure = Object.assign(new Error(code), { code });
    signalGroup(child.pid, 'SIGTERM');
    escalation = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), graceMs);
  };
  const abort = () => stop('INTERRUPTED');
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('ETIMEDOUT'), timeout);
  const result = await new Promise(resolve => {
    child.once('error', error => { failure ??= error; });
    child.once('close', (status, endedBySignal) => resolve({ status, signal: endedBySignal }));
  });
  clearTimeout(timer); clearTimeout(escalation);
  signal?.removeEventListener('abort', abort);
  try { await cleanGroup(child.pid, graceMs); }
  catch (error) {
    failure ??= error;
    console.error({ event: 'ts01_process_cleanup_failed', code: error.code });
  }
  return { ...result, error: failure };
}
function assertResult(result, phase) {
  if (resultCode(result)) {
    console.error({ event: 'ts01_stage_failed', phase, code: result.error?.code ?? result.signal ?? ('EXIT_' + result.status) });
    throw new Error('TS01_STAGE_FAILED: ' + phase);
  }
}
function confirmCompletion(directory, nonce, result) {
  if (resultCode(result)) return false;
  try {
    const receipt = JSON.parse(readFileSync(path.join(directory, 'completed.json'), 'utf8'));
    return receipt.nonce === nonce && receipt.project === project && receipt.success === true;
  } catch { return false; }
}
function environment(directory) {
  return {
    PATH: process.env.PATH, ...(process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : {}),
    XDG_CONFIG_HOME: directory, FIREBASE_EMULATORS_PATH: path.join(tmpdir(), 'teamspeak-integration-tools', 'emulators'),
    NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', PORT: String(ports.api),
    FIREBASE_PROJECT_ID: project, FIREBASE_EXPECTED_PROJECT_ID: project, GCLOUD_PROJECT: project,
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:' + ports.firestore, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:' + ports.auth,
    TEAMSPEAK_ENABLE_DELETE_TESTS: 'true', TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS: 'true', TEAMSPEAK_TS01_INTEGRATION: 'true',
    CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
  };
}
async function main() {
  if (+process.versions.node.split('.')[0] !== 24) throw new Error('Node 24 required');
  if (process.platform === 'win32') throw new Error('POSIX process groups required');
  const internal = process.argv[2] === '--run';
  const directory = internal ? process.argv[3] : mkdtempSync(path.join(tmpdir(), 'teamspeak-ts01-'));
  const nonce = internal ? process.argv[4] : randomUUID();
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let primaryFailure;
  try {
    if (internal) {
      // A run-private manifest identifies the parent. It is NOT a success receipt.
      if (!directory || path.dirname(directory) !== tmpdir() || !path.basename(directory).startsWith('teamspeak-ts01-')) throw new Error('INVALID_RUN_DIRECTORY');
      const stat = statSync(directory);
      if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('INVALID_RUN_OWNERSHIP');
      const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
      if (manifest.nonce !== nonce || manifest.project !== project || existsSync(path.join(directory, 'completed.json'))) throw new Error('INVALID_RUN_MANIFEST');
    } else {
      writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ nonce, project }), { mode: 0o600, flag: 'wx' });
    }
    const isolated = environment(directory);
    const run = async (command, args, phase, timeout, cwd) => {
      const result = await supervise(command, args, { cwd, env: isolated, timeout, signal: abort.signal });
      assertResult(result, phase);
      return result;
    };
    if (internal) {
      for (const key of Object.keys(isolated).filter(key => key.includes('HOST') || key.includes('PROJECT') || key.startsWith('TEAMSPEAK_'))) {
        if (process.env[key] !== isolated[key]) throw new Error('Use the complete TS01 launcher');
      }
      await run(process.execPath, ['--test','--test-concurrency=1','--test-reporter=spec',path.join(__dirname, 'ts01.test.cjs')], 'joint-tests', 180000, root);
      if (abort.signal.aborted) throw new Error('TS01_INTERRUPTED');
      // Only after successful runner exit AND its process-group cleanup.
      writeFileSync(path.join(directory, 'completed.json'), JSON.stringify({ nonce, project, success: true }), { mode: 0o600, flag: 'wx' });
      console.log({ event: 'ts01_runner_completed' });
      return;
    }
    for (const port of Object.values(ports)) {
      if (abort.signal.aborted) throw new Error('TS01_INTERRUPTED');
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', error => reject(new Error('Reserved TS01 port unavailable: ' + port + ' ' + error.code)));
        server.listen(port, '127.0.0.1', () => server.close(resolve));
      });
    }
    if (!existsSync(path.join(isolated.FIREBASE_EMULATORS_PATH, 'cloud-firestore-emulator-v1.22.0.jar'))) throw new Error('Existing Firestore emulator required; downloads are not authorized');
    for (const service of ['backend-api', 'backend-realtime']) {
      await run(process.execPath, [path.join(root, service, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, service, 'tsconfig.json')], 'build-' + service, 60000, root);
    }
    const config = {
      firestore: { rules: path.join(root, 'backend-realtime/firestore.emulator.rules') },
      emulators: { auth: { host: '127.0.0.1', port: ports.auth }, firestore: { host: '127.0.0.1', port: ports.firestore, websocketPort: ports.websocket },
        hub: { host: '127.0.0.1', port: ports.hub }, logging: { host: '127.0.0.1', port: ports.logging }, ui: { enabled: false }, singleProjectMode: true },
    };
    const filename = path.join(directory, 'firebase.json'); writeFileSync(filename, JSON.stringify(config));
    const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const command = [process.execPath, __filename, '--run', directory, nonce].map(quote).join(' ');
    const result = await run(process.env.TEAMSPEAK_FIREBASE_CLI || 'firebase', ['emulators:exec','--only','auth,firestore','--project',project,'--config',filename,'--non-interactive',command], 'emulator-suite', 240000, directory);
    if (abort.signal.aborted || !confirmCompletion(directory, nonce, result)) throw new Error('TS01_COMPLETION_NOT_CONFIRMED');
    console.log({ event: 'ts01_validation_completed', success: true });
  } catch (error) { primaryFailure = error; throw error; }
  finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    // Only the owner deletes its private directory, after CLI/process cleanup.
    if (!internal) {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch {
        console.error({ event: 'ts01_directory_cleanup_failed', code: 'CLEANUP_INCOMPLETE' });
        if (!primaryFailure) throw new Error('TS01_DIRECTORY_CLEANUP_FAILED');
      }
    }
  }
}
module.exports = { resultCode, supervise, confirmCompletion, main };
if (require.main === module) main().catch(error => { console.error({ event: 'ts01_launcher_failed', code: error.message }); process.exitCode = 1; });
