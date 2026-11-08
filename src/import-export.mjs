import {readFileSync,realpathSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {ROOT,AppError,atomicJson} from './runtime.mjs';
import {parseExport,matchExport,requireFullExport} from './export.mjs';
import {saveExport,listBaseline} from './store.mjs';
export const EXPORT_ENDPOINT={host:'creator.douyin.com',path:'/web/api/creator/item/list/download'};
export function reuseExport(path,{manifestPath}={}){
 const real=realpathSync(resolve(ROOT,path)),folder=realpathSync(join(ROOT,'data/exports'));
 if(!real.startsWith(folder+sep))throw new AppError('EXPORT_FILE_OUTSIDE_MODULE');
 const parsed=parseExport(real);
 let manifest;try{manifest=JSON.parse(readFileSync(manifestPath??join(folder,'run-'+real.split('/').at(-1).match(/^run-(\d+)-/)?.[1]+'-manifest.json'),'utf8'));}catch{throw new AppError('EXPORT_MANIFEST_MISSING');}
 if(manifest.sha256!==parsed.sha256)throw new AppError('EXPORT_HASH_MISMATCH');
 const observed=manifest.source_contracts?.find(c=>c.host===EXPORT_ENDPOINT.host&&c.path===EXPORT_ENDPOINT.path&&c.method==='GET'&&c.status===200)?.at??manifest.source_observed_at??manifest.downloaded_at;
 if(!observed)throw new AppError('EXPORT_SOURCE_TIME_UNKNOWN');
 return {parsed,metadata:{...manifest,path:real,source:EXPORT_ENDPOINT,source_observed_at:observed,original_downloaded_at:manifest.downloaded_at,imported_at:new Date().toISOString(),reused:true,reuse_notice:'复用已有导出；文件原始取数时刻早于本次列表，不代表重新取数',period_verified:false}};
}
export function importIntoRun(db,runId,exported,{writeReceipt=true}={}){
 const run=db.prepare('SELECT * FROM collect_runs WHERE id=?').get(runId);if(!run)throw new AppError('RUN_NOT_FOUND');
 const snapshots=db.prepare('SELECT w.*,s.* FROM works w JOIN metric_snapshots s USING(aweme_id) WHERE s.run_id=?').all(runId);
 const result=matchExport(exported.parsed,snapshots,exported.metadata);
 const byId=new Map(snapshots.map(r=>[r.aweme_id,r])),differences=[];
 for(const row of result.accepted){const source=byId.get(row.aweme_id),list=listBaseline(source).values.plays,value=row.metrics.plays?.value??null;differences.push({aweme_id:row.aweme_id,title:source.title,published_at:source.published_at,list_plays:list,export_plays:value,difference:list!==null&&value!==null?value-list:null,list_zero_export_positive:list===0&&value>0});}
 const comparable=differences.filter(r=>r.list_plays!==null&&r.export_plays!==null),summary={counts:result.counts,fields:result.fields,matchedPlays:comparable.length,differentPlays:comparable.filter(r=>r.list_plays!==r.export_plays).length,listZeroExportPositive:comparable.filter(r=>r.list_zero_export_positive).length,listPlaysSum:comparable.reduce((n,r)=>n+r.list_plays,0),exportPlaysSum:comparable.reduce((n,r)=>n+r.export_plays,0),file:exported.metadata.path,sha256:exported.parsed.sha256,source_observed_at:exported.metadata.source_observed_at,imported_at:exported.metadata.imported_at,period:exported.metadata.period,reused:Boolean(exported.metadata.reused)};
 saveExport(db,runId,result,{...exported.metadata,sha256:exported.parsed.sha256,format:exported.parsed.format});
 if(writeReceipt)atomicJson(join(ROOT,`logs/export-import-run-${runId}.json`),{at:new Date().toISOString(),runId,summary,differences,rows:result.rows.map(r=>({aweme_id:r.aweme_id,minute:r.minute,row:r.row_number,sheet:r.sheet,status:r.status,reason:r.reason,method:r.match_method,candidate_ids:r.candidate_ids,title:r.cells.find(c=>['作品名称','标题','作品标题'].includes(c.header))?.raw??null})),synthetic:false});
 try{requireFullExport(result,run.page_work_count??snapshots.length);}catch(e){db.prepare("UPDATE collect_runs SET status='partial',error_code=? WHERE id=?").run(e.code,runId);throw e;}
 const warnings=JSON.parse(run.warnings_json??'[]').filter(w=>w.code!=='EXPORT_INCOMPLETE_MATCH');db.prepare('UPDATE collect_runs SET warnings_json=? WHERE id=?').run(JSON.stringify(warnings),runId);
 return summary;
}
