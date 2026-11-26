"use strict";
/* Galactic Dominion: the screens before play. Connect (host a new game, or join one by address, port and join code),
   the new game's setup with its lobby, choosing a ship and crew, and the universe being generated. Ported from the
   plugin's app.js (home, gate, seat, lobby), in the look of the setup mockup; only the Story mode options are shown. */
(function () {
  const GD = window.GD, esc = GD.esc, $ = GD.$, $$ = GD.$$;
  const api = () => window.api || {};

  /* ===================================================================== connect */
  GD.connect = () => {
    GD.leaveScreen();
    GD.token = ""; GD.ticket = ""; GD.store = { captains: [], active: 0, device: GD.device() };
    const last = GD.lastServer() || {};
    const portIn = (id, v) => `<input id="${id}" class="in" inputmode="numeric" maxlength="5" value="${esc(v)}" autocomplete="off">`;
    GD.show(`<div class="gd-root warm">${GD.top("Story // co-operative campaign")}
<main class="gd-page">
  <div class="gd-col">
    ${GD.panel("01", "Host a new game", `<form id="f-host" class="stack">
      <p class="note">This PC runs the game. The other captains connect to it over the network, or share this screen.</p>
      <div class="two"><label class="fld" for="h-port">Port${portIn("h-port", GD.DEFAULT_PORT)}</label>
      <label class="fld" for="h-code">Join code · 4 digits<input id="h-code" class="in code-in" inputmode="numeric" maxlength="4" autocomplete="off" required></label></div>
      <p class="note">The other captains enter this code to join. After five wrong tries, joining locks for a few minutes.</p>
      <div class="btns"><button class="btn btn-hot" type="submit">Host a new game</button></div>
      <p class="err" id="h-err" hidden></p></form>`)}
    ${GD.panel("02", "Join a game", `<form id="f-join" class="stack">
      <p class="note">Ask the host for their address, port and join code.</p>
      <div class="two"><label class="fld" for="j-host">Host address<input id="j-host" class="in" autocomplete="off" placeholder="192.168.1.20" value="${esc(last.host && last.host !== "127.0.0.1" ? last.host : "")}" required></label>
      <label class="fld" for="j-port">Port${portIn("j-port", last.port || GD.DEFAULT_PORT)}</label></div>
      <label class="fld" for="j-code">Join code<input id="j-code" class="in code-in" inputmode="numeric" maxlength="4" autocomplete="off" required></label>
      <div class="btns"><button class="btn" type="submit">Join</button></div>
      <div id="j-games"></div>
      <p class="err" id="j-err" hidden></p></form>`)}
  </div>
  <aside class="gd-side">
    ${GD.panel("03", "Your games on this PC", `<ul id="here"><li class="empty">None yet. A game you host or join is listed here, so you can return to it.</li></ul>`)}
    <section class="hud" id="campaigns" hidden><h2 class="hud-h"><span class="ix">04</span>Campaigns hosted here<span class="tail">Reopen one, or reread its log</span></h2><ul id="camp"></ul></section>
    ${GD.ai.panel("05")}
    ${GD.panel("06", "Ship & crew creator", `<p class="note" style="padding-bottom:12px">Build the ships and crews captains choose when they join. They are kept in the library of the game server: open it once you host, or once you have joined.</p><div class="btns"><button class="btn" type="button" id="b-creator">Open the creator</button></div><p class="err" id="c-err" hidden></p>`)}
  </aside>
</main></div>`);
    const digits = el => el.addEventListener("input", () => { el.value = el.value.replace(/\D+/g, "").slice(0, el.maxLength); });
    ["#h-port", "#h-code", "#j-port", "#j-code"].forEach(id => digits($(id)));

    $("#f-host").addEventListener("submit", ev => {
      ev.preventDefault();
      const port = parseInt($("#h-port").value, 10), code = $("#h-code").value;
      if (!(port >= 1024 && port <= 65535)) return GD.error({ message: "Choose a port from 1024 to 65535." }, "#h-err");
      if (!/^\d{4}$/.test(code)) return GD.error({ message: "Enter all four digits of the join code." }, "#h-err");
      if (!GD.ai.ready()) return GD.error({ message: "Set up the AI engine and choose a model first (in the AI engine panel)." }, "#h-err");
      host(port).then(() => { GD.joinCode = code; GD.setup(); }).catch(e => GD.error(e, "#h-err"));
    });
    $("#f-join").addEventListener("submit", ev => {
      ev.preventDefault();
      const code = $("#j-code").value;
      if (!/^\d{4}$/.test(code)) return GD.error({ message: "Enter all four digits of the join code." }, "#j-err");
      GD.hosting = false;
      GD.setServer($("#j-host").value, $("#j-port").value);
      $("#j-err").hidden = true;
      GD.api("GET", "/hosted").then(r => {
        const games = (r.games || []).filter(g => g.status === "lobby" || g.status === "active");
        if (!games.length) throw GD.fail({ message: "That host has no game open to join right now." });
        if (games.length === 1) return unlock(games[0].token, code);
        $("#j-games").innerHTML = `<div class="subh">Choose the game</div>` + games.map(g => `<div class="row"><span><b>${esc(g.title || "Game in the lobby")}</b><br><span class="sub">${esc(g.status === "lobby" ? "In the lobby" : "Under way")} · ${g.captains || 0} captains</span></span><button class="btn small" type="button" data-g="${esc(g.token)}">Join</button></div>`).join("");
        $$("[data-g]").forEach(b => b.addEventListener("click", () => unlock(b.dataset.g, code)));
      }).catch(e => GD.error(e, "#j-err"));
    });
    $("#b-creator").addEventListener("click", () => {
      const port = parseInt($("#h-port").value, 10) || GD.DEFAULT_PORT;
      host(port).then(() => GD.Creator.open(GD.connect)).catch(e => GD.error(e, "#c-err"));
    });
    GD.ai.mount();
    listHere();
    listCampaigns(parseInt($("#h-port").value, 10) || GD.DEFAULT_PORT);
  };

  /* Starts this PC's game server (main.js), or finds it already running, and talks to it. */
  function host(port) {
    const start = typeof api().hostGame === "function" ? api().hostGame({ port }) : Promise.resolve({ port });
    return start.then(r => { GD.hosting = true; GD.setServer("127.0.0.1", (r && r.port) || port); return GD.loadRules(); });
  }

  /* Join step 2: the join code, checked only by the server, with its rate limit and lockout. */
  function unlock(token, code) {
    GD.token = token; GD.loadStore();
    return GD.api("POST", GD.game("/unlock"), { code }).then(r => { GD.ticket = r.ticket; return GD.loadRules(); }).then(() => GD.enter())
      .catch(e => GD.error(codeError(e), "#j-err"));
  }
  const codeError = e => e.code === "gd_code_locked" ? { message: "Too many wrong tries. Try again in " + Math.ceil((e.data.seconds || 60) / 60) + " minutes." }
    : e.data && e.data.attempts_left != null ? { message: "That code is not right. " + e.data.attempts_left + " tries left." } : e;

  /* Games this PC holds a seat in, on any server. */
  function listHere() {
    const label = { lobby: ["warn", "In the lobby"], generating: ["warn", "Generating"], active: ["good", "Under way"], ended: ["off", "Complete"] };
    const seats = GD.seatsHere(), box = $("#here");
    seats.forEach(s => {
      fetch(s.base + "/game/" + s.token, { headers: { "X-GD-Captain": s.seat.token } }).then(r => r.ok ? r.json() : null).then(g => {
        if (!g || !g.joined || !$("#here")) return;
        if (box.querySelector(".empty")) box.innerHTML = "";
        const t = label[g.status] || ["off", g.status];
        const li = document.createElement("li");
        li.className = "row";
        li.innerHTML = `<span><b>${esc(g.title || "Game in the lobby")}</b> <span class="tag ${t[0]}">${t[1]}</span><br><span class="sub">${esc(s.seat.name || "Captain")} · ${g.turns || 0} turns · ${esc(s.base.replace(/^http:\/\//, ""))}</span></span><button class="btn small" type="button">${g.status === "ended" ? "Open the ship's log" : "Return to the bridge"}</button>`;
        li.querySelector("button").addEventListener("click", () => {
          GD.base = s.base; GD.hosting = /\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(s.base + "/"); GD.token = s.token; GD.loadStore();
          GD.loadRules().then(GD.enter).catch(e => GD.toast(e.message));
        });
        box.appendChild(li);
      }).catch(() => {});
    });
  }
  /* Player One's campaigns on this PC's own server, running and finished, if it is running. */
  function listCampaigns(port) {
    const base = "http://127.0.0.1:" + port;
    fetch(base + "/games").then(r => r.ok ? r.json() : null).then(r => {
      if (!r || !r.games || !r.games.length || !$("#camp")) return;
      const label = { lobby: ["warn", "In the lobby"], generating: ["warn", "Generating"], active: ["good", "Under way"], ended: ["off", "Complete"] };
      $("#campaigns").hidden = false;
      $("#camp").innerHTML = r.games.map((g, i) => { const t = label[g.status] || ["off", g.status]; return `<li class="row"><span><b>${esc(g.title || "Untitled campaign")}</b> <span class="tag ${t[0]}">${t[1]}</span><br><span class="sub">${esc(g.preset)} · ${g.captains} captain${g.captains === 1 ? "" : "s"} · ${g.turns} turns · started ${esc(g.created)}${g.ended ? " · finished " + esc(g.ended) : ""}</span></span><button class="btn small" type="button" data-c="${i}">${g.status === "ended" ? "Ship's log" : "Open"}</button></li>`; }).join("");
      $$("[data-c]").forEach(b => b.addEventListener("click", () => {
        const g = r.games[+b.dataset.c];
        host(port).then(() => { GD.token = g.token; GD.loadStore(); return GD.enter(); }).catch(e => GD.toast(e.message));
      }));
    }).catch(() => {});
  }

  /* ===================================================================== entering a game */
  /** Where a game's address leads: its bridge, its lobby, a seat to choose, or the join code. */
  GD.enter = () => GD.api("GET", GD.game()).then(info => {
    if (info.joined) return (info.status === "active" || info.status === "ended") ? GD.bridge() : GD.lobby();
    if (GD.me()) { GD.store.captains = []; GD.store.active = 0; GD.saveStore(); }   // a stale seat
    if (info.expired) return notice("Game expired", "This game was never started and has expired. Ask Player One to create a new game.");
    if (info.status === "ended") return notice("Campaign complete", "This campaign has ended.");
    if (info.owner) return GD.seat(false);
    if (GD.ticket) return GD.seat(false);
    if (!info.join_ready) return notice("Joining unavailable", "This game has no join code, so it cannot be joined.");
    return gate();
  }).catch(e => notice("Game not found", e.message));

  function notice(title, text) {
    GD.leaveScreen();
    GD.show(`<div class="gd-root warm">${GD.top(title)}<main class="gd-page"><div class="gd-col">${GD.panel("01", title, `<p>${esc(text)}</p><div class="btns" style="padding-top:14px"><button class="btn" type="button" id="b-back">Back to the start</button></div>`)}</div></main></div>`);
    $("#b-back").addEventListener("click", GD.connect);
  }
  /* The join code, when a game is reopened from this PC and its seat has lapsed. */
  function gate() {
    GD.leaveScreen();
    GD.show(`<div class="gd-root warm">${GD.top("Join game // join code")}<main class="gd-page"><div class="gd-col">${GD.panel("01", "Join code", `<form id="f-gate" class="stack"><label class="fld" for="g-code">Enter the 4-digit join code<input id="g-code" class="in code-in" inputmode="numeric" maxlength="4" autocomplete="off" required></label><div class="btns"><button class="btn btn-hot" type="submit">Continue</button><button class="btn" type="button" id="b-back">Back</button></div><p class="err" id="g-err" hidden></p></form>`)}</div></main></div>`);
    $("#b-back").addEventListener("click", GD.connect);
    $("#f-gate").addEventListener("submit", ev => {
      ev.preventDefault();
      GD.api("POST", GD.game("/unlock"), { code: $("#g-code").value }).then(r => { GD.ticket = r.ticket; GD.seat(false); }).catch(e => GD.error(codeError(e), "#g-err"));
    });
    $("#g-code").focus();
  }

  /* ===================================================================== setup and lobby */
  /* The galaxy, dice and captains, as set before the game is created (setup) or as it was created (lobby). */
  function options(chosen, locked) {
    const R = GD.rules, presets = R.presets, keys = Object.keys(presets), dis = locked ? " disabled" : "";
    const size = keys.map(k => { const p = presets[k], on = chosen.preset === k; return `<button type="button" class="opt${on ? " on" : ""}" data-preset="${esc(k)}" aria-pressed="${on}"${dis}><span class="ot">${esc(p.label)}</span><span class="lbl">${p.size}³ · ${(p.size ** 3).toLocaleString("en-GB")} sectors · ${p.critical} critical missions</span><span class="sub">${esc(p.blurb)}</span></button>`; }).join("");
    const dice = [["system", "System rolls", "The game rolls a d20 for every roll, shown on screen."], ["physical", "Physical dice", "Each captain rolls their own d20 and enters the number. If no roll is entered in time, the system rolls for them."]]
      .map(([k, t, d]) => { const on = chosen.dice === k; return `<button type="button" class="opt${on ? " on" : ""}" data-dice="${k}" aria-pressed="${on}"${dis}><span class="ot">${t}</span><span class="sub">${d}</span></button>`; }).join("");
    const caps = Array.from({ length: R.max_captains }, (_, i) => `<button type="button" class="btn" data-caps="${i + 1}" aria-pressed="${chosen.captains === i + 1}"${dis}>${i + 1}</button>`).join("");
    return GD.panel("01", "Galaxy size", `<div class="opts">${size}</div><p class="note" id="suggest" style="padding-top:12px"></p>`, { tail: locked ? "Fixed once generated" : "" }) +
      GD.panel("02", "Dice", `<div class="opts wide">${dice}</div>`, { tail: locked ? "Whole game" : "" }) +
      GD.panel("03", "Captains", `<div class="lbl" style="padding-bottom:6px">Captains expected · more may join later</div><div class="seg">${caps}</div>`);
  }
  /* Larger grids mean a longer campaign: the plugin's suggestion, by the presets' order (smallest first). */
  function suggestion(n) {
    const keys = Object.keys(GD.rules.presets), p = GD.rules.presets, i = n <= 2 ? 0 : n <= 4 ? 1 : 2;
    const s = keys.slice(i, i + 2);
    return "Suggested for " + n + " captain" + (n > 1 ? "s" : "") + ": " + s.map(k => p[k].label).join(" or ") + ". Larger grids mean a longer campaign, a longer generation wait and longer journeys to reach other captains.";
  }

  /** Player One sets up a new game. */
  GD.setup = () => {
    GD.leaveScreen();
    const R = GD.rules, keys = Object.keys(R.presets);
    const chosen = { preset: keys.includes("standard") ? "standard" : keys[1] || keys[0], dice: "system", captains: 1 };
    const draw = () => {
      GD.show(`<div class="gd-root warm">${GD.top("New game // configure the galaxy")}<main class="gd-page"><div class="gd-col">${options(chosen, false)}</div>
<aside class="hud gd-side" style="display:block"><h2 class="hud-h"><span class="ix">04</span>Lobby</h2>
  <div class="lbl" style="padding-bottom:6px">Join details</div>
  <div class="row"><span class="lbl">Join code</span><span class="num" style="font-size:20px;letter-spacing:.3em">${esc(GD.joinCode)}</span></div>
  <div class="row"><span class="lbl">Port</span><span>${esc(GD.base.replace(/^.*:/, ""))}</span></div>
  <p class="note" style="padding:12px 0 18px">Opening the lobby creates the game. Then choose your own ship and crew, and the other captains can join.</p>
  <button type="button" class="btn btn-hot btn-big" id="b-create">Open the lobby</button>
  <div class="btns" style="padding-top:14px"><button type="button" class="btn" id="b-creator">Ship & crew creator</button><button type="button" class="btn" id="b-back">Back</button></div>
  <p class="err" id="s-err" hidden></p>
</aside></main></div>`);
      $("#suggest").textContent = suggestion(chosen.captains);
      $$("[data-preset]").forEach(b => b.addEventListener("click", () => { chosen.preset = b.dataset.preset; draw(); }));
      $$("[data-dice]").forEach(b => b.addEventListener("click", () => { chosen.dice = b.dataset.dice; draw(); }));
      $$("[data-caps]").forEach(b => b.addEventListener("click", () => { chosen.captains = +b.dataset.caps; draw(); }));
      $("#b-back").addEventListener("click", GD.connect);
      $("#b-creator").addEventListener("click", () => GD.Creator.open(GD.setup));
      $("#b-create").addEventListener("click", () => {
        GD.api("POST", "/game", { preset: chosen.preset, dice: chosen.dice, captains: chosen.captains, join_code: GD.joinCode })
          .then(r => { GD.token = r.token; GD.loadStore(); GD.seat(false); }).catch(e => GD.error(e, "#s-err"));
      });
    };
    draw();
  };

  /** The lobby: who has joined, the game's options, Start, and the universe being generated. */
  GD.lobby = () => {
    GD.leaveScreen();
    let timer = 0, generating = false, removing = false, live = true, last = null;
    GD.stops.push(() => { live = false; clearTimeout(timer); });
    GD.show(`<div class="gd-root warm">${GD.top("Game lobby // waiting for captains")}<main class="gd-page"><div class="gd-col" id="l-opts"></div><aside class="hud gd-side" style="display:block" id="l-side"></aside></main></div>`);
    const tick = () => {
      GD.api("GET", GD.game()).then(L => {
        if (!live) return;
        if (L.status === "active" || L.status === "ended") return GD.bridge();
        last = L; draw(L);
        if (L.status === "generating" && !generating && (L.owner || L.joined)) drive();
        timer = setTimeout(tick, 2000);
      }).catch(() => { if (live) timer = setTimeout(tick, 4000); });
    };
    /* Generation advances a phase per request; the lobby drives it (the plugin's Player One screen did the same). */
    const drive = () => {
      generating = true;
      GD.api("POST", GD.game("/generate")).then(r => {
        generating = false;
        if (live && r.status === "generating" && !(r.gen && r.gen.error)) setTimeout(drive, r.busy ? 3000 : 200);
      }).catch(() => { generating = false; });
    };
    const draw = L => {
      const opts = L.options || {};
      const optsHtml = options({ preset: opts.preset, dice: opts.dice, captains: opts.captains }, true);
      if ($("#l-opts").dataset.sig !== optsHtml) { $("#l-opts").innerHTML = optsHtml; $("#l-opts").dataset.sig = optsHtml; }
      let h = `<h2 class="hud-h"><span class="ix">04</span>Lobby<span class="tail">${L.status === "generating" ? "Generating" : "Live"}</span></h2>`;
      if (L.owner && L.join) {
        const where = (L.join.addresses || []).map(a => a + ":" + L.join.port).join("  ·  ") || "port " + L.join.port;
        h += `<div class="lbl" style="padding-bottom:6px">Join details</div><div class="btns" style="flex-wrap:nowrap"><div class="link" id="l-link">${esc(where)}  ·  code ${esc(L.join.code)}</div><button type="button" class="btn" id="b-copy">Copy</button></div>
          <div class="sub" style="padding:8px 0 16px">Players choose Join a game, enter this address, port and join code, and pick a ship and crew.</div>`;
      }
      h += `<div class="lbl" style="padding-bottom:4px">Captains · ${L.captains.length} of ${L.max}</div>`;
      h += L.captains.map(c => {
        const host = c.seat === 1, col = host ? "var(--you)" : c.ready ? "var(--good)" : "var(--dim)";
        const state = host ? "Host" : c.ready ? "Ready" : "Choosing", sc = host ? "var(--you-2)" : c.ready ? "var(--good)" : "var(--dim)";
        const rm = removing && L.owner && !host && L.status === "lobby" ? `<button class="btn small warn" type="button" data-remove="${c.id}">Remove</button>` : `<span class="lbl" style="color:${sc}">${state}</span>`;
        return `<div class="row"><span class="who-dia"><span class="dia" style="color:${col}"></span><span><b>${esc(c.name)}</b><br><span class="sub">${host ? "Player One · " : ""}${esc(c.ship)} · ${c.connected ? (c.local ? "on this PC" : "connected") : "not connected"}</span></span></span>${rm}</div>`;
      }).join("");
      if (L.status === "lobby") {
        if (L.owner) {
          h += `<div class="btns" style="padding:14px 0 18px">${L.captains.length < L.max ? `<button type="button" class="btn" id="b-local">Add player on this PC</button>` : ""}${L.captains.length > 1 ? `<button type="button" class="btn${removing ? " on" : ""}" id="b-remove">${removing ? "Done removing" : "Remove a player"}</button>` : ""}<button type="button" class="btn" id="b-creator">Creator</button></div>
            <button type="button" class="btn btn-hot btn-big" id="b-start">Start game</button>
            <div class="sub" style="padding-top:10px;text-align:center">Starting generates the galaxy, its factions and the campaign. This can take a few minutes.</div>`;
        } else h += `<p class="note" style="padding-top:14px">Waiting for Player One to start the game.</p>`;
      }
      if (L.status === "generating") {
        const ph = L.gen.phase, err = L.gen.error;
        const row = (n, name, note) => {
          const st = ph >= n ? "done" : ph === n - 1 ? (err ? "error" : "run") : "wait";
          const tag = { done: ["good", "Complete"], error: ["crit", "Stopped"], run: ["cy", "Working"], wait: ["off", "Waiting"] }[st];
          return `<div class="phase"><span><b>${n} · ${name}</b><br><span class="sub">${note}</span></span><span class="tag ${tag[0]}">${tag[1]}</span><span class="bar ${st === "done" ? "g" : st === "run" ? "run" : ""}"><i style="width:${st === "done" ? 100 : st === "run" ? 35 : 0}%"></i></span></div>`;
        };
        h += `<div class="subh" style="padding-top:16px">Generating the universe</div>` +
          row(1, "Grid", ph >= 1 ? (L.gen.sectors || 0).toLocaleString("en-GB") + " systems and features placed" : "Placing stars, nebulae and hazards") +
          row(2, "Story", "Writing factions and the campaign arc. This is the long one.") +
          row(3, "Missions", "Main and side missions") +
          (err ? `<p class="err">${esc(err)}</p>${L.owner ? `<div class="btns" style="padding-top:8px"><button class="btn" type="button" id="b-retry">Try again</button></div>` : ""}` : "");
      }
      h += `<p class="err" id="l-err" hidden></p>`;
      $("#l-side").innerHTML = h;
      const copy = $("#b-copy");
      if (copy) copy.addEventListener("click", () => { (navigator.clipboard ? navigator.clipboard.writeText($("#l-link").textContent) : Promise.reject()).then(() => { copy.textContent = "Copied"; }).catch(() => { copy.textContent = "Select it"; }); });
      $$("[data-remove]").forEach(b => b.addEventListener("click", () => GD.api("POST", GD.game("/remove"), { captain: +b.dataset.remove }).then(tick).catch(e => GD.error(e, "#l-err"))));
      const on = (id, fn) => { const b = $(id); if (b) b.addEventListener("click", fn); };
      on("#b-remove", () => { removing = !removing; draw(last); });
      on("#b-local", () => GD.seat(true));
      on("#b-creator", () => GD.Creator.open(GD.lobby));
      on("#b-retry", drive);
      on("#b-start", () => GD.api("POST", GD.game("/start")).then(() => { clearTimeout(timer); tick(); }).catch(e => GD.error(e, "#l-err")));
    };
    tick();
  };

  /* ===================================================================== choosing a ship and crew */
  /** Join step 3: pick a saved ship and crew, or take back a seat held before. local: another captain on this PC. */
  GD.seat = local => {
    GD.leaveScreen();
    GD.api("GET", GD.game("/builds")).then(r => {
      const seats = !local && r.seats ? r.seats : [];
      let pick = null;
      const resume = seats.length ? GD.panel("01", "Return to your ship", `<p class="note" style="padding-bottom:8px">If you were playing on another PC, take your seat back here. Everything is as you left it.</p>` +
        seats.map(c => `<div class="row"><span><b>${esc(c.name)}</b><br><span class="sub">${esc(c.ship)} · seat ${c.seat}</span></span><button class="btn small" type="button" data-resume="${c.id}">Resume this seat</button></div>`).join(""), { tail: "Already in this game?" }) : "";
      const builds = r.builds.length ? `<div class="opts">${r.builds.map(b => `<button type="button" class="opt${b.taken ? " taken" : ""}" data-build="${b.id}" data-captain="${esc(b.captain || "")}" aria-pressed="false"${b.taken ? " disabled" : ""}><span class="ot">${esc(b.name)}</span><span class="sub">${b.taken ? "Taken by another captain" : b.captain ? "Captain " + esc(b.captain) : "Available"}</span></button>`).join("")}</div>`
        : `<p class="err">No ships and crews have been saved yet. Build one in the creator first.</p>`;
      GD.show(`<div class="gd-root warm">${GD.top(local ? "Shared screen // add a captain on this PC" : "Join game // choose your ship and crew")}<main class="gd-page"><div class="gd-col">${resume}
        ${GD.panel(seats.length ? "02" : "01", local ? "Add a captain on this PC" : seats.length ? "Or join as a new captain" : "Your ship and crew", `<form id="f-seat" class="stack">${builds}
          <label class="fld" for="s-name" id="s-namef">Captain's name<input id="s-name" class="in" maxlength="60" autocomplete="off"></label><p class="note" id="s-named" hidden></p>
          <div class="btns"><button class="btn btn-hot" type="submit" id="b-join" disabled>${local ? "Add captain" : "Join the lobby"}</button>${local ? `<button class="btn" type="button" id="b-cancel">Cancel</button>` : ""}<button class="btn" type="button" id="b-creator">Open the creator</button></div>
          <p class="err" id="s-err" hidden></p></form>`, { tail: "One player per ship and crew" })}</div></main></div>`);
      if (local) $("#b-cancel").addEventListener("click", GD.lobby);
      $("#b-creator").addEventListener("click", () => GD.Creator.open(() => GD.seat(local)));
      // A ship saved with its captain's name does not ask for one.
      $$("[data-build]").forEach(b => b.addEventListener("click", () => {
        pick = +b.dataset.build;
        $$("[data-build]").forEach(o => { o.classList.toggle("on", o === b); o.setAttribute("aria-pressed", o === b); });
        const own = b.dataset.captain;
        $("#s-namef").hidden = !!own; $("#s-named").hidden = !own;
        $("#s-named").textContent = own ? "You will command this ship as Captain " + own + "." : "";
        $("#b-join").disabled = false;
      }));
      $$("[data-resume]").forEach(b => b.addEventListener("click", () => {
        GD.api("POST", GD.game("/resume"), { captain: +b.dataset.resume, device: GD.store.device }).then(j => {
          GD.store.captains = [{ id: j.captain, token: j.token, name: j.name, seat: j.seat }]; GD.store.active = j.captain; GD.saveStore(); GD.enter();
        }).catch(e => GD.error(e, "#s-err"));
      }));
      $("#f-seat").addEventListener("submit", ev => {
        ev.preventDefault();
        const b = $(`[data-build="${pick}"]`);
        if (!b) return;
        if (!b.dataset.captain && !$("#s-name").value.trim()) return GD.error({ message: "Enter your captain's name." }, "#s-err");
        GD.api("POST", GD.game("/join"), { name: $("#s-name").value, build_id: pick, device: GD.store.device }).then(j => {
          GD.store.captains.push({ id: j.captain, token: j.token, name: j.name, seat: j.seat });
          if (!GD.store.active) GD.store.active = j.captain;
          GD.saveStore(); GD.enter();
        }).catch(e => { GD.error(e, "#s-err"); if (e.code === "gd_build_taken") setTimeout(() => GD.seat(local), 1500); });
      });
    }).catch(e => { if (e.status === 403) { GD.ticket = ""; gate(); } else notice("Join game", e.message); });
  };
})();
