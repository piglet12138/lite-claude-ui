const STORAGE_VERSION = "20260505-docs-v2";
const THREADS_KEY = `claude-lite-threads-${STORAGE_VERSION}`;
const OLD_THREADS_KEY = "claude-lite-threads-20260504-stable";
const OLD_DOCUMENTS_KEY = "claude-lite-documents-20260504-stable";

const state = {
  authenticated: false,
  activeId: "",
  activeDocId: "",
  threads: loadJson(THREADS_KEY, []),
  attachments: [],
  streaming: false,
  docOpen: false,
  docAutoOpenSuppressedThreadId: "",
  expectDocument: false,
  webSearchEnabled: false,
};

// Migration: move global documents into their threads
(function migrate() {
  if (state.threads.length) return; // already migrated or fresh
  const oldThreads = loadJson(OLD_THREADS_KEY, []);
  const oldDocs = loadJson(OLD_DOCUMENTS_KEY, []);
  if (!oldThreads.length) return;
  for (const t of oldThreads) t.documents = t.documents || [];
  for (const doc of oldDocs) {
    const thread = oldThreads.find((t) => t.id === doc.threadId) || oldThreads[0];
    if (thread) {
      thread.documents = thread.documents || [];
      thread.documents.push(doc);
    }
  }
  state.threads = oldThreads;
  saveThreads();
})();

const els = {
  loginView: document.querySelector("#loginView"),
  chatView: document.querySelector("#chatView"),
  loginForm: document.querySelector("#loginForm"),
  loginError: document.querySelector("#loginError"),
  logout: document.querySelector("#logout"),
  newChat: document.querySelector("#newChat"),
  threadList: document.querySelector("#threadList"),
  documentList: document.querySelector("#documentList"),
  messages: document.querySelector("#messages"),
  hero: document.querySelector("#hero"),
  composer: document.querySelector("#composer"),
  prompt: document.querySelector("#prompt"),
  send: document.querySelector("#send"),
  fileInput: document.querySelector("#fileInput"),
  attachmentBar: document.querySelector("#attachmentBar"),
  copyDoc: document.querySelector("#copyDoc"),
  downloadDoc: document.querySelector("#downloadDoc"),
  downloadHtml: document.querySelector("#downloadHtml"), // may be null
  uploadGoogleDoc: document.querySelector("#uploadGoogleDoc"),
  docPanel: document.querySelector("#docPanel"),
  docTitle: document.querySelector("#docTitle"),
  docMeta: document.querySelector("#docMeta"),
  docPreview: document.querySelector("#docPreview"),
  closeDocPanel: document.querySelector("#closeDocPanel"),
  toggleDocPanel: document.querySelector("#toggleDocPanel"),
  artifactPreviewTab: document.querySelector("#artifactPreviewTab"),
  artifactSourceTab: document.querySelector("#artifactSourceTab"),
  sidebarToggle: document.querySelector("#sidebarToggle"),
  webSearchToggle: document.querySelector("#webSearchToggle"),
};

const PENDING_GOOGLE_UPLOAD_KEY = "lite-claude-pending-google-upload";
let streamRenderQueued = false;

init();

async function init() {
  initTheme();
  wireEvents();
  const session = await fetchJson("/api/session").catch(() => ({ authenticated: false }));
  state.authenticated = session.authenticated;
  state.docOpen = false;
  state.authenticated ? showChat() : showLogin();
}

function initTheme() {
  const saved = localStorage.getItem("claude-lite-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.querySelector("#themeToggle");
  if (btn) btn.textContent = theme === "dark" ? "☀" : "☾";
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("claude-lite-theme", next);
  const btn = document.querySelector("#themeToggle");
  if (btn) btn.textContent = next === "dark" ? "☀" : "☾";
}

function wireEvents() {
  els.loginForm.addEventListener("submit", login);
  document.querySelector("#registerForm")?.addEventListener("submit", register);
  document.querySelector("#switchToRegister")?.addEventListener("click", (e) => { e.preventDefault(); showRegisterForm(); });
  document.querySelector("#switchToLogin")?.addEventListener("click", (e) => { e.preventDefault(); showLoginForm(); });
  els.logout.addEventListener("click", logout);
  els.newChat.addEventListener("click", () => {
    state.docAutoOpenSuppressedThreadId = "";
    createThread();
    render();
  });
  els.composer.addEventListener("submit", send);
  els.composer.addEventListener("paste", handlePaste);
  els.prompt.addEventListener("input", autosize);
  els.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      els.composer.requestSubmit();
    }
  });
  els.fileInput.addEventListener("change", handleFiles);
  els.webSearchToggle?.addEventListener("click", () => {
    state.webSearchEnabled = !state.webSearchEnabled;
    renderSearchToggle();
  });
  document.querySelector("#themeToggle")?.addEventListener("click", toggleTheme);
  els.copyDoc?.addEventListener("click", copyCurrentDoc);
  els.downloadDoc.addEventListener("click", () => {
    const doc = activeDocument();
    downloadCurrentDoc(doc?.type === "html" ? "html" : "markdown");
  });
  els.uploadGoogleDoc.addEventListener("click", uploadCurrentDocToGoogle);
  els.artifactPreviewTab.addEventListener("click", () => setArtifactView("preview"));
  els.artifactSourceTab.addEventListener("click", () => setArtifactView("source"));
  els.closeDocPanel.addEventListener("click", () => {
    state.docOpen = false;
    state.docAutoOpenSuppressedThreadId = state.activeId;
    renderDocumentPanel();
  });
  els.toggleDocPanel.addEventListener("click", () => {
    state.docOpen = !state.docOpen;
    if (state.docOpen) state.docAutoOpenSuppressedThreadId = "";
    else state.docAutoOpenSuppressedThreadId = state.activeId;
    if (state.docOpen && !state.activeDocId && threadDocuments()[0]) state.activeDocId = threadDocuments()[0].id;
    renderDocumentPanel();
  });
  els.sidebarToggle.addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
  document.querySelectorAll(".starter").forEach((button) => {
    button.addEventListener("click", () => {
      els.prompt.value = button.dataset.prompt || "";
      autosize();
      els.prompt.focus();
    });
  });
}

async function login(event) {
  event.preventDefault();
  els.loginError.textContent = "";
  const form = new FormData(els.loginForm);
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
  });
  if (!response.ok) {
    els.loginError.textContent = "账号或密码不正确";
    return;
  }
  state.authenticated = true;
  showChat();
}

