/*
 * RealismConstruction.ts
 * ----------------------
 * The Verano Build Co. construction site for the Construction job (RealismJobsLegal.ts).
 *
 *  - Placed at runtime on a free lot near construction.near (default: the player's start point):
 *    a 30 x 26 m rectangle facing the nearest road, clear of every building, road, prop, tree and
 *    lamp of the map (with margins), on flat dry ground. The map itself is never changed.
 *  - The site: construction screen fence with a gate, concrete slab, scaffolding, site office
 *    trailer, brick pallets, lumber pile and (construction.crane) a tower crane.
 *  - The house goes up in 5 stages (footings, columns, beams, walls, roof; 27 pieces). The next
 *    pieces show as green ghosts; placing one (hold E at it, a Build task) uses one unit of site
 *    materials (stock). Deliveries add stock. After the last piece the project completes: the
 *    building stays (fence, scaffolding and crane go), and the next project opens on the next
 *    free lot.
 *  - Saved in localStorage 'realism.construction.v1': { v, seed, project, placed, stock, done: [lots] }.
 *
 * Draw calls: static site parts 1, placed pieces 1, ghosts 1 (+1 per finished building).
 * Geometry is rebuilt only when a piece is placed (a few hundred triangles).
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { RealismCtx } from './RealismContext';
import { GeoAccum, Frame, box, cyl } from './RealismGeometry';
import { SEA_LEVEL } from './RealismMapData';

export const CONSTRUCTION_KEY = 'realism.construction.v1';

export interface Lot { x: number; y: number; z: number; rot: number; w: number; d: number; }

export interface Piece { stage: number; kind: string; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; }

export const STAGES = ['Footings', 'Columns', 'Beams', 'Walls', 'Roof'];
const PIECE_NAMES = ['footing', 'column', 'beam', 'wall panel', 'roof panel'];
const PIECE_COLORS = [[0.62, 0.62, 0.6], [0.62, 0.22, 0.16], [0.62, 0.22, 0.16], [0.74, 0.72, 0.68], [0.3, 0.31, 0.34]];

const LOT_W = 30, LOT_D = 26;
const BX = 0, BZ = -2;           // building centre in the site frame
const SLAB_TOP = 0.3;

/** All pieces of the house, in the site frame (y relative to the site ground). */
export function housePieces(): Piece[]
{
	const p: Piece[] = [];
	const y = SLAB_TOP;
	const add = (stage: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
		p.push({ stage: stage, kind: PIECE_NAMES[stage], x0: BX + x0, y0: y0, z0: BZ + z0, x1: BX + x1, y1: y1, z1: BZ + z1 });
	// 0 footings
	for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(0, sx * 5.8 - 0.6, y, sz * 4.3 - 0.6, sx * 5.8 + 0.6, y + 0.5, sz * 4.3 + 0.6);
	// 1 columns
	for (const cx of [-5.8, 0, 5.8]) for (const sz of [-1, 1]) add(1, cx - 0.2, y, sz * 4.3 - 0.2, cx + 0.2, y + 3.2, sz * 4.3 + 0.2);
	// 2 beams
	for (const bz of [-4.3, 0, 4.3]) add(2, -6.1, y + 3.2, bz - 0.18, 6.1, y + 3.6, bz + 0.18);
	for (const bx of [-5.8, 5.8]) add(2, bx - 0.18, y + 3.2, -4.5, bx + 0.18, y + 3.6, 4.5);
	// 3 walls (front has a door gap at x -1.1..1.1)
	add(3, -6, y, -4.55, 0, y + 3.2, -4.3); add(3, 0, y, -4.55, 6, y + 3.2, -4.3);
	add(3, -6.05, y, -4.3, -5.8, y + 3.2, 0); add(3, -6.05, y, 0, -5.8, y + 3.2, 4.3);
	add(3, 5.8, y, -4.3, 6.05, y + 3.2, 0); add(3, 5.8, y, 0, 6.05, y + 3.2, 4.3);
	add(3, -6, y, 4.3, -1.1, y + 3.2, 4.55); add(3, 1.1, y, 4.3, 6, y + 3.2, 4.55);
	// 4 roof
	for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(4, sx < 0 ? -6.3 : 0, y + 3.6, sz < 0 ? -4.8 : 0, sx < 0 ? 0 : 6.3, y + 3.85, sz < 0 ? 0 : 4.8);
	return p;
}

// ---------------------------------------------------------------------------------- spatial index

/** Coarse grid over buildings, props, trees and lamps for free-spot checks (built once). */
export class SpatialIndex
{
	private cell = 32;
	private b: { [k: string]: number[] } = {};
	private o: { [k: string]: number[] } = {};   // x, z, r triples
	private ctx: RealismCtx;

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		const d = ctx.data;
		for (let i = 0; i < d.buildings.length; i++)
		{
			const bd = d.buildings[i];
			const r = Math.sqrt(bd.w * bd.w + bd.d * bd.d) / 2;
			this.cells(bd.x, bd.z, r, (k) => (this.b[k] = this.b[k] || []).push(i));
		}
		const obj = (x: number, z: number, r: number) => this.cells(x, z, r, (k) => { const a = (this.o[k] = this.o[k] || []); a.push(x, z, r); });
		for (let i = 0; i < d.props.length; i++) { const p = d.props[i]; obj(p.x, p.z, p.len ? p.len / 2 + 0.6 : 1.2); }
		for (let i = 0; i < d.trees.length; i++) { const t = d.trees[i]; obj(t.x, t.z, Math.max(1.2, t.s * 1.6)); }
		for (let i = 0; i < d.lamps.length; i++) { const l = d.lamps[i]; obj(l.x, l.z, 0.8); }
	}

	private cells(x: number, z: number, r: number, f: (k: string) => void): void
	{
		const c = this.cell;
		const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c), z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
		for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) f(gx + '_' + gz);
	}

	/** Adds an extra round obstacle (runtime content of other systems). */
	public addObstacle(x: number, z: number, r: number): void
	{
		this.cells(x, z, r, (k) => { const a = (this.o[k] = this.o[k] || []); a.push(x, z, r); });
	}

	/** Index of a building whose footprint (+ margin) contains the point, else -1. */
	public buildingAt(x: number, z: number, margin: number): number
	{
		const k = Math.floor(x / this.cell) + '_' + Math.floor(z / this.cell);
		const list = this.b[k];
		if (!list) return -1;
		const bs = this.ctx.data.buildings;
		for (let i = 0; i < list.length; i++)
		{
			const b = bs[list[i]];
			const dx = x - b.x, dz = z - b.z, c = Math.cos(b.rot), s = Math.sin(b.rot);
			const lx = dx * c - dz * s, lz = dx * s + dz * c;
			if (Math.abs(lx) < b.w / 2 + margin && Math.abs(lz) < b.d / 2 + margin) return list[i];
		}
		return -1;
	}

	/** True when a prop / tree / lamp is within margin of the point. */
	public objectNear(x: number, z: number, margin: number): boolean
	{
		const k = Math.floor(x / this.cell) + '_' + Math.floor(z / this.cell);
		const a = this.o[k];
		if (!a) return false;
		for (let i = 0; i < a.length; i += 3)
		{
			const dx = a[i] - x, dz = a[i + 1] - z, r = a[i + 2] + margin;
			if (dx * dx + dz * dz < r * r) return true;
		}
		return false;
	}

	/** Free for something on foot: not in a building, not on a road, nothing standing there. */
	public freeSpot(x: number, z: number, margin: number): boolean
	{
		if (this.buildingAt(x, z, margin) >= 0) return false;
		if (this.ctx.data.roadClearance(x, z) < margin) return false;
		return !this.objectNear(x, z, margin * 0.5);
	}
}

