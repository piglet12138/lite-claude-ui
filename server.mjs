import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
import { dbUsers, dbSessions, dbThreads, dbMessages, dbDocuments, dbBulkImport } from "./db.mjs";
const XLSX = require("xlsx");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, TableRow, TableCell, Table, WidthType, BorderStyle, PageBreak } = require("docx");

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");

// Temporary share links (in-memory, expire after 24h)
const shareStore = new Map();
// Long document background jobs (in-memory, expire after 2h)
const longDocJobs = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of shareStore) {
    if (now > entry.expires) shareStore.delete(id);
  }
  for (const [id, job] of longDocJobs) {
    if (now - job.createdAt > 7200_000) longDocJobs.delete(id);
  }
}, 3600_000);
const env = await loadEnv(path.join(root, ".env"));
const port = Number(env.PORT || process.env.PORT || 3040);
const baseUrl = process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
const model = process.env.MODEL || env.MODEL || "claude-opus-4-7";
const accessEmail = process.env.ACCESS_EMAIL || env.ACCESS_EMAIL;
const accessPassword = process.env.ACCESS_PASSWORD || env.ACCESS_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET || env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const braveApiKey = process.env.BRAVE_SEARCH_API_KEY || env.BRAVE_SEARCH_API_KEY;
const serperApiKey = process.env.SERPER_API_KEY || env.SERPER_API_KEY || "";
const tavilyApiKey = process.env.TAVILY_API_KEY || env.TAVILY_API_KEY || "";
const googleCseApiKey = process.env.GOOGLE_CSE_API_KEY || env.GOOGLE_CSE_API_KEY || "";
const googleCseCx = process.env.GOOGLE_CSE_CX || env.GOOGLE_CSE_CX || "";
const webSearchEnabled = /^(true|1|yes)$/i.test(process.env.ENABLE_WEB_SEARCH || env.ENABLE_WEB_SEARCH || "false");
const webSearchCount = Math.max(1, Math.min(5, Number(process.env.WEB_SEARCH_RESULT_COUNT || env.WEB_SEARCH_RESULT_COUNT || 3)));
const webSearchQueryCount = Math.max(1, Math.min(3, Number(process.env.WEB_SEARCH_QUERY_COUNT || env.WEB_SEARCH_QUERY_COUNT || 2)));
const googleClientId = process.env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || env.GOOGLE_REDIRECT_URI;
const googleTokenFile = path.resolve(root, process.env.GOOGLE_TOKEN_FILE || env.GOOGLE_TOKEN_FILE || ".google-token.json");
const googleScopes = ["https://www.googleapis.com/auth/drive.file"];
const googleOauthStates = new Map();
// Global crash protection
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err.message, err.stack?.split("\n").slice(0, 3).join("\n"));
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", String(reason));
});

const agenticSystemPrompt = [
  "你是一个极其聪明、有深度的 AI 助手。默认用中文。不做身份声明。",
  "回答风格：深度优先，充分展开，结构清晰，不用空洞收尾语。",
  "",
  "## 工具使用策略（严格遵守）",
  "",
  "核心原则：**搜后深读，读完再搜**。宁可少搜几次读透内容，也不要广撒网浅尝辄止。",
  "",
  "搜索流程：",
  "1. 每轮最多调用 1-2 次 web_search（不同角度），不要一次搜 3 个以上",
  "2. 搜索结果中包含了自动抓取的页面全文 —— 认真阅读这些全文内容",
  "3. 如果全文信息不够，用 fetch_url 抓取其他感兴趣的搜索结果 URL",
  "4. 充分消化当前信息后，再决定是否需要换角度搜索",
  "5. 信息足够时立即开始回答，不要为了全面而过度搜索",
  "",
  "工具说明：",
  "- web_search：搜索互联网，返回摘要+自动抓取的全文。用精确关键词，不要整句搜索。",
  "- fetch_url：读取指定 URL 全文。用于深入阅读搜索结果或用户给的链接。",
  "- run_code：执行 JavaScript/Python 代码。用于计算、数据处理、验证。",
  "- generate_long_document：生成长篇报告/白皮书/论文。多个子Agent并行撰写，支持50-100页。",
  "- create_artifact：创建普通文档/网页/代码，显示在右侧面板。适合10页以内的内容。",
  "",
  "## 何时用 generate_long_document vs create_artifact（严格遵守）",
  "- 用户要求「完整报告」「全景报告」「白皮书」「详细文档」「至少X页」「长文档」→ **必须用 generate_long_document**",
  "- 用户要求 20 页以上、或明确说「完整」「全面」「详细」「深度」→ **必须用 generate_long_document**",
  "- 普通博客、短文档、代码、网页 → 用 create_artifact",
  "- **绝对不要**用 create_artifact 来生成需要 20 页以上的内容，它无法生成那么长的文档",
  "",
  "## create_artifact 规则",
  "1. 聊天中只用 1-2 句话说明意图",
  "2. 调用 create_artifact 生成完整内容（文档至少2000字，HTML要美观完整，代码要可运行）",
  "3. 之后用 1 句话收尾",
  "4. 绝不在聊天正文中写出文档全文内容",
  "",
  "必须用 create_artifact：写文档/报告/方案/邮件、做网页/可视化、写代码文件（10页以内）。",
  "不用：普通问答、短回复、简单列表。",
  "",
  "## 交互式选项",
  "",
  "你有两种交互格式可以使用：",
  "",
  "### 1. 采访/规划选项（当需要了解用户需求时）",
  "当用户的请求比较开放、需要更多信息时，先写一段简短分析（2-3句），然后一次性给出 3-5 个问题让用户选择。格式：",
  "<<options>>",
  '[{"question":"目标受众？","choices":[{"label":"技术人员"},{"label":"管理层"},{"label":"通用读者"}]},{"question":"篇幅偏好？","choices":[{"label":"简洁(1-2页)"},{"label":"中等(5-10页)"},{"label":"详尽(20页+)"}]},{"question":"语气风格？","choices":[{"label":"正式学术"},{"label":"商务专业"},{"label":"轻松易懂"}]}]',
  "<</options>>",
  "规则：",
  "- 一次给 3-5 个问题，每个问题 2-4 个选项",
  "- 每个 choice 有 label（必须），desc 可选",
  "- 用户点选后所有选择一次性发回",
  "- 正文先写一些分析/说明，然后给 <<options>>",
  "- 可以多轮对话。如果第一轮选择后还需要细化，可以继续用 <<options>> 追问",
  "- 任何时候需要用户做选择，都用 <<options>> 格式，不要用纯文本列表让用户自己打字",
  "- 也可以用于引导思考：比如「你觉得哪个方向更重要？」配选项",
  "- 收集到足够信息后直接开始工作",
  "- 适用：写文档、做方案、技术选型、复杂分析、引导用户思考",
  "",
  "### 2. 建议后续问题（回答完成后）",
  "在完整回答的末尾，生成 2-3 个后续追问建议。格式：",
  "<<suggestions>>",
  '["问题1", "问题2", "问题3"]',
  "<</suggestions>>",
  "规则：具体、有价值、20字以内。简单闲聊可以不加。",
].join("\n");

const anthropicTools = [
  {
    name: "web_search",
    description: "Search the web for current information, facts, data, news. Supports Chinese and English. Tips: (1) Use specific keywords, not full sentences. (2) For Chinese topics, search in Chinese. (3) Call multiple times with different angles for comprehensive research. (4) After searching, the system auto-reads top results for full content.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query, concise and specific" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch and extract text content from a URL. Use when you need to read a specific webpage, article, documentation, or any online resource. Returns the main text content.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "run_code",
    description: "Execute JavaScript or Python code in a sandboxed environment. Use for calculations, data processing, generating outputs, or demonstrating code. Returns stdout/stderr output.",
    input_schema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["javascript", "python"], description: "Programming language" },
        code: { type: "string", description: "The code to execute" },
      },
      required: ["language", "code"],
    },
  },
  {
    name: "generate_long_document",
    description: "Generate a long professional document (20-100 pages) by orchestrating multiple sub-agents writing in parallel. Use ONLY when the user explicitly requests a long/detailed document, report, white paper, or comprehensive guide that needs 20+ pages. Each sub-agent can search the web for up-to-date information. Do NOT use for short documents or simple questions.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Document topic and title" },
        requirements: { type: "string", description: "Detailed requirements: audience, scope, style, specific sections to include" },
        pages: { type: "number", description: "Target page count, 10-100. Default 30." },
      },
      required: ["topic"],
    },
  },
  {
    name: "create_artifact",
    description: "Create or update a rich document or interactive artifact displayed in the user's side panel. Use for: long-form documents, reports, HTML pages, interactive web apps, data visualizations, SVG graphics, code files. Do NOT use for short answers that fit in a chat message.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, max 50 chars" },
        type: { type: "string", enum: ["html", "document", "code"], description: "html: self-contained HTML/CSS/JS page or app. document: Markdown text. code: source code file." },
        content: { type: "string", description: "Full content of the artifact" },
        language: { type: "string", description: "e.g. html, markdown, javascript, python" },
        description: { type: "string", description: "One-line description of the artifact" },
        file_path: { type: "string", description: "Suggested filename, e.g. index.html, report.md" },
      },
      required: ["title", "type", "content"],
    },
  },
];
const apiEndpoint = `${baseUrl.replace(/\/v1\/?$/, "")}/v1/messages`;

// ---------------------------------------------------------------------------
// API Key Pool — round-robin with temporary cooldown on failure
// ---------------------------------------------------------------------------
// Keys from .env: ANTHROPIC_API_KEY is the primary, SUB_AGENT_KEYS is comma-separated extras
const allApiKeys = [
  apiKey,
  ...(process.env.SUB_AGENT_KEYS || env.SUB_AGENT_KEYS || "")
    .split(",").map(k => k.trim()).filter(Boolean),
].filter(Boolean);
const keyCooldowns = new Map(); // key -> cooldownUntil timestamp
const COOLDOWN_MS = 3 * 60_000; // 3 minutes cooldown after failure
let keyIndex = 0;

function pickKey(preferSub = false) {
  const now = Date.now();
  // If preferSub and we have >1 key, start from index 1 to skip primary
  const startOffset = (preferSub && allApiKeys.length > 1) ? 1 : 0;
  // Try all keys, starting from current index
  for (let i = 0; i < allApiKeys.length; i++) {
    const idx = (keyIndex + startOffset + i) % allApiKeys.length;
    const key = allApiKeys[idx];
    const coolUntil = keyCooldowns.get(key) || 0;
    if (now >= coolUntil) {
      keyIndex = idx + 1; // advance for next call
      return key;
    }
  }
  // All keys on cooldown — use the one that cools down soonest
  let bestKey = allApiKeys[0], bestTime = Infinity;
  for (const key of allApiKeys) {
    const t = keyCooldowns.get(key) || 0;
    if (t < bestTime) { bestTime = t; bestKey = key; }
  }
  console.log(`[KeyPool] All keys on cooldown, using least-cooled key (wait ${Math.round((bestTime - now) / 1000)}s)`);
  return bestKey;
}

