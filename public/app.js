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
  abortController: null,
  docOpen: false,
  docAutoOpenSuppressedThreadId: "",
  expectDocument: false,
  webSearchEnabled: false,
  searchQuery: "",
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
  shareDoc: document.querySelector("#shareDoc"),
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

// Mobile: handle virtual keyboard resize (iOS/Android)
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    // Adjust layout when keyboard appears/disappears
    document.documentElement.style.setProperty('--vh', window.visualViewport.height + 'px');
  });
  document.documentElement.style.setProperty('--vh', window.visualViewport.height + 'px');
}

// Mobile: scroll to bottom when input is focused
document.addEventListener('focusin', (e) => {
  if (e.target === els.prompt) {
    setTimeout(() => {
      els.messages.scrollTop = els.messages.scrollHeight;
    }, 300);
  }
});

// Mobile: close sidebar on backdrop tap
document.addEventListener('click', (e) => {
  if (document.body.classList.contains('sidebar-open') && !e.target.closest('.sidebar') && !e.target.closest('.mobile-only')) {
    document.body.classList.remove('sidebar-open');
  }
});

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
  document.querySelector("#bugReportBtn")?.addEventListener("click", showBugReportModal);
  els.newChat.addEventListener("click", () => {
    state.docAutoOpenSuppressedThreadId = "";
    createThread();
    render();
  });
  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.streaming) { stopGeneration(); return; }
    send(e);
  });
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
  els.shareDoc?.addEventListener("click", shareCurrentDoc);
  // Show share button if Web Share API is available (mobile)
  if (els.shareDoc) {
    if (navigator.share) {
      
      els.shareDoc.classList.add("visible");
    } else {
      els.shareDoc.classList.remove("visible");
    }
  }
  els.downloadDoc.addEventListener("click", () => {
    const doc = activeDocument();
    if (!doc) return;
    if (doc.type === "file" && doc.fileId) {
      // File artifact: direct download
      const a = document.createElement("a");
      a.href = `/api/files/${doc.fileId}`;
      a.download = doc.title;
      a.click();
    } else if (doc.type === "html") {
      downloadCurrentDoc("html");
    } else if (doc.type === "code") {
      downloadCurrentDoc("source");
    } else {
      // Document type: download as DOCX
      exportCurrentDocAsDocx();
    }
  });
  els.uploadGoogleDoc.addEventListener("click", uploadCurrentDocToGoogle);
  els.artifactPreviewTab.addEventListener("click", () => setArtifactView("preview"));
  els.artifactSourceTab.addEventListener("click", () => setArtifactView("source"));
  els.closeDocPanel.addEventListener("click", () => {
    state.docOpen = false;
    state.docAutoOpenSuppressedThreadId = state.activeId;
    renderDocumentPanel();
    renderDocFab();
  });
  els.toggleDocPanel.addEventListener("click", () => {
    state.docOpen = !state.docOpen;
    if (state.docOpen) state.docAutoOpenSuppressedThreadId = "";
    else state.docAutoOpenSuppressedThreadId = state.activeId;
    if (state.docOpen && !state.activeDocId && threadDocuments()[0]) state.activeDocId = threadDocuments()[0].id;
    renderDocumentPanel();
    renderDocFab();
  });
  els.sidebarToggle.addEventListener("click", () => document.body.classList.toggle("sidebar-open"));

  els.prompt.addEventListener("input", updateSendButton);
  initScrollBottomBtn();
  updateSendButton();

  document.querySelectorAll(".starter").forEach((button) => {
    button.addEventListener("click", () => {
      els.prompt.value = button.dataset.prompt || "";
      autosize();
      els.prompt.focus();
    });
  });

  // Drag-and-drop file upload on the main chat column
  const chatColumn = document.querySelector(".chat-column");
  if (chatColumn) {
    chatColumn.addEventListener("dragenter", handleDragEnter);
    chatColumn.addEventListener("dragover", handleDragOver);
    chatColumn.addEventListener("dragleave", handleDragLeave);
    chatColumn.addEventListener("drop", handleDrop);
  }

  // Keyboard shortcuts
  document.addEventListener("keydown", handleKeyboardShortcut);
}

let _dragDepth = 0;

function handleDragEnter(e) {
  e.preventDefault();
  if (!state.authenticated) return;
  _dragDepth++;
  document.querySelector(".chat-column")?.classList.add("drag-over");
}

function handleDragOver(e) {
  e.preventDefault();
}

function handleDragLeave() {
  _dragDepth--;
  if (_dragDepth <= 0) {
    _dragDepth = 0;
    document.querySelector(".chat-column")?.classList.remove("drag-over");
  }
}

async function handleDrop(e) {
  e.preventDefault();
  _dragDepth = 0;
  document.querySelector(".chat-column")?.classList.remove("drag-over");
  if (!state.authenticated) return;
  const files = Array.from(e.dataTransfer.files).slice(0, 6);
  if (!files.length) return;
  for (const file of files) {
    await addFileAttachment(file);
  }
  saveDocuments();
  render();
}

function handleKeyboardShortcut(e) {
  if (!state.authenticated) return;
  const tag = document.activeElement?.tagName?.toLowerCase();
  const isEditing = tag === "textarea" || tag === "input" || document.activeElement?.isContentEditable;

  // Cmd/Ctrl+N: new conversation (skip if typing in an input)
  if ((e.metaKey || e.ctrlKey) && e.key === "n" && !isEditing) {
    e.preventDefault();
    state.docAutoOpenSuppressedThreadId = "";
    createThread();
    render();
    return;
  }

  // Esc: close document panel if open
  if (e.key === "Escape" && state.docOpen) {
    state.docOpen = false;
    state.docAutoOpenSuppressedThreadId = state.activeId;
    renderDocumentPanel();
    renderDocFab();
    return;
  }

  // Cmd/Ctrl+K: focus the prompt input
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    els.prompt?.focus();
  }
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

function showBugReportModal() {
  document.querySelector(".bug-modal")?.remove();
  const bugImages = []; // base64 strings
  const modal = document.createElement("div");
  modal.className = "bug-modal";
  modal.innerHTML = `
    <div class="bug-modal-backdrop"></div>
    <div class="bug-modal-card">
      <h3>反馈问题</h3>
      <p>描述你遇到的问题或建议：</p>
      <textarea id="bugText" rows="5" placeholder="比如：上传图片后无法识别内容...&#10;&#10;可以直接粘贴截图 (Ctrl+V)"></textarea>
      <div class="bug-images"></div>
      <div class="bug-upload-row">
        <label class="bug-upload-btn">
          <input type="file" accept="image/*" multiple style="display:none" />
          添加截图
        </label>
        <span class="bug-upload-hint">支持粘贴、拖拽或点击上传</span>
      </div>
      <div class="bug-modal-actions">
        <button class="bug-cancel">取消</button>
        <button class="bug-submit">提交</button>
      </div>
      <div class="bug-msg"></div>
    </div>`;
  document.body.append(modal);

  const imagesDiv = modal.querySelector(".bug-images");
  const textarea = modal.querySelector("#bugText");

  function addImage(dataUrl) {
    if (bugImages.length >= 5) return; // max 5 images
    bugImages.push(dataUrl);
    renderBugImages();
  }

  function renderBugImages() {
    imagesDiv.innerHTML = "";
    bugImages.forEach((src, i) => {
      const wrap = document.createElement("div");
      wrap.className = "bug-image-thumb";
      wrap.innerHTML = `<img src="${src}" /><span class="bug-image-remove" data-idx="${i}">&times;</span>`;
      imagesDiv.append(wrap);
    });
    imagesDiv.querySelectorAll(".bug-image-remove").forEach(btn => {
      btn.addEventListener("click", () => { bugImages.splice(Number(btn.dataset.idx), 1); renderBugImages(); });
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  }

  // File input
  modal.querySelector('input[type="file"]').addEventListener("change", async (e) => {
    for (const file of e.target.files) {
      if (!file.type.startsWith("image/")) continue;
      addImage(await fileToDataUrl(file));
    }
    e.target.value = "";
  });

  // Paste
  textarea.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addImage(await fileToDataUrl(file));
      }
    }
  });

  // Drag & drop
  const card = modal.querySelector(".bug-modal-card");
  card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drag-over"); });
  card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
  card.addEventListener("drop", async (e) => {
    e.preventDefault(); card.classList.remove("drag-over");
    for (const file of e.dataTransfer.files) {
      if (file.type.startsWith("image/")) addImage(await fileToDataUrl(file));
    }
  });

  modal.querySelector(".bug-cancel").addEventListener("click", () => modal.remove());
  modal.querySelector(".bug-modal-backdrop").addEventListener("click", () => modal.remove());
  modal.querySelector(".bug-submit").addEventListener("click", async () => {
    const text = modal.querySelector("#bugText").value.trim();
    const msg = modal.querySelector(".bug-msg");
    if (!text && !bugImages.length) { msg.textContent = "请填写内容或添加截图"; msg.style.color = "var(--accent)"; return; }
    modal.querySelector(".bug-submit").disabled = true;
    modal.querySelector(".bug-submit").textContent = "提交中...";
    try {
      const resp = await fetch("/api/bug-report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, images: bugImages }) });
      if (!resp.ok) throw new Error((await resp.json()).error || "提交失败");
      msg.textContent = "感谢反馈！";
      msg.style.color = "#4d9950";
      setTimeout(() => modal.remove(), 1200);
    } catch (e) {
      msg.textContent = String(e.message);
      msg.style.color = "var(--accent)";
      modal.querySelector(".bug-submit").disabled = false;
      modal.querySelector(".bug-submit").textContent = "提交";
    }
  });
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  state.authenticated = false;
  // Clear local data so next login starts fresh
  state.threads = [];
  state.activeId = "";
  state.activeDocId = "";
  try { saveThreads(); } catch {}
  showLogin();
}

