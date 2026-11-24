/*
 * RealismVehicleTuning.ts
 * -----------------------
 * Runtime tuning of Sketchbook cars: paint, ride height, suspension, steering, engine, brakes, grip.
 * Contract C3: (world as any).realismVehicleTuning = { apply(car, tuning), read(car), defaults(car?) }
 *
 * tuning = {
 *   rgb?: [r, g, b]            body paint 0..1 (only the body / door material, never glass, lights or wheels;
 *                              every car gets its own material copy the first time it is painted)
 *   finish?: 'stock' | 'gloss' | 'metallic' | 'matte'
 *   rgb2?: [r, g, b] | null    lower body colour for a two-tone paint (null = one colour)
 *   split?: number             height (car space, metres) of the two-tone line
 *   rideHeight?: number        metres added to the stock suspension rest length (-0.15 .. 0.15, 0 = stock)
 *   suspensionStiffness?: number   wheel spring stiffness (stock 20)
 *   damping?: number           suspension damping (relaxation + compression, stock 2)
 *   steeringSpeed?: number     multiplier on how fast the wheels turn (stock 1)
 *   maxSteer?: number          max steering angle in radians (stock 0.8)
 *   enginePower?: number       engine force (stock 500)
 *   topSpeed?: number          multiplier on every gear's top speed (stock 1)
 *   brakeForce?: number        multiplier on the braking force of S while rolling forwards (stock 1)
 *   grip?: number              tyre friction slip (stock 0.8)
 *   livery?: 'police' | 'sheriff' | null   handled by RealismPolice.ts (decals, lightbar, ELS)
 *   unit?: string              unit number shown by the livery
 * }
 * apply() only touches the fields that are present, works on an already-spawned car and wakes it up.
 * read() returns every field with the car's current values. defaults(car) returns the car's stock values.
 *
 * Owned cars: every 0.2 s the tuning saved on the car's owned record (realismOwnedCars.recordFor(car).tuning)
 * is re-applied when the car was (re)spawned or reused from the NPC car pool, so purchases survive reloads.
 */

import * as THREE from 'three';
import { RealismCtx } from './RealismContext';

export const STOCK_TUNING = {
	rgb: [1, 1, 1], finish: 'stock', rgb2: null as number[], split: 0.22,
	rideHeight: 0, suspensionStiffness: 20, damping: 2, steeringSpeed: 1, maxSteer: 0.8,
	enginePower: 500, topSpeed: 1, brakeForce: 1, grip: 0.8, livery: null as string, unit: '',
};

const NON_PAINT = /glass|window|windshield|light|lamp|wheel|tire|tyre|rim|chrome|interior|seat|steer|mirror|plate|grill|black|rubber/i;
const PAINT = /^car$|paint|body|carpaint|exterior|shell/i;

export interface PaintInfo
{
	mat: any;
	meshes: THREE.Mesh[];
	stockColor: THREE.Color;
	stockShininess: number;
	stockSpecular: THREE.Color;
	stockRoughness: number;
	stockMetalness: number;
	finish: string;
	twoTone: { color2: { value: THREE.Color }; split: { value: number }; carMatrix: { value: THREE.Matrix4 } };
}

/** The car the player is driving, or null. Sketchbook keeps the Character as the input receiver while it
 *  drives (it forwards keys to character.controlledObject); a vehicle can also be the receiver directly. */
export function playerVehicle(world: any): any
{
	const im: any = world ? world.inputManager : null;
	const r: any = im ? im.inputReceiver : null;
	if (!r) return null;
	const v: any = r.controlledObject ? r.controlledObject : r;
	return v && v.rayCastVehicle && v.controllingCharacter ? v : null;
}

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
function num(v: any): boolean { return typeof v === 'number' && isFinite(v); }

function isUnderWheel(car: any, o: THREE.Object3D): boolean
{
	const wheels = car.wheels || [];
	let p: THREE.Object3D = o;
	while (p)
	{
		for (let i = 0; i < wheels.length; i++) if (wheels[i].wheelObject === p) return true;
		p = p.parent;
	}
	return false;
}

