/*
 * RealismDoors.ts
 * ---------------
 * Openable doors for San Verano County.
 *
 *  - Kinds: 'hinged'  single leaf swinging about its hinge (houses, shops, rooms)
 *           'rollup'  warehouse / garage roll-up door that slides up into a housing
 *           'hangar'  two big leaves that slide sideways apart (airport hangars)
 *  - Placement uses the same convention as Frame: world = anchor + R(rot) * local, with the
 *    closed door spanning local x in [0, width], y in [0, height] (anchor = hinge / left edge).
 *  - Rendering: every door is 48 vertices inside ONE merged, vertex-coloured mesh per 256 m
 *    chunk (and per category: exterior doors / interior room doors). Only the vertex range of
 *    a door that is actually moving is rewritten and re-uploaded, so a few thousand doors cost
 *    a handful of draw calls and nothing per frame while they stand still.
 *  - Physics: no permanent bodies. Doors within COLLIDER_RANGE of the player borrow a box body
 *    from a small pool; the box follows the panel (closed = blocks the doorway, open = lies
 *    against the wall / rolled up / slid aside). Far doors have no collider at all.
 *  - Input: E opens / closes the nearest door (player on foot, within USE_RANGE),
 *    L locks / unlocks it (and every door of the same building).
 *  - Prompts (C7, RealismPrompts): owner 'doors' shows [E] Open / Close + [L] Lock, or "Locked" +
 *    [L] Unlock, or an info line ("Private residence", "Front door: boarded up"). E / L only act
 *    while (world as any).realismPrompt.isActive('doors') (or when there is no prompt system).
 *  - Owned properties (C10, (world as any).realismProperties): the outer doors of a building the
 *    player owns ('b' + building index) are the player's: L locks / unlocks them even if they were
 *    a private NPC home or a closed building. Selling restores the old state.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx, chunkKey, RENDER_CHUNK } from './RealismContext';

export type DoorKind = 'hinged' | 'rollup' | 'hangar';

export interface DoorSpec
{
	kind: DoorKind;
	x: number; y: number; z: number;      // anchor (hinge for 'hinged', left edge of the opening otherwise), world
	rot: number;                          // yaw, same convention as Frame
	width: number;
	height: number;
	thickness?: number;
	color?: number[];                     // rgb 0..1
	locked?: boolean;
	fixed?: boolean;                      // lock can't be changed (closed / boarded buildings)
	openAngle?: number;                   // hinged only, radians; + swings local +x towards local -z
	open?: boolean;                       // start open
	group?: string;                       // doors of one building: L locks / unlocks them together
	interior?: boolean;                   // room door (culled with the interiors)
	label?: string;                       // shown in the prompt, e.g. "Door", "Garage"
	privateHome?: boolean;                // NPC home (RealismNPCs): locked for good, prompt "Private residence"
	lawEnforcementOnly?: boolean;          // requires an on-duty police or sheriff job
}

interface Door
{
	kind: DoorKind;
	x: number; y: number; z: number; rot: number;
	w: number; h: number; t: number;
	openAngle: number;
	locked: boolean; fixed: boolean;
	group: string;
	label: string;
	s: number;           // current open amount 0..1
	target: number;      // 0 or 1
	speed: number;       // open amount per second
	batch: DoorBatch;
	v0: number;          // first vertex in the batch
	partner: number;     // index of the other leaf of a double door, -1 if none
	bodies: CANNON.Body[];
	moving: boolean;
	interior: boolean;
	color: number[];
	privateHome: boolean;
	lawEnforcementOnly: boolean;
	bIndex: number;      // building index from the group 'b<i>', -1 otherwise
	owned: boolean;      // the player owns the building (C10)
	orig: number;        // bit 1 privateHome, 2 fixed, 4 locked: state before it became owned
	// closed door segment, for distance tests (xz)
	ax: number; az: number; bx: number; bz: number;
}

interface DoorBatch
{
	key: string;
	interior: boolean;
	doors: number[];
	mesh: THREE.Mesh;
	pos: Float32Array;
	nor: Int8Array;
	posAttr: THREE.BufferAttribute;
	norAttr: THREE.BufferAttribute;
	dirtyLo: number;
	dirtyHi: number;
	maxSlide: number;
}

const VERTS_PER_DOOR = 48;        // two boxes of 24 vertices
const IDX_PER_DOOR = 72;
const USE_RANGE = 2.2;
const COLLIDER_RANGE = 15;
const POOL_MAX = 24;
const GRID = 16;

export class DoorSystem implements IUpdatable
{
	public updateOrder: number = 7;
	public doors: Door[] = [];
	public stats = { doors: 0, interiorDoors: 0, batches: 0, colliders: 0 };
	private ctx: RealismCtx;
	private batches: { [key: string]: DoorBatch } = {};
	private batchList: DoorBatch[] = [];
	private grid: { [key: string]: number[] } = {};
	private moving: number[] = [];
	private pool: CANNON.Body[] = [];
	private withBodies: number[] = [];
	private colliderAcc = 1;
	private nearest = -1;
	private finalized = false;
	private msg: HTMLElement = null;
	private msgUntil = 0;
	private promptKey = '';
	private ownedSet: { [b: number]: boolean } = {};
	private groupDoors: { [b: number]: number[] } = {};
	private ownedAcc = 10;
	private propsHooked: any = null;
	private playerPos = new THREE.Vector3();
	private keyHandler: (e: KeyboardEvent) => void;
	private bodyMat: CANNON.Material;
	private tmpQ = new CANNON.Quaternion();
	private yAxis = new CANNON.Vec3(0, 1, 0);
	private npcCloses: { i: number; t: number }[] = [];

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.bodyMat = new CANNON.Material('doorMat');
		this.bodyMat.friction = 0.3;
	}

	// -----------------------------------------------------------------------
	// building time
	// -----------------------------------------------------------------------

	/** Registers a door. Returns its index (use with link()). */
	public add(spec: DoorSpec): number
	{
		if (this.finalized) { console.warn('[Realism] door added after finalize() ignored'); return -1; }
		if (!(spec.width > 0.2) || !(spec.height > 0.5)) return -1;
		const kind = spec.kind;
		const t = spec.thickness !== undefined ? spec.thickness : (kind === 'hinged' ? 0.05 : (kind === 'rollup' ? 0.08 : 0.25));
		const c = Math.cos(spec.rot), s = Math.sin(spec.rot);
		const interior = !!spec.interior;
		const key = (interior ? 'i' : 'e') + '|' + chunkKey(spec.x, spec.z, RENDER_CHUNK);
		let batch = this.batches[key];
		if (batch === undefined)
		{
			batch = { key: key, interior: interior, doors: [], mesh: null, pos: null, nor: null, posAttr: null, norAttr: null, dirtyLo: -1, dirtyHi: -1, maxSlide: 0 };
			this.batches[key] = batch;
			this.batchList.push(batch);
		}
		const open = !!spec.open && !spec.locked;
		const d: Door = {
			kind: kind, x: spec.x, y: spec.y, z: spec.z, rot: spec.rot,
			w: spec.width, h: spec.height, t: t,
			openAngle: spec.openAngle !== undefined ? spec.openAngle : Math.PI * 0.5,
			locked: !!spec.locked || !!spec.privateHome, fixed: !!spec.fixed || !!spec.privateHome,
			group: spec.group || '',
			label: spec.label || (kind === 'rollup' ? 'Roll-up door' : (kind === 'hangar' ? 'Hangar door' : 'Door')),
			s: open ? 1 : 0, target: open ? 1 : 0,
			speed: kind === 'hinged' ? 1.6 : (kind === 'rollup' ? 0.45 : 0.16),
			batch: batch, v0: batch.doors.length * VERTS_PER_DOOR, partner: -1, bodies: [], moving: false, interior: interior,
			color: spec.color || (kind === 'hinged' ? [0.45, 0.32, 0.22] : [0.72, 0.73, 0.72]),
			privateHome: !!spec.privateHome,
			lawEnforcementOnly: !!spec.lawEnforcementOnly,
			bIndex: /^b\d+$/.test(spec.group || '') ? parseInt((spec.group as string).substring(1), 10) : -1,
			owned: false, orig: 0,
			ax: spec.x, az: spec.z, bx: spec.x + spec.width * c, bz: spec.z - spec.width * s,
		};
		if (kind === 'hangar') batch.maxSlide = Math.max(batch.maxSlide, spec.width / 2);
		const idx = this.doors.length;
		this.doors.push(d);
		batch.doors.push(idx);
		// spatial grid: every cell the closed door segment passes through (+ neighbours at query time)
		const n = Math.max(1, Math.ceil(spec.width / GRID));
		for (let k = 0; k <= n; k++)
		{
			const px = d.ax + (d.bx - d.ax) * k / n, pz = d.az + (d.bz - d.az) * k / n;
			const gk = Math.floor(px / GRID) + '_' + Math.floor(pz / GRID);
			const list = this.grid[gk] || (this.grid[gk] = []);
			if (list[list.length - 1] !== idx) list.push(idx);
		}
		this.stats.doors++;
		if (interior) this.stats.interiorDoors++;
		return idx;
	}

	/** Makes two leaves open and close together (double doors). */
	public link(a: number, b: number): void
	{
		if (a < 0 || b < 0) return;
		this.doors[a].partner = b;
		this.doors[b].partner = a;
	}

	/** Builds the merged door meshes. Call once after every building has been placed. */
	public finalize(): void
	{
		if (this.finalized) return;
		this.finalized = true;
		const mat = this.ctx.mats.plain;
		for (let bi = 0; bi < this.batchList.length; bi++)
		{
			const b = this.batchList[bi];
			const nd = b.doors.length;
			const nv = nd * VERTS_PER_DOOR;
			b.pos = new Float32Array(nv * 3);
			b.nor = new Int8Array(nv * 3);
			const col = new Uint8Array(nv * 3);
			const idx = nv > 65535 ? new Uint32Array(nd * IDX_PER_DOOR) : new Uint16Array(nd * IDX_PER_DOOR);
			for (let k = 0; k < nd; k++)
			{
				const d = this.doors[b.doors[k]];
				this.writeDoor(d);
				const c = this.colorsOf(d);
				for (let v = 0; v < VERTS_PER_DOOR; v++)
				{
					const cc = v < 24 ? c[0] : c[1];
					const o = (d.v0 + v) * 3;
					col[o] = cc[0]; col[o + 1] = cc[1]; col[o + 2] = cc[2];
				}
				for (let bx = 0; bx < 2; bx++)
					for (let f = 0; f < 6; f++)
					{
						const base = d.v0 + bx * 24 + f * 4;
						const o = k * IDX_PER_DOOR + bx * 36 + f * 6;
						idx[o] = base; idx[o + 1] = base + 1; idx[o + 2] = base + 2;
						idx[o + 3] = base; idx[o + 4] = base + 2; idx[o + 5] = base + 3;
					}
			}
			const g = new THREE.BufferGeometry();
			b.posAttr = new THREE.BufferAttribute(b.pos, 3);
			b.posAttr.setUsage(THREE.DynamicDrawUsage);
			b.norAttr = new THREE.BufferAttribute(b.nor, 3, true);
			b.norAttr.setUsage(THREE.DynamicDrawUsage);
			g.setAttribute('position', b.posAttr);
			g.setAttribute('normal', b.norAttr);
			g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
			g.setIndex(new THREE.BufferAttribute(idx, 1));
			g.computeBoundingSphere();
			g.computeBoundingBox();
			// leaves move: make the bounds big enough to cover every pose
			g.boundingSphere.radius += 1.5 + b.maxSlide;
			const mesh = new THREE.Mesh(g, mat);
			mesh.name = b.interior ? 'roomDoors' : 'doors';
			mesh.castShadow = !b.interior;
			mesh.receiveShadow = true;
			mesh.matrixAutoUpdate = false;
			mesh.updateMatrix();
			this.ctx.world.graphicsWorld.add(mesh);
			this.ctx.cull.add(mesh, b.interior ? 'interior' : 'detail', g.boundingSphere.center, g.boundingSphere.radius);
			b.mesh = mesh;
		}
		this.stats.batches = this.batchList.length;
		for (let j = 0; j < this.doors.length; j++)
		{
			const d = this.doors[j];
			if (d.bIndex >= 0 && !d.interior) (this.groupDoors[d.bIndex] || (this.groupDoors[d.bIndex] = [])).push(j);
		}
		this.bindInput();
	}

	private colorsOf(d: Door): number[][]
	{
		const c = d.color;
		const k = d.kind === 'rollup' ? 0.6 : 0.9;
		const to8 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
		const main = [to8(c[0]), to8(c[1]), to8(c[2])];
		const second = d.kind === 'hinged' ? [204, 176, 76] : [to8(c[0] * k), to8(c[1] * k), to8(c[2] * k)];   // brass knob / housing
		return [main, second];
	}

	// -----------------------------------------------------------------------
	// geometry
	// -----------------------------------------------------------------------

	/** Writes one door's 48 vertices for its current open amount. */
	private writeDoor(d: Door): void
	{
		const s = d.s, w = d.w, h = d.h, t = d.t;
		if (d.kind === 'hinged')
		{
			const yaw = d.rot + d.openAngle * smooth(s);
			this.writeBox(d, 0, yaw, 0.01, 0, -t / 2, w - 0.01, h, t / 2);
			const kx = Math.max(0.1, w - 0.13);
			this.writeBox(d, 24, yaw, kx, 0.92, -t / 2 - 0.06, kx + 0.06, 1.0, t / 2 + 0.06);
		}
		else if (d.kind === 'rollup')
		{
			const lift = smooth(s) * (h - 0.3);
			this.writeBox(d, 0, d.rot, 0, lift, -t / 2, w, h, t / 2);
			// housing the door rolls into (inside the building, above the opening)
			this.writeBox(d, 24, d.rot, -0.1, h - 0.05, -t / 2 - 0.5, w + 0.1, h + 0.45, -t / 2 - 0.02);
		}
		else
		{
			const sl = smooth(s) * (w / 2);
			this.writeBox(d, 0, d.rot, -sl, 0, 0.12, w / 2 - sl, h, 0.12 + t);
			this.writeBox(d, 24, d.rot, w / 2 + sl, 0, 0.12, w + sl, h, 0.12 + t);
		}
		const b = d.batch;
		if (b.dirtyLo < 0 || d.v0 < b.dirtyLo) b.dirtyLo = d.v0;
		if (d.v0 + VERTS_PER_DOOR > b.dirtyHi) b.dirtyHi = d.v0 + VERTS_PER_DOOR;
	}

	/** Box (x0..x1, y0..y1, z0..z1) in door space, turned by `yaw` about the anchor. */
	private writeBox(d: Door, vOff: number, yaw: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void
	{
		const P = d.batch.pos, N = d.batch.nor;
		if (P === null) return;
		const c = Math.cos(yaw), s = Math.sin(yaw);
		const ox = d.x, oy = d.y, oz = d.z;
		let v = d.v0 + vOff;
		const put = (lx: number, ly: number, lz: number, nx: number, ny: number, nz: number) =>
		{
			const o = v * 3;
			P[o] = ox + lx * c + lz * s; P[o + 1] = oy + ly; P[o + 2] = oz - lx * s + lz * c;
			N[o] = Math.round((nx * c + nz * s) * 127); N[o + 1] = Math.round(ny * 127); N[o + 2] = Math.round((-nx * s + nz * c) * 127);
			v++;
		};
		// each face counter-clockwise seen from outside (indices 0-1-2, 0-2-3)
		put(x0, y0, z1, 0, 0, 1); put(x1, y0, z1, 0, 0, 1); put(x1, y1, z1, 0, 0, 1); put(x0, y1, z1, 0, 0, 1);
		put(x1, y0, z0, 0, 0, -1); put(x0, y0, z0, 0, 0, -1); put(x0, y1, z0, 0, 0, -1); put(x1, y1, z0, 0, 0, -1);
		put(x1, y0, z1, 1, 0, 0); put(x1, y0, z0, 1, 0, 0); put(x1, y1, z0, 1, 0, 0); put(x1, y1, z1, 1, 0, 0);
		put(x0, y0, z0, -1, 0, 0); put(x0, y0, z1, -1, 0, 0); put(x0, y1, z1, -1, 0, 0); put(x0, y1, z0, -1, 0, 0);
		put(x0, y1, z1, 0, 1, 0); put(x1, y1, z1, 0, 1, 0); put(x1, y1, z0, 0, 1, 0); put(x0, y1, z0, 0, 1, 0);
		put(x0, y0, z0, 0, -1, 0); put(x1, y0, z0, 0, -1, 0); put(x1, y0, z1, 0, -1, 0); put(x0, y0, z1, 0, -1, 0);
	}

	/** Collider boxes for the current pose: [cx, cy, cz, hx, hy, hz, yaw] (world). */
	private boxesOf(d: Door): number[][]
	{
		const s = smooth(d.s), w = d.w, h = d.h, t = d.t;
		const out: number[][] = [];
		const add = (yaw: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
		{
			if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return;
			const c = Math.cos(yaw), sn = Math.sin(yaw);
			const lx = (x0 + x1) / 2, ly = (y0 + y1) / 2, lz = (z0 + z1) / 2;
			out.push([d.x + lx * c + lz * sn, d.y + ly, d.z - lx * sn + lz * c, (x1 - x0) / 2, (y1 - y0) / 2, Math.max(0.06, (z1 - z0) / 2), yaw]);
		};
		if (d.kind === 'hinged') add(d.rot + d.openAngle * s, 0.02, 0.02, -t / 2, w - 0.02, h, t / 2);
		else if (d.kind === 'rollup') { const lift = s * (h - 0.3); add(d.rot, 0, lift, -t / 2, w, h, t / 2); }
		else { const sl = s * (w / 2); add(d.rot, -sl, 0, 0.12, w / 2 - sl, h, 0.12 + t); add(d.rot, w / 2 + sl, 0, 0.12, w + sl, h, 0.12 + t); }
		return out;
	}

	// -----------------------------------------------------------------------
	// play time
	// -----------------------------------------------------------------------

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		if (!this.finalized) return;
		const dt = Math.min(0.1, unscaledTimeStep || timeStep || 0.016);
		const player = this.player();
		const pos = this.playerPos;
		const have = player !== null;
		if (have) pos.copy(player.position);

		// NPC door swings (RealismNPCs): close again once the hold time is over
		for (let i = this.npcCloses.length - 1; i >= 0; i--)
		{
			const c = this.npcCloses[i];
			c.t -= dt;
			if (c.t > 0) continue;
			this.setTarget(c.i, 0);
			const pd = this.doors[c.i];
			if (pd && pd.partner >= 0) this.setTarget(pd.partner, 0);
			this.npcCloses.splice(i, 1);
		}

		// animate
		for (let i = this.moving.length - 1; i >= 0; i--)
		{
			const di = this.moving[i];
			const d = this.doors[di];
			const step = d.speed * dt;
			if (d.s < d.target) d.s = Math.min(d.target, d.s + step); else d.s = Math.max(d.target, d.s - step);
			this.writeDoor(d);
			if (d.bodies.length) this.poseBodies(d);
			if (d.s === d.target) { d.moving = false; this.moving.splice(i, 1); }
		}
		this.upload();

		// colliders around the player
		this.colliderAcc += dt;
		if (have && this.colliderAcc >= 0.25) { this.colliderAcc = 0; this.refreshColliders(pos); }

		// owned properties (C10)
		this.ownedAcc += dt;
		if (this.ownedAcc >= 2) { this.ownedAcc = 0; this.refreshOwned(); }

		// nearest usable door + prompt (C7)
		const onFoot = have && this.onFoot(player);
		this.nearest = onFoot ? this.findNearest(pos, USE_RANGE) : -1;
		this.updatePrompt();
		if (this.msg && this.msgUntil > 0 && now() > this.msgUntil) { this.msg.style.display = 'none'; this.msgUntil = 0; }
	}

	private upload(): void
	{
		for (let bi = 0; bi < this.batchList.length; bi++)
		{
			const b = this.batchList[bi];
			if (b.dirtyLo < 0 || b.posAttr === null) continue;
			const off = b.dirtyLo * 3, cnt = (b.dirtyHi - b.dirtyLo) * 3;
			const pr: any = b.posAttr, nr: any = b.norAttr;
			pr.updateRange.offset = off; pr.updateRange.count = cnt; b.posAttr.needsUpdate = true;
			nr.updateRange.offset = off; nr.updateRange.count = cnt; b.norAttr.needsUpdate = true;
			b.dirtyLo = -1; b.dirtyHi = -1;
		}
	}

	/** Opens / closes door i (and its partner). Returns false if locked. */
	public toggle(i: number): boolean
	{
		const d = this.doors[i];
		if (d === undefined) return false;
		if (d.lawEnforcementOnly && !this.hasLawEnforcementAccess()) { this.flash('Law enforcement only'); return false; }
		if (d.locked) { this.flash(d.privateHome ? 'Private residence' : (d.fixed ? 'Boarded up' : 'Locked')); return false; }
		this.promptKey = '';
		const target = d.target > 0.5 ? 0 : 1;
		this.setTarget(i, target);
		if (d.partner >= 0) this.setTarget(d.partner, target);
		return true;
	}

	private setTarget(i: number, target: number): void
	{
		const d = this.doors[i];
		d.target = target;
		if (!d.moving && d.s !== d.target) { d.moving = true; this.moving.push(i); }
	}

	/** Locks / unlocks door i and every door in its group (a locked door closes). */
	public toggleLock(i: number): void
	{
		const d = this.doors[i];
		if (d === undefined) return;
		if (d.lawEnforcementOnly && !this.hasLawEnforcementAccess()) { this.flash('Law enforcement only'); return; }
		if (d.privateHome) { this.flash('Private residence'); return; }
		if (d.fixed) { this.flash(d.locked ? 'Boarded up' : 'This lock is broken'); return; }
		const lock = !d.locked;
		const apply = (j: number) =>
		{
			const e = this.doors[j];
			if (e.fixed) return;
			e.locked = lock;
			if (lock) this.setTarget(j, 0);
		};
		if (d.group)
		{
			for (let j = 0; j < this.doors.length; j++) if (this.doors[j].group === d.group && !this.doors[j].interior) apply(j);
		}
		apply(i);
		if (d.partner >= 0) apply(d.partner);
		this.promptKey = '';
		this.flash(lock ? 'Locked' : 'Unlocked');
	}

	// -----------------------------------------------------------------------
	// NPC homes / errands (RealismNPCs)
	// -----------------------------------------------------------------------

	/** Turns every outer door of a building group into a private NPC home door: locked for good,
	 *  L can't unlock it and the prompt says "Private residence". Returns how many doors changed. */
	public markPrivate(group: string): number
	{
		if (!group) return 0;
		let n = 0;
		for (let j = 0; j < this.doors.length; j++)
		{
			const d = this.doors[j];
			if (d.group !== group || d.interior) continue;
			if (d.owned) { d.orig |= 1 | 2 | 4; n++; continue; }   // owned by the player: becomes private again only if sold
			d.privateHome = true; d.locked = true; d.fixed = true;
			if (d.target !== 0) this.setTarget(j, 0);
			n++;
		}
		return n;
	}

	/** Indices of the outer doors of a building group (front door first). */
	public doorsOfGroup(group: string): number[]
	{
		const out: number[] = [];
		for (let j = 0; j < this.doors.length; j++)
		{
			const d = this.doors[j];
			if (d.group === group && !d.interior) out.push(j);
		}
		out.sort((a, b) => (this.doors[a].label === 'Front door' || this.doors[a].label === 'Entrance' ? 0 : 1) - (this.doors[b].label === 'Front door' || this.doors[b].label === 'Entrance' ? 0 : 1));
		return out;
	}

	/** Centre of door i's closed opening and its outward facing (local +z of the building). */
	public doorInfo(i: number): { x: number; y: number; z: number; rot: number; width: number; label: string; locked: boolean; privateHome: boolean } | null
	{
		const d = this.doors[i];
		if (d === undefined) return null;
		const w = d.partner >= 0 ? d.w * 2 : d.w;
		const c = Math.cos(d.rot), s = Math.sin(d.rot);
		const mx = (d.ax + d.bx) / 2 + (d.partner >= 0 ? (d.w / 2) * c : 0), mz = (d.az + d.bz) / 2 - (d.partner >= 0 ? (d.w / 2) * s : 0);
		return { x: mx, y: d.y, z: mz, rot: d.rot, width: w, label: d.label, locked: d.locked, privateHome: d.privateHome };
	}

	/** Swings door i (and its partner) open for an NPC walking through, whatever its lock, and closes it after `hold` seconds. */
	public npcPass(i: number, hold: number = 1.6): void
	{
		const d = this.doors[i];
		if (d === undefined || !this.finalized || d.lawEnforcementOnly) return;
		this.setTarget(i, 1);
		if (d.partner >= 0) this.setTarget(d.partner, 1);
		for (let k = 0; k < this.npcCloses.length; k++) if (this.npcCloses[k].i === i) { this.npcCloses[k].t = hold; return; }
		this.npcCloses.push({ i: i, t: hold });
	}

	private refreshColliders(p: THREE.Vector3): void
	{
		const want = this.query(p.x, p.z, COLLIDER_RANGE, p.y);
		// release doors that left the range
		for (let k = this.withBodies.length - 1; k >= 0; k--)
		{
			const di = this.withBodies[k];
			if (want.indexOf(di) >= 0) continue;
			const d = this.doors[di];
			for (let b = 0; b < d.bodies.length; b++) { this.ctx.world.physicsWorld.remove(d.bodies[b]); this.pool.push(d.bodies[b]); }
			d.bodies = [];
			this.withBodies.splice(k, 1);
		}
		// nearest first, so the pool is spent on the doors that matter
		want.sort((a, b) => this.dist(this.doors[a], p.x, p.z) - this.dist(this.doors[b], p.x, p.z));
		let used = 0;
		for (let k = 0; k < this.withBodies.length; k++) used += this.doors[this.withBodies[k]].bodies.length;
		for (let k = 0; k < want.length; k++)
		{
			const di = want[k];
			const d = this.doors[di];
			if (d.bodies.length) continue;
			const need = d.kind === 'hangar' ? 2 : 1;
			if (used + need > POOL_MAX) break;
			for (let b = 0; b < need; b++)
			{
				let body = this.pool.pop();
				if (body === undefined)
				{
					body = new CANNON.Body({ mass: 0 });
					body.material = this.bodyMat;
				}
				d.bodies.push(body);
			}
			this.shapeBodies(d);
			for (let b = 0; b < d.bodies.length; b++) this.ctx.world.physicsWorld.addBody(d.bodies[b]);
			this.withBodies.push(di);
			used += need;
		}
		this.stats.colliders = used;
	}

	/** Gives the door's bodies box shapes of the right size (on assignment). */
	private shapeBodies(d: Door): void
	{
		const boxes = this.boxesOf(d);
		for (let b = 0; b < d.bodies.length; b++)
		{
			const body: any = d.bodies[b];
			const bx = boxes[b] || boxes[0];
			body.shapes.length = 0; body.shapeOffsets.length = 0; body.shapeOrientations.length = 0;
			body.addShape(new CANNON.Box(new CANNON.Vec3(bx[3], bx[4], bx[5])));
		}
		this.poseBodies(d);
	}

	private poseBodies(d: Door): void
	{
		const boxes = this.boxesOf(d);
		for (let b = 0; b < d.bodies.length; b++)
		{
			const body = d.bodies[b];
			const bx = boxes[b];
			if (bx === undefined) { body.position.set(d.x, -1000, d.z); body.aabbNeedsUpdate = true; continue; }
			// the hinged / rollup panel keeps its size; only the rollup shrinks as it lifts
			if (d.kind === 'rollup')
			{
				const shape = body.shapes[0] as CANNON.Box;
				if (shape && Math.abs(shape.halfExtents.y - bx[4]) > 0.02)
				{
					shape.halfExtents.set(bx[3], bx[4], bx[5]);
					shape.updateConvexPolyhedronRepresentation();
					shape.updateBoundingSphereRadius();
					body.updateBoundingRadius();
				}
			}
			body.position.set(bx[0], bx[1], bx[2]);
			this.tmpQ.setFromAxisAngle(this.yAxis, bx[6]);
			body.quaternion.copy(this.tmpQ);
			body.aabbNeedsUpdate = true;
		}
	}

	// -----------------------------------------------------------------------
	// lookups
	// -----------------------------------------------------------------------

	private query(x: number, z: number, r: number, y?: number): number[]
	{
		const out: number[] = [];
		const g0x = Math.floor((x - r) / GRID), g1x = Math.floor((x + r) / GRID);
		const g0z = Math.floor((z - r) / GRID), g1z = Math.floor((z + r) / GRID);
		for (let gx = g0x; gx <= g1x; gx++)
			for (let gz = g0z; gz <= g1z; gz++)
			{
				const list = this.grid[gx + '_' + gz];
				if (list === undefined) continue;
				for (let k = 0; k < list.length; k++)
				{
					const di = list[k];
					if (out.indexOf(di) >= 0) continue;
					const d = this.doors[di];
					if (y !== undefined && (y < d.y - 3 || y > d.y + d.h + 3)) continue;
					if (this.dist(d, x, z) <= r) out.push(di);
				}
			}
		return out;
	}

	private findNearest(p: THREE.Vector3, r: number): number
	{
		const list = this.query(p.x, p.z, r + 0.5);
		let best = -1, bestD = r;
		for (let k = 0; k < list.length; k++)
		{
			const d = this.doors[list[k]];
			// must be standing on the door's floor (not the storey above / below)
			if (p.y < d.y - 0.6 || p.y > d.y + Math.min(d.h, 2.4) + 0.4) continue;
			const dd = this.dist(d, p.x, p.z);
			if (dd < bestD) { bestD = dd; best = list[k]; }
		}
		return best;
	}

	/** xz distance from a point to the closed door's segment. */
	private dist(d: Door, x: number, z: number): number
	{
		const vx = d.bx - d.ax, vz = d.bz - d.az;
		const L = vx * vx + vz * vz;
		let t = L > 0 ? ((x - d.ax) * vx + (z - d.az) * vz) / L : 0;
		t = Math.max(0, Math.min(1, t));
		const dx = d.ax + vx * t - x, dz = d.az + vz * t - z;
		return Math.sqrt(dx * dx + dz * dz);
	}

	/** The character the user controls, or null (free camera). */
	private player(): any
	{
		const im: any = this.ctx.world.inputManager;
		const r: any = im ? im.inputReceiver : null;
		if (r && r.characterCapsule !== undefined && r.position) return r;
		if (r && r.controllingCharacter) return r.controllingCharacter;   // driving: colliders follow the car
		return null;
	}

	private onFoot(ch: any): boolean
	{
		if (!ch || ch.characterCapsule === undefined) return false;
		return !ch.occupyingSeat && ch.controlledObject === undefined && !ch.vehicleEntryInstance;
	}

	private hasLawEnforcementAccess(): boolean
	{
		const job = (this.ctx.world as any).realismJob;
		return !!(job && job.onDuty === true && (job.id === 'police' || job.id === 'sheriff'));
	}

	// -----------------------------------------------------------------------
	// input + HUD
	// -----------------------------------------------------------------------

	private bindInput(): void
	{
		if (typeof document === 'undefined' || !document.addEventListener) return;
		this.keyHandler = (e: KeyboardEvent) =>
		{
			if (e.repeat) return;
			if (e.code !== 'KeyE' && e.code !== 'KeyL') return;
			const tgt: any = e.target;
			if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
			const w: any = this.ctx.world;
			const pr = w.realismPrompt;
			if (pr && typeof pr.isActive === 'function') { if (!pr.isActive('doors')) return; }
			else if (w.realismUIBlocking === true || w.realismPaused === true) return;
			const p = this.player();
			if (p === null || !this.onFoot(p)) return;
			this.playerPos.copy(p.position);
			const i = this.findNearest(this.playerPos, e.code === 'KeyL' ? USE_RANGE + 0.8 : USE_RANGE);
			if (i < 0) return;
			if (e.code === 'KeyE') this.toggle(i); else this.toggleLock(i);
		};
		document.addEventListener('keydown', this.keyHandler, false);
	}

	private ensureHud(): void
	{
		if (this.msg !== null) return;
		try
		{
			if (typeof document === 'undefined' || !document.body || !document.createElement) return;
			const m = document.createElement('div');
			m.style.cssText = 'position:fixed;left:50%;bottom:100px;transform:translateX(-50%);z-index:9999;font:bold 18px sans-serif;color:#ffd54a;text-shadow:0 1px 3px #000;pointer-events:none;display:none';
			document.body.appendChild(m);
			this.msg = m;
		}
		catch (e) { /* headless */ }
	}

	/** Shows / clears the 'doors' prompt for the nearest door (only when it changes). */
	private updatePrompt(): void
	{
		const pr = (this.ctx.world as any).realismPrompt;
		if (!pr || typeof pr.set !== 'function') return;
		const i = this.nearest;
		let key = '';
		if (i >= 0)
		{
			const d = this.doors[i];
			const state = (d.lawEnforcementOnly && !this.hasLawEnforcementAccess() ? 'x' : '') +
				(d.privateHome ? 'p' : (d.fixed && d.locked ? 'b' : (d.locked ? 'l' : (d.target > 0.5 ? 'c' : 'o'))));
			key = i + state;
		}
		if (key === this.promptKey) return;
		this.promptKey = key;
		if (i < 0) { pr.set('doors', null); return; }
		const d = this.doors[i];
		let items: { key: string; label: string }[];
		if (d.lawEnforcementOnly && !this.hasLawEnforcementAccess()) items = [{ key: '', label: 'Law enforcement access only' }];
		else if (d.privateHome) items = PROMPT_PRIVATE;
		else if (d.fixed && d.locked) items = [{ key: '', label: d.label + ': boarded up' }];
		else if (d.locked) items = PROMPT_LOCKED;
		else items = d.target > 0.5 ? PROMPT_CLOSE : PROMPT_OPEN;
		pr.set('doors', items, { priority: 0, anchor: this.anchorOf(d) });
	}

	private anchor = new THREE.Vector3();
	private anchorOf(d: Door): THREE.Vector3
	{
		return this.anchor.set((d.ax + d.bx) / 2, d.y + 1, (d.az + d.bz) / 2);
	}

	// -----------------------------------------------------------------------
	// owned properties (C10)
	// -----------------------------------------------------------------------

	/** True when the player owns building `b` (realismProperties.owns). */
	public isOwnedBuilding(b: number): boolean { return !!this.ownedSet[b]; }

	/** Re-reads which buildings the player owns and hands their outer doors over / back. */
	public refreshOwned(): void
	{
		const w: any = this.ctx.world;
		const props = w.realismProperties;
		const next: { [b: number]: boolean } = {};
		if (props)
		{
			if (this.propsHooked !== props)
			{
				this.propsHooked = props;
				try { if (typeof props.onChange === 'function') props.onChange(() => this.refreshOwned()); } catch (e) { /* ignore */ }
				const ev = w.realismEvents;
				if (ev && typeof ev.on === 'function') { ev.on('propertyBought', () => this.refreshOwned()); ev.on('propertySold', () => this.refreshOwned()); }
			}
			try
			{
				let list: any[] = null;
				if (typeof props.ownedList === 'function') list = props.ownedList();
				if (list && list.length !== undefined)
				{
					for (let k = 0; k < list.length; k++)
					{
						const r = list[k];
						const bi = r && typeof r.buildingIndex === 'number' ? r.buildingIndex : (r && typeof r.id === 'string' && /^b\d+$/.test(r.id) ? parseInt(r.id.substring(1), 10) : -1);
						if (bi >= 0 && (typeof props.owns !== 'function' || props.owns(bi))) next[bi] = true;
					}
				}
				else if (typeof props.owns === 'function')
				{
					for (const b in this.groupDoors) if (this.groupDoors.hasOwnProperty(b) && props.owns(+b)) next[+b] = true;
				}
			}
			catch (e) { /* their bug, keep the old state */ return; }
		}
		// sold
		for (const b in this.ownedSet)
		{
			if (!this.ownedSet.hasOwnProperty(b) || next[+b]) continue;
			const list = this.groupDoors[+b] || [];
			for (let k = 0; k < list.length; k++)
			{
				const d = this.doors[list[k]];
				if (!d.owned) continue;
				d.owned = false;
				d.privateHome = (d.orig & 1) !== 0; d.fixed = (d.orig & 2) !== 0;
				if (d.orig & 4) { d.locked = true; this.setTarget(list[k], 0); }
			}
		}
		// bought
		for (const b in next)
		{
			if (!next.hasOwnProperty(b) || this.ownedSet[+b]) continue;
			const list = this.groupDoors[+b] || [];
			for (let k = 0; k < list.length; k++)
			{
				const d = this.doors[list[k]];
				if (d.owned) continue;
				d.owned = true;
				d.orig = (d.privateHome ? 1 : 0) | (d.fixed ? 2 : 0) | (d.locked ? 4 : 0);
				d.privateHome = false; d.fixed = false;   // the player's own doors: lock / unlock with L
			}
		}
		this.ownedSet = next;
		this.promptKey = '';
	}

	private flash(text: string): void
	{
		this.ensureHud();
		if (this.msg === null) return;
		this.msg.textContent = text;
		this.msg.style.display = 'block';
		this.msgUntil = now() + 1300;
	}
}

const PROMPT_OPEN = [{ key: 'E', label: 'Open' }, { key: 'L', label: 'Lock' }];
const PROMPT_CLOSE = [{ key: 'E', label: 'Close' }, { key: 'L', label: 'Lock' }];
const PROMPT_LOCKED = [{ key: '', label: 'Locked' }, { key: 'L', label: 'Unlock' }];
const PROMPT_PRIVATE = [{ key: '', label: 'Private residence' }];

function smooth(s: number): number { return s * s * (3 - 2 * s); }
function now(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
