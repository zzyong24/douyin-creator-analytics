import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {metricEvidence,CATALOG_PATH} from './list-source.mjs';
import { METRICS, sanitize } from './parse.mjs';
export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  if (!db.prepare('PRAGMA table_info(collect_runs)').all().some(c => c.name === 'list_metric_count')) db.exec('ALTER TABLE collect_runs ADD COLUMN list_metric_count INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(collect_runs)').all().some(c => c.name === 'warnings_json')) db.exec("ALTER TABLE collect_runs ADD COLUMN warnings_json TEXT");
  if (!db.prepare('PRAGMA table_info(metric_snapshots)').all().some(c => c.name === 'extensions_json')) db.exec("ALTER TABLE metric_snapshots ADD COLUMN extensions_json TEXT CHECK(extensions_json IS NULL OR json_valid(extensions_json))");
  db.exec(`CREATE TABLE IF NOT EXISTS export_files (run_id INTEGER PRIMARY KEY REFERENCES collect_runs(id),metadata_json TEXT NOT NULL,summary_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS export_import_history (id INTEGER PRIMARY KEY,run_id INTEGER NOT NULL,imported_at TEXT NOT NULL,previous_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS export_rows (id INTEGER PRIMARY KEY,run_id INTEGER NOT NULL REFERENCES collect_runs(id),aweme_id TEXT,status TEXT NOT NULL,row_json TEXT NOT NULL);`);
  return db;
}
export function startRun(db, at = new Date().toISOString()) {
  return Number(db.prepare("INSERT INTO collect_runs(started_at,status) VALUES(?,'running')").run(at).lastInsertRowid);
}
export function finishRun(db, id, { status, pageCount = null, apiCount = null, detailCount = 0, listMetricCount = 0, error = null }) {
  const count = db.prepare('SELECT count(*) n FROM metric_snapshots WHERE run_id=?').get(id).n;
  db.prepare('UPDATE collect_runs SET finished_at=?,status=?,page_work_count=?,api_work_count=?,collected_count=?,detail_count=?,list_metric_count=?,error_code=? WHERE id=?')
    .run(new Date().toISOString(), status, pageCount, apiCount, count, detailCount, listMetricCount, error, id);
  return count;
}
export function saveWork(db, runId, work, metrics, raw, at = new Date().toISOString()) {
  const fields = ['title', 'description', 'published_at', 'duration_sec', 'cover_url', 'work_type', 'visibility'];
  const keys = Object.keys(METRICS);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO works(aweme_id,${fields.join(',')},first_seen_at,last_seen_at) VALUES(${Array(10).fill('?')})
      ON CONFLICT(aweme_id) DO UPDATE SET ${fields.map(k => `${k}=excluded.${k}`).join(',')},last_seen_at=excluded.last_seen_at`)
      .run(work.aweme_id, ...fields.map(k => work[k] ?? null), at, at);
    db.prepare(`INSERT INTO metric_snapshots(run_id,aweme_id,collected_at,${keys.join(',')},raw_json) VALUES(${Array(keys.length + 4).fill('?')})
      ON CONFLICT(run_id,aweme_id) DO UPDATE SET collected_at=excluded.collected_at,${keys.map(k => `${k}=excluded.${k}`).join(',')},raw_json=excluded.raw_json`)
      .run(runId, work.aweme_id, at, ...keys.map(k => metrics[k] ?? null), JSON.stringify(sanitize(raw)));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function latestRows(db) {
  return db.prepare(`SELECT w.*,s.*,s.id snapshot_id FROM works w JOIN metric_snapshots s ON s.aweme_id=w.aweme_id
    WHERE s.id=(SELECT s2.id FROM metric_snapshots s2 WHERE s2.aweme_id=w.aweme_id ORDER BY collected_at DESC,id DESC LIMIT 1)
    ORDER BY s.plays DESC,w.aweme_id`).all();
}
export function previousSnapshot(db, row) {
  return db.prepare(`SELECT * FROM metric_snapshots WHERE aweme_id=? AND (collected_at<? OR (collected_at=? AND id<?)) ORDER BY collected_at DESC,id DESC LIMIT 1`)
    .get(row.aweme_id, row.collected_at, row.collected_at, row.snapshot_id);
}

export function listBaseline(snapshot){
 const raw=JSON.parse(snapshot.raw_json),source=raw.sources?.find(s=>s.path===CATALOG_PATH);
 return source?metricEvidence(source.row,CATALOG_PATH,source.observed_at):{values:Object.fromEntries(Object.keys(METRICS).map(k=>[k,snapshot[k]??null])),evidence:{}};
}
export function saveExport(db,runId,result,metadata){
 db.exec('BEGIN IMMEDIATE');
 try{
  const previous=db.prepare('SELECT * FROM export_files WHERE run_id=?').get(runId);
  if(previous){
   const rows=db.prepare('SELECT aweme_id,status,row_json FROM export_rows WHERE run_id=?').all(runId);
   db.prepare('INSERT INTO export_import_history(run_id,imported_at,previous_json) VALUES(?,?,?)').run(runId,new Date().toISOString(),JSON.stringify({file:previous,rows}));
  }
  db.prepare('INSERT INTO export_files(run_id,metadata_json,summary_json) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET metadata_json=excluded.metadata_json,summary_json=excluded.summary_json').run(runId,JSON.stringify(metadata),JSON.stringify({counts:result.counts,fields:result.fields}));
  db.prepare('DELETE FROM export_rows WHERE run_id=?').run(runId);
  const insert=db.prepare('INSERT INTO export_rows(run_id,aweme_id,status,row_json) VALUES(?,?,?,?)');
  for(const row of result.rows)insert.run(runId,row.aweme_id,row.status,JSON.stringify(row));
  const keys=Object.keys(METRICS);
  // 每次导入先恢复同一快照的原始列表值，防止旧扩展或旧匹配留下来源错配。
  for(const snapshot of db.prepare('SELECT * FROM metric_snapshots WHERE run_id=?').all(runId)){
   const base=listBaseline(snapshot);
   db.prepare(`UPDATE metric_snapshots SET ${keys.map(k=>k+'=?').join(',')},extensions_json=NULL WHERE id=?`).run(...keys.map(k=>base.values[k]??null),snapshot.id);
  }
  for(const row of result.accepted){
   const snapshot=db.prepare('SELECT * FROM metric_snapshots WHERE run_id=? AND aweme_id=?').get(runId,row.aweme_id);
   const base=listBaseline(snapshot),selected={};
   for(const key of keys){
    const exported=row.metrics[key],fromExport=exported?.value!=null;
    selected[key]=fromExport?{...exported,selected_source:'导出优先',observed_at:metadata.source_observed_at??metadata.downloaded_at??metadata.exported_at}:base.values[key]!=null?{...base.evidence[key],value:base.values[key],selected_source:'导出缺值，保留实际主列表来源'}:{value:null,selected_source:'无已确认来源'};
   }
   const extension={source:metadata,cells:row.cells,metrics:row.metrics,selected_sources:selected,list_values:base.values,match_method:row.match_method,minute:row.minute};
   db.prepare(`UPDATE metric_snapshots SET ${keys.map(k=>k+'=?').join(',')},extensions_json=? WHERE run_id=? AND aweme_id=?`).run(...keys.map(k=>selected[k].value??null),JSON.stringify(extension),runId,row.aweme_id);
  }
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
