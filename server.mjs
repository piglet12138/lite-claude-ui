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
  const result = await mammoth.extractRawText({ buffer });
  const content = String(result.value || "").trim();
  return json(res, {
    content,
    warnings: (result.messages || []).map((message) => String(message.message || message)).slice(0, 5),
  });
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
