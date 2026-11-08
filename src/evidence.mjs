export function displayRange(raw){
 const text=String(raw??'').trim().replaceAll(',','');
 if(!text||/^[-—]+$/.test(text))return null;
 const m=text.match(/^(\d+(?:\.\d+)?)(万|亿)?$/);if(!m)return null;
 const scale=m[2]==='万'?10000:m[2]==='亿'?100000000:1,n=Number(m[1])*scale;
 if(!m[2])return {low:n,high:n,exact:true,rule:'界面完整整数，精确比较'};
 const digits=m[1].split('.')[1]?.length??0,step=scale*10**-digits;
 return {low:Math.max(0,n-step/2),high:n+step,exact:false,rule:'界面未声明截断/四舍五入，取两种规则并集；上界不含'};
}
export function compareDisplay(raw,value){const range=displayRange(raw);return {raw,db:value,range,pass:value!==null&&range!==null&&(range.exact?value===range.low:value>=range.low&&value<range.high)};}
export function comparePercent(raw,value){
 const m=String(raw).trim().match(/^(\d+(?:\.\d+)?)%$/);if(!m||value==null)return {raw,db:value,range:null,pass:false};
 const decimals=m[1].split('.')[1]?.length??0,center=Number(m[1])/100,half=10**-decimals/200;
 return {raw,db:value,range:{low:center-half,high:center+half,exact:false,rule:'百分数按所显示小数位四舍五入；上界不含'},pass:value>=center-half-1e-12&&value<center+half};
}
