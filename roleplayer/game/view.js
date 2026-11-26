"use strict";
/* What a client is allowed to see, ported from the plugin's class-view.php. Every panel value is drawn from current
   state (§9): nothing hard-coded. Hidden things stay hidden here: a mission's on_abandon type (§6.4) and the
   adaptive difficulty shift (§7.6).

   Additions for the desktop app: every line and notice carries the voice id it is spoken in (each player's app
   speaks it); the state of a captain whose turn the safety check put on hold carries `safety` (only theirs), and
   everyone's carries `hold`, saying only whose turn is on hold. */
const Rules = require("./rules.js");
const Engine = require("./engine.js");
const Library = require("./library.js");
const Game = require("./game.js");
const setting = require("./setting.js");
const T = require("./text.js");

const { time, gmdate, parseGm, empty, toList } = T;
const Turn = () => require("./turn.js");

/* join: for Player One, how other players reach this game ({ addresses, port, code }), else null. */
function lobby(w, g, caps, isOwner, join = null) {
  const first = [...caps.values()][0];
  const out = [...caps.values()].map(c => {
    const b = Library.getBuild(w.dataDir, c.build_id);
    return {
      id: c.id,
      seat: c.seat,
      name: c.name,
      ship: b ? b.name : "",
      ready: !!c.ready,
      connected: Game.isConnected(w, c),
      local: c.device !== "" && c.device === (first?.device ?? "") && c.seat !== 1
    };
  });
  return {
    status: g.status,
    options: g.options,
    presets: Rules.presets(),
    captains: out,
    max: Rules.MAX_CAPTAINS,
    gen: g.gen,
    join: isOwner ? join : null,
    expired: Game.expired(g)
  };
}

function crew(state) {
  const out = [];
  const names = Rules.attributes();
  for (const [role, def] of Object.entries(Rules.roles())) {
    if (!state.crew[role]) continue; // a crew saved before this station existed
    const o = state.crew[role];
    const attrs = Object.entries(Engine.effectiveAttrs(o)).map(([k, v]) => ({ key: k, label: names[k], base: v.base, bonus: v.bonus, value: v.value }));
    out.push({ role, title: def.title, name: o.name, species: o.species, gender: o.gender, attrs, injury: o.injury || null, voice: o.voice ?? "" });
  }
  return out;
}

function ship(state, range = null) {
  const labels = Rules.shipAttributes();
  const attrs = Object.entries(Game.shipEffective(state)).map(([k, v]) => Object.assign({ key: k, label: labels[k] }, v));
  const s = state.ship;
  return {
    name: s.name,
    class: s.class ?? "",
    registry: s.registry ?? "",
    attrs,
    hull: Rules.intval(s.hull),
    shields: state.alert === "normal" ? 0 : s.damaged.includes("shields") ? 50 : 100,
    shields_up: state.alert !== "normal",
    weapons: state.alert === "red",
    alert: state.alert,
    damaged: s.damaged.slice(),
    range_ly: range ?? Game.rangeLy(state),
    cargo_used: Game.cargoUsed(state),
    cargo_max: Rules.CARGO_SLOTS,
    bonus_pool: empty(s.bonus_done) ? Rules.intval(s.bonus_pool) : 0
  };
}

function inventory(state) {
  const items = Rules.items();
  return state.inventory.map(slot => {
    const it = items[slot.item] ?? null;
    return {
      key: slot.key,
      name: slot.name,
      desc: slot.desc ?? "",
      qty: Rules.intval(slot.qty),
      kind: !empty(slot.story) ? "story" : it?.kind,
      rarity: it?.rarity ?? "story",
      cost: Rules.intval(it?.cost ?? 0),
      effect: it ? effectText(it) : "Needed for a mission."
    };
  });
}

