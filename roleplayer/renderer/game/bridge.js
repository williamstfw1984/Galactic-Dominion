"use strict";
/* Galactic Dominion: the bridge, the Story screen. A port of the plugin's app.js bridge in the layout of the Story
   mockup: the header with whose turn it is, the points and Momentum; the star chart with the command bar, leads and
   missions under it; the attributed bridge log beside it, as tall as the chart; and the ship, crew, tactical,
   diplomacy, inventory and captains panels below. Everything shown is drawn from server state. Orders are only ever
   typed or spoken; the buttons are the game menu and the system dialogues. */
(function () {
  const GD = window.GD, esc = GD.esc, $ = GD.$, $$ = GD.$$, cap = GD.cap;
  // The words the server takes as Proceed (the plugin's Turn::command).
  const YES = ["yes", "aye", "proceed", "yes proceed", "make it so", "engage", "do it", "confirmed", "affirmative", "go ahead", "go"];
  const BELAY = /^(belay that|cancel that|never mind|scratch that)[.!]?$/i;
  const DIE_MIN = 3000, DIE_SHOW = 1500;

  let S = null, lastEvent = 0, pollTimer = 0, busy = false, map = null, mapV = "", selected = null, firstLoad = true, left = false;
  let bonusShown = false, streamOn = false, streamCtl = null, working = false, pollSeq = 0, clockTimer = 0, clockAt = 0;
  let liveIds = {}, liveRef = {}, liveDead = {}, liveLines = {}, liveQ = [], liveWait = 0, refSeen = {}, shownEarly = {};
  let die = null, rolled = {}, dialogueSaid = "", typed = false, talking = false, spokenTimer = 0, rollTick = 0, rollEnds = 0;
  const liveReset = () => { liveIds = {}; liveRef = {}; liveDead = {}; liveLines = {}; liveQ = []; liveWait = 0; refSeen = {}; shownEarly = {}; };

  /* ===================================================================== the screen */
  GD.bridge = () => {
    GD.leaveScreen();
    lastEvent = 0; firstLoad = true; left = false; S = null; liveReset(); bonusShown = false; mapV = ""; selected = null;
    const legend = [["own", "Your ship"], ["oth", "Other captains"], ["rch", "Reach this turn"], ["vis", "Visited"], ["scn", "Scanned"], ["unv", "Unvisited"], ["led", "Lead"], ["lck", "Locked mission"]]
      .map(([c, t]) => `<span><i class="${c}"></i>${t}</span>`).join("");
    GD.show(`<div class="gd-root" id="bridge">
<header class="br-head">
  <div class="br-logo">${GD.logo(40)}<div><div class="t">GALACTIC DOMINION</div><div class="lbl" id="br-sub">Story // co-operative campaign</div></div></div>
  <div class="br-stat" id="br-stat"></div>
  <nav class="br-nav" aria-label="Game menu" id="br-nav"></nav>
</header>
<main class="br-main">
  <div class="br-top" id="br-top">
    <section class="br-left" aria-labelledby="h-map">
      <div class="hud" style="padding:16px 18px 18px">
        <div class="mapbar"><h2 class="hud-h" id="h-map"><span class="ix">01</span>Star chart</h2><div class="legend">${legend}</div></div>
        <div class="mapbox" id="map"><div class="scan"></div><div class="sweep lbl" id="sweep">Sensor sweep // live</div></div>
      </div>
      <div class="hud stack">
        <div id="pending"></div>
        <form class="cmd" id="cmd" autocomplete="off">
          <div class="box"><label for="cmd-in" class="sr">Give an order</label><input id="cmd-in" type="text" maxlength="600" placeholder="Give an order, then Enter. Hold Space or the button to speak"></div>
          <div style="display:grid;justify-items:center;gap:4px"><button type="button" class="mic" id="mic" aria-label="Hold to talk"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#DFFAFF" stroke-width="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path></svg></button><span class="mic-state" id="mic-state">Hold to talk</span></div>
        </form>
        <p class="busy" id="busy" hidden>Working</p>
        <p class="err" id="err" hidden></p>
        <div class="leads" id="leads"></div>
      </div>
    </section>
    <section class="hud br-log" aria-labelledby="h-log">
      <h2 class="hud-h" id="h-log"><span class="ix">02</span>Bridge log<span class="tail">Attributed</span></h2>
      <div class="lines-wrap"><div class="lines" id="lines" aria-live="polite"></div></div>
      <div id="die-slot"></div>
      <div id="chat"></div>
    </section>
  </div>
  <div class="br-panels">
    ${GD.panel("03", "Ship", `<div id="p-ship"></div>`, { tail: "", tailId: "t-ship" })}
    ${GD.panel("04", "Crew", `<div id="p-crew"></div>`, { tail: "Effective values" })}
    ${GD.panel("05", "Tactical", `<div id="p-tac"></div>`)}
    ${GD.panel("06", "Diplomacy", `<div id="p-dip"></div>`)}
    ${GD.panel("07", "Inventory", `<div id="p-inv"></div>`, { tail: "", tailId: "t-inv" })}
    ${GD.panel("08", "Captains + fleets", `<div id="p-fleet"></div>`)}
  </div>
</main>
<div class="veil" id="v-pause" hidden></div>
<div class="veil sheet" id="v-sheet" hidden></div>
</div>`);
    $("#cmd").addEventListener("submit", ev => { ev.preventDefault(); holdSpoken(null); send($("#cmd-in").value); });
    // Push to talk: the microphone is open only while the button is held (or the space bar: see talkKey).
    const mic = $("#mic");
    mic.addEventListener("pointerdown", ev => { ev.preventDefault(); talk(true); });
    ["pointerup", "pointerleave", "pointercancel"].forEach(n => mic.addEventListener(n, () => talk(false)));
    mic.addEventListener("contextmenu", ev => ev.preventDefault());
    $("#cmd-in").addEventListener("input", ev => { holdSpoken(null); if (ev.isTrusted) typed = $("#cmd-in").value.trim() !== ""; });   // editing by hand stops a spoken phrase being sent
    if (window.GDMap && window.THREE) {
      map = GD.chart = window.GDMap.create($("#map"), { onSelect: coord => { selected = coord; const i = $("#cmd-in"); if (i) i.placeholder = coord ? "Sector " + coord + " selected. Say \"set course for the selected sector\"" : "Give an order, then Enter. Hold Space or the button to speak"; } });
    } else { map = null; $("#map").insertAdjacentHTML("beforeend", `<p class="empty" style="padding:14px">The star chart could not be loaded.</p>`); }
    // Where the window is too narrow for the log beside the chart, the log becomes a fixed box that scrolls.
    const layout = () => { const top = $("#br-top"); if (!top) return; const l = top.children[0], r = top.children[1]; top.classList.toggle("stacked", r.offsetTop > l.offsetTop + 10); };
    const ro = new ResizeObserver(layout); ro.observe($("#br-top"));
    document.addEventListener("keydown", talkKey); document.addEventListener("keyup", talkKey);
    const blur = () => talk(false); window.addEventListener("blur", blur);
    const vis = () => { if (!document.hidden && S && !left) poll(); }; document.addEventListener("visibilitychange", vis);
    const onSpeech = () => micLabel(); GD.Speech.on(onSpeech);
    GD.stops.push(() => {
      left = true; clearTimeout(pollTimer); clearInterval(clockTimer); clearInterval(rollTick); clearInterval(spokenTimer); dieClose();
      GD.Speech.stop(); GD.Mic.release(); if (streamCtl) streamCtl.abort(); streamOn = false;
      if (map) { map.destroy(); map = null; GD.chart = null; }
      ro.disconnect(); document.removeEventListener("keydown", talkKey); document.removeEventListener("keyup", talkKey);
      window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", vis);
    });
    clockTimer = setInterval(clock, 1000);
    poll();
  };

  /* ===================================================================== state */
  function poll() {
    clearTimeout(pollTimer);
    if (left) return;
    const seq = ++pollSeq;
    GD.api("GET", GD.game("/state"), { after: lastEvent }).then(s => {
      if (left || !$("#lines")) return;
      if (s.status !== "active" && s.status !== "ended") { dieClose(); return GD.lobby(); }
      // Held work is fetched by a request of its own: it may take a while, and the state requests carry the heartbeat.
      if (s.work && !working) { working = true; liveCall("/work").catch(() => {}).then(() => { working = false; }); }
      // A roll the system has just made: the die is shown landing on it first. Until it has, nothing of the result
      // is put on screen or spoken, so neither the panels nor the crew give it away.
      const fresh = firstLoad ? null : freshRoll(s.events || []);
      if (fresh) {
        if (!die) dieOpen({ officer: fresh.roll.officer, needed: fresh.roll.needed });
        if (die && !die.roll) dieTarget(fresh);
        if (die) { pollTimer = setTimeout(poll, streamOn ? 8000 : 2000); return; }
      }
      if (die && !die.roll && die.cancelFrom && seq >= die.cancelFrom) dieClose();   // Proceed did not lead to a roll after all
      S = s; clockAt = Date.now();
      render();
      if (liveWait && seq >= liveWait) liveWait = 0;
      liveRun();
      if (s.realtime === "sse" && !streamOn) stream();
      pollTimer = setTimeout(poll, streamOn ? 8000 : 2000);
    }).catch(e => {
      if (left) return;
      if (e.status === 403) { GD.store.captains = []; GD.saveStore(); return GD.enter(); }
      pollTimer = setTimeout(poll, 4000);
    });
  }

  /* Live updates: the stream only says "something changed"; the state still comes from the normal request. Polling
     carries on underneath at a slower rate, as the heartbeat and as the fallback if the stream fails. */
  function stream() {
    const m = GD.me();
    if (!m || left) return;
    streamOn = true; streamCtl = new AbortController();
    fetch(GD.base + GD.game("/stream"), { headers: { "X-GD-Captain": m.token }, signal: streamCtl.signal }).then(r => {
      if (!r.ok || !r.body) throw new Error("no stream");
      const reader = r.body.getReader(), dec = new TextDecoder();
      const pump = () => reader.read().then(x => {
        if (x.done) { streamOn = false; if (!left && S && S.status === "active") stream(); return; }
        if (dec.decode(x.value).includes("data: change") && !busy) poll();
        return pump();
      });
      return pump();
    }).catch(() => { streamOn = false; if (S) S.realtime = "polling"; });
  }

  /* Hot-seat: a shared screen follows the fixed turn order to the next local captain. */
  function hotSeat() {
    const st = GD.store;
    if (st.captains.length < 2 || !S.turn || S.turn.mine) return;
    if (st.captains.some(c => c.id === S.turn.of)) { st.active = S.turn.of; GD.saveStore(); lastEvent = 0; firstLoad = true; liveReset(); $("#lines").innerHTML = ""; poll(); }
  }

  function render() {
    const s = S;
    $("#br-sub").textContent = "Story // " + (s.title || "co-operative campaign");
    if (s.ship && s.ship.bonus_pool > 0 && !bonusShown) { bonusShown = true; setTimeout(() => { const p = $("#p-ship"); if (p) p.closest(".hud").scrollIntoView({ block: "center", behavior: "smooth" }); }, 400); }
    head(s); crew(s); ship(s); tactical(s); diplomacy(s); inventory(s); fleet(s); missions(s); sayDialogue(s);
    events(s.events || []);
    pending(s); paused(s); chat(s); menu(s);
    if (GD.Safety) GD.Safety.update(s, { carry: () => act("/safety", { choice: "carry" }) });
    if (map && s.ship) {
      if (s.map_v !== mapV) { mapV = s.map_v; GD.api("GET", GD.game("/map")).then(m => { if (map) { map.setMap(m); $("#sweep").textContent = "Sensor sweep // " + m.size + "³ grid // live"; } }).catch(() => { mapV = ""; }); }
      map.setState({
        position: s.position, range_ly: s.ship.range_ly, me: { name: s.me.name, ship: s.ship.name },
        captains: s.captains.map(c => ({ id: c.id, name: c.name, ship: c.ship.name, position: c.position, in_fleet: c.in_fleet, me: c.id === s.me.id, connected: c.connected })),
        missions: s.missions.filter(m => ["available", "active", "suspended"].includes(m.status)).concat(s.leads.map(l => ({ title: "Lead", sector: l.sector, status: "available", critical: true })))
      });
    }
    const txt = !s.audio || s.audio.text;
    $("#lines").hidden = !txt;
    $("#cmd").hidden = !txt || (!!s.pending && s.pending.kind !== "confirm") || s.status === "ended" || s.joining || s.narration_pending || s.benched || s.briefing_pending || !!s.safety || (s.status === "active" && s.turn && !s.turn.mine);
    if (s.status === "ended") { const e = $("#err"); e.hidden = false; e.className = "ok"; e.textContent = "The campaign is complete. Open the Log to reread it."; }
    speech(s);
    micLabel();
    hotSeat();
    firstLoad = false;
  }

  /* ---------- the header: whose turn, the mission, the points, Momentum and the alert ---------- */
  const mmss = n => Math.floor(n / 60) + ":" + ("0" + (n % 60)).slice(-2);
  function turnLeft() { const t = S && S.turn; if (!t || t.seconds_left == null) return null; return S.pause ? t.seconds_left : Math.max(0, t.seconds_left - Math.floor((Date.now() - clockAt) / 1000)); }
  function clock() { const n = turnLeft(), el = $("#br-clock"); if (el && n != null) el.textContent = " · " + mmss(n); }
  function head(s) {
    const st = s.stage, t = s.turn, ended = s.status === "ended";
    const segs = (pts, max, bonus) => { let h = ""; for (let i = 0; i < max; i++) h += `<i class="${i < pts ? "on" : ""}"></i>`; for (let i = 0; i < bonus; i++) h += `<i class="bonus"></i>`; return h; };
    let html = "";
    if (t && !ended) {
      const mine = t.mine, held = s.hold && s.hold.captain === t.of;
      const left = turnLeft();
      html += `<div class="br-turn${mine ? " mine" : ""}"><div class="lbl">${mine ? "Your turn" : "Turn"}${held ? " · on hold" : ""}<span id="br-clock">${left != null ? " · " + mmss(left) : ""}</span></div><div class="num">Captain ${esc(mine ? s.me.name : t.name)}</div></div>`;
    }
    if (st) {
      html += `<div class="br-mission"><div class="lbl">${st.critical ? "Critical mission" : "Mission"} · decisive move costs ${st.climax_cost}</div><div class="v">${esc(st.mission)} <span>// ${st.recovery ? "recovery stage" : "stage " + st.index + " of " + st.total}</span></div></div>`;
      html += `<div class="br-pts"><div style="display:flex;justify-content:space-between"><span class="lbl">Turn points</span><span class="num" style="font-size:16px">${st.points}${st.bonus ? " +" + st.bonus : ""}<span style="color:var(--dim)"> / ${st.points_max}</span></span></div><div class="segs">${segs(st.points, st.points_max, st.bonus)}</div></div>`;
      html += `<div class="br-mom" title="Momentum runs from ${st.momentum_min} to +${st.momentum_max}"><div class="lbl">Momentum</div><div class="num${st.momentum < 0 ? " neg" : ""}">${st.momentum > 0 ? "+" : ""}${st.momentum}</div></div>`;
    } else {
      html += `<div class="br-mission"><div class="lbl">${ended ? "Campaign" : "No mission"}</div><div class="v">${ended ? "Campaign complete" : s.joining ? "On course to join the fleet" : "Exploring freely"}</div></div>`;
      if (t && !ended) html += `<div class="br-pts" title="The turn ends when its points are spent, or when the ship sets a course"><div style="display:flex;justify-content:space-between"><span class="lbl">Turn points</span><span class="num" style="font-size:16px">${t.points}${t.bonus ? " +" + t.bonus : ""}<span style="color:var(--dim)"> / ${t.points_max}</span></span></div><div class="segs">${segs(t.points, t.points_max, t.bonus)}</div></div>`;
    }
    if (s.ship) html += `<div class="alertbox ${esc(s.ship.alert)}"><div class="lbl">Alert</div><div class="num">${s.ship.alert === "normal" ? "NORMAL" : esc(s.ship.alert.toUpperCase())}</div></div>`;
    if (st && st.forced) html += `<span class="forced">Decisive move or retreat</span>`;
    $("#br-stat").innerHTML = html;
  }

  /* ---------- panels ---------- */
  const row = (k, v, cls) => `<div class="row"><span class="lbl">${k}</span><span${cls ? ` class="${cls}"` : ""}>${v}</span></div>`;
  const two = (name, sub, right, rc) => `<div class="row"><span><b>${name}</b>${sub ? `<br><span class="sub">${sub}</span>` : ""}</span><span class="lbl"${rc ? ` style="color:${rc}"` : ""}>${right}</span></div>`;
  function crew(s) {
    $("#p-crew").innerHTML = s.crew.map(o => {
      const state = o.injury ? (o.injury.type === "psychological" ? "Shaken" : cap(o.injury.severity) + " injury") + " · " + o.injury.turns_remaining + " turn" + (o.injury.turns_remaining === 1 ? "" : "s") : "Ready";
      const at = o.attrs.map(a => `<span>${esc(a.label)} <b>${a.value}</b>${a.bonus ? ` <em>(${a.base}+${a.bonus})</em>` : ""}</span>`).join("");
      return `<div class="crew-o"><div class="crew-top"><span><b>${esc(o.name)}</b><br><span class="sub">${esc(o.title)} · ${esc(o.species)} · ${esc(o.gender)}</span></span><span class="lbl" style="color:${o.injury ? "var(--warn)" : "var(--good)"}">${esc(state)}</span></div><div class="crew-at">${at}</div></div>`;
    }).join("") + two("Ship Computer", "Readouts and facts, free to ask", esc(s.computer.status), "var(--vio-2)");
  }
  const bar = (label, value, max, cls, text) => `<div><div style="display:flex;justify-content:space-between"><span class="lbl">${esc(label)}</span><span class="num" style="font-size:17px">${esc(text)}</span></div><div class="bar ${cls || ""}" style="margin-top:6px"><i style="width:${Math.max(0, Math.min(100, value / max * 100))}%"></i></div></div>`;
  function ship(s) {
    const sh = s.ship;
    $("#t-ship").closest(".hud-h").childNodes[1].textContent = "Ship // " + sh.name;
    const attrs = sh.attrs.map(a => row(esc(a.label), a.value + (a.bonus + a.items ? ` <span style="color:var(--good)">(+${a.bonus + a.items})</span>` : ""))).join("");
    const html = `<div class="shipbars">${bar("Hull", sh.hull, 100, sh.hull < 50 ? "r" : sh.hull < 80 ? "w" : "g", sh.hull + "%")}${bar("Shields", sh.shields, 100, "", sh.shields_up ? sh.shields + "%" : "Down")}</div>` +
      (sh.class || sh.registry ? row("Class", esc([sh.class, sh.registry].filter(Boolean).join(" · "))) : "") + attrs + row("Alert", cap(sh.alert) + (sh.weapons ? " · weapons armed" : " · weapons cold")) + row("Damaged", sh.damaged.length ? esc(sh.damaged.map(cap).join(", ")) : "None") +
      row("Sector", esc(s.position.replace(/,/g, " · "))) + row("Range this turn", sh.range_ly + " ly" + (s.fleet.is_fleet ? " (slowest in fleet)" : "")) + row("Cargo", sh.cargo_used + " of " + sh.cargo_max + " slots");
    const box = $("#p-ship");
    // Bonus points from the Engineer's Power Management, placed once, before the first order.
    if (sh.bonus_pool > 0) {
      if (!$("#alloc")) {
        box.innerHTML = `<form class="alloc" id="alloc"><h3>Place ${sh.bonus_pool} bonus ship point${sh.bonus_pool > 1 ? "s" : ""}</h3><p class="note">Your Engineer's Power Management adds these to the ship. Place them before your first order; this is done once.</p>` +
          sh.attrs.map(a => `<div class="ar"><label class="lbl" for="al-${a.key}">${esc(a.label)}</label><input class="in" id="al-${a.key}" data-al="${a.key}" type="number" min="0" max="${sh.bonus_pool}" value="0"></div>`).join("") +
          `<div class="btns"><button class="btn btn-hot" type="submit">Confirm</button></div><p class="err" id="al-err" hidden></p></form><div id="p-ship-live"></div>`;
        $("#alloc").addEventListener("submit", ev => {
          ev.preventDefault(); const al = {}; $$("[data-al]").forEach(i => { al[i.dataset.al] = +i.value || 0; });
          GD.api("POST", GD.game("/allocate"), { alloc: al }).then(poll).catch(e => GD.error(e, "#al-err"));
        });
      }
      $("#p-ship-live").innerHTML = html;
    } else box.innerHTML = html;
  }
  const postureCol = p => p === "Hostile" ? "var(--crit-2)" : p === "Wary" ? "var(--warn)" : p === "Passive" ? "var(--good)" : "var(--soft)";
  function tactical(s) {
    const t = s.tactical, sh = s.ship;
    let h = row("Readiness", (sh.shields_up ? "Shields up" : "Shields down") + " · " + (sh.weapons ? "weapons armed" : "weapons cold") + (sh.damaged.length ? " · damaged: " + esc(sh.damaged.map(cap).join(", ")) : ""));
    h += t.contacts.length ? t.contacts.map(c => two(esc(c.name), esc([cap(c.kind), c.faction, c.position].filter(Boolean).join(" · ")), esc(c.posture), postureCol(c.posture))).join("") : `<p class="empty">Nothing detected in this sector.</p>`;
    const here = s.captains.filter(c => c.id !== s.me.id && c.position === s.position);
    if (here.length) h += `<div class="subh">Concord ships here</div>` + here.map(c => two(esc(c.ship.name), esc(c.name) + " · seat " + c.seat + " · " + cap(c.ship.alert) + " alert · shields " + (c.ship.shields_up ? "up" : "down") + " · hull " + c.ship.hull + "%" + (c.connected ? "" : " · disconnected"), c.in_fleet ? "In your fleet" : "Not in fleet", c.in_fleet ? "var(--good)" : "")).join("");
    h += `<div class="subh">Tactical scan</div>` + (t.scan ? `<p><b>${esc(t.scan.subject)}</b>: ${esc(t.scan.text)}</p>` : `<p class="empty">No contact has been scanned yet.</p>`);
    h += `<div class="threat"><div class="lbl">Active threat</div><div style="padding-top:2px">${t.threat ? esc(t.threat.description) + (t.threat.needed != null ? `<br><span class="sub">Die must show ${t.threat.needed} or higher</span>` : "") : "None declared"}</div></div>`;
    $("#p-tac").innerHTML = h;
  }
  function diplomacy(s) {
    const d = s.diplomacy, stepCol = { Hostile: "var(--crit-2)", Unfriendly: "var(--crit-2)", Neutral: "var(--soft)", Cordial: "var(--good)", Allied: "var(--good)" };
    let h = d.factions.length ? d.factions.map(f => two(esc(f.name), esc(f.reason || ""), esc(f.step) + (f.dir > 0 ? " ▲" : f.dir < 0 ? " ▼" : ""), stepCol[f.step])).join("") : `<p class="empty">No other faction has been met yet.</p>`;
    h += `<div class="subh">Active channel</div>` + (d.channel ? two(esc(d.channel.with), esc((d.channel.faction || "Unaligned") + (d.channel.attitude ? " · " + d.channel.attitude : "")), "Open", "var(--good)") : `<p class="empty">Hailing frequencies closed.</p>`);
    h += `<div class="subh">Database</div>` + (d.database ? `<p><b>${esc(d.database.subject)}</b>: ${esc(d.database.text)}</p>` : `<p class="empty">Ask the Computer about a species or faction. It is free.</p>`);
    h += `<div class="subh">Agreements</div>` + (d.agreements.length ? d.agreements.map(a => `<p class="row" style="display:block">${esc(a.text)}</p>`).join("") : `<p class="empty">No promises, treaties, debts or threats on record.</p>`);
    h += `<div class="subh">Contacts</div>` + (d.contacts.length ? d.contacts.map(c => two(esc(c.name), esc((c.faction || "Unaligned") + (c.attitude ? " · " + c.attitude : "")), "Met at " + esc(c.met_at))).join("") : `<p class="empty">Nobody met yet.</p>`);
    $("#p-dip").innerHTML = h;
  }
  const rarCol = r => ({ standard: "var(--soft)", advanced: "var(--c1-2)", prototype: "var(--you-2)", story: "var(--vio-2)" })[r] || "var(--soft)";
  const itemList = items => items.map(i => `<div class="row"><span><b>${esc(i.name)}${i.qty > 1 ? " ×" + i.qty : ""}</b> <span class="tag" style="color:${rarCol(i.rarity)}">${i.kind === "story" ? "Story" : esc(i.rarity)}</span><br><span class="sub">${esc(i.effect)}${i.kind === "equipment" ? " · equipment" : ""}</span></span><span class="num" style="font-size:16px">${i.kind === "consumable" ? (i.cost ? i.cost + " PT" : "0 PT") : ""}</span></div>`).join("");
  function inventory(s) {
    let h = s.inventory.length ? itemList(s.inventory) : `<p class="empty">The hold is empty. Items come from exploring, completing stages and side missions.</p>`;
    if (s.held_back) h += `<p class="note" style="padding-top:8px">${s.held_back} item${s.held_back > 1 ? "s are" : " is"} waiting for a free cargo slot. Use, jettison or transfer something.</p>`;
    s.captains.forEach(c => { if (c.in_fleet && c.id !== s.me.id && c.inventory && c.inventory.length) h += `<div class="subh">${esc(c.ship.name)} holds</div>` + itemList(c.inventory); });
    $("#p-inv").innerHTML = h;
    $("#t-inv").textContent = s.ship.cargo_used + " of " + s.ship.cargo_max;
  }
  function fleet(s) {
    const leader = s.fleet.leader, byId = {};
    s.captains.forEach(c => { byId[c.id] = c; });
    let h = s.captains.map(c => {
      const me = c.id === s.me.id, partyMates = s.captains.filter(o => o.party === c.party);
      const lead = partyMates.length > 1 ? (me ? s.fleet.leader === c.id : null) : null;
      const where = "Sector " + c.position.replace(/,/g, " · ");
      let rel = partyMates.length < 2 ? "Alone" : c.in_fleet ? (leader === c.id ? "Fleet leader" : "In your fleet") : "In a fleet of " + partyMates.length;
      if (me) rel = !s.fleet.is_fleet ? "Alone" : lead ? "Fleet leader" : "In " + esc((byId[leader] || {}).name || "a") + "'s fleet";
      return two((me ? "You · " : "Capt. " + esc(c.name) + " · ") + esc(c.ship.name), rel + " · " + esc(where) + (c.connected ? "" : " · away") + (c.injured ? " · " + c.injured + " hurt" : ""), "Hull " + c.ship.hull + "%", me ? "var(--you-2)" : "");
    }).join("");
    if (s.invites.length) h += `<div class="invite">${s.invites.map(i => "Capt. " + esc(i.from) + " of the " + esc(i.ship) + " asks you to join the fleet.").join(" ")} Answer by voice on your turn.</div>`;
    if (s.hold && s.hold.captain !== s.me.id) h += `<div class="invite" style="border-color:rgba(143,166,204,.5);background:rgba(143,166,204,.08)">Captain ${esc(s.hold.name)}'s turn is on hold.</div>`;
    $("#p-fleet").innerHTML = h;
  }
  function missions(s) {
    const list = s.missions.filter(m => m.status !== "failed" || m.critical);
    // Missions are not listed ahead of time: the story's leads say where to go, and a mission appears once the ship is there.
    const leads = `<div><div class="lbl" style="color:var(--vio-3);padding-bottom:6px">Leads</div>` + (s.leads.length ? s.leads.map(l => `<div class="row"><span>${esc(l.text)}</span><span class="lbl" style="color:var(--vio-2);flex:none">${esc(l.sector.replace(/,/g, "·"))}</span></div>`).join("") : `<p class="empty">No leads open.</p>`) + `</div>`;
    const ms = `<div><div class="lbl" style="color:var(--c1-2);padding-bottom:6px">Missions</div>` + (list.length ? list.map(m => {
      const tag = m.status === "completed" ? ["var(--good)", "Complete"] : m.orders_pending ? ["var(--warn)", "Failed · new orders pending"] : m.recovery_pending ? ["var(--warn)", "Recovery being prepared"] : m.status === "failed" ? ["var(--dim)", "Failed"] : m.status === "active" ? ["", "Stage " + (m.stage + 1) + "/" + m.stages] : m.status === "suspended" ? ["var(--warn)", "Held"] : m.locked ? ["var(--you-2)", esc(m.locked)] : ["var(--good)", "Available"];
      const kind = m.final ? "Final mission" : m.critical ? "critical" : m.kind === "random" ? "encounter" : "side mission";
      return `<div class="row"><span>${esc(m.title)} · ${kind}<br><span class="sub">Sector ${esc(m.sector.replace(/,/g, "·"))}${m.status === "available" && !m.locked ? " · " + esc(m.briefing) : ""}</span></span><span class="lbl" style="flex:none;${tag[0] ? "color:" + tag[0] : ""}">${tag[1]}</span></div>`;
    }).join("") : `<p class="empty">${s.leads.length ? "None begun yet. Follow a lead to find one." : "None begun yet. Missions are found by going where the story points, and by exploring."}</p>`) + `</div>`;
    $("#leads").innerHTML = leads + ms;
  }

  /* The Computer reads out a question put to the captain once, when it appears. Its "Proceed?" is already a log line. */
  function sayDialogue(s) {
    const p = s.pending; let text = "";
    if (p && p.type === "dialogue" && p.kind !== "confirm") text = p.message;
    else if (!p && s.invites.length) text = s.invites.map(i => i.from + " of the " + i.ship + " asks you to join their fleet.").join(" ");
    if (text && text !== dialogueSaid && !firstLoad && s.audio.tts) GD.Speech.say(text, s.computer.voice);
    dialogueSaid = text;
  }

  /* ---------- the attributed log ---------- */
  function lineEl(l, title) {
    const cls = l.speaker_type === "npc" ? "npc" : l.speaker_type === "computer" ? "comp" : "";
    const role = l.speaker_type === "npc" ? "Incoming" : l.speaker_type === "computer" ? "Computer" : (title || "");
    return `<div class="msg ${cls}"><div class="who"><b><span class="dia"></span>${esc(l.speaker_name)}</b><span class="lbl">${esc(role)}</span></div><p>${esc(l.line)}</p></div>`;
  }
  const officerTitle = id => { const o = (S.crew || []).find(c => c.role === id); return o ? o.title : ""; };
  const say = l => { if (!firstLoad && S.audio.tts) GD.Speech.say(l.line, l.voice, l.made); };
  /** @param early The events came with the live stream, ahead of the state request that will carry them again. */
  function events(list, early) {
    const box = $("#lines"), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    let html = "";
    const reported = {};
    list.forEach(e => { if (e.type === "narration" && e.ref) reported[e.ref] = true; });
    Object.keys(reported).forEach(id => { const chip = box.querySelector(`[data-await="${id}"]`); if (chip) chip.remove(); });
    list.forEach(e => {
      if (e.id <= lastEvent) return;
      if (!early) lastEvent = e.id;
      if (shownEarly[e.id]) return;
      if (early) shownEarly[e.id] = true;
      if (e.type === "turn") {
        // With physical dice the captain's words were already logged when the roll was requested.
        if (!(e.roll && e.roll.source !== "system")) html += `<div class="msg capt"><div class="who"><b><span class="dia"></span>${esc(e.captain)}</b><span class="lbl">${e.mine ? "You · Captain" : "Captain"}</span></div><p>${esc(e.text)}</p></div>`;
        const chips = [];
        if (e.refused) chips.push(`<span>Not attempted · no cost</span>`);
        else if (e.roll) chips.push(`<span>${e.cost ? e.cost + " pt" + (e.cost > 1 ? "s" : "") : "No cost"}</span><span>${e.roll.source === "manual" ? "Rolled " : e.roll.source === "system_timeout" ? "Auto-rolled " : "System rolled "}${e.roll.value}${e.roll.needed == null ? " · needed a natural 20" : " · needed " + e.roll.needed}</span><span class="${esc(e.roll.outcome)}">${cap(e.roll.outcome)}${e.roll.momentum ? " · Momentum " + (e.roll.momentum > 0 ? "+" : "") + e.roll.momentum : ""}</span>`);
        else if (e.cost) chips.push(`<span>${e.cost} pt${e.cost > 1 ? "s" : ""}</span><span>No roll</span>`);
        if (e.awaiting_report && !reported[e.id]) chips.push(`<span class="await" data-await="${e.id}">Awaiting the bridge's report</span>`);
        if (chips.length) html += `<div class="chips">${chips.join("")}</div>`;
        // What the turn changed on the ship and crew, so the panels and the story never disagree unseen.
        if ((e.changes || []).length) html += `<div class="msg sysl"><div class="who"><b><span class="dia"></span>Changes</b><span class="lbl">This turn</span></div><p>${e.changes.map(esc).join(" · ")}</p></div>`;
        (e.notes || []).forEach(n => { html += `<div class="msg note"><div class="who"><b><span class="dia"></span>Bridge</b><span class="lbl">Note</span></div><p>${esc(n)}</p></div>`; });
        (e.lines || []).forEach(l => { html += lineEl(l, l.speaker_type === "officer" && e.mine ? officerTitle(l.speaker_id) : ""); say(l); });
      } else if (e.type === "narration") {
        const k0 = e.ref ? (refSeen[e.ref] || 0) : 0;
        if (e.ref) refSeen[e.ref] = k0 + (e.lines || []).length;
        (e.lines || []).forEach((l, i) => {
          if (liveIds[e.id] || (e.ref && liveRef[e.ref + ":" + (k0 + i)])) return;   // shown and spoken already, as it was written
          html += lineEl(l, l.speaker_type === "officer" ? officerTitle(l.speaker_id) : ""); say(l);
        });
      } else if (e.type === "roll_prompt") {
        html += `<div class="msg capt"><div class="who"><b><span class="dia"></span>${esc(e.captain)}</b><span class="lbl">Captain</span></div><p>${esc(e.text)}</p></div><div class="chips"><span>${e.cost} pts deducted</span><span>Awaiting roll</span></div>`;
      } else if (e.type === "notice") {
        html += `<div class="msg note"><div class="who"><b><span class="dia"></span>${esc(e.speaker || "Bridge")}</b><span class="lbl">Notice</span></div><p>${esc(e.text)}</p></div>`;
        if (e.say && (!firstLoad || e.fresh) && S.audio.tts) GD.Speech.say(e.text, S.computer.voice);
      } else if (e.type === "pause" || e.type === "unpause") {
        html += `<div class="chips"><span>${e.type === "pause" ? "Game paused" : "Game resumed"}</span></div>`;
      }
    });
    if (html) { box.insertAdjacentHTML("beforeend", html); if (stick || firstLoad) box.scrollTop = box.scrollHeight; }
  }

  /* ---------- awaiting a roll, and the system dialogues ---------- */
  function pending(s) {
    const box = $("#pending"), p = s.pending, sig = p ? p.type + "|" + (p.text || p.message) : (s.invites.length ? "inv" + s.invites.length : "");
    if (p && p.type === "roll") {
      rollEnds = Date.now() + p.seconds_left * 1000;
      if (box.dataset.sig !== sig) {
        const v = p.preview;
        box.innerHTML = `<div class="dlg"><h3>Roll d20</h3><div class="roll"><span class="lbl">Officer</span><span>${esc(v.officer)}, ${esc(v.role)}${v.covering ? " (covering)" : ""}</span>
          <span class="lbl">Needed</span><span class="need">${v.needed == null ? "Only a natural 20 will do" : "Die must show " + v.needed + " or higher"}</span>
          <label class="lbl" for="die-in">Your roll</label><form id="rollf"><input class="in" id="die-in" type="number" min="1" max="20" step="1" required><button class="btn btn-hot" type="submit">Enter</button><span class="sub" id="roll-left"></span></form>
          <div class="tbar"><i id="roll-bar"></i></div></div><p class="err" id="roll-err" hidden></p></div>`;
        $("#rollf").addEventListener("submit", ev => {
          ev.preventDefault(); const n = $("#die-in").value;
          if (!/^\d+$/.test(n) || +n < 1 || +n > 20) return GD.error({ message: "Enter a whole number from 1 to 20." }, "#roll-err");
          act("/roll", { value: n }, $("#roll-err"));
        });
        if (!s.pause) $("#die-in").focus();
      }
      clearInterval(rollTick);
      const total = p.seconds_total, frozen = !!s.pause, upd = () => {
        const l = frozen ? p.seconds_left : Math.max(0, Math.round((rollEnds - Date.now()) / 1000)), a = $("#roll-left"), b = $("#roll-bar");
        if (!a) return clearInterval(rollTick);
        a.textContent = l + " s, then the system rolls" + (frozen ? " (frozen)" : ""); b.style.width = (l / total * 100) + "%";
      };
      upd(); if (!frozen) rollTick = setInterval(upd, 1000);
    } else if (p) {
      if (box.dataset.sig !== sig) {
        box.innerHTML = `<div class="dlg"><h3>${esc(p.title)}</h3><p>${esc(p.message)}</p><div class="btns">${p.buttons.map((b, i) => `<button type="button" class="btn${i ? "" : " btn-hot"}" data-ans="${esc(b.id)}">${esc(b.label)}</button>`).join("")}</div><p class="err" id="ans-err" hidden></p></div>`;
        $$("[data-ans]", box).forEach(b => b.addEventListener("click", () => { answered(b.dataset.ans === "proceed"); act("/answer", { choice: b.dataset.ans }, $("#ans-err")); }));
      }
    } else if (s.invites.length) {
      if (box.dataset.sig !== sig) box.innerHTML = `<div class="dlg"><h3>Fleet request</h3>${s.invites.map(i => `<p>${esc(i.from)} of the ${esc(i.ship)} (seat ${i.seat}) asks you to join their fleet.</p>`).join("")}<p class="sub">Tell your crew to accept or decline. Accepting takes your whole turn; declining is free.</p></div>`;
    } else { box.innerHTML = ""; clearInterval(rollTick); }
    box.dataset.sig = sig;
    const say = (cls, t, m) => { box.innerHTML = `<div class="dlg ${cls}"><h3>${t}</h3><p>${m}</p></div>`; box.dataset.sig = ""; };
    if (p) return;
    if (s.safety) { box.innerHTML = `<div class="dlg hold"><h3>Your turn is on hold</h3><p>The game waits for you.</p><div class="btns"><button class="btn" type="button" id="b-help">Show the help screen again</button></div></div>`; box.dataset.sig = ""; $("#b-help").addEventListener("click", () => GD.Safety.reopen()); }
    else if (s.hold && s.hold.captain !== s.me.id && s.turn && s.hold.captain === s.turn.of) say("hold", "On hold", "Captain " + esc(s.hold.name) + "'s turn is on hold.");
    else if (s.joining) say("calm", "Joining the fleet", "Your ship is on its way. You arrive at the start of the fleet leader's next turn.");
    else if (s.briefing_pending) say("calm", "Crew briefing", "Your crew is being briefed on the campaign so far. You can give orders as soon as it is done.");
    else if (s.narration_pending) say("calm", "Awaiting the bridge's report", "Your order has been carried out and the result is recorded. The crew's report has not come through yet; it will appear here as soon as it does.");
    else if (s.benched) say("calm", "Joined mid-stage", "You take your place in the turn order from the next round. Until then, follow the log.");
    else if (s.status === "active" && s.turn && !s.turn.mine) say("calm", esc(s.turn.name) + "'s turn", "The game is played one captain at a time. You can give orders when the turn comes to you; until then, follow the log.");
  }

  function paused(s) {
    const el = $("#v-pause"), P = s.pause;
    // The captain whose own turn is on hold sees the help screen, not the pause.
    if (!P || (P.reason === "hold" && s.safety)) { el.hidden = true; el.dataset.sig = ""; GD.Speech.hold(!!P); return; }
    GD.Speech.hold(true);
    const sig = JSON.stringify(P);
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      let body;
      if (P.reason === "disconnect") {
        body = `<p>${esc(P.dropped.join(", "))}${P.dropped.length > 1 ? " have" : " has"} lost connection. They can rejoin with the host's address and join code.</p><p class="note">${esc(P.warning)}</p>` +
          (P.can_decide ? `<div class="btns" style="padding-top:16px"><button class="btn" type="button" data-dec="wait">Wait</button><button class="btn btn-hot" type="button" data-dec="resume">Resume without them</button></div>` : `<p class="note">Player One decides whether to wait or resume.</p>`);
      } else if (P.reason === "hold") {
        body = `<p>${P.by ? "Captain " + esc(P.by) + "'s turn is on hold." : "A captain's turn is on hold."} The game carries on when they return.</p>`;
      } else {
        body = `<p>Paused by ${esc(P.by)}. Roll timers are frozen. Any captain may resume.</p><div class="btns" style="padding-top:16px"><button class="btn btn-hot" type="button" data-unpause>Resume</button></div>`;
      }
      el.innerHTML = `<div class="hud" role="alertdialog" aria-labelledby="pause-t"><div class="pause-t" id="pause-t">PAUSED</div>${body}</div>`;
      $$("[data-dec]", el).forEach(b => b.addEventListener("click", () => GD.api("POST", GD.game("/decide"), { choice: b.dataset.dec }).then(poll).catch(() => {})));
      const u = $("[data-unpause]", el); if (u) u.addEventListener("click", () => GD.api("POST", GD.game("/pause"), { on: 0 }).then(poll).catch(() => {}));
    }
    el.hidden = false;
  }

  /* Player chat inside a fleet: free, and never sent to the AI. */
  function chat(s) {
    const box = $("#chat");
    if (!s.fleet.is_fleet) { box.innerHTML = ""; box.dataset.on = ""; return; }
    if (!box.dataset.on) {
      box.dataset.on = "1";
      box.innerHTML = `<div class="chat"><div class="lbl">Fleet chat · free · not seen by the crew</div><div class="chat-lines" id="chat-lines"></div><form id="chat-f"><input class="in" id="chat-in" maxlength="400" autocomplete="off" aria-label="Fleet chat message" placeholder="Message the other captains"></form></div>`;
      $("#chat-f").addEventListener("submit", ev => { ev.preventDefault(); const i = $("#chat-in"); if (!i.value.trim()) return; GD.api("POST", GD.game("/chat"), { text: i.value }).then(() => { i.value = ""; poll(); }).catch(e => GD.error(e, "#err")); });
    }
    const l = $("#chat-lines"), n = s.chat.length;
    if (+l.dataset.n !== n) { l.dataset.n = n; l.innerHTML = s.chat.map(c => `<div><b>${esc(c.from)}:</b> ${esc(c.text)}</div>`).join(""); l.scrollTop = l.scrollHeight; }
  }

  /* ===================================================================== sending */
  function setBusy(b) { busy = b; const n = $("#busy"); if (n) n.hidden = !b; const i = $("#cmd-in"); if (i) i.disabled = b; }
  function act(path, body, errEl) {
    if (busy) return;
    setBusy(true); const er = errEl || $("#err"); if (er) er.hidden = true;
    const after = () => { setBusy(false); if (die && !die.roll) die.cancelFrom = pollSeq + 1; poll(); };
    return liveCall(path, body).then(after).catch(e => { GD.error(e, er); after(); });
  }

  /* ---------- the live channel: a turn's words as they are written ---------- */
  /* An order, an answer, a roll, held work and a carry-on are answered as a stream of JSON lines (the plugin's
     class-live.php, without its speech messages). Each line's text arrives piece by piece and is shown as it comes;
     its voice id comes with it and its sentences are spoken here as they complete. Everything is also recorded as
     events, and a line shown this way is claimed the moment it begins, so the state request that later carries the
     same line does not show or speak it again. */
  function liveCall(path, body) {
    const headers = GD.headers({ "X-GD-Live": "text" });
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      let at = 0, result = null, live = false;
      const read = () => {
        if (!live) { live = /ndjson/.test(x.getResponseHeader("content-type") || ""); if (!live) return; }
        const text = x.responseText;
        let nl;
        while ((nl = text.indexOf("\n", at)) >= 0) {
          const ln = text.slice(at, nl); let msg = null; at = nl + 1;
          if (!ln) continue;
          try { msg = JSON.parse(ln); } catch { continue; }
          if (msg.t === "done") result = msg; else liveMsg(msg);
        }
      };
      x.open("POST", GD.base + GD.game(path), true);
      Object.keys(headers).forEach(k => x.setRequestHeader(k, headers[k]));
      x.onreadystatechange = () => { if (x.readyState >= 3 && x.status) { try { read(); } catch {} } };
      x.onprogress = () => { try { read(); } catch {} };
      x.onerror = x.onabort = x.ontimeout = () => { liveMsg({ t: "over" }); reject(GD.fail({ message: "The connection to the game server was lost. Try again." }, 0)); };
      x.onload = () => {
        try { read(); } catch {}
        if (!live) {
          let j = {}; try { j = JSON.parse(x.responseText) || {}; } catch { j = {}; }
          return x.status >= 200 && x.status < 300 ? resolve(j) : reject(GD.fail(j, x.status));
        }
        liveMsg({ t: "over" });
        if (!result) return resolve({});   // it ended without its reply: the state request says what happened
        if (result.status >= 400) return reject(GD.fail(result.body, result.status));
        resolve(result.body || {});
      };
      x.send(JSON.stringify(body || {}));
    });
  }
  /** A message has arrived. A line is claimed at once; it is put on screen in order, once the state it belongs after is. */
  function liveMsg(m) {
    if (m.t === "pad") return;
    if (m.t === "safety") { liveQ.push(m); return liveRun(); }
    if (m.t === "sync") {
      // The turn is recorded, and its result came with the stream: the die lands on it and it goes on screen
      // without waiting for a state request, which can be held up for as long as the turn is being resolved.
      if (m.events && m.events.length) {
        const fresh = firstLoad ? null : freshRoll(m.events);
        if (fresh) { if (!die) dieOpen({ officer: fresh.roll.officer, needed: fresh.roll.needed }); if (die && !die.roll) dieTarget(fresh); }
        liveQ.push({ t: "events", events: m.events }); liveRun();
      } else liveWait = pollSeq + 1;
      poll();   // for the panels
      return;
    }
    if (m.t === "line") {
      if ((m.id && m.id <= lastEvent) || (m.ref && m.k < (refSeen[m.ref] || 0))) liveDead[m.key] = true;   // the state request brought it first
      else if (m.id) liveIds[m.id] = true; else liveRef[m.ref + ":" + m.k] = true;
    }
    if (liveDead[m.key]) return;
    if (m.t === "end" && m.id) liveIds[m.id] = true;
    liveQ.push(m); liveRun();
  }
  function liveRun() {
    // Held while the die is tumbling, and until the turn's own result is on screen.
    if (die || liveWait || !S || !$("#lines")) return;
    while (liveQ.length) liveDo(liveQ.shift());
  }
  function liveDrop(key) {
    const L = liveLines[key]; if (!L) return;
    delete liveLines[key];
    L.el.remove();
    if (L.m.id) delete liveIds[L.m.id]; else delete liveRef[L.m.ref + ":" + L.m.k];
    if (L.item) L.item.cancel();
  }
  function liveDo(m) {
    if (m.t === "over") return liveOver();
    if (m.t === "events") return events(m.events, true);
    if (m.t === "safety") { if (GD.Safety) GD.Safety.flag(m.kind, m.id); GD.Speech.stop(); return; }
    const box = $("#lines"), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    let L = liveLines[m.key];
    if (m.t === "line") {
      const el = document.createElement("div"), title = m.ref && m.speaker_type === "officer" ? officerTitle(m.speaker_id) : "";
      el.className = "msg live " + (m.speaker_type === "npc" ? "npc" : m.speaker_type === "computer" ? "comp" : "");
      const role = m.speaker_type === "npc" ? "Incoming" : m.speaker_type === "computer" ? "Computer" : title;
      el.innerHTML = `<div class="who"><b><span class="dia"></span>${esc(m.speaker_name)}</b><span class="lbl">${esc(role)}</span></div><p></p>`;
      box.appendChild(el);
      // The report has begun to arrive: the order it answers is no longer waiting for it.
      if (m.ref) { const chip = box.querySelector(`[data-await="${m.ref}"]`); if (chip) chip.remove(); }
      L = liveLines[m.key] = { el, p: el.querySelector("p"), m, text: "", item: null, ended: false };
      if (S.audio.tts && m.voice) L.item = GD.Speech.line(m.voice, m.made);   // it joins the queue now, and speaks as its sentences complete
    } else if (!L) {
      return;
    } else if (m.t === "txt") {
      L.text += m.d; L.p.textContent = L.text;
      if (L.item) L.item.add(L.text);
    } else if (m.t === "end") {
      L.ended = true; L.text = m.text; L.p.textContent = m.text; L.el.classList.remove("live");
      if (L.item) L.item.finish(m.text);
    } else if (m.t === "drop") {
      liveDrop(m.key);
    }
    if (stick) box.scrollTop = box.scrollHeight;
  }
  /** The stream has ended: a line left unfinished is withdrawn (the state request brings it). */
  function liveOver() {
    Object.keys(liveLines).forEach(key => { if (!liveLines[key].ended) liveDrop(key); });
    liveLines = {}; liveDead = {};
  }

  /* ---------- the system's roll, shown ---------- */
  /* When the system rolls the d20 the die tumbles for a few seconds before the result is given. It starts the moment
     the captain says Proceed, while the order is resolved, and lands on the number the server rolled once that is
     known, never sooner than DIE_MIN after it started. The number shown is always the server's: nothing is rolled here. */
  function freshRoll(list) {
    return list.find(e => e.type === "turn" && e.id > lastEvent && e.roll && (e.roll.source === "system" || e.roll.source === "system_timeout") && !rolled[e.id]) || null;
  }
  function dieOpen(info) {
    if (die || !$("#die-slot")) return;
    const el = document.createElement("div"); el.className = "die"; el.setAttribute("role", "status");
    el.innerHTML = `<svg width="78" height="78" viewBox="0 0 78 78" aria-hidden="true"><polygon points="39,4 72,22 72,56 39,74 6,56 6,22" fill="rgba(54,226,255,.12)" stroke="#36E2FF" stroke-width="2"></polygon><text x="39" y="49" text-anchor="middle" class="face"></text></svg><div><div class="lbl who" style="color:var(--c1-3)">d20 // system roll</div><div class="out"><span class="need"></span> <span class="res" aria-live="assertive"></span></div></div>`;
    $("#die-slot").appendChild(el);
    const still = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    die = { el, num: el.querySelector(".face"), at: Date.now(), roll: null, id: 0, last: 0, still, spin: 0, timers: [], cancelFrom: 0 };
    dieInfo(info);
    die.num.textContent = still ? "··" : "";
    if (!still) { dieFlick(); die.spin = setInterval(dieFlick, 70); }
    const box = $("#lines"); box.scrollTop = box.scrollHeight;
  }
  function dieInfo(info) {
    if (!die || !info) return;
    if (info.officer) die.el.querySelector(".who").textContent = "d20 // " + info.officer + (info.role ? ", " + info.role : "");
    if (info.needed !== undefined) die.el.querySelector(".need").textContent = info.needed == null ? "Only a natural 20 will do." : "Needs " + info.needed + " or more.";
  }
  /** Show another face, never the same one twice running. */
  function dieFlick() { if (!die) return; let n; do { n = 1 + Math.floor(Math.random() * 20); } while (n === die.last); die.last = n; die.num.textContent = n; }
  /** The server's roll is known: land on it when the die has tumbled long enough. */
  function dieTarget(e) {
    die.roll = e.roll; die.id = e.id;
    dieInfo({ officer: /system roll$/.test(die.el.querySelector(".who").textContent) ? e.roll.officer : "", needed: e.roll.needed });
    die.timers.push(setTimeout(dieLand, Math.max(600, die.at + DIE_MIN - Date.now())));
  }
  function dieLand() {
    if (!die) return;
    clearInterval(die.spin);
    const steps = die.still ? [] : [110, 150, 200, 260, 340];
    let t = 0;
    steps.forEach(ms => { t += ms; die.timers.push(setTimeout(dieFlick, t)); });   // slowing down
    die.timers.push(setTimeout(() => {
      if (!die) return;
      const r = die.roll;
      die.num.textContent = r.value; die.el.classList.add("landed", r.outcome);
      const res = die.el.querySelector(".res"); res.className = "res " + r.outcome; res.textContent = cap(r.outcome).replace(/^./, c => c.toUpperCase()) + ".";
      die.timers.push(setTimeout(() => { dieClose(); liveRun(); poll(); }, DIE_SHOW));   // now the result and the report are shown and spoken
    }, t + (die.still ? 0 : 420)));
  }
  function dieClose() {
    if (!die) return;
    clearInterval(die.spin); die.timers.forEach(clearTimeout);
    if (die.id) rolled[die.id] = true;
    die.el.remove();
    die = null;
  }
  /** The captain has answered the Computer's "Proceed?": the Computer stops talking, and on Proceed the die starts if a system roll follows. */
  function answered(proceed) {
    const p = S && S.pending;
    if (!p || p.type !== "dialogue" || p.kind !== "confirm") return;
    GD.Speech.stop();
    if (proceed && p.roll && !busy && !S.pause) dieOpen(p.roll);
  }
  function send(text) {
    text = String(text || "").trim();
    if (!text || busy || !S || S.pause) return;
    if (selected && /\b(selected|that sector|this sector|there)\b/i.test(text) && !text.includes(selected)) text += " (selected sector: " + selected + ")";
    const i = $("#cmd-in"); i.value = ""; typed = false;
    answered(YES.includes(text.toLowerCase().replace(/[.!,]+$/, "").replace(/\s+/g, " ")));   // an answer in words, or a new order, also cuts the Computer off
    const p = act("/command", { text });
    if (p) p.then(() => { const n = $("#cmd-in"); if (n && !$("#cmd").hidden && S && S.audio.text) n.focus(); });
  }

  /* ===================================================================== the game menu */
  function toggleAudio(k) {
    const b = {}; b[k] = !S.audio[k];
    GD.api("POST", GD.game("/audio"), b).then(r => { S.audio = r.audio; if (k === "tts" && !r.audio.tts) GD.Speech.stop(); render(); }).catch(() => {});
  }
  function menu(s) {
    const items = [];
    if (s.status === "active") items.push({ id: "pause", label: s.pause ? "Resume" : "Pause", hot: !!s.pause, disabled: !!(s.pause && s.pause.reason !== "manual"), on: () => GD.api("POST", GD.game("/pause"), { on: S.pause ? 0 : 1 }).then(poll).catch(() => {}) });
    items.push({ id: "tts", label: "Voice", state: s.audio.tts, title: "Speech out " + (s.audio.tts ? "on" : "off"), on: () => toggleAudio("tts") });
    items.push({ id: "stt", label: "Mic", state: s.audio.stt, title: "Speech in " + (s.audio.stt ? "on" : "off"), on: () => toggleAudio("stt") });
    items.push({ id: "text", label: "Text", state: s.audio.text, title: "Text " + (s.audio.text ? "on" : "off"), on: () => toggleAudio("text") });
    items.push({ id: "vol", label: "Vol " + Math.round(GD.Speech.volume * 100) + "%", title: "Volume", on: () => { GD.Speech.setVolume(GD.Speech.volume <= 0.26 ? 1 : GD.Speech.volume - 0.25); menu(S); } });
    items.push({ id: "log", label: "Log", title: "Ship's log", on: shipsLog });
    items.push({ id: "help", label: "Help", on: help });
    GD.store.captains.forEach(c => { if (GD.store.captains.length > 1 && c.id !== s.me.id) items.push({ id: "seat" + c.id, label: "Switch to " + c.name, on: () => { GD.store.active = c.id; GD.saveStore(); GD.bridge(); } }); });
    items.push({ id: "leave", label: "Leave", on: leave });
    const nav = $("#br-nav"), sig = JSON.stringify(items.map(b => [b.id, b.label, b.state, b.disabled, b.hot]));
    if (nav.dataset.sig === sig) return;
    nav.dataset.sig = sig;
    nav.innerHTML = items.map(b => `<button type="button" class="btn${b.state === true ? " on" : b.state === false ? " off" : ""}${b.hot ? " btn-hot" : ""}" data-menu="${esc(b.id)}"${b.state != null ? ` aria-pressed="${b.state}"` : ""}${b.title ? ` title="${esc(b.title)}"` : ""}${b.disabled ? " disabled" : ""}>${esc(b.label)}</button>`).join("");
    items.forEach(b => { const n = $(`[data-menu="${b.id}"]`, nav); if (n) n.addEventListener("click", b.on); });
  }
  function sheet(ix, title, html) {
    const el = $("#v-sheet");
    el.innerHTML = `<div class="hud" role="dialog" aria-labelledby="sheet-h"><h2 class="hud-h" id="sheet-h"><span class="ix">${ix}</span>${esc(title)}</h2>${html}<div class="btns" style="padding-top:16px"><button class="btn" type="button" id="sheet-close">Close</button></div></div>`;
    el.hidden = false;
    $("#sheet-close").addEventListener("click", () => { el.hidden = true; });
    el.firstChild.scrollTop = 0;
  }
  function shipsLog() {
    GD.api("GET", GD.game("/log")).then(r => {
      sheet("LOG", "Ship's log // " + (r.title || ""), `<div class="log-sheet">` + r.entries.map(e => {
        if (e.type === "turn") return `<div class="msg capt"><div class="who"><b><span class="dia"></span>Turn ${e.turn} · ${esc(e.captain)}</b><span class="lbl">Captain</span></div><p>${esc(e.text)}</p></div>` +
          (e.roll ? `<div class="chips"><span>${esc(e.roll.attribute)}</span><span>Rolled ${e.roll.value}${e.roll.needed == null ? " · needed a natural 20" : " · needed " + e.roll.needed} (${cap(e.roll.source)})</span><span class="${esc(e.roll.outcome)}">${cap(e.roll.outcome)}</span></div>` : "") +
          (e.lines || []).map(l => lineEl(l, "")).join("");
        if (e.type === "narration") return (e.lines || []).map(l => lineEl(l, "")).join("");
        if (e.type === "notice") return `<div class="msg note"><div class="who"><b><span class="dia"></span>${esc(e.speaker || "Bridge")}</b><span class="lbl">Notice</span></div><p>${esc(e.text)}</p></div>`;
        return "";
      }).join("") + `</div>`);
    }).catch(e => GD.error(e, "#err"));
  }
  function help() {
    sheet("?", "Help", `<div class="stack" style="max-width:72ch">
      <p>You are the Captain. Give every order in your own words, typed or spoken: there are no action buttons. Your crew, the Computer or whoever you are talking to will answer.</p>
      <p><b>Turns.</b> The game is played one captain at a time, in the order you joined. Your turn has 20 turn points and every order spends some. When they are spent, or you set a course, or you say "end turn", it is the next captain's turn. Playing alone, your next turn follows at once with a fresh 20.</p>
      <p><b>Missions.</b> A mission begins the moment your ship enters its sector: there is nothing to accept. It has 1 to 10 stages, and each stage gives you 20 turn points that last the whole stage. Every stage ends with its main task, the decisive action named at the top of the screen.</p>
      <p><b>Costs.</b> Asking the Computer for information is free. Moving the ship or yellow alert costs 1 point, red alert 2. Asking an officer for advice costs 3. Actions that could change the outcome cost 1 to 3 and need a d20 roll. When a stage begins, your crew tell you what has to be achieved, never how: achieve it any way that would work. The order that goes for it outright is your decisive move, and it costs ${S && S.stage ? S.stage.climax_cost : 3}.</p>
      <p><b>Rolls.</b> Before any order that costs turn points or goes to the dice, the Computer tells you the cost, sums up the situation and says what the die must show, then asks whether to proceed. Say yes or no, press a button, or simply give a different order. Each new kind of successful action builds Momentum, which lowers the target of your decisive move.</p>
      <p><b>Running out.</b> When your points fall below the cost of the decisive move, you must make it or retreat. Retreating leaves the sector; you are told first whether the mission will fail or be held for your return.</p>
      <p><b>The star chart.</b> Drag to orbit, right-drag or shift-drag to pan, scroll to zoom, click a sector to read it. The sphere shows how far you can jump this turn. Say where you want to go.</p>
      <p><b>Finding missions.</b> Missions are not listed ahead of time. The story points the way: your opening orders from Concord Fleet Command, and what each mission turns up, are logged under Leads with a sector. Go there and your crew will report what they find. Other missions are found by exploring.</p>
      <p><b>Speaking.</b> With Mic turned on, hold the space bar or the speak button while you talk, and let go when you are done. What was heard waits two seconds in the box before it is sent, so you can correct it, or say "belay that". Speak to an officer by name or title and that officer answers.</p>
      <p><b>Fleets.</b> Ask to join another captain's fleet, or ask them to join yours. A fleet travels together, takes turns in order and shares Momentum. Some critical missions need more than one captain.</p></div>`);
  }
  function leave() {
    sheet("!", "Leave game", `<p>Your ship stays in the game and you can return at any time from the start screen. While you are away the other captains are told you have disconnected.</p><div class="btns" style="padding-top:14px"><button class="btn warn" type="button" id="b-leave">Leave now</button></div>`);
    $("#b-leave").addEventListener("click", () => {
      GD.leaveScreen();
      GD.show(`<div class="gd-root warm">${GD.top("You have left // your seat is kept")}<main class="gd-page"><div class="gd-col">${GD.panel("01", "You have left", `<p>Return whenever you want: your seat is kept.</p><div class="btns" style="padding-top:14px"><button class="btn btn-hot" type="button" id="b-return">Return to the bridge</button><button class="btn" type="button" id="b-start">Back to the start</button></div>`)}</div></main></div>`);
      $("#b-return").addEventListener("click", GD.enter);
      $("#b-start").addEventListener("click", GD.connect);
    });
  }

  /* ===================================================================== voice out and voice in */
  function speech(s) {
    if (!s.audio.tts && GD.Speech.speaking()) GD.Speech.stop();
  }
  /* A heard phrase waits in the order box for two seconds before it is sent, so a mishearing can be caught: say
     "belay that", speak again to replace it, or edit it by hand. '' cancels; null only stops the clock. */
  let sendIn = 0;
  function holdSpoken(text) {
    clearInterval(spokenTimer); spokenTimer = 0; sendIn = 0;
    const i = $("#cmd-in");
    if (text === "" && i) i.value = "";
    if (!text) { micLabel(); return; }
    sendIn = 2; micLabel();
    spokenTimer = setInterval(() => {
      sendIn--;
      if (sendIn > 0) { micLabel(); return; }
      clearInterval(spokenTimer); spokenTimer = 0; sendIn = 0;
      micLabel();
      const n = $("#cmd-in"); if (n && n.value.trim()) send(n.value);
    }, 1000);
  }
  /* The microphone may open: speech in is on, the game is running and not paused, and no question other than
     "Proceed?" is waiting (those are answered with their buttons). */
  function micAllowed() {
    if (!S) return false;
    const asked = S.pending && !(S.pending.type === "dialogue" && S.pending.kind === "confirm");
    return !!(S.audio.stt && GD.Mic.available() && S.status === "active" && !S.pause && !asked && !S.safety);
  }
  function micLabel() {
    const mic = $("#mic"), st = $("#mic-state"); if (!mic || !S) return;
    const rec = GD.Mic.state === "recording";
    st.textContent = sendIn ? "Sending in " + sendIn : !S.audio.stt ? "Mic off" : !GD.Mic.available() ? "No mic support" : rec ? "Listening" : GD.Mic.state === "working" ? "Hearing" : "Hold to talk";
    mic.classList.toggle("live", rec); st.classList.toggle("live", rec || !!sendIn);
    mic.disabled = !S.audio.stt || !GD.Mic.available();
  }
  /** Press and hold to speak; let go to finish. Holding it while the game is speaking cuts the speech short. */
  function talk(on) {
    if (on === talking) return;
    talking = on;
    if (on) {
      if (!micAllowed()) { talking = false; return; }
      if (GD.Speech.speaking()) GD.Speech.stop();   // the microphone never hears the game's own voice
      holdSpoken(null);
      GD.Mic.hold(heard => {
        const i = $("#cmd-in"); if (!i || left) return;
        if (!heard) { GD.toast("No speech was heard. Hold the button or the space bar while you speak."); return; }
        if (typed) return;   // never over a half-typed order
        if (BELAY.test(heard) && !(S.pending && S.pending.kind === "confirm")) return holdSpoken("");
        i.value = heard;
        holdSpoken(heard);
      });
    } else GD.Mic.release();
    micLabel();
  }
  /** The space bar is the same button, unless an order is being typed. */
  function talkKey(ev) {
    if (ev.code !== "Space" || !$("#mic") || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const t = ev.target, field = t && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName), cmd = t && t.id === "cmd-in";
    if (field && !(cmd && (t.value === "" || talking))) return;
    if (t && t.closest && t.closest(".veil")) return;
    ev.preventDefault();
    if (ev.type === "keydown" && !ev.repeat) talk(true); else if (ev.type === "keyup") talk(false);
  }
})();
