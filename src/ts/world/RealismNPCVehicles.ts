/*
 * RealismNPCVehicles.ts
 * ---------------------
 * Cars that belong to NPC homes, and cars the player has stolen (owned cars).
 *
 *  - Every NPC home may get a car parked at the kerb in front of it (npcs.carShare).
 *  - Parked cars are drawn as instanced meshes (one draw call per paint colour + one for all
 *    wheels), only within ~170 m of the player. Within 35 m they get a cheap static collider
 *    so you can't drive through them.
 *  - Within 16 m of the player on foot a parked car becomes a real, drivable Sketchbook Car
 *    (a small pool, npcs.maxRealCars). Press F as with any car: getting in steals it
 *    (car alarm + "It's yours now"). Walk 40 m away and it goes back to a cheap parked car.
 *  - A stolen car is the player's for good: saved in localStorage (paint, where you left it,
 *    rotation) and restored there on the next load. Its NPC home gets no replacement.
 *
 *  - Cars bought in the Dealership app (add) wait "stored" (not in the world) until you spawn
 *    them from the Garage app (spawn): they appear on the nearest road lane next to you.
 *    Any vehicle type works: the sedan ('car') uses the cheap pool above, every other type
 *    (heli, airplane, config vehicles.types such as policeCruiser) is a real vehicle kept while
 *    you are within 170 m of it.
 *
 * API (world as any).realismOwnedCars (contract C2):
 *    cars              live array of owned cars { id, origin, type, model, color, rgb, x, y, z, qx, qy, qz, qw,
 *                      stolenAt, name, tuning?, stored?, price?, trim?, boughtAt? }
 *                      type: 'car' (the sedan), 'police', 'sheriff' or a vehicles.types id; origin: 'h<building>'
 *                      for a stolen NPC car, 'dealer', or whatever claim() was given; stored: bought, never spawned.
 *    list()            a copy of it
 *    count, stats
 *    locate(id)        { x, y, z } where it is now (live if it is spawned), null while stored
 *    forget(id)        give a car up (it disappears; a claimed world car just stops being yours)
 *    onChange(cb)      called with the list whenever it changes
 *    save()
 *    current()         the owned car the player sits in, or null
 *    claim(car, { origin, type?, rgb? })   make a live car yours, returns its record (null for department
 *                      patrol cars, car.realismDeptVehicle)
 *    add({ type, rgb?, name?, tuning?, price?, trim? })   new stored record (dealer purchase), not spawned
 *    spawn(id, near?)  puts that car on the road next to the player (or near) and returns the live car;
 *                      spawning again moves it. null if no free spot / still loading (see lastError).
 *    update(id, patch) merge into the record + save (rgb repaints, tuning re-applies a live car)
 *    recordFor(car)    the record of a live car, or null
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { RealismCtx, instMat } from './RealismContext';
import { Road } from './RealismMapData';
import { Car } from '../vehicles/Car';
import { cheapMaterial } from './RealismAssets';
import { ownGeometry } from './RealismInstanceGeom';
import { InstancedCarLights, measureLamps, carLightSettings, isNightNow } from './RealismCarLights';
import { loadSharedModel, NPCSettings } from './RealismNPCs';
import { Helicopter } from '../vehicles/Helicopter';
import { Airplane } from '../vehicles/Airplane';
import { dressVehicle } from './RealismVehicles';
import { findRoadSpot } from './RealismRoadSpot';

export interface NPCHome { building: number; doorX: number; doorZ: number; rot: number; }

export interface OwnedCar
{
	id: string;
	origin: string;           // NPC spot it came from ('h<building>'), 'dealer', '' if none
	type: string;             // vehicle type id: 'car' (sedan), 'police', 'sheriff' or a vehicles.types id
	model: string;            // 'car' (kept for old saves) or the type
	color: number;            // palette index
	rgb: number[];
	x: number; y: number; z: number;
	qx: number; qy: number; qz: number; qw: number;
	stolenAt: number;
	name: string;
	tuning?: any;             // opaque, owned by realismVehicleTuning (A9)
	stored?: boolean;         // bought, not spawned yet
	price?: number;
	trim?: string;
	boughtAt?: number;
	// C12 (stolen cars; A17 respray / VIN scratch / fence)
	stolen?: boolean;
	vin?: string;
	vinScratched?: boolean;
	hot?: boolean;
}

interface Spot
{
	id: string;
	owned: boolean;
	rec: OwnedCar;
	color: number;
	pos: THREE.Vector3;
	quat: THREE.Quaternion;
	car: Car;
	coll: CANNON.Body;
	marker: THREE.Object3D;
	lastSave: number;
	home: number;             // building index of the NPC home, -1 for owned cars
	kind: string;             // 'pool' sedan from the pool | 'special' other owned type | 'foreign' claimed world car
	cache: any;               // 'special': the vehicle kept while it is out of range
	theft?: boolean;          // the hotwire minigame is running for this car
}

const STORE_KEY = 'realism.ownedCars.v1';
const PALETTE: { name: string; rgb: number[] }[] = [
	{ name: 'White', rgb: [0.95, 0.95, 0.94] }, { name: 'Black', rgb: [0.13, 0.13, 0.14] }, { name: 'Silver', rgb: [0.62, 0.64, 0.66] },
	{ name: 'Red', rgb: [0.72, 0.09, 0.08] }, { name: 'Blue', rgb: [0.14, 0.25, 0.58] }, { name: 'Green', rgb: [0.16, 0.34, 0.22] },
	{ name: 'Beige', rgb: [0.78, 0.7, 0.54] },
];
const REAL_RANGE = 16;        // on foot: spawn a drivable car this close
const RELEASE_RANGE = 40;     // despawn a drivable car (unused) this far away
const COLLIDER_RANGE = 35;
const DRAW_RANGE = 170;
const MAX_COLLIDERS = 10;
const CAR_SAG = 0.16;        // the real car sits this much lower than its modelled wheels (measured)
const CAP = 64;               // instanced cars per paint colour
const SPECIAL_RANGE = 170;    // other owned vehicle types are real within this range
const SPECIAL_RELEASE = 210;

/** Palette index closest to an rgb (instanced parked look). */
function nearestPalette(rgb: number[]): number
{
	if (!rgb || rgb.length < 3) return 0;
	let best = 0, bd = 1e9;
	for (let i = 0; i < PALETTE.length; i++)
	{
		const p = PALETTE[i].rgb;
		const d = (p[0] - rgb[0]) * (p[0] - rgb[0]) + (p[1] - rgb[1]) * (p[1] - rgb[1]) + (p[2] - rgb[2]) * (p[2] - rgb[2]);
		if (d < bd) { bd = d; best = i; }
	}
	return best;
}

function validRgb(v: any): number[] | null
{
	if (!(v instanceof Array) || v.length < 3) return null;
	const out = [+v[0], +v[1], +v[2]];
	if (!out.every((x) => isFinite(x))) return null;
	return out.map((x) => Math.max(0, Math.min(1, x)));
}

/** Paints a vehicle's body material ('Car' / 'Heli' / 'Airplane'). */
export function paintVehicle(car: any, rgb: number[]): void
{
	if (!car || !rgb) return;
	car.traverse((o: any) =>
	{
		if (!o.isMesh || !o.material || o.material instanceof Array) return;
		const n = o.material.name;
		if ((n === 'Car' || n === 'Heli' || n === 'Airplane') && o.material.color) o.material.color.setRGB(rgb[0], rgb[1], rgb[2]);
	});
}

