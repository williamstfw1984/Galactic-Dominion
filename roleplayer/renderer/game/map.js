/*
 * Galactic Dominion — the 3D star chart (plugin brief §5.1, §5.2), in the HUD look.
 *
 * Plain script, no build step. Needs the global THREE (three.js r160 UMD core, no addons).
 * Public API:  window.GDMap.create(container, { onSelect(coord|null, detail) })
 *   -> { setMap, setState, select, focus, resize, destroy, getSelected }
 *
 * Grid coordinates are x = East, y = North, z = Upper (class-grid.php). They are drawn with
 * x to the right, z up and y into the screen: world = (x - h, z - h, -(y - h)), a pure rotation,
 * so distances and the reach sphere are exact. One grid unit is map.ly_per_unit light-years.
 *
 * Everything is drawn in seven draw calls (background stars, nebulae, frame, reach sphere,
 * sectors, lines, markers) using instanced quads and custom shaders, so a 20-cube with ~2,600
 * sectors costs the same number of calls as an 8-cube. Glow is additive blending, not
 * post-processing. Text labels are DOM elements so they stay sharp and use the HUD typeface.
 */
(function () {
	'use strict';

	// The palette, read from the HUD's tokens in hud.css (key: [custom property, fallback]).
	// c1 your ship and reach, c2 other captains, c3 scanned sectors, c4 selection, frame the chart's grid, lead leads and open missions.
	var TOKENS = { c1: ['map-own', '#36E2FF'], c2: ['map-other', '#FFB547'], c3: ['map-scan', '#8FA6CC'], c4: ['map-sel', '#B5F7FF'], frame: ['c1', '#36E2FF'], lead: ['map-lead', '#A98BFF'],
		text: ['map-visit', '#F4F8FF'], dim: ['map-dim', '#3C5378'], good: ['map-good', '#4DFFC3'], warn: ['map-warn', '#FFD58F'], crit: ['map-crit', '#FF4D8D'] };
	// Faction territories glow in these, one per known faction.
	var FAC_COLS = ['#36E2FF', '#A98BFF', '#FFB547', '#FF4D8D', '#4DFFC3', '#5F8BFF'];
	var STAR = { O: ['#86aaff', 1.5], B: ['#a3c0ff', 1.36], A: ['#cfdcff', 1.22], F: ['#fbf6ff', 1.08], G: ['#ffeec9', 1.0], K: ['#ffc37a', 0.92], M: ['#ff8f5c', 0.84] };
	var TYPE = { star_system: 0, nebula: 1, anomaly: 2, station: 3 };
	var HAZ = { ion_storm: 1, radiation: 2, gravitational_shear: 3, subspace_rift: 4, asteroid_field: 5, pulsar: 6 };
	var STATUS = ['Unvisited', 'Scanned', 'Visited'];
	var NEB_PAL = [
		['#c46bff', '#5f6dff'], ['#ff5fa8', '#9a5cff'], ['#38cfd0', '#4a7dff'],
		['#ff9a4a', '#ff4f7b'], ['#6a8cff', '#c08cff'], ['#3fd9a4', '#3aa8ff']
	];
	var TAU = Math.PI * 2;
	var STYLE_ID = 'gd-map-style';

	/* ------------------------------------------------------------------ helpers */

	function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
	function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
	function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
	function pad(n) { return (n < 10 ? '0' : '') + n; }
	function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
	function words(s) { return String(s == null ? '' : s).replace(/_/g, ' '); }
	function mulberry(a) {
		return function () {
			a |= 0; a = a + 0x6D2B79F5 | 0;
			var t = Math.imul(a ^ a >>> 15, 1 | a);
			t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
			return ((t ^ t >>> 14) >>> 0) / 4294967296;
		};
	}
	function cellSeed(x, y, z) { return (Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ Math.imul(z + 1, 83492791)) >>> 0; }
	function strSeed(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 16777619); } return h >>> 0; }
	function parseCoord(s) {
		if (typeof s !== 'string') { return null; }
		var m = s.split(',');
		if (m.length !== 3) { return null; }
		var x = parseInt(m[0], 10), y = parseInt(m[1], 10), z = parseInt(m[2], 10);
		if (isNaN(x) || isNaN(y) || isNaN(z)) { return null; }
		return [x, y, z];
	}
	function designation(p) { return 'Sector ' + pad(p[0]) + '-' + pad(p[1]) + '-' + pad(p[2]); }
	function rgb(str, fallback) {
		var s = String(str || '').trim(), m;
		if ((m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s))) { return [parseInt(m[1] + m[1], 16) / 255, parseInt(m[2] + m[2], 16) / 255, parseInt(m[3] + m[3], 16) / 255]; }
		if ((m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(s))) { return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]; }
		if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s))) { return [m[1] / 255, m[2] / 255, m[3] / 255]; }
		return fallback ? rgb(fallback) : [1, 1, 1];
	}
	function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
	function media(q) { try { return window.matchMedia ? window.matchMedia(q) : null; } catch (e) { return null; } }

	function injectStyle() {
		if (document.getElementById(STYLE_ID)) { return; }
		var f = 'Rajdhani,"Segoe UI",sans-serif';
		// Labels and controls in the HUD look: Rajdhani capitals with a dark halo, cut-corner glass buttons.
		var css =
			'.gdm-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab;outline:none;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}' +
			'.gdm-canvas.gdm-grabbing{cursor:grabbing}.gdm-canvas.gdm-hot{cursor:pointer}' +
			'.gdm-canvas:focus-visible{box-shadow:inset 0 0 0 2px var(--c1,#36E2FF)}' +
			'.gdm-labels{position:absolute;left:0;top:0;right:0;bottom:0;overflow:hidden;pointer-events:none;contain:strict;z-index:2}' +
			'.gdm-l{position:absolute;left:0;top:0;white-space:nowrap;font:600 12px/1.2 ' + f + ';letter-spacing:.11em;text-transform:uppercase;color:var(--soft,#C9D6F0);' +
			'text-shadow:0 0 6px #000,0 0 3px #000,0 1px 2px #000;will-change:transform,opacity}' +
			'.gdm-l i{display:block;font-style:normal;font-weight:500;font-size:11px;opacity:.9;letter-spacing:.06em}' +
			'.gdm-l.own{font-size:13px;font-weight:700;color:var(--c1-3,#B5F7FF);text-shadow:0 0 10px rgba(54,226,255,.8),0 0 3px #000}' +
			'.gdm-l.cap{color:var(--you-2,#FFD58F)}.gdm-l.away{color:var(--you-2,#FFD58F);opacity:.6}' +
			'.gdm-l.sel{color:var(--bright,#F4F8FF)}.gdm-l.hov{color:var(--c1-3,#B5F7FF);font-weight:500}' +
			'.gdm-l.place{color:var(--text,#DDE8FF);font-weight:500}' +
			'.gdm-l.sec{color:var(--dim,#8FA6CC);font-weight:500;font-size:11px}' +
			'.gdm-l.fac{font:700 13px ' + f + ';letter-spacing:.5em;opacity:.9}' +
			'.gdm-l.m-lead{color:var(--vio-3,#D9CCFF)}.gdm-l.m-crit{color:var(--crit-2,#FF8FB4)}.gdm-l.m-own{color:var(--c1-2,#8DF3FF)}.gdm-l.m-oth{color:var(--you-2,#FFD58F)}.gdm-l.m-warn{color:var(--warn,#FFD58F)}' +
			'button.gdm-edge.gdm-edge{position:absolute;left:0;top:0;display:none;align-items:center;gap:6px;pointer-events:auto;cursor:pointer;margin:0;padding:5px 12px 5px 8px;z-index:4;' +
			'background:rgba(6,14,30,.92);color:var(--c1-3,#B5F7FF);border:1px solid var(--c1,#36E2FF);box-shadow:0 0 14px rgba(54,226,255,.45);font:700 12px/1 ' + f + ';letter-spacing:.12em;text-transform:uppercase;white-space:nowrap;max-width:60%;overflow:hidden;text-overflow:ellipsis}' +
			'.gdm-edge svg{flex:none;width:12px;height:12px}' +
			'.gdm-ctl{position:absolute;right:12px;bottom:12px;display:flex;gap:6px;pointer-events:none;z-index:4}' +
			'button.gdm-btn.gdm-btn{pointer-events:auto;cursor:pointer;margin:0;padding:0 16px;min-height:34px;color:var(--c1-ink,#BFF6FF);background:rgba(6,14,30,.85);border:1px solid rgba(54,226,255,.45);' +
			'clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);font:700 12px/1 ' + f + ';letter-spacing:.16em;text-transform:uppercase}' +
			'button.gdm-btn.gdm-me{border-color:var(--c1,#36E2FF);box-shadow:inset 0 0 12px rgba(54,226,255,.25)}' +
			'.gdm-btn:hover,.gdm-edge:hover{background:rgba(54,226,255,.2);color:#fff}.gdm-btn:focus-visible,.gdm-edge:focus-visible{outline:2px solid var(--c1-3,#B5F7FF);outline-offset:2px}' +
			'.gdm-msg{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:64px 22px 22px;pointer-events:none;z-index:3;' +
			'font:600 14px/1.45 ' + f + ';letter-spacing:.12em;text-transform:uppercase;color:var(--soft,#C9D6F0)}' +
			'.gdm-msg b{display:block;font:700 16px Orbitron,sans-serif;letter-spacing:.18em;color:var(--c1-2,#8DF3FF);margin-bottom:8px}' +
			'.gdm-msg.gdm-lost{background:rgba(2,4,10,.78)}';
		var el = document.createElement('style');
		el.id = STYLE_ID;
		el.textContent = css;
		(document.head || document.documentElement).appendChild(el);
	}

	/* ------------------------------------------------------------------ shaders */

	var SECTOR_VS = [
		'attribute vec3 iPos; attribute vec4 iA; attribute vec3 iCol; attribute float iSize;',
		'uniform float uScale, uPx, uCamDist, uReach; uniform vec3 uOwn;',
		'varying vec2 vUv; varying vec4 vA; varying vec3 vCol; varying vec3 vP;',
		'void main(){',
		'  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);',
		'  float d = max(0.001, -mv.z);',
		'  float st = iA.x;',
		'  float inReach = (uReach > 0.0 && distance(iPos, uOwn) <= uReach + 0.001) ? 1.0 : 0.0;',
		'  float world = iSize * (st > 1.5 ? 1.0 : st > 0.5 ? 0.56 : 0.15);',
		'  // Smallest drawn size follows how tightly the grid is packed on screen, so a 20-cube on a phone stays readable.',
		'  float ppu = uScale / d / uPx;',
		'  float minPx = (st > 1.5 ? clamp(ppu * 0.3, 4.5, 8.0) : st > 0.5 ? clamp(ppu * 0.2, 2.8, 5.0) : clamp(ppu * 0.095, 1.25, 2.7)) * uPx;',
		'  if (iA.z > 0.5 && st > 0.5) { minPx = max(minPx, clamp(ppu * 0.28, 4.5, 7.0) * uPx); }',
		'  float dense = st > 0.5 ? 1.0 : clamp(ppu / 26.0, 0.5, 1.0);',
		'  float px = clamp(world * uScale / d, minPx, 240.0 * uPx);',
		'  mv.xy += position.xy * px * d / uScale;',
		'  gl_Position = projectionMatrix * mv;',
		'  vUv = position.xy; vA = iA; vCol = iCol;',
		'  vP = vec3(px, clamp(1.75 - 0.78 * d / uCamDist, 0.3, 1.25) * dense, inReach);',
		'}'
	].join('\n');

	var SECTOR_FS = [
		'uniform vec3 uDim, uScan, uVisit, uWarn, uReachCol; uniform float uTime, uTw;',
		'varying vec2 vUv; varying vec4 vA; varying vec3 vCol; varying vec3 vP;',
		'float ringf(float r, float r0, float w, float aa){ return 1.0 - smoothstep(w, w + aa, abs(r - r0)); }',
		'void main(){',
		'  float r = length(vUv); if (r > 1.0) discard;',
		'  float aa = 1.6 / vP.x; float st = vA.x; float ty = vA.y; float hz = vA.z; float seed = vA.w;',
		'  float fall = 1.0 - r; float ang = atan(vUv.y, vUv.x); float thin = max(0.008, 0.6 / vP.x);',
		'  vec3 col = vec3(0.0);',
		'  if (st < 0.5) {',
		'    col = mix(uDim, uReachCol, vP.z * 0.55) * ringf(r, 0.62, max(0.028, 0.62 / vP.x), aa) * (0.42 + 0.3 * vP.z);',
		'  } else {',
		'    float vis = step(1.5, st);',
		'    vec3 sc = mix(uScan, uVisit, vis);',
		'    if (ty < 0.5) {',
		'      float tw = 1.0 + uTw * 0.2 * sin(uTime * (1.3 + seed * 2.6) + seed * 40.0);',
		'      float cw = max(mix(0.2, 0.085, vis), 1.3 / vP.x);',
		'      float core = exp(-r * r / (cw * cw));',
		'      float glow = exp(-r * r * 14.0) * fall;',
		'      float spike = (exp(-abs(vUv.x) * vP.x * 0.7) + exp(-abs(vUv.y) * vP.x * 0.7)) * fall * fall * fall;',
		'      vec3 visited = sc * core * 1.25 + vCol * (glow * 0.8 * tw + pow(fall, 2.5) * 0.22 + spike * 0.5 * tw);',
		'      vec3 scanned = sc * core * 0.95 + mix(uScan, vCol, 0.25) * pow(fall, 2.5) * 0.3;',
		'      col = mix(scanned, visited, vis);',
		'    } else if (ty < 1.5) {',
		'      float cr = max(0.3, 1.3 / vP.x);',
		'      col = sc * exp(-r * r / (cr * cr)) * 0.8;',
		'    } else if (ty < 2.5) {',
		'      float sw = 0.5 + 0.5 * sin(ang * 2.0 + r * 9.0 - uTime * 1.5 + seed * 6.0);',
		'      float disk = smoothstep(1.0, 0.25, r) * smoothstep(0.12, 0.22, r);',
		'      vec3 ac = mix(vec3(0.62, 0.36, 1.0), vec3(0.2, 0.88, 0.95), sw);',
		'      col = ac * disk * (0.25 + 0.75 * sw) * mix(0.6, 1.0, vis) + sc * ringf(r, 0.17, max(0.02, 0.7 / vP.x), aa);',
		'    } else {',
		'      float bx = max(abs(vUv.x), abs(vUv.y));',
		'      float sq = ringf(bx, 0.46, max(0.02, 0.3 / vP.x), aa * 0.7);',
		'      float dotc = 1.0 - smoothstep(0.12 - aa, 0.12 + aa, r);',
		'      float tick = ringf(min(abs(vUv.x), abs(vUv.y)), 0.0, max(0.022, 0.5 / vP.x), aa) * step(0.5, bx) * step(bx, 0.8);',
		'      col = sc * (sq + dotc + tick * 0.8) * mix(0.8, 1.0, vis) + sc * pow(fall, 3.0) * 0.25;',
		'    }',
		'    if (hz > 0.5) {',
		'      float h = 0.0; vec3 hc = uWarn;',
		'      if (hz < 1.5) {',
		'        float n = sin(ang * 7.0 + uTime * 9.0 + seed * 10.0) * sin(ang * 3.0 - uTime * 5.0);',
		'        h = ringf(r, 0.6 + 0.05 * n, thin, aa) * (0.45 + 0.55 * sin(uTime * 13.0 + ang * 5.0 + seed * 9.0));',
		'      } else if (hz < 2.5) {',
		'        float f = fract(uTime * 0.45 + seed);',
		'        h = ringf(r, 0.2 + 0.55 * f, thin, aa) * (1.0 - f);',
		'      } else if (hz < 3.5) {',
		'        h = ringf(r, 0.62, thin, aa) * smoothstep(0.25, 0.85, abs(sin(ang + uTime * 0.8 + seed)));',
		'      } else if (hz < 4.5) {',
		'        float x = vUv.x + 0.07 * sin(vUv.y * 13.0 + uTime * 6.0) + 0.04 * sin(vUv.y * 31.0 - uTime * 9.0);',
		'        h = (1.0 - smoothstep(0.0, max(0.05, 1.2 / vP.x), abs(x))) * smoothstep(0.92, 0.4, abs(vUv.y)) * (0.65 + 0.35 * sin(uTime * 8.0 + seed * 5.0));',
		'        hc = vec3(1.0, 0.45, 0.75);',
		'      } else if (hz < 5.5) {',
		'        h = ringf(r, 0.6, max(0.012, 0.7 / vP.x), aa) * smoothstep(0.1, 0.5, sin(ang * 12.0 + uTime * 0.35 + seed * 6.0));',
		'      } else {',
		'        float b = pow(abs(cos(ang - uTime * 2.4 - seed * 6.0)), 70.0);',
		'        h = b * fall * 1.5 + ringf(r, 0.3, thin, aa) * 0.5; hc = vec3(0.7, 0.86, 1.0);',
		'      }',
		'      col += hc * h * 0.62;',
		'    }',
		'  }',
		'  gl_FragColor = vec4(col * vP.y, 1.0);',
		'}'
	].join('\n');

	var NEB_VS = [
		'attribute vec3 iPos; attribute vec4 iN; attribute vec3 iCol; attribute float iFollow;',
		'uniform float uTime, uSpin;',
		'varying vec2 vUv; varying vec3 vCol; varying float vTile;',
		'void main(){',
		'  vec4 mv = viewMatrix * vec4(iPos + cameraPosition * iFollow, 1.0);',
		'  float rot = iN.y + uTime * uSpin * 0.03 * (fract(iN.y * 7.31) - 0.5);',
		'  float c = cos(rot), s = sin(rot);',
		'  mv.xy += vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iN.x;',
		'  gl_Position = projectionMatrix * mv;',
		'  float d = -mv.z;',
		'  vCol = iCol * iN.w * smoothstep(iN.x * 0.3, iN.x * 1.7, d);',
		'  vUv = position.xy * 0.5 + 0.5; vTile = iN.z;',
		'}'
	].join('\n');

	var NEB_FS = [
		'uniform sampler2D uTex;',
		'varying vec2 vUv; varying vec3 vCol; varying float vTile;',
		'void main(){',
		'  float a;',
		'  if (vTile < -0.5) { float f = max(0.0, 1.0 - length(vUv * 2.0 - 1.0)); a = f * f; }',
		'  else { a = texture2D(uTex, (vUv + vec2(mod(vTile, 2.0), floor(vTile * 0.5))) * 0.5).r; }',
		'  gl_FragColor = vec4(vCol * a, 1.0);',
		'}'
	].join('\n');

	var BG_VS = [
		'attribute vec3 aCol; attribute vec2 aP;',
		'uniform float uPx, uTime, uTw;',
		'varying vec3 vCol;',
		'void main(){',
		'  vec4 mv = viewMatrix * vec4(position + cameraPosition * aP.y, 1.0);',
		'  gl_Position = projectionMatrix * mv;',
		'  gl_PointSize = aP.x * uPx;',
		'  vCol = aCol * (1.0 + uTw * 0.3 * sin(uTime * (0.6 + fract(aP.x * 13.7) * 1.8) + aP.x * 50.0));',
		'}'
	].join('\n');

	var BG_FS = [
		'varying vec3 vCol;',
		'void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; gl_FragColor = vec4(vCol * (1.0 - smoothstep(0.15, 1.0, r)), 1.0); }'
	].join('\n');

	var FRAME_VS = 'attribute vec3 aCol; varying vec3 vCol; void main(){ vCol = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
	var FRAME_FS = 'varying vec3 vCol; void main(){ gl_FragColor = vec4(vCol, 1.0); }';

	var SPH_VS = [
		'varying vec3 vN; varying vec3 vV; varying vec3 vO;',
		'void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalMatrix * normal; vV = -mv.xyz; vO = position; gl_Position = projectionMatrix * mv; }'
	].join('\n');

	var SPH_FS = [
		'uniform vec3 uCol; uniform float uTime, uAlpha, uGrid;',
		'varying vec3 vN; varying vec3 vV; varying vec3 vO;',
		'void main(){',
		'  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));',
		'  float a = 0.018 + pow(f, 3.0) * 0.26 + pow(f, 12.0) * 0.4;',
		'  if (uGrid > 0.5) {',
		'    float y = clamp(vO.y, -1.0, 1.0);',
		'    float lat = asin(y) / 0.3926991; float lon = atan(vO.z, vO.x) / 0.3926991;',
		'    float gl = abs(fract(lat + 0.5) - 0.5) / max(fwidth(lat), 1e-4);',
		'    float wl = fwidth(lon);',
		'    float go = wl > 0.3 ? 1.0 : abs(fract(lon + 0.5) - 0.5) / max(wl, 1e-4);',
		'    float grid = (1.0 - min(min(gl, go), 1.0)) * smoothstep(0.9, 0.6, abs(y));',
		'    float eq = 1.0 - min(abs(lat) / max(fwidth(lat) * 1.4, 1e-4), 1.0);',
		'    float sweep = pow(max(0.0, 1.0 - abs(fract(y * 0.5 + 0.5 - uTime * 0.07) - 0.5) * 9.0), 2.0);',
		'    a += grid * 0.04 + eq * 0.2 + sweep * 0.03;',
		'  }',
		'  gl_FragColor = vec4(uCol * a * uAlpha, 1.0);',
		'}'
	].join('\n');

	var LINE_VS = [
		'attribute vec3 iA2; attribute vec3 iB2; attribute vec4 iCol; attribute vec4 iP;',
		'uniform vec2 uView;',
		'varying vec4 vCol; varying vec4 vL;',
		'void main(){',
		'  vec4 a = modelViewMatrix * vec4(iA2, 1.0); vec4 b = modelViewMatrix * vec4(iB2, 1.0);',
		'  float n = -0.05;',
		'  vCol = iCol; vL = vec4(0.0);',
		'  if (a.z > n && b.z > n) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }',
		'  float ta = 0.0, tb = 1.0;',
		'  if (a.z > n) { ta = (a.z - n) / (a.z - b.z); a = mix(a, b, ta); }',
		'  else if (b.z > n) { tb = (n - a.z) / (b.z - a.z); b = mix(a, b, tb); }',
		'  vec4 ca = projectionMatrix * a; vec4 cb = projectionMatrix * b;',
		'  vec2 sa = ca.xy / ca.w * uView * 0.5; vec2 sb = cb.xy / cb.w * uView * 0.5;',
		'  vec2 dir = sb - sa; float len = length(dir); dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);',
		'  float t = position.x * 0.5 + 0.5;',
		'  vec4 c = mix(ca, cb, t);',
		'  c.xy += vec2(-dir.y, dir.x) * position.y * iP.x * 2.0 / uView * c.w;',
		'  gl_Position = c;',
		'  vL = vec4(mix(ta, tb, t), position.y, len * t, iP.y);',
		'  vCol.a *= mix(iP.z, iP.w, vL.x);',
		'}'
	].join('\n');

	var LINE_FS = [
		'uniform float uTime;',
		'varying vec4 vCol; varying vec4 vL;',
		'void main(){',
		'  float e = 1.0 - abs(vL.y);',
		'  float a = smoothstep(0.0, 0.55, e) * 0.55 + smoothstep(0.55, 0.9, e) * 0.45;',
		'  if (vL.w > 0.5) { a *= smoothstep(0.4, 0.6, abs(fract(vL.z / vL.w - uTime * 1.6) - 0.5) * 2.0); }',
		'  gl_FragColor = vec4(vCol.rgb * vCol.a * a, 1.0);',
		'}'
	].join('\n');

	var MARK_VS = [
		'attribute vec3 iPos; attribute vec4 iB; attribute vec4 iCol; attribute vec2 iC;',
		'uniform vec2 uView; uniform float uScaleCss;',
		'varying vec2 vUv; varying vec4 vCol; varying vec3 vG;',
		'void main(){',
		'  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);',
		'  float d = max(0.001, -mv.z);',
		'  vec4 clip = projectionMatrix * mv;',
		'  float s = min(max(iB.z, iC.y * uScaleCss / d), 110.0);',
		'  clip.xy += (position.xy * s + iB.xy) * 2.0 / uView * clip.w;',
		'  gl_Position = clip;',
		'  vUv = position.xy; vCol = iCol; vG = vec3(iB.w, s, iC.x);',
		'}'
	].join('\n');

	var MARK_FS = [
		'uniform float uTime, uPx;',
		'varying vec2 vUv; varying vec4 vCol; varying vec3 vG;',
		'float tri(vec2 p){ return max(-p.y - 0.42, 0.898 * abs(p.x) + 0.440 * p.y - 0.264); }',
		'float dia(vec2 p, float s){ return (abs(p.x) + abs(p.y) - s) * 0.7071; }',
		'float box(vec2 p, vec2 b){ vec2 d = abs(p) - b; return max(d.x, d.y); }',
		'void main(){',
		'  vec2 p = vUv; float r = length(p); float g = vG.x; float aa = 1.1 / (vG.y * uPx); float t = uTime;',
		'  float a = 0.0; float bg = 0.0;',
		'  #define FILL(d) (1.0 - smoothstep(-aa, aa, (d)))',
		'  #define LINE(d, w) (1.0 - smoothstep((w) - aa, (w) + aa, abs(d)))',
		'  if (g < 0.5) {',
		'    vec2 q = p * 1.5; q.y += 0.06;',
		'    float d = max(tri(q), -((q.y + 0.14 + 0.75 * abs(q.x)) * 0.8)) / 1.5;',
		'    a = FILL(d); a = max(a, LINE(r - 0.6, 0.04));',
		'    float f = fract(t * 0.55); a = max(a, LINE(r - (0.6 + 0.38 * f), 0.03) * (1.0 - f) * 0.85);',
		'    bg = (1.0 - smoothstep(0.52, 0.62, r)) * 0.55;',
		'  } else if (g < 1.5) { a = FILL(tri(p * 1.12) / 1.12); bg = FILL(tri(p * 0.9) / 0.9) * 0.6; }',
		'  else if (g < 2.5) { a = max(FILL(tri(p * 1.75) / 1.75), LINE(r - 0.82, 0.07)); bg = (1.0 - smoothstep(0.72, 0.86, r)) * 0.55; }',
		'  else if (g < 3.5) { a = LINE(tri(p * 1.12) / 1.12 + 0.07, 0.07); }',
		'  else if (g < 4.5) { float d = dia(p, 0.8); a = max(LINE(d, 0.055), FILL(dia(p, 0.34))) * (0.82 + 0.18 * sin(t * 3.0 + vG.z)); bg = FILL(d) * 0.6; }',
		'  else if (g < 5.5) {',
		'    float d = dia(p, 0.88); a = LINE(d, 0.07); bg = FILL(d) * 0.8;',
		'    float body = box(p - vec2(0.0, -0.13), vec2(0.2, 0.15));',
		'    float sh = max(abs(length(p - vec2(0.0, 0.04)) - 0.15) - 0.045, -(p.y - 0.02));',
		'    a = max(a, max(FILL(body), FILL(sh)));',
		'    float f = fract(t * 0.4 + vG.z); a = max(a, LINE(dia(p, 0.88 + 0.12 * f), 0.03) * (1.0 - f) * 0.6);',
		'  } else if (g < 6.5) { float d = dia(p, 0.5); a = FILL(d); float f = fract(t * 0.7 + vG.z); a = max(a, LINE(dia(p, 0.5 + 0.46 * f), 0.045) * (1.0 - f)); bg = FILL(dia(p, 0.62)) * 0.6; }',
		'  else if (g < 7.5) { a = LINE(dia(p, 0.72), 0.07); bg = FILL(dia(p, 0.72)) * 0.5; }',
		'  else if (g < 8.5) { vec2 q = p * (1.0 + 0.05 * sin(t * 2.4)); a = LINE(box(q, vec2(0.8)), max(0.03, 0.9 / vG.y)) * step(0.4, abs(q.x)) * step(0.4, abs(q.y)); }',
		'  else if (g < 9.5) { a = 1.0 - smoothstep(0.45, 1.0, r); }',
		'  else if (g < 10.5) { a = LINE(r - 0.8, max(0.03, 0.7 / vG.y)) * 0.8; }',
		'  else { a = LINE(r - 0.92 * vG.z, 0.05) * (1.0 - vG.z); }',
		'  float al = a * vCol.a; float ba = bg * vCol.a * (1.0 - a);',
		'  gl_FragColor = vec4(vCol.rgb * al, al + ba);',
		'}'
	].join('\n');

	var QUAD = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
	var QUAD_IDX = [0, 1, 2, 0, 2, 3];

	/** A growable set of instanced quads sharing one material: one draw call. */
	function Layer(T, spec, material, order) {
		this.T = T; this.spec = spec; this.cap = 0; this.count = 0; this.arr = {};
		this.mesh = new T.Mesh(new T.BufferGeometry(), material);
		this.mesh.frustumCulled = false; this.mesh.renderOrder = order; this.mesh.visible = false;
		this.alloc(16);
	}
	Layer.prototype.alloc = function (n) {
		var T = this.T, old = this.mesh.geometry, g = new T.InstancedBufferGeometry(), k;
		g.setAttribute('position', new T.BufferAttribute(QUAD, 3));
		g.setIndex(QUAD_IDX);
		for (k in this.spec) {
			this.arr[k] = new Float32Array(n * this.spec[k]);
			var a = new T.InstancedBufferAttribute(this.arr[k], this.spec[k]);
			a.setUsage(T.DynamicDrawUsage);
			g.setAttribute(k, a);
		}
		g.instanceCount = 0;
		this.mesh.geometry = g;
		if (old) { old.dispose(); }
		this.cap = n;
	};
	Layer.prototype.fill = function (recs) {
		var n = recs.length, k, i;
		if (n > this.cap) { this.alloc(Math.ceil(n * 1.4) + 8); }
		for (k in this.spec) {
			var arr = this.arr[k], size = this.spec[k];
			for (i = 0; i < n; i++) { arr.set(recs[i][k], i * size); }
			this.mesh.geometry.attributes[k].needsUpdate = true;
		}
		this.mesh.geometry.instanceCount = n;
		this.count = n;
		this.mesh.visible = n > 0;
	};
	Layer.prototype.dispose = function () { this.mesh.geometry.dispose(); this.mesh.material.dispose(); };

	/**
	 * Cloud sprites for the nebulae: a 2x2 atlas of domain-distorted value noise, each tile fading to
	 * exactly zero at its rim so the billboards never show an edge.
	 */
	function makePuffs(tile) {
		var c = document.createElement('canvas');
		c.width = c.height = tile * 2;
		var g = c.getContext('2d'), img = g.createImageData(tile * 2, tile * 2), data = img.data;
		var perm = new Float32Array(4096), rnd = mulberry(977), i, t, x, y;
		for (i = 0; i < 4096; i++) { perm[i] = rnd(); }
		function lat(ix, iy) { return perm[((ix * 73) ^ (iy * 151) ^ ((ix * iy) * 7)) & 4095]; }
		function noise(px, py) {
			var ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
			fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
			var a = lat(ix, iy), b = lat(ix + 1, iy), cc = lat(ix, iy + 1), d = lat(ix + 1, iy + 1);
			return a + (b - a) * fx + (cc - a) * fy + (a - b - cc + d) * fx * fy;
		}
		function fbm(px, py, oct) {
			var v = 0, amp = 0.5, k;
			for (k = 0; k < oct; k++) { v += amp * noise(px, py); px = px * 2.03 + 17.1; py = py * 2.03 + 9.7; amp *= 0.5; }
			return v;
		}
		for (t = 0; t < 4; t++) {
			var ox = (t % 2) * tile, oy = (t >> 1) * tile, sx = 40 + t * 31.7, sy = 12 + t * 57.3;
			for (y = 0; y < tile; y++) {
				for (x = 0; x < tile; x++) {
					var u = (x + 0.5) / tile * 2 - 1, v = (y + 0.5) / tile * 2 - 1, r = Math.sqrt(u * u + v * v), val = 0;
					if (r < 1) {
						var qx = fbm(u * 1.5 + sx, v * 1.5 + sy, 3), qy = fbm(u * 1.5 + sx + 5.2, v * 1.5 + sy + 1.3, 3);
						var n = fbm(u * 2.1 + sx + 2.4 * qx, v * 2.1 + sy + 2.4 * qy, 5);
						var fall = 1 - smooth(0.12, 1, r);
						val = Math.pow(fall, 1.25) * (0.16 + 0.84 * smooth(0.3, 0.72, n));
					}
					var o = ((oy + y) * tile * 2 + ox + x) * 4, b8 = Math.round(clamp(val, 0, 1) * 255);
					data[o] = data[o + 1] = data[o + 2] = b8; data[o + 3] = 255;
				}
			}
		}
		g.putImageData(img, 0, 0);
		return c;
	}

	/* ------------------------------------------------------------------ create */

	function create(container, opts) {
		opts = opts || {};
		var T = window.THREE;
		var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
		injectStyle();

		/* ----- DOM ----- */
		var made = [];
		function el(tag, cls, parent) { var e = document.createElement(tag); if (cls) { e.className = cls; } (parent || container).appendChild(e); made.push(e); return e; }
		try { if (window.getComputedStyle(container).position === 'static') { container.style.position = 'relative'; } } catch (e) { /* detached */ }
		var canvas = el('canvas', 'gdm-canvas');
		canvas.setAttribute('tabindex', '0');
		canvas.setAttribute('role', 'application');
		canvas.setAttribute('aria-label', '3D sector map. Drag to orbit, shift-drag or two fingers to pan, scroll or pinch to zoom, tap a sector for details. Arrow keys orbit, plus and minus zoom, shift with arrow keys or page up and down step the selected sector.');
		var labelBox = el('div', 'gdm-labels');
		var info = container.querySelector('.gd-secinfo');
		var ownInfo = !info;
		if (!info) { info = el('div', 'gd-secinfo'); } else { container.appendChild(info); }
		info.setAttribute('aria-live', 'polite');
		var edge = el('button', 'gdm-edge');
		edge.type = 'button';
		edge.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0l5 11-5-3-5 3z" fill="#000"/></svg><span></span>';
		var ctl = el('div', 'gdm-ctl');
		var btnMe = el('button', 'gdm-btn gdm-me', ctl); btnMe.type = 'button'; btnMe.textContent = 'My ship'; btnMe.title = 'Centre the map on your ship';
		var btnAll = el('button', 'gdm-btn', ctl); btnAll.type = 'button'; btnAll.textContent = 'Overview'; btnAll.title = 'Show the whole map';
		var msg = null;

		/* ----- state ----- */
		var css = {};
		var N = 12, half = 5.5, lyU = 5, haveMap = false;
		var sectors = new Map(), sectorList = [], factions = {};
		var st = { position: null, pos: null, range: 0, me: {}, captains: [], missions: [] };
		var moves = {}; // other captains in transit: id -> { from, to, t, dur } in world space
		var selected = null, hover = null, lastDetailJson = '[null,null]';
		var W = 0, H = 0, dpr = 1;
		var destroyed = false, lost = false, visible = true, raf = 0, lastT = 0, time = 0, frameNo = 0, dirty = true;
		var mqReduce = media('(prefers-reduced-motion: reduce)');
		var reduced = !!(mqReduce && mqReduce.matches);
		var quality = 'high', frameEma = 16, cpuEma = 0, slowFor = 0, startedAt = 0, degraded = 0;
		var listeners = [];
		function on(target, type, fn, o) { target.addEventListener(type, fn, o); listeners.push([target, type, fn, o]); }

		function readColours() {
			var cs = null;
			try { cs = window.getComputedStyle(document.documentElement); } catch (e) { cs = null; }
			Object.keys(TOKENS).forEach(function (k) { css[k] = rgb(cs ? cs.getPropertyValue('--' + TOKENS[k][0]) : '', TOKENS[k][1]); });
		}
		readColours();

		function inBounds(p) { return p && p[0] >= 0 && p[1] >= 0 && p[2] >= 0 && p[0] < N && p[1] < N && p[2] < N; }
		function wx(p) { return p[0] - half; }
		function wy(p) { return p[2] - half; }
		function wz(p) { return -(p[1] - half); }
		function world(p) { return [wx(p), wy(p), wz(p)]; }
		function distLy(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * lyU; }
		function fmtLy(v) { return (Math.round(v * 10) / 10).toString(); }

		/* ----- detail + overlay (works with or without WebGL) ----- */
		function sectorName(p, s) { return (s && s.p) || (s && s.d && s.d.name) || designation(p); }

		function detailFor(coord) {
			var p = parseCoord(coord);
			if (!p || (haveMap && !inBounds(p))) { return null; }
			var s = sectors.get(coord) || null, known = !!(s && s.s > 0), d = (known && s.d) || {};
			var dist = st.pos ? distLy(p, st.pos) : null;
			var caps = st.captains.filter(function (c) { return c && c.position === coord; }).map(function (c) {
				return { id: c.id, name: c.name || '', ship: c.ship || '', me: !!c.me, in_fleet: !!c.in_fleet, connected: c.connected !== false };
			});
			if (st.position === coord && !caps.some(function (c) { return c.me; })) {
				caps.unshift({ id: null, name: (st.me && st.me.name) || '', ship: (st.me && st.me.ship) || 'Your ship', me: true, in_fleet: false, connected: true });
			}
			var missions = st.missions.filter(function (m) { return m && m.sector === coord; }).map(function (m) {
				return { title: m.title || 'Mission', critical: !!m.critical, locked: m.locked || '', status: m.status || 'available', mine: !!m.mine };
			});
			var out = {
				coord: coord, x: p[0], y: p[1], z: p[2],
				designation: designation(p), name: sectorName(p, s), place: (s && s.p) || null,
				empty: !s, status: s ? s.s : null, status_label: s ? STATUS[s.s] || 'Unvisited' : 'Open space', known: known,
				type: known ? s.t : null, star_class: known ? (s.k || null) : null,
				planets: known && d.planets != null ? d.planets : null, habitability: known ? (d.habitability || null) : null,
				resources: known && d.resources ? d.resources.slice() : [], hazard: known ? (d.hazard || null) : null,
				notable: known ? (d.notable || null) : null, note: known ? (d.note || '') : '', scan: known ? (d.scan || '') : '',
				faction: (s && s.f) || null, faction_name: (s && s.f && factions[s.f]) || null,
				distance_ly: dist, in_reach: dist != null && dist <= st.range + 1e-6, own: st.position === coord,
				range_ly: st.range, captains: caps, missions: missions, others: []
			};
			if (missions.some(function (m) { return m.locked; })) {
				st.captains.forEach(function (c) {
					var cp = c && parseCoord(c.position);
					if (cp && !c.me) { out.others.push({ name: c.name || '', ship: c.ship || '', position: c.position, distance_ly: distLy(p, cp), connected: c.connected !== false }); }
				});
			}
			return out;
		}

		function typeLine(d) {
			var bits = [];
			if (d.type === 'star_system') { bits.push(d.star_class ? 'Class ' + d.star_class + ' star system' : 'Star system'); }
			else if (d.type) { bits.push(words(d.type)); }
			if (d.planets != null && d.type === 'star_system') { bits.push(d.planets === 0 ? 'no planets' : d.planets + (d.planets === 1 ? ' planet' : ' planets')); }
			if (d.habitability && d.habitability !== 'none') { bits.push(words(d.habitability)); }
			return bits.join(' · ');
		}

		/* The sector card in the corner of the chart, as on the mockup: what is known of the selected sector, or of the ship's own. */
		function row(k, v, cls) { return '<div class="row"><span>' + esc(k) + '</span><span' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</span></div>'; }
		function renderInfo(d) {
			var L = [];
			if (!d) {
				if (st.pos) { d = detailFor(st.position); }
				if (!d) { info.innerHTML = '<span class="lbl">Star chart</span><span class="nm">No position yet</span><span class="x">Tap any sector for details</span>'; return; }
			}
			var title = d.own ? 'Current sector' : 'Selected sector';
			var head = '<span class="lbl">' + title + '</span><span class="nm">' + esc(d.name) + '</span><span class="sub">' + esc(d.designation) + ' · ' + esc(d.status_label) + '</span>';
			if (d.own) { L.push(row('Reach', esc(fmtLy(d.range_ly)) + ' ly this turn')); }
			else if (d.distance_ly != null) { L.push(row('Distance', esc(fmtLy(d.distance_ly)) + ' ly · ' + (d.in_reach ? '<span style="color:var(--good)">in reach</span>' : 'out of reach'))); }
			if (d.empty) { L.push(row('Type', 'Open space')); }
			else if (!d.known) { L.push(row('Type', 'No data · not yet scanned')); }
			else {
				var tl = typeLine(d);
				if (tl) { L.push(row('Type', esc(tl))); }
				if (d.resources.length) { L.push(row('Resources', esc(d.resources.map(words).join(', ')))); }
				if (d.hazard) { L.push(row('Hazard', esc(words(d.hazard)), 'gdm-warn')); }
				if (d.notable) { L.push(row('Notable', esc(d.notable))); }
			}
			L.push(row('Held by', d.faction_name ? esc(d.faction_name) : 'Unclaimed'));
			if (d.known && d.note) { L.push('<div class="row"><span class="x">' + esc(d.note) + '</span></div>'); }
			if (d.scan) { L.push(row('Scan', esc(d.scan), 'gdm-scan')); }
			if (d.captains.length) {
				var others = d.captains.filter(function (c) { return !c.me; });
				var names = d.captains.map(function (c) { return esc(c.ship || c.name || 'Ship') + (c.me ? ' (you)' : c.name && c.ship ? ' (' + esc(c.name) + ')' : '') + (c.connected ? '' : ' (away)'); });
				if (others.length || !d.own) {
					var fleet = d.captains.length > 1 && d.captains.every(function (c) { return c.in_fleet || c.me; }) && others.some(function (c) { return c.in_fleet; });
					L.push(row(d.captains.length > 1 ? (fleet ? 'Fleet' : 'Ships here') : 'Ship here', '<span style="color:var(--you-2)">' + names.join(', ') + '</span>'));
				}
			}
			d.missions.forEach(function (m) {
				var col = m.locked ? 'var(--crit-2)' : m.status === 'active' ? 'var(--c1-2)' : m.status === 'available' ? 'var(--vio-3)' : m.status === 'suspended' ? 'var(--warn)' : 'var(--dim)';
				var txt = esc(m.title) + (m.locked ? ' · locked · ' + esc(m.locked) : ' · ' + esc(m.status) + (m.mine && m.status === 'active' ? ' (yours)' : ''));
				L.push(row(m.critical ? 'Critical' : 'Mission', '<span style="color:' + col + '">' + txt + '</span>'));
			});
			if (d.others.length) {
				L.push(row('Captains', '<span style="color:var(--you-2)">' + d.others.map(function (o) { return esc(o.ship || o.name || 'Ship') + ' ' + esc(fmtLy(o.distance_ly)) + ' ly' + (o.connected ? '' : ' (away)'); }).join(' · ') + '</span>'));
			}
			info.innerHTML = head + L.join('');
		}

		function refreshDetail(force) {
			var d = selected ? detailFor(selected) : null;
			renderInfo(d);
			var json = JSON.stringify([selected, d]);
			if (force || json !== lastDetailJson) {
				lastDetailJson = json;
				if (onSelect) { try { onSelect(selected, d); } catch (e) { if (window.console) { console.error(e); } } }
			}
			return d;
		}

		function setSelected(coord) {
			if (coord != null) {
				var p = parseCoord(coord);
				if (!p || (haveMap && !inBounds(p))) { coord = null; } else { coord = p.join(','); }
			}
			if (coord === selected) { return; }
			selected = coord;
			refreshDetail(true);
			if (gfx) { gfx.dataChanged(); }
		}

		/* ----- WebGL ----- */
		var gfx = null;

		function showMsg(title, text, extraCls) {
			if (!msg) { msg = el('div', 'gdm-msg'); }
			msg.className = 'gdm-msg' + (extraCls ? ' ' + extraCls : '');
			msg.innerHTML = '<div><b>' + esc(title) + '</b>' + esc(text) + '</div>';
			msg.style.display = '';
		}
		function hideMsg() { if (msg) { msg.style.display = 'none'; } }

		function initGL() {
			if (!T || !T.WebGLRenderer) { return null; }
			var gl = null, attrs = { alpha: false, antialias: false, depth: true, stencil: false, powerPreference: 'high-performance', premultipliedAlpha: true, preserveDrawingBuffer: false };
			var soft = false, coarse = !!(media('(pointer: coarse)') || {}).matches;
			var cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 4;
			quality = opts.quality === 'low' || opts.quality === 'high' ? opts.quality : ((coarse && (cores <= 4 || mem <= 3)) || cores <= 2 ? 'low' : 'high');
			attrs.antialias = quality === 'high';
			try { gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); } catch (e) { gl = null; }
			if (!gl) { return null; }
			try {
				var ext = gl.getExtension('WEBGL_debug_renderer_info');
				soft = /swiftshader|llvmpipe|software|basic render/i.test(String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ''));
			} catch (e) { soft = false; }
			if (soft && opts.quality !== 'high') { quality = 'low'; }
			var renderer;
			try { renderer = new T.WebGLRenderer({ canvas: canvas, context: gl, antialias: attrs.antialias, alpha: false }); } catch (e) { return null; }
			renderer.setClearColor(0x000000, 1);
			renderer.sortObjects = true;
			return buildGfx(renderer);
		}

		function buildGfx(renderer) {
			var low = quality === 'low';
			var scene = new T.Scene();
			var FOV = 40, tanF = Math.tan(FOV * Math.PI / 360);
			var camera = new T.PerspectiveCamera(FOV, 1, 0.05, 1500);
			var G = {};

			function v3(a) { return new T.Vector3(a[0], a[1], a[2]); }
			function mat(o) {
				return new T.ShaderMaterial(Object.assign({ transparent: true, depthTest: false, depthWrite: false, blending: T.AdditiveBlending }, o));
			}

			/* --- uniforms shared by reference --- */
			var uTime = { value: 0 }, uPx = { value: 1 }, uTw = { value: reduced ? 0 : 1 }, uView = { value: new T.Vector2(1, 1) };
			var uScale = { value: 1 }, uScaleCss = { value: 1 }, uCamDist = { value: 20 };
			var uOwn = { value: new T.Vector3() }, uReach = { value: -1 };
			var uCols = { dim: { value: v3(css.dim) }, scan: { value: v3(css.c3) }, visit: { value: v3(css.text) }, warn: { value: v3(css.warn) }, own: { value: v3(css.c1) } };

			/* --- background stars --- */
			var bgCount = low ? 900 : 3000, bgPos = new Float32Array(bgCount * 3), bgCol = new Float32Array(bgCount * 3), bgP = new Float32Array(bgCount * 2);
			(function () {
				var rnd = mulberry(20260113), i, R = 170;
				var tilt = new T.Quaternion().setFromEuler(new T.Euler(0.9, 0.3, 0.5)), v = new T.Vector3();
				for (i = 0; i < bgCount; i++) {
					var u = rnd() * 2 - 1, a = rnd() * TAU, band = rnd() < 0.45;
					if (band) { u = (rnd() + rnd() + rnd() - 1.5) * 0.22; }
					var s = Math.sqrt(1 - u * u);
					v.set(Math.cos(a) * s, u, Math.sin(a) * s);
					if (band) { v.applyQuaternion(tilt); }
					bgPos[i * 3] = v.x * R; bgPos[i * 3 + 1] = v.y * R; bgPos[i * 3 + 2] = v.z * R;
					var m = Math.pow(rnd(), 3.0), b = 0.2 + m * 0.8, tint = rnd();
					var c = tint < 0.2 ? [1, 0.8, 0.62] : tint < 0.45 ? [0.72, 0.8, 1] : [1, 0.97, 0.92];
					bgCol[i * 3] = c[0] * b; bgCol[i * 3 + 1] = c[1] * b; bgCol[i * 3 + 2] = c[2] * b;
					bgP[i * 2] = 1.1 + m * 2.6 + rnd() * 0.5;
					bgP[i * 2 + 1] = 0.985 - (0.03 + m * 0.2);
				}
			}());
			var bgGeo = new T.BufferGeometry();
			bgGeo.setAttribute('position', new T.BufferAttribute(bgPos, 3));
			bgGeo.setAttribute('aCol', new T.BufferAttribute(bgCol, 3));
			bgGeo.setAttribute('aP', new T.BufferAttribute(bgP, 2));
			var bg = new T.Points(bgGeo, mat({ vertexShader: BG_VS, fragmentShader: BG_FS, uniforms: { uPx: uPx, uTime: uTime, uTw: uTw } }));
			bg.frustumCulled = false; bg.renderOrder = 0; scene.add(bg);

			/* --- nebulae, faction tints, far haze --- */
			var puffTex = new T.CanvasTexture(makePuffs(low ? 128 : 256));
			puffTex.generateMipmaps = true; puffTex.minFilter = T.LinearMipmapLinearFilter; puffTex.magFilter = T.LinearFilter;
			var neb = new Layer(T, { iPos: 3, iN: 4, iCol: 3, iFollow: 1 }, mat({ vertexShader: NEB_VS, fragmentShader: NEB_FS, uniforms: { uTex: { value: puffTex }, uTime: uTime, uSpin: uTw } }), 1);
			scene.add(neb.mesh);

			/* --- frame --- */
			var frame = new T.LineSegments(new T.BufferGeometry(), mat({ vertexShader: FRAME_VS, fragmentShader: FRAME_FS }));
			frame.frustumCulled = false; frame.renderOrder = 2; scene.add(frame);

			/* --- reach sphere --- */
			var sphMat = mat({ vertexShader: SPH_VS, fragmentShader: SPH_FS, side: T.DoubleSide, uniforms: { uCol: uCols.own, uTime: uTime, uAlpha: { value: 1 }, uGrid: { value: 1 } } });
			sphMat.extensions = { derivatives: true };
			var sphere = new T.Mesh(new T.SphereGeometry(1, low ? 40 : 64, low ? 24 : 40), sphMat);
			sphere.frustumCulled = false; sphere.renderOrder = 3; sphere.visible = false; scene.add(sphere);

			/* --- sectors --- */
			var sec = new Layer(T, { iPos: 3, iA: 4, iCol: 3, iSize: 1 }, mat({
				vertexShader: SECTOR_VS, fragmentShader: SECTOR_FS,
				uniforms: { uScale: uScale, uPx: uPx, uCamDist: uCamDist, uReach: uReach, uOwn: uOwn, uTime: uTime, uTw: uTw, uDim: uCols.dim, uScan: uCols.scan, uVisit: uCols.visit, uWarn: uCols.warn, uReachCol: uCols.own }
			}), 4);
			scene.add(sec.mesh);

			/* --- lines + markers --- */
			var lines = new Layer(T, { iA2: 3, iB2: 3, iCol: 4, iP: 4 }, mat({ vertexShader: LINE_VS, fragmentShader: LINE_FS, uniforms: { uView: uView, uTime: uTime } }), 5);
			scene.add(lines.mesh);
			var marks = new Layer(T, { iPos: 3, iB: 4, iCol: 4, iC: 2 }, mat({
				vertexShader: MARK_VS, fragmentShader: MARK_FS, blending: T.NormalBlending, premultipliedAlpha: true,
				uniforms: { uView: uView, uScaleCss: uScaleCss, uTime: uTime, uPx: uPx }
			}), 6);
			scene.add(marks.mesh);

			/* --- camera rig --- */
			var cam = { yaw: 0.62, pitch: 0.36, dist: 30, goal: 30, target: new T.Vector3(), vyaw: 0, vpitch: 0, vpan: new T.Vector3(), fit: 30, touched: false };
			var tween = null, lastInput = -1e9, anchor = null, anchorAt = 0;
			var vp = new T.Matrix4(), tmpA = new T.Vector3(), tmpB = new T.Vector3(), tmpC = new T.Vector3();
			var P = { x: 0, y: 0, w: 0, vis: false };

			function fitDist() {
				var aspect = W > 0 && H > 0 ? W / H : 1.6;
				var halfV = FOV * Math.PI / 360, halfH = Math.atan(tanF * aspect);
				return (N * (aspect < 1.2 ? 0.8 : 0.74)) / Math.sin(Math.min(halfV, halfH));
			}
			function placeCamera() {
				var cp = Math.cos(cam.pitch);
				camera.position.set(cam.target.x + cam.dist * Math.sin(cam.yaw) * cp, cam.target.y + cam.dist * Math.sin(cam.pitch), cam.target.z + cam.dist * Math.cos(cam.yaw) * cp);
				camera.lookAt(cam.target);
				camera.updateMatrixWorld(true);
				vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
				uCamDist.value = cam.dist;
			}
			function project(x, y, z) {
				var e = vp.elements, w = e[3] * x + e[7] * y + e[11] * z + e[15];
				P.w = w;
				if (w <= 0.02) { P.vis = false; return P; }
				P.x = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * W;
				P.y = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5) * H;
				P.vis = true;
				return P;
			}
			function clampTarget() {
				var m = half + 0.5;
				cam.target.set(clamp(cam.target.x, -m, m), clamp(cam.target.y, -m, m), clamp(cam.target.z, -m, m));
			}
			function panPx(dx, dy) {
				var k = cam.dist * 2 * tanF / Math.max(1, H);
				tmpA.setFromMatrixColumn(camera.matrixWorld, 0); tmpB.setFromMatrixColumn(camera.matrixWorld, 1);
				tmpC.set(0, 0, 0).addScaledVector(tmpA, -dx * k).addScaledVector(tmpB, dy * k);
				cam.target.add(tmpC); clampTarget();
				return tmpC;
			}
			function zoomBy(f, cx, cy) {
				cam.goal = clamp(cam.goal * f, 1.6, cam.fit * 1.7);
				if (cx != null) { anchor = [cx / W * 2 - 1, 1 - cy / H * 2]; anchorAt = performance.now(); }
			}
			function startTween(to, dur) {
				cam.vyaw = cam.vpitch = 0; cam.vpan.set(0, 0, 0);
				if (reduced || dur <= 0) {
					if (to.target) { cam.target.copy(to.target); }
					if (to.dist != null) { cam.dist = cam.goal = to.dist; }
					tween = null; dirty = true; return;
				}
				tween = { t: 0, dur: dur, t0: cam.target.clone(), t1: to.target || cam.target.clone(), d0: cam.dist, d1: to.dist != null ? to.dist : cam.dist };
			}
			function updateCamera(dt) {
				var moving = false;
				if (tween) {
					tween.t = Math.min(1, tween.t + dt / tween.dur);
					var k = ease(tween.t);
					cam.target.lerpVectors(tween.t0, tween.t1, k);
					// Zoom eases in log space so a long pull-back feels even.
					cam.dist = cam.goal = Math.exp(Math.log(tween.d0) + (Math.log(tween.d1) - Math.log(tween.d0)) * k);
					if (tween.t >= 1) { tween = null; }
					moving = true;
				} else {
					if (!drag.active) {
						if (Math.abs(cam.vyaw) + Math.abs(cam.vpitch) > 1e-4) {
							cam.yaw += cam.vyaw * dt; cam.pitch = clamp(cam.pitch + cam.vpitch * dt, -1.45, 1.45);
							moving = true;
						}
						if (cam.vpan.lengthSq() > 1e-7) { cam.target.addScaledVector(cam.vpan, dt); clampTarget(); moving = true; }
						var decay = Math.exp(-dt * 5.5);
						cam.vyaw *= decay; cam.vpitch *= decay; cam.vpan.multiplyScalar(Math.exp(-dt * 7));
					}
					if (Math.abs(cam.goal - cam.dist) > 1e-4 * cam.dist) {
						var before = cam.dist;
						cam.dist += (cam.goal - cam.dist) * (reduced ? 1 : 1 - Math.exp(-dt * 11));
						if (anchor && performance.now() - anchorAt < 450) {
							// Zoom about the point under the pointer: slide the target toward it.
							var kk = cam.dist / before, hh = before * tanF;
							tmpA.setFromMatrixColumn(camera.matrixWorld, 0); tmpB.setFromMatrixColumn(camera.matrixWorld, 1);
							cam.target.addScaledVector(tmpA, anchor[0] * hh * camera.aspect * (1 - kk)).addScaledVector(tmpB, anchor[1] * hh * (1 - kk));
							clampTarget();
						}
						moving = true;
					}
					// Idle drift, as in the approved mockup, unless the user prefers reduced motion.
					if (!reduced && !drag.active && performance.now() - lastInput > 7000) { cam.yaw += dt * 0.022; moving = true; }
				}
				if (moving) { dirty = true; }
				placeCamera();
			}

			/* --- data → buffers --- */
			var ownW = new T.Vector3(), haveOwn = false, jump = null, trail = [], flash = null, reachFade = 1;
			var markEnts = [], labelEnts = [], lodEnts = [], reachCells = [], dataDirty = true;

			function buildFrame() {
				var lo = -half - 0.5, hi = half + 0.5, pos = [], col = [], c3 = css.frame, i, b;
				function seg(a, bb, k) { pos.push(a[0], a[1], a[2], bb[0], bb[1], bb[2]); for (var j = 0; j < 2; j++) { col.push(c3[0] * k, c3[1] * k, c3[2] * k); } }
				for (i = 0; i < 8; i++) {
					for (b = 1; b <= 4; b <<= 1) {
						if (!(i & b)) { seg([i & 1 ? hi : lo, i & 2 ? hi : lo, i & 4 ? hi : lo], [(i | b) & 1 ? hi : lo, (i | b) & 2 ? hi : lo, (i | b) & 4 ? hi : lo], 0.34); }
					}
				}
				// Floor grid: one line per cell boundary, every fourth one a little stronger.
				for (i = 1; i < N; i++) {
					var t = lo + i, k = i % 4 === 0 ? 0.13 : 0.055;
					seg([t, lo, lo], [t, lo, hi], k); seg([lo, lo, t], [hi, lo, t], k);
				}
				// Short ticks up the four vertical edges mark the levels.
				for (i = 1; i < N; i++) {
					var y = lo + i, tk = 0.22;
					seg([lo, y, lo], [lo + tk, y, lo], 0.2); seg([hi, y, lo], [hi - tk, y, lo], 0.2);
					seg([lo, y, hi], [lo + tk, y, hi], 0.2); seg([hi, y, hi], [hi - tk, y, hi], 0.2);
				}
				var g = new T.BufferGeometry();
				g.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
				g.setAttribute('aCol', new T.BufferAttribute(new Float32Array(col), 3));
				frame.geometry.dispose(); frame.geometry = g;
			}

			function buildSectors() {
				var recs = [], i;
				for (i = 0; i < sectorList.length; i++) {
					var s = sectorList[i], ty = TYPE[s.t] || 0, known = s.s > 0, star = STAR[s.k] || STAR.G;
					var size = ty === 0 ? 0.52 * star[1] : ty === 1 ? 0.2 : ty === 2 ? 0.62 : 0.4;
					var hz = known && s.d && s.d.hazard ? (HAZ[s.d.hazard] || 5) : 0;
					if (hz && ty !== 2) { size *= 1.15; }
					if (!known) { size = 0.5; }
					recs.push({ iPos: s.w, iA: [s.s, ty, hz, (cellSeed(s.x, s.y, s.z) % 1000) / 1000], iCol: ty === 0 ? rgb(star[0]) : css.frame, iSize: [size] });
				}
				sec.fill(recs);
			}

			function buildNebulae() {
				var recs = [], nebCells = sectorList.filter(function (s) { return s.t === 'nebula'; }), i, j;
				var per = low ? 1 : nebCells.length > 420 ? 2 : 3;
				var aScale = (per === 1 ? 1.6 : per === 2 ? 1.15 : 0.88) * (low ? 0.9 : 1);
				// Connected nebula cells share a palette so each cloud reads as one body.
				var cluster = new Map(), dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
				nebCells.forEach(function (s) {
					if (cluster.has(s.c)) { return; }
					var pal = NEB_PAL[cellSeed(s.x, s.y, s.z) % NEB_PAL.length], stack = [s];
					cluster.set(s.c, pal);
					while (stack.length) {
						var q = stack.pop();
						for (var d = 0; d < 6; d++) {
							var key = (q.x + dirs[d][0]) + ',' + (q.y + dirs[d][1]) + ',' + (q.z + dirs[d][2]), nb = sectors.get(key);
							if (nb && nb.t === 'nebula' && !cluster.has(key)) { cluster.set(key, pal); stack.push(nb); }
						}
					}
				});
				for (i = 0; i < nebCells.length; i++) {
					var s = nebCells[i], rnd = mulberry(cellSeed(s.x, s.y, s.z)), pal = cluster.get(s.c), a = rgb(pal[0]), b = rgb(pal[1]), known = s.s > 0;
					for (j = 0; j < per; j++) {
						var col = mix3(a, b, rnd()), al = (0.1 + rnd() * 0.07) * aScale;
						if (!known) { var gy = (col[0] + col[1] + col[2]) / 3; col = mix3([gy * 0.8, gy * 0.85, gy], col, 0.3); al *= 0.42; }
						recs.push({
							iPos: [s.w[0] + (rnd() - 0.5) * 0.9, s.w[1] + (rnd() - 0.5) * 0.9, s.w[2] + (rnd() - 0.5) * 0.9],
							iN: [0.95 + rnd() * 0.85, rnd() * TAU, Math.floor(rnd() * 4), al], iCol: col, iFollow: [0]
						});
					}
				}
				// Known factions: one faint soft volume per territory sector.
				var fcount = 0;
				sectorList.forEach(function (s) { if (s.f && factions[s.f]) { fcount++; } });
				if (fcount) {
					// Large territories are thinned out (every nth sector, larger and a little stronger) to bound overdraw.
					var stride = Math.ceil(fcount / (low ? 140 : 520)), grow = Math.pow(stride, 1 / 3), fi = 0;
					var fa = (fcount / stride > 400 ? 0.022 : fcount / stride > 120 ? 0.032 : 0.05) * Math.sqrt(grow);
					sectorList.forEach(function (s) {
						if (!s.f || !factions[s.f] || (fi++ % stride)) { return; }
						recs.push({ iPos: s.w, iN: [1.75 * grow, 0, -1, fa * 1.8], iCol: factionColour(s.f), iFollow: [0] });
						if (!low) { recs.push({ iPos: s.w, iN: [3.1 * grow, 0, -1, fa * 0.55], iCol: factionColour(s.f), iFollow: [0] }); }
					});
				}
				// Far haze behind everything, fixed to the sky.
				var rnd2 = mulberry(4471), hz = low ? 0 : 5, tints = [[0.25, 0.3, 0.75], [0.5, 0.28, 0.7], [0.7, 0.36, 0.3], [0.2, 0.45, 0.6]];
				for (i = 0; i < hz; i++) {
					var u = rnd2() * 1.4 - 0.7, an = rnd2() * TAU, sr = Math.sqrt(1 - u * u), R = 150;
					recs.push({ iPos: [Math.cos(an) * sr * R, u * R, Math.sin(an) * sr * R], iN: [70 + rnd2() * 50, rnd2() * TAU, Math.floor(rnd2() * 4), 0.17 + rnd2() * 0.08], iCol: tints[i % tints.length], iFollow: [0.93] });
				}
				neb.fill(recs);
			}

			function factionColour(key) {
				var keys = Object.keys(factions).sort(), idx = keys.indexOf(key);
				return rgb(FAC_COLS[(idx < 0 ? strSeed(key) : idx) % FAC_COLS.length]);
			}

			function buildReachCells() {
				reachCells = [];
				if (!st.pos || !(st.range > 0) || !haveMap) { return; }
				var r = st.range / lyU + 1e-6, R = Math.ceil(r), x, y, z, o = st.pos;
				for (x = Math.max(0, o[0] - R); x <= Math.min(N - 1, o[0] + R); x++) {
					for (y = Math.max(0, o[1] - R); y <= Math.min(N - 1, o[1] + R); y++) {
						for (z = Math.max(0, o[2] - R); z <= Math.min(N - 1, o[2] + R); z++) {
							if (Math.hypot(x - o[0], y - o[1], z - o[2]) > r) { continue; }
							var key = x + ',' + y + ',' + z;
							if (sectors.has(key) || key === st.position) { continue; }
							reachCells.push({ c: key, w: world([x, y, z]) });
						}
					}
				}
			}

			function shipLabel(c) { return c.ship || c.name || 'Ship'; }

			/** Markers, lines and label anchors: everything that depends on state or selection. */
			function buildDynamic() {
				var M = [], L = [], Lb = [], floor = -half - 0.5, i;
				markEnts = [];
				function mark(w, ox, oy, size, glyph, col, alpha, phase, worldSize) { M.push({ iPos: w, iB: [ox, oy, size, glyph], iCol: [col[0], col[1], col[2], alpha], iC: [phase || 0, worldSize || 0] }); }
				function line(a, b, col, alpha, width, dash, fa, fb) { L.push({ iA2: a, iB2: b, iCol: [col[0], col[1], col[2], alpha], iP: [width, dash || 0, fa == null ? 1 : fa, fb == null ? 1 : fb] }); }
				function drop(w, col, alpha) {
					if (w[1] - floor < 0.05) { return; }
					line(w, [w[0], floor, w[2]], col, alpha, 1.3, 0, 0.9, 0.15);
					mark([w[0], floor, w[2]], 0, 0, 2.2, 9, col, alpha * 0.9);
				}
				var ownNow = haveOwn ? [ownW.x, ownW.y, ownW.z] : null, selP = selected ? parseCoord(selected) : null, selW = selP ? world(selP) : null;
				var selDetail = selected ? detailFor(selected) : null;

				// Empty cells the ship can reach this turn, drawn as a faint lattice so they can be tapped.
				if (!jump) {
					for (i = 0; i < reachCells.length; i++) { mark(reachCells[i].w, 0, 0, 1.7, 9, css.c1, 0.5 * reachFade); }
				}

				// Route trail.
				for (i = 0; i < trail.length - 1; i++) {
					var age = trail.length - 2 - i, a0 = 0.8 * Math.pow(0.6, age + 1), a1 = 0.8 * Math.pow(0.6, age);
					line(trail[i], trail[i + 1], css.c1, 1, 2, 0, a0, a1);
					mark(trail[i], 0, 0, 2.4, 9, css.c1, a0 * 1.2);
				}
				if (jump) {
					var k = jump.k, from = jump.from;
					line(from, ownNow, css.c1, 1, 2.4, 0, 0.2, 0.8);
					// Bright streak just behind the ship.
					var tail = Math.max(0, k - 0.28 * Math.sin(Math.PI * k) - 0.02);
					var tw = [from[0] + (jump.to[0] - from[0]) * tail, from[1] + (jump.to[1] - from[1]) * tail, from[2] + (jump.to[2] - from[2]) * tail];
					line(tw, ownNow, css.text, 1, 5, 0, 0, 1);
					line(tw, ownNow, css.c1, 1, 13, 0, 0, 0.7);
				}

				// Captains grouped by position.
				var groups = new Map(), ownOthers = [];
				st.captains.forEach(function (c) {
					if (!c || c.me) { return; }
					var p = parseCoord(c.position);
					if (!p || !inBounds(p)) { return; }
					var key = p.join(',');
					if (moves[c.id]) { return; } // still travelling: drawn below, on the way
					if (key === st.position) { ownOthers.push(c); return; }
					if (!groups.has(key)) { groups.set(key, { coord: key, p: p, list: [] }); }
					groups.get(key).list.push(c);
				});
				// Captains under way between two sectors.
				st.captains.forEach(function (c) {
					var m = c && moves[c.id];
					if (!m) { return; }
					var k = ease(m.t), tail = Math.max(0, k - 0.22);
					var at = [m.from[0] + (m.to[0] - m.from[0]) * k, m.from[1] + (m.to[1] - m.from[1]) * k, m.from[2] + (m.to[2] - m.from[2]) * k];
					var back = [m.from[0] + (m.to[0] - m.from[0]) * tail, m.from[1] + (m.to[1] - m.from[1]) * tail, m.from[2] + (m.to[2] - m.from[2]) * tail];
					line(back, at, css.c2, 1, 9, 0, 0, 0.7);
					mark(at, 0, 0, 10.5, 1, css.c2, 1);
					Lb.push({ id: 'mov:' + c.id, w: at, ox: 15, oy: 0, html: esc(shipLabel(c)), cls: 'cap', mode: 'always', prio: 80 });
				});
				groups.forEach(function (g) {
					var w = world(g.p), n = g.list.length, isSel = selected === g.coord;
					var anyOn = g.list.some(function (c) { return c.connected !== false; });
					drop(w, css.c2, 0.4);
					var html;
					if (n > 1) {
						mark(w, 0, 0, 15, 2, css.c2, anyOn ? 1 : 0.6);
						var fleet = g.list.every(function (c) { return c.in_fleet; });
						html = (fleet ? 'Fleet' : 'Group') + ' · ' + n + ' ships';
						if (isSel) { html += g.list.map(function (c) { return '<i>' + esc(shipLabel(c)) + (c.connected === false ? ' (away)' : '') + '</i>'; }).join(''); }
					} else {
						mark(w, 0, 0, 10.5, anyOn ? 1 : 3, css.c2, anyOn ? 1 : 0.75);
						html = esc(shipLabel(g.list[0])) + (anyOn ? '' : ' (away)');
					}
					Lb.push({ id: 'cap:' + g.coord, w: w, ox: n > 1 ? 21 : 15, oy: 0, html: html, cls: anyOn ? 'cap' : 'away', mode: 'always', prio: 80 });
					markEnts.push({ c: g.coord, w: w, oy: 0, r: 1.3 });
					// §6.3: show where the other captains are relative to a gated mission.
					if (selW && selDetail && selDetail.missions.some(function (m) { return m.locked; }) && g.coord !== selected) { line(w, selW, css.c2, 0.5, 1.5, 9); }
				});

				// Own ship (or own fleet).
				if (ownNow) {
					drop(ownNow, css.c1, 0.6);
					mark(ownNow, 0, 0, 24, 0, css.c1, 1);
					if (flash) { mark(ownNow, 0, 0, 46, 11, css.c1, 1, flash.k); }
					var mine = esc((st.me && st.me.ship) || 'Your ship');
					if (ownOthers.length) {
						var fl = ownOthers.every(function (c) { return c.in_fleet; });
						mine += ' · ' + (fl ? 'fleet of ' : 'with ') + (fl ? ownOthers.length + 1 : ownOthers.length + (ownOthers.length === 1 ? ' ship' : ' ships'));
						if (selected === st.position) { mine += ownOthers.map(function (c) { return '<i>' + esc(shipLabel(c)) + (c.connected === false ? ' (away)' : '') + '</i>'; }).join(''); }
					}
					Lb.push({ id: 'own', w: ownNow, ox: 22, oy: 0, html: mine, cls: 'own', mode: 'always', prio: 100, live: true });
					if (st.position) { markEnts.push({ c: st.position, w: world(st.pos), oy: 0, r: 1.5 }); }
				}

				// Missions, stacked above their sector.
				var stacks = {};
				st.missions.forEach(function (m, idx) {
					if (!m || m.status === 'completed' || m.status === 'failed') { return; }
					var p = parseCoord(m.sector);
					if (!p || !inBounds(p)) { return; }
					var key = p.join(','), n = stacks[key] = (stacks[key] || 0) + 1, w = world(p);
					var oy = 4 + n * 23, glyph, col, cls, size = 10, text = esc(m.title || 'Mission'), mode = 'mission';
					if (m.locked) { glyph = 5; col = css.crit; cls = 'm-crit'; size = 13; text = 'Locked<i>' + esc(m.locked) + '</i>'; mode = 'always'; }
					else if (m.status === 'active') { glyph = 6; col = m.mine ? css.c1 : css.c2; cls = m.mine ? 'm-own' : 'm-oth'; size = 11; mode = m.mine ? 'always' : 'mission'; if (m.mine) { text = 'Active · ' + text; } }
					else if (m.status === 'suspended') { glyph = 7; col = css.warn; cls = 'm-warn'; }
					else { glyph = 4; col = css.lead; cls = 'm-lead'; size = m.critical ? 11.5 : 9.5; }
					if (selected === key) { mode = 'always'; if (m.locked) { text = 'Locked · ' + esc(m.title || 'Mission') + '<i>' + esc(m.locked) + '</i>'; } }
					mark(w, 0, oy, size, glyph, col, 1, idx * 1.7);
					Lb.push({ id: 'mis:' + idx, w: w, ox: size + 7, oy: -oy, html: text, cls: cls, mode: mode, prio: m.locked ? 90 : m.status === 'active' ? 85 : 60 });
					markEnts.push({ c: key, w: w, oy: -oy, r: 1.2 });
				});

				// Selection: reticle, drop line, course line from the own ship.
				if (selW) {
					drop(selW, css.c4, 0.55);
					mark(selW, 0, 0, 13, 8, css.c4, 1, 0, 0.34);
					mark(selW, 0, 0, 20, 10, css.c4, 0.55, 0, 0.5);
					if (ownNow && selected !== st.position && selDetail) {
						line(ownNow, selW, selDetail.in_reach ? css.c1 : css.dim, selDetail.in_reach ? 0.85 : 0.6, 1.7, 9);
					}
					var shown = groups.has(selected) || selected === st.position;
					if (!shown && selDetail) {
						Lb.push({ id: 'sel', w: selW, ox: 16, oy: 14, html: esc(selDetail.name) + (selDetail.distance_ly != null ? '<i>' + esc(fmtLy(selDetail.distance_ly)) + ' ly · ' + (selDetail.in_reach ? 'in reach' : 'out of reach') + '</i>' : ''), cls: 'sel', mode: 'always', prio: 95 });
					}
				}
				if (hover && hover !== selected) {
					var hp = parseCoord(hover);
					if (hp) {
						var hw = world(hp), hs = sectors.get(hover);
						mark(hw, 0, 0, 10, 10, css.c4, 0.8, 0, 0.26);
						if (!groups.has(hover) && hover !== st.position) { Lb.push({ id: 'hov', w: hw, ox: 14, oy: 12, html: esc(sectorName(hp, hs)), cls: 'hov', mode: 'always', prio: 70 }); }
					}
				}

				// Place names and faction names: fade in by zoom level.
				sectorList.forEach(function (s) {
					if (s.p && s.c !== selected && s.c !== hover) { Lb.push({ id: 'pl:' + s.c, w: s.w, ox: 11, oy: 0, html: esc(s.p), cls: 'place', mode: 'place', prio: s.s > 0 ? 40 : 30 }); }
				});
				var cent = {};
				sectorList.forEach(function (s) {
					if (!s.f || !factions[s.f]) { return; }
					var c = cent[s.f] || (cent[s.f] = [0, 0, 0, 0]);
					c[0] += s.w[0]; c[1] += s.w[1]; c[2] += s.w[2]; c[3]++;
				});
				Object.keys(cent).forEach(function (k) {
					var c = cent[k];
					Lb.push({ id: 'fac:' + k, w: [c[0] / c[3], c[1] / c[3], c[2] / c[3]], ox: 0, oy: 0, html: esc(factions[k]), cls: 'fac', mode: 'faction', prio: 50, centre: true, col: factionColour(k) });
				});

				marks.fill(M); lines.fill(L);
				Lb.sort(function (a, b) { return b.prio - a.prio; });
				labelEnts = Lb;
			}

			/* --- labels --- */
			var pool = new Map(), placed = [], infoRect = null;
			function lodAlpha(L, w) {
				var pxu = uScaleCss.value / w / (W < 520 ? 1.5 : 1);
				if (L.mode === 'always') { return 1; }
				if (L.mode === 'place') { return smooth(17, 26, pxu); }
				if (L.mode === 'mission') { return smooth(13, 20, pxu); }
				if (L.mode === 'sector') { return smooth(60, 80, pxu) * 0.9; }
				if (L.mode === 'faction') { return (1 - smooth(30, 46, pxu)) * 0.5; }
				return 1;
			}
			function overlaps(x, y, w, h) {
				for (var i = 0; i < placed.length; i++) {
					var r = placed[i];
					if (x < r[0] + r[2] + 4 && x + w + 4 > r[0] && y < r[1] + r[3] + 1 && y + h + 1 > r[1]) { return true; }
				}
				return false;
			}
			function updateLabels(dt) {
				placed.length = 0;
				if (frameNo % 20 === 1 || !infoRect) {
					var ir = info.getBoundingClientRect(), cr = container.getBoundingClientRect();
					infoRect = [ir.left - cr.left, ir.top - cr.top, Math.min(ir.width, info.scrollWidth), ir.height];
				}
				if (infoRect[3] > 0) { placed.push(infoRect); }
				if (haveOwn) { project(ownW.x, ownW.y, ownW.z); if (P.vis) { placed.push([P.x - 15, P.y - 15, 30, 30]); } }
				var all = lodEnts.length ? labelEnts.concat(lodEnts) : labelEnts, i;
				for (i = 0; i < all.length; i++) {
					var L = all[i], n = pool.get(L.id);
					if (!n) {
						var e = document.createElement('div');
						e.style.opacity = '0';
						labelBox.appendChild(e);
						n = { el: e, alpha: 0, w: 0, h: 0, html: null, cls: null, x: 0, y: 0, ox: 0, oy: 0, slot: 0, shown: true };
						pool.set(L.id, n);
					}
					if (n.html !== L.html || n.cls !== L.cls) {
						n.el.className = 'gdm-l ' + L.cls; n.el.innerHTML = L.html; n.html = L.html; n.cls = L.cls;
						n.el.style.color = L.col ? 'rgb(' + Math.round(L.col[0] * 255) + ',' + Math.round(L.col[1] * 255) + ',' + Math.round(L.col[2] * 255) + ')' : '';
						if (!n.shown) { n.el.style.display = ''; n.shown = true; }
						n.w = n.el.offsetWidth; n.h = n.el.offsetHeight;
					}
					n.seen = frameNo;
					var w = L.live ? [ownW.x, ownW.y, ownW.z] : L.w, target = 0, slot = 0;
					project(w[0], w[1], w[2]);
					if (P.vis) {
						var sx = P.x + L.ox - (L.centre ? n.w / 2 : 0), sy = P.y + L.oy - (L.oy > 6 ? 0 : n.h > 20 && !L.centre ? 8 : n.h / 2);
						if (sx < W - 6 && sx + n.w > 6 && sy > -n.h && sy < H) {
							target = lodAlpha(L, P.w);
							if (target > 0.02) {
								if (sx + n.w > W - 4 && !L.centre) {
									if (P.x - L.ox - n.w > 4) { sx = P.x - L.ox - n.w; slot = 8; }
									else if (L.mode === 'always') { sx = Math.max(4, W - 4 - n.w); sy += n.h / 2 + 12; slot = 9; }
								}
								if (overlaps(sx, sy, n.w, n.h)) {
									// Try below, above, then the left side before giving up (or, for must-show labels, overlapping).
									var lx = P.x - L.ox - n.w, alt = [[sx, sy + n.h + 2], [sx, sy - n.h - 2], [lx, sy], [lx, sy + n.h + 2], [lx, sy - n.h - 2]], ok = false;
									if (L.mode === 'faction') { alt = [[sx, sy + n.h * 2], [sx, sy - n.h * 2], [sx, sy + n.h * 4], [sx, sy - n.h * 4], [sx, sy + n.h * 6], [sx, sy - n.h * 6]]; }
									if (L.mode === 'always' || L.mode === 'mission' || L.mode === 'faction') {
										for (var ai = 0; ai < alt.length && !ok; ai++) {
											if (!overlaps(alt[ai][0], alt[ai][1], n.w, n.h)) { sx = alt[ai][0]; sy = alt[ai][1]; ok = true; slot = ai + 1; }
										}
									}
									if (!ok && L.mode !== 'always') { target = 0; }
								}
								if (target > 0.02) { placed.push([sx, sy, n.w, n.h]); }
							}
							// Ease toward a new slot so a label never jumps.
							if (slot !== n.slot && n.alpha > 0.05 && !reduced) { n.ox += n.x - sx; n.oy += n.y - sy; }
							n.slot = slot; n.x = sx; n.y = sy;
						}
					}
					n.alpha = reduced ? target : n.alpha + (target - n.alpha) * Math.min(1, dt * 9);
					if (n.alpha < 0.02) {
						if (n.shown) { n.el.style.display = 'none'; n.shown = false; }
					} else {
						if (!n.shown) { n.el.style.display = ''; n.shown = true; }
						n.el.style.opacity = n.alpha.toFixed(2);
						if (n.ox || n.oy) { var dk = Math.exp(-dt * 11); n.ox *= dk; n.oy *= dk; if (Math.abs(n.ox) + Math.abs(n.oy) < 0.5) { n.ox = n.oy = 0; } }
						n.el.style.transform = 'translate3d(' + (n.x + n.ox).toFixed(1) + 'px,' + (n.y + n.oy).toFixed(1) + 'px,0)';
					}
				}
				pool.forEach(function (n, id) { if (n.seen !== frameNo) { n.el.remove(); pool.delete(id); } });
			}

			/** Zoom-level detail: designations of the sectors nearest the middle of a close-up view. */
			function updateLod() {
				var out = [], i, cx = W / 2, cy = H / 2;
				if (uScaleCss.value / cam.dist > 42) {
					var cand = [];
					for (i = 0; i < sectorList.length; i++) {
						var s = sectorList[i];
						if (s.p || s.t === 'nebula' || s.c === selected || s.c === hover || s.c === st.position) { continue; }
						project(s.w[0], s.w[1], s.w[2]);
						if (!P.vis || uScaleCss.value / P.w < 60 || P.x < 0 || P.x > W || P.y < 0 || P.y > H) { continue; }
						cand.push([Math.hypot(P.x - cx, P.y - cy) + P.w * 6, s]);
					}
					cand.sort(function (a, b) { return a[0] - b[0]; });
					for (i = 0; i < Math.min(low ? 8 : 14, cand.length); i++) {
						var q = cand[i][1], txt = pad(q.x) + '-' + pad(q.y) + '-' + pad(q.z);
						if (q.s > 0) { txt += q.t === 'star_system' ? ' · ' + (q.k ? 'class ' + q.k : 'star') : ' · ' + esc(words(q.t)); }
						out.push({ id: 'sec:' + q.c, w: q.w, ox: 11, oy: 0, html: txt, cls: 'sec', mode: 'sector', prio: 10 });
					}
				}
				lodEnts = out;
			}

			function updateEdge() {
				if (!haveOwn) { if (edge.style.display !== 'none') { edge.style.display = 'none'; } return; }
				project(ownW.x, ownW.y, ownW.z);
				var m = 16, inside = P.vis && P.x > m && P.x < W - m && P.y > m && P.y < H - m;
				if (inside) { if (edge.style.display !== 'none') { edge.style.display = 'none'; } return; }
				var dx, dy;
				if (P.vis) { dx = P.x - W / 2; dy = P.y - H / 2; }
				else {
					// Behind the camera: point the way the camera would have to turn.
					tmpA.copy(ownW).applyMatrix4(camera.matrixWorldInverse);
					dx = tmpA.x; dy = -tmpA.y;
					if (Math.abs(dx) + Math.abs(dy) < 1e-4) { dy = 1; }
				}
				if (edge.style.display !== 'flex') { edge.style.display = 'flex'; }
				var ew = edge.offsetWidth, eh = edge.offsetHeight, hw = W / 2 - ew / 2 - 8, hh = H / 2 - eh / 2 - 8;
				var k = Math.min(hw / Math.max(1e-3, Math.abs(dx)), hh / Math.max(1e-3, Math.abs(dy)));
				var ex = W / 2 + dx * k - ew / 2, ey = H / 2 + dy * k - eh / 2;
				edge.style.transform = 'translate3d(' + ex.toFixed(0) + 'px,' + ey.toFixed(0) + 'px,0)';
				edge.firstChild.style.transform = 'rotate(' + (Math.atan2(dy, dx) + Math.PI / 2).toFixed(2) + 'rad)';
			}

			/* --- picking --- */
			function pick(px, py, touch) {
				var tol = touch ? 26 : 14, best = null, bestScore = 1e9, i, d, sc;
				for (i = 0; i < markEnts.length; i++) {
					var m = markEnts[i];
					project(m.w[0], m.w[1], m.w[2]);
					if (!P.vis) { continue; }
					d = Math.hypot(P.x - px, P.y + m.oy - py);
					if (d < tol * m.r) { sc = d / m.r - 8; if (sc < bestScore) { bestScore = sc; best = m.c; } }
				}
				for (i = 0; i < sectorList.length; i++) {
					var s = sectorList[i];
					project(s.w[0], s.w[1], s.w[2]);
					if (!P.vis) { continue; }
					d = Math.hypot(P.x - px, P.y - py);
					// A big, close star is an easier target than its centre point alone.
					var grow = Math.min(18, (s.s > 0 ? 0.2 : 0.1) * uScaleCss.value / P.w);
					if (d < tol + grow) { sc = Math.max(0, d - grow) + tol * 0.3 * clamp(P.w / (cam.dist * 2), 0, 1) + (s.s > 0 ? 0 : 1.5); if (sc < bestScore) { bestScore = sc; best = s.c; } }
				}
				if (best) { return best; }
				for (i = 0; i < reachCells.length; i++) {
					var c = reachCells[i];
					project(c.w[0], c.w[1], c.w[2]);
					if (!P.vis) { continue; }
					d = Math.hypot(P.x - px, P.y - py);
					if (d < tol) { sc = d + tol * 0.4 * clamp(P.w / (cam.dist * 2), 0, 1); if (sc < bestScore) { bestScore = sc; best = c.c; } }
				}
				return best;
			}

			/* --- input --- */
			var ptrs = new Map(), drag = { active: false, mode: 'orbit', moved: 0, multi: false, t: 0, type: 'mouse', pd: 0, pcx: 0, pcy: 0, lastT: 0 };
			var lastClick = { c: null, t: 0 }, hoverPt = null;
			function local(e) { var r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
			function touchInput() { lastInput = performance.now(); cam.touched = true; tween = null; dirty = true; }
			function pinchState() {
				var a = [], it = ptrs.values(), n;
				while (!(n = it.next()).done) { a.push(n.value); }
				drag.pd = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); drag.pcx = (a[0].x + a[1].x) / 2; drag.pcy = (a[0].y + a[1].y) / 2;
			}
			function onDown(e) {
				if (e.pointerType === 'mouse' && e.button > 2) { return; }
				ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
				try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
				touchInput();
				cam.vyaw = cam.vpitch = 0; cam.vpan.set(0, 0, 0);
				if (ptrs.size === 1) {
					drag.active = true; drag.moved = 0; drag.multi = false; drag.t = performance.now(); drag.type = e.pointerType || 'mouse';
					drag.mode = (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'orbit';
					drag.lastT = drag.t;
					canvas.classList.add('gdm-grabbing');
				} else if (ptrs.size === 2) { drag.multi = true; pinchState(); }
				if (e.pointerType === 'mouse') { e.preventDefault(); try { canvas.focus({ preventScroll: true }); } catch (err) { /* old browser */ } }
			}
			function onMove(e) {
				var p = ptrs.get(e.pointerId);
				if (!p) {
					if (e.pointerType === 'mouse') { hoverPt = local(e); }
					return;
				}
				var dx = e.clientX - p.x, dy = e.clientY - p.y, now = performance.now();
				p.x = e.clientX; p.y = e.clientY;
				if (!dx && !dy) { return; }
				var dt = Math.max(0.004, (now - drag.lastT) / 1000);
				drag.lastT = now;
				touchInput();
				if (ptrs.size === 1) {
					drag.moved += Math.abs(dx) + Math.abs(dy);
					if (drag.mode === 'pan') {
						var mv = panPx(dx, dy);
						cam.vpan.lerp(tmpA.copy(mv).multiplyScalar(1 / dt), 0.5);
					} else {
						var ky = -dx * 0.0065, kp = dy * 0.0055;
						cam.yaw += ky; cam.pitch = clamp(cam.pitch + kp, -1.45, 1.45);
						cam.vyaw = cam.vyaw * 0.5 + (ky / dt) * 0.5; cam.vpitch = cam.vpitch * 0.5 + (kp / dt) * 0.5;
					}
				} else if (ptrs.size === 2) {
					var od = drag.pd, ox = drag.pcx, oy = drag.pcy;
					pinchState();
					if (od > 0 && drag.pd > 0) { cam.dist = cam.goal = clamp(cam.dist * od / drag.pd, 1.6, cam.fit * 1.7); }
					panPx(drag.pcx - ox, drag.pcy - oy);
					drag.moved += 10;
				}
			}
			function onUp(e) {
				if (!ptrs.has(e.pointerId)) { return; }
				ptrs.delete(e.pointerId);
				try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
				lastInput = performance.now();
				if (ptrs.size === 0) {
					drag.active = false;
					canvas.classList.remove('gdm-grabbing');
					var touch = drag.type !== 'mouse';
					if (performance.now() - drag.lastT > 90) { cam.vyaw = cam.vpitch = 0; cam.vpan.set(0, 0, 0); }
					cam.vyaw = clamp(cam.vyaw, -6, 6); cam.vpitch = clamp(cam.vpitch, -4, 4);
					if (e.type === 'pointerup' && !drag.multi && drag.moved < (touch ? 12 : 6) && performance.now() - drag.t < 700) {
						cam.vyaw = cam.vpitch = 0; cam.vpan.set(0, 0, 0);
						var q = local(e); click(pick(q[0], q[1], touch));
					}
				} else if (ptrs.size === 1) {
					drag.mode = 'orbit'; drag.lastT = performance.now();
				}
			}
			function click(c) {
				var now = performance.now();
				if (c && lastClick.c === c && now - lastClick.t < 400) {
					lastClick.t = 0;
					setSelected(c); focusOn(c);
					return;
				}
				lastClick.c = c; lastClick.t = now;
				setSelected(c);
			}
			function onWheel(e) {
				e.preventDefault();
				var d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1), q = local(e);
				// A trackpad pinch arrives as ctrl+wheel with small deltas.
				zoomBy(Math.exp(clamp(d, -240, 240) * (e.ctrlKey ? 0.011 : 0.0016)), q[0], q[1]);
				touchInput();
			}
			function onKey(e) {
				var used = true, k = e.key;
				if ((e.shiftKey && k.indexOf('Arrow') === 0) || k === 'PageUp' || k === 'PageDown') {
					// Step the selection one sector at a time, so any cell (empty ones included) can be reached from the keyboard.
					var sp = parseCoord(selected || st.position || '');
					if (sp) {
						if (k === 'ArrowLeft') { sp[0]--; } else if (k === 'ArrowRight') { sp[0]++; } else if (k === 'ArrowUp') { sp[1]++; } else if (k === 'ArrowDown') { sp[1]--; } else if (k === 'PageUp') { sp[2]++; } else { sp[2]--; }
						if (inBounds(sp)) { setSelected(sp.join(',')); }
					}
				}
				else if (k === 'ArrowLeft') { cam.vyaw = -1.6; } else if (k === 'ArrowRight') { cam.vyaw = 1.6; }
				else if (k === 'ArrowUp') { cam.vpitch = 1.2; } else if (k === 'ArrowDown') { cam.vpitch = -1.2; }
				else if (k === '+' || k === '=') { zoomBy(0.8); } else if (k === '-' || k === '_') { zoomBy(1.25); }
				else if (k === 'Home' || k === '0') { overview(); }
				else if (k === 'Escape') { setSelected(null); }
				else { used = false; }
				if (used) { e.preventDefault(); lastInput = performance.now(); cam.touched = true; dirty = true; if (k.indexOf('Arrow') === 0 && !e.shiftKey) { tween = null; } }
			}
			function onLeave() { hoverPt = null; if (hover) { hover = null; canvas.classList.remove('gdm-hot'); dataDirty = true; dirty = true; } }

			on(canvas, 'pointerdown', onDown);
			on(canvas, 'pointermove', onMove);
			on(canvas, 'pointerup', onUp);
			on(canvas, 'pointercancel', onUp);
			on(canvas, 'pointerleave', onLeave);
			on(canvas, 'wheel', onWheel, { passive: false });
			on(canvas, 'keydown', onKey);
			on(canvas, 'contextmenu', function (e) { e.preventDefault(); });
			on(canvas, 'webglcontextlost', function (e) {
				e.preventDefault(); lost = true;
				showMsg('Map display interrupted', 'Restoring the 3D view…', 'gdm-lost');
				schedule();
			});
			on(canvas, 'webglcontextrestored', function () { lost = false; hideMsg(); dirty = true; dataDirty = true; schedule(); });

			/* --- camera moves --- */
			function focusOn(coord) {
				var p = parseCoord(coord);
				if (!p) { return; }
				var w = world(p), d = clamp(Math.min(cam.dist, Math.max(6.5, cam.fit * 0.36)), 4.5, cam.fit);
				lastInput = performance.now(); cam.touched = true;
				startTween({ target: new T.Vector3(w[0], w[1], w[2]), dist: d }, 1.1);
			}
			function overview() { lastInput = performance.now(); startTween({ target: new T.Vector3(0, 0, 0), dist: cam.fit }, 1.2); }

			/* --- frame --- */
			function resize() {
				var r = container.getBoundingClientRect(), w = Math.round(canvas.clientWidth || r.width), h = Math.round(canvas.clientHeight || r.height);
				if (w < 2 || h < 2) { W = H = 0; return; }
				var cap = (low ? 1.5 : 2) * (degraded ? 0.7 : 1);
				dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, cap));
				if (degraded > 1) { dpr = 1; }
				W = w; H = h;
				renderer.setPixelRatio(dpr);
				renderer.setSize(w, h, false);
				camera.aspect = w / h; camera.updateProjectionMatrix();
				uView.value.set(w, h); uPx.value = dpr;
				uScaleCss.value = h / (2 * tanF); uScale.value = uScaleCss.value * dpr;
				var f = fitDist();
				if (!cam.touched || Math.abs(cam.dist - cam.fit) < 1e-3) { cam.dist = cam.goal = f; }
				cam.fit = f;
				cam.goal = clamp(cam.goal, 1.6, f * 1.7);
				dirty = true;
			}

			function tick(dt) {
				frameNo++;
				// Jump travel between two setState positions.
				if (jump) {
					jump.t = Math.min(1, jump.t + dt / jump.dur);
					jump.k = ease(jump.t);
					ownW.set(jump.from[0] + (jump.to[0] - jump.from[0]) * jump.k, jump.from[1] + (jump.to[1] - jump.from[1]) * jump.k, jump.from[2] + (jump.to[2] - jump.from[2]) * jump.k);
					reachFade = jump.t < 0.2 ? 1 - jump.t / 0.2 : 0;
					if (jump.t >= 1) { trail.push(jump.to); while (trail.length > 6) { trail.shift(); } jump = null; flash = { k: 0 }; reachFade = 0; }
					dataDirty = true; dirty = true;
				} else if (reachFade < 1) { reachFade = Math.min(1, reachFade + dt * 1.6); dataDirty = true; dirty = true; }
				Object.keys(moves).forEach(function (id) {
					moves[id].t += dt / moves[id].dur;
					if (moves[id].t >= 1) { delete moves[id]; }
					dataDirty = true; dirty = true;
				});
				if (flash) { flash.k += dt * 1.3; if (flash.k >= 1) { flash = null; } dataDirty = true; dirty = true; }

				updateCamera(dt);

				if (hoverPt && !drag.active && frameNo % 2 === 0) {
					var hc = pick(hoverPt[0], hoverPt[1], false);
					if (hc !== hover) { hover = hc; canvas.classList.toggle('gdm-hot', !!hc); dataDirty = true; dirty = true; }
				}
				if (dataDirty) { buildDynamic(); dataDirty = false; dirty = true; }
				if (!reduced) { dirty = true; }
				if (!dirty || !W) { return false; }

				if (haveOwn && st.range > 0) {
					var rr = st.range / lyU, pulse = jump ? 0.25 : 0.25 + 0.75 * ease(reachFade);
					sphere.visible = true; sphere.position.copy(ownW); sphere.scale.setScalar(rr * (jump ? 1 : 0.86 + 0.14 * ease(reachFade)));
					sphMat.uniforms.uAlpha.value = pulse;
				} else { sphere.visible = false; }
				uTime.value = time;
				if (frameNo % 8 === 1) { updateLod(); }
				renderer.render(scene, camera);
				updateLabels(dt);
				updateEdge();
				dirty = false;
				return true;
			}

			function adapt(ms) {
				// Sustained slow frames: lower the resolution first, then the nebula density.
				if (opts.quality === 'high' || degraded >= 2 || performance.now() - startedAt < 2500) { return; }
				slowFor = ms > 42 ? slowFor + ms : Math.max(0, slowFor - ms * 2);
				if (slowFor > 2500) {
					slowFor = 0; degraded++; startedAt = performance.now();
					if (degraded === 2 && !low) { low = true; quality = 'low'; buildNebulae(); }
					resize();
				}
			}

			G.resize = resize;
			G.tick = tick;
			G.adapt = adapt;
			G.focus = focusOn;
			G.overview = overview;
			G.dataChanged = function () { dataDirty = true; dirty = true; schedule(); };
			G.mapChanged = function (sizeChanged) {
				if (sizeChanged) {
					buildFrame();
					cam.target.set(0, 0, 0); cam.fit = fitDist(); cam.dist = cam.goal = cam.fit; cam.touched = false;
					trail = []; jump = null;
					if (st.pos) { var w = world(st.pos); ownW.set(w[0], w[1], w[2]); trail = [w]; }
				}
				buildSectors(); buildNebulae(); buildReachCells();
				dataDirty = true; dirty = true; schedule();
			};
			G.stateChanged = function (prev) {
				if (st.pos && inBounds(st.pos)) {
					var w = world(st.pos);
					if (haveOwn && prev && prev !== st.position && !reduced) {
						var from = jump ? [ownW.x, ownW.y, ownW.z] : trail.length ? trail[trail.length - 1] : [ownW.x, ownW.y, ownW.z];
						if (jump) { trail.push(from); }
						var len = Math.hypot(w[0] - from[0], w[1] - from[1], w[2] - from[2]);
						jump = { from: from, to: w, t: 0, k: 0, dur: clamp(1.1 + len * 0.22, 1.3, 2.8) };
					} else {
						if (prev !== st.position) { trail.push(w); while (trail.length > 6) { trail.shift(); } }
						ownW.set(w[0], w[1], w[2]);
						jump = null;
					}
					haveOwn = true;
					uOwn.value.set(w[0], w[1], w[2]);
					uReach.value = st.range > 0 ? st.range / lyU : -1;
				} else { haveOwn = false; uReach.value = -1; jump = null; }
				buildReachCells();
				edge.lastChild.textContent = (st.me && st.me.ship) || 'Your ship';
				dataDirty = true; dirty = true; schedule();
			};
			G.fontsChanged = function () { pool.forEach(function (n) { n.html = null; }); infoRect = null; dirty = true; };
			G.motionChanged = function () { uTw.value = reduced ? 0 : 1; dirty = true; };
			G.coloursChanged = function () {
				uCols.dim.value.fromArray(css.dim); uCols.scan.value.fromArray(css.c3); uCols.visit.value.fromArray(css.text); uCols.warn.value.fromArray(css.warn); uCols.own.value.fromArray(css.c1);
			};
			G.stats = function () {
				return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, points: renderer.info.render.points, frame_ms: frameEma, cpu_ms: cpuEma, quality: quality, degraded: degraded, pixel_ratio: dpr, sectors: sec.count, nebula_sprites: neb.count, markers: marks.count, lines: lines.count, labels: pool.size, webgl2: !!renderer.capabilities.isWebGL2 };
			};
			G.view = function () { return { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, target: cam.target.toArray(), fit: cam.fit }; };
			G.screenOf = function (coord) { var p = parseCoord(coord); if (!p) { return null; } var w = world(p); project(w[0], w[1], w[2]); return P.vis ? [P.x, P.y] : null; };
			G.dispose = function () {
				pool.forEach(function (n) { n.el.remove(); }); pool.clear();
				[neb, sec, lines, marks].forEach(function (l) { l.dispose(); });
				bgGeo.dispose(); bg.material.dispose(); frame.geometry.dispose(); frame.material.dispose(); sphere.geometry.dispose(); sphMat.dispose(); puffTex.dispose();
				renderer.dispose();
			};

			on(btnMe, 'click', function () { if (st.position) { focusOn(st.position); schedule(); } });
			on(edge, 'click', function () { if (st.position) { focusOn(st.position); schedule(); } });
			on(btnAll, 'click', function () { overview(); schedule(); });

			buildFrame();
			buildNebulae();
			return G;
		}

		/* ----- loop ----- */
		function loop(now) {
			raf = 0;
			if (destroyed || !gfx || lost || !visible || document.hidden) { return; }
			var real = lastT ? now - lastT : 16.7, dt = Math.min(0.1, real / 1000);
			lastT = now;
			if (!reduced) { time += dt; }
			var t0 = performance.now();
			if (gfx.tick(dt)) {
				cpuEma += (performance.now() - t0 - cpuEma) * 0.1;
				frameEma += (real - frameEma) * 0.1;
				gfx.adapt(real);
			}
			raf = window.requestAnimationFrame(loop);
		}
		function schedule() {
			if (raf || destroyed || !gfx || lost || !visible || document.hidden) { return; }
			lastT = 0;
			raf = window.requestAnimationFrame(loop);
		}

		try { gfx = initGL(); } catch (e) { gfx = null; if (window.console) { console.warn('GDMap: 3D view unavailable', e); } }
		if (!gfx) {
			canvas.style.display = 'none'; ctl.style.display = 'none';
			showMsg('3D map unavailable', 'This browser or device cannot show WebGL graphics. Sector details still appear here when a sector is chosen elsewhere.');
		}

		var ro = null, io = null;
		if (gfx) {
			startedAt = performance.now();
			gfx.resize();
			if (window.ResizeObserver) { ro = new window.ResizeObserver(function () { if (!destroyed) { gfx.resize(); schedule(); } }); ro.observe(container); }
			else { on(window, 'resize', function () { gfx.resize(); schedule(); }); }
			if (window.IntersectionObserver) {
				io = new window.IntersectionObserver(function (es) { visible = es[es.length - 1].isIntersecting; if (visible) { startedAt = performance.now(); schedule(); } }, { threshold: 0 });
				io.observe(container);
			}
			on(document, 'visibilitychange', function () { if (!document.hidden) { startedAt = performance.now(); schedule(); } });
			if (mqReduce) {
				var mqFn = function () { reduced = mqReduce.matches; gfx.motionChanged(); schedule(); };
				if (mqReduce.addEventListener) { on(mqReduce, 'change', mqFn); } else if (mqReduce.addListener) { mqReduce.addListener(mqFn); }
			}
			if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
				document.fonts.ready.then(function () { if (!destroyed && gfx) { gfx.fontsChanged(); schedule(); } });
				if (document.fonts.addEventListener) { on(document.fonts, 'loadingdone', function () { if (gfx) { gfx.fontsChanged(); schedule(); } }); }
			}
			schedule();
		}
		renderInfo(null);

		/* ----- public API ----- */
		var api = {
			setMap: function (map) {
				if (destroyed || !map) { return; }
				var size = clamp(parseInt(map.size, 10) || 12, 2, 64), sizeChanged = !haveMap || size !== N;
				N = size; half = (N - 1) / 2; lyU = +map.ly_per_unit > 0 ? +map.ly_per_unit : 5;
				factions = map.factions && typeof map.factions === 'object' ? map.factions : {};
				sectors = new Map(); sectorList = [];
				(map.sectors || []).forEach(function (row) {
					var p = row && parseCoord(row.c);
					if (!p || !inBounds(p)) { return; }
					var s = { c: p.join(','), x: p[0], y: p[1], z: p[2], w: world(p), s: row.s === 2 ? 2 : row.s === 1 ? 1 : 0, t: TYPE[row.t] != null ? row.t : 'star_system', k: row.k || null, f: row.f || null, p: row.p || null, d: row.d || null };
					if (!sectors.has(s.c)) { sectorList.push(s); }
					sectors.set(s.c, s);
				});
				haveMap = true;
				readColours();
				if (st.position) { st.pos = parseCoord(st.position); if (!inBounds(st.pos)) { st.pos = null; } }
				if (selected && !inBounds(parseCoord(selected))) { selected = null; }
				if (gfx) { gfx.coloursChanged(); gfx.mapChanged(sizeChanged); if (sizeChanged) { gfx.stateChanged(st.position); } }
				refreshDetail(false);
			},
			setState: function (state) {
				if (destroyed || !state) { return; }
				var prev = st.position, p = parseCoord(state.position);
				if (p && haveMap && !inBounds(p)) { p = null; }
				// A captain whose position has changed since the last state travels there instead of jumping.
				var was = {};
				st.captains.forEach(function (c) { if (c && !c.me) { was[c.id] = c.position; } });
				(Array.isArray(state.captains) ? state.captains : []).forEach(function (c) {
					if (!c || c.me || !was[c.id] || was[c.id] === c.position || !haveMap || reduced) { return; }
					var a = parseCoord(was[c.id]), b = parseCoord(c.position);
					if (!a || !b || !inBounds(a) || !inBounds(b)) { return; }
					var from = moves[c.id] ? (function (m, k) { return [m.from[0] + (m.to[0] - m.from[0]) * k, m.from[1] + (m.to[1] - m.from[1]) * k, m.from[2] + (m.to[2] - m.from[2]) * k]; })(moves[c.id], ease(moves[c.id].t)) : world(a);
					var to = world(b), len = Math.sqrt(Math.pow(to[0] - from[0], 2) + Math.pow(to[1] - from[1], 2) + Math.pow(to[2] - from[2], 2));
					moves[c.id] = { from: from, to: to, t: 0, dur: Math.max(1.3, Math.min(2.8, 1.1 + len * 0.22)) };
				});
				st = {
					position: p ? p.join(',') : null, pos: p, range: Math.max(0, +state.range_ly || 0), me: state.me || {},
					captains: Array.isArray(state.captains) ? state.captains : [], missions: Array.isArray(state.missions) ? state.missions : []
				};
				if (gfx) { gfx.stateChanged(prev); }
				refreshDetail(false);
			},
			select: function (coord) { if (!destroyed) { setSelected(coord == null ? null : String(coord)); } },
			focus: function (coord) { if (!destroyed && gfx && parseCoord(coord)) { gfx.focus(coord); schedule(); } },
			resize: function () { if (!destroyed && gfx) { gfx.resize(); schedule(); } },
			getSelected: function () { return selected; },
			destroy: function () {
				if (destroyed) { return; }
				destroyed = true;
				if (raf) { window.cancelAnimationFrame(raf); raf = 0; }
				if (ro) { ro.disconnect(); }
				if (io) { io.disconnect(); }
				listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
				listeners = [];
				if (gfx) { try { gfx.dispose(); } catch (e) { /* context already gone */ } gfx = null; }
				made.forEach(function (e) { if (e.parentNode) { e.parentNode.removeChild(e); } });
				if (!ownInfo) { info.innerHTML = ''; }
			},
			/* Diagnostics, not part of the contract: draw calls, frame time, quality tier, camera. */
			stats: function () { return gfx ? gfx.stats() : { webgl: false }; },
			view: function () { return gfx ? gfx.view() : null; },
			screenOf: function (coord) { return gfx ? gfx.screenOf(coord) : null; }
		};
		return api;
	}

	window.GDMap = { create: create };
}());
