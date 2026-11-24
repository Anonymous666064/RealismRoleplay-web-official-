/*
 * RealismInternetMedia.ts  (A15)
 * ------------------------------
 * Canvas 2D drawing for the laptop's websites: NPC avatars, Snapgram photos, SV Realty facade
 * thumbnails and location maps, and the procedural ViewTube "videos" (car review, vlog, city
 * timelapse in minimap colours, cooking show, music visualiser). Everything is a pure function of
 * (seed, time), so seeking is free. Nothing here runs unless a page that shows it is open.
 */

import { HALF } from './RealismMapData';

/** GTA-style minimap palette, shared with the timelapse and the property maps. */
export const MINIMAP = { land: '#2a3843', land2: '#31424e', road: '#8b98a4', major: '#c8b26a', water: '#24536f', park: '#2f4c39', building: '#46545f', text: '#e8eef2' };

export function hash(n: number): number { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); }

export function hsl(h: number, s: number, l: number): string { return 'hsl(' + Math.round(((h % 360) + 360) % 360) + ',' + Math.round(s) + '%,' + Math.round(l) + '%)'; }

function rgbCss(c: number[], k: number = 1): string
{
	if (!c || c.length < 3) return '#888';
	return 'rgb(' + Math.round(Math.min(1, c[0] * k) * 255) + ',' + Math.round(Math.min(1, c[1] * k) * 255) + ',' + Math.round(Math.min(1, c[2] * k) * 255) + ')';
}

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }

export const mediaStats = { draws: 0 };   // tests / perf

// ---------------------------------------------------------------------------- avatars

export function drawAvatar(g: any, size: number, name: string, hue: number): void
{
	mediaStats.draws++;
	g.clearRect(0, 0, size, size);
	g.fillStyle = hsl(hue, 55, 42);
	g.beginPath(); g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); g.fill();
	// head + shoulders silhouette
	g.fillStyle = hsl(hue, 45, 70);
	g.beginPath(); g.arc(size / 2, size * 0.42, size * 0.18, 0, Math.PI * 2); g.fill();
	g.beginPath(); g.arc(size / 2, size * 0.98, size * 0.34, Math.PI, Math.PI * 2); g.fill();
	const ini = String(name || '?').split(/\s+/).map((p) => p.charAt(0)).join('').slice(0, 2).toUpperCase();
	g.fillStyle = 'rgba(0,0,0,0.55)';
	g.font = 'bold ' + Math.round(size * 0.26) + 'px Arial';
	g.textAlign = 'center'; g.textBaseline = 'middle';
	g.fillText(ini, size * 0.5, size * 0.43);
}

// ---------------------------------------------------------------------------- Snapgram photos

