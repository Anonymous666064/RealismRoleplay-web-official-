/*
 * RealismScatter.ts
 * -----------------
 * Shared helpers for the build-time "dressing" passes (RealismVegetation.ts,
 * RealismHoodDetails.ts). They only READ the generated map, so they never
 * change what RealismMapData / RealismBuildings produce.
 *
 *  - ScatterSpace: a spatial hash of everything already standing (building
 *    footprints, trees, lamps, map props, junctions) plus whatever the dressing
 *    passes place, so new things never end up inside a wall, on a road, in a
 *    doorway or on top of each other.
 *  - MatrixBatcher: GPU instancing with a full transform per instance (yaw,
 *    tilt, non-uniform scale), grouped per map chunk so distance culling
 *    (RealismPerformance) and frustum culling stay tight. Materials go through
 *    instMat(). Any asset can be swapped for your own .glb with
 *    realism-config.js -> city.props.<name> (model / scale / rotation / offset /
 *    disabled), like the street furniture.
 */

import * as THREE from 'three';
import { RealismCtx, chunkKey, instMat } from './RealismContext';
import { Building, Road } from './RealismMapData';
import { AssetPart, loadGLB, bakeParts, overrideMatrix } from './RealismAssets';
import { AssetOverride } from './RealismConfig';

// ---------------------------------------------------------------------------
// Spatial occupancy
// ---------------------------------------------------------------------------

interface Circle { x: number; z: number; r: number; }
interface ORect { x: number; z: number; hw: number; hd: number; c: number; s: number; }

const CELL = 8;
const PAD = 1.5;   // largest query radius: objects are filed in every cell a query could reach them from

/** Point (x, z) inside building `b`'s footprint grown by `m` metres. */
export function inBuilding(b: Building, x: number, z: number, m: number): boolean
{
	const dx = x - b.x, dz = z - b.z;
	const c = Math.cos(b.rot), s = Math.sin(b.rot);
	const lx = dx * c - dz * s, lz = dx * s + dz * c;
	return Math.abs(lx) <= b.w / 2 + m && Math.abs(lz) <= b.d / 2 + m;
}

/** Highest point of a building (roof ridge included, roughly). */
export function buildingTop(b: Building): number
{
	return b.baseY + b.h + (b.roof === 'gable' ? Math.min(b.w, b.d) * 0.35 + 0.6 : 0.4);
}

