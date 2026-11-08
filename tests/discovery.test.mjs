import test from 'node:test';
import assert from 'node:assert/strict';
import {responseShape,safeEndpoint,catalogArrays} from '../src/discover.mjs';
test('自然响应诊断只记录两层键名和数组长度，动态ID键脱敏',()=>{
 const json={status_code:0,data:{items:[{aweme_id:'1234567890123456789',title:'合成业务值'}],total:123},'1234567890123456789':{secret:'合成凭据'}};
 const meta=responseShape(json),text=JSON.stringify(meta);
 for(const value of ['1234567890123456789','合成业务值','合成凭据','123'])assert.ok(!text.includes(value));
 assert.ok(meta.keys.includes('data.items'));assert.ok(meta.keys.includes('[动态键已脱敏]'));
 assert.deepEqual(meta.arrays,[{path:'data.items',length:1}]);
 assert.deepEqual(safeEndpoint('https://creator.douyin.com/api/1234567890123456789?token=合成值'),{host:'creator.douyin.com',path:'/api/[动态片段已脱敏]'});
});
test('目录发现只在内存识别明确作品ID数组，不误识别普通业务数组',()=>{
 assert.equal(catalogArrays({data:{aweme_list:[{aweme_id:'1234567890123456789'}]}})[0].path,'data.aweme_list');
 assert.deepEqual(catalogArrays({data:{items:[{id:'123'}]}}),[]);
});
test('已观测Janus列表精确匹配，合成游标与标题字段解析',async()=>{
 const {isList}=await import('../src/browser.mjs');
 const {parseList,pageCount}=await import('../src/parse.mjs');
 assert.equal(isList(new URL('https://creator.douyin.com/janus/douyin/creator/pc/work_list')),true);
 assert.equal(isList(new URL('https://creator.douyin.com/janus/douyin/creator/pc/work_list_extra')),false);
 const parsed=parseList({aweme_list:[{aweme_id:'1111111111111111111',item_title:'合成标题'}],total:1,has_more:0,max_cursor:'合成游标',min_cursor:'合成游标二'});
 assert.equal(parsed.works[0].title,'合成标题');assert.equal(parsed.maxCursor,'合成游标');assert.equal(parsed.minCursor,'合成游标二');
 assert.equal(pageCount('内容管理\n作品 (246)\n作品合集 (6)'),246);
});
