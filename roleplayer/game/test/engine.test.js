"use strict";
/* Ported from the plugin's tests/test-engine.php. */
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../engine.js");
const R = require("../rules.js");

test("modifier: brief examples attr 6 -> +3, 12 -> +6, 15 -> +7", () => {
  assert.equal(E.modifier(6), 3, "mod 6");
  assert.equal(E.modifier(12), 6, "mod 12");
  assert.equal(E.modifier(15), 7, "mod 15");
  assert.equal(E.modifier(10, 2, 1, 2), 4, "mod with item, injury, situational");
});

test("DC and Momentum", () => {
  assert.equal(E.dc("hard", 4, false), 18, "momentum ignored outside climax");
  assert.equal(E.dc("hard", 4, true), 14, "hard climax with +4 momentum");
  assert.equal(E.dc("hard", -3, true), 21, "negative momentum raises DC");
});

test("outcome bands", () => {
  assert.equal(E.outcome(15, 4, 14).outcome, "critical_success", "beat by 5");
  assert.equal(E.outcome(10, 4, 14).outcome, "success", "meet DC");
  assert.equal(E.outcome(6, 4, 14).outcome, "partial", "miss by 4");
  assert.equal(E.outcome(5, 4, 14).outcome, "failure", "miss by 5");
  assert.equal(E.outcome(20, 0, 30).outcome, "critical_success", "natural 20");
  assert.equal(E.outcome(1, 20, 5).outcome, "failure", "natural 1");
});

test("band clamp: one band from baseline, and the rules' own shifts", () => {
  assert.equal(E.clampBand("hard", "routine"), "tricky", "clamp down");
  assert.equal(E.clampBand("hard", "desperate"), "desperate", "one up allowed");
  assert.equal(E.clampBand("routine", "desperate"), "tricky", "clamp up");
  assert.equal(E.finalBand("routine", "routine", { ignoring_threat: true }), "desperate", "ignoring a threat is flat desperate");
  assert.equal(E.finalBand("tricky", "tricky", { missing_helper: true }), "hard", "dropped helper: one band up after clamp");
  assert.equal(E.finalBand("tricky", "tricky", { is_diplomacy: true, standing_step: "Allied" }), "routine", "allied eases diplomacy");
  assert.equal(E.finalBand("tricky", "tricky", { is_diplomacy: true, standing_step: "Hostile" }), "hard", "hostile hardens diplomacy");
  assert.equal(E.finalBand("tricky", "tricky", { is_diplomacy: false, standing_step: "Hostile" }), "tricky", "standing only affects diplomacy");
});

test("momentum: values, clamp and anti-grinding", () => {
  let m = E.applyMomentum(0, [], "success", "scan", true);
  assert.equal(m.momentum, 1, "success +1");
  m = E.applyMomentum(m.momentum, m.used, "critical_success", "scan", true);
  assert.equal(m.momentum, 1, "second scan grants nothing");
  m = E.applyMomentum(m.momentum, m.used, "critical_success", "hail", true);
  assert.equal(m.momentum, 3, "crit on a new class +2");
  m = E.applyMomentum(m.momentum, m.used, "success", "repair", false);
  assert.equal(m.momentum, 3, "no gain unless it advances the stage");
  m = E.applyMomentum(m.momentum, m.used, "failure", "scan", true);
  assert.equal(m.momentum, 2, "failure always -1");
  assert.equal(E.applyMomentum(6, [], "critical_success", "attack", true).momentum, 6, "clamped at +6");
  assert.equal(E.applyMomentum(-3, [], "failure", "attack", true).momentum, -3, "clamped at -3");
});

