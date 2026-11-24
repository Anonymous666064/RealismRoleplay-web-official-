/*
 * RealismAssets.ts
 * ----------------
 * Instanced placement of repeated assets (street lights, hydrants, furniture...)
 * with optional replacement by your own .glb models from realism-config.js.
 *
 * Every built-in asset is drawn procedurally. When the config gives a `model`
 * for it, the .glb is loaded in the background and swapped in for every copy,
 * using GPU instancing, so 300 hydrants still cost one draw call per mesh in
 * the .glb per area of the map.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { RealismCtx, chunkKey, DETAIL_CHUNK, instMat } from './RealismContext';
import { AssetOverride, PlacedModel, BuildingModelRule, scaleVec } from './RealismConfig';
import { GeoAccum } from './RealismGeometry';

export interface AssetPart { geom: THREE.BufferGeometry; mat: THREE.Material; cast?: boolean; }
export interface Placement { x: number; y: number; z: number; ry: number; sx?: number; sy?: number; sz?: number; /** interior room key (RealismRoomLights), -1 / unset = none */ room?: number; }

const DEG = Math.PI / 180;

/** Builds the user transform (offset * rotation * scale) for an override. */
export function overrideMatrix(ov: { scale?: number | number[]; rotation?: number[]; offset?: number[] }): THREE.Matrix4
{
	const s = scaleVec(ov.scale);
	const r = ov.rotation || [0, 0, 0];
	const o = ov.offset || [0, 0, 0];
	const m = new THREE.Matrix4();
	const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((r[0] || 0) * DEG, (r[1] || 0) * DEG, (r[2] || 0) * DEG));
	m.compose(new THREE.Vector3(o[0] || 0, o[1] || 0, o[2] || 0), q, new THREE.Vector3(s[0], s[1], s[2]));
	return m;
}

// ---------------------------------------------------------------------------
// GLB loading with a small cache
// ---------------------------------------------------------------------------

let loader: GLTFLoader;
const sceneCache: { [path: string]: { state: string; scene?: THREE.Object3D; waiting: ((s: THREE.Object3D) => void)[]; failing: (() => void)[] } } = {};

/** Loads (once) and hands over a .glb scene. `failed` (optional) runs if the file can't be loaded. */
export function loadGLB(path: string, done: (scene: THREE.Object3D) => void, failed?: () => void): void
{
	if (!loader) loader = new GLTFLoader();
	let entry = sceneCache[path];
	if (entry === undefined)
	{
		entry = { state: 'loading', waiting: [], failing: [] };
		sceneCache[path] = entry;
		const e = entry;
		loader.load(path, (gltf: any) =>
		{
			e.state = 'ready';
			e.scene = gltf.scene;
			e.failing = [];
			for (let i = 0; i < e.waiting.length; i++) e.waiting[i](gltf.scene);
			e.waiting = [];
		}, undefined, (err: any) =>
		{
			e.state = 'failed';
			e.waiting = [];
			console.warn('[Realism] Could not load model "' + path + '". The built-in model is used instead.', err);
			const f = e.failing;
			e.failing = [];
			for (let i = 0; i < f.length; i++) { try { f[i](); } catch (x) { console.warn('[Realism] fallback after a failed model load threw', x); } }
		});
	}
	if (entry.state === 'ready') done(entry.scene);
	else if (entry.state === 'loading') { entry.waiting.push(done); if (failed) entry.failing.push(failed); }
	else if (entry.state === 'failed' && failed) failed();
}

const cheapCache: { [uuid: string]: THREE.Material } = {};

/** On low / medium lighting, swaps your models' PBR (Standard) materials for cheap Lambert ones (same texture and colour). */
export function cheapMaterial(ctx: RealismCtx, mat: any): THREE.Material
{
	if (!mat || ctx.preset.lighting !== 'lambert' || !(mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial || mat.isMeshPhongMaterial)) return mat;
	if (cheapCache[mat.uuid]) return cheapCache[mat.uuid];
	const m = new THREE.MeshLambertMaterial({
		map: mat.map || null, color: mat.color ? mat.color.clone() : 0xffffff, transparent: !!mat.transparent, opacity: mat.opacity,
		alphaTest: mat.alphaTest || 0, side: mat.side, vertexColors: mat.vertexColors, emissive: mat.emissive ? mat.emissive.clone() : 0x000000, emissiveMap: mat.emissiveMap || null,
	});
	cheapCache[mat.uuid] = m;
	return m;
}

