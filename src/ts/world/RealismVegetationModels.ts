/*
 * RealismVegetationModels.ts
 * --------------------------
 * Your own tree / bush / hedge models from realism-config.js -> vegetation.
 *
 * You only give a .glb path and a scale. When the model loads it is:
 *  - flattened (every mesh in the .glb, its node transforms baked in),
 *  - turned by your `rotation`, then measured: its bottom centre becomes the origin,
 *    so it stands on the ground whatever its origin was in Blender,
 *  - merged into as few geometries as possible (one per material) so each map chunk
 *    costs one draw call per material,
 *  - drawn with GPU instancing per map chunk (instMat copies, distance culled like the
 *    built-in vegetation).
 * Trees and bushes keep the model's real size x your scale. Hedges are tiled: the model
 * is repeated along every hedge run and stretched slightly so the run is filled exactly,
 * with its height / depth fitted to the hedge (x your scale). A hedge model exported along
 * Z is turned to run along X by itself.
 *
 * Each placed tree / bush / hedge run picks one variant of its list from its position, so the
 * same seed always gives the same mix. Until a model has loaded (and for good if it fails to
 * load) the built-in model is shown for those instances.
 */

import * as THREE from 'three';
import { RealismCtx, chunkKey, instMat, PhysicsChunks } from './RealismContext';
import { AssetPart, loadGLB, cheapMaterial } from './RealismAssets';
import { VegetationModel, VegetationSettings, scaleVec, DEFAULT_SETTINGS } from './RealismConfig';

export type VegKind = 'tree' | 'pineTree' | 'bush' | 'hedge';

const LIST_KEY: { [k: string]: string } = { tree: 'trees', pineTree: 'pineTrees', bush: 'bushes', hedge: 'hedges' };
const DEG = Math.PI / 180;

/** Built-in variants are encoded as builtin + VARIANT_STRIDE * yourVariant in the instancers. */
export const VARIANT_STRIDE = 10;

export interface VegEntry
{
	model: string;
	scale: number[];
	rotation: number[];
	offset: number[];
	collider: boolean;
	castShadow: boolean;
	weight: number;
}