export function drawPhoto(g: any, w: number, h: number, kind: string, seed: number, hour: number): void
{
	mediaStats.draws++;
	const r = (i: number) => hash(seed * 0.001 + i * 7.31);
	const night = hour >= 21 || hour < 5;
	const sky = kind === 'sunset' ? ['#2b2d5c', '#c4506a', '#f6a04d'] : night ? ['#070b1c', '#141c3a', '#25305a'] : ['#4a8fd0', '#86bce6', '#cfe6f5'];
	for (let i = 0; i < 3; i++) { g.fillStyle = sky[i]; g.fillRect(0, h * 0.22 * i, w, h * 0.24); }
	if (kind === 'sunset' || kind === 'beach')
	{
		g.fillStyle = kind === 'sunset' ? '#ffd27a' : '#fff6c0';
		g.beginPath(); g.arc(w * (0.3 + r(1) * 0.4), h * 0.55, h * 0.09, 0, Math.PI * 2); g.fill();
		g.fillStyle = kind === 'sunset' ? '#3b3e6b' : '#2f78a8'; g.fillRect(0, h * 0.58, w, h * 0.2);
		g.fillStyle = 'rgba(255,220,150,0.5)';
		for (let i = 0; i < 6; i++) g.fillRect(w * (0.25 + r(10 + i) * 0.5), h * (0.6 + i * 0.025), w * 0.12 * r(20 + i), 2);
		g.fillStyle = '#e3cf9a'; g.fillRect(0, h * 0.78, w, h * 0.22);
		if (kind === 'beach') { g.fillStyle = '#d2573c'; g.beginPath(); g.arc(w * 0.7, h * 0.8, w * 0.12, Math.PI, 0); g.fill(); g.fillStyle = '#5a4630'; g.fillRect(w * 0.7 - 1, h * 0.8, 3, h * 0.12); }
		return;
	}
	if (kind === 'skyline')
	{
		let x = 0, i = 0;
		while (x < w)
		{
			const bw = w * (0.06 + r(i) * 0.1), bh = h * (0.25 + r(i + 50) * 0.55);
			g.fillStyle = night ? '#101522' : hsl(210, 12, 30 + r(i + 9) * 25);
			g.fillRect(x, h - bh, bw, bh);
			g.fillStyle = night ? 'rgba(255,214,120,0.85)' : 'rgba(200,230,255,0.45)';
			for (let wy = h - bh + 6; wy < h - 6; wy += 9) for (let wx = x + 3; wx < x + bw - 4; wx += 7) if (hash(wx * 3.1 + wy * 1.7 + seed) > (night ? 0.55 : 0.3)) g.fillRect(wx, wy, 3, 4);
			x += bw + 2; i++;
		}
		return;
	}
	if (kind === 'food')
	{
		g.fillStyle = '#6b4a33'; g.fillRect(0, 0, w, h);
		g.fillStyle = '#f2efe8'; g.beginPath(); g.arc(w / 2, h / 2, Math.min(w, h) * 0.38, 0, Math.PI * 2); g.fill();
		for (let i = 0; i < 9; i++)
		{
			g.fillStyle = hsl(r(i) * 60 + (i % 3) * 90, 60, 50);
			const a = r(i + 30) * Math.PI * 2, d = r(i + 60) * Math.min(w, h) * 0.24;
			g.beginPath(); g.arc(w / 2 + Math.cos(a) * d, h / 2 + Math.sin(a) * d, Math.min(w, h) * (0.05 + r(i + 90) * 0.06), 0, Math.PI * 2); g.fill();
		}
		return;
	}
	if (kind === 'park')
	{
		g.fillStyle = '#4f8a45'; g.fillRect(0, h * 0.6, w, h * 0.4);
		for (let i = 0; i < 6; i++) { const tx = w * r(i), th = h * (0.25 + r(i + 7) * 0.2); g.fillStyle = '#5a4630'; g.fillRect(tx, h * 0.62 - th * 0.3, 4, th * 0.3); g.fillStyle = '#2f6b33'; g.beginPath(); g.arc(tx + 2, h * 0.62 - th * 0.35, th * 0.28, 0, Math.PI * 2); g.fill(); }
		return;
	}
	// car
	g.fillStyle = '#3a3d42'; g.fillRect(0, h * 0.62, w, h * 0.38);
	drawCar(g, w * 0.5, h * 0.7, w * 0.7, hsl(r(3) * 360, 70, 45), 0);
}

