"use strict";
/* Galactic Dominion: a stand-in game server for working on the interface while the real one (game/server.js) is being
   ported. Plain Node, no dependencies. It serves the routes and JSON shapes the interface uses, with fixed sample data
   for every screen and a scripted streamed turn, and serves the interface itself over http with a stand-in for the
   app's window.api (speech out, speech in, settings, country, hosting), since a plain browser has no Electron preload.

   node renderer/game/mock-server.js [--port 47800]          then open http://127.0.0.1:47800/renderer/game.html
   node renderer/game/mock-server.js --shots <folder>        also takes screenshots of every screen with Playwright

   Scenes (POST /__mock/scene {"name": ...}, or ?scene= on the page address): connect, setup, lobby, generating,
   seat, bridge (the default), confirm, roll, paused, disconnect, hold-other, hold-pause, safety, explore, ended.
   In the bridge scene, an order is answered with the Computer's "Proceed?"; "yes" or Proceed then plays a system
   roll and a streamed report; an order containing "hurt myself" is flagged by the safety check. */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");      // roleplayer/: game.html loads ../built-in.js and ../helplines.js
const args = process.argv.slice(2);
const PORT = +(args[args.indexOf("--port") + 1] || 0) || 47800;
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const CAPTAIN_TOKENS = { 1: "tok-rhea-0001", 2: "tok-okono-0002", 3: "tok-hale-0003" };

/* ---------------------------------------------------------------- rules */
const RULES = {
  roles: {
    tactical: { label: "Tactical", title: "Tactical Officer", attrs: ["accuracy", "threat_assessment", "security", "composure"] },
    engineer: { label: "Engineer", title: "Engineer", attrs: ["repair", "power_management", "improvisation", "composure"] },
    science: { label: "Science", title: "Science Officer", attrs: ["sensor_analysis", "xenology", "improvisation", "composure"] },
    first_officer: { label: "First Officer", title: "First Officer", attrs: ["command_presence", "diplomacy", "threat_assessment", "composure"] },
    medical: { label: "Medical", title: "Medical Officer", attrs: ["triage", "psychology", "xenology", "composure"] },
    helm: { label: "Helm", title: "Helm Officer", attrs: ["piloting", "navigation", "evasion", "composure"] }
  },
  attributes: { accuracy: "Accuracy", threat_assessment: "Threat Assessment", security: "Security", composure: "Composure", repair: "Repair", power_management: "Power Management", improvisation: "Improvisation", sensor_analysis: "Sensor Analysis", xenology: "Xenology", command_presence: "Command Presence", diplomacy: "Diplomacy", triage: "Triage", psychology: "Psychology", piloting: "Piloting", navigation: "Navigation", evasion: "Evasion" },
  ship: { tactical: "Tactical", defense: "Defense", speed: "Speed", manoeuvrability: "Manoeuvrability", sensors: "Sensors", hull_integrity: "Hull Integrity" },
  species: {
    Human: { free: 3, bonus: [] }, Seluun: { bonus: { composure: 2, sensor_analysis: 1 } }, Vey: { bonus: { accuracy: 2, threat_assessment: 1 } },
    Ossan: { bonus: { repair: 2, power_management: 1 } }, Lirae: { bonus: { diplomacy: 2, threat_assessment: 1 } }, "Joined Ament": { bonus: { xenology: 1, improvisation: 1, command_presence: 1 } },
    Haldani: { bonus: { improvisation: 2, composure: 1 } }, Quell: { bonus: { composure: 2, diplomacy: 1 } }, Teneri: { bonus: { xenology: 3 } }, Drav: { bonus: { accuracy: 3 } }
  },
  genders: ["Male", "Female"],
  presets: {
    skirmish: { label: "Skirmish", size: 8, critical: 3, blurb: "Short campaign, fast generation, everyone stays close." },
    standard: { label: "Standard", size: 12, critical: 5, blurb: "The default. Real travel decisions without long empty hauls." },
    expanse: { label: "Expanse", size: 16, critical: 7, blurb: "Long campaign. Longer journeys to reach other captains." },
    deep_void: { label: "Deep Void", size: 20, critical: 9, blurb: "Maximum size. Long generation wait and heavier on older computers.", warning: true }
  },
  pools: { crew: 150, ship: 100, crew_cap: 15, ship_min: 5, ship_max: 35 },
  max_captains: 6,
  voices: [
    ["af_heart", "Heart", "Female", "American", 1], ["af_bella", "Bella", "Female", "American", 1], ["bf_emma", "Emma", "Female", "British", 1], ["af_nicole", "Nicole", "Female", "American", 2], ["bf_isabella", "Isabella", "Female", "British", 2], ["af_sarah", "Sarah", "Female", "American", 3],
    ["am_michael", "Michael", "Male", "American", 1], ["am_fenrir", "Fenrir", "Male", "American", 1], ["bm_george", "George", "Male", "British", 1], ["am_puck", "Puck", "Male", "American", 2], ["bm_fable", "Fable", "Male", "British", 2], ["bm_lewis", "Lewis", "Male", "British", 3]
  ].map(([id, name, gender, accent, quality]) => ({ id, label: name + " (" + accent + ")", gender, locale: accent, timbre: id, quality })),
  join_ready: true
};

