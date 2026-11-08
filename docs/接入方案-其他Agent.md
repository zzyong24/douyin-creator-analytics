# 其他 Agent 接入指南

适用于 Codex、Claude、桌面 Bot 和定时分析程序。集成应把本项目作为“受控采集命令 + 本机只读数据库 + Markdown 报告”使用，不需要读取浏览器 Cookie，也不需要自行构造带签名的平台请求。

## 前置条件与安装

运行采集需要 macOS、Node.js ≥ 22.13、npm、Python 3、Ego Lite，以及用户拥有并授权读取的抖音创作者中心账号。确认用户授权采集范围，且没有其他命令占用同一数据根。浏览器已有登录可复用，但执行前应由用户正常退出 Ego；程序不强制退出它。

在当前仓库目录安装：

```bash
npm ci
npm test
```

测试使用合成数据和模拟浏览器对象，不启动 Ego。Python 只用标准库，不需要 pip 安装。仅分析既有 SQLite 时不需要启动浏览器，读取方也无需调用采集程序的数据库初始化函数。

## 调用配置

调用方每次明确传环境变量，避免依赖交互式 shell 或 `.env` 自动加载：

```bash
export DOUYIN_ANALYTICS_HOME="$PWD"
export DOUYIN_EXPECTED_NICKNAME='用户指定的账号昵称'
# 路径与默认安装位置不同时配置
# export EGO_USER_DATA_DIR="$HOME/自定义登录档根目录"
# export EGO_EXECUTABLE='/自定义应用目录/ego lite'
# export ANALYTICS_NODE_BIN='/Node安装目录/bin/node'
export DOUYIN_ANALYTICS_LABEL='com.douyin-analytics'
```

默认用户数据根从系统 home 推导，`Default` profile 固定由程序附加；不要把 `EGO_USER_DATA_DIR` 指到 Default 子目录。模块位置从脚本推导，数据根可位于另一个可写真实目录。使用绝对路径并避免符号链接。每个账号使用独立数据根和定时 label。

昵称为必填，缺失时连接类命令拒绝运行，不能关闭一致性检查。若已有 `data/account.json`，还需匹配稳定账号标识的哈希；不要为了让命令通过而改写或删除身份约束。用户确需切换账号时，先确认身份，再使用新的数据根。

## CLI 调用约定

以仓库为工作目录，用参数数组启动进程，不拼接未经转义的 shell 文本。推荐限制同一数据根最多一个 CLI 进程，并采集标准输出、标准错误与退出码。日志可能包含业务作品信息和本机路径，不应自动向公共频道回传。

| 调用 | 是否连接浏览器 | 结果 |
| --- | --- | --- |
| `node src/cli.mjs login` | 是，有界面 | 人工登录并核对账号，最多 10 分钟 |
| `node src/cli.mjs probe` | 是，无界面 | 核对登录与预期账号 |
| `node src/cli.mjs shape` | 是，无界面 | 会话键名诊断，不输出值，不作为身份验证替代 |
| `node src/cli.mjs collect` | 是，无界面 | 列表分页、新下载 XLSX、对账入库；输出一行 `采集结果：<JSON>` |
| `node src/cli.mjs collect --reuse-export data/exports/run-N-T.xlsx` | 是，无界面 | 显式复用旧导出，仍读取在线列表；不代表新下载 |
| `node src/cli.mjs import-export N data/exports/run-N-T.xlsx` | 否 | 按既有快照重新匹配本机文件，需原 manifest 与哈希；保留导入历史 |
| `node src/cli.mjs sample` | 是，无界面 | 外部证据 + 中旧样本人工复核，保存验收基线 |
| `node src/cli.mjs report` | 否 | 生成数据根 `reports/复盘-YYYYMMDD.md` |
| `node src/cli.mjs report --output reports/复盘-自定义.md` | 否 | 指定数据根 reports 内 `.md` 路径 |
| `node src/cli.mjs verify-install` | 否 | 检查最新完整数据、本轮验收和报告 |

采集结果 JSON 的重要字段包括 `runId/status/collected/pageCount/apiCount/basicCount/warnings/exportSummary/error/exitCode`。API schema 变化、页面总数无法确认或导出不唯一时，不要解析日志中的局部数字宣称成功。退出码是主判据，再结合 status 和 error；普通 CLI 提示文本不是稳定 JSON API。

不要自行调用 `src/discovery-shell.mjs` 扩大默认采集范围。该文件是人工接口发现工具，会连接浏览器；默认 collect 不进入详情页。

## 退出码及应对