function drawCar(g: any, cx: number, cy: number, len: number, color: string, wheelAngle: number): void
{
	const hgt = len * 0.22;
	g.fillStyle = color;
	g.fillRect(cx - len / 2, cy - hgt, len, hgt * 0.62);                       // body
	g.beginPath();
	g.moveTo(cx - len * 0.28, cy - hgt); g.lineTo(cx - len * 0.16, cy - hgt * 1.6); g.lineTo(cx + len * 0.18, cy - hgt * 1.6); g.lineTo(cx + len * 0.32, cy - hgt);
	g.fill();                                                                   // cabin
	g.fillStyle = 'rgba(170,210,235,0.85)';
	g.fillRect(cx - len * 0.14, cy - hgt * 1.52, len * 0.13, hgt * 0.46);
	g.fillRect(cx + len * 0.02, cy - hgt * 1.52, len * 0.14, hgt * 0.46);
	g.fillStyle = '#ffe9a6'; g.fillRect(cx + len / 2 - 5, cy - hgt * 0.9, 5, 4);
	g.fillStyle = '#c0392b'; g.fillRect(cx - len / 2, cy - hgt * 0.9, 4, 4);
	for (let s = -1; s <= 1; s += 2)
	{
		const wx = cx + s * len * 0.3, wy = cy - hgt * 0.38, wr = hgt * 0.36;
		g.fillStyle = '#151515'; g.beginPath(); g.arc(wx, wy, wr, 0, Math.PI * 2); g.fill();
		g.strokeStyle = '#9aa0a6'; g.lineWidth = 2;
		for (let k = 0; k < 3; k++) { const a = wheelAngle + k * 2.094; g.beginPath(); g.moveTo(wx, wy); g.lineTo(wx + Math.cos(a) * wr * 0.7, wy + Math.sin(a) * wr * 0.7); g.stroke(); }
	}
}

// ---------------------------------------------------------------------------- SV Realty

export function drawFacade(g: any, w: number, h: number, p: { kind: string; tint: number[]; floors: number; closed: boolean; hood: boolean; buildingIndex: number; label?: string }): void
{
	mediaStats.draws++;
	const seed = p.buildingIndex * 1.37;
	g.fillStyle = '#9cc9ea'; g.fillRect(0, 0, w, h);
	g.fillStyle = '#c4e0f2'; g.fillRect(0, h * 0.45, w, h * 0.3);
	g.fillStyle = '#6f8a5c'; g.fillRect(0, h * 0.86, w, h * 0.14);
	g.fillStyle = '#55595e'; g.fillRect(0, h * 0.92, w, h * 0.08);
	const tall = p.kind === 'hotel' || p.kind === 'bank' || p.kind === 'office';
	const floors = Math.max(1, Math.min(tall ? 22 : 6, p.floors));
	const bw = w * (p.kind === 'house' ? 0.55 : p.kind === 'warehouse' ? 0.8 : tall ? 0.42 : 0.66);
	const bh = Math.min(h * 0.8, h * (p.kind === 'house' ? 0.3 + floors * 0.12 : p.kind === 'warehouse' ? 0.36 : 0.24 + floors * (tall ? 0.03 : 0.09)));
	const x0 = (w - bw) / 2, y0 = h * 0.88 - bh;
	g.fillStyle = rgbCss(p.tint, p.hood ? 0.8 : 1);
	g.fillRect(x0, y0, bw, bh);
	if (p.kind === 'house')
	{
		g.fillStyle = '#5b4a42';
		g.beginPath(); g.moveTo(x0 - 6, y0); g.lineTo(w / 2, y0 - bh * 0.35); g.lineTo(x0 + bw + 6, y0); g.fill();
	}
	else if (p.kind === 'warehouse')
	{
		g.fillStyle = 'rgba(0,0,0,0.18)';
		for (let i = 0; i < bw; i += 6) g.fillRect(x0 + i, y0, 2, bh);
		g.fillStyle = '#6b7075'; g.fillRect(x0 + bw * 0.2, y0 + bh * 0.4, bw * 0.3, bh * 0.6);
	}
	// windows
	const rows = p.kind === 'warehouse' ? 1 : Math.max(1, Math.min(18, floors));
	const cols = Math.max(2, Math.round(bw / (tall ? 9 : 16)));
	const cw = bw / cols, rh = (bh * 0.86) / rows;
	for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
	{
		if (p.kind === 'warehouse' && c % 2) continue;
		const lit = hash(seed + r * 3.1 + c * 7.7);
		g.fillStyle = p.closed ? '#8a6d4a' : (lit > 0.75 ? '#ffe3a0' : tall ? '#5f86a6' : '#3c5468');
		g.fillRect(x0 + c * cw + cw * 0.2, y0 + bh * 0.08 + r * rh + rh * 0.18, cw * 0.6, rh * 0.55);
	}
	// door
	g.fillStyle = p.closed ? '#8a6d4a' : '#2b2b2b';
	g.fillRect(w / 2 - 5, h * 0.88 - Math.min(16, bh * 0.3), 10, Math.min(16, bh * 0.3));
	if (p.label)
	{
		g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x0, y0 + 2, bw, 11);
		g.fillStyle = '#fff'; g.font = 'bold 9px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
		g.fillText(String(p.label).slice(0, 22), w / 2, y0 + 8);
	}
	if (p.closed) { g.fillStyle = '#c0392b'; g.font = 'bold 10px Arial'; g.textAlign = 'center'; g.fillText('FIXER-UPPER', w / 2, h * 0.12); }
}

