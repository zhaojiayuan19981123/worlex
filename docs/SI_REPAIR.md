# SI 征稿修复与接入说明

## v2.2.4 官网核验与查询修复（2026-11-23）

本节记录 v2.2.4 的官网来源核验、征稿解析和 ABS 查询修复。桌面安装包由仓库的标签发布工作流构建，可用平台及构建完成状态以 v2.2.4 GitHub Release 的实际附件为准。下文既有版本和验证记录保留为历史记录。

### 官网入口与抓取规则

- 新增 `scripts/audit-si-sources.mjs`、`src/specialIssueSourcePolicy.js` 和 `src/specialIssueSourceAudit.json`。166 本目录均有独立来源状态及候选主页；候选地址本身不是官网身份或征稿存在的证据。按期刊名拼接的地址、普通出版社品牌页和未核实聚合页不再成为默认征稿源。
- 当前快照：74 本因 robots 禁止、robots 请求受限或无法安全核实而未自动访问；69 本官网访问受限；21 本仅主页身份确认；1 本仍未确认；1 本确认到当前征稿专题入口（JIBS）。以上合计 166 本，不能解读为已核实 166 个可用征稿入口。T&F 官方公开 JSON 另作为已核实聚合源覆盖其目录期刊。
- Journal of Interactive Marketing 的 AMA 官方主页当前指向 Sage；主页中的 Special Issues 链接是 `/toc/` 已出版专刊。用户提供的 ScienceDirect 地址没有被当作已核实的当前征稿入口，也没有把已出版专刊导入为在征 SI。出版方修正为 Sage。
- 核对 POMS、Wiley 和 JITM 官方资料后，修正 POM 为 Sage、JOM 为 Wiley、JITM 为 Association of Management，并更新候选主页。JITM 原站明确迁至 `home.thejitm.org`；新站在本次环境仍受访问限制。POMS 的征稿链接返回 404，故只记录主页确认，不认定征稿入口可用。
- JBE 的 `https://link.springer.com/collections/hicgjgfhjd` 明确写有 “Closed for submissions”；快照保留关闭证据，移出已确认可投稿入口。同步时给出关闭诊断，不导入该专题。
- Springer `/collections/` 主通知与相关论文链接分别处理，只提取主征稿，并读取侧栏 `submission-deadline`；不把文章标题误作独立征稿。过滤 Sage `/toc/`、`/loi/` 和明确关闭的专题。
- 主页发现会保留所有符合条件的同源、同刊征稿链接，逐个请求、验证和记录诊断；不再静默限制前三个。166 本订阅均进入任务或明确的不可抓取诊断，不再截断第 120 个之后的任务。
- T&F 公开接口经 HTTP 200 和字段结构复验，使用每页 100 条，遵守已记录的 10 秒访问间隔。本次 6 页可在默认 90 秒预算内完成；仍保留分页上限、超时和部分结果警告。JSON 响应直接走结构化解析，不送入 HTML 验证页解析器。

### ABS 标注的实际完成范围

每本目录固定展示 ABS 状态：已有返回等级、查询未返回 ABS、待查询。ABS 在 SI 卡片中优先显示，不因其他三类排名占位而隐藏。支持筛选当前组查询、全目录每批 20 本查询、七天缓存、最大每批 40 本、查询中切换视图后的状态恢复；显式空列表不会意外查询整个目录。失败项不会在同一轮无限重试。

等级取自用户配置的 easyScholar，不把测试值写入真实目录。本次没有使用可用的真实密钥，也没有取得可逐条核验的正式 AJG 等级数据；**166 本的真实 ABS 数值尚未补齐，零条数值等级在本次验证中获得独立核实**。AJG 2024 官方介绍页在本环境返回 403。第三方响应的榜单年份也需要核对，不能未经证据统一标成 AJG 2024。没有 ABS 返回不等于未收录，当前目录也不宣称是官方认证的完整 ABS 名单。

