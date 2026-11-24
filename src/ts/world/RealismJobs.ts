/*
 * RealismJobs.ts
 * --------------
 * Jobs: Civilian, Police Officer (San Verano Police), Sheriff Deputy (San Verano County Sheriff),
 * and the civilian trades (RealismJobsLegal.ts): DOT Road Worker (San Verano DOT), Construction
 * Worker (Verano Build Co.), Electrician (Volt Electric Co.) and Community Service, all picked in
 * the phone's Jobs app. The trades share this file's duty / uniform / hourly pay code; their tasks,
 * work vehicles and pay per task live in RealismJobsLegal.ts.
 *
 *  - On duty: you get a unit number, your clothes turn into the department's uniform colour
 *    (the player's own materials are re-textured in place: skin, hands and face keep their
 *    colours; restored when you go off duty), and a salary is paid into your bank account every
 *    in-game hour (jobs.<dept>.salary, via realismEconomy.earn).
 *  - 'Get patrol vehicle' asks (world as any).realismPolice.spawnUnit(dept, { unit }) for a car.
 *    Near the station (jobs.stationRange) it is parked at the station; farther away it is put on
 *    the nearest road lane next to you. Department vehicles are not yours: never saved, never in
 *    the Garage, and they are removed when you go off duty (once nobody sits in them).
 *  - 'Report to station' teleports you (on foot) to your department's station.
 *  - Saved in localStorage 'realism.job.v1' (job, duty state, unit numbers).
 *
 * Contract C4, (world as any).realismJob = { id: 'civilian' | 'police' | 'sheriff' | 'dot' | 'construction' |
 *    'electrician' | 'community'; onDuty: boolean; unit: string; rank?: string }  (one object, updated in place).
 * Also (world as any).realismJobs = this (setJob, goOnDuty, goOffDuty, getPatrolVehicle,
 *    reportToStation, departments, patrol, salaryFor, ...).
 */

import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
import { findRoadSpot } from './RealismRoadSpot';

export const JOB_KEY = 'realism.job.v1';

export interface Department
{
	id: string;            // police | sheriff
	name: string;          // San Verano Police
	title: string;         // Police Officer
	rank: string;          // Officer
	salary: number;        // $ per in-game hour on duty
	uniform: number[];     // rgb 0..1
	unitWords: string[];   // radio words for unit numbers
	// --- civilian trades (RealismJobsLegal.ts) ---
	civil?: boolean;       // true for the trades: work vehicle instead of a patrol car, tasks with pay per task
	unitPrefix?: string;   // crew number prefix, e.g. DOT
	icon?: string;         // phone list icon (HTML entity)
	desc?: string;         // phone list description
	vehicleRgb?: number[]; // work vehicle paint (rgb 0..1)
	vehicleRgb2?: number[];// lower body colour (two-tone) or null
	vehicleName?: string;  // 'DOT work truck'
	pay?: { [task: string]: number };   // $ per finished task by task kind
	kinds?: string[];      // task kinds dispatched, with weights in `weights`
	weights?: number[];
}

