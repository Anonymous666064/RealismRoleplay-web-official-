/*
 * RealismIllegalCore.ts
 * ---------------------
 * Shared plumbing for the street-crime side of San Verano County (fictional GTA-style gameplay):
 * hotwiring, the chop-shop chain, the abstract production jobs, clubs and secret hideouts.
 *
 *  - One interaction owner for everything here: C7 prompts as realismPrompt.set('illegal', ...), keys acted on
 *    only while isActive('illegal') (fallback: a small hint of our own when realismPrompt is missing).
 *  - Interactables: { id, x, y, z, r, mode: 'foot' | 'car' | 'any', items(), act(key) }; the nearest one in
 *    range of the player (or the car they drive) owns the prompt. hold > 0 items fire after holding the key.
 *  - Money through realismEconomy (C1), items through realismInventory (C13) with an internal fallback
 *    inventory (same save) when it is missing, 'crime' events through realismEvents (C14), blips through
 *    realismGPS (C8), guides through realismGuides (A15). All guarded, all looked up lazily.
 *  - Pocket rooms: interiors (hideouts, club floors, the grow room) are closed boxes built high above the
 *    sea south of the coast. Entering teleports the player in, leaving puts them back at the entrance.
 *    Rooms are hidden and their colliders removed while nobody is inside (0 draw calls, 0 bodies).
 *  - Heat: 0..100, raised by crimes, slowly cooling; small HUD meter (top right) while > 0.
 *  - Menus / timing minigames: one overlay each, mouse released via realismSetUIBlocking(owner, true)
 *    before exitPointerLock, given back on close.
 *  - Saved in localStorage 'realism.illegal.v1' (heat, fallback inventory, stolen-car meta, stashes,
 *    grow room, stations, discovered places).
 *
 * CONTENT RULE: everything is abstract game mechanics: generic named stations, timers, simple minigames
 * and fictional items. No real-world ingredients, procedures or theft techniques anywhere.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { RealismCtx, instMat } from './RealismContext';
import { GeoAccum, Frame, boxC } from './RealismGeometry';
import { loadSharedModel, playerScaleOf } from './RealismNPCs';
import { SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils';

export const ILLEGAL_KEY = 'realism.illegal.v1';
export const OWNER = 'illegal';

export interface PromptItem { key: string; label: string; hold?: number; }

export interface Interactable
{
	id: string;
	x: number; y: number; z: number;
	r: number;                       // metres (xz); |dy| must be < 4
	mode?: string;                   // 'foot' (default) | 'car' | 'any'
	items(): PromptItem[] | null;    // null = nothing to offer right now
	act(key: string): void;
	blip?: string;                   // id of a blip revealed when the player comes close
}

export interface ItemDef { name: string; icon?: string; legal?: boolean; value?: number; }

/** Fictional, generic items (C13 define()). */
export const ITEMS: { [id: string]: ItemDef } = {
	supplies: { name: 'Supplies', icon: 'box', legal: false, value: 60 },
	lab_kit: { name: 'Lab kit', icon: 'case', legal: false, value: 400 },
	starter_pot: { name: 'Starter pot', icon: 'pot', legal: false, value: 40 },
	lean_cup: { name: 'Lean (cup)', icon: 'cup', legal: false, value: 120 },
	weed_raw: { name: 'Weed (unpackaged)', icon: 'leaf', legal: false, value: 60 },
	weed_bag: { name: 'Weed (bag)', icon: 'bag', legal: false, value: 90 },
	batch_tray: { name: 'Batch tray', icon: 'tray', legal: false, value: 500 },
	pressed_block: { name: 'Pressed block', icon: 'block', legal: false, value: 900 },
	coke_brick: { name: 'Coke (brick)', icon: 'brick', legal: false, value: 2400 },
};

export interface CarMeta { stolen?: boolean; vin?: string; vinScratched?: boolean; hot?: boolean; resprayed?: boolean; }

export interface MenuRow { label: string; detail?: string; right?: string; disabled?: boolean; action?: () => any; }
export interface MenuSpec { title: string; subtitle?: string; rows: () => MenuRow[]; owner?: string; onClose?: () => void; }

export interface TimingSpec
{
	owner: string;
	title: string;
	stages: string[];              // one label per stage
	zone: number;                  // green zone width 0..1
	speed: number;                 // needle sweeps per second (0..1..0 counts as 2)
	maxMisses: number;             // this many misses = failure
	stageTimeout: number;          // seconds per stage before it counts as a miss
	duration?: number;             // optional minimum total seconds (progress bar), e.g. a kitchen batch
	onFinish: (r: { success: boolean; hits: number; misses: number }) => void;
}

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
export function money(n: number): string { return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
export function esc(s: string): string { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]); }
function num(v: any, d: number): number { return typeof v === 'number' && isFinite(v) ? v : d; }
function hasDom(): boolean { return typeof document !== 'undefined' && !!document.body && !!document.createElement; }

/** Merges config over defaults (one level of nested objects). */
export function mergeCfg(def: any, user: any): any
{
	const out: any = {};
	for (const k in def) if (def.hasOwnProperty(k)) out[k] = def[k] && typeof def[k] === 'object' && !(def[k] instanceof Array) ? mergeCfg(def[k], {}) : def[k];
	if (!user || typeof user !== 'object') return out;
	for (const k in user)
	{
		if (!user.hasOwnProperty(k)) continue;
		const u = user[k];
		if (u && typeof u === 'object' && !(u instanceof Array) && out[k] && typeof out[k] === 'object' && !(out[k] instanceof Array)) out[k] = mergeCfg(out[k], u);
		else if (u !== undefined) out[k] = u;
	}
	return out;
}

// ---------------------------------------------------------------------------------------- config

export const ILLEGAL_DEFAULTS = {
	enabled: true,
	revealAll: false,            // true: every hideout / dealer / fence blip shows from the start
	discoverRange: 30,           // metres: coming this close reveals a place (blip)
	heat: { hud: true, decayPerMinute: 6, theft: 15, failedTheft: 10, sale: 6, carSale: 10, max: 100 },
	hotwire: { enabled: true, stages: 3, maxMisses: 2, stageTimeout: 3.5, zone: [0.26, 0.19, 0.13], speed: [0.55, 0.75, 0.95], alarmOnFail: true },
	respray: { price: 500, colors: null as any },
	vin: { holdSeconds: 3 },
	fence: { share: 0.25, hotPolicy: 'lowball', hotFactor: 0.25, vinBonus: 1.35, noVinFactor: 0.8, refusePolice: true, minCondition: 0.35 },
	prices: {
		supplies: 60, lab_kit: 400, starter_pot: 40,
		growTable: 1500, lampUpgrade: 2500, soilUpgrade: 1800, waterUpgrade: 1200,
		dealer: { lean_cup: 110, weed_bag: 80 },
		bulk: { weed_bag: 120 },
		cartel: { coke_brick: 2600 },
	},
	dealerMaxPerHour: 10,        // units the street dealer takes per in-game hour
	bulkMin: 10,                 // the bulk buyer only takes this many bags or more
	cartelHours: [20, 5],        // the cartel buyer is at the port from 8 PM to 5 AM
	saleCrimeChance: 0.25,       // chance a sale is noticed (a 'crime' event + heat)
	lean: { suppliesPerBatch: 2, seconds: 12, baseCups: 2 },
	coke: { kitsPerBatch: 1, mixSeconds: 14, pressHold: 4, packSeconds: 20, bricksPerBatch: 2 },
	weed: { growHours: 8, waterHours: 4, baseYield: 3, maxTables: 6, startTables: 2, freeWithoutProperties: false },
};

// ---------------------------------------------------------------------------------------- core

export class IllegalCore
{
	public updateOrder = 8;
	public ctx: RealismCtx;
	public w: any;
	public cfg: any;
	public state: any;
	public spots: Interactable[] = [];
	public current: Interactable = null;
	public items: PromptItem[] = null;
	public hint = '';
	public lastToast = '';
	public events: { name: string; data: any }[] = [];      // for tests / debugging: last emitted
	public stats = { spots: 0, rooms: 0, roomsVisible: 0, markers: 0, updateMs: 0, maxUpdateMs: 0, drawCalls: 0 };
	public rooms: PocketRoom[] = [];
	public insideRoom: PocketRoom = null;
	public blips: { [id: string]: { x: number; z: number; icon: string; color?: string; label?: string; shortRange?: boolean; always?: boolean; added?: boolean } } = {};
	public guides: any[] = [];
	public updaters: { update: (dt: number) => void }[] = [];
	public menuOpen = false;
	public timing: TimingGame = null;
	public dh = 0;                       // in-game hours that passed this frame
	public random: () => number = Math.random;
	private lastHour = -1;