### 最终验证（北京时间）

- Node.js 20.19.0：全套 `node --test --test-reporter=spec`，880 项通过，0 失败、0 跳过。新增覆盖官方来源证据、robots 规则、全目录覆盖、全部入口发现、Springer 主通知及侧栏日期、关闭通知、ABS 分批及缓存边界。
- Edge 无头浏览器：166 行 ABS 状态、ABS 优先显示、筛选查询、全目录分批、缓存复用、查询期间关闭和重开、真实应用导航通过；390/768/1365 宽度下五个 SI 标签页无横向溢出，页面脚本错误为 0。等级接口使用明确标记的模拟数据，截图中的模拟等级不是真实排名；完整应用截图未填入模拟等级。
- 最终源码真实联网同步于 2026-11-23 02:33:03 开始，耗时 52.596 秒，采用默认 90 秒预算、默认详情上限和已核实访问间隔，使用隔离数据。T&F 与 JIBS 两个来源成功，共 5 条未截止 SI，0 分页警告；JBE 关闭专题作为一条明确诊断排除。六本订阅中四本有返回，不能说六本都有征稿。

| 期刊 | 主通知标题 | 截止日 |
| --- | --- | --- |
| Journal of International Business Studies | Special Issue on Microfoundations of International Business | 2026-11-30 |
| Current Issues in Tourism | A Decade (2015-2025) of the Sustainable Development Goals (SDGs): Trends, Reflections, and Realignments in Hospitality and Tourism Research | 2026-12-01 |
| Current Issues in Tourism | Tourism and the 2026 Middle East Crisis: International and Regional Implications | 2026-12-31 |
| Asia Pacific Journal of Tourism Research | Walking and Working with AI: AI-Enabled Tourism Research and Practices | 2027-04-30 |
| Journal of Sustainable Tourism | Sustainable Luxury Tourism: Opportunities, Tensions, and Impacts | 2027-05-31 |

标题与日期仅为官方页面或接口当时返回的字段，不对专题中涉及的历史事件或研究论述背书。投稿前应重新核对开放状态、延期、摘要与全文阶段及时区。

审计脚本遵守已获取的 robots 规则并限速，但没有对每一次自动 HTTP 重定向逐跳重新验证 robots；较早的部分受限记录也缺少完整 robots HTTP 元数据。运行时使用审计快照与间隔，不会动态重抓每个域名的 robots。因此本次不是对所有域名、所有重定向的实时合规保证。143 本受限记录不能当作无 SI；需要后续官网人工核实、有效授权渠道或用户粘贴导入。

官方核对入口：

- AMA JIM：`https://www.ama.org/journal-of-interactive-marketing/`
- JIBS 主通知：`https://link.springer.com/collections/fbcifgfdga`
- JBE 关闭专题：`https://link.springer.com/collections/hicgjgfhjd`
- POMS：`https://www.poms.org/journal`
- Wiley JOM：`https://onlinelibrary.wiley.com/journal/18731317`
- JITM 迁址说明：`https://jitm.ubalt.edu/`
- CABS AJG 2024：`https://www.charteredabs.org/academic-journal-guide/academic-journal-guide-2024`

## v2.2.3 补丁（2026-11-23）

v2.2.3 移除失效的 Wiley 通用征稿入口及旧地址覆盖。支持主页发现的 Wiley 期刊使用目录内的 `journalUrl`，仅跟进主页列出的同刊官方征稿链接。用户配置的单刊征稿页优先。遇到 404、403/429 或无来源时，可在「抓取诊断」设置征稿页或粘贴导入。

SI 翻译使用全局默认引擎。`translations` 的条目新增 `engineKey`，与 `contentHash` 一起校验显示及搜索所用的译文。旧缓存缺少 `engineKey` 或引擎配置已改变时，点击翻译会重新生成。存储版本与定时规则沿用 v2.2.2。

