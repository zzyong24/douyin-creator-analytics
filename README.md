# 抖音创作者数据采集与复盘

一个在本机运行的抖音创作者中心只读分析工具。使用 Node.js、Playwright 持久化上下文复用 Ego Lite 的登录档，将作品列表和平台 XLSX 导出保存到 SQLite，再生成简体中文 Markdown 复盘报告。macOS 可用 launchd 每 6 小时调度。

仓库只提供程序与合成测试数据，不附带账号登录态、作品数据或验收记录。

## 功能

- 观察管理页主列表，按真实游标分页，按字符串作品 ID 去重并核对总数。
- 通过管理页“导出数据”读取 XLSX，保留原始 16 列、来源时间、匹配依据和未匹配行。
- 按精确 ID，或北京时间发布时间分钟与归一化文案匹配；重复、歧义、数量不足均拒绝完整验收。
- 保存多次指标快照，生成播放、吸粉、完播率排行、率分布、发布月份分组和零播放作品附录。
- 三条样本验收、报告与安装门禁；登录失效、Ego 占用和部分成功有独立退出码。

## 安全边界

程序不执行发布、删除、评论、点赞、关注等平台业务写操作；会写本地数据库、导出、截图、日志和报告。路由按非 GET 请求的写操作关键词拦截，放行静态资源、只读 GET、页面初始化请求和抖音存储桥 iframe。这是已知合同与调用约定构成的防线，不能证明所有未知平台接口都没有副作用。

Cookie 由本机 Ego 登录档维护，不导出 Cookie、storageState 或钥匙串，不上传登录档。请求审计仅保存时间、动作、方法和 host+path，不保存查询串、请求头或请求体。截图、导出及报告仍含账号业务数据，应保留在本机。

Ego 主进程或 SingletonLock 存在时立即停止，绝不强杀 Ego、删除浏览器锁或自动重启它。显式 `login` 是人工登录维护入口，有界面且不启用采集路由；操作者只应完成登录。默认 CLI 不接管已运行的 Ego，也不接受 CDP 模式。

## 快速开始

前置条件：macOS、Node.js ≥ 22.13（需要 `node:sqlite`）、npm、Python 3（标准库解析 XLSX）、已安装 Ego Lite。无需下载 Playwright 浏览器。

在仓库目录执行：

```bash
npm ci
export DOUYIN_EXPECTED_NICKNAME='你的抖音昵称'
export DOUYIN_ANALYTICS_HOME="$PWD"
# 仅在需要人工维护登录时运行；先手动正常退出 Ego
npm run login
npm run collect
```

