"use strict";
/* Game sessions, ported from the plugin's class-game.php: creation, lobby, joining, start, pause, heartbeats,
   missions, sectors, ship helpers and standing. A game's shared state is one JSON object (game.json); each captain
   has a row. All writes happen under the per-game lock.

   Every function takes the world `w` first: { store, llm, voices, settings, dataDir }. Captains and missions are
   Maps of id -> row, in the plugin's order (seat, and spine then id). Ids are numbers throughout. */
const Rules = require("./rules.js");
const Engine = require("./engine.js");
const Grid = require("./grid.js");
const Library = require("./library.js");
const Prompts = require("./prompts.js");
const setting = require("./setting.js");
const T = require("./text.js");

const { GdError, isErr, fail, time, gmdate, parseGm, sha256, randomHex, randInt, sanitizeTextField, sanitizeTextareaField, empty, toList } = T;
const POWER = setting.POWER.key;
const DAY = 86400;

/* ---------- settings (§2.1): the plugin's admin settings, with its defaults and allowed ranges ---------- */

const DEFAULTS = Object.freeze({
  roll_timeout: 100,       // seconds, 30-600 (§7.2.5)
  turn_timeout: 180,       // seconds a captain in a multi-captain game has to give an order, 60-900 (§14.5 rule 6)
  heartbeat_timeout: 30,   // seconds without a heartbeat = dropped (§3.5)
  summary_every: 10,       // turns (§11.2)
  recent_window: 6,        // turns kept verbatim (§11.2)
  token_budget: 24000,     // input-token ceiling per turn call (§11.5)
  computer_gender: "Female" // §10
});
const RANGES = { roll_timeout: [30, 600], turn_timeout: [60, 900], heartbeat_timeout: [10, 300], summary_every: [4, 50], recent_window: [2, 20], token_budget: [4000, 200000] };

function setting_(w, key) {
  const s = (w && w.settings) || {};
  if (Object.prototype.hasOwnProperty.call(RANGES, key)) {
    const v = s[key] === undefined || s[key] === null ? DEFAULTS[key] : Rules.intval(s[key]);
    return Math.max(RANGES[key][0], Math.min(RANGES[key][1], v));
  }
  if (key === "computer_gender") return Rules.genders().includes(s.computer_gender) ? s.computer_gender : DEFAULTS.computer_gender;
  return s[key] === undefined ? DEFAULTS[key] : s[key];
}

/* ---------- load / save ---------- */

function get(w, id) {
  const g = w.store.getGame(id);
  if (!g) return null;
  // A pause asked for while a turn was being resolved (see requestPause) counts from the moment it was asked.
  const asked = w.store.getMeta(g.id, "pause_req");
  if (asked && empty(g.pause) && g.status === "active") g.pause = { by: Rules.intval(asked.by), reason: "manual", at: Rules.intval(asked.at) };
  return g;
}

function byToken(w, token) {
  token = String(token ?? "").toLowerCase().replace(/[^a-f0-9]/g, "");
  if (token.length < 32) return null;
  const g = w.store.gameByToken(token);
  return g ? get(w, g.id) : null;
}

function save(w, g) {
  w.store.saveGame(g);
}

const lockName = id => "game_" + Math.trunc(Number(id));

/* Run fn(game) under the game lock. wait: seconds to wait for it. */
async function withLock(w, gameId, fn, wait = 20) {
  const name = lockName(gameId);
  if (!(await w.store.lock(name, wait))) return fail("gd_busy", "The game is busy resolving another turn. Try again in a moment.", 409);
  try {
    const g = get(w, gameId);
    if (!g) return fail("gd_no_game", "That game does not exist.", 404);
    return await fn(g);
  } finally {
    w.store.unlock(name);
  }
}

/* ---------- leads (§14.6) ---------- */

/* Missions are not listed in advance: the story leads the captains from one to the next. This gives out the lead to
   every critical mission the story has now opened (nothing before it, or what came before it is complete; the finale
   once every other critical mission is settled) and that has not been given out yet. Each is logged for every
   captain and read out by the Computer. Returns [game, the leads just given out]. */
