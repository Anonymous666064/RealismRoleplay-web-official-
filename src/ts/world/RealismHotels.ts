/*
 * RealismHotels.ts
 * ----------------
 * Hotels for San Verano County: a 20-storey tower downtown, a 14-storey hotel in
 * the east of downtown, an 8-storey beach hotel by Verano Pier and a 10-storey
 * airport hotel on a free lot in front of the terminal.
 *
 * Every hotel has
 *  - an exterior: window grid (one real window per room), podium, floor ledges,
 *    cornice, rooftop gear, a canvas-texture name sign on the roof, a canopy with
 *    posts, down-lights and a small sign over the entrance, and entrance steps;
 *  - a lobby: front desk with monitors, a feature wall with the hotel name,
 *    sofas, armchairs, coffee tables, rugs, plants, a luggage cart, pendant lights
 *    and two (decorative) elevators;
 *  - a scissor stairwell through every floor (two flights + a mid landing per
 *    storey, walkable ramp colliders, centre wall, handrails, exit signs);
 *  - on every upper floor a central hallway with rooms on both sides. Each room:
 *    bed with headboard, pillows and a throw, two nightstands with lamps, a dresser
 *    with a TV, desk + chair + desk lamp, armchair, wardrobe, curtains, a window,
 *    carpet, and a bathroom with its own door (toilet, vanity + basin + mirror +
 *    light bar, bathtub with shower and curtain).
 *
 * Performance (Chromebooks, 30 fps):
 *  - The shell, slabs, stairwell and lobby are static meshes merged per material
 *    per hotel (about 5 draw calls outside, 5 more inside interiorDistance).
 *  - Guest floors are NOT built 20 times. One room kit and one floor-walls kit are
 *    built per hotel and drawn with GPU instancing only on the floors around the
 *    player / camera (max 4 floors), and only while you are in or at the hotel.
 *    Their colliders (partitions, furniture) live in a small pool of static bodies
 *    that is moved to those floors. Shell, slabs and stairs use ctx.bphys.
 *  - Room / bathroom / stairwell doors are registered with the door system
 *    ((ctx as any).doors.add), the openings are left empty for it.
 *
 * Integration:
 *  - assignHotels(data) once right after generateRealismMap(): picks the sites and
 *    marks them custom = 'hotel' (role 'hotel').
 *  - RealismBuildings skips custom === 'hotel'.
 *  - new HotelBuilder(ctx).build() after the landmarks, before ctx.bphys.commit().
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { Building, MapData, HALF } from './RealismMapData';
import { RealismCtx, addMesh, instMat } from './RealismContext';
import { AccumSet, GeoAccum, Frame, box, cyl, wallPieces, Opening } from './RealismGeometry';
import { signTexture, canvasTexture } from './RealismMaterials';
import { IUpdatable } from '../interfaces/IUpdatable';

// ---------------------------------------------------------------------------
// Dimensions (metres)
// ---------------------------------------------------------------------------

const LOBBY_H = 4.2;      // ground floor, floor to floor
const FLOOR_H = 3.4;      // guest floors, floor to floor
const SLAB = 0.3;         // floor slab thickness (clear height 3.1 on guest floors)
const T = 0.35;           // outer wall
const HH = 0.9;           // half width of the hallway
const HT = 0.14;          // hallway / core wall thickness
const SW = 2.7;           // stairwell inner width (two lanes + centre wall)
const LANE = 1.25;        // stair flight width
const CWALL = 0.2;        // centre wall between the flights
const LAND = 1.3;         // floor landing depth
const RUN = 3.6;          // horizontal run of one flight
const PARAPET = 1.2;
const BW = 2.3;           // bathroom width incl. its wall
const BD = 2.4;           // bathroom depth
const DOOR_H = 2.15;
const MAXF = 4;           // guest floors drawn / collided at once per hotel
const WIN_W = 1.8, WIN_V0 = 0.8, WIN_V1 = 2.6;

const Z4 = [[0, 0], [0, 0], [0, 0], [0, 0]];

// ---------------------------------------------------------------------------
// Hotel list + palettes
// ---------------------------------------------------------------------------

export interface HotelDef { name: string; floors: number; near?: number[]; airport?: boolean; pal: number; }

export const HOTEL_DEFS: HotelDef[] = [
	{ name: 'THE GRAND VERANO', floors: 20, near: [262, 560], pal: 0 },     // downtown core, next to the bank tower
	{ name: 'HARBORVIEW HOTEL', floors: 14, near: [372, 650], pal: 1 },     // east downtown, towards the port
	{ name: 'PACIFIC SANDS HOTEL', floors: 8, near: [-40, 770], pal: 2 },   // boardwalk, by Verano Pier
	{ name: 'SKYPORT INN', floors: 10, airport: true, pal: 3 },             // in front of the airport terminal
];

interface Palette
{
	facade: number[]; podium: number[]; trim: number[]; accent: number[];
	hallCarpet: number[]; roomCarpet: number[]; hallWall: number[]; roomWall: number[];
	bedding: number[]; throwC: number[]; headboard: number[]; wood: number[]; sofa: number[];
	sign: string[];
}

const PALETTES: Palette[] = [
	{ // Grand Verano: cream stone, burgundy and gold
		facade: [0.86, 0.82, 0.73], podium: [0.4, 0.36, 0.32], trim: [0.25, 0.22, 0.2], accent: [0.45, 0.1, 0.12],
		hallCarpet: [0.42, 0.12, 0.14], roomCarpet: [0.56, 0.48, 0.38], hallWall: [0.86, 0.79, 0.66], roomWall: [0.9, 0.87, 0.8],
		bedding: [0.95, 0.95, 0.94], throwC: [0.5, 0.1, 0.12], headboard: [0.36, 0.25, 0.19], wood: [0.34, 0.22, 0.15], sofa: [0.42, 0.12, 0.14],
		sign: ['#4a0c10', '#f2d48a'],
	},
	{ // Harborview: white and navy
		facade: [0.9, 0.91, 0.92], podium: [0.22, 0.26, 0.34], trim: [0.16, 0.2, 0.3], accent: [0.12, 0.2, 0.38],
		hallCarpet: [0.16, 0.22, 0.36], roomCarpet: [0.5, 0.52, 0.55], hallWall: [0.84, 0.86, 0.88], roomWall: [0.92, 0.92, 0.9],
		bedding: [0.96, 0.96, 0.97], throwC: [0.14, 0.22, 0.42], headboard: [0.3, 0.33, 0.4], wood: [0.45, 0.33, 0.24], sofa: [0.2, 0.28, 0.45],
		sign: ['#14223f', '#ffffff'],
	},
	{ // Pacific Sands: sand and teal
		facade: [0.93, 0.86, 0.72], podium: [0.62, 0.52, 0.4], trim: [0.12, 0.42, 0.44], accent: [0.1, 0.5, 0.52],
		hallCarpet: [0.14, 0.42, 0.44], roomCarpet: [0.72, 0.66, 0.54], hallWall: [0.94, 0.9, 0.8], roomWall: [0.95, 0.93, 0.86],
		bedding: [0.97, 0.97, 0.95], throwC: [0.12, 0.5, 0.52], headboard: [0.75, 0.68, 0.55], wood: [0.62, 0.5, 0.36], sofa: [0.85, 0.8, 0.68],
		sign: ['#0f6668', '#fff4d6'],
	},
	{ // Skyport Inn: grey and orange
		facade: [0.72, 0.74, 0.76], podium: [0.3, 0.31, 0.33], trim: [0.22, 0.23, 0.25], accent: [0.85, 0.42, 0.1],
		hallCarpet: [0.3, 0.3, 0.33], roomCarpet: [0.45, 0.44, 0.42], hallWall: [0.86, 0.85, 0.82], roomWall: [0.9, 0.89, 0.86],
		bedding: [0.95, 0.95, 0.95], throwC: [0.85, 0.42, 0.1], headboard: [0.28, 0.28, 0.3], wood: [0.4, 0.3, 0.22], sofa: [0.32, 0.33, 0.36],
		sign: ['#2a2b2e', '#ff8a1e'],
	},
];

const CONCRETE = [0.66, 0.65, 0.62], CEILING = [0.93, 0.93, 0.91], WHITE = [0.95, 0.95, 0.94], DARK = [0.1, 0.1, 0.11];
const STEEL = [0.62, 0.64, 0.67], TILE = [0.86, 0.87, 0.86], GLASS = [0.42, 0.52, 0.6], PLANT = [0.2, 0.42, 0.18];

function clamp(v: number, a: number, b: number): number { return v < a ? a : (v > b ? b : v); }
function mul(c: number[], k: number): number[] { return [c[0] * k, c[1] * k, c[2] * k]; }
function slugOf(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function pad2(n: number): string { return n < 10 ? '0' + n : '' + n; }

// ---------------------------------------------------------------------------
// Site selection (pure data, runs once after generateRealismMap)
// ---------------------------------------------------------------------------

/**
 * Picks the hotel sites and marks them custom = 'hotel'. Downtown / beach hotels
 * replace an existing office, tower or shop lot (footprint only shrinks, so nothing
 * around them moves); the airport hotel claims a free lot facing a landside road.
 * Safe to call twice (returns the hotels already assigned).
 */
export function assignHotels(data: MapData): Building[]
{
	const already = data.buildings.filter((b) => b.custom === 'hotel' && b.role === 'hotel');
	if (already.length) return already;
	const out: Building[] = [];
	for (let i = 0; i < HOTEL_DEFS.length; i++)
	{
		const def = HOTEL_DEFS[i];
		let b: Building = null;
		if (def.airport) b = claimAirportLot(data, out);
		if (!b && def.near) b = pickLot(data, def.near, out, 260);
		if (!b && def.airport) b = pickLot(data, [-110, 470], out, 600);   // fallback: west downtown
		if (!b) continue;
		setupHotel(b, def);
		out.push(b);
	}
	if (data.stats) data.stats.hotels = out.length;
	return out;
}

function pickLot(data: MapData, near: number[], taken: Building[], maxDist: number): Building
{
	let best: Building = null, bestScore = 1e9;
	for (let i = 0; i < data.buildings.length; i++)
	{
		const b = data.buildings[i];
		if (b.custom || !b.enterable || b.groundY === undefined) continue;
		if (b.label) continue;                                     // named landmark (bank tower, ...)
		if (b.kind !== 'office' && b.kind !== 'tower' && b.kind !== 'shop') continue;
		if (b.w < 22 || b.d < 18) continue;
		const dist = Math.sqrt((b.x - near[0]) * (b.x - near[0]) + (b.z - near[1]) * (b.z - near[1]));
		if (dist > maxDist) continue;
		let clash = false;
		for (let k = 0; k < taken.length; k++) if (Math.abs(taken[k].x - b.x) + Math.abs(taken[k].z - b.z) < 90) clash = true;
		if (clash) continue;
		const score = dist - Math.min(b.w, 40) * 0.6 - Math.min(b.d, 24) * 0.3;
		if (score < bestScore) { bestScore = score; best = b; }
	}
	return best;
}

function inBuilding(data: MapData, x: number, z: number, margin: number): boolean
{
	const bs = data.buildings;
	for (let i = 0; i < bs.length; i++)
	{
		const b = bs[i];
		const dx = x - b.x, dz = z - b.z;
		if (Math.abs(dx) > 200 || Math.abs(dz) > 200) continue;
		const c = Math.cos(b.rot), s = Math.sin(b.rot);
		const lx = dx * c - dz * s, lz = dx * s + dz * c;
		if (Math.abs(lx) < b.w / 2 + margin && Math.abs(lz) < b.d / 2 + margin) return true;
	}
	return false;
}

