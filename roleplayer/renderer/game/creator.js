"use strict";
/*
 * Galactic Dominion: the ship and crew creator (port of the plugin's creator.js, brief 4.5, 4.4, 10), in the HUD look.
 *
 * It is part of each player's own app: there is no creator code. It works on the library of the game server the app
 * is talking to (GD.base), through the same routes the plugin's creator used, under /creator.
 * Validation here mirrors the library's check_ship() / check_crew() message for message, so the live checks, the CSV
 * importer and the save endpoint all say the same thing.
 * GD.Creator.open(onBack) shows it; onBack is called when the player leaves it.
 */
(function () {
	'use strict';
	var GD = window.GD;
	var root = null, onBack = null;
	var HUMAN_POINTS = 3;
	var ROLE_COLOUR = { tactical: '#FF8FB4', engineer: '#FFD58F', science: '#8DF3FF', first_officer: '#FFB547', medical: '#4DFFC3', helm: '#C4B5FD' };

	var S = {
		rules: null,
		view: 'loading',     // loading | list | editor | fatal | closed
		builds: [],
		model: null,
		dirty: false,
		touched: {},
		showAll: false,
		serverErrs: {},      // field key => [messages] from a 422
		panel: null,         // null | 'upload' | 'leave'
		report: null,        // last CSV import result
		downloads: null,     // { files:[{name,text}], note }
		notice: null,        // { kind:'msg'|'err', text }
		busy: false
	};
	var E = {};   // editor field registry: key => { el, err, row }
	var R = {};   // other live references (counters, buttons ...)
	var V = null; // last validation result

	/* ------------------------------------------------------------------ helpers */

	function h(tag, attrs, kids) {
		var el = document.createElement(tag), k;
		if (attrs) {
			for (k in attrs) {
				if (!Object.prototype.hasOwnProperty.call(attrs, k)) { continue; }
				var v = attrs[k];
				if (v === null || v === undefined || v === false) { continue; }
				if (k === 'class') { el.className = v; }
				else if (k === 'text') { el.textContent = v; }
				else if (k === 'style') { el.setAttribute('style', v); }
				else if (k.slice(0, 2) === 'on' && typeof v === 'function') { el.addEventListener(k.slice(2), v); }
				else if (v === true) { el.setAttribute(k, ''); }
				else { el.setAttribute(k, String(v)); }
			}
		}
		add(el, kids);
		return el;
	}
	function add(el, kids) {
		if (kids === null || kids === undefined || kids === false) { return el; }
		if (Array.isArray(kids)) { kids.forEach(function (c) { add(el, c); }); return el; }
		el.appendChild(kids instanceof Node ? kids : document.createTextNode(String(kids)));
		return el;
	}
	function clear(el) { while (el.firstChild) { el.removeChild(el.firstChild); } return el; }
	function idOf(key) { return 'cx-' + key.replace(/[^a-z0-9_]+/gi, '-'); }
	function trim(v) { return String(v === null || v === undefined ? '' : v).trim(); }
	function toInt(v) {
		var s = trim(v);
		return /^[+-]?\d{1,6}$/.test(s) ? parseInt(s, 10) : null;
	}
	function offBy(total, pool) { return total > pool ? (total - pool) + ' too many' : (pool - total) + ' too few'; }
	function slug(s) {
		var out = trim(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
		return out || 'ship';
	}
	/* ------------------------------------------------------------------ REST */

	function request(method, path, body) {
		var opts = { method: method, headers: GD.headers({ 'Accept': 'application/json' }) };
		if (body !== undefined) { opts.body = JSON.stringify(body); } else { delete opts.headers['Content-Type']; }
		return fetch(GD.base + path, opts).then(function (res) {
			return res.text().then(function (txt) {
				var json = null;
				try { json = txt ? JSON.parse(txt) : null; } catch (e) { json = null; }
				if (!res.ok || json === null || typeof json !== 'object') {
					var err = new Error((json && json.message) || 'The server did not answer as expected. Try again.');
					err.status = res.status;
					err.code = (json && json.code) || '';
					err.data = (json && json.data) || {};
					throw err;
				}
				return json;
			});
		}, function () {
			var err = new Error('The game server could not be reached. Check the connection and try again.');
			err.status = 0; err.code = 'network'; err.data = {};
			throw err;
		});
	}
	var call = request;

	/* ------------------------------------------------------------------ the HUD frame */

	function buildFrame() {
		clear(root);
		R.h1 = h('div', { class: 'brand', text: 'SHIP & CREW CREATOR' });
		R.sub = h('div', { class: 'lbl', text: 'Saved to the library · reusable in any game' });
		R.menu = h('nav', { class: 'btns cx-menu', 'aria-label': 'Creator menu' });
		R.content = h('div', { class: 'cx-stack' });
		root.appendChild(h('div', { class: 'gd-root warm' }, [
			h('header', { class: 'gd-top' }, [R.h1, R.sub]),
			h('div', { class: 'cx-page' }, [R.menu, R.content])
		]));
	}
	function setMenu(items) {
		clear(R.menu);
		R.menuBtn = {};
		items.forEach(function (it) {
			var b = h('button', { type: 'button', class: 'btn' + (it.primary ? ' btn-hot' : ''), text: it.label, onclick: it.go });
			if (it.describedby) { b.setAttribute('aria-describedby', it.describedby); }
			R.menuBtn[it.key] = b;
			R.menu.appendChild(b);
		});
		R.menu.appendChild(h('span', { class: 'cx-grow' }));
		R.backBtn = h('button', { type: 'button', class: 'btn', text: 'Close the creator', onclick: function () { if (S.view === 'editor' && S.dirty) { openPanel('leave', true); return; } close(); } });
		R.menu.appendChild(R.backBtn);
	}
	function close() {
		S.view = 'closed';
		if (previewing) { previewing = false; if (GD.Speech) { GD.Speech.stop(); } }
		var fn = onBack; onBack = null;
		if (fn) { fn(); }
	}

	var panelNo = 0;
	function panel(colour, title, code, kids, extra) {
		var head = h('h2', { class: 'hud-h cx-h', tabindex: '-1' }, [h('span', { class: 'ix', text: ('0' + (++panelNo)).slice(-2) }), title, code ? h('span', { class: 'tail', text: code }) : null]);
		var sec = h('section', { class: 'hud' + (extra ? ' ' + extra : '') + (colour === '--c5' ? ' alarm' : '') }, [head]);
		add(sec, kids);
		sec.cxHead = head;
		return sec;
	}

	function show(view, focus) {
		S.view = view;
		E = {};
		panelNo = 0;
		if (view === 'list') { renderList(); }
		else if (view === 'editor') { renderEditor(); }
		if (focus) {
			var target = R.content.querySelector('h2');
			if (target) { try { target.focus({ preventScroll: false }); } catch (e) { target.focus(); } }
		}
	}

	function noticeNode() {
		R.notice = h('div', { role: 'status', 'aria-live': 'polite' });
		drawNotice();
		return R.notice;
	}
	function drawNotice() {
		if (!R.notice) { return; }
		clear(R.notice);
		if (S.notice) { R.notice.appendChild(h('p', { class: S.notice.kind === 'err' ? 'err' : 'msgline', text: S.notice.text })); }
	}
	function notify(kind, text) { S.notice = text ? { kind: kind, text: text } : null; drawNotice(); }
	function fail(err, fallback) {
		if (err && err.handled) { return; }
		notify('err', (err && err.message) || fallback || 'Something went wrong. Try again.');
	}

	/* ------------------------------------------------------------------ library list */

	function openList(focus) {
		return call('GET', '/creator/builds').then(function (res) {
			S.builds = Array.isArray(res.builds) ? res.builds : [];
			S.model = null; S.dirty = false; S.panel = null; S.report = null; S.downloads = null;
			show('list', focus);
		}).catch(function (err) {
			if (err.handled) { return; }
			if (S.view === 'loading') { fatal(err.message, function () { openList(true); }); } else { fail(err); }
		});
	}

	function renderList() {
		R.sub.textContent = 'Saved to the library · reusable in any game';
		setMenu([
			{ key: 'new', label: 'New ship and crew', primary: true, go: function () { startNew(false); } },
			{ key: 'upload', label: 'Upload CSV', go: function () { startNew(true); } },
			{ key: 'template', label: 'Blank template', go: downloadTemplates }
		]);
		clear(R.content);
		R.content.appendChild(noticeNode());
		R.dl = h('div');
		R.content.appendChild(R.dl);
		drawDownloads();

		var body;
		if (!S.builds.length) {
			body = h('p', { class: 'empty', text: 'No ships and crews are saved yet. Start with New ship and crew, or upload a CSV.' });
		} else {
			body = h('ul', { class: 'cx-list cx-lib' }, S.builds.map(function (b) {
				return h('li', null, [
					h('div', { class: 'h' }, [
						h('span', { text: b.name || 'Unnamed ship' }),
						h('span', { class: 'btns' }, [
							h('button', { type: 'button', class: 'btn small', text: 'Edit', 'aria-label': 'Edit ' + (b.name || 'this ship') + ' and crew', onclick: function () { openBuild(b.id); } }),
							h('button', { type: 'button', class: 'btn small off', text: 'Download CSV', 'aria-label': 'Download CSV files for ' + (b.name || 'this ship') + ' and crew', onclick: function () { downloadBuild(b.id); } })
						])
					]),
					h('div', { class: 'd', text: 'Ship and crew · last changed ' + (b.modified || 'unknown') })
				]);
			}));
		}
		R.content.appendChild(panel('--c1', 'Saved ships and crews', S.builds.length + ' on record', [
			body,
			h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', text: 'New ship and crew', onclick: function () { startNew(false); } })),
			h('p', { class: 'cx-note', text: 'Every saved ship and crew can be picked in any future game on this server.' })
		]));
	}

	function fatal(message, retry) {
		S.view = 'fatal';
		setMenu([]);
		clear(R.content);
		R.content.appendChild(panel('--c5', 'Creator unavailable', '', [
			h('p', { class: 'err', role: 'alert', text: message || 'The creator could not be loaded.' }),
			h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', text: 'Try again', onclick: retry }))
		]));
	}

	/* ------------------------------------------------------------------ model */

	function roles() { return S.rules.roles; }
	function roleKeys() { return Object.keys(S.rules.roles); }
	function pools() { return S.rules.pools; }

	function blankModel() {
		var m = { id: 0, name: '', ship: { name: '', class: '', registry: '', captain: '', attrs: {} }, crew: {} };
		Object.keys(S.rules.ship).forEach(function (k) { m.ship.attrs[k] = ''; });
		roleKeys().forEach(function (r) { m.crew[r] = blankOfficer(r); });
		return m;
	}
	function blankOfficer(r) {
		var o = { name: '', species: '', gender: '', attrs: {}, hb: {}, personality: '', voice: '' };
		roles()[r].attrs.forEach(function (a) { o.attrs[a] = '0'; o.hb[a] = 0; });
		return o;
	}
	function officerFrom(r, src) {
		var o = blankOfficer(r);
		if (!src || typeof src !== 'object') { return o; }
		o.name = trim(src.name);
		o.species = Object.prototype.hasOwnProperty.call(S.rules.species, src.species) ? src.species : '';
		o.gender = S.rules.genders.indexOf(src.gender) >= 0 ? src.gender : '';
		o.personality = trim(src.personality);
		o.voice = trim(src.voice);
		o.voiceChosen = o.voice !== ''; // a saved or uploaded voice was somebody's choice
		var at = src.attrs && typeof src.attrs === 'object' ? src.attrs : {};
		roles()[r].attrs.forEach(function (a) {
			o.attrs[a] = at[a] === undefined || at[a] === null ? '0' : String(at[a]);
		});
		(Array.isArray(src.human_bonus) ? src.human_bonus : []).forEach(function (a) {
			if (Object.prototype.hasOwnProperty.call(o.hb, a)) { o.hb[a] += 1; }
		});
		return o;
	}
	function shipFrom(src) {
		var s = { name: '', class: '', registry: '', captain: '', attrs: {} };
		src = src && typeof src === 'object' ? src : {};
		s.name = trim(src.name); s.class = trim(src.class); s.registry = trim(src.registry); s.captain = trim(src.captain);
		var at = src.attrs && typeof src.attrs === 'object' ? src.attrs : {};
		Object.keys(S.rules.ship).forEach(function (k) { s.attrs[k] = at[k] === undefined || at[k] === null ? '' : String(at[k]); });
		return s;
	}
	function modelFrom(build) {
		var m = blankModel();
		m.id = parseInt(build.id, 10) || 0;
		m.name = build.name || '';
		m.ship = shipFrom(build.ship);
		roleKeys().forEach(function (r) { m.crew[r] = officerFrom(r, build.crew && build.crew[r]); });
		ensureVoices(m);
		return m;
	}

	function payload() {
		var m = S.model, ship = { name: trim(m.ship.name), class: trim(m.ship.class), registry: trim(m.ship.registry), captain: trim(m.ship.captain), attrs: {} }, crew = {};
		Object.keys(S.rules.ship).forEach(function (k) { var n = toInt(m.ship.attrs[k]); ship.attrs[k] = n === null ? m.ship.attrs[k] : n; });
		roleKeys().forEach(function (r) {
			var o = m.crew[r], out = { role: r, name: trim(o.name), species: o.species, gender: o.gender, attrs: {}, human_bonus: [], personality: trim(o.personality), voice: o.voice };
			roles()[r].attrs.forEach(function (a) {
				var n = toInt(o.attrs[a]);
				out.attrs[a] = trim(o.attrs[a]) === '' ? 0 : (n === null ? o.attrs[a] : n);
				if (o.species === 'Human') { for (var i = 0; i < (o.hb[a] || 0); i++) { out.human_bonus.push(a); } }
			});
			crew[r] = out;
		});
		return { id: m.id || 0, ship: ship, crew: crew };
	}

	/* ------------------------------------------------------------------ voices */

	function voiceById(id) {
		var list = S.rules.voices || [];
		for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
		return null;
	}
	/** Timbres and locales in use by the other officers. Twin voice ids of one speaker share a timbre (brief 10). */
	function usedByOthers(m, role) {
		var out = { timbre: {}, locale: {} };
		roleKeys().forEach(function (r) {
			if (r === role) { return; }
			var v = voiceById(m.crew[r].voice);
			if (v && v.gender === m.crew[r].gender) { out.timbre[v.timbre] = r; out.locale[v.locale] = true; }
		});
		return out;
	}
	/** A sensible default: right gender, not used by any other officer, and a fresh accent where one is free. */
	/** The voice suggested for an officer: the best-sounding one of their gender that nobody else on the ship has. */
	function pickVoice(m, role) {
		var g = m.crew[role].gender, used = usedByOthers(m, role);
		if (!g) { return ''; }
		var free = (S.rules.voices || []).filter(function (v) { return v.gender === g && !used.timbre[v.timbre]; }).sort(function (a, b) { return a.quality - b.quality; });
		return free.length ? free[0].id : '';
	}
	function ensureVoices(m) {
		roleKeys().forEach(function (r) {
			var o = m.crew[r], v = voiceById(o.voice);
			if (!o.gender) { o.voice = ''; return; }
			if (!v) { o.voice = pickVoice(m, r); } // a voice the captain chose is kept, whatever its gender
		});
	}

	/** Play the officer's own voice, the one heard in the game, made on this PC. If it cannot be played, say why: no other voice stands in. */
	var previewing = false;
	function preview(role) {
		var o = S.model.crew[role], v = voiceById(o.voice), out = R.off[role].prev, btn = R.off[role].prevBtn;
		if (!v) { return; }
		if (!GD.Speech || !GD.Speech.available()) { out.textContent = v.label + ' could not be previewed: the voices of this app are not available here.'; return; }
		GD.Speech.stop();
		out.textContent = 'Making ' + v.label + '…';
		btn.disabled = true; previewing = true;
		GD.Speech.say((trim(o.name) || 'Your ' + roles()[role].title) + ', reporting for duty, Captain.', v.id, v.made || null);
		var wait = function () {
			if (!previewing || S.view !== 'editor') { return; }
			if (GD.Speech.speaking()) { out.textContent = 'Playing ' + v.label + '.'; setTimeout(wait, 250); return; }
			previewing = false;
			out.textContent = 'That was ' + v.label + ', as this officer will sound in the game.';
			btn.disabled = !o.voice;
		};
		setTimeout(wait, 250);
	}

	/* ------------------------------------------------------------------ validation (mirrors the importer) */

	function validate() {
		var m = S.model, P = pools(), errs = [], res = { errs: errs, shipTotal: 0, crewTotal: 0, per: {}, byKey: {} };
		function push(key, msg, soft, who) { errs.push({ key: key, msg: msg, soft: !!soft, who: who || '' }); }

		if (trim(m.ship.name) === '') { push('ship.name', 'The ship needs a name.', true); }
		Object.keys(S.rules.ship).forEach(function (k) {
			var label = S.rules.ship[k], raw = m.ship.attrs[k], val = toInt(raw), key = 'ship.attr.' + k;
			if (val === null) {
				if (trim(raw) === '') { push(key, label + ' is blank. Enter a whole number from ' + P.ship_min + ' to ' + P.ship_max + '.', true); }
				else { push(key, label + ' must be a whole number from ' + P.ship_min + ' to ' + P.ship_max + ', not "' + trim(raw) + '".'); }
				return;
			}
			res.shipTotal += val;
			if (val < P.ship_min) { push(key, label + ' is ' + val + '. Every ship attribute needs at least ' + P.ship_min + ' points.'); }
			else if (val > P.ship_max) { push(key, label + ' is ' + val + '. No ship attribute may have more than ' + P.ship_max + ' points.'); }
		});
		if (res.shipTotal !== P.ship) {
			push('ship.total', 'The ship spends ' + res.shipTotal + ' points in total. It must spend exactly ' + P.ship + ' (' + offBy(res.shipTotal, P.ship) + ').');
		}

		var voices = {};
		roleKeys().forEach(function (r) {
			var def = roles()[r], o = m.crew[r], who = def.title, base = 'crew.' + r + '.';
			res.per[r] = 0;
			if (trim(o.name) === '') { push(base + 'name', who + ': a name is required.', true, who); }
			if (!o.species) { push(base + 'species', who + ': a species is required. Choose one of: ' + Object.keys(S.rules.species).join(', ') + '.', true, who); }
			if (!o.gender) { push(base + 'gender', who + ': gender is required. Choose ' + S.rules.genders.join(' or ') + '.', true, who); }
			def.attrs.forEach(function (a) {
				var label = S.rules.attributes[a], raw = o.attrs[a];
				if (trim(raw) === '') { return; } // a blank own cell counts as 0, as in the importer
				var val = toInt(raw);
				if (val === null || val < 0) {
					push(base + 'attr.' + a, who + ': ' + label + ' must be a whole number from 0 to ' + P.crew_cap + ', not "' + trim(raw) + '".', false, who);
					return;
				}
				res.per[r] += val;
				if (val > P.crew_cap) { push(base + 'attr.' + a, who + ': ' + label + ' is ' + val + '. No single attribute may have more than ' + P.crew_cap + ' allocated points.', false, who); }
			});
			if (o.species === 'Human') {
				var placed = humanPlaced(o);
				if (placed !== HUMAN_POINTS) {
					push(base + 'human', who + ': a Human officer must place all ' + HUMAN_POINTS + ' bonus points. ' + placed + ' of ' + HUMAN_POINTS + ' placed.', false, who);
				}
			}
			if (trim(o.personality) === '') { push(base + 'personality', who + ': a personality summary is required.', true, who); }
			var v = voiceById(o.voice);
			if (v && o.gender) {
				if (voices[v.timbre]) {
					push(base + 'voice', who + ': has the same voice as the ' + roles()[voices[v.timbre]].title + '. Each officer needs a different voice.', false, who);
				} else { voices[v.timbre] = r; }
			}
			res.crewTotal += res.per[r];
		});
		if (res.crewTotal !== P.crew) {
			push('crew.total', 'The crew spends ' + res.crewTotal + ' points in total across all ' + roleKeys().length + ' officers. It must spend exactly ' + P.crew + ' (' + offBy(res.crewTotal, P.crew) + ').');
		}
		errs.forEach(function (e) { (res.byKey[e.key] = res.byKey[e.key] || []).push(e); });
		return res;
	}
	function humanPlaced(o) {
		var n = 0;
		Object.keys(o.hb).forEach(function (a) { n += o.hb[a] || 0; });
		return n;
	}
	function bonusFor(role, a) {
		var o = S.model.crew[role];
		if (!o.species) { return 0; }
		if (o.species === 'Human') { return o.hb[a] || 0; }
		var sp = S.rules.species[o.species], b = sp && sp.bonus && !Array.isArray(sp.bonus) ? sp.bonus : {};
		return parseInt(b[a], 10) || 0;
	}

	/* ------------------------------------------------------------------ editor */

	function startNew(withUpload) {
		S.model = blankModel();
		S.dirty = false; S.touched = {}; S.showAll = false; S.serverErrs = {}; S.report = null; S.downloads = null; S.notice = null;
		S.panel = withUpload ? 'upload' : null;
		show('editor', true);
		if (withUpload && R.slotFocus) { R.slotFocus.focus(); }
	}
	function openBuild(id) {
		notify('msg', 'Loading the ship and crew.');
		call('GET', '/creator/builds/' + encodeURIComponent(id)).then(function (b) {
			S.model = modelFrom(b);
			S.dirty = false; S.touched = {}; S.showAll = true; S.serverErrs = {}; S.report = null; S.downloads = null; S.notice = null; S.panel = null;
				show('editor', true);
		}).catch(function (err) { fail(err); });
	}

	function register(key, el, err, row) { E[key] = { el: el, err: err || null, row: row || null }; }
	function errNode(key) { return h('p', { class: 'err cx-ferr', id: idOf(key) + '-err', hidden: true }); }
	function touch(key) { S.touched[key] = true; }
	function edited(key) {
		S.dirty = true;
		delete S.serverErrs[key];
		if (key.indexOf('.attr.') > 0) { delete S.serverErrs[key.indexOf('ship.') === 0 ? 'ship.total' : 'crew.total']; }
		refresh();
	}

	/** A labelled text-like control. `get`/`set` read and write the model. */
	function field(key, label, tag, attrs, get, set) {
		var id = idOf(key);
		var a = { id: id, 'aria-describedby': id + '-err' }, k;
		for (k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) { a[k] = attrs[k]; } }
		var el = h(tag, a);
		if (tag !== 'select') { el.value = get(); }
		el.addEventListener('input', function () { set(el.value); edited(key); });
		el.addEventListener('change', function () { touch(key); set(el.value); edited(key); });
		el.addEventListener('blur', function () { touch(key); refresh(); });
		var err = errNode(key);
		register(key, el, err);
		return h('div', { class: 'cx-f' }, [h('label', { class: 'fld', for: id }, [label, el]), err]);
	}

	/** One attribute row: label, number box, optional effective-value readout. */
	function attrRow(key, label, get, set, withOut, max) {
		var id = idOf(key);
		var el = h('input', { id: id, class: 'cx-n', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '4', 'aria-describedby': id + '-err' + (withOut ? ' ' + id + '-out' : '') });
		el.value = get();
		el.addEventListener('input', function () { set(el.value); edited(key); });
		el.addEventListener('blur', function () { touch(key); refresh(); });
		el.addEventListener('keydown', function (ev) {
			if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') { return; }
			var n = toInt(el.value);
			if (n === null && trim(el.value) !== '') { return; }
			ev.preventDefault();
			n = Math.max(0, Math.min(max, (n === null ? 0 : n) + (ev.key === 'ArrowUp' ? 1 : -1)));
			el.value = String(n); set(el.value); edited(key);
		});
		var out = withOut ? h('output', { id: id + '-out', for: id }) : null;
		var row = h('div', { class: 'cx-ar' + (withOut ? '' : ' two') }, [h('label', { for: id, text: label }), el, out]);
		var err = errNode(key);
		register(key, el, err, row);
		E[key].out = out;
		return [row, err];
	}

	function renderEditor() {
		var m = S.model, P = pools();
		setMenu([
			{ key: 'save', label: 'Save', primary: true, go: save, describedby: 'cx-save-why' },
			{ key: 'upload', label: 'Upload CSV', go: function () { openPanel('upload'); } },
			{ key: 'download', label: 'Download CSV', go: function () { downloadBuild(S.model.id); }, describedby: 'cx-dl-why' },
			{ key: 'template', label: 'Blank template', go: downloadTemplates },
			{ key: 'back', label: 'Back to list', go: leave }
		]);
		clear(R.content);
		R.content.appendChild(noticeNode());
		R.slots = h('div', { class: 'cx-stack' });
		R.dl = h('div');
		R.content.appendChild(R.slots);
		R.content.appendChild(R.dl);
		R.off = {};

		/* ---- ship ---- */
		R.shipCount = h('div', { class: 'cx-counter', 'aria-live': 'polite' });
		var shipGeneral = errNode('ship.general'); register('ship.general', null, shipGeneral);
		var shipLeft = h('div', { class: 'cx-grid' }, [
			field('ship.name', 'Ship name', 'input', { type: 'text', maxlength: '80', autocomplete: 'off' }, function () { return m.ship.name; }, function (v) { m.ship.name = v; }),
			h('div', { class: 'two' }, [
				field('ship.class', 'Class (optional)', 'input', { type: 'text', maxlength: '60', autocomplete: 'off' }, function () { return m.ship.class; }, function (v) { m.ship.class = v; }),
				field('ship.registry', 'Registry (optional)', 'input', { type: 'text', maxlength: '40', autocomplete: 'off' }, function () { return m.ship.registry; }, function (v) { m.ship.registry = v; })
			]),
			h('p', { class: 'cx-note', text: 'Leave class or registry blank and they are generated for you when the ship is first saved.' }),
			field('ship.captain', 'Captain\'s name (optional)', 'input', { type: 'text', maxlength: '60', autocomplete: 'off' }, function () { return m.ship.captain; }, function (v) { m.ship.captain = v; }),
			h('p', { class: 'cx-note', text: 'With a captain named here, the player who takes this ship is not asked for a name.' }),
			R.shipCount, shipGeneral
		]);
		var shipRows = h('div', { class: 'cx-rows' });
		Object.keys(S.rules.ship).forEach(function (k) {
			add(shipRows, attrRow('ship.attr.' + k, S.rules.ship[k], function () { return m.ship.attrs[k]; }, function (v) { m.ship.attrs[k] = v; }, false, P.ship_max));
		});
		var shipPanel = panel('--c1', 'Ship', P.ship + ' points · six attributes · ' + P.ship_min + ' to ' + P.ship_max + ' each',
			h('div', { class: 'cx-cols' }, [shipLeft, shipRows]), 'full');

		/* ---- crew ---- */
		R.crewCount = h('div', { class: 'cx-counter', 'aria-live': 'polite' });
		R.saveWhy = h('p', { class: 'cx-save', id: 'cx-save-why', role: 'status' });
		var crewGeneral = errNode('crew.general'); register('crew.general', null, crewGeneral);
		var crw = h('div', { class: 'cx-crew' }, roleKeys().map(officerNode));
		var crewPanel = panel('--c2', 'Command crew', P.crew + ' points shared by all ' + roleKeys().length, [
			h('div', { class: 'cx-sticky' }, [R.crewCount, R.saveWhy]),
			crewGeneral,
			h('p', { class: 'cx-note', text: 'Each attribute takes 0 to ' + P.crew_cap + ' allocated points. Species bonuses sit on top and are not counted in the ' + P.crew + '. ' +
				'Voices: in the game each officer speaks with the voice selected here, and Preview plays that same voice on this PC.' }),
			crw
		], 'full');

		/* ---- save check ---- */
		R.probs = h('div', { class: 'cx-probs' });
		R.saveBtn2 = h('button', { type: 'button', class: 'btn', text: 'Save', onclick: save, 'aria-describedby': 'cx-save-why' });
		R.dlWhy = h('p', { class: 'cx-note', id: 'cx-dl-why' });
		var checkPanel = panel('--c4', 'Save check', '', [R.probs, h('div', { class: 'btns' }, R.saveBtn2), R.dlWhy], 'full');
		R.checkHead = checkPanel.cxHead;

		R.content.appendChild(h('div', { class: 'cx-cols' }, [shipPanel, crewPanel, checkPanel]));
		drawSlots();
		drawDownloads();
		refresh();
	}

	function officerNode(r) {
		var m = S.model, def = roles()[r], o = m.crew[r], base = 'crew.' + r + '.', P = pools(), ref = {};
		R.off[r] = ref;

		var general = errNode(base + 'general'); register(base + 'general', null, general);
		ref.pts = h('p', { class: 'cx-pts' });

		var species = field(base + 'species', 'Species', 'select', {}, function () { return o.species; }, function (v) { o.species = v; });
		var sel = E[base + 'species'].el;
		sel.appendChild(h('option', { value: '', text: 'Choose' }));
		Object.keys(S.rules.species).forEach(function (s) { sel.appendChild(h('option', { value: s, text: s })); });
		sel.value = o.species;

		/* gender: a two-option selector (brief 10) */
		var gKey = base + 'gender', gId = idOf(gKey), gErr = errNode(gKey);
		var seg = h('div', { class: 'cx-seg', role: 'radiogroup', 'aria-labelledby': gId + '-cap', 'aria-describedby': gId + '-err' });
		var firstRadio = null;
		S.rules.genders.forEach(function (g) {
			var radio = h('input', { type: 'radio', name: gId, id: gId + '-' + g.toLowerCase(), value: g });
			radio.checked = o.gender === g;
			radio.addEventListener('change', function () {
				if (!radio.checked) { return; }
				o.gender = g;
				if (!o.voiceChosen) { o.voice = pickVoice(m, r); } // the suggestion follows the gender; a voice the captain picked is left alone
				delete S.serverErrs[base + 'voice'];
				ref.prev.textContent = '';
				touch(gKey); edited(gKey);
			});
			firstRadio = firstRadio || radio;
			seg.appendChild(h('label', { for: radio.id }, [radio, g]));
		});
		register(gKey, firstRadio, gErr);
		var gender = h('div', { class: 'cx-f' }, [h('span', { class: 'cx-cap', id: gId + '-cap', text: 'Gender' }), seg, gErr]);

		/* voice */
		var vKey = base + 'voice', vId = idOf(vKey), vErr = errNode(vKey);
		ref.voice = h('select', { id: vId, 'aria-describedby': vId + '-err ' + vId + '-prev' });
		ref.voice.addEventListener('change', function () { o.voice = ref.voice.value; o.voiceChosen = true; ref.prev.textContent = ''; touch(vKey); edited(vKey); });
		ref.prevBtn = h('button', { type: 'button', class: 'btn small', text: 'Preview', 'aria-label': 'Preview the ' + def.title + '\'s voice', onclick: function () { preview(r); } });
		ref.prev = h('p', { class: 'cx-note', id: vId + '-prev', role: 'status' });
		register(vKey, ref.voice, vErr);
		var voice = h('div', { class: 'cx-f' }, [
			h('div', { class: 'cx-voice' }, [h('label', { class: 'fld', for: vId }, ['Voice', ref.voice]), ref.prevBtn]),
			vErr, ref.prev
		]);

		/* attributes */
		ref.hum = h('p', { class: 'cx-hum', id: idOf(base + 'human'), hidden: true });
		var humErr = errNode(base + 'human'); register(base + 'human', null, humErr);
		ref.note = h('p', { class: 'cx-note', hidden: true });
		ref.step = {};
		var rows = [];
		def.attrs.forEach(function (a) {
			var label = S.rules.attributes[a];
			rows = rows.concat(attrRow(base + 'attr.' + a, label, function () { return o.attrs[a]; }, function (v) { o.attrs[a] = v; }, true, P.crew_cap));
			var minus = h('button', { type: 'button', text: '−', 'aria-label': 'Take a Human bonus point off ' + label, onclick: function () { stepHuman(r, a, -1); } });
			var plus = h('button', { type: 'button', text: '+', 'aria-label': 'Put a Human bonus point on ' + label, onclick: function () { stepHuman(r, a, 1); } });
			var n = h('b', { text: '0' });
			var line = h('div', { class: 'cx-step', hidden: true, role: 'group', 'aria-label': 'Human bonus on ' + label }, [h('span', { text: 'Human bonus' }), minus, n, plus]);
			ref.step[a] = { line: line, minus: minus, plus: plus, n: n };
			rows.push(line);
		});
		if (!E[base + 'human'].el) { E[base + 'human'].el = ref.step[def.attrs[0]].plus; }

		return h('fieldset', { class: 'cx-off hud', style: '--oc:' + (ROLE_COLOUR[r] || '#8DF3FF') }, [
			h('legend', { text: def.title }),
			general,
			field(base + 'name', 'Name', 'input', { type: 'text', maxlength: '80', autocomplete: 'off' }, function () { return o.name; }, function (v) { o.name = v; }),
			h('div', { class: 'two' }, [species, gender]),
			voice,
			field(base + 'personality', 'Personality', 'textarea', { rows: '3', maxlength: '600' }, function () { return o.personality; }, function (v) { o.personality = v; }),
			ref.note, ref.hum, humErr,
			rows,
			ref.pts
		]);
	}

	function stepHuman(r, a, d) {
		var o = S.model.crew[r], placed = humanPlaced(o), cur = o.hb[a] || 0;
		if (d > 0 && placed >= HUMAN_POINTS) { return; }
		if (d < 0 && cur <= 0) { return; }
		o.hb[a] = cur + d;
		var key = 'crew.' + r + '.human', st = R.off[r].step[a], keep = d > 0 ? st.plus : st.minus;
		touch(key); edited(key);
		if (keep.disabled) { (d > 0 ? st.minus : st.plus).focus(); } // keep keyboard focus on a live control
	}

	function drawVoice(r) {
		var m = S.model, o = m.crew[r], ref = R.off[r], sel = ref.voice, used = usedByOthers(m, r);
		var sig = o.gender + '|' + o.voice + '|' + Object.keys(used.timbre).sort().join(',');
		if (sel.getAttribute('data-sig') !== sig) {
			sel.setAttribute('data-sig', sig);
			clear(sel);
			if (!o.gender) {
				sel.appendChild(h('option', { value: '', text: 'Choose a gender first' }));
			} else {
				// Every voice is offered, marked male or female; the officer's own gender is listed first, best voices at the top.
				[o.gender, o.gender === 'Male' ? 'Female' : 'Male'].forEach(function (g) {
					var group = h('optgroup', { label: g + ' voices' });
					(S.rules.voices || []).filter(function (v) { return v.gender === g; }).sort(function (a, b) { return a.quality - b.quality; }).forEach(function (v) {
						var taken = used.timbre[v.timbre] && v.id !== o.voice;
						group.appendChild(h('option', { value: v.id, disabled: taken, text: v.label + ' · ' + g + (taken ? ' · used by ' + roles()[used.timbre[v.timbre]].label : '') }));
					});
					sel.appendChild(group);
				});
				if (!o.voice) { sel.insertBefore(h('option', { value: '', text: 'No voice free' }), sel.firstChild); }
			}
			sel.value = o.voice;
		}
		sel.disabled = !o.gender;
		ref.prevBtn.disabled = !o.voice;
	}

	/** Recompute everything that depends on the model. Never rebuilds inputs, so focus and carets survive. */
	function refresh() {
		if (S.view !== 'editor' || !S.model) { return; }
		var m = S.model, P = pools();
		V = validate();

		/* per-field messages */
		Object.keys(E).forEach(function (key) {
			var f = E[key], seen = {}, msgs = [];
			(V.byKey[key] || []).forEach(function (e) {
				if (e.soft && !S.showAll && !S.touched[key]) { return; }
				var text = e.who && e.msg.indexOf(e.who + ': ') === 0 ? e.msg.slice(e.who.length + 2) : e.msg;
				text = text.charAt(0).toUpperCase() + text.slice(1);
				if (!seen[text]) { seen[text] = 1; msgs.push(text); }
			});
			(S.serverErrs[key] || []).forEach(function (text) { if (!seen[text]) { seen[text] = 1; msgs.push(text); } });
			if (key === 'ship.total' || key === 'crew.total') { return; }
			if (f.err) {
				clear(f.err);
				msgs.forEach(function (t, i) { if (i) { f.err.appendChild(h('br')); } f.err.appendChild(document.createTextNode(t)); });
				f.err.hidden = !msgs.length;
			}
			if (f.el && f.el.tagName !== 'BUTTON') {
				if (msgs.length) { f.el.setAttribute('aria-invalid', 'true'); } else { f.el.removeAttribute('aria-invalid'); }
			}
			if (f.row) { f.row.classList.toggle('bad', msgs.length > 0); }
		});

		/* ship counter */
		counter(R.shipCount, V.shipTotal, P.ship, 'All points placed.', (S.serverErrs['ship.total'] || []));

		/* crew counter (shared by all five, always visible) */
		counter(R.crewCount, V.crewTotal, P.crew, 'All points placed. Species bonuses sit on top and are not counted.', (S.serverErrs['crew.total'] || []));

		/* officers */
		roleKeys().forEach(function (r) {
			var def = roles()[r], o = m.crew[r], ref = R.off[r], any = false, human = o.species === 'Human', placed = humanPlaced(o);
			def.attrs.forEach(function (a) {
				var f = E['crew.' + r + '.attr.' + a], raw = trim(o.attrs[a]), val = raw === '' ? 0 : toInt(raw), b = bonusFor(r, a);
				if (!human && b) { any = true; }
				clear(f.out);
				if (val === null || val < 0) { f.out.textContent = '—'; }
				else if (b) { add(f.out, [val + ' (+' + b + ' ' + o.species + ') = ', h('b', { text: String(val + b) })]); }
				else { add(f.out, ['= ', h('b', { text: String(val) })]); }
				var st = ref.step[a];
				st.line.hidden = !human;
				st.n.textContent = String(o.hb[a] || 0);
				st.minus.disabled = (o.hb[a] || 0) <= 0;
				st.plus.disabled = placed >= HUMAN_POINTS;
			});
			ref.hum.hidden = !human;
			if (human) {
				ref.hum.textContent = 'Human: ' + placed + ' of ' + HUMAN_POINTS + ' placed' + (placed === HUMAN_POINTS ? '' : ' · place them with the + buttons below');
				ref.hum.classList.toggle('bad', placed !== HUMAN_POINTS);
			}
			var inert = !!o.species && !human && !any;
			ref.note.hidden = !inert;
			if (inert) { ref.note.textContent = o.species + ' bonuses apply to attributes the ' + def.title + ' does not have, so this officer gains no species bonus.'; }
			clear(ref.pts);
			add(ref.pts, ['Points allocated ', h('b', { text: String(V.per[r]) })]);
			drawVoice(r);
		});

		/* save state */
		var n = V.errs.length, why;
		R.saveWhy.classList.toggle('bad', n > 0);
		if (S.busy) { why = 'Working.'; }
		else if (n) { why = 'Save is blocked · ' + n + (n === 1 ? ' thing' : ' things') + ' to fix · ' + V.errs[0].msg; }
		else if (S.dirty || !m.id) { why = 'Ready to save.'; }
		else { why = 'Saved. No unsaved changes.' + (!trim(m.ship.class) || !trim(m.ship.registry) ? ' Class and registry could not be generated just now. They will be generated the next time this ship is saved, or when it is first taken into a game.' : ''); }
		if (R.saveWhy.textContent !== why) { R.saveWhy.textContent = why; }
		var blocked = n > 0 || S.busy;
		R.menuBtn.save.disabled = blocked;
		R.saveBtn2.disabled = blocked;
		R.menuBtn.download.disabled = !m.id || S.busy;
		R.menuBtn.upload.disabled = S.busy;
		R.menuBtn.template.disabled = S.busy;
		R.dlWhy.textContent = !m.id ? 'Download CSV becomes available once this ship and crew has been saved.'
			: (S.dirty ? 'Download CSV gives the last saved version. Save first to include your changes.' : 'Download CSV gives two files: the ship and the crew.');

		clear(R.probs);
		if (!n) {
			R.probs.appendChild(h('p', { class: 'msgline', text: 'Everything is valid. ' + (S.dirty || !m.id ? 'The ship and crew can be saved.' : 'Nothing has changed since the last save.') }));
		} else {
			R.probs.appendChild(h('p', { class: 'err', text: 'Save is blocked until ' + (n === 1 ? 'this is' : 'these ' + n + ' things are') + ' fixed. Select one to go to it.' }));
			V.errs.forEach(function (e) {
				R.probs.appendChild(h('button', { type: 'button', text: e.msg, onclick: function () { jump(e.key); } }));
			});
		}

		R.sub.textContent = (m.id ? 'Editing ' + (trim(m.ship.name) || m.name || 'saved ship') : 'New ship and crew') + (S.dirty ? ' · unsaved changes' : '');
	}

	function counter(el, total, pool, okText, serverMsgs) {
		var ok = total === pool, small = ok ? okText : (total > pool ? (total - pool) + ' over. Save is blocked.' : (pool - total) + ' left to place. Save is blocked.');
		if (serverMsgs.length) { small += ' ' + serverMsgs.join(' '); }
		var sig = total + '|' + small;
		if (el.getAttribute('data-sig') === sig) { return; }
		el.setAttribute('data-sig', sig);
		el.className = 'cx-counter' + (ok && !serverMsgs.length ? '' : ' bad');
		clear(el);
		add(el, [total + ' / ' + pool, h('small', { text: small })]);
	}

	function jump(key) {
		var target = null;
		S.touched[key] = true;
		refresh();
		if (key === 'ship.total') { target = E['ship.attr.' + Object.keys(S.rules.ship)[0]].el; }
		else if (key === 'crew.total') { var r0 = roleKeys()[0]; target = E['crew.' + r0 + '.attr.' + roles()[r0].attrs[0]].el; }
		else if (E[key]) { target = E[key].el; }
		if (key.slice(-6) === '.human') {
			var r = key.split('.')[1], steps = R.off[r].step;
			Object.keys(steps).some(function (a) { if (!steps[a].plus.disabled) { target = steps[a].plus; return true; } return false; });
		}
		if (key.slice(-7) === '.gender') {
			var radios = E[key].el.closest('.cx-seg').querySelectorAll('input');
			target = radios[0];
		}
		if (target) {
			target.focus();
			if (target.scrollIntoView) { target.scrollIntoView({ block: 'center' }); }
		}
	}

	/* ------------------------------------------------------------------ save */

	function setBusy(on) { S.busy = on; refresh(); }

	function save() {
		if (S.busy || !S.model) { return; }
		S.showAll = true;
		refresh();
		if (V.errs.length) { R.checkHead.focus(); return; }
		S.serverErrs = {};
		notify('msg', 'Saving.');
		setBusy(true);
		call('POST', '/creator/builds', payload()).then(function (b) {
			S.model = modelFrom(b);
			S.dirty = false; S.touched = {}; S.showAll = true; S.serverErrs = {}; S.panel = null;
			S.busy = false;
			S.notice = { kind: 'msg', text: 'Saved. ' + (b.name || 'The ship and crew') + ' is in the library and can be picked in any game.' };
			show('editor', false);
			R.content.querySelector('h2').focus();
		}).catch(function (err) {
			S.busy = false;
			if (err.handled) { return; }
			if (err.data && err.data.errors) {
				placeServerErrors(err.data.errors);
				notify('err', 'Not saved. The server found problems. They are shown next to the fields and in the save check.');
				refresh();
				var keys = Object.keys(S.serverErrs);
				if (keys.length) { jump(keys[0]); }
				return;
			}
			refresh();
			fail(err, 'The ship and crew could not be saved.');
		});
	}

	/** Server errors carry role and column, which is enough to put each one beside its field. */
	function placeServerErrors(errors) {
		var out = {};
		function put(key, msg) { (out[key] = out[key] || []).push(msg); }
		(Array.isArray(errors.ship) ? errors.ship : []).forEach(function (e) {
			var col = e.column, msg = String(e.message || '');
			if (col === 'ship_name') { put('ship.name', msg); }
			else if (col === 'ship_class') { put('ship.class', msg); }
			else if (col === 'registry') { put('ship.registry', msg); }
			else if (col === 'captain_name') { put('ship.captain', msg); }
			else if (col && Object.prototype.hasOwnProperty.call(S.rules.ship, col)) { put('ship.attr.' + col, msg); }
			else if (!col) { put('ship.total', msg); }
			else { put('ship.general', msg); }
		});
		(Array.isArray(errors.crew) ? errors.crew : []).forEach(function (e) {
			var col = e.column, r = e.role, msg = String(e.message || '');
			if (!r || !roles()[r]) { put(col ? 'crew.general' : 'crew.total', msg); return; }
			var base = 'crew.' + r + '.', who = roles()[r].title + ': ';
			if (msg.indexOf(who) === 0) { msg = msg.slice(who.length); msg = msg.charAt(0).toUpperCase() + msg.slice(1); }
			if (col === 'name' || col === 'gender' || col === 'personality' || col === 'voice') { put(base + col, msg); }
			else if (col === 'race' || col === 'species') { put(base + 'species', msg); }
			else if (col && col.indexOf('human_bonus') === 0) { put(base + 'human', msg); }
			else if (col && roles()[r].attrs.indexOf(col) >= 0) { put(base + 'attr.' + col, msg); }
			else { put(base + 'general', msg); }
		});
		S.serverErrs = out;
	}

	/* ------------------------------------------------------------------ in-page panels: leave guard, upload, import report */

	var leaveToClose = false;
	function openPanel(name, closing) {
		leaveToClose = !!closing;
		S.panel = name;
		drawSlots();
		if (R.slotFocus) { R.slotFocus.focus(); if (R.slotFocus.scrollIntoView) { R.slotFocus.scrollIntoView({ block: 'center' }); } }
	}
	function closePanel(returnTo) {
		S.panel = null;
		drawSlots();
		var b = R.menuBtn && R.menuBtn[returnTo];
		if (b && !b.disabled) { b.focus(); }
	}

	function leave() {
		if (S.busy) { return; }
		if (S.dirty) { openPanel('leave'); return; }
		openList(true);
	}

	function drawSlots() {
		if (!R.slots) { return; }
		clear(R.slots);
		R.slotFocus = null;

		if (S.panel === 'leave') {
			var stay = h('button', { type: 'button', class: 'btn', text: 'Stay and keep editing', onclick: function () { closePanel('back'); } });
			R.slots.appendChild(h('div', { class: 'dlg', role: 'alertdialog', 'aria-labelledby': 'cx-leave-h', 'aria-describedby': 'cx-leave-p' }, [
				h('h3', { id: 'cx-leave-h', text: 'Leave without saving?' }),
				h('p', { id: 'cx-leave-p', text: 'This ship and crew has changes that are not saved. If you leave now they are lost.' }),
				h('div', { class: 'btns' }, [
					stay,
					h('button', { type: 'button', class: 'btn warn', text: 'Leave without saving', onclick: function () { S.dirty = false; if (leaveToClose) { close(); } else { openList(true); } } })
				])
			]));
			R.slotFocus = stay;
		}

		if (S.panel === 'upload') {
			var shipIn = h('input', { type: 'file', id: 'cx-up-ship', accept: '.csv,.xlsx,text/csv,text/plain' });
			var crewIn = h('input', { type: 'file', id: 'cx-up-crew', accept: '.csv,.xlsx,text/csv,text/plain' });
			var msg = h('p', { class: 'err', role: 'alert', hidden: true });
			var go = h('button', { type: 'button', class: 'btn', text: 'Read files', onclick: function () { upload(shipIn, crewIn, msg, go); } });
			var up = panel('--c3', 'Upload CSV', 'Ship file · crew file', [
				h('p', { class: 'cx-lead', text: 'Choose a ship file, a crew file, or both. Each file is checked and loaded into the editor below, replacing that part of it. Nothing is saved until you press Save.' }),
				h('div', { class: 'cx-cols' }, [
					h('div', { class: 'cx-f cx-file' }, h('label', { class: 'fld', for: 'cx-up-ship' }, ['Ship CSV', shipIn])),
					h('div', { class: 'cx-f cx-file' }, h('label', { class: 'fld', for: 'cx-up-crew' }, ['Crew CSV', crewIn]))
				]),
				msg,
				h('div', { class: 'btns' }, [go, h('button', { type: 'button', class: 'btn off', text: 'Close', onclick: function () { closePanel('upload'); } })])
			]);
			R.slots.appendChild(up);
			R.slotFocus = shipIn;
		}

		if (S.report) { R.slots.appendChild(reportNode(S.report)); }
	}

	function readFile(file) {
		return new Promise(function (resolve, reject) {
			var fr = new FileReader();
			fr.onload = function () {
				var bytes = new Uint8Array(fr.result), bin = '';
				for (var i = 0; i < bytes.length; i += 8192) { bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); }
				resolve(btoa(bin));
			};
			fr.onerror = function () { reject(new Error('The file "' + file.name + '" could not be read.')); };
			fr.readAsArrayBuffer(file);
		});
	}

	function upload(shipIn, crewIn, msg, go) {
		var sf = shipIn.files && shipIn.files[0], cf = crewIn.files && crewIn.files[0];
		function say(t) { msg.textContent = t; msg.hidden = !t; }
		if (!sf && !cf) { say('Choose at least one file first.'); shipIn.focus(); return; }
		say('');
		go.disabled = true;
		Promise.all([sf ? readFile(sf) : '', cf ? readFile(cf) : '']).then(function (texts) {
			var body = {}, empty = [];
			if (sf) { if (texts[0] === '') { empty.push(sf.name); } else { body.ship_file = texts[0]; } }
			if (cf) { if (texts[1] === '') { empty.push(cf.name); } else { body.crew_file = texts[1]; } }
			if (!body.ship_file && !body.crew_file) { throw new Error('The file is empty. It needs a header row and the data rows.'); }
			return call('POST', '/creator/import', body).then(function (res) {
				if (res.ship_error || res.crew_error) { throw new Error(res.ship_error || res.crew_error); }
				applyImport(res, { ship: sf ? sf.name : '', crew: cf ? cf.name : '', empty: empty });
			});
		}).catch(function (err) {
			go.disabled = false;
			if (err && err.handled) { return; }
			say((err && err.message) || 'The files could not be read.');
		});
	}

	function applyImport(res, names) {
		var m = S.model;
		if (res.ship && res.ship.ship) {
			m.ship = shipFrom(res.ship.ship);
		}
		if (res.crew && res.crew.crew && typeof res.crew.crew === 'object') {
			roleKeys().forEach(function (r) {
				if (res.crew.crew[r]) { m.crew[r] = officerFrom(r, res.crew.crew[r]); }
			});
			ensureVoices(m);
		}
		S.report = { ship: res.ship || null, crew: res.crew || null, names: names };
		S.dirty = true; S.showAll = true; S.serverErrs = {}; S.panel = null; S.touched = {};
		S.notice = null;
		show('editor', false);
		if (R.reportHead) { R.reportHead.focus(); R.reportHead.scrollIntoView({ block: 'start' }); }
	}

	function errorList(errors) {
		return h('ul', { class: 'cx-list' }, errors.map(function (e) {
			var where = [];
			if (e.row) { where.push('Row ' + e.row); }
			if (e.column) { where.push('column ' + e.column); }
			return h('li', null, [
				h('div', { class: 'h' }, h('span', { text: where.length ? where.join(' · ') : 'Whole file' })),
				h('div', { class: 'd', style: 'color:var(--text)', text: String(e.message || '') })
			]);
		}));
	}

	function reportNode(rep) {
		var P = pools(), kids = [];
		function part(title, file, r, body) {
			var errs = Array.isArray(r.errors) ? r.errors : [];
			var block = [h('p', { class: 'subh' }, [title + (file ? ' · ' + file : '') + ' ', h('span', { class: 'tag ' + (r.ok ? 'good' : 'crit'), text: r.ok ? 'Valid' : errs.length + (errs.length === 1 ? ' problem' : ' problems') })])];
			block.push(body);
			if (errs.length) { block.push(errorList(errs)); }
			return h('div', { class: 'cx-grid' }, block);
		}
		if (rep.ship) {
			var st = parseInt(rep.ship.total, 10) || 0;
			kids.push(part('Ship file', rep.names.ship, rep.ship, h('dl', { class: 'cx-read' }, [
				h('dt', { class: 'tot', text: 'Ship points' }), h('dd', { class: 'tot ' + (st === P.ship ? 'good' : 'bad'), text: st + ' / ' + P.ship })
			])));
		}
		if (rep.crew) {
			var per = rep.crew.per_officer || {}, ct = parseInt(rep.crew.total, 10) || 0, dl = h('dl', { class: 'cx-read' });
			roleKeys().forEach(function (r) {
				dl.appendChild(h('dt', { text: roles()[r].label }));
				dl.appendChild(h('dd', { text: String(parseInt(per[r], 10) || 0) }));
			});
			dl.appendChild(h('dt', { class: 'tot', text: 'Crew points' }));
			dl.appendChild(h('dd', { class: 'tot ' + (ct === P.crew ? 'good' : 'bad'), text: ct + ' / ' + P.crew }));
			kids.push(part('Crew file', rep.names.crew, rep.crew, dl));
		}
		(rep.names.empty || []).forEach(function (n) { kids.push(h('p', { class: 'err', text: 'The file "' + n + '" is empty, so it was not read.' })); });
		var allOk = (!rep.ship || rep.ship.ok) && (!rep.crew || rep.crew.ok);
		var sec = panel(allOk ? '--c3' : '--c5', 'CSV check', 'Points spent per officer', [
			h('p', { class: 'cx-lead', text: allOk
				? 'The upload is valid and has been loaded into the editor. It is not saved yet: check it over and press Save.'
				: 'The upload has problems. What could be read has been loaded into the editor below so you can fix it here, or correct the file and upload it again. Nothing has been saved.' }),
			h('div', { class: 'cx-cols' }, kids),
			h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn small off', text: 'Hide this check', onclick: function () { S.report = null; drawSlots(); var b = R.menuBtn.upload; if (b) { b.focus(); } } }))
		]);
		R.reportHead = sec.cxHead;
		return sec;
	}

	/* ------------------------------------------------------------------ downloads */

	function saveFile(name, text, base64) {
		var data = text, type = 'text/csv;charset=utf-8';
		if (base64) {
			var bin = atob(base64);
			data = new Uint8Array(bin.length);
			for (var i = 0; i < bin.length; i++) { data[i] = bin.charCodeAt(i); }
			type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
		}
		var blob = new Blob([data], { type: type });
		var url = URL.createObjectURL(blob);
		var a = h('a', { href: url, download: name, style: 'display:none' });
		document.body.appendChild(a);
		a.click();
		setTimeout(function () { if (a.parentNode) { a.parentNode.removeChild(a); } URL.revokeObjectURL(url); }, 4000);
	}
	function offer(files, note) {
		S.downloads = { files: files, note: note };
		drawDownloads();
		files.forEach(function (f, i) { setTimeout(function () { saveFile(f.name, f.text, f.base64); }, i * 450); });
	}
	function drawDownloads() {
		if (!R.dl) { return; }
		clear(R.dl);
		var d = S.downloads;
		if (!d) { return; }
		R.dl.appendChild(panel('--c4', 'Downloads', d.files.length + ' files', [
			h('p', { class: 'cx-lead', role: 'status', text: d.note + ' If your browser only kept one of them, use the buttons to fetch each file on its own.' }),
			h('div', { class: 'btns' }, d.files.map(function (f) {
				return h('button', { type: 'button', class: 'btn small', text: f.name, 'aria-label': 'Download ' + f.name, onclick: function () { saveFile(f.name, f.text, f.base64); } });
			}).concat([h('button', { type: 'button', class: 'btn small off', text: 'Hide', onclick: function () { S.downloads = null; drawDownloads(); } })]))
		]));
	}
	function downloadBuild(id) {
		if (!id) { return; }
		notify('msg', 'Preparing the CSV files.');
		call('GET', '/creator/export/' + encodeURIComponent(id)).then(function (res) {
			var base = slug(res.name);
			notify('msg', '');
			offer([{ name: base + '-ship.csv', text: String(res.ship_csv || '') }, { name: base + '-crew.csv', text: String(res.crew_csv || '') }],
				'Two files were sent to your downloads for ' + (res.name || 'this ship') + ': the ship and the crew' + (S.view === 'editor' && S.dirty ? ', as last saved' : '') + '.');
		}).catch(function (err) { fail(err, 'The CSV files could not be prepared.'); });
	}
	function downloadTemplates() {
		notify('msg', 'Preparing the templates.');
		call('GET', '/creator/templates').then(function (res) {
			notify('msg', '');
			if (res.ship_xlsx && res.crew_xlsx) {
				offer([{ name: 'ship-template.xlsx', base64: res.ship_xlsx }, { name: 'crew-template.xlsx', base64: res.crew_xlsx }],
					'Two blank spreadsheets were sent to your downloads: one for the ship and one for the crew. In the crew sheet, species, gender and Human bonus points are picked from lists, and each officer\'s own four attributes are pre-filled with 0. Fill them in, then upload them here as they are.');
				return;
			}
			offer([{ name: 'ship-template.csv', text: String(res.ship_csv || '') }, { name: 'crew-template.csv', text: String(res.crew_csv || '') }],
				'Two blank templates were sent to your downloads: one for the ship and one for the crew, with each officer\'s own four attributes pre-filled with 0.');
		}).catch(function (err) { fail(err, 'The templates could not be prepared.'); });
	}

	/* ------------------------------------------------------------------ start */

	window.addEventListener('beforeunload', function (ev) {
		if (S.view === 'editor' && S.dirty) { ev.preventDefault(); ev.returnValue = ''; }
	});

	function loadRules() {
		return request('GET', '/rules').then(function (rules) {
			if (!rules || !rules.roles || !rules.pools || !rules.species || !rules.ship || !rules.attributes) {
				throw new Error('The game rules could not be read from the server.');
			}
			rules.genders = Array.isArray(rules.genders) && rules.genders.length ? rules.genders : ['Male', 'Female'];
			rules.voices = Array.isArray(rules.voices) ? rules.voices : [];
			S.rules = rules;
		});
	}

	function start() {
		clear(R.content);
		R.content.appendChild(h('p', { class: 'busy', role: 'status', text: 'Loading' }));
		S.view = 'loading';
		loadRules().then(function () { return openList(false); }).catch(function (err) { fatal(err.message, start); });
	}

	GD.Creator = {
		open: function (back) {
			GD.leaveScreen();
			onBack = back || null;
			root = GD.app();
			S.model = null; S.dirty = false; S.panel = null; S.report = null; S.downloads = null; S.notice = null;
			buildFrame();
			setMenu([]);
			start();
			window.scrollTo(0, 0);
		}
	};
})();
