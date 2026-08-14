// Persist per-chat session POOLS: botName:openId -> { sessions: [sessionId...], current: index }.
// Legacy string values ({openId: "session-..."}) are migrated to a pool on read.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export class SessionStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.load();
  }

  load() {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        if (parsed && typeof parsed === "object") this.data = parsed;
      }
    } catch (err) {
      console.error("[store] failed to load", this.file, err);
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error("[store] failed to save", this.file, err);
    }
  }

  key(bot, openId) {
    return `${bot}:${openId}`;
  }

  /** Read (and lazily migrate) the pool for one chat. */
  getPool(bot, openId) {
    const k = this.key(bot, openId);
    let v = this.data[k];
    if (v === undefined) {
      // legacy single-bot entry keyed by bare openId -> migrate to pool
      const legacy = this.data[openId];
      if (typeof legacy === "string") {
        this.data[k] = { sessions: [legacy], current: 0 };
        delete this.data[openId];
        this.save();
        return this.data[k];
      }
      return null;
    }
    if (typeof v === "string") {
      // legacy single-session mapping under the namespaced key
      const pool = { sessions: [v], current: 0 };
      this.data[k] = pool;
      this.save();
      return pool;
    }
    return v;
  }

  currentSessionId(bot, openId) {
    const p = this.getPool(bot, openId);
    if (!p || !Array.isArray(p.sessions) || p.sessions.length === 0) return null;
    const i = Number.isInteger(p.current) && p.current >= 0 && p.current < p.sessions.length ? p.current : p.sessions.length - 1;
    return p.sessions[i];
  }

  currentIndex(bot, openId) {
    const p = this.getPool(bot, openId);
    if (!p || !Array.isArray(p.sessions) || p.sessions.length === 0) return -1;
    return Number.isInteger(p.current) && p.current >= 0 && p.current < p.sessions.length ? p.current : p.sessions.length - 1;
  }

  addSession(bot, openId, sessionId) {
    const k = this.key(bot, openId);
    const p = this.getPool(bot, openId) ?? { sessions: [], current: 0 };
    p.sessions.push(sessionId);
    p.current = p.sessions.length - 1;
    this.data[k] = p;
    this.save();
    return p.current;
  }

  switchSession(bot, openId, index) {
    const p = this.getPool(bot, openId);
    if (!p || !Array.isArray(p.sessions) || index < 0 || index >= p.sessions.length) return false;
    p.current = index;
    this.save();
    return true;
  }

  /** Set the current session to any sessionId (adds it to the pool if absent). */
  setCurrent(bot, openId, sessionId) {
    const k = this.key(bot, openId);
    const p = this.getPool(bot, openId) ?? { sessions: [], current: 0 };
    let idx = p.sessions.indexOf(sessionId);
    if (idx === -1) {
      p.sessions.push(sessionId);
      idx = p.sessions.length - 1;
    }
    p.current = idx;
    this.data[k] = p;
    this.save();
    return idx;
  }

  listSessions(bot, openId) {
    return this.getPool(bot, openId)?.sessions ?? [];
  }

  reset(bot, openId) {
    delete this.data[this.key(bot, openId)];
    this.save();
  }
}
