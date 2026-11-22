# SI 征稿链接核验与重新设置（v2.2.5）

## 结论摘要

用户反馈「许多期刊的 SI 链接不正确、无法正确抓取」。本轮对 166 本 ABS 期刊逐一核验后，结论如下：

1. **绝大多数出版社官网在服务端不可抓取**：Elsevier / Wiley / SAGE / Taylor & Francis 期刊站 / INFORMS / OUP / AOM 等使用 Cloudflare / Akamai 站点级反爬，直连与代理均返回 403 或 robots 禁止。这类链接无论写成什么形式，服务端都无法稳定抓取，**不是链接拼写问题**。
2. **唯一可稳定抓取的官方来源是 Taylor & Francis 的公开征稿接口**：
   `https://callforpapers.taylorandfrancis.com/wp-json/wp/v2/special_issues`
   实测返回 574 条真实 SI 记录，含期刊名、专刊标题、deadline 与详情页链接。
3. 从该接口按**官方期刊代号**（`_special_issues_journal_select`，如 RPXM=Public Management Review，UJOA=Journal of Advertising）精确匹配，确认 10 本 ABS 期刊共 21 条真实在征 SI。每条都已实际访问详情页核验：HTTP 200、含 special issue / deadline、期刊身份匹配。

## 本次重新设置的默认源

| 期刊 id | 期刊 | 核验到的真实 SI 数 | 抓取源 |
| --- | --- | --- | --- |
| af | Accounting Forum | 1 | T&F 官方 API |
| ijpr | International Journal of Production Research | 4 | T&F 官方 API |
| iise | IISE Transactions | 1 | T&F 官方 API |
| ejis | European Journal of Information Systems | 4 | T&F 官方 API |
| ja | Journal of Advertising | 1 | T&F 官方 API |
| jar_res | Journal of Advertising Research | 2 | T&F 官方 API |
| jost | Journal of Sustainable Tourism | 1 | T&F 官方 API |
| cit | Current Issues in Tourism | 2 | T&F 官方 API |
| apjtr | Asia Pacific Journal of Tourism Research | 1 | T&F 官方 API |
| pmr | Public Management Review | 4 | T&F 官方 API |

- 完整的 21 条详情页链接与 deadline 存于 `src/specialIssueSourceAudit.json` 的 `verifiedSiUrls` / `issues` 字段，可逐条核对。
- 抓取仍走官方聚合接口（避免单条详情页过期），核验过的详情页作为证据在界面的来源标记中展示（悬停可见「逐条核验 N 个 SI 详情页」）。
- 已移除 v2.2.4 中 jibs 的 Springer collection 链接：复核时返回 303、内容无法确认，不再作为默认源。

## 为什么用期刊代号而不是期刊名匹配

T&F 接口里存在易混淆刊名：
- `Journal of Advertising`（UJOA，ABS 期刊 ja）
- `International Journal of Advertising`（RINA，不在目录）
- `Journal of Marketing Management`（RJMM，不是 JM）

按名称子串匹配会把后者的 SI 错配给前者。本轮用 `_special_issues_journal_select` 代号精确匹配，代号来自已核验的 tandfonline 期刊主页，从根上避免串刊。

## 其余期刊的处理方式

- 审计快照 `src/specialIssueSourceAudit.json` 保留 166 本期刊逐本核验状态：`cfp-confirmed`（官方 API 已核验）、`homepage-confirmed`（仅主页身份确认）、`access-limited` / `robots-restricted`（访问受限）。
- 对受限期刊，服务端抓取注定失败，界面明确提示在浏览器打开官方征稿页后用「从网页粘贴」导入，或手动添加、填写单刊征稿页覆盖。
- 不猜测、不拼接任何未经验证的征稿 URL。

## 可复现的核验脚本

```bash
# 1) 拉取 T&F 官方接口全部记录（6 页 / 574 条）
for p in 1 2 3 4 5 6; do
  curl -s "https://callforpapers.taylorandfrancis.com/wp-json/wp/v2/special_issues?per_page=100&page=$p&_fields=id,link,title,special_issues,date" -o tandf_p$p.json
done

# 2) 构建期刊 → 真实 SI 详情页映射（用官方期刊代号精确匹配）
node scripts/build-si-source-map.mjs tandf_all.json src/specialIssueSourceAudit.json

# 3) 逐条核验详情页可达性与 SI 内容（可选代理）
node scripts/verify-si-links.mjs si-link-verification.json --proxy=http://127.0.0.1:10809
```

核验器判据：官方 `/special_issues/` 路径 + 期刊身份匹配 + 含 special issue / deadline + 未关闭。普通主页、归档页、已关闭专题一律不通过。

## 验证结果

- 链接核验专项 8/8；SI 专项与回归、链接核验合计 57/57（Node 22）。
- 真实同步验收：订阅 af / ejis / pmr，抓到 9 条 SI，期刊名、标题、deadline、详情页链接均正确，0 失败。
- 逐条访问 21 个详情页：全部 HTTP 200 且判为真实 Special Issue。