function markKeyFailed(key, statusCode) {
  const cooldown = statusCode === 429 ? COOLDOWN_MS : COOLDOWN_MS * 2; // rate limit: 3min, balance/other: 6min
  keyCooldowns.set(key, Date.now() + cooldown);
  const masked = key.slice(0, 6) + "..." + key.slice(-4);
  console.log(`[KeyPool] Key ${masked} cooled down for ${cooldown / 1000}s (HTTP ${statusCode}), ${allApiKeys.length - [...keyCooldowns.values()].filter(t => t > Date.now()).length}/${allApiKeys.length} keys available`);
}

function markKeyOk(key) {
  keyCooldowns.delete(key); // clear cooldown on success
}

console.log(`[KeyPool] Loaded ${allApiKeys.length} API key(s)`);

if (!apiKey) {
  throw new Error("ANTHROPIC_API_KEY is required. Set it in .env or as an environment variable.");
}
if (!accessEmail || !accessPassword) {
  throw new Error("ACCESS_EMAIL and ACCESS_PASSWORD are required. Set them in .env or as environment variables.");
}

// ---------------------------------------------------------------------------
// User management (SQLite)
// ---------------------------------------------------------------------------
const loginAttempts = new Map(); // ip -> { count, resetAt }

function hashPwd(password, salt) {
  return crypto.createHash("sha256").update(password + salt).digest("hex");
}

function seedAdmin() {
  const existing = dbUsers.getByEmail(accessEmail);
  if (existing) return;
  // Also check if any users exist at all
  const users = dbUsers.list();
  if (users.length) return;
  const salt = crypto.randomBytes(16).toString("hex");
  dbUsers.create(crypto.randomUUID(), accessEmail, hashPwd(accessPassword, salt), salt, "admin");
}
seedAdmin();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/session") {
      const session = readSession(req);
      return json(res, { authenticated: Boolean(session), email: session?.email || "", role: session?.role || "", model });
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      const ip = req.socket.remoteAddress || "";
      if (isRateLimited(ip)) return json(res, { error: "操作过于频繁，请稍后再试" }, 429);
      const body = await readJson(req, 32 * 1024);
      const email = String(body?.email || "").trim().toLowerCase();
      const password = String(body?.password || "");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, { error: "邮箱格式不正确" }, 400);
      if (password.length < 6) return json(res, { error: "密码至少 6 位" }, 400);
      if (dbUsers.getByEmail(email)) return json(res, { error: "该邮箱已注册" }, 409);
      const salt = crypto.randomBytes(16).toString("hex");
      const user = { id: crypto.randomUUID(), email, passwordHash: hashPwd(password, salt), salt, role: "user" };
      dbUsers.create(user.id, email, user.passwordHash, salt, "user");
      const token = createSession(user);
      res.setHeader("Set-Cookie", `claude_lite=${token}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=604800`);
      return json(res, { ok: true, email: user.email });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const ip = req.socket.remoteAddress || "";
      if (isRateLimited(ip)) return json(res, { error: "操作过于频繁，请稍后再试" }, 429);
      const body = await readJson(req, 32 * 1024);
      const email = String(body?.email || "").trim().toLowerCase();
      const password = String(body?.password || "");
      const user = dbUsers.getByEmail(email);
      if (!user || hashPwd(password, user.salt) !== user.password_hash) {
        recordAttempt(ip);
        return json(res, { error: "账号或密码不正确" }, 401);
      }
      const token = createSession(user);
      res.setHeader("Set-Cookie", `claude_lite=${token}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=604800`);
      return json(res, { ok: true, email: user.email });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const session = readSession(req);
      if (session) dbSessions.delete(getCookieToken(req));
      res.setHeader("Set-Cookie", "claude_lite=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0");
      return json(res, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);
      return json(res, dbUsers.list());
    }

    // =========================================================================
    // Thread / Message / Document API (SQLite-backed)
    // =========================================================================

    if (req.method === "GET" && url.pathname === "/api/threads") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threads = dbThreads.list(session.userId);
      return json(res, threads);
    }

    if (req.method === "POST" && url.pathname === "/api/threads") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 64 * 1024);
      const id = body.id || crypto.randomUUID();
      dbThreads.create(id, session.userId, body.title || "新对话", body.archived ? 1 : 0, body.createdAt, body.updatedAt);
      return json(res, { ok: true, id });
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/threads/") && !url.pathname.includes("/messages") && !url.pathname.includes("/documents")) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      const body = await readJson(req, 32 * 1024);
      const existing = dbThreads.get(threadId, session.userId);
      if (!existing) return json(res, { error: "Not found" }, 404);
      dbThreads.update(threadId, session.userId, body.title ?? existing.title, body.archived ?? existing.archived);
      return json(res, { ok: true });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/threads/") && !url.pathname.includes("/messages") && !url.pathname.includes("/documents")) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      dbThreads.delete(threadId, session.userId);
      return json(res, { ok: true });
    }

    // Messages
    if (req.method === "GET" && url.pathname.match(/^\/api\/threads\/[^/]+\/messages$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      if (!dbThreads.get(threadId, session.userId)) return json(res, { error: "Not found" }, 404);
      const messages = dbMessages.list(threadId);
      return json(res, messages);
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/threads\/[^/]+\/messages$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      if (!dbThreads.get(threadId, session.userId)) return json(res, { error: "Not found" }, 404);
      const body = await readJson(req, 512 * 1024);
      if (Array.isArray(body)) {
        dbMessages.appendBatch(threadId, body);
      } else {
        dbMessages.append(threadId, body);
      }
      // Touch thread updated_at
      const t = dbThreads.get(threadId, session.userId);
      if (t) dbThreads.update(threadId, session.userId, t.title, t.archived);
      return json(res, { ok: true });
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/threads\/[^/]+\/messages$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      if (!dbThreads.get(threadId, session.userId)) return json(res, { error: "Not found" }, 404);
      const param = url.searchParams.get("action");
      if (param === "deleteLast") {
        dbMessages.deleteLast(threadId);
      } else {
        dbMessages.clearThread(threadId);
      }
      return json(res, { ok: true });
    }

    // Documents
    if (req.method === "GET" && url.pathname.match(/^\/api\/threads\/[^/]+\/documents$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      if (!dbThreads.get(threadId, session.userId)) return json(res, { error: "Not found" }, 404);
      return json(res, dbDocuments.list(threadId));
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/threads\/[^/]+\/documents$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const threadId = url.pathname.split("/")[3];
      if (!dbThreads.get(threadId, session.userId)) return json(res, { error: "Not found" }, 404);
      const doc = await readJson(req, 2 * 1024 * 1024);
      doc.id = doc.id || crypto.randomUUID();
      dbDocuments.upsert(threadId, doc);
      return json(res, { ok: true, id: doc.id });
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/documents\/[^/]+$/)) {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const docId = url.pathname.split("/")[3];
      dbDocuments.delete(docId);
      return json(res, { ok: true });
    }

    // Bulk import (migration from localStorage)
    if (req.method === "POST" && url.pathname === "/api/migrate") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 50 * 1024 * 1024); // up to 50MB
      const threads = Array.isArray(body.threads) ? body.threads : [];
      if (!threads.length) return json(res, { ok: true, imported: 0 });
      // Skip threads that already exist
      const existing = new Set(dbThreads.list(session.userId).map(t => t.id));
      const newThreads = threads.filter(t => !existing.has(t.id));
      if (newThreads.length) {
        dbBulkImport(session.userId, newThreads);
      }
      return json(res, { ok: true, imported: newThreads.length, skipped: threads.length - newThreads.length });
    }

        if (req.method === "POST" && url.pathname === "/api/bug-report") {
      const session = readSession(req);
      if (!session) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 10 * 1024 * 1024); // 10MB for images
      const text = String(body?.text || "").trim().slice(0, 2000);
      const rawImages = Array.isArray(body?.images) ? body.images.slice(0, 5) : [];
      if (!text && !rawImages.length) return json(res, { error: "内容不能为空" }, 400);
      // Save images to disk, store paths in report
      const imgDir = path.join(root, "bug-images");
      await fs.mkdir(imgDir, { recursive: true });
      const imagePaths = [];
      for (const dataUrl of rawImages) {
        if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) continue;
        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) continue;
        const ext = match[1] === "jpeg" ? "jpg" : match[1];
        const fname = `${crypto.randomBytes(8).toString("hex")}.${ext}`;
        await fs.writeFile(path.join(imgDir, fname), Buffer.from(match[2], "base64"));
        imagePaths.push(`/bug-images/${fname}`);
      }
      const reportsFile = path.join(root, "bug-reports.json");
      let reports = [];
      try { reports = JSON.parse(await fs.readFile(reportsFile, "utf8")); } catch {}
      reports.push({ id: crypto.randomUUID(), email: session.email, text, images: imagePaths, userAgent: String(req.headers["user-agent"] || "").slice(0, 200), createdAt: new Date().toISOString() });
      await fs.writeFile(reportsFile, JSON.stringify(reports, null, 2), "utf8");
      return json(res, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/bug-reports") {
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);
      const reportsFile = path.join(root, "bug-reports.json");
      let reports = [];
      try { reports = JSON.parse(await fs.readFile(reportsFile, "utf8")); } catch {}
      return json(res, reports.reverse());
    }

    if (req.method === "POST" && url.pathname === "/api/import-docx") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      return importDocx(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/google/status") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      return googleStatus(res);
    }

    if (req.method === "GET" && url.pathname === "/api/google/auth/start") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      return startGoogleAuth(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/google/callback") {
      return googleCallback(req, res, url);
    }

    if (req.method === "POST" && url.pathname === "/api/google/upload-doc") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 10 * 1024 * 1024);
      return uploadGoogleDoc(res, body);
    }

    // ── Long doc job status (disconnect recovery) ──
    if (req.method === "GET" && url.pathname.match(/^\/api\/job\/[^/]+$/)) {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      const jobId = url.pathname.split("/")[3];
      const job = longDocJobs.get(jobId);
      if (!job) return json(res, { error: "Job not found" }, 404);
      // Return progress since a given index (for incremental polling)
      const since = Number(url.searchParams?.get("since") || 0);
      return json(res, {
        id: job.id,
        status: job.status,
        progress: job.progress.slice(since),
        progressTotal: job.progress.length,
        artifact: job.status === "completed" ? job.artifact : null,
        error: job.error,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/search") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 32 * 1024);
      const results = await multiSearch(body?.query);
      return json(res, { results });
    }

    // ── Share: create temporary link ──
    if (req.method === "POST" && url.pathname === "/api/share") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req);
      const title = String(body?.title || "文档").slice(0, 200);
      const html = String(body?.html || "").slice(0, 2_000_000);
      if (!html) return json(res, { error: "No content" }, 400);
      const id = crypto.randomBytes(8).toString("hex");
      shareStore.set(id, { title, html, expires: Date.now() + 24 * 3600_000 });
      const shareUrl = `https://${req.headers.host || "claude.yaoyuheng2001.me"}/s/${id}`;
      return json(res, { url: shareUrl, id });
    }

    // ── Share: view shared document ──
    if (req.method === "GET" && url.pathname.startsWith("/s/")) {
      const id = url.pathname.slice(3);
      const entry = shareStore.get(id);
      if (!entry) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body style='font-family:system-ui;padding:40px;text-align:center'><h2>链接已过期</h2><p>分享链接有效期为 24 小时</p></body></html>");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(entry.html);
      return;
    }

    // ── Export as DOCX ──
    if (req.method === "POST" && url.pathname === "/api/export-docx") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      return exportDocx(req, res);
    }

        if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      return chat(req, res);
    }

    if (req.method === "GET" && url.pathname === "/app") {
      return staticFile("/app.html", res);
    }

    // Serve bug report images (admin only in practice, but images are random-named)
    if (req.method === "GET" && url.pathname.startsWith("/bug-images/")) {
      const fname = path.basename(url.pathname);
      const imgPath = path.join(root, "bug-images", fname);
      try {
        const data = await fs.readFile(imgPath);
        const ext = path.extname(fname);
        res.writeHead(200, { "content-type": mime[ext] || "image/png", "cache-control": "public, max-age=86400" });
        res.end(data);
        return;
      } catch { return notFound(res); }
    }

    return staticFile(url.pathname, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, { error: "Server error" }, 500);
    else res.end();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Claude listening on http://127.0.0.1:${port}`);
});