// ---------------------------------------------------------------------------------- the site

export interface ConstructionSettings { near: number[] | null; crane: boolean; startStock: number; deliveryStock: number; piecesPerTask: number; maxProjects: number; }

export function constructionSettings(cfg: any): ConstructionSettings
{
	const raw: any = (cfg && cfg.construction) || {};
	const n = (v: any, d: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, typeof v === 'number' && isFinite(v) ? v : d));
	return {
		near: raw.near instanceof Array && raw.near.length >= 2 && isFinite(raw.near[0]) && isFinite(raw.near[1]) ? [+raw.near[0], +raw.near[1]] : null,
		crane: raw.crane !== false,
		startStock: Math.round(n(raw.startStock, 9, 0, 1000)),
		deliveryStock: Math.round(n(raw.deliveryStock, 12, 1, 1000)),
		piecesPerTask: Math.round(n(raw.piecesPerTask, 3, 1, 27)),
		maxProjects: Math.round(n(raw.maxProjects, 4, 1, 12)),
	};
}

export class ConstructionSite
{
	public settings: ConstructionSettings;
	public lot: Lot = null;
	public project = 1;
	public placed = 0;            // pieces of the current project in place
	public stock = 0;             // site materials, one per piece
	public done: Lot[] = [];      // finished projects
	public pieces: Piece[] = housePieces();
	public ghosts: number[] = []; // piece indices currently shown as ghosts
	public stats = { searchMs: 0, candidates: 0 };
	private ctx: RealismCtx;
	private index: SpatialIndex;
	private siteMesh: THREE.Mesh = null;
	private pieceMesh: THREE.Mesh = null;
	private ghostMesh: THREE.Mesh = null;
	private doneMeshes: THREE.Mesh[] = [];
	private body: CANNON.Body = null;
	private doneBodies: CANNON.Body[] = [];
	private ghostMat: THREE.Material;