export class ScatterSpace
{
	private ctx: RealismCtx;
	private bGrid: { [key: string]: number[] } = {};
	private cGrid: { [key: string]: Circle[] } = {};
	private rGrid: { [key: string]: ORect[] } = {};
	private kGrid: { [key: string]: ORect[] } = {};
	private lake: { x: number; z: number; rx: number; rz: number };

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		const data = ctx.data;
		this.lake = data.lake;
		const bs = data.buildings;
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			const r = Math.sqrt(b.w * b.w + b.d * b.d) / 2 + 3;
			for (let gx = Math.floor((b.x - r) / CELL); gx <= Math.floor((b.x + r) / CELL); gx++)
				for (let gz = Math.floor((b.z - r) / CELL); gz <= Math.floor((b.z + r) / CELL); gz++)
					(this.bGrid[gx + '_' + gz] || (this.bGrid[gx + '_' + gz] = [])).push(i);
		}
		for (let i = 0; i < data.trees.length; i++) this.addCircle(data.trees[i].x, data.trees[i].z, 0.9 * data.trees[i].s);
		for (let i = 0; i < data.lamps.length; i++) this.addCircle(data.lamps[i].x, data.lamps[i].z, 0.6);
		for (let i = 0; i < data.props.length; i++)
		{
			const p = data.props[i];
			if (p.type === 'fence') this.addRect(p.x, p.z, (p.len || 3) / 2, 0.25, p.r);
			else if (p.type === 'wreckedCar') this.addRect(p.x, p.z, 1.1, 2.4, p.r);
			else if (p.type === 'dumpster' || p.type === 'bench' || p.type === 'picnicTable' || p.type === 'bleacher') this.addRect(p.x, p.z, p.type === 'bleacher' ? 3.2 : 1.1, p.type === 'bleacher' ? 1.6 : 0.9, p.r);
			else this.addCircle(p.x, p.z, p.type === 'mattress' ? 1.1 : 0.6);
		}
		for (let i = 0; i < data.intersections.length; i++)
		{
			const J = data.intersections[i];
			this.addCircle(J.x, J.z, J.crossHW + 3.5);
		}
		// doorways, porches, front paths and driveways of every house stay clear
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.kind !== 'house' || b.custom) continue;
			const ks = houseKeepOut(b);
			for (let k = 0; k < ks.length; k++)
			{
				const q = ks[k];
				const c = local(b, (q[0] + q[2]) / 2, (q[1] + q[3]) / 2);
				this.addRectTo(this.kGrid, c[0], c[1], (q[2] - q[0]) / 2, (q[3] - q[1]) / 2, b.rot);
			}
		}
	}

	private addRectTo(grid: { [key: string]: ORect[] }, x: number, z: number, hw: number, hd: number, rot: number): void
	{
		const rr = Math.sqrt(hw * hw + hd * hd) + PAD;
		const o: ORect = { x: x, z: z, hw: hw, hd: hd, c: Math.cos(rot), s: Math.sin(rot) };
		for (let gx = Math.floor((x - rr) / CELL); gx <= Math.floor((x + rr) / CELL); gx++)
			for (let gz = Math.floor((z - rr) / CELL); gz <= Math.floor((z + rr) / CELL); gz++)
				(grid[gx + '_' + gz] || (grid[gx + '_' + gz] = [])).push(o);
	}

	private inRects(grid: { [key: string]: ORect[] }, x: number, z: number, r: number): boolean
	{
		const rs = grid[Math.floor(x / CELL) + '_' + Math.floor(z / CELL)];
		if (!rs) return false;
		for (let i = 0; i < rs.length; i++)
		{
			const o = rs[i];
			const dx = x - o.x, dz = z - o.z;
			const lx = dx * o.c - dz * o.s, lz = dx * o.s + dz * o.c;
			if (Math.abs(lx) <= o.hw + r && Math.abs(lz) <= o.hd + r) return true;
		}
		return false;
	}

	/** Inside a house's door / porch / path / driveway keep-out (see houseKeepOut). */
	public inDoorway(x: number, z: number, r: number): boolean
	{
		return this.inRects(this.kGrid, x, z, r);
	}

	public addCircle(x: number, z: number, r: number): void
	{
		const rp = r + PAD;
		for (let gx = Math.floor((x - rp) / CELL); gx <= Math.floor((x + rp) / CELL); gx++)
			for (let gz = Math.floor((z - rp) / CELL); gz <= Math.floor((z + rp) / CELL); gz++)
				(this.cGrid[gx + '_' + gz] || (this.cGrid[gx + '_' + gz] = [])).push({ x: x, z: z, r: r });
	}

	/** Oriented rectangle: half extents along its local x / z, yaw `rot` (same convention as buildings). */
	public addRect(x: number, z: number, hw: number, hd: number, rot: number): void
	{
		this.addRectTo(this.rGrid, x, z, hw, hd, rot);
	}

	/** First building whose footprint (grown by m) contains (x, z), or null. */
	public buildingAt(x: number, z: number, m: number): Building
	{
		const list = this.bGrid[Math.floor(x / CELL) + '_' + Math.floor(z / CELL)];
		if (!list) return null;
		const bs = this.ctx.data.buildings;
		for (let i = 0; i < list.length; i++) if (inBuilding(bs[list[i]], x, z, m)) return bs[list[i]];
		return null;
	}

	/** Does anything solid sit above height y at (x, z)? (used for wires) */
	public blockedAbove(x: number, y: number, z: number): boolean
	{
		const list = this.bGrid[Math.floor(x / CELL) + '_' + Math.floor(z / CELL)];
		if (!list) return false;
		const bs = this.ctx.data.buildings;
		for (let i = 0; i < list.length; i++)
		{
			const b = bs[list[i]];
			if (inBuilding(b, x, z, 0.3) && buildingTop(b) > y - 0.3 && b.baseY < y) return true;
		}
		return false;
	}

	/** Free of placed objects (circles / rects) within r. */
	public clearOfObjects(x: number, z: number, r: number): boolean
	{
		const key = Math.floor(x / CELL) + '_' + Math.floor(z / CELL);
		const cs = this.cGrid[key];
		if (cs) for (let i = 0; i < cs.length; i++)
		{
			const c = cs[i];
			const dx = x - c.x, dz = z - c.z, rr = r + c.r;
			if (dx * dx + dz * dz < rr * rr) return false;
		}
		if (this.inRects(this.rGrid, x, z, r)) return false;
		return true;
	}

	/** Usable ground: dry land, not in the lake, not too steep. */
	public ground(x: number, z: number): boolean
	{
		const d = this.ctx.data;
		const h = d.heightAt(x, z);
		if (h < 0.6) return false;
		const L = this.lake;
		const lx = (x - L.x) / (L.rx * 1.25), lz = (z - L.z) / (L.rz * 1.25);
		if (lx * lx + lz * lz < 1) return false;
		const sx = d.heightAt(x + 1, z) - d.heightAt(x - 1, z), sz = d.heightAt(x, z + 1) - d.heightAt(x, z - 1);
		return Math.abs(sx) < 1.3 && Math.abs(sz) < 1.3;
	}

	/**
	 * Full check: on usable ground, at least `roadGap` metres from any road edge,
	 * outside every building footprint (grown by r + bMargin), clear of placed objects.
	 */
	public free(x: number, z: number, r: number, roadGap: number, bMargin?: number): boolean
	{
		if (this.ctx.data.roadClearance(x, z) < roadGap + r) return false;
		if (this.buildingAt(x, z, r + (bMargin === undefined ? 0.35 : bMargin))) return false;
		if (!this.clearOfObjects(x, z, r)) return false;
		if (this.inDoorway(x, z, r)) return false;
		return this.ground(x, z);
	}
}

