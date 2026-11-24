/*
 * RealismMaterials.ts
 * -------------------
 * Canvas-drawn textures and the shared materials for San Verano County.
 * No image files are needed; everything is painted at start-up.
 */

import * as THREE from 'three';
import { World } from './World';

export function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, height?: number): THREE.CanvasTexture
{
	const c = document.createElement('canvas');
	c.width = size; c.height = height || size;
	const ctx = c.getContext('2d');
	draw(ctx, size);
	const t = new THREE.CanvasTexture(c);
	t.wrapS = THREE.RepeatWrapping;
	t.wrapT = THREE.RepeatWrapping;
	t.anisotropy = 4;
	return t;
}

function noiseFill(ctx: CanvasRenderingContext2D, w: number, h: number, base: number, amp: number, seed: number): void
{
	let a = seed;
	const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
	const img = ctx.createImageData(w, h);
	for (let i = 0; i < w * h; i++)
	{
		const v = Math.max(0, Math.min(255, base + (rnd() - 0.5) * amp));
		img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
}

/** Facade with a 4 x 4 grid of bays/floors and random lit windows.
 *  `litOut` collects the lit window rectangles (0..1 UV units) for the night glow mask. */
function facadeTexture(kind: string, litOut?: number[][]): THREE.CanvasTexture
{
	return canvasTexture(256, (ctx, s) =>
	{
		let a = kind.length * 7919 + 13;
		const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
		const t = s / 4;
		if (kind === 'glass')
		{
			ctx.fillStyle = '#9fb4c4'; ctx.fillRect(0, 0, s, s);
			for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++)
			{
				const l = 120 + rnd() * 70;
				ctx.fillStyle = 'rgb(' + (l * 0.55) + ',' + (l * 0.72) + ',' + l + ')';
				ctx.fillRect(i * t + 2, j * t + 3, t - 4, t - 10);
				if (litOut && ((i * 5 + j * 3 + kind.length) % 9) < 2) litOut.push([(i * t + 2) / s, (j * t + 3) / s, (t - 4) / s, (t - 10) / s]);
			}
			ctx.fillStyle = '#d8dde2';
			for (let j = 0; j < 4; j++) ctx.fillRect(0, j * t + t - 7, s, 4);
			return;
		}
		const wall = kind === 'brick' ? '#ffffff' : (kind === 'concrete' ? '#f2f2f2' : '#fbfbfb');
		ctx.fillStyle = wall; ctx.fillRect(0, 0, s, s);
		if (kind === 'brick')
		{
			ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1;
			for (let y = 0; y < s; y += 6)
			{
				ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
				for (let x = (y / 6) % 2 ? 0 : 6; x < s; x += 12) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 6); ctx.stroke(); }
			}
		}
		const ww = kind === 'concrete' ? 0.4 : 0.55;
		const wh = 0.5;
		for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++)
		{
			const lit = rnd() < 0.18;
			const x = i * t + t * (1 - ww) / 2, y = j * t + t * (1 - wh) / 2;
			ctx.fillStyle = '#5a5a5a'; ctx.fillRect(x - 2, y - 2, t * ww + 4, t * wh + 4);
			ctx.fillStyle = lit ? '#c9b98a' : (rnd() < 0.5 ? '#2b3642' : '#34404c');
			ctx.fillRect(x, y, t * ww, t * wh);
			// at night these windows glow, plus a few more that are dark in the day texture
			if (litOut && (lit || ((i * 7 + j * 11 + kind.length) % 6) === 0)) litOut.push([x / s, y / s, t * ww / s, t * wh / s]);
			ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x, y, t * ww * 0.35, t * wh);
		}
	});
}

/** Black texture with the lit windows white: the facade's emissive map (glows only at night). */
function windowGlowMask(rects: number[][]): THREE.CanvasTexture
{
	return canvasTexture(64, (ctx, s) =>
	{
		ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, s, s);
		for (let i = 0; i < rects.length; i++)
		{
			const r = rects[i];
			const warm = 200 + ((i * 37) % 55);
			ctx.fillStyle = 'rgb(255,' + warm + ',' + Math.round(warm * 0.62) + ')';
			ctx.fillRect(r[0] * s, r[1] * s, Math.max(1, r[2] * s), Math.max(1, r[3] * s));
		}
	});
}