本地 869 项测试通过。真实同步五本旅游期刊时，Taylor & Francis 返回 4 条在征记录，Wiley 的 IJTR 返回 403。下文保留 v2.2.2 的实现与历史验证记录。

## v2.2.2 接入说明

修复版本：v2.2.2，修复日期：2026-11-22。源码基线：`a597ed7991e28eb4bab557ca53c9b9bc4eebdb2e`（v2.2.1）。用户提供的入口为 v2.2.0；本次保留后续 v2.2.1 的网页粘贴导入功能，再修复抓取、展开、翻译和状态一致性。桌面安装包由原仓库的标签发布工作流构建，是否已构建成功及可用平台以对应 GitHub Release 的实际附件为准。

## 1. 问题与处理

| 问题 | 处理 |
| --- | --- |
| 默认地址被拒绝或返回普通目录页，也被当作抓取完成 | 移除 Elsevier 普通期刊目录兜底；检测 403、429、超时、验证页与零解析结果；失败不更新实际成功时间 |
| 用正则切割嵌套网页，标题、详情和日期容易丢失 | 新增 htmlparser2 DOM 解析器；过滤导航和脚本；有限度跟进同源详情页 |
| T&F 原入口不可用 | 使用该出版社公开 WordPress 征稿接口，按正式期刊名精确识别；分页、字段裁剪，避免无关数据和冗余详情请求 |
| 摘要日期、开稿日或非法日期被当成最终 deadline | 优先全文投稿或延期截止；排除仅摘要、开稿与出版日期；歧义日期进入待核实 |
| 卡片无法展开 | 展开状态与 aria-expanded 同步；取消展开后的行数、高度和溢出限制 |
| 翻译返回后没有显示、按钮卡住、旧缓存误用 | 每条 SI 独立请求状态；支持显示、隐藏、失败恢复；按标题和简介内容哈希校验缓存 |
| 网络等待期间收藏、订阅等修改被覆盖 | 写入前重新读取状态；合并抓取内容；保留同时发生的收藏、人工添加、删除、日期确认和译文 |
| 来源设置被重绘或覆盖操作丢掉 | 保留未保存草稿及展开状态；添加、删除单刊覆盖时使用当前草稿；请求期间的新草稿不被标成已保存 |
| 中文研究词无法匹配英文征稿 | 读取图谱主题、关键词、实体；复用中英文主题词表；英文采用词边界，避免 AI 匹配到单词内部 |

## 2. 模块边界

| 文件 | 职责 |
| --- | --- |
| `src/specialIssueParser.js`（新增） | DOM 候选提取、验证页识别、详情页限制 |
| `src/specialIssues.js` | HTML/RSS/官方 JSON 解析、deadline 归一、订阅任务、抓取限额、合并、收藏、人工添加、搜索、图谱相关度、热点、到期清理 |
| `src/specialIssueCatalog.js` | 166 本期刊身份目录、学科和方向预设、来源与中英文主题词表；不硬编码期刊等级 |
| `src/specialIssueRoutes.js` | Express 接口、单实例抓取去重、并发状态合并、译文缓存、EasyScholar 调用、待核实日期确认 |
| `src/specialIssueScheduler.js` | 每日任务、启动补跑、独立到期清理、调度状态 |
| `src/translate.js` | 复用现有翻译引擎、当前模型配置及注入的网络通道；配置错误明确返回 |
| `public/special-issue.js` / `.css` | 保持原有独立视图、颜色 token、卡片与期刊分组；补充交互、诊断及手机布局 |
| `package.json` / `package-lock.json` | 将 htmlparser2 声明为直接依赖 |
| `test/special-issues-regression.test.mjs`（新增） | 日期、DOM、官方接口、状态并发、翻译、推荐、待核实和定时任务回归测试 |

`server.js` 已有 SI 路由、图谱、存储和调度接线，本次未改动；继续使用 Express + 原生 JavaScript，不增加前端框架或数据库。目录用于多选订阅，不宣称它是完整、经官方逐条复核的 ABS/AJG 全量名单；最终等级以 EasyScholar 返回及正式指南为准。

