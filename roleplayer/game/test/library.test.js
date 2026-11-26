"use strict";
/* Ported from the plugin's tests/test-library.php, with tests of the saved-builds store that replaces WordPress posts. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../library.js");
const R = require("../rules.js");
const E = require("../engine.js");

/* True when any error matches the column (and row, when given) and its message contains needle (any case). */
function hasError(errors, column, needle = "", row = false) {
  return errors.some(e => e.column === column && (row === false || e.row === row) && (needle === "" || e.message.toLowerCase().includes(needle.toLowerCase())));
}

const libShip = () => ({
  name: "CSV Meridian",
  class: "Pathfinder",
  registry: "CR-1024",
  captain: "",
  attrs: { tactical: 20, defense: 20, speed: 15, manoeuvrability: 10, sensors: 15, hull_integrity: 20 }
});

/* A valid crew: 6 officers x 25 points = 150. */
const libCrew = () => ({
  tactical: { role: "tactical", name: "Thira Ond'Kor", species: "Vey", gender: "Female", attrs: { accuracy: 10, threat_assessment: 5, security: 5, composure: 5 }, human_bonus: [], personality: "Blunt, loyal, quick to anger.", voice: "bf_emma" },
  engineer: { role: "engineer", name: "Marcus Hale", species: "Human", gender: "Male", attrs: { repair: 15, power_management: 5, improvisation: 5, composure: 0 }, human_bonus: ["repair", "repair", "composure"], personality: "Says \"it'll hold\", then checks twice.\nHates paperwork, loves coffee.", voice: "am_adam" },
  science: { role: "science", name: "Sael Tovan", species: "Seluun", gender: "Female", attrs: { sensor_analysis: 10, xenology: 5, improvisation: 5, composure: 5 }, human_bonus: [], personality: "Precise, dry, curious.", voice: "" },
  first_officer: { role: "first_officer", name: "Joran Hesk", species: "Joined Ament", gender: "Male", attrs: { command_presence: 10, diplomacy: 5, threat_assessment: 5, composure: 5 }, human_bonus: [], personality: "Calm, wry, sees the long view.", voice: "" },
  medical: { role: "medical", name: "Phelan Ruse", species: "Teneri", gender: "Male", attrs: { triage: 10, psychology: 5, xenology: 5, composure: 5 }, human_bonus: [], personality: "Cheerful, tireless, nosy.", voice: "" },
  helm: { role: "helm", name: "Kessa Rhal", species: "Haldani", gender: "Female", attrs: { piloting: 10, navigation: 5, evasion: 5, composure: 5 }, human_bonus: [], personality: "Cool hands, dry humour.", voice: "" }
});

/* ---------- Ship ---------- */

test("ship validation", () => {
  let r = L.validateShip(libShip());
  assert.ok(r.ok, "valid ship passes");
  assert.deepEqual(r.errors, [], "valid ship has no errors");
  assert.equal(r.total, 100, "ship total 100");
  assert.deepEqual(r.ship, libShip(), "ship normalises to itself");

  let s = libShip();
  delete s.class;
  delete s.registry;
  r = L.validateShip(s);
  assert.ok(r.ok, "ship class and registry are optional");
  assert.equal(r.ship.class, "", "missing class normalises to empty");

  s = libShip();
  s.name = "  ";
  r = L.validateShip(s);
  assert.ok(!r.ok && hasError(r.errors, "ship_name"), "ship name required");

  s = libShip();
  s.attrs.tactical = 21;
  r = L.validateShip(s);
  assert.ok(!r.ok, "ship over-spend fails");
  assert.equal(r.total, 101, "ship over-spend total reported");
  assert.ok(hasError(r.errors, null, "1 too many"), "ship over-spend message");
  s.attrs.tactical = 18;
  r = L.validateShip(s);
  assert.ok(!r.ok && hasError(r.errors, null, "2 too few"), "ship under-spend fails");

  s = libShip();
  s.attrs.tactical = 36;
  s.attrs.defense = 4;
  r = L.validateShip(s);
  assert.equal(r.total, 100, "min/max case still totals 100");
  assert.ok(hasError(r.errors, "tactical", "more than 35"), "ship attribute max 35");
  assert.ok(hasError(r.errors, "defense", "at least 5"), "ship attribute min 5");
  assert.equal(r.errors.length, 2, "only the two range errors");

  s = libShip();
  s.attrs.tactical = 35;
  s.attrs.defense = 5;
  assert.ok(L.validateShip(s).ok, "ship 35 and 5 are allowed");

  s = libShip();
  s.attrs.speed = "15.5";
  r = L.validateShip(s);
  assert.ok(hasError(r.errors, "speed", "whole number"), "ship attribute must be an integer");
  s.attrs.speed = "15";
  assert.ok(L.validateShip(s).ok, "numeric string accepted");
  assert.equal(L.validateShip(s).ship.attrs.speed, 15, "numeric string normalised to int");
});

