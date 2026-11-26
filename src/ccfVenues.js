// ccfVenues.js —— CCF（中国计算机学会）A / B 类期刊与会议目录
//
// 口径说明（界面上的徽标直接读这里的 `ccf` 字段，所以必须写清楚）：
//   · **国际刊 / 国际会议**：按 CCF《推荐国际学术会议和期刊目录》（2022 版）的 A / B 类。
//   · **中文刊**：CCF 对中文期刊不发 A/B，用的是《计算领域高质量科技期刊分级目录》(2025) 的 T1 / T2；
//     这里按惯例映射 T1→A、T2→B，并在 `ccfNote` 里注明「中文 T1 / T2」，避免把它说成国际 A 类。
//
// 取数方式（`provider`）：
//   · crossref —— 英文期刊。出版社把 DOI 元数据报给 Crossref，一次拿到标题/作者/卷期/页码/原文链接，
//     稳定且不需要碰各家反爬（IEEE Xplore、ACM DL、Elsevier 都会挡程序访问）。
//   · cnki     —— 中文期刊，走知网期刊 RSS（见 cnkiRss.js），带作者与摘要节选。
//   · site     —— 中文刊的官网当期目录（知网没有 RSS 时；见 cnJournalFeed.js）。
//   · rss      —— 期刊官网自己的 RSS（JMLR 没有 DOI，Crossref 收录为 0，官网给了标准 RSS）。
//   · conf     —— 会议，抓**官网论文集目录**（见 confFeed.js）。每个会议一个适配器。
//
// 会议只收录「官网论文集可被程序稳定抓取」的场馆。KDD / SIGMOD / ICSE / CCS / CHI / SIGGRAPH 等
// 由 ACM DL / IEEE Xplore 托管，两者都有 Cloudflare 之类的反爬（实测 403 / 202 挑战页），
// 不放进目录，免得用户每天看到一条失败。

