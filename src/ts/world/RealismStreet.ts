/*
 * RealismStreet.ts
 * ----------------
 * Street lights, working traffic lights, stop signs and street furniture
 * (hydrants, benches, trash cans, dumpsters, fences, wrecked cars...).
 *
 * Each of these is a named asset in realism-config.js -> city.props.<name>,
 * so you can drop in your own .glb (and scale/rotate it) without touching code.
 */

import * as THREE from 'three';
import { RealismCtx, instMat } from './RealismContext';
import { GeoAccum, Frame, box, boxC, cyl, cylX, cylZ } from './RealismGeometry';
import { AssetInstancer, AssetPart, partsFrom } from './RealismAssets';
import { IUpdatable } from '../interfaces/IUpdatable';

const METAL = [0.3, 0.31, 0.33], DARK = [0.12, 0.12, 0.13], YELLOWP = [0.85, 0.7, 0.1];

/** Prop type in the map data -> asset name in the config. */
const PROP_NAMES: { [type: string]: string } = { hydrant: 'fireHydrant', fence: 'chainLinkFence' };

/** Box colliders for props: [halfX, halfY, halfZ, offsetZ] (local). */
const PROP_COLLIDERS: { [name: string]: number[] } = {
	fireHydrant: [0.2, 0.45, 0.2, 0], bench: [0.9, 0.4, 0.3, 0], trashCan: [0.3, 0.5, 0.3, 0], dumpster: [0.95, 0.65, 0.75, 0],
	wreckedCar: [0.95, 0.7, 2.2, 0], barrier: [1.0, 0.45, 0.3, 0], picnicTable: [0.9, 0.4, 0.8, 0], bleacher: [3.0, 0.9, 1.4, 0],
	stopSign: [0.06, 1.3, 0.06, 0], streetLight: [0.15, 4, 0.15, 0], trafficLight: [0.18, 3, 0.18, 0], flagpole: [0.08, 5, 0.08, 0],
	hoop: [0.1, 1.6, 0.1, -0.6], weightBench: [0.3, 0.3, 0.7, 0], infoBoard: [0.8, 0.9, 0.1, 0], tire: [0.35, 0.15, 0.35, 0],
};

function streetLight(ctx: RealismCtx, v: number): AssetPart[]
{
	const a = new GeoAccum(), g = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	cyl(a, f, 0, 0, 0, 0.5, 0.22, 0.16, 8, [0.4, 0.4, 0.4]);
	cyl(a, f, 0, 0.5, 0, 7.6, 0.11, 0.075, 8, METAL);
	// curved arm made of short segments toward +z
	let py = 8.0, pz = 0;
	for (let k = 0; k < 6; k++)
	{
		const ny = 8.0 + Math.sin((k + 1) / 6 * Math.PI / 2) * 0.45, nz = (k + 1) / 6 * 2.2;
		const len = Math.sqrt((ny - py) * (ny - py) + (nz - pz) * (nz - pz));
		const sub = f.sub(0, py, pz, 0);
		const ang = Math.atan2(ny - py, nz - pz);
		for (let i = 0; i < 6; i++)
		{
			const a0 = i / 6 * Math.PI * 2, a1 = (i + 1) / 6 * Math.PI * 2;
			const r = 0.06;
			const p = (aa: number, t: number) => [r * Math.cos(aa), r * Math.sin(aa) * Math.cos(ang) + t * Math.sin(ang), -r * Math.sin(aa) * Math.sin(ang) + t * Math.cos(ang)];
			const q0 = p(a0, 0), q1 = p(a1, 0), q2 = p(a1, len), q3 = p(a0, len);
			a.face([sub.p(q0[0], q0[1], q0[2]), sub.p(q1[0], q1[1], q1[2]), sub.p(q2[0], q2[1], q2[2]), sub.p(q3[0], q3[1], q3[2])], [Math.cos((a0 + a1) / 2), Math.sin((a0 + a1) / 2), 0], [[0, 0], [0, 0], [0, 0], [0, 0]], METAL);
		}
		py = ny; pz = nz;
	}
	// cobra head
	box(a, f, -0.22, 8.25, 1.75, 0.22, 8.5, 2.75, [0.55, 0.56, 0.58]);
	if (v === 0) box(g, f, -0.17, 8.2, 1.85, 0.17, 8.25, 2.65, [1, 1, 1], 't');
	else box(a, f, -0.17, 8.2, 1.85, 0.17, 8.25, 2.65, [0.25, 0.25, 0.25], 't');
	return partsFrom(ctx, [[a, 'plain'], [g, 'streetLampGlow', false]]);   // day / night switched lamp head
}