/* ---------- Crew ---------- */

test("crew validation", () => {
  let r = L.validateCrew(libCrew());
  assert.ok(r.ok, "valid crew passes");
  assert.deepEqual(r.errors, [], "valid crew has no errors");
  assert.equal(r.total, 150, "crew total 150");
  assert.deepEqual(r.per_officer, { tactical: 25, engineer: 25, science: 25, first_officer: 25, medical: 25, helm: 25 }, "per-officer points");
  assert.deepEqual(r.crew, libCrew(), "crew normalises to itself");

  // The normalised shape is what the engine reads.
  assert.equal(E.effectiveAttrs(r.crew.engineer).repair.value, 17, "human bonus feeds effective attrs (15 + 2)");

  let c = libCrew();
  c.tactical.attrs.accuracy = 11;
  r = L.validateCrew(c);
  assert.ok(!r.ok, "crew over-spend fails");
  assert.equal(r.total, 151, "crew over-spend total");
  assert.ok(hasError(r.errors, null, "1 too many"), "crew over-spend message");

  c = libCrew();
  c.medical.attrs.triage = 7;
  r = L.validateCrew(c);
  assert.ok(!r.ok && hasError(r.errors, null, "3 too few"), "crew under-spend fails");
  assert.equal(r.per_officer.medical, 22, "per-officer reflects under-spend");

  c = libCrew();
  c.tactical.attrs.accuracy = 16;
  c.tactical.attrs.security = 0;
  c.tactical.attrs.composure = 4;
  r = L.validateCrew(c);
  assert.equal(r.total, 150, "cap case still totals 150");
  assert.ok(!r.ok && hasError(r.errors, "accuracy", "more than 15"), "cap 15 enforced");
  assert.equal(r.errors.length, 1, "cap is the only error");
  assert.equal(r.errors[0].role, "tactical", "crew errors name the role");

  c = libCrew();
  c.science.attrs.xenology = -1;
  assert.ok(hasError(L.validateCrew(c).errors, "xenology", "whole number"), "negative points rejected");
  c.science.attrs.xenology = "lots";
  assert.ok(hasError(L.validateCrew(c).errors, "xenology", "whole number"), "non-numeric points rejected");

  c = libCrew();
  c.science.species = "Orrin";
  r = L.validateCrew(c);
  assert.ok(!r.ok && hasError(r.errors, "species", "Orrin"), "species outside the ten rejected");

  c = libCrew();
  c.science.species = "sELUUN";
  c.science.gender = "female";
  r = L.validateCrew(c);
  assert.ok(r.ok, "species and gender match case-insensitively");
  assert.equal(r.crew.science.species, "Seluun", "species normalised");
  assert.equal(r.crew.science.gender, "Female", "gender normalised");

  c = libCrew();
  c.first_officer.species = "joined ament";
  assert.equal(L.validateCrew(c).crew.first_officer.species, "Joined Ament", "a two-word species matches too");

  c = libCrew();
  c.medical.species = "Seluun";
  assert.ok(L.validateCrew(c).ok, "two officers may share a species");

  for (const g of ["Other", "Non-binary", "M", ""]) {
    c = libCrew();
    c.medical.gender = g;
    r = L.validateCrew(c);
    assert.ok(!r.ok && hasError(r.errors, "gender", "Male or Female"), `gender '${g}' rejected`);
  }

  c = libCrew();
  c.tactical.attrs.repair = 0;
  r = L.validateCrew(c);
  assert.ok(!r.ok && hasError(r.errors, "repair", "does not have"), "value in an attribute the officer lacks is rejected");
  c.tactical.attrs.repair = "";
  assert.ok(L.validateCrew(c).ok, "blank in an attribute the officer lacks is fine");
});

