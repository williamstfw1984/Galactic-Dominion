"use strict";
/* The turn cycle (§7.2.2), ported from the plugin's class-turn.php: Call A adjudicates, the game prices, rolls and
   resolves, Call B narrates. Also stages (§7.6), threats (§7.2.3), retreat and leaving (§6.4), fleets (§3.3.1),
   travel (§7.4) and items (§7.3). Every entry point runs under the game lock, so one turn resolves at a time.

   The app's safety check (docs/PORT.md) is added here: every order is checked before it is acted on, and every line
   the turn would show before it is shown. A flagged order or line puts its captain's turn on hold (g.holds); only
   that captain is told why (w.tell, and the streamed reply when it is theirs); nothing about it is logged.

   `live` is the streamed reply of the request being served, or null: { cid, send(message) }. */
const Rules = require("./rules.js");
const Engine = require("./engine.js");
const Grid = require("./grid.js");
const Advice = require("./advice.js");
const Prompts = require("./prompts.js");
const Game = require("./game.js");
const Generator = require("./generator.js");
const Context = require("./context.js");
const setting = require("./setting.js");
const T = require("./text.js");

const { GdError, isErr, fail, time, hashPick, randomHex, mbSubstr, stripAllTags, empty, toList } = T;
const View = () => require("./view.js");
const own = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const uniq = list => [...new Set(list)];
const isArr = v => v !== null && typeof v === "object";

// TUNABLE chances (percent), all rolled from the game seed so they are reproducible.
const CHANCE_EXPLORE_ITEM = 15; // first scan or visit of a sector: "sometimes a Standard consumable"
const CHANCE_CRIT_ITEM = 10;    // critical success on a rolled action: "small chance of a Standard item"
const CHANCE_CLIMAX_ITEM = 60;  // critical-success climax: "a reward item is likely"
const CHANCE_RANDOM_EVENT = 15; // arriving in a sector with no mission
const RETREAT_COST = 2;         // a retreat is priced as a Tier 2 manoeuvre
const RETRY_EVERY = 8;          // seconds between attempts at work held for a failed model call

/* The app's words when the safety check cannot run (renderer/index.html), for a turn rather than a roleplay. */
const UNCHECKED = "The safety check could not run, so the turn has stopped.";
const unchecked = why => fail("gd_safety_unchecked", UNCHECKED, 503, { why });

class Turn {
  constructor(w, g, caps, cid, live = null) {
    this.w = w;
    this.g = g;
    this.caps = caps;
    this.cid = Rules.intval(cid);
    this.live = live;
    this.notes = [];
    this.changes = [];  // what the engine changed this turn, shown under the turn in the log
    this.touched = {};  // role -> what happened at that officer's station this turn
    this.freshStage = false;
    this.gained = [];   // items newly taken aboard this turn: [cid, slot key, item id]
    this.stopped = null; // the safety check could not run on something this turn would have shown
  }

  /* =================================================================== entry points */

  static async run(w, gameId, cid, fn, live = null) {
    return Game.withLock(w, gameId, async g => {
      const t = new Turn(w, g, Game.captains(w, g.id), cid, live);
      if (!t.caps.has(t.cid)) return fail("gd_no_captain", "You are not a captain in this game.", 403);
      const res = await fn(t);
      t.commit();
      return res;
    });
  }

  commit() {
    for (const c of this.caps.values()) Game.saveCaptain(this.w, c);
    Game.save(this.w, this.g);
  }

  /* A captain's free-text order. */
  static async command(w, gameId, cid, text, live = null) {
    text = stripAllTags(String(text ?? "")).trim();
    if (text === "") return fail("gd_empty", "Say or type a command first.", 400);
    text = mbSubstr(text.replace(/\s+/g, " ").trim(), 0, 600); // one line: nothing in it can pose as a new section of a prompt
    // The safety check, before anything is done with the order. Flagged: it is not carried out and costs nothing.
    let flagged = false;
    if (typeof w.safety === "function") {
      try {
        flagged = !!(await w.safety({ fromUser: true, text }));
      } catch (e) {
        return unchecked(String((e && e.message) || e));
      }
    }
    if (flagged) {
      return Turn.run(w, gameId, cid, async t => {
        t.hold("order");
        return { ok: true, held: true };
      }, live);
    }
    return Turn.run(w, gameId, cid, async t => {
      // The Computer's "Proceed?" may be answered in words. Anything else is a new order, which replaces the old one.
      const p = t.state().pending;
      if (p && p.type === "dialogue" && (p.kind ?? "") === "confirm" && t.g.status === "active" && !t.g.pause && !t.held()) {
        const word = text.toLowerCase().replace(/^[ .!,\t]+|[ .!,\t]+$/g, "");
        if (["yes", "aye", "proceed", "yes proceed", "make it so", "engage", "do it", "confirmed", "affirmative", "go ahead", "go"].includes(word)) return t.answerDialogue("proceed");
        if (["no", "belay", "belay that", "cancel", "negative", "stop", "abort", "never mind"].includes(word)) return t.answerDialogue("belay");
        t.caps.get(t.cid).state.pending = null;
      }
      t.syncTurn();
      const err = t.guard();
      if (err) return err;
      t.g.turn_clock = { cid: t.cid, since: time() }; // the turn timer runs from the last order given
      t.processArrivals();
      await t.openTurn();
      const a = await t.adjudicate(text);
      if (isErr(a)) return a;
      return t.route(text, a);
    }, live);
  }

  /* Physical dice: the player enters the face value (§7.2.5). */
  static submitRoll(w, gameId, cid, value, live = null) {
    return Turn.run(w, gameId, cid, async t => {
      if (t.g.status !== "active" || t.g.pause) return fail("gd_paused", "The game is paused.", 409);
      const p = t.state().pending;
      if (!p || p.type !== "roll") return fail("gd_no_roll", "No roll is waiting.", 409);
      const n = Engine.validDie(Number.isInteger(value) ? value : String(value ?? "").trim());
      if (n === null) return fail("gd_bad_roll", "Enter the number showing on your d20: a whole number from 1 to 20.", 400);
      t.caps.get(t.cid).state.pending = null;
      if (t.lapsed(p.params)) return t.lapseRoll(p.params);
      return t.resolveRoll(p.params, n, "manual", null);
    }, live);
  }

  /* Answer a system dialogue (leave warning, out-of-range travel, item request, confirmation). */
  static answer(w, gameId, cid, choice, live = null) {
    return Turn.run(w, gameId, cid, async t => {
      if (t.g.status !== "active" || t.g.pause) return fail("gd_paused", "The game is paused.", 409);
      if (t.held()) return fail("gd_hold", "Your turn is on hold.", 409);
      return t.answerDialogue(choice);
    }, live);
  }

  /* The captain carries on after the safety check's help screen: after an order it is their turn again; after a
     line the turn goes on without it. A game-wide pause that the hold brought on ends with it. */
  static carryOn(w, gameId, cid, live = null) {
    return Turn.run(w, gameId, cid, async t => {
      if (!t.held()) return { ok: true };
      delete t.g.holds[t.cid];
      if (t.g.pause && t.g.pause.reason === "hold" && Rules.intval(t.g.pause.captain) === t.cid) {
        t.g = Game.clearPause(t.w, t.g, t.cid);
      }
      if (Turn.holder(t.g) === t.cid) t.g.turn_clock = { cid: t.cid, since: time() };
      return { ok: true };
    }, live);
  }

  async answerDialogue(choice) {
    const p = this.state().pending;
    if (!p || p.type !== "dialogue") return fail("gd_no_dialogue", "Nothing is waiting for an answer.", 409);
    this.caps.get(this.cid).state.pending = null;
    if (p.stamp !== undefined && (p.kind === "confirm" ? this.lapsed(p) : p.stamp !== this.stamp())) {
      return this.systemLine("That question no longer applies: the situation has changed. Give a new order.");
    }
    const yes = ["yes", "leave", "accept", "go", "give", "retreat", "proceed"].includes(choice);
    switch (p.kind) {
      case "leave":
        return yes ? this.doLeave(p) : this.systemLine("Staying. Choose another action.");
      case "travel_partial":
        return yes ? this.doTravel(p.partial, p.text) : this.systemLine("Course cancelled. Choose a destination within range.");
      case "item_request":
        return yes ? this.doTransfer(this.cid, Rules.intval(p.from), p.item, true) : this.declineItem(p);
      case "confirm": {
        if (!yes) return this.systemLine("Order belayed. Nothing was spent.");
        const a = Object.assign({}, p.a, { confirmed: true });
        return p.via === "use_item" ? this.useItem(p.text, a) : this.action(p.text, a);
      }
    }
    return { ok: true };
  }

  /* Work that was held because the model could not be had: reports, recovery stages, new orders, a late joiner's
     briefing. It can take as long as the model takes, so it never runs inside a status request. */
  static async work(w, gameId, live = null) {
    const g = Game.get(w, gameId);
    if (g && !g.pause && ["active", "ended"].includes(g.status)) {
      if (Game.needsLeads(g)) await Game.withLock(w, gameId, async fresh => Game.save(w, await Game.writeLeads(w, fresh)));
      await Turn.heldWork(w, gameId, live);
    }
  }

  /* Whether anything is held for this game, so the page knows to ask for it. */
  static hasWork(w, gameId, caps) {
    const g = Game.get(w, gameId);
    if (g && Game.needsLeads(g)) return true;
    for (const c of caps.values()) {
      if (!empty(c.state.narration) || !empty(c.state.briefing) || !empty(c.state.joining)) return true;
    }
    for (const m of Game.missions(w, gameId, ["active", "failed"]).values()) {
      if (!empty(m.data.progress?.recovery_pending) || !empty(m.data.bridge_pending)) return true;
    }
    return false;
  }

  /* Server-authoritative timers (§7.2.5, §14.5 rule 6): the turn timer, and at a roll's deadline the game rolls on
     the player's behalf. Run on every status request and on the server's timer. */
  static async tick(w, gameId) {
    const g = Game.get(w, gameId);
    if (!g || g.pause || g.status !== "active") return;
    const holder = Turn.holder(g);
    const clock = g.turn_clock ?? null;
    if (holder && (Rules.intval(g.turn_of ?? 0) !== holder || !clock || Rules.intval(clock.cid) !== holder || time() - Rules.intval(clock.since) >= Game.setting(w, "turn_timeout"))) {
      await Turn.run(w, gameId, holder, async t => {
        if (t.g.status === "active" && !t.g.pause) t.turnTick();
        return null;
      });
    }
    for (const [cid, c] of Game.captains(w, gameId)) {
      const p = c.state.pending ?? null;
      if (p && p.type === "roll" && time() >= Rules.intval(p.deadline)) {
        await Turn.run(w, gameId, cid, async t => {
          const q = t.state().pending;
          if (!q || q.type !== "roll" || time() < Rules.intval(q.deadline) || t.g.pause) return null;
          t.caps.get(t.cid).state.pending = null;
          if (t.lapsed(q.params)) return t.lapseRoll(q.params);
          const seed = Engine.newSeed();
          t.note("No roll was entered in time, so the roll was made automatically.");
          return t.resolveRoll(q.params, Engine.d20FromSeed(seed), "system_timeout", seed);
        });
      }
    }
  }

  /* Work held back because a model call failed is retried here until it succeeds: a turn's report, a recovery
     stage, a bridge mission. Nothing is substituted meanwhile. Also brings in a captain who accepted a fleet
     request when the requester has gone quiet. */
  static async heldWork(w, gameId, live) {
    const name = "held_" + gameId;
    if (!(await w.store.lock(name, 0))) return; // another request is already on it
    try {
      const now = time();
      const caps = Game.captains(w, gameId);
      for (const [cid, c] of caps) {
        const n = c.state.narration ?? null;
        if (n && now - Rules.intval(n.tried) >= RETRY_EVERY) await Turn.retryNarration(w, gameId, cid, live);
        const b = c.state.briefing ?? null;
        if (b && now - Rules.intval(b.tried) >= RETRY_EVERY) await Turn.run(w, gameId, cid, t => t.briefJoiner(), live);
        if (!empty(c.state.joining) && now - Rules.intval(c.state.joining_at ?? now) >= Game.setting(w, "roll_timeout")) await Turn.run(w, gameId, cid, async t => t.arriveOverdue(), live);
      }
      for (const m of Game.missions(w, gameId, ["active", "failed"]).values()) {
        const rp = m.data.progress?.recovery_pending ?? null;
        const bp = m.data.bridge_pending ?? null;
        const owners = toList(m.data.progress?.owners ?? []).filter(o => caps.has(o));
        const who = owners.length ? owners[0] : [...caps.keys()][0];
        if (m.status === "active" && rp && now - Rules.intval(rp.tried) >= RETRY_EVERY) await Turn.run(w, gameId, who, t => t.retryRecovery(m.id), live);
        if (m.status === "failed" && bp && now - Rules.intval(bp.tried) >= RETRY_EVERY) await Turn.run(w, gameId, who, t => t.retryBridge(m.id), live);
      }
    } finally {
      w.store.unlock(name);
    }
  }