/** Flattens a glTF scene into world-baked parts, with the override transform applied. */
export function bakeParts(ctx: RealismCtx, scene: THREE.Object3D, extra: THREE.Matrix4, castDefault: boolean): AssetPart[]
{
	const parts: AssetPart[] = [];
	scene.updateMatrixWorld(true);
	scene.traverse((o: any) =>
	{
		if (!o.isMesh || !o.geometry) return;
		const g: THREE.BufferGeometry = o.geometry.isBufferGeometry ? o.geometry.clone() : new THREE.BufferGeometry().fromGeometry(o.geometry);
		g.applyMatrix4(o.matrixWorld);
		g.applyMatrix4(extra);
		let mat: THREE.Material = o.material instanceof Array ? o.material[0] : o.material;
		mat = cheapMaterial(ctx, mat);
		try { ctx.world.sky.csm.setupMaterial(mat); } catch (e) { /* unlit material */ }
		parts.push({ geom: g, mat: mat, cast: castDefault });
	});
	return parts;
}

// ---------------------------------------------------------------------------
// Instancer
// ---------------------------------------------------------------------------

interface Group { name: string; variant: number; list: Placement[]; cat: string; cast: boolean; meshes: THREE.Object3D[]; mats?: Float32Array; glow?: boolean[]; slot?: Int32Array; hasRoom?: boolean; }

export class AssetInstancer
{
	private ctx: RealismCtx;
	private overrides: { [name: string]: AssetOverride };
	private procs: { [key: string]: AssetPart[] } = {};
	private makers: { [name: string]: (variant: number) => AssetPart[] } = {};
	private groups: { [key: string]: Group } = {};
	private keys: string[] = [];
	public instanceCount: number = 0;
	/** Interior rooms whose lamps are switched off (RealismRoomLights): their lamp-glow instances are drawn collapsed. */
	public roomOff: { [room: number]: boolean } = {};
	public roomOffCount = 0;

	constructor(ctx: RealismCtx, overrides: { [name: string]: AssetOverride })
	{
		this.ctx = ctx;
		this.overrides = overrides || {};
	}

	/** Registers how to draw the built-in version of an asset. */
	public define(name: string, maker: (variant: number) => AssetPart[]): void
	{
		this.makers[name] = maker;
	}

	public isDisabled(name: string): boolean
	{
		const ov = this.overrides[name];
		return !!(ov && ov.disabled);
	}

	public add(name: string, p: Placement, cat: string, variant?: number, cast?: boolean): void
	{
		if (this.isDisabled(name)) return;
		if (cat === 'interior')
		{
			// interaction anchors (RealismInteractions): beds, seats, toilets, ... are collected as they are placed
			const sink = (this.ctx as any).interactionSink;
			if (sink) sink(name, p, variant || 0);
		}
		const v = variant || 0;
		// interiors: one group per item type for the whole map; refresh() draws only the items near you
		const key = cat === 'interior' ? name + '|' + v + '|interior' : name + '|' + v + '|' + cat + '|' + chunkKey(p.x, p.z, DETAIL_CHUNK);
		let g = this.groups[key];
		if (g === undefined)
		{
			const ov = this.overrides[name];
			const c = ov && ov.castShadow !== undefined ? ov.castShadow : (cast === undefined ? true : cast);
			g = { name: name, variant: v, list: [], cat: cat, cast: c, meshes: [] };
			this.groups[key] = g;
			this.keys.push(key);
		}
		g.list.push(p);
		if (p.room !== undefined && p.room >= 0) g.hasRoom = true;
		this.instanceCount++;
	}

	private procParts(name: string, variant: number): AssetPart[]
	{
		const key = name + '|' + variant;
		if (this.procs[key] === undefined) this.procs[key] = this.makers[name] ? this.makers[name](variant) : [];
		return this.procs[key];
	}

	private lastX = 1e9;
	private lastZ = 1e9;
	private lastLim = -1;
	public drawnInterior = 0;

	/** Switches the lamp glow of one interior room on / off (no new meshes: off instances are drawn collapsed). */
	public setRoomLight(room: number, on: boolean): void
	{
		const was = this.roomOff[room] === true;
		if (was === !on) return;
		if (on) { delete this.roomOff[room]; this.roomOffCount--; }
		else { this.roomOff[room] = true; this.roomOffCount++; }
		this.lastX = 1e9;   // re-upload on the next refresh
	}