test("the helm attributes belong to the Helm Officer alone", () => {
  for (const helmAttr of ["piloting", "navigation", "evasion"]) {
    for (const other of ["tactical", "engineer", "science", "first_officer", "medical"]) {
      const c = libCrew();
      c[other].attrs[helmAttr] = 0;
      const r = L.validateCrew(c);
      assert.ok(!r.ok && hasError(r.errors, helmAttr, "does not have"), `${helmAttr} rejected on the ${other} officer`);
      assert.equal(r.errors[0].role, other, `${helmAttr} on ${other}: the error names that officer`);
    }
  }
  assert.deepEqual(L.validateCrew(libCrew()).crew.helm.attrs, { piloting: 10, navigation: 5, evasion: 5, composure: 5 }, "helm attributes accepted on the Helm Officer");
  let c = libCrew();
  c.helm.attrs.accuracy = 0;
  assert.ok(hasError(L.validateCrew(c).errors, "accuracy", "does not have"), "the Helm Officer has no Accuracy");
  c = libCrew();
  c.helm.attrs.piloting = 16;
  c.helm.attrs.evasion = 0;
  c.helm.attrs.composure = 4;
  const r = L.validateCrew(c);
  assert.ok(r.total === 150 && r.errors.length === 1 && hasError(r.errors, "piloting", "more than 15"), "cap 15 applies to the helm attributes");
});

test("missing, unknown and duplicate roles; names, personality, voices", () => {
  let c = libCrew();
  delete c.medical;
  let r = L.validateCrew(c);
  assert.ok(!r.ok && hasError(r.errors, "role", "Medical Officer is missing"), "missing role rejected");
  assert.equal(r.per_officer.medical, 0, "missing officer still in per_officer");

  c = libCrew();
  delete c.helm;
  r = L.validateCrew(c);
  assert.ok(!r.ok && hasError(r.errors, "role", "Helm Officer is missing"), "a crew without the Helm Officer is rejected");
  assert.ok(hasError(r.errors, "role", "exactly six officers"), "the message asks for six officers");
  assert.ok(hasError(r.errors, null, "25 too few"), "five officers at 25 each fall 25 short of the pool");
  assert.equal(r.total, 125, "total without the Helm Officer");
  assert.equal(r.per_officer.helm, 0, "missing Helm Officer still in per_officer");

  c = libCrew();
  c.counsellor = c.medical;
  r = L.validateCrew(c);
  assert.ok(!r.ok && hasError(r.errors, "role", "not a role"), "seventh, unknown role rejected");

  const list = Object.values(libCrew());
  assert.ok(L.validateCrew(list).ok, "list of officers with role fields accepted");
  list.push(list[0]);
  r = L.validateCrew(list);
  assert.ok(!r.ok && hasError(r.errors, "role", "more than once"), "duplicate role rejected");

  c = libCrew();
  c.science.name = "";
  c.medical.personality = " ";
  r = L.validateCrew(c);
  assert.ok(hasError(r.errors, "name", "name is required"), "officer name required");
  assert.ok(hasError(r.errors, "personality", "personality summary is required"), "personality required");

  c = libCrew();
  c.science.voice = "bf_emma";
  assert.ok(hasError(L.validateCrew(c).errors, "voice", "same voice"), "two officers cannot share a voice");
});

test("Human bonus", () => {
  let c = libCrew();
  c.engineer.human_bonus = ["repair", "repair"];
  let r = L.validateCrew(c);
  assert.ok(!r.ok && hasError(r.errors, "human_bonus_3", "blank"), "Human must place all three bonus points");
  c.engineer.human_bonus = [];
  assert.equal(L.validateCrew(c).errors.length, 3, "Human with no bonus: three errors");
  c.engineer.human_bonus = ["repair", "repair", "repair", "repair"];
  assert.ok(hasError(L.validateCrew(c).errors, "human_bonus_3", "no more"), "Human cannot place four");
  c.engineer.human_bonus = ["repair", "accuracy", "repair"];
  assert.ok(hasError(L.validateCrew(c).errors, "human_bonus_2", "not one of this officer"), "Human bonus must be on own attributes");
  c.engineer.human_bonus = ["repair", "repair", "repair"];
  r = L.validateCrew(c);
  assert.ok(r.ok, "Human bonus may repeat an attribute, above the allocated cap");
  assert.equal(r.total, 150, "Human bonus does not count towards the 150");
  c.engineer.human_bonus = ["Power Management", "REPAIR", "composure"];
  assert.deepEqual(L.validateCrew(c).crew.engineer.human_bonus, ["power_management", "repair", "composure"], "Human bonus accepts labels");
  c = libCrew();
  c.science.human_bonus = ["composure"];
  r = L.validateCrew(c);
  assert.ok(!r.ok && hasError(r.errors, "human_bonus_1", "only Human"), "non-Human may not have bonus points");
});

