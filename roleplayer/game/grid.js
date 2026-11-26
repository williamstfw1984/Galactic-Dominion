"use strict";
/* Phase-1 universe generator (§5.3) and grid geometry / travel maths (§5.1, §7.4, §7.2.3), ported from the plugin's
   class-grid.php.

   No I/O, no LLM. Deterministic: the same size and seed give the same galaxy, bit for bit, as the PHP generator did
   (the PRNG is mulberry32 on unsigned 32-bit integers, seeded from sha256, and every draw happens in the same order).
   Resource keys and the habitable planet type carry the setting's names; everything else is as in the plugin.

   Coordinates are integer [x, y, z] lists, 0..size-1 on each axis. Every integer coordinate is a valid sector; only
   non-empty sectors are stored, empty space is implicit. Directional labels: +x is East, +y is North, +z is Upper.
   Function names are camelCase; the PHP name is noted where it differs. */
const crypto = require("crypto");
const Rules = require("./rules.js");

const { intval } = Rules;

const MIN_GRID = 2;

const TYPES = Object.freeze(["star_system", "nebula", "anomaly", "station"]); // 'empty' is implicit.
const STAR_CLASSES = Object.freeze(["O", "B", "A", "F", "G", "K", "M"]);
const PLANET_TYPES = Object.freeze(["rocky", "gas_giant", "ice", "ocean", "desert", "temperate", "barren"]); // 'temperate' is the only habitable type
const HABITABILITY = Object.freeze(["none", "marginal", "habitable"]);
const RESOURCES = Object.freeze(["aetherite", "hydrex", "corundite", "aurelium_ore", "veilstone"]); // Empty list = none.
const HAZARDS = Object.freeze(["ion_storm", "radiation", "gravitational_shear", "subspace_rift", "asteroid_field", "pulsar"]);
const SECTOR_FIELDS = Object.freeze(["x", "y", "z", "type", "star_class", "planets", "habitability", "resources", "hazard", "faction", "notable", "name"]);

/* Generation odds, in parts per 10,000 (integer maths only, so results match on any machine). */
const NEBULA_SHARE = 700;  // ~7% of all sectors, placed as coherent blobs.
const STATION_ODDS = 100;  // ~1% of the remaining sectors.
const ANOMALY_ODDS = 200;  // ~2%.
const SYSTEM_ODDS = 2300;  // ~23%. Total non-empty lands at roughly 31%.
const NOTABLE_ODDS = 650;  // ~6.5% of non-empty sectors carry a notable physical feature.

/* ---------------------------------------------------------------------
 * Deterministic PRNG. One instance per generation (the PHP class kept it in a static; the draws are the same).
 * ------------------------------------------------------------------- */

function makePrng(size, seed) {
  // PHP: seed_prng(). sha256 is identical everywhere; take the first 32 bits.
  let state = parseInt(crypto.createHash("sha256").update(size + "|" + seed, "utf8").digest("hex").slice(0, 8), 16) >>> 0;

  /* PHP: next_u32(). mulberry32: next unsigned 32-bit value. Math.imul gives the low 32 bits of the product, as the
     PHP imul() did in 16-bit halves; >>> 0 keeps every intermediate unsigned like PHP's & 0xFFFFFFFF. */
  function nextU32() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ ((t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0)) >>> 0)) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /* PHP: rand_int(). Uniform integer in 0..n-1: (u32 * n) >> 32. Exact in a double for n below 2^21, which every
     caller is (at most 10000). */
  function randInt(n) {
    return Math.floor((nextU32() * n) / 4294967296);
  }

  /* True with probability odds / 10000. */
  function chance(odds) {
    return randInt(10000) < odds;
  }

  /* Weighted pick from [[value, integer weight], ...], in list order (the PHP array's key order). */
  function pick(weights) {
    let roll = randInt(weights.reduce((s, w) => s + w[1], 0));
    for (const [value, w] of weights) {
      if (roll < w) return value;
      roll -= w;
    }
    return weights[weights.length - 1][0];
  }

  return { randInt, chance, pick };
}

/* ---------------------------------------------------------------------
 * Phase 1 generator
 * ------------------------------------------------------------------- */

