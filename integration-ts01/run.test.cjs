const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { resultCode, supervise, confirmCompletion } = require('./run.cjs');
const childEnv = { PATH: process.env.PATH, NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null' };
// Fixtures inherit neither credentials nor nested test-runner controls.
const zeroOnTerm = "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {},1000)";
test('regression: native spawnSync ETIMEDOUT/status 0 fails, including the parent exit code', () => {
  const old = spawnSync(process.execPath, ['-e', zeroOnTerm], { timeout: 500, env: childEnv });
  assert.equal(old.error.code, 'ETIMEDOUT'); assert.equal(old.status, 0);
  assert.equal(old.status ?? 1, 0, 'Vulnerable classification incorrectly succeeds');
  assert.equal(resultCode(old), 1);
  const parent = spawnSync(process.execPath, ['-e', `const {spawnSync}=require('node:child_process');const {resultCode}=require(${JSON.stringify(path.join(__dirname,'run.cjs'))});process.exitCode=resultCode(spawnSync(process.execPath,['-e',${JSON.stringify(zeroOnTerm)}],{timeout:500}));`], { env: childEnv });
  assert.equal(parent.status, 1);
});
test('classifies all process result fields conservatively', () => {
  assert.equal(resultCode({ status: 0, signal: null }), 0);
  for (const value of [
    { status: 0, error: { code: 'ETIMEDOUT' } }, { status: null, signal: 'SIGTERM' },
    { status: null, error: { code: 'ENOENT' } }, { status: 1 }, { status: null }, { status: 0, signal: 'SIGTERM' },
  ]) assert.equal(resultCode(value), 1);
});
test('zero CLI exit without a current completion receipt is failure', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'teamspeak-receipt-test-'));
  const ok = { status: 0, signal: null };
  try {
    assert.equal(confirmCompletion(directory, 'current', ok), false);
    writeFileSync(path.join(directory, 'completed.json'), JSON.stringify({ nonce: 'old', project: 'demo-teamspeak-tests', success: true }));
    assert.equal(confirmCompletion(directory, 'current', ok), false);
    writeFileSync(path.join(directory, 'completed.json'), JSON.stringify({ nonce: 'current', project: 'demo-teamspeak-tests', success: true }));
    assert.equal(confirmCompletion(directory, 'current', ok), true);
    assert.equal(confirmCompletion(directory, 'current', { ...ok, error: { code: 'ETIMEDOUT' } }), false);
    writeFileSync(path.join(directory, 'completed.json'), '{broken');
    assert.equal(confirmCompletion(directory, 'current', ok), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
const run = (code, extra = {}) => supervise(process.execPath, ['-e', code], { timeout: 3000, stdio: 'ignore', env: childEnv, ...extra });
test('supervisor accepts successful execution', async () => assert.equal(resultCode(await run('process.exit(0)')), 0));
test('supervisor rejects a failed execution', async () => assert.equal(resultCode(await run('process.exit(2)')), 1));
test('supervisor rejects signal termination', async () => {
  const result = await run("process.kill(process.pid,'SIGTERM')");
  assert.equal(result.signal, 'SIGTERM'); assert.equal(resultCode(result), 1);
});
test('supervisor preserves timeout failure even when SIGTERM exits zero', async () => {
  const result = await run(zeroOnTerm, { timeout: 500 });
  assert.equal(result.status, 0); assert.equal(result.error.code, 'ETIMEDOUT'); assert.equal(resultCode(result), 1);
});
test('supervisor propagates spawn errors', async () => {
  const result = await supervise('/does-not-exist-ts01', [], { timeout: 1000, stdio: 'ignore', env: childEnv });
  assert.equal(result.error.code, 'ENOENT'); assert.equal(resultCode(result), 1);
});
test('interruption cannot become success after graceful cleanup', async () => {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 500);
  try {
    const result = await run(zeroOnTerm, { signal: abort.signal });
    assert.equal(result.error.code, 'INTERRUPTED'); assert.equal(resultCode(result), 1);
  } finally { clearTimeout(timer); }
});
test('an already aborted stage never starts', async () => {
  const abort = new AbortController(); abort.abort();
  assert.equal((await run('process.exit(0)', { signal: abort.signal })).error.code, 'INTERRUPTED');
});

test('timeout closes the owned descendant before accepting its parent cleanup', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'teamspeak-child-test-'));
  const filename = path.join(directory, 'child.json');
  const descendant = "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),25));setInterval(()=>{},1000)";
  const parent = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(filename)},JSON.stringify({pid:child.pid}));process.on('SIGTERM',()=>child.once('exit',()=>process.exit(0)));setInterval(()=>{},1000);`;
  try {
    const result = await run(parent, { timeout: 700 });
    assert.equal(result.error.code, 'ETIMEDOUT'); assert.equal(result.status, 0);
    const { pid } = JSON.parse(readFileSync(filename, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(resultCode(result), 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