	private promptSig = '';
	private holdKey = '';
	private holdT = 0;
	private holdItem: PromptItem = null;
	private scanAcc = 1;
	private saveAcc = 0;
	private dirty = false;
	private lazyAcc = 0;
	private markers: { obj: THREE.Object3D; arrow: THREE.Object3D; x: number; z: number; baseY: number; range: number }[] = [];
	private markerAcc = 0;
	private markerMats: { [c: string]: THREE.Material[] } = {};
	private markerGeo: THREE.BufferGeometry[] = null;
	private hintEl: HTMLElement = null;
	private toastEl: HTMLElement = null;
	private toastT = 0;
	private heatEl: HTMLElement = null;
	private heatShown = -1;
	private menuEl: HTMLElement = null;
	private menuSpec: MenuSpec = null;
	private locks: { [owner: string]: boolean } = {};
	private tmpV = new THREE.Vector3();
	private figures: { root: THREE.Object3D; mixer: THREE.AnimationMixer; x: number; z: number; bob: number }[] = [];
	private boxman: any = null;
	private boxmanState = 0;          // 0 loading, 1 ready, 2 failed
	private pendingFigures: { root: THREE.Group; pose: string }[] = [];
	private guideRegistered: { [id: string]: boolean } = {};
	private invMigrated = false;
	private roomSlots = 0;

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.w = ctx.world;
		const user: any = (ctx.cfg as any).illegal || ((typeof window !== 'undefined' && (window as any).REALISM_CONFIG) ? (window as any).REALISM_CONFIG.illegal : null);
		this.cfg = mergeCfg(ILLEGAL_DEFAULTS, user);
		this.state = this.load();
		this.bindInput();
		this.loadBoxman();
	}

	// ------------------------------------------------------------------ save

	private load(): any
	{
		const def = { v: 1, clock: 0, heat: 0, inv: {}, cars: {}, found: {}, guidesRead: false, stash: {}, weed: {}, kitchen: {}, lab: {}, dealer: { hour: -1, sold: 0 } };
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			const raw = ls ? ls.getItem(ILLEGAL_KEY) : null;
			if (!raw) return def;
			const d = JSON.parse(raw);
			if (!d || d.v !== 1) return def;
			for (const k in def) if (def.hasOwnProperty(k) && (d[k] === undefined || d[k] === null)) d[k] = (def as any)[k];
			d.heat = clamp(num(d.heat, 0), 0, 100);
			return d;
		}
		catch (e) { return def; }
	}

	public markDirty(): void { this.dirty = true; }

	public save(): void
	{
		this.dirty = false;
		this.saveAcc = 0;
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			if (ls) ls.setItem(ILLEGAL_KEY, JSON.stringify(this.state));
		}
		catch (e) { /* storage full / private mode */ }
	}

	// ------------------------------------------------------------------ player

	public player(): any
	{
		const im: any = this.w.inputManager;
		const r: any = im ? im.inputReceiver : null;
		if (r && r.characterCapsule !== undefined && r.position) return r;
		if (r && r.controllingCharacter) return r.controllingCharacter;
		return null;
	}

	/** The car (any rayCastVehicle) the player is driving, or null. */
	public drivenCar(): any
	{
		const ch = this.player();
		if (!ch || !ch.occupyingSeat) return null;
		const v = ch.occupyingSeat.vehicle;
		return v && v.rayCastVehicle && ch.controlledObject === v ? v : null;
	}

	public onFoot(): boolean
	{
		const ch = this.player();
		return !!ch && !ch.occupyingSeat && !ch.vehicleEntryInstance;
	}

	public playerPos(out: THREE.Vector3): boolean
	{
		const ch = this.player();
		if (!ch) return false;
		if (ch.occupyingSeat && ch.occupyingSeat.vehicle) out.copy(ch.occupyingSeat.vehicle.position);
		else out.copy(ch.position);
		return true;
	}

	public gameHour(): number
	{
		const t = this.w.realismTime;
		return t && typeof t.hour === 'number' ? t.hour : 12;
	}

	public isNight(from: number, to: number): boolean
	{
		const h = this.gameHour();
		return from > to ? (h >= from || h < to) : (h >= from && h < to);
	}

	public blocked(): boolean { return !!(this.w.realismPaused || this.w.realismUIBlocking); }

	// ------------------------------------------------------------------ registry

	public add(s: Interactable): Interactable { this.spots.push(s); this.stats.spots = this.spots.length; return s; }
	public remove(id: string): void { this.spots = this.spots.filter((s) => s.id !== id); this.stats.spots = this.spots.length; if (this.current && this.current.id === id) this.current = null; }
	public addUpdater(u: { update: (dt: number) => void }): void { this.updaters.push(u); }

	// ------------------------------------------------------------------ money / items / events

	public eco(): any { const e = this.w.realismEconomy; return e && typeof e.spend === 'function' ? e : null; }
	public cash(): number { const e = this.eco(); try { return e && e.getCash ? e.getCash() : 0; } catch (x) { return 0; } }

	/** Pays in cash (method 'cash'); free without an economy. */
	public payCash(amount: number, desc: string, merchant: string): boolean
	{
		if (amount <= 0) return true;
		const e = this.eco();
		if (!e) return true;
		try { return e.spend(amount, desc, merchant, 'cash') !== false; } catch (x) { return false; }
	}

	/** Pays by card, falling back to cash (legal businesses: club entry, drinks, grow upgrades). */
	public pay(amount: number, desc: string, merchant: string): boolean
	{
		if (amount <= 0) return true;
		const e = this.eco();
		if (!e) return true;
		try { return e.spend(amount, desc, merchant) !== false; } catch (x) { return false; }
	}

	public earnCash(amount: number, desc: string, source: string): void
	{
		const e = this.eco();
		if (!e || amount <= 0) return;
		try { e.earn(Math.round(amount), desc, source, 'cash'); } catch (x) { /* ignore */ }
	}

	private inv(): any
	{
		const i = this.w.realismInventory;
		if (!(i && typeof i.add === 'function' && typeof i.remove === 'function' && typeof i.count === 'function')) return null;
		if (!this.invMigrated)
		{
			this.invMigrated = true;
			try
			{
				if (typeof i.define === 'function') for (const id in ITEMS) if (ITEMS.hasOwnProperty(id)) i.define(id, ITEMS[id]);
				// items collected while there was no inventory move over once
				const inv = this.state.inv || {};
				for (const id in inv) if (inv.hasOwnProperty(id) && inv[id] > 0) i.add(id, inv[id]);
				this.state.inv = {};
				this.markDirty();
			}
			catch (e) { /* ignore */ }
		}
		return i;
	}

	public usingRealInventory(): boolean { return !!this.inv(); }

	public count(id: string): number
	{
		const i = this.inv();
		if (i) { try { return Math.max(0, +i.count(id) || 0); } catch (e) { return 0; } }
		return Math.max(0, +(this.state.inv[id] || 0));
	}

	public give(id: string, qty: number): void
	{
		if (qty <= 0) return;
		const i = this.inv();
		if (i) { try { i.add(id, qty); } catch (e) { /* ignore */ } return; }
		this.state.inv[id] = (this.state.inv[id] || 0) + qty;
		this.markDirty();
	}

	public take(id: string, qty: number): boolean
	{
		if (qty <= 0) return true;
		if (this.count(id) < qty) return false;
		const i = this.inv();
		if (i) { try { return i.remove(id, qty) !== false; } catch (e) { return false; } }
		this.state.inv[id] = (this.state.inv[id] || 0) - qty;
		if (this.state.inv[id] <= 0) delete this.state.inv[id];
		this.markDirty();
		return true;
	}

	public emit(name: string, data: any): void
	{
		this.events.push({ name: name, data: data });
		if (this.events.length > 40) this.events.shift();
		const ev = this.w.realismEvents;
		try { if (ev && typeof ev.emit === 'function') ev.emit(name, data); } catch (e) { /* ignore */ }
	}

	public crime(kind: string, pos?: { x: number; y: number; z: number }, heat?: number): void
	{
		let p: any = pos;
		if (!p) { p = new THREE.Vector3(); if (!this.playerPos(p)) p = null; }
		this.emit('crime', { kind: kind, position: p ? new THREE.Vector3(p.x, p.y, p.z) : null });
		if (heat) this.addHeat(heat);
	}

	public addHeat(n: number): void
	{
		this.state.heat = clamp(this.state.heat + n, 0, num(this.cfg.heat.max, 100));
		this.markDirty();
	}

	public get heat(): number { return this.state.heat; }

	// ------------------------------------------------------------------ cars

	/** Stolen-car meta: the owned record's own fields (A13 sets stolen / vin / hot), backed by our save. */
	public carMeta(rec: any): CarMeta
	{
		if (!rec) return {};
		const m: CarMeta = Object.assign({}, this.state.cars[rec.id] || {});
		if (rec.stolen !== undefined) m.stolen = !!rec.stolen;
		if (typeof rec.vin === 'string' && rec.vin) m.vin = rec.vin;
		if (rec.vinScratched !== undefined) m.vinScratched = !!rec.vinScratched || !!m.vinScratched;
		if (rec.hot !== undefined && !m.resprayed) m.hot = !!rec.hot;
		if (m.stolen === undefined) m.stolen = isStolenOrigin(rec);
		if (m.stolen && m.hot === undefined) m.hot = true;
		if (m.stolen && !m.vin) m.vin = makeVin(rec.id);
		return m;
	}

	public setCarMeta(rec: any, patch: CarMeta): void
	{
		if (!rec) return;
		const cur = this.carMeta(rec);
		const next = Object.assign(cur, patch);
		this.state.cars[rec.id] = next;
		this.markDirty();
		this.save();
		const oc = this.w.realismOwnedCars;
		try { if (oc && typeof oc.update === 'function') oc.update(rec.id, patch); else Object.assign(rec, patch); } catch (e) { /* ignore */ }
	}

	/** Drops meta of cars that are no longer owned. */
	public pruneCars(): void
	{
		const oc = this.w.realismOwnedCars;
		if (!oc || !oc.cars) return;
		const ids: { [id: string]: boolean } = {};
		for (let i = 0; i < oc.cars.length; i++) ids[oc.cars[i].id] = true;
		for (const id in this.state.cars) if (this.state.cars.hasOwnProperty(id) && !ids[id]) { delete this.state.cars[id]; this.markDirty(); }
	}

	public recordFor(car: any): any
	{
		const oc = this.w.realismOwnedCars;
		try { if (oc && typeof oc.recordFor === 'function') return oc.recordFor(car); } catch (e) { /* ignore */ }
		return null;
	}

	/** Dealer value of a vehicle type (dealership prices; 18000 for the sedan, 35000 for config types). */
	public typeValue(type: string): number
	{
		const dp: any = ((this.ctx.cfg as any).dealership && (this.ctx.cfg as any).dealership.prices) || {};
		if (!type || type === 'car') return num(dp.sedan, 18000);
		if (typeof dp[type] === 'number') return dp[type];
		if (type === 'police' || type === 'sheriff') return 40000;
		if (type === 'heli') return num(dp.heli, 450000);
		if (type === 'airplane') return num(dp.airplane, 850000);
		return 35000;
	}

	public carType(car: any): string
	{
		if (!car) return 'car';
		const rec = this.recordFor(car);
		if (rec && rec.type) return rec.type;
		if (car.realismType) return car.realismType;
		const pol = this.w.realismPolice;
		try { if (pol && pol.isPoliceCar && pol.isPoliceCar(car)) return 'police'; } catch (e) { /* ignore */ }
		return 'car';
	}

	// ------------------------------------------------------------------ overlays / blocking

	public grabMouse(owner: string): void
	{
		const w = this.w;
		try { if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking(owner, true); } catch (e) { /* ignore */ }
		let locked = false;
		try { locked = typeof document !== 'undefined' && !!document.pointerLockElement; } catch (e) { locked = false; }
		this.locks[owner] = locked;
		if (locked)
		{
			try { if (w.realismUI && w.realismUI.exitLock) w.realismUI.exitLock(); else document.exitPointerLock(); } catch (e) { /* ignore */ }
		}
	}

	public releaseMouse(owner: string): void
	{
		const w = this.w;
		try { if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking(owner, false); } catch (e) { /* ignore */ }
		if (this.locks[owner])
		{
			try
			{
				if (w.realismUI && w.realismUI.requestLock) w.realismUI.requestLock();
				else if (w.renderer && w.renderer.domElement.requestPointerLock) w.renderer.domElement.requestPointerLock();
			}
			catch (e) { /* next click grabs the mouse */ }
		}
		delete this.locks[owner];
	}

	/** Opens a list menu (mouse or number keys). rows() is called again after every action. */
	public menu(spec: MenuSpec): void
	{
		if (this.menuOpen) this.closeMenu();
		this.menuSpec = spec;
		this.menuOpen = true;
		this.grabMouse(spec.owner || OWNER);
		this.renderMenu();
	}

	public closeMenu(): void
	{
		if (!this.menuOpen) return;
		const spec = this.menuSpec;
		this.menuOpen = false;
		this.menuSpec = null;
		if (this.menuEl) this.menuEl.style.display = 'none';
		this.releaseMouse(spec && spec.owner || OWNER);
		if (spec && spec.onClose) { try { spec.onClose(); } catch (e) { /* ignore */ } }
	}

	/** Test / keyboard access: rows of the open menu. */
	public menuRows(): MenuRow[] { return this.menuOpen && this.menuSpec ? this.menuSpec.rows() : []; }
	public menuTitle(): string { return this.menuOpen && this.menuSpec ? this.menuSpec.title : ''; }

	public menuPick(i: number): boolean
	{
		const rows = this.menuRows();
		const r = rows[i];
		if (!r || r.disabled || !r.action) return false;
		let res: any;
		try { res = r.action(); } catch (e) { console.warn('[Realism] illegal menu action failed', e); }
		if (this.menuOpen) this.renderMenu();
		return res !== false;
	}

	private renderMenu(): void
	{
		if (!hasDom() || !this.menuSpec) return;
		try
		{
			if (!this.menuEl)
			{
				const el = document.createElement('div');
				el.className = 'rl-ill-menu';
				document.body.appendChild(el);
				el.addEventListener('click', (e: any) =>
				{
					const t: any = e.target;
					const b = t && t.closest ? t.closest('[data-i]') : t;
					if (b && b.getAttribute && b.getAttribute('data-i') !== null) { this.menuPick(+b.getAttribute('data-i')); return; }
					if (b && b.getAttribute && b.getAttribute('data-close') !== null) this.closeMenu();
				});
				this.menuEl = el;
			}
			const s = this.menuSpec;
			const rows = s.rows();
			let h = '<div class="rl-ill-panel"><div class="rl-ill-title">' + esc(s.title) + '</div>';
			if (s.subtitle) h += '<div class="rl-ill-sub">' + esc(s.subtitle) + '</div>';
			h += '<div class="rl-ill-cash">Cash ' + money(this.cash()) + '</div><div class="rl-ill-rows">';
			for (let i = 0; i < rows.length; i++)
			{
				const r = rows[i];
				const tag = r.action ? 'button' : 'div';
				h += '<' + tag + ' class="rl-ill-row' + (r.disabled ? ' off' : '') + (r.action ? '' : ' info') + '"' + (r.action ? ' data-i="' + i + '"' : '') + '>' +
					(r.action && i < 9 ? '<span class="rl-ill-k">' + (i + 1) + '</span>' : '') +
					'<span class="rl-ill-l">' + esc(r.label) + (r.detail ? '<small>' + esc(r.detail) + '</small>' : '') + '</span>' +
					(r.right ? '<span class="rl-ill-r">' + esc(r.right) + '</span>' : '') + '</' + tag + '>';
			}
			h += '</div><button class="rl-ill-close" data-close="1">Close (Esc)</button>';
			if (this.lastToast && this.toastT > 0) h += '<div class="rl-ill-msg">' + esc(this.lastToast) + '</div>';
			h += '</div>';
			this.menuEl.innerHTML = h;
			this.menuEl.style.display = '';
		}
		catch (e) { /* headless */ }
	}

	/** Starts a timing minigame (one at a time). */
	public startTiming(spec: TimingSpec): TimingGame
	{
		if (this.timing) this.timing.cancel();
		this.timing = new TimingGame(this, spec);
		return this.timing;
	}

	// ------------------------------------------------------------------ messages / HUD

	public toast(msg: string, seconds: number = 3.5): void
	{
		this.lastToast = msg;
		this.toastT = seconds;
		if (!hasDom()) return;
		try
		{
			if (!this.toastEl)
			{
				const el = document.createElement('div');
				el.className = 'rl-ill-toast';
				document.body.appendChild(el);
				this.toastEl = el;
			}
			this.toastEl.textContent = msg;
			this.toastEl.style.display = msg ? '' : 'none';
		}
		catch (e) { /* headless */ }
		if (this.menuOpen) this.renderMenu();
	}

	private updateHud(dt: number): void
	{
		if (this.toastT > 0)
		{
			this.toastT -= dt;
			if (this.toastT <= 0 && this.toastEl) this.toastEl.style.display = 'none';
		}
		const lvl = this.cfg.heat.hud ? Math.ceil(this.state.heat / 20) : 0;   // 0..5 bars
		if (lvl === this.heatShown || !hasDom()) return;
		this.heatShown = lvl;
		try
		{
			if (!this.heatEl)
			{
				const el = document.createElement('div');
				el.className = 'rl-ill-heat';
				document.body.appendChild(el);
				this.heatEl = el;
			}
			let bars = '';
			for (let i = 0; i < 5; i++) bars += '<i class="' + (i < lvl ? 'on' : '') + '"></i>';
			this.heatEl.innerHTML = '<b>HEAT</b>' + bars;
			this.heatEl.style.display = lvl > 0 ? '' : 'none';
		}
		catch (e) { /* headless */ }
	}

	private setHint(t: string): void
	{
		if (t === this.hint) return;
		this.hint = t;
		if (!hasDom()) return;
		try
		{
			if (!this.hintEl)
			{
				const el = document.createElement('div');
				el.className = 'rl-ill-hint';
				document.body.appendChild(el);
				this.hintEl = el;
			}
			this.hintEl.textContent = t;
			this.hintEl.style.display = t ? '' : 'none';
		}
		catch (e) { /* headless */ }
	}

	// ------------------------------------------------------------------ prompts

	private setPrompt(items: PromptItem[] | null, anchor: THREE.Vector3 | null): void
	{
		let sig = '';
		if (items) for (let i = 0; i < items.length; i++) sig += items[i].key + items[i].label + (items[i].hold || 0) + '|';
		if (sig === this.promptSig) return;
		this.promptSig = sig;
		this.items = items;
		const pr = this.w.realismPrompt;
		if (pr && typeof pr.set === 'function')
		{
			try { pr.set(OWNER, items && items.length ? items : null, items && anchor ? { priority: 1, anchor: anchor } : { priority: 1 }); } catch (e) { /* ignore */ }
			this.setHint('');
		}
		else this.setHint(items ? items.map((it) => '[' + it.key + '] ' + it.label + (it.hold ? ' (hold)' : '')).join('   ') : '');
	}

	/** True when our prompt is the one shown (C7), or there is no prompt system. */
	public promptActive(): boolean
	{
		const pr = this.w.realismPrompt;
		if (pr && typeof pr.isActive === 'function') { try { return !!pr.isActive(OWNER); } catch (e) { return true; } }
		return true;
	}

	private scan(): void
	{
		const p = this.tmpV;
		let best: Interactable = null, bd = 1e9, bestItems: PromptItem[] = null;
		const ok = !this.blocked() && this.playerPos(p);
		if (ok)
		{
			const car = this.drivenCar();
			const foot = this.onFoot();
			const R = this.cfg.discoverRange;
			for (let i = 0; i < this.spots.length; i++)
			{
				const s = this.spots[i];
				const dx = s.x - p.x, dz = s.z - p.z, dy = s.y - p.y;
				const d2 = dx * dx + dz * dz;
				if (s.blip && d2 < R * R && Math.abs(dy) < 12) this.reveal(s.blip);
				if (d2 > s.r * s.r || Math.abs(dy) > 4 || d2 >= bd) continue;
				const mode = s.mode || 'foot';
				if (mode === 'foot' && !foot) continue;
				if (mode === 'car' && !car) continue;
				let items: PromptItem[] = null;
				try { items = s.items(); } catch (e) { items = null; }
				if (!items || !items.length) continue;
				best = s; bd = d2; bestItems = items;
			}
		}
		if (best !== this.current) { this.holdKey = ''; this.holdT = 0; }
		this.current = best;
		if (best) this.setPrompt(bestItems, new THREE.Vector3(best.x, best.y + 1.2, best.z));
		else this.setPrompt(null, null);
	}

	/** Re-evaluates prompts right away (after an action changed what is offered). */
	public refresh(): void { this.scanAcc = 1; this.scan(); }

	private bindInput(): void
	{
		try
		{
			if (typeof window === 'undefined' || !(window as any).addEventListener) return;
			window.addEventListener('keydown', (e: KeyboardEvent) => this.onKey(e, true), true);
			window.addEventListener('keyup', (e: KeyboardEvent) => this.onKey(e, false), true);
		}
		catch (e) { /* headless */ }
	}

	/** Public for tests: e = { code, repeat?, target?, preventDefault? }. */
	public onKey(e: any, down: boolean): boolean
	{
		const stop = () => { try { if (e.preventDefault) e.preventDefault(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch (x) { /* ignore */ } };
		const t: any = e.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false;
		if (this.timing)
		{
			if (!down) return false;
			if (e.code === 'Escape') { stop(); this.timing.cancel(); return true; }
			if ((e.code === 'Space' || e.code === 'KeyE') && !e.repeat) { stop(); this.timing.press(); return true; }
			return false;
		}
		if (this.menuOpen)
		{
			if (!down) return false;
			if (e.code === 'Escape') { stop(); this.closeMenu(); return true; }
			const m = /^Digit([1-9])$/.exec(e.code || '');
			if (m && !e.repeat) { stop(); this.menuPick(+m[1] - 1); return true; }
			return false;
		}
		const key = keyOf(e.code);
		if (!key) return false;
		if (!down)
		{
			if (this.holdKey === key) { this.holdKey = ''; this.holdT = 0; this.progress(0); }
			return false;
		}
		if (e.repeat || this.blocked() || !this.current || !this.items) return false;
		const item = this.items.filter((it) => it.key === key)[0];
		if (!item || !this.promptActive()) return false;
		if (item.hold && item.hold > 0)
		{
			this.holdKey = key; this.holdT = 0; this.holdItem = item;
			return true;
		}
		this.fire(key);
		return true;
	}

	private fire(key: string): void
	{
		const s = this.current;
		if (!s) return;
		try { s.act(key); } catch (err) { console.warn('[Realism] illegal action failed', err); }
		this.refresh();
	}

	private progress(t: number): void
	{
		const pr = this.w.realismPrompt;
		try { if (pr && typeof pr.progress === 'function') pr.progress(OWNER, t); } catch (e) { /* ignore */ }
	}

	/** Test helper: presses (and for hold items holds) a key on the current prompt. Returns false if not offered. */
	public press(key: string, holdSeconds?: number): boolean
	{
		this.refresh();
		if (!this.items) return false;
		const item = this.items.filter((it) => it.key === key)[0];
		if (!item) return false;
		if (item.hold && (holdSeconds || 0) < item.hold) return false;
		this.fire(key);
		return true;
	}

	// ------------------------------------------------------------------ blips / guides

	public addBlip(id: string, b: { x: number; z: number; icon: string; color?: string; label?: string; shortRange?: boolean; always?: boolean }): void
	{
		this.blips[id] = Object.assign({ added: false }, b);
		this.syncBlips();
	}

	public reveal(id: string): void
	{
		if (!id || this.state.found[id]) return;
		this.state.found[id] = true;
		this.markDirty();
		this.syncBlips();
	}

	public revealAll(): void
	{
		for (const id in this.blips) if (this.blips.hasOwnProperty(id)) this.state.found[id] = true;
		this.state.guidesRead = true;
		this.markDirty();
		this.syncBlips();
	}

	public isFound(id: string): boolean { return !!(this.cfg.revealAll || this.state.guidesRead || this.state.found[id]); }

	private syncBlips(): void
	{
		const gps = this.w.realismGPS;
		if (!gps || typeof gps.addBlip !== 'function') return;
		for (const id in this.blips)
		{
			if (!this.blips.hasOwnProperty(id)) continue;
			const b = this.blips[id];
			if (b.added || !(b.always || this.isFound(id))) continue;
			try { gps.addBlip(id, { x: b.x, z: b.z, icon: b.icon, color: b.color, label: b.label, shortRange: b.shortRange }); b.added = true; } catch (e) { /* ignore */ }
		}
	}

	/** Guide for the A15 guide system; registered as soon as realismGuides exists. */
	public addGuide(g: any): void
	{
		const self = this;
		g.category = g.category || 'illegal';
		g.illegal = true;
		const read = g.onRead;
		g.onRead = function(): void
		{
			const ids: string[] = g.reveals || [];
			for (let i = 0; i < ids.length; i++) self.reveal(ids[i]);
			if (read) { try { read(); } catch (e) { /* ignore */ } }
		};
		g.onOpen = g.onRead;
		this.guides.push(g);
		this.syncGuides();
	}

	private syncGuides(): void
	{
		const gs = this.w.realismGuides;
		if (!gs || typeof gs.add !== 'function') return;
		for (let i = 0; i < this.guides.length; i++)
		{
			const g = this.guides[i];
			if (this.guideRegistered[g.id]) continue;
			try { gs.add(g); this.guideRegistered[g.id] = true; } catch (e) { /* ignore */ }
		}
	}

	public get guidesRegistered(): number { let n = 0; for (const k in this.guideRegistered) if (this.guideRegistered.hasOwnProperty(k)) n++; return n; }

	// ------------------------------------------------------------------ markers (GTA style)

	/** A ground ring + soft light column + floating chevron. Visible within `range` metres. */
	public marker(x: number, y: number, z: number, color: string, opts?: { radius?: number; range?: number; column?: boolean }): THREE.Object3D
	{
		const o = opts || {};
		if (!this.markerGeo)
		{
			const ring = new THREE.RingBufferGeometry(0.82, 1, 32, 1); ring.rotateX(-Math.PI / 2);
			const col = new THREE.CylinderBufferGeometry(1, 1, 1, 24, 1, true); col.translate(0, 0.5, 0);
			const arrow = new THREE.ConeBufferGeometry(0.28, 0.5, 4, 1); arrow.rotateX(Math.PI);
			this.markerGeo = [ring, col, arrow];
		}
		let mats = this.markerMats[color];
		if (!mats)
		{
			const c = new THREE.Color(color);
			mats = [
				new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
				new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
				new THREE.MeshBasicMaterial({ color: c }),
			];
			this.markerMats[color] = mats;
		}
		const r = o.radius || 1.2;
		const g = new THREE.Group();
		g.name = 'illegalMarker';
		const ring = new THREE.Mesh(this.markerGeo[0], mats[0]); ring.scale.set(r, 1, r); ring.position.y = 0.06;
		g.add(ring);
		if (o.column !== false) { const c = new THREE.Mesh(this.markerGeo[1], mats[1]); c.scale.set(r, 1.6, r); g.add(c); }
		const arrow = new THREE.Mesh(this.markerGeo[2], mats[2]); arrow.position.y = 2.6;
		g.add(arrow);
		g.position.set(x, y, z);
		g.traverse((m: any) => { if (m.isMesh) m.renderOrder = 2; });
		this.w.graphicsWorld.add(g);
		this.markers.push({ obj: g, arrow: arrow, x: x, z: z, baseY: 2.6, range: o.range || 140 });
		this.stats.markers = this.markers.length;
		return g;
	}

	private updateMarkers(dt: number): void
	{
		this.markerAcc += dt;
		const t = (Date.now() % 100000) / 1000;
		const p = this.tmpV;
		const have = this.playerPos(p);
		const check = this.markerAcc > 0.5;
		if (check) this.markerAcc = 0;
		for (let i = 0; i < this.markers.length; i++)
		{
			const m = this.markers[i];
			if (check && have)
			{
				const dx = m.x - p.x, dz = m.z - p.z;
				const vis = !m.obj.userData.hidden && dx * dx + dz * dz < m.range * m.range && Math.abs(m.obj.position.y - p.y) < 60;
				if (m.obj.visible !== vis) m.obj.visible = vis;
			}
			if (m.obj.visible) { m.arrow.position.y = m.baseY + Math.sin(t * 2.4 + i) * 0.15; m.arrow.rotation.y = t * 1.6; }
		}
	}

	// ------------------------------------------------------------------ figures (contacts, dancers)

	private loadBoxman(): void
	{
		try
		{
			loadSharedModel('build/assets/boxman.glb', (gltf: any) =>
			{
				this.boxman = gltf; this.boxmanState = 1;
				const p = this.pendingFigures; this.pendingFigures = [];
				for (let i = 0; i < p.length; i++) this.fillFigure(p[i].root, p[i].pose);
			}, () => { this.boxmanState = 2; const p = this.pendingFigures; this.pendingFigures = []; for (let i = 0; i < p.length; i++) this.fillFigure(p[i].root, p[i].pose); });
		}
		catch (e) { this.boxmanState = 2; }
	}

	/** A standing person (pooled boxman clone, idle animation) at a spot, facing `rot`. */
	public figure(x: number, y: number, z: number, rot: number, tint: number[], pose?: string, parent?: THREE.Object3D): THREE.Group
	{
		const root = new THREE.Group();
		root.name = 'illegalFigure';
		root.position.set(x, y, z);
		root.rotation.y = rot;
		root.userData.tint = tint;
		(parent || this.w.graphicsWorld).add(root);
		if (this.boxmanState === 0) this.pendingFigures.push({ root: root, pose: pose || 'idle' });
		else this.fillFigure(root, pose || 'idle');
		return root;
	}

	private fillFigure(root: THREE.Group, pose: string): void
	{
		const tint: number[] = root.userData.tint || [0.3, 0.3, 0.35];
		const s = playerScaleOf(this.ctx);
		let mixer: THREE.AnimationMixer = null;
		if (this.boxmanState === 1 && this.boxman)
		{
			const model = SkeletonUtils.clone(this.boxman.scene) as THREE.Object3D;
			const mat = this.figureMat(tint);
			model.traverse((o: any) => { if (o.isMesh) { o.material = mat; o.castShadow = false; o.receiveShadow = false; } });
			model.scale.setScalar(s);
			root.add(model);
			const clips = this.boxman.animations || [];
			const clip = THREE.AnimationClip.findByName(clips, pose) || THREE.AnimationClip.findByName(clips, 'idle');
			if (clip) { mixer = new THREE.AnimationMixer(model); mixer.clipAction(clip).play(); mixer.update(Math.random() * 2); }
		}
		else
		{
			const acc = new GeoAccum();
			const f = new Frame(0, 0, 0, 0);
			const skin = [0.55, 0.4, 0.3];
			boxC(acc, f, 0, 0.42, 0, 0.36, 0.84, 0.22, [tint[0] * 0.6, tint[1] * 0.6, tint[2] * 0.6]);
			boxC(acc, f, 0, 1.12, 0, 0.46, 0.6, 0.26, tint);
			boxC(acc, f, 0, 1.56, 0, 0.24, 0.26, 0.24, skin);
			const m = new THREE.Mesh(acc.toGeometry(), this.standInMat());
			m.scale.setScalar(s / 1.7);
			root.add(m);
		}
		this.figures.push({ root: root, mixer: mixer, x: root.position.x, z: root.position.z, bob: pose === 'dance' ? 1 : 0 });
	}

	private figMats: { [k: string]: THREE.Material } = {};
	private figureMat(tint: number[]): THREE.Material
	{
		const key = tint.map((v) => v.toFixed(2)).join(',');
		let m = this.figMats[key];
		if (m) return m;
		let map: THREE.Texture = null;
		this.boxman.scene.traverse((o: any) => { if (o.isMesh && o.material && o.material.map && !map) map = o.material.map; });
		m = new THREE.MeshLambertMaterial({ map: map, skinning: true, color: new THREE.Color(0.6 + tint[0] * 0.4, 0.6 + tint[1] * 0.4, 0.6 + tint[2] * 0.4) } as any);
		m.name = 'illegalFigure';
		this.figMats[key] = m;
		return m;
	}

	private sMat: THREE.Material = null;
	private standInMat(): THREE.Material
	{
		if (!this.sMat) this.sMat = new THREE.MeshLambertMaterial({ vertexColors: THREE.VertexColors });
		return this.sMat;
	}

	private updateFigures(dt: number): void
	{
		const p = this.tmpV;
		if (!this.playerPos(p)) return;
		const t = (Date.now() % 100000) / 1000;
		for (let i = 0; i < this.figures.length; i++)
		{
			const f = this.figures[i];
			const wp = f.root.parent && f.root.parent !== this.w.graphicsWorld ? null : f.root.position;
			let near = true;
			if (wp)
			{
				const dx = wp.x - p.x, dz = wp.z - p.z, d2 = dx * dx + dz * dz, dy = Math.abs(wp.y - p.y);
				const show = !f.root.userData.hidden && d2 < 130 * 130 && dy < 40;      // contacts: hidden far away (0 draw calls)
				if (f.root.visible !== show) f.root.visible = show;
				near = show && d2 < 70 * 70;
			}
			else near = isVisible(f.root);
			if (!near) continue;
			if (f.mixer) f.mixer.update(dt * (f.bob ? 1.6 : 1));
			if (f.bob)
			{
				const k = f.root.children[0];
				if (k) { k.position.y = Math.abs(Math.sin(t * 4.2 + i * 1.3)) * 0.12; k.rotation.y = Math.sin(t * 1.1 + i) * 0.6; }
			}
		}
	}

	public get figureCount(): number { return this.figures.length; }

	// ------------------------------------------------------------------ pocket rooms

	/** Allocates a closed room above the sea south of the coast. */
	public room(id: string, w: number, d: number, h: number, colors: { floor: number[]; wall: number[]; ceil: number[] }): PocketRoom
	{
		const i = this.roomSlots++;
		const x = -930 + i * 62, z = 960, y = 320;
		const r = new PocketRoom(this, id, x, y, z, w, d, h, colors);
		this.rooms.push(r);
		this.stats.rooms = this.rooms.length;
		return r;
	}

	public roomById(id: string): PocketRoom { for (let i = 0; i < this.rooms.length; i++) if (this.rooms[i].id === id) return this.rooms[i]; return null; }

	/** Teleports the player (on foot) to a world point, facing yaw `rot` (0 = +Z). */
	public teleport(x: number, y: number, z: number, rot: number): boolean
	{
		const ch = this.player();
		if (!ch || ch.occupyingSeat) return false;
		try
		{
			ch.setPosition(x, y, z);
			ch.resetVelocity();
			const v = new THREE.Vector3(Math.sin(rot), 0, Math.cos(rot));
			ch.setOrientation(v, true);
			if (ch.position) ch.position.set(x, y, z);
		}
		catch (e) { return false; }
		return true;
	}

	// ------------------------------------------------------------------ per frame

	public update(timeStep: number, unscaled: number): void
	{
		const t0 = now();
		const dt = Math.min(0.1, unscaled || timeStep || 0);
		const paused = !!this.w.realismPaused;
		this.updateHud(dt);
		if (this.timing) this.timing.update(paused ? 0 : dt);
		this.dh = 0;
		if (!paused)
		{
			const t = this.w.realismTime;
			if (t && typeof t.hour === 'number')
			{
				if (this.lastHour >= 0) { let d = t.hour - this.lastHour; if (d < -12) d += 24; if (d > 0 && d < 24) this.dh = d; }
				this.lastHour = t.hour;
			}
			else this.dh = dt / 60;
			this.state.clock = (this.state.clock || 0) + this.dh;
			// heat cools down
			if (this.state.heat > 0)
			{
				this.state.heat = Math.max(0, this.state.heat - this.cfg.heat.decayPerMinute * dt / 60);
			}
			for (let i = 0; i < this.updaters.length; i++) { try { this.updaters[i].update(dt); } catch (e) { console.warn('[Realism] illegal updater failed', e); this.updaters.splice(i, 1); i--; } }
			// hold-to-act
			if (this.holdKey && this.holdItem && this.current)
			{
				if (this.blocked()) { this.holdKey = ''; this.holdT = 0; this.progress(0); }
				else
				{
					this.holdT += dt;
					this.progress(clamp(this.holdT / this.holdItem.hold, 0, 1));
					if (this.holdT >= this.holdItem.hold) { const k = this.holdKey; this.holdKey = ''; this.holdT = 0; this.progress(0); this.fire(k); }
				}
			}
			this.scanAcc += dt;
			if (this.scanAcc >= 0.12) { this.scanAcc = 0; this.scan(); }
			this.updateMarkers(dt);
			this.updateFigures(dt);
			for (let i = 0; i < this.rooms.length; i++) this.rooms[i].watch();
		}
		else if (this.items) this.setPrompt(null, null);
		this.lazyAcc += dt;
		if (this.lazyAcc > 2) { this.lazyAcc = 0; this.syncBlips(); this.syncGuides(); this.inv(); }
		this.saveAcc += dt;
		if (this.dirty && this.saveAcc > 3) this.save();
		const ms = now() - t0;
		this.stats.updateMs = this.stats.updateMs * 0.9 + ms * 0.1;
		if (ms > this.stats.maxUpdateMs) this.stats.maxUpdateMs = ms;
	}
}

// ---------------------------------------------------------------------------------------- pocket room

export class PocketRoom
{
	public id: string;
	public x: number; public y: number; public z: number;
	public w: number; public d: number; public h: number;
	public group: THREE.Group;
	public acc = new GeoAccum();            // static furniture (vertex coloured), merged on finish()
	public inside = false;
	public body: CANNON.Body;
	public returnTo: { x: number; y: number; z: number; rot: number } = null;
	public onEnter: () => void = null;
	public onExit: () => void = null;
	public frame: Frame;
	private core: IllegalCore;
	private furniture: THREE.Mesh = null;
	private mat: THREE.Material;

	constructor(core: IllegalCore, id: string, x: number, y: number, z: number, w: number, d: number, h: number, colors: { floor: number[]; wall: number[]; ceil: number[] })
	{
		this.core = core; this.id = id;
		this.x = x; this.y = y; this.z = z; this.w = w; this.d = d; this.h = h;
		this.frame = new Frame(x, y, z, 0);
		this.group = new THREE.Group();
		this.group.name = 'pocketRoom_' + id;
		this.group.visible = false;
		const lit = core.ctx.preset && (core.ctx.preset as any).lighting === 'phong';
		this.mat = lit ? new THREE.MeshPhongMaterial({ vertexColors: THREE.VertexColors, shininess: 4, emissive: new THREE.Color(0.18, 0.18, 0.18) })
			: new THREE.MeshLambertMaterial({ vertexColors: THREE.VertexColors, emissive: new THREE.Color(0.18, 0.18, 0.18) });
		this.mat.name = 'pocketRoom';
		// shell: inward facing quads only, so a camera outside a wall looks straight through it
		const s = new GeoAccum();
		const hw = w / 2, hd = d / 2;
		const P = (a: number, b: number, c: number) => [x + a, y + b, z + c];
		s.face([P(-hw, 0, -hd), P(hw, 0, -hd), P(hw, 0, hd), P(-hw, 0, hd)], [0, 1, 0], [[0, 0], [0, 0], [0, 0], [0, 0]], colors.floor);
		s.face([P(-hw, h, -hd), P(-hw, h, hd), P(hw, h, hd), P(hw, h, -hd)], [0, -1, 0], [[0, 0], [0, 0], [0, 0], [0, 0]], colors.ceil);
		s.face([P(-hw, 0, -hd), P(-hw, h, -hd), P(hw, h, -hd), P(hw, 0, -hd)], [0, 0, 1], [[0, 0], [0, 0], [0, 0], [0, 0]], colors.wall);
		s.face([P(-hw, 0, hd), P(hw, 0, hd), P(hw, h, hd), P(-hw, h, hd)], [0, 0, -1], [[0, 0], [0, 0], [0, 0], [0, 0]], colors.wall);
		const wd = [colors.wall[0] * 0.9, colors.wall[1] * 0.9, colors.wall[2] * 0.9];
		s.face([P(-hw, 0, -hd), P(-hw, 0, hd), P(-hw, h, hd), P(-hw, h, -hd)], [1, 0, 0], [[0, 0], [0, 0], [0, 0], [0, 0]], wd);
		s.face([P(hw, 0, -hd), P(hw, h, -hd), P(hw, h, hd), P(hw, 0, hd)], [-1, 0, 0], [[0, 0], [0, 0], [0, 0], [0, 0]], wd);
		const shell = new THREE.Mesh(s.toGeometry(), this.mat);
		shell.name = 'pocketShell';
		shell.matrixAutoUpdate = false;
		this.group.add(shell);
		// colliders: floor, walls, ceiling (one static body, only while someone is inside)
		this.body = new CANNON.Body({ mass: 0 });
		const T = 0.5;
		this.body.addShape(new CANNON.Box(new CANNON.Vec3(hw + T, T, hd + T)), new CANNON.Vec3(0, -T, 0));
		this.body.addShape(new CANNON.Box(new CANNON.Vec3(hw + T, T, hd + T)), new CANNON.Vec3(0, h + T, 0));
		this.body.addShape(new CANNON.Box(new CANNON.Vec3(hw + T, h / 2, T)), new CANNON.Vec3(0, h / 2, -hd - T));
		this.body.addShape(new CANNON.Box(new CANNON.Vec3(hw + T, h / 2, T)), new CANNON.Vec3(0, h / 2, hd + T));
		this.body.addShape(new CANNON.Box(new CANNON.Vec3(T, h / 2, hd + T)), new CANNON.Vec3(-hw - T, h / 2, 0));
		this.body.addShape(new CANNON.Box(new CANNON.Vec3(T, h / 2, hd + T)), new CANNON.Vec3(hw + T, h / 2, 0));
		this.body.position.set(x, y, z);
		try { core.w.sky.csm.setupMaterial(this.mat); } catch (e) { /* no csm */ }
		core.w.graphicsWorld.add(this.group);
	}

	/** World point of local (lx, ly, lz), room centre floor = (0, 0, 0). */
	public p(lx: number, ly: number, lz: number): THREE.Vector3 { return new THREE.Vector3(this.x + lx, this.y + ly, this.z + lz); }

	/** Static furniture box (local coords, centre + size); collide adds a collider box. */
	public box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, c: number[], collide?: boolean): void
	{
		boxC(this.acc, this.frame, cx, cy, cz, sx, sy, sz, c);
		if (collide) this.body.addShape(new CANNON.Box(new CANNON.Vec3(sx / 2, sy / 2, sz / 2)), new CANNON.Vec3(cx, cy, cz));
	}

	public finish(): void
	{
		if (this.acc.empty || this.furniture) return;
		this.furniture = new THREE.Mesh(this.acc.toGeometry(), this.mat);
		this.furniture.name = 'pocketFurniture';
		this.furniture.matrixAutoUpdate = false;
		this.group.add(this.furniture);
	}

	/** A label plate (canvas texture) on a wall or above a station. */
	public label(text: string, lx: number, ly: number, lz: number, rotY: number, wM: number, color?: string): THREE.Mesh
	{
		const m = textPlane(text, wM, color || '#f2c230');
		m.position.set(this.x + lx, this.y + ly, this.z + lz);
		m.rotation.y = rotY;
		this.group.add(m);
		return m;
	}

	public enter(returnTo: { x: number; y: number; z: number; rot: number }, lx: number, lz: number, rot: number): boolean
	{
		if (!this.core.onFoot()) { this.core.toast('Get out of the vehicle first.'); return false; }
		const prev = this.core.insideRoom;
		if (prev && prev !== this) prev.leave(false);
		this.finish();
		if (!this.inside) { this.core.w.physicsWorld.addBody(this.body); }
		this.group.visible = true;
		this.inside = true;
		if (returnTo) this.returnTo = returnTo;
		this.core.insideRoom = this;
		this.core.stats.roomsVisible = this.core.rooms.filter((r) => r.group.visible).length;
		this.core.teleport(this.x + lx, this.y + 1.0, this.z + lz, rot);
		(this.core.w as any).realismIndoors = this.id;
		if (this.onEnter) { try { this.onEnter(); } catch (e) { /* ignore */ } }
		return true;
	}

	/** Back to the entrance (teleport = false: just hide, the player is already elsewhere). */
	public leave(teleport: boolean = true): void
	{
		if (!this.inside) return;
		this.inside = false;
		this.group.visible = false;
		try { this.core.w.physicsWorld.remove(this.body); } catch (e) { /* ignore */ }
		if (this.core.insideRoom === this) this.core.insideRoom = null;
		if ((this.core.w as any).realismIndoors === this.id) (this.core.w as any).realismIndoors = null;
		this.core.stats.roomsVisible = this.core.rooms.filter((r) => r.group.visible).length;
		if (teleport && this.returnTo) this.core.teleport(this.returnTo.x, this.returnTo.y, this.returnTo.z, this.returnTo.rot);
		if (this.onExit) { try { this.onExit(); } catch (e) { /* ignore */ } }
	}

	/** Respawned / teleported away by something else: tidy up. */
	public watch(): void
	{
		if (!this.inside) return;
		const ch = this.core.player();
		if (!ch) return;
		const p = ch.occupyingSeat && ch.occupyingSeat.vehicle ? ch.occupyingSeat.vehicle.position : ch.position;
		if (Math.abs(p.x - this.x) > this.w / 2 + 8 || Math.abs(p.z - this.z) > this.d / 2 + 8 || p.y < this.y - 10 || p.y > this.y + this.h + 10) this.leave(false);
	}
}

