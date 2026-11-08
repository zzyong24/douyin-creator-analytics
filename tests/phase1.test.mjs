import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,AppError} from '../src/runtime.mjs';
import {CATALOG_PATH,OVERVIEW_PATH,BASIC,parseSource,selectInitial,ListPager,mergeSourceWork} from '../src/list-source.mjs';
import {collect} from '../src/collect.mjs';
import {openDb,latestRows} from '../src/store.mjs';
import {buildReport} from '../src/report.mjs';
const ids=['1000000000000000001','1000000000000000002','1000000000000000003'];
const at='2026-11-07T00:00:00.000Z';
const row=(id,n=10)=>({aweme_id:id,item_title:'合成标题',create_time:1700000000,statistics:{play_count:n,digg_count:2,comment_count:0,share_count:1,collect_count:0}});
const json=(rows,total=3,has_more=false,max_cursor='0')=>({status_code:0,aweme_list:rows,total,has_more,max_cursor});
const overview=(items,total=3,has_more=false,max_cursor='0')=>({status_code:0,items,total,has_more,max_cursor});
function record(path,data,cursor='0'){return {path,url:new URL('https://creator.douyin.com'+path+'?count=2&max_cursor='+cursor),json:data,parsed:parseSource(data,path,at),at,pageCount:3};}
test('两接口按明确ID解析，0与NULL分开，详情NULL不影响基础指标',()=>{
 const a=parseSource(json([row(ids[0],0)],1),CATALOG_PATH,at).works[0];
 assert.equal(a.metrics.plays,0);assert.equal(a.metrics.comments,0);assert.equal(a.metrics.finish_rate,null);assert.equal(a.metrics.avg_play_duration_sec,null);
 assert.ok(BASIC.every(k=>a.metrics[k]!==null));
 const b=parseSource(overview([{id:ids[0],description:'合成同名标题',metrics:{play_count:20,like_count:0}}],1),OVERVIEW_PATH,at).works[0];
 const merged=mergeSourceWork(a,b);assert.equal(merged.metrics.plays,20);assert.equal(merged.metrics.likes,0);assert.equal(merged.metrics.comments,0);
 assert.equal(merged.metric_sources.plays.source_path,OVERVIEW_PATH);assert.equal(merged.metric_sources.plays.observed_at,at);
 assert.equal(merged.metric_sources.comments.field,'statistics.comment_count');
 assert.throws(()=>mergeSourceWork(a,{...b,aweme_id:ids[1]}),{code:'WORK_ID_MISMATCH'});
});
test('未知单位时长不猜秒；显式单位保留，非数值短横不当0',()=>{
 const a=parseSource(json([{...row(ids[0]),statistics:{avg_play_duration:2000,play_count:'-',digg_count:0}}],1),CATALOG_PATH,at).works[0];
 assert.equal(a.metrics.avg_play_duration_sec,null);assert.equal(a.metrics.plays,null);assert.equal(a.metrics.likes,0);
 const b=parseSource(json([{...row(ids[0]),metrics:{avg_play_duration:{value:2.5,unit:'秒'}}}],1),CATALOG_PATH,at).works[0];
 assert.equal(b.metrics.avg_play_duration_sec,2.5);assert.equal(b.metric_sources.avg_play_duration_sec.unit,'秒');
});
test('主目录筛选排除置顶子集total和一件终止片段，不能按最后响应结束',()=>{
 const main=record(CATALOG_PATH,json([row(ids[0]),row(ids[1])],3,true,'10'));
 const pin=record(CATALOG_PATH,json([row(ids[0])],1,false));
 const fragment=record(CATALOG_PATH,json([row(ids[0])],3,false));
 assert.equal(selectInitial([main,pin,fragment],CATALOG_PATH,3),main);
 assert.equal(selectInitial([pin],CATALOG_PATH,3),null);
});
test('真实max_cursor接续、重复置顶精确去重，必须到has_more=false',()=>{
 const p=new ListPager(3);
 assert.equal(p.accept(parseSource(json([row(ids[0]),row(ids[2])],3,true,'100'),CATALOG_PATH,at),'0'),'100');
 assert.equal(p.accept(parseSource(json([row(ids[1]),row(ids[2])],3,false,'50'),CATALOG_PATH,at),'100'),null);
 assert.equal(p.works.size,3);assert.equal(p.finished,true);assert.equal(p.pages,2);
});
for(const [name,data,code]of[
 ['total缺失',{...json([row(ids[0])]),total:null},'LIST_TOTAL_MISSING'],
 ['total冲突',json([row(ids[0])],2,false),'LIST_TOTAL_CONFLICT'],
 ['游标不前进',json([row(ids[0])],3,true,'0'),'CURSOR_NOT_ADVANCING'],
 ['has_more未知',{...json([row(ids[0])]),has_more:null},'HAS_MORE_UNKNOWN'],
 ['终止但数量不足',json([row(ids[0])],3,false),'LIST_COUNT_MISMATCH'],
])test(name+'明确失败',()=>assert.throws(()=>new ListPager(3).accept(parseSource(data,CATALOG_PATH,at),'0'),{code}));
test('游标回环明确失败',()=>{
 const p=new ListPager(3);p.accept(parseSource(json([row(ids[0])],3,true,'100'),CATALOG_PATH,at),'0');
 assert.throws(()=>p.accept(parseSource(json([row(ids[1])],3,true,'0'),CATALOG_PATH,at),'100'),{code:'CURSOR_LOOP'});
});
async function fixtureCollect({badTotal=false,missing=false,network=false}={}){
 const db=openDb(':memory:');let closed=0;const requests=[];
 const initialSource=async path=>path===CATALOG_PATH?record(path,json([row(ids[0]),row(ids[2])],3,true,'100')):record(path,overview([{id:ids[2]},{id:ids[1]},{id:ids[0]}],badTotal?4:3));
 const result=await collect(db,{openBrowser:async()=>({page:{},gate:null,state:{},close:async()=>{closed++;}}),go:async()=>{},identify:async()=>{},wait:async()=>{},initialSource,exportData:async()=>({metadata:{period:'合成全时间',work_scope:'全部合成作品',path:'合成文件'},parsed:{sha256:'合成hash',format:'CSV',sheets:[{name:'合成',rows:[['作品ID','吸粉量'],...ids.map(id=>[id,''])]}]}}),readPage:async(_p,url)=>{
  requests.push(new URL(url).searchParams.get('max_cursor'));if(network)throw new AppError('HTTP_403');
  return json([{...row(ids[1]),...(missing?{statistics:{play_count:10}}:{})},row(ids[2])],3,false,'50');
 }});
 return {db,result,closed,requests};
}
test('一期集成：完整两页、重复置顶、两接口ID集合对账、详情可空且成功',async()=>{
 const {db,result,closed,requests}=await fixtureCollect();try{
  assert.equal(result.status,'success');assert.equal(result.collected,3);assert.equal(result.basicCount,3);assert.equal(result.detailCount,0);assert.equal(closed,1);assert.deepEqual(requests,['100']);
  const rows=latestRows(db);assert.equal(rows.length,3);assert.ok(rows.every(r=>r.finish_rate===null&&r.avg_play_duration_sec===null));
  const raw=JSON.parse(rows[0].raw_json);assert.equal(raw.sources.length,2);assert.ok(raw.metric_sources.plays.observed_at);assert.equal(db.prepare('SELECT detail_count,list_metric_count FROM collect_runs').get().list_metric_count,3);
  assert.match(buildReport(db),/一期以列表/);assert.match(buildReport(db),/实际观察/);assert.match(buildReport(db),/首次|首轮/);
 }finally{db.close();}
});
for(const [name,options,error]of[['基础指标缺失',{missing:true},'BASE_METRICS_MISSING'],['后页403',{network:true},'HTTP_403']])test(name+'不冒充成功并保留已有数据',async()=>{
 const {db,result,closed}=await fixtureCollect(options);try{assert.equal(result.status,'partial');assert.equal(result.error,error);assert.ok(result.collected>=2);assert.equal(closed,1);}finally{db.close();}
});
test('调度仅忙锁成功跳过，其他错误保留失败；忙锁不report或重启Ego',()=>{
 const dir=mkdtempSync(join(ROOT,'logs/schedule-test-')),mock=join(dir,'node-mock.sh'),log=join(dir,'calls');
 try{
  writeFileSync(mock,'#!/bin/bash\nset -euo pipefail\necho "$2" >> "$MOCK_CALLS"\nif [[ "$2" == collect ]]; then exit "$MOCK_EXIT"; fi\n');chmodSync(mock,0o700);
  for(const code of [4,1,2,3,0]){
   writeFileSync(log,'');const result=spawnSync('/bin/bash',['launchd/run-scheduled.sh'],{cwd:ROOT,env:{...process.env,ANALYTICS_NODE_BIN:mock,MOCK_CALLS:log,MOCK_EXIT:String(code)},encoding:'utf8'});
   assert.equal(result.status,code===4?0:code);assert.deepEqual(readFileSync(log,'utf8').trim().split('\n'),code===0?['collect','report']:['collect']);
   if(code===4)assert.match(result.stdout,/EGO_PROFILE_LOCKED/);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('抽检万/亿按显示精度范围比较，短横与NULL不可验收',async()=>{
 const {displayRange,compareDisplay,sampleSelection}=await import('../src/sample.mjs');
 assert.equal(compareDisplay('0',0).pass,true);assert.equal(compareDisplay('-',0).pass,false);assert.equal(compareDisplay('0',null).pass,false);
 assert.equal(compareDisplay('1.2万',12234).pass,true);assert.equal(compareDisplay('1.2万',15000).pass,false);assert.equal(compareDisplay('1,234',1234).pass,true);assert.equal(compareDisplay('1,234',1235).pass,false);
 assert.equal(displayRange('1.23万').exact,false);
 const rows=ids.map((aweme_id,i)=>({aweme_id,published_at:new Date(1700000000000+i*100000).toISOString()}));
 assert.deepEqual(sampleSelection(rows).map(x=>x.row.aweme_id),[ids[2],ids[1],ids[0]]);
});

test('副源total冲突仅warning，不写错误范围或使主目录partial',async()=>{const {db,result}=await fixtureCollect({badTotal:true});try{assert.equal(result.status,'success');assert.equal(result.overviewCount,null);assert.equal(result.warnings[0].code,'LIST_TOTAL_CONFLICT');assert.equal(JSON.parse(latestRows(db)[0].raw_json).sources.length,1);}finally{db.close();}});