	/** Uploads only the interior items within `limit` metres of (x, z). Cheap: called a few times a second. */
	public refresh(x: number, z: number, limit: number): void
	{
		const moved = Math.abs(x - this.lastX) + Math.abs(z - this.lastZ);
		if (moved < 1.5 && limit === this.lastLim) return;
		this.lastX = x; this.lastZ = z; this.lastLim = limit;
		const lim2 = limit > 0 ? limit * limit : -1;
		let drawn = 0;
		for (let k = 0; k < this.keys.length; k++)
		{
			const g = this.groups[this.keys[k]];
			if (g.cat !== 'interior' || !g.mats || g.meshes.length === 0) continue;
			const first = g.meshes[0] as THREE.InstancedMesh;
			const dst = first.instanceMatrix.array as Float32Array;
			let n = 0;
			for (let i = 0; i < g.list.length; i++)
			{
				const t = g.list[i];
				const dx = t.x - x, dz = t.z - z;
				if (dx * dx + dz * dz > lim2) continue;
				dst.set(g.mats.subarray(i * 16, i * 16 + 16), n * 16);
				if (g.slot) g.slot[n] = i;
				n++;
			}
			for (let mi = 0; mi < g.meshes.length; mi++)
			{
				const mesh = g.meshes[mi] as THREE.InstancedMesh;
				if (mi > 0 && n > 0) (mesh.instanceMatrix.array as Float32Array).set(dst.subarray(0, n * 16));
				mesh.count = n;
				mesh.visible = n > 0;
				if (n > 0) mesh.instanceMatrix.needsUpdate = true;
			}
			// lamps of switched-off rooms: collapse their glow instances (same meshes, same draw calls)
			if (this.roomOffCount > 0 && g.hasRoom && g.glow && g.slot && n > 0)
			{
				for (let mi = 0; mi < g.meshes.length; mi++)
				{
					if (!g.glow[mi]) continue;
					const arr = (g.meshes[mi] as THREE.InstancedMesh).instanceMatrix.array as Float32Array;
					for (let j = 0; j < n; j++)
					{
						const rm = g.list[g.slot[j]].room;
						if (rm === undefined || this.roomOff[rm] !== true) continue;
						const o = j * 16;
						for (let e = 0; e < 11; e++) arr[o + e] = 0;
					}
				}
			}
			if (n > 0) drawn += g.meshes.length;
		}
		this.drawnInterior = drawn;
	}

	public build(): void
	{
		const byName: { [name: string]: Group[] } = {};
		for (let k = 0; k < this.keys.length; k++)
		{
			const g = this.groups[this.keys[k]];
			if (byName[g.name] === undefined) byName[g.name] = [];
			byName[g.name].push(g);
			this.instantiate(g, this.procParts(g.name, g.variant));
		}
		// swap in user models
		for (const name in byName)
		{
			if (!byName.hasOwnProperty(name)) continue;
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
					for (let m = 0; m < g.meshes.length; m++) this.ctx.world.graphicsWorld.remove(g.meshes[m]);
					g.meshes.forEach((mesh: any) => { mesh.visible = false; mesh.userData.realismRemoved = true; });
					g.meshes = [];
					this.instantiate(g, parts);
				}
				console.log('[Realism] Using your model for "' + name + '": ' + ov.model);
			});
		}
	}

	private instantiate(g: Group, parts: AssetPart[]): void
	{
		const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
		let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, minY = 1e9, maxY = -1e9;
		for (let i = 0; i < g.list.length; i++)
		{
			const t = g.list[i];
			minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x);
			minZ = Math.min(minZ, t.z); maxZ = Math.max(maxZ, t.z);
			minY = Math.min(minY, t.y); maxY = Math.max(maxY, t.y);
		}
		if (g.cat === 'interior')
		{
			// dynamic instancing: all matrices are kept, only the nearby ones are uploaded
			if (!g.mats)
			{
				g.mats = new Float32Array(g.list.length * 16);
				for (let i = 0; i < g.list.length; i++)
				{
					const t = g.list[i];
					p.set(t.x, t.y, t.z);
					q.setFromAxisAngle(yAxis, t.ry);
					s.set(t.sx || 1, t.sy || 1, t.sz || 1);
					m.compose(p, q, s);
					m.toArray(g.mats, i * 16);
				}
				g.slot = new Int32Array(g.list.length);
			}
			g.glow = [];
			for (let k = 0; k < parts.length; k++)
			{
				const mesh = new THREE.InstancedMesh(parts[k].geom.clone(), instMat(this.ctx, parts[k].mat), g.list.length);
				mesh.count = 0;
				mesh.visible = false;
				mesh.frustumCulled = false;
				mesh.castShadow = parts[k].cast !== undefined ? parts[k].cast && g.cast : g.cast;
				mesh.receiveShadow = true;
				mesh.matrixAutoUpdate = false;
				mesh.updateMatrix();
				this.ctx.world.graphicsWorld.add(mesh);
				g.meshes.push(mesh);
				g.glow.push(parts[k].mat === this.ctx.mats.lampGlow);
			}
			this.lastX = 1e9;   // force a refresh
			return;
		}
		for (let k = 0; k < parts.length; k++)
		{
			const part = parts[k];
			const geom = part.geom.clone();
			if (!part.geom.boundingSphere) part.geom.computeBoundingSphere();
			const pr = part.geom.boundingSphere ? part.geom.boundingSphere.radius + part.geom.boundingSphere.center.length() : 5;
			const mesh = new THREE.InstancedMesh(geom, instMat(this.ctx, part.mat), g.list.length);
			for (let i = 0; i < g.list.length; i++)
			{
				const t = g.list[i];
				p.set(t.x, t.y, t.z);
				q.setFromAxisAngle(yAxis, t.ry);
				s.set(t.sx || 1, t.sy || 1, t.sz || 1);
				m.compose(p, q, s);
				mesh.setMatrixAt(i, m);
			}
			mesh.instanceMatrix.needsUpdate = true;
			const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
			const radius = Math.sqrt((maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY) + (maxZ - minZ) * (maxZ - minZ)) / 2 + pr * 2;
			geom.boundingSphere = new THREE.Sphere(center, radius);
			mesh.castShadow = part.cast !== undefined ? part.cast && g.cast : g.cast;
			mesh.receiveShadow = true;
			mesh.matrixAutoUpdate = false;
			mesh.updateMatrix();
			this.ctx.world.graphicsWorld.add(mesh);
			this.ctx.cull.add(mesh, g.cat, center, radius);
			g.meshes.push(mesh);
		}
	}
}