function openLeads(w, g) {
  const all = missions(w, g.id);
  const known = toList(g.leads ?? []).map(l => l.mission);
  const fresh = [];
  outer: for (const m of all.values()) {
    if (!m.is_critical || m.status !== "available" || known.includes(m.id) || String(m.data.lead ?? "") === "") continue;
    const dep = Rules.intval(m.data.depends_on ?? 0);
    if (dep && all.has(dep) && all.get(dep).status !== "completed") continue;
    if (m.is_final) {
      for (const o of all.values()) {
        if (o.is_critical && !o.is_final && (!["completed", "failed"].includes(o.status) || !empty(o.data.bridge_pending))) continue outer;
      }
    }
    const lead = { mission: m.id, sector: m.sector, text: m.data.lead };
    if (!Array.isArray(g.leads)) g.leads = [];
    g.leads.push(lead);
    fresh.push(lead);
    w.store.event(g.id, 0, "notice", { text: "New lead logged. " + lead.text + " Sector " + lead.sector + ".", audience: "all", speaker: "Computer", say: true }, Rules.intval(g.turn ?? 0));
  }
  return [g, fresh];
}

/* A campaign generated before leads existed has none written for its missions yet. */
const needsLeads = g => (g.status ?? "") === "active" && (g.leads === undefined || g.leads === null);

/* Write the leads such a campaign is missing. All or nothing: if they cannot all be had, this is tried again shortly. */
async function writeLeads(w, g) {
  if (!needsLeads(g) || time() - Rules.intval(g.leads_tried ?? 0) < 8) return g;
  g.leads_tried = time();
  const all = missions(w, g.id);
  const want = new Map();
  for (const m of all.values()) {
    if (m.is_critical && m.status === "available" && String(m.data.lead ?? "") === "") {
      const dep = Rules.intval(m.data.depends_on ?? 0);
      want.set(m.id, "MISSION id " + m.id + ': "' + m.data.title + '"' + (m.is_final ? " (the finale)" : "") + ". " + m.data.briefing
        + " Comes after: " + (dep && all.has(dep) ? '"' + all.get(dep).data.title + '"' : m.is_final ? "every other critical mission" : "nothing; it can be reached from the start") + ".");
    }
  }
  if (want.size) {
    const res = await w.llm.call("missions", Prompts.leadsSystem(), "CAMPAIGN: " + (g.story?.title ?? "") + ". " + (g.story?.premise ?? "") + "\n\n" + [...want.values()].join("\n"), { json: true, schema: Prompts.leadsSchema(), maxTokens: 4000, store: w.store, gameId: g.id });
    const leads = new Map();
    for (const l of isErr(res) ? [] : toList(res.json?.leads ?? [])) {
      const text = sanitizeTextareaField(T.str(l?.lead ?? ""));
      if (want.has(Rules.intval(l?.id ?? 0)) && text !== "") leads.set(Rules.intval(l.id), text);
    }
    if (leads.size !== want.size) return g;
    for (const [id, text] of leads) {
      const m = all.get(id);
      m.data.lead = text;
      saveMission(w, m);
    }
  }
  g.leads = [];
  delete g.leads_tried;
  return openLeads(w, g)[0];
}

/* Pause without waiting for the turn in progress (§7.2.6). The turn completes, but everything it logs after this
   moment is held back from every player until the game is resumed. */
function requestPause(w, gameId, by) {
  if (!w.store.getMeta(gameId, "pause_req")) {
    w.store.setMeta(gameId, "pause_req", { by: Rules.intval(by), at: time() });
    w.store.event(gameId, Rules.intval(by), "pause", { reason: "manual" });
  }
}

/* ---------- captains ---------- */

const captains = (w, gameId) => w.store.captains(gameId);
const captainByToken = (w, gameId, token) => w.store.captainByToken(gameId, token);
const saveCaptain = (w, c) => w.store.saveCaptain(c);
const touch = (w, gameId, cid) => w.store.touch(gameId, cid);