/** Facade material with night-lit windows: emissiveMap is set from the start (so switching day / night
 *  never recompiles a shader) and emissive stays black until RealismDayNight turns it up. */
function facadeMaterial(world: World, kind: string, params: any): THREE.Material
{
	const lit: number[][] = [];
	params.map = facadeTexture(kind, lit);
	params.emissive = 0x000000;
	params.emissiveMap = windowGlowMask(lit);
	const m = phong(world, params);
	(m as any).userData.realismNightWindow = true;
	return m;
}

/** Horizontal lap siding without windows (houses get real 3D windows). */
function sidingTexture(): THREE.CanvasTexture
{
	return canvasTexture(128, (ctx, s) =>
	{
		ctx.fillStyle = '#f7f7f5'; ctx.fillRect(0, 0, s, s);
		for (let y = 0; y < s; y += 8)
		{
			ctx.fillStyle = 'rgba(0,0,0,0.10)'; ctx.fillRect(0, y + 6, s, 2);
			ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(0, y, s, 1);
		}
	});
}

function metalTexture(): THREE.CanvasTexture
{
	return canvasTexture(128, (ctx, s) =>
	{
		ctx.fillStyle = '#f0f0f0'; ctx.fillRect(0, 0, s, s);
		for (let x = 0; x < s; x += 8)
		{
			ctx.fillStyle = 'rgba(0,0,0,0.13)'; ctx.fillRect(x, 0, 3, s);
			ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(x + 4, 0, 1, s);
		}
	});
}

function roadTexture(kind: string): THREE.CanvasTexture
{
	return canvasTexture(256, (ctx, s) =>
	{
		const concrete = kind === 'apron' || kind === 'taxiway';
		noiseFill(ctx, s, s, concrete ? 150 : 62, concrete ? 22 : 26, kind.length * 31 + 7);
		const line = (u: number, width: number, color: string, dashed: boolean, dashFrac: number = 0.25) =>
		{
			ctx.fillStyle = color;
			const x = u * s - width / 2;
			if (dashed) ctx.fillRect(x, 0, width, s * dashFrac);
			else ctx.fillRect(x, 0, width, s);
		};
		const W = '#e8e8e2', Y = '#e0b52a';
		switch (kind)
		{
			case 'highway':
				line(0.035, 5, W, false); line(0.965, 5, W, false);
				line(0.488, 4, Y, false); line(0.512, 4, Y, false);
				line(0.26, 4, W, true); line(0.74, 4, W, true);
				break;
			case 'avenue':
				line(0.04, 5, W, false); line(0.96, 5, W, false);
				line(0.485, 4, Y, false); line(0.515, 4, Y, false);
				line(0.27, 4, W, true); line(0.73, 4, W, true);
				break;
			case 'street':
				line(0.5, 4, Y, true, 0.3);
				break;
			case 'rural':
				line(0.05, 5, W, false); line(0.95, 5, W, false);
				line(0.5, 4, Y, true, 0.35);
				break;
			case 'runway':
				line(0.03, 5, W, false); line(0.97, 5, W, false);
				line(0.5, 6, W, true, 0.4);
				break;
			case 'taxiway':
				line(0.5, 5, Y, false);
				line(0.04, 3, Y, false); line(0.96, 3, Y, false);
				break;
			case 'apron':
				ctx.fillStyle = 'rgba(0,0,0,0.15)';
				ctx.fillRect(0, 0, s, 2); ctx.fillRect(0, 0, 2, s);
				break;
		}
	});
}

