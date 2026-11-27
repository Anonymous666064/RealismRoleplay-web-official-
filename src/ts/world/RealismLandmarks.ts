/*
 * RealismLandmarks.ts
 * -------------------
 * Hand-detailed additions for the roleplay landmarks:
 *  - Port Verano Police Department and the County Sheriff: holding cells,
 *    bullpen, lockers, armoury cage, parked cruisers, flag poles, radio mast,
 *    helipad markings, wall lights.
 *  - San Verano State Prison: guard towers with cabins and searchlights,
 *    razor wire, inner fence, two-tier cell blocks with bunks and toilets,
 *    catwalks and stairs, a yard with hoops, bleachers and weights, floodlights,
 *    a sally port gate and a gate house.
 *  - Verano Peak Lookout: a climbable fire-lookout tower with switch-back
 *    stairs and a glass cab, a viewing deck with railings, telescopes,
 *    picnic tables and a lattice radio mast with warning lights.
 *
 * The station / cell block / admin shells themselves come from RealismBuildings.
 */

import * as THREE from 'three';
import { Building } from './RealismMapData';
import { RealismCtx, chunkKey, RENDER_CHUNK, addMesh } from './RealismContext';
import { AccumSet, GeoAccum, Frame, box, boxC, cyl, cylX, hash01 } from './RealismGeometry';
import { AssetInstancer, partsFrom } from './RealismAssets';
import { placeProp } from './RealismStreet';
import { InteriorPlan } from './RealismBuildings';

const CONCRETE = [0.68, 0.67, 0.64], STEEL = [0.45, 0.46, 0.48], DARK = [0.12, 0.12, 0.13], BARS = [0.3, 0.31, 0.33], WIRE = [0.55, 0.56, 0.58];

export class LandmarkBuilder
{
	private ctx: RealismCtx;
	private city: AssetInstancer;
	private furn: AssetInstancer;
	private set = new AccumSet();
	public stats = { towers: 0, cells: 0, cruisers: 0 };

	constructor(ctx: RealismCtx, city: AssetInstancer, furn: AssetInstancer)
	{
		this.ctx = ctx; this.city = city; this.furn = furn;
		city.define('policeCar', (v) => policeCar(ctx, v));
	}

	private acc(mat: string, x: number, z: number): GeoAccum
	{
		return this.set.get(mat + '|' + chunkKey(x, z, RENDER_CHUNK));
	}

	public build(plans: InteriorPlan[]): void
	{
		const data = this.ctx.data;
		for (let i = 0; i < data.buildings.length; i++)
		{
			const b = data.buildings[i];
			if (!b.custom) continue;
			if ((b.custom === 'police' || b.custom === 'sheriff') && b.role === 'station') this.station(b, plans);
			else if (b.custom === 'police' && b.role === 'helipad') this.helipad(b);
			else if (b.custom === 'prison' && b.role === 'wall') this.prisonWall(b);
			else if (b.custom === 'prison' && b.role === 'tower') this.guardTower(b);
			else if (b.custom === 'prison' && b.role === 'cellblock') this.cellBlock(b, plans);
			else if (b.custom === 'lookout' && b.role === 'mast') this.radioMast(b);
		}
		this.prisonGrounds();
		this.lookout();
		for (let k = 0; k < this.set.keys.length; k++)
		{
			const key = this.set.keys[k];
			const a = this.set.get(key);
			if (a.empty) continue;
			const mat = key.split('|')[0];
			addMesh(this.ctx, a.toGeometry(), this.ctx.mats[mat], mat !== 'lampGlow' && mat !== 'glassPane', true, 'building');
		}
	}

	// -----------------------------------------------------------------------
	// helpers

