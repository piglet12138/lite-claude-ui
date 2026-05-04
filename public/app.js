const STORAGE_VERSION = "20260504-stable";
const THREADS_KEY = `claude-lite-threads-${STORAGE_VERSION}`;
const DOCUMENTS_KEY = `claude-lite-documents-${STORAGE_VERSION}`;

const state = {
  authenticated: false,
  activeId: "",
  activeDocId: "",
  threads: loadJson(THREADS_KEY, []),
  documents: loadJson(DOCUMENTS_KEY, []),
  attachments: [],
  streaming: false,
  docOpen: false,
  docAutoOpenSuppressedThreadId: "",
  expectDocument: false,
  webSearchEnabled: false,
};

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
  downloadHtml: document.querySelector("#downloadHtml"),
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

let streamRenderQueued = false;

init();

async function init() {
  wireEvents();
  const session = await fetchJson("/api/session").catch(() => ({ authenticated: false }));
  state.authenticated = session.authenticated;
  state.activeDocId ||= state.documents[0]?.id || "";
  state.docOpen = false;
  state.authenticated ? showChat() : showLogin();
}

function wireEvents() {
  els.loginForm.addEventListener("submit", login);
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
  els.webSearchToggle.addEventListener("click", () => {
    state.webSearchEnabled = !state.webSearchEnabled;
    renderSearchToggle();
  });
  els.copyDoc.addEventListener("click", copyCurrentDoc);
  els.downloadDoc.addEventListener("click", () => downloadCurrentDoc("markdown"));
  els.downloadHtml.addEventListener("click", () => downloadCurrentDoc("html"));
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
    if (state.docOpen && !state.activeDocId && state.documents[0]) state.activeDocId = state.documents[0].id;
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
}

function createThread() {
  const thread = { id: crypto.randomUUID(), title: "新对话", messages: [], createdAt: Date.now() };
  state.threads.unshift(thread);
  state.activeId = thread.id;
  saveThreads();
  return thread;
}

function activeThread() {
  return state.threads.find((thread) => thread.id === state.activeId) || createThread();
}

function activeDocument() {
  return state.documents.find((doc) => doc.id === state.activeDocId) || null;
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
  for (const thread of state.threads) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thread-item${thread.id === state.activeId ? " active" : ""}`;
    button.textContent = thread.title || "新对话";
    button.addEventListener("click", () => {
      state.activeId = thread.id;
      document.body.classList.remove("sidebar-open");
      render();
    });
    els.threadList.append(button);
  }
}

function renderDocuments() {
  els.documentList.innerHTML = "";
  if (!state.documents.length) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.className = "thread-item";
    empty.innerHTML = "<span>暂无 Artifact</span><small>生成后会出现在这里</small>";
    empty.disabled = true;
    els.documentList.append(empty);
    return;
  }
  for (const doc of state.documents) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thread-item${doc.id === state.activeDocId ? " active" : ""}`;
    button.innerHTML = `<span>${escapeHtml(doc.title)}</span><small>${new Date(doc.updatedAt).toLocaleString()}</small>`;
    button.addEventListener("click", () => {
      state.activeDocId = doc.id;
      state.docOpen = true;
      state.docAutoOpenSuppressedThreadId = "";
      document.body.classList.remove("sidebar-open");
      render();
    });
    els.documentList.append(button);
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
      const content = displayAssistantMessage(message.content);
      bubble.innerHTML = renderRichDocument(content, "chat");
      body.append(bubble);
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
  const images = Array.isArray(message.attachments) ? message.attachments.filter((item) => item.kind === "image" && item.dataUrl) : [];
  const text = stripImagePlaceholders(message.content || "").trim();
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
  return actions;
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
  els.webSearchToggle.classList.toggle("active", state.webSearchEnabled);
  els.webSearchToggle.setAttribute("aria-pressed", String(state.webSearchEnabled));
}

function queueStreamRender(thread, assistant) {
  if (streamRenderQueued) return;
  streamRenderQueued = true;
  requestAnimationFrame(() => {
    streamRenderQueued = false;
    renderMessages();
    if (state.expectDocument || looksLikeDocument(assistant.content)) {
      upsertArtifactFromAssistant(assistant.content, thread);
      renderDocuments();
      renderDocumentPanel();
    }
  });
}

