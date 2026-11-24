/*
 * RealismELS.ts
 * -------------
 * Emergency lighting + siren system for police / sheriff cars (RealismPolice.ts attaches it).
 *
 *  Lights (no real light per LED): one additive, unlit LED mesh per car whose vertex colours are switched
 *  frame by frame (the emissive look without any shader or material change). Elements:
 *    lightbar front x6 (red driver side / blue passenger side), takedown x2 (white), lightbar rear x8
 *    (red / blue, or amber traffic advisor on stage 1), alley lights x2 (bar ends), grille flashers x2,
 *    headlight wig-wag x2, rear deck flashers x2. Takedown / alley lights also show a soft light beam.
 *  Optional pooled point lights (els.pooledLights: 'auto' = 0 on low, 1 on medium, 2 on high) follow the
 *  nearest active car; they are created once at load (so no shader recompiles) and sit at intensity 0.
 *
 *  Stages: 0 off, 1 rear amber traffic advisor + amber deck, 2 full lights, 3 full lights + siren.
 *  Siren tones (WebAudio, synthesized): WAIL, YELP, PRIORITY (phaser). Air horn while held.
 *  Volume follows (world as any).realismVolume * police.els.sirenVolume, fades with distance when you
 *  are not in that car. Lights and siren keep running when you get out.
 *
 *  Keys (only while you drive a police / sheriff car, configurable in police.els.keys):
 *    Q stage up (0-1-2-3-0), Shift+Q all off, K siren on / off, J siren tone, H air horn (hold),
 *    U flash pattern, N takedown lights, B alley lights.
 *
 *  (world as any).realismPolice.els = { state(car), setStage(car, n), setSiren(car, on), setTone(car, i),
 *    setPattern(car, i), setTakedown(car, on), setAlley(car, on), horn(car, on), patterns, tones, stats }
 */

import * as THREE from 'three';
import { playerVehicle } from './RealismVehicleTuning';
import { RealismCtx } from './RealismContext';

export const LED_COUNT = 24;
export const ATLAS_W = 1024, ATLAS_H = 256;

/** Quad builder: positions, uvs, colors, normals. A quad faces u x v. uvr = atlas pixel rect. */
export class QuadBuilder
{
	public pos: number[] = [];
	public uv: number[] = [];
	public col: number[] = [];
	public nor: number[] = [];
	public count = 0;

	public quad(cx: number, cy: number, cz: number, u: number[], v: number[], w: number, h: number, uvr?: number[], rgb?: number[]): void
	{
		const hw = w / 2, hh = h / 2;
		const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
		const cs = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
		let u0 = 0, v0 = 0, u1 = 1, v1 = 1;
		if (uvr) { u0 = uvr[0] / ATLAS_W; u1 = (uvr[0] + uvr[2]) / ATLAS_W; v1 = 1 - uvr[1] / ATLAS_H; v0 = 1 - (uvr[1] + uvr[3]) / ATLAS_H; }
		for (let k = 0; k < 6; k++)
		{
			const a = cs[k][0], b = cs[k][1];
			this.pos.push(cx + u[0] * hw * a + v[0] * hh * b, cy + u[1] * hw * a + v[1] * hh * b, cz + u[2] * hw * a + v[2] * hh * b);
			this.uv.push(a < 0 ? u0 : u1, b < 0 ? v0 : v1);
			this.nor.push(n[0], n[1], n[2]);
			if (rgb) this.col.push(rgb[0], rgb[1], rgb[2]);
		}
		this.count++;
	}

