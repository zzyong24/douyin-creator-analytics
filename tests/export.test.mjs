import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,AppError} from '../src/runtime.mjs';
import {parseExport,matchExport,exportNumber,exportTime,tableRows} from '../src/export.mjs';
import {openDb,startRun,saveWork,saveExport} from '../src/store.mjs';
import {buildReport} from '../src/report.mjs';
import {exactExportException,isReadRequest} from '../src/browser.mjs';
import {safeExportControl} from '../src/export-browser.mjs';
import {collect} from '../src/collect.mjs';
const id='7654321098765432101',works=[{aweme_id:id,title:'合成精确标题',published_at:'2026-11-07T08:02:33.000Z'}];
const metadata={source:{host:'creator.douyin.com',path:'/合成导出'},path:'合成本地文件',period:'合成全部时间',work_scope:'全部作品',exported_at:'2026-11-07T10:00:00Z'};
const parsed=rows=>({format:'CSV',sheets:[{name:'合成',rows}]});
test('CSV中文引号换行/空值/长ID原样保留，全部列入扩展',()=>{
 const dir=mkdtempSync(join(ROOT,'logs/export-test-'));try{
  const path=join(dir,'合成.csv');writeFileSync(path,'\uFEFF作品ID,作品标题,吸粉量,完播率,平均播放占比,2秒跳出率,弹幕,未知字段\r\n'+id+',"合成,标题\n换行",0,12.5%,25%,—,,"保持原值"\r\n');
  const data=parseExport(path),r=matchExport(data,works,metadata);assert.equal(data.format,'CSV');assert.equal(r.counts.matchedWorks,1);assert.equal(r.accepted[0].aweme_id,id);assert.equal(r.accepted[0].cells.length,8);
  assert.equal(r.accepted[0].metrics.follower_gain.value,0);assert.equal(r.accepted[0].metrics.finish_rate.value,0.125);assert.equal(r.accepted[0].metrics.avg_play_ratio.value,0.25);assert.equal(r.accepted[0].metrics.bounce_2s_rate.value,null);assert.equal(r.accepted[0].metrics.danmaku.value,null);
  assert.equal(r.accepted[0].cells[7].raw,'保持原值');assert.match(data.sha256,/^[a-f0-9]{64}$/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('XLSX标准库读取inline/shared strings，百分比样式和日期样式，ID不经浮点',()=>{
 const dir=mkdtempSync(join(ROOT,'logs/xlsx-test-'));try{
  const path=join(dir,'合成.xlsx');const script=`import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="合成" sheetId="1" r:id="r1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/sharedStrings.xml','<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>作品ID</t></si><si><t>完播率</t></si><si><t>发布时间</t></si></sst>')
 z.writestr('xl/styles.xml','<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs><xf numFmtId="0"/><xf numFmtId="10"/><xf numFmtId="22"/></cellXfs></styleSheet>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>未知列</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>${id}</t></is></c><c r="B2" s="1"><v>0.125</v></c><c r="C2" s="2"><v>45000.5</v></c><c r="D2"><v>9999999999999999999</v></c></row></sheetData></worksheet>')
`;
  const child=spawnSync('/usr/bin/python3',['-c',script,path],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
  const data=parseExport(path),r=matchExport(data,works,metadata);assert.equal(data.format,'XLSX');assert.equal(r.accepted[0].metrics.finish_rate.value,0.125);assert.match(r.accepted[0].metrics.finish_rate.unit,/XLSX/);assert.equal(r.accepted[0].cells[3].raw,'9999999999999999999');assert.equal(r.accepted[0].cells[2].raw.kind,'excel_date');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('表头单位、毫秒秒、比例区分；未附单位时长不猜秒，NULL不补0',()=>{
 assert.equal(exportNumber('2500','平均播放时长（毫秒）').value,2.5);assert.equal(exportNumber('2.5秒','平均播放时长').value,2.5);assert.equal(exportNumber('12.5','完播率（%）').value,0.125);
 assert.equal(exportNumber('','吸粉量').value,null);assert.equal(exportNumber('0','吸粉量').value,0);
 const r=matchExport(parsed([['作品ID','平均播放时长','平均播放占比'],[id,'2000','20%']]),works,metadata);assert.equal(r.accepted[0].metrics.avg_play_duration_sec.value,null);assert.equal(r.accepted[0].metrics.avg_play_ratio.value,0.2);assert.equal(r.accepted[0].metrics.finish_rate,undefined);
});
test('ID科学计数法拒绝修补；明确ID错误时不退化标题匹配',()=>{
 const r=matchExport(parsed([['作品ID','标题','发布时间'],['7.65432109876543E+18',works[0].title,'2026-11-07 16:02'],['111',works[0].title,'2026-11-07 16:02']]),works,metadata);
 assert.equal(r.counts.unmatched,2);assert.equal(r.accepted.length,0);assert.match(r.rows[0].reason,/精度/);
});
test('无ID时精确标题+分钟时间按上海匹配；重名同分钟歧义保留',()=>{
 const data=parsed([['标题','发布时间','吸粉量'],[works[0].title,'2026-11-07 16:02','3']]);
 const r=matchExport(data,works,metadata);assert.equal(r.counts.matchedWorks,1);assert.match(r.accepted[0].match_method,/上海.*分钟唯一/);
 const ambiguous=matchExport(data,[...works,{...works[0],aweme_id:'2'}],metadata);assert.equal(ambiguous.counts.ambiguous,1);assert.equal(ambiguous.accepted.length,0);
 assert.equal(exportTime('2026-11-07 16:02').precision,'分钟');
});
test('重复不任取第一条，所有行及未知列保留；覆盖率独立',()=>{
 const r=matchExport(parsed([['作品ID','吸粉量','未知'],[id,'0','甲'],[id,'2','乙'],['123','4','丙']]),works,metadata);
 assert.equal(r.rows.length,3);assert.equal(r.counts.duplicates,2);assert.equal(r.counts.unmatched,1);assert.equal(r.counts.acceptedRows,0);assert.equal(r.counts.matchedWorks,0);assert.equal(r.rows[1].cells[2].raw,'乙');
});
test('SQLite保存全部扩展列与未匹配行，报告引用真实保存来源与周期',()=>{
 const db=openDb(':memory:');try{
  const run=startRun(db);saveWork(db,run,works[0],{plays:9,likes:0,comments:0},{scope:{}});
  const r=matchExport(parsed([['作品ID','吸粉量','平均播放占比','未知'],[id,'3','20%','原值'],['123','','','保留未匹配']]),works,metadata);
  saveExport(db,run,r,{...metadata,sha256:'合成hash'});
  const row=db.prepare('SELECT * FROM metric_snapshots').get(),ext=JSON.parse(row.extensions_json);assert.equal(row.follower_gain,3);assert.equal(row.finish_rate,null);assert.equal(ext.cells[3].raw,'原值');assert.equal(ext.metrics.avg_play_ratio.value,0.2);assert.equal(ext.metrics.follower_gain.period,metadata.period);assert.equal(db.prepare('SELECT count(*) n FROM export_rows').get().n,2);
  const report=buildReport(db);assert.match(report,/合成全部时间/);assert.match(report,/成功匹配导出行：1\/2/);assert.match(report,/吸粉量.*不是作者粉丝总数/);assert.match(report,/未知/);
 }finally{db.close();}
});
test('精确导出合同不扩散到别host/path/method，当前默认无例外；写路径仍禁',()=>{
 const contracts=[{host:'creator.douyin.com',path:'/合成/export/create',method:'POST'}];
 assert.equal(exactExportException(new URL('https://creator.douyin.com/合成/export/create'),'POST',contracts),false); // URL编码路径必须精确同一合同
 const c=[{host:'creator.douyin.com',path:'/test/export/create',method:'POST'}];
 assert.equal(exactExportException(new URL('https://creator.douyin.com/test/export/create'),'POST',c),true);
 for(const [url,method]of[['https://evil.test/test/export/create','POST'],['https://creator.douyin.com/test/export/create/other','POST'],['https://creator.douyin.com/test/export/create','DELETE']])assert.equal(exactExportException(new URL(url),method,c),false);
 assert.equal(isReadRequest(new URL('https://creator.douyin.com/test/export/create'),'POST','xhr'),false);assert.equal(isReadRequest(new URL('https://creator.douyin.com/publish'),'POST','xhr'),false);
 for(const text of ['发布','删除','编辑','点赞','登录','扫码'])assert.equal(safeExportControl(text),false);assert.equal(safeExportControl('导出数据'),true);
});
test('新增导出路径不绕忙锁；忙锁不调用导航、身份或下载',async()=>{
 const db=openDb(':memory:');let called=0;try{const result=await collect(db,{openBrowser:async()=>{throw new AppError('EGO_PROFILE_LOCKED',4);},go:async()=>{called++;},identify:async()=>{called++;},exportData:async()=>{called++;}});assert.equal(result.exitCode,4);assert.equal(called,0);}finally{db.close();}
});
