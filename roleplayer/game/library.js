"use strict";
/* Ship and crew library: validation, CSV import/export and saved builds (§4.1–§4.5), ported from the plugin's
   class-library.php.

   The validation and CSV functions are pure and need only rules.js. Saved builds, which the plugin kept as WordPress
   posts, are kept in <dataDir>/builds.json; the data folder is always passed in by the caller. Permission checks
   (who may save or delete, §4.5) belong to the caller, not to this module.
   Spreadsheet workbooks (.xlsx, the plugin's class-xlsx.php) are not supported: uploads are read as CSV only.

   Error shape everywhere: { row: int|null, column: string|null, message: string, role: role key|null }.
   Crew errors carry the role so a creator screen can place the message without a row number.
   CSV row numbers match a spreadsheet: the header is row 1 and the first data row is row 2.
   Function names are camelCase; the PHP name is noted where it differs. */
const fs = require("fs");
const path = require("path");
const Rules = require("./rules.js");

const { intval, phpTrim, phpStrval } = Rules;

const HUMAN_BONUS_POINTS = 3; // §4.3
const BUILDS_FILE = "builds.json";

const own = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const isScalar = v => typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint";
const isArr = v => v !== null && typeof v === "object"; // PHP's is_array: a list or a keyed object
const get = (o, k) => (own(o, k) ? o[k] : undefined);

/* ---------- Column lists ---------- */

/* PHP: ship_required_columns(). Ship CSV columns that must be present (§4.4.1). */
function shipRequiredColumns() {
  return ["ship_name", ...Object.keys(Rules.shipAttributes())];
}

/* PHP: ship_columns(). Ship CSV columns: the required seven plus the optional flavour fields (§4.1). */
function shipColumns() {
  return [...shipRequiredColumns(), "ship_class", "registry", "captain_name"];
}

/* PHP: crew_required_columns(). The crew CSV columns of §4.4.2, in order. */
function crewRequiredColumns() {
  return ["role", "name", "race", "gender", ...Object.keys(Rules.attributes()), "personality"];
}

/* PHP: human_bonus_columns() */
function humanBonusColumns() {
  const cols = [];
  for (let i = 1; i <= HUMAN_BONUS_POINTS; i++) cols.push("human_bonus_" + i);
  return cols;
}

/* PHP: crew_columns(). Every crew CSV column the importer understands: the required ones, then the optional ones
   (§4.3, §10). */
function crewColumns() {
  return [...crewRequiredColumns(), ...humanBonusColumns(), "voice"];
}

/* ---------- Small helpers ---------- */

function err(row, column, message, role = null) {
  return { row: row ?? null, column: column ?? null, message, role: role ?? null };
}

function str(v) {
  return isScalar(v) ? phpTrim(phpStrval(v)) : "";
}

function blank(v) {
  return v === null || v === undefined || (typeof v === "string" && phpTrim(v) === "");
}

/* PHP: to_int(). Whole numbers only: 7, "7", " 7 " and 7.0 pass; "7.5", "seven" and "" do not.
   (JavaScript cannot tell 7 from 7.0, so a whole number of any size up to the safe range passes as an integer.) */
function toInt(v) {
  if (typeof v === "number") {
    if (Number.isSafeInteger(v)) return v;
    return Number.isFinite(v) && Math.floor(v) === v && Math.abs(v) < 1000000 ? Math.trunc(v) : null;
  }
  if (typeof v === "string" && /^[+-]?\d{1,6}$/.test(phpTrim(v))) return intval(phpTrim(v));
  return null;
}

/* PHP: off_by() */
function offBy(total, pool) {
  return total > pool ? total - pool + " too many" : pool - total + " too few";
}

/* PHP's strtolower: ASCII letters only. */
function asciiLower(s) {
  return String(s).replace(/[A-Z]/g, c => c.toLowerCase());
}

/* PHP's \s without /u: space, tab, newline, vertical tab, form feed, carriage return. */
const WS = " \t\n\v\f\r";

function slug(s) {
  return asciiLower(phpTrim(String(s ?? ""))).replace(/[ \t\n\v\f\r_\-]+/g, "_");
}

