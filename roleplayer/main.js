"use strict";
/* Galactic Dominion: desktop program. Everything it downloads or saves lives in DATA, which the uninstaller deletes. */
const { app, BrowserWindow, Menu, ipcMain, net, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFile, execFileSync } = require("child_process");
const { pipeline } = require("stream/promises");
const { Readable, Transform } = require("stream");
const readline = require("readline");
const format = require("./settings-format.js");
const builtIn = require("./built-in.js");

const ENGINE = {
  url: "https://github.com/ollama/ollama/releases/download/v0.40.16/ollama-windows-amd64.zip",
  sha256: "50fcf5ad54277f2fa5d173ebfc93bcb017adbc0c9ef2314daabc96ca9e6aa64e"
};
const PORT = 11527;                                   // private port, so a separately installed Ollama is left alone
const BASE = "http://127.0.0.1:" + PORT;
const DATA = app.getPath("userData");
const MODELS_DIR = path.join(DATA, "models");
const ENGINE_DIR = process.env.ROLEPLAYER_ENGINE_DIR || path.join(DATA, "engine");   // the variable is set only by automated tests, to use an engine that is already unpacked
const ENGINE_EXE = path.join(ENGINE_DIR, process.platform === "win32" ? "galactic-dominion-engine.exe" : "ollama");
const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, "resources");
const SETTINGS = path.join(DATA, "settings.dat");
const SELFTEST = process.env.ROLEPLAYER_SELFTEST;        // path of a result file; set only by automated tests

let win = null;
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
const progress = info => send("progress", info);

/* ---------- settings (prompts, stand-in words, interests, models, repetition penalty, admin password) ---------- */
/* The settings in a file that came with the program, or null when there is no such file. */
function cameWith(name) {
  const file = path.join(RES, name);
  if (!fs.existsSync(file)) return null;
  let cfg = null;
  try { cfg = format.decode(fs.readFileSync(file, "utf8")); } catch {}
  if (!format.valid(cfg)) throw new Error("The settings that came with the program are damaged. Please install it again.");
  return cfg;
}
/* Every installer leaves the settings it carries beside the ones the program was built with. When the two differ the
   installer was customised, and its settings replace the program's every time it installs. Otherwise the settings the
   program was built with are taken on the first run only. Either way they become the only copy. */
function loadSettings() {
  // The carried settings are named first because they are removed first: left alone, they would pass for a customised installer's.
  const files = ["installer-settings.dat", "settings.dat"], [carried, built] = files.map(cameWith);
  const customised = carried && JSON.stringify(carried) !== JSON.stringify(built);
  const taken = customised ? carried : fs.existsSync(SETTINGS) ? null : built;
  if (taken) { fs.mkdirSync(DATA, { recursive: true }); saveSettings(taken); }
  if (app.isPackaged && (built || carried)) for (const name of files) fs.rmSync(path.join(RES, name), { force: true });
  return builtIn.complete(format.decode(fs.readFileSync(SETTINGS, "utf8")));
}
function saveSettings(cfg) {
  if (!format.valid(cfg)) throw new Error("The settings are incomplete and were not saved.");
  const tmp = SETTINGS + ".tmp";
  fs.writeFileSync(tmp, format.encode(cfg));
  fs.renameSync(tmp, SETTINGS);                         // in one step, so a file cut short is never taken for the settings; no earlier copy is kept
}