test("carry-over, forced climax, adaptive layer", () => {
  assert.equal(E.carryMomentum("critical_success", 9), 2, "crit + 8 unspent capped at +2");
  assert.equal(E.carryMomentum("success", 8), 1, "8 unspent");
  assert.equal(E.carryMomentum("success", 7), 0, "7 unspent");
  assert.ok(E.climaxForced(2), "below climax cost forces the climax");
  assert.ok(!E.climaxForced(3), "exactly the climax cost does not");
  assert.equal(E.adaptiveShift(["success", "partial", "failure"]), -1, "two poor in a row eases");
  assert.equal(E.adaptiveShift(["critical_success", "critical_success", "critical_success"]), 1, "three crits raises");
  assert.equal(E.adaptiveShift(["failure", "failure", "success"]), 0, "ordinary result returns to normal");
});

test("recovery and injury", () => {
  assert.equal(E.recoveryTurns("light", 12), 1, "light with a good medic");
  assert.equal(E.recoveryTurns("serious", 6), 4, "serious, attr 6");
  assert.equal(E.recoveryTurns("critical", 12), 8, "critical, attr 12");
  assert.equal(E.recoveryTurns("light", 15, 2, 2), 1, "never below 1");
  assert.equal(E.injuryFrom("success", 3, "high"), null, "no injury on success");
  assert.equal(E.injuryFrom("failure", -9, "none"), null, "no injury without risk");
  assert.equal(E.injuryFrom("partial", -2, "high"), "light", "partial, high risk");
  assert.equal(E.injuryFrom("failure", -11, "high"), "critical", "bad miss, high risk");
});

test("dice", () => {
  const seed = "abc123";
  assert.equal(E.d20FromSeed(seed), E.d20FromSeed(seed), "seeded roll is reproducible");
  const counts = new Array(21).fill(0);
  for (let i = 0; i < 20000; i++) counts[E.d20FromSeed("s" + i)]++;
  const faces = counts.slice(1);
  assert.ok(Math.min(...faces) > 850 && Math.max(...faces) < 1150, "d20 is roughly uniform");
  assert.equal(E.validDie("20"), 20, "die 20");
  assert.equal(E.validDie("21"), null, "die 21 rejected");
  assert.equal(E.validDie("0"), null, "die 0 rejected");
  assert.equal(E.validDie("7.5"), null, "non-integer rejected");
  assert.equal(E.validDie("abc"), null, "text rejected");
  assert.match(E.newSeed(), /^[0-9a-f]{32}$/, "a new seed is 16 random bytes in hex");
});

test("d20 from a seed matches the plugin's values", () => {
  // Computed with the PHP engine's d20_from_seed() for the same seeds.
  assert.deepEqual(["abc123", "s0", "s1", "s19999", "seed:with:colons", "Ünï"].map(s => E.d20FromSeed(s)), [7, 7, 17, 8, 6, 11]);
  let x = 0;
  for (let i = 0; i < 20000; i++) x = (x * 31 + E.d20FromSeed("s" + i)) % 1000000007;
  assert.equal(x, 718768813, "a checksum over 20000 seeded rolls matches the plugin's");
});

test("preview: Sensor Analysis 7 -> +3, tricky 14, momentum 2 at a climax -> 12", () => {
  const p = E.preview({ attribute_value: 7, band: "tricky", momentum: 2, apply_momentum: true });
  assert.equal(p.modifier, 3, "preview modifier");
  assert.equal(p.dc, 12, "preview target");
  assert.equal(p.needed_face, 9, "preview needed face");
});