/** One shared ScatterSpace per world build, so all dressing passes avoid each other. */
export function scatterSpace(ctx: RealismCtx): ScatterSpace
{
	const c: any = ctx;
	if (!c.__scatter) c.__scatter = new ScatterSpace(ctx);
	return c.__scatter;
}

/**
 * Areas around a house that must stay clear (front path to the street, porch, garage
 * driveway, back door), in the house's local frame: [x0, z0, x1, z1].
 * Mirrors RealismBuildings.ts houseExterior()/door placement. If the front door or
 * garage placement changes there, update this function.
 */
export function houseKeepOut(b: Building): number[][]
{
	const hw = b.w / 2, hd = b.d / 2;
	const out: number[][] = [];
	const doorU = Math.max(0.15 + 1.6, b.w * 0.3);
	const dx = -hw + doorU;
	const pw = Math.min(b.w * 0.45, 4.2);
	// porch + steps + path to the street
	out.push([dx - pw / 2 - 0.6, hd - 0.2, dx + pw / 2 + 0.6, hd + 2.6]);
	out.push([dx - 1.3, hd, dx + 1.3, hd + 14]);
	// garage + driveway on wide single-storey houses (kept clear on every house, doors may move)
	if (b.w >= 12.5) out.push([hw - 3.8, hd - 0.2, hw - 0.1, hd + 14]);
	// back door
	const bu = b.w * 0.35;
	out.push([hw - bu - 1.2, -hd - 2.6, hw - bu + 1.2, -hd + 0.2]);
	return out;
}

export function inKeepOut(b: Building, rects: number[][], x: number, z: number, r: number): boolean
{
	const dx = x - b.x, dz = z - b.z;
	const c = Math.cos(b.rot), s = Math.sin(b.rot);
	const lx = dx * c - dz * s, lz = dx * s + dz * c;
	for (let i = 0; i < rects.length; i++)
	{
		const q = rects[i];
		if (lx >= q[0] - r && lx <= q[2] + r && lz >= q[1] - r && lz <= q[3] + r) return true;
	}
	return false;
}

/** World point from a building's local frame (local +Z = front). */
export function local(b: Building, lx: number, lz: number): number[]
{
	const c = Math.cos(b.rot), s = Math.sin(b.rot);
	return [b.x + lx * c + lz * s, b.z - lx * s + lz * c];
}