function showLogin() {
  els.loginView.classList.remove("hidden");
  els.chatView.classList.add("hidden");
  document.body.classList.remove("sidebar-open");
}

async function showChat() {
  els.loginView.classList.add("hidden");
  els.chatView.classList.remove("hidden");
  initSidebarSearch();
  // Load threads from server (SQLite)
  try {
    const serverThreads = await fetchJson("/api/threads");
    // Server is source of truth — replace local threads with server data
    const localMap = new Map(state.threads.map(t => [t.id, t]));
    state.threads = serverThreads.map(t => {
      const local = localMap.get(t.id);
      return {
        id: t.id,
        title: t.title,
        archived: !!t.archived,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        messages: local?.messages || [], // lazy-loaded
        documents: local?.documents || [],
        _loaded: local?._loaded || false,
      };
    });
    // If server has no threads (new account), clear any leftover local data
    if (!serverThreads.length) {
      state.threads = [];
    }
  } catch (e) {
    console.warn("[Sync] Failed to load threads from server, using local cache:", e.message);
  }
  if (!state.threads.length) createThread();
  state.activeId ||= state.threads[0].id;
  render();
  // Load messages for active thread (force reload to pick up ratings)
  await loadThreadData(state.activeId, true);
  render();
  // Migrate localStorage data to server (one-time)
  await migrateLocalToServer();
  resumePendingGoogleUpload();
  // Fix stuck "running" tool cards from interrupted streams
  fixStuckToolCards();
  // Resume any pending long-doc background jobs
  resumeLongDocJobs();
}

// Save partial content and warn if user leaves/refreshes during streaming
window.addEventListener("beforeunload", (e) => {
  if (state.streaming) {
    try { saveThreads(); } catch {}
    e.preventDefault();
  }
});

// Auto-refresh active thread when tab regains focus (cross-device sync)
let lastRefreshTime = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !state.streaming) {
    const now = Date.now();
    // Cooldown: don't refresh more than once per 5 seconds (prevents download dialog flicker)
    if (now - lastRefreshTime < 5000) return;
    lastRefreshTime = now;
    refreshActiveThread();
  }
});

async function refreshActiveThread() {
  if (!state.activeId || state.streaming) return;
  try {
    // Refresh thread list
    const serverThreads = await fetchJson("/api/threads");
    if (serverThreads.length) {
      const localMap = new Map(state.threads.map(t => [t.id, t]));
      state.threads = serverThreads.map(t => {
        const local = localMap.get(t.id);
        return {
          id: t.id,
          title: t.title,
          archived: !!t.archived,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
          messages: local?.messages || [],
          documents: local?.documents || [],
          _loaded: local?._loaded || false,
        };
      });
    }
    // Force reload active thread messages from server
    await loadThreadData(state.activeId, true);
    saveThreads();
    render();
  } catch (e) {
    console.warn("[Sync] refresh failed:", e.message);
  }
}

function createThread() {
  const thread = { id: crypto.randomUUID(), title: "新对话", messages: [], documents: [], createdAt: new Date().toISOString(), _loaded: true };
  state.threads.unshift(thread);
  state.activeId = thread.id;
  state.activeDocId = "";
  saveThreads();
  // Persist to server (fire-and-forget)
  fetch("/api/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: thread.id, title: thread.title }),
  }).catch(() => {});
  return thread;
}

function activeThread() {
  return state.threads.find((thread) => thread.id === state.activeId) || createThread();
}

async function migrateLocalToServer() {
  const MIGRATED_KEY = "claude-lite-migrated-to-sqlite";
  if (localStorage.getItem(MIGRATED_KEY)) return;
  // Check if we have local threads with messages that server doesn't have
  const localThreads = state.threads.filter(t => t.messages && t.messages.length > 0 && t._loaded !== false);
  if (!localThreads.length) {
    localStorage.setItem(MIGRATED_KEY, "1");
    return;
  }
  try {
    const resp = await fetch("/api/migrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threads: localThreads }),
    });
    const result = await resp.json();
    console.log("[Migration]", result);
    localStorage.setItem(MIGRATED_KEY, "1");
  } catch (e) {
    console.warn("[Migration] Failed:", e.message);
  }
}

async function loadThreadData(threadId, forceReload) {
  const thread = state.threads.find(t => t.id === threadId);
  if (!thread) return;
  if (thread._loaded && !forceReload) return;
  try {
    const [serverMessages, documents, ratings] = await Promise.all([
      fetchJson("/api/threads/" + threadId + "/messages"),
      fetchJson("/api/threads/" + threadId + "/documents"),
      fetchJson("/api/ratings?thread_id=" + threadId).catch(() => []),
    ]);
    const ratingMap = new Map(ratings.map(r => [r.message_id, r.rating]));
    const mappedServer = serverMessages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls,
      _feedback: ratingMap.has(m.id) ? (ratingMap.get(m.id) === 1 ? "up" : "down") : null,
    }));
    // Keep local messages if they have more content (e.g. partial streaming saved locally)
    const localLen = (thread.messages || []).reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : 0), 0);
    const serverLen = mappedServer.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : 0), 0);
    if (localLen > serverLen && thread.messages.length >= mappedServer.length) {
      // Local has more content — keep it and sync to server
      console.log("[Sync] Local messages have more content, keeping local and syncing up");
      // Apply ratings to local messages
      for (const m of thread.messages) {
        if (m.id && ratingMap.has(m.id)) m._feedback = ratingMap.get(m.id) === 1 ? "up" : "down";
      }
      syncMessages(threadId, thread.messages);
    } else {
      thread.messages = mappedServer;
    }
    // Merge documents: keep local docs not on server, prefer version with more content
    const serverDocs = documents.map(d => ({
      id: d.id,
      title: d.title,
      type: d.type,
      content: d.content,
      language: d.language,
      description: d.description,
      filePath: d.filePath || d.file_path || "",
      versions: d.versions || [],
    }));
    const serverDocIds = new Set(serverDocs.map(d => d.id));
    const localDocs = (thread.documents || []);
    // Keep local-only docs (not yet synced to server)
    const localOnly = localDocs.filter(d => !serverDocIds.has(d.id));
    // For docs on both sides, prefer the one with more content
    const merged = serverDocs.map(sd => {
      const ld = localDocs.find(d => d.id === sd.id);
      if (ld && (ld.content || "").length > (sd.content || "").length) return ld;
      // Preserve filePath from local if server lost it
      if (ld?.filePath && !sd.filePath) sd.filePath = ld.filePath;
      return sd;
    });
    thread.documents = [...merged, ...localOnly];
    // Re-sync any local-only docs to server
    for (const doc of localOnly) syncDocument(threadId, doc);
    thread._loaded = true;
    saveThreads(); // cache locally
    render();
  } catch (e) {
    console.warn("[Sync] Failed to load thread data:", e.message);
  }
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
  renderDocFab();
}

// Floating action button for opening documents on mobile
function renderDocFab() {
  let fab = document.querySelector("#docFab");
  const docs = threadDocuments();
  const shouldShow = docs.length > 0 && !state.docOpen && window.innerWidth <= 1020;
  if (!shouldShow) {
    if (fab) fab.remove();
    return;
  }
  if (!fab) {
    fab = document.createElement("button");
    fab.id = "docFab";
    fab.className = "doc-fab";
    fab.setAttribute("aria-label", "打开文档");
    fab.addEventListener("click", () => {
      state.docOpen = true;
      if (!state.activeDocId && docs[0]) state.activeDocId = docs[0].id;
      render();
    });
    document.body.append(fab);
  }
  const count = docs.length;
  const latest = docs[0]?.title || "文档";
  fab.innerHTML = `<span class="doc-fab-icon">◆</span><span class="doc-fab-label">${escapeHtml(latest.slice(0, 12))}${latest.length > 12 ? "…" : ""}${count > 1 ? " +" + (count - 1) : ""}</span>`;
}

