/*
 * RealismBuildings.ts
 * -------------------
 * Real 3D buildings for San Verano County.
 *
 *  - Every house gets lap siding, real framed windows (glass you can see
 *    through on houses you can enter), a front door you can walk through, a
 *    back door, a porch with steps, a porch light, gutters, chimney, AC unit.
 *  - Shops, offices, towers, civic buildings and warehouses get storefront
 *    glass, an entrance, awnings, shop signs, cornices and rooftop gear.
 *  - Enterable buildings are hollow: walls with thickness, floors, ceilings,
 *    interior walls with doorways and (for 2-storey houses) working stairs.
 *    Furniture is placed by RealismInteriors.ts from the room plans returned here.
 *  - Buildings in the gang neighbourhoods are run down: faded paint, dirt,
 *    graffiti, broken or boarded windows.
 */

import * as THREE from 'three';
import { Building } from './RealismMapData';
import { RealismCtx, chunkKey, RENDER_CHUNK, DETAIL_CHUNK, addMesh } from './RealismContext';
import { AccumSet, GeoAccum, Frame, box, boxC, cyl, wallPieces, Opening, hash01 } from './RealismGeometry';
import { STYLES, StyleDef, signTexture } from './RealismMaterials';
import { ruleMatches, placeBuildingModel } from './RealismAssets';

// ---------------------------------------------------------------------------
// Room plans handed to the interior decorator
// ---------------------------------------------------------------------------

export interface Room
{
	type: string;              // living, kitchen, bedroom, bath, hall, dining, shop, back, office, garage...
	x0: number; x1: number; z0: number; z1: number;   // local, inside faces of walls
	y: number;                 // world floor height
	h: number;                 // clear height
	doors: number[][];         // local [x, z] door centres on the room edge (keep clear)
	windows?: number[][];      // local [x, z] of windows on outer walls (keep tall furniture away)
}

export interface InteriorPlan
{
	b: Building;
	f: Frame;                  // origin at building centre, y = 0
	rooms: Room[];
	hood: boolean;
	seed: number;
}

// ---------------------------------------------------------------------------

interface Side { ax: number; az: number; dx: number; dz: number; nx: number; nz: number; len: number; name: string; }

function sidesOf(w: number, d: number): Side[]
{
	return [
		{ name: 'front', ax: -w / 2, az: d / 2, dx: 1, dz: 0, nx: 0, nz: 1, len: w },
		{ name: 'right', ax: w / 2, az: d / 2, dx: 0, dz: -1, nx: 1, nz: 0, len: d },
		{ name: 'back', ax: w / 2, az: -d / 2, dx: -1, dz: 0, nx: 0, nz: -1, len: w },
		{ name: 'left', ax: -w / 2, az: -d / 2, dx: 0, dz: 1, nx: -1, nz: 0, len: d },
	];
}

/** Local point on side `s` at distance u along it, height y, pushed `inset` metres inwards. */
function sp(s: Side, u: number, inset: number): number[]
{
	return [s.ax + s.dx * u - s.nx * inset, s.az + s.dz * u - s.nz * inset];
}

interface WallOpts
{
	acc: GeoAccum;
	f: Frame;
	s: Side;
	inset: number;             // 0 = outer face; T = inner face
	facing: number;            // +1 outwards, -1 inwards
	u0: number; u1: number;    // span along the side
	y0: number; y1: number;    // world heights
	openings: Opening[];       // u relative to the side start, v relative to y0
	color: number[];
	st?: StyleDef;             // texture tiling (outer faces)
	vBase?: number;            // world y where texture v = 0
}

function wallFaces(o: WallOpts): void
{
	const len = o.u1 - o.u0, h = o.y1 - o.y0;
	if (len <= 0.01 || h <= 0.01) return;
	const ops: Opening[] = [];
	for (let i = 0; i < o.openings.length; i++)
	{
		const op = o.openings[i];
		if (op.u1 <= o.u0 || op.u0 >= o.u1 || op.v1 <= 0 || op.v0 >= h) continue;
		ops.push({ u0: op.u0 - o.u0, u1: op.u1 - o.u0, v0: op.v0, v1: op.v1 });
	}
	const pieces = ops.length ? wallPieces(len, h, ops) : [{ u0: 0, u1: len, v0: 0, v1: h }];
	const n = o.f.n(o.s.nx * o.facing, 0, o.s.nz * o.facing);
	const vb = o.vBase === undefined ? o.y0 : o.vBase;
	for (let i = 0; i < pieces.length; i++)
	{
		const pc = pieces[i];
		const a = sp(o.s, o.u0 + pc.u0, o.inset), b = sp(o.s, o.u0 + pc.u1, o.inset);
		const ya = o.y0 + pc.v0, yb = o.y0 + pc.v1;
		let uvs = [[0, 0], [0, 0], [0, 0], [0, 0]];
		if (o.st)
		{
			const ua = (o.u0 + pc.u0) / o.st.tileW, ub = (o.u0 + pc.u1) / o.st.tileW;
			const va = (ya - vb) / o.st.tileH, vbb = (yb - vb) / o.st.tileH;
			uvs = [[ua, va], [ub, va], [ub, vbb], [ua, vbb]];
		}
		o.acc.face([o.f.p(a[0], ya, a[1]), o.f.p(b[0], ya, b[1]), o.f.p(b[0], yb, b[1]), o.f.p(a[0], yb, a[1])], n, uvs, o.color);
	}
}

/** The four reveal faces of an opening through a wall of thickness T. */
function jambs(acc: GeoAccum, f: Frame, s: Side, op: Opening, y0: number, T: number, c: number[], skipBottom: boolean): void
{
	const a0 = sp(s, op.u0, 0), a1 = sp(s, op.u0, T), b0 = sp(s, op.u1, 0), b1 = sp(s, op.u1, T);
	const ya = y0 + op.v0, yb = y0 + op.v1;
	const Z = [[0, 0], [0, 0], [0, 0], [0, 0]];
	acc.face([f.p(a0[0], ya, a0[1]), f.p(a1[0], ya, a1[1]), f.p(a1[0], yb, a1[1]), f.p(a0[0], yb, a0[1])], f.n(s.dx, 0, s.dz), Z, c);
	acc.face([f.p(b1[0], ya, b1[1]), f.p(b0[0], ya, b0[1]), f.p(b0[0], yb, b0[1]), f.p(b1[0], yb, b1[1])], f.n(-s.dx, 0, -s.dz), Z, c);
	acc.face([f.p(a0[0], yb, a0[1]), f.p(b0[0], yb, b0[1]), f.p(b1[0], yb, b1[1]), f.p(a1[0], yb, a1[1])], [0, -1, 0], Z, c);
	if (!skipBottom) acc.face([f.p(a1[0], ya, a1[1]), f.p(b1[0], ya, b1[1]), f.p(b0[0], ya, b0[1]), f.p(a0[0], ya, a0[1])], [0, 1, 0], Z, c);
}

/** Physics boxes for a wall (only door openings are left open). */
function wallPhysics(ctx: RealismCtx, b: Building, f: Frame, s: Side, T: number, y0: number, y1: number, doors: Opening[]): void
{
	const pieces = wallPieces(s.len, y1 - y0, doors);
	for (let i = 0; i < pieces.length; i++)
	{
		const pc = pieces[i];
		const um = (pc.u0 + pc.u1) / 2, hl = (pc.u1 - pc.u0) / 2;
		const c = sp(s, um, T / 2);
		const w = f.p(c[0], y0 + (pc.v0 + pc.v1) / 2, c[1]);
		const hy = (pc.v1 - pc.v0) / 2;
		if (s.dx !== 0) ctx.bphys.box(w[0], w[1], w[2], hl, hy, T / 2, b.rot);
		else ctx.bphys.box(w[0], w[1], w[2], T / 2, hy, hl, b.rot);
	}
}

/** A thin interior partition along local X (at z) or along local Z (at x), both faces + physics. */
function partition(ctx: RealismCtx, acc: GeoAccum, b: Building, f: Frame, alongX: boolean, at: number, from: number, to: number, y0: number, y1: number, doors: number[], col: number[], doorW: number): void
{
	const T = 0.12, dh = Math.min(2.1, y1 - y0 - 0.15);
	const len = to - from;
	if (len < 0.3) return;
	const ops: Opening[] = [];
	for (let i = 0; i < doors.length; i++) ops.push({ u0: doors[i] - from - doorW / 2, u1: doors[i] - from + doorW / 2, v0: -1, v1: dh });
	const pieces = wallPieces(len, y1 - y0, ops.map((o) => ({ u0: o.u0, u1: o.u1, v0: 0, v1: o.v1 })));
	const Z = [[0, 0], [0, 0], [0, 0], [0, 0]];
	for (let i = 0; i < pieces.length; i++)
	{
		const pc = pieces[i];
		const u0 = from + pc.u0, u1 = from + pc.u1, ya = y0 + pc.v0, yb = y0 + pc.v1;
		for (let side = -1; side <= 1; side += 2)
		{
			const off = at + side * T / 2;
			if (alongX) acc.face([f.p(u0, ya, off), f.p(u1, ya, off), f.p(u1, yb, off), f.p(u0, yb, off)], f.n(0, 0, side), Z, col);
			else acc.face([f.p(off, ya, u0), f.p(off, ya, u1), f.p(off, yb, u1), f.p(off, yb, u0)], f.n(side, 0, 0), Z, col);
		}
		const cm = (u0 + u1) / 2, hl = (u1 - u0) / 2, hy = (yb - ya) / 2;
		const w = alongX ? f.p(cm, (ya + yb) / 2, at) : f.p(at, (ya + yb) / 2, cm);
		if (alongX) ctx.bphys.box(w[0], w[1], w[2], hl, hy, T / 2, b.rot);
		else ctx.bphys.box(w[0], w[1], w[2], T / 2, hy, hl, b.rot);
	}
	// door reveals + header faces
	for (let i = 0; i < doors.length; i++)
	{
		const d0 = doors[i] - doorW / 2, d1 = doors[i] + doorW / 2;
		// a real room door, standing open (E closes it). Along X: hinge at d0, leaf along +x;
		// along Z: leaf along +z, i.e. the frame turned by -90 degrees.
		if (ctx.doors && dh > 1.6 && d0 > from - 0.01 && d1 < to + 0.01)
		{
			const hp = alongX ? f.p(d0 + 0.02, y0, at) : f.p(at, y0, d0 + 0.02);
			ctx.doors.add({ kind: 'hinged', x: hp[0], y: y0 + 0.01, z: hp[2], rot: alongX ? b.rot : b.rot - Math.PI / 2, width: doorW - 0.04, height: dh - 0.03,
				thickness: 0.04, color: [0.8, 0.76, 0.68], open: true, interior: true, openAngle: Math.PI * 0.5 });
		}
		const trim = [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8];
		if (alongX)
		{
			acc.face([f.p(d0, y0, at - T / 2), f.p(d0, y0, at + T / 2), f.p(d0, y0 + dh, at + T / 2), f.p(d0, y0 + dh, at - T / 2)], f.n(1, 0, 0), Z, trim);
			acc.face([f.p(d1, y0, at + T / 2), f.p(d1, y0, at - T / 2), f.p(d1, y0 + dh, at - T / 2), f.p(d1, y0 + dh, at + T / 2)], f.n(-1, 0, 0), Z, trim);
			acc.face([f.p(d0, y0 + dh, at - T / 2), f.p(d1, y0 + dh, at - T / 2), f.p(d1, y0 + dh, at + T / 2), f.p(d0, y0 + dh, at + T / 2)], [0, -1, 0], Z, trim);
		}
		else
		{
			acc.face([f.p(at - T / 2, y0, d0), f.p(at + T / 2, y0, d0), f.p(at + T / 2, y0 + dh, d0), f.p(at - T / 2, y0 + dh, d0)], f.n(0, 0, 1), Z, trim);
			acc.face([f.p(at + T / 2, y0, d1), f.p(at - T / 2, y0, d1), f.p(at - T / 2, y0 + dh, d1), f.p(at + T / 2, y0 + dh, d1)], f.n(0, 0, -1), Z, trim);
			acc.face([f.p(at - T / 2, y0 + dh, d0), f.p(at - T / 2, y0 + dh, d1), f.p(at + T / 2, y0 + dh, d1), f.p(at + T / 2, y0 + dh, d0)], [0, -1, 0], Z, trim);
		}
	}
}

