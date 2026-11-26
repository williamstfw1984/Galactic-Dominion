"use strict";
/* Ported from the plugin's tests/test-advice.php. */
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../advice.js");

const fit = (role, attrs) => ({ role, name: role.charAt(0).toUpperCase() + role.slice(1), species: "Teneri", attrs });
const base = () => ({
  in_stage: true, momentum: 0, used: [], points: 20, obstacle_band: "tricky", threat: "none", forced: false,
  has_contacts: false, alert: "normal", hull: 100, damaged: [], items: [], injured: [],
  ship: { tactical: 10, defense: 10, speed: 10, manoeuvrability: 10, sensors: 35, hull_integrity: 10 },
  crew: {
    tactical: fit("tactical", { accuracy: 4, threat_assessment: 4, security: 4, composure: 5 }),
    engineer: fit("engineer", { repair: 10, power_management: 6, improvisation: 6, composure: 4 }),
    science: fit("science", { sensor_analysis: 14, xenology: 6, improvisation: 5, composure: 5 }),
    first_officer: fit("first_officer", { command_presence: 8, diplomacy: 12, threat_assessment: 5, composure: 6 }),
    medical: fit("medical", { triage: 9, psychology: 6, xenology: 7, composure: 5 }),
    helm: fit("helm", { piloting: 6, navigation: 6, evasion: 5, composure: 5 })
  }
});
const ids = c => A.options(c).map(o => o.id);

test("odds and ship penalty", () => {
  assert.deepEqual(A.odds(4, 14), { success: 0.55, failure: 0.25 }, "odds at +4 against 14");
  assert.deepEqual(A.odds(0, 30), { success: 0.05, failure: 0.95 }, "only a natural 20");
  assert.deepEqual(A.odds(20, 5), { success: 0.95, failure: 0.05 }, "only a natural 1 fails");
  assert.equal(A.shipPenalty("attack", ["weapons", "sensors"], 40), 2, "damaged weapons and a weak hull both count against an attack");
  assert.equal(A.shipPenalty("hail", ["weapons"], 90), 0, "damaged weapons do not hamper a hail");
});

test("the best approach for this crew and ship", () => {
  const b = base();
  assert.equal(ids(b)[0], "approach_scan", "the crew and ship are best at scanning, so that comes first");
  assert.ok(!ids(b).includes("approach_hail"), "nobody to talk to: a hail is not suggested");
  assert.ok(!ids(b).includes("repair") && !ids(b).includes("treat"), "nothing damaged, nobody hurt: no repair or treatment suggested");
  assert.equal(A.brief(b).length, 2, "two courses of action are offered");
  assert.ok(A.brief(b)[0].includes("cold"), "with no Momentum, the reason given is the cold final move");

  let c = base(); c.used = ["scan"]; c.momentum = 1;
  assert.ok(!ids(c).includes("approach_scan"), "an approach that has already built Momentum is dropped");
  c = base(); c.has_contacts = true;
  assert.ok(ids(c).includes("approach_hail"), "contacts present: hailing is an option");
});

test("threats and alerts", () => {
  let c = base(); c.threat = "active";
  assert.equal(ids(c)[0], "answer_threat", "an active threat comes first");
  c = base(); c.threat = "pending";
  assert.ok(ids(c).includes("alert_red"), "threat pending, nobody to talk to: red alert");
  c.has_contacts = true;
  assert.ok(ids(c).includes("alert_yellow") && !ids(c).includes("alert_red"), "threat pending with contacts: yellow, not red");
  c.alert = "yellow";
  assert.ok(!ids(c).includes("alert_yellow"), "already at alert: not suggested again");
  c = base(); c.alert = "red"; c.has_contacts = true;
  assert.ok(ids(c).includes("alert_normal"), "at red alert with talking still open: stand down");
});

test("damage, injuries and points", () => {
  let c = base(); c.damaged = ["sensors", "weapons"]; c.hull = 40;
  assert.equal(ids(c)[0], "repair", "a badly damaged ship: repairs come first");
  c = base(); c.crew.science.injury = { severity: "serious" }; c.injured = ["Science"];
  assert.ok(ids(c).includes("treat"), "an injured officer: treatment is suggested");
  const val = x => Object.fromEntries(A.options(x).map(o => [o.id, o.value])).approach_scan;
  assert.ok(val(c) < val(base()), "with the science officer down, scanning is worth less than it was");

  c = base(); c.points = 4;
  assert.ok(!ids(c).some(i => i.startsWith("approach_")), "too few points: no approach that would cost the final move");
  c.momentum = 2;
  assert.ok(ids(c).includes("climax_now"), "groundwork laid and points short: make the move");
  c = base(); c.forced = true; c.points = 1;
  assert.deepEqual(ids(c), ["climax_now"], "points spent: only the final move is suggested");
});

test("items in the hold, and nothing invented", () => {
  let c = base(); c.items = ["prototype_solver", "tactical_brief", "medkit_unknown"];
  assert.ok(ids(c).includes("item_prototype_solver") && ids(c).includes("item_tactical_brief"), "useful consumables are suggested");
  c = base(); c.in_stage = false;
  assert.deepEqual(A.brief(c), [], "nothing to prepare: no advice is invented");
});