async function register(event) {
  event.preventDefault();
  const errorEl = document.querySelector("#registerError");
  errorEl.textContent = "";
  const form = new FormData(event.target);
  const email = form.get("email");
  const password = form.get("password");
  const confirmPassword = form.get("confirmPassword");
  if (password !== confirmPassword) { errorEl.textContent = "两次密码不一致"; return; }
  if (password.length < 6) { errorEl.textContent = "密码至少 6 位"; return; }
  const response = await fetch("/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { errorEl.textContent = data.error || "注册失败"; return; }
  state.authenticated = true;
  showChat();
}

function showRegisterForm() {
  els.loginForm.classList.add("hidden");
  document.querySelector("#registerForm")?.classList.remove("hidden");
  document.querySelector("#switchToRegister")?.classList.add("hidden");
  document.querySelector("#switchToLogin")?.classList.remove("hidden");
  document.querySelector("#authTitle").textContent = "注册 Claude";
  document.querySelector("#authSubtitle").textContent = "创建账号，免费使用。";
}

function showLoginForm() {
  els.loginForm.classList.remove("hidden");
  document.querySelector("#registerForm")?.classList.add("hidden");
  document.querySelector("#switchToRegister")?.classList.remove("hidden");
  document.querySelector("#switchToLogin")?.classList.add("hidden");
  document.querySelector("#authTitle").textContent = "登录 Claude";
  document.querySelector("#authSubtitle").textContent = "继续进入你的文档工作台。";
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  state.authenticated = false;
  showLogin();
}

function showLogin() {
  els.loginView.classList.remove("hidden");
  els.chatView.classList.add("hidden");
  document.body.classList.remove("sidebar-open");
}

function showChat() {
  els.loginView.classList.add("hidden");
  els.chatView.classList.remove("hidden");
  if (!state.threads.length) createThread();
  state.activeId ||= state.threads[0].id;
  render();
  resumePendingGoogleUpload();
}

function createThread() {
  const thread = { id: crypto.randomUUID(), title: "新对话", messages: [], documents: [], createdAt: Date.now() };
  state.threads.unshift(thread);
  state.activeId = thread.id;
  state.activeDocId = "";
  saveThreads();
  return thread;
}

function activeThread() {
  return state.threads.find((thread) => thread.id === state.activeId) || createThread();
}

function activeDocument() {
  const thread = activeThread();
  return (thread.documents || []).find((doc) => doc.id === state.activeDocId) || null;
}

function threadDocuments() {
  return activeThread().documents || [];
}

function render() {
  renderThreads();
  renderDocuments();
  renderMessages();
  renderAttachments();
  renderDocumentPanel();
  renderSearchToggle();
}

function renderThreads() {
  els.threadList.innerHTML = "";
  const visible = state.threads.filter((t) => !t.archived);
  for (const thread of visible) {
    const item = document.createElement("div");
    item.className = `thread-item${thread.id === state.activeId ? " active" : ""}`;
    const label = document.createElement("span");
    label.className = "thread-label";
    label.textContent = thread.title || "新对话";
    item.append(label);

    const more = document.createElement("button");
    more.className = "thread-more-btn";
    more.textContent = "⋯";
    more.title = "更多操作";
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      showContextMenu(e.currentTarget, [
        { label: "重命名", action: () => renameThread(thread.id) },
        { label: "删除", action: () => deleteThread(thread.id), danger: true },
      ]);
    });
    item.append(more);

    item.addEventListener("click", (e) => {
      if (e.target.closest(".thread-more-btn")) return;
      state.activeId = thread.id;
      // Switch to this thread's first document
      const docs = thread.documents || [];
      state.activeDocId = docs[0]?.id || "";
      state.docOpen = docs.length > 0 && state.docOpen;
      document.body.classList.remove("sidebar-open");
      render();
    });
    els.threadList.append(item);
  }
  // Show archived count if any
  const archivedCount = state.threads.filter((t) => t.archived).length;
  if (archivedCount) {
    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "thread-item archive-toggle";
    archiveBtn.textContent = `📦 已归档 (${archivedCount})`;
    archiveBtn.addEventListener("click", () => {
      state._showArchived = !state._showArchived;
      renderThreads();
    });
    els.threadList.append(archiveBtn);
    if (state._showArchived) {
      for (const thread of state.threads.filter((t) => t.archived)) {
        const item = document.createElement("div");
        item.className = "thread-item archived";
        item.innerHTML = `<span class="thread-label">${escapeHtml(thread.title || "��对话")}</span>`;
        const restore = document.createElement("button");
        restore.className = "thread-more-btn";
        restore.title = "恢复";
        restore.textContent = "↩";
        restore.addEventListener("click", (e) => { e.stopPropagation(); thread.archived = false; saveThreads(); render(); });
        item.append(restore);
        item.addEventListener("click", () => { state.activeId = thread.id; render(); });
        els.threadList.append(item);
      }
    }
  }
}

