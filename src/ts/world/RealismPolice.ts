/*
 * RealismPolice.ts
 * ----------------
 * Police and sheriff cars: the stock sedan (car.glb) painted gloss black (configurable; sheriff can be
 * two-tone), white POLICE / SHERIFF lettering on both front doors, the unit number on the rear doors,
 * the roof and the trunk lid, a roof lightbar, an optional push bar, and the full ELS (RealismELS.ts).
 *
 * Contract C3: (world as any).realismPolice = {
 *    spawnUnit(dept: 'police' | 'sheriff', opts?: { unit?: string; position?: THREE.Vector3; heading?: number }): Car | null
 *        a real drivable car with livery + ELS at that department's station parking (or at opts.position).
 *        Returns null only while car.glb is still loading; the car is then spawned once it is loaded
 *        (opts.onSpawn(car) is called either way).
 *    isPoliceCar(car): boolean
 *    applyLivery(car, dept, unit?)   turns any existing sedan into a police / sheriff car
 *    removeLivery(car)
 *    units()                         every live police / sheriff car
 * }
 *
 * Cost per police car: 4 door decal meshes + 1 roof/trunk decal mesh + 1 lightbar housing (+ push bar)
 * + 1 additive LED mesh (+ 1 beam mesh only while takedown / alley lights are on). One shared 1024x256
 * canvas atlas (words, 37 glyphs, star) and shared materials for every police car. Decal geometries are
 * cached per door model and unit text, so 10 cars with the same unit text share one geometry.
 */

import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
import { Car } from '../vehicles/Car';
import { loadSharedModel } from './RealismNPCs';
import { loadGLB } from './RealismAssets';
import { ensurePaint, setTwoTone, VehicleTuning } from './RealismVehicleTuning';
import { ELSSystem, LED_COUNT, QuadBuilder, CarLayout, barLayout, ATLAS_W, ATLAS_H } from './RealismELS';

export interface PoliceSettings
{
	enabled: boolean;
	color: number[];
	finish: string;
	lettering: number[];
	unitPrefix: string;
	firstUnit: number;
	pushBar: boolean;
	lightColors: { left: number[]; right: number[] };
	sheriff: { color: number[]; twoTone: boolean; upper: number[]; lower: number[]; split: number; unitPrefix: string; firstUnit: number; pushBar: boolean };
	mdtLaptop: { model: string; position: number[]; rotation: number[]; scale: number | number[] };
	els: any;
}

export const POLICE_DEFAULTS: PoliceSettings = {
	enabled: true,
	color: [0.035, 0.035, 0.04],
	finish: 'gloss',
	lettering: [1, 1, 1],
	unitPrefix: '1A',
	firstUnit: 12,
	pushBar: true,
	lightColors: { left: [1, 0.06, 0.04], right: [0.12, 0.3, 1] },
	sheriff: { color: [0.035, 0.035, 0.04], twoTone: false, upper: [0.86, 0.79, 0.62], lower: [0.13, 0.27, 0.17], split: 0.22, unitPrefix: 'S', firstUnit: 21, pushBar: true },
	mdtLaptop: { model: '', position: [0, 0.62, 0.62], rotation: [0, 180, 0], scale: 0.72 },
	els: {},
};

const GLYPHS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-';
const GLYPH_W = 38, GLYPH_H = 80;
// atlas regions, pixels [x, y, w, h]
const R_POLICE = [0, 0, 512, 96], R_SHERIFF = [512, 0, 512, 96], R_STAR = [440, 176, 80, 80];
function glyphRect(ch: string): number[]
{
	const i = GLYPHS.indexOf(ch);
	if (i < 0) return null;
	if (i < 26) return [i * GLYPH_W, 96, GLYPH_W, GLYPH_H];
	return [(i - 26) * GLYPH_W, 176, GLYPH_W, GLYPH_H];
}

export function cleanUnit(u: any): string
{
	let s = String(u === undefined || u === null ? '' : u).toUpperCase();
	const m = /^(\d+)-([A-Z]+)-(\d+)$/.exec(s);   // Jobs app call signs: 1-LINCOLN-59 -> 1L59
	if (m) s = m[1] + m[2].charAt(0) + m[3];
	return s.replace(/[^0-9A-Z-]/g, '').slice(0, 6);
}