/* ---------- AI engine (Ollama, kept private to this program) ---------- */
const engineInstalled = () => fs.existsSync(ENGINE_EXE);
const STALLED_MS = 60 * 1000;                           // a download that sends nothing for this long is given up
async function download(url, dest, onProgress) {
  const stalled = new AbortController();
  let timer = setTimeout(() => stalled.abort(), STALLED_MS);
  try {
    const res = await net.fetch(url, { signal: stalled.signal });
    if (!res.ok) throw new Error("The download failed (" + res.status + ").");
    const total = Number(res.headers.get("content-length")) || 0, hash = crypto.createHash("sha256");
    let done = 0, last = 0;
    const count = new Transform({ transform(chunk, _encoding, pass) {
      clearTimeout(timer); timer = setTimeout(() => stalled.abort(), STALLED_MS);
      hash.update(chunk); done += chunk.length;
      if (Date.now() - last > 300) { last = Date.now(); onProgress(done, total); }
      pass(null, chunk);
    } });
    await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(dest));
    return hash.digest("hex");
  } catch (e) {
    throw stalled.signal.aborted ? new Error("The download stopped responding. Please check the connection and try again.") : e;
  } finally { clearTimeout(timer); }
}
function unzip(zipFile, destDir, onProgress) {
  const yauzl = require("yauzl");
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      let n = 0;
      zip.on("error", reject).on("close", resolve);        // "close": the package file itself has been released
      zip.on("entry", entry => {
        const target = path.join(destDir, entry.fileName);
        if (!target.startsWith(destDir + path.sep)) return reject(new Error("The engine package contains an unsafe file path."));
        onProgress(++n, zip.entryCount);
        if (entry.fileName.endsWith("/")) { fs.mkdirSync(target, { recursive: true }); return zip.readEntry(); }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          // "close", not "finish": Windows will not rename the folder while any file in it is still open
          stream.pipe(fs.createWriteStream(target)).on("close", () => zip.readEntry()).on("error", reject);
        });
      });
      zip.readEntry();
    });
  });
}
/* Sets up the engine with the models that are part of it, each downloaded unless it is there already. */
async function setUpEngine() {
  await installEngine(); await aiEngine.start();
  const have = await installedModels();
  for (const model of builtIn.ENGINE_MODELS) if (!hasModel(have, model)) await pullModel(model);
}
async function installEngine() {
  if (engineInstalled()) return;
  if (process.platform !== "win32") throw new Error("Automatic engine setup is only available on Windows.");
  fs.mkdirSync(DATA, { recursive: true });
  const zip = path.join(DATA, "engine-download.zip"), tmpDir = ENGINE_DIR + ".tmp";
  try {
    const sum = await download(ENGINE.url, zip, (done, total) => progress({ kind: "engine", phase: "Downloading", done, total }));
    if (sum !== ENGINE.sha256) throw new Error("The engine download was damaged. Please try again.");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await unzip(zip, tmpDir, (done, total) => progress({ kind: "engine", phase: "Unpacking", done, total }));
    fs.renameSync(path.join(tmpDir, "ollama.exe"), path.join(tmpDir, path.basename(ENGINE_EXE)));
    fs.rmSync(ENGINE_DIR, { recursive: true, force: true });
    fs.renameSync(tmpDir, ENGINE_DIR);
  } finally {
    fs.rmSync(zip, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
const START_CHECK_MS = 500;
/* A helper program kept running in the background and reached on a port of this computer. start() resolves once it
   answers at the given address; it is given that many checks, half a second apart, to do so. When it does not, the
   error says whether the program ended by itself (exited) or was still running and was stopped. */
function service(name, exe, launch, address, checks) {
  let child = null, ready = null;
  const stop = () => {
    if (!child) return;
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});   // also ends any process it started
    else child.kill();
    child = null; ready = null;
  };
  const start = () => {
    if (ready) return ready;
    const starting = ready = (async () => {
      // One left running by an earlier run of the program that did not close properly would hold the port.
      if (process.platform === "win32") { try { execFileSync("taskkill", ["/im", path.basename(exe), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {} }   // fails when none is running
      const mine = child = launch();
      const gone = () => { if (child === mine) { child = null; ready = null; } };   // a later one is not this one's to clear
      mine.on("exit", gone).on("error", gone);
      for (let i = 0; i < checks && child === mine; i++) {
        try { if ((await fetch(address)).ok) return; } catch {}   // not listening yet
        await new Promise(r => setTimeout(r, START_CHECK_MS));
      }
      const exited = child !== mine;                    // it ended by itself, rather than not answering in time
      if (!exited) stop();
      throw Object.assign(new Error(`The ${name} did not start.`), { exited });
    })();
    starting.catch(() => { if (ready === starting) ready = null; });
    return starting;
  };
  return { start, stop };
}
/* Follows what a helper program says as it runs. There is nothing to follow when it could not be launched. */
const listen = (child, heard) => { if (child.stderr) readline.createInterface({ input: child.stderr }).on("line", heard); return child; };
let compute = [];                                       // what the AI engine said, as it started, that it can run models on: "cpu", or the kind of each graphics card it found
const engineUsesCard = () => compute.some(kind => kind !== "cpu");
const aiEngine = service("AI engine", ENGINE_EXE, () => {
  if (!engineInstalled()) throw new Error("The AI engine has not been set up yet.");
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  compute = [];
  return listen(spawn(ENGINE_EXE, ["serve"], {
    env: { ...process.env, OLLAMA_HOST: "127.0.0.1:" + PORT, OLLAMA_MODELS: MODELS_DIR, OLLAMA_KEEP_ALIVE: "30m" },
    windowsHide: true, stdio: ["ignore", "ignore", "pipe"]
  }), line => { const found = /msg="inference compute".*\slibrary=(\S+)/.exec(line); if (found) compute.push(found[1].toLowerCase()); });
}, BASE + "/api/version", 120);
/* Ends a request when it has taken too long, or when it is cut off. */
const within = (timeoutMs, stop) => stop ? AbortSignal.any([AbortSignal.timeout(timeoutMs), stop]) : AbortSignal.timeout(timeoutMs);
async function engineCall(route, body, timeoutMs, stop) {
  await aiEngine.start();
  const res = await fetch(BASE + route, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, signal: within(timeoutMs, stop) });
  if (!res.ok) {
    let msg = ""; try { msg = (await res.json()).error || ""; } catch {}
    throw new Error(msg || "The AI engine returned an error (" + res.status + ").");
  }
  return res;
}
const installedModels = async () => (await (await engineCall("/api/tags", null, 15000)).json()).models.map(m => m.name);
/* Whether a model is among those the engine has. The engine does not mind the case of a name. */
const hasModel = (list, name) => { const wanted = [name, name + ":latest"].map(n => n.toLowerCase()); return list.some(n => wanted.includes(n.toLowerCase())); };
/* Models whose own conversation format the engine does not recognise, with the format to give it in the engine's own
   terms, written from the one the model comes with: who is speaking is marked by <|system|>, <|user|> or
   <|assistant|>, each turn ends with <|endoftext|>, and the reply begins with <|assistant|>. */
const FORMATS = [{
  models: /^hf\.co\/bartowski\/pocketdoc_dans-personalityengine-/i,
  template: '{{- range $i, $_ := .Messages }}{{- $last := eq (len (slice $.Messages $i)) 1 }}'
    + '{{- if eq .Role "system" }}<|system|>{{ .Content }}<|endoftext|>'
    + '{{- else if eq .Role "user" }}<|user|>{{ .Content }}<|endoftext|>'
    + '{{- else if eq .Role "assistant" }}<|assistant|>{{ .Content }}{{ if not $last }}<|endoftext|>{{ end }}'
    + '{{- end }}{{- if and $last (ne .Role "assistant") }}<|assistant|>{{ end }}{{- end }}',
  stop: ["<|endoftext|>", "<|user|>"]
}];
/* The engine answers long requests as one JSON object per line. */
async function* jsonLines(res) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      yield j;
    }
  }
}
async function pullModel(name) {
  const layers = {};
  for await (const j of jsonLines(await engineCall("/api/pull", { model: name }, 6 * 3600 * 1000))) {
    if (j.digest && j.total) layers[j.digest] = [j.completed || 0, j.total];
    const all = Object.values(layers);
    progress({ kind: "model", model: name, phase: j.status === "success" ? "Finished" : "Downloading", done: all.reduce((a, l) => a + l[0], 0), total: all.reduce((a, l) => a + l[1], 0) });
  }
  await formatted(name);
}
/* Gives a model that needs it the conversation format it is used with, unless it has it already: done after it is
   downloaded, and checked again before it is first used in a session, in case that was cut short. The model keeps its
   name. */
const formatsGiven = new Set();
async function formatted(model) {
  const format = FORMATS.find(f => f.models.test(model));
  if (!format || formatsGiven.has(model)) return;
  const shown = await (await engineCall("/api/show", { model }, 15000)).json();
  if (shown.template !== format.template) await engineCall("/api/create", { model, from: model, template: format.template, parameters: { stop: format.stop }, stream: false }, LOAD_MS);
  formatsGiven.add(model);
}
let chatRequest = null;                                 // the request the model is working on, so it can be cut off
function cutOffSignal() {
  chatRequest = new AbortController();
  return chatRequest.signal;
}
/* The largest context the model accepts, in tokens, as the engine reports it. */
async function modelContext(model) {
  const info = (await (await engineCall("/api/show", { model }, 15000)).json()).model_info || {};
  const key = Object.keys(info).find(k => k.endsWith(".context_length"));
  return key ? info[key] : 0;
}
async function chat({ model, messages, temperature, json, context, limit }) {
  await formatted(model);
  const body = { model, messages, stream: false, think: false, options: { temperature, num_ctx: context } };
  if (json) body.format = "json";
  if (limit) body.options.num_predict = limit;          // the most tokens the reply may have
  const out = await (await engineCall("/api/chat", body, 15 * 60 * 1000, cutOffSignal())).json();
  return (out.message && out.message.content || "").trim();
}
const LOAD_MS = 10 * 60 * 1000;                         // how long the engine is given to load a model
/* Has the engine load a model, with the context it will be asked for: the engine loads a model again whenever that changes. */
const loadModel = async (model, context) => { await formatted(model); return engineCall("/api/chat", { model, messages: [], options: { num_ctx: context } }, LOAD_MS); };
/* How much of a loaded model sits on the graphics card, from 0 to 1. The engine's own figure is only asked for when it
   found a card: without one it still reports part of the model as being there. */
