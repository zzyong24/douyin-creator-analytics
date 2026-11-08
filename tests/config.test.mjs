import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {MODULE_DIR,ROOT,expectedNickname} from '../src/runtime.mjs';
import {renderPlist} from '../launchd/render-plist.mjs';
import {requireIdentity} from '../src/browser.mjs';
import {loadSampleEvidence,checkUserEvidence} from '../src/sample.mjs';

test('昵称缺失或空白拒绝；空配置不调用身份探针',async()=>{
 for(const env of [{},{DOUYIN_EXPECTED_NICKNAME:'  '}])assert.throws(()=>expectedNickname(env),{code:'EXPECTED_NICKNAME_REQUIRED'});
 assert.equal(expectedNickname({DOUYIN_EXPECTED_NICKNAME:' 测试账号 '}),'测试账号');
 let probes=0;
 await assert.rejects(requireIdentity({},null,false,{nickname:'',probe:async()=>{probes++;}}),{code:'EXPECTED_NICKNAME_REQUIRED'});
 assert.equal(probes,0);
 const result=spawnSync(process.execPath,['src/cli.mjs','collect'],{cwd:MODULE_DIR,encoding:'utf8',env:{...process.env,DOUYIN_EXPECTED_NICKNAME:''}});
 assert.equal(result.status,1);assert.match(result.stderr,/EXPECTED_NICKNAME_REQUIRED/);assert.match(result.stderr,/DOUYIN_EXPECTED_NICKNAME/);
});
test('模块目录、外部数据根和Ego路径配置互不混用，无需访问登录档',()=>{
 const home=join(ROOT,'logs/config-runtime'),ego=join(ROOT,'logs/config-ego');
 const code="const r=await import('./src/runtime.mjs');const e=await import('./src/ego.mjs');r.prepare();const unlock=r.commandLock();unlock();console.log(JSON.stringify({module:r.MODULE_DIR,root:r.ROOT,db:r.DB,login:r.LOGIN_COMMAND,ego:e.EGO_USER_DATA_DIR,executable:e.EGO_EXECUTABLE}));";
 try{
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:MODULE_DIR,encoding:'utf8',env:{...process.env,DOUYIN_ANALYTICS_HOME:home,EGO_USER_DATA_DIR:ego,EGO_EXECUTABLE:'/synthetic/ego'}});
 assert.equal(result.status,0);const value=JSON.parse(result.stdout);
 assert.equal(value.module,MODULE_DIR);assert.equal(value.root,home);assert.equal(value.db,join(home,'data/douyin.sqlite'));assert.ok(value.login.includes(join(MODULE_DIR,'src/cli.mjs')));assert.equal(value.ego,ego);assert.equal(value.executable,'/synthetic/ego');assert.equal(existsSync(join(home,'logs')),true);assert.equal(existsSync(join(home,'logs/command.lock')),false);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('launchd模板固定六小时间隔，不立即启动；路径及昵称按XML转义',()=>{
 const xml=renderPlist({label:'com.example.synthetic',moduleDir:'/synthetic/module & files',home:'/synthetic/data',nickname:'测试<&账号',nodeBin:'/synthetic/node',egoDir:'/synthetic/profile',egoExecutable:'/synthetic/ego'});
 assert.match(xml,/com.example.synthetic/);assert.match(xml,/module &amp; files/);assert.match(xml,/测试&lt;&amp;账号/);assert.match(xml,/<integer>21600<\/integer>/);assert.match(xml,/<key>RunAtLoad<\/key><false\/>/);assert.doesNotMatch(xml,/__[A-Z_]+__/);
 const parsed=spawnSync('/usr/bin/plutil',['-lint','-'],{input:xml,encoding:'utf8'});assert.equal(parsed.status,0,parsed.stdout+parsed.stderr);
 assert.throws(()=>renderPlist({label:'../other',nickname:'测试账号'}),{code:'LAUNCHD_LABEL_INVALID'});
 assert.throws(()=>renderPlist({nickname:'测试账号',nodeBin:'node'}),{code:'LAUNCHD_PATH_MUST_BE_ABSOLUTE'});
});
test('外部证据缺失、损坏、身份错配拒绝；数据可从任意本机文件加载',()=>{
 const dir=mkdtempSync(join(ROOT,'logs/evidence-config-'));try{
  assert.throws(()=>loadSampleEvidence(''),{code:'SAMPLE_EVIDENCE_REQUIRED'});
  const file=join(dir,'input.json');writeFileSync(file,'{broken');assert.throws(()=>loadSampleEvidence(file),{code:'SAMPLE_EVIDENCE_INVALID'});
  writeFileSync(file,JSON.stringify({aweme_id:'1'}));assert.throws(()=>loadSampleEvidence(file),{code:'SAMPLE_EVIDENCE_INVALID'});
  const evidence={aweme_id:'9000000000000000099',title:'合成作品',published_minute:'2026-01-02 12:00',source_type:'用户提供截图转述',source:'合成来源',source_time:'2026-01-03T00:00:00+08:00',original_image_available:false,page:{plays:'100',likes:'1',comments:'0',shares:'0',favorites:'0',follower_gain:'0',cover_ctr:'10.00%'}};
  writeFileSync(file,JSON.stringify(evidence));assert.deepEqual(loadSampleEvidence(file),evidence);
  const row={aweme_id:evidence.aweme_id,title:evidence.title,published_at:'2026-01-02T04:00:00Z',plays:100,likes:1,comments:0,shares:0,favorites:0,follower_gain:0,cover_ctr:.1};
  assert.equal(checkUserEvidence(row,{evidence,referencePath:file}).pass,true);
  for(const bad of [{...row,aweme_id:'2'},{...row,title:'其他作品'},{...row,published_at:'2026-01-02T04:01:00Z'}])assert.throws(()=>checkUserEvidence(bad,{evidence}),{code:'USER_SAMPLE_IDENTITY_MISMATCH'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
