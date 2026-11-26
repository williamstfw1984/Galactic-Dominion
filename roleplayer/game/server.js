"use strict";
/* The game server, replacing the plugin's class-rest.php, class-live.php, class-codes.php and class-cron.php.

   Plain node:http. Routes and JSON shapes follow class-rest.php and class-view.php, with the changes the desktop app
   needs (docs/PORT.md):
   - No WordPress accounts. Player One is the host's own window: a request from this computer (127.0.0.1 or ::1).
     Every other captain holds the token given when they joined, sent as X-GD-Captain.
   - The host sets the game's 4-digit join code when creating it; the plugin's checks, rate limit and lockout apply
     (5 wrong tries per address, then 10 minutes locked out). A correct code gives a ticket (X-GD-Ticket) for 12 hours.
   - A streamed turn (any request with X-GD-Live) is answered as newline-delimited JSON with class-live.php's message
     shapes, without its Edge speech messages: lines carry a voice id and each player's app speaks them.
   - Live updates to every client go out as server-sent events (GET .../stream); the short-poll state route stays.
   - Heartbeats, disconnects, roll timeouts and turn timers run on a timer here instead of WordPress cron.
   - Saved ships and crews come from library.js in the data folder, and are listed for joining players.
   - The app's safety check runs here, on the host (see turn.js); its private message reaches only the captain
     concerned, on their streamed reply and their event stream.

   createServer({ dataDir, llm, voices, safety, settings, port, host }) -> { listen, close, world }
     llm:      { chat, chatStream } as in main.js (or a ready caller from llm.js)
     voices:   the list main.js voices() gives (or a ready assigner from voices.js)
     safety:   async ({ fromUser, text }) -> true when flagged (main.js checkSafety)
     settings: { model, context, temperature, roll_timeout, turn_timeout, heartbeat_timeout, summary_every,
                 recent_window, token_budget, computer_gender } */
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const Rules = require("./rules.js");
const Library = require("./library.js");
const { createStore } = require("./store.js");
const { createLlm } = require("./llm.js");
const { createVoices } = require("./voices.js");
const Game = require("./game.js");
const Generator = require("./generator.js");
const View = require("./view.js");
const { Turn } = require("./turn.js");
const T = require("./text.js");

const { GdError, isErr, fail, time, gmdate, sha256, randomHex, sanitizeKey, sanitizeTextField, mbSubstr, md5 } = T;

const DEFAULT_PORT = 47800;
const MAX_TRIES = 5;
const LOCKOUT = 600;     // 10 minutes
const TOKEN_TTL = 43200; // 12 hours
const TICK_MS = 5000;    // how often timers are checked: the plugin's cron backstop ran every minute
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-GD-Captain, X-GD-Ticket, X-GD-Live",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

/* ---------- the join code (class-codes.php), one per game ---------- */

const isValidCode = plain => typeof plain === "string" && /^[0-9]{4}$/.test(plain);
function hashCode(plain) {
  const salt = randomHex(16);
  return { salt, hash: crypto.scryptSync(plain, salt, 32).toString("hex"), code: plain };
}
function codeMatches(stored, plain) {
  if (!stored || !isValidCode(plain)) return false;
  const h = crypto.scryptSync(plain, stored.salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(stored.hash, "hex"));
}
const lockedOut = seconds => {
  seconds = Math.max(1, Math.trunc(seconds));
  const minutes = Math.ceil(seconds / 60);
  return fail("gd_code_locked", "Too many wrong tries. Try again in " + minutes + (minutes === 1 ? " minute." : " minutes."), 429, { seconds });
};

