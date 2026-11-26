"use strict";
/* Storage, replacing the plugin's class-db.php and the table helpers of class-game.php (§11.4).

   Everything lives under the data folder passed in (never computed here), one folder per game:
     <dataDir>/games/<id>/game.json       the game's shared state (what was the plugin's game post and its meta)
     <dataDir>/games/<id>/captains.json   one row per seat
     <dataDir>/games/<id>/events.json     the event log: append-only, one row per turn or system event (§11.1)
     <dataDir>/games/<id>/canon.json      world canon: generated facts and everything established in play
     <dataDir>/games/<id>/sectors.json    only non-empty or visited sectors; empty space is implicit (§5.3)
     <dataDir>/games/<id>/missions.json   missions
     <dataDir>/games/<id>/meta.json       a pause asked for while a turn held the game (the plugin's pause-request meta)
   Every write is atomic: the file is written to .tmp and renamed over the old one. Rows keep the plugin's column
   names. Ids count up from 1 within a game and are never reused. Times are stored as the plugin stored them, UTC
   "YYYY-MM-DD HH:MM:SS", which also decides the order canon is read in (updated_at to the second, then id).

   The plugin's database locks become a per-name async mutex here: one turn resolves at a time in each game (§3.3.2).
   Reads return copies, so a caller that changes a row changes nothing until it saves it, as with the database. */
const fs = require("fs");
const path = require("path");
const { gmdate, sha256, mbSubstr } = require("./text.js");

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const TABLES = ["captains", "events", "canon", "sectors", "missions", "meta"];

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

