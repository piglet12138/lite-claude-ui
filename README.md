<div align="center">

# Claude AI Harness

**轻量级 AI Agent Harness — 复刻 Claude.ai 的核心 Agentic 能力**

[![Live Demo](https://img.shields.io/badge/Demo-claude.yaoyuheng2001.me-blue?style=flat-square)](https://claude.yaoyuheng2001.me)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Blog](https://img.shields.io/badge/Blog-掘金-1e80ff?style=flat-square)](https://juejin.cn/post/7637353693051781166)

<br>

*Not just a chatbot — a full Agent harness with tool use, web search, code execution, file generation, and artifact management.*

<br>

<img src="./docs/1.png" alt="主界面" width="800">

</div>

---

## 为什么叫 Harness？

这不是一个 Chat UI。它是一个 **Agent Harness** — 模型的执行环境。

就像 Claude Code 是 Claude 在终端里的 harness，Claude AI Harness 是 Claude 在浏览器里的 harness。模型在这里拥有搜索、读网页、跑代码、生成文件、创建文档的完整能力链，自主决定何时用什么工具。

市面上的开源方案（LibreChat、Open WebUI）功能全但太重 — MongoDB、Redis、LangChain，512MB 的 VPS 跑不动。**Claude AI Harness 用单文件 server.mjs + 纯前端实现了完整的 Agent 架构**：

- 单文件后端，零外部服务依赖
- 直连 Anthropic API（不套 LangChain）
- 全功能前端，无构建步骤
- 128MB 内存就能跑

---

## 核心能力

### Agentic Tool Use Loop

模型自主决定何时搜索、何时读取网页、何时写代码、何时生成文档：

```
用户提问
  → 模型推理 → 需要工具？
       ├─ web_search    → 搜索结果 → 继续推理
       ├─ fetch_url     → 读取网页 → 继续推理
       ├─ run_code      → 执行代码 / 生成文件 → 继续推理
       ├─ create_artifact → 生成文档 → 结束
       └─ 不需要工具    → 直接回答
```

**搜索 + 深度阅读：** 模型自主搜索多个角度，自动读取全文后回答

<img src="./docs/2.png" alt="Agent 搜索 + 深度阅读" width="700">

**搜索 + 代码执行 + 可视化：** 搜索真实数据 → 尝试 Python → 自动切换 Chart.js 方案

<img src="./docs/3.png" alt="代码执行 + 可视化" width="700">

### Office 文件生成（Anthropic Skills 集成）

`run_code` 内置 Office 文件生成能力，基于 [Anthropic Skills](https://github.com/anthropics/skills) 的知识：

| 格式 | 库 | 语言 |
|------|-----|------|
| Word (.docx) | docx-js | JavaScript |
| Excel (.xlsx) | openpyxl | Python |
| PowerPoint (.pptx) | pptxgenjs | JavaScript |
| PDF (.pdf) | reportlab | Python |

生成的文件自动出现在文档面板，可直接下载。和 Claude.ai 的 artifact 管理体验一致。

<img src="./docs/code-exec.png" alt="Code Interpreter & Tool Cards" width="600">

### 日/夜双主题

一键切换，偏好自动记忆。日光模式温暖纸质感，夜间模式深邃编辑器调。

| Light | Dark |
|-------|------|
| <img src="./docs/theme-light.png" width="380"> | <img src="./docs/theme-dark.png" width="380"> |

### 交互式选项 & 文档生成

模型主动提问明确需求，用户点选后生成高质量文档：

<img src="./docs/4.png" alt="先问再写 + 文档生成" width="700">

<img src="./docs/5.png" alt="交互式选项" width="500">

### 对话级文档管理

每个对话拥有独立的文档空间，多文档 tab 切换，版本历史可回退：

<img src="./docs/doc-panel.png" alt="Document panel with tabs" width="600">

### 长文档并行生成

多个子 Agent 并行撰写各章节，支持 50-100 页长篇文档，可预览和导出 DOCX：

<img src="./docs/6.png" alt="61 页白皮书生成" width="700">

---

## 能力对比

| 能力 | Claude.ai | Claude AI Harness | LibreChat |
|------|-----------|-------------------|-----------|
| Agent Loop | ✅ | ✅ | ✅ (LangChain) |
| Web Search | ✅ | ✅ 5-engine Fallback | ✅ Multi-provider |
| URL Fetch | ✅ | ✅ | ❌ |
| Code Execution | ✅ Sandbox | ✅ JS/Python | ✅ Docker |
| Artifacts | ✅ | ✅ HTML/MD/Code | ✅ |
| **Office File Gen** | ✅ | ✅ DOCX/XLSX/PPTX/PDF | ❌ |
| Long Doc Generation | ✅ | ✅ Multi-agent | ❌ |
| DOCX Export | ✅ | ✅ | ❌ |
| Doc Versioning | ✅ | ✅ | ❌ |
| Image Understanding | ✅ | ✅ | ✅ |
| Day/Night Theme | ✅ | ✅ | ✅ |
| SQLite Persistence | N/A | ✅ | ✅ (MongoDB) |
| Mobile Optimized | ✅ | ✅ | ✅ |
| Stop & Edit | ✅ | ✅ | ✅ |
| Interactive Options | ✅ | ✅ | ❌ |
| Follow-up Suggestions | ✅ | ✅ | ❌ |
| 文档分享 | N/A | ✅ 临时链接 | ❌ |
| Runs on 128MB VPS | N/A | ✅ | ❌ (needs 2GB+) |

---

## Quick Start

```bash
git clone https://github.com/piglet12138/claude-ai-harness.git
cd claude-ai-harness
npm install
pip install openpyxl reportlab pypdf   # Office 文件生成依赖
cp .env.example .env   # 编辑配置
npm start              # → http://localhost:3040
```

### 环境变量

| 变量 | 必须 | 说明 |
|------|------|------|
| `ANTHROPIC_BASE_URL` | ✅ | API base URL（默认 `https://api.anthropic.com/v1`） |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API Key |
| `MODEL` | | 模型名（默认 claude-opus-4-7） |
| `ACCESS_EMAIL` | ✅ | 登录账号 |
| `ACCESS_PASSWORD` | ✅ | 登录密码 |
| `ENABLE_WEB_SEARCH` | | `true` 启用搜索 |
| `BRAVE_SEARCH_API_KEY` | | Brave Search Key |
| `SERPER_API_KEY` | | [Serper.dev](https://serper.dev) Key (Google results) |
| `TAVILY_API_KEY` | | [Tavily](https://tavily.com) Key (AI search) |
| `GOOGLE_CSE_API_KEY` | | Google Custom Search API Key |
| `GOOGLE_CSE_CX` | | Google CSE Engine ID |
| `GOOGLE_CLIENT_ID` | | Google Docs 上传（可选） |
| `GOOGLE_CLIENT_SECRET` | | Google Docs 上传（可选） |

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (Vanilla JS)                                       │
│  ┌──────────┐  ┌───────────┐  ┌────────────────────────┐   │
│  │ Sidebar  │  │   Chat    │  │   Document Panel       │   │
│  │ Threads  │  │ Messages  │  │ Artifacts / Files      │   │
│  │ Docs     │  │ Tool Cards│  │ Preview / Download     │   │
│  └──────────┘  └───────────┘  └────────────────────────┘   │
│                       │ SSE Stream                           │
└───────────────────────┼─────────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  server.mjs + db.mjs                                        │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Agentic Loop (max 8 rounds, token budget mgmt)       │  │
│  │                                                       │  │
│  │  Tools:                                               │  │
│  │  • web_search  (5-engine fallback + auto-fetch)       │  │
│  │  • fetch_url   (HTTP GET, HTML → text)                │  │
│  │  • run_code    (JS/Python + Office file generation)   │  │
│  │  • create_artifact (HTML/Markdown/Code)               │  │
│  │  • generate_long_document (多agent并行, 50-100页)     │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  File Store (.generated-files/) · Context Compression       │
│  API Key Pool · Retry Logic · Stream Parsing                │
└─────────────────────────┼───────────────────────────────────┘
                          ▼
               Anthropic Messages API
```

### 关键设计决策

| 决策 | 理由 |
|------|------|
| Anthropic 原生 API（非 OpenAI 兼容） | 工具格式更稳定，避免格式转换 bug |
| 搜索后压缩 context | 避免 token 膨胀导致 400 |
| Artifact 后立即 break | 不把巨大文档带入下一轮 |
| 增量 DOM 更新 | 流式输出不闪烁 |
| 文档存入对话对象内 | 自然的生命周期管理 |
| CSS 变量 + data-theme | 一份代码两套主题 |
| SQLite + localStorage 双层 | 服务端持久 + 前端缓存加速首屏 |
| 5 引擎 Fallback 搜索 | 最大化免费额度，保证可用性 |
| 搜索后自动抓取全文 | 摘要不够深，全文才能支撑深度回答 |
| Token 预算管理 (80K) | 主动压缩上下文，防止 API 400 错误 |
| .cjs + module resolve 注入 | 让 run_code 的 JS 能 require() npm 包 |
| 文件 sidecar .meta.json | 服务重启后自动恢复文件下载链接 |

---

## 项目结构

```
├── server.mjs           # 后端：Auth + Agentic Loop + Tools + Search + File Store
├── db.mjs               # SQLite 存储层（用户/会话/对话/消息/文档）
├── public/
│   ├── app.html         # 应用骨架
│   ├── app.js           # 前端：SSE解析、文档管理、文件下载、主题切换
│   ├── styles.css       # 双主题 (Newsreader + DM Sans)
│   ├── index.html       # Landing page
│   └── logo.svg
├── .generated-files/    # 生成的 Office 文件（自动创建，7天过期）
├── .env.example
├── package.json
└── docs/                # README 截图
```

---

## 本地开发

```bash
node server.mjs
# 无需 Docker、无需数据库、无需构建步骤
```

## 部署

```bash
scp server.mjs db.mjs package.json public/* user@server:/path/to/app/
ssh server 'cd /path/to/app && npm install && pip install openpyxl reportlab pypdf && node server.mjs'
```

推荐用 `systemd` 或 `nohup` 保活。

---

## 更新日志

### 2026-05-13 — Office 文件生成 & 项目改名

**项目改名：** `lite-claude-ui` → `claude-ai-harness`，突出 Agent harness 定位而非 UI。

**Office 文件生成（Anthropic Skills 集成）：**
- `run_code` 支持生成 .docx/.xlsx/.pptx/.pdf/.csv 文件，自动捕获并提供下载
- 注入 Anthropic Skills 知识（docx-js、openpyxl、pptxgenjs、reportlab）到 system prompt
- 生成的文件进入文档面板统一管理，和 Claude.ai 的 artifact 体验一致
- JS 执行从 .mjs 切换到 .cjs，支持 require() 加载 npm 包
- 文件元数据通过 .meta.json sidecar 持久化，服务重启不丢失

---

### 2026-05-08 — 分享功能 & 移动端文档入口

- 文档面板"分享"按钮，生成 24h 有效临时链接
- 移动端浮动文档按钮（FAB），点击直接打开文档面板
- 文档同步合并策略，修复下载后文档丢失 bug

---

### 2026-05-07 — SQLite 存储 & 多引擎搜索 & 交互增强

- SQLite 全量持久化 + localStorage 双层缓存
- 5 引擎智能 Fallback 搜索 + 搜后自动全文抓取
- 终止生成、编辑消息、采访式选项、后续问题建议
- 搜后深读策略 + 80K Token 预算管理
- 多子 Agent 并行长文档生成 + DOCX 导出
- iOS 键盘适配 + PWA 支持

---

## Blog

- [自己写了一个 Claude Agent 前端之后，对 Agent 的一些想法](https://juejin.cn/post/7637353693051781166) — 掘金

## Credits

- Powered by [Anthropic Claude](https://www.anthropic.com)
- Office skills inspired by [Anthropic Skills](https://github.com/anthropics/skills)
- Web search by [Serper](https://serper.dev) + [Tavily](https://tavily.com) + [Brave](https://brave.com/search/api/) + [DuckDuckGo](https://duckduckgo.com)
- Data storage by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- Typography: [Newsreader](https://fonts.google.com/specimen/Newsreader) + [DM Sans](https://fonts.google.com/specimen/DM+Sans)

## License

MIT

---

<div align="center">
<sub>Built with Claude Code · Not affiliated with Anthropic</sub>
</div>