/* PHP: match_role(). Role key from a key or a label ('First Officer', 'first_officer'), case-insensitive. */
function matchRole(given) {
  given = slug(given);
  for (const [role, def] of Object.entries(Rules.roles())) {
    if (given === role || given === slug(def.label)) return role;
  }
  return null;
}

/* PHP: match_species(). Compared as PHP's strcasecmp does: ASCII letters fold, anything else must match exactly. */
function matchSpecies(given) {
  const g = asciiLower(phpTrim(String(given ?? "")));
  for (const s of Object.keys(Rules.species())) {
    if (asciiLower(s) === g) return s;
  }
  return null;
}

/* PHP: match_gender() */
function matchGender(given) {
  const g = asciiLower(phpTrim(String(given ?? "")));
  for (const x of Rules.genders()) {
    if (asciiLower(x) === g) return x;
  }
  return null;
}

/* PHP: match_attribute(). Attribute key from a key or a label ('Threat Assessment'), case-insensitive. */
function matchAttribute(given) {
  given = slug(given);
  return own(Rules.attributes(), given) ? given : null;
}

/* PHP: attr_labels() */
function attrLabels(keys) {
  const all = Rules.attributes();
  return keys.map(k => all[k]).join(", ");
}

/* PHP: role_labels() */
function roleLabels() {
  return Object.values(Rules.roles()).map(d => d.label).join(", ");
}

/* PHP: role_title() */
function roleTitle(role) {
  return Rules.roles()[role].title;
}

/* PHP: unknown_role_message() */
function unknownRoleMessage(given) {
  given = phpTrim(String(given ?? ""));
  return (given === "" ? "The role is blank." : `"${given}" is not a role.`) + " Use one of: " + roleLabels() + ".";
}

/* Code-point-safe substring, as PHP's mb_substr. */
function mbSubstr(s, start, length) {
  return Array.from(s).slice(start, start + length).join("");
}

/* Keys of a PHP-style array: list indices are integers, as are all-digit keys of a keyed object. */
function entries(v) {
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  return Object.entries(v).map(([k, x]) => [/^(0|[1-9]\d*)$/.test(k) && Number(k) <= Number.MAX_SAFE_INTEGER ? Number(k) : k, x]);
}

/* ---------- Validation ---------- */

/* PHP: validate_ship(). Validate a ship (§4.1). Returns { ok, errors, ship, total }. */
function validateShip(ship) {
  return checkShip(isArr(ship) ? ship : {}, null);
}

/* PHP: validate_crew(). Validate a crew keyed by role (§4.2, §4.3). A plain list of officers that each carry 'role'
   is also accepted. Returns { ok, errors, crew, total, per_officer }. */
function validateCrew(crew) {
  const errors = [];
  const officers = {};
  for (const [key, officer] of entries(isArr(crew) ? crew : {})) {
    if (!isArr(officer)) {
      errors.push(err(null, "role", "One of the officers is not a valid record."));
      continue;
    }
    let role = typeof key === "string" ? matchRole(key) : null;
    if (role === null && typeof key !== "string") role = matchRole(str(get(officer, "role") ?? ""));
    if (role === null) {
      const given = typeof key === "string" ? key : str(get(officer, "role") ?? "");
      errors.push(err(null, "role", unknownRoleMessage(given)));
      continue;
    }
    if (own(officers, role)) {
      errors.push(err(null, "role", roleTitle(role) + " appears more than once. A crew has exactly one of each officer.", role));
      continue;
    }
    officers[role] = officer;
  }
  const res = checkCrew(officers, {}, "species");
  res.errors = [...errors, ...res.errors];
  res.ok = !res.errors.length;
  return res;
}

