"use strict";
/* Galactic Dominion: speech out and speech in, both made on this PC.
   Out: every spoken line comes from the server as text and a local voice id. Its sentences are turned into sound by the
   app's voices (window.api.speak, the tts:speak IPC), a sentence at a time while the line is still arriving, and the
   parts are played back to back with Web Audio, as the roleplay interface does. One line is heard after another, in
   the order they were queued.
   In: push to talk. While the button or the space bar is held the microphone records; on release what was recorded is
   turned into 16 kHz samples and read by the app's speech recognition (window.api.transcribe, the stt:transcribe IPC). */
(function () {
  const GD = window.GD;
  const api = () => window.api || {};

  /* How much of an unfinished line can already be spoken: up to its last complete sentence. */
  function speakableEnd(text, from) {
    const boundary = /[.!?…]+["'”’)\]]*\s+/g;
    let end = from;
    boundary.lastIndex = from;
    for (let m; (m = boundary.exec(text));) end = m.index + m[0].length;
    return end;
  }

  let ctx = null, gain = null, nextStart = 0, playing = [], gen = 0, queue = [], working = false, held = false;
  const listeners = [];
  const Speech = GD.Speech = {
    volume: 1,
    on: fn => listeners.push(fn),
    /* Whether the game is speaking: a line waiting, being made or still being heard. */
    speaking: () => queue.length > 0 || working || (ctx && ctx.currentTime < nextStart - 0.02),
    available: () => typeof api().speak === "function"
  };
  const changed = () => listeners.forEach(fn => { try { fn(); } catch {} });

  function audio() {
    if (!ctx) {
      ctx = new AudioContext();
      gain = ctx.createGain(); gain.gain.value = Speech.volume; gain.connect(ctx.destination);
    }
    if (ctx.state === "suspended" && !held) ctx.resume().catch(() => {});
    return ctx;
  }
  /* Plays a part of speech straight after the part before it, with no gap. */
  function play(samples, rate) {
    const c = audio(), buffer = c.createBuffer(1, samples.length, rate), source = c.createBufferSource();
    buffer.copyToChannel(samples instanceof Float32Array ? samples : Float32Array.from(samples), 0);
    source.buffer = buffer; source.connect(gain);
    const at = Math.max(c.currentTime + 0.05, nextStart);
    nextStart = at + buffer.duration;
    source.start(at); playing.push(source);
    source.onended = () => { playing = playing.filter(s => s !== source); if (!playing.length) changed(); };
    // A computer with no sound device never reports the end: the queue is told when the sound should have finished.
    setTimeout(changed, (nextStart - c.currentTime) * 1000 + 300);
  }

  /* A line to be spoken. add(textSoFar) while it arrives; finish(text) when it is complete; cancel() withdraws it. */
  Speech.line = (voice, made) => {
    const item = { voice, made: made || null, text: "", used: 0, pieces: [], complete: false, dead: false, gen };
    item.add = text => {
      if (item.dead) return;
      item.text = text;
      const end = speakableEnd(text, item.used);
      if (end > item.used) { item.pieces.push(text.slice(item.used, end).trim()); item.used = end; }
      pump();
    };
    item.finish = text => {
      if (item.dead) return;
      item.text = text == null ? item.text : text;
      if (item.text.length > item.used) item.pieces.push(item.text.slice(item.used).trim());
      item.used = item.text.length; item.complete = true;
      pump();
    };
    item.cancel = () => { item.dead = true; const i = queue.indexOf(item); if (i > 0) queue.splice(i, 1); else if (i === 0) item.complete = true; changed(); };
    if (!voice || !Speech.available()) { item.dead = true; return item; }
    queue.push(item); changed();
    return item;
  };
  Speech.say = (text, voice, made) => { const it = Speech.line(voice, made); it.finish(text); return it; };

  /* The queue is worked through one piece at a time: making sound is sequential, playing it is scheduled ahead. */
  async function pump() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const item = queue[0], mine = gen;
        if (item.dead || item.gen !== gen) { queue.shift(); continue; }
        if (!item.pieces.length) {
          if (item.complete) { queue.shift(); continue; }
          break;                                         // the rest of this line has not arrived yet
        }
        const piece = item.pieces.shift();
        if (!/[\p{L}\p{N}]/u.test(piece)) continue;
        try {
          await api().speak({ text: piece, voice: item.voice, made: item.made }, part => {
            if (mine === gen && !item.dead && part && part.samples) play(part.samples, part.rate);
          });
        } catch (e) { if (window.console) console.warn("Speech could not be made: " + e.message); }
        if (mine !== gen) break;
      }
    } finally { working = false; changed(); }
  }

  /* Everything stops at once: the line being made, what is waiting and what is being heard. */
  Speech.stop = () => {
    gen++;
    queue.forEach(it => { it.dead = true; }); queue = [];
    if (api().stopSpeaking) { try { api().stopSpeaking(); } catch {} }
    playing.forEach(s => { try { s.stop(); } catch {} }); playing = [];
    nextStart = 0;
    changed();
  };
  /* Pausing the game pauses speech mid-line; resuming carries on from there. */
  Speech.hold = on => {
    held = !!on;
    if (!ctx) return;
    if (held && ctx.state === "running") ctx.suspend().catch(() => {});
    else if (!held && ctx.state === "suspended") ctx.resume().catch(() => {});
  };
  Speech.setVolume = v => { Speech.volume = v; if (gain) gain.gain.value = v; };
  /* The first touch or key lets the page make sound (Chromium starts audio suspended until then). */
  const unlock = () => { audio(); document.removeEventListener("pointerdown", unlock, true); document.removeEventListener("keydown", unlock, true); };
  document.addEventListener("pointerdown", unlock, true); document.addEventListener("keydown", unlock, true);

  /* ---------- speech in: push to talk ---------- */
  let rec = null, stream = null, press = 0;
  const Mic = GD.Mic = { state: "idle", available: () => typeof api().transcribe === "function" && !!(navigator.mediaDevices && window.MediaRecorder) };
  const setState = s => { Mic.state = s; changed(); };
  /* Recording lasts for as long as the button or the space bar is held. onText(text) gets what was heard ("" for nothing). */
  Mic.hold = async onText => {
    if (rec || Mic.state === "recording") return;
    const mine = ++press;
    setState("recording");
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { setState("idle"); GD.toast("No microphone was found, or access to it was not allowed."); return; }
    if (mine !== press) { stream.getTracks().forEach(t => t.stop()); stream = null; return; }   // let go before the microphone was ready
    const chunks = [], s = stream;
    rec = new MediaRecorder(s);
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = async () => {
      rec = null; s.getTracks().forEach(t => t.stop());
      setState("working");
      let text = "";
      try {
        const c = new AudioContext({ sampleRate: 16000 });
        const pcm = (await c.decodeAudioData(await new Blob(chunks).arrayBuffer())).getChannelData(0);
        c.close();
        const loud = Math.sqrt(pcm.reduce((sum, v) => sum + v * v, 0) / (pcm.length || 1)) > 0.005;   // skip silence: the recogniser invents words for it
        if (loud) text = await api().transcribe(pcm);
      } catch (e) { GD.toast("Your speech could not be understood. " + e.message); }
      setState("idle");
      onText(String(text || "").trim());
    };
    rec.start();
  };
  Mic.release = () => { press++; if (rec && rec.state === "recording") rec.stop(); else if (Mic.state === "recording") setState("idle"); };
})();