/** Finds the body paint meshes of a car (stock car.glb: material 'Car', minus the steering wheel). */
function findPaintMeshes(car: any): THREE.Mesh[]
{
	const stock: THREE.Mesh[] = [], guess: THREE.Mesh[] = [];
	car.traverse((o: any) =>
	{
		if (!o.isMesh || !o.material || o.material instanceof Array) return;
		if (o.userData && (o.userData.realismLivery || o.userData.data === 'steering_wheel' || o.userData.data === 'collision' || o.userData.data === 'navmesh')) return;
		if (isUnderWheel(car, o)) return;
		const n = String(o.material.name || '');
		if (o.visible && n === 'Car') stock.push(o);
		else if (o.visible && PAINT.test(n) && !NON_PAINT.test(n) && !NON_PAINT.test(o.name || '')) guess.push(o);
	});
	if (stock.length > 0) return stock;
	if (guess.length > 0) return guess;
	// a dressed model with unnamed materials: the visible mesh with the most vertices is the body
	let best: any = null, bv = 0;
	car.traverse((o: any) =>
	{
		if (!o.isMesh || !o.visible || !o.material || o.material instanceof Array || o.userData.realismLivery) return;
		if (isUnderWheel(car, o) || NON_PAINT.test(String(o.material.name || '')) || NON_PAINT.test(o.name || '')) return;
		const g: any = o.geometry;
		const n = g && g.attributes && g.attributes.position ? g.attributes.position.count : 0;
		if (n > bv) { bv = n; best = o; }
	});
	return best ? [best] : [];
}

/** Gives the car ONE paint material of its own (shared by its body and doors, never by another car
 *  or an InstancedMesh) and returns it. Created once per car. */
export function ensurePaint(ctx: RealismCtx, car: any): PaintInfo
{
	if (car.realismPaint) return car.realismPaint;
	const meshes = findPaintMeshes(car);
	if (meshes.length === 0) return null;
	const src: any = meshes[0].material;
	const mat: any = src.clone();
	mat.name = src.name || 'Car';
	if (mat.userData) { delete mat.userData.instancedCopy; delete mat.userData.realismBase; }
	try { ctx.world.sky.csm.setupMaterial(mat); } catch (e) { /* no csm */ }
	for (let i = 0; i < meshes.length; i++) meshes[i].material = mat;
	if (car.materials instanceof Array) car.materials.push(mat);
	const info: PaintInfo = {
		mat: mat, meshes: meshes,
		stockColor: mat.color ? mat.color.clone() : new THREE.Color(1, 1, 1),
		stockShininess: num(mat.shininess) ? mat.shininess : 30,
		stockSpecular: mat.specular ? mat.specular.clone() : new THREE.Color(0x111111),
		stockRoughness: num(mat.roughness) ? mat.roughness : 0.5,
		stockMetalness: num(mat.metalness) ? mat.metalness : 0,
		finish: 'stock', twoTone: null,
	};
	car.realismPaint = info;
	return info;
}

function setFinish(info: PaintInfo, finish: string): void
{
	const m = info.mat;
	const f = finish === 'gloss' || finish === 'metallic' || finish === 'matte' ? finish : 'stock';
	info.finish = f;
	if (m.isMeshStandardMaterial)
	{
		m.roughness = f === 'gloss' ? 0.25 : f === 'metallic' ? 0.32 : f === 'matte' ? 0.9 : info.stockRoughness;
		m.metalness = f === 'metallic' ? 0.65 : f === 'stock' ? info.stockMetalness : 0;
	}
	else if (m.specular)
	{
		if (f === 'gloss') { m.shininess = 70; m.specular.setScalar(0.32); }
		else if (f === 'metallic') { m.shininess = 110; m.specular.copy(m.color).multiplyScalar(0.45).addScalar(0.18); }
		else if (f === 'matte') { m.shininess = 0; m.specular.setScalar(0); }
		else { m.shininess = info.stockShininess; m.specular.copy(info.stockSpecular); }
	}
}

const TWO_TONE_VERT_HEAD = 'uniform mat4 rrCarMatrix;\nvarying float vRRY;\n';
const TWO_TONE_FRAG_HEAD = 'uniform vec3 rrColor2;\nuniform float rrSplit;\nvarying float vRRY;\n';