/** Turns accumulators into asset parts: [[accum, materialName, castShadow?], ...] */
export function partsFrom(ctx: RealismCtx, list: any[][]): AssetPart[]
{
	const out: AssetPart[] = [];
	for (let i = 0; i < list.length; i++)
	{
		const acc: GeoAccum = list[i][0];
		if (acc.empty) continue;
		out.push({ geom: acc.toGeometry(), mat: ctx.mats[list[i][1]], cast: list[i][2] !== false });
	}
	return out;
}

// ---------------------------------------------------------------------------
// One-off placed models (extra models, building replacements)
// ---------------------------------------------------------------------------

function addCollider(ctx: RealismCtx, obj: THREE.Object3D, mode: string): void
{
	if (mode === 'none') return;
	obj.updateMatrixWorld(true);
	if (mode === 'trimesh')
	{
		const verts: number[] = [], idx: number[] = [];
		obj.traverse((o: any) =>
		{
			if (!o.isMesh || !o.geometry || !o.geometry.isBufferGeometry) return;
			const g: THREE.BufferGeometry = o.geometry.clone();
			g.applyMatrix4(o.matrixWorld);
			const pos = g.getAttribute('position');
			const base = verts.length / 3;
			for (let i = 0; i < pos.count; i++) verts.push(pos.getX(i), pos.getY(i), pos.getZ(i));
			if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
			else for (let i = 0; i < pos.count; i++) idx.push(base + i);
		});
		if (verts.length === 0) return;
		const body = new CANNON.Body({ mass: 0 });
		const C: any = CANNON;   // Trimesh exists in cannon.js but is missing from the bundled typings
		body.addShape(new C.Trimesh(verts, idx));
		ctx.world.physicsWorld.addBody(body);
		return;
	}
	const box = new THREE.Box3().setFromObject(obj);
	if (box.isEmpty()) return;
	const size = new THREE.Vector3(), c = new THREE.Vector3();
	box.getSize(size); box.getCenter(c);
	const body = new CANNON.Body({ mass: 0 });
	body.addShape(new CANNON.Box(new CANNON.Vec3(Math.max(size.x / 2, 0.05), Math.max(size.y / 2, 0.05), Math.max(size.z / 2, 0.05))));
	body.position.set(c.x, c.y, c.z);
	ctx.world.physicsWorld.addBody(body);
}

