"use strict";
/* The resolution engine (§7.2.2), ported from the plugin's class-engine.php. Pure maths: no LLM, no I/O.
   The LLM interprets and narrates; this module decides. Function names are camelCase; the PHP name is noted where
   it differs. Option and result objects keep the plugin's snake_case keys. */
const crypto = require("crypto");
const Rules = require("./rules.js");

const { intval } = Rules;
const own = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
/* PHP's empty(): true for undefined, null, false, 0, "", "0" and an empty list. */
const empty = v => v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0);
const OUTCOMES = Object.freeze(["critical_success", "success", "partial", "failure"]);

/* ---------- Dice ---------- */

/* PHP: new_seed(). A fresh seed for a system roll. Stored in the event log so the roll can be recomputed (§11.1). */
function newSeed() {
  return crypto.randomBytes(16).toString("hex");
}

/* PHP: d20_from_seed(). Deterministic, unbiased d20 from a stored seed. */
function d20FromSeed(seed) {
  let i = 0;
  let n;
  do {
    const h = crypto.createHash("sha256").update(Rules.phpStrval(seed) + ":" + i, "utf8").digest("hex");
    n = parseInt(h.slice(0, 7), 16); // 28 bits
    i++;
  } while (n >= 268435440); // largest multiple of 20 below 2^28
  return (n % 20) + 1;
}

/* PHP: valid_die(). Physical dice entry: integer 1-20 only (§7.2.5). Returns the number or null.
   A whole JavaScript number counts as an integer (PHP would refuse a float such as 7.0). */
function validDie(value) {
  // PHP's /^\d{1,2}$/ also matches before one trailing newline.
  if ((typeof value === "number" && Number.isInteger(value)) || (typeof value === "string" && /^\d{1,2}\n?$/.test(value))) {
    const n = intval(value);
    return n >= 1 && n <= 20 ? n : null;
  }
  return null;
}

/* ---------- Difficulty ---------- */

/* PHP: band_index() */
function bandIndex(band) {
  const i = Object.keys(Rules.bands()).indexOf(band);
  return i === -1 ? 1 : i;
}

/* PHP: band_at() */
function bandAt(index) {
  const keys = Object.keys(Rules.bands());
  return keys[Math.max(0, Math.min(keys.length - 1, intval(index)))];
}

/* PHP: shift_band() */
function shiftBand(band, steps) {
  return bandAt(bandIndex(band) + intval(steps));
}

/* PHP: clamp_band(). Call A may move one band from the stage's declared baseline; anything further is clamped
   (§7.2.2 defence 2). */
function clampBand(baseline, proposed) {
  const b = bandIndex(baseline);
  const p = bandIndex(proposed);
  return bandAt(Math.max(b - 1, Math.min(b + 1, p)));
}

/* PHP: final_band(). Final band after the rules' own shifts, applied after the clamp so they are always felt.
   ctx keys (all optional): ignoring_threat, missing_helper, standing_step, is_diplomacy, item_band_shift, cold_climax. */
function finalBand(baseline, proposed, ctx = {}) {
  const band = clampBand(baseline, proposed);
  if (!empty(ctx.ignoring_threat)) return "desperate"; // §7.2.3 flat desperate before Momentum.
  let shift = 0;
  if (!empty(ctx.missing_helper)) shift++; // §3.5 one band up for the rest of the stage.
  if (!empty(ctx.is_diplomacy) && ctx.standing_step !== undefined && ctx.standing_step !== null) {
    if (ctx.standing_step === "Hostile") shift++;
    else if (ctx.standing_step === "Allied") shift--;
  }
  if (!empty(ctx.item_band_shift)) shift--;
  if (!empty(ctx.cold_climax)) shift++; // §14.5 rule 4: a climax attempted with no Momentum built is one band harder.
  return shiftBand(band, shift);
}

/* DC = band value, less Momentum at a climax or a threat response (§7.2.2, §7.2.3). */
function dc(band, momentum = 0, applyMomentum = false) {
  const bands = Rules.bands();
  const value = own(bands, band) ? bands[band] : bands.tricky;
  return applyMomentum ? value - intval(momentum) : value;
}

/* ---------- Modifier and outcome ---------- */

/* PHP: ship_bonus(). What the ship adds to a matching roll: +1 for every 10 points in the attribute (§14.5 rule 2). */
function shipBonus(shipAttributeValue) {
  return Math.floor(Math.max(0, intval(shipAttributeValue)) / 10);
}

/* modifier = floor(effective attribute / 2) + item bonus - injury penalty - situational penalty.
   The species bonus is already inside the effective attribute. */
function modifier(attributeValue, itemBonus = 0, injuryPenalty = 0, situationalPenalty = 0) {
  return Math.floor(Math.max(0, intval(attributeValue)) / 2) + intval(itemBonus) - intval(injuryPenalty) - intval(situationalPenalty);
}