/** Two-tone paint: below `split` (car space height) the body uses color2. Shader patch, no extra draw call. */
export function setTwoTone(info: PaintInfo, car: any, rgb2: number[], split: number): void
{
	if (!rgb2)
	{
		if (info.twoTone) info.twoTone.split.value = -100;
		return;
	}
	if (!info.twoTone)
	{
		const tt = { color2: { value: new THREE.Color() }, split: { value: -100 }, carMatrix: { value: car.matrixWorld as THREE.Matrix4 } };
		info.twoTone = tt;
		const mat = info.mat;
		const prev = mat.onBeforeCompile;
		mat.onBeforeCompile = function (shader: any, renderer: any): void
		{
			if (prev) prev.call(this, shader, renderer);
			patchTwoTone(shader, (this as any).__rrTwoTone);
		};
		mat.__rrTwoTone = tt;
		mat.needsUpdate = true;
	}
	info.twoTone.carMatrix.value = car.matrixWorld;
	info.twoTone.color2.value.setRGB(clamp(rgb2[0], 0, 1), clamp(rgb2[1], 0, 1), clamp(rgb2[2], 0, 1));
	info.twoTone.split.value = num(split) ? split : STOCK_TUNING.split;
}

export function patchTwoTone(shader: any, tt: any): void
{
	if (!tt || !shader || typeof shader.vertexShader !== 'string') return;
	shader.uniforms.rrColor2 = tt.color2;
	shader.uniforms.rrSplit = tt.split;
	shader.uniforms.rrCarMatrix = tt.carMatrix;
	shader.vertexShader = TWO_TONE_VERT_HEAD + shader.vertexShader.replace('#include <begin_vertex>',
		'#include <begin_vertex>\n\t{ vec4 rrW = modelMatrix * vec4( transformed, 1.0 ); vRRY = dot( rrW.xyz - rrCarMatrix[3].xyz, normalize( rrCarMatrix[1].xyz ) ); }');
	shader.fragmentShader = TWO_TONE_FRAG_HEAD + shader.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );',
		'vec4 diffuseColor = vec4( mix( diffuse, rrColor2, step( vRRY, rrSplit ) ), opacity );');
}

