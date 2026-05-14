/**
 * SQLite storage layer for Claude AI Harness
 * Uses better-sqlite3 (synchronous, fast, single-file)
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "data.db");

function nowSGT() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
}

const db = new Database(dbPath, { /* verbose: console.log */ });

// Performance settings
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now', '+8 hours'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT DEFAULT '新对话',
    archived INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, seq);

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    title TEXT DEFAULT '未命名',
    type TEXT DEFAULT 'document',
    content TEXT DEFAULT '',
    language TEXT DEFAULT '',
    description TEXT DEFAULT '',
    versions TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_documents_thread ON documents(thread_id);

  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    model TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', '+8 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id, created_at);

  CREATE TABLE IF NOT EXISTS pv (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT,
    referrer TEXT DEFAULT '',
    screen TEXT DEFAULT '',
    fp TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', '+8 hours'))
  );

  CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    thread_id TEXT,
    tool_calls TEXT DEFAULT '[]',
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    latency_ms INTEGER DEFAULT 0,
    message_preview TEXT DEFAULT '',
    model TEXT DEFAULT '',
    rounds INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', '+8 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_telemetry_user ON telemetry(user_id, created_at);

  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    UNIQUE(message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ratings_thread ON ratings(thread_id);
`);

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

// Users
const stmts = {
  // Users
  getUserByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  getUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
  insertUser: db.prepare("INSERT INTO users (id, email, password_hash, salt, role) VALUES (?, ?, ?, ?, ?)"),
  listUsers: db.prepare("SELECT id, email, role, created_at FROM users"),
  deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
  updateUserPassword: db.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?"),
  updateUserRole: db.prepare("UPDATE users SET role = ? WHERE id = ?"),

  // Sessions
  getSession: db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > ?"),
  insertSession: db.prepare("INSERT INTO sessions (token, user_id, email, role, expires_at) VALUES (?, ?, ?, ?, ?)"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  cleanExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),

  // Threads
  listThreads: db.prepare("SELECT id, title, archived, created_at, updated_at FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100"),
  listAllThreads: db.prepare(`SELECT t.id, t.user_id, u.email, t.title, t.created_at, t.updated_at,
    (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) as msg_count
    FROM threads t LEFT JOIN users u ON t.user_id = u.id ORDER BY t.updated_at DESC`),
  getThread: db.prepare("SELECT * FROM threads WHERE id = ? AND user_id = ?"),
  getThreadById: db.prepare("SELECT * FROM threads WHERE id = ?"),
  insertThread: db.prepare("INSERT INTO threads (id, user_id, title, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"),
  updateThread: db.prepare("UPDATE threads SET title = ?, archived = ?, updated_at = datetime('now', '+8 hours') WHERE id = ? AND user_id = ?"),
  deleteThread: db.prepare("DELETE FROM threads WHERE id = ? AND user_id = ?"),

  // Messages
  listMessages: db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq ASC"),
  insertMessage: db.prepare("INSERT OR IGNORE INTO messages (id, thread_id, role, content, tool_calls, seq) VALUES (?, ?, ?, ?, ?, ?)"),
  deleteMessagesByThread: db.prepare("DELETE FROM messages WHERE thread_id = ?"),
  getMaxSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) as max_seq FROM messages WHERE thread_id = ?"),
  deleteLastMessage: db.prepare("DELETE FROM messages WHERE thread_id = ? AND seq = (SELECT MAX(seq) FROM messages WHERE thread_id = ?)"),

  // Documents
  listDocuments: db.prepare("SELECT * FROM documents WHERE thread_id = ?"),
  getDocument: db.prepare("SELECT * FROM documents WHERE id = ?"),
  findDocByTitle: db.prepare("SELECT * FROM documents WHERE thread_id = ? AND title = ? LIMIT 1"),
  upsertDocument: db.prepare(`INSERT INTO documents (id, thread_id, title, type, content, language, description, versions, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, type=excluded.type, content=excluded.content,
    language=excluded.language, description=excluded.description, versions=excluded.versions, updated_at=datetime('now', '+8 hours')`),
  deleteDocument: db.prepare("DELETE FROM documents WHERE id = ?"),

  // Usage
  recordUsage: db.prepare("INSERT INTO usage (user_id, input_tokens, output_tokens, model, created_at) VALUES (?, ?, ?, ?, datetime('now', '+8 hours'))"),
  userUsageToday: db.prepare("SELECT COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens, COUNT(*) as requests FROM usage WHERE user_id = ? AND created_at >= date('now', '+8 hours')"),
  userUsageAll: db.prepare("SELECT COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens, COUNT(*) as requests FROM usage WHERE user_id = ?"),
  allUsageSummary: db.prepare(`SELECT u.user_id, us.email, COALESCE(SUM(u.input_tokens),0) as input_tokens, COALESCE(SUM(u.output_tokens),0) as output_tokens, COUNT(*) as requests, MAX(u.created_at) as last_active
    FROM usage u LEFT JOIN users us ON u.user_id = us.id GROUP BY u.user_id ORDER BY input_tokens + output_tokens DESC`),
  userUsageDaily: db.prepare(`SELECT date(created_at) as day, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens, COUNT(*) as requests
    FROM usage WHERE user_id = ? GROUP BY date(created_at) ORDER BY day DESC LIMIT 30`),

  // PV
  insertPv: db.prepare("INSERT INTO pv (path, referrer, screen, fp) VALUES (?, ?, ?, ?)"),

  // Telemetry
  insertTelemetry: db.prepare("INSERT INTO telemetry (user_id, thread_id, tool_calls, input_tokens, output_tokens, latency_ms, message_preview, model, rounds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  allTelemetry: db.prepare("SELECT t.*, u.email FROM telemetry t LEFT JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC"),
  telemetryStats: db.prepare(`SELECT COUNT(*) as total_chats,
    SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
    AVG(latency_ms) as avg_latency_ms,
    SUM(json_array_length(tool_calls)) as total_tool_calls
    FROM telemetry`),

  // Ratings
  upsertRating: db.prepare(`INSERT INTO ratings (message_id, thread_id, user_id, rating) VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, user_id) DO UPDATE SET rating = excluded.rating`),
  getRating: db.prepare("SELECT rating FROM ratings WHERE message_id = ? AND user_id = ?"),
  getThreadRatings: db.prepare("SELECT message_id, rating FROM ratings WHERE thread_id = ?"),
  allRatings: db.prepare(`SELECT r.*, u.email, m.content as message_content, m.thread_id
    FROM ratings r LEFT JOIN users u ON r.user_id = u.id LEFT JOIN messages m ON r.message_id = m.id
    ORDER BY r.created_at DESC`),
  ratingStats: db.prepare(`SELECT
    COUNT(*) as total,
    SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as thumbs_up,
    SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) as thumbs_down
    FROM ratings`),
};

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------
export const dbUsers = {
  getByEmail(email) { return stmts.getUserByEmail.get(email); },
  getById(id) { return stmts.getUserById.get(id); },
  create(id, email, hash, salt, role = "user") { stmts.insertUser.run(id, email, hash, salt, role); },
  list() { return stmts.listUsers.all(); },
  delete(id) { stmts.deleteUser.run(id); },
  updatePassword(id, hash, salt) { stmts.updateUserPassword.run(hash, salt, id); },
  updateRole(id, role) { stmts.updateUserRole.run(role, id); },
};

export const dbSessions = {
  get(token) { return stmts.getSession.get(token, Date.now()); },
  create(token, userId, email, role, expiresAt) { stmts.insertSession.run(token, userId, email, role, expiresAt); },
  delete(token) { stmts.deleteSession.run(token); },
  cleanup() { stmts.cleanExpiredSessions.run(Date.now()); },
};

export const dbThreads = {
  list(userId) { return stmts.listThreads.all(userId); },
  listAll() { return stmts.listAllThreads.all(); },
  get(id, userId) { return stmts.getThread.get(id, userId); },
  getById(id) { return stmts.getThreadById.get(id); },
  create(id, userId, title = "新对话", archived = 0, createdAt = null, updatedAt = null) {
    const now = createdAt || nowSGT();
    stmts.insertThread.run(id, userId, title, archived ? 1 : 0, now, updatedAt || now);
  },
  update(id, userId, title, archived) { stmts.updateThread.run(title, archived ? 1 : 0, id, userId); },
  delete(id, userId) { stmts.deleteThread.run(id, userId); },
};

export const dbMessages = {
  list(threadId) {
    return stmts.listMessages.all(threadId).map(row => ({
      ...row,
      content: JSON.parse(row.content),
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    }));
  },
  append(threadId, msg) {
    const seq = (stmts.getMaxSeq.get(threadId)?.max_seq || 0) + 1;
    stmts.insertMessage.run(
      msg.id || crypto.randomUUID(),
      threadId,
      msg.role,
      JSON.stringify(msg.content),
      msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
      seq
    );
  },
  appendBatch: db.transaction((threadId, messages) => {
    let seq = stmts.getMaxSeq.get(threadId)?.max_seq || 0;
    for (const msg of messages) {
      seq++;
      stmts.insertMessage.run(
        msg.id || crypto.randomUUID(),
        threadId,
        msg.role,
        JSON.stringify(msg.content),
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        seq
      );
    }
  }),
  clearThread(threadId) { stmts.deleteMessagesByThread.run(threadId); },
  deleteLast(threadId) { stmts.deleteLastMessage.run(threadId, threadId); },
};

export const dbDocuments = {
  list(threadId) {
    return stmts.listDocuments.all(threadId).map(row => ({
      ...row,
      versions: JSON.parse(row.versions || "[]"),
    }));
  },
  get(id) {
    const row = stmts.getDocument.get(id);
    if (!row) return null;
    return { ...row, versions: JSON.parse(row.versions || "[]") };
  },
  upsert(threadId, doc) {
    // Check if a document with same title already exists in this thread
    const title = doc.title || "未命名";
    const existing = stmts.findDocByTitle.get(threadId, title);
    const id = existing?.id || doc.id;
    stmts.upsertDocument.run(
      id, threadId, title, doc.type || "document",
      doc.content || "", doc.language || "", doc.description || "",
      JSON.stringify(doc.versions || [])
    );
  },
  delete(id) { stmts.deleteDocument.run(id); },
};

export const dbUsage = {
  record(userId, inputTokens, outputTokens, model) {
    stmts.recordUsage.run(userId, inputTokens, outputTokens, model || "");
  },
  userToday(userId) { return stmts.userUsageToday.get(userId); },
  userAll(userId) { return stmts.userUsageAll.get(userId); },
  userDaily(userId) { return stmts.userUsageDaily.all(userId); },
  allSummary() { return stmts.allUsageSummary.all(); },
};

export const dbPv = {
  record(path, referrer, screen, fp) { stmts.insertPv.run(path, referrer, screen, fp); },
};

export const dbTelemetry = {
  record(userId, threadId, toolCalls, inputTokens, outputTokens, latencyMs, messagePreview, model, rounds) {
    stmts.insertTelemetry.run(userId, threadId, JSON.stringify(toolCalls), inputTokens, outputTokens, latencyMs, messagePreview, model, rounds);
  },
  all() { return stmts.allTelemetry.all().map(r => ({ ...r, tool_calls: JSON.parse(r.tool_calls || '[]') })); },
  stats() { return stmts.telemetryStats.get(); },
};

export const dbRatings = {
  upsert(messageId, threadId, userId, rating) { stmts.upsertRating.run(messageId, threadId, userId, rating); },
  get(messageId, userId) { return stmts.getRating.get(messageId, userId); },
  getThreadRatings(threadId) { return stmts.getThreadRatings.all(threadId); },
  all() { return stmts.allRatings.all(); },
  stats() { return stmts.ratingStats.get(); },
};

// Bulk import (for migration from localStorage)
export const dbBulkImport = db.transaction((userId, threads) => {
  for (const thread of threads) {
    // Insert thread
    const now = thread.updatedAt || thread.createdAt || nowSGT();
    stmts.insertThread.run(thread.id, userId, thread.title || "新对话", thread.archived ? 1 : 0, thread.createdAt || now, now);

    // Insert messages
    let seq = 0;
    for (const msg of (thread.messages || [])) {
      seq++;
      stmts.insertMessage.run(
        msg.id || crypto.randomUUID(),
        thread.id,
        msg.role,
        JSON.stringify(msg.content),
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        seq
      );
    }

    // Insert documents
    for (const doc of (thread.documents || [])) {
      stmts.upsertDocument.run(
        doc.id, thread.id, doc.title || "未命名", doc.type || "document",
        doc.content || "", doc.language || "", doc.description || "",
        JSON.stringify(doc.versions || [])
      );
    }
  }
});

// Cleanup expired sessions every hour
setInterval(() => dbSessions.cleanup(), 3600_000);

export default db;
