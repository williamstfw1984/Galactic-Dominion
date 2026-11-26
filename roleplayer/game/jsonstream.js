"use strict";
/* Reads a JSON object as it is being written, and hands over each element of its top-level arrays the moment that
   element is complete. Used to show and speak narration line by line while the model is still writing (§14.5 rule 8).
   Ported from the plugin's class-jsonstream.php.

   Only what is needed for that: the text is one JSON object; for every key whose value is an array of objects, each
   object is reported as soon as its closing brace arrives. Pure logic. Chunks are strings: a caller reading bytes
   decodes them first (for example with a streaming TextDecoder), so a character is never split between chunks. */

/* JSON.parse that gives undefined instead of throwing, as PHP's json_decode gives null. */
function decode(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

class Jsonstream {
  /* emit(key, object) is called for each finished array element; partial(key, raw), if given, after each feed with
     the array element now being written, as far as it has got. */
  constructor(emit, partial = null) {
    this.emit = emit;
    this.partial = partial;
    this.buf = "";
    this.pos = 0;      // next character to look at
    this.depth = 0;    // nesting of {} and []
    this.inStr = false;
    this.escape = false;
    this.strAt = 0;    // where the current string began
    this.key = "";     // the top-level key whose value is being read
    this.last = "";    // the last string seen at depth 1, a candidate key
    this.objAt = -1;   // where the current array element began
  }

  /* PHP: partial_line(). Read a line object that is still being written: {"speaker_type":..., ..., "line":"so far
     Returns { head (the fields before "line"), text (the line so far) }, or null while "line" has not begun, or if it
     was not written last and so cannot be shown as it comes. */
  static partialLine(raw) {
    raw = String(raw);
    const m = /(?<!\\)"line"[ \t\n\r\v\f]*:[ \t\n\r\v\f]*"/.exec(raw); // PHP's \s, without /u
    if (!m) return null;
    const head = decode(raw.slice(0, m.index).replace(/[, \t\r\n]+$/, "") + "}");
    if (head === null || typeof head !== "object") return null;
    let body = raw.slice(m.index + m[0].length);
    // Up to the closing quote if it has been written; otherwise all of it, less an escape that is not finished.
    const n = body.length;
    let end = n;
    for (let i = 0; i < n; i++) {
      if (body[i] === "\\") {
        const need = i + 1 < n && body[i + 1] === "u" ? 6 : 2;
        if (i + need > n) {
          end = i;
          break;
        }
        i += need - 1;
      } else if (body[i] === '"') {
        end = i;
        break;
      }
    }
    body = body.slice(0, end);
    // A pair of 😀 escapes must be whole (and, in PHP, a multi-byte character too: the cuts below).
    body = body.replace(/\\u[dD][89abAB][0-9a-fA-F]{2}$/, "");
    for (let cut = 0; cut < 4; cut++) {
      const text = decode('"' + (cut ? body.slice(0, -cut) : body) + '"');
      if (typeof text === "string") return { head, text };
    }
    return null;
  }

  feed(chunk) {
    this.buf += typeof chunk === "string" ? chunk : String(chunk);
    const n = this.buf.length;
    for (; this.pos < n; this.pos++) {
      const ch = this.buf[this.pos];
      if (this.inStr) {
        if (this.escape) {
          this.escape = false;
        } else if (ch === "\\") {
          this.escape = true;
        } else if (ch === '"') {
          this.inStr = false;
          if (this.depth === 1) {
            const s = decode(this.buf.slice(this.strAt, this.pos + 1));
            this.last = typeof s === "string" ? s : "";
          }
        }
        continue;
      }
      if (ch === '"') {
        this.inStr = true;
        this.strAt = this.pos;
      } else if (ch === ":" && this.depth === 1) {
        this.key = this.last;
      } else if (ch === "{" || ch === "[") {
        this.depth++;
        if (ch === "{" && this.depth === 3) this.objAt = this.pos;
      } else if (ch === "}" || ch === "]") {
        if (ch === "}" && this.depth === 3 && this.objAt >= 0) {
          const obj = decode(this.buf.slice(this.objAt, this.pos + 1));
          this.objAt = -1;
          if (obj !== null && typeof obj === "object") this.emit(this.key, obj);
        }
        this.depth--;
      }
    }
    if (this.partial && this.objAt >= 0 && this.depth >= 3) {
      this.partial(this.key, this.buf.slice(this.objAt));
    }
  }
}

module.exports = { Jsonstream };