function effectText(it) {
  const attr = it.attribute !== undefined ? Rules.attributes()[it.attribute] ?? Rules.shipAttributes()[it.attribute] ?? "" : "";
  switch (it.effect) {
    case "turn_points": return `+${it.value} turn points for one turn`;
    case "roll_bonus": return `+${it.value} to the next ${attr} roll`;
    case "recovery": return it.kind === "equipment" ? `New injuries recover ${it.value} turn sooner while held` : `-${it.value} turns from one officer's recovery`;
    case "ship_attribute": return `+${it.value} ${attr} while held`;
    case "range": return `+${it.value} light-years for one journey`;
    case "momentum": return "+1 Momentum this stage";
    case "band_shift": return "Next rolled action is one band easier";
    case "reveal": return "Reveals a sector without a scan";
  }
  return "";
}

const computerVoiceFor = (w, state) => w.voices.computerVoice(Game.setting(w, "computer_gender"), Object.values(state?.crew ?? {}).map(o => o.voice).filter(v => !empty(v)));

/* Whose turn is on hold, as everyone may see it: the turn holder's if theirs is, else the first. */
function holdView(g, caps) {
  const holds = Object.keys(g.holds ?? {}).map(Number).filter(cid => caps.has(cid));
  if (!holds.length) return null;
  const of = Turn().holder(g);
  const cid = holds.includes(of) ? of : holds[0];
  return { captain: cid, name: caps.get(cid).name };
}

