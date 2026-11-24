/*
 * RealismMinimap.ts
 * -----------------
 * GTA 6 style minimap (bottom left) and the full-screen map (M).
 *
 * Minimap
 *  - Rounded-rectangle frame, dark stylised map: land / water, roads by class, faint building
 *    footprints, greener parks and grass. Rotates with the camera heading; the player arrow stays in
 *    the lower middle, 'N' rides the rim. Zooms out with vehicle speed.
 *  - Blips (C8, RealismGPS): icons, short-range ones only nearby, long-range ones clamp to the rim
 *    when off the map; the waypoint blip always shows; the GPS route is drawn along the roads (dashed
 *    where it leaves the road).
 *  - Cost: the county is pre-rendered once into a 1024 x 1024 base image (0.5 px per metre); when
 *    zoomed in, 256 m tiles at hud.minimapDetail px per metre (default 2) are rendered lazily (at most
 *    one per frame, LRU of hud.maxTiles) on top. Each redraw (hud.minimapFps, default 24 Hz) is a
 *    handful of drawImage calls into a small canvas (200 x 140 CSS px, devicePixelRatio capped at 2),
 *    a route path and the blip sprites (pre-rendered once). No allocations per frame.
 *
 * Full-screen map (M, or the pause menu's Map button)
 *  - Calls realismSetUIBlocking('bigMap', true) before releasing the mouse; Esc / M closes it and
 *    grabs the mouse again if it was grabbed. Drag to pan, wheel / + - to zoom, click to set a
 *    waypoint (on a blip: go there, on the waypoint: clear it), right click clears it.
 *
 * (world as any).realismMinimap = { openBigMap(), closeBigMap(), toggleBigMap(), bigMapOpen, stats }
 */

import * as THREE from 'three';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { HALF, CELL, VERTS } from './RealismMapData';
import { RealismGPS, HudSettings, PlayerState, newPlayerState, readPlayer, Blip } from './RealismGPS';

const BASE_PPM = 0.5;           // base image pixels per metre
const TILE = 256;               // metres per detail tile
const SEA = '#16303f';

const ROAD_DRAW: { [k: string]: { c: string; w: number; min: number; casing: boolean } } = {
	highway: { c: '#e2e6ea', w: 0.85, min: 2.2, casing: true },
	avenue: { c: '#b9c1ca', w: 0.85, min: 1.8, casing: true },
	street: { c: '#8f99a4', w: 0.8, min: 1.3, casing: false },
	rural: { c: '#857f72', w: 0.75, min: 1.2, casing: false },
	apron: { c: '#4c555e', w: 1, min: 1, casing: false },
	taxiway: { c: '#5a636c', w: 0.9, min: 1, casing: false },
	runway: { c: '#66707a', w: 0.95, min: 1.5, casing: false },
};
const ROAD_ORDER = ['apron', 'taxiway', 'runway', 'rural', 'street', 'avenue', 'highway'];

/** Blip looks: background colour and glyph. */
export const BLIP_STYLE: { [icon: string]: { bg: string; g: string } } = {
	house: { bg: '#3fa34d', g: '\u2302' },
	property: { bg: '#e8e8e8', g: '\u2302' },
	hotel: { bg: '#8e44ad', g: 'H' },
	bank: { bg: '#27ae60', g: '$' },
	job: { bg: '#f1c40f', g: '!' },
	shop: { bg: '#e67e22', g: '24' },
	club: { bg: '#e84393', g: '\u266B' },
	hideout: { bg: '#636e72', g: '\u25C6' },
	dealer: { bg: '#2980b9', g: 'car' },
	modshop: { bg: '#d35400', g: 'wrench' },
	police: { bg: '#2f6fe4', g: '\u2605' },
	sheriff: { bg: '#c9a227', g: '\u2605' },
	hospital: { bg: '#e74c3c', g: '+' },
	construction: { bg: '#f39c12', g: '\u2692' },
	warehouse: { bg: '#7f8c8d', g: 'W' },
	fence: { bg: '#2d3436', g: '$' },
	buyer: { bg: '#16a085', g: '$' },
	car: { bg: '#3498db', g: 'car' },
	waypoint: { bg: '#c45cff', g: 'wp' },
	north: { bg: 'rgba(12,14,18,0.85)', g: 'N' },
};

const spriteCache: { [key: string]: HTMLCanvasElement } = {};