/* ---------------------------------------------------------------- the map: a 12-cube, seeded so it is the same every run */
function rand(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const MAP = (() => {
  const r = rand(20261126), N = 12, sectors = [], classes = "OBAFGKMMMKKG";
  const own = [7, 5, 3];
  for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) {
    const v = r();
    let t = null;
    if (v < 0.11) t = "star_system"; else if (v < 0.125) t = "nebula"; else if (v < 0.13) t = "anomaly"; else if (v < 0.134) t = "station";
    const nearNeb = Math.hypot(x - 7, y - 5, z - 3) < 2.2 && r() < 0.6;
    if (nearNeb) t = "nebula";
    if (!t) continue;
    const d = Math.hypot(x - own[0], y - own[1], z - own[2]);
    const s = d < 0.5 ? 2 : d < 2.5 ? (r() < 0.6 ? 2 : 1) : d < 4.5 && r() < 0.4 ? 1 : 0;
    const row = { c: x + "," + y + "," + z, s, t, k: t === "star_system" ? classes[Math.floor(r() * classes.length)] : null };
    if (x <= 4 && z >= 6) row.f = "ossan"; else if (x >= 8 && y >= 8) row.f = "vashtar"; else if (y <= 2 && z <= 3) row.f = "drav";
    if (s > 0) row.d = { name: t === "nebula" ? "Kestrel Nebula" : "System " + (x * 144 + y * 12 + z), planets: t === "star_system" ? Math.floor(r() * 7) : 0, habitability: r() < 0.3 ? "marginal" : "none", resources: r() < 0.4 ? ["aetherite"] : r() < 0.5 ? ["hydrex", "corundite"] : [], hazard: t === "nebula" && r() < 0.5 ? "ion_storm" : null, notable: null, note: "", scan: "" };
    sectors.push(row);
  }
  const set = (c, o) => { let row = sectors.find(s => s.c === c); if (!row) { row = { c, s: 0, t: "star_system", k: "G" }; sectors.push(row); } Object.assign(row, o); };
  set("7,5,3", { s: 2, t: "nebula", k: null, p: "Kestrel Nebula", d: { name: "Kestrel Nebula", planets: 0, habitability: "none", resources: ["veilstone"], hazard: "ion_storm", notable: "A hollow moon with a repeating signal", note: "Signal from the second moon", scan: "Signal period 4.2 seconds. No match in the archive." } });
  set("5,6,3", { s: 2, t: "station", k: null, p: "Vela Outpost", d: { name: "Vela Outpost", planets: 0, habitability: "none", resources: [], hazard: null, notable: "Concord supply depot", note: "", scan: "" } });
  set("9,6,4", { s: 1, t: "star_system", k: "K", p: "Calder Reach", d: { name: "Calder Reach", planets: 4, habitability: "habitable", resources: ["aurelium_ore"], hazard: null, notable: null, note: "", scan: "" } });
  set("11,9,2", { s: 0, t: "star_system", k: "M" });
  set("2,8,7", { s: 0, t: "star_system", k: "F", f: "ossan", p: "Tull's Market" });
  return { size: N, ly_per_unit: 5, sectors, factions: { ossan: "Ossan Guilds", vashtar: "Vashtar Hegemony", drav: "Drav Imperium" } };
})();

/* ---------------------------------------------------------------- the captains, ship and crew */
const shipAttrs = (t, d, sp, m, se, h) => [["tactical", "Tactical", t], ["defense", "Defense", d], ["speed", "Speed", sp], ["manoeuvrability", "Manoeuvrability", m], ["sensors", "Sensors", se], ["hull_integrity", "Hull Integrity", h]]
  .map(([key, label, value]) => ({ key, label, value, base: value, bonus: 0, items: 0 }));
const ship = (name, cls, reg, hull, alert, extra) => Object.assign({ name, class: cls, registry: reg, attrs: shipAttrs(18, 16, 15, 17, 20, 14), hull, shields: alert === "normal" ? 0 : 100, shields_up: alert !== "normal", weapons: alert === "red", alert, damaged: [], range_ly: 30, cargo_used: 3, cargo_max: 10, bonus_pool: 0 }, extra || {});
const at = (o, list) => list.map(([k, base, bonus]) => ({ key: k, label: RULES.attributes[k], base, bonus: bonus || 0, value: base + (bonus || 0) }));
const CREW = [
  { role: "first_officer", title: "First Officer", name: "Cmdr. Ashe Kerrow", species: "Human", gender: "Female", voice: "bf_emma", injury: null, attrs: at(0, [["command_presence", 12, 1], ["diplomacy", 9, 1], ["threat_assessment", 6, 1], ["composure", 8]]) },
  { role: "tactical", title: "Tactical Officer", name: "Lt. Cmdr. Brann Ode", species: "Drav", gender: "Male", voice: "am_fenrir", injury: null, attrs: at(0, [["accuracy", 13, 3], ["threat_assessment", 8], ["security", 9], ["composure", 6]]) },
  { role: "science", title: "Science Officer", name: "Lt. Iri Vell", species: "Seluun", gender: "Female", voice: "af_nicole", injury: null, attrs: at(0, [["sensor_analysis", 12, 1], ["xenology", 10], ["improvisation", 6], ["composure", 7, 2]]) },
  { role: "engineer", title: "Engineer", name: "Chief Halden Moor", species: "Ossan", gender: "Male", voice: "bm_george", injury: { type: "physical", severity: "light", turns_remaining: 2 }, attrs: at(0, [["repair", 13, 2], ["power_management", 9, 1], ["improvisation", 8], ["composure", 5]]) },
  { role: "medical", title: "Medical Officer", name: "Dr. Sefa Imari", species: "Teneri", gender: "Female", voice: "af_bella", injury: null, attrs: at(0, [["triage", 11], ["psychology", 8], ["xenology", 6, 3], ["composure", 7]]) },
  { role: "helm", title: "Helm Officer", name: "Ens. Tavi Rook", species: "Haldani", gender: "Male", voice: "am_puck", injury: null, attrs: at(0, [["piloting", 12], ["navigation", 9], ["evasion", 8, 2], ["composure", 5, 1]]) }
];
const others = [
  { id: 2, seat: 2, name: "Ilo Okono", position: "9,6,4", party: "p2", in_fleet: false, connected: true, ship: ship("CSV Lantern", "Harrow class", "CR-2207", 70, "yellow"), inventory: [], injured: 1 },
  { id: 3, seat: 3, name: "Marek Hale", position: "9,6,4", party: "p2", in_fleet: false, connected: true, ship: ship("CSV Wren", "Swift class", "CR-3314", 100, "normal"), inventory: [], injured: 0 }
];