/** Pole + mast arm toward local -x, signal housings facing +z. Variant 0: 4 m arm, 1: 6.5 m arm. */
export const SIGNAL_ARM = [4.0, 6.5];
export const SIGNAL_HEAD_Y = 5.6;
export const SIGNAL_POLE_HEAD_Y = 3.0;

function trafficLight(ctx: RealismCtx, v: number): AssetPart[]
{
	const a = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	const L = SIGNAL_ARM[v];
	cyl(a, f, 0, 0, 0, 0.4, 0.25, 0.25, 8, [0.45, 0.45, 0.45]);
	cyl(a, f, 0, 0.4, 0, 6.4, 0.14, 0.12, 8, [0.2, 0.22, 0.2]);
	cylX(a, f, -L, 0, 6.3, 0, 0.08, 6, [0.2, 0.22, 0.2]);
	// diagonal brace
	for (let k = 0; k < 6; k++) boxC(a, f, -k * L / 10 - 0.1, 6.3 - 0.7 + k * 0.12, 0, L / 10 + 0.05, 0.04, 0.04, [0.2, 0.22, 0.2]);
	const housing = (x: number, y: number) =>
	{
		box(a, f, x - 0.2, y - 0.58, -0.12, x + 0.2, y + 0.58, 0.12, [0.1, 0.1, 0.1]);
		box(a, f, x - 0.32, y - 0.7, -0.14, x + 0.32, y + 0.7, -0.12, YELLOWP);
		for (let k = -1; k <= 1; k++) box(a, f, x - 0.16, y + k * 0.36 + 0.13, 0.12, x + 0.16, y + k * 0.36 + 0.16, 0.3, [0.08, 0.08, 0.08]);
	};
	housing(-L + 0.3, SIGNAL_HEAD_Y);
	cyl(a, f, -L + 0.3, 6.18, 0, 0.12, 0.05, 0.05, 6, DARK);
	housing(-0.4, SIGNAL_POLE_HEAD_Y);
	// pedestrian button box
	box(a, f, 0.1, 1.0, -0.08, 0.22, 1.3, 0.08, [0.85, 0.7, 0.1]);
	return partsFrom(ctx, [[a, 'plain']]);
}

function stopSign(ctx: RealismCtx): AssetPart[]
{
	const a = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	cyl(a, f, 0, 0, 0, 2.6, 0.04, 0.04, 6, [0.6, 0.6, 0.62]);
	box(a, f, -0.37, 2.0, -0.04, 0.37, 2.74, -0.02, [0.65, 0.65, 0.65]);
	const parts = partsFrom(ctx, [[a, 'plain']]);
	const face = new THREE.PlaneBufferGeometry(0.76, 0.76);
	face.translate(0, 2.37, 0.0);
	parts.push({ geom: face, mat: ctx.mats.stop, cast: false });
	return parts;
}

