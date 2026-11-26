"use strict";
/* Static game rules and authored data, ported from the plugin's class-rules.php. No dependencies beyond setting.js.
   Section references (§) point at the plugin's build brief. Function names are camelCase; where that differs from
   the PHP name, the PHP name is given in a comment. Data keys (role, attribute, preset, item ids, ...) are kept
   snake_case, as stored and sent over the network. */
const setting = require("./setting.js");

const CREW_POOL = 150;       // §4.2, raised from 125 when the Helm Officer was added: still 25 an officer on average
const SHIP_POOL = 100;       // §4.1
const CREW_ATTR_CAP = 15;    // §4.2 allocated points only; species bonus may exceed (§4.3)
const SHIP_ATTR_MIN = 5;     // §4.1
const SHIP_ATTR_MAX = 35;
const MAX_CAPTAINS = 6;      // §3.2
const STAGE_POINTS = 20;     // §7.1
const ADVICE_COST = 3;       // §7.2.1
const MOMENTUM_MIN = -3;     // §7.2.7
const MOMENTUM_MAX = 6;
const LY_PER_UNIT = 5;       // §7.4
const CARGO_SLOTS = 10;      // §7.3
const STACK_SIZE = 3;
const MAX_GRID = 20;         // §5.3 hard upper limit
const FREE_TIER0 = 10;       // §8 free Tier 0 actions per stage, then 1 point each
const MAX_SPEAKERS = 3;      // §7.2.4
const MAX_NEW_FACTIONS = 2;  // §5.4
const LINK_EXPIRY_DAYS = 7;  // §3.5
const SETBACK_HULL = Object.freeze({ failure: 10, partial: 5 }); // hull lost when a combat or manoeuvre order goes wrong (§14.5)
/* What an alert does (§14.5 rule 3). threat: added to any roll answering a threat. care: added to repair and medical
   rolls, the crew being at their stations. hail: added to hails, since a ship at alert reads as wary or hostile.
   soak: per cent taken off damage the ship receives. */
const ALERT = Object.freeze({
  yellow: Object.freeze({ threat: 1, care: 1, hail: -1, soak: 25 }),
  red: Object.freeze({ threat: 2, care: 2, hail: -3, soak: 50 })
});
const AGREEMENT_KEPT = 1;    // TUNABLE: standing change when a promise to a faction is kept (§9.1)
const AGREEMENT_BROKEN = -2; // TUNABLE: and when it is broken
const DAMAGED_RECOVERY = 1;  // TUNABLE: extra recovery turns for an injury taken aboard a badly damaged ship (§7.5)

const SPECIES_COUNT = 10;     // §4.3 a closed list of ten
const SPECIES_BONUS = 3;      // §4.3 every species grants +3 in total
const SPECIES_MAX_ATTRS = 3;  // §4.3 spread across one to three attributes
const SPECIES_NAME_MAX = 40;  // in bytes of UTF-8, as PHP's strlen counts
/* TUNABLE: penalty when Science covers an injured medic via Xenology (§7.5 says "at a penalty"). */
const MEDIC_COVER_PENALTY = 2;

/* ---------- PHP value helpers, so the port reads and casts values the way the plugin did ---------- */

/* PHP's (int) cast: numbers truncate, numeric-leading strings read their number, true is 1, anything else 0. */
function intval(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) || 0 : 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const m = /^[ \t\n\r\v\f]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(v);
    if (!m) return 0;
    const n = Number(m[1]);
    return Number.isFinite(n) ? Math.trunc(n) || 0 : 0;
  }
  return 0;
}

/* PHP's trim(): only space, tab, newline, carriage return, NUL and vertical tab, unlike String.prototype.trim. */
function phpTrim(s) {
  return String(s).replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
}

