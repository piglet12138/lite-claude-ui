# Lite Claude UI — Agentic AI Workbench

一个轻量的 Claude.ai 风格 AI 工作台，复刻了 Claude.ai 的核心 **Agentic 能力**：不只是聊天机器人，而是能自主推理、调用工具、搜索互联网、生成完整文档的 AI Agent。

> Unofficial project. This repository is not affiliated with Anthropic or Claude.

![Lite Claude UI screenshot](./docs/screenshot.svg)

## 不只是 Chatbot — 完整的 Agent 架构

传统聊天机器人是"一问一答"的管道：用户输入 → 模型输出 → 结束。

**Lite Claude UI 实现了完整的 Agentic Loop（工具使用循环）**，让模型能：

```
用户消息 → 模型推理 → 需要工具？
                        ├─ 是 → 调用工具 → 获取结果 → 继续推理（循环）
                        └─ 否 → 输出最终回答
```

这意味着模型可以：
- 自主决定搜索什么关键词（不是用户指定的）
- 搜索后判断信息不够，再次搜索
- 基于搜索结果自主创建完整文档
- 在一次对话中完成"研究 → 分析 → 写作"的完整链路

## Agentic 能力一览

| 能力 | 说明 | 类比 Claude.ai |
|------|------|----------------|
| **Tool Use Loop** | 模型自主决定调用工具，循环执行直到完成 | ✅ 核心能力 |
| **Web Search** | Brave Search API，模型自主决定搜索词和次数 | ✅ 联网搜索 |
| **Artifact 创建** | 通过工具调用生成文档/网页/代码，右侧面板预览 | ✅ Artifacts |
| **流式输出** | 实时流式展示思考和工具调用过程 | ✅ 流式响应 |
| **工具状态展示** | 前端显示搜索中/创建中等工具调用卡片 | ✅ 工具卡片 |
| **Google Docs 上传** | 生成文档直接上传到 Google Drive | ✅ 导出能力 |
| **图片理解** | 上传/粘贴图片，模型分析图片内容 | ✅ 视觉能力 |

## 技术架构

### 后端：Anthropic Native API + Tool Use Loop

```javascript
// 核心循环（简化）
for (let round = 0; round < MAX_ROUNDS; round++) {
  const result = await consumeAnthropicStream(apiCall);
  
  if (result.stopReason === "tool_use") {
    // 执行工具 → 压缩结果 → 下一轮
    for (const tool of result.toolUseBlocks) {
      await executeTool(tool);
    }
    continue;
  }
  break; // 最终回答已流式输出
}
```

关键设计决策：
- **Anthropic Messages API**（非 OpenAI 兼容格式）— 原生 Claude 工具支持更稳定
- **流式解析**：实时转发文本 delta，积累 tool_use 块
- **Context 压缩**：搜索结果不用冗长的 tool_use/tool_result 格式，而是压缩为文本注入，避免 context 膨胀
- **Artifact 分离**：create_artifact 后立即 break，不将巨大的文档内容带入下一轮
- **400 重试**：延迟重试 + context 压缩，应对 API 代理的限流

### 前端：SSE 事件驱动

```
event: tool_start    → 显示工具调用卡片（搜索中...）
event: tool_result   → 更新卡片为完成状态
event: artifact      → 在右侧面板渲染文档/网页
data: {"delta":""}   → 实时追加聊天文本
event: done          → 结束
```

### 系统提示词设计

系统提示词是 Agent 行为的蓝图：
- 引导模型深度思考、充分展开
- 明确 create_artifact 的行为模式：「简述意图 → 调用工具生成完整内容 → 简短收尾」
- 防止聊天正文和文档内容混淆

## Features

### Agent 能力
- Agentic Tool Use Loop（最多 5 轮工具循环）
- Web Search（Brave Search API，模型自主决定是否搜索、搜索什么）
- Artifact 创建（Markdown 文档、HTML 网页/应用、代码文件）
- 工具调用过程可视化（前端实时展示搜索/创建状态卡片）

### 界面体验
- Claude-like 暖色调纸张风格界面
- 流式响应 + 实时输出光标
- 右侧 Artifact/文档预览面板（Preview/Source 切换）
- 图片上传和粘贴（支持截图直接粘贴）
- .docx 文件导入（保留标题、列表、表格、链接、内联图片）
- 生成文档下载（Markdown/HTML）
- Google Docs 一键上传

### 工程特性
- 纯 HTML/CSS/JS 前端（无构建步骤）
- 单文件 Node.js 后端（~700 行）
- Anthropic Messages API 原生对接
- 最小依赖（仅 mammoth 用于 .docx 解析）
- 单用户密码登录
- 低内存 VPS 友好

## Quick Start

```bash
git clone https://github.com/piglet12138/lite-claude-ui.git
cd lite-claude-ui
npm install
cp .env.example .env
# Edit .env with your API key
npm start
```

## Environment Variables

| Name | Required | Description |
|------|----------|-------------|
| `LUCKY_BASE_URL` | Yes | Anthropic-compatible API base URL (e.g. `https://api.anthropic.com`) |
| `LUCKY_API_KEY` | Yes | API key |
| `MODEL` | No | Model name (default: `claude-opus-4-7`) |
| `ACCESS_EMAIL` | Yes | Login email |
| `ACCESS_PASSWORD` | Yes | Login password |
| `SESSION_SECRET` | Yes | Random string for cookie signing |
| `ENABLE_WEB_SEARCH` | No | `true` to enable Brave Search |
| `BRAVE_SEARCH_API_KEY` | No | Brave Search API key |
| `GOOGLE_CLIENT_ID` | No | For Google Docs upload |
| `GOOGLE_CLIENT_SECRET` | No | For Google Docs upload |

## How the Agent Architecture Works

详见项目内的白皮书：[AI Agent 设计与实现](./public/whitepaper-agent-design.html)

核心概念：

1. **Tool Use 是模型训练 + 系统工程的结合** — 模型在 fine-tuning 阶段学会了何时/如何调用工具，API 层做格式转换，应用层做执行
2. **Agent = While 循环 + LLM + 工具** — 本质就是不断调用模型、执行工具、直到模型认为任务完成
3. **Context 管理是核心挑战** — 搜索结果会膨胀 context，需要压缩策略避免超限

## Project Structure

```
.
├── server.mjs          # 后端：Auth + Agentic Loop + Tool Execution
├── public/
│   ├── app.js          # 前端：SSE 解析 + 工具卡片渲染 + Artifact 面板
│   ├── styles.css      # 样式
│   ├── app.html        # HTML 骨架
│   └── index.html      # Landing page
├── .env.example
└── package.json
```

## Comparison with Claude.ai

| 维度 | Claude.ai | Lite Claude UI |
|------|-----------|----------------|
| Agent Loop | ✅ | ✅ |
| Web Search | ✅ Brave | ✅ Brave |
| Artifacts | ✅ React/HTML/SVG/Mermaid | ✅ HTML/Markdown/Code |
| Code Execution | ✅ JS Sandbox | ❌ Not yet |
| Image Generation | ✅ | ❌ Not yet |
| Multi-turn Memory | ✅ | ❌ Not yet |
| Extended Thinking | ✅ | ❌ Not yet |

## License

MIT