async function importDocx(req, res) {
  const buffer = await readBuffer(req, 16 * 1024 * 1024);
  const mammoth = await import("mammoth");
  const [htmlResult, textResult] = await Promise.all([
    mammoth.convertToHtml(
      { buffer },
      {
        convertImage: mammoth.images.imgElement(async (image) => ({
          src: `data:${image.contentType};base64,${await image.read("base64")}`,
        })),
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => p.subtitle:fresh",
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
          "p[style-name='Quote'] => blockquote:fresh",
        ],
      },
    ),
    mammoth.extractRawText({ buffer }),
  ]);
  const content = String(textResult.value || "").trim();
  const html = wrapDocxHtml(String(htmlResult.value || ""), decodeURIComponent(req.headers["x-file-name"] || "Document"));
  return json(res, {
    content,
    html,
    warnings: [...(htmlResult.messages || []), ...(textResult.messages || [])].map((message) => String(message.message || message)).slice(0, 8),
  });
}

async function googleStatus(res) {
  return json(res, {
    configured: googleConfigured(),
    connected: googleConfigured() && Boolean(await readGoogleToken()),
  });
}

function startGoogleAuth(req, res) {
  if (!googleConfigured()) return html(res, googleCallbackPage("Google OAuth 未配置", "请先在 .env 中配置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET。"), 500);
  const url = new URL(req.url || "/", "http://localhost");
  const redirectUri = getGoogleRedirectUri(req);
  const state = crypto.randomBytes(24).toString("base64url");
  googleOauthStates.set(state, {
    createdAt: Date.now(),
    redirectUri,
    mode: url.searchParams.get("mode") === "redirect" ? "redirect" : "popup",
  });
  cleanupGoogleStates();
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", googleClientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", googleScopes.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  res.writeHead(302, { location: authUrl.toString(), "cache-control": "no-store" });
  res.end();
}

async function googleCallback(req, res, url) {
  if (!googleConfigured()) return html(res, googleCallbackPage("Google OAuth 未配置", "请先配置 Google OAuth 客户端。"), 500);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const error = url.searchParams.get("error") || "";
  const stateData = googleOauthStates.get(state);
  googleOauthStates.delete(state);
  if (error) return html(res, googleCallbackPage("Google 授权失败", escapeHtml(error)), 400);
  if (!code || !stateData || Date.now() - stateData.createdAt > 10 * 60_000) {
    return html(res, googleCallbackPage("Google 授权已失效", "请回到页面重新点击上传。"), 400);
  }
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: stateData.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !token.access_token) {
    return html(res, googleCallbackPage("Google 授权失败", escapeHtml(token.error_description || token.error || "Token exchange failed")), 502);
  }
  const existing = await readGoogleToken();
  await writeGoogleToken({
    ...existing,
    ...token,
    refresh_token: token.refresh_token || existing?.refresh_token,
    expiry_date: Date.now() + Math.max(30, Number(token.expires_in || 3600) - 60) * 1000,
  });
  return html(
    res,
    googleCallbackPage(
      "Google Docs 已连接",
      stateData.mode === "redirect" ? "正在返回并继续上传文档。" : "你可以关闭这个窗口并回到文档上传。",
      stateData.mode,
    ),
  );
}

