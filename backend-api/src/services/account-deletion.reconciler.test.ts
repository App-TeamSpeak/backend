import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
const sdk = vi.hoisted(() => ({ withDeletionEmulatorClients: vi.fn(), processAccountDeletion: vi.fn() }));
vi.mock('../config/deletion-emulator-clients', () => ({ withDeletionEmulatorClients: sdk.withDeletionEmulatorClients }));
vi.mock('./account-deletion.processor', () => ({ processAccountDeletion: sdk.processAccountDeletion }));
import { createAccountDeletionReconciler } from './account-deletion.reconciler';
const instant = Timestamp.fromMillis(10000);
const marker = { status: 'pending', phase: 'auth', usernameKeys: [], attempts: 0, requestedAt: instant, updatedAt: instant };
let records: Map<string, Record<string, unknown>>;
let query: ReturnType<typeof vi.fn>;
let closed: number;
function fixture() {
  records = new Map(); closed = 0;
  query = vi.fn(async (cursor: string | undefined, limit: number) => {
    const docs = [...records].filter(([id, data]) => data.status === 'pending' && (!cursor || id > cursor)).sort(([a],[b]) => a.localeCompare(b)).slice(0,limit).map(([id,data]) => ({ id, data: () => data }));
    return { docs, size: docs.length };
  });
  sdk.withDeletionEmulatorClients.mockImplementation(async (operation) => {
    const build = (cursor?: string, limit = 25): object => ({ where: () => build(cursor,limit), orderBy: () => build(cursor,limit), limit: (value: number) => build(cursor,value), startAfter: (id: string) => build(id,limit), get: () => query(cursor,limit) });
    try { return await operation({ firestore: { collection: () => build() }, assertSafe: () => undefined }); }
    finally { closed++; }
  });
  sdk.processAccountDeletion.mockImplementation(async (uid: string) => { records.set(uid, { ...marker, status: 'completed', phase: 'done' }); });
}
function add(id: string, data: Record<string, unknown> = {}) { records.set(id, { ...marker, ...data }); }
const create = (options: Parameters<typeof createAccountDeletionReconciler>[0] = {}) => createAccountDeletionReconciler({ now: () => instant, ...options });
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.spyOn(console,'error').mockImplementation(() => undefined);
  for (const [key,value] of Object.entries({ NODE_ENV:'test', TEAMSPEAK_ENABLE_DELETE_TESTS:'true', TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS:'true', FIREBASE_PROJECT_ID:'demo-teamspeak-tests', GCLOUD_PROJECT:'demo-teamspeak-tests', DOTENV_CONFIG_PATH:'/dev/null', FIRESTORE_EMULATOR_HOST:'127.0.0.1:8081', FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099' })) vi.stubEnv(key,value);
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','FIREBASE_CONFIG','FIREBASE_TOKEN']) vi.stubEnv(key,'');
  fixture();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('deletion reconciler lifecycle and bounded discovery (mock SDK)', () => {
  it('does no work or scheduling when disabled', async () => {
    vi.stubEnv('TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS',''); const r=create(); await r.start(); await r.runOnce(); await r.stop();
    expect(sdk.withDeletionEmulatorClients).not.toHaveBeenCalled(); expect(sdk.processAccountDeletion).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([['NODE_ENV','production'],['FIRESTORE_EMULATOR_HOST','remote:8081'],['FIREBASE_AUTH_EMULATOR_HOST',''],['FIREBASE_PROJECT_ID','other'],['GOOGLE_APPLICATION_CREDENTIALS','synthetic']])('rejects unsafe %s before scheduling/querying', (key,value) => {
    vi.stubEnv(key,value); expect(() => create()).toThrow(); expect(vi.getTimerCount()).toBe(0); expect(query).not.toHaveBeenCalled();
  });
  it('runs initially, periodically, idempotently starts, then stops', async () => {
    add('a'); const r=create({ intervalMs:1000 }); await r.start(); await r.start(); expect(sdk.processAccountDeletion).toHaveBeenCalledTimes(1);
    add('b'); await vi.advanceTimersByTimeAsync(1000); expect(sdk.processAccountDeletion).toHaveBeenCalledTimes(2);
    await r.stop(); add('c'); await vi.advanceTimersByTimeAsync(5000); await r.runOnce(); expect(sdk.processAccountDeletion).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('selects absent/equal/past timestamps, ignores future/completed/blocked', async () => {
    add('a'); add('b',{nextAttemptAt:instant}); add('c',{nextAttemptAt:Timestamp.fromMillis(9999)}); add('d',{nextAttemptAt:Timestamp.fromMillis(10001)}); add('e',{status:'completed'}); add('f',{status:'blocked'});
    const result=await create().runOnce(); expect(result.processed).toBe(3); expect(sdk.processAccountDeletion.mock.calls.map(([uid])=>uid)).toEqual(['a','b','c']);
  });
  it('rejects malformed markers without changing them and continues', async () => {
    add('a',{phase:'done'}); add('b',{nextAttemptAt:'invalid'}); add('c'); const before=records.get('a');
    expect(await create().runOnce()).toMatchObject({malformed:2,processed:1}); expect(records.get('a')).toEqual(before);
  });
  it('advances bounded cursors past future documents without starvation', async () => {
    for(let i=0;i<5;i++) add(`a${i}`,{nextAttemptAt:Timestamp.fromMillis(20000)}); add('z');
    const r=create({pageSize:2,scanLimit:2}); expect((await r.runOnce()).processed).toBe(0); expect((await r.runOnce()).processed).toBe(0); expect((await r.runOnce()).processed).toBe(1);
    expect(query.mock.calls.map(([,limit])=>limit)).toEqual([2,2,2]);
  });
  it('limits admissions and preserves unvisited documents within a page', async () => {
    add('a');add('b');add('c');const r=create({batchSize:1,pageSize:3});
    for(let i=0;i<3;i++) expect((await r.runOnce()).processed).toBe(1);
    expect(sdk.processAccountDeletion.mock.calls.map(([uid])=>uid)).toEqual(['a','b','c']);
  });
  it('wraps its cursor so newly inserted earlier IDs are eventually found', async () => {
    add('z');const r=create({batchSize:1});await r.runOnce();add('a');await r.runOnce();await r.runOnce();expect(sdk.processAccountDeletion).toHaveBeenCalledWith('a');
  });
  it('continues after one account fails and logs no SDK text or UID', async () => {
    add('a');add('b');sdk.processAccountDeletion.mockRejectedValueOnce(new Error('PRIVATE'));
    expect(await create().runOnce()).toMatchObject({failed:1,processed:1});expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE');
  });
  it('reports query failures, releases scope, and recovers on the next pass', async () => {
    query.mockRejectedValueOnce(new Error('PRIVATE'));const r=create();await expect(r.runOnce()).rejects.toMatchObject({code:'RECONCILER_QUERY_FAILED'});expect(closed).toBe(1);add('a');expect((await r.runOnce()).processed).toBe(1);
  });
  it('continues periodic scheduling after an initial query failure', async () => {
    query.mockRejectedValueOnce(new Error());const r=create({intervalMs:1000});await r.start();add('a');await vi.advanceTimersByTimeAsync(1000);expect(sdk.processAccountDeletion).toHaveBeenCalledWith('a');await r.stop();
  });
  it('coalesces overlapping passes and stops admitting jobs during shutdown', async () => {
    add('a');add('b');let release!:()=>void;let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
    sdk.processAccountDeletion.mockImplementationOnce(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});});
    const r=create();const first=r.runOnce();await ready;expect(r.runOnce()).toBe(first);let stopped=false;const stop=r.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);release();await first;await stop;expect(sdk.processAccountDeletion).toHaveBeenCalledTimes(1);expect(r.getState().running).toBe(false);
  });
  it('uses fresh persistent discovery after replacing the instance', async () => {
    add('a',{nextAttemptAt:Timestamp.fromMillis(20000)});const old=create();await old.start();await old.stop();records.set('a',{...marker});const fresh=create();await fresh.start();expect(sdk.processAccountDeletion).toHaveBeenCalledWith('a');await fresh.stop();
  });
  it('stops scheduling if isolation changes after construction', async () => {
    const r=create();vi.stubEnv('FIRESTORE_EMULATOR_HOST','127.0.0.1:8082');await expect(r.start()).rejects.toMatchObject({statusCode:501});expect(r.getState().stopped).toBe(true);expect(vi.getTimerCount()).toBe(0);expect(query).not.toHaveBeenCalled();
  });
  it.each([{intervalMs:0},{batchSize:-1},{pageSize:101},{scanLimit:1001},{concurrency:2},{intervalMs:NaN}])('rejects invalid bounds %j', options => {
    expect(()=>create(options as Parameters<typeof create>[0])).toThrow();expect(query).not.toHaveBeenCalled();
  });
  it('validates explicit environment settings and flags', () => {
    vi.stubEnv('TEAMSPEAK_DELETION_RECONCILER_BATCH_SIZE','0');expect(()=>create()).toThrow();vi.stubEnv('TEAMSPEAK_ENABLE_DELETION_RECONCILER_TESTS','yes');expect(()=>create()).toThrow();
  });
  it('halts the pass before the next account if isolation is lost during processing', async () => {
    add('a');add('b');
    sdk.processAccountDeletion.mockImplementationOnce(async()=>{vi.stubEnv('TEAMSPEAK_ENABLE_DELETE_TESTS','');});
    const r=create();await expect(r.start()).rejects.toMatchObject({statusCode:501});
    expect(sdk.processAccountDeletion).toHaveBeenCalledTimes(1);expect(r.getState().stopped).toBe(true);expect(closed).toBe(1);expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule if isolation changes while the query scope is closing', async () => {
    const scope=sdk.withDeletionEmulatorClients.getMockImplementation()!;
    sdk.withDeletionEmulatorClients.mockImplementationOnce(async(operation)=>{
      const result=await scope(operation);vi.stubEnv('TEAMSPEAK_ENABLE_DELETE_TESTS','');return result;
    });
    const r=create();await r.start();expect(r.getState()).toMatchObject({stopped:true,scheduled:false,lastErrorCode:'NOT_IMPLEMENTED'});expect(vi.getTimerCount()).toBe(0);
  });

});
