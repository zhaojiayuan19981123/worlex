// specialIssueCatalog.js —— SI（Special Issue）征稿：ABS 期刊目录、征稿页源、研究方向预设、领域主题词表
//
// 设计取舍（重要）：
// 1) 目录只放「期刊身份信息」（名称 / 简称 / 学科 / 出版社），**不写死期刊等级**。
//    等级一律由 easyScholar 的 ajg(ABS) / utd24 / 中科院等字段实时查询并缓存，避免内置一份会过期的榜单。
// 2) 出版社的征稿页结构千差万别，且随时改版。因此每刊只有一个「默认征稿页地址」，
//    用户可在「期刊管理」里改成实际页面，也可额外添加自定义征稿页；抓取器是通用的，
//    换 URL 不需要改代码。
// 3) 主题词表只用于「本地确定性的热点聚合 / 相关性计算」，不产生任何编造的数据。

// 每条：[id, 期刊全名, 简称, ABS 学科, 出版社]
// 覆盖 ABS/AJG 指南中经管、旅游、信息系统、会计金融等主要学科的常用期刊。
const RAW = [
  // 会计
  ['tar', 'The Accounting Review', 'TAR', '会计', 'AAA'],
  ['jar', 'Journal of Accounting Research', 'JAR', '会计', 'Wiley'],
  ['jae', 'Journal of Accounting and Economics', 'JAE', '会计', 'Elsevier'],
  ['aos', 'Accounting, Organizations and Society', 'AOS', '会计', 'Elsevier'],
  ['car', 'Contemporary Accounting Research', 'CAR', '会计', 'Wiley'],
  ['ras', 'Review of Accounting Studies', 'RAS', '会计', 'Springer'],
  ['ah', 'Accounting Horizons', 'AH', '会计', 'AAA'],
  ['ajpt', 'Auditing: A Journal of Practice & Theory', 'AJPT', '会计', 'AAA'],
  ['japp', 'Journal of Accounting and Public Policy', 'JAPP', '会计', 'Elsevier'],
  ['mar', 'Management Accounting Research', 'MAR', '会计', 'Elsevier'],
  ['bar', 'British Accounting Review', 'BAR', '会计', 'Elsevier'],
  ['abr', 'Accounting and Business Research', 'ABR', '会计', 'T&F'],
  ['af', 'Accounting Forum', 'AF', '会计', 'T&F'],
  ['ear', 'European Accounting Review', 'EAR', '会计', 'T&F'],
  ['ijoa', 'International Journal of Auditing', 'IJA', '会计', 'Wiley'],
  ['jcaae', 'Journal of Contemporary Accounting & Economics', 'JCAE', '会计', 'Elsevier'],
  // 金融
  ['jof', 'The Journal of Finance', 'JoF', '金融', 'Wiley'],
  ['jfe', 'Journal of Financial Economics', 'JFE', '金融', 'Elsevier'],
  ['rfs', 'Review of Financial Studies', 'RFS', '金融', 'Oxford'],
  ['jfqa', 'Journal of Financial and Quantitative Analysis', 'JFQA', '金融', 'Cambridge'],
  ['jbf', 'Journal of Banking & Finance', 'JBF', '金融', 'Elsevier'],
  ['jcf', 'Journal of Corporate Finance', 'JCF', '金融', 'Elsevier'],
  ['fm', 'Financial Management', 'FM', '金融', 'Wiley'],
  ['rof', 'Review of Finance', 'RoF', '金融', 'Oxford'],
  ['jfm', 'Journal of Financial Markets', 'JFM', '金融', 'Elsevier'],
  ['jfi', 'Journal of Financial Intermediation', 'JFI', '金融', 'Elsevier'],
  ['jmcb', 'Journal of Money, Credit and Banking', 'JMCB', '金融', 'Wiley'],
  ['jimf', 'Journal of International Money and Finance', 'JIMF', '金融', 'Elsevier'],
  ['irfa', 'International Review of Financial Analysis', 'IRFA', '金融', 'Elsevier'],
  ['jef', 'Journal of Empirical Finance', 'JEF', '金融', 'Elsevier'],
  ['efm', 'European Financial Management', 'EFM', '金融', 'Wiley'],
  ['frl', 'Finance Research Letters', 'FRL', '金融', 'Elsevier'],
  ['pbfj', 'Pacific-Basin Finance Journal', 'PBFJ', '金融', 'Elsevier'],
  ['jbfin', 'Journal of Behavioral Finance', 'JBF', '金融', 'T&F'],
  // 管理科学与运筹
  ['ms', 'Management Science', 'MS', '运营与运筹', 'INFORMS'],
  ['or', 'Operations Research', 'OR', '运营与运筹', 'INFORMS'],
  ['msom', 'Manufacturing & Service Operations Management', 'M&SOM', '运营与运筹', 'INFORMS'],
  ['pom', 'Production and Operations Management', 'POM', '运营与运筹', 'Wiley'],
  ['jom', 'Journal of Operations Management', 'JOM', '运营与运筹', 'Elsevier'],
  ['ejor', 'European Journal of Operational Research', 'EJOR', '运营与运筹', 'Elsevier'],
  ['ijoc', 'INFORMS Journal on Computing', 'IJOC', '运营与运筹', 'INFORMS'],
  ['omega', 'Omega', 'Omega', '运营与运筹', 'Elsevier'],
  ['ijpe', 'International Journal of Production Economics', 'IJPE', '运营与运筹', 'Elsevier'],
  ['ijopm', 'International Journal of Operations & Production Management', 'IJOPM', '运营与运筹', 'Emerald'],
  ['ds', 'Decision Sciences', 'DS', '运营与运筹', 'Wiley'],
  ['jscm', 'Journal of Supply Chain Management', 'JSCM', '运营与运筹', 'Wiley'],
  ['scm', 'Supply Chain Management: An International Journal', 'SCM', '运营与运筹', 'Emerald'],
  ['ijpr', 'International Journal of Production Research', 'IJPR', '运营与运筹', 'T&F'],
  ['aor', 'Annals of Operations Research', 'AOR', '运营与运筹', 'Springer'],
  ['iise', 'IISE Transactions', 'IISE', '运营与运筹', 'T&F'],
  ['nrl', 'Naval Research Logistics', 'NRL', '运营与运筹', 'Wiley'],
  ['orsp', 'OR Spectrum', 'ORS', '运营与运筹', 'Springer'],
  // 信息系统
  ['misq', 'MIS Quarterly', 'MISQ', '信息系统', 'AIS'],
  ['isr', 'Information Systems Research', 'ISR', '信息系统', 'INFORMS'],
  ['jmis', 'Journal of Management Information Systems', 'JMIS', '信息系统', 'T&F'],
  ['jais', 'Journal of the Association for Information Systems', 'JAIS', '信息系统', 'AIS'],
  ['im', 'Information & Management', 'I&M', '信息系统', 'Elsevier'],
  ['dss', 'Decision Support Systems', 'DSS', '信息系统', 'Elsevier'],
  ['ejis', 'European Journal of Information Systems', 'EJIS', '信息系统', 'T&F'],
  ['jit', 'Journal of Information Technology', 'JIT', '信息系统', 'Sage'],
  ['isj', 'Information Systems Journal', 'ISJ', '信息系统', 'Wiley'],
  ['chb', 'Computers in Human Behavior', 'CHB', '信息系统', 'Elsevier'],
  ['isf', 'Information Systems Frontiers', 'ISF', '信息系统', 'Springer'],
  ['bise', 'Business & Information Systems Engineering', 'BISE', '信息系统', 'Springer'],
  ['ijim', 'International Journal of Information Management', 'IJIM', '信息系统', 'Elsevier'],
  ['em', 'Electronic Markets', 'EM', '信息系统', 'Springer'],
  ['iacr', 'Internet Research', 'IR', '信息系统', 'Emerald'],
  ['jitm', 'Journal of Information Technology Management', 'JITM', '信息系统', 'Springer'],
  // 市场营销
  ['jm', 'Journal of Marketing', 'JM', '市场营销', 'Sage'],
  ['jmr', 'Journal of Marketing Research', 'JMR', '市场营销', 'Sage'],
  ['jcr', 'Journal of Consumer Research', 'JCR', '市场营销', 'Oxford'],
  ['mksc', 'Marketing Science', 'MktSci', '市场营销', 'INFORMS'],
  ['jams', 'Journal of the Academy of Marketing Science', 'JAMS', '市场营销', 'Springer'],
  ['jr', 'Journal of Retailing', 'JR', '市场营销', 'Elsevier'],
  ['ijrm', 'International Journal of Research in Marketing', 'IJRM', '市场营销', 'Elsevier'],
  ['jbr', 'Journal of Business Research', 'JBR', '市场营销', 'Elsevier'],
  ['jcp', 'Journal of Consumer Psychology', 'JCP', '市场营销', 'Wiley'],
  ['ja', 'Journal of Advertising', 'JA', '市场营销', 'T&F'],
  ['jar_res', 'Journal of Advertising Research', 'JAR', '市场营销', 'Sage'],
  ['jsr', 'Journal of Service Research', 'JSR', '市场营销', 'Sage'],
  ['jsm', 'Journal of Services Marketing', 'JSM', '市场营销', 'Emerald'],
  ['ejm', 'European Journal of Marketing', 'EJM', '市场营销', 'Emerald'],
  ['imm', 'Industrial Marketing Management', 'IMM', '市场营销', 'Elsevier'],
  ['jpi', 'Journal of Product Innovation Management', 'JPIM', '市场营销', 'Wiley'],
  ['ml', 'Marketing Letters', 'ML', '市场营销', 'Springer'],
  ['pam', 'Psychology & Marketing', 'P&M', '市场营销', 'Wiley'],
  ['jim', 'Journal of Interactive Marketing', 'JIM', '市场营销', 'Elsevier'],
  ['jppm', 'Journal of Public Policy & Marketing', 'JPPM', '市场营销', 'Sage'],
  ['jcm', 'Journal of Consumer Marketing', 'JCM', '市场营销', 'Emerald'],
  ['jbm', 'Journal of Brand Management', 'JBM', '市场营销', 'Palgrave'],
  // 综合管理 / 战略 / 组织行为
  ['amj', 'Academy of Management Journal', 'AMJ', '综合管理与战略', 'AOM'],
  ['amr', 'Academy of Management Review', 'AMR', '综合管理与战略', 'AOM'],
  ['asq', 'Administrative Science Quarterly', 'ASQ', '综合管理与战略', 'Sage'],
  ['smj', 'Strategic Management Journal', 'SMJ', '综合管理与战略', 'Wiley'],
  ['os', 'Organization Science', 'OS', '综合管理与战略', 'INFORMS'],
  ['jomg', 'Journal of Management', 'JoM', '综合管理与战略', 'Sage'],
  ['jms', 'Journal of Management Studies', 'JMS', '综合管理与战略', 'Wiley'],
  ['job', 'Journal of Organizational Behavior', 'JOB', '综合管理与战略', 'Wiley'],
  ['obhdp', 'Organizational Behavior and Human Decision Processes', 'OBHDP', '综合管理与战略', 'Elsevier'],
  ['jap', 'Journal of Applied Psychology', 'JAP', '综合管理与战略', 'APA'],
  ['pp', 'Personnel Psychology', 'PP', '综合管理与战略', 'Wiley'],
  ['amp', 'Academy of Management Perspectives', 'AMP', '综合管理与战略', 'AOM'],
  ['bjmt', 'British Journal of Management', 'BJM', '综合管理与战略', 'Wiley'],
  ['cmr', 'California Management Review', 'CMR', '综合管理与战略', 'Sage'],
  ['lrp', 'Long Range Planning', 'LRP', '综合管理与战略', 'Elsevier'],
  ['gsj', 'Global Strategy Journal', 'GSJ', '综合管理与战略', 'Wiley'],
  ['jwb', 'Journal of World Business', 'JWB', '综合管理与战略', 'Elsevier'],
  ['jibs', 'Journal of International Business Studies', 'JIBS', '国际商务', 'Palgrave'],
  ['hbr', 'Harvard Business Review', 'HBR', '综合管理与战略', 'HBP'],
  ['sloan', 'MIT Sloan Management Review', 'SMR', '综合管理与战略', 'MIT'],
  ['org', 'Organization', 'Organization', '组织行为', 'Sage'],
  ['osr', 'Organization Studies', 'OS', '组织行为', 'Sage'],
  ['humrel', 'Human Relations', 'HR', '组织行为', 'Sage'],
  // 创业 / 创新 / 技术管理
  ['jbv', 'Journal of Business Venturing', 'JBV', '创业与创新', 'Elsevier'],
  ['etp', 'Entrepreneurship Theory and Practice', 'ETP', '创业与创新', 'Sage'],
  ['sbe', 'Small Business Economics', 'SBE', '创业与创新', 'Springer'],
  ['sej', 'Strategic Entrepreneurship Journal', 'SEJ', '创业与创新', 'Wiley'],
  ['rp', 'Research Policy', 'RP', '创业与创新', 'Elsevier'],
  ['tech', 'Technovation', 'Technovation', '创业与创新', 'Elsevier'],
  ['rdm', 'R&D Management', 'R&DM', '创业与创新', 'Wiley'],
  ['ieee_tem', 'IEEE Transactions on Engineering Management', 'IEEE TEM', '创业与创新', 'IEEE'],
  ['jetm', 'Journal of Engineering and Technology Management', 'JETM', '创业与创新', 'Elsevier'],
  ['jkm', 'Journal of Knowledge Management', 'JKM', '创业与创新', 'Emerald'],
  ['tfs', 'Technological Forecasting and Social Change', 'TFSC', '创业与创新', 'Elsevier'],
  ['ijtm', 'International Journal of Technology Management', 'IJTM', '创业与创新', 'Inderscience'],
  // 旅游与酒店（示例：用户研究旅游时优先看到这些刊的 SI）
  ['tm', 'Tourism Management', 'TM', '旅游与酒店', 'Elsevier'],
  ['atr', 'Annals of Tourism Research', 'ATR', '旅游与酒店', 'Elsevier'],
  ['jtr', 'Journal of Travel Research', 'JTR', '旅游与酒店', 'Sage'],
  ['jost', 'Journal of Sustainable Tourism', 'JoST', '旅游与酒店', 'T&F'],
  ['ijhm', 'International Journal of Hospitality Management', 'IJHM', '旅游与酒店', 'Elsevier'],
  ['jhtr', 'Journal of Hospitality & Tourism Research', 'JHTR', '旅游与酒店', 'Sage'],
  ['chq', 'Cornell Hospitality Quarterly', 'CHQ', '旅游与酒店', 'Sage'],
  ['jdmm', 'Journal of Destination Marketing & Management', 'JDMM', '旅游与酒店', 'Elsevier'],
  ['tg', 'Tourism Geographies', 'TG', '旅游与酒店', 'T&F'],
  ['cit', 'Current Issues in Tourism', 'CIT', '旅游与酒店', 'T&F'],
  ['jtf', 'Journal of Tourism Futures', 'JTF', '旅游与酒店', 'Emerald'],
  ['tmp', 'Tourism Management Perspectives', 'TMP', '旅游与酒店', 'Elsevier'],
  ['jhtm', 'Journal of Hospitality and Tourism Management', 'JHTM', '旅游与酒店', 'Elsevier'],
  ['apjtr', 'Asia Pacific Journal of Tourism Research', 'APJTR', '旅游与酒店', 'T&F'],
  ['jttm', 'Journal of Travel & Tourism Marketing', 'JTTM', '旅游与酒店', 'T&F'],
  ['ijtr', 'International Journal of Tourism Research', 'IJTR', '旅游与酒店', 'Wiley'],
  ['te', 'Tourism Economics', 'TE', '旅游与酒店', 'Sage'],
  ['jht', 'Journal of Heritage Tourism', 'JHT', '旅游与酒店', 'T&F'],
  ['trr', 'Tourism Recreation Research', 'TRR', '旅游与酒店', 'T&F'],
  ['ijcthr', 'International Journal of Contemporary Hospitality Management', 'IJCHM', '旅游与酒店', 'Emerald'],
  ['ijhmc', 'Journal of Hospitality Marketing & Management', 'JHMM', '旅游与酒店', 'T&F'],
  // 经济学 / 商业伦理 / 可持续 / 公共管理
  ['aer', 'American Economic Review', 'AER', '经济学', 'AEA'],
  ['qje', 'The Quarterly Journal of Economics', 'QJE', '经济学', 'Oxford'],
  ['ecma', 'Econometrica', 'Econometrica', '经济学', 'Wiley'],
  ['jpe', 'Journal of Political Economy', 'JPE', '经济学', 'Chicago'],
  ['restud', 'The Review of Economic Studies', 'ReStud', '经济学', 'Oxford'],
  ['joe', 'Journal of Econometrics', 'JoE', '经济学', 'Elsevier'],
  ['ej', 'The Economic Journal', 'EJ', '经济学', 'Oxford'],
  ['jebeo', 'Journal of Economic Behavior & Organization', 'JEBO', '经济学', 'Elsevier'],
  ['jbe', 'Journal of Business Ethics', 'JBE', '商业伦理与可持续', 'Springer'],
  ['bas', 'Business & Society', 'B&S', '商业伦理与可持续', 'Sage'],
  ['oae', 'Organization & Environment', 'O&E', '商业伦理与可持续', 'Sage'],
  ['bse', 'Business Strategy and the Environment', 'BSE', '商业伦理与可持续', 'Wiley'],
  ['csrem', 'Corporate Social Responsibility and Environmental Management', 'CSREM', '商业伦理与可持续', 'Wiley'],
  ['jcleanprod', 'Journal of Cleaner Production', 'JCP', '商业伦理与可持续', 'Elsevier'],
  ['ee', 'Ecological Economics', 'EE', '商业伦理与可持续', 'Elsevier'],
  ['par', 'Public Administration Review', 'PAR', '公共管理', 'Wiley'],
  ['jpart', 'Journal of Public Administration Research and Theory', 'JPART', '公共管理', 'Oxford'],
  ['pmr', 'Public Management Review', 'PMR', '公共管理', 'T&F'],
  ['he', 'Higher Education', 'HE', '教育学', 'Springer'],
  ['she', 'Studies in Higher Education', 'SHE', '教育学', 'T&F'],
];