function shadowsOn(obj: THREE.Object3D, cast: boolean): void
{
	obj.traverse((o: any) =>
	{
		if (o.isMesh)
		{
			o.castShadow = cast; o.receiveShadow = true;
			try { const mat = o.material instanceof Array ? o.material[0] : o.material; ctx_setup(mat); } catch (e) { /* ignore */ }
		}
	});
}
let ctx_setup: (m: THREE.Material) => void = () => { /* set in placeModels */ };

/** Places the config's extraModels. */
export function placeExtraModels(ctx: RealismCtx, list: PlacedModel[]): void
{
	ctx_setup = (m) => ctx.world.sky.csm.setupMaterial(m);
	for (let i = 0; i < (list || []).length; i++)
	{
		const pm = list[i];
		if (!pm || !pm.model || !pm.position) continue;
		loadGLB(pm.model, (scene) =>
		{
			const inner = scene.clone();
			const holder = new THREE.Group();
			const wrap = new THREE.Group();
			wrap.applyMatrix4(overrideMatrix(pm));
			wrap.add(inner);
			holder.add(wrap);
			const x = pm.position[0], z = pm.position.length > 2 ? pm.position[2] : pm.position[1];
			const y = pm.position.length > 2 ? pm.position[1] : ctx.data.heightAt(x, z);
			holder.position.set(x, y, z);
			holder.rotation.y = (pm.rotationY || 0) * DEG;
			shadowsOn(holder, pm.castShadow !== false);
			ctx.world.graphicsWorld.add(holder);
			addCollider(ctx, holder, pm.collider || 'box');
		});
	}
}

export function ruleMatches(rule: BuildingModelRule, b: any, roll: number): boolean
{
	if (!rule || !rule.model || !rule.match) return false;
	const m = rule.match;
	if (m.label !== undefined && m.label !== b.label) return false;
	if (m.kind !== undefined && m.kind !== b.kind) return false;
	if (m.district !== undefined && m.district !== (b.district || '')) return false;
	if (m.style !== undefined && m.style !== b.style) return false;
	if (rule.chance !== undefined && roll > rule.chance) return false;
	return true;
}

/** Replaces one generated building with a user model (fit to the footprint or scaled as given). */
export function placeBuildingModel(ctx: RealismCtx, rule: BuildingModelRule, b: any): void
{
	ctx_setup = (m) => ctx.world.sky.csm.setupMaterial(m);
	const gy = b.groundY !== undefined ? b.groundY : ctx.data.heightAt(b.x, b.z);
	// placeholder collider right away so nothing falls through while loading
	const pending = new CANNON.Body({ mass: 0 });
	pending.addShape(new CANNON.Box(new CANNON.Vec3(b.w / 2, Math.max(b.h, 1) / 2, b.d / 2)));
	pending.position.set(b.x, b.baseY + b.h / 2, b.z);
	pending.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), b.rot);
	const collider = rule.collider || 'box';
	if (collider !== 'none') ctx.world.physicsWorld.addBody(pending);
	loadGLB(rule.model, (scene) =>
	{
		const inner = scene.clone();
		const wrap = new THREE.Group();
		wrap.add(inner);
		wrap.applyMatrix4(overrideMatrix({ rotation: rule.rotation, offset: rule.offset, scale: rule.fit === false ? rule.scale : 1 }));
		const holder = new THREE.Group();
		holder.add(wrap);
		if (rule.fit !== false)
		{
			holder.updateMatrixWorld(true);
			const box = new THREE.Box3().setFromObject(holder);
			const size = new THREE.Vector3(); box.getSize(size);
			const extra = scaleVec(rule.scale);
			if (size.x > 0.01 && size.y > 0.01 && size.z > 0.01)
			{
				wrap.scale.multiply(new THREE.Vector3(b.w / size.x * extra[0], (b.h - (gy - b.baseY)) / size.y * extra[1], b.d / size.z * extra[2]));
				holder.updateMatrixWorld(true);
				const box2 = new THREE.Box3().setFromObject(holder);
				const c = new THREE.Vector3(); box2.getCenter(c);
				wrap.position.x -= c.x; wrap.position.z -= c.z; wrap.position.y -= box2.min.y;
			}
		}
		holder.position.set(b.x, gy, b.z);
		holder.rotation.y = b.rot;
		shadowsOn(holder, true);
		ctx.world.graphicsWorld.add(holder);
		if (collider === 'trimesh')
		{
			ctx.world.physicsWorld.remove(pending);
			addCollider(ctx, holder, 'trimesh');
		}
	});
}