/** A loaded, measured and merged model, ready for instancing. Sizes are in metres at instance scale 1. */
export interface PreparedModel
{
	parts: AssetPart[];
	size: THREE.Vector3;
	radius: number;
	/** Trunk box (trees): centre offset x / z, half width, height. */
	trunk: { x: number; z: number; hw: number; h: number };
	triangles: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function num(v: any, def: number, lo: number, hi: number): number
{
	const n = typeof v === 'number' && !isNaN(v) ? v : def;
	return Math.max(lo, Math.min(hi, n));
}

/** realism-config.js -> vegetation, made safe (missing section, `vegetation: false`, bad values). */
export function vegSettings(ctx: RealismCtx): VegetationSettings
{
	const c: any = ctx.cfg as any;
	if (c.__vegNorm) return c.__vegNorm;
	const def = DEFAULT_SETTINGS.vegetation;
	let v: any = c.vegetation;
	if (v === false) v = { enabled: false };
	else if (v === true || v === undefined || v === null || typeof v !== 'object') v = {};
	const d = v.density && typeof v.density === 'object' ? v.density : {};
	const out: VegetationSettings = {
		enabled: v.enabled !== false && !(ctx.cfg.city && (ctx.cfg.city as any).vegetation === false),
		trees: v.trees !== undefined ? v.trees : def.trees,
		pineTrees: v.pineTrees !== undefined ? v.pineTrees : def.pineTrees,
		bushes: v.bushes !== undefined ? v.bushes : def.bushes,
		hedges: v.hedges !== undefined ? v.hedges : def.hedges,
		density: {
			trees: num(d.trees, 1, 0, 1),
			bushes: num(d.bushes, 1, 0, 2),
			hedges: num(d.hedges, 1, 0, 2),
		},
		frontHedges: v.frontHedges !== false,
		sideHedges: v.sideHedges !== false,
		randomScale: num(v.randomScale, def.randomScale, 0, 0.9),
		nearModels: Math.round(num(v.nearModels, def.nearModels, 0, 200)),
		nearDistance: num(v.nearDistance, def.nearDistance, 5, 2000),
	};
	c.__vegNorm = out;
	return out;
}

function toEntry(raw: any, kind: VegKind, i: number): VegEntry
{
	if (typeof raw === 'string') raw = { model: raw };
	if (raw && typeof raw === 'object' && raw.model === '') return null;   // placeholder entry: keep the built-in model
	if (!raw || typeof raw !== 'object' || typeof raw.model !== 'string' || !raw.model)
	{
		console.warn('[Realism] vegetation.' + LIST_KEY[kind] + '[' + i + '] has no model path, skipped:', raw);
		return null;
	}
	const vec = (a: any, def: number) => (a instanceof Array ? [a[0] || def, a[1] || def, a[2] || def] : [def, def, def]);
	const s = scaleVec(raw.scale);
	return {
		model: raw.model,
		scale: [s[0] > 0 ? s[0] : 1, s[1] > 0 ? s[1] : 1, s[2] > 0 ? s[2] : 1],
		rotation: vec(raw.rotation, 0),
		offset: vec(raw.offset, 0),
		collider: raw.collider !== undefined ? !!raw.collider : kind !== 'bush',
		castShadow: raw.castShadow !== false,
		weight: typeof raw.weight === 'number' && raw.weight > 0 ? raw.weight : 1,
	};
}

/** Position hash in [0, 1): same spot + salt = same number on every load. */
export function hash01(x: number, z: number, salt: number): number
{
	let h = (Math.floor(x * 8) * 73856093) ^ (Math.floor(z * 8) * 19349663) ^ (salt * 83492791);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	h = Math.imul(h ^ (h >>> 16), 668265263);
	h ^= h >>> 15;
	return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// One list (trees, pineTrees, bushes or hedges)
// ---------------------------------------------------------------------------

export class VegModelSet
{
	public kind: VegKind;
	public entries: VegEntry[] = [];
	private cum: number[] = [];
	private ctx: RealismCtx;
	private prepared: { [i: number]: PreparedModel } = {};

	constructor(ctx: RealismCtx, kind: VegKind)
	{
		this.ctx = ctx;
		this.kind = kind;
		const vs = vegSettings(ctx);
		if (!vs.enabled) return;
		let list: any = (vs as any)[LIST_KEY[kind]];
		if (list && !(list instanceof Array)) list = [list];
		if (!list) list = [];
		let total = 0;
		for (let i = 0; i < list.length; i++)
		{
			const e = toEntry(list[i], kind, i);
			if (!e) continue;
			this.entries.push(e);
			total += e.weight;
			this.cum.push(total);
		}
		for (let i = 0; i < this.cum.length; i++) this.cum[i] /= total || 1;
	}

	/** True when you gave at least one model for this list (the old city.props override is then ignored). */
	public get custom(): boolean { return this.entries.length > 0; }

	/** Variant index for something placed at (x, z). */
	public pick(x: number, z: number, salt: number): number
	{
		if (this.entries.length <= 1) return 0;
		const r = hash01(x, z, salt);
		for (let i = 0; i < this.cum.length; i++) if (r < this.cum[i]) return i;
		return this.cum.length - 1;
	}

	/** Loads variant i (once), prepares it, then calls ready; failed runs if it can't be loaded or is empty. */
	public load(i: number, ready: (m: PreparedModel, e: VegEntry) => void, failed: () => void): void
	{
		const e = this.entries[i];
		if (!e) { failed(); return; }
		loadGLB(e.model, (scene) =>
		{
			let m = this.prepared[i];
			if (m === undefined)
			{
				try { m = prepareModel(this.ctx, scene, e, this.kind); }
				catch (err) { console.warn('[Realism] Could not use vegetation model "' + e.model + '":', err); m = null; }
				this.prepared[i] = m;
			}
			if (!m) { failed(); return; }
			ready(m, e);
		}, failed);
	}
}

// ---------------------------------------------------------------------------
// Prepare a loaded scene: flatten, normalise, merge per material
// ---------------------------------------------------------------------------

interface RawPiece { geom: THREE.BufferGeometry; mat: THREE.Material; }

/** Every visible mesh of the scene as world-baked geometries, one per material (multi-material meshes are split). */
function flatten(scene: THREE.Object3D): RawPiece[]
{
	const out: RawPiece[] = [];
	scene.updateMatrixWorld(true);
	scene.traverse((o: any) =>
	{
		if (!o.isMesh || !o.geometry || o.visible === false) return;
		let g: THREE.BufferGeometry = o.geometry.isBufferGeometry ? o.geometry.clone() : new THREE.BufferGeometry().fromGeometry(o.geometry);
		g.applyMatrix4(o.matrixWorld);
		const mats: THREE.Material[] = o.material instanceof Array ? o.material : [o.material];
		if (o.material instanceof Array && g.groups && g.groups.length > 0)
		{
			if (g.index) g = g.toNonIndexed();
			for (let k = 0; k < g.groups.length; k++)
			{
				const gr = g.groups[k];
				const mat = mats[gr.materialIndex || 0] || mats[0];
				const sub = new THREE.BufferGeometry();
				const count = Math.min(gr.count, (g.getAttribute('position').count - gr.start));
				if (count <= 0) continue;
				for (const name in g.attributes)
				{
					if (!g.attributes.hasOwnProperty(name)) continue;
					const a = g.attributes[name] as THREE.BufferAttribute;
					const arr = (a.array as any).slice(gr.start * a.itemSize, (gr.start + count) * a.itemSize);
					sub.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
				}
				out.push({ geom: sub, mat: mat });
			}
		}
		else out.push({ geom: g, mat: mats[0] });
	});
	return out;
}

/** Same look = same key, so duplicate materials (common in exported .glb files) merge into one draw call. */
function matKey(m: any): string
{
	const col = m.color ? m.color.getHexString() : '-';
	const em = m.emissive ? m.emissive.getHexString() : '-';
	const tex = (t: any) => (t ? t.uuid : '-');
	return [m.type, col, em, tex(m.map), tex(m.normalMap), tex(m.alphaMap), tex(m.emissiveMap), m.transparent ? 1 : 0, m.opacity, m.alphaTest || 0,
		m.side, m.vertexColors ? 1 : 0, m.roughness, m.metalness, m.flatShading ? 1 : 0].join('|');
}

/** Merges geometries that share a material and attribute layout. Keeps position, normal, uv and (if used) color. */
function mergeByMaterial(ctx: RealismCtx, pieces: RawPiece[], cast: boolean): AssetPart[]
{
	const groups: { [key: string]: { mat: THREE.Material; geoms: THREE.BufferGeometry[]; names: string[] } } = {};
	const order: string[] = [];
	for (let i = 0; i < pieces.length; i++)
	{
		const p = pieces[i];
		const g = p.geom;
		if (!g.getAttribute('position')) continue;
		if (!g.getAttribute('normal')) g.computeVertexNormals();
		const mat: any = p.mat || new THREE.MeshLambertMaterial({ color: 0x4a7a3a });
		const names = ['position', 'normal'];
		if (g.getAttribute('uv')) names.push('uv');
		if (g.getAttribute('color') && mat.vertexColors) names.push('color');
		const sig = names.map((n) => n + (g.getAttribute(n) as THREE.BufferAttribute).itemSize).join(',');
		const key = matKey(mat) + '|' + sig;
		if (!groups[key]) { groups[key] = { mat: mat, geoms: [], names: names }; order.push(key); }
		groups[key].geoms.push(g);
	}
	const out: AssetPart[] = [];
	for (let k = 0; k < order.length; k++)
	{
		const grp = groups[order[k]];
		let vcount = 0, icount = 0;
		for (let i = 0; i < grp.geoms.length; i++)
		{
			const g = grp.geoms[i];
			const n = g.getAttribute('position').count;
			vcount += n;
			icount += g.index ? g.index.count : n;
		}
		const merged = new THREE.BufferGeometry();
		for (let a = 0; a < grp.names.length; a++)
		{
			const name = grp.names[a];
			const size = (grp.geoms[0].getAttribute(name) as THREE.BufferAttribute).itemSize;
			const arr = new Float32Array(vcount * size);
			let off = 0;
			for (let i = 0; i < grp.geoms.length; i++)
			{
				const src = grp.geoms[i].getAttribute(name) as THREE.BufferAttribute;
				const n = src.count;
				for (let v = 0; v < n; v++)
				{
					arr[(off + v) * size] = src.getX(v);
					if (size > 1) arr[(off + v) * size + 1] = src.getY(v);
					if (size > 2) arr[(off + v) * size + 2] = src.getZ(v);
					if (size > 3) arr[(off + v) * size + 3] = src.getW(v);
				}
				off += n;
			}
			merged.setAttribute(name, new THREE.BufferAttribute(arr, size));
		}
		const idx = vcount > 65535 ? new Uint32Array(icount) : new Uint16Array(icount);
		let vo = 0, io = 0;
		for (let i = 0; i < grp.geoms.length; i++)
		{
			const g = grp.geoms[i];
			const n = g.getAttribute('position').count;
			if (g.index) for (let j = 0; j < g.index.count; j++) idx[io++] = g.index.getX(j) + vo;
			else for (let j = 0; j < n; j++) idx[io++] = j + vo;
			vo += n;
		}
		merged.setIndex(new THREE.BufferAttribute(idx, 1));
		merged.computeBoundingSphere();
		merged.computeBoundingBox();
		let mat = cheapMaterial(ctx, grp.mat);
		try { ctx.world.sky.csm.setupMaterial(mat); } catch (e) { /* unlit material */ }
		out.push({ geom: merged, mat: mat, cast: cast });
	}
	return out;
}

function transformAll(pieces: RawPiece[], m: THREE.Matrix4): void
{
	for (let i = 0; i < pieces.length; i++) pieces[i].geom.applyMatrix4(m);
}

function boxOf(pieces: RawPiece[]): THREE.Box3
{
	const box = new THREE.Box3();
	for (let i = 0; i < pieces.length; i++)
	{
		pieces[i].geom.computeBoundingBox();
		box.union(pieces[i].geom.boundingBox);
	}
	return box;
}

/** Trunk of a tree model: the footprint of whatever is in its lowest 15% (clamped so a ground disc or roots don't make a wall). */
function measureTrunk(pieces: RawPiece[], size: THREE.Vector3): { x: number; z: number; hw: number; h: number }
{
	const H = size.y, W = Math.max(size.x, size.z);
	const lim = Math.max(0.15 * H, 0.25);
	let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, n = 0;
	for (let i = 0; i < pieces.length; i++)
	{
		const pos = pieces[i].geom.getAttribute('position') as THREE.BufferAttribute;
		for (let v = 0; v < pos.count; v++)
		{
			if (pos.getY(v) > lim) continue;
			const x = pos.getX(v), z = pos.getZ(v);
			x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
			n++;
		}
	}
	const maxHw = Math.min(1.0, Math.max(0.12, W * 0.12));
	let hw = n > 0 ? Math.max(x1 - x0, z1 - z0) / 2 : W * 0.05;
	hw = Math.max(0.08, Math.min(maxHw, hw));
	const cx = n > 0 ? Math.max(-W / 4, Math.min(W / 4, (x0 + x1) / 2)) : 0;
	const cz = n > 0 ? Math.max(-W / 4, Math.min(W / 4, (z0 + z1) / 2)) : 0;
	return { x: cx, z: cz, hw: hw, h: Math.max(1.2, Math.min(H * 0.55, 6)) };
}

export function prepareModel(ctx: RealismCtx, scene: THREE.Object3D, e: VegEntry, kind: VegKind): PreparedModel
{
	const pieces = flatten(scene);
	if (pieces.length === 0) { console.warn('[Realism] Vegetation model "' + e.model + '" has no meshes. The built-in model is used instead.'); return null; }
	// 1. your rotation
	const r = e.rotation;
	if (r[0] || r[1] || r[2]) transformAll(pieces, new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG)));
	let box = boxOf(pieces);
	let size = new THREE.Vector3(); box.getSize(size);
	if (size.x < 1e-4 && size.y < 1e-4 && size.z < 1e-4) { console.warn('[Realism] Vegetation model "' + e.model + '" is empty.'); return null; }
	// 2. hedges run along X: turn a model exported along Z
	if (kind === 'hedge' && size.z > size.x * 1.2)
	{
		transformAll(pieces, new THREE.Matrix4().makeRotationY(Math.PI / 2));
		box = boxOf(pieces);
		box.getSize(size);
	}
	// 3. bottom centre to the origin
	const c = new THREE.Vector3(); box.getCenter(c);
	transformAll(pieces, new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z));
	// 4. trees / bushes: your scale and offset are baked in (hedges are fitted per tile instead)
	if (kind !== 'hedge')
	{
		const s = e.scale, o = e.offset;
		const m = new THREE.Matrix4().makeScale(s[0], s[1], s[2]);
		m.premultiply(new THREE.Matrix4().makeTranslation(o[0], o[1], o[2]));
		transformAll(pieces, m);
	}
	box = boxOf(pieces);
	size = new THREE.Vector3(); box.getSize(size);
	const trunk = kind === 'tree' || kind === 'pineTree' ? measureTrunk(pieces, size) : { x: 0, z: 0, hw: Math.max(size.x, size.z) * 0.3, h: size.y };
	let tris = 0;
	for (let i = 0; i < pieces.length; i++) tris += (pieces[i].geom.index ? pieces[i].geom.index.count : pieces[i].geom.getAttribute('position').count) / 3;
	const parts = mergeByMaterial(ctx, pieces, e.castShadow);
	if (parts.length === 0) return null;
	const sphere = new THREE.Sphere(); box.getBoundingSphere(sphere);
	const radius = sphere.radius + sphere.center.length();
	if (kind !== 'hedge' && (size.y > 80 || size.y < 0.1))
		console.warn('[Realism] Vegetation model "' + e.model + '" is ' + size.y.toFixed(2) + ' m tall after scale ' + e.scale[1] + '. Set its scale in realism-config.js -> vegetation if that is wrong (models exported in centimetres need scale: 0.01).');
	if (tris > 15000)
		console.warn('[Realism] Vegetation model "' + e.model + '" has ' + Math.round(tris) + ' triangles. Every copy draws all of them: keep vegetation under ~3,000 for Chromebooks.');
	console.log('[Realism] Vegetation model ready: "' + e.model + '" (' + kind + ', ' + size.x.toFixed(1) + ' x ' + size.y.toFixed(1) + ' x ' + size.z.toFixed(1) + ' m, ' + parts.length + ' material(s), ' + Math.round(tris) + ' triangles)');
	return { parts: parts, size: size, radius: radius, trunk: trunk, triangles: Math.round(tris) };
}