const slug = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** 出版社级公开征稿聚合页：作为默认抓取起点，可在界面里替换。 */
export const CFP_SOURCES = [
  { id: 'elsevier', label: 'Elsevier / ScienceDirect', url: 'https://www.sciencedirect.com/browse/journals-and-books', publisher: 'Elsevier' },
  { id: 'emerald', label: 'Emerald', url: 'https://www.emeraldgrouppublishing.com/calls-for-papers', publisher: 'Emerald' },
  { id: 'sage', label: 'SAGE Journals', url: 'https://journals.sagepub.com/call-for-papers', publisher: 'Sage' },
  { id: 'wiley', label: 'Wiley Online Library', url: 'https://onlinelibrary.wiley.com/call-for-papers', publisher: 'Wiley' },
  { id: 'tandf', label: 'Taylor & Francis', url: 'https://www.tandfonline.com/action/showSpecialIssues', publisher: 'T&F' },
  { id: 'springer', label: 'Springer', url: 'https://www.springer.com/gp/authors-editors/journal-author/call-for-papers', publisher: 'Springer' },
  { id: 'frontiers', label: 'Frontiers Research Topics', url: 'https://www.frontiersin.org/research-topics', publisher: 'Frontiers' },
  { id: 'informs', label: 'INFORMS', url: 'https://pubsonline.informs.org/page/calls-for-papers', publisher: 'INFORMS' },
];

