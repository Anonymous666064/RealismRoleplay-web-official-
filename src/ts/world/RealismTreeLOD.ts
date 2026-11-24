/**
 * Tree LOD: only the trees nearest to you use your .glb tree models
 * (realism-config.js -> vegetation.trees / pineTrees). Every other tree keeps the built-in
 * low-poly model, which is what you see in the distance.
 *
 *  - vegetation.nearModels (default 10): how many trees use your model at once.
 *  - vegetation.nearDistance (default 120 m): never farther than this.
 *  - A model file is only downloaded the first time a tree of its kind comes that close,
 *    so pine models load when you reach the hills and forests where the pines are.
 *  - A model that has had no tree near you for 30 s gives its graphics memory back.
 *  - Trunk colliders are the built-in ones for every tree, so nothing changes when a tree swaps.
 */

import * as THREE from 'three';
import { RealismCtx, instMat, gpuOnly } from './RealismContext';
import { VegModelSet, PreparedModel, VegEntry, hash01, vegSettings } from './RealismVegetationModels';
import { IUpdatable } from '../interfaces/IUpdatable';

/** One built-in tree that can swap to a .glb model. */
interface LodTree
{
	x: number; y: number; z: number; r: number;
	kind: string;              // 'tree' | 'pineTree'
	variant: number;           // which of your models (vegetation list index)
	mesh: THREE.InstancedMesh; // built-in instanced mesh it lives in
	slot: number;              // its instance in that mesh
	scale: number;             // size for your model (randomScale)
}

/** Instanced meshes for one of your models, sized for nearModels trees. */
interface Pool
{
	state: 'idle' | 'loading' | 'ready' | 'failed';
	model?: PreparedModel;
	meshes: THREE.InstancedMesh[];
	used: number;
	idleSince: number;
	disposed: boolean;
}