/** Defaults of the civilian trades. Config: jobs.<id>.{ name, rank, salary, uniform, vehicleColor, vehicleColor2, pay: { kind: $ } }. */
const CIVIL_DEFAULTS: any = {
	dot: {
		name: 'San Verano DOT', title: 'DOT Road Worker', rank: 'Road Crew', salary: 45, uniform: [0.98, 0.48, 0.06], unitPrefix: 'DOT', icon: '&#x1F6A7;',
		desc: 'Potholes, cones, street lights, signals, debris, road lines', vehicleRgb: [0.98, 0.45, 0.05], vehicleRgb2: [0.95, 0.95, 0.93], vehicleName: 'DOT work truck',
		pay: { pothole: 140, cones: 120, streetlight: 190, signal: 210, debris: 110, lines: 150 },
		kinds: ['pothole', 'cones', 'streetlight', 'signal', 'debris', 'lines'], weights: [3, 2, 3, 2, 2, 2],
	},
	construction: {
		name: 'Verano Build Co.', title: 'Construction Worker', rank: 'Laborer', salary: 50, uniform: [0.92, 0.72, 0.12], unitPrefix: 'VBC', icon: '&#x1F3D7;&#xFE0F;',
		desc: 'Build the house, deliver supplies, design blueprints', vehicleRgb: [0.95, 0.75, 0.1], vehicleRgb2: null, vehicleName: 'Verano Build pickup',
		pay: { build: 160, deliver: 240, blueprint: 300, complete: 1500 },
		kinds: ['build', 'deliver', 'blueprint'], weights: [6, 2, 2],
	},
	electrician: {
		name: 'Volt Electric Co.', title: 'Electrician', rank: 'Electrician', salary: 55, uniform: [0.12, 0.3, 0.46], unitPrefix: 'VOLT', icon: '&#x26A1;',
		desc: 'AC units, computers, security systems, vehicle wiring', vehicleRgb: [0.94, 0.94, 0.92], vehicleRgb2: [0.1, 0.32, 0.62], vehicleName: 'Volt Electric van',
		pay: { ac: 220, computer: 200, security: 240, vehicle: 260 },
		kinds: ['ac', 'computer', 'security', 'vehicle'], weights: [3, 2, 2, 2],
	},
	community: {
		name: 'San Verano Community Service', title: 'Community Service', rank: 'Volunteer', salary: 0, uniform: [0.55, 0.82, 0.16], unitPrefix: 'CS', icon: '&#x1F9F9;',
		desc: 'Litter pickup, sweeping, graffiti removal. Works off service hours', vehicleRgb: [0.86, 0.86, 0.84], vehicleRgb2: [0.2, 0.55, 0.25], vehicleName: 'Parks dept. pickup',
		pay: { litter: 25, sweep: 15, graffiti: 25 },
		kinds: ['litter', 'sweep', 'graffiti'], weights: [3, 2, 2],
	},
};
export const CIVIL_IDS = ['dot', 'construction', 'electrician', 'community'];

export interface JobState { id: string; onDuty: boolean; unit: string; rank?: string; }

function num(v: any, d: number, lo: number, hi: number): number
{
	const n = typeof v === 'number' && isFinite(v) ? v : d;
	return Math.max(lo, Math.min(hi, n));
}

function rgbOf(v: any, d: number[]): number[]
{
	if (v instanceof Array && v.length >= 3 && v.every((x: any) => typeof x === 'number' && isFinite(x))) return [v[0], v[1], v[2]].map((x) => Math.max(0, Math.min(1, x)));
	return d;
}

export function jobSettings(cfg: any): { departments: { [id: string]: Department }; stationRange: number; maxHoursPerTick: number }
{
	const raw: any = (cfg && cfg.jobs) || {};
	const p: any = raw.police || {}, s: any = raw.sheriff || {};
	const deps: { [id: string]: Department } = {
			police: {
				id: 'police', name: typeof p.name === 'string' ? p.name : 'San Verano Police', title: 'Police Officer', rank: typeof p.rank === 'string' ? p.rank : 'Officer',
				salary: num(p.salary, 300, 0, 1e6), uniform: rgbOf(p.uniform, [0.12, 0.16, 0.32]), unitWords: ['ADAM', 'LINCOLN', 'TOM', 'MARY'],
			},
			sheriff: {
				id: 'sheriff', name: typeof s.name === 'string' ? s.name : 'San Verano County Sheriff', title: 'Sheriff Deputy', rank: typeof s.rank === 'string' ? s.rank : 'Deputy',
				salary: num(s.salary, 280, 0, 1e6), uniform: rgbOf(s.uniform, [0.62, 0.52, 0.34]), unitWords: ['SAM', 'DAVID', 'HENRY', 'EDWARD'],
			},
	};
	for (let i = 0; i < CIVIL_IDS.length; i++)
	{
		const id = CIVIL_IDS[i], D = CIVIL_DEFAULTS[id], c: any = raw[id] || {};
		const pay: { [k: string]: number } = {};
		for (const k in D.pay) if (D.pay.hasOwnProperty(k)) pay[k] = num(c.pay && c.pay[k], D.pay[k], 0, 1e6);
		deps[id] = {
			id: id, name: typeof c.name === 'string' ? c.name : D.name, title: typeof c.title === 'string' ? c.title : D.title, rank: typeof c.rank === 'string' ? c.rank : D.rank,
			salary: num(c.salary, D.salary, 0, 1e6), uniform: rgbOf(c.uniform, D.uniform), unitWords: [], civil: true, unitPrefix: D.unitPrefix, icon: D.icon, desc: D.desc,
			vehicleRgb: rgbOf(c.vehicleColor, D.vehicleRgb), vehicleRgb2: c.vehicleColor2 === null ? null : rgbOf(c.vehicleColor2, D.vehicleRgb2 || null), vehicleName: D.vehicleName,
			pay: pay, kinds: D.kinds.slice(0), weights: D.weights.slice(0),
		};
		if (c.enabled === false) delete deps[id];
	}
	return {
		departments: deps,
		stationRange: num(raw.stationRange, 200, 0, 5000),
		maxHoursPerTick: 2,
	};
}