/* PHP: check_ship() */
function checkShip(ship, row) {
  const errors = [];
  const out = {
    name: str(get(ship, "name") ?? ""),
    class: str(get(ship, "class") ?? ""),
    registry: str(get(ship, "registry") ?? ""),
    captain: mbSubstr(str(get(ship, "captain") ?? ""), 0, 60), // optional: the player is not asked for a name if the ship has its captain's
    attrs: {}
  };
  if (out.name === "") errors.push(err(row, "ship_name", "The ship needs a name."));
  const given = isArr(get(ship, "attrs")) ? ship.attrs : {};
  let total = 0;
  const min = Rules.SHIP_ATTR_MIN;
  const max = Rules.SHIP_ATTR_MAX;
  for (const [key, label] of Object.entries(Rules.shipAttributes())) {
    const raw = get(given, key) ?? null;
    const val = toInt(raw);
    if (val === null) {
      out.attrs[key] = 0;
      errors.push(err(row, key, blank(raw)
        ? `${label} is blank. Enter a whole number from ${min} to ${max}.`
        : `${label} must be a whole number from ${min} to ${max}, not "` + str(raw) + '".'));
      continue;
    }
    out.attrs[key] = val;
    total += val;
    if (val < min) errors.push(err(row, key, `${label} is ${val}. Every ship attribute needs at least ${min} points.`));
    else if (val > max) errors.push(err(row, key, `${label} is ${val}. No ship attribute may have more than ${max} points.`));
  }
  const pool = Rules.SHIP_POOL;
  if (total !== pool) {
    errors.push(err(row, null, `The ship spends ${total} points in total. It must spend exactly ${pool} (` + offBy(total, pool) + ")."));
  }
  return { ok: !errors.length, errors, ship: out, total };
}

/* PHP: check_crew(). Shared crew checks for the creator route and the CSV route.
   officers: role key => raw officer. 'attrs' may hold columns the officer lacks (they are reported). 'human_bonus'
   is a positional list; blanks keep their position so errors name the column.
   rows: role key => CSV row number, where known. speciesCol: column name used in species errors ('race' in the
   CSV, §4.4.2). */
