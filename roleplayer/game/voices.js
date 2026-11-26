"use strict";
/* Voice assignment (§10, §3.4, §7.2.4), replacing the plugin's class-voices.php and class-tts.php.

   Every speaker (officer, Computer, character) has a voice of their own, matched to their gender. The voices are the
   app's local ones: the list main.js voices() gives for its standard voices, passed in as
   [{ id, name, gender: "male" | "female", accent }], best-rated first. The game server sends each line's text and
   voice id, and each player's app speaks it; nothing here makes sound.

   The plugin counted two Edge voice ids of one speaker as the same voice (its "timbre"). Every local voice is a
   different speaker, so a voice's timbre is its own id. The plugin also ranked its voices in quality tiers and handed
   out the best first; the local list comes already ordered best first, so a voice's quality is its place in that
   order. The plugin's fixed list of Computer voices has no local equivalent: the Computer takes the best voice of
   the chosen gender that no officer on the ship has, which is what the plugin did once its own list was used up. */
const { sha1 } = require("./text.js");

/* 'Male' or 'Female'; anything unrecognised is 'Female', as in the plugin. */
function gender(g) {
  return String(g ?? "").trim().toLowerCase() === "male" ? "Male" : "Female";
}

function createVoices(list = []) {
  const pool = [];
  const seen = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    const g = String(v && v.gender || "").toLowerCase();
    if (!v || !v.id || seen.has(String(v.id)) || (g !== "male" && g !== "female")) continue; // only voices with a gender of their own
    seen.add(String(v.id));
    pool.push({
      id: String(v.id),
      gender: g === "male" ? "Male" : "Female",
      locale: String(v.accent || ""),
      label: String(v.name || v.id) + (v.accent ? " (" + v.accent + ")" : ""),
      timbre: String(v.id),
      quality: pool.length + 1
    });
  }

  /* The pool, optionally only one gender (case-insensitive). Each entry: id, gender, locale, label, timbre, quality. */
  function voicePool(g = null) {
    if (g === null || g === undefined) return pool.map(v => Object.assign({}, v));
    const want = gender(g);
    return pool.filter(v => v.gender === want).map(v => Object.assign({}, v));
  }
  const get = id => {
    const v = pool.find(x => x.id === String(id ?? ""));
    return v ? Object.assign({}, v) : null;
  };
  /* Whether a voice id is one of the pool's. Any officer may have any voice, whatever their gender. */
  const isValid = id => get(id) !== null;
  /* The speaker behind a voice id ('' for an unknown id). */
  const timbre = id => {
    const v = get(id);
    return v ? v.timbre : "";
  };
  const timbres = ids => {
    const out = {};
    for (const id of ids || []) {
      const t = timbre(String(id));
      if (t !== "") out[t] = true;
    }
    return out;
  };

  /* Deterministic pick: among the gender's voices whose timbre is not taken, the one with the fewest uses, then the
     best quality, ties broken by a hash of seed + voice id. '' when nothing is left. */
  function pick(g, seed, taken, uses = {}) {
    let best = "";
    let rank = null;
    for (const v of voicePool(g)) {
      if (taken[v.timbre]) continue;
      const r = String(uses[v.timbre] || 0).padStart(6, "0") + String(v.quality).padStart(6, "0") + sha1(seed + "|" + v.id);
      if (rank === null || r < rank) {
        rank = r;
        best = v.id;
      }
    }
    return best;
  }

  /* Fill every officer's 'voice' (§10). A chosen voice is kept when it is one of the pool's and no earlier officer
     on this ship already has it; every other officer gets a gender-matched voice nobody else on the ship uses.
     crew: role -> officer with at least gender, voice and name. */
  function assignCrew(crew) {
    const out = JSON.parse(JSON.stringify(crew || {}));
    const used = {};
    const pending = [];
    for (const [role, o] of Object.entries(out)) {
      if (!o || typeof o !== "object") continue;
      const voice = String(o.voice ?? "").trim();
      const t = timbre(voice);
      if (voice !== "" && isValid(voice) && !used[t]) {
        used[t] = true;
        out[role].voice = voice;
      } else {
        pending.push(role);
      }
    }
    for (const role of pending) {
      const o = out[role];
      const voice = pick(String(o.gender ?? ""), (o.name ?? "") + "|" + role, used);
      used[timbre(voice)] = true;
      out[role].voice = voice;
    }
    return out;
  }

  /* Deterministic gender-matched pick for a seed, avoiding the voice ids in exclude. Seed with name + '|' + role to
     get the voice assignCrew() would choose for that officer alone. */
  const suggest = (g, seed, exclude = []) => pick(g, seed, timbres(exclude));

  /* The Computer's voice: the best voice of the gender (the app's setting) that is not in exclude. */
  function computerVoice(g, exclude = []) {
    const voice = pick(gender(g), "computer", timbres(exclude));
    if (voice !== "") return voice;
    const any = voicePool(gender(g))[0];
    return any ? any.id : "";
  }

  /* Voice for a character, remembered in world canon (§10, §7.2.4).
     - A character already in known keeps its voice for ever.
     - A new one gets a gender-matched voice that is not in exclude (the captains' officers and the Computer) and not
       used by any character in sceneKeys (those sharing the scene).
     - The least-used voice wins, so a voice is only reused once the whole pool has been handed out, and then only
       between characters who are not in the same scene.
     known: npc_key -> { voice, gender }. Returns { voice, known } with known updated. */
  function npcVoice(known, key, g, exclude, sceneKeys = []) {
    known = Object.assign({}, known || {});
    if (known[key] && known[key].voice !== undefined && get(String(known[key].voice)) !== null) return { voice: known[key].voice, known };
    g = gender(g);
    const banned = timbres(exclude);
    const scene = {};
    for (const k of sceneKeys) {
      if (k !== key && known[k] && known[k].voice !== undefined) scene[timbre(String(known[k].voice))] = true;
    }
    const uses = {};
    for (const [k, n] of Object.entries(known)) {
      if (k !== key && n && n.voice !== undefined) {
        const t = timbre(String(n.voice));
        uses[t] = (uses[t] || 0) + 1;
      }
    }
    // Preferred: outside the officers' and Computer's voices and outside the scene. If the scene alone holds every
    // remaining voice, a clash in the scene is better than taking an officer's voice; the last resort applies only
    // if exclude covers the whole of the gender's pool.
    let voice = pick(g, "npc|" + key, Object.assign({}, banned, scene), uses);
    if (voice === "") voice = pick(g, "npc|" + key, banned, uses);
    if (voice === "") voice = pick(g, "npc|" + key, {}, uses);
    known[key] = Object.assign({}, known[key] && typeof known[key] === "object" ? known[key] : {}, { voice, gender: g });
    return { voice, known };
  }

  return { pool: voicePool, get, isValid, timbre, assignCrew, suggest, computerVoice, npcVoice, gender };
}

module.exports = { createVoices, gender };