function threadMatchesSearch(thread, query) {
  if ((thread.title || "").toLowerCase().includes(query)) return true;
  for (const msg of (thread.messages || [])) {
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.toLowerCase().includes(query)) return true;
  }
  return false;
}

function highlightText(text, query) {
  if (!query) return escapeHtml(text);
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  let result = "";
  let pos = 0;
  while (pos < text.length) {
    const idx = lower.indexOf(q, pos);
    if (idx === -1) { result += escapeHtml(text.slice(pos)); break; }
    result += escapeHtml(text.slice(pos, idx));
    result += `<mark class="search-highlight">${escapeHtml(text.slice(idx, idx + q.length))}</mark>`;
    pos = idx + q.length;
  }
  return result;
}

function initSidebarSearch() {
  if (document.querySelector("#sidebarSearch")) return;
  const sidebar = document.querySelector(".sidebar");
  const navLabel = sidebar?.querySelector(".nav-label");
  if (!sidebar || !navLabel) return;

  const wrapper = document.createElement("div");
  wrapper.className = "sidebar-search";

  const icon = document.createElement("span");
  icon.className = "sidebar-search-icon";
  icon.setAttribute("aria-hidden", "true");

  const input = document.createElement("input");
  input.id = "sidebarSearch";
  input.type = "text";
  input.placeholder = "搜索对话";
  input.className = "sidebar-search-input";
  input.autocomplete = "off";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "sidebar-search-clear hidden";
  clearBtn.setAttribute("aria-label", "清空搜索");
  clearBtn.textContent = "×";

  wrapper.append(icon, input, clearBtn);
  sidebar.insertBefore(wrapper, navLabel);

  input.addEventListener("input", () => {
    state.searchQuery = input.value;
    clearBtn.classList.toggle("hidden", !input.value);
    renderThreads();
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    state.searchQuery = "";
    clearBtn.classList.add("hidden");
    renderThreads();
    input.focus();
  });
}