function propParts(ctx: RealismCtx, name: string, v: number): AssetPart[]
{
	const a = new GeoAccum(), s = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	switch (name)
	{
		case 'fireHydrant':
			cyl(a, f, 0, 0, 0, 0.08, 0.2, 0.2, 10, [0.75, 0.1, 0.08]);
			cyl(a, f, 0, 0.08, 0, 0.62, 0.14, 0.13, 10, [0.8, 0.12, 0.1]);
			cyl(a, f, 0, 0.7, 0, 0.18, 0.16, 0.05, 10, [0.8, 0.12, 0.1]);
			cylX(a, f, -0.26, 0.26, 0.5, 0, 0.06, 8, [0.8, 0.12, 0.1]);
			cylZ(a, f, 0, 0.22, 0, 0.45, 0.08, 8, [0.8, 0.12, 0.1]);
			cyl(a, f, 0, 0.88, 0, 0.06, 0.04, 0.03, 6, [0.85, 0.75, 0.2]);
			break;
		case 'bench':
			for (let k = 0; k < 3; k++) box(a, f, -0.9, 0.42, -0.25 + k * 0.17, 0.9, 0.46, -0.13 + k * 0.17, [0.5, 0.35, 0.2]);
			for (let k = 0; k < 2; k++) box(a, f, -0.9, 0.6 + k * 0.17, -0.3, 0.9, 0.72 + k * 0.17, -0.27, [0.5, 0.35, 0.2]);
			for (let k = -1; k <= 1; k += 2) { box(a, f, k * 0.8 - 0.04, 0, -0.28, k * 0.8 + 0.04, 0.42, 0.22, DARK); box(a, f, k * 0.8 - 0.04, 0.42, -0.3, k * 0.8 + 0.04, 0.92, -0.26, DARK); }
			break;
		case 'trashCan':
			cyl(a, f, 0, 0, 0, 0.95, 0.28, 0.3, 12, v ? [0.25, 0.3, 0.25] : [0.2, 0.25, 0.32]);
			cyl(a, f, 0, 0.95, 0, 0.08, 0.32, 0.25, 12, DARK, true);
			break;
		case 'dumpster':
		{
			const c = v ? [0.15, 0.32, 0.6] : [0.18, 0.4, 0.22];
			box(a, f, -0.95, 0.15, -0.75, 0.95, 1.25, 0.75, c);
			box(a, f, -0.98, 1.25, -0.8, 0.98, 1.32, 0.15, [0.12, 0.12, 0.12]);
			box(a, f, -0.98, 1.25, 0.15, 0.98, 1.55, 0.2, [0.12, 0.12, 0.12]);
			for (let k = 0; k < 4; k++) cyl(a, f, (k % 2 ? 0.8 : -0.8), 0, (k < 2 ? 0.6 : -0.6), 0.15, 0.07, 0.07, 6, DARK);
			break;
		}
		case 'chainLinkFence':
		{
			// one 3 m panel along local x with posts; stretched along x by the placement
			for (let k = 0; k <= 1; k++) cyl(a, f, -1.5 + k * 3, 0, 0, 2.0, 0.035, 0.035, 6, [0.6, 0.6, 0.62]);
			box(a, f, -1.5, 1.95, -0.02, 1.5, 2.0, 0.02, [0.6, 0.6, 0.62]);
			const mesh = new GeoAccum();
			mesh.face([[-1.5, 0.05, 0], [1.5, 0.05, 0], [1.5, 1.95, 0], [-1.5, 1.95, 0]], [0, 0, 1], [[0, 0], [12, 0], [12, 7.6], [0, 7.6]], [1, 1, 1]);
			mesh.face([[1.5, 0.05, 0], [-1.5, 0.05, 0], [-1.5, 1.95, 0], [1.5, 1.95, 0]], [0, 0, -1], [[12, 0], [0, 0], [0, 7.6], [12, 7.6]], [1, 1, 1]);
			const parts = partsFrom(ctx, [[a, 'plain']]);
			parts.push({ geom: mesh.toGeometry(), mat: chainMat(ctx), cast: true });
			return parts;
		}
		case 'wreckedCar':
		{
			const c = [[0.35, 0.12, 0.1], [0.2, 0.25, 0.3], [0.45, 0.42, 0.38], [0.25, 0.22, 0.18]][v % 4];
			box(a, f, -0.9, 0.3, -2.2, 0.9, 0.95, 2.2, c);
			box(a, f, -0.8, 0.95, -1.0, 0.8, 1.45, 0.9, c);
			box(s, f, -0.78, 1.0, 0.9, 0.78, 1.4, 0.92, [0.05, 0.05, 0.05]);
			box(s, f, -0.78, 1.0, -1.02, 0.78, 1.4, -1.0, [0.05, 0.05, 0.05]);
			box(a, f, -0.92, 0.4, 2.15, 0.92, 0.6, 2.25, [0.3, 0.3, 0.3]);
			// rust patches and flat tyres / bricks
			box(a, f, 0.5, 0.95, -2.0, 0.85, 0.97, -1.3, [0.45, 0.22, 0.1]);
			for (let k = 0; k < 4; k++) box(a, f, (k % 2 ? 0.55 : -0.95), 0, (k < 2 ? 1.2 : -1.6), (k % 2 ? 0.95 : -0.55), 0.3, (k < 2 ? 1.6 : -1.2), [0.45, 0.25, 0.2]);
			break;
		}
		case 'trashBag':
			cyl(a, f, 0, 0, 0, 0.35, 0.24, 0.29, 7, DARK);
			cyl(a, f, 0, 0.35, 0, 0.18, 0.29, 0.03, 7, DARK);
			break;
		case 'tire':
			cyl(a, f, 0, 0, 0, 0.25, 0.34, 0.34, 12, DARK);
			cyl(a, f, 0, 0.25, 0, 0.01, 0.34, 0.2, 12, [0.05, 0.05, 0.05]);
			break;
		case 'mattress':
			box(a, f, -0.7, 0, -1.0, 0.7, 0.2, 1.0, [0.65, 0.6, 0.5]);
			box(a, f, -0.2, 0.2, -0.3, 0.4, 0.21, 0.5, [0.45, 0.38, 0.3]);
			break;
		case 'barrier':
			box(a, f, -1.0, 0, -0.3, 1.0, 0.15, 0.3, [0.75, 0.74, 0.72]);
			box(a, f, -1.0, 0.15, -0.12, 1.0, 0.9, 0.12, [0.78, 0.77, 0.75]);
			break;
		case 'picnicTable':
			box(a, f, -0.9, 0.72, -0.4, 0.9, 0.77, 0.4, [0.55, 0.4, 0.25]);
			box(a, f, -0.9, 0.42, 0.55, 0.9, 0.46, 0.8, [0.55, 0.4, 0.25]);
			box(a, f, -0.9, 0.42, -0.8, 0.9, 0.46, -0.55, [0.55, 0.4, 0.25]);
			for (let k = -1; k <= 1; k += 2) box(a, f, k * 0.7 - 0.04, 0, -0.75, k * 0.7 + 0.04, 0.72, 0.75, [0.45, 0.32, 0.2]);
			break;
		case 'telescope':
			cyl(a, f, 0, 0, 0, 1.0, 0.06, 0.05, 8, [0.3, 0.32, 0.3]);
			box(a, f, -0.18, 1.0, -0.35, 0.18, 1.3, 0.35, [0.25, 0.45, 0.3]);
			cylZ(a, f, 0.35, 0.55, 0, 1.15, 0.08, 8, [0.15, 0.15, 0.15]);
			break;
		case 'flagpole':
			cyl(a, f, 0, 0, 0, 10, 0.07, 0.04, 8, [0.85, 0.85, 0.85]);
			box(a, f, 0.05, 8.4, -0.01, 1.85, 9.6, 0.01, v ? [0.25, 0.35, 0.6] : [0.75, 0.15, 0.15]);
			break;
		case 'infoBoard':
			box(a, f, -0.85, 0, -0.06, -0.75, 1.8, 0.06, [0.4, 0.3, 0.2]); box(a, f, 0.75, 0, -0.06, 0.85, 1.8, 0.06, [0.4, 0.3, 0.2]);
			box(a, f, -0.8, 0.8, -0.04, 0.8, 1.8, 0.04, [0.35, 0.5, 0.35]);
			break;
		case 'hoop':
			cyl(a, f, 0, 0, -0.6, 3.05, 0.07, 0.07, 8, [0.3, 0.3, 0.3]);
			box(a, f, -0.9, 2.9, -0.55, 0.9, 3.95, -0.5, [0.9, 0.9, 0.9]);
			for (let i = 0; i < 10; i++) { const an = i / 10 * Math.PI * 2; box(a, f, Math.cos(an) * 0.23 - 0.02, 3.05, -0.27 + Math.sin(an) * 0.23 - 0.02, Math.cos(an) * 0.23 + 0.02, 3.07, -0.27 + Math.sin(an) * 0.23 + 0.02, [0.9, 0.35, 0.1]); }
			break;
		case 'weightBench':
			box(a, f, -0.18, 0.4, -0.7, 0.18, 0.5, 0.6, DARK);
			for (let k = -1; k <= 1; k += 2) cyl(a, f, k * 0.5, 0, -0.55, 1.1, 0.03, 0.03, 6, METAL);
			cylX(a, f, -0.8, 0.8, 1.05, -0.55, 0.02, 6, METAL);
			for (let k = -1; k <= 1; k += 2) cylX(a, f, k * 0.62 - 0.04, k * 0.62 + 0.04, 1.05, -0.55, 0.2, 10, DARK);
			break;
		case 'bleacher':
			for (let k = 0; k < 4; k++) box(a, f, -3, 0.3 + k * 0.45, -1.4 + k * 0.7, 3, 0.36 + k * 0.45, -0.9 + k * 0.7, [0.7, 0.7, 0.72]);
			for (let k = -1; k <= 1; k++) box(a, f, k * 2.8 - 0.05, 0, -1.4, k * 2.8 + 0.05, 1.8, 1.4, METAL);
			break;
	}
	return partsFrom(ctx, [[a, 'plain'], [s, 'shiny']]);
}

