/*
 * RealismVehicles.ts
 * ------------------
 * Lets realism-config.js add your own vehicles.
 *
 *  - sketchbookFormat: true   your .glb was made with Sketchbook's Blender add-on (seats, wheels,
 *                             collision are inside it). It is loaded as-is.
 *  - sketchbookFormat: false  any .glb (Sketchfab, Blender export, ...). The stock Sketchbook vehicle
 *                             of the same base (car / heli / airplane) does the physics, seats and
 *                             wheels; its body is hidden and your model is shown on top.
 */

import * as THREE from 'three';
import { World } from './World';
import { loadGLB, overrideMatrix } from './RealismAssets';

export function dressVehicle(world: World, vehicle: any, gltf: any, vt: any): void
{
	// hide the stock body (keep wheels when asked)
	const wheelObjs: THREE.Object3D[] = (vehicle.wheels || []).map((w: any) => w.wheelObject);
	const underWheel = (o: THREE.Object3D): boolean =>
	{
		let p = o;
		while (p) { if (wheelObjs.indexOf(p) >= 0) return true; p = p.parent; }
		return false;
	};
	gltf.scene.traverse((o: any) =>
	{
		if (!o.isMesh) return;
		if (vt.keepBaseWheels !== false && underWheel(o)) return;
		o.visible = false;
	});
	loadGLB(vt.model, (scene) =>
	{
		const body = scene.clone();
		const wrap = new THREE.Group();
		wrap.applyMatrix4(overrideMatrix(vt));
		wrap.add(body);
		body.traverse((o: any) =>
		{
			if (!o.isMesh) return;
			o.castShadow = true;
			o.receiveShadow = true;
			const mats = o.material instanceof Array ? o.material : [o.material];
			mats.forEach((m: THREE.Material) => world.sky.csm.setupMaterial(m));
		});
		vehicle.add(wrap);
		console.log('[Realism] Vehicle model loaded: ' + vt.model);
	});
}

/**
 * Called by VehicleSpawnPoint after a scenario / config vehicle is added to the world.
 * Police types ('police', 'sheriff', or 'policeCruiser' without its own model, or any type with
 * livery: 'police' | 'sheriff') get the police livery + ELS (RealismPolice.ts).
 */
export function realismVehicleSpawned(world: World, vehicle: any, type: string, vt: any): void
{
	const w: any = world;
	try { if (w.realismPoliceSystem) w.realismPoliceSystem.onSpawned(vehicle, type, vt); }
	catch (e) { console.warn('[Realism] vehicle spawn hook failed', e); }
}
