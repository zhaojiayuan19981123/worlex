# SI 征稿（v2）：公众号与官网页面驱动的征稿信息管线

本文档描述 v2.3.0 起重做的 SI（Special Issue，专刊征稿）模块，以及 v2.4.0 的界面与输入方式改造。旧版「逐刊访问出版社官网抓征稿页」的方案已整体移除，本文不保留其说明。

> v2.4.0 变更摘要（细节见各节）：界面改为**一览表 + 右侧详情抽屉**；「粘贴收稿」除公众号链接外还接受**出版社官网专刊页链接**与**整段正文**；抽取产出**全文翻译**（`detailZh`）而非概括；收藏改为**加入任务**（同步到任务安排与首页倒计时）；抽屉里可由大模型把**灵感孵化**的想法关联到该专刊。

## 1. 为什么重做

旧方案有两条硬约束，都不在原代码可控范围内：

1. **出版社官网大面积封锁服务端抓取。** ScienceDirect、SAGE、Wiley、T&F、INFORMS、Emerald、Springer、Frontiers 普遍有 Cloudflare / Akamai 站点级反爬，服务端请求直连超时、挂代理仍返回 403。
2. **微信关闭了公众号后台的跨号文章搜索接口。** 2026-07-30 起 `searchbiz` / `appmsgpublish` 接口族下线，依赖它的 `wechat-article-exporter`（12.5k star）、`we-mp-rss`、`wewe-rss` 全部停止维护；搜狗微信、PC 客户端历史消息页抓包也早已失效。

**但有一条路仍然通**：`mp.weixin.qq.com/s?...` 的**单篇文章正文**仍可免登录抓取（必须带完整参数含 `chksm`，带桌面 UA + Referer；短链缺 `chksm` 会 302 到「未知错误」页）。正文在 `#js_content` 内，默认 `visibility:hidden` 但文本就在 HTML 里，不需要执行 JS。

因此 v2 的思路是：**列表由外部来源提供，正文自己抓，字段交给大模型抽取。**

## 2. 处理流程

```
文章源（RSS / 本地导出目录 / 粘贴链接 / 自定义接口）
  或「粘贴收稿」：公众号链接 / 出版社专刊页链接 / 整段正文
        │  collectArticles / collect（enqueueTargets）
        ▼
state.articles  每篇一条，status: pending（contentKind: feed | url | text）
        │  processArticles（并发 2，新的优先，单篇失败只影响自己）
        │      ├── 取正文：feed 用自带全文 / text 用粘贴的正文
        │      │        / 本地文件 readLocalArticle / 微信 fetchWechatArticle
        │      │        / 其他 URL fetchWebPageArticle（通用网页正文抽取）
        │      ├── 抽取：大模型 → normalizeExtractedIssues
        │      │           失败、被截断或没有模型 → salvageModelJson → ruleExtractIssues
        │      └── 去重：stableIssueId = 期刊名 + 截止日 + 主题
        ▼
state.issues    条目数据（中文一句话摘要 + 全文翻译 detailZh + 主题词 + 客座编辑 + 投稿链接）
        │  enrichRanks（同名期刊只查一次，缓存 7 天，550ms 间隔）
        ▼
state.ranks + issue.rank    中科院分区 / 新锐分区 / ABS / UTD24 / SSCI / FMS / CSSCI
        ▼
一览表（摘要一行）+ 右侧详情抽屉（全文翻译 / 相关灵感）+ 多维筛选
        ▼
「加入任务」→ data/tasks.json（source: 'si'）→ 任务安排 + 首页「征稿截止」卡片
```

每一步都以「从磁盘读最新状态」开始、以「写回状态」结束，中途中断后重跑不会重复出条目。

### 三路取正文（v2.4.0）

`extractOne` 之前把所有 URL 都当微信文章抓，于是**贴官网链接必定失败**——这是「贴了地址没反应」的根因。现在按来源分流：

| 来源 | 处理 |
| --- | --- |
| `contentKind: 'feed'` | 订阅源自带全文，直接转文本，不联网 |
| `contentKind: 'text'` | 用户粘贴的正文，直接使用 |
| 本地文件 | `readLocalArticle` |
| `mp.weixin.qq.com/s...` | `fetchWechatArticle`（`#js_content`） |
| 其他 `http(s)` | `fetchWebPageArticle`：依次找 `article` → `main` → `id/class` 含 article/content/main/body/text/detail/call 的容器，取文本量最大且 ≥200 字者，无则退回 `body`；去掉 `nav/script/style/header/footer/aside`；块级标签转换行 |

