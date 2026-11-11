const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const project = 'demo-teamspeak-tests';
function local(value) {
  const match = /^127\.0\.0\.1:([1-9][0-9]*)$/.exec(value || '');
  return !!match && +match[1] >= 1024 && +match[1] <= 65535;
}
function assertSafe() {
  if (+process.versions.node.split('.')[0] !== 24 || process.env.NODE_ENV !== 'test'
    || process.env.TEAMSPEAK_TS01_INTEGRATION !== 'true'
    || process.env.TEAMSPEAK_ENABLE_DELETE_TESTS !== 'true'
    || process.env.TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS !== 'true'
    || process.env.DOTENV_CONFIG_PATH !== '/dev/null'
    || ['FIREBASE_PROJECT_ID', 'FIREBASE_EXPECTED_PROJECT_ID', 'GCLOUD_PROJECT'].some(key => process.env[key] !== project)
    || !local(process.env.FIREBASE_AUTH_EMULATOR_HOST) || !local(process.env.FIRESTORE_EMULATOR_HOST)
    || process.env.FIREBASE_AUTH_EMULATOR_HOST === process.env.FIRESTORE_EMULATOR_HOST
    || ['GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','FIREBASE_TOKEN','FIREBASE_CONFIG','NODE_OPTIONS'].some(key => !!process.env[key])) {
    throw new Error('UNSAFE_TS01_ENVIRONMENT');
  }
}
assertSafe();
const allowed = new Set();
const blocked = new Set();
function allow(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !local(url.host) || url.pathname !== '/' || url.username || url.password) throw new Error('UNSAFE_TEST_ORIGIN');
  allowed.add(url.origin);
}
allow('http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST);
allow('http://' + process.env.FIRESTORE_EMULATOR_HOST);
allow('http://127.0.0.1:' + process.env.PORT);
function check(target) {
  const url = new URL(target);
  if (!allowed.has(url.origin) || blocked.has(url.origin)) throw new Error('TEST_NETWORK_BLOCKED');
}
for (const [transport, protocol] of [[http, 'http:'], [https, 'https:']]) {
  const original = transport.request;
  transport.request = function (...args) {
    const value = args[0];
    if (typeof value === 'string' || value instanceof URL) {
      check(value);
      if (args[1] && typeof args[1] === 'object') throw new Error('AMBIGUOUS_NETWORK_TARGET');
    } else {
      if (value.socketPath || value.createConnection) throw new Error('UNSAFE_NETWORK_OPTIONS');
      check(`${value.protocol || protocol}//${value.hostname || value.host}:${value.port || (protocol === 'http:' ? 80 : 443)}`);
    }
    return Reflect.apply(original, transport, args);
  };
  transport.get = function (...args) { const request = transport.request(...args); request.end(); return request; };
}
const connect = http2.connect;
http2.connect = function (authority, ...args) {
  check(authority);
  const session = Reflect.apply(connect, http2, [authority, ...args]);
  const request = session.request;
  session.request = function (...params) { check(authority); return Reflect.apply(request, session, params); };
  return session;
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  check(typeof input === 'string' || input instanceof URL ? input : input.url);
  return nativeFetch(input, { ...init, redirect: 'error' });
};
const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeWebSocket {
  constructor(url, ...args) {
    const target = new URL(url);
    if (target.protocol !== 'ws:') throw new Error('TEST_NETWORK_BLOCKED');
    check('http://' + target.host);
    super(url, ...args);
  }
};
module.exports = { assertSafe, allow, block: origin => blocked.add(origin), unblock: origin => blocked.delete(origin) };