## 3. 数据结构

沿用 `data/special-issues.json`，`version: 1`，旧文件可直接读取。主要结构如下，注释用于说明，不是实际 JSON：

```js
{
  version: 1,
  selectedJournalIds: [],
  cfpOverrides: {},             // journalId -> 官方征稿 URL
  customSources: [],            // { id, label, url, journalId }
  issues: [],                   // 见下表
  favoriteIds: [],
  dismissedIds: [],
  translations: {},             // issueId -> { title, description, contentHash, translatedAt }
  ranks: {},                    // journalId -> { summary, items, queriedAt, journal }
  sync: {},                     // 来源 -> 尝试/成功时间、数量、warnings、error、url
  topicHistory: {},             // 日期 -> { counts, scope }，保留至多 120 个快照
  preferences: {
    autoSync: true, syncHour: 8, aiExtract: false,
    recommendEnabled: true, scope: 'subscribed'
  },
  lastAttemptAt: '',
  lastSyncAt: ''
}
```

| SI 字段 | 说明 |
| --- | --- |
| `id` | 期刊、URL、标题等生成的稳定标识；沿用已有条目 ID |
| `journalId`, `journal`, `journalShort`, `publisher`, `category` | 期刊身份；官方接口中未知期刊不从正文猜成别刊 |
| `title`, `description` | 标题和主题正文；简介最多 12,000 字符 |
| `deadline`, `deadlineText` | 存储的归一日期 `YYYY-MM-DD` 与原始日期信息 |
| `deadlineVerifiedAt` | 人工核实日期时间；后续抓取保留人工确认结果 |
| `url`, `sourceUrl` | 原文和抓取起点；仅接受 HTTP(S) |
| `topics`, `keywords` | 本地主题标签与关键词 |
| `source`, `custom` | HTML、RSS、官方接口、人工或粘贴等来源标识及人工条目标记 |
| `discoveredAt`, `updatedAt`, `detailFetchedAt` | 发现、更新及详情抓取时间 |

主列表 API 的 `deadline` 会转换为 `{ date, days, label, tone }` 供展示，磁盘内仍是日期字符串。`pendingIssues` 单独返回日期不明条目。有效译文按 `SHA-256([title, description])` 验证，正文变动后旧译文不再展示。

## 4. 页面交互

- 「征稿」：只展示确认未截止的 SI，展示 deadline、倒计时、期刊等级、原文、主题和相关度；展开与收起、翻译显示与隐藏、收藏及人工条目删除。
- 搜索：覆盖标题、简介、期刊、出版社、主题、关键词、日期和已有译文；可叠加只看收藏、主题和排序。搜索只检索本地已抓取或导入的数据，不是全网搜索。
- 「添加 SI」：手工输入标题、期刊、简介、截止日与链接，要求有效未截止日期；自动收藏，并订阅已指定期刊。网页粘贴导入允许日期待核实。
- 「期刊管理」：按学科分组，支持搜索、勾选即时保存、方向预设、全选与清空；快速连续勾选采用顺序保存。可修改单刊征稿页、添加自定义来源、设置每日时间及 AI 辅助抽取。
- 「我的研究推荐」：主动在视图中展示与图谱主题、关键词和实体相关的 SI；例如中文“旅游”可匹配英文 tourism。支持跳转、展开及不再推荐。这里没有新增系统通知、邮件或短信推送。
- 「领域热点」：根据当前统计范围中未截止的 SI，综合主题覆盖数、期刊数、新近发现和临近截止情况排序。点击主题联动征稿筛选；只有存在同范围七天前快照时才计算趋势。
- 「待核实」：显示无有效日期的候选，打开原文核实后填写日期；确认后进入在征列表。它们不进入推荐和热点。
- 「抓取诊断」：逐来源展示最近尝试、成功、条数、错误和分页警告。全部失败会显示失败；官方接口合法空列表可记为成功，不能据此保证其他出版社没有征稿。