/* PHP: clamp_size() */
function clampSize(size) {
  return Math.max(MIN_GRID, Math.min(Rules.MAX_GRID, intval(size)));
}

/* Generate the physical universe. Same size + seed always yields identical output.
   Returns { size, seed, ly_per_unit, sectors: { 'x,y,z': sector }, regions: [...] }. */
function generate(size, seed) {
  size = clampSize(size);
  seed = Rules.phpStrval(seed);
  const rng = makePrng(size, seed);

  const nebulae = growNebulae(rng, size);
  const sectors = {};

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        const key = `${x},${y},${z}`;
        let type;
        if (nebulae.has(key)) {
          type = "nebula";
        } else {
          const roll = rng.randInt(10000);
          if (roll < STATION_ODDS) type = "station";
          else if (roll < STATION_ODDS + ANOMALY_ODDS) type = "anomaly";
          else if (roll < STATION_ODDS + ANOMALY_ODDS + SYSTEM_ODDS) type = "star_system";
          else continue; // Empty space: implicit, not stored.
        }
        sectors[key] = buildSector(rng, x, y, z, type);
      }
    }
  }

  const grid = { size, seed, ly_per_unit: Rules.LY_PER_UNIT, sectors };
  grid.regions = buildRegions(size, sectors);
  return grid;
}

/* PHP: grow_nebulae(). Nebulae as spatially coherent blobs: a few seed cells, then growth by accretion (a random
   existing nebula cell gains a random face-neighbour) until the target cell count is reached.
   Returns a Set of 'x,y,z'. */
function growNebulae(rng, size) {
  const total = size * size * size;
  const target = Math.floor((total * NEBULA_SHARE + 5000) / 10000);
  const set = new Set();
  const cells = [];
  if (target < 1) return set;
  const blobs = Math.min(target, Math.floor(size / 3) + 1);
  let guard = 0;
  while (cells.length < blobs && guard++ < 1000) {
    const c = [rng.randInt(size), rng.randInt(size), rng.randInt(size)];
    const key = `${c[0]},${c[1]},${c[2]}`;
    if (!set.has(key)) {
      set.add(key);
      cells.push(c);
    }
  }
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  guard = target * 400;
  while (cells.length < target && guard-- > 0) {
    const c = cells[rng.randInt(cells.length)];
    const d = dirs[rng.randInt(6)];
    const n = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
    if (!inBounds(size, n)) continue;
    const key = `${n[0]},${n[1]},${n[2]}`;
    if (!set.has(key)) {
      set.add(key);
      cells.push(n);
    }
  }
  return set;
}

/* Two-digit, zero-padded like PHP's %02d (a negative number keeps its sign and is not padded further). */
function pad2(n) {
  n = intval(n);
  return String(n).padStart(2, "0"); // "-5" is already two characters, as PHP prints it
}

/* Neutral catalogue designation, e.g. 'Sector 07-04-09'. Naming places is the story phase's job. */
function designation(x, y, z) {
  return `Sector ${pad2(x)}-${pad2(y)}-${pad2(z)}`;
}