function createServer({ dataDir, llm, voices, safety, settings = {}, port = DEFAULT_PORT, host = "0.0.0.0", isOwner = null } = {}) {
  const store = createStore(dataDir);
  const w = {
    store,
    dataDir,
    settings,
    safety,
    llm: llm && typeof llm.call === "function" ? llm : createLlm(Object.assign({}, llm || {}, { settings })),
    voices: voices && typeof voices.assignCrew === "function" ? voices : createVoices(voices || []),
    tell: null
  };

  const tries = new Map();   // bucket -> { tries, until }
  const tickets = new Map(); // sha256(ticket) -> { game, stamp, expires }
  const streams = new Map(); // game id -> Set of { res, cid }
  let listenPort = port;
  let server = null;
  let timer = null;

  /* ---------- helpers ---------- */

  // Player One is the host's own window. isOwner(req) replaces the test, for tests that play every seat from here.
  const isLoopback = typeof isOwner === "function" ? isOwner : req => /^(::ffff:)?127\.\d+\.\d+\.\d+$|^::1$/.test(String(req.socket.remoteAddress || ""));
  const clientIp = req => String(req.socket.remoteAddress || "");
  const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => a.address);

  function checkCode(g, plain, ip) {
    if (!g.join_code) return fail("gd_code_unset", "No join code has been set for this game.", 403);
    const bucket = md5(g.id + "|" + ip);
    const t = tries.get(bucket) || { tries: 0, until: 0 };
    if (t.until > time()) return lockedOut(t.until - time());
    if (codeMatches(g.join_code, String(plain ?? ""))) {
      tries.delete(bucket);
      return true;
    }
    t.tries++;
    if (t.tries >= MAX_TRIES) {
      tries.set(bucket, { tries: 0, until: time() + LOCKOUT });
      return lockedOut(LOCKOUT);
    }
    t.until = 0;
    tries.set(bucket, t);
    const left = MAX_TRIES - t.tries;
    return fail("gd_code_wrong", "That code is not correct. " + left + (left === 1 ? " try" : " tries") + " left.", 403, { attempts_left: left });
  }
  function issueTicket(g) {
    const ticket = randomHex(16);
    tickets.set(sha256(ticket), { game: g.id, stamp: md5(g.join_code.hash), expires: time() + TOKEN_TTL });
    return ticket;
  }
  function ticketOk(g, ticket, anyGame = false) {
    if (typeof ticket !== "string" || !/^[0-9a-f]{32}$/.test(ticket)) return false;
    const t = tickets.get(sha256(ticket));
    if (!t || t.expires < time()) return false;
    if (anyGame) return true;
    return t.game === g.id && !!g.join_code && t.stamp === md5(g.join_code.hash);
  }

  /* Live updates: every stream of a game hears that something changed; a private message goes to one captain's. */
  function broadcast(gameId) {
    for (const s of streams.get(gameId) || []) s.res.write("data: change\n\n");
  }
  w.tell = (gameId, cid, msg) => {
    for (const s of streams.get(gameId) || []) if (s.cid === cid) s.res.write("event: safety\ndata: " + JSON.stringify(msg) + "\n\n");
  };
  // Any write to a game's log or state is a change the clients should hear about.
  const marks = new Map();
  function markOf(gameId) {
    const g = store.getGame(gameId);
    return store.maxEventId(gameId) + ":" + md5(JSON.stringify(g)) + ":" + md5(JSON.stringify([...store.captains(gameId).values()].map(c => [c.state, c.name])));
  }
  function watch() {
    for (const gameId of streams.keys()) {
      const m = markOf(gameId);
      if (marks.get(gameId) !== m) {
        if (marks.has(gameId)) broadcast(gameId);
        marks.set(gameId, m);
      }
    }
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 4 * 1024 * 1024) break;
      chunks.push(c);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return {};
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  function json(res, status, body) {
    res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, CORS));
    res.end(JSON.stringify(body));
  }
  const errBody = e => ({ code: e.code, message: e.message, data: e.data });
  function reply(res, value) {
    if (isErr(value)) return json(res, Rules.intval(value.data.status) || 500, errBody(value));
    return json(res, 200, value);
  }

  /* As a play request, but with X-GD-Live the reply is a stream: what the turn says is sent while it happens, and
     the ordinary reply is its last message. */
  async function live(req, res, cid, fn) {
    if (!String(req.headers["x-gd-live"] || "")) return reply(res, await fn(null));
    res.writeHead(200, Object.assign({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", "X-GD-Live": "1" }, CORS));
    const send = m => {
      if (!res.writableEnded) res.write(JSON.stringify(m) + "\n");
    };
    send({ t: "pad", p: " ".repeat(2048) });
    let out;
    try {
      out = await fn({ cid, send });
    } catch (e) {
      out = fail("gd_error", "Something went wrong on the host: " + String((e && e.message) || e), 500);
    }
    if (isErr(out)) send({ t: "done", status: Rules.intval(out.data.status) || 500, body: errBody(out) });
    else send({ t: "done", status: 200, body: out });
    res.end();
  }

  /* ---------- routes ---------- */

  function rules() {
    return {
      roles: Rules.roles(),
      attributes: Rules.attributes(),
      ship: Rules.shipAttributes(),
      species: Rules.species(),
      genders: Rules.genders(),
      presets: Rules.presets(),
      pools: { crew: Rules.CREW_POOL, ship: Rules.SHIP_POOL, crew_cap: Rules.CREW_ATTR_CAP, ship_min: Rules.SHIP_ATTR_MIN, ship_max: Rules.SHIP_ATTR_MAX },
      max_captains: Rules.MAX_CAPTAINS,
      voices: w.voices.pool(),
      join_ready: true
    };
  }

  function gameRow(g) {
    return {
      token: g.token,
      title: g.story?.title ?? "",
      status: g.status,
      created: gmdate(Rules.intval(g.created)).slice(0, 10),
      ended: g.ended ? gmdate(Rules.intval(g.ended)).slice(0, 10) : "",
      preset: Rules.presets()[g.options.preset].label,
      captains: Game.captains(w, g.id).size,
      turns: Rules.intval(g.turn)
    };
  }

  function captainOf(req, g) {
    const c = Game.captainByToken(w, g.id, String(req.headers["x-gd-captain"] || ""));
    return c || fail("gd_auth", "You are not seated in this game. Open the game to join.", 403);
  }
  const maySeat = (req, g) => isLoopback(req) || ticketOk(g, String(req.headers["x-gd-ticket"] || ""));

  async function creatorRoute(req, res, url, body) {
    // The library of this server: open to the host's window and to anyone who has entered a join code here.
    if (!isLoopback(req) && !ticketOk(null, String(req.headers["x-gd-ticket"] || ""), true)) return json(res, 403, errBody(fail("gd_auth", "Enter the join code first.", 403)));
    const p = url.pathname;
    if (p === "/creator/builds" && req.method === "GET") return json(res, 200, { builds: Library.listBuilds(dataDir) });
    if (p === "/creator/builds" && req.method === "POST") return reply(res, await creatorSave(body));
    let m = /^\/creator\/builds\/(\d+)$/.exec(p);
    if (m && req.method === "GET") {
      const b = Library.getBuild(dataDir, Number(m[1]));
      return reply(res, b || fail("gd_not_found", "That ship and crew could not be found.", 404));
    }
    if (p === "/creator/import" && req.method === "POST") return json(res, 200, creatorImport(body));
    m = /^\/creator\/export\/(\d+)$/.exec(p);
    if (m && req.method === "GET") {
      const b = Library.getBuild(dataDir, Number(m[1]));
      if (!b) return reply(res, fail("gd_not_found", "That ship and crew could not be found.", 404));
      return json(res, 200, { name: b.name, ship_csv: Library.exportShipCsv(b.ship), crew_csv: Library.exportCrewCsv(b.crew) });
    }
    if (p === "/creator/templates" && req.method === "GET") return json(res, 200, { ship_csv: Library.shipTemplateCsv(), crew_csv: Library.crewTemplateCsv() });
    return json(res, 404, errBody(fail("gd_not_found", "No such route.", 404)));
  }

  /* Create or edit a saved ship and crew. Validation is identical to the importer's. */
  async function creatorSave(body) {
    const vs = Library.validateShip(body.ship && typeof body.ship === "object" ? body.ship : {});
    const vc = Library.validateCrew(body.crew && typeof body.crew === "object" ? body.crew : {});
    if (!vs.ok || !vc.ok) return fail("gd_invalid", "Fix the problems shown before saving.", 422, { errors: { ship: vs.errors, crew: vc.errors } });
    // A chosen voice is never silently swapped: it must be one of this computer's voices and unique on the ship (§10).
    const used = {};
    const errs = [];
    for (const [role, o] of Object.entries(vc.crew)) {
      const v = String(o.voice ?? "");
      if (v === "") continue;
      const t = w.voices.timbre(v);
      if (!w.voices.isValid(v)) errs.push({ row: null, column: "voice", role, message: "That voice is not one this computer offers. Choose another." });
      else if (used[t]) errs.push({ row: null, column: "voice", role, message: "Another officer on this ship already has that voice. Choose another." });
      used[t] = true;
    }
    if (errs.length) return fail("gd_invalid", "Fix the problems shown before saving.", 422, { errors: { ship: [], crew: errs } });
    const crew = w.voices.assignCrew(vc.crew); // officers left without a voice get a distinct, gender-matched one
    const ship = (await Game.withFlavour(w, { ship: vs.ship, crew })).ship; // class and registry generated once if blank (§4.1)
    const id = Library.saveBuild(dataDir, ship, crew, Rules.intval(body.id ?? 0));
    if (Library.isError(id)) return fail("gd_" + id.code, id.message, 422, id.data || {});
    return Library.getBuild(dataDir, id);
  }

  /* Parse uploaded CSV text and return what it contains, with errors and the points readout. Nothing is saved. */
  function creatorImport(body) {
    const out = {};
    for (const half of ["ship", "crew"]) {
      let text = String(body[half + "_csv"] ?? "");
      if (String(body[half + "_file"] ?? "") !== "") {
        const bytes = Buffer.from(String(body[half + "_file"]), "base64");
        const read = Library.readUpload(bytes.subarray(0, 2097152));
        if (!read.ok) {
          out[half + "_error"] = read.error;
          continue;
        }
        text = read.csv;
      }
      if (text !== "") {
        text = mbSubstr(text, 0, 262144);
        out[half] = half === "ship" ? Library.parseShipCsv(text) : Library.parseCrewCsv(text);
      }
    }
    return out;
  }

  async function gameRoute(req, res, url, body, g, route) {
    const owner = isLoopback(req);
    switch (route) {
      case "": {
        const me = Game.captainByToken(w, g.id, String(req.headers["x-gd-captain"] || ""));
        if (me) Game.touch(w, g.id, me.id);
        // Before joining, a visitor learns only that the game exists and whether it can be joined.
        if (!owner && !me) return json(res, 200, { status: g.status, joined: false, owner: false, join_ready: !!g.join_code, expired: Game.expired(g) });
        const caps = Game.captains(w, g.id);
        const join = { addresses: lanAddresses(), port: listenPort, code: g.join_code ? g.join_code.code : "" };
        return json(res, 200, Object.assign(View.lobby(w, g, caps, owner, join), { joined: !!me, owner, me: me ? me.id : 0, title: g.story?.title ?? "", turns: Rules.intval(g.turn) }));
      }
      case "/unlock": {
        if (req.method !== "POST") break;
        const ok = checkCode(g, String(body.code ?? ""), clientIp(req));
        if (isErr(ok)) return reply(res, ok);
        return json(res, 200, { ticket: issueTicket(g) });
      }
      case "/builds": {
        if (!maySeat(req, g)) return reply(res, fail("gd_auth", "Enter the join code first.", 403));
        const taken = Game.takenBuilds(w, g.id);
        const builds = Library.listBuilds(dataDir).map(b => ({ id: b.id, name: b.name, captain: b.captain, taken: taken.includes(b.id) }));
        // Seats that can be resumed from this device: any whose player is not connected (§3.5, §11.3). Player One
        // may always take their own seat back.
        const seats = [];
        for (const c of Game.captains(w, g.id).values()) {
          if (!Game.isConnected(w, c) || (c.seat === 1 && owner)) {
            const b = Library.getBuild(dataDir, c.build_id);
            seats.push({ id: c.id, seat: c.seat, name: c.name, ship: c.state?.ship?.name ?? (b ? b.name : "") });
          }
        }
        return json(res, 200, { builds, seats });
      }
      case "/resume": {
        if (req.method !== "POST") break;
        if (!maySeat(req, g)) return reply(res, fail("gd_auth", "Enter the join code first.", 403));
        return reply(res, await Game.withLock(w, g.id, async fresh => {
          const c = Game.captains(w, fresh.id).get(Rules.intval(body.captain)) ?? null;
          if (!c) return fail("gd_not_found", "That seat does not exist.", 404);
          if (Game.isConnected(w, c) && !(c.seat === 1 && owner)) return fail("gd_in_use", "That captain is connected on another device.", 409);
          const token = randomHex(24);
          store.updateCaptain(fresh.id, c.id, { token_hash: sha256(token), device: String(body.device ?? "").replace(/[^a-zA-Z0-9]/g, ""), last_seen: gmdate() });
          store.event(fresh.id, c.id, "system", { what: "seat_resumed" });
          return { captain: c.id, seat: c.seat, token, name: c.name };
        }));
      }
      case "/join": {
        if (req.method !== "POST") break;
        if (!maySeat(req, g)) return reply(res, fail("gd_auth", "Enter the join code first.", 403));
        if (!["lobby", "active"].includes(g.status)) return reply(res, fail("gd_busy", g.status === "generating" ? "The universe is being generated. Join again in a moment." : "This campaign has ended.", 409));
        const r = await Game.join(w, g.id, String(body.name ?? ""), Rules.intval(body.build_id), String(body.device ?? ""));
        if (isErr(r)) return reply(res, r);
        return json(res, 200, { captain: r[0].id, seat: r[0].seat, name: r[0].name, token: r[1] });
      }
      case "/remove": {
        if (req.method !== "POST") break;
        if (!owner) return reply(res, fail("gd_auth", "Only Player One can remove a captain.", 403));
        const r = await Game.removeCaptain(w, g.id, Rules.intval(body.captain));
        return reply(res, isErr(r) ? r : { ok: true });
      }
      case "/start": {
        if (req.method !== "POST") break;
        if (!owner) return reply(res, fail("gd_auth", "Only Player One can start the game.", 403));
        const r = await Game.start(w, g.id);
        return reply(res, isErr(r) ? r : { ok: true });
      }
      case "/generate": {
        if (req.method !== "POST") break;
        if (!owner && isErr(captainOf(req, g))) return reply(res, fail("gd_auth", "Not allowed.", 403));
        const gen = await Generator.step(w, g.id);
        if (isErr(gen)) return reply(res, gen.code === "gd_busy" ? { busy: true } : gen);
        return json(res, 200, { gen, status: Game.get(w, g.id).status });
      }
    }
    // Everything else is for a seated captain.
    const c = captainOf(req, g);
    if (isErr(c)) return reply(res, c);
    switch (route) {
      case "/state": {
        // Heartbeat. Captains sharing one screen stay connected together (hot-seat, §3.6).
        for (const o of Game.captains(w, g.id).values()) if (o.id === c.id || (c.device !== "" && o.device === c.device)) Game.touch(w, g.id, o.id);
        if (g.status === "active") {
          // Under the game lock, so it never overwrites a turn being resolved: if one is, this poll skips the check.
          await Game.withLock(w, g.id, async fresh => Game.checkConnections(w, fresh), 0);
          await Turn.tick(w, g.id);
        }
        const fresh = Game.get(w, g.id);
        const caps = Game.captains(w, g.id);
        const out = View.state(w, fresh, caps, c.id, Rules.intval(url.searchParams.get("after") ?? 0));
        out.map_v = View.mapVersion(w, fresh);
        out.local = [...caps.values()].filter(o => c.device !== "" && o.device === c.device).map(o => ({ id: o.id, name: o.name, seat: o.seat }));
        out.work = Turn.hasWork(w, g.id, caps);
        out.tts_mode = "local";
        out.realtime = "sse";
        return json(res, 200, out);
      }
      case "/map": return json(res, 200, View.map(w, g));
      case "/log": return json(res, 200, { title: g.story?.title ?? "", entries: View.shipsLog(w, g, c.id) });
      case "/stream": {
        res.writeHead(200, Object.assign({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" }, CORS));
        res.write(": open\n\n");
        const entry = { res, cid: c.id };
        if (!streams.has(g.id)) streams.set(g.id, new Set());
        streams.get(g.id).add(entry);
        if (!marks.has(g.id)) marks.set(g.id, markOf(g.id));
        const keep = setInterval(() => res.write(": keep\n\n"), 15000);
        req.on("close", () => {
          clearInterval(keep);
          streams.get(g.id)?.delete(entry);
        });
        return;
      }
    }
    if (req.method !== "POST") return reply(res, fail("gd_not_found", "No such route.", 404));
    switch (route) {
      case "/command": return live(req, res, c.id, lv => Turn.command(w, g.id, c.id, String(body.text ?? ""), lv));
      case "/work": return live(req, res, c.id, async lv => { await Turn.work(w, g.id, lv); return { ok: true }; });
      case "/roll": return live(req, res, c.id, lv => Turn.submitRoll(w, g.id, c.id, body.value, lv));
      case "/answer": return live(req, res, c.id, lv => Turn.answer(w, g.id, c.id, sanitizeKey(String(body.choice ?? "")), lv));
      case "/safety": return live(req, res, c.id, lv => (String(body.choice ?? "carry") === "carry" ? Turn.carryOn(w, g.id, c.id, lv) : { ok: true }));
      case "/allocate": return reply(res, await Turn.allocateBonus(w, g.id, c.id, body.alloc && typeof body.alloc === "object" ? body.alloc : {}));
      case "/pause": {
        // Any captain may pause, and any captain may unpause a pause made by hand (§7.2.6).
        const on = !T.empty(body.on);
        const done = await Game.withLock(w, g.id, async fresh => {
          if (fresh.status !== "active") return fail("gd_not_active", "The game is not running.", 409);
          if (on) fresh = Game.setPause(w, fresh, c.id, "manual");
          else if (fresh.pause && fresh.pause.reason === "manual") fresh = Game.clearPause(w, fresh, c.id);
          Game.save(w, fresh);
          return { ok: true };
        }, on ? 0 : 20);
        // A turn is being resolved: the pause is recorded at once all the same, and that turn's report is held.
        if (isErr(done) && done.code === "gd_busy" && on && g.status === "active") {
          Game.requestPause(w, g.id, c.id);
          return json(res, 200, { ok: true });
        }
        return reply(res, done);
      }
      case "/decide": return reply(res, await Game.withLock(w, g.id, async fresh => {
        const caps = Game.captains(w, fresh.id);
        if (!fresh.pause || fresh.pause.reason !== "disconnect") return { ok: true };
        if (Game.decider(w, fresh, caps) !== c.id) return fail("gd_auth", "Only Player One chooses whether to wait or resume.", 403);
        if (body.choice === "resume") Game.save(w, Game.resumeWithout(w, fresh, c.id));
        return { ok: true };
      }));
      case "/audio": return reply(res, await Game.withLock(w, g.id, async fresh => {
        const me = Game.captains(w, fresh.id).get(c.id); // re-read inside the lock
        for (const k of ["tts", "stt", "text"]) if (body[k] !== undefined && body[k] !== null) me.state.audio[k] = !!body[k];
        Game.saveCaptain(w, me);
        return { audio: me.state.audio };
      }));
      case "/chat": {
        // Player chat inside a fleet: free, and never sent to the model (§3.3.2).
        const text = sanitizeTextField(String(body.text ?? "")).trim();
        if (text === "") return reply(res, fail("gd_empty", "Type a message first.", 400));
        return reply(res, await Game.withLock(w, g.id, async fresh => {
          const pid = c.state.party ?? "";
          if (!fresh.parties[pid] || fresh.parties[pid].members.length < 2) return fail("gd_chat", "Player chat is for captains in the same fleet.", 409);
          fresh.chat.push({ party: pid, from: c.name, text: mbSubstr(text, 0, 400), at: time() });
          fresh.chat = fresh.chat.slice(-200);
          Game.save(w, fresh);
          return { ok: true };
        }));
      }
    }
    return reply(res, fail("gd_not_found", "No such route.", 404));
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://host");
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    const body = req.method === "POST" ? await readBody(req) : {};
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (p === "/rules" && req.method === "GET") return json(res, 200, rules());
    if (p === "/game" && req.method === "POST") {
      if (!isLoopback(req)) return reply(res, fail("gd_login", "Only the host's own window can create a game.", 401));
      const code = String(body.join_code ?? body.code ?? "");
      if (!isValidCode(code)) return reply(res, fail("gd_code_format", "The join code must be exactly four digits.", 400));
      const g = Game.create(w, { preset: body.preset, dice: body.dice, captains: body.captains, join_code: hashCode(code) });
      return json(res, 200, { token: g.token });
    }
    if (p === "/games" && req.method === "GET") {
      // Player One's campaigns, running and finished, so an archived one can be reopened (§11.3).
      if (!isLoopback(req)) return json(res, 200, { games: [] });
      return json(res, 200, { games: store.allGames().filter(g => !Game.expired(g)).sort((a, b) => b.created - a.created || b.id - a.id).slice(0, 50).map(gameRow) });
    }
    if (p === "/hosted" && req.method === "GET") {
      // The games on this host a player can join, for the join screen (it replaces the plugin's game link).
      const games = store.allGames().filter(g => !Game.expired(g) && g.status !== "ended").map(g => ({ token: g.token, title: g.story?.title ?? "", status: g.status, captains: Game.captains(w, g.id).size, join_ready: !!g.join_code }));
      return json(res, 200, { games });
    }
    if (p.startsWith("/creator/")) return creatorRoute(req, res, url, body);
    const m = /^\/game\/([a-f0-9]{32,64})(\/[a-z]+)?$/.exec(p);
    if (!m) return reply(res, fail("gd_not_found", "No such route.", 404));
    const g = Game.byToken(w, m[1]);
    if (!g) return reply(res, fail("gd_no_game", "That game is not on this server.", 404));
    return gameRoute(req, res, url, body, g, m[2] || "");
  }

  /* The timers that replace WordPress cron: disconnects, roll timeouts and the turn timer, for every running game. */
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const g of store.allGames()) {
        if (g.status !== "active") continue;
        await Game.withLock(w, g.id, async fresh => Game.checkConnections(w, fresh), 0);
        await Turn.tick(w, g.id);
      }
      watch();
    } catch (e) {
      // a timer must never bring the server down; the next tick tries again
    } finally {
      ticking = false;
    }
  }

  function listen() {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        handle(req, res).catch(e => {
          if (!res.headersSent) json(res, 500, errBody(fail("gd_error", "Something went wrong on the host: " + String((e && e.message) || e), 500)));
          else res.end();
        });
      });
      server.on("error", reject);
      server.listen(port, host, () => {
        listenPort = server.address().port;
        timer = setInterval(tick, TICK_MS);
        const fast = setInterval(watch, 1000);
        server.on("close", () => clearInterval(fast));
        resolve({ port: listenPort, host });
      });
    });
  }

  function close() {
    return new Promise(resolve => {
      clearInterval(timer);
      for (const set of streams.values()) for (const s of set) s.res.end();
      streams.clear();
      if (!server) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { listen, close, world: w, tick };
}

module.exports = { createServer, DEFAULT_PORT };
