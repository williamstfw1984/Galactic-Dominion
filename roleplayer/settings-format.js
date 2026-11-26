"use strict";
/* The settings file (prompts, stand-in words, interests, models, repetition penalty, admin password hash) and the way an installer carries it.
   An installer ends with: <settings text> <"1" followed by the 9-digit length of that text> <RPSETTINGS>.
   Used by the program, the build and the installer editor. */
const MARK = "RPSETTINGS", TAIL = 10 + MARK.length;
const ascii = bytes => Array.from(bytes, b => String.fromCharCode(b)).join("");
const encode = cfg => btoa(ascii(new TextEncoder().encode(JSON.stringify(cfg))));
const decode = text => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(text.trim()), c => c.charCodeAt(0))));
const valid = cfg => !!cfg && typeof cfg.prompt === "string" && !!cfg.prompt.trim() && Array.isArray(cfg.interests) && !!cfg.models && typeof cfg.adminHash === "string";
/* Length of the settings text, given the last TAIL bytes of an installer; 0 when it carries none. */
const embeddedLength = tail => {
  const text = ascii(tail);
  return text.length === TAIL && text.endsWith(MARK) && /^1\d{9}$/.test(text.slice(0, 10)) ? Number(text.slice(1, 10)) : 0;
};
const trailer = text => text + "1" + String(text.length).padStart(9, "0") + MARK;
module.exports = { TAIL, encode, decode, valid, embeddedLength, trailer };
