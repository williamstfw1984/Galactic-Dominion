"use strict";
/* Ported from the plugin's tests/test-objective.php: a stage has an objective and no prescribed way of achieving it. */
const test = require("node:test");
const assert = require("node:assert/strict");
const Prompts = require("../prompts.js");
const { Turn } = require("../turn.js");

test("objective: judged against the objective, and said by the crew", () => {
  assert.ok(!Prompts.callASystem().includes("stage climax described"), "decisive move: judged against the objective, not a scripted action");
  assert.ok(Prompts.callBSystem().includes("WHEN A STAGE BEGINS"), "objective: the crew are told to say what has to be achieved");
  assert.equal(Turn.withoutStage('MISSION BEGINS: "Crit One". A convoy is lost. STAGE 1 of 2: C1S1. Situation: sit Objective: obj'), 'MISSION BEGINS: "Crit One". A convoy is lost.', "notice: the stage's situation and objective are not put on screen as text");
  assert.equal(Turn.withoutStage("RESUMED STAGE 2 of 3: X. Situation: s Objective: o"), "", "notice: a stage on its own shows nothing; the crew say it");
});

test("prompts: the setting's own names, and never Star Trek's", () => {
  const all = [Prompts.callASystem(), Prompts.callBSystem(), Prompts.storySystem(), Prompts.missionsSystem(5, 8, 2), Prompts.bridgeSystem(), Prompts.leadsSystem(), Prompts.recoverySystem(), Prompts.randomSystem(), Prompts.summarySystem(), Prompts.flavourSystem()];
  for (const p of all) {
    assert.ok(/never use any name from Star Trek/i.test(p), "every prompt tells the model not to use Star Trek names");
    assert.ok(!/Starfleet|Federation|Klingon|Romulan|Cardassian|Dominion War|Borg|Vulcan|NCC|warp|phaser|tricorder|transporter|holodeck|replicator|LCARS/i.test(p.replace(/never use any name from Star Trek/ig, "")), "no Star Trek name in: " + p.slice(0, 60));
  }
  assert.ok(Prompts.flavourSystem().includes("CR-1024"), "registry in the setting's form");
});