	private free(x: number, z: number, margin: number): boolean
	{
		if (this.ctx.data.roadClearance(x, z) < margin) return false;
		const bs = this.ctx.data.buildings;
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			const dx = x - b.x, dz = z - b.z;
			if (Math.abs(dx) > 120 || Math.abs(dz) > 120) continue;
			const c = Math.cos(b.rot), s = Math.sin(b.rot);
			const lx = dx * c - dz * s, lz = dx * s + dz * c;
			if (Math.abs(lx) < b.w / 2 + margin && Math.abs(lz) < b.d / 2 + margin) return false;
		}
		return true;
	}

	private floodlight(x: number, z: number, h: number): void
	{
		const y = this.ctx.data.heightAt(x, z);
		const f = new Frame(x, y, z, 0);
		const a = this.acc('plain', x, z), g = this.acc('lampGlow', x, z);
		cyl(a, f, 0, 0, 0, h, 0.2, 0.12, 8, STEEL);
		box(a, f, -1.1, h, -0.15, 1.1, h + 0.15, 0.15, STEEL);
		for (let k = 0; k < 4; k++)
		{
			const lx = -0.9 + k * 0.6;
			box(a, f, lx - 0.22, h + 0.15, -0.2, lx + 0.22, h + 0.6, 0.2, DARK);
			box(g, f, lx - 0.18, h + 0.19, 0.2, lx + 0.18, h + 0.56, 0.21, [1, 1, 1]);
		}
		this.ctx.phys.box(x, y + h / 2, z, 0.2, h / 2, 0.2, 0);
		this.ctx.lightSpots.push({ x: x, y: y + h, z: z, color: 0xf4f6ff, range: 40, night: true });
	}

	/** Prison / jail cell row along local x (front of the cells faces +z). */
	private cellRow(f: Frame, x0: number, x1: number, zBack: number, depth: number, y: number, h: number, cellW: number, physRot: number, open: boolean, staffOnly: boolean = false): number
	{
		const n = Math.floor((x1 - x0) / cellW);
		const a = this.acc('plain', f.x, f.z);
		const zf = zBack + depth;
		const controlledDoors = staffOnly && !!this.ctx.doors;
		const wallC = [0.78, 0.77, 0.72];
		const p = (lx: number, ly: number, lz: number) => f.p(lx, ly, lz);
		// back wall + ceiling slab are the building's; dividers + bars here
		for (let k = 0; k <= n; k++)
		{
			const x = x0 + k * cellW;
			box(a, f, x - 0.08, y, zBack, x + 0.08, y + h, zf, wallC);
			const c = p(x, y + h / 2, zBack + depth / 2);
			this.ctx.bphys.box(c[0], c[1], c[2], 0.08, h / 2, depth / 2, physRot);
		}
		for (let k = 0; k < n; k++)
		{
			const cx = x0 + (k + 0.5) * cellW;
			// bars with a door (left 0.9 m); some doors stand open
			const doorOpen = controlledDoors || open || hash01(Math.floor(f.x * 31 + f.z * 17 + k * 13 + y * 7)) < 0.35;
			const bx0 = x0 + k * cellW + 0.08, bx1 = x0 + (k + 1) * cellW - 0.08;
			for (let bx = bx0 + 0.1; bx < bx1 - 0.05; bx += 0.14)
			{
				if (doorOpen && bx < bx0 + 0.95) continue;
				box(a, f, bx - 0.02, y, zf - 0.02, bx + 0.02, y + h - 0.05, zf + 0.02, BARS);
			}
			box(a, f, bx0, y + h - 0.12, zf - 0.04, bx1, y + h - 0.02, zf + 0.04, BARS);
			box(a, f, bx0, y + 1.05, zf - 0.03, bx1, y + 1.1, zf + 0.03, BARS);
			if (doorOpen && !controlledDoors) box(a, f, bx0 - 0.02, y, zf + 0.05, bx0 + 0.02, y + h - 0.15, zf + 0.95, BARS);  // swung-open door
			if (controlledDoors)
			{
				const hinge = p(bx0, y, zf);
				this.ctx.doors.add({
					kind: 'hinged', x: hinge[0], y: y + 0.01, z: hinge[2], rot: physRot,
					width: 0.9, height: h - 0.06, thickness: 0.06, color: [0.36, 0.38, 0.4],
					locked: true, interior: true, lawEnforcementOnly: true, label: 'Holding cell',
				});
			}
			const solid = doorOpen ? [[bx0 + 0.95, bx1]] : [[bx0, bx1]];
			for (let s = 0; s < solid.length; s++)
			{
				const c = p((solid[s][0] + solid[s][1]) / 2, y + h / 2, zf);
				this.ctx.bphys.box(c[0], c[1], c[2], (solid[s][1] - solid[s][0]) / 2, h / 2, 0.05, physRot);
			}
			// bunk + toilet + sink
			const bp = f.p(cx + cellW / 2 - 0.62, y, zBack + 1.1);
			this.furn.add('bunkBed', { x: bp[0], y: y, z: bp[2], ry: f.rot }, 'interior');
			const tp = f.p(x0 + k * cellW + 0.45, y, zBack + 0.45);
			this.furn.add('toilet', { x: tp[0], y: y, z: tp[2], ry: f.rot }, 'interior');
			this.stats.cells++;
		}
		return n;
	}

	// -----------------------------------------------------------------------
	// Police / Sheriff

	private station(b: Building, plans: InteriorPlan[]): void
	{
		const ctx = this.ctx;
		const f = new Frame(b.x, 0, b.z, b.rot);
		const gY = b.groundY !== undefined ? b.groundY : b.baseY + 0.8;
		const floorY = gY + 0.18;
		const T = 0.3;
		const sheriff = b.custom === 'sheriff';
		// holding cells along the back of the main room, one side
		const plan = plans.filter((p) => p.b === b)[0];
		if (plan)
		{
			const main = plan.rooms.filter((r) => r.type === 'main')[0];
			if (main)
			{
				const width = Math.min(3 * 2.6, (main.x1 - main.x0) * 0.4);
				const x1 = main.x1, x0 = x1 - width;
				this.cellRow(f, x0, x1, main.z0, 2.6, floorY, Math.min(3.0, main.h - 0.1), 2.6, b.rot, false, true);
				// armoury cage in the other back corner
				const a = this.acc('plain', b.x, b.z);
				const cx0 = main.x0, cx1 = main.x0 + 3.2, cz0 = main.z0, cz1 = main.z0 + 2.4;
				for (let x = cx0 + 0.1; x < cx1; x += 0.2) box(a, f, x - 0.015, floorY, cz1 - 0.015, x + 0.015, floorY + 2.4, cz1 + 0.015, [0.5, 0.5, 0.52]);
				for (let z = cz0 + 0.1; z < cz1; z += 0.2) box(a, f, cx1 - 0.015, floorY, z - 0.015, cx1 + 0.015, floorY + 2.4, z + 0.015, [0.5, 0.5, 0.52]);
				const c1 = f.p((cx0 + cx1) / 2, floorY + 1.2, cz1), c2 = f.p(cx1, floorY + 1.2, (cz0 + cz1) / 2);
				ctx.bphys.box(c1[0], c1[1], c1[2], (cx1 - cx0) / 2, 1.2, 0.04, b.rot);
				ctx.bphys.box(c2[0], c2[1], c2[2], 0.04, 1.2, (cz1 - cz0) / 2, b.rot);
				const lp = f.p(cx0 + 0.6, floorY, cz0 + 0.35);
				this.furn.add('locker', { x: lp[0], y: floorY, z: lp[2], ry: b.rot }, 'interior', 1);
				const lp2 = f.p(cx0 + 1.6, floorY, cz0 + 0.35);
				this.furn.add('locker', { x: lp2[0], y: floorY, z: lp2[2], ry: b.rot }, 'interior', 1);
				// interview room table
				const tp = f.p((main.x0 + main.x1) / 2, floorY, main.z0 + 1.4);
				this.furn.add('diningTable', { x: tp[0], y: floorY, z: tp[2], ry: b.rot }, 'interior', 1);
			}
		}
		// exterior: flag poles flanking the entrance, wall lights, radio mast on the roof
		const fr = f.p(-4.5, 0, b.d / 2 + 4), fl = f.p(4.5, 0, b.d / 2 + 4);
		if (this.free(fr[0], fr[2], 0.5)) placeProp(ctx, this.city, 'flagpole', fr[0], ctx.data.heightAt(fr[0], fr[2]), fr[2], b.rot, 1);
		if (this.free(fl[0], fl[2], 0.5)) placeProp(ctx, this.city, 'flagpole', fl[0], ctx.data.heightAt(fl[0], fl[2]), fl[2], b.rot, 0);
		const a = this.acc('plain', b.x, b.z), g = this.acc('lampGlow', b.x, b.z);
		for (let k = -2; k <= 2; k++)
		{
			const x = k * b.w / 5;
			box(a, f, x - 0.25, floorY + 3.6, b.d / 2, x + 0.25, floorY + 3.9, b.d / 2 + 0.35, DARK);
			box(g, f, x - 0.2, floorY + 3.58, b.d / 2 + 0.05, x + 0.2, floorY + 3.6, b.d / 2 + 0.3, [1, 1, 1]);
		}
		const y1 = b.baseY + b.h;
		const mx = -b.w * 0.3, mz = -b.d * 0.3;
		for (let k = 0; k < 3; k++) cyl(a, f, mx + (k === 1 ? 0.6 : 0), y1, mz + (k === 2 ? 0.6 : 0), 14, 0.04, 0.04, 4, STEEL);
		for (let k = 0; k < 14; k += 1.5) box(a, f, mx - 0.05, y1 + k, mz - 0.05, mx + 0.65, y1 + k + 0.04, mz + 0.65, STEEL);
		box(this.acc('signalRed', b.x, b.z), f, mx + 0.1, y1 + 14, mz + 0.1, mx + 0.5, y1 + 14.3, mz + 0.5, [1, 1, 1]);
		// blue stripe under the cornice + POLICE / SHERIFF lettering band
		box(a, f, -b.w / 2 - 0.02, floorY + 4.3, b.d / 2, b.w / 2 + 0.02, floorY + 4.6, b.d / 2 + 0.04, sheriff ? [0.45, 0.3, 0.12] : [0.12, 0.22, 0.5]);
		// parked cruisers along the sides (only where there is room off the road)
		const spots: number[][] = [];
		for (let side = -1; side <= 1; side += 2)
			for (let k = 0; k < 4; k++) spots.push([side * (b.w / 2 + 4.5), b.d / 2 - 4 - k * 3.2, Math.PI / 2 * side]);
		if (sheriff) for (let k = 0; k < 5; k++) spots.push([-b.w / 2 + 5 + k * 3.2, b.d / 2 + 8, Math.PI]);
		for (let i = 0; i < spots.length; i++)
		{
			const p = f.p(spots[i][0], 0, spots[i][1]);
			if (!this.free(p[0], p[2], 1.8)) continue;
			const y = ctx.data.heightAt(p[0], p[2]);
			placeProp(ctx, this.city, 'policeCar', p[0], y, p[2], b.rot + spots[i][2], sheriff ? 1 : 0);
			ctx.phys.box(p[0], y + 0.75, p[2], 0.95, 0.75, 2.3, b.rot + spots[i][2]);
			// parking lines
			const d = this.acc('decal', p[0], p[2]);
			const pf = new Frame(p[0], y + 0.06, p[2], b.rot + spots[i][2]);
			d.face([pf.p(-1.4, 0, -2.6), pf.p(-1.3, 0, -2.6), pf.p(-1.3, 0, 2.6), pf.p(-1.4, 0, 2.6)], [0, 1, 0], [[0, 0], [0, 0], [0, 0], [0, 0]], [0.9, 0.9, 0.88]);
			this.stats.cruisers++;
		}
	}

	private helipad(b: Building): void
	{
		const y = b.baseY + b.h + 0.02;
		const f = new Frame(b.x, y, b.z, b.rot);
		const d = this.acc('decal', b.x, b.z);
		const Z = [[0, 0], [0, 0], [0, 0], [0, 0]];
		const q = (x0: number, z0: number, x1: number, z1: number, c: number[]) => d.face([f.p(x0, 0, z0), f.p(x1, 0, z0), f.p(x1, 0, z1), f.p(x0, 0, z1)], [0, 1, 0], Z, c);
		const Y = [0.9, 0.75, 0.15], W = [0.95, 0.95, 0.95];
		for (let i = 0; i < 24; i++)
		{
			const a0 = i / 24 * Math.PI * 2, a1 = (i + 0.7) / 24 * Math.PI * 2;
			d.face([f.p(Math.cos(a0) * 7, 0, Math.sin(a0) * 7), f.p(Math.cos(a1) * 7, 0, Math.sin(a1) * 7), f.p(Math.cos(a1) * 7.5, 0, Math.sin(a1) * 7.5), f.p(Math.cos(a0) * 7.5, 0, Math.sin(a0) * 7.5)], [0, 1, 0], [[0, 0], [0, 0], [0, 0], [0, 0]], Y);
		}
		q(-2.5, -3, -1.5, 3, W); q(1.5, -3, 2.5, 3, W); q(-1.5, -0.5, 1.5, 0.5, W);
		const a = this.acc('plain', b.x, b.z), g = this.acc('lampGlow', b.x, b.z);
		for (let i = 0; i < 8; i++)
		{
			const an = i / 8 * Math.PI * 2;
			box(a, f, Math.cos(an) * 8.4 - 0.12, 0, Math.sin(an) * 8.4 - 0.12, Math.cos(an) * 8.4 + 0.12, 0.12, Math.sin(an) * 8.4 + 0.12, DARK);
			box(g, f, Math.cos(an) * 8.4 - 0.08, 0.12, Math.sin(an) * 8.4 - 0.08, Math.cos(an) * 8.4 + 0.08, 0.2, Math.sin(an) * 8.4 + 0.08, [1, 1, 1]);
		}
	}

	// -----------------------------------------------------------------------
	// Prison

	private prisonWall(b: Building): void
	{
		const y1 = b.baseY + b.h;
		const f = new Frame(b.x, 0, b.z, b.rot);
		const a = this.acc('plain', b.x, b.z);
		const along = b.w > b.d;
		const L = along ? b.w : b.d;
		// coping + razor wire coils along the top
		if (along) box(a, f, -b.w / 2, y1, -b.d / 2 - 0.15, b.w / 2, y1 + 0.15, b.d / 2 + 0.15, [0.6, 0.6, 0.58]);
		else box(a, f, -b.w / 2 - 0.15, y1, -b.d / 2, b.w / 2 + 0.15, y1 + 0.15, b.d / 2, [0.6, 0.6, 0.58]);
		const step = 0.55;
		for (let u = -L / 2 + 0.3; u < L / 2 - 0.3; u += step)
		{
			// one coil loop: a thin ring standing across the wall
			const sub = along ? f.sub(u, y1 + 0.6, 0, 0) : f.sub(0, y1 + 0.6, u, Math.PI / 2);
			for (let i = 0; i < 8; i++)
			{
				const a0 = i / 8 * Math.PI * 2, a1 = (i + 1) / 8 * Math.PI * 2;
				box(a, sub, -0.015, Math.sin(a0) * 0.45 - 0.015, Math.cos(a0) * 0.45 - 0.015, 0.015, Math.sin(a0) * 0.45 + 0.015, Math.cos(a0) * 0.45 + 0.015, WIRE, '');
				void a1;
			}
		}
		// buttress pilasters every 10 m (outer face)
		for (let u = -L / 2 + 5; u < L / 2; u += 10)
		{
			if (along) { box(a, f, u - 0.3, b.baseY, -b.d / 2 - 0.35, u + 0.3, y1 - 0.4, b.d / 2 + 0.35, [0.62, 0.61, 0.58], 't'); }
			else { box(a, f, -b.w / 2 - 0.35, b.baseY, u - 0.3, b.w / 2 + 0.35, y1 - 0.4, u + 0.3, [0.62, 0.61, 0.58], 't'); }
		}
	}

	private guardTower(b: Building): void
	{
		const ctx = this.ctx;
		const gy = b.groundY !== undefined ? b.groundY : b.baseY + 0.8;
		const f = new Frame(b.x, 0, b.z, 0);
		const a = this.acc('concrete', b.x, b.z), p = this.acc('plain', b.x, b.z), gl = this.acc('glassPane', b.x, b.z), g = this.acc('lampGlow', b.x, b.z);
		const shaftTop = gy + 9, cabTop = shaftTop + 3.2;
		box(a, f, -1.6, b.baseY, -1.6, 1.6, shaftTop, 1.6, CONCRETE, '', 0.25);
		// cab floor slab with a catwalk
		box(p, f, -3.0, shaftTop - 0.25, -3.0, 3.0, shaftTop, 3.0, [0.55, 0.55, 0.53]);
		// railings around the catwalk
		const r = 2.95;
		for (let s = 0; s < 4; s++)
		{
			const sub = f.sub(0, 0, 0, s * Math.PI / 2);
			box(p, sub, -r, shaftTop + 1.0, r - 0.05, r, shaftTop + 1.06, r, STEEL);
			box(p, sub, -r, shaftTop + 0.5, r - 0.05, r, shaftTop + 0.54, r, STEEL);
			for (let x = -r; x <= r; x += 1.0) box(p, sub, x - 0.03, shaftTop, r - 0.06, x + 0.03, shaftTop + 1.06, r, STEEL);
		}
		// cab: low wall, glazing band, posts, overhanging roof
		const c = 2.2;
		box(a, f, -c, shaftTop, -c, c, shaftTop + 1.0, c, CONCRETE, 'b', 0.25);
		for (let s = 0; s < 4; s++)
		{
			const sub = f.sub(0, 0, 0, s * Math.PI / 2);
			const Z = [[0, 0], [0, 0], [0, 0], [0, 0]];
			gl.face([sub.p(-c, shaftTop + 1.0, c), sub.p(c, shaftTop + 1.0, c), sub.p(c, cabTop - 0.3, c), sub.p(-c, cabTop - 0.3, c)], sub.n(0, 0, 1), Z, [0.4, 0.5, 0.55]);
			box(p, sub, -c - 0.05, shaftTop + 1.0, c - 0.1, -c + 0.12, cabTop, c + 0.05, DARK);
			box(p, sub, -0.05, shaftTop + 1.0, c - 0.06, 0.05, cabTop - 0.3, c + 0.02, DARK);
		}
		box(p, f, -c, cabTop - 0.3, -c, c, cabTop, c, DARK, 'b');
		box(p, f, -3.2, cabTop, -3.2, 3.2, cabTop + 0.25, 3.2, [0.3, 0.3, 0.32]);
		// searchlight
		cyl(p, f, 0, cabTop + 0.25, 0, 0.4, 0.1, 0.1, 6, DARK);
		box(p, f, -0.35, cabTop + 0.65, -0.35, 0.35, cabTop + 1.2, 0.45, DARK);
		box(g, f, -0.28, cabTop + 0.72, 0.45, 0.28, cabTop + 1.13, 0.46, [1, 1, 1]);
		ctx.lightSpots.push({ x: b.x, y: cabTop + 1, z: b.z, color: 0xf4f6ff, range: 35, night: true });
		// ladder up the shaft (outside face toward the yard)
		const lz = b.z < -880 ? 1.6 : -1.6;
		const dir = lz > 0 ? 1 : -1;
		for (let y = b.baseY + 1; y < shaftTop; y += 0.3) box(p, f, -0.3, y, lz, 0.3, y + 0.04, lz + dir * 0.18, STEEL);
		box(p, f, -0.34, gy, lz, -0.3, shaftTop + 1, lz + dir * 0.2, STEEL);
		box(p, f, 0.3, gy, lz, 0.34, shaftTop + 1, lz + dir * 0.2, STEEL);
		// colliders
		ctx.bphys.box(b.x, (b.baseY + shaftTop) / 2, b.z, 1.6, (shaftTop - b.baseY) / 2, 1.6, 0);
		ctx.bphys.box(b.x, shaftTop - 0.125, b.z, 3.0, 0.125, 3.0, 0);
		ctx.bphys.box(b.x, cabTop + 0.1, b.z, 3.2, 0.15, 3.2, 0);
		this.stats.towers++;
	}

	private cellBlock(b: Building, plans: InteriorPlan[]): void
	{
		const ctx = this.ctx;
		const plan = plans.filter((p) => p.b === b)[0];
		const f = new Frame(b.x, 0, b.z, b.rot);
		const gY = b.groundY !== undefined ? b.groundY : b.baseY + 0.8;
		const floorY = gY + 0.18;
		const T = 0.3;
		const x0 = -b.w / 2 + T + 4, x1 = b.w / 2 - T - 4;   // keep the ends for stairs / guard post
		const zb = -b.d / 2 + T;
		const depth = 3.0, tierH = 3.1;
		// lower tier
		this.cellRow(f, x0, x1, zb, depth, floorY, tierH - 0.15, 2.6, b.rot, false);
		// upper tier floor slab over the lower cells + catwalk
		const y2 = floorY + tierH;
		const a = this.acc('plain', b.x, b.z);
		const walkD = 1.4;
		box(a, f, x0 - 0.1, y2 - 0.15, zb, x1 + 0.1, y2, zb + depth + walkD, [0.58, 0.58, 0.56]);
		const sc = f.p((x0 + x1) / 2, y2 - 0.075, zb + (depth + walkD) / 2);
		ctx.bphys.box(sc[0], sc[1], sc[2], (x1 - x0) / 2 + 0.1, 0.075, (depth + walkD) / 2, b.rot);
		this.cellRow(f, x0, x1, zb, depth, y2, tierH - 0.3, 2.6, b.rot, false);
		// catwalk railing (visual + physics)
		const zr = zb + depth + walkD;
		box(a, f, x0, y2 + 1.0, zr - 0.05, x1, y2 + 1.06, zr, BARS);
		for (let x = x0; x <= x1; x += 1.2) box(a, f, x - 0.03, y2, zr - 0.06, x + 0.03, y2 + 1.06, zr, BARS);
		const rc = f.p((x0 + x1) / 2, y2 + 0.55, zr - 0.03);
		ctx.bphys.box(rc[0], rc[1], rc[2], (x1 - x0) / 2, 0.55, 0.04, b.rot);
		// stairs at the west end (ramp + steps)
		const run = 5.0;
		const sx = x0 - 1.8, sz0 = zr + 0.2, sz1 = sz0 + run;
		for (let k = 0; k < 16; k++)
		{
			const za = sz1 - (k + 1) * run / 16, zbb = sz1 - k * run / 16;
			box(a, f, sx - 0.6, floorY, za, sx + 0.6, floorY + (k + 1) * tierH / 16, zbb, k % 2 ? [0.5, 0.5, 0.5] : [0.55, 0.55, 0.55], 'b');
		}
		box(a, f, sx - 0.6, y2 - 0.15, zb + depth, x0 + 0.1, y2, sz0 + 0.1, [0.58, 0.58, 0.56]);
		const lc = f.p((sx - 0.6 + x0 + 0.1) / 2, y2 - 0.075, (zb + depth + sz0 + 0.1) / 2);
		ctx.bphys.box(lc[0], lc[1], lc[2], (x0 + 0.1 - sx + 0.6) / 2, 0.075, (sz0 + 0.1 - zb - depth) / 2, b.rot);
		const mid = f.p(sx, floorY + tierH / 2 - 0.1, (sz0 + sz1) / 2);
		ctx.bphys.box(mid[0], mid[1], mid[2], 0.6, 0.1, Math.sqrt(run * run + tierH * tierH) / 2, b.rot, Math.atan2(tierH, run));
		// day room: steel tables with fixed stools, guard desk, TV
		const zt = zr + 3.5;
		for (let x = x0 + 4; x < x1 - 4; x += 7)
		{
			const p = f.p(x, floorY, zt);
			this.furn.add('diningTable', { x: p[0], y: floorY, z: p[2], ry: b.rot }, 'interior', 1);
			for (let k = 0; k < 4; k++)
			{
				const sp = f.p(x + (k % 2 ? 0.5 : -0.5), floorY, zt + (k < 2 ? 0.8 : -0.8));
				this.furn.add('barStool', { x: sp[0], y: floorY, z: sp[2], ry: b.rot }, 'interior');
			}
			ctx.bphys.box(p[0], floorY + 0.38, p[2], 0.8, 0.38, 0.45, b.rot);
		}
		const gp = f.p(x1 + 2.0, floorY, b.d / 2 - T - 2.5);
		this.furn.add('receptionDesk', { x: gp[0], y: floorY, z: gp[2], ry: b.rot + Math.PI / 2 }, 'interior', 1);
		ctx.bphys.box(gp[0], floorY + 0.55, gp[2], 0.45, 0.55, 1.2, b.rot);
		const tv = f.p((x0 + x1) / 2, floorY + 2.2, b.d / 2 - T - 0.1);
		this.furn.add('tv', { x: tv[0], y: floorY + 2.2, z: tv[2], ry: b.rot + Math.PI }, 'interior', 1);
		// security lights
		for (let x = x0; x < x1; x += 10) { const lp = f.p(x, floorY + 6, 2); ctx.lightSpots.push({ x: lp[0], y: lp[1], z: lp[2], color: 0xeef4ff, range: 14, night: false }); }
		void plan;
	}

	private prisonGrounds(): void
	{
		const ctx = this.ctx;
		const walls = ctx.data.buildings.filter((b) => b.custom === 'prison' && b.role === 'wall');
		if (walls.length === 0) return;
		let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
		for (let i = 0; i < walls.length; i++)
		{
			const b = walls[i];
			minX = Math.min(minX, b.x - b.w / 2); maxX = Math.max(maxX, b.x + b.w / 2);
			minZ = Math.min(minZ, b.z - b.d / 2); maxZ = Math.max(maxZ, b.z + b.d / 2);
		}
		// inner fence 6 m inside the wall (gap left at the east gate)
		const inset = 6;
		const fx0 = minX + inset, fx1 = maxX - inset, fz0 = minZ + inset, fz1 = maxZ - inset;
		const gateZ = (-889 + -871) / 2;
		const fenceRun = (ax: number, az: number, bx: number, bz: number) =>
		{
			const len = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
			const n = Math.max(1, Math.round(len / 3));
			const r = Math.atan2(bz - az, bx - ax);
			for (let k = 0; k < n; k++)
			{
				const t = (k + 0.5) / n;
				const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
				placeProp(ctx, this.city, 'chainLinkFence', x, ctx.data.heightAt(x, z), z, -r, 0, len / n);
				// wire coil on top
				const y = ctx.data.heightAt(x, z) + 2.25;
				const f = new Frame(x, y, z, -r);
				const a = this.acc('plain', x, z);
				for (let u = -len / n / 2; u < len / n / 2; u += 0.5) for (let i = 0; i < 6; i++)
				{
					const an = i / 6 * Math.PI * 2;
					box(a, f, u - 0.012, Math.sin(an) * 0.3 - 0.012, Math.cos(an) * 0.3 - 0.012, u + 0.012, Math.sin(an) * 0.3 + 0.012, Math.cos(an) * 0.3 + 0.012, WIRE, '');
				}
			}
		};
		fenceRun(fx0, fz0, fx1, fz0);
		fenceRun(fx0, fz1, fx1, fz1);
		fenceRun(fx0, fz0, fx0, fz1);
		fenceRun(fx1, fz0, fx1, gateZ - 6);
		fenceRun(fx1, gateZ + 6, fx1, fz1);
		// yard on the west strip
		const yx0 = minX + 9, yx1 = minX + 28;
		const yards = [[yx0 + 4, minZ + 30], [yx0 + 4, maxZ - 30]];
		for (let k = 0; k < yards.length; k++)
		{
			const x = yards[k][0], z = yards[k][1];
			const y = ctx.data.heightAt(x, z);
			// court slab with lines
			const f = new Frame((yx0 + yx1) / 2, y + 0.05, z, 0);
			const d = this.acc('decal', x, z);
			const Z = [[0, 0], [0, 0], [0, 0], [0, 0]];
			d.face([f.p(-9, 0, -7.5), f.p(9, 0, -7.5), f.p(9, 0, 7.5), f.p(-9, 0, 7.5)], [0, 1, 0], Z, [0.42, 0.42, 0.42]);
			d.face([f.p(-0.05, 0.01, -7.5), f.p(0.05, 0.01, -7.5), f.p(0.05, 0.01, 7.5), f.p(-0.05, 0.01, 7.5)], [0, 1, 0], Z, [0.9, 0.9, 0.9]);
			placeProp(ctx, this.city, 'hoop', (yx0 + yx1) / 2 - 8.4, y, z, Math.PI / 2);
			placeProp(ctx, this.city, 'hoop', (yx0 + yx1) / 2 + 8.4, y, z, -Math.PI / 2);
			placeProp(ctx, this.city, 'bleacher', (yx0 + yx1) / 2, y, z + 10.5, Math.PI);
			for (let w = 0; w < 3; w++) placeProp(ctx, this.city, 'weightBench', (yx0 + yx1) / 2 - 4 + w * 3, y, z - 11, 0);
			for (let w = 0; w < 2; w++) placeProp(ctx, this.city, 'picnicTable', (yx0 + yx1) / 2 - 3 + w * 6, y, z + 14.5, 0);
		}
		// floodlights in the corners of the inner compound
		this.floodlight(fx0 + 3, fz0 + 3, 16); this.floodlight(fx1 - 3, fz0 + 3, 16);
		this.floodlight(fx0 + 3, fz1 - 3, 16); this.floodlight(fx1 - 3, fz1 - 3, 16);
		this.floodlight((fx0 + fx1) / 2, fz0 + 3, 16); this.floodlight((fx0 + fx1) / 2, fz1 - 3, 16);
		// sally port: a sliding gate half open, plus a gate house outside
		const gx = maxX + 0.3;
		const gy = ctx.data.heightAt(gx, gateZ);
		const gf = new Frame(gx, gy, gateZ, Math.PI / 2);
		const a = this.acc('plain', gx, gateZ);
		box(a, gf, -12, 0, -0.1, -5, 4.5, 0.1, [0.25, 0.26, 0.28]);
		for (let x = -12; x <= -5; x += 0.25) box(a, gf, x - 0.03, 0, -0.12, x + 0.03, 4.5, 0.12, [0.3, 0.31, 0.33]);
		box(a, gf, -13, 4.5, -0.15, 9, 4.7, 0.15, [0.85, 0.7, 0.1]);
		ctx.phys.box(gx, gy + 2.25, gateZ - 8.5, 0.15, 2.25, 3.5, 0);
		const hx = maxX + 9, hz = gateZ + 14;
		if (this.free(hx, hz, 1))
		{
			const hy = ctx.data.heightAt(hx, hz);
			const hf = new Frame(hx, hy, hz, -Math.PI / 2);
			const c = this.acc('concrete', hx, hz), gl = this.acc('glassPane', hx, hz);
			box(c, hf, -1.8, -0.5, -1.5, 1.8, 1.0, 1.5, CONCRETE, '', 0.25);
			const Z = [[0, 0], [0, 0], [0, 0], [0, 0]];
			for (let s = 0; s < 4; s++)
			{
				const sub = hf.sub(0, 0, 0, s * Math.PI / 2);
				const hw = s % 2 ? 1.5 : 1.8, hd = s % 2 ? 1.8 : 1.5;
				gl.face([sub.p(-hw, 1.0, hd), sub.p(hw, 1.0, hd), sub.p(hw, 2.3, hd), sub.p(-hw, 2.3, hd)], sub.n(0, 0, 1), Z, [0.35, 0.45, 0.5]);
			}
			box(this.acc('plain', hx, hz), hf, -2.1, 2.3, -1.8, 2.1, 2.55, 1.8, DARK);
			for (let k = 0; k < 4; k++) box(this.acc('plain', hx, hz), hf, (k % 2 ? 1.7 : -1.8), 1.0, (k < 2 ? 1.4 : -1.5), (k % 2 ? 1.8 : -1.7), 2.3, (k < 2 ? 1.5 : -1.4), DARK);
			ctx.phys.box(hx, hy + 1.2, hz, 1.8, 1.3, 1.5, -Math.PI / 2);
			for (let k = 0; k < 3; k++) placeProp(ctx, this.city, 'barrier', maxX + 6 + k * 2.2, ctx.data.heightAt(maxX + 6 + k * 2.2, gateZ - 6), gateZ - 6, 0);
		}
		// signs: flag at the admin entrance
		const adm = ctx.data.buildings.filter((b) => b.custom === 'prison' && b.role === 'admin')[0];
		if (adm)
		{
			const f = new Frame(adm.x, 0, adm.z, adm.rot);
			const p = f.p(5, 0, adm.d / 2 + 5);
			if (this.free(p[0], p[2], 0.5)) placeProp(ctx, this.city, 'flagpole', p[0], ctx.data.heightAt(p[0], p[2]), p[2], adm.rot, 1);
		}
	}

	// -----------------------------------------------------------------------
	// Lookout

	private radioMast(b: Building): void
	{
		const ctx = this.ctx;
		const y0 = ctx.data.heightAt(b.x, b.z) - 0.3;
		const H = b.h;
		const f = new Frame(b.x, y0, b.z, 0);
		const a = this.acc('plain', b.x, b.z);
		const red = [0.75, 0.15, 0.1], white = [0.92, 0.92, 0.9];
		const w0 = 1.4;
		for (let k = 0; k < 3; k++)
		{
			const an = k / 3 * Math.PI * 2;
			const x = Math.cos(an) * w0, z = Math.sin(an) * w0;
			for (let s = 0; s < 9; s++) cyl(a, f, x, s * H / 9, z, H / 9, 0.06, 0.06, 5, s % 2 ? white : red);
		}
		for (let y = 1; y < H; y += 1.6)
		{
			for (let k = 0; k < 3; k++)
			{
				const a0 = k / 3 * Math.PI * 2, a1 = (k + 1) / 3 * Math.PI * 2;
				const sub = f.sub(Math.cos(a0) * w0, y, Math.sin(a0) * w0, -Math.atan2(Math.sin(a1) * w0 - Math.sin(a0) * w0, Math.cos(a1) * w0 - Math.cos(a0) * w0));
				box(a, sub, 0, -0.02, -0.02, w0 * Math.sqrt(3), 0.02, 0.02, (Math.floor(y / 5) % 2) ? white : red);
			}
		}
		for (let k = 0; k < 4; k++) cylX(a, f, -0.6, 0.6, H * (0.5 + k * 0.12), 0, 0.25, 8, [0.85, 0.85, 0.85]);
		box(this.acc('signalRed', b.x, b.z), f, -0.2, H, -0.2, 0.2, H + 0.4, 0.2, [1, 1, 1]);
		box(this.acc('signalRed', b.x, b.z), f, -0.15 + w0, H * 0.5, -0.15, 0.15 + w0, H * 0.5 + 0.3, 0.15, [1, 1, 1]);
		// equipment hut + fence
		const hx = b.x - 4, hz = b.z + 3;
		const hy = ctx.data.heightAt(hx, hz);
		const hf = new Frame(hx, hy, hz, 0);
		box(this.acc('concrete', hx, hz), hf, -1.5, -0.6, -1.2, 1.5, 2.4, 1.2, CONCRETE, '', 0.25);
		box(a, hf, -1.7, 2.4, -1.4, 1.7, 2.6, 1.4, DARK);
		ctx.phys.box(hx, hy + 1, hz, 1.5, 1.6, 1.2, 0);
		ctx.phys.box(b.x, y0 + 6, b.z, 1.3, 6, 1.3, 0);
	}

	private lookout(): void
	{
		const ctx = this.ctx;
		const cabin = ctx.data.buildings.filter((b) => b.custom === 'lookout' && b.role === 'cabin')[0];
		const lm = ctx.data.landmarks.filter((l) => l.name.indexOf('Lookout') >= 0)[0];
		if (!lm) return;
		// pick the flattest free spot near the summit for the fire-lookout tower
		let best: number[] = null, bestScore = 1e9;
		for (let r = 14; r <= 34; r += 4)
			for (let k = 0; k < 16; k++)
			{
				const an = k / 16 * Math.PI * 2;
				const x = lm.x + Math.cos(an) * r, z = lm.z + Math.sin(an) * r;
				if (!this.free(x, z, 5)) continue;
				const h = ctx.data.heightAt(x, z);
				let slope = 0;
				for (let s = 0; s < 4; s++) slope = Math.max(slope, Math.abs(ctx.data.heightAt(x + Math.cos(s * 1.57) * 4, z + Math.sin(s * 1.57) * 4) - h));
				const score = slope * 3 - h * 0.2 + r * 0.05;
				if (score < bestScore) { bestScore = score; best = [x, z]; }
			}
		if (best) this.fireTower(best[0], best[1], Math.atan2(lm.x - best[0], lm.z - best[1]));
		// viewing deck at the end of the road
		const deck: number[][] = [];
		for (let k = 0; k < 16; k++)
		{
			const an = k / 16 * Math.PI * 2;
			const x = lm.x + Math.cos(an) * 9, z = lm.z + Math.sin(an) * 9;
			if (this.free(x, z, 2.5)) deck.push([x, z, an]);
		}
		if (deck.length)
		{
			// the deck faces outwards (downhill)
			let pick = deck[0], low = 1e9;
			for (let i = 0; i < deck.length; i++) { const h = ctx.data.heightAt(deck[i][0] + Math.cos(deck[i][2]) * 12, deck[i][1] + Math.sin(deck[i][2]) * 12); if (h < low) { low = h; pick = deck[i]; } }
			const x = pick[0], z = pick[1];
			const rot = Math.atan2(Math.cos(pick[2]), Math.sin(pick[2]));
			const y = ctx.data.heightAt(x, z) + 0.35;
			const f = new Frame(x, y, z, rot);
			const a = this.acc('plain', x, z);
			const wood = [0.52, 0.38, 0.25];
			box(a, f, -5, -2.5, -2.5, 5, 0, 2.5, wood, '');
			for (let k = -5; k < 5; k += 0.3) box(a, f, k, 0, -2.5, k + 0.02, 0.005, 2.5, [0.4, 0.28, 0.18], 'b');
			ctx.phys.box(x, y - 0.15, z, 5, 0.15, 2.5, rot);
			// railing on three sides
			const rail = (ax: number, az: number, bx: number, bz: number) =>
			{
				const len = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
				const sub = f.sub(ax, 0, az, -Math.atan2(bz - az, bx - ax));
				box(a, sub, 0, 1.0, -0.05, len, 1.1, 0.05, wood);
				box(a, sub, 0, 0.5, -0.03, len, 0.56, 0.03, wood);
				for (let u = 0; u <= len; u += 1.25) box(a, sub, u - 0.06, -0.3, -0.06, u + 0.06, 1.1, 0.06, wood);
				const c = f.p((ax + bx) / 2, 0.55, (az + bz) / 2);
				ctx.phys.box(c[0], c[1], c[2], len / 2, 0.55, 0.06, rot - Math.atan2(bz - az, bx - ax));
			};
			rail(-5, 2.5, 5, 2.5); rail(-5, -2.5, -5, 2.5); rail(5, -2.5, 5, 2.5);
			const t1 = f.p(-2.5, 0, 1.7), t2 = f.p(2.5, 0, 1.7);
			placeProp(ctx, this.city, 'telescope', t1[0], y, t1[2], rot);
			placeProp(ctx, this.city, 'telescope', t2[0], y, t2[2], rot);
			const ib = f.p(0, 0, -1.8);
			placeProp(ctx, this.city, 'infoBoard', ib[0], y, ib[2], rot + Math.PI);
			const bn = f.p(-3, 0, -1.8);
			placeProp(ctx, this.city, 'bench', bn[0], y, bn[2], rot);
		}
		// picnic area around the cabin
		if (cabin)
		{
			for (let k = 0; k < 4; k++)
			{
				const an = k * 1.4 + 0.3;
				const x = cabin.x + Math.cos(an) * 10, z = cabin.z + Math.sin(an) * 10;
				if (this.free(x, z, 1.5)) placeProp(ctx, this.city, 'picnicTable', x, ctx.data.heightAt(x, z), z, an);
			}
		}
	}

	/** Classic fire-lookout tower: four legs, cross bracing, switch-back stairs and a glass cab on top. */
	private fireTower(x: number, z: number, rot: number): void
	{
		const ctx = this.ctx;
		const y0 = ctx.data.heightAt(x, z);
		const f = new Frame(x, y0, z, rot);
		const a = this.acc('plain', x, z), gl = this.acc('glassPane', x, z);
		const wood = [0.5, 0.36, 0.24], steel = [0.42, 0.43, 0.45];
		const H = 15, base = 3.2, topW = 2.4;
		// legs (tapered) and bracing
		for (let k = 0; k < 4; k++)
		{
			const sx = k % 2 ? 1 : -1, sz = k < 2 ? 1 : -1;
			for (let s = 0; s < 10; s++)
			{
				const t0 = s / 10, t1 = (s + 1) / 10;
				const w0 = base + (topW - base) * t0, w1 = base + (topW - base) * t1;
				boxC(a, f, sx * (w0 + w1) / 2, -0.5 + (H + 0.5) * (t0 + t1) / 2, sz * (w0 + w1) / 2, 0.22, (H + 0.5) / 10 + 0.02, 0.22, steel);
			}
			ctx.phys.box.apply(ctx.phys, f.p(sx * (base + topW) / 2, H / 2, sz * (base + topW) / 2).concat([0.15, H / 2, 0.15, rot]));
		}
		for (let lvl = 0; lvl < 5; lvl++)
		{
			const y = 1 + lvl * 3;
			const w = base + (topW - base) * (y / H);
			for (let s = 0; s < 4; s++)
			{
				const sub = f.sub(0, 0, 0, s * Math.PI / 2);
				box(a, sub, -w, y - 0.06, w - 0.06, w, y + 0.06, w + 0.06, steel);
			}
		}
		// switch-back stairs on the outside of the legs: flights alternate sides
		const flights = 6, rise = H / flights, run = 4.4;
		const so = base + 0.9;
		for (let k = 0; k < flights; k++)
		{
			const side = k % 2 ? 1 : -1;                 // +x side or -x side
			const yb = k * rise, yt = (k + 1) * rise;
			const dir = k % 2 ? -1 : 1;                  // climbing toward +z or -z
			const zA = -dir * run / 2, zB = dir * run / 2;
			const n = 12;
			for (let s = 0; s < n; s++)
			{
				const zz0 = zA + (zB - zA) * s / n, zz1 = zA + (zB - zA) * (s + 1) / n;
				const y = yb + (s + 1) * rise / n;
				box(a, f, side * so - 0.55, y - 0.08, Math.min(zz0, zz1), side * so + 0.55, y, Math.max(zz0, zz1), wood);
			}
			// stringer rails
			box(a, f, side * so + side * 0.55, yb, -run / 2, side * so + side * 0.6, yt + 1.0, run / 2, wood);
			const mid = f.p(side * so, (yb + yt) / 2 - 0.08, 0);
			const ang = Math.atan2(rise, run) * dir;
			ctx.phys.box(mid[0], mid[1], mid[2], 0.55, 0.08, Math.sqrt(run * run + rise * rise) / 2, rot, -ang);
			const rl = f.p(side * (so + 0.62), (yb + yt) / 2 + 0.6, 0);
			ctx.phys.box(rl[0], rl[1], rl[2], 0.04, 0.6, run / 2, rot);
			// landing joining this flight to the next on the other side
			if (k < flights - 1)
			{
				const zl = zB + dir * 0.7;
				box(a, f, -so - 0.55, yt - 0.12, zl - 0.7, so + 0.55, yt, zl + 0.7, wood);
				const lp = f.p(0, yt - 0.06, zl);
				ctx.phys.box(lp[0], lp[1], lp[2], so + 0.55, 0.06, 0.7, rot);
				box(a, f, -so - 0.55, yt + 1.0, zl + dir * 0.65, so + 0.55, yt + 1.06, zl + dir * 0.7, wood);
				const lr = f.p(0, yt + 0.55, zl + dir * 0.68);
				ctx.phys.box(lr[0], lr[1], lr[2], so + 0.55, 0.55, 0.04, rot);
			}
		}
		// top deck + cab
		const top = H;
		box(a, f, -so - 0.6, top - 0.2, -so - 0.6, so + 0.6, top, so + 0.6, wood);
		ctx.phys.box(x, y0 + top - 0.1, z, so + 0.6, 0.1, so + 0.6, rot);
		for (let s = 0; s < 4; s++)
		{
			const sub = f.sub(0, 0, 0, s * Math.PI / 2);
			const e = so + 0.55;
			// railing, leaving the stair arrival open on the last flight side
			box(a, sub, -e, top + 1.0, e - 0.05, e, top + 1.06, e, wood);
			for (let u = -e; u <= e; u += 0.9) box(a, sub, u - 0.04, top, e - 0.08, u + 0.04, top + 1.06, e, wood);
			const rp = sub.p(0, top + 0.55, e - 0.03);
			ctx.phys.box(rp[0], rp[1], rp[2], e * (s % 2 ? 1 : 1), 0.55, 0.04, rot + s * Math.PI / 2);
		}
		// cab: 4 x 4 m, window band all round, door on the stair side, hip roof
		const c = 2.0, ch = 2.6;
		const Z = [[0, 0], [0, 0], [0, 0], [0, 0]];
		for (let s = 0; s < 4; s++)
		{
			const sub = f.sub(0, 0, 0, s * Math.PI / 2);
			box(a, sub, -c, top, c - 0.1, c, top + 1.0, c, [0.75, 0.68, 0.55]);
			gl.face([sub.p(-c, top + 1.0, c), sub.p(c, top + 1.0, c), sub.p(c, top + ch, c), sub.p(-c, top + ch, c)], sub.n(0, 0, 1), Z, [0.45, 0.55, 0.6]);
			gl.face([sub.p(c, top + 1.0, c - 0.02), sub.p(-c, top + 1.0, c - 0.02), sub.p(-c, top + ch, c - 0.02), sub.p(c, top + ch, c - 0.02)], sub.n(0, 0, -1), Z, [0.45, 0.55, 0.6]);
			for (let u = -c; u <= c + 0.01; u += c / 2) box(a, sub, u - 0.05, top + 1.0, c - 0.08, u + 0.05, top + ch, c, [0.3, 0.25, 0.2]);
			const wp = sub.p(0, top + ch / 2, c - 0.05);
			if (s !== 0) ctx.phys.box(wp[0], wp[1], wp[2], c, ch / 2, 0.06, rot + s * Math.PI / 2);
			// roof slope
			a.face([sub.p(-c - 0.5, top + ch, c + 0.5), sub.p(c + 0.5, top + ch, c + 0.5), sub.p(0, top + ch + 1.3, 0)], sub.n(0, 0.8, 0.6), [[0, 0], [0, 0], [0, 0]], [0.3, 0.22, 0.16]);
		}
		ctx.phys.box(x, y0 + top + ch + 0.1, z, c, 0.1, c, rot);
		// inside the cab: the fire finder (telescope) on a stand and a stool
		const tp = f.p(0, top, 0);
		this.furn.add('telescope', { x: tp[0], y: tp[1], z: tp[2], ry: rot }, 'interior');
		const st = f.p(0.9, top, -0.9);
		this.furn.add('barStool', { x: st[0], y: st[1], z: st[2], ry: rot }, 'interior');
		const lp = f.p(0, top + ch - 0.2, 0);
		ctx.lightSpots.push({ x: lp[0], y: lp[1], z: lp[2], color: 0xffe2b0, range: 7, night: false });
		this.stats.towers++;
	}
}