/** A free lot in front of the airport terminal whose front faces a landside road (not a runway / taxiway / apron). */
function claimAirportLot(data: MapData, taken: Building[]): Building
{
	const term = data.buildings.filter((b) => b.sub === 'terminal')[0];
	if (!term) return null;
	const W = 26, D = 18;
	const tx = term.x + Math.sin(term.rot) * (term.d / 2 + 80), tz = term.z + Math.cos(term.rot) * (term.d / 2 + 80);
	// landside road segments near the airport
	const segs: number[][] = [];
	for (let r = 0; r < data.roads.length; r++)
	{
		const road = data.roads[r];
		if (road.kind === 'runway' || road.kind === 'taxiway' || road.kind === 'apron') continue;
		for (let i = 0; i < road.pts.length - 1; i++)
		{
			const a = road.pts[i], c = road.pts[i + 1];
			if (Math.abs(a.x - tx) > 450 || Math.abs(a.z - tz) > 450) continue;
			segs.push([a.x, a.z, c.x, c.z, road.width / 2]);
		}
	}
	if (segs.length === 0) return null;
	const roadDist = (x: number, z: number) =>
	{
		let best = 1e9;
		for (let i = 0; i < segs.length; i++)
		{
			const s = segs[i];
			const dx = s[2] - s[0], dz = s[3] - s[1];
			const l2 = dx * dx + dz * dz;
			const t = l2 > 0 ? clamp(((x - s[0]) * dx + (z - s[1]) * dz) / l2, 0, 1) : 0;
			const px = s[0] + dx * t - x, pz = s[1] + dz * t - z;
			const d = Math.sqrt(px * px + pz * pz) - s[4];
			if (d < best) best = d;
		}
		return best;
	};
	const rots = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
	for (let r = 0; r <= 300; r += 10)
	{
		const na = r === 0 ? 1 : 24;
		for (let a = 0; a < na; a++)
		{
			const an = a / na * Math.PI * 2;
			const cx = tx + Math.cos(an) * r, cz = tz + Math.sin(an) * r;
			if (Math.abs(cx) > HALF - 40 || Math.abs(cz) > HALF - 40) continue;
			for (let k = 0; k < rots.length; k++)
			{
				const rot = rots[k];
				const fx = cx + Math.sin(rot) * (D / 2 + 7), fz = cz + Math.cos(rot) * (D / 2 + 7);
				if (roadDist(fx, fz) > 2.5) continue;               // the front must look at a street
				const c = Math.cos(rot), s = Math.sin(rot);
				let ok = true, lo = 1e9, hi = -1e9;
				for (let i = 0; i <= 6 && ok; i++)
					for (let j = 0; j <= 6 && ok; j++)
					{
						const lx = (-0.5 + i / 6) * (W + 5), lz = (-0.5 + j / 6) * (D + 5);
						const x = cx + lx * c + lz * s, z = cz - lx * s + lz * c;
						if (data.roadClearance(x, z) < 2) ok = false;
						else if (inBuilding(data, x, z, 3)) ok = false;
						const h = data.heightAt(x, z);
						if (h < lo) lo = h; if (h > hi) hi = h;
					}
				if (!ok || hi - lo > 0.8) continue;
				for (let t = 0; t < taken.length; t++) if (Math.abs(taken[t].x - cx) + Math.abs(taken[t].z - cz) < 60) ok = false;
				if (!ok) continue;
				// footprint ground range
				let glo = 1e9, ghi = -1e9;
				for (let i = 0; i <= 4; i++)
					for (let j = 0; j <= 4; j++)
					{
						const lx = (-0.5 + i / 4) * W, lz = (-0.5 + j / 4) * D;
						const h = data.heightAt(cx + lx * c + lz * s, cz - lx * s + lz * c);
						if (h < glo) glo = h; if (h > ghi) ghi = h;
					}
				const b: Building = {
					x: cx, z: cz, w: W, d: D, h: 10, rot: rot, baseY: glo - 0.8, style: 'plain', tint: [0.7, 0.72, 0.74],
					roof: 'flat', roofTint: [0.3, 0.3, 0.32], collide: true, groundY: ghi, kind: 'hotel', enterable: true, id: data.buildings.length,
				};
				(b as any).fixedBase = true;
				data.buildings.push(b);
				clearLot(data, b, 3);
				return b;
			}
		}
	}
	return null;
}

/** Removes trees, lamps and props standing on a newly claimed lot. */
function clearLot(data: MapData, b: Building, m: number): void
{
	const c = Math.cos(b.rot), s = Math.sin(b.rot);
	const inside = (x: number, z: number) =>
	{
		const dx = x - b.x, dz = z - b.z;
		const lx = dx * c - dz * s, lz = dx * s + dz * c;
		return Math.abs(lx) < b.w / 2 + m && Math.abs(lz) < b.d / 2 + m + 6;   // + the entrance in front
	};
	const keepT = data.trees.filter((t) => !inside(t.x, t.z));
	data.trees.length = 0; for (let i = 0; i < keepT.length; i++) data.trees.push(keepT[i]);
	const keepL = data.lamps.filter((t) => !inside(t.x, t.z));
	data.lamps.length = 0; for (let i = 0; i < keepL.length; i++) data.lamps.push(keepL[i]);
	const keepP = data.props.filter((t) => !inside(t.x, t.z));
	data.props.length = 0; for (let i = 0; i < keepP.length; i++) data.props.push(keepP[i]);
}

