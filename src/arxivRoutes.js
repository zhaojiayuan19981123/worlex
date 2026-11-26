// arxivRoutes.js —— arXiv 分类浏览的 HTTP 入口
import { ARXIV_GROUPS, ARXIV_SORTS, DEFAULT_CATEGORY, MAX_PER_PAGE, fetchArxiv } from './arxivFeed.js';

const str = (v) => String(v == null ? '' : v);
const clean = (v) => str(v).replace(/\s+/g, ' ').trim();
const ALL_CATEGORIES = new Set(ARXIV_GROUPS.flatMap((g) => g.items.map(([id]) => id)));

export function registerArxivRoutes(app, { fetchImpl, logger } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};

  app.get('/api/arxiv/meta', (_req, res) => {
    res.json({
      groups: ARXIV_GROUPS,
      sorts: ARXIV_SORTS,
      defaultCategory: DEFAULT_CATEGORY,
      maxPerPage: MAX_PER_PAGE,
    });
  });

  app.get('/api/arxiv/feed', async (req, res) => {
    const category = clean(req.query?.category) || DEFAULT_CATEGORY;
    if (category !== 'all' && !ALL_CATEGORIES.has(category)) {
      return res.status(400).json({ error: '未知的 arXiv 分类' });
    }
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(req.query?.perPage) || 20));
    const start = Math.max(0, Number(req.query?.start) || 0);
    const query = clean(req.query?.q);
    if (query.length > 160) return res.status(400).json({ error: '检索词过长（最多 160 字）' });
    try {
      const data = await fetchArxiv({ category, query, start, perPage, sort: req.query?.sort }, { fetchImpl });
      res.json({ ...data, category, query, perPage, start });
    } catch (e) {
      const message = e?.name === 'AbortError' ? 'arXiv 响应超时，请稍后重试' : (e?.message || 'arXiv 抓取失败');
      log(`[arXiv] ${message}`);
      res.status(502).json({ error: message });
    }
  });
}