function createStore(dataDir) {
  if (!dataDir) throw new Error("The game store needs a data folder.");
  const root = path.join(dataDir, "games");
  const cache = new Map(); // game id -> { game, captains, events, canon, sectors, missions, meta }

  const dir = id => path.join(root, String(Math.trunc(Number(id))));
  const empty = () => ({ game: null, captains: [], events: [], canon: [], sectors: {}, missions: [], meta: {} });

  /* The tables of one game, loaded on first use. */
  function tables(id) {
    id = Math.trunc(Number(id));
    if (!cache.has(id)) {
      const d = dir(id), t = empty();
      t.game = readJson(path.join(d, "game.json"), null);
      for (const name of TABLES) t[name] = readJson(path.join(d, name + ".json"), t[name]);
      cache.set(id, t);
    }
    return cache.get(id);
  }
  function flush(id, name) {
    const t = tables(id);
    writeAtomic(path.join(dir(id), name + ".json"), name === "game" ? t.game : t[name]);
  }
  const nextId = rows => rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;

  /* ---------- games ---------- */

  function gameIds() {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return names.filter(n => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
  }
  /* A new game: given its id, written, and returned. */
  function createGame(g) {
    const id = (gameIds().pop() || 0) + 1;
    const t = empty();
    t.game = Object.assign({}, g, { id });
    cache.set(id, t);
    fs.mkdirSync(dir(id), { recursive: true });
    flush(id, "game");
    return clone(t.game);
  }
  function getGame(id) {
    if (!(Number(id) > 0)) return null;
    const t = tables(id);
    return t.game ? clone(t.game) : null;
  }
  function saveGame(g) {
    const id = Math.trunc(Number(g.id));
    const t = tables(id);
    const copy = clone(g);
    copy.id = id;
    t.game = copy;
    flush(id, "game");
  }
  function gameByToken(token) {
    for (const id of gameIds()) {
      const t = tables(id);
      if (t.game && t.game.token === token) return clone(t.game);
    }
    return null;
  }
  function allGames() {
    return gameIds().map(id => tables(id).game).filter(Boolean).map(clone);
  }
  /* Delete everything belonging to a game (the admin deletes a campaign, §11.5). */
  function purgeGame(id) {
    cache.delete(Math.trunc(Number(id)));
    fs.rmSync(dir(id), { recursive: true, force: true });
  }

  /* The post meta value set without the game lock: a pause asked for while a turn was being resolved. */
  function getMeta(id, key) {
    return clone(tables(id).meta[key]);
  }
  function setMeta(id, key, value) {
    const t = tables(id);
    if (value === undefined || value === null) delete t.meta[key];
    else t.meta[key] = clone(value);
    flush(id, "meta");
  }

  /* ---------- locks ---------- */

  const locks = new Map(); // name -> array of waiting resolvers; present while held
  /* Take a lock, waiting at most `wait` seconds. Resolves true when it is held. */
  function lock(name, wait = 8) {
    if (!locks.has(name)) {
      locks.set(name, []);
      return Promise.resolve(true);
    }
    if (!(wait > 0)) return Promise.resolve(false);
    return new Promise(resolve => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const q = locks.get(name);
        if (q) {
          const i = q.indexOf(waiter);
          if (i >= 0) q.splice(i, 1);
        }
        resolve(false);
      }, wait * 1000);
      locks.get(name).push(waiter);
    });
  }
  function unlock(name) {
    const q = locks.get(name);
    if (!q) return;
    const next = q.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(true); // handed straight over: the lock stays held
    } else {
      locks.delete(name);
    }
  }
  const locked = name => locks.has(name);

  /* ---------- the event log ---------- */

  function event(gameId, captainId, type, data, turnNo = 0, tokensIn = 0, tokensOut = 0) {
    const t = tables(gameId);
    const row = {
      id: nextId(t.events), game_id: Math.trunc(Number(gameId)), captain_id: Math.trunc(Number(captainId) || 0),
      turn_no: Math.trunc(Number(turnNo) || 0), type, data: clone(data || {}),
      tokens_in: Math.trunc(Number(tokensIn) || 0), tokens_out: Math.trunc(Number(tokensOut) || 0), created_at: gmdate()
    };
    t.events.push(row);
    flush(gameId, "events");
    return row.id;
  }
  /* Fill in fields held back when an event was written (a narration that arrived late). */
  function eventMerge(gameId, id, merge) {
    const t = tables(gameId);
    const row = t.events.find(r => r.id === Number(id));
    if (row) {
      row.data = Object.assign({}, row.data, clone(merge));
      flush(gameId, "events");
    }
  }
  /* args: captain_id, types, after_id, limit (1..2000, 200), order ASC|DESC */
  function events(gameId, args = {}) {
    let rows = tables(gameId).events;
    if (args.captain_id !== undefined) rows = rows.filter(r => r.captain_id === Number(args.captain_id));
    if (args.types && args.types.length) rows = rows.filter(r => args.types.includes(r.type));
    if (args.after_id) rows = rows.filter(r => r.id > Number(args.after_id));
    rows = rows.slice();
    if (args.order === "DESC") rows.reverse();
    const limit = Math.max(1, Math.min(2000, Math.trunc(Number(args.limit ?? 200)) || 0));
    return clone(rows.slice(0, limit));
  }
  const maxEventId = gameId => tables(gameId).events.reduce((m, r) => Math.max(m, r.id), 0);

  /* ---------- world canon ---------- */

  function canonAdd(gameId, kind, subject, data, tags = {}) {
    const t = tables(gameId);
    const now = gmdate();
    const row = {
      id: nextId(t.canon), game_id: Math.trunc(Number(gameId)), scope: String(tags.scope ?? "shared"), kind,
      subject: mbSubstr(String(subject ?? ""), 0, 190), sector: String(tags.sector ?? ""),
      mission_id: Math.trunc(Number(tags.mission_id ?? 0) || 0), faction: String(tags.faction ?? ""),
      data: clone(data || {}), created_at: now, updated_at: now
    };
    t.canon.push(row);
    flush(gameId, "canon");
    return row.id;
  }
  /* Merge fields into one canon row of this game. Returns the updated row, or null. */
  function canonMerge(gameId, id, merge) {
    const t = tables(gameId);
    const row = t.canon.find(r => r.id === Number(id));
    if (!row) return null;
    row.data = Object.assign({}, row.data, clone(merge));
    row.updated_at = gmdate();
    flush(gameId, "canon");
    return clone(row);
  }
  /* Insert or replace the single canon row for a kind + subject (+ scope). */
  function canonSet(gameId, kind, subject, data, tags = {}) {
    const t = tables(gameId);
    const scope = String(tags.scope ?? "shared");
    const row = t.canon.find(r => r.kind === kind && r.subject === subject && r.scope === scope);
    if (!row) return canonAdd(gameId, kind, subject, data, tags);
    row.data = clone(data || {});
    row.updated_at = gmdate();
    for (const k of ["sector", "faction"]) if (tags[k] !== undefined && tags[k] !== null) row[k] = String(tags[k]);
    flush(gameId, "canon");
    return row.id;
  }
  /* args: kind (string|array), subject, sector, faction, mission_id, scopes (array), limit (1..1000, 200).
     Newest first: updated_at, then id. */
  function canon(gameId, args = {}) {
    let rows = tables(gameId).canon;
    if (args.kind && (!Array.isArray(args.kind) || args.kind.length)) {
      const kinds = Array.isArray(args.kind) ? args.kind : [args.kind];
      rows = rows.filter(r => kinds.includes(r.kind));
    }
    for (const k of ["subject", "sector", "faction", "mission_id"]) {
      if (args[k] !== undefined && args[k] !== null && args[k] !== "") {
        rows = rows.filter(r => (k === "mission_id" ? r[k] === Math.trunc(Number(args[k])) : r[k] === String(args[k])));
      }
    }
    if (args.scopes && args.scopes.length) {
      const scopes = args.scopes.map(String);
      rows = rows.filter(r => scopes.includes(r.scope));
    }
    rows = rows.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id));
    const limit = Math.max(1, Math.min(1000, Math.trunc(Number(args.limit ?? 200)) || 0));
    return clone(rows.slice(0, limit));
  }

  /* ---------- captains ---------- */

  /* Every seat, by seat then id, as a Map of id -> row (the order is the turn order of joining). */
  function captains(gameId) {
    const rows = tables(gameId).captains.slice().sort((a, b) => a.seat - b.seat || a.id - b.id);
    return new Map(rows.map(r => [r.id, clone(r)]));
  }
  function captainByToken(gameId, token) {
    const h = sha256(String(token ?? ""));
    const row = tables(gameId).captains.find(r => r.token_hash === h);
    return row ? clone(row) : null;
  }
  function insertCaptain(gameId, row) {
    const t = tables(gameId);
    const r = Object.assign({ seat: 0, token_hash: "", device: "", name: "", build_id: 0, ready: 0, state: {}, last_seen: gmdate() }, clone(row), { id: nextId(t.captains), game_id: Math.trunc(Number(gameId)) });
    t.captains.push(r);
    flush(gameId, "captains");
    return r.id;
  }
  /* The plugin's save_captain(): state, ready, name, build and seat. */
  function saveCaptain(c) {
    updateCaptain(c.game_id, c.id, { state: c.state, ready: c.ready ? 1 : 0, name: c.name, build_id: Math.trunc(Number(c.build_id) || 0), seat: Math.trunc(Number(c.seat) || 0) });
  }
  function updateCaptain(gameId, id, fields) {
    const t = tables(gameId);
    const row = t.captains.find(r => r.id === Number(id));
    if (!row) return false;
    Object.assign(row, clone(fields));
    flush(gameId, "captains");
    return true;
  }
  function deleteCaptain(gameId, id) {
    const t = tables(gameId);
    t.captains = t.captains.filter(r => r.id !== Number(id));
    flush(gameId, "captains");
  }
  const touch = (gameId, id) => updateCaptain(gameId, id, { last_seen: gmdate() });

  /* ---------- sectors ---------- */

  /* Every stored sector: coord -> { status, faction, data }. */
  function sectors(gameId) {
    return clone(tables(gameId).sectors);
  }
  function sectorRow(gameId, coord) {
    const s = tables(gameId).sectors[coord];
    return s ? clone(s) : null;
  }
  function putSector(gameId, coord, row) {
    tables(gameId).sectors[coord] = clone(row);
    flush(gameId, "sectors");
  }
  /* Replace every sector at once (phase 1 of generation). */
  function replaceSectors(gameId, map) {
    tables(gameId).sectors = clone(map);
    flush(gameId, "sectors");
  }

  /* ---------- missions ---------- */

  /* Missions by spine then id, as a Map of id -> row, optionally only those of the given status(es). */
  function missions(gameId, status = null) {
    let rows = tables(gameId).missions;
    if (status) {
      const st = Array.isArray(status) ? status : [status];
      rows = rows.filter(r => st.includes(r.status));
    }
    rows = rows.slice().sort((a, b) => a.spine - b.spine || a.id - b.id);
    return new Map(rows.map(r => [r.id, clone(r)]));
  }
  function insertMission(gameId, row) {
    const t = tables(gameId);
    const r = Object.assign(clone(row), { id: nextId(t.missions), game_id: Math.trunc(Number(gameId)), created_at: gmdate() });
    t.missions.push(r);
    flush(gameId, "missions");
    return r.id;
  }
  /* The plugin's save_mission(): status, data and sector. */
  function saveMission(row) {
    const t = tables(row.game_id);
    const r = t.missions.find(x => x.id === Number(row.id));
    if (!r) return;
    r.status = row.status;
    r.data = clone(row.data);
    r.sector = row.sector;
    flush(row.game_id, "missions");
  }

  return {
    dataDir, createGame, getGame, saveGame, gameByToken, allGames, gameIds, purgeGame, getMeta, setMeta,
    lock, unlock, locked,
    event, eventMerge, events, maxEventId,
    canonAdd, canonMerge, canonSet, canon,
    captains, captainByToken, insertCaptain, saveCaptain, updateCaptain, deleteCaptain, touch,
    sectors, sectorRow, putSector, replaceSectors,
    missions, insertMission, saveMission
  };
}

module.exports = { createStore };