// ---------------------------------------------------------------------------------------- timing minigame

export class TimingGame
{
	public spec: TimingSpec;
	public stage = 0;
	public hits = 0;
	public misses = 0;
	public needle = 0;
	public zoneAt = 0.5;
	public elapsed = 0;
	public done = false;
	private dir = 1;
	private stageT = 0;
	private core: IllegalCore;
	private el: HTMLElement = null;
	private needleEl: HTMLElement = null;
	private zoneEl: HTMLElement = null;
	private textEl: HTMLElement = null;
	private progEl: HTMLElement = null;
	private flash = 0;
	private finished = false;

	constructor(core: IllegalCore, spec: TimingSpec)
	{
		this.core = core;
		this.spec = spec;
		this.newZone();
		core.grabMouse(spec.owner);
		this.build();
	}

	private newZone(): void
	{
		const z = this.spec.zone;
		this.zoneAt = z / 2 + Math.random() * (1 - z);
		this.needle = Math.random() < 0.5 ? 0 : 1;
		this.dir = this.needle === 0 ? 1 : -1;
		this.stageT = 0;
	}

	public get inZone(): boolean { return Math.abs(this.needle - this.zoneAt) <= this.spec.zone / 2; }

	/** Space / E / click. */
	public press(): void
	{
		if (this.done) return;
		if (this.inZone) { this.hits++; this.flash = 0.25; this.nextStage(); }
		else this.miss();
	}