function showContextMenu(anchor, items) {
  // Remove any existing menu
  document.querySelector(".ctx-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.className = `ctx-menu-item${item.danger ? " danger" : ""}`;
    btn.textContent = item.label;
    btn.addEventListener("click", () => { menu.remove(); item.action(); });
    menu.append(btn);
  }
  document.body.append(menu);
  // Position near anchor
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 140)}px`;
  // Close on outside click
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", close, true); } };
  setTimeout(() => document.addEventListener("click", close, true), 0);
}

function deleteThread(id) {
  if (!confirm("确定删除这个对话？")) return;
  state.threads = state.threads.filter((t) => t.id !== id);
  if (state.activeId === id) {
    state.activeId = state.threads[0]?.id || "";
    if (!state.threads.length) createThread();
  }
  saveThreads();
  render();
}

function renameThread(id) {
  const thread = state.threads.find((t) => t.id === id);
  if (!thread) return;
  const name = prompt("重命名对话：", thread.title || "");
  if (name === null) return;
  thread.title = name.trim() || "新对话";
  saveThreads();
  renderThreads();
}

function renderDocuments() {
  els.documentList.innerHTML = "";
  const docs = threadDocuments();
  if (!docs.length) {
    const empty = document.createElement("div");
    empty.className = "thread-item";
    empty.innerHTML = "<span>暂无文档</span><small>生成或上传后出现在这里</small>";
    els.documentList.append(empty);
    return;
  }
  for (const doc of docs) {
    const item = document.createElement("div");
    item.className = `thread-item${doc.id === state.activeDocId ? " active" : ""}`;
    item.innerHTML = `<span class="thread-label">${escapeHtml(doc.title)}</span><small>${doc.source || ""}</small>`;

    const more = document.createElement("button");
    more.className = "thread-more-btn";
    more.textContent = "⋯";
    more.title = "更多操作";
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const thread = activeThread();
      showContextMenu(e.currentTarget, [
        { label: "重命名", action: () => { const n = prompt("重命名：", doc.title); if (n !== null) { doc.title = n.trim() || doc.title; saveThreads(); render(); } } },
        { label: "删除", action: () => { if (!confirm(`删除「${doc.title}」？`)) return; thread.documents = (thread.documents || []).filter((d) => d.id !== doc.id); if (state.activeDocId === doc.id) state.activeDocId = (thread.documents[0]?.id) || ""; saveThreads(); render(); }, danger: true },
      ]);
    });
    item.append(more);

    item.addEventListener("click", (e) => {
      if (e.target.closest(".thread-more-btn")) return;
      state.activeDocId = doc.id;
      state.docOpen = true;
      state.docAutoOpenSuppressedThreadId = "";
      document.body.classList.remove("sidebar-open");
      render();
    });
    els.documentList.append(item);
  }
}

function renderMessages() {
  const thread = activeThread();
  els.hero.classList.toggle("hidden", thread.messages.length > 0);
  els.messages.innerHTML = "";
  for (const message of thread.messages) {
    const wrapper = document.createElement("div");
    const isStreamingMessage = state.streaming && message.role === "assistant" && message === thread.messages.at(-1);
    wrapper.className = `message ${message.role}${isStreamingMessage ? " streaming" : ""}`;
    if (message.role === "assistant") {
      const avatar = document.createElement("img");
      avatar.className = "message-avatar";
      avatar.src = "/logo.svg";
      avatar.alt = "";
      wrapper.append(avatar);
    }
    const body = document.createElement("div");
    body.className = "message-body";
    const bubble = document.createElement("div");
    bubble.className = `message-bubble${isStreamingMessage ? " streaming" : ""}`;
    if (message.role === "assistant") {
      // Render tool call cards before the text content
      if (message.toolCalls?.length) {
        const toolsDiv = document.createElement("div");
        toolsDiv.className = "tool-calls";
        for (const tc of message.toolCalls) {
          toolsDiv.append(renderToolCard(tc));
        }
        body.append(toolsDiv);
      }
      const content = displayAssistantMessage(message.content);
      if (content.trim()) {
        bubble.innerHTML = renderRichDocument(content, "chat");
        body.append(bubble);
      }
      body.append(renderMessageActions(message, isStreamingMessage));
      wrapper.append(body);
    } else {
      bubble.innerHTML = renderUserMessage(message);
      wrapper.append(bubble);
    }
    els.messages.append(wrapper);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderUserMessage(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const images = attachments.filter((item) => item.kind === "image" && item.dataUrl);
  const files = attachments.filter((item) => item.kind !== "image");
  const text = (message.content || "").trim();
  const parts = [];
  if (images.length) {
    parts.push(
      `<div class="sent-images">${images
        .map(
          (image) =>
            `<figure class="sent-image" title="${escapeAttribute(image.name || "上传图片")}"><img src="${escapeAttribute(image.dataUrl)}" alt="${escapeAttribute(image.name || "上传图片")}" loading="lazy"></figure>`,
        )
        .join("")}</div>`,
    );
  }
  if (files.length) {
    parts.push(
      `<div class="sent-files">${files.map((f) => `<span class="file-chip">📎 ${escapeHtml(f.name)}</span>`).join("")}</div>`,
    );
  }
  if (text) parts.push(`<div class="message-text">${escapeHtml(text)}</div>`);
  return parts.join("") || "";
}

function renderMessageActions(message, isStreamingMessage) {
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "message-action";
  copy.disabled = isStreamingMessage || !message.content;
  copy.title = "复制回复";
  copy.setAttribute("aria-label", "复制回复");
  copy.innerHTML = `<span class="icon copy" aria-hidden="true"></span><span>复制</span>`;
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(displayAssistantMessage(message.content));
    copy.innerHTML = `<span class="icon copy" aria-hidden="true"></span><span>已复制</span>`;
    setTimeout(() => {
      copy.innerHTML = `<span class="icon copy" aria-hidden="true"></span><span>复制</span>`;
    }, 1200);
  });
  actions.append(copy);

  // Regenerate button (only on last assistant message, not during streaming)
  const thread = activeThread();
  const isLast = message === thread.messages.at(-1);
  if (isLast && !isStreamingMessage) {
    const regen = document.createElement("button");
    regen.type = "button";
    regen.className = "message-action";
    regen.title = "重新生成";
    regen.innerHTML = `<span class="icon-regen" aria-hidden="true">↻</span><span>重新生成</span>`;
    regen.addEventListener("click", () => regenerateLastMessage());
    actions.append(regen);
  }
  return actions;
}

function regenerateLastMessage() {
  if (state.streaming) return;
  const thread = activeThread();
  // Remove last assistant message
  if (thread.messages.at(-1)?.role === "assistant") thread.messages.pop();
  // Get the last user message to resend
  const lastUser = thread.messages.at(-1);
  if (!lastUser || lastUser.role !== "user") return;
  // Re-trigger send with existing user message
  thread.messages.push({ role: "assistant", content: "", toolCalls: [] });
  state.streaming = true;
  els.send.disabled = true;
  saveThreads();
  render();
  // Re-fetch
  (async () => {
    try {
      const apiContent = lastUser.content;
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: messagesForApi(thread, apiContent) }),
      });
      if (!response.ok || !response.body) throw new Error(await response.text());
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const assistant = thread.messages.at(-1);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const sseBlocks = buffer.split(/\r?\n\r?\n/);
        buffer = sseBlocks.pop() || "";
        for (const block of sseBlocks) {
          if (block.startsWith(":")) continue;
          const lines = block.split(/\r?\n/);
          let eventType = "";
          let dataStr = "";
          for (const l of lines) {
            if (l.startsWith("event:")) eventType = l.slice(6).trim();
            else if (l.startsWith("data:")) dataStr = l.slice(5).trim();
          }
          if (!dataStr) continue;
          let data;
          try { data = JSON.parse(dataStr); } catch { continue; }
          handleSSEEvent(eventType, data, assistant, thread);
        }
      }
      if (!assistant.toolCalls?.some((t) => t.name === "create_artifact")) {
        if (looksLikeRunnableArtifact(assistant.content)) {
          upsertArtifactFromAssistant(assistant.content, thread);
        }
      }
    } catch (error) {
      thread.messages.at(-1).content ||= `请求失败：${String(error.message || error).slice(0, 500)}`;
    } finally {
      state.streaming = false;
      els.send.disabled = false;
      saveThreads();
      saveDocuments();
      render();
    }
  })();
}

function renderToolCard(tc) {
  const card = document.createElement("div");
  card.className = `tool-card ${tc.status || "running"}`;
  const isExpandable = (tc.name === "web_search" && tc.sources?.length) || (tc.name === "run_code" && tc.codeResult);
  const isClickable = tc.name === "create_artifact" && tc.status === "completed";
  if (isExpandable || isClickable) card.classList.add("interactive");

  const icons = { web_search: "○", fetch_url: "◎", run_code: "▸", create_artifact: "◆" };
  const iconText = icons[tc.name] || "·";
  let label = tc.name;
  if (tc.name === "web_search") label = `搜索「${tc.args?.query || "..."}」`;
  else if (tc.name === "fetch_url") label = `读取 ${tc.args?.url ? new URL(tc.args.url).hostname : "..."}`;
  else if (tc.name === "run_code") label = `运行 ${tc.args?.language || "code"}`;
  else if (tc.name === "create_artifact") label = `创建「${tc.args?.title || "Artifact"}」`;

  const header = document.createElement("div");
  header.className = "tool-card-header";
  const statusIcon = tc.status === "completed" ? `<span class="tool-check">✓</span>` : "";
  header.innerHTML = `<span class="tool-icon">${iconText}</span><span class="tool-label">${escapeHtml(label)}</span>`;
  if (tc.status === "running") {
    const spinner = document.createElement("span");
    spinner.className = "tool-spinner";
    header.append(spinner);
  } else if (tc.status === "completed") {
    const check = document.createElement("span");
    check.className = "tool-check";
    check.textContent = "✓";
    header.append(check);
  }

  if (isExpandable) {
    const chevron = document.createElement("span");
    chevron.className = `tool-chevron${tc._expanded ? " expanded" : ""}`;
    header.append(chevron);
  }
  card.append(header);

  if (tc.summary) {
    const result = document.createElement("div");
    result.className = "tool-card-result";
    result.textContent = tc.summary;
    card.append(result);
  }

  // Expandable sources for web_search
  if (tc.name === "web_search" && tc.sources?.length) {
    const sources = document.createElement("div");
    sources.className = `tool-sources${tc._expanded ? " expanded" : ""}`;
    for (const src of tc.sources) {
      const item = document.createElement("a");
      item.className = "tool-source-item";
      item.href = src.url;
      item.target = "_blank";
      item.rel = "noopener noreferrer";
      item.innerHTML = `<span class="source-title">${escapeHtml(src.title)}</span><span class="source-snippet">${escapeHtml(src.snippet)}</span>`;
      sources.append(item);
    }
    card.append(sources);
    card.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      tc._expanded = !tc._expanded;
      sources.classList.toggle("expanded", tc._expanded);
      card.querySelector(".tool-chevron")?.classList.toggle("expanded", tc._expanded);
    });
  }

  // Expandable output for run_code
  if (tc.name === "run_code" && tc.codeResult) {
    const output = document.createElement("div");
    output.className = `tool-code-output${tc._expanded ? " expanded" : ""}`;
    const pre = document.createElement("pre");
    pre.textContent = tc.codeResult.output || "(no output)";
    if (tc.codeResult.error) pre.classList.add("error");
    output.append(pre);
    card.append(output);
    card.addEventListener("click", () => {
      tc._expanded = !tc._expanded;
      output.classList.toggle("expanded", tc._expanded);
      card.querySelector(".tool-chevron")?.classList.toggle("expanded", tc._expanded);
    });
  }

  // Clickable artifact card → open doc panel
  if (isClickable) {
    card.addEventListener("click", () => {
      state.docOpen = true;
      state.docAutoOpenSuppressedThreadId = "";
      renderDocumentPanel();
    });
  }

  return card;
}

function renderAttachments() {
  els.attachmentBar.innerHTML = "";
  for (const attachment of state.attachments) {
    const pill = document.createElement("span");
    pill.className = `attachment-pill${attachment.kind === "image" ? " image-pill" : ""}`;
    if (attachment.kind === "image") {
      const img = document.createElement("img");
      img.src = attachment.dataUrl;
      img.alt = "";
      pill.append(img);
    }
    const label = document.createElement("span");
    label.textContent = attachment.name;
    pill.append(label);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "x";
    remove.addEventListener("click", () => {
      state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
      renderAttachments();
    });
    pill.append(remove);
    els.attachmentBar.append(pill);
  }
}

function renderSearchToggle() {
  els.webSearchToggle?.classList.toggle("active", state.webSearchEnabled);
  els.webSearchToggle?.setAttribute("aria-pressed", String(state.webSearchEnabled));
}

function queueStreamRender(thread, assistant) {
  if (streamRenderQueued) return;
  streamRenderQueued = true;
  requestAnimationFrame(() => {
    streamRenderQueued = false;
    updateStreamingMessage(assistant);
  });
}

function updateStreamingMessage(assistant) {
  // Find or create the streaming message DOM node
  let wrapper = els.messages.querySelector(".message.assistant.streaming");
  if (!wrapper) {
    // Fallback: full re-render if streaming node not found
    renderMessages();
    return;
  }
  const body = wrapper.querySelector(".message-body");
  if (!body) return;

  // Update tool cards
  let toolsDiv = body.querySelector(".tool-calls");
  if (assistant.toolCalls?.length) {
    if (!toolsDiv) {
      toolsDiv = document.createElement("div");
      toolsDiv.className = "tool-calls";
      body.prepend(toolsDiv);
    }
    // Only re-render tool cards if count changed or status changed
    const existingCount = toolsDiv.children.length;
    const needsUpdate = existingCount !== assistant.toolCalls.length ||
      assistant.toolCalls.some((tc, i) => {
        const card = toolsDiv.children[i];
        return card && !card.classList.contains(tc.status || "running");
      });
    if (needsUpdate) {
      toolsDiv.innerHTML = "";
      for (const tc of assistant.toolCalls) {
        toolsDiv.append(renderToolCard(tc));
      }
    }
  }

  // Update text bubble
  let bubble = body.querySelector(".message-bubble.streaming");
  const content = displayAssistantMessage(assistant.content);
  if (content.trim()) {
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "message-bubble streaming";
      // Insert before message-actions
      const actions = body.querySelector(".message-actions");
      if (actions) body.insertBefore(bubble, actions);
      else body.append(bubble);
    }
    bubble.innerHTML = renderRichDocument(content, "chat");
  }

  // Scroll to bottom
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderDocumentPanel() {
  els.chatView.classList.toggle("doc-closed", !state.docOpen);
  els.docPanel.classList.toggle("collapsed", !state.docOpen);
  renderDocTabs();
  const doc = activeDocument();
  if (!doc) {
    els.docTitle.textContent = "文档";
    els.docMeta.textContent = "需要时自动生成";
    els.docPreview.innerHTML = `<p class="empty-doc">当对话生成文档时，会在这里打开精排预览。</p>`;
    return;
  }
  doc.type ||= "document";
  doc.language ||= doc.type === "html" ? "html" : "markdown";
  doc.view ||= defaultArtifactView(doc);
  els.docTitle.textContent = doc.title;
  els.docMeta.textContent = artifactMeta(doc);
  els.downloadHtml?.classList.toggle("hidden", doc.type !== "document" && doc.type !== "html");
  els.downloadDoc.textContent = doc.type === "html" ? "下载源码" : "下载";
  // Version navigation
  renderVersionNav(doc);
  els.uploadGoogleDoc.disabled = false;
  els.artifactPreviewTab.classList.toggle("active", doc.view === "preview");
  els.artifactSourceTab.classList.toggle("active", doc.view === "source");
  els.artifactPreviewTab.disabled = doc.type === "code";
  const displayContent = getDocContent(doc);
  if (doc.view === "source") {
    els.docPreview.className = "doc-preview source-preview";
    els.docPreview.innerHTML = `<pre><code>${escapeHtml(displayContent)}</code></pre>`;
    return;
  }
  els.docPreview.className = `doc-preview ${doc.type === "html" ? "html-preview" : ""}`;
  if (doc.type === "html") {
    els.docPreview.innerHTML = `<iframe title="Artifact preview" sandbox="allow-scripts allow-forms allow-modals allow-popups" srcdoc="${escapeAttribute(displayContent)}"></iframe>`;
  } else {
    els.docPreview.innerHTML = renderRichDocument(displayContent, "document");
  }
}

function renderDocTabs() {
  let tabs = document.querySelector(".doc-tabs");
  const docs = threadDocuments();
  if (docs.length <= 1) {
    if (tabs) tabs.remove();
    return;
  }
  if (!tabs) {
    tabs = document.createElement("div");
    tabs.className = "doc-tabs";
    // Insert after doc-panel-header
    const header = els.docPanel.querySelector(".doc-panel-header");
    if (header) header.after(tabs);
    else els.docPanel.prepend(tabs);
  }
  tabs.innerHTML = "";
  for (const doc of docs) {
    const tab = document.createElement("button");
    tab.className = `doc-tab${doc.id === state.activeDocId ? " active" : ""}`;
    tab.textContent = (doc.title || "文档").slice(0, 20);
    tab.title = doc.title || "文档";
    tab.addEventListener("click", () => {
      state.activeDocId = doc.id;
      renderDocumentPanel();
      renderDocuments();
    });
    tabs.append(tab);
  }
}

function renderVersionNav(doc) {
  let nav = document.querySelector(".version-nav");
  if (!doc.versions?.length) {
    if (nav) nav.remove();
    return;
  }
  if (!nav) {
    nav = document.createElement("div");
    nav.className = "version-nav";
    els.docPanel.querySelector(".doc-panel-header")?.append(nav);
  }
  const total = doc.versions.length + 1; // versions + current
  const current = doc.versionIndex ?? doc.versions.length;
  nav.innerHTML = `<button class="version-btn" data-dir="prev" ${current <= 0 ? "disabled" : ""}>‹</button><span class="version-label">v${current + 1}/${total}</span><button class="version-btn" data-dir="next" ${current >= doc.versions.length ? "disabled" : ""}>›</button>`;
  nav.onclick = (e) => {
    const btn = e.target.closest(".version-btn");
    if (!btn || btn.disabled) return;
    if (btn.dataset.dir === "prev") doc.versionIndex = Math.max(0, current - 1);
    else doc.versionIndex = Math.min(doc.versions.length, current + 1);
    saveDocuments();
    renderDocumentPanel();
  };
}

function getDocContent(doc) {
  if (!doc.versions?.length) return doc.content;
  const idx = doc.versionIndex ?? doc.versions.length;
  if (idx >= doc.versions.length) return doc.content; // current/latest
  return doc.versions[idx].content;
}

function setArtifactView(view) {
  const doc = activeDocument();
  if (!doc) return;
  doc.view = view;
  saveDocuments();
  renderDocumentPanel();
}

async function send(event) {
  event.preventDefault();
  if (state.streaming) return;
  const text = els.prompt.value.trim();
  if (!text && !state.attachments.length) return;

  const thread = activeThread();
  const attachments = [...state.attachments];
  const displayAttachments = attachmentsForDisplay(attachments);
  const userContent = text || (attachments.length ? attachments.map((f) => f.name).join(", ") : "");
  const apiContent = buildUserApiContent(text, attachments);
  state.expectDocument = false; // Artifact creation is now driven by tool use only

  thread.messages.push({ role: "user", content: userContent, attachments: displayAttachments });
  thread.title = titleFrom(userContent || displayAttachments[0]?.name || "图片");
  thread.messages.push({ role: "assistant", content: "", toolCalls: [] });
  state.attachments = [];
  els.prompt.value = "";
  autosize();
  state.streaming = true;
  els.send.disabled = true;
  saveThreads();
  render();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: messagesForApi(thread, apiContent) }),
    });
    if (!response.ok || !response.body) throw new Error(await response.text());

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const assistant = thread.messages.at(-1);

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const sseBlocks = buffer.split(/\r?\n\r?\n/);
      buffer = sseBlocks.pop() || "";
      for (const block of sseBlocks) {
        if (block.startsWith(":")) continue;
        const lines = block.split(/\r?\n/);
        let eventType = "";
        let dataStr = "";
        for (const l of lines) {
          if (l.startsWith("event:")) eventType = l.slice(6).trim();
          else if (l.startsWith("data:")) dataStr = l.slice(5).trim();
        }
        if (!dataStr) continue;

        let data;
        try { data = JSON.parse(dataStr); } catch { continue; }

        handleSSEEvent(eventType, data, assistant, thread);
      }
    }
    // Only detect inline HTML artifacts as fallback (e.g. model outputs raw HTML without tool)
    if (!assistant.toolCalls?.some((t) => t.name === "create_artifact")) {
      if (looksLikeRunnableArtifact(assistant.content)) {
        upsertArtifactFromAssistant(assistant.content, thread);
      }
    }
  } catch (error) {
    thread.messages.at(-1).content ||= `请求失败：${String(error.message || error).slice(0, 500)}`;
  } finally {
    state.streaming = false;
    state.expectDocument = false;
    els.send.disabled = false;
    saveThreads();
    saveDocuments();
    render();
  }
}

function handleSSEEvent(eventType, data, assistant, thread) {
  switch (eventType) {
    case "tool_start":
      assistant.toolCalls = assistant.toolCalls || [];
      assistant.toolCalls.push({
        id: data.id,
        name: data.name,
        args: data.args || {},
        summary: "",
        status: "running",
      });
      queueStreamRender(thread, assistant);
      break;
    case "tool_result":
      if (assistant.toolCalls) {
        const tc = assistant.toolCalls.find((t) => t.id === data.id);
        if (tc) {
          tc.summary = data.summary || "";
          tc.status = "completed";
          if (data.sources) tc.sources = data.sources;
          if (data.codeResult) tc.codeResult = data.codeResult;
        }
      }
      queueStreamRender(thread, assistant);
      break;
    case "artifact":
      upsertArtifactFromTool(data, thread);
      renderDocuments();
      renderDocumentPanel();
      break;
    case "done":
      break;
    default:
      if (data.delta) {
        assistant.content += data.delta;
        queueStreamRender(thread, assistant);
      }
      break;
  }
}

function upsertArtifactFromTool(data, thread) {
  thread.documents = thread.documents || [];
  // Find existing artifact with same title in this thread, or create new
  const existing = thread.documents.find((doc) => doc.title === (data.title || "Artifact"));
  const artifactType = data.type || "html";
  const payload = {
    id: existing?.id || crypto.randomUUID(),
    title: data.title || "Artifact",
    content: data.content || "",
    type: artifactType,
    language: data.language || (artifactType === "html" ? "html" : "markdown"),
    source: data.description || "Claude 生成",
    filePath: data.file_path || (artifactType === "html" ? "index.html" : artifactType === "code" ? "code.js" : "document.md"),
    template: artifactType === "html" ? "html-inline" : artifactType,
    view: artifactType === "code" ? "source" : "preview",
    updatedAt: Date.now(),
  };
  if (existing) {
    existing.versions = existing.versions || [];
    existing.versions.push({ content: existing.content, title: existing.title, updatedAt: existing.updatedAt });
    if (existing.versions.length > 5) existing.versions.shift();
    Object.assign(existing, payload);
    existing.versionIndex = existing.versions.length;
  } else {
    payload.versions = [];
    payload.versionIndex = 0;
    thread.documents.unshift(payload);
  }
  state.activeDocId = payload.id;
  if (state.docAutoOpenSuppressedThreadId !== thread.id) {
    state.docOpen = true;
  }
  saveThreads();
}

function upsertArtifactFromAssistant(content, thread) {
  thread.documents = thread.documents || [];
  const artifact = extractArtifact(content, thread);
  const payload = {
    id: crypto.randomUUID(),
    title: artifact.title,
    content: artifact.content,
    type: artifact.type,
    language: artifact.language,
    filePath: artifact.filePath,
    template: artifact.template,
    source: artifact.source,
    view: artifact.view,
    updatedAt: Date.now(),
    versions: [],
    versionIndex: 0,
  };
  thread.documents.unshift(payload);
  state.activeDocId = payload.id;
  if (state.docAutoOpenSuppressedThreadId !== thread.id) {
    state.docOpen = true;
  }
  saveThreads();
}

async function handleFiles() {
  const files = Array.from(els.fileInput.files || []);
  els.fileInput.value = "";
  for (const file of files.slice(0, 6)) {
    await addFileAttachment(file);
  }
  saveDocuments();
  render();
}

async function handlePaste(event) {
  const files = Array.from(event.clipboardData?.files || []).filter(isImageFile);
  const items = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const capacity = Math.max(0, 6 - state.attachments.filter((item) => item.kind === "image").length);
  const images = uniqueFiles([...files, ...items]).slice(0, capacity);
  if (!images.length) return;
  event.preventDefault();
  for (const [index, file] of images.entries()) {
    const name = file.name || `pasted-image-${Date.now()}-${index + 1}.png`;
    await addFileAttachment(new File([file], name, { type: file.type || "image/png" }));
  }
  render();
}

async function addFileAttachment(file) {
  const lower = file.name.toLowerCase();
  if (isImageFile(file)) {
    const dataUrl = await imageToDataUrl(file).catch(() => "");
    if (dataUrl && !state.attachments.some((item) => item.kind === "image" && item.dataUrl === dataUrl)) {
      state.attachments.push({ id: crypto.randomUUID(), name: file.name, kind: "image", mime: file.type, dataUrl });
    }
    return;
  }
  if (lower.endsWith(".docx")) {
    const imported = await convertDocx(file).catch((error) => ({
      content: `无法读取这个 .docx：${String(error.message || error)}`,
      html: "",
      failed: true,
    }));
    const title = file.name.replace(/\.[^.]+$/, "");
    const content = String(imported.content || "").slice(0, 100000);
    const html = String(imported.html || "");
    addUploadedDocument(title, html || content, imported.failed ? "导入失败" : "上传的 Google Docs/Word", html ? "html" : "document");
    state.attachments.push({ id: crypto.randomUUID(), name: file.name, kind: "document", content });
    return;
  }
  const raw = await file.text().catch(() => "");
  const content = lower.endsWith(".html") || lower.endsWith(".htm") ? htmlToText(raw) : raw;
  const kind = /\.(html|htm|md|markdown|txt)$/i.test(file.name) ? "document" : "file";
  state.attachments.push({ id: crypto.randomUUID(), name: file.name, kind, content: content.slice(0, 100000) });
  if (kind === "document") {
    addUploadedDocument(file.name.replace(/\.[^.]+$/, ""), content, "上传的 Google Docs/文本", lower.endsWith(".html") || lower.endsWith(".htm") ? "html" : "document");
  }
}

function attachmentsForDisplay(attachments) {
  return attachments.map((file) => ({
    kind: file.kind,
    name: file.name,
    mime: file.mime,
    dataUrl: file.dataUrl || "",
  }));
}

function buildUserApiContent(text, attachments) {
  const parts = [];
  // Build text part: user message + file contents (for context)
  const fileParts = attachments
    .filter((f) => f.kind !== "image" && f.content)
    .map((f) => `[附件：${f.name}]\n${f.content}`);
  const textContent = [text, ...fileParts].filter(Boolean).join("\n\n").trim();
  if (textContent) parts.push({ type: "text", text: textContent });
  for (const file of attachments) {
    if (file.kind === "image") parts.push({ type: "image_url", image_url: { url: file.dataUrl } });
  }
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

function messagesForApi(thread, latestUserContent) {
  const history = thread.messages.slice(0, -1);
  return history.map((message, index) => {
    const isLatestUser = index === history.length - 1 && message.role === "user";
    return { role: message.role, content: isLatestUser ? latestUserContent : message.content };
  });
}

async function imageToDataUrl(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error("图片不能超过 8MB");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function isImageFile(file) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}

function uniqueFiles(files) {
  const seen = new Set();
  const unique = [];
  for (const file of files.filter(isImageFile)) {
    const signature = `${file.type || "image"}:${file.size}:${file.lastModified || 0}:${file.name || ""}`;
    const looseSignature = `${file.type || "image"}:${file.size}:${file.lastModified || 0}`;
    if (seen.has(signature) || seen.has(looseSignature)) continue;
    seen.add(signature);
    seen.add(looseSignature);
    unique.push(file);
  }
  return unique;
}

async function convertDocx(file) {
  const response = await fetch("/api/import-docx", {
    method: "POST",
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "x-file-name": encodeURIComponent(file.name),
    },
    body: await file.arrayBuffer(),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return {
    content: String(data.content || "").slice(0, 100000),
    html: String(data.html || "").slice(0, 500000),
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
  };
}

function addUploadedDocument(title, content, source, type = "document") {
  const thread = activeThread();
  thread.documents = thread.documents || [];
  const doc = {
    id: crypto.randomUUID(),
    title,
    content: String(content || "").slice(0, type === "html" ? 200000 : 80000),
    type,
    language: type === "html" ? "html" : "markdown",
    source,
    view: defaultArtifactView({ type }),
    updatedAt: Date.now(),
    versions: [],
    versionIndex: 0,
  };
  thread.documents.unshift(doc);
  state.activeDocId = doc.id;
  state.docOpen = true;
  saveThreads();
}

async function copyCurrentDoc() {
  const doc = activeDocument();
  if (!doc) return;
  await navigator.clipboard.writeText(doc.content);
  els.copyDoc.textContent = "已复制";
  setTimeout(() => (els.copyDoc.textContent = "复制文档"), 1200);
}

function downloadCurrentDoc(format) {
  const doc = activeDocument();
  if (!doc) return;
  const isHtmlArtifact = doc.type === "html";
  const html = isHtmlArtifact ? doc.content : documentHtml(doc);
  const blob =
    format === "html"
      ? new Blob([html], { type: "text/html;charset=utf-8" })
      : new Blob([doc.content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.filePath || `${safeFilename(doc.title)}.${format === "html" || isHtmlArtifact ? "html" : "md"}`;
  a.click();
  URL.revokeObjectURL(url);
}

async function uploadCurrentDocToGoogle() {
  const doc = activeDocument();
  if (!doc) return;
  const originalText = els.uploadGoogleDoc.textContent;
  els.uploadGoogleDoc.disabled = true;
  try {
    els.uploadGoogleDoc.textContent = "连接 Google...";
    const html = doc.type === "html" ? doc.content : documentHtml(doc);
    const connected = await ensureGoogleConnected({ title: doc.title, html });
    if (!connected) return;
    els.uploadGoogleDoc.textContent = "上传中...";
    const data = await uploadGoogleDocPayload({ title: doc.title, html });
    els.uploadGoogleDoc.textContent = "已上传";
    if (data.file?.webViewLink) window.open(data.file.webViewLink, "_blank", "noopener,noreferrer");
    setTimeout(() => (els.uploadGoogleDoc.textContent = originalText), 1400);
  } catch (error) {
    els.uploadGoogleDoc.textContent = String(error.message || error).slice(0, 18);
    setTimeout(() => (els.uploadGoogleDoc.textContent = originalText), 2200);
  } finally {
    els.uploadGoogleDoc.disabled = false;
  }
}

async function ensureGoogleConnected(pendingUpload) {
  const status = await fetchJson("/api/google/status");
  if (!status.configured) throw new Error("未配置 Google OAuth");
  if (status.connected) return true;
  sessionStorage.setItem(
    PENDING_GOOGLE_UPLOAD_KEY,
    JSON.stringify({
      ...pendingUpload,
      createdAt: Date.now(),
    }),
  );
  window.location.href = "/api/google/auth/start?mode=redirect";
  return false;
}

async function resumePendingGoogleUpload() {
  const pending = loadPendingGoogleUpload();
  if (!pending) return;
  sessionStorage.removeItem(PENDING_GOOGLE_UPLOAD_KEY);
  state.docOpen = true;
  renderDocumentPanel();
  els.uploadGoogleDoc.textContent = "上传中...";
  els.uploadGoogleDoc.disabled = true;
  try {
    const data = await uploadGoogleDocPayload(pending);
    els.uploadGoogleDoc.textContent = "已上传";
    if (data.file?.webViewLink) window.open(data.file.webViewLink, "_blank", "noopener,noreferrer");
  } catch (error) {
    els.uploadGoogleDoc.textContent = String(error.message || error).slice(0, 18);
  } finally {
    setTimeout(() => {
      els.uploadGoogleDoc.textContent = "上传 Docs";
      els.uploadGoogleDoc.disabled = false;
    }, 1800);
  }
}

function loadPendingGoogleUpload() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(PENDING_GOOGLE_UPLOAD_KEY) || "null");
    if (!pending?.html || Date.now() - Number(pending.createdAt || 0) > 10 * 60_000) return null;
    return { title: pending.title || "Untitled document", html: pending.html };
  } catch {
    return null;
  }
}

async function uploadGoogleDocPayload(payload) {
  const response = await fetch("/api/google/upload-doc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.detail?.error?.message || "上传失败");
  return data;
}

function autosize() {
  const min = 34;
  const max = 154;
  els.prompt.style.height = `${min}px`;
  const next = Math.min(max, Math.max(min, els.prompt.scrollHeight));
  els.prompt.style.height = `${next}px`;
  els.prompt.style.overflowY = els.prompt.scrollHeight > max ? "auto" : "hidden";
}

function shouldCreateDocument(text) {
  return /(文档|报告|方案|PRD|邮件|纪要|草稿|Google Docs|docs|doc|改写|审校|润色|整理|下载|生成|artifact|网页|页面|HTML|组件|预览)/i.test(text);
}

function shouldUseWebSearch(text) {
  return /(联网|搜索|查一下|查找|最新|今天|昨日|昨天|本周|新闻|价格|股价|汇率|天气|官网|资料|来源|引用|现在|当前|2026)/i.test(text);
}

function looksLikeDocument(text) {
  const headings = (text.match(/^#{1,3}\s+/gm) || []).length;
  const longEnough = text.length > 700;
  return headings >= 2 || (longEnough && /(摘要|背景|目标|建议|行动项|下一步|结论)/.test(text));
}

function looksLikeRunnableArtifact(text) {
  return /```(html|svg|xml|javascript|js|css|tsx|jsx|vue|python|py)\b/i.test(text) || /<!doctype html|<html[\s>]|<svg[\s>]/i.test(text);
}