function checkCrew(officers, rows, speciesCol) {
  const roleDefs = Rules.roles();
  const all = Rules.attributes();
  const cap = Rules.CREW_ATTR_CAP;
  const errors = [];
  const out = {};
  const per = {};
  const voices = {};
  const missing = [];

  for (const [role, def] of Object.entries(roleDefs)) {
    per[role] = 0;
    if (!own(officers, role)) {
      missing.push(role);
      continue;
    }
    const o = officers[role];
    const row = own(rows, role) ? rows[role] : null;
    const who = def.title;
    const clean = {
      role,
      name: str(get(o, "name") ?? ""),
      species: "",
      gender: "",
      attrs: {},
      human_bonus: [],
      personality: str(get(o, "personality") ?? ""),
      voice: str(get(o, "voice") ?? "")
    };

    if (clean.name === "") errors.push(err(row, "name", `${who}: a name is required.`, role));

    // Species: the closed list of ten (§4.3).
    const rawSpecies = str(get(o, "species") ?? "");
    const sp = matchSpecies(rawSpecies);
    if (sp === null) {
      const list = Object.keys(Rules.species()).join(", ");
      errors.push(err(row, speciesCol, rawSpecies === ""
        ? `${who}: a species is required. Choose one of: ${list}.`
        : `${who}: "${rawSpecies}" is not one of the ten allowed species. Choose one of: ${list}.`, role));
    } else {
      clean.species = sp;
    }

    // Gender: Male or Female only (§10).
    const rawGender = str(get(o, "gender") ?? "");
    const gender = matchGender(rawGender);
    if (gender === null) {
      errors.push(err(row, "gender", rawGender === ""
        ? `${who}: gender is required. Enter Male or Female.`
        : `${who}: gender must be Male or Female, not "${rawGender}".`, role));
    } else {
      clean.gender = gender;
    }

    // Attributes: only this officer's own four, whole numbers, 0 to the cap (§4.2).
    const given = isArr(get(o, "attrs")) ? o.attrs : {};
    for (const a of def.attrs) {
      const raw = get(given, a) ?? null;
      if (blank(raw)) {
        clean.attrs[a] = 0; // A blank own cell is read as 0; the pool total still has to balance.
        continue;
      }
      const val = toInt(raw);
      if (val === null || val < 0) {
        clean.attrs[a] = 0;
        errors.push(err(row, a, `${who}: ${all[a]} must be a whole number from 0 to ${cap}, not "` + str(raw) + '".', role));
        continue;
      }
      clean.attrs[a] = val;
      per[role] += val;
      if (val > cap) errors.push(err(row, a, `${who}: ${all[a]} is ${val}. No single attribute may have more than ${cap} allocated points.`, role));
    }
    for (const [key, raw] of entries(given)) {
      if (def.attrs.includes(key) || blank(raw)) continue;
      const a = String(key);
      const label = own(all, a) ? all[a] : a;
      const ownLabels = attrLabels(def.attrs);
      errors.push(err(row, a, `${who}: has a value in ${label}, which this officer does not have. Leave it blank. The ${who}'s attributes are ${ownLabels}.`, role));
    }

    // Human free bonus (§4.3): exactly three points, each on one of the officer's own attributes.
    const hbRaw = get(o, "human_bonus");
    const hb = isArr(hbRaw) ? Object.values(hbRaw) : [];
    if (clean.species === "Human") {
      const slots = Math.max(HUMAN_BONUS_POINTS, hb.length);
      for (let i = 0; i < slots; i++) {
        const col = "human_bonus_" + (i + 1);
        const raw = hb[i] ?? null;
        if (i >= HUMAN_BONUS_POINTS) {
          if (!blank(raw)) {
            errors.push(err(row, "human_bonus_" + HUMAN_BONUS_POINTS, `${who}: a Human officer places exactly ` + HUMAN_BONUS_POINTS + " bonus points, no more.", role));
            break;
          }
          continue;
        }
        const ownLabels = attrLabels(def.attrs);
        if (blank(raw)) {
          errors.push(err(row, col, `${who}: ${col} is blank. A Human officer must place all ` + HUMAN_BONUS_POINTS + ` bonus points. Name one of: ${ownLabels}.`, role));
          continue;
        }
        const a = matchAttribute(str(raw));
        if (a === null || !def.attrs.includes(a)) {
          errors.push(err(row, col, `${who}: ${col} is "` + str(raw) + `", which is not one of this officer's own attributes. Name one of: ${ownLabels}.`, role));
          continue;
        }
        clean.human_bonus.push(a);
      }
    } else if (clean.species !== "") {
      hb.forEach((raw, i) => {
        if (!blank(raw)) {
          const col = "human_bonus_" + Math.min(i + 1, HUMAN_BONUS_POINTS);
          errors.push(err(row, col, `${who}: only Human officers place bonus points. Leave ${col} blank for a ${clean.species}.`, role));
        }
      });
    }

    if (clean.personality === "") errors.push(err(row, "personality", `${who}: a personality summary is required.`, role));

    // No two officers on one ship share a voice (§10). A blank voice is assigned later.
    if (clean.voice !== "") {
      if (own(voices, clean.voice)) {
        const other = roleDefs[voices[clean.voice]].title;
        errors.push(err(row, "voice", `${who}: has the same voice as the ${other}. Each officer needs a different voice.`, role));
      } else {
        voices[clean.voice] = role;
      }
    }

    out[role] = clean;
  }

  for (const role of missing) {
    errors.push(err(null, "role", "The " + roleDefs[role].title + " is missing. A crew needs exactly six officers: " + roleLabels() + ".", role));
  }

  const total = Object.values(per).reduce((s, v) => s + v, 0);
  const pool = Rules.CREW_POOL;
  if (total !== pool) {
    errors.push(err(null, null, `The crew spends ${total} points in total across all six officers. It must spend exactly ${pool} (` + offBy(total, pool) + ")."));
  }

  return { ok: !errors.length, errors, crew: out, total, per_officer: per };
}

/* ---------- Uploads and CSV import ---------- */

/* PHP: read_upload(). The text of an uploaded ship or crew file. Takes a Buffer or a string; returns
   { ok, csv, error }. The plugin also converted .xlsx workbooks here; this port reads CSV only, so a workbook (a zip
   file) is refused with a message saying so. */
function readUpload(bytes) {
  const isBuf = Buffer.isBuffer(bytes) || bytes instanceof Uint8Array;
  const head = isBuf ? Buffer.from(bytes.subarray(0, 4)).toString("latin1") : String(bytes).slice(0, 4);
  if (head === "PK\x03\x04") {
    return { ok: false, csv: "", error: "That file is a spreadsheet workbook, which this game cannot read. Save it as .csv and load it again." };
  }
  return { ok: true, csv: isBuf ? Buffer.from(bytes).toString("utf8") : String(bytes), error: "" };
}

