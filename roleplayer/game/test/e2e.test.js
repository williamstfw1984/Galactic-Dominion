"use strict";
/* Ported from the plugin's tests/integration/e2e.php: full games played over real HTTP against createServer, with a
   scripted stand-in for the model (the plugin's model-mock filter) and for the safety check. The stand-in
   model is given main.js's chat()/chatStream() shapes, so llm.js runs as it does in the app; the kind of call is read
   from its system prompt, as the plugin's mock was given it by name. Like the plugin's test, this one reaches into
   the stores to age timers and set up situations. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServer } = require("../server.js");
const Game = require("../game.js");
const Engine = require("../engine.js");
const { Turn } = require("../turn.js");

const { M, A, stage, mission, chat, chatStream, SAFE, safety, VOICES } = require("./scripted-model.js");

/* ---------------------------------------------------------------- HTTP */
let base = "";
async function api(method, p, params = {}, headers = {}) {
  let url = base + p;
  const opt = { method, headers: Object.assign({ "Content-Type": "application/json" }, headers) };
  if (method === "GET") {
    const q = new URLSearchParams(params).toString();
    if (q) url += "?" + q;
  } else opt.body = JSON.stringify(params);
  const r = await fetch(url, opt);
  const text = await r.text();
  if (/ndjson/.test(r.headers.get("content-type") || "")) {
    const msgs = text.split("\n").filter(Boolean).map(l => JSON.parse(l));
    const done = msgs.find(m => m.t === "done");
    return [done.status, done.body, msgs];
  }
  return [r.status, text ? JSON.parse(text) : null];
}
const OWNER = { "X-Test-Owner": "1" };
const capH = token => ({ "X-GD-Captain": token });

const failures = [];
let passes = 0;
function ok(cond, label) {
  if (cond) passes++;
  else failures.push(label);
}

function crew(n) {
  const a = {
    tactical: { accuracy: 8, threat_assessment: 6, security: 5, composure: 5 },
    engineer: { repair: 7, power_management: 8, improvisation: 5, composure: 4 },
    science: { sensor_analysis: 9, xenology: 6, improvisation: 5, composure: 5 },
    first_officer: { command_presence: 8, diplomacy: 7, threat_assessment: 5, composure: 5 },
    medical: { triage: 9, psychology: 6, xenology: 7, composure: 5 },
    helm: { piloting: 8, navigation: 7, evasion: 5, composure: 5 }
  };
  const sp = ["Vey", "Ossan", "Seluun", "Lirae", "Teneri", "Drav"];
  const c = {};
  let i = 0;
  for (const [r, at] of Object.entries(a)) {
    c[r] = { role: r, name: `${n} ${r}`, species: sp[i], gender: i % 2 ? "Male" : "Female", attrs: at, human_bonus: [], personality: "p", voice: "" };
    i++;
  }
  return c;
}

test("end to end: games played over HTTP", { timeout: 600000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gd-e2e-"));
  const srv = createServer({ dataDir: dir, llm: { chat, chatStream }, voices: VOICES, safety, settings: { model: "test-model", heartbeat_timeout: 300 }, port: 0, host: "127.0.0.1", isOwner: req => req.headers["x-test-owner"] === "1" });
  const { port } = await srv.listen();
  base = "http://127.0.0.1:" + port;
  const W = srv.world;
  const store = W.store;
  try {
    await play(W, store);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) console.log("FAILURES:\n- " + failures.join("\n- "));
  console.log(passes + " passed, " + failures.length + " failed");
  assert.deepEqual(failures, []);
});

/* Orders that cost points or roll are put to the captain first; the tests say "proceed" unless M.ASK is set. */
async function cmd(T, h, text) {
  let r = await api("POST", `/game/${T}/command`, { text }, h);
  if (r[0] === 200 && r[1] && r[1].confirm && !M.ASK) r = await api("POST", `/game/${T}/answer`, { choice: "proceed" }, h);
  if (process.env.DEBUG && r[0] !== 200) console.log("CMD", text, r[0], JSON.stringify(r[1]).slice(0, 300));
  return r;
}
const st = async (T, h, after = null) => (await api("GET", `/game/${T}/state`, after === null ? {} : { after }, h))[1];
const pass = (T, h) => { A({ intent: "pass", tier: 0 }); return cmd(T, h, "End turn"); };
async function give(T, cid, hs) {
  for (let i = 0; i < 8; i++) {
    const of = (await st(T, Object.values(hs)[0])).turn.of;
    if (of === cid) return true;
    if (!hs[of] || (await pass(T, hs[of]))[0] !== 200) break;
  }
  console.log("note: could not bring the turn to captain " + cid);
  return false;
}
const said = (s, text) => s.events.some(e => e.type === "notice" && e.text.includes(text));
const gidOf = (W, T) => Game.byToken(W, T).id;
const lastTurn = (W, T) => W.store.events(gidOf(W, T), { types: ["turn"], order: "DESC", limit: 1 })[0].data;
const began = (W, T, re) => W.store.events(gidOf(W, T), { types: ["notice"], order: "DESC", limit: 12 }).some(e => re.test(String(e.data.text ?? "").trim()));
const logged = async (T, h, text) => JSON.stringify((await st(T, h, 0)).events).includes(text);
function nb(coord, avoid = [], size = 8) {
  const c = coord.split(",").map(Number);
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const n = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
    const k = n.join(",");
    if (Math.min(...n) >= 0 && Math.max(...n) < size && !avoid.includes(k)) return k;
  }
  return null;
}
async function age(W, gid) {
  for (const c of Game.captains(W, gid).values()) if (c.state.narration) { c.state.narration.tried = 0; Game.saveCaptain(W, c); }
  for (const m of Game.missions(W, gid).values()) {
    let ch = false;
    if (m.data.progress.recovery_pending) { m.data.progress.recovery_pending.tried = 0; ch = true; }
    if (m.data.bridge_pending) { m.data.bridge_pending.tried = 0; ch = true; }
    if (ch) Game.saveMission(W, m);
  }
}
const work = (T, h) => api("POST", `/game/${T}/work`, {}, h); // held work is asked for apart from the status request

