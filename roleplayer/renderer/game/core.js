"use strict";
/* Galactic Dominion: what every screen of the game shares. The game server's address, the requests to it, the seats this
   PC holds, and small helpers for building the screens. Everything shown is drawn from server state. */
(function () {
  const GD = window.GD = {};

  /* ---------- the game server: its address is kept here and nowhere else ---------- */
  GD.DEFAULT_PORT = 47800;
  GD.base = "";                 // e.g. http://127.0.0.1:47800 for the host, http://192.168.1.20:47800 for a joining player
  GD.hosting = false;           // this PC runs the game server (Player One)
  GD.setServer = (host, port) => {
    const h = String(host || "127.0.0.1").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    GD.base = "http://" + (h.includes(":") && !h.startsWith("[") ? "[" + h + "]" : h) + ":" + (parseInt(port, 10) || GD.DEFAULT_PORT);
    try { localStorage.setItem("gd:last-server", JSON.stringify({ host: h, port: parseInt(port, 10) || GD.DEFAULT_PORT })); } catch {}
  };
  GD.lastServer = () => { try { return JSON.parse(localStorage.getItem("gd:last-server")) || null; } catch { return null; } };
  GD.token = "";                // the game's token
  GD.ticket = "";               // proof the join code was entered, from /unlock

  /* ---------- seats held on this PC: captain tokens per server and game ---------- */
  GD.store = { captains: [], active: 0, device: "" };
  const key = () => "gd:" + GD.base + "|" + GD.token;
  GD.loadStore = () => {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(key())); } catch {}
    GD.store = s && typeof s === "object" ? s : { captains: [], active: 0, device: "" };
    if (!GD.store.captains) GD.store.captains = [];
    if (!GD.store.device) GD.store.device = GD.device();
  };
  GD.saveStore = () => { try { localStorage.setItem(key(), JSON.stringify(GD.store)); } catch {} };
  /* One id for this PC, so captains sharing its screen stay connected together (hot-seat). */
  GD.device = () => {
    let d = "";
    try { d = localStorage.getItem("gd:device") || ""; } catch {}
    if (!d) { d = Math.random().toString(36).slice(2) + Date.now().toString(36); try { localStorage.setItem("gd:device", d); } catch {} }
    return d;
  };
  GD.me = () => GD.store.captains.find(c => c.id === GD.store.active) || GD.store.captains[0] || null;
  /* Every game this PC holds a seat in, so a campaign can be reopened, running or finished, without its address. */
  GD.seatsHere = () => {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith("gd:http")) continue;
        const at = k.indexOf("|"), s = JSON.parse(localStorage.getItem(k));
        if (at > 0 && s && s.captains && s.captains.length) out.push({ base: k.slice(3, at), token: k.slice(at + 1), seat: s.captains[0] });
      }
    } catch {}
    return out;
  };

  /* ---------- requests ---------- */
  GD.headers = extra => {
    const h = { "Content-Type": "application/json" }, m = GD.me();
    if (m) h["X-GD-Captain"] = m.token;
    if (GD.ticket) h["X-GD-Ticket"] = GD.ticket;
    return Object.assign(h, extra || {});
  };
  GD.fail = (j, status) => {
    const e = new Error((j && j.message) || "Something went wrong. Try again.");
    e.code = j && j.code; e.status = status; e.data = (j && j.data) || {};
    return e;
  };
  /* A JSON request. GET bodies become the query string. Errors carry the server's code, status and data. */
  GD.api = (method, path, body, extra) => {
    let url = GD.base + path;
    const opt = { method, headers: GD.headers(extra) };
    if (body && method !== "GET") opt.body = JSON.stringify(body);
    else if (body) url += (url.includes("?") ? "&" : "?") + Object.keys(body).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(body[k])).join("&");
    return fetch(url, opt).then(r => r.json().catch(() => ({})).then(j => { if (!r.ok) throw GD.fail(j, r.status); return j; }),
      () => { throw GD.fail({ message: "The game server could not be reached. Check the address and that the host's game is running." }, 0); });
  };
  GD.game = path => "/game/" + GD.token + (path || "");

  /* ---------- helpers ---------- */
  GD.esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  GD.$ = (sel, el) => (el || document).querySelector(sel);
  GD.$$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  GD.cap = s => String(s || "").replace(/_/g, " ");
  GD.app = () => document.getElementById("gd-app");
  GD.show = html => { GD.app().innerHTML = html; window.scrollTo(0, 0); };
  /* The title block of the small screens, as on the setup mockup. */
  GD.top = (sub) => `<header class="gd-top"><div class="brand">GALACTIC DOMINION</div><div class="lbl">${GD.esc(sub)}</div></header>`;
  GD.panel = (ix, title, body, opts) => {
    opts = opts || {};
    return `<section class="hud${opts.cls ? " " + opts.cls : ""}"${opts.id ? ` id="${opts.id}"` : ""}><h2 class="hud-h"><span class="ix">${GD.esc(ix)}</span>${GD.esc(title)}${opts.tail != null ? `<span class="tail"${opts.tailId ? ` id="${opts.tailId}"` : ""}>${GD.esc(opts.tail)}</span>` : ""}</h2>${body}</section>`;
  };
  GD.error = (e, el) => { const n = typeof el === "string" ? GD.$(el) : el; if (n) { n.textContent = e.message; n.hidden = false; } };
  GD.toast = text => {
    let t = GD.$("#gd-toast");
    if (!t) { t = document.createElement("div"); t.id = "gd-toast"; t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = text; t.hidden = false;
    clearTimeout(GD.toast.timer); GD.toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
  };
  GD.logo = size => `<svg width="${size}" height="${size}" viewBox="0 0 44 44" aria-hidden="true"><defs><filter id="lg${size}"><feGaussianBlur stdDeviation="1.6"></feGaussianBlur></filter></defs><polygon points="22,3 41,22 22,41 3,22" fill="none" stroke="#36E2FF" stroke-width="2" filter="url(#lg${size})"></polygon><polygon points="22,3 41,22 22,41 3,22" fill="none" stroke="#B5F7FF" stroke-width="1"></polygon><polygon points="22,12 32,22 22,32 12,22" fill="#36E2FF"></polygon><circle cx="22" cy="22" r="3" fill="#021018"></circle></svg>`;

  /* The rules the interfaces need (roles, attributes, species, presets, pools, voices), fetched once per server. */
  GD.rules = null;
  GD.loadRules = () => GD.api("GET", "/rules").then(r => {
    r.genders = Array.isArray(r.genders) && r.genders.length ? r.genders : ["Male", "Female"];
    r.voices = Array.isArray(r.voices) ? r.voices : [];
    GD.rules = r; return r;
  });

  /* The screen in use is left: whatever it runs on timers stops. Each screen registers its own stop. */
  GD.stops = [];
  GD.leaveScreen = () => { const s = GD.stops; GD.stops = []; s.forEach(fn => { try { fn(); } catch {} }); };
})();
