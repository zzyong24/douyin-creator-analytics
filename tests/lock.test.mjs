import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync,unlinkSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {ROOT,commandLock,pidStatus} from '../src/runtime.mjs';
function fixture(fn){const dir=mkdtempSync(join(ROOT,'logs/lock-test-'));try{return fn(join(dir,'command.lock'));}finally{rmSync(dir,{recursive:true,force:true});}}
test('模块锁写PID和owner，活PID不能抢占，解锁幂等',()=>fixture(path=>{
 const release=commandLock({path});const saved=JSON.parse(readFileSync(path));
 assert.equal(saved.pid,process.pid);assert.match(saved.owner,/^[a-f0-9-]{36}$/);
 assert.throws(()=>commandLock({path}),{code:'COMMAND_LOCKED'});release();release();assert.equal(existsSync(path),false);
}));
test('过期PID恢复；活PID、权限未知、损坏记录和符号链接均不抢锁',()=>fixture(path=>{
 writeFileSync(path,JSON.stringify({pid:9999999}));
 const release=commandLock({path,alive:()=> 'dead'});release();
 for(const state of ['alive','unknown']){
  writeFileSync(path,JSON.stringify({pid:9999999}));
  assert.throws(()=>commandLock({path,alive:()=>state}),{code:'COMMAND_LOCKED'});unlinkSync(path);
 }
 writeFileSync(path,'损坏');assert.throws(()=>commandLock({path}),{code:'COMMAND_LOCKED'});
}));
test('空锁只在明确无人持有且无其他CLI时恢复',()=>fixture(path=>{
 writeFileSync(path,'');let calls=0;
 assert.throws(()=>commandLock({path,emptySafe:()=>{calls++;return false;}}),{code:'COMMAND_LOCKED'});
 assert.equal(calls,1);assert.equal(readFileSync(path,'utf8'),'');
 const release=commandLock({path,emptySafe:()=>true});release();
}));
test('写锁失败关闭FD并仅移除自己创建的同inode锁',()=>fixture(path=>{
 assert.throws(()=>commandLock({path,write:()=>{throw new Error('合成写入失败');}}),{code:'COMMAND_LOCK_WRITE_FAILED'});
 assert.equal(existsSync(path),false);
 assert.throws(()=>commandLock({path,write:()=>{renameSync(path,path+'.old');writeFileSync(path,'其他所有者');throw new Error();}}),{code:'COMMAND_LOCK_WRITE_FAILED'});
 assert.equal(readFileSync(path,'utf8'),'其他所有者');
}));
test('旧解锁器不得删除替换inode或owner不同的文件',()=>fixture(path=>{
 const release=commandLock({path});renameSync(path,path+'.old');writeFileSync(path,'替换文件');release();
 assert.equal(readFileSync(path,'utf8'),'替换文件');unlinkSync(path);
 const other=commandLock({path});writeFileSync(path,JSON.stringify({pid:process.pid,owner:'其他所有者'}));other();
 assert.equal(JSON.parse(readFileSync(path)).owner,'其他所有者');
}));
test('PID权限不明保守停止，当前PID为活进程',()=>assert.equal(pidStatus(process.pid),'alive'));
for(const signal of ['SIGINT','SIGTERM'])test(signal+'正常清理自己子进程的模块锁',async()=>{
 const dir=mkdtempSync(join(ROOT,'logs/lock-signal-test-')),path=join(dir,'command.lock');
 const code=`import process from 'node:process';import {commandLock,installSignalCleanup,registerCleanup} from ${JSON.stringify(new URL('../src/runtime.mjs',import.meta.url).href)};installSignalCleanup();registerCleanup(commandLock({path:${JSON.stringify(path)}}));console.log('就绪');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
 try{await once(child.stdout,'data');const exit=once(child,'exit');child.kill(signal);const [status]=await exit;assert.equal(status,signal==='SIGINT'?130:143);assert.equal(existsSync(path),false);}
 finally{rmSync(dir,{recursive:true,force:true});}
});