async function play(W, store) {
  /* ---- the creator's library on this server ---- */
  let [s0, d] = await api("GET", "/creator/builds");
  ok(s0 === 403, "the library needs the host's window or a join code");
  const ids = [];
  for (const n of ["Alpha", "Bravo", "Charlie"]) {
    [s0, d] = await api("POST", "/creator/builds", { ship: { name: `CSV ${n}`, class: "", registry: "", attrs: { tactical: 18, defense: 17, speed: 20, manoeuvrability: 13, sensors: 17, hull_integrity: 15 } }, crew: crew(n) }, OWNER);
    ok(s0 === 200, `save build ${n} ` + (s0 === 200 ? "" : JSON.stringify(d)));
    ids.push(d.id || 0);
    ok((d.ship?.class ?? "") === "Harrow class" && d.ship.registry === "CR-7001", "class and registry generated when blank");
    ok(new Set(Object.values(d.crew ?? {}).map(o => o.voice)).size === 6, "six distinct voices");
  }
  [s0, d] = await api("POST", "/creator/builds", { ship: { name: "Bad", attrs: {} }, crew: {} }, OWNER);
  ok(s0 === 422, "invalid build rejected");
  const five = crew("Delta");
  delete five.helm;
  [s0, d] = await api("POST", "/creator/builds", { ship: { name: "CSV Delta", class: "Nova class", registry: "CR-1", attrs: { tactical: 18, defense: 17, speed: 20, manoeuvrability: 13, sensors: 17, hull_integrity: 15 } }, crew: five }, OWNER);
  ok(s0 === 422 && JSON.stringify(d).includes("Helm Officer is missing"), "a five-officer crew (no Helm Officer) is rejected: " + s0);
  [s0, d] = await api("GET", "/rules");
  ok(d.voices.length === 18 && d.voices[0].id === "af_heart" && d.presets.skirmish.label === "Skirmish", "rules: local voices and the setting's presets");

  /* ---- game: system dice ---- */
  [s0, d] = await api("POST", "/game", { preset: "skirmish", dice: "system", captains: 2, join_code: "4321" });
  ok(s0 === 401, "only the host's window creates a game");
  [s0, d] = await api("POST", "/game", { preset: "skirmish", dice: "system", captains: 2, join_code: "43" }, OWNER);
  ok(s0 === 400 && d.code === "gd_code_format", "the join code is four digits");
  [s0, d] = await api("POST", "/game", { preset: "skirmish", dice: "system", captains: 2, join_code: "4321" }, OWNER);
  ok(s0 === 200 && /^[a-f0-9]{48}$/.test(d.token), "create");
  const T = d.token;
  [s0, d] = await api("GET", "/hosted");
  ok(d.games.some(g => g.token === T && g.status === "lobby"), "the game is listed for joining players");
  [s0, d] = await api("POST", `/game/${T}/join`, { name: "Rhea", build_id: ids[0], device: "devA" }, OWNER);
  ok(s0 === 200, "owner joins without code");
  const h1 = capH(d.token), c1 = d.captain;
  [s0, d] = await api("GET", `/game/${T}`);
  ok(s0 === 200 && d.joined === false && d.captains === undefined, "visitor sees no roster");
  [s0, d] = await api("GET", `/game/${T}`, {}, OWNER);
  ok(d.owner && d.join && d.join.code === "4321" && Array.isArray(d.join.addresses), "Player One sees how to join: " + JSON.stringify(d.join));
  [s0, d] = await api("POST", `/game/${T}/join`, { name: "Ilo", build_id: ids[1] });
  ok(s0 === 403, "join needs code");
  [s0, d] = await api("POST", `/game/${T}/unlock`, { code: "1111" });
  ok(s0 === 403 && d.code === "gd_code_wrong" && d.data.attempts_left === 4, "a wrong code: four tries left");
  [s0, d] = await api("POST", `/game/${T}/unlock`, { code: "4321" });
  ok(s0 === 200, "join code ok");
  const tk = { "X-GD-Ticket": d.ticket };
  [s0, d] = await api("GET", `/game/${T}/builds`, {}, tk);
  ok(s0 === 200 && d.builds.find(b => b.id === ids[0]).taken === true && d.builds.find(b => b.id === ids[1]).taken === false, "taken build greyed out");
  [s0, d] = await api("POST", `/game/${T}/join`, { name: "Ilo", build_id: ids[0], device: "devB" }, tk);
  ok(s0 === 409 && d.code === "gd_build_taken", "taken build refused");
  [s0, d] = await api("POST", `/game/${T}/join`, { name: "Ilo", build_id: ids[1], device: "devB" }, tk);
  ok(s0 === 200, "P2 joins");
  const h2 = capH(d.token), c2 = d.captain;
  [s0, d] = await api("POST", `/game/${T}/start`, {}, h2);
  ok(s0 === 403, "only P1 starts");
  [s0, d] = await api("POST", `/game/${T}/start`, {}, OWNER);
  ok(s0 === 200, "start " + JSON.stringify(d));
  for (let i = 0; i < 3; i++) {
    [s0, d] = await api("POST", `/game/${T}/generate`, {}, OWNER);
    ok(s0 === 200 && !d.gen.error, `generate ${i} ` + JSON.stringify(d));
  }
  ok(d.status === "active", "game active after 3 phases");
  let s = await st(T, h1);
  ok(s.status === "active", "state");
  ok(s.position === M.start, "starts at start sector");
  const all0 = Game.missions(W, gidOf(W, T));
  ok(all0.size === 8, "3 critical + 5 side missions after top-up: " + all0.size);
  ok([...all0.values()].filter(m => m.is_final).length === 1 && [...all0.values()].find(m => m.is_final).data.title === "Finale", "one finale");
  const c2m = s.missions.find(m => m.title === "Crit Two");
  ok(c2m && c2m.locked === "Requires 2 captains — 1 present", "gated mission locked: " + (c2m && c2m.locked));
  ok(s.missions[0].on_abandon === undefined, "on_abandon hidden");
  ok(s.ship.bonus_pool === 2, "bonus pool floor(PM/4): " + s.ship.bonus_pool);
  ok(s.ship.registry === "CR-7001" && s.safety === null && s.hold === null, "ship in the setting's form; nothing on hold");
  A({ action_class: "information", tier: 0, officer: "computer", attribute: "none" });
  [s0, d] = await api("POST", `/game/${T}/command`, { text: "Computer, status" }, h1);
  ok(s0 === 409 && d.code === "gd_bonus", "bonus ship points must be placed before the first order");
  M.A = [];
  [s0, d] = await api("POST", `/game/${T}/allocate`, { alloc: { speed: 2 } }, h1);
  ok(s0 === 200, "allocate");
  await api("POST", `/game/${T}/allocate`, { alloc: { speed: 2 } }, h2);
  [s0, d] = await api("GET", `/game/${T}/map`, {}, h1);
  ok(d.size === 8 && d.sectors.length > 100, "map");

  s = await st(T, h1);
  let s2 = await st(T, h2);
  ok(s.stage === null && s.turn.of === c1 && s.turn.mine && !s2.turn.mine && s2.turn.of === c1 && s2.turn.name === "Rhea" && s.turn.points === 20 && s2.turn.points === 20 && s.turn.points_max === 20, "the game opens on Player One's turn, with 20 turn points: " + JSON.stringify(s.turn));
  ok(s.turn.seconds_left > 170 && s.turn.seconds_left <= 180 && s2.turn.seconds_left === s.turn.seconds_left && said(s2, "It is Rhea's turn."), "with two captains the turn is timed and announced: " + s.turn.seconds_left);
  const brief = (await st(T, h1, 0)).events.find(e => e.type === "notice" && e.say);
  ok(brief && brief.speaker === "Concord Fleet Command" && brief.text === "Brief for all captains." && brief.voice === s.computer.voice && brief.voice !== "", "the opening orders, from Concord Fleet Command, read in the Computer's voice");

  A({ action_class: "information", tier: 0, officer: "computer", attribute: "none" });
  [s0, d] = await cmd(T, h1, "Computer, status");
  ok(s0 === 200, "tier 0 " + JSON.stringify(d));
  s = await st(T, h1);
  let ev = lastTurn(W, T);
  ok(s.stage && s.stage.mission === "Crit One" && s.stage.points === 20 && s.turn.points === 20 && ev.cost === 0 && s.turn.mine, "stage started with 20 points by the first order of the turn; a free order spends none");
  ok(began(W, T, /^MISSION BEGINS: "Crit One"/), "the mission's beginning is logged as the turn opens");
  A({ intent: "accept_mission", tier: 1, action_class: "other" });
  [s0, d] = await cmd(T, h1, "We accept Crit One");
  s = await st(T, h1);
  ev = lastTurn(W, T);
  ok(s0 === 200 && ev.refused && s.stage.mission === "Crit One" && s.stage.points === 20, "an accept order changes nothing: the mission began on arrival");
  A({ action_class: "alert_yellow", tier: 1, officer: "tactical", attribute: "none" });
  await cmd(T, h1, "Yellow alert");
  s = await st(T, h1);
  ok(s.stage.points === 19, "yellow alert costs 1: " + s.stage.points);
  ok(s.ship.alert === "yellow" && s.ship.shields_up, "shields up");
  ok(s.tactical.threat !== null, "threat declared");
  A({ action_class: "advice", tier: 1, officer: "first_officer", attribute: "diplomacy" });
  await cmd(T, h1, "Number One, advice?");
  s = await st(T, h1);
  ok(s.stage.points === 16, "advice costs 3: " + s.stage.points);
  A({ action_class: "scan", tier: 2, responds_to_threat: false });
  await cmd(T, h1, "Scan the cutter");
  ev = lastTurn(W, T);
  ok(ev.resolve.band === "desperate" && ev.resolve.dc === 22, "ignoring threat = desperate DC 22: " + JSON.stringify(ev.resolve));
  ok(ev.roll_source === "system" && ev.roll.seed.length === 32, "seed logged");
  ok(Engine.d20FromSeed(ev.roll.seed) === ev.roll.value, "roll recomputable from seed");
  s = await st(T, h1);
  ok(s.stage.points === 14, "scan costs 2: " + s.stage.points);
  ok(s.tactical.threat === null, "threat resolved");
  // a threat cannot be stalled: the second no-roll order lets it partly succeed (state restored afterwards)
  const tg = gidOf(W, T);
  const snapG = Game.get(W, tg), snapC = Game.captains(W, tg);
  const g2 = Game.get(W, tg);
  for (const pp of Object.values(g2.parties)) if (pp.stage) pp.stage.threat = { description: "torpedoes inbound", after_turns: 0, active: true, stalled: 1 };
  Game.save(W, g2);
  const hull0 = (await st(T, h1)).ship.hull;
  A({ action_class: "alert_red", tier: 1, responds_to_threat: false });
  const rr = await cmd(T, h1, "Red alert");
  s2 = await st(T, h1);
  if (process.env.DEBUG) console.log("RED", JSON.stringify(rr), JSON.stringify(lastTurn(W, T)).slice(0, 1500), JSON.stringify(s2.stage));
  ok(s2.tactical.threat === null && s2.ship.hull < hull0, "second no-roll order under threat: it partly succeeds and the hull pays: " + hull0 + " -> " + s2.ship.hull);
  Game.save(W, snapG);
  for (const c0 of snapC.values()) Game.saveCaptain(W, c0);
  ok(s.tactical.contacts[0].name === "Veil cutter Tal" && s.tactical.contacts[0].posture === "Hostile", "contact identified + posture live");
  ok((s.diplomacy.channel?.with ?? "") === "Commander Velal", "channel shown");
  ok(s.diplomacy.agreements.length >= 1, "agreement recorded");
  ok(s.diplomacy.factions.some(f => f.name === "Seluun Veil"), "met faction shown");
  ok(!s.diplomacy.factions.some(f => f.name === "Drav Imperium"), "unmet faction hidden");
  ok((s.tactical.scan?.subject ?? "") === "Veil cutter Tal", "tactical scan stored");
  let turnsOnly = s.events.filter(e => e.type === "turn");
  let last = turnsOnly[turnsOnly.length - 1];
  const lnl = last.lines[last.lines.length - 1];
  ok(last.type === "turn" && lnl.speaker_type === "npc" && lnl.voice !== "", "attributed lines with voices");
  A({ impossible: true, impossible_reason: "no" });
  await cmd(T, h1, "Fire on Captain Ilo");
  s2 = await st(T, h1);
  ok(s2.stage.points === 14, "impossible is free");
  M.A = [{ junk: 1 }, { junk: 2 }];
  await cmd(T, h1, "Do something odd");
  ev = lastTurn(W, T);
  ok(ev.call_a.fallback && ev.call_a.tier === 2 && ev.resolve.band === "tricky", "fallback after two bad Call A replies");
  const before = await st(T, h1);
  A({ is_stage_climax: true, tier: 3 });
  await cmd(T, h1, "Do the thing");
  ev = lastTurn(W, T);
  ok(ev.resolve.dc === (before.stage.momentum <= 0 ? 18 : 14) - before.stage.momentum, "climax DC = band - momentum, one band harder when cold (" + before.stage.momentum + "): " + ev.resolve.dc);
  ok(ev.stage_result !== "", "stage result recorded");
  s = await st(T, h1);
  s2 = await st(T, h2);
  ok(s.turn.of === c2 && !s.turn.mine && s2.turn.mine && s2.stage === null && !s2.fleet.is_fleet && s2.turn.points === 20 && said(s, "It is Ilo's turn."), "resolving the main task ends the turn: " + JSON.stringify(s.turn));
  [s0, d] = await cmd(T, h1, "Scan again");
  ok(s0 === 409 && d.code === "gd_not_your_turn" && d.message.includes("It is Ilo's turn."), "an order from a captain who does not hold the turn is refused");
  [s0, d] = await pass(T, h2);
  s2 = await st(T, h2);
  s = await st(T, h1);
  const own2 = s2.stage?.mission ?? "";
  ok(s0 === 200 && s.turn.mine && !s2.turn.mine && said(s, "Ilo ends the turn.") && said(s2, "It is Rhea's turn."), "a captain may end the turn outside a fleet stage too");
  ok(s2.stage && own2 !== "Crit One" && s2.stage.points === 20, "the first order of Ilo's turn began a mission of his own: " + own2);
  ok(await logged(T, h2, 'MISSION BEGINS: \\"' + own2 + '\\"'), "a mission that begins on an order to end the turn is still logged");

  /* ---- the safety check: a flagged order, a flagged line ---- */
  s = await st(T, h1);
  const pts0 = s.stage ? s.stage.points : s.turn.points;
  SAFE.checked = [];
  const callsBefore = M.calls.length;
  let msgs;
  [s0, d, msgs] = await api("POST", `/game/${T}/command`, { text: "I want to hurt myself" }, Object.assign({ "X-GD-Live": "text" }, h1));
  ok(s0 === 200 && d.held && msgs.some(m => m.t === "safety" && m.kind === "order" && m.fromUser === true), "a flagged order: not carried out, and the captain is told on their stream");
  ok(M.calls.length === callsBefore, "a flagged order never reaches the model");
  s = await st(T, h1);
  s2 = await st(T, h2);
  ok(s.safety && s.safety.kind === "order" && s2.safety === null, "only the captain concerned sees the help screen");
  ok(s.hold && s.hold.captain === c1 && s2.hold && s2.hold.captain === c1 && s2.hold.name === "Rhea", "everyone sees whose turn is on hold, and nothing more");
  ok((s.stage ? s.stage.points : s.turn.points) === pts0, "a flagged order costs nothing");
  ok(!(await logged(T, h1, "hurt myself")) && !(await logged(T, h2, "hurt myself")) && !JSON.stringify(store.canon(tg, {})).includes("hurt myself") && !JSON.stringify(store.events(tg, { limit: 2000 })).includes("hurt myself"), "nothing about it is written to the log or canon");
  A({ action_class: "information", tier: 0 });
  [s0, d] = await cmd(T, h1, "Computer, status");
  ok(s0 === 409 && d.code === "gd_hold", "while on hold, the captain gives no orders");
  M.A = [];
  [s0, d] = await api("POST", `/game/${T}/safety`, { choice: "carry" }, Object.assign({ "X-GD-Live": "text" }, h1));
  s = await st(T, h1);
  ok(s0 === 200 && s.safety === null && s.hold === null && s.turn.mine, "carry on: it is the captain's turn again");
  // a flagged line: removed with everything after it, and the turn goes on without it
  M.B = [{ npcs: [], lines: [{ speaker_type: "computer", speaker_id: "computer", speaker_name: "x", line: "Hull holding." }, { speaker_type: "computer", speaker_id: "computer", speaker_name: "x", line: "FLAGGED-LINE do it." }, { speaker_type: "computer", speaker_id: "computer", speaker_name: "x", line: "After it." }], contacts: [{ name: "Ghost ship", kind: "ship", identified: true, faction: "orrin", posture: "Hostile", position: "aft", gone: false }], channel: null, scan: null, canon: [{ kind: "event", subject: "x", text: "A bulletin after the line.", faction: null }], items: [], resolved: [] }];
  A({ action_class: "information", tier: 0, officer: "computer", attribute: "none" });
  [s0, d, msgs] = await api("POST", `/game/${T}/command`, { text: "Computer, status" }, Object.assign({ "X-GD-Live": "text" }, h1));
  s = await st(T, h1);
  s2 = await st(T, h2);
  turnsOnly = s.events.filter(e => e.type === "turn");
  last = turnsOnly[turnsOnly.length - 1];
  ok(s0 === 200 && last.lines.map(l => l.line).join("|") === "Hull holding." && !last.awaiting_report && !s.narration_pending, "a flagged line is removed with what follows it; the report ends there: " + JSON.stringify(last.lines.map(l => l.line)));
  ok(msgs.some(m => m.t === "safety" && m.kind === "line") && msgs.filter(m => m.t === "txt").map(m => m.d).join("|") === "Hull holding.", "the stream shows the checked line only, and tells this captain");
  ok(!JSON.stringify(store.events(tg, { limit: 2000 })).includes("FLAGGED-LINE") && !JSON.stringify(store.canon(tg, {})).includes("A bulletin after the line") && !(s.tactical.contacts || []).some(c => c.name === "Ghost ship"), "nothing the reply said after the flagged line is kept");
  ok(s.safety && s.safety.kind === "line" && s2.safety === null && s2.hold.captain === c1, "the captain whose turn produced the line is on hold; the other sees only the hold");
  [s0, d] = await api("POST", `/game/${T}/safety`, { choice: "carry" }, h1);
  s = await st(T, h1);
  ok(s.safety === null && s.turn.mine, "carry on after a line: the turn goes on without it");
  // the check cannot run: the turn stops with the message
  SAFE.down = true;
  A({ action_class: "information", tier: 0 });
  [s0, d] = await cmd(T, h1, "Computer, status");
  SAFE.down = false;
  ok(s0 === 503 && d.code === "gd_safety_unchecked" && d.message === "The safety check could not run, so the turn has stopped.", "the safety check cannot run: the turn stops with its message");
  M.A = [];
  // a hold that outlasts the turn timer pauses the game for everyone, until that captain carries on
  [s0, d] = await api("POST", `/game/${T}/command`, { text: "I want to hurt myself" }, h1);
  let g = Game.get(W, tg);
  g.turn_clock.since -= 400;
  Game.save(W, g);
  s2 = await st(T, h2);
  ok(s2.pause && s2.pause.reason === "hold" && s2.pause.by === "Rhea" && s2.turn.of === c1, "a hold past the turn timer is the game's neutral pause: " + JSON.stringify(s2.pause));
  [s0, d] = await api("POST", `/game/${T}/pause`, { on: 0 }, h2);
  ok((await st(T, h2)).pause !== null, "only the captain on hold ends that pause");
  await api("POST", `/game/${T}/safety`, { choice: "carry" }, h1);
  s = await st(T, h1);
  ok(s.pause === null && s.hold === null && s.turn.mine, "carrying on ends the pause");

  /* ---- retreat warning ---- */
  s = await st(T, h1);
  if (s.stage) {
    A({ intent: "retreat" });
    await cmd(T, h1, "Get us out of here");
    s = await st(T, h1);
    ok((s.pending?.type ?? "") === "dialogue" && s.pending.message.includes("will hold: Crit One"), "leave warning reveals hold: " + (s.pending?.message ?? ""));
    [s0, d] = await cmd(T, h1, "x");
    ok(s0 === 409, "must answer dialogue first");
    const pts = s.stage.points;
    await api("POST", `/game/${T}/answer`, { choice: "stay" }, h1);
    s = await st(T, h1);
    ok(s.pending === null && s.stage && s.stage.points === pts, "stay costs nothing");
    A({ intent: "retreat" });
    await cmd(T, h1, "Retreat");
    [s0, d] = await api("POST", `/game/${T}/answer`, { choice: "leave" }, h1);
    ok(s0 === 200, "leave " + JSON.stringify(d));
    s = await st(T, h1);
    ok(s.stage === null && s.position !== M.start, "retreated to nearest sector: " + s.position);
    const m1 = s.missions.find(m => m.title === "Crit One");
    ok(m1 && m1.status === "suspended", "mission held");
    ok(s.turn.of === c2 && !s.turn.mine, "a retreat is the last act of a turn");
    await pass(T, h2);
    A({ intent: "travel", destination: M.start, action_class: "move", tier: 1 });
    [s0, d] = await cmd(T, h1, "Return");
    s = await st(T, h1);
    ok(s.stage && s.position === M.start && s.stage.momentum === 0, "returning resumes the stage, momentum reset " + JSON.stringify(d));
    ok(lastTurn(W, T).cost === 0 && s.turn.of === c2, "setting a course costs no turn points and ends the turn");
  }

  /* ---- fleet: P2 joins P1 ---- */
  await give(T, c2, { [c1]: h1, [c2]: h2 });
  A({ intent: "fleet_join", target_captains: [1], tier: 1 });
  [s0, d] = await cmd(T, h2, "Join Rhea");
  s = await st(T, h2);
  if ((s.pending?.type ?? "") === "dialogue") {
    ok(s.pending.message.includes("will hold: " + own2) && s.pending.message.includes("Accept the fleet request anyway?"), "joining a fleet from inside a stage warns: " + s.pending.message);
    [s0, d] = await api("POST", `/game/${T}/answer`, { choice: "accept" }, h2);
  }
  ok(s0 === 200, "fleet join " + JSON.stringify(d));
  s = await st(T, h2);
  ok(s.fleet.is_fleet && s.fleet.leader === c1 && s.position === M.start, "fleet formed around P1");
  ok(s.turn.of === c1 && !s.turn.mine, "joining a fleet takes the whole turn");
  let s1 = await st(T, h1);
  if (s1.stage) ok((s1.stage.fleet_points?.[c2] ?? 0) === 20, "joiner has own 20 points");
  if (s1.stage) {
    A({ intent: "retreat" });
    await cmd(T, h1, "Withdraw the fleet");
    await api("POST", `/game/${T}/answer`, { choice: "leave" }, h1);
  }
  s = await st(T, h1);
  s2 = await st(T, h2);
  ok(s.stage === null && s2.stage === null && s.position === s2.position && s.position !== M.start && s2.turn.mine, "the leader withdraws the fleet: both ships go, and the turn passes on");
  const from = s.position;
  const far = from.split(",").map((p, i) => (Number(p) >= Number(M.start.split(",")[i]) ? 7 : 0)).join(",");
  A({ intent: "travel", destination: far, action_class: "move", tier: 1 });
  [s0, d] = await cmd(T, h2, "go");
  ev = lastTurn(W, T);
  s2 = await st(T, h2);
  ok(s0 === 200 && ev.refused && s2.position === from && s2.turn.mine && s2.turn.points === 20, "only the fleet leader sets the course; refused costs nothing");
  await pass(T, h2);
  A({ intent: "travel", destination: far, action_class: "move", tier: 1 });
  await cmd(T, h1, `Set course for ${far}`);
  s = await st(T, h1);
  if ((s.pending?.type ?? "") === "dialogue") {
    ok(s.pending.message.includes("Go as far as possible"), "out-of-range dialogue");
    ok(s.turn.mine, "the turn waits for the answer");
    await api("POST", `/game/${T}/answer`, { choice: "go" }, h1);
    s = await st(T, h1);
    ok(s.position !== M.start && s.position !== from, "partial journey moved fleet: " + s.position);
    s2 = await st(T, h2);
    ok(s2.position === s.position, "fleet moves together");
  } else console.log("note: destination was in range");
  s = await st(T, h1);
  s2 = await st(T, h2);
  ok(s.position !== from && s.stage === null && !s.turn.mine && s2.turn.mine && s2.turn.points === 20, "travelling ends the turn");

  /* ---- pause and chat ---- */
  await api("POST", `/game/${T}/pause`, { on: 1 }, h2);
  s = await st(T, h1);
  ok((s.pause?.reason ?? "") === "manual" && s.pause.by === "Ilo", "paused by P2, seen by P1");
  [s0, d] = await cmd(T, h1, "x");
  ok(s0 === 409, "no turns while paused");
  await api("POST", `/game/${T}/pause`, { on: 0 }, h1);
  s = await st(T, h1);
  ok(s.pause === null, "any captain unpauses");
  const nCalls = M.calls.length;
  await api("POST", `/game/${T}/chat`, { text: "hello" }, h2);
  s = await st(T, h1);
  ok(s.chat.length === 1, "fleet chat");
  ok(M.calls.length === nCalls, "chat not sent to the model");

  /* ---- disconnect: pause, Player One decides, resume without them ---- */
  store.updateCaptain(tg, c2, { last_seen: require("../text.js").gmdate(Math.floor(Date.now() / 1000) - 3000) });
  s = await st(T, h1);
  ok((s.pause?.reason ?? "") === "disconnect" && JSON.stringify(s.pause.dropped) === '["Ilo"]' && s.pause.can_decide && s.pause.warning !== "", "drop pauses the game; Player One may decide");
  [s0, d] = await cmd(T, h1, "x");
  ok(s0 === 409, "no turns during a disconnect pause");
  await api("POST", `/game/${T}/decide`, { choice: "resume" }, h1);
  s = await st(T, h1);
  ok(s.pause === null, "resumed without the dropped captain");
  ok(Game.get(W, tg).dropped.includes(c2) && s.turn.of === c1 && s.turn.mine && s.turn.points === 20, "the dropped captain is passed over");
  let me = s.captains.find(c => c.id === c2);
  ok(me.connected === false && me.in_fleet, "dropped ship stays in the fleet, inactive");
  await st(T, h2);
  s = await st(T, h1);
  me = s.captains.find(c => c.id === c2);
  ok(me.connected === true, "rejoining restores the captain");

  /* ---- fleet leave, request, accept, arrival ---- */
  const adj = nb(s.position, [M.start]);
  await pass(T, h1);
  A({ intent: "fleet_leave", destination: adj, tier: 1 });
  await cmd(T, h2, "We leave the fleet for " + adj);
  s2 = await st(T, h2);
  ok(!s2.fleet.is_fleet && s2.position === adj, "leaver departs alone: " + s2.position);
  ok(s2.turn.of === c1, "leaving a fleet takes the whole turn");
  A({ intent: "fleet_request", target_captains: [2], tier: 1 });
  await cmd(T, h1, "Ask Ilo to join us");
  s2 = await st(T, h2);
  ok(s2.invites.length === 1 && s2.invites[0].from === "Rhea", "request visible to the invited captain");
  ok(s2.turn.mine, "asking takes the whole turn");
  A({ intent: "fleet_accept", tier: 1 });
  await cmd(T, h2, "Accept");
  s2 = await st(T, h2);
  ok(s2.joining && !s2.fleet.is_fleet && s2.turn.of === c1, "accepting takes the turn; not yet arrived");
  [s0, d] = await cmd(T, h2, "x");
  ok(s0 === 409, "no action while on the way");
  A({ action_class: "information", tier: 0, officer: "computer", attribute: "none" });
  await cmd(T, h1, "Computer, status");
  s2 = await st(T, h2);
  ok(s2.fleet.is_fleet && s2.fleet.leader === c1 && !s2.joining && s2.position === (await st(T, h1)).position, "arrives at the start of the requester's next turn");

  /* ---- items ---- */
  let caps = Game.captains(W, tg);
  const cc = caps.get(c1);
  cc.state.inventory = [];
  Game.addItem(cc.state, "medkit");
  Game.addItem(cc.state, "medkit");
  Game.addItem(cc.state, "targeting_module");
  Game.saveCaptain(W, cc);
  const c2row = caps.get(c2);
  c2row.state.inventory = [];
  Game.saveCaptain(W, c2row);
  s = await st(T, h1);
  ok(s.inventory.length === 2 && s.inventory[0].qty === 2 && s.ship.cargo_used === 2, "consumables stack in one slot");
  const tac = s.ship.attrs.find(a => a.key === "tactical");
  ok(tac.items === 3 && tac.value === 21, "equipment raises the ship attribute while held");
  A({ intent: "transfer_item", item: "targeting_module", target_captains: [2], tier: 1 });
  await cmd(T, h1, "Send the targeting module to Ilo");
  s = await st(T, h1);
  s2 = await st(T, h2);
  ok(s.inventory.length === 1 && s2.inventory.length === 1 && s2.inventory[0].name === "Targeting module", "equipment transferred within the fleet");
  A({ intent: "request_item", item: "targeting_module", target_captains: [2], tier: 1 });
  await cmd(T, h1, "Ask for it back");
  s2 = await st(T, h2);
  ok((s2.pending?.type ?? "") === "dialogue" && s2.pending.title === "Transfer request", "item request arrives as a dialogue");
  await api("POST", `/game/${T}/answer`, { choice: "decline" }, h2);
  s2 = await st(T, h2);
  ok(s2.pending === null && s2.inventory.length === 1, "a transfer request can be declined at no cost");
  const hurtN = (await st(T, h1)).crew.filter(o => o.injury).length;
  A({ intent: "use_item", item: "medkit", tier: 1 });
  await cmd(T, h1, "Use a medkit");
  s = await st(T, h1);
  ok(hurtN ? true : s.inventory[0].qty === 2, "a medkit is not wasted when nobody is injured");

  /* ---- held work: no stand-in narration, recovery stage or bridge mission ---- */
  M.FAIL = { call_b: true };
  A({ action_class: "information", tier: 0, officer: "computer", attribute: "none" });
  [s0, d] = await cmd(T, h1, "Computer, report");
  ok(s0 === 200, "turn resolves even when narration fails");
  s = await st(T, h1);
  last = s.events[s.events.length - 1];
  ok(s.narration_pending && last.type === "turn" && last.lines.length === 0 && last.awaiting_report, "no stand-in line: the report is held");
  ok(s.work === true, "the page is told there is held work");
  [s0, d] = await cmd(T, h1, "x");
  ok(s0 === 409 && d.code === "gd_narration", "captain waits for the report");
  await age(W, tg);
  await work(T, h1);
  s = await st(T, h1);
  ok(s.narration_pending, "still held while the call keeps failing");
  M.FAIL = {};
  await age(W, tg);
  await work(T, h1);
  s = await st(T, h1);
  last = s.events[s.events.length - 1];
  ok(!s.narration_pending && last.type === "turn" && last.lines.length > 0 && !last.awaiting_report, "the real report arrives on a later request for held work");
  const allEv = (await st(T, h1, 0)).events;
  ok(allEv.filter(e => e.type === "narration" && (e.lines[0]?.speaker_type ?? "") !== "computer").length === 0, "on reload the report sits on its turn, not twice");
  // recovery stage held
  const gpos = Game.get(W, tg);
  const pid1 = Game.captains(W, tg).get(c1).state.party;
  let side = [...Game.missions(W, tg).values()].find(m => m.data.title === "Side A");
  side.sector = gpos.parties[pid1].position;
  Game.saveMission(W, side);
  const HT = { [c1]: h1, [c2]: h2 };
  await give(T, c2, HT);
  A({ action_class: "information", tier: 0, officer: "computer", attribute: "none" });
  await cmd(T, h2, "Computer, status");
  s2 = await st(T, h2);
  ok(s2.stage === null && s2.turn.mine, "the fleet leader, not a member, brings the fleet into a mission");
  await give(T, c1, HT);
  A({ action_class: "information", tier: 0, officer: "computer", attribute: "none" });
  await cmd(T, h1, "Computer, status");
  s = await st(T, h1);
  ok(s.stage && s.stage.mission === "Side A" && s.stage.points === 20, "side mission started");
  M.FAIL = { bridge: "recovery" };
  let tries = 0;
  do {
    g = Game.get(W, tg);
    g.parties[pid1].stage.momentum = -3;
    g.parties[pid1].stage.def.climax_band = "desperate";
    g.parties[pid1].stage.points[c1] = 20;
    g.turn_of = c1;
    Game.save(W, g);
    A({ is_stage_climax: true, tier: 3, attribute: "composure", officer: "engineer", difficulty_band: "desperate" });
    await cmd(T, h1, "Attempt the climax");
    s = await st(T, h1);
    tries++;
  } while (s.stage && tries < 12);
  let m = s.missions.find(x => x.title === "Side A");
  if (m.status === "completed") console.log("note: climax succeeded against the odds; recovery path not exercised this run");
  else {
    ok(s.stage === null && m.recovery_pending, "failed stage with no recovery stage available: mission held, no stock stage");
    M.FAIL = {};
    await age(W, tg);
    await work(T, h1);
    s = await st(T, h1);
    ok(s.stage && s.stage.recovery && s.stage.title === "Recovery", "the real recovery stage begins once it is written");
  }
  // bridge held: fail a critical mission with the bridge call down
  M.FAIL = { bridge: "bridge" };
  g = Game.get(W, tg);
  g.parties[pid1].stage = null;
  Game.save(W, g);
  for (const mm of Game.missions(W, tg).values()) if (mm.data.title === "Side A" && mm.status !== "completed") { mm.status = "failed"; Game.saveMission(W, mm); }
  for (const mm of Game.missions(W, tg).values()) if (mm.data.title === "Crit Two") { mm.sector = g.parties[pid1].position; mm.status = "available"; Game.saveMission(W, mm); }
  await give(T, c2, HT);
  await give(T, c1, HT);
  A({ action_class: "information", tier: 0, officer: "computer", attribute: "none" });
  await cmd(T, h1, "Computer, status");
  s = await st(T, h1);
  ok(s.stage && s.stage.mission === "Crit Two", "gated critical mission started by the fleet: " + JSON.stringify(s.stage?.mission ?? null));
  ok(began(W, T, /MISSION BEGINS: "Crit Two"/) && s.stage.points === 20 && (s.stage.fleet_points?.[c2] ?? 0) === 20, "every member has 20 points for the stage");
  A({ intent: "retreat" });
  await cmd(T, h1, "Retreat");
  s = await st(T, h1);
  ok((s.pending?.message ?? "").includes("will fail: Crit Two"), "warning reveals that leaving fails this mission");
  await api("POST", `/game/${T}/answer`, { choice: "leave" }, h1);
  s = await st(T, h1);
  m = s.missions.find(x => x.title === "Crit Two");
  ok(m.status === "failed" && m.orders_pending, "the failure stays canon; new orders are pending");
  const fin = [...Game.missions(W, tg).values()].find(x => x.is_final);
  ok(fin.status === "available" && !s.missions.some(x => x.final), "the finale is still to come, and not shown ahead of time");
  M.FAIL = {};
  await age(W, tg);
  await work(T, h1);
  s = await st(T, h1);
  const b = [...Game.missions(W, tg).values()].filter(x => x.data.title === "Bridge Mission");
  m = s.missions.find(x => x.title === "Crit Two");
  ok(b.length === 1 && b[0].is_critical && !m.orders_pending, "the bridge mission arrives once the call succeeds");
  const everything = await st(T, h1, 0);
  const says = everything.events.filter(e => e.type === "notice" && e.say);
  ok(b[0].sector === s.position || s.leads.some(l => l.sector === b[0].sector), "new orders come with a lead to where they are");
  ok(says.length >= 2 && says[0].speaker === "Concord Fleet Command" && says[1].text.startsWith("New lead logged. Lead to "), "the opening orders and each new lead are read out by the Computer");
  ok(!s.missions.some(x => !x.mine && x.sector !== s.position) && typeof everything.computer.voice === "string" && everything.computer.voice !== "", "no mission listed that the captain has not come to; the Computer has a voice");
  const games = (await api("GET", "/games", {}, OWNER))[1].games;
  ok(games.some(x => x.token === T && x.title === "The Quiet Border" && x.preset === "Skirmish"), "Player One's campaigns are listed for reopening");

  await threeCaptains(W, store, ids, tk);
  await physical(W, store, ids);
  await alone(W, store, ids);
}