## 5. 接口

以下路径均以 `/api/special-issues` 开头；原有接口继续保留。

| 方法 / 路径 | 用途 |
| --- | --- |
| `GET /` | 目录、列表、待核实、推荐、热点、配置及调度状态；支持 query/topic/sort/favoriteOnly/recommendOnly |
| `PUT /subscriptions` | 保存 selectedJournalIds |
| `PUT /preferences` | 保存自动抓取、小时、范围、推荐、AI 设置 |
| `PUT /sources` | 保存 cfpOverrides、customSources |
| `POST /sync` | 手工抓取，与定时任务共用一个正在运行的 Promise |
| `GET /status` | 调度和正在抓取状态 |
| `POST /custom` | 人工添加并收藏 |
| `POST /parse-paste`, `POST /import` | 本地解析粘贴内容、确认导入 |
| `PUT /:id/deadline`（新增） | 核实并保存有效未截止日期 |
| `POST /:id/favorite`, `DELETE /:id` | 收藏切换、删除条目 |
| `POST /:id/translate` | 翻译标题和正文；相同条目、相同内容请求去重 |
| `POST /:id/dismiss` | 不再推荐 |
| `POST /ranks/refresh` | EasyScholar 查询；七天缓存，默认每批最多 20 本，显式 limit 最多 40 |
| `GET /recommendations`, `GET /hot-topics` | 获取当前范围推荐与热点 |
| `POST /purge` | 立即清理过期项 |

## 6. 定时与日期规则

1. 应用或服务器运行期间，每日本地 `syncHour:00` 执行，默认 08:00。关闭应用后不运行；没有安装 Windows 计划任务。
2. 启动时若已有订阅且上次成功超过 24 小时或从未成功，45 秒后补抓一次；执行前重新检查是否仍启用、是否仍有订阅。关闭自动抓取或停止服务会取消补跑。
3. 启动立即清理过期项，此后每小时清理一次，即使关闭每日抓取也清理。读取接口时也会清理；前台可见且没有未保存来源草稿或弹窗时每 60 秒刷新。
4. 截止当天仍视为可投稿，次日本地 00:00 后视为过期，并在下一次清理时从磁盘删除；主列表即时过滤。关联收藏、译文和不再推荐标记同时删除，收藏不豁免。需要历史档案时应自行备份数据目录。
5. 未明确时区或具体时刻的日期按应用运行机器的本地日历计算，不猜测出版社午夜时区。投稿前应核对原文的时区、摘要与全文各阶段要求。
6. 单请求 15 秒、单次抓取默认 90 秒、单页 4 MB；默认并发 3，单来源最多跟进 12 个同源详情、全轮最多 60 个详情。T&F 官方接口最多 12 页，超时或上限会报告结果可能不完整。

## 7. 部署与配置

优先把补丁应用到现有完整仓库，保留 `data/`、`uploads/`、模型文件和本地设置。补丁的校验工具会核对基线与文件哈希，先备份所有将改动的文件，再覆盖；存在用户修改或基线不匹配会停止。本次补丁针对上述提交，不应盲目覆盖其他版本。

```powershell
# 在对应源码根目录执行；本次实际使用 Node.js 24 验证
npm ci
npm test
npm start
```

浏览器访问 `npm start` 日志中给出的地址。应用源码补丁不会改变已有 EXE；桌面用户应从 GitHub Release 下载 v2.2.2 安装包，或在完整仓库中按原项目打包流程构建。

