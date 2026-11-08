import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, openSync, closeSync, unlinkSync, lstatSync, realpathSync, fstatSync, fsyncSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const MODULE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const ROOT = resolve(process.env.DOUYIN_ANALYTICS_HOME || MODULE_DIR);
export const DB = join(ROOT, 'data/douyin.sqlite');
export const LOGIN_COMMAND = `node ${join(MODULE_DIR, 'src/cli.mjs')} login`;
export class AppError extends Error {
  constructor(code, exitCode = 1) { super(code); this.code = code; this.exitCode = exitCode; }
}
export function expectedNickname(env = process.env) {
  const nickname = env.DOUYIN_EXPECTED_NICKNAME?.trim();
  if (!nickname) throw new AppError('EXPECTED_NICKNAME_REQUIRED');
  return nickname;
}
export function prepare() {
  for (const dir of ['data', 'logs', 'reports']) {
    const path = join(ROOT, dir);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    // 只管理本模块运行目录；不修改 Ego 用户数据目录的权限或内容。
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new AppError('UNSAFE_RUNTIME_PATH');
    chmodSync(path, 0o700);
  }
}
export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new AppError('LOCAL_JSON_INVALID'); }
}
export function atomicJson(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
export function pidStatus(pid) {
  try { process.kill(pid, 0); return 'alive'; }
  catch (e) { return e.code === 'ESRCH' ? 'dead' : 'unknown'; }
}
export function emptyLockSafe(path) {
  // lsof的退出1且无输出表示无人持有；权限告警或执行失败均不放行。
  const holders = spawnSync('/usr/sbin/lsof', ['-t', path], { encoding: 'utf8' });
  if (holders.error || holders.status !== 1 || holders.stdout.trim() || holders.stderr.trim()) return false;
  const listing = spawnSync('/bin/ps', ['-axo', 'pid=,comm=,args='], { encoding: 'utf8' });
  if (listing.error || listing.status !== 0 || listing.stderr.trim()) return false;
  return !listing.stdout.split('\n').some(row => {
    const match = row.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || Number(match[1]) === process.pid || !/(?:^|\/)node(?:\s|$)/.test(match[2])) return false;
    return /(?:src\/cli\.mjs|src\/discovery-shell\.mjs)/.test(match[3]);
  });
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
export function commandLock({ path = join(ROOT, 'logs/command.lock'), alive = pidStatus, emptySafe = emptyLockSafe, write = writeFileSync } = {}) {
  if (!path.startsWith(join(ROOT, 'logs') + '/')) throw new AppError('UNSAFE_COMMAND_LOCK_PATH');
  let fd, inode;
  const owner = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fd = openSync(path, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw new AppError('COMMAND_LOCKED');
      try {
        const before = lstatSync(path);
        if (!before.isFile() || before.isSymbolicLink()) throw new Error();
        const text = readFileSync(path, 'utf8');
        if (!sameFile(before, lstatSync(path))) throw new Error();
        if (!text.trim()) {
          if (!emptySafe(path)) throw new Error();
        } else {
          const saved = JSON.parse(text);
          if (!Number.isSafeInteger(saved.pid) || saved.pid <= 0 || alive(saved.pid) !== 'dead') throw new Error();
        }
        // 只恢复仍是已核查inode的本模块锁，不触及Ego锁。
        if (!sameFile(before, lstatSync(path)) || readFileSync(path, 'utf8') !== text) throw new Error();
        unlinkSync(path);
      } catch { throw new AppError('COMMAND_LOCKED'); }
    }
  }
  try {
    inode = fstatSync(fd);
    write(fd, JSON.stringify({ pid: process.pid, owner, started_at: new Date().toISOString() }));
    fsyncSync(fd);
  } catch {
    try { if (inode && sameFile(inode, lstatSync(path))) unlinkSync(path); } catch {}
    try { closeSync(fd); } catch {}
    throw new AppError('COMMAND_LOCK_WRITE_FAILED');
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    try {
      if (sameFile(inode, lstatSync(path)) && JSON.parse(readFileSync(path, 'utf8')).owner === owner) unlinkSync(path);
    } catch { /* 路径已消失、inode或所有权变化时保留对方文件。 */ }
    finally { try { closeSync(fd); } catch {} }
  };
  process.once('exit', release);
  return release;
}
const shutdownTasks = new Set();
export function registerCleanup(fn) { shutdownTasks.add(fn); return () => shutdownTasks.delete(fn); }
export function installSignalCleanup() {
  let stopping = false;
  const handler = async signal => {
    if (stopping) return;
    stopping = true;
    console.log('收到终止信号，关闭本次context并释放模块锁。');
    for (const fn of [...shutdownTasks].reverse()) { try { await fn(); } catch {} }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onInt = () => { void handler('SIGINT'); }, onTerm = () => { void handler('SIGTERM'); };
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  return () => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); };
}
export async function sleep(ms) {
  // 长冷却分成最多30秒片段，允许终止，也避免单次阻塞式长等待。
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(remaining, 30000);
    await new Promise(resolve => setTimeout(resolve, step)); remaining -= step;
  }
}
export class RequestGate {
  constructor({ path = null, now = Date.now, wait = sleep, random = Math.random } = {}) {
    this.path = path; this.now = now; this.wait = wait; this.random = random;
    this.state = path ? readJson(path, {}) : {};
    this.tail = Promise.resolve();
  }
  persist() { if (this.path) atomicJson(this.path, this.state); }
  async run(fn) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const now = this.now();
      const delay = Math.max(0, (this.state.cooldownUntil ?? 0) - now, (this.state.lastCompletedAt ?? 0) + 4000 - now) + Math.floor(this.random() * 1201);
      if (delay > 60000) console.log(`请求冷却：约 ${Math.ceil(delay / 1000)} 秒。`);
      if (delay > 0) await this.wait(delay);
      return await fn();
    } finally {
      try { this.state.lastCompletedAt = this.now(); this.persist(); }
      finally { release(); }
    }
  }
  cooldown(ms) { this.state.cooldownUntil = Math.max(this.state.cooldownUntil ?? 0, this.now() + ms); this.persist(); }
}
export async function retry(fn, { gate, wait = sleep, random = Math.random, onRetry = () => {}, maxRetries = 3, exponentOffset = 0 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (error.exitCode === 3 || ['CAPTCHA', 'ACCOUNT_MISMATCH', 'IDENTITY_UNKNOWN', 'READ_ONLY_BLOCKED', 'HTTP_403', 'REQUEST_RETRIES_EXHAUSTED'].includes(error.code)) throw error;
      if (attempt === maxRetries) throw error;
      const delay = (error.code === 'HTTP_429' ? 120000 : 4000) * 2 ** (attempt + exponentOffset) + Math.floor(random() * 1201);
      onRetry(attempt + 1, error.code ?? 'NETWORK_ERROR');
      if (error.code === 'HTTP_429' && gate) gate.cooldown(Math.min(delay, 3600000));
      // Gate 在下次请求时兑现冷却；普通错误在这里等。
      else await wait(delay);
    }
  }
}