function renderThreads() {
  els.threadList.innerHTML = "";
  const query = state.searchQuery.trim().toLowerCase();
  const visible = state.threads.filter((t) => !t.archived && (!query || threadMatchesSearch(t, query)));
  for (const thread of visible) {
    const item = document.createElement("div");
    item.className = `thread-item${thread.id === state.activeId ? " active" : ""}`;
    const label = document.createElement("span");
    label.className = "thread-label";
    const titleText = thread.title || "新对话";
    if (query) {
      label.innerHTML = highlightText(titleText, query);
    } else {
      label.textContent = titleText;
    }
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
      // Load/refresh from server for cross-device sync
      loadThreadData(thread.id, true);
    });
    els.threadList.append(item);
  }
  if (visible.length === 0 && query) {
    const empty = document.createElement("div");
    empty.className = "thread-item thread-search-empty";
    empty.textContent = "没有匹配的对话";
    els.threadList.append(empty);
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
        restore.addEventListener("click", (e) => { e.stopPropagation(); thread.archived = false; saveThreads(); syncThreadMeta(thread.id, { archived: false }); render(); });
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

// ─── Inline Modal (themed replacement for window.prompt / window.confirm) ───

function showModal({ title, message, inputDefault, isPrompt, danger }) {
  return new Promise((resolve) => {
    let resolved = false;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const card = document.createElement("div");
    card.className = "modal-card";

    if (title || message) {
      const label = document.createElement(isPrompt ? "h3" : "p");
      label.className = isPrompt ? "modal-title" : "modal-message";
      label.textContent = title || message;
      card.append(label);
    }

    let input;
    if (isPrompt) {
      input = document.createElement("input");
      input.className = "modal-input";
      input.type = "text";
      input.value = inputDefault || "";
      card.append(input);
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-btn modal-btn-cancel";
    cancelBtn.textContent = "取消";
    cancelBtn.type = "button";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = `modal-btn modal-btn-confirm${danger ? " danger" : ""}`;
    confirmBtn.textContent = "确定";
    confirmBtn.type = "button";

    actions.append(cancelBtn, confirmBtn);
    card.append(actions);
    overlay.append(card);
    document.body.append(overlay);

    if (isPrompt && input) {
      input.focus();
      input.select();
    } else {
      confirmBtn.focus();
    }

    function done(result) {
      if (resolved) return;
      resolved = true;
      document.removeEventListener("keydown", keyHandler);
      overlay.remove();
      resolve(result);
    }

    function keyHandler(e) {
      if (e.key === "Escape") { e.preventDefault(); done(isPrompt ? null : false); }
      else if (e.key === "Enter" && e.target !== cancelBtn) { e.preventDefault(); done(isPrompt ? input?.value ?? null : true); }
    }

    cancelBtn.addEventListener("click", () => done(isPrompt ? null : false));
    confirmBtn.addEventListener("click", () => done(isPrompt ? input?.value ?? null : true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(isPrompt ? null : false); });
    document.addEventListener("keydown", keyHandler);
  });
}

function showPromptModal(title, defaultValue) {
  return showModal({ title, isPrompt: true, inputDefault: defaultValue });
}

function showConfirmModal(message, { danger = false } = {}) {
  return showModal({ message, isPrompt: false, danger });
}

// ─────────────────────────────────────────────────────────────────────────────

async function deleteThread(id) {
  if (!await showConfirmModal("确定删除这个对话？", { danger: true })) return;
  fetch("/api/threads/" + id, { method: "DELETE" }).catch(() => {});
  state.threads = state.threads.filter((t) => t.id !== id);
  if (state.activeId === id) {
    state.activeId = state.threads[0]?.id || "";
    if (!state.threads.length) createThread();
  }
  saveThreads();
  render();
}

async function renameThread(id) {
  const thread = state.threads.find((t) => t.id === id);
  if (!thread) return;
  const name = await showPromptModal("重命名对话：", thread.title || "");
  if (name === null) return;
  thread.title = name.trim() || "新对话";
  syncThreadMeta(thread.id, { title: thread.title });
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
    const fileIcon = doc.type === "file" ? { docx: "📄", xlsx: "📊", pptx: "📽", pdf: "📕", csv: "📋", zip: "📦" }[doc.language] || "📁" : "";
    item.innerHTML = `<span class="thread-label">${fileIcon ? fileIcon + " " : ""}${escapeHtml(doc.title)}</span><small>${doc.source || ""}</small>`;

    const more = document.createElement("button");
    more.className = "thread-more-btn";
    more.textContent = "⋯";
    more.title = "更多操作";
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const thread = activeThread();
      showContextMenu(e.currentTarget, [
        { label: "重命名", action: async () => { const n = await showPromptModal("重命名：", doc.title); if (n !== null) { doc.title = n.trim() || doc.title; saveThreads(); render(); } } },
        { label: "删除", action: async () => { if (!await showConfirmModal(`删除「${doc.title}」？`, { danger: true })) return; thread.documents = (thread.documents || []).filter((d) => d.id !== doc.id); if (state.activeDocId === doc.id) state.activeDocId = (thread.documents[0]?.id) || ""; saveThreads(); render(); }, danger: true },
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
      const { clean: cleanContent, suggestions, options } = parseInteractive(displayAssistantMessage(message.content));
      if (cleanContent.trim()) {
        bubble.innerHTML = renderRichDocument(cleanContent, "chat");
        body.append(bubble);
      }
      body.append(renderMessageActions(message, isStreamingMessage));
      // Show interactive elements on last assistant message (not during streaming)
      const isLastMsg = message === thread.messages.at(-1);
      if (isLastMsg && !isStreamingMessage) {
        if (options) body.append(renderOptions(options));
        if (suggestions.length) body.append(renderSuggestions(suggestions));
      }
      wrapper.append(body);
    } else {
      bubble.innerHTML = renderUserMessage(message);
      const userBody = document.createElement("div");
      userBody.className = "message-body";
      userBody.append(bubble);
      userBody.append(renderMessageActions(message, false));
      wrapper.append(userBody);
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

// Extract interactive options and suggested follow-ups from assistant message
function parseInteractive(text) {
  if (!text || typeof text !== "string") return { clean: text || "", suggestions: [], options: null };
  let clean = text;
  let suggestions = [];
  let options = null;

  // Parse <<options>> (supports single object or array of questions)
  const optRegex = /<<options>>\s*\n?\s*([\[{][\s\S]*?[\]}])\s*\n?\s*<<\/options>>/;
  const optMatch = clean.match(optRegex);
  if (optMatch) {
    clean = clean.replace(optRegex, "").trimEnd();
    try {
      const parsed = JSON.parse(optMatch[1]);
      if (Array.isArray(parsed) && parsed.length && parsed[0].question) {
        // Array of questions
        options = parsed.filter(q => q.question && Array.isArray(q.choices) && q.choices.length);
      } else if (parsed.question && Array.isArray(parsed.choices)) {
        // Single question — wrap in array
        options = [parsed];
      }
      if (options && !options.length) options = null;
    } catch {}
  }

  // Parse <<suggestions>>
  const sugRegex = /<<suggestions>>\s*\n?\s*(\[[\s\S]*?\])\s*\n?\s*<<\/suggestions>>/;
  const sugMatch = clean.match(sugRegex);
  if (sugMatch) {
    clean = clean.replace(sugRegex, "").trimEnd();
    try {
      const arr = JSON.parse(sugMatch[1]);
      if (Array.isArray(arr) && arr.every(s => typeof s === "string")) {
        suggestions = arr.slice(0, 4);
      }
    } catch {}
  }

  return { clean, suggestions, options };
}

function renderOptions(questions) {
  const container = document.createElement("div");
  container.className = "options-card";

  // Track selections for each question
  const selections = new Array(questions.length).fill(null);

  questions.forEach((q, qIdx) => {
    const group = document.createElement("div");
    group.className = "options-group";

    const qLabel = document.createElement("div");
    qLabel.className = "options-question";
    qLabel.textContent = q.question;
    group.append(qLabel);

    const choicesDiv = document.createElement("div");
    choicesDiv.className = "options-choices";

    for (const choice of q.choices.slice(0, 5)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option-btn";
      const label = document.createElement("span");
      label.className = "option-label";
      label.textContent = choice.label;
      btn.append(label);
      if (choice.desc) {
        const desc = document.createElement("span");
        desc.className = "option-desc";
        desc.textContent = choice.desc;
        btn.append(desc);
      }
      btn.addEventListener("click", () => {
        if (state.streaming) return;
        // Toggle selection
        selections[qIdx] = choice.label;
        // Visual feedback: mark selected
        choicesDiv.querySelectorAll(".option-btn").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        // Auto-submit when all questions answered
        const answered = selections.filter(Boolean).length;
        if (answered === questions.length) {
          setTimeout(() => submitSelections(), 300);
        }
        // Update counter
        updateSubmitHint();
      });
      choicesDiv.append(btn);
    }
    group.append(choicesDiv);
    container.append(group);
  });

  // Submit bar
  const footer = document.createElement("div");
  footer.className = "options-footer";
  const counter = document.createElement("span");
  counter.className = "options-counter";
  counter.textContent = "点击选项回答";
  footer.append(counter);
  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "options-submit";
  submitBtn.textContent = "提交";
  submitBtn.disabled = true;
  submitBtn.addEventListener("click", () => submitSelections());
  footer.append(submitBtn);
  container.append(footer);

  function updateSubmitHint() {
    const answered = selections.filter(Boolean).length;
    counter.textContent = `已选 ${answered}/${questions.length}`;
    submitBtn.disabled = answered === 0;
  }

  function submitSelections() {
    if (state.streaming) return;
    const parts = [];
    questions.forEach((q, i) => {
      if (selections[i]) parts.push(`${q.question} ${selections[i]}`);
    });
    if (!parts.length) return;
    els.prompt.value = parts.join("；");
    autosize();
    container.remove();
    document.querySelectorAll(".suggestions").forEach(el => el.remove());
    send(new Event("submit"));
  }

  return container;
}

function renderSuggestions(suggestions) {
  const container = document.createElement("div");
  container.className = "suggestions";
  for (const text of suggestions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggestion-chip";
    btn.textContent = text;
    btn.addEventListener("click", () => {
      if (state.streaming) return;
      els.prompt.value = text;
      autosize();
      // Remove suggestion chips immediately
      container.remove();
      // Auto-send
      send(new Event("submit"));
    });
    container.append(btn);
  }
  return container;
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
  // Feedback buttons (assistant messages only, not during streaming)
  if (message.role === "assistant" && !isStreamingMessage && message.content) {
    const feedbackDiv = document.createElement("div");
    feedbackDiv.className = "feedback-buttons";

    const thumbUp = document.createElement("button");
    thumbUp.type = "button";
    thumbUp.className = `message-action feedback-btn${message._feedback === "up" ? " active" : ""}`;
    thumbUp.title = "有帮助";
    thumbUp.innerHTML = '<span aria-hidden="true">&#x1F44D;</span>';
    thumbUp.addEventListener("click", () => submitFeedback(message, "up", thumbUp, thumbDown));

    const thumbDown = document.createElement("button");
    thumbDown.type = "button";
    thumbDown.className = `message-action feedback-btn${message._feedback === "down" ? " active" : ""}`;
    thumbDown.title = "没帮助";
    thumbDown.innerHTML = '<span aria-hidden="true">&#x1F44E;</span>';
    thumbDown.addEventListener("click", () => submitFeedback(message, "down", thumbUp, thumbDown));

    feedbackDiv.append(thumbUp, thumbDown);
    actions.append(feedbackDiv);
  }

  // Edit button for user messages
  if (message.role === "user" && !state.streaming) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "message-action";
    edit.title = "编辑消息";
    edit.innerHTML = '<span class="icon-edit" aria-hidden="true">✎</span><span>编辑</span>';
    edit.addEventListener("click", () => editUserMessage(message));
    actions.append(edit);
  }

  return actions;
}

async function submitFeedback(message, feedback, thumbUp, thumbDown) {
  if (message._feedback === feedback) return;
  message._feedback = feedback;
  thumbUp.classList.toggle("active", feedback === "up");
  thumbDown.classList.toggle("active", feedback === "down");
  try {
    const rating = feedback === "up" ? 1 : -1;
    await fetch("/api/messages/" + encodeURIComponent(message.id) + "/rate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating, thread_id: state.activeId }),
    });
  } catch (e) {
    console.error("[Feedback]", e);
  }
}

function editUserMessage(message) {
  if (state.streaming) return;
  const thread = activeThread();
  const msgIndex = thread.messages.indexOf(message);
  if (msgIndex < 0) return;

  // Put message content back in the composer
  const text = typeof message.content === "string" ? message.content : "";
  els.prompt.value = text;
  autosize();
  els.prompt.focus();

  // Remove this message and all subsequent messages
  thread.messages.splice(msgIndex);
  saveThreads();
  render();
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
  thread.messages.push({ id: crypto.randomUUID(), role: "assistant", content: "", toolCalls: [], _streamStart: Date.now() });
  state.streaming = true;
  state.abortController = new AbortController();
  updateSendButton();
  saveThreads();
  render();
  // Re-fetch
  (async () => {
    try {
      const apiContent = lastUser.content;
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: messagesForApi(thread, apiContent), threadId: thread.id }),
        signal: state.abortController.signal,
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
      if (error.name === "AbortError") {
        const lastMsg = thread.messages.at(-1);
        if (lastMsg?.role === "assistant" && !lastMsg.content) {
          lastMsg.content = "（已停止生成）";
        }
      } else {
        thread.messages.at(-1).content ||= `请求失败：${String(error.message || error).slice(0, 500)}`;
      }
    } finally {
      state.streaming = false;
      state.abortController = null;
      updateSendButton();
      const lastMsg = thread.messages.at(-1);
      if (lastMsg?.toolCalls) {
        for (const tc of lastMsg.toolCalls) {
          if (tc.status === "running") {
            tc.status = "completed";
            tc.summary = tc.summary || "连接中断";
          }
        }
      }
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
  else if (tc.name === "generate_long_document") label = `生成长文档「${tc.args?.topic || "..."}」`;
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
    output.className = `tool-code-output${tc._expanded ? " expanded" : ""}${tc.codeResult.images?.length ? " has-images" : ""}`;
    // Show generated downloadable files
    if (tc.codeResult.files?.length) {
      const filesContainer = document.createElement("div");
      filesContainer.className = "code-output-files";
      for (const f of tc.codeResult.files) {
        const a = document.createElement("a");
        a.href = `/api/files/${f.id}`;
        a.download = f.name;
        a.className = "file-download-btn";
        const ext = f.name.split(".").pop().toUpperCase();
        const sizeStr = f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(f.size / 1024)} KB`;
        a.innerHTML = `<span class="file-icon">${ext === "DOCX" ? "📄" : ext === "XLSX" ? "📊" : ext === "PPTX" ? "📽" : ext === "PDF" ? "📕" : "📁"}</span><span class="file-info"><span class="file-name">${escapeHtml(f.name)}</span><span class="file-size">${sizeStr}</span></span><span class="file-dl-icon">↓</span>`;
        filesContainer.append(a);
      }
      output.append(filesContainer);
    }
    // Show generated images inline
    if (tc.codeResult.images?.length) {
      const imgContainer = document.createElement("div");
      imgContainer.className = "code-output-images";
      for (const src of tc.codeResult.images) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = "Code output";
        imgContainer.append(img);
      }
      output.append(imgContainer);
    }
    const pre = document.createElement("pre");
    pre.textContent = tc.codeResult.output || (tc.codeResult.images?.length ? "(图表已生成)" : "(no output)");
    if (tc.codeResult.error) pre.classList.add("error");
    output.append(pre);
    card.append(output);
    card.addEventListener("click", () => {
      tc._expanded = !tc._expanded;
      output.classList.toggle("expanded", tc._expanded);
      card.querySelector(".tool-chevron")?.classList.toggle("expanded", tc._expanded);
    });
    // Auto-expand if there are images or files
    if ((tc.codeResult.images?.length || tc.codeResult.files?.length) && !tc._expanded) {
      tc._expanded = true;
      output.classList.add("expanded");
    }
  }

  // Long doc progress log with progress bar
  if (tc.name === "generate_long_document") {
    const progressDiv = document.createElement("div");
    progressDiv.className = "longdoc-progress";

    // Parse progress to determine stage and percentage
    const logs = tc._progressLog || [];
    const lastLog = logs[logs.length - 1] || "";
    let pct = 0, stageLabel = "准备中...";
    if (lastLog.includes("大纲")) { pct = 10; stageLabel = "规划大纲"; }
    if (lastLog.includes("搜索")) { pct = 20; stageLabel = "搜索参考资料"; }
    const writingMatch = lastLog.match(/第\s*(\d+).*?\/(\d+)\s*章/);
    const chapterDone = logs.filter(l => l.includes("章") && (l.includes("完成") || l.includes("done"))).length;
    if (writingMatch) {
      const current = parseInt(writingMatch[1]);
      const total = parseInt(writingMatch[2]);
      pct = 25 + Math.round((current / total) * 65);
      stageLabel = `撰写中 (${current}/${total} 章)`;
    } else if (chapterDone > 0) {
      // Estimate from completed chapters in logs
      const totalMatch = logs.join(" ").match(/(\d+)\s*章/g);
      const totalChapters = totalMatch ? Math.max(...totalMatch.map(m => parseInt(m))) : 6;
      pct = 25 + Math.round((chapterDone / totalChapters) * 65);
      stageLabel = `撰写中 (${chapterDone} 章已完成)`;
    }
    if (lastLog.includes("组装")) { pct = 92; stageLabel = "组装文档"; }
    if (lastLog.includes("文档完成")) { pct = 100; stageLabel = "完成"; }
    if (tc.status === "completed") pct = 100;

    // Progress bar
    const bar = document.createElement("div");
    bar.className = "longdoc-bar";
    bar.innerHTML = `<div class="longdoc-bar-fill" style="width:${pct}%"></div>`;
    progressDiv.append(bar);

    // Stage label + elapsed time
    const info = document.createElement("div");
    info.className = "longdoc-info";
    const elapsed = tc._startTime ? Math.round((Date.now() - tc._startTime) / 1000) : 0;
    const elapsedStr = elapsed > 0 ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}` : "";
    info.innerHTML = `<span>${escapeHtml(stageLabel)}</span>${elapsedStr ? `<span class="longdoc-elapsed">${elapsedStr}</span>` : ""}`;
    progressDiv.append(info);

    // Tip messages (rotate every 8 seconds)
    if (tc.status === "running") {
      if (!tc._startTime) tc._startTime = Date.now();
      const tips = [
        "长文档由多个子 Agent 并行撰写，每章独立生成后汇编",
        "生成过程中可以放心刷新页面，进度不会丢失",
        "每个章节约需 20-40 秒，取决于复杂度",
        "生成完成后可以导出为 DOCX 格式",
        "Opus 模型正在深度思考，好文档值得等待",
        "多个 API Key 轮流工作中，最大化生成速度",
      ];
      const tipIdx = Math.floor(Date.now() / 8000) % tips.length;
      const tipDiv = document.createElement("div");
      tipDiv.className = "longdoc-tip";
      tipDiv.textContent = tips[tipIdx];
      progressDiv.append(tipDiv);
    }

    card.append(progressDiv);

    // Detailed log (collapsed by default)
    if (logs.length > 0) {
      const toggle = document.createElement("div");
      toggle.className = "longdoc-log-toggle";
      toggle.textContent = tc._logExpanded ? "收起日志 ▴" : "查看详细日志 ▾";
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        tc._logExpanded = !tc._logExpanded;
        const thread = state.threads.find(t => t.id === state.activeId);
        const assistant = thread?.messages?.at(-1);
        if (thread && assistant) queueStreamRender(thread, assistant);
      });
      card.append(toggle);

      if (tc._logExpanded) {
        const logDiv = document.createElement("div");
        logDiv.className = "tool-code-output expanded";
        logDiv.style.maxHeight = "150px";
        logDiv.style.overflowY = "auto";
        logDiv.style.fontSize = "12px";
        logDiv.style.lineHeight = "1.6";
        logDiv.style.color = "var(--muted)";
        const logText = logs.map(l => {
          if (l.includes("完成") || l.includes("✓")) return `<span style="color:#4d9950">${escapeHtml(l)}</span>`;
          if (l.includes("失败") || l.includes("错误")) return `<span style="color:var(--accent)">${escapeHtml(l)}</span>`;
          return escapeHtml(l);
        }).join("<br>");
        logDiv.innerHTML = logText;
        card.append(logDiv);
      }
    }
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
  updateSendButton();
}

function renderSearchToggle() {
  els.webSearchToggle?.classList.toggle("active", state.webSearchEnabled);
  els.webSearchToggle?.setAttribute("aria-pressed", String(state.webSearchEnabled));
}

let lastStreamSave = 0;

function queueStreamRender(thread, assistant) {
  if (streamRenderQueued) return;
  streamRenderQueued = true;
  requestAnimationFrame(() => {
    streamRenderQueued = false;
    updateStreamingMessage(assistant);
    // Throttled save: persist partial content every 3 seconds
    const now = Date.now();
    if (now - lastStreamSave > 3000) {
      lastStreamSave = now;
      try { saveThreads(); } catch {}
    }
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
    // Remove waiting indicator if present
    body.querySelector(".stream-waiting")?.remove();
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "message-bubble streaming";
      // Insert before message-actions
      const actions = body.querySelector(".message-actions");
      if (actions) body.insertBefore(bubble, actions);
      else body.append(bubble);
    }
    bubble.innerHTML = renderRichDocument(content, "chat");
  } else if (!content.trim() && state.streaming && !body.querySelector(".stream-waiting")) {
    // No content yet — show a waiting indicator with elapsed time
    const waiting = document.createElement("div");
    waiting.className = "stream-waiting";
    waiting.innerHTML = `<span class="stream-waiting-dot"></span><span class="stream-waiting-text">思考中...</span>`;
    const actions = body.querySelector(".message-actions");
    if (actions) body.insertBefore(waiting, actions);
    else body.append(waiting);
    // Update elapsed time every second
    if (!assistant._waitingTimer) {
      assistant._waitingTimer = setInterval(() => {
        const el = document.querySelector(".stream-waiting-text");
        if (!el || !state.streaming) { clearInterval(assistant._waitingTimer); assistant._waitingTimer = null; return; }
        const sec = Math.round((Date.now() - (assistant._streamStart || Date.now())) / 1000);
        if (sec >= 5) {
          const tips = ["深度思考中", "正在推理", "组织回答中", "分析问题中"];
          el.textContent = `${tips[Math.floor(sec / 6) % tips.length]}... ${sec}s`;
        }
      }, 1000);
    }
  }

  // Scroll to bottom only if user is near the bottom; otherwise show unread badge
  const distFromBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
  if (distFromBottom <= 200) {
    els.messages.scrollTop = els.messages.scrollHeight;
  } else if (els.scrollBottomBtn) {
    els.scrollBottomBtn.querySelector(".scroll-unread")?.classList.remove("hidden");
    els.scrollBottomBtn.classList.add("visible");
  }
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
  els.uploadGoogleDoc?.classList.toggle("hidden", doc.type === "file");
  els.artifactPreviewTab?.classList.toggle("hidden", doc.type === "file");
  els.artifactSourceTab?.classList.toggle("hidden", doc.type === "file");
  els.shareDoc?.classList.toggle("hidden", doc.type === "file");
  els.downloadDoc.textContent = doc.type === "file" ? "下载" : doc.type === "html" ? "下载源码" : doc.type === "code" ? "下载源码" : "下载 DOCX";
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
  if (doc.type === "file" && doc.fileId) {
    const ext = (doc.language || doc.filePath?.split(".").pop() || "").toUpperCase();
    const sizeStr = doc.fileSize > 1024 * 1024 ? `${(doc.fileSize / 1024 / 1024).toFixed(1)} MB` : `${Math.round((doc.fileSize || 0) / 1024)} KB`;
    const iconMap = { DOCX: "📄", XLSX: "📊", PPTX: "📽", PDF: "📕", CSV: "📋", ZIP: "📦" };
    els.docPreview.innerHTML = `<div class="file-artifact-preview">
      <div class="file-artifact-icon">${iconMap[ext] || "📁"}</div>
      <div class="file-artifact-name">${escapeHtml(doc.title)}</div>
      <div class="file-artifact-meta">${ext} 文件 · ${sizeStr}</div>
      <a href="/api/files/${doc.fileId}" download="${escapeAttribute(doc.title)}" class="file-artifact-download">下载文件</a>
    </div>`;
  } else if (doc.type === "html") {
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

function updateSendButton() {
  if (state.streaming) {
    els.send.disabled = false;
    els.send.classList.add("stop-mode");
    els.send.setAttribute("aria-label", "停止生成");
    els.send.innerHTML = '<span class="icon stop-icon" aria-hidden="true"></span>';
    els.send.style.opacity = "";
    els.send.style.cursor = "";
  } else {
    els.send.classList.remove("stop-mode");
    els.send.setAttribute("aria-label", "发送");
    els.send.innerHTML = '<span class="icon arrow-up" aria-hidden="true"></span>';
    els.send.disabled = false;
    const isEmpty = !els.prompt.value.trim() && !state.attachments.length;
    els.send.style.opacity = isEmpty ? "0.4" : "";
    els.send.style.cursor = isEmpty ? "not-allowed" : "";
  }
}

function initScrollBottomBtn() {
  const btn = document.createElement("button");
  btn.id = "scrollBottomBtn";
  btn.className = "scroll-bottom-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", "跳到底部");
  btn.innerHTML = '↓<span class="scroll-unread hidden"></span>';
  els.messages.parentElement.append(btn);
  els.scrollBottomBtn = btn;

  els.messages.addEventListener("scroll", updateScrollBottomBtn);
  btn.addEventListener("click", () => {
    els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" });
    btn.querySelector(".scroll-unread").classList.add("hidden");
    btn.classList.remove("visible");
  });
}

function updateScrollBottomBtn() {
  if (!els.scrollBottomBtn) return;
  const distFromBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
  const isScrolledUp = distFromBottom > 200;
  els.scrollBottomBtn.classList.toggle("visible", isScrolledUp);
  if (!isScrolledUp) {
    els.scrollBottomBtn.querySelector(".scroll-unread")?.classList.add("hidden");
  }
}

function stopGeneration() {
  if (state.abortController) {
    state.abortController.abort();
  }
}

async function send(event) {
  if (event) event.preventDefault();
  if (state.streaming) return;
  const text = els.prompt.value.trim();
  if (!text && !state.attachments.length) return;

  const thread = activeThread();
  const attachments = [...state.attachments];
  const displayAttachments = attachmentsForDisplay(attachments);
  const userContent = text || (attachments.length ? attachments.map((f) => f.name).join(", ") : "");
  const apiContent = buildUserApiContent(text, attachments);
  state.expectDocument = false; // Artifact creation is now driven by tool use only

  thread.messages.push({ id: crypto.randomUUID(), role: "user", content: userContent, attachments: displayAttachments });
  thread.title = titleFrom(userContent || displayAttachments[0]?.name || "图片");
  thread.messages.push({ id: crypto.randomUUID(), role: "assistant", content: "", toolCalls: [], _streamStart: Date.now() });
  state.attachments = [];
  els.prompt.value = "";
  autosize();
  state.streaming = true;
  state.abortController = new AbortController();
  updateSendButton();
  saveThreads();
  render();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: messagesForApi(thread, apiContent), threadId: thread.id }),
      signal: state.abortController.signal,
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
    if (error.name === "AbortError") {
      const lastMsg = thread.messages.at(-1);
      if (lastMsg?.role === "assistant" && !lastMsg.content) {
        lastMsg.content = "（已停止生成）";
      }
    } else {
      thread.messages.at(-1).content ||= `请求失败：${String(error.message || error).slice(0, 500)}`;
    }
  } finally {
    state.streaming = false;
    state.abortController = null;
    state.expectDocument = false;
    updateSendButton();
    // Mark any still-running tool cards as failed (stream ended unexpectedly)
    const lastMsg = thread.messages.at(-1);
    if (lastMsg?.toolCalls) {
      for (const tc of lastMsg.toolCalls) {
        if (tc.status === "running") {
          tc.status = "completed";
          tc.summary = tc.summary || "连接中断";
        }
      }
    }
    saveThreads();
    saveDocuments();
    // Sync all messages to server
    syncMessages(thread.id, thread.messages);
    syncThreadMeta(thread.id, { title: thread.title });
    // Sync any new documents
    for (const doc of (thread.documents || [])) syncDocument(thread.id, doc);
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
    case "longdoc_job": {
      // Server assigned a background job ID — persist it for disconnect recovery
      if (data.jobId && thread) {
        thread._longDocJobId = data.jobId;
        thread._longDocJobSeen = 0;
        try { saveThreads(); } catch {}
      }
      break;
    }
    case "longdoc_progress": {
      // Update the generate_long_document tool card with progress
      if (assistant.toolCalls) {
        const tc = assistant.toolCalls.find(t => t.name === "generate_long_document" && t.status === "running");
        if (tc) {
          tc.summary = data.message || tc.summary;
          // Persist progress log for refresh recovery
          tc._progressLog = tc._progressLog || [];
          if (data.message) tc._progressLog.push(data.message);
          if (tc._progressLog.length > 20) tc._progressLog = tc._progressLog.slice(-15);
          // Track how many progress events we've seen (for incremental polling)
          if (thread) thread._longDocJobSeen = (thread._longDocJobSeen || 0) + 1;
          queueStreamRender(thread, assistant);
          // Save periodically so refresh shows latest state
          try { saveThreads(); } catch {}
        }
      }
      break;
    }
    case "artifact":
      upsertArtifactFromTool(data, thread);
      // Long doc job delivered artifact via SSE — clean up job tracking
      if (thread._longDocJobId) {
        delete thread._longDocJobId;
        delete thread._longDocJobSeen;
      }
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

// Fix tool cards stuck in "running" state after page refresh (stream was interrupted)
function fixStuckToolCards() {
  if (state.streaming) return; // don't touch if actively streaming
  for (const thread of state.threads) {
    for (const msg of (thread.messages || [])) {
      if (msg.role !== "assistant" || !msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        // Skip long-doc jobs — those have their own recovery via polling
        if (tc.name === "generate_long_document" && thread._longDocJobId) continue;
        if (tc.status === "running") {
          tc.status = "completed";
          tc.summary = tc.summary || "已中断（页面刷新）";
          console.log(`[Recovery] Marked stuck tool card as completed: ${tc.name}`);
        }
      }
    }
  }
  try { saveThreads(); } catch {}
}

// Resume long-doc background jobs after page refresh
function resumeLongDocJobs() {
  for (const thread of state.threads) {
    if (!thread._longDocJobId) continue;
    const jobId = thread._longDocJobId;
    // Find the tool card that was running
    const lastMsg = [...(thread.messages || [])].reverse().find(m => m.role === "assistant" && m.toolCalls);
    const tc = lastMsg?.toolCalls?.find(t => t.name === "generate_long_document" && t.status === "running");
    if (!tc) {
      // Tool already completed or doesn't exist — clean up
      delete thread._longDocJobId;
      delete thread._longDocJobSeen;
      try { saveThreads(); } catch {}
      continue;
    }
    console.log(`[LongDoc] Resuming job ${jobId} for thread ${thread.id}`);
    pollLongDocJob(thread, lastMsg, tc, jobId);
  }
}

async function pollLongDocJob(thread, assistant, tc, jobId) {
  const seen = thread._longDocJobSeen || 0;
  let pollCount = 0;
  const maxPolls = 300; // ~10 min at 2s interval
  const interval = 2000;

  const poll = async () => {
    try {
      const sinceIdx = (thread._longDocJobSeen || 0);
      const res = await fetchJson(`/api/job/${jobId}?since=${sinceIdx}`);

      // Apply new progress events
      if (res.progress?.length) {
        for (const p of res.progress) {
          tc.summary = p.message || tc.summary;
          tc._progressLog = tc._progressLog || [];
          if (p.message) tc._progressLog.push(p.message);
          if (tc._progressLog.length > 20) tc._progressLog = tc._progressLog.slice(-15);
        }
        thread._longDocJobSeen = res.progressTotal;
        queueStreamRender(thread, assistant);
        try { saveThreads(); } catch {}
      }

      if (res.status === "completed") {
        tc.status = "completed";
        tc.summary = res.progress?.slice(-1)?.[0]?.message || tc.summary;
        // Apply the artifact
        if (res.artifact) {
          upsertArtifactFromTool(res.artifact, thread);
          renderDocuments();
          renderDocumentPanel();
        }
        // Clean up job tracking
        delete thread._longDocJobId;
        delete thread._longDocJobSeen;
        queueStreamRender(thread, assistant);
        try { saveThreads(); } catch {}
        console.log(`[LongDoc] Job ${jobId} completed successfully`);
        return; // stop polling
      }

      if (res.status === "failed") {
        tc.status = "completed";
        tc.summary = `生成失败: ${res.error || "未知错误"}`;
        delete thread._longDocJobId;
        delete thread._longDocJobSeen;
        queueStreamRender(thread, assistant);
        try { saveThreads(); } catch {}
        console.error(`[LongDoc] Job ${jobId} failed:`, res.error);
        return; // stop polling
      }

      // Still running — continue polling
      pollCount++;
      if (pollCount < maxPolls) {
        setTimeout(poll, interval);
      } else {
        console.warn(`[LongDoc] Job ${jobId} polling timeout`);
        tc.summary = "生成超时，请刷新重试";
        tc.status = "completed";
        delete thread._longDocJobId;
        queueStreamRender(thread, assistant);
        try { saveThreads(); } catch {}
      }
    } catch (err) {
      console.error(`[LongDoc] Poll error for job ${jobId}:`, err.message);
      pollCount++;
      if (pollCount < maxPolls) setTimeout(poll, interval * 2);
    }
  };

  poll();
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
  // File-type artifacts carry download metadata
  if (artifactType === "file" && data.fileId) {
    payload.fileId = data.fileId;
    payload.fileSize = data.fileSize || 0;
  }
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
  const allFiles = Array.from(event.clipboardData?.files || []);
  const itemFiles = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
  // Deduplicate by name+size
  const seen = new Set();
  const files = [...allFiles, ...itemFiles].filter(f => {
    const key = f.name + ":" + f.size;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
  if (!files.length) return;
  event.preventDefault();
  for (const file of files) {
    const name = file.name || (file.type.startsWith("image/") ? `pasted-image-${Date.now()}.png` : `pasted-file-${Date.now()}`);
    await addFileAttachment(new File([file], name, { type: file.type }));
  }
  saveDocuments();
  render();
}

async function addFileAttachment(file) {
  const lower = file.name.toLowerCase();
  if (isImageFile(file)) {
    try {
      const dataUrl = await imageToDataUrl(file);
      if (dataUrl && !state.attachments.some((item) => item.kind === "image" && item.dataUrl === dataUrl)) {
        const mime = dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg";
        state.attachments.push({ id: crypto.randomUUID(), name: file.name, kind: "image", mime, dataUrl });
      }
    } catch (e) {
      showToast(e.message || "图片上传失败", "error");
    }
    return;
  }
  if (lower.endsWith(".pdf") || lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    if (file.size > 32 * 1024 * 1024) { alert("文件不能超过 32MB"); return; }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const kind = lower.endsWith(".pdf") ? "pdf" : "xlsx";
    state.attachments.push({ id: crypto.randomUUID(), name: file.name, kind, mime: file.type || "application/octet-stream", dataUrl });
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
    dataUrl: (file.kind === "pdf" || file.kind === "xlsx") ? "" : (file.dataUrl || ""),
  }));
}

function buildUserApiContent(text, attachments) {
  const parts = [];
  // Build text part: user message + file contents (for context)
  const fileParts = attachments
    .filter((f) => f.kind !== "image" && f.kind !== "pdf" && f.kind !== "xlsx" && f.content)
    .map((f) => `[附件：${f.name}]\n${f.content}`);
  const textContent = [text, ...fileParts].filter(Boolean).join("\n\n").trim();
  if (textContent) parts.push({ type: "text", text: textContent });
  for (const file of attachments) {
    if (file.kind === "image") parts.push({ type: "image_url", image_url: { url: file.dataUrl } });
    if (file.kind === "pdf") parts.push({ type: "pdf_url", pdf_url: { url: file.dataUrl, name: file.name } });
    if (file.kind === "xlsx") parts.push({ type: "file_url", file_url: { url: file.dataUrl, name: file.name } });
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
  if (file.size > 20 * 1024 * 1024) throw new Error("图片不能超过 20MB");
  // Read file as data URL first
  const raw = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
  // Try to compress via canvas (handles HEIC, large photos, etc.)
  try {
    return await compressImage(raw, file.type);
  } catch {
    // If canvas fails (e.g. unsupported format), return raw if small enough
    if (raw.length < 5_000_000) return raw;
    throw new Error("图片格式不支持或太大，请转为 JPG/PNG 后重试");
  }
}

// Compress image via canvas: resize to max 2048px, output as JPEG
async function compressImage(dataUrl, mimeType) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 2048;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const scale = MAX / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        // Use original format if PNG/WebP and small, otherwise JPEG
        const isPng = mimeType === "image/png";
        const isSmall = img.width <= MAX && img.height <= MAX;
        const outType = (isPng && isSmall) ? "image/png" : "image/jpeg";
        const quality = outType === "image/jpeg" ? 0.85 : undefined;
        const result = canvas.toDataURL(outType, quality);
        if (!result || result === "data:,") {
          reject(new Error("Canvas export failed"));
          return;
        }
        resolve(result);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("图片加载失败，格式可能不支持"));
    img.src = dataUrl;
  });
}

