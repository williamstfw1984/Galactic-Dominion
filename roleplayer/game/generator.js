"use strict";
/* The generation pipeline (§5.3), ported from the plugin's class-generator.php: phase 1 builds the grid from the
   stored seed, phase 2 writes the story (one model call), phase 3 the missions (another). Also the later
   single-purpose calls: bridge missions (§6.4), recovery stages (§7.6) and random encounters (§5.3), and the reward
   items a mission gives (§7.3).

   Generation is advanced one phase per request by step(), as in the plugin, so the lobby can show its progress. */
const Rules = require("./rules.js");
const Grid = require("./grid.js");
const Prompts = require("./prompts.js");
const Game = require("./game.js");
const setting = require("./setting.js");
const T = require("./text.js");

const { isErr, fail, sanitizeKey, hashPick, toList } = T;
const POWER = setting.POWER.key;

let gridCache = { key: "", grid: null };
function gridFor(g) {
  const key = g.options.size + "|" + g.seed;
  if (gridCache.key !== key) gridCache = { key, grid: Grid.generate(Rules.intval(g.options.size), String(g.seed)) };
  return gridCache.grid;
}

/* Advance generation by one phase. Returns the game's gen state, or a GdError. */
function step(w, gameId) {
  return Game.withLock(w, gameId, async g => {
    if (g.status !== "generating") return g.gen;
    g.gen.error = null;
    const phase = Rules.intval(g.gen.phase);
    if (phase === 0) g = phaseGrid(w, g);
    else if (phase === 1) g = await phaseStory(w, g);
    else if (phase === 2) g = await phaseMissions(w, g);
    Game.save(w, g);
    return g.gen;
  }, 2);
}

/* ---------- phase 1: the grid, from the stored seed ---------- */

function phaseGrid(w, g) {
  const grid = gridFor(g);
  const rows = {};
  for (const [coord, s] of Object.entries(grid.sectors)) rows[coord] = { status: 0, faction: "", data: s };
  w.store.replaceSectors(g.id, rows);
  g.factions = {};
  for (const [key, f] of Object.entries(Rules.factions())) {
    g.factions[key] = { key, name: f.name, standing: f.standing, met: key === POWER, dir: 0, reason: "", note: f.note, new: false, active: false };
  }
  g.gen.phase = 1;
  g.gen.sectors = Object.keys(grid.sectors).length;
  w.store.event(g.id, 0, "system", { what: "phase_1_grid", seed: g.seed, size: grid.size, non_empty: Object.keys(grid.sectors).length });
  return g;
}

/* ---------- phase 2: the story ---------- */

function factionBrief() {
  return Object.entries(Rules.factions()).map(([key, f]) => `${key}: ${f.name}. ${f.note} Starting standing with ${setting.POWER.short}: ` + Rules.standingStep(f.standing) + ".").join("\n");
}

function rosterBrief(w, g) {
  return [...Game.captains(w, g.id).values()].map(c => "Seat " + c.seat + ": " + c.name + ", commanding the " + (c.state?.ship?.name ?? "ship") + ".").join("\n");
}