| 退出码 | 常见状态 / 错误 | Agent 应做什么 |
| --- | --- | --- |
| 0 | success | 可继续生成或读取报告；仍需看 warnings 和来源周期 |
| 1 | failed、EXPECTED_NICKNAME_REQUIRED、ACCOUNT_MISMATCH、COMMAND_LOCKED、CAPTCHA、HTTP_403 等 | 缺配置先补配置；错号交用户核对；锁冲突等待；验证码 / 403 / 合同变化停止在线重试并报告原因 |
| 2 | partial、EXPORT_INCOMPLETE_MATCH、SAMPLE_NOT_APPROVED、REPORT_REQUIRES_COMPLETE_DATA、REPORT_REQUIRES_SAMPLES、INSTALL_REQUIRES_CURRENT_APPROVAL | 数据不完整或证据不足；读取本机差异与来源排查，不改 approved、不改状态、不将缺失补零 |
| 3 | needs_login、NEEDS_LOGIN、LOGIN_TIMEOUT | 暂停自动采集，通知操作者正常退出 Ego 后显式运行 login；人工登录成功后再试 |
| 4 | EGO_PROFILE_LOCKED | Ego 正在使用或浏览器锁存在；延后运行，绝不杀进程、删锁或改用另一登录档绕过 |
| 130 / 143 | 收到 SIGINT / SIGTERM | 本次被终止，不当作成功；检查 run 状态后再决定是否重试 |

429 已有持久冷却与有限指数退避，外层 Agent 不应立即循环重试叠加压力。状态为 running 可能表示进程仍在工作或异常中断，应先核对进程；不要直接修改数据库。

定时 wrapper 有一个特例：collect 退出 4 时日志明确写“跳过”，wrapper 返回 0，且不生成报告。所以监控定时任务还应核对最新成功 run 的完成时间，不能只看 launchd 最近退出码。

## SQLite 只读接入

数据库位置为 `<DOUYIN_ANALYTICS_HOME>/data/douyin.sqlite`。读取时使用 SQLite 只读模式，允许正常 WAL 读取；不要在活跃数据库上使用可能忽略 WAL 的 immutable 快捷方式，也不要只复制主文件而漏掉 WAL。备份应使用 SQLite 一致性备份机制。

```bash
sqlite3 -readonly "$DOUYIN_ANALYTICS_HOME/data/douyin.sqlite"
```

Node 读取示例（只打开既有数据库）：

```js
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
const db = new DatabaseSync(join(process.env.DOUYIN_ANALYTICS_HOME, 'data/douyin.sqlite'), {readOnly: true});
db.exec('PRAGMA query_only=ON');
try {
  const run = db.prepare('SELECT * FROM collect_runs ORDER BY id DESC LIMIT 1').get();
  console.log(run);
} finally {
  db.close();
}
```

不要使用项目的 `openDb()` 做外部只读分析，它会执行建表与兼容迁移。外部读者也不要写入 works 或快照表。先检查最新运行，再决定分析“最近一轮”还是“最近成功一轮”，并在输出标明所选 run，避免无提示地回退旧结果。

| 表 | 主键 / 字段 |
| --- | --- |
| works | aweme_id（TEXT）；title、description、published_at、duration_sec、cover_url、work_type、visibility；topic_id、works_dir 可选映射；first_seen_at、last_seen_at |
| collect_runs | id；started_at、finished_at、status；page_work_count、api_work_count、collected_count、detail_count、list_metric_count；error_code、warnings_json |
| metric_snapshots | id，run_id、aweme_id（联合唯一）；collected_at；plays、finish_rate、avg_play_duration_sec、likes、comments、shares、favorites、follower_gain、finish_5s_rate、bounce_2s_rate、cover_ctr、profile_visits；raw_json、extensions_json |
| export_files | run_id；metadata_json（本机文件、SHA-256、源时间、导入时间、范围、周期等）、summary_json（counts / fields） |
| export_rows | id；run_id、可空 aweme_id、status、row_json（原始 cells、候选、原因、匹配依据、指标来源） |
| export_import_history | id；run_id、imported_at、previous_json（上次导出与逐行记录） |