/* Connected = heartbeat within the timeout (§3.5). */
function isConnected(w, c, now = null) {
  now = now ?? time();
  return now - parseGm(c.last_seen) <= setting_(w, "heartbeat_timeout");
}

/* ---------- create ---------- */

/* A new game. opts: preset, dice, captains. Returns the game, with ownerToken (shown once: Player One's proof). */
function create(w, opts) {
  const presets = Rules.presets();
  const preset = Object.prototype.hasOwnProperty.call(presets, opts.preset ?? "") ? opts.preset : "standard";
  const token = randomHex(24); // unguessable game token (§3.5)
  const ownerToken = randomHex(24);
  const g = w.store.createGame({
    token,
    owner_hash: sha256(ownerToken),
    status: "lobby", // lobby | generating | active | ended
    options: {
      preset,
      size: Math.min(Rules.MAX_GRID, Rules.intval(presets[preset].size)), // hard cap in code (§5.3)
      dice: opts.dice === "physical" ? "physical" : "system",
      captains: Math.max(1, Math.min(Rules.MAX_CAPTAINS, Rules.intval(opts.captains ?? 1)))
    },
    seed: randomHex(8),
    created: time(),
    started: 0,
    gen: { phase: 0, error: null },
    pause: null,
    story: null,
    factions: {},
    order: [],
    parties: {},
    turn: 0,
    chat: [],
    join_code: opts.join_code || null
  });
  w.store.event(g.id, 0, "system", { what: "game_created", options: g.options });
  g.ownerToken = ownerToken;
  return g;
}

const expired = g => g.status === "lobby" && time() - Rules.intval(g.created) > Rules.LINK_EXPIRY_DAYS * DAY;
const isOwner = (g, ownerToken) => !!ownerToken && typeof ownerToken === "string" && g.owner_hash === sha256(ownerToken);

/* ---------- lobby ---------- */

/* Build ids already taken in this game (§4.5: one player per ship and crew). */
function takenBuilds(w, gameId) {
  const out = [];
  for (const c of captains(w, gameId).values()) if (c.build_id) out.push(Rules.intval(c.build_id));
  return out;
}

/* Seat a captain. Returns [captain row, plain token] or a GdError. device: shared by local captains on one screen. */
function join(w, gameId, name, buildId, device) {
  return withLock(w, gameId, async g => {
    if (g.status === "ended") return fail("gd_ended", "This campaign has ended.", 410);
    if (expired(g)) return fail("gd_expired", "This game has expired. Ask Player One to create a new game.", 410);
    let caps = captains(w, g.id);
    if (caps.size >= Rules.MAX_CAPTAINS) return fail("gd_full", "This game already has six captains, which is the maximum.", 409);
    const build = Library.getBuild(w.dataDir, Rules.intval(buildId));
    if (!build) return fail("gd_no_build", "That ship and crew could not be found. Choose another.", 404);
    if (takenBuilds(w, g.id).includes(Rules.intval(buildId))) return fail("gd_build_taken", "Another captain has just taken that ship and crew. Choose another.", 409);
    // A ship saved with its captain's name brings that name with it; otherwise the player gives one.
    const ownName = String(build.ship.captain ?? "").trim();
    name = ownName !== "" ? ownName : sanitizeTextField(String(name ?? "")).trim();
    const token = randomHex(24);
    const seat = caps.size ? Math.max(...[...caps.values()].map(c => c.seat)) + 1 : 1;
    const cid = w.store.insertCaptain(g.id, {
      seat,
      token_hash: sha256(token),
      device: String(device ?? "").replace(/[^a-zA-Z0-9]/g, ""),
      name: name !== "" ? name : "Captain " + seat,
      build_id: Rules.intval(buildId),
      ready: 1,
      state: {},
      last_seen: gmdate()
    });
    w.store.event(g.id, cid, "system", { what: "captain_joined", seat, build: build.name });
    if (g.status === "active") {
      g = await seatLateJoiner(w, g, cid); // §3.5 late joiners
      save(w, g);
    }
    caps = captains(w, g.id);
    return [caps.get(cid), token];
  });
}