/* PHP: build_sector() */
function buildSector(rng, x, y, z, type) {
  const s = {
    x, y, z, type,
    star_class: null,
    planets: [],
    habitability: "none",
    resources: [],
    hazard: null,
    faction: null, // Phase 2 assigns controlling factions.
    notable: null,
    name: designation(x, y, z)
  };
  let features;

  if (type === "star_system") {
    // Realistic-ish: M and K dwarfs dominate, O and B are rare.
    s.star_class = rng.pick([["O", 1], ["B", 2], ["A", 4], ["F", 9], ["G", 14], ["K", 25], ["M", 45]]);
    s.planets = buildPlanets(rng, s.star_class);
    let habitable = false;
    let marginal = false;
    for (const p of s.planets) {
      habitable = habitable || p.habitable;
      marginal = marginal || p.type === "ocean" || p.type === "desert";
    }
    s.habitability = habitable ? "habitable" : marginal ? "marginal" : "none";
    if (s.planets.length) {
      const n = rng.pick([[0, 45], [1, 40], [2, 15]]);
      s.resources = pickResources(rng, n, [["aetherite", 12], ["hydrex", 32], ["corundite", 30], ["aurelium_ore", 10], ["veilstone", 16]]);
    }
    if (rng.chance(1200)) {
      s.hazard = rng.pick([["asteroid_field", 45], ["radiation", 25], ["ion_storm", 20], ["gravitational_shear", 10]]);
    }
    features = ["Binary star", "Trinary star", "Dense ring system", "Extensive asteroid belt", "Protoplanetary disc", "Unusually active corona", "Tidally locked inner world", "Large cometary cloud"];
  } else if (type === "nebula") {
    if (rng.chance(4000)) s.resources = pickResources(rng, 1, [["hydrex", 80], ["aetherite", 10], ["veilstone", 10]]);
    if (rng.chance(3000)) s.hazard = rng.pick([["ion_storm", 55], ["radiation", 35], ["gravitational_shear", 10]]);
    features = ["Protostellar nursery", "Dense dust lanes", "Luminous emission core", "Rogue planet", "Dark molecular cloud"];
  } else if (type === "anomaly") {
    if (rng.chance(1500)) s.resources = pickResources(rng, 1, [["aetherite", 60], ["veilstone", 40]]);
    if (rng.chance(6500)) s.hazard = rng.pick([["subspace_rift", 35], ["gravitational_shear", 30], ["pulsar", 20], ["radiation", 15]]);
    features = ["Rogue planet", "Stable gravitational lens", "Dark matter concentration", "Stellar remnant", "Brown dwarf"];
  } else { // Station: a structure in open space; who built or holds it is the story phase's call.
    if (rng.chance(500)) s.hazard = rng.pick([["asteroid_field", 60], ["radiation", 40]]);
    features = ["Adjacent debris field", "Rogue planet", "Captured asteroid cluster"];
  }

  if (rng.chance(NOTABLE_ODDS)) s.notable = features[rng.randInt(features.length)];
  return s;
}

/* PHP: build_planets() */
function buildPlanets(rng, starClass) {
  const count = rng.pick([[0, 8], [1, 12], [2, 16], [3, 18], [4, 16], [5, 12], [6, 9], [7, 6], [8, 3]]);
  let weights;
  if (starClass === "O" || starClass === "B" || starClass === "A") {
    weights = [["rocky", 20], ["gas_giant", 30], ["ice", 5], ["desert", 10], ["barren", 35]];
  } else if (starClass === "M") {
    weights = [["rocky", 25], ["gas_giant", 10], ["ice", 27], ["ocean", 4], ["desert", 8], ["temperate", 2], ["barren", 24]];
  } else { // F, G, K.
    weights = [["rocky", 22], ["gas_giant", 20], ["ice", 13], ["ocean", 8], ["desert", 12], ["temperate", 5], ["barren", 20]];
  }
  const planets = [];
  for (let i = 0; i < count; i++) {
    const type = rng.pick(weights);
    planets.push({ type, habitable: type === "temperate" });
  }
  return planets;
}

/* PHP: pick_resources(). n distinct resources, returned in the fixed RESOURCES order. */
function pickResources(rng, n, weights) {
  const chosen = new Set();
  weights = weights.slice();
  while (n-- > 0 && weights.length) {
    const r = rng.pick(weights);
    weights = weights.filter(w => w[0] !== r);
    chosen.add(r);
  }
  return RESOURCES.filter(r => chosen.has(r));
}

/* Regions per axis: octants (2) normally, 3x3x3 for size >= 16. */
function divisions(size) {
  return size >= 16 ? 3 : 2;
}

/* PHP: slice_of(). Index of the region slice a coordinate falls in on one axis. */
function sliceOf(size, n, v) {
  for (let i = 0; i < n; i++) {
    if (v < Math.floor(((i + 1) * size) / n)) return i;
  }
  return n - 1;
}