// ---------------------------------------------------------------------------
// Instancing per chunk
// ---------------------------------------------------------------------------

const tmpM = new THREE.Matrix4(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), Y_AXIS = new THREE.Vector3(0, 1, 0);

interface Chunk { mats: number[]; x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; maxScale: number; }

/** Collects instance matrices per map chunk, then makes one InstancedMesh per chunk and material. */
export class ChunkInstances
{
	private chunks: { [key: string]: Chunk } = {};
	private keys: string[] = [];
	private size: number;
	public count = 0;

	constructor(chunkSize: number) { this.size = chunkSize; }

	public add(x: number, y: number, z: number, ry: number, sx: number, sy: number, sz: number): void
	{
		const key = chunkKey(x, z, this.size);
		let c = this.chunks[key];
		if (!c) { c = { mats: [], x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9, maxScale: 1 }; this.chunks[key] = c; this.keys.push(key); }
		tmpP.set(x, y, z);
		tmpQ.setFromAxisAngle(Y_AXIS, ry);
		tmpS.set(sx, sy, sz);
		tmpM.compose(tmpP, tmpQ, tmpS);
		const el = tmpM.elements;
		for (let k = 0; k < 16; k++) c.mats.push(el[k]);
		c.x0 = Math.min(c.x0, x); c.x1 = Math.max(c.x1, x);
		c.y0 = Math.min(c.y0, y); c.y1 = Math.max(c.y1, y);
		c.z0 = Math.min(c.z0, z); c.z1 = Math.max(c.z1, z);
		c.maxScale = Math.max(c.maxScale, sx, sy, sz);
		this.count++;
	}