function hash01(n: number): number
{
	const x = Math.sin(n * 91.7 + 17.3) * 43758.5453;
	return x - Math.floor(x);
}

export class NPCVehicles
{
	public spots: Spot[] = [];
	public owned: OwnedCar[] = [];
	public stats: { [k: string]: number } = { npcCars: 0, ownedCars: 0, realCars: 0, drawn: 0, colliders: 0 };
	public api: any;
	private ctx: RealismCtx;
	private npcs: any;
	private settings: NPCSettings;
	private gltf: any = null;
	private ready = false;
	private bodyGeom: THREE.BufferGeometry = null;
	private wheelGeom: THREE.BufferGeometry = null;
	private bodyMeshes: THREE.InstancedMesh[] = [];
	private wheelMesh: THREE.InstancedMesh = null;
	public lights: InstancedCarLights = null;
	private promptOn = false;
	private boxes: { half: CANNON.Vec3; off: CANNON.Vec3 }[] = [];
	private restY = 0.62;
	private freeCars: Car[] = [];
	private realCount = 0;
	private acc = 0;
	private drawAcc = 1;
	private lastDrawPos = new THREE.Vector3(1e9, 0, 0);
	private collPool: CANNON.Body[] = [];
	private collMat: CANNON.Material;
	private listeners: ((list: OwnedCar[]) => void)[] = [];
	private hud: HTMLElement = null;
	private hudText = '';
	private msg: HTMLElement = null;
	private msgUntil = 0;
	private tmpM = new THREE.Matrix4();
	private one = new THREE.Vector3(1, 1, 1);

	constructor(ctx: RealismCtx, npcs: any, homes: NPCHome[], settings: NPCSettings)
	{
		this.ctx = ctx;
		this.npcs = npcs;
		this.settings = settings;
		this.collMat = new CANNON.Material('parkedCarMat');
		this.collMat.friction = 0.3;
		this.load();
		const taken: { [id: string]: boolean } = {};
		for (let i = 0; i < this.owned.length; i++)
		{
			const o = this.owned[i];
			if (o.origin) taken[o.origin] = true;
			if (o.stored) continue;
			this.spots.push(this.ownedSpot(o));
			if (o.type !== 'car') this.requestModel(o.type);
		}
		if (settings.parkedCars) this.placeParked(homes, taken);
		this.stats.npcCars = this.spots.filter((s) => !s.owned).length;
		this.stats.ownedCars = this.owned.length;
		this.api = this.makeApi();
		loadSharedModel('build/assets/car.glb', (gltf) =>
		{
			try { this.prepare(gltf); }
			catch (e) { console.warn('[Realism] NPC cars: car.glb setup failed', e); }
		});
		try
		{
			if (typeof window !== 'undefined' && (window as any).addEventListener) (window as any).addEventListener('beforeunload', () => this.save());
		}
		catch (e) { /* headless */ }
	}

	// -----------------------------------------------------------------------
	// placement
	// -----------------------------------------------------------------------

