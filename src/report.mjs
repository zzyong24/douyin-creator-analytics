import {richReport} from './report-analysis.mjs';
import {readJson,ROOT} from './runtime.mjs';
import {join} from 'node:path';
import { CORE } from './parse.mjs';
import { latestRows, previousSnapshot } from './store.mjs';
export const shanghaiDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replaceAll('-', '');
const cell = value => String(value ?? '—').replaceAll('|', '／').replace(/[\r\n]+/g, ' ');
const fmt = value => value == null ? '—' : Number(value.toFixed(4)).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
const labels = { plays: '播放', finish_rate: '完播率（原口径）', avg_play_duration_sec: '平均播放秒数', likes: '点赞', comments: '评论', shares: '分享', favorites: '收藏', follower_gain: '涨粉' };
function table(rows) {
  return ['| 作品 | 播放 | 完播率原值 | 平均时长秒 | 点赞 | 评论 | 分享 | 收藏 | 涨粉 | 采集时间 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |', ...rows.map(r => `| ${cell(r.title)}（${r.aweme_id}） | ${CORE.map(k => fmt(r[k])).join(' | ')} | ${r.collected_at} |`)].join('\n');
}
function insights(rows,ranked) {
  const sum=ranked.reduce((n,r)=>n+r.plays,0),sorted=ranked.map(r=>r.plays).sort((a,b)=>a-b);
  if(!ranked.length)return ['## 实际观察','','暂无可形成洞察的播放数据。'];
  const median=sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
  const top=ranked[0],top10=ranked.slice(0,10).reduce((n,r)=>n+r.plays,0);
  const likes=rows.some(r=>r.likes!==null)?rows.filter(r=>r.likes!==null).reduce((n,r)=>n+r.likes,0):null,comments=rows.some(r=>r.comments!==null)?rows.filter(r=>r.comments!==null).reduce((n,r)=>n+r.comments,0):null;
  return ['## 实际观察','',
    `1. 有播放来源${ranked.length}/${rows.length}件，播放中位数${fmt(median)}；各作品发布龄期不同，不能据此推断近期增长。`,
    `2. 播放最高作品为“${cell(top.title)}”（${top.aweme_id}），${fmt(top.plays)}；前10件占已知播放的${sum?fmt(top10/sum*100):'—'}%。`,
    `3. 已知点赞合计${fmt(likes)}、评论合计${fmt(comments)}；覆盖分别为${rows.filter(r=>r.likes!==null).length}/${rows.length}和${rows.filter(r=>r.comments!==null).length}/${rows.length}，不将缺失记0。`,
    `4. 完播率覆盖${rows.filter(r=>r.finish_rate!==null).length}/${rows.length}，平均播放时长覆盖${rows.filter(r=>r.avg_play_duration_sec!==null).length}/${rows.length}；有值时以导出明确表头与单位为来源；平均播放占比独立保存，不作为完播率。`,
    '5. 仅有首轮或历史可比快照不足时，不作增长结论或预测；下方变化表仅比较同口径的实测快照。'];
}
export function buildReport(db, now = new Date()) {
  const run = db.prepare('SELECT * FROM collect_runs ORDER BY id DESC LIMIT 1').get();
  const rows = latestRows(db), ranked = rows.filter(r => r.plays !== null);
  const lines = [`# 抖音自号复盘 ${shanghaiDate(now)}`, '', `生成时间：${now.toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai',hour12:false})}（Asia/Shanghai）。`, '', '## 全量概览', '',
    `- 最近运行：${run?.id ?? '无'}；状态：${run?.status ?? '尚未采集'}；完成时间：${run?.finished_at ?? '—'}。`,
    `- 页面显示作品数：${run?.page_work_count ?? '未知'}；接口总数：${run?.api_work_count ?? '未知'}；本轮采集：${run?.collected_count ?? 0}；本轮基础列表指标完整：${run?.list_metric_count ?? 0}；详情成功数（历史字段）：${run?.detail_count ?? 0}。`,
    `- 本地累计作品：${rows.length}；本地最新快照中已知播放合计：${ranked.length?fmt(ranked.reduce((n, r) => n + r.plays, 0)):'—'}（播放有值 ${ranked.length}/${rows.length}）。`,
    `- 最近运行错误码：${run?.error_code ?? '无'}。`, '',
    '一期主目录用于作品完整性与原始计数审计；统一指标以非空导出值优先（包括真实0），导出缺值时才保留已确认列表来源；NULL不补0。完播率、吸粉量等可来自内容管理页导出；原始列、单位与周期见扩展字段，未知单位不作换算。\n\n一期以列表核目录、导出补指标。本报告只描述已采到的数据。未登录、partial、失败或目录数量不一致时，不能视为全量验收。排名使用每件作品最近一次快照，可能混有历史数据；采集时间逐行列出。率字段保留来源数值，显式百分号已转小数，数字值的比例单位需在后台核对。', '', '| 核心指标 | 有值作品/本地作品 |', '| --- | ---: |',
    ...CORE.map(k => `| ${labels[k]} | ${rows.filter(r => r[k] !== null).length}/${rows.length} |`), '', ...insights(rows,ranked), '', '## TOP10（播放量）', '', ranked.length ? table(ranked.slice(0, 10)) : '尚无可排名的播放数据。', '', '## 底部10（播放量，从低到高）', '', ranked.length ? table([...ranked].reverse().slice(0, 10)) : '尚无可排名的播放数据。', '', '## 与上一次快照的近期变化', '',
    '每件作品与自身紧邻的上一条快照比较，间隔按实测时间计算。不同时间窗/累计口径不能直接比较；负数照实保留，可能来自平台修正。', '', '| 作品 | 间隔小时 | 播放变化 | 点赞变化 | 评论变化 | 分享变化 | 收藏变化 | 涨粉变化 | 当前快照 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  let comparisons = 0;
  const changes = rows.filter(r => r.run_id === run?.id).map(r => ({ row: r, prev: previousSnapshot(db, r) })).filter(x => x.prev);
  changes.sort((a, b) => ((b.row.plays ?? b.prev.plays ?? 0) - (b.prev.plays ?? b.row.plays ?? 0)) - ((a.row.plays ?? a.prev.plays ?? 0) - (a.prev.plays ?? a.row.plays ?? 0)));
  for (const { row, prev } of changes) {
    const a = JSON.parse(row.raw_json), b = JSON.parse(prev.raw_json);
    // 不跨来源口径计算伪增长；实际接口时间窗原样记录在 scope。
    const ae=JSON.parse(row.extensions_json??'null')?.source,be=JSON.parse(prev.extensions_json??'null')?.source;
    const sameSource=ae&&be&&ae.sha256===be.sha256&&ae.source_observed_at===be.source_observed_at;
    const comparable = !sameSource && ae?.period_verified===true && be?.period_verified===true && ae.period===be.period && ae.source_observed_at!==be.source_observed_at || !ae&&!be&&a.scope?.period_verified===true&&b.scope?.period_verified===true&&JSON.stringify(a.scope)===JSON.stringify(b.scope);
    const noCompare=sameSource?'同一导出取数时刻重复导入，未比较':'统计周期/可比来源未核实，未比较';
    const delta = ['plays', 'likes', 'comments', 'shares', 'favorites', 'follower_gain'].map(k => comparable && row[k] !== null && prev[k] !== null ? fmt(row[k] - prev[k]) : '—');
    lines.push(`| ${cell(row.title)}（${row.aweme_id}） | ${fmt((Date.parse(row.collected_at) - Date.parse(prev.collected_at)) / 3600000)} | ${delta.join(' | ')} | ${row.collected_at}${comparable ? '' : '（'+noCompare+'）'} |`);
    comparisons++;
  }
  if (!comparisons) lines.push('', '尚无同一作品的两次快照，无法计算近期变化。');
  const exported=db.prepare('SELECT * FROM export_files WHERE run_id=?').get(run?.id??-1);
  lines.push('','## 内容管理页导出来源与覆盖','');
  if(exported){
   const meta=JSON.parse(exported.metadata_json),summary=JSON.parse(exported.summary_json),c=summary.counts;
   lines.push(`- 本机原文件：${meta.path}；SHA256：${meta.sha256}；原始取数时间：${meta.source_observed_at??meta.downloaded_at??'未知'}；导入时间：${meta.imported_at??'未知'}；复用旧文件：${meta.reused?'是':'否'}。`,
    `- 作品范围：${meta.work_scope}；统计周期：${meta.period}；来源：${meta.source?JSON.stringify(meta.source):'测试合成来源'}。`,
    `- 成功匹配导出行：${c.acceptedRows}/${c.totalRows}；匹配作品：${c.matchedWorks}/${c.catalogWorks}；重复${c.duplicates}、歧义${c.ambiguous}、未匹配${c.unmatched}。`,
    `- 全部表头：${summary.fields.map(cell).join('、')}。`,'','| 扩展指标 | 有值作品/本轮作品 |','| --- | ---: |');
   const metrics={};for(const row of rows.filter(r=>r.run_id===run.id))for(const [key,v] of Object.entries(JSON.parse(row.extensions_json??'null')?.metrics??{}))if(v.value!==null)metrics[key]=(metrics[key]??0)+1;
   for(const [key,n]of Object.entries(metrics))lines.push(`| ${key} | ${n}/${run.collected_count} |`);
   lines.push('','吸粉量使用导出同名字段，不是作者粉丝总数；平均播放占比与完播率分开。所有未知列保留原表头与原值，NULL不补0。');
  }else lines.push('本轮无已保存导出，不能声称导出指标完整覆盖。');
  lines.push('',`本轮警告：${run?.warnings_json??'[]'}。`);
  const currentRows=rows.filter(r=>r.run_id===run?.id);lines.push(...richReport(currentRows));
  const approval=readJson(join(ROOT,'data/acceptance.json'));
  if(approval&&run&&approval.runId===run.id){lines.push('','## 三条验收证据来源','',...approval.checks.map(c=>`- ${c.kind}／${c.aweme_id}：${c.source_type}，${c.source}，证据时间${c.source_time}；${c.reference_path??c.screenshot}。`),'新样本来自用户提供截图转述，无原图文件；平均播放占比仅作为证据上下文，不能代替完播率。中旧来自本轮网页截图。');}
  return lines.join('\n') + '\n';
}