	/** Axis-aligned box from 6 quads. */
	public box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rgb: number[]): void
	{
		const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1], nX = [-1, 0, 0], nZ = [0, 0, -1];
		this.quad(cx, cy, cz + sz / 2, X, Y, sx, sy, null, rgb);
		this.quad(cx, cy, cz - sz / 2, nX, Y, sx, sy, null, rgb);
		this.quad(cx + sx / 2, cy, cz, nZ, Y, sz, sy, null, rgb);
		this.quad(cx - sx / 2, cy, cz, Z, Y, sz, sy, null, rgb);
		this.quad(cx, cy + sy / 2, cz, nX, Z, sx, sz, null, rgb);
		this.quad(cx, cy - sy / 2, cz, X, Z, sx, sz, null, rgb);
	}

	public geometry(withUv: boolean, withColor: boolean): THREE.BufferGeometry
	{
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
		g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
		if (withUv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
		if (withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
		g.computeBoundingSphere();
		return g;
	}
}

/** Where things are on the sedan, in car space. */
export interface CarLayout
{
	roofY: number; roofZ0: number; roofZ1: number; roofHalfW: number;
	trunkY: number; trunkZ: number;
	frontZ: number; grilleY: number; headX: number; headY: number; headZ: number;
	rearZ: number; rearY: number; halfW: number;
}

/** Lightbar dimensions and segment positions (car space). Position 0 = driver side (+x). */
export function barLayout(L: CarLayout): { y: number; z: number; w: number; h: number; d: number; segX: number[] }
{
	const w = Math.min(0.92, L.roofHalfW * 1.8);
	const h = 0.06, d = 0.16;
	const s = w / 0.9;
	return {
		y: L.roofY + 0.012 + 0.024 + h / 2, z: Math.min(L.roofZ1 - 0.12, L.roofZ0 + (L.roofZ1 - L.roofZ0) * 0.82), w: w, h: h, d: d,
		segX: [0.40 * s, 0.29 * s, 0.18 * s, 0.06 * s, -0.06 * s, -0.18 * s, -0.29 * s, -0.40 * s],
	};
}

// LED element indices
const E_FRONT = 0, E_TKD = 6, E_REAR = 8, E_ALLEY = 16, E_GRILLE = 18, E_WIG = 20, E_DECK = 22;
const FRONT_POS = [0, 1, 2, 5, 6, 7];

export interface FlashPattern { name: string; step: number; frames: number[]; }

/** Bar patterns: 8-bit masks over bar positions 0..7 (bit i = position i, 0-3 driver side). */
export const PATTERNS: FlashPattern[] = [
	{ name: 'DOUBLE', step: 0.07, frames: [0x0F, 0, 0x0F, 0, 0xF0, 0, 0xF0, 0] },
	{ name: 'ALTERNATE', step: 0.25, frames: [0x0F, 0xF0] },
	{ name: 'QUAD', step: 0.05, frames: [0x0F, 0, 0x0F, 0, 0x0F, 0, 0x0F, 0, 0xF0, 0, 0xF0, 0, 0xF0, 0, 0xF0, 0] },
	{ name: 'CROSS', step: 0.16, frames: [0xC3, 0, 0x3C, 0] },
	{ name: 'SCAN', step: 0.08, frames: [0x81, 0x42, 0x24, 0x18, 0x24, 0x42] },
	{ name: 'STROBE', step: 0.06, frames: [0xFF, 0, 0xFF, 0, 0, 0, 0, 0] },
];
/** Traffic advisor patterns (stage 1, rear, amber). */
export const TA_PATTERNS: FlashPattern[] = [
	{ name: 'WARN', step: 0.3, frames: [0xAA, 0x55] },
	{ name: 'CENTER OUT', step: 0.13, frames: [0x18, 0x3C, 0x7E, 0xFF, 0, 0] },
	{ name: 'ARROW LEFT', step: 0.1, frames: [0x01, 0x03, 0x07, 0x0F, 0x1F, 0x3F, 0x7F, 0xFF, 0, 0] },
	{ name: 'ARROW RIGHT', step: 0.1, frames: [0x80, 0xC0, 0xE0, 0xF0, 0xF8, 0xFC, 0xFE, 0xFF, 0, 0] },
];
export const TONES = ['WAIL', 'YELP', 'PRIORITY'];
// carrier base Hz, sweep depth Hz, lfo Hz, lfo wave
const TONE_PARAMS: { base: number; depth: number; rate: number; wave: string }[] = [
	{ base: 900, depth: 450, rate: 0.23, wave: 'triangle' },
	{ base: 950, depth: 430, rate: 3.4, wave: 'triangle' },
	{ base: 1150, depth: 420, rate: 11, wave: 'sawtooth' },
];

const DEFAULT_KEYS = { stage: 'KeyQ', siren: 'KeyK', tone: 'KeyJ', horn: 'KeyH', pattern: 'KeyU', takedown: 'KeyN', alley: 'KeyB' };

export interface ELSUnit
{
	car: any;
	stage: number;
	pattern: number;
	taPattern: number;
	siren: boolean;
	tone: number;
	horn: boolean;
	takedown: boolean;
	alley: boolean;
	t: number;
	lastFrame: number;
	dirty: boolean;
	led: THREE.Mesh;
	colors: Float32Array;
	colorAttr: THREE.BufferAttribute;
	beam: THREE.Mesh;
	beamColors: Float32Array;
	beamAttr: THREE.BufferAttribute;
	beamVerts: number;
	barX: number[];
	barY: number;
	barZ: number;
	frontZ: number;
	sirenNodes: any;
	hornNodes: any;
	litA: boolean;
	litB: boolean;
}

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }

export class ELSSystem
{
	public units: ELSUnit[] = [];
	public api: any;
	public stats: { [k: string]: number } = { units: 0, active: 0, sirensPlaying: 0, ledWrites: 0, lights: 0, sirenNodesStarted: 0, sirenNodesStopped: 0 };
	public settings: any;
	private ctx: RealismCtx;
	private police: any;
	private ledMat: THREE.MeshBasicMaterial;
	private beamMat: THREE.MeshBasicMaterial;
	private colA: number[];
	private colB: number[];
	private amber = [1, 0.55, 0.02];
	private white = [1, 1, 0.95];
	private lights: THREE.PointLight[] = [];
	private audio: any = null;
	private master: any = null;
	private keys: any;
	private hud: HTMLElement = null;
	private hudKey = '';
	private driven: ELSUnit = null;
	private tmpV = new THREE.Vector3();
	private tmpV2 = new THREE.Vector3();
	private paused = false;

