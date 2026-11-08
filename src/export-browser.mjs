import {join} from 'node:path';
import {mkdirSync,appendFileSync,chmodSync} from 'node:fs';
import {ROOT,AppError,sleep,atomicJson} from './runtime.mjs';
import {explicitRead,checkPage} from './browser.mjs';
import {safeEndpoint,responseShape} from './discover.mjs';
import {parseExport} from './export.mjs';
import {EXPORT_ENDPOINT} from './import-export.mjs';
// 已实测：未筛选内容管理页“导出数据”直接触发GET下载，无范围弹窗。
export const safeExportControl=text=>text==='导出数据';
export async function downloadExport(browser,runId){
 const page=browser.page,folder=join(ROOT,'data/exports'),records=[];let httpError=null,contract=null,download=null,downloadError=null;
 mkdirSync(folder,{recursive:true,mode:0o700});
 const listener=response=>{
  const u=new URL(response.url()),req=response.request();if(u.host!==EXPORT_ENDPOINT.host||u.pathname!==EXPORT_ENDPOINT.path||req.method()!=='GET')return;
  const meta={at:new Date().toISOString(),...EXPORT_ENDPOINT,method:'GET',status:response.status(),contentType:(response.headers()['content-type']??'').split(';')[0]};
  records.push(meta);contract=meta;if(meta.status>=400)httpError='HTTP_'+meta.status;
  appendFileSync(join(ROOT,`logs/export-metadata-run-${runId}.jsonl`),JSON.stringify(meta)+'\n',{mode:0o600});console.log('导出自然响应：'+JSON.stringify(meta));
 };
 const onDownload=d=>{if(download)downloadError='EXPORT_MULTIPLE_DOWNLOADS';else download=d;};
 browser.responses.on('response',listener);page.on('download',onDownload);
 try{
  await checkPage(page,browser.state);
  const text=await page.locator('body').innerText();if(!/作品\s*[（(]\s*\d+\s*[）)]/.test(text))throw new AppError('EXPORT_PAGE_SCOPE_UNKNOWN');
  if(!['审核状态','体裁','发布日期'].every(s=>text.includes(s)))throw new AppError('EXPORT_FILTER_SCOPE_CHANGED');
  const button=page.getByText('导出数据',{exact:true});if(await button.count()!==1)throw new AppError('EXPORT_BUTTON_NOT_UNIQUE');
  const before=join(ROOT,`logs/export-before-run-${runId}.png`);await page.screenshot({path:before});
  await explicitRead(browser.gate,()=>button.click({timeout:15000,noWaitAfter:true}));
  const until=Date.now()+120000;
  while(!download&&Date.now()<until){await sleep(500);await checkPage(page,browser.state);if(httpError)throw new AppError(httpError);}
  if(downloadError)throw new AppError(downloadError);if(!download)throw new AppError('EXPORT_DOWNLOAD_TIMEOUT');
  if(!contract||contract.status!==200)throw new AppError('EXPORT_RESPONSE_CONTRACT_CHANGED');
  const suggested=download.suggestedFilename(),ext=/\.xlsx$/i.test(suggested)?'xlsx':/\.csv$/i.test(suggested)?'csv':'bin',path=join(folder,`run-${runId}-${Date.now()}.${ext}`);
  await download.saveAs(path);if(await download.failure())throw new AppError('EXPORT_DOWNLOAD_FAILED');chmodSync(path,0o600);
  const parsed=parseExport(path),at=new Date().toISOString();
  const metadata={path,source:EXPORT_ENDPOINT,source_observed_at:contract.at,downloaded_at:at,exported_at:at,imported_at:at,reused:false,period:'页面与导出文件未提供指标统计起止，未知；不可认定全历史累计或近30天',period_verified:false,work_scope:'未筛选内容管理页全部作品；导出与主目录逐行匹配及数量门禁另行核验',scope_evidence:'已实测同一管理页导出按钮、审核状态/体裁/发布日期未筛、无范围弹窗，接口GET200；若合同改变则停止',scope_screenshot:before,full_work_scope:true,timezone:'Asia/Shanghai'};
  atomicJson(join(folder,`run-${runId}-manifest.json`),{...metadata,sha256:parsed.sha256,format:parsed.format,source_contracts:records});
  console.log('正常导出完成：'+JSON.stringify({runId,format:parsed.format,path,source:EXPORT_ENDPOINT,source_observed_at:contract.at}));return {parsed,metadata};
 }finally{browser.responses.off('response',listener);page.off('download',onDownload);}
}
