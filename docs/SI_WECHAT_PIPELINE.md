# SI 征稿（v2）：公众号文章驱动的征稿信息管线

本文档描述 v2.3.0 起重做的 SI（Special Issue，专刊征稿）模块。旧版「逐刊访问出版社官网抓征稿页」的方案已整体移除，本文不保留其说明。

## 1. 为什么重做

旧方案有两条硬约束，都不在原代码可控范围内：

1. **出版社官网大面积封锁服务端抓取。** ScienceDirect、SAGE、Wiley、T&F、INFORMS、Emerald、Springer、Frontiers 普遍有 Cloudflare / Akamai 站点级反爬，服务端请求直连超时、挂代理仍返回 403。
2. **微信关闭了公众号后台的跨号文章搜索接口。** 2026-07-30 起 `searchbiz` / `appmsgpublish` 接口族下线，依赖它的 `wechat-article-exporter`（12.5k star）、`we-mp-rss`、`wewe-rss` 全部停止维护；搜狗微信、PC 客户端历史消息页抓包也早已失效。

**但有一条路仍然通**：`mp.weixin.qq.com/s?...` 的**单篇文章正文**仍可免登录抓取（必须带完整参数含 `chksm`，带桌面 UA + Referer；短链缺 `chksm` 会 302 到「未知错误」页）。正文在 `#js_content` 内，默认 `visibility:hidden` 但文本就在 HTML 里，不需要执行 JS。

因此 v2 的思路是：**列表由外部来源提供，正文自己抓，字段交给大模型抽取。**

## 2. 处理流程

```
文章源（RSS / 本地导出目录 / 粘贴链接 / 自定义接口）
        │  collectArticles
        ▼
state.articles  每篇一条，status: pending
        │  processArticles（并发 2，新的优先，单篇失败只影响自己）
        │      ├── 抓正文：fetchWechatArticle（在线） / readLocalArticle（本地文件）
        │      ├── 抽取：大模型 → normalizeExtractedIssues
        │      │           失败或没有模型 → ruleExtractIssues（正则兜底）
        │      └── 去重：stableIssueId = 期刊名 + 截止日 + 主题
        ▼
state.issues    卡片数据（含中文标题、摘要、主题词、客座编辑、投稿链接）
        │  enrichRanks（同名期刊只查一次，缓存 7 天，550ms 间隔）
        ▼
state.ranks + issue.rank    中科院分区 / 新锐分区 / ABS / UTD24 / SSCI / FMS / CSSCI
        ▼
界面卡片 + 多维筛选（关键词 / 截止窗口 / 等级 / 主题 / 收藏 / 排序）
```

每一步都以「从磁盘读最新状态」开始、以「写回状态」结束，中途中断后重跑不会重复出卡。

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

不配任何源也能用，这是给「不想装 Docker、不想折腾 RSS」的场景准备的主路径：

1. 在微信里打开文章 → 右上角「…」（电脑版右键）→ **复制链接**。
2. 回到 worlex 的 SI 页，点「粘贴收稿」，或在页面任意空白处直接 `Ctrl+V`（会自动弹窗并预填）。
3. 点「开始识别」：抓正文 → 大模型拆分译中 → 查 EasyScholar 等级 → 出卡片，全自动。

接口 `POST /api/special-issues/collect`：

- 入参 `{ text }` 或 `{ urls: [...] }`；从任意文本里提取 `mp.weixin.qq.com/s...` 链接（微信分享文案、多行混排都行），**非微信链接会被过滤**；
- 单次最多 60 篇，超出部分在响应里用 `dropped` 返回，前端提示用户下批再贴；
- **先在请求里入队落盘再返回**，所以「收下了没有」有确定答案；全是重复链接时返回 `started:false, queued:0, existing:N`，不会白跑后台任务；
- 抽取在后台分批（每批 6 篇）执行，每批结束落盘一次，中途关窗口或进程被杀不会丢掉已识别的结果；
- 与「立即同步」共用同一份运行态 `runtime`，两者互斥：正在跑时再提交返回 409。

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


## 4. 文件与职责