	constructor(ctx: RealismCtx, police: any)
	{
		this.ctx = ctx;
		this.police = police;
		const S = police.settings;
		const e = S.els || {};
		this.settings = {
			pooledLights: e.pooledLights === undefined ? 'auto' : e.pooledLights,
			sirenVolume: typeof e.sirenVolume === 'number' ? e.sirenVolume : 0.7,
			sirenRange: typeof e.sirenRange === 'number' ? e.sirenRange : 220,
			wigwag: e.wigwag !== false,
			pattern: typeof e.pattern === 'string' ? Math.max(0, PATTERNS.map((p) => p.name).indexOf(e.pattern.toUpperCase())) : 0,
			hud: e.hud !== false,
		};
		this.keys = Object.assign({}, DEFAULT_KEYS, e.keys || {});
		this.colA = S.lightColors.left;
		this.colB = S.lightColors.right;
		this.ledMat = new THREE.MeshBasicMaterial({ vertexColors: THREE.VertexColors, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
			polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
		this.ledMat.name = 'elsLEDs';
		this.beamMat = new THREE.MeshBasicMaterial({ vertexColors: THREE.VertexColors, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide });
		this.beamMat.name = 'elsBeams';
		this.makeLights();
		this.bindInput();
		const self = this;
		const U = (car: any) => self.unitOf(car);
		this.api = {
			state(car: any): any
			{
				const u = U(car);
				if (!u) return null;
				return { stage: u.stage, pattern: PATTERNS[u.pattern].name, taPattern: TA_PATTERNS[u.taPattern].name, siren: u.siren, tone: TONES[u.tone],
					horn: u.horn, takedown: u.takedown, alley: u.alley };
			},
			setStage(car: any, n: number): void { const u = U(car); if (u) self.setStage(u, n); },
			cycleStage(car: any): void { const u = U(car); if (u) self.setStage(u, (u.stage + 1) % 4); },
			setSiren(car: any, on: boolean): void { const u = U(car); if (u) self.setSiren(u, on); },
			setTone(car: any, i: number): void { const u = U(car); if (u) { u.tone = ((i % 3) + 3) % 3; self.retone(u); u.dirty = true; } },
			setPattern(car: any, i: number): void { const u = U(car); if (u) self.setPattern(u, i); },
			setTakedown(car: any, on: boolean): void { const u = U(car); if (u) { u.takedown = !!on; u.dirty = true; } },
			setAlley(car: any, on: boolean): void { const u = U(car); if (u) { u.alley = !!on; u.dirty = true; } },
			horn(car: any, on: boolean): void { const u = U(car); if (u) self.setHorn(u, on); },
			patterns: PATTERNS.map((p) => p.name),
			taPatterns: TA_PATTERNS.map((p) => p.name),
			tones: TONES.slice(0),
			keys: this.keys,
			get stats(): any { return self.stats; },
			get lights(): THREE.PointLight[] { return self.lights; },
			/** Headlight wig-wag in stage 2-3 is on (RealismCarLights follows the same phase). */
			get wigwag(): boolean { return self.settings.wigwag !== false; },
			/** Test hook: set the AudioContext to use. */
			useAudioContext(ac: any): void { self.audio = ac; self.master = null; },
		};
	}

	public unitOf(car: any): ELSUnit { return car && car.realismELS ? car.realismELS : null; }

	// ------------------------------------------------------------------ meshes

	public attach(car: any, L: CarLayout): THREE.Mesh[]
	{
		let u: ELSUnit = car.realismELS;
		const keep = u ? { stage: u.stage, pattern: u.pattern, taPattern: u.taPattern, siren: u.siren, tone: u.tone, takedown: u.takedown, alley: u.alley } : null;
		if (u) this.detach(car);
		const bar = barLayout(L);
		const qb = new QuadBuilder();
		const off = [0, 0, 0];
		const FZ = [1, 0, 0], BZ = [-1, 0, 0], Y = [0, 1, 0];
		const fz = bar.z + bar.d / 2 + 0.004, bz = bar.z - bar.d / 2 - 0.004;
		for (let i = 0; i < 6; i++) qb.quad(bar.segX[FRONT_POS[i]], bar.y, fz, FZ, Y, 0.1, bar.h * 0.72, null, off);            // 0-5
		qb.quad(bar.segX[3], bar.y, fz, FZ, Y, 0.07, bar.h * 0.72, null, off);                                                    // 6
		qb.quad(bar.segX[4], bar.y, fz, FZ, Y, 0.07, bar.h * 0.72, null, off);                                                    // 7
		for (let i = 0; i < 8; i++) qb.quad(bar.segX[i], bar.y, bz, BZ, Y, i === 3 || i === 4 ? 0.07 : 0.1, bar.h * 0.72, null, off);  // 8-15
		qb.quad(bar.w / 2 + 0.004, bar.y, bar.z, [0, 0, -1], Y, 0.1, bar.h * 0.6, null, off);                                      // 16 alley +x
		qb.quad(-bar.w / 2 - 0.004, bar.y, bar.z, [0, 0, 1], Y, 0.1, bar.h * 0.6, null, off);                                      // 17 alley -x
		qb.quad(0.12, L.grilleY, L.frontZ + 0.012, FZ, Y, 0.08, 0.035, null, off);                                                 // 18 grille
		qb.quad(-0.12, L.grilleY, L.frontZ + 0.012, FZ, Y, 0.08, 0.035, null, off);                                                // 19
		qb.quad(L.headX, L.headY, L.headZ + 0.012, FZ, Y, 0.13, 0.055, null, off);                                                 // 20 wig-wag
		qb.quad(-L.headX, L.headY, L.headZ + 0.012, FZ, Y, 0.13, 0.055, null, off);                                                // 21
		qb.quad(0.3, L.rearY, L.rearZ - 0.012, BZ, Y, 0.09, 0.035, null, off);                                                     // 22 rear deck
		qb.quad(-0.3, L.rearY, L.rearZ - 0.012, BZ, Y, 0.09, 0.035, null, off);                                                    // 23
		const geo = qb.geometry(false, true);
		const colorAttr = geo.getAttribute('color') as THREE.BufferAttribute;
		(colorAttr as any).setUsage ? (colorAttr as any).setUsage(THREE.DynamicDrawUsage) : ((colorAttr as any).dynamic = true);
		const led = new THREE.Mesh(geo, this.ledMat);
		led.name = 'elsLEDs';
		led.castShadow = false; led.receiveShadow = false;
		led.renderOrder = 2;
		// beams: front (takedown), +x and -x (alley); colour fades along the cone
		const bgeo = this.beamGeometry(bar);
		const beamAttr = bgeo.getAttribute('color') as THREE.BufferAttribute;
		(beamAttr as any).setUsage ? (beamAttr as any).setUsage(THREE.DynamicDrawUsage) : ((beamAttr as any).dynamic = true);
		const beam = new THREE.Mesh(bgeo, this.beamMat);
		beam.name = 'elsBeams';
		beam.visible = false;
		beam.castShadow = false; beam.receiveShadow = false;
		beam.renderOrder = 3;
		u = {
			car: car, stage: 0, pattern: this.settings.pattern, taPattern: 0, siren: false, tone: 0, horn: false, takedown: false, alley: false,
			t: 0, lastFrame: -1, dirty: true, led: led, colors: colorAttr.array as Float32Array, colorAttr: colorAttr,
			beam: beam, beamColors: beamAttr.array as Float32Array, beamAttr: beamAttr, beamVerts: (bgeo as any).userData.vertsPerBeam,
			barX: bar.segX, barY: bar.y, barZ: bar.z, frontZ: L.frontZ, sirenNodes: null, hornNodes: null, litA: false, litB: false,
		};
		if (keep) { u.stage = keep.stage; u.pattern = keep.pattern; u.taPattern = keep.taPattern; u.tone = keep.tone; u.takedown = keep.takedown; u.alley = keep.alley; }
		car.realismELS = u;
		this.units.push(u);
		if (keep && keep.siren) this.setSiren(u, true);
		this.stats.units = this.units.length;
		return [led, beam];
	}

	private beamGeometry(bar: any): THREE.BufferGeometry
	{
		const SEG = 8;
		const pos: number[] = [], col: number[] = [];
		const cone = (ox: number, oy: number, oz: number, dir: number[], len: number, rad: number) =>
		{
			// side vectors
			const up = Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
			const s = [dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]];
			const sl = Math.hypot(s[0], s[1], s[2]); s[0] /= sl; s[1] /= sl; s[2] /= sl;
			const t = [dir[1] * s[2] - dir[2] * s[1], dir[2] * s[0] - dir[0] * s[2], dir[0] * s[1] - dir[1] * s[0]];
			for (let i = 0; i < SEG; i++)
			{
				const a0 = i / SEG * Math.PI * 2, a1 = (i + 1) / SEG * Math.PI * 2;
				const p = (a: number) => [ox + dir[0] * len + (s[0] * Math.cos(a) + t[0] * Math.sin(a)) * rad,
					oy + dir[1] * len + (s[1] * Math.cos(a) + t[1] * Math.sin(a)) * rad, oz + dir[2] * len + (s[2] * Math.cos(a) + t[2] * Math.sin(a)) * rad];
				const p0 = p(a0), p1 = p(a1);
				pos.push(ox, oy, oz, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2]);
				col.push(0, 0, 0, 0, 0, 0, 0, 0, 0);
			}
		};
		const dn = -0.12;
		const fl = Math.hypot(1, dn);
		cone(0, bar.y, bar.z + bar.d / 2, [0, dn / fl, 1 / fl], 7, 1.3);
		cone(bar.w / 2, bar.y, bar.z, [1 / fl, dn / fl, 0], 6, 1.1);
		cone(-bar.w / 2, bar.y, bar.z, [-1 / fl, dn / fl, 0], 6, 1.1);
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
		g.computeBoundingSphere();
		(g as any).userData = { vertsPerBeam: SEG * 3 };
		return g;
	}