function renderDocumentPanel() {
  els.chatView.classList.toggle("doc-closed", !state.docOpen);
  els.docPanel.classList.toggle("collapsed", !state.docOpen);
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
  els.downloadHtml.classList.toggle("hidden", doc.type !== "document" && doc.type !== "html");
  els.downloadDoc.textContent = doc.type === "html" ? "下载源码" : "下载";
  els.artifactPreviewTab.classList.toggle("active", doc.view === "preview");
  els.artifactSourceTab.classList.toggle("active", doc.view === "source");
  els.artifactPreviewTab.disabled = doc.type === "code";
  if (doc.view === "source") {
    els.docPreview.className = "doc-preview source-preview";
    els.docPreview.innerHTML = `<pre><code>${escapeHtml(doc.content)}</code></pre>`;
    return;
  }
  els.docPreview.className = `doc-preview ${doc.type === "html" ? "html-preview" : ""}`;
  if (doc.type === "html") {
    els.docPreview.innerHTML = `<iframe title="Artifact preview" sandbox="allow-scripts allow-forms allow-modals allow-popups" srcdoc="${escapeAttribute(doc.content)}"></iframe>`;
  } else {
    els.docPreview.innerHTML = renderRichDocument(doc.content, "document");
  }
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
  const displayAttachments = attachmentsForMessage(attachments);
  const attachmentText = attachments.filter((file) => file.kind !== "image").map(attachmentTextForMessage).join("");
  const userContent = `${text}${attachmentText}`.trim();
  const apiContent = buildUserApiContent(text, attachments);
  const useWebSearch = state.webSearchEnabled || shouldUseWebSearch(userContent);
  state.expectDocument = shouldCreateDocument(userContent) || attachments.some((item) => item.kind === "document");

  thread.messages.push({ role: "user", content: userContent, attachments: displayAttachments });
  thread.title = titleFrom(userContent || displayAttachments[0]?.name || "图片");
  thread.messages.push({ role: "assistant", content: "" });
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
      body: JSON.stringify({ messages: messagesForApi(thread, apiContent), webSearch: useWebSearch }),
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
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const eventText of events) {
        if (eventText.startsWith(":")) continue;
        const line = eventText.split(/\n/).find((item) => item.startsWith("data:"));
        if (!line) continue;
        let data;
        try {
          data = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (data.delta) {
          assistant.content += data.delta;
          queueStreamRender(thread, assistant);
        }
      }
    }
    if (state.expectDocument || looksLikeDocument(assistant.content) || looksLikeRunnableArtifact(assistant.content)) {
      upsertArtifactFromAssistant(assistant.content, thread);
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

function upsertArtifactFromAssistant(content, thread) {
  const artifact = extractArtifact(content, thread);
  const existing = state.documents.find((doc) => doc.threadId === thread.id);
  const payload = {
    id: existing?.id || crypto.randomUUID(),
    threadId: thread.id,
    title: artifact.title,
    content: artifact.content,
    type: artifact.type,
    language: artifact.language,
    filePath: artifact.filePath,
    template: artifact.template,
    source: artifact.source,
    view: artifact.view,
    updatedAt: Date.now(),
  };
  if (existing) Object.assign(existing, payload);
  else state.documents.unshift(payload);
  state.activeDocId = payload.id;
  if (state.docAutoOpenSuppressedThreadId !== thread.id) {
    state.docOpen = true;
  }
  saveDocuments();
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

function attachmentTextForMessage(file) {
  if (file.kind === "image") return `\n\n[图片：${file.name}]`;
  return `\n\n[附件：${file.name}]\n${file.content}`;
}

function attachmentsForMessage(attachments) {
  return attachments
    .filter((file) => file.kind === "image" && file.dataUrl)
    .map((file) => ({
      kind: "image",
      name: file.name,
      mime: file.mime,
      dataUrl: file.dataUrl,
    }));
}

function buildUserApiContent(text, attachments) {
  const parts = [];
  const textContent = `${text}${attachments.filter((file) => file.kind !== "image").map(attachmentTextForMessage).join("")}`.trim();
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
  const doc = {
    id: crypto.randomUUID(),
    threadId: "",
    title,
    content: String(content || "").slice(0, type === "html" ? 500000 : 100000),
    type,
    language: type === "html" ? "html" : "markdown",
    source,
    view: defaultArtifactView({ type }),
    updatedAt: Date.now(),
  };
  state.documents.unshift(doc);
  state.activeDocId = doc.id;
  state.docOpen = true;
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
  localStorage.setItem(DOCUMENTS_KEY, JSON.stringify(state.documents.slice(0, 50)));
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