/* PHP: parse_ship_csv(). Parse and validate a ship CSV (§4.4.1): a header and exactly one data row.
   Returns { ok, errors, ship, total }. */
function parseShipCsv(csv) {
  const records = readCsv(csv);
  if (!records.length) {
    const res = checkShip({}, null);
    res.errors = [err(null, null, "The file is empty. It needs a header row and one row for the ship.")];
    return res;
  }
  let [map, errors] = mapHeader(records[0].cells, shipColumns(), shipRequiredColumns());
  const data = records.slice(1);
  const headerOk = !errors.length;

  if (!data.length) {
    errors.push(err(null, null, "The file has a header but no ship row. Add one row for the ship."));
  } else if (data.length > 1) {
    errors.push(err(data[1].row, null, "The file has " + data.length + " data rows. A ship file must have exactly one. Only the first row was read."));
  }

  let ship = {};
  let row = null;
  if (data.length) {
    row = data[0].row;
    const cells = assocRow(data[0].cells, map);
    errors = [...errors, ...extraCellErrors(data[0], records[0].cells.length)];
    ship = {
      name: cells.ship_name ?? "",
      class: cells.ship_class ?? "",
      registry: cells.registry ?? "",
      captain: cells.captain_name ?? "",
      attrs: {}
    };
    for (const a of Object.keys(Rules.shipAttributes())) ship.attrs[a] = cells[a] ?? "";
  }
  const res = checkShip(ship, row);
  // With a broken header or no row, the cell-level messages would only be noise.
  res.errors = headerOk && data.length ? [...errors, ...res.errors] : errors;
  res.ok = !res.errors.length;
  return res;
}

/* PHP: parse_crew_csv(). Parse and validate a crew CSV (§4.4.2): a header and exactly six officer rows.
   'total' and 'per_officer' are always returned so a screen can show its points readout.
   Returns { ok, errors, crew, total, per_officer }. */
function parseCrewCsv(csv) {
  const records = readCsv(csv);
  if (!records.length) {
    const res = checkCrew({}, {}, "race");
    res.errors = [err(null, null, "The file is empty. It needs a header row and six officer rows.")];
    res.ok = false;
    return res;
  }
  let [map, errors] = mapHeader(records[0].cells, crewColumns(), crewRequiredColumns(), { species: "race" });
  const headerOk = !errors.length;
  const data = records.slice(1);
  const width = records[0].cells.length;
  const officers = {};
  const rows = {};

  if (Object.keys(Rules.roles()).length !== data.length) {
    errors.push(err(null, null, "The file has " + data.length + " officer row" + (data.length === 1 ? "" : "s") + ". It must have exactly six: " + roleLabels() + "."));
  }

  for (const rec of data) {
    const cells = assocRow(rec.cells, map);
    errors = [...errors, ...extraCellErrors(rec, width)];
    const given = cells.role ?? "";
    const role = matchRole(given);
    if (role === null) {
      errors.push(err(rec.row, "role", unknownRoleMessage(given)));
      continue;
    }
    if (own(officers, role)) {
      errors.push(err(rec.row, "role", roleTitle(role) + ` is already on row ${rows[role]}. A crew has exactly one of each officer.`, role));
      continue;
    }
    const officer = {
      name: cells.name ?? "",
      species: cells.race ?? "",
      gender: cells.gender ?? "",
      attrs: {},
      human_bonus: [],
      personality: cells.personality ?? "",
      voice: cells.voice ?? ""
    };
    for (const a of Object.keys(Rules.attributes())) officer.attrs[a] = cells[a] ?? "";
    for (const col of humanBonusColumns()) officer.human_bonus.push(cells[col] ?? "");
    officers[role] = officer;
    rows[role] = rec.row;
  }

  const res = checkCrew(officers, rows, "race");
  // With a broken header the cell-level messages would only be noise; the readout figures are still returned.
  res.errors = headerOk ? [...errors, ...res.errors] : errors;
  res.ok = !res.errors.length;
  return res;
}