function extractArtifact(content, thread) {
  const metadata = extractArtifactMetadata(content);
  const html = extractHtmlArtifact(content);
  if (html) {
    return {
      title: metadata.title || extractTitle(content) || thread.title || "Artifact",
      content: html,
      type: "html",
      language: "html",
      source: metadata.description || "HTML Artifact",
      filePath: metadata.file_path || "index.html",
      template: metadata.template || "html-inline",
      view: "preview",
    };
  }
  const code = extractCodeArtifact(content);
  if (code) {
    return {
      title: metadata.title || extractTitle(content) || thread.title || "Artifact",
      content: code.code,
      type: "code",
      language: code.language,
      source: metadata.description || `${code.language.toUpperCase()} Artifact`,
      filePath: metadata.file_path || defaultFilePath(code.language),
      template: metadata.template || code.language,
      view: "source",
    };
  }
  return {
    title: metadata.title || extractTitle(content) || thread.title || "Untitled",
    content: stripArtifactMetadata(content),
    type: "document",
    language: "markdown",
    source: metadata.description || "Claude 生成",
    filePath: metadata.file_path || "document.md",
    template: metadata.template || "markdown-doc",
    view: "preview",
  };
}

function extractHtmlArtifact(text) {
  const clean = stripArtifactMetadata(text);
  const fenced = clean.match(/```(?:html|HTML)\s*([\s\S]*?)```/);
  if (fenced) return ensureHtmlDocument(fenced[1].trim());
  const doc = clean.match(/<!doctype html[\s\S]*<\/html>/i) || clean.match(/<html[\s\S]*<\/html>/i);
  if (doc) return ensureHtmlDocument(doc[0].trim());
  const svg = clean.match(/<svg[\s\S]*<\/svg>/i);
  if (svg) return ensureHtmlDocument(svg[0].trim());
  return "";
}