### 首次回溯与每日增量

- 首次配置时按 `backfillDays`（默认 90 天，可在源上单独设 1~365）回溯，`collectArticles` 用 `since` 时窗过滤，没写日期的条目计入 warning 而不是静默丢弃。
- 之后每天 `syncHour`（默认 09:00）跑一次增量：只处理新出现的文章（按 canonical 链接去重，同一篇文章的短链与长链视为同一条）。
- 定时器是链式 `setTimeout`，全部 `unref()`，不拖住进程退出；启动时若距上次同步超过 24 小时，会在 45 秒后补跑一次。

## 3. 四类文章源

微信目前没有稳定的免登录「列出某号全部历史文章」通道，所以「列表从哪来」被抽象成可替换的源（`src/siSources.js`），任何一个被封都不至于让整个功能失效：

| 类型 | 说明 | 适用 |
| --- | --- | --- |
| `rss` | 第三方或自建服务把公众号转成 RSS，粘贴订阅地址。**自建可用 wechat-mp-tools**（见 3.2），也可用收费的 wechat2rss | 需要每日全自动增量时 |
| `folder` | 本地导出目录（wechatDownload、MPider 等工具导出 md/html/txt/json），深度 3、最多 3000 个文件 | 不依赖任何接口，永不失效 |
| `links` | 一次性批量补录，消费后该源自动移除 | 补录、验证、兜底 |
| `json` | 自建桥接接口，返回 `[{url,title,publishedAt}]` 或 `{items:[...]}` | 接本机脚本 / MCP |

源的配置项：`type`、`name`、`target`（地址或目录）、`enabled`、`backfillDays`。同一时刻最多 20 个源，单个源失败只写自己的 `lastError`，界面在「诊断」里显示。

### 3.1 零配置：粘贴收稿（默认路径）

不配任何源也能用，这是给「不想装 Docker、不想折腾 RSS」的场景准备的主路径。**可贴三种东西**：

| 贴什么 | 判定 | 处理 |
| --- | --- | --- |
| 公众号文章链接 | `mp.weixin.qq.com/s...` | 抓 `#js_content` |
| 出版社官网专刊页链接 | 其他 `http(s)` 链接 | 通用网页正文抽取 |
| 整段正文 | 去掉链接后 **≥400 字**且含征稿信号（`CFP_SIGNAL_RE`：special issue / call for papers / 专刊 / 征稿 / 截稿 / submission deadline / guest editor …） | 零网络请求，直接抽取 |

**界面同时告诉你该去哪里找**：SI 页顶部有一张可收起的「去哪找征稿」指引卡，写明推荐公众号 **SSCI征稿**（微信号 `sscizhenggao`）、三步操作（关注 → 打开文章复制链接 → 回到 SI 页 Ctrl+V）。收起状态记在 `localStorage` 的 `worlex.si.guideHidden`，刷新后保持。

1. 在微信里打开文章 → 右上角「…」（电脑版右键）→ **复制链接**；或直接在浏览器地址栏复制出版社专刊页地址；或选中网页上的征稿说明文字复制。
2. 回到 worlex 的 SI 页，点「粘贴收稿」，或在页面任意空白处直接 `Ctrl+V`（会自动弹窗并预填）。
3. 点「开始整理」：抓正文 → 大模型拆分并全文翻译 → 查 EasyScholar 等级 → 出列表，全自动。

接口 `POST /api/special-issues/collect`：

- 入参 `{ text }` 或 `{ urls: [...] }`；`parseCollectInput` 从任意文本里抽取所有 `http(s)` 链接（微信分享文案、多行混排都行），**链接被移除后剩下的正文 ≥400 字且有征稿信号时按正文收**（避免「链接 + 正文」重复出两条）；否则按链接收。
- 响应里的 `counted: { wechat, page, text }` 给出三类各自识别到几条，前端实时显示；识别不到时按钮禁用并提示「没有识别到可处理的内容。可以粘贴公众号文章链接、出版社专刊页链接，或直接粘贴正文（400 字以上会自动识别）。」
- 单次最多 60 篇，超出部分在响应里用 `dropped` 返回，前端提示用户下批再贴；
- **先在请求里入队落盘再返回**，所以「收下了没有」有确定答案；全是重复内容时返回 `started:false, queued:0, existing:N`，不会白跑后台任务；
- 粘贴的整段正文不入「文章链接」表，而是作为 `contentKind: 'text'` 的文章记录，`sourceName: '粘贴正文'`，去重键为 `'art_t' + sha1(正文)` 前 16 位；
- 抽取在后台分批（每批 6 篇）执行，每批结束落盘一次，中途关窗口或进程被杀不会丢掉已识别的结果；
- 与「立即同步」共用同一份运行态 `runtime`，两者互斥：正在跑时再提交返回 409。

