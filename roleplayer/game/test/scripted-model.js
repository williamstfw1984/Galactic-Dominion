"use strict";
/* The scripted stand-in for the model and the safety check, used by the end-to-end test and by the development
   harness that plays the real interface against the real server without the AI engine. The kind of call is read
   from its system prompt. */
/* ---------------------------------------------------------------- the scripted model */
const M = { A: [], B: [], calls: [], Buser: [], Suser: [], FAIL: {}, DOWN: false, NOLEADS: false, SETTLE: null, RANDOM: false, start: "1,1,1" };
const DEFAULT_A = { understood_as: "x", action_class: "other", tier: 2, officer: "science", attribute: "sensor_analysis", difficulty_band: "tricky", difficulty_reason: "r", is_stage_climax: false, impossible: false, impossible_reason: null, advances_stage: true, intent: "action", responds_to_threat: false, injury_risk: "none", captain_decision: "none", target_officer: null, target_faction: null, target_captains: [], destination: null, item: null, query_subject: null };
const A = o => M.A.push(Object.assign({}, DEFAULT_A, o));
const stage = (t, threat = null) => ({ title: t, situation: "sit", objective: "obj", obstacle_band: "tricky", climax: "do the thing", climax_band: "tricky", threat, contacts: [{ name: "Veil cutter Tal", kind: "ship", faction: "seluun", posture: "Wary", position: "off the bow" }], npcs: [{ name: "Commander Velal", gender: "Female", faction: "seluun", role: "cutter commander", manner: "cold" }] });
function mission(t, sector, crit, n = 2, extra = {}) {
  const s = [];
  for (let i = 0; i < n; i++) s.push(stage(`${t} stage ${i + 1}`));
  return Object.assign({ title: t, kind: crit ? "main" : "side", is_critical: crit, is_final: false, min_captains_required: 1, sector, briefing: "brief", lead: crit ? `Lead to ${t}.` : null, on_abandon: "resumable", expiry_turns: null, depends_on: null, standing: { on_success: [{ faction: "seluun", change: "improve_strongly" }], on_failure: [{ faction: "seluun", change: "worsen" }] }, reward: { consumables: 2, equipment: 1, rarity: "advanced", story_item: crit ? null : "Survey beacon" }, stages: s }, extra);
}
function kind(system) {
  if (system.startsWith("You are the adjudicator")) return "call_a";
  if (system.startsWith("You voice the bridge")) return "call_b";
  if (system.includes("You design the campaign story")) return "story";
  if (system.includes("needs a LEAD")) return "missions";
  if (system.includes("You write the missions")) return "missions";
  if (system.includes("recovery stage")) return "bridge";
  if (system.includes("has failed")) return "bridge";
  if (system.includes("emergent encounter")) return "random";
  if (system.includes("running campaign summary")) return "summary";
  if (system.includes("starship details")) return "flavour";
  return "other";
}
function reply(type, system, user) {
  M.calls.push(type);
  if (M.DOWN) throw new Error("Could not reach the engine.");
  if (M.FAIL[type] && (type !== "bridge" || M.FAIL.bridge === (system.includes("recovery stage") ? "recovery" : "bridge"))) return { garbage: true };
  switch (type) {
    case "story": {
      const m = /"notable":\[\{"coord":"([0-9,]+)"/.exec(user);
      M.start = m ? m[1] : "1,1,1";
      return { title: "The Quiet Border", premise: "p", public_brief: "Brief for all captains.", arc: ["one", "two", "three"], ending: "Peace holds.", start_sector: M.start, factions: [{ key: "seluun", name: "x", new: false, justification: null, role: "rival", goals: "g", regions: ["r-0-0-0"] }, { key: "veil", name: "The Shroud", new: true, justification: "needed", role: "unknown", goals: "g", regions: [] }], places: [{ coord: M.start, name: "Haven Station", description: "hub" }], npcs: [{ name: "Admiral Rhos", gender: "Male", faction: "concord", role: "co", manner: "brisk" }] };
    }
    case "missions": {
      if (system.includes("needs a LEAD")) {
        if (M.NOLEADS) return { leads: [] };
        return { leads: [...user.matchAll(/MISSION id (\d+):/g)].map(x => ({ id: Number(x[1]), lead: `Written later for ${x[1]}.` })) };
      }
      const s = M.start;
      const mm = /and (\d+) optional side missions/.exec(system);
      if (system.includes("exactly 0 critical") && mm) {
        const o = [];
        for (let i = 0; i < Number(mm[1]); i++) o.push(mission("Extra Side " + (i + 1) + "-" + require("crypto").createHash("md5").update(user).digest("hex").slice(0, 4), s, false, 1));
        return { missions: o };
      }
      return { missions: [mission("Crit One", s, true, 2, { stages: [stage("C1S1", { description: "A Veil cutter drops its shroud", after_turns: 1, foreseeable_by: ["scan"] }), stage("C1S2")] }), mission("Crit Two", s, true, 1, { on_abandon: "fail", min_captains_required: 2 }), mission("Finale", s, true, 1), mission("Side A", s, false, 1)] };
    }
    case "call_a": return M.A.shift() || { bad: 1 };
    case "call_b": {
      M.Buser.push(user);
      if (M.B.length) return M.B.shift();
      const named = [...user.matchAll(/item key "([a-z_]+)"/g)].map(x => ({ item: x[1], name: "Recovered " + x[1], description: "Pulled from the wreck." }));
      const settle = [];
      const am = /\[agreement #(\d+), still open\]/.exec(user);
      if (M.SETTLE && am) settle.push({ id: Number(am[1]), outcome: M.SETTLE });
      const wm = /speaker_id "([a-z_]+)" \((officer|computer)\)/.exec(user);
      const who = wm ? [wm[2], wm[1]] : ["computer", "computer"];
      return { npcs: [{ name: "Commander Velal", gender: "Female", faction: "seluun", attitude: "cold", role: "commander" }], lines: [{ speaker_type: who[0], speaker_id: who[1], speaker_name: "x", line: "Done, Captain." }, { speaker_type: "npc", speaker_id: "x", speaker_name: "Commander Velal", line: "State your business." }], contacts: [{ name: "Veil cutter Tal", kind: "ship", identified: true, faction: "seluun", posture: "Hostile", position: "aft", gone: false }], channel: { open: true, with: "Commander Velal", faction: "seluun", attitude: "cold" }, scan: { target: "contact", subject: "Veil cutter Tal", text: "Shields up." }, canon: [{ kind: "agreement", subject: "Velal", text: "Captain promised to withdraw by dawn.", faction: "seluun" }], items: named, resolved: settle };
    }
    case "bridge": return system.includes("recovery stage") ? stage("Recovery") : mission("Bridge Mission", M.start, true, 1);
    case "summary": M.Suser.push(user); return "Summary so far.";
    case "flavour": return { class: "Harrow class", registry: "CR-7001" };
    case "random": return M.RANDOM ? mission("Chance Meeting", M.start, false, 1) : { x: 1 };
  }
  return { x: 1 };
}
const asText = v => (typeof v === "string" ? v : JSON.stringify(v));
const chat = async ({ messages }) => asText(reply(kind(messages[0].content), messages[0].content, messages[1].content));
const chatStream = async ({ messages, onText, signal }) => {
  const text = asText(reply(kind(messages[0].content), messages[0].content, messages[1].content));
  for (let i = 0; i < text.length; i += 37) {
    if (signal && signal.aborted) throw new Error("aborted");
    onText(text.slice(i, i + 37));
    await new Promise(r => setImmediate(r));
  }
  return text;
};

/* ---------------------------------------------------------------- the scripted safety check */
const SAFE = { down: false, checked: [] };
async function safety({ fromUser, text }) {
  SAFE.checked.push({ fromUser, text });
  if (SAFE.down) throw new Error("the classifier could not be loaded");
  return fromUser ? /hurt myself/i.test(text) : /FLAGGED-LINE/.test(text);
}

const VOICES = ["af_heart", "af_bella", "bf_emma", "af_nicole", "bf_isabella", "af_sarah", "bf_alice", "af_sky", "am_michael", "am_fenrir", "bm_george", "am_puck", "bm_fable", "bm_lewis", "am_echo", "am_adam", "bm_daniel", "am_eric"]
  .map(id => ({ id, name: id.slice(3), gender: id[1] === "f" ? "female" : "male", accent: id[0] === "a" ? "American" : "British", needs: [] }));


module.exports = { M, A, DEFAULT_A, stage, mission, kind, reply, chat, chatStream, SAFE, safety, VOICES };
