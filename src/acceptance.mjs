import {minuteKey} from './export.mjs';
import {compareDisplay,comparePercent} from './evidence.mjs';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT,AppError,readJson,atomicJson} from './runtime.mjs';
export const CONTRACT_VERSION='外部证据-用户转述加双网页-v3';
export function requireDataReady(db){
 const run=db.prepare('SELECT * FROM collect_runs ORDER BY id DESC LIMIT 1').get(),file=run&&db.prepare('SELECT * FROM export_files WHERE run_id=?').get(run.id);
 if(!run||run.status!=='success'||!file)throw new AppError('REPORT_REQUIRES_COMPLETE_DATA',2);
 const c=JSON.parse(file.summary_json).counts;
 if(c.matchedWorks!==run.page_work_count||c.acceptedRows!==run.page_work_count||c.totalRows!==run.page_work_count||c.duplicates||c.ambiguous||c.unmatched||run.collected_count!==run.page_work_count||run.api_work_count!==run.page_work_count)throw new AppError('EXPORT_INCOMPLETE_MATCH',2);
 return {run,file};
}
export function validChecks(db,checks,runId){
 if(!Array.isArray(checks)||checks.length!==3||checks.some(c=>!c||typeof c!=='object')||new Set(checks.map(c=>c.aweme_id)).size!==3||checks.map(c=>c.kind).sort().join(',')!=='中,新,旧')return false;
 for(const c of checks){
  const row=db.prepare('SELECT * FROM metric_snapshots WHERE run_id=? AND aweme_id=?').get(runId,c.aweme_id);
  const keys=c.kind==='新'?['plays','likes','comments','shares','favorites','follower_gain','cover_ctr']:['plays','likes','comments','follower_gain'];
  if(!row||!c.pass||!c.id_proof||!c.source||!Number.isFinite(Date.parse(c.source_time))||keys.some(k=>{const m=c.metrics?.[k];return !m?.pass||m.db!==row[k]||!(k==='cover_ctr'?comparePercent(m.raw,row[k]):compareDisplay(m.raw,row[k])).pass||!m.range||(m.range.exact?m.db!==m.range.low:m.db<m.range.low-1e-12||m.db>=m.range.high);}))return false;
  if(c.kind==='新'){
   if(c.source_type!=='用户提供截图转述'||!c.source||c.original_image_available!==false||!c.reference_path||!existsSync(c.reference_path)||c.screenshot!==null)return false;
   let reference;try{reference=JSON.parse(readFileSync(c.reference_path,'utf8'));}catch{return false;}
   const work=db.prepare('SELECT * FROM works WHERE aweme_id=?').get(c.aweme_id);
   if(!work||!reference||typeof reference!=='object'||reference.source_type!==c.source_type||reference.source!==c.source||reference.source_time!==c.source_time||!Number.isFinite(Date.parse(c.source_time))||reference.original_image_available!==false||reference.aweme_id!==c.aweme_id||reference.title!==work.title||reference.published_minute!==minuteKey(Date.parse(work.published_at))||c.title!==work.title||c.published_at!==work.published_at||keys.some(k=>reference.page?.[k]!==c.metrics[k].raw))return false;
  }else{
   if(c.source_type!=='本轮网页截图'||!c.screenshot||!existsSync(c.screenshot)||!c.location_evidence?.effective||!c.location_method||c.selection?.page_status!=='已发布'||!['公开','已发布'].includes(c.selection?.export_status)||row.plays<=0||keys.some(k=>c.page_readings?.[k]!==c.metrics[k].raw))return false;
  }
 }
 return true;
}
export function approveSamples(db,checks,{path=join(ROOT,'data/acceptance.json')}={}){
 const {run,file}=requireDataReady(db);
 if(!validChecks(db,checks,run.id))throw new AppError('SAMPLE_NOT_APPROVED',2);
 const approval={approved:true,contractVersion:CONTRACT_VERSION,runId:run.id,at:new Date().toISOString(),exportSha256:JSON.parse(file.metadata_json).sha256,checks};atomicJson(path,approval);return approval;
}
export function requireReportReady(db,{approval=readJson(join(ROOT,'data/acceptance.json'))}={}){
 const ready=requireDataReady(db);
 if(!approval?.approved||approval.contractVersion!==CONTRACT_VERSION||approval.runId>ready.run.id||!validChecks(db,approval.checks,approval.runId))throw new AppError('REPORT_REQUIRES_SAMPLES',2);
 return ready;
}
