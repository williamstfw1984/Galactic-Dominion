"use strict";
/* Galactic Dominion: the help screen of the safety check. The check runs on the host. When an order a captain gave, or a
   line their turn produced, shows signs of suicide or self-harm, that captain's turn is put on hold and only that
   captain's screen shows this: the app's own help screen (the words in the settings' "safety" texts, the helpline of
   this player's own country from helplines.js, "carry on" and "close"). Everyone else sees only that the turn is on
   hold. "Carry on" returns to the game; "Close" leaves the turn on hold, and the help screen can be opened again. */
(function () {
  const GD = window.GD, esc = GD.esc;
  const api = () => window.api || {};
  let words = null, country = "", shown = "", open = false, carryFn = null, current = null;

  /* The wording in use, as the admin page keeps it; the original wording if the settings cannot be read. */
  const original = () => (window.BuiltIn && window.BuiltIn.factory ? window.BuiltIn.factory().safety : {});
  const ready = Promise.all([
    (typeof api().getSettings === "function" ? api().getSettings().then(c => c && c.safety).catch(() => null) : Promise.resolve(null)).then(w => { words = Object.assign({}, original(), w || {}); }),
    (typeof api().country === "function" ? api().country().catch(() => "") : Promise.resolve("")).then(c => { country = c || ""; })
  ]);
  const fill = (text, tags) => String(text).replace(/\[([A-Z]+)\]/g, (m, k) => tags[k] != null ? tags[k] : m);

  function show(kind) {
    ready.then(() => {
      const w = words, line = window.Helplines ? window.Helplines.of(country) : null, fromUser = kind !== "line";
      let el = document.getElementById("v-help");
      if (!el) { el = document.createElement("div"); el.id = "v-help"; el.className = "veil"; el.style.zIndex = "80"; document.body.appendChild(el); }
      el.innerHTML = `<div class="hud" role="alertdialog" aria-labelledby="help-t" aria-describedby="help-why">
        <h2 class="hud-h" id="help-t" style="font-size:14px">${esc(w.heading)}</h2>
        <p id="help-why">${esc(fromUser ? w.fromUser : w.fromCharacter)}</p>
        ${line ? `<div class="help-line"><span class="lbl">${esc(line.country)}</span><strong>${esc(line.name)}</strong>
          <div>${line.phone ? `${esc(w.call)} <span class="num">${esc(line.phone)}</span>` : ""}${line.phone && line.text ? " · " : ""}${line.text ? `${esc(w.textTo)} <span class="num">${esc(line.text)}</span>` : ""}</div>
          <span class="sub">${esc(line.always ? w.allHours : w.someHours)}</span></div>` : ""}
        <p>${esc(line ? fill(w.emergency, { NUMBER: line.emergency }) : w.noCountry)}</p>
        <p class="note">${esc(w.elsewhere + " " + (window.Helplines ? window.Helplines.elsewhere : "findahelpline.com"))}</p>
        <div class="btns" style="padding-top:18px;justify-content:flex-end"><button class="btn" type="button" id="help-close">${esc(w.close)}</button><button class="btn btn-hot" type="button" id="help-carry">${esc(w.carryOn)}</button></div></div>`;
      el.hidden = false; open = true;
      document.getElementById("help-close").addEventListener("click", hide);
      document.getElementById("help-carry").addEventListener("click", () => { hide(); if (carryFn) carryFn(); });
      document.getElementById("help-close").focus();
    });
  }
  function hide() { const el = document.getElementById("v-help"); if (el) el.hidden = true; open = false; }

  GD.Safety = {
    /* From every state: s.safety is present only on the screen of the captain concerned. */
    update(s, handlers) {
      carryFn = handlers && handlers.carry;
      current = s.safety || null;
      if (!current) { if (open) hide(); shown = ""; return; }
      const id = current.kind + ":" + (current.id || "");
      if (id !== shown) { shown = id; show(current.kind); }
    },
    /* From the live stream, the moment the server flags what this captain's turn said or was given. */
    flag(kind, id) { const key = kind + ":" + (id || ""); if (key !== shown) { shown = key; show(kind); } },
    reopen() { if (current) show(current.kind); },
    hide
  };
})();
