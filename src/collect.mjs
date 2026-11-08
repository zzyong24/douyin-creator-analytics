import {join} from 'node:path';
import {ROOT,expectedNickname,AppError,sleep,atomicJson} from './runtime.mjs';
import {ORIGIN,HOME,MANAGE,ANALYSIS,launch,navigate,requireIdentity,checkPage,readJsonInPage,logProbe} from './browser.mjs';
import {assertEgoUnlocked} from './ego.mjs';
import {pageCount} from './parse.mjs';
import {CATALOG_PATH,OVERVIEW_PATH,BASIC,parseSource,selectInitial,ListPager,mergeSourceWork} from './list-source.mjs';
import {downloadExport} from './export-browser.mjs';
import {assertExportRuntime} from './export.mjs';
import {importIntoRun,reuseExport} from './import-export.mjs';
import {startRun,finishRun,saveWork} from './store.mjs';
export function scopeOf(url){const scope={path:url.pathname};for(const [k,v]of url.searchParams)if(/^(?:date_type|time_type|data_type|start_time|end_time|start_date|end_date|date|period|type)$/.test(k))scope[k]=v;return scope;}
function observe(browser){
 const records=[],pending=new Set();
 const handler=response=>{
  const url=new URL(response.url()),path=url.pathname.replace(/\/$/,'');
  if(url.origin!==ORIGIN||![CATALOG_PATH,OVERVIEW_PATH].includes(path)||response.request().method()!=='GET')return;
  const task=(async()=>{
   const at=new Date().toISOString();
   try{
    const status=response.status();logProbe({stage:'列表自然响应',host:url.host,path,status});
    if(status>=400){records.push({path,url,at,error:new AppError(`HTTP_${status}`)});return;}
    const json=await response.json(),parsed=parseSource(json,path,at);records.push({path,url,at,json,parsed});
   }catch(e){records.push({path,url,at,error:e instanceof AppError?e:new AppError('LIST_SCHEMA_UNKNOWN')});}
  })();pending.add(task);void task.finally(()=>pending.delete(task));
 };
 browser.responses.on('response',handler);
 return {records,async flush(){while(pending.size)await Promise.all([...pending]);},close(){browser.responses.off('response',handler);}};
}
export async function collect(db,{openBrowser=launch,go=navigate,identify=requireIdentity,wait=sleep,initialSource=null,readPage=readJsonInPage,exportData=downloadExport,reusePath=null}={}){
 const runId=startRun(db);let browser,watch,status='failed',errorCode=null,exitCode=1,pageTotal=null,apiTotal=null,overviewTotal=null,basicCount=0;
 const works=new Map(),sources=new Map(),sourceMetadata={},warnings=[];let exportSummary=null,preparedReuse=null;
 const save=work=>{
  const entries=sources.get(work.aweme_id)??[];
  saveWork(db,runId,work,work.metrics,{phase:'一期列表',scope:{kind:'列表当前累计快照',source_fields:Object.fromEntries(Object.entries(work.metric_sources).map(([k,v])=>[k,{path:v.source_path,field:v.field}]))},metric_sources:work.metric_sources,sources:entries,optional_detail_metrics:'未提供时NULL，不作为一期失败条件'});
 };
 const put=(work,path)=>{
  const previous=works.get(work.aweme_id);
  if(path===CATALOG_PATH)works.set(work.aweme_id,work);
  else{if(!previous)throw new AppError('OVERVIEW_WORK_NOT_IN_CATALOG');works.set(work.aweme_id,mergeSourceWork(previous,work));}
  const raw=[...(sources.get(work.aweme_id)??[]).filter(s=>s.path!==path),{path,observed_at:work.observed_at,row:work.raw}];
  sources.set(work.aweme_id,raw);save(works.get(work.aweme_id));
 };
 const initial=async path=>{
  if(initialSource)return initialSource(path,pageTotal);
  const until=Date.now()+25000;
  while(Date.now()<until){
   await wait(500);await watch.flush();await checkPage(browser.page,browser.state);
   if(path===CATALOG_PATH){const count=pageCount(await browser.page.locator('body').innerText());if(count!==null)pageTotal=count;}
   if(pageTotal!==null){
    const selected=selectInitial(watch.records,path,pageTotal);
    if(selected){await wait(1200);await watch.flush();return selectInitial(watch.records,path,pageTotal)??selected;}
    const failed=watch.records.find(r=>r.path===path&&r.error);
    if(failed){
     if(/^HTTP_(?:429|5\d\d)$/.test(failed.error.code)){
      const json=await readPage(browser.page,failed.url.href,browser.gate);return {...failed,error:null,json,parsed:parseSource(json,path)};
     }
     throw failed.error;
    }
    const available=watch.records.filter(r=>r.path===path&&r.parsed);
    // 等初始化窗口结束再判冲突，不能把先返回的子场景当作主列表。
   }
  }
  if(pageTotal===null)throw new AppError('PAGE_TOTAL_UNKNOWN');
  if(watch.records.some(r=>r.path===path&&r.parsed?.total===null))throw new AppError('LIST_TOTAL_MISSING');
  if(path===OVERVIEW_PATH&&watch.records.some(r=>r.path===path&&r.parsed))throw new AppError('OVERVIEW_TOTAL_CONFLICT');
  throw new AppError('MAIN_LIST_RESPONSE_NOT_FOUND');
 };
 const readAll=async path=>{
  const first=await initial(path);pageTotal=first.pageCount??pageTotal;
  const pager=new ListPager(pageTotal),template=new URL(first.url);let parsed=first.parsed,cursor=template.searchParams.get('max_cursor');
  if(cursor===null)throw new AppError('REQUEST_CURSOR_MISSING');
  for(let round=0;round<1000;round++){
   if(path===CATALOG_PATH)apiTotal=parsed.total;else overviewTotal=parsed.total;
   // 先保存成功获得的逐条数据，后续游标/对账失败仍保留。
   for(const work of parsed.works){
    if(path===CATALOG_PATH){const author=work.raw.author;if(author?.nickname&&author.nickname!==expectedNickname())throw new AppError('ACCOUNT_MISMATCH');}
    put(work,path);
   }
   sourceMetadata[path]??={row_keys:Object.keys(parsed.works[0]?.raw??{}),metric_fields:{}};
   for(const work of parsed.works)for(const [k,v]of Object.entries(work.metric_sources))sourceMetadata[path].metric_fields[k]=v.field;
   const next=pager.accept(parsed,cursor);
   console.log(`列表分页：${path}；第${pager.pages}页；去重${pager.works.size}；接口total=${pager.total}；has_more=${!pager.finished}。`);
   if(next===null)return pager;
   cursor=next;const url=new URL(template);url.searchParams.set('max_cursor',cursor);
   const json=await readPage(browser.page,url.href,browser.gate);await checkPage(browser.page,browser.state);
   parsed=parseSource(json,path);
  }
  throw new AppError('PAGINATION_LIMIT_REACHED');
 };
 try{
  if(openBrowser===launch){assertEgoUnlocked();assertExportRuntime();}
  if(reusePath)preparedReuse=reuseExport(reusePath);
  browser=await openBrowser(false);
  await go(browser.page,HOME,browser);await identify(browser.page,browser.gate);
  console.log('身份确认：预期账号核对通过；一期仅采列表指标，不进入详情页。');
  if(!initialSource)watch=observe(browser);
  await go(browser.page,MANAGE,browser);
  const catalog=await readAll(CATALOG_PATH);
  if(browser.page.screenshot)await browser.page.screenshot({path:join(ROOT,`logs/manage-count-run-${runId}.png`)});
  if(catalog.works.size!==pageTotal)throw new AppError('CATALOG_COUNT_MISMATCH');
  // 副源完全可选，仅复用管理页已有自然响应；不导航直播/投稿场景。
  try{
   if(watch)await watch.flush();
   const candidate=initialSource?await initialSource(OVERVIEW_PATH,pageTotal):selectInitial(watch.records,OVERVIEW_PATH,pageTotal);
   if(!candidate)throw new AppError('OPTIONAL_OVERVIEW_SCOPE_UNAVAILABLE');
   const p=new ListPager(pageTotal),template=new URL(candidate.url);let parsed=candidate.parsed,cursor=template.searchParams.get('max_cursor');
   if(cursor===null)throw new AppError('REQUEST_CURSOR_MISSING');
   for(let i=0;i<1000;i++){
    const next=p.accept(parsed,cursor);if(next===null)break;
    cursor=next;const u=new URL(template);u.searchParams.set('max_cursor',cursor);parsed=parseSource(await readPage(browser.page,u.href,browser.gate),OVERVIEW_PATH);
   }
   if(!p.finished||p.works.size!==catalog.works.size||[...p.works.keys()].some(id=>!catalog.works.has(id)))throw new AppError('OPTIONAL_OVERVIEW_ID_SET_MISMATCH');
   // 整个范围确认前不写副源；主源值不被不确定副源覆盖。
   overviewTotal=p.total;for(const work of p.works.values())put(work,OVERVIEW_PATH);
  }catch(e){
   if(['NEEDS_LOGIN','CAPTCHA','ACCOUNT_MISMATCH'].includes(e.code))throw e;
   const warning={source:OVERVIEW_PATH,code:e instanceof AppError?e.code:'OPTIONAL_OVERVIEW_UNAVAILABLE',merged:false};warnings.push(warning);console.log('可选副源警告：'+JSON.stringify(warning));
  }
  basicCount=[...works.values()].filter(w=>BASIC.every(k=>w.metrics[k]!==null)).length;
  const snapshotCount=db.prepare('SELECT count(*) n FROM metric_snapshots WHERE run_id=?').get(runId).n;
  if(snapshotCount!==pageTotal||works.size!==pageTotal||apiTotal!==pageTotal)throw new AppError('FINAL_COUNT_MISMATCH');
  if(basicCount!==works.size)throw new AppError('BASE_METRICS_MISSING');
  const exported=preparedReuse??await exportData(browser,runId);
  exported.metadata.list_observed_at=new Date().toISOString();
  exportSummary=importIntoRun(db,runId,exported,{writeReceipt:openBrowser===launch});
  console.log('导出匹配概要：'+JSON.stringify(exportSummary));
  status='success';exitCode=0;
  console.log(`一期全量对账通过：去重=${works.size}，本轮数据库=${snapshotCount}，目录total=${apiTotal}，总览total=${overviewTotal}，管理页=${pageTotal}。`);
 }catch(e){
  errorCode=e instanceof AppError?e.code:'COLLECT_FAILED';exitCode=e.exitCode??1;
  status=exitCode===3?'needs_login':works.size?'partial':'failed';
  console.log('采集停止：'+errorCode);
  if(browser?.page?.screenshot)await browser.page.screenshot({path:join(ROOT,`logs/collect-failed-run-${runId}.png`)}).catch(()=>{});
 }finally{
  watch?.close();
  if(browser){try{await browser.close();if(openBrowser===launch){assertEgoUnlocked();console.log('采集退出核对：Ego主进程为0，SingletonLock已释放。');}}catch{errorCode??='BROWSER_CLOSE_FAILED';if(status==='success')status='partial';}}
 }
 basicCount=[...works.values()].filter(w=>BASIC.every(k=>w.metrics[k]!==null)).length;
 const snapshotCount=db.prepare('SELECT count(*) n FROM metric_snapshots WHERE run_id=?').get(runId).n;
 if(openBrowser===launch)atomicJson(join(ROOT,`logs/reconciliation-run-${runId}.json`),{at:new Date().toISOString(),runId,pageTotal,apiTotal,overviewTotal,distinct:works.size,snapshotCount,basicComplete:basicCount,sourceMetadata,scope:'一期列表；详情可空',status,error:errorCode,warnings,exportSummary,synthetic:false});
 db.prepare('UPDATE collect_runs SET warnings_json=? WHERE id=?').run(JSON.stringify(warnings),runId);
 const count=finishRun(db,runId,{status,pageCount:pageTotal,apiCount:apiTotal,detailCount:0,listMetricCount:basicCount,error:errorCode});
 return {runId,status,collected:count,pageCount:pageTotal,apiCount:apiTotal,overviewCount:overviewTotal,basicCount,detailCount:0,warnings,exportSummary,error:errorCode,exitCode:status==='success'?0:status==='partial'?2:exitCode};
}