/** A pre-rendered blip icon (cached). radius in device pixels. */
export function blipSprite(icon: string, color: string, radius: number): HTMLCanvasElement
{
	const st = BLIP_STYLE[icon] || BLIP_STYLE.job;
	const bg = color || st.bg;
	const r = Math.max(4, Math.round(radius));
	const key = icon + '|' + bg + '|' + r;
	const have = spriteCache[key];
	if (have !== undefined) return have;
	let c: HTMLCanvasElement = null;
	try
	{
		c = document.createElement('canvas');
		const pad = 2;
		c.width = c.height = (r + pad) * 2;
		const g = c.getContext('2d');
		if (g)
		{
			const m = r + pad;
			if (st.g === 'wp')
			{
				// waypoint: map pin
				g.fillStyle = bg; g.strokeStyle = '#ffffff'; g.lineWidth = Math.max(1.2, r * 0.16);
				g.beginPath();
				g.arc(m, m - r * 0.25, r * 0.72, Math.PI * 0.85, Math.PI * 2.15);
				g.lineTo(m, m + r * 0.95);
				g.closePath();
				g.fill(); g.stroke();
				g.fillStyle = '#ffffff';
				g.beginPath(); g.arc(m, m - r * 0.25, r * 0.26, 0, Math.PI * 2); g.fill();
			}
			else
			{
				g.fillStyle = 'rgba(0,0,0,0.55)';
				g.beginPath(); g.arc(m, m + 0.8, r, 0, Math.PI * 2); g.fill();
				g.fillStyle = bg;
				g.beginPath(); g.arc(m, m, r - 0.5, 0, Math.PI * 2); g.fill();
				g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = Math.max(1, r * 0.12);
				g.stroke();
				const fg = icon === 'property' ? '#1d2229' : '#ffffff';
				g.fillStyle = fg; g.strokeStyle = fg;
				if (st.g === 'car')
				{
					const w = r * 1.1, h = r * 0.5;
					g.fillRect(m - w / 2, m - h * 0.3, w, h * 0.75);
					g.fillRect(m - w * 0.3, m - h * 0.8, w * 0.6, h * 0.6);
					g.fillStyle = bg;
					g.beginPath(); g.arc(m - w * 0.28, m + h * 0.48, h * 0.26, 0, Math.PI * 2); g.arc(m + w * 0.28, m + h * 0.48, h * 0.26, 0, Math.PI * 2); g.fill();
				}
				else if (st.g === 'wrench')
				{
					g.lineWidth = r * 0.26; g.lineCap = 'round';
					g.beginPath(); g.moveTo(m - r * 0.45, m + r * 0.45); g.lineTo(m + r * 0.2, m - r * 0.2); g.stroke();
					g.beginPath(); g.arc(m + r * 0.28, m - r * 0.28, r * 0.28, 0, Math.PI * 2); g.lineWidth = r * 0.16; g.stroke();
				}
				else
				{
					const text = st.g;
					const fs = text.length > 1 ? r * 0.95 : r * 1.25;
					g.font = 'bold ' + Math.round(fs) + 'px Arial, sans-serif';
					g.textAlign = 'center';
					g.textBaseline = 'middle';
					g.fillText(text, m, m + fs * 0.06);
				}
			}
		}
	}
	catch (e) { c = null; }
	spriteCache[key] = c;
	return c;
}

interface Tile { key: number; tx: number; tz: number; canvas: HTMLCanvasElement; used: number; }

/** Renders the county map into canvases: the base image and the detail tiles. */
export class MapRenderer
{
	public base: HTMLCanvasElement = null;
	public tiles: { [key: number]: Tile } = {};
	public tileCount = 0;
	public stats = { tilesRendered: 0, baseMs: 0, tileMs: 0 };
	private data: any;
	private detail: number;
	private maxTiles: number;
	private roadBox: number[] = [];       // per road: minx, minz, maxx, maxz
	private frame = 0;
	private budget = 0;

	constructor(data: any, detail: number, maxTiles: number)
	{
		this.data = data;
		this.detail = detail;
		this.maxTiles = maxTiles;
		const roads = data.roads;
		for (let r = 0; r < roads.length; r++)
		{
			let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
			const P = roads[r].pts || [];
			for (let i = 0; i < P.length; i++) { a = Math.min(a, P[i].x); b = Math.min(b, P[i].z); c = Math.max(c, P[i].x); d = Math.max(d, P[i].z); }
			const m = roads[r].width;
			this.roadBox.push(a - m, b - m, c + m, d + m);
		}
	}

	public get detailPPM(): number { return this.detail; }

	/** Allows `n` tile renders until the next call (one frame). */
	public newFrame(n: number): void { this.frame++; this.budget = n; }

	public ensureBase(): HTMLCanvasElement
	{
		if (this.base !== null) return this.base;
		const t0 = now();
		const size = Math.round(HALF * 2 * BASE_PPM);
		const c = makeCanvas(size, size);
		if (c === null) return null;
		const g = c.getContext('2d');
		if (!g) return null;
		this.drawArea(g, -HALF, -HALF, HALF * 2, BASE_PPM);
		this.base = c;
		this.stats.baseMs = now() - t0;
		return c;
	}

	/** Detail tile covering tile column / row, or null while not rendered yet (within this frame's budget it is rendered now). */
	public tile(tx: number, tz: number): HTMLCanvasElement
	{
		const key = tx * 64 + tz;
		const t = this.tiles[key];
		if (t !== undefined) { t.used = this.frame; return t.canvas; }
		if (this.budget <= 0) return null;
		this.budget--;
		const t0 = now();
		const px = Math.round(TILE * this.detail);
		// reuse the least recently used tile's canvas when the cache is full
		let canvas: HTMLCanvasElement = null;
		if (this.tileCount >= this.maxTiles)
		{
			let oldK = -1, oldU = 1e18;
			for (const k in this.tiles) if (this.tiles.hasOwnProperty(k) && this.tiles[k].used < oldU) { oldU = this.tiles[k].used; oldK = +k; }
			if (oldK >= 0 && oldU < this.frame) { canvas = this.tiles[oldK].canvas; delete this.tiles[oldK]; this.tileCount--; }
			else return null;
		}
		if (canvas === null) canvas = makeCanvas(px, px);
		if (canvas === null) return null;
		const g = canvas.getContext('2d');
		if (!g) return null;
		g.setTransform(1, 0, 0, 1, 0, 0);
		g.clearRect(0, 0, px, px);
		this.drawArea(g, -HALF + tx * TILE, -HALF + tz * TILE, TILE, this.detail);
		this.tiles[key] = { key: key, tx: tx, tz: tz, canvas: canvas, used: this.frame };
		this.tileCount++;
		this.stats.tilesRendered++;
		this.stats.tileMs = now() - t0;
		return canvas;
	}