	private miss(): void
	{
		this.misses++;
		this.flash = -0.3;
		if (this.misses >= this.spec.maxMisses) { this.finish(false); return; }
		this.newZone();
	}

	private nextStage(): void
	{
		this.stage++;
		if (this.stage >= this.spec.stages.length)
		{
			// a batch with a minimum duration waits for the progress bar
			if (this.spec.duration && this.elapsed < this.spec.duration) { this.stage = this.spec.stages.length; return; }
			this.finish(true);
			return;
		}
		this.newZone();
	}

	public update(dt: number): void
	{
		if (this.done) return;
		this.elapsed += dt;
		const allHit = this.stage >= this.spec.stages.length;
		if (allHit)
		{
			if (!this.spec.duration || this.elapsed >= this.spec.duration) this.finish(true);
			this.render();
			return;
		}
		this.needle += this.dir * this.spec.speed * 2 * dt;
		if (this.needle > 1) { this.needle = 2 - this.needle; this.dir = -1; }
		if (this.needle < 0) { this.needle = -this.needle; this.dir = 1; }
		this.stageT += dt;
		if (this.stageT > this.spec.stageTimeout) this.miss();
		if (this.flash > 0) this.flash = Math.max(0, this.flash - dt); else if (this.flash < 0) this.flash = Math.min(0, this.flash + dt);
		this.render();
	}

