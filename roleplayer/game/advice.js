"use strict";
/* The advice engine (§14.5 rule 5), ported from the plugin's class-advice.php.

   Advice gives no bonus of its own. When a captain asks an officer for advice, this module works out, from the real
   state of the ship, crew and stage, which courses of action would do most to make the stage's final move cheaper or
   likelier to succeed, and hands the best two to the narrator to voice. Every suggestion is true: each is something
   the rules reward, weighed by the odds this crew and this ship have of pulling it off.

   Pure logic: no storage, no LLM. Function names are camelCase; the PHP name is noted where it differs. */
const Rules = require("./rules.js");
const Engine = require("./engine.js");

const { intval } = Rules;

/* Which orders a damaged system makes harder (§7.5). */
const SYSTEM_HAMPERS = Object.freeze({
  weapons: ["attack"],
  sensors: ["scan"],
  engines: ["manoeuvre", "move"],
  shields: ["board"],
  communications: ["hail"],
  power: ["divert_power", "repair"]
});

/* Orders that roll and can build Momentum, with the words an officer would use for them. */
const APPROACHES = Object.freeze({
  scan: "scan what is in front of the ship",
  hail: "open a channel and talk",
  divert_power: "divert power to where it is needed",
  manoeuvre: "manoeuvre for a better position",
  repair: "put a repair team to work",
  attack: "strike first",
  board: "send a boarding party"
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* PHP's round($v, 3): halves away from zero, after first rounding to 15 significant digits as PHP does, so a value
   such as 1.0005 rounds up as it does there. */
function round3(v) {
  const pre = Number(Math.abs(v).toPrecision(15));
  return Math.sign(v) * (Math.round(pre * 1000) / 1000);
}

/* PHP: ship_penalty(). The penalty a roll of this kind carries from the ship's condition. */
function shipPenalty(actionClass, damaged, hull) {
  let pen = 0;
  for (const sys of damaged) {
    if ((own(SYSTEM_HAMPERS, sys) ? SYSTEM_HAMPERS[sys] : []).includes(actionClass)) pen++;
  }
  return pen + (intval(hull) < 50 ? 1 : 0);
}

/* Chances on a d20, as fractions of 1: success or better, and outright failure (a miss by 5 or more).
   A natural 20 always succeeds and a natural 1 always fails. Returns { success, failure }. */
function odds(mod, target) {
  let win = 0;
  let fail = 0;
  for (let face = 1; face <= 20; face++) {
    const out = Engine.outcome(face, mod, target).outcome;
    if (out === "success" || out === "critical_success") win++;
    else if (out === "failure") fail++;
  }
  return { success: win / 20, failure: fail / 20 };
}

/* PHP: modifier_for(). The modifier this crew and ship would bring to an order of this kind right now, or null if
   nobody can do it. */
function modifierFor(actionClass, c) {
  const [role, attr] = Rules.defaultActor(actionClass);
  const actor = Engine.resolveActor(c.crew, role, attr);
  if (!actor) return null;
  let ship = 0;
  for (const k of Rules.shipAttributesFor(actionClass, false, false)) {
    ship = Math.max(ship, Engine.shipBonus(c.ship && own(c.ship, k) ? c.ship[k] ?? 0 : 0));
  }
  const extra = ship + Rules.alertBonus(c.alert, actionClass, false);
  return Engine.modifier(actor.value, extra, actor.penalty, shipPenalty(actionClass, c.damaged, c.hull));
}

/* What one more point of Momentum is worth now: more when it lifts the stage out of a cold start. */
function momentumWorth(c) {
  return intval(c.momentum) === 0 ? 5.0 : 1.0; // +1 on the target, and at zero it also removes the cold-climax band (+4)
}

/* Every course of action worth suggesting, best first.
   c: in_stage (bool), momentum (int), used (classes that have already built Momentum), points (int, this
   captain's), obstacle_band (string), threat ('none'|'pending'|'active'), forced (bool), has_contacts (bool),
   alert (string), hull (int), damaged (string[]), crew (as stored), ship (attribute => value), items (catalogue ids
   held), injured (officer names).
   Returns [{ id, say (what to suggest), why (what it buys), value (for ranking) }]. */
function options(c) {
  const out = [];
  const climax = Rules.climaxCost();
  const bands = Rules.bands();
  const dc = own(bands, c.obstacle_band) ? bands[c.obstacle_band] : bands.tricky;
  const cold = c.in_stage && intval(c.momentum) <= 0;
  const add = (id, say, why, value) => {
    if (value > 0) out.push({ id, say, why, value: round3(value) });
  };

  if (c.in_stage && c.forced) {
    add("climax_now", "make the decisive move now", "the turn points are spent, so only the final move or a retreat remain", 9);
  }
  if (c.threat === "active") {
    add("answer_threat", "deal with the immediate threat before anything else", "any other order given while it stands is attempted at desperate difficulty", 8);
  }

  // The ship's condition drags on every roll it touches, including the final one.
  const pen = c.damaged.length + (intval(c.hull) < 50 ? 1 : 0);
  if (pen > 0) {
    const mod = modifierFor("repair", c);
    if (mod !== null) {
      const o = odds(mod, dc);
      const fresh = c.in_stage && !c.used.includes("repair") ? momentumWorth(c) : 0;
      const what = c.damaged.length ? "the damaged " + c.damaged.slice(0, 2).join(" and ") : "the hull";
      add("repair", `get ${what} repaired`, "damage to the ship counts against every order that depends on it, the final move included", o.success * (1.2 * pen + fresh) - o.failure);
    }
  }
  if (c.injured.length) {
    const mod = modifierFor("treat", c);
    if (mod !== null) {
      const o = odds(mod, dc);
      add("treat", "have " + c.injured[0] + " treated", "an officer out of action means someone less skilled covers their station", o.success * 1.5 * c.injured.length);
    }
  }

  if (c.in_stage && !c.forced) {
    // A fresh approach that works builds Momentum, and Momentum lowers the target of the final move.
    for (const [cls, say] of Object.entries(APPROACHES)) {
      if (c.used.includes(cls) || cls === "repair" || (cls === "hail" && !c.has_contacts)) continue;
      if (intval(c.points) - Rules.cost(cls, 2) < climax) continue; // it would leave too little for the final move
      const mod = modifierFor(cls, c);
      if (mod === null) continue;
      const o = odds(mod, dc);
      const why = cold
        ? "nothing has been set up yet, and going into the final move cold makes it a band harder"
        : "a fresh approach that works adds Momentum, which lowers the target of the final move";
      add("approach_" + cls, say, why, o.success * momentumWorth(c) - o.failure);
    }
    if (c.threat === "pending" && c.alert === "normal" && intval(c.points) - 2 >= climax) {
      // Red alert braces harder but reads as hostile; while talking is still an option, yellow is the better call.
      const talk = c.has_contacts && !c.used.includes("hail");
      add(
        talk ? "alert_yellow" : "alert_red",
        talk ? "go to yellow alert and raise shields" : "go to red alert, shields up and weapons ready",
        "if something here strikes first, a ship at alert takes less damage and answers it better" + (talk ? ", and yellow is less likely than red to be read as a threat" : ""),
        talk ? 2.0 : 2.6
      );
    }
    if (c.alert !== "normal" && c.threat !== "pending" && c.threat !== "active" && c.has_contacts && !c.used.includes("hail")) {
      const hail = own(Rules.ALERT, c.alert) ? Rules.ALERT[c.alert].hail : 0;
      add("alert_normal", "stand down from alert before opening a channel", "a ship at alert looks ready for a fight, which makes any hail harder", Math.abs(hail) * 0.6);
    }
    if (intval(c.momentum) >= 1 && intval(c.points) < climax + 2) {
      add("climax_now", "make the decisive move now", "the groundwork is laid and there are few turn points left to lay more", 3);
    }
  }

  // What is in the hold.
  const catalogue = Rules.items();
  const labels = Rules.attributes();
  for (const id of [...new Set(c.items)]) {
    const it = own(catalogue, id) ? catalogue[id] : null;
    if (!it || it.kind !== "consumable") continue;
    if (it.effect === "band_shift" && c.in_stage) {
      add("item_" + id, "use the " + it.name + " just before the final move", "it makes the next rolled order one band easier", 4);
    } else if (it.effect === "momentum" && c.in_stage) {
      add("item_" + id, "use the " + it.name, "it adds Momentum without a roll", momentumWorth(c));
    } else if (it.effect === "roll_bonus" && c.in_stage) {
      add("item_" + id, "use the " + it.name + " before a roll that calls on " + labels[it.attribute], "it adds to that roll", 0.8 * intval(it.value));
    }
  }

  out.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/* The two best courses of action, as the lines given to the narrator. Empty when there is nothing true to suggest. */
function brief(c) {
  return options(c).slice(0, 2).map(o => o.say.charAt(0).toUpperCase() + o.say.slice(1) + ", because " + o.why + ".");
}

module.exports = { SYSTEM_HAMPERS, APPROACHES, shipPenalty, odds, modifierFor, options, brief };
