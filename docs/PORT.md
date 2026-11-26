# Galactic Dominion: porting the story game to the desktop app

This file is the contract every part of the port follows. Decisions recorded here were made by the owner;
anything not covered here must be asked about, not invented.

## What is being built

A Windows desktop game (Electron, the existing app in `roleplayer/`). Two modes:

- **Story** (built first): a port of a WordPress plugin's multiplayer AI roleplay game, in which every player is
  a captain with one ship and a six-officer crew, in a generated 3D galaxy, with a campaign that ends. The plugin's
  source is the reference, together with its build brief `BRIEF.md`. Keep its rules, numbers and behaviour exactly,
  except for the changes listed below.
- **Galactic Conquest** (later): empires, systems, fleets. Not part of this stage.

The plugin is set in the Star Trek universe. **Galactic Dominion has its own setting and names** (below). Nothing from
Star Trek may remain: no faction, species, ship, technology, place, rank system particular to it, era or the word
"LCARS".

Owner decisions:

| Area | Decision |
|---|---|
| Platform | Windows desktop app, the existing Electron app |
| AI | **Local only**: the app's own engine (a private Ollama, see `main.js`). No cloud providers, no API keys |
| Multiplayer | **The host's PC is the server.** Player One's app runs the game server; other players' apps connect to it over the network by address and port. A shared screen (hot-seat) also works, as in the plugin |
| Voices | **The app's local voices** (`main.js`: standard Kokoro voices; expressive and described voices where available). No Edge TTS |
| Speech input | The app's local speech recognition (`main.js`: Whisper) |
| Orders | Every game order is spoken or typed and sent to the AI, as in the plugin. Only the game menu and system dialogues are buttons |
| Look | The HUD style of the approved mockups: https://claude.ai/artifact/NUGWyCnnzoFMXX7oqaj2xi (dark glass panels, cyan glow, cut corners, corner brackets, Orbitron / Rajdhani / Exo 2, amber for "you" and "your turn") |

## The safety check (kept from the desktop app)

The app's safety check (`main.js` `checkSafety`, the messages in `built-in.js` `safety`, the helplines in
`helplines.js`) runs in the game:

- **Every order a captain gives** (typed or heard) is checked as the user's text before it is acted on. If it is
  flagged, the order is not carried out and costs nothing.
- **Every line the AI writes** (narration, crew, characters, the Computer) is checked as a character's text before it
  is shown or spoken. A flagged line is removed, with what the turn would have shown after it.