	/** Draws the stylised map of the square (x0, z0, size m) at ppm pixels per metre at the canvas origin. */
	private drawArea(g: CanvasRenderingContext2D, x0: number, z0: number, size: number, ppm: number): void
	{
		const data = this.data;
		const px = Math.round(size * ppm);
		// land / water from the height + colour samples (one per 4 m cell, scaled up smoothly)
		const n = Math.max(2, Math.round(size / CELL));
		const small = makeCanvas(n, n);
		const sg = small ? small.getContext('2d') : null;
		if (sg && sg.createImageData)
		{
			const img = sg.createImageData(n, n);
			const H = data.heights, C = data.colors;
			const lake = data.lake;
			for (let j = 0; j < n; j++)
				for (let i = 0; i < n; i++)
				{
					const x = x0 + (i + 0.5) * size / n, z = z0 + (j + 0.5) * size / n;
					const gx = Math.max(0, Math.min(VERTS - 1, Math.round((x + HALF) / CELL)));
					const gz = Math.max(0, Math.min(VERTS - 1, Math.round((z + HALF) / CELL)));
					const h = H ? H[gz * VERTS + gx] : data.heightAt(x, z);
					const o = (j * n + i) * 4;
					let inLake = false;
					if (lake) { const lx = (x - lake.x) / (lake.rx * 1.12), lz = (z - lake.z) / (lake.rz * 1.12); inLake = lx * lx + lz * lz < 1; }
					if (h < 0.25 || inLake)
					{
						const deep = Math.min(1, Math.max(0, -h / 25));
						img.data[o] = 30 - deep * 8; img.data[o + 1] = 62 - deep * 12; img.data[o + 2] = 84 - deep * 10;
					}
					else
					{
						const ci = (gz * VERTS + gx) * 3;
						const r = C ? C[ci] : 0.3, gg = C ? C[ci + 1] : 0.4, b = C ? C[ci + 2] : 0.3;
						const green = Math.max(0, gg - (r + b) / 2);
						const lum = (r + gg + b) / 3;
						const alt = Math.min(1, h / 140);
						let R = 36 + lum * 26 + alt * 16, G = 44 + lum * 26 + alt * 14, B = 52 + lum * 22 + alt * 14;
						// grass / parks: a muted green; sand: a muted tan
						const k = Math.min(1, green * 9);
						R += (-8) * k; G += 16 * k; B += (-12) * k;
						if (r > 0.55 && gg > 0.48 && b < 0.45) { R += 14; G += 9; }
						img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B;
					}
					img.data[o + 3] = 255;
				}
			sg.putImageData(img, 0, 0);
			g.imageSmoothingEnabled = true;
			g.drawImage(small, 0, 0, px, px);
		}
		else
		{
			g.fillStyle = '#2b343e';
			g.fillRect(0, 0, px, px);
		}
		const X = (x: number) => (x - x0) * ppm, Z = (z: number) => (z - z0) * ppm;
		const x1 = x0 + size, z1 = z0 + size;
		// buildings (faint footprints)
		const bs = data.buildings || [];
		g.fillStyle = ppm >= 1 ? 'rgba(92,104,118,0.55)' : 'rgba(92,104,118,0.45)';
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.kind === 'prop' || b.h < 2) continue;
			const r = (b.w + b.d) * 0.75;
			if (b.x + r < x0 || b.x - r > x1 || b.z + r < z0 || b.z - r > z1) continue;
			const c = Math.cos(b.rot), s = Math.sin(b.rot);
			const hw = b.w / 2, hd = b.d / 2;
			// local (lx, lz) -> world: x = b.x + lx c + lz s, z = b.z - lx s + lz c
			g.beginPath();
			g.moveTo(X(b.x - hw * c - hd * s), Z(b.z + hw * s - hd * c));
			g.lineTo(X(b.x + hw * c - hd * s), Z(b.z - hw * s - hd * c));
			g.lineTo(X(b.x + hw * c + hd * s), Z(b.z - hw * s + hd * c));
			g.lineTo(X(b.x - hw * c + hd * s), Z(b.z + hw * s + hd * c));
			g.closePath();
			g.fill();
		}
		// roads by class (casing first for the big ones)
		const roads = data.roads;
		g.lineCap = 'round';
		g.lineJoin = 'round';
		for (let pass = 0; pass < 2; pass++)
		{
			for (let o = 0; o < ROAD_ORDER.length; o++)
			{
				const kind = ROAD_ORDER[o];
				const st = ROAD_DRAW[kind];
				if (pass === 0 && !st.casing) continue;
				for (let r = 0; r < roads.length; r++)
				{
					const road = roads[r];
					if (road.kind !== kind || !road.pts || road.pts.length < 2) continue;
					const bb = this.roadBox;
					if (bb[r * 4 + 2] < x0 || bb[r * 4] > x1 || bb[r * 4 + 3] < z0 || bb[r * 4 + 1] > z1) continue;
					const w = Math.max(st.min * Math.min(1.6, Math.max(0.6, ppm)), road.width * st.w * ppm);
					g.lineWidth = pass === 0 ? w + Math.max(1.2, ppm * 1.4) : w;
					g.strokeStyle = pass === 0 ? 'rgba(8,10,14,0.55)' : st.c;
					g.beginPath();
					const P = road.pts;
					g.moveTo(X(P[0].x), Z(P[0].z));
					for (let i = 1; i < P.length; i++) g.lineTo(X(P[i].x), Z(P[i].z));
					g.stroke();
				}
			}
		}
	}
}

/** Draws the GPS route (world coordinates; the caller has set the transform). */
export function strokeRoute(g: CanvasRenderingContext2D, gps: RealismGPS, from: number, pxPerUnit: number, widthPx: number, color: string, dash: number[]): void
{
	const n = gps.rn;
	if (n < 2) return;
	const a = Math.max(0, Math.min(from, n - 2));
	const rs = gps.roadStart, re = gps.roadEnd;
	const w = widthPx / pxPerUnit;
	// road part
	if (re > rs)
	{
		g.beginPath();
		g.moveTo(gps.rx[Math.max(a, rs)], gps.rz[Math.max(a, rs)]);
		for (let i = Math.max(a, rs) + 1; i <= re; i++) g.lineTo(gps.rx[i], gps.rz[i]);
		g.lineWidth = w * 1.7;
		g.strokeStyle = 'rgba(10,6,20,0.65)';
		g.stroke();
		g.lineWidth = w;
		g.strokeStyle = color;
		g.stroke();
	}
	// off-road parts: dashed
	dash[0] = 3.2 * w; dash[1] = 2.2 * w;
	g.lineWidth = w * 0.75;
	g.strokeStyle = color;
	if (g.setLineDash) g.setLineDash(dash);
	g.beginPath();
	let any = false;
	if (rs > 0 && a < rs) { g.moveTo(gps.rx[a], gps.rz[a]); for (let i = a + 1; i <= rs; i++) g.lineTo(gps.rx[i], gps.rz[i]); any = true; }
	if (re < n - 1) { g.moveTo(gps.rx[re], gps.rz[re]); for (let i = re + 1; i < n; i++) g.lineTo(gps.rx[i], gps.rz[i]); any = true; }
	if (any) g.stroke();
	if (g.setLineDash) { dash[0] = 0; dash[1] = 0; g.setLineDash(EMPTY_DASH); }
}
const EMPTY_DASH: number[] = [];

