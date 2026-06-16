# JA 每日洞察对外 API · 接口文档

> 供其他项目按「用户」拉取**实时（每日）洞察**做展示。服务端鉴权、按目标用户的访问权限过滤。
> 版本：v1 · 更新：2026-06-16

---

## 1. 概述

- 通过一个 **API Key** 调用，传入**目标用户邮箱**和**日期**，返回该用户**有权访问**的当日实时洞察。
- 访问范围 = 该用户被分配的 **access group** + 全员公开（`default`）洞察，与站内看到的完全一致。
- 适用：其他系统给自己的用户展示「今日洞察 / 每日简报」。

**Base URL**

```
https://insights.jefurryaxis.ai/ja
```

> 所有路径都在该前缀下，例如完整地址 `https://insights.jefurryaxis.ai/ja/api/v1/daily`。

---

## 2. 鉴权

请求头携带 Bearer Token：

```
Authorization: Bearer ja_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

可用的 Key 有两类：

| 类型 | 说明 |
|------|------|
| **管理员 Key** | 全权限，可调用本接口 |
| **`query:daily` 服务 Key**（推荐） | 仅能调用本「每日洞察查询」接口，**不能**录入/管理，最小权限 |

**如何获取服务 Key**（由 JA 管理员操作，二选一）：

- **后台**：管理后台 → 🔑 Token 管理 → 生成表单勾选「**每日洞察查询 API（query:daily）**」→ 生成（明文只显示一次，请妥善保存）。
- **命令行**：`npm run create-key -- --email svc@yourapp.com --name "对接服务" --scopes query:daily`

> ⚠️ Key 是服务端密钥，请仅在**后端服务器**保存与使用，不要放进浏览器/前端代码。

---

## 3. 接口

### 3.1 查询某用户某日的每日洞察

```
GET /api/v1/daily
```

**Query 参数**

| 参数 | 必填 | 说明 | 默认 |
|------|------|------|------|
| `user` | 是 | 目标用户邮箱（须为 JA 已登记用户，见 §6） | — |
| `date` | 是 | 日期，格式 `YYYY-MM-DD` | — |
| `lang` | 否 | `en` / `zh` / `both` | `both` |
| `format` | 否 | `insights`（结构化数据）/ `cards`（后台同款渲染卡片，含 HTML） | `insights` |

**响应（`format=insights`，默认）**

```json
{
  "date": "2026-05-25",
  "user": { "email": "u@example.com", "name": "张三", "access_groups": ["NUS"] },
  "count": 2,
  "insights": [
    {
      "id": "uuid",
      "report_id": "01",
      "report_date": "2026-05-25",
      "access": ["NUS", "SMU"],
      "category": "中国教育市场",
      "status": "RADAR",
      "type": "daily-insights",
      "creator": null,
      "clients": "NUS, SMU",
      "tracks": "新加坡硕士项目 / 商学院 EMBA 与 MBA",
      "attributes": { "category_en": "China Education Market", "category_zh": "中国教育市场", "...": "..." },
      "title":   { "en": "English title", "zh": "中文标题" },
      "summary": { "en": "English summary", "zh": "中文摘要" },
      "insight": { "en": "English insight", "zh": "中文洞察" },
      "recommendations": { "en": ["rec 1", "rec 2"], "zh": ["建议 1", "建议 2"] },
      "sources": [ { "tier": "E", "title": "SCMP …", "url": "https://…" } ],
      "recommended_services": { "en": ["Service A"], "zh": ["受众画像与决策建模"] },
      "images": [ { "url": "https://…/x.png" } ],
      "created_at": "2026-05-25T…Z",
      "updated_at": "2026-05-25T…Z"
    }
  ]
}
```

字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| `report_id` | string | 当日编号（如 "01"，已按数值排序） |
| `report_date` | string | `YYYY-MM-DD` |
| `category` / `status` / `type` / `clients` / `tracks` | string | 元数据（分类/状态/类型/相关客户/适用赛道） |
| `title` / `summary` / `insight` | object | 按 `lang` 含 `en` 和/或 `zh` 键，值为字符串 |
| `recommendations` / `recommended_services` | object | 按 `lang` 含 `en`/`zh` 键，值为**字符串数组** |
| `sources` | array | 每项 `{ tier, title, url }` |
| `images` | array | 每项含 `url`（公开图片直链） |

> `lang=en` 时 `title` 形如 `{ "en": "…" }`（不含 `zh`）；`lang=zh` 反之；`both` 同时含两者。

**响应（`format=cards`）** —— 与站内每日洞察同款的**预渲染卡片**（字段为可直接插入页面的 HTML，省去自行渲染）：

```json
{
  "date": "2026-05-25",
  "user": { "email": "u@example.com", "name": "张三", "access_groups": ["NUS"] },
  "count": 2,
  "cards": [
    {
      "num": "01", "cat": "中国教育市场", "status": "RADAR", "clients": "NUS, SMU",
      "catLabel": "中国教育市场", "catLabelEn": "China Education Market",
      "hook": "<…标题 HTML…>", "hookEn": "<…title HTML…>",
      "sum": "<…摘要 HTML…>", "sumEn": "<…summary HTML…>",
      "ins": "<…洞察+建议 HTML…>", "insEn": "<…insight+recs HTML…>",
      "aud": "<…适用赛道 HTML…>", "audEn": "<…tracks HTML…>",
      "rec": "<…推荐服务 HTML…>", "recEn": "<…services HTML…>",
      "src": "<…信源 <a> HTML…>", "imgs": "<…<figure><img> HTML…>"
    }
  ]
}
```

> `cards` 里的文本字段均为 HTML，需用 `innerHTML` 注入；`num/cat/status/clients` 为纯文本。

---

### 3.2 查询某用户可见的所有日期

```
GET /api/v1/daily/dates?user=<email>
```

**响应**

```json
{ "user": { "email": "u@example.com" }, "dates": ["2026-05-29", "2026-05-25", "…"] }
```

> 倒序（最新在前）。用于先列日期、再按日期拉当天内容。

---

## 4. 错误码

| HTTP | 含义 | 响应体示例 |
|------|------|-----------|
| `400` | 缺少/非法参数（`user` 或 `date`） | `{"error":"缺少或非法的 date（YYYY-MM-DD）"}` |
| `401` | 缺少或无效的 API Key | `{"error":"需要有效的 API Key（Authorization: Bearer ja_...）"}` |
| `403` | Key 无权限（非管理员且无 `query:daily`） | `{"error":"此 API Key 无权调用（需要 query:daily 权限或管理员 Key）"}` |
| `404` | 目标用户不存在或未启用 | `{"error":"目标用户不存在或未启用：u@example.com"}` |
| `429` | 触发限流 | `{"error":"请求过于频繁（每分钟上限 120 次），请稍后再试"}` |
| `500` | 服务端错误 | `{"error":"…"}` |

成功为 `200`。

---

## 5. 限流

- 每个 Key 所属账号 **每分钟最多 120 次**，超出返回 `429`（带 `Retry-After: 60`）。
- 建议：先用 `/dates` 取日期，再按需拉取；对结果做缓存（同一用户+日期的内容当天基本不变）。

---

## 6. 访问与安全模型（重要）

- **目标用户必须是 JA 已登记用户**：其 access group 决定可见范围。新用户由 JA 管理员在「Token 管理 / create-key」中按邮箱登记并分配访问组。未登记 → `404`。
- **按目标用户过滤**：返回 = 该用户的 access group ∩ 洞察 `access` ∪ `default` 公开项。访问组**不由调用方传入**，一律服务端按邮箱解析，无法越权。
- **不暴露管理员全量**：即使目标邮箱是管理员，本接口也只返回其 group + `default`，**不**开放「看全部」的超级权限。
- **邮箱精确匹配**：大小写不敏感、不支持通配符（`%`、`_` 等会被当普通字符，无法用于枚举用户）。
- Key 仅服务端使用；如需浏览器跨域访问，请联系 JA 配置 CORS 允许的来源。

---

## 7. 调用示例

**curl**

```bash
curl -s "https://insights.jefurryaxis.ai/ja/api/v1/daily?user=u@example.com&date=2026-05-25&lang=zh" \
  -H "Authorization: Bearer ja_xxxxxxxxxxxxxxxxxxxx"
```

**Node.js (fetch)**

```js
const BASE = "https://insights.jefurryaxis.ai/ja";
const KEY  = process.env.JA_API_KEY;

async function getDaily(userEmail, date, lang = "both") {
  const url = `${BASE}/api/v1/daily?user=${encodeURIComponent(userEmail)}&date=${date}&lang=${lang}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`JA API ${r.status}: ${(await r.json()).error || ""}`);
  return r.json(); // { date, user, count, insights: [...] }
}
```

**Python (requests)**

```python
import requests, os
BASE = "https://insights.jefurryaxis.ai/ja"
KEY  = os.environ["JA_API_KEY"]

def get_daily(user_email, date, lang="both"):
    r = requests.get(f"{BASE}/api/v1/daily",
                     params={"user": user_email, "date": date, "lang": lang},
                     headers={"Authorization": f"Bearer {KEY}"})
    r.raise_for_status()
    return r.json()
```

---

## 8. 变更记录

- **v1（2026-06-16）**：首发。`GET /api/v1/daily`、`GET /api/v1/daily/dates`；`query:daily` 服务 Key；按目标用户访问控制；邮箱精确匹配（防枚举）；每分钟 120 次限流。
