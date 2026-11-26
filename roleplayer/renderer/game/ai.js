"use strict";
/* Galactic Dominion: the AI engine and the model the game runs on, set up on the host's PC. The engine and the models
   are the app's own (main.js): the engine is downloaded once, then the host downloads a model and chooses it. Only the
   PC that hosts needs them: a captain who joins another PC's game plays on the host's AI. */
(function () {
  const GD = window.GD, esc = GD.esc, $ = GD.$, $$ = GD.$$;
  const api = () => window.api || {};
  const SIZES = [["small", "Small", "For most PCs. Runs on the processor, faster with a graphics card."], ["medium", "Medium", "Better storytelling. Wants a graphics card with 8 GB."], ["large", "Large", "The best. Wants a graphics card with 16 GB or more."]];

  const state = { status: null, settings: null, chosen: "", busy: "", progress: null, error: "" };
  let listening = false;
  const present = () => !!(api().engineStatus && api().getSettings && api().gameSettings);
  const has = name => !!state.status && state.status.models.some(m => [name, name + ":latest"].map(n => n.toLowerCase()).includes(m.toLowerCase()));

  GD.ai = {
    /* Whether this PC can run a game: always, outside the app (the test page), or once a downloaded model is chosen. */
    ready: () => !present() || (!!state.status && state.status.installed && !!state.chosen && has(state.chosen)),
    panel: ix => GD.panel(ix, "AI engine", `<div id="ai-box"><p class="note">Checking the AI engine…</p></div>`),
    /* Fills the panel and keeps it up to date while the start screen is shown. */
    mount: () => {
      if (!present()) { const box = $("#ai-box"); if (box) box.innerHTML = `<p class="note">The AI engine is set up in the app.</p>`; return; }
      if (!listening && api().onProgress) { listening = true; api().onProgress(info => { state.progress = info; draw(); }); }
      refresh();
    }
  };

  function refresh() {
    Promise.all([api().engineStatus(), state.settings ? state.settings : api().getSettings(), api().gameSettings()])
      .then(([status, settings, game]) => { state.status = status; state.settings = settings; state.chosen = game.model || ""; draw(); })
      .catch(e => { state.error = e.message; draw(); });
  }
  const percent = p => p && p.total ? Math.min(100, Math.round(p.done / p.total * 100)) : 0;
  const sizeText = n => n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.round(n / 1e6) + " MB";

  function draw() {
    const box = $("#ai-box");
    if (!box) return;
    const s = state.status, p = state.progress;
    const bar = state.busy && p ? `<div style="padding:8px 0 4px"><div class="sub">${esc(p.phase || "Working")}${p.model ? " " + esc(p.model) : ""}${p.total ? " · " + sizeText(p.done) + " of " + sizeText(p.total) : ""}</div><div class="bar" style="margin-top:6px"><i style="width:${percent(p)}%"></i></div></div>` : "";
    const err = state.error ? `<p class="err">${esc(state.error)}</p>` : "";
    if (!s) { box.innerHTML = `<p class="note">Checking the AI engine…</p>${err}`; return; }
    if (!s.installed) {
      box.innerHTML = `<p class="note">The game's AI runs on this PC. Its engine is downloaded once (about 1.5 GB) and works offline from then on.</p>${bar}<div class="btns" style="padding-top:10px"><button class="btn btn-hot" type="button" id="ai-install"${state.busy ? " disabled" : ""}>${state.busy ? "Setting up…" : "Set up the AI engine"}</button></div>${err}`;
      $("#ai-install").addEventListener("click", () => run("engine", () => api().installEngine()));
      return;
    }
    const models = state.settings && state.settings.models || {};
    const groups = SIZES.map(([key, label, note]) => {
      const list = Array.isArray(models[key]) ? models[key] : [];
      if (!list.length) return "";
      return `<div class="subh" style="padding-top:10px">${esc(label)}</div><p class="sub" style="padding-bottom:4px">${esc(note)}</p>` + list.map(m => {
        const here = has(m.name), on = state.chosen === m.name;
        const act = on ? `<span class="tag good">In use</span>`
          : here ? `<button class="btn small" type="button" data-use="${esc(m.name)}"${state.busy ? " disabled" : ""}>Use</button>`
          : `<button class="btn small" type="button" data-get="${esc(m.name)}"${state.busy ? " disabled" : ""}>Download</button>`;
        return `<div class="row"><span><b>${esc(m.name.replace(/^hf\.co\/[^/]+\//, ""))}</b><br><span class="sub">${esc(m.note || "")}${here && !on ? " · downloaded" : ""}</span></span>${act}</div>`;
      }).join("");
    }).join("");
    const head = state.chosen && has(state.chosen)
      ? `<p class="note">The game runs on <b>${esc(state.chosen.replace(/^hf\.co\/[^/]+\//, ""))}</b>.</p>`
      : `<p class="note">Download a model and choose it to host a game. The larger the model, the better the story and the more of the rules it keeps to.</p>`;
    box.innerHTML = head + bar + groups + err;
    $$("[data-get]", box).forEach(b => b.addEventListener("click", () => run("model", () => api().pullModel(b.dataset.get).then(() => api().chooseGameModel(b.dataset.get)))));
    $$("[data-use]", box).forEach(b => b.addEventListener("click", () => run("model", () => api().chooseGameModel(b.dataset.use))));
  }

  /* One task at a time: setting up the engine, or downloading or choosing a model. */
  function run(kind, fn) {
    if (state.busy) return;
    state.busy = kind; state.progress = null; state.error = ""; draw();
    fn().then(() => { state.busy = ""; state.progress = null; refresh(); })
      .catch(e => { state.busy = ""; state.progress = null; state.error = e.message; refresh(); });
  }
})();