export class VehicleTuning
{
	public updateOrder = 6;
	public api: any;
	private ctx: RealismCtx;
	private acc = 0;

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		const self = this;
		this.api = {
			apply(car: any, tuning: any): void { self.apply(car, tuning); },
			read(car: any): any { return self.read(car); },
			defaults(car?: any): any { return self.defaults(car); },
			paint(car: any, rgb: number[], finish?: string): void { self.apply(car, { rgb: rgb, finish: finish }); },
		};
		(ctx.world as any).realismVehicleTuning = this.api;
	}

	public isCar(car: any): boolean
	{
		return !!car && !!car.rayCastVehicle && car.steeringSimulator !== undefined && car.engineForce !== undefined;
	}

	/** Snapshot of the car's stock values, taken the first time it is tuned. */
	private stock(car: any): any
	{
		if (car.realismStock) return car.realismStock;
		const wi = car.rayCastVehicle && car.rayCastVehicle.wheelInfos && car.rayCastVehicle.wheelInfos[0];
		const s: any = {
			stiffness: wi ? wi.suspensionStiffness : STOCK_TUNING.suspensionStiffness,
			restLength: [] as number[],
			damping: wi ? wi.dampingRelaxation : STOCK_TUNING.damping,
			grip: wi ? wi.frictionSlip : STOCK_TUNING.grip,
			engine: num(car.engineForce) ? car.engineForce : STOCK_TUNING.enginePower,
			maxSteer: num(car.maxSteerVal) ? car.maxSteerVal : STOCK_TUNING.maxSteer,
			steeringMass: num(car.steeringMass) ? car.steeringMass : 10,
		};
		if (car.rayCastVehicle) for (let i = 0; i < car.rayCastVehicle.wheelInfos.length; i++) s.restLength.push(car.rayCastVehicle.wheelInfos[i].suspensionRestLength);
		car.realismStock = s;
		return s;
	}

	public defaults(car?: any): any
	{
		const d: any = JSON.parse(JSON.stringify(STOCK_TUNING));
		if (!car) return d;
		if (this.isCar(car))
		{
			const s = this.stock(car);
			d.suspensionStiffness = s.stiffness; d.damping = s.damping; d.grip = s.grip;
			d.enginePower = s.engine; d.maxSteer = s.maxSteer;
		}
		const p: PaintInfo = car.realismPaint;
		if (p) d.rgb = [p.stockColor.r, p.stockColor.g, p.stockColor.b];
		else
		{
			const m = findPaintMeshes(car);
			const c = m.length && (m[0].material as any).color;
			if (c) d.rgb = [c.r, c.g, c.b];
		}
		return d;
	}

	public read(car: any): any
	{
		const t = this.defaults(car);
		if (!car) return t;
		const p: PaintInfo = car.realismPaint;
		const pm: any = p ? p.mat : (findPaintMeshes(car)[0] || { material: null }).material;
		if (pm && pm.color) t.rgb = [round(pm.color.r), round(pm.color.g), round(pm.color.b)];
		if (p) t.finish = p.finish;
		if (p && p.twoTone && p.twoTone.split.value > -50)
		{
			const c = p.twoTone.color2.value;
			t.rgb2 = [round(c.r), round(c.g), round(c.b)];
			t.split = p.twoTone.split.value;
		}
		if (this.isCar(car))
		{
			const s = this.stock(car);
			const wi = car.rayCastVehicle.wheelInfos[0];
			if (wi)
			{
				t.rideHeight = round(wi.suspensionRestLength - s.restLength[0], 3);
				t.suspensionStiffness = wi.suspensionStiffness;
				t.damping = wi.dampingRelaxation;
				t.grip = wi.frictionSlip;
			}
			t.steeringSpeed = round(s.steeringMass / car.steeringMass, 3);
			t.maxSteer = car.maxSteerVal;
			t.enginePower = car.engineForce;
			t.topSpeed = car.topSpeedFactor;
			t.brakeForce = car.brakeFactor;
		}
		const pol = car.realismPolice;
		t.livery = pol ? pol.dept : null;
		t.unit = pol ? pol.unit : '';
		return t;
	}

	public apply(car: any, t: any): void
	{
		if (!car || !t || typeof t !== 'object') return;
		if (t.rgb instanceof Array && t.rgb.length >= 3)
		{
			const p = ensurePaint(this.ctx, car);
			if (p && p.mat.color) p.mat.color.setRGB(clamp(+t.rgb[0] || 0, 0, 1), clamp(+t.rgb[1] || 0, 0, 1), clamp(+t.rgb[2] || 0, 0, 1));
			if (p && t.finish === undefined && p.finish === 'metallic') setFinish(p, 'metallic');   // metallic flake follows the colour
		}
		if (typeof t.finish === 'string')
		{
			const p = ensurePaint(this.ctx, car);
			if (p) setFinish(p, t.finish);
		}
		if (t.rgb2 !== undefined)
		{
			const p = ensurePaint(this.ctx, car);
			if (p) setTwoTone(p, car, t.rgb2 instanceof Array ? t.rgb2 : null, t.split);
		}
		if (this.isCar(car))
		{
			const s = this.stock(car);
			const wis = car.rayCastVehicle.wheelInfos;
			for (let i = 0; i < wis.length; i++)
			{
				const wi = wis[i];
				if (num(t.rideHeight)) wi.suspensionRestLength = Math.max(0.12, s.restLength[i] + clamp(t.rideHeight, -0.15, 0.15));
				if (num(t.suspensionStiffness)) wi.suspensionStiffness = clamp(t.suspensionStiffness, 5, 80);
				if (num(t.damping)) { wi.dampingRelaxation = clamp(t.damping, 0.5, 6); wi.dampingCompression = wi.dampingRelaxation; }
				if (num(t.grip)) wi.frictionSlip = clamp(t.grip, 0.3, 2.5);
			}
			if (num(t.steeringSpeed)) { car.steeringMass = s.steeringMass / clamp(t.steeringSpeed, 0.4, 3); if (car.steeringSimulator) car.steeringSimulator.mass = car.steeringMass; }
			if (num(t.maxSteer)) car.maxSteerVal = clamp(t.maxSteer, 0.25, 1.2);
			if (num(t.enginePower)) car.engineForce = clamp(t.enginePower, 100, 3000);
			if (num(t.topSpeed)) car.topSpeedFactor = clamp(t.topSpeed, 0.5, 2);
			if (num(t.brakeForce)) car.brakeFactor = clamp(t.brakeForce, 0.3, 5);
			try { car.collision.wakeUp(); } catch (e) { /* headless */ }
		}
		if (t.livery !== undefined)
		{
			const pol = (this.ctx.world as any).realismPolice;
			if (pol && pol.applyLivery)
			{
				if (t.livery === 'police' || t.livery === 'sheriff') pol.applyLivery(car, t.livery, t.unit);
				else if (car.realismPolice) pol.removeLivery(car);
			}
		}
		else if (typeof t.unit === 'string' && car.realismPolice)
		{
			const pol = (this.ctx.world as any).realismPolice;
			if (pol && pol.applyLivery) pol.applyLivery(car, car.realismPolice.dept, t.unit);
		}
		car.realismTuned = true;
		if (t.rgb instanceof Array) car.realismTunedRgb = [+t.rgb[0], +t.rgb[1], +t.rgb[2]];
	}

	/** Back to stock physics, finish and two-tone (the colour is left to whoever spawns the car). */
	public reset(car: any): void
	{
		const d = this.defaults(car);
		const keep = { rideHeight: 0, suspensionStiffness: d.suspensionStiffness, damping: d.damping, steeringSpeed: 1, maxSteer: d.maxSteer,
			enginePower: d.enginePower, topSpeed: 1, brakeForce: 1, grip: d.grip, finish: 'stock', rgb2: null as number[], livery: null as string };
		this.apply(car, keep);
		car.realismTuned = false;
		car.realismTunedRgb = null;
	}

	// -----------------------------------------------------------------------
	// owned cars: re-apply saved tuning when a car is (re)spawned / reused
	// -----------------------------------------------------------------------

	public update(timeStep: number, unscaled: number): void
	{
		const w: any = this.ctx.world;
		if (w.realismPaused) return;
		this.acc += unscaled;
		if (this.acc < 0.2) return;
		this.acc = 0;
		this.sync();
	}

	public sync(): void
	{
		const w: any = this.ctx.world;
		const oc = w.realismOwnedCars;
		const vs: any[] = w.vehicles || [];
		for (let i = 0; i < vs.length; i++)
		{
			const car = vs[i];
			if (car.realismModShopPreview) continue;
			let rec: any = null;
			try { rec = oc && typeof oc.recordFor === 'function' ? oc.recordFor(car) : null; } catch (e) { rec = null; }
			const spot = car.realismSpot || '';
			const seen = car.realismSyncSeen === true;
			const changed = !seen || car.realismSyncRec !== (rec ? rec.id : '') || car.realismSyncSpot !== spot;
			if (changed)
			{
				const prevSpot = car.realismSyncSpot || '', prevRec = car.realismSyncRec || '';
				car.realismSyncSeen = true;
				car.realismSyncRec = rec ? rec.id : '';
				car.realismSyncSpot = spot;
				// a pooled car that now stands for another car: drop the old car's tuning first
				if (seen && car.realismTuned && (prevSpot !== '' || prevRec !== '')) this.reset(car);
				if (rec && rec.tuning && typeof rec.tuning === 'object') this.apply(car, rec.tuning);
				if (rec && (rec.type === 'police' || rec.type === 'sheriff') && !car.realismPolice && w.realismPolice)
				{
					const unit = rec.tuning && rec.tuning.unit ? rec.tuning.unit : (rec.unit || '');
					w.realismPolice.applyLivery(car, rec.type, unit);
				}
			}
			else if (car.realismTuned && car.realismTunedRgb && car.realismPaint)
			{
				// someone (the NPC car pool) repainted it: put the bought paint back
				const c = car.realismPaint.mat.color, t = car.realismTunedRgb;
				if (c && (Math.abs(c.r - t[0]) > 0.01 || Math.abs(c.g - t[1]) > 0.01 || Math.abs(c.b - t[2]) > 0.01)) c.setRGB(t[0], t[1], t[2]);
			}
		}
	}
}

function round(v: number, d: number = 3): number
{
	const f = Math.pow(10, d);
	return Math.round(v * f) / f;
}