function setupHotel(b: Building, def: HotelDef): void
{
	// fit the footprint (shrink only; keep the front on the street)
	const nw = clamp(b.w, 22, 40), nd = clamp(b.d, 18, 24);
	const shift = (b.d - nd) / 2;
	b.x += Math.sin(b.rot) * shift;
	b.z += Math.cos(b.rot) * shift;
	b.w = nw; b.d = nd;
	const gY = b.groundY !== undefined ? b.groundY : b.baseY + 0.8;
	b.groundY = gY;
	b.custom = 'hotel'; b.role = 'hotel';
	b.kind = 'hotel'; b.sub = 'hotel';
	b.label = def.name; b.floors = def.floors;
	b.enterable = true; b.collide = true; b.roof = 'flat'; b.style = 'plain';
	b.tint = PALETTES[def.pal % PALETTES.length].facade;
	b.district = undefined; b.condition = 1; b.boarded = false;
	const top = gY + 0.18 + LOBBY_H + (def.floors - 1) * FLOOR_H + PARAPET;
	b.h = top - b.baseY;
	(b as any).hotel = { name: def.name, floors: def.floors, pal: def.pal };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

type Acc = (mat: string) => GeoAccum;
interface Shape { x: number; y: number; z: number; hx: number; hy: number; hz: number; rot: number; }
interface Part { geom: THREE.BufferGeometry; mat: string; }
export interface DoorSpec { kind: string; x: number; y: number; z: number; rot: number; width: number; height: number; thickness?: number; color?: number; locked?: boolean; openAngle?: number; group?: string; }

export interface Hotel
{
	b: Building; name: string; slug: string; N: number; pal: Palette;
	f: Frame; w: number; d: number;
	ix0: number; ix1: number; iz0: number; iz1: number; sx1: number; rx0: number;
	RW: number; n: number; ex: number; xe: number;
	Y: number[]; floorY: number; top: number; zA: number; zB: number;
	roomsX: number[];
	kitParts: Part[]; wallParts: Part[];
	kitMeshes: THREE.InstancedMesh[]; wallMeshes: THREE.InstancedMesh[];
	floorShapes: Shape[];
	bodies: { body: CANNON.Body; floor: number; added: boolean }[];
	key: string;
	rooms: number;
	/** Rooms (by room number) whose lamps are switched off (RealismRoomLights). */
	lightsOff?: { [num: number]: boolean };
}

/** Stair flight as built (world-space checks in tests / debugging). */
export interface FlightLog { hotel: string; level: number; lane: string; f: Frame; x: number; zStart: number; yStart: number; zEnd: number; yEnd: number; }

export class HotelBuilder
{
	private ctx: RealismCtx;
	private S: AccumSet;
	private signAcc: GeoAccum;
	private doorQueue: DoorSpec[] = [];
	public hotels: Hotel[] = [];
	public flights: FlightLog[] = [];
	public runtime: HotelRuntime = null;
	public stats = {
		hotels: 0, floors: 0, rooms: 0, doors: 0, staticTris: 0, staticTrisInterior: 0, kitTrisPerRoom: 0, floorWallTris: 0,
		staticShapes: 0, lazyShapesPerFloor: 0, lightSpots: 0, drawCallsOutside: 0, drawCallsInside: 0, gpuBytes: 0,
	};

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
	}

	public build(): void
	{
		const ctx = this.ctx;
		this.ensureMaterials();
		const shapes0 = ctx.bphys.shapeCount, lights0 = ctx.lightSpots.length;
		for (let i = 0; i < ctx.data.buildings.length; i++)
		{
			const b = ctx.data.buildings[i];
			if (b.custom !== 'hotel' || b.role !== 'hotel' || !(b as any).hotel) continue;
			this.S = new AccumSet();
			this.signAcc = new GeoAccum();
			const h = this.layout(b);
			this.exterior(h);
			this.slabs(h);
			this.core(h);
			this.lobby(h);
			this.guestStatics(h);
			this.roomKit(h);
			this.roomAnchors(h, this.hotels.length);
			this.floorWalls(h);
			this.flush(h);
			this.makeInstanced(h);
			this.hotels.push(h);
			this.stats.hotels++;
			this.stats.floors += h.N;
			this.stats.rooms += h.rooms;
		}
		this.stats.staticShapes = ctx.bphys.shapeCount - shapes0;
		this.stats.lightSpots = ctx.lightSpots.length - lights0;
		this.stats.doors = this.doorQueue.length;
		if (this.hotels.length)
		{
			this.runtime = new HotelRuntime(ctx, this.hotels, this.doorQueue);
			this.runtime.flushDoors();
			const w: any = ctx.world;
			if (w && typeof w.registerUpdatable === 'function') w.registerUpdatable(this.runtime);
			w.realismHotels = this;
		}
		console.log('[Realism] Hotels', this.hotels.map((h) => h.name + ' (' + h.N + ' floors, ' + h.rooms + ' rooms)').join(', '), this.stats);
	}

	// -----------------------------------------------------------------------
	// materials

	private ensureMaterials(): void
	{
		const ctx = this.ctx, mats = ctx.mats;
		if (!mats.hotelGlass)
		{
			const m = new THREE.MeshPhongMaterial({ vertexColors: THREE.VertexColors, transparent: true, opacity: 0.58, shininess: 110, specular: 0xaaaaaa, depthWrite: false });
			try { ctx.world.sky.csm.setupMaterial(m); } catch (e) { /* headless */ }
			m.name = 'hotelGlass';
			mats.hotelGlass = m;
		}
		if (!mats.hotelDigits)
		{
			const tex = canvasTexture(1024, (g, s) =>
			{
				g.clearRect(0, 0, s, 64);
				g.fillStyle = '#ffffff';
				g.font = 'bold 54px Arial, Helvetica, sans-serif';
				g.textAlign = 'center'; g.textBaseline = 'middle';
				const chars = '0123456789L';
				for (let i = 0; i < chars.length; i++) g.fillText(chars.charAt(i), i * 64 + 32, 34);
			}, 64);
			tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
			const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.45, vertexColors: THREE.VertexColors });
			m.name = 'hotelDigits';
			mats.hotelDigits = m;
		}
	}

	private X: Acc = (m: string) => this.S.get(m + '|building');   // exterior + slabs (drawn with the building)
	private I: Acc = (m: string) => this.S.get(m + '|interior');   // stairwell, core, lobby (interior distance)

	// -----------------------------------------------------------------------
	// layout

	private layout(b: Building): Hotel
	{
		const def = (b as any).hotel;
		const N = Math.max(3, Math.min(20, def.floors | 0));
		const f = new Frame(b.x, 0, b.z, b.rot);
		const w = b.w, d = b.d;
		const ix0 = -w / 2 + T, ix1 = w / 2 - T, iz0 = -d / 2 + T, iz1 = d / 2 - T;
		const sx1 = ix0 + SW, rx0 = sx1 + HT;
		const n = Math.max(2, Math.floor((ix1 - rx0) / 3.9));
		const RW = (ix1 - rx0) / n;
		const floorY = b.groundY + 0.18;
		const Y: number[] = [floorY];
		for (let k = 1; k <= N; k++) Y.push(floorY + LOBBY_H + (k - 1) * FLOOR_H);
		const roomsX: number[] = [];
		for (let i = 0; i < n; i++) roomsX.push(rx0 + (i + 0.5) * RW);
		const zA = -(HH + HT) - LAND, zB = zA - RUN;
		const pal = PALETTES[(def.pal | 0) % PALETTES.length];
		return {
			b: b, name: def.name, slug: slugOf(def.name), N: N, pal: pal, f: f, w: w, d: d,
			ix0: ix0, ix1: ix1, iz0: iz0, iz1: iz1, sx1: sx1, rx0: rx0, RW: RW, n: n,
			ex: -RW / 2 + 0.06 + 0.15 + 0.45, xe: (rx0 + ix1) / 2,
			Y: Y, floorY: floorY, top: Y[N] + PARAPET, zA: zA, zB: zB, roomsX: roomsX,
			kitParts: [], wallParts: [], kitMeshes: [], wallMeshes: [], floorShapes: [], bodies: [], key: '',
			rooms: (N - 1) * n * 2,
		};
	}

	// -----------------------------------------------------------------------
	// small helpers

	/** Faces of a wall plane in frame `fr` at local z, spanning local x [x0,x1] and world y [y0,y1], minus openings (local x / world y). */
	private band(acc: GeoAccum, fr: Frame, x0: number, x1: number, y0: number, y1: number, ops: Opening[], z: number, facing: number, col: number[]): void
	{
		const L = x1 - x0, H = y1 - y0;
		if (L <= 0.01 || H <= 0.01) return;
		const local: Opening[] = [];
		for (let i = 0; i < ops.length; i++)
		{
			const o = ops[i];
			if (o.u1 <= x0 || o.u0 >= x1 || o.v1 <= y0 || o.v0 >= y1) continue;
			local.push({ u0: o.u0 - x0, u1: o.u1 - x0, v0: o.v0 - y0, v1: o.v1 - y0 });
		}
		const pieces = local.length ? wallPieces(L, H, local) : [{ u0: 0, u1: L, v0: 0, v1: H }];
		const nn = fr.n(0, 0, facing);
		for (let i = 0; i < pieces.length; i++)
		{
			const p = pieces[i];
			const xa = x0 + p.u0, xb = x0 + p.u1, ya = y0 + p.v0, yb = y0 + p.v1;
			acc.face([fr.p(xa, ya, z), fr.p(xb, ya, z), fr.p(xb, yb, z), fr.p(xa, yb, z)], nn, Z4, col);
		}
	}

	/** Reveal faces of an opening through a wall between local z0 and z1. */
	private jambs(acc: GeoAccum, fr: Frame, o: Opening, z0: number, z1: number, col: number[], bottom: boolean): void
	{
		const xa = o.u0, xb = o.u1, ya = o.v0, yb = o.v1;
		acc.face([fr.p(xa, ya, z0), fr.p(xa, ya, z1), fr.p(xa, yb, z1), fr.p(xa, yb, z0)], fr.n(1, 0, 0), Z4, col);
		acc.face([fr.p(xb, ya, z1), fr.p(xb, ya, z0), fr.p(xb, yb, z0), fr.p(xb, yb, z1)], fr.n(-1, 0, 0), Z4, col);
		acc.face([fr.p(xa, yb, z0), fr.p(xb, yb, z0), fr.p(xb, yb, z1), fr.p(xa, yb, z1)], [0, -1, 0], Z4, col);
		if (bottom) acc.face([fr.p(xa, ya, z1), fr.p(xb, ya, z1), fr.p(xb, ya, z0), fr.p(xa, ya, z0)], [0, 1, 0], Z4, col);
	}

	/** Horizontal rectangle at height y in frame fr. */
	private flat(acc: GeoAccum, fr: Frame, x0: number, z0: number, x1: number, z1: number, y: number, up: boolean, col: number[], uvScale?: number): void
	{
		const u = uvScale || 0;
		const uv = u > 0 ? [[x0 * u, z0 * u], [x1 * u, z0 * u], [x1 * u, z1 * u], [x0 * u, z1 * u]] : Z4;
		acc.face([fr.p(x0, y, z0), fr.p(x1, y, z0), fr.p(x1, y, z1), fr.p(x0, y, z1)], [0, up ? 1 : -1, 0], uv, col);
	}

	/** Static collider from a frame-local centre. */
	private pbox(fr: Frame, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, extraRot?: number, tilt?: number): void
	{
		const p = fr.p(cx, cy, cz);
		this.ctx.bphys.box(p[0], p[1], p[2], hx, hy, hz, fr.rot + (extraRot || 0), tilt);
	}

	/** Collider by local min / max corners (axis aligned in frame fr). */
	private pminmax(fr: Frame, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void
	{
		this.pbox(fr, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2);
	}

	/** Flat sign panel with the hotel name (facing local +z when facing = 1). */
	private sign(fr: Frame, cx: number, cy: number, cz: number, width: number, facing: number): void
	{
		const h = width * (128 / 1024);
		const x0 = cx - width / 2 * facing, x1 = cx + width / 2 * facing;
		this.signAcc.face([fr.p(x0, cy - h / 2, cz), fr.p(x1, cy - h / 2, cz), fr.p(x1, cy + h / 2, cz), fr.p(x0, cy + h / 2, cz)], fr.n(0, 0, facing), [[0, 0], [1, 0], [1, 1], [0, 1]], [1, 1, 1]);
	}

	/** Digits / 'L' from the shared atlas, centred at (cx, cy) on local z, facing +z. */
	private text(acc: GeoAccum, fr: Frame, str: string, cx: number, cy: number, z: number, ch: number): void
	{
		const cw = ch * 0.72;
		const total = str.length * cw;
		const chars = '0123456789L';
		for (let i = 0; i < str.length; i++)
		{
			const idx = chars.indexOf(str.charAt(i));
			if (idx < 0) continue;
			const x0 = cx - total / 2 + i * cw, x1 = x0 + cw;
			const u0 = idx * 64 / 1024 + 0.004, u1 = (idx + 1) * 64 / 1024 - 0.004;
			acc.face([fr.p(x0, cy - ch / 2, z), fr.p(x1, cy - ch / 2, z), fr.p(x1, cy + ch / 2, z), fr.p(x0, cy + ch / 2, z)], fr.n(0, 0, 1), [[u0, 0], [u1, 0], [u1, 1], [u0, 1]], [1, 1, 1]);
		}
	}

	private addDoor(spec: DoorSpec): void
	{
		this.doorQueue.push(spec);
	}

	// -----------------------------------------------------------------------
	// exterior

	private exterior(h: Hotel): void
	{
		const b = h.b, f = h.f, w = h.w, d = h.d, P = h.pal;
		const y0 = b.baseY, top = h.top, Y = h.Y, N = h.N;
		const podTop = Y[1] - SLAB;
		const wallA = this.X('plain'), glass = this.X('hotelGlass'), glow = this.X('lampGlow');
		const sides = [
			{ fr: f.sub(0, 0, d / 2, 0), len: w },
			{ fr: f.sub(w / 2, 0, 0, Math.PI / 2), len: d },
			{ fr: f.sub(0, 0, -d / 2, Math.PI), len: w },
			{ fr: f.sub(-w / 2, 0, 0, -Math.PI / 2), len: d },
		];
		const wins: Opening[][] = [[], [], [], []];     // windows (glass)
		const doors: Opening[][] = [[], [], [], []];    // open holes (entrance)
		// front: room windows + lobby storefront + entrance
		for (let k = 1; k < N; k++)
			for (let i = 0; i < h.n; i++) wins[0].push({ u0: h.roomsX[i] - WIN_W / 2, u1: h.roomsX[i] + WIN_W / 2, v0: Y[k] + WIN_V0, v1: Y[k] + WIN_V1 });
		const xe = h.xe;
		doors[0].push({ u0: xe - 1.3, u1: xe + 1.3, v0: h.floorY - 0.02, v1: h.floorY + 2.8 });
		const sv0 = h.floorY + 0.5, sv1 = h.floorY + 3.3;
		if (xe - 1.8 - (h.rx0 + 0.6) > 0.8) wins[0].push({ u0: h.rx0 + 0.6, u1: xe - 1.8, v0: sv0, v1: sv1 });
		if (h.ix1 - 0.6 - (xe + 1.8) > 0.8) wins[0].push({ u0: xe + 1.8, u1: h.ix1 - 0.6, v0: sv0, v1: sv1 });
		wins[0].push({ u0: xe - 1.3, u1: xe + 1.3, v0: h.floorY + 2.95, v1: sv1 });
		// back: room windows (back local x = -building x), stair windows, two lobby windows
		for (let k = 1; k < N; k++)
			for (let i = 0; i < h.n; i++) wins[2].push({ u0: -h.roomsX[i] - WIN_W / 2, u1: -h.roomsX[i] + WIN_W / 2, v0: Y[k] + WIN_V0, v1: Y[k] + WIN_V1 });
		const stairX = -(h.ix0 + SW / 2);
		for (let k = 0; k < N - 1; k++)
		{
			const ym = Y[k] + (Y[k + 1] - Y[k]) / 2;
			wins[2].push({ u0: stairX - 0.6, u1: stairX + 0.6, v0: ym + 0.45, v1: ym + 1.35 });
		}
		const lobbyWins = [h.rx0 + 2.5, h.ix1 - 2.5];
		for (let i = 0; i < lobbyWins.length; i++)
			if (Math.abs(lobbyWins[i] - xe) > 3.4) wins[2].push({ u0: -lobbyWins[i] - 1.0, u1: -lobbyWins[i] + 1.0, v0: h.floorY + 0.9, v1: h.floorY + 3.0 });
		// right end: hallway window on every guest floor + a lobby window (right local x = -building z)
		for (let k = 1; k < N; k++) wins[1].push({ u0: -0.6, u1: 0.6, v0: Y[k] + 0.9, v1: Y[k] + 2.5 });
		wins[1].push({ u0: -1.5, u1: 1.5, v0: h.floorY + 0.6, v1: h.floorY + 3.2 });

		for (let si = 0; si < 4; si++)
		{
			const s = sides[si], fr = s.fr, L = s.len;
			const holes = wins[si].concat(doors[si]);
			// outer face: podium + tower
			this.band(wallA, fr, -L / 2, L / 2, y0, podTop, holes, 0, 1, P.podium);
			this.band(wallA, fr, -L / 2, L / 2, podTop, top, holes, 0, 1, P.facade);
			// inner face
			this.band(wallA, fr, -L / 2 + T, L / 2 - T, h.floorY, top, holes, -T, -1, P.roomWall);
			for (let k = 0; k < holes.length; k++) this.jambs(wallA, fr, holes[k], 0, -T, P.trim, true);
			for (let k = 0; k < wins[si].length; k++)
			{
				const o = wins[si][k];
				const gz = -T * 0.45;
				glass.face([fr.p(o.u0, o.v0, gz), fr.p(o.u1, o.v0, gz), fr.p(o.u1, o.v1, gz), fr.p(o.u0, o.v1, gz)], fr.n(0, 0, 1), Z4, GLASS);
				glass.face([fr.p(o.u1, o.v0, gz), fr.p(o.u0, o.v0, gz), fr.p(o.u0, o.v1, gz), fr.p(o.u1, o.v1, gz)], fr.n(0, 0, -1), Z4, GLASS);
				box(wallA, fr, o.u0 - 0.04, o.v0 - 0.07, -0.02, o.u1 + 0.04, o.v0, 0.07, P.trim, 'b');
				if (o.u1 - o.u0 > 2.5) for (let u = o.u0 + 1.6; u < o.u1 - 0.5; u += 1.6) box(wallA, fr, u - 0.04, o.v0, gz - 0.04, u + 0.04, o.v1, gz + 0.04, P.trim);
			}
			// floor ledges, corner pilasters, cornice, coping
			for (let k = 1; k <= N; k++) box(wallA, fr, -L / 2 - 0.1, Y[k] - SLAB, 0, L / 2 + 0.1, Y[k] - SLAB + 0.16, 0.1, k === 1 ? P.accent : mul(P.facade, 0.88));
			box(wallA, fr, -L / 2 - 0.12, y0, 0, -L / 2 + 0.55, top, 0.14, mul(P.facade, 0.92), 'b');
			box(wallA, fr, L / 2 - 0.55, y0, 0, L / 2 + 0.12, top, 0.14, mul(P.facade, 0.92), 'b');
			box(wallA, fr, -L / 2 - 0.3, top - 0.55, 0, L / 2 + 0.3, top - 0.1, 0.3, mul(P.facade, 0.82));
			box(wallA, fr, -L / 2, top, -T, L / 2, top + 0.1, 0.04, mul(P.facade, 0.75), 'b');
			// colliders: full-height wall, door holes left open
			const H = top - y0;
			const pieces = wallPieces(L, H, doors[si].map((o) => ({ u0: o.u0 + L / 2, u1: o.u1 + L / 2, v0: o.v0 - y0, v1: o.v1 - y0 })));
			for (let k = 0; k < pieces.length; k++)
			{
				const pc = pieces[k];
				this.pbox(fr, -L / 2 + (pc.u0 + pc.u1) / 2, y0 + (pc.v0 + pc.v1) / 2, -T / 2, (pc.u1 - pc.u0) / 2, (pc.v1 - pc.v0) / 2, T / 2);
			}
		}
		// roof surface + rooftop gear
		const roofY = Y[N];
		this.flat(wallA, f, h.ix0, h.iz0, h.ix1, h.iz1, roofY, true, [0.3, 0.3, 0.31]);
		box(wallA, f, h.ix0, roofY, -3.2, h.rx0 + 2.2, roofY + 3.2, 3.2, mul(P.facade, 0.8), 'b');       // elevator machine room
		box(wallA, f, h.ix0 + 0.6, roofY + 3.2, -1.2, h.ix0 + 2.2, roofY + 3.5, 1.2, DARK, 'b');
		for (let k = 0; k < 3; k++)
		{
			const ax = h.rx0 + 5 + k * 3.2;
			if (ax > h.ix1 - 2) break;
			box(wallA, f, ax - 1.1, roofY, h.iz0 + 1.5, ax + 1.1, roofY + 1.4, h.iz0 + 3.3, [0.7, 0.71, 0.72], 'b');
			box(wallA, f, ax - 0.7, roofY + 1.4, h.iz0 + 1.9, ax + 0.7, roofY + 1.45, h.iz0 + 2.9, DARK, 'b');
		}
		cyl(wallA, f, h.ix1 - 2.5, roofY, -1.5, 3.4, 1.4, 1.4, 10, [0.55, 0.5, 0.45], true);
		cyl(wallA, f, h.ix1 - 1.2, roofY, h.iz0 + 1.2, 9, 0.06, 0.03, 4, STEEL);
		box(this.X('signalRed'), f, h.ix1 - 1.3, roofY + 9, h.iz0 + 1.1, h.ix1 - 1.1, roofY + 9.25, h.iz0 + 1.3, [1, 1, 1]);
		this.ctx.bphys.box(b.x, roofY - SLAB / 2, b.z, w / 2, SLAB / 2, d / 2, b.rot);
		// rooftop name sign (two sided) on a steel frame near the front parapet
		const sw = Math.min(w * 0.82, 24), sh = sw * 128 / 1024;
		const sz = h.iz1 - 0.6, sy = top + 0.6 + sh / 2;
		this.sign(f, 0, sy, sz + 0.01, sw, 1);
		this.sign(f, 0, sy, sz - 0.17, sw, -1);
		box(wallA, f, -sw / 2 - 0.12, sy - sh / 2 - 0.12, sz - 0.16, sw / 2 + 0.12, sy + sh / 2 + 0.12, sz, DARK);
		for (let k = -1; k <= 1; k++) box(wallA, f, k * sw / 3 - 0.1, roofY, sz - 0.3, k * sw / 3 + 0.1, sy - sh / 2, sz - 0.1, STEEL, 'b');
		// canopy over the entrance
		const fy = h.floorY;
		const gF = f.p(xe, 0, d / 2 + 3);
		const yg = this.ctx.data.heightAt(gF[0], gF[2]);
		const cz0 = d / 2, cz1 = d / 2 + 4.2;
		box(wallA, f, xe - 3.4, fy + 3.2, cz0, xe + 3.4, fy + 3.5, cz1, P.accent);
		box(wallA, f, xe - 3.45, fy + 3.5, cz1 - 0.08, xe + 3.45, fy + 3.62, cz1 + 0.02, P.trim);
		this.sign(f, xe, fy + 3.5 + 0.38, cz1 + 0.03, 5.6, 1);
		box(wallA, f, xe - 2.85, fy + 3.48, cz1 - 0.06, xe + 2.85, fy + 4.2, cz1 + 0.01, DARK, 'b');
		for (let s = -1; s <= 1; s += 2)
		{
			cyl(wallA, f, xe + s * 3.05, yg - 0.2, cz1 - 0.35, fy + 3.2 - yg + 0.2, 0.13, 0.13, 10, P.trim);
			this.pbox(f, xe + s * 3.05, (yg + fy + 3.2) / 2, cz1 - 0.35, 0.13, (fy + 3.2 - yg) / 2 + 0.1, 0.13);
		}
		for (let k = 0; k < 4; k++) box(glow, f, xe - 2.4 + k * 1.6 - 0.2, fy + 3.18, cz0 + 1.6, xe - 2.4 + k * 1.6 + 0.2, fy + 3.2, cz0 + 2.0, [1, 1, 1], 't');
		const lp = f.p(xe, fy + 3.0, cz0 + 2.2);
		this.ctx.lightSpots.push({ x: lp[0], y: lp[1], z: lp[2], color: 0xffe2b0, range: 10, night: true });
		// entrance steps: ramp collider from the pavement up to the lobby floor
		const rise = fy - yg;
		if (rise > 0.04)
		{
			const sx0 = xe - 3.2, sx1 = xe + 3.2, run = Math.max(1.6, rise / 0.3);
			const ns = Math.max(1, Math.ceil(rise / 0.16));
			for (let k = 0; k < ns; k++)
			{
				const zt0 = d / 2 + run * k / ns, ztop = fy - rise * k / ns;
				box(wallA, f, sx0, yg - 0.3, zt0, sx1, ztop, d / 2 + run * (k + 1) / ns, k % 2 ? mul(P.podium, 1.1) : P.podium, 'b');
			}
			this.ramp(f, (sx0 + sx1) / 2, (sx1 - sx0) / 2, d / 2 + run, yg, d / 2, fy, null);
		}
	}

	/**
	 * Walkable ramp collider whose TOP face runs exactly from (zStart, yStart) to (zEnd, yEnd)
	 * in frame fr (centre x, half width hw). tiltX > 0 lowers the box's local +Z end, so a
	 * flight climbing towards -z (low end at +z) gets a positive tilt; one climbing towards +z
	 * a negative tilt. Verified numerically by raycasting the committed bodies (see test notes).
	 */
	private ramp(fr: Frame, x: number, hw: number, zStart: number, yStart: number, zEnd: number, yEnd: number, log: FlightLog): void
	{
		const dz = zEnd - zStart, dy = yEnd - yStart;
		const tilt = -Math.atan(dy / dz);
		const L = Math.sqrt(dz * dz + dy * dy);
		const th = 0.1;
		// top-face normal of a box tilted by `tilt` about local X: (0, cos, sin)
		const cy = (yStart + yEnd) / 2 - th * Math.cos(tilt);
		const cz = (zStart + zEnd) / 2 - th * Math.sin(tilt);
		this.pbox(fr, x, cy, cz, hw, th, L / 2, 0, tilt);
		if (log) this.flights.push(log);
	}

	// -----------------------------------------------------------------------
	// slabs (floors / ceilings), drawn with the building so the windows never show a hollow tower

	private slabs(h: Hotel): void
	{
		const f = h.f, b = h.b, P = h.pal, Y = h.Y, N = h.N;
		const A = this.X('plain'), F = this.X('floor');
		const { ix0, ix1, iz0, iz1, sx1, rx0, zA } = h;
		// ground floor
		this.flat(F, f, ix0, iz0, ix1, iz1, h.floorY, true, [0.86, 0.84, 0.8], 0.25);
		this.ctx.bphys.box(b.x, (b.baseY + h.floorY) / 2, b.z, h.w / 2, Math.max(0.05, (h.floorY - b.baseY) / 2), h.d / 2, b.rot);
		for (let k = 1; k <= N; k++)
		{
			const y = Y[k], yb = y - SLAB;
			if (k < N)
			{
				this.flat(A, f, ix0, -HH, ix1, HH, y, true, P.hallCarpet);
				this.flat(A, f, rx0, HH, ix1, iz1, y, true, P.roomCarpet);
				this.flat(A, f, rx0, iz0, ix1, -HH, y, true, P.roomCarpet);
				this.flat(A, f, ix0, zA, sx1, -HH, y, true, CONCRETE);
				A.face([f.p(ix0, yb, zA), f.p(sx1, yb, zA), f.p(sx1, y, zA), f.p(ix0, y, zA)], f.n(0, 0, -1), Z4, mul(CONCRETE, 0.9));
				this.pminmax(f, sx1, yb, iz0, ix1, y, iz1);
				this.pminmax(f, ix0, yb, zA, sx1, y, iz1);
			}
			// ceilings of the floor below
			this.flat(A, f, sx1, iz0, ix1, iz1, yb, false, CEILING);
			this.flat(A, f, ix0, zA, sx1, iz1, yb, false, CEILING);
			if (k === N) this.flat(A, f, ix0, iz0, sx1, zA, yb, false, CEILING);
		}
	}

	// -----------------------------------------------------------------------
	// core: stairwell, elevators, core walls

	private core(h: Hotel): void
	{
		const ctx = this.ctx, f = h.f, P = h.pal, Y = h.Y, N = h.N;
		const A = this.I('plain'), S = this.I('shiny'), G = this.I('lampGlow'), D = this.I('hotelDigits'), GR = this.I('signalGreen');
		const { ix0, iz0, iz1, sx1, rx0, zA, zB } = h;
		const yTop = Y[N] - SLAB;
		// stair side wall (x sx1..rx0, z iz0..-(HH+HT))
		const zw = -(HH + HT);
		A.face([f.p(sx1, h.floorY, zw), f.p(sx1, h.floorY, iz0), f.p(sx1, yTop, iz0), f.p(sx1, yTop, zw)], f.n(-1, 0, 0), Z4, CONCRETE);
		A.face([f.p(rx0, h.floorY, iz0), f.p(rx0, h.floorY, zw), f.p(rx0, yTop, zw), f.p(rx0, yTop, iz0)], f.n(1, 0, 0), Z4, P.roomWall);
		this.pminmax(f, sx1, h.floorY, iz0, rx0, yTop, zw);
		// stair hall wall (z -(HH+HT)..-HH, x ix0..rx0) with a door on every level
		const dxc = ix0 + SW / 2, dw = 0.95;
		const ops: Opening[] = [];
		for (let k = 0; k < N; k++) ops.push({ u0: dxc - dw / 2, u1: dxc + dw / 2, v0: Y[k], v1: Y[k] + DOOR_H });
		this.band(A, f, ix0, rx0, h.floorY, yTop, ops, -HH, 1, P.hallWall);
		this.band(A, f, ix0, rx0, h.floorY, yTop, ops, zw, -1, CONCRETE);
		for (let k = 0; k < N; k++)
		{
			const o = ops[k];
			this.jambs(A, f, o, zw, -HH, P.trim, false);
			// casing on the hall side + exit sign
			box(A, f, o.u0 - 0.08, o.v0, -HH, o.u0, o.v1 + 0.08, -HH + 0.03, P.trim, 'b');
			box(A, f, o.u1, o.v0, -HH, o.u1 + 0.08, o.v1 + 0.08, -HH + 0.03, P.trim, 'b');
			box(A, f, o.u0, o.v1, -HH, o.u1, o.v1 + 0.08, -HH + 0.03, P.trim);
			box(GR, f, dxc - 0.18, o.v1 + 0.18, -HH, dxc + 0.18, o.v1 + 0.32, -HH + 0.05, [1, 1, 1]);
			const ch = (k === 0 ? LOBBY_H : FLOOR_H) - SLAB;
			this.pminmax(f, ix0, Y[k], zw, o.u0, Y[k] + ch, -HH);
			this.pminmax(f, o.u1, Y[k], zw, rx0, Y[k] + ch, -HH);
			// door (swings into the stairwell): hinge at the -x jamb, closed panel along +x
			const hp = f.p(o.u0, Y[k], -(HH + HT / 2));
			this.addDoor({ kind: 'hinged', x: hp[0], y: hp[1], z: hp[2], rot: f.rot, width: dw, height: DOOR_H, thickness: 0.05, color: 0x8a9096, locked: false, openAngle: Math.PI / 2, group: 'hotel:' + h.slug + ':stairs' });
		}
		// elevator block (x ix0..rx0, z HH..iz1): hall face with two elevators per level
		A.face([f.p(rx0, h.floorY, HH), f.p(ix0, h.floorY, HH), f.p(ix0, yTop, HH), f.p(rx0, yTop, HH)], f.n(0, 0, -1), Z4, P.hallWall);
		A.face([f.p(rx0, h.floorY, iz1), f.p(rx0, h.floorY, HH), f.p(rx0, yTop, HH), f.p(rx0, yTop, iz1)], f.n(1, 0, 0), Z4, P.roomWall);
		this.pminmax(f, ix0, h.floorY, HH, rx0, yTop, iz1);
		const ecs = [ix0 + 0.7, ix0 + 2.15];
		for (let k = 0; k < N; k++)
		{
			const y = Y[k];
			for (let e = 0; e < 2; e++)
			{
				const c = ecs[e];
				box(S, f, c - 0.55, y, HH - 0.04, c + 0.55, y + 2.3, HH, [0.55, 0.56, 0.58], 'b');
				box(S, f, c - 0.47, y, HH - 0.07, c - 0.008, y + 2.2, HH - 0.04, STEEL, 'b');
				box(S, f, c + 0.008, y, HH - 0.07, c + 0.47, y + 2.2, HH - 0.04, STEEL, 'b');
				box(G, f, c - 0.2, y + 2.38, HH - 0.05, c + 0.2, y + 2.48, HH, [1, 0.85, 0.6]);
			}
			const pc = ix0 + 1.425;
			box(S, f, pc - 0.07, y + 1.0, HH - 0.03, pc + 0.07, y + 1.32, HH, [0.5, 0.5, 0.52]);
			box(G, f, pc - 0.03, y + 1.08, HH - 0.045, pc + 0.03, y + 1.13, HH - 0.03, [1, 1, 1]);
			box(G, f, pc - 0.03, y + 1.18, HH - 0.045, pc + 0.03, y + 1.23, HH - 0.03, [1, 1, 1]);
			const pf = f.sub(pc, y + 1.7, HH - 0.03, Math.PI);
			box(A, pf, -0.17, -0.13, -0.012, 0.17, 0.13, 0, DARK);
			this.text(D, pf, k === 0 ? 'L' : '' + k, 0, 0, 0.003, 0.16);
		}
		// centre wall between the flights (full height, flight zone only)
		box(A, f, ix0 + LANE, h.floorY, zB, ix0 + LANE + CWALL, yTop, zA, CONCRETE);
		this.pminmax(f, ix0 + LANE, h.floorY, zB, ix0 + LANE + CWALL, yTop, zA);
		// flights + mid landings
		const xL0 = ix0, xL1 = ix0 + LANE, xR0 = ix0 + LANE + CWALL, xR1 = sx1;
		for (let k = 0; k < N - 1; k++)
		{
			const y = Y[k], H = Y[k + 1] - Y[k], rise = H / 2;
			this.flight(h, A, k, 'A', xL0, xL1, zA, y, zB, y + rise);
			this.flight(h, A, k, 'B', xR0, xR1, zB, y + rise, zA, Y[k + 1]);
			box(A, f, ix0, y + rise - 0.2, iz0, sx1, y + rise, zB, mul(CONCRETE, 1.05));
			this.pminmax(f, ix0, y + rise - 0.2, iz0, sx1, y + rise, zB);
			const lp = f.p((ix0 + sx1) / 2, y + rise + 2.3, (iz0 + zB) / 2);
			ctx.lightSpots.push({ x: lp[0], y: lp[1], z: lp[2], color: 0xf2f4ff, range: 6, night: false });
		}
		// ground floor: close the space under flight B; top floor: guard rail where flight A would continue
		box(A, f, xR0, h.floorY, zA - 0.12, xR1, h.floorY + 2.0, zA, CONCRETE);
		this.pminmax(f, xR0, h.floorY, zA - 0.12, xR1, h.floorY + 2.0, zA);
		const yt = Y[N - 1];
		box(A, f, xL0, yt, zA - 0.08, xL1, yt + 1.1, zA, STEEL);
		this.pminmax(f, xL0, yt, zA - 0.08, xL1, yt + 1.1, zA);
	}

	/** One stair flight: visual steps, soffit, handrail and its ramp collider. */
	private flight(h: Hotel, A: GeoAccum, level: number, lane: string, x0: number, x1: number, zS: number, yS: number, zE: number, yE: number): void
	{
		const f = h.f;
		const rise = yE - yS;
		const n = Math.max(6, Math.round(rise / 0.175));
		const sh = rise / n;
		for (let i = 0; i < n; i++)
		{
			const za = zS + (zE - zS) * i / n, zb = zS + (zE - zS) * (i + 1) / n;
			const yt = yS + sh * (i + 1);
			box(A, f, x0, yt - sh - 0.16, Math.min(za, zb), x1, yt, Math.max(za, zb), i % 2 ? [0.6, 0.6, 0.58] : [0.64, 0.64, 0.62], 'b');
		}
		// soffit (underside)
		A.face([f.p(x0, yS - 0.18, zS), f.p(x1, yS - 0.18, zS), f.p(x1, yE - 0.18, zE), f.p(x0, yE - 0.18, zE)], [0, -1, 0], Z4, mul(CONCRETE, 0.85));
		// handrail on the outer wall side
		const rx = lane === 'A' ? x0 + 0.05 : x1 - 0.05;
		const r0 = rx - 0.03, r1 = rx + 0.03, hr = 0.9;
		A.face([f.p(r0, yS + hr + 0.05, zS), f.p(r1, yS + hr + 0.05, zS), f.p(r1, yE + hr + 0.05, zE), f.p(r0, yE + hr + 0.05, zE)], [0, 1, 0], Z4, STEEL);
		A.face([f.p(r0, yS + hr, zS), f.p(r0, yS + hr + 0.05, zS), f.p(r0, yE + hr + 0.05, zE), f.p(r0, yE + hr, zE)], f.n(-1, 0, 0), Z4, STEEL);
		A.face([f.p(r1, yS + hr + 0.05, zS), f.p(r1, yS + hr, zS), f.p(r1, yE + hr, zE), f.p(r1, yE + hr + 0.05, zE)], f.n(1, 0, 0), Z4, STEEL);
		this.ramp(f, (x0 + x1) / 2, (x1 - x0) / 2, zS, yS, zE, yE, { hotel: h.name, level: level, lane: lane, f: f, x: (x0 + x1) / 2, zStart: zS, yStart: yS, zEnd: zE, yEnd: yE });
	}

	// -----------------------------------------------------------------------
	// lobby

	private lobby(h: Hotel): void
	{
		const ctx = this.ctx, f = h.f, P = h.pal, y = h.floorY;
		const A: Acc = this.I;
		const lf = new Frame(f.x, y, f.z, f.rot);       // lobby frame at floor height
		const { ix1, iz0, iz1, rx0, xe } = h;
		const LW = ix1 - rx0;
		// front desk against the back wall
		const L = Math.min(4.2, LW * 0.32);
		const dz = iz0 + 2.0;
		const df = lf.sub(xe, 0, dz, 0);
		box(A('plain'), df, -L / 2, 0, -0.45, L / 2, 1.0, 0.45, P.wood, 'b');
		box(A('shiny'), df, -L / 2 - 0.05, 1.0, 0.05, L / 2 + 0.05, 1.06, 0.6, [0.82, 0.8, 0.76]);
		box(A('plain'), df, -L / 2 + 0.05, 0.72, -0.75, L / 2 - 0.05, 0.76, -0.45, P.wood);
		box(A('lampGlow'), df, -L / 2 + 0.1, 0.08, 0.451, L / 2 - 0.1, 0.12, 0.46, [1, 0.88, 0.6]);
		box(A('plain'), df, -L / 2 + 0.1, 0.25, 0.452, L / 2 - 0.1, 0.85, 0.47, P.accent);
		for (let k = -1; k <= 1; k += 2)
		{
			box(A('shiny'), df, k * L / 4 - 0.25, 0.8, -0.62, k * L / 4 + 0.25, 1.12, -0.6, DARK);
			box(A('plain'), df, k * L / 4 - 0.03, 0.76, -0.6, k * L / 4 + 0.03, 0.8, -0.56, DARK);
			this.chair(A, df.sub(k * L / 4, 0, -1.05, 0), DARK);
		}
		cyl(A('shiny'), df, 0.4, 1.06, 0.4, 0.06, 0.06, 0.01, 8, [0.85, 0.7, 0.3]);
		this.pbox(df, 0, 0.55, 0, L / 2 + 0.05, 0.55, 0.6);
		// feature wall + name sign behind the desk
		box(A('plain'), lf, xe - L / 2 - 0.6, 0.0, iz0, xe + L / 2 + 0.6, 3.5, iz0 + 0.08, mul(P.wood, 0.85), 'b');
		box(A('plain'), lf, xe - L / 2 - 0.4, 2.0, iz0 + 0.08, xe + L / 2 + 0.4, 2.9, iz0 + 0.1, DARK);
		this.sign(lf, xe, 2.45, iz0 + 0.105, L + 0.6, 1);
		// seating group right of the entrance
		const gx = (xe + 2.6 + ix1) / 2, gz = iz1 - 3.6;
		if (ix1 - (xe + 2.6) > 4.4)
		{
			this.rug(A, lf, gx, gz, 3.4, 4.2, mul(P.sofa, 0.7));
			this.sofa(A, lf.sub(gx, 0, gz - 1.45, 0), P.sofa, true);
			this.sofa(A, lf.sub(gx, 0, gz + 1.45, Math.PI), P.sofa, true);
			this.coffeeTable(A, lf.sub(gx, 0, gz, 0), P.wood);
			this.plant(A, lf, ix1 - 0.6, iz1 - 0.7);
		}
		// armchairs + side table left of the entrance, by the elevators
		const ax = (rx0 + xe - 2.6) / 2;
		if (xe - 2.6 - rx0 > 3.2)
		{
			this.armchair(A, lf.sub(ax - 0.7, 0, iz1 - 1.6, Math.PI * 0.85), P.sofa, true);
			this.armchair(A, lf.sub(ax + 0.7, 0, iz1 - 1.6, -Math.PI * 0.85), P.sofa, true);
			cyl(A('plain'), lf, ax, 0, iz1 - 2.1, 0.55, 0.28, 0.28, 10, P.wood, true);
			this.plant(A, lf, rx0 + 0.6, iz1 - 0.7);
		}
		// plants flanking the entrance and in the back corners, luggage cart by the desk
		this.plant(A, lf, xe - 2.0, iz1 - 0.6);
		this.plant(A, lf, xe + 2.0, iz1 - 0.6);
		this.plant(A, lf, ix1 - 0.6, iz0 + 0.6);
		if (xe + L / 2 + 2.2 < ix1 - 0.8) this.luggageCart(A, lf.sub(xe + L / 2 + 1.4, 0, dz + 0.6, 0.3));
		// pendant lights
		const ch = LOBBY_H - SLAB;
		for (let k = -1; k <= 1; k++)
		{
			const px = xe + k * Math.min(5, LW / 4);
			cyl(A('plain'), lf, px, ch - 0.9, 0, 0.9, 0.01, 0.01, 4, DARK);
			cyl(A('lampGlow'), lf, px, ch - 1.15, 0, 0.25, 0.35, 0.2, 10, [1, 0.9, 0.7], true);
			const lp = lf.p(px, ch - 1.3, 0);
			ctx.lightSpots.push({ x: lp[0], y: lp[1], z: lp[2], color: 0xffe6c0, range: 9, night: false });
		}
	}

	// -----------------------------------------------------------------------
	// guest floors: static parts that differ per floor (room numbers) + lights

	private guestStatics(h: Hotel): void
	{
		const ctx = this.ctx, f = h.f, P = h.pal, Y = h.Y;
		const A = this.I('plain'), D = this.I('hotelDigits');
		for (let k = 1; k < h.N; k++)
		{
			const ch = FLOOR_H - SLAB;
			for (let s = 0; s < 2; s++)
			{
				for (let i = 0; i < h.n; i++)
				{
					const xc = h.roomsX[i];
					const RF = f.sub(xc, Y[k], 0, s === 0 ? 0 : Math.PI);
					const num = k * 100 + this.roomIndex(h, s, i);
					// plaque on the hall side of the hall wall, hinge side of the door
					const pf = RF.sub(h.ex + 0.72, 1.5, HH - 0.002, Math.PI);
					box(A, pf, -0.15, -0.09, -0.012, 0.15, 0.09, 0, P.trim);
					this.text(D, pf, '' + num, 0, 0, 0.003, 0.1);
					// room light
					const zb = HH + HT + BD + 0.1;
					const lp = RF.p(0, ch - 0.3, (zb + h.iz1) / 2);
					ctx.lightSpots.push({ x: lp[0], y: lp[1], z: lp[2], color: 0xfff0d8, range: 6.5, night: false });
					const sink = (ctx as any).interactionSink;   // RealismRoomLights: this room's pooled light
					if (sink) sink('roomSpot', { x: lp[0], y: lp[1], z: lp[2], ry: 0, room: 1e7 + this.hotels.length * 1e5 + num }, 0, { spot: ctx.lightSpots.length - 1 });
					// doors: entry (swings into the room) + bathroom (swings out into the entry)
					const group = 'hotel:' + h.slug + ':room' + num;
					const eh = RF.p(h.ex + 0.45, 0, HH + HT / 2);
					this.addDoor({ kind: 'hinged', x: eh[0], y: eh[1], z: eh[2], rot: RF.rot + Math.PI, width: 0.9, height: DOOR_H, thickness: 0.045, color: 0x6b4a33, locked: false, openAngle: Math.PI / 2, group: group });
					const xb = h.RW / 2 - 0.06 - BW, bz1 = HH + HT + BD;
					const bh = RF.p(xb + 0.05, 0, bz1 - 0.15);
					this.addDoor({ kind: 'hinged', x: bh[0], y: bh[1], z: bh[2], rot: RF.rot + Math.PI / 2, width: 0.8, height: 2.1, thickness: 0.04, color: 0xe8e6e0, locked: false, openAngle: Math.PI / 2, group: group });
				}
			}
			// hallway lights
			for (let x = h.ix0 + 1.5; x < h.ix1 - 1; x += 7)
			{
				const lp = f.p(x, Y[k] + ch - 0.25, 0);
				ctx.lightSpots.push({ x: lp[0], y: lp[1], z: lp[2], color: 0xffe8c8, range: 6, night: false });
			}
		}
	}

	/** Room numbers run along the front side, then back along the back side. */
	private roomIndex(h: Hotel, side: number, i: number): number
	{
		return side === 0 ? i + 1 : h.n + (h.n - i);
	}

	// -----------------------------------------------------------------------
	// room kit (one geometry per hotel, instanced on the active floors)

	private roomKit(h: Hotel): void
	{
		const P = h.pal, RW = h.RW;
		const set = new AccumSet();
		const A: Acc = (m: string) => set.get(m);
		const K = new Frame(0, 0, 0, 0);
		const shapes: Shape[] = [];
		const solid = (fr: Frame, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
		{
			const c = fr.p((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
			shapes.push({ x: c[0], y: c[1], z: c[2], hx: Math.abs(x1 - x0) / 2, hy: Math.abs(y1 - y0) / 2, hz: Math.abs(z1 - z0) / 2, rot: fr.rot });
		};
		const CH = FLOOR_H - SLAB;
		const xL = -RW / 2 + 0.06, xR = RW / 2 - 0.06;
		const zr0 = HH + HT, zo = h.iz1;
		// ---- bathroom walls
		const xb = xR - BW, bz1 = zr0 + BD;
		const bx0 = xb + 0.1, bx1 = xR, bz0 = zr0;
		const wallC = P.roomWall, pl = A('plain'), sh = A('shiny'), gl = A('lampGlow');
		// W1 along x (bath side at bz1, room side at bz1 + 0.1)
		pl.face([K.p(bx1, 0, bz1), K.p(bx0, 0, bz1), K.p(bx0, CH, bz1), K.p(bx1, CH, bz1)], [0, 0, -1], Z4, TILE);
		pl.face([K.p(xb, 0, bz1 + 0.1), K.p(bx1, 0, bz1 + 0.1), K.p(bx1, CH, bz1 + 0.1), K.p(xb, CH, bz1 + 0.1)], [0, 0, 1], Z4, wallC);
		solid(K, bx0, 0, bz1, bx1, CH, bz1 + 0.1);
		// W2 along z with the bathroom door
		const dz0 = bz1 - 0.95, dz1 = bz1 - 0.15;
		const W2 = K.sub(0, 0, 0, -Math.PI / 2);      // local x = +z of the room, local +z = -x of the room
		const w2ops: Opening[] = [{ u0: dz0, u1: dz1, v0: 0, v1: 2.1 }];
		this.band(pl, W2, zr0, bz1 + 0.1, 0, CH, w2ops, -xb, 1, wallC);         // corridor face (x = xb)
		this.band(pl, W2, zr0, bz1, 0, CH, w2ops, -(xb + 0.1), -1, TILE);        // bath face (x = xb + 0.1)
		this.jambs(pl, W2, w2ops[0], -xb, -(xb + 0.1), [0.85, 0.84, 0.8], false);
		solid(K, xb, 0, zr0, xb + 0.1, CH, dz0);
		solid(K, xb, 0, dz1, xb + 0.1, CH, bz1 + 0.1);
		// door casing on the corridor side
		box(pl, K, xb - 0.03, 0, dz0 - 0.07, xb, 2.17, dz0, P.trim, 'b');
		box(pl, K, xb - 0.03, 0, dz1, xb, 2.17, dz1 + 0.07, P.trim, 'b');
		box(pl, K, xb - 0.03, 2.1, dz0, xb, 2.17, dz1, P.trim);
		// tiles over the hall wall and the divider inside the bathroom, tile floor
		pl.face([K.p(bx0, 0, bz0 + 0.004), K.p(bx1, 0, bz0 + 0.004), K.p(bx1, CH, bz0 + 0.004), K.p(bx0, CH, bz0 + 0.004)], [0, 0, 1], Z4, TILE);
		pl.face([K.p(bx1 - 0.004, 0, bz0), K.p(bx1 - 0.004, 0, bz1), K.p(bx1 - 0.004, CH, bz1), K.p(bx1 - 0.004, CH, bz0)], [-1, 0, 0], Z4, TILE);
		this.flat(pl, K, bx0, bz0, bx1, bz1, 0.012, true, [0.78, 0.79, 0.8]);
		// ---- bathtub with shower + curtain
		const tx0 = bx1 - 1.7, tz1 = bz0 + 0.76;
		box(sh, K, tx0, 0, bz0, bx1, 0.56, tz1, WHITE, 'b');
		this.flat(sh, K, tx0 + 0.08, bz0 + 0.08, bx1 - 0.08, tz1 - 0.08, 0.565, true, [0.72, 0.8, 0.84]);
		cyl(sh, K, bx1 - 0.12, 0.56, bz0 + 0.38, 0.12, 0.025, 0.025, 6, STEEL);
		box(sh, K, bx1 - 0.05, 0.9, bz0 + 0.35, bx1 - 0.01, 2.0, bz0 + 0.41, STEEL);
		box(sh, K, bx1 - 0.25, 1.96, bz0 + 0.32, bx1 - 0.02, 2.02, bz0 + 0.44, STEEL);
		box(sh, K, tx0, 2.05, tz1 - 0.02, bx1, 2.08, tz1 + 0.01, STEEL);
		box(pl, K, tx0 + 0.02, 0.6, tz1 - 0.03, tx0 + 0.55, 2.05, tz1 + 0.0, [0.86, 0.9, 0.92]);
		solid(K, tx0, 0, bz0, bx1, 0.56, tz1);
		// ---- toilet (back to the divider, facing -x)
		const zt = (tz1 + bz1 - 0.5) / 2;
		const tf = K.sub(bx1, 0, zt, -Math.PI / 2);
		box(sh, tf, -0.2, 0.42, 0.02, 0.2, 0.8, 0.2, WHITE, 'b');
		box(sh, tf, -0.19, 0, 0.18, 0.19, 0.4, 0.62, WHITE, 'b');
		box(sh, tf, -0.2, 0.4, 0.17, 0.2, 0.44, 0.66, [0.97, 0.97, 0.96]);
		box(sh, tf, -0.06, 0.8, 0.08, 0.06, 0.82, 0.12, STEEL);
		// ---- vanity (back to W1, facing into the bathroom)
		const vf = K.sub(bx1 - 0.6, 0, bz1, Math.PI);
		box(pl, vf, -0.45, 0.08, 0, 0.45, 0.82, 0.5, P.wood, 'b');
		box(sh, vf, -0.47, 0.82, 0, 0.47, 0.86, 0.52, [0.8, 0.78, 0.74]);
		box(sh, vf, -0.2, 0.8, 0.12, 0.2, 0.865, 0.42, WHITE);
		cyl(sh, vf, 0, 0.86, 0.07, 0.18, 0.02, 0.02, 6, STEEL);
		box(sh, vf, -0.42, 1.05, 0, 0.42, 1.9, 0.02, [0.78, 0.84, 0.9]);
		box(gl, vf, -0.35, 1.95, 0, 0.35, 2.01, 0.05, [1, 0.95, 0.85]);
		box(pl, vf, 0.1, 0.012, 0.6, 0.55, 0.02, 1.05, [0.85, 0.85, 0.82], 'b');       // bath mat
		solid(vf, -0.45, 0, 0, 0.45, 0.86, 0.5);
		// towel bar on W2 bath side
		box(sh, K, xb + 0.1, 1.2, bz0 + 0.82, xb + 0.14, 1.23, bz0 + 1.36, STEEL);
		box(pl, K, xb + 0.1, 0.75, bz0 + 0.86, xb + 0.16, 1.22, bz0 + 1.32, WHITE);
		// ---- entry: wardrobe on the -x wall, ceiling light
		const wz = zr0 + 1.66;
		const wf = K.sub(xL, 0, wz, Math.PI / 2);      // front faces +x (the corridor)
		box(pl, wf, -0.6, 0, 0, 0.6, 2.1, 0.6, P.wood, 'b');
		box(pl, wf, -0.005, 0.05, 0.6, 0.005, 2.05, 0.605, mul(P.wood, 0.6));
		box(sh, wf, -0.08, 0.95, 0.6, -0.06, 1.25, 0.63, STEEL);
		box(sh, wf, 0.06, 0.95, 0.6, 0.08, 1.25, 0.63, STEEL);
		solid(wf, -0.6, 0, 0, 0.6, 2.1, 0.6);
		box(gl, K, (xL + xb) / 2 - 0.15, CH - 0.04, zr0 + 1.1, (xL + xb) / 2 + 0.15, CH, zr0 + 1.4, [1, 0.95, 0.85], 't');
		// ---- bedroom
		const zb0 = bz1 + 0.1, D2 = zo - zb0;
		const bw = D2 >= 5.6 ? 1.9 : 1.6, BL = 2.1;
		let zbed = zb0 + D2 * 0.45;
		zbed = Math.max(zbed, zb0 + bw / 2 + 0.6);
		const bf = K.sub(xR - 0.08 - BL / 2, 0, zbed, -Math.PI / 2);   // headboard (local -z) against the +x wall
		this.bed(A, bf, bw, BL, P);
		solid(bf, -bw / 2, 0, -BL / 2, bw / 2, 0.62, BL / 2);
		for (let s = -1; s <= 1; s += 2)
		{
			const nf = K.sub(xR, 0, zbed + s * (bw / 2 + 0.3), -Math.PI / 2);
			this.nightstand(A, nf, P.wood);
		}
		// art above the headboard
		box(pl, K, xR - 0.04, 1.45, zbed - 0.75, xR, 2.15, zbed + 0.75, DARK);
		box(pl, K, xR - 0.045, 1.5, zbed - 0.7, xR - 0.04, 2.1, zbed + 0.7, P.accent);
		// dresser + TV on the -x wall, facing the bed
		const tvf = K.sub(xL, 0, zbed, Math.PI / 2);
		box(pl, tvf, -0.7, 0.05, 0, 0.7, 0.8, 0.5, P.wood, 'b');
		for (let r = 0; r < 3; r++) box(pl, tvf, -0.66, 0.12 + r * 0.22, 0.5, 0.66, 0.13 + r * 0.22, 0.505, mul(P.wood, 0.6));
		box(pl, tvf, -0.15, 0.8, 0.15, 0.15, 0.95, 0.3, DARK);
		box(pl, tvf, -0.58, 0.95, 0.18, 0.58, 1.62, 0.23, DARK);
		box(sh, tvf, -0.55, 0.98, 0.231, 0.55, 1.59, 0.236, [0.05, 0.06, 0.08]);
		solid(tvf, -0.7, 0, 0, 0.7, 0.8, 0.5);
		// desk + chair + lamp at the window wall (-x side)
		const dkf = K.sub(xL + 0.72, 0, zo, Math.PI);
		box(pl, dkf, -0.62, 0.72, 0, 0.62, 0.76, 0.6, P.wood);
		box(pl, dkf, -0.6, 0, 0.02, -0.56, 0.72, 0.58, P.wood, 'b');
		box(pl, dkf, 0.56, 0, 0.02, 0.6, 0.72, 0.58, P.wood, 'b');
		box(pl, dkf, -0.56, 0.4, 0.02, 0.56, 0.72, 0.06, mul(P.wood, 0.85), 'b');
		cyl(pl, dkf, 0.4, 0.76, 0.2, 0.3, 0.02, 0.02, 5, STEEL);
		cyl(gl, dkf, 0.4, 1.02, 0.2, 0.15, 0.12, 0.08, 8, [1, 0.92, 0.75], true);
		solid(dkf, -0.62, 0, 0, 0.62, 0.76, 0.6);
		this.chair(A, K.sub(xL + 0.72, 0, zo - 0.95, 0), P.sofa);
		// laptop on the desk (RealismInteractions: Use laptop)
		const lpf = dkf.sub(-0.1, 0.76, 0.3, 0);
		box(pl, lpf, -0.17, 0, -0.12, 0.17, 0.02, 0.12, [0.22, 0.23, 0.25]);
		box(pl, lpf, -0.15, 0.02, -0.07, 0.15, 0.022, 0.06, [0.1, 0.1, 0.11]);
		box(pl, lpf, -0.17, 0.02, -0.125, 0.17, 0.25, -0.11, [0.22, 0.23, 0.25]);
		box(sh, lpf, -0.155, 0.035, -0.11, 0.155, 0.235, -0.106, [0.14, 0.3, 0.48]);
		// armchair in the window corner
		this.armchair(A, K.sub(xR - 0.62, 0, zo - 0.68, -Math.PI * 0.75), P.sofa, false);
		solid(K.sub(xR - 0.62, 0, zo - 0.68, -Math.PI * 0.75), -0.42, 0, -0.38, 0.42, 0.7, 0.38);
		// curtains + rod
		for (let s = -1; s <= 1; s += 2) box(pl, K, s * 0.95 - (s > 0 ? 0 : 0.32), 0.05, zo - 0.12, s * 0.95 + (s > 0 ? 0.32 : 0), 2.75, zo - 0.04, mul(P.throwC, 0.85), 'b');
		box(sh, K, -1.35, 2.76, zo - 0.1, 1.35, 2.8, zo - 0.06, STEEL);
		// ceiling light
		box(gl, K, -0.25, CH - 0.04, (zb0 + zo) / 2 - 0.25, 0.25, CH, (zb0 + zo) / 2 + 0.25, [1, 0.95, 0.85], 't');
		// done
		h.kitParts = this.parts(set);
		h.floorShapes = h.floorShapes.concat(this.roomShapes(h, shapes));
	}

	/** Interaction anchors of every guest room (RealismInteractions): bed, lamps, toilet, sink, shower, desk, chairs, switch. */
	private roomAnchors(h: Hotel, hi: number): void
	{
		const sink = (this.ctx as any).interactionSink;
		if (!sink) return;
		const RW = h.RW;
		const xL = -RW / 2 + 0.06, xR = RW / 2 - 0.06;
		const zr0 = HH + HT, zo = h.iz1;
		const xb = xR - BW, bz1 = zr0 + BD, bx1 = xR, bz0 = zr0;
		const tx0 = bx1 - 1.7, tz1 = bz0 + 0.76;
		const zt = (tz1 + bz1 - 0.5) / 2;
		const zb0 = bz1 + 0.1, D2 = zo - zb0;
		const bw = D2 >= 5.6 ? 1.9 : 1.6, BL = 2.1;
		let zbed = zb0 + D2 * 0.45;
		zbed = Math.max(zbed, zb0 + bw / 2 + 0.6);
		const tcx = (tx0 + bx1) / 2, tcz = (bz0 + tz1) / 2;
		const put = (RF: Frame, name: string, fr: Frame, lz: number, room: number, dims: any, ly?: number) =>
		{
			const c = fr.p(0, ly || 0, lz);
			sink(name, { x: c[0], y: c[1], z: c[2], ry: fr.rot, room: room }, 0, dims);
		};
		for (let k = 1; k < h.N; k++)
			for (let s = 0; s < 2; s++)
				for (let i = 0; i < h.n; i++)
				{
					const RF = h.f.sub(h.roomsX[i], h.Y[k], 0, s === 0 ? 0 : Math.PI);
					const room = 1e7 + hi * 1e5 + k * 100 + this.roomIndex(h, s, i);
					put(RF, 'bed', RF.sub(xR - 0.08 - BL / 2, 0, zbed, -Math.PI / 2), 0, room, { w: bw, d: BL, top: 0.62 });
					for (let q = -1; q <= 1; q += 2) put(RF, 'nightstand', RF.sub(xR, 0, zbed + q * (bw / 2 + 0.3), -Math.PI / 2), 0.21, room, { w: 0.5, d: 0.42 });
					put(RF, 'toilet', RF.sub(bx1, 0, zt, -Math.PI / 2), 0.34, room, { w: 0.42, d: 0.64, top: 0.44, z: 0.08 });
					put(RF, 'bathSink', RF.sub(bx1 - 0.6, 0, bz1, Math.PI), 0.25, room, { w: 0.9, d: 0.5 });
					put(RF, 'bathtub', RF.sub(tcx, 0, tcz, 0), 0, room, { w: 1.7, d: 0.76, floor: 0.565, head: [bx1 - 0.13 - tcx, 1.96, bz0 + 0.38 - tcz] });
					put(RF, 'laptop', RF.sub(xL + 0.72, 0, zo, Math.PI).sub(-0.1, 0, 0.3, 0), 0, room, { deskH: 0.76 }, 0.76);
					put(RF, 'chair', RF.sub(xL + 0.72, 0, zo - 0.95, 0), 0, room, { top: 0.48 });
					put(RF, 'armchair', RF.sub(xR - 0.62, 0, zo - 0.68, -Math.PI * 0.75), 0, room, { w: 0.84, d: 0.76, top: 0.5 });
					put(RF, 'lightSwitch', RF.sub(xb - 0.06, 0, zr0 + 0.45, -Math.PI / 2), 0, room, null);
				}
	}

	/** Places the room-kit colliders of every room on one floor (floor-relative y). */
	private roomShapes(h: Hotel, kit: Shape[]): Shape[]
	{
		const out: Shape[] = [];
		for (let s = 0; s < 2; s++)
			for (let i = 0; i < h.n; i++)
			{
				const RF = h.f.sub(h.roomsX[i], 0, 0, s === 0 ? 0 : Math.PI);
				for (let k = 0; k < kit.length; k++)
				{
					const c = kit[k];
					const p = RF.p(c.x, c.y, c.z);
					out.push({ x: p[0], y: p[1], z: p[2], hx: c.hx, hy: c.hy, hz: c.hz, rot: RF.rot + c.rot });
				}
			}
		return out;
	}

	// -----------------------------------------------------------------------
	// floor walls (hall walls with door openings + dividers), one geometry per hotel

	private floorWalls(h: Hotel): void
	{
		const P = h.pal, f = new Frame(h.f.x, 0, h.f.z, h.f.rot);
		const set = new AccumSet();
		const pl = set.get('plain'), gl = set.get('lampGlow');
		const CH = FLOOR_H - SLAB;
		const shapes: Shape[] = [];
		const solid = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
		{
			const c = f.p((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
			shapes.push({ x: c[0], y: c[1], z: c[2], hx: Math.abs(x1 - x0) / 2, hy: Math.abs(y1 - y0) / 2, hz: Math.abs(z1 - z0) / 2, rot: f.rot });
		};
		const { rx0, ix1, iz0, iz1, RW, n } = h;
		for (let si = 0; si < 2; si++)
		{
			const s = si === 0 ? 1 : -1;
			const ops: Opening[] = [];
			for (let i = 0; i < n; i++)
			{
				const bx = h.roomsX[i] + s * h.ex;
				ops.push({ u0: bx - 0.45, u1: bx + 0.45, v0: 0, v1: DOOR_H });
			}
			const zh = s * HH, zr = s * (HH + HT);
			// hall face: baseboard + wallpaper; room face
			this.band(pl, f, rx0, ix1, 0, 0.12, ops, zh, -s, P.trim);
			this.band(pl, f, rx0, ix1, 0.12, CH, ops, zh, -s, P.hallWall);
			this.band(pl, f, rx0, ix1, 0, CH, ops, zr, s, P.roomWall);
			for (let i = 0; i < ops.length; i++)
			{
				const o = ops[i];
				this.jambs(pl, f, o, zh, zr, mul(P.trim, 1.6), false);
				const z0 = zh, z1 = zh - s * 0.03;
				box(pl, f, o.u0 - 0.08, 0, Math.min(z0, z1), o.u0, o.v1 + 0.08, Math.max(z0, z1), P.trim, 'b');
				box(pl, f, o.u1, 0, Math.min(z0, z1), o.u1 + 0.08, o.v1 + 0.08, Math.max(z0, z1), P.trim, 'b');
				box(pl, f, o.u0, o.v1, Math.min(z0, z1), o.u1, o.v1 + 0.08, Math.max(z0, z1), P.trim);
			}
			// colliders: wall pieces reachable from the floor (headers over the doors are skipped)
			const pieces = wallPieces(ix1 - rx0, CH, ops.map((o) => ({ u0: o.u0 - rx0, u1: o.u1 - rx0, v0: -1, v1: o.v1 })));
			for (let k = 0; k < pieces.length; k++)
			{
				const pc = pieces[k];
				if (pc.v0 > 1.9) continue;
				solid(rx0 + pc.u0, pc.v0, Math.min(zh, zr), rx0 + pc.u1, pc.v1, Math.max(zh, zr));
			}
			// dividers between rooms
			const za = s > 0 ? HH + HT : iz0, zb = s > 0 ? iz1 : -(HH + HT);
			for (let i = 1; i < n; i++)
			{
				const x = rx0 + i * RW;
				pl.face([f.p(x - 0.06, 0, zb), f.p(x - 0.06, 0, za), f.p(x - 0.06, CH, za), f.p(x - 0.06, CH, zb)], f.n(-1, 0, 0), Z4, P.roomWall);
				pl.face([f.p(x + 0.06, 0, za), f.p(x + 0.06, 0, zb), f.p(x + 0.06, CH, zb), f.p(x + 0.06, CH, za)], f.n(1, 0, 0), Z4, P.roomWall);
				solid(x - 0.06, 0, za, x + 0.06, CH, zb);
			}
		}
		// hallway ceiling lights
		for (let x = h.ix0 + 1.5; x < ix1 - 1; x += 3.5) box(gl, f, x - 0.25, CH - 0.035, -0.25, x + 0.25, CH, 0.25, [1, 0.94, 0.82], 't');
		h.wallParts = this.parts(set);
		h.floorShapes = h.floorShapes.concat(shapes);
	}

	private parts(set: AccumSet): Part[]
	{
		const out: Part[] = [];
		for (let k = 0; k < set.keys.length; k++)
		{
			const a = set.get(set.keys[k]);
			if (a.empty) continue;
			out.push({ geom: a.toGeometry(), mat: set.keys[k] });
		}
		return out;
	}

	// -----------------------------------------------------------------------
	// furniture pieces (local frame: front faces +z, origin on the floor)

	private bed(A: Acc, f: Frame, bw: number, L: number, P: Palette): void
	{
		const pl = A('plain');
		box(pl, f, -bw / 2, 0.05, -L / 2, bw / 2, 0.34, L / 2, mul(P.headboard, 0.8), 'b');
		box(pl, f, -bw / 2 + 0.02, 0.34, -L / 2 + 0.02, bw / 2 - 0.02, 0.56, L / 2 - 0.02, WHITE, 'b');
		box(pl, f, -bw / 2 - 0.02, 0.4, -L / 2 + 0.6, bw / 2 + 0.02, 0.62, L / 2 + 0.02, P.bedding, 'b');
		box(pl, f, -bw / 2 - 0.03, 0.42, L / 2 - 0.55, bw / 2 + 0.03, 0.635, L / 2 - 0.2, P.throwC, 'b');
		for (let k = 0; k < 2; k++)
		{
			const px = -bw / 4 + k * bw / 2;
			box(pl, f, px - bw / 4 + 0.06, 0.56, -L / 2 + 0.08, px + bw / 4 - 0.06, 0.72, -L / 2 + 0.48, WHITE, 'b');
		}
		box(pl, f, -bw / 2 - 0.15, 0, -L / 2 - 0.08, bw / 2 + 0.15, 1.3, -L / 2, P.headboard, 'b');
		box(pl, f, -bw / 2 - 0.1, 0.6, -L / 2, bw / 2 + 0.1, 1.22, -L / 2 + 0.04, mul(P.headboard, 1.15));
	}

	private nightstand(A: Acc, f: Frame, wood: number[]): void
	{
		const pl = A('plain');
		box(pl, f, -0.25, 0.04, 0, 0.25, 0.55, 0.42, wood, 'b');
		box(pl, f, -0.21, 0.36, 0.42, 0.21, 0.37, 0.425, mul(wood, 0.6));
		cyl(pl, f, 0, 0.55, 0.2, 0.32, 0.06, 0.03, 6, [0.75, 0.7, 0.6]);
		cyl(A('lampGlow'), f, 0, 0.84, 0.2, 0.24, 0.17, 0.12, 8, [1, 0.92, 0.75], true);
	}

	private chair(A: Acc, f: Frame, col: number[]): void
	{
		const pl = A('plain');
		box(pl, f, -0.22, 0.42, -0.22, 0.22, 0.48, 0.22, col);
		box(pl, f, -0.22, 0.48, -0.24, 0.22, 0.95, -0.2, col, 'b');
		for (let k = 0; k < 4; k++) box(pl, f, (k % 2 ? 0.17 : -0.21), 0, (k < 2 ? 0.17 : -0.21), (k % 2 ? 0.21 : -0.17), 0.42, (k < 2 ? 0.21 : -0.17), DARK, 'b');
	}

	private armchair(A: Acc, f: Frame, col: number[], collide: boolean): void
	{
		const pl = A('plain');
		box(pl, f, -0.42, 0.08, -0.38, 0.42, 0.42, 0.38, col, 'b');
		box(pl, f, -0.32, 0.42, -0.22, 0.32, 0.5, 0.36, mul(col, 1.12), 'b');
		box(pl, f, -0.42, 0.42, -0.38, 0.42, 0.9, -0.22, col, 'b');
		box(pl, f, -0.42, 0.42, -0.22, -0.32, 0.64, 0.38, col, 'b');
		box(pl, f, 0.32, 0.42, -0.22, 0.42, 0.64, 0.38, col, 'b');
		if (collide) this.pbox(f, 0, 0.4, 0, 0.42, 0.4, 0.38);
	}

	private sofa(A: Acc, f: Frame, col: number[], collide: boolean): void
	{
		const pl = A('plain');
		box(pl, f, -1.05, 0.08, -0.45, 1.05, 0.42, 0.45, col, 'b');
		box(pl, f, -0.95, 0.42, -0.25, 0.95, 0.52, 0.44, mul(col, 1.12), 'b');
		box(pl, f, -1.05, 0.42, -0.45, 1.05, 0.88, -0.25, col, 'b');
		box(pl, f, -1.05, 0.42, -0.25, -0.95, 0.65, 0.45, col, 'b');
		box(pl, f, 0.95, 0.42, -0.25, 1.05, 0.65, 0.45, col, 'b');
		if (collide) this.pbox(f, 0, 0.42, 0, 1.05, 0.42, 0.45);
	}

	private coffeeTable(A: Acc, f: Frame, wood: number[]): void
	{
		const pl = A('plain');
		box(pl, f, -0.6, 0.38, -0.35, 0.6, 0.43, 0.35, wood);
		box(pl, f, -0.5, 0, -0.25, 0.5, 0.38, 0.25, mul(wood, 0.7), 'b');
		box(A('shiny'), f, -0.15, 0.43, -0.1, 0.15, 0.47, 0.1, [0.8, 0.8, 0.82]);
	}

	private rug(A: Acc, f: Frame, cx: number, cz: number, w: number, d: number, col: number[]): void
	{
		box(A('plain'), f, cx - w / 2, 0, cz - d / 2, cx + w / 2, 0.012, cz + d / 2, col, 'b');
	}

	private plant(A: Acc, f: Frame, x: number, z: number): void
	{
		cyl(A('plain'), f, x, 0, z, 0.5, 0.26, 0.2, 8, [0.3, 0.3, 0.32], true);
		cyl(A('plain'), f, x, 0.5, z, 1.1, 0.42, 0, 7, PLANT);
		cyl(A('plain'), f, x, 0.9, z, 0.8, 0.3, 0, 7, mul(PLANT, 1.2));
	}

	private luggageCart(A: Acc, f: Frame): void
	{
		const sh = A('shiny');
		box(A('plain'), f, -0.5, 0.15, -0.3, 0.5, 0.2, 0.3, [0.45, 0.12, 0.12]);
		for (let k = -1; k <= 1; k += 2) box(sh, f, k * 0.48 - 0.02, 0.2, -0.02, k * 0.48 + 0.02, 1.8, 0.02, [0.85, 0.7, 0.3]);
		box(sh, f, -0.5, 1.78, -0.02, 0.5, 1.82, 0.02, [0.85, 0.7, 0.3]);
		box(A('plain'), f, -0.4, 0.2, -0.25, 0.1, 0.75, 0.05, [0.2, 0.25, 0.35], 'b');
		box(A('plain'), f, 0.12, 0.2, -0.2, 0.42, 0.55, 0.2, [0.5, 0.35, 0.2], 'b');
	}

	// -----------------------------------------------------------------------
	// meshes

	private flush(h: Hotel): void
	{
		const ctx = this.ctx;
		const r = Math.sqrt(h.w * h.w + h.d * h.d) / 2 + 2;
		const center = new THREE.Vector3(h.b.x, h.floorY, h.b.z);
		for (let k = 0; k < this.S.keys.length; k++)
		{
			const key = this.S.keys[k];
			const a = this.S.get(key);
			if (a.empty) continue;
			const parts = key.split('|');
			const mat = ctx.mats[parts[0]];
			if (!mat) continue;
			const tris = a.idx.length / 3;
			this.stats.gpuBytes += a.count * 26 + a.idx.length * (a.count > 65535 ? 4 : 2);
			if (parts[1] === 'building')
			{
				const cast = parts[0] === 'plain';
				addMesh(ctx, a.toGeometry(), mat, cast, true, 'building');
				this.stats.staticTris += tris;
				this.stats.drawCallsOutside++;
			}
			else
			{
				const mesh = addMesh(ctx, a.toGeometry(), mat, false, true);
				ctx.cull.add(mesh, 'interior', center, r);
				this.stats.staticTrisInterior += tris;
				this.stats.drawCallsInside++;
			}
		}
		if (!this.signAcc.empty)
		{
			const P = h.pal;
			const m = new THREE.MeshBasicMaterial({ map: signTexture(h.name, P.sign[0], P.sign[1]), vertexColors: THREE.VertexColors });
			const mesh = addMesh(ctx, this.signAcc.toGeometry(), m, false, false, 'building');
			mesh.name = 'hotelSign:' + h.name;
			this.stats.drawCallsOutside++;
		}
		this.S = new AccumSet();
	}

	private makeInstanced(h: Hotel): void
	{
		const ctx = this.ctx;
		const perFloor = h.n * 2;
		const make = (parts: Part[], cap: number, out: THREE.InstancedMesh[]) =>
		{
			for (let i = 0; i < parts.length; i++)
			{
				const src = ctx.mats[parts[i].mat];
				if (!src) continue;
				const mesh = new THREE.InstancedMesh(parts[i].geom, instMat(ctx, src), cap);
				mesh.count = 0;
				mesh.visible = false;
				mesh.frustumCulled = false;
				mesh.castShadow = false;
				mesh.receiveShadow = true;
				mesh.matrixAutoUpdate = false;
				mesh.updateMatrix();
				mesh.name = 'hotelKit:' + h.name + ':' + parts[i].mat;
				mesh.userData.realismGlow = parts[i].mat === 'lampGlow';
				ctx.world.graphicsWorld.add(mesh);
				out.push(mesh);
				const g = parts[i].geom;
				const ic = g.index ? g.index.count : 0;
				const vc = (g.getAttribute('position') as THREE.BufferAttribute).count;
				this.stats.gpuBytes += vc * 26 + ic * (vc > 65535 ? 4 : 2) + cap * 64;
			}
		};
		make(h.kitParts, perFloor * MAXF, h.kitMeshes);
		make(h.wallParts, MAXF, h.wallMeshes);
		const triCount = (parts: Part[]) => parts.reduce((s, p) => s + (p.geom.index ? p.geom.index.count / 3 : 0), 0);
		this.stats.kitTrisPerRoom = triCount(h.kitParts);
		this.stats.floorWallTris = Math.max(this.stats.floorWallTris, triCount(h.wallParts));
		this.stats.lazyShapesPerFloor = Math.max(this.stats.lazyShapesPerFloor, h.floorShapes.length);
		this.stats.drawCallsInside += h.kitMeshes.length + h.wallMeshes.length;
	}
}

// ---------------------------------------------------------------------------
// Runtime: draws / collides only the guest floors around the player and camera
// ---------------------------------------------------------------------------

export class HotelRuntime implements IUpdatable
{
	public updateOrder: number = 9;
	private ctx: RealismCtx;
	private hotels: Hotel[];
	private doors: DoorSpec[];
	private doorsDone = false;
	private acc = 1;
	private m = new THREE.Matrix4();
	private q = new THREE.Quaternion();
	private v = new THREE.Vector3();
	private s = new THREE.Vector3(1, 1, 1);
	private yAxis = new THREE.Vector3(0, 1, 0);
	private cam = new THREE.Vector3();
	private bodyMat = new CANNON.Material('hotelMat');
	/** Debug / test hook: extra points (world positions) treated like characters. */
	public extraPoints: { x: number; y: number; z: number }[] = [];
	public activeFloors: { [hotel: string]: number[] } = {};

	constructor(ctx: RealismCtx, hotels: Hotel[], doors: DoorSpec[])
	{
		this.ctx = ctx;
		this.hotels = hotels;
		this.doors = doors;
		this.bodyMat.friction = 0.3;
	}

	/** Registers the door queue with the door system once it exists (it may be created after the hotels). */
	public flushDoors(): void
	{
		if (this.doorsDone) return;
		const doors = (this.ctx as any).doors;
		if (!doors || typeof doors.add !== 'function') return;
		for (let i = 0; i < this.doors.length; i++)
		{
			try { doors.add(this.doors[i]); } catch (e) { console.warn('[Realism] Hotel door rejected', this.doors[i], e); }
		}
		this.doorsDone = true;
	}

	public update(timestep: number, unscaledTimeStep: number): void
	{
		this.acc += unscaledTimeStep || timestep || 0.016;
		if (this.acc < 0.15) return;
		this.acc = 0;
		this.flushDoors();
		this.tick();
	}

	/** One activation pass (also callable directly). */
	public tick(): void
	{
		const pts: { x: number; y: number; z: number; prio: number }[] = [];
		const world: any = this.ctx.world;
		const chars: any[] = world && world.characters ? world.characters : [];
		for (let i = 0; i < chars.length; i++)
		{
			const p = chars[i] && chars[i].position;
			if (p) pts.push({ x: p.x, y: p.y, z: p.z, prio: 0 });
		}
		for (let i = 0; i < this.extraPoints.length; i++) pts.push({ x: this.extraPoints[i].x, y: this.extraPoints[i].y, z: this.extraPoints[i].z, prio: 0 });
		if (world && world.camera && world.camera.getWorldPosition)
		{
			world.camera.getWorldPosition(this.cam);
			pts.push({ x: this.cam.x, y: this.cam.y, z: this.cam.z, prio: 1 });
		}
		const show = this.ctx.preset.interiors !== false;
		for (let i = 0; i < this.hotels.length; i++)
		{
			const h = this.hotels[i];
			const want = this.wanted(h, pts);
			const key = want.join(',');
			if (key !== h.key) { this.apply(h, want); h.key = key; this.activeFloors[h.name] = want; }
			for (let k = 0; k < h.kitMeshes.length; k++) h.kitMeshes[k].visible = show && h.kitMeshes[k].count > 0;
			for (let k = 0; k < h.wallMeshes.length; k++) h.wallMeshes[k].visible = show && h.wallMeshes[k].count > 0;
		}
	}

	private wanted(h: Hotel, pts: { x: number; y: number; z: number; prio: number }[]): number[]
	{
		const b = h.b;
		const c = Math.cos(b.rot), s = Math.sin(b.rot);
		const out: number[] = [];
		for (let pass = 0; pass < 2; pass++)
		{
			for (let i = 0; i < pts.length; i++)
			{
				const p = pts[i];
				if (p.prio !== pass) continue;
				const dx = p.x - b.x, dz = p.z - b.z;
				const lx = dx * c - dz * s, lz = dx * s + dz * c;
				const m = 2;
				if (Math.abs(lx) > h.w / 2 + m || Math.abs(lz) > h.d / 2 + m) continue;
				if (p.y < h.floorY - 3 || p.y > h.Y[h.N] + 2) continue;
				let k = 0;
				while (k < h.N - 1 && h.Y[k + 1] <= p.y + 0.4) k++;
				const order = [k, k + 1, k - 1];
				for (let j = 0; j < order.length; j++)
				{
					const fl = order[j];
					if (fl < 1 || fl > h.N - 1 || out.indexOf(fl) >= 0) continue;
					if (out.length < MAXF) out.push(fl);
				}
			}
		}
		out.sort((a, bb) => a - bb);
		return out;
	}

	private apply(h: Hotel, floors: number[]): void
	{
		const m = this.m, q = this.q, v = this.v;
		// room kits
		let idx = 0;
		for (let j = 0; j < floors.length; j++)
		{
			const y = h.Y[floors[j]];
			for (let side = 0; side < 2; side++)
				for (let i = 0; i < h.n; i++)
				{
					const p = h.f.p(h.roomsX[i], y, 0);
					v.set(p[0], y, p[2]);
					q.setFromAxisAngle(this.yAxis, h.f.rot + (side === 0 ? 0 : Math.PI));
					m.compose(v, q, this.s);
					for (let k = 0; k < h.kitMeshes.length; k++) h.kitMeshes[k].setMatrixAt(idx, m);
					// switched-off room (RealismRoomLights): its lamp glow instance is drawn collapsed
					if (h.lightsOff && h.lightsOff[floors[j] * 100 + (side === 0 ? i + 1 : h.n + (h.n - i))] === true)
					{
						for (let k = 0; k < h.kitMeshes.length; k++)
						{
							if (h.kitMeshes[k].material !== this.ctx.mats.lampGlow && (h.kitMeshes[k] as any).userData.realismGlow !== true) continue;
							const arr = h.kitMeshes[k].instanceMatrix.array as Float32Array;
							for (let e = 0; e < 11; e++) arr[idx * 16 + e] = 0;
						}
					}
					idx++;
				}
		}
		for (let k = 0; k < h.kitMeshes.length; k++) { h.kitMeshes[k].count = idx; h.kitMeshes[k].instanceMatrix.needsUpdate = true; }
		// floor walls
		for (let j = 0; j < floors.length; j++)
		{
			m.makeTranslation(0, h.Y[floors[j]], 0);
			for (let k = 0; k < h.wallMeshes.length; k++) h.wallMeshes[k].setMatrixAt(j, m);
		}
		for (let k = 0; k < h.wallMeshes.length; k++) { h.wallMeshes[k].count = floors.length; h.wallMeshes[k].instanceMatrix.needsUpdate = true; }
		// colliders: release bodies of floors no longer wanted, then place the missing ones
		const pw = this.ctx.world.physicsWorld;
		for (let i = 0; i < h.bodies.length; i++)
		{
			const e = h.bodies[i];
			if (e.floor >= 0 && floors.indexOf(e.floor) < 0)
			{
				if (e.added) { pw.remove(e.body); e.added = false; }
				e.floor = -1;
			}
		}
		for (let j = 0; j < floors.length; j++)
		{
			const fl = floors[j];
			let have = false;
			for (let i = 0; i < h.bodies.length; i++) if (h.bodies[i].floor === fl) have = true;
			if (have) continue;
			let e: { body: CANNON.Body; floor: number; added: boolean } = null;
			for (let i = 0; i < h.bodies.length; i++) if (h.bodies[i].floor < 0) { e = h.bodies[i]; break; }
			if (!e) { e = { body: this.makeBody(h), floor: -1, added: false }; h.bodies.push(e); }
			e.floor = fl;
			e.body.position.set(h.b.x, h.Y[fl], h.b.z);
			e.body.aabbNeedsUpdate = true;
			if (!e.added) { pw.addBody(e.body); e.added = true; }
		}
	}

	private makeBody(h: Hotel): CANNON.Body
	{
		const body = new CANNON.Body({ mass: 0 });
		body.material = this.bodyMat;
		const yAxis = new CANNON.Vec3(0, 1, 0);
		for (let i = 0; i < h.floorShapes.length; i++)
		{
			const s = h.floorShapes[i];
			if (s.hx <= 0.001 || s.hy <= 0.001 || s.hz <= 0.001) continue;
			const q = new CANNON.Quaternion();
			q.setFromAxisAngle(yAxis, s.rot);
			body.addShape(new CANNON.Box(new CANNON.Vec3(s.hx, s.hy, s.hz)), new CANNON.Vec3(s.x - h.b.x, s.y, s.z - h.b.z), q);
		}
		body.position.set(h.b.x, 0, h.b.z);
		body.updateMassProperties();
		return body;
	}
}