/* PHP's (string) cast of a scalar. A number that is not a safe integer prints as PHP prints a float (precision 14). */
function phpStrval(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v === true) return "1";
  if (typeof v === "number") {
    if (Number.isSafeInteger(v)) return String(v);
    if (Number.isNaN(v)) return "NAN";
    if (!Number.isFinite(v)) return v > 0 ? "INF" : "-INF";
    if (Object.is(v, -0)) return "-0";
    const [mant, expPart] = v.toExponential(13).split("e");
    const exp = Number(expPart);
    if (exp < -4 || exp >= 14) {
      let m = mant.replace(/\.?0+$/, "");
      if (!m.includes(".")) m += ".0";
      return m + "E" + (exp < 0 ? "-" : "+") + Math.abs(exp);
    }
    return String(Number(v.toPrecision(14)));
  }
  return String(v);
}

/* ---------- Roles, attributes, ship ---------- */

/* Roles in CSV order (§4.4.2) with each officer's own four attributes (§4.2). */
function roles() {
  return {
    tactical: { label: "Tactical", title: "Tactical Officer", attrs: ["accuracy", "threat_assessment", "security", "composure"] },
    engineer: { label: "Engineer", title: "Engineer", attrs: ["repair", "power_management", "improvisation", "composure"] },
    science: { label: "Science", title: "Science Officer", attrs: ["sensor_analysis", "xenology", "improvisation", "composure"] },
    first_officer: { label: "First Officer", title: "First Officer", attrs: ["command_presence", "diplomacy", "threat_assessment", "composure"] },
    medical: { label: "Medical", title: "Medical Officer", attrs: ["triage", "psychology", "xenology", "composure"] },
    helm: { label: "Helm", title: "Helm Officer", attrs: ["piloting", "navigation", "evasion", "composure"] }
  };
}

/* Crew attributes in CSV column order (§4.4.2). */
function attributes() {
  return {
    accuracy: "Accuracy",
    threat_assessment: "Threat Assessment",
    security: "Security",
    composure: "Composure",
    repair: "Repair",
    power_management: "Power Management",
    improvisation: "Improvisation",
    sensor_analysis: "Sensor Analysis",
    xenology: "Xenology",
    command_presence: "Command Presence",
    diplomacy: "Diplomacy",
    triage: "Triage",
    psychology: "Psychology",
    piloting: "Piloting",
    navigation: "Navigation",
    evasion: "Evasion"
  };
}

/* PHP: ship_attributes() */
function shipAttributes() {
  return {
    tactical: "Tactical",
    defense: "Defense",
    speed: "Speed",
    manoeuvrability: "Manoeuvrability",
    sensors: "Sensors",
    hull_integrity: "Hull Integrity"
  };
}

/* ---------- Species (§4.3) ---------- */

/* The species list set from the app's settings (§2.1), or null while the built-in ten are in use. Set through
   setSpecies() only. */
let speciesOverride = null;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = v => typeof v === "object" && v !== null;

/* PHP: default_species(). The built-in ten (setting.js) and their bonus-only modifiers. Human's +3 is placed by the player. */
function defaultSpecies() {
  const out = {};
  for (const s of setting.SPECIES) {
    out[s.name] = own(s, "free") ? { free: s.free, bonus: { ...s.bonus } } : { bonus: { ...s.bonus } };
  }
  return out;
}

/* The species list in force: the settings' list when one has been set (§2.1), otherwise the built-in ten (§4.3). */
function species() {
  return speciesOverride !== null ? structuredClone(speciesOverride) : defaultSpecies();
}

/* PHP: set_species(). Replace the species list. An invalid list is refused and the list already in force stays.
   Returns true when the list was accepted. */
function setSpecies(list) {
  if (!isObj(list) || validateSpecies(list).length) return false;
  speciesOverride = structuredClone(list);
  return true;
}

/* PHP: reset_species(). Go back to the built-in ten. */
function resetSpecies() {
  speciesOverride = null;
}

/* PHP: species_name_key(). A name as compared for uniqueness: species names match without regard to case (§4.4.2). */
function speciesNameKey(name) {
  return phpTrim(name === null || name === undefined ? "" : phpStrval(name)).toLowerCase();
}