/** 期刊级征稿页：ScienceDirect / Emerald 的期刊页有稳定的 call-for-papers 子页。 */
export function defaultCfpUrl(journal) {
  const p = String(journal?.publisher || '');
  if (p === 'Elsevier') return `https://www.sciencedirect.com/journal/${slug(journal.title)}/about/call-for-papers`;
  if (p === 'Emerald') return `https://www.emeraldgrouppublishing.com/journal/${slug(journal.shortTitle || journal.title)}/call-for-papers`;
  const hit = CFP_SOURCES.find((s) => s.publisher === p);
  return hit ? hit.url : '';
}

export const ABS_JOURNALS = RAW.map(([id, title, shortTitle, category, publisher]) => ({
  id, title, shortTitle, category, publisher, cfpUrl: '',
})).map((j) => ({ ...j, cfpUrl: defaultCfpUrl(j) }));

export const ABS_CATEGORIES = [...new Set(ABS_JOURNALS.map((j) => j.category))];

/** 研究方向预设：一键替换订阅（与顶刊追踪的 JOURNAL_PRESETS 同构）。 */
export const SI_PRESETS = {
  tourism: { label: '旅游与酒店', journalIds: ['tm', 'atr', 'jtr', 'jost', 'ijhm', 'jhtr', 'chq', 'jdmm', 'tg', 'cit', 'jtf', 'tmp', 'jhtm', 'ijcthr'] },
  marketing: { label: '市场营销', journalIds: ['jm', 'jmr', 'jcr', 'mksc', 'jams', 'jr', 'ijrm', 'jbr', 'jcp', 'ja', 'jsr', 'ejm', 'imm', 'jim'] },
  finance: { label: '金融', journalIds: ['jof', 'jfe', 'rfs', 'jfqa', 'jbf', 'jcf', 'fm', 'rof', 'irfa', 'frl'] },
  accounting: { label: '会计', journalIds: ['tar', 'jar', 'jae', 'aos', 'car', 'ras', 'bar', 'ear', 'mar'] },
  informationSystems: { label: '信息系统', journalIds: ['misq', 'isr', 'jmis', 'jais', 'im', 'dss', 'ejis', 'jit', 'isj', 'chb', 'ijim'] },
  operations: { label: '运营与供应链', journalIds: ['ms', 'or', 'msom', 'pom', 'jom', 'ejor', 'omega', 'ijpe', 'ijopm', 'jscm', 'scm', 'ds'] },
  strategy: { label: '战略与国际商务', journalIds: ['amj', 'amr', 'asq', 'smj', 'os', 'jomg', 'jms', 'jibs', 'jwb', 'gsj', 'lrp'] },
  entrepreneurship: { label: '创业与创新', journalIds: ['jbv', 'etp', 'sbe', 'sej', 'rp', 'tech', 'rdm', 'jpi', 'tfs', 'jkm'] },
  ob: { label: '组织行为与人力', journalIds: ['job', 'obhdp', 'jap', 'pp', 'org', 'osr', 'humrel', 'amp'] },
  sustainability: { label: '可持续与商业伦理', journalIds: ['jbe', 'bas', 'oae', 'bse', 'csrem', 'jcleanprod', 'ee', 'jost'] },
};