async function uploadGoogleDoc(res, body) {
  if (!googleConfigured()) return json(res, { error: "Google OAuth is not configured" }, 428);
  const title = safeDriveName(body?.title || "Untitled document");
  const htmlContent = String(body?.html || "").slice(0, 8_000_000);
  if (!htmlContent.trim()) return json(res, { error: "Document is empty" }, 400);
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) return json(res, { error: "Google account is not connected" }, 428);

  const boundary = `lite_claude_${crypto.randomBytes(12).toString("hex")}`;
  const metadata = JSON.stringify({
    name: title,
    mimeType: "application/vnd.google-apps.document",
  });
  const bodyBuffer = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\ncontent-type: text/html; charset=utf-8\r\n\r\n`),
    Buffer.from(ensureUploadHtml(htmlContent, title), "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const upload = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": `multipart/related; boundary=${boundary}`,
      "content-length": String(bodyBuffer.length),
    },
    body: bodyBuffer,
  });
  const data = await upload.json().catch(async () => ({ error: await upload.text().catch(() => "") }));
  if (!upload.ok) return json(res, { error: `Google Drive upload failed ${upload.status}`, detail: data }, 502);
  return json(res, { ok: true, file: data });
}

async function chat(req, res) {
  const body = await readJson(req, 50 * 1024 * 1024);
  const messages = Array.isArray(body?.messages) ? body.messages.slice(-24) : [];
  const chatThreadId = body?.threadId || null; // for persisting artifacts to SQLite
  // Preprocess: extract text from binary file attachments (PDF, XLSX)
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      const part = msg.content[i];
      if (part?.type === "pdf_url" && part.pdf_url?.url) {
        const pdfText = await extractPdfText(part.pdf_url.url, part.pdf_url.name);
        msg.content[i] = { type: "text", text: pdfText };
      } else if (part?.type === "file_url" && part.file_url?.url) {
        const fileText = await extractFileText(part.file_url.url, part.file_url.name);
        msg.content[i] = { type: "text", text: fileText };
      }
    }
  }
  const temperature = Number.isFinite(body?.temperature) ? body.temperature : 0.7;

  // Convert frontend messages to Anthropic format
  let apiMessages = toAnthropicMessages(messages);

  // Build available tools
  const tools = anthropicTools.filter((t) => {
    if (t.name === "web_search") return webSearchEnabled && braveApiKey;
    return true;
  });

  // Start SSE response to frontend
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();
  res.write(": stream\n\n");

  const MAX_ROUNDS = 8;

  const TOKEN_BUDGET = 80000; // Conservative budget to leave room for response

  try {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    console.log(`[Chat] Round ${round} start, messages: ${apiMessages.length}, est tokens: ${estimateTokens(apiMessages)}`);
    const isLastRound = round === MAX_ROUNDS - 1;
    // Proactive context management: compress if approaching budget
    if (round > 0) {
      apiMessages = budgetCompress(apiMessages, TOKEN_BUDGET);
    }
    // Search allowed in first 3 rounds, fetch_url in first 5
    const roundTools = round < 3
      ? tools
      : round < 5
        ? tools.filter((t) => t.name !== "web_search")
        : tools.filter((t) => t.name !== "web_search" && t.name !== "fetch_url");

    const upstreamBody = {
      model,
      max_tokens: 32768,
      stream: true,
      temperature,
      system: agenticSystemPrompt,
      messages: apiMessages,
      ...(!isLastRound && roundTools.length ? { tools: roundTools } : {}),
    };

    console.log(`[Chat] Round ${round}: sending to API, body size: ${JSON.stringify(upstreamBody).length} chars`);
    const upstream = await fetch(apiEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2024-10-22",
      },
      body: JSON.stringify(upstreamBody),
    });
    console.log(`[Chat] Round ${round}: API responded ${upstream.status}`);

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      // On 400, wait briefly then retry (handles both rate limits and context size)
      if (upstream.status === 400) {
        await delay(1500);
        const compressedMessages = round === 0 ? apiMessages : compressMessages(apiMessages);
        const retryBody = {
          model, max_tokens: 32768, stream: true, temperature,
          system: agenticSystemPrompt,
          messages: compressedMessages,
          tools: tools.length ? tools : undefined,
        };
        const retry = await fetch(apiEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2024-10-22" },
          body: JSON.stringify(retryBody),
        });
        if (retry.ok && retry.body) {
          const retryResult = await consumeAnthropicStream(retry.body, res);
          // Handle tool calls from retry (mainly create_artifact)
          if (retryResult.stopReason === "tool_use" && retryResult.toolUseBlocks.length) {
            for (const tc of retryResult.toolUseBlocks) {
              res.write(`event: tool_start\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, args: toolDisplayArgs(tc.name, tc.input) })}\n\n`);
              console.log(`[Chat] Executing tool: ${tc.name}`);
        const toolResult = await executeTool(tc.name, tc.input, res);
              if (tc.name === "create_artifact") {
                const artifactDoc = { title: tc.input.title || "Artifact", type: tc.input.type || "html", content: tc.input.content || "", language: tc.input.language || "", description: tc.input.description || "", file_path: tc.input.file_path || "" };
                if (chatThreadId) { try { dbDocuments.upsert(chatThreadId, { id: crypto.randomUUID(), ...artifactDoc }); } catch {} }
                try { res.write(`event: artifact\ndata: ${JSON.stringify(artifactDoc)}\n\n`); } catch {}
              }
              res.write(`event: tool_result\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, summary: toolResult.summary, sources: toolResult.sources || undefined })}\n\n`);
              res.flush?.();
            }
          }
          break;
        }
      }
      res.write(`data: ${JSON.stringify({ delta: `请求失败 (${upstream.status})：${errText.slice(0, 200)}` })}\n\n`);
      break;
    }

    const result = await consumeAnthropicStream(upstream.body, res);
    // Normalize: if stopReason is empty/missing, infer from content
    if (!result.stopReason) {
      result.stopReason = result.toolUseBlocks?.length ? "tool_use" : "end_turn";
      console.log(`[Chat] Round ${round}: stopReason was empty, inferred as ${result.stopReason}`);
    }
    console.log(`[Chat] Round ${round}: stream consumed, stopReason=${result.stopReason}, toolUse=${result.toolUseBlocks?.length || 0}`);

    if (result.stopReason === "tool_use" && result.toolUseBlocks.length) {
      const allSearches = result.toolUseBlocks.every((t) => t.name === "web_search");
      // Add assistant tool_use blocks (required for non-search tool calls)
      if (!allSearches) {
        // Trim any huge text blocks in allBlocks to avoid context bloat
        const trimmedBlocks = result.allBlocks.map(b => {
          if (b.type === "text" && b.text && b.text.length > 5000) {
            return { ...b, text: b.text.slice(0, 5000) + "..." };
          }
          return b;
        });
        apiMessages.push({ role: "assistant", content: trimmedBlocks });
      }

      // Execute tools and build tool_result blocks
      const toolResultBlocks = [];
      let hasArtifact = false;
      for (const tc of result.toolUseBlocks) {
        res.write(`event: tool_start\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, args: toolDisplayArgs(tc.name, tc.input) })}\n\n`);
        res.flush?.();

        const toolResult = await executeTool(tc.name, tc.input, res);

        if (tc.name === "create_artifact") {
          hasArtifact = true;
          const artifactDoc = {
            title: tc.input.title || "Artifact",
            type: tc.input.type || "html",
            content: tc.input.content || "",
            language: tc.input.language || "",
            description: tc.input.description || "",
            file_path: tc.input.file_path || "",
          };
          // Persist to SQLite immediately (survives client disconnect)
          if (chatThreadId) {
            try {
              const docId = crypto.randomUUID();
              dbDocuments.upsert(chatThreadId, { id: docId, ...artifactDoc });
            } catch (e) { console.error("[Chat] Failed to persist artifact:", e.message); }
          }
          try {
            res.write(`event: artifact\ndata: ${JSON.stringify(artifactDoc)}\n\n`);
            res.flush?.();
          } catch {}
        }

        res.write(`event: tool_result\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, summary: toolResult.summary, sources: toolResult.sources || undefined, codeResult: toolResult.codeResult || undefined })}\n\n`);
        res.flush?.();

        // Cap tool result content to prevent context explosion
        const maxResultLen = tc.name === "web_search" ? 12000
          : tc.name === "fetch_url" ? 10000
          : tc.name === "run_code" ? 5000
          : 3000;
        const resultContent = typeof toolResult.content === "string"
          ? toolResult.content.slice(0, maxResultLen)
          : toolResult.content;
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: resultContent,
        });
      }

      // Compact approach: avoid carrying huge content into next round
      if (hasArtifact) {
        // Compress: replace the full assistant tool_use blocks with a summary
        // so artifact content doesn't bloat the context
        const artifactNames = result.toolUseBlocks
          .filter((t) => t.name === "create_artifact")
          .map((t) => t.input?.title || "Artifact");
        apiMessages.pop(); // remove the verbose assistant content we just pushed
        apiMessages.push({ role: "assistant", content: `已创建文档：${artifactNames.join("、")}。` });
        apiMessages.push({ role: "user", content: "文档已生成。如果还有其他需要补充说明的内容或建议，请简要说明。" });
      } else if (allSearches && toolResultBlocks.length) {
        // Keep meaningful content from each search for the next round
        const searchSummary = toolResultBlocks
          .map((b) => String(b.content || "").slice(0, 4000))
          .filter(Boolean)
          .join("\n\n---\n\n");
        console.log(`[Chat] allSearches branch: ${toolResultBlocks.length} results, summary ${searchSummary.length} chars`);
        apiMessages.push({ role: "assistant", content: `我搜索了相关信息，以下是搜索结果摘要：\n\n${searchSummary.slice(0, 12000)}` });
        apiMessages.push({ role: "user", content: "请仔细阅读以上搜索结果和全文内容。如果信息已经足够回答问题，请直接给出深入全面的回答。如果某个方面信息不足，可以用 fetch_url 深入阅读某篇文章，或换角度再搜一次。不要重复搜索已有信息。" });
      } else {
        console.log(`[Chat] Non-search tool results: ${toolResultBlocks.length} blocks`);
        apiMessages.push({ role: "user", content: toolResultBlocks });
      }
      continue; // Next round
    }

    // No tool calls — check if model intended to use a tool but stream was cut short
    if (result.textContent && !result.toolUseBlocks?.length && round < MAX_ROUNDS - 1) {
      const text = result.textContent.slice(-200);
      const wantsArtifact = /生成|创建|整理成|输出|写一份|制作/.test(text) && /报告|文档|方案|调研|表格|artifact/i.test(text);
      if (wantsArtifact) {
        console.log(`[Chat] Round ${round}: detected unfinished artifact intent, auto-continuing`);
        apiMessages.push({ role: "assistant", content: result.textContent });
        apiMessages.push({ role: "user", content: "请继续，使用 create_artifact 工具生成完整内容。" });
        continue;
      }
    }
    break;
  }

  } catch (loopErr) {
    console.error("[Chat] Agentic loop error:", loopErr.message, "\n", loopErr.stack);
    try {
      res.write(`data: ${JSON.stringify({ delta: `\n\n---\n请求出错：${String(loopErr.message).slice(0, 200)}` })}\n\n`);
    } catch {}
  }
  try {
    res.write("event: done\ndata: {}\n\n");
    res.end();
  } catch {}
}

// ---------------------------------------------------------------------------
// Convert frontend messages (OpenAI-ish) to Anthropic Messages API format
// ---------------------------------------------------------------------------
function toAnthropicMessages(messages) {
  const result = [];
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    const content = toAnthropicContent(msg.content, role);
    // Anthropic requires alternating user/assistant — merge consecutive same-role
    if (result.length && result.at(-1).role === role) {
      const prev = result.at(-1);
      prev.content = Array.isArray(prev.content)
        ? [...prev.content, ...(Array.isArray(content) ? content : [{ type: "text", text: content }])]
        : [{ type: "text", text: prev.content }, ...(Array.isArray(content) ? content : [{ type: "text", text: content }])];
    } else {
      result.push({ role, content });
    }
  }
  return result;
}

function toAnthropicContent(content, role) {
  if (!Array.isArray(content)) return String(content || "").slice(0, 120000);
  const blocks = [];
  for (const part of content) {
    if (part?.type === "pdf_url") console.log("[PDF] found pdf_url part, name:", part.pdf_url?.name, "url length:", (part.pdf_url?.url || "").length);
    if (part?.type === "image_url") {
      const url = part.image_url?.url || (typeof part.image_url === "string" ? part.image_url : "");
      const parsed = parseDataImage(url);
      if (parsed) {
        blocks.push({ type: "image", source: parsed });
      } else if (url) {
        // Fallback: if data URL parsing failed, tell the model an image was attached
        blocks.push({ type: "text", text: "[用户上传了一张图片，但解析失败]" });
      }
    } else if (part?.type === "pdf_url") {
      // PDF should already be preprocessed to text in chat(); fallback just in case
      blocks.push({ type: "text", text: "[PDF attachment - content not extracted]" });
    } else if (part?.type === "file_url") {
      blocks.push({ type: "text", text: "[File attachment - content not extracted]" });
    } else {
      const text = String(part?.text || "").slice(0, 120000);
      if (text) blocks.push({ type: "text", text });
    }
  }
  return blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks;
}

// ---------------------------------------------------------------------------
// Anthropic streaming parser — forwards text deltas to client, accumulates
// tool_use blocks, returns everything when the stream ends.
// ---------------------------------------------------------------------------
async function consumeAnthropicStream(body, res) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let textContent = "";
  const allBlocks = [];     // complete content blocks for context
  let currentBlock = null;
  let stopReason = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    let eventType = "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;

      try {
        const data = JSON.parse(raw);

        switch (eventType) {
          case "content_block_start":
            currentBlock = { ...data.content_block };
            if (currentBlock.type === "tool_use") {
              currentBlock._inputJson = "";
            }
            break;

          case "content_block_delta":
            if (data.delta?.type === "text_delta" && data.delta.text) {
              textContent += data.delta.text;
              if (currentBlock) currentBlock.text = (currentBlock.text || "") + data.delta.text;
              res.write(`data: ${JSON.stringify({ delta: data.delta.text })}\n\n`);
              res.flush?.();
            }
            if (data.delta?.type === "input_json_delta" && data.delta.partial_json != null) {
              if (currentBlock) currentBlock._inputJson = (currentBlock._inputJson || "") + data.delta.partial_json;
            }
            break;

          case "content_block_stop":
            if (currentBlock) {
              if (currentBlock.type === "tool_use") {
                currentBlock.input = safeParseJson(currentBlock._inputJson);
                delete currentBlock._inputJson;
              }
              allBlocks.push(currentBlock);
              currentBlock = null;
            }
            break;

          case "message_delta":
            if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
            break;
        }
      } catch {
        // Ignore malformed
      }
    }
  }

  return {
    textContent,
    allBlocks: allBlocks.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text || "" };
      if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      return b;
    }),
    toolUseBlocks: allBlocks.filter((b) => b.type === "tool_use"),
    stopReason,
  };
}

// ---------------------------------------------------------------------------
// Tool execution dispatcher
// ---------------------------------------------------------------------------
async function executeTool(name, args, res = null) {
  switch (name) {
    case "web_search": {
      const query = String(args?.query || "").trim();
      if (!query) return { summary: "空查询", content: "No query provided.", sources: [] };

      // Smart multi-engine search with fallback chain
      const results = await multiSearch(query);
      if (!results.length) return { summary: "无结果", content: `No search results found for: ${query}`, sources: [] };

      // Auto-fetch top 2-3 results for full content
      const fetchable = results.filter(r => r.url && r.url.startsWith("http"));
      const fetchCount = Math.min(3, fetchable.length);
      const fetchPromises = fetchable.slice(0, fetchCount).map(r =>
        fetchPageText(r.url, 6000).catch(() => "")
      );
      const fullTexts = await Promise.all(fetchPromises);

      // Build rich output
      let fetchIdx = 0;
      const formatted = results
        .map((r, i) => {
          let entry = `[${i + 1}] ${r.title}${r.age ? ` (${r.age})` : ""}`;
          if (r.url) entry += `\nURL: ${r.url}`;
          entry += `\n${r.description}`;
          if (r.url && fetchIdx < fetchCount && fetchable[fetchIdx]?.url === r.url) {
            if (fullTexts[fetchIdx]) {
              entry += `\n--- 页面内容 ---\n${fullTexts[fetchIdx]}`;
            }
            fetchIdx++;
          }
          return entry;
        })
        .join("\n\n");

      const sources = results.filter(r => r.url).map((r) => ({ title: r.title, url: r.url, snippet: r.description.slice(0, 180) }));
      const fetchedCount = fullTexts.filter(Boolean).length;
      return { summary: `${results.length} 条结果${fetchedCount ? ` (已读取 ${fetchedCount} 篇全文)` : ""}`, content: formatted.slice(0, 15000), sources };
    }
    case "fetch_url": {
      const url = String(args?.url || "").trim();
      if (!url) return { summary: "空 URL", content: "No URL provided." };
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(url, {
          headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timeout);
        if (!resp.ok) return { summary: `HTTP ${resp.status}`, content: `Failed to fetch: HTTP ${resp.status}` };
        const html = await resp.text();
        const text = extractTextFromHtml(html).slice(0, 12000);
        const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim().slice(0, 100);
        return { summary: title || url.slice(0, 40), content: `[${title || url}]\n\n${text}` };
      } catch (e) {
        return { summary: "抓取失败", content: `Fetch error: ${e.message}` };
      }
    }
    case "run_code": {
      const lang = String(args?.language || "javascript");
      const code = String(args?.code || "");
      if (!code.trim()) return { summary: "空代码", content: "No code provided." };
      try {
        const result = await executeCode(lang, code);
        return { summary: result.error ? "执行出错" : "执行完成", content: result.output.slice(0, 4000), codeResult: result };
      } catch (e) {
        return { summary: "执行���败", content: `Error: ${e.message}` };
      }
    }
    case "generate_long_document": {
      const topic = String(args?.topic || "").trim();
      if (!topic) return { summary: "空主题", content: "No topic provided." };
      const result = await executeGenerateLongDoc(args, res);
      return result;
    }
    case "create_artifact": {
      const title = String(args?.title || "Artifact").slice(0, 50);
      return {
        summary: `已创建「${title}」`,
        content: `Artifact "${title}" has been created and is now visible in the user's preview panel.`,
      };
    }
    default:
      return { summary: "未知工具", content: `Unknown tool: ${name}` };
  }
}