- 在原有设置中配置可用翻译服务或活动 AI 模型。SI 复用现有翻译选择；大模型路径需要有效 Base URL、模型名及该服务要求的密钥，缺配置会明确提示。长简介按每段最多 4,000 字符顺序翻译。
- 在原有 AI 设置中填写 `easyScholar SecretKey`，再点「期刊等级」。未配置时不伪造 ABS 等级，显示配置提示。
- 知识图谱由现有文库生成；没有研究画像时不生成虚假的个性化推荐。相关度是本地词表加权匹配，不是语义嵌入模型，存在跨语种覆盖和同义词局限。
- 默认 AI 辅助抽取关闭，普通解析、推荐和热点不调用模型。翻译和可选 AI 抽取会向配置的服务发送相应征稿文本，可能消耗额度；EasyScholar 也受自身访问额度限制。

抓取不能绕过验证码、登录或出版社访问限制。当前已验证的自动通道为 T&F 官方公开接口；ScienceDirect、Wiley、Emerald 等在此次环境的部分页面返回 403，Springer 的旧入口可能重定向到普通页。遇到此类情况应使用有效官方来源、自定义征稿地址、粘贴导入或人工添加，不能把空结果视为该期刊不存在 SI。

本次本地验证使用的下载镜像缺少原项目 67,372,587 字节的 OCR 布局模型 `processor/dist/models/PP-DocLayoutV3-FP16-58dfa00ba1135e027817cbd5802f1f0df62aa5c0.onnx`（分发端拒绝下载），因此未用该镜像打包。发布提交只更新 SI 相关改动和版本说明，保留远端原有模型；安装包由 GitHub Actions 检出完整仓库构建。本节 SI 功能验证不能代替 OCR 实机验证。

## 8. 验证证据与解释边界

- Node.js 24 全套 `node --test`：865 项通过，0 失败、0 跳过。新增回归覆盖日期优先级、歧义日期、当天边界、DOM 嵌套、反爬识别、官方 JSON、分页、并发合并、翻译缓存、删除期间翻译、图谱匹配、待核实和调度。
- Edge 无头浏览器：真实 SI 路由与页面验证展开、翻译显示/隐藏/缓存/失败恢复、收藏、人工添加、搜索、核实日期、快速订阅、来源草稿、403 诊断、缺少等级密钥提示；390、768、1365 像素宽度无横向溢出，推荐标题有可读宽度。完整应用导航与定时任务接线通过，页面脚本错误为 0。
- 上述交互测试的翻译、图谱和出版社响应采用测试替身；不能证明真实翻译服务或 EasyScholar 密钥可用。没有可用真实密钥，未进行这两项外部服务调用。
- 最终源码真实联网复验：2026-11-22 22:28:23（Asia/Shanghai），原生 Node fetch 请求官方接口，订阅 jost/cit/tg/apjtr，39.459 秒，完整分页返回 4 条未截止 SI，1 个来源成功，0 来源失败、0 分页警告。四本订阅中只有三本有返回，不能说四本均有征稿。

| 期刊 | SI 标题 | 截止日期 |
| --- | --- | --- |
| Current Issues in Tourism | A Decade (2015-2025) of the Sustainable Development Goals (SDGs): Trends, Reflections, and Realignments in Hospitality and Tourism Research | 2026-12-01 |
| Current Issues in Tourism | Tourism and the 2026 Middle East Crisis: International and Regional Implications | 2026-12-31 |
| Asia Pacific Journal of Tourism Research | Walking and Working with AI: AI-Enabled Tourism Research and Practices | 2027-04-30 |
| Journal of Sustainable Tourism | Sustainable Luxury Tourism: Opportunities, Tensions, and Impacts | 2027-05-31 |

上述标题和日期为接口当时返回的字段，未对其中研究论述或历史事件作事实背书；出版社可能延期、撤回或更新。后续结果以原文和重新同步为准。

SI 主题榜衡量的是选定来源内的征稿关注度。它受到订阅范围、成功抓取比例、主题词表、编辑选题与首次发现时间影响；没有抓到、没有有效截止日或不在词表中的主题会被低估。它不能替代全领域文献计量、引用趋势或对研究价值的独立判断。