let chainMaterial: THREE.Material;
function chainMat(ctx: RealismCtx): THREE.Material
{
	if (chainMaterial) return chainMaterial;
	const c = document.createElement('canvas');
	c.width = 32; c.height = 32;
	const g = c.getContext('2d');
	g.clearRect(0, 0, 32, 32);
	g.strokeStyle = 'rgba(170,172,176,1)'; g.lineWidth = 2.5;
	g.beginPath(); g.moveTo(0, 16); g.lineTo(16, 0); g.lineTo(32, 16); g.lineTo(16, 32); g.closePath(); g.stroke();
	const t = new THREE.CanvasTexture(c);
	t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping;
	const m = new THREE.MeshPhongMaterial({ map: t, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, shininess: 20 });
	ctx.world.sky.csm.setupMaterial(m);
	chainMaterial = m;
	return m;
}

// ---------------------------------------------------------------------------

export function defineStreetAssets(ctx: RealismCtx, inst: AssetInstancer): void
{
	inst.define('streetLight', (v) => streetLight(ctx, v));
	inst.define('trafficLight', (v) => trafficLight(ctx, v));
	inst.define('stopSign', () => stopSign(ctx));
	const names = ['fireHydrant', 'bench', 'trashCan', 'dumpster', 'chainLinkFence', 'wreckedCar', 'trashBag', 'tire', 'mattress', 'barrier', 'picnicTable', 'telescope', 'flagpole', 'infoBoard', 'hoop', 'weightBench', 'bleacher'];
	for (let i = 0; i < names.length; i++) { const n = names[i]; inst.define(n, (v) => propParts(ctx, n, v)); }
}