/* The full game view for one captain. */
function state(w, g, caps, cid, afterId) {
  const me = caps.get(cid);
  const s = me.state;
  const pid = s.party ?? "";
  const party = g.parties?.[pid] ?? null;
  const out = {
    status: g.status,
    turn: Rules.intval(g.turn),
    dice: g.options.dice,
    options: g.options,
    title: g.story?.title ?? "",
    me: { id: cid, seat: me.seat, name: me.name },
    gen: g.gen
  };

  // Pause state, with who paused and who may decide Wait or Resume (§3.5, §7.2.6).
  if (g.pause) {
    const dec = Game.decider(w, g, caps);
    const names = toList(g.pause.dropped ?? []).map(d => caps.get(d)?.name ?? "A captain");
    const by = g.pause.reason === "hold" ? caps.get(Rules.intval(g.pause.captain))?.name ?? "" : g.pause.by ? caps.get(g.pause.by)?.name ?? "" : "";
    out.pause = {
      reason: g.pause.reason,
      by,
      dropped: names,
      can_decide: g.pause.reason === "disconnect" && dec === cid,
      warning: g.pause.reason === "disconnect" ? "Resuming without them leaves their ship in the fleet but inactive. Their turns are skipped, their items cannot be transferred, and the rest of the current stage becomes one difficulty band harder for the captains who remain." : ""
    };
  } else {
    out.pause = null;
  }
  const mine = g.holds?.[cid];
  out.safety = mine ? { kind: mine.kind, id: mine.id } : null;
  out.hold = holdView(g, caps);
  if (!["active", "ended"].includes(g.status) || !party) return out;

  const range = Game.partyRange(party, caps);
  out.ship = ship(s, range);
  out.crew = crew(s);
  out.computer = { name: "Computer", status: "Online", voice: computerVoiceFor(w, s) };
  out.inventory = inventory(s);
  out.held_back = toList(s.held_back ?? []).length;
  out.audio = s.audio;
  out.position = party.position;
  out.database = s.database ?? null;

  // Pending prompt: the awaiting-roll state or a system dialogue. Server-authoritative countdown.
  const p = s.pending ?? null;
  if (p && p.type === "roll") {
    const left = g.pause ? Math.max(0, Rules.intval(p.deadline) - Rules.intval(g.pause.at)) : Math.max(0, Rules.intval(p.deadline) - time());
    out.pending = { type: "roll", preview: preview(p.preview), seconds_left: left, seconds_total: Game.setting(w, "roll_timeout"), text: p.text };
  } else if (p) {
    out.pending = { type: "dialogue", kind: p.kind, title: p.title, message: p.message, buttons: p.buttons, roll: p.roll ?? null };
  } else {
    out.pending = null;
  }
  out.joining = !empty(s.joining);
  out.narration_pending = !empty(s.narration);
  out.briefing_pending = !empty(s.briefing);
  out.benched = !!(party.stage && toList(party.stage.bench ?? []).includes(cid) && !Turn().stageOrder(g, party).includes(cid));

  // Fleet and other captains: positions, status and inventory are visible to all (§3.2, §3.3).
  out.fleet = { leader: Turn().partyLeader(g, party), members: party.members.slice(), is_fleet: party.members.length > 1 };
  out.captains = [];
  for (const [oid, o] of caps) {
    const op = g.parties[o.state.party ?? ""] ?? null;
    if (!op) continue;
    out.captains.push({
      id: oid,
      seat: o.seat,
      name: o.name,
      position: op.position,
      party: op.id,
      in_fleet: party.members.includes(oid),
      connected: !(g.dropped ?? []).includes(oid),
      ship: ship(o.state),
      inventory: oid === cid ? null : inventory(o.state),
      injured: Object.values(o.state.crew).filter(x => !empty(x.injury)).length
    });
  }
  out.invites = toList(s.invites ?? []).map(inv => ({ from: caps.get(inv.from)?.name ?? "", seat: caps.get(inv.from)?.seat ?? 0, ship: caps.get(inv.from)?.state?.ship?.name ?? "" }));

  // Whose turn it is, and the points this captain has: every turn has them, in a mission stage or not (§14.7).
  const holder = Turn().holder(g);
  const clock = g.turn_clock ?? null;
  out.turn = {
    of: holder,
    name: caps.get(holder)?.name ?? "",
    mine: holder === cid,
    points: party.stage ? Rules.intval(party.stage.points?.[cid] ?? 0) : Rules.intval(s.tp ?? Rules.STAGE_POINTS),
    bonus: Rules.intval(s.turn_bonus ?? 0),
    points_max: Rules.STAGE_POINTS,
    seconds_left: caps.size > 1 && clock && Rules.intval(clock.cid) === holder ? Math.max(0, Rules.intval(clock.since) + Game.setting(w, "turn_timeout") - (g.pause ? Rules.intval(g.pause.at) : time())) : null
  };

  // Stage: points and Momentum always visible (§7.2.7).
  const stage = party.stage;
  if (stage) {
    const m = Game.missions(w, g.id).get(stage.mission_id) ?? null;
    out.stage = {
      mission: stage.mission_title,
      critical: m ? !!m.is_critical : false,
      index: Rules.intval(stage.idx) + 1,
      total: m ? m.data.stages.length : 1,
      recovery: !empty(stage.def.recovery),
      title: stage.def.title,
      points: Rules.intval(stage.points?.[cid] ?? 0),
      bonus: Rules.intval(s.turn_bonus ?? 0),
      points_max: Rules.STAGE_POINTS,
      momentum: Rules.intval(stage.momentum),
      momentum_min: Rules.MOMENTUM_MIN,
      momentum_max: Rules.MOMENTUM_MAX,
      forced: Turn().stageForced(g, party),
      climax_cost: Rules.climaxCost(),
      free_info_left: Math.max(0, Rules.FREE_TIER0 - Rules.intval(stage.tier0?.[cid] ?? 0)),
      fleet_points: party.members.length > 1 ? stage.points : null
    };
  } else {
    out.stage = null;
  }

  // Tactical panel (§9.2).
  let threat = null;
  if (stage && stage.threat && typeof stage.threat === "object" && !empty(stage.threat.active)) {
    threat = { description: stage.threat.description, needed: p && p.type === "roll" ? p.preview?.needed_face ?? null : null };
  }
  out.tactical = {
    contacts: toList(stage ? stage.contacts : party.contacts ?? []).map(ct => {
      const c = Object.assign({}, ct);
      if (empty(c.identified)) {
        c.name = "Unknown contact";
        c.faction = "";
      } else if (c.faction) {
        c.faction = g.factions[c.faction]?.name ?? c.faction;
      }
      return c;
    }),
    threat,
    scan: s.tactical_scan ?? null
  };

  // Diplomacy panel (§9.1): only factions that have been met.
  const dip = { factions: [], channel: party.channel ? Object.assign({}, party.channel) : null, database: s.database ?? null, agreements: [], contacts: [] };
  for (const [key, f] of Object.entries(g.factions)) {
    if (!empty(f.met) && key !== setting.POWER.key) dip.factions.push({ key, name: f.name, step: Rules.standingStep(f.standing), dir: Rules.intval(f.dir ?? 0), reason: f.reason ?? "" });
  }
  if (dip.channel && !empty(dip.channel.faction)) dip.channel.faction = g.factions[dip.channel.faction]?.name ?? dip.channel.faction;
  for (const r of w.store.canon(g.id, { kind: "agreement", scopes: ["shared", String(cid)], limit: 30 })) {
    if ((r.data.status ?? "") === "") dip.agreements.push({ text: r.data.text, by: r.data.by ?? "" }); // visible until kept or broken (§9.1)
  }
  for (const r of w.store.canon(g.id, { kind: "npc", limit: 300 })) {
    if (!empty(r.data.met_at)) dip.contacts.push({ name: r.data.name, faction: g.factions[r.faction]?.name ?? "", attitude: r.data.attitude ?? "", met_at: r.data.met_at });
  }
  out.diplomacy = dip;

  // Missions: one shared pool. Gated missions are visibly locked (§6.3).
  out.missions = [];
  let present = 0;
  for (const mcid of party.members) if (!(g.dropped ?? []).includes(mcid)) present++;
  const all = Game.missions(w, g.id);
  for (const m of all.values()) {
    if (m.status === "expired" || (m.kind === "random" && m.status === "available" && m.sector !== party.position)) continue;
    // A mission is not shown until a captain has come to it: one they have taken on, or one where they are (§14.6).
    const isMine = toList(m.data.progress?.owners ?? []).includes(cid);
    if (!isMine && m.sector !== party.position) continue;
    const need = Game.effectiveRequirement(w, m, g, caps);
    out.missions.push({
      id: m.id,
      title: m.data.title,
      kind: m.kind,
      critical: !!m.is_critical,
      final: !!m.is_final,
      status: m.status,
      sector: m.sector,
      briefing: m.data.briefing,
      stage: Rules.intval(m.data.progress.stage),
      stages: m.data.stages.length,
      need,
      present,
      locked: ["available", "suspended"].includes(m.status) && present < need ? `Requires ${need} captains — ${present} present` : "",
      mine: isMine,
      orders_pending: !empty(m.data.bridge_pending),
      recovery_pending: !empty(m.data.progress.recovery_pending)
    });
  }

  // The leads log: where the story has pointed so far, until the captain gets there.
  out.leads = [];
  for (const lead of toList(g.leads ?? [])) {
    const m = all.get(lead.mission) ?? null;
    if (m && m.status === "available" && m.sector !== party.position) out.leads.push({ text: lead.text, sector: lead.sector });
  }

  out.events = events(w, g, cid, afterId);
  out.chat = party.members.length > 1 ? toList(g.chat).filter(c => c.party === pid) : [];
  return out;
}