function detailTexture(): THREE.CanvasTexture
{
	return canvasTexture(256, (ctx, s) =>
	{
		noiseFill(ctx, s, s, 232, 40, 4242);
		ctx.globalAlpha = 0.25;
		for (let i = 0; i < 400; i++)
		{
			ctx.fillStyle = i % 2 ? '#ffffff' : '#9a9a9a';
			ctx.beginPath();
			ctx.arc((i * 73) % s, (i * 151) % s, 1 + (i % 5), 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = 1;
	});
}

/** Wood planks / tiles for interior floors (tinted per room by vertex colour). */
function floorTexture(): THREE.CanvasTexture
{
	return canvasTexture(256, (ctx, s) =>
	{
		noiseFill(ctx, s, s, 225, 30, 99);
		ctx.fillStyle = 'rgba(0,0,0,0.16)';
		for (let y = 0; y < s; y += 32)
		{
			ctx.fillRect(0, y, s, 2);
			const off = (y / 32) % 2 ? 0 : 96;
			for (let x = off; x < s + 192; x += 192) ctx.fillRect(x % s, y, 2, 32);
		}
	});
}

/** 4 x 2 atlas of spray-painted tags for the gang neighbourhoods. */
/** White with alpha fading from 0.75 at the bottom (v = 0) to 0 at the top (v = 1). */
function fadeTexture(): THREE.CanvasTexture
{
	const t = canvasTexture(16, (ctx, s) =>
	{
		ctx.clearRect(0, 0, s, 64);
		const g = ctx.createLinearGradient(0, 64, 0, 0);
		g.addColorStop(0, 'rgba(255,255,255,0.75)');
		g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
		g.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, s, 64);
	}, 64);
	t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
	return t;
}

function graffitiTexture(): THREE.CanvasTexture
{
	const t = canvasTexture(512, (ctx, s) =>
	{
		ctx.clearRect(0, 0, s, 256);
		const tags = ['HRB 13', 'FLATS', 'SVC', 'EAST $IDE', 'KING', '4LIFE', 'NO SNITCH', 'HC PROJ'];
		const cols = ['#d1262b', '#2a6fd6', '#18a34a', '#e6c21e', '#b02cc7', '#f2f2f2', '#ff7a1a', '#1fd3c6'];
		for (let i = 0; i < 8; i++)
		{
			const cx = (i % 4) * 128 + 64, cy = Math.floor(i / 4) * 128 + 64;
			ctx.save();
			ctx.translate(cx, cy);
			ctx.rotate(((i * 37) % 20 - 10) * Math.PI / 180);
			ctx.font = 'bold ' + (tags[i].length > 6 ? 26 : 36) + 'px Impact, Arial Black, sans-serif';
			ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			ctx.lineWidth = 7; ctx.strokeStyle = '#111111'; ctx.strokeText(tags[i], 0, 0);
			ctx.fillStyle = cols[i]; ctx.fillText(tags[i], 0, 0);
			ctx.lineWidth = 2; ctx.strokeStyle = cols[(i + 3) % 8];
			ctx.beginPath(); ctx.moveTo(-50, 26); ctx.quadraticCurveTo(0, 40 + (i % 3) * 6, 52, 22); ctx.stroke();
			ctx.restore();
		}
	}, 256);
	t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
	return t;
}

export function signTexture(text: string, bg: string, fg: string): THREE.CanvasTexture
{
	const t = canvasTexture(1024, (ctx, s) =>
	{
		ctx.fillStyle = bg; ctx.fillRect(0, 0, s, 128);
		ctx.fillStyle = fg;
		let size = 80;
		ctx.font = 'bold ' + size + 'px Arial, Helvetica, sans-serif';
		while (ctx.measureText(text).width > s - 60 && size > 30) { size -= 4; ctx.font = 'bold ' + size + 'px Arial, Helvetica, sans-serif'; }
		ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
		ctx.fillText(text, s / 2, 66);
	}, 128);
	t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
	return t;
}

/** Red octagon with STOP. */
function stopTexture(): THREE.CanvasTexture
{
	const t = canvasTexture(128, (ctx, s) =>
	{
		ctx.clearRect(0, 0, s, s);
		ctx.fillStyle = '#ffffff';
		const oct = (r: number) =>
		{
			ctx.beginPath();
			for (let i = 0; i < 8; i++)
			{
				const a = Math.PI / 8 + i * Math.PI / 4;
				const x = s / 2 + Math.cos(a) * r, y = s / 2 + Math.sin(a) * r;
				if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
			}
			ctx.closePath();
		};
		oct(62); ctx.fill();
		ctx.fillStyle = '#c8161d'; oct(56); ctx.fill();
		ctx.fillStyle = '#ffffff'; ctx.font = 'bold 40px Arial, Helvetica, sans-serif';
		ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('STOP', s / 2, s / 2 + 2);
	});
	t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
	return t;
}

/** 'lambert' = per-vertex lighting (much cheaper on Chromebooks / phones), 'phong' = per-pixel. */
let LIGHTING = 'phong';
let BRIGHTNESS = 0.55;

/** Re-tints every Realism material (they remember their original colour in userData.realismBase). */
export function applyBrightness(root: THREE.Object3D, v: number): void
{
	BRIGHTNESS = v;
	const seen: { [id: string]: boolean } = {};
	root.traverse((o: any) =>
	{
		if (!o.material) return;
		const ms = Array.isArray(o.material) ? o.material : [o.material];
		for (const m of ms)
		{
			if (!m || seen[m.uuid] || !m.userData || !m.userData.realismBase || !m.color) continue;
			seen[m.uuid] = true;
			m.color.copy(m.userData.realismBase).multiplyScalar(v);
		}
	});
}

export function phong(world: World, params: any): THREE.Material
{
	let m: THREE.Material;
	if (LIGHTING === 'lambert')
	{
		const p: any = {};
		for (const k in params) if (params.hasOwnProperty(k) && k !== 'shininess' && k !== 'specular') p[k] = params[k];
		m = new THREE.MeshLambertMaterial(p);
	}
	else m = new THREE.MeshPhongMaterial(params);
	const mc: any = m;
	if (mc.color) { mc.userData.realismBase = mc.color.clone(); mc.color.multiplyScalar(BRIGHTNESS); }
	world.sky.csm.setupMaterial(m);
	return m;
}

export function createMaterials(world: World, lighting?: string, brightness?: number): { [name: string]: THREE.Material }
{
	LIGHTING = lighting === 'lambert' ? 'lambert' : 'phong';
	BRIGHTNESS = typeof brightness === 'number' && brightness > 0 ? brightness : 0.55;
	const mats: { [name: string]: THREE.Material } = {};
	const vc = THREE.VertexColors;
	mats.terrain = phong(world, { vertexColors: vc, map: detailTexture(), shininess: 0, specular: 0x000000 });
	mats.glass = facadeMaterial(world, 'glass', { vertexColors: vc, shininess: 60, specular: 0x555555 });
	mats.office = facadeMaterial(world, 'office', { vertexColors: vc, shininess: 5, specular: 0x111111 });
	mats.brick = facadeMaterial(world, 'brick', { vertexColors: vc, shininess: 0, specular: 0x000000 });
	mats.concrete = facadeMaterial(world, 'concrete', { vertexColors: vc, shininess: 0, specular: 0x000000 });
	mats.house = phong(world, { vertexColors: vc, map: sidingTexture(), shininess: 0, specular: 0x000000 });
	mats.metal = phong(world, { vertexColors: vc, map: metalTexture(), shininess: 10, specular: 0x222222 });
	mats.plain = phong(world, { vertexColors: vc, shininess: 0, specular: 0x000000 });
	mats.shiny = phong(world, { vertexColors: vc, shininess: 70, specular: 0x666666 });
	mats.floor = phong(world, { vertexColors: vc, map: floorTexture(), shininess: 12, specular: 0x222222 });
	mats.foliage = phong(world, { vertexColors: vc, shininess: 0, specular: 0x000000 });
	mats.graffiti = phong(world, { map: graffitiTexture(), transparent: true, alphaTest: 0.15, shininess: 0, specular: 0x000000, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
	mats.decal = phong(world, { vertexColors: vc, shininess: 0, specular: 0x000000, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
	mats.stop = new THREE.MeshBasicMaterial({ map: stopTexture(), transparent: true, alphaTest: 0.3 });
	// emissive bits: lamp heads, windows at night, traffic signal lenses
	mats.lampGlow = new THREE.MeshBasicMaterial({ color: 0xfff1c8 });
	mats.lampOff = phong(world, { color: 0xb8b8ae, shininess: 30, specular: 0x333333 });
	// street lamp heads: lit at night, plain grey lens by day (RealismDayNight switches the colour,
	// so the switch costs no draw calls and no shader change)
	mats.streetLampGlow = new THREE.MeshBasicMaterial({ color: 0xfff1c8 });
	mats.streetLampGlow.name = 'streetLampGlow';
	(mats.streetLampGlow as any).userData = { realismNightLamp: true, onColor: 0xfff1c8, offColor: 0x7c7d78 };
	mats.signalRed = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
	mats.signalYellow = new THREE.MeshBasicMaterial({ color: 0xffc21a });
	mats.signalGreen = new THREE.MeshBasicMaterial({ color: 0x2aff6a });
	mats.signalOff = phong(world, { color: 0x1b1b1b, shininess: 40, specular: 0x444444 });
	const kinds = ['highway', 'avenue', 'street', 'rural', 'runway', 'taxiway', 'apron'];
	const layer: { [k: string]: number } = { apron: 0, street: 1, rural: 1, taxiway: 2, avenue: 2, runway: 3, highway: 3 };
	for (let i = 0; i < kinds.length; i++)
	{
		mats['road_' + kinds[i]] = phong(world, {
			vertexColors: vc, map: roadTexture(kinds[i]), shininess: 4, specular: 0x111111,
			polygonOffset: true, polygonOffsetFactor: -1 - layer[kinds[i]], polygonOffsetUnits: -4 - 2 * layer[kinds[i]],
		});
	}
	// grime / water streaks on run-down walls: a soft see-through fade, not a solid band
	mats.grime = phong(world, {
		vertexColors: vc, map: fadeTexture(), transparent: true, depthWrite: false, shininess: 0, specular: 0x000000,
		polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
	});
	// plain asphalt pad drawn over every junction (hides the lane lines of the crossing roads
	// and the flicker where two road ribbons overlap), plus white stop bars on top of it
	mats.road_junction = phong(world, {
		vertexColors: vc, map: roadTexture('junction'), shininess: 4, specular: 0x111111,
		polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -12,
	});
	mats.road_marking = phong(world, {
		vertexColors: vc, shininess: 4, specular: 0x111111,
		polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -16,
	});
	return mats;
}

/** Facade texture tiling per building style (metres per texture repeat). */
export interface StyleDef { mat: string; tileW: number; tileH: number; }

export const STYLES: { [style: string]: StyleDef } = {
	glass:     { mat: 'glass',     tileW: 3.2 * 4, tileH: 3.5 * 4 },
	office:    { mat: 'office',    tileW: 3.5 * 4, tileH: 3.5 * 4 },
	brick:     { mat: 'brick',     tileW: 3.5 * 4, tileH: 3.5 * 4 },
	concrete:  { mat: 'concrete',  tileW: 4.5 * 4, tileH: 4.0 * 4 },
	house:     { mat: 'house',     tileW: 2.4,     tileH: 2.4 },
	warehouse: { mat: 'metal',     tileW: 6,       tileH: 8 },
	steel:     { mat: 'metal',     tileW: 2.5,     tileH: 2.6 },
	wood:      { mat: 'plain',     tileW: 1,       tileH: 1 },
	silo:      { mat: 'metal',     tileW: 4,       tileH: 4 },
	plain:     { mat: 'plain',     tileW: 1,       tileH: 1 },
};