function extractCodeArtifact(text) {
  const clean = stripArtifactMetadata(text);
  const match = clean.match(/```(javascript|js|css|tsx|jsx|vue|python|py)\s*([\s\S]*?)```/i);
  if (!match) return null;
  return { language: match[1].toLowerCase(), code: match[2].trim() };
}

function ensureHtmlDocument(html) {
  if (/<html[\s>]/i.test(html)) return html;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fffaf2;color:#2c2218;padding:24px}</style></head><body>${html}</body></html>`;
}

function artifactMeta(doc) {
  const type = doc.type || "document";
  const file = doc.filePath ? ` · ${doc.filePath}` : "";
  if (type === "html") return `${doc.source || "HTML Artifact"}${file}`;
  if (type === "code") return `${doc.source || `${(doc.language || "code").toUpperCase()} Artifact`}${file}`;
  return doc.source || "Claude 生成";
}

function defaultArtifactView(doc) {
  return doc.type === "code" ? "source" : "preview";
}

function extractArtifactMetadata(text) {
  const match = String(text || "").match(/<!--\s*artifact:\s*({[\s\S]*?})\s*-->/i);
  if (!match) return {};
  try {
    const data = JSON.parse(match[1]);
    return {
      template: String(data.template || "").slice(0, 40),
      title: String(data.title || "").slice(0, 50),
      description: String(data.description || "").slice(0, 120),
      file_path: String(data.file_path || "").slice(0, 100),
    };
  } catch {
    return {};
  }
}