/** Top-down map around (x, z) in minimap colours with a pin. */
export function drawMapPreview(g: any, w: number, h: number, data: any, x: number, z: number, radius: number, buildings?: any[]): void
{
	mediaStats.draws++;
	g.fillStyle = MINIMAP.land; g.fillRect(0, 0, w, h);
	const s = Math.min(w, h) / (radius * 2);
	const px = (wx: number) => w / 2 + (wx - x) * s, pz = (wz: number) => h / 2 + (wz - z) * s;
	if (data.lake) { g.fillStyle = MINIMAP.water; g.beginPath(); g.ellipse ? g.ellipse(px(data.lake.x), pz(data.lake.z), data.lake.rx * s, data.lake.rz * s, 0, 0, Math.PI * 2) : g.arc(px(data.lake.x), pz(data.lake.z), data.lake.rx * s, 0, Math.PI * 2); g.fill(); }
	if (z + radius > HALF - 260) { g.fillStyle = MINIMAP.water; g.fillRect(0, pz(HALF - 150), w, h); }
	if (buildings)
	{
		g.fillStyle = MINIMAP.building;
		for (let i = 0; i < buildings.length; i++)
		{
			const b = buildings[i];
			if (Math.abs(b.x - x) > radius + 30 || Math.abs(b.z - z) > radius + 30) continue;
			g.fillRect(px(b.x) - b.w * s / 2, pz(b.z) - b.d * s / 2, Math.max(1, b.w * s), Math.max(1, b.d * s));
		}
	}
	const roads: any[] = data.roads || [];
	g.lineCap = 'round';
	for (let r = 0; r < roads.length; r++)
	{
		const road = roads[r];
		const pts = road.pts || [];
		if (!pts.length) continue;
		g.strokeStyle = road.kind === 'highway' ? MINIMAP.major : MINIMAP.road;
		g.lineWidth = Math.max(1.5, road.width * s);
		g.beginPath();
		let pen = false;
		for (let i = 0; i < pts.length; i++)
		{
			const p = pts[i];
			const inside = Math.abs(p.x - x) < radius * 1.4 && Math.abs(p.z - z) < radius * 1.4;
			if (!inside) { pen = false; continue; }
			if (!pen) { g.moveTo(px(p.x), pz(p.z)); pen = true; } else g.lineTo(px(p.x), pz(p.z));
		}
		g.stroke();
	}
	// pin
	g.fillStyle = '#e53935';
	g.beginPath(); g.arc(w / 2, h / 2 - 8, 7, 0, Math.PI * 2); g.fill();
	g.beginPath(); g.moveTo(w / 2 - 6, h / 2 - 5); g.lineTo(w / 2, h / 2 + 4); g.lineTo(w / 2 + 6, h / 2 - 5); g.fill();
	g.fillStyle = '#fff'; g.beginPath(); g.arc(w / 2, h / 2 - 8, 2.5, 0, Math.PI * 2); g.fill();
}

// ---------------------------------------------------------------------------- ViewTube

export interface VideoInfo { id: string; title: string; kind: string; dur: number; seed: number; h: string; extra?: string; }