/* ---------- CSV export and templates ---------- */

/* PHP: export_ship_csv() */
function exportShipCsv(ship) {
  ship = isArr(ship) ? ship : {};
  const attrs = isArr(ship.attrs) ? ship.attrs : {};
  const row = [str(get(ship, "name") ?? "")];
  for (const a of Object.keys(Rules.shipAttributes())) row.push(String(intval(get(attrs, a) ?? 0)));
  row.push(str(get(ship, "class") ?? ""), str(get(ship, "registry") ?? ""), str(get(ship, "captain") ?? ""));
  return writeCsv([shipColumns(), row]);
}

/* PHP: export_crew_csv() */
function exportCrewCsv(crew) {
  const lines = [crewColumns()];
  for (const [role, def] of Object.entries(Rules.roles())) {
    if (!own(crew, role) || !isArr(crew[role])) continue;
    const o = crew[role];
    const attrs = isArr(o.attrs) ? o.attrs : {};
    const row = [def.label, str(get(o, "name") ?? ""), str(get(o, "species") ?? ""), str(get(o, "gender") ?? "")];
    for (const a of Object.keys(Rules.attributes())) {
      row.push(def.attrs.includes(a) ? String(intval(get(attrs, a) ?? 0)) : "");
    }
    row.push(str(get(o, "personality") ?? ""));
    const hbRaw = get(o, "human_bonus");
    const hb = hbRaw === null || hbRaw === undefined ? [] : isArr(hbRaw) ? Object.values(hbRaw) : [hbRaw];
    for (let i = 0; i < HUMAN_BONUS_POINTS; i++) row.push(str(hb[i] ?? ""));
    row.push(str(get(o, "voice") ?? ""));
    lines.push(row);
  }
  return writeCsv(lines);
}

/* PHP: crew_template_csv(). Pre-filled crew template (§4.4.2): roles in order, 0 in each officer's own four cells,
   the rest empty. */
function crewTemplateCsv() {
  const cols = [...crewRequiredColumns(), ...humanBonusColumns()];
  const lines = [cols];
  for (const def of Object.values(Rules.roles())) {
    lines.push(cols.map(col => (col === "role" ? def.label : def.attrs.includes(col) ? "0" : "")));
  }
  return writeCsv(lines);
}

/* PHP: ship_template_csv(). Ship template: the header and one row with a blank name and 0 in each attribute. */
function shipTemplateCsv() {
  const attrs = Rules.shipAttributes();
  return writeCsv([shipColumns(), shipColumns().map(col => (own(attrs, col) ? "0" : ""))]);
}

/* ---------- CSV helpers ---------- */

/* PHP's fgetcsv(..., ',', '"', '') over a whole text with "\n" line endings, returning every record. A wholly blank
   line gives [null], as fgetcsv does. Followed exactly: spaces before an opening quote are dropped; inside quotes ""
   is a quote and line breaks are kept; text after a closing quote, up to the comma, is kept; an unclosed quote runs
   to the end of the text. */
function fgetcsvAll(text) {
  const records = [];
  const len = text.length;
  let pos = 0;
  while (pos < len) {
    let nl = text.indexOf("\n", pos);
    let limit = nl === -1 ? len : nl;
    let next = nl === -1 ? len : nl + 1;
    const cells = [];
    let b = pos;
    let first = true;
    for (;;) {
      if (b < limit) {
        let t = b;
        while (t < limit && text[t] !== "," && WS.includes(text[t])) t++;
        if (t < limit && text[t] === '"') b = t;
      }
      if (first && b === limit) {
        cells.push(null);
        break;
      }
      first = false;
      let value = "";
      if (b < limit && text[b] === '"') {
        b++;
        let closed = false;
        for (;;) {
          if (b >= limit) {
            // The line ended inside the quotes: keep its line break and read on into the next line.
            if (nl !== -1) value += "\n";
            if (next >= len) {
              b = limit;
              break; // unterminated: the field runs to the end of the text
            }
            nl = text.indexOf("\n", next);
            b = next;
            limit = nl === -1 ? len : nl;
            next = nl === -1 ? len : nl + 1;
            continue;
          }
          const ch = text[b];
          if (ch === '"') {
            if (b + 1 < limit && text[b + 1] === '"') {
              value += '"';
              b += 2;
            } else {
              b++;
              closed = true;
              break;
            }
          } else {
            value += ch;
            b++;
          }
        }
        if (closed) {
          let d = text.indexOf(",", b);
          if (d === -1 || d > limit) d = limit;
          value += text.slice(b, d);
          b = d;
        }
      } else {
        let d = text.indexOf(",", b);
        if (d === -1 || d > limit) d = limit;
        value = text.slice(b, d);
        b = d;
      }
      cells.push(value);
      if (b < limit && text[b] === ",") {
        b++;
        continue;
      }
      break;
    }
    records.push(cells);
    pos = next;
  }
  return records;
}