/* ---------------------------------------------------------------- the event log */
let nextId = 100;
const L = (type, id, name, line, voice) => ({ speaker_type: type, speaker_id: id, speaker_name: name, line, voice });
const LOG = [
  { id: 90, type: "notice", turn: 11, at: "", mine: true, text: "Stage 2 begins: find what is broadcasting from inside the storm.", speaker: "Concord Fleet Command", say: false, fresh: false },
  { id: 91, type: "turn", turn: 11, at: "", mine: true, captain: "Rhea Solvane", text: "Take us into the storm, slowly. Shields up.", cost: 1, refused: false, lines: [L("officer", "first_officer", "Cmdr. Ashe Kerrow", "Whatever is broadcasting that signal knows we are here. It changed pattern the moment we entered the storm.", "bf_emma")], notes: [], changes: ["Yellow alert"], awaiting_report: false },
  { id: 92, type: "narration", turn: 11, at: "", mine: true, ref: 91, lines: [L("computer", "computer", "Ship Computer", "Signal period: 4.2 seconds. No match in the archive.", "af_heart")] },
  { id: 93, type: "narration", turn: 12, at: "", mine: true, ref: 0, lines: [L("npc", "npc-tull", "Master Tull", "You hunt the beacon too? Then we are neighbours in trouble, Captain.", "bm_lewis")] },
  { id: 94, type: "turn", turn: 12, at: "", mine: true, captain: "Rhea Solvane", text: "Vell, scan the second moon.", cost: 2, refused: false,
    roll: { value: 14, source: "system", needed: 12, outcome: "success", momentum: 1, officer: "Lt. Iri Vell", attribute: "Sensor Analysis" },
    lines: [L("officer", "science", "Lt. Iri Vell", "I have it. The signal is coming from a hollow moon, not a ship.", "af_nicole")], notes: [], changes: ["Scan of the 2nd moon recorded on the chart", "Turn points 11"], awaiting_report: false }
];