/* PHP: species_entry_errors(). Check one species against §4.3: a plain-text name, and either +3 the player places by
   hand ({ free: 3, bonus: {} }) or +3 spread across one to three crew attributes, bonuses only.
   Returns plain-language problems, without the species name in front; empty when valid. */
function speciesEntryErrors(name, def) {
  const errors = [];
  name = typeof name === "string" || typeof name === "number" || typeof name === "boolean" ? phpStrval(name) : "";
  if (phpTrim(name) === "") {
    errors.push("The name is empty. Every species needs a name.");
  } else if (phpTrim(name) !== name) {
    errors.push("The name has a space before or after it.");
  } else if (!/^[\p{L}\p{N}][\p{L}\p{N} '’.\-]*$/u.test(name)) {
    errors.push("The name must be plain text: letters, numbers, spaces, apostrophes, hyphens and full stops only, starting with a letter or number.");
  } else if (Buffer.byteLength(name, "utf8") > SPECIES_NAME_MAX) {
    errors.push("The name is too long. Keep it to " + SPECIES_NAME_MAX + " characters.");
  }

  const total = SPECIES_BONUS;
  if (!isObj(def)) {
    errors.push("The bonus is missing.");
    return errors;
  }
  if (Object.keys(def).some(k => k !== "free" && k !== "bonus")) {
    errors.push("The entry holds something other than a bonus.");
  }
  const bonus = own(def, "bonus") ? def.bonus : null;
  if (!isObj(bonus)) {
    errors.push("The bonus is missing.");
    return errors;
  }
  const bonusKeys = Object.keys(bonus);
  if (own(def, "free")) {
    if (def.free !== total) errors.push(`A species whose points the player places must give exactly ${total} points.`);
    if (bonusKeys.length) {
      errors.push(`The player places this species' ${total} points, so it cannot also have fixed bonuses. Remove the bonuses, or stop letting the player place the points.`);
    }
    return errors;
  }
  if (!bonusKeys.length) {
    errors.push(`There is no bonus. Give ${total} points across one to three attributes, or let the player place them.`);
    return errors;
  }
  const labels = attributes();
  let sum = 0;
  let sound = true;
  for (const attr of bonusKeys) {
    const value = bonus[attr];
    // PHP turns an all-digit key into an integer, which is never a crew attribute; own() also rules out "constructor" etc.
    if (!own(labels, attr)) {
      errors.push('"' + attr + '" is not a crew attribute.');
      sound = false;
      continue;
    }
    const label = labels[attr];
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push(`The ${label} bonus must be a whole number from 1 to ${total}.`);
      sound = false;
    } else if (value < 0) {
      errors.push(`The ${label} bonus is negative. Species only give bonuses, never penalties.`);
      sound = false;
    } else if (value < 1 || value > total) {
      errors.push(`The ${label} bonus must be from 1 to ${total}.`);
      sound = false;
    } else {
      sum += value;
    }
  }
  if (bonusKeys.length > SPECIES_MAX_ATTRS) {
    errors.push("The bonus is spread across " + bonusKeys.length + " attributes. Use at most " + SPECIES_MAX_ATTRS + ".");
  }
  // A total is only worth reporting when every figure in it could be counted.
  if (sound && sum !== total) errors.push(`The bonuses add up to ${sum}. Every species gives exactly ${total}.`);
  return errors;
}

/* PHP: validate_species(). Check a whole species list against §4.3: exactly ten species, unique names, and every
   entry valid. list is name => definition, as species() returns it. Returns plain-language problems. */
function validateSpecies(list) {
  const errors = [];
  const names = Object.keys(list);
  if (SPECIES_COUNT !== names.length) {
    errors.push("The list must hold exactly " + SPECIES_COUNT + " species. This one holds " + names.length + ".");
  }
  const seen = new Map();
  let n = 0;
  for (const name of names) {
    ++n;
    const label = phpTrim(name) === "" ? `Species ${n}` : '"' + name + '"';
    for (const e of speciesEntryErrors(name, list[name])) errors.push(`${label}: ${e}`);
    const key = speciesNameKey(name);
    if (key === "") continue;
    if (seen.has(key)) {
      errors.push(`${label}: the name is used more than once ("${seen.get(key)}"). Names must differ by more than capital letters.`);
    } else {
      seen.set(key, name);
    }
  }
  return errors;
}