/** Road segments of the county in 0..1 coordinates (built once for the timelapse). */
export class MapCache
{
	public segs: Float32Array = null;
	public major: Uint8Array = null;
	public count = 0;
	constructor(data: any)
	{
		const roads: any[] = (data && data.roads) || [];
		let n = 0;
		for (let r = 0; r < roads.length; r++) n += Math.max(0, Math.ceil((roads[r].pts || []).length / 3));
		this.segs = new Float32Array(n * 4);
		this.major = new Uint8Array(n);
		let k = 0;
		for (let r = 0; r < roads.length; r++)
		{
			const pts = roads[r].pts || [];
			if (!/street|avenue|highway|rural/.test(roads[r].kind)) continue;
			for (let i = 0; i + 3 < pts.length && k < n; i += 3)
			{
				this.segs[k * 4] = (pts[i].x + HALF) / (2 * HALF); this.segs[k * 4 + 1] = (pts[i].z + HALF) / (2 * HALF);
				this.segs[k * 4 + 2] = (pts[i + 3].x + HALF) / (2 * HALF); this.segs[k * 4 + 3] = (pts[i + 3].z + HALF) / (2 * HALF);
				this.major[k] = roads[r].kind === 'highway' ? 1 : 0;
				k++;
			}
		}
		this.count = k;
	}
}

function caption(g: any, w: number, h: number, text: string, sub?: string): void
{
	g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, h - 34, w, 34);
	g.fillStyle = '#fff'; g.font = 'bold 13px Arial'; g.textAlign = 'left'; g.textBaseline = 'middle';
	g.fillText(text, 10, h - (sub ? 24 : 17));
	if (sub) { g.fillStyle = '#ddd'; g.font = '11px Arial'; g.fillText(sub, 10, h - 10); }
}

function titleCard(g: any, w: number, h: number, v: VideoInfo, t: number, hue: number): void
{
	g.fillStyle = hsl(hue, 40, 12); g.fillRect(0, 0, w, h);
	for (let i = 0; i < 8; i++)
	{
		const a = t * (0.6 + hash(i + v.seed) * 1.4) + i;
		g.fillStyle = hsl(hue + i * 25, 70, 50);
		g.globalAlpha = 0.35;
		g.beginPath(); g.arc(w * (0.5 + Math.cos(a) * 0.38), h * (0.5 + Math.sin(a * 1.3) * 0.35), 10 + hash(i * 3 + v.seed) * 26, 0, Math.PI * 2); g.fill();
	}
	g.globalAlpha = 1;
	const slide = clamp(t / 0.6, 0, 1);
	g.fillStyle = hsl(hue, 80, 55); g.fillRect(0, h * 0.42, w * slide, 4);
	g.fillStyle = '#fff'; g.font = 'bold 18px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
	g.fillText(v.title.length > 40 ? v.title.slice(0, 38) + '...' : v.title, w / 2, h * 0.52);
	g.fillStyle = '#cfd8dc'; g.font = '12px Arial'; g.fillText('@' + v.h, w / 2, h * 0.64);
}