/* Four outcome bands (§7.2.2). Natural 20 and natural 1 override the sum. Returns { outcome, total, margin }. */
function outcome(roll, mod, target) {
  roll = intval(roll);
  const total = roll + intval(mod);
  const margin = total - intval(target);
  let band;
  if (roll === 20) band = "critical_success";
  else if (roll === 1) band = "failure";
  else if (margin >= 5) band = "critical_success";
  else if (margin >= 0) band = "success";
  else if (margin >= -4) band = "partial";
  else band = "failure";
  return { outcome: band, total, margin };
}

/* PHP: needed_face(). The face the die must show to succeed, for the pre-roll readout (§7.2.5). Null if only a
   natural 20 will do. */
function neededFace(mod, target) {
  const need = intval(target) - intval(mod);
  if (need > 20) return null;
  return Math.max(2, need); // a natural 1 always fails
}

/* PHP: threat_result(). Threat outcome read through the Captain's result (§7.2.3). */
function threatResult(result) {
  const map = {
    critical_success: "fails_completely",
    success: "fails",
    partial: "partly_succeeds",
    failure: "succeeds"
  };
  return own(map, result) ? map[result] : "succeeds";
}

/* ---------- Momentum (§7.2.7) ---------- */

/* PHP: clamp_momentum() */
function clampMomentum(m) {
  return Math.max(Rules.MOMENTUM_MIN, Math.min(Rules.MOMENTUM_MAX, intval(m)));
}

/* PHP: apply_momentum(). Apply one rolled result to a stage's Momentum.
   Anti-grinding: gains only once per distinct action_class per stage, and only when the action advances the stage.
   Failures always cost. used: action classes that have already granted Momentum this stage.
   Returns { momentum, used, delta }; used is a new list. */
function applyMomentum(momentum, used, result, actionClass, advancesStage) {
  const gain = { critical_success: 2, success: 1, partial: 0, failure: -1 };
  used = used.slice();
  let delta = own(gain, result) ? gain[result] : 0;
  if (delta > 0) {
    if (!advancesStage || used.includes(actionClass)) delta = 0;
    else used.push(actionClass);
  }
  const next = clampMomentum(intval(momentum) + delta);
  return { momentum: next, used, delta: next - intval(momentum) };
}

/* PHP: carry_momentum(). Momentum carried into the next stage: +1 for a critical climax, +1 for 8 or more unspent
   points, capped at +2 (§7.6). */
function carryMomentum(climaxOutcome, pointsLeft) {
  let m = 0;
  if (climaxOutcome === "critical_success") m++;
  if (intval(pointsLeft) >= 8) m++;
  return Math.min(2, m);
}

/* ---------- Stage flow (§7.6) ---------- */

/* PHP: climax_forced(). Points have run out when what is left is below the cost of the climax. */
function climaxForced(pointsLeft) {
  return intval(pointsLeft) < Rules.climaxCost();
}

/* PHP: adaptive_shift(). Adaptive layer: shift for the next stage's baseline from recent climax results, newest last.
   Two failed or partial in a row eases one band; three critical successes in a row raises one band. */
function adaptiveShift(recent) {
  const n = recent.length;
  const poor = o => o === "failure" || o === "partial";
  if (n >= 2 && poor(recent[n - 1]) && poor(recent[n - 2])) return -1;
  if (n >= 3 && recent[n - 1] === "critical_success" && recent[n - 2] === "critical_success" && recent[n - 3] === "critical_success") return 1;
  return 0;
}

/* ---------- Injury (§7.5) ---------- */

/* PHP: injury_from(). Injury from a failed or partial result, severity scaled to the miss.
   risk comes from adjudication: none | low | high.
   TUNABLE thresholds: partial -> light (high risk only); failure -> light/serious/critical by margin. */
function injuryFrom(result, margin, risk) {
  if (risk === "none" || (result !== "partial" && result !== "failure")) return null;
  if (result === "partial") return risk === "high" ? "light" : null;
  const miss = Math.max(0, -intval(margin)); // a natural 1 on a strong total is a failure, not a wide miss
  if (risk === "high") {
    if (miss >= 10) return "critical";
    return miss >= 7 ? "serious" : "light";
  }
  return miss >= 10 ? "serious" : "light";
}

/* PHP: recovery_turns(). recovery_turns = base - floor(medic skill / 3) - item reduction - captain decision
   reduction, minimum 1. */
function recoveryTurns(severity, medicAttr, itemReduction = 0, decisionReduction = 0) {
  const sev = Rules.severities();
  const base = own(sev, severity) ? sev[severity] : 3;
  return Math.max(1, base - Math.floor(Math.max(0, intval(medicAttr)) / 3) - intval(itemReduction) - intval(decisionReduction));
}

/* ---------- Crew helpers ---------- */

/* PHP's (array) cast of a value: a list stays as it is, an object gives its values, null nothing, a scalar itself. */
function asList(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object") return Object.values(v);
  return [v];
}

/* PHP: effective_attrs(). Effective attributes for one officer: allocated + species bonus (inert where the officer
   lacks the attribute, §4.3 option A). Returns attribute => { base, bonus, value }. */
