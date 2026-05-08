/**
 * SQLite storage layer for Lite Claude UI
 * Uses better-sqlite3 (synchronous, fast, single-file)
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "data.db");

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
    created_at TEXT DEFAULT (datetime('now'))
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    created_at TEXT DEFAULT (datetime('now')),
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
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_documents_thread ON documents(thread_id);
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

  // Sessions
  getSession: db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > ?"),
  insertSession: db.prepare("INSERT INTO sessions (token, user_id, email, role, expires_at) VALUES (?, ?, ?, ?, ?)"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  cleanExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),

  // Threads
  listThreads: db.prepare("SELECT id, title, archived, created_at, updated_at FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100"),
  getThread: db.prepare("SELECT * FROM threads WHERE id = ? AND user_id = ?"),
  insertThread: db.prepare("INSERT INTO threads (id, user_id, title, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"),
  updateThread: db.prepare("UPDATE threads SET title = ?, archived = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"),
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
  upsertDocument: db.prepare(`INSERT INTO documents (id, thread_id, title, type, content, language, description, versions, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, type=excluded.type, content=excluded.content,
    language=excluded.language, description=excluded.description, versions=excluded.versions, updated_at=datetime('now')`),
  deleteDocument: db.prepare("DELETE FROM documents WHERE id = ?"),
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
};

export const dbSessions = {
  get(token) { return stmts.getSession.get(token, Date.now()); },
  create(token, userId, email, role, expiresAt) { stmts.insertSession.run(token, userId, email, role, expiresAt); },
  delete(token) { stmts.deleteSession.run(token); },
  cleanup() { stmts.cleanExpiredSessions.run(Date.now()); },
};

export const dbThreads = {
  list(userId) { return stmts.listThreads.all(userId); },
  get(id, userId) { return stmts.getThread.get(id, userId); },
  create(id, userId, title = "新对话", archived = 0, createdAt = null, updatedAt = null) {
    const now = createdAt || new Date().toISOString();
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
    stmts.upsertDocument.run(
      doc.id, threadId, doc.title || "未命名", doc.type || "document",
      doc.content || "", doc.language || "", doc.description || "",
      JSON.stringify(doc.versions || [])
    );
  },
  delete(id) { stmts.deleteDocument.run(id); },
};

// Bulk import (for migration from localStorage)
export const dbBulkImport = db.transaction((userId, threads) => {
  for (const thread of threads) {
    // Insert thread
    const now = thread.updatedAt || thread.createdAt || new Date().toISOString();
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
