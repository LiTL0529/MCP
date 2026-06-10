# JA Insight Hub — MCP Server

把「洞察报告」存进 **Supabase**，用 **pgvector** 对*英文版*的「标题 + 关键属性 + 摘要」做向量化，
并以 **MCP（Streamable HTTP）** 对外提供接口：经过授权的用户（带 API key）只能检索到自己有权访问的报告。

- **数据库**：Supabase / Postgres + pgvector
- **向量**：OpenAI `text-embedding-3-small`（1536 维），只向量化英文版；标题/摘要/关键属性/**图片**各存一个向量（**四路**），检索时分别打分、每篇取最高分
- **图片**：上传到 Supabase Storage，用**视觉大模型**（`gpt-4o-mini`/`qwen-vl-max`）生成英文描述，再把描述嵌入成 `image_embedding`——和文本同一向量空间，所以纯文字 query 也能命中图片
- **正文格式**：摘要 / 洞察 / 建议支持 **Markdown**，录入表单带实时预览，渲染成安全 HTML 显示在工作台卡片里
- **接入**：远程 HTTP MCP（`POST /mcp`），`Authorization: Bearer <api_key>` 鉴权
- **权限**：每用户一个 API key + 权限组；报告 `access` 命中用户权限组、或 `access=default` 时可见，admin 看全部
- **录入**：网页表单 `/submit.html` → 后端 `POST /api/insights`（自动生成英文向量入库）

---

## 1. 数据模型

> 所有对象都加了 `ja_` 前缀（`ja_users` / `ja_api_keys` / `ja_insights` 及 `ja_*` 函数），以便和同库里已有的 `insights` / `customer_pages` 等表共存、互不影响。

| 表 | 说明 |
|---|---|
| `ja_users` | 用户。`access_groups text[]`（如 `{NUS,SMU}`）、`is_admin` |
| `ja_api_keys` | 每用户可多把 key，只存 `sha256` 哈希；原始 key 创建时显示一次 |
| `ja_insights` | 洞察报告，中英双语字段 + `attributes jsonb`（关键属性）+ 三个 `vector(1536)`（标题/摘要/属性各一个） |

`insights` 关键列：

- 关键属性（JSON）：`attributes`（完整元数据块）；并把 `report_id / report_date / access / category / status / type / clients / tracks` 拍平成列方便过滤。
- 双语内容：`title_*`、`summary_*`、`insight_*`、`recommendations_*`（jsonb 数组）、`sources`（jsonb）、`recommended_services_*`。摘要 / 洞察 / 建议正文按 **Markdown** 编写。
- 图片：`images jsonb` = `[{url, alt, caption, description}]`；文件存 Supabase Storage 公开桶，`description` 由视觉模型生成。
- 向量：`title_embedding` / `summary_embedding` / `attributes_embedding` / `image_embedding` 四个 `vector(1536)`——前三个向量化英文标题/摘要/关键属性，第四个向量化所有图片描述拼成的文本（原文留在对应的 `*_emb_input`）。检索时对四者分别算余弦相似度、**每篇取 max**、按文章去重、返回**整篇双语全文 + 图片** + `similarity` + `matched_field`（命中 title/summary/attributes/**image**）。

**可见性规则**（集中在 SQL 函数 `ja_can_access` 里，Node 层不重复实现）：

```
可见  ⇔  是 admin  ∨  'default' ∈ access  ∨  access ∩ 用户权限组 ≠ ∅
```

检索/浏览/取详情分别走 `match_insights` / `list_insights` / `get_insight` 三个 RPC，
它们都接收调用者的 `(groups, is_admin)` 并在库内完成权限过滤。

---

## 2. 安装与配置

```bash
npm install
cp .env.example .env      # 填入下方变量
```

`.env`：

| 变量 | 说明 |
|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase 项目地址与 **service-role** key（仅服务端） |
| `OPENAI_API_KEY` | 生成向量用 |
| `OPENAI_EMBEDDING_MODEL` | 默认 `text-embedding-3-small` |
| `OPENAI_VISION_MODEL` | 描述图片的视觉模型，默认 `gpt-4o-mini`（DashScope 用 `qwen-vl-max`）。须与 embedding 同一 `OPENAI_BASE_URL`/key |
| `SUPABASE_STORAGE_BUCKET` | 存图片的公开桶，默认 `ja-insight-images`（建库脚本会自动创建） |
| `EMBEDDING_DIM` | 必须与迁移里的 `vector(N)` 一致（3-small = 1536） |
| `PORT` | HTTP 端口，默认 8787 |
| `INGEST_TOKEN` | 录入表单用的共享令牌（也可改用 admin API key） |
| `CORS_ORIGINS` | 表单跨域时填，逗号分隔；同源部署可留空 |
| `OPENAI_BASE_URL` | 可选，OpenAI 兼容端点（如阿里 DashScope）；留空走 OpenAI 官方 |

> **代理**：若环境里设了 `HTTPS_PROXY` / `HTTP_PROXY`（如国内访问 `api.openai.com`），服务端会自动让 OpenAI 与 Supabase 的请求走该代理，无需额外配置。

### 建库

最简单：把 `supabase/setup_all.sql` 整个粘进 **Supabase SQL Editor** 点 Run（含建表 + RPC + 示例数据，幂等可重复跑）。

或分开执行：

```
supabase/migrations/0001_init.sql        # 扩展、表、索引（含 HNSW 向量索引）
supabase/migrations/0002_functions.sql   # 权限 + 检索 RPC（ja_match_insights 等）
supabase/migrations/0003_split_embeddings.sql  # 单向量 → 三路（标题/摘要/属性）
supabase/migrations/0004_images.sql      # 第四路图片向量 + images 列 + Storage 公开桶
supabase/seed.sql                        # 可选：示例用户 + example.md 那篇文章（无向量）
```

> 已经建过老版本库的，单独跑一次 `0004_images.sql` 即可（幂等）。它会新增 `images` / `image_embedding` 列、重建三个检索 RPC、并创建 `ja-insight-images` 公开桶。

---

## 3. 运行

```bash
npm run dev      # tsx 热重载
# 或
npm run build && npm start
```

启动后：

- MCP：`POST http://localhost:8787/mcp`（需 `Authorization: Bearer <api_key>`）
- 录入表单：`http://localhost:8787/submit.html`
- 录入接口：`POST http://localhost:8787/api/insights`
- 健康检查：`GET http://localhost:8787/health`

---

## 4. 用户与 API key

```bash
# 建管理员
npm run create-key -- --email admin@jefferyasia.com --name "JA Admin" --admin

# 建普通用户并赋权限组（只能看到 access 命中 NUS/SMU 或 default 的报告）
npm run create-key -- --email zhang@nus.edu.sg --name "Zhang" --groups NUS,SMU

# 给已有用户再发一把 key
npm run create-key -- --email zhang@nus.edu.sg --label "mobile"
```

原始 key 只在创建时打印一次，请立即保存。

---

## 5. 录入洞察（三种方式）

**A. 网页表单**：打开 `/submit.html`，填中英文字段 + Ingest Token，点「发布」。后端自动用英文版生成向量入库。摘要 / 洞察 / 建议用 Markdown 编写（带实时预览）；「图片」区可上传图片，后端会上传到 Storage、用视觉模型生成描述并向量化。

**B. HTTP 接口**：

```bash
curl -X POST http://localhost:8787/api/insights \
  -H "Content-Type: application/json" \
  -H "X-Ingest-Token: <INGEST_TOKEN>" \
  -d '{
    "report_id":"03","report_date":"2026-06-01",
    "access":["NUS","SMU"],
    "category":"中国教育市场","status":"RADAR","type":"daily-insights",
    "title_en":"...","summary_en":"...",
    "title_zh":"...","summary_zh":"...",
    "recommendations_en":["...","..."],
    "sources":[{"tier":"E","title":"SCMP ...","url":"https://..."}]
  }'
```

`access` 留空 = `["default"]`（所有人可见）。也可用 admin 的 `Authorization: Bearer` 代替 `X-Ingest-Token`。
图片走 `images` 字段，每项 `{ "data": "data:image/png;base64,...", "caption": "...", "alt": "..." }`（上传到 Storage）或 `{ "url": "https://...", "caption": "..." }`（已托管的图）；后端会逐张生成视觉描述并向量化。

**C. 解析双语 .md**（example.md 那种「中文块 + 英文块」格式）：

```bash
npm run ingest-md -- "C:/path/to/example.md"
```

**给 seed 里的示例文章补向量**（或重嵌全部）：

```bash
npm run backfill          # 只嵌入 embedding 为空的
npm run backfill -- --all # 全部重嵌
```

---

## 6. 把 MCP 接到客户端

Streamable HTTP，鉴权走 header。Claude Code 示例（`.mcp.json`）：

```json
{
  "mcpServers": {
    "ja-insights": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer ja_xxx_your_key" }
    }
  }
}
```

不同 MCP 客户端的远程 HTTP + 自定义 header 配置方式略有差异，核心是把上面的 URL 和 `Authorization` 带上。

### MCP 工具

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `whoami` | 返回当前用户、权限组、是否 admin | — |
| `search_insights` | 语义检索（标题/摘要/属性/图片四向量分别打分取 max、去重、返回整篇全文 + 图片 + `matched_field`），仅返回有权访问的 | `query`(必填)、`limit`、`category`、`status`、`date_from`、`date_to`、`min_similarity`、`lang` |
| `list_insights` | 按条件浏览/分页（非语义） | `category`、`status`、`date_from`、`date_to`、`limit`、`offset`、`lang` |
| `get_insight` | 按 id 取整篇双语报告 | `id`(uuid)、`lang` |

`lang` ∈ `en` / `zh` / `both`（默认 `both`，前端可自行切换中英文）。
`get_insight` 对无权或不存在的 id 统一返回 `{found:false}`（不泄露是否存在）。

---

## 7. 网页工作台 Workbench

`http://localhost:8787/workbench.html` —— 用 demo 的样式做的整套前端工作台：

- **登录**：输入 API Key（`ja_...`），后端 `GET /api/me` 校验后存到 localStorage。
- **实时洞察**：从数据库按权限拉取并显示（`GET /api/daily?date=`、`GET /api/insights/dates`），支持日期切换、搜索、中英文切换。只会看到自己有 access 权限的洞察；非 admin 不显示「管理后台」。
- **管理后台 · 实时洞察上传**：上传 `example.md` 那种双语 `.md`，前端把原文 POST 到 `POST /api/insights/from-md`，后端解析→英文向量化→入库，刷新即显示。

给浏览器用的 REST（都走 `Authorization: Bearer <api_key>`，权限同 MCP）：

| 端点 | 作用 |
|---|---|
| `GET /api/me` | 当前用户身份与权限组 |
| `GET /api/insights` | 列表/分页（access 过滤） |
| `GET /api/insights/search?q=` | 语义检索 |
| `GET /api/insights/dates` | 有权访问的日期列表 |
| `GET /api/insights/:id` | 单篇双语全文 |
| `GET /api/daily?date=` | 某天的卡片（已渲染成工作台卡片结构） |
| `POST /api/insights` | 录入单篇（admin key 或 `INGEST_TOKEN`） |
| `POST /api/insights/from-md` | 上传双语 `.md` 批量录入 |

> **代理**：`.env` 里可设 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`（国内访问 OpenAI 用）。设了之后 OpenAI 与 Supabase 请求走代理、`localhost` 直连，无论服务由谁启动都生效。

---

## 7. 安全要点

- service-role key 与 `OPENAI_API_KEY` 只在服务端，绝不下发浏览器；表单只持有 `INGEST_TOKEN`。
- API key 只存哈希；轮换时把 `api_keys.revoked` 置 true 即可立刻失效。
- 权限过滤在 Postgres 函数内完成，Node 层即使写错也不会绕过 `access` 规则。
- 向量索引为 HNSW（cosine）；数据量大后可按 pgvector 文档调 `ef_search` / 重建索引。

---

## 目录结构

```
supabase/migrations/  0001_init · 0002_functions · 0003_split_embeddings · 0004_images
supabase/seed.sql · setup_all.sql
src/  config · supabase · embeddings · storage · mdrender · auth · insights · cardmap · mcp · http · server
scripts/  create-user · backfill-embeddings · ingest-md
public/   submit.html (录入表单) · workbench.html (工作台)
```
