"use strict";
/* Ported from the plugin's tests/test-addressed.php: whom the captain spoke to, and who may speak in the report. */
const test = require("node:test");
const assert = require("node:assert/strict");
const Context = require("../context.js");

const crew = {
  tactical: { name: "Thalira Ven" },
  engineer: { name: "Brokk Garv" },
  science: { name: "T'Lera" },
  first_officer: { name: "Daniel Okoro" },
  medical: { name: "Jorvan Phel" },
  helm: { name: "Sorin Vale" }
};
const who = text => Context.addressed(text, crew);

test("addressed: the officer or Computer the captain spoke to", () => {
  assert.equal(who("Number One, what do you make of this?"), "first_officer", "title at the start");
  assert.equal(who("Doctor, how is the tactical officer?"), "medical", "the one addressed, not the one mentioned");
  assert.equal(who("T'Lera, scan the relay."), "science", "a name with an apostrophe");
  assert.equal(who("How long for repairs, Brokk?"), "engineer", "a first name at the end");
  assert.equal(who("What is the state of the jump core, Mr Garv?"), "engineer", "a surname with a form of address");
  assert.equal(who("Scan them. Tactical, raise shields!"), "tactical", "a title after a full stop");
  assert.equal(who("Lieutenant Thalira, report."), "tactical", "a rank before a name");
  assert.equal(who("Computer, hull status."), "computer", "the Computer");
  assert.equal(who("Go to tactical alert and scan the area"), null, "a title used as an ordinary word addresses nobody");
  assert.equal(who("Raise shields and set course for sector 1,2,3"), null, "no one addressed");
  assert.equal(who("Run a science scan of the engineering section"), null, "station words inside an order address nobody");
  assert.equal(who("Science officer: what is that?"), "science", "a title with a colon");
  assert.equal(who("Helm, take us out of orbit."), "helm", "the Helm Officer by station");
  assert.equal(who("Evasive pattern delta, Mr Vale!"), "helm", "the Helm Officer by surname");
  assert.equal(who("Take the helm and set a course for the relay"), null, "helm used as an ordinary word addresses nobody");
});

test("candidates: who may speak is decided by the game, not the model", () => {
  const cap = { state: { crew: JSON.parse(JSON.stringify(crew)) } };
  const act = (cls, officer = "none", intent = "") => ({ action_class: cls, officer, intent });
  const ids = (...args) => Object.keys(Context.candidates(...args));
  const actor = role => ({ role, covering: false });
  assert.deepEqual(ids(cap, act("scan", "science"), actor("science")), ["science"], "only the officer who carried the order out");
  assert.deepEqual(ids(cap, act("move")), ["helm"], "with no roll, the officer whose station it is");
  assert.deepEqual(ids(cap, act("attack", "tactical"), actor("tactical"), {}, null, { engineer: "the shields system was damaged", medical: "Sorin Vale took a serious injury" }), ["tactical", "engineer", "medical"], "plus officers whose station the result touched");
  assert.deepEqual(ids(cap, act("information", "computer", "database_query")), ["first_officer"], "the Computer does not answer an order that did not address it");
  assert.deepEqual(ids(cap, act("information", "computer"), null, {}, "computer", {}, true), ["computer"], "the Computer answers when addressed");
  assert.deepEqual(ids(cap, act("scan", "science"), actor("science"), {}, "science", {}, true), ["science", "computer"], "an officer spoken to answers first, the Computer only because it was named");
  assert.deepEqual(ids(cap, act("scan", "science"), actor("science"), {}, "engineer"), ["engineer", "science"], "the officer spoken to, then the one who did the work");
  const hurt = JSON.parse(JSON.stringify(cap));
  hurt.state.crew.first_officer.injury = { severity: "minor" };
  assert.deepEqual(ids(hurt, act("information")), ["tactical"], "with the First Officer down, another officer answers for the bridge");
  const all = JSON.parse(JSON.stringify(cap));
  for (const r of Object.keys(crew)) all.state.crew[r].injury = { severity: "minor" };
  assert.deepEqual(ids(all, act("information")), ["computer"], "the Computer only when no officer is fit");
  assert.ok(Context.computerAddressed("Ask the computer for the hull status") && Context.computerAddressed("Computer, report."), "named anywhere in the order");
  assert.ok(!Context.computerAddressed("Scan the computerised relay") && !Context.computerAddressed("Raise shields"), "not named");
});