async function phaseStory(w, g) {
  const grid = gridFor(g);
  const summary = Grid.summarise(grid);
  const preset = Rules.presets()[g.options.preset];
  const user = "GRID SUMMARY (JSON; one grid unit is 5 light-years; coordinates are x,y,z):\n" + JSON.stringify(summary)
    + "\n\nFACTIONS (use these keys):\n" + factionBrief()
    + "\n\nCAPTAINS:\n" + rosterBrief(w, g)
    + `\n\nThe campaign has exactly ${preset.critical} critical missions including the finale, so write an arc of exactly ${preset.critical} beats.`;
  let story = null;
  let error = "";
  for (let attempt = 0; attempt < 2 && !story; attempt++) {
    const res = await w.llm.call("story", Prompts.storySystem(), user + (error ? `\n\nYour previous reply was rejected: ${error} Correct this.` : ""), { json: true, schema: Prompts.storySchema(), maxTokens: 16000, store: w.store, gameId: g.id });
    if (isErr(res)) {
      g.gen.error = res.message;
      return g;
    }
    [story, error] = Prompts.validateStory(res.json, grid);
    if (story && story.arc.length !== Rules.intval(preset.critical)) {
      error = "The arc had " + story.arc.length + ` beats; exactly ${preset.critical} are required.`;
      story = null;
    }
  }
  if (!story) {
    g.gen.error = "The story could not be generated: " + error;
    return g;
  }
  if (!story.start_sector) story.start_sector = summary.notable[0]?.coord ?? "0,0,0";
  g.story = story;

  // Factions the story uses, with territory painted onto the grid by region.
  for (const [key, f] of Object.entries(story.factions)) {
    if (!g.factions[key]) g.factions[key] = { key, name: f.name, standing: 0, met: false, dir: 0, reason: "", note: f.role, new: true, justification: f.justification };
    g.factions[key].active = true;
    g.factions[key].role = f.role;
    g.factions[key].goals = f.goals;
  }
  const owner = {};
  for (const [key, f] of Object.entries(story.factions)) for (const rid of f.regions) if (!owner[rid]) owner[rid] = key;
  if (Object.keys(owner).length) {
    const rows = w.store.sectors(g.id);
    for (const coord of Object.keys(grid.sectors)) {
      const rid = Grid.regionId(grid.size, Grid.parseCoord(coord));
      if (owner[rid] && rows[coord]) rows[coord].faction = owner[rid];
    }
    w.store.replaceSectors(g.id, rows);
  }
  for (const [coord, p] of Object.entries(story.places)) Game.markSector(w, g.id, coord, 0, grid.size, { place: p.name, place_note: p.description });
  for (const n of story.npcs) w.store.canonSet(g.id, "npc", "npc_" + sanitizeKey(n.name), Object.assign({}, n, { attitude: "", met_at: "" }), { faction: n.faction });
  g.gen.phase = 2;
  w.store.event(g.id, 0, "system", { what: "phase_2_story", title: story.title, factions: Object.keys(story.factions) });
  return g;
}

/* ---------- phase 3: the missions ---------- */

function storyBrief(g) {
  const s = g.story;
  const f = Object.entries(s.factions).map(([key, x]) => `${key} (${x.name}): ${x.role} Goals: ${x.goals}`);
  const p = Object.entries(s.places).map(([coord, x]) => `${coord} ${x.name}: ${x.description}`);
  const n = s.npcs.map(x => `${x.name} (${x.gender}, ${x.faction}): ${x.role}`);
  return `STORY: ${s.title}\nPremise: ${s.premise}\nArc:\n- ` + s.arc.join("\n- ") + `\nEnding: ${s.ending}\nStart sector: ${s.start_sector}\nFactions:\n` + f.join("\n") + "\nPlaces:\n" + p.join("\n") + "\nCharacters:\n" + n.join("\n");
}

