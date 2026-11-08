import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, RequestGate, ROOT } from '../src/runtime.mjs';
import { assertEgoUnlocked, openEgo, EGO_USER_DATA_DIR, EGO_EXECUTABLE } from '../src/ego.mjs';
import { launchWithEgo, requireIdentity } from '../src/browser.mjs';
import { collect } from '../src/collect.mjs';
import { openDb } from '../src/store.mjs';

const absent = () => { throw Object.assign(new Error(), { code: 'ENOENT' }); };
const locked = error => error.code === 'EGO_PROFILE_LOCKED' && error.exitCode === 4;

test('SingletonLock（包括悬空链接）存在立即退出4，不启动浏览器或检查进程', async () => {
  let launches = 0;
  const unlocked = () => assertEgoUnlocked({ stat: path => {
    assert.equal(path, join(EGO_USER_DATA_DIR, 'SingletonLock')); return {};
  }, processes: () => assert.fail('锁存在时无需再扫描') });
  await assert.rejects(openEgo({ headed: false, env: {}, unlocked,
    chromium: { launchPersistentContext: async () => { launches++; } } }), locked);
  assert.equal(launches, 0);
});
test('没有锁但 Ego 主进程或目标 user-data-dir 占用仍退出4；无法检测时不启动', () => {
  for (const row of [EGO_EXECUTABLE, `chromium --user-data-dir=${EGO_USER_DATA_DIR}`, `chromium --user-data-dir="${EGO_USER_DATA_DIR}"`]) {
    assert.throws(() => assertEgoUnlocked({ stat: absent, processes: () => row }), locked);
  }
  assert.doesNotThrow(() => assertEgoUnlocked({ stat: absent, processes: () => '/usr/bin/other' }));
  assert.throws(() => assertEgoUnlocked({ stat: absent, processes: () => { throw new Error(); } }), { code: 'EGO_PROFILE_CHECK_FAILED' });
  assert.throws(() => assertEgoUnlocked({ stat: () => { throw Object.assign(new Error(), { code: 'EACCES' }); } }), { code: 'EGO_PROFILE_CHECK_FAILED' });
});
test('默认固定 Ego Chromium 入口、用户数据根和 Default，不使用 chrome channel', async () => {
  const context = {};
  let checks = 0;
  const result = await openEgo({ headed: false, env: {}, unlocked: () => checks++, executable: () => {},
    chromium: { launchPersistentContext: async (path, options) => {
      assert.equal(path, EGO_USER_DATA_DIR);
      assert.equal(options.executablePath, EGO_EXECUTABLE);
      assert.deepEqual(options.args, ['--profile-directory=Default']);
      assert.equal(options.headless, true); assert.equal(options.channel, undefined);
      return context;
    } } });
  assert.equal(result.context, context); assert.equal(checks, 1);
});
test('Chromium 启动时抢锁的竞态保留退出码4，原始启动报错不外泄', async () => {
  await assert.rejects(openEgo({ headed: false, env: {}, unlocked: () => {}, executable: () => {},
    chromium: { launchPersistentContext: async () => { throw new Error('ProcessSingleton private URL'); } } }), locked);
  await assert.rejects(openEgo({ headed: false, env: {}, unlocked: () => {}, executable: () => {},
    chromium: { launchPersistentContext: async () => { throw new Error('sensitive launch output'); } } }), error => error.code === 'BROWSER_LAUNCH_FAILED' && !error.message.includes('sensitive'));
});
test('CDP 优先于锁检测与独占启动，连接失败不回退抢 profile', async () => {
  const context = {}, connection = { contexts: () => [context] };
  const options = { headed: false, env: { EGO_CDP_URL: 'http://127.0.0.1:9333' },
    unlocked: () => assert.fail('CDP不检测独占锁'), executable: () => assert.fail(),
    chromium: { connectOverCDP: async (url, opts) => {
      assert.equal(url, 'http://127.0.0.1:9333'); assert.equal(opts.timeout, 30000); assert.equal(opts.noDefaults, true); return connection;
    }, launchPersistentContext: () => assert.fail('不应独占启动') } };
  assert.equal((await openEgo(options)).connection, connection);
  await assert.rejects(openEgo({ ...options, chromium: { connectOverCDP: async () => { throw new Error('secret'); } } }), { code: 'EGO_CDP_CONNECT_FAILED' });
  await assert.rejects(openEgo({ ...options, env: { EGO_CDP_URL: 'https://remote.invalid:9333' } }), { code: 'EGO_CDP_URL_INVALID' });
});
test('CDP 新建采集页，只拦截/观察本次页面，清理不关闭共享 context 或已有标签页', async () => {
  const context = new EventEmitter();
  let closed = 0, disconnected = 0, removed = 0, handler;
  const page = { opener: async () => null, setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    isClosed: () => false, close: async () => closed++ };
  const existing = { opener: async () => null, close: () => assert.fail('不能碰已有页') };
  context.newPage = async () => page;
  context.close = () => assert.fail('不能关闭共用context');
  context.route = async (_pattern, fn) => { handler = fn; };
  context.unroute = async (_pattern, fn) => { assert.equal(fn, handler); removed++; };
  const connection = { contexts: () => [context], close: async () => disconnected++ };
  const browser = await launchWithEgo(false, { env: { EGO_CDP_URL: 'http://localhost:9333' },
    requestGate: new RequestGate({}), chromium: { connectOverCDP: async () => connection } });
  let aborted = 0, bypassed = 0, observed = 0;
  const request = target => ({ frame: () => ({ page: () => target }), url: () => 'https://creator.douyin.com/write', method: () => 'POST', resourceType: () => 'fetch' });
  const route = target => ({ request: () => request(target), abort: async () => aborted++, fallback: async () => bypassed++ });
  await handler(route(existing)); await handler(route(page));
  assert.equal(aborted, 1); assert.equal(bypassed, 1);
  browser.responses.on('response', () => observed++);
  context.emit('response', { request: () => request(existing), status: () => 200 });
  context.emit('response', { request: () => request(page), status: () => 200 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed, 1);
  await browser.close();
  assert.equal(closed, 1); assert.equal(disconnected, 1); assert.equal(removed, 1);
  assert.equal(context.listenerCount('response'), 0);
});
test('没有 account.json 仍调用现有登录探针；未登录保持NEEDS_LOGIN，错号保持停止', async () => {
  const dir = mkdtempSync(join(ROOT, 'logs/analytics-identity-'));
  const accountPath = join(dir, 'account.json');
  try {
    const options = { accountPath, nickname: '测试账号', probe: async () => ({ status_code: 0, data: { nickname: '测试账号', uid: 'fixture-id' } }) };
    assert.match(await requireIdentity({}, null, false, options), /^[a-f0-9]{64}$/);
    assert.equal(existsSync(accountPath), false, 'collect不需要创建绑定');
    await assert.rejects(requireIdentity({}, null, false, { accountPath, nickname: '测试账号', probe: async () => ({ status_code: 8 }) }), { code: 'NEEDS_LOGIN', exitCode: 3 });
    await assert.rejects(requireIdentity({}, null, false, { accountPath, nickname: '测试账号', probe: async () => ({ status_code: 0, data: { nickname: '其他账号', uid: 'other' } }) }), { code: 'ACCOUNT_MISMATCH' });
    writeFileSync(accountPath, JSON.stringify({ fingerprint: 'old-account' }));
    await assert.rejects(requireIdentity({}, null, false, options), { code: 'ACCOUNT_MISMATCH' });
  } finally { rmSync(dir, { recursive: true }); }
});
test('collect锁异常入库为failed并向CLI保留退出码4，没有作品和指标', async () => {
  const db = openDb(':memory:');
  try {
    const result = await collect(db, { openBrowser: async () => { throw new AppError('EGO_PROFILE_LOCKED', 4); } });
    assert.equal(result.exitCode, 4); assert.equal(result.error, 'EGO_PROFILE_LOCKED');
    assert.equal(result.collected, 0); assert.equal(result.pageCount, null);
    assert.equal(db.prepare('SELECT status FROM collect_runs').get().status, 'failed');
    assert.equal(db.prepare('SELECT count(*) n FROM metric_snapshots').get().n, 0);
  } finally { db.close(); }
});

 test('Ego 启动不使用模拟钥匙串或 basic 密码存储', async () => {
  let seen;
  await openEgo({ headed: false, env: {}, unlocked: () => {}, executable: () => {},
    chromium: { launchPersistentContext: async (_path, options) => { seen = options; return {}; } } });
  assert.deepEqual(seen.ignoreDefaultArgs, ['--use-mock-keychain', '--password-store=basic']);
 });