function isImageFile(file) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|heif|bmp|tiff?)$/i.test(file.name);
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

function shareCurrentDoc() {
  const doc = activeDocument();
  if (!doc) return;
  const btn = els.shareDoc;
  const orig = btn.textContent;
  btn.textContent = "生成链接...";
  btn.disabled = true;

  const title = doc.title || "文档";
  const isHtml = doc.type === "html";
  const html = isHtml ? doc.content : documentHtml(doc);

  // Step 1: create a share link on server
  fetch("/api/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, html }),
  })
  .then(r => r.json())
  .then(data => {
    if (!data.url) throw new Error(data.error || "创建链接失败");
    // Step 2: share the URL (synchronous from .then — user gesture may be lost)
    // So we try share, but also show a copyable link as fallback
    const shareUrl = data.url;
    if (navigator.share) {
      return navigator.share({ title, url: shareUrl }).then(() => {
        btn.textContent = "已分享";
      }).catch(e => {
        if (e.name === "AbortError") return;
        // Share failed — show copy dialog
        showShareLink(shareUrl, title);
        btn.textContent = "链接已生成";
      });
    } else {
      showShareLink(shareUrl, title);
      btn.textContent = "链接已生成";
    }
  })
  .catch(e => {
    console.log("[Share] Error:", e.message);
    btn.textContent = "分享失败";
  })
  .finally(() => {
    btn.disabled = false;
    setTimeout(() => (btn.textContent = orig), 2000);
  });
}