function stripArtifactMetadata(text) {
  return String(text || "").replace(/<!--\s*artifact:\s*{[\s\S]*?}\s*-->\s*/gi, "");
}

function displayAssistantMessage(text) {
  const metadata = extractArtifactMetadata(text);
  if (/<!--\s*artifact:/i.test(text)) {
    const beforeArtifact = String(text || "").split(/<!--\s*artifact:/i)[0].trim();
    if (beforeArtifact) return beforeArtifact;
    const title = metadata.title || "Artifact";
    const description = metadata.description ? `：${metadata.description}` : "";
    return `已创建 ${title}${description}。`;
  }
  if (!looksLikeRunnableArtifact(text)) return stripArtifactMetadata(text);
  const clean = stripArtifactMetadata(text)
    .replace(/```(?:html|svg|xml|javascript|js|css|tsx|jsx|vue|python|py)[\s\S]*?```/gi, "")
    .replace(/<!doctype html[\s\S]*<\/html>/gi, "")
    .replace(/<html[\s\S]*<\/html>/gi, "")
    .replace(/<svg[\s\S]*<\/svg>/gi, "")
    .trim();
  if (clean) return clean;
  const title = metadata.title || "Artifact";
  const description = metadata.description ? `：${metadata.description}` : "";
  return `已创建 ${title}${description}。`;
}

