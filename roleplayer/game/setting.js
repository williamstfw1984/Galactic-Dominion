"use strict";
/* Galactic Dominion's setting: every name the game shows for its factions, species, resources, items, ships and era.
   This file is the single source of truth for those names (docs/PORT.md, "The setting"). The rules, the generator
   and the prompts read them from here; nothing else spells them out. Pure data, no dependencies. */

/* The power every captain serves, its ships and its command. */
const POWER = {
  key: "concord",
  name: "The Concord of Worlds",
  short: "the Concord",
  adjective: "Concord"
};
const SHIP_PREFIX = "CSV";                         // Concord starships: "CSV Meridian"
const REGISTRY_PREFIX = "CR";                      // registry form "CR-1024"
const REGISTRY_EXAMPLE = "CR-1024";
const SHIP_EXAMPLE = "CSV Meridian";
const FLEET_COMMAND = "Concord Fleet Command";     // where orders come from

/* A ship's full name, e.g. shipName("Meridian") gives "CSV Meridian". */
function shipName(name) {
  return SHIP_PREFIX + " " + String(name).trim();
}

/* A registry in the setting's form, e.g. registry(1024) gives "CR-1024". */
function registry(number) {
  return REGISTRY_PREFIX + "-" + String(number).trim();
}

/* The era the campaign is set in. */
const WAR = { name: "the Long War", enemy: "orrin" };
const ERA =
  "Five years after the end of the Long War against the Orrin Compact. The Concord of Worlds is rebuilding.";

/* Factions in the order the rules list them, with each one's starting standing towards the Concord (-10..+10). */
const FACTIONS = [
  { key: "concord", name: "The Concord of Worlds", standing: 10, note: "Rebuilding after the Long War. Every captain serves it." },
  { key: "drav", name: "Drav Imperium", standing: 6, note: "Warrior people; allies since fighting beside the Concord in the war." },
  { key: "seluun", name: "Seluun Veil", standing: -1, note: "Wartime ally, but secretive and distrusted." },
  { key: "marr", name: "Marr Union", standing: -2, note: "Devastated by the war and rebuilding." },
  { key: "ossan", name: "Ossan Guilds", standing: 1, note: "Merchant guilds; deal with anyone." },
  { key: "haldane", name: "Free Haldane", standing: 5, note: "Close partner world after occupation and war." },
  { key: "orrin", name: "Orrin Compact", standing: -6, note: "The Long War's enemy, withdrawn beyond the Rift since its end." },
  { key: "kethri", name: "Kethri Swarm", standing: -10, note: "A hive that absorbs what it meets; known afresh from scouts returned from the far reaches." },
  { key: "vashtar", name: "Vashtar Hegemony", standing: -6, note: "On the losing side of the war." },
  { key: "choir", name: "Crystalline Choir", standing: -3, note: "Territorial and unwilling to speak with outsiders." },
  { key: "skarn", name: "Skarn Dominion", standing: -2, note: "Wary neighbours with a history of border disputes." },
  { key: "blacktide", name: "Black Tide Syndicate", standing: -4, note: "Criminal network operating across borders." }
];

/* The built-in ten species, in order. Every one grants +3: "free" means the player places the three points on the
   officer's own attributes (Human), otherwise "bonus" spreads them over one to three crew attributes. */
const SPECIES = [
  { name: "Human", free: 3, bonus: {} },
  { name: "Seluun", bonus: { composure: 2, sensor_analysis: 1 } },
  { name: "Vey", bonus: { accuracy: 2, threat_assessment: 1 } },
  { name: "Ossan", bonus: { repair: 2, power_management: 1 } },
  { name: "Lirae", bonus: { diplomacy: 2, threat_assessment: 1 } },
  { name: "Joined Ament", bonus: { xenology: 1, improvisation: 1, command_presence: 1 } },
  { name: "Haldani", bonus: { improvisation: 2, composure: 1 } },
  { name: "Quell", bonus: { composure: 2, diplomacy: 1 } },
  { name: "Teneri", bonus: { xenology: 3 } },
  { name: "Drav", bonus: { accuracy: 3 } }
];

/* Resources a sector can hold, in the generator's fixed order, with the names shown to players. */
const RESOURCES = [
  { key: "aetherite", name: "Aetherite" },
  { key: "hydrex", name: "Hydrex" },
  { key: "corundite", name: "Corundite" },
  { key: "aurelium_ore", name: "Aurelium ore" },
  { key: "veilstone", name: "Veilstone" }
];

/* The words the setting uses for its technology, for prompts and narration. */
const TECHNOLOGY = {
  ftl: "jump",                    // jump drive, jump coil, jump core
  drive: "jump drive",
  sublight: "thrusters",
  beam_weapon: "lances",
  torpedo: "torpedoes",
  handheld_sensor: "scanner",
  teleporter: "matter relay"
};

/* Display names of the item catalogue, by catalogue id (rules.js holds the effects). */
const ITEM_NAMES = {
  power_cell: "Emergency power cell",
  power_cell_adv: "High-capacity power cell",
  medkit: "Medkit",
  surgical_kit: "Surgical kit",
  sensor_probe: "Sensor probe",
  shield_booster: "Shield booster",
  targeting_solution: "Targeting solution",
  universal_primer: "Linguistic primer",
  repair_drones: "Repair drones",
  jump_coil: "Overcharged jump coil",
  tactical_brief: "Tactical briefing",
  prototype_solver: "Prototype analysis core",
  targeting_module: "Targeting module",
  enhanced_deflector: "Enhanced deflector",
  sensor_array: "Long-range sensor array",
  thruster_tuning: "Thruster tuning kit",
  jump_core_upgrade: "Prototype jump core",
  ablative_plating: "Prototype ablative plating",
  field_hospital: "Field hospital kit"
};

/* Names of the grid presets, by preset key (rules.js holds the sizes and mission counts). */
const PRESET_NAMES = {
  skirmish: "Skirmish",
  standard: "Standard",
  expanse: "Expanse",
  deep_void: "Deep Void"
};

/* Display names of the generator's planet types (grid.js holds the keys and weights). */
const PLANET_TYPE_NAMES = {
  rocky: "Rocky",
  gas_giant: "Gas giant",
  ice: "Ice",
  ocean: "Ocean",
  desert: "Desert",
  temperate: "Temperate (habitable)",
  barren: "Barren"
};

module.exports = {
  POWER, SHIP_PREFIX, REGISTRY_PREFIX, REGISTRY_EXAMPLE, SHIP_EXAMPLE, FLEET_COMMAND, shipName, registry,
  WAR, ERA, FACTIONS, SPECIES, RESOURCES, TECHNOLOGY, ITEM_NAMES, PRESET_NAMES, PLANET_TYPE_NAMES
};