function genders() {
  return ["Male", "Female"]; // §10
}

/* ---------- Grid presets (§5.3) with critical-mission counts including the finale (§6.3) ---------- */

function presets() {
  const n = setting.PRESET_NAMES;
  return {
    skirmish: { label: n.skirmish, size: 8, critical: 3, blurb: "Short campaign, fast generation, everyone stays close." },
    standard: { label: n.standard, size: 12, critical: 5, blurb: "The default. Real travel decisions without long empty hauls." },
    expanse: { label: n.expanse, size: 16, critical: 7, blurb: "Long campaign. Longer journeys to reach other captains." },
    deep_void: { label: n.deep_void, size: 20, critical: 9, blurb: "Maximum size. Long generation wait and heavier on older devices.", warning: true }
  };
}

/* PHP: suggested_presets(). Suggested presets by captain count (§5.3). */
function suggestedPresets(captains) {
  if (captains <= 2) return ["skirmish", "standard"];
  return captains <= 4 ? ["standard", "expanse"] : ["expanse", "deep_void"];
}

/* ---------- Resolution engine data (§7.2.2) ---------- */

function bands() {
  return { routine: 10, tricky: 14, hard: 18, desperate: 22 };
}

/* PHP: ship_attributes_for(). The ship attributes that count towards a roll (§14.5 rule 2). Each kind of order draws
   on one part of the ship; a roll made in answer to a threat also draws on Defense, and a retreat on Speed.
   Returns ship attribute keys; empty for orders the crew carries out without the ship. */
function shipAttributesFor(actionClass, retreat, answersThreat) {
  const byClass = {
    attack: "tactical",
    board: "tactical",
    manoeuvre: "manoeuvrability",
    scan: "sensors",
    repair: "hull_integrity",
    divert_power: "hull_integrity"
  };
  const out = [];
  if (retreat) out.push("speed");
  else if (own(byClass, actionClass)) out.push(byClass[actionClass]);
  if (answersThreat) out.push("defense");
  return out;
}

/* PHP: alert_bonus(). What the ship's alert adds to a roll: the sum of the effects that apply to this order. */
function alertBonus(alert, actionClass, answersThreat) {
  const fx = own(ALERT, alert) ? ALERT[alert] : null;
  if (!fx) return 0;
  return (answersThreat ? fx.threat : 0)
    + (actionClass === "repair" || actionClass === "treat" ? fx.care : 0)
    + (actionClass === "hail" ? fx.hail : 0);
}

/* PHP: action_classes() */
function actionClasses() {
  return ["scan", "hail", "divert_power", "manoeuvre", "repair", "treat", "attack", "board", "advice", "alert_yellow", "alert_red", "alert_normal", "move", "information", "other"];
}

/* PHP: officers_enum() */
function officersEnum() {
  return ["tactical", "engineer", "science", "first_officer", "medical", "helm", "computer", "captain"];
}

/* Point costs. The rules price every action; the LLM only classifies (§7.2.1).
   Confirmed: move 1, yellow alert 1, red alert 2, advice 3. Tier 0 is free.
   TUNABLE: the per-class figures inside the approved Tier 2 (1-3) and Tier 3 (2-3) ranges. */
function cost(actionClass, tier) {
  tier = intval(tier);
  if (tier === 0) return 0;
  if (actionClass === "advice") return ADVICE_COST;
  if (tier === 3) return climaxCost();
  if (tier === 1) {
    const t1 = { move: 1, alert_yellow: 1, alert_red: 2, hail: 1 };
    return own(t1, actionClass) ? t1[actionClass] : 1;
  }
  const t2 = {
    scan: 2, hail: 2, divert_power: 2, manoeuvre: 2, treat: 2,
    repair: 3, attack: 3, board: 3, other: 2, move: 2, information: 1
  };
  return own(t2, actionClass) ? t2[actionClass] : 2;
}