	/** Adds the meshes to the world and the cull registry. Returns how many meshes (draw calls when all visible). */
	public emit(ctx: RealismCtx, m: PreparedModel, cat: string, name: string): number
	{
		let meshes = 0;
		for (let k = 0; k < this.keys.length; k++)
		{
			const c = this.chunks[this.keys[k]];
			const n = c.mats.length / 16;
			if (n === 0) continue;
			const arr = new Float32Array(c.mats);
			const center = new THREE.Vector3((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2, (c.z0 + c.z1) / 2);
			const radius = Math.sqrt((c.x1 - c.x0) * (c.x1 - c.x0) + (c.y1 - c.y0) * (c.y1 - c.y0) + (c.z1 - c.z0) * (c.z1 - c.z0)) / 2 + m.radius * c.maxScale;
			for (let p = 0; p < m.parts.length; p++)
			{
				const part = m.parts[p];
				// a thin wrapper over the same vertex buffers: every chunk shares one copy on the GPU,
				// only the bounding sphere (frustum culling) differs per chunk
				const geom = new THREE.BufferGeometry();
				for (const an in part.geom.attributes) if (part.geom.attributes.hasOwnProperty(an)) geom.setAttribute(an, part.geom.attributes[an]);
				if (part.geom.index) geom.setIndex(part.geom.index);
				geom.boundingSphere = new THREE.Sphere(center.clone(), radius);
				const mesh = new THREE.InstancedMesh(geom, instMat(ctx, part.mat), n);
				(mesh.instanceMatrix.array as Float32Array).set(arr);
				mesh.instanceMatrix.needsUpdate = true;
				mesh.castShadow = part.cast !== false;
				mesh.receiveShadow = true;
				mesh.matrixAutoUpdate = false;
				mesh.updateMatrix();
				mesh.userData.realismAsset = name;
				ctx.world.graphicsWorld.add(mesh);
				ctx.cull.add(mesh, cat, center, radius);
				meshes++;
			}
		}
		return meshes;
	}
}

/** Static colliders added after the world was built (a model arrived later): one compound body per 128 m chunk. */
export function lateColliders(ctx: RealismCtx, fill: (phys: PhysicsChunks) => void): number
{
	const phys = new PhysicsChunks(ctx.world, 128);
	fill(phys);
	phys.commit();
	return phys.shapeCount;
}

/** Running totals shown in the console / build summary. */
export const vegModelStats: { meshes: number; colliders: number; loaded: string[]; failed: string[] } = { meshes: 0, colliders: 0, loaded: [], failed: [] };