/** Point, tangent and left normal on a road at arc length s. */
export function roadAt(road: Road, s: number): { x: number; z: number; y: number; tx: number; tz: number; nx: number; nz: number; i: number; t: number }
{
	const pts = road.pts;
	let i = 0;
	while (i < pts.length - 2 && pts[i + 1].s < s) i++;
	const a = pts[i], b = pts[i + 1];
	const t = Math.max(0, Math.min(1, (s - a.s) / Math.max(b.s - a.s, 1e-6)));
	let tx = b.x - a.x, tz = b.z - a.z;
	const tl = Math.sqrt(tx * tx + tz * tz) || 1;
	tx /= tl; tz /= tl;
	return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t, tx: tx, tz: tz, nx: -tz, nz: tx, i: i, t: t };
}

/** Yaw that turns local +X onto the world direction (dx, dz). */
export function yawX(dx: number, dz: number): number
{
	return Math.atan2(-dz, dx);
}

// ---------------------------------------------------------------------------
// Instancing with full transforms
// ---------------------------------------------------------------------------

interface MGroup { name: string; variant: number; cat: string; cast: boolean; mats: number[]; xs: number[]; ys: number[]; zs: number[]; maxScale: number; meshes: THREE.Object3D[]; }

const tmpM = new THREE.Matrix4(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), Y_AXIS = new THREE.Vector3(0, 1, 0);

