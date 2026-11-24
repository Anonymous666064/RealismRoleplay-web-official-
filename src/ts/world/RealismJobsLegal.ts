/*
 * RealismJobsLegal.ts
 * -------------------
 * The civilian trades of the Jobs app (developer A16). Duty, uniform and hourly pay are shared with
 * police / sheriff in RealismJobs.ts; this file runs the shifts' tasks:
 *
 *  DOT Road Worker (San Verano DOT)   pothole (hold E, 1 asphalt), cones around a work zone (E x4,
 *                                     1 cone each), street light repair (night only, hold E), traffic
 *                                     signal controller (sequence minigame), road debris (hold E x3),
 *                                     road lines (hold E x3, 1 paint).
 *  Community Service                  litter bags in a park (E x5) then the dumpster, sweeping (hold E
 *                                     x3), painting over graffiti (hold E x2). Works off service hours
 *                                     (world.realismCommunityService); paid a little once none are owed.
 *  Construction (Verano Build Co.)    build: place the next ghost pieces at the site (hold E, one site
 *                                     material each; RealismConstruction.ts); deliver: take the supply
 *                                     truck at the depot, drive to the site, unload (hold E); blueprint:
 *                                     the designer minigame at the site office, pay scaled by the score.
 *  Electrician (Volt Electric Co.)    AC units on buildings (wire minigame, 1 wire), office computers
 *                                     (diagnostic sequence), shop / bank alarm panels (fuse box, fuses
 *                                     from your bag), broken-down car with the hood up (diagnose, then
 *                                     hold E to fix the wiring, 1 wire).
 *
 *  - One task at a time: GPS waypoint (realismGPS.setWaypoint) + blip (realismGPS.addBlip), yellow
 *    markers over the spots, an objective line on the right. Pay per task via realismEconomy.earn
 *    (bank), then realismEvents.emit('jobCompleted', { job, pay, task }). Next task after
 *    jobs.dispatchDelay seconds. 'Skip task' in the Jobs app.
 *  - Every interaction is a C7 prompt (owner 'jobs'): realismPrompt.set('jobs', ...) while in range,
 *    acting only when realismPrompt.isActive('jobs'). Hold prompts send progress().
 *  - Work vehicle per trade (the Jobs app 'Get work vehicle'): a sedan painted in the company colours
 *    (realismVehicleTuning.apply, guarded), on the road next to you. Not owned, never saved, removed
 *    off duty once empty. E at its trunk restocks the trade's supplies.
 *  - Electrician props added at runtime: wall + rooftop AC units, alarm panels and cameras on shops
 *    and banks (merged per 256 m chunk, distance culled as 'detail').
 *
 * World API: (world as any).realismJobsLegal = this; (world as any).realismCommunityService =
 *    { hours: number (getter); add(h: number): void; onChange(cb): void }  (saved in
 *    localStorage 'realism.communityService.v1').
 */

import * as THREE from 'three';
import { RealismCtx, chunkKey, RENDER_CHUNK, addMesh } from './RealismContext';
import { GeoAccum, AccumSet, Frame, box, cyl, cylX } from './RealismGeometry';
import { Building } from './RealismMapData';
import { RealismJobs, Department, rrToast } from './RealismJobs';
import { findRoadSpot, RoadSpot } from './RealismRoadSpot';
import { loadSharedModel } from './RealismNPCs';
import { Car } from '../vehicles/Car';
import { buildInventory, RealismInventory } from './RealismInventory';
import { ConstructionSite, SpatialIndex } from './RealismConstruction';
import { JobPrompt, TaskMarkers, ObjectiveHud, MinigameOverlay, WireGame, FuseGame, SequenceGame, BlueprintGame, makeBrief, ensureEvents, emitEvent, Minigame } from './RealismWorkTasks';

export const SERVICE_KEY = 'realism.communityService.v1';

export interface Target
{
	x: number; y: number; z: number;
	r: number;                    // interaction range (m)
	label: string;
	hold: number;                 // seconds to hold E; 0 = press
	done: boolean;
	vehicle?: boolean;            // may be done from a vehicle
	consume?: [string, number];   // inventory needed (taken on success)
	check?: () => string;         // '' = ok, else the reason shown instead
	mg?: () => Minigame;          // press E opens this minigame; solved = done
	onDone?: (t: Target, mg?: Minigame) => void;
	vis?: number;                 // index of a TaskVisuals item this target changes
}

export interface Task
{
	id: number;
	job: string;
	kind: string;
	title: string;
	where: string;
	pay: number;
	phases: Target[][];
	phase: number;
	bonus?: number;
	credit?: number;              // community service hours worked off
	cleanup?: () => void;
	finish?: () => void;
}

interface Spot { x: number; y: number; z: number; name: string; bi: number; }

interface VisItem { type: string; x: number; y: number; z: number; rot: number; on: boolean; }

export interface LegalSettings { dispatchDelay: number; minDist: number; maxDist: number; acUnits: number; panels: number; blueprintPass: number; }

export function legalSettings(cfg: any): LegalSettings
{
	const raw: any = (cfg && cfg.jobs) || {};
	const n = (v: any, d: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, typeof v === 'number' && isFinite(v) ? v : d));
	const td = raw.taskDistance instanceof Array ? raw.taskDistance : [];
	const el: any = (cfg && cfg.jobs && cfg.jobs.electrician) || {};
	return {
		dispatchDelay: n(raw.dispatchDelay, 4, 0, 600),
		minDist: n(td[0], 60, 0, 3000),
		maxDist: n(td[1], 420, 40, 4000),
		acUnits: Math.round(n(el.acUnits, 48, 0, 400)),
		panels: Math.round(n(el.securityPanels, 30, 0, 400)),
		blueprintPass: n(raw.blueprintPass, 0.75, 0.1, 1),
	};
}

/** Supplies each trade starts a shift with / restocks from the work vehicle. */
const KITS: { [job: string]: { [item: string]: number } } = {
	dot: { cone: 6, asphalt: 4, roadPaint: 2, toolkit: 1 },
	community: { broom: 1 },
	construction: { toolkit: 1 },
	electrician: { toolkit: 1, multimeter: 1, fuse: 8, wire: 5 },
};