	public detach(car: any, dispose?: boolean): void
	{
		const u: ELSUnit = car && car.realismELS;
		if (!u) return;
		this.stopSiren(u);
		this.setHorn(u, false);
		if (u.led.parent) u.led.parent.remove(u.led);
		if (u.beam.parent) u.beam.parent.remove(u.beam);
		u.led.geometry.dispose();
		u.beam.geometry.dispose();
		const i = this.units.indexOf(u);
		if (i >= 0) this.units.splice(i, 1);
		car.realismELS = undefined;
		if (this.driven === u) this.driven = null;
		this.stats.units = this.units.length;
	}

	// ------------------------------------------------------------------ state

	public setStage(u: ELSUnit, n: number): void
	{
		const s = clamp(Math.round(n) || 0, 0, 3);
		u.stage = s;
		if (s === 3 && !u.siren) this.setSiren(u, true, true);
		if (s < 3 && u.siren) this.setSiren(u, false, true);
		u.dirty = true;
	}

	public setSiren(u: ELSUnit, on: boolean, fromStage?: boolean): void
	{
		u.siren = !!on;
		if (!fromStage)
		{
			if (on && u.stage < 3) u.stage = 3;
			else if (!on && u.stage === 3) u.stage = 2;
		}
		if (on) this.startSiren(u); else this.stopSiren(u);
		u.dirty = true;
	}

