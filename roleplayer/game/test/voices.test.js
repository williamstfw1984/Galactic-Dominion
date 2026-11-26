"use strict";
/* Ported from the parts of the plugin's tests/test-voices.php that apply to the app's local voices. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createVoices } = require("../voices.js");

/* A list in the shape main.js voices() gives, best-rated first, with the voices that need more than the program. */
const LIST = [
  ["af_heart", "Heart", "female", "American"], ["af_bella", "Bella", "female", "American"], ["bf_emma", "Emma", "female", "British"],
  ["am_michael", "Michael", "male", "American"], ["am_fenrir", "Fenrir", "male", "American"], ["bm_george", "George", "male", "British"],
  ["af_nicole", "Nicole", "female", "American"], ["af_aoede", "Aoede", "female", "American"], ["bf_isabella", "Isabella", "female", "British"],
  ["am_puck", "Puck", "male", "American"], ["bm_fable", "Fable", "male", "British"], ["am_echo", "Echo", "male", "American"],
  ["af_sarah", "Sarah", "female", "American"], ["bf_alice", "Alice", "female", "British"], ["bm_lewis", "Lewis", "male", "British"],
  ["am_adam", "Adam", "male", "American"], ["bf_lily", "Lily", "female", "British"], ["bm_daniel", "Daniel", "male", "British"]
].map(([id, name, gender, accent]) => ({ id, name, gender, accent, needs: [] })).concat({ id: "described", name: "New voice from a description", accent: "", gender: "", needs: ["mood"] });
const V = createVoices(LIST);

const crew = {
  tactical: { name: "Torv", gender: "Male", voice: "", species: "Vey" },
  engineer: { name: "Mira Okafor", gender: "Female", voice: "" },
  science: { name: "Tela Sien", gender: "Female", voice: "" },
  first_officer: { name: "Jonas Reyes", gender: "Male", voice: "" },
  medical: { name: "Selene Voss", gender: "Female", voice: "" },
  helm: { name: "Ilya Brandt", gender: "Male", voice: "" }
};
const distinct = c => {
  const t = new Set();
  for (const o of Object.values(c)) {
    if (!V.isValid(o.voice)) return false;
    t.add(V.timbre(o.voice));
  }
  return t.size === Object.keys(c).length;
};
const female = id => V.isValid(id) && V.get(id).gender === "Female";
const male = id => V.isValid(id) && V.get(id).gender === "Male";
const copy = o => JSON.parse(JSON.stringify(o));

test("pool: the local voices with a gender of their own", () => {
  const pool = V.pool();
  assert.equal(pool.length, 18, "only voices with a gender: a described voice has none");
  assert.equal(new Set(pool.map(v => v.id)).size, pool.length, "ids unique");
  assert.equal(pool.length, V.pool("Female").length + V.pool("Male").length, "gender filter partitions the pool");
  assert.deepEqual([...new Set(V.pool("male").map(v => v.gender))], ["Male"], "filter is case-insensitive");
  assert.deepEqual(V.get("bf_emma"), { id: "bf_emma", gender: "Female", locale: "British", label: "Emma (British)", timbre: "bf_emma", quality: 3 }, "entry shape");
  assert.ok(V.isValid("bf_emma") && !V.isValid("") && !V.isValid("described") && !V.isValid("en-US-AriaNeural"), "valid and invalid ids");
});

test("assignCrew: six distinct voices, chosen ones kept", () => {
  const a = V.assignCrew(crew);
  assert.deepEqual(Object.keys(a), Object.keys(crew), "roles preserved");
  assert.ok(distinct(a), "six distinct voices");
  assert.ok(male(a.tactical.voice) && female(a.engineer.voice), "gender-matched");
  assert.deepEqual(V.assignCrew(crew), a, "deterministic");
  assert.deepEqual(V.assignCrew(a), a, "assigning again changes nothing");
  assert.equal(a.tactical.species, "Vey", "other fields untouched");
  assert.equal(a.tactical.voice, V.suggest("Male", "Torv|tactical"), "first officer processed gets the suggested voice");

  let c = copy(crew);
  c.science.voice = "bf_emma";
  let b = V.assignCrew(c);
  assert.equal(b.science.voice, "bf_emma", "valid chosen voice kept");
  assert.ok(distinct(b), "still distinct around a chosen voice");

  c = copy(crew);
  c.tactical.voice = "bf_emma"; // a female voice on a male officer
  c.engineer.voice = "en-US-AnaNeural"; // not a local voice
  c.medical.voice = "made-up";
  b = V.assignCrew(c);
  assert.equal(b.tactical.voice, "bf_emma", "a chosen voice is kept whatever the officer's gender");
  assert.ok(female(b.engineer.voice) && female(b.medical.voice), "unknown voices replaced");
  assert.ok(distinct(b), "distinct after replacing invalid voices");

  c = copy(crew);
  c.engineer.voice = c.science.voice = c.medical.voice = "af_bella";
  b = V.assignCrew(c);
  assert.equal(b.engineer.voice, "af_bella", "first holder keeps a duplicated voice");
  assert.ok(b.science.voice !== "af_bella" && b.medical.voice !== "af_bella" && distinct(b), "duplicates replaced");

  const auto = a.engineer.voice;
  c = copy(crew);
  c.medical.voice = auto;
  b = V.assignCrew(c);
  assert.ok(b.medical.voice === auto && b.engineer.voice !== auto && distinct(b), "explicit choices win over auto-assignment");

  for (const g of ["Male", "Female"]) {
    const cx = copy(crew);
    for (const o of Object.values(cx)) o.gender = g;
    assert.ok(distinct(V.assignCrew(cx)), "six distinct voices, all " + g);
  }
});