	public cancel(): void { if (!this.done) this.finish(false); }

	private finish(success: boolean): void
	{
		if (this.finished) return;
		this.finished = true;
		this.done = true;
		if (this.el) this.el.style.display = 'none';
		this.core.releaseMouse(this.spec.owner);
		if (this.core.timing === this) this.core.timing = null;
		try { this.spec.onFinish({ success: success, hits: this.hits, misses: this.misses }); } catch (e) { console.warn('[Realism] minigame callback failed', e); }
	}

	private build(): void
	{
		if (!hasDom()) return;
		try
		{
			const el = document.createElement('div');
			el.className = 'rl-ill-timing';
			el.innerHTML = '<div class="rl-ill-panel"><div class="rl-ill-title">' + esc(this.spec.title) + '</div><div class="rl-ill-stage"></div>' +
				'<div class="rl-ill-bar"><div class="rl-ill-zone"></div><div class="rl-ill-needle"></div></div>' +
				(this.spec.duration ? '<div class="rl-ill-prog"><i></i></div>' : '') +
				'<div class="rl-ill-sub">SPACE / E / click when the needle is in the green. Esc gives up.</div></div>';
			document.body.appendChild(el);
			el.addEventListener('mousedown', (e: any) => { if (e && e.button === 0) this.press(); });
			this.el = el;
			this.textEl = el.querySelector('.rl-ill-stage') as HTMLElement;
			this.zoneEl = el.querySelector('.rl-ill-zone') as HTMLElement;
			this.needleEl = el.querySelector('.rl-ill-needle') as HTMLElement;
			this.progEl = el.querySelector('.rl-ill-prog i') as HTMLElement;
			this.render();
		}
		catch (e) { this.el = null; }
	}

