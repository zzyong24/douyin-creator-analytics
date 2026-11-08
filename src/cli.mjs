#!/usr/bin/env node
import process from 'node:process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ROOT, expectedNickname, DB, LOGIN_COMMAND, prepare, commandLock, AppError, installSignalCleanup, registerCleanup } from './runtime.mjs';
import { openDb } from './store.mjs';
import { collect } from './collect.mjs';
import { sampleList } from './sample.mjs';
import { login, probeIdentity, probeShape } from './browser.mjs';
import { EGO_LOCK_MESSAGE } from './ego.mjs';
import {reuseExport,importIntoRun} from './import-export.mjs';
import {requireReportReady} from './acceptance.mjs';
import { buildReport, shanghaiDate } from './report.mjs';

process.umask(0o077);
const removeSignalHandlers = installSignalCleanup();
const command = process.argv[2],args=process.argv.slice(3);
const validArgs=command==='collect'?args.length===0||(args.length===2&&args[0]==='--reuse-export'):command==='import-export'?args.length===2:command==='report'?args.length===0||(args.length===2&&args[0]==='--output'):args.length===0;
if (!['login', 'shape', 'probe', 'collect', 'sample', 'report','import-export','verify-install'].includes(command) || !validArgs) {
  console.log('用法：node src/cli.mjs <login|shape|probe|collect|sample|report|import-export|verify-install>');
  process.exitCode = 1;
} else {
  let unlock, db;
  try {
    if (['login','shape','probe','collect','sample','verify-install'].includes(command)) expectedNickname();
    prepare(); unlock = commandLock(); registerCleanup(unlock);
    if (command === 'login') await login();
    else if (command === 'probe') await probeIdentity();
    else if (command === 'shape') await probeShape();
    else {
      db = openDb(DB);
      if(command==='import-export'){
        const runId=Number(args[0]);if(!Number.isSafeInteger(runId)||runId<1)throw new AppError('RUN_ID_INVALID');
        console.log('离线导入：'+JSON.stringify(importIntoRun(db,runId,reuseExport(args[1]))));
      }else if(command==='verify-install'){
        const ready=requireReportReady(db);
        const approval=JSON.parse((await import('node:fs')).readFileSync(join(ROOT,'data/acceptance.json'),'utf8'));
        if(approval.runId!==ready.run.id||!approval.reportPath)throw new AppError('INSTALL_REQUIRES_CURRENT_APPROVAL',2);
        (await import('node:fs')).accessSync(approval.reportPath);console.log('安装前数据/抽检/报告门禁通过。');
      }else if (command === 'sample') {
        console.log('抽检结果：'+JSON.stringify(await sampleList(db)));
      } else if (command === 'collect') {
        const result = await collect(db,{reusePath:args[0]==='--reuse-export'?args[1]:null});
        console.log(`采集结果：${JSON.stringify(result)}`);
        if (result.error === 'EGO_PROFILE_LOCKED') console.error(`执行停止：EGO_PROFILE_LOCKED\n${EGO_LOCK_MESSAGE}`);
        if (result.exitCode === 3) console.log(`需要扫码：运行 ${LOGIN_COMMAND}`);
        process.exitCode = result.exitCode;
      } else {
        const ready=requireReportReady(db);
        const {resolve,sep}=await import('node:path');
        const path=args[0]==='--output'?resolve(ROOT,args[1]):join(ROOT,'reports',`复盘-${shanghaiDate()}.md`);
        if(!path.startsWith(join(ROOT,'reports')+sep)||!path.endsWith('.md'))throw new AppError('REPORT_PATH_INVALID');
        writeFileSync(path, buildReport(db), { mode: 0o600 });
        const fs=await import('node:fs');const ap=join(ROOT,'data/acceptance.json'),approval=JSON.parse(fs.readFileSync(ap,'utf8'));if(approval.runId===ready.run.id){approval.reportPath=path;approval.reportGeneratedAt=new Date().toISOString();fs.writeFileSync(ap,JSON.stringify(approval,null,2)+'\n',{mode:0o600});}
        console.log(`报告已生成：${path}`);
      }
    }
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'LOCAL_OPERATION_FAILED';
    console.error(`执行停止：${code}`);
    process.exitCode = error.exitCode ?? 1;
    if (process.exitCode === 3) console.log(`需要扫码：运行 ${LOGIN_COMMAND}`);
    if (code === 'EXPECTED_NICKNAME_REQUIRED') console.error('请先设置环境变量 DOUYIN_EXPECTED_NICKNAME 为待采集账号昵称。');
    if (code === 'SAMPLE_EVIDENCE_REQUIRED') console.error('请设置 DOUYIN_SAMPLE_EVIDENCE_FILE，指向本机验收证据 JSON。');
    if (code === 'COMMAND_LOCKED') console.error('已有命令占用模块锁；请先核对 analytics/logs/command.lock 对应进程，本程序不杀进程或清锁。');
    if (code === 'EGO_PROFILE_LOCKED') console.error(EGO_LOCK_MESSAGE);
    if (code === 'BROWSER_LAUNCH_FAILED') console.error('请检查 Ego Lite Chromium 入口是否可用；本程序不会清浏览器锁。');
  } finally {
    db?.close(); unlock?.(); removeSignalHandlers();
  }
}