	public setPattern(u: ELSUnit, i: number): void
	{
		if (u.stage === 1) u.taPattern = ((i % TA_PATTERNS.length) + TA_PATTERNS.length) % TA_PATTERNS.length;
		else u.pattern = ((i % PATTERNS.length) + PATTERNS.length) % PATTERNS.length;
		u.t = 0;
		u.dirty = true;
	}

	// ------------------------------------------------------------------ per frame

	public update(timeStep: number, unscaled: number): void
	{
		const w: any = this.ctx.world;
		const paused = !!w.realismPaused;
		if (paused !== this.paused) { this.paused = paused; this.muteAll(paused); }
		this.driven = this.drivenUnit();
		this.updateHud();
		if (paused) return;
		const dt = Math.min(unscaled, 0.1);
		let active = 0, sirens = 0;
		const cam = w.camera ? w.camera.position : null;
		for (let i = 0; i < this.units.length; i++)
		{
			const u = this.units[i];
			const inWorld = !!u.car.parent && !!u.car.world;
			if (!inWorld)
			{
				if (u.sirenNodes) this.stopSiren(u, true);
				continue;
			}
			const on = u.stage > 0 || u.takedown || u.alley;
			if (on) { active++; u.t += dt; }
			this.paint(u);
			if (u.siren)
			{
				if (!u.sirenNodes) this.startSiren(u);
				if (u.sirenNodes) { sirens++; this.sirenGain(u, cam); }
			}
		}
		this.stats.active = active;
		this.stats.sirensPlaying = sirens;
		this.updateLights();
	}

	/** Writes the LED colours for the current flash frame (only when it changed). */
	public paint(u: ELSUnit): void
	{
		const pat = u.stage === 1 ? TA_PATTERNS[u.taPattern] : PATTERNS[u.pattern];
		const fi = Math.floor(u.t / pat.step) % pat.frames.length;
		const gi = Math.floor(u.t / 0.09) % 4;          // grille / deck
		const wi = Math.floor(u.t / 0.33) % 2;          // wig-wag
		const di = Math.floor(u.t / 0.4) % 2;           // stage 1 deck
		const frame = fi + 100 * gi + 1000 * wi + 10000 * di;
		if (!u.dirty && frame === u.lastFrame) return;
		u.lastFrame = frame;
		u.dirty = false;
		this.stats.ledWrites++;
		const mask = u.stage >= 2 ? pat.frames[fi] : 0;
		const ta = u.stage === 1 ? pat.frames[fi] : 0;
		const A = this.colA, B = this.colB;
		let litA = false, litB = false;
		for (let i = 0; i < 6; i++)
		{
			const p = FRONT_POS[i];
			const lit = (mask >> p) & 1;
			if (lit) { if (p < 4) litA = true; else litB = true; }
			this.setEl(u, E_FRONT + i, lit ? (p < 4 ? A : B) : null);
		}
		this.setEl(u, E_TKD, u.takedown ? this.white : null);
		this.setEl(u, E_TKD + 1, u.takedown ? this.white : null);
		for (let p = 0; p < 8; p++)
		{
			let c: number[] = null;
			if (u.stage === 1) c = (ta >> p) & 1 ? this.amber : null;
			else if ((mask >> p) & 1) c = p < 4 ? A : B;
			this.setEl(u, E_REAR + p, c);
		}
		this.setEl(u, E_ALLEY, u.alley ? this.white : null);
		this.setEl(u, E_ALLEY + 1, u.alley ? this.white : null);
		const full = u.stage >= 2;
		this.setEl(u, E_GRILLE, full && gi === 0 ? A : null);
		this.setEl(u, E_GRILLE + 1, full && gi === 2 ? B : null);
		const wig = full && this.settings.wigwag;
		this.setEl(u, E_WIG, wig && wi === 0 ? this.white : null);
		this.setEl(u, E_WIG + 1, wig && wi === 1 ? this.white : null);
		if (u.stage === 1)
		{
			this.setEl(u, E_DECK, di === 0 ? this.amber : null);
			this.setEl(u, E_DECK + 1, di === 1 ? this.amber : null);
		}
		else
		{
			this.setEl(u, E_DECK, full && gi === 2 ? A : null);
			this.setEl(u, E_DECK + 1, full && gi === 0 ? B : null);
		}
		u.litA = litA || (full && gi === 0);
		u.litB = litB || (full && gi === 2);
		u.colorAttr.needsUpdate = true;
		u.led.visible = u.stage > 0 || u.takedown || u.alley;   // idle bar: no LED draw call
		// beams
		const anyBeam = u.takedown || u.alley;
		u.beam.visible = anyBeam;
		if (anyBeam)
		{
			const bc = u.beamColors, n = u.beamVerts;
			for (let b = 0; b < 3; b++)
			{
				const on = b === 0 ? u.takedown : u.alley;
				for (let k = 0; k < n; k++)
				{
					const apex = k % 3 === 0;
					const v = on ? (apex ? 0.16 : 0.0) : 0;
					const o = (b * n + k) * 3;
					bc[o] = v; bc[o + 1] = v; bc[o + 2] = v * 0.95;
				}
			}
			u.beamAttr.needsUpdate = true;
		}
	}

