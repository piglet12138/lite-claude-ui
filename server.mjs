import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const env = await loadEnv(path.join(root, ".env"));
const port = Number(env.PORT || process.env.PORT || 3040);
const baseUrl = process.env.LUCKY_BASE_URL || env.LUCKY_BASE_URL || "https://luckyapi.chat/v1";
const apiKey = process.env.LUCKY_API_KEY || env.LUCKY_API_KEY;
const model = process.env.MODEL || env.MODEL || "claude-opus-4-7";
const accessEmail = process.env.ACCESS_EMAIL || env.ACCESS_EMAIL || "i@i.io";
const accessPassword = process.env.ACCESS_PASSWORD || env.ACCESS_PASSWORD || "iiiiiiii";
const sessionSecret = process.env.SESSION_SECRET || env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const braveApiKey = process.env.BRAVE_SEARCH_API_KEY || env.BRAVE_SEARCH_API_KEY;
const webSearchEnabled = /^(true|1|yes)$/i.test(process.env.ENABLE_WEB_SEARCH || env.ENABLE_WEB_SEARCH || "false");
const webSearchCount = Math.max(1, Math.min(5, Number(process.env.WEB_SEARCH_RESULT_COUNT || env.WEB_SEARCH_RESULT_COUNT || 3)));
const webSearchQueryCount = Math.max(1, Math.min(3, Number(process.env.WEB_SEARCH_QUERY_COUNT || env.WEB_SEARCH_QUERY_COUNT || 2)));
const googleClientId = process.env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || env.GOOGLE_REDIRECT_URI;
const googleTokenFile = path.resolve(root, process.env.GOOGLE_TOKEN_FILE || env.GOOGLE_TOKEN_FILE || ".google-token.json");
const googleScopes = ["https://www.googleapis.com/auth/drive.file"];
const googleOauthStates = new Map();
const agenticSystemPrompt = [
  "你是一个极其聪明、有深度的 AI 助手。默认用中文。不做身份声明。",
  "回答风格：深度优先，充分展开，结构清晰，不用空洞收尾语。",
  "",
  "工具使用规则：",
  "- web_search：需要最新信息或事实验证时搜索。可多次搜索。",
  "- fetch_url：需要阅读某个网页/文章/文档的具体内容时使用。搜索后想深入了解某条结果时，用这个抓取全文。",
  "- run_code：需要计算、数据处理、验证逻辑时执行代码。支持 JavaScript 和 Python。",
  "- create_artifact：创建文档/网页/代码等完整作品，显示在右侧面板。",
  "",
  "create_artifact 行为模式（严格遵守）：",
  "1. 聊天中只用 1-2 句话说明意图",
  "2. 调用 create_artifact 生成完整内容（文档至少2000字，HTML要美观完整，代码要可运行）",
  "3. 之后用 1 句话收尾",
  "4. 绝不在聊天正文中写出文档全文内容",
  "",
  "必须用 create_artifact 的场景：写文档/报告/白皮书/方案/邮件、做网页/应用/可视化、写代码文件。",
  "不用的场景：普通问答、短回复、简单列表。",
].join("\n");