/** Decorative parked cruiser (black & white or sheriff tan/green) with a light bar. */
function policeCar(ctx: RealismCtx, v: number): any[]
{
	const a = new GeoAccum(), s = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	const body = v ? [0.85, 0.82, 0.72] : [0.08, 0.08, 0.09];
	const door = v ? [0.2, 0.35, 0.25] : [0.95, 0.95, 0.95];
	box(a, f, -0.92, 0.35, -2.35, 0.92, 0.95, 2.35, body);
	box(a, f, -0.93, 0.4, -0.9, 0.93, 0.92, 0.9, door);
	box(a, f, -0.82, 0.95, -1.1, 0.82, 1.45, 0.85, body);
	box(s, f, -0.8, 1.0, 0.85, 0.8, 1.4, 0.95, [0.05, 0.06, 0.08]);
	box(s, f, -0.8, 1.0, -1.2, 0.8, 1.4, -1.1, [0.05, 0.06, 0.08]);
	box(s, f, -0.83, 1.0, -1.0, 0.83, 1.4, 0.75, [0.05, 0.06, 0.08]);
	box(a, f, -0.82, 1.45, -1.1, 0.82, 1.5, 0.85, body);
	box(a, f, -0.65, 1.5, -0.25, -0.05, 1.62, 0.05, [0.85, 0.1, 0.1]);
	box(a, f, 0.05, 1.5, -0.25, 0.65, 1.62, 0.05, [0.1, 0.25, 0.9]);
	box(a, f, -0.95, 0.35, 2.3, 0.95, 0.6, 2.42, [0.15, 0.15, 0.15]);
	box(s, f, -0.85, 0.7, 2.34, -0.55, 0.85, 2.38, [0.95, 0.95, 0.85]);
	box(s, f, 0.55, 0.7, 2.34, 0.85, 0.85, 2.38, [0.95, 0.95, 0.85]);
	box(a, f, -0.85, 0.7, -2.38, -0.55, 0.85, -2.35, [0.7, 0.05, 0.05]);
	box(a, f, 0.55, 0.7, -2.38, 0.85, 0.85, -2.35, [0.7, 0.05, 0.05]);
	for (let k = 0; k < 4; k++) { const wf = f.sub((k % 2 ? 0.82 : -0.82), 0.36, (k < 2 ? 1.45 : -1.45), Math.PI / 2); cyl(a, wf, 0, 0, 0, 0.001, 0, 0, 3, DARK); }
	for (let k = 0; k < 4; k++) cylX(a, f, (k % 2 ? 0.72 : -0.98), (k % 2 ? 0.98 : -0.72), 0.36, (k < 2 ? 1.45 : -1.45), 0.36, 12, DARK);
	return partsFrom(ctx, [[a, 'plain'], [s, 'shiny']]);
}
