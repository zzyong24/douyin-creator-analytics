import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {AppError} from './runtime.mjs';
export const EXPORT_METRICS={
 '播放量':'plays','播放次数':'plays','播放':'plays','点赞量':'likes','点赞数':'likes','点赞':'likes','评论量':'comments','评论数':'comments','评论':'comments','分享量':'shares','分享数':'shares','收藏量':'favorites','收藏数':'favorites',
 '粉丝增量':'follower_gain','5s完播率':'finish_5s_rate','5秒完播率':'finish_5s_rate','2s跳出率':'bounce_2s_rate','主页访问量':'profile_visits','吸粉量':'follower_gain','新增粉丝量':'follower_gain','涨粉量':'follower_gain','封面点击率':'cover_ctr','完播率':'finish_rate','平均播放占比':'avg_play_ratio','2秒跳出率':'bounce_2s_rate','两秒跳出率':'bounce_2s_rate','弹幕量':'danmaku','弹幕数':'danmaku','弹幕':'danmaku','平均播放时长':'avg_play_duration_sec'
};
const display=v=>typeof v==='object'&&v!==null?v.display:String(v??'');
const clean=h=>String(h).trim().replace(/[（(](?:%|％|次|个|人|条|秒|毫秒|s|ms)[）)]$/i,'').trim();
const idHeaders=['作品ID','作品id','视频ID','视频id','aweme_id','item_id'];
const titleHeaders=['作品名称','作品标题','视频标题','标题','内容标题'];
const timeHeaders=['发布时间','发布日时','作品发布时间','视频发布时间'];
export function assertExportRuntime(){const r=spawnSync('/usr/bin/python3',['-c','import csv,zipfile,xml.etree.ElementTree as E; E.fromstring("<ok/>")'],{encoding:'utf8'});if(r.status!==0)throw new AppError('EXPORT_RUNTIME_UNAVAILABLE');}
export function parseExport(path){
 const r=spawnSync('/usr/bin/python3',[fileURLToPath(new URL('./export-reader.py',import.meta.url)),path],{encoding:'utf8',maxBuffer:80*1024*1024});
 if(r.status!==0)throw new AppError('EXPORT_FILE_PARSE_FAILED');
 let data;try{data=JSON.parse(r.stdout);}catch{throw new AppError('EXPORT_FILE_PARSE_FAILED');}
 return {...data,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
}
export function exportNumber(raw,header){
 const text=display(raw).trim().replaceAll(',','');
 if(!text||/^[-—]+$/.test(text)||/^(?:N\/A|null)$/i.test(text))return {value:null,unit:null};
 if(clean(header)==='平均播放时长'&&/^\d{1,3}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)){const parts=text.split(':').map(Number);if(parts[1]<60&&parts[2]<60)return {value:parts[0]*3600+parts[1]*60+parts[2],unit:'秒（显式时:分:秒格式）'};}
 const m=text.match(/^(-?\d+(?:\.\d+)?)(%|％|秒|毫秒|ms|s)?$/i);if(!m)return {value:null,unit:'未识别，保留原值'};
 let value=Number(m[1]),unit=raw?.kind==='excel_percent'?'比例（XLSX百分比单元格原始小数）':(m[2]??header.match(/[（(](%|％|秒|毫秒|s|ms)[）)]$/i)?.[1]??null);
 if(unit==='%'||unit==='％'){value/=100;unit='比例（原始百分数÷100）';}
 if(unit==='毫秒'||unit==='ms'){value/=1000;unit='秒（原始毫秒÷1000）';}
 if(unit==='s')unit='秒';
 return {value,unit:unit??'未附单位'};
}
export const minuteKey=epoch=>Number.isFinite(epoch)?new Date(Math.floor(epoch/60000)*60000+8*3600000).toISOString().slice(0,16).replace('T',' '):null;
export function exportTime(raw){
 const text=display(raw).trim();let epoch=null,precision='分钟';
 if(/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)){epoch=Date.parse(text);precision=/:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(text)?'秒':'分钟';}
 else{
  const m=text.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if(!m)return null;const [,y,mo,d,h,mi,se]=m;
  const local=`${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${mi}:${se??'00'}`;
  epoch=Date.parse(local+'+08:00');precision=se===undefined?'分钟':'秒';
  if(!Number.isFinite(epoch)||new Date(epoch+8*3600000).toISOString().slice(0,19)!==local)return null;
 }
 return Number.isFinite(epoch)?{epoch,minute:minuteKey(epoch),precision,timezone:'Asia/Shanghai',raw:text}:null;
}
export function normalizeCaption(text){return String(text??'').normalize('NFKC').replace(/#[^#\s]+/gu,'').replace(/[\s\p{P}\p{S}]/gu,'');}
function fullDescription(work){
 const raws=work.raw_json?JSON.parse(work.raw_json).sources?.map(s=>s.row)??[]:[work.raw];
 return raws.map(r=>r?.desc).find(v=>typeof v==='string'&&v.trim())??null;
}
function mappedMetrics(row,metadata){
 const metrics={};
 for(const c of row.cells){
  const key=EXPORT_METRICS[clean(c.header)];if(!key)continue;
  const n=exportNumber(c.raw,c.header);
  if(['finish_rate','finish_5s_rate','cover_ctr','bounce_2s_rate','avg_play_ratio'].includes(key)&&n.value!==null){
   if(n.value<0||n.value>1){n.warning='比例超出0–1，未猜百分数';n.value=null;}
   else if(n.unit==='未附单位')n.unit='比例（率字段原始0–1数值）';
  }
  if(key==='avg_play_duration_sec'&&n.value!==null&&!/^秒/.test(n.unit)){n.warning='原始数值未附时长单位，未猜秒';n.value=null;}
  if(metrics[key]){metrics[key]={...metrics[key],value:null,warning:'同指标多个列，未选择'};continue;}
  metrics[key]={...n,raw:c.raw,header:c.header,source:'内容管理页导出',...metadata};
 }
 return metrics;
}
export function tableRows(parsed){
 const result=[];
 for(const sheet of parsed.sheets){
  const index=sheet.rows.findIndex((row,i)=>i<30&&row.some(h=>[...idHeaders,...titleHeaders].includes(display(h).trim())));
  if(index<0)continue;
  const headers=sheet.rows[index].map(display);
  for(let i=index+1;i<sheet.rows.length;i++){
   const row=sheet.rows[i];if(row.every(v=>display(v).trim()===''))continue;
   const cells=Array.from({length:Math.max(headers.length,row.length)},(_,j)=>({column:j+1,header:headers[j]??'',raw:row[j]??''}));
   result.push({sheet:sheet.name,row_number:i+1,cells});
  }
 }
 if(!result.length)throw new AppError('EXPORT_TABLE_UNKNOWN');
 return result;
}
export function matchExport(parsed,works,metadata){
 const originals=tableRows(parsed),byMinute=new Map(),workMinutes=new Map();
 const prepared=originals.map(row=>{
  const get=names=>row.cells.filter(c=>names.includes(c.header.trim()));
  const times=get(timeHeaders),t=times.length===1?exportTime(times[0].raw):null;
  const info={row,time:t,ids:get(idHeaders),titles:get(titleHeaders)};
  if(t){const group=byMinute.get(t.minute)??[];group.push(info);byMinute.set(t.minute,group);}return info;
 });
 for(const work of works){const key=minuteKey(Date.parse(work.published_at));if(key){const group=workMinutes.get(key)??[];group.push(work);workMinutes.set(key,group);}}
 const attempts=prepared.map(info=>{
  const {row,time,ids,titles}=info;let candidates=[],method=null,reason=null;
  if(ids.length){
   let id=display(ids[0].raw).trim();if(/^="\d+"$/.test(id))id=id.slice(2,-1);
   if(ids.length!==1||!/^\d+$/.test(id))reason='ID格式或精度不可确认';
   else{candidates=works.filter(w=>w.aweme_id===id);method='精确作品ID';if(!candidates.length)reason='ID未匹配';}
  }else if(!time)reason='发布时间格式未知或列不唯一';
  else{
   const pool=workMinutes.get(time.minute)??[];
   if(pool.length===1&&byMinute.get(time.minute).length===1){candidates=pool;method='上海发布时间分钟唯一（作品与导出行均唯一）';}
   else if(pool.length){
    const caption=titles.length===1?normalizeCaption(display(titles[0].raw)):'';
    if(!caption)reason='同分钟缺少唯一文案列';else{
     const exact=pool.filter(w=>{const desc=fullDescription(w);return desc&&normalizeCaption(desc)===caption;});
     if(exact.length){candidates=exact;method='同分钟+真实desc归一化全文一致';}
     else{candidates=pool.filter(w=>{const title=normalizeCaption(w.title);return title&&caption.includes(title);});method='同分钟+归一化标题为导出名称子串';}
    }
   }else reason='该上海分钟无作品';
   if(!candidates.length)reason??='同分钟文案未匹配';
  }
  if(candidates.length>1)reason='同分钟文案歧义，多个候选';
  return {...row,minute:time?.minute??null,published_raw:time?.raw??null,candidate_ids:candidates.map(w=>w.aweme_id),aweme_id:candidates.length===1?candidates[0].aweme_id:null,match_method:method,status:candidates.length===1?'matched':candidates.length>1?'ambiguous':'unmatched',reason,metrics:mappedMetrics(row,metadata)};
 });
 const countsById=new Map();for(const r of attempts)if(r.aweme_id)countsById.set(r.aweme_id,(countsById.get(r.aweme_id)??0)+1);
 const rows=attempts.map(r=>r.aweme_id&&countsById.get(r.aweme_id)>1?{...r,status:'duplicate',reason:'多导出行指向同作品，全部拒绝合并'}:r),accepted=rows.filter(r=>r.status==='matched');
 const counts={totalRows:rows.length,matchedRows:accepted.length,acceptedRows:accepted.length,matchedWorks:new Set(accepted.map(r=>r.aweme_id)).size,duplicates:rows.filter(r=>r.status==='duplicate').length,ambiguous:rows.filter(r=>r.status==='ambiguous').length,unmatched:rows.filter(r=>r.status==='unmatched').length,catalogWorks:works.length};
 return {rows,accepted,counts,fields:[...new Set(rows.flatMap(r=>r.cells.map(c=>c.header)))]};
}
export function requireFullExport(result,expected){if(result.counts.totalRows!==expected||result.counts.matchedWorks!==expected||result.counts.acceptedRows!==expected||result.counts.duplicates||result.counts.ambiguous||result.counts.unmatched)throw new AppError('EXPORT_INCOMPLETE_MATCH',2);}
