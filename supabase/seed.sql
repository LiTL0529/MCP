-- ============================================================
-- Seed data — sample users + the example.md article.
-- The insight is inserted WITHOUT an embedding; run
--   npm run backfill
-- afterwards to vectorise it (needs OPENAI_API_KEY).
-- API keys are NOT seeded; mint them with `npm run create-key`.
-- ============================================================

insert into ja_users (email, name, access_groups, is_admin) values
  ('admin@jefferyasia.com', 'JA Admin',      '{}',    true),
  ('nus.user@nus.edu.sg',   'NUS Demo User', '{NUS}', false)
on conflict (email) do nothing;

insert into ja_insights (
  report_id, report_date, access, attributes,
  category, status, type, clients, tracks,
  title_en, title_zh, summary_en, summary_zh,
  insight_en, insight_zh,
  recommendations_en, recommendations_zh,
  sources, recommended_services_en, recommended_services_zh
) values (
  '02',
  '2026-05-25',
  '{NUS,SMU,NTU}',
  jsonb_build_object(
    'date', '2026-05-25',
    'access', to_jsonb(array['NUS','SMU','NTU']),
    'id', '02',
    'lang', 'en',
    'type', 'daily-insights',
    'category_zh', $ja$中国教育市场$ja$,
    'category_en', $ja$China Education Market$ja$,
    'status', 'RADAR',
    'clients_zh', $ja$NUS(新加坡国立大学), SMU(), NTU, INSEAD, SUSS_SUTD$ja$,
    'clients_en', $ja$NUS, SMU, NTU, INSEAD, SUSS, SUTD$ja$,
    'tracks_zh', $ja$新加坡硕士项目 / 商学院 EMBA 与 MBA / 政策与社科研究生项目 / 国际教育服务机构$ja$,
    'tracks_en', $ja$Master's Programs in Singapore / EMBA & MBA Programs at Business Schools / Postgraduate Programs in Policy Studies & Social Sciences / International Education Service Providers$ja$
  ),
  $ja$中国教育市场$ja$,
  'RADAR',
  'daily-insights',
  $ja$NUS, SMU, NTU, INSEAD, SUSS, SUTD$ja$,
  $ja$Master's Programs in Singapore / EMBA & MBA Programs at Business Schools / Postgraduate Programs in Policy Studies & Social Sciences / International Education Service Providers$ja$,
  $ja$Singapore Evolves into a Transit Hub for Chinese Enterprises Going Global: China's committed fixed asset investment in Singapore surged from 2.5% to roughly 21% within a year, making China the second-largest investment source. With proactive investment promotion by Singapore's EDB, ByteDance, Tencent and Alibaba having set up regional headquarters here, a new employment avenue has opened up for Chinese students pursuing studies in Singapore.$ja$,
  $ja$新加坡正把自己摆成中国企业出海的中转站：2025 年中国对新加坡的固定资产投资承诺一年内从 2.5% 跳到约 21%，跃居第二大来源。EDB 主动招商、字节腾讯阿里设区域总部，这给中国学生留学新加坡又多开了一条就业出口$ja$,
  $ja$According to the 2026 annual report released by Singapore's Economic Development Board (EDB), the national authority in charge of investment promotion, Singapore's total committed fixed asset investment across all industries stood at S$14.16 billion in 2025. Committed investment from Chinese enterprises reached approximately S$2.9 billion, accounting for around 21% of the total. This represented a sharp rise from 2.5% recorded in 2024, cementing China's position as Singapore's second-largest source of investment. (Source: SCMP citing EDB, May 3, 2026)$ja$,
  $ja$据新加坡经济发展局（EDB，新加坡国家级招商引资主管机构）2026 年 2 月发布的年度报告，2025 年新加坡全行业固定资产投资承诺总额 S$141.6 亿，中国企业承诺约 S$29 亿、占比约 21%，较 2024 年的 2.5% 大幅跳升，跃居第二大投资来源 [SCMP 引 EDB · 2026/05/03]$ja$,
  $ja$To put it simply, Singapore views Chinese enterprises as business partners and growth opportunities rather than potential risks. The EDB's active investment drive, matchmaking efforts by business chambers and Business China, coupled with a nearly tenfold jump in investment share within a year, reflect a clear national strategy. For partner universities in Singapore, the significance lies not just in macro trends, but in filling a long-standing gap in enrollment marketing content. Previously, Chinese students studying in Singapore were presented with two mainstream career paths: joining local Singaporean companies or returning to China for work. Now a distinct third path has emerged — working for Chinese enterprises operating in Singapore.$ja$,
  $ja$新加坡对中国企业市场环境的态度，用一句话概括就是把中国企业当客户、当机会，而不是当风险：EDB 招手、总商会和通商中国搭桥、投资份额一年涨近十倍，这是一个国家级的明确选择。对 JA 高校客户来说，这件事的价值不在宏观层面，而在它给招生内容补上了一块一直缺的拼图。中国学生留学新加坡的就业出口，过去只讲留新本地企业和回国就业两条路，现在多了清晰的第三条：在新加坡的中国企业。$ja$,
  jsonb_build_array(
    $ja$Add Chinese enterprises based in Singapore as the third career pathway in employment-related content. Leverage official EDB statistics and alumni employment data to create long infographics for WeChat Official Accounts and Q&A posts for Xiaohongshu.$ja$,
    $ja$Leverage the trend of Chinese enterprises going global as a core selling point for EMBA and MBA programs at business schools, featuring alumni career experiences at overseas Chinese enterprises and real cross-border management cases.$ja$,
    $ja$Focus content on business trends and talent demands, and avoid macro geopolitical discussions. Cite only authoritative statistics from official bodies such as the EDB and Caixin, and use neutral expressions like "regional hub" and "talent corridor".$ja$
  ),
  jsonb_build_array(
    $ja$把在新中国企业做成就业出口内容的第三条路径。用 EDB 公开数据和项目自己的校友去向做支撑，做成微信公众号长图与小红书问答笔记。$ja$,
    $ja$商学院 EMBA 与 MBA 用中国企业出海做高管教育钩子。校友在出海企业担任的岗位、课程中与东南亚市场相关的模块、真实的跨境管理案例。$ja$,
    $ja$内容口径锁定商业与人才，不碰宏观与地缘。只引 EDB、财新等官方与权威统计，用区域枢纽、人才走廊这类中性表述。$ja$
  ),
  jsonb_build_array(
    jsonb_build_object('tier', 'E', 'title', $ja$SCMP: Singapore's safe-haven status draws more Chinese capital (May 3, 2026)$ja$, 'url', 'https://www.scmp.com/business/article/3352046/singapores-safe-haven-status-draws-more-chinese-capital-property-sector'),
    jsonb_build_object('tier', 'F', 'title', $ja$Caixin: China's fixed asset investment in Singapore jumps more than eightfold (February 10, 2026)$ja$, 'url', 'https://www.caixinglobal.com/2026-02-10/chinas-fixed-asset-investment-in-singapore-jumps-more-than-eightfold-102413373.html'),
    jsonb_build_object('tier', 'Industry', 'title', $ja$Indeed Singapore: Job openings at Chinese companies in Singapore$ja$, 'url', 'https://sg.indeed.com/q-china-company-jobs.html')
  ),
  jsonb_build_array(
    $ja$Audience Profiling & Decision-Making Modeling$ja$,
    $ja$WeChat Official Account & WeChat Channel Operation$ja$,
    $ja$Brand Content Asset Library Development$ja$
  ),
  jsonb_build_array(
    $ja$受众画像与决策建模$ja$,
    $ja$微信公众号 + 视频号运营$ja$,
    $ja$品牌内容资产库建设$ja$
  )
)
on conflict (report_date, report_id) do nothing;
