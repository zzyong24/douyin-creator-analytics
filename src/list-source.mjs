import {AppError} from './runtime.mjs';
import {METRICS,number,object,parseList,mergeMetrics} from './parse.mjs';
export const CATALOG_PATH='/janus/douyin/creator/pc/work_list';
export const OVERVIEW_PATH='/web/api/creator/item/list';
export const BASIC=['plays','likes','comments','shares','favorites'];
export function metricEvidence(row,source,at){
 const values=Object.fromEntries(Object.keys(METRICS).map(k=>[k,null])),evidence={};
 const layers=[['',object(row)],...['statistics','stats','metrics','statistics_data','item_data'].map(k=>[k,object(row[k])])];
 for(const [name,aliases] of Object.entries(METRICS))for(const [prefix,layer] of layers)for(const alias of aliases){
  const raw=layer[alias],wrapper=object(raw),value=number(raw)??number(wrapper.value)??number(wrapper.count);
  if(value===null)continue;
  const unit=wrapper.unit??layer[alias+'_unit']??null;
  if(name==='avg_play_duration_sec'&&alias!=='avg_duration_sec'&&!['秒','s','sec','seconds'].includes(unit))continue;
  values[name]=value;
  evidence[name]={source_path:source,field:[prefix,alias].filter(Boolean).join('.'),raw_value:typeof raw==='object'?(wrapper.value??wrapper.count):raw,unit:typeof raw==='string'&&raw.endsWith('%')?'显式百分比转小数':unit??(alias==='avg_duration_sec'?'秒':'接口原始计数或比例，未附单位'),observed_at:at};
 }
 return {values,evidence};
}
export function parseSource(json,path,at=new Date().toISOString()){
 if(json?.status_code===8)throw new AppError('NEEDS_LOGIN',3);
 if(json?.status_code!=null&&json.status_code!==0)throw new AppError('LIST_API_ERROR');
 let parsed;
 if(path===CATALOG_PATH)parsed=parseList(json);
 else if(path===OVERVIEW_PATH){
  if(!Array.isArray(json?.items))throw new AppError('OVERVIEW_SCHEMA_UNKNOWN');
  parsed=parseList({aweme_list:json.items.map(r=>({...r,aweme_id:r.id,desc:r.description})),total:json.total,has_more:json.has_more,max_cursor:json.max_cursor,min_cursor:json.min_cursor});
 }else throw new AppError('SOURCE_NOT_ALLOWED');
 parsed.works=parsed.works.map(work=>{
  const raw=path===OVERVIEW_PATH?json.items.find(r=>r.id===work.aweme_id):work.raw;
  const m=metricEvidence(raw,path,at);
  return {...work,raw,metrics:m.values,metric_sources:m.evidence,source:path,observed_at:at};
 });
 return parsed;
}
export function selectInitial(records,path,pageTotal){
 const candidates=records.filter(r=>r.path===path&&!r.error&&r.parsed.total===pageTotal&&r.url.searchParams.has('max_cursor'));
 // 置顶子集不能冒充全量初始页；不读取/改写scene或status值来猜合同。
 const full=candidates.filter(r=>r.parsed.hasMore===true||new Set(r.parsed.works.map(w=>w.aweme_id)).size===pageTotal);
 return full.sort((a,b)=>b.parsed.works.length-a.parsed.works.length||a.at.localeCompare(b.at))[0]??null;
}
export class ListPager{
 constructor(expected){this.expected=expected;this.total=null;this.works=new Map();this.cursors=new Set();this.finished=false;this.pages=0;}
 accept(parsed,requestCursor){
  if(this.finished)throw new AppError('PAGINATION_AFTER_END');
  if(!Number.isSafeInteger(parsed.total)||parsed.total<0)throw new AppError('LIST_TOTAL_MISSING');
  if(parsed.total!==this.expected||this.total!==null&&parsed.total!==this.total)throw new AppError('LIST_TOTAL_CONFLICT');
  if(typeof parsed.hasMore!=='boolean')throw new AppError('HAS_MORE_UNKNOWN');
  const cursor=String(requestCursor);
  if(this.cursors.has(cursor))throw new AppError('CURSOR_LOOP');
  this.cursors.add(cursor);this.total=parsed.total;this.pages++;
  const before=this.works.size;
  for(const work of parsed.works)this.works.set(work.aweme_id,work);
  if(this.works.size>this.total)throw new AppError('LIST_COUNT_EXCEEDS_TOTAL');
  if(parsed.hasMore===false){this.finished=true;if(this.works.size!==this.total)throw new AppError('LIST_COUNT_MISMATCH');return null;}
  if(this.works.size===before)throw new AppError('PAGINATION_STALLED');
  const next=parsed.maxCursor;
  if(!['string','number'].includes(typeof next)||String(next)===''||typeof next==='number'&&!Number.isSafeInteger(next)||String(next)===cursor)throw new AppError('CURSOR_NOT_ADVANCING');
  if(this.cursors.has(String(next)))throw new AppError('CURSOR_LOOP');
  return String(next);
 }
}
export function mergeSourceWork(primary,secondary){
 if(primary.aweme_id!==secondary.aweme_id)throw new AppError('WORK_ID_MISMATCH');
 const metrics=mergeMetrics(primary.metrics,secondary.metrics),metric_sources={...primary.metric_sources};
 for(const [key,value] of Object.entries(secondary.metrics))if(value!==null)metric_sources[key]=secondary.metric_sources[key];
 return {...primary,metrics,metric_sources};
}