	private render(): void
	{
		if (!this.el) return;
		try
		{
			const st = Math.min(this.stage, this.spec.stages.length - 1);
			const allHit = this.stage >= this.spec.stages.length;
			if (this.textEl) this.textEl.textContent = allHit ? 'Finishing up...' : 'Stage ' + (st + 1) + '/' + this.spec.stages.length + ': ' + this.spec.stages[st] + '   (misses ' + this.misses + '/' + this.spec.maxMisses + ')';
			if (this.zoneEl) { this.zoneEl.style.left = ((this.zoneAt - this.spec.zone / 2) * 100) + '%'; this.zoneEl.style.width = (this.spec.zone * 100) + '%'; }
			if (this.needleEl) { this.needleEl.style.left = (this.needle * 100) + '%'; this.needleEl.style.background = this.flash > 0 ? '#6f6' : this.flash < 0 ? '#f55' : '#fff'; }
			if (this.progEl && this.spec.duration) this.progEl.style.width = Math.min(100, this.elapsed / this.spec.duration * 100) + '%';
		}
		catch (e) { /* ignore */ }
	}
}

// ---------------------------------------------------------------------------------------- helpers

export function now(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

function keyOf(code: string): string
{
	if (!code) return '';
	const m = /^Key([A-Z])$/.exec(code);
	return m ? m[1] : '';
}

function isVisible(o: THREE.Object3D): boolean
{
	let p = o;
	while (p) { if (!p.visible) return false; p = p.parent; }
	return true;
}

export function isStolenOrigin(rec: any): boolean
{
	if (!rec) return false;
	if (rec.stolen === true) return true;
	const o = String(rec.origin || '');
	return /^h\d+/.test(o) || o === 'traffic' || o === 'stolen' || o === 'carjack';
}

const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
/** 17-character fictional VIN, stable per record id. */
export function makeVin(seed: string): string
{
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = (h * 16777619) >>> 0; }
	let s = 'SV';
	for (let i = 0; i < 15; i++) { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; s += VIN_CHARS.charAt(h % VIN_CHARS.length); }
	return s;
}