/* ---- a fresh three-captain game ---- */
async function threeCaptains(W, store, ids, tkOld) {
  let [s0, d] = await api("POST", "/game", { preset: "skirmish", dice: "system", captains: 3, join_code: "1234" }, OWNER);
  const N = d.token;
  [s0, d] = await api("POST", `/game/${N}/join`, { name: "Ana", build_id: ids[0], device: "n1" }, OWNER);
  const ha = capH(d.token), ca = d.captain;
  const tk = { "X-GD-Ticket": (await api("POST", `/game/${N}/unlock`, { code: "1234" }))[1].ticket };
  ok((await api("GET", `/game/${N}/builds`, {}, tkOld))[0] === 403, "a ticket is for the game it was given for");
  [s0, d] = await api("POST", `/game/${N}/join`, { name: "Ben", build_id: ids[1], device: "n2" }, tk);
  const hb = capH(d.token), cb = d.captain;
  [s0, d] = await api("POST", `/game/${N}/join`, { name: "Cyd", build_id: ids[2], device: "n3" }, tk);
  const hc = capH(d.token), ccid = d.captain;
  await api("POST", `/game/${N}/start`, {}, OWNER);
  for (let i = 0; i < 3; i++) await api("POST", `/game/${N}/generate`, {}, OWNER);
  const nid = gidOf(W, N);
  for (const h of [ha, hb, hc]) await api("POST", `/game/${N}/allocate`, { alloc: { speed: 2 } }, h);
  const setstage = (cid, fn) => { const g = Game.get(W, nid); const pid = Game.captains(W, nid).get(cid).state.party; g.parties[pid].stage = fn(g.parties[pid].stage); Game.save(W, g); };
  A({ action_class: "information", tier: 0, officer: "computer", attribute: "none" });
  await cmd(N, ha, "Computer, status");
  let s = await st(N, ha);
  ok(s.stage && s.stage.mission === "Crit One" && s.stage.points === 20 && s.turn.mine, "Ana starts Crit One");
  M.DOWN = true;
  [s0, d] = await cmd(N, ha, "Scan the area");
  M.DOWN = false;
  s = await st(N, ha);
  ok(s0 === 503 && d.code === "gd_llm_down" && s.stage.points === 20 && !s.narration_pending && s.turn.mine, "engine unreachable: 503, nothing charged, the turn is not lost");
  await pass(N, ha);
  A({ intent: "fleet_join", target_captains: [1], tier: 1 });
  [s0, d] = await cmd(N, hb, "Join Ana");
  let sb = await st(N, hb);
  const ownb = sb.stage?.mission ?? "";
  if ((sb.pending?.type ?? "") === "dialogue") [s0, d] = await api("POST", `/game/${N}/answer`, { choice: "accept" }, hb);
  ok(s0 === 200, "Ben joins mid-stage " + JSON.stringify(d));
  sb = await st(N, hb);
  s = await st(N, ha);
  let sc = await st(N, hc);
  ok(sb.benched && sb.fleet.is_fleet && !s.turn.mine && !sb.turn.mine && sc.turn.mine && s.turn.of === ccid, "joiner sits out; the turn passes to the next captain");
  [s0, d] = await cmd(N, hb, "Scan");
  ok(s0 === 409 && d.code === "gd_next_round", "benched captain cannot act this round");
  [s0, d] = await cmd(N, ha, "Scan");
  ok(s0 === 409 && d.code === "gd_not_your_turn", "nor can the host: it is the third captain's turn");
  await pass(N, hc);
  sc = await st(N, hc);
  const ownc = sc.stage?.mission ?? "";
  ok(sc.stage && !["Crit One", ownb].includes(ownc) && sc.stage.points === 20, "Cyd takes a different mission: " + ownc);
  s = await st(N, ha);
  sb = await st(N, hb);
  ok(s.turn.mine && !sb.benched, "a new round: the joiner is no longer sitting out");
  A({ action_class: "alert_yellow", tier: 1, officer: "tactical", attribute: "none" });
  await cmd(N, ha, "Yellow alert");
  s = await st(N, ha);
  ok(s.stage.points === 19 && s.turn.mine, "an order that leaves points does not end the turn");
  await pass(N, ha);
  sb = await st(N, hb);
  ok(!sb.benched && sb.turn.mine && sb.stage.points === 20 && sb.turn.points === 20, "next round: the joiner plays with their own 20 points");
  ok(sb.turn.seconds_left > 170 && sb.turn.seconds_left <= 180, "the captain on turn sees the turn timer: " + sb.turn.seconds_left);
  let g = Game.get(W, nid);
  g.turn_clock.since -= 200;
  Game.save(W, g);
  s = await st(N, ha);
  sb = await st(N, hb);
  sc = await st(N, hc);
  ok(sc.turn.mine && !sb.turn.mine && !s.turn.mine && sb.stage.points === 20 && sc.turn.seconds_left > 170 && said(s, "Ben gave no order in time, so the turn passes."), "timer ran out: the turn passes, no points spent");
  await pass(N, hc);
  A({ intent: "pass", tier: 2 });
  [s0, d] = await cmd(N, ha, "Pass");
  sb = await st(N, hb);
  s = await st(N, ha);
  ok(s0 === 200 && sb.turn.mine && s.stage.points === 19, "a captain may pass the turn at no cost");
  setstage(ca, stg => { stg.points[cb] = 2; stg.threat = "done"; return stg; });
  A({ action_class: "scan", tier: 2 });
  await cmd(N, hb, "Scan the area");
  sb = await st(N, hb);
  sc = await st(N, hc);
  ok(sb.stage.points === 0 && !sb.turn.mine && sc.turn.mine && !sb.stage.forced, "spending the last stage points ends the turn while another member has points");
  await pass(N, hc);
  await pass(N, ha);
  s = await st(N, ha);
  sb = await st(N, hb);
  ok(s.turn.of === ccid && !sb.turn.mine && !s.stage.forced, "member with 0 points is skipped");
  await pass(N, hc);
  // the Computer puts a costed order to the captain first
  M.ASK = true;
  const p0 = (await st(N, ha)).stage.points;
  A({ action_class: "scan", tier: 2 });
  [s0, d] = await cmd(N, ha, "Scan the area");
  s = await st(N, ha);
  const sd = s.events[s.events.length - 1];
  ok(s0 === 200 && d.confirm && s.pending.type === "dialogue" && s.stage.points === p0, "a costed order stops for the Computer, nothing spent yet");
  ok(sd.type === "narration" && sd.lines[0].speaker_type === "computer" && sd.lines[0].line.includes("It will use 2 of your") && sd.lines[0].line.includes("The die must show") && sd.lines[0].line.includes("Proceed?") && !/[+\-]\d/.test(sd.lines[0].line) && sd.lines[0].voice !== "", "the Computer states the cost and the number to beat: " + sd.lines[0].line);
  [s0, d] = await cmd(N, ha, "Belay that");
  s = await st(N, ha);
  ok(s0 === 200 && !s.pending && s.stage.points === p0 && s.turn.mine, "belay: nothing spent");
  A({ action_class: "scan", tier: 2 });
  await cmd(N, ha, "Scan the area");
  A({ action_class: "information", tier: 0 });
  [s0, d] = await cmd(N, ha, "Computer, hull status");
  s = await st(N, ha);
  ok(s0 === 200 && !s.pending && s.stage.points === p0, "a different order replaces the question");
  A({ action_class: "scan", tier: 2 });
  await cmd(N, ha, "Scan the area");
  [s0, d] = await cmd(N, ha, "Make it so.");
  s = await st(N, ha);
  ok(s0 === 200 && !s.pending && s.stage.points === p0 - 2, "answering in words carries the order out");
  M.ASK = false;
  // streamed narration: a line that cannot be used stops the reply there; the model finishes from that point
  const ln = (id, text) => ({ speaker_type: id === "computer" ? "computer" : "officer", speaker_id: id, speaker_name: "x", line: text });
  M.B = [{ npcs: [], lines: [ln("computer", "One."), ln("computer", ""), ln("computer", "Nor this.")] }, { npcs: [], lines: [ln("computer", "Two.")] }];
  M.Buser = [];
  A({ action_class: "information", tier: 0 });
  let msgs;
  [s0, d, msgs] = await api("POST", `/game/${N}/command`, { text: "Computer, status" }, Object.assign({ "X-GD-Live": "text" }, ha));
  s = await st(N, ha);
  let turns = s.events.filter(e => e.type === "turn");
  let last = turns[turns.length - 1];
  ok(last.lines.map(l => l.line).join("|") === "One.|Two." && !s.narration_pending, "a bad line stops the reply; the report is finished from there: " + JSON.stringify(last.lines.map(l => l.line)));
  ok(!M.Buser[0].includes("ALREADY SHOWN") && M.Buser[1].includes("ALREADY SHOWN TO THE PLAYERS") && M.Buser[1].includes("- Computer: One."), "the second request tells the model what is already on screen");
  const lineMsgs = msgs.filter(m => m.t === "line");
  ok(msgs[0].t === "pad" && msgs.some(m => m.t === "sync" && m.events.length === 1) && lineMsgs.length === 2 && lineMsgs[0].ref === last.id && lineMsgs[0].voice !== "" && msgs.filter(m => m.t === "end").every(m => m.id > 0), "the streamed reply: pad, sync, then each line whole with its voice");
  M.B = [{ npcs: [], lines: [ln("computer", "Alpha."), ln("computer", "")] }, { garbage: true }];
  A({ action_class: "information", tier: 0 });
  await cmd(N, ha, "Computer, status again");
  s = await st(N, ha);
  turns = s.events.filter(e => e.type === "turn");
  last = turns[turns.length - 1];
  ok(s.narration_pending && last.lines.map(l => l.line).join("|") === "Alpha." && last.awaiting_report, "unfinished report: what was said is shown, the rest is held");
  M.B = [{ npcs: [], lines: [ln("computer", "Omega.")] }];
  await age(W, nid);
  await work(N, ha);
  s = await st(N, ha);
  turns = s.events.filter(e => e.type === "turn");
  last = turns[turns.length - 1];
  ok(!s.narration_pending && last.lines.map(l => l.line).join("|") === "Alpha.|Omega.", "the held report is continued, not restarted: " + JSON.stringify(last.lines.map(l => l.line)));
  M.B = [];
  const eng = Game.captains(W, nid).get(ca).state.crew.engineer.name;
  M.Buser = [];
  M.B = [{ npcs: [], lines: [ln("computer", "Hull at one hundred per cent.")] }, { npcs: [], lines: [ln("engineer", "All systems sound, Captain."), ln("computer", "Confirmed.")] }];
  A({ action_class: "information", tier: 0 });
  await cmd(N, ha, "Engineer, what is our status?");
  s = await st(N, ha);
  turns = s.events.filter(e => e.type === "turn");
  last = turns[turns.length - 1];
  ok(last.lines[0].speaker_name === eng && last.lines.length === 1 && !s.narration_pending, "the officer addressed answers; the Computer, not addressed, is left out: " + JSON.stringify(last.lines.map(l => l.speaker_name)));
  ok(M.Buser[0].includes(`SPOKEN TO: the captain addressed ${eng} directly`) && M.Buser[0].includes(`${eng} answers factually`), "the narrator is told who was spoken to");
  M.B = [];
}