/* ---------------------------------------------------------------- the state of one captain */
function baseState(scene) {
  const s = {
    status: scene === "ended" ? "ended" : "active", turn: 12, dice: scene === "roll" ? "physical" : "system", options: { preset: "standard", dice: "system", captains: 3, size: 12 },
    title: "The Silent Beacon", me: { id: 1, seat: 1, name: "Rhea Solvane" }, gen: { phase: 3 }, pause: null,
    ship: ship("CSV Meridian", "Meridian class", "CR-1024", 92, "yellow"), crew: CREW,
    computer: { name: "Computer", status: "Online", voice: "af_heart" },
    inventory: [
      { key: "i1", name: "Phase-lattice probe", desc: "", qty: 1, kind: "consumable", rarity: "advanced", cost: 1, effect: "Reveals a sector without a scan" },
      { key: "i2", name: "Reserve power cell", desc: "", qty: 2, kind: "consumable", rarity: "standard", cost: 0, effect: "+3 turn points for one turn" },
      { key: "i3", name: "Overcharged jump coil", desc: "", qty: 1, kind: "equipment", rarity: "prototype", cost: 0, effect: "+5 light-years for one journey" }
    ],
    held_back: 0, audio: { tts: true, stt: true, text: true }, position: "7,5,3", database: null, pending: null,
    joining: false, narration_pending: false, briefing_pending: false, benched: false,
    fleet: { leader: 1, members: [1], is_fleet: false },
    captains: [{ id: 1, seat: 1, name: "Rhea Solvane", position: "7,5,3", party: "p1", in_fleet: true, connected: true, ship: null, inventory: null, injured: 1 }].concat(others),
    invites: [{ from: "Ilo Okono", seat: 2, ship: "CSV Lantern" }],
    turn: { of: 1, name: "Rhea Solvane", mine: true, points: 11, bonus: 0, points_max: 20, seconds_left: 161 },
    stage: { mission: "The Silent Beacon", critical: true, index: 2, total: 4, recovery: false, title: "Inside the storm", points: 11, bonus: 0, points_max: 20, momentum: 2, momentum_min: -3, momentum_max: 6, forced: false, climax_cost: 3, free_info_left: 8, fleet_points: null },
    tactical: {
      contacts: [{ name: "Unknown contact", kind: "ship", faction: "", posture: "Wary", position: "inside the storm, bearing 040", identified: false }, { name: "Ossan freighter Tull", kind: "ship", faction: "Ossan Guilds", posture: "Passive", position: "behind the 2nd moon, beside us", identified: true }],
      threat: null, scan: { subject: "Ossan freighter Tull", text: "Shields at 40%. Light cargo lances. Eleven life signs. Hold full of veilstone." }
    },
    diplomacy: {
      factions: [{ key: "ossan", name: "Ossan Guilds", step: "Cordial", dir: 1, reason: "Shared the storm charts" }, { key: "vashtar", name: "Vashtar Hegemony", step: "Unfriendly", dir: -1, reason: "Border patrol turned us back" }, { key: "kethri", name: "Kethri Swarm", step: "Hostile", dir: 0, reason: "Known from the scouts' reports" }],
      channel: null, database: { subject: "Ossan Guilds", text: "Merchant guilds of the inner worlds. They deal with anyone, and keep every bargain to the letter." },
      agreements: [{ text: "Captain Solvane promised Master Tull a share of any salvage from the hollow moon.", by: "Rhea Solvane" }],
      contacts: [{ name: "Master Tull", faction: "Ossan Guilds", attitude: "Friendly", met_at: "Kestrel Nebula" }, { name: "Overseer Vask", faction: "Vashtar Hegemony", attitude: "Cold", met_at: "Calder Reach" }]
    },
    missions: [
      { id: 1, title: "The Silent Beacon", kind: "main", critical: true, final: false, status: "active", sector: "7,5,3", briefing: "Find what broadcasts from the storm.", stage: 1, stages: 4, need: 1, present: 1, locked: "", mine: true, orders_pending: false, recovery_pending: false },
      { id: 2, title: "The Long Silence", kind: "main", critical: true, final: true, status: "available", sector: "7,5,3", briefing: "", stage: 0, stages: 6, need: 3, present: 1, locked: "Requires 3 captains — 1 present", mine: false, orders_pending: false, recovery_pending: false }
    ],
    leads: [{ text: "The beacon repeats from deep in the Morrow Expanse.", sector: "11,9,2" }],
    events: LOG.slice(), chat: [], map_v: "v1", local: [{ id: 1, name: "Rhea Solvane", seat: 1 }], work: false, tts_mode: "local", realtime: "sse", hold: null
  };
  s.captains[0].ship = s.ship;
  if (scene === "confirm") s.pending = { type: "dialogue", kind: "confirm", title: "Proceed?", message: "Lt. Iri Vell will try to lock the matter relay on the hollow moon. Cost 2 points. The die must show 13 or higher. Proceed?", buttons: [{ id: "proceed", label: "Proceed" }, { id: "belay", label: "Belay" }], roll: { officer: "Lt. Iri Vell", needed: 13 } };
  if (scene === "roll") s.pending = { type: "roll", preview: { officer: "Lt. Cmdr. Brann Ode", role: "Tactical Officer", covering: false, needed: 13 }, seconds_left: 41, seconds_total: 60, text: "Fire a spread of torpedoes at the contact" };
  if (scene === "paused") s.pause = { reason: "manual", by: "Ilo Okono", dropped: [], can_decide: false, warning: "" };
  if (scene === "disconnect") s.pause = { reason: "disconnect", by: "", dropped: ["Marek Hale"], can_decide: true, warning: "Resuming without them leaves their ship in the fleet but inactive. Their turns are skipped, their items cannot be transferred, and the rest of the current stage becomes one difficulty band harder for the captains who remain." };
  if (scene === "hold-other") { s.turn = { of: 2, name: "Ilo Okono", mine: false, points: 14, bonus: 0, points_max: 20, seconds_left: 95 }; s.hold = { captain: 2, name: "Ilo Okono" }; }
  if (scene === "hold-pause") { s.turn = { of: 2, name: "Ilo Okono", mine: false, points: 14, bonus: 0, points_max: 20, seconds_left: 0 }; s.hold = { captain: 2, name: "Ilo Okono" }; s.pause = { reason: "hold", by: "Ilo Okono", dropped: [], can_decide: false, warning: "" }; }
  if (scene === "safety") { s.safety = { kind: "order", id: "s1" }; s.hold = { captain: 1, name: "Rhea Solvane" }; }
  if (scene === "explore") { s.stage = null; s.ship.alert = "normal"; s.ship.shields_up = false; s.ship.shields = 0; s.ship.bonus_pool = 2; s.invites = []; s.turn.points = 17; s.fleet = { leader: 2, members: [1, 2, 3], is_fleet: true }; s.captains.forEach(c => { c.in_fleet = true; c.party = "p1"; c.position = "7,5,3"; }); s.chat = [{ party: "p1", from: "Ilo Okono", text: "We are with you. Lantern holds station off your port side.", at: 0 }]; }
  return s;
}

