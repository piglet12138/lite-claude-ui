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
const googleClientId = process.env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || env.GOOGLE_REDIRECT_URI;
const googleTokenFile = path.resolve(root, process.env.GOOGLE_TOKEN_FILE || env.GOOGLE_TOKEN_FILE || ".google-token.json");
const googleScopes = ["https://www.googleapis.com/auth/drive.file"];
const googleOauthStates = new Map();
const systemPrompt =
  [
    "默认用中文，直接完成用户请求，不做身份纠正、模型声明或元说明。",
    "文档要适合复制到 Google Docs：标题、层级、段落、表格和行动项清楚。",
    "需要可预览作品时生成单个 Artifact：先一句说明，再给 artifact 元信息注释和一个代码块。",
    '元信息注释：<!-- artifact: {"template":"html-inline","title":"短标题","description":"一句话描述","file_path":"index.html","port":null} -->',
    "默认用完整自包含 HTML；不要依赖构建步骤。不要输出工具调用标签。",
  ].join("\n");

if (!apiKey) {
  throw new Error("LUCKY_API_KEY is required");
}

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
      return json(res, { authenticated: Boolean(readSession(req)), email: accessEmail, model });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readJson(req, 32 * 1024);
      if (body?.email === accessEmail && body?.password === accessPassword) {
        const token = signSession(body.email);
        res.setHeader("Set-Cookie", `claude_lite=${token}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=604800`);
        return json(res, { ok: true, email: body.email });
      }
      return json(res, { error: "Invalid email or password" }, 401);
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      res.setHeader("Set-Cookie", "claude_lite=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0");
      return json(res, { ok: true });
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
  const latestText = latestUserText(messages);
  const searchResults = body?.webSearch && webSearchEnabled && braveApiKey ? await braveSearch(latestText) : [];
  const searchContext = formatSearchContext(searchResults);
  const preparedMessages = searchContext ? attachSearchContext(messages, searchContext) : messages;
  const normalizedMessages = preparedMessages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: normalizeMessageContent(message.content),
    }));
  const hasImage = normalizedMessages.some(
    (message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image" || part.type === "image_url"),
  );
  const requestMessages = hasImage ? normalizedMessages : [{ role: "system", content: systemPrompt }, ...normalizedMessages];

  const upstreamBody = {
    model,
    stream: !hasImage,
    temperature,
    messages: requestMessages,
  };
  let upstream = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  });

  if (!upstream.ok && hasImage) {
    upstream = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, stream: false, messages: requestMessages }),
    });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return json(res, { error: `LuckyAPI error ${upstream.status}`, detail: text.slice(0, 800) }, 502);
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();
  res.write(": stream\n\n");

  if (hasImage) {
    const data = await upstream.json();
    const text = data.choices?.[0]?.message?.content || "";
    for (const chunk of chunkText(text)) {
      res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
      res.flush?.();
      await delay(22);
    }
    res.write("event: done\ndata: {}\n\n");
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        res.write("event: done\ndata: {}\n\n");
        res.end();
        return;
      }
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || "";
        if (delta) {
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          res.flush?.();
        }
      } catch {
        // Ignore malformed upstream fragments.
      }
    }
  }

  res.write("event: done\ndata: {}\n\n");
  res.end();
}

async function braveSearch(query) {
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return [];
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", String(webSearchCount));
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("safesearch", "moderate");
  url.searchParams.set("search_lang", /[\u4e00-\u9fff]/.test(q) ? "zh-cn" : "en");

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": braveApiKey,
    },
  });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.web?.results || []).slice(0, webSearchCount).map((item) => ({
    title: stripTags(item.title || ""),
    url: item.url || "",
    description: stripTags(item.description || ""),
  }));
}

function formatSearchContext(results) {
  if (!results.length) return "";
  return [
    "【已检索资料】以下资料由系统检索得到。请把它们视为用户粘贴给你的材料，直接基于资料回答；不要说你不能浏览网页。使用资料时标注来源 URL。",
    ...results.map((item, index) => `[${index + 1}] ${item.title}\nURL: ${item.url}\n摘要: ${item.description}`),
  ].join("\n\n");
}

function attachSearchContext(messages, searchContext) {
  const cloned = messages.map((message) => ({ ...message }));
  for (let i = cloned.length - 1; i >= 0; i -= 1) {
    if (cloned[i]?.role !== "user") continue;
    cloned[i].content = prependTextToContent(cloned[i].content, `${searchContext}\n\n请先阅读上面的已检索资料，再回答下面的问题。\n\n【用户问题】`);
    return cloned;
  }
  return cloned;
}

function prependTextToContent(content, prefix) {
  if (Array.isArray(content)) {
    const next = [...content];
    const textPart = next.find((part) => part?.type === "text");
    if (textPart) textPart.text = `${prefix}${textPart.text || ""}`;
    else next.unshift({ type: "text", text: prefix });
    return next;
  }
  return `${prefix}${String(content || "")}`;
}

function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "user") continue;
    return contentToText(messages[i].content);
  }
  return "";
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
  const match = String(url || "").match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  return {
    type: "base64",
    media_type: match[1].toLowerCase().replace("image/jpg", "image/jpeg"),
    data: match[2].slice(0, 7_500_000),
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

function signSession(email) {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + 7 * 86400_000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function readSession(req) {
  const cookie = req.headers.cookie || "";
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("claude_lite="))
    ?.slice("claude_lite=".length);
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.exp < Date.now() || data.email !== accessEmail) return null;
    return data;
  } catch {
    return null;
  }
}

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
      ? "setTimeout(()=>location.replace('/?google=connected'),700)"
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