let toastEl: HTMLElement = null;
let toastTimer: any = null;
/** Short message in the upper middle of the screen. */
export function rrToast(text: string, ms: number = 2600): void
{
	try
	{
		if (typeof document === 'undefined' || !document.body || !document.createElement) return;
		if (!toastEl)
		{
			toastEl = document.createElement('div');
			toastEl.id = 'rr-toast';
			document.body.appendChild(toastEl);
		}
		toastEl.textContent = text;
		toastEl.classList.add('rr-toast-show');
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => { if (toastEl) toastEl.classList.remove('rr-toast-show'); toastTimer = null; }, ms);
	}
	catch (e) { /* headless */ }
}

export class RealismJobs
{
	public updateOrder = 9;
	public state: JobState = { id: 'civilian', onDuty: false, unit: '', rank: undefined };
	public departments: { [id: string]: Department };
	public stationRange: number;
	/** The current department patrol car (not owned), or null. */
	public patrol: any = null;
	public paidHours = 0;
	public dutyHours = 0;         // in-game hours on duty this shift
	private units: { [dept: string]: string } = {};
	private hourAcc = 0;
	private lastHour = -1;
	private acc = 0;
	private ctx: RealismCtx;
	private world: any;
	private tinted: { ch: any; mats: { mat: any; map: any; color: number[] }[] } = null;
	private uniformMaps: { [key: string]: any } = {};
	private oldPatrols: any[] = [];
	private maxHours: number;
	private tmp = new THREE.Vector3();

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		const js = jobSettings(ctx.cfg);
		this.departments = js.departments;
		this.stationRange = js.stationRange;
		this.maxHours = js.maxHoursPerTick;
		this.load();
		this.world.realismJob = this.state;
	}

	// ------------------------------------------------------------------ player helpers

	/** The player's character (on foot or in a vehicle), or null (free camera). */
	public static playerCharacter(world: any): any
	{
		const im: any = world.inputManager;
		const r: any = im ? im.inputReceiver : null;
		if (r && r.characterCapsule !== undefined && r.position) return r;
		if (r && r.controllingCharacter) return r.controllingCharacter;
		return null;
	}

	private player(): any { return RealismJobs.playerCharacter(this.world); }

	private playerPos(out: THREE.Vector3): boolean
	{
		const ch = this.player();
		if (!ch) return false;
		if (ch.occupyingSeat && ch.occupyingSeat.vehicle) out.copy(ch.occupyingSeat.vehicle.position);
		else out.copy(ch.position);
		return true;
	}

	public department(): Department | null { return this.departments[this.state.id] || null; }

	public salaryFor(id: string): number { const d = this.departments[id]; return d ? d.salary : 0; }

	/** In-game minutes until the next salary payment (on duty), else -1. */
	public minutesToPay(): number { return this.state.onDuty ? Math.max(0, Math.ceil((1 - this.hourAcc) * 60)) : -1; }

	// ------------------------------------------------------------------ job changes

	/** Signs up for a job ('civilian' | 'police' | 'sheriff'). Switching goes off duty first. */
	public setJob(id: string): boolean
	{
		if (id !== 'civilian' && !this.departments[id]) return false;
		if (id === this.state.id) return true;
		if (this.state.onDuty) this.goOffDuty();
		this.state.id = id;
		this.state.unit = '';
		this.state.rank = id === 'civilian' ? undefined : this.departments[id].rank;
		this.save();
		rrToast(id === 'civilian' ? 'You are a civilian now.' : 'Hired: ' + this.departments[id].title + ', ' + this.departments[id].name + '.');
		return true;
	}

	public goOnDuty(): boolean
	{
		const d = this.department();
		if (!d) return false;
		if (this.state.onDuty) return true;
		if (!this.units[d.id]) this.units[d.id] = this.makeUnit(d);
		this.state.onDuty = true;
		this.state.unit = this.units[d.id];
		this.state.rank = d.rank;
		this.hourAcc = 0;
		this.dutyHours = 0;
		this.lastHour = -1;
		this.applyUniform();
		this.save();
		rrToast('On duty: ' + d.rank + (d.civil ? ', ' + d.name + ', crew ' : ', unit ') + this.state.unit + '.');
		this.notifyLegal(true);
		return true;
	}

	public goOffDuty(): boolean
	{
		if (!this.state.onDuty) return true;
		this.state.onDuty = false;
		this.restoreUniform();
		this.releasePatrol();
		this.save();
		rrToast('Off duty. Shift: ' + this.paidHoursThisShift() + ' h paid.');
		this.notifyLegal(false);
		return true;
	}

	/** Tells the trades (RealismJobsLegal.ts) about duty changes. */
	private notifyLegal(on: boolean): void
	{
		const L = this.world.realismJobsLegal;
		if (L && typeof L.onDutyChange === 'function') { try { L.onDutyChange(on); } catch (e) { console.warn('[Realism] legal jobs duty change failed', e); } }
	}

	/** True for the civilian trades (dot, construction, electrician, community). */
	public isCivil(id?: string): boolean { const d = this.departments[id || this.state.id]; return !!(d && d.civil); }

	private shiftPaid = 0;
	private paidHoursThisShift(): number { const n = this.shiftPaid; this.shiftPaid = 0; return n; }

	private makeUnit(d: Department): string
	{
		if (d.civil) return (d.unitPrefix || 'CREW') + '-' + (10 + Math.floor(Math.random() * 90));
		const w = d.unitWords[Math.floor(Math.random() * d.unitWords.length)];
		if (d.id === 'sheriff') return (10 + Math.floor(Math.random() * 40)) + '-' + w + '-' + (1 + Math.floor(Math.random() * 9));
		return (1 + Math.floor(Math.random() * 9)) + '-' + w + '-' + (10 + Math.floor(Math.random() * 80));
	}

	// ------------------------------------------------------------------ station / patrol car

	/** Where you report for duty: the department's scenario player spawn, else in front of the station. */
	public stationSpot(dept: string): { x: number; y: number; z: number; name: string } | null
	{
		const data = this.ctx.data;
		if (dept === 'police')
		{
			const sc = data.scenarios.filter((s) => s.id === 'police')[0];
			const ps = sc ? sc.spawns.filter((s) => s.type === 'player')[0] : null;
			if (ps) return { x: ps.x, y: ps.y, z: ps.z, name: 'Police Department' };
		}
		const label = dept === 'police' ? 'POLICE DEPARTMENT' : 'COUNTY SHERIFF';
		let b = data.buildings.filter((x) => x.custom === dept && x.role === 'station')[0];
		if (!b) b = data.buildings.filter((x) => x.label === label)[0];
		if (!b) return null;
		const x = b.x + Math.sin(b.rot) * (b.d / 2 + 5), z = b.z + Math.cos(b.rot) * (b.d / 2 + 5);
		return { x: x, y: data.heightAt(x, z) + 1.1, z: z, name: dept === 'police' ? 'Police Department' : 'Sheriff Station' };
	}

	public patrolAvailable(): boolean
	{
		if (this.isCivil()) { const L = this.world.realismJobsLegal; return !!L && L.vehicleAvailable(); }
		const pol = this.world.realismPolice;
		return !!pol && typeof pol.spawnUnit === 'function';
	}

	/** Spawns your department patrol car. Returns a message for the phone. */
	public getPatrolVehicle(): { ok: boolean; message: string }
	{
		const d = this.department();
		if (!d || !this.state.onDuty) return { ok: false, message: 'Go on duty first.' };
		if (d.civil)
		{
			const L = this.world.realismJobsLegal;
			return L ? L.getWorkVehicle() : { ok: false, message: 'Work vehicle unavailable.' };
		}
		if (!this.patrolAvailable()) return { ok: false, message: 'Patrol vehicle unavailable.' };
		const pl = this.player();
		if (this.patrol && this.occupied(this.patrol, pl)) return { ok: false, message: 'You are already in your patrol car.' };
		this.releasePatrol();
		const opts: any = { unit: this.state.unit };
		let where = 'at the ' + (d.id === 'police' ? 'Police Department' : 'Sheriff Station');
		const st = this.stationSpot(d.id);
		if (this.playerPos(this.tmp) && (!st || Math.sqrt((st.x - this.tmp.x) * (st.x - this.tmp.x) + (st.z - this.tmp.z) * (st.z - this.tmp.z)) > this.stationRange))
		{
			const obst = this.parkedObstacles();
			const spot = findRoadSpot(this.ctx, this.tmp, { clearance: 3, player: this.tmp, obstacles: obst }) ||
				findRoadSpot(this.ctx, this.tmp, { clearance: 3, player: this.tmp, obstacles: obst, radius: 160 });
			if (spot)
			{
				// same convention as scenario vehicle spawn points: ground + 0.6
				opts.position = new THREE.Vector3(spot.x, spot.y + 0.6, spot.z);
				opts.heading = spot.heading;
				where = 'on ' + (spot.road || 'the road') + ' next to you';
			}
		}
		let car: any = null;
		try { car = this.world.realismPolice.spawnUnit(d.id, opts); }
		catch (e) { console.warn('[Realism] spawnUnit failed', e); return { ok: false, message: 'Patrol vehicle unavailable.' }; }
		const take = (c: any) =>
		{
			if (!c) return;
			c.realismDeptVehicle = true;
			c.realismDept = d.id;
			c.realismUnit = this.state.unit;
			if (!this.state.onDuty) { this.oldPatrols.push(c); return; }
			this.patrol = c;
		};
		if (car && typeof car.then === 'function') { car.then(take, () => { /* ignore */ }); return { ok: true, message: 'Patrol car requested ' + where + '.' }; }
		if (!car) return { ok: false, message: 'Patrol vehicle unavailable.' };
		take(car);
		return { ok: true, message: 'Unit ' + this.state.unit + ': patrol car ' + where + '.' };
	}

	private parkedObstacles(): { x: number; z: number }[]
	{
		const out: { x: number; z: number }[] = [];
		const npcs: any = this.world.realismNPCs;
		const spots: any[] = npcs && npcs.vehicles ? npcs.vehicles.spots : [];
		for (let i = 0; i < spots.length; i++) if (!spots[i].car && spots[i].pos) out.push(spots[i].pos);
		return out;
	}

	private occupied(car: any, who?: any): boolean
	{
		if (!car) return false;
		const seats: any[] = car.seats || [];
		for (let i = 0; i < seats.length; i++)
		{
			const o = seats[i].occupiedBy;
			if (o && (!who || o === who)) return true;
		}
		const cc = car.controllingCharacter;
		return !!cc && (!who || cc === who);
	}

	private releasePatrol(): void
	{
		if (this.patrol) this.oldPatrols.push(this.patrol);
		this.patrol = null;
		this.cleanPatrols();
	}

	/** Removes old department cars once nobody sits in them. */
	private cleanPatrols(): void
	{
		for (let i = this.oldPatrols.length - 1; i >= 0; i--)
		{
			const c = this.oldPatrols[i];
			if (this.occupied(c)) continue;
			try { if (c.world || (this.world.vehicles && this.world.vehicles.indexOf(c) >= 0)) this.world.remove(c); }
			catch (e) { console.warn('[Realism] patrol car remove failed', e); }
			this.oldPatrols.splice(i, 1);
		}
	}

	/** Teleports the player (on foot) to the department's station. */
	public reportToStation(): { ok: boolean; message: string }
	{
		const d = this.department();
		if (!d) return { ok: false, message: 'You have no department.' };
		if (d.civil)
		{
			const L = this.world.realismJobsLegal;
			return L ? L.goToDepot() : { ok: false, message: 'Depot not found.' };
		}
		const pl = this.player();
		if (!pl) return { ok: false, message: 'No player.' };
		if (pl.occupyingSeat || pl.controlledObject !== undefined || pl.vehicleEntryInstance) return { ok: false, message: 'Step out of the vehicle first.' };
		const st = this.stationSpot(d.id);
		if (!st) return { ok: false, message: 'Station not found.' };
		try
		{
			pl.setPosition(st.x, st.y + 0.2, st.z);
			if (pl.characterCapsule && pl.characterCapsule.body) pl.characterCapsule.body.velocity.set(0, 0, 0);
		}
		catch (e) { return { ok: false, message: 'Could not move you.' }; }
		return { ok: true, message: 'Reported to the ' + st.name + '.' };
	}

	// ------------------------------------------------------------------ uniform

	private applyUniform(): void
	{
		const d = this.department();
		const ch = this.player();
		if (!d || !ch) return;
		if (this.tinted && this.tinted.ch === ch) return;
		this.restoreUniform();
		const mats: any[] = ch.materials instanceof Array ? ch.materials : [];
		const saved: { mat: any; map: any; color: number[] }[] = [];
		for (let i = 0; i < mats.length; i++)
		{
			const m = mats[i];
			if (!m || !m.color) continue;
			saved.push({ mat: m, map: m.map || null, color: [m.color.r, m.color.g, m.color.b] });
			const um = m.map ? this.uniformMap(m.map, d) : null;
			if (um) m.map = um;
			else m.color.setRGB(d.uniform[0] * 1.6, d.uniform[1] * 1.6, d.uniform[2] * 1.6);
		}
		this.tinted = { ch: ch, mats: saved };
	}

	private restoreUniform(): void
	{
		if (!this.tinted) return;
		for (let i = 0; i < this.tinted.mats.length; i++)
		{
			const s = this.tinted.mats[i];
			s.mat.map = s.map;
			s.mat.color.setRGB(s.color[0], s.color[1], s.color[2]);
		}
		this.tinted = null;
	}

	/** A copy of the boxman texture with the clothes (grey / white areas) in the uniform colour;
	 *  hands (yellow) and the face card (bottom left) keep their colours. Made once per department. */
	private uniformMap(src: any, d: Department): any
	{
		const img = src.image;
		if (!img || !img.width || !img.height) return null;
		const key = d.id + ':' + (src.uuid || '');
		if (this.uniformMaps[key]) return this.uniformMaps[key];
		try
		{
			const W = Math.min(512, img.width), H = Math.min(512, img.height);
			const c = document.createElement('canvas');
			c.width = W; c.height = H;
			const g = c.getContext('2d');
			if (!g) return null;
			g.drawImage(img, 0, 0, W, H);
			const id = g.getImageData(0, 0, W, H);
			const px = id.data;
			const u = d.uniform;
			for (let y = 0; y < H; y++)
			{
				const faceRow = y > H * 0.62;
				for (let x = 0; x < W; x++)
				{
					if (faceRow && x < W * 0.34) continue;   // face card
					const o = (y * W + x) * 4;
					const r = px[o], gg = px[o + 1], b = px[o + 2];
					const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
					if (mx - mn > 28) continue;               // coloured (hands / skin): keep
					const l = (r + gg + b) / 765 * 1.15;
					px[o] = Math.min(255, u[0] * l * 255);
					px[o + 1] = Math.min(255, u[1] * l * 255);
					px[o + 2] = Math.min(255, u[2] * l * 255);
				}
			}
			g.putImageData(id, 0, 0);
			const t: any = new THREE.CanvasTexture(c);
			t.flipY = src.flipY;
			t.wrapS = src.wrapS; t.wrapT = src.wrapT;
			t.encoding = src.encoding;
			t.anisotropy = src.anisotropy;
			t.needsUpdate = true;
			this.uniformMaps[key] = t;
			return t;
		}
		catch (e)
		{
			// a cross-origin texture can't be read: tint the whole material instead
			return null;
		}
	}

	// ------------------------------------------------------------------ per frame

	public update(timeStep: number, unscaled: number): void
	{
		if (this.world.realismPaused === true) return;
		if (this.state.onDuty)
		{
			const t = this.world.realismTime;
			if (t && isFinite(t.hour))
			{
				if (this.lastHour >= 0)
				{
					let dh = t.hour - this.lastHour;
					if (dh < -12) dh += 24;
					if (dh > 0) this.addHours(Math.min(this.maxHours, dh));
				}
				this.lastHour = t.hour;
			}
		}
		this.acc += unscaled || timeStep || 0;
		if (this.acc < 0.5) return;
		this.acc = 0;
		// the player character can change (respawn): put the uniform back on
		if (this.state.onDuty)
		{
			const ch = this.player();
			if (ch && (!this.tinted || this.tinted.ch !== ch)) this.applyUniform();
		}
		if (this.oldPatrols.length) this.cleanPatrols();
		if (this.patrol && this.world.vehicles && this.world.vehicles.indexOf(this.patrol) < 0) this.patrol = null;
	}

	/** Adds on-duty game time and pays every full hour. */
	public addHours(h: number): void
	{
		if (!this.state.onDuty || !(h > 0)) return;
		this.dutyHours += h;
		this.hourAcc += h;
		while (this.hourAcc >= 1)
		{
			this.hourAcc -= 1;
			const d = this.department();
			const eco = this.world.realismEconomy;
			if (d && d.salary > 0 && eco && typeof eco.earn === 'function')
			{
				eco.earn(d.salary, 'Shift pay, unit ' + this.state.unit, d.name, 'bank');
				this.paidHours++;
				this.shiftPaid++;
			}
		}
	}

	// ------------------------------------------------------------------ saving

	private load(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			const raw = ls ? ls.getItem(JOB_KEY) : null;
			if (!raw) return;
			const d = JSON.parse(raw);
			if (!d || d.v !== 1) return;
			if (d.units && typeof d.units === 'object')
			{
				for (const k in this.departments) if (this.departments.hasOwnProperty(k) && typeof d.units[k] === 'string' && d.units[k].length < 24) this.units[k] = d.units[k];
			}
			if (typeof d.id === 'string' && this.departments.hasOwnProperty(d.id))
			{
				this.state.id = d.id;
				this.state.rank = this.departments[d.id].rank;
				if (d.onDuty === true)
				{
					this.state.onDuty = true;
					if (!this.units[d.id]) this.units[d.id] = this.makeUnit(this.departments[d.id]);
					this.state.unit = this.units[d.id];
					// the uniform goes on as soon as the player character exists (update)
				}
			}
		}
		catch (e) { /* ignore */ }
	}

	public save(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			if (ls) ls.setItem(JOB_KEY, JSON.stringify({ v: 1, id: this.state.id, onDuty: this.state.onDuty, units: this.units }));
		}
		catch (e) { /* ignore */ }
	}
}