// Show a modal with the share link for manual copy
function showShareLink(url, title) {
  const existing = document.querySelector(".share-modal-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "share-modal-overlay";
  overlay.innerHTML = `
    <div class="share-modal">
      <h3>分享「${escapeHtml(title)}」</h3>
      <p style="font-size:13px;color:var(--muted)">链接有效期 24 小时，打开即可查看排版文档</p>
      <input type="text" class="share-link-input" value="${escapeHtml(url)}" readonly>
      <div class="share-modal-actions">
        <button class="share-copy-btn">复制链接</button>
        <button class="share-close-btn">关闭</button>
      </div>
    </div>
  `;
  document.body.append(overlay);

  const input = overlay.querySelector(".share-link-input");
  overlay.querySelector(".share-copy-btn").addEventListener("click", () => {
    input.select();
    navigator.clipboard.writeText(url).then(() => {
      overlay.querySelector(".share-copy-btn").textContent = "已复制";
    });
  });
  overlay.querySelector(".share-close-btn").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  input.addEventListener("click", () => input.select());
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
  try {
    // Save to localStorage as cache (strip large content for quota safety)
    const toCache = state.threads.slice(0, 50).map(t => ({
      ...t,
      messages: (t.messages || []).slice(-30), // keep last 30 messages in cache
    }));
    localStorage.setItem(THREADS_KEY, JSON.stringify(toCache));
  } catch (e) {
    console.warn("saveThreads cache failed (quota?):", e.message);
  }
}

// Sync a message to server after it's appended
function syncMessages(threadId, messages) {
  fetch("/api/threads/" + threadId + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(messages),
  }).catch(e => console.warn("[Sync] message sync failed:", e.message));
}