const anthropicTools = [
  {
    name: "web_search",
    description: "Search the web using Brave Search for current/recent information, facts, prices, news, weather, or anything that benefits from real-time data. Can be called multiple times with different queries.",
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

if (!apiKey) {
  throw new Error("LUCKY_API_KEY is required");
}

// ---------------------------------------------------------------------------
// User management (JSON file based)
// ---------------------------------------------------------------------------
const usersFile = path.join(root, "users.json");
const sessions = new Map(); // token -> { userId, email, role, exp }
const loginAttempts = new Map(); // ip -> { count, resetAt }

async function loadUsers() {
  try { return JSON.parse(await fs.readFile(usersFile, "utf8")); } catch { return []; }
}

async function saveUsers(users) {
  await fs.writeFile(usersFile, JSON.stringify(users, null, 2), "utf8");
}

function hashPwd(password, salt) {
  return crypto.createHash("sha256").update(password + salt).digest("hex");
}

async function seedAdmin() {
  const users = await loadUsers();
  if (users.length) return;
  const salt = crypto.randomBytes(16).toString("hex");
  users.push({
    id: crypto.randomUUID(),
    email: accessEmail,
    passwordHash: hashPwd(accessPassword, salt),
    salt,
    role: "admin",
    createdAt: new Date().toISOString(),
  });
  await saveUsers(users);
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
      const users = await loadUsers();
      if (users.find((u) => u.email === email)) return json(res, { error: "该邮箱已注册" }, 409);
      const salt = crypto.randomBytes(16).toString("hex");
      const user = { id: crypto.randomUUID(), email, passwordHash: hashPwd(password, salt), salt, role: "user", createdAt: new Date().toISOString() };
      users.push(user);
      await saveUsers(users);
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
      const users = await loadUsers();
      const user = users.find((u) => u.email === email);
      if (!user || hashPwd(password, user.salt) !== user.passwordHash) {
        recordAttempt(ip);
        return json(res, { error: "账号或密码不正确" }, 401);
      }
      const token = createSession(user);
      res.setHeader("Set-Cookie", `claude_lite=${token}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=604800`);
      return json(res, { ok: true, email: user.email });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const session = readSession(req);
      if (session) sessions.delete(getCookieToken(req));
      res.setHeader("Set-Cookie", "claude_lite=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0");
      return json(res, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      const session = readSession(req);
      if (!session || session.role !== "admin") return json(res, { error: "Forbidden" }, 403);
      const users = await loadUsers();
      return json(res, users.map((u) => ({ id: u.id, email: u.email, role: u.role, createdAt: u.createdAt })));
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

    if (req.method === "POST" && url.pathname === "/api/search") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      const body = await readJson(req, 32 * 1024);
      return json(res, { results: await braveSearch(body?.query) });
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!readSession(req)) return json(res, { error: "Unauthorized" }, 401);
      return chat(req, res);
    }

    if (req.method === "GET" && url.pathname === "/app") {
      return staticFile("/app.html", res);
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
  const body = await readJson(req, 8 * 1024 * 1024);
  const messages = Array.isArray(body?.messages) ? body.messages.slice(-24) : [];
  const temperature = Number.isFinite(body?.temperature) ? body.temperature : 0.42;

  // Convert frontend messages to Anthropic format
  const apiMessages = toAnthropicMessages(messages);

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

  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const isLastRound = round === MAX_ROUNDS - 1;
    // After first round, remove web_search to prevent context bloat; keep fetch_url, run_code, create_artifact
    const roundTools = round === 0 ? tools : tools.filter((t) => t.name !== "web_search" && t.name !== "fetch_url");

    const upstreamBody = {
      model,
      max_tokens: 16384,
      stream: true,
      temperature,
      system: agenticSystemPrompt,
      messages: apiMessages,
      ...(!isLastRound && roundTools.length ? { tools: roundTools } : {}),
    };

    const upstream = await fetch(apiEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(upstreamBody),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      // On 400, wait briefly then retry (handles both rate limits and context size)
      if (upstream.status === 400) {
        await delay(1500);
        const compressedMessages = round === 0 ? apiMessages : compressMessages(apiMessages);
        const retryBody = {
          model, max_tokens: 16384, stream: true, temperature,
          system: agenticSystemPrompt,
          messages: compressedMessages,
          tools: tools.length ? tools : undefined,
        };
        const retry = await fetch(apiEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify(retryBody),
        });
        if (retry.ok && retry.body) {
          const retryResult = await consumeAnthropicStream(retry.body, res);
          // Handle tool calls from retry (mainly create_artifact)
          if (retryResult.stopReason === "tool_use" && retryResult.toolUseBlocks.length) {
            for (const tc of retryResult.toolUseBlocks) {
              res.write(`event: tool_start\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, args: toolDisplayArgs(tc.name, tc.input) })}\n\n`);
              const toolResult = await executeTool(tc.name, tc.input);
              if (tc.name === "create_artifact") {
                res.write(`event: artifact\ndata: ${JSON.stringify({ title: tc.input.title || "Artifact", type: tc.input.type || "html", content: tc.input.content || "", language: tc.input.language || "", description: tc.input.description || "", file_path: tc.input.file_path || "" })}\n\n`);
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

    if (result.stopReason === "tool_use" && result.toolUseBlocks.length) {
      const allSearches = result.toolUseBlocks.every((t) => t.name === "web_search");
      // Only add verbose assistant tool_use blocks for non-search-only rounds
      if (!allSearches) {
        apiMessages.push({ role: "assistant", content: result.allBlocks });
      }

      // Execute tools and build tool_result blocks
      const toolResultBlocks = [];
      let hasArtifact = false;
      for (const tc of result.toolUseBlocks) {
        res.write(`event: tool_start\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, args: toolDisplayArgs(tc.name, tc.input) })}\n\n`);
        res.flush?.();

        const toolResult = await executeTool(tc.name, tc.input);

        if (tc.name === "create_artifact") {
          hasArtifact = true;
          res.write(`event: artifact\ndata: ${JSON.stringify({
            title: tc.input.title || "Artifact",
            type: tc.input.type || "html",
            content: tc.input.content || "",
            language: tc.input.language || "",
            description: tc.input.description || "",
            file_path: tc.input.file_path || "",
          })}\n\n`);
          res.flush?.();
        }

        res.write(`event: tool_result\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, summary: toolResult.summary, sources: toolResult.sources || undefined, codeResult: toolResult.codeResult || undefined })}\n\n`);
        res.flush?.();

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: toolResult.content,
        });
      }

      // If artifact was created, stop the loop — don't carry the massive content into next round
      if (hasArtifact) break;

      // Compact approach: instead of standard tool_use/tool_result format (verbose),
      // flatten search results into a lean text exchange to avoid context bloat.
      if (allSearches && toolResultBlocks.length) {
        const searchSummary = toolResultBlocks
          .map((b) => String(b.content || "").slice(0, 600))
          .filter(Boolean)
          .join("\n\n");
        // Replace verbose tool format with compact text
        apiMessages.push({ role: "assistant", content: `我搜索了相关信息，以下是搜索结果：\n\n${searchSummary}` });
        apiMessages.push({ role: "user", content: "好的，请基于这些信息完成我的请求。如果需要创建文档，请使用 create_artifact 工具。" });
      } else {
        apiMessages.push({ role: "user", content: toolResultBlocks });
      }
      continue; // Next round
    }

    // No tool calls: final answer was already streamed
    break;
  }

  res.write("event: done\ndata: {}\n\n");
  res.end();
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
    if (part?.type === "image_url") {
      const url = part.image_url?.url || (typeof part.image_url === "string" ? part.image_url : "");
      const parsed = parseDataImage(url);
      if (parsed) {
        blocks.push({ type: "image", source: parsed });
      } else if (url) {
        // Fallback: if data URL parsing failed, tell the model an image was attached
        blocks.push({ type: "text", text: "[用户上传了一张图片，但解析失败]" });
      }
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
async function executeTool(name, args) {
  switch (name) {
    case "web_search": {
      const query = String(args?.query || "").trim();
      if (!query) return { summary: "空查询", content: "No query provided.", sources: [] };
      const results = await braveSearch(query);
      if (!results.length) return { summary: "无结果", content: `No search results found for: ${query}`, sources: [] };
      const formatted = results
        .map((r, i) => `[${i + 1}] ${r.title}${r.age ? ` (${r.age})` : ""}\nURL: ${r.url}\n${r.description}`)
        .join("\n\n");
      const sources = results.map((r) => ({ title: r.title, url: r.url, snippet: r.description.slice(0, 180) }));
      return { summary: `${results.length} 条结果`, content: formatted.slice(0, 3000), sources };
    }
    case "fetch_url": {
      const url = String(args?.url || "").trim();
      if (!url) return { summary: "空 URL", content: "No URL provided." };
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(url, {
          headers: { "user-agent": "Mozilla/5.0 (compatible; ClaudeLite/1.0)" },
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timeout);
        if (!resp.ok) return { summary: `HTTP ${resp.status}`, content: `Failed to fetch: HTTP ${resp.status}` };
        const html = await resp.text();
        const text = extractTextFromHtml(html).slice(0, 6000);
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
  if (name === "create_artifact") return { title: args?.title, type: args?.type };
  return {};
}

async function braveSearch(query) {
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return [];
  const hasChinese = /[\u4e00-\u9fff]/.test(q);
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", "8");
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("result_filter", "web,news");
  if (hasChinese) {
    url.searchParams.set("search_lang", "zh-cn");
    url.searchParams.set("country", "cn");
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
  const webResults = (data.web?.results || []).slice(0, 6).map((item) => ({
    title: stripTags(item.title || ""),
    url: item.url || "",
    description: stripTags(
      [item.description || "", ...(item.extra_snippets || [])].join(" ").trim()
    ).slice(0, 500),
    age: item.age || "",
  }));

  const newsResults = (data.news?.results || []).slice(0, 4).map((item) => ({
    title: stripTags(item.title || ""),
    url: item.url || "",
    description: stripTags(item.description || "").slice(0, 500),
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
  return merged.slice(0, 6);
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
  const { writeFile, unlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const tmpFile = path.join(tmpdir(), `claude-exec-${Date.now()}.${language === "python" ? "py" : "mjs"}`);

  await writeFile(tmpFile, code, "utf8");
  const cmd = language === "python" ? "python3" : process.execPath;
  const args = [tmpFile];

  return new Promise((resolve) => {
    const proc = execFile(cmd, args, { timeout: 15000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      unlink(tmpFile).catch(() => {});
      if (err) {
        resolve({ output: stderr || err.message || "Execution failed", error: true });
      } else {
        resolve({ output: stdout + (stderr ? `\n[stderr]: ${stderr}` : ""), error: false });
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
      return { type: "text", text: String(part?.text || "").slice(0, 120000) };
    })
    .filter((part) => part.type === "image" || part.type === "image_url" || part.text);
}

function parseDataImage(url) {
  const str = String(url || "").trim();
  const headerMatch = str.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,/i);
  if (!headerMatch) return null;
  const data = str.slice(headerMatch[0].length).replace(/[\s\r\n]/g, "").slice(0, 7_500_000);
  if (!data) return null;
  return {
    type: "base64",
    media_type: headerMatch[1].toLowerCase().replace("image/jpg", "image/jpeg"),
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
  sessions.set(token, { userId: user.id, email: user.email, role: user.role, exp: Date.now() + 7 * 86400_000 });
  return token;
}

function getCookieToken(req) {
  const cookie = req.headers.cookie || "";
  return cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("claude_lite="))?.slice("claude_lite=".length) || "";
}

function readSession(req) {
  const token = getCookieToken(req);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.exp < Date.now()) { sessions.delete(token); return null; }
  return session;
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
  const now = Date.now();
  for (const [token, session] of sessions) { if (session.exp < now) sessions.delete(token); }
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
