"use strict";
/* Ported from the plugin's tests/test-grid.php, plus pinned fingerprints taken from the PHP generator. */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const G = require("../grid.js");

const md5 = s => crypto.createHash("md5").update(s).digest("hex");

/* JSON exactly as PHP's json_encode writes it: empty objects as [], "/" escaped, non-ASCII as \uXXXX. The
   fingerprints below were made by PHP 8.3 from the plugin's generator, with its five resource keys and its habitable
   planet type renamed to this port's (aetherite, hydrex, corundite, aurelium_ore, veilstone; temperate) before
   json_encode, so a match means the same galaxy, draw for draw. */
function phpJson(v) {
  const s = JSON.stringify(v, (k, x) => {
    if (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 0) return [];
    return x;
  });
  return s.replace(/\//g, "\\/").replace(/[\u0080-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

test("determinism from a stored seed (§5.3)", () => {
  const a = G.generate(12, "alpha");
  const b = G.generate(12, "alpha");
  const c = G.generate(12, "beta");
  assert.ok(JSON.stringify(a) === JSON.stringify(b), "grid: same seed is identical");
  assert.ok(JSON.stringify(a.sectors) !== JSON.stringify(c.sectors), "grid: different seed differs");
  assert.ok(JSON.stringify(G.generate(8, "alpha").sectors) !== JSON.stringify(G.generate(8, "alpha2").sectors), "grid: similar seeds differ");
  assert.equal(a.size, 12, "grid: size stored");
  assert.equal(a.seed, "alpha", "grid: seed stored");
  assert.equal(a.ly_per_unit, 5, "grid: 5 ly per unit");
  // The plugin's pinned fingerprint (made from PHP as described above): fails if the PRNG or generation order drifts.
  assert.equal(md5(phpJson(G.generate(8, "fingerprint"))), "f626ac60790c51d9922f53451736404b", 'grid: pinned fingerprint for size 8 seed "fingerprint"');
});

test("bit-for-bit the same galaxies and summaries as the PHP generator", () => {
  // [size, seed, md5 of json_encode(generate()), md5 of json_encode(summarise()), non-empty sectors], from PHP 8.3 (see phpJson).
  const cases = [
    [8, "fingerprint", "f626ac60790c51d9922f53451736404b", "b1ed58ac6133aae090e649cd517fb3a1", 158],
    [12, "alpha", "8b6cea889e1be87856bd7abab164d8ae", "e09b1c59e94553c72f455c0fb4b0d9a2", 535],
    [12, "beta", "c0b3828366f106e9a8df9e1706e734c1", "7c2a1a27fc018edcacf1ad7f193d9aef", 571],
    [2, "tiny", "244a607ca488a0b52d59c26bfb434445", "ec4e64e8028ae1916735ce14bf1bcaa6", 3],
    [0, "tiny", "244a607ca488a0b52d59c26bfb434445", "ec4e64e8028ae1916735ce14bf1bcaa6", 3],
    [3, "x", "1499541d79712bdff635918f8b1676a6", "8b73fdb3c0c8f57ffc4cc2bed443c047", 7],
    [5, "a/b", "7fdc342022440212de01c585de98acc6", "17f5bebfa76dcebdad9727500e53a174", 37],
    [16, "r", "54463e3d37050b7bd506d57f3486df24", "39d72d6f20f7524a8f8839c71d6832e8", 1315],
    [20, "clamp", "ccdc2a4b0668f2b4585406fb583bdc49", "cb8b0302756d4e13d6d9ef305b6bf5e1", 2551],
    [50, "clamp", "ccdc2a4b0668f2b4585406fb583bdc49", "cb8b0302756d4e13d6d9ef305b6bf5e1", 2551],
    [20, "d1", "07847b3490d2b80d6e1bae9915c40060", "85c251c8556fc4851c09f5c555c377a3", 2528],
    [13, "Ünïcode seed ☄", "55e5ae090f40633a1bf7d5facc197cf5", "3780afef4f2ead5011ed02b306e16075", 642],
    [7, "", "7e2867869351ab6375d1bb79b4063ec3", "bce1096f94251bd9050460217beb68bc", 115],
    [11, "12345", "1c80f96cba509eb6e42e091d6714bc8b", "c80d9b580b1be1720ee39aa6e08ffa42", 432],
    [20, "long seed with spaces and | pipes", "e2ac02b0408753d36b807ffa4d156708", "8fb5908599e59a3bf29b9b815ddf858a", 2509],
    [4, "q", "72f17cc16137c77392d4d337780ab899", "2b359d5201c357484ad525e6b838c8b0", 23],
    [9, "z9", "7b53794a3068406cc7970433a33ae38f", "5856b992f308b63af340ba09ed125ea4", 219],
    [15, "fifteen", "8e80b9f82718024db134d264d8b67d31", "0e7a1a97058ab5db1944ada1573cc1f9", 1056],
    [17, "seventeen", "e429e4e539923bada5559b90d96f9466", "f10dda6110e21744b1ecef8a825195c6", 1560],
    [19, "nineteen", "391398fe16d1d92e0e38b4f53f0793be", "c225df06f492b28ed21698970010ecd8", 2216]
  ];
  for (const [size, seed, gridMd5, sumMd5, count] of cases) {
    const g = G.generate(size, seed);
    assert.equal(Object.keys(g.sectors).length, count, `sector count, size ${size} seed "${seed}"`);
    assert.equal(md5(phpJson(g)), gridMd5, `galaxy, size ${size} seed "${seed}"`);
    assert.equal(md5(phpJson(G.summarise(g))), sumMd5, `summary, size ${size} seed "${seed}"`);
  }
  assert.equal(md5(phpJson(G.generate(11, 12345))), "1c80f96cba509eb6e42e091d6714bc8b", "a number seed reads as its digits, as in PHP");
});

const big = G.generate(50, "clamp");

test("hard upper limit (§5.3) and lower clamp", () => {
  const t0 = process.hrtime.bigint();
  G.generate(50, "clamp");
  const dt = Number(process.hrtime.bigint() - t0) / 1e9;
  assert.equal(big.size, 20, "grid: 50 clamps to 20");
  assert.ok(dt < 2.0, `grid: size 20 generates in under 2 seconds (${dt.toFixed(3)}s)`);
  assert.equal(G.generate(0, "tiny").size, 2, "grid: 0 clamps to 2");
  assert.equal(G.generate(-5, "tiny").size, 2, "grid: negative clamps to 2");
  let oob = 0;
  for (const [key, s] of Object.entries(big.sectors)) {
    if (!G.inBounds(20, [s.x, s.y, s.z]) || key !== `${s.x},${s.y},${s.z}`) oob++;
  }
  assert.equal(oob, 0, "grid: all coords in bounds and keyed x,y,z");
});

test("density 25-40% non-empty, across sizes and several seeds", () => {
  for (const size of [8, 12, 20]) {
    for (const seed of ["d1", "d2", "d3", "d4"]) {
      const ratio = Object.keys(G.generate(size, seed).sectors).length / size ** 3;
      assert.ok(ratio >= 0.25 && ratio <= 0.40, `grid: density size ${size} seed ${seed} (${ratio.toFixed(3)})`);
    }
  }
});

test("field list and enum values (§5.3 minimum fields)", () => {
  const bad = [];
  const types = {};
  const stars = {};
  let notes = 0;
  for (const [key, s] of Object.entries(big.sectors)) {
    let e = null;
    if (JSON.stringify(Object.keys(s)) !== JSON.stringify(G.SECTOR_FIELDS)) e = "fields";
    else if (!G.TYPES.includes(s.type)) e = "type";
    else if (s.type === "star_system" ? !G.STAR_CLASSES.includes(s.star_class) : s.star_class !== null) e = "star_class";
    else if (!Array.isArray(s.planets) || s.planets.length > 8 || (s.type !== "star_system" && s.planets.length)) e = "planets";
    else if (!G.HABITABILITY.includes(s.habitability)) e = "habitability";
    else if (!Array.isArray(s.resources) || s.resources.some(r => !G.RESOURCES.includes(r)) || new Set(s.resources).size !== s.resources.length) e = "resources";
    else if (s.hazard !== null && !G.HAZARDS.includes(s.hazard)) e = "hazard";
    else if (s.faction !== null) e = "faction";
    else if (s.notable !== null && (typeof s.notable !== "string" || s.notable === "")) e = "notable";
    else if (!/^Sector \d\d-\d\d-\d\d$/.test(s.name)) e = "name";
    let hasHabitable = false;
    for (const p of s.planets) {
      if (JSON.stringify(Object.keys(p)) !== '["type","habitable"]' || !G.PLANET_TYPES.includes(p.type) || typeof p.habitable !== "boolean") e = "planet";
      hasHabitable = hasHabitable || p.habitable;
    }
    if (hasHabitable !== (s.habitability === "habitable")) e = "habitability mismatch";
    if (e) bad.push(`${key}: ${e}`);
    types[s.type] = (types[s.type] ?? 0) + 1;
    if (s.star_class) stars[s.star_class] = (stars[s.star_class] ?? 0) + 1;
    notes += s.notable !== null ? 1 : 0;
  }
  assert.deepEqual(bad.slice(0, 5), [], "grid: every sector has valid fields and enums");
  assert.equal(Object.keys(types).length, 4, "grid: all four non-empty types occur at size 20");
  assert.ok(types.station / 8000 > 0.004 && types.station / 8000 < 0.02, "grid: stations rare (~1%)");
  assert.ok(types.anomaly / 8000 > 0.01 && types.anomaly / 8000 < 0.035, "grid: anomalies rare (~2%)");
  assert.ok(types.nebula / 8000 > 0.04 && types.nebula / 8000 < 0.10, "grid: nebula share");
  assert.ok(stars.M > stars.K && stars.K > stars.G && stars.G > (stars.O ?? 0), "grid: M then K most common");
  const nr = notes / Object.keys(big.sectors).length;
  assert.ok(nr > 0.04 && nr < 0.09, `grid: notable features on roughly 5-8% (${nr.toFixed(3)})`);

  // Nebulae cluster: most nebula sectors touch another nebula sector.
  let touching = 0;
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const s of Object.values(big.sectors)) {
    if (s.type !== "nebula") continue;
    for (const d of dirs) {
      const n = G.sectorAt(big, s.x + d[0], s.y + d[1], s.z + d[2]);
      if (n && n.type === "nebula") {
        touching++;
        break;
      }
    }
  }
  assert.ok(touching / types.nebula > 0.95, "grid: nebulae are spatially coherent");
});

test("regions: octants below 16, 3x3x3 from 16; counts add up", () => {
  const a = G.generate(12, "alpha");
  assert.equal(a.regions.length, 8, "grid: 8 regions at size 12");
  assert.equal(big.regions.length, 27, "grid: 27 regions at size 20");
  assert.equal(G.generate(16, "r").regions.length, 27, "grid: 27 regions at size 16");
  assert.equal(a.regions[0].label, "Lower South-West", "grid: first octant label");
  assert.deepEqual(a.regions[0].bounds, [[0, 0, 0], [5, 5, 5]], "grid: first octant bounds");
  assert.equal(new Set(a.regions.map(r => r.label)).size, 8, "grid: octant labels unique");
  assert.equal(new Set(big.regions.map(r => r.label)).size, 27, "grid: 27 labels unique");
  let total = 0;
  let nonempty = 0;
  let haz = 0;
  for (const r of big.regions) {
    const sum = Object.values(r.counts).reduce((x, y) => x + y, 0);
    total += sum;
    nonempty += sum - r.counts.empty;
    haz += r.hazards;
  }
  assert.equal(total, 8000, "grid: region counts cover every sector");
  assert.equal(nonempty, Object.keys(big.sectors).length, "grid: region non-empty counts match");
  assert.equal(haz, Object.values(big.sectors).filter(s => s.hazard).length, "grid: region hazard counts match");
  assert.equal(G.regionId(20, [19, 0, 6]), "r-2-0-1", "grid: region_id");
});

test("summary for the story LLM (§5.3)", () => {
  const sum = G.summarise(big);
  assert.ok(JSON.stringify(sum).length < 12000, `grid: size-20 summary under 12 KB (${JSON.stringify(sum).length} bytes)`);
  assert.ok(sum.notable.length <= 40 && sum.notable.length > 0, "grid: at most 40 notable");
  assert.equal(sum.size, 20, "summary: size");
  assert.equal(sum.width_ly, 100, "summary: Deep Void is 100 ly across");
  assert.equal(sum.total_sectors, 8000, "summary: total sectors");
  assert.equal(sum.non_empty, Object.keys(big.sectors).length, "summary: non-empty count");
  assert.equal(sum.regions.length, 27, "summary: regions");
  assert.deepEqual(Object.keys(sum.notable[0]), ["coord", "type", "star_class", "planets", "habitability", "hazard", "notable", "name"], "summary: notable entry shape");
  assert.ok(Number.isInteger(sum.notable[0].planets), "summary: planets is a count");
  assert.deepEqual(G.summarise(big), sum, "summary: deterministic");
  assert.equal(G.summarise(big, 5).notable.length, 5, "summary: max_notable respected");
  assert.equal(G.summarise(big, 0).notable.length, 0, "summary: zero notable allowed");
  const seen = new Set();
  let ok = true;
  for (const n of sum.notable) {
    const s = big.sectors[n.coord];
    ok = ok && !!s && (["station", "anomaly"].includes(s.type) || s.habitability === "habitable" || s.notable !== null);
    seen.add(G.regionId(20, G.parseCoord(n.coord)));
  }
  assert.ok(ok, "summary: notable entries are real, noteworthy sectors");
  assert.equal(new Set(sum.notable.map(n => n.coord)).size, 40, "summary: notable entries distinct");
  assert.ok(seen.size >= 20, "summary: notable spread across regions");
  assert.ok(JSON.stringify(G.summarise(G.generate(12, "alpha"))).length < 12000, "summary: size-12 summary compact");
});

test("sectorAt", () => {
  const a = G.generate(12, "alpha");
  const first = Object.values(a.sectors)[0];
  assert.deepEqual(G.sectorAt(a, first.x, first.y, first.z), first, "sector_at: stored sector");
  let empty = null;
  for (let i = 0; i < 12 && !empty; i++) {
    if (!a.sectors[`${i},0,0`]) empty = G.sectorAt(a, i, 0, 0);
  }
  assert.equal(empty.type, "empty", "sector_at: implicit empty sector");
  assert.deepEqual(Object.keys(empty), [...G.SECTOR_FIELDS], "sector_at: empty sector has the full field list");
  assert.deepEqual([empty.star_class, empty.planets, empty.habitability, empty.resources, empty.hazard, empty.faction, empty.notable], [null, [], "none", [], null, null, null], "sector_at: empty fields blank");
  assert.equal(G.designation(7, 4, 9), "Sector 07-04-09", "designation format");
  assert.equal(G.sectorAt(a, 12, 0, 0), null, "sector_at: out of bounds high");
  assert.equal(G.sectorAt(a, 0, -1, 0), null, "sector_at: out of bounds negative");
});

test("coordinates", () => {
  assert.ok(G.inBounds(8, [0, 7, 3]), "in_bounds: inside");
  assert.ok(!G.inBounds(8, [0, 8, 3]), "in_bounds: edge is outside");
  assert.ok(!G.inBounds(8, [-1, 0, 0]), "in_bounds: negative");
  assert.deepEqual(G.parseCoord("3,4,5"), [3, 4, 5], "parse_coord");
  assert.deepEqual(G.parseCoord(" 3, 4 ,15 "), [3, 4, 15], "parse_coord tolerates spaces");
  assert.equal(G.parseCoord("3,4"), null, "parse_coord: too few");
  assert.equal(G.parseCoord("3,-4,5"), null, "parse_coord: negative");
  assert.equal(G.parseCoord("a,b,c"), null, "parse_coord: junk");
  assert.equal(G.parseCoord("1,2,3,4"), null, "parse_coord: too many");
  assert.equal(G.coordKey([3, 4, 5]), "3,4,5", "coord_key");
  assert.equal(G.coordKey({ x: 3, y: 4, z: 5, type: "nebula" }), "3,4,5", "coord_key accepts a sector");
});

test("distance (§5.1 Euclidean, §7.4 5 ly per unit)", () => {
  assert.equal(G.distanceUnits([0, 0, 0], [2, 0, 0]), 2.0, "distance: 2 units");
  assert.equal(G.distanceLy([0, 0, 0], [2, 0, 0]), 10.0, "distance: 2 units = 10 ly");
  assert.equal(G.distanceLy([1, 1, 1], [4, 5, 1]), 25.0, "distance: 3-4-5 triangle = 25 ly");
  assert.ok(Math.abs(G.distanceLy([0, 0, 0], [1, 1, 1]) - 5 * Math.sqrt(3)) < 1e-12, "distance: space diagonal");
  assert.equal(G.distanceLy([3, 3, 3], [3, 3, 3]), 0.0, "distance: zero");
  assert.ok(G.reachable([0, 0, 0], [2, 0, 0], 10), "reachable: exactly at range");
  assert.ok(!G.reachable([0, 0, 0], [2, 0, 0], 9.9), "reachable: just short");
  assert.ok(!G.reachable([0, 0, 0], [1, 1, 1], 8), "reachable: diagonal 8.66 ly > 8");
  assert.ok(G.reachable([0, 0, 0], [1, 1, 1], 9), "reachable: diagonal 8.66 ly <= 9");
});

test("partial journeys (§7.4)", () => {
  assert.deepEqual(G.partialDestination(12, [0, 0, 0], [4, 0, 0], 10), [2, 0, 0], "partial: brief example, half way");
  assert.deepEqual(G.partialDestination(12, [5, 5, 5], [5, 5, 1], 10), [5, 5, 3], "partial: half way along -z");
  assert.deepEqual(G.partialDestination(12, [0, 0, 0], [4, 0, 0], 20), [4, 0, 0], "partial: destination in range is returned");
  assert.deepEqual(G.partialDestination(12, [0, 0, 0], [4, 0, 0], 4.9), [0, 0, 0], "partial: range under one unit stays put");
  assert.deepEqual(G.partialDestination(12, [3, 3, 3], [3, 3, 3], 25), [3, 3, 3], "partial: from == to stays put");
  assert.deepEqual(G.partialDestination(12, [0, 0, 0], [6, 6, 6], 10), [1, 1, 1], "partial: diagonal, 2 units of range reaches 1,1,1");
  // Tie on distance to destination, resolved by perpendicular distance then lowest x.
  assert.deepEqual(G.partialDestination(12, [0, 0, 0], [3, 3, 0], 5), [0, 1, 0], "partial: full tie broken by lowest x");
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let ok = true;
  let n = 0;
  for (const range of [5, 10, 12.5, 17, 25, 35]) {
    for (const from of [[0, 0, 0], [7, 3, 1], [4, 4, 4], [7, 7, 7]]) {
      for (const to of [[7, 7, 7], [0, 5, 2], [6, 0, 3], [1, 6, 7]]) {
        const p = G.partialDestination(8, from, to, range);
        ok = ok && G.inBounds(8, p)
          && G.distanceLy(from, p) <= range + 1e-9
          && G.distanceLy(p, to) <= G.distanceLy(from, to)
          && same(p, from) === same(from, to)
          && (!G.reachable(from, to, range) || same(p, to))
          && same(p, G.partialDestination(8, from, to, range));
        n++;
      }
    }
  }
  assert.ok(ok, `partial: ${n} cases within range, progressing, deterministic`);
  let pos = [0, 0, 0];
  let turns = 0;
  while (!same(pos, [19, 19, 19]) && turns < 50) {
    pos = G.partialDestination(20, pos, [19, 19, 19], 10);
    turns++;
  }
  assert.ok(same(pos, [19, 19, 19]) && turns <= 19, `partial: repeated hops arrive (${turns} turns)`);
});

test("retreat target (§7.2.3) and reachable-radius counts (§5.2)", () => {
  assert.deepEqual(G.nearestSector(8, [3, 3, 3]), [2, 3, 3], "nearest: interior picks lowest x");
  assert.deepEqual(G.nearestSector(8, [0, 0, 0]), [0, 0, 1], "nearest: origin corner => x=0, y=0 neighbour");
  assert.deepEqual(G.nearestSector(8, [0, 3, 3]), [0, 2, 3], "nearest: on x=0 face picks lowest y among x=0");
  assert.deepEqual(G.nearestSector(8, [0, 0, 3]), [0, 0, 2], "nearest: on x=0,y=0 edge picks lowest z");
  assert.deepEqual(G.nearestSector(8, [7, 7, 7]), [6, 7, 7], "nearest: far corner");
  assert.deepEqual(G.nearestSector(2, [0, 0, 0]), [0, 0, 1], "nearest: smallest grid");
  assert.equal(G.distanceUnits([3, 3, 3], G.nearestSector(8, [3, 3, 3])), 1.0, "nearest: one unit away");
  assert.equal(G.sectorsInRange(8, [3, 3, 3], 4), 0, "in range: under one unit");
  assert.equal(G.sectorsInRange(8, [3, 3, 3], 5), 6, "in range: 5 ly = six face neighbours");
  assert.equal(G.sectorsInRange(8, [3, 3, 3], 10), 32, "in range: 10 ly sphere");
  assert.equal(G.sectorsInRange(8, [0, 0, 0], 5), 3, "in range: corner is clipped by the grid edge");
  assert.equal(G.sectorsInRange(8, [0, 0, 0], 1000), 511, "in range: everything but the start");
});