// Sync a document to server
function syncDocument(threadId, doc) {
  fetch("/api/threads/" + threadId + "/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc),
  }).catch(e => console.warn("[Sync] document sync failed:", e.message));
}

// Sync thread metadata (title, archived)
function syncThreadMeta(threadId, updates) {
  fetch("/api/threads/" + threadId, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updates),
  }).catch(e => console.warn("[Sync] thread meta sync failed:", e.message));
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
  let inOList = false;
  let inCode = false;
  let codeLang = "";
  let code = [];

  const closeList = () => {
    if (inList) { out.push("</ul>"); inList = false; }
    if (inOList) { out.push("</ol>"); inOList = false; }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (inCode) {
        const lang = codeLang;
        const rawCode = code.join("\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
        const codeContent = `<pre><code${lang ? ` class="language-${lang}"` : ""}>${highlightCode(rawCode, lang)}</code></pre>`;
        const toolbar = `<div class="code-block-toolbar"><span class="code-block-lang">${lang}</span><button type="button" class="code-block-copy" onclick="copyCodeBlock(this)">复制</button></div>`;
        out.push(`<div class="code-block-wrapper">${toolbar}${codeContent}</div>`);
        code = [];
        codeLang = "";
        inCode = false;
      } else {
        closeList();
        codeLang = line.slice(3).trim();
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
      if (inOList) { out.push("</ol>"); inOList = false; }
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
    } else if (/^\d+\.\s+/.test(line)) {
      if (inList) { out.push("</ul>"); inList = false; }
      if (!inOList) { out.push("<ol>"); inOList = true; }
      out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ""))}</li>`);
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
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
    .replace(/(?<![A-Za-z\d])_([^_\n]+?)_(?![A-Za-z\d])/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function copyCodeBlock(btn) {
  const code = btn.closest(".code-block-wrapper").querySelector("code").textContent;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "已复制";
    setTimeout(() => { btn.textContent = "复制"; }, 1000);
  }).catch(() => {});
}

// ─── Syntax Highlighting ────────────────────────────────────────────────────

const _HL_LANG_ALIAS = { javascript: "js", typescript: "ts", python: "py", bash: "sh", zsh: "sh", shell: "sh", markdown: "md" };

function highlightCode(raw, lang) {
  const L = _HL_LANG_ALIAS[lang] || lang || "";
  const rules = _getHighlightRules(L);
  if (!rules) return escapeHtml(raw);
  // Convert inner capturing groups to non-capturing so group indices align with rules array
  const src = rules.map(([, r]) => `(${r.source.replace(/\((?!\?)/g, "(?:")})`).join("|");
  const re = new RegExp(src, "gs");
  let out = "", last = 0;
  for (const m of raw.matchAll(re)) {
    if (m.index > last) out += escapeHtml(raw.slice(last, m.index));
    const idx = m.slice(1).findIndex((g) => g !== undefined);
    out += `<span class="tok-${rules[idx][0]}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  if (last < raw.length) out += escapeHtml(raw.slice(last));
  return out;
}