function removeCaptain(w, gameId, captainId) {
  return withLock(w, gameId, async g => {
    if (g.status !== "lobby") return fail("gd_started", "Captains can only be removed before the game starts.", 409);
    const caps = captains(w, g.id);
    const c = caps.get(Rules.intval(captainId));
    if (!c || c.seat === 1) return fail("gd_bad", "That captain cannot be removed.", 400);
    w.store.deleteCaptain(g.id, c.id);
    w.store.event(g.id, 0, "system", { what: "captain_removed", captain: c.id });
    return true;
  });
}

/* ---------- start: each game takes its own copy of ship and crew (§4.5) ---------- */

function freshState(build) {
  const crew = JSON.parse(JSON.stringify(build.crew));
  for (const o of Object.values(crew)) o.injury = null;
  const pm = Engine.effectiveAttrs(crew.engineer).power_management.value;
  return {
    ship: Object.assign({}, build.ship, {
      bonus_pool: Math.floor(pm / 4), // §4.2.1 allocated by the player when the game starts
      bonus_alloc: {},
      hull: 100,
      damaged: []
    }),
    crew,
    inventory: [],
    alert: "normal",
    party: "",
    climaxes: [],
    decisions: [],
    pending: null,
    turns: 0,
    summary: "",
    summary_upto: 0,
    database: null,
    tactical_scan: null,
    audio: { tts: true, stt: true, text: true }
  };
}

/* Ship class and registry are optional; blank ones are generated once and stored on the record (§4.1). Tried at save,
   and again when the ship is first taken into a game. If that fails the fields stay blank; nothing is made up. */
async function withFlavour(w, build) {
  const ship = Object.assign({}, build.ship);
  if (String(ship.class ?? "").trim() !== "" && String(ship.registry ?? "").trim() !== "") return build;
  const top = Object.entries(ship.attrs || {}).sort((a, b) => b[1] - a[1]).map(e => e[0]);
  const res = await w.llm.call("flavour", Prompts.flavourSystem(), "Ship name: " + ship.name + ". Strongest in: " + top.slice(0, 2).join(", ") + ".", { json: true, schema: Prompts.flavourSchema(), maxTokens: 2000 });
  if (!isErr(res) && res.json && !empty(res.json.class) && !empty(res.json.registry)) {
    ship.class = String(ship.class ?? "").trim() !== "" ? ship.class : sanitizeTextField(T.str(res.json.class));
    ship.registry = String(ship.registry ?? "").trim() !== "" ? ship.registry : sanitizeTextField(T.str(res.json.registry));
    build = Object.assign({}, build, { ship });
    if (!empty(build.id)) Library.saveBuild(w.dataDir, ship, build.crew, Rules.intval(build.id));
  }
  return build;
}

function start(w, gameId) {
  return withLock(w, gameId, async g => {
    if (g.status !== "lobby") return fail("gd_started", "This game has already started.", 409);
    const caps = captains(w, g.id);
    if (!caps.size) return fail("gd_empty", "Choose a ship and crew before starting.", 400);
    for (const c of caps.values()) {
      const build = Library.getBuild(w.dataDir, c.build_id);
      if (!build) return fail("gd_no_build", c.name + " has no ship and crew selected.", 400);
      c.state = freshState(await withFlavour(w, build));
      c.state.crew = w.voices.assignCrew(c.state.crew);
      saveCaptain(w, c);
      g.order.push(c.id); // fixed turn order = lobby join order, Player One first (§3.3.2)
    }
    g.status = "generating";
    g.started = time();
    g.gen = { phase: 0, error: null };
    save(w, g);
    w.store.event(g.id, 0, "system", { what: "game_started", order: g.order });
    return true;
  });
}