/** 期刊（英文 + 中文），`kind` 缺省即 journal */
const JOURNALS = [
  // ---------- CCF-A · 人工智能 ----------
  { id: 'ccf-tpami', ccf: 'A', category: '人工智能', shortTitle: 'TPAMI', title: 'IEEE Transactions on Pattern Analysis and Machine Intelligence', issn: '0162-8828', publisherUrl: 'https://www.computer.org/csdl/journal/tp' },
  { id: 'ccf-jmlr', ccf: 'A', category: '人工智能', shortTitle: 'JMLR', title: 'Journal of Machine Learning Research', issn: '1532-4435', provider: 'rss', rssUrl: 'https://jmlr.org/jmlr.xml', publisherUrl: 'https://jmlr.org/papers/' },
  { id: 'ccf-aij', ccf: 'A', category: '人工智能', shortTitle: 'AIJ', title: 'Artificial Intelligence', issn: '0004-3702', publisherUrl: 'https://www.sciencedirect.com/journal/artificial-intelligence' },
  { id: 'ccf-ijcv', ccf: 'A', category: '人工智能', shortTitle: 'IJCV', title: 'International Journal of Computer Vision', issn: '0920-5691', publisherUrl: 'https://link.springer.com/journal/11263' },

  // ---------- CCF-A · 数据库 / 数据挖掘 / 信息检索 ----------
  { id: 'ccf-tkde', ccf: 'A', category: '数据库与信息检索', shortTitle: 'TKDE', title: 'IEEE Transactions on Knowledge and Data Engineering', issn: '1041-4347', publisherUrl: 'https://www.computer.org/csdl/journal/tk' },
  { id: 'ccf-tois', ccf: 'A', category: '数据库与信息检索', shortTitle: 'TOIS', title: 'ACM Transactions on Information Systems', issn: '1046-8188', publisherUrl: 'https://dl.acm.org/journal/tois' },
  { id: 'ccf-tods', ccf: 'A', category: '数据库与信息检索', shortTitle: 'TODS', title: 'ACM Transactions on Database Systems', issn: '0362-5915', publisherUrl: 'https://dl.acm.org/journal/tods' },
  { id: 'ccf-vldbj', ccf: 'A', category: '数据库与信息检索', shortTitle: 'VLDBJ', title: 'The VLDB Journal', issn: '1066-8888', publisherUrl: 'https://link.springer.com/journal/778' },

  // ---------- CCF-A · 软件工程 / 系统软件 / 程序设计语言 ----------
  { id: 'ccf-tse', ccf: 'A', category: '软件工程', shortTitle: 'TSE', title: 'IEEE Transactions on Software Engineering', issn: '0098-5589', publisherUrl: 'https://www.computer.org/csdl/journal/ts' },
  { id: 'ccf-tosem', ccf: 'A', category: '软件工程', shortTitle: 'TOSEM', title: 'ACM Transactions on Software Engineering and Methodology', issn: '1049-331X', publisherUrl: 'https://dl.acm.org/journal/tosem' },
  { id: 'ccf-toplas', ccf: 'A', category: '软件工程', shortTitle: 'TOPLAS', title: 'ACM Transactions on Programming Languages and Systems', issn: '0164-0925', publisherUrl: 'https://dl.acm.org/journal/toplas' },
  { id: 'ccf-tsc', ccf: 'A', category: '软件工程', shortTitle: 'TSC', title: 'IEEE Transactions on Services Computing', issn: '1939-1374', publisherUrl: 'https://www.computer.org/csdl/journal/sc' },

  // ---------- CCF-A · 图形学与多媒体 ----------
  { id: 'ccf-tog', ccf: 'A', category: '图形与多媒体', shortTitle: 'TOG', title: 'ACM Transactions on Graphics', issn: '0730-0301', publisherUrl: 'https://dl.acm.org/journal/tog' },
  { id: 'ccf-tip', ccf: 'A', category: '图形与多媒体', shortTitle: 'TIP', title: 'IEEE Transactions on Image Processing', issn: '1057-7149', publisherUrl: 'https://signalprocessingsociety.org/publications-resources/ieee-transactions-image-processing' },
  { id: 'ccf-tvcg', ccf: 'A', category: '图形与多媒体', shortTitle: 'TVCG', title: 'IEEE Transactions on Visualization and Computer Graphics', issn: '1077-2626', publisherUrl: 'https://www.computer.org/csdl/journal/tg' },

  // ---------- CCF-A · 网络与信息安全 ----------
  { id: 'ccf-tmc', ccf: 'A', category: '网络与安全', shortTitle: 'TMC', title: 'IEEE Transactions on Mobile Computing', issn: '1536-1233', publisherUrl: 'https://www.computer.org/csdl/journal/tm' },
  { id: 'ccf-ton', ccf: 'A', category: '网络与安全', shortTitle: 'TON', title: 'IEEE/ACM Transactions on Networking', issn: '1063-6692', publisherUrl: 'https://www.comsoc.org/publications/journals/ieeeacm-transactions-networking' },
  { id: 'ccf-tdsc', ccf: 'A', category: '网络与安全', shortTitle: 'TDSC', title: 'IEEE Transactions on Dependable and Secure Computing', issn: '1545-5971', publisherUrl: 'https://www.computer.org/csdl/journal/tq' },
  { id: 'ccf-tifs', ccf: 'A', category: '网络与安全', shortTitle: 'TIFS', title: 'IEEE Transactions on Information Forensics and Security', issn: '1556-6013', publisherUrl: 'https://signalprocessingsociety.org/publications-resources/ieee-transactions-information-forensics-and-security' },

  // ---------- CCF-A · 体系结构 / 并行 / 存储 ----------
  { id: 'ccf-tc', ccf: 'A', category: '系统与存储', shortTitle: 'TC', title: 'IEEE Transactions on Computers', issn: '0018-9340', publisherUrl: 'https://www.computer.org/csdl/journal/tc' },
  { id: 'ccf-tpds', ccf: 'A', category: '系统与存储', shortTitle: 'TPDS', title: 'IEEE Transactions on Parallel and Distributed Systems', issn: '1045-9219', publisherUrl: 'https://www.computer.org/csdl/journal/td' },
  { id: 'ccf-tocs', ccf: 'A', category: '系统与存储', shortTitle: 'TOCS', title: 'ACM Transactions on Computer Systems', issn: '0734-2071', publisherUrl: 'https://dl.acm.org/journal/tocs' },

  // ---------- CCF-A · 交叉 / 综合 ----------
  { id: 'ccf-jacm', ccf: 'A', category: '理论与交叉', shortTitle: 'JACM', title: 'Journal of the ACM', issn: '0004-5411', publisherUrl: 'https://dl.acm.org/journal/jacm' },
  { id: 'ccf-scis', ccf: 'A', category: '理论与交叉', shortTitle: 'SCIS', title: 'Science China Information Sciences', issn: '1674-733X', publisherUrl: 'https://link.springer.com/journal/11432' },

  // ---------- CCF-A · 人机交互 ----------
  { id: 'ccf-tochi', ccf: 'A', category: '人机交互', shortTitle: 'TOCHI', title: 'ACM Transactions on Computer-Human Interaction', issn: '1073-0516', publisherUrl: 'https://dl.acm.org/journal/tochi' },

  // ---------- CCF-B · 人工智能 ----------
  { id: 'ccf-tnnls', ccf: 'B', category: '人工智能', shortTitle: 'TNNLS', title: 'IEEE Transactions on Neural Networks and Learning Systems', issn: '2162-237X', publisherUrl: 'https://www.ieee-icsociety.org/publications-resources/ieee-transactions-neural-networks-and-learning-systems' },
  { id: 'ccf-tcyb', ccf: 'B', category: '人工智能', shortTitle: 'TCYB', title: 'IEEE Transactions on Cybernetics', issn: '2168-2267', publisherUrl: 'https://www.ieee-smc.org/publications/ieee-transactions-on-cybernetics' },
  { id: 'ccf-pr', ccf: 'B', category: '人工智能', shortTitle: 'PR', title: 'Pattern Recognition', issn: '0031-3203', publisherUrl: 'https://www.sciencedirect.com/journal/pattern-recognition' },
  { id: 'ccf-jair', ccf: 'B', category: '人工智能', shortTitle: 'JAIR', title: 'Journal of Artificial Intelligence Research', issn: '1076-9757', publisherUrl: 'https://www.jair.org' },
  { id: 'ccf-mlj', ccf: 'B', category: '人工智能', shortTitle: 'MLJ', title: 'Machine Learning', issn: '0885-6125', publisherUrl: 'https://link.springer.com/journal/10994' },

  // ---------- CCF-B · 自然语言处理 ----------
  { id: 'ccf-tacl', ccf: 'B', category: '自然语言处理', shortTitle: 'TACL', title: 'Transactions of the Association for Computational Linguistics', issn: '2307-387X', publisherUrl: 'https://aclanthology.org/venues/tacl/' },

  // ---------- CCF-B · 网络与安全 ----------
  { id: 'ccf-twc', ccf: 'B', category: '网络与安全', shortTitle: 'TWC', title: 'IEEE Transactions on Wireless Communications', issn: '1536-1276', publisherUrl: 'https://www.comsoc.org/publications/journals/ieee-transactions-wireless-communications' },
  { id: 'ccf-cn', ccf: 'B', category: '网络与安全', shortTitle: 'CN', title: 'Computer Networks', issn: '1389-1286', publisherUrl: 'https://www.sciencedirect.com/journal/computer-networks' },

  // ---------- CCF-B · 数据库与信息检索 ----------
  { id: 'ccf-tkdd', ccf: 'B', category: '数据库与信息检索', shortTitle: 'TKDD', title: 'ACM Transactions on Knowledge Discovery from Data', issn: '1556-4681', publisherUrl: 'https://dl.acm.org/journal/tkdd' },
  { id: 'ccf-dmkd', ccf: 'B', category: '数据库与信息检索', shortTitle: 'DMKD', title: 'Data Mining and Knowledge Discovery', issn: '1384-5810', publisherUrl: 'https://link.springer.com/journal/10618' },
  { id: 'ccf-ipm', ccf: 'B', category: '数据库与信息检索', shortTitle: 'IPM', title: 'Information Processing & Management', issn: '0306-4573', publisherUrl: 'https://www.sciencedirect.com/journal/information-processing-and-management' },

  // ---------- CCF-B · 软件工程 ----------
  { id: 'ccf-emse', ccf: 'B', category: '软件工程', shortTitle: 'EMSE', title: 'Empirical Software Engineering', issn: '1382-3256', publisherUrl: 'https://link.springer.com/journal/10664' },
  { id: 'ccf-jss', ccf: 'B', category: '软件工程', shortTitle: 'JSS', title: 'Journal of Systems and Software', issn: '0164-1212', publisherUrl: 'https://www.sciencedirect.com/journal/journal-of-systems-and-software' },
  { id: 'ccf-ist', ccf: 'B', category: '软件工程', shortTitle: 'IST', title: 'Information and Software Technology', issn: '0950-5849', publisherUrl: 'https://www.sciencedirect.com/journal/information-and-software-technology' },

  // ---------- CCF-B · 图形与多媒体 ----------
  { id: 'ccf-tmm', ccf: 'B', category: '图形与多媒体', shortTitle: 'TMM', title: 'IEEE Transactions on Multimedia', issn: '1520-9210', publisherUrl: 'https://signalprocessingsociety.org/publications-resources/ieee-transactions-multimedia' },
  { id: 'ccf-cgf', ccf: 'B', category: '图形与多媒体', shortTitle: 'CGF', title: 'Computer Graphics Forum', issn: '0167-7055', publisherUrl: 'https://onlinelibrary.wiley.com/journal/14678659' },
  { id: 'ccf-tcsvt', ccf: 'B', category: '图形与多媒体', shortTitle: 'TCSVT', title: 'IEEE Transactions on Circuits and Systems for Video Technology', issn: '1051-8215', publisherUrl: 'https://ieee-cas.org/publication/ieee-transactions-circuits-and-systems-video-technology' },

  // ---------- CCF-B · 人机交互 ----------
  { id: 'ccf-thms', ccf: 'B', category: '人机交互', shortTitle: 'THMS', title: 'IEEE Transactions on Human-Machine Systems', issn: '2168-2291', publisherUrl: 'https://www.ieee-smc.org/publications/ieee-transactions-on-human-machine-systems' },

  // ---------- CCF-B · 交叉 / 综合 ----------
  { id: 'ccf-jcst', ccf: 'B', category: '理论与交叉', shortTitle: 'JCST', title: 'Journal of Computer Science and Technology', issn: '1000-9000', publisherUrl: 'https://jcst.ict.ac.cn' },
  { id: 'ccf-fcs', ccf: 'B', category: '理论与交叉', shortTitle: 'FCS', title: 'Frontiers of Computer Science', issn: '2095-2228', publisherUrl: 'https://link.springer.com/journal/11704' },
  { id: 'ccf-wwwj', ccf: 'B', category: '理论与交叉', shortTitle: 'WWWJ', title: 'World Wide Web', issn: '1386-145X', publisherUrl: 'https://link.springer.com/journal/11280' },

  // ---------- 中文刊 · CCF 分级目录 T1（映射为 A） ----------
  // 知网代码逐个实测核对过 channel title（见 cnkiRss.js 的 CNKI_CODES）；
  // 没有知网 RSS 的三本走官网当期目录（feedUrl 已实测能解析出标题）。
  { id: 'ccf-rjxb', ccf: 'A', ccfNote: '中文 T1', category: '软件工程', shortTitle: '软件学报', title: '软件学报', titleEn: 'Journal of Software', issn: '1000-9825', language: 'zh', cnkiCode: 'RJXB', publisherUrl: 'https://www.jos.org.cn' },
  { id: 'ccf-jsjx', ccf: 'A', ccfNote: '中文 T1', category: '理论与交叉', shortTitle: '计算机学报', title: '计算机学报', titleEn: 'Chinese Journal of Computers', issn: '0254-4164', language: 'zh', cnkiCode: 'JSJX', publisherUrl: 'http://cjc.ict.ac.cn' },
  { id: 'ccf-jsjyfz', ccf: 'A', ccfNote: '中文 T1', category: '理论与交叉', shortTitle: '计算机研究与发展', title: '计算机研究与发展', titleEn: 'Journal of Computer Research and Development', issn: '1000-1239', language: 'zh', feedUrl: 'https://crad.ict.ac.cn/CN/1000-1239/home.shtml', publisherUrl: 'https://crad.ict.ac.cn' },
  { id: 'ccf-ssis', ccf: 'A', ccfNote: '中文 T1', category: '理论与交叉', shortTitle: '中国科学:信息科学', title: '中国科学:信息科学', titleEn: 'Scientia Sinica Informationis', issn: '1674-7267', language: 'zh', cnkiCode: 'PZKX', publisherUrl: 'https://www.sciengine.com/SSI' },
  { id: 'ccf-dzxb', ccf: 'A', ccfNote: '中文 T1', category: '电子信息', shortTitle: '电子学报', title: '电子学报', titleEn: 'Acta Electronica Sinica', issn: '0372-2112', language: 'zh', cnkiCode: 'DZXU', publisherUrl: 'http://www.ejournal.org.cn' },
  { id: 'ccf-dzxx', ccf: 'A', ccfNote: '中文 T1', category: '电子信息', shortTitle: '电子与信息学报', title: '电子与信息学报', titleEn: 'Journal of Electronics & Information Technology', issn: '1009-5896', language: 'zh', cnkiCode: 'DZYX', publisherUrl: 'http://jeit.ac.cn' },
  { id: 'ccf-zdhxb', ccf: 'A', ccfNote: '中文 T1', category: '人工智能', shortTitle: '自动化学报', title: '自动化学报', titleEn: 'Acta Automatica Sinica', issn: '0254-4156', language: 'zh', cnkiCode: 'MOTO', publisherUrl: 'http://www.aas.net.cn' },
  { id: 'ccf-txxb', ccf: 'A', ccfNote: '中文 T1', category: '网络与安全', shortTitle: '通信学报', title: '通信学报', titleEn: 'Journal on Communications', issn: '1000-436X', language: 'zh', cnkiCode: 'TXXB', publisherUrl: 'http://www.joconline.com.cn' },
  { id: 'ccf-zwxx', ccf: 'A', ccfNote: '中文 T1', category: '自然语言处理', shortTitle: '中文信息学报', title: '中文信息学报', titleEn: 'Journal of Chinese Information Processing', issn: '1003-0077', language: 'zh', cnkiCode: 'MESS', publisherUrl: 'http://jcip.cipsc.org.cn' },
  { id: 'ccf-jcad', ccf: 'A', ccfNote: '中文 T1', category: '图形与多媒体', shortTitle: '计算机辅助设计与图形学学报', title: '计算机辅助设计与图形学学报', titleEn: 'Journal of Computer-Aided Design & Computer Graphics', issn: '1003-9775', language: 'zh', cnkiCode: 'JSJF', publisherUrl: 'http://www.jcad.cn' },

  // ---------- 中文刊 · CCF 分级目录 T2（映射为 B） ----------
  { id: 'ccf-jsjkx', ccf: 'B', ccfNote: '中文 T2', category: '理论与交叉', shortTitle: '计算机科学', title: '计算机科学', titleEn: 'Computer Science', issn: '1002-137X', language: 'zh', feedUrl: 'https://www.jsjkx.com', publisherUrl: 'https://www.jsjkx.com' },
  { id: 'ccf-pr-ai', ccf: 'B', ccfNote: '中文 T2', category: '人工智能', shortTitle: '模式识别与人工智能', title: '模式识别与人工智能', titleEn: 'Pattern Recognition and Artificial Intelligence', issn: '1003-6059', language: 'zh', cnkiCode: 'MSSB', publisherUrl: 'http://manu46.magtech.com.cn' },
  { id: 'ccf-jsjyy', ccf: 'B', ccfNote: '中文 T2', category: '软件工程', shortTitle: '计算机应用', title: '计算机应用', titleEn: 'Journal of Computer Applications', issn: '1001-9081', language: 'zh', cnkiCode: 'JSJY', publisherUrl: 'http://www.joca.cn' },
  { id: 'ccf-cjig', ccf: 'B', ccfNote: '中文 T2', category: '图形与多媒体', shortTitle: '中国图象图形学报', title: '中国图象图形学报', titleEn: 'Journal of Image and Graphics', issn: '1006-8961', language: 'zh', feedUrl: 'http://www.cjig.cn', publisherUrl: 'http://www.cjig.cn' },
  { id: 'ccf-xxwx', ccf: 'B', ccfNote: '中文 T2', category: '系统与存储', shortTitle: '小型微型计算机系统', title: '小型微型计算机系统', titleEn: 'Journal of Chinese Computer Systems', issn: '1000-1220', language: 'zh', cnkiCode: 'XXWX', publisherUrl: 'http://xwxt.sict.ac.cn' },
  { id: 'ccf-jsjgc', ccf: 'B', ccfNote: '中文 T2', category: '系统与存储', shortTitle: '计算机工程', title: '计算机工程', titleEn: 'Computer Engineering', issn: '1000-3428', language: 'zh', cnkiCode: 'JSJC', publisherUrl: 'http://www.ecice06.com' },
  { id: 'ccf-xtyy', ccf: 'B', ccfNote: '中文 T2', category: '系统与存储', shortTitle: '计算机系统应用', title: '计算机系统应用', titleEn: 'Computer Systems & Applications', issn: '1003-3254', language: 'zh', cnkiCode: 'XTYY', publisherUrl: 'http://www.c-s-a.org.cn' },
];