  /* Continue a held report. The model is called with the game lock released, so a slow model holds up nobody
     else's orders; the lock is taken only to read what is needed and to write the result. */
  static async retryNarration(w, gameId, cid, live) {
    const input = await Turn.run(w, gameId, cid, async t => {
      const h = t.state().narration ?? null;
      if (!h) return null;
      t.caps.get(t.cid).state.narration.tried = time();
      return { h: JSON.parse(JSON.stringify(h)), g: JSON.parse(JSON.stringify(t.g)), caps: new Map([...t.caps].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])), party: t.narrationScene(h)[0] };
    });
    if (!input || isErr(input)) return;
    const t = new Turn(w, input.g, input.caps, cid, live);
    const n = await t.narrateCall(input.h, 1, input.party);
    await Turn.run(w, gameId, cid, async t2 => {
      const h = t2.state().narration ?? null;
      // Only if this is still the report that was being continued, at the point it was continued from.
      if (!h || h.event !== input.h.event || toList(h.said ?? []).length !== toList(input.h.said ?? []).length) return null;
      const [party, here] = t2.narrationScene(h);
      return t2.narrateApply(h, n, party, here);
    }, live);
  }

  /* Where a held report belongs: if the ship has since moved on, it is narrated against that place as it was.
     Returns [party to narrate against, whether the ship is still there]. */
  narrationScene(h) {
    const now = this.g.parties[this.pid()];
    const was = h.party ?? null;
    const key = p => JSON.stringify(p.position) + "|" + (p.stage ? p.stage.mission_id + ":" + p.stage.idx : "");
    return !was || key(was) === key(now) ? [now, true] : [was, false];
  }

  /* Narrate a recorded turn into the log. Each line is written the moment it is ready. If the report cannot be
     finished now, what was said stands and the remainder is held, to be continued from that point. */
  async narrateInto(h, attempts) {
    const [party, here] = this.narrationScene(h);
    return this.narrateApply(h, await this.narrateCall(h, attempts, party), party, here);
  }

  narrateCall(h, attempts, party) {
    const w = this.w, gid = this.g.id, turn = this.g.turn, cid = this.cid;
    return Context.narrate(w, this.g, this.caps.get(this.cid), party, this.caps, h.a, h.text, h.result, h.actor, {
      attempts,
      skipEvent: h.event,
      said: toList(h.said ?? []),
      touched: h.touched ?? {},
      live: this.live,
      onLine: async line => w.store.event(gid, cid, "narration", { ref: h.event, lines: [line], audience: h.audience }, turn)
    });
  }

  /* here: whether the ship is still where the turn happened. If not, the report changes nothing where it is now. */
  narrateApply(h, n, party, here) {
    h.party = h.party ?? party;
    if (!n || n.nothing) {
      h.tried = time();
      this.caps.get(this.cid).state.narration = h;
      if (n && n.unchecked) this.stopped = n.unchecked;
      return null;
    }
    const [g, c, after, nn] = Context.applyWorld(this.w, this.g, this.caps.get(this.cid), party, n, h.a);
    this.g = g;
    const done = empty(nn.incomplete);
    c.state.narration = done ? null : Object.assign({}, h, { said: nn.lines, tried: time() });
    this.caps.set(this.cid, c);
    if (here) this.g.parties[this.pid()] = after;
    if (done) this.nameItems(nn, toList(h.gained ?? []));
    this.w.store.eventMerge(this.g.id, h.event, { lines: nn.lines, narration_pending: !done });
    if (nn.flagged) this.hold("line");
    if (nn.unchecked) this.stopped = nn.unchecked;
    return done ? true : null;
  }

  /* ---------- the safety hold ---------- */

  held(cid = null) {
    return !!(this.g.holds && this.g.holds[cid ?? this.cid]);
  }

  /* Put this captain's turn on hold, and tell only them why. kind: 'order' | 'line'. */
  hold(kind) {
    if (!this.g.holds) this.g.holds = {};
    const id = randomHex(4);
    this.g.holds[this.cid] = { kind, id, at: time() };
    const msg = { t: "safety", kind, id, fromUser: kind === "order" };
    if (this.live && Rules.intval(this.live.cid) === this.cid) this.live.send(msg);
    if (typeof this.w.tell === "function") this.w.tell(this.g.id, this.cid, msg);
  }

  /* Write a late joiner's briefing from the campaign so far (§3.5). Retried until it succeeds. */
  async briefJoiner() {
    const b = this.state().briefing ?? null;
    if (!b || !this.caps.has(b.from)) {
      this.caps.get(this.cid).state.briefing = null;
      return null;
    }
    const p1 = this.caps.get(b.from);
    const turns = Context.recent(this.w, this.g, p1, Game.setting(this.w, "summary_every") + Game.setting(this.w, "recent_window"));
    const res = await this.w.llm.call("summary", Prompts.summarySystem(), "PREVIOUS SUMMARY\n" + (p1.state.summary || "(none yet)") + "\n\nTURNS SINCE\n" + turns.join("\n") + "\n\nThis summary briefs the crew of a ship that has just joined the campaign.", { maxTokens: 6000, store: this.w.store, gameId: this.g.id, captainId: this.cid });
    if (isErr(res) || res.text.trim() === "") {
      this.caps.get(this.cid).state.briefing.tried = time();
      return null;
    }
    this.caps.get(this.cid).state.summary = res.text.trim() + " " + Game.sharedSummary(this.w, this.g);
    this.caps.get(this.cid).state.briefing = null;
    this.notice("Your crew has been briefed on the campaign so far.", [this.cid]);
    return true;
  }

  arriveOverdue() {
    const pid = this.state().joining ?? "";
    if (pid && this.g.parties[pid]) {
      this.mergeInto(this.cid, pid);
      this.notice(this.cap().name + " of the " + this.state().ship.name + " has arrived and joined the fleet.", this.g.parties[pid].members);
    }
    this.caps.get(this.cid).state.joining = "";
    return true;
  }

  async retryRecovery(missionId) {
    const m = Game.missions(this.w, this.g.id).get(missionId) ?? null;
    const rp = m?.data?.progress?.recovery_pending ?? null;
    if (!rp) return null;
    const def = await Generator.recoveryStage(this.w, this.g, m, rp.stage, rp.why);
    if (!def) {
      m.data.progress.recovery_pending.tried = time();
      Game.saveMission(this.w, m);
      return null;
    }
    delete m.data.progress.recovery_pending;
    m.data.progress.recovery_def = def;
    Game.saveMission(this.w, m);
    const party = this.party();
    if (!party.stage && party.position === m.sector && toList(m.data.progress.owners).includes(this.cid)) {
      const intro = this.beginStage(Game.missions(this.w, this.g.id).get(missionId));
      this.notice('"' + m.data.title + '" is not over. Your crew will report.', null, { speaker: "Mission update" });
      const st = this.state();
      st.opening = (String(st.opening ?? "") + " " + intro).trim(); // the crew say what it asks for, with the next order
    } else {
      this.notice('The recovery stage of "' + m.data.title + '" is ready in sector ' + m.sector + ".", toList(m.data.progress.owners), { speaker: "Mission update" });
    }
    return true;
  }

  async retryBridge(missionId) {
    let m = Game.missions(this.w, this.g.id).get(missionId) ?? null;
    if (!m || empty(m.data.bridge_pending)) return null;
    const mid = await Generator.bridge(this.w, this.g, m, m.data.bridge_pending.why);
    if (!isErr(mid) && mid) [this.g] = Game.openLeads(this.w, this.g); // new orders say where to go
    m = Game.missions(this.w, this.g.id).get(missionId);
    if (isErr(mid)) {
      m.data.bridge_pending.tried = time();
      Game.saveMission(this.w, m);
      return null;
    }
    delete m.data.bridge_pending;
    Game.saveMission(this.w, m);
    const b = Game.missions(this.w, this.g.id).get(mid);
    this.notice("New orders: " + b.data.title + " (sector " + b.sector + "). " + b.data.briefing, "all", { speaker: setting.FLEET_COMMAND });
    return true;
  }

  /* Allocate the Engineer's bonus ship points at game start (§4.2.1). */
  static allocateBonus(w, gameId, cid, alloc) {
    return Turn.run(w, gameId, cid, async t => {
      if (t.g.status !== "active" || t.g.pause) return fail("gd_paused", "The game is not running.", 409);
      const ship = t.state().ship;
      const out = {};
      for (const a of Object.keys(Rules.shipAttributes())) out[a] = Math.max(0, Rules.intval(alloc?.[a] ?? 0));
      if (Object.values(out).reduce((x, y) => x + y, 0) !== Rules.intval(ship.bonus_pool)) return fail("gd_alloc", "Place exactly " + Rules.intval(ship.bonus_pool) + " bonus points.", 400);
      if (!empty(ship.bonus_done)) return fail("gd_alloc", "The bonus points have already been placed.", 409);
      ship.bonus_alloc = out;
      ship.bonus_done = true;
      return { ok: true };
    });
  }

  /* =================================================================== small accessors */

  cap(cid = null) { return this.caps.get(cid ?? this.cid); }
  state(cid = null) { return this.caps.get(cid ?? this.cid).state; }
  pid(cid = null) { return this.state(cid).party; }
  party(cid = null) { return this.g.parties[this.pid(cid)]; }
  note(text) { this.notes.push(text); }
  isDropped(cid) { return (this.g.dropped ?? []).includes(Rules.intval(cid)); }

  /* Party members who are playing the current stage, in the fixed turn order: connected, and not sitting out the
     round they joined in. If nobody else is left to play, the bench is treated as cleared. */
  static stageOrder(g, party) {
    const dropped = g.dropped ?? [];
    const bench = toList(party.stage?.bench ?? []);
    const active = [];
    const waiting = [];
    for (let cid of g.order) {
      cid = Rules.intval(cid);
      if (!party.members.includes(cid) || dropped.includes(cid)) continue;
      if (bench.includes(cid)) waiting.push(cid);
      else active.push(cid);
    }
    if (!active.length || !waiting.length) return active.length ? active : waiting;
    for (const cid of active) {
      if (!Engine.climaxForced(Rules.intval(party.stage.points?.[cid] ?? 0))) return active;
    }
    // Everyone playing is out of points: the round is over in all but name, so the waiting captains are in.
    return g.order.map(Rules.intval).filter(cid => active.includes(cid) || waiting.includes(cid));
  }

  /* Points have run out when every playing member is below the cost of the climax (§3.3.2, §7.6). Derived. */
  static stageForced(g, party) {
    if (empty(party.stage)) return false;
    const order = Turn.stageOrder(g, party);
    if (!order.length) return false;
    return order.every(cid => Engine.climaxForced(Rules.intval(party.stage.points?.[cid] ?? 0)));
  }

  /* Whose turn it is. One captain plays at a time, in the fixed order (lobby join order, Player One first), wherever
     their ships are (§14.7). A captain who has dropped is passed over until they return. */
  static holder(g) {
    const order = toList(g.order ?? []).map(Rules.intval);
    const dropped = toList(g.dropped ?? []).map(Rules.intval);
    const n = order.length;
    let at = order.indexOf(Rules.intval(g.turn_of ?? 0));
    if (at < 0) at = 0;
    for (let k = 0; k < n; k++) {
      const cand = order[(at + k) % n];
      if (!dropped.includes(cand)) return cand;
    }
    return 0;
  }

  /* The fleet leader, or while they are disconnected the next connected member in the fixed order (§3.3.1). */
  static partyLeader(g, party) {
    const leader = Rules.intval(party.leader);
    const dropped = g.dropped ?? [];
    if (!dropped.includes(leader)) return leader;
    for (const cid of g.order) {
      if (party.members.includes(Rules.intval(cid)) && !dropped.includes(Rules.intval(cid))) return Rules.intval(cid);
    }
    return leader;
  }

  order(party) { return Turn.stageOrder(this.g, party); }
  leads(party = null) { return Turn.partyLeader(this.g, party ?? this.party()) === this.cid; }
  forced(party = null) { return Turn.stageForced(this.g, party ?? this.party()); }

  chance(percent, salt) {
    return hashPick(this.g.seed + ":" + this.g.turn + ":" + this.cid + ":" + salt) % 100 < percent;
  }
  pick(list, salt) {
    return list.length ? list[hashPick(this.g.seed + ":" + this.g.turn + ":" + this.cid + ":" + salt) % list.length] : null;
  }

  notice(text, audience = null, extra = {}) {
    this.w.store.event(this.g.id, 0, "notice", Object.assign({ text, audience: audience ?? this.party().members }, extra), this.g.turn);
  }

  /* The part of a stage's opening that may be put on screen as a notice: everything before the stage itself. */
  static withoutStage(text) {
    return String(text ?? "").replace(/\s*(?:RESUMED )?STAGE \d+ of \d+:.*$/s, "").trim();
  }

  /* Where this captain stands: fleet, sector, mission and stage. A roll or a question belongs to that moment. */
  stamp() {
    const party = this.party();
    const stage = party.stage;
    return this.pid() + "|" + JSON.stringify(party.position) + "|" + (stage ? stage.mission_id + ":" + stage.idx : "");
  }

  /* True when the situation a waiting roll was called for no longer exists, or the turn has passed on. */
  lapsed(p) {
    if ((p.stamp ?? "") !== this.stamp()) return true;
    return Turn.holder(this.g) !== this.cid;
  }

  lapseRoll(p) {
    if ((p.stamp ?? "") === this.stamp()) this.refund(Rules.intval(p.cost));
    return this.systemLine("The situation moved on before that roll was made, so the order lapsed. Nothing was spent. Give a new order.");
  }

  /* Ships return to normal running when a stage ends or they travel on (§14.5 rule 3). */
  standDown(members) {
    for (const cid of members) if (this.caps.has(cid)) this.state(cid).alert = "normal";
  }

  systemLine(text) {
    this.w.store.event(this.g.id, this.cid, "notice", { text, audience: [this.cid] }, this.g.turn);
    return { ok: true };
  }

  guard() {
    if (this.g.status !== "active") return fail("gd_not_active", this.g.status === "ended" ? "This campaign has ended." : "The game has not started yet.", 409);
    if (this.g.pause) return fail("gd_paused", "The game is paused.", 409);
    if (this.held()) return fail("gd_hold", "Your turn is on hold.", 409);
    const s = this.state();
    if (!empty(s.pending)) return fail("gd_pending", s.pending.type === "roll" ? "Enter your roll first." : "Answer the question on screen first.", 409);
    if (!empty(s.joining)) return fail("gd_joining", "Your ship is on its way to join the fleet. You arrive at the start of the fleet leader's next turn.", 409);
    if (Rules.intval(s.ship.bonus_pool ?? 0) > 0 && empty(s.ship.bonus_done)) return fail("gd_bonus", "Place your bonus ship points first. They are in the Ship status panel.", 409);
    if (!empty(s.briefing)) return fail("gd_briefing", "Your crew is still being briefed on the campaign so far. One moment.", 409);
    if (!empty(s.narration)) return fail("gd_narration", "The bridge has not reported on your last order yet.", 409);
    const party = this.party();
    if (party.stage && toList(party.stage.bench ?? []).includes(this.cid) && !this.order(party).includes(this.cid)) {
      return fail("gd_next_round", "You joined part-way through this stage. You take your place in the turn order from the next round.", 409);
    }
    const holder = Turn.holder(this.g);
    if (holder !== this.cid) {
      const who = this.caps.get(holder)?.name ?? "another captain";
      return fail("gd_not_your_turn", `It is ${who}'s turn.`, 409);
    }
    return null;
  }

  /* =================================================================== Call A */

  async adjudicate(text) {
    const ctx = Context.build(this.w, this.g, this.cap(), this.party(), this.caps);
    const opts = { schema: Prompts.callASchema(), maxTokens: 8000, store: this.w.store, gameId: this.g.id, captainId: this.cid, turnNo: this.g.turn };
    let down = 0;
    for (let attempt = 0; attempt < 2; attempt++) { // retry once, then the safe default (§7.2.2 defence 4)
      const res = await this.w.llm.call("call_a", Prompts.callASystem(), Prompts.callAUser(ctx, text), opts);
      if (isErr(res)) {
        down++;
        continue;
      }
      const a = Prompts.validateCallA(res.json);
      if (a) return a;
    }
    // The safe default is for a malformed reply only. If the model could not be reached, nothing is charged.
    if (down === 2) return fail("gd_llm_down", "The order could not be processed: the game's AI engine did not answer. Nothing was charged. Try again in a moment.", 503);
    return Prompts.fallbackCallA(text);
  }

  async route(text, a) {
    const party = this.party();
    const stage = party.stage;
    const zeroUnderThreat = !!(stage && isArr(stage.threat) && !empty(stage.threat.active) && Rules.intval(stage.points?.[this.cid] ?? 0) <= 0);
    if (zeroUnderThreat && a.intent !== "retreat") return this.refuse(text, a, "There are no turn points left and the ship is under threat. The only option is to retreat.");
    if (a.impossible && a.intent !== "retreat") return this.refuse(text, a, a.impossible_reason || "That cannot be done.");
    if (stage && this.forced(party) && !a.is_stage_climax && !["retreat", "travel"].includes(a.intent) && a.tier > 0) {
      return this.refuse(text, a, "Turn points have run out. The only choices left are to make your decisive move for the objective now, by whatever means you judge best, or to retreat.");
    }
    switch (a.intent) {
      case "retreat": return stage ? this.askLeave("retreat", text, a, zeroUnderThreat) : this.refuse(text, a, "There is nothing to retreat from. To move on, name a destination.");
      case "travel": return stage ? this.askLeave("retreat", text, a, zeroUnderThreat) : this.travel(text, a);
      case "fleet_join":
      case "fleet_accept": return this.fleetJoin(text, a);
      case "fleet_request": return this.fleetRequest(text, a);
      case "pass": return this.passTurn(text, a);
      case "fleet_decline": return this.fleetDecline(text, a);
      case "fleet_leave": return this.fleetLeave(text, a);
      case "transfer_item": return this.transferItem(text, a);
      case "request_item": return this.requestItem(text, a);
      case "use_item": return this.useItem(text, a);
      case "jettison_item": return this.jettison(text, a);
      case "accept_mission": return this.acceptMission(text, a);
      case "decline_mission": return this.finish(text, a, "The captain declines the mission on offer here. Acknowledge briefly. No cost.", {});
    }
    return this.action(text, a);
  }

  /* An impossible or unavailable command: refused in fiction, at no cost (§8). */
  refuse(text, a, reason) {
    return this.finish(text, a, `NOT ATTEMPTED, at no cost. Reason: ${reason}\nAn officer explains this in the fiction. Nothing happens.`, { refused: true });
  }

  /* =================================================================== ordinary actions */

  async action(text, a) {
    const pid = this.pid();
    const stage = this.g.parties[pid].stage;
    const s = this.state();
    const alertBefore = s.alert;
    // An officer who is out of commission gives no advice (§7.5). Checked before anything is charged or changed.
    if (a.action_class === "advice") {
      const adv = own(s.crew, a.officer) ? a.officer : "first_officer";
      if (!empty(s.crew[adv].injury)) return this.refuse(text, a, s.crew[adv].name + " is out of commission and cannot give advice.");
    }
    // "Go to yellow alert and scan them": the alert is part of the order, set and paid for with it.
    const also = (a.also_alert ?? "none") !== "none" && a.also_alert !== s.alert && !["alert_yellow", "alert_red", "alert_normal"].includes(a.action_class) ? a.also_alert : null;
    let tier0Used = null;
    // Every turn has turn points, in a mission stage or not (§14.7), and every order is priced the same way.
    let cost = Rules.cost(a.action_class, a.tier);
    if (stage && a.tier === 0) {
      tier0Used = Rules.intval(stage.tier0?.[this.cid] ?? 0) + 1;
      cost = tier0Used > Rules.FREE_TIER0 ? 1 : 0; // §8
    }
    if (stage && this.forced() && a.is_stage_climax) cost = 0; // the forced climax is a free choice (§7.6)
    if (also) cost += Rules.cost("alert_" + also, also === "normal" ? 0 : 1);
    const have = this.pointsLeft();
    if (cost > have) return this.refuse(text, a, `That needs ${cost} turn points and only ${have} remain` + (stage ? "." : " this turn. End the turn to begin a new one."));
    // Any order that spends turn points or goes to the dice is put to the captain first (§14.5 rule 8).
    if (empty(a.confirmed) && (cost > 0 || a.tier >= 2)) {
      let params = null;
      if (a.tier >= 2) {
        if (also) s.alert = also; // so the number given is the one that will apply
        params = await this.prepareRoll(text, a, cost, "action", {}, true);
        s.alert = alertBefore;
        if (!params || !params.engine) return params; // nobody can carry it out: already refused
      }
      return this.askConfirm(text, a, cost, params, "action");
    }
    if (tier0Used !== null) {
      if (!this.g.parties[pid].stage.tier0 || Array.isArray(this.g.parties[pid].stage.tier0)) this.g.parties[pid].stage.tier0 = {};
      this.g.parties[pid].stage.tier0[this.cid] = tier0Used;
    }
    this.spend(cost);

    if (a.action_class === "alert_yellow") s.alert = "yellow";
    else if (a.action_class === "alert_red") s.alert = "red";
    else if (a.action_class === "alert_normal") s.alert = "normal";
    else if (also) {
      s.alert = also;
      this.notes.push(also === "normal" ? "The ship stood down from alert as part of this order." : `The ship went to ${also} alert as part of this order.`);
    }
    if (s.alert !== alertBefore) {
      this.changes.push("Alert: " + s.alert.charAt(0).toUpperCase() + s.alert.slice(1));
      this.touched.tactical = "the ship went to " + s.alert + " alert";
    }
    this.applyDecision(a);

    if (a.tier <= 1) {
      let result = "AUTOMATIC, no roll. " + a.understood_as + (cost ? ` Cost: ${cost} turn points.` : " No cost.");
      if (a.action_class === "advice") {
        const role = own(s.crew, a.officer) ? a.officer : "first_officer";
        const eff = Engine.effectiveAttrs(s.crew[role]);
        const attr = own(eff, a.attribute) ? a.attribute : Object.keys(eff)[0];
        const val = eff[attr].value;
        const qual = val >= 12 ? "sharp, specific and reliable" : val >= 8 ? "sound and useful" : val >= 5 ? "general, with some uncertainty" : "vague and hedged";
        const party = this.party();
        const st = party.stage;
        const ship = {};
        for (const [k, v] of Object.entries(Game.shipEffective(s))) ship[k] = v.value;
        const courses = Advice.brief({
          in_stage: !!st,
          momentum: st ? Rules.intval(st.momentum) : 0,
          used: st ? toList(st.used) : [],
          points: st ? Rules.intval(st.points?.[this.cid] ?? 0) : 0,
          obstacle_band: st ? Engine.shiftBand(st.def.obstacle_band, Rules.intval(st.shift)) : "tricky",
          threat: st && isArr(st.threat) ? (empty(st.threat.active) ? "pending" : "active") : "none",
          forced: !!(st && this.forced(party)),
          has_contacts: st ? !empty(st.contacts) : !empty(party.contacts),
          alert: s.alert,
          hull: Rules.intval(s.ship.hull),
          damaged: toList(s.ship.damaged),
          crew: s.crew,
          ship,
          items: s.inventory.map(x => x.item),
          injured: Object.values(s.crew).filter(o => !empty(o.injury)).map(o => o.name)
        });
        if (!courses.length) {
          // Nothing true to suggest: the officer says so and the points come back, rather than a made-up hint.
          this.refund(cost);
          cost = 0;
          result = "AUTOMATIC, no roll. " + a.understood_as + ` No cost.\nADVICE from ${s.crew[role].name} only: they have nothing to add. The ship and crew are in good order and there is nothing to prepare that would help. They say so briefly, in character.`;
        } else {
          result += `\nADVICE from ${s.crew[role].name} only. The engine has worked out the courses of action that would genuinely help most right now. The officer recommends exactly these, in this order, in character, as suggestions the captain may take or leave:\n- ` + courses.join("\n- ")
            + "\nTheir " + Rules.attributes()[attr] + ` is ${val}, so the way they put it is ${qual}. No numbers, no rules terms, no other suggestions, and no promise that either will work.`;
        }
      }
      if (a.action_class === "information" || a.intent === "database_query") {
        const asked = Context.addressed(text, s.crew);
        const answers = asked && own(s.crew, asked) && empty(s.crew[asked].injury) ? s.crew[asked].name : "The Computer";
        result += `\n${answers} answers factually from LIVE STATE, SHARED WORLD and canon.` + (a.intent === "database_query" ? ' This is a database query about "' + a.query_subject + `": return it as scan target "species" with government, known traits, history with ${setting.POWER.short}, and what has happened with them in this campaign.` : "");
      }
      if (cost > 0) result += this.stallThreat(); // free questions to the computer do not count as stalling
      return this.finish(text, a, result, { cost, consume: cost > 0, effort: "low" });
    }
    return this.prepareRoll(text, a, cost, "action");
  }

  spend(cost) {
    if (cost <= 0) return;
    const pid = this.pid();
    const s = this.state();
    const bonus = Rules.intval(s.turn_bonus ?? 0);
    const from = Math.min(bonus, cost);
    s.turn_bonus = bonus - from;
    const stage = this.g.parties[pid].stage;
    if (stage) stage.points[this.cid] = Math.max(0, Rules.intval(stage.points[this.cid]) - (cost - from));
    else s.tp = Math.max(0, this.roamingPoints() - (cost - from));
  }

  refund(cost) {
    if (cost <= 0) return;
    const stage = this.party().stage;
    if (stage) stage.points[this.cid] = Rules.intval(stage.points[this.cid]) + cost;
    else this.state().tp = this.roamingPoints() + cost;
  }

  /* Turn points left this turn outside a mission stage. A turn begins with the full allowance. */
  roamingPoints() {
    return Rules.intval(this.state().tp ?? Rules.STAGE_POINTS);
  }

  /* Turn points this captain can still spend: the stage's inside a mission stage, this turn's outside one. */
  pointsLeft() {
    const stage = this.party().stage;
    return (stage ? Rules.intval(stage.points?.[this.cid] ?? 0) : this.roamingPoints()) + Rules.intval(this.state().turn_bonus ?? 0);
  }

  /* Captain decisions that shorten recovery (§7.5): once per stage per decision. */
  applyDecision(a) {
    if (a.captain_decision === "none") return;
    const stage = this.g.parties[this.pid()].stage;
    const s = this.state();
    const done = toList(stage ? stage.decisions ?? s.decisions ?? [] : s.decisions ?? []).slice();
    if (done.includes(a.captain_decision)) return;
    done.push(a.captain_decision);
    if (stage) stage.decisions = done;
    else s.decisions = done; // once between stages, too
    for (const o of Object.values(s.crew)) {
      if (!empty(o.injury)) o.injury.turns_remaining = Math.max(1, Rules.intval(o.injury.turns_remaining) - 1);
    }
  }

  situationalPenalty(a) {
    const ship = this.state().ship;
    let pen = 0;
    for (const sys of toList(ship.damaged)) if ((Advice.SYSTEM_HAMPERS[sys] ?? []).includes(a.action_class)) pen++;
    if (Rules.intval(ship.hull) < 50) pen++;
    return pen;
  }

  /* The Computer states what an order will cost, sums up the situation in words and gives the number the die must
     show, then asks whether to proceed (§14.5 rule 8). Composed from the real state, so it is always accurate. */
  async askConfirm(text, a, cost, params, via) {
    const party = this.party();
    const stage = party.stage;
    const s = this.state();
    const say = ["Order understood: " + a.understood_as.replace(/[. \t]+$/, "") + "."];
    if (params) {
      const who = s.crew[params.actor.role];
      say.push(who.name + " will carry it out" + (params.actor.covering ? ", covering for " + s.crew[params.asked.role].name + ", who is out of commission" : "") + ".");
    }
    const left = this.pointsLeft();
    say.push(cost > 0 ? `It will use ${cost} of your ${left} turn points.` : "It costs no turn points.");
    if (stage) {
      if ((a.also_alert ?? "none") !== "none" && a.also_alert !== s.alert && !a.action_class.startsWith("alert_")) {
        say.push(a.also_alert === "normal" ? "That includes standing down from alert." : `That includes going to ${a.also_alert} alert.`);
      }
      const threat = isArr(stage.threat) && !empty(stage.threat.active);
      if (params && params.climax) {
        say.push(this.forced(party)
          ? "Turn points have run out, so this is the decisive move of the stage with things as they stand."
          : !empty(params.cold) ? "This is the decisive move of the stage, and no groundwork has been laid for it." : "This is the decisive move of the stage, and the groundwork laid so far counts towards it.");
      } else if (params && toList(stage.used).includes(a.action_class)) {
        say.push("This approach has already gained ground in this stage, so it will not build Momentum a second time.");
      }
      if (threat && params) {
        say.push(params.threat === "respond" ? "It answers the threat now facing the ship." : "A threat is facing the ship and this order does not deal with it, which makes it far harder.");
      } else if (threat) {
        say.push(empty(stage.threat.stalled) ? "A threat is facing the ship and this order does not deal with it." : "A threat is facing the ship and has already been left once. If this order goes ahead, the threat will land.");
      }
    }
    if (params) {
      const hampered = toList(s.ship.damaged).filter(sys => (Advice.SYSTEM_HAMPERS[sys] ?? []).includes(a.action_class));
      if (hampered.length) say.push("The damaged " + hampered.join(" and ") + " will hamper it.");
      if (Rules.intval(s.ship.hull) < 50) say.push("Hull integrity is at " + Rules.intval(s.ship.hull) + " per cent, which counts against the ship.");
      if (params.alert) say.push("The ship is at " + params.alert.level + " alert, which " + (params.alert.bonus > 0 ? "helps here." : "the other side will read as a threat."));
      const need = params.preview.needed_face;
      say.push(need === null ? "Only a natural 20 will succeed." : `The die must show ${need} or higher.`);
    }
    say.push("Proceed?");
    const crewVoices = Object.values(s.crew).map(o => o.voice).filter(v => !empty(v));
    const line = { speaker_type: "computer", speaker_id: "computer", speaker_name: "Computer", line: say.join(" "), voice: this.w.voices.computerVoice(Game.setting(this.w, "computer_gender"), crewVoices) };
    // The line carries the model's reading of the order, so it goes through the safety check before it is shown.
    let ok;
    try {
      ok = await Context.characterSafe(this.w, line.line);
    } catch (e) {
      return unchecked(String((e && e.message) || e));
    }
    if (!ok) {
      this.hold("line"); // removed, with the question that would have followed it
      return { ok: true, held: true };
    }
    const id = this.w.store.event(this.g.id, this.cid, "narration", { ref: 0, lines: [line], audience: [this.cid] }, this.g.turn);
    this.wholeLine(id, line);
    s.pending = {
      type: "dialogue",
      kind: "confirm",
      via,
      title: "Computer",
      message: "Proceed with this order? You may also answer in words, or simply give a different order.",
      buttons: [{ id: "proceed", label: "Proceed" }, { id: "belay", label: "Belay that" }],
      text,
      a,
      stamp: this.stamp(),
      // When Proceed will be followed at once by a roll the system makes, the page is told, so the die can be shown
      // tumbling from the moment Proceed is pressed.
      roll: params && this.g.options.dice !== "physical" ? { officer: s.crew[params.actor.role].name, role: Rules.roles()[params.actor.role].title, needed: params.preview.needed_face } : null
    };
    return { ok: true, dialogue: true, confirm: true };
  }

  /* A line whose whole text is known and already recorded: shown and spoken at once (the plugin's whole_line). */
  wholeLine(eventId, line) {
    if (!this.live) return;
    const key = "e" + eventId;
    this.live.send({ t: "line", key, id: eventId, speaker_type: line.speaker_type, speaker_id: line.speaker_id, speaker_name: line.speaker_name, voice: String(line.voice ?? "") });
    this.live.send({ t: "txt", key, d: line.line });
    this.live.send({ t: "end", key, id: eventId, text: line.line });
  }

  /* Assemble everything a roll needs. Both dice modes share this and resolveRoll() (§7.2.5).
     dry: work the roll out without making it, to tell the captain what the die must show. */
  async prepareRoll(text, a, cost, kind, extra = {}, dry = false) {
    const party = this.party();
    const stage = party.stage;
    const s = this.state();
    const cls = kind === "retreat" ? "retreat" : a.action_class;
    let role = own(Rules.roles(), a.officer) && kind !== "retreat" ? a.officer : Rules.defaultActor(cls)[0];
    let attr = a.attribute === "none" || kind === "retreat" ? Rules.defaultActor(cls)[1] : a.attribute;
    // Getting the ship out of the way of something that is already upon it is Evasion, not Piloting.
    if (attr === "piloting" && cls === "manoeuvre" && a.responds_to_threat && stage && isArr(stage.threat) && !empty(stage.threat.active)) attr = "evasion";
    // A crew saved before there was a Helm Officer: the Tactical Officer flies the ship, as before.
    if (!own(s.crew, "helm") && (role === "helm" || (Rules.roles().helm.attrs.includes(attr) && attr !== "composure"))) {
      role = "tactical";
      attr = "threat_assessment";
    }
    let actor = Engine.resolveActor(s.crew, role, attr);
    if (!actor && kind === "retreat") {
      // Every officer is down: whoever is nearest the helm gets the ship out, with no skill to add.
      actor = { role: "tactical", attribute: "composure", value: 0, penalty: 0, covering: false };
    }
    if (!actor) {
      if (!dry) this.refund(cost);
      return this.refuse(text, a, "Every officer is out of commission. Nobody can carry that out.");
    }
    let threatMode = null;
    const climax = !!(stage && a.is_stage_climax && kind === "action");
    if (stage && isArr(stage.threat) && !empty(stage.threat.active)) threatMode = a.responds_to_threat || kind === "retreat" ? "respond" : "ignore";
    const baseline = stage ? Engine.shiftBand(climax ? stage.def.climax_band : stage.def.obstacle_band, Rules.intval(stage.shift)) : "tricky";
    const faction = a.target_faction && this.g.factions[a.target_faction] ? a.target_faction : null;
    const itemShift = !empty(s.next_band_shift);
    const cold = climax && Rules.intval(stage.momentum) <= 0 && !this.forced(party); // not when points ran out: that climax is not a choice
    const band = Engine.finalBand(baseline, a.difficulty_band, {
      ignoring_threat: threatMode === "ignore",
      missing_helper: !!(stage && !empty(stage.missing_helper)),
      is_diplomacy: a.action_class === "hail" && !!faction,
      standing_step: faction ? Rules.standingStep(this.g.factions[faction].standing) : null,
      item_band_shift: itemShift,
      cold_climax: cold
    });
    let itemBonus = 0;
    const nb = s.next_roll_bonus ?? null;
    if (nb && nb.attribute === actor.attribute) itemBonus = Rules.intval(nb.value);
    // The ship's own attributes count on matching rolls. Where two apply, the better one is used, not both.
    let shipAttr = null;
    let shipBonus = 0;
    const ship = Game.shipEffective(s);
    for (const k of Rules.shipAttributesFor(a.action_class, kind === "retreat", threatMode === "respond")) {
      const b = Engine.shipBonus(ship[k].value);
      if (shipAttr === null || b > shipBonus) {
        shipAttr = k;
        shipBonus = b;
      }
    }
    const alertBonus = Rules.alertBonus(s.alert, a.action_class, threatMode === "respond");
    const params = Object.assign({
      text, a, kind, cold,
      alert: alertBonus ? { level: s.alert, bonus: alertBonus } : null,
      ship: shipAttr ? { attribute: shipAttr, bonus: shipBonus } : null,
      cost, actor,
      asked: { role, attribute: attr },
      baseline, climax, threat: threatMode, faction, in_stage: !!stage,
      engine: {
        attribute_value: actor.value,
        item_bonus: itemBonus + shipBonus + alertBonus,
        injury_penalty: actor.penalty,
        situational_penalty: this.situationalPenalty(a),
        band,
        momentum: stage ? Rules.intval(stage.momentum) : 0,
        apply_momentum: !!(stage && (climax || threatMode)) // climax and threat responses (§7.2.2, §7.2.3)
      },
      used_item_bonus: itemBonus > 0,
      used_band_shift: itemShift,
      stamp: this.stamp()
    }, extra);
    params.preview = Object.assign(Engine.preview(params.engine), {
      officer: s.crew[actor.role].name, role: actor.role, attribute: actor.attribute, covering: actor.covering, ship: params.ship, alert: params.alert, cold
    });
    if (dry) return params;
    if (this.g.options.dice === "physical") {
      s.pending = { type: "roll", params, preview: params.preview, started: time(), deadline: time() + Game.setting(this.w, "roll_timeout"), text };
      this.w.store.event(this.g.id, this.cid, "roll_prompt", { text, captain_name: this.cap().name, preview: params.preview, cost, audience: party.members }, this.g.turn);
      return { ok: true, awaiting_roll: true };
    }
    const seed = Engine.newSeed();
    return this.resolveRoll(params, Engine.d20FromSeed(seed), "system", seed);
  }

  /* Authoritative resolution. Nothing downstream knows which dice mode produced the roll. */
  async resolveRoll(p, roll, source, seed) {
    const a = p.a;
    const pid = this.pid();
    const res = Engine.resolve(Object.assign({}, p.engine, { roll }));
    const out = res.outcome;
    const crew = this.state().crew;
    const actor = p.actor;
    const fx = []; // plain-language consequences for Call B and the log
    const stageOpen = !!this.g.parties[pid].stage;
    const s = this.state();
    if (p.used_item_bonus) s.next_roll_bonus = null;
    if (p.used_band_shift) s.next_band_shift = false;

    // Momentum (§7.2.7): not for the climax itself, which spends it.
    let momDelta = 0;
    if (stageOpen && !p.climax && p.kind !== "retreat") {
      const st = this.g.parties[pid].stage;
      const m = Engine.applyMomentum(st.momentum, st.used, out, a.action_class, a.advances_stage);
      st.momentum = m.momentum;
      st.used = m.used;
      st.used_all = uniq([...toList(st.used_all), a.action_class]);
      momDelta = m.delta;
    }

    // Threat: the captain's roll decides how far it succeeds (§7.2.3).
    let risk = a.injury_risk;
    if (p.threat && stageOpen && isArr(this.g.parties[pid].stage.threat)) {
      const tr = Engine.threatResult(out);
      const desc = this.g.parties[pid].stage.threat.description;
      this.g.parties[pid].stage.threat = "done";
      if (tr === "succeeds") {
        fx.push(`THE THREAT SUCCEEDS (${desc}). ` + this.damageParty(20, true));
        risk = "high";
      } else if (tr === "partly_succeeds") {
        fx.push(`THE THREAT PARTLY SUCCEEDS (${desc}): damage taken, ground lost, but not the worst case. ` + this.damageParty(10, false));
      } else if (tr === "fails_completely") {
        fx.push(`THE THREAT FAILS COMPLETELY (${desc}), and the captain gains an advantage from it.`);
        if (!p.climax) this.g.parties[pid].stage.momentum = Engine.clampMomentum(this.g.parties[pid].stage.momentum + 1);
      } else {
        fx.push(`THE THREAT FAILS (${desc}).`);
      }
      if (p.threat === "ignore") fx.push("The captain did something else instead of dealing with the threat, so this action was attempted at desperate difficulty.");
    }

    // A combat or manoeuvre order that goes wrong costs the acting ship hull, unless a threat has already taken its
    // toll on this roll (§14.5).
    const threatHit = fx.some(l => l.includes("Ship damage:"));
    if (!threatHit && p.kind !== "retreat" && own(Rules.SETBACK_HULL, out) && ["attack", "board", "manoeuvre"].includes(a.action_class)) {
      fx.push("THE ORDER WENT WRONG AND THE SHIP PAID FOR IT. " + this.damageParty(Rules.SETBACK_HULL[out], false, [this.cid]));
    }

    // Injury from failure and partial results, severity scaled to the miss (§7.5). A failed Composure roll leaves the
    // officer Shaken (§4.2). Officers named to an away team are the ones exposed if it goes wrong (§4.2.1).
    let hurt = actor.role;
    const away = toList(a.away_team ?? []).filter(r => own(crew, r) && empty(crew[r].injury));
    if (away.length && ["partial", "failure"].includes(out)) {
      hurt = this.pick(away, "away");
      if (risk === "none") risk = "low";
    }
    let sev = Engine.injuryFrom(out, res.margin, risk);
    let type = "physical";
    if (out === "failure" && actor.attribute === "composure" && !sev) {
      sev = "light";
      type = "psychological";
    }
    if (sev) fx.push(this.injure(this.cid, type === "psychological" ? actor.role : hurt, sev, type));
    if (["partial", "failure"].includes(out) && !sev && !fx.some(l => l.includes("Ship damage:"))) {
      fx.push("No ship was damaged and nobody was hurt by this result. Narrate the setback without any damage or injury.");
    }

    // Standing: only the game changes it, from diplomacy results and hostile acts (§9.1). TUNABLE deltas.
    if (p.faction) {
      let delta = 0;
      if (a.action_class === "hail") delta = { critical_success: 2, success: 1, partial: 0, failure: -1 }[out];
      else if (["attack", "board"].includes(a.action_class)) delta = -2;
      this.g = Game.meetFaction(this.g, p.faction);
      if (delta) {
        this.g = Game.changeStanding(this.w, this.g, p.faction, delta, mbSubstr(a.understood_as, 0, 120));
        fx.push("Standing with " + this.g.factions[p.faction].name + (delta > 0 ? " improves." : " worsens."));
      }
    }

    // Class-specific effects.
    const good = ["critical_success", "success"].includes(out);
    if (a.action_class === "treat") fx.push(this.treat(a, out));
    if (a.action_class === "repair" && (good || out === "partial")) {
      const ship = s.ship;
      const gain = out === "critical_success" ? 20 : good ? 10 : 5;
      ship.hull = Math.min(100, Rules.intval(ship.hull) + gain);
      const fixed = good && ship.damaged.length ? ship.damaged.shift() : null;
      fx.push(`Repairs restore hull integrity to ${ship.hull}%.` + (fixed ? ` The ${fixed} system is back online.` : ""));
    }
    if (a.action_class === "scan" && (good || out === "partial")) {
      const first = Game.markSector(this.w, this.g.id, this.party().position, 1, this.g.options.size);
      fx.push(out === "partial" ? "The scan returns partial, less reliable detail." : 'The scan returns clear detail. If it targeted a contact, report shields, weapons, visible damage, life signs and anything unusual as scan target "contact"; if the sector, planets or an anomaly, as scan target "sector".');
      if (first && good && this.chance(CHANCE_EXPLORE_ITEM, "explore")) fx.push(this.grant(this.cid, this.pick(Rules.itemIdsBy("standard", "consumable"), "exploreitem"), "found while scanning"));
    }
    if (out === "critical_success" && !p.climax && this.chance(CHANCE_CRIT_ITEM, "crit")) fx.push(this.grant(this.cid, this.pick(Rules.itemIdsBy("standard"), "crititem"), "an unexpected gain from the success"));

    // Retreat always gets the ship out; the roll decides how cleanly (§7.2.3).
    if (p.kind === "retreat") {
      if (out === "partial") fx.push("The ship gets away, but not cleanly. " + this.damageParty(10, false));
      else if (out === "failure") fx.push("The ship gets away, but badly mauled. " + this.damageParty(20, true));
      fx.push(await this.leaveStage(p.leave ?? {}));
    }

    let stageFx = "";
    if (p.climax && stageOpen) stageFx = await this.stageEnd(out);

    const names = Rules.attributes();
    const covered = actor.covering ? " covering for " + crew[p.asked.role].name + ", who is out of commission," : "";
    const result = out.split("_").join(" ").toUpperCase() + ". " + a.understood_as
      + `\nCarried out by ${crew[actor.role].name} (${actor.role})${covered} using ${names[actor.attribute]}`
      + (!empty(p.ship) ? ", helped by the ship's " + Rules.shipAttributes()[p.ship.attribute] + ` (+${p.ship.bonus})` : "")
      + (!empty(p.alert) ? ", with the ship at " + p.alert.level + " alert (" + (p.alert.bonus > 0 ? "+" : "") + p.alert.bonus + (p.alert.bonus < 0 ? ": the other side sees a ship ready for a fight" : ": the crew were at their stations") + ")" : "")
      + (!empty(p.cold) ? ". The climax was attempted cold, with no groundwork laid, which made it one band harder" : "")
      + `. Difficulty: ${res.band}.`
      + (out === "critical_success" ? "\nThe objective is advanced strongly." : out === "success" ? "\nThe objective is advanced." : out === "partial" ? "\nSuccess at a cost: it works, but something breaks, is noticed or is spent." : "\nIt does not work, and a consequence lands.")
      + (fx.filter(Boolean).length ? "\nCONSEQUENCES:\n- " + fx.filter(Boolean).join("\n- ") : "")
      + (stageFx ? `\nSTAGE RESULT: ${stageFx}` : "");

    return this.finish(p.text, a, result, {
      cost: p.cost,
      consume: true,
      ends_turn: p.climax || p.kind === "retreat", // the main task, or a retreat, is the last act of a turn
      actor,
      resolve: res,
      roll: { value: Rules.intval(roll), source, seed },
      modifiers: p.engine,
      preview: p.preview,
      momentum_delta: momDelta,
      effects: fx.filter(Boolean),
      stage_result: stageFx,
      kind: p.kind
    });
  }

  /* =================================================================== narrate, record, advance */

  async finish(text, a, result, o) {
    const consume = !empty(o.consume);
    const pid = this.pid();
    const members = this.party().members.slice();
    const stage = this.g.parties[pid].stage;
    // A stage's threat arrives after its set number of turns; Call B declares it in this narration (§7.2.3).
    if (consume && stage && !this.freshStage) {
      stage.actions++;
      const th = stage.threat;
      if (isArr(th) && empty(th.active) && stage.actions >= Rules.intval(th.after_turns)) {
        th.active = true;
        result += "\nA THREAT MUST NOW BE DECLARED at the end of this narration, unresolved: " + th.description;
      }
    }
    if (this.notes.length) result += "\nALSO: " + this.notes.join(" ");
    const opening = String(this.state().opening ?? "");
    if (opening !== "") {
      result += `\nAS THIS TURN OPENED, BEFORE THE ORDER: ${opening}\nSet the scene for it in the voices of the crew, then report on the order.`;
      this.state().opening = "";
    }
    if (this.gained.length) {
      const items = Rules.items();
      const lines = uniq(this.gained.map(x => x[2])).map(iid => `- item key "${iid}": catalogue name "${items[iid].name}". What it does is fixed: ` + View().effectText(items[iid]) + ".");
      result += "\nITEMS GAINED (give each a name and one-sentence description that fit where it came from):\n" + lines.join("\n");
    }
    const now = this.state();
    const down = Object.values(now.crew).filter(o => !empty(o.injury)).map(o => o.name + " (" + (o.injury.type === "psychological" ? "Shaken" : o.injury.severity + " injury") + ", " + Rules.intval(o.injury.turns_remaining) + " turns)");
    result += "\nSHIP AND CREW NOW (the whole truth; add nothing to it): hull " + Rules.intval(now.ship.hull) + "%. Damaged systems: " + (now.ship.damaged.length ? now.ship.damaged.join(", ") : "none") + ". Out of commission: " + (down.length ? down.join("; ") : "nobody") + ". Alert: " + now.alert + "."
      + (this.changes.length ? " Changed this turn: " + this.changes.join("; ") + "." : " Nothing was damaged and nobody was hurt this turn.");
    // The turn is recorded first, so its result is on screen at once; its report then arrives line by line.
    const c = this.cap();
    const gained = this.gained;
    this.gained = [];
    this.g.turn++;
    const eventId = this.w.store.event(this.g.id, this.cid, "turn", {
      text, captain_name: c.name, call_a: a, cost: Rules.intval(o.cost ?? 0), roll: o.roll ?? null, roll_source: o.roll?.source ?? null,
      modifiers: o.modifiers ?? null, preview: o.preview ?? null, resolve: o.resolve ?? null, momentum_delta: o.momentum_delta ?? 0,
      effects: o.effects ?? [], stage_result: o.stage_result ?? "", refused: !empty(o.refused), notes: this.notes, changes: this.changes,
      lines: [], narration_pending: true, audience: members, sector: this.g.parties[pid].position
    }, this.g.turn);
    const touched = this.touched;
    this.notes = [];
    this.changes = [];
    this.touched = {};
    const held = { touched, event: eventId, text, a, result, actor: o.actor ?? null, effort: o.effort ?? "medium", audience: members, gained, said: [], tried: time() };
    // The result is sent with the stream, so the page shows it (and lands the die on it) at once.
    if (this.live) this.live.send({ t: "sync", events: View().events(this.w, this.g, this.cid, eventId - 1, 1) });
    await this.narrateInto(held, 2);

    if (consume) this.afterTurn();
    this.caps.set(this.cid, await Context.maybeSummarise(this.w, this.g, this.cap()));
    // The turn ends when the order was one that takes the whole turn, or when it used the last of the points.
    if (Turn.holder(this.g) === this.cid && (!empty(o.ends_turn) || this.turnSpent())) this.endTurn();
    if (this.stopped) return unchecked(this.stopped);
    return { ok: true };
  }

  /* Give newly gained items the name and description the narration wrote for them. Effects never change (§7.3). */
  nameItems(n, gained) {
    for (const [cid, key, iid] of gained) {
      if (empty(n.items?.[iid]) || !this.caps.has(cid)) continue;
      for (const slot of this.state(cid).inventory) {
        if (slot.key === key) {
          slot.name = n.items[iid].name;
          slot.desc = n.items[iid].desc;
        }
      }
    }
  }

  /* Bring the turn to whoever should hold it now: at the first order of a game, or when its holder has dropped. */
  syncTurn() {
    const holder = Turn.holder(this.g);
    if (holder && Rules.intval(this.g.turn_of ?? 0) !== holder) {
      this.g.turn_of = holder;
      this.beginTurn(holder);
    }
  }

  /* A captain's turn begins: a full allowance of turn points if they are not in a mission stage, and a fresh clock. */
  beginTurn(cid) {
    this.state(cid).tp = Rules.STAGE_POINTS;
    this.state(cid).turn_fresh = true;
    this.g.turn_clock = { cid: Rules.intval(cid), since: time() };
    if (this.caps.size > 1) this.w.store.event(this.g.id, 0, "notice", { text: "It is " + this.cap(cid).name + "'s turn.", audience: "all" }, this.g.turn);
  }

  /* The first order of a captain's turn. If their ship is not in a mission stage, whatever is waiting in the sector
     begins now. A fleet's leader does this for the fleet. */
  async openTurn() {
    if (empty(this.state().turn_fresh)) return;
    this.state().turn_fresh = false;
    const party = this.party();
    if (!party.stage && this.leads(party)) {
      const sec = Game.sector(this.w, this.g.id, party.position, Rules.intval(this.g.options.size));
      const here = (await this.missionsHere(party.position, sec, true)).trim();
      if (here !== "") {
        // What is put on screen is only that a mission has begun. What the stage asks for is not shown as a
        // statement from nowhere: the crew say it, when they report on the captain's first order.
        const shown = Turn.withoutStage(here);
        if (shown !== "") this.notice(shown);
        this.state().opening = here;
      }
    }
  }

  /* Whether this captain has anything left to do this turn. */
  turnSpent() {
    const party = this.party();
    if (party.stage) return Rules.intval(party.stage.points?.[this.cid] ?? 0) <= 0 && !this.forced(party);
    return this.roamingPoints() <= 0;
  }

  /* Whether a captain could do anything with a turn now. */
  canPlay(cid) {
    const s = this.state(cid);
    const party = this.g.parties[s.party] ?? null;
    if (!party || !empty(s.joining)) return false;
    if (!party.stage) return true;
    if (toList(party.stage.bench ?? []).includes(Rules.intval(cid))) return false;
    return Rules.intval(party.stage.points?.[cid] ?? 0) > 0 || Turn.stageForced(this.g, party);
  }

  /* This captain's turn is over. Their injured officers are a turn nearer to duty, and the next captain in the fixed
     order who can play takes the turn. Alone, a captain's next turn follows at once. */
  endTurn() {
    for (const o of Object.values(this.state().crew)) {
      if (empty(o.injury)) continue;
      if (!empty(o.injury.fresh)) {
        delete o.injury.fresh; // hurt this turn: the count starts next turn
        continue;
      }
      const left = Rules.intval(o.injury.turns_remaining) - 1;
      if (left <= 0) {
        o.injury = null;
        this.notice(o.name + " has recovered and returns to duty.", [this.cid]);
      } else {
        o.injury.turns_remaining = left;
      }
    }
    this.state().turn_bonus = 0; // a turn-point boost lasts one turn (§7.1)
    const dropped = toList(this.g.dropped ?? []).map(Rules.intval);
    const order = this.g.order.map(Rules.intval).filter(c => !dropped.includes(c));
    let at = order.indexOf(this.cid);
    if (at < 0) at = 0;
    const n = order.length;
    let next = this.cid;
    for (let k = 1; k <= n; k++) {
      if (at + k === n) {
        // The order has come back round: a new round. Captains who joined a stage part-way take their place (§3.3.1).
        for (const p of Object.values(this.g.parties)) if (p.stage && !empty(p.stage.bench)) p.stage.bench = [];
      }
      const cand = order[(at + k) % n];
      if (this.canPlay(cand)) {
        next = cand;
        break;
      }
    }
    this.g.turn_of = next;
    this.beginTurn(next);
  }

  /* The turn timer, run as the captain whose turn it is. A captain whose turn is on hold past the timer pauses the
     game for everyone instead (docs/PORT.md, the safety check). */
  turnTick() {
    this.syncTurn();
    if (this.caps.size < 2 || Turn.holder(this.g) !== this.cid) return; // a captain playing alone is never hurried
    const s = this.state();
    const asked = !empty(s.pending) && (s.pending.kind ?? "") === "confirm";
    // A captain who owes a dice roll or an answer, or whose last report is still arriving, is not timed out.
    if ((!empty(s.pending) && !asked) || !empty(s.narration)) {
      this.g.turn_clock = { cid: this.cid, since: time() };
      return;
    }
    if (time() - Rules.intval(this.g.turn_clock?.since ?? time()) < Game.setting(this.w, "turn_timeout")) return;
    if (this.held()) {
      this.g = Game.setPause(this.w, this.g, 0, "hold", { captain: this.cid });
      return;
    }
    s.pending = null;
    this.notice(this.cap().name + " gave no order in time, so the turn passes.", "all");
    this.endTurn();
  }

  /* The captain ends their turn. Outside a mission stage the points not used are lost; inside one they are kept. */
  passTurn() {
    this.notice(this.cap().name + " ends the turn.", "all");
    this.endTurn();
    return { ok: true };
  }

  /* Housekeeping after an order that counted: the forced climax is announced, time-critical missions expire. */
  afterTurn() {
    const pid = this.pid();
    this.state().turns = Rules.intval(this.state().turns) + 1;
    this.g.clock = Rules.intval(this.g.clock ?? 0) + 1; // counts turns actually taken, not refusals or free readouts
    const party = this.g.parties[pid];
    if (party && party.stage && Turn.stageForced(this.g, party) && empty(party.stage.forced_told)) {
      party.stage.forced_told = true;
      this.notice("Turn points have run out. The stage has reached its climax: attempt it now, with Momentum as it stands, or retreat.");
    }
    // Time-critical side missions expire (§6.5).
    for (const m of Game.missions(this.w, this.g.id, ["available"]).values()) {
      const exp = Rules.intval(m.data.expires_turn ?? 0);
      if (!exp && !empty(m.data.expiry_turns)) {
        m.data.expires_turn = this.g.clock + Rules.intval(m.data.expiry_turns);
        Game.saveMission(this.w, m);
      } else if (exp && this.g.clock >= exp) {
        m.status = "expired";
        Game.saveMission(this.w, m);
      }
    }
  }

  /* =================================================================== damage, injury, treatment, items */

  /* An order with no roll, given while a threat is active (§14.5 rule 7). The first draws a warning; the second
     leaves the threat unanswered too long: it partly succeeds and is over. */
  stallThreat() {
    const stage = this.g.parties[this.pid()].stage;
    if (!stage || !isArr(stage.threat) || empty(stage.threat.active)) return "";
    const desc = stage.threat.description;
    if (empty(stage.threat.stalled)) {
      stage.threat.stalled = 1;
      return `\nTHE THREAT STILL STANDS (${desc}) and this order did nothing about it. Make it plain in the narration that it is about to land: one more order that does not deal with it, and it will.`;
    }
    stage.threat = "done";
    return `\nTHE THREAT PARTLY SUCCEEDS (${desc}) because it was left unanswered: damage taken, ground lost, but not the worst case. ` + this.damageParty(10, false);
  }

  /* Damage to the acting captain's ship, or to every ship of the fleet. Hull never reaches zero (§12). */
  damageParty(amount, system, only = null) {
    const systems = ["shields", "weapons", "engines", "sensors", "communications", "power"];
    const out = [];
    for (const cid of only ?? this.party().members) {
      if (!this.caps.has(cid)) continue;
      const st = this.state(cid);
      const ship = st.ship;
      const def = Game.shipEffective(st).defense.value;
      const soak = Rules.ALERT[st.alert]?.soak ?? 0; // shields up at alert
      const hit = Math.max(5, Math.round(amount * (1 - Math.min(35, def) / 100) * (1 - soak / 100))); // TUNABLE: Defense soaks part of the hit
      ship.hull = Math.max(5, Rules.intval(ship.hull) - hit);
      let broke = null;
      if (system) {
        const free = systems.filter(x => !ship.damaged.includes(x));
        broke = this.pick(free, "sys" + cid);
        if (broke) ship.damaged.push(broke);
      }
      out.push(`${ship.name}: hull down to ${ship.hull}%` + (broke ? `, ${broke} damaged` : ""));
      this.changes.push(`${ship.name}: hull ${ship.hull}%` + (broke ? `, ${broke} damaged` : ""));
      if (Rules.intval(cid) === this.cid) {
        this.touched.tactical = `the ship was hit: hull at ${ship.hull}%`;
        if (broke) this.touched.engineer = `the ${broke} system was damaged`;
      }
    }
    return "Ship damage: " + out.join("; ") + ".";
  }

  medicSkill(cid, type) {
    const actor = Engine.resolveActor(this.state(cid).crew, "medical", type === "psychological" ? "psychology" : "triage");
    if (!actor) return 0;
    // Only the Medical Officer, or Science covering through Xenology, brings medical skill (§7.5).
    if (actor.role === "medical" || (actor.role === "science" && actor.attribute === "xenology")) return Math.max(0, actor.value - actor.penalty);
    return 0;
  }

  injure(cid, role, severity, type) {
    const st = this.state(cid);
    const o = st.crew[role];
    if (!empty(o.injury)) return "";
    const kit = st.inventory.some(slot => slot.item === "field_hospital") ? 1 : 0;
    o.injury = { severity, type, turns_remaining: 0, fresh: true };
    // A badly damaged ship is a poor place to recover: recovery runs longer (§7.5).
    const worse = Rules.intval(st.ship.hull) < 50 || toList(st.ship.damaged).includes("power") ? Rules.DAMAGED_RECOVERY : 0;
    const turns = Engine.recoveryTurns(severity, this.medicSkill(cid, type), kit, -worse);
    o.injury.turns_remaining = turns;
    this.changes.push(o.name + (type === "psychological" ? ": Shaken" : `: ${severity} injury`) + `, out of commission for ${turns} turns`);
    if (Rules.intval(cid) === this.cid) this.touched.medical = o.name + (type === "psychological" ? " was badly shaken" : ` took a ${severity} injury`);
    const label = type === "psychological" ? "is left Shaken" : `suffers a ${severity} injury`;
    return `${o.name} (${role}) ${label} and is out of commission for ${turns} turns.`;
  }

  /* Active treatment: an extra reduction on top of automatic recovery (§7.5). A fleet member's crew can be treated too. */
  treat(a, outcome) {
    const red = Rules.treatmentReduction(outcome);
    for (const cid of this.party().members) {
      for (const [role, o] of Object.entries(this.state(cid).crew)) {
        if (!empty(o.injury) && (!a.target_officer || a.target_officer === role)) {
          if (red <= 0) return `Treatment of ${o.name} makes no headway.`;
          const left = Math.max(1, Rules.intval(o.injury.turns_remaining) - red);
          o.injury.turns_remaining = left;
          return `Treatment shortens ${o.name}'s recovery to ${left} turns.`;
        }
      }
    }
    return "Nobody is in need of treatment.";
  }

  grant(cid, itemId, why) {
    if (!itemId) return "";
    const name = Rules.items()[itemId].name;
    const st = this.state(cid);
    const before = st.inventory.length;
    if (Game.addItem(st, itemId)) {
      if (st.inventory.length > before) this.gained.push([Rules.intval(cid), st.inventory[st.inventory.length - 1].key, itemId]); // a new slot can be given its own name
      return `Item gained (${why}): ${name}.`;
    }
    if (!Array.isArray(st.held_back)) st.held_back = [];
    st.held_back.push(itemId);
    return `Item found (${why}): ${name}. The hold is full, so it waits until a slot is freed by using, jettisoning or transferring something.`;
  }

  claimHeldBack(cid) {
    const st = this.state(cid);
    const held = toList(st.held_back ?? []).slice();
    while (held.length && Game.addItem(st, held[0])) held.shift();
    st.held_back = held;
  }

  findSlot(cid, key) {
    return this.state(cid).inventory.find(slot => slot.key === key || slot.item === key) ?? null;
  }

  async useItem(text, a) {
    const slot = a.item ? this.findSlot(this.cid, a.item) : null;
    const items = Rules.items();
    if (!slot || !own(items, slot.item)) return this.refuse(text, a, "That item is not in the hold.");
    const it = items[slot.item];
    if (it.kind === "equipment") return this.refuse(text, a, slot.name + " is equipment: it works for as long as it is held and is not used up.");
    const stage = this.g.parties[this.pid()].stage;
    const s = this.state();
    const cost = Rules.intval(it.cost);
    if (cost > this.pointsLeft()) return this.refuse(text, a, `Using ${slot.name} needs ${cost} turn points.`);
    if (cost > 0 && empty(a.confirmed)) return this.askConfirm(text, a, cost, null, "use_item");
    let fx = "";
    switch (it.effect) {
      case "turn_points":
        s.turn_bonus = Rules.intval(s.turn_bonus ?? 0) + Rules.intval(it.value);
        fx = `+${it.value} turn points for the rest of this turn.`;
        break;
      case "roll_bonus":
        s.next_roll_bonus = { attribute: it.attribute, value: Rules.intval(it.value) };
        fx = `+${it.value} to the next roll using ` + Rules.attributes()[it.attribute] + ".";
        break;
      case "recovery": {
        let done = false;
        for (const [role, o] of Object.entries(s.crew)) {
          if (!empty(o.injury) && (!a.target_officer || a.target_officer === role)) {
            const left = Math.max(1, Rules.intval(o.injury.turns_remaining) - Rules.intval(it.value));
            o.injury.turns_remaining = left;
            fx = `${o.name}'s recovery is shortened to ${left} turns.`;
            done = true;
            break;
          }
        }
        if (!done) return this.refuse(text, a, "Nobody is injured, so it would be wasted.");
        break;
      }
      case "range":
        s.range_bonus = Rules.intval(s.range_bonus ?? 0) + Rules.intval(it.value);
        fx = `+${it.value} light-years of range for the next journey.`;
        break;
      case "momentum":
        if (!stage) return this.refuse(text, a, "Momentum only exists inside a mission stage.");
        stage.momentum = Engine.clampMomentum(stage.momentum + Rules.intval(it.value));
        fx = "+1 Momentum this stage.";
        break;
      case "band_shift":
        s.next_band_shift = true;
        fx = "The next rolled action is one difficulty band easier.";
        break;
      case "reveal": {
        const coord = Grid.parseCoord(String(a.destination ?? ""));
        const key = coord && Grid.inBounds(this.g.options.size, coord) ? Grid.coordKey(coord) : this.party().position;
        Game.markSector(this.w, this.g.id, key, 1, this.g.options.size);
        fx = `Sector ${key} is revealed on the map without a scan.`;
        break;
      }
    }
    Game.takeItem(s, slot.key);
    this.claimHeldBack(this.cid);
    this.spend(cost);
    // Items are used at the beginning of a turn (§7.3): using one does not end the turn.
    fx += this.stallThreat();
    return this.finish(text, a, `ITEM USED: ${slot.name}. ${fx}` + (cost ? ` Cost: ${cost} turn points.` : " No cost.") + " Acknowledge briefly.", { cost, effort: "low" });
  }

  jettison(text, a) {
    const slot = a.item ? this.findSlot(this.cid, a.item) : null;
    if (!slot) return this.refuse(text, a, "That item is not in the hold.");
    if (!empty(slot.story)) return this.refuse(text, a, slot.name + " is needed for a mission and cannot be discarded.");
    Game.takeItem(this.state(), slot.key);
    this.claimHeldBack(this.cid);
    return this.finish(text, a, `JETTISONED: one ${slot.name}. Acknowledge briefly. No cost.`, { effort: "low" });
  }

  targetCaptain(a) {
    for (const seat of a.target_captains) {
      for (const [cid, c] of this.caps) if (c.seat === Rules.intval(seat) && cid !== this.cid) return cid;
    }
    return 0;
  }

  /* Transfers need both captains in the same fleet (§3.3.2). */
  transferItem(text, a) {
    const to = this.targetCaptain(a);
    if (!to || !this.party().members.includes(to)) return this.refuse(text, a, "Items can only be transferred to a captain in the same fleet.");
    if (this.isDropped(to)) return this.refuse(text, a, this.cap(to).name + " is disconnected, so nothing can be transferred to or from their ship until they return.");
    const slot = a.item ? this.findSlot(this.cid, a.item) : null;
    if (!slot || !empty(slot.story)) return this.refuse(text, a, "That item is not available to transfer.");
    const r = this.doTransfer(this.cid, to, slot.key, false);
    if (isErr(r)) return this.refuse(text, a, r.message);
    return this.finish(text, a, `TRANSFERRED: one ${slot.name} to ${this.cap(to).name} of the ${this.state(to).ship.name}. Acknowledge briefly. No cost.`, { effort: "low" });
  }

  doTransfer(from, to, key, fromDialogue) {
    const slot = this.findSlot(from, key);
    if (!slot) return fromDialogue ? this.systemLine("That item is no longer in the hold.") : new GdError("gd_item", "That item is not in the hold.");
    if (!this.party(from).members.includes(Rules.intval(to))) return fromDialogue ? this.systemLine("That captain is no longer in your fleet.") : new GdError("gd_item", "That captain is not in your fleet.");
    if (!Game.addItem(this.state(to), slot.item, { name: slot.name, desc: slot.desc ?? "" })) return fromDialogue ? this.systemLine("Their hold is full.") : new GdError("gd_item", `${this.cap(to).name}'s hold is full.`);
    Game.takeItem(this.state(from), slot.key);
    this.claimHeldBack(from);
    this.notice(`${this.cap(from).name} transferred ${slot.name} to ${this.cap(to).name}.`, [from, to]);
    return { ok: true };
  }

  requestItem(text, a) {
    const from = this.targetCaptain(a);
    if (!from || !this.party().members.includes(from)) return this.refuse(text, a, "An item can only be requested from a captain in the same fleet. Join their fleet first.");
    if (this.isDropped(from)) return this.refuse(text, a, this.cap(from).name + " is disconnected, so their items cannot be transferred until they return.");
    const slot = a.item ? this.findSlot(from, a.item) : null;
    if (!slot || !empty(slot.story)) return this.refuse(text, a, "That captain does not hold that item.");
    if (!empty(this.state(from).pending)) return this.refuse(text, a, "That captain is busy. Ask again in a moment.");
    this.state(from).pending = {
      type: "dialogue", kind: "item_request", from: this.cid, item: slot.key, title: "Transfer request",
      message: `${this.cap().name} of the ${this.state().ship.name} asks you to transfer: ${slot.name}. Declining costs nothing.`,
      buttons: [{ id: "give", label: "Transfer" }, { id: "decline", label: "Decline" }]
    };
    return this.finish(text, a, `REQUEST SENT to ${this.cap(from).name} for one ${slot.name}. They have not answered yet. Acknowledge briefly. No cost.`, { effort: "low" });
  }

  declineItem(p) {
    this.notice(`${this.cap().name} declined the transfer request.`, [this.cid, Rules.intval(p.from)]);
    return { ok: true };
  }

  /* =================================================================== missions and stages */

  async acceptMission(text, a) {
    const party = this.party();
    if (party.stage) return this.refuse(text, a, "A mission stage is already under way.");
    if (!this.leads(party)) return this.refuse(text, a, "The fleet leader decides which mission the fleet takes on.");
    const here = [...Game.missions(this.w, this.g.id, ["available", "suspended", "active"]).values()].filter(m => m.sector === party.position && this.mayTake(m));
    if (!here.length) return this.refuse(text, a, "There is no mission to take on in this sector.");
    // Prefer the one the captain named; otherwise critical first.
    here.sort((x, y) => y.is_critical - x.is_critical);
    let m = here[0];
    for (const cand of here) if (text.toLowerCase().includes(String(cand.data.title).toLowerCase())) m = cand;
    const lock = this.lockedReason(m);
    if (lock) return this.refuse(text, a, lock);
    return this.finish(text, a, (m.status === "available" ? this.startMission(m) : this.beginStage(m)) + "\nSet the scene for the stage in the voices of the crew. No cost.", {});
  }

  /* Any captain or fleet may pick up a held mission, or one left between stages (§6.3). One party at a time. */
  mayTake(m) {
    return !this.inPlay(m.id) && empty(m.data.progress?.recovery_pending);
  }

  inPlay(missionId) {
    return Object.values(this.g.parties).some(p => !empty(p.stage) && Rules.intval(p.stage.mission_id) === Rules.intval(missionId));
  }

  /* Why a mission cannot start yet, or '' (§6.3). */
  lockedReason(m) {
    const dep = Rules.intval(m.data.depends_on ?? 0);
    if (dep) {
      const all = Game.missions(this.w, this.g.id);
      if (all.has(dep) && all.get(dep).status !== "completed") return 'This mission cannot begin until "' + all.get(dep).data.title + '" is complete.';
    }
    if (m.is_final) {
      for (const o of Game.missions(this.w, this.g.id).values()) {
        if (o.is_critical && !o.is_final && (!["completed", "failed"].includes(o.status) || !empty(o.data.bridge_pending))) return "The final mission cannot begin until every other critical mission is complete.";
      }
    }
    const need = Game.effectiveRequirement(this.w, m, this.g, this.caps);
    const present = this.order(this.party()).length;
    if (present < need) return `Requires ${need} captains — ${present} present. Form a fleet to attempt it.`;
    return "";
  }

  /* Start (or resume) the mission's current stage for this party. Returns a line for Call B. */
  beginStage(m) {
    const pid = this.pid();
    const party = this.g.parties[pid];
    const prog = m.data.progress;
    const idx = Rules.intval(prog.stage);
    const def = prog.recovery_def ?? m.data.stages[idx];
    const saved = prog.saved_stage ?? null;
    const carry = Rules.intval(prog.carry_momentum ?? 0);
    // Adaptive layer, hidden (§7.6): a fleet uses its shared record, a lone captain their own.
    const record = party.members.length > 1 && !empty(party.climaxes) ? party.climaxes : toList(this.state(Turn.partyLeader(this.g, party))?.climaxes ?? []);
    let shift = Engine.adaptiveShift(record) + Rules.intval(prog.next_shift ?? 0);
    shift = Math.max(-1, Math.min(2, shift));
    const points = {};
    for (const cid of party.members) points[cid] = Rules.STAGE_POINTS; // each member keeps their own allowance (§3.3.2)
    const stage = {
      mission_id: m.id,
      mission_title: m.data.title,
      idx,
      def,
      shift,
      points: saved ? Object.assign({}, points, saved.points) : points,
      tier0: {},
      momentum: saved ? 0 : carry, // Momentum resets when a resumed mission is re-entered (§6.4)
      used: saved ? saved.used : [],
      used_all: saved ? saved.used_all : [],
      actions: saved ? saved.actions : 0,
      threat: saved ? saved.threat : def.threat,
      contacts: saved ? saved.contacts : def.contacts,
      turn: 0,
      bench: [],
      missing_helper: false,
      decisions: []
    };
    party.stage = stage;
    party.channel = null;
    this.freshStage = true;
    for (const mc of party.members) if (this.caps.has(mc)) this.state(mc).decisions = [];
    m.status = "active";
    m.data.progress.owners = uniq([...toList(prog.owners ?? []), ...party.members]);
    delete m.data.progress.saved_stage;
    delete m.data.progress.carry_momentum;
    delete m.data.progress.next_shift;
    Game.saveMission(this.w, m);
    this.w.store.event(this.g.id, 0, "system", { what: "stage_start", mission: m.id, stage: idx, adaptive_shift: shift, party: party.members }, this.g.turn);
    const total = m.data.stages.length;
    return (saved ? "RESUMED " : "") + "STAGE " + (idx + 1) + ` of ${total}: ${def.title}. Situation: ${def.situation} Objective: ${def.objective}`;
  }

  /* Resolve the stage from its climax result (§7.6). Returns plain-language text for Call B. */
  async stageEnd(outcome) {
    const pid = this.pid();
    const party = this.g.parties[pid];
    const stage = party.stage;
    let m = Game.missions(this.w, this.g.id).get(stage.mission_id);
    const left = Rules.intval(stage.points?.[this.cid] ?? 0);
    party.climaxes = [...toList(party.climaxes ?? []), outcome].slice(-5);
    for (const mc of party.members) if (this.caps.has(mc)) this.state(mc).climaxes = [...toList(this.state(mc).climaxes ?? []), outcome].slice(-5);
    party.stage = null;
    this.standDown(party.members);
    party.contacts = stage.contacts;
    this.w.store.event(this.g.id, this.cid, "system", { what: "stage_end", mission: m.id, stage: stage.idx, climax: outcome, points_left: stage.points, momentum: stage.momentum }, this.g.turn);

    if (outcome === "failure") {
      m.data.progress.failures = Rules.intval(m.data.progress.failures) + 1;
      if (m.data.progress.failures === 1) {
        // First failure in a mission: a recovery stage puts it back on track at a harder baseline.
        const why = "The decisive attempt at the stage's objective failed. The objective was: " + stage.def.objective;
        const def = await Generator.recoveryStage(this.w, this.g, m, stage.def, why);
        if (!def) {
          m.data.progress.recovery_pending = { stage: stage.def, why, tried: time() };
          Game.saveMission(this.w, m);
          return "STAGE FAILED. The mission is not over, but what happens next is not yet clear: the crew is still taking stock. The recovery stage will begin shortly.";
        }
        m.data.progress.recovery_def = def;
        Game.saveMission(this.w, m);
        const intro = this.beginStage(Game.missions(this.w, this.g.id).get(m.id));
        return `STAGE FAILED. The mission is not over: a recovery stage begins at once. ${intro}`;
      }
      return "STAGE FAILED for the second time in this mission. " + (await this.failMission(m, "Two stages failed. The last was: " + stage.def.title + ". Its objective was: " + stage.def.objective));
    }

    let text = outcome === "critical_success" ? "STAGE WON decisively." : outcome === "success" ? "STAGE WON." : "STAGE WON AT A COST.";
    m.data.progress.carry_momentum = Engine.carryMomentum(outcome, left);
    if (outcome === "partial") {
      // A complication carries forward: ship damage, an injury, or a harder next stage.
      const kind = this.pick(["damage", "injury", "harder"], "complication");
      if (kind === "damage") text += " Complication: " + this.damageParty(10, true);
      else if (kind === "injury") {
        const fit = Object.entries(this.state().crew).filter(([, o]) => empty(o.injury)).map(([r]) => r);
        text += " Complication: " + (fit.length ? this.injure(this.cid, this.pick(fit, "who"), "light", "physical") : this.damageParty(10, false));
      } else {
        m.data.progress.next_shift = 1;
        text += " Complication: the next stage will be harder than planned.";
      }
    }
    if (outcome === "critical_success" && this.chance(CHANCE_CLIMAX_ITEM, "climax")) {
      const rar = this.chance(35, "climaxrar") ? "advanced" : "standard";
      text += " " + this.grant(this.cid, this.pick(Rules.itemIdsBy(rar), "climaxitem"), "a reward for the decisive result");
    }
    delete m.data.progress.recovery_def;
    if (!empty(stage.def.recovery)) {
      // The failed stage is not replayed: the recovery stage dealt with it, and the mission goes on harder.
      m.data.progress.next_shift = Math.max(1, Rules.intval(m.data.progress.next_shift ?? 0));
    }
    m.data.progress.stage = Rules.intval(stage.idx) + 1;
    if (m.data.progress.stage >= m.data.stages.length) return text + " " + this.completeMission(m);
    Game.saveMission(this.w, m);
    const next = m.data.stages[m.data.progress.stage];
    const sec = next.sector ?? m.sector;
    if (sec === party.position) return text + " The next stage begins here. " + this.beginStage(Game.missions(this.w, this.g.id).get(m.id));
    m.sector = sec;
    Game.saveMission(this.w, m);
    return text + ` The next stage of this mission is in sector ${sec}. Tell the captain where to go next; they may travel anywhere in range first.`;
  }

  completeMission(m) {
    m.status = "completed";
    Game.saveMission(this.w, m);
    this.storyStanding(m, "on_success", "Mission completed: " + m.data.title);
    const party = this.party();
    const got = new Map();
    for (const cid of party.members) { // each member receives the reward; items are not split (§3.3.2)
      for (const item of Generator.rewardItems(this.g, m)) {
        if (!got.has(cid)) got.set(cid, []);
        got.get(cid).push(this.grant(cid, item, "mission reward"));
      }
    }
    for (const cid of this.caps.keys()) this.removeStoryItems(cid, m.id);
    this.w.store.canonAdd(this.g.id, "event", "mission_" + m.id, { text: "Mission completed: " + m.data.title + "." }, { sector: party.position, mission_id: m.id });
    let text = "MISSION COMPLETE: " + m.data.title + ". " + (got.get(this.cid) ?? []).join(" ");
    for (const [cid, lines] of got) if (cid !== this.cid && lines.length) this.notice(lines.join(" "), [cid]);
    // What this mission turned up points the way to what comes next.
    let leads;
    [this.g, leads] = Game.openLeads(this.w, this.g);
    for (const lead of leads) text += " A LEAD TO WHAT COMES NEXT HAS BEEN FOUND, and an officer reports it as something this mission turned up: " + lead.text + " (It points to sector " + lead.sector + ".)";
    if (m.is_final) {
      let bridges = 0;
      for (const o of Game.missions(this.w, this.g.id).values()) bridges = Math.max(bridges, Rules.intval(o.data.progress?.bridges ?? 0));
      this.g.status = "ended";
      this.g.ended = time();
      this.w.store.event(this.g.id, 0, "notice", { text: "The campaign is complete. " + this.g.story.ending, audience: "all", speaker: setting.FLEET_COMMAND, ending: true, say: true }, this.g.turn);
      this.w.store.event(this.g.id, 0, "system", { what: "campaign_ended", bridges }, this.g.turn);
      text += " THE FINAL MISSION IS RESOLVED AND THE CAMPAIGN ENDS. Ending: " + this.g.story.ending + (bridges ? ` Earlier failures made this a costlier victory (${bridges} missions had to be bridged); let that show.` : "");
    }
    return text;
  }

  /* Standing also moves with the story: each mission declares what its outcome means to the factions (§9.1). */
  storyStanding(m, when, reason) {
    const worth = Prompts.standingChanges();
    for (const e of toList(m.data.standing?.[when] ?? [])) {
      if (this.g.factions[e.faction]) this.g = Game.changeStanding(this.w, this.g, e.faction, worth[e.change], reason);
    }
  }

  removeStoryItems(cid, missionId) {
    const st = this.state(cid);
    st.inventory = st.inventory.filter(s => empty(s.story) || Rules.intval(s.mission) !== Rules.intval(missionId));
  }

  /* A failed critical mission is bridged, without limit; a failed side mission is simply gone (§6.4). */
  async failMission(m, why) {
    m.status = "failed";
    Game.saveMission(this.w, m);
    this.storyStanding(m, "on_failure", "Mission failed: " + m.data.title);
    for (const cid of toList(m.data.progress?.owners ?? [])) if (this.caps.has(cid)) this.removeStoryItems(cid, m.id);
    this.w.store.canonAdd(this.g.id, "event", "mission_" + m.id, { text: "Mission failed: " + m.data.title + "." }, { sector: m.sector, mission_id: m.id });
    let text = "MISSION FAILED: " + m.data.title + ".";
    if (m.is_critical) {
      const mid = await Generator.bridge(this.w, this.g, m, why);
      if (!isErr(mid) && mid) [this.g] = Game.openLeads(this.w, this.g); // new orders say where to go
      if (isErr(mid)) {
        // The failure stays canon (§6.4). New orders are held and requested again until they arrive.
        m = Game.missions(this.w, this.g.id).get(m.id);
        m.data.bridge_pending = { why, tried: time() };
        Game.saveMission(this.w, m);
        text += ` ${setting.FLEET_COMMAND} has been informed. New orders are pending.`;
      } else {
        const b = Game.missions(this.w, this.g.id).get(mid);
        text += ' The failure stands, but there is another way. NEW ORDERS reach the ship: "' + b.data.title + '" in sector ' + b.sector + ". " + b.data.briefing;
        this.notice("New orders: " + b.data.title + " (sector " + b.sector + "). " + b.data.briefing, "all", { speaker: setting.FLEET_COMMAND, except: this.party().members });
      }
    }
    return text;
  }

  /* =================================================================== leaving a stage (§6.4) */

  askLeave(kind, text, a, onlyOption = false, extra = {}) {
    const party = this.party();
    const stage = party.stage;
    if (kind === "retreat" && !this.leads(party) && !onlyOption && !this.forced(party)) {
      return this.refuse(text, a, "The fleet moves together and the fleet leader decides when it withdraws. To go alone, leave the fleet.");
    }
    const m = Game.missions(this.w, this.g.id).get(stage.mission_id);
    const failing = m.data.on_abandon === "fail";
    let msg = failing ? "Leaving now will fail: " + m.data.title + "." : "Leaving now will hold: " + m.data.title + ". The stage will be kept until you return to this sector.";
    let buttons;
    if (kind === "retreat") {
      const near = Grid.coordKey(Grid.nearestSector(Rules.intval(this.g.options.size), Grid.parseCoord(party.position)));
      msg += ` The ship will retreat to the nearest sector, ${near}.` + (onlyOption ? " With no turn points left, retreat is the only option." : "");
      buttons = onlyOption ? [{ id: "retreat", label: "Retreat" }] : [{ id: "leave", label: "Leave" }, { id: "stay", label: "Stay" }];
    } else if (party.members.length > 1) {
      // Leaving a fleet mid-stage does not end the mission: the others carry on without this ship.
      msg = "You are part-way through a stage with your fleet. If you go, the others carry on without you and the rest of that stage becomes one difficulty band harder for them. Go anyway?";
      buttons = [{ id: "accept", label: "Go" }, { id: "stay", label: "Stay" }];
    } else {
      msg += " Accept the fleet request anyway?";
      buttons = [{ id: "accept", label: "Accept" }, { id: "stay", label: "Stay" }];
    }
    this.state().pending = Object.assign({
      type: "dialogue", kind: "leave", why: kind, title: kind === "retreat" ? "Retreat" : "Fleet request", message: msg, buttons, text, a,
      free: onlyOption || this.forced(party), stamp: this.stamp()
    }, extra);
    this.w.store.event(this.g.id, this.cid, "system", { what: "leave_warning", mission: m.id, on_abandon: m.data.on_abandon, why: kind }, this.g.turn);
    return { ok: true, dialogue: true };
  }

  /* The captain chose Leave or Accept on the warning. */
  async doLeave(p) {
    if (p.why !== "retreat") {
      await this.leaveStage({ solo: true });
      return this.fleetJoinNow(p.text, p.a, Rules.intval(p.target), !empty(p.invited));
    }
    const a = Object.assign({}, p.a);
    let cost = p.free ? 0 : RETREAT_COST;
    const have = Rules.intval(this.party().stage?.points?.[this.cid] ?? 0);
    cost = Math.min(cost, have); // a retreat is never blocked by bookkeeping
    this.spend(cost);
    a.action_class = "manoeuvre";
    a.tier = 2;
    a.is_stage_climax = false;
    a.understood_as = "Retreat: break off and leave the sector.";
    if (!["threat_assessment", "composure", "improvisation", "power_management"].includes(a.attribute)) {
      a.officer = "tactical";
      a.attribute = "threat_assessment";
    }
    return this.prepareRoll(p.text, a, cost, "retreat");
  }

  /* Take the party (or one member) out of its stage. The mission fails or is held by its hidden type. */
  async leaveStage(o) {
    const pid = this.pid();
    const party = this.g.parties[pid];
    const stage = party.stage;
    if (!stage) return "";
    const m = Game.missions(this.w, this.g.id).get(stage.mission_id);
    const solo = !empty(o.solo) && party.members.length > 1;
    if (solo) {
      // One member leaves a fleet mid-stage: the rest carry on, one band harder (§3.3.1).
      stage.missing_helper = true;
      return "";
    }
    let text = "";
    if (m.data.on_abandon === "fail") {
      text = await this.failMission(m, "The mission was abandoned during: " + stage.def.title + ".");
    } else {
      m.status = "suspended";
      const saved = {};
      for (const k of ["points", "used", "used_all", "actions", "threat", "contacts"]) if (own(stage, k)) saved[k] = stage[k];
      if (isArr(saved.threat)) saved.threat.active = false;
      m.data.progress.saved_stage = saved;
      Game.saveMission(this.w, m);
      text = 'The mission "' + m.data.title + '" is held and can be resumed by returning to sector ' + party.position + ".";
    }
    this.g.parties[pid].stage = null;
    this.standDown(party.members);
    this.g.parties[pid].channel = null;
    if (empty(o.solo)) {
      const near = Grid.coordKey(Grid.nearestSector(Rules.intval(this.g.options.size), Grid.parseCoord(party.position)));
      text += " " + (await this.arrive(near, false));
    }
    return text.trim();
  }

  /* =================================================================== travel (§7.4) */

  travel(text, a) {
    const party = this.party();
    if (!this.leads(party)) return this.refuse(text, a, "The fleet leader chooses where the fleet goes next.");
    const size = Rules.intval(this.g.options.size);
    let dest = null;
    if (a.destination === "next_mission") {
      const led = toList(this.g.leads ?? []).map(l => l.mission);
      for (const m of Game.missions(this.w, this.g.id, ["active", "suspended", "available"]).values()) {
        const mine = ["active", "suspended"].includes(m.status) ? toList(m.data.progress?.owners ?? []).some(o => party.members.includes(o)) : m.is_critical && led.includes(m.id);
        if (mine) {
          dest = Grid.parseCoord(m.sector);
          break;
        }
      }
    } else {
      dest = Grid.parseCoord(String(a.destination ?? ""));
    }
    if (!dest || !Grid.inBounds(size, dest)) return this.refuse(text, a, "No valid destination was given. Name a sector by its coordinates, or select one on the map and say so.");
    const from = Grid.parseCoord(party.position);
    const range = Game.partyRange(party, this.caps);
    const key = Grid.coordKey(dest);
    if (key === party.position) return this.refuse(text, a, "The ship is already in that sector.");
    if (Grid.reachable(from, dest, range)) return this.doTravel(key, text, a);
    const dist = Math.round(Grid.distanceLy(from, dest) * 10) / 10;
    const partial = Grid.coordKey(Grid.partialDestination(size, from, dest, range));
    if (partial === party.position) return this.refuse(text, a, `Sector ${key} is ${dist} light-years away and the ship's range this turn is ${range}.`);
    this.state().pending = {
      type: "dialogue", kind: "travel_partial", title: "Out of range",
      message: `Sector ${key} is ${dist} light-years away. Range this turn is ${range} light-years. Go as far as possible along the route, to sector ${partial}, or pick another destination within range.`,
      buttons: [{ id: "go", label: `Go to ${partial}` }, { id: "cancel", label: "Choose another" }],
      partial, text, stamp: this.stamp()
    };
    return { ok: true, dialogue: true };
  }

  async doTravel(coord, text, a = null) {
    a = a ?? Prompts.validateCallA({ understood_as: "Travel to sector " + coord, action_class: "move", tier: 1, officer: "tactical", attribute: "none", difficulty_band: "routine", intent: "travel", destination: coord });
    this.state().range_bonus = 0;
    const fx = await this.arrive(coord, true);
    // A travel turn is one action with no point cost (§7.4).
    return this.finish(text, a, `TRAVEL COMPLETE. ${fx}\nDescribe the arrival briefly from the bridge. No cost.`, { consume: true, ends_turn: true });
  }

  /* Move the party and handle everything arrival triggers. Returns text for Call B. */
  async arrive(coord, explore) {
    const pid = this.pid();
    const size = Rules.intval(this.g.options.size);
    const party = this.g.parties[pid];
    party.last_position = party.position;
    party.position = coord;
    party.contacts = [];
    party.channel = null;
    this.standDown(party.members);
    // Unanswered invitations lapse when the requester's fleet travels (§3.3.1).
    for (const c of this.caps.values()) c.state.invites = toList(c.state.invites ?? []).filter(i => !party.members.includes(Rules.intval(i.from)));
    const first = Game.markSector(this.w, this.g.id, coord, 2, size);
    const sec = Game.sector(this.w, this.g.id, coord, size);
    let text = `The ship is now in sector ${coord}` + (!empty(sec.data.place) ? " (" + sec.data.place + ")" : "") + ": " + String(sec.data.type ?? "").split("_").join(" ") + (!empty(sec.data.hazard) ? ", hazard: " + sec.data.hazard.split("_").join(" ") : "") + ".";
    if (sec.faction) this.g = Game.meetFaction(this.g, sec.faction);
    if (explore && first && sec.data.type !== "empty" && this.chance(CHANCE_EXPLORE_ITEM, "visit")) text += " " + this.grant(this.cid, this.pick(Rules.itemIdsBy("standard", "consumable"), "visititem"), "found on first exploring this sector");
    text += await this.missionsHere(coord, sec, explore);
    return text;
  }

  /* What is waiting for this ship in the sector it is in, begun at once (§14.7). A mission never waits to be accepted. */
  async missionsHere(coord, sec, explore) {
    const pid = this.pid();
    const party = this.g.parties[pid];
    let text = "";
    let start = null;
    let left = null;
    const locked = [];
    for (const m of Game.missions(this.w, this.g.id, ["active", "suspended", "available"]).values()) {
      if (m.sector !== coord || this.g.parties[pid].stage) continue;
      const mine = toList(m.data.progress?.owners ?? []).some(o => party.members.includes(o));
      if (!empty(m.data.progress?.recovery_pending)) {
        if (mine) text += ' The recovery stage of "' + m.data.title + '" is still being prepared.';
      } else if (this.inPlay(m.id)) {
        continue; // another party is playing it
      } else if (["active", "suspended"].includes(m.status) && this.lockedReason(m) === "") {
        if (mine) text += " " + this.beginStage(m); // a mission in progress continues, or a held one resumes
        else if (!left) left = m; // held by another captain: any captain may pick it up (§6.3)
      } else if (m.status === "available") {
        const lock = this.lockedReason(m);
        if (lock) locked.push('"' + m.data.title + '": ' + lock);
        else if (!start || (m.is_critical && !start.is_critical)) start = m;
      }
    }
    if (this.g.parties[pid].stage) return text;
    if (start) return text + " " + this.startMission(start);
    if (left) return text + ' MISSION TAKEN UP WHERE ANOTHER SHIP LEFT IT: "' + left.data.title + '". ' + this.beginStage(left);
    if (locked.length) return text + " A MISSION IS HERE BUT CANNOT BEGIN YET. " + locked.join(" ");
    if (explore && this.chance(CHANCE_RANDOM_EVENT, "random")) {
      const mid = await Generator.randomEncounter(this.w, this.g, coord, sec); // generated on demand so it stays fresh (§5.3)
      if (mid) return text + " SOMETHING UNEXPECTED. " + this.startMission(Game.missions(this.w, this.g.id).get(mid));
    }
    return text;
  }

  /* Begin a mission that has not been started: its first stage opens with a full allowance of turn points. */
  startMission(m) {
    let intro = this.beginStage(m);
    // A mission that needs a story item hands it over at the start; it takes no cargo space (§7.3).
    if (!empty(m.data.reward?.story_item)) {
      Game.addItem(this.state(), "", { story: true, name: m.data.reward.story_item, desc: "Needed for: " + m.data.title, mission: m.id });
      intro += " The ship now carries: " + m.data.reward.story_item + ".";
    }
    return 'MISSION BEGINS: "' + m.data.title + '". ' + m.data.briefing + " " + intro;
  }

  /* =================================================================== fleets (§3.3.1): each takes the whole turn */

  processArrivals() {
    const pid = this.pid();
    for (const [cid, c] of this.caps) {
      if ((c.state.joining ?? "") === pid) {
        this.mergeInto(cid, pid);
        c.state.joining = "";
        this.notice(c.name + " of the " + c.state.ship.name + " has arrived and joined the fleet.", this.g.parties[pid].members);
      }
    }
  }

  /* Move one captain out of their party into another. Joining ignores travel range. */
  mergeInto(cid, pid) {
    if (this.state(cid).party === pid) return;
    this.detach(cid);
    const party = this.g.parties[pid];
    party.members.push(Rules.intval(cid));
    this.state(cid).party = pid;
    this.state(cid).invites = [];
    if (party.stage) {
      // Joining mid-stage: own allowance, a place in the order from the next round.
      if (party.stage.points[cid] === undefined) party.stage.points[cid] = Rules.STAGE_POINTS;
      party.stage.bench = [...toList(party.stage.bench ?? []), Rules.intval(cid)];
    }
  }

  /* Remove a captain from their current party, passing leadership on or dissolving it. */
  detach(cid) {
    const old = this.state(cid).party;
    if (!this.g.parties[old]) return;
    const p = this.g.parties[old];
    p.members = p.members.filter(m => m !== Rules.intval(cid));
    if (!p.members.length) {
      delete this.g.parties[old];
      return;
    }
    if (Rules.intval(p.leader) === Rules.intval(cid)) {
      for (const o of this.g.order) { // leadership passes to the next member in the fixed order
        if (p.members.includes(Rules.intval(o))) {
          p.leader = Rules.intval(o);
          break;
        }
      }
    }
  }

  fleetJoin(text, a) {
    const invites = toList(this.state().invites ?? []);
    let target = this.targetCaptain(a);
    let invited = false;
    for (const inv of invites) {
      if (!target || Rules.intval(inv.from) === target) {
        target = Rules.intval(inv.from);
        invited = true;
        break;
      }
    }
    if (!target) return this.refuse(text, a, "Name the captain whose fleet you want to join.");
    if (this.party().members.includes(target)) return this.refuse(text, a, "You are already in a fleet with that captain.");
    const tp = this.g.parties[this.pid(target)];
    if (tp.members.length >= Rules.MAX_CAPTAINS) return this.refuse(text, a, "That fleet is full.");
    if (this.party().stage) return this.askLeave("fleet", text, a, false, { target, invited });
    return this.fleetJoinNow(text, a, target, invited);
  }

  fleetJoinNow(text, a, target, invited) {
    const tpid = this.pid(target);
    const name = this.cap(target).name;
    if (invited) {
      // Accepting a request: you appear beside the requester at the start of their next turn.
      this.detach(this.cid);
      const solo = "p" + this.cid + "t" + this.g.turn;
      this.g.parties[solo] = Game.newParty(solo, this.cid, this.g.parties[tpid].position);
      const s = this.state();
      s.party = solo;
      s.joining = tpid;
      s.joining_at = time();
      s.invites = [];
      this.notice(this.cap().name + " has accepted the fleet request and will arrive at the start of your next turn.", [target]);
      return this.finish(text, a, `FLEET REQUEST ACCEPTED. This takes the whole turn. The ship sets course to join ${name} and will appear beside them at the start of their next turn. Acknowledge briefly.`, { ends_turn: true, consume: true, effort: "low" });
    }
    // Joining unasked: taken to the other captain, and in the fleet from then on. The fleet forms around them.
    this.mergeInto(this.cid, tpid);
    this.notice(this.cap().name + " of the " + this.state().ship.name + " has joined your fleet.", this.g.parties[tpid].members.filter(m => m !== this.cid));
    return this.finish(text, a, `FLEET JOINED. This takes the whole turn. The ship is taken to ${name}'s position, sector ${this.g.parties[tpid].position}, and is now part of their fleet. ${name} leads it. Acknowledge briefly.`, { ends_turn: true, consume: true, effort: "low" });
  }

  fleetRequest(text, a) {
    const pid = this.pid();
    const party = this.party();
    const sent = [];
    for (const seat of a.target_captains) {
      for (const [cid, c] of this.caps) {
        if (c.seat === Rules.intval(seat) && cid !== this.cid && !party.members.includes(cid)) {
          const inv = toList(c.state.invites ?? []).filter(i => Rules.intval(i.from) !== this.cid);
          inv.push({ from: this.cid, party: pid, turn: this.g.turn });
          c.state.invites = inv;
          sent.push(c.name);
          this.notice(this.cap().name + " of the " + this.state().ship.name + " asks you to join their fleet. You may accept or decline on your next turn. Declining costs nothing.", [cid]);
        }
      }
    }
    if (!sent.length) return this.refuse(text, a, "Name at least one captain outside your fleet to invite.");
    // The fleet forms around the requester: they lead it.
    return this.finish(text, a, "FLEET REQUEST SENT to " + sent.join(", ") + ". This takes the whole turn, however many were asked. Each decides for themselves on their next turn. Acknowledge briefly.", { ends_turn: true, consume: true, effort: "low" });
  }

  fleetDecline(text, a) {
    const inv = toList(this.state().invites ?? []);
    if (!inv.length) return this.refuse(text, a, "There is no fleet request to decline.");
    const target = this.targetCaptain(a);
    const keep = [];
    for (const i of inv) {
      if (target && Rules.intval(i.from) !== target) keep.push(i);
      else this.notice(this.cap().name + " has declined the fleet request.", [Rules.intval(i.from)]);
    }
    this.state().invites = keep;
    // Declining is free; the captain then takes their turn normally.
    return this.finish(text, a, "FLEET REQUEST DECLINED. No cost. Acknowledge briefly.", { effort: "low" });
  }

  async fleetLeave(text, a) {
    const party = this.party();
    if (party.members.length < 2) return this.refuse(text, a, "You are not in a fleet.");
    const size = Rules.intval(this.g.options.size);
    const dest = Grid.parseCoord(String(a.destination ?? ""));
    if (!dest || !Grid.inBounds(size, dest)) return this.refuse(text, a, "To leave the fleet, say where you want to go.");
    const from = Grid.parseCoord(party.position);
    const range = Game.rangeLy(this.state());
    const to = Grid.reachable(from, dest, range) ? dest : Grid.partialDestination(size, from, dest, range);
    await this.leaveStage({ solo: true });
    const old = this.pid();
    this.detach(this.cid);
    const solo = "p" + this.cid + "t" + this.g.turn;
    this.g.parties[solo] = Game.newParty(solo, this.cid, party.position);
    this.state().party = solo;
    if (this.g.parties[old]) {
      this.notice(this.cap().name + " has left the fleet.", this.g.parties[old].members);
      if (this.g.parties[old].members.length === 1 && this.g.parties[old].stage) this.g.parties[old].stage.missing_helper = true;
    }
    const fx = await this.arrive(Grid.coordKey(to), true);
    return this.finish(text, a, `LEFT THE FLEET. This takes the whole turn. The ship departs alone. ${fx}` + (Grid.coordKey(to) !== Grid.coordKey(dest) ? " The destination was out of range, so the ship went as far as it could along the route." : ""), { ends_turn: true, consume: true });
  }
}

module.exports = {
  Turn, UNCHECKED, CHANCE_EXPLORE_ITEM, CHANCE_CRIT_ITEM, CHANCE_CLIMAX_ITEM, CHANCE_RANDOM_EVENT, RETREAT_COST, RETRY_EVERY,
  stageOrder: Turn.stageOrder, stageForced: Turn.stageForced, holder: Turn.holder, partyLeader: Turn.partyLeader, withoutStage: Turn.withoutStage
};
