/*
 * RealismContext.ts
 * -----------------
 * Shared state for the San Verano builders: the world, the map data, settings,
 * materials, chunked static physics and the mesh registry the performance
 * manager uses for distance culling.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { World } from './World';
import { MapData, HALF } from './RealismMapData';
import { RealismSettings, PerformancePreset } from './RealismConfig';
import { DoorSystem } from './RealismDoors';

export const RENDER_CHUNK = 256;   // metres, merged render chunks
export const DETAIL_CHUNK = 128;   // smaller chunks for props / trims so distance culling is tighter

export function chunkKey(x: number, z: number, size: number): string
{
	return Math.floor((x + HALF) / size) + '_' + Math.floor((z + HALF) / size);
}

/** Static colliders merged into one compound body per chunk. */
export class PhysicsChunks
{
	private world: World;
	private size: number;
	private bodies: { [key: string]: CANNON.Body } = {};
	private keys: string[] = [];
	private mat: CANNON.Material;
	public shapeCount: number = 0;

	constructor(world: World, size: number)
	{
		this.world = world;
		this.size = size;
		this.mat = new CANNON.Material('staticMat');
		this.mat.friction = 0.3;
	}

	private bodyFor(x: number, z: number): CANNON.Body
	{
		const key = chunkKey(x, z, this.size);
		let body = this.bodies[key];
		if (body === undefined)
		{
			const parts = key.split('_');
			const cx = -HALF + (parseInt(parts[0], 10) + 0.5) * this.size;
			const cz = -HALF + (parseInt(parts[1], 10) + 0.5) * this.size;
			body = new CANNON.Body({ mass: 0 });
			body.position.set(cx, 0, cz);
			body.material = this.mat;
			this.bodies[key] = body;
			this.keys.push(key);
		}
		return body;
	}

	/** Box centred at world (x,y,z), half extents, yaw `rot`, optional tilt about the box's local X (ramps). */
	public box(x: number, y: number, z: number, hx: number, hy: number, hz: number, rot: number, tiltX?: number): void
	{
		if (hx <= 0.001 || hy <= 0.001 || hz <= 0.001) return;
		const body = this.bodyFor(x, z);
		const q = new CANNON.Quaternion();
		q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rot);
		if (tiltX)
		{
			const qt = new CANNON.Quaternion();
			qt.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), tiltX);
			q.copy(q.mult(qt));
		}
		body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)), new CANNON.Vec3(x - body.position.x, y, z - body.position.z), q);
		this.shapeCount++;
	}

	public commit(): void
	{
		for (let i = 0; i < this.keys.length; i++)
		{
			const b = this.bodies[this.keys[i]];
			b.updateMassProperties();
			b.aabbNeedsUpdate = true;
			this.world.physicsWorld.addBody(b);
		}
	}
}

export interface CullEntry { obj: THREE.Object3D; x: number; z: number; r: number; cat: string; }

/** Meshes registered here are hidden by the performance manager beyond their category's distance. */
export class CullRegistry
{
	public entries: CullEntry[] = [];

	public add(obj: THREE.Object3D, cat: string, center?: THREE.Vector3, radius?: number): void
	{
		let c = center, r = radius;
		if (c === undefined)
		{
			const m: any = obj;
			const g = m.geometry as THREE.BufferGeometry;
			if (g && !g.boundingSphere) g.computeBoundingSphere();
			c = g && g.boundingSphere ? g.boundingSphere.center : new THREE.Vector3(obj.position.x, obj.position.y, obj.position.z);
			r = g && g.boundingSphere ? g.boundingSphere.radius : 50;
		}
		this.entries.push({ obj: obj, x: c.x, z: c.z, r: r || 50, cat: cat });
	}
}

export interface RealismCtx
{
	world: World;
	data: MapData;
	cfg: RealismSettings;
	preset: PerformancePreset;
	presetName: string;
	mats: { [name: string]: THREE.Material };
	phys: PhysicsChunks;        // terrain props, trees, lamps (128 m chunks)
	bphys: PhysicsChunks;       // building shells (64 m chunks, many small boxes)
	cull: CullRegistry;
	/** Instancers whose interior items are uploaded around the camera (see AssetInstancer.refresh). */
	dynamic: { refresh(x: number, z: number, limit: number): void; drawnInterior: number }[];
	/** Lights the light pool may place: lamps, porch lights, room ceiling lights. */
	lightSpots: { x: number; y: number; z: number; color: number; range: number; night: boolean }[];
	/** Openable doors (RealismDoors.ts). Builders add doors while building; finalize() makes the meshes. */
	doors?: DoorSystem;
}

/**
 * three r113 compiles ONE shader program per material. A material first drawn on an
 * InstancedMesh gets the instancing program; drawing a plain Mesh with that same material
 * then crashes ("reading 'isInterleavedBufferAttribute'"), and the other way round the
 * instances all collapse to one spot. So every InstancedMesh gets its own copy of the
 * material (one copy per source material, shared by all instanced meshes).
 */
const instancedCopies: { [uuid: string]: THREE.Material } = {};
export function instMat(ctx: RealismCtx, mat: THREE.Material): THREE.Material
{
	if (!mat) return mat;
	if ((mat as any).userData && (mat as any).userData.instancedCopy) return mat;
	let copy = instancedCopies[mat.uuid];
	if (copy === undefined)
	{
		copy = mat.clone();
		copy.name = (mat.name || 'mat') + ' (instanced)';
		(copy as any).userData = Object.assign({}, (mat as any).userData || {}, { instancedCopy: true });
		if ((mat as any).onBeforeCompile !== (THREE.Material.prototype as any).onBeforeCompile)
		{
			try { ctx.world.sky.csm.setupMaterial(copy); } catch (e) { /* unlit material */ }
		}
		instancedCopies[mat.uuid] = copy;
	}
	return copy;
}

function freeArray(): void { (this as any).array = null; }

/** True when this geometry dropped its JavaScript copy after upload (addMesh): the GPU holds the
 *  only copy, so it must never be disposed (three.js could not upload it again). */
export function gpuOnly(geom: THREE.BufferGeometry): boolean
{
	const attrs: any = geom.attributes;
	for (const k in attrs)
	{
		if (!attrs.hasOwnProperty(k)) continue;
		const a = attrs[k];
		if (!a || !a.array || a.onUploadCallback === freeArray) return true;
	}
	const ix: any = geom.index;
	if (ix && (!ix.array || ix.onUploadCallback === freeArray)) return true;
	return false;
}

export function addMesh(ctx: RealismCtx, geom: THREE.BufferGeometry, mat: THREE.Material, cast: boolean, receive: boolean, cat?: string): THREE.Mesh
{
	const mesh = new THREE.Mesh(geom, mat);
	mesh.castShadow = cast;
	mesh.receiveShadow = receive;
	mesh.matrixAutoUpdate = false;
	mesh.updateMatrix();
	ctx.world.graphicsWorld.add(mesh);
	if (cat) ctx.cull.add(mesh, cat);
	if (!geom.boundingSphere) geom.computeBoundingSphere();
	if (!geom.boundingBox) geom.computeBoundingBox();
	// once the GPU has the data, drop the JavaScript copy (halves RAM use)
	for (const k in geom.attributes) if (geom.attributes.hasOwnProperty(k)) (geom.attributes[k] as THREE.BufferAttribute).onUpload(freeArray);
	if (geom.index) geom.index.onUpload(freeArray);
	return mesh;
}