昵称未设置或为空时，所有连接类命令都会在启动浏览器前拒绝运行。首次采集后还需完成三条样本验收，才能生成正式报告和安装定时任务；详见[连接逻辑](docs/连接逻辑.md#样本验收与报告门禁)。`sample` 包含人工复核步骤，并非无人值守的一键命令。

```bash
export DOUYIN_SAMPLE_EVIDENCE_FILE="$DOUYIN_ANALYTICS_HOME/data/sample-evidence.json"
# 按文档准备本机证据 JSON，再运行并根据状态文件完成中旧样本复核
node src/cli.mjs sample
npm run report
```

环境变量由 shell 或调用方提供，本程序不自动加载 `.env` 文件。换账号建议使用独立的数据根目录，防止混合历史记录或触发已绑定账号约束。

## 配置项

| 环境变量 | 默认 / 含义 |
| --- | --- |
| `DOUYIN_EXPECTED_NICKNAME` | 必填，精确匹配去除首尾空白后的账号昵称 |
| `DOUYIN_ANALYTICS_HOME` | 默认脚本推导的模块根目录；其下建立 `data/`、`logs/`、`reports/`；建议使用绝对真实路径，避免符号链接 |
| `EGO_USER_DATA_DIR` | 默认 `$HOME/Library/Application Support/Citro Labs/ego lite`；指向用户数据根目录，而非其下的 `Default` |
| `EGO_EXECUTABLE` | 默认 `/Applications/ego lite.app/Contents/MacOS/ego lite` |
| `DOUYIN_SAMPLE_EVIDENCE_FILE` | `sample` 必填，本机用户截图转述证据 JSON 路径 |
| `DOUYIN_ANALYTICS_LABEL` | 默认 `com.douyin-analytics`；安装和卸载使用相同值，只允许字母、数字、点和连字符，首字符为字母或数字 |
| `ANALYTICS_NODE_BIN` | 安装 / 定时脚本默认 `command -v node`；可设为绝对 Node 路径，安装时写入 plist |

数据路径始终以运行数据根为基准，源码和模板路径由脚本自身推导，不依赖某个人的电脑目录。`EGO_CDP_URL`、`ANALYTICS_ROUTE_ISOLATION` 是底层历史实验参数，正式 CLI 设置它们会拒绝连接。

## 命令

| 命令 | 行为 |
| --- | --- |
| `npm run login` | 有界面登录 / 身份核对，最多等待 10 分钟，成功后保存身份指纹 |
| `node src/cli.mjs probe` | 无界面核对当前登录与预期账号 |
| `node src/cli.mjs shape` | 输出会话 JSON 键名结构，不输出会话值 |
| `npm run collect` | 列表分页、新下载导出、匹配、入库 |
| `node src/cli.mjs collect --reuse-export data/exports/run-N-T.xlsx` | 在线读取列表并显式复用已有导出，需匹配 manifest；不是离线命令 |
| `node src/cli.mjs import-export N data/exports/run-N-T.xlsx` | 离线重新匹配已有 run，保留原始列表与导入历史 |
| `node src/cli.mjs sample` | 从外部证据指定新样本，再复核中旧样本，成功写验收记录 |
| `npm run report` | 离线生成 `reports/复盘-YYYYMMDD.md`，日期为北京时间；同日重跑覆盖同名报告 |
| `node src/cli.mjs report --output reports/自定义.md` | 报告只能写入数据根的 `reports/` 下，扩展名须为 `.md` |
| `node src/cli.mjs verify-install` | 仅本机检查最新完整数据、验收记录和本轮报告文件 |
| `npm test` / `npm run validate` | 合成单测 / 单测加源码、Shell、plist 语法检查，不启动浏览器 |

`import-export` 不会把原本的 `partial` 自动提升成 `success`，修正导出后仍需完整采集通过，不能手工改运行状态绕过门禁。

## 退出码

| 码 | 含义与应对 |
| --- | --- |
| 0 | 命令成功；定时 wrapper 的 Ego 忙锁也会记录跳过后返回 0 |
| 1 | 配置、身份不符、锁检测、验证码、网络、接口变化或其他失败；根据固定错误码处理 |
| 2 | `partial` / 导出匹配不足 / 报告或样本或安装门禁不满足；保留数据，检查证据，不冒充完整成功 |
| 3 | `needs_login` / `NEEDS_LOGIN` / 登录超时；停止自动重试，交人工登录 |
| 4 | `EGO_PROFILE_LOCKED`；等待用户正常退出 Ego，下一轮再试 |
| 130 / 143 | SIGINT / SIGTERM 终止，尽力关闭本次上下文并释放模块锁 |

## 定时任务

先完成 `collect → sample → report`，保持配置变量已导出，再执行：

```bash
bash launchd/install.sh
# 自定义 label 安装后，卸载时也需设置相同值
bash launchd/uninstall.sh
```

安装器从 `launchd/com.example.douyin-analytics.plist.template` 生成真实 plist，安装到 `~/Library/LaunchAgents/<label>.plist` 并注册。它把当前昵称、数据根、Ego 路径和 Node 路径写入任务环境；配置变化后需卸载重装。已有文件或同名任务会拒绝覆盖。

每 21600 秒运行一次，`RunAtLoad=false`，安装不立即采集。仅 `collect` 成功后才生成报告；退出 4 时跳过本轮，不生成报告、不重启 Ego，其他错误保持失败。Mac 睡眠时不保证准点，也不补采每个错过的时间点。卸载保留本机数据库、登录档、导出和报告。

## 目录结构

```text
src/         CLI、连接与路由、分页、导出匹配、SQLite、验收与报告
launchd/     plist 模板、渲染器、安装/卸载/调度脚本
tests/      合成数据与离线测试
docs/       连接细节和其他 Agent 接入指南
data/       运行时数据库、身份指纹、验收记录、exports/（忽略）
logs/       运行时诊断、请求审计、截图和抽检状态文件（忽略）
reports/    本地复盘报告（忽略）
```

深入阅读：[连接逻辑](docs/连接逻辑.md)、[接入方案：其他 Agent](docs/接入方案-其他Agent.md)、[通用设计](方案.md)。当前只提供统计与复盘，不包含预测模型。许可为 [MIT](LICENSE)。