// Compress messages for retry after 400 — flatten tool exchanges into a single user summary
// Estimate token count (rough: 1 token ≈ 3.5 chars for mixed zh/en)
function estimateTokens(messages) {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") chars += (block.text || "").length;
        else if (block.type === "tool_use") chars += JSON.stringify(block.input || {}).length;
        else if (block.type === "tool_result") chars += (typeof block.content === "string" ? block.content : JSON.stringify(block.content || "")).length;
      }
    }
  }
  return Math.ceil(chars / 3.5);
}

// Progressively compress messages to fit within token budget
function budgetCompress(messages, maxTokens) {
  let est = estimateTokens(messages);
  if (est <= maxTokens) return messages;

  // Strategy 1: Truncate long tool_result content (keep first 2000 chars)
  const compressed = JSON.parse(JSON.stringify(messages)); // deep clone
  for (let i = 0; i < compressed.length - 2; i++) {
    const msg = compressed[i];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > 2000) {
          block.content = block.content.slice(0, 2000) + "\n...(内容已截断)";
        }
      }
    }
    if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 3000) {
      // Truncate long assistant search summaries from earlier rounds
      msg.content = msg.content.slice(0, 3000) + "\n...(已截断)";
    }
  }
  est = estimateTokens(compressed);
  if (est <= maxTokens) return compressed;

  // Strategy 2: Drop early tool rounds entirely, keep summary
  return compressMessages(compressed);
}

function compressMessages(messages) {
  const compressed = [];
  let toolSummary = "";

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Extract text parts, summarize tool_use parts
      const textParts = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const toolParts = msg.content.filter((b) => b.type === "tool_use").map((b) => `[已调用 ${b.name}]`).join(" ");
      if (textParts || toolParts) {
        toolSummary += (textParts ? textParts + " " : "") + toolParts + "\n";
      }
    } else if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some((b) => b.type === "tool_result")) {
      // Summarize tool results
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const content = String(block.content || "").slice(0, 400);
          toolSummary += `[工具结果]: ${content}\n`;
        }
      }
    } else {
      // Regular message — if we have accumulated tool summary, inject it first
      if (toolSummary) {
        compressed.push({ role: "assistant", content: toolSummary.trim() });
        toolSummary = "";
      }
      compressed.push(msg);
    }
  }

  // If trailing tool summary, add as assistant message + clear instruction
  if (toolSummary) {
    compressed.push({ role: "assistant", content: toolSummary.trim() });
    compressed.push({ role: "user", content: "请基于以上搜索结果，使用 create_artifact 工具完成我最初的请求。生成完整的、高质量的内容。" });
  }

  return compressed;
}

function safeParseJson(str) {
  try {
    return JSON.parse(str || "{}");
  } catch {
    return {};
  }
}

function toolDisplayArgs(name, args) {
  if (name === "web_search") return { query: args?.query };
  if (name === "fetch_url") return { url: args?.url };
  if (name === "run_code") return { language: args?.language, code: String(args?.code || "").slice(0, 80) };
  if (name === "generate_long_document") return { topic: args?.topic, pages: args?.pages };
  if (name === "create_artifact") return { title: args?.title, type: args?.type };
  return {};
}

// ---------------------------------------------------------------------------
// Multi-engine search functions
// ---------------------------------------------------------------------------

// Serper.dev — Google results, fastest, best quality
async function serperSearch(query) {
  if (!serperApiKey) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const hasChinese = /[\u4e00-\u9fff]/.test(query);
    const resp = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": serperApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        num: 10,
        ...(hasChinese ? { gl: "cn", hl: "zh-cn" } : {}),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.log(`[Serper] Error ${resp.status}: ${errText.slice(0, 100)}`);
      return [];
    }
    const data = await resp.json();
    const organic = (data.organic || []).slice(0, 8).map(item => ({
      title: item.title || "",
      url: item.link || "",
      description: (item.snippet || "").slice(0, 800),
      age: item.date || "",
    }));
    // Also include knowledge graph if present
    const kg = data.knowledgeGraph;
    if (kg?.description) {
      organic.unshift({
        title: kg.title || query,
        url: kg.website || "",
        description: `${kg.description} ${kg.attributes ? Object.entries(kg.attributes).map(([k,v]) => `${k}: ${v}`).join("; ") : ""}`.slice(0, 800),
        age: "",
      });
    }
    console.log(`[Serper] ${organic.length} results for: ${query.slice(0, 40)}`);
    return organic;
  } catch (e) {
    console.log(`[Serper] Failed: ${e.message}`);
    return [];
  }
}

// Tavily — AI-optimized search, good summaries
async function tavilySearch(query) {
  if (!tavilyApiKey) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query: query,
        search_depth: "basic",
        max_results: 8,
        include_answer: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.log(`[Tavily] Error ${resp.status}: ${errText.slice(0, 100)}`);
      return [];
    }
    const data = await resp.json();
    const results = (data.results || []).map(item => ({
      title: item.title || "",
      url: item.url || "",
      description: (item.content || "").slice(0, 800),
      age: "",
    }));
    // Tavily provides a direct answer — prepend it as a synthetic result
    if (data.answer) {
      results.unshift({
        title: "AI 摘要",
        url: "",
        description: data.answer.slice(0, 1000),
        age: "",
      });
    }
    console.log(`[Tavily] ${results.length} results for: ${query.slice(0, 40)}`);
    return results;
  } catch (e) {
    console.log(`[Tavily] Failed: ${e.message}`);
    return [];
  }
}

// Google Custom Search Engine
async function googleCseSearch(query) {
  if (!googleCseApiKey || !googleCseCx) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const hasChinese = /[\u4e00-\u9fff]/.test(query);
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", googleCseApiKey);
    url.searchParams.set("cx", googleCseCx);
    url.searchParams.set("q", query);
    url.searchParams.set("num", "8");
    if (hasChinese) {
      url.searchParams.set("lr", "lang_zh-CN|lang_zh-TW");
    }
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.log(`[GoogleCSE] Error ${resp.status}: ${errText.slice(0, 100)}`);
      return [];
    }
    const data = await resp.json();
    const results = (data.items || []).map(item => ({
      title: item.title || "",
      url: item.link || "",
      description: (item.snippet || "").replace(/\n/g, " ").slice(0, 800),
      age: "",
    }));
    console.log(`[GoogleCSE] ${results.length} results for: ${query.slice(0, 40)}`);
    return results;
  } catch (e) {
    console.log(`[GoogleCSE] Failed: ${e.message}`);
    return [];
  }
}

// Smart multi-engine search with fallback chain
async function multiSearch(query) {
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return [];

  // Try engines in priority order, stop when we have enough results
  let results = [];
  const usedEngines = [];

  // 1. Serper first (Google results, best quality)
  if (serperApiKey) {
    results = await serperSearch(q);
    if (results.length) usedEngines.push("Serper");
  }

  // 2. If Serper insufficient, try Tavily
  if (results.length < 3 && tavilyApiKey) {
    const tavilyResults = await tavilySearch(q);
    if (tavilyResults.length) {
      usedEngines.push("Tavily");
      results = mergeResults(results, tavilyResults);
    }
  }

  // 3. Google CSE (limited to configured sites, use as supplement not primary)
  if (results.length < 3 && googleCseApiKey) {
    const gResults = await googleCseSearch(q);
    if (gResults.length) {
      usedEngines.push("GoogleCSE");
      results = mergeResults(results, gResults);
    }
  }

  // 4. Brave as further fallback
  if (results.length < 3 && braveApiKey) {
    const braveResults = await braveSearch(q);
    if (braveResults.length) {
      usedEngines.push("Brave");
      results = mergeResults(results, braveResults);
    }
  }

  // 5. DuckDuckGo as last resort
  if (results.length < 3) {
    const ddgResults = await duckDuckGoSearch(q).catch(() => []);
    if (ddgResults.length) {
      usedEngines.push("DDG");
      results = mergeResults(results, ddgResults);
    }
  }

  console.log(`[Search] "${q.slice(0, 30)}" → ${results.length} results via [${usedEngines.join(" → ")}]`);
  return results.slice(0, 10);
}