	private placeParked(homes: NPCHome[], taken: { [id: string]: boolean }): void
	{
		const data = this.ctx.data;
		const segs: { r: Road; i: number }[] = [];
		for (let r = 0; r < data.roads.length; r++)
		{
			const road = data.roads[r];
			if (road.kind !== 'street' && road.kind !== 'avenue') continue;
			for (let i = 0; i < road.pts.length - 1; i++) segs.push({ r: road, i: i });
		}
		const props = data.props;
		const placed: THREE.Vector3[] = [];
		for (let h = 0; h < homes.length; h++)
		{
			const home = homes[h];
			const id = 'h' + home.building;
			if (taken[id]) continue;
			if (hash01(home.building * 1.37 + data.seed) >= this.settings.carShare) continue;
			const fx = home.doorX + Math.sin(home.rot) * 1.5, fz = home.doorZ + Math.cos(home.rot) * 1.5;
			// nearest street centreline point
			let best = -1, bd = 1e18, bt = 0;
			for (let k = 0; k < segs.length; k++)
			{
				const a = segs[k].r.pts[segs[k].i], b = segs[k].r.pts[segs[k].i + 1];
				const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
				let t = l2 > 0 ? ((fx - a.x) * dx + (fz - a.z) * dz) / l2 : 0;
				t = Math.max(0, Math.min(1, t));
				const px = a.x + dx * t - fx, pz = a.z + dz * t - fz, d = px * px + pz * pz;
				if (d < bd) { bd = d; best = k; bt = t; }
			}
			if (best < 0) continue;
			const road = segs[best].r, a = road.pts[segs[best].i], b = road.pts[segs[best].i + 1];
			const hw = road.width / 2;
			if (Math.sqrt(bd) > hw + 30) continue;
			let tx = b.x - a.x, tz = b.z - a.z;
			const tl = Math.sqrt(tx * tx + tz * tz) || 1;
			tx /= tl; tz /= tl;
			const nx = -tz, nz = tx;
			const cx = a.x + (b.x - a.x) * bt, cz = a.z + (b.z - a.z) * bt;
			const side = (fx - cx) * nx + (fz - cz) * nz >= 0 ? 1 : -1;
			const shift = (hash01(home.building * 3.1) - 0.5) * 5;
			const x = cx + nx * side * (hw - 1.3) + tx * shift, z = cz + nz * side * (hw - 1.3) + tz * shift;
			// keep clear of junctions, hydrants and other parked cars
			let ok = true;
			for (let j = 0; j < data.intersections.length && ok; j++)
			{
				const I = data.intersections[j];
				const r = I.crossHW + 10;
				if ((I.x - x) * (I.x - x) + (I.z - z) * (I.z - z) < r * r) ok = false;
			}
			for (let k = 0; k < placed.length && ok; k++) if ((placed[k].x - x) * (placed[k].x - x) + (placed[k].z - z) * (placed[k].z - z) < 8 * 8) ok = false;
			for (let k = 0; k < props.length && ok; k++)
			{
				const p = props[k];
				if (Math.abs(p.x - x) < 3.2 && Math.abs(p.z - z) < 3.2) ok = false;
			}
			if (!ok) continue;
			const ry = a.y + (b.y - a.y) * bt;
			const y = Math.max(ry, data.heightAt(x, z)) + (road.kind === 'avenue' ? 0.1 : 0.08) + this.restY;
			const fxd = tx * side, fzd = tz * side;    // drive on the right: facing along the kerb
			const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(fxd, fzd));
			const color = Math.floor(hash01(home.building * 7.7) * PALETTE.length) % PALETTE.length;
			const marker = new THREE.Object3D();
			marker.position.set(x, y + 0.5, z);
			marker.quaternion.copy(quat);
			marker.updateMatrixWorld(true);
			this.spots.push({ id: id, owned: false, rec: null, color: color, pos: new THREE.Vector3(x, y, z), quat: quat, car: null, coll: null, marker: marker, lastSave: 0, home: home.building, kind: 'pool', cache: null });
			placed.push(new THREE.Vector3(x, y, z));
		}
	}

	private ownedSpot(o: OwnedCar): Spot
	{
		const marker = new THREE.Object3D();
		marker.position.set(o.x, o.y + 0.5, o.z);
		marker.updateMatrixWorld(true);
		return { id: o.id, owned: true, rec: o, color: o.color, pos: new THREE.Vector3(o.x, o.y, o.z), quat: new THREE.Quaternion(o.qx, o.qy, o.qz, o.qw).normalize(),
			car: null, coll: null, marker: marker, lastSave: 0, home: -1, kind: o.type === 'car' ? 'pool' : 'special', cache: null };
	}

	// -----------------------------------------------------------------------
	// model
	// -----------------------------------------------------------------------

	private prepare(gltf: any): void
	{
		this.gltf = gltf;
		const scene: THREE.Object3D = gltf.scene;
		scene.updateMatrixWorld(true);
		const body: THREE.BufferGeometry[] = [], wheels: THREE.BufferGeometry[] = [];
		let bodyMat: any = null, wheelMat: any = null;
		scene.traverse((o: any) =>
		{
			const ud = o.userData || {};
			if (ud.data === 'collision' && ud.shape === 'box')
				this.boxes.push({ half: new CANNON.Vec3(o.scale.x, o.scale.y, o.scale.z), off: new CANNON.Vec3(o.position.x, o.position.y, o.position.z) });
			if (!o.isMesh || ud.data === 'collision' || ud.data === 'navmesh') return;
			const m = o.material;
			const g = (o.geometry as THREE.BufferGeometry).clone();
			g.applyMatrix4(o.matrixWorld);
			const isWheel = (m && m.name === 'Wheel') || ud.data === 'wheel';
			if (isWheel) { wheels.push(g); if (!wheelMat) wheelMat = m; }
			else { body.push(g); if (!bodyMat) bodyMat = m; }
		});
		this.bodyGeom = mergeSimple(body);
		this.wheelGeom = mergeSimple(wheels);
		// rest height: wheels touch the road at y = lowest wheel vertex - suspension sag
		this.wheelGeom.computeBoundingBox();
		const measured = (window as any).REALISM_CAR_REST_Y;
		const rest = typeof measured === 'number' ? measured : -this.wheelGeom.boundingBox.min.y - CAR_SAG;
		if (isFinite(rest) && rest > 0.1 && rest < 2) this.adjustRest(rest);
		const ctx = this.ctx;
		const mk = (base: any, rgb: number[]) =>
		{
			let m: any = base ? cheapMaterial(ctx, base) : new THREE.MeshLambertMaterial();
			m = m.clone();
			if (rgb && m.color) m.color.setRGB(rgb[0], rgb[1], rgb[2]);
			m.userData = Object.assign({}, m.userData || {}, { instancedCopy: true });
			try { ctx.world.sky.csm.setupMaterial(m); } catch (e) { /* no csm */ }
			return m as THREE.Material;
		};
		for (let c = 0; c < PALETTE.length; c++)
		{
			const mesh = new THREE.InstancedMesh(ownGeometry(this.bodyGeom), mk(bodyMat, PALETTE[c].rgb), CAP);
			mesh.count = 0;
			mesh.frustumCulled = false;
			mesh.castShadow = !!ctx.preset.shadows; mesh.receiveShadow = true;
			mesh.name = 'parkedCars_' + PALETTE[c].name;
			ctx.world.graphicsWorld.add(mesh);
			this.bodyMeshes.push(mesh);
		}
		this.wheelMesh = new THREE.InstancedMesh(ownGeometry(this.wheelGeom), mk(wheelMat, null), CAP * PALETTE.length);
		this.wheelMesh.count = 0;
		this.wheelMesh.frustumCulled = false;
		this.wheelMesh.name = 'parkedCarWheels';
		ctx.world.graphicsWorld.add(this.wheelMesh);
		// parked cars have their engine off: lenses only (all off), no glow (RealismCarLights.ts)
		try
		{
			const ls = carLightSettings(ctx);
			if (ls.enabled) this.lights = new InstancedCarLights(ctx.world.graphicsWorld, measureLamps(this.bodyGeom, this.wheelGeom), CAP * PALETTE.length, 'parkedCar', false);
		}
		catch (e) { console.warn('[Realism] parked car lights failed', e); }
		this.ready = true;
		this.drawAcc = 1;
		this.lastDrawPos.set(1e9, 0, 0);
	}

	/** Re-seats the never-spawned NPC cars on the measured rest height. */
	private adjustRest(rest: number): void
	{
		const d = rest - this.restY;
		this.restY = rest;
		for (let i = 0; i < this.spots.length; i++)
		{
			const s = this.spots[i];
			if (s.owned || s.lastSave > 0) continue;
			s.pos.y += d;
			s.marker.position.y += d;
			s.marker.updateMatrixWorld(true);
		}
	}

	private newCar(): Car
	{
		const clone = { scene: this.gltf.scene.clone(true), animations: [] as any[] };
		const car = new Car(clone);
		return car;
	}

	// -----------------------------------------------------------------------
	// per frame (called by RealismNPCs.update, so it pauses with realismPaused)
	// -----------------------------------------------------------------------

	public tick(dt: number): void
	{
		if (!this.ready) return;
		const w: any = this.ctx.world;
		const player = this.npcs.player;
		const ppos: THREE.Vector3 = this.npcs.playerPosition;
		const onFoot = !!player && !player.occupyingSeat && player.controlledObject === undefined && !player.vehicleEntryInstance;

		// stolen?
		for (let i = 0; i < this.spots.length; i++)
		{
			const s = this.spots[i];
			if (!s.car) continue;
			const inside = player && (s.car.controllingCharacter === player || s.car.seats.some((seat) => seat.occupiedBy === player));
			if (inside && !s.owned) this.steal(s);
			if (s.owned && s.car)
			{
				s.lastSave += dt;
				if (s.lastSave > 2) { s.lastSave = 0.001; this.capture(s); this.save(); }
			}
		}

		this.acc += dt;
		if (this.acc >= 0.25)
		{
			this.acc = 0;
			if (player) this.manage(ppos, onFoot, player);
		}
		this.drawAcc += dt;
		if (this.drawAcc > 0.5 || ppos.distanceToSquared(this.lastDrawPos) > 64)
		{
			this.drawAcc = 0;
			this.lastDrawPos.copy(ppos);
			this.draw(ppos);
		}

		// prompt (C7 realismPrompt; the old text hint when there is none)
		let text = '', label = '';
		if (onFoot && w.realismUIBlocking !== true)
		{
			for (let i = 0; i < this.spots.length; i++)
			{
				const s = this.spots[i];
				if (!s.car) continue;
				if (s.car.position.distanceToSquared(player.position) < 3.6 * 3.6) { label = s.owned ? 'Enter' : 'Steal'; text = s.owned ? '[F] Your car' : '[F] Steal car'; break; }
			}
		}
		const pr = w.realismPrompt;
		if (pr && typeof pr.set === 'function')
		{
			if (label) { try { pr.set('npcCars', [{ key: 'F', label: label }]); } catch (e) { /* ignore */ } this.promptOn = true; }
			else if (this.promptOn) { try { pr.set('npcCars', null); } catch (e) { /* ignore */ } this.promptOn = false; }
			this.showHint('');
		}
		else this.showHint(text);
		if (this.msg && this.msgUntil > 0 && Date.now() > this.msgUntil) { this.msg.style.display = 'none'; this.msgUntil = 0; }
	}

	private manage(p: THREE.Vector3, onFoot: boolean, player: any): void
	{
		const near: Spot[] = [], nd: number[] = [];
		let colls = 0;
		this.realCount = 0;
		for (let i = 0; i < this.spots.length; i++)
		{
			const s = this.spots[i];
			const cp = s.car ? s.car.position : s.pos;
			const d = Math.sqrt((cp.x - p.x) * (cp.x - p.x) + (cp.z - p.z) * (cp.z - p.z));
			if (s.kind === 'foreign') continue;   // the world owns it
			if (s.kind === 'special')
			{
				if (s.car)
				{
					if (d > SPECIAL_RELEASE && !this.inUse(s.car, player)) this.despawn(s);
				}
				else if (d < SPECIAL_RANGE) this.spawnSpecial(s);
				continue;
			}
			if (s.car)
			{
				const used = s.car.controllingCharacter || s.car.seats.some((seat) => !!seat.occupiedBy) || (player && player.vehicleEntryInstance && player.vehicleEntryInstance.targetSeat && player.vehicleEntryInstance.targetSeat.vehicle === s.car);
				if (!used && d > RELEASE_RANGE) this.despawn(s);
				else this.realCount++;
				continue;
			}
			if (onFoot && d < REAL_RANGE) { near.push(s); nd.push(d); }
			// static collider for parked cars close by
			if (d < COLLIDER_RANGE && colls < MAX_COLLIDERS)
			{
				if (!s.coll) this.addCollider(s);
				colls++;
			}
			else if (s.coll) this.removeCollider(s);
		}
		// spawn the nearest parked cars as real ones
		const order = near.map((_, k) => k).sort((a, b) => nd[a] - nd[b]);
		for (let k = 0; k < order.length; k++)
		{
			const s = near[order[k]];
			if (this.realCount >= this.settings.maxRealCars)
			{
				// free the farthest unused real car if it is farther than this one
				let far: Spot = null, fd = nd[order[k]] + 6;
				for (let i = 0; i < this.spots.length; i++)
				{
					const o = this.spots[i];
					if (o.kind !== 'pool' || !o.car || o.car.controllingCharacter || o.car.seats.some((seat) => !!seat.occupiedBy)) continue;
					const d = o.car.position.distanceTo(p);
					if (d > fd) { fd = d; far = o; }
				}
				if (!far) break;
				this.despawn(far);
				this.realCount--;
			}
			this.spawn(s);
			this.realCount++;
		}
		this.stats.realCars = this.realCount;
		this.stats.colliders = colls;
	}

	private spawn(s: Spot): void
	{
		if (s.coll) this.removeCollider(s);
		let car = this.freeCars.pop();
		if (!car) car = this.newCar();
		const rgb = s.rec && s.rec.rgb ? s.rec.rgb : PALETTE[s.color % PALETTE.length].rgb;
		paintVehicle(car, rgb);
		this.applyTuning(car, s.rec);
		const b: any = car.collision;
		b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
		b.position.set(s.pos.x, s.pos.y + 0.05, s.pos.z);
		b.quaternion.set(s.quat.x, s.quat.y, s.quat.z, s.quat.w);
		if (b.previousPosition) b.previousPosition.copy(b.position);
		if (b.interpolatedPosition) b.interpolatedPosition.copy(b.position);
		if (b.interpolatedQuaternion) b.interpolatedQuaternion.copy(b.quaternion);
		if (b.initPosition) b.initPosition.copy(b.position);
		car.position.set(s.pos.x, s.pos.y + 0.05, s.pos.z);
		car.quaternion.copy(s.quat);
		s.marker.position.set(s.pos.x, s.pos.y + 0.5, s.pos.z);
		s.marker.updateMatrixWorld(true);
		car.spawnPoint = s.marker;
		this.ctx.world.add(car);
		(car as any).realismSpot = s.id;
		s.car = car;
		this.drawAcc = 1;
	}

	private despawn(s: Spot): void
	{
		const car = s.car;
		if (!car) return;
		this.capture(s);
		if (s.kind === 'foreign') { s.car = null; if (s.owned) this.save(); return; }
		try { this.ctx.world.remove(car); } catch (e) { console.warn('[Realism] NPC car remove failed', e); }
		(car as any).realismSpot = undefined;
		if (s.kind === 'special') s.cache = car;
		else this.freeCars.push(car);
		s.car = null;
		if (s.owned) this.save();
		this.drawAcc = 1;
	}

	/** Copies a spawned car's pose back into its spot (and the owned record). */
	private capture(s: Spot): void
	{
		if (!s.car) return;
		const b = s.car.collision;
		if (!isFinite(b.position.x) || !isFinite(b.position.y)) return;
		s.pos.set(b.position.x, b.position.y, b.position.z);
		s.quat.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
		if (s.lastSave === 0) s.lastSave = 0.001;    // moved by physics: keep the real pose from now on
		if (s.rec)
		{
			const r = s.rec;
			r.x = round(s.pos.x); r.y = round(s.pos.y); r.z = round(s.pos.z);
			r.qx = round(s.quat.x, 4); r.qy = round(s.quat.y, 4); r.qz = round(s.quat.z, 4); r.qw = round(s.quat.w, 4);
		}
	}

	private steal(s: Spot): void
	{
		if (s.theft) return;
		const car: any = s.car;
		if (car && car.realismTheftFailAt && Date.now() - car.realismTheftFailAt < 4000) return;   // getting out after a failed hotwire
		s.theft = true;
		const hotwire = this.hasHotwire();
		this.beginTheft(car, (ok: boolean) =>
		{
			s.theft = false;
			if (!ok || s.owned) return;
			const rec = this.claimSpot(s, { origin: s.id, type: 'car' });
			this.markStolen(rec, s.car || car);
			this.flash('Car stolen. It\'s yours now.');
			if (this.settings.carAlarm && !hotwire) alarm();      // with the hotwire minigame the alarm means failure
			try { if (this.npcs && this.npcs.panic) this.npcs.panic((s.car || car).position, 22); } catch (e) { /* ignore */ }
		});
	}

	private hasHotwire(): boolean
	{
		const hw = (this.ctx.world as any).realismHotwire;
		return !!hw && typeof hw.start === 'function';
	}

	/**
	 * C12: the player sits in a car that isn't theirs. With (world as any).realismHotwire (A17)
	 * the engine stays off until its minigame calls done(true); done(false) sounds the alarm and
	 * puts the player out. Without it the theft succeeds at once (onDone(true)).
	 */
	public beginTheft(car: any, onDone: (ok: boolean) => void): void
	{
		const w: any = this.ctx.world;
		const hw = w.realismHotwire;
		if (!car || !hw || typeof hw.start !== 'function') { onDone(true); return; }
		car.engineOff = true;
		car.realismTheft = true;
		let fired = false;
		const done = (ok: boolean) =>
		{
			if (fired) return;
			fired = true;
			car.realismTheft = false;
			car.engineOff = false;
			if (!ok)
			{
				car.realismTheftFailAt = Date.now();
				if (this.settings.carAlarm) alarm();
				this.flash('The alarm went off.');
				try { if (typeof car.forceCharacterOut === 'function' && car.controllingCharacter) car.forceCharacterOut(); } catch (e) { /* ignore */ }
				try { if (this.npcs && this.npcs.panic) this.npcs.panic(car.position, 22); } catch (e) { /* ignore */ }
			}
			try { onDone(!!ok); } catch (e) { console.warn('[Realism] theft callback failed', e); }
		};
		try { hw.start(car, done); }
		catch (e) { console.warn('[Realism] hotwire failed to start', e); done(true); }
	}

	/** C12 fields on a stolen car's record, saved, and the 'carStolen' event (C14). */
	public markStolen(rec: OwnedCar, car: any): void
	{
		if (!rec) return;
		rec.stolen = true;
		if (!rec.vin || rec.vin.length !== 17) rec.vin = randomVin();   // keep a VIN another system already gave it
		if (rec.vinScratched === undefined) rec.vinScratched = false;
		rec.hot = true;
		this.save();
		this.emit();
		const ev = (this.ctx.world as any).realismEvents;
		if (ev && typeof ev.emit === 'function') { try { ev.emit('carStolen', { car: car, record: rec }); } catch (e) { console.warn('[Realism] carStolen listener failed', e); } }
	}

	/** Makes a spot (NPC parked car) owned. */
	private claimSpot(s: Spot, info: { origin: string; type?: string; rgb?: number[] }): OwnedCar
	{
		if (s.owned && s.rec) return s.rec;
		s.owned = true;
		const rgb = validRgb(info.rgb);
		const color = rgb ? nearestPalette(rgb) : s.color;
		const pal = PALETTE[color % PALETTE.length];
		const type = info.type || 'car';
		const rec: OwnedCar = {
			id: newId(), origin: info.origin || s.id, type: type, model: type, color: color, rgb: rgb || pal.rgb.slice(0),
			x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, stolenAt: Date.now(), name: pal.name + ' sedan',
		};
		s.color = color;
		s.rec = rec;
		s.home = -1;
		this.owned.push(rec);
		this.capture(s);
		this.save();
		this.countsChanged();
		this.emit();
		return rec;
	}

	private countsChanged(): void
	{
		this.stats.ownedCars = this.owned.length;
		this.stats.npcCars = this.spots.filter((o) => !o.owned).length;
		this.drawAcc = 1;
	}

	private inUse(car: any, player: any): boolean
	{
		if (!car) return false;
		if (car.controllingCharacter || (car.seats && car.seats.some((seat: any) => !!seat.occupiedBy))) return true;
		return !!(player && player.vehicleEntryInstance && player.vehicleEntryInstance.targetSeat && player.vehicleEntryInstance.targetSeat.vehicle === car);
	}

	private applyTuning(car: any, rec: OwnedCar): void
	{
		const tu: any = (this.ctx.world as any).realismVehicleTuning;
		if (!tu || typeof tu.apply !== 'function') return;
		try
		{
			if (rec && rec.tuning) { tu.apply(car, rec.tuning); car.realismTuned = true; }
			else if (car.realismTuned)
			{
				// a pooled car that was tuned for an owner goes back to stock for NPCs
				tu.apply(car, typeof tu.defaults === 'function' ? tu.defaults(car) : {});
				car.realismTuned = false;
			}
		}
		catch (e) { console.warn('[Realism] vehicle tuning failed', e); }
	}

	// -----------------------------------------------------------------------
	// other vehicle types (heli, airplane, config vehicles.types, police / sheriff)
	// -----------------------------------------------------------------------

	private models: { [path: string]: any } = {};
	private modelFailed: { [path: string]: boolean } = {};

	/** Base class + model path of a type: null if unknown. */
	private typeInfo(type: string): { base: string; path: string; vt: any } | null
	{
		const types: any = (this.ctx.world as any).realismVehicleTypes || {};
		const vt = types[type];
		const base: string = vt && vt.base ? vt.base : type;
		if (base !== 'car' && base !== 'heli' && base !== 'airplane') return null;
		let path = 'build/assets/' + base + '.glb';
		if (vt) path = vt.sketchbookFormat === false ? (vt.baseModel || path) : (vt.model || path);
		return { base: base, path: path, vt: vt };
	}

	public requestModel(type: string): boolean
	{
		if (type === 'police' || type === 'sheriff') return true;
		const ti = this.typeInfo(type);
		if (!ti) return false;
		if (this.models[ti.path]) return true;
		if (this.modelFailed[ti.path]) return false;
		loadSharedModel(ti.path, (g) => { this.models[ti.path] = g; }, () => { this.modelFailed[ti.path] = true; });
		return !!this.models[ti.path];
	}

	private createSpecial(s: Spot): any
	{
		const type = s.rec ? s.rec.type : 'car';
		const w: any = this.ctx.world;
		if (type === 'police' || type === 'sheriff')
		{
			const pol = w.realismPolice;
			if (!pol || typeof pol.spawnUnit !== 'function') return null;
			const heading = 2 * Math.atan2(s.quat.y, s.quat.w);
			const c = pol.spawnUnit(type, { position: s.pos.clone(), heading: heading, unit: s.rec && s.rec.tuning ? s.rec.tuning.unit : undefined });
			return c && typeof c.then !== 'function' ? c : null;
		}
		const ti = this.typeInfo(type);
		if (!ti) return null;
		const gltf = this.models[ti.path];
		if (!gltf) { this.requestModel(type); return null; }
		const clone = { scene: gltf.scene.clone(true), animations: gltf.animations || [] };
		let v: any;
		if (ti.base === 'heli') v = new Helicopter(clone);
		else if (ti.base === 'airplane') v = new Airplane(clone);
		else v = new Car(clone);
		if (ti.vt && ti.vt.sketchbookFormat === false && ti.vt.model) { try { dressVehicle(w, v, clone, ti.vt); } catch (e) { /* model missing */ } }
		v.realismType = type;
		return v;
	}

	private spawnSpecial(s: Spot): boolean
	{
		let car = s.cache;
		const fresh = !car;
		if (!car) car = this.createSpecial(s);
		if (!car) return false;
		s.cache = null;
		if (s.rec && s.rec.rgb) paintVehicle(car, s.rec.rgb);
		this.place(car, s);
		if (fresh || !(this.ctx.world as any).vehicles || (this.ctx.world as any).vehicles.indexOf(car) < 0)
		{
			try { if ((this.ctx.world as any).vehicles.indexOf(car) < 0) this.ctx.world.add(car); }
			catch (e) { console.warn('[Realism] owned vehicle add failed', e); return false; }
		}
		this.applyTuning(car, s.rec);
		car.realismSpot = s.id;
		s.car = car;
		return true;
	}

	/** Puts a live vehicle on the spot's pose (body + mesh), at rest. */
	private place(car: any, s: Spot): void
	{
		const b: any = car.collision;
		b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
		b.position.set(s.pos.x, s.pos.y + 0.05, s.pos.z);
		b.quaternion.set(s.quat.x, s.quat.y, s.quat.z, s.quat.w);
		if (b.previousPosition) b.previousPosition.copy(b.position);
		if (b.interpolatedPosition) b.interpolatedPosition.copy(b.position);
		if (b.previousQuaternion) b.previousQuaternion.copy(b.quaternion);
		if (b.interpolatedQuaternion) b.interpolatedQuaternion.copy(b.quaternion);
		if (b.initPosition) b.initPosition.copy(b.position);
		if (b.initQuaternion) b.initQuaternion.copy(b.quaternion);
		car.position.set(s.pos.x, s.pos.y + 0.05, s.pos.z);
		car.quaternion.copy(s.quat);
		s.marker.position.set(s.pos.x, s.pos.y + 0.5, s.pos.z);
		s.marker.quaternion.copy(s.quat);
		s.marker.updateMatrixWorld(true);
		car.spawnPoint = s.marker;
	}

	/** Rest height above the road surface for a type. */
	private restFor(type: string): number
	{
		if (type === 'car') return this.restY;
		const ti = this.typeInfo(type);
		if (ti && ti.base === 'car') return this.restY + 0.1;
		return 1.4;
	}

	private clearanceFor(type: string): number
	{
		const ti = this.typeInfo(type);
		if (ti && ti.base === 'heli') return 8;
		if (ti && ti.base === 'airplane') return 14;
		return 2.6;
	}

	// -----------------------------------------------------------------------
	// contract C2 additions
	// -----------------------------------------------------------------------

	public lastError = '';

	private spotOf(id: string): Spot | null
	{
		for (let i = 0; i < this.spots.length; i++) if (this.spots[i].rec && this.spots[i].rec.id === id) return this.spots[i];
		return null;
	}

	private recOf(id: string): OwnedCar | null
	{
		for (let i = 0; i < this.owned.length; i++) if (this.owned[i].id === id) return this.owned[i];
		return null;
	}

	public claim(car: any, info: { origin: string; type?: string; rgb?: number[]; stolen?: boolean }): OwnedCar | null
	{
		if (!car || !car.collision) return null;
		if (car.realismDeptVehicle) return null;        // department patrol cars are never yours
		info = info || { origin: '' };
		if (info.stolen)
		{
			const plain = Object.assign({}, info); delete plain.stolen;
			const before = this.recordFor(car);
			const wasStolen = !!(before && before.stolen);
			const r = this.claim(car, plain);
			// v14: another listener (chop shop) may flag the new record stolen during claim();
			// still mark it here so 'carStolen' fires exactly once.
			if (r && !wasStolen) this.markStolen(r, car);
			return r;
		}
		for (let i = 0; i < this.spots.length; i++)
		{
			const s = this.spots[i];
			if (s.car !== car) continue;
			if (s.owned && s.rec) return s.rec;
			return this.claimSpot(s, info);
		}
		// a car the world spawned (scenario, mission, ...): it stays where it is, now owned
		let type = info.type || car.realismType;
		if (!type)
		{
			const pol: any = (this.ctx.world as any).realismPolice;
			if (pol && typeof pol.isPoliceCar === 'function') { try { if (pol.isPoliceCar(car)) type = 'police'; } catch (e) { /* ignore */ } }
		}
		if (!type) type = car instanceof Helicopter ? 'heli' : car instanceof Airplane ? 'airplane' : 'car';
		let rgb = validRgb(info.rgb);
		if (!rgb)
		{
			car.traverse((o: any) =>
			{
				if (rgb || !o.isMesh || !o.material || o.material instanceof Array) return;
				const n = o.material.name;
				if ((n === 'Car' || n === 'Heli' || n === 'Airplane') && o.material.color) rgb = [o.material.color.r, o.material.color.g, o.material.color.b];
			});
		}
		const color = rgb ? nearestPalette(rgb) : 0;
		const rec: OwnedCar = {
			id: newId(), origin: info.origin || '', type: type, model: type, color: color, rgb: rgb || PALETTE[color].rgb.slice(0),
			x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, stolenAt: Date.now(), name: typeName(type, PALETTE[color].name),
		};
		const marker = new THREE.Object3D();
		const s: Spot = { id: rec.id, owned: true, rec: rec, color: color, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), car: car, coll: null,
			marker: marker, lastSave: 0.001, home: -1, kind: 'foreign', cache: null };
		car.realismSpot = s.id;
		this.spots.push(s);
		this.owned.push(rec);
		this.capture(s);
		this.save();
		this.countsChanged();
		this.emit();
		return rec;
	}

	public add(info: { type: string; rgb?: number[]; name?: string; tuning?: any; price?: number; trim?: string }): OwnedCar | null
	{
		if (!info || typeof info.type !== 'string' || !info.type) return null;
		const type = info.type;
		if (type !== 'police' && type !== 'sheriff' && !this.typeInfo(type)) { this.lastError = 'Unknown vehicle type ' + type; return null; }
		const rgb = validRgb(info.rgb);
		const color = rgb ? nearestPalette(rgb) : 0;
		const rec: OwnedCar = {
			id: newId(), origin: 'dealer', type: type, model: type, color: color, rgb: rgb || PALETTE[color].rgb.slice(0),
			x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, stolenAt: 0, name: String(info.name || typeName(type, PALETTE[color].name)).slice(0, 40),
			stored: true, boughtAt: Date.now(),
		};
		if (info.tuning !== undefined) rec.tuning = info.tuning;
		if (typeof info.price === 'number' && isFinite(info.price)) rec.price = info.price;
		if (typeof info.trim === 'string') rec.trim = info.trim.slice(0, 30);
		this.owned.push(rec);
		if (type !== 'car') this.requestModel(type);
		this.save();
		this.countsChanged();
		this.emit();
		return rec;
	}

	/** Spawns (or moves) an owned car onto the nearest free road lane next to `near` / the player. */
	public spawnOwned(id: string, near?: THREE.Vector3): any
	{
		this.lastError = '';
		const rec = this.recOf(id);
		if (!rec) { this.lastError = 'No such car'; return null; }
		const player = this.npcs.player;
		let s = this.spotOf(id);
		if (s && s.car && player && this.inUse(s.car, player) && s.car.seats.some((seat: any) => seat.occupiedBy === player)) return s.car;
		if (s && s.car && this.inUse(s.car, null)) { this.lastError = 'Someone is in it'; return null; }
		const kind = s ? s.kind : (rec.type === 'car' ? 'pool' : 'special');
		if (kind === 'pool' && !this.ready) { this.lastError = 'Still loading, try again in a moment'; return null; }
		if (kind === 'special' && rec.type !== 'police' && rec.type !== 'sheriff' && !this.requestModel(rec.type) && !(s && (s.car || s.cache)))
		{
			const ti = this.typeInfo(rec.type);
			this.lastError = ti && this.modelFailed[ti.path] ? 'Model could not be loaded' : 'Still loading, try again in a moment';
			return null;
		}
		const at = new THREE.Vector3();
		if (near) at.copy(near);
		else at.copy(this.npcs.playerPosition);
		const ignore = s && s.car ? [s.car] : [];
		const obst: { x: number; z: number }[] = [];
		for (let i = 0; i < this.spots.length; i++) { const o = this.spots[i]; if (o !== s && !o.car && o.rec !== rec && o.kind !== 'foreign') obst.push(o.pos); }
		const pp = this.npcs.playerPosition;
		const clear = this.clearanceFor(rec.type);
		const spot = findRoadSpot(this.ctx, at, { clearance: clear, ignore: ignore, obstacles: obst, player: pp }) ||
			findRoadSpot(this.ctx, at, { clearance: clear, ignore: ignore, obstacles: obst, player: pp, radius: 180 });
		if (!spot) { this.lastError = 'No free spot on a road nearby'; return null; }
		const y = spot.y + this.restFor(rec.type);
		if (!s)
		{
			rec.x = spot.x; rec.y = y; rec.z = spot.z;
			rec.qx = spot.quat.x; rec.qy = spot.quat.y; rec.qz = spot.quat.z; rec.qw = spot.quat.w;
			s = this.ownedSpot(rec);
			this.spots.push(s);
		}
		if (s.coll) this.removeCollider(s);
		s.pos.set(spot.x, y, spot.z);
		s.quat.copy(spot.quat);
		s.lastSave = 0.001;
		delete rec.stored;
		if (s.car) this.place(s.car, s);
		else if (s.kind === 'pool') this.spawn(s);
		else if (!this.spawnSpecial(s))
		{
			this.capture(s);
			rec.x = round(spot.x); rec.y = round(y); rec.z = round(spot.z);
			rec.qx = round(spot.quat.x, 4); rec.qy = round(spot.quat.y, 4); rec.qz = round(spot.quat.z, 4); rec.qw = round(spot.quat.w, 4);
			this.save(); this.emit();
			this.lastError = 'Still loading, it will appear in a moment';
			return null;
		}
		this.capture(s);
		this.save();
		this.drawAcc = 1;
		this.emit();
		return s.car;
	}

	public updateRecord(id: string, patch: any): void
	{
		const rec = this.recOf(id);
		if (!rec || !patch || typeof patch !== 'object') return;
		for (const k in patch)
		{
			if (!patch.hasOwnProperty(k) || k === 'id') continue;
			(rec as any)[k] = patch[k];
		}
		if (patch.rgb !== undefined)
		{
			const rgb = validRgb(patch.rgb);
			if (rgb) { rec.rgb = rgb; rec.color = nearestPalette(rgb); }
		}
		const s = this.spotOf(id);
		if (s)
		{
			s.color = rec.color;
			if (s.car && patch.rgb !== undefined) paintVehicle(s.car, rec.rgb);
			if (s.car && patch.tuning !== undefined) this.applyTuning(s.car, rec);
		}
		this.save();
		this.drawAcc = 1;
		this.emit();
	}

	public recordFor(car: any): OwnedCar | null
	{
		if (!car) return null;
		for (let i = 0; i < this.spots.length; i++) if (this.spots[i].car === car || this.spots[i].cache === car) return this.spots[i].rec || null;
		return null;
	}

	// -----------------------------------------------------------------------
	// drawing + colliders
	// -----------------------------------------------------------------------

	private draw(p: THREE.Vector3): void
	{
		const counts: number[] = [];
		for (let c = 0; c < PALETTE.length; c++) counts.push(0);
		let wheels = 0;
		const R2 = DRAW_RANGE * DRAW_RANGE;
		for (let i = 0; i < this.spots.length; i++)
		{
			const s = this.spots[i];
			if (s.car || s.kind !== 'pool') continue;
			const dx = s.pos.x - p.x, dz = s.pos.z - p.z;
			if (dx * dx + dz * dz > R2) continue;
			const c = s.color % PALETTE.length;
			if (counts[c] >= CAP) continue;
			this.tmpM.compose(s.pos, s.quat, this.one);
			this.bodyMeshes[c].setMatrixAt(counts[c]++, this.tmpM);
			if (this.lights) this.lights.set(wheels, this.tmpM, 0, 0, 0);      // engine off: every lamp off
			this.wheelMesh.setMatrixAt(wheels++, this.tmpM);
		}
		let lightCalls = 0;
		if (this.lights) lightCalls = this.lights.commit(wheels, isNightNow(this.ctx.world), false);
		let drawn = 0;
		for (let c = 0; c < PALETTE.length; c++)
		{
			const m = this.bodyMeshes[c];
			m.count = counts[c];
			m.visible = counts[c] > 0;
			m.instanceMatrix.needsUpdate = true;
			drawn += counts[c];
		}
		this.wheelMesh.count = wheels;
		this.wheelMesh.visible = wheels > 0;
		this.wheelMesh.instanceMatrix.needsUpdate = true;
		this.stats.drawn = drawn;
		this.stats.drawCalls = this.bodyMeshes.filter((m) => m.visible).length + (this.wheelMesh.visible ? 1 : 0) + lightCalls;
	}

	private addCollider(s: Spot): void
	{
		let body = this.collPool.pop();
		if (!body)
		{
			body = new CANNON.Body({ mass: 0 });
			body.material = this.collMat;
			const list = this.boxes.length ? this.boxes : [{ half: new CANNON.Vec3(0.9, 0.55, 2.1), off: new CANNON.Vec3(0, 0, 0) }];
			for (let k = 0; k < list.length; k++) body.addShape(new CANNON.Box(list[k].half), list[k].off);
		}
		body.position.set(s.pos.x, s.pos.y, s.pos.z);
		body.quaternion.set(s.quat.x, s.quat.y, s.quat.z, s.quat.w);
		body.aabbNeedsUpdate = true;
		this.ctx.world.physicsWorld.addBody(body);
		s.coll = body;
	}

	private removeCollider(s: Spot): void
	{
		if (!s.coll) return;
		this.ctx.world.physicsWorld.remove(s.coll);
		this.collPool.push(s.coll);
		s.coll = null;
	}

	// -----------------------------------------------------------------------
	// saving
	// -----------------------------------------------------------------------

	private load(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			if (!ls) return;
			const raw = ls.getItem(STORE_KEY);
			if (!raw) return;
			const data = JSON.parse(raw);
			const list: any[] = data && data.cars ? data.cars : [];
			for (let i = 0; i < list.length; i++)
			{
				const o = list[i];
				if (!o || !isFinite(o.x) || !isFinite(o.y) || !isFinite(o.z)) continue;
				const q = new THREE.Quaternion(+o.qx || 0, +o.qy || 0, +o.qz || 0, isFinite(o.qw) ? +o.qw : 1);
				if (q.lengthSq() < 0.01) q.set(0, 0, 0, 1);
				q.normalize();
				const color = Math.max(0, Math.floor(+o.color || 0)) % PALETTE.length;
				const type = typeof o.type === 'string' && o.type ? o.type : (typeof o.model === 'string' && o.model ? o.model : 'car');
				const rec: OwnedCar = { id: String(o.id || ('c' + i)), origin: String(o.origin || ''), type: type, model: type, color: color, rgb: validRgb(o.rgb) || PALETTE[color].rgb.slice(0),
					x: +o.x, y: +o.y, z: +o.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, stolenAt: +o.stolenAt || 0, name: String(o.name || typeName(type, PALETTE[color].name)) };
				if (o.tuning !== undefined && o.tuning !== null) rec.tuning = o.tuning;
				if (o.stored === true) rec.stored = true;
				if (isFinite(o.price)) rec.price = +o.price;
				if (typeof o.trim === 'string') rec.trim = o.trim;
				if (isFinite(o.boughtAt)) rec.boughtAt = +o.boughtAt;
				if (o.stolen === true) rec.stolen = true;
				if (typeof o.vin === 'string') rec.vin = o.vin.slice(0, 17);
				if (typeof o.vinScratched === 'boolean') rec.vinScratched = o.vinScratched;
				if (typeof o.hot === 'boolean') rec.hot = o.hot;
				this.owned.push(rec);
			}
			if (this.owned.length) console.log('[Realism] Restored ' + this.owned.length + ' owned car(s)');
		}
		catch (e) { console.warn('[Realism] Could not read owned cars', e); }
	}

	public save(): void
	{
		try
		{
			for (let i = 0; i < this.spots.length; i++) if (this.spots[i].owned && this.spots[i].car) this.capture(this.spots[i]);
			// department patrol cars and vehicles that left the world are never saved as a pose
			for (let i = this.spots.length - 1; i >= 0; i--)
			{
				const s = this.spots[i];
				if (s.kind === 'foreign' && s.car && (this.ctx.world as any).vehicles && (this.ctx.world as any).vehicles.indexOf(s.car) < 0)
				{
					// the world removed it (scenario reload): from now on it is an ordinary owned car of its type
					(s.car as any).realismSpot = undefined;
					s.car = null;
					s.kind = s.rec && s.rec.type !== 'car' ? 'special' : 'pool';
					this.drawAcc = 1;
				}
			}
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			if (!ls) return;
			ls.setItem(STORE_KEY, JSON.stringify({ v: 1, cars: this.owned }));
		}
		catch (e) { /* storage full / private mode */ }
	}

	private emit(): void
	{
		const list = this.owned.slice(0);
		for (let i = 0; i < this.listeners.length; i++) { try { this.listeners[i](list); } catch (e) { /* ignore */ } }
	}

	private makeApi(): any
	{
		const self = this;
		return {
			get cars(): OwnedCar[] { return self.owned; },
			list(): OwnedCar[] { return self.owned.slice(0); },
			get count(): number { return self.owned.length; },
			locate(id: string): { x: number; y: number; z: number } | null
			{
				for (let i = 0; i < self.spots.length; i++)
				{
					const s = self.spots[i];
					if (!s.rec || s.rec.id !== id) continue;
					const p = s.car ? s.car.position : s.pos;
					return { x: p.x, y: p.y, z: p.z };
				}
				return null;
			},
			forget(id: string): boolean
			{
				for (let i = 0; i < self.spots.length; i++)
				{
					const s = self.spots[i];
					if (!s.rec || s.rec.id !== id) continue;
					if (s.car && (s.car.controllingCharacter || s.car.seats.some((seat) => !!seat.occupiedBy))) return false;
					if (s.kind === 'foreign') { if (s.car) (s.car as any).realismSpot = undefined; s.car = null; }
					if (s.car) self.despawn(s);
					if (s.coll) self.removeCollider(s);
					s.cache = null;
					self.spots.splice(i, 1);
					self.owned = self.owned.filter((o) => o.id !== id);
					self.save(); self.countsChanged(); self.emit();
					return true;
				}
				// stored (never spawned)
				const before = self.owned.length;
				self.owned = self.owned.filter((o) => o.id !== id);
				if (self.owned.length === before) return false;
				self.save(); self.countsChanged(); self.emit();
				return true;
			},
			onChange(cb: (list: OwnedCar[]) => void): void { if (typeof cb === 'function') self.listeners.push(cb); },
			save(): void { self.save(); },
			get stats(): any { return self.stats; },
			/** The owned car the player is in right now, or null. */
			current(): OwnedCar | null
			{
				const pl = self.npcs.player;
				for (let i = 0; i < self.spots.length; i++)
				{
					const s = self.spots[i];
					if (s.rec && s.car && pl && s.car.seats.some((seat) => seat.occupiedBy === pl)) return s.rec;
				}
				return null;
			},
			claim(car: any, info: { origin: string; type?: string; rgb?: number[]; stolen?: boolean }): OwnedCar | null { return self.claim(car, info); },
			/** C12 helper: hotwire (if present) then onDone(success). */
			beginTheft(car: any, onDone: (ok: boolean) => void): void { self.beginTheft(car, onDone); },
			add(info: { type: string; rgb?: number[]; name?: string; tuning?: any; price?: number; trim?: string }): OwnedCar | null { return self.add(info); },
			spawn(id: string, near?: THREE.Vector3): any { return self.spawnOwned(id, near); },
			update(id: string, patch: any): void { self.updateRecord(id, patch); },
			recordFor(car: any): OwnedCar | null { return self.recordFor(car); },
			get(id: string): OwnedCar | null { return self.recOf(id); },
			isSpawned(id: string): boolean { const s = self.spotOf(id); return !!(s && s.car); },
			get lastError(): string { return self.lastError; },
		};
	}

	// -----------------------------------------------------------------------
	// HUD
	// -----------------------------------------------------------------------

	private ensureHud(): void
	{
		if (this.hud !== null) return;
		try
		{
			if (typeof document === 'undefined' || !document.body || !document.createElement) return;
			const h = document.createElement('div');
			h.style.cssText = 'position:fixed;left:50%;bottom:132px;transform:translateX(-50%);z-index:9999;font:bold 14px sans-serif;color:#fff;background:rgba(0,0,0,0.5);padding:5px 12px;border-radius:5px;pointer-events:none;display:none';
			document.body.appendChild(h);
			const m = document.createElement('div');
			m.style.cssText = 'position:fixed;left:50%;top:22%;transform:translateX(-50%);z-index:9999;font:bold 20px sans-serif;color:#ffd54a;text-shadow:0 1px 3px #000;pointer-events:none;display:none';
			document.body.appendChild(m);
			this.hud = h; this.msg = m;
		}
		catch (e) { /* headless */ }
	}

	private showHint(text: string): void
	{
		if (text === this.hudText) return;
		this.hudText = text;
		this.ensureHud();
		if (!this.hud) return;
		this.hud.textContent = text;
		this.hud.style.display = text ? 'block' : 'none';
	}

	private flash(text: string): void
	{
		this.ensureHud();
		if (!this.msg) return;
		this.msg.textContent = text;
		this.msg.style.display = 'block';
		this.msgUntil = Date.now() + 2600;
	}
}