/* A captain joining after the start arrives beside Player One, last in the turn order (§3.5). */
async function seatLateJoiner(w, g, cid) {
  const caps = captains(w, g.id);
  const c = caps.get(cid);
  const build = await withFlavour(w, Library.getBuild(w.dataDir, c.build_id));
  c.state = freshState(build);
  c.state.crew = w.voices.assignCrew(c.state.crew);
  const p1 = caps.get(g.order[0]) || null;
  const pos = p1 ? g.parties[p1.state.party]?.position ?? "0,0,0" : "0,0,0";
  const pid = "p" + cid;
  g.parties[pid] = newParty(pid, cid, pos);
  c.state.party = pid;
  // Their crew knows what has already happened: the campaign so far, digested from Player One's rolling summary
  // and recent turns, plus world canon (§3.5). Written by the turn module's briefJoiner(); until it exists the
  // joiner's crew is still being briefed.
  c.state.summary = sharedSummary(w, g);
  c.state.briefing = p1 && Rules.intval(p1.state.turns ?? 0) > 0 ? { from: p1.id, tried: 0 } : null;
  saveCaptain(w, c);
  g.order.push(cid);
  w.store.event(g.id, cid, "notice", { text: c.name + " of the " + c.state.ship.name + " has joined the campaign and arrives at sector " + pos + ".", audience: "all" });
  return g;
}

function newParty(pid, leader, position) {
  return { id: pid, leader: Rules.intval(leader), members: [Rules.intval(leader)], position, stage: null, last_position: position };
}

/* Digest for a late joiner: the public brief plus recorded major events. */
function sharedSummary(w, g) {
  const parts = [g.story?.public_brief ?? ""];
  for (const row of w.store.canon(g.id, { kind: "event", limit: 20 })) parts.push(row.data.text ?? "");
  return parts.filter(p => !empty(p)).join(" ").trim();
}

/* ---------- pause (§7.2.6) and disconnects (§3.5) ---------- */

function setPause(w, g, by, reason, extra = {}) {
  if (g.pause) return g;
  g.pause = Object.assign({ by: Rules.intval(by), reason, at: time() }, extra);
  w.store.event(g.id, Rules.intval(by), "pause", Object.assign({ reason }, extra));
  return g;
}

/* Unpause: roll timeouts resume with their remaining time preserved. */
function clearPause(w, g, by) {
  if (!g.pause) return g;
  const held = time() - Rules.intval(g.pause.at);
  for (const c of captains(w, g.id).values()) {
    if (!empty(c.state?.pending?.deadline)) {
      c.state.pending.deadline += held;
      saveCaptain(w, c);
    }
  }
  if (!empty(g.turn_clock)) g.turn_clock.since += held; // the turn timer keeps its remaining time too
  w.store.event(g.id, Rules.intval(by), "unpause", { held_seconds: held });
  w.store.setMeta(g.id, "pause_req", null);
  g.pause = null;
  return g;
}

/* Who decides Wait or Resume: Player One, or the next connected captain in the fixed order if Player One dropped. */
function decider(w, g, caps) {
  for (const cid of g.order) {
    if (caps.has(cid) && isConnected(w, caps.get(cid))) return Rules.intval(cid);
  }
  return 0;
}

/* Server-side disconnect detection, run on every poll and on a timer. Marks captains dropped or returned, pauses
   with a dialogue when someone drops, and restores them on return. */
function checkConnections(w, g) {
  if (g.status !== "active") return g;
  const caps = captains(w, g.id);
  let dropped = (g.dropped ?? []).slice();
  let changed = false;
  for (const [cid, c] of caps) {
    const on = isConnected(w, c);
    if (!on && !dropped.includes(cid)) {
      dropped.push(cid);
      changed = true;
      w.store.event(g.id, cid, "system", { what: "disconnected" });
      if (caps.size > dropped.length) {
        if (!g.pause) g = setPause(w, g, 0, "disconnect", { dropped: [cid] });
        else if (g.pause.reason === "disconnect") g.pause.dropped.push(cid);
      }
    } else if (on && dropped.includes(cid)) {
      dropped = dropped.filter(d => d !== cid);
      changed = true;
      w.store.event(g.id, cid, "notice", { text: c.name + " has reconnected.", audience: "all" });
      if (g.pause && g.pause.reason === "disconnect") {
        g.pause.dropped = g.pause.dropped.filter(d => d !== cid);
        if (!g.pause.dropped.length) g = clearPause(w, g, cid);
      }
    }
  }
  if (changed) {
    g.dropped = dropped;
    save(w, g);
  }
  return g;
}