function effectiveAttrs(officer) {
  const roleDefs = Rules.roles();
  const speciesList = Rules.species();
  const ownAttrs = own(roleDefs, officer.role) ? roleDefs[officer.role].attrs : [];
  const sp = officer.species ?? "";
  const bonus = own(speciesList, sp) && speciesList[sp].bonus ? speciesList[sp].bonus : {};
  const attrs = officer.attrs && typeof officer.attrs === "object" ? officer.attrs : {};
  const out = {};
  for (const a of ownAttrs) {
    out[a] = { base: intval(own(attrs, a) ? attrs[a] ?? 0 : 0), bonus: intval(own(bonus, a) ? bonus[a] ?? 0 : 0) };
  }
  if (sp === "Human") {
    for (const a of asList(officer.human_bonus)) {
      if (typeof a === "string" && own(out, a)) out[a].bonus++;
    }
  }
  for (const a of Object.keys(out)) out[a].value = out[a].base + out[a].bonus;
  return out;
}

/* PHP: resolve_actor(). Who actually makes a roll, given injuries (§7.5).
   A fit officer uses the named attribute. If they are out of commission another officer covers using Composure;
   Science covers an injured medic through shared Xenology at a penalty.
   crew: role => officer (with optional injury). Returns { role, attribute, value, penalty, covering } or null when
   nobody is fit. */
function resolveActor(crew, role, attribute) {
  const roleDefs = Rules.roles();
  if (!own(roleDefs, role)) {
    [role, attribute] = bestHolder(crew, attribute) ?? ["first_officer", "composure"];
  }
  if (!roleDefs[role].attrs.includes(attribute)) {
    const holder = bestHolder(crew, attribute);
    if (holder) [role, attribute] = holder;
    else attribute = "composure";
  }
  const fit = r => own(crew, r) && crew[r] !== null && crew[r] !== undefined && empty(crew[r].injury);
  if (fit(role)) {
    const eff = effectiveAttrs(crew[role]);
    return { role, attribute, value: eff[attribute].value, penalty: 0, covering: false };
  }
  if (role === "medical" && fit("science")) {
    const eff = effectiveAttrs(crew.science);
    return { role: "science", attribute: "xenology", value: eff.xenology.value, penalty: Rules.MEDIC_COVER_PENALTY, covering: true };
  }
  let best = null;
  for (const r of Object.keys(roleDefs)) {
    if (r === role || !fit(r)) continue;
    const v = effectiveAttrs(crew[r]).composure.value;
    if (best === null || v > best.value) best = { role: r, attribute: "composure", value: v, penalty: 0, covering: true };
  }
  return best;
}

/* PHP: best_holder(). The officer with the highest effective value in an attribute, as [role, attribute], or null.
   As in the plugin, injuries are not considered here; resolveActor() deals with them. */
function bestHolder(crew, attribute) {
  let best = null;
  let top = -1;
  for (const [r, def] of Object.entries(Rules.roles())) {
    if (!own(crew, r) || crew[r] === null || crew[r] === undefined || !def.attrs.includes(attribute)) continue;
    const v = effectiveAttrs(crew[r])[attribute].value;
    if (v > top) {
      top = v;
      best = [r, attribute];
    }
  }
  return best;
}

/* ---------- One call that resolves a rolled turn ---------- */

/* Resolve a rolled action. Both dice modes converge here: only the source of roll differs (§7.2.5).
   p: attribute_value, item_bonus, injury_penalty, situational_penalty, band, momentum, apply_momentum, roll. */
function resolve(p) {
  const mod = modifier(p.attribute_value ?? 0, p.item_bonus ?? 0, p.injury_penalty ?? 0, p.situational_penalty ?? 0);
  const target = dc(p.band ?? "tricky", p.momentum ?? 0, !empty(p.apply_momentum));
  const res = outcome(p.roll, mod, target);
  return {
    roll: intval(p.roll),
    modifier: mod,
    dc: target,
    band: p.band ?? "tricky",
    total: res.total,
    margin: res.margin,
    outcome: res.outcome
  };
}

/* Pre-roll readout shown in both dice modes (§7.2.5). */
function preview(p) {
  const mod = modifier(p.attribute_value ?? 0, p.item_bonus ?? 0, p.injury_penalty ?? 0, p.situational_penalty ?? 0);
  const target = dc(p.band ?? "tricky", p.momentum ?? 0, !empty(p.apply_momentum));
  return {
    modifier: mod,
    dc: target,
    band: p.band ?? "tricky",
    momentum_applied: !empty(p.apply_momentum) ? intval(p.momentum ?? 0) : 0,
    needed_face: neededFace(mod, target)
  };
}

module.exports = {
  OUTCOMES, newSeed, d20FromSeed, validDie, bandIndex, bandAt, shiftBand, clampBand, finalBand, dc, shipBonus,
  modifier, outcome, neededFace, threatResult, clampMomentum, applyMomentum, carryMomentum, climaxForced,
  adaptiveShift, injuryFrom, recoveryTurns, effectiveAttrs, resolveActor, bestHolder, resolve, preview
};