/* ---------------------------------------------------------------- mutable mock state */
let scene = "bridge";
let live = null;               // the bridge state, kept between requests so the scripted turn changes it
let lobbyStatus = "lobby", genPhase = 0;
const lobbyCaps = [
  { id: 1, seat: 1, name: "Rhea Solvane", ship: "CSV Meridian", ready: true, connected: true, local: false },
  { id: 2, seat: 2, name: "Ilo Okono", ship: "CSV Lantern", ready: true, connected: true, local: false },
  { id: 3, seat: 3, name: "Marek Hale", ship: "Choosing a ship…", ready: false, connected: true, local: false }
];
function setScene(name) {
  scene = name || "bridge";
  live = baseState(scene);
  lobbyStatus = scene === "generating" ? "generating" : scene === "lobby" || scene === "seat" ? "lobby" : "active";
  genPhase = 1;
}
setScene("bridge");

const BUILDS = [
  { id: 1, name: "CSV Meridian", captain: "", modified: "2026-11-20" },
  { id: 2, name: "CSV Lantern", captain: "Ilo Okono", modified: "2026-11-21" },
  { id: 3, name: "CSV Wren", captain: "", modified: "2026-11-22" },
  { id: 4, name: "CSV Halcyon", captain: "", modified: "2026-11-24" }
];
function fullBuild(id) {
  const b = BUILDS.find(x => x.id === id) || BUILDS[0], crew = {};
  CREW.forEach(o => {
    const a = {}; RULES.roles[o.role].attrs.forEach((k, i) => { a[k] = [13, 9, 6, 7][i]; });
    crew[o.role] = { role: o.role, name: o.name, species: o.species, gender: o.gender, attrs: a, human_bonus: o.species === "Human" ? ["command_presence", "diplomacy", "threat_assessment"] : [], personality: "Steady under pressure; speaks plainly and briefly.", voice: o.voice };
  });
  crew.helm.attrs.piloting = 6; crew.helm.attrs.navigation = 5;
  return { id: b.id, name: b.name, ship: { name: b.name, class: "Meridian class", registry: "CR-1024", captain: b.captain, attrs: { tactical: 18, defense: 16, speed: 15, manoeuvrability: 17, sensors: 20, hull_integrity: 14 } }, crew };
}

/* ---------------------------------------------------------------- the stand-in window.api for a plain browser */
const STUB = `/* Stand-in for the Electron preload (window.api) in a plain browser: speech is a soft tone, speech in returns a fixed order. */
(function () {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let stopped = 0;
  window.api = {
    hostGame: async ({ port }) => ({ port }),
    getSettings: async () => ({ safety: window.BuiltIn ? window.BuiltIn.factory().safety : {} }),
    country: async () => "GB",
    voices: async () => [],
    speak: async (req, onSound) => {
      const mine = stopped, words = String(req.text).split(/\\s+/).length, rate = 24000, n = Math.min(rate * 6, Math.round(words * 0.28 * rate));
      await wait(150);
      if (mine !== stopped) return;
      const samples = new Float32Array(n), f = 180 + (req.voice || "").length * 13;
      for (let i = 0; i < n; i++) samples[i] = 0.02 * Math.sin(2 * Math.PI * f * i / rate) * Math.min(1, i / 800, (n - i) / 800);
      onSound({ samples, rate });
    },
    stopSpeaking: () => { stopped++; },
    transcribe: async () => { await wait(300); return "Set course for the selected sector."; }
  };
})();`;