/* Wait keeps the pause; Resume continues without the dropped captains (their party pays one band, §3.5). */
function resumeWithout(w, g, by) {
  if (!g.pause || g.pause.reason !== "disconnect") return g;
  for (const cid of g.pause.dropped) {
    for (const [pid, p] of Object.entries(g.parties)) {
      if (p.members.includes(cid) && p.members.length > 1 && p.stage) g.parties[pid].stage.missing_helper = true;
    }
  }
  return clearPause(w, g, by);
}

/* ---------- requirements (§6.3) ---------- */

/* Captains currently in the game: those who have not dropped. */
function connectedIds(w, g, caps = null) {
  caps = caps ?? captains(w, g.id);
  return [...caps.keys()].filter(cid => !(g.dropped ?? []).includes(cid));
}

/* effective = min(declared, captains currently in the game); the finale needs every connected captain. */
function effectiveRequirement(w, row, g, caps = null) {
  const connected = Math.max(1, connectedIds(w, g, caps).length);
  if (!empty(row.is_final)) return connected;
  return Math.min(Rules.intval(row.min_captains), connected);
}

/* ---------- missions ---------- */

const missions = (w, gameId, status = null) => w.store.missions(gameId, status);

function addMission(w, gameId, m, spine = 0, status = "available") {
  return w.store.insertMission(gameId, {
    kind: m.kind,
    status,
    sector: m.sector,
    is_critical: m.is_critical ? 1 : 0,
    is_final: m.is_final ? 1 : 0,
    min_captains: Rules.intval(m.min_captains_required),
    spine: Rules.intval(spine),
    data: Object.assign({}, m, m.progress ? {} : { progress: { stage: 0, failures: 0, bridges: 0 } })
  });
}

const saveMission = (w, row) => w.store.saveMission(row);

/* ---------- sectors ---------- */

const sectors = (w, gameId) => w.store.sectors(gameId);

function sector(w, gameId, coord, size) {
  const r = w.store.sectorRow(gameId, coord);
  if (r) return r;
  const c = Grid.parseCoord(coord);
  if (!c || !Grid.inBounds(size, c)) return null;
  return { status: 0, faction: "", data: Grid.sectorAt({ size, sectors: {} }, c[0], c[1], c[2]) };
}

/* Mark a sector scanned (1) or visited (2). Scans and visits are one shared record of the Concord (§3.2).
   Returns true when its status went up. */
function markSector(w, gameId, coord, status, size, merge = {}) {
  const cur = w.store.sectorRow(gameId, coord);
  if (cur) {
    const was = cur.status;
    cur.status = Math.max(cur.status, Rules.intval(status));
    if (!empty(merge)) cur.data = Object.assign({}, cur.data, merge);
    w.store.putSector(gameId, coord, cur);
    return was < Rules.intval(status);
  }
  const s = sector(w, gameId, coord, size);
  if (!s) return false;
  w.store.putSector(gameId, coord, { status: Rules.intval(status), faction: "", data: Object.assign({}, s.data, merge) });
  return true;
}

/* ---------- ship helpers ---------- */

/* Effective ship attributes: allocated + bonus allocation + equipment held (§4.1, §7.3). */
function shipEffective(state) {
  const out = {};
  for (const a of Object.keys(Rules.shipAttributes())) {
    out[a] = { base: Rules.intval(state.ship.attrs?.[a] ?? 0), bonus: Rules.intval(state.ship.bonus_alloc?.[a] ?? 0), items: 0 };
  }
  const items = Rules.items();
  for (const slot of state.inventory || []) {
    const it = items[slot.item] ?? null;
    if (it && it.kind === "equipment" && it.effect === "ship_attribute" && out[it.attribute]) out[it.attribute].items += Rules.intval(it.value);
  }
  for (const v of Object.values(out)) v.value = v.base + v.bonus + v.items;
  return out;
}