/* ---------- CSV round trips ---------- */

test("CSV round trips", () => {
  let csv = L.exportShipCsv(libShip());
  let r = L.parseShipCsv(csv);
  assert.ok(r.ok, "ship export parses");
  assert.deepEqual(r.ship, libShip(), "ship round trip");
  assert.equal(csv.split("\n")[0], "ship_name,tactical,defense,speed,manoeuvrability,sensors,hull_integrity,ship_class,registry,captain_name", "ship export header");

  // The optional captain's name.
  let s = libShip();
  s.captain = 'Elena "Lena" Marlowe, PhD';
  r = L.validateShip(s);
  assert.ok(r.ok, "ship with a captain passes");
  assert.deepEqual(r.ship, s, "ship with a captain normalises to itself");
  csv = L.exportShipCsv(s);
  r = L.parseShipCsv(csv);
  assert.ok(r.ok, "ship export with a captain parses");
  assert.equal(r.ship.captain, s.captain, "captain_name round trip (quotes and comma survive)");
  assert.deepEqual(r.ship, s, "ship round trip with a captain");
  assert.equal(L.exportShipCsv(r.ship), csv, "ship export is stable");
  s.captain = "N".repeat(61);
  assert.equal(L.validateShip(s).ship.captain, "N".repeat(60), "captain is cut to 60 characters");
  s = libShip();
  delete s.captain;
  r = L.validateShip(s);
  assert.ok(r.ok && r.ship.captain === "", "captain is optional");

  csv = L.exportCrewCsv(libCrew());
  r = L.parseCrewCsv(csv);
  assert.deepEqual(r.errors, [], "crew export parses without errors");
  assert.deepEqual(r.crew, libCrew(), "crew round trip (quotes, commas and newlines in personality survive)");
  assert.equal(L.exportCrewCsv(r.crew), csv, "crew export is stable");
  assert.equal(csv.split("\n")[0], "role,name,race,gender,accuracy,threat_assessment,security,composure,repair,power_management,improvisation,sensor_analysis,xenology,command_presence,diplomacy,triage,psychology,piloting,navigation,evasion,personality,human_bonus_1,human_bonus_2,human_bonus_3,voice", "crew export header");
});

/* ---------- Ship CSV ---------- */

test("ship CSV", () => {
  const base = "ship_name,tactical,defense,speed,manoeuvrability,sensors,hull_integrity\n";
  let r = L.parseShipCsv(base + "CSV Meridian,20,20,15,10,15,20\n");
  assert.ok(r.ok, "brief ship header (no optional columns) parses");
  assert.equal(r.ship.registry, "", "no registry column gives empty registry");
  assert.equal(r.ship.captain, "", "no captain_name column gives an empty captain");
  r = L.parseShipCsv("ship_name,tactical,defense,speed,manoeuvrability,sensors,hull_integrity,ship_class,registry\nCSV Meridian,20,20,15,10,15,20,Pathfinder,CR-1024\n");
  assert.ok(r.ok, "ship CSV from before the captain_name column is still valid");
  assert.deepEqual(r.ship, libShip(), "and reads as a ship with no captain");
  r = L.parseShipCsv("ship_name,tactical,defense,speed,manoeuvrability,sensors,hull_integrity,captain_name\nCSV Meridian,20,20,15,10,15,20, Jean Mercer \n");
  assert.ok(r.ok && r.ship.captain === "Jean Mercer", "captain_name column read and trimmed");

  r = L.parseShipCsv('\uFEFF Ship_Name , TACTICAL,defense,speed,manoeuvrability,sensors,hull_integrity,Registry\r\n "Meridian, CSV" , 20 ,20,15,10,15,20, CR-7 \r\n\r\n');
  assert.ok(r.ok, "ship CSV tolerates BOM, CRLF, whitespace and header case");
  assert.equal(r.ship.name, "Meridian, CSV", "quoted ship name with comma");
  assert.equal(r.ship.registry, "CR-7", "optional registry column read");

  r = L.parseShipCsv(base + "A,20,20,15,10,15,20\nB,20,20,15,10,15,20\n");
  assert.ok(!r.ok && hasError(r.errors, null, "exactly one", 3), "two ship rows rejected");
  r = L.parseShipCsv(base);
  assert.ok(!r.ok && hasError(r.errors, null, "no ship row"), "ship header only rejected");
  r = L.parseShipCsv("");
  assert.ok(!r.ok && r.total === 0, "empty ship file rejected");
  r = L.parseShipCsv("ship_name,tactical,defense,speed,manoeuvrability,sensors\nA,20,20,20,20,20\n");
  assert.ok(!r.ok && hasError(r.errors, "hull_integrity", "missing", 1), "missing ship column reported on row 1");
  r = L.parseShipCsv(base + "A,40,20,15,10,,15\n");
  assert.ok(hasError(r.errors, "tactical", "more than 35", 2), "ship CSV error carries row and column");
  assert.ok(hasError(r.errors, "sensors", "blank", 2), "blank ship attribute reported");

  r = L.parseShipCsv(L.shipTemplateCsv());
  assert.ok(!r.ok && hasError(r.errors, "ship_name") && r.total === 0, "ship template parses structurally");
});