/* ---- physical dice ---- */
async function physical(W, store, ids) {
  let [s0, d] = await api("POST", "/game", { preset: "skirmish", dice: "physical", captains: 1, join_code: "5555" }, OWNER);
  const P = d.token;
  [s0, d] = await api("POST", `/game/${P}/join`, { name: "Wren", build_id: ids[2], device: "devA" }, OWNER);
  const h3 = capH(d.token);
  ok(s0 === 200, "solo join " + JSON.stringify(d));
  await api("POST", `/game/${P}/start`, {}, OWNER);
  for (let i = 0; i < 3; i++) await api("POST", `/game/${P}/generate`, {}, OWNER);
  await api("POST", `/game/${P}/allocate`, { alloc: { speed: 2 } }, h3);
  let s = await st(P, h3);
  ok(s.stage === null && s.turn.mine && s.turn.points === 20 && s.turn.seconds_left === null, "a captain alone holds the turn, untimed");
  A({ action_class: "scan", tier: 2 });
  [s0, d] = await cmd(P, h3, "Scan");
  ok(d && d.awaiting_roll, "physical: awaiting roll");
  s = await st(P, h3);
  ok(s.pending.type === "roll" && (s.stage?.mission ?? "") === "Crit One" && s.stage.points === 18 && s.turn.points === 18 && s.pending.seconds_left > 90 && s.pending.preview.needed === 8 && s.pending.preview.modifier === undefined, "awaiting-roll readout: " + JSON.stringify(s.pending));
  [s0, d] = await api("POST", `/game/${P}/roll`, { value: "21" }, h3);
  ok(s0 === 400, "21 rejected");
  [s0, d] = await api("POST", `/game/${P}/roll`, { value: "15" }, h3);
  ok(s0 === 200, "roll accepted " + JSON.stringify(d));
  let ev = lastTurn(W, P);
  ok(ev.roll_source === "manual" && ev.roll.seed === null && ev.roll.value === 15 && ev.resolve.outcome === "critical_success", "manual roll logged, 15+5 vs 14 = crit");
  s = await st(P, h3);
  ok(s.stage.momentum === 2, "crit gives +2 momentum");
  A({ action_class: "scan", tier: 2 });
  await cmd(P, h3, "Scan again");
  await api("POST", `/game/${P}/roll`, { value: 20 }, h3);
  s = await st(P, h3);
  ok(s.stage.momentum === 3, "second scan grants no momentum itself; +1 from the threat failing completely: " + s.stage.momentum);
  A({ action_class: "hail", tier: 2, officer: "first_officer", attribute: "diplomacy", target_faction: "seluun" });
  await cmd(P, h3, "Hail them");
  const gid = gidOf(W, P);
  const c = [...Game.captains(W, gid).values()][0];
  c.state.pending.deadline = Math.floor(Date.now() / 1000) - 1;
  Game.saveCaptain(W, c);
  s = await st(P, h3);
  ok(s.pending === null, "timeout resolved by the server");
  ev = lastTurn(W, P);
  ok(ev.roll_source === "system_timeout" && ev.notes.length > 0, "roll_source system_timeout, and the log says so");
}