/* PHP: region_label() */
function regionLabel(n, xi, yi, zi) {
  if (n === 2) return (zi ? "Upper" : "Lower") + " " + (yi ? "North" : "South") + "-" + (xi ? "East" : "West");
  const v = ["Lower", "Middle", "Upper"][zi];
  const ns = ["South", "", "North"][yi];
  const ew = ["West", "", "East"][xi];
  let h;
  if (ns === "" && ew === "") h = "Central";
  else if (ns === "" || ew === "") h = ns + ew;
  else h = `${ns}-${ew}`;
  return `${v} ${h}`;
}

/* PHP: build_regions() */
function buildRegions(size, sectors) {
  const n = divisions(size);
  const regions = {};
  for (let xi = 0; xi < n; xi++) {
    for (let yi = 0; yi < n; yi++) {
      for (let zi = 0; zi < n; zi++) {
        const lo = [Math.floor((xi * size) / n), Math.floor((yi * size) / n), Math.floor((zi * size) / n)];
        const hi = [Math.floor(((xi + 1) * size) / n) - 1, Math.floor(((yi + 1) * size) / n) - 1, Math.floor(((zi + 1) * size) / n) - 1];
        const id = `r-${xi}-${yi}-${zi}`;
        regions[id] = {
          id,
          label: regionLabel(n, xi, yi, zi),
          bounds: [lo, hi],
          counts: { star_system: 0, nebula: 0, anomaly: 0, station: 0, empty: (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) },
          habitable_systems: 0,
          hazards: 0
        };
      }
    }
  }
  for (const s of Object.values(sectors)) {
    const r = regions[regionId(size, [s.x, s.y, s.z])];
    r.counts[s.type]++;
    r.counts.empty--;
    if (s.type === "star_system" && s.habitability === "habitable") r.habitable_systems++;
    if (s.hazard !== null) r.hazards++;
  }
  return Object.values(regions);
}

/* PHP: region_id(). Region id ('r-xi-yi-zi') containing a coordinate. */
function regionId(size, c) {
  size = intval(size);
  const n = divisions(size);
  c = xyz(c);
  return "r-" + sliceOf(size, n, c[0]) + "-" + sliceOf(size, n, c[1]) + "-" + sliceOf(size, n, c[2]);
}

/* The summarised grid handed to the phase-2 story LLM (§5.3): region-level description plus notable systems only.

   Notable selection (deterministic): candidates are stations, anomalies, habitable systems and any sector with a
   'notable' feature. Score = station 100 / anomaly 80 / habitable system 60 / other 0, plus 30 for a notable feature.
   Within each region candidates are ranked by score (highest first), then x, y, z. Entries are then taken round-robin
   across regions in region order (best of each region first) until maxNotable is reached, so the list is spread out. */
function summarise(grid, maxNotable = 40) {
  const size = intval(grid.size);
  maxNotable = intval(maxNotable);
  const sectors = grid.sectors && typeof grid.sectors === "object" ? grid.sectors : {};
  const regions = grid.regions ? grid.regions : buildRegions(size, sectors);

  const byRegion = new Map();
  for (const r of regions) byRegion.set(r.id, []);
  for (const s of Object.values(sectors)) {
    let score = 0;
    if (s.type === "station") score = 100;
    else if (s.type === "anomaly") score = 80;
    else if (s.habitability === "habitable") score = 60;
    if (s.notable !== null) score += 30;
    if (score > 0) {
      const id = regionId(size, [s.x, s.y, s.z]);
      if (!byRegion.has(id)) byRegion.set(id, []);
      byRegion.get(id).push([score, s]);
    }
  }
  const key = e => [-e[0], e[1].x, e[1].y, e[1].z];
  for (const list of byRegion.values()) {
    list.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      return 0;
    });
  }

  const notable = [];
  for (let round = 0; notable.length < maxNotable; round++) {
    let took = false;
    for (const list of byRegion.values()) {
      if (round < list.length && notable.length < maxNotable) {
        const s = list[round][1];
        took = true;
        notable.push({
          coord: coordKey([s.x, s.y, s.z]),
          type: s.type,
          star_class: s.star_class,
          planets: s.planets.length,
          habitability: s.habitability,
          hazard: s.hazard,
          notable: s.notable,
          name: s.name
        });
      }
    }
    if (!took) break;
  }

  return {
    size,
    ly_per_unit: Rules.LY_PER_UNIT,
    width_ly: size * Rules.LY_PER_UNIT,
    total_sectors: size * size * size,
    non_empty: Object.keys(sectors).length,
    regions: regions.slice(),
    notable
  };
}

