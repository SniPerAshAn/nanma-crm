// Nanma CRM server – plain Node.js (v22+), no extra packages.
// Stores every CRM record in one SQLite file and gives the page the same
// data / sign-in / upload services it had on claude.ai.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const DATA = process.env.NANMA_DATA || path.join(ROOT, "data");
const CFG_FILE = path.join(DATA, "config.json");
fs.mkdirSync(path.join(DATA, "files"), { recursive: true });
const cfg = Object.assign({ port: 3100, ownerId: "u_itNRQ_y8RhKbiy1QYdTsHA", tz: "Asia/Kolkata" },
  fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, "utf8")) : {});

const db = new DatabaseSync(path.join(DATA, "crm.db"));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, ver INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS docs_coll ON docs(coll);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid TEXT NOT NULL, exp INTEGER NOT NULL, stay INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS localusers(username TEXT PRIMARY KEY, uid TEXT NOT NULL, hash TEXT NOT NULL, salt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, by TEXT, at INTEGER);`);

// ---------- access rules (same as the claude.ai version) ----------
const RULES = [
  ["", "view", "admin"], ["timelogs", "view", "admin"], ["timelogs/{self}", "view", "interact"],
  ["joins", "view", "admin"], ["joins/{self}", "view", "interact"], ["comments", "view", "interact"],
  ["messages", "view", "interact"], ["chat", "view", "interact"], ["leads", "admin", "admin"],
  ["pcards", "admin", "admin"], ["pcomments", "admin", "admin"], ["pmessages", "admin", "admin"],
  ["pchat", "admin", "admin"], ["esslp", "admin", "admin"], ["pevents", "admin", "admin"], ["activity", "view", "interact"],
  ["pactivity", "admin", "admin"], ["todolists", "view", "interact"], ["todos", "view", "interact"],
  ["docs", "view", "interact"], ["answers", "view", "interact"], ["boosts", "view", "interact"],
  ["logins", "admin", "admin"], ["logins/{self}", "view", "interact"], ["leaves", "view", "admin"],
  ["leaves/{self}", "view", "interact"], ["reqs", "view", "admin"], ["reqs/{self}", "view", "interact"],
  ["billing", "view", "admin"], ["billing/{self}", "view", "interact"], ["reviews", "view", "interact"],
  ["dms", "view", "interact"], ["hrdata", "admin", "admin"], ["private", "admin", "admin"], ["private/{self}", "view", "interact"]
].map(([p, read, write]) => ({ p, read, write, segs: p ? p.split("/") : [] }));
const LV = { view: 1, interact: 2, admin: 3, owner: 4 };
function ruleFor(docPath, uid) {
  const segs = docPath.split("/");
  let best = RULES[0], bestLen = 0, selfHit = false;
  for (const r of RULES) {
    if (r.segs.length > segs.length || r.segs.length < bestLen) continue;
    let ok = true, isSelf = false;
    for (let i = 0; i < r.segs.length; i++) {
      if (r.segs[i] === "{self}") { if (segs[i] !== uid) { ok = false; break; } isSelf = true; }
      else if (r.segs[i] !== segs[i]) { ok = false; break; }
    }
    if (ok && (r.segs.length > bestLen || (isSelf && !selfHit))) { best = r; bestLen = r.segs.length; selfHit = isSelf; }
  }
  return best;
}
function canRead(u, p) {
  if (p.startsWith("data/users/")) return p.split("/")[2] === u.id;
  if (u.level >= LV.owner) return true;
  return u.level >= LV[ruleFor(p, u.id).read];
}
function canWrite(u, p) {
  if (p.startsWith("data/users/")) return p.split("/")[2] === u.id;
  if (u.level >= LV.owner) return true;
  return u.level >= LV[ruleFor(p, u.id).write];
}

// ---------- records ----------
const qGet = db.prepare("SELECT data, ver FROM docs WHERE path=?");
const qColl = db.prepare("SELECT path, id, data, ver FROM docs WHERE coll=?");
const qSet = db.prepare("INSERT INTO docs(path,coll,id,data,ver,at) VALUES(?,?,?,?,1,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, ver=docs.ver+1, at=excluded.at");
const qDel = db.prepare("DELETE FROM docs WHERE path=?");
const collOf = p => { const s = p.split("/"); return s.slice(0, -1).join("/"); };
const idOf = p => p.split("/").pop();
const validPath = p => typeof p === "string" && p.length < 400 && !p.includes("..") && p.split("/").length % 2 === 0 && p.split("/").every(Boolean);
function getDoc(p) { const r = qGet.get(p); return r ? JSON.parse(r.data) : null; }

// ---------- people ----------
function people() {
  const by = {}, out = {};
  for (const j of qColl.all("joins")) { const d = JSON.parse(j.data) || {}; if (!d.code) continue; if (!by[d.code] || (d.at || 0) < by[d.code].at) by[d.code] = { u: j.id, at: d.at || 0 }; }
  for (const code in by) { const inv = getDoc("invites/" + code); if (inv) out[by[code].u] = { name: inv.name || "", role: inv.role || "staff", admin: !!inv.admin, code }; }
  return out;
}
const claimed = code => Object.values(people()).some(p => p.code === code);
const usernameTaken = un => { if (db.prepare("SELECT 1 FROM localusers WHERE username=?").get(un)) return true; return qColl.all("timelogs").some(t => { const l = (JSON.parse(t.data) || {}).lock; return l && String(l.u || "").toLowerCase() === un; }); };
function userInfo(uid) {
  const ps = people(); const p = ps[uid] || {};
  const owner = uid === cfg.ownerId;
  const admin = owner || p.admin || ["head", "manager", "hr"].includes(p.role);
  return { id: uid, name: p.name || (owner ? (cfg.ownerName || "Owner") : ""), isOwner: owner, canEdit: admin, level: owner ? LV.owner : admin ? LV.admin : LV.interact };
}

// ---------- sign-in ----------
const pbkdf2 = (pw, salt) => crypto.pbkdf2Sync(String(pw), String(salt), 150000, 32, "sha256").toString("hex");
function findLogin(username, password) {
  const un = String(username || "").trim().toLowerCase();
  const loc = db.prepare("SELECT uid, hash, salt FROM localusers WHERE username=?").get(un);
  if (loc && crypto.timingSafeEqual(Buffer.from(pbkdf2(password, loc.salt)), Buffer.from(loc.hash))) return loc.uid;
  for (const t of qColl.all("timelogs")) {
    const lock = (JSON.parse(t.data) || {}).lock;
    if (lock && String(lock.u || "").toLowerCase() === un && lock.h && lock.s) {
      const h = pbkdf2(password, lock.s);
      if (h.length === lock.h.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(lock.h))) return t.id;
    }
  }
  return null;
}
const IDLE = 30 * 60 * 1000;
function midnight() { // next 12:00 AM in India time
  const now = new Date(); const ist = new Date(now.getTime() + 5.5 * 3600e3);
  ist.setUTCHours(24, 0, 0, 0); return ist.getTime() - 5.5 * 3600e3;
}
function cookies(req) { const o = {}; (req.headers.cookie || "").split(";").forEach(c => { const i = c.indexOf("="); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); }); return o; }
function session(req) {
  const tok = cookies(req).nanma_sid; if (!tok) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token=?").get(tok);
  if (!s || s.exp < Date.now()) { if (s) db.prepare("DELETE FROM sessions WHERE token=?").run(tok); return null; }
  if (!s.stay) db.prepare("UPDATE sessions SET exp=? WHERE token=?").run(Date.now() + IDLE, tok);
  return Object.assign(userInfo(s.uid), { token: tok });
}
const failed = new Map();

// ---------- live updates (server-sent events) ----------
const clients = new Set();
function broadcast(p, data) {
  const msg = "data: " + JSON.stringify({ p, d: data }) + "\n\n";
  for (const c of clients) { try { if (canRead(c.u, p)) c.res.write(msg); } catch (_) {} }
}
setInterval(() => { for (const c of clients) { try { c.res.write(": ping\n\n"); } catch (_) {} } }, 25000);

// ---------- helpers ----------
function send(res, code, body, type = "application/json") { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); }
function body(req, limit = 2e6) { return new Promise((ok, no) => { const ch = []; let n = 0; req.on("data", d => { n += d.length; if (n > limit) { no(new Error("too_large")); req.destroy(); } else ch.push(d); }); req.on("end", () => ok(Buffer.concat(ch))); req.on("error", no); }); }
const PUB = path.join(ROOT, "server");
function page() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  return html.replace("<script", '<script>window.__NANMA_SERVER=true;</script><script src="/shim.js"></script><script')
    .split(" (open it while signed in to claude.ai)").join("")
    .split("\\n(Sign in to claude.ai with your own account first.)").join("");
}

// ---------- eSSL / ZKTeco attendance machines (ADMS "cloud server" push) ----------
function esslDevices() { return getDoc("esslp/devices") || { list: {} }; }
function esslSaveDevices(d) { d.at = Date.now(); qSet.run("esslp/devices", "esslp", "devices", JSON.stringify(d), Date.now()); broadcast("esslp/devices", d); }
function esslSeen(sn, ip, n) {
  const d = esslDevices(); d.list = d.list || {}; const x = d.list[sn] || (d.list[sn] = { first: Date.now(), n: 0, ok: false });
  x.last = Date.now(); x.ip = ip || x.ip || ""; if (n) { x.n = (x.n || 0) + n; x.lastPunch = Date.now(); }
  // write at most once a minute unless punches arrived
  if (n || !x._w || Date.now() - x._w > 60000) { x._w = Date.now(); esslSaveDevices(d); }
}
function esslUsers(sn, users) { if (!Object.keys(users).length) return; const d = esslDevices(); const x = (d.list = d.list || {})[sn]; if (!x) return; x.users = Object.assign({}, x.users || {}, users); esslSaveDevices(d); }
function esslPunches(sn, lines) {
  const byDay = {}; let n = 0;
  for (const line of lines) {
    const f = line.split("\t"); if (f.length < 2) continue;
    const pin = String(f[0] || "").trim(); const m = String(f[1] || "").trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
    if (!pin || !m || pin.length > 30) continue;
    ((byDay[m[1]] = byDay[m[1]] || {})[sn + "|" + pin] = byDay[m[1]][sn + "|" + pin] || []).push(m[2].length === 5 ? m[2] + ":00" : m[2]);
  }
  for (const [day, add] of Object.entries(byDay)) {
    const path = "esslp/day_" + day; const doc = getDoc(path) || { p: {} }; doc.p = doc.p || {}; let changed = false;
    for (const [k, ts] of Object.entries(add)) { const cur = new Set(doc.p[k] || []); const before = cur.size; ts.forEach(t => cur.add(t)); if (cur.size !== before) { doc.p[k] = [...cur].sort(); changed = true; n += cur.size - before; } }
    if (changed) { doc.at = Date.now(); qSet.run(path, "esslp", "day_" + day, JSON.stringify(doc), Date.now()); broadcast(path, doc); }
  }
  return n;
}
async function esslHandle(req, res, url, P) {
  const sn = String(url.searchParams.get("SN") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  const ip = req.headers["x-real-ip"] || req.socket.remoteAddress;
  const txt = b => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(b); };
  if (!sn) return txt("OK");
  if (P === "/iclock/cdata" && req.method === "GET") {
    esslSeen(sn, ip, 0);
    return txt(["GET OPTION FROM: " + sn, "ATTLOGStamp=None", "OPERLOGStamp=9999", "ATTPHOTOStamp=None", "ErrorDelay=60", "Delay=30", "TransTimes=00:00;14:05", "TransInterval=1", "TransFlag=TransData AttLog\tOpLog\tEnrollUser", "Realtime=1", "Encrypt=None", ""].join("\n"));
  }
  if (P === "/iclock/cdata" && req.method === "POST") {
    const table = String(url.searchParams.get("table") || "").toUpperCase();
    const body = (await body_(req, 8e6)).toString("utf8"); const lines = body.split(/\r?\n/).filter(Boolean);
    if (table === "ATTLOG") { const n = esslPunches(sn, lines); esslSeen(sn, ip, n); return txt("OK: " + lines.length); }
    if (table === "OPERLOG" || table === "USERINFO") { const users = {}; for (const l of lines) { const m = l.match(/(?:^|[\t ])PIN=([^\t]+).*?\tName=([^\t]*)/); if (m && m[2].trim()) users[m[1].trim()] = m[2].trim().slice(0, 60); } esslUsers(sn, users); }
    esslSeen(sn, ip, 0); return txt("OK: " + lines.length);
  }
  esslSeen(sn, ip, 0); return txt("OK");
}
const body_ = (req, limit) => body(req, limit);

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x"); const P = url.pathname;
    if (P === "/healthz") return send(res, 200, { ok: true });
    if (P === "/install") { res.writeHead(302, { Location: "https://github.com/SniPerAshAn/nanma-crm/releases/latest/download/Nanma-CRM-Setup.exe" }); return res.end(); }
    if (P.startsWith("/iclock/")) return esslHandle(req, res, url, P);
    if (P === "/shim.js") return send(res, 200, fs.readFileSync(path.join(PUB, "shim.js")), "text/javascript");
    if (P === "/api/login" && req.method === "POST") {
      const ip = req.headers["x-real-ip"] || req.socket.remoteAddress; let f = failed.get(ip) || { n: 0, t: 0 };
      if (f.n >= 8 && Date.now() - f.t < 60e3) return send(res, 429, { error: "Too many tries – wait 1 minute and try again." });
      if (f.n >= 8) { failed.delete(ip); f = { n: 0, t: 0 }; }
      const b = JSON.parse((await body(req)).toString() || "{}"); const uid = findLogin(b.username, b.password);
      if (!uid) { failed.set(ip, { n: f.n + 1, t: Date.now() }); return send(res, 401, { error: "Wrong username or password." }); }
      failed.delete(ip); const tok = crypto.randomBytes(32).toString("hex"); const stay = !!b.stay;
      db.prepare("INSERT INTO sessions(token,uid,exp,stay) VALUES(?,?,?,?)").run(tok, uid, stay ? midnight() : Date.now() + IDLE, stay ? 1 : 0);
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `nanma_sid=${tok}; Path=/; HttpOnly;${cfg.insecure ? "" : " Secure;"} SameSite=Lax${stay ? "; Expires=" + new Date(midnight()).toUTCString() : ""}` });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (P === "/api/join" && req.method === "POST") {
      const b = JSON.parse((await body(req)).toString() || "{}");
      const code = String(b.code || "").replace(/^.*#join-/, "").trim(), un = String(b.username || "").trim().toLowerCase(), pw = String(b.password || "");
      const inv = code && getDoc("invites/" + code);
      if (!inv) return send(res, 400, { error: "That invite code isn't valid. Ask HR for a new link." });
      if (claimed(code)) return send(res, 400, { error: "This invite has already been used. Ask HR for help." });
      if (!/^[a-z0-9._-]{3,30}$/.test(un)) return send(res, 400, { error: "Username: 3–30 letters, numbers, dots or dashes." });
      if (pw.length < 6) return send(res, 400, { error: "Password needs at least 6 characters." });
      if (usernameTaken(un)) return send(res, 400, { error: "That username is taken – pick another." });
      const uid = "u_" + crypto.randomBytes(16).toString("base64url"), salt = crypto.randomBytes(16).toString("hex"), now = Date.now();
      const j = { code, at: now }, t = { running: null, logs: {}, lock: { u: un, s: salt, h: pbkdf2(pw, salt), at: now, by: uid } };
      qSet.run("joins/" + uid, "joins", uid, JSON.stringify(j), now); broadcast("joins/" + uid, j);
      qSet.run("timelogs/" + uid, "timelogs", uid, JSON.stringify(t), now); broadcast("timelogs/" + uid, t);
      return send(res, 200, { ok: true });
    }
    if (P === "/api/logout") { const tok = cookies(req).nanma_sid; if (tok) db.prepare("DELETE FROM sessions WHERE token=?").run(tok); res.writeHead(200, { "Set-Cookie": "nanma_sid=; Path=/; Max-Age=0" }); return res.end("{}"); }
    const u = session(req);
    if (P === "/" || P === "/index.html") { if (!u) return send(res, 200, fs.readFileSync(path.join(PUB, "login.html")), "text/html; charset=utf-8"); return send(res, 200, page(), "text/html; charset=utf-8"); }
    if (P.startsWith("/files/")) { if (!u) return send(res, 401, "Sign in"); const id = P.slice(7).replace(/[^a-f0-9]/g, ""); const f = db.prepare("SELECT * FROM files WHERE id=?").get(id); if (!f) return send(res, 404, "Not found", "text/plain"); res.writeHead(200, { "Content-Type": f.type || "application/octet-stream", "Cache-Control": "private, max-age=86400" }); return fs.createReadStream(path.join(DATA, "files", id)).pipe(res); }
    if (!P.startsWith("/api/")) return send(res, 404, "Not found", "text/plain");
    if (!u) return send(res, 401, { error: "signed_out" });
    if (P === "/api/me") return send(res, 200, { id: u.id, name: u.name, isOwner: u.isOwner, canEdit: u.canEdit });
    if (P === "/api/profiles") { const ps = people(); const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean); const o = {}; for (const id of ids) { const n = (ps[id] || {}).name || (id === cfg.ownerId ? cfg.ownerName || "" : ""); if (n || ps[id]) o[id] = { id, name: n }; } return send(res, 200, o); }
    if (P === "/api/search") { const q = (url.searchParams.get("q") || "").toLowerCase(); const ps = people(); return send(res, 200, Object.entries(ps).filter(([, p]) => p.name && p.name.toLowerCase().includes(q)).slice(0, 20).map(([id, p]) => ({ id, name: p.name }))); }
    if (P === "/api/col") {
      const c = url.searchParams.get("c") || ""; if (!c || c.split("/").length % 2 !== 1) return send(res, 400, { error: "bad" });
      const rows = qColl.all(c).filter(r => canRead(u, r.path)).map(r => ({ id: r.id, d: JSON.parse(r.data), v: r.ver }));
      return send(res, 200, rows);
    }
    if (P === "/api/doc") {
      const p = url.searchParams.get("p"); if (!validPath(p)) return send(res, 400, { code: "invalid_argument" });
      if (req.method === "GET") { if (!canRead(u, p)) return send(res, 200, { exists: false }); const r = qGet.get(p); return send(res, 200, r ? { exists: true, d: JSON.parse(r.data), v: r.ver } : { exists: false }); }
      if (!canWrite(u, p)) return send(res, 403, { code: "invalid_argument" });
      if (req.method === "PUT") { const raw = (await body(req, 4e6)).toString(); const d = JSON.parse(raw); qSet.run(p, collOf(p), idOf(p), JSON.stringify(d), Date.now()); broadcast(p, d); return send(res, 200, { ok: true }); }
      if (req.method === "DELETE") { qDel.run(p); broadcast(p, null); return send(res, 200, { ok: true }); }
    }
    if (P === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
      res.write(": hi\n\n"); const c = { u, res }; clients.add(c); req.on("close", () => clients.delete(c)); return;
    }
    if (P === "/api/upload" && req.method === "POST") {
      const buf = await body(req, 30 * 1024 * 1024); const id = crypto.randomBytes(16).toString("hex");
      fs.writeFileSync(path.join(DATA, "files", id), buf);
      db.prepare("INSERT INTO files(id,name,type,size,by,at) VALUES(?,?,?,?,?,?)").run(id, decodeURIComponent(req.headers["x-name"] || "file"), req.headers["content-type"] || "", buf.length, u.id, Date.now());
      return send(res, 200, { url: "/files/" + id, contentType: req.headers["content-type"] || "" });
    }
    send(res, 404, { error: "not_found" });
  } catch (e) { console.error(e); try { send(res, 500, { error: "server_error" }); } catch (_) {} }
});

// ---------- command line: node server.js set-password <username> <password> [uid] ----------
if (process.argv[2] === "set-password") {
  const [, , , un, pw, uid] = process.argv;
  if (!un || !pw || String(pw).length < 6) { console.error("Usage: node server.js set-password <username> <password (6+ characters)> [user id]"); process.exit(1); } const salt = crypto.randomBytes(16).toString("hex");
  db.prepare("INSERT INTO localusers(username,uid,hash,salt) VALUES(?,?,?,?) ON CONFLICT(username) DO UPDATE SET uid=excluded.uid, hash=excluded.hash, salt=excluded.salt").run(String(un).toLowerCase(), uid || cfg.ownerId, pbkdf2(pw, salt), salt);
  console.log("Password set for " + un); process.exit(0);
} else {
  server.listen(cfg.port, "127.0.0.1", () => console.log("Nanma CRM on http://127.0.0.1:" + cfg.port));
}
