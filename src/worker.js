export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/session") {
      return json({ authenticated: Boolean(await readSession(request, env)), email: env.ACCESS_EMAIL, model: env.MODEL });
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = await request.json();
      if (body.email === env.ACCESS_EMAIL && body.password === env.ACCESS_PASSWORD) {
        const token = await signSession(body.email, env);
        return json(
          { ok: true, email: body.email },
          200,
          { "set-cookie": `claude_lite=${token}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=604800` },
        );
      }
      return json({ error: "Invalid email or password" }, 401);
    }
    if (request.method === "POST" && url.pathname === "/api/logout") {
      return json({ ok: true }, 200, {
        "set-cookie": "claude_lite=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0",
      });
    }
    if (request.method === "POST" && url.pathname === "/api/chat") {
      if (!(await readSession(request, env))) return json({ error: "Unauthorized" }, 401);
      return chat(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function chat(request, env) {
  const body = await request.json();
  const messages = Array.isArray(body.messages) ? body.messages.slice(-24) : [];
  const upstream = await fetch(`${(env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1").replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.ANTHROPIC_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.MODEL || "claude-opus-4-7",
      stream: true,
      temperature: 0.42,
      messages: [
        {
          role: "system",
          content:
            "你是 Claude Opus 4.7 文档工作台。默认用中文。擅长生成高质量长文档、改写 Google Docs 草稿、审校结构、整理上传材料。输出应可直接复制到 Google Docs：标题层级清楚，段落自然，必要时使用表格、清单、摘要和行动项。不要编造事实；涉及事实、数据、引用、法律、医学、金融或实时信息时提醒核对来源。",
        },
        ...messages.map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: String(message.content || "").slice(0, 120000),
        })),
      ],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    return json({ error: `API error ${upstream.status}`, detail: await upstream.text() }, 502);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
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
            controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
            controller.close();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || "";
            if (delta) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
          } catch {
            // Ignore malformed upstream fragments.
          }
        }
      }
      controller.enqueue(new TextEncoder().encode("event: done\ndata: {}\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

async function signSession(email, env) {
  const payload = btoa(JSON.stringify({ email, exp: Date.now() + 7 * 86400_000 })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const sig = await hmac(payload, env.SESSION_SECRET);
  return `${payload}.${sig}`;
}

async function readSession(request, env) {
  const cookie = request.headers.get("cookie") || "";
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("claude_lite="))
    ?.slice("claude_lite=".length);
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || (await hmac(payload, env.SESSION_SECRET)) !== sig) return null;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const data = JSON.parse(atob(normalized));
    if (data.exp < Date.now() || data.email !== env.ACCESS_EMAIL) return null;
    return data;
  } catch {
    return null;
  }
}

async function hmac(payload, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