// Merge results, deduplicate by URL
function mergeResults(existing, incoming) {
  const urls = new Set(existing.map(r => r.url).filter(Boolean));
  const merged = [...existing];
  for (const r of incoming) {
    if (!r.url || urls.has(r.url)) continue;
    urls.add(r.url);
    merged.push(r);
  }
  return merged;
}

// Fetch page text (lightweight, for auto-fetch after search)
async function fetchPageText(url, maxLen = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!resp.ok) return "";
    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("html") && !contentType.includes("text")) return "";
    const html = await resp.text();
    return extractTextFromHtml(html).slice(0, maxLen);
  } catch {
    clearTimeout(timeout);
    return "";
  }
}

// DuckDuckGo HTML search (no API key needed, better Chinese coverage than Brave)
async function duckDuckGoSearch(query) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return [];
    const html = await resp.text();

    // Parse DDG HTML results
    const results = [];
    // Match result links and snippets
    const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs;
    const links = [...html.matchAll(linkRegex)];
    const snippets = [...html.matchAll(snippetRegex)];

    for (let i = 0; i < Math.min(links.length, 8); i++) {
      const rawUrl = links[i][1];
      // DDG wraps URLs in a redirect
      let actualUrl = rawUrl;
      try {
        const decoded = decodeURIComponent(rawUrl);
        const uddgMatch = decoded.match(/uddg=([^&]+)/);
        if (uddgMatch) actualUrl = decodeURIComponent(uddgMatch[1]);
      } catch {}
      if (!actualUrl.startsWith("http")) continue;
      if (actualUrl.includes("duckduckgo.com/y.js")) continue; // skip ads
      results.push({
        title: stripTags(links[i][2]).trim(),
        url: actualUrl,
        description: snippets[i] ? stripTags(snippets[i][1]).trim().slice(0, 600) : "",
        age: "",
      });
    }
    return results;
  } catch {
    return [];
  }
}

async function braveSearch(query) {
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return [];
  const hasChinese = /[\u4e00-\u9fff]/.test(q);
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", "12");
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("result_filter", "web,news");
  if (hasChinese) {
    url.searchParams.set("search_lang", "zh");
    // Note: do NOT set country=cn, it breaks Brave results for Chinese queries
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "accept-language": hasChinese ? "zh-CN,zh;q=0.9" : "en-US,en;q=0.9",
      "x-subscription-token": braveApiKey,
    },
  });
  if (!response.ok) return [];
  const data = await response.json();

  // Merge web results and news results for richer content
  const webResults = (data.web?.results || []).slice(0, 8).map((item) => ({
    title: stripTags(item.title || ""),
    url: item.url || "",
    description: stripTags(
      [item.description || "", ...(item.extra_snippets || [])].join(" ").trim()
    ).slice(0, 800),
    age: item.age || "",
  }));

  const newsResults = (data.news?.results || []).slice(0, 4).map((item) => ({
    title: stripTags(item.title || ""),
    url: item.url || "",
    description: stripTags(item.description || "").slice(0, 800),
    age: item.age || "",
  }));

  // Deduplicate by URL, prefer news for freshness
  const seen = new Set();
  const merged = [];
  for (const r of [...newsResults, ...webResults]) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    merged.push(r);
  }
  return merged.slice(0, 8);
}

function extractTextFromHtml(html) {
  // Simple HTML to text extraction - strip tags, scripts, styles
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function executeCode(language, code) {
  const { execFile } = await import("node:child_process");
  const { writeFile, unlink, readFile, readdir, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");

  // Create a temp working directory for this execution
  const workDir = path.join(tmpdir(), `claude-exec-${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  const ext = language === "python" ? "py" : "mjs";
  const tmpFile = path.join(workDir, `code.${ext}`);

  // For Python: auto-inject Agg backend and auto-save any open figures
  let finalCode = code;
  if (language === "python") {
    const preamble = `import matplotlib\nmatplotlib.use("Agg")\n`;
    const postamble = `\n\n# Auto-save open matplotlib figures\ntry:\n    import matplotlib.pyplot as _plt\n    for _i, _fig in enumerate(_plt.get_fignums()):\n        _plt.figure(_fig).savefig(f"${workDir}/figure_{_i}.png", dpi=150, bbox_inches="tight")\nexcept Exception:\n    pass\n`;
    finalCode = preamble + code + postamble;
  }

  await writeFile(tmpFile, finalCode, "utf8");
  const cmd = language === "python" ? "python3" : process.execPath;
  const args = [tmpFile];

  return new Promise((resolve) => {
    const env = { ...process.env, MPLBACKEND: "Agg" };
    const proc = execFile(cmd, args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024, cwd: workDir, env }, async (err, stdout, stderr) => {
      // Scan for generated image files
      const images = [];
      try {
        const files = await readdir(workDir);
        for (const f of files) {
          if (/\.(png|jpg|jpeg|svg)$/i.test(f)) {
            const data = await readFile(path.join(workDir, f));
            const ext = path.extname(f).slice(1).toLowerCase();
            const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
            images.push(`data:${mime};base64,${data.toString("base64")}`);
          }
        }
      } catch {}
      // Cleanup
      rm(workDir, { recursive: true, force: true }).catch(() => {});

      if (err) {
        // Strip the preamble/postamble line numbers from error messages
        const cleanErr = (stderr || err.message || "Execution failed").replace(/code\.py/g, "script");
        resolve({ output: cleanErr, error: true, images });
      } else {
        resolve({ output: stdout + (stderr ? `\n[stderr]: ${stderr}` : ""), error: false, images });
      }
    });
  });
}

function contentToText(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
  }
  return String(content || "");
}

function normalizeMessageContent(content) {
  if (!Array.isArray(content)) return String(content || "").slice(0, 120000);
  return content
    .map((part) => {
      if (part?.type === "image_url" && part.image_url?.url) {
        return { type: "image_url", image_url: String(part.image_url.url).slice(0, 7_500_000) };
      }
      if (part?.type === "image_url" && typeof part.image_url === "string") {
        return { type: "image_url", image_url: part.image_url.slice(0, 7_500_000) };
      }
      if (part?.type === "pdf_url" && part.pdf_url?.url) {
        return { type: "pdf_url", pdf_url: { url: part.pdf_url.url, name: part.pdf_url.name || "document.pdf" } };
      }
      return { type: "text", text: String(part?.text || "").slice(0, 120000) };
    })
    .filter((part) => part.type === "image" || part.type === "image_url" || part.type === "pdf_url" || part.text);
}

async function extractFileText(dataUrl, name) {
  try {
    const match = String(dataUrl).match(/^data:[^;]+;base64,(.+)$/i);
    if (!match) return `[文件: ${name || "file"} - 无法解析]`;
    const buffer = Buffer.from(match[1], "base64");
    const lower = (name || "").toLowerCase();
    if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheets = workbook.SheetNames.map(sn => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sn], { blankrows: false });
        return `[Sheet: ${sn}]\n${csv}`;
      });
      const text = sheets.join("\n\n").slice(0, 100000);
      return `[Excel 文件: ${name}, ${workbook.SheetNames.length} 个工作表]\n\n${text}`;
    }
    return `[文件: ${name} - 不支持的格式]`;
  } catch (e) {
    console.error("[FILE] extraction error:", e.message);
    return `[文件: ${name || "file"} - 提取失败: ${e.message}]`;
  }
}

async function extractPdfText(dataUrl, name) {
  try {
    const match = String(dataUrl).match(/^data:application\/pdf;base64,(.+)$/i);
    if (!match) return `[PDF: ${name || "document.pdf"} - 无法解析]`;
    const buffer = Buffer.from(match[1], "base64");
    const result = await pdfParse(buffer);
    const text = (result.text || "").trim().slice(0, 100000);
    if (!text) return `[PDF: ${name || "document.pdf"} - 无文本内容（可能是扫描件）]`;
    return `[PDF 文件: ${name || "document.pdf"}, ${result.numpages} 页]\n\n${text}`;
  } catch (e) {
    console.error("[PDF] extraction error:", e.message);
    return `[PDF: ${name || "document.pdf"} - 提取失败: ${e.message}]`;
  }
}

function parseDataPdf(url) {
  const str = String(url || "").trim();
  const headerMatch = str.match(/^data:application\/pdf;base64,/i);
  if (!headerMatch) return null;
  const data = str.slice(headerMatch[0].length).replace(/[\s\r\n]/g, "");
  if (!data) return null;
  return {
    type: "base64",
    media_type: "application/pdf",
    data,
  };
}

function parseDataImage(url) {
  const str = String(url || "").trim();
  // Accept common image formats including those converted by canvas
  const headerMatch = str.match(/^data:(image\/(?:png|jpe?g|webp|gif|bmp|tiff?|heic|heif|svg\+xml));base64,/i);
  if (!headerMatch) return null;
  const data = str.slice(headerMatch[0].length).replace(/[\s\r\n]/g, "").slice(0, 7_500_000);
  if (!data) return null;
  // Normalize media type for Anthropic API (only supports png, jpeg, webp, gif)
  let mediaType = headerMatch[1].toLowerCase().replace("image/jpg", "image/jpeg");
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
    mediaType = "image/jpeg"; // Canvas converts unsupported formats to jpeg
  }
  return {
    type: "base64",
    media_type: mediaType,
    data,
  };
}

function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function chunkText(text) {
  const value = String(text || "");
  if (!value) return [];
  return value.match(/[\s\S]{1,14}/g) || [value];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function staticFile(requestPath, res) {
  const cleanPath = decodeURIComponent(requestPath.split("?")[0]);
  const relative = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const target = path.resolve(publicDir, relative);
  if (!target.startsWith(publicDir)) return notFound(res);

  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return staticFile(path.join(cleanPath, "index.html"), res);
    const ext = path.extname(target);
    const cacheControl = [".html", ".js", ".css", ".svg"].includes(ext) ? "no-cache" : "public, max-age=3600";
    res.writeHead(200, {
      "content-type": mime[ext] || "application/octet-stream",
      "cache-control": cacheControl,
    });
    const data = await fs.readFile(target);
    res.end(data);
  } catch {
    return staticFile("/", res);
  }
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 7 * 86400_000;
  dbSessions.create(token, user.id, user.email, user.role || "user", expiresAt);
  return token;
}

function getCookieToken(req) {
  const cookie = req.headers.cookie || "";
  return cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("claude_lite="))?.slice("claude_lite=".length) || "";
}

function readSession(req) {
  const token = getCookieToken(req);
  if (!token) return null;
  const session = dbSessions.get(token);
  if (!session) return null;
  return { userId: session.user_id, email: session.email, role: session.role };
}

function isRateLimited(ip) {
  const record = loginAttempts.get(ip);
  if (!record || record.resetAt < Date.now()) return false;
  return record.count >= 10;
}

