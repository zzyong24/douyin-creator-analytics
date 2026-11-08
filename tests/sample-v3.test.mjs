import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT} from '../src/runtime.mjs';
import {checkUserEvidence,selectSamplesV3,compareDisplay,comparePercent} from '../src/sample.mjs';
import {openDb,startRun,saveWork,finishRun,saveExport} from '../src/store.mjs';
import {matchExport} from '../src/export.mjs';
import {approveSamples,requireReportReady,CONTRACT_VERSION} from '../src/acceptance.mjs';
import {quantile,rateDistribution,monthGroups,richReport} from '../src/report-analysis.mjs';
const newestEvidence={source_type:'用户提供截图转述',source:'合成截图说明',source_time:'2026-08-02T12:00:00+08:00',original_image_available:false,aweme_id:'9000000000000000001',title:'合成新作品',published_minute:'2026-08-01 18:00',page:{plays:'1.2万',likes:'10',comments:'2',shares:'3',favorites:'4',follower_gain:'5',cover_ctr:'17.49%',avg_play_ratio:'3.96%'}};
const newest={aweme_id:newestEvidence.aweme_id,title:newestEvidence.title,published_at:'2026-08-01T10:00:34Z',plays:12000,likes:10,comments:2,shares:3,favorites:4,follower_gain:5,cover_ctr:.174905};
const checkEvidence=(row,options={})=>checkUserEvidence(row,{evidence:newestEvidence,...options});
const ext=(status)=>JSON.stringify({cells:[{header:'审核状态',raw:status}]});
test('新证据来源为用户转述，无原图；7指标依规则比较，平均占比仅上下文',()=>{
 const c=checkEvidence(newest);assert.equal(c.pass,true);assert.equal(c.source,'合成截图说明');assert.equal(c.screenshot,null);assert.equal(c.original_image_available,false);assert.equal(Object.keys(c.metrics).length,7);assert.equal(c.context_only.avg_play_ratio.db,null);
 assert.equal(comparePercent('17.49%',.174905).pass,true);assert.equal(comparePercent('17.49%',.175).pass,false);assert.equal(compareDisplay('-',0).pass,false);
 assert.equal(checkEvidence({...newest,likes:11}).pass,false);
});
test('中旧以实际状态公开/已发布与播放正数选，不能由播放推状态，固定时间规则',()=>{
 const rows=[{...newest,extensions_json:ext('公开')},{aweme_id:'1',title:'旧',published_at:'2025-10-16T00:00:00Z',plays:10,extensions_json:ext('公开')},{aweme_id:'2',title:'中',published_at:'2026-04-25T00:00:00Z',plays:20,extensions_json:ext('公开')},{aweme_id:'3',title:'自见正播放排除',published_at:'2026-04-26T00:00:00Z',plays:200,extensions_json:ext('自见')},{aweme_id:'4',title:'零排除',published_at:'2025-01-01T00:00:00Z',plays:0,extensions_json:ext('公开')}];
 const selected=selectSamplesV3(rows,{evidence:newestEvidence});assert.equal(selected[1].row.aweme_id,'2');assert.equal(selected[2].row.aweme_id,'1');assert.equal(selected[2].position,3);assert.equal(selected[1].export_status,'公开');
});
test('v3门禁需要1用户引用+2真实网页来源元数据，不允许删门禁硬写true或缺来源',()=>{
 const dir=mkdtempSync(join(ROOT,'logs/v3-test-')),db=openDb(':memory:');try{
  const run=startRun(db),works=[newest,{aweme_id:'1',title:'中',published_at:'2026-04-01T00:00:00Z',plays:100,likes:2,comments:1,follower_gain:3},{aweme_id:'2',title:'旧',published_at:'2025-10-01T00:00:00Z',plays:50,likes:1,comments:0,follower_gain:0}];
  for(const w of works)saveWork(db,run,w,w,{scope:{}});finishRun(db,run,{status:'success',pageCount:3,apiCount:3});
  const data={sheets:[{name:'合成',rows:[['作品ID','播放量','粉丝增量'],...works.map(w=>[w.aweme_id,String(w.plays),String(w.follower_gain)])]}]};saveExport(db,run,matchExport(data,works,{}),{sha256:'合成'});
  // saveExport无源raw的合成会保留已有cover_ctr等值。
  const ref=join(dir,'用户引用.json');writeFileSync(ref,JSON.stringify(newestEvidence));
  const checks=[checkEvidence(newest,{referencePath:ref}),...works.slice(1).map((w,i)=>{const screenshot=join(dir,`合成网页-${i}.png`);writeFileSync(screenshot,'合成测试非真实截图');return {kind:i?'旧':'中',aweme_id:w.aweme_id,source_type:'本轮网页截图',source:'https://creator.douyin.com/creator-micro/content/manage',source_time:'2026-11-08T00:00:00Z',screenshot,id_proof:'合成标题+精确时间',location_method:'合成只读搜索',location_evidence:{effective:true},selection:{page_status:'已发布',export_status:'公开'},page_readings:Object.fromEntries(['plays','likes','comments','follower_gain'].map(k=>[k,String(w[k])])),metrics:Object.fromEntries(['plays','likes','comments','follower_gain'].map(k=>[k,compareDisplay(String(w[k]),w[k])])),pass:true};})];
  const ap=join(dir,'acceptance.json'),approval=approveSamples(db,checks,{path:ap});assert.equal(approval.contractVersion,CONTRACT_VERSION);assert.match(CONTRACT_VERSION,/v3/);assert.equal(requireReportReady(db,{approval}).run.id,run);
  assert.throws(()=>approveSamples(db,checks.map((c,i)=>i===0?{...c,source_type:'本轮网页截图',screenshot:checks[1].screenshot}:c),{path:ap}),{code:'SAMPLE_NOT_APPROVED'});
  assert.throws(()=>approveSamples(db,checks.map((c,i)=>i===1?{...c,location_evidence:{effective:false}}:c),{path:ap}),{code:'SAMPLE_NOT_APPROVED'});
  assert.throws(()=>requireReportReady(db,{approval:{approved:true,contractVersion:CONTRACT_VERSION,runId:run}}),{code:'REPORT_REQUIRES_SAMPLES'});
  for(const altered of [{...newestEvidence,title:'其他标题'},{...newestEvidence,aweme_id:'2'},{...newestEvidence,published_minute:'2026-08-01 18:01'},{...newestEvidence,source:'伪造来源'},{...newestEvidence,source_time:'2026-08-03T00:00:00Z'},{...newestEvidence,page:{...newestEvidence.page,likes:'999'}}]){
   writeFileSync(ref,JSON.stringify(altered));assert.throws(()=>approveSamples(db,checks,{path:ap}),{code:'SAMPLE_NOT_APPROVED'});
  }
  writeFileSync(ref,'{broken');assert.throws(()=>approveSamples(db,checks,{path:ap}),{code:'SAMPLE_NOT_APPROVED'});
  writeFileSync(ref,'null');assert.throws(()=>approveSamples(db,checks,{path:ap}),{code:'SAMPLE_NOT_APPROVED'});
  assert.throws(()=>approveSamples(db,[null,...checks.slice(1)],{path:ap}),{code:'SAMPLE_NOT_APPROVED'});
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('率分布R7分位数、频数边界、异常缺失；月份按上海跨日分组',()=>{
 assert.equal(quantile([0,1],.25),.25);assert.equal(quantile([],0.5),null);
 const rows=[{cover_ctr:0},{cover_ctr:.2},{cover_ctr:1},{cover_ctr:null},{cover_ctr:2}],d=rateDistribution(rows,'cover_ctr',[0,.2,1]);assert.equal(d.n,3);assert.equal(d.missing,1);assert.equal(d.invalid,1);assert.deepEqual(d.buckets.map(b=>b.n),[1,2]);assert.equal(d.q[2],.2);
 assert.equal(monthGroups([{published_at:'2026-10-31T16:30:00Z'}])[0][0],'2026-11');
});
test('丰富报告含三类Top、率分布、发布月份非增长、零播放实际状态与逐件附录',()=>{
 const rows=[{aweme_id:'1',title:'合成甲',published_at:'2026-11-01T00:00:00Z',plays:0,follower_gain:0,finish_rate:0,cover_ctr:null,bounce_2s_rate:.5,duration_sec:10,extensions_json:JSON.stringify({cells:[{header:'审核状态',raw:'自见'},{header:'体裁',raw:'视频'}],list_values:{plays:0},metrics:{plays:{value:0}}})},{aweme_id:'2',title:'合成乙',published_at:'2026-10-01T00:00:00Z',plays:10,follower_gain:1,finish_rate:.5,cover_ctr:.2,bounce_2s_rate:null,duration_sec:null,extensions_json:JSON.stringify({cells:[{header:'审核状态',raw:'公开'}]})}];
 const report=richReport(rows).join('\n');for(const phrase of ['按播放排序','按吸粉排序','按完播率排序','封面点击率分布','2秒跳出率分布','按发布月份分组的当前快照','不是逐月历史增长','播放0共1/2','自见 1件','附录：播放0逐件','不编造选题'])assert.ok(report.includes(phrase),phrase);
});