/* PHP: read_csv(). Read CSV text into records, tolerating a BOM, CRLF line endings and blank lines.
   Returns [{ row: spreadsheet row number, cells: trimmed strings }]. */
function readCsv(csv) {
  csv = String(csv ?? "");
  if (csv.startsWith("﻿")) csv = csv.slice(1);
  else if (csv.startsWith("\xEF\xBB\xBF")) csv = csv.slice(3); // a BOM read as Latin-1
  csv = csv.replace(/\r\n|\r/g, "\n");
  const records = [];
  let n = 0;
  for (const raw of fgetcsvAll(csv)) {
    n++;
    const cells = raw.map(c => phpTrim(c === null ? "" : c));
    // A wholly blank line is not a record, but it still counts, so row numbers match the spreadsheet.
    if (cells.join("") === "") continue;
    records.push({ row: n, cells });
  }
  return records;
}

/* PHP: write_csv(), with fputcsv(..., ',', '"', ''): a field is quoted when it holds a comma, a quote, a line break,
   a tab or a space; quotes inside are doubled; every line ends with "\n". */
function writeCsv(lines) {
  return lines.map(line => line.map(f => {
    f = String(f);
    return /[,"\n\r\t ]/.test(f) ? '"' + f.replace(/"/g, '""') + '"' : f;
  }).join(",") + "\n").join("");
}

/* PHP: map_header(). Match a header row against the known columns.
   Returns [column name => cell index, header errors (row 1)]. */
function mapHeader(header, known, required, aliases = {}) {
  const map = {};
  const errors = [];
  header.forEach((cell, i) => {
    let name = asciiLower(phpTrim(cell)).replace(/[ \t\n\v\f\r\-]+/g, "_");
    if (own(aliases, name)) name = aliases[name];
    if (name === "") return;
    if (!known.includes(name)) {
      errors.push(err(1, name, `The header has a column called "${cell}", which is not part of this file. Remove it or correct its name.`));
      return;
    }
    if (own(map, name)) {
      errors.push(err(1, name, `The header has the column "${name}" more than once.`));
      return;
    }
    map[name] = i;
  });
  for (const name of required) {
    if (!own(map, name)) errors.push(err(1, name, `The header is missing the "${name}" column.`));
  }
  return [map, errors];
}

/* PHP: assoc_row() */
function assocRow(cells, map) {
  const out = {};
  for (const [name, i] of Object.entries(map)) out[name] = cells[i] ?? "";
  return out;
}

/* PHP: extra_cell_errors(). A row with filled cells beyond the header's last column has slipped sideways; say so. */
function extraCellErrors(record, width) {
  if (record.cells.slice(width).join("") === "") return [];
  return [err(record.row, null, "This row has more cells than the header has columns. Check for a stray comma, or put text that contains commas in double quotes.")];
}

/* ---------- Saved builds: one record is a ship and its crew together (§4.5) ----------
   The plugin stored these as WordPress posts. Here they live in <dataDir>/builds.json:
   { next_id: int, builds: [{ id, name, ship, crew, modified }] }, written atomically (.tmp, then rename).
   Ids count up from 1 and are never reused, as post ids were not. 'modified' is UTC, "YYYY-MM-DD HH:MM:SS", the form
   of WordPress's post_modified_gmt. Failures are returned as { code, message, data } (what was a WP_Error). */

function buildsPath(dataDir) {
  return path.join(dataDir, BUILDS_FILE);
}

/* The store, or an empty one when the file does not exist yet. A damaged file throws rather than being overwritten. */
function loadStore(dataDir) {
  let text;
  try {
    text = fs.readFileSync(buildsPath(dataDir), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { next_id: 1, builds: [] };
    throw e;
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || !Array.isArray(data.builds)) throw new Error(buildsPath(dataDir) + " is not a saved-builds file.");
  if (!Number.isSafeInteger(data.next_id) || data.next_id < 1) data.next_id = 1;
  for (const b of data.builds) data.next_id = Math.max(data.next_id, intval(b.id) + 1);
  return data;
}

function writeStore(dataDir, data) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = buildsPath(dataDir);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

function gmtNow() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/* True when a value returned by saveBuild() is a failure rather than an id. */
function isError(v) {
  return v !== null && typeof v === "object" && typeof v.code === "string";
}

/* PHP: save_build(). Create (id 0) or update a saved build. Both halves are validated first and stored in their
   validated form. Returns the build's id, or { code: 'invalid', message, data: { errors: { ship: [], crew: [] } } },
   or { code: 'not_found', message } when id names no saved build. */
function saveBuild(dataDir, ship, crew, id = 0) {
  id = intval(id);
  const s = validateShip(ship);
  const c = validateCrew(crew);
  if (!s.ok || !c.ok) {
    return { code: "invalid", message: "The ship or crew is not valid, so it was not saved.", data: { errors: { ship: s.errors, crew: c.errors } } };
  }
  const store = loadStore(dataDir);
  const record = { id, name: s.ship.name, ship: s.ship, crew: c.crew, modified: gmtNow() };
  if (id > 0) {
    const i = store.builds.findIndex(b => intval(b.id) === id);
    if (i === -1) return { code: "not_found", message: "That saved ship and crew no longer exists." };
    store.builds[i] = record;
  } else {
    record.id = store.next_id++;
    store.builds.push(record);
  }
  writeStore(dataDir, store);
  return record.id;
}

/* PHP: get_build(). Returns { id, name, ship, crew, modified } or null. */
function getBuild(dataDir, id) {
  id = intval(id);
  if (id <= 0) return null;
  const b = loadStore(dataDir).builds.find(x => intval(x.id) === id);
  if (!b || !isArr(b.ship) || !isArr(b.crew)) return null;
  return { id: intval(b.id), name: String(b.name ?? ""), ship: b.ship, crew: b.crew, modified: String(b.modified ?? "") };
}

/* PHP: list_builds(). Light listing for pickers, ordered by name (ignoring case, then by id): no ship or crew bodies.
   Returns [{ id, name, captain, modified }]. */
function listBuilds(dataDir) {
  const out = loadStore(dataDir).builds.map(b => ({
    id: intval(b.id),
    name: String(b.name ?? ""),
    captain: String(isArr(b.ship) ? b.ship.captain ?? "" : ""),
    modified: String(b.modified ?? "")
  }));
  out.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.id - b.id;
  });
  return out;
}

/* PHP: delete_build(). True when a build was deleted. */
function deleteBuild(dataDir, id) {
  id = intval(id);
  if (id <= 0) return false;
  const store = loadStore(dataDir);
  const i = store.builds.findIndex(b => intval(b.id) === id);
  if (i === -1) return false;
  store.builds.splice(i, 1);
  writeStore(dataDir, store);
  return true;
}

module.exports = {
  HUMAN_BONUS_POINTS, BUILDS_FILE,
  shipRequiredColumns, shipColumns, crewRequiredColumns, humanBonusColumns, crewColumns,
  validateShip, validateCrew, readUpload, parseShipCsv, parseCrewCsv,
  exportShipCsv, exportCrewCsv, crewTemplateCsv, shipTemplateCsv,
  saveBuild, getBuild, listBuilds, deleteBuild, isError,
  // Exposed for tests and for the CSV parser's exactness checks.
  _readCsv: readCsv, _fgetcsvAll: fgetcsvAll, _writeCsv: writeCsv
};