export class RealismMinimap implements IUpdatable
{
	public updateOrder = 45;
	public ctx: RealismCtx;
	public world: any;
	public gps: RealismGPS;
	public settings: HudSettings;
	public map: MapRenderer;
	public bigMapOpen = false;
	public stats = { draws: 0, bigDraws: 0, lastDrawMs: 0, avgDrawMs: 0, blipsDrawn: 0, clamped: 0, tilesDrawn: 0 };
	/** Current view (for tests): metres per CSS pixel and rotation (radians). */
	public mpp = 0.85;
	public rotation = 0;
	private frame: HTMLElement = null;
	private canvas: HTMLCanvasElement = null;
	private g: CanvasRenderingContext2D = null;
	private W = 0; private H = 0; private dpr = 1;
	private acc = 0;
	private visible = false;
	private ps: PlayerState = newPlayerState();
	private camDir = new THREE.Vector3();
	private dash: number[] = [0, 0];
	private clampOut = { x: 0, y: 0, clamped: false };
	// big map
	private big: HTMLElement = null;
	private bigCanvas: HTMLCanvasElement = null;
	private bigG: CanvasRenderingContext2D = null;
	private bigInfo: HTMLElement = null;
	private bigW = 0; private bigH = 0; private bigDpr = 1;
	public view = { x: 0, z: 0, ppm: 0.6 };   // big map centre and CSS pixels per metre
	private bigAcc = 0;
	private bigDirty = true;
	private wasLocked = false;
	private drag = { down: false, x: 0, y: 0, sx: 0, sy: 0, moved: false, vx: 0, vz: 0 };
	private keyHandler: (e: KeyboardEvent) => void = null;

