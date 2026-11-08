import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadRequest, auditPost } from '../src/browser.mjs';
test('GET只读与初始化POST放行，非GET写接口按路径拦截', () => {
 for (const path of ['/web/r/token','/passport/user/info/','/monitor_browser/collect/batch/','/aweme/v1/creator/user/info/']) {
  for(const method of ['GET','POST']) assert.equal(isReadRequest(new URL('https://example.com'+path),method,'fetch'),true,path);
 }
 for(const path of ['/publish','/create','/delete','/remove','/update','/modify','/edit','/comment','/reply','/digg','/follow','/upload','/post_item','/set_profile','/aweme/item/delete/','/api/comment_list','/api/edit-item']) {
  assert.equal(isReadRequest(new URL('https://creator.douyin.com'+path),'GET','xhr'),true,path);
  for(const method of ['POST','PUT','DELETE','PATCH']) assert.equal(isReadRequest(new URL('https://creator.douyin.com'+path),method,'xhr'),false,path);
 }
});
test('POST审计固定字段，不保存query、body、header，允许和阻止均可审计', () => {
 const records=[];
 for(const action of ['allowed','blocked']) auditPost({action,method:'POST',host:'example.com',path:'/web/r/token',query:'secret',body:'secret',headers:'secret'},(path,line,options)=>{
   assert.ok(path.endsWith('/logs/allowed-post.jsonl'));assert.equal(options.mode,0o600);records.push(JSON.parse(line));
 });
 assert.deepEqual(records.map(r=>r.action),['allowed','blocked']);
 for(const r of records) assert.deepEqual(Object.keys(r),['at','action','method','host','path']);
});
test('可信douyin子文档放行，主文档白名单保留', () => {
 for (const host of ['douyin.com','www.douyin.com','live.douyin.com','lf-zt.douyin.com']) {
  const u = new URL('https://'+host+'/ucenter/security/storage-bridge/index.html');
  assert.equal(isReadRequest(u,'GET','document',{subdocument:true}),true);
  assert.equal(isReadRequest(u,'GET','document'),false);
 }
 assert.equal(isReadRequest(new URL('https://douyin.com.evil.test/bridge'),'GET','document',{subdocument:true}),false);
 assert.equal(isReadRequest(new URL('https://www.douyin.com/delete'),'GET','document',{subdocument:true}),true);
});
test('静态资源create/publish与notice/comment GET不误伤；隔离参数不绕文档白名单', () => {
 for (const [path,type] of [['/assets/create.png','image'],['/assets/publish/main.js','script'],['/assets/create.css','stylesheet'],['/assets/publish.woff2','font'],['/assets/publish.json','fetch'],['/notice/comment','xhr']]) {
  assert.equal(isReadRequest(new URL('https://example.org'+path),'GET',type),true);
 }
 assert.equal(isReadRequest(new URL('https://example.org/bridge'),'GET','document',{isolation:true}),false);
});