/** Adds a street-furniture instance plus its collider. */
export function placeProp(ctx: RealismCtx, inst: AssetInstancer, name: string, x: number, y: number, z: number, r: number, variant?: number, len?: number): void
{
	if (inst.isDisabled(name)) return;
	const sx = name === 'chainLinkFence' && len ? len / 3 : 1;
	inst.add(name, { x: x, y: y, z: z, ry: r, sx: sx }, name === 'streetLight' || name === 'trafficLight' ? 'street' : 'detail', variant || 0);
	const col = PROP_COLLIDERS[name];
	if (col)
	{
		const c = Math.cos(r), s = Math.sin(r);
		ctx.phys.box(x + col[3] * s, y + col[1], z + col[3] * c, col[0] * sx, col[1], col[2], r);
	}
	else if (name === 'chainLinkFence') ctx.phys.box(x, y + 1, z, 1.5 * sx, 1, 0.05, r);
}

export function buildStreet(ctx: RealismCtx, inst: AssetInstancer): TrafficSignals
{
	const data = ctx.data, city = ctx.cfg.city;
	// street lights
	if (city.streetLights)
	{
		for (let i = 0; i < data.lamps.length; i++)
		{
			const l = data.lamps[i];
			placeProp(ctx, inst, 'streetLight', l.x, l.y, l.z, l.r, l.broken ? 1 : 0);
			if (!l.broken)
			{
				const hx = l.x + Math.sin(l.r) * 2.2, hz = l.z + Math.cos(l.r) * 2.2;
				ctx.lightSpots.push({ x: hx, y: l.y + 8.0, z: hz, color: 0xffd7a0, range: 22, night: true });
			}
		}
	}
	// street furniture from the map
	for (let i = 0; i < data.props.length; i++)
	{
		const p = data.props[i];
		const name = PROP_NAMES[p.type] || p.type;
		if (name === 'fireHydrant' && !city.hydrants) continue;
		if (name === 'bench' && !city.benches) continue;
		if (name === 'trashCan' && !city.trashCans) continue;
		if (!city.gangNeighborhoods && (name === 'wreckedCar' || name === 'mattress' || name === 'tire' || name === 'trashBag')) continue;
		placeProp(ctx, inst, name, p.x, p.y, p.z, p.r, (i * 7) % 4, p.len);
	}
	// intersections
	const signals = new TrafficSignals(ctx);
	for (let i = 0; i < data.intersections.length; i++)
	{
		const J = data.intersections[i];
		for (let k = 0; k < J.arms.length; k++)
		{
			const arm: any = J.arms[k];
			const dx = arm.dx, dz = arm.dz;
			const rx = dz, rz = -dx;                       // driver's right for traffic coming in
			const ry = Math.atan2(dx, dz);                 // faces the approaching traffic
			if (J.control === 'signal' && city.trafficLights && ctx.preset.trafficLights)
			{
				const px = J.x + dx * (J.crossHW + 1.6) + rx * (arm.hw + 1.0);
				const pz = J.z + dz * (J.crossHW + 1.6) + rz * (arm.hw + 1.0);
				const py = data.heightAt(px, pz);
				const v = arm.hw > 5 ? 1 : 0;
				placeProp(ctx, inst, 'trafficLight', px, py, pz, ry, v);
				signals.addApproach(px, py, pz, ry, v, arm.group, J.phase);
			}
			else if (J.control === 'stop' && city.stopSigns && arm.stop)
			{
				const px = J.x + dx * (J.crossHW + 1.3) + rx * (arm.hw + 0.7);
				const pz = J.z + dz * (J.crossHW + 1.3) + rz * (arm.hw + 0.7);
				placeProp(ctx, inst, 'stopSign', px, data.heightAt(px, pz), pz, ry);
			}
		}
	}
	signals.build();
	return signals;
}