/* Max range in light-years this turn = the ship's Speed (§7.4). */
const rangeLy = state => shipEffective(state).speed.value + Number(state.range_bonus ?? 0);

/* Fleet range is the slowest member's (§3.3.1). */
function partyRange(party, caps) {
  let r = null;
  for (const cid of party.members) {
    if (caps.has(cid)) {
      const v = rangeLy(caps.get(cid).state);
      r = r === null ? v : Math.min(r, v);
    }
  }
  return r ?? 0;
}

function cargoUsed(state) {
  return (state.inventory || []).filter(slot => empty(slot.story)).length;
}

/* Add an item, stacking consumables up to three per slot. Returns false when the hold is full. */
function addItem(state, itemId, flavour = {}) {
  const items = Rules.items();
  if (!state.inventory) state.inventory = [];
  if (!empty(flavour.story)) {
    state.inventory.push({ key: "story" + (state.inventory.length + 1) + randInt(100, 999), item: "story", qty: 1, story: true, name: flavour.name, desc: flavour.desc ?? "", mission: Rules.intval(flavour.mission ?? 0) });
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(items, itemId)) return false;
  if (items[itemId].kind === "consumable") {
    for (const slot of state.inventory) {
      if (slot.item === itemId && slot.qty < Rules.STACK_SIZE) {
        slot.qty++;
        return true;
      }
    }
  }
  if (cargoUsed(state) >= Rules.CARGO_SLOTS) return false;
  state.inventory.push({ key: itemId + "_" + randInt(1000, 9999), item: itemId, qty: 1, name: flavour.name ?? items[itemId].name, desc: flavour.desc ?? "" });
  return true;
}

function takeItem(state, key) {
  const i = state.inventory.findIndex(slot => slot.key === key || slot.item === key);
  if (i < 0) return null;
  const slot = Object.assign({}, state.inventory[i]);
  if (state.inventory[i].qty > 1) state.inventory[i].qty--;
  else state.inventory.splice(i, 1);
  slot.qty = 1;
  return slot;
}

/* ---------- standing (§9.1): shared by all captains, changed only by the game ---------- */

function changeStanding(w, g, faction, delta, reason) {
  if (!g.factions[faction] || Rules.intval(delta) === 0 || faction === POWER) return g;
  const f = g.factions[faction];
  const old = Rules.intval(f.standing);
  const now = Math.max(-10, Math.min(10, old + Rules.intval(delta)));
  g.factions[faction] = Object.assign({}, f, { standing: now, met: true, dir: Math.sign(now - old), reason });
  if (now !== old) {
    const from = Rules.standingStep(old);
    const to = Rules.standingStep(now);
    w.store.event(g.id, 0, "notice", { text: "Standing with " + f.name + (from !== to ? " is now " + to : now > old ? " has improved" : " has worsened") + ": " + reason, audience: "all", standing: [faction, old, now] });
  }
  return g;
}

function meetFaction(g, faction) {
  if (g.factions[faction] && empty(g.factions[faction].met)) g.factions[faction].met = true;
  return g;
}

module.exports = {
  DEFAULTS, setting: setting_, get, byToken, save, withLock, lockName, openLeads, needsLeads, writeLeads, requestPause,
  captains, captainByToken, saveCaptain, touch, isConnected, create, expired, isOwner, takenBuilds, join, removeCaptain,
  freshState, withFlavour, start, seatLateJoiner, newParty, sharedSummary, setPause, clearPause, decider,
  checkConnections, resumeWithout, connectedIds, effectiveRequirement, missions, addMission, saveMission,
  sectors, sector, markSector, shipEffective, rangeLy, partyRange, cargoUsed, addItem, takeItem, changeStanding, meetFaction
};