/* ---------------------------------------------------------------- http */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-GD-Captain, X-GD-Ticket, X-GD-Live", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (res, status, body) => { res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, CORS)); res.end(JSON.stringify(body)); };
const err = (res, status, code, message, data) => json(res, status, { code, message, data: Object.assign({ status }, data || {}) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function serveFile(res, rel, inject) {
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, CORS); return res.end("Not found"); }
  let body = fs.readFileSync(file);
  if (inject) body = Buffer.from(String(body).replace('<script src="../built-in.js"></script>', '<script src="../built-in.js"></script>\n<script src="/__mock/stub.js"></script>'));
  res.writeHead(200, Object.assign({ "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }, CORS));
  res.end(body);
}

function readBody(req) { return new Promise(resolve => { let b = ""; req.on("data", c => { b += c; }); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); }); }

/* A streamed reply, as class-live.php sends it: one JSON message per line, the request's own reply last. */
function ndjson(res) {
  res.writeHead(200, Object.assign({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" }, CORS));
  const send = m => res.write(JSON.stringify(m) + "\n");
  send({ t: "pad", p: " ".repeat(2048) });
  return send;
}
async function streamLine(send, key, head, text) {
  send(Object.assign({ t: "line", key }, head));
  const parts = text.match(/\S+\s*/g) || [];
  for (const p of parts) { send({ t: "txt", key, d: p }); await sleep(45); }
}

const YES = ["yes", "aye", "proceed", "yes proceed", "make it so", "engage", "do it", "confirmed", "affirmative", "go ahead", "go"];
/* The scripted turn: an order is first summed up by the Computer, which asks whether to proceed. */
async function command(res, text) {
  const send = ndjson(res), s = live;
  const plain = String(text).toLowerCase().replace(/[.!,]+$/, "").replace(/\s+/g, " ").trim();
  if (/hurt myself|kill myself/.test(plain)) {
    // The safety check flagged the order: nothing is carried out, it costs nothing, and only this captain is told.
    await sleep(300);
    s.safety = { kind: "order", id: "s" + (++nextId) }; s.hold = { captain: 1, name: s.me.name };
    send({ t: "safety", kind: "order", id: s.safety.id });
    send({ t: "done", status: 200, body: { ok: true, held: true } });
    return res.end();
  }
  if (s.pending && s.pending.kind === "confirm" && YES.includes(plain)) return proceed(send, res);
  if (s.pending && s.pending.kind === "confirm" && /^(no|belay|belay that)$/.test(plain)) return belay(send, res);
  await sleep(500);
  const id = ++nextId, line = L("computer", "computer", "Ship Computer", "Order understood: Lieutenant Vell locks the matter relay on the hollow moon. Cost two points. This is groundwork for the decisive move. The die must show thirteen or higher. Proceed?", "af_heart");
  s.events = [{ id, type: "narration", turn: s.turn.points, at: "", mine: true, ref: 0, lines: [line] }];
  await streamLine(send, "e" + id, { speaker_type: line.speaker_type, speaker_id: line.speaker_id, speaker_name: line.speaker_name, voice: line.voice, audio: false, id }, line.line);
  send({ t: "end", key: "e" + id, id, text: line.line });
  s.pending = { type: "dialogue", kind: "confirm", title: "Proceed?", message: "Lt. Iri Vell will lock the matter relay on the hollow moon. Cost 2 points. The die must show 13 or higher.", buttons: [{ id: "proceed", label: "Proceed" }, { id: "belay", label: "Belay" }], roll: { officer: "Lt. Iri Vell", needed: 13 } };
  pendingOrder = text;
  send({ t: "done", status: 200, body: { ok: true } });
  res.end();
}
let pendingOrder = "Lock the matter relay on the hollow moon.";
async function belay(send, res) {
  const s = live; s.pending = null;
  const id = ++nextId;
  s.events = [{ id, type: "notice", turn: 12, at: "", mine: true, text: "Order belayed. Nothing was spent.", speaker: "Ship Computer", say: true, fresh: true }];
  send({ t: "sync", events: s.events });
  send({ t: "done", status: 200, body: { ok: true } });
  res.end();
}
/* Proceed: the order is resolved with a system roll, recorded, and its report is streamed line by line. */
async function proceed(send, res) {
  const s = live; s.pending = null;
  await sleep(1200);
  const tid = ++nextId;
  const turn = { id: tid, type: "turn", turn: 13, at: "", mine: true, captain: s.me.name, text: pendingOrder, cost: 2, refused: false,
    roll: { value: 17, source: "system", needed: 13, outcome: "success", momentum: 1, officer: "Lt. Iri Vell", attribute: "Sensor Analysis" }, lines: [], notes: [], changes: ["Matter relay lock held", "Turn points 9", "Momentum +3"], awaiting_report: true };
  s.stage.points = 9; s.turn.points = 9; s.stage.momentum = 3;
  s.events = [turn];
  send({ t: "sync", events: [turn] });
  await sleep(2600);
  const report = [
    L("officer", "science", "Lt. Iri Vell", "Lock established. Captain, there is a chamber inside the moon, and it is warm. Someone built this.", "af_nicole"),
    L("officer", "first_officer", "Cmdr. Ashe Kerrow", "Then someone is still home. Recommend we keep the shields up while we look.", "bf_emma"),
    L("npc", "npc-tull", "Master Tull", "Captain, my scanners show the same chamber. Whatever is in there, I want my share.", "bm_lewis")
  ];
  const nid = ++nextId;
  for (let k = 0; k < report.length; k++) {
    const l = report[k], key = "r" + tid + "-" + k;
    await streamLine(send, key, { speaker_type: l.speaker_type, speaker_id: l.speaker_id, speaker_name: l.speaker_name, voice: l.voice, audio: false, ref: tid, k }, l.line);
    send({ t: "end", key, id: nid, text: l.line });
    await sleep(150);
  }
  turn.awaiting_report = false;
  s.events = [turn, { id: nid, type: "narration", turn: 13, at: "", mine: true, ref: tid, lines: report }];
  send({ t: "done", status: 200, body: { ok: true } });
  res.end();
}

function stateFor(after) {
  const s = Object.assign({}, live);
  s.events = (live.events || []).filter(e => e.id > after);
  return s;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), p = url.pathname;
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (p === "/__mock/stub.js") { res.writeHead(200, Object.assign({ "Content-Type": MIME[".js"] }, CORS)); return res.end(STUB); }
  if (p === "/__mock/scene") { const b = await readBody(req); setScene(b.name); return json(res, 200, { ok: true, scene }); }
  if (p === "/" ) { res.writeHead(302, { Location: "/renderer/game.html" }); return res.end(); }
  if (p.startsWith("/renderer/") || p === "/built-in.js" || p === "/helplines.js") return serveFile(res, p.slice(1), p === "/renderer/game.html");

  const body = req.method === "POST" ? await readBody(req) : {};
  if (p === "/rules") return json(res, 200, RULES);
  if (p === "/hosted") return json(res, 200, { games: [{ token: TOKEN, title: lobbyStatus === "lobby" ? "" : "The Silent Beacon", status: lobbyStatus === "generating" ? "lobby" : lobbyStatus, captains: 3, join_ready: true }] });
  if (p === "/games") return json(res, 200, { games: [{ token: TOKEN, title: "The Silent Beacon", status: "active", created: "2026-11-20", ended: "", preset: "Standard", captains: 3, turns: 12 }, { token: "f".repeat(32), title: "Embers of the Rift", status: "ended", created: "2026-10-02", ended: "2026-10-30", preset: "Skirmish", captains: 2, turns: 64 }] });
  if (p === "/game" && req.method === "POST") return json(res, 200, { token: TOKEN });

  /* ---- creator: the library of this server ---- */
  if (p === "/creator/builds" && req.method === "GET") return json(res, 200, { builds: BUILDS });
  if (p === "/creator/builds" && req.method === "POST") return json(res, 200, Object.assign(fullBuild(1), { id: body.id || 9, name: (body.ship && body.ship.name) || "New ship" }));
  if (/^\/creator\/builds\/\d+$/.test(p)) return json(res, 200, fullBuild(+p.split("/").pop()));
  if (p === "/creator/templates") return json(res, 200, { ship_csv: "ship_name,ship_class,registry,captain_name,tactical,defense,speed,manoeuvrability,sensors,hull_integrity\n", crew_csv: "role,name,race,gender\n" });
  if (/^\/creator\/export\/\d+$/.test(p)) return json(res, 200, { name: "CSV Meridian", ship_csv: "ship_name\nCSV Meridian\n", crew_csv: "role,name\n" });
  if (p === "/creator/import") return json(res, 200, {});

  const m = /^\/game\/([a-f0-9]{32,64})(\/[a-z]+)?$/.exec(p);
  if (!m) return err(res, 404, "gd_not_found", "No such route.");
  if (m[1] !== TOKEN) return err(res, 404, "gd_no_game", "That game is not on this server.");
  const route = m[2] || "", cap = req.headers["x-gd-captain"], seated = Object.values(CAPTAIN_TOKENS).includes(cap);
  // The host's own window (this PC) is Player One, as a logged-in owner was in the plugin.
  const owner = /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress) && !url.searchParams.has("guest");

  switch (route) {
    case "": {
      const joined = seated && !(scene === "seat" && cap !== CAPTAIN_TOKENS[1]);
      if (!owner && !seated) return json(res, 200, { status: lobbyStatus, joined: false, owner: false, join_ready: true, expired: false });
      if (scene === "seat" && !seated) return json(res, 200, { status: "lobby", joined: false, owner, join_ready: true, expired: false });
      if (lobbyStatus === "generating") { genPhase = Math.min(3, genPhase); }
      return json(res, 200, {
        status: lobbyStatus, options: { preset: "standard", dice: "system", captains: 3 }, presets: RULES.presets, captains: lobbyCaps, max: 6,
        gen: lobbyStatus === "generating" ? { phase: genPhase, sectors: 214, error: "" } : { phase: 0 }, join: owner ? { addresses: ["192.168.1.20"], port: PORT, code: "4417" } : null,
        expired: false, joined, owner, me: joined ? 1 : 0, title: "The Silent Beacon", turns: 12
      });
    }
    case "/unlock": return body.code === "4417" ? json(res, 200, { ticket: "ticket-1" }) : err(res, 403, "gd_code_wrong", "That code is not right.", { attempts_left: 4 });
    case "/builds": return json(res, 200, { builds: BUILDS.map(b => ({ id: b.id, name: b.name, captain: b.captain, taken: b.id === 2 })), seats: scene === "seat" ? [{ id: 3, seat: 3, name: "Marek Hale", ship: "CSV Wren" }] : [] });
    case "/join": return json(res, 200, { captain: 1, seat: 1, name: body.name || "Rhea Solvane", token: CAPTAIN_TOKENS[1] });
    case "/resume": return json(res, 200, { captain: body.captain, seat: body.captain, name: "Marek Hale", token: CAPTAIN_TOKENS[body.captain] || CAPTAIN_TOKENS[1] });
    case "/remove": case "/allocate": case "/decide": case "/chat": return json(res, 200, { ok: true });
    case "/start": lobbyStatus = "generating"; genPhase = 0; return json(res, 200, { ok: true });
    case "/generate": await sleep(400); genPhase = Math.min(3, genPhase + 1); if (genPhase >= 3 && scene !== "generating") lobbyStatus = "active"; return json(res, 200, { gen: { phase: genPhase }, status: lobbyStatus });
  }
  if (!seated) return err(res, 403, "gd_auth", "You are not seated in this game.");
  switch (route) {
    case "/state": return json(res, 200, stateFor(+url.searchParams.get("after") || 0));
    case "/map": return json(res, 200, MAP);
    case "/log": return json(res, 200, { title: "The Silent Beacon", entries: LOG });
    case "/stream":
      res.writeHead(200, Object.assign({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }, CORS));
      res.write(": open\n\n");
      { const t = setInterval(() => res.write(": keep\n\n"), 5000); req.on("close", () => clearInterval(t)); setTimeout(() => { clearInterval(t); res.end(); }, 25000); }
      return;
    case "/command": return command(res, body.text || "");
    case "/answer": { const send = ndjson(res); return body.choice === "proceed" ? proceed(send, res) : belay(send, res); }
    case "/roll": { const send = ndjson(res); live.pending = null; send({ t: "done", status: 200, body: { ok: true } }); return res.end(); }
    case "/work": { const send = ndjson(res); send({ t: "done", status: 200, body: { ok: true } }); return res.end(); }
    case "/safety": { const send = ndjson(res); live.safety = null; live.hold = null; if (live.pause && live.pause.reason === "hold") live.pause = null; send({ t: "done", status: 200, body: { ok: true } }); return res.end(); }
    case "/pause": live.pause = body.on ? { reason: "manual", by: live.me.name, dropped: [], can_decide: false, warning: "" } : null; return json(res, 200, { ok: true });
    case "/audio": ["tts", "stt", "text"].forEach(k => { if (body[k] != null) live.audio[k] = !!body[k]; }); return json(res, 200, { audio: live.audio });
  }
  return err(res, 404, "gd_not_found", "No such route.");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Mock game server on http://127.0.0.1:" + PORT + "/renderer/game.html");
  const shots = args.indexOf("--shots");
  if (shots >= 0) screenshots(args[shots + 1]).then(() => { server.close(); process.exit(0); }, e => { console.error(e); process.exit(1); });
});

/* ---------------------------------------------------------------- screenshots of every screen, with Playwright */
async function screenshots(dir) {
  const { chromium } = require("playwright");
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: +process.env.SHOT_W || 1440, height: +process.env.SHOT_H || 900 } });
  const problems = [];
  page.on("console", m => { if (m.type() === "error") problems.push(m.text()); });
  page.on("pageerror", e => problems.push(String(e)));
  const base = "http://127.0.0.1:" + PORT, game = base + "/renderer/game.html";
  const seatHash = "#" + encodeURIComponent(base + "|" + TOKEN);
  const seatIn = async () => page.evaluate(([b, t, c]) => { localStorage.setItem("gd:" + b + "|" + t, JSON.stringify({ captains: [{ id: 1, token: c, name: "Rhea Solvane", seat: 1 }], active: 1, device: "dev1" })); }, [base, TOKEN, CAPTAIN_TOKENS[1]]);
  const go = async (name, sceneName, url, after, full) => {
    await fetch(base + "/__mock/scene", { method: "POST", body: JSON.stringify({ name: sceneName }) });
    await page.goto(url, { waitUntil: "load" });
    if (after) await after();
    await sleep(1600);
    await page.screenshot({ path: path.join(dir, name + ".png"), fullPage: !!full });
    console.log("shot", name, problems.length ? "ERRORS: " + problems.join(" | ") : "ok");
    problems.length = 0;
  };
  await page.goto(game); await seatIn();
  await go("01-connect", "bridge", game, async () => { await page.evaluate(() => localStorage.clear()); await page.reload(); await seatIn(); await sleep(300); });
  await go("02-setup", "lobby", game, async () => { await page.fill("#h-code", "4417"); await page.click("#f-host button[type=submit]"); });
  await go("03-seat", "seat", game + seatHash, async () => { await page.evaluate(() => localStorage.clear()); await page.reload(); await sleep(500); const b = await page.$("[data-build='1']"); if (b) await b.click(); await page.fill("#s-name", "Rhea Solvane"); });
  await go("04-lobby", "lobby", game + seatHash, seatIn);
  await go("05-generating", "generating", game + seatHash, seatIn);
  await go("06-creator-list", "bridge", game, async () => { await page.click("#b-creator"); });
  await go("07-creator-editor", "bridge", game, async () => { await page.click("#b-creator"); await sleep(500); await page.click("text=Edit >> nth=0"); }, true);
  await go("08-bridge", "bridge", game + seatHash, seatIn);
  await go("09-bridge-full", "bridge", game + seatHash, seatIn, true);
  await go("10-confirm", "confirm", game + seatHash, seatIn);
  await go("11-turn-streaming", "confirm", game + seatHash, async () => { await seatIn(); await sleep(1500); await page.click("[data-ans='proceed']"); await sleep(1500); });
  await go("12-turn-report", "confirm", game + seatHash, async () => { await seatIn(); await sleep(1500); await page.click("[data-ans='proceed']"); await sleep(7000); });
  await go("13-roll", "roll", game + seatHash, seatIn);
  await go("14-paused", "paused", game + seatHash, seatIn);
  await go("15-disconnect", "disconnect", game + seatHash, seatIn);
  await go("16-hold-other", "hold-other", game + seatHash, seatIn);
  await go("17-hold-pause", "hold-pause", game + seatHash, seatIn);
  await go("18-safety", "safety", game + seatHash, seatIn);
  await go("19-explore-fleet", "explore", game + seatHash, seatIn, true);
  await go("20-ships-log", "bridge", game + seatHash, async () => { await seatIn(); await sleep(1200); await page.click("[data-menu='log']"); });
  await go("21-map-selected", "bridge", game + seatHash, async () => { await seatIn(); await sleep(2000); const box = await page.$("#map canvas"); const r = await box.boundingBox(); await page.mouse.click(r.x + r.width * 0.32, r.y + r.height * 0.55); });
  await page.setViewportSize({ width: 1024, height: 768 });
  await go("22-bridge-1024", "bridge", game + seatHash, seatIn, true);
  await go("23-order-flagged", "bridge", game + seatHash, async () => { await seatIn(); await sleep(1500); await page.fill("#cmd-in", "I want to hurt myself"); await page.press("#cmd-in", "Enter"); await sleep(1500); });
  await browser.close();
}