async function onCard(model) {
  if (!engineUsesCard()) return 0;
  const loaded = (await (await engineCall("/api/ps", null, 15000)).json()).models.find(m => hasModel([m.name], model));
  return loaded && loaded.size ? loaded.size_vram / loaded.size : 0;
}
const REPEAT_WINDOW = 512;                              // how many tokens back the repetition penalty looks: a few turns, not just the last sentence
/* Whether a model can think before it replies, as the engine says. */
async function modelThinks(model) {
  const info = await (await engineCall("/api/show", { model }, 15000)).json();
  return (info.capabilities || []).includes("thinking");
}
/* think: whether the model thinks before it replies; what it thinks is not kept, only the reply. */
async function chatStream({ model, messages, temperature, context, penalty, think }) {
  await formatted(model);
  const body = { model, messages, stream: true, think: !!think, options: { temperature, num_ctx: context, repeat_penalty: penalty, repeat_last_n: REPEAT_WINDOW } };
  let text = "";
  for await (const j of jsonLines(await engineCall("/api/chat", body, 15 * 60 * 1000, cutOffSignal()))) {
    const piece = j.message && j.message.content || "";
    if (piece) { text += piece; send("chat:text", piece); }
  }
  return text.trim();
}

/* ---------- the game's own calls to the engine ---------- */
/* The game server (game/llm.js) asks for a reply in one piece, or streamed a piece at a time to onText. A JSON call gives
   its JSON schema as format, which the engine holds the reply to. Unlike chat() above, these calls are not cut off
   by the interface's stop: each game turn has its own signal. */
function gameBody({ model, messages, temperature, json, format, context, limit }, stream) {
  const body = { model, messages, stream, think: false, options: { num_ctx: context } };
  if (temperature != null) body.options.temperature = temperature;
  if (limit) body.options.num_predict = limit;
  if (format) body.format = format; else if (json) body.format = "json";
  return body;
}
async function gameChat(req) {
  await formatted(req.model);
  const out = await (await engineCall("/api/chat", gameBody(req, false), 15 * 60 * 1000, req.signal)).json();
  return (out.message && out.message.content || "").trim();
}
async function gameChatStream(req) {
  await formatted(req.model);
  let text = "";
  for await (const j of jsonLines(await engineCall("/api/chat", gameBody(req, true), 15 * 60 * 1000, req.signal))) {
    const piece = j.message && j.message.content || "";
    if (piece) { text += piece; if (req.onText) req.onText(piece); }
  }
  return text.trim();
}

/* ---------- the game server, run on this PC when it hosts ---------- */
/* The model the game runs on, chosen on the start screen, and kept in a file of its own. */
const GAME_SETTINGS = path.join(DATA, "game-settings.json");
const GAME_CONTEXT = 16384;                             // tokens the engine holds for a game call: the prompts carry the whole scene; less if the model takes less
const gameSettings = { model: "", context: GAME_CONTEXT, temperature: undefined };   // shared with the server, which reads it on every call
function loadGameSettings() {
  try { Object.assign(gameSettings, JSON.parse(fs.readFileSync(GAME_SETTINGS, "utf8"))); } catch {}   // none yet: no model chosen
  return { model: gameSettings.model };
}
async function chooseGameModel(model) {
  gameSettings.model = String(model || "");
  gameSettings.context = gameSettings.model && engineInstalled() ? Math.min(GAME_CONTEXT, await modelContext(gameSettings.model).catch(() => 0) || GAME_CONTEXT) : GAME_CONTEXT;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(GAME_SETTINGS + ".tmp", JSON.stringify({ model: gameSettings.model, context: gameSettings.context }));
  fs.renameSync(GAME_SETTINGS + ".tmp", GAME_SETTINGS);
  return { model: gameSettings.model };
}
let gameServer = null;                                  // { port, server } while this PC hosts
/* Starts the game server on the port asked for, or reports the one already running. It listens on every network of
   this PC, so captains on other PCs can join; Windows may ask once whether to allow that. */
async function hostGame({ port }) {
  if (gameServer) return { port: gameServer.port };
  const { createServer } = require("./game/server.js");
  const standard = (await voices()).filter(v => !v.needs.length).map(v => ({ id: v.id, name: v.name, gender: v.gender, accent: v.accent }));
  const server = createServer({
    dataDir: path.join(DATA, "game"), llm: { chat: gameChat, chatStream: gameChatStream }, voices: standard,
    safety: checkSafety, settings: gameSettings, port: Number(port) || 47800, host: "0.0.0.0"
  });
  const listening = await server.listen();
  gameServer = { port: listening.port, server };
  return { port: listening.port };
}

/* ---------- speech (Kokoro voices and Whisper recognition, both shipped with the program) ---------- */
let ttsReady = null, sttReady = null;
/* The library that runs the models shipped with the program. It finds a speech model by its name in the speech models'
   folder, and the safety check's classifiers by their full path. */
async function modelLibrary() {
  const lib = await import("@huggingface/transformers");
  lib.env.allowRemoteModels = false;                   // never fetch anything: the models are in the program folder
  lib.env.localModelPath = path.join(RES, "speech-models") + path.sep;
  return lib;
}
function loadTts() {
  if (!ttsReady) ttsReady = (async () => {
    await modelLibrary();
    const { KokoroTTS } = await import("kokoro-js");
    return KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "cpu" });   // the smaller variants are slower or return unusable sound for some sentences
  })();
  ttsReady.catch(() => { ttsReady = null; });
  return ttsReady;
}
function loadStt() {
  if (!sttReady) sttReady = (async () => (await modelLibrary()).pipeline("automatic-speech-recognition", "Xenova/whisper-base.en", { dtype: "q8", device: "cpu" }))();
  sttReady.catch(() => { sttReady = null; });
  return sttReady;
}
/* Expressive voices. A speech model run by the AI engine writes the sound as numbered tokens, seven to each frame of sound,
   every place in a frame with its own range of codes. A small decoder shipped with the program turns the frames into samples.
   It needs a graphics card: without one the model writes sound many times slower than it plays. */
const EXPRESSIVE = {
  prefix: "expressive:", rate: 24000, frame: 7, codes: 4096, firstCode: 10,
  voices: [["tara", "Tara", "female"], ["leah", "Leah", "female"], ["jess", "Jess", "female"], ["mia", "Mia", "female"], ["zoe", "Zoe", "female"], ["leo", "Leo", "male"], ["dan", "Dan", "male"], ["zac", "Zac", "male"]],
  stream: { part: 6, beside: 2, samples: 2048 },       // sound is handed over six frames (half a second) at a time, decoded with two frames either side; a frame is 2048 samples
  tokensPerLetter: 10, spareTokens: 150,              // the most tokens a text may take: generous, so speech is never cut short
  sampling: { temperature: 0.6, top_p: 0.9, repeat_penalty: 1.1, num_ctx: 4096 }   // as the model's makers set them
};
let decoderReady = null;
function loadDecoder() {
  if (!decoderReady) decoderReady = require("onnxruntime-node").InferenceSession.create(path.join(RES, "speech-models", "onnx-community", "snac_24khz-ONNX", "onnx", "decoder_model.onnx"));
  decoderReady.catch(() => { decoderReady = null; });
  return decoderReady;
}
const SPEAK_MS = 10 * 60 * 1000;                        // how long a voice engine is given to make one piece of speech
/* The sound of some frames out of a run of codes. The decoder takes a frame as one coarse code, two middle and four fine. */
async function decodeFrames(codes, from, to) {
  const ort = require("onnxruntime-node"), decoder = await loadDecoder(), coarse = [], middle = [], fine = [];
  for (let at = from * EXPRESSIVE.frame; at < to * EXPRESSIVE.frame; at += EXPRESSIVE.frame) {
    const [a, b, c, d, e, f, g] = codes.slice(at, at + EXPRESSIVE.frame);
    coarse.push(a); middle.push(b, e); fine.push(c, d, f, g);
  }
  const layer = list => new ort.Tensor("int64", BigInt64Array.from(list, BigInt), [1, list.length]);
  const out = await decoder.run(Object.fromEntries(decoder.inputNames.map((name, i) => [name, layer([coarse, middle, fine][i])])));
  return out[decoder.outputNames[0]].data;
}
/* Speech in an expressive voice, handed over a part at a time while the model is still writing the rest. Each part is
   decoded together with the frames next to it, which is what makes the parts join without a click. */