function recordAttempt(ip) {
  const record = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 60_000 };
  if (record.resetAt < Date.now()) { record.count = 0; record.resetAt = Date.now() + 60_000; }
  record.count++;
  loginAttempts.set(ip, record);
}

// Cleanup expired sessions every hour
setInterval(() => {
  dbSessions.cleanup();
  const now = Date.now();
  for (const [ip, record] of loginAttempts) { if (record.resetAt < now) loginAttempts.delete(ip); }
}, 3600_000);

async function readJson(req, maxBytes) {
  const buffer = await readBuffer(req, maxBytes);
  return JSON.parse(buffer.toString("utf8") || "{}");
}

async function readBuffer(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function html(res, body, status = 200) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function wrapDocxHtml(fragment, title) {
  const body = String(fragment || "").trim() || "<p>这个文档没有可提取的正文内容。</p>";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(String(title || "Document").replace(/\.[^.]+$/, ""))}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      background: #f4efe7;
      color: #2d251d;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.72;
    }
    main {
      max-width: 820px;
      margin: 34px auto;
      border: 1px solid #e4d7c6;
      border-radius: 14px;
      background: #fffaf2;
      padding: 42px 48px;
      box-shadow: 0 12px 34px rgba(45, 37, 29, 0.08);
    }
    h1, h2, h3 { color: #2d251d; line-height: 1.24; }
    h1 { margin: 0 0 22px; padding-bottom: 12px; border-bottom: 1px solid #eadfcc; font-size: 30px; }
    h2 { margin-top: 30px; font-size: 22px; }
    h3 { margin-top: 24px; font-size: 17px; }
    p { margin: 0 0 14px; }
    .subtitle { color: #766b5f; font-size: 18px; }
    ul, ol { padding-left: 1.45em; }
    li { margin: 5px 0; }
    table { width: 100%; margin: 18px 0; border-collapse: collapse; border: 1px solid #e4d7c6; }
    th, td { border: 1px solid #e4d7c6; padding: 10px 11px; text-align: left; vertical-align: top; }
    th { background: #f3eadc; }
    blockquote { margin: 18px 0; border-left: 4px solid #bd5d3a; border-radius: 8px; background: #f8f1e8; padding: 12px 14px; color: #4e4034; }
    img { max-width: 100%; height: auto; border-radius: 8px; }
    a { color: #93482d; }
    code, pre { border-radius: 8px; background: #eee4d6; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { overflow: auto; padding: 12px; }
    @media (max-width: 760px) {
      main { margin: 0; min-height: 100vh; border: 0; border-radius: 0; padding: 28px 22px; }
    }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function googleConfigured() {
  return Boolean(googleClientId && googleClientSecret);
}

function getGoogleRedirectUri(req) {
  if (googleRedirectUri) return googleRedirectUri;
  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${port}`;
  const proto = req.headers["x-forwarded-proto"] || (String(host).startsWith("127.0.0.1") || String(host).startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/google/callback`;
}

function cleanupGoogleStates() {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [state, data] of googleOauthStates) {
    if (!data || data.createdAt < cutoff) googleOauthStates.delete(state);
  }
}

async function readGoogleToken() {
  try {
    return JSON.parse(await fs.readFile(googleTokenFile, "utf8"));
  } catch {
    return null;
  }
}

async function writeGoogleToken(token) {
  await fs.writeFile(googleTokenFile, JSON.stringify(token, null, 2), { mode: 0o600 });
}

async function getGoogleAccessToken() {
  const token = await readGoogleToken();
  if (!token?.access_token) return "";
  if (Number(token.expiry_date || 0) > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) return "";
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const refreshed = await response.json().catch(() => ({}));
  if (!response.ok || !refreshed.access_token) return "";
  const next = {
    ...token,
    ...refreshed,
    refresh_token: refreshed.refresh_token || token.refresh_token,
    expiry_date: Date.now() + Math.max(30, Number(refreshed.expires_in || 3600) - 60) * 1000,
  };
  await writeGoogleToken(next);
  return next.access_token;
}

function ensureUploadHtml(value, title) {
  const input = String(value || "");
  if (/<html[\s>]/i.test(input)) return input;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${input}</body></html>`;
}

function googleCallbackPage(title, detail, mode = "popup") {
  const script =
    mode === "redirect"
      ? "setTimeout(()=>location.replace('/app?google=connected'),700)"
      : "try{window.opener&&window.opener.postMessage({type:'google-auth-complete'},'*');setTimeout(()=>window.close(),900)}catch{}";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#f7f3ec;color:#2d251d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.box{max-width:420px;border:1px solid #ddd2c3;border-radius:14px;background:#fffaf2;padding:26px;box-shadow:0 12px 34px rgba(45,37,29,.1)}h1{margin:0 0 10px;font-size:22px}p{margin:0;color:#766b5f;line-height:1.6}</style></head><body><main class="box"><h1>${escapeHtml(title)}</h1><p>${detail}</p></main><script>${script}</script></body></html>`;
}

function safeDriveName(name) {
  return String(name || "Untitled document").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 120);
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}


// ---------------------------------------------------------------------------
// Long document generation — multi-agent parallel chapter writing
// ---------------------------------------------------------------------------
function buildOutlinePrompt(topic, requirements, targetPages, format) {
  const chaptersEstimate = Math.max(3, Math.min(15, Math.round(targetPages / 6)));
  return `你是一位专业的文档架构师。请为以下主题设计一份详细的文档大纲。

主题：${topic}
${requirements ? `额外要求：${requirements}` : ""}
目标页数：约${targetPages}页
章节数量建议：${chaptersEstimate}章左右

请严格按照以下 JSON 格式输出（不要添加任何其他文字）：
\`\`\`json
{
  "title": "文档标题",
  "abstract": "100字以内的摘要",
  "chapters": [
    {
      "title": "章节标题",
      "description": "本章要涵盖的内容描述（50-100字）",
      "sections": ["小节1标题", "小节2标题"],
      "targetWords": 2000
    }
  ]
}
\`\`\`

注意：
- 每章的 targetWords 应该合理分配，总字数约 ${targetPages * 500} 字
- 章节之间要有逻辑递进关系
- 包含引言/概述和总结章节
- 重要：只输出纯 JSON，不要添加任何说明文字、注释或 markdown 格式
- description 中不要使用双引号，用单引号或避免引号
- sections 数组中每个元素是简短的标题字符串`;
}

function parseOutline(text) {
  try {
    // Try multiple extraction strategies
    let jsonStr = "";

    // Strategy 1: fenced json block
    const fenced = text.match(/```json\s*([\s\S]*?)```/);
    if (fenced) jsonStr = fenced[1].trim();

    // Strategy 2: find outermost { ... } containing "chapters"
    if (!jsonStr) {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end > start) {
        jsonStr = text.slice(start, end + 1);
      }
    }

    if (!jsonStr) jsonStr = text;

    // Clean up common JSON issues from Claude
    jsonStr = jsonStr
      .replace(/,\s*}/g, "}")          // trailing comma before }
      .replace(/,\s*]/g, "]")          // trailing comma before ]
      .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width chars
      .replace(/\t/g, " ");            // tabs to spaces

    // Try parsing; if it fails, try fixing unescaped quotes in strings
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e1) {
      // Try fixing: sometimes Claude puts unescaped quotes inside string values
      // Replace smart quotes with regular quotes first
      const fixed = jsonStr
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/：/g, ":")  // fullwidth colon
        .replace(/，/g, ","); // fullwidth comma in JSON structure (risky but sometimes needed)
      try {
        parsed = JSON.parse(fixed);
      } catch (e2) {
        console.error("[LongDoc] Outline parse error:", e2.message);
        console.error("[LongDoc] Raw outline text (first 500):", text.slice(0, 500));
        console.error("[LongDoc] Extracted JSON (first 500):", jsonStr.slice(0, 500));
        return { title: "文档", abstract: "", chapters: [] };
      }
    }

    const result = {
      title: String(parsed.title || "未命名文档"),
      abstract: String(parsed.abstract || ""),
      chapters: Array.isArray(parsed.chapters) ? parsed.chapters.map(ch => ({
        title: String(ch.title || ""),
        description: String(ch.description || ""),
        sections: Array.isArray(ch.sections) ? ch.sections : [],
        targetWords: Number(ch.targetWords) || 2000,
      })) : [],
    };
    console.log(`[LongDoc] Outline parsed: "${result.title}", ${result.chapters.length} chapters`);
    return result;
  } catch (e) {
    console.error("[LongDoc] Outline parse error:", e.message);
    return { title: "文档", abstract: "", chapters: [] };
  }
}


async function executeGenerateLongDoc(args, res) {
  const topic = String(args?.topic || "").trim();
  const requirements = String(args?.requirements || "").trim();
  const targetPages = Math.max(5, Math.min(120, Number(args?.pages) || 30));

  // Create a background job so progress survives client disconnect
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId, status: "running", createdAt: Date.now(),
    progress: [], artifact: null, result: null, error: null,
  };
  longDocJobs.set(jobId, job);

  // Notify client of the jobId immediately
  if (res) {
    try { res.write(`event: longdoc_job\ndata: ${JSON.stringify({ jobId })}\n\n`); res.flush?.(); } catch {}
  }

  const sendProgress = (data) => {
    job.progress.push(data);
    if (job.progress.length > 50) job.progress = job.progress.slice(-40);
    if (res) {
      try { res.write(`event: longdoc_progress\ndata: ${JSON.stringify(data)}\n\n`); res.flush?.(); } catch {}
    }
  };

  try {
    // Step 1: Generate outline (main key)
    sendProgress({ stage: "outline", message: "正在规划文档大纲..." });
    const outlinePrompt = buildOutlinePrompt(topic, requirements, targetPages, "markdown");
    const outlineResult = await callClaude(outlinePrompt, 4096, 3, false);
    const outline = parseOutline(outlineResult);

    if (!outline.chapters.length) {
      return { summary: "大纲生成失败", content: "无法生成有效的文档大纲。请尝试更具体的主题描述。" };
    }

    sendProgress({ stage: "outline_done", message: `大纲完成：${outline.title}（${outline.chapters.length} 章）`, outline });

    // Step 1.5: Quick research phase (if web search is available)
    if (braveApiKey) {
      sendProgress({ stage: "research", message: "正在搜索参考资料..." });
      try {
        const searchQueries = outline.chapters.slice(0, 6).map(ch => ch.title + " " + outline.title);
        const searchResults = await Promise.all(
          searchQueries.slice(0, 3).map(q => braveSearch(q).catch(() => []))
        );
        const allResults = searchResults.flat();
        const researchText = allResults
          .map((r, i) => `[${i+1}] ${r.title}: ${r.description}`)
          .join("\n")
          .slice(0, 4000);
        if (researchText) {
          for (const ch of outline.chapters) {
            ch.research = researchText;
          }
          sendProgress({ stage: "research_done", message: `搜索完成，获取 ${allResults.length} 条参考` });
        }
      } catch (e) {
        console.log("[LongDoc] Research phase error (non-fatal):", e.message);
      }
    }

    // Step 2: Generate chapters with sub-agent keys
    const allChapters = [];
    const batchSize = 2;
    for (let i = 0; i < outline.chapters.length; i += batchSize) {
      const batch = outline.chapters.slice(i, i + batchSize);
      sendProgress({
        stage: "writing",
        message: `正在撰写第 ${i + 1}-${Math.min(i + batchSize, outline.chapters.length)}/${outline.chapters.length} 章...`,
        current: i,
        total: outline.chapters.length,
      });

      const promises = batch.map((chapter, idx) => {
        const chapterIndex = i + idx;
        const prevSummary = allChapters.length > 0
          ? allChapters.slice(-3).map((c, ci) => `「${c.title}」摘要: ${c.content.slice(0, 300)}...`).join("\n")
          : "";
        return generateChapterWithSearch(chapter, chapterIndex, outline, prevSummary, targetPages)
          .then(result => {
            sendProgress({ stage: "chapter_done", index: chapterIndex, title: chapter.title });
            return result;
          })
          .catch(err => {
            console.error(`[LongDoc] Chapter ${chapterIndex} failed:`, err.message);
            sendProgress({ stage: "chapter_error", index: chapterIndex, title: chapter.title, error: err.message });
            return { title: chapter.title, content: `[第${chapterIndex + 1}章生成失败: ${err.message}]` };
          });
      });

      const results = await Promise.all(promises);
      allChapters.push(...results);
      if (i + batchSize < outline.chapters.length) await delay(1500);
    }

    // Step 3: Assemble
    sendProgress({ stage: "assembly", message: "正在组装最终文档..." });
    const finalDoc = assembleMarkdown(outline, allChapters);
    const estimatedPages = Math.round(finalDoc.length / 1500);

    sendProgress({ stage: "complete", message: `文档完成：${outline.chapters.length} 章，约 ${estimatedPages} 页` });

    // Store artifact in job for disconnect recovery
    const artifactData = {
      title: outline.title,
      type: "document",
      content: finalDoc,
      language: "markdown",
      description: `长文档 · ${outline.chapters.length}章 · ~${estimatedPages}页`,
      file_path: "document.md",
    };
    job.artifact = artifactData;
    job.status = "completed";
    job.result = {
      summary: `已生成「${outline.title}」(${outline.chapters.length}章, ~${estimatedPages}页)`,
      content: `Long document "${outline.title}" generated: ${outline.chapters.length} chapters, ~${estimatedPages} pages. The document is now visible in the preview panel.`,
    };

    // Emit as artifact (may fail if client disconnected — that's OK, job has the data)
    if (res) {
      try {
        res.write(`event: artifact\ndata: ${JSON.stringify(artifactData)}\n\n`);
        res.flush?.();
      } catch {}
    }

    return job.result;
  } catch (err) {
    console.error("[LongDoc] Error:", err);
    job.status = "failed";
    job.error = err.message;
    return { summary: "生成失败", content: `Long document generation failed: ${err.message}` };
  }
}



async function generateChapterWithSearch(chapter, index, outline, prevSummary, totalPages) {
  // Simple approach: generate chapter text directly, no tool use
  // (sub-agent keys may not support tools on LuckyAPI)
  const prompt = `你是一位专业的文档撰写者。请撰写以下文档的第 ${index + 1} 章。

文档标题：${outline.title}
文档摘要：${outline.abstract}
本章标题：${chapter.title}
本章要求：${chapter.description}
本章小节：${chapter.sections.join("、")}
目标字数：约${chapter.targetWords}字

${prevSummary ? `前文摘要（确保内容连贯）：\n${prevSummary}\n` : ""}
${chapter.research ? `参考资料：\n${chapter.research}\n` : ""}

要求：
- 直接输出正文内容，不要输出"第X章"标题（我会自动添加）
- 包含所有小节，每个小节用 ## 标记
- 内容要专业、详实、有深度
- 适当使用表格、列表丰富内容
- 字数要达到目标（${chapter.targetWords}字左右）
- 使用 Markdown 格式`;

  const maxTokens = Math.min(16384, Math.max(4096, Math.round(chapter.targetWords * 2)));
  const result = await callClaude(prompt, maxTokens, 3, true);
  return { title: chapter.title, content: result };
}

async function callClaude(prompt, maxTokens = 8192, retries = 3, useSubKey = false) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const key = pickKey(useSubKey);
    const masked = key.slice(0, 6) + "..." + key.slice(-4);
    try {
      if (attempt > 1) await delay(2000 * attempt);
      const response = await fetch(apiEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2024-10-22",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        markKeyFailed(key, response.status);
        if (attempt < retries && (response.status === 403 || response.status === 429 || response.status >= 500)) {
          console.log(`[LongDoc] Key ${masked} failed (${response.status}), switching key and retrying ${attempt}/${retries}...`);
          continue;
        }
        throw new Error(`Claude API ${response.status}: ${errText.slice(0, 200)}`);
      }
      markKeyOk(key);
      const data = await response.json();
      return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    } catch (err) {
      if (attempt < retries && !err.message?.startsWith("Claude API")) {
        console.log(`[LongDoc] Key ${masked} network error, retry ${attempt}/${retries}:`, err.message);
        continue;
      }
      throw err;
    }
  }
}


