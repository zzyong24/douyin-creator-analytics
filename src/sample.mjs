import {join} from 'node:path';
import {existsSync,readFileSync,unlinkSync,appendFileSync} from 'node:fs';
import {ROOT,AppError,sleep,atomicJson} from './runtime.mjs';
import {HOME,MANAGE,ORIGIN,launch,navigate,requireIdentity,checkPage,explicitRead} from './browser.mjs';
import {assertEgoUnlocked} from './ego.mjs';
import {requireDataReady,approveSamples} from './acceptance.mjs';
import {CATALOG_PATH,parseSource} from './list-source.mjs';
import {safeEndpoint,responseShape,catalogArrays} from './discover.mjs';
import {minuteKey} from './export.mjs';
export {displayRange,compareDisplay,comparePercent} from './evidence.mjs';
import {compareDisplay,comparePercent} from './evidence.mjs';
export function sampleSelection(rows){
 const sorted=[...rows].sort((a,b)=>String(b.published_at??'').localeCompare(String(a.published_at??''))||b.aweme_id.localeCompare(a.aweme_id));
 if(sorted.length<3||sorted.some(r=>!r.published_at))throw new AppError('SAMPLE_DATE_SOURCE_MISSING');
 return [0,Math.floor(sorted.length/2),sorted.length-1].map((i,n)=>({kind:['新','中','旧'][n],row:sorted[i]}));
}