export function canvas(w: number, h: number): { cv: any; g: any }
{
	try
	{
		const cv: any = document.createElement('canvas');
		cv.width = w; cv.height = h;
		return { cv: cv, g: cv.getContext('2d') };
	}
	catch (e) { return { cv: null, g: null }; }
}

/** Unlit text plate (signs, station names). */
export function textPlane(text: string, widthM: number, color: string, bg?: string, glow?: boolean): THREE.Mesh
{
	const { cv, g } = canvas(512, 128);
	if (g)
	{
		g.fillStyle = bg || 'rgba(12,14,18,0.92)'; g.fillRect(0, 0, 512, 128);
		g.strokeStyle = color; g.lineWidth = 6; g.strokeRect(5, 5, 502, 118);
		g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
		g.font = 'bold ' + (text.length > 16 ? 44 : 60) + 'px Arial, sans-serif';
		if (glow) { g.shadowColor = color; g.shadowBlur = 18; }
		g.fillText(text, 256, 66);
	}
	const tex = cv ? new THREE.CanvasTexture(cv) : null;
	const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: !!bg && bg.indexOf('rgba') === 0, side: THREE.DoubleSide });
	const m = new THREE.Mesh(new THREE.PlaneBufferGeometry(widthM, widthM / 4), mat);
	m.name = 'illegalLabel';
	return m;
}