/** Draws one frame of a video at time t (seconds). */
export function drawVideoFrame(g: any, w: number, h: number, v: VideoInfo, t: number, map: MapCache): void
{
	mediaStats.draws++;
	const hue = hash(v.seed * 0.0001) * 360;
	g.globalAlpha = 1;
	if (t < 2.5 && v.kind !== 'timelapse') { titleCard(g, w, h, v, t, hue); return; }
	if (v.kind === 'carReview')
	{
		const sp = 140;
		g.fillStyle = '#7fb3dc'; g.fillRect(0, 0, w, h * 0.5);
		g.fillStyle = '#5b7f52';
		for (let i = 0; i < 6; i++) { const hx = ((i * 130 - t * 20) % (w + 130) + w + 130) % (w + 130) - 65; g.beginPath(); g.arc(hx, h * 0.52, 70, Math.PI, 0); g.fill(); }
		g.fillStyle = '#3b3f44'; g.fillRect(0, h * 0.5, w, h * 0.5);
		g.fillStyle = '#e6d36a';
		for (let x = -((t * sp) % 60); x < w; x += 60) g.fillRect(x, h * 0.78, 30, 4);
		drawCar(g, w * 0.5 + Math.sin(t * 1.3) * 6, h * 0.74, w * 0.42, hsl(hue, 70, 45), -t * 14);
		g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
		for (let i = 0; i < 5; i++) { const ly = h * (0.6 + i * 0.03), lx = ((w - t * 300 - i * 97) % w + w) % w; g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx + 40, ly); g.stroke(); }
		const left = v.dur - t;
		if (left < 3) { g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(w * 0.3, h * 0.15, w * 0.4, h * 0.25); g.fillStyle = '#ffd54a'; g.font = 'bold 22px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText((6 + hash(v.seed) * 3.9).toFixed(1) + ' / 10', w / 2, h * 0.27); }
		const lines = ['0-60 mph in ' + (5 + hash(v.seed + 1) * 4).toFixed(1) + ' s', 'Handling: ' + (hash(v.seed + 2) > 0.5 ? 'sharp' : 'comfy'), 'Fuel: ' + Math.round(22 + hash(v.seed + 3) * 18) + ' mpg'];
		caption(g, w, h, v.extra || 'Road test', lines[Math.floor(t / 4) % lines.length]);
		return;
	}
	if (v.kind === 'vlog')
	{
		const scene = Math.floor((t - 2.5) / 4) % 3;
		if (scene === 0)
		{
			// selfie cam
			g.fillStyle = hsl(hue + 180, 30, 55); g.fillRect(0, 0, w, h);
			g.fillStyle = hsl(hue + 200, 25, 40); for (let i = 0; i < 5; i++) g.fillRect(i * w / 5 + 8, h * 0.2, w / 5 - 16, h * 0.5);
			g.fillStyle = '#c89b77'; g.beginPath(); g.arc(w / 2, h * 0.55 + Math.sin(t * 6) * 2, h * 0.24, 0, Math.PI * 2); g.fill();
			g.fillStyle = '#2b1d14'; g.beginPath(); g.arc(w / 2, h * 0.43, h * 0.22, Math.PI, 0); g.fill();
			const blink = (t % 3.2) < 0.15;
			g.fillStyle = '#1a1a1a';
			if (blink) { g.fillRect(w / 2 - 22, h * 0.52, 12, 2); g.fillRect(w / 2 + 10, h * 0.52, 12, 2); }
			else { g.beginPath(); g.arc(w / 2 - 16, h * 0.52, 4, 0, Math.PI * 2); g.fill(); g.beginPath(); g.arc(w / 2 + 16, h * 0.52, 4, 0, Math.PI * 2); g.fill(); }
			const open = 2 + Math.abs(Math.sin(t * 11)) * 7;
			g.fillStyle = '#7a2f2f'; g.fillRect(w / 2 - 10, h * 0.64, 20, open);
			caption(g, w, h, 'what\'s up guys', 'welcome back to the channel');
		}
		else if (scene === 1)
		{
			// walking down the street: scrolling buildings
			g.fillStyle = '#8fc2e6'; g.fillRect(0, 0, w, h);
			for (let i = 0; i < 12; i++)
			{
				const bx = ((i * 70 - t * 45) % (12 * 70) + 12 * 70) % (12 * 70) - 70, bh = h * (0.3 + hash(i + v.seed) * 0.45);
				g.fillStyle = hsl(hue + i * 20, 25, 45); g.fillRect(bx, h * 0.8 - bh, 64, bh);
				g.fillStyle = 'rgba(255,240,200,0.6)'; for (let wy = h * 0.8 - bh + 8; wy < h * 0.75; wy += 14) g.fillRect(bx + 8, wy, 48, 6);
			}
			g.fillStyle = '#6b6f74'; g.fillRect(0, h * 0.8, w, h * 0.2);
			caption(g, w, h, v.title, 'San Verano');
		}
		else titleCard(g, w, h, v, (t - 2.5) % 4, hue + 40);
		return;
	}
	if (v.kind === 'timelapse')
	{
		const day = (t / v.dur) * 24;    // a full day over the video
		const dark = clamp(Math.cos((day - 13) / 24 * Math.PI * 2) * -0.5 + 0.35, 0, 0.75);
		g.fillStyle = MINIMAP.land; g.fillRect(0, 0, w, h);
		const s = Math.min(w, h), ox = (w - s) / 2;
		g.fillStyle = MINIMAP.water; g.fillRect(ox, s * 0.93, s, h);
		if (map)
		{
			g.lineWidth = 1;
			for (let pass = 0; pass < 2; pass++)
			{
				g.strokeStyle = pass ? MINIMAP.major : MINIMAP.road;
				g.beginPath();
				for (let i = 0; i < map.count; i++)
				{
					if (map.major[i] !== pass) continue;
					g.moveTo(ox + map.segs[i * 4] * s, map.segs[i * 4 + 1] * s);
					g.lineTo(ox + map.segs[i * 4 + 2] * s, map.segs[i * 4 + 3] * s);
				}
				g.stroke();
			}
			// cars as dots running along segments
			const n = Math.min(90, map.count);
			for (let k = 0; k < n; k++)
			{
				const i = Math.floor(hash(k + v.seed) * map.count);
				const f = (t * (0.3 + hash(k * 7) * 0.9) + hash(k * 3)) % 1;
				const x = map.segs[i * 4] + (map.segs[i * 4 + 2] - map.segs[i * 4]) * f, z = map.segs[i * 4 + 1] + (map.segs[i * 4 + 3] - map.segs[i * 4 + 1]) * f;
				g.fillStyle = dark > 0.4 ? '#ffe08a' : '#ffffff';
				g.fillRect(ox + x * s - 1, z * s - 1, 2, 2);
			}
		}
		g.fillStyle = 'rgba(8,12,40,' + dark.toFixed(2) + ')'; g.fillRect(0, 0, w, h);
		const hh = Math.floor(day), mm = Math.floor((day - hh) * 60);
		g.fillStyle = '#fff'; g.font = 'bold 16px Arial'; g.textAlign = 'right'; g.textBaseline = 'top';
		g.fillText((hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm, w - 10, 8);
		g.textAlign = 'left'; g.font = '11px Arial'; g.fillText('SV TIMELAPSE  x2880', 10, 10);
		return;
	}
	if (v.kind === 'cooking')
	{
		g.fillStyle = '#d9cbb3'; g.fillRect(0, 0, w, h);
		g.fillStyle = '#8b6a4a'; g.fillRect(0, h * 0.62, w, h * 0.38);
		g.fillStyle = '#2d2d2d'; g.beginPath(); g.arc(w * 0.5, h * 0.66, h * 0.22, 0, Math.PI * 2); g.fill();
		g.fillRect(w * 0.5 + h * 0.2, h * 0.64, w * 0.25, 8);
		const step = Math.floor((t - 2.5) / 3);
		for (let i = 0; i <= Math.min(step, 7); i++)
		{
			const fall = i === step ? clamp(((t - 2.5) % 3) / 0.8, 0, 1) : 1;
			const a = hash(i + v.seed) * Math.PI * 2, d = hash(i * 5 + v.seed) * h * 0.13;
			g.fillStyle = hsl(hash(i * 11 + v.seed) * 360, 60, 50);
			g.beginPath(); g.arc(w * 0.5 + Math.cos(a) * d, h * 0.66 + Math.sin(a) * d * 0.6 - (1 - fall) * h * 0.6, 6 + hash(i) * 6, 0, Math.PI * 2); g.fill();
		}
		g.fillStyle = 'rgba(255,255,255,0.35)';
		for (let i = 0; i < 6; i++) { const sy = h * 0.4 - ((t * 30 + i * 17) % 60); g.beginPath(); g.arc(w * 0.45 + i * 8 + Math.sin(t * 2 + i) * 6, sy, 5, 0, Math.PI * 2); g.fill(); }
		const STEPS = ['Step 1: prep everything', 'Step 2: heat the pan', 'Step 3: add the good stuff', 'Step 4: stir, don\'t burn it', 'Step 5: season to taste', 'Step 6: plate it up', 'Step 7: enjoy!'];
		caption(g, w, h, STEPS[Math.max(0, Math.min(STEPS.length - 1, step))], v.title);
		return;
	}
	// music visualiser
	g.fillStyle = hsl(hue, 45, 8); g.fillRect(0, 0, w, h);
	const bars = 32, bw = w / bars;
	for (let i = 0; i < bars; i++)
	{
		const a = Math.abs(Math.sin(t * (2 + hash(i) * 4) + i * 0.5)) * 0.6 + Math.abs(Math.sin(t * 1.7 + i * 0.21)) * 0.4;
		g.fillStyle = hsl(hue + i * 6, 80, 55);
		g.fillRect(i * bw + 1, h * 0.82 - a * h * 0.55, bw - 2, a * h * 0.55);
	}
	const pulse = 1 + Math.abs(Math.sin(t * 3.9)) * 0.15;
	g.strokeStyle = hsl(hue + 120, 80, 65); g.lineWidth = 3;
	g.beginPath(); g.arc(w / 2, h * 0.36, 34 * pulse, 0, Math.PI * 2); g.stroke();
	caption(g, w, h, v.title, '@' + v.h);
}

/** Plays one video into a canvas. step() is driven by the laptop's update, only while visible. */
export class VideoPlayer
{
	public canvas: any;
	public video: VideoInfo;
	public time = 0;
	public playing = false;
	public frames = 0;
	public ended = false;
	private g: any;
	private map: MapCache;
	private acc = 0;
	private w: number;
	private h: number;

	constructor(canvas: any, video: VideoInfo, map: MapCache)
	{
		this.canvas = canvas;
		this.video = video;
		this.map = map;
		this.w = canvas.width || 480;
		this.h = canvas.height || 270;
		this.g = canvas && canvas.getContext ? canvas.getContext('2d') : null;
		this.draw();
	}

	/** Moves the player to a new canvas (the page was re-rendered) keeping time / state. */
	public rebind(canvas: any): void
	{
		this.canvas = canvas;
		this.w = (canvas && canvas.width) || 480;
		this.h = (canvas && canvas.height) || 270;
		this.g = canvas && canvas.getContext ? canvas.getContext('2d') : null;
		this.draw();
	}

	public play(): void { if (this.ended || this.time >= this.video.dur) { this.time = 0; this.ended = false; } this.playing = true; }
	public pause(): void { this.playing = false; }
	public toggle(): void { if (this.playing) this.pause(); else this.play(); }

	public seek(t: number): void
	{
		this.time = clamp(t, 0, this.video.dur);
		this.ended = this.time >= this.video.dur;
		this.draw();
	}

	/** Advances while playing; redraws at most 20 times a second. Returns true when a frame was drawn. */
	public step(dt: number): boolean
	{
		if (!this.playing || !(dt > 0)) return false;
		this.time += Math.min(dt, 0.25);
		if (this.time >= this.video.dur) { this.time = this.video.dur; this.playing = false; this.ended = true; this.acc = 1; }
		this.acc += dt;
		if (this.acc < 0.05) return false;
		this.acc = 0;
		this.draw();
		return true;
	}

	public draw(): void
	{
		if (!this.g) return;
		drawVideoFrame(this.g, this.w, this.h, this.video, this.time, this.map);
		this.frames++;
	}

	public dispose(): void
	{
		this.playing = false;
		this.g = null;
		if (this.canvas) { try { this.canvas.width = 1; this.canvas.height = 1; } catch (e) { /* ignore */ } }
		this.canvas = null;
	}
}

export function fmtTime(s: number): string
{
	const m = Math.floor(s / 60), r = Math.floor(s % 60);
	return m + ':' + (r < 10 ? '0' : '') + r;
}
