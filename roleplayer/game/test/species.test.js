"use strict";
/* Ported from the plugin's tests/test-species.php. */
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../rules.js");
const L = require("../library.js");

test("species list validation and the settings' override", () => {
  R.resetSpecies();
  const def = R.defaultSpecies();
  assert.deepEqual(R.validateSpecies(def), [], "the built-in ten validate");
  assert.equal(Object.keys(def).length, 10, "ten built-in species");
  assert.deepEqual(Object.keys(def), ["Human", "Seluun", "Vey", "Ossan", "Lirae", "Joined Ament", "Haldani", "Quell", "Teneri", "Drav"], "the setting's ten, in order");

  const bad = list => R.validateSpecies(list).length > 0;
  const nine = { ...def };
  delete nine.Drav;
  assert.ok(bad(nine), "nine species refused");
  assert.ok(bad({ ...def, Kesh: { bonus: { diplomacy: 3 } } }), "eleven species refused");

  const swap = (name, entry) => {
    const l = { ...def };
    delete l.Drav;
    l[name] = entry;
    return l;
  };
  assert.deepEqual(R.validateSpecies(swap("Kesh", { bonus: { diplomacy: 2, composure: 1 } })), [], "a valid replacement species is accepted");
  assert.ok(bad(swap("seluun", { bonus: { accuracy: 3 } })), "names differing only by capitals are duplicates");
  assert.ok(bad(swap("Kesh", { bonus: { diplomacy: 4, composure: -1 } })), "a negative modifier is refused");
  assert.ok(bad(swap("Kesh", { bonus: { diplomacy: 2 } })), "a total of 2 is refused");
  assert.ok(bad(swap("Kesh", { bonus: { diplomacy: 4 } })), "a total of 4 is refused");
  assert.ok(bad(swap("Kesh", { bonus: { diplomacy: 1, composure: 1, accuracy: 1, repair: 0 } })), "four attributes are refused");
  assert.ok(bad(swap("Kesh", { bonus: { greed: 3 } })), "an unknown attribute is refused");
  assert.ok(bad(swap(" ", { bonus: { diplomacy: 3 } })), "an empty name is refused");
  assert.ok(bad(swap("Kesh", { free: 3, bonus: { diplomacy: 1 } })), "a free species cannot also carry fixed bonuses");
  assert.deepEqual(R.validateSpecies(swap("Kesh", { free: 3, bonus: {} })), [], "a second free species is allowed");

  const custom = swap("Kesh", { bonus: { diplomacy: 2, composure: 1 } });
  assert.ok(R.setSpecies(custom), "a valid custom list is accepted");
  assert.ok("Kesh" in R.species() && !("Drav" in R.species()), "species() returns the custom list");
  assert.ok(!R.setSpecies(nine), "an invalid list is refused");
  assert.ok("Kesh" in R.species(), "and the list in force is kept");

  // The importer follows the list in force.
  const sp = { tactical: "Kesh", engineer: "Ossan", science: "Seluun", first_officer: "Lirae", medical: "Teneri", helm: "Quell" };
  const at = { tactical: [8, 6, 5, 5], engineer: [7, 6, 6, 4], science: [9, 6, 5, 5], first_officer: [8, 7, 5, 6], medical: [9, 6, 7, 5], helm: [8, 6, 6, 5] };
  const crew = {};
  for (const [role, d] of Object.entries(R.roles())) {
    crew[role] = { role, name: "Officer " + role, species: sp[role], gender: "Male", attrs: Object.fromEntries(d.attrs.map((a, i) => [a, at[role][i]])), human_bonus: [], personality: "Steady.", voice: "" };
  }
  assert.ok(L.validateCrew(crew).ok, "an officer of a species added in the settings validates");
  crew.tactical.species = "Drav";
  assert.ok(!L.validateCrew(crew).ok, "an officer of a removed species does not");

  R.resetSpecies();
  assert.ok("Drav" in R.species(), "reset restores the built-in ten");
});

test("species entry messages", () => {
  assert.deepEqual(R.speciesEntryErrors("Kesh", { bonus: { diplomacy: 2 } }), ["The bonuses add up to 2. Every species gives exactly 3."]);
  assert.deepEqual(R.speciesEntryErrors("Kesh", { bonus: { diplomacy: 1.5, composure: 1.5 } }), ["The Diplomacy bonus must be a whole number from 1 to 3.", "The Composure bonus must be a whole number from 1 to 3."]);
  assert.deepEqual(R.speciesEntryErrors("Kesh", null), ["The bonus is missing."]);
  assert.deepEqual(R.speciesEntryErrors("<b>", { bonus: { accuracy: 3 } }), ["The name must be plain text: letters, numbers, spaces, apostrophes, hyphens and full stops only, starting with a letter or number."]);
  assert.deepEqual(R.speciesEntryErrors("é".repeat(21), { bonus: { accuracy: 3 } }), ["The name is too long. Keep it to 40 characters."], "length is counted in UTF-8 bytes, as PHP's strlen does");
  assert.deepEqual(R.speciesEntryErrors("Kesh ", { bonus: { accuracy: 3 } }), ["The name has a space before or after it."]);
});
