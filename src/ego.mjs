import process from 'node:process';
import { accessSync, constants, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppError } from './runtime.mjs';

export const EGO_USER_DATA_DIR = resolve(process.env.EGO_USER_DATA_DIR || join(homedir(), 'Library/Application Support/Citro Labs/ego lite'));
// 已静态核验：此 Mach-O 入口 dlopen ego Framework 并调用 ChromeMain，非 Electron 壳。
// Helpers 下的 Renderer/Node/ego-browser 均不是应当独占此 profile 的浏览器入口。
export const EGO_EXECUTABLE = resolve(process.env.EGO_EXECUTABLE || '/Applications/ego lite.app/Contents/MacOS/ego lite');
export const EGO_LOCK_MESSAGE = 'Ego 主进程或 SingletonLock 存在，默认独占模式停止并退出4；本模块不强杀、不删锁、不自动重启 Ego。';

export function assertEgoUnlocked({ stat = lstatSync, processes = () => execFileSync('/bin/ps', ['-axo', 'comm=,args='], { encoding: 'utf8' }) } = {}) {
  // lstat 能识别悬空 SingletonLock；即使疑似旧锁也不自行删除或接管。
  try {
    stat(join(EGO_USER_DATA_DIR, 'SingletonLock'));
    throw new AppError('EGO_PROFILE_LOCKED', 4);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error.code !== 'ENOENT') throw new AppError('EGO_PROFILE_CHECK_FAILED');
  }
  let rows;
  try { rows = processes(); } catch { throw new AppError('EGO_PROFILE_CHECK_FAILED'); }
  if (rows.split('\n').some(row => row.includes(EGO_EXECUTABLE) || row.includes(`--user-data-dir=${EGO_USER_DATA_DIR}`) || row.includes(`--user-data-dir="${EGO_USER_DATA_DIR}"`))) {
    throw new AppError('EGO_PROFILE_LOCKED', 4);
  }
}

export async function openEgo({ chromium, headed, env = process.env, unlocked = assertEgoUnlocked, executable = () => accessSync(EGO_EXECUTABLE, constants.X_OK) }) {
  if (env.EGO_CDP_URL) {
    // CDP 只连接本机端口；不输出地址或底层异常（可能带授权信息）。
    try {
      const url = new URL(env.EGO_CDP_URL);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { throw new AppError('EGO_CDP_URL_INVALID'); }
    let connection;
    try {
      connection = await chromium.connectOverCDP(env.EGO_CDP_URL, { timeout: 30000, noDefaults: true });
      const context = connection.contexts()[0];
      if (!context) throw new AppError('EGO_CDP_CONTEXT_MISSING');
      return { context, connection };
    } catch (error) {
      await connection?.close().catch(() => {});
      throw new AppError(error instanceof AppError ? error.code : 'EGO_CDP_CONNECT_FAILED');
    }
  }
  unlocked();
  try { executable(); } catch { throw new AppError('EGO_EXECUTABLE_NOT_FOUND'); }
  try {
    const context = await chromium.launchPersistentContext(EGO_USER_DATA_DIR, {
      executablePath: EGO_EXECUTABLE, args: ['--profile-directory=Default'],
      // 使用 Ego 自身的 macOS Safe Storage，不切换到 Playwright 模拟钥匙串。
      ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
      headless: !headed, acceptDownloads: true,
      viewport: { width: 1440, height: 1000 }, timeout: 30000, serviceWorkers: 'block',
    });
    return { context, connection: null };
  } catch (error) {
    // 缩小预检与 Chromium 抢锁之间的竞态；不打印 Playwright 的原始启动日志。
    if (/SingletonLock|ProcessSingleton|profile.*(?:in use|locked)/i.test(error.message ?? '')) throw new AppError('EGO_PROFILE_LOCKED', 4);
    unlocked();
    throw new AppError('BROWSER_LAUNCH_FAILED');
  }
}
