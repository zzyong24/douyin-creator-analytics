import process from 'node:process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ROOT, expectedNickname, AppError, RequestGate, atomicJson, readJson, retry, sleep, registerCleanup } from './runtime.mjs';
import { openEgo } from './ego.mjs';
import { parseIdentity } from './parse.mjs';
export const ORIGIN = 'https://creator.douyin.com';
export const HOME = `${ORIGIN}/creator-micro/home`;
export const MANAGE = `${ORIGIN}/creator-micro/content/manage`;
export const ANALYSIS = `${ORIGIN}/creator-micro/data-center/content`;
export const SESSION = `${ORIGIN}/aweme/v1/creator/user/info/`;
export const LIST_PATHS = ['/janus/douyin/creator/pc/work_list', '/aweme/v1/creator/item/list', '/creator/pc/work_list', '/web/aweme/post'];
export const isList = url => LIST_PATHS.some(p => url.pathname.replace(/\/$/, '') === p);
const WRITE_PATH = /(?:^|[\/_.-])(?:publish|upload|delete|remove|edit|update|modify|create|submit|send|digg|like|follow|unfollow|reply|logout|comment|post_item|write)(?=[\/_.-]|$)|(?:^|[\/_.-])set_/i;
// 当前没有实测需要放行的导出写关键词路径；仅支持精确合同，不支持通配。
export const EXACT_EXPORT_EXCEPTIONS = Object.freeze([]);
export function exactExportException(url,method,contracts=EXACT_EXPORT_EXCEPTIONS){return contracts.some(c=>c.host===url.host&&c.path===url.pathname&&c.method===method.toUpperCase());}
export function isReadRequest(url, method, type, { subdocument = false } = {}) {
  // 尚无经证实的 GET 写接口；静态资源文件名不属于写接口合同。
  const staticResource = ['script', 'stylesheet', 'image', 'font', 'media'].includes(type) || /\.(?:js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|map)$/i.test(url.pathname);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && !staticResource && WRITE_PATH.test(url.pathname) && !exactExportException(url,method)) return false;
  if (type === 'document' && subdocument && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) return true;
  if (type === 'document') return url.origin === ORIGIN && ([HOME, MANAGE, ANALYSIS].some(p => url.pathname === new URL(p).pathname) || url.pathname.startsWith('/creator-micro/data-center/'));
  return true;
}
export function analysisLink(href, id) {
  try {
    const url = new URL(href, ORIGIN);
    return url.origin === ORIGIN && url.pathname.startsWith('/creator-micro/data-center/') && !WRITE_PATH.test(url.pathname) &&
      ([...url.searchParams.values()].some(v => v === id) || url.pathname.split('/').includes(id)) ? url.href : null;
  } catch { return null; }
}
// 兼容以按钮而非a标签呈现的“数据分析”。目标必须先由作品ID定位，绝不只按标题猜行。
export async function dataActionSelector(page, id) {
  return page.evaluate(id => {
    const idInLink = anchor => {
      try {
        const u = new URL(anchor.href);
        return [...u.searchParams.values()].includes(id) || u.pathname.split('/').includes(id);
      } catch { return false; }
    };
    const anchors = [...document.querySelectorAll('a[href]')].filter(idInLink);
    const seeds = [...document.querySelectorAll('[data-row-key],[data-aweme-id],[data-item-id]')].filter(el =>
      ['data-row-key', 'data-aweme-id', 'data-item-id'].some(k => el.getAttribute(k) === id));
    // 新版卡片没有data-row-key时，仅在页面内存读取React的业务ID归属；不调用事件函数。
    const ids = (value, found = new Set(), depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 4) return found;
      if (Array.isArray(value)) { for (const row of value.slice(0, 30)) ids(row, found, depth + 1); return found; }
      for (const [key, child] of Object.entries(value)) {
        if (['id', 'aweme_id', 'item_id', 'awemeId', 'itemId'].includes(key) && typeof child === 'string' && /^\d{10,}$/.test(child)) found.add(child);
        else if (!['children', '_owner', 'ref'].includes(key) && typeof child === 'object') ids(child, found, depth + 1);
      }
      return found;
    };
    for (const el of document.querySelectorAll('main *,section *,[class*="item"],[class*="card"],[class*="row"]')) {
      const key = Object.keys(el).find(k => k.startsWith('__reactProps$'));
      if (!key) continue;
      const own = ids(el[key]);
      if (own.size === 1 && own.has(id)) seeds.push(el);
    }
    const selector = element => {
      const parts = [];
      for (let el = element; el && el !== document.documentElement; el = el.parentElement) {
        const siblings = [...el.parentElement.children].filter(x => x.tagName === el.tagName);
        parts.unshift(`${el.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(el) + 1})`);
      }
      return `html > ${parts.join(' > ')}`;
    };
    for (const seed of [...seeds, ...anchors]) {
      let parent = seed;
      for (let depth = 0; parent && depth < 7; depth++, parent = parent.parentElement) {
        const otherWorks = [...parent.querySelectorAll('[data-row-key],[data-aweme-id],[data-item-id]')].some(el =>
          ['data-row-key', 'data-aweme-id', 'data-item-id'].some(k => /^\d{10,}$/.test(el.getAttribute(k) ?? '') && el.getAttribute(k) !== id));
        const otherLinks = [...parent.querySelectorAll('a[href]')].some(anchor => {
          try {
            const u = new URL(anchor.href);
            const other = u.searchParams.get('item_id') ?? u.searchParams.get('aweme_id') ?? u.pathname.match(/\/(?:video|note)\/(\d+)/)?.[1];
            return other && other !== id;
          } catch { return false; }
        });
        if (otherWorks || otherLinks) break;
        const actions = [...parent.querySelectorAll('button,a,[role="button"],span,div')].filter(el =>
          /^(?:数据分析|查看数据|作品数据|查看详情|数据详情|作品分析|查看分析|内容分析)$/.test(el.textContent.trim()) && el.getBoundingClientRect().width > 0);
        // 只选最内层准确命中的入口，点击前由Playwright再次检查可见性。
        const leaf = actions.find(el => !actions.some(other => el !== other && el.contains(other)));
        if (leaf) return selector(leaf);
      }
    }
    return null;
  }, id);
}
export async function launch(headed) {
  expectedNickname();
  if (process.env.EGO_CDP_URL || process.env.ANALYTICS_ROUTE_ISOLATION) throw new AppError('DEFAULT_MODE_REQUIRED');
  const { chromium } = await import('playwright-core');
  return launchWithEgo(headed, { chromium });
}
export async function launchWithEgo(headed, options) {
  const gate = options.requestGate ?? new RequestGate({ path: join(ROOT, 'data/throttle.json') });
  const { context, connection } = await openEgo({ ...options, headed });
  const pages = new Set(), responses = new EventEmitter();
  const ownsPage = async page => {
    if (pages.has(page)) return true;
    const opener = await page.opener();
    if (opener && pages.has(opener)) { pages.add(page); return true; }
    return false;
  };
  const ownsRequest = async request => {
    try { return await ownsPage(request.frame().page()); } catch { return false; }
  };
  const state = { blocked: 0, httpError: null };
  const onResponse = async response => {
    if (!await ownsRequest(response.request())) return;
    // 自然请求不排队，也不等响应体结束；429只反馈给下一次显式采集。
    if (response.status() === 429) {
      gate.cooldown(120000);
      logProbe({ stage: 'background', status: 429, request: diagnosticUrl(response.url()) });
    }
    responses.emit('response', response);
  };
  const routeHandler = async route => {
    const req = route.request();
    // 共用 CDP context 时，已有标签页及其弹窗的请求原样交还，不采集、不拦截。
    if (!await ownsRequest(req)) { await route.fallback(); return; }
    const url = new URL(req.url());
    let subdocument = false;
    try { subdocument = Boolean(req.frame().parentFrame()); } catch {}
    const allowed = isReadRequest(url, req.method(), req.resourceType(), { subdocument });
    if (req.method() === 'POST' || !allowed) auditPost({ action: allowed ? 'allowed' : 'blocked', method: req.method(), host: url.host, path: url.pathname });
    if (!allowed) {
      state.blocked++;
      if (['fetch', 'xhr'].includes(req.resourceType())) logProbe({ stage: 'route', action: 'blocked', request: diagnosticUrl(req.url()), method: req.method(), type: req.resourceType() });
      await route.abort('blockedbyclient').catch(() => {}); return;
    }
    await route.continue().catch(() => {});
  };
  let closePromise, unregister;
  const close = () => closePromise ??= (async () => {
    unregister?.();
    context.off('response', onResponse);
    try {
      if (connection) {
        for (const page of pages) if (!page.isClosed()) await page.close();
      }
    } finally {
      try { if (!headed) await context.unroute('**/*', routeHandler); }
      finally {
        // connectOverCDP 返回连接的 close 在此版本中断开 transport，不发送 Browser.close。
        if (connection) await connection.close();
        else await context.close();
      }
    }
  })();
  unregister = registerCleanup(close);
  try {
    // 永远新建本次采集页，不导航或关闭已存在的空间/标签页。
    const page = await context.newPage();
    pages.add(page);
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(45000);
    context.on('response', onResponse);
    if (!headed) await context.route('**/*', routeHandler);
    return { context, page, gate, state, responses, close };
  } catch {
    await close().catch(() => {});
    throw new AppError('BROWSER_SETUP_FAILED');
  }
}
// 只记协议/主机/路径；不记录查询串、响应体、凭据及完整异常URL。
export function diagnosticUrl(value) {
  try { const u = new URL(value); return `${u.protocol}//${u.host}${u.pathname}`; }
  catch { return 'unknown'; }
}
export function diagnosticMessage(value) {
  return String(value ?? '').replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, '[URL]').replace(/(?:cookie|authorization|token|signature|password)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]').slice(0, 240);
}
export function logProbe(value) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...value });
  console.log(`探针诊断：${line}`);
  try { appendFileSync(join(ROOT, 'logs/probe.jsonl'), line + '\n', { mode: 0o600 }); } catch { /* 无日志目录的单测仍可执行 */ }
}
// 审计只接收固定白名单字段；永不保存query、body或请求头。
export function auditPost(value, writer = appendFileSync) {
  const record = { at: new Date().toISOString(), action: value.action, method: value.method, host: value.host, path: value.path };
  writer(join(ROOT, 'logs/allowed-post.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
}
export async function readJsonInPage(page, url, gate, { maxRetries = 3, exponentOffset = 0 } = {}) {
  return retry(async () => {
    let result;
    try {
      result = await explicitRead(gate, () => page.evaluate(async url => {
        let status = null, contentType = null;
        try {
          const r = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(30000) });
          status = r.status; contentType = r.headers.get('content-type');
          try { return { status, contentType, body: await r.json() }; }
          catch (e) { return { status, contentType, error: 'BAD_JSON', name: e.name }; }
        } catch (e) { return { status, contentType, error: e.name === 'TimeoutError' || e.name === 'AbortError' ? 'FETCH_TIMEOUT' : 'FETCH_FAILED', name: e.name }; }
      }, url));
    } catch { result = { error: 'EVALUATE_FAILED' }; }
    logProbe({ page: diagnosticUrl(page.url()), request: diagnosticUrl(url), status: result?.status ?? null,
      contentType: diagnosticMessage(result?.contentType), error: result?.error ?? null,
      name: ['SyntaxError', 'TimeoutError', 'AbortError', 'TypeError'].includes(result?.name) ? result.name : null });
    if (!result) throw new AppError('EMPTY_PROBE_RESULT');
    if (result.status === 401 || result.body?.status_code === 8) throw new AppError('NEEDS_LOGIN', 3);
    if (result.status >= 400) throw new AppError(`HTTP_${result.status}`);
    if (result.error) throw new AppError(result.error);
    return result.body;
  }, { gate, maxRetries, exponentOffset, onRetry: (n, code) => console.log(`只读请求重试 ${n}/${maxRetries}：${code}`) });
}
// 每次尝试只进闸一次；观察器重放可直接调用 readJsonInPage，不持有外层闸。
export const explicitRead = (gate, fn) => gate ? gate.run(fn) : fn();