const CELL = 32;
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class TreeLOD implements IUpdatable
{
	public updateOrder = 8;
	public stats = { near: 0, loadedModels: 0 };

	private ctx: RealismCtx;
	private trees: LodTree[] = [];
	private grid: { [key: string]: number[] } = {};
	private sets: { [kind: string]: VegModelSet };
	private pools: { [key: string]: Pool } = {};
	private near: number[] = [];                       // tree indices currently on your model
	private saved: { [i: number]: Float32Array } = {}; // their built-in matrices while hidden
	private nearCount: number;
	private nearDist: number;
	private acc = 1;
	private time = 0;
	private camPos = new THREE.Vector3();
	private tmpM = new THREE.Matrix4();
	private tmpQ = new THREE.Quaternion();
	private tmpP = new THREE.Vector3();
	private tmpS = new THREE.Vector3();
	private yAxis = new THREE.Vector3(0, 1, 0);

	constructor(ctx: RealismCtx, sets: { [kind: string]: VegModelSet })
	{
		this.ctx = ctx;
		this.sets = sets;
		const vs = vegSettings(ctx);
		this.nearCount = vs.nearModels;
		this.nearDist = vs.nearDistance;
	}

	/** True when at least one kind has your models and the near count is above 0. */
	public get active(): boolean
	{
		if (this.nearCount <= 0) return false;
		for (const k in this.sets) if (this.sets.hasOwnProperty(k) && this.sets[k].custom) return true;
		return false;
	}

	/** Registers one built-in tree instance. Only trees whose kind has your models are kept. */
	public add(x: number, y: number, z: number, r: number, kind: string, mesh: THREE.InstancedMesh, slot: number): void
	{
		const set = this.sets[kind];
		if (!set || !set.custom) return;
		const variant = set.pick(x, z, 17);
		const rs = vegSettings(this.ctx).randomScale;
		const scale = 1 + rs * (2 * hash01(x, z, 43) - 1);
		const i = this.trees.length;
		this.trees.push({ x: x, y: y, z: z, r: r, kind: kind, variant: variant, mesh: mesh, slot: slot, scale: scale });
		const key = Math.floor(x / CELL) + '_' + Math.floor(z / CELL);
		(this.grid[key] || (this.grid[key] = [])).push(i);
	}

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		this.time += unscaledTimeStep;
		this.acc += unscaledTimeStep;
		if (this.acc < 0.25) return;
		this.acc = 0;
		this.ctx.world.camera.getWorldPosition(this.camPos);
		this.refresh(this.camPos.x, this.camPos.z);
	}

	/** Picks the nearest trees and moves them between the built-in model and yours. */
	public refresh(px: number, pz: number): void
	{
		// 1. nearest trees within nearDistance, closest first
		const cand: { i: number; d: number }[] = [];
		const R = Math.ceil(this.nearDist / CELL);
		const gx = Math.floor(px / CELL), gz = Math.floor(pz / CELL);
		for (let ring = 0; ring <= R; ring++)
		{
			for (let ax = gx - ring; ax <= gx + ring; ax++)
				for (let az = gz - ring; az <= gz + ring; az++)
				{
					if (Math.max(Math.abs(ax - gx), Math.abs(az - gz)) !== ring) continue;
					const list = this.grid[ax + '_' + az];
					if (list === undefined) continue;
					for (let k = 0; k < list.length; k++)
					{
						const t = this.trees[list[k]];
						const dx = t.x - px, dz = t.z - pz;
						const d = dx * dx + dz * dz;
						if (d <= this.nearDist * this.nearDist) cand.push({ i: list[k], d: d });
					}
				}
			// a full ring beyond the n-th closest can't hold anything closer
			if (cand.length >= this.nearCount)
			{
				cand.sort((a, b) => a.d - b.d);
				const nth = Math.sqrt(cand[this.nearCount - 1].d);
				if (nth <= ring * CELL) break;
			}
		}
		cand.sort((a, b) => a.d - b.d);
		const want: number[] = [];
		for (let k = 0; k < cand.length && want.length < this.nearCount; k++)
		{
			const t = this.trees[cand[k].i];
			const pool = this.pool(t);
			if (pool.state === 'failed') continue;       // that model can't load: stays built-in
			if (pool.state !== 'ready') continue;        // still downloading: built-in until it arrives
			want.push(cand[k].i);
		}

		// 2. trees leaving the near set get their built-in model back
		const dirty = new Set<THREE.InstancedMesh>();
		for (let k = 0; k < this.near.length; k++)
		{
			const i = this.near[k];
			if (want.indexOf(i) >= 0) continue;
			const t = this.trees[i];
			const m = this.saved[i];
			if (m) { (t.mesh.instanceMatrix.array as Float32Array).set(m, t.slot * 16); delete this.saved[i]; dirty.add(t.mesh); }
		}
		// 3. trees entering it hide their built-in model
		for (let k = 0; k < want.length; k++)
		{
			const i = want[k];
			if (this.saved[i]) continue;
			const t = this.trees[i];
			const arr = t.mesh.instanceMatrix.array as Float32Array;
			this.saved[i] = arr.slice(t.slot * 16, t.slot * 16 + 16);
			arr.set(ZERO.elements, t.slot * 16);
			dirty.add(t.mesh);
		}
		dirty.forEach((m) => { m.instanceMatrix.needsUpdate = true; });
		this.near = want;

		// 4. fill your model's instances
		for (const key in this.pools) if (this.pools.hasOwnProperty(key)) this.pools[key].used = 0;
		for (let k = 0; k < want.length; k++)
		{
			const t = this.trees[want[k]];
			const pool = this.pool(t);
			this.tmpP.set(t.x, t.y, t.z);
			this.tmpQ.setFromAxisAngle(this.yAxis, t.r);
			this.tmpS.set(t.scale, t.scale, t.scale);
			this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
			for (let p = 0; p < pool.meshes.length; p++) pool.meshes[p].setMatrixAt(pool.used, this.tmpM);
			pool.used++;
		}
		let loaded = 0;
		for (const key in this.pools)
		{
			if (!this.pools.hasOwnProperty(key)) continue;
			const pool = this.pools[key];
			if (pool.state !== 'ready') continue;
			for (let p = 0; p < pool.meshes.length; p++)
			{
				const mesh = pool.meshes[p];
				mesh.count = pool.used;
				mesh.visible = pool.used > 0;
				if (pool.used > 0) mesh.instanceMatrix.needsUpdate = true;
			}
			if (pool.used > 0) { pool.idleSince = this.time; pool.disposed = false; loaded++; }
			else if (!pool.disposed && this.time - pool.idleSince > 30)
			{
				// nothing of this kind near you for 30 s: free its graphics memory (comes back by itself)
				for (let p = 0; p < pool.meshes.length; p++) if (!gpuOnly(pool.meshes[p].geometry as THREE.BufferGeometry)) pool.meshes[p].geometry.dispose();
				pool.disposed = true;
			}
		}
		this.stats.near = want.length;
		this.stats.loadedModels = loaded;
	}

	/** The pool for a tree's model; starts the download the first time a tree of it is near. */
	private pool(t: LodTree): Pool
	{
		const key = t.kind + ':' + t.variant;
		let pool = this.pools[key];
		if (pool !== undefined) return pool;
		pool = { state: 'loading', meshes: [], used: 0, idleSince: this.time, disposed: false };
		this.pools[key] = pool;
		const set = this.sets[t.kind];
		const name = t.kind;
		set.load(t.variant, (model: PreparedModel, e: VegEntry) =>
		{
			pool.model = model;
			for (let p = 0; p < model.parts.length; p++)
			{
				const part = model.parts[p];
				const mesh = new THREE.InstancedMesh(part.geom, instMat(this.ctx, part.mat), Math.max(1, this.nearCount));
				mesh.count = 0;
				mesh.visible = false;
				mesh.frustumCulled = false;   // a few trees around you: cheaper than keeping a bounding sphere right
				mesh.castShadow = part.cast !== false && e.castShadow !== false;
				mesh.receiveShadow = true;
				mesh.matrixAutoUpdate = false;
				mesh.updateMatrix();
				mesh.userData.realismAsset = name;
				this.ctx.world.graphicsWorld.add(mesh);
				pool.meshes.push(mesh);
			}
			pool.state = 'ready';
			console.log('[Realism] Your ' + name + ' model "' + e.model + '" loaded: used on the ' + this.nearCount + ' trees nearest to you.');
			this.acc = 1;   // place it on the next frame
		}, () =>
		{
			pool.state = 'failed';
			console.warn('[Realism] ' + name + ' model could not be loaded: the built-in trees stay.');
		});
		return pool;
	}
}