	private setEl(u: ELSUnit, e: number, c: number[]): void
	{
		const a = u.colors;
		const r = c ? c[0] : 0, g = c ? c[1] : 0, b = c ? c[2] : 0;
		const o = e * 18;
		for (let k = 0; k < 18; k += 3) { a[o + k] = r; a[o + k + 1] = g; a[o + k + 2] = b; }
	}

	// ------------------------------------------------------------------ pooled lights

	private makeLights(): void
	{
		let n = this.settings.pooledLights;
		if (n === 'auto' || typeof n !== 'number') n = this.ctx.presetName === 'low' ? 0 : this.ctx.presetName === 'high' ? 2 : 1;
		if (this.ctx.presetName === 'low' && this.settings.pooledLights === 'auto') n = 0;
		n = clamp(Math.round(n), 0, 2);
		for (let i = 0; i < n; i++)
		{
			const l = new THREE.PointLight(0xffffff, 0, 14, 2);
			l.castShadow = false;
			l.name = 'elsPooledLight' + i;
			this.ctx.world.graphicsWorld.add(l);
			this.lights.push(l);
		}
		this.stats.lights = n;
	}

	private updateLights(): void
	{
		if (this.lights.length === 0) return;
		const w: any = this.ctx.world;
		const cam = w.camera ? w.camera.position : this.tmpV2.set(0, 0, 0);
		// nearest active unit (the one you drive first)
		let best: ELSUnit = null, bd = 1e18, tk: ELSUnit = null, td = 1e18;
		for (let i = 0; i < this.units.length; i++)
		{
			const u = this.units[i];
			if (!u.car.parent) continue;
			const d = u === this.driven ? -1 : u.car.position.distanceToSquared(cam);
			if (u.stage >= 2 && d < bd) { bd = d; best = u; }
			if ((u.takedown || u.alley) && d < td) { td = d; tk = u; }
		}
		const l0 = this.lights[0];
		if (best && bd < 120 * 120 && (best.litA || best.litB))
		{
			const c = best.litA ? this.colA : this.colB;
			l0.color.setRGB(c[0], c[1], c[2]);
			this.tmpV.set(0, best.barY + 0.25, best.barZ).applyMatrix4(best.car.matrixWorld);
			l0.position.copy(this.tmpV);
			l0.intensity = 2.2;
		}
		else l0.intensity = 0;
		if (this.lights.length > 1)
		{
			const l1 = this.lights[1];
			if (tk && td < 120 * 120)
			{
				l1.color.setRGB(1, 1, 0.95);
				if (tk.takedown) this.tmpV.set(0, 1.0, tk.frontZ + 4);
				else this.tmpV.set(3.5, 1.0, 0);
				this.tmpV.applyMatrix4(tk.car.matrixWorld);
				l1.position.copy(this.tmpV);
				l1.intensity = 1.6;
			}
			else l1.intensity = 0;
		}
	}

	// ------------------------------------------------------------------ audio

	private ensureAudio(): any
	{
		if (this.audio) return this.audio;
		const w: any = this.ctx.world;
		try
		{
			const wa = w.realismWeapons && w.realismWeapons.audio;
			if (wa && wa.ctx) { this.audio = wa.ctx; return this.audio; }
			const win: any = typeof window !== 'undefined' ? window : null;
			const AC = win && (win.AudioContext || win.webkitAudioContext);
			if (!AC) return null;
			this.audio = new AC();
		}
		catch (e) { this.audio = null; }
		return this.audio;
	}

	private out(): any
	{
		const ac = this.ensureAudio();
		if (!ac) return null;
		if (!this.master)
		{
			try
			{
				this.master = ac.createGain();
				this.master.gain.value = 1;
				this.master.connect(ac.destination);
			}
			catch (e) { this.master = null; }
		}
		try { if (ac.state === 'suspended' && ac.resume) ac.resume(); } catch (e) { /* ignore */ }
		return this.master;
	}

	private startSiren(u: ELSUnit): void
	{
		if (u.sirenNodes) return;
		const master = this.out();
		if (!master) return;
		const ac = this.audio;
		try
		{
			const tp = TONE_PARAMS[u.tone];
			const car = ac.createOscillator();
			car.type = 'sawtooth';
			car.frequency.value = tp.base;
			const lfo = ac.createOscillator();
			lfo.type = tp.wave;
			lfo.frequency.value = tp.rate;
			const depth = ac.createGain();
			depth.gain.value = tp.depth;
			lfo.connect(depth);
			depth.connect(car.frequency);
			const filt = ac.createBiquadFilter();
			filt.type = 'lowpass';
			filt.frequency.value = 2600;
			const g = ac.createGain();
			g.gain.value = 0;
			car.connect(filt);
			filt.connect(g);
			g.connect(master);
			car.start(); lfo.start();
			u.sirenNodes = { car: car, lfo: lfo, depth: depth, filt: filt, gain: g, level: -1 };
			this.stats.sirenNodesStarted++;
		}
		catch (e) { u.sirenNodes = null; }
	}

