import process from 'node:process';
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {MODULE_DIR} from './runtime.mjs';
function run(cmd,args){const r=spawnSync(cmd,args,{cwd:MODULE_DIR,stdio:'inherit'});if(r.error||r.status!==0)process.exit(r.status??1);}
run(process.execPath,['--test',...readdirSync(MODULE_DIR+'/tests').filter(x=>x.endsWith('.test.mjs')).map(x=>'tests/'+x)]);
for(const f of readdirSync(MODULE_DIR+'/src').filter(x=>x.endsWith('.mjs')))run(process.execPath,['--check','src/'+f]);
for(const f of readdirSync(MODULE_DIR+'/launchd').filter(x=>x.endsWith('.sh')))run('/bin/bash',['-n','launchd/'+f]);
run('/usr/bin/plutil',['-lint','launchd/com.example.douyin-analytics.plist.template']);
console.log('全部测试、源码语法、Shell语法和plist验证通过。');