/* ---------- Crew CSV ---------- */

const h21 = "role,name,race,gender,accuracy,threat_assessment,security,composure,repair,power_management,improvisation,sensor_analysis,xenology,command_presence,diplomacy,triage,psychology,piloting,navigation,evasion,personality";
const csvRows = () => ({
  tactical: 'Tactical,Thira,Vey,Female,10,5,5,5,,,,,,,,,,,,,"Blunt, loyal."',
  engineer: "engineer,Brak,Ossan,male,,,,5,10,5,5,,,,,,,,,,Argues.",
  science: 'SCIENCE,Sael,seluun,FEMALE,,,,5,,,5,10,5,,,,,,,,"Precise.\nDry, ""curious""."',
  first_officer: "first officer,Joran,Joined Ament,Male,,5,,5,,,,,,10,5,,,,,,Calm.",
  medical: "Medical,Phelan,Teneri,Male,,,,5,,,,,5,,,10,5,,,,Cheerful.",
  helm: 'Helm,Kessa,Haldani,Female,,,,5,,,,,,,,,,10,5,5,"Cool hands."'
});
const mk = rows => h21 + "\n" + Object.values(rows).join("\n") + "\n";

test("crew template", () => {
  const tpl = L.crewTemplateCsv();
  const lines = tpl.trim().split("\n");
  assert.equal(lines.length, 7, "template: header and six rows");
  assert.equal(lines[0], "role,name,race,gender,accuracy,threat_assessment,security,composure,repair,power_management,improvisation,sensor_analysis,xenology,command_presence,diplomacy,triage,psychology,piloting,navigation,evasion,personality,human_bonus_1,human_bonus_2,human_bonus_3", "template header");
  assert.equal(lines[1], "Tactical,,,,0,0,0,0,,,,,,,,,,,,,,,,", "template tactical row");
  assert.equal(lines[4], '"First Officer",,,,,0,,0,,,,,,0,0,,,,,,,,,', "template first officer row");
  assert.equal(lines[5], "Medical,,,,,,,0,,,,,0,,,0,0,,,,,,,", "template medical row");
  assert.equal(lines[6], "Helm,,,,,,,0,,,,,,,,,,0,0,0,,,,", "template helm row");

  const r = L.parseCrewCsv(tpl);
  assert.ok(!r.ok, "blank template is not a valid crew");
  assert.ok(hasError(r.errors, null, "exactly 150"), "template fails on the total");
  assert.ok(!hasError(r.errors, "role"), "template has no structural (role) errors");
  assert.ok(!hasError(r.errors, null, "officer row"), "template has six rows");
  assert.deepEqual(r.per_officer, { tactical: 0, engineer: 0, science: 0, first_officer: 0, medical: 0, helm: 0 }, "template per_officer returned");
  assert.equal(r.total, 0, "template total 0");
  assert.deepEqual(Object.keys(r.crew), ["tactical", "engineer", "science", "first_officer", "medical", "helm"], "template roles in order");
});