	constructor(ctx: RealismCtx, index: SpatialIndex)
	{
		this.ctx = ctx;
		this.index = index;
		this.settings = constructionSettings(ctx.cfg);
		this.stock = this.settings.startStock;
		const gm = new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: 0.33, depthWrite: false });
		gm.name = 'constructionGhost';
		this.ghostMat = gm;
		this.load();
		for (let i = 0; i < this.done.length; i++) this.buildDone(this.done[i]);
		if (this.done.length < this.settings.maxProjects) this.lot = this.findLot();
		if (this.lot) this.rebuild(true);
	}

	public get total(): number { return this.pieces.length; }
	public get complete(): boolean { return !this.lot; }

	/** Current stage 0..4, pieces placed in it and its size. */
	public stageInfo(): { stage: number; name: string; inStage: number; stageSize: number; placed: number; total: number }
	{
		const st = this.placed < this.pieces.length ? this.pieces[this.placed].stage : STAGES.length - 1;
		let size = 0, before = 0;
		for (let i = 0; i < this.pieces.length; i++)
		{
			if (this.pieces[i].stage === st) size++;
			else if (this.pieces[i].stage < st) before++;
		}
		return { stage: st, name: STAGES[st], inStage: this.placed - before, stageSize: size, placed: this.placed, total: this.pieces.length };
	}

	/** Site frame point to world. */
	public toWorld(lx: number, ly: number, lz: number, lot?: Lot): THREE.Vector3
	{
		const L = lot || this.lot;
		const f = new Frame(L.x, L.y, L.z, L.rot);
		const p = f.p(lx, ly, lz);
		return new THREE.Vector3(p[0], p[1], p[2]);
	}

	/** Where to stand to place piece i (ground level). */
	public pieceSpot(i: number): THREE.Vector3
	{
		const p = this.pieces[i];
		let cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
		// walls / footings: stand a little outside so the spot is reachable
		if (p.stage === 0 || p.stage === 3)
		{
			const dx = cx - BX, dz = cz - BZ;
			const l = Math.sqrt(dx * dx + dz * dz) || 1;
			cx += dx / l * 1.1; cz += dz / l * 1.1;
		}
		return this.toWorld(cx, SLAB_TOP, cz);
	}

	/** The next n unplaced pieces of the current stage. */
	public nextPieces(n: number): number[]
	{
		const out: number[] = [];
		if (!this.lot || this.placed >= this.pieces.length) return out;
		const st = this.pieces[this.placed].stage;
		for (let i = this.placed; i < this.pieces.length && out.length < n; i++) if (this.pieces[i].stage === st) out.push(i);
		return out;
	}

	public showGhosts(ids: number[]): void
	{
		this.ghosts = ids.slice(0);
		this.rebuildGhosts();
	}

	/** Places the next piece (pieces go in order). Returns false without stock. */
	public placeNext(): boolean
	{
		if (!this.lot || this.placed >= this.pieces.length) return false;
		if (this.stock <= 0) return false;
		this.stock--;
		const id = this.placed;
		this.placed++;
		const gi = this.ghosts.indexOf(id);
		if (gi >= 0) this.ghosts.splice(gi, 1);
		if (this.placed >= this.pieces.length) this.finishProject();
		else this.rebuild(false);
		this.save();
		return true;
	}

	public addStock(n: number): void
	{
		this.stock = Math.max(0, Math.min(999, this.stock + Math.round(n)));
		this.save();
	}

	/** Unload spot just inside the gate. */
	public unloadSpot(): THREE.Vector3 { return this.toWorld(0, 0, LOT_D / 2 - 2.5); }
	/** Site office (blueprints). */
	public officeSpot(): THREE.Vector3 { return this.toWorld(-10, 0, 6.2); }
	public center(): THREE.Vector3 { return this.lot ? this.toWorld(0, 0, 0) : null; }

	private finishProject(): void
	{
		const L = this.lot;
		this.done.push(L);
		this.buildDone(L);
		this.disposeSite();
		this.project++;
		this.placed = 0;
		this.ghosts = [];
		this.lot = this.done.length < this.settings.maxProjects ? this.findLot() : null;
		if (this.lot) this.rebuild(true);
	}

	// ------------------------------------------------------------------ lot search

	/** First free lot by distance from construction.near (or the respawn point). */
	public findLot(): Lot
	{
		const t0 = Date.now();
		const d = this.ctx.data;
		const c = this.settings.near || [d.respawn.x, d.respawn.z];
		let n = 0;
		for (let r = 40; r <= 1400; r += 14)
		{
			const steps = Math.max(8, Math.floor((2 * Math.PI * r) / 14));
			for (let k = 0; k < steps; k++)
			{
				const a = (k / steps) * Math.PI * 2 + r * 0.013;
				const x = c[0] + Math.cos(a) * r, z = c[1] + Math.sin(a) * r;
				n++;
				const lot = this.tryLot(x, z);
				if (lot) { this.stats.searchMs = Date.now() - t0; this.stats.candidates = n; return lot; }
			}
		}
		this.stats.searchMs = Date.now() - t0;
		this.stats.candidates = n;
		console.warn('[Realism] Construction: no free lot found');
		return null;
	}

	/** A lot centred at (x, z), facing its nearest road, or null when anything is in the way. */
	public tryLot(x: number, z: number): Lot
	{
		const d = this.ctx.data;
		const hw = LOT_W / 2 + 1.5, hd = LOT_D / 2 + 1.5;
		// quick rejects at the centre
		if (d.roadClearance(x, z) < hd) return null;
		if (this.index.buildingAt(x, z, hw) >= 0) return null;
		// face the nearest road: probe 8 directions
		let best = -1, bestD = 1e9;
		for (let k = 0; k < 8; k++)
		{
			const a = k * Math.PI / 4;
			for (let s = hd; s <= hd + 26; s += 4)
			{
				if (d.roadClearance(x + Math.sin(a) * s, z + Math.cos(a) * s) < 0.5) { if (s < bestD) { bestD = s; best = a; } break; }
			}
		}
		if (best < 0) return null;
		const rot = best;
		const f = new Frame(x, 0, z, rot);
		let hmin = 1e9, hmax = -1e9;
		for (let lx = -hw; lx <= hw + 0.01; lx += 3)
		{
			for (let lz = -hd; lz <= hd + 0.01; lz += 3)
			{
				const p = f.p(lx, 0, lz);
				if (d.roadClearance(p[0], p[2]) < 1.0) return null;
				if (this.index.buildingAt(p[0], p[2], 2.5) >= 0) return null;
				if (this.index.objectNear(p[0], p[2], 1.0)) return null;
				const h = d.heightAt(p[0], p[2]);
				if (h < hmin) hmin = h;
				if (h > hmax) hmax = h;
			}
		}
		if (hmax - hmin > 1.2 || hmin < SEA_LEVEL + 1.2) return null;
		// stay out of the lake
		const lk = d.lake;
		if (lk && ((x - lk.x) * (x - lk.x)) / ((lk.rx + 40) * (lk.rx + 40)) + ((z - lk.z) * (z - lk.z)) / ((lk.rz + 40) * (lk.rz + 40)) < 1) return null;
		// not on top of an earlier lot
		const all = this.done.concat(this.lot ? [this.lot] : []);
		for (let i = 0; i < all.length; i++) if (Math.abs(all[i].x - x) < LOT_W + 6 && Math.abs(all[i].z - z) < LOT_W + 6) return null;
		// no scenario spawn inside
		for (let s = 0; s < d.scenarios.length; s++)
		{
			const sp = d.scenarios[s].spawns;
			for (let i = 0; i < sp.length; i++) if (Math.abs(sp[i].x - x) < hw + 3 && Math.abs(sp[i].z - z) < hw + 3) return null;
		}
		return { x: x, y: (hmin + hmax) / 2, z: z, rot: rot, w: LOT_W, d: LOT_D };
	}

	/** Verification for tests: true when nothing of the map overlaps the lot rectangle. */
	public verifyLot(L: Lot): { buildings: number; road: number; objects: number }
	{
		const d = this.ctx.data;
		const f = new Frame(L.x, 0, L.z, L.rot);
		let bld = 0, road = 0, obj = 0;
		for (let lx = -L.w / 2; lx <= L.w / 2 + 0.01; lx += 1) for (let lz = -L.d / 2; lz <= L.d / 2 + 0.01; lz += 1)
		{
			const p = f.p(lx, 0, lz);
			if (this.index.buildingAt(p[0], p[2], 0) >= 0) bld++;
			if (d.roadClearance(p[0], p[2]) < 0) road++;
			if (this.index.objectNear(p[0], p[2], 0)) obj++;
		}
		return { buildings: bld, road: road, objects: obj };
	}

	// ------------------------------------------------------------------ meshes

	private pieceBox(acc: GeoAccum, f: Frame, p: Piece, c: number[]): void
	{
		box(acc, f, p.x0, p.y0, p.z0, p.x1, p.y1, p.z1, c);
	}

	private rebuild(withSite: boolean): void
	{
		const L = this.lot;
		if (!L) return;
		const f = new Frame(L.x, L.y, L.z, L.rot);
		if (withSite || !this.siteMesh)
		{
			const a = new GeoAccum();
			this.siteGeometry(a, f);
			this.siteMesh = this.swap(this.siteMesh, a, this.ctx.mats.plain, true);
		}
		const pa = new GeoAccum();
		// slab always
		box(pa, f, BX - 6.6, -0.6, BZ - 5.1, BX + 6.6, SLAB_TOP, BZ + 5.1, [0.66, 0.66, 0.64]);
		for (let i = 0; i < this.placed; i++) this.pieceBox(pa, f, this.pieces[i], PIECE_COLORS[this.pieces[i].stage]);
		this.pieceMesh = this.swap(this.pieceMesh, pa, this.ctx.mats.plain, true);
		this.rebuildGhosts();
		this.rebuildBody();
	}

	private rebuildGhosts(): void
	{
		const L = this.lot;
		const a = new GeoAccum();
		if (L)
		{
			const f = new Frame(L.x, L.y, L.z, L.rot);
			for (let i = 0; i < this.ghosts.length; i++)
			{
				const p = this.pieces[this.ghosts[i]];
				if (p && this.ghosts[i] >= this.placed) box(a, f, p.x0 - 0.03, p.y0 - 0.03, p.z0 - 0.03, p.x1 + 0.03, p.y1 + 0.03, p.z1 + 0.03, [1, 1, 1]);
			}
		}
		this.ghostMesh = this.swap(this.ghostMesh, a, this.ghostMat, false);
	}

	private swap(old: THREE.Mesh, a: GeoAccum, mat: THREE.Material, shadows: boolean): THREE.Mesh
	{
		const gw = this.ctx.world.graphicsWorld;
		if (old) { gw.remove(old); old.geometry.dispose(); }
		if (a.empty) return null;
		const m = new THREE.Mesh(a.toGeometry(), mat);
		m.castShadow = false;
		m.receiveShadow = shadows;
		m.matrixAutoUpdate = false;
		m.updateMatrix();
		m.name = 'realismConstruction';
		gw.add(m);
		return m;
	}

	private disposeSite(): void
	{
		this.siteMesh = this.swap(this.siteMesh, new GeoAccum(), null, false);
		this.pieceMesh = this.swap(this.pieceMesh, new GeoAccum(), null, false);
		this.ghostMesh = this.swap(this.ghostMesh, new GeoAccum(), null, false);
		if (this.body) { this.ctx.world.physicsWorld.remove(this.body); this.body = null; }
	}

	private siteGeometry(a: GeoAccum, f: Frame): void
	{
		const hw = LOT_W / 2, hd = LOT_D / 2;
		const post = [0.45, 0.46, 0.47], screen = [0.18, 0.3, 0.22];
		// fence: posts every 3 m, green screen panels, gate gap of 6 m at the front centre
		const run = (x0: number, z0: number, x1: number, z1: number) =>
		{
			const len = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0));
			const n = Math.max(1, Math.round(len / 3));
			for (let i = 0; i <= n; i++)
			{
				const t = i / n, px = x0 + (x1 - x0) * t, pz = z0 + (z1 - z0) * t;
				box(a, f, px - 0.05, -0.8, pz - 0.05, px + 0.05, 2.1, pz + 0.05, post);
			}
			const tx = (x1 - x0) / len, tz = (z1 - z0) / len;
			if (Math.abs(tx) > Math.abs(tz)) box(a, f, Math.min(x0, x1), -0.6, z0 - 0.02, Math.max(x0, x1), 2.0, z0 + 0.02, screen);
			else box(a, f, x0 - 0.02, -0.6, Math.min(z0, z1), x0 + 0.02, 2.0, Math.max(z0, z1), screen);
		};
		run(-hw, -hd, hw, -hd);
		run(-hw, -hd, -hw, hd);
		run(hw, -hd, hw, hd);
		run(-hw, hd, -3, hd);
		run(3, hd, hw, hd);
		// gate sign
		box(a, f, -3.2, 2.1, hd - 0.05, -0.4, 2.9, hd + 0.05, [0.95, 0.78, 0.1]);
		box(a, f, 0.4, 2.1, hd - 0.05, 3.2, 2.9, hd + 0.05, [0.95, 0.78, 0.1]);
		// site office trailer
		box(a, f, -13, 0, 5.2, -7, 2.7, 7.6, [0.92, 0.92, 0.88]);
		box(a, f, -10.5, 0, 7.6, -9.5, 2.1, 7.7, [0.35, 0.36, 0.38]);
		box(a, f, -12.4, 1.3, 7.6, -11.2, 2.1, 7.68, [0.55, 0.7, 0.85]);
		box(a, f, -8.8, 1.3, 7.6, -7.6, 2.1, 7.68, [0.55, 0.7, 0.85]);
		box(a, f, -10.8, 0, 7.7, -9.2, 0.35, 8.5, [0.4, 0.4, 0.42]);
		// brick pallets and lumber
		for (let i = 0; i < 4; i++) box(a, f, 8 + (i % 2) * 1.4, 0, 6 + Math.floor(i / 2) * 1.4, 9.2 + (i % 2) * 1.4, 1.0, 7.2 + Math.floor(i / 2) * 1.4, [0.62, 0.28, 0.2]);
		for (let i = 0; i < 5; i++) box(a, f, 9, 0.18 * i, -9 + i * 0.05, 13, 0.18 * i + 0.17, -7.8 + i * 0.05, [0.72, 0.55, 0.32]);
		// scaffolding along the back of the house
		const sz = BZ - 5.6;
		for (let x = -7; x <= 7.01; x += 2.33)
		{
			box(a, f, BX + x - 0.04, 0, sz - 0.04, BX + x + 0.04, 6.2, sz + 0.04, post);
			box(a, f, BX + x - 0.04, 0, sz - 1.04, BX + x + 0.04, 6.2, sz - 0.96, post);
		}
		for (const y of [2.0, 4.0, 6.0]) box(a, f, BX - 7, y, sz - 1.0, BX + 7, y + 0.06, sz, [0.62, 0.46, 0.26]);
		// porta-potty and dumpster
		box(a, f, 12, 0, 9.5, 13.3, 2.3, 10.8, [0.2, 0.45, 0.75]);
		box(a, f, -14, 0, -11.5, -10.5, 1.4, -9.5, [0.25, 0.42, 0.3]);
		// tower crane
		if (this.settings.crane)
		{
			const y = [0.95, 0.75, 0.1];
			box(a, f, 10.4, 0, -11.6, 12.6, 0.8, -9.4, [0.55, 0.55, 0.55]);
			for (const cx of [10.8, 12.2]) for (const cz of [-11.2, -9.8]) box(a, f, cx - 0.08, 0.8, cz - 0.08, cx + 0.08, 22, cz + 0.08, y);
			for (let h = 2.8; h < 22; h += 2.6) box(a, f, 10.7, h, -11.3, 12.3, h + 0.12, -9.7, y);
			box(a, f, 10.5, 22, -11.4, 12.5, 23.4, -9.6, y);
			box(a, f, 11.3, 23.4, -10.6 - 18, 11.7, 23.9, -10.6 + 6, y);
			box(a, f, 10.9, 22.4, -10.6 + 4, 12.1, 23.4, -10.6 + 6, [0.5, 0.5, 0.5]);   // counterweight
			box(a, f, 11.45, 14, -24.05, 11.55, 23.4, -23.95, [0.15, 0.15, 0.15]);       // hook cable
			box(a, f, 11.2, 13.6, -24.3, 11.8, 14.0, -23.7, [0.9, 0.2, 0.1]);
		}
		// cones at the gate
		for (const cx of [-4, 4]) cyl(a, f, cx, 0, hd + 1.0, 0.75, 0.22, 0.03, 8, [0.95, 0.42, 0.06]);
	}

	private buildDone(L: Lot): void
	{
		const f = new Frame(L.x, L.y, L.z, L.rot);
		const a = new GeoAccum();
		box(a, f, BX - 6.6, -0.6, BZ - 5.1, BX + 6.6, SLAB_TOP, BZ + 5.1, [0.66, 0.66, 0.64]);
		for (let i = 0; i < this.pieces.length; i++) this.pieceBox(a, f, this.pieces[i], PIECE_COLORS[this.pieces[i].stage]);
		// finished touches: door, windows, sign
		box(a, f, BX - 1.1, SLAB_TOP, BZ + 4.32, BX + 1.1, SLAB_TOP + 2.2, BZ + 4.4, [0.38, 0.25, 0.16]);
		for (const wx of [-3.6, 3.6]) box(a, f, BX + wx - 0.9, SLAB_TOP + 1.1, BZ + 4.55, BX + wx + 0.9, SLAB_TOP + 2.3, BZ + 4.6, [0.55, 0.7, 0.85]);
		const m = this.swap(null, a, this.ctx.mats.plain, true);
		if (m) this.doneMeshes.push(m);
		const b = new CANNON.Body({ mass: 0 });
		b.position.set(L.x, L.y, L.z);
		b.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), L.rot);
		this.addPieceShapes(b, this.pieces.length, true);
		this.ctx.world.physicsWorld.addBody(b);
		this.doneBodies.push(b);
	}

	private addPieceShapes(b: CANNON.Body, n: number, slab: boolean): void
	{
		const sh = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
			b.addShape(new CANNON.Box(new CANNON.Vec3((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2)), new CANNON.Vec3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
		if (slab) sh(BX - 6.6, -0.6, BZ - 5.1, BX + 6.6, SLAB_TOP, BZ + 5.1);
		for (let i = 0; i < n; i++)
		{
			const p = this.pieces[i];
			if (p.stage === 0 || p.stage === 1 || p.stage === 3 || p.stage === 4) sh(p.x0, p.y0, p.z0, p.x1, p.y1, p.z1);
		}
	}

	private rebuildBody(): void
	{
		const L = this.lot;
		if (this.body) { this.ctx.world.physicsWorld.remove(this.body); this.body = null; }
		if (!L) return;
		const b = new CANNON.Body({ mass: 0 });
		b.position.set(L.x, L.y, L.z);
		b.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), L.rot);
		this.addPieceShapes(b, this.placed, true);
		// trailer, pallets, dumpster, crane base, fence (gate open)
		const sh = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
			b.addShape(new CANNON.Box(new CANNON.Vec3((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2)), new CANNON.Vec3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
		sh(-13, 0, 5.2, -7, 2.7, 7.6);
		sh(8, 0, 6, 10.6, 1.0, 8.6);
		sh(-14, 0, -11.5, -10.5, 1.4, -9.5);
		sh(12, 0, 9.5, 13.3, 2.3, 10.8);
		if (this.settings.crane) sh(10.4, 0, -11.6, 12.6, 3, -9.4);
		const hw = LOT_W / 2, hd = LOT_D / 2;
		sh(-hw, 0, -hd - 0.05, hw, 2.1, -hd + 0.05);
		sh(-hw - 0.05, 0, -hd, -hw + 0.05, 2.1, hd);
		sh(hw - 0.05, 0, -hd, hw + 0.05, 2.1, hd);
		sh(-hw, 0, hd - 0.05, -3, 2.1, hd + 0.05);
		sh(3, 0, hd - 0.05, hw, 2.1, hd + 0.05);
		this.ctx.world.physicsWorld.addBody(b);
		this.body = b;
	}

	// ------------------------------------------------------------------ saving

	private load(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			const raw = ls ? ls.getItem(CONSTRUCTION_KEY) : null;
			if (!raw) return;
			const d = JSON.parse(raw);
			if (!d || d.v !== 1 || d.seed !== this.ctx.data.seed) return;   // another map: start over
			this.project = Math.max(1, Math.floor(+d.project) || 1);
			this.placed = Math.max(0, Math.min(this.pieces.length - 1, Math.floor(+d.placed) || 0));
			this.stock = Math.max(0, Math.min(999, Math.floor(+d.stock) || 0));
			if (d.done instanceof Array)
			{
				for (let i = 0; i < d.done.length && i < 12; i++)
				{
					const L = d.done[i];
					if (L && [L.x, L.y, L.z, L.rot].every((v: any) => typeof v === 'number' && isFinite(v))) this.done.push({ x: L.x, y: L.y, z: L.z, rot: L.rot, w: LOT_W, d: LOT_D });
				}
			}
		}
		catch (e) { /* corrupt: start over */ }
	}

	public save(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			if (!ls) return;
			const r = (v: number) => Math.round(v * 1000) / 1000;
			ls.setItem(CONSTRUCTION_KEY, JSON.stringify({
				v: 1, seed: this.ctx.data.seed, project: this.project, placed: this.placed, stock: this.stock,
				done: this.done.map((L) => ({ x: r(L.x), y: r(L.y), z: r(L.z), rot: r(L.rot) })),
			}));
		}
		catch (e) { /* ignore */ }
	}
}
