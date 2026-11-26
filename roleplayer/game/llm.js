"use strict";
/* Calls to the language model, replacing the plugin's class-llm.php (§1.1, §7.2.2).

   The game only ever uses the app's own local engine (a private Ollama, see main.js). This module is given the two
   functions main.js uses to talk to it, so it has no network code of its own and tests can give a scripted stand-in:
     chat({ model, messages, temperature, json, format, context, limit })       -> the reply text
     chatStream({ model, messages, temperature, context, format, onText, signal }) -> the whole reply text
   messages are Ollama's: [{ role: "system" | "user", content }]. A JSON call passes its JSON schema as `format`
   (Ollama's structured outputs) and also `json: true`. A streamed call hands each piece of the reply to onText as
   it is written; when the game wants the reply stopped (a line it cannot use, or one the safety check flagged) it
   aborts `signal`, and later pieces are ignored.

   One model, from the app's settings, is used for every kind of call; the plugin's per-call routing has no
   equivalent. The engine reports no token counts here, so the log keeps estimates (about four characters a token),
   as the plugin's own budgeting did (§11.5). Every call is logged with them, as an 'llm' or 'llm_error' event. */
const { GdError } = require("./text.js");

/* Rough token estimate: about four characters per token (bytes of UTF-8, as PHP's strlen counts). */
function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / 4);
}

/* JSON.parse that gives null for anything but an object or array (PHP's json_decode(..., true) as an array). */
function decodeArray(text) {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/* Pull the first JSON object out of model text. Returns the value or null. */
function extractJson(text) {
  text = String(text ?? "").trim();
  let v = decodeArray(text);
  if (v) return v;
  const m = /```(?:json)?\s*(\{.*\})\s*```/s.exec(text);
  if (m) {
    v = decodeArray(m[1]);
    if (v) return v;
  }
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a !== -1 && b !== -1 && b > a) {
    v = decodeArray(text.slice(a, b + 1));
    if (v) return v;
  }
  return null;
}

/* The model caller. settings: { model, context, temperature } (the app's default model and its context size). */
function createLlm({ chat, chatStream, settings = {} }) {
  if (typeof chat !== "function") throw new Error("The model caller needs a chat function.");

  /* Run one call.
     opts: json (bool), schema (JSON schema for structured output), maxTokens, onText (piece) -> false to stop,
     store, gameId, captainId, turnNo (for the event log).
     Returns { text, json, tokens_in, tokens_out, model } or a GdError. */
  async function call(callType, system, user, opts = {}) {
    const model = String(settings.model || "");
    if (!model) return new GdError("gd_no_model", "No model is chosen for the game. Choose one in the app's settings.");
    const messages = [{ role: "system", content: String(system) }, { role: "user", content: String(user) }];
    const wantsJson = !!(opts.json || opts.schema);
    const base = { model, messages, temperature: settings.temperature, context: settings.context };
    if (wantsJson) {
      base.json = true;
      if (opts.schema) base.format = opts.schema;
    }
    const t0 = Date.now();
    let text = "";
    let error = null;
    try {
      if (opts.onText && typeof chatStream === "function") {
        const ctl = new AbortController();
        let cut = false;
        const onText = piece => {
          if (cut || !piece) return;
          text += piece;
          if (opts.onText(piece) === false) {
            cut = true;
            ctl.abort();
          }
        };
        const whole = await chatStream(Object.assign({}, base, { onText, signal: ctl.signal })).catch(e => {
          if (cut) return text; // stopped on purpose: what arrived stands
          throw e;
        });
        if (!cut && typeof whole === "string" && whole.length >= text.length) text = whole;
      } else {
        if (opts.maxTokens) base.limit = opts.maxTokens;
        text = String(await chat(base));
        if (opts.onText) opts.onText(text);
      }
      if (String(text).trim() === "") error = "The model returned no text.";
    } catch (e) {
      error = "The game's AI engine could not be reached: " + String((e && e.message) || e);
    }
    const ms = Date.now() - t0;
    const log = opts.store && opts.gameId ? opts.store : null;
    if (error) {
      if (log) log.event(opts.gameId, opts.captainId || 0, "llm_error", { call: callType, provider: "local", model, error, ms }, opts.turnNo || 0);
      return new GdError("gd_llm", error);
    }
    const res = { text, tokens_in: estimateTokens(system) + estimateTokens(user), tokens_out: estimateTokens(text), provider: "local", model };
    if (wantsJson) res.json = extractJson(text);
    if (log) log.event(opts.gameId, opts.captainId || 0, "llm", { call: callType, provider: "local", model, ms }, opts.turnNo || 0, res.tokens_in, res.tokens_out);
    return res;
  }

  return { call, estimateTokens, extractJson };
}

module.exports = { createLlm, estimateTokens, extractJson };