test("crew CSV", () => {
  const rows = csvRows();
  let r = L.parseCrewCsv(mk(rows));
  assert.deepEqual(r.errors, [], "21-column crew CSV parses (no optional columns)");
  assert.equal(r.total, 150, "crew CSV total");
  assert.equal(r.crew.tactical.personality, "Blunt, loyal.", "quoted personality with comma");
  assert.equal(r.crew.science.personality, 'Precise.\nDry, "curious".', "quoted personality with newline and quotes");
  assert.equal(r.crew.first_officer.role, "first_officer", "role label matched case-insensitively");
  assert.equal(r.crew.first_officer.species, "Joined Ament", "a two-word species read from an unquoted cell");
  assert.equal(r.crew.engineer.gender, "Male", "CSV gender normalised");
  assert.deepEqual(r.crew.first_officer.attrs, { command_presence: 10, diplomacy: 5, threat_assessment: 5, composure: 5 }, "only own four attrs kept, as ints");
  assert.deepEqual(r.crew.helm.attrs, { piloting: 10, navigation: 5, evasion: 5, composure: 5 }, "helm columns read on the Helm row");
  assert.deepEqual(r.per_officer, { tactical: 25, engineer: 25, science: 25, first_officer: 25, medical: 25, helm: 25 }, "crew CSV per-officer points");

  r = L.parseCrewCsv("\uFEFF" + (h21.toUpperCase() + "\n" + Object.values(rows).join("\n") + "\n").replace(/\n/g, "\r\n"));
  assert.deepEqual(r.errors, [], "crew CSV tolerates BOM, CRLF and header case");
  assert.equal(r.crew.science.personality, 'Precise.\nDry, "curious".', "CRLF inside a quoted field is kept as a newline");

  let bad = csvRows();
  bad.engineer = "Engineer,Brak,Ossan,Male,3,,,5,10,5,5,,,,,,,,,,Argues.";
  r = L.parseCrewCsv(mk(bad));
  assert.ok(!r.ok && hasError(r.errors, "accuracy", "does not have", 3), "CSV: value in a column the officer lacks, with row and column");
  assert.equal(r.total, 150, "value in a foreign column is not counted");

  // The helm columns are the Helm Officer's alone.
  bad = csvRows();
  bad.tactical = 'Tactical,Thira,Vey,Female,10,5,5,5,,,,,,,,,,0,,,"Blunt, loyal."';
  bad.medical = "Medical,Phelan,Teneri,Male,,,,5,,,,,5,,,10,5,,2,3,Cheerful.";
  r = L.parseCrewCsv(mk(bad));
  assert.ok(!r.ok && hasError(r.errors, "piloting", "does not have", 2), "CSV: piloting on the Tactical row rejected");
  assert.ok(hasError(r.errors, "navigation", "does not have", 6) && hasError(r.errors, "evasion", "does not have", 6), "CSV: navigation and evasion on the Medical row rejected");
  assert.ok(!hasError(r.errors, "piloting", "", 7) && !hasError(r.errors, "navigation", "", 7) && !hasError(r.errors, "evasion", "", 7), "CSV: the same columns are fine on the Helm row");
  assert.equal(r.errors.length, 3, "CSV: those three cells are the only problems");
  assert.equal(r.total, 150, "CSV: helm values on other rows are not counted");

  bad = csvRows();
  bad.medical = "Medical,Phelan,Kesh,Unknown,,,,5,,,,,5,,,16,5,,,,";
  r = L.parseCrewCsv(mk(bad));
  assert.ok(hasError(r.errors, "race", "Kesh", 6), "CSV: wrong species on spreadsheet row 6 (a multi-line cell is still one row), column race");
  assert.ok(hasError(r.errors, "gender", "Male or Female", 6), "CSV: wrong gender");
  assert.ok(hasError(r.errors, "triage", "more than 15", 6), "CSV: cap");
  assert.ok(hasError(r.errors, "personality", "required", 6), "CSV: personality required");
  assert.ok(hasError(r.errors, null, "6 too many"), "CSV: total over");
  assert.equal(r.per_officer.medical, 31, "CSV: per_officer returned when invalid");
  assert.equal(r.total, 156, "CSV: total returned when invalid");

  bad = csvRows();
  delete bad.medical;
  r = L.parseCrewCsv(mk(bad));
  assert.ok(!r.ok && hasError(r.errors, "role", "Medical Officer is missing"), "CSV: missing role");
  assert.ok(hasError(r.errors, null, "5 officer rows"), "CSV: five rows");
  assert.equal(r.total, 125, "CSV: total with a missing officer");

  bad = csvRows();
  delete bad.helm;
  r = L.parseCrewCsv(mk(bad));
  assert.ok(!r.ok && hasError(r.errors, "role", "Helm Officer is missing"), "CSV: a file without the Helm row is rejected");
  assert.ok(hasError(r.errors, null, "It must have exactly six"), "CSV: the row-count message asks for six");
  assert.ok(hasError(r.errors, null, "Medical, Helm"), "CSV: and lists Helm last");
  assert.ok(hasError(r.errors, null, "all six officers") && hasError(r.errors, null, "25 too few"), "CSV: five officers fall 25 short");

  bad = csvRows();
  bad.medical = rows.medical.replace("Medical,", "Science,");
  r = L.parseCrewCsv(mk(bad));
  assert.ok(hasError(r.errors, "role", "already on row 4", 6), "CSV: duplicate role");
  assert.ok(hasError(r.errors, "role", "Medical Officer is missing"), "CSV: duplicate leaves a role missing");

  bad = csvRows();
  bad.extra = "Counsellor,Ilsa,Joined Ament,Female,,,,5,,,,,,,,,,,,,Kind.";
  r = L.parseCrewCsv(mk(bad));
  assert.ok(!r.ok && hasError(r.errors, null, "7 officer rows"), "CSV: seven rows rejected");
  assert.ok(hasError(r.errors, "role", "Counsellor", 8), "CSV: unknown role named");
  assert.equal(r.total, 150, "CSV: unknown-role row not counted");

  r = L.parseCrewCsv(h21.replace(",personality", "") + "\n");
  assert.ok(!r.ok && hasError(r.errors, "personality", "missing", 1), "CSV: missing header column");
  assert.ok(r.per_officer !== undefined && r.total !== undefined, "CSV: readout present even with a bad header");
  r = L.parseCrewCsv(h21 + ",notes\n" + Object.values(rows).join("\n") + "\n");
  assert.ok(!r.ok && hasError(r.errors, "notes", "not part of this file", 1), "CSV: unknown header column");
  assert.equal(r.total, 150, "CSV: readout still computed with an unknown column");
  r = L.parseCrewCsv(h21.replace(",piloting,navigation,evasion", "") + "\n");
  assert.ok(!r.ok && hasError(r.errors, "piloting", "missing", 1) && hasError(r.errors, "navigation", "missing", 1) && hasError(r.errors, "evasion", "missing", 1), "CSV: a header from before the Helm Officer is told which columns it lacks");
  r = L.parseCrewCsv("");
  assert.ok(!r.ok && r.total === 0 && Object.keys(r.per_officer).length === 6, "CSV: empty crew file");
  assert.ok(hasError(r.errors, null, "six officer rows"), "CSV: empty file message asks for six rows");

  bad = csvRows();
  bad.engineer = "Engineer,Brak, the Loud,Ossan,Male,,,,5,10,5,5,,,,,,,,,,Argues.";
  r = L.parseCrewCsv(mk(bad));
  assert.ok(hasError(r.errors, null, "more cells", 3), "CSV: unquoted comma shifts the row and is explained");
});

