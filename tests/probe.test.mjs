import test from 'node:test';
import assert from 'node:assert/strict';
import { readJsonInPage, diagnosticUrl, diagnosticMessage, isReadRequest, HOME, SESSION } from '../src/browser.mjs';
const fake = result => ({ url: () => HOME, evaluate: async () => result });
test('探针区分BAD_JSON、超时、HTTP和身份过期，不吞异常', async () => {
  for (const [result,code] of [
    [{status:200, contentType:'text/html', error:'BAD_JSON', name:'SyntaxError',message:'Unexpected token'},'BAD_JSON'],
    [{error:'FETCH_TIMEOUT',name:'TimeoutError',message:'timed out'},'FETCH_TIMEOUT'],
    [{status:403},'HTTP_403'],[{status:401},'NEEDS_LOGIN'],
  ]) await assert.rejects(readJsonInPage(fake(result), SESSION, null,{maxRetries:0}),{code});
  assert.deepEqual(await readJsonInPage(fake({status:200,body:{status_code:0}}),SESSION,null,{maxRetries:0}),{status_code:0});
});
test('诊断URL去查询串和片段，异常消息不含完整URL', () => {
 assert.equal(diagnosticUrl(HOME+'?token=secret#fragment'),HOME);
 assert.ok(!diagnosticMessage('failed https://example.com/?token=secret').includes('secret'));
 assert.equal(new URL(HOME).origin,new URL(SESSION).origin);
});
test('fetch/xhr读取放行，写操作仍阻止', () => {
 for(const t of ['fetch','xhr']) {
  assert.equal(isReadRequest(new URL(SESSION),'GET',t),true);
  assert.equal(isReadRequest(new URL(SESSION),'POST',t),true);
 }
});

test('显式fetch由RequestGate串行覆盖响应体读取，重试不套外层闸', async () => {
 const { RequestGate } = await import('../src/runtime.mjs');
 let now=10000, active=0, max=0, calls=0; const starts=[];
 const gate=new RequestGate({now:()=>now,random:()=>0,wait:async ms=>{now+=ms;}});
 const page={url:()=>HOME,evaluate:async()=>{
   starts.push(now); max=Math.max(max,++active); await Promise.resolve(); now+=100; active--; calls++;
   return {status:200,body:{status_code:0}};
 }};
 await Promise.all([readJsonInPage(page,SESSION,gate,{maxRetries:0}),readJsonInPage(page,SESSION,gate,{maxRetries:0})]);
 assert.equal(calls,2);assert.equal(max,1);assert.ok(starts[1]-starts[0]>=4100);
});
test('shape只输出嵌套键名，数组合并结构，不泄露叶值或动态ID键', async()=>{
 const {sessionShape}=await import('../src/browser.mjs');
 const shape=sessionShape({status_code:0,data:{profile:{nickname:'合成昵称',uid:'fixture-id',token:'fixture-credential'},items:[{count:1},{other:'fixture-value'}],'1234567890123456789':{secret:'fixture-secret'}}});
 assert.ok(shape.includes('$.data.profile.nickname'));assert.ok(shape.includes('$.data.profile.uid'));
 assert.ok(shape.includes('$.data.items[].other'));
 const text=JSON.stringify(shape);
 for(const value of ['合成昵称','fixture-id','fixture-credential','fixture-value','1234567890123456789','fixture-secret']) assert.ok(!text.includes(value));
});

test('默认route自然请求立即continue，429只设置冷却；不进入gate或等待response.finished', async()=>{
 const {EventEmitter}=await import('node:events');
 const {launchWithEgo}=await import('../src/browser.mjs');
 const context=new EventEmitter();let handler, continued=0, cooldown=0, closed=0;
 const page={opener:async()=>null,setDefaultTimeout(){},setDefaultNavigationTimeout(){}};
 context.newPage=async()=>page;context.route=async(_p,fn)=>{handler=fn;};context.unroute=async()=>{};context.close=async()=>{closed++;};
 const gate={run:()=>assert.fail('自然请求不进闸'),cooldown:ms=>{cooldown=ms;}};
 const browser=await launchWithEgo(false,{requestGate:gate,env:{},unlocked:()=>{},executable:()=>{},chromium:{launchPersistentContext:async()=>context}});
 try{
   const req={frame:()=>({page:()=>page,parentFrame:()=>null}),url:()=>SESSION,method:()=> 'GET',resourceType:()=> 'fetch',response:()=>assert.fail('route不等response')};
   await handler({request:()=>req,continue:async()=>{continued++;}});
   context.emit('response',{request:()=>req,url:()=>SESSION,status:()=>429,finished:()=>assert.fail('自然请求不等finished')});
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(continued,1);assert.equal(cooldown,120000);assert.equal(browser.state.httpError,null);
 }finally{await browser.close();}
 assert.equal(closed,1);
});
