"use strict";
/* Small helpers the port shares: the WordPress text-cleaning functions the plugin used on everything a model or a
   player wrote (sanitize_key, sanitize_text_field, sanitize_textarea_field, wp_strip_all_tags), PHP's mb_substr,
   the plugin's error object (what was a WP_Error), the time in the plugin's stored form, and hashing helpers.
   Pure functions, no dependencies beyond Node's crypto. */
const crypto = require("crypto");

/* A failure, as the plugin's WP_Error: a code, a message for the player and data (data.status is the HTTP status). */
class GdError {
  constructor(code, message, data = {}) {
    this.code = code;
    this.message = message;
    this.data = data || {};
  }
}
const isErr = v => v instanceof GdError;
const fail = (code, message, status, data = {}) => new GdError(code, message, Object.assign({ status }, data));

/* PHP's mb_substr(s, 0, n): by characters (code points), not UTF-16 units. */
function mbSubstr(s, start, length) {
  const chars = Array.from(String(s ?? ""));
  return chars.slice(start, length === undefined ? undefined : start + length).join("");
}

/* wp_strip_all_tags(): script and style elements with their content, then every tag. */
function stripAllTags(s, removeBreaks = false) {
  let out = String(s ?? "").replace(/<(script|style)[^>]*?>.*?<\/\1>/gis, "");
  out = out.replace(/<[^>]*>/g, "");
  if (removeBreaks) out = out.replace(/[\r\n\t ]+/g, " ");
  return out.trim();
}

/* WordPress's _sanitize_text_fields(): what sanitize_text_field and sanitize_textarea_field share. */
function sanitizeFields(s, keepNewlines) {
  let str = String(s ?? "");
  if (str.includes("<")) {
    // wp_pre_kses_less_than: a "<" that does not open a tag is kept as text, then the tags go.
    str = str.replace(/<(?![a-zA-Z\/!?])/g, "&lt;");
    str = stripAllTags(str, false);
    str = str.replace(/<\n/g, "&lt;\n");
  }
  if (!keepNewlines) str = str.replace(/[\r\n\t ]+/g, " ");
  str = str.trim();
  let found = false;
  while (/%[a-f0-9]{2}/i.test(str)) {
    str = str.replace(/%[a-f0-9]{2}/i, "");
    found = true;
  }
  if (found) str = str.trim().replace(/ +/g, " ");
  return str;
}
const sanitizeTextField = s => sanitizeFields(s, false);
const sanitizeTextareaField = s => sanitizeFields(s, true);

/* sanitize_key(): lower case letters, digits, underscores and dashes only. */
function sanitizeKey(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9_\-]/g, "");
}

/* The time as the plugin stored it: UTC "YYYY-MM-DD HH:MM:SS" (gmdate('Y-m-d H:i:s')). */
function gmdate(unix) {
  return new Date((unix === undefined ? Date.now() / 1000 : unix) * 1000).toISOString().slice(0, 19).replace("T", " ");
}
/* Seconds since 1970, as PHP's time(). */
const time = () => Math.floor(Date.now() / 1000);
/* strtotime(stored . ' UTC') for a stored time. */
const parseGm = s => Math.floor(Date.parse(String(s).replace(" ", "T") + "Z") / 1000);

const sha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const sha1 = s => crypto.createHash("sha1").update(String(s)).digest("hex");
const md5 = s => crypto.createHash("md5").update(String(s)).digest("hex");
const randomHex = bytes => crypto.randomBytes(bytes).toString("hex");
/* wp_rand(min, max) */
const randInt = (min, max) => crypto.randomInt(min, max + 1);

/* hexdec(substr(hash('sha256', s), 0, 7)): the plugin's seeded picks. */
const hashPick = s => parseInt(sha256(s).slice(0, 7), 16);

/* PHP's empty(): undefined, null, false, 0, "", "0", and an empty list or keyed array. */
const empty = v => v === undefined || v === null || v === false || v === 0 || v === "" || v === "0"
  || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
/* What PHP's foreach over (array) $v visits: nothing for null, the values of a list or keyed array, else the value. */
const toList = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : typeof v === "object" ? Object.values(v) : [v]);
const isObj = v => v !== null && typeof v === "object";
/* PHP's (string) cast of what a model wrote: arrays become "Array", as PHP would print them. */
const str = v => (v === undefined || v === null || v === false ? "" : v === true ? "1" : typeof v === "object" ? "Array" : String(v));

/* JSON in the plugin's form (wp_json_encode with unescaped slashes and unicode is what JSON.stringify gives). */
const enc = v => JSON.stringify(v);

module.exports = {
  GdError, isErr, fail, mbSubstr, stripAllTags, sanitizeTextField, sanitizeTextareaField, sanitizeKey,
  gmdate, time, parseGm, empty, toList, isObj, str, sha256, sha1, md5, randomHex, randInt, hashPick, enc
};