function mulberry(seed: number): () => number
{
	let a = seed >>> 0;
	return () =>
	{
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul ? Math.imul(t ^ (t >>> 15), t | 1) : (t ^ (t >>> 15)) * (t | 1);
		t ^= t + (Math.imul ? Math.imul(t ^ (t >>> 7), t | 61) : (t ^ (t >>> 7)) * (t | 61));
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function hash01(i: number, salt: number): number
{
	let h = (i * 374761393 + salt * 668265263) | 0;
	h = (h ^ (h >>> 13)) * 1274126177 | 0;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------------- task visuals

/** Temporary task objects (potholes, cones, debris, litter, dirt, graffiti...), one solid + one decal mesh. */
class TaskVisuals
{
	public items: VisItem[] = [];
	private ctx: RealismCtx;
	private solid: THREE.Mesh = null;
	private decal: THREE.Mesh = null;

	constructor(ctx: RealismCtx) { this.ctx = ctx; }

	public add(type: string, x: number, y: number, z: number, rot: number): number
	{
		this.items.push({ type: type, x: x, y: y, z: z, rot: rot, on: true });
		return this.items.length - 1;
	}

	public clear(): void { this.items.length = 0; this.rebuild(); }

	public rebuild(): void
	{
		const s = new GeoAccum(), d = new GeoAccum();
		for (let i = 0; i < this.items.length; i++)
		{
			const it = this.items[i];
			const f = new Frame(it.x, it.y, it.z, it.rot);
			switch (it.type)
			{
				case 'pothole': if (it.on) { cyl(d, f, 0, 0.03, 0, 0.001, 0.55, 0.55, 10, [0.08, 0.08, 0.08], true); } else box(d, f, -0.7, 0.0, -0.7, 0.7, 0.035, 0.7, [0.16, 0.16, 0.17]); break;
				case 'cone':
					if (!it.on) break;
					box(s, f, -0.22, 0, -0.22, 0.22, 0.05, 0.22, [0.1, 0.1, 0.1]);
					cyl(s, f, 0, 0.05, 0, 0.45, 0.18, 0.1, 8, [0.97, 0.42, 0.05]);
					cyl(s, f, 0, 0.5, 0, 0.12, 0.1, 0.075, 8, [0.95, 0.95, 0.95]);
					cyl(s, f, 0, 0.62, 0, 0.12, 0.075, 0.02, 8, [0.97, 0.42, 0.05]);
					break;
				case 'tire': if (it.on) cylX(s, f, -0.13, 0.13, 0.36, 0, 0.36, 10, [0.07, 0.07, 0.07]); break;
				case 'crate': if (it.on) box(s, f, -0.4, 0, -0.3, 0.4, 0.5, 0.3, [0.55, 0.4, 0.24]); break;
				case 'branch': if (it.on) { cylX(s, f, -1.2, 1.2, 0.12, 0, 0.1, 6, [0.35, 0.25, 0.15]); box(s, f, -0.4, 0.05, -0.5, 0.4, 0.45, 0.2, [0.22, 0.38, 0.16]); } break;
				case 'line': if (!it.on) box(d, f, -0.08, 0, -1.5, 0.08, 0.03, 1.5, [0.95, 0.95, 0.9]); break;
				case 'litter': if (it.on) { cyl(s, f, 0, 0, 0, 0.45, 0.26, 0.2, 7, [0.07, 0.07, 0.08]); cyl(s, f, 0, 0.45, 0, 0.12, 0.08, 0.02, 5, [0.07, 0.07, 0.08]); } break;
				case 'dirt': if (it.on) { box(d, f, -0.9, 0, -0.7, 0.9, 0.025, 0.7, [0.32, 0.25, 0.16]); box(d, f, -0.4, 0, -0.9, 0.5, 0.03, 0.9, [0.28, 0.22, 0.14]); } break;
				case 'graffiti':
					// vertical tag on a wall: local +Z points out of the wall
					if (it.on)
					{
						box(d, f, -1.3, 0.9, 0, 1.3, 2.3, 0.02, [0.85, 0.15, 0.55]);
						box(d, f, -1.0, 1.2, 0.01, 0.6, 1.6, 0.03, [0.15, 0.55, 0.95]);
						box(d, f, -0.2, 1.7, 0.01, 1.1, 2.1, 0.03, [0.98, 0.85, 0.1]);
					}
					else box(d, f, -1.4, 0.8, 0, 1.4, 2.4, 0.02, [0.7, 0.7, 0.68]);
					break;
			}
		}
		this.solid = this.swap(this.solid, s, this.ctx.mats.plain);
		this.decal = this.swap(this.decal, d, this.ctx.mats.decal || this.ctx.mats.plain);
	}

	private swap(old: THREE.Mesh, a: GeoAccum, mat: THREE.Material): THREE.Mesh
	{
		const gw = this.ctx.world.graphicsWorld;
		if (old) { gw.remove(old); old.geometry.dispose(); }
		if (a.empty) return null;
		const m = new THREE.Mesh(a.toGeometry(), mat);
		m.castShadow = false;
		m.receiveShadow = true;
		m.matrixAutoUpdate = false;
		m.updateMatrix();
		m.name = 'realismJobTask';
		gw.add(m);
		return m;
	}
}

// ---------------------------------------------------------------------------------- the trades

export class RealismJobsLegal
{
	public updateOrder = 10;
	public settings: LegalSettings;
	public task: Task = null;
	public site: ConstructionSite = null;
	public index: SpatialIndex;
	public inventory: RealismInventory;
	public prompt: JobPrompt;
	public markers: TaskMarkers;
	public hud = new ObjectiveHud();
	public minigames: MinigameOverlay;
	public workVehicle: any = null;
	public supplyTruck: any = null;
	public brokenCar: any = null;
	public acSpots: Spot[] = [];
	public panelSpots: Spot[] = [];
	public officeSpots: Spot[] = [];
	public serviceHours = 0;
	public serviceDone = 0;
	public stats = { tasks: 0, paid: 0, propsMs: 0, acUnits: 0, panels: 0 };
	/** The interaction in range this frame (tests read it). */
	public cur: { label: string; hold: number; blocked: string; run: () => void; t?: Target } = null;
	public holdTime = 0;
	public eHeld = false;
	public lastPay = 0;
	public dispatchIn = 0;
	private ctx: RealismCtx;
	private world: any;
	private jobs: RealismJobs;
	private visuals: TaskVisuals;
	private oldVehicles: any[] = [];
	private taskSeq = 0;
	private rnd: () => number;
	private carState = 0;          // 0 loading, 1 ready, -1 failed
	private carGltf: any = null;
	private waitingCars: Array<() => void> = [];
	private slowAcc = 0;
	private wasOnDuty = false;
	private lastJob = '';
	private serviceListeners: Array<() => void> = [];
	private blipIds: { [id: string]: boolean } = {};
	private tmp = new THREE.Vector3();
	private markerSig = '';
	private gpsLabel = '';
	private hadPromptApi = false;
	private hudAcc = 1;
	private scanAcc = 1;
	private rescan = false;

	constructor(ctx: RealismCtx, jobs: RealismJobs)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		this.jobs = jobs;
		this.settings = legalSettings(ctx.cfg);
		this.rnd = mulberry((Date.now() ^ 0x5bd1e995) >>> 0);
		ensureEvents(this.world);
		this.inventory = buildInventory(ctx);
		this.prompt = new JobPrompt(this.world, 'jobs');
		this.markers = new TaskMarkers(ctx);
		this.minigames = new MinigameOverlay(this.world);
		this.visuals = new TaskVisuals(ctx);
		this.index = new SpatialIndex(ctx);
		const t0 = Date.now();
		try { this.buildElectricProps(); }
		catch (e) { console.warn('[Realism] electrician props failed', e); }
		this.stats.propsMs = Date.now() - t0;
		try { this.site = new ConstructionSite(ctx, this.index); }
		catch (e) { console.warn('[Realism] construction site failed', e); this.site = null; }
		this.loadService();
		const self = this;
		this.world.realismCommunityService = {
			get hours(): number { return self.serviceHours; },
			add(h: number): void { self.addService(h); },
			onChange(cb: () => void): void { if (typeof cb === 'function') self.serviceListeners.push(cb); },
			get served(): number { return self.serviceDone; },
		};
		this.world.realismJobsLegal = this;
		this.bindInput();
		loadSharedModel('build/assets/car.glb', (g: any) =>
		{
			this.carGltf = g; this.carState = 1;
			const w = this.waitingCars; this.waitingCars = [];
			for (let i = 0; i < w.length; i++) w[i]();
		}, () => { this.carState = -1; this.waitingCars = []; });
		// a saved on-duty trade: dispatch shortly after load
		this.wasOnDuty = this.onCivilDuty();
		this.lastJob = this.jobs.state.id;
		this.dispatchIn = 2;
	}

	// ------------------------------------------------------------------ helpers

	private dept(): Department { const d = this.jobs.department(); return d && d.civil ? d : null; }
	public onCivilDuty(): boolean { return !!this.dept() && this.jobs.state.onDuty; }

	private player(): any { return RealismJobs.playerCharacter(this.world); }

	private playerPos(out: THREE.Vector3): boolean
	{
		const ch = this.player();
		if (!ch) return false;
		if (ch.occupyingSeat && ch.occupyingSeat.vehicle) out.copy(ch.occupyingSeat.vehicle.position);
		else out.copy(ch.position);
		return true;
	}

	private inVehicle(): any
	{
		const ch = this.player();
		return ch && ch.occupyingSeat && ch.occupyingSeat.vehicle ? ch.occupyingSeat.vehicle : null;
	}

	private gps(): any { const g = this.world.realismGPS; return g && typeof g.setWaypoint === 'function' ? g : null; }

	private night(): boolean
	{
		const t = this.world.realismTime;
		const h = t && isFinite(t.hour) ? t.hour : 12;
		return h >= 19.5 || h < 6;
	}

	private pick<T>(a: T[]): T { return a.length ? a[Math.floor(this.rnd() * a.length)] : null; }

	// ------------------------------------------------------------------ community service hours

	public addService(h: number): void
	{
		if (typeof h !== 'number' || !isFinite(h)) return;
		this.serviceHours = Math.max(0, Math.min(10000, Math.round((this.serviceHours + h) * 100) / 100));
		this.saveService();
		for (let i = 0; i < this.serviceListeners.length; i++) { try { this.serviceListeners[i](); } catch (e) { /* ignore */ } }
	}

	private loadService(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			const raw = ls ? ls.getItem(SERVICE_KEY) : null;
			if (!raw) return;
			const d = JSON.parse(raw);
			if (!d || d.v !== 1) return;
			this.serviceHours = Math.max(0, Math.min(10000, +d.hours || 0));
			this.serviceDone = Math.max(0, +d.served || 0);
		}
		catch (e) { /* ignore */ }
	}

	private saveService(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			if (ls) ls.setItem(SERVICE_KEY, JSON.stringify({ v: 1, hours: this.serviceHours, served: Math.round(this.serviceDone * 100) / 100 }));
		}
		catch (e) { /* ignore */ }
	}

	// ------------------------------------------------------------------ duty

	/** Called by RealismJobs on duty changes. */
	public onDutyChange(on: boolean): void
	{
		if (on && this.dept())
		{
			this.topUpKit(this.jobs.state.id);
			this.dispatchIn = Math.min(this.settings.dispatchDelay, 1.5);
		}
		if (!on) this.endShift();
		this.wasOnDuty = this.onCivilDuty();
		this.lastJob = this.jobs.state.id;
	}

	private endShift(): void
	{
		this.cancelTask(false);
		if (this.workVehicle) { this.oldVehicles.push(this.workVehicle); this.workVehicle = null; }
		this.cleanVehicles();
		this.hud.set('');
		this.prompt.set(null);
	}

	/** Tops up the trade's supplies to its kit. Returns how many items were added. */
	public topUpKit(job: string): number
	{
		const kit = KITS[job];
		if (!kit) return 0;
		let n = 0;
		for (const k in kit)
		{
			if (!kit.hasOwnProperty(k)) continue;
			const have = this.inventory.count(k);
			if (have < kit[k]) { this.inventory.add(k, kit[k] - have); n += kit[k] - have; }
		}
		return n;
	}

	private kitLow(job: string): boolean
	{
		const kit = KITS[job];
		if (!kit) return false;
		for (const k in kit) if (kit.hasOwnProperty(k) && this.inventory.count(k) < kit[k]) return true;
		return false;
	}

	// ------------------------------------------------------------------ vehicles

	public vehicleAvailable(): boolean { return this.carState >= 0; }

	/** Spawns a stock sedan (when car.glb is loaded) and hands it to cb. */
	private spawnCar(x: number, y: number, z: number, heading: number, rgb: number[], rgb2: number[], cb: (car: any) => void): void
	{
		const make = () =>
		{
			if (this.carState !== 1) { cb(null); return; }
			let car: any = null;
			try
			{
				car = new Car({ scene: this.carGltf.scene.clone(true), animations: [] as any[] });
				const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
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
				car.spawnPoint = marker;
				this.world.add(car);
				car.updateMatrixWorld(true);
				car.realismDeptVehicle = true;     // never claimable / owned (C2)
				car.realismType = 'car';
				this.paint(car, rgb, rgb2);
			}
			catch (e) { console.warn('[Realism] work vehicle spawn failed', e); car = null; }
			cb(car);
		};
		if (this.carState === 0) this.waitingCars.push(make);
		else make();
	}

	private paint(car: any, rgb: number[], rgb2: number[]): void
	{
		if (!rgb) return;
		const tu = this.world.realismVehicleTuning;
		try
		{
			if (tu && typeof tu.apply === 'function') { tu.apply(car, rgb2 ? { rgb: rgb, rgb2: rgb2 } : { rgb: rgb }); return; }
			if (tu && typeof tu.paint === 'function') { tu.paint(car, rgb); return; }
		}
		catch (e) { /* fall back below */ }
		// no tuning system: own copy of the body material
		car.traverse((o: any) =>
		{
			if (!o.isMesh || !o.material || o.material.name !== 'Car') return;
			o.material = o.material.clone();
			o.material.color.setRGB(rgb[0], rgb[1], rgb[2]);
		});
	}

	private roadSpotNear(p: THREE.Vector3, radius: number, clearance: number): RoadSpot
	{
		const obst: { x: number; z: number }[] = [];
		const npcs: any = this.world.realismNPCs;
		const spots: any[] = npcs && npcs.vehicles ? npcs.vehicles.spots : [];
		for (let i = 0; i < spots.length; i++) if (!spots[i].car && spots[i].pos) obst.push(spots[i].pos);
		return findRoadSpot(this.ctx, p, { clearance: clearance, radius: radius, player: p, obstacles: obst }) ||
			findRoadSpot(this.ctx, p, { clearance: clearance, radius: radius * 2.5, player: p, obstacles: obst });
	}

	/** 'Get work vehicle' (via RealismJobs.getPatrolVehicle). */
	public getWorkVehicle(): { ok: boolean; message: string }
	{
		const d = this.dept();
		if (!d || !this.jobs.state.onDuty) return { ok: false, message: 'Go on duty first.' };
		if (this.carState < 0) return { ok: false, message: 'Work vehicle unavailable.' };
		const pl = this.player();
		if (this.workVehicle && this.occupied(this.workVehicle, pl)) return { ok: false, message: 'You are already in your ' + d.vehicleName + '.' };
		if (!this.playerPos(this.tmp)) return { ok: false, message: 'No player.' };
		const spot = this.roadSpotNear(this.tmp, 70, 3);
		if (!spot) return { ok: false, message: 'No room on the road nearby.' };
		if (this.workVehicle) { this.oldVehicles.push(this.workVehicle); this.workVehicle = null; }
		const job = d.id;
		this.spawnCar(spot.x, spot.y + 0.6, spot.z, spot.heading, d.vehicleRgb, d.vehicleRgb2, (car) =>
		{
			if (!car) return;
			car.realismWorkVehicle = job;
			car.realismDept = job;
			car.realismUnit = this.jobs.state.unit;
			if (!this.onCivilDuty() || this.jobs.state.id !== job) { this.oldVehicles.push(car); return; }
			this.workVehicle = car;
		});
		return { ok: true, message: d.vehicleName + (this.carState === 1 ? '' : ' requested') + ' on ' + (spot.road || 'the road') + ' next to you.' };
	}

	/** 'Go to depot': the GPS marks where tasks start (the site for construction). */
	public goToDepot(): { ok: boolean; message: string }
	{
		const d = this.dept();
		if (!d) return { ok: false, message: 'You have no trade job.' };
		let p: { x: number; z: number } = null, label = d.name;
		if (d.id === 'construction' && this.site && this.site.lot) { const c = this.site.center(); p = { x: c.x, z: c.z }; label = 'Verano Build Co. site'; }
		else if (this.task) { const t = this.firstOpen(); if (t) { p = { x: t.x, z: t.z }; label = this.task.title; } }
		if (!p) { const dp = this.depot(); if (dp) { p = { x: dp.x, z: dp.z }; label = d.name + ' depot'; } }
		if (!p) return { ok: false, message: 'Depot not found.' };
		const g = this.gps();
		if (g) { try { g.setWaypoint(p, label); this.gpsLabel = label; } catch (e) { /* ignore */ } return { ok: true, message: label + ' marked on your GPS.' }; }
		return { ok: true, message: label + ': ' + Math.round(p.x) + ', ' + Math.round(p.z) + '.' };
	}

	/** Nearest warehouse (deliveries, depot). */
	public depot(near?: THREE.Vector3, minDist?: number): { x: number; y: number; z: number; name: string } | null
	{
		const bs = this.ctx.data.buildings;
		let best: Building = null, bd = 1e18;
		const c = near || (this.site && this.site.lot ? this.site.center() : null) || (this.playerPos(this.tmp) ? this.tmp : null);
		if (!c) return null;
		const md = minDist || 0;
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.custom || b.closed || !(b.kind === 'warehouse' || b.style === 'warehouse')) continue;
			const d2 = (b.x - c.x) * (b.x - c.x) + (b.z - c.z) * (b.z - c.z);
			if (d2 < md * md) continue;
			if (d2 < bd) { bd = d2; best = b; }
		}
		if (!best) return null;
		const x = best.x + Math.sin(best.rot) * (best.d / 2 + 4), z = best.z + Math.cos(best.rot) * (best.d / 2 + 4);
		return { x: x, y: this.ctx.data.heightAt(x, z), z: z, name: best.label || 'Hardware depot' };
	}

	private occupied(car: any, who?: any): boolean
	{
		if (!car) return false;
		const seats: any[] = car.seats || [];
		for (let i = 0; i < seats.length; i++) { const o = seats[i].occupiedBy; if (o && (!who || o === who)) return true; }
		const cc = car.controllingCharacter;
		return !!cc && (!who || cc === who);
	}

	private cleanVehicles(): void
	{
		for (let i = this.oldVehicles.length - 1; i >= 0; i--)
		{
			const c = this.oldVehicles[i];
			if (this.occupied(c)) continue;
			try { if (this.world.vehicles && this.world.vehicles.indexOf(c) >= 0) this.world.remove(c); }
			catch (e) { console.warn('[Realism] work vehicle remove failed', e); }
			this.oldVehicles.splice(i, 1);
		}
		if (this.workVehicle && this.world.vehicles && this.world.vehicles.indexOf(this.workVehicle) < 0) this.workVehicle = null;
	}

	// ------------------------------------------------------------------ electrician props

	private buildElectricProps(): void
	{
		const d = this.ctx.data;
		const bs = d.buildings;
		const accs = new AccumSet();
		const acWant = this.settings.acUnits, pnWant = this.settings.panels;
		const shopSubs = /market|diner|convenience|clothing|restaurant|barber|laundromat|cafe|bank|mechanic|dealer|liquor|pharmacy|store|shop/;
		const officeSubs = /cityhall|court|bank|office|lobby/;
		const order: number[] = [];
		for (let i = 0; i < bs.length; i++) order.push(i);
		order.sort((a, b) => hash01(a, 7) - hash01(b, 7));
		for (let oi = 0; oi < order.length && (this.acSpots.length < acWant || this.panelSpots.length < pnWant || this.officeSpots.length < 40); oi++)
		{
			const i = order[oi];
			const b = bs[i];
			if (b.custom || b.closed || b.boarded || b.h < 3.5 || b.w < 5 || b.d < 5) continue;
			const g = typeof b.groundY === 'number' ? b.groundY : d.heightAt(b.x, b.z);
			const f = new Frame(b.x, g, b.z, b.rot);
			const acc = accs.get(chunkKey(b.x, b.z, RENDER_CHUNK));
			const plain = (b.sub && (shopSubs.test(b.sub) || officeSubs.test(b.sub))) ? b.sub : (b.kind || 'building');
			const name = b.label ? b.label.charAt(0) + b.label.slice(1).toLowerCase() : (/^[aeiou]/.test(plain) ? 'an ' : 'a ') + plain;
			const kind = b.kind || '';
			const isShop = kind === 'shop' || (!!b.sub && shopSubs.test(b.sub));
			// AC unit on a side wall (+ one on a flat roof)
			if (this.acSpots.length < acWant && (kind === 'shop' || kind === 'office' || kind === 'apartment' || kind === 'house' || kind === 'warehouse' || kind === 'tower'))
			{
				for (const side of [1, -1])
				{
					const ax = side * (b.w / 2 + 1.5);
					const ap = f.p(ax, 0, 0);
					if (!this.index.freeSpot(ap[0], ap[2], 0.9)) continue;
					const wp = f.p(side * (b.w / 2 + 0.4), 0, 0);
					const owner = this.index.buildingAt(wp[0], wp[2], 0.6);   // the wall spot must belong to this building, not a neighbour
					if (owner !== i && owner !== -1) continue;
					const wx = side * (b.w / 2);
					const y0 = Math.min(2.3, b.h - 1.2);
					// unit, fan grille, pipe
					box(acc, f, side > 0 ? wx : wx - 0.55, y0, -0.45, side > 0 ? wx + 0.55 : wx, y0 + 0.62, 0.45, [0.86, 0.86, 0.84]);
					box(acc, f, side > 0 ? wx + 0.55 : wx - 0.57, y0 + 0.1, -0.3, side > 0 ? wx + 0.57 : wx - 0.55, y0 + 0.52, 0.3, [0.25, 0.26, 0.27]);
					box(acc, f, side > 0 ? wx : wx - 0.06, 0.4, 0.3, side > 0 ? wx + 0.06 : wx, y0, 0.36, [0.6, 0.6, 0.58]);
					if (b.roof === 'flat' && b.h > 4) box(acc, f, -1.0, b.h + (b.baseY - g), -b.d / 4 - 0.8, 1.0, b.h + (b.baseY - g) + 1.1, -b.d / 4 + 0.8, [0.72, 0.73, 0.72]);
					this.acSpots.push({ x: ap[0], y: d.heightAt(ap[0], ap[2]), z: ap[2], name: name, bi: i });
					this.index.addObstacle(f.p(wx + side * 0.3, 0, 0)[0], f.p(wx + side * 0.3, 0, 0)[2], 0.4);
					break;
				}
			}
			// alarm panel + camera at shops and banks (front wall)
			if (this.panelSpots.length < pnWant && isShop)
			{
				const ap = f.p(-b.w / 2 + 1.0, 0, b.d / 2 + 1.1);
				if (this.index.freeSpot(ap[0], ap[2], 0.6))
				{
					const fz = b.d / 2;
					box(acc, f, -b.w / 2 + 0.7, 1.25, fz, -b.w / 2 + 1.3, 1.75, fz + 0.08, [0.9, 0.9, 0.88]);
					box(acc, f, -b.w / 2 + 0.8, 1.55, fz + 0.08, -b.w / 2 + 1.2, 1.68, fz + 0.1, [0.15, 0.6, 0.25]);
					const cy = Math.min(3.4, b.h - 0.6);
					box(acc, f, b.w / 2 - 0.45, cy, fz, b.w / 2 - 0.25, cy + 0.15, fz + 0.3, [0.85, 0.85, 0.85]);
					box(acc, f, b.w / 2 - 0.5, cy - 0.12, fz + 0.2, b.w / 2 - 0.2, cy + 0.04, fz + 0.5, [0.2, 0.2, 0.22]);
					this.panelSpots.push({ x: ap[0], y: d.heightAt(ap[0], ap[2]), z: ap[2], name: name, bi: i });
				}
			}
			// office computers / server closet, inside by the front door
			if (this.officeSpots.length < 40 && b.enterable && (kind === 'office' || kind === 'tower' || (!!b.sub && officeSubs.test(b.sub))))
			{
				const p = f.p(b.w / 2 - 1.6, 0, b.d / 2 - 1.8);
				this.officeSpots.push({ x: p[0], y: g + 0.1, z: p[2], name: name, bi: i });
			}
		}
		for (let k = 0; k < accs.keys.length; k++)
		{
			const a = accs.get(accs.keys[k]);
			if (a.empty) continue;
			const m = addMesh(this.ctx, a.toGeometry(), this.ctx.mats.plain, false, false, 'detail');
			m.name = 'realismElectricProps';
		}
		this.stats.acUnits = this.acSpots.length;
		this.stats.panels = this.panelSpots.length;
	}

	// ------------------------------------------------------------------ dispatch

	private chooseKind(d: Department): string
	{
		const kinds = d.kinds || [], ws = d.weights || [];
		const ok: string[] = [], w: number[] = [];
		for (let i = 0; i < kinds.length; i++)
		{
			const k = kinds[i];
			if (k === 'streetlight' && !this.night()) continue;
			if (d.id === 'construction' && (!this.site || !this.site.lot)) continue;
			if (k === 'build' && this.site && this.site.stock <= 0) continue;
			if (k === 'vehicle' && this.carState < 0) continue;
			ok.push(k); w.push(ws[i] || 1);
		}
		if (d.id === 'construction' && this.site && this.site.lot && this.site.stock <= 0) return 'deliver';
		let sum = 0;
		for (let i = 0; i < w.length; i++) sum += w[i];
		let r = this.rnd() * sum;
		for (let i = 0; i < ok.length; i++) { r -= w[i]; if (r <= 0) return ok[i]; }
		return ok[ok.length - 1] || null;
	}

	/** Gives the next task now. kind forces a task kind (tests, phone). Returns the task or null. */
	public dispatch(kind?: string): Task
	{
		const d = this.dept();
		if (!d || !this.jobs.state.onDuty) return null;
		this.cancelTask(false);
		if (!this.playerPos(this.tmp)) return null;
		const k = kind || this.chooseKind(d);
		if (!k) return null;
		let t: Task = null;
		try { t = this.makeTask(d, k, this.tmp.clone()); }
		catch (e) { console.warn('[Realism] task ' + k + ' failed', e); t = null; }
		if (!t) { this.dispatchIn = 5; return null; }
		this.task = t;
		this.visuals.rebuild();
		this.updateGuidance(true);
		rrToast(d.name + ': ' + t.title + (t.where ? ', ' + t.where : '') + '.', 3200);
		return t;
	}

	private newTask(d: Department, kind: string, title: string, where: string): Task
	{
		return { id: ++this.taskSeq, job: d.id, kind: kind, title: title, where: where, pay: (d.pay && d.pay[kind]) || 0, phases: [], phase: 0 };
	}

	private tgt(x: number, y: number, z: number, r: number, label: string, hold: number, extra?: any): Target
	{
		const t: Target = { x: x, y: y, z: z, r: r, label: label, hold: hold, done: false };
		if (extra) for (const k in extra) if (extra.hasOwnProperty(k)) (t as any)[k] = extra[k];
		return t;
	}

	/** A road lane spot at a random distance from p. */
	private taskRoadSpot(p: THREE.Vector3, minD?: number, maxD?: number): RoadSpot
	{
		const lo = minD !== undefined ? minD : this.settings.minDist, hi = maxD !== undefined ? maxD : this.settings.maxDist;
		const q = new THREE.Vector3();
		for (let i = 0; i < 10; i++)
		{
			const a = this.rnd() * Math.PI * 2, r = lo + this.rnd() * (hi - lo);
			q.set(p.x + Math.cos(a) * r, 0, p.z + Math.sin(a) * r);
			if (Math.abs(q.x) > 1900 || Math.abs(q.z) > 1900) continue;
			const s = findRoadSpot(this.ctx, q, { clearance: 2.5, radius: 90 });
			if (s) return s;
		}
		return findRoadSpot(this.ctx, p, { clearance: 2.5, radius: 200, player: p });
	}

	private nearestOf(list: Spot[], p: THREE.Vector3, minD: number): Spot
	{
		const cands = list.filter((s) => { const dx = s.x - p.x, dz = s.z - p.z; const dd = dx * dx + dz * dz; return dd > minD * minD && dd < this.settings.maxDist * this.settings.maxDist * 2.5; });
		if (cands.length) return this.pick(cands);
		let best: Spot = null, bd = 1e18;
		for (let i = 0; i < list.length; i++) { const s = list[i]; const dd = (s.x - p.x) * (s.x - p.x) + (s.z - p.z) * (s.z - p.z); if (dd < bd) { bd = dd; best = s; } }
		return best;
	}

	private needItem(id: string, qty: number): () => string
	{
		return () => this.inventory.count(id) >= qty ? '' : 'Need ' + this.inventory.defOf(id).name.toLowerCase() + ': restock at your work vehicle';
	}

	private makeTask(d: Department, kind: string, p: THREE.Vector3): Task
	{
		const data = this.ctx.data;
		const V = this.visuals;
		V.items.length = 0;
		switch (kind)
		{
			// ---------------------------------------------------------- DOT
			case 'pothole':
			{
				const s = this.taskRoadSpot(p);
				if (!s) return null;
				const t = this.newTask(d, kind, 'Fill a pothole', 'on ' + s.road);
				const vi = V.add('pothole', s.x, s.y, s.z, s.heading);
				t.phases.push([this.tgt(s.x, s.y, s.z, 2.4, 'Fill pothole', 4, { consume: ['asphalt', 1], vis: vi })]);
				return t;
			}
			case 'cones':
			{
				const s = this.taskRoadSpot(p);
				if (!s) return null;
				const t = this.newTask(d, kind, 'Cone off a work zone', 'on ' + s.road);
				const fr = new Frame(s.x, s.y, s.z, s.heading);
				const ph: Target[] = [];
				for (const c of [[-1.5, -4], [1.5, -4], [-1.5, 4], [1.5, 4]])
				{
					const w = fr.p(c[0], 0, c[1]);
					const vi = V.add('cone', w[0], data.heightAt(w[0], w[2]) > s.y + 0.5 ? s.y : s.y, w[2], 0);
					V.items[vi].on = false;
					ph.push(this.tgt(w[0], s.y, w[2], 1.6, 'Place cone', 0, { consume: ['cone', 1], vis: vi }));
				}
				t.phases.push(ph);
				t.cleanup = () => { this.inventory.add('cone', ph.filter((q) => q.done).length); };   // the crew collects the cones
				return t;
			}
			case 'streetlight':
			{
				const lamps = data.lamps.filter((l) => { const dd = (l.x - p.x) * (l.x - p.x) + (l.z - p.z) * (l.z - p.z); return dd > 40 * 40 && dd < this.settings.maxDist * this.settings.maxDist; });
				const broken = lamps.filter((l) => l.broken);
				const l = this.pick(broken.length ? broken : lamps);
				if (!l) return null;
				const t = this.newTask(d, kind, 'Repair a street light', 'near ' + Math.round(l.x) + ', ' + Math.round(l.z));
				const x = l.x + Math.sin(l.r) * 0.9, z = l.z + Math.cos(l.r) * 0.9;
				t.phases.push([this.tgt(x, data.heightAt(x, z), z, 2.2, 'Repair street light', 5, { check: () => this.night() ? '' : 'Street lights are repaired at night' })]);
				return t;
			}
			case 'signal':
			{
				const ins = data.intersections.filter((q) => { const dd = (q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z); return q.control === 'signal' && dd > 50 * 50 && dd < this.settings.maxDist * this.settings.maxDist * 2; });
				const q = this.pick(ins.length ? ins : data.intersections.filter((z) => z.control === 'signal'));
				if (!q || !q.arms.length) return null;
				const a0 = q.arms[0], a1 = q.arms[1] || { dx: -a0.dz, dz: a0.dx };
				let dx = a0.dx + a1.dx, dz = a0.dz + a1.dz;
				const l = Math.sqrt(dx * dx + dz * dz) || 1;
				dx /= l; dz /= l;
				const r = q.crossHW + 2.8;
				const x = q.x + dx * r, z = q.z + dz * r;
				const t = this.newTask(d, kind, 'Fix a traffic signal controller', 'at a junction ' + Math.round(Math.sqrt((q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z))) + ' m away');
				t.phases.push([this.tgt(x, data.heightAt(x, z), z, 2.6, 'Open signal controller', 0, { mg: () => new SequenceGame('Signal controller: reset sequence', 5, this.rnd) })]);
				return t;
			}
			case 'debris':
			{
				const s = this.taskRoadSpot(p);
				if (!s) return null;
				const t = this.newTask(d, kind, 'Clear debris off the road', 'on ' + s.road);
				const fr = new Frame(s.x, s.y, s.z, s.heading);
				const types = ['tire', 'crate', 'branch'];
				const ph: Target[] = [];
				for (let i = 0; i < 3; i++)
				{
					const w = fr.p((this.rnd() - 0.5) * 2, 0, (i - 1) * 3.5);
					const vi = V.add(types[i], w[0], s.y, w[2], this.rnd() * 6);
					ph.push(this.tgt(w[0], s.y, w[2], 1.8, 'Clear debris', 1.5, { vis: vi }));
				}
				t.phases.push(ph);
				return t;
			}
			case 'lines':
			{
				const s = this.taskRoadSpot(p);
				if (!s) return null;
				const t = this.newTask(d, kind, 'Repaint road lines', 'on ' + s.road);
				const fr = new Frame(s.x, s.y, s.z, s.heading);
				const ph: Target[] = [];
				for (let i = 0; i < 3; i++)
				{
					const w = fr.p(-0.2, 0, (i - 1) * 4.5);
					const vi = V.add('line', w[0], s.y + 0.01, w[2], s.heading);
					V.items[vi].on = true;
					ph.push(this.tgt(w[0], s.y, w[2], 1.8, 'Paint road line', 2.5, i === 0 ? { consume: ['roadPaint', 1], vis: vi } : { vis: vi }));
				}
				t.phases.push(ph);
				return t;
			}
			// ---------------------------------------------------------- community service
			case 'litter':
			{
				const parks = data.landmarks.filter((l) => l.kind === 'park' || l.kind === 'leisure');
				let c: { x: number; z: number; name: string } = null;
				const pk = this.pick(parks);
				if (pk) c = { x: pk.x, z: pk.z, name: pk.name };
				else { const s = this.taskRoadSpot(p); if (s) c = { x: s.x, z: s.z, name: s.road }; }
				if (!c) return null;
				const t = this.newTask(d, kind, 'Pick up litter', 'in ' + c.name);
				t.credit = 1;
				const ph: Target[] = [];
				for (let tries = 0; tries < 80 && ph.length < 5; tries++)
				{
					const a = this.rnd() * Math.PI * 2, r = 6 + this.rnd() * 22;
					const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
					if (!this.index.freeSpot(x, z, 1.2)) continue;
					if (ph.some((q) => (q.x - x) * (q.x - x) + (q.z - z) * (q.z - z) < 9)) continue;
					const y = data.heightAt(x, z);
					const vi = V.add('litter', x, y, z, this.rnd() * 6);
					ph.push(this.tgt(x, y, z, 1.6, 'Pick up litter bag', 0, { vis: vi, onDone: () => this.inventory.add('litterBag', 1) }));
				}
				if (ph.length < 3) return null;
				t.phases.push(ph);
				// drop off at the nearest dumpster / trash can
				let bin: { x: number; z: number } = null, bd = 150 * 150;
				for (let i = 0; i < data.props.length; i++)
				{
					const q = data.props[i];
					if (q.type !== 'dumpster' && q.type !== 'trashCan') continue;
					const dd = (q.x - c.x) * (q.x - c.x) + (q.z - c.z) * (q.z - c.z);
					if (dd < bd) { bd = dd; bin = { x: q.x + 1.2, z: q.z + 1.2 }; }
				}
				if (!bin) bin = { x: ph[0].x, z: ph[0].z };
				const n = ph.length;
				t.phases.push([this.tgt(bin.x, data.heightAt(bin.x, bin.z), bin.z, 2.4, 'Dump litter bags', 0,
					{ check: () => this.inventory.count('litterBag') > 0 ? '' : 'No litter bags', onDone: () => this.inventory.remove('litterBag', Math.min(n, this.inventory.count('litterBag'))) })]);
				t.cleanup = () => { const c2 = this.inventory.count('litterBag'); if (c2 > 0) this.inventory.remove('litterBag', c2); };
				return t;
			}
			case 'sweep':
			{
				const s = this.taskRoadSpot(p);
				if (!s) return null;
				const road = data.roads.filter((r) => r.name === s.road)[0];
				const hw = road ? road.width / 2 : 5;
				const fr = new Frame(s.x, s.y, s.z, s.heading);
				const ph: Target[] = [];
				for (let i = 0; i < 12 && ph.length < 3; i++)
				{
					// sidewalk strip on one side, then the other
					const side = i < 6 ? 1 : -1;
					const w = fr.p(side * (hw + 1.6), 0, ((i % 6) - 2) * 4);
					if (this.index.buildingAt(w[0], w[2], 0.4) >= 0 || this.index.objectNear(w[0], w[2], 0.3)) continue;
					const y = Math.max(s.y, data.heightAt(w[0], w[2]));
					const vi = V.add('dirt', w[0], y + 0.02, w[2], this.rnd() * 3);
					ph.push(this.tgt(w[0], y, w[2], 1.8, 'Sweep', 3, { vis: vi, consume: ['broom', 0] }));
				}
				if (!ph.length) return null;
				const t = this.newTask(d, kind, 'Sweep the sidewalk', 'along ' + s.road);
				t.credit = 0.5;
				t.phases.push(ph);
				return t;
			}
			case 'graffiti':
			{
				const bs = data.buildings;
				const cands: number[] = [];
				for (let i = 0; i < bs.length; i++)
				{
					const b = bs[i];
					if (b.custom || b.w < 6 || b.h < 3) continue;
					const dd = (b.x - p.x) * (b.x - p.x) + (b.z - p.z) * (b.z - p.z);
					if (dd < 40 * 40 || dd > this.settings.maxDist * this.settings.maxDist * 2) continue;
					cands.push(i);
				}
				const hood = cands.filter((i) => bs[i].district === 'hood');
				for (let tries = 0; tries < 30; tries++)
				{
					const bi = this.pick(hood.length && this.rnd() < 0.7 ? hood : cands);
					if (bi === null || bi === undefined) return null;
					const b = bs[bi];
					const g = typeof b.groundY === 'number' ? b.groundY : data.heightAt(b.x, b.z);
					// a side wall with free ground in front of it
					for (const side of [1, -1])
					{
						const f = new Frame(b.x, g, b.z, b.rot);
						const ok = [-1.6, 1.6].every((lz) => { const q = f.p(side * (b.w / 2 + 1.3), 0, lz); return this.index.freeSpot(q[0], q[2], 0.8); });
						if (!ok) continue;
						const t = this.newTask(d, kind, 'Paint over graffiti', 'on ' + (b.label ? b.label.toLowerCase() : 'a ' + (b.kind || 'building')) + (b.district === 'hood' ? ' in the hood' : ''));
						t.credit = 1;
						const ph: Target[] = [];
						const wallRot = b.rot + side * Math.PI / 2;
						for (const lz of [-1.6, 1.6])
						{
							const wpt = f.p(side * (b.w / 2 + 0.02), 0, lz);
							const vi = V.add('graffiti', wpt[0], g, wpt[2], wallRot);
							const q = f.p(side * (b.w / 2 + 1.3), 0, lz);
							ph.push(this.tgt(q[0], data.heightAt(q[0], q[2]), q[2], 1.9, 'Paint over graffiti', 4, { vis: vi }));
						}
						t.phases.push(ph);
						return t;
					}
				}
				return null;
			}
			// ---------------------------------------------------------- construction
			case 'build':
			{
				const site = this.site;
				if (!site || !site.lot) return null;
				const ids = site.nextPieces(site.settings.piecesPerTask);
				if (!ids.length) return null;
				const st = site.stageInfo();
				const t = this.newTask(d, kind, 'Build: ' + st.name.toLowerCase() + ' (' + ids.length + ' piece' + (ids.length > 1 ? 's' : '') + ')', 'at the Verano Build Co. site');
				for (let i = 0; i < ids.length; i++)
				{
					const sp = site.pieceSpot(ids[i]);
					const pc = site.pieces[ids[i]];
					t.phases.push([this.tgt(sp.x, sp.y, sp.z, 3.0, 'Place ' + pc.kind, 2,
						{ check: () => site.stock > 0 ? '' : 'Out of materials: deliver supplies', onDone: () => { site.placeNext(); if (!site.lot || site.placed === 0) t.bonus = (this.dept() && this.dept().pay.complete) || 0; } })]);
				}
				site.showGhosts(ids);
				t.cleanup = () => site.showGhosts([]);
				return t;
			}
			case 'deliver':
			{
				const site = this.site;
				if (!site || !site.lot) return null;
				const c = site.center();
				const dp = this.depot(c, 120) || this.depot(c, 0);
				if (!dp) return null;
				const t = this.newTask(d, kind, 'Deliver building supplies', 'from ' + dp.name.toLowerCase() + ' to the site');
				const crates = 4;
				const ts = this.roadSpotNear(new THREE.Vector3(dp.x, dp.y, dp.z), 60, 3);
				if (ts && this.carState >= 0)
				{
					this.spawnCar(ts.x, ts.y + 0.6, ts.z, ts.heading, [0.95, 0.75, 0.1], [0.2, 0.2, 0.22], (car) =>
					{
						if (!car) return;
						car.realismWorkVehicle = 'supply';
						if (this.task !== t) { this.oldVehicles.push(car); return; }
						this.supplyTruck = car;
					});
				}
				const pick = ts ? { x: ts.x, y: ts.y, z: ts.z } : dp;
				const u = site.unloadSpot();
				t.phases.push([this.tgt(pick.x, pick.y, pick.z, 5, 'Load supply truck', 0, { onDone: () =>
				{
					this.inventory.add('supplyCrate', crates);
					const g = this.gps();
					if (g) { try { g.setWaypoint({ x: u.x, z: u.z }, 'Verano Build Co. site'); this.gpsLabel = 'Verano Build Co. site'; } catch (e) { /* ignore */ } }
				} })]);
				t.phases.push([this.tgt(u.x, u.y, u.z, 9, 'Unload supplies', 3, {
					vehicle: true,
					check: () =>
					{
						const tr = this.supplyTruck;
						if (tr && this.world.vehicles.indexOf(tr) >= 0 && tr.position.distanceTo(new THREE.Vector3(u.x, tr.position.y, u.z)) > 14) return 'Bring the supply truck here';
						return '';
					},
					onDone: () =>
					{
						const n = this.inventory.count('supplyCrate');
						if (n > 0) this.inventory.remove('supplyCrate', n);
						site.addStock(Math.max(1, n) * Math.max(1, Math.round(site.settings.deliveryStock / crates)));
					},
				})]);
				t.cleanup = () =>
				{
					if (this.supplyTruck) { this.oldVehicles.push(this.supplyTruck); this.supplyTruck = null; }
					const n = this.inventory.count('supplyCrate');
					if (n > 0) this.inventory.remove('supplyCrate', n);
				};
				return t;
			}
			case 'blueprint':
			{
				const site = this.site;
				if (!site || !site.lot) return null;
				const o = site.officeSpot();
				const t = this.newTask(d, kind, 'Design a blueprint for a client', 'in the site office');
				const base = t.pay;
				t.phases.push([this.tgt(o.x, o.y, o.z, 2.6, 'Open blueprint designer', 0, {
					mg: () => new BlueprintGame(makeBrief(this.rnd), this.settings.blueprintPass),
					onDone: (_t: Target, mg: Minigame) =>
					{
						const sc = mg && (mg as BlueprintGame).score ? (mg as BlueprintGame).score : 1;
						t.pay = Math.round(base * sc);
						this.inventory.add('blueprint', 1);
					},
				})]);
				return t;
			}
			// ---------------------------------------------------------- electrician
			case 'ac':
			{
				const s = this.nearestOf(this.acSpots, p, 40);
				if (!s) return null;
				const t = this.newTask(d, kind, 'Repair an AC unit', 'at ' + s.name);
				t.phases.push([this.tgt(s.x, s.y, s.z, 2.4, 'Repair AC unit', 0, { consume: ['wire', 1], mg: () => new WireGame('AC unit: reconnect the wiring', 4, this.rnd) })]);
				return t;
			}
			case 'computer':
			{
				const s = this.nearestOf(this.officeSpots, p, 40);
				if (!s) return null;
				const t = this.newTask(d, kind, 'Fix the office computers', 'at ' + s.name);
				t.phases.push([this.tgt(s.x, s.y, s.z, 2.8, 'Open server closet', 0, { consume: ['multimeter', 0], mg: () => new SequenceGame('Server closet: run diagnostics', 5, this.rnd) })]);
				return t;
			}
			case 'security':
			{
				const s = this.nearestOf(this.panelSpots, p, 40);
				if (!s) return null;
				const t = this.newTask(d, kind, 'Service a security system', 'at ' + s.name);
				t.phases.push([this.tgt(s.x, s.y, s.z, 2.2, 'Open alarm panel', 0, { check: this.needItem('fuse', 1), mg: () => new FuseGame('Alarm panel: fuse box', 8, 2 + Math.floor(this.rnd() * 2), this.rnd, this.inventory.api) })]);
				return t;
			}
			case 'vehicle':
			{
				const s = this.taskRoadSpot(p);
				if (!s) return null;
				const t = this.newTask(d, kind, 'Fix a broken-down car', 'on ' + s.road);
				this.spawnCar(s.x, s.y + 0.6, s.z, s.heading, [0.3 + this.rnd() * 0.5, 0.3 + this.rnd() * 0.3, 0.3 + this.rnd() * 0.4], null, (car) =>
				{
					if (!car) return;
					car.realismWorkVehicle = 'broken';
					this.hoodUp(car);
					if (this.task !== t) { this.oldVehicles.push(car); return; }
					this.brokenCar = car;
				});
				const fr = new Frame(s.x, s.y, s.z, s.heading);
				const w = fr.p(0, 0, 3.2);
				t.phases.push([this.tgt(w[0], s.y, w[2], 2.4, 'Diagnose the car', 0, { consume: ['multimeter', 0], mg: () => new SequenceGame('Vehicle diagnostics', 4, this.rnd) })]);
				t.phases.push([this.tgt(w[0], s.y, w[2], 2.4, 'Repair the wiring', 4, { consume: ['wire', 1] })]);
				t.cleanup = () => { if (this.brokenCar) { this.oldVehicles.push(this.brokenCar); this.brokenCar = null; } };
				return t;
			}
		}
		return null;
	}

	/** A raised hood on a broken-down car (child mesh, the car's own geometry stays). */
	private hoodUp(car: any): void
	{
		try
		{
			const a = new GeoAccum();
			const f = new Frame(0, 0, 0, 0);
			box(a, f, -0.7, -0.02, -0.02, 0.7, 0.02, 1.05, [0.25, 0.25, 0.27]);
			const m = new THREE.Mesh(a.toGeometry(), this.ctx.mats.plain);
			m.position.set(0, 0.85, 0.75);
			m.rotation.x = -1.05;
			m.name = 'realismHoodUp';
			car.add(m);
		}
		catch (e) { /* cosmetic */ }
	}

	/** Stops the current task. paid: completion path (no cleanup of rewards). */
	public cancelTask(paid: boolean): void
	{
		const t = this.task;
		if (!t) return;
		this.task = null;
		this.minigames.cancel();
		if (t.cleanup) { try { t.cleanup(); } catch (e) { console.warn('[Realism] task cleanup failed', e); } }
		this.visuals.clear();
		this.markers.setPoints([]);
		this.markerSig = '';
		this.clearGuidance();
		this.cur = null;
		this.holdTime = 0;
		this.prompt.set(null);
		if (!paid) this.dispatchIn = this.settings.dispatchDelay;
	}

	/** 'Skip task' in the Jobs app. */
	public skipTask(): { ok: boolean; message: string }
	{
		if (!this.task) return { ok: false, message: 'No task right now.' };
		const title = this.task.title;
		this.cancelTask(false);
		this.dispatchIn = Math.max(this.settings.dispatchDelay, 8);
		return { ok: true, message: 'Skipped: ' + title + '. Next task soon.' };
	}

	private completeTask(): void
	{
		const t = this.task;
		const d = this.dept();
		if (!t || !d) return;
		let pay = Math.max(0, Math.round(t.pay + (t.bonus || 0)));
		let note = '';
		if (t.job === 'community')
		{
			const owed = this.serviceHours;
			const credit = t.credit || 0.5;
			this.serviceDone += credit;
			if (owed > 0)
			{
				pay = 0;
				this.addService(-credit);
				note = ' ' + credit + ' h of community service worked off, ' + this.serviceHours + ' h left.';
			}
			else this.saveService();
		}
		this.stats.tasks++;
		this.lastPay = pay;
		const eco = this.world.realismEconomy;
		if (pay > 0 && eco && typeof eco.earn === 'function') { eco.earn(pay, d.title + ': ' + t.title, d.name, 'bank'); this.stats.paid += pay; }
		emitEvent(this.world, 'jobCompleted', { job: t.job, pay: pay, task: t.kind, title: t.title });
		rrToast((pay > 0 ? 'Task done: +$' + pay + '.' : 'Task done.') + (t.bonus ? ' Project complete!' : '') + note, 3200);
		this.cancelTask(true);
		this.dispatchIn = this.settings.dispatchDelay;
	}

	// ------------------------------------------------------------------ guidance

	public firstOpen(): Target
	{
		const t = this.task;
		if (!t || t.phase >= t.phases.length) return null;
		const ph = t.phases[t.phase];
		let best: Target = null, bd = 1e18;
		const has = this.playerPos(this.tmp);
		for (let i = 0; i < ph.length; i++)
		{
			if (ph[i].done) continue;
			const dd = has ? (ph[i].x - this.tmp.x) * (ph[i].x - this.tmp.x) + (ph[i].z - this.tmp.z) * (ph[i].z - this.tmp.z) : i;
			if (dd < bd) { bd = dd; best = ph[i]; }
		}
		return best;
	}

	private updateGuidance(force: boolean): void
	{
		const t = this.task;
		if (!t) return;
		const ph = t.phases[t.phase] || [];
		const pts: number[] = [];
		let sig = t.id + ':' + t.phase;
		for (let i = 0; i < ph.length; i++) if (!ph[i].done) { pts.push(ph[i].x, ph[i].y, ph[i].z); sig += ',' + i; }
		if (sig !== this.markerSig) { this.markerSig = sig; this.markers.setPoints(pts); force = true; }
		if (!force) return;
		const f = this.firstOpen();
		const g = this.gps();
		if (!f || !g) return;
		const label = t.title;
		try
		{
			g.setWaypoint({ x: f.x, z: f.z }, label);
			this.gpsLabel = label;
			if (typeof g.addBlip === 'function') { g.addBlip('jobs.task', { x: f.x, z: f.z, icon: t.job === 'construction' ? 'construction' : 'job', color: '#f2c230', label: label }); this.blipIds['jobs.task'] = true; }
		}
		catch (e) { console.warn('[Realism] GPS failed', e); }
	}

	private clearGuidance(): void
	{
		const g = this.gps();
		if (!g) return;
		try
		{
			const cur = typeof g.current === 'function' ? g.current() : null;
			if (cur && cur.label === this.gpsLabel && typeof g.clear === 'function') g.clear();
			if (this.blipIds['jobs.task'] && typeof g.removeBlip === 'function') g.removeBlip('jobs.task');
			delete this.blipIds['jobs.task'];
		}
		catch (e) { /* ignore */ }
		this.gpsLabel = '';
	}

	private siteBlip(): void
	{
		const g = this.gps();
		if (!g || typeof g.addBlip !== 'function' || !this.site) return;
		const has = !!this.blipIds['jobs.site'];
		if (this.site.lot)
		{
			const c = this.site.center();
			const key = Math.round(c.x) + ',' + Math.round(c.z);
			if (has && (this as any).siteBlipKey === key) return;
			try { g.addBlip('jobs.site', { x: c.x, z: c.z, icon: 'construction', color: '#f2c230', label: 'Verano Build Co. construction site', shortRange: true }); this.blipIds['jobs.site'] = true; (this as any).siteBlipKey = key; }
			catch (e) { /* ignore */ }
		}
		else if (has) { try { g.removeBlip('jobs.site'); } catch (e) { /* ignore */ } delete this.blipIds['jobs.site']; }
	}

	// ------------------------------------------------------------------ input

	private bindInput(): void
	{
		try
		{
			if (typeof window === 'undefined' || !(window as any).addEventListener) return;
			(window as any).addEventListener('keydown', (e: KeyboardEvent) =>
			{
				const t: any = e.target;
				if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
				if (e.code === 'KeyE' && !e.repeat) this.keyDown('KeyE');
			}, true);
			(window as any).addEventListener('keyup', (e: KeyboardEvent) => { if (e.code === 'KeyE') this.keyUp('KeyE'); }, true);
			(window as any).addEventListener('blur', () => { this.eHeld = false; }, false);
		}
		catch (e) { /* headless */ }
	}

	/** Public for tests: E pressed. Runs a press action when our prompt is the active one. */
	public keyDown(code: string): boolean
	{
		if (code !== 'KeyE') return false;
		this.eHeld = true;
		const w = this.world;
		if (w.realismPaused || w.realismUIBlocking || this.minigames.isOpen) return false;
		const c = this.cur;
		if (!c || !this.prompt.active()) return false;
		if (c.blocked) { rrToast(c.blocked + '.'); return true; }
		if (c.hold > 0) return true;   // progress runs in update()
		this.rescan = true;
		c.run();
		return true;
	}

	public keyUp(code: string): void { if (code === 'KeyE') this.eHeld = false; }

	// ------------------------------------------------------------------ per frame

	public update(timeStep: number, unscaled: number): void
	{
		const w = this.world;
		const dt = Math.min(0.1, unscaled || timeStep || 0);
		const civ = this.onCivilDuty();
		if (civ !== this.wasOnDuty || this.jobs.state.id !== this.lastJob)
		{
			// duty or job changed outside onDutyChange (load, setJob while on duty)
			if (!civ) this.endShift(); else { this.cancelTask(false); this.topUpKit(this.jobs.state.id); this.dispatchIn = 1; }
			this.wasOnDuty = civ;
			this.lastJob = this.jobs.state.id;
		}
		this.slowAcc += dt;
		if (this.slowAcc >= 0.5)
		{
			this.slowAcc = 0;
			if (this.oldVehicles.length || this.workVehicle) this.cleanVehicles();
			if (this.jobs.state.id === 'construction') this.siteBlip();
			const hasApi = !!(w.realismPrompt && typeof w.realismPrompt.set === 'function');
			if (hasApi !== this.hadPromptApi) { this.hadPromptApi = hasApi; this.prompt.refresh(); }
		}
		if (w.realismPaused === true) return;
		if (!civ) { if (this.cur) { this.cur = null; this.prompt.set(null); } return; }
		this.markers.update(dt);
		this.hudAcc += dt;
		if (!this.task)
		{
			if (this.hudAcc >= 0.5) { this.hudAcc = 0; this.hud.set(this.dept().name + ': waiting for the next call...'); }
			this.dispatchIn -= dt;
			if (this.dispatchIn <= 0) { this.dispatchIn = 5; this.dispatch(); }
		}
		else if (this.hudAcc >= 0.25) { this.hudAcc = 0; this.updateHud(); }
		// what is in range: 10 times a second (the hold timer below runs every frame)
		this.scanAcc += dt;
		if (this.scanAcc >= 0.1 || this.rescan)
		{
			this.scanAcc = 0;
			this.rescan = false;
			const blocked = w.realismUIBlocking === true || this.minigames.isOpen;
			const n = blocked ? null : this.findInteraction();
			const c0 = this.cur;
			if (!n) { if (c0) { this.cur = null; this.prompt.set(null); this.holdTime = 0; } }
			else if (!c0 || c0.t !== n.t || c0.blocked !== n.blocked || c0.label !== n.label)
			{
				if (!c0 || c0.t !== n.t) this.holdTime = 0;
				this.cur = n;
				this.prompt.set([{ key: 'E', label: n.blocked || n.label, hold: n.blocked ? undefined : (n.hold > 0 ? n.hold : undefined) }], { priority: 2 });
			}
		}
		const c = this.cur;
		if (c && c.hold > 0 && !c.blocked && this.eHeld && this.prompt.active() && !w.realismUIBlocking)
		{
			this.holdTime += dt;
			this.prompt.progress(this.holdTime / c.hold);
			if (this.holdTime >= c.hold) { this.holdTime = 0; this.prompt.progress(0); this.rescan = true; c.run(); }
		}
		else if (this.holdTime > 0) { this.holdTime = 0; this.prompt.progress(0); }
	}

	private updateHud(): void
	{
		const t = this.task, d = this.dept();
		const f = this.firstOpen();
		let dist = '';
		if (f && this.playerPos(this.tmp)) { const dd = Math.sqrt((f.x - this.tmp.x) * (f.x - this.tmp.x) + (f.z - this.tmp.z) * (f.z - this.tmp.z)); dist = dd < 1000 ? Math.round(dd) + ' m' : (dd / 1000).toFixed(1) + ' km'; }
		const ph = t.phases[t.phase] || [];
		const left = ph.filter((q) => !q.done).length;
		this.hud.set(d.name + ' \u00b7 ' + t.title + '\n' + (f ? f.label + (ph.length > 1 ? ' (' + left + ' left)' : '') + ' \u00b7 ' + dist : ''));
	}

	/** The interaction in range now: the nearest open task spot, else restocking at the work vehicle. */
	private findInteraction(): { label: string; hold: number; blocked: string; run: () => void; t?: Target }
	{
		if (!this.playerPos(this.tmp)) return null;
		const veh = this.inVehicle();
		const p = this.tmp;
		const t = this.task;
		let best: Target = null, bd = 1e18;
		if (t && t.phase < t.phases.length)
		{
			const ph = t.phases[t.phase];
			for (let i = 0; i < ph.length; i++)
			{
				const q = ph[i];
				if (q.done || (veh && !q.vehicle)) continue;
				const dx = q.x - p.x, dz = q.z - p.z, dy = q.y - p.y;
				const dd = dx * dx + dz * dz;
				if (dd > q.r * q.r || Math.abs(dy) > 4) continue;
				if (dd < bd) { bd = dd; best = q; }
			}
		}
		if (best)
		{
			const q = best;
			let why = q.check ? q.check() : '';
			if (!why && q.consume && q.consume[1] > 0 && this.inventory.count(q.consume[0]) < q.consume[1]) why = this.needItem(q.consume[0], q.consume[1])();
			if (!why && q.consume && q.consume[1] === 0 && this.inventory.count(q.consume[0]) < 1) why = this.needItem(q.consume[0], 1)();
			return { label: q.label, hold: q.mg ? 0 : q.hold, blocked: why, t: q, run: () => this.doTarget(q) };
		}
		// restock at the trunk of the work vehicle
		const wv = this.workVehicle;
		const job = this.jobs.state.id;
		if (!veh && wv && this.kitLow(job))
		{
			const dx = wv.position.x - p.x, dz = wv.position.z - p.z;
			if (dx * dx + dz * dz < 4.2 * 4.2) return { label: 'Restock supplies', hold: 0, blocked: '', run: () => { const n = this.topUpKit(job); rrToast('Restocked ' + n + ' item' + (n === 1 ? '' : 's') + ' from the ' + (this.dept() ? this.dept().vehicleName : 'vehicle') + '.'); } };
		}
		return null;
	}

	/** Runs a target: minigame first when it has one, else finishes it. */
	private doTarget(q: Target): void
	{
		if (q.done || !this.task) return;
		if (q.mg)
		{
			const task = this.task;
			let mg: Minigame = null;
			try { mg = q.mg(); } catch (e) { console.warn('[Realism] minigame failed', e); }
			if (!mg) { this.finishTarget(q, null); return; }
			this.prompt.set(null);
			this.minigames.open(mg, (ok, g) => { if (ok && this.task === task) this.finishTarget(q, g); });
			return;
		}
		this.finishTarget(q, null);
	}

	private finishTarget(q: Target, mg: Minigame): void
	{
		const t = this.task;
		if (!t || q.done) return;
		if (q.consume && q.consume[1] > 0 && !this.inventory.remove(q.consume[0], q.consume[1])) { rrToast(this.needItem(q.consume[0], q.consume[1])() + '.'); return; }
		q.done = true;
		if (q.vis !== undefined && this.visuals.items[q.vis])
		{
			const it = this.visuals.items[q.vis];
			it.on = it.type === 'cone' ? true : it.type === 'line' ? false : false;
			this.visuals.rebuild();
		}
		if (q.onDone) { try { q.onDone(q, mg); } catch (e) { console.warn('[Realism] task step failed', e); } }
		if (this.task !== t) return;
		const ph = t.phases[t.phase];
		if (ph.every((x) => x.done))
		{
			t.phase++;
			if (t.phase >= t.phases.length) { this.completeTask(); return; }
		}
		this.updateGuidance(true);
	}
}

/** Builds the trades after RealismJobs (buildEconomy). Sets world.realismJobsLegal, realismInventory, realismCommunityService. */
export function buildLegalJobs(ctx: RealismCtx): RealismJobsLegal
{
	const w: any = ctx.world;
	const jobs: RealismJobs = w.realismJobs;
	if (!jobs) { console.warn('[Realism] legal jobs need RealismJobs'); try { buildInventory(ctx); } catch (e) { /* ignore */ } return null; }
	const L = new RealismJobsLegal(ctx, jobs);
	w.registerUpdatable(L);
	return L;
}