/* PHP: sector_at(). The stored sector, an implicit empty sector for valid empty coordinates, or null out of bounds. */
function sectorAt(grid, x, y, z) {
  x = intval(x);
  y = intval(y);
  z = intval(z);
  if (!inBounds(intval(grid.size), [x, y, z])) return null;
  const key = `${x},${y},${z}`;
  if (grid.sectors && Object.prototype.hasOwnProperty.call(grid.sectors, key) && grid.sectors[key] !== null) return grid.sectors[key];
  return {
    x, y, z,
    type: "empty",
    star_class: null,
    planets: [],
    habitability: "none",
    resources: [],
    hazard: null,
    faction: null,
    notable: null,
    name: designation(x, y, z)
  };
}

/* ---------------------------------------------------------------------
 * Geometry and travel (§5.1, §7.4, §7.2.3)
 * ------------------------------------------------------------------- */

/* Normalise a coordinate ([x,y,z] list or { x, y, z }) to an integer list. */
function xyz(c) {
  if (!Array.isArray(c) && c && c.x !== undefined && c.x !== null && c.y !== undefined && c.y !== null && c.z !== undefined && c.z !== null) {
    return [intval(c.x), intval(c.y), intval(c.z)];
  }
  const v = Array.isArray(c) ? c : c && typeof c === "object" ? Object.values(c) : [];
  return [intval(v[0] ?? 0), intval(v[1] ?? 0), intval(v[2] ?? 0)];
}

