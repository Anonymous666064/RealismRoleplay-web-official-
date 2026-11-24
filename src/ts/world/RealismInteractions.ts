/*
 * RealismInteractions.ts
 * ----------------------
 * Using furniture in San Verano County (developer A14).
 *
 *  - Anchors: every bed, seat, toilet, shower, sink, fridge, stove, desk / laptop, lamp and wall light switch
 *    becomes an anchor while the interiors are built (AssetInstancer.add -> ctx.interactionSink, hotels call
 *    the sink for their room kit). Anchors are kept in a 6 m grid; the search runs 10x a second.
 *  - Within reach (about 1.5 m) and roughly facing one, a prompt shows (contract C7:
 *    realismPrompt.set('interact', [{ key: 'E', label: 'Sleep' }], { priority: 1 })) and E acts on it only
 *    while isActive('interact') (or when no realismPrompt exists: then a small own prompt is drawn).
 *  - Bed: lie down, the screen fades out, the clock skips up to 8 game hours or until morning
 *    (realismDayNight.setHour), energy restored, E / W gets up. Toilet: sit, bladder restored, flush.
 *    Shower: stand in the tub, water drops + sound, hygiene restored over a few seconds. Sink: wash hands
 *    (arms forward). Seats: sit at the right height for the scaled player; E or W/A/S/D stands up.
 *    Fridge: menu (Eat snack / Drink water / Drink soda). Stove: cook a meal (progress + sizzle).
 *    Light switch / lamp: toggles the room's lamps (glow instances collapsed, no new draw calls) and the
 *    room's pooled point light (its light spot is moved out of reach while off).
 *    Desk with laptop / computer: sit, the camera eases into the screen (0.8 s), then
 *    (world as any).realismLaptop?.open({ onClose, location }) (A15); on close it eases back, still seated.
 *    Missing realismLaptop: toast 'Laptop unavailable'.
 *  - Weapons are put away (fists, hidden) while using furniture.
 *
 * API: (world as any).realismInteractions = this (anchors, counts(), nearest, active, use(anchor), leave(),
 *      fridgeChoice(i), laptopClosed(), roomLights). (world as any).realismRoomLights = RoomLights.
 * Config: realism-config.js -> interactions (defaults in DEFAULT_INTERACTIONS below).
 * Respects realismPaused (frozen) and realismUIBlocking (E ignored). No allocations per frame in the hot path.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { deepMerge } from './RealismConfig';
import { FURNITURE } from './RealismInteriors';
import { Idle } from '../characters/character_states/_stateLibrary';
import { RealismPose, RealismPoseKind } from '../characters/character_states/RealismStates';
import { realismToast } from './RealismNeeds';
import { sfxFor, RealismSfx } from './RealismSfx';
import { RoomLights } from './RealismRoomLights';
import { CollisionGroups } from '../enums/CollisionGroups';

export const DEFAULT_INTERACTIONS = {
	enabled: true,
	reach: 1.5,              // metres from the furniture's edge
	wakeHour: 7,             // sleeping skips to this hour ...
	maxSleepHours: 8,        // ... or at most this many game hours
	energyPerSleepHour: 12.5,
	showerSeconds: 6,
	washSeconds: 2.5,
	cookSeconds: 5,
	toiletSeconds: 3,
	laptopZoomSeconds: 0.8,
	fridge: {                // menu items: need gains (cost 0)
		snack: { hunger: 20, thirst: -3 },
		water: { thirst: 35, bladder: -10 },
		soda: { thirst: 22, hunger: 5, energy: 6, bladder: -8 },
	},
	cookGain: { hunger: 50, thirst: -5 },
	sinkGain: 15,
};

// pose heights (multiplied by the player scale): character origin above the seat / mattress / floor
const SIT_K = 0.505;      // 'sitting' clip: hips 0.52 x scale below the origin (measured at scale 1.7)
const LIE_K = 0.085;      // back of the body below the origin when lying
const STAND_K = 0.57;     // capsule centre above the feet

export interface Anchor
{
	type: string;            // bed seat toilet shower sink fridge stove switch lamp laptop computer desk
	name: string;            // furniture name
	x: number; z: number; y: number;   // footprint centre (floor level y)
	ry: number; hw: number; hd: number;
	room: number;
	pose: string;            // sit | lie | stand | none
	px: number; pz: number; top: number;  // pose point (feet / seat / mattress surface height in `top`)
	yaw: number;             // character facing while using
	ex: number; ez: number;  // where to stand when getting up
	sx: number; sy: number; sz: number;   // screen centre (laptop / computer) or shower head
	nx: number; nz: number;               // screen normal (towards the user)
	prio: number;
	paired?: Anchor;
}

function A(): Anchor
{
	return { type: '', name: '', x: 0, z: 0, y: 0, ry: 0, hw: 0.3, hd: 0.3, room: -1, pose: 'none', px: 0, pz: 0, top: 0, yaw: 0, ex: 0, ez: 0, sx: 0, sy: 0, sz: 0, nx: 0, nz: 1, prio: 1 };
}

// seats: [seatTop, seatLocalZ, xs...]
const SEATS: { [name: string]: number[] } = {
	chair: [0.485, 0.02, 0],
	couch: [0.49, 0.06, -0.55, 0, 0.55],
	armchair: [0.49, 0.06, 0],
	officeChair: [0.52, 0, 0],
	barStool: [0.77, 0, 0],
	bench: [0.48, 0.05, -0.7, 0, 0.7],
	booth: [0.51, 0.05, -0.35, 0.35],
	seatRow: [0.48, 0.05, -0.93, -0.31, 0.31, 0.93],
	barberChair: [0.575, 0.05, 0],
};
const BEDS: { [name: string]: number } = { bed: 0.56, mattress: 0.22, bunkBed: 0.5, hospitalBed: 0.76 };

// ---------------------------------------------------------------------------
// Anchor store
// ---------------------------------------------------------------------------

const CELL = 6;

export class AnchorStore
{
	public list: Anchor[] = [];
	private grid: { [key: number]: Anchor[] } = {};
	public roomCeil: { room: number; x: number; y: number; z: number }[] = [];
	public roomSpots: { room: number; spot: number }[] = [];

	private key(ix: number, iz: number): number { return (ix + 4096) * 8192 + (iz + 4096); }

	public add(a: Anchor): void
	{
		this.list.push(a);
		const k = this.key(Math.floor(a.x / CELL), Math.floor(a.z / CELL));
		let c = this.grid[k];
		if (!c) { c = []; this.grid[k] = c; }
		c.push(a);
	}

	public cell(ix: number, iz: number): Anchor[] { return this.grid[this.key(ix, iz)]; }

	/** World point of local (lx, ly, lz) in a placement frame (same convention as RealismGeometry.Frame). */
	public static wp(p: any, lx: number, lz: number, out: number[]): number[]
	{
		const c = Math.cos(p.ry), s = Math.sin(p.ry);
		out[0] = p.x + lx * c + lz * s;
		out[1] = p.z - lx * s + lz * c;
		return out;
	}

	/** Builds the anchors of one placed furniture item. dims overrides the item size (hotel kit). */
	public fromItem(name: string, p: any, variant: number, dims?: any): void
	{
		const it = FURNITURE[name] || { w: 0.5, d: 0.5, h: 1 };
		const d = dims || {};
		const W = d.w || it.w, D = d.d || it.d;
		const room = typeof p.room === 'number' ? p.room : -1;
		const t = [0, 0];
		const base = (type: string, pose: string): Anchor =>
		{
			const a = A();
			a.type = type; a.name = name; a.x = p.x; a.z = p.z; a.y = p.y; a.ry = p.ry; a.hw = W / 2; a.hd = D / 2; a.room = room; a.pose = pose;
			return a;
		};
		if (name === 'ceilingLight') { this.roomCeil.push({ room: room, x: p.x, y: p.y, z: p.z }); return; }
		if (name === 'roomSpot') { this.roomSpots.push({ room: room, spot: d.spot }); return; }
		if (SEATS[name])
		{
			const sd = SEATS[name];
			const top = d.top || sd[0];
			const n = sd.length - 2;
			for (let i = 0; i < n; i++)
			{
				const a = base('seat', 'sit');
				AnchorStore.wp(p, sd[2 + i], sd[1], t);
				a.x = t[0]; a.z = t[1];
				a.hw = n > 1 ? Math.min(0.32, W / n / 2) : W / 2;
				a.px = t[0]; a.pz = t[1]; a.top = p.y + top; a.yaw = p.ry;
				AnchorStore.wp(p, sd[2 + i], D / 2 + 0.45, t);
				a.ex = t[0]; a.ez = t[1];
				a.prio = 1;
				this.add(a);
			}
			return;
		}
		if (BEDS[name] !== undefined)
		{
			const a = base('bed', 'lie');
			const top = d.top || BEDS[name];
			AnchorStore.wp(p, 0, -0.1, t);
			a.px = t[0]; a.pz = t[1]; a.top = p.y + top; a.yaw = p.ry;
			AnchorStore.wp(p, W / 2 + 0.45, 0.2, t);
			a.ex = t[0]; a.ez = t[1];
			a.prio = 0.6;
			this.add(a);
			return;
		}
		switch (name)
		{
			case 'toilet':
			{
				const a = base('toilet', 'sit');
				AnchorStore.wp(p, 0, d.z !== undefined ? d.z : 0.14, t);
				a.px = t[0]; a.pz = t[1]; a.top = p.y + (d.top || 0.43); a.yaw = p.ry;
				AnchorStore.wp(p, 0, (d.z !== undefined ? d.z : 0.14) + 0.6, t);
				a.ex = t[0]; a.ez = t[1];
				a.prio = 1.2;
				this.add(a);
				return;
			}
			case 'bathSink':
			case 'sink':
			case 'fridge':
			case 'stove':
			{
				const type = name === 'bathSink' ? 'sink' : name;
				const a = base(type, name === 'fridge' ? 'none' : 'stand');
				const off = name === 'fridge' ? 0.5 : 0.42;
				AnchorStore.wp(p, 0, D / 2 + off, t);
				a.px = t[0]; a.pz = t[1]; a.top = p.y; a.yaw = p.ry + Math.PI;
				a.ex = t[0]; a.ez = t[1];
				a.prio = 1.1;
				this.add(a);
				return;
			}
			case 'bathtub':
			{
				const a = base('shower', 'stand');
				AnchorStore.wp(p, 0.15, 0, t);
				a.px = t[0]; a.pz = t[1]; a.top = p.y + (d.floor !== undefined ? d.floor : 0.12); a.yaw = p.ry + Math.PI;
				AnchorStore.wp(p, 0.15, D / 2 + 0.5, t);
				a.ex = t[0]; a.ez = t[1];
				const hl = d.head || [-W / 2 + 0.12, 1.9, -D / 2 + 0.3];
				AnchorStore.wp(p, hl[0], hl[2], t);
				a.sx = t[0]; a.sy = p.y + hl[1]; a.sz = t[1];
				a.prio = 1;
				this.add(a);
				return;
			}
			case 'desk':
			case 'laptop':
			{
				const isLaptop = name === 'laptop';
				const type = isLaptop ? 'laptop' : (variant === 2 ? 'desk' : 'computer');
				const a = base(type, 'sit');
				const deskH = isLaptop ? (d.deskH || 0.76) : it.h;
				a.y = p.y - (isLaptop ? deskH : 0);
				if (isLaptop) { a.hw = 0.45; a.hd = 0.4; }
				// default seat in front (+z) of it; paired with the nearest chair in finalize()
				AnchorStore.wp(p, 0, (isLaptop ? 0.08 : D / 2) + 0.42, t);
				a.px = t[0]; a.pz = t[1]; a.top = a.y + 0.5; a.yaw = p.ry + Math.PI;
				AnchorStore.wp(p, 0, (isLaptop ? 0.08 : D / 2) + 0.95, t);
				a.ex = t[0]; a.ez = t[1];
				if (isLaptop)
				{
					AnchorStore.wp(p, 0, -0.105, t);
					a.sx = t[0]; a.sy = p.y + 0.135; a.sz = t[1];
				}
				else
				{
					AnchorStore.wp(p, 0.1, -0.135, t);
					a.sx = t[0]; a.sy = p.y + it.h + 0.22; a.sz = t[1];
				}
				a.nx = Math.sin(p.ry); a.nz = Math.cos(p.ry);
				a.prio = isLaptop ? 1.6 : (type === 'computer' ? 1.3 : 0.9);
				this.add(a);
				return;
			}
			case 'floorLamp':
			case 'nightstand':
			{
				if (room < 0) return;
				const a = base('lamp', 'none');
				a.prio = 0.8;
				AnchorStore.wp(p, 0, D / 2 + 0.5, t);
				a.ex = a.px = t[0]; a.ez = a.pz = t[1]; a.yaw = p.ry + Math.PI;
				this.add(a);
				return;
			}
			case 'lightSwitch':
			{
				if (room < 0) return;
				const a = base('switch', 'none');
				a.hw = 0.25; a.hd = 0.15;
				a.prio = 1.4;
				AnchorStore.wp(p, 0, 0.7, t);   // where you stand to reach it (local +z points into the room)
				a.ex = a.px = t[0]; a.ez = a.pz = t[1]; a.yaw = p.ry + Math.PI;
				this.add(a);
				return;
			}
		}
	}

	/** Pairs desks / laptops with the nearest chair (sit there, facing the screen). */
	public finalize(): void
	{
		for (let i = 0; i < this.list.length; i++)
		{
			const a = this.list[i];
			if (a.type !== 'laptop' && a.type !== 'computer' && a.type !== 'desk') continue;
			let best: Anchor = null, bd = 1.5 * 1.5;
			const ix = Math.floor(a.x / CELL), iz = Math.floor(a.z / CELL);
			for (let dx = -1; dx <= 1; dx++)
				for (let dz = -1; dz <= 1; dz++)
				{
					const c = this.cell(ix + dx, iz + dz);
					if (!c) continue;
					for (let k = 0; k < c.length; k++)
					{
						const s = c[k];
						if (s.type !== 'seat' || (s.name !== 'officeChair' && s.name !== 'chair') || Math.abs(s.y - a.y) > 0.5) continue;
						const ddx = s.px - a.x, ddz = s.pz - a.z, dd = ddx * ddx + ddz * ddz;
						if (dd < bd) { bd = dd; best = s; }
					}
				}
			if (best !== null)
			{
				a.px = best.px; a.pz = best.pz; a.top = best.top;
				a.paired = best;
			}
			// face the screen (or the desk centre)
			const tx = a.type === 'desk' ? a.x : a.sx, tz = a.type === 'desk' ? a.z : a.sz;
			a.yaw = Math.atan2(tx - a.px, tz - a.pz);
			const len = Math.sqrt((a.px - a.sx) * (a.px - a.sx) + (a.pz - a.sz) * (a.pz - a.sz)) || 1;
			a.nx = (a.px - a.sx) / len; a.nz = (a.pz - a.sz) / len;
			// get up backwards, away from the desk
			a.ex = a.px + Math.sin(a.yaw) * -0.55; a.ez = a.pz + Math.cos(a.yaw) * -0.55;
		}
	}

	public counts(): { [type: string]: number }
	{
		const out: { [type: string]: number } = {};
		for (let i = 0; i < this.list.length; i++) out[this.list[i].type] = (out[this.list[i].type] || 0) + 1;
		return out;
	}
}