- The check runs on the host, where the game server is. The help screen (the app's existing messages: the flagged
  message, the helplines for **that player's own country**, "carry on" and "close") appears **only on the screen of
  the captain concerned**: the one who gave the order, or whose turn produced the line.
- **Other players see only that the captain's turn is on hold**, with no reason given ("Captain X's turn is on
  hold"). Nothing about it goes into the log, the canon or any other captain's context.
- "Carry on" returns to the game as the app does now (after an order: it is the captain's turn again; after a line:
  the turn goes on without it). "Close" leaves that captain's turn on hold.
- If the hold lasts past the turn timer, the game pauses for everyone with the neutral pause message, as any pause
  does, until that captain carries on. With one captain there is no timer; the game simply waits.
- If the check cannot run, the game does what the app does now: the turn stops with the message that the safety
  check could not run.

## Architecture

```
roleplayer/
  main.js            Electron main: engine, voices, speech recognition (existing) + starts the game server
  game/              the game, pure Node (CommonJS), no Electron: testable with `node --test`
    setting.js       Galactic Dominion's setting: factions, species, resources, items' names, era text
    rules.js         from class-rules.php
    engine.js        from class-engine.php
    advice.js        from class-advice.php
    grid.js          from class-grid.php (seeded generator: must give the same galaxy for the same seed)
    jsonstream.js    from class-jsonstream.php
    library.js       from class-library.php: ship/crew validation, CSV in and out, saved builds
    store.js         replaces class-db.php: JSON files under the data folder, one folder per game
    llm.js           replaces class-llm.php: calls the local engine through a function passed in (see below)
    prompts.js       from class-prompts.php
    voices.js        replaces class-voices.php: assigns local voices to officers, the Computer and characters
    generator.js, context.js, turn.js, game.js, view.js   from the classes of the same names
    server.js        replaces class-rest.php, class-live.php, class-codes.php and class-cron.php
  test/              node:test tests, ported from the plugin's tests/
  renderer/          the interface (replaces the roleplay interface)
```

- **The server** is plain Node `http` inside the main process, listening on a port chosen by the host (default
  47800; on all interfaces while hosting). Routes and JSON shapes follow `class-rest.php` and `class-view.php`, with
  names changed only where the setting requires it. Live updates and the streamed turn follow `class-live.php`'s
  message shapes, over server-sent events / a streamed response, without the Edge speech parts.
- **Access.** No WordPress accounts. Player One is whoever creates the game on the host app. The host sets a 4-digit
  join code when creating the game (it replaces the site-wide join code); the checks, rate limit and lockout of
  `class-codes.php` apply. The creator code is dropped: the creator is part of each player's own app.
- **The interface** is one client for all players: the host's own window connects to `http://127.0.0.1:<port>`,
  other players' windows to the host's address. Speech is made on each player's own PC from line text and a voice id
  sent by the server; speech recognition is local too.
- **The AI.** `llm.js` exports a factory taking `{ chat, chatStream }` functions with the shapes of `chat()` and
  `chatStream()` in `main.js` (model, messages, temperature, json/format, context). JSON calls (Call A, generation)
  pass a JSON schema as Ollama's `format`. Tests use a scripted stand-in. Which model: the app's default model setting.
- **Storage.** Everything under the app's data folder (`app.getPath("userData")`), passed in as a path, never
  computed inside `game/`. Writes are atomic (write to `.tmp`, rename).
- **Pause and timeouts** run on timers in the server process instead of WordPress cron.

## The setting

Every player serves **the Concord of Worlds** ("the Concord"), and their ships are Concord starships, prefix
**CSV** (e.g. CSV Meridian), registry form **CR-1024**. Orders come from **Concord Fleet Command**. The era: five
years after the end of **the Long War** against the Orrin Compact; the Concord is rebuilding.

Factions (key, name, starting standing towards the Concord, note):

| key | name | standing | note |
|---|---|---|---|
| concord | The Concord of Worlds | 10 | Rebuilding after the Long War. Every captain serves it |
| drav | Drav Imperium | 6 | Warrior people; allies since fighting beside the Concord in the war |
| seluun | Seluun Veil | -1 | Wartime ally, but secretive and distrusted |
| marr | Marr Union | -2 | Devastated by the war and rebuilding |
| ossan | Ossan Guilds | 1 | Merchant guilds; deal with anyone |
| haldane | Free Haldane | 5 | Close partner world after occupation and war |
| orrin | Orrin Compact | -6 | The Long War's enemy, withdrawn beyond the Rift since its end |
| kethri | Kethri Swarm | -10 | A hive that absorbs what it meets; known afresh from scouts returned from the far reaches |
| vashtar | Vashtar Hegemony | -6 | On the losing side of the war |
| choir | Crystalline Choir | -3 | Territorial and unwilling to speak with outsiders |
| skarn | Skarn Dominion | -2 | Wary neighbours with a history of border disputes |
| blacktide | Black Tide Syndicate | -4 | Criminal network operating across borders |

Species (same bonus shapes as the plugin's ten, in this order):

| Plugin | Galactic Dominion | Bonus |
|---|---|---|
| Human | Human | +3 placed by the player |
| Vulcan | Seluun | composure 2, sensor analysis 1 |
| Andorian | Vey | accuracy 2, threat assessment 1 |
| Tellarite | Ossan | repair 2, power management 1 |
| Betazoid | Lirae | diplomacy 2, threat assessment 1 |
| Trill | Joined Ament | xenology 1, improvisation 1, command presence 1 |
| Bajoran | Haldani | improvisation 2, composure 1 |
| Bolian | Quell | composure 2, diplomacy 1 |
| Denobulan | Teneri | xenology 3 |
| Klingon | Drav | accuracy 3 |

Resources: dilithium → **aetherite**, deuterium → **hydrex**, duranium → **corundite**, latinum ore → **aurelium
ore**, kelbonite → **veilstone**. Hazards keep their generic names.

Technology words: warp → **jump** (jump drive, jump coil, jump core); impulse → **thrusters**; phasers/photon
torpedoes → **lances / torpedoes**; tricorder → **scanner**; transporter → **matter relay**; holodeck, replicator and
other Star Trek inventions are not used. Item names in the catalogue are renamed the same way (Overcharged warp coil →
Overcharged jump coil, Impulse tuning kit → Thruster tuning kit, Prototype warp core → Prototype jump core).

Ranks (Captain, Commander, Lieutenant, Ensign, Chief, Doctor) are kept: they are ordinary naval ranks.

Grid presets keep the plugin's sizes and critical-mission counts, renamed **Skirmish, Standard, Expanse, Deep Void**.

Prompts are rewritten for this setting: "Starfleet" becomes the Concord, "Star Trek universe ... era" becomes the
era text above, "canon Star Trek factions" becomes "the factions of the setting, from the FACTIONS list". The LLM
must be told not to use Star Trek names.

## Working rules

- Port behaviour, not just shape: the plugin's tests are ported to `node:test` and must pass.
- No new game rules. Where the plugin used a WordPress feature, use the equivalent named above; where there is
  none, stop and report it rather than inventing one.
- Code style follows `main.js`: comments say what and why in plain words, no frameworks.