// ---------------- 领域主题词表（热点 / 相关性共用） ----------------
// terms 同时收中英文说法：用户知识图谱里可能是中文主题，SI 原文多为英文。
export const TOPIC_LEXICON = [
  { id: 'ai', label: '人工智能', terms: ['artificial intelligence', 'machine learning', 'deep learning', 'generative ai', 'large language model', 'llm', 'chatgpt', '算法', '人工智能', '机器学习', '大模型', '生成式'] },
  { id: 'digital', label: '数字化', terms: ['digital transformation', 'digitalization', 'digitization', 'digital economy', 'digital platform', '数字化转型', '数字化', '数字经济'] },
  { id: 'platform', label: '平台与生态', terms: ['platform', 'ecosystem', 'two-sided market', 'sharing economy', 'gig economy', '平台', '生态', '共享经济', '零工经济'] },
  { id: 'bigdata', label: '大数据与分析', terms: ['big data', 'analytics', 'data science', 'predictive analytics', 'text mining', '大数据', '数据分析', '文本挖掘'] },
  { id: 'blockchain', label: '区块链与加密', terms: ['blockchain', 'cryptocurrency', 'smart contract', 'web3', 'token', '区块链', '加密'] },
  { id: 'metaverse', label: '元宇宙与虚拟', terms: ['metaverse', 'virtual reality', 'augmented reality', 'virtual world', 'avatar', '元宇宙', '虚拟现实', '增强现实'] },
  { id: 'robot', label: '机器人与自动化', terms: ['robot', 'automation', 'autonomous', 'human-robot', 'service robot', '机器人', '自动化', '人机'] },
  { id: 'esg', label: '可持续与 ESG', terms: ['sustainability', 'sustainable', 'esg', 'carbon', 'climate', 'green', 'circular economy', 'sdg', '可持续', '低碳', '碳中和', '绿色', '循环经济'] },
  { id: 'csr', label: '社会责任与伦理', terms: ['corporate social responsibility', 'csr', 'business ethics', 'ethics', 'governance', '企业社会责任', '商业伦理', '公司治理'] },
  { id: 'consumer', label: '消费者行为', terms: ['consumer behavior', 'consumer', 'customer', 'buyer', 'purchase intention', '消费者', '顾客', '购买意愿'] },
  { id: 'brand', label: '品牌与营销', terms: ['brand', 'branding', 'advertising', 'marketing', 'promotion', '品牌', '广告', '营销'] },
  { id: 'socialmedia', label: '社交媒体', terms: ['social media', 'social network', 'influencer', 'user-generated', 'online community', '社交媒体', '社交网络', '网红', ' influencer'] },
  { id: 'ecommerce', label: '电子商务', terms: ['e-commerce', 'ecommerce', 'online retail', 'online shopping', 'live streaming commerce', '电子商务', '线上零售', '直播带货'] },
  { id: 'service', label: '服务营销', terms: ['service quality', 'service innovation', 'customer experience', 'hospitality service', '服务', '顾客体验', '服务质量'] },
  { id: 'tourism', label: '旅游与酒店', terms: ['tourism', 'tourist', 'travel', 'hospitality', 'hotel', 'destination', 'visitor', 'vacation', '旅游', '游客', '酒店', '目的地', '文旅'] },
  { id: 'sustainableTourism', label: '可持续旅游', terms: ['sustainable tourism', 'ecotourism', 'overtourism', 'responsible tourism', '可持续旅游', '生态旅游', '过度旅游'] },
  { id: 'heritage', label: '遗产与文化', terms: ['heritage', 'cultural tourism', 'culture', 'museum', '遗产', '文化旅游', '文化'] },
  { id: 'supplychain', label: '供应链', terms: ['supply chain', 'logistics', 'procurement', 'sourcing', 'resilience', 'disruption', '供应链', '物流', '韧性', '采购'] },
  { id: 'operations', label: '运营管理', terms: ['operations management', 'production', 'inventory', 'capacity', 'lean', 'quality management', '运营管理', '库存', '生产', '精益'] },
  { id: 'fintech', label: '金融科技', terms: ['fintech', 'digital finance', 'mobile payment', 'crowdfunding', 'p2p lending', '金融科技', '移动支付', '众筹'] },
  { id: 'behavioralFinance', label: '行为金融', terms: ['behavioral finance', 'investor sentiment', 'bias', 'herding', '行为金融', '投资者情绪', '羊群'] },
  { id: 'corporateFinance', label: '公司金融', terms: ['corporate finance', 'capital structure', 'merger', 'acquisition', 'ipo', 'dividend', '公司金融', '并购', '资本结构'] },
  { id: 'accounting', label: '会计与审计', terms: ['accounting', 'audit', 'financial reporting', 'earnings', 'disclosure', '会计', '审计', '财报', '披露'] },
  { id: 'governance', label: '公司治理', terms: ['corporate governance', 'board', 'ownership', 'executive compensation', '公司治理', '董事会', '股权'] },
  { id: 'entrepreneurship', label: '创业', terms: ['entrepreneurship', 'entrepreneur', 'startup', 'venture', 'new venture', '创业', '初创', '企业家'] },
  { id: 'innovation', label: '创新', terms: ['innovation', 'r&d', 'patent', 'technology transfer', 'open innovation', '创新', '研发', '专利'] },
  { id: 'strategy', label: '战略管理', terms: ['strategy', 'competitive advantage', 'strategic', 'business model', '战略', '竞争优势', '商业模式'] },
  { id: 'international', label: '国际商务', terms: ['international business', 'multinational', 'cross-cultural', 'globalization', 'fdi', '国际商务', '跨国', '跨文化'] },
  { id: 'ob', label: '组织行为', terms: ['organizational behavior', 'leadership', 'team', 'motivation', 'job satisfaction', '组织行为', '领导力', '团队', '工作满意'] },
  { id: 'hr', label: '人力资源', terms: ['human resource', 'talent', 'recruitment', 'turnover', 'performance appraisal', '人力资源', '人才', '离职', '绩效'] },
  { id: 'knowledge', label: '知识管理', terms: ['knowledge management', 'knowledge sharing', 'learning organization', 'absorptive capacity', '知识管理', '知识共享', '组织学习'] },
  { id: 'risk', label: '风险与危机', terms: ['risk', 'crisis', 'uncertainty', 'resilience', 'pandemic', 'covid', '风险', '危机', '不确定性', '疫情'] },
  { id: 'health', label: '健康与医疗', terms: ['health', 'healthcare', 'medical', 'wellbeing', 'mental health', '健康', '医疗', '心理健康'] },
  { id: 'education', label: '教育', terms: ['education', 'teaching', 'learning', 'student', 'pedagogy', '教育', '教学', '学生'] },
  { id: 'publicPolicy', label: '公共政策', terms: ['public policy', 'regulation', 'government', 'policy', '公共政策', '监管', '政府'] },
  { id: 'energy', label: '能源与环境', terms: ['energy', 'renewable', 'emission', 'environmental', 'pollution', '能源', '可再生', '排放', '环境'] },
  { id: 'method', label: '研究方法', terms: ['methodology', 'mixed methods', 'experimental design', 'causal inference', 'replication', '研究方法', '混合方法', '因果推断'] },
  { id: 'b2b', label: 'B2B 与关系', terms: ['b2b', 'business-to-business', 'relationship marketing', 'network', 'alliance', 'b2b', '关系营销', '联盟'] },
  { id: 'decision', label: '决策与行为科学', terms: ['decision making', 'behavioral', 'nudge', 'judgment', 'heuristic', '决策', '行为科学', '助推'] },
];

export function journalById(id) {
  return ABS_JOURNALS.find((j) => j.id === id) || null;
}