/**
 * 会议（CCF-A / CCF-B）。
 *
 * `conf` 是给 confFeed.js 的取数参数：
 *   adapter  —— 官网模板（nips / pmlr / cvf / acl / ijcai / usenix / ecva）
 *   month    —— 通常的办会月份，用来判断「今年这届出没出论文集」，省掉一次必然 404 的探测
 *   series / slug / match —— 各适配器定位当届目录所需的参数
 */
const CONFERENCES = [
  { id: 'ccf-neurips', ccf: 'A', category: '人工智能', shortTitle: 'NeurIPS', title: 'Conference on Neural Information Processing Systems', month: 12, conf: { adapter: 'nips' }, publisherUrl: 'https://papers.nips.cc' },
  { id: 'ccf-icml', ccf: 'A', category: '人工智能', shortTitle: 'ICML', title: 'International Conference on Machine Learning', month: 7, conf: { adapter: 'pmlr', match: 'International Conference on Machine Learning|\\bICML\\b' }, publisherUrl: 'https://proceedings.mlr.press' },
  { id: 'ccf-ijcai', ccf: 'A', category: '人工智能', shortTitle: 'IJCAI', title: 'International Joint Conference on Artificial Intelligence', month: 8, conf: { adapter: 'ijcai' }, publisherUrl: 'https://www.ijcai.org' },
  { id: 'ccf-cvpr', ccf: 'A', category: '计算机视觉', shortTitle: 'CVPR', title: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition', month: 6, conf: { adapter: 'cvf', series: 'CVPR' }, publisherUrl: 'https://openaccess.thecvf.com' },
  { id: 'ccf-iccv', ccf: 'A', category: '计算机视觉', shortTitle: 'ICCV', title: 'IEEE/CVF International Conference on Computer Vision', month: 10, conf: { adapter: 'cvf', series: 'ICCV' }, publisherUrl: 'https://openaccess.thecvf.com' },
  { id: 'ccf-acl', ccf: 'A', category: '自然语言处理', shortTitle: 'ACL', title: 'Annual Meeting of the Association for Computational Linguistics', month: 7, conf: { adapter: 'acl', slug: 'acl' }, publisherUrl: 'https://aclanthology.org' },
  { id: 'ccf-osdi', ccf: 'A', category: '系统与存储', shortTitle: 'OSDI', title: 'USENIX Symposium on Operating Systems Design and Implementation', month: 7, conf: { adapter: 'usenix', slug: 'osdi' }, publisherUrl: 'https://www.usenix.org/conferences/byname/179' },
  { id: 'ccf-fast', ccf: 'A', category: '系统与存储', shortTitle: 'FAST', title: 'USENIX Conference on File and Storage Technologies', month: 2, conf: { adapter: 'usenix', slug: 'fast' }, publisherUrl: 'https://www.usenix.org/conferences/byname/150' },
  { id: 'ccf-atc', ccf: 'A', category: '系统与存储', shortTitle: 'USENIX ATC', title: 'USENIX Annual Technical Conference', month: 7, conf: { adapter: 'usenix', slug: 'atc' }, publisherUrl: 'https://www.usenix.org/conferences/byname/131' },
  { id: 'ccf-nsdi', ccf: 'A', category: '网络与安全', shortTitle: 'NSDI', title: 'USENIX Symposium on Networked Systems Design and Implementation', month: 4, conf: { adapter: 'usenix', slug: 'nsdi' }, publisherUrl: 'https://www.usenix.org/conferences/byname/161' },
  { id: 'ccf-sec', ccf: 'A', category: '网络与安全', shortTitle: 'USENIX Security', title: 'USENIX Security Symposium', month: 8, conf: { adapter: 'usenix', slug: 'usenixsecurity' }, publisherUrl: 'https://www.usenix.org/conferences/byname/108' },

  { id: 'ccf-eccv', ccf: 'B', category: '计算机视觉', shortTitle: 'ECCV', title: 'European Conference on Computer Vision', month: 9, conf: { adapter: 'ecva' }, publisherUrl: 'https://www.ecva.net' },
  { id: 'ccf-emnlp', ccf: 'B', category: '自然语言处理', shortTitle: 'EMNLP', title: 'Conference on Empirical Methods in Natural Language Processing', month: 11, conf: { adapter: 'acl', slug: 'emnlp' }, publisherUrl: 'https://aclanthology.org' },
  { id: 'ccf-naacl', ccf: 'B', category: '自然语言处理', shortTitle: 'NAACL', title: 'Conference of the North American Chapter of the ACL', month: 4, conf: { adapter: 'acl', slug: 'naacl' }, publisherUrl: 'https://aclanthology.org' },
  { id: 'ccf-coling', ccf: 'B', category: '自然语言处理', shortTitle: 'COLING', title: 'International Conference on Computational Linguistics', month: 1, conf: { adapter: 'acl', slug: 'coling' }, publisherUrl: 'https://aclanthology.org' },
  { id: 'ccf-uai', ccf: 'B', category: '人工智能', shortTitle: 'UAI', title: 'Conference on Uncertainty in Artificial Intelligence', month: 7, conf: { adapter: 'pmlr', match: 'Uncertainty in Artificial Intelligence|\\bUAI\\b' }, publisherUrl: 'https://proceedings.mlr.press' },
  { id: 'ccf-colt', ccf: 'B', category: '人工智能', shortTitle: 'COLT', title: 'Conference on Learning Theory', month: 6, conf: { adapter: 'pmlr', match: 'Conference on Learning Theory|\\bCOLT\\b' }, publisherUrl: 'https://proceedings.mlr.press' },
];

export const CCF_JOURNALS = JOURNALS.map((journal) => {
  const provider = journal.provider || (journal.cnkiCode ? 'cnki' : journal.language === 'zh' ? 'site' : 'crossref');
  return {
    ...journal,
    kind: 'journal',
    set: 'ccf',
    titleEn: journal.titleEn || '',
    language: journal.language || 'en',
    provider,
    ccfNote: journal.ccfNote || '',
  };
});

export const CCF_CONFERENCES = CONFERENCES.map((venue) => ({
  ...venue,
  kind: 'conference',
  set: 'ccf',
  language: 'en',
  provider: 'conf',
  titleEn: venue.title,
  ccfNote: '',
  issn: '',
}));

export const CCF_VENUES = [...CCF_JOURNALS, ...CCF_CONFERENCES];

export const CCF_LEVELS = ['A', 'B'];

export function ccfVenueById(id) {
  return CCF_VENUES.find((venue) => venue.id === id) || null;
}

/** 某个等级的场馆 id 列表（JOURNAL_SETS / 预设用） */
export function ccfIdsOf(level, kind) {
  return CCF_VENUES.filter((venue) => venue.ccf === level && (!kind || venue.kind === kind)).map((venue) => venue.id);
}

/** 按领域取 id（预设用） */
export function ccfIdsByCategory(level, categories) {
  const wanted = new Set(Array.isArray(categories) ? categories : [categories]);
  return CCF_VENUES.filter((venue) => venue.ccf === level && wanted.has(venue.category)).map((venue) => venue.id);
}