// 证据只从调用方或本机配置加载；仓库不内置任何账号的验收基线。
export function loadSampleEvidence(path=process.env.DOUYIN_SAMPLE_EVIDENCE_FILE){
 if(!path)throw new AppError('SAMPLE_EVIDENCE_REQUIRED');
 let evidence;try{evidence=JSON.parse(readFileSync(path,'utf8'));}catch{throw new AppError('SAMPLE_EVIDENCE_INVALID');}
 return validateSampleEvidence(evidence);
}
export function validateSampleEvidence(evidence){
 const keys=['plays','likes','comments','shares','favorites','follower_gain','cover_ctr'];
 if(!evidence||typeof evidence.aweme_id!=='string'||!/^\d+$/.test(evidence.aweme_id)||typeof evidence.title!=='string'||!evidence.title.trim()||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(evidence.published_minute??'')||evidence.source_type!=='用户提供截图转述'||typeof evidence.source!=='string'||!evidence.source.trim()||!Number.isFinite(Date.parse(evidence.source_time))||evidence.original_image_available!==false||keys.some(k=>typeof evidence.page?.[k]!=='string'||!evidence.page[k].trim()))throw new AppError('SAMPLE_EVIDENCE_INVALID');
 return evidence;
}
export const exportStatus=row=>JSON.parse(row.extensions_json??'null')?.cells.find(c=>c.header==='审核状态')?.raw??null;
export function selectSamplesV3(rows,{evidence=loadSampleEvidence()}={}){
 validateSampleEvidence(evidence);
 if(rows.length<3||rows.some(r=>!Number.isFinite(Date.parse(r.published_at))))throw new AppError('SAMPLE_DATE_SOURCE_MISSING');
 const sorted=[...rows].sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at)||b.aweme_id.localeCompare(a.aweme_id));
 const latest=sorted.find(r=>r.aweme_id===evidence.aweme_id);if(!latest||minuteKey(Date.parse(latest.published_at))!==evidence.published_minute||latest.title!==evidence.title)throw new AppError('USER_SAMPLE_IDENTITY_MISMATCH');
 const min=Math.min(...sorted.map(r=>Date.parse(r.published_at))),max=Math.max(...sorted.map(r=>Date.parse(r.published_at))),mid=(min+max)/2;
 const eligible=sorted.filter(r=>['公开','已发布'].includes(exportStatus(r))&&r.plays>0&&r.aweme_id!==latest.aweme_id);
 if(eligible.length<2)throw new AppError('PUBLIC_SAMPLE_CANDIDATES_MISSING');
 const oldest=[...eligible].sort((a,b)=>Date.parse(a.published_at)-Date.parse(b.published_at)||a.aweme_id.localeCompare(b.aweme_id))[0];
 const middle=eligible.filter(r=>r.aweme_id!==oldest.aweme_id).sort((a,b)=>Math.abs(Date.parse(a.published_at)-mid)-Math.abs(Date.parse(b.published_at)-mid)||a.aweme_id.localeCompare(b.aweme_id))[0];
 return [{kind:'新',row:latest,rule:'用户明确指定最新作品，用户截图转述作为证据'}, {kind:'中',row:middle,rule:'导出审核状态公开/已发布且播放>0，排除新旧；离全目录最早与最晚发布时间中点最近，距离并列按ID升序'}, {kind:'旧',row:oldest,rule:'同一合格集合中发布时间最早，并列按ID升序'}].map(s=>({...s,position:sorted.findIndex(r=>r.aweme_id===s.row.aweme_id),export_status:exportStatus(s.row),time_midpoint:new Date(mid).toISOString()}));
}
export function checkUserEvidence(row,{referencePath,evidence=loadSampleEvidence()}={}){
 validateSampleEvidence(evidence);
 if(row.aweme_id!==evidence.aweme_id||row.title!==evidence.title||minuteKey(Date.parse(row.published_at))!==evidence.published_minute)throw new AppError('USER_SAMPLE_IDENTITY_MISMATCH');
 const metrics=Object.fromEntries(['plays','likes','comments','shares','favorites','follower_gain'].map(k=>[k,compareDisplay(evidence.page[k],row[k])]));metrics.cover_ctr=comparePercent(evidence.page.cover_ctr,row.cover_ctr);
 return {kind:'新',aweme_id:row.aweme_id,title:row.title,published_at:row.published_at,source_type:evidence.source_type,source:evidence.source,source_time:evidence.source_time,original_image_available:false,reference_path:referencePath??null,screenshot:null,id_proof:'用户明确作品ID+标题+上海发布时间分钟，与本轮目录同一作品一致',metrics,context_only:{avg_play_ratio:{raw:evidence.page.avg_play_ratio??null,db:null,note:'仅用户截图上下文，导出没有该列，不映射成完播率，不造统一覆盖'}},pass:Object.values(metrics).every(x=>x.pass)};
}
function variants(row){const raw=JSON.parse(row.raw_json),extension=JSON.parse(row.extensions_json);return [...new Set([row.title,row.description,...(raw.sources??[]).flatMap(s=>[s.row?.desc,s.row?.item_title]),extension.cells.find(c=>c.header==='作品名称')?.raw].filter(x=>typeof x==='string'&&x))];}
export async function inspectSamplePage(page,row){
 return page.evaluate(({variants,minute,id})=>{
  const norm=s=>String(s??'').normalize('NFKC').replace(/\s+/g,'');
  const names=variants.map(norm),selector=e=>{const parts=[];for(;e&&e!==document.documentElement;e=e.parentElement){const siblings=[...e.parentElement.children].filter(x=>x.tagName===e.tagName);parts.unshift(`${e.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(e)+1})`);}return 'html > '+parts.join(' > ');};
  const visible=e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0;};
  const dates=text=>[...new Set([...text.matchAll(/(\d{4})[年/-](\d{2})[月/-](\d{2})日?\s+(\d{2}:\d{2})/g)].map(m=>`${m[1]}-${m[2]}-${m[3]} ${m[4]}`))];
  const leaves=[...document.querySelectorAll('a,span,div,p,h3,h4')].filter(e=>visible(e)&&names.includes(norm(e.textContent))&&!Array.from(e.children).some(c=>names.includes(norm(c.textContent))));
  const numeric=s=>/^(?:\d[\d,.]*(?:万|亿|%)?|[-—]+)$/.test(s.trim());
  const result=[];
  for(const seed of leaves){let el=seed;for(let d=0;el&&d<9;d++,el=el.parentElement){
   const text=el.innerText??'',ds=dates(text);if(ds.length>1)break;if(ds.length!==1||ds[0]!==minute)continue;
   const values={};for(const [key,label]of Object.entries({plays:'播放',likes:'点赞',comments:'评论',shares:'分享',favorites:'收藏',follower_gain:'吸粉量',cover_ctr:'封面点击率'})){
    const labels=[...el.querySelectorAll('span,div,p,td')].filter(n=>n.textContent.trim()===label&&!Array.from(n.children).some(c=>c.textContent.trim()===label));
    for(const lab of labels){const nodes=[lab.nextElementSibling,lab.previousElementSibling,...(lab.parentElement?.children??[])].filter(n=>n&&n!==lab),choices=[...new Set(nodes.map(n=>n.textContent.trim()).filter(numeric))];if(choices.length===1){values[key]=choices[0];break;}}
   }
   if(!['播放','点赞','评论','吸粉量'].every(label=>text.includes(label)))continue;
   const explicit=[el,...el.querySelectorAll('[data-row-key],[data-aweme-id],[data-item-id]')].some(n=>['data-row-key','data-aweme-id','data-item-id'].some(k=>n.getAttribute(k)===id));
   result.push({selector:selector(el),title:seed.textContent.trim(),published_minute:minute,published_status:text.includes('已发布')?'已发布':null,values,text:text.slice(0,5000),proof:explicit?'页面明确作品ID+精确发布时间':'唯一标题或真实完整文案精确一致+精确上海发布时间分钟',inViewport:el.getBoundingClientRect().top<innerHeight&&el.getBoundingClientRect().bottom>0});break;
  }}
  const candidates=[...new Map(result.map(c=>[c.selector,c])).values()];
  const controls=[];const search=document.querySelector('input[placeholder="搜索作品"]');
  if(search){let parent=search.parentElement;for(let i=0;parent&&i<3;i++,parent=parent.parentElement){const sb=search.getBoundingClientRect();for(const n of parent.querySelectorAll('svg,button,[role="button"]')){const b=n.getBoundingClientRect();if(visible(n)&&b.left<sb.left+12&&Math.abs(b.top-sb.top)<25&&sb.left-b.left<65)controls.push({kind:'搜索提交图标',selector:selector(n),label:'搜索输入框左侧图标'});}}}
  for(const el of document.querySelectorAll('button,span,div,label,input,td,[role="option"]')){
   if(!visible(el))continue;const text=el.textContent.trim();const calendar=Boolean(el.closest('[class*="picker"],[class*="calendar"],[class*="Picker"],[class*="Calendar"],[role="dialog"]'));
   const aria=el.getAttribute('aria-label')??el.getAttribute('title')??'';const arrow=calendar&&el.tagName==='BUTTON'&&(/上一|下一|前一|后一|上个|下个|previous|next|prev/i.test(aria)||/prev|next/i.test(el.className??''));
   if(calendar&&(arrow||el.tagName==='INPUT'||/^(?:确定|确认|取消|清除|重置|不限|全部|今天|昨天|近\d+天|\d{1,2}|\d{4}年|\d{1,2}月|\d{4}-\d{2}-\d{2})$/.test(text))&&!Array.from(el.children).some(c=>c.textContent.trim()===text))controls.push({kind:el.tagName==='INPUT'?'日期输入':'日期控件',selector:selector(el),label:el.tagName==='INPUT'?(el.getAttribute('placeholder')??'日期输入'):arrow?(aria||'日期翻页按钮'):text,value:el.tagName==='INPUT'?el.value:null,readOnly:el.tagName==='INPUT'?el.readOnly:null});
  }
  return {candidates,controls:[...new Map(controls.map(c=>[c.selector,c])).values()],visiblePublicationMinutes:dates(document.body.innerText).slice(0,20),searchPresent:Boolean(search)};
 },{variants:variants(row),minute:minuteKey(Date.parse(row.published_at)),id:row.aweme_id});
}
export async function sampleList(db){
 const {run}=requireDataReady(db),rows=db.prepare('SELECT w.*,s.* FROM works w JOIN metric_snapshots s USING(aweme_id) WHERE s.run_id=?').all(run.id),evidence=loadSampleEvidence(),selection=selectSamplesV3(rows,{evidence});
 const reference=join(ROOT,`logs/user-evidence-run-${run.id}.json`);atomicJson(reference,{...evidence,recorded_at:new Date().toISOString(),note:'用户文字转述其截图；本任务没有该原图文件，此JSON不是截图'});
 const checks=[checkUserEvidence(selection[0].row,{referencePath:reference,evidence})];atomicJson(join(ROOT,'logs/samples-v3-run-'+run.id+'.json'),{runId:run.id,selection:selection.map(s=>({kind:s.kind,id:s.row.aweme_id,title:s.row.title,published_at:s.row.published_at,position:s.position,export_status:s.export_status,rule:s.rule})),checks,approved:false});
 if(!checks[0].pass)throw new AppError('USER_EVIDENCE_VALUE_MISMATCH',2);
 console.log('新样本用户证据核对通过：'+JSON.stringify(checks[0]));
 let browser,handler;const pending=new Set(),records=[];let responseError=null;
 try{
  assertEgoUnlocked();browser=await launch(false);await navigate(browser.page,HOME,browser);await requireIdentity(browser.page,browser.gate);
  handler=response=>{const request=response.request();if(!['fetch','xhr'].includes(request.resourceType()))return;
   const task=(async()=>{const u=new URL(response.url());if(u.pathname==='/aweme/v1/creator/user/info/')return;const contentType=(await response.headerValue('content-type')??'').split(';')[0];let json=null;if(/json/.test(contentType))try{json=await response.json();}catch{}
    const meta={at:new Date().toISOString(),...safeEndpoint(u),method:request.method(),status:response.status(),contentType,...responseShape(json)};
    appendFileSync(join(ROOT,'logs/sample-v3-metadata-run-'+run.id+'.jsonl'),JSON.stringify(meta)+'\n',{mode:0o600});
    const ids=catalogArrays(json).flatMap(a=>a.rows.map(r=>r.aweme_id??r.item_id));records.push({meta,ids});
    if(u.origin===ORIGIN&&u.pathname.replace(/\/$/,'')===CATALOG_PATH&&response.status()>=400)responseError='HTTP_'+response.status();
   })().catch(()=>{responseError='SAMPLE_METADATA_FAILED';});pending.add(task);void task.finally(()=>pending.delete(task));};
  browser.responses.on('response',handler);await navigate(browser.page,MANAGE,browser);
  const flush=async()=>{while(pending.size)await Promise.all([...pending]);if(responseError)throw new AppError(responseError);await checkPage(browser.page,browser.state);};await sleep(3000);await flush();
  for(const selected of selection.slice(1)){
   const {kind,row}=selected,base=join(ROOT,`logs/sample-v3-run-${run.id}-${kind}`),command=base+'-command.json';
   if(existsSync(command))throw new AppError('SAMPLE_COMMAND_EXISTS');let revision=0,state,beforeTarget=null,searched=false,dateUsed=false,searchSubmits=0,actions=0,proved=false;const startRecords=records.length;
   const inspect=async()=>{await flush();state=await inspectSamplePage(browser.page,row);revision++;const screenshot=base+`-${revision}.png`;await browser.page.screenshot({path:screenshot});const matching=records.slice(startRecords).filter(r=>r.ids.includes(row.aweme_id));
    proved=(searched||dateUsed)&&state.candidates.length===1&&(beforeTarget===false||matching.some(r=>r.ids.length<run.page_work_count));
    atomicJson(base+'-state.json',{runId:run.id,kind,revision,target:{id:row.aweme_id,title:row.title,published_at:row.published_at,minute:minuteKey(Date.parse(row.published_at)),position:selected.position,status:selected.export_status,rule:selected.rule},...state,screenshot,locationEvidence:{searched,dateUsed,beforeTarget,matchingResponses:matching.map(r=>({host:r.meta.host,path:r.meta.path,status:r.meta.status,matchedId:true,rowCount:r.ids.length})),effective:proved}});console.log(`中旧只读定位复核：${base}-state.json；版本${revision}；候选${state.candidates.length}；定位生效=${proved}。`);
   };
   await inspect();beforeTarget=state.candidates.length>0;
   const until=Date.now()+10*60*1000;let accepted=false;
   while(Date.now()<until){
    await flush();if(!existsSync(command)){await sleep(750);continue;}
    const action=JSON.parse(readFileSync(command,'utf8'));unlinkSync(command);if(action.revision!==revision)throw new AppError('SAMPLE_STALE_CONTROL');
    if(action.action==='inspect'){await inspect();continue;}
    if(action.action==='stop')throw new AppError('SAMPLE_TARGET_NOT_CONFIRMED');
    if(++actions>16)throw new AppError('SAMPLE_ACTION_LIMIT');
    if(action.action==='search'){
     if(searched)throw new AppError('SAMPLE_SEARCH_ALREADY_ATTEMPTED');searched=true;
     const input=browser.page.getByPlaceholder('搜索作品',{exact:true});if(await input.count()!==1)throw new AppError('SAMPLE_SEARCH_INPUT_MISSING');
     const keyword=String(action.keyword??row.title);if(!row.title.includes(keyword)||keyword.length<2)throw new AppError('SAMPLE_KEYWORD_NOT_FROM_TITLE');
     await explicitRead(browser.gate,()=>input.fill(keyword));await explicitRead(browser.gate,()=>input.press('Enter'));await sleep(3000);await inspect();continue;
    }
    if(action.action==='date'){
     if(dateUsed)throw new AppError('SAMPLE_DATE_ALREADY_ATTEMPTED');dateUsed=true;
     const input=browser.page.getByPlaceholder('搜索作品',{exact:true});if(await input.count()===1){await explicitRead(browser.gate,()=>input.fill(''));await explicitRead(browser.gate,()=>input.press('Enter'));}
     await explicitRead(browser.gate,()=>browser.page.getByText('发布日期',{exact:true}).click({timeout:10000}));await sleep(1000);await inspect();continue;
    }
    if(action.action==='control'){
     const c=state.controls[action.index];if(!c)throw new AppError('SAMPLE_CONTROL_NOT_OBSERVED');
     if(c.kind==='搜索提交图标'&&(!searched||++searchSubmits>1))throw new AppError('SAMPLE_SEARCH_SUBMIT_LIMIT');
     if(c.kind==='日期输入'){
      if(!dateUsed||c.readOnly||action.value!==minuteKey(Date.parse(row.published_at)).slice(0,10)||!/^\d{4}-\d{2}-\d{2}$/.test(action.value))throw new AppError('SAMPLE_DATE_INPUT_INVALID');await explicitRead(browser.gate,()=>browser.page.locator(c.selector).fill(action.value));
     }else{if(c.kind==='日期控件'&&!dateUsed)throw new AppError('SAMPLE_DATE_NOT_ACTIVE');await explicitRead(browser.gate,()=>browser.page.locator(c.selector).click({timeout:10000}));}
     await sleep(2000);await inspect();continue;
    }
    if(action.action==='verify'){
     if(!proved||state.candidates.length!==1)throw new AppError('SAMPLE_LOCATION_NOT_EFFECTIVE');const found=state.candidates[0];if(found.published_status!=='已发布')throw new AppError('SAMPLE_NOT_PUBLISHED');
     const readings=action.readings??found.values;
     for(const k of ['plays','likes','comments','follower_gain'])if(typeof readings[k]!=='string'||!found.text.includes(readings[k]))throw new AppError('SAMPLE_PAGE_READING_MISSING');
     const metrics=Object.fromEntries(['plays','likes','comments','follower_gain',...['shares','favorites'].filter(k=>readings[k]!==undefined)].map(k=>[k,compareDisplay(readings[k],row[k])]));
     const screenshot=base+'-verified.png';await explicitRead(browser.gate,()=>browser.page.locator(found.selector).scrollIntoViewIfNeeded());await browser.page.screenshot({path:screenshot});
     const check={kind,aweme_id:row.aweme_id,title:row.title,published_at:row.published_at,source_type:'本轮网页截图',source:MANAGE,source_time:new Date().toISOString(),screenshot,id_proof:found.proof+'；全库该精确名称/文案+上海发布时间唯一',selection:{position:selected.position,rule:selected.rule,export_status:selected.export_status,page_status:found.published_status},location_method:dateUsed?'只读搜索后发布日期筛选':'只读标题关键词搜索',location_evidence:{searched,dateUsed,effective:proved,matchingResponseCount:records.slice(startRecords).filter(r=>r.ids.includes(row.aweme_id)).length},page_readings:readings,reading_method:action.readings?'本轮截图人工读取，数值须同时出现在目标卡片DOM文本':'目标卡片DOM逐标签读数，截图复核',metrics,pass:Object.values(metrics).every(m=>m.pass)};
     checks.push(check);atomicJson(join(ROOT,'logs/samples-v3-run-'+run.id+'.json'),{runId:run.id,checks,approved:false});console.log('样本对照：'+JSON.stringify(check));
     if(!check.pass)throw new AppError('SAMPLE_VALUE_MISMATCH_OR_MISSING',2);accepted=true;break;
    }
    throw new AppError('SAMPLE_ACTION_INVALID');
   }
   if(!accepted)throw new AppError('SAMPLE_REVIEW_TIMEOUT');
  }
  const approval=approveSamples(db,checks);atomicJson(join(ROOT,'logs/samples-v3-run-'+run.id+'.json'),{runId:run.id,selection:selection.map(s=>({kind:s.kind,id:s.row.aweme_id,position:s.position,rule:s.rule,status:s.export_status})),checks,approved:true,contractVersion:approval.contractVersion});return {runId:run.id,approved:true,checks};
 }catch(e){if(browser)await browser.page.screenshot({path:join(ROOT,'logs/sample-v3-failed-run-'+run.id+'.png')}).catch(()=>{});throw e;}
 finally{if(browser){if(handler)browser.responses.off('response',handler);await browser.close();assertEgoUnlocked();console.log('抽检退出核对：Ego主进程0、SingletonLock已释放。');}}
}