/* PHP: climax_cost() */
function climaxCost() {
  return 3; // TUNABLE within the approved 2-3 range.
}

/* PHP: default_actor(). Fallback [role, attribute] by action class when Call A is unusable (§7.2.2 defence 4). */
function defaultActor(actionClass) {
  const map = {
    scan: ["science", "sensor_analysis"],
    hail: ["first_officer", "diplomacy"],
    divert_power: ["engineer", "power_management"],
    manoeuvre: ["helm", "piloting"],
    retreat: ["helm", "piloting"],
    repair: ["engineer", "repair"],
    treat: ["medical", "triage"],
    attack: ["tactical", "accuracy"],
    board: ["tactical", "security"],
    other: ["first_officer", "composure"]
  };
  return own(map, actionClass) ? map[actionClass].slice() : ["first_officer", "composure"];
}

/* PHP: automatic_classes(). Tier 1 actions never roll (§7.2.1). */
function automaticClasses() {
  return ["alert_yellow", "alert_red", "alert_normal", "move", "advice", "information"];
}

/* ---------- Injury (§7.5) ---------- */

function severities() {
  return { light: 3, serious: 6, critical: 12 };
}

/* PHP: treatment_reduction(). TUNABLE: extra recovery reduction for a turn spent on active treatment, by outcome (§7.5). */
function treatmentReduction(outcome) {
  const t = { critical_success: 3, success: 2, partial: 1, failure: 0 };
  return own(t, outcome) ? t[outcome] : 0;
}

/* ---------- Diplomacy (§9.1) ---------- */

/* PHP: standing_step(). TUNABLE: how the numeric standing (-10..+10) maps onto the five steps. */
function standingStep(n) {
  n = Math.max(-10, Math.min(10, intval(n)));
  if (n <= -6) return "Hostile";
  if (n <= -2) return "Unfriendly";
  if (n <= 1) return "Neutral";
  return n <= 5 ? "Cordial" : "Allied";
}

/* The setting's factions (§5.4), from setting.js, as key => { name, standing, note }.
   TUNABLE: the starting standing numbers. */
function factions() {
  const out = {};
  for (const f of setting.FACTIONS) out[f.key] = { name: f.name, standing: f.standing, note: f.note };
  return out;
}

/* ---------- Items (§7.3) ---------- */

/* PHP: item_effects() */
function itemEffects() {
  return ["turn_points", "roll_bonus", "recovery", "ship_attribute", "range", "momentum", "band_shift", "reveal"];
}

/* The authored catalogue. Effects are closed enums; the LLM may only rename and describe. Names come from setting.js.
   kind: consumable | equipment. rarity: standard | advanced | prototype. cost = turn points to use.
   TUNABLE: the catalogue entries themselves, built from the brief's examples and effect list. */