async function phaseMissions(w, g) {
  const grid = gridFor(g);
  const caps = Game.captains(w, g.id);
  const roster = caps.size;
  const critical = g.story.arc.length;
  const side = Math.max(2, Math.round(critical * 1.5)); // TUNABLE: side missions per campaign.
  const user = storyBrief(g) + "\n\nGRID SUMMARY (JSON):\n" + JSON.stringify(Grid.summarise(grid)) + `\n\nGrid size is ${grid.size} per axis; coordinates run from 0 to ` + (grid.size - 1) + ".";
  let clean = [];
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await w.llm.call("missions", Prompts.missionsSystem(critical, side, roster), user + (error ? `\n\nYour previous reply was rejected: ${error} Correct this.` : ""), { json: true, schema: Prompts.missionsSchema(), maxTokens: 32000, store: w.store, gameId: g.id });
    if (isErr(res)) {
      g.gen.error = res.message;
      return g;
    }
    clean = [];
    for (const m of toList(res.json?.missions ?? [])) {
      const v = Prompts.validateMission(m, grid.size, roster);
      if (v) clean.push(v);
    }
    const crit = clean.filter(m => m.is_critical);
    let bad = "";
    crit.forEach((cm, i) => {
      // A critical mission may only depend on an earlier one, so the campaign can never deadlock.
      if (cm.depends_on !== null && (cm.depends_on < 0 || cm.depends_on >= i)) bad = 'Critical mission "' + cm.title + '" had a depends_on that did not point to an earlier critical mission.';
    });
    if (crit.length === critical && bad === "") break;
    error = bad !== "" ? bad : "It contained " + crit.length + ` valid critical missions; exactly ${critical} are required.`;
    clean = [];
  }
  if (!clean.length) {
    g.gen.error = "The missions could not be generated: " + error;
    return g;
  }
  // Side missions are the main source of items (§7.3). If any were invalid, top the set up rather than start short.
  const countSide = list => list.filter(m => !m.is_critical).length;
  for (let attempt = 0; attempt < 2 && countSide(clean) < side; attempt++) {
    const need = side - countSide(clean);
    const have = clean.map(m => m.title).join("; ");
    const res = await w.llm.call("missions", Prompts.missionsSystem(0, need, roster), user + `\n\nThese missions already exist, so do not repeat them: ${have}.\nWrite only ${need} more side missions.`, { json: true, schema: Prompts.missionsSchema(), maxTokens: 16000, store: w.store, gameId: g.id });
    if (isErr(res)) continue;
    for (const m of toList(res.json?.missions ?? [])) {
      const v = Prompts.validateMission(m, grid.size, roster);
      if (v && !v.is_critical && countSide(clean) < side && !clean.map(x => x.title).includes(v.title)) clean.push(v);
    }
  }
  if (countSide(clean) < side) {
    g.gen.error = "Only " + countSide(clean) + ` of ${side} side missions could be generated.`;
    return g;
  }
  // Exactly one finale: the last critical mission, which needs every captain (§6.3).
  let last = null;
  clean.forEach((m, i) => {
    if (m.is_critical) {
      m.is_final = false;
      last = i;
    }
  });
  clean[last].is_final = true;
  clean[last].min_captains_required = Math.min(3, roster);
  const critIndex = [];
  let spine = 0;
  for (const m of clean) {
    const mid = Game.addMission(w, g.id, m, m.is_critical ? ++spine : 0);
    if (m.is_critical) critIndex.push(mid);
    m.id = mid;
    for (const s of m.stages) {
      for (const n of s.npcs) w.store.canonSet(g.id, "npc", "npc_" + sanitizeKey(n.name), Object.assign({}, n, { attitude: "", met_at: "" }), { faction: n.faction, mission_id: mid });
    }
  }
  // depends_on is an index into the critical list; store it as a mission id.
  for (const row of Game.missions(w, g.id).values()) {
    const dep = row.data.depends_on;
    row.data.depends_on = row.is_critical && dep !== null && critIndex[dep] !== undefined && critIndex[dep] !== row.id ? critIndex[dep] : null;
    Game.saveMission(w, row);
  }
  // Everyone begins together in the start sector, each as a party of one.
  const start = g.story.start_sector;
  for (const [cid, c] of caps) {
    const pid = "p" + cid;
    g.parties[pid] = Game.newParty(pid, cid, start);
    c.state.party = pid;
    c.state.summary = "";
    Game.saveCaptain(w, c);
  }
  Game.markSector(w, g.id, start, 2, grid.size);
  g.status = "active";
  g.gen.phase = 3;
  w.store.event(g.id, 0, "system", { what: "phase_3_missions", missions: clean.length, critical: critIndex.length });
  w.store.event(g.id, 0, "notice", { text: g.story.public_brief, audience: "all", speaker: setting.FLEET_COMMAND, say: true });
  g.leads = [];
  [g] = Game.openLeads(w, g); // the opening orders point to where the story begins
  return g;
}

/* ---------- later calls ---------- */

/* Bridge mission for a failed critical mission (§6.4). Returns the new mission's id or a GdError. */
async function bridge(w, g, failed, whatWentWrong) {
  const grid = gridFor(g);
  const roster = Game.captains(w, g.id).size;
  const bridges = Rules.intval(failed.data.progress?.bridges ?? 0) + 1;
  const canon = w.store.canon(g.id, { kind: ["fact", "agreement", "event"], limit: 30 }).map(row => "- " + (row.data.text ?? ""));
  const data = Object.assign({}, failed.data);
  delete data.progress;
  const user = storyBrief(g) + "\n\nFAILED MISSION (JSON):\n" + JSON.stringify(data)
    + "\n\nWHAT WENT WRONG:\n" + whatWentWrong + "\n\nWORLD CANON:\n" + canon.join("\n")
    + `\n\nBRIDGE COUNT: ${bridges}\n\nGRID SUMMARY (JSON):\n` + JSON.stringify(Grid.summarise(grid, 25));
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await w.llm.call("bridge", Prompts.bridgeSystem(), user, { json: true, schema: Prompts.missionSchema(), maxTokens: 12000, store: w.store, gameId: g.id });
    if (isErr(res)) return res;
    const m = Prompts.validateMission(res.json, grid.size, roster);
    if (m) {
      m.kind = "main";
      m.is_critical = true;
      m.is_final = !!failed.is_final;
      m.depends_on = failed.data.depends_on ?? null;
      m.bridge_of = failed.id;
      const mid = Game.addMission(w, g.id, m, Rules.intval(failed.spine)); // inherits its place in the spine
      const row = Game.missions(w, g.id).get(mid);
      row.data.progress.bridges = bridges;
      Game.saveMission(w, row);
      // Anything that depended on the failed mission now depends on its bridge.
      for (const other of Game.missions(w, g.id).values()) {
        if (Rules.intval(other.data.depends_on ?? 0) === Rules.intval(failed.id)) {
          other.data.depends_on = mid;
          Game.saveMission(w, other);
        }
      }
      w.store.event(g.id, 0, "system", { what: "bridge_mission", failed: failed.id, bridge: mid, count: bridges });
      return mid;
    }
  }
  return fail("gd_bridge", "A bridging mission could not be generated.");
}