/** Creates the anchor store and the sink the furniture builders call. Hook: before buildInteriors(). */
export function installInteractionSink(ctx: RealismCtx): AnchorStore
{
	const store = new AnchorStore();
	const user = (ctx.cfg as any).interactions;
	if (user && user.enabled === false) return store;
	(ctx as any).interactionStore = store;
	(ctx as any).interactionSink = (name: string, p: any, variant: number, dims?: any) =>
	{
		try { store.fromItem(name, p, variant || 0, dims); }
		catch (e) { /* never break the world build */ }
	};
	return store;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

interface Session
{
	a: Anchor;
	kind: string;           // the anchor type
	phase: string;          // pose | timed | sleepOut | sleepHold | sleepIn | idle | zoomIn | open | zoomOut
	t: number;
	dur: number;
	state: RealismPose;
	gained: number;
	prevWeapon: number;
}

const ITEMS: { [k: string]: any[] } = {};
function items(key: string, label: string, key2?: string, label2?: string): any[]
{
	const id = key + label + (key2 || '') + (label2 || '');
	let v = ITEMS[id];
	if (!v) { v = [{ key: key, label: label }]; if (key2) v.push({ key: key2, label: label2 }); ITEMS[id] = v; }
	return v;
}

const LABEL: { [type: string]: string } = {
	bed: 'Sleep', seat: 'Sit', toilet: 'Use toilet', shower: 'Take a shower', sink: 'Wash hands', fridge: 'Open fridge',
	stove: 'Cook a meal', laptop: 'Use laptop', computer: 'Use computer', desk: 'Sit at desk',
};

export class InteractionSystem implements IUpdatable
{
	public updateOrder: number = 4.7;   // after the camera (4) and first person (4.5), before rendering
	public settings: any;
	public store: AnchorStore;
	public roomLights: RoomLights;
	public nearest: Anchor = null;
	public active: Session = null;
	public sfx: RealismSfx;
	public stats = { uses: 0, sleeps: 0, hoursSlept: 0, laptopOpens: 0, laptopCloses: 0, toggles: 0, fridge: 0 };

	private world: any;
	private ctx: RealismCtx;
	private acc = 0;
	private lastItems: any[] = null;
	private ownPrompt: any = null;
	private fade: any = null;
	private fadeLevel = 0;
	private menu: any = null;
	private menuOpen = false;
	private hadLock = false;
	private handlers: { target: any; type: string; fn: any }[] = [];
	private bones: { [name: string]: THREE.Bone } = {};
	private bonesOf: any = null;
	private qx = new THREE.Quaternion();
	private ax = new THREE.Vector3(1, 0, 0);
	// camera zoom
	private camFromP = new THREE.Vector3();
	private camFromQ = new THREE.Quaternion();
	private camToP = new THREE.Vector3();
	private camToQ = new THREE.Quaternion();
	private tmpQ = new THREE.Quaternion();
	private tmpM = new THREE.Matrix4();
	private tmpV = new THREE.Vector3();
	private up = new THREE.Vector3(0, 1, 0);
	public camBlend = 0;            // 0 = normal camera, 1 = at the screen (tests)
	private modelHidden = false;
	// shower drops
	private drops: THREE.Points = null;
	private dropV: Float32Array = null;
	// raycast
	private rayRes = new CANNON.RaycastResult();
	private rayFrom = new CANNON.Vec3();
	private rayTo = new CANNON.Vec3();

	constructor(ctx: RealismCtx, store: AnchorStore, furniture: any)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		this.store = store;
		const user = (ctx.cfg as any).interactions;
		this.settings = deepMerge(DEFAULT_INTERACTIONS, user && typeof user === 'object' ? user : {});
		store.finalize();
		this.roomLights = new RoomLights(ctx, store, furniture);
		this.sfx = sfxFor(this.world);
		this.world.realismInteractions = this;
		this.world.realismRoomLights = this.roomLights;
		this.bind();
		const c = store.counts();
		console.log('[Realism] Interactions: ' + store.list.length + ' anchors', c);
	}

	public counts(): { [type: string]: number } { return this.store.counts(); }

	private bind(): void
	{
		try
		{
			if (typeof window === 'undefined') return;
			const fn = (e: KeyboardEvent) => this.onKey(e);
			window.addEventListener('keydown', fn, false);
			this.handlers.push({ target: window, type: 'keydown', fn: fn });
		}
		catch (e) { /* headless */ }
	}

	// -------------------------------------------------------------------- input

	private blocked(): boolean
	{
		const w = this.world;
		return w.realismPaused === true || w.realismUIBlocking === true;
	}

	public onKey(e: any): void
	{
		if (this.menuOpen)
		{
			const k = e.code;
			if (k === 'Digit1' || k === 'Numpad1') { this.fridgeChoice(0); e.preventDefault && e.preventDefault(); }
			else if (k === 'Digit2' || k === 'Numpad2') { this.fridgeChoice(1); e.preventDefault && e.preventDefault(); }
			else if (k === 'Digit3' || k === 'Numpad3') { this.fridgeChoice(2); e.preventDefault && e.preventDefault(); }
			else if (k === 'Escape' || k === 'KeyE') { this.fridgeChoice(-1); e.preventDefault && e.preventDefault(); }
			return;
		}
		if (e.code !== 'KeyE' || e.repeat) return;
		if (this.blocked()) return;
		this.pressE();
	}

	/** E pressed (also callable from tests). */
	public pressE(): boolean
	{
		if (this.blocked() || this.settings.enabled === false) return false;
		const s = this.active;
		if (s !== null)
		{
			if (!this.promptActive()) return false;
			if (s.phase === 'zoomIn' || s.phase === 'open' || s.phase === 'zoomOut' || s.phase.indexOf('sleep') === 0) return false;
			if (s.phase === 'timed') { this.finishTimed(true); return true; }
			if ((s.kind === 'laptop' || s.kind === 'computer') && s.phase === 'idle') { this.startZoom(); return true; }
			this.leave();
			return true;
		}
		const a = this.nearest;
		if (a === null || !this.promptActive()) return false;
		this.use(a);
		return true;
	}

	private promptActive(): boolean
	{
		const p = this.world.realismPrompt;
		if (p && typeof p.isActive === 'function') return p.isActive('interact') === true;
		return true;
	}

	// ------------------------------------------------------------------ prompt

	private promptAnchor = new THREE.Vector3();
	private lastNear: Anchor | null = null;
	/** `near`: a nearby furniture anchor. v14: same priority as doors, so the closer one wins
	 *  the shared [E] key (a light switch beside a door no longer hides the door's prompt). */
	private setPrompt(it: any[], near?: Anchor): void
	{
		if (it === this.lastItems && (near || null) === this.lastNear) return;
		this.lastItems = it;
		this.lastNear = near || null;
		const p = this.world.realismPrompt;
		if (p && typeof p.set === 'function')
		{
			const opts: any = near ? { priority: 0, anchor: this.promptAnchor.set(near.x, near.y + 1, near.z) } : { priority: 1 };
			try { p.set('interact', it, opts); } catch (e) { /* prompt error */ }
			return;
		}
		this.drawOwnPrompt(it);
	}

	private progress(t: number): void
	{
		const p = this.world.realismPrompt;
		if (p && typeof p.progress === 'function') { try { p.progress('interact', t); } catch (e) { /* prompt error */ } }
		else if (this.ownPrompt) this.ownPrompt.bar.style.width = Math.round(t * 100) + '%';
	}

	/** Small stand-in prompt, only when A12's realismPrompt doesn't exist. */
	private drawOwnPrompt(it: any[]): void
	{
		try
		{
			if (typeof document === 'undefined' || !document.body) return;
			if (!this.ownPrompt)
			{
				const el = document.createElement('div');
				el.style.cssText = 'position:fixed;right:28%;bottom:22%;z-index:45;pointer-events:none;font:600 15px system-ui,sans-serif;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6)';
				const txt = document.createElement('div');
				const bw = document.createElement('div');
				bw.style.cssText = 'margin-top:6px;height:4px;width:140px;background:rgba(255,255,255,.2);border-radius:2px;overflow:hidden';
				const bar = document.createElement('div');
				bar.style.cssText = 'height:100%;width:0;background:#fff';
				bw.appendChild(bar);
				el.appendChild(txt); el.appendChild(bw);
				document.body.appendChild(el);
				this.ownPrompt = { el: el, txt: txt, bar: bar };
			}
			const o = this.ownPrompt;
			if (!it || it.length === 0) { o.el.style.display = 'none'; return; }
			let h = '';
			for (let i = 0; i < it.length; i++)
				h += '<div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="display:inline-flex;width:26px;height:26px;border-radius:50%;background:rgba(10,12,16,.7);align-items:center;justify-content:center;border:2px solid rgba(255,255,255,.6)">' + it[i].key + '</span>' + it[i].label + '</div>';
			o.txt.innerHTML = h;
			o.bar.style.width = '0';
			o.el.style.display = 'block';
		}
		catch (e) { /* headless */ }
	}

	// ------------------------------------------------------------------ update

	private player(): any
	{
		const w = this.world;
		const r = w.inputManager && w.inputManager.inputReceiver;
		if (!r || r.characterCapsule === undefined) return null;
		if (r.occupyingSeat || r.controlledObject !== undefined || r.vehicleEntryInstance) return null;
		return r;
	}

	private scale(ch: any): number
	{
		const s = Number(ch && ch.playerScale);
		return s > 0 ? s : (Number(this.world.realismPlayerScale) || 1);
	}

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		const w = this.world;
		if (w.realismPaused === true) return;
		const dt = Math.min(0.1, Math.max(0, unscaledTimeStep !== undefined ? unscaledTimeStep : timeStep));
		this.updateFade(dt);
		this.updateDrops(dt);
		const s = this.active;
		if (s !== null) { this.updateSession(s, dt); return; }
		if (this.settings.enabled === false) { this.setPrompt(null); return; }
		this.acc += dt;
		if (this.acc < 0.1) return;
		this.acc = 0;
		const ch = this.player();
		const swim = w.realismSwim;
		if (ch === null || !ch.physicsEnabled || (swim && swim.active) || w.realismUIBlocking === true) { this.nearest = null; this.setPrompt(null); return; }
		this.nearest = this.find(ch);
		const a = this.nearest;
		if (a === null) { this.setPrompt(null); return; }
		if (a.type === 'switch' || a.type === 'lamp') this.setPrompt(items('E', this.roomLights.isOn(a.room) ? 'Lights off' : 'Lights on'), a);
		else this.setPrompt(items('E', LABEL[a.type] || 'Use'), a);
	}

	/** Best anchor in reach that the character roughly faces. */
	public find(ch: any): Anchor
	{
		const sc = this.scale(ch);
		const px = ch.position.x, pz = ch.position.z, feet = ch.position.y - STAND_K * sc;
		const reach = Number(this.settings.reach) || 1.5;
		const ox = ch.orientation ? ch.orientation.x : 0, oz = ch.orientation ? ch.orientation.z : 1;
		const ix = Math.floor(px / CELL), iz = Math.floor(pz / CELL);
		let best: Anchor = null, bs = 1e9;
		for (let dx = -1; dx <= 1; dx++)
			for (let dz = -1; dz <= 1; dz++)
			{
				const c = this.store.cell(ix + dx, iz + dz);
				if (!c) continue;
				for (let k = 0; k < c.length; k++)
				{
					const a = c[k];
					if (Math.abs(feet - a.y) > 1.0) continue;
					// distance to the footprint rectangle
					const cs = Math.cos(a.ry), sn = Math.sin(a.ry);
					const rx = px - a.x, rz = pz - a.z;
					const lx = rx * cs - rz * sn, lz = rx * sn + rz * cs;
					const qx = Math.max(-a.hw, Math.min(a.hw, lx)), qz = Math.max(-a.hd, Math.min(a.hd, lz));
					const ddx = lx - qx, ddz = lz - qz;
					const d = Math.sqrt(ddx * ddx + ddz * ddz);
					if (d > reach) continue;
					// facing: direction to the closest point (world)
					const cwx = a.x + qx * cs + qz * sn, cwz = a.z - qx * sn + qz * cs;
					let fx = cwx - px, fz = cwz - pz;
					const fl = Math.sqrt(fx * fx + fz * fz);
					let dot = 1;
					if (fl > 0.25) { fx /= fl; fz /= fl; dot = fx * ox + fz * oz; }
					if (dot < 0.25) continue;
					const score = d - a.prio * 0.35 - dot * 0.4;
					if (score < bs) { bs = score; best = a; }
				}
			}
		return best;
	}

	// ----------------------------------------------------------------- actions

	/** Starts using an anchor (E). */
	public use(a: Anchor): boolean
	{
		const ch = this.player();
		if (ch === null || this.active !== null) return false;
		this.stats.uses++;
		if (a.type === 'switch' || a.type === 'lamp')
		{
			this.roomLights.toggle(a.room);
			this.stats.toggles++;
			this.sfx.click();
			this.lastItems = null;
			this.acc = 1;
			return true;
		}
		if (a.type === 'fridge') { this.openFridge(); return true; }
		const s: Session = { a: a, kind: a.type, phase: 'pose', t: 0, dur: 0, state: null, gained: 0, prevWeapon: -1 };
		this.active = s;
		this.putAwayWeapon(s);
		this.enterPose(ch, s);
		const S = this.settings;
		switch (a.type)
		{
			case 'bed': s.phase = 'sleepOut'; s.t = 0; this.setPrompt(null); this.stats.sleeps++; break;
			case 'toilet': this.startTimed(s, Number(S.toiletSeconds) || 3, 'Using the toilet'); break;
			case 'shower': this.startTimed(s, Number(S.showerSeconds) || 6, 'Showering'); this.sfx.loop('shower', true); break;
			case 'sink': this.startTimed(s, Number(S.washSeconds) || 2.5, 'Washing hands'); break;
			case 'stove': this.startTimed(s, Number(S.cookSeconds) || 5, 'Cooking'); this.sfx.loop('sizzle', true); break;
			case 'laptop':
			case 'computer': s.phase = 'idle'; this.startZoom(); break;
			default: s.phase = 'idle'; this.seatedPrompt(s); break;
		}
		return true;
	}

	private seatedPrompt(s: Session): void
	{
		if (s.kind === 'laptop') this.setPrompt(items('E', 'Use laptop', 'W', 'Stand up'));
		else if (s.kind === 'computer') this.setPrompt(items('E', 'Use computer', 'W', 'Stand up'));
		else if (s.kind === 'bed') this.setPrompt(items('E', 'Get up'));
		else this.setPrompt(items('E', 'Stand up'));
	}

	private startTimed(s: Session, dur: number, label: string): void
	{
		s.phase = 'timed'; s.t = 0; s.dur = dur; s.gained = 0;
		this.setPrompt(items('E', 'Stop'));
		realismToast(label + '...', Math.min(2000, dur * 1000));
	}

	private enterPose(ch: any, s: Session): void
	{
		const a = s.a, sc = this.scale(ch);
		const kind: RealismPoseKind = a.pose === 'lie' ? 'lie' : a.pose === 'sit' ? 'sit' : 'stand';
		ch.setPhysicsEnabled(false);
		let y = a.top + STAND_K * sc;
		if (kind === 'sit') y = a.top + SIT_K * sc;
		else if (kind === 'lie') y = a.top + LIE_K * sc;
		ch.setPosition(a.px, y, a.pz);
		ch.setOrientation(this.tmpV.set(Math.sin(a.yaw), 0, Math.cos(a.yaw)), true);
		ch.lookAt(a.px + Math.sin(a.yaw), y, a.pz + Math.cos(a.yaw));
		ch.tiltContainer.rotation.set(kind === 'lie' ? -Math.PI / 2 : 0, 0, 0);
		ch.tiltContainer.position.set(0, 0, 0);
		ch.realismEyeDrop = kind === 'sit' ? -0.5 * sc / 1.7 : kind === 'lie' ? -0.45 * sc / 1.7 : 0;
		const st = new RealismPose(ch, kind);
		st.onLeave = () => this.onMoveKey();
		ch.setState(st);
		s.state = st;
		ch.updateMatrixWorld(true);
	}

	private onMoveKey(): void
	{
		const s = this.active;
		if (s === null || this.blocked()) { if (s && s.state) s.state.onLeave = () => this.onMoveKey(); return; }
		if (s.phase === 'timed') { this.finishTimed(true); return; }
		if (s.phase === 'idle') { this.leave(); return; }
		s.state.onLeave = () => this.onMoveKey();   // busy (sleeping / laptop): ignore
	}

	/** Gets up / steps away and ends the current interaction. */
	public leave(): void
	{
		const s = this.active;
		if (s === null) return;
		this.active = null;
		this.sfx.loop('shower', false);
		this.sfx.loop('sizzle', false);
		this.restoreCamera();
		const ch = this.player() || (s.state ? s.state.character : null);
		if (ch && ch.charState === s.state)
		{
			const sc = this.scale(ch);
			let ex = s.a.ex, ez = s.a.ez;
			if (s.kind === 'bed') { const e = this.bedExit(s.a, ch); ex = e[0]; ez = e[1]; }
			ch.tiltContainer.rotation.set(0, 0, 0);
			ch.realismEyeDrop = 0;
			ch.setPhysicsEnabled(true);
			ch.setPosition(ex, s.a.y + STAND_K * sc + 0.05, ez);
			ch.resetVelocity();
			ch.setOrientation(this.tmpV.set(Math.sin(s.a.yaw), 0, Math.cos(s.a.yaw)), true);
			ch.setState(new Idle(ch));
		}
		else if (ch)
		{
			ch.tiltContainer.rotation.x = 0;
			ch.realismEyeDrop = 0;
		}
		this.restoreWeapon(s);
		this.lastItems = null;
		this.setPrompt(null);
		this.acc = 1;
	}

	/** Side of the bed that isn't against a wall. */
	private bedExit(a: Anchor, ch: any): number[]
	{
		const pw = this.world.physicsWorld;
		const c = Math.cos(a.ry), sn = Math.sin(a.ry);
		const y = a.y + 1.0;
		for (let side = 1; side >= -1; side -= 2)
		{
			const lx = side * (a.hw + 0.45);
			const x = a.x + lx * c + 0.2 * sn, z = a.z - lx * sn + 0.2 * c;
			if (!pw || typeof pw.raycastClosest !== 'function') return [x, z];
			this.rayFrom.set(a.x + 0.2 * sn, y, a.z + 0.2 * c);
			this.rayTo.set(a.x + (lx + side * 0.35) * c + 0.2 * sn, y, a.z - (lx + side * 0.35) * sn + 0.2 * c);
			this.rayRes.reset();
			const hit = pw.raycastClosest(this.rayFrom, this.rayTo, { collisionFilterMask: CollisionGroups.Default, skipBackfaces: true }, this.rayRes);
			if (!hit) return [x, z];
		}
		return [a.ex, a.ez];
	}

	private putAwayWeapon(s: Session): void
	{
		const wp = this.world.realismWeapons;
		if (!wp || typeof wp.equipById !== 'function') return;
		s.prevWeapon = typeof wp.current === 'number' ? wp.current : -1;
		try { wp.equipById('fists'); } catch (e) { /* weapons optional */ }
	}

	private restoreWeapon(s: Session): void
	{
		const wp = this.world.realismWeapons;
		if (!wp || s.prevWeapon < 0 || typeof wp.equip !== 'function') return;
		try { wp.equip(s.prevWeapon); } catch (e) { /* weapons optional */ }
	}

	// ---------------------------------------------------------------- session

	private updateSession(s: Session, dt: number): void
	{
		const ch = s.state ? s.state.character : null;
		if (!ch || ch.charState !== s.state)
		{
			// something else took over the character (respawn, teleport): just forget the interaction
			this.active = null;
			this.sfx.stopAll();
			this.restoreCamera();
			if (ch) { ch.tiltContainer.rotation.x = 0; ch.realismEyeDrop = 0; }
			this.setPrompt(null);
			return;
		}
		// weapons stay hidden
		const wp = this.world.realismWeapons;
		if (wp && wp.root) wp.root.visible = false;
		s.t += dt;
		switch (s.phase)
		{
			case 'timed':
			{
				const k = Math.min(1, s.t / s.dur);
				this.progress(k);
				this.applyGain(s, k);
				if (s.kind === 'sink' || s.kind === 'stove') this.armsForward(ch, s.kind === 'stove' ? 0.9 : 1.15, s.t);
				if (s.kind === 'shower') this.showerDrops(s.a);
				if (k >= 1) this.finishTimed(false);
				break;
			}
			case 'sleepOut':
				this.fadeTo(1);
				if (s.t > 0.9) { this.doSleep(s); s.phase = 'sleepHold'; s.t = 0; }
				break;
			case 'sleepHold':
				if (s.t > 0.7) { s.phase = 'sleepIn'; s.t = 0; this.fadeTo(0); }
				break;
			case 'sleepIn':
				if (s.t > 0.9)
				{
					s.phase = 'idle';
					const n = this.world.realismNeeds;
					if (n && n.system) n.system.sleeping = false;
					this.seatedPrompt(s);
				}
				break;
			case 'zoomIn':
			case 'open':
			case 'zoomOut':
				this.updateZoom(s, ch);
				break;
		}
	}

	/** Gains spread over the timed action (partial when stopped early). */
	private applyGain(s: Session, k: number): void
	{
		const n = this.world.realismNeeds;
		if (!n) return;
		const step = k - s.gained;
		if (step <= 0) return;
		s.gained = k;
		const S = this.settings;
		if (s.kind === 'shower') n.add('hygiene', 100 * step);
		else if (s.kind === 'sink') n.add('hygiene', (Number(S.sinkGain) || 15) * step);
		else if (s.kind === 'toilet') n.add('bladder', 100 * step);
		else if (s.kind === 'stove') { const g = S.cookGain || {}; for (const key in g) if (g.hasOwnProperty(key)) n.add(key, Number(g[key]) * step); }
	}

	private finishTimed(early: boolean): void
	{
		const s = this.active;
		if (s === null || s.phase !== 'timed') return;
		this.progress(0);
		this.sfx.loop('shower', false);
		this.sfx.loop('sizzle', false);
		if (s.kind === 'toilet')
		{
			if (!early) this.applyGain(s, 1);
			this.sfx.flush();
			s.phase = 'idle';
			this.seatedPrompt(s);
			return;
		}
		if (s.kind === 'stove' && !early) realismToast('You cooked and ate a meal.');
		if (s.kind === 'shower' && !early) realismToast('Clean and fresh.');
		this.leave();
	}

	// ------------------------------------------------------------------ sleep

	private doSleep(s: Session): void
	{
		const w = this.world, S = this.settings;
		const t = w.realismTime;
		const hour = t && typeof t.hour === 'number' ? t.hour : 12;
		const wake = Number(S.wakeHour) || 7;
		let until = wake - hour;
		if (until <= 0.05) until += 24;
		const skip = Math.max(0, Math.min(Number(S.maxSleepHours) || 8, until));
		const needs = w.realismNeeds;
		if (needs && needs.system) needs.system.sleeping = true;
		if (needs && typeof needs.decay === 'function')
		{
			const sys = needs.system;
			needs.decay(skip, sys && sys.settings ? sys.settings.sleepRates : { energy: 0 });
			needs.add('energy', skip * (Number(S.energyPerSleepHour) || 12.5));
		}
		const nh = (hour + skip) % 24;
		const dn = w.realismDayNight;
		if (dn && typeof dn.setHour === 'function') dn.setHour(nh);
		else if (t) t.hour = nh;
		this.stats.hoursSlept += skip;
		const hh = Math.floor(nh), mm = Math.floor((nh - hh) * 60);
		realismToast('You slept ' + (Math.round(skip * 10) / 10) + ' h. It is ' + ((hh % 12) || 12) + ':' + (mm < 10 ? '0' : '') + mm + (hh < 12 ? ' AM' : ' PM') + '.', 3200);
	}

	private updateFade(dt: number): void
	{
		if (!this.fade) return;
		const target = this.fade.target;
		if (this.fadeLevel === target) return;
		const step = dt / 0.8;
		this.fadeLevel = target > this.fadeLevel ? Math.min(target, this.fadeLevel + step) : Math.max(target, this.fadeLevel - step);
		if (this.fade.el) { this.fade.el.style.opacity = String(this.fadeLevel); this.fade.el.style.display = this.fadeLevel > 0.001 ? 'block' : 'none'; }
	}

	private fadeTo(v: number): void
	{
		if (!this.fade)
		{
			this.fade = { el: null, target: 0 };
			try
			{
				if (typeof document !== 'undefined' && document.body)
				{
					const el = document.createElement('div');
					el.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:#000;opacity:0;display:none;z-index:55;pointer-events:none';
					document.body.appendChild(el);
					this.fade.el = el;
				}
			}
			catch (e) { /* headless */ }
		}
		this.fade.target = v;
	}

	public get fadeValue(): number { return this.fadeLevel; }

	// ----------------------------------------------------------------- fridge

	private openFridge(): void
	{
		this.stats.fridge++;
		this.sfx.fridge();
		this.menuOpen = true;
		this.setPrompt(null);
		const w = this.world;
		try
		{
			if (typeof document === 'undefined' || !document.body) return;
			if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking('fridge', true);
			this.hadLock = !!(document as any).pointerLockElement;
			if (this.hadLock && document.exitPointerLock) document.exitPointerLock();
			if (!this.menu)
			{
				const el = document.createElement('div');
				el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:58;background:rgba(14,16,22,.9);color:#fff;border-radius:14px;padding:14px 16px;min-width:230px;font:600 15px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45)';
				const opts = ['Eat snack', 'Drink water', 'Drink soda'];
				let h = '<div style="font-size:13px;opacity:.7;margin-bottom:8px">FRIDGE</div>';
				for (let i = 0; i < opts.length; i++)
					h += '<div data-i="' + i + '" style="cursor:pointer;padding:8px 10px;margin:4px 0;border-radius:8px;background:rgba(255,255,255,.08)"><span style="opacity:.6;margin-right:8px">' + (i + 1) + '</span>' + opts[i] + '</div>';
				h += '<div data-i="-1" style="cursor:pointer;padding:6px 10px;margin-top:8px;font-size:13px;opacity:.7">Esc  Close</div>';
				el.innerHTML = h;
				el.addEventListener('click', (e: any) =>
				{
					let t = e.target;
					while (t && t !== el && !t.getAttribute('data-i')) t = t.parentNode;
					if (t && t !== el) this.fridgeChoice(parseInt(t.getAttribute('data-i'), 10));
				});
				document.body.appendChild(el);
				this.menu = el;
			}
			this.menu.style.display = 'block';
		}
		catch (e) { /* headless */ }
	}

	public get fridgeOpen(): boolean { return this.menuOpen; }

	/** Fridge menu choice: 0 snack, 1 water, 2 soda, -1 close. */
	public fridgeChoice(i: number): void
	{
		if (!this.menuOpen) return;
		this.menuOpen = false;
		const n = this.world.realismNeeds, f = this.settings.fridge || {};
		const g = i === 0 ? f.snack : i === 1 ? f.water : i === 2 ? f.soda : null;
		if (g && n) for (const key in g) if (g.hasOwnProperty(key)) n.add(key, Number(g[key]) || 0);
		if (g) { if (i === 0) this.sfx.fridge(); else this.sfx.drink(); realismToast(i === 0 ? 'You ate a snack.' : i === 1 ? 'You drank some water.' : 'You drank a soda.'); }
		const w = this.world;
		try
		{
			if (this.menu) this.menu.style.display = 'none';
			if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking('fridge', false);
			if (this.hadLock && w.renderer && w.renderer.domElement && w.renderer.domElement.requestPointerLock) w.renderer.domElement.requestPointerLock();
		}
		catch (e) { /* headless */ }
		this.hadLock = false;
		this.lastItems = null;
		this.acc = 1;
	}

	// ------------------------------------------------------------ laptop zoom

	private startZoom(): void
	{
		const s = this.active;
		if (s === null) return;
		const cam: THREE.PerspectiveCamera = this.world.camera;
		if (!cam) return;
		this.camFromP.copy(cam.position);
		this.camFromQ.copy(cam.quaternion);
		this.screenPose(s.a, cam);
		s.phase = 'zoomIn'; s.t = 0;
		this.setPrompt(null);
	}

	/** Camera pose in front of the screen (camToP / camToQ). */
	private screenPose(a: Anchor, cam: THREE.PerspectiveCamera): void
	{
		const fov = (cam && cam.fov ? cam.fov : 70) * Math.PI / 180;
		const half = a.type === 'laptop' ? 0.12 : 0.2;
		const dist = Math.max(0.2, half / Math.tan(fov / 2) * 1.08);
		this.camToP.set(a.sx + a.nx * dist, a.sy + 0.01, a.sz + a.nz * dist);
		this.tmpV.set(a.sx, a.sy, a.sz);
		this.tmpM.lookAt(this.camToP, this.tmpV, this.up);
		this.camToQ.setFromRotationMatrix(this.tmpM);
	}

	private updateZoom(s: Session, ch: any): void
	{
		const cam: THREE.PerspectiveCamera = this.world.camera;
		if (!cam) return;
		const dur = Number(this.settings.laptopZoomSeconds) || 0.8;
		if (s.phase === 'zoomIn')
		{
			const k = Math.min(1, s.t / dur);
			const e = k * k * (3 - 2 * k);
			this.camBlend = e;
			cam.position.lerpVectors(this.camFromP, this.camToP, e);
			THREE.Quaternion.slerp(this.camFromQ, this.camToQ, cam.quaternion, e);
			this.hideModel(ch, e > 0.45);
			if (k >= 1) { s.phase = 'open'; s.t = 0; this.openLaptop(s); }
		}
		else if (s.phase === 'open')
		{
			this.camBlend = 1;
			cam.position.copy(this.camToP);
			cam.quaternion.copy(this.camToQ);
			this.hideModel(ch, true);
		}
		else
		{
			// ease from the screen back to wherever the normal camera is this frame
			const k = Math.min(1, s.t / dur);
			const e = k * k * (3 - 2 * k);
			this.camBlend = 1 - e;
			this.camFromP.copy(cam.position);
			this.camFromQ.copy(cam.quaternion);
			cam.position.lerpVectors(this.camToP, this.camFromP, e);
			THREE.Quaternion.slerp(this.camToQ, this.camFromQ, this.tmpQ, e);
			cam.quaternion.copy(this.tmpQ);
			this.hideModel(ch, e < 0.55);
			if (k >= 1)
			{
				s.phase = 'idle';
				this.camBlend = 0;
				this.hideModel(ch, false);
				this.seatedPrompt(s);
			}
		}
		cam.updateMatrixWorld();
	}

	private hideModel(ch: any, hide: boolean): void
	{
		if (!ch || !ch.modelContainer) return;
		ch.modelContainer.visible = !hide;
		this.modelHidden = hide;
	}

	private restoreCamera(): void
	{
		this.camBlend = 0;
		if (this.modelHidden)
		{
			const ch = this.active && this.active.state ? this.active.state.character : this.player();
			if (ch && ch.modelContainer) ch.modelContainer.visible = true;
			this.modelHidden = false;
		}
	}

	private openLaptop(s: Session): void
	{
		const lap = this.world.realismLaptop;
		if (!lap || typeof lap.open !== 'function')
		{
			realismToast('Laptop unavailable');
			s.phase = 'zoomOut'; s.t = 0;
			return;
		}
		this.stats.laptopOpens++;
		let closed = false;
		const loc = s.a.room >= 1e7 ? 'hotel' : (s.kind === 'computer' ? 'office' : 'home');
		try
		{
			lap.open({
				location: loc,
				onClose: () => { if (closed) return; closed = true; this.laptopClosed(); },
			});
		}
		catch (e)
		{
			console.warn('[Realism] laptop failed to open', e);
			s.phase = 'zoomOut'; s.t = 0;
		}
	}

	/** Called by the laptop's onClose: zoom back out, still seated. */
	public laptopClosed(): void
	{
		const s = this.active;
		this.stats.laptopCloses++;
		if (s === null || s.phase !== 'open') return;
		s.phase = 'zoomOut'; s.t = 0;
	}

	// ------------------------------------------------------------- animation

	private findBones(ch: any): void
	{
		if (this.bonesOf === ch) return;
		this.bones = {};
		ch.traverse((o: any) => { if (o.isBone) this.bones[o.name] = o; });
		this.bonesOf = ch;
	}

	/** Arms forward over the sink / stove, with a small washing / stirring motion. Runs after the mixer. */
	private armsForward(ch: any, amount: number, t: number): void
	{
		this.findBones(ch);
		const wob = Math.sin(t * 9) * 0.12;
		const parts: [string, number][] = [['arm_upperR', -amount + wob], ['arm_upperL', -amount - wob], ['arm_lowerR', -0.5], ['arm_lowerL', -0.5]];
		for (let i = 0; i < parts.length; i++)
		{
			const b = this.bones[parts[i][0]];
			if (!b) continue;
			this.qx.setFromAxisAngle(this.ax, parts[i][1]);
			b.quaternion.multiply(this.qx);
		}
	}

	// ------------------------------------------------------------ shower drops

	private showerDrops(a: Anchor): void
	{
		if (!this.drops)
		{
			const N = 40;
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
			const m = new THREE.PointsMaterial({ color: 0xcfe6ff, size: 0.035, transparent: true, opacity: 0.75, depthWrite: false });
			this.drops = new THREE.Points(g, m);
			this.drops.frustumCulled = false;
			this.drops.visible = false;
			this.dropV = new Float32Array(N);
			this.world.graphicsWorld.add(this.drops);
			const arr = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
			for (let i = 0; i < N; i++) { arr[i * 3 + 1] = -1e4; this.dropV[i] = -1; }
		}
		const pts = this.drops;
		pts.visible = true;
		const attr = (pts.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
		const arr = attr.array as Float32Array;
		const floor = a.top;
		for (let i = 0; i < this.dropV.length; i++)
		{
			if (arr[i * 3 + 1] < floor || this.dropV[i] < 0)
			{
				arr[i * 3] = a.sx + (Math.random() - 0.5) * 0.18;
				arr[i * 3 + 1] = a.sy - Math.random() * (a.sy - floor);
				arr[i * 3 + 2] = a.sz + (Math.random() - 0.5) * 0.18;
				this.dropV[i] = 1;
			}
		}
		attr.needsUpdate = true;
	}

	private updateDrops(dt: number): void
	{
		if (!this.drops || !this.drops.visible) return;
		const s = this.active;
		if (s === null || s.kind !== 'shower' || s.phase !== 'timed') { this.drops.visible = false; return; }
		const attr = (this.drops.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
		const arr = attr.array as Float32Array;
		for (let i = 0; i < this.dropV.length; i++) arr[i * 3 + 1] -= dt * 3.2;
		attr.needsUpdate = true;
	}

	public get dropsVisible(): boolean { return !!(this.drops && this.drops.visible); }
}