官网页面抓不到正文时的提示语是具体的：命中人机验证 / Cloudflare 挑战页 →「这个页面返回的是人机验证/拒绝访问页，抓不到正文。请在浏览器里打开后把正文复制粘贴进来。」；401/403 →「该页面不允许程序访问……请直接把页面正文复制粘贴进来」；正文 <80 字 →「页面里没有解析出正文（可能是纯 JS 渲染）」。

耗时参考：每篇都要过一次大模型，约 10~30 秒一篇，进度显示在页面顶部横幅。

### 3.2 可选：自建订阅源，实现「每日自动增量」

需要电脑上长期跑一个服务，一次配好后每天自动发现新文章。适合要回溯大量历史文章的情况。

wechat2rss 这类托管服务要收费，可以自己跑一个。选择 wechat-mp-tools 的原因是它用 Playwright 驱动真实 Chromium 操作公众号后台页面，而不是硬调微信接口——2026-07-30 微信关闭的是后者，所以同类项目（we-mp-rss、wewe-rss）的采集功能都废了，它还在更新。

**前提**：它要登录 **mp.weixin.qq.com 公众号后台**，也就是你得有一个自己能登录的公众号（订阅号也行）。没有公众号账号就走 3.1，别在这上面花时间。

**本机没装 Docker 也没关系**：项目在 Releases 里提供 Windows / macOS 免安装包（`WeChat_MP_Tools_Windows_Lite.zip` 约 40~60 MB，`Full` 约 200 MB 且内置 Chromium）。解压后双击运行即可，`data` 目录在程序同级，端口仍是 5200，后续步骤与下面完全一致。

```bash
# 有 Docker 时的轻量版（只要公众号 + RSS）
docker run -d --name wechat-mp-tools --restart unless-stopped \
  -p 5200:5200 -v $(pwd)/data:/app/data \
  -e TZ=Asia/Shanghai -e BIND_ADDR=127.0.0.1 \
  ghcr.io/x554960766/wechat-mp-tools:latest
```

装好后：

1. 打开 `http://127.0.0.1:5200`，在「账号池」扫码登录公众号后台（建议用小号，有风控风险；不要勾选 24 小时自动退出）。
2. 添加「SSCI征稿」这个公众号，按时间范围触发一次采集，把近 3 个月的文章拉下来。
3. 复制该号的 RSS 地址，形如 `http://127.0.0.1:5200/api/articles/rss/...`；如果设置了 `RSS_TOKEN`，要在地址后加 `?token=你的密钥`。
4. 在 worlex 的「专刊征稿 → 设置 → 文章源」里选「RSS 订阅地址」，粘贴上面这个地址，回溯天数填 90。

**为什么不需要再抓正文**：它的 RSS 默认带 `content:encoded` 全文（`full=1`，上限 30 万字符）。worlex 解析时会把这段全文存进文章记录（`contentKind: 'feed'`），抽取阶段直接用它，不再请求一次正文页——少一次往返，也少一次被微信风控的机会。若在 wechat-mp-tools 里关掉了全文输出，worlex 会自动回落到抓正文。

注意它的 `<link>` 指向自己的离线预览文件，真正的公众号原文地址在 `<guid>` 里。worlex 解析时优先取 `<guid>`，所以卡片上的「原文」按钮仍然跳微信，不会跳到本地服务。


### 3.3 界面：一览表 + 右侧详情抽屉

旧布局是卡片网格 + 点击原地展开：一屏只能放 4~6 张卡，摘要被截断成 3 行，要看全文得来回滚。现在改为**一览表**（`public/special-issue.js` 的 `renderList`）：