function preview(p) {
  return { officer: p.officer, role: Rules.roles()[p.role].title, covering: !empty(p.covering), needed: p.needed_face };
}

/* Dialogue-log entries this captain may see, oldest first. */
function events(w, g, cid, afterId, limit = 150) {
  const args = { types: ["turn", "narration", "notice", "roll_prompt", "pause", "unpause"], limit };
  // A turn that finishes while the game is paused is held until unpause (§7.2.6).
  const holdFrom = !empty(g.pause) ? gmdate(Rules.intval(g.pause.at)) : null;
  let rows;
  if (afterId > 0) rows = w.store.events(g.id, Object.assign({ after_id: afterId }, args));
  else rows = w.store.events(g.id, Object.assign({ order: "DESC" }, args)).reverse();
  const caps = Game.captains(w, g.id);
  const voice = caps.has(cid) && caps.get(cid).state?.crew ? computerVoiceFor(w, caps.get(cid).state) : w.voices.computerVoice(Game.setting(w, "computer_gender"), []);
  const out = [];
  const seen = {}; // turns in this batch that already carry their lines
  for (const r of rows) {
    const d = r.data;
    const aud = d.audience ?? "all";
    if (r.type === "turn" && !empty(d.lines)) seen[r.id] = true;
    if (r.type === "narration" && seen[Rules.intval(d.ref)]) continue;
    if (holdFrom && ["turn", "narration"].includes(r.type) && r.created_at > holdFrom) break; // later entries wait too
    if (toList(d.except ?? []).map(Number).includes(cid)) continue;
    if (aud !== "all" && r.captain_id !== cid && !toList(aud).map(Number).includes(cid)) continue;
    const e = { id: r.id, type: r.type, turn: r.turn_no, at: r.created_at, mine: r.captain_id === cid };
    if (r.type === "turn") {
      Object.assign(e, {
        captain: d.captain_name, text: d.text, cost: Rules.intval(d.cost), refused: !empty(d.refused), lines: d.lines,
        notes: d.notes ?? [], changes: d.changes ?? [], awaiting_report: !empty(d.narration_pending)
      });
      if (!empty(d.resolve)) {
        e.roll = {
          value: Rules.intval(d.roll.value),
          source: d.roll.source,
          needed: Engine.neededFace(Rules.intval(d.resolve.modifier), Rules.intval(d.resolve.dc)),
          outcome: d.resolve.outcome,
          momentum: Rules.intval(d.momentum_delta ?? 0),
          officer: d.preview?.officer ?? "",
          attribute: Rules.attributes()[d.preview?.attribute ?? ""] ?? ""
        };
      }
    } else if (r.type === "narration") {
      Object.assign(e, { lines: d.lines, ref: Rules.intval(d.ref) });
    } else if (r.type === "roll_prompt") {
      Object.assign(e, { captain: d.captain_name, text: d.text, cost: Rules.intval(d.cost) });
    } else if (r.type === "notice") {
      // 'say': read out by the Computer, in this captain's Computer voice. 'fresh': just logged.
      Object.assign(e, { text: d.text, speaker: d.speaker ?? "", say: !empty(d.say), fresh: parseGm(r.created_at) > time() - 120, voice });
    }
    out.push(e);
  }
  return out;
}