// ---------------------------------------------------------------------------
// Animated signal lenses
// ---------------------------------------------------------------------------

interface Approach { x: number; y: number; z: number; ry: number; v: number; group: number; phase: number; }

export class TrafficSignals implements IUpdatable
{
	public updateOrder: number = 9;
	private ctx: RealismCtx;
	private list: Approach[] = [];
	private lens: THREE.InstancedMesh[] = [];    // red, yellow, green
	private slots: number[][] = [];               // per color: approach index list (2 heads each)
	private time = 0;
	private acc = 0;
	public enabled = true;

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
	}

	public addApproach(x: number, y: number, z: number, ry: number, v: number, group: number, phase: number): void
	{
		this.list.push({ x: x, y: y, z: z, ry: ry, v: v, group: group, phase: phase });
	}

	public build(): void
	{
		const n = this.list.length * 2;
		if (n === 0) return;
		const geom = new THREE.CylinderBufferGeometry(0.135, 0.135, 0.04, 12);
		geom.rotateX(Math.PI / 2);
		const mats = [this.ctx.mats.signalRed, this.ctx.mats.signalYellow, this.ctx.mats.signalGreen];
		const offY = [0.36, 0, -0.36];
		const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1), yAxis = new THREE.Vector3(0, 1, 0);
		let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
		for (let c = 0; c < 3; c++)
		{
			const mesh = new THREE.InstancedMesh(geom.clone(), instMat(this.ctx, mats[c]), n);
			const off = new THREE.InstancedMesh(geom.clone(), instMat(this.ctx, this.ctx.mats.signalOff), n);
			for (let i = 0; i < this.list.length; i++)
			{
				const a = this.list[i];
				const cs = Math.cos(a.ry), sn = Math.sin(a.ry);
				const heads = [[-SIGNAL_ARM[a.v] + 0.3, SIGNAL_HEAD_Y], [-0.4, SIGNAL_POLE_HEAD_Y]];
				for (let h = 0; h < 2; h++)
				{
					const lx = heads[h][0], lz = 0.135;
					p.set(a.x + lx * cs + lz * sn, a.y + heads[h][1] + offY[c], a.z - lx * sn + lz * cs);
					q.setFromAxisAngle(yAxis, a.ry);
					m.compose(p, q, s);
					mesh.setMatrixAt(i * 2 + h, m);
					p.set(a.x + lx * cs + (lz - 0.005) * sn, a.y + heads[h][1] + offY[c], a.z - lx * sn + (lz - 0.005) * cs);
					m.compose(p, q, s);
					off.setMatrixAt(i * 2 + h, m);
				}
				minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x); minZ = Math.min(minZ, a.z); maxZ = Math.max(maxZ, a.z);
			}
			const sphere = new THREE.Sphere(new THREE.Vector3((minX + maxX) / 2, 20, (minZ + maxZ) / 2), Math.max(maxX - minX, maxZ - minZ) / 2 + 20);
			mesh.geometry.boundingSphere = sphere; off.geometry.boundingSphere = sphere;
			mesh.instanceMatrix.needsUpdate = true; off.instanceMatrix.needsUpdate = true;
			mesh.userData.base = (mesh.instanceMatrix.array as Float32Array).slice(0);
			this.ctx.world.graphicsWorld.add(mesh);
			this.ctx.world.graphicsWorld.add(off);
			this.lens.push(mesh);
		}
		this.ctx.world.registerUpdatable(this);
		this.apply();
	}

	private state(a: Approach): number
	{
		const cycle = Math.max(6, this.ctx.cfg.city.trafficCycle || 24);
		let t = (this.time / cycle + a.phase) % 1;
		if (a.group === 1) t = (t + 0.5) % 1;
		if (t < 0.42) return 2;      // green
		if (t < 0.5) return 1;       // yellow
		return 0;                    // red
	}

	private apply(): void
	{
		for (let c = 0; c < this.lens.length; c++)
		{
			const mesh = this.lens[c];
			const arr = mesh.instanceMatrix.array as Float32Array;
			const base: Float32Array = mesh.userData.base;
			for (let i = 0; i < this.list.length; i++)
			{
				const on = this.state(this.list[i]) === c;
				for (let h = 0; h < 2; h++)
				{
					const o = (i * 2 + h) * 16;
					if (on) for (let k = 0; k < 16; k++) arr[o + k] = base[o + k];
					else { for (let k = 0; k < 12; k++) arr[o + k] = 0; arr[o + 12] = base[o + 12]; arr[o + 13] = base[o + 13] - 1000; arr[o + 14] = base[o + 14]; arr[o + 15] = 1; }
				}
			}
			mesh.instanceMatrix.needsUpdate = true;
		}
	}

	public update(timeStep: number): void
	{
		if (!this.enabled) return;
		this.time += timeStep;
		this.acc += timeStep;
		if (this.acc < 0.25) return;
		this.acc = 0;
		this.apply();
	}

	public get count(): number { return this.list.length; }
}