async function* speakExpressive(text, voice, limitMs, stop) {
  const res = await engineCall("/api/generate", {
    model: loadSettings().models.expressive, raw: true, stream: true, prompt: `<|audio|>${voice}: ${text}<|eot_id|>`,
    options: { ...EXPRESSIVE.sampling, num_predict: text.length * EXPRESSIVE.tokensPerLetter + EXPRESSIVE.spareTokens }
  }, limitMs, stop);
  const codes = [], { part, beside, samples } = EXPRESSIVE.stream, frames = () => Math.floor(codes.length / EXPRESSIVE.frame);
  let written = "", sent = 0;                          // sent: how many frames have been handed over as sound
  const sound = async upTo => {
    const from = Math.max(0, sent - beside), decoded = await decodeFrames(codes, from, Math.min(frames(), upTo + beside));
    const clip = { samples: decoded.slice((sent - from) * samples, (upTo - from) * samples), rate: EXPRESSIVE.rate };
    sent = upTo;
    return clip;
  };
  for await (const line of jsonLines(res)) {
    written += line.response || "";
    const whole = written.lastIndexOf(">") + 1;        // a token cut in two by the way the reply arrives waits for its other half
    for (const [, id] of written.slice(0, whole).matchAll(/<custom_token_(\d+)>/g)) {
      const code = Number(id) - EXPRESSIVE.firstCode - (codes.length % EXPRESSIVE.frame) * EXPRESSIVE.codes;
      if (code >= 0 && code < EXPRESSIVE.codes) codes.push(code);        // anything else is a marker, not sound
    }
    written = written.slice(whole);
    while (frames() - sent >= part + beside) yield await sound(sent + part);
  }
  if (!frames()) throw new Error("The voice engine returned no sound.");
  if (frames() > sent) yield await sound(frames());
}
/* The described voice. A second speech engine, shipped with the program, makes a voice from a description of how it
   should sound. It does so once: one model designs a short sample from the description, and from then on a second
   model speaks every line in the voice of that sample, so the voice stays the same from line to line. The
   models are downloaded when the user asks for them. The engine holds one of them at a time. It runs on the graphics
   card when it finds one it can use, and on the processor otherwise. A model that did not start on the graphics card
   is started on the processor. */
const DESCRIBED = {
  id: "described", port: 11528,
  exe: path.join(RES, "voice-engine", process.platform === "win32" ? "galactic-dominion-voice.exe" : "tts-server"),
  folder: path.join(DATA, "voice-models"), samples: path.join(DATA, "voices"),
  source: "https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/resolve/main/",
  files: {
    design: { name: "qwen-talker-1.7b-voicedesign-Q4_K_M.gguf", size: 1182630816, sha256: "7605ed0cc5e72059f27468c27f70c070e05d1cc0c7b1c76bfb9cba717a59eee3" },   // makes a voice from a description
    // speaks in the voice of a sample. The larger of the two models that can: the engine's makers check this one, on
    // graphics cards as on the processor, and not the smaller, which on a graphics card made noise in place of speech
    speak: { name: "qwen-talker-1.7b-base-Q4_K_M.gguf", size: 1219245248, sha256: "ea393ebaf2167ea23ce9fc18b093822851358a950d7075cd47ab4f6ce23e887d" },
    sound: { name: "qwen-tokenizer-12hz-Q4_K_M.gguf", size: 254974752, sha256: "cf3788b4d50aaa665fb6e57c170396aae03a3555fea52d2b5d0cda902d658039" }             // turns what either writes into sound
  },
  language: "English", rate: 24000,
  frames: { second: 12.5, letter: 2.5, spare: 25 },    // the engine writes 12.5 frames of sound a second; a text is allowed 2.5 to the letter, three times what speech takes, and two seconds besides
  part: 24000,                                          // sound is handed over in parts of at least this many bytes: half a second
  sample: "Come and sit with me a while. I have been hoping we could talk, just the two of us.",   // what a new voice says in its sample
  seed: 1                                               // the same throw of the dice every time, unless a different voice is asked for
};
/* The most frames a text may take. Without it, a voice that misses the end of its line goes on for minutes. */
const describedLimit = text => Math.ceil(text.length * DESCRIBED.frames.letter) + DESCRIBED.frames.spare;
const describedFile = file => path.join(DESCRIBED.folder, file.name);
const describedInstalled = () => Object.values(DESCRIBED.files).every(file => fs.existsSync(describedFile(file)));
async function installDescribed() {
  fs.mkdirSync(DESCRIBED.folder, { recursive: true });
  const files = Object.values(DESCRIBED.files), total = files.reduce((sum, file) => sum + file.size, 0);
  let before = 0;
  for (const file of files) {
    const dest = describedFile(file), part = dest + ".part";
    if (!fs.existsSync(dest)) {
      try {
        const sum = await download(DESCRIBED.source + file.name, part, done => progress({ kind: "voice", phase: "Downloading", done: before + done, total }));
        if (sum !== file.sha256) throw new Error("The voice download was damaged. Please try again.");
        fs.renameSync(part, dest);                      // only a complete, checked file gets the name the program looks for
      } finally { fs.rmSync(part, { force: true }); }
    }
    before += file.size;
  }
  const wanted = files.map(file => file.name);          // a model an earlier version of the program used is not kept
  for (const name of fs.readdirSync(DESCRIBED.folder)) if (!wanted.includes(name)) fs.rmSync(path.join(DESCRIBED.folder, name), { force: true });
}
/* holds: the model the engine has, or is to be started with. onProcessor: the models that did not start on the graphics
   card, each of which is started on the processor from then on; the other is still tried on the card. runsOn: the
   engine's own name for what it loaded its model on, "CPU" for the processor. known: the voices the running engine has
   been given the samples of. */