NULL 是未知，0 是实际测量零；率为 0–1，已确认时长为秒；不要把 NULL 换成 0 再做覆盖率或排行。所有作品 ID 保持字符串。`extensions_json` 的 `cells` 保留原表头与值，`selected_sources` 给出每项最终指标的来源与时间，`list_values` 保存原列表基线。字段、约束及索引的完整说明见[连接逻辑](连接逻辑.md#sqlite-表结构)。

## 示例 SQL

下面三个例子都明确选择最近的完整成功 run。若最新一次失败而例子回退到旧成功 run，报告必须同时披露最新失败状态与选用数据的时间。

播放 Top10：

```sql
WITH chosen AS (
  SELECT id FROM collect_runs WHERE status='success' ORDER BY id DESC LIMIT 1
)
SELECT s.run_id, w.aweme_id, w.title, w.published_at,
       s.plays, s.likes, s.comments, s.collected_at
FROM metric_snapshots s JOIN works w USING(aweme_id)
WHERE s.run_id=(SELECT id FROM chosen) AND s.plays IS NOT NULL
ORDER BY s.plays DESC, w.aweme_id LIMIT 10;
```

吸粉排行（follower_gain 是作品粉丝增量，不是账号总粉丝）：

```sql
SELECT s.run_id, w.aweme_id, w.title, s.follower_gain, s.plays,
       CASE WHEN s.plays>0 THEN 1000.0*s.follower_gain/s.plays END AS followers_per_1000_plays
FROM metric_snapshots s JOIN works w USING(aweme_id)
WHERE s.run_id=(SELECT id FROM collect_runs WHERE status='success' ORDER BY id DESC LIMIT 1)
  AND s.follower_gain IS NOT NULL
ORDER BY s.follower_gain DESC, w.aweme_id LIMIT 10;
```

按发布月份汇总当前快照（北京时间，不能称为逐月历史增长）：

```sql
SELECT strftime('%Y-%m', w.published_at, '+8 hours') AS publish_month_beijing,
       count(*) AS work_count,
       count(s.plays) AS known_plays_count,
       sum(s.plays) AS current_plays_sum,
       count(s.follower_gain) AS known_followers_count,
       sum(s.follower_gain) AS current_followers_sum
FROM works w JOIN metric_snapshots s USING(aweme_id)
WHERE s.run_id=(SELECT id FROM collect_runs WHERE status='success' ORDER BY id DESC LIMIT 1)
GROUP BY publish_month_beijing ORDER BY publish_month_beijing;
```

检查最近运行与导出覆盖：

```sql
SELECT id, status, started_at, finished_at, page_work_count, api_work_count,
       collected_count, list_metric_count, error_code, warnings_json
FROM collect_runs ORDER BY id DESC LIMIT 5;
SELECT run_id,
       json_extract(summary_json,'$.counts.totalRows') AS total_rows,
       json_extract(summary_json,'$.counts.matchedWorks') AS matched_works,
       json_extract(metadata_json,'$.source_observed_at') AS source_time,
       json_extract(metadata_json,'$.period') AS period
FROM export_files ORDER BY run_id DESC LIMIT 5;
```

## 验收与复盘报告

首次完整流程是 collect → sample → report。sample 读取 `DOUYIN_SAMPLE_EVIDENCE_FILE` 指向的本机 JSON，新样本使用调用者有来源的截图转述，中旧样本用实时管理页截图与定位证明。格式和文件控制动作见[样本验收协议](连接逻辑.md#样本验收与报告门禁)。不要用仓库的合成测试数据验收真实账号，不要为了消除误差挑选“数字吻合”的作品。

sample 写 `data/acceptance.json` 后，report 离线检查最新完整数据与有效验收，再写 Markdown。中旧需人工或被授权的页面复核；无人值守 Agent 不应直接构造通过记录。后续定时报告允许引用仍有效的历史验收基线，不声称每次都重新截图。安装另需本轮验收与本轮报告。

成功后读取命令输出的报告路径，并验证文件确为本次生成；默认文件名使用北京时间日期，同日会覆盖，可用 `--output reports/自定义.md` 保留多个版本。报告包含实际来源和未知项，仍可能包含本机路径、作品标题、ID 与指标，不能默认发布到外部。只读集成可以直接读取已经生成的 `.md`，不需要启动 collect。

排行和月份分组只能解释当前快照；有两个快照也不自动说明可比较。统计周期未确认、来源时刻相同或重复复用导出时不得宣称增长或预测。统一秒数为空时，必须读取原始单位证据，不猜秒。

## 定时安装、卸载与登录失效

完成本轮采集、样本和报告后，可由用户授权安装：

```bash
bash launchd/install.sh
# 卸载时使用安装时相同的 DOUYIN_ANALYTICS_LABEL
bash launchd/uninstall.sh
```

模板生成真实 plist 并安装到用户 LaunchAgents，每 6 小时，RunAtLoad=false。任务环境保存安装时的配置，终端后续 export 不会自动改变它；改变路径或账号需要卸载重装。卸载不删除数据或 Ego 登录档。

登录失效时停止后台快速重试，让用户在正常关闭 Ego 后运行显式 login 完成扫码 / 验证。Agent 不应读取或回传二维码授权信息、Cookie、storageState、钥匙串，也不代替用户绕过验证码。成功核对后再按用户原授权范围采集；如果只是 Ego 正在使用，等待下一轮即可。

## 只读协作规则

- 平台只读：只使用受控命令，不执行发布、删除、互动、改资料、登出等操作，不自行调用未知接口。
- 本地写入仅由项目命令完成采集、验收和报告；外部分析连接 SQLite 必须只读，不改状态、身份绑定、指标或 approved。
- 不强杀 Ego、不删除 SingletonLock、不切换 CDP 或登录档规避占用，不并发复用同一数据根。
- 日志只保留脱敏元数据；运行数据、截图、XLSX、数据库、Cookie 和真实 plist 都不能提交公开仓库。
- 缺失保持未知，部分失败明确标注；无来源、时间或唯一归属的结果不能冒充成功。