/* ---- a captain alone (§14.7) ---- */
async function alone(W, store, ids) {
  let [s0, d] = await api("POST", "/game", { preset: "skirmish", dice: "system", captains: 1, join_code: "7777" }, OWNER);
  const S = d.token;
  [s0, d] = await api("POST", `/game/${S}/join`, { name: "Kade", build_id: ids[0], device: "s1" }, OWNER);
  const hk = capH(d.token), ck = d.captain;
  await api("POST", `/game/${S}/start`, {}, OWNER);
  for (let i = 0; i < 3; i++) await api("POST", `/game/${S}/generate`, {}, OWNER);
  await api("POST", `/game/${S}/allocate`, { alloc: { speed: 2 } }, hk);
  const sid = gidOf(W, S);
  const home = M.start;
  const X = nb(home);
  for (const m of Game.missions(W, sid).values()) { m.sector = X; Game.saveMission(W, m); } // open space around the ship
  let s = await st(S, hk);
  ok(s.turn.mine && s.turn.of === ck && s.turn.points === 20 && s.turn.seconds_left === null && s.stage === null, "alone: the turn is this captain's, with 20 points and no timer");
  const scan = { action_class: "scan", tier: 2 };
  A({ action_class: "alert_red", tier: 1, officer: "tactical", attribute: "none" });
  await cmd(S, hk, "Red alert");
  const seen = [(await st(S, hk)).turn.points];
  for (let i = 0; i < 8; i++) {
    A(scan);
    await cmd(S, hk, "Scan the area");
    seen.push((await st(S, hk)).turn.points);
  }
  ok(JSON.stringify(seen) === "[18,16,14,12,10,8,6,4,2]", "each order takes its cost from the turn's points: " + JSON.stringify(seen));
  A(scan);
  await cmd(S, hk, "Scan the area");
  s = await st(S, hk);
  ok(s.turn.points === 20 && s.turn.mine && s.stage === null && lastTurn(W, S).cost === 2, "a captain alone who uses the points up has 20 again at once");
  [s0, d] = await pass(S, hk);
  s = await st(S, hk);
  ok(s0 === 200 && s.turn.points === 20 && s.turn.mine && said(s, "Kade ends the turn."), "ending the turn alone: the next begins at once");
  ok(!(await logged(S, hk, "It is Kade's turn.")), "a captain alone is not told whose turn it is");
  const g = Game.get(W, sid);
  g.turn_clock = { cid: ck, since: Math.floor(Date.now() / 1000) - 5000 };
  Game.save(W, g);
  await st(S, hk);
  s = await st(S, hk);
  ok(s.turn.mine && s.turn.seconds_left === null && !(await logged(S, hk, "gave no order in time")), "with one captain the turn never passes for want of an order");
  // alone, a hold has no timer: the game simply waits
  await api("POST", `/game/${S}/command`, { text: "I really want to hurt myself" }, hk);
  const g2 = Game.get(W, sid);
  g2.turn_clock.since -= 5000;
  Game.save(W, g2);
  s = await st(S, hk);
  ok(s.safety && s.pause === null, "alone, a hold never becomes a pause: the game waits");
  await api("POST", `/game/${S}/safety`, { choice: "carry" }, hk);
  const Y = nb(home, [X]);
  A({ intent: "travel", destination: Y, action_class: "move", tier: 1 });
  await cmd(S, hk, `Set course for ${Y}`);
  s = await st(S, hk);
  ok(s.position === Y && s.stage === null && s.turn.points === 20 && s.turn.mine, "alone, travelling ends the turn and the next begins at once");
}