const described = { holds: "speak", onProcessor: { design: false, speak: false }, runsOn: "", known: new Set() };
const voiceEngine = service("voice engine", DESCRIBED.exe, () => {
  if (!describedInstalled()) throw new Error("The described voice has not been downloaded yet.");
  described.runsOn = ""; described.known = new Set();
  const child = spawn(DESCRIBED.exe, ["--model", describedFile(DESCRIBED.files[described.holds]), "--codec", describedFile(DESCRIBED.files.sound), "--host", "127.0.0.1", "--port", String(DESCRIBED.port), "--lang", DESCRIBED.language, ...(described.onProcessor[described.holds] ? ["--device", "CPU"] : [])], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  return listen(child, line => { const on = /Talker backend: (\S+)/.exec(line); if (on) described.runsOn = on[1]; });   // as it loads, the engine names what it runs on
}, `http://127.0.0.1:${DESCRIBED.port}/health`, 360);    // longer than the AI engine: it answers only once its model is loaded
/* Everything asked of the voice engine takes its turn, one at a time: what one needs it to hold, another would take away.
   Resolves, when the turn has come, to what ends it. */
let voiceTurn = Promise.resolve();
function nextVoiceTurn() {
  const before = voiceTurn;
  let end;
  voiceTurn = new Promise(done => { end = done; });
  return before.then(() => end);
}
/* Has the engine running with the given model, on the processor if it did not start on the graphics card. For use
   within a turn. */
async function voiceEngineWith(model) {
  if (described.holds !== model) { voiceEngine.stop(); described.holds = model; }
  try { await voiceEngine.start(); }
  catch (e) {
    if (!e.exited || described.onProcessor[model] || !describedInstalled()) throw e;   // only an engine that ended by itself failed on the card: one that was slow to answer is tried again as it is
    described.onProcessor[model] = true;
    await voiceEngine.start();
  }
}
/* What the voice engine is asked: the reply, or its own account of what went wrong. */
async function askVoiceEngine(route, body, signal) {
  const res = await fetch(`http://127.0.0.1:${DESCRIBED.port}${route}`, { method: "POST", signal, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = ""; try { msg = (await res.json()).error.message || ""; } catch {}
    throw new Error(msg || "The voice engine returned an error (" + res.status + ").");
  }
  return res;
}
/* A voice made from a description is kept as its sample, under a name made from the voice's key: the description
   itself while the voice is only being tried, and the saved voice's own identity once it is saved. The same key is always
   the same voice. A voice is given here as its key with its description. */
const voiceName = key => "v" + crypto.createHash("sha256").update(key.trim()).digest("hex").slice(0, 24);
const sampleFile = key => path.join(DESCRIBED.samples, voiceName(key) + ".wav");
const byDescription = description => ({ key: description, description });   // a voice known by its description alone
const gettingReady = phase => progress({ kind: "voiceReady", phase });   // what is being done towards a described voice's first sound
/* Makes the voice, unless it has one. again: makes a different one in its place. */
async function designVoice({ key, description }, again, signal = AbortSignal.timeout(SPEAK_MS)) {
  const file = sampleFile(key), made = () => !again && fs.existsSync(file);
  if (made()) return;
  const end = await nextVoiceTurn();
  try {
    signal.throwIfAborted();                            // given up while it waited its turn
    if (made()) return;                                 // made while this was waiting its turn
    if (described.holds !== "design") gettingReady("Starting the voice engine");
    await voiceEngineWith("design");
    gettingReady("Making the voice");
    const res = await askVoiceEngine("/v1/audio/speech", { input: DESCRIBED.sample, instructions: description, response_format: "wav", max_new_tokens: describedLimit(DESCRIBED.sample), seed: again ? crypto.randomInt(2, 2 ** 31) : DESCRIBED.seed }, signal);
    keepSample(file, Buffer.from(await res.arrayBuffer()));
  } finally { end(); }
}
/* Keeps a voice's sample under its file name, in one step, so a sample cut short is never taken for the voice. */
function keepSample(file, sound) {
  fs.mkdirSync(DESCRIBED.samples, { recursive: true });
  fs.writeFileSync(file + ".part", sound);
  fs.renameSync(file + ".part", file);
}
/* Keeps a voice that was being tried, under the key of the saved voice it becomes. */
function saveVoice({ from, to }) {
  fs.renameSync(sampleFile(from), sampleFile(to));
}
const deleteVoice = key => fs.rmSync(sampleFile(key), { force: true });
/* A saved voice's sample as text that can go in a file, or "" when it has none. */
const voiceSample = key => fs.existsSync(sampleFile(key)) ? fs.readFileSync(sampleFile(key)).toString("base64") : "";
const MOST_SAMPLE = 10 * 1024 * 1024;                   // the largest sample a file may bring: a few seconds of speech is well under a megabyte
/* Keeps a voice's sample that came in a file, as the sample of the saved voice with the given key. */
function importVoice({ key, sample }) {
  const sound = Buffer.from(String(sample), "base64");
  if (sound.length > MOST_SAMPLE || !samplesLikeOurs(sound)) throw new Error("The voice in this file is not a sound the program can use.");
  keepSample(sampleFile(key), sound);
}
/* Whether a sound is in the form the engine makes its samples in, and so takes back: one channel of 16-bit samples, at
   the engine's own rate, with sound in it. */
function samplesLikeOurs(sound) {
  if (sound.toString("latin1", 0, 4) !== "RIFF" || sound.toString("latin1", 8, 12) !== "WAVE") return false;
  let form = null, data = 0;
  for (let at = 12; at + 8 <= sound.length;) {
    const id = sound.toString("latin1", at, at + 4), size = sound.readUInt32LE(at + 4);
    if (id === "fmt " && size >= 16 && at + 24 <= sound.length) form = { kind: sound.readUInt16LE(at + 8), channels: sound.readUInt16LE(at + 10), rate: sound.readUInt32LE(at + 12), bits: sound.readUInt16LE(at + 22) };
    if (id === "data") data = Math.min(size, sound.length - at - 8);
    at += 8 + size + size % 2;
  }
  return !!form && form.kind === 1 && form.channels === 1 && form.bits === 16 && form.rate === DESCRIBED.rate && data > 0;
}
/* Removes the samples of voices that are no longer among the given keys. */
function keepVoices(keys) {
  const wanted = new Set(keys.map(key => path.basename(sampleFile(key))));
  if (fs.existsSync(DESCRIBED.samples)) for (const name of fs.readdirSync(DESCRIBED.samples)) if (!wanted.has(name)) fs.rmSync(path.join(DESCRIBED.samples, name), { force: true });
}
/* Has the engine ready to speak in a voice: running with the model that speaks, and given the voice's sample. For use
   within a turn. */
async function voiceReady({ key }, signal = AbortSignal.timeout(SPEAK_MS)) {
  const name = voiceName(key);
  if (described.holds !== "speak" || !described.known.has(name)) gettingReady("Loading the voice");
  await voiceEngineWith("speak");
  if (described.known.has(name)) return name;
  await askVoiceEngine("/v1/audio/voices", { name, ref_text: DESCRIBED.sample, wav_b64: fs.readFileSync(sampleFile(key)).toString("base64") }, signal);
  described.known.add(name);
  return name;
}
/* Speech in a described voice, handed over a part at a time while the engine is still making the rest. The engine
   sends the samples as 16-bit numbers as soon as it has them. */
async function* speakDescribed(text, voice, limitMs, stop) {
  const signal = within(limitMs, stop);                 // covers getting the voice ready as well as speaking
  await designVoice(voice, false, signal);
  const end = await nextVoiceTurn();
  try {
    signal.throwIfAborted();
    const res = await askVoiceEngine("/v1/audio/speech", { input: text, voice: await voiceReady(voice, signal), response_format: "pcm", max_new_tokens: describedLimit(text), seed: DESCRIBED.seed }, signal);
    const clip = bytes => { const samples = new Float32Array(bytes.length >> 1); for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768; return { samples, rate: DESCRIBED.rate }; };
    let held = Buffer.alloc(0), any = false;
    for await (const bytes of res.body) {
      held = Buffer.concat([held, bytes]);
      if (held.length < DESCRIBED.part) continue;
      const whole = held.length - held.length % 2;      // half a sample waits for its other half
      yield clip(held.subarray(0, whole)); any = true;
      held = held.subarray(whole);
    }
    if (held.length >= 2) { yield clip(held); any = true; }
    if (!any) throw new Error("The voice engine returned no sound.");
  } finally { end(); }
}
const GRADES = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F+", "F"];
/* Every voice, with what it needs beyond the program itself: "gpu" for a graphics card, "mood" for a description of how
   it should sound. A voice made from a description has no gender of its own. */
async function voices() {
  const tts = await loadTts();
  const rank = v => { const i = GRADES.indexOf(v.overallGrade); return i < 0 ? GRADES.length : i; };
  return Object.entries(tts.voices).filter(([id]) => /^[ab][fm]_/.test(id)).sort((a, b) => rank(a[1]) - rank(b[1]))   // best-rated voices first
    .map(([id, v]) => ({ id, name: v.name, accent: id[0] === "a" ? "American" : "British", gender: id[1] === "f" ? "female" : "male", needs: [] }))
    .concat(EXPRESSIVE.voices.map(([id, name, gender]) => ({ id: EXPRESSIVE.prefix + id, name, accent: "expressive", gender, needs: ["gpu"] })))
    .concat({ id: DESCRIBED.id, name: "New voice from a description", accent: "", gender: "", needs: ["mood"] });
}
async function transcribe(samples) {                    // samples: 16 kHz mono
  const stt = await loadStt();
  const out = await stt(Float32Array.from(samples), { chunk_length_s: 30 });
  return (out.text || "").replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim();
}
async function* speakStandard(text, voice) {
  const audio = await (await loadTts()).generate(text, { voice });
  yield { samples: audio.audio, rate: audio.sampling_rate };
}
/* Speech in any voice, as parts of sound in the order they are heard. A standard voice makes one part; the others hand
   over each part as soon as it is made. made: for a described voice, which voice it is, by its key and description.
   stop: cuts the making short. */
async function* speak(text, voice, made, limitMs = SPEAK_MS, stop) {
  const parts = voice === DESCRIBED.id ? speakDescribed(text, made, limitMs, stop)
    : voice.startsWith(EXPRESSIVE.prefix) ? speakExpressive(text, voice.slice(EXPRESSIVE.prefix.length), limitMs, stop)
    : speakStandard(text, voice);
  for await (const part of parts) {
    if (part.samples.some(Number.isNaN)) throw new Error("The voice engine returned unusable sound.");
    yield part;
  }
}
/* A whole piece of speech in one, with how long its first sound took to come. */
async function spoken(text, voice, made, limitMs) {
  const began = Date.now(), parts = [];
  let first = 0;
  for await (const part of speak(text, voice, made, limitMs)) { first ||= (Date.now() - began) / 1000; parts.push(part); }
  const samples = new Float32Array(parts.reduce((sum, part) => sum + part.samples.length, 0));
  let at = 0;
  for (const part of parts) { samples.set(part.samples, at); at += part.samples.length; }
  return { samples, rate: parts[0].rate, first };
}
/* Loads what a scene is about to use, so that its first line does not wait for it: the model, the engines behind the
   voices, and the given voices made from descriptions. Nothing is reported from here: whatever cannot be loaded says so when it is used. */
async function warm({ model, context, voices, made }) {
  await loadModel(model, context).catch(() => {});
  await Promise.all(Object.keys(SAFETY_MODELS).map(kind => loadSafety(kind).catch(() => {})));
  if (voices.some(voice => voice.startsWith(EXPRESSIVE.prefix))) await loadModel(loadSettings().models.expressive, EXPRESSIVE.sampling.num_ctx).catch(() => {});
  for (const voice of made) await designVoice(voice).catch(() => {});
  if (made.length) await nextVoiceTurn().then(async end => { try { for (const voice of made) await voiceReady(voice); } catch {} finally { end(); } });
}

/* ---------- the safety check ---------- */
/* Two small classifiers shipped with the program, run on the processor: one judges what the user writes for signs that
   they are thinking of suicide or self-harm, the other judges a character's line for encouraging or enabling it (made
   by scripts/make-safety-models.py). Each reads at most 512 tokens, so a long text is judged a part at a time. */
const SAFETY_MODELS = { user: path.join(RES, "safety-models", "user"), character: path.join(RES, "safety-models", "character") };
const UNSAFE_AT = 0.5;                                  // how sure a classifier must be that a text is unsafe
const SAFETY_PART = 1200;                               // characters judged at once: well within what a classifier reads
const safetyReady = {};
function loadSafety(kind) {
  if (!safetyReady[kind]) safetyReady[kind] = (async () => {
    const lib = await modelLibrary();
    return { tokenizer: await lib.AutoTokenizer.from_pretrained(SAFETY_MODELS[kind]), model: await lib.AutoModelForSequenceClassification.from_pretrained(SAFETY_MODELS[kind], { dtype: "q8", device: "cpu" }) };
  })();
  safetyReady[kind].catch(() => { delete safetyReady[kind]; });
  return safetyReady[kind];
}
/* A text in parts of at most SAFETY_PART characters, broken between sentences where it can be. */
function safetyParts(text) {
  const parts = [];
  let part = "";
  for (const sentence of String(text).match(/[^.!?\n]+[.!?]*\s*|\n+/g) || []) {
    for (let piece = sentence; piece; piece = piece.slice(SAFETY_PART)) {
      if (part.length + Math.min(piece.length, SAFETY_PART) > SAFETY_PART) { parts.push(part); part = ""; }
      part += piece.slice(0, SAFETY_PART);
    }
  }
  return [...parts, part].filter(p => p.trim());
}
/* How sure a classifier is that a text is unsafe, from 0 to 1: its one score, or its share for the label "suicide". */
function unsafeShare(logits, labels) {
  if (logits.length === 1) return 1 / (1 + Math.exp(-logits[0]));
  const most = Math.max(...logits), shares = logits.map(x => Math.exp(x - most)), sum = shares.reduce((a, b) => a + b, 0);
  return shares[Number(Object.keys(labels).find(i => String(labels[i]).toLowerCase() === "suicide"))] / sum;
}
/* Whether a message ({ fromUser, text }) shows signs of suicide or self-harm: for one from the user, that they may be
   thinking of it; for a character's, that it encourages or enables it. */
async function checkSafety({ fromUser, text }) {
  const { tokenizer, model } = await loadSafety(fromUser ? "user" : "character");
  for (const part of safetyParts(text)) {
    const { logits } = await model(await tokenizer(part, { truncation: true, max_length: 512 }));
    if (unsafeShare(Array.from(logits.data), model.config.id2label) >= UNSAFE_AT) return true;
  }
  return false;
}

/* ---------- what this computer can run ---------- */
const ADAPTERS = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";   // where Windows keeps its graphics adapters
/* One value of every graphics adapter, by the adapter's place in the registry. Empty when the registry cannot be read. */
function adapterValues(name) {
  return new Promise(resolve => execFile("reg", ["query", ADAPTERS, "/s", "/v", name], { windowsHide: true }, (_error, out) => {
    const found = {};
    let adapter = "";
    for (const line of String(out).split(/\r?\n/)) {
      const value = /^\s+\S+\s+REG_\w+\s+(.+)$/.exec(line);
      if (line.startsWith("HKEY")) adapter = line.trim();
      else if (value && adapter) found[adapter] = value[1].trim();
    }
    resolve(found);
  }));
}
/* A size as the registry prints it: a number, or eight bytes with the smallest first. */
const registrySize = text => /^0x/i.test(text) ? Number(text) : /^[0-9a-f]{16}$/i.test(text) ? Number(BigInt("0x" + text.match(/../g).reverse().join(""))) : 0;
/* The graphics cards with memory of their own, the largest first. */
async function graphicsCards() {
  if (process.platform !== "win32") return [];
  const [names, sizes] = await Promise.all(["DriverDesc", "HardwareInformation.qwMemorySize"].map(adapterValues));
  return Object.keys(names).map(adapter => ({ name: names[adapter], memory: registrySize(sizes[adapter] || "") })).filter(card => card.memory).sort((a, b) => b.memory - a.memory);
}
const TRIAL = { line: "She smiles, and asks what kind of music you like.", description: "A warm, clear voice at an easy pace.", limitMs: 60 * 1000, story: "Tell a short story about a lighthouse.", tokens: 80 };
/* How a kind of voice does on this computer, once it is loaded: how much speech it made, how long that took, and how
   long it was before the first of it could be heard. */
async function trial(voice, installed) {
  if (!installed) return { state: "missing" };
  try {
    await spoken("Hello.", voice, byDescription(TRIAL.description), TRIAL.limitMs);    // the first use also loads the voice
    const began = Date.now(), clip = await spoken(TRIAL.line, voice, byDescription(TRIAL.description), TRIAL.limitMs);
    const speech = clip.samples.length / clip.rate;
    // ranOn: a described voice that only stopped at the most its line was allowed, so not where the line ended
    return { state: "timed", speech, took: (Date.now() - began) / 1000, first: clip.first, ranOn: voice === DESCRIBED.id && speech > (describedLimit(TRIAL.line) - 1) / DESCRIBED.frames.second };
  } catch (e) { return e.name === "TimeoutError" ? { state: "slow" } : { state: "failed", why: String(e && e.message || e) }; }
}
/* How the model for roleplays does on this computer: how fast it writes once it is loaded, and how much of it is on the
   graphics card. */
async function modelTrial(model, context) {
  if (!model) return { state: "missing" };
  try {
    await loadModel(model, context);
    const out = await (await engineCall("/api/chat", { model, stream: false, think: false, messages: [{ role: "user", content: TRIAL.story }], options: { num_ctx: context, num_predict: TRIAL.tokens } }, LOAD_MS)).json();
    return { state: "timed", name: model, tokensPerSecond: out.eval_count / (out.eval_duration / 1e9), onCard: await onCard(model) };
  } catch (e) { return { state: "failed", why: String(e && e.message || e) }; }
}
/* The computer's memory, processor and graphics cards, then a trial of the given model and of each kind of voice, one
   at a time. The model comes first and stays loaded, so the voices are tried beside it, as they are in a roleplay. */
async function checkComputer({ model, context }) {
  const expressiveModel = loadSettings().models.expressive, expressive = engineInstalled() && hasModel(await installedModels(), expressiveModel);
  const tried = await modelTrial(model, context), voices = {};
  for (const [kind, voice, installed] of [["standard", "af_heart", true], ["gpu", EXPRESSIVE.prefix + EXPRESSIVE.voices[0][0], expressive], ["mood", DESCRIBED.id, describedInstalled()]]) voices[kind] = await trial(voice, installed);
  if (voices.gpu.state === "timed") voices.gpu.onCard = await onCard(expressiveModel);
  return { memory: os.totalmem(), cores: os.cpus().length, cards: await graphicsCards(), engineUsesCard: engineUsesCard(), model: tried, voices, describedOnCard: !!described.runsOn && described.runsOn !== "CPU" };
}

/* ---------- window and messages from the interface ---------- */
const handle = (name, fn) => ipcMain.handle(name, async (_e, arg) => {
  try { return { ok: true, value: await fn(arg) }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
handle("settings:get", () => loadSettings());
handle("settings:save", cfg => saveSettings(cfg));
handle("engine:status", async () => ({ installed: engineInstalled(), models: engineInstalled() ? await installedModels() : [], described: describedInstalled() }));
handle("engine:install", () => setUpEngine());
handle("model:pull", name => pullModel(name));
handle("model:context", name => modelContext(name));
handle("model:thinks", name => modelThinks(name));
handle("chat", req => chat(req));
handle("chat:stream", req => chatStream(req));
handle("safety:check", message => checkSafety(message));
handle("system:country", () => app.getLocaleCountryCode());
ipcMain.on("chat:stop", () => { if (chatRequest) chatRequest.abort(); });
handle("tts:voices", () => voices());
handle("tts:install", () => installDescribed());
handle("voice:design", ({ voice, again }) => designVoice(voice, again));
handle("voice:save", names => saveVoice(names));
handle("voice:delete", key => deleteVoice(key));
handle("voice:keep", keys => keepVoices(keys));
handle("voice:sample", key => voiceSample(key));
handle("voice:import", voice => importVoice(voice));

/* Characters and roleplays saved to a file of the user's choosing, and read back from one. */
const FILE_KIND = [{ name: "Galactic Dominion file", extensions: ["json"] }];
const MOST_FILE = 50 * 1024 * 1024;                     // larger than any character or roleplay with its pictures and voices
handle("file:save", async ({ name, text }) => {
  const picked = await dialog.showSaveDialog(win, { title: "Download", defaultPath: path.join(app.getPath("documents"), name), filters: FILE_KIND });
  if (picked.canceled || !picked.filePath) return false;
  fs.writeFileSync(picked.filePath, text);
  return true;
});
handle("file:open", async () => {
  const picked = await dialog.showOpenDialog(win, { title: "Upload", properties: ["openFile"], filters: FILE_KIND });
  if (picked.canceled || !picked.filePaths.length) return null;
  if (fs.statSync(picked.filePaths[0]).size > MOST_FILE) throw new Error("This file is too large to be a character or a roleplay.");
  return fs.readFileSync(picked.filePaths[0], "utf8");
});
/* Speech for the interface goes to it a part at a time, each marked with the number of the request it belongs to. */
const speaking = new Set();                             // what cuts off each request for speech that is still being made
handle("tts:speak", async ({ id, text, voice, made }) => {
  const stop = new AbortController();
  speaking.add(stop);
  try { for await (const part of speak(text, voice, made, SPEAK_MS, stop.signal)) send("tts:sound", { id, ...part }); }
  finally { speaking.delete(stop); }
});
ipcMain.on("tts:stop", () => { for (const stop of speaking) stop.abort(); });
handle("stt:transcribe", samples => transcribe(samples));
handle("system:check", request => checkComputer(request));
handle("warm", request => warm(request));
handle("game:host", request => hostGame(request || {}));
handle("game:settings", () => loadGameSettings());
handle("game:model", model => chooseGameModel(model));

/* A record of every request made to the model, one file per roleplay, for the admin page. */
const LOGS = path.join(DATA, "logs");
const logFile = id => path.join(LOGS, String(id).replace(/[^\w-]/g, "") + ".jsonl");
handle("log:add", ({ id, entry }) => { fs.mkdirSync(LOGS, { recursive: true }); fs.appendFileSync(logFile(id), JSON.stringify(entry) + "\n"); });
/* A line cut short when the program was closed is left out. */
const logLine = line => { try { return [JSON.parse(line)]; } catch { return []; } };
handle("log:read", id => fs.existsSync(logFile(id)) ? fs.readFileSync(logFile(id), "utf8").split("\n").filter(Boolean).flatMap(logLine) : []);
handle("log:delete", id => fs.rmSync(id ? logFile(id) : LOGS, { recursive: true, force: true }));

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 360, minHeight: 560, backgroundColor: "#0B0D12", title: "Galactic Dominion",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, "renderer", "game.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

async function selfTest() {
  const result = { ok: false, steps: [] };
  const step = async (name, fn) => { const t = Date.now(); const value = await fn(); result.steps.push({ name, seconds: Math.round((Date.now() - t) / 1000), value }); return value; };
  try {
    const model = process.env.ROLEPLAYER_SELFTEST_MODEL || "huihui_ai/qwen3-abliterated:0.6b";
    await step("settings", async () => Object.keys(loadSettings()).join(","));
    await step("engine set up, with its models", async () => { await setUpEngine(); const have = await installedModels(); return engineInstalled() && builtIn.ENGINE_MODELS.every(model => hasModel(have, model)); });
    await step("model download", async () => { await pullModel(model); return hasModel(await installedModels(), model); });
    await step("chat", () => chat({ model, temperature: 0.5, messages: [{ role: "user", content: "Say hello in one short sentence." }] }));
    await step("streamed chat", () => chatStream({ model, temperature: 0.5, messages: [{ role: "user", content: "Say goodbye in one short sentence." }] }));
    await step("safety check", async () => {
      const judged = { user: await checkSafety({ fromUser: true, text: "I want to kill myself." }), userPasses: !await checkSafety({ fromUser: true, text: "Hello, what is on the menu tonight?" }),
        character: await checkSafety({ fromUser: false, text: "Cut deeper, it will make the pain go away." }), characterPasses: !await checkSafety({ fromUser: false, text: "Sit by the fire, I'll bring you some stew." }) };
      if (!Object.values(judged).every(Boolean)) throw new Error("the safety check judged wrongly: " + JSON.stringify(judged));
      return true;
    });
    await spoken("Hello.", "af_heart");                  // the first use is slower while the voice loads
    const started = Date.now();
    const said = await step("voice", () => spoken("Hello, it is lovely to meet you.", "af_heart"));
    const seconds = said.samples.length / said.rate;
    result.steps[result.steps.length - 1].value = `${seconds.toFixed(1)} s of speech made in ${((Date.now() - started) / 1000).toFixed(1)} s`;
    await step("every voice", async () => {
      const failed = [];
      for (const v of (await voices()).filter(v => !v.needs.length)) { try { await spoken("She smiles, and asks what kind of music you like.", v.id); } catch { failed.push(v.id); } }
      if (failed.length) throw new Error("These voices returned unusable sound: " + failed.join(", "));
      return "all voices produced sound";
    });
    const heard = clip => {                               // read a voice sample back, resampled to the 16 kHz the recogniser expects
      const pcm = new Float32Array(Math.floor(clip.samples.length * 16000 / clip.rate));
      for (let i = 0; i < pcm.length; i++) pcm[i] = clip.samples[Math.floor(i * clip.rate / 16000)];
      return transcribe(pcm);
    };
    await step("speech recognition", () => heard(said));
    await step("expressive voice", async () => {
      await pullModel(loadSettings().models.expressive);
      const words = await heard(await spoken("Hello there.", EXPRESSIVE.prefix + EXPRESSIVE.voices[0][0]));
      if (!/hello/i.test(words)) throw new Error("The expressive voice was heard as: " + words);
      return words;
    });
    await step("described voice", async () => {
      await installDescribed();
      const description = "A warm, low woman's voice, speaking slowly.", began = Date.now();
      await designVoice(byDescription(description));
      const designing = ((Date.now() - began) / 1000).toFixed(1), sample = fs.readFileSync(sampleFile(description));
      const timed = async text => {
        const began = Date.now(), clip = await spoken(text, DESCRIBED.id, byDescription(description));
        return { clip, took: `${(clip.samples.length / clip.rate).toFixed(1)} s of speech made in ${((Date.now() - began) / 1000).toFixed(1)} s, the first of it after ${clip.first.toFixed(1)} s` };
      };
      const first = await timed("Hello there, it is lovely to meet you."), second = await timed("She smiles, and asks what kind of music you like.");
      const on = described.runsOn || "something the engine did not name", words = await heard(first.clip);
      if (!/hello/i.test(words) || /sit with me/i.test(words)) throw new Error("The described voice was heard as: " + words);   // the second: the words of the voice's own sample
      await designVoice(byDescription(description), true);
      if (sample.equals(fs.readFileSync(sampleFile(description)))) throw new Error("Asking for a different voice gave the same one.");
      saveVoice({ from: description, to: "saved:self-test" });
      const kept = await heard(await spoken("Hello again.", DESCRIBED.id, { key: "saved:self-test", description }));
      if (!/hello/i.test(kept) || fs.existsSync(sampleFile(description))) throw new Error("A saved voice did not speak, or its try-out was left behind: " + kept);
      deleteVoice("saved:self-test");
      return `voice designed in ${designing} s with the engine starting; ${first.took} with the engine changing model, then ${second.took}; running on ${on}; heard as: ${words}`;
    });
    await step("computer check", async () => {
      const found = await checkComputer({ model, context: 4096 });
      if (found.model.state !== "timed") throw new Error("The check could not try the model: " + JSON.stringify(found));
      for (const kind of ["standard", "gpu", "mood"]) if (!["timed", "slow"].includes(found.voices[kind].state)) throw new Error("The check could not try the voices: " + JSON.stringify(found));
      return JSON.stringify(found);
    });
    result.ok = result.steps.every(s => s.value);
  } catch (e) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(SELFTEST, JSON.stringify(result, null, 2));
  app.quit();
}

/* One copy of the program at a time: a second would start a second engine on the same port. */
const onlyCopy = app.requestSingleInstanceLock();
if (!onlyCopy) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  if (!onlyCopy) return;
  if (SELFTEST) return selfTest();
  loadGameSettings();
  createWindow();
  if (engineInstalled()) aiEngine.start().catch(() => {});
  spoken("Hello.", "af_heart").catch(() => {});         // load the voice now, so the first line of a scene is not delayed
});
app.on("window-all-closed", () => app.quit());
app.on("quit", () => { aiEngine.stop(); voiceEngine.stop(); if (gameServer) gameServer.server.close(); });