test("crew: species bonus, inert bonus, Human free points, covering", () => {
  const crew = {
    tactical: { role: "tactical", species: "Teneri", attrs: { accuracy: 8, threat_assessment: 6, security: 5, composure: 5 } },
    engineer: { role: "engineer", species: "Ossan", attrs: { repair: 7, power_management: 6, improvisation: 6, composure: 4 }, injury: { severity: "serious", turns_remaining: 4 } },
    science: { role: "science", species: "Seluun", attrs: { sensor_analysis: 9, xenology: 6, improvisation: 5, composure: 5 } },
    first_officer: { role: "first_officer", species: "Human", human_bonus: ["diplomacy", "diplomacy", "composure"], attrs: { command_presence: 8, diplomacy: 7, threat_assessment: 5, composure: 6 } },
    medical: { role: "medical", species: "Teneri", attrs: { triage: 9, psychology: 6, xenology: 7, composure: 5 } },
    helm: { role: "helm", species: "Haldani", attrs: { piloting: 9, navigation: 7, evasion: 5, composure: 4 } }
  };
  assert.equal(E.effectiveAttrs(crew.tactical).accuracy.value, 8, "Teneri tactical: bonus is inert");
  assert.equal(E.effectiveAttrs(crew.science).sensor_analysis.value, 10, "Seluun +1 sensor analysis");
  assert.equal(E.effectiveAttrs(crew.first_officer).diplomacy.value, 9, "Human free points");
  assert.equal(E.effectiveAttrs(crew.medical).xenology.value, 10, "Teneri medic +3 xenology");
  let a = E.resolveActor(crew, "engineer", "repair");
  assert.ok(a.covering && a.attribute === "composure", "injured engineer is covered with Composure");
  assert.equal(a.role, "science", "best Composure covers (tie goes to role order)");
  crew.medical.injury = { severity: "light", turns_remaining: 2 };
  a = E.resolveActor(crew, "medical", "triage");
  assert.deepEqual([a.role, a.attribute, a.penalty], ["science", "xenology", 2], "Science covers the medic via Xenology at a penalty");
  a = E.resolveActor(crew, "science", "diplomacy");
  assert.equal(a.role, "first_officer", "attribute the named officer lacks goes to its holder");
  assert.equal(E.effectiveAttrs(crew.helm).piloting.value, 9, "no species bonus on Piloting");
  assert.equal(E.effectiveAttrs(crew.helm).composure.value, 5, "Haldani helm +1 composure");
  const [dr, da] = R.defaultActor("manoeuvre");
  a = E.resolveActor(crew, dr, da);
  assert.deepEqual([a.role, a.attribute, a.covering], ["helm", "piloting", false], "a manoeuvre is flown by the Helm Officer on Piloting");
  assert.deepEqual(R.defaultActor("retreat"), ["helm", "piloting"], "a retreat is flown by the Helm Officer on Piloting");
  a = E.resolveActor(crew, "tactical", "piloting");
  assert.equal(a.role, "helm", "Piloting asked of another officer goes to the Helm Officer");
});

test("costs, species totals, item effects, standing steps", () => {
  assert.equal(R.cost("information", 0), 0, "tier 0 free");
  assert.equal(R.cost("move", 1), 1, "move 1");
  assert.equal(R.cost("alert_yellow", 1), 1, "yellow 1");
  assert.equal(R.cost("alert_red", 1), 2, "red 2");
  assert.equal(R.cost("advice", 1), 3, "advice 3");
  for (const c of R.actionClasses()) {
    const t2 = R.cost(c, 2);
    assert.ok(c === "advice" || (t2 >= 1 && t2 <= 3), "tier 2 cost in range: " + c);
  }
  assert.ok(R.cost("attack", 3) >= 2 && R.cost("attack", 3) <= 3, "climax cost in range");
  for (const [name, s] of Object.entries(R.species())) {
    assert.equal(Object.values(s.bonus).reduce((x, y) => x + y, 0) + (s.free ?? 0), 3, "species grants +3: " + name);
  }
  for (const [id, it] of Object.entries(R.items())) {
    assert.ok(R.itemEffects().includes(it.effect), "item effect is a closed enum: " + id);
    assert.equal(typeof it.name, "string", "item has a display name: " + id);
  }
  assert.deepEqual([-10, -3, 0, 4, 10].map(R.standingStep), ["Hostile", "Unfriendly", "Neutral", "Cordial", "Allied"], "standing steps");
});