test("Human in a crew CSV", () => {
  const human = csvRows();
  human.engineer = "Engineer,Marcus,Human,Male,,,,5,10,5,5,,,,,,,,,,Steady.";
  let r = L.parseCrewCsv(mk(human));
  assert.ok(!r.ok && hasError(r.errors, "human_bonus_1", "", 3), "CSV: Human without bonus columns rejected");
  const hb = (rows, extra) => {
    let out = h21 + ",human_bonus_1,human_bonus_2,human_bonus_3\n";
    for (const [role, line] of Object.entries(rows)) out += line + "," + (extra[role] ?? ",") + "\n";
    return out;
  };
  r = L.parseCrewCsv(hb(human, { engineer: "repair,Repair,Composure" }));
  assert.deepEqual(r.errors, [], "CSV: Human with three bonus cells passes");
  assert.deepEqual(r.crew.engineer.human_bonus, ["repair", "repair", "composure"], "CSV: human bonus read");
  r = L.parseCrewCsv(hb(human, { engineer: "repair,,xenology" }));
  assert.ok(hasError(r.errors, "human_bonus_2", "blank", 3) && hasError(r.errors, "human_bonus_3", "xenology", 3), "CSV: human bonus errors per column");
  r = L.parseCrewCsv(hb(human, { engineer: "repair,repair,repair", tactical: ",accuracy," }));
  assert.ok(hasError(r.errors, "human_bonus_2", "only Human", 2), "CSV: bonus cell on a non-Human row rejected");
});