/* The whole map: every stored sector, compactly. Clients cache it and refresh on the version. */
function map(w, g) {
  const sectors = [];
  for (const [coord, s] of Object.entries(Game.sectors(w, g.id))) {
    const d = s.data;
    const row = { c: coord, s: s.status, t: d.type, k: d.star_class ?? null };
    if (s.faction) row.f = s.faction;
    if (!empty(d.place)) row.p = d.place;
    // Details are known once a sector has been scanned or visited.
    if (s.status > 0) row.d = { name: d.name, planets: toList(d.planets ?? []).length, habitability: d.habitability ?? "none", resources: d.resources ?? [], hazard: d.hazard ?? null, notable: d.notable ?? null, note: d.place_note ?? "", scan: d.scan ?? "" };
    sectors.push(row);
  }
  const factions = {};
  for (const [key, f] of Object.entries(g.factions)) if (!empty(f.met)) factions[key] = f.name;
  return { size: Rules.intval(g.options.size), ly_per_unit: Rules.LY_PER_UNIT, sectors, factions };
}

/* The map's version: changes whenever a sector is added or its status goes up. */
function mapVersion(w, g) {
  const all = Object.values(Game.sectors(w, g.id));
  return String(all.length + all.reduce((n, s) => n + s.status, 0) * 100000);
}

/* Readable Ship's Log built from the event log (§11.5). */
function shipsLog(w, g, cid) {
  return events(w, g, cid, 0, 2000);
}

module.exports = { lobby, crew, ship, inventory, effectText, state, events, map, mapVersion, shipsLog, holdView };