/** Ground height + free-spot test against buildings / roads (for contacts and markers). */
export function spotIsFree(ctx: RealismCtx, x: number, z: number, clearance: number, ignore?: number): boolean
{
	const bs: any[] = ctx.data.buildings || [];
	for (let i = 0; i < bs.length; i++)
	{
		if (i === ignore) continue;
		const b = bs[i];
		const dx = x - b.x, dz = z - b.z;
		if (dx * dx + dz * dz > (b.w + b.d + clearance * 2) * (b.w + b.d + clearance * 2)) continue;
		const c = Math.cos(b.rot), s = Math.sin(b.rot);
		const lx = dx * c - dz * s, lz = dx * s + dz * c;
		if (Math.abs(lx) < b.w / 2 + clearance && Math.abs(lz) < b.d / 2 + clearance) return false;
	}
	const props: any[] = ctx.data.props || [];
	for (let i = 0; i < props.length; i++)
	{
		const p = props[i];
		const dx = x - p.x, dz = z - p.z;
		if (dx * dx + dz * dz < (clearance + 0.8) * (clearance + 0.8)) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------------------- site picking

export interface Site { x: number; y: number; z: number; rot: number; building: number; face: number; }

/** Places reserved by our builders (so two sites never overlap). */
export const RESERVED: { x: number; z: number; r: number; what: string }[] = [];

export function reserve(x: number, z: number, r: number, what: string): void { RESERVED.push({ x: x, z: z, r: r, what: what }); }

export function reservedClash(x: number, z: number, r: number): boolean
{
	for (let i = 0; i < RESERVED.length; i++)
	{
		const o = RESERVED[i];
		const dx = o.x - x, dz = o.z - z;
		if (dx * dx + dz * dz < (o.r + r) * (o.r + r)) return true;
	}
	return false;
}

/** Distance (xz) from a point to the nearest exterior door segment. */
export function doorDistance(ctx: RealismCtx, x: number, z: number): number
{
	const ds: any[] = ctx.doors && (ctx.doors as any).doors ? (ctx.doors as any).doors : [];
	let best = 1e9;
	for (let i = 0; i < ds.length; i++)
	{
		const d = ds[i];
		if (d.interior) continue;
		const ex = d.bx - d.ax, ez = d.bz - d.az;
		const l2 = ex * ex + ez * ez || 1;
		const t = clamp(((x - d.ax) * ex + (z - d.az) * ez) / l2, 0, 1);
		const px = d.ax + ex * t - x, pz = d.az + ez * t - z;
		const dd = px * px + pz * pz;
		if (dd < best) best = dd;
	}
	return Math.sqrt(best);
}

/**
 * Finds a free spot of size width x depth against one face of building `bi` (outside it), facing away
 * from the wall: no other building / prop inside, not deep in a road, clear of doors and of RESERVED,
 * ground fairly flat. road: 'near' prefers spots by a road (bays you drive into), 'away' prefers spots
 * away from roads (hidden entrances). faces: which faces to try (0 front, 1 right, 2 back, 3 left).
 */
export function besideBuilding(ctx: RealismCtx, bi: number, width: number, depth: number, opts?: { road?: string; faces?: number[]; doorGap?: number; gap?: number }): Site | null
{
	const o = opts || {};
	const b: any = ctx.data.buildings[bi];
	if (!b) return null;
	const faces = o.faces || [0, 1, 2, 3];
	const data = ctx.data;
	let best: Site = null, bestScore = 1e9;
	const fx = Math.sin(b.rot), fz = Math.cos(b.rot), rx = Math.cos(b.rot), rz = -Math.sin(b.rot);
	for (let fi = 0; fi < faces.length; fi++)
	{
		const f = faces[fi];
		// face normal n and tangent t (world), half extent along n (hn) and along t (ht)
		const nx = f === 0 ? fx : f === 2 ? -fx : f === 1 ? rx : -rx;
		const nz = f === 0 ? fz : f === 2 ? -fz : f === 1 ? rz : -rz;
		const tx = -nz, tz = nx;
		const hn = f === 0 || f === 2 ? b.d / 2 : b.w / 2;
		const ht = f === 0 || f === 2 ? b.w / 2 : b.d / 2;
		const dist = hn + depth / 2 + (o.gap !== undefined ? o.gap : 0.6);
		for (let k = -4; k <= 4; k++)
		{
			const off = (k / 4) * Math.max(0, ht - width / 2 - 0.5);
			const x = b.x + nx * dist + tx * off, z = b.z + nz * dist + tz * off;
			const rad = Math.sqrt(width * width + depth * depth) / 2;
			if (Math.abs(x) > 1000 || Math.abs(z) > 1000) continue;
			if (reservedClash(x, z, rad)) continue;
			if (!spotIsFree(ctx, x, z, rad * 0.8, bi)) continue;
			// keep the rect off this building and flat
			let hmin = 1e9, hmax = -1e9;
			for (let cx = -1; cx <= 1; cx += 2) for (let cz = -1; cz <= 1; cz += 2)
			{
				const px = x + tx * cx * width / 2 + nx * cz * depth / 2, pz = z + tz * cx * width / 2 + nz * cz * depth / 2;
				const h = data.heightAt(px, pz);
				if (h < hmin) hmin = h; if (h > hmax) hmax = h;
			}
			if (hmax - hmin > 1.2 || hmin < 0.3) continue;
			const rc = data.roadClearance(x, z);
			if (rc < -0.5) continue;
			const dd = doorDistance(ctx, x, z);
			if (dd < (o.doorGap !== undefined ? o.doorGap : 2.5) + width / 2) continue;
			let score = o.road === 'away' ? -Math.min(rc, 30) : Math.abs(rc - 2.5);
			score += Math.abs(k) * 0.15;
			if (score < bestScore)
			{
				bestScore = score;
				best = { x: x, y: data.heightAt(x, z), z: z, rot: Math.atan2(nx, nz), building: bi, face: f };
			}
		}
	}
	return best;
}

/** A painted bay on the ground (decal following the terrain) with a title. rot = yaw of its +Z (towards the street). */
export function bayDecal(core: IllegalCore, x: number, z: number, rot: number, w: number, d: number, title: string, sub: string, color: string): THREE.Mesh
{
	const data = core.ctx.data;
	const g = new THREE.PlaneBufferGeometry(w, d, 4, 6);
	g.rotateX(-Math.PI / 2);
	const p = g.attributes.position as THREE.BufferAttribute;
	const fx = Math.sin(rot), fz = Math.cos(rot), rx = Math.cos(rot), rz = -Math.sin(rot);
	for (let i = 0; i < p.count; i++)
	{
		const lx = p.getX(i), lz = p.getZ(i);
		const wx = x + rx * lx + fx * -lz, wz = z + rz * lx + fz * -lz;
		p.setXYZ(i, wx, data.heightAt(wx, wz) + 0.05, wz);
	}
	g.computeVertexNormals();
	g.computeBoundingSphere();
	const { cv, g: c2 } = canvas(256, 512);
	if (c2)
	{
		c2.clearRect(0, 0, 256, 512);
		c2.fillStyle = 'rgba(30,30,34,0.55)'; c2.fillRect(0, 0, 256, 512);
		c2.strokeStyle = color; c2.lineWidth = 12; c2.setLineDash && c2.setLineDash([26, 14]); c2.strokeRect(9, 9, 238, 494);
		c2.setLineDash && c2.setLineDash([]);
		c2.fillStyle = color; c2.textAlign = 'center'; c2.textBaseline = 'middle';
		c2.font = 'bold 40px Arial, sans-serif';
		const words = title.split(' ');
		for (let i = 0; i < words.length; i++) c2.fillText(words[i], 128, 70 + i * 46);
		c2.font = 'bold 22px Arial, sans-serif';
		c2.fillText(sub, 128, 90 + words.length * 46);
	}
	const mat = new THREE.MeshLambertMaterial({ map: cv ? new THREE.CanvasTexture(cv) : null, alphaTest: 0.3, transparent: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
	try { core.w.sky.csm.setupMaterial(mat); } catch (e) { /* no csm */ }
	const m = new THREE.Mesh(g, mat);
	m.name = 'illegalBay';
	m.receiveShadow = true;
	m.matrixAutoUpdate = false;
	m.updateMatrix();
	core.w.graphicsWorld.add(m);
	return m;
}

/** World-space rectangle test for a car inside a bay (centre x,z, yaw rot, size w x d). */
export function inRect(px: number, pz: number, x: number, z: number, rot: number, w: number, d: number, margin: number = 0.4): boolean
{
	const dx = px - x, dz = pz - z;
	const lx = dx * Math.cos(rot) - dz * Math.sin(rot), lz = dx * Math.sin(rot) + dz * Math.cos(rot);
	return Math.abs(lx) < w / 2 + margin && Math.abs(lz) < d / 2 + margin;
}

/** Shows objects only within `range` metres of the player (cheap distance check, call ~2x per second). */
export class NearSet
{
	public items: { o: THREE.Object3D; x: number; z: number; r: number }[] = [];
	public add(o: THREE.Object3D, x: number, z: number, r: number): void { this.items.push({ o: o, x: x, z: z, r: r }); o.visible = false; }
	public update(p: THREE.Vector3): void
	{
		for (let i = 0; i < this.items.length; i++)
		{
			const it = this.items[i];
			const dx = it.x - p.x, dz = it.z - p.z;
			const v = !it.o.userData.hidden && dx * dx + dz * dz < it.r * it.r && p.y < 200;
			if (it.o.visible !== v) it.o.visible = v;
		}
	}
}

/** Instanced-safe material copy (three r113: one program per material). */
export function instMatSafe(ctx: RealismCtx, mat: THREE.Material): THREE.Material { try { return instMat(ctx, mat); } catch (e) { return mat; } }
