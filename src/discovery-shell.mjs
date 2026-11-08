import process from 'node:process';
import {createInterface} from 'node:readline';
import {Discovery} from './discover.mjs';
import {installSignalCleanup} from './runtime.mjs';
process.umask(0o077);
const removeSignals=installSignalCleanup(),d=new Discovery();
const input=createInterface({input:process.stdin,terminal:false});
let finished=false;
const show=meta=>console.log(JSON.stringify(meta.filter(r=>r.host==='creator.douyin.com')));
console.log('只读发现控制已就绪：开始、翻页、合同、入口、详情、结束。所有响应原文仅在内存。');
try{
 for await(const raw of input){
  const command=raw.trim();
  if(command==='开始'){show(await d.start());}
  else if(command==='开始详情'){show(await d.start({analysisOnly:true}));}
  else if(command==='翻页'){show(await d.paginate());}
  else if(command==='合同'){console.log(JSON.stringify(d.contracts()));}
  else if(command==='入口'){console.log(JSON.stringify(await d.detailEntry()));}
  else if(command==='详情'){console.log(JSON.stringify(await d.openDetail()));}
  else if(command==='结束'){finished=true;break;}
  else{console.log('仅接受固定只读发现命令。');continue;}
  console.log('当前分段已结束，等待下一条固定只读命令。');
 }
}catch(e){console.log('只读发现停止：'+(e.code??'DISCOVERY_FAILED'));process.exitCode=e.exitCode??1;}
finally{input.close();await d.close();removeSignals();if(!finished&&!process.exitCode)process.exitCode=1;}