| 文件 | 职责 |
| --- | --- |
| `src/siSources.js` | 源适配器：四类取数、链接规范化与去重、日期解析、RSS/Atom 解析 |
| `src/wechatArticle.js` | 单篇正文抓取与归一化：`#js_content` 提取、链接转「文字 (URL)」、错误页识别、本地文件读取 |
| `src/siExtract.js` | 提示词、模型 JSON 容错解析、字段归一化（`normalizeExtractedIssues`）、正则兜底（`ruleExtractIssues`） |
| `src/specialIssues.js` | 状态 v2 与纯逻辑：去重键、卡片构建、筛选、排序、统计、过期清理、偏好 |
| `src/siPipeline.js` | 管线编排：采集 / 抽取 / 等级富化 / 全流程，含重试与进度回调 |
| `src/specialIssueScheduler.js` | 每日增量定时器 |
| `src/specialIssueRoutes.js` | HTTP 路由，只做「读状态 → 调管线 → 写状态 → 返回 payload」 |
| `public/special-issue.js` | 视图：卡片列表、筛选工具条、侧滑面板（文章源 / 诊断 / 偏好） |
| `public/special-issue.css` | 只用 token 变量，跟随主题 |

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
  "dismissedIds": [], "favoriteIds": [],
  "lastSyncAt": "", "lastAttemptAt": ""
}
```

- 文章状态机：`pending → extracted | skipped | failed`，失败累计 `attempts`（上限 3），错误写在 `lastError`。
- 卡片去重键 `stableIssueId`：同一专刊被多篇推文报道（延期、补充信息）只出一张卡。
- 收藏、删除分别记在 `favoriteIds` / `dismissedIds`，不写进卡片本身。
- 过期卡片（截止后 7 天）在未开启「显示已截止」时自动清理，同时清掉关联的收藏与译文。

## 6. HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/special-issues` | 主查询，`query` / `topics` / `deadlineWindow` / `rankSystem` / `rankLevels` / `favoriteOnly` / `sourceId` / `sort` |
| GET | `/api/special-issues/status` | 定时器与运行时状态，前端轮询用 |
| POST / PUT / DELETE | `/api/special-issues/sources[/:id]` | 源增删改；删除可加 `?purgeArticles=1` 连带清文章与卡片 |
| POST | `/api/special-issues/sources/test` | 试拉一个源（不落盘） |
| POST | `/api/special-issues/sync` | **启动后台同步并立即返回**，前端轮询 `/status` |
| POST | `/api/special-issues/collect` | **粘贴收稿**：`{text}` 或 `{urls}`，入队后立即返回，后台分批抽取；与 sync 互斥（跑着时返回 409） |
| POST | `/api/special-issues/step` | 单步：`collect` / `extract` / `rank` |
| POST | `/api/special-issues/manual` | 手动粘贴一篇正文入库 |
| POST | `/api/special-issues/ranks/refresh` | 强制刷新等级 |
| POST | `/api/special-issues/:id/translate` | 单张卡片重新翻译 |
| POST | `/api/special-issues/:id/favorite` | 收藏 / 取消 |
| PATCH / DELETE | `/api/special-issues/:id` | 改字段 / 删除卡片 |
| POST | `/api/special-issues/purge` | 清理过期卡片 |
| PUT | `/api/special-issues/preferences` | 偏好（自动同步、时间、回溯天数、显示开关、排序） |

同步接口必须是后台任务：首次回溯 90 天会有几十篇文章、每篇一次模型调用，同步等待必然超时。

## 7. 没有大模型时

- 抽取退化为正则（`ruleExtractIssues`），只认「期刊：… 专刊主题：… 截稿日期：…」这类固定版式，结果标 `extractedBy: 'rule'`，卡片上显示「规则抽取」角标，置信度压到 0.55。
- 规则抽取的已知边界：纯叙述式推文（没有字段标签）抽不出卡片，会记成 `skipped`（非征稿），不报错。
- 偏好里可关掉「显示规则抽取」，只看模型结果。
- 期刊等级需要「AI 设置」里的 EasyScholar SecretKey，没有 Key 时卡片显示「未收录分区」占位，等级筛选不可用。

## 8. 验证

单测：`node --test test/special-issues-v2.test.mjs`（33 项，覆盖源解析、去重、时窗、正文提取、模型 JSON 容错、字段归一化、规则抽取、跨文章去重、筛选各维度、管线编排与失败隔离）；`node --test test/special-issues-collect.test.mjs`（5 项，覆盖粘贴收稿的链接提取、重复入库、忙碌互斥、60 条上限）。

浏览器端到端（Playwright，需先启动服务）：切视图 → 卡片渲染 → 主题/关键词/等级筛选 → 排序 → 展开 → 面板三个页签 → 收藏回显 → 立即同步的增量出卡；「粘贴收稿」按钮 → 浮层识别计数 → 空白处 Ctrl+V 自动弹窗 → 普通文本不打扰 → 来回切视图不重复弹层。

真实环境已验证：单篇公众号正文抓取（标题、发布时间、7883 字正文、正文内链接保留）、真实文章经模型抽取成卡、模型不可用时自动回落规则抽取。**未验证**：真实 EasyScholar 返回值（需有效 Key）、真实大模型的抽取质量（用本地假模型验证的是链路而非质量）。