function mergeCfg(base: any, over: any): any
{
	if (!over || typeof over !== 'object' || over instanceof Array) return over === undefined ? base : over;
	const out: any = {};
	for (const k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
	for (const k in over)
	{
		if (!over.hasOwnProperty(k)) continue;
		const b = out[k], o = over[k];
		out[k] = b && typeof b === 'object' && !(b instanceof Array) && o && typeof o === 'object' && !(o instanceof Array) ? mergeCfg(b, o) : o;
	}
	return out;
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

const layoutCache: { [uuid: string]: CarLayout } = {};

function measureLayout(car: any): CarLayout
{
	car.updateMatrixWorld(true);
	const inv = new THREE.Matrix4().getInverse(car.matrixWorld);
	const doorObjs: THREE.Object3D[] = [];
	(car.seats || []).forEach((s: any) => { if (s.door && s.door.doorObject) doorObjs.push(s.door.doorObject); });
	let body: any = null, bn = 0;
	car.traverse((o: any) =>
	{
		if (!o.isMesh || !o.visible || doorObjs.indexOf(o) >= 0 || (o.userData && (o.userData.realismLivery || o.userData.data))) return;
		const wheels = car.wheels || [];
		for (let i = 0; i < wheels.length; i++) if (wheels[i].wheelObject === o) return;
		const g: any = o.geometry;
		const n = g && g.attributes && g.attributes.position ? g.attributes.position.count : 0;
		if (n > bn) { bn = n; body = o; }
	});
	const key = body ? body.geometry.uuid : 'none';
	if (layoutCache[key]) return layoutCache[key];
	// fallback: stock sedan numbers
	const L: CarLayout = { roofY: 0.9, roofZ0: -0.75, roofZ1: 0.25, roofHalfW: 0.5, trunkY: 0.42, trunkZ: -1.12, frontZ: 1.28, grilleY: 0.12,
		headX: 0.42, headY: 0.2, headZ: 1.24, rearZ: -1.21, rearY: 0.28, halfW: 0.61 };
	if (body)
	{
		const m = new THREE.Matrix4().multiplyMatrices(inv, body.matrixWorld);
		const a = body.geometry.attributes.position;
		const P: number[] = [];
		const v = new THREE.Vector3();
		for (let i = 0; i < a.count; i++) { v.set(a.getX(i), a.getY(i), a.getZ(i)).applyMatrix4(m); P.push(v.x, v.y, v.z); }
		const scan = (f: (x: number, y: number, z: number) => boolean, k: number, max: boolean): number =>
		{
			let best = max ? -1e9 : 1e9;
			for (let i = 0; i < P.length; i += 3)
			{
				if (!f(P[i], P[i + 1], P[i + 2])) continue;
				const val = P[i + k];
				if (max ? val > best : val < best) best = val;
			}
			return Math.abs(best) > 1e8 ? NaN : best;
		};
		const ok = (n: number, d: number) => isFinite(n) ? n : d;
		L.halfW = ok(scan(() => true, 0, true), L.halfW);
		L.roofY = ok(scan((x) => Math.abs(x) < 0.25, 1, true), L.roofY);
		L.roofZ0 = ok(scan((x, y) => Math.abs(x) < 0.25 && y > L.roofY - 0.04, 2, false), L.roofZ0);
		L.roofZ1 = ok(scan((x, y) => Math.abs(x) < 0.25 && y > L.roofY - 0.04, 2, true), L.roofZ1);
		L.roofHalfW = ok(scan((x, y) => y > L.roofY - 0.06, 0, true), L.roofHalfW);
		L.frontZ = ok(scan((x, y) => Math.abs(x) < 0.3 && y > 0 && y < 0.3, 2, true), L.frontZ);
		L.rearZ = ok(scan((x, y) => Math.abs(x) < 0.3 && y > 0.1 && y < 0.35, 2, false), L.rearZ);
		L.trunkY = ok(scan((x, y, z) => Math.abs(x) < 0.3 && z < L.rearZ + 0.25, 1, true), L.trunkY);
		const tz0 = ok(scan((x, y, z) => Math.abs(x) < 0.3 && z < L.roofZ0 && y > L.trunkY - 0.03, 2, false), L.rearZ + 0.05);
		const tz1 = ok(scan((x, y, z) => Math.abs(x) < 0.3 && z < L.roofZ0 && y > L.trunkY - 0.03, 2, true), L.rearZ + 0.3);
		L.trunkZ = (tz0 + tz1) / 2;
		L.headX = Math.min(0.42, L.halfW - 0.16);
		L.headY = 0.2;
		L.headZ = ok(scan((x, y) => Math.abs(Math.abs(x) - L.headX) < 0.08 && y > 0.1 && y < 0.3, 2, true), L.frontZ);
		L.grilleY = 0.14;
		L.rearY = 0.28;
	}
	layoutCache[key] = L;
	return L;
}

const doorDecalCache: { [key: string]: THREE.BufferGeometry } = {};

/** Decal geometry on the outer face of a door mesh, in the door's own space. */
function doorDecal(door: any, side: number, kind: string, unit: string, dept: string): THREE.BufferGeometry
{
	const g: any = door.geometry;
	const key = g.uuid + '|' + side + '|' + kind + '|' + unit + '|' + dept;
	if (doorDecalCache[key]) return doorDecalCache[key];
	const a = g.attributes.position;
	let minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
	for (let i = 0; i < a.count; i++) { const y = a.getY(i), z = a.getZ(i); if (y < minY) minY = y; if (y > maxY) maxY = y; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
	const h = maxY - minY, len = maxZ - minZ;
	const y0 = minY + h * 0.28, y1 = minY + h * 0.6;
	let outX = side > 0 ? -1e9 : 1e9;
	for (let i = 0; i < a.count; i++)
	{
		const y = a.getY(i);
		if (y < y0 || y > y1) continue;
		const x = a.getX(i);
		if (side > 0 ? x > outX : x < outX) outX = x;
	}
	if (Math.abs(outX) > 1e8) outX = 0;
	const x = outX + side * 0.004;
	const cy = (y0 + y1) / 2, cz = (minZ + maxZ) / 2;
	const u = side > 0 ? [0, 0, -1] : [0, 0, 1];   // reads front-to-back seen from either side
	const vY = [0, 1, 0];
	const qb = new QuadBuilder();
	if (kind === 'word')
	{
		const r = dept === 'sheriff' ? R_SHERIFF : R_POLICE;
		const th = Math.min((y1 - y0) * 0.95, len * 0.9 / (r[2] / r[3]));
		qb.quad(x, cy, cz, u, vY, th * r[2] / r[3], th, r);
	}
	else
	{
		const th = Math.min((y1 - y0) * 0.85, 0.09);
		const gw = th * GLYPH_W / GLYPH_H * 1.15;
		const star = dept === 'sheriff';
		const total = unit.length * gw + (star ? th * 1.1 : 0);
		let off = -total / 2;
		const place = (w: number, r: number[]) =>
		{
			const c = off + w / 2;   // along u
			qb.quad(x, cy, cz + u[2] * c, u, vY, w, th, r);
			off += w;
		};
		if (star) place(th * 1.1, R_STAR);
		for (let i = 0; i < unit.length; i++) { const r = glyphRect(unit[i]); if (r) place(gw, r); else off += gw; }
	}
	const geo = qb.geometry(true, false);
	doorDecalCache[key] = geo;
	return geo;
}

const bodyDecalCache: { [key: string]: THREE.BufferGeometry } = {};

/** Roof + trunk lid unit numbers, in car space. */
function bodyDecal(L: CarLayout, unit: string, layoutKey: string): THREE.BufferGeometry
{
	const key = layoutKey + '|' + unit;
	if (bodyDecalCache[key]) return bodyDecalCache[key];
	const qb = new QuadBuilder();
	const U = [-1, 0, 0], V = [0, 0, 1];   // lying flat, top of the letters towards the front
	const row = (y: number, z: number, th: number, maxW: number) =>
	{
		let gw = th * GLYPH_W / GLYPH_H * 1.15;
		if (gw * unit.length > maxW) { const s = maxW / (gw * unit.length); gw *= s; th *= s; }
		let off = -gw * unit.length / 2;
		for (let i = 0; i < unit.length; i++)
		{
			const r = glyphRect(unit[i]);
			const c = off + gw / 2;
			if (r) qb.quad(-c, y, z, U, V, gw, th, r);
			off += gw;
		}
	};
	if (unit.length > 0)
	{
		const roofLen = L.roofZ1 - L.roofZ0;
		row(L.roofY + 0.006, L.roofZ0 + roofLen * 0.35, Math.min(0.32, roofLen * 0.5), L.roofHalfW * 1.6);
		row(L.trunkY + 0.008, L.trunkZ, 0.16, L.halfW * 1.1);
	}
	const geo = qb.geometry(true, false);
	bodyDecalCache[key] = geo;
	return geo;
}

// ---------------------------------------------------------------------------

export class PoliceSystem
{
	public updateOrder = 6;
	public api: any;
	public settings: PoliceSettings;
	public els: ELSSystem;
	public cars: any[] = [];
	public stats: { [k: string]: number } = { units: 0, spawned: 0 };
	private ctx: RealismCtx;
	private tuning: VehicleTuning;
	private gltf: any = null;
	private gltfState = 0;    // 0 loading, 1 ready, -1 failed
	private pending: { dept: string; opts: any }[] = [];
	private atlas: THREE.Texture = null;
	private decalMat: THREE.Material = null;
	private housingMat: THREE.Material = null;
	private unitCounter: { [dept: string]: number } = {};

	constructor(ctx: RealismCtx, tuning: VehicleTuning)
	{
		this.ctx = ctx;
		this.tuning = tuning;
		this.settings = mergeCfg(POLICE_DEFAULTS, (ctx.cfg as any).police || {});
		this.els = new ELSSystem(ctx, this);
		const self = this;
		this.api = {
			spawnUnit(dept: 'police' | 'sheriff', opts?: any): any { return self.spawnUnit(dept, opts); },
			isPoliceCar(car: any): boolean { return !!car && !!car.realismPolice; },
			applyLivery(car: any, dept: string, unit?: string): void { self.applyLivery(car, dept, unit); },
			removeLivery(car: any): void { self.removeLivery(car); },
			units(): any[] { return self.cars.slice(0); },
			get els(): any { return self.els.api; },
			get stats(): any { return self.stats; },
		};
		(ctx.world as any).realismPolice = this.api;
		loadSharedModel('build/assets/car.glb', (gltf: any) =>
		{
			this.gltf = gltf;
			this.gltfState = 1;
			const p = this.pending;
			this.pending = [];
			for (let i = 0; i < p.length; i++) this.spawnUnit(p[i].dept as any, p[i].opts);
		}, () => { this.gltfState = -1; this.pending = []; console.warn('[Realism] Police: car.glb could not be loaded'); });
	}

	// ------------------------------------------------------------------ shared resources

	private ensureShared(): void
	{
		if (this.decalMat) return;
		this.atlas = this.makeAtlas();
		const lc = this.settings.lettering || [1, 1, 1];
		const dm = new THREE.MeshLambertMaterial({ map: this.atlas, alphaTest: 0.5, color: new THREE.Color(lc[0], lc[1], lc[2]),
			emissive: new THREE.Color(0.12, 0.12, 0.12), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
		dm.name = 'policeDecals';
		const hm = new THREE.MeshLambertMaterial({ vertexColors: THREE.VertexColors });
		hm.name = 'policeLightbar';
		try { this.ctx.world.sky.csm.setupMaterial(dm); this.ctx.world.sky.csm.setupMaterial(hm); } catch (e) { /* no csm */ }
		this.decalMat = dm;
		this.housingMat = hm;
	}

	private makeAtlas(): THREE.Texture
	{
		const cv: any = document.createElement('canvas');
		cv.width = ATLAS_W; cv.height = ATLAS_H;
		const g: any = cv.getContext('2d');
		if (g)
		{
			g.clearRect(0, 0, ATLAS_W, ATLAS_H);
			g.textAlign = 'center'; g.textBaseline = 'middle';
			g.lineJoin = 'round';
			const word = (t: string, r: number[]) =>
			{
				g.font = 'bold 84px Arial Black, Arial, sans-serif';
				g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.85)';
				g.strokeText(t, r[0] + r[2] / 2, r[1] + r[3] / 2 + 2, r[2] - 16);
				g.fillStyle = '#ffffff';
				g.fillText(t, r[0] + r[2] / 2, r[1] + r[3] / 2 + 2, r[2] - 16);
			};
			word('POLICE', R_POLICE);
			word('SHERIFF', R_SHERIFF);
			g.font = 'bold 70px Arial, sans-serif';
			for (let i = 0; i < GLYPHS.length; i++)
			{
				const r = glyphRect(GLYPHS[i]);
				g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.85)';
				g.strokeText(GLYPHS[i], r[0] + r[2] / 2, r[1] + r[3] / 2 + 3, r[2] - 2);
				g.fillStyle = '#ffffff';
				g.fillText(GLYPHS[i], r[0] + r[2] / 2, r[1] + r[3] / 2 + 3, r[2] - 2);
			}
			// six-point sheriff star (gold)
			const cx = R_STAR[0] + R_STAR[2] / 2, cy = R_STAR[1] + R_STAR[3] / 2, ro = 36, ri = 17;
			g.beginPath();
			for (let k = 0; k < 12; k++)
			{
				const ang = -Math.PI / 2 + k * Math.PI / 6, rr = k % 2 === 0 ? ro : ri;
				const px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr;
				if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
			}
			g.closePath();
			g.fillStyle = '#d9b44a'; g.fill();
			g.lineWidth = 3; g.strokeStyle = '#3a2c08'; g.stroke();
		}
		const t = new THREE.CanvasTexture(cv);
		t.anisotropy = 4;
		return t;
	}

	// ------------------------------------------------------------------ livery

	public applyLivery(car: any, dept: string, unitIn?: string): void
	{
		if (!car || !car.rayCastVehicle) return;
		const d = dept === 'sheriff' ? 'sheriff' : 'police';
		let unit = cleanUnit(unitIn);
		if (!unit && car.realismPolice && car.realismPolice.dept === d) unit = car.realismPolice.unit;
		if (!unit) unit = this.nextUnit(d);
		if (car.realismPolice && car.realismPolice.dept === d && car.realismPolice.unit === unit) return;
		if (car.realismPolice) this.detachMeshes(car);
		this.ensureShared();
		const S = this.settings;
		const sh = S.sheriff;
		// paint
		const paint = ensurePaint(this.ctx, car);
		const twoTone = d === 'sheriff' && sh.twoTone;
		const base = twoTone ? sh.upper : (d === 'sheriff' ? sh.color : S.color);
		this.tuning.apply(car, { rgb: base, finish: S.finish || 'gloss', rgb2: twoTone ? sh.lower : null, split: sh.split });
		if (paint && !twoTone) setTwoTone(paint, car, null, 0);
		car.realismPolice = { dept: d, unit: unit, meshes: [] as THREE.Object3D[] };
		this.ensureMdtLaptop(car);
		// decals on the doors
		const meshes: THREE.Object3D[] = car.realismPolice.meshes;
		car.updateMatrixWorld(true);
		const inv = new THREE.Matrix4().getInverse(car.matrixWorld);
		const tmp = new THREE.Vector3();
		(car.seats || []).forEach((s: any) =>
		{
			const door: any = s.door && s.door.doorObject;
			if (!door || !door.isMesh || !door.geometry || !door.geometry.attributes.position) return;
			// rotate-free door position in car space tells side and front / rear
			tmp.setFromMatrixPosition(door.matrixWorld).applyMatrix4(inv);
			const side = tmp.x >= 0 ? 1 : -1;
			const front = s.type === 'driver' || tmp.z > -0.1;
			const geo = doorDecal(door, side, front ? 'word' : 'unit', unit, d);
			const m = new THREE.Mesh(geo, this.decalMat);
			m.userData.realismLivery = true;
			m.castShadow = false; m.receiveShadow = true;
			m.name = 'policeDecal_' + (front ? 'word' : 'unit');
			door.add(m);
			meshes.push(m);
		});
		// roof + trunk numbers, lightbar, push bar, LEDs
		const L = measureLayout(car);
		const lkey = JSON.stringify(L);
		const bm = new THREE.Mesh(bodyDecal(L, unit, lkey), this.decalMat);
		bm.userData.realismLivery = true; bm.castShadow = false; bm.receiveShadow = true; bm.name = 'policeDecal_body';
		car.add(bm); meshes.push(bm);
		const pushBar = d === 'sheriff' ? sh.pushBar !== false : S.pushBar !== false;
		const hous = new THREE.Mesh(this.housingGeometry(L, pushBar, lkey), this.housingMat);
		hous.userData.realismLivery = true; hous.castShadow = !!this.ctx.preset.shadows; hous.receiveShadow = true; hous.name = 'policeLightbar';
		car.add(hous); meshes.push(hous);
		const led = this.els.attach(car, L);
		for (let i = 0; i < led.length; i++) { led[i].userData.realismLivery = true; car.add(led[i]); meshes.push(led[i]); }
		if (this.cars.indexOf(car) < 0) this.cars.push(car);
		this.stats.units = this.cars.length;
	}

	private ensureMdtLaptop(car: any): void
	{
		const police = car && car.realismPolice;
		if (!police || police.mdtLaptop) return;
		const settings = this.settings.mdtLaptop;
		const group = new THREE.Group();
		group.name = 'policeMdtLaptop';
		const position = settings && settings.position;
		const rotation = settings && settings.rotation;
		const scale = settings && settings.scale;
		const finite = (value: any, fallback: number): number =>
			typeof value === 'number' && isFinite(value) ? value : fallback;
		group.position.set(
			finite(position && position[0], 0),
			finite(position && position[1], 0.62),
			finite(position && position[2], 0.62));
		group.rotation.set(
			finite(rotation && rotation[0], 0) * Math.PI / 180,
			finite(rotation && rotation[1], 180) * Math.PI / 180,
			finite(rotation && rotation[2], 0) * Math.PI / 180);
		if (Array.isArray(scale))
		{
			group.scale.set(
				Math.max(0.01, finite(scale[0], 0.72)),
				Math.max(0.01, finite(scale[1], 0.72)),
				Math.max(0.01, finite(scale[2], 0.72)));
		}
		else
		{
			const uniform = typeof scale === 'number' && isFinite(scale) && scale > 0 ? scale : 0.72;
			group.scale.setScalar(uniform);
		}
		car.add(group);
		police.mdtLaptop = group;
		police.meshes.push(group);

		const model = settings && typeof settings.model === 'string' ? settings.model.trim() : '';
		if (!model) { this.addMdtLaptopFallback(group); return; }
		loadGLB(model, (scene: THREE.Object3D) =>
		{
			if (!car.realismPolice || car.realismPolice.meshes.indexOf(group) < 0) return;
			while (group.children.length) group.remove(group.children[0]);
			group.add(scene.clone(true));
		}, () => this.addMdtLaptopFallback(group));
	}

	private addMdtLaptopFallback(group: THREE.Group): void
	{
		const frame = new THREE.MeshLambertMaterial({ color: 0x171a1e });
		const screen = new THREE.MeshLambertMaterial({ color: 0x17324a, emissive: 0x07121d, side: THREE.DoubleSide });
		const base = new THREE.Mesh(new THREE.BoxBufferGeometry(0.38, 0.025, 0.27), frame);
		base.position.set(0, 0.015, 0);
		const lid = new THREE.Mesh(new THREE.BoxBufferGeometry(0.38, 0.24, 0.018), frame);
		lid.position.set(0, 0.135, -0.12);
		const display = new THREE.Mesh(new THREE.BoxBufferGeometry(0.34, 0.195, 0.003), screen);
		display.position.set(0, 0.135, -0.109);
		group.add(base, lid, display);
	}

	private detachMeshes(car: any): void
	{
		const pol = car.realismPolice;
		if (!pol) return;
		for (let i = 0; i < pol.meshes.length; i++) { const m = pol.meshes[i]; if (m.parent) m.parent.remove(m); }
		pol.meshes = [];
		this.els.detach(car);
	}

	public removeLivery(car: any): void
	{
		if (!car || !car.realismPolice) return;
		this.detachMeshes(car);
		car.realismPolice = undefined;
		const p = car.realismPaint;
		if (p)
		{
			setTwoTone(p, car, null, 0);
			const s = p.stockColor;
			this.tuning.apply(car, { rgb: [s.r, s.g, s.b], finish: 'stock' });
			car.realismTunedRgb = null;
		}
		const i = this.cars.indexOf(car);
		if (i >= 0) this.cars.splice(i, 1);
		this.stats.units = this.cars.length;
	}

	private housingCache: { [k: string]: THREE.BufferGeometry } = {};

	private housingGeometry(L: CarLayout, pushBar: boolean, lkey: string): THREE.BufferGeometry
	{
		const key = lkey + '|' + pushBar;
		if (this.housingCache[key]) return this.housingCache[key];
		const qb = new QuadBuilder();
		const bar = barLayout(L);
		const dark = [0.06, 0.06, 0.07];
		const A = this.settings.lightColors.left, B = this.settings.lightColors.right;
		const lens = (c: number[]) => [0.12 + c[0] * 0.22, 0.12 + c[1] * 0.22, 0.12 + c[2] * 0.22];
		// base strip + housing
		qb.box(0, bar.y - bar.h / 2 - 0.012, bar.z, bar.w * 0.86, 0.024, bar.d * 0.8, dark);
		qb.box(0, bar.y, bar.z, bar.w, bar.h, bar.d, dark);
		// tinted lenses (visible when the LEDs are off)
		for (let i = 0; i < 8; i++)
		{
			const x = bar.segX[i], c = i < 4 ? A : B, w = i === 3 || i === 4 ? 0.07 : 0.1;
			const lc = (i === 3 || i === 4) ? [0.5, 0.5, 0.5] : lens(c);
			qb.quad(x, bar.y, bar.z + bar.d / 2 + 0.001, [1, 0, 0], [0, 1, 0], w, bar.h * 0.7, null, lc);
			qb.quad(x, bar.y, bar.z - bar.d / 2 - 0.001, [-1, 0, 0], [0, 1, 0], w, bar.h * 0.7, null, i < 4 ? lens(A) : lens(B));
		}
		if (pushBar)
		{
			const z = L.frontZ + 0.07;
			const steel = [0.08, 0.08, 0.09];
			qb.box(0.24, L.grilleY + 0.02, z, 0.035, 0.3, 0.035, steel);
			qb.box(-0.24, L.grilleY + 0.02, z, 0.035, 0.3, 0.035, steel);
			qb.box(0, L.grilleY + 0.12, z + 0.01, 0.56, 0.035, 0.035, steel);
			qb.box(0, L.grilleY - 0.07, z + 0.01, 0.56, 0.035, 0.035, steel);
			qb.box(0.24, L.grilleY - 0.12, z - 0.05, 0.03, 0.03, 0.12, steel);
			qb.box(-0.24, L.grilleY - 0.12, z - 0.05, 0.03, 0.03, 0.12, steel);
		}
		const g = qb.geometry(false, true);
		this.housingCache[key] = g;
		return g;
	}

	// ------------------------------------------------------------------ units

	private nextUnit(dept: string): string
	{
		const S = this.settings;
		const prefix = cleanUnit(dept === 'sheriff' ? S.sheriff.unitPrefix : S.unitPrefix);
		if (this.unitCounter[dept] === undefined) this.unitCounter[dept] = (dept === 'sheriff' ? S.sheriff.firstUnit : S.firstUnit) || 1;
		const n = this.unitCounter[dept]++;
		return cleanUnit(prefix + n);
	}

	/** Station parking spots of a department: the scenario's car spawns. */
	public stationSpots(dept: string): { x: number; y: number; z: number; rot: number }[]
	{
		const data: any = this.ctx.data;
		const out: { x: number; y: number; z: number; rot: number }[] = [];
		const scs: any[] = data.scenarios || [];
		for (let i = 0; i < scs.length; i++)
		{
			if (scs[i].id !== dept) continue;
			for (let k = 0; k < scs[i].spawns.length; k++)
			{
				const s = scs[i].spawns[k];
				if (s.type === 'car') out.push({ x: s.x, y: s.y, z: s.z, rot: s.rot });
			}
		}
		if (out.length === 0)
		{
			// any station building of that department: park in front of it
			const bs: any[] = data.buildings || [];
			for (let i = 0; i < bs.length; i++)
			{
				const b = bs[i];
				if (b.custom !== dept || b.role !== 'station') continue;
				const fx = Math.sin(b.rot), fz = Math.cos(b.rot);
				const x = b.x + fx * (b.d / 2 + 10), z = b.z + fz * (b.d / 2 + 10);
				out.push({ x: x, y: data.heightAt(x, z) + 0.6, z: z, rot: b.rot });
			}
		}
		return out;
	}

	private freeSpot(dept: string): { x: number; y: number; z: number; rot: number }
	{
		const spots = this.stationSpots(dept);
		if (spots.length === 0) return null;
		const vs: any[] = this.ctx.world.vehicles || [];
		const busy = (x: number, z: number) =>
		{
			for (let i = 0; i < vs.length; i++)
			{
				const p = vs[i].collision ? vs[i].collision.position : vs[i].position;
				if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 3.2 * 3.2) return true;
			}
			return false;
		};
		for (let ring = 0; ring < 6; ring++)
		{
			for (let i = 0; i < spots.length; i++)
			{
				const s = spots[i];
				// line up sideways next to the stock spot (along the car's right)
				const off = ring * 3.4;
				const x = s.x + Math.cos(s.rot) * off, z = s.z - Math.sin(s.rot) * off;
				if (!busy(x, z)) return { x: x, y: ring === 0 ? s.y : this.ctx.data.heightAt(x, z) + 0.6, z: z, rot: s.rot };
			}
		}
		return spots[0];
	}

	public spawnUnit(dept: 'police' | 'sheriff', opts?: any): any
	{
		const d = dept === 'sheriff' ? 'sheriff' : 'police';
		const o = opts || {};
		if (this.gltfState === 0) { this.pending.push({ dept: d, opts: o }); return null; }
		if (this.gltfState < 0) return null;
		let x: number, y: number, z: number, rot: number;
		if (o.position && isFinite(o.position.x))
		{
			x = o.position.x; z = o.position.z;
			y = isFinite(o.position.y) ? o.position.y : this.ctx.data.heightAt(x, z) + 0.6;
			rot = typeof o.heading === 'number' ? o.heading : 0;
		}
		else
		{
			const s = this.freeSpot(d);
			if (!s) { console.warn('[Realism] Police: no station parking for ' + d); return null; }
			x = s.x; y = s.y; z = s.z;
			rot = typeof o.heading === 'number' ? o.heading : s.rot;
		}
		const car: any = new Car({ scene: this.gltf.scene.clone(true), animations: [] as any[] });
		const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
		const b: any = car.collision;
		b.position.set(x, y + 0.4, z);
		b.quaternion.set(q.x, q.y, q.z, q.w);
		if (b.previousPosition) b.previousPosition.copy(b.position);
		if (b.interpolatedPosition) b.interpolatedPosition.copy(b.position);
		if (b.interpolatedQuaternion) b.interpolatedQuaternion.copy(b.quaternion);
		if (b.initPosition) b.initPosition.copy(b.position);
		if (b.initQuaternion) b.initQuaternion.copy(b.quaternion);
		car.position.set(x, y + 0.4, z);
		car.quaternion.copy(q);
		const marker = new THREE.Object3D();
		marker.position.set(x, y + 0.5, z);
		marker.quaternion.copy(q);
		marker.updateMatrixWorld(true);
		car.spawnPoint = marker;   // out-of-bounds respawn
		this.ctx.world.add(car);
		car.updateMatrixWorld(true);
		let unit = cleanUnit(o.unit);
		if (!unit)
		{
			const job = (this.ctx.world as any).realismJob;
			if (job && job.id === d && job.unit) unit = cleanUnit(job.unit);
		}
		this.applyLivery(car, d, unit);
		car.realismType = d;
		this.stats.spawned++;
		if (typeof o.onSpawn === 'function') { try { o.onSpawn(car); } catch (e) { console.warn('[Realism] spawnUnit onSpawn threw', e); } }
		return car;
	}

	/** Called for every scenario / config vehicle spawn (RealismVehicles.realismVehicleSpawned). */
	public onSpawned(vehicle: any, type: string, vt: any): void
	{
		if (!vehicle || !vehicle.rayCastVehicle || !this.settings.enabled) return;
		vehicle.realismType = type;
		let dept: string = null;
		if (vt && (vt.livery === 'police' || vt.livery === 'sheriff')) dept = vt.livery;
		else if (type === 'police' || type === 'sheriff') dept = type;
		else if (type === 'policeCruiser' && !(vt && vt.model)) dept = 'police';
		// your own body model drawn over the stock car (sketchbookFormat false): the decals are fitted
		// to the stock sedan, so that car keeps its own look
		if (vt && vt.model && vt.sketchbookFormat === false) dept = null;
		if (!dept) return;
		this.applyLivery(vehicle, dept, vt && vt.unit);
	}

	public update(timeStep: number, unscaled: number): void
	{
		this.stats.units = this.cars.length;
		this.els.update(timeStep, unscaled);
	}
}

export { LED_COUNT };