export class MatrixBatcher
{
	private ctx: RealismCtx;
	private overrides: { [name: string]: AssetOverride };
	private makers: { [name: string]: (variant: number) => AssetPart[] } = {};
	private procs: { [key: string]: AssetPart[] } = {};
	private groups: { [key: string]: MGroup } = {};
	private keys: string[] = [];
	private noOverride: { [name: string]: boolean } = {};
	public instanceCount = 0;
	public meshCount = 0;
	public counts: { [name: string]: number } = {};

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.overrides = (ctx.cfg.city && ctx.cfg.city.props) || {};
	}

	/** `overridable: false` keeps the built-in look even if city.props has the name (decals). */
	public define(name: string, maker: (variant: number) => AssetPart[], overridable?: boolean): void
	{
		this.makers[name] = maker;
		if (overridable === false) this.noOverride[name] = true;
	}

	public isDisabled(name: string): boolean
	{
		const ov = this.overrides[name];
		return !!(ov && ov.disabled);
	}

	/** Adds an instance from a quaternion + scale. `chunk`: grouping size in metres. */
	public addQ(name: string, variant: number, x: number, y: number, z: number, q: THREE.Quaternion, sx: number, sy: number, sz: number, cat: string, chunk: number, cast?: boolean): boolean
	{
		if (this.isDisabled(name)) return false;
		const key = name + '|' + variant + '|' + cat + '|' + chunk + '|' + chunkKey(x, z, chunk);
		let g = this.groups[key];
		if (g === undefined)
		{
			const ov = this.overrides[name];
			const c = ov && ov.castShadow !== undefined && !this.noOverride[name] ? ov.castShadow : (cast === undefined ? true : cast);
			g = { name: name, variant: variant, cat: cat, cast: c, mats: [], xs: [], ys: [], zs: [], maxScale: 1, meshes: [] };
			this.groups[key] = g;
			this.keys.push(key);
		}
		tmpP.set(x, y, z);
		tmpS.set(sx, sy, sz);
		tmpM.compose(tmpP, q, tmpS);
		const e = tmpM.elements;
		for (let k = 0; k < 16; k++) g.mats.push(e[k]);
		g.xs.push(x); g.ys.push(y); g.zs.push(z);
		g.maxScale = Math.max(g.maxScale, sx, sy, sz);
		this.instanceCount++;
		this.counts[name] = (this.counts[name] || 0) + 1;
		return true;
	}

	/** Adds an instance turned by yaw only. */
	public add(name: string, variant: number, x: number, y: number, z: number, ry: number, sx: number, sy: number, sz: number, cat: string, chunk: number, cast?: boolean): boolean
	{
		tmpQ.setFromAxisAngle(Y_AXIS, ry);
		return this.addQ(name, variant, x, y, z, tmpQ, sx, sy, sz, cat, chunk, cast);
	}

	private procParts(name: string, variant: number): AssetPart[]
	{
		const key = name + '|' + variant;
		if (this.procs[key] === undefined) this.procs[key] = this.makers[name] ? this.makers[name](variant) : [];
		return this.procs[key];
	}

	/**
	 * Takes the built-in meshes of `name` whose variant passes `pick` out of the scene for good
	 * (used when your own model has loaded for those instances). Returns how many meshes went.
	 */
	public retire(name: string, pick: (variant: number) => boolean): number
	{
		let n = 0;
		for (let k = 0; k < this.keys.length; k++)
		{
			const g = this.groups[this.keys[k]];
			if (g.name !== name || !pick(g.variant)) continue;
			for (let m = 0; m < g.meshes.length; m++)
			{
				this.ctx.world.graphicsWorld.remove(g.meshes[m]);
				g.meshes[m].visible = false;
				g.meshes[m].userData.realismRemoved = true;
				n++;
			}
			g.meshes = [];
		}
		this.meshCount -= n;
		return n;
	}

	public build(): void
	{
		const byName: { [name: string]: MGroup[] } = {};
		for (let k = 0; k < this.keys.length; k++)
		{
			const g = this.groups[this.keys[k]];
			(byName[g.name] || (byName[g.name] = [])).push(g);
			this.instantiate(g, this.procParts(g.name, g.variant));
		}
		for (const name in byName)
		{
			if (!byName.hasOwnProperty(name) || this.noOverride[name]) continue;
			const ov = this.overrides[name];
			if (!ov || !ov.model) continue;
			const groups = byName[name];
			loadGLB(ov.model, (scene) =>
			{
				const parts = bakeParts(this.ctx, scene, overrideMatrix(ov), ov.castShadow !== false);
				if (parts.length === 0) return;
				for (let i = 0; i < groups.length; i++)
				{
					const g = groups[i];
					for (let m = 0; m < g.meshes.length; m++)
					{
						this.ctx.world.graphicsWorld.remove(g.meshes[m]);
						g.meshes[m].visible = false;
						g.meshes[m].userData.realismRemoved = true;
					}
					g.meshes = [];
					this.instantiate(g, parts);
				}
				console.log('[Realism] Using your model for "' + name + '": ' + ov.model);
			});
		}
	}

	private instantiate(g: MGroup, parts: AssetPart[]): void
	{
		const n = g.xs.length;
		if (n === 0) return;
		let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
		for (let i = 0; i < n; i++)
		{
			minX = Math.min(minX, g.xs[i]); maxX = Math.max(maxX, g.xs[i]);
			minY = Math.min(minY, g.ys[i]); maxY = Math.max(maxY, g.ys[i]);
			minZ = Math.min(minZ, g.zs[i]); maxZ = Math.max(maxZ, g.zs[i]);
		}
		const arr = new Float32Array(g.mats);
		for (let k = 0; k < parts.length; k++)
		{
			const part = parts[k];
			if (!part.geom.boundingSphere) part.geom.computeBoundingSphere();
			const pr = part.geom.boundingSphere ? (part.geom.boundingSphere.radius + part.geom.boundingSphere.center.length()) * g.maxScale : 5;
			const geom = part.geom.clone();
			const mesh = new THREE.InstancedMesh(geom, instMat(this.ctx, part.mat), n);
			(mesh.instanceMatrix.array as Float32Array).set(arr);
			mesh.instanceMatrix.needsUpdate = true;
			const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
			const radius = Math.sqrt((maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY) + (maxZ - minZ) * (maxZ - minZ)) / 2 + pr;
			geom.boundingSphere = new THREE.Sphere(center, radius);
			mesh.castShadow = part.cast !== undefined ? part.cast && g.cast : g.cast;
			mesh.receiveShadow = true;
			mesh.matrixAutoUpdate = false;
			mesh.updateMatrix();
			this.ctx.world.graphicsWorld.add(mesh);
			mesh.userData.realismAsset = g.name;
			this.ctx.cull.add(mesh, g.cat, center, radius);
			g.meshes.push(mesh);
			this.meshCount++;
		}
	}
}