function assembleMarkdown(outline, chapters) {
  const parts = [];
  parts.push(`# ${outline.title}\n`);
  if (outline.abstract) {
    parts.push(`> ${outline.abstract}\n`);
  }
  parts.push(`---\n`);
  // Table of contents
  parts.push(`## 目录\n`);
  chapters.forEach((ch, i) => {
    parts.push(`${i + 1}. ${ch.title}`);
  });
  parts.push(`\n---\n`);
  // Chapters
  chapters.forEach((ch, i) => {
    parts.push(`## 第${i + 1}章 ${ch.title}\n`);
    parts.push(ch.content);
    parts.push(`\n`);
  });
  return parts.join("\n");
}


// ---------------------------------------------------------------------------
// Export as DOCX
// ---------------------------------------------------------------------------
async function exportDocx(req, res) {
  const body = await readJson(req, 10 * 1024 * 1024);
  const title = String(body?.title || "Document");
  const markdown = String(body?.content || "");
  if (!markdown.trim()) return json(res, { error: "内容为空" }, 400);

  try {
    const doc = markdownToDocx(title, markdown);
    const buffer = await Packer.toBuffer(doc);
    const filename = encodeURIComponent(safeDocFilename(title) + ".docx");
    res.writeHead(200, {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": `attachment; filename*=UTF-8''${filename}`,
      "content-length": buffer.length,
    });
    res.end(buffer);
  } catch (err) {
    console.error("[DOCX] Export error:", err);
    json(res, { error: `DOCX 生成失败: ${err.message}` }, 500);
  }
}

function markdownToDocx(title, markdown) {
  const lines = markdown.split("\n");
  const children = [];
  let inCodeBlock = false;
  let codeLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        children.push(new Paragraph({
          children: [new TextRun({ text: codeLines.join("\n"), font: "Courier New", size: 18 })],
          spacing: { before: 100, after: 100 },
          shading: { type: "clear", fill: "F5F5F5" },
        }));
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Headings
    if (line.startsWith("# ")) {
      children.push(new Paragraph({
        children: parseInlineFormatting(line.slice(2)),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
      }));
      continue;
    }
    if (line.startsWith("## ")) {
      children.push(new Paragraph({
        children: parseInlineFormatting(line.slice(3)),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 150 },
      }));
      continue;
    }
    if (line.startsWith("### ")) {
      children.push(new Paragraph({
        children: parseInlineFormatting(line.slice(4)),
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 },
      }));
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      children.push(new Paragraph({
        children: [],
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" } },
        spacing: { before: 200, after: 200 },
      }));
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      children.push(new Paragraph({
        children: parseInlineFormatting(line.slice(2)),
        indent: { left: 720 },
        border: { left: { style: BorderStyle.SINGLE, size: 3, color: "C05A32" } },
        spacing: { before: 100, after: 100 },
      }));
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      children.push(new Paragraph({
        children: parseInlineFormatting(line.replace(/^[-*]\s+/, "")),
        bullet: { level: 0 },
        spacing: { before: 40, after: 40 },
      }));
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\d+)\.\s+(.*)/);
    if (olMatch) {
      children.push(new Paragraph({
        children: parseInlineFormatting(olMatch[2]),
        numbering: { reference: "default-numbering", level: 0 },
        spacing: { before: 40, after: 40 },
      }));
      continue;
    }

    // Table detection
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const tableLines = [];
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      i--;
      const tableRows = tableLines.filter((_, idx) => idx !== 1); // skip separator
      if (tableRows.length) {
        const rows = tableRows.map((row, rowIdx) => {
          const cells = row.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
          return new TableRow({
            children: cells.map(cell => new TableCell({
              children: [new Paragraph({
                children: [new TextRun({ text: cell, bold: rowIdx === 0, size: 20 })],
              })],
              width: { size: Math.floor(100 / cells.length), type: WidthType.PERCENTAGE },
            })),
          });
        });
        children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
      }
      continue;
    }

    // Empty line → spacing
    if (!line.trim()) {
      continue;
    }

    // Regular paragraph
    children.push(new Paragraph({
      children: parseInlineFormatting(line),
      spacing: { before: 60, after: 60 },
    }));
  }

  return new Document({
    numbering: {
      config: [{
        reference: "default-numbering",
        levels: [{
          level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
      },
      children,
    }],
  });
}

function parseInlineFormatting(text) {
  const runs = [];
  // Split by bold and code markers
  const parts = String(text || "").split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true, size: 22 }));
    } else if (part.startsWith("`") && part.endsWith("`")) {
      runs.push(new TextRun({ text: part.slice(1, -1), font: "Courier New", size: 20, shading: { type: "clear", fill: "F0F0F0" } }));
    } else {
      runs.push(new TextRun({ text: part, size: 22 }));
    }
  }
  return runs;
}

function safeDocFilename(name) {
  return String(name || "document").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
}


async function loadEnv(file) {
  const result = {};
  try {
    const text = await fs.readFile(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trimStart().startsWith("#") || !line.includes("=")) continue;
      const index = line.indexOf("=");
      result[line.slice(0, index)] = line.slice(index + 1);
    }
  } catch {
    // Optional.
  }
  return result;
}