function items() {
  const n = setting.ITEM_NAMES;
  const it = (id, rest) => [id, { name: n[id], ...rest }];
  return Object.fromEntries([
    it("power_cell", { kind: "consumable", rarity: "standard", effect: "turn_points", value: 3, cost: 0 }),
    it("power_cell_adv", { kind: "consumable", rarity: "advanced", effect: "turn_points", value: 5, cost: 1 }),
    it("medkit", { kind: "consumable", rarity: "standard", effect: "recovery", value: 2, cost: 0 }),
    it("surgical_kit", { kind: "consumable", rarity: "advanced", effect: "recovery", value: 4, cost: 1 }),
    it("sensor_probe", { kind: "consumable", rarity: "standard", effect: "reveal", value: 1, cost: 1 }),
    it("shield_booster", { kind: "consumable", rarity: "standard", effect: "roll_bonus", attribute: "threat_assessment", value: 2, cost: 0 }),
    it("targeting_solution", { kind: "consumable", rarity: "standard", effect: "roll_bonus", attribute: "accuracy", value: 2, cost: 0 }),
    it("universal_primer", { kind: "consumable", rarity: "standard", effect: "roll_bonus", attribute: "diplomacy", value: 2, cost: 0 }),
    it("repair_drones", { kind: "consumable", rarity: "standard", effect: "roll_bonus", attribute: "repair", value: 2, cost: 0 }),
    it("jump_coil", { kind: "consumable", rarity: "standard", effect: "range", value: 10, cost: 0 }),
    it("tactical_brief", { kind: "consumable", rarity: "advanced", effect: "momentum", value: 1, cost: 1 }),
    it("prototype_solver", { kind: "consumable", rarity: "prototype", effect: "band_shift", value: 1, cost: 2 }),
    it("targeting_module", { kind: "equipment", rarity: "advanced", effect: "ship_attribute", attribute: "tactical", value: 3, cost: 0 }),
    it("enhanced_deflector", { kind: "equipment", rarity: "advanced", effect: "ship_attribute", attribute: "defense", value: 3, cost: 0 }),
    it("sensor_array", { kind: "equipment", rarity: "advanced", effect: "ship_attribute", attribute: "sensors", value: 3, cost: 0 }),
    it("thruster_tuning", { kind: "equipment", rarity: "advanced", effect: "ship_attribute", attribute: "manoeuvrability", value: 3, cost: 0 }),
    it("jump_core_upgrade", { kind: "equipment", rarity: "prototype", effect: "ship_attribute", attribute: "speed", value: 5, cost: 0 }),
    it("ablative_plating", { kind: "equipment", rarity: "prototype", effect: "ship_attribute", attribute: "hull_integrity", value: 5, cost: 0 }),
    it("field_hospital", { kind: "equipment", rarity: "advanced", effect: "recovery", value: 1, cost: 0 })
  ]);
}

/* PHP: item_ids_by(). Catalogue ids of one rarity, and optionally one kind. */
function itemIdsBy(rarity, kind = null) {
  const out = [];
  for (const [id, it] of Object.entries(items())) {
    if (it.rarity === rarity && (kind === null || kind === undefined || it.kind === kind)) out.push(id);
  }
  return out;
}

/* PHP: call_types(). LLM call types that can each be given their own model (§1.1, §7.2.2). */
function callTypes() {
  return {
    call_a: "Call A: adjudication",
    call_b: "Call B: narration",
    story: "Phase 2: story",
    missions: "Phase 3: missions",
    random: "Random missions and events",
    bridge: "Bridge and recovery missions",
    summary: "Rolling campaign summary",
    flavour: "Ship class, registry and item flavour"
  };
}

module.exports = {
  CREW_POOL, SHIP_POOL, CREW_ATTR_CAP, SHIP_ATTR_MIN, SHIP_ATTR_MAX, MAX_CAPTAINS, STAGE_POINTS, ADVICE_COST,
  MOMENTUM_MIN, MOMENTUM_MAX, LY_PER_UNIT, CARGO_SLOTS, STACK_SIZE, MAX_GRID, FREE_TIER0, MAX_SPEAKERS,
  MAX_NEW_FACTIONS, LINK_EXPIRY_DAYS, SETBACK_HULL, ALERT, AGREEMENT_KEPT, AGREEMENT_BROKEN, DAMAGED_RECOVERY,
  SPECIES_COUNT, SPECIES_BONUS, SPECIES_MAX_ATTRS, SPECIES_NAME_MAX, MEDIC_COVER_PENALTY,
  roles, attributes, shipAttributes, defaultSpecies, species, setSpecies, resetSpecies, speciesNameKey,
  speciesEntryErrors, validateSpecies, genders, presets, suggestedPresets, bands, shipAttributesFor, alertBonus,
  actionClasses, officersEnum, cost, climaxCost, defaultActor, automaticClasses, severities, treatmentReduction,
  standingStep, factions, itemEffects, items, itemIdsBy, callTypes,
  intval, phpTrim, phpStrval
};