test("quality: a ship's officers get the best-rated voices first", () => {
  const cq = {};
  for (const [r, g] of Object.entries({ tactical: "Female", engineer: "Male", science: "Female", first_officer: "Male", medical: "Male" })) cq[r] = { name: "Officer " + r, gender: g, voice: "" };
  const got = Object.values(V.assignCrew(cq)).map(o => o.voice).sort();
  assert.deepEqual(got, ["af_bella", "af_heart", "am_fenrir", "am_michael", "bm_george"], "the best two women's and three men's voices");
});

test("suggest and computerVoice", () => {
  assert.equal(V.suggest("Female", "Mira|engineer"), V.suggest("Female", "Mira|engineer"), "deterministic");
  assert.ok(male(V.suggest("Male", "x")), "gender-matched");
  const s1 = V.suggest("Female", "seed");
  const s2 = V.suggest("Female", "seed", [s1]);
  assert.ok(s1 !== s2 && female(s2), "respects exclude");
  assert.equal(V.computerVoice("Female"), "af_heart", "the best female voice");
  assert.equal(V.computerVoice("Male"), "am_michael", "the best male voice");
  assert.equal(V.computerVoice("Female", ["af_heart"]), "af_bella", "the next when an officer has the first");
  const allF = V.pool("Female").map(v => v.id);
  assert.ok(female(V.computerVoice("Female", allF)), "always returns a voice");
});

test("npcVoice: remembered, outside officers and scene, least used", () => {
  const a = V.assignCrew(crew);
  const exclude = [...Object.values(a).map(o => o.voice), V.computerVoice("Female")];
  let r = V.npcVoice({}, "gul_tarn", "Male", exclude);
  assert.ok(male(r.voice) && !exclude.includes(r.voice), "gender-matched and outside exclude");
  assert.deepEqual(r.known, { gul_tarn: { voice: r.voice, gender: "Male" } }, "recorded in known");
  assert.deepEqual(V.npcVoice({}, "gul_tarn", "Male", exclude), r, "deterministic");
  const again = V.npcVoice(r.known, "gul_tarn", "Female", [r.voice], ["gul_tarn"]);
  assert.equal(again.voice, r.voice, "remembered voice kept");
  assert.deepEqual(again.known, r.known, "known unchanged for a remembered character");

  let known = {};
  const free = new Set(V.pool("Female").map(v => v.timbre).filter(t => !exclude.includes(t)));
  const seen = new Set();
  let clean = true;
  for (let i = 0; i < free.size; i++) {
    r = V.npcVoice(known, "npc_f_" + i, "Female", exclude);
    known = r.known;
    clean = clean && free.has(r.voice) && !seen.has(r.voice);
    seen.add(r.voice);
  }
  assert.ok(clean, "no reuse and no excluded voice until the pool is exhausted");
  assert.equal(seen.size, free.size, "whole free pool handed out");
  const scene = ["npc_f_0", "npc_f_1", "npc_f_2"];
  const sceneT = scene.map(k => known[k].voice);
  r = V.npcVoice(known, "late_arrival", "Female", exclude, scene);
  assert.ok(female(r.voice) && seen.has(r.voice), "exhausted pool reuses a voice");
  assert.ok(!sceneT.includes(r.voice) && !exclude.includes(r.voice), "never one from the scene or an officer's");
  const r2 = V.npcVoice(r.known, "later_arrival", "Female", exclude);
  assert.notEqual(r2.voice, r.voice, "least-used voice preferred");

  const males = V.pool("Male").map(v => v.id);
  const keepA = "bm_george", keepB = "am_echo";
  const exM = males.filter(id => id !== keepA && id !== keepB);
  const k = { one: { voice: keepA, gender: "Male" } };
  assert.equal(V.npcVoice(k, "two", "Male", exM, ["one"]).voice, keepB, "scene partner's voice avoided");
  k.three = { voice: keepB, gender: "Male" };
  k.four = { voice: keepB, gender: "Male" };
  assert.equal(V.npcVoice(k, "five", "Male", exM).voice, keepA, "least-used of the remaining voices");
  assert.equal(V.npcVoice(k, "five", "Male", exM, ["three"]).voice, keepA, "scene rule and least-used agree");
  assert.equal(V.npcVoice(k, "five", "Male", exM, ["one"]).voice, keepB, "scene rule beats least-used");
  assert.ok([keepA, keepB].includes(V.npcVoice(k, "five", "Male", exM, ["one", "three"]).voice), "never an excluded voice while any other exists");
  assert.ok(male(V.npcVoice({}, "x", "Male", males).voice), "a voice even if everything is excluded");
});