- 行网格：期刊 178px / 标题主体 / 徽标 + 截止 / 箭头；已加任务的行左侧加一条主色竖条。
- 行可 `tabindex`，`Enter` / 空格打开抽屉；抽屉内按 `Esc` 或点遮罩关闭，关闭后焦点回到触发行。
- 列表接口**不下发全文**：`payload()` 里 `detailZh` 被剔除，只留 `detailChars`（长度）与 `hasTask`；抽屉打开时才 `GET /api/special-issues/:id` 取全文。
- 详情抽屉：620px，两页签「详情与全文翻译」/「相关灵感 N」，含事实网格（截稿 / 开放 / 出版商 / 客座编辑）、主题、按段落渲染的全文翻译、来源链接与底部操作条。
- 响应式：1180px 收邮票级信息，900px 隐藏英文标题行，720px 抽屉全宽。

### 3.4 全文翻译（`detailZh`）

提示词（`buildExtractMessages`，`SI_PROMPT_VERSION = 3`）的要求从「摘要」改成**全文翻译**：

- 不概括、不合并、不省略段落；逐段翻译，段落之间保留 `\n`；
- 数字、日期、期刊名、投稿系统名、邮箱、链接一律原样保留；
- 全文 ≤4000 字（原文很长时也允许到 12000 字上限），`summaryZh` 收窄为一句话（30~60 字），只用于列表行。

容错链：模型 JSON 解析失败 → `salvageModelJson` 按正则逐字段抢救（`detailZh` 取到截断点为止）→ 仍无 `journal` / `titleZh` 才回落 `ruleExtractIssues`。

`normalizeExtractedIssues` 会做 CRLF 归一、压多余空行、保留段落分隔、截断 12000 字。单独重译走 `POST /api/special-issues/:id/translate`：先用文章记录里的正文，正文丢了按 `localPath` / 微信 / 通用网页重新取一次，再调 `buildTranslateMessages`（只输出译文）；没有模型时回落 `translateImpl`。旧条目没有 `detailZh`，抽屉里给「生成全文翻译」按钮。

`mergeIssues` 里 `detailZh` 的合并规则是 `item.detailZh || prev.detailZh || ''`——**空译文不覆盖已有译文**，避免一次失败的抽取把用户已生成的翻译洗掉。

### 3.5 加入任务与首页截止

收藏（`favoriteIds` / `POST /:id/favorite`）已移除，改为任务：

- `POST /api/special-issues/:id/task`：`buildTaskFromIssue` 生成任务——标题 `投稿 SI｜<期刊>｜<主题>`，`due = 截稿日`（未标注则今天 +14 天），`priority` 按剩余天数分档（≤14 天高 / ≤45 天中 / 其余低），`source: 'si'`、`issueId`、`issueUrl`、`journal`、`deadline`；已存在则返回 `{ already: true }` 不重复建。写回 `issue.taskId` / `taskAddedAt`。
- `DELETE /api/special-issues/:id/task`：删派生任务并清 `taskId`；`DELETE /api/special-issues/:id` 会连带删除派生任务。
- `mergeIssues` 中 `taskId` / `taskAddedAt` / `ideaMatches` **一律保留旧值**：抽取结果无权清空用户数据。
- 列表支持 `taskOnly=1`；`specialIssueSummary` 新增 `tasks`（已加任务条数）与 `nearestTask`，后者由 `nearestTaskDeadline(issues, now)` 计算：只统计**已加入任务且未过期**的征稿，返回 `{id, date, days, label, journal, title}`。
- 前端：`public/app.js` 的 `renderHome()` 渲染「征稿截止」卡片（`tasks.filter(t => t.source === 'si' && t.status !== 'done')`，按天数排序取 4 条），倒计时标签为「征稿截止」；任务安排里带「征稿」chip，点条目 → `switchView('specialissue')` → `SpecialIssueView.open(issueId)`；SI 统计条第 4 格显示最近截止并可切到「只看已加任务」，第 5 格是已加入任务的条数。

### 3.6 灵感关联（大模型梳理）

`POST /api/special-issues/:id/ideas`：

1. 取最近 40 条灵感（标题 + 摘要 + 领域）；
2. 与该专刊的期刊、主题、征稿范围、客座编辑一起给模型，要求只输出 `{"matches":[{id,score,reason,angle}]}`；
3. `score >= 45` 才留，最多 5 条，写回 `issue.ideaMatches`（`{ideaId, score, reason, angle, at}`，上限 6 条）；
4. 前端「相关灵感」页签渲染，点条目用 `window.Worlex.openIdea(id)` 跳回灵感孵化并打开该想法。

未配置大模型时返回 400 `/未配置大模型/`，界面显示明确提示而不是静默失败。

## 4. 文件与职责