// SESSION 诊断只提取键名，不输出类型之外的任何叶值或动态账号键。
export function sessionShape(json) {
  const paths = new Set();
  function visit(value, path, depth) {
    if (!value || typeof value !== 'object' || depth > 12 || paths.size >= 4000) return;
    if (Array.isArray(value)) {
      paths.add(`${path}[]`);
      for (const item of value) visit(item, `${path}[]`, depth + 1);
      return;
    }
    for (const key of Object.keys(value)) {
      const safe = /^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(key) && !/\d{6,}/.test(key);
      const next = `${path}.${safe ? key : '[键名已省略]'}`;
      paths.add(next);
      if (safe) visit(value[key], next, depth + 1);
    }
  }
  visit(json, '$', 0);
  return [...paths].sort();
}
export async function probeShape() {
  const browser = await launch(false);
  try {
    await navigate(browser.page, HOME, browser, { maxRetries: 0 });
    const json = await readJsonInPage(browser.page, SESSION, browser.gate, { maxRetries: 0 });
    await checkPage(browser.page, browser.state);
    console.log(`SESSION键名结构：${JSON.stringify(sessionShape(json))}`);
    console.log('结构提取完成；本命令不运行旧身份解析，不声明身份通过。');
  } catch (error) {
    logProbe({ stage: 'shape', code: error.code ?? 'UNKNOWN', blocked: browser.state.blocked });
    await browser.page.screenshot({ path: join(ROOT, 'logs/shape-failed.png') }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
}
export async function probeIdentity() {
  const browser = await launch(false);
  try {
    await navigate(browser.page, HOME, browser, { maxRetries: 0 });
    await requireIdentity(browser.page, browser.gate, false, {
      probe: (page, url, gate) => readJsonInPage(page, url, gate, { maxRetries: 0 }),
    });
    console.log('身份确认：预期账号核对通过');
  } catch (error) {
    logProbe({ stage: 'identity', page: diagnosticUrl(browser.page.url()), code: error.code ?? 'UNKNOWN', blocked: browser.state.blocked });
    try { await browser.page.screenshot({ path: join(ROOT, 'logs/probe-failed.png') }); } catch {}
    throw error;
  } finally { await browser.close(); }
}
export async function checkPage(page, state) {
  if (state.httpError === 401) throw new AppError('NEEDS_LOGIN', 3);
  if (state.httpError === 403) throw new AppError('HTTP_403');
  if (state.httpError === 429) throw new AppError('HTTP_429');
  let text = '';
  try { text = await page.locator('body').innerText({ timeout: 8000 }); } catch { /* 交给接口或超时判定 */ }
  if (/请完成.{0,12}(?:验证|验证码)|拖动滑块|安全验证|访问过于频繁/.test(text)) throw new AppError('CAPTCHA');
  if (/扫码登录|扫描二维码登录|登录抖音创作者中心/.test(text)) throw new AppError('NEEDS_LOGIN', 3);
}
export async function navigate(page, url, browser, { maxRetries = 3 } = {}) {
  return retry(async () => {
    browser.state.httpError = null;
    let response;
    try { response = await explicitRead(browser.gate, () => page.goto(url, { waitUntil: 'domcontentloaded' })); }
    catch { throw new AppError('NAVIGATION_FAILED'); }
    if (response?.status() >= 400) throw new AppError(`HTTP_${response.status()}`);
    await sleep(1500);
    await checkPage(page, browser.state);
  }, { gate: browser.gate, maxRetries, onRetry: (n, code) => console.log(`页面读取重试 ${n}/${maxRetries}：${code}`) });
}
export async function requireIdentity(page, gate, bind = false, { accountPath = join(ROOT, 'data/account.json'), probe = readJsonInPage, nickname = expectedNickname() } = {}) {
  const path = accountPath;
  if (!nickname?.trim()) throw new AppError('EXPECTED_NICKNAME_REQUIRED');
  const saved = readJson(path);
  const json = await probe(page, SESSION, gate);
  const code = json?.status_code;
  if (code === 8) throw new AppError('NEEDS_LOGIN', 3);
  if (code !== 0) throw new AppError('SESSION_UNKNOWN');
  const identity = parseIdentity(json);
  if (!identity) throw new AppError('IDENTITY_UNKNOWN');
  if (identity.nickname.trim() !== nickname.trim()) throw new AppError('ACCOUNT_MISMATCH');
  const fingerprint = createHash('sha256').update(identity.stable).digest('hex');
  if (saved && saved.fingerprint !== fingerprint) throw new AppError('ACCOUNT_MISMATCH');
  // account.json 仅是可选的身份约束；缺失不妨碍复用 Ego 的有效登录。
  if (!saved && bind) atomicJson(path, { nickname: nickname.trim(), fingerprint, bound_at: new Date().toISOString() });
  return fingerprint;
}
export async function login() {
  const browser = await launch(true);
  try {
    try { await browser.page.goto(HOME, { waitUntil: 'domcontentloaded' }); }
    catch { throw new AppError('NAVIGATION_FAILED'); }
    console.log('正在核对 Ego 现有登录；若未登录，请在新开的 Ego 页面用 DOUYIN_EXPECTED_NICKNAME 指定的账号登录；等待最多10分钟。');
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline && !browser.page.isClosed()) {
      try {
        // headed模式没有route闸，显式串行限流会话探针。
        await requireIdentity(browser.page, browser.gate, true);
        console.log('登录成功：已核对预期账号；登录态由 Ego Default profile 自行维护。');
        return;
      } catch (error) {
        if (error.code === 'ACCOUNT_MISMATCH') throw error;
        await sleep(5000);
      }
    }
    throw new AppError('LOGIN_TIMEOUT', 3);
  } finally { await browser.close(); }
}