	private retone(u: ELSUnit): void
	{
		const n = u.sirenNodes;
		if (!n) return;
		const tp = TONE_PARAMS[u.tone];
		try
		{
			n.car.frequency.value = tp.base;
			n.lfo.type = tp.wave;
			n.lfo.frequency.value = tp.rate;
			n.depth.gain.value = tp.depth;
		}
		catch (e) { /* ignore */ }
	}

	private stopSiren(u: ELSUnit, keepState?: boolean): void
	{
		const n = u.sirenNodes;
		if (!n) return;
		u.sirenNodes = null;
		try
		{
			const t = this.audio.currentTime || 0;
			n.gain.gain.setTargetAtTime ? n.gain.gain.setTargetAtTime(0, t, 0.03) : (n.gain.gain.value = 0);
			n.car.stop(t + 0.15); n.lfo.stop(t + 0.15);
			setTimeout(() => { try { n.car.disconnect(); n.lfo.disconnect(); n.depth.disconnect(); n.filt.disconnect(); n.gain.disconnect(); } catch (e) { /* gone */ } }, 300);
		}
		catch (e) { /* ignore */ }
		this.stats.sirenNodesStopped++;
		void keepState;
	}

	/** Siren loudness: full inside the car, fading with distance outside. */
	private sirenGain(u: ELSUnit, cam: THREE.Vector3): void
	{
		const n = u.sirenNodes;
		const vol = this.volume() * this.settings.sirenVolume;
		let level: number;
		if (u === this.driven) level = vol * 0.55;
		else
		{
			const d = cam ? u.car.position.distanceTo(cam) : 0;
			const R = this.settings.sirenRange;
			level = d >= R ? 0 : vol * 0.8 * (12 / (12 + d)) * (1 - d / R);
		}
		if (Math.abs(level - n.level) < 0.004) return;
		n.level = level;
		try
		{
			const g = n.gain.gain;
			if (g.setTargetAtTime) g.setTargetAtTime(level, this.audio.currentTime || 0, 0.05); else g.value = level;
		}
		catch (e) { /* ignore */ }
	}

	private volume(): number
	{
		const v = (this.ctx.world as any).realismVolume;
		return typeof v === 'number' ? clamp(v, 0, 1) : 1;
	}

	private muteAll(mute: boolean): void
	{
		for (let i = 0; i < this.units.length; i++)
		{
			const n = this.units[i].sirenNodes;
			if (!n) continue;
			n.level = -1;
			if (mute) { try { n.gain.gain.value = 0; if (n.gain.gain.cancelScheduledValues) n.gain.gain.cancelScheduledValues(0); n.gain.gain.value = 0; } catch (e) { /* ignore */ } }
			if (this.units[i].hornNodes && mute) this.setHorn(this.units[i], false);
		}
	}

	public setHorn(u: ELSUnit, on: boolean): void
	{
		if (on === !!u.hornNodes) { u.horn = on; return; }
		u.horn = on;
		u.dirty = true;
		if (!on)
		{
			const n = u.hornNodes;
			u.hornNodes = null;
			try
			{
				const t = this.audio.currentTime || 0;
				n.g.gain.setTargetAtTime ? n.g.gain.setTargetAtTime(0, t, 0.025) : (n.g.gain.value = 0);
				n.a.stop(t + 0.12); n.b.stop(t + 0.12);
				setTimeout(() => { try { n.a.disconnect(); n.b.disconnect(); n.f.disconnect(); n.g.disconnect(); } catch (e) { /* gone */ } }, 250);
			}
			catch (e) { /* ignore */ }
			return;
		}
		const master = this.out();
		if (!master) return;
		const ac = this.audio;
		try
		{
			const a = ac.createOscillator(), b = ac.createOscillator();
			a.type = 'square'; b.type = 'sawtooth';
			a.frequency.value = 292; b.frequency.value = 366;
			const f = ac.createBiquadFilter();
			f.type = 'lowpass'; f.frequency.value = 1900;
			const g = ac.createGain();
			let level = this.volume() * this.settings.sirenVolume * 0.6;
			if (u !== this.driven)
			{
				const cam = (this.ctx.world as any).camera;
				const d = cam ? u.car.position.distanceTo(cam.position) : 0;
				level *= 12 / (12 + d);
			}
			g.gain.value = level;
			a.connect(f); b.connect(f); f.connect(g); g.connect(master);
			a.start(); b.start();
			u.hornNodes = { a: a, b: b, f: f, g: g };
		}
		catch (e) { u.hornNodes = null; }
	}

	// ------------------------------------------------------------------ input + HUD

	private drivenUnit(): ELSUnit
	{
		const v: any = playerVehicle(this.ctx.world);
		return v && v.realismELS ? v.realismELS : null;
	}

	private bindInput(): void
	{
		try
		{
			if (typeof window === 'undefined' || !(window as any).addEventListener) return;
			window.addEventListener('keydown', (e: KeyboardEvent) => this.onKey(e, true), false);
			window.addEventListener('keyup', (e: KeyboardEvent) => this.onKey(e, false), false);
		}
		catch (e) { /* headless */ }
	}

