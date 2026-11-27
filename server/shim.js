// Gives the CRM page the same "db", "user" and "assets" services it had on claude.ai,
// backed by the Nanma CRM server instead.
(function () {
  "use strict";
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const toLogin = () => { location.href = "/"; };
  async function api(url, opt) {
    const r = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    if (r.status === 401) { toLogin(); throw Object.assign(new Error("signed_out"), { code: "revoked" }); }
    if (r.status === 403) throw Object.assign(new Error("denied"), { code: "invalid_argument" });
    if (!r.ok) throw Object.assign(new Error("server " + r.status), { code: r.status === 413 ? "quota_exceeded" : "unavailable" });
    return r.json();
  }
  const collOf = p => p.split("/").slice(0, -1).join("/");
  const idOf = p => p.split("/").pop();
  const newId = () => { const a = new Uint8Array(15); crypto.getRandomValues(a); return Array.from(a, b => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62]).join(""); };

  // ---- local copy of the data, kept fresh by live updates ----
  const colls = {};   // coll -> {loaded, docs: Map(id -> data), subs: Set, loading}
  const docs = {};    // path -> {loaded, data, subs: Set}
  function C(c) { return colls[c] || (colls[c] = { loaded: false, docs: new Map(), subs: new Set(), loading: null }); }
  function D(p) { return docs[p] || (docs[p] = { loaded: false, data: null, subs: new Set(), loading: null }); }

  function qsnap(c, q) {
    let arr = Array.from(C(c).docs.entries()).map(([id, d]) => ({ id, d }));
    if (q.order) { const [f, dir] = q.order; arr.sort((a, b) => { const x = a.d[f], y = b.d[f]; const r = x < y ? -1 : x > y ? 1 : 0; return dir === "desc" ? -r : r; }); }
    if (q.lim) arr = arr.slice(0, q.lim);
    const list = arr.map(({ id, d }) => ({ id, exists: true, ref: { id, path: c + "/" + id }, data: () => clone(d) }));
    return { docs: list, size: list.length, empty: !list.length, metadata: { fromCache: false, hasPendingWrites: false }, forEach: f => list.forEach(f) };
  }
  function dsnap(p) {
    const e = D(p), c = colls[collOf(p)];
    const data = c && c.loaded ? (c.docs.has(idOf(p)) ? c.docs.get(idOf(p)) : null) : e.data;
    return { id: idOf(p), exists: data != null, ref: { id: idOf(p), path: p }, metadata: { fromCache: false, hasPendingWrites: false }, data: () => (data == null ? undefined : clone(data)) };
  }
  function fire(set, make) { for (const s of Array.from(set)) { try { s.cb(make(s)); } catch (e) { console.error(e); } } }

  async function loadColl(c) {
    const e = C(c);
    e.loading = e.loading || api("/api/col?c=" + encodeURIComponent(c)).then(rows => {
      e.docs = new Map(rows.map(r => [r.id, r.d])); e.loaded = true; e.loading = null;
      fire(e.subs, s => qsnap(c, s.q));
    }).catch(err => { e.loading = null; for (const x of Array.from(e.subs)) if (x.err) { try { x.err(err); } catch (_) {} } throw err; });
    return e.loading;
  }
  async function loadDoc(p) {
    const e = D(p);
    e.loading = e.loading || api("/api/doc?p=" + encodeURIComponent(p)).then(r => {
      e.data = r.exists ? r.d : null; e.loaded = true; e.loading = null; fire(e.subs, () => dsnap(p));
    }).catch(err => { e.loading = null; throw err; });
    return e.loading;
  }
  function apply(p, data) {   // a record changed (here or on someone else's screen)
    const c = colls[collOf(p)];
    if (c && c.loaded) { if (data == null) c.docs.delete(idOf(p)); else c.docs.set(idOf(p), data); fire(c.subs, s => qsnap(collOf(p), s.q)); }
    const d = docs[p];
    if (d) { d.data = data; d.loaded = true; fire(d.subs, () => dsnap(p)); }
  }

  // ---- live updates ----
  let es = null, wasDown = false;
  function connect() {
    es = new EventSource("/api/events");
    es.onmessage = ev => { try { const m = JSON.parse(ev.data); apply(m.p, m.d); } catch (_) {} };
    es.onopen = () => { if (wasDown) { wasDown = false; for (const c in colls) if (colls[c].subs.size) loadColl(c).catch(() => {}); for (const p in docs) if (docs[p].subs.size) loadDoc(p).catch(() => {}); } };
    es.onerror = () => { wasDown = true; if (es.readyState === 2) { setTimeout(() => fetch("/api/me").then(r => { if (r.status === 401) toLogin(); else connect(); }).catch(() => setTimeout(connect, 5000)), 3000); } };
  }

  function docRef(p) {
    return {
      id: idOf(p), path: p,
      set(data) { const v = clone(data); apply(p, v); return api("/api/doc?p=" + encodeURIComponent(p), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) }).then(() => undefined); },
      delete() { apply(p, null); return api("/api/doc?p=" + encodeURIComponent(p), { method: "DELETE" }).then(() => undefined); },
      async get() { const c = colls[collOf(p)]; if (!(c && c.loaded)) await loadDoc(p); return dsnap(p); },
      onSnapshot(cb, err) {
        const e = D(p), s = { cb, err }; e.subs.add(s);
        const c = colls[collOf(p)];
        if ((c && c.loaded) || e.loaded) setTimeout(() => cb(dsnap(p)), 0);
        else loadDoc(p).catch(x => err && err(x));
        return () => e.subs.delete(s);
      }
    };
  }
  function query(c, q) {
    return {
      orderBy(f, dir) { return query(c, Object.assign({}, q, { order: [f, dir || "asc"] })); },
      limit(n) { return query(c, Object.assign({}, q, { lim: n })); },
      doc(id) { return docRef(c + "/" + (id || newId())); },
      async get() { if (!C(c).loaded) await loadColl(c); return qsnap(c, q); },
      onSnapshot(cb, err) {
        const e = C(c), s = { cb, err, q }; e.subs.add(s);
        if (e.loaded) setTimeout(() => cb(qsnap(c, q)), 0); else loadColl(c).catch(() => {});
        return () => e.subs.delete(s);
      }
    };
  }
  const db = { collection: c => query(c, {}), doc: p => docRef(p) };

  const user = {
    me: () => api("/api/me"),
    profiles: ids => api("/api/profiles?ids=" + encodeURIComponent((ids || []).join(","))),
    search: q => api("/api/search?q=" + encodeURIComponent(q || ""))
  };
  const assets = {
    async upload(file) {
      const r = await api("/api/upload", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-Name": encodeURIComponent(file.name || "file") }, body: file });
      return { id: r.url.split("/").pop(), url: r.url, contentType: r.contentType || file.type };
    }
  };
  connect();
  window.claude = { use: async k => (k === "db" ? db : k === "user" ? user : k === "assets" ? assets : null) };
})();
