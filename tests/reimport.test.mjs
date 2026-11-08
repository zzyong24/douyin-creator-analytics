import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {matchExport,exportNumber,exportTime,normalizeCaption,requireFullExport} from '../src/export.mjs';
import {openDb,startRun,saveWork,finishRun} from '../src/store.mjs';
import {importIntoRun} from '../src/import-export.mjs';
import {requireDataReady,requireReportReady,CONTRACT_VERSION} from '../src/acceptance.mjs';
import {collect} from '../src/collect.mjs';
import {CATALOG_PATH,OVERVIEW_PATH,parseSource} from '../src/list-source.mjs';
const at='2026-11-07T16:05:00Z',id='7654321098765432101',id2='7654321098765432102';
const work={aweme_id:id,title:'短标题',published_at:'2026-11-07T16:01:30Z'};
const parsed=rows=>({format:'XLSX',sha256:'合成hash',sheets:[{name:'合成',rows}]});
const meta={source_observed_at:'2026-11-07T15:45:14Z',imported_at:at,period:'未知统计周期',reused:true,path:'合成文件'};
test('分钟唯一优先，无需标题相等；Z到上海跨日，导出秒差不影响分钟',()=>{
 const r=matchExport(parsed([['作品名称','发布时间'],['完全不同的完整名称','2026-11-08 00:01:59']]),[work],meta);
 assert.equal(r.counts.matchedWorks,1);assert.equal(r.accepted[0].minute,'2026-11-08 00:01');assert.match(r.accepted[0].match_method,/分钟唯一/);
 assert.equal(exportTime('2026-11-07T16:01:30Z').minute,'2026-11-08 00:01');assert.equal(exportTime('2026-02-31 12:00'),null);
});
test('同分钟优先真实desc全文归一化，再用标题子串；不选第一个歧义候选',()=>{
 const a={...work,raw_json:JSON.stringify({sources:[{row:{desc:'ＡＩ，方法！ #工具'}}]})},b={...work,aweme_id:id2,title:'另一个标题',raw_json:JSON.stringify({sources:[{row:{desc:'另外的真实全文'}}]})};
 const r=matchExport(parsed([['作品名称','发布时间'],['AI 方法 #效率','2026-11-08 00:01:01'],['另外的真实全文','2026-11-08 00:01:59']]),[a,b],meta);
 assert.equal(r.counts.matchedWorks,2);assert.match(r.accepted[0].match_method,/desc.*全文/);assert.equal(normalizeCaption('ＡＩ， 方法 #工具'),'AI方法');
 const ambiguous=matchExport(parsed([['作品名称','发布时间'],['短标题的完整文案','2026-11-08 00:01']]),[work,{...work,aweme_id:id2}],meta);
 assert.equal(ambiguous.counts.ambiguous,1);assert.throws(()=>requireFullExport(ambiguous,2),{code:'EXPORT_INCOMPLETE_MATCH',exitCode:2});
});
test('同分钟导出重复行全部拒绝，不以分钟唯一硬配',()=>{
 const r=matchExport(parsed([['作品名称','发布时间'],['短标题','2026-11-08 00:01'],['短标题','2026-11-08 00:01']]),[work],meta);
 assert.equal(r.counts.duplicates,2);assert.equal(r.counts.acceptedRows,0);
});
test('实际16表头全保留，实际别名、0–1、秒/毫秒/无单位明确区分',()=>{
 const headers=['作品名称','发布时间','体裁','审核状态','播放量','完播率','5s完播率','封面点击率','2s跳出率','平均播放时长','点赞量','分享量','评论量','收藏量','主页访问量','粉丝增量'];
 const r=matchExport(parsed([headers,['长文案','2026-11-08 00:01','视频','通过','1280','0.12','25%','0.03','0.4','2500ms','12','3','2','1','9','0']]),[work],meta),row=r.accepted[0];
 assert.equal(row.cells.length,16);assert.equal(row.metrics.follower_gain.value,0);assert.equal(row.metrics.finish_5s_rate.value,0.25);assert.equal(row.metrics.bounce_2s_rate.value,0.4);assert.equal(row.metrics.profile_visits.value,9);assert.equal(row.metrics.avg_play_duration_sec.value,2.5);assert.equal(row.metrics.avg_play_ratio,undefined);
 assert.equal(exportNumber('00:01:02.5','平均播放时长').value,62.5);
 const unknown=matchExport(parsed([['作品名称','发布时间','平均播放时长','完播率'],['长文案','2026-11-08 00:01','17.722126','12']]),[work],meta).accepted[0];assert.equal(unknown.metrics.avg_play_duration_sec.value,null);assert.equal(unknown.metrics.avg_play_duration_sec.raw,'17.722126');assert.equal(unknown.metrics.finish_rate.value,null);
});
test('离线修同一run：导出非空优先覆盖列表0，原raw和导入历史保留，源时刻不变',()=>{
 const db=openDb(':memory:');try{
  const run=startRun(db),raw={sources:[{path:CATALOG_PATH,observed_at:at,row:{statistics:{play_count:0,digg_count:1,comment_count:0,share_count:0,collect_count:0}}}]};
  saveWork(db,run,work,{plays:0,likes:1,comments:0,shares:0,favorites:0},raw);finishRun(db,run,{status:'success',pageCount:1,apiCount:1});
  const exported={parsed:parsed([['作品名称','发布时间','播放量','点赞量','粉丝增量'],['长文案','2026-11-08 00:01','1280','12','2']]),metadata:meta};
  const summary=importIntoRun(db,run,exported,{writeReceipt:false});assert.equal(summary.listZeroExportPositive,1);assert.equal(summary.differentPlays,1);
  const first=db.prepare('SELECT * FROM metric_snapshots').get(),ext=JSON.parse(first.extensions_json);assert.equal(first.plays,1280);assert.equal(first.likes,12);assert.equal(first.follower_gain,2);assert.deepEqual(JSON.parse(first.raw_json),raw);assert.equal(ext.list_values.plays,0);assert.equal(ext.selected_sources.plays.observed_at,meta.source_observed_at);
  importIntoRun(db,run,exported,{writeReceipt:false});assert.equal(db.prepare('SELECT count(*) n FROM export_rows').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM export_import_history').get().n,1);assert.equal(JSON.parse(db.prepare('SELECT extensions_json FROM metric_snapshots').get().extensions_json).list_values.plays,0);
  assert.throws(()=>requireReportReady(db,{approval:null}),{code:'REPORT_REQUIRES_SAMPLES'});assert.throws(()=>requireReportReady(db,{approval:{approved:true,contractVersion:CONTRACT_VERSION,runId:run}}),{code:'REPORT_REQUIRES_SAMPLES'});
 }finally{db.close();}
});
test('匹配不足collect为partial退出2，保留导出原行且报告/安装门禁拒绝',async()=>{
 const db=openDb(':memory:');let closed=0;try{
  const data={aweme_list:[{aweme_id:id,item_title:'合成',create_time:1700000000,statistics:{play_count:0,digg_count:0,comment_count:0,share_count:0,collect_count:0}}],total:1,has_more:false,max_cursor:'0'};
  const result=await collect(db,{openBrowser:async()=>({page:{},state:{},gate:null,close:async()=>{closed++;}}),go:async()=>{},identify:async()=>{},initialSource:async path=>{if(path===OVERVIEW_PATH)throw Error('无可选源');return {pageCount:1,url:new URL('https://creator.douyin.com'+CATALOG_PATH+'?max_cursor=0'),parsed:parseSource(data,CATALOG_PATH)};},exportData:async()=>({parsed:parsed([['作品ID','吸粉量'],['999','0']]),metadata:meta})});
  assert.equal(result.status,'partial');assert.equal(result.exitCode,2);assert.equal(result.error,'EXPORT_INCOMPLETE_MATCH');assert.equal(closed,1);assert.equal(db.prepare('SELECT count(*) n FROM export_rows').get().n,1);assert.throws(()=>requireDataReady(db),{code:'REPORT_REQUIRES_COMPLETE_DATA',exitCode:2});
  assert.match(readFileSync(new URL('../launchd/install.sh',import.meta.url),'utf8'),/cli\.mjs" verify-install[\s\S]*cat/);assert.doesNotMatch(readFileSync(new URL('../launchd/run-scheduled.sh',import.meta.url),'utf8'),/reuse-export|run-9/);
 }finally{db.close();}
});
test('默认未来导出按已观察按钮下载一次，不使用本轮复用文件或交互命令',async()=>{
 const {EventEmitter}=await import('node:events'),{writeFileSync,unlinkSync,existsSync}=await import('node:fs'),{ROOT}=await import('../src/runtime.mjs'),{join}=await import('node:path'),{downloadExport}=await import('../src/export-browser.mjs');
 const key='合成-'+Date.now(),page=new EventEmitter(),responses=new EventEmitter();let clicks=0;const created=[];
 Object.assign(page,{locator:()=>({innerText:async()=>'作品(1) 审核状态 体裁 发布日期'}),screenshot:async()=>{},getByText:()=>({count:async()=>1,click:async()=>{
  clicks++;responses.emit('response',{url:()=> 'https://creator.douyin.com/web/api/creator/item/list/download?不打印=合成',request:()=>({method:()=>'GET'}),status:()=>200,headers:()=>({'content-type':'application/vnd.ms-excel'})});
  page.emit('download',{suggestedFilename:()=> '合成.csv',saveAs:async path=>{writeFileSync(path,'作品ID,吸粉量\n'+id+',0\n');created.push(path);},failure:async()=>null});
 }})});
 try{const result=await downloadExport({page,responses,state:{},gate:null},key);assert.equal(clicks,1);assert.equal(result.metadata.reused,false);assert.equal(result.metadata.source.path,'/web/api/creator/item/list/download');assert.equal(result.parsed.format,'CSV');}
 finally{for(const path of [...created,join(ROOT,`data/exports/run-${key}-manifest.json`),join(ROOT,`logs/export-metadata-run-${key}.jsonl`)])if(existsSync(path))unlinkSync(path);}
});
test('同一导出源时刻跨快照重复导入不作增长，即使导入时间不同',async()=>{
 const {buildReport}=await import('../src/report.mjs');const db=openDb(':memory:');try{
  for(let i=0;i<2;i++){
   const run=startRun(db);saveWork(db,run,work,{plays:0,likes:0,comments:0},{scope:{period_verified:true,period:'合成相同周期'}},`2026-11-07T16:0${i}:00Z`);finishRun(db,run,{status:'success',pageCount:1,apiCount:1});
   importIntoRun(db,run,{parsed:parsed([['作品ID','播放量'],[id,String(10+i)]]),metadata:{...meta,sha256:'同一hash',period_verified:true,imported_at:`2026-11-07T16:0${i}:00Z`}},{writeReceipt:false});
  }
  assert.match(buildReport(db),/同一导出取数时刻重复导入，未比较/);
 }finally{db.close();}
});