function _getHighlightRules(L) {
  const JS_KW = /\b(async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|false|finally|for|from|function|get|if|import|in|instanceof|let|new|null|of|return|set|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|with|yield)\b/;
  const TS_KW = /\b(any|as|boolean|declare|enum|implements|interface|keyof|namespace|never|number|object|private|protected|public|readonly|satisfies|string|symbol|type|unknown)\b/;
  const PY_KW = /\b(and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b/;
  const SH_KW = /\b(break|case|continue|do|done|echo|elif|else|esac|exit|export|fi|for|function|if|in|local|readonly|return|set|shift|source|then|trap|true|false|unset|while)\b/;
  const SQL_KW = /\b(ADD|ALL|ALTER|AND|AS|ASC|BETWEEN|BY|CASE|COLUMN|CREATE|DELETE|DESC|DISTINCT|DROP|ELSE|END|EXISTS|FALSE|FROM|GROUP|HAVING|IN|INDEX|INNER|INSERT|INTO|IS|JOIN|KEY|LEFT|LIKE|LIMIT|NOT|NULL|OFFSET|ON|OR|ORDER|OUTER|PRIMARY|REFERENCES|RIGHT|SELECT|SET|TABLE|THEN|TRUE|UNION|UNIQUE|UPDATE|VALUES|VIEW|WHEN|WHERE|WITH|add|all|alter|and|as|asc|between|by|case|column|create|delete|desc|distinct|drop|else|end|exists|false|from|group|having|in|index|inner|insert|into|is|join|key|left|like|limit|not|null|offset|on|or|order|outer|primary|references|right|select|set|table|then|true|union|unique|update|values|view|when|where|with)\b/;
  if (["js", "jsx"].includes(L)) return [
    ["cmt", /\/\/[^\n]*/],
    ["cmt", /\/\*[\s\S]*?\*\//],
    ["str", /`(?:[^`\\]|\\.)*`/],
    ["str", /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/],
    ["num", /\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
    ["kw",  JS_KW],
    ["fn",  /\b([A-Za-z_$][\w$]*)(?=\s*\()/],
  ];
  if (["ts", "tsx"].includes(L)) return [
    ["cmt", /\/\/[^\n]*/],
    ["cmt", /\/\*[\s\S]*?\*\//],
    ["str", /`(?:[^`\\]|\\.)*`/],
    ["str", /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/],
    ["num", /\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
    ["kw",  TS_KW],
    ["kw",  JS_KW],
    ["fn",  /\b([A-Za-z_$][\w$]*)(?=\s*\()/],
  ];
  if (L === "json") return [
    ["key", /"(?:[^"\\]|\\.)*"(?=\s*:)/],
    ["str", /"(?:[^"\\]|\\.)*"/],
    ["kw",  /\b(true|false|null)\b/],
    ["num", /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/],
  ];
  if (L === "html") return [
    ["cmt", /<!--[\s\S]*?-->/],
    ["kw",  /<\/?[A-Za-z][A-Za-z0-9-]*/],
    ["attr", /\b[A-Za-z][A-Za-z0-9-:]*(?=\s*=)/],
    ["str", /"[^"]*"|'[^']*'/],
    ["punct", /[<>/?]/],
  ];
  if (L === "css") return [
    ["cmt", /\/\*[\s\S]*?\*\//],
    ["str", /"[^"]*"|'[^']*'/],
    ["num", /#[\da-fA-F]{3,8}\b/],
    ["num", /(?<!\w)-?\.?\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|%|s|ms|deg|fr|pt|ch|ex|cm|mm|in)\b/],
    ["fn",  /\b[A-Za-z-]+(?=\s*\()/],
    ["attr", /--[A-Za-z][\w-]*/],
    ["sel", /[.#][A-Za-z_-][\w-]*/],
    ["kw",  /\b(auto|block|bold|flex|grid|inherit|initial|inline|italic|none|normal|relative|absolute|fixed|sticky|transparent|unset)\b/],
  ];
  if (L === "py") return [
    ["cmt", /#[^\n]*/],
    ["str", /"""[\s\S]*?"""|'''[\s\S]*?'''/],
    ["str", /f?"(?:[^"\\\n]|\\.)*"|f?'(?:[^'\\\n]|\\.)*'/],
    ["num", /\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
    ["kw",  PY_KW],
    ["fn",  /\b([A-Za-z_][\w]*)(?=\s*\()/],
  ];
  if (L === "sh") return [
    ["cmt", /#[^\n]*/],
    ["str", /"(?:[^"\\\n]|\\.)*"|'[^']*'/],
    ["num", /\b\d+\b/],
    ["kw",  SH_KW],
  ];
  if (L === "sql") return [
    ["cmt", /--[^\n]*|\/\*[\s\S]*?\*\//],
    ["str", /'(?:[^'\\]|\\.)*'/],
    ["num", /\b\d+(?:\.\d+)?\b/],
    ["kw",  SQL_KW],
    ["fn",  /\b[A-Za-z_]\w*(?=\s*\()/],
  ];
  return null;
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

// ---------------------------------------------------------------------------
// Export current document as DOCX
// ---------------------------------------------------------------------------
async function exportCurrentDocAsDocx() {
  const doc = activeDocument();
  if (!doc) return;
  const btn = els.downloadDoc;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "生成中...";
  try {
    const content = doc.type === "html" ? htmlToText(doc.content) : doc.content;
    const response = await fetch("/api/export-docx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: doc.title, content }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || "导出失败");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safeFilename(doc.title) + ".docx";
    a.click();
    URL.revokeObjectURL(url);
    btn.textContent = "已下载";
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1200);
  } catch (err) {
    alert("DOCX 导出失败: " + err.message);
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

function stripImagePlaceholders(text) {
  return String(text || "")
    .replace(/^\s*\[图片[:：][^\]]+\]\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n");
}