| 文件 | 职责 |
| --- | --- |
| `src/siSources.js` | 源适配器：四类取数、链接规范化与去重、日期解析、RSS/Atom 解析 |
| `src/wechatArticle.js` | 单篇公众号正文抓取与归一化：`#js_content` 提取、链接转「文字 (URL)」、错误页识别、本地文件读取 |
| `src/siWebPage.js` | **v2.4.0 新增**：通用网页正文抽取（`fetchWebPageArticle` / `htmlToPlainText` / `htmlTitle` / `htmlPublishedAt`），供出版社专刊页等非微信链接使用；含人机验证 / 403 / 正文过短的可读报错 |
| `src/siExtract.js` | 提示词（抽取 + 全文翻译）、模型 JSON 容错解析与 `salvageModelJson` 抢救、字段归一化（`normalizeExtractedIssues`）、正则兜底（`ruleExtractIssues`） |
| `src/specialIssues.js` | 状态 v2 与纯逻辑：去重键、条目构建（`normalizeIssueRecord` 单一出口）、筛选、排序、统计、`nearestTaskDeadline`、过期清理、偏好 |
| `src/siPipeline.js` | 管线编排：采集 / 三路取正文 / 抽取 / 等级富化 / 全流程，含重试与进度回调 |
| `src/specialIssueScheduler.js` | 每日增量定时器 |
| `src/specialIssueRoutes.js` | HTTP 路由，只做「读状态 → 调管线 → 写状态 → 返回 payload」；含收稿解析、任务派生、灵感关联 |
| `public/special-issue.js` | 视图：指引卡、统计条、一览表、右侧详情抽屉（全文翻译 / 相关灵感）、筛选工具条、侧滑面板（文章源 / 诊断 / 偏好）；导出 `open(id)` 供首页跳转 |
| `public/special-issue.css` | 只用 token 变量，跟随主题；含列表与抽屉的响应式降级 |

## 5. 状态结构（`data/special-issues.json`）

```json
{
  "version": 2,
  "sources": [],
  "articles": [],
  "issues": [],
  "ranks": {},
  "translations": {},
  "sync": {},
  "preferences": {
    "autoSync": true, "syncHour": 9, "backfillDays": 90,
    "includeExpired": false, "showRuleExtracted": true,
    "autoRank": true, "autoTranslate": false, "sort": "deadline"
  },
  "dismissedIds": [],
  "lastSyncAt": "", "lastAttemptAt": ""
}
```

条目（`state.issues[]`）关键字段：

| 字段 | 说明 |
| --- | --- |
| `summaryZh` | 一句话摘要（≤400 字，列表行用） |
| `detailZh` | **全文翻译**（≤12000 字，保留 `\n` 分段；列表接口不下发） |
| `taskId` / `taskAddedAt` | 已加入任务时指向 `tasks.json` 里的派生任务；合并时不会被抽取结果覆盖 |
| `ideaMatches` | 大模型梳理出的相关灵感 `{ideaId, score, reason, angle, at}`，≤6 条 |
| `rank` / `badges` | EasyScholar 等级 |

- 文章状态机：`pending → extracted | skipped | failed`，失败累计 `attempts`（上限 3），错误写在 `lastError`。文章记录的 `contentKind` 为 `feed` / `url` / `text` / `file`。
- 条目去重键 `stableIssueId`：同一专刊被多篇推文报道（延期、补充信息）只出一条。
- 删除记在 `dismissedIds`；**收藏已移除**（`favoriteIds` 不再使用），改由条目的 `taskId` 与 `tasks.json` 表达。
- 过期条目（截止后 7 天）在未开启「显示已截止」时自动清理，同时清掉关联译文。
- **字段白名单**统一走 `normalizeIssueRecord`：v2.3.0 曾因为「写的时候有、读的时候白名单里没有」静默丢掉全文，所以读路径只有一处。

