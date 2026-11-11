import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
// Runs before services importing dotenv/config. Reject unsafe direct Vitest invocations.
const project = 'demo-teamspeak-tests';
function valid(host: string | undefined) {
  const match = /^127\.0\.0\.1:([1-9][0-9]*)$/.exec(host ?? '');
  return !!match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535;
}
if (Number(process.versions.node.split('.')[0]) < 24 || process.env.NODE_ENV !== 'test'
  || process.env.DOTENV_CONFIG_PATH !== '/dev/null' || process.env.TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS !== 'true'
  || [process.env.FIREBASE_PROJECT_ID, process.env.FIREBASE_EXPECTED_PROJECT_ID, process.env.GCLOUD_PROJECT].some((value) => value !== project)
  || !valid(process.env.FIRESTORE_EMULATOR_HOST) || !valid(process.env.FIREBASE_AUTH_EMULATOR_HOST)
  || Number(process.env.FIRESTORE_EMULATOR_HOST?.split(':')[1]) === Number(process.env.FIREBASE_AUTH_EMULATOR_HOST?.split(':')[1])
  || ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CONFIG', 'FIREBASE_TOKEN', 'NODE_OPTIONS'].some((key) => !!process.env[key])) {
  throw new Error('Unsafe realtime integration environment. Use node scripts/firebase-integration.cjs.');
}
console.log(`Realtime integration runtime: Node ${process.versions.node}; local demo emulators only.`);
export {};

// Test-only transport boundary. Never patch transports in the application runtime.
const allowed = new Set([
  `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`,
  `http://${process.env.FIRESTORE_EMULATOR_HOST}`,
]);
function assertLocal(target: string | URL) {
  if (!allowed.has(new URL(target).origin)) throw new Error('REMOTE_TEST_NETWORK_BLOCKED');
}
const request = http.request;
Object.defineProperty(http, 'request', { configurable: true, writable: true, value: (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === 'string' || first instanceof URL) {
    assertLocal(first);
    // URL overrides are not needed by the SDK; reject ambiguous destinations.
    if (args[1] && typeof args[1] === 'object') throw new Error('AMBIGUOUS_TEST_NETWORK_TARGET');
  } else {
    const options = first as http.RequestOptions;
    assertLocal(`${options.protocol ?? 'http:'}//${options.hostname ?? options.host}:${options.port ?? 80}`);
    if (options.socketPath) throw new Error('REMOTE_TEST_NETWORK_BLOCKED');
  }
  return Reflect.apply(request, http, args);
} });
Object.defineProperty(https, 'request', { configurable: true, writable: true, value: () => { throw new Error('REMOTE_TEST_NETWORK_BLOCKED'); } });
const connect = http2.connect;
Object.defineProperty(http2, 'connect', { configurable: true, writable: true, value: (...args: unknown[]) => {
  assertLocal(args[0] as string | URL);
  return Reflect.apply(connect, http2, args);
} });
const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  assertLocal(typeof input === 'string' || input instanceof URL ? input : input.url);
  return localFetch(input, init);
};