	constructor(ctx: RealismCtx, gps: RealismGPS, settings: HudSettings)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		this.gps = gps;
		this.settings = settings;
		this.map = new MapRenderer(ctx.data, settings.minimapDetail, settings.maxTiles);
		if (settings.minimap) this.buildDom();
		if (settings.bigMap) this.bindKeys();
		const self = this;
		this.world.realismMinimap = {
			openBigMap(relock?: boolean): boolean { return self.openBigMap(relock); },
			closeBigMap(): void { self.closeBigMap(); },
			toggleBigMap(): void { if (self.bigMapOpen) self.closeBigMap(); else self.openBigMap(); },
			get bigMapOpen(): boolean { return self.bigMapOpen; },
			stats: this.stats,
			system: this,
		};
	}

	// ------------------------------------------------------------------ DOM

	private buildDom(): void
	{
		try
		{
			if (typeof document === 'undefined' || !document.body || !document.createElement) return;
			const s = this.settings;
			const frame = document.createElement('div');
			frame.id = 'rr-minimap';
			frame.className = 'rr-minimap';
			frame.style.width = s.minimapWidth + 'px';
			frame.style.height = s.minimapHeight + 'px';
			if (s.minimapTilt > 0) frame.style.transform = 'perspective(520px) rotateX(' + Math.min(40, s.minimapTilt) + 'deg)';
			const dpr = Math.min(2, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
			const c = document.createElement('canvas');
			c.className = 'rr-minimap-canvas';
			c.width = Math.round(s.minimapWidth * dpr);
			c.height = Math.round(s.minimapHeight * dpr);
			frame.appendChild(c);
			frame.style.display = 'none';
			document.body.appendChild(frame);
			this.frame = frame;
			this.canvas = c;
			this.g = c.getContext('2d');
			this.W = c.width; this.H = c.height; this.dpr = dpr;
		}
		catch (e) { this.frame = null; this.g = null; }
	}

	private show(on: boolean): void
	{
		if (on === this.visible || this.frame === null) return;
		this.visible = on;
		this.frame.style.display = on ? '' : 'none';
	}

	// ------------------------------------------------------------------ frame

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		const w = this.world;
		const dt = Math.min(0.2, unscaledTimeStep || timeStep || 0.016);
		if (this.bigMapOpen)
		{
			this.show(false);
			// a pointer-lock request still in flight (e.g. Resume from the pause menu) must not grab the mouse
			try { if (typeof document !== 'undefined' && document.pointerLockElement && document.exitPointerLock) document.exitPointerLock(); } catch (e) { /* ignore */ }
			this.bigAcc += dt;
			if (this.bigDirty || this.bigAcc > 0.16) this.drawBig();
			return;
		}
		const on = this.g !== null && !w.realismPaused && this.settings.minimap;
		this.show(on);
		if (!on) return;
		this.acc += dt;
		if (this.acc < 1 / this.settings.minimapFps) return;
		const step = this.acc;
		this.acc = 0;
		this.draw(step);
	}

	/** One minimap redraw. */
	public draw(step: number = 0.04): void
	{
		const g = this.g;
		if (!g) return;
		const t0 = now();
		const ps = readPlayer(this.world, this.ps);
		const p = ps.pos;
		// zoom: further out the faster the car goes
		const z = this.settings.minimapZoom;
		const target = (ps.kind === 'vehicle' ? 1.05 + Math.min(ps.speed, 40) * 0.042 : (ps.kind === 'cam' ? 1.3 : 0.8)) * z;
		const k = Math.min(1, step * 2.5);
		this.mpp += (target - this.mpp) * k;
		// heading: camera forward points up
		const cam = this.world.camera;
		let fx = ps.fx, fz = ps.fz;
		if (cam && cam.getWorldDirection)
		{
			cam.getWorldDirection(this.camDir);
			const l = Math.sqrt(this.camDir.x * this.camDir.x + this.camDir.z * this.camDir.z);
			if (l > 0.05) { fx = this.camDir.x / l; fz = this.camDir.z / l; }
		}
		const th = -Math.PI / 2 - Math.atan2(fz, fx);
		this.rotation = th;
		const cs = Math.cos(th), sn = Math.sin(th);
		const W = this.W, H = this.H, dpr = this.dpr;
		const s = dpr / this.mpp;            // device px per metre
		const cx = W / 2, cy = H * 0.6;
		g.setTransform(1, 0, 0, 1, 0, 0);
		g.globalAlpha = 1;
		g.fillStyle = SEA;
		g.fillRect(0, 0, W, H);
		// world -> canvas
		const e = cx - s * (cs * p.x - sn * p.z), f = cy - s * (sn * p.x + cs * p.z);
		g.setTransform(cs * s, sn * s, -sn * s, cs * s, e, f);
		const R = Math.sqrt(Math.max(cx, W - cx) * Math.max(cx, W - cx) + Math.max(cy, H - cy) * Math.max(cy, H - cy)) / s + 4;
		this.drawMapArea(g, p.x - R, p.z - R, p.x + R, p.z + R, s);
		// route
		if (this.gps.rn >= 2) strokeRoute(g, this.gps, this.gps.progressIdx, s, 4.2 * dpr, this.settings.routeColor, this.dash);
		// blips (screen space)
		g.setTransform(1, 0, 0, 1, 0, 0);
		const m = 9 * dpr, rr = 16 * dpr;
		const br = 7 * dpr;
		const list = this.gps.blipList;
		const sr = this.settings.shortRange;
		let drawn = 0, clamped = 0;
		for (let i = 0; i < list.length; i++)
		{
			const b = list[i];
			const dx = b.x - p.x, dz = b.z - p.z;
			if (b.shortRange && dx * dx + dz * dz > sr * sr) continue;
			const sx = cx + (cs * dx - sn * dz) * s, sy = cy + (sn * dx + cs * dz) * s;
			const c = this.clampRim(sx, sy, cx, cy, W, H, m, rr);
			if (c.clamped && b.shortRange) continue;
			const spr = blipSprite(b.icon, b.color, br * (c.clamped ? 0.85 : 1));
			if (spr) { g.globalAlpha = c.clamped ? 0.85 : 1; g.drawImage(spr, c.x - spr.width / 2, c.y - spr.height / 2); }
			drawn++;
			if (c.clamped) clamped++;
		}
		g.globalAlpha = 1;
		// waypoint
		const wp = this.gps.waypoint;
		if (wp)
		{
			const dx = wp.x - p.x, dz = wp.z - p.z;
			const c = this.clampRim(cx + (cs * dx - sn * dz) * s, cy + (sn * dx + cs * dz) * s, cx, cy, W, H, m, rr);
			const spr = blipSprite('waypoint', this.settings.waypointColor, 9 * dpr);
			if (spr) g.drawImage(spr, c.x - spr.width / 2, c.y - spr.height / 2 - (c.clamped ? 0 : 5 * dpr));
			drawn++;
			if (c.clamped) clamped++;
		}
		// player arrow (facing relative to the map rotation)
		const ax = cs * ps.fx - sn * ps.fz, ay = sn * ps.fx + cs * ps.fz;
		this.arrow(g, cx, cy, Math.atan2(ay, ax), 8 * dpr);
		// north on the rim
		{
			const nx = cx + sn * 4000, ny = cy - cs * 4000;
			const c = this.clampRim(nx, ny, cx, cy, W, H, m - 1 * dpr, rr);
			const spr = blipSprite('north', '', 7 * dpr);
			if (spr) g.drawImage(spr, c.x - spr.width / 2, c.y - spr.height / 2);
		}
		this.stats.blipsDrawn = drawn;
		this.stats.clamped = clamped;
		this.stats.draws++;
		const ms = now() - t0;
		this.stats.lastDrawMs = ms;
		this.stats.avgDrawMs = this.stats.avgDrawMs * 0.95 + ms * 0.05;
	}

	/** Base image + detail tiles for the world rectangle (canvas transform already set to world units). */
	private drawMapArea(g: CanvasRenderingContext2D, x0: number, z0: number, x1: number, z1: number, devPxPerM: number): void
	{
		const map = this.map;
		const base = map.ensureBase();
		if (base)
		{
			const ax = Math.max(-HALF, x0), az = Math.max(-HALF, z0), bx = Math.min(HALF, x1), bz = Math.min(HALF, z1);
			if (bx > ax && bz > az)
				g.drawImage(base, (ax + HALF) * BASE_PPM, (az + HALF) * BASE_PPM, (bx - ax) * BASE_PPM, (bz - az) * BASE_PPM, ax, az, bx - ax, bz - az);
		}
		let tiles = 0;
		if (devPxPerM > BASE_PPM * 1.5)
		{
			map.newFrame(1);
			const t0x = Math.max(0, Math.floor((x0 + HALF) / TILE)), t1x = Math.min(HALF * 2 / TILE - 1, Math.floor((x1 + HALF) / TILE));
			const t0z = Math.max(0, Math.floor((z0 + HALF) / TILE)), t1z = Math.min(HALF * 2 / TILE - 1, Math.floor((z1 + HALF) / TILE));
			for (let tx = t0x; tx <= t1x; tx++)
				for (let tz = t0z; tz <= t1z; tz++)
				{
					const c = map.tile(tx, tz);
					if (!c) continue;
					g.drawImage(c, -HALF + tx * TILE, -HALF + tz * TILE, TILE, TILE);
					tiles++;
				}
		}
		this.stats.tilesDrawn = tiles;
	}

	/** Keeps a screen point inside the rounded frame (margin m, corner radius rr). */
	private clampRim(x: number, y: number, cx: number, cy: number, W: number, H: number, m: number, rr: number): { x: number; y: number; clamped: boolean }
	{
		const o = this.clampOut;
		let vx = x - cx, vy = y - cy;
		let k = 1;
		if (vx > 0) k = Math.min(k, (W - m - cx) / vx); else if (vx < 0) k = Math.min(k, (m - cx) / vx);
		if (vy > 0) k = Math.min(k, (H - m - cy) / vy); else if (vy < 0) k = Math.min(k, (m - cy) / vy);
		o.clamped = k < 1;
		let px = cx + vx * k, py = cy + vy * k;
		// rounded corners
		const r = Math.max(0, rr - m * 0.5);
		const qx = Math.min(Math.max(px, m + r), W - m - r), qy = Math.min(Math.max(py, m + r), H - m - r);
		const dx = px - qx, dy = py - qy;
		const d = Math.sqrt(dx * dx + dy * dy);
		if (d > r && d > 0) { px = qx + dx / d * r; py = qy + dy / d * r; o.clamped = true; }
		o.x = px; o.y = py;
		return o;
	}

	private arrow(g: CanvasRenderingContext2D, x: number, y: number, ang: number, size: number): void
	{
		const c = Math.cos(ang), s = Math.sin(ang);
		g.setTransform(c, s, -s, c, x, y);
		g.beginPath();
		g.moveTo(size * 1.15, 0);
		g.lineTo(-size * 0.8, -size * 0.75);
		g.lineTo(-size * 0.35, 0);
		g.lineTo(-size * 0.8, size * 0.75);
		g.closePath();
		g.lineWidth = Math.max(1.5, size * 0.28);
		g.strokeStyle = 'rgba(8,10,14,0.85)';
		g.stroke();
		g.fillStyle = '#ffffff';
		g.fill();
		g.setTransform(1, 0, 0, 1, 0, 0);
	}

	// ------------------------------------------------------------------ big map

	private bindKeys(): void
	{
		if (typeof window === 'undefined' || !window.addEventListener) return;
		this.keyHandler = (e: KeyboardEvent) => this.onKey(e);
		window.addEventListener('keydown', this.keyHandler, true);
	}

	/** Keyboard (window, capture). Public for tests. */
	public onKey(e: KeyboardEvent): void
	{
		const t: any = e.target;
		if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
		const stop = () => { try { e.preventDefault(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); else e.stopPropagation(); } catch (x) { /* ignore */ } };
		if (this.bigMapOpen)
		{
			if (e.code === 'Escape' || (e.code === 'KeyM' && !e.repeat)) { stop(); this.closeBigMap(); return; }
			if (e.code === 'Equal' || e.code === 'NumpadAdd') { stop(); this.zoomBig(1.4, -1, -1); return; }
			if (e.code === 'Minus' || e.code === 'NumpadSubtract') { stop(); this.zoomBig(1 / 1.4, -1, -1); return; }
			if (e.code === 'Space' || e.code === 'KeyC') { stop(); this.centreBig(); return; }
			if (e.code === 'Delete' || e.code === 'Backspace') { stop(); this.gps.clear(); this.bigDirty = true; return; }
			return;
		}
		if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
		if (this.openBigMap()) stop();
	}

	/** Opens the full-screen map. Returns false when it can't open now (paused, another overlay). */
	public openBigMap(relock?: boolean): boolean
	{
		const w = this.world;
		if (this.bigMapOpen || !this.settings.bigMap) return false;
		if (w.realismPaused || w.realismUIBlocking) return false;
		this.ensureBig();
		if (this.big === null) return false;
		this.bigMapOpen = true;
		if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking('bigMap', true);
		let locked = false;
		try { locked = !!(typeof document !== 'undefined' && document.pointerLockElement); } catch (e) { locked = false; }
		this.wasLocked = locked || !!relock;
		try
		{
			const ui = w.realismUI;
			if (ui && typeof ui.exitLock === 'function') ui.exitLock();
			else if (locked && document.exitPointerLock) document.exitPointerLock();
		}
		catch (e) { /* headless */ }
		this.centreBig();
		this.big.style.display = '';
		this.resizeBig();
		this.bigDirty = true;
		this.drawBig();
		return true;
	}

	public closeBigMap(): void
	{
		if (!this.bigMapOpen) return;
		this.bigMapOpen = false;
		this.drag.down = false;
		if (this.big) this.big.style.display = 'none';
		const w = this.world;
		if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking('bigMap', false);
		if (this.wasLocked && !w.realismPaused)
		{
			try
			{
				const ui = w.realismUI;
				if (ui && typeof ui.requestLock === 'function') ui.requestLock();
				else
				{
					const c: any = w.renderer ? w.renderer.domElement : null;
					if (c && c.requestPointerLock) c.requestPointerLock();
				}
			}
			catch (e) { /* ignore */ }
		}
		this.wasLocked = false;
	}

	private centreBig(): void
	{
		const ps = readPlayer(this.world, this.ps);
		this.view.x = ps.pos.x; this.view.z = ps.pos.z;
		this.bigDirty = true;
	}

	private ensureBig(): void
	{
		if (this.big !== null) return;
		try
		{
			if (typeof document === 'undefined' || !document.body || !document.createElement) return;
			const el = document.createElement('div');
			el.id = 'rr-bigmap';
			el.className = 'rr-bigmap';
			el.style.display = 'none';
			el.innerHTML =
				'<canvas class="rr-bigmap-canvas"></canvas>' +
				'<div class="rr-bigmap-head"><span class="rr-bigmap-title">San Verano County</span><span class="rr-bigmap-info"></span></div>' +
				'<div class="rr-bigmap-tools"><button data-z="1">+</button><button data-z="-1">&minus;</button><button data-c="1" title="Centre on you">&#x25CE;</button></div>' +
				'<div class="rr-bigmap-help">Click: set waypoint &middot; Right click: clear &middot; Drag: move &middot; Wheel: zoom &middot; M / Esc: close</div>';
			document.body.appendChild(el);
			this.big = el;
			this.bigCanvas = el.querySelector('canvas') as HTMLCanvasElement;
			this.bigInfo = el.querySelector('.rr-bigmap-info') as HTMLElement;
			this.bigG = this.bigCanvas && this.bigCanvas.getContext ? this.bigCanvas.getContext('2d') : null;
			const c = this.bigCanvas;
			if (c && c.addEventListener)
			{
				c.addEventListener('mousedown', (ev: MouseEvent) => this.onDown(ev.clientX, ev.clientY, ev.button), false);
				window.addEventListener('mousemove', (ev: MouseEvent) => { if (this.bigMapOpen) this.onMove(ev.clientX, ev.clientY); }, false);
				window.addEventListener('mouseup', (ev: MouseEvent) => { if (this.bigMapOpen) this.onUp(ev.clientX, ev.clientY, ev.button); }, false);
				c.addEventListener('contextmenu', (ev: Event) => { ev.preventDefault(); }, false);
				c.addEventListener('wheel', (ev: WheelEvent) => { ev.preventDefault(); this.zoomBig(ev.deltaY < 0 ? 1.2 : 1 / 1.2, ev.clientX, ev.clientY); }, false);
				c.addEventListener('touchstart', (ev: TouchEvent) => { if (ev.touches.length === 1) { ev.preventDefault(); this.onDown(ev.touches[0].clientX, ev.touches[0].clientY, 0); } }, false);
				c.addEventListener('touchmove', (ev: TouchEvent) => { if (ev.touches.length === 1) { ev.preventDefault(); this.onMove(ev.touches[0].clientX, ev.touches[0].clientY); } }, false);
				c.addEventListener('touchend', (ev: TouchEvent) => { const t = ev.changedTouches && ev.changedTouches[0]; if (t) this.onUp(t.clientX, t.clientY, 0); }, false);
			}
			const zs = el.querySelectorAll('[data-z]');
			for (let i = 0; i < zs.length; i++)
			{
				const b = zs[i] as HTMLElement;
				b.addEventListener('click', (ev: Event) => { ev.preventDefault(); this.zoomBig(b.getAttribute('data-z') === '1' ? 1.4 : 1 / 1.4, -1, -1); });
			}
			const cb = el.querySelector('[data-c]');
			if (cb) cb.addEventListener('click', (ev: Event) => { ev.preventDefault(); this.centreBig(); });
			el.addEventListener('mousedown', (ev: Event) => ev.stopPropagation(), false);
			if (window.addEventListener) window.addEventListener('resize', () => { if (this.bigMapOpen) { this.resizeBig(); this.bigDirty = true; } }, false);
		}
		catch (e) { this.big = null; }
	}

	private resizeBig(): void
	{
		if (!this.bigCanvas) return;
		const dpr = Math.min(1.5, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
		const cw = (typeof window !== 'undefined' && window.innerWidth) || 800, ch = (typeof window !== 'undefined' && window.innerHeight) || 600;
		this.bigCanvas.width = Math.round(cw * dpr);
		this.bigCanvas.height = Math.round(ch * dpr);
		this.bigW = cw; this.bigH = ch; this.bigDpr = dpr;
		const fit = Math.min(cw, ch) / (HALF * 2) * 0.95;
		this.minPPM = fit;
		if (this.view.ppm < fit) this.view.ppm = fit;
	}
	private minPPM = 0.2;

	/** Screen (CSS px, relative to the canvas) -> world. */
	public bigToWorld(sx: number, sy: number, out: { x: number; z: number }): { x: number; z: number }
	{
		out.x = this.view.x + (sx - this.bigW / 2) / this.view.ppm;
		out.z = this.view.z + (sy - this.bigH / 2) / this.view.ppm;
		return out;
	}

	private zoomBig(f: number, sx: number, sy: number): void
	{
		const v = this.view;
		const old = v.ppm;
		v.ppm = Math.max(this.minPPM, Math.min(4, v.ppm * f));
		if (sx >= 0 && sy >= 0)
		{
			// keep the point under the cursor in place
			const r = this.relXY(sx, sy);
			const wx = v.x + (r.x - this.bigW / 2) / old, wz = v.z + (r.y - this.bigH / 2) / old;
			v.x = wx - (r.x - this.bigW / 2) / v.ppm;
			v.z = wz - (r.y - this.bigH / 2) / v.ppm;
		}
		this.clampView();
		this.bigDirty = true;
	}

	private clampView(): void
	{
		this.view.x = Math.max(-HALF, Math.min(HALF, this.view.x));
		this.view.z = Math.max(-HALF, Math.min(HALF, this.view.z));
	}

	private rel = { x: 0, y: 0 };
	private relXY(cx: number, cy: number): { x: number; y: number }
	{
		let l = 0, t = 0;
		try { const r = this.bigCanvas.getBoundingClientRect(); l = r.left; t = r.top; } catch (e) { /* headless */ }
		this.rel.x = cx - l; this.rel.y = cy - t;
		return this.rel;
	}

	/** Pointer input on the big map (CSS client coordinates). Public for tests. */
	public onDown(cx: number, cy: number, button: number): void
	{
		const d = this.drag;
		if (button === 2) { this.gps.clear(); this.bigDirty = true; return; }
		d.down = true; d.moved = false;
		d.x = d.sx = cx; d.y = d.sy = cy;
		d.vx = this.view.x; d.vz = this.view.z;
	}

	public onMove(cx: number, cy: number): void
	{
		const d = this.drag;
		if (!d.down) return;
		if (Math.abs(cx - d.sx) + Math.abs(cy - d.sy) > 5) d.moved = true;
		if (!d.moved) return;
		this.view.x = d.vx - (cx - d.sx) / this.view.ppm;
		this.view.z = d.vz - (cy - d.sy) / this.view.ppm;
		this.clampView();
		this.bigDirty = true;
	}

	public onUp(cx: number, cy: number, button: number): void
	{
		const d = this.drag;
		if (!d.down) return;
		d.down = false;
		if (d.moved || button !== 0) return;
		const r = this.relXY(cx, cy);
		this.clickAt(r.x, r.y);
	}

	private wtmp = { x: 0, z: 0 };
	/** A click at canvas CSS pixel (x, y): blip -> waypoint there, waypoint -> clear, else waypoint here. */
	public clickAt(x: number, y: number): void
	{
		const v = this.view;
		const toSX = (wx: number) => (wx - v.x) * v.ppm + this.bigW / 2, toSY = (wz: number) => (wz - v.z) * v.ppm + this.bigH / 2;
		const wp = this.gps.waypoint;
		if (wp && Math.abs(toSX(wp.x) - x) < 14 && Math.abs(toSY(wp.z) - y - 6) < 18) { this.gps.clear(); this.bigDirty = true; return; }
		let best: Blip = null, bd = 13 * 13;
		const list = this.gps.blipList;
		for (let i = 0; i < list.length; i++)
		{
			const b = list[i];
			if (b.shortRange && v.ppm < 0.9) continue;
			const dx = toSX(b.x) - x, dy = toSY(b.z) - y;
			if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = b; }
		}
		if (best) this.gps.setWaypoint({ x: best.x, z: best.z }, best.label || 'Waypoint');
		else { const w = this.bigToWorld(x, y, this.wtmp); this.gps.setWaypoint({ x: w.x, z: w.z }, 'Waypoint'); }
		this.bigDirty = true;
	}

	/** Full-screen map redraw (on change and a few times a second while open). */
	public drawBig(): void
	{
		this.bigAcc = 0;
		this.bigDirty = false;
		const g = this.bigG;
		if (!g) return;
		const dpr = this.bigDpr, W = this.bigW * dpr, H = this.bigH * dpr;
		const v = this.view;
		const s = v.ppm * dpr;
		g.setTransform(1, 0, 0, 1, 0, 0);
		g.fillStyle = SEA;
		g.fillRect(0, 0, W, H);
		g.setTransform(s, 0, 0, s, W / 2 - v.x * s, H / 2 - v.z * s);
		const hw = W / 2 / s, hh = H / 2 / s;
		this.map.newFrame(3);
		this.drawMapArea(g, v.x - hw, v.z - hh, v.x + hw, v.z + hh, s);
		if (this.stats.tilesDrawn === 0 && s > BASE_PPM * 1.5) this.bigDirty = true;   // tiles still coming
		if (this.gps.rn >= 2) strokeRoute(g, this.gps, 0, s, 4 * dpr, this.settings.routeColor, this.dash);
		g.setTransform(1, 0, 0, 1, 0, 0);
		const toX = (x: number) => (x - v.x) * s + W / 2, toY = (z: number) => (z - v.z) * s + H / 2;
		// blips + labels
		const list = this.gps.blipList;
		const showShort = v.ppm >= 0.9;
		g.font = 'bold ' + Math.round(11 * dpr) + 'px Arial, sans-serif';
		g.textAlign = 'left';
		g.textBaseline = 'middle';
		for (let i = 0; i < list.length; i++)
		{
			const b = list[i];
			if (b.shortRange && !showShort) continue;
			const x = toX(b.x), y = toY(b.z);
			if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
			const spr = blipSprite(b.icon, b.color, 8 * dpr);
			if (spr) g.drawImage(spr, x - spr.width / 2, y - spr.height / 2);
			if (b.label && (v.ppm >= 0.45 || !b.shortRange && v.ppm >= 0.3))
			{
				g.lineWidth = 3 * dpr; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.fillStyle = '#ffffff';
				g.strokeText(b.label, x + 11 * dpr, y);
				g.fillText(b.label, x + 11 * dpr, y);
			}
		}
		const wp = this.gps.waypoint;
		if (wp)
		{
			const spr = blipSprite('waypoint', this.settings.waypointColor, 11 * dpr);
			if (spr) g.drawImage(spr, toX(wp.x) - spr.width / 2, toY(wp.z) - spr.height / 2 - 6 * dpr);
		}
		const ps = readPlayer(this.world, this.ps);
		this.arrow(g, toX(ps.pos.x), toY(ps.pos.z), Math.atan2(ps.fz, ps.fx), 9 * dpr);
		this.stats.bigDraws++;
		if (this.bigInfo)
		{
			const r = this.gps.routeInfo();
			const txt = wp ? (wp.label + (r ? ' \u00B7 ' + fmtDist(r.remaining) : '')) : 'No waypoint';
			if (this.bigInfo.textContent !== txt) this.bigInfo.textContent = txt;
		}
	}
}

export function fmtDist(m: number): string
{
	if (!(m >= 0)) return '';
	return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km';
}

function makeCanvas(w: number, h: number): HTMLCanvasElement
{
	try
	{
		if (typeof document === 'undefined' || !document.createElement) return null;
		const c = document.createElement('canvas');
		c.width = w; c.height = h;
		return c;
	}
	catch (e) { return null; }
}

function now(): number { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

/**
 * Builds the GPS (C8) and the minimap / full-screen map. Call once the county is built.
 * (Events (C14) and prompts (C7) are created earlier with ensureEvents / ensurePrompts.)
 */
export function buildHud(ctx: RealismCtx, settings: HudSettings): { gps: RealismGPS; minimap: RealismMinimap }
{
	const gps = new RealismGPS(ctx, settings);
	ctx.world.registerUpdatable(gps);
	(ctx.world as any).realismGPSSystem = gps;
	const minimap = new RealismMinimap(ctx, gps, settings);
	ctx.world.registerUpdatable(minimap);
	return { gps: gps, minimap: minimap };
}