## 6. HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/special-issues` | 主查询，`query` / `topics` / `deadlineWindow` / `rankSystem` / `rankLevels` / `taskOnly` / `sourceId` / `sort`；**不下发 `detailZh`**，只给 `detailChars` 与 `hasTask` |
| GET | `/api/special-issues/:id` | 单条详情：`{issue, article, ideaMatches}`，含 `deadline` 与等级徽章；抽屉打开时调用 |
| GET | `/api/special-issues/status` | 定时器与运行时状态，前端轮询用 |
| POST / PUT / DELETE | `/api/special-issues/sources[/:id]` | 源增删改；删除可加 `?purgeArticles=1` 连带清文章与条目 |
| POST | `/api/special-issues/sources/test` | 试拉一个源（不落盘） |
| POST | `/api/special-issues/sync` | **启动后台同步并立即返回**，前端轮询 `/status` |
| POST | `/api/special-issues/collect` | **粘贴收稿**：`{text}` 或 `{urls}`，接受公众号链接 / 官网专刊页 / 整段正文，返回 `counted:{wechat,page,text}`；与 sync 互斥（跑着时 409） |
| POST | `/api/special-issues/step` | 单步：`collect` / `extract` / `rank` |
| POST | `/api/special-issues/manual` | 手动粘贴一篇正文入库 |
| POST | `/api/special-issues/ranks/refresh` | 强制刷新等级 |
| POST | `/api/special-issues/:id/translate` | 生成 / 重新生成该条的**全文翻译** |
| POST | `/api/special-issues/:id/task` | **加入任务**（重复调用返回 `already: true`） |
| DELETE | `/api/special-issues/:id/task` | 移出任务（只删派生任务） |
| POST | `/api/special-issues/:id/ideas` | 大模型梳理相关灵感，写回 `ideaMatches`；未配模型返回 400 |
| PATCH / DELETE | `/api/special-issues/:id` | 改字段 / 删除条目（连带删除派生任务） |
| POST | `/api/special-issues/purge` | 清理过期条目 |
| PUT | `/api/special-issues/preferences` | 偏好（自动同步、时间、回溯天数、显示开关、排序） |

同步接口必须是后台任务：首次回溯 90 天会有几十篇文章、每篇一次模型调用，同步等待必然超时。

## 7. 没有大模型时

- 抽取退化为正则（`ruleExtractIssues`），只认「期刊：… 专刊主题：… 截稿日期：…」这类固定版式，结果标 `extractedBy: 'rule'`，列表里显示「规则抽取」角标，置信度压到 0.55。
- 规则抽取**不做翻译**（`detailZh` 为空），抽屉里给「生成全文翻译」按钮，配好模型后点一下即可补。
- 规则抽取的已知边界：纯叙述式推文（没有字段标签）抽不出条目，会记成 `skipped`（非征稿），不报错。
- 偏好里可关掉「显示规则抽取」，只看模型结果。
- 期刊等级需要「AI 设置」里的 EasyScholar SecretKey，没有 Key 时显示「未收录分区」占位，等级筛选不可用。
- 灵感关联按钮会直接返回「未配置大模型」，不会排队后静默失败。

## 8. 验证

单测：`node --test test/special-issues-v2.test.mjs`（**40 项**：源解析、去重、时窗、微信正文提取、通用网页正文抽取与 403 报错、`detailZh` 分段与 CRLF 归一与 12000 字截断、截断 JSON 抢救、翻译提示词不概括、模型 JSON 容错、字段归一化、规则抽取、跨文章去重、`mergeIssues` 不冲掉任务与旧译文、`nearestTaskDeadline` 只算已加任务、筛选各维度、管线编排与失败隔离）；`node --test test/special-issues-collect.test.mjs`（**10 项**：链接提取、官网专刊页抓取、整段正文零网络请求、重复入库、忙碌互斥、60 条上限、加入 / 移出任务、未配模型时 `/ideas` 报错）。

全量 `node --test` 881 项通过（Git Bash 下需前置 `TEMP="C:/Users/zjy1998/AppData/Local/Temp"`，否则 `os.tmpdir()` 指向不可写目录）。

浏览器端到端（Playwright，1680×980，无 console / page 错误）：粘贴正文识别「1 段正文（766 字）」→ 出 1 行列表 → 抽屉详情 → 相关灵感页签 → 加入任务提示截止日 → 统计条第 4 / 5 格立即更新 → 首页四卡同排且「征稿截止」卡显示该条目 → 任务安排里带「征稿」chip → 指引卡收起后刷新仍收起；另验三种粘贴形态的计数（微信 1 篇 / 网页 1 个 / 短文本「没有识别到内容」且按钮禁用）。

真实环境已验证：单篇公众号正文抓取（标题、发布时间、7883 字正文、正文内链接保留）、真实文章经模型抽取成条目、模型不可用时自动回落规则抽取、出版社专刊页正文抓取。**未验证**：真实 EasyScholar 返回值（需有效 Key）、真实大模型的抽取与翻译质量（用本地假模型验证的是链路而非质量）、真实官网大面积 Cloudflare 站点的抓取成功率。
