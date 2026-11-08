import process from 'node:process';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT,AppError,prepare,commandLock,sleep,registerCleanup} from './runtime.mjs';
import {assertEgoUnlocked} from './ego.mjs';
import {launch,navigate,requireIdentity,readJsonInPage,checkPage,explicitRead,HOME,MANAGE,ANALYSIS,ORIGIN,analysisLink,dataActionSelector} from './browser.mjs';

export const safeKey=key=>/^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(key)&&!/\d{6,}/.test(key)?key:'[动态键已脱敏]';
export function safeEndpoint(value){
 const u=new URL(value);
 return {host:u.host,path:u.pathname.split('/').map(s=>/^\d{6,}$/.test(s)||s.length>80?'[动态片段已脱敏]':s).join('/')};
}
// 仅顶层、第二层键名及数组长度。数组元素只合并键名，不输出任何叶值。
export function responseShape(value){
 const keys=new Set(),arrays=[];
 function visit(v,path,depth){
  if(!v||typeof v!=='object')return;
  if(Array.isArray(v)){
   arrays.push({path,length:v.length});
   if(depth<=2)for(const item of v)visit(item,`${path}[]`,depth);
   return;
  }
  if(depth>2)return;
  for(const k of Object.keys(v)){
   const safe=safeKey(k),next=path?`${path}.${safe}`:safe;
   keys.add(next);
   if(safe===k)visit(v[k],next,depth+1);
  }
 }
 visit(value,'',1);
 return {keys:[...keys].sort(),arrays:[...new Map(arrays.map(a=>[JSON.stringify(a),a])).values()]};
}
export function catalogArrays(value,path='',depth=0){
 if(!value||typeof value!=='object'||depth>5)return [];
 if(Array.isArray(value)){
  return value.some(row=>row&&typeof row==='object'&&['aweme_id','item_id'].some(k=>typeof row[k]==='string'&&/^\d+$/.test(row[k])))?[{path,rows:value}]:[];
 }
 return Object.entries(value).flatMap(([key,child])=>catalogArrays(child,path?`${path}.${key}`:key,depth+1));
}
export class Discovery{
 constructor(){this.browser=null;this.pending=new Set();this.records=[];this.phase='初始化';this.failed=false;this.file=join(ROOT,'logs/discovery-metadata.jsonl');}
 async operation(fn){
  if(this.failed)throw new AppError('DISCOVERY_ALREADY_STOPPED');
  try{return await fn();}catch(error){
   this.failed=true;
   const code=error instanceof AppError?error.code:'DISCOVERY_OPERATION_FAILED';
   console.log('发现步骤停止：'+code);
   if(this.browser)await this.browser.page.screenshot({path:join(ROOT,'logs/discovery-failed.png')}).catch(()=>{});
   await this.close();throw new AppError(code,error.exitCode??1);
  }
 }
 async flush(){while(this.pending.size)await Promise.all([...this.pending]);}
 snapshot(){return this.records.filter(r=>r.phase===this.phase).map(r=>r.meta);}
 async settle(ms=6000){await sleep(ms);await this.flush();await checkPage(this.browser.page,this.browser.state);}
 async start({analysisOnly=false}={}){return this.operation(async()=>{
  prepare();this.unlock=commandLock();assertEgoUnlocked();
  this.unregister=registerCleanup(()=>this.close());
  if(process.env.EGO_CDP_URL||process.env.ANALYTICS_ROUTE_ISOLATION)throw new AppError('DISCOVERY_REQUIRES_DEFAULT');
  console.log('发现启动前：Ego主进程不存在、SingletonLock不存在；默认独占模式。');
  this.browser=await launch(false);
  await navigate(this.browser.page,HOME,this.browser,{maxRetries:0});
  await requireIdentity(this.browser.page,this.browser.gate,false,{probe:(p,u,g)=>readJsonInPage(p,u,g,{maxRetries:0})});
  this.handler=response=>{
   if(!['fetch','xhr'].includes(response.request().resourceType()))return;
   const phase=this.phase;
   const task=(async()=>{
    const contentType=(await response.headerValue('content-type')??'').split(';')[0].slice(0,100);
    let json=null;
    if(/json/i.test(contentType)){try{json=await response.json();}catch{}}
    const meta={at:new Date().toISOString(),phase,...safeEndpoint(response.url()),status:response.status(),contentType,...responseShape(json)};
    appendFileSync(this.file,JSON.stringify(meta)+'\n',{mode:0o600});
    this.records.push({phase,url:new URL(response.url()),json,meta,method:response.request().method()});
   })().catch(()=>{this.observerFailed=true;});
   this.pending.add(task);void task.finally(()=>this.pending.delete(task));
  };
  this.browser.responses.on('response',this.handler);
  this.phase=analysisOnly?'分析入口':'管理首页';
  await navigate(this.browser.page,analysisOnly?ANALYSIS:MANAGE,this.browser,{maxRetries:0});await this.settle();
  if(this.observerFailed)throw new AppError('DISCOVERY_METADATA_FAILED');
  console.log('自然响应元数据已记录；未输出业务值。');
  return this.snapshot();
 });}
 catalogs(phase=null){return this.records.filter(r=>(!phase||r.phase===phase)&&r.url.origin===ORIGIN).flatMap(r=>catalogArrays(r.json).map(a=>({...a,record:r})));}
 contracts(){
  return this.catalogs().map(c=>({phase:c.record.phase,...safeEndpoint(c.record.url),method:c.record.method,rowsPath:c.path,rowKeys:[...new Set(c.rows.flatMap(row=>Object.keys(row??{})).map(safeKey))].sort(),responseFields:Object.keys(c.record.json??{}).map(safeKey),requestFieldNames:[...c.record.url.searchParams.keys()].map(safeKey)}));
 }
 async paginate(){return this.operation(async()=>{
  this.phase='管理翻页';
  const page=this.browser.page;
  this.pagination=await explicitRead(this.browser.gate,()=>page.evaluate(()=>{
   const candidates=[...document.querySelectorAll('button,a,[role="button"],li')].filter(el=>{
    const label=[el.getAttribute('aria-label'),el.getAttribute('title'),el.textContent.trim()].filter(Boolean);
    return label.some(x=>/^(?:下一页|Next Page|next page|Next)$/.test(x))&&el.getBoundingClientRect().width>0&&!el.matches(':disabled,[aria-disabled="true"]')&&!/disabled/.test(el.className??'');
   });
   const target=candidates.find(el=>!candidates.some(other=>el!==other&&el.contains(other)));
   if(target){
    const parts=[];for(let el=target;el&&el!==document.documentElement;el=el.parentElement){const siblings=[...el.parentElement.children].filter(x=>x.tagName===el.tagName);parts.unshift(`${el.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(el)+1})`);}
    return {kind:'下一页',selector:'html > '+parts.join(' > ')};
   }
   return {kind:'一次滚动'};
  }));
  if(this.pagination.selector)await explicitRead(this.browser.gate,()=>page.locator(this.pagination.selector).click({noWaitAfter:true}));
  else await explicitRead(this.browser.gate,()=>page.evaluate(()=>{
   const elements=[document.scrollingElement,...document.querySelectorAll('main,section,div')].filter(Boolean).filter(el=>el.scrollHeight>el.clientHeight+100&&getComputedStyle(el).overflowY!=='hidden');
   for(const el of elements)el.scrollTop=el.scrollHeight;
  }));
  await this.settle(6000);
  console.log('管理页已完成唯一一次'+this.pagination.kind+'，仅记录自然响应元数据。');
  return this.snapshot();
 });}
 async detailEntry(){return this.operation(async()=>{
  const analysisItems=this.records.filter(r=>r.url.pathname==='/web/api/creator/item/list'&&Array.isArray(r.json?.items));
  const catalogs=this.catalogs('管理首页');
  if(analysisItems.length){
   this.target=analysisItems.at(-1).json.items.map(r=>r.id).find(id=>typeof id==='string'&&/^\d+$/.test(id));
  }
  if(!catalogs.length&&!this.target)throw new AppError('DISCOVERY_CATALOG_NOT_FOUND');
  // 第一页一个明确ID，仅留内存；不输出目标ID或标题。
  this.target??=catalogs[0].rows.map(r=>r.aweme_id??r.item_id).find(id=>typeof id==='string'&&/^\d+$/.test(id));
  const alreadyAnalysis=this.phase==='分析入口';
  this.phase='分析入口';
  if(!alreadyAnalysis){await navigate(this.browser.page,ANALYSIS,this.browser,{maxRetries:0});await this.settle();}
  this.frameEndpoints=this.browser.page.frames().map(f=>safeEndpoint(f.url()));
  for(const frame of this.browser.page.frames()){
   const hrefs=await frame.locator('a[href]').evaluateAll(nodes=>nodes.map(n=>n.href));
   this.targetLink=hrefs.map(h=>analysisLink(h,this.target)).find(Boolean);
   this.targetSelector=this.targetLink?null:await dataActionSelector(frame,this.target);
   if(this.targetLink||this.targetSelector){this.targetFrame=frame;break;}
  }
  // 仅返回可用动作和路径结构，不输出查询串或ID。
  return {entryFound:Boolean(this.targetLink||this.targetSelector),entry:this.targetLink?safeEndpoint(this.targetLink):null,frames:this.frameEndpoints,responses:this.snapshot().filter(r=>r.host==='creator.douyin.com')};
 });}
 async openDetail(){return this.operation(async()=>{
  if(!this.targetLink&&!this.targetSelector)throw new AppError('DISCOVERY_DETAIL_ENTRY_NOT_FOUND');
  this.phase='作品分析';
  let target=this.browser.page;
  if(this.targetLink)await navigate(target,this.targetLink,this.browser,{maxRetries:0});
  else{
   const popup=this.browser.page.waitForEvent('popup',{timeout:4000}).catch(()=>null);
   await explicitRead(this.browser.gate,()=>(this.targetFrame??this.browser.page).locator(this.targetSelector).click({noWaitAfter:true}));
   target=await popup??this.browser.page;await target.waitForLoadState('domcontentloaded');
  }
  this.detailPage=target;
  await sleep(6000);await this.flush();await checkPage(target,this.browser.state);
  return {page:safeEndpoint(target.url()),responses:this.snapshot()};
 });}
 async close(){
  this.unregister?.();this.unregister=null;
  if(this.browser){
   if(this.handler)this.browser.responses.off('response',this.handler);
   try{await this.browser.close();}finally{this.browser=null;await this.flush();}
  }
  this.unlock?.();this.unlock=null;
  assertEgoUnlocked();console.log('发现退出核对：Ego主进程不存在、SingletonLock已释放。');
 }
}
