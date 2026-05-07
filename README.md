<div align="center">

# Lite Claude UI

**轻量级 AI Agent 工作台 — 复刻 Claude.ai 的核心 Agentic 能力**

[![Live Demo](https://img.shields.io/badge/Demo-claude.yaoyuheng2001.me-blue?style=flat-square)](https://claude.yaoyuheng2001.me)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)

<br>

*Not just a chatbot — a full Agent with tool use, web search, code execution, and artifact generation.*

<br>

<img src="./docs/preview-light.png" alt="Light Theme" width="800">

</div>

---

## 为什么做这个？

市面上的开源 AI UI（LibreChat、Open WebUI）功能全但太重 — MongoDB、Redis、LangChain，512MB 的 VPS 跑不动。

**Lite Claude UI 用单文件 server.mjs + 纯前端实现了完整的 Agent 架构**：

- 单文件后端，零外部服务依赖
- 直连 Anthropic API（不套 LangChain）
- 全功能前端，无构建步骤
- 128MB 内存就能跑

---

## 功能展示

### Agentic Tool Use Loop

模型自主决定何时搜索、何时读取网页、何时写代码、何时生成文档：

```
用户提问
  → 模型推理 → 需要工具？
       ├─ web_search  → 搜索结果 → 继续推理
       ├─ fetch_url   → 读取网页 → 继续推理
       ├─ run_code    → 执行代码 → 继续推理
       ├─ create_artifact → 生成文档 → 结束
       └─ 不需要工具  → 直接回答
```

<img src="./docs/code-exec.png" alt="Code Interpreter & Tool Cards" width="600">

### 日/夜双主题

一键切换，偏好自动记忆。日光模式温暖纸质感，夜间模式深邃编辑器调。

| Light | Dark |
|-------|------|
| <img src="./docs/theme-light.png" width="380"> | <img src="./docs/theme-dark.png" width="380"> |

### 对话级文档管理

每个对话拥有独立的文档空间，多文档 tab 切换，版本历史可回退：

<img src="./docs/doc-panel.png" alt="Document panel with tabs" width="600">

### Code Interpreter

模型可自主执行 JavaScript / Python 代码，输出直接展示：

<img src="./docs/code-exec.png" alt="Code execution" width="500">

---

## 能力对比

| 能力 | Claude.ai | Lite Claude UI | LibreChat |
|------|-----------|----------------|-----------|
| Agent Loop | ✅ | ✅ | ✅ (LangChain) |
| Web Search | ✅ | ✅ 5-engine Fallback | ✅ Multi-provider |
| URL Fetch | ✅ | ✅ | ❌ |
| Code Execution | ✅ Sandbox | ✅ JS/Python | ✅ Docker |
| Artifacts | ✅ | ✅ HTML/MD/Code | ✅ |
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
| Runs on 128MB VPS | N/A | ✅ | ❌ (needs 2GB+) |
| MCP Support | ✅ | ❌ | ✅ |

---

## Quick Start

```bash
git clone https://github.com/piglet12138/lite-claude-ui.git
cd lite-claude-ui
npm install
cp .env.example .env   # 编辑配置
npm start              # → http://localhost:3040
```

### 环境变量

| 变量 | 必须 | 说明 |
|------|------|------|
| `LUCKY_BASE_URL` | ✅ | Anthropic API base URL |
| `LUCKY_API_KEY` | ✅ | API Key |
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
┌─────────────────────────────────────────────────────────┐
│  Browser (Vanilla JS)                                    │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────────┐ │
│  │ Sidebar  │  │   Chat    │  │   Document Panel     │ │
│  │ Threads  │  │ Messages  │  │ Preview / Source     │ │
│  │ Docs     │  │ Tool Cards│  │ Tabs / Versions      │ │
│  └──────────┘  └───────────┘  └──────────────────────┘ │
│                       │ SSE Stream                        │
└───────────────────────┼──────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  server.mjs + db.mjs                                 │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Agentic Loop (max 8 rounds, token budget mgmt)                     │    │
│  │                                                   │    │
│  │  Tools:                                           │    │
│  │  • web_search  (5-engine fallback + auto-fetch)           │    │
│  │  • fetch_url   (HTTP GET, HTML → text)           │    │
│  │  • run_code    (JS/Python, 15s timeout)          │    │
│  │  • create_artifact (HTML/Markdown/Code)          │    │
│  │  • generate_long_document (多agent并行, 50-100页)│    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  Context Compression · Retry Logic · Stream Parsing      │
└────────────────────────┼─────────────────────────────────┘
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
| 搜后深读策略 | 限制每轮搜索次数，鼓励深入阅读而非广撒网 |
| <<options>> 交互协议 | 系统提示定义结构化格式，前端解析渲染 |

---

## 项目结构

```
├── server.mjs           # 后端：Auth + Agentic Loop + Tools + Search
├── db.mjs               # SQLite 存储层（用户/会话/对话/消息/文档）
├── public/
│   ├── app.html         # 应用骨架
│   ├── app.js           # 前端：SSE解析、文档管理、主题切换
│   ├── styles.css       # 双主题 (Newsreader + DM Sans)
│   ├── index.html       # Landing page
│   └── logo.svg
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
scp server.mjs public/* user@server:/path/to/app/
ssh server 'cd /path/to/app && node server.mjs'
```

推荐用 `systemd` 或 `nohup` 保活。

---

## 更新日志

### 2026-05-07 — 交互增强 & Agentic 优化 & 稳定性修复

**交互功能：**
- 终止生成：流式输出时发送按钮变为红色停止按钮，可随时中断
- 编辑消息：用户消息支持编辑，回退到该时间点重新对话
- 采访/规划选项：AI 提出多选题，用户点选后自动提交（类似 claude.ai）
- 建议后续问题：回答末尾显示 2-3 个可点击的追问建议
- 刷新保持：流式生成中每 3 秒自动保存，刷新页面不丢失内容
- 跨设备同步：切换标签页/设备时自动刷新对话

**Agentic Loop 优化：**
- 搜后深读策略：限制每轮 1-2 次搜索，鼓励深入阅读全文后再搜
- Token 预算管理：80K token 预算，主动压缩早期轮次
- 工具可用性分层：搜索(前3轮) → 深读(前5轮) → 生成(后续)
- 未完成意图续接：检测到模型想创建文档但流断开时自动追加一轮
- 搜索结果保留量提升：从 600 字→4000 字/条

**稳定性修复：**
- 全局异常捕获：uncaughtException + try-catch 防进程崩溃
- 空 stopReason 推断：兼容上游 API 不返回 stop_reason 的情况
- 图片上传修复：Canvas 压缩 + HEIC 格式支持 + 错误提示

---

### 2026-05-07 — SQLite 存储 & 多引擎搜索 & 移动端优化

**存储层升级：**
- SQLite 持久化：用户/会话/对话/消息/文档全部服务端存储
- Session 持久化：服务重启不丢失登录状态
- 双层缓存架构：API 读写 + localStorage 缓存，首屏秒开
- 自动迁移：首次登录将 localStorage 旧数据上传到 SQLite

**多引擎搜索增强：**
- 5 引擎智能 Fallback：Serper (Google) > Tavily (AI) > Google CSE > Brave > DuckDuckGo
- 搜索后自动全文抓取 Top 3 结果（6000 字/页）
- 中文搜索修复：移除 Brave country=cn 导致返回空的 bug
- Agentic Loop 增强：8 轮上限，前 3 轮均可搜索
- 系统提示重写：鼓励深入全面回答 + 主动搜索验证

**移动端优化：**
- iOS 键盘适配（visualViewport）
- 触摸目标增大至 44px
- 全屏文档面板 + 防缩放 + PWA 支持

---

### 2026-05-07 — 长文档生成 & DOCX 导出

**新增功能：**
- 🔖 **多子Agent并行长文档生成**：支持生成 50-100 页的长篇文档，采用大纲规划→参考搜索→分章并行撰写→汇编的流水线架构
- 📥 **DOCX 导出**：一键下载 Word 文档，支持标题、段落、列表、表格等格式转换
- 📊 **生成进度实时推送**：通过 SSE 流式推送章节生成进度，工具卡片显示详细日志
- 🔄 **进度持久化**：刷新页面后可恢复查看生成进度状态

**修复：**
- 工具卡片流中断后仍显示加载动画 → 自动标记为完成
- 大纲 JSON 解析增强（兼容 trailing comma、全角标点、smart quotes）
- 子Agent移除 tools 参数，解决 LuckyAPI 兼容性问题

**优化：**
- 移除独立的"生成长文档"侧栏按钮，能力内化为 Agent 工具调用
- 简化导出：移除冗余按钮，智能下载（文档→DOCX，HTML→原始HTML）
- 子Agent密钥池轮询，独立于主聊天密钥

---

## Credits

- Powered by [Anthropic Claude](https://www.anthropic.com)
- Web search by [Serper](https://serper.dev) + [Tavily](https://tavily.com) + [Brave](https://brave.com/search/api/) + [DuckDuckGo](https://duckduckgo.com)
- Data storage by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- Typography: [Newsreader](https://fonts.google.com/specimen/Newsreader) + [DM Sans](https://fonts.google.com/specimen/DM+Sans)

## License

MIT

---

<div align="center">
<sub>Built with Claude Code · Not affiliated with Anthropic</sub>
</div>