let idSeq = 0;
function newId(): string { return 'c' + Date.now().toString(36) + (idSeq++).toString(36) + Math.floor(Math.random() * 1000).toString(36); }

const TYPE_NAMES: { [t: string]: string } = { car: 'sedan', heli: 'helicopter', airplane: 'airplane', police: 'police cruiser', sheriff: 'sheriff cruiser' };
function typeName(type: string, colour: string): string
{
	const n = TYPE_NAMES[type] || type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
	return colour + ' ' + n;
}

const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';   // no I, O, Q
function randomVin(): string
{
	let v = '';
	for (let i = 0; i < 17; i++) v += VIN_CHARS.charAt(Math.floor(Math.random() * VIN_CHARS.length));
	return v;
}

function round(v: number, d: number = 3): number { const k = Math.pow(10, d); return Math.round(v * k) / k; }

/** Merges geometries (position / normal / uv) into one non-indexed geometry. */
function mergeSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry
{
	const pos: number[] = [], nor: number[] = [], uv: number[] = [];
	for (let i = 0; i < list.length; i++)
	{
		const g = list[i].index ? list[i].toNonIndexed() : list[i];
		const p = g.getAttribute('position') as THREE.BufferAttribute;
		const n = g.getAttribute('normal') as THREE.BufferAttribute;
		const u = g.getAttribute('uv') as THREE.BufferAttribute;
		if (!p) continue;
		for (let v = 0; v < p.count; v++)
		{
			pos.push(p.getX(v), p.getY(v), p.getZ(v));
			if (n) nor.push(n.getX(v), n.getY(v), n.getZ(v)); else nor.push(0, 1, 0);
			if (u) uv.push(u.getX(v), u.getY(v)); else uv.push(0, 0);
		}
	}
	const out = new THREE.BufferGeometry();
	out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
	out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	out.computeBoundingSphere();
	return out;
}

let audioCtx: any = null;
/** Short two-tone car alarm (WebAudio, silent where unavailable). */
function alarm(): void
{
	try
	{
		const W: any = typeof window !== 'undefined' ? window : null;
		const AC = W && (W.AudioContext || W.webkitAudioContext);
		if (!AC) return;
		if (!audioCtx) audioCtx = new AC();
		const ac = audioCtx;
		const osc = ac.createOscillator(), gain = ac.createGain();
		osc.type = 'square';
		const t0 = ac.currentTime;
		for (let k = 0; k < 10; k++) osc.frequency.setValueAtTime(k % 2 ? 620 : 880, t0 + k * 0.25);
		gain.gain.setValueAtTime(0.0001, t0);
		gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.05);
		gain.gain.setValueAtTime(0.06, t0 + 2.3);
		gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.5);
		osc.connect(gain); gain.connect(ac.destination);
		osc.start(t0); osc.stop(t0 + 2.55);
	}
	catch (e) { /* no audio */ }
}