function defaultFilePath(language) {
  const normalized = String(language || "txt").toLowerCase();
  const map = {
    javascript: "index.js",
    js: "index.js",
    css: "styles.css",
    tsx: "App.tsx",
    jsx: "App.jsx",
    vue: "app.vue",
    python: "app.py",
    py: "app.py",
  };
  return map[normalized] || `artifact.${normalized}`;
}

function extractTitle(text) {
  const heading = text.match(/^#\s+(.+)$/m) || text.match(/^##\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 50);
  return titleFrom(text);
}

function titleFrom(text) {
  return text.replace(/[#>*_`\-\s]+/g, " ").trim().slice(0, 28) || "新对话";
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function saveThreads() {
  localStorage.setItem(THREADS_KEY, JSON.stringify(state.threads.slice(0, 30)));
}

function saveDocuments() {
  saveThreads(); // documents now live inside threads
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(response.statusText);
  return response.json();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript").forEach((node) => node.remove());
  const title = doc.querySelector("title")?.textContent?.trim();
  return `${title ? `# ${title}\n\n` : ""}${doc.body?.innerText || doc.documentElement.innerText || ""}`.trim();
}

function renderRichDocument(markdown, mode = "document") {
  const lines = escapeHtml(markdown).split(/\n/);
  const out = [];
  let inList = false;
  let inCode = false;
  let code = [];

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${code.join("\n")}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }

    if (isTableStart(lines, i)) {
      closeList();
      const table = [];
      while (i < lines.length && lines[i].includes("|")) {
        table.push(lines[i]);
        i += 1;
      }
      i -= 1;
      out.push(renderTable(table));
      continue;
    }

    if (line.startsWith("# ")) {
      closeList();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (line.startsWith("## ")) {
      closeList();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith("### ")) {
      closeList();
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
    } else if (line.startsWith("&gt; ")) {
      closeList();
      out.push(`<blockquote>${inline(line.slice(5))}</blockquote>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
    } else if (line.trim()) {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    } else {
      closeList();
    }
  }
  closeList();
  return out.join("") || (mode === "document" ? `<p class="empty-doc">暂无内容。</p>` : "");
}

function inline(text) {
  return text.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function isTableStart(lines, index) {
  return lines[index]?.includes("|") && /^\s*\|?[\s:-]+\|[\s|:-]+$/.test(lines[index + 1] || "");
}

function renderTable(lines) {
  const rows = lines
    .filter((line, index) => index !== 1)
    .map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => inline(cell.trim())));
  if (!rows.length) return "";
  const [head, ...body] = rows;
  return `<table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function documentHtml(doc) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title><style>${documentStyles()}</style></head><body><main class="doc">${renderRichDocument(doc.content)}</main></body></html>`;
}

function documentStyles() {
  return `body{margin:0;background:#f4efe7;color:#2c2218;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.doc{max-width:820px;margin:40px auto;background:#fffefb;border:1px solid #e4d7c6;border-radius:16px;padding:44px;line-height:1.72}h1{font-size:30px;border-bottom:1px solid #eadfcc;padding-bottom:12px}h2{font-size:22px;margin-top:30px}h3{font-size:17px;margin-top:22px}p,li{color:#3f342a}blockquote{border-left:4px solid #c76342;background:#f8f1e8;border-radius:8px;padding:12px 14px}table{width:100%;border-collapse:collapse;margin:18px 0;border:1px solid #e4d7c6}th,td{border-bottom:1px solid #e4d7c6;padding:10px;text-align:left;vertical-align:top}th{background:#f3eadc}code,pre{background:#eee4d6;border-radius:8px}pre{padding:12px;overflow:auto}`;
}

function safeFilename(name) {
  return (name || "document").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
}

function stripImagePlaceholders(text) {
  return String(text || "")
    .replace(/^\s*\[图片[:：][^\]]+\]\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n");
}