function flatRect(acc: GeoAccum, f: Frame, x0: number, z0: number, x1: number, z1: number, y: number, up: boolean, c: number[], uvScale?: number): void
{
	const u = uvScale || 0;
	const uv = u > 0 ? [[x0 * u, z0 * u], [x1 * u, z0 * u], [x1 * u, z1 * u], [x0 * u, z1 * u]] : [[0, 0], [0, 0], [0, 0], [0, 0]];
	acc.face([f.p(x0, y, z0), f.p(x1, y, z0), f.p(x1, y, z1), f.p(x0, y, z1)], [0, up ? 1 : -1, 0], uv, c);
}

function mix(a: number[], b: number[], t: number): number[]
{
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function mul(a: number[], k: number): number[] { return [a[0] * k, a[1] * k, a[2] * k]; }

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const SHOP_SIGNS: { [sub: string]: string[][] } = {
	market: [['MARKET', '#1f6b3a', '#ffffff'], ['FRESH FOODS', '#2d5f2e', '#f2e6b1']],
	convenience: [['LIQUOR & DELI', '#b3201b', '#ffffff'], ['CORNER STORE', '#1d4e89', '#ffd23f'], ['24/7 MART', '#d24b1a', '#ffffff']],
	diner: [['DINER', '#c8102e', '#ffffff']],
	restaurant: [['TACOS', '#d9541e', '#fff3d6'], ['PIZZA', '#1e7a3c', '#ffffff'], ['NOODLE HOUSE', '#8a1c1c', '#f7d774'], ['WINGS', '#202020', '#ffb000']],
	cafe: [['COFFEE', '#4b2e1e', '#f3e2c7'], ['BAKERY & CAFE', '#f1e3c8', '#5b3a24']],
	barber: [['BARBER', '#1b2a49', '#ffffff'], ['FRESH CUTS', '#111111', '#e6c35c']],
	laundromat: [['LAUNDROMAT', '#2a7fc1', '#ffffff'], ['COIN LAUNDRY', '#ffffff', '#2a7fc1']],
	clothing: [['CLOTHING', '#111111', '#ffffff'], ['SNEAKERS', '#e2e2e2', '#d0021b'], ['BOUTIQUE', '#f5d7dd', '#5a2a3a']],
	pawn: [['PAWN', '#f2c230', '#111111']],
};
const AWNING_COLORS = [[0.62, 0.12, 0.1], [0.12, 0.35, 0.2], [0.1, 0.2, 0.45], [0.75, 0.6, 0.15], [0.25, 0.25, 0.27], [0.55, 0.15, 0.35]];
const DOOR_COLORS = [[0.45, 0.12, 0.1], [0.12, 0.2, 0.35], [0.15, 0.3, 0.2], [0.38, 0.25, 0.15], [0.9, 0.9, 0.88], [0.1, 0.1, 0.1]];
const SIGN_COLORS: { [k: string]: string[] } = {
	'POLICE DEPARTMENT': ['#1c3d7a', '#ffffff'],
	'COUNTY SHERIFF': ['#5a3d1c', '#f2d27a'],
	'ST. MARY MEDICAL CENTER': ['#ffffff', '#c41a1a'],
	'FIRE STATION 1': ['#9c1b14', '#ffffff'],
	'GAS': ['#c41a1a', '#ffffff'],
	'MERIDIAN TRUST BANK': ['#0e2a3c', '#e6c36a'],
	'SAN VERANO STATE PRISON': ['#2b2b2b', '#f0f0f0'],
	'VERANO PEAK LOOKOUT': ['#4a3424', '#f3e2c7'],
};

export class BuildingBuilder
{
	private ctx: RealismCtx;
	private set = new AccumSet();
	public plans: InteriorPlan[] = [];
	private signBatches: { [key: string]: { tex: THREE.Texture, acc: GeoAccum } } = {};
	public stats = { shells: 0, enterable: 0, houses: 0, windows: 0, replaced: 0 };

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
	}

	private acc(mat: string, x: number, z: number, detail?: boolean): GeoAccum
	{
		const size = detail ? DETAIL_CHUNK : RENDER_CHUNK;
		return this.set.get(mat + '|' + (detail ? 'd' : 'b') + '|' + chunkKey(x, z, size));
	}

	public build(): void
	{
		const data = this.ctx.data;
		const cfg = this.ctx.cfg;
		// Build one 256 m chunk at a time and upload it before the next, so loading never
		// holds the geometry of the whole city in memory at once (avoids out-of-memory on Chromebooks).
		const order: number[] = [];
		for (let i = 0; i < data.buildings.length; i++) order.push(i);
		const ck = (i: number) => chunkKey(data.buildings[i].x, data.buildings[i].z, RENDER_CHUNK);
		order.sort((a, b) => { const ka = ck(a), kb = ck(b); return ka < kb ? -1 : ka > kb ? 1 : a - b; });
		let lastChunk = '';
		for (let oi = 0; oi < order.length; oi++)
		{
			const i = order[oi];
			const b = data.buildings[i];
			const chunk = ck(i);
			if (chunk !== lastChunk && lastChunk !== '') this.flush(false);
			lastChunk = chunk;
			if ((b.custom === 'prison' && b.role === 'tower') || (b.custom === 'lookout' && b.role === 'mast') || b.custom === 'hotel') continue;  // built by RealismLandmarks
			// user replacement models
			const rules = b.custom ? [] : (b.kind === 'house' ? cfg.house.models : cfg.city.buildingModels);
			let replaced = false;
			for (let r = 0; r < (rules || []).length; r++)
			{
				if (ruleMatches(rules[r], b, hash01(i * 7 + r))) { placeBuildingModel(this.ctx, rules[r], b); replaced = true; this.stats.replaced++; break; }
			}
			if (replaced) continue;
			if (b.style === 'silo') { this.silo(b); if (b.collide) this.ctx.bphys.box(b.x, b.baseY + b.h / 2, b.z, b.w / 2, b.h / 2, b.d / 2, 0); continue; }
			this.building(b, i);
		}
		this.flush();
	}

	public flush(signs: boolean = true): void
	{
		for (let k = 0; k < this.set.keys.length; k++)
		{
			const key = this.set.keys[k];
			const parts = key.split('|');
			const a = this.set.get(key);
			if (a.empty) continue;
			const detail = parts[1] === 'd';
			const mat = this.ctx.mats[parts[0]];
			const cast = parts[0] !== 'graffiti' && parts[0] !== 'grime' && parts[0] !== 'decal' && parts[0] !== 'glassPane' && parts[0] !== 'floor';
			addMesh(this.ctx, a.toGeometry(), mat, cast, true, detail ? 'detail' : 'building');
		}
		if (signs) for (const key in this.signBatches)
		{
			if (!this.signBatches.hasOwnProperty(key)) continue;
			const sb = this.signBatches[key];
			const mesh = addMesh(this.ctx, sb.acc.toGeometry(), new THREE.MeshBasicMaterial({ map: sb.tex, vertexColors: THREE.VertexColors }), false, false, 'detail');
			mesh.name = 'shopSigns';
		}
		this.set = new AccumSet();
	}

	/** A flat sign panel (texture batch keyed by text). */
	public sign(f: Frame, text: string, bg: string, fg: string, cx: number, cy: number, cz: number, width: number, facing: number): void
	{
		const key = text + '|' + bg + '|' + fg;
		let sb = this.signBatches[key];
		if (sb === undefined) { sb = { tex: signTexture(text, bg, fg), acc: new GeoAccum() }; this.signBatches[key] = sb; }
		const h = width * (128 / 1024);
		const s = facing;   // +1 faces +z, -1 faces -z
		const x0 = cx - width / 2 * s, x1 = cx + width / 2 * s;
		sb.acc.face([f.p(x0, cy - h / 2, cz), f.p(x1, cy - h / 2, cz), f.p(x1, cy + h / 2, cz), f.p(x0, cy + h / 2, cz)], f.n(0, 0, s), [[0, 0], [1, 0], [1, 1], [0, 1]], [1, 1, 1]);
	}

	private silo(b: Building): void
	{
		const a = this.acc('metal', b.x, b.z);
		const f = new Frame(b.x, 0, b.z, 0);
		cyl(a, f, 0, b.baseY, 0, b.h, b.w / 2, b.w / 2, 16, b.tint);
		cyl(a, f, 0, b.baseY + b.h, 0, b.w * 0.3, b.w / 2, 0, 16, mul(b.tint, 0.85));
		const d = this.acc('plain', b.x, b.z, true);
		for (let k = 0; k < Math.floor(b.h / 0.6); k++) box(d, f, b.w / 2, b.baseY + 1 + k * 0.6, -0.25, b.w / 2 + 0.05, b.baseY + 1.05 + k * 0.6, 0.25, [0.3, 0.3, 0.3]);
	}

	// -----------------------------------------------------------------------

	public building(b: Building, index: number): void
	{
		const ctx = this.ctx;
		const st = STYLES[b.style] || STYLES.plain;
		const f = new Frame(b.x, 0, b.z, b.rot);
		const seed = (index + 1) * 7919 + Math.floor(b.x * 13 + b.z * 7);
		const rnd = (k: number) => hash01(seed + k * 101);
		const hood = b.district === 'hood' && ctx.cfg.city.gangNeighborhoods !== false;
		const cond = b.condition === undefined ? 1 : b.condition;
		const isHouse = b.style === 'house' || b.kind === 'house';
		const gY = b.groundY !== undefined ? b.groundY : b.baseY + 0.8;
		const y0 = b.baseY, y1 = b.baseY + b.h;
		const small = b.h < 2.2 || b.kind === 'prop' || b.style === 'plain' && b.h < 3 || (b.custom === 'prison' && b.role === 'wall');
		let tint = b.tint;
		if (hood) tint = mix(mul(tint, 0.78), [0.55, 0.52, 0.47], 0.35 * (1 - cond));
		const enter = !!b.enterable && b.w >= 6 && b.d >= 6 && !small;
		const closed = !!b.closed;
		const hangar = b.sub === 'hangar';
		this.stats.shells++;
		if (isHouse) this.stats.houses++;

		const T = isHouse ? 0.22 : 0.3;
		const floorY = gY + 0.18;
		// storeys
		let floors = isHouse ? Math.max(1, b.floors || Math.round((y1 - gY) / 3)) : 1;
		const storeyH = 3.0;
		if (isHouse && floors === 2 && (y1 - floorY < 5.6 || b.d < 9.5)) floors = 1;
		const interiorTop = isHouse
			? (floors === 2 ? Math.min(floorY + 5.8, y1 - 0.12) : Math.min(floorY + 2.8, y1 - 0.12))
			: Math.min(y1 - 0.25, floorY + (b.kind === 'warehouse' || b.sub === 'fire' || b.sub === 'hangar' || b.sub === 'mechanic' || b.sub === 'cellblock' ? Math.min(y1 - floorY - 0.4, 9) : 4.2));
		const ceil1 = isHouse ? (floors === 2 ? floorY + 2.8 : interiorTop) : interiorTop;
		const clear1 = ceil1 - floorY;
		const doorH = hangar ? Math.min(8, clear1 - 0.4) : Math.min(isHouse ? 2.15 : (b.kind === 'warehouse' ? 4.2 : 2.6), clear1 - 0.15);
		const sides = sidesOf(b.w, b.d);
		const wallMat = st.mat;
		const outer = this.acc(wallMat, b.x, b.z);
		const plain = this.acc('plain', b.x, b.z);
		const det = this.acc('plain', b.x, b.z, true);
		const glassA = this.acc('glassPane', b.x, b.z);
		const inner = this.acc('plain', b.x, b.z);
		const floorAcc = this.acc('floor', b.x, b.z);

		// -------- openings -------------------------------------------------
		const doorOps: Opening[][] = [[], [], [], []];      // physics + visual holes
		const winOps: Opening[][] = [[], [], [], []];       // visual holes (enterable) / panels
		const doorsLocal: number[][] = [];                  // door centres for the room planner
		let frontDoorU = b.w / 2;
		const doorW = isHouse ? 1.05 : (hangar ? Math.min(26, b.w * 0.5) : (b.kind === 'warehouse' || b.sub === 'fire' || b.sub === 'mechanic' ? Math.min(5, b.w * 0.4) : Math.min(2.2, b.w * 0.3)));
		if (enter && doorH > 1.6)
		{
			frontDoorU = isHouse ? Math.max(T + 1.6, b.w * 0.3) : b.w / 2;
			if (isHouse && floors === 2) frontDoorU = Math.max(frontDoorU, T + 1.0 + 0.4 + doorW / 2 + 0.3);
			doorOps[0].push({ u0: frontDoorU - doorW / 2, u1: frontDoorU + doorW / 2, v0: floorY - y0 - 0.02, v1: floorY - y0 + doorH });
			doorsLocal.push([-b.w / 2 + frontDoorU, b.d / 2]);
			if (isHouse && b.d >= 8)
			{
				const bu = b.w * 0.35;
				doorOps[2].push({ u0: bu - 0.5, u1: bu + 0.5, v0: floorY - y0 - 0.02, v1: floorY - y0 + doorH });
				doorsLocal.push([b.w / 2 - bu, -b.d / 2]);
			}
		}

		// windows
		const winList: { side: number; u: number; v0: number; v1: number; w: number; floor: number }[] = [];
		if (isHouse && !small)
		{
			for (let fl = 0; fl < Math.max(1, floors); fl++)
			{
				const base = floorY + fl * storeyH;
				const wv0 = base + 0.9 - y0, wv1 = base + 2.15 - y0;
				if (base + 2.15 > y1 - 0.1) break;
				for (let si = 0; si < 4; si++)
				{
					const len = sides[si].len;
					const n = Math.max(1, Math.floor((len - 1.0) / 3.0));
					const step = len / n;
					for (let k = 0; k < n; k++)
					{
						const u = step * (k + 0.5);
						const ww = Math.min(1.3, step - 0.8);
						if (ww < 0.6) continue;
						let clash = false;
						for (let d = 0; d < doorOps[si].length; d++) if (fl === 0 && u + ww / 2 > doorOps[si][d].u0 - 0.35 && u - ww / 2 < doorOps[si][d].u1 + 0.35) clash = true;
						if (clash) continue;
						if (u - ww / 2 < T + 0.3 || u + ww / 2 > len - T - 0.3) continue;
						winList.push({ side: si, u: u, v0: wv0, v1: wv1, w: ww, floor: fl });
						if (enter && (fl === 0 || floors === 2)) winOps[si].push({ u0: u - ww / 2, u1: u + ww / 2, v0: wv0, v1: wv1 });
					}
				}
			}
		}
		// storefront glazing for enterable shops / civic / offices / towers
		let storefront = false;
		if (enter && !isHouse && b.kind !== 'warehouse' && b.kind !== 'barn' && b.style !== 'steel')
		{
			storefront = true;
			const sv0 = floorY - y0 + 0.45, sv1 = floorY - y0 + Math.min(clear1 - 0.5, 3.2);
			const du0 = frontDoorU - doorW / 2 - 0.35, du1 = frontDoorU + doorW / 2 + 0.35;
			if (du0 - 0.8 > 1.0) winOps[0].push({ u0: 0.8, u1: du0, v0: sv0, v1: sv1 });
			if (b.w - 0.8 - du1 > 1.0) winOps[0].push({ u0: du1, u1: b.w - 0.8, v0: sv0, v1: sv1 });
			// transom glass over the door
			if (doorOps[0].length && floorY - y0 + doorH + 0.25 < sv1) winOps[0].push({ u0: frontDoorU - doorW / 2, u1: frontDoorU + doorW / 2, v0: floorY - y0 + doorH + 0.12, v1: sv1 });
		}

		// -------- exterior walls --------------------------------------------
		for (let si = 0; si < 4; si++)
		{
			const s = sides[si];
			const holes = enter ? doorOps[si].concat(winOps[si]) : [];
			wallFaces({ acc: outer, f: f, s: s, inset: 0, facing: 1, u0: 0, u1: s.len, y0: y0, y1: y1, openings: holes, color: tint, st: st, vBase: y0 });
			if (enter)
			{
				for (let k = 0; k < holes.length; k++) jambs(plain, f, s, holes[k], y0, T, isHouse ? [0.93, 0.92, 0.88] : [0.55, 0.56, 0.58], false);
				wallPhysics(ctx, b, f, s, T, y0, y1, doorOps[si]);
			}
		}
		if (!enter && b.collide)
		{
			const extra = b.roof === 'gable' ? Math.min(b.w, b.d) * 0.35 : 0;
			ctx.bphys.box(b.x, b.baseY + (b.h + extra) / 2, b.z, b.w / 2, (b.h + extra) / 2, b.d / 2, b.rot);
		}

		// -------- interior shell ---------------------------------------------
		const wallCols = hood ? ctx.cfg.house.hoodWallColors : ctx.cfg.house.wallColors;
		const wallCol = isHouse || b.kind === 'apartment'
			? wallCols[Math.floor(rnd(1) * wallCols.length) % wallCols.length]
			: (b.kind === 'warehouse' || b.sub === 'mechanic' || b.sub === 'fire' ? [0.62, 0.62, 0.6] : [0.9, 0.89, 0.86]);
		const ix0 = -b.w / 2 + T, ix1 = b.w / 2 - T, iz0 = -b.d / 2 + T, iz1 = b.d / 2 - T;
		const rooms: Room[] = [];
		if (enter)
		{
			this.stats.enterable++;
			const floorTint = isHouse ? (rnd(2) < 0.5 ? [0.78, 0.6, 0.42] : [0.66, 0.5, 0.36]) : (b.kind === 'warehouse' || b.sub === 'mechanic' || b.sub === 'fire' ? [0.6, 0.6, 0.6] : [0.82, 0.8, 0.76]);
			const dirt = hood ? 0.75 + cond * 0.25 : 1;
			// floor
			flatRect(floorAcc, f, ix0, iz0, ix1, iz1, floorY, true, mul(floorTint, dirt), 0.25);
			ctx.bphys.box(b.x, (y0 + floorY) / 2, b.z, b.w / 2, Math.max(0.05, (floorY - y0) / 2), b.d / 2, b.rot);
			// inner faces of outer walls, per storey
			const storeys: number[][] = floors === 2 && isHouse ? [[floorY, floorY + 2.8], [floorY + 3.0, interiorTop]] : [[floorY, ceil1]];
			for (let si = 0; si < 4; si++)
			{
				const s = sides[si];
				for (let k = 0; k < storeys.length; k++)
				{
					const sy0 = storeys[k][0], sy1 = storeys[k][1];
					const holes = doorOps[si].concat(winOps[si]).map((o) => ({ u0: o.u0, u1: o.u1, v0: o.v0 - (sy0 - y0), v1: o.v1 - (sy0 - y0) }));
					wallFaces({ acc: inner, f: f, s: s, inset: T, facing: -1, u0: T, u1: s.len - T, y0: sy0, y1: sy1, openings: holes, color: mul(wallCol, dirt) });
					// baseboard
					if (isHouse) wallFaces({ acc: det, f: f, s: s, inset: T - 0.015, facing: -1, u0: T, u1: s.len - T, y0: sy0, y1: sy0 + 0.1, openings: holes, color: [0.95, 0.95, 0.93] });
				}
				// slab edge between storeys
				if (storeys.length === 2) wallFaces({ acc: inner, f: f, s: s, inset: T, facing: -1, u0: T, u1: s.len - T, y0: floorY + 2.8, y1: floorY + 3.0, openings: [], color: [0.85, 0.85, 0.83] });
			}
			// ceilings
			flatRect(inner, f, ix0, iz0, ix1, iz1, ceil1, false, [0.93, 0.93, 0.91]);
			if (storeys.length === 1)
			{
				// solid from the ceiling up to the roof
				if (y1 - ceil1 > 0.05) ctx.bphys.box(b.x, (ceil1 + y1) / 2, b.z, b.w / 2, (y1 - ceil1) / 2, b.d / 2, b.rot);
			}
			else
			{
				flatRect(inner, f, ix0, iz0, ix1, iz1, interiorTop, false, [0.93, 0.93, 0.91]);
				if (y1 - interiorTop > 0.05) ctx.bphys.box(b.x, (interiorTop + y1) / 2, b.z, b.w / 2, (y1 - interiorTop) / 2, b.d / 2, b.rot);
			}
			if (b.roof === 'gable')
			{
				const extra = Math.min(b.w, b.d) * 0.35;
				ctx.bphys.box(b.x, y1 + extra / 2, b.z, b.w / 2 * 0.8, extra / 2, b.d / 2 * 0.8, b.rot);
			}
			// rooms
			if (isHouse) this.houseRooms(b, f, rooms, floors, floorY, ceil1, interiorTop, T, frontDoorU, doorW, inner, floorAcc, wallCol, floorTint, dirt, doorsLocal);
			else this.cityRooms(b, f, rooms, floorY, ceil1, T, frontDoorU, inner, wallCol, doorsLocal);
			// windows into rooms (for furniture placement)
			const winLocal: number[][] = [];
			for (let k = 0; k < winList.length; k++)
			{
				const wl = winList[k];
				const p = sp(sides[wl.side], wl.u, T);
				winLocal.push([p[0], p[1], floorY + wl.floor * storeyH]);
			}
			for (let r = 0; r < rooms.length; r++)
			{
				rooms[r].windows = winLocal.filter((w) => Math.abs(w[2] - rooms[r].y) < 0.5).map((w) => [w[0], w[1]]);
				// ceiling light
				const cx = (rooms[r].x0 + rooms[r].x1) / 2, cz = (rooms[r].z0 + rooms[r].z1) / 2;
				const wp = f.p(cx, rooms[r].y + rooms[r].h - 0.25, cz);
				if (!closed) ctx.lightSpots.push({ x: wp[0], y: wp[1], z: wp[2], color: hood ? 0xffd9a0 : 0xfff0d8, range: Math.max(6, Math.max(rooms[r].x1 - rooms[r].x0, rooms[r].z1 - rooms[r].z0) * 1.1), night: false });
			}
			this.plans.push({ b: b, f: f, rooms: rooms, hood: hood, seed: seed });
			// real, openable doors in every doorway of the outer walls
			this.outerDoors(b, f, index, rnd, hood, closed, isHouse, T, floorY, doorH, doorW, frontDoorU, doorOps);
		}
		else if (isHouse && !small)
		{
			// sealed interior: give the hollow look something to see through dark windows
		}

		// -------- windows (3D) ----------------------------------------------
		for (let k = 0; k < winList.length; k++)
		{
			const wl = winList[k];
			const s = sides[wl.side];
			const boarded = b.boarded || closed || (hood && rnd(10 + k) < 0.18 * (1 - cond) * 3);
			const broken = hood && !boarded && rnd(40 + k) < 0.25 * (1 - cond) * 2;
			const see = enter && (wl.floor === 0 || floors === 2);
			this.window(f, s, wl.u, y0 + wl.v0, y0 + wl.v1, wl.w, see, boarded, broken, hood, T, det, glassA, plain);
			this.stats.windows++;
		}

		// -------- doors / storefront -----------------------------------------
		if (isHouse && !small) this.houseExterior(b, f, rnd, hood, cond, gY, floorY, y1, enter, frontDoorU, doorW, doorH, det, plain, floors);
		else if (!small) this.cityExterior(b, f, rnd, hood, cond, gY, floorY, y1, enter, storefront, frontDoorU, doorW, doorH, det, glassA, winOps[0]);
		if (closed && !small) this.closedUp(b, f, rnd, isHouse, enter, storefront, floorY, doorH, doorW, frontDoorU, doorOps, winOps[0], T);
		if (enter && !isHouse && storefront)
		{
			for (let k = 0; k < winOps[0].length; k++)
			{
				const o = winOps[0][k];
				const s = sides[0];
				const a = sp(s, o.u0, T * 0.5), bb = sp(s, o.u1, T * 0.5);
				const ya = y0 + o.v0, yb = y0 + o.v1;
				glassA.face([f.p(a[0], ya, a[1]), f.p(bb[0], ya, bb[1]), f.p(bb[0], yb, bb[1]), f.p(a[0], yb, a[1])], f.n(0, 0, 1), [[0, 0], [0, 0], [0, 0], [0, 0]], [0.55, 0.68, 0.75]);
				glassA.face([f.p(bb[0], ya, bb[1]), f.p(a[0], ya, a[1]), f.p(a[0], yb, a[1]), f.p(bb[0], yb, bb[1])], f.n(0, 0, -1), [[0, 0], [0, 0], [0, 0], [0, 0]], [0.55, 0.68, 0.75]);
				// mullions
				const nm = Math.max(1, Math.round((o.u1 - o.u0) / 2.2));
				for (let m = 0; m <= nm; m++)
				{
					const u = o.u0 + (o.u1 - o.u0) * m / nm;
					const p = sp(s, u, 0);
					box(det, f, p[0] - 0.05, ya, p[1] - T * 0.6, p[0] + 0.05, yb, p[1] + 0.03, [0.18, 0.18, 0.2]);
				}
				const pa = sp(s, o.u0, 0), pb = sp(s, o.u1, 0);
				box(det, f, pa[0], ya - 0.08, pa[1] - T * 0.6, pb[0], ya, pb[1] + 0.05, [0.18, 0.18, 0.2]);
				box(det, f, pa[0], yb, pa[1] - T * 0.6, pb[0], yb + 0.08, pb[1] + 0.03, [0.18, 0.18, 0.2]);
			}
		}

		// -------- roof ----------------------------------------------------------
		this.roof(b, f, tint, rnd, hood, cond, y1, isHouse, small);

		// -------- signs ----------------------------------------------------------
		if (b.label) this.labelSign(b, f, y0, y1, floorY);
		else if (enter && (b.kind === 'shop') && SHOP_SIGNS[b.sub || ''])
		{
			const opts = SHOP_SIGNS[b.sub];
			const pick = opts[Math.floor(rnd(5) * opts.length) % opts.length];
			const width = Math.min(b.w * 0.7, 1.5 + pick[0].length * 0.55);
			const sy = Math.min(floorY + clear1 + 0.55, y1 - 0.4);
			box(det, f, -width / 2 - 0.15, sy - width * 0.08 - 0.12, b.d / 2, width / 2 + 0.15, sy + width * 0.08 + 0.12, b.d / 2 + 0.1, [0.12, 0.12, 0.13]);
			this.sign(f, pick[0], pick[1], pick[2], 0, sy, b.d / 2 + 0.115, width, 1);
		}

		// -------- run-down extras -------------------------------------------------
		if (hood && !small)
		{
			// nothing may be drawn over a doorway, a door, a window or a shop window
			const keep: Opening[][] = [[], [], [], []];
			for (let si = 0; si < 4; si++)
			{
				if (enter) for (let k = 0; k < doorOps[si].length; k++)
				{
					const o = doorOps[si][k];
					keep[si].push({ u0: o.u0 - 0.15, u1: o.u1 + 0.15, v0: gY - 2, v1: y0 + o.v1 + 0.2 });
				}
				if (enter) for (let k = 0; k < winOps[si].length; k++)
				{
					const o = winOps[si][k];
					keep[si].push({ u0: o.u0 - 0.15, u1: o.u1 + 0.15, v0: y0 + o.v0 - 0.15, v1: y0 + o.v1 + 0.15 });
				}
			}
			for (let k = 0; k < winList.length; k++)
			{
				const wl = winList[k];
				keep[wl.side].push({ u0: wl.u - wl.w / 2 - 0.22, u1: wl.u + wl.w / 2 + 0.22, v0: y0 + wl.v0 - 0.2, v1: y0 + wl.v1 + 0.15 });
			}
			// painted / sealed doors of buildings you can't enter
			if (!enter)
			{
				if (isHouse) keep[0].push({ u0: frontDoorU - doorW / 2 - 0.15, u1: frontDoorU + doorW / 2 + 0.15, v0: gY - 2, v1: floorY + 2.3 });
				else keep[0].push({ u0: b.w / 2 - 1.0, u1: b.w / 2 + 1.0, v0: gY - 2, v1: floorY + 2.6 });
			}
			this.decay(b, f, rnd, cond, y0, gY, y1, sides, keep);
		}
	}

	// -----------------------------------------------------------------------

	private window(f: Frame, s: Side, u: number, ya: number, yb: number, w: number, see: boolean, boarded: boolean, broken: boolean, hood: boolean, T: number, det: GeoAccum, glassA: GeoAccum, plain: GeoAccum): void
	{
		const frameC = hood ? [0.7, 0.68, 0.62] : [0.96, 0.96, 0.94];
		const p0 = sp(s, u - w / 2, 0), p1 = sp(s, u + w / 2, 0);
		const nx = s.nx, nz = s.nz;
		const out = 0.05;
		// frame: four bars standing proud of the wall
		const bar = (ua: number, ub: number, y0: number, y1: number) =>
		{
			const a = sp(s, ua, -out), b2 = sp(s, ub, 0.02);
			const xs = [a[0], b2[0]].sort((m, n) => m - n), zs = [a[1], b2[1]].sort((m, n) => m - n);
			box(det, f, xs[0], y0, zs[0], xs[1], y1, zs[1], frameC);
		};
		const fw = 0.08;
		bar(u - w / 2 - fw, u - w / 2, ya - fw, yb + fw);
		bar(u + w / 2, u + w / 2 + fw, ya - fw, yb + fw);
		bar(u - w / 2, u + w / 2, yb, yb + fw);
		// sill
		{
			const a = sp(s, u - w / 2 - 0.12, -0.12), b2 = sp(s, u + w / 2 + 0.12, 0.02);
			const xs = [a[0], b2[0]].sort((m, n) => m - n), zs = [a[1], b2[1]].sort((m, n) => m - n);
			box(det, f, xs[0], ya - fw - 0.05, zs[0], xs[1], ya - fw + 0.02, zs[1], frameC);
		}
		const Z = [[0, 0], [0, 0], [0, 0], [0, 0]];
		const n = f.n(nx, 0, nz), nn = f.n(-nx, 0, -nz);
		if (boarded)
		{
			// plywood sheets nailed over the opening
			const a = sp(s, u - w / 2 - 0.05, -0.07), b2 = sp(s, u + w / 2 + 0.05, -0.03);
			const xs = [a[0], b2[0]].sort((m, q) => m - q), zs = [a[1], b2[1]].sort((m, q) => m - q);
			box(plain, f, xs[0], ya - 0.05, zs[0], xs[1], yb + 0.05, zs[1], [0.62, 0.5, 0.33]);
			const c = sp(s, u, -0.09);
			const xs2 = [c[0] - 0.02 - Math.abs(nz) * w * 0.55, c[0] + 0.02 + Math.abs(nz) * w * 0.55].sort((m, q) => m - q);
			const zs2 = [c[1] - 0.02 - Math.abs(nx) * w * 0.55, c[1] + 0.02 + Math.abs(nx) * w * 0.55].sort((m, q) => m - q);
			box(plain, f, xs2[0], (ya + yb) / 2 - 0.08, zs2[0], xs2[1], (ya + yb) / 2 + 0.08, zs2[1], [0.5, 0.4, 0.26]);
			return;
		}
		if (see)
		{
			if (broken) return;   // empty frame, glass long gone
			const g0 = sp(s, u - w / 2, T * 0.35), g1 = sp(s, u + w / 2, T * 0.35);
			const gc = [0.62, 0.74, 0.8];
			glassA.face([f.p(g0[0], ya, g0[1]), f.p(g1[0], ya, g1[1]), f.p(g1[0], yb, g1[1]), f.p(g0[0], yb, g0[1])], n, Z, gc);
			glassA.face([f.p(g1[0], ya, g1[1]), f.p(g0[0], ya, g0[1]), f.p(g0[0], yb, g0[1]), f.p(g1[0], yb, g1[1])], nn, Z, gc);
			// muntin cross
			const m0 = sp(s, u - 0.025, T * 0.3), m1 = sp(s, u + 0.025, T * 0.4);
			box(det, f, Math.min(m0[0], m1[0]), ya, Math.min(m0[1], m1[1]), Math.max(m0[0], m1[0]), yb, Math.max(m0[1], m1[1]), frameC);
			const ym = (ya + yb) / 2;
			const h0 = sp(s, u - w / 2, T * 0.3), h1 = sp(s, u + w / 2, T * 0.4);
			box(det, f, Math.min(h0[0], h1[0]), ym - 0.025, Math.min(h0[1], h1[1]), Math.max(h0[0], h1[0]), ym + 0.025, Math.max(h0[1], h1[1]), frameC);
			return;
		}
		// closed house: dark glass with curtains behind
		const g0 = sp(s, u - w / 2, -0.01), g1 = sp(s, u + w / 2, -0.01);
		const gc = broken ? [0.08, 0.08, 0.09] : [0.2, 0.27, 0.33];
		glassA.face([f.p(g0[0], ya, g0[1]), f.p(g1[0], ya, g1[1]), f.p(g1[0], yb, g1[1]), f.p(g0[0], yb, g0[1])], n, Z, gc);
		const c0 = sp(s, u - w / 2, -0.008), c1 = sp(s, u - w / 2 + w * 0.22, -0.008);
		det.face([f.p(c0[0], ya, c0[1]), f.p(c1[0], ya, c1[1]), f.p(c1[0], yb, c1[1]), f.p(c0[0], yb, c0[1])], n, Z, hood ? [0.5, 0.45, 0.35] : [0.85, 0.82, 0.72]);
		const c2 = sp(s, u + w / 2 - w * 0.22, -0.008), c3 = sp(s, u + w / 2, -0.008);
		det.face([f.p(c2[0], ya, c2[1]), f.p(c3[0], ya, c3[1]), f.p(c3[0], yb, c3[1]), f.p(c2[0], yb, c2[1])], n, Z, hood ? [0.5, 0.45, 0.35] : [0.85, 0.82, 0.72]);
		void p0; void p1;
	}

	// -----------------------------------------------------------------------

	private houseRooms(b: Building, f: Frame, rooms: Room[], floors: number, floorY: number, ceil1: number, top: number, T: number, frontDoorU: number, doorW: number, inner: GeoAccum, floorAcc: GeoAccum, wallCol: number[], floorTint: number[], dirt: number, doorsLocal: number[][]): void
	{
		const ctx = this.ctx;
		const ix0 = -b.w / 2 + T, ix1 = b.w / 2 - T, iz0 = -b.d / 2 + T, iz1 = b.d / 2 - T;
		const zSplit = iz1 - Math.max(3.6, (iz1 - iz0) * 0.55);
		const col = mul(wallCol, dirt);
		const h1 = ceil1 - floorY;
		const backDoorX = doorsLocal.length > 1 ? doorsLocal[1][0] : 99;
		if (floors === 1)
		{
			const wide = ix1 - ix0 >= 10.5;
			const xa = ix0 + (ix1 - ix0) * (wide ? 0.42 : 0.5);
			const xb = wide ? xa + 2.4 : xa;
			const dK = (ix0 + xa) / 2, dB = wide ? (xa + xb) / 2 : -99, dR = (xb + ix1) / 2;
			const doorsZ = wide ? [dK, dB, dR] : [dK, dR];
			partition(ctx, inner, b, f, true, zSplit, ix0, ix1, floorY, ceil1, doorsZ, col, 0.95);
			partition(ctx, inner, b, f, false, xa, iz0, zSplit, floorY, ceil1, [], col, 0.95);
			if (wide) partition(ctx, inner, b, f, false, xb, iz0, zSplit, floorY, ceil1, [], col, 0.95);
			rooms.push({ type: 'living', x0: ix0, x1: ix1, z0: zSplit + 0.06, z1: iz1, y: floorY, h: h1, doors: [[-b.w / 2 + frontDoorU, iz1]].concat(doorsZ.map((x) => [x, zSplit])) });
			rooms.push({ type: 'kitchen', x0: ix0, x1: xa - 0.06, z0: iz0, z1: zSplit - 0.06, y: floorY, h: h1, doors: [[dK, zSplit], [backDoorX, iz0]] });
			if (wide) rooms.push({ type: 'bath', x0: xa + 0.06, x1: xb - 0.06, z0: iz0, z1: zSplit - 0.06, y: floorY, h: h1, doors: [[dB, zSplit], [backDoorX, iz0]] });
			rooms.push({ type: wide ? 'bedroom' : 'bedroom_bath', x0: xb + 0.06, x1: ix1, z0: iz0, z1: zSplit - 0.06, y: floorY, h: h1, doors: [[dR, zSplit], [backDoorX, iz0]] });
			return;
		}
		// ----- two storeys -----
		const stairW = 1.0, run = 4.3, rise = 3.0;
		const sx0 = ix0, sx1 = ix0 + stairW;
		const zBottom = iz1 - 0.5, zTop = zBottom - run;
		const y2 = floorY + 3.0;
		// ground floor: living (front, with the stair) + kitchen/dining (back)
		const dK = (ix0 + ix1) / 2 + 0.5;
		partition(ctx, inner, b, f, true, zSplit, ix0, ix1, floorY, ceil1, [dK], col, 1.2);
		rooms.push({ type: 'living', x0: sx1 + 0.3, x1: ix1, z0: zSplit + 0.06, z1: iz1, y: floorY, h: h1, doors: [[-b.w / 2 + frontDoorU, iz1], [dK, zSplit]] });
		rooms.push({ type: 'kitchen_dining', x0: ix0, x1: ix1, z0: iz0, z1: zSplit - 0.06, y: floorY, h: h1, doors: [[dK, zSplit], [backDoorX, iz0]] });
		// stairs: steps (visual) + ramp (physics)
		const steps = 15;
		const plainS = this.acc('plain', b.x, b.z);
		for (let k = 0; k < steps; k++)
		{
			const za = zBottom - (k + 1) * run / steps, zb = zBottom - k * run / steps;
			box(plainS, f, sx0, floorY, za, sx1, floorY + (k + 1) * rise / steps, zb, k % 2 ? [0.55, 0.4, 0.28] : [0.58, 0.43, 0.3], 'b');
		}
		// railing
		box(this.acc('plain', b.x, b.z, true), f, sx1, floorY + 0.9, zTop, sx1 + 0.05, floorY + 0.95 + rise, zBottom, [0.35, 0.25, 0.18]);
		const ang = Math.atan2(rise, run);
		const mid = f.p((sx0 + sx1) / 2, floorY + rise / 2 - 0.1, (zBottom + zTop) / 2);
		ctx.bphys.box(mid[0], mid[1], mid[2], stairW / 2, 0.1, Math.sqrt(run * run + rise * rise) / 2, b.rot, ang);
		// upper slab with a stairwell
		const slab = (x0: number, z0: number, x1: number, z1: number) =>
		{
			if (x1 - x0 < 0.05 || z1 - z0 < 0.05) return;
			flatRect(floorAcc, f, x0, z0, x1, z1, y2, true, mul(floorTint, dirt), 0.25);
			flatRect(inner, f, x0, z0, x1, z1, ceil1, false, [0.93, 0.93, 0.91]);
			const c = f.p((x0 + x1) / 2, (ceil1 + y2) / 2, (z0 + z1) / 2);
			ctx.bphys.box(c[0], c[1], c[2], (x1 - x0) / 2, (y2 - ceil1) / 2, (z1 - z0) / 2, b.rot);
		};
		slab(sx1, iz0, ix1, iz1);
		slab(sx0, iz0, sx1, zTop - 0.1);
		slab(sx0, zBottom + 0.02, sx1, iz1);
		// stairwell guard rail upstairs
		box(this.acc('plain', b.x, b.z, true), f, sx1, y2, zTop, sx1 + 0.05, y2 + 0.95, zBottom, [0.35, 0.25, 0.18]);
		// upstairs layout
		const h2 = top - y2;
		const hallX = sx1 + 1.1;
		const xb = Math.min(ix0 + 2.6, ix1 - 3);
		partition(ctx, inner, b, f, false, hallX, zSplit, iz1, y2, top, [(zSplit + iz1) / 2], col, 0.95);
		const dBath = (ix0 + xb) / 2, dBed2 = (Math.max(xb, hallX) + ix1) / 2;
		partition(ctx, inner, b, f, true, zSplit, ix0, ix1, y2, top, [Math.min(dBath, hallX - 0.6), dBed2], col, 0.95);
		partition(ctx, inner, b, f, false, xb, iz0, zSplit, y2, top, [], col, 0.95);
		rooms.push({ type: 'hall', x0: ix0, x1: hallX - 0.06, z0: zSplit + 0.06, z1: iz1, y: y2, h: h2, doors: [[sx0, zTop], [hallX, (zSplit + iz1) / 2]] });
		rooms.push({ type: 'bedroom', x0: hallX + 0.06, x1: ix1, z0: zSplit + 0.06, z1: iz1, y: y2, h: h2, doors: [[hallX, (zSplit + iz1) / 2], [dBed2, zSplit]] });
		rooms.push({ type: 'bath', x0: ix0, x1: xb - 0.06, z0: iz0, z1: zSplit - 0.06, y: y2, h: h2, doors: [[Math.min(dBath, hallX - 0.6), zSplit]] });
		rooms.push({ type: 'bedroom', x0: xb + 0.06, x1: ix1, z0: iz0, z1: zSplit - 0.06, y: y2, h: h2, doors: [[dBed2, zSplit]] });
	}

	private cityRooms(b: Building, f: Frame, rooms: Room[], floorY: number, ceil1: number, T: number, frontDoorU: number, inner: GeoAccum, wallCol: number[], doorsLocal: number[][]): void
	{
		const ix0 = -b.w / 2 + T, ix1 = b.w / 2 - T, iz0 = -b.d / 2 + T, iz1 = b.d / 2 - T;
		const h = ceil1 - floorY;
		const open = b.kind === 'warehouse' || b.sub === 'fire' || b.sub === 'hangar' || b.sub === 'mechanic' || b.sub === 'terminal' || b.sub === 'cellblock';
		const dx = -b.w / 2 + frontDoorU;
		if (!open && iz1 - iz0 > 9)
		{
			const zb = iz0 + Math.min(4, (iz1 - iz0) * 0.3);
			const door = ix0 + 1.2;
			partition(this.ctx, inner, b, f, true, zb, ix0, ix1, floorY, ceil1, [door], wallCol, 1.0);
			rooms.push({ type: 'main', x0: ix0, x1: ix1, z0: zb + 0.06, z1: iz1, y: floorY, h: h, doors: [[dx, iz1], [door, zb]] });
			rooms.push({ type: 'back', x0: ix0, x1: ix1, z0: iz0, z1: zb - 0.06, y: floorY, h: h, doors: [[door, zb]] });
		}
		else rooms.push({ type: 'main', x0: ix0, x1: ix1, z0: iz0, z1: iz1, y: floorY, h: h, doors: [[dx, iz1]] });
		void doorsLocal;
	}

	// -----------------------------------------------------------------------

	private houseExterior(b: Building, f: Frame, rnd: (k: number) => number, hood: boolean, cond: number, gY: number, floorY: number, y1: number, enter: boolean, doorU: number, doorW: number, doorH: number, det: GeoAccum, plain: GeoAccum, floors: number): void
	{
		const ctx = this.ctx;
		const trim = hood ? [0.72, 0.7, 0.64] : [0.97, 0.97, 0.95];
		const y0 = b.baseY;
		// corner boards
		const hw = b.w / 2, hd = b.d / 2;
		const cb = 0.12;
		box(det, f, -hw - 0.03, y0, hd - cb, -hw + cb, y1, hd + 0.03, trim, 'bt');
		box(det, f, hw - cb, y0, hd - cb, hw + 0.03, y1, hd + 0.03, trim, 'bt');
		box(det, f, -hw - 0.03, y0, -hd - 0.03, -hw + cb, y1, -hd + cb, trim, 'bt');
		box(det, f, hw - cb, y0, -hd - 0.03, hw + 0.03, y1, -hd + cb, trim, 'bt');
		// foundation band
		const fc = hood ? [0.42, 0.4, 0.37] : [0.58, 0.57, 0.55];
		box(det, f, -hw - 0.04, y0, -hd - 0.04, hw + 0.04, floorY - 0.02, hd + 0.04, fc, 'tb');
		// fascia / gutter
		box(det, f, -hw - 0.5, y1 - 0.18, hd + 0.3, hw + 0.5, y1 - 0.02, hd + 0.45, hood ? [0.45, 0.43, 0.4] : [0.9, 0.9, 0.9]);
		box(det, f, -hw - 0.5, y1 - 0.18, -hd - 0.45, hw + 0.5, y1 - 0.02, -hd - 0.3, hood ? [0.45, 0.43, 0.4] : [0.9, 0.9, 0.9]);
		// downspout
		box(det, f, hw + 0.05, y0, hd + 0.05, hw + 0.15, y1 - 0.1, hd + 0.15, [0.85, 0.85, 0.85]);

		const dx = -hw + doorU;
		const dc = DOOR_COLORS[Math.floor(rnd(3) * DOOR_COLORS.length) % DOOR_COLORS.length];
		if (!enter)
		{
			// closed door panel + frame
			box(plain, f, dx - doorW / 2, floorY, hd, dx + doorW / 2, floorY + 2.1, hd + 0.04, hood ? mul(dc, 0.7) : dc);
			box(det, f, dx - doorW / 2 - 0.1, floorY, hd, dx - doorW / 2, floorY + 2.2, hd + 0.08, trim);
			box(det, f, dx + doorW / 2, floorY, hd, dx + doorW / 2 + 0.1, floorY + 2.2, hd + 0.08, trim);
			box(det, f, dx - doorW / 2 - 0.1, floorY + 2.1, hd, dx + doorW / 2 + 0.1, floorY + 2.2, hd + 0.08, trim);
			box(det, f, dx + doorW / 2 - 0.2, floorY + 1.0, hd + 0.04, dx + doorW / 2 - 0.12, floorY + 1.06, hd + 0.08, [0.8, 0.7, 0.3]);
		}
		else
		{
			// door casing outside
			box(det, f, dx - doorW / 2 - 0.1, floorY, hd, dx - doorW / 2, floorY + doorH + 0.1, hd + 0.06, trim);
			box(det, f, dx + doorW / 2, floorY, hd, dx + doorW / 2 + 0.1, floorY + doorH + 0.1, hd + 0.06, trim);
			box(det, f, dx - doorW / 2 - 0.1, floorY + doorH, hd, dx + doorW / 2 + 0.1, floorY + doorH + 0.12, hd + 0.06, trim);
		}
		// porch: slab + steps + roof + posts + light
		const pw = Math.min(b.w * 0.45, 4.2), pd = 1.8;
		const px0 = Math.max(-hw + 0.2, dx - pw / 2), px1 = Math.min(hw - 0.2, px0 + pw);
		const porchC = hood ? [0.5, 0.48, 0.45] : [0.7, 0.69, 0.66];
		const gFront = ctx.data.heightAt.apply(null, f.p(dx, 0, hd + pd + 0.8).filter((v: number, i: number) => i !== 1));
		const porchTop = floorY - 0.02;
		box(plain, f, px0, Math.min(gFront, porchTop) - 0.4, hd, px1, porchTop, hd + pd, porchC);
		const pc = f.p((px0 + px1) / 2, (porchTop + Math.min(gFront, porchTop) - 0.4) / 2, hd + pd / 2);
		ctx.bphys.box(pc[0], pc[1], pc[2], (px1 - px0) / 2, (porchTop - Math.min(gFront, porchTop) + 0.4) / 2, pd / 2, b.rot);
		const drop = porchTop - gFront;
		if (drop > 0.12)
		{
			const n = Math.min(8, Math.max(1, Math.round(drop / 0.18)));
			const tread = 0.3;
			for (let k = 0; k < n; k++)
			{
				const yt = porchTop - (k + 1) * drop / (n + 0) + drop / n;
				box(plain, f, dx - 0.7, gFront - 0.3, hd + pd + k * tread, dx + 0.7, Math.max(gFront, yt - drop / n), hd + pd + (k + 1) * tread, porchC);
			}
			const runL = n * tread;
			const ang = Math.atan2(drop, runL);
			const rc = f.p(dx, gFront + drop / 2 - 0.12, hd + pd + runL / 2);
			ctx.bphys.box(rc[0], rc[1], rc[2], 0.7, 0.1, Math.sqrt(runL * runL + drop * drop) / 2, b.rot, ang);   // +ang: low end faces the street
		}
		// porch roof (shed) and posts
		const pr = Math.min(floorY + 2.75, y1 - 0.05);
		box(det, f, px0 - 0.1, pr, hd, px1 + 0.1, pr + 0.12, hd + pd + 0.15, hood ? [0.3, 0.28, 0.26] : mul(b.roofTint, 1.1));
		box(det, f, px0, floorY, hd + pd - 0.15, px0 + 0.12, pr, hd + pd - 0.03, trim);
		box(det, f, px1 - 0.12, floorY, hd + pd - 0.15, px1, pr, hd + pd - 0.03, trim);
		// porch light
		box(det, f, dx + doorW / 2 + 0.25, floorY + 1.9, hd, dx + doorW / 2 + 0.4, floorY + 2.15, hd + 0.15, [0.15, 0.15, 0.15]);
		const lampOn = !(hood && rnd(20) < 0.5) && !b.closed;
		if (lampOn)
		{
			box(this.acc('lampGlow', b.x, b.z, true), f, dx + doorW / 2 + 0.27, floorY + 1.93, hd + 0.15, dx + doorW / 2 + 0.38, floorY + 2.1, hd + 0.17, [1, 1, 1]);
			const lp = f.p(dx + doorW / 2 + 0.33, floorY + 2.0, hd + 0.6);
			ctx.lightSpots.push({ x: lp[0], y: lp[1], z: lp[2], color: 0xffd08a, range: 7, night: true });
		}
		// garage door on wide houses
		if (b.w >= 12.5 && floors === 1 && !hood)
		{
			const gx0 = hw - 3.4, gx1 = hw - 0.5;
			if (gx0 > dx + doorW / 2 + 0.6)
			{
				box(det, f, gx0, floorY - 0.15, hd, gx1, floorY + 2.25, hd + 0.05, [0.92, 0.92, 0.9]);
				for (let k = 1; k < 4; k++) box(det, f, gx0, floorY - 0.15 + k * 0.6, hd + 0.05, gx1, floorY - 0.13 + k * 0.6, hd + 0.07, [0.75, 0.75, 0.73]);
			}
		}
		// chimney
		if (rnd(6) < 0.55 && b.roof === 'gable')
		{
			const cx = hw * 0.55 * (rnd(7) < 0.5 ? -1 : 1);
			const rh = Math.min(b.w, b.d) * 0.35;
			box(plain, f, cx - 0.45, y1 - 0.5, -0.4, cx + 0.45, y1 + rh + 0.9, 0.4, hood ? [0.4, 0.28, 0.24] : [0.55, 0.32, 0.26]);
			box(plain, f, cx - 0.52, y1 + rh + 0.9, -0.47, cx + 0.52, y1 + rh + 1.02, 0.47, [0.35, 0.35, 0.35]);
		}
		// AC unit + bins on the side
		if (!hood || rnd(8) < 0.5)
		{
			box(det, f, hw + 0.15, gY, -0.5, hw + 0.9, gY + 0.8, 0.4, [0.78, 0.78, 0.76]);
			box(det, f, hw + 0.92, gY + 0.1, -0.4, hw + 0.93, gY + 0.7, 0.3, [0.2, 0.2, 0.2]);
		}
		// window boxes / shutters on nicer houses
		if (!hood && rnd(9) < 0.4)
		{
			// a simple hedge strip along the front
			const hc = [0.22, 0.4, 0.18];
			box(det, f, -hw + 0.2, gY - 0.2, hd + 0.25, px0 - 0.3, gY + 0.6, hd + 0.85, hc);
			if (hw - 0.2 > px1 + 0.3) box(det, f, px1 + 0.3, gY - 0.2, hd + 0.25, hw - 0.2, gY + 0.6, hd + 0.85, hc);
		}
	}

	private cityExterior(b: Building, f: Frame, rnd: (k: number) => number, hood: boolean, cond: number, gY: number, floorY: number, y1: number, enter: boolean, storefront: boolean, doorU: number, doorW: number, doorH: number, det: GeoAccum, glassA: GeoAccum, glazing: Opening[]): void
	{
		const ctx = this.ctx;
		const hw = b.w / 2, hd = b.d / 2, y0 = b.baseY;
		const dx = -hw + doorU;
		const stone = hood ? [0.38, 0.37, 0.35] : [0.55, 0.54, 0.52];
		const floor1Top = floorY + 4.2;
		// base plinth
		if (b.style !== 'steel' && b.style !== 'wood') box(det, f, -hw - 0.06, y0, -hd - 0.06, hw + 0.06, floorY + 0.1, hd + 0.06, stone, 'tb');
		// ledge bands on masonry buildings
		if ((b.style === 'brick' || b.style === 'concrete' || b.style === 'office') && b.h > 7)
		{
			const fh = b.style === 'concrete' ? 4 : 3.5;
			const step = b.h > 40 ? fh * 3 : (b.h > 18 ? fh * 2 : fh);
			let n = 0;
			for (let y = gY + Math.max(4.2, fh); y < y1 - 1.5 && n < 8; y += step, n++)
				box(det, f, -hw - 0.12, y - 0.12, -hd - 0.12, hw + 0.12, y + 0.05, hd + 0.12, mul(b.tint, 0.82), '');
		}
		// cornice
		if (b.style !== 'steel' && b.style !== 'wood' && b.style !== 'warehouse' && b.roof !== 'gable')
			box(det, f, -hw - 0.3, y1 - 0.45, -hd - 0.3, hw + 0.3, y1 - 0.1, hd + 0.3, b.style === 'glass' ? [0.7, 0.72, 0.75] : mul(b.tint, 0.75));
		// fire escape on brick walk-ups
		if (b.style === 'brick' && b.h > 9 && b.h < 32 && b.w > 8)
		{
			const fc = [0.12, 0.12, 0.13];
			const fx = b.d > 10 ? 0 : 0;
			for (let y = floorY + 3.5; y < y1 - 2; y += 3.5)
			{
				box(det, f, hw, y, fx - 1.8, hw + 1.2, y + 0.06, fx + 1.8, fc);
				box(det, f, hw + 1.15, y, fx - 1.8, hw + 1.2, y + 0.95, fx + 1.8, fc, 'b');
				box(det, f, hw + 0.1, y - 3.5 + 0.06, fx - 1.4, hw + 1.1, y, fx - 1.35, fc);
			}
		}
		if (!enter)
		{
			// solid door panel so the building reads as a building
			if (b.h >= 3 && b.w >= 4)
			{
				box(det, f, -0.8, floorY, hd, 0.8, floorY + 2.4, hd + 0.06, [0.25, 0.27, 0.3]);
				box(det, f, -0.95, floorY + 2.4, hd, 0.95, floorY + 2.55, hd + 0.1, stone);
			}
			return;
		}
		if (b.kind === 'warehouse' || b.sub === 'fire' || b.sub === 'mechanic' || b.sub === 'hangar')
		{
			// the roll-up / sliding hangar door itself is a real door (RealismDoors, see outerDoors)
			const yTop = floorY + doorH;
			box(det, f, dx - doorW / 2 - 0.2, floorY, hd, dx - doorW / 2, yTop + 0.3, hd + 0.1, [0.85, 0.7, 0.1]);
			box(det, f, dx + doorW / 2, floorY, hd, dx + doorW / 2 + 0.2, yTop + 0.3, hd + 0.1, [0.85, 0.7, 0.1]);
			if (b.sub === 'hangar')
			{
				// top track the two leaves hang from, running the whole width they slide along
				box(det, f, Math.max(-hw, dx - doorW), yTop + 0.02, hd, Math.min(hw, dx + doorW), yTop + 0.3, hd + 0.45, [0.3, 0.31, 0.33]);
			}
			// apron ramp up to the floor
			const gF = ctx.data.heightAt.apply(null, f.p(dx, 0, hd + 3).filter((v: number, i: number) => i !== 1));
			const drop = floorY - gF;
			if (drop > 0.05)
			{
				box(this.acc('plain', b.x, b.z), f, dx - doorW / 2, gF - 0.3, hd, dx + doorW / 2, floorY, hd + 0.05, stone);
				const L = Math.max(2, drop * 4);
				const rc = f.p(dx, gF + drop / 2 - 0.1, hd + L / 2);
				ctx.bphys.box(rc[0], rc[1], rc[2], doorW / 2, 0.1, Math.sqrt(L * L + drop * drop) / 2, b.rot, Math.atan2(drop, L));   // low end at the street
				const ramp = this.acc('plain', b.x, b.z);
				const a = f.p(dx - doorW / 2, floorY + 0.01, hd), c = f.p(dx + doorW / 2, floorY + 0.01, hd), e = f.p(dx + doorW / 2, gF + 0.02, hd + L), g = f.p(dx - doorW / 2, gF + 0.02, hd + L);
				ramp.face([a, c, e, g], [0, 1, 0], [[0, 0], [0, 0], [0, 0], [0, 0]], stone);
			}
			return;
		}
		// entrance steps / ramp from the street
		const gF = ctx.data.heightAt.apply(null, f.p(dx, 0, hd + 2.2).filter((v: number, i: number) => i !== 1));
		const drop = floorY - gF;
		if (drop > 0.05)
		{
			const L = Math.max(1.2, drop * 3.2);
			const pc = this.acc('plain', b.x, b.z);
			const n = Math.max(1, Math.round(drop / 0.17));
			for (let k = 0; k < n; k++) box(pc, f, dx - doorW / 2 - 0.4, gF - 0.3, hd + k * L / n, dx + doorW / 2 + 0.4, floorY - k * drop / n, hd + (k + 1) * L / n, stone);
			const rc = f.p(dx, gF + drop / 2 - 0.1, hd + L / 2);
			ctx.bphys.box(rc[0], rc[1], rc[2], doorW / 2 + 0.4, 0.1, Math.sqrt(L * L + drop * drop) / 2, b.rot, Math.atan2(drop, L));   // low end at the street
		}
		// the entrance doors themselves are real double doors (RealismDoors, see outerDoors)
		const Z = [[0, 0], [0, 0], [0, 0], [0, 0]];
		// awning (shops) or canopy (office / civic)
		if (b.kind === 'shop' || b.kind === 'apartment')
		{
			const ac = AWNING_COLORS[Math.floor(rnd(11) * AWNING_COLORS.length) % AWNING_COLORS.length];
			const acol = hood ? mix(ac, [0.35, 0.33, 0.3], 0.45) : ac;
			const ay = Math.min(floorY + 3.4, y1 - 0.3);
			const aw0 = -hw + 0.4, aw1 = hw - 0.4, out = 1.6;
			const awn = this.acc('plain', b.x, b.z, true);
			const p1 = f.p(aw0, ay, hd), p2 = f.p(aw1, ay, hd), p3 = f.p(aw1, ay - 0.7, hd + out), p4 = f.p(aw0, ay - 0.7, hd + out);
			awn.face([p1, p2, p3, p4], f.n(0, 0.9, 0.4), Z, acol);
			awn.face([p2, p1, p4, p3], f.n(0, -0.9, -0.4), Z, mul(acol, 0.7));
			box(awn, f, aw0, ay - 1.0, hd + out - 0.02, aw1, ay - 0.7, hd + out + 0.02, mul(acol, 0.9));
			if (hood && rnd(12) < 0.4) { /* torn: skip side flaps */ }
			else
			{
				awn.face([f.p(aw0, ay, hd), f.p(aw0, ay - 0.7, hd + out), f.p(aw0, ay - 1.0, hd + out)], f.n(-1, 0, 0), [[0, 0], [0, 0], [0, 0]], mul(acol, 0.8));
				awn.face([f.p(aw1, ay - 0.7, hd + out), f.p(aw1, ay, hd), f.p(aw1, ay - 1.0, hd + out)], f.n(1, 0, 0), [[0, 0], [0, 0], [0, 0]], mul(acol, 0.8));
			}
		}
		else
		{
			const cy = Math.min(floorY + doorH + 0.5, floor1Top);
			box(det, f, dx - doorW / 2 - 1.2, cy, hd, dx + doorW / 2 + 1.2, cy + 0.25, hd + 2.4, [0.3, 0.31, 0.33]);
			box(det, f, dx - doorW / 2 - 1.1, floorY, hd + 2.1, dx - doorW / 2 - 0.95, cy, hd + 2.25, [0.3, 0.31, 0.33]);
			box(det, f, dx + doorW / 2 + 0.95, floorY, hd + 2.1, dx + doorW / 2 + 1.1, cy, hd + 2.25, [0.3, 0.31, 0.33]);
			const lp = f.p(dx, cy - 0.3, hd + 1.4);
			ctx.lightSpots.push({ x: lp[0], y: lp[1], z: lp[2], color: 0xfff2d6, range: 9, night: true });
		}
		void glazing; void cond;
	}

	// -----------------------------------------------------------------------

	private roof(b: Building, f: Frame, tint: number[], rnd: (k: number) => number, hood: boolean, cond: number, y1: number, isHouse: boolean, small: boolean): void
	{
		const roofAcc = this.acc('plain', b.x, b.z);
		const wall = this.acc((STYLES[b.style] || STYLES.plain).mat, b.x, b.z);
		const x0 = -b.w / 2, x1 = b.w / 2, z0 = -b.d / 2, z1 = b.d / 2;
		const Z = [[0, 0], [0, 0], [0, 0], [0, 0]];
		const roofTint = hood ? mix(b.roofTint, [0.25, 0.24, 0.22], 0.4) : b.roofTint;
		if (b.roof === 'gable')
		{
			const o = 0.45;
			const alongX = b.w >= b.d;
			const rh = Math.min(b.w, b.d) * 0.35;
			const st = STYLES[b.style] || STYLES.plain;
			const gUV = (a: number, h: number) => [a / st.tileW, (h - b.baseY) / st.tileH];
			if (alongX)
			{
				const rA = f.p(x0 - o, y1 + rh, 0), rB = f.p(x1 + o, y1 + rh, 0);
				const s1 = Math.atan2(rh, b.d / 2);
				roofAcc.face([f.p(x0 - o, y1 - o * 0.6, z1 + o), f.p(x1 + o, y1 - o * 0.6, z1 + o), rB, rA], f.n(0, Math.cos(s1), Math.sin(s1)), Z, roofTint);
				roofAcc.face([f.p(x1 + o, y1 - o * 0.6, z0 - o), f.p(x0 - o, y1 - o * 0.6, z0 - o), rA, rB], f.n(0, Math.cos(s1), -Math.sin(s1)), Z, roofTint);
				// soffits (underside of the overhang)
				roofAcc.face([f.p(x1 + o, y1 - o * 0.6, z1 + o), f.p(x0 - o, y1 - o * 0.6, z1 + o), f.p(x0 - o, y1, z1), f.p(x1 + o, y1, z1)], [0, -1, 0], Z, [0.85, 0.85, 0.83]);
				roofAcc.face([f.p(x0 - o, y1 - o * 0.6, z0 - o), f.p(x1 + o, y1 - o * 0.6, z0 - o), f.p(x1 + o, y1, z0), f.p(x0 - o, y1, z0)], [0, -1, 0], Z, [0.85, 0.85, 0.83]);
				wall.face([f.p(x1, y1, z0), f.p(x1, y1, z1), f.p(x1, y1 + rh, 0)], f.n(1, 0, 0), [gUV(0, y1), gUV(b.d, y1), gUV(b.d / 2, y1 + rh)], tint);
				wall.face([f.p(x0, y1, z1), f.p(x0, y1, z0), f.p(x0, y1 + rh, 0)], f.n(-1, 0, 0), [gUV(0, y1), gUV(b.d, y1), gUV(b.d / 2, y1 + rh)], tint);
				// ridge cap
				box(roofAcc, f, x0 - o, y1 + rh - 0.06, -0.12, x1 + o, y1 + rh + 0.08, 0.12, mul(roofTint, 0.8));
			}
			else
			{
				const rA = f.p(0, y1 + rh, z0 - o), rB = f.p(0, y1 + rh, z1 + o);
				const s1 = Math.atan2(rh, b.w / 2);
				roofAcc.face([f.p(x1 + o, y1 - o * 0.6, z0 - o), f.p(x1 + o, y1 - o * 0.6, z1 + o), rB, rA], f.n(Math.sin(s1), Math.cos(s1), 0), Z, roofTint);
				roofAcc.face([f.p(x0 - o, y1 - o * 0.6, z1 + o), f.p(x0 - o, y1 - o * 0.6, z0 - o), rA, rB], f.n(-Math.sin(s1), Math.cos(s1), 0), Z, roofTint);
				roofAcc.face([f.p(x1 + o, y1 - o * 0.6, z1 + o), f.p(x1 + o, y1 - o * 0.6, z0 - o), f.p(x1, y1, z0 - o), f.p(x1, y1, z1 + o)], [0, -1, 0], Z, [0.85, 0.85, 0.83]);
				roofAcc.face([f.p(x0 - o, y1 - o * 0.6, z0 - o), f.p(x0 - o, y1 - o * 0.6, z1 + o), f.p(x0, y1, z1 + o), f.p(x0, y1, z0 - o)], [0, -1, 0], Z, [0.85, 0.85, 0.83]);
				wall.face([f.p(x0, y1, z1), f.p(x1, y1, z1), f.p(0, y1 + rh, z1)], f.n(0, 0, 1), [gUV(0, y1), gUV(b.w, y1), gUV(b.w / 2, y1 + rh)], tint);
				wall.face([f.p(x1, y1, z0), f.p(x0, y1, z0), f.p(0, y1 + rh, z0)], f.n(0, 0, -1), [gUV(0, y1), gUV(b.w, y1), gUV(b.w / 2, y1 + rh)], tint);
				box(roofAcc, f, -0.12, y1 + rh - 0.06, z0 - o, 0.12, y1 + rh + 0.08, z1 + o, mul(roofTint, 0.8));
			}
			// missing shingles patch in the hood
			if (hood && rnd(30) < 0.5 * (1 - cond) + 0.15)
			{
				const pc = [0.18, 0.15, 0.13];
				const det = this.acc('decal', b.x, b.z, true);
				if (alongX)
				{
					const s1 = Math.atan2(rh, b.d / 2);
					const t = 0.3 + rnd(31) * 0.3, px = (rnd(32) - 0.5) * b.w * 0.5;
					const zz = (b.d / 2) * (1 - t), yy = y1 + rh * t + 0.03;
					det.face([f.p(px - 1, yy - 0.25, zz + 0.6), f.p(px + 1, yy - 0.25, zz + 0.6), f.p(px + 1, yy + 0.25, zz - 0.6), f.p(px - 1, yy + 0.25, zz - 0.6)], f.n(0, Math.cos(s1), Math.sin(s1)), Z, pc);
				}
			}
			return;
		}
		const top = [f.p(x0, y1, z0), f.p(x1, y1, z0), f.p(x1, y1, z1), f.p(x0, y1, z1)];
		if (b.roof === 'none' || b.style === 'plain' || b.style === 'wood')
		{
			roofAcc.face(top, [0, 1, 0], Z, tint);
			return;
		}
		roofAcc.face(top, [0, 1, 0], Z, roofTint);
		if (small || isHouse) return;
		// parapet
		if (b.h > 6 && b.style !== 'warehouse' && b.style !== 'steel')
		{
			const pt = 0.25, ph = 0.9, pc = mul(tint, 0.85);
			box(wall === roofAcc ? roofAcc : roofAcc, f, x0, y1, z0, x1, y1 + ph, z0 + pt, pc);
			box(roofAcc, f, x0, y1, z1 - pt, x1, y1 + ph, z1, pc);
			box(roofAcc, f, x0, y1, z0 + pt, x0 + pt, y1 + ph, z1 - pt, pc);
			box(roofAcc, f, x1 - pt, y1, z0 + pt, x1, y1 + ph, z1 - pt, pc);
		}
		const det = this.acc('plain', b.x, b.z, true);
		if (b.h > 10 && b.w > 10 && b.d > 10)
		{
			// stair / elevator hut
			const hw = Math.min(4, b.w * 0.25), hd2 = Math.min(3.5, b.d * 0.22);
			box(roofAcc, f, -hw / 2 + b.w * 0.15, y1, -hd2 / 2 - b.d * 0.15, hw / 2 + b.w * 0.15, y1 + 3, hd2 / 2 - b.d * 0.15, [0.62, 0.62, 0.62]);
			// AC units
			const n = 1 + Math.floor(rnd(40) * 3);
			for (let k = 0; k < n; k++)
			{
				const ax = (rnd(41 + k) - 0.5) * b.w * 0.6, az = (rnd(51 + k) - 0.5) * b.d * 0.6 + b.d * 0.15;
				box(det, f, ax - 0.9, y1, az - 0.7, ax + 0.9, y1 + 1.2, az + 0.7, [0.72, 0.72, 0.7]);
				cyl(det, f, ax, y1 + 1.2, az, 0.05, 0.5, 0.5, 8, [0.25, 0.25, 0.25], true);
			}
		}
		// wooden water tank on brick walk-ups
		if (b.style === 'brick' && b.h > 12 && b.h < 40 && rnd(60) < 0.5)
		{
			const tx = -b.w * 0.25, tz = -b.d * 0.2;
			for (let k = 0; k < 4; k++) box(det, f, tx + (k % 2 ? 1.1 : -1.3), y1, tz + (k < 2 ? 1.1 : -1.3), tx + (k % 2 ? 1.3 : -1.1), y1 + 2.6, tz + (k < 2 ? 1.3 : -1.1), [0.2, 0.2, 0.2]);
			cyl(det, f, tx, y1 + 2.6, tz, 3, 1.6, 1.6, 12, [0.5, 0.38, 0.28], true);
			cyl(det, f, tx, y1 + 5.6, tz, 1, 1.7, 0, 12, [0.3, 0.3, 0.32]);
		}
		// antenna on towers
		if (b.h > 50)
		{
			cyl(det, f, 0, y1, 0, 12, 0.25, 0.08, 6, [0.75, 0.75, 0.78]);
			box(this.acc('signalRed', b.x, b.z, true), f, -0.15, y1 + 12, -0.15, 0.15, y1 + 12.3, 0.15, [1, 1, 1]);
		}
	}

	private labelSign(b: Building, f: Frame, y0: number, y1: number, floorY: number): void
	{
		const colors = SIGN_COLORS[b.label] || ['#1d1d1f', '#f4f4f0'];
		const width = Math.min(b.w * 0.85, 2 + b.label.length * 0.9);
		const height = width * (128 / 1024);
		const y = b.h < 3 ? y0 + b.h / 2 : Math.min(y0 + Math.min(b.h - height / 2 - 0.4, 7), y1 - height / 2 - 0.3);
		const yy = Math.max(y, floorY + 3.3 + height / 2);
		const yS = Math.min(yy, y1 - height / 2 - 0.2);
		this.sign(f, b.label, colors[0], colors[1], 0, b.h < 3 ? y : yS, b.d / 2 + 0.14, width, 1);
		if (b.h < 3) this.sign(f, b.label, colors[0], colors[1], 0, y, -b.d / 2 - 0.14, width, -1);
	}

	// -----------------------------------------------------------------------

	/** Registers real doors for every doorway in the outer walls (front + back). */
	private outerDoors(b: Building, f: Frame, index: number, rnd: (k: number) => number, hood: boolean, closed: boolean, isHouse: boolean, T: number,
		floorY: number, doorH: number, doorW: number, frontDoorU: number, doorOps: Opening[][]): void
	{
		const doors = this.ctx.doors;
		if (!doors || !doorOps[0].length) return;
		const hw = b.w / 2, hd = b.d / 2;
		const group = 'b' + index;
		const dx = -hw + frontDoorU;
		const lockedForGood = closed;
		if (isHouse)
		{
			const dc = DOOR_COLORS[Math.floor(rnd(3) * DOOR_COLORS.length) % DOOR_COLORS.length];
			const col = hood ? mul(dc, 0.7) : dc;
			// hinge on the left jamb, in the middle of the wall; swings into the house
			const hp = f.p(dx - doorW / 2, floorY, hd - T / 2);
			doors.add({ kind: 'hinged', x: hp[0], y: floorY + 0.005, z: hp[2], rot: b.rot, width: doorW, height: doorH - 0.02, color: col,
				locked: lockedForGood, fixed: lockedForGood, group: group, label: 'Front door' });
			// back door: back side runs from local +x to -x; frame turned 180 degrees so the leaf still swings inwards
			for (let k = 0; k < doorOps[2].length; k++)
			{
				const o = doorOps[2][k];
				const bp = f.p(hw - o.u0, floorY, -hd + T / 2);
				doors.add({ kind: 'hinged', x: bp[0], y: floorY + 0.005, z: bp[2], rot: b.rot + Math.PI, width: o.u1 - o.u0, height: doorH - 0.02, color: [0.9, 0.9, 0.88],
					locked: lockedForGood, fixed: lockedForGood, group: group, label: 'Back door' });
			}
			return;
		}
		if (b.sub === 'hangar')
		{
			// two big leaves outside the wall that slide apart along the facade
			const hp = f.p(dx - doorW / 2, floorY, hd);
			doors.add({ kind: 'hangar', x: hp[0], y: floorY - 0.02, z: hp[2], rot: b.rot, width: doorW, height: doorH, thickness: 0.25, color: [0.78, 0.8, 0.83],
				group: group, label: 'Hangar door' });
			return;
		}
		if (b.kind === 'warehouse' || b.sub === 'fire' || b.sub === 'mechanic')
		{
			const hp = f.p(dx - doorW / 2, floorY, hd - T / 2);
			doors.add({ kind: 'rollup', x: hp[0], y: floorY - 0.01, z: hp[2], rot: b.rot, width: doorW, height: doorH, color: b.sub === 'fire' ? [0.75, 0.18, 0.14] : [0.7, 0.7, 0.68],
				open: (b.sub === 'fire' || b.sub === 'mechanic') && !closed, locked: lockedForGood, fixed: lockedForGood, group: group, label: 'Roll-up door' });
			return;
		}
		// shops, offices, civic: double doors, each leaf swings inwards
		const col = hood ? [0.16, 0.19, 0.21] : [0.22, 0.27, 0.3];
		const lw = doorW / 2;
		const lp = f.p(dx - doorW / 2, floorY, hd - T / 2), rp = f.p(dx + doorW / 2, floorY, hd - T / 2);
		const a = doors.add({ kind: 'hinged', x: lp[0], y: floorY + 0.005, z: lp[2], rot: b.rot, width: lw, height: doorH - 0.02, color: col,
			locked: lockedForGood, fixed: lockedForGood, group: group, label: 'Entrance' });
		const c = doors.add({ kind: 'hinged', x: rp[0], y: floorY + 0.005, z: rp[2], rot: b.rot + Math.PI, width: lw, height: doorH - 0.02, color: col, openAngle: -Math.PI * 0.5,
			locked: lockedForGood, fixed: lockedForGood, group: group, label: 'Entrance' });
		doors.link(a, c);
	}

	/** Closed / abandoned building: plywood over the door(s) and shop windows, a CLOSED / FOR LEASE sign. */
	private closedUp(b: Building, f: Frame, rnd: (k: number) => number, isHouse: boolean, enter: boolean, storefront: boolean,
		floorY: number, doorH: number, doorW: number, frontDoorU: number, doorOps: Opening[][], glazing: Opening[], T: number): void
	{
		const ply = this.acc('plain', b.x, b.z, true);
		const hw = b.w / 2, hd = b.d / 2, y0 = b.baseY;
		const wood = [0.62, 0.5, 0.33], batten = [0.5, 0.4, 0.26];
		// a plywood sheet on the outside of the front wall, from local x0..x1, height ya..yb
		const sheet = (x0: number, x1: number, ya: number, yb: number, zf: number, dir: number) =>
		{
			const za = dir > 0 ? zf + 0.015 : zf - 0.055, zb = dir > 0 ? zf + 0.055 : zf - 0.015;
			box(ply, f, x0, ya, za, x1, yb, zb, wood);
			const zc = dir > 0 ? zb : za - 0.03;
			const xm = (x0 + x1) / 2, ym = (ya + yb) / 2;
			box(ply, f, x0 + 0.05, ym - 0.07, zc, x1 - 0.05, ym + 0.07, zc + 0.03, batten);
			if (yb - ya > 1.4)
			{
				box(ply, f, x0 + 0.05, ya + (yb - ya) * 0.2 - 0.07, zc, x1 - 0.05, ya + (yb - ya) * 0.2 + 0.07, zc + 0.03, batten);
				box(ply, f, x0 + 0.05, ya + (yb - ya) * 0.8 - 0.07, zc, x1 - 0.05, ya + (yb - ya) * 0.8 + 0.07, zc + 0.03, batten);
			}
			void xm;
		};
		const dx = -hw + frontDoorU;
		// front door (real opening, or the sealed panel of a building you can't enter)
		let dw = doorW, dh = isHouse ? 2.2 : 2.55, dcx = dx;
		if (enter && doorOps[0].length) { dh = doorOps[0][0].v1 + y0 - floorY + 0.06; dw = doorW + 0.12; }
		else if (!isHouse) { dcx = 0; dw = 1.9; }
		else dw = doorW + 0.2;
		// a sealed door panel stands proud of the wall: nail the sheet onto its face
		const zDoor = enter && doorOps[0].length ? hd : hd + 0.065;
		sheet(dcx - dw / 2, dcx + dw / 2, floorY - 0.01, floorY + dh, zDoor, 1);
		// back door
		if (enter) for (let k = 0; k < doorOps[2].length; k++)
		{
			const o = doorOps[2][k];
			sheet(hw - o.u1 - 0.06, hw - o.u0 + 0.06, floorY - 0.01, y0 + o.v1 + 0.06, -hd, -1);
		}
		// shop windows
		if (storefront) for (let k = 0; k < glazing.length; k++)
		{
			const o = glazing[k];
			if (o.u1 - o.u0 < 0.3) continue;
			const ya = y0 + o.v0 - 0.05, yb = y0 + o.v1 + 0.05;
			// several 1.2 m sheets side by side, slightly uneven
			const n = Math.max(1, Math.round((o.u1 - o.u0) / 1.22));
			for (let m = 0; m < n; m++)
			{
				const u0 = o.u0 + (o.u1 - o.u0) * m / n, u1 = o.u0 + (o.u1 - o.u0) * (m + 1) / n;
				sheet(-hw + u0 - 0.03, -hw + u1 + 0.03, ya - rnd(200 + m) * 0.04, yb + rnd(220 + m) * 0.04, hd + (m % 2) * 0.012, 1);
			}
		}
		// sign on the boards
		const forLease = !isHouse && rnd(240) < 0.55;
		const text = forLease ? 'FOR LEASE' : 'CLOSED';
		const bg = forLease ? '#ffffff' : '#b3201b', fg = forLease ? '#c41a1a' : '#ffffff';
		if (storefront && glazing.length && glazing[0].u1 - glazing[0].u0 > 1.6)
		{
			const o = glazing[0];
			const width = Math.min(3.2, (o.u1 - o.u0) * 0.8);
			this.sign(f, text, bg, fg, -hw + (o.u0 + o.u1) / 2, y0 + (o.v0 + o.v1) / 2 + 0.35, hd + 0.11, width, 1);
		}
		else this.sign(f, text, bg, fg, dcx, floorY + Math.min(1.6, dh - 0.4), zDoor + 0.11, Math.max(1.3, dw * 1.25), 1);
		void T; void doorH;
	}

	/**
	 * A wall decal (grime, streak, graffiti) on side `s`, cut around every keep-out rectangle
	 * (doorways, doors, windows). u is along the side, y is world height; UVs follow the cut.
	 */
	private decal(acc: GeoAccum, f: Frame, s: Side, inset: number, u0: number, u1: number, ya: number, yb: number, uv: number[], color: number[], keep: Opening[]): void
	{
		const len = u1 - u0, h = yb - ya;
		if (len <= 0.02 || h <= 0.02) return;
		const ops: Opening[] = [];
		for (let i = 0; i < keep.length; i++)
		{
			const k = keep[i];
			if (k.u1 <= u0 || k.u0 >= u1 || k.v1 <= ya || k.v0 >= yb) continue;
			ops.push({ u0: k.u0 - u0, u1: k.u1 - u0, v0: k.v0 - ya, v1: k.v1 - ya });
		}
		const pieces = ops.length ? wallPieces(len, h, ops) : [{ u0: 0, u1: len, v0: 0, v1: h }];
		const n = f.n(s.nx, 0, s.nz);
		// uv = [uA, vA, uB, vB]: texture coords at (u0, ya) and (u1, yb)
		const U = (t: number) => uv[0] + (uv[2] - uv[0]) * t, V = (t: number) => uv[1] + (uv[3] - uv[1]) * t;
		for (let i = 0; i < pieces.length; i++)
		{
			const pc = pieces[i];
			if (pc.u1 - pc.u0 < 0.03 || pc.v1 - pc.v0 < 0.03) continue;
			const a = sp(s, u0 + pc.u0, inset), c = sp(s, u0 + pc.u1, inset);
			const y0 = ya + pc.v0, y1 = ya + pc.v1;
			const ta = pc.u0 / len, tb = pc.u1 / len, va = pc.v0 / h, vb = pc.v1 / h;
			acc.face([f.p(a[0], y0, a[1]), f.p(c[0], y0, c[1]), f.p(c[0], y1, c[1]), f.p(a[0], y1, a[1])], n,
				[[U(ta), V(va)], [U(tb), V(va)], [U(tb), V(vb)], [U(ta), V(vb)]], color);
		}
	}

	// -----------------------------------------------------------------------

	private decay(b: Building, f: Frame, rnd: (k: number) => number, cond: number, y0: number, gY: number, y1: number, sides: Side[], keep: Opening[][]): void
	{
		// Every decal is cut around the doorways, doors and windows of its wall (keep). Before,
		// the grime band, the water streaks and the graffiti were single quads across the whole
		// wall and floated in front of the open front / back doorways of every run-down house.
		const decal = this.acc('grime', b.x, b.z, true);
		const graf = this.acc('graffiti', b.x, b.z, true);
		for (let si = 0; si < 4; si++)
		{
			const s = sides[si];
			const K = keep[si];
			// grime band along the bottom
			const gh = 0.45 + (1 - cond) * 0.45;      // soft dirt fade, at most ~0.9 m
			this.decal(decal, f, s, -0.015, 0, s.len, gY - 0.3, gY + gh, [0, 0, 1, 1], [0.3, 0.26, 0.21], K);
			// water streaks
			const streaks = Math.floor(s.len / 4);
			for (let k = 0; k < streaks; k++)
			{
				if (rnd(70 + si * 10 + k) > 0.5) continue;
				const u = (k + 0.5) * s.len / streaks;
				const yt = y1 - 0.2, yb = Math.max(gY + gh, y1 - 1.5 - rnd(80 + k) * 3);
				// streak: darkest at the top (under the gutter), fading out downwards
				this.decal(decal, f, s, -0.016, u - 0.25, u + 0.25, yb, yt, [0, 1, 1, 0], [0.36, 0.33, 0.29], K);
			}
			// graffiti tags: on a clear stretch of wall, never over a door, below the window sills
			if (rnd(90 + si) < 0.55 + (1 - cond) * 0.4 && s.len > 4)
			{
				const cell = Math.floor(rnd(95 + si) * 8) % 8;
				const cu = (cell % 4) * 0.25, cv = cell < 4 ? 0.5 : 0;
				const yb = gY + 0.25;
				let tw = Math.min(s.len * 0.6, 2.6 + rnd(97 + si) * 1.5);
				let placed = false;
				for (let attempt = 0; attempt < 6 && !placed; attempt++)
				{
					const u = s.len * (0.12 + ((rnd(99 + si) + attempt * 0.618) % 1) * 0.76);
					let ua = Math.max(0.15, u - tw / 2), ub = Math.min(s.len - 0.15, u + tw / 2);
					let blocked = false, top = yb + tw * 0.95;
					for (let k = 0; k < K.length; k++)
					{
						const o = K[k];
						if (o.u1 <= ua || o.u0 >= ub) continue;
						if (o.v0 <= yb + 0.6) { blocked = true; break; }   // a door (or a low shop window) in the way
						top = Math.min(top, o.v0 - 0.05);                  // stay under the window sill
					}
					if (blocked) { tw *= 0.8; continue; }
					const th = top - yb;
					if (th < 0.5) { tw *= 0.8; continue; }
					// keep the tag's proportions: narrow it to fit the height
					const w2 = Math.min(ub - ua, th / 0.95);
					const um = (ua + ub) / 2;
					ua = um - w2 / 2; ub = um + w2 / 2;
					this.decal(graf, f, s, -0.02, ua, ub, yb, yb + w2 * 0.95, [cu, cv, cu + 0.25, cv + 0.5], [1, 1, 1], K);
					placed = true;
				}
			}
		}
		void y0;
	}
}

/** Material for see-through window glass (shared, created lazily). */
export function ensureGlassMaterial(ctx: RealismCtx): void
{
	if (ctx.mats.glassPane) return;
	const m = new THREE.MeshPhongMaterial({ vertexColors: THREE.VertexColors, transparent: true, opacity: 0.32, shininess: 90, specular: 0x999999, side: THREE.FrontSide, depthWrite: false });
	ctx.world.sky.csm.setupMaterial(m);
	ctx.mats.glassPane = m;
}