/* Recovery stage after the first failed stage of a mission (§7.6). Returns a stage, or null. */
async function recoveryStage(w, g, mission, stage, whatWentWrong) {
  const user = "MISSION: " + mission.data.title + "\n" + mission.data.briefing + "\n\nFAILED STAGE (JSON):\n" + JSON.stringify(stage) + "\n\nWHAT WENT WRONG:\n" + whatWentWrong;
  let st = null;
  for (let attempt = 0; attempt < 2 && !st; attempt++) {
    const res = await w.llm.call("bridge", Prompts.recoverySystem(), user, { json: true, schema: Prompts.recoveryStageSchema(), maxTokens: 12000, store: w.store, gameId: g.id });
    st = isErr(res) ? null : Prompts.validateStage(res.json);
  }
  if (!st) return null; // no stock stage: the caller holds the mission and tries again
  st.recovery = true;
  return st;
}

/* A random encounter generated on demand from the sector and story (§5.3). Returns its mission id, or null. */
async function randomEncounter(w, g, coord, sec) {
  const grid = gridFor(g);
  const user = storyBrief(g) + `\n\nSECTOR ${coord} (JSON):\n` + JSON.stringify(sec.data) + "\nControlling faction: " + (sec.faction || "none") + `\nThe mission's sector must be "${coord}".`;
  let m = null;
  for (let attempt = 0; attempt < 2 && !m; attempt++) {
    const res = await w.llm.call("random", Prompts.randomSystem(), user, { json: true, schema: Prompts.missionSchema(), maxTokens: 16000, store: w.store, gameId: g.id });
    m = isErr(res) ? null : Prompts.validateMission(res.json, grid.size, 1);
  }
  if (!m) return null; // an optional encounter that could not be written simply does not occur
  m.kind = "random";
  m.is_critical = false;
  m.is_final = false;
  m.sector = coord;
  m.stages = m.stages.slice(0, 2);
  return Game.addMission(w, g.id, m, 0);
}

/* Reward items for a mission, picked from the catalogue to the mission's budget (§7.3). Deterministic for a given
   game seed and mission id. */
function rewardItems(g, mission) {
  const r = mission.data.reward;
  const out = [];
  const tier = { standard: 0, advanced: 1, prototype: 2 }[r.rarity];
  const pick = (ids, salt) => (ids.length ? ids[hashPick(g.seed + ":" + mission.id + ":" + salt) % ids.length] : null);
  for (let i = 0; i < Rules.intval(r.consumables); i++) {
    // The first consumable matches the mission's rarity (never prototype by default); the rest are standard.
    const rar = i === 0 && tier >= 1 ? "advanced" : "standard";
    out.push(pick(Rules.itemIdsBy(rar, "consumable"), "c" + i));
  }
  if (tier >= 2 && r.consumables > 0 && mission.kind !== "side") out.push(pick(Rules.itemIdsBy("prototype", "consumable"), "p"));
  if (Rules.intval(r.equipment) > 0) out.push(pick(Rules.itemIdsBy(tier >= 2 ? "prototype" : "advanced", "equipment"), "e"));
  return out.filter(Boolean);
}

module.exports = { gridFor, step, bridge, recoveryStage, randomEncounter, rewardItems, storyBrief };
