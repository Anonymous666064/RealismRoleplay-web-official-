/*
 * RealismRoadSpot.ts
 * ------------------
 * Finds a free place for a vehicle on the nearest road lane: on the right-hand lane, facing the
 * direction of traffic, clear of junctions, buildings, street furniture, other vehicles, parked
 * NPC cars and the player. Used by the Garage app (realismOwnedCars.spawn) and the Jobs app
 * (patrol car near you). One-off search (a few thousand cheap checks), never per frame.
 */

import * as THREE from 'three';
import { RealismCtx } from './RealismContext';

export interface RoadSpot
{
	x: number;
	y: number;          // road surface height (add the vehicle's rest height yourself)
	z: number;
	heading: number;    // yaw in radians, atan2(dirX, dirZ): the vehicle's local +Z points along the lane
	quat: THREE.Quaternion;
	road: string;
}

export interface RoadSpotOptions
{
	/** Clear radius around the vehicle centre in metres (sedan ~3, heli ~8, airplane ~15). */
	clearance?: number;
	/** Search radius around `near` in metres. */
	radius?: number;
	/** Extra obstacle positions (e.g. parked NPC cars), checked with `clearance`. */
	obstacles?: { x: number; z: number }[];
	/** Vehicles to ignore (e.g. the car being moved). */
	ignore?: any[];
	/** Player position: the spot is at least this far from it (default 3.2 m). */
	player?: THREE.Vector3;
}

const ROAD_KINDS: { [k: string]: boolean } = { street: true, avenue: true, highway: true, rural: true };
const UP = new THREE.Vector3(0, 1, 0);

export function findRoadSpot(ctx: RealismCtx, near: THREE.Vector3, opts?: RoadSpotOptions): RoadSpot | null
{
	const o = opts || {};
	const clear = o.clearance !== undefined ? o.clearance : 3;
	const R = o.radius !== undefined ? o.radius : 70;
	const data = ctx.data;
	const world: any = ctx.world;
	const px = near.x, pz = near.z;

	// buildings, props and junctions close enough to matter
	const bl: any[] = [];
	const lim = R + 60;
	for (let i = 0; i < data.buildings.length; i++)
	{
		const b = data.buildings[i];
		const r = Math.max(b.w, b.d) * 0.75 + lim;
		if (Math.abs(b.x - px) > r || Math.abs(b.z - pz) > r) continue;
		bl.push(b);
	}
	const props: any[] = [];
	for (let i = 0; i < data.props.length; i++)
	{
		const p = data.props[i];
		if (Math.abs(p.x - px) < lim && Math.abs(p.z - pz) < lim) props.push(p);
	}
	const vehicles: THREE.Vector3[] = [];
	const vs: any[] = world.vehicles || [];
	for (let i = 0; i < vs.length; i++)
	{
		const v = vs[i];
		if (!v || !v.position || (o.ignore && o.ignore.indexOf(v) >= 0)) continue;
		vehicles.push(v.position);
	}
	const obst = o.obstacles || [];
	const pl = o.player || null;

	let best: RoadSpot = null, bestScore = 1e18;
	for (let r = 0; r < data.roads.length; r++)
	{
		const road = data.roads[r];
		if (!ROAD_KINDS[road.kind] || road.pts.length < 2) continue;
		const hw = road.width / 2;
		const off = Math.max(1.6, hw * 0.5);   // middle of the right-hand half
		for (let i = 0; i < road.pts.length - 1; i++)
		{
			const a = road.pts[i], b = road.pts[i + 1];
			const dx = b.x - a.x, dz = b.z - a.z;
			const len = Math.sqrt(dx * dx + dz * dz);
			if (len < 0.5) continue;
			// quick reject: segment far from the search point
			const l2 = len * len;
			let t0 = ((px - a.x) * dx + (pz - a.z) * dz) / l2;
			t0 = Math.max(0, Math.min(1, t0));
			const cx0 = a.x + dx * t0 - px, cz0 = a.z + dz * t0 - pz;
			if (cx0 * cx0 + cz0 * cz0 > R * R) continue;
			const tx = dx / len, tz = dz / len;
			const nx = -tz, nz = tx;           // right of the travel direction (+t)
			const step = 5 / len;
			for (let k = -8; k <= 8; k++)
			{
				const t = t0 + k * step;
				if (t < 0 || t > 1) continue;
				const cx = a.x + dx * t, cz = a.z + dz * t;
				for (let side = -1; side <= 1; side += 2)
				{
					const x = cx + nx * side * off, z = cz + nz * side * off;
					const ddx = x - px, ddz = z - pz;
					const d2 = ddx * ddx + ddz * ddz;
					if (d2 > R * R) continue;
					const score = d2;
					if (score >= bestScore) continue;
					if (!free(x, z)) continue;
					const fx = tx * side, fz = tz * side;   // drive on the right
					const heading = Math.atan2(fx, fz);
					const ry = a.y + (b.y - a.y) * t;
					const y = Math.max(ry, data.heightAt(x, z)) + (road.kind === 'avenue' || road.kind === 'highway' ? 0.1 : 0.08);
					best = { x: x, y: y, z: z, heading: heading, quat: null, road: road.name };
					bestScore = score;
				}
			}
		}
	}
	if (best) best.quat = new THREE.Quaternion().setFromAxisAngle(UP, best.heading);
	return best;

	function free(x: number, z: number): boolean
	{
		if (pl)
		{
			const qx = pl.x - x, qz = pl.z - z;
			if (qx * qx + qz * qz < 3.2 * 3.2) return false;
		}
		for (let j = 0; j < data.intersections.length; j++)
		{
			const I = data.intersections[j];
			const rr = I.crossHW + 6 + clear * 0.5;
			if ((I.x - x) * (I.x - x) + (I.z - z) * (I.z - z) < rr * rr) return false;
		}
		for (let j = 0; j < bl.length; j++)
		{
			const b = bl[j];
			const ddx = x - b.x, ddz = z - b.z;
			const c = Math.cos(b.rot), s = Math.sin(b.rot);
			const lx = ddx * c - ddz * s, lz = ddx * s + ddz * c;
			if (Math.abs(lx) < b.w / 2 + clear && Math.abs(lz) < b.d / 2 + clear) return false;
		}
		const pc = Math.max(1.6, clear * 0.8);
		for (let j = 0; j < props.length; j++)
		{
			const p = props[j];
			if (Math.abs(p.x - x) < pc && Math.abs(p.z - z) < pc) return false;
		}
		const vc = clear + 3;
		for (let j = 0; j < vehicles.length; j++)
		{
			const v = vehicles[j];
			if ((v.x - x) * (v.x - x) + (v.z - z) * (v.z - z) < vc * vc) return false;
		}
		for (let j = 0; j < obst.length; j++)
		{
			const v = obst[j];
			if ((v.x - x) * (v.x - x) + (v.z - z) * (v.z - z) < vc * vc) return false;
		}
		return true;
	}
}