const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/* Squared distance in grid units (exact integer). */
function dist2(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/* PHP: in_bounds() */
function inBounds(size, c) {
  size = intval(size);
  c = xyz(c);
  return c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < size && c[1] < size && c[2] < size;
}

/* PHP: parse_coord(). 'x,y,z' (non-negative integers, optional spaces) => [x,y,z], or null if malformed. */
function parseCoord(s) {
  // PHP's \s without /u, and its $ that also matches before a final newline (which \s* takes anyway).
  const m = /^[ \t\n\r\v\f]*(\d{1,4})[ \t\n\r\v\f]*,[ \t\n\r\v\f]*(\d{1,4})[ \t\n\r\v\f]*,[ \t\n\r\v\f]*(\d{1,4})[ \t\n\r\v\f]*$/.exec(String(s));
  if (!m) return null;
  return [intval(m[1]), intval(m[2]), intval(m[3])];
}

/* PHP: coord_key() */
function coordKey(c) {
  c = xyz(c);
  return `${c[0]},${c[1]},${c[2]}`;
}

/* PHP: distance_units(). Straight-line (Euclidean) distance in grid units. */
function distanceUnits(a, b) {
  return Math.sqrt(dist2(xyz(a), xyz(b)));
}

/* PHP: distance_ly(). Straight-line distance in light-years (§7.4: 5 ly per grid unit). */
function distanceLy(a, b) {
  return distanceUnits(a, b) * Rules.LY_PER_UNIT;
}

/* §7.4 step 2: distance <= max range means the ship arrives this turn. */
function reachable(from, to, rangeLy) {
  return distanceLy(from, to) <= Number(rangeLy) + 1e-9;
}

/* In-bounds integer sectors (excluding from) within rangeLy of from, in x, y, z order. */
function candidates(size, from, rangeLy) {
  const out = [];
  if (rangeLy < 0) return out;
  const r = Math.floor((rangeLy + 1e-9) / Rules.LY_PER_UNIT);
  for (let x = Math.max(0, from[0] - r); x <= Math.min(size - 1, from[0] + r); x++) {
    for (let y = Math.max(0, from[1] - r); y <= Math.min(size - 1, from[1] + r); y++) {
      for (let z = Math.max(0, from[2] - r); z <= Math.min(size - 1, from[2] + r); z++) {
        const c = [x, y, z];
        if (!same(c, from) && reachable(from, c, rangeLy)) out.push(c);
      }
    }
  }
  return out;
}

/* PHP: partial_destination(). §7.4 step 3, "go as far as possible along the route".

   Exact selection rule. Candidates are every in-bounds integer sector, other than from, whose straight-line distance
   from from is <= rangeLy (same 1e-9 tolerance as reachable()). Choose:
     1. the candidate with the smallest distance to the destination (most progress);
     2. tie: the smallest perpendicular distance to the infinite straight line from -> to;
     3. tie: lowest x, then lowest y, then lowest z.
   A candidate is only accepted if it is strictly closer to the destination than from is, so a "partial journey"
   never moves the ship away from where it is going. Returns from when there is no such candidate (range under one
   grid unit, or from == to). If the destination itself is within range it is returned (distance 0 wins rule 1).
   All comparisons use exact integer squared distances, so the result is fully deterministic. */
function partialDestination(size, from, to, rangeLy) {
  size = intval(size);
  rangeLy = Number(rangeLy);
  from = xyz(from);
  to = xyz(to);
  const dir = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  let best = from;
  let moved = false; // PHP compared best === from; a candidate is never equal to from
  let bd = dist2(from, to);
  let bp = 0;
  for (const c of candidates(size, from, rangeLy)) { // Iterated in x, y, z order.
    const d = dist2(c, to);
    if (d > bd || (!moved && d >= bd)) continue;
    // |(c - from) x dir|^2 is proportional to the squared perpendicular distance to the line.
    const v = [c[0] - from[0], c[1] - from[1], c[2] - from[2]];
    const cx = v[1] * dir[2] - v[2] * dir[1];
    const cy = v[2] * dir[0] - v[0] * dir[2];
    const cz = v[0] * dir[1] - v[1] * dir[0];
    const p = cx * cx + cy * cy + cz * cz;
    // Strict comparisons + x,y,z iteration order give the lowest-coordinate tie-break.
    if (d < bd || p < bp) {
      best = c;
      moved = true;
      bd = d;
      bp = p;
    }
  }
  return best.slice();
}

/* PHP: nearest_sector(). §7.2.3 retreat target: the nearest OTHER in-bounds sector by Euclidean distance; ties broken
   by lowest x, then lowest y, then lowest z. Returns from only if the grid has no other sector. */
function nearestSector(size, from) {
  size = intval(size);
  from = xyz(from);
  let best = from;
  let bd = Infinity;
  // When from is in bounds the answer is always a face-neighbour; the wider scan only matters for defensive handling
  // of an out-of-bounds start.
  const r = inBounds(size, from) ? 1 : size + Math.max(...from.map(Math.abs));
  for (let x = Math.max(0, from[0] - r); x <= Math.min(size - 1, from[0] + r); x++) {
    for (let y = Math.max(0, from[1] - r); y <= Math.min(size - 1, from[1] + r); y++) {
      for (let z = Math.max(0, from[2] - r); z <= Math.min(size - 1, from[2] + r); z++) {
        const c = [x, y, z];
        if (same(c, from)) continue;
        const d = dist2(c, from);
        if (d < bd) { // Strict: first hit in x, y, z order wins ties.
          best = c;
          bd = d;
        }
      }
    }
  }
  return best.slice();
}

/* PHP: sectors_in_range(). Count of in-bounds sectors, excluding from, within rangeLy of from. */
function sectorsInRange(size, from, rangeLy) {
  return candidates(intval(size), xyz(from), Number(rangeLy)).length;
}

module.exports = {
  MIN_GRID, TYPES, STAR_CLASSES, PLANET_TYPES, HABITABILITY, RESOURCES, HAZARDS, SECTOR_FIELDS,
  NEBULA_SHARE, STATION_ODDS, ANOMALY_ODDS, SYSTEM_ODDS, NOTABLE_ODDS,
  clampSize, generate, designation, regionId, summarise, sectorAt, inBounds, parseCoord, coordKey,
  distanceUnits, distanceLy, reachable, partialDestination, nearestSector, sectorsInRange
};
