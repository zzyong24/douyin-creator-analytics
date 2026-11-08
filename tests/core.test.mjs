import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseList, detailRecords, metricsOf, mergeMetrics, pageCount, parseIdentity, sanitize, number } from '../src/parse.mjs';
import { openDb, startRun, finishRun, saveWork, latestRows } from '../src/store.mjs';
import { buildReport, shanghaiDate } from '../src/report.mjs';
import { AppError, RequestGate, retry } from '../src/runtime.mjs';
import { isReadRequest, analysisLink } from '../src/browser.mjs';
import { collect, scopeOf } from '../src/collect.mjs';
const catalog = JSON.parse(readFileSync(new URL('./fixtures/catalog.json', import.meta.url)));
const detail = JSON.parse(readFileSync(new URL('./fixtures/detail.json', import.meta.url)));

test('解析目录：长ID、标题、时长毫秒、真0与缺失分开', () => {
  const parsed = parseList(catalog);
  assert.equal(parsed.hasMore, false); assert.equal(parsed.total, 2);
  assert.equal(parsed.works[0].aweme_id, '7561234567890123456');
  assert.equal(parsed.works[0].duration_sec, 61.5);
  assert.equal(parsed.works[0].metrics.comments, 0);
  assert.equal(parsed.works[1].metrics.favorites, null);
  assert.equal(parsed.works[1].title, '先写清楚问题');
});
test('支持item_list和字符串has_more，未知schema与数字ID拒绝', () => {
  assert.equal(parseList({ item_list: [], has_more: '0' }).hasMore, false);
  assert.equal(parseList({ item_list: [], has_more: '1' }).hasMore, true);
  assert.equal(parseList({ item_list: [] }).hasMore, null);
  assert.throws(() => parseList({}), /LIST_SCHEMA_UNKNOWN/);
  assert.throws(() => parseList({ item_list: [{ aweme_id: 7561234567890123456 }] }), /WORK_ID_INVALID/);
});
test('明细：只按ID归属、保留扩展字段、秒值和比例', () => {
  const [record] = detailRecords(detail);
  assert.equal(record.aweme_id, catalog.data.aweme_list[0].aweme_id);
  assert.equal(record.metrics.finish_rate, 0.32);
  assert.equal(record.metrics.avg_play_duration_sec, 24.5);
  assert.equal(record.metrics.follower_gain, 7);
  assert.equal(record.metrics.finish_5s_rate, 0.72);
  assert.equal(detail.data.unmapped_platform_field, 123);
});
test('无法识别ID的账号汇总不能误作单作品；不累加时序数组', () => {
  assert.deepEqual(detailRecords({ data: { play_count: 100 } }), []);
  const rows = detailRecords({ data: { play_count: 100, series: [{ play_count: 5 }, { play_count: 8 }] } }, '123');
  assert.equal(rows[0].metrics.plays, 100);
});
test('明细多作品不能串号，requestId不覆盖响应内ID', () => {
  const rows = detailRecords({ data: [{ item_id: '1', play_count: 10 }, { item_id: '2', play_count: 20 }] }, '1');
  assert.equal(rows.find(x => x.aweme_id === '2').metrics.plays, 20);
});
test('数值不猜单位，不把空串、短横或非数值当0', () => {
  assert.equal(number(''), null); assert.equal(number('-'), null); assert.equal(number('1万'), null);
  assert.equal(number('1,234'), 1234); assert.equal(number('0%'), 0);
  assert.equal(metricsOf({ finish_rate: 1 }).finish_rate, 1);
});
test('页面数与接口数分开，识别全部作品/全部标签', () => {
  assert.equal(pageCount('全部作品（1,234）'), 1234);
  assert.equal(pageCount('共 23 个作品'), 23);
  assert.equal(pageCount('全部 (0)'), 0);
  assert.equal(pageCount('粉丝 9999'), null);
});
test('身份必须同时有昵称和稳定字符串ID', () => {
  assert.deepEqual(parseIdentity({ data: { user_info: { nickname: '测试账号', uid: '100' } } }), { nickname: '测试账号', stable: '100' });
  assert.equal(parseIdentity({ data: { nickname: '测试账号' } }), null);
});
test('实测SESSION结构用user_profile.nick_name和secret_id，合成值不冒充实测', () => {
  assert.deepEqual(parseIdentity({status_code:0,user_profile:{nick_name:'测试账号',secret_id:'synthetic-stable-id',unique_id:'synthetic-handle'}}),{nickname:'测试账号',stable:'synthetic-stable-id'});
  for (const profile of [{nick_name:'测试账号'},{nick_name:'测试账号',unique_id:'synthetic-handle'},{nick_name:'测试账号',secret_id:123},{nick_name:'测试账号',secret_id:' '}]) assert.equal(parseIdentity({user_profile:profile}),null);
  assert.equal(parseIdentity({data:{nickname:'测试账号',unique_id:'synthetic-handle'}}),null);
});
test('raw去凭据但保留未映射业务字段和安全封面参数', () => {
  const safe = sanitize({ ...detail, sessionid: 'secret', headers: { Cookie: 'secret' } });
  const text = JSON.stringify(safe);
  assert.ok(!text.includes('fixture-secret')); assert.ok(!text.includes('sessionid')); assert.ok(!text.includes('Cookie'));
  assert.equal(safe.data.unmapped_platform_field, 123);
  assert.ok(safe.data.cover.endsWith('width=200'));
});
test('SQLite：快照幂等、映射不覆盖、raw脱敏、同作品多次快照', () => {
  const db = openDb(':memory:');
  try {
    const work = parseList(catalog).works[0]; const run = startRun(db);
    saveWork(db, run, work, work.metrics, detail, '2026-11-06T00:00:00Z');
    db.prepare('UPDATE works SET topic_id=?,works_dir=? WHERE aweme_id=?').run('OT-20261106-01', 'works/2026/W-test', work.aweme_id);
    saveWork(db, run, work, { ...work.metrics, plays: 1100 }, detail, '2026-11-06T00:00:01Z');
    assert.equal(db.prepare('SELECT count(*) n FROM metric_snapshots').get().n, 1);
    assert.equal(latestRows(db)[0].topic_id, 'OT-20261106-01');
    assert.ok(!latestRows(db)[0].raw_json.includes('fixture-secret'));
    const run2 = startRun(db); saveWork(db, run2, work, work.metrics, {}, '2026-11-07T00:00:00Z');
    assert.equal(db.prepare('SELECT count(*) n FROM metric_snapshots').get().n, 2);
    assert.equal(finishRun(db, run2, { status: 'success', pageCount: 1 }), 1);
    assert.equal(db.prepare('SELECT page_work_count FROM collect_runs WHERE id=?').get(run2).page_work_count, 1);
  } finally { db.close(); }
});
test('事务失败不能留下孤立作品，外键有效', () => {
  const db = openDb(':memory:');
  try {
    const work = parseList(catalog).works[0];
    assert.throws(() => saveWork(db, 999, work, work.metrics, {}));
    assert.equal(db.prepare('SELECT count(*) n FROM works').get().n, 0);
  } finally { db.close(); }
});
test('报告：排序、空值、上一快照变化、实际间隔与状态警示', () => {
  const db = openDb(':memory:');
  try {
    const works = parseList(catalog).works;
    const run1 = startRun(db, '2026-11-06T00:00:00Z');
    for (const work of works) saveWork(db, run1, work, work.metrics, { scope: {period_verified:true,period:'合成相同累计周期'} }, '2026-11-06T00:00:00Z');
    finishRun(db, run1, { status: 'success' });
    const run2 = startRun(db, '2026-11-07T00:00:00Z');
    saveWork(db, run2, works[0], mergeMetrics(works[0].metrics, detailRecords(detail)[0].metrics), { scope: {period_verified:true,period:'合成相同累计周期'} }, '2026-11-07T00:00:00Z');
    finishRun(db, run2, { status: 'partial', pageCount: 2, error: 'DETAIL_METRICS_MISSING' });
    const report = buildReport(db, new Date('2026-11-07T00:00:00Z'));
    assert.match(report, /状态：partial/); assert.match(report, /页面显示作品数：2/);
    assert.match(report, /TOP10/); assert.match(report, /底部10/); assert.match(report, /\| 24 \| 100 \|/);
    assert.match(report, /—/); assert.match(report, /混有历史数据/);
  } finally { db.close(); }
});
test('口径变化不计算增长，首次空库报告可生成', () => {
  const db = openDb(':memory:');
  try {
    assert.match(buildReport(db), /尚未采集/);
    const work = parseList(catalog).works[0];
    saveWork(db, startRun(db), work, work.metrics, { scope: '7days' }, '2026-11-06T00:00:00Z');
    saveWork(db, startRun(db), work, { ...work.metrics, plays: 1200 }, { scope: '30days' }, '2026-11-07T00:00:00Z');
    assert.match(buildReport(db), /统计周期\/可比来源未核实，未比较/);
  } finally { db.close(); }
});
test('上海日期按跨日边界计算', () => assert.equal(shanghaiDate(new Date('2026-11-06T17:00:00Z')), '20261107'));
test('只读闸拦写请求/写页，只接收实际同源ID分析链接', () => {
  assert.equal(isReadRequest(new URL('https://creator.douyin.com/aweme/v1/creator/item/delete/'), 'GET', 'fetch'), true);
  assert.equal(isReadRequest(new URL('https://creator.douyin.com/read'), 'POST', 'fetch'), true);
  assert.equal(isReadRequest(new URL('https://creator.douyin.com/creator-micro/content/upload'), 'GET', 'document'), false);
  assert.equal(analysisLink('/creator-micro/data-center/content/detail?item_id=123', '123'), 'https://creator.douyin.com/creator-micro/data-center/content/detail?item_id=123');
  assert.equal(analysisLink('/creator-micro/data-center/content/detail?item_id=456', '123'), null);
  assert.equal(analysisLink('https://evil.invalid/?item_id=123', '123'), null);
});
test('串行闸覆盖请求整个生命周期，间隔至少4秒，正抖动', async () => {
  let now = 10000, active = 0, max = 0; const starts = [];
  const gate = new RequestGate({ now: () => now, random: () => 0.5, wait: async ms => { now += ms; } });
  await Promise.all([1, 2, 3].map(() => gate.run(async () => {
    starts.push(now); max = Math.max(max, ++active); await Promise.resolve(); now += 100; active--;
  })));
  assert.equal(max, 1);
  assert.ok(starts[1] - starts[0] >= 4100); assert.ok(starts[2] - starts[1] >= 4100);
});
test('失败最多重试3次，指数等待，未登录不重试', async () => {
  let calls = 0; const waits = [];
  await assert.rejects(retry(async () => { calls++; throw new AppError('NETWORK_ERROR'); }, { random: () => 0, wait: async ms => waits.push(ms) }));
  assert.equal(calls, 4); assert.deepEqual(waits, [4000, 8000, 16000]);
  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new AppError('NEEDS_LOGIN', 3); }));
  assert.equal(calls, 1);
});
test('429重试持久冷却参数为120/240/480秒', async () => {
  const waits = [];
  await assert.rejects(retry(async () => { throw new AppError('HTTP_429'); }, { gate: { cooldown: ms => waits.push(ms) }, random: () => 0 }));
  assert.deepEqual(waits, [120000, 240000, 480000]);
});
test('口径只存业务参数，不保存签名', () => assert.deepEqual(scopeOf(new URL('https://creator.douyin.com/api/stats?date_type=7&token=secret&item_id=123')), { path: '/api/stats', date_type: '7' }));
test('collect未登录异常落run表，退出码3，不写作品', async () => {
  const db = openDb(':memory:');
  try {
    const result = await collect(db, { openBrowser: async () => { throw new AppError('NEEDS_LOGIN', 3); } });
    assert.equal(result.exitCode, 3); assert.equal(result.collected, 0); assert.equal(result.pageCount, null);
    assert.equal(db.prepare('SELECT status FROM collect_runs').get().status, 'needs_login');
  } finally { db.close(); }
});