/* Live updates: every client of a game hears of a change; the safety check's message reaches only that captain. */
test("server-sent events: changes for all, the safety message for one", { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gd-sse-"));
  const srv = createServer({ dataDir: dir, llm: { chat, chatStream }, voices: VOICES, safety, settings: { model: "test-model", heartbeat_timeout: 300 }, port: 0, host: "127.0.0.1", isOwner: req => req.headers["x-test-owner"] === "1" });
  const { port } = await srv.listen();
  base = "http://127.0.0.1:" + port;
  try {
    let [, d] = await api("POST", "/creator/builds", { ship: { name: "CSV Echo", class: "Harrow class", registry: "CR-9", attrs: { tactical: 18, defense: 17, speed: 20, manoeuvrability: 13, sensors: 17, hull_integrity: 15 } }, crew: crew("Echo") }, OWNER);
    const b1 = d.id;
    [, d] = await api("POST", "/creator/builds", { ship: { name: "CSV Foxtrot", class: "Harrow class", registry: "CR-8", attrs: { tactical: 18, defense: 17, speed: 20, manoeuvrability: 13, sensors: 17, hull_integrity: 15 } }, crew: crew("Fox") }, OWNER);
    const b2 = d.id;
    [, d] = await api("POST", "/game", { preset: "skirmish", dice: "system", captains: 2, join_code: "2468" }, OWNER);
    const T = d.token;
    [, d] = await api("POST", `/game/${T}/join`, { name: "Ora", build_id: b1, device: "a" }, OWNER);
    const h1 = capH(d.token);
    [, d] = await api("POST", `/game/${T}/join`, { name: "Pell", build_id: b2, device: "b" }, OWNER);
    const h2 = capH(d.token);
    await api("POST", `/game/${T}/start`, {}, OWNER);
    for (let i = 0; i < 3; i++) await api("POST", `/game/${T}/generate`, {}, OWNER);
    for (const h of [h1, h2]) await api("POST", `/game/${T}/allocate`, { alloc: { speed: 2 } }, h);
    const listen = h => {
      const ctl = new AbortController();
      const got = { text: "" };
      got.ready = fetch(base + `/game/${T}/stream`, { headers: h, signal: ctl.signal }).then(async r => {
        got.type = r.headers.get("content-type");
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const x = await reader.read().catch(() => ({ done: true }));
          if (x.done) break;
          got.text += dec.decode(x.value);
        }
      });
      got.stop = () => ctl.abort();
      return got;
    };
    const one = listen(h1), two = listen(h2);
    await new Promise(r => setTimeout(r, 1300));
    await api("POST", `/game/${T}/command`, { text: "I want to hurt myself" }, h1);
    await new Promise(r => setTimeout(r, 2300));
    one.stop();
    two.stop();
    assert.match(one.type, /text\/event-stream/);
    assert.ok(one.text.includes("data: change") && two.text.includes("data: change"), "both captains hear that the game changed");
    assert.ok(one.text.includes("event: safety") && /"kind":"order"/.test(one.text), "the captain concerned is told privately");
    assert.ok(!two.text.includes("safety") && !two.text.includes("hurt"), "the other captain is not");
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