test("default actors and roles", () => {
  assert.deepEqual(R.defaultActor("manoeuvre"), ["helm", "piloting"], "manoeuvres are flown by the Helm Officer on Piloting");
  assert.deepEqual(R.defaultActor("retreat"), ["helm", "piloting"], "a retreat is flown by the Helm Officer on Piloting");
  assert.deepEqual(R.defaultActor("attack"), ["tactical", "accuracy"], "attacks stay with Tactical");
  assert.deepEqual(Object.keys(R.roles()), ["tactical", "engineer", "science", "first_officer", "medical", "helm"], "six roles, Helm last");
  assert.deepEqual(R.roles().helm.attrs, ["piloting", "navigation", "evasion", "composure"], "the Helm Officer's four attributes");
  assert.deepEqual(Object.keys(R.attributes()).slice(-3), ["piloting", "navigation", "evasion"], "the helm attributes come last");
  assert.equal(R.CREW_POOL, 150, "crew pool is 150");
  for (const [name, def] of Object.entries(R.species())) {
    assert.deepEqual(Object.keys(def.bonus).filter(a => ["piloting", "navigation", "evasion"].includes(a)), [], "no species bonus on a helm attribute: " + name);
  }
});

/* ---------- Uploads ---------- */

test("uploads are read as CSV; a workbook is refused", () => {
  assert.deepEqual(L.readUpload(Buffer.from("a,b\n1,2\n")), { ok: true, csv: "a,b\n1,2\n", error: "" });
  assert.deepEqual(L.readUpload("a,b\n"), { ok: true, csv: "a,b\n", error: "" });
  const zip = L.readUpload(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
  assert.ok(!zip.ok && zip.csv === "" && zip.error.includes(".csv"), "a zip (an .xlsx workbook) is refused");
});

/* ---------- Saved builds (replacing the plugin's WordPress posts) ---------- */

test("saved builds are kept in builds.json in the data folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gd-builds-"));
  try {
    assert.deepEqual(L.listBuilds(dir), [], "nothing saved yet");
    assert.equal(L.getBuild(dir, 1), null, "no build 1 yet");

    const id = L.saveBuild(dir, libShip(), libCrew());
    assert.equal(id, 1, "the first build gets id 1");
    assert.ok(fs.existsSync(path.join(dir, "builds.json")) && !fs.existsSync(path.join(dir, "builds.json.tmp")), "written atomically to builds.json");
    let b = L.getBuild(dir, id);
    assert.equal(b.id, 1);
    assert.equal(b.name, "CSV Meridian", "named after the ship");
    assert.deepEqual(b.ship, L.validateShip(libShip()).ship, "the validated ship is stored");
    assert.deepEqual(b.crew, L.validateCrew(libCrew()).crew, "the validated crew is stored");
    assert.match(b.modified, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, "modified time in UTC");

    const s2 = libShip();
    s2.name = "CSV Aster";
    s2.captain = "Ines Varro";
    const id2 = L.saveBuild(dir, s2, libCrew());
    assert.equal(id2, 2, "ids count up");
    assert.deepEqual(L.listBuilds(dir).map(x => [x.id, x.name, x.captain]), [[2, "CSV Aster", "Ines Varro"], [1, "CSV Meridian", ""]], "listed by name, with the captain");
    assert.deepEqual(Object.keys(L.listBuilds(dir)[0]), ["id", "name", "captain", "modified"], "the listing has no ship or crew bodies");

    const s3 = libShip();
    s3.name = "CSV Meridian II";
    assert.equal(L.saveBuild(dir, s3, libCrew(), 1), 1, "an update keeps its id");
    assert.equal(L.getBuild(dir, 1).name, "CSV Meridian II", "and its new name");

    const invalid = libShip();
    invalid.attrs.speed = 99;
    const e = L.saveBuild(dir, invalid, libCrew());
    assert.ok(L.isError(e) && e.code === "invalid", "an invalid build is not saved");
    assert.ok(e.data.errors.ship.length > 0 && e.data.errors.crew.length === 0, "and says which half is wrong");
    const nf = L.saveBuild(dir, libShip(), libCrew(), 99);
    assert.ok(L.isError(nf) && nf.code === "not_found", "updating a build that does not exist fails");

    assert.ok(L.deleteBuild(dir, 2), "delete");
    assert.ok(!L.deleteBuild(dir, 2), "a second delete finds nothing");
    assert.equal(L.getBuild(dir, 2), null, "deleted build is gone");
    assert.equal(L.saveBuild(dir, s2, libCrew()), 3, "ids are not reused");
    assert.equal(L.getBuild(dir, 0), null, "id 0 is never a build");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged builds.json is not overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gd-builds-"));
  try {
    fs.writeFileSync(path.join(dir, "builds.json"), "{not json");
    assert.throws(() => L.saveBuild(dir, libShip(), libCrew()));
    assert.equal(fs.readFileSync(path.join(dir, "builds.json"), "utf8"), "{not json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