	/** Public for tests. Returns true when the key was used. */
	public onKey(e: any, down: boolean): boolean
	{
		const w: any = this.ctx.world;
		const u = this.drivenUnit();
		if (!u) return false;
		const K = this.keys;
		if (!down)
		{
			if (e.code === K.horn && u.horn) { this.setHorn(u, false); return true; }
			return false;
		}
		if (w.realismPaused || w.realismUIBlocking) return false;
		const t: any = e.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false;
		if (e.ctrlKey || e.altKey || e.metaKey) return false;
		if (e.code === K.horn) { if (!e.repeat) this.setHorn(u, true); return true; }
		if (e.repeat) return false;
		if (e.code === K.stage)
		{
			if (e.shiftKey) { this.setStage(u, 0); u.takedown = false; u.alley = false; u.dirty = true; }
			else this.setStage(u, (u.stage + 1) % 4);
		}
		else if (e.code === K.siren) this.setSiren(u, !u.siren);
		else if (e.code === K.tone) { u.tone = (u.tone + 1) % TONES.length; this.retone(u); u.dirty = true; }
		else if (e.code === K.pattern) this.setPattern(u, (u.stage === 1 ? u.taPattern : u.pattern) + 1);
		else if (e.code === K.takedown) { u.takedown = !u.takedown; u.dirty = true; }
		else if (e.code === K.alley) { u.alley = !u.alley; u.dirty = true; }
		else return false;
		return true;
	}

	private keyName(code: string): string { return String(code || '').replace(/^Key|^Digit/, ''); }

	private updateHud(): void
	{
		const u = this.settings.hud ? this.driven : null;
		const w: any = this.ctx.world;
		let key = '';
		if (u && !w.realismPaused)
		{
			key = u.stage + '|' + u.pattern + '|' + u.taPattern + '|' + (u.siren ? 1 : 0) + '|' + u.tone + '|' + (u.takedown ? 1 : 0) + '|' + (u.alley ? 1 : 0) + '|' + (u.horn ? 1 : 0) + '|' + (u.car.realismPolice ? u.car.realismPolice.unit : '');
		}
		if (key === this.hudKey) return;
		this.hudKey = key;
		this.ensureHud();
		if (!this.hud) return;
		if (!key) { this.hud.style.display = 'none'; return; }
		const K = this.keys, n = (c: string) => this.keyName(c);
		const pol = u.car.realismPolice || { dept: 'police', unit: '' };
		const stageName = ['OFF', 'STAGE 1 (TRAFFIC)', 'STAGE 2 (LIGHTS)', 'STAGE 3 (LIGHTS + SIREN)'][u.stage];
		const pat = u.stage === 1 ? TA_PATTERNS[u.taPattern].name : PATTERNS[u.pattern].name;
		const dot = (on: boolean, c: string) => '<span style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:3px;background:' + (on ? c : '#333') + '"></span>';
		const A = this.css(this.colA), B = this.css(this.colB);
		this.hud.innerHTML =
			'<div style="font-weight:bold;letter-spacing:1px;margin-bottom:3px">' + (pol.dept === 'sheriff' ? 'SHERIFF' : 'POLICE') + ' ' + pol.unit + ' &middot; ELS</div>' +
			'<div>' + dot(u.stage >= 2, A) + dot(u.stage >= 2, B) + dot(u.stage === 1, '#ffa000') + ' ' + stageName + '</div>' +
			'<div>Pattern: ' + pat + '</div>' +
			'<div>Siren: ' + TONES[u.tone] + (u.siren ? ' <b style="color:#ff5a4a">ON</b>' : ' off') + (u.horn ? ' &middot; <b>HORN</b>' : '') + '</div>' +
			'<div>' + (u.takedown ? '<b>TAKEDOWN</b> ' : 'takedown ') + (u.alley ? '<b>ALLEY</b>' : 'alley') + '</div>' +
			'<div style="opacity:0.65;margin-top:3px;font-size:11px">' + n(K.stage) + ' stage &middot; Shift+' + n(K.stage) + ' off &middot; ' + n(K.siren) + ' siren &middot; ' + n(K.tone) + ' tone &middot; ' +
			n(K.horn) + ' horn &middot; ' + n(K.pattern) + ' pattern &middot; ' + n(K.takedown) + ' takedown &middot; ' + n(K.alley) + ' alley</div>';
		this.hud.style.display = '';
	}

	private css(c: number[]): string
	{
		return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')';
	}

	private ensureHud(): void
	{
		if (this.hud !== null) return;
		try
		{
			if (typeof document === 'undefined' || !document.body || !document.createElement) return;
			const h = document.createElement('div');
			h.style.cssText = 'position:fixed;right:14px;bottom:110px;z-index:9998;font:12px sans-serif;color:#fff;background:rgba(10,14,22,0.72);' +
				'padding:7px 10px;border-radius:6px;pointer-events:none;display:none;min-width:190px;max-width:260px;line-height:1.45;border-left:3px solid #2f6bff';
			document.body.appendChild(h);
			this.hud = h;
		}
		catch (e) { this.hud = null; }
	}

	public get hudText(): string { return this.hudKey; }
}