test("ship bonus on matching rolls: +1 per 10 points (brief 14.5 rule 2)", () => {
  assert.equal(E.shipBonus(5), 0, "ship 5");
  assert.equal(E.shipBonus(9), 0, "ship 9");
  assert.equal(E.shipBonus(10), 1, "ship 10");
  assert.equal(E.shipBonus(35), 3, "ship 35");
  assert.deepEqual(R.shipAttributesFor("attack", false, false), ["tactical"], "attack uses Tactical");
  assert.deepEqual(R.shipAttributesFor("board", false, false), ["tactical"], "boarding uses Tactical");
  assert.deepEqual(R.shipAttributesFor("manoeuvre", false, false), ["manoeuvrability"], "manoeuvre uses Manoeuvrability");
  assert.deepEqual(R.shipAttributesFor("scan", false, false), ["sensors"], "scan uses Sensors");
  assert.deepEqual(R.shipAttributesFor("repair", false, false), ["hull_integrity"], "repair uses Hull Integrity");
  assert.deepEqual(R.shipAttributesFor("divert_power", false, false), ["hull_integrity"], "divert power uses Hull Integrity");
  assert.deepEqual(R.shipAttributesFor("manoeuvre", true, false), ["speed"], "retreat uses Speed");
  assert.deepEqual(R.shipAttributesFor("attack", false, true), ["tactical", "defense"], "answering a threat also draws on Defense");
  assert.deepEqual(R.shipAttributesFor("hail", false, true), ["defense"], "a hail answering a threat draws on Defense only");
  assert.deepEqual(R.shipAttributesFor("hail", false, false), [], "hails get no ship bonus");
  assert.deepEqual(R.shipAttributesFor("treat", false, false), [], "treatment gets no ship bonus");
});

test("alerts (brief 14.5 rule 3)", () => {
  assert.equal(R.alertBonus("normal", "attack", true), 0, "no alert, no bonus");
  assert.equal(R.alertBonus("yellow", "attack", true), 1, "yellow answering a threat");
  assert.equal(R.alertBonus("red", "attack", true), 2, "red answering a threat");
  assert.equal(R.alertBonus("red", "attack", false), 0, "red attack with no threat");
  assert.equal(R.alertBonus("yellow", "repair", false), 1, "yellow repair");
  assert.equal(R.alertBonus("red", "treat", false), 2, "red treatment");
  assert.equal(R.alertBonus("red", "repair", true), 4, "red repair answering a threat adds both");
  assert.equal(R.alertBonus("yellow", "hail", false), -1, "yellow hail");
  assert.equal(R.alertBonus("red", "hail", false), -3, "red hail");
  assert.equal(R.alertBonus("red", "hail", true), -1, "red hail answering a threat");
});

test("a cold climax is one band harder (brief 14.5 rule 4)", () => {
  assert.equal(E.finalBand("tricky", "tricky", { cold_climax: true }), "hard", "cold climax one band up");
  assert.equal(E.finalBand("tricky", "tricky", { cold_climax: false }), "tricky", "prepared climax unchanged");
  assert.equal(E.finalBand("desperate", "desperate", { cold_climax: true }), "desperate", "cold climax cannot go past desperate");
});

test("presets keep the plugin's sizes and critical counts under the setting's names", () => {
  const p = R.presets();
  assert.deepEqual(Object.keys(p), ["skirmish", "standard", "expanse", "deep_void"]);
  assert.deepEqual(Object.values(p).map(x => [x.label, x.size, x.critical]), [["Skirmish", 8, 3], ["Standard", 12, 5], ["Expanse", 16, 7], ["Deep Void", 20, 9]]);
  assert.deepEqual(R.suggestedPresets(2), ["skirmish", "standard"]);
  assert.deepEqual(R.suggestedPresets(4), ["standard", "expanse"]);
  assert.deepEqual(R.suggestedPresets(6), ["expanse", "deep_void"]);
});
