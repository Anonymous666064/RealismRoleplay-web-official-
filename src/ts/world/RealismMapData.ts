/*
 * RealismMapData.ts
 * -----------------
 * Pure data generator for the "San Verano County" open world.
 * No three.js / cannon.js imports here, so it can be unit-tested or used
 * by tools (map preview, minimap, server-side spawn validation).
 *
 * Coordinate system (matches Sketchbook / three.js):
 *   +X = east, -Z = north, +Y = up. 1 unit = 1 metre.
 *   The playable square is 2048 m x 2048 m, centred on the origin.
 *
 * Layout (north is up):
 *
 *   NW  Prison ....... edge ridge .......... Verano Peak (mountains)   NE
 *       Airport (plateau)     Lake Verano     Summit Road / lookout
 *       Farmland   Lakeview Road ------------------------- Route 9
 *       Farmland   West Suburbs  North Suburbs   Eastside strip
 *       Farmland   West Suburbs  DOWNTOWN        Port of Verano
 *   SW  Pacific Coast Highway ..... beach / Verano Pier ..... ocean    SE
 */

export const WORLD_SIZE = 2048;
export const HALF = WORLD_SIZE / 2;
export const GRID_RES = 512;                 // terrain cells per side
export const CELL = WORLD_SIZE / GRID_RES;   // 4 m per cell
export const VERTS = GRID_RES + 1;           // 513 samples per side
export const SEA_LEVEL = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoadPoint { x: number; z: number; y: number; s: number; }

export interface Road
{
	name: string;
	kind: string;      // highway | avenue | street | rural | runway | taxiway | apron
	width: number;
	pts: RoadPoint[];
	layer: number;     // draw order offset (higher draws on top)
	grade?: number;    // max grade override (rise / run)
}

export interface Building
{
	x: number; z: number;      // footprint centre
	w: number; d: number;      // local X width, local Z depth
	h: number;                 // total height from baseY
	rot: number;               // yaw (radians). Local +Z is the "front".
	baseY: number;             // bottom of the box (buried slightly)
	style: string;             // glass | office | brick | house | warehouse | concrete | wood | steel | silo | plain
	tint: number[];            // rgb 0..1
	roof: string;              // flat | gable | none
	roofTint: number[];
	label?: string;            // sign text on the front face
	collide: boolean;
	// --- added for 3D exteriors / interiors ---
	groundY?: number;          // highest ground under the footprint (interior floor sits just above it)
	kind?: string;             // house | apartment | shop | office | tower | warehouse | civic | barn | prop
	sub?: string;              // interior type: living, market, diner, mechanic, dealer, motel, cafe, cityhall, court, bank, hospital, fire, terminal, hangar, police, cellblock, prisonadmin, cabin, lobby, clothing, restaurant, barber, laundromat, convenience, apartment
	floors?: number;           // storeys for houses
	enterable?: boolean;
	district?: string;         // 'hood' for the gang neighbourhoods
	condition?: number;        // 1 = well kept, 0 = run down
	boarded?: boolean;         // abandoned house with boarded-up windows
	closed?: boolean;          // closed / abandoned: plywood over windows + door, CLOSED / FOR LEASE sign, door locked for good
	custom?: string;           // drawn by the landmark builder: police | sheriff | prison | lookout
	role?: string;             // part of a custom landmark (wall, tower, cellblock, admin, cabin, mast...)
	id?: number;
}

export interface Tree { x: number; y: number; z: number; s: number; r: number; type: number; }
export interface Lamp { x: number; y: number; z: number; r: number; broken?: boolean; }

/** Street furniture: hydrant, bench, trashCan, dumpster, stopSign, wreckedCar, trashBag, tire, fence, mattress, barrier, picnicTable, telescope, flagpole, infoBoard, hoop, weightBench, bleacher */
export interface Prop { type: string; x: number; y: number; z: number; r: number; len?: number; color?: number[]; }

/** A road junction. `arms` are unit vectors pointing out of the junction along each road. */
export interface Intersection
{
	x: number; z: number; y: number;
	control: string;          // signal | stop
	arms: { dx: number; dz: number; hw: number; group: number }[];
	crossHW: number;          // half width of the widest crossing road
	phase: number;            // 0..1 offset of the signal cycle
}

export interface Hood { name: string; x0: number; x1: number; z0: number; z1: number; }
export interface Spawn { type: string; x: number; y: number; z: number; rot: number; driver?: string; }

export interface ScenarioDef
{
	id: string;
	name: string;
	title: string;
	desc: string;
	isDefault: boolean;
	camAngle: number;
	spawns: Spawn[];
}

export interface Landmark { name: string; x: number; z: number; kind: string; }
export interface WaterBody { x: number; z: number; rx: number; rz: number; level: number; }

export interface MapData
{
	seed: number;
	heights: Float32Array;   // VERTS*VERTS, index gz*VERTS+gx, x=-HALF+gx*CELL, z=-HALF+gz*CELL
	colors: Float32Array;    // rgb per height sample
	roads: Road[];
	buildings: Building[];
	trees: Tree[];
	lamps: Lamp[];
	props: Prop[];
	intersections: Intersection[];
	hoods: Hood[];
	scenarios: ScenarioDef[];
	landmarks: Landmark[];
	lake: WaterBody;
	respawn: { x: number; y: number; z: number };
	heightAt: (x: number, z: number) => number;
	roadClearance: (x: number, z: number) => number;
	stats: { [key: string]: number };
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function clamp(v: number, a: number, b: number): number { return v < a ? a : (v > b ? b : v); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function smoothstep(a: number, b: number, v: number): number
{
	const t = clamp((v - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
}

// Integer multiply (the ES2015 built-in isn't available when targeting ES5).
function imul(a: number, b: number): number
{
	const ah = (a >>> 16) & 0xffff, al = a & 0xffff;
	const bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
	return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
}

export function mulberry32(seed: number): () => number
{
	let a = seed >>> 0;
	return function(): number
	{
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = imul(t ^ (t >>> 15), t | 1);
		t ^= t + imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const GX = [1, -1, 1, -1, 1.41, -1.41, 0, 0];
const GZ = [1, 1, -1, -1, 0, 0, 1.41, -1.41];

function makePerlin(seed: number): (x: number, z: number) => number
{
	const rnd = mulberry32(seed);
	const perm: number[] = [];
	for (let i = 0; i < 256; i++) perm.push(i);
	for (let i = 255; i > 0; i--)
	{
		const j = Math.floor(rnd() * (i + 1));
		const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
	}
	const p = new Uint8Array(512);
	for (let i = 0; i < 512; i++) p[i] = perm[i & 255];

	return function(x: number, z: number): number
	{
		const X = Math.floor(x), Z = Math.floor(z);
		const xf = x - X, zf = z - Z;
		const xi = X & 255, zi = Z & 255;
		const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
		const v = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
		const aa = p[p[xi] + zi] & 7, ab = p[p[xi] + zi + 1] & 7;
		const ba = p[p[xi + 1] + zi] & 7, bb = p[p[xi + 1] + zi + 1] & 7;
		const n00 = GX[aa] * xf + GZ[aa] * zf;
		const n10 = GX[ba] * (xf - 1) + GZ[ba] * zf;
		const n01 = GX[ab] * xf + GZ[ab] * (zf - 1);
		const n11 = GX[bb] * (xf - 1) + GZ[bb] * (zf - 1);
		return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
	};
}

// ---------------------------------------------------------------------------
// Zones (terrain plateaus) and named regions
// ---------------------------------------------------------------------------

interface Zone { x0: number; x1: number; z0: number; z1: number; y: number; feather: number; amp: number; }
interface Rect { x0: number; x1: number; z0: number; z1: number; }

export const REGIONS: { [name: string]: Rect } = {
	downtown:     { x0: -170, x1: 478, z0: 312, z1: 776 },
	port:         { x0: 478,  x1: 930, z0: 440, z1: 860 },
	eastside:     { x0: 478,  x1: 860, z0: 250, z1: 440 },
	westSuburbs:  { x0: -630, x1: -170, z0: 300, z1: 760 },
	northSuburbs: { x0: -130, x1: 478, z0: -40, z1: 230 },
	airport:      { x0: -960, x1: -220, z0: -780, z1: -420 },
	prison:       { x0: -935, x1: -705, z0: -965, z1: -795 },
	farmland:     { x0: -1000, x1: -660, z0: -400, z1: 640 },
};

function inRect(x: number, z: number, r: Rect, m: number = 0): boolean
{
	return x >= r.x0 - m && x <= r.x1 + m && z >= r.z0 - m && z <= r.z1 + m;
}

const MOUNTAIN = { x: 600, z: -760, r0: 160, r1: 760 };
const LAKE: WaterBody = { x: 40, z: -300, rx: 150, rz: 110, level: 21 };
const LOOKOUT = { x: 505, z: -478 };

function coastZ(x: number): number { return 830 + 20 * Math.sin(x / 173) + 10 * Math.sin(x / 61 + 1); }
function coastX(z: number): number { return 885 + 28 * Math.sin(z / 197); }
/** Signed distance-ish to the coastline. > 0 means sea. */
export function coastDistance(x: number, z: number): number
{
	return Math.max(z - coastZ(x), x - coastX(z));
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function generateRealismMap(seed: number = 1337): MapData
{
	const t0 = Date.now();
	const rnd = mulberry32(seed * 7 + 3);
	const n1 = makePerlin(seed);
	const n2 = makePerlin(seed + 101);
	const n3 = makePerlin(seed + 202);

	function fbm(noise: (x: number, z: number) => number, x: number, z: number, oct: number): number
	{
		let sum = 0, amp = 1, f = 1, norm = 0;
		for (let i = 0; i < oct; i++)
		{
			sum += amp * noise(x * f, z * f);
			norm += amp; amp *= 0.5; f *= 2.03;
		}
		return (sum / norm) * 1.6;   // roughly -1..1
	}

	function ridged(x: number, z: number, oct: number): number
	{
		let sum = 0, amp = 1, f = 1, norm = 0;
		for (let i = 0; i < oct; i++)
		{
			const r = 1 - Math.abs(n2(x * f, z * f)) * 1.4;
			sum += amp * r * r;
			norm += amp; amp *= 0.5; f *= 2.1;
		}
		return clamp(sum / norm, 0, 1);
	}

	// --- Natural landform -------------------------------------------------
	function mountainMask(x: number, z: number): number
	{
		const d = Math.sqrt((x - MOUNTAIN.x) * (x - MOUNTAIN.x) + (z - MOUNTAIN.z) * (z - MOUNTAIN.z) * 1.3);
		const m = 1 - smoothstep(MOUNTAIN.r0, MOUNTAIN.r1, d);
		return m * m;
	}

	function natural(x: number, z: number): number
	{
		let h = 24 + fbm(n1, x / 700, z / 700, 4) * 14;
		const mm = mountainMask(x, z);
		h += mm * (60 + 190 * ridged(x / 420, z / 420, 5)) + Math.sqrt(mm) * 35;
		const edge = smoothstep(860, 1010, Math.max(-x, -z));
		h += edge * (55 + 35 * fbm(n3, x / 200, z / 200, 3));
		h += fbm(n3, x / 90, z / 90, 3) * 2.5;
		return h;
	}

	const zones: Zone[] = [
		{ x0: -680, x1: 860, z0: 250, z1: 820, y: 5, feather: 120, amp: 0 },     // coastal lowland (downtown, port, eastside)
		{ x0: -630, x1: -220, z0: 300, z1: 720, y: 7, feather: 60, amp: 2.5 },   // west suburbs, gentle rolls
		{ x0: -150, x1: 470, z0: -30, z1: 220, y: 12, feather: 80, amp: 2 },     // north suburbs
		{ x0: -980, x1: -660, z0: -380, z1: 620, y: 18, feather: 110, amp: 6 },  // farmland
		{ x0: 500, x1: 930, z0: 440, z1: 860, y: 4, feather: 60, amp: 0 },       // port
		{ x0: -960, x1: -220, z0: -780, z1: -420, y: 26, feather: 100, amp: 0 }, // airport plateau
		{ x0: -935, x1: -705, z0: -965, z1: -795, y: 40, feather: 70, amp: 0 },  // prison
	];


	function zoneMask(x: number, z: number, zn: Zone): number
	{
		const dx = Math.max(zn.x0 - x, 0, x - zn.x1);
		const dz = Math.max(zn.z0 - z, 0, z - zn.z1);
		const d = Math.sqrt(dx * dx + dz * dz);
		return 1 - smoothstep(0, zn.feather, d);
	}

	function seawallMask(x: number, z: number): number
	{
		const r = { x0: 500, x1: 940, z0: 430, z1: 880 };
		const dx = Math.max(r.x0 - x, 0, x - r.x1);
		const dz = Math.max(r.z0 - z, 0, z - r.z1);
		return 1 - smoothstep(0, 30, Math.sqrt(dx * dx + dz * dz));
	}

	function coastCap(x: number, z: number): number
	{
		const cd = coastDistance(x, z);
		let normal: number;
		if (cd > 0) normal = Math.max(-14, -cd * 0.1);
		else if (cd > -45) normal = 2 * (-cd / 45);
		else { const ex = Math.max(0, -cd - 150); normal = 2 + (-cd - 45) * 0.12 + (ex * ex / (ex + 80)) * 1.5; }
		const wall = cd > 0 ? Math.max(-12, -2 - cd * 0.8) : 4.5;
		return lerp(normal, wall, seawallMask(x, z));
	}

	/** Terrain height before roads are cut in. */
	function preRoadHeight(x: number, z: number): number
	{
		let h = natural(x, z);
		for (let i = 0; i < zones.length; i++)
		{
			const zn = zones[i];
			const m = zoneMask(x, z, zn);
			if (m > 0)
			{
				const target = zn.amp > 0 ? zn.y + fbm(n3, x / 250, z / 250, 2) * zn.amp : zn.y;
				h = lerp(h, target, m);
			}
		}
		// Lake bowl with a guaranteed rim above water level
		const ld = Math.sqrt(((x - LAKE.x) / LAKE.rx) * ((x - LAKE.x) / LAKE.rx) + ((z - LAKE.z) / LAKE.rz) * ((z - LAKE.z) / LAKE.rz));
		if (ld < 1.6)
		{
			const rimH = LAKE.level + 1.5;
			const rimW = smoothstep(1.6, 1.0, ld);
			h = lerp(h, Math.max(h, rimH), rimW);
			if (ld < 1)
			{
				const bottom = LAKE.level - 0.6 - 7 * (1 - ld * ld);
				h = Math.min(h, lerp(rimH, bottom, smoothstep(1.0, 0.72, ld)));
			}
		}
		return Math.min(h, coastCap(x, z));
	}

	// --- Roads ------------------------------------------------------------
	const roads: Road[] = [];
	const SMOOTH: { [kind: string]: number } = { highway: 44, avenue: 24, street: 20, rural: 28, runway: 80, taxiway: 40, apron: 40 };
	const GRADE: { [kind: string]: number } = { highway: 0.06, avenue: 0.08, street: 0.1, rural: 0.12, runway: 0.01, taxiway: 0.015, apron: 0.02 };
	const LAYER: { [kind: string]: number } = { street: 0, rural: 0, avenue: 1, highway: 2, taxiway: 1, apron: 0, runway: 2 };

	function catmull(ctrl: number[][], step: number): number[][]
	{
		const out: number[][] = [];
		const n = ctrl.length;
		for (let i = 0; i < n - 1; i++)
		{
			const p0 = ctrl[Math.max(i - 1, 0)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(i + 2, n - 1)];
			const segLen = Math.sqrt((p2[0] - p1[0]) * (p2[0] - p1[0]) + (p2[1] - p1[1]) * (p2[1] - p1[1]));
			const steps = Math.max(1, Math.ceil(segLen / step));
			for (let k = 0; k < steps; k++)
			{
				const t = k / steps, t2 = t * t, t3 = t2 * t;
				const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
				const z = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
				out.push([x, z]);
			}
		}
		out.push([ctrl[n - 1][0], ctrl[n - 1][1]]);
		return out;
	}

	function straight(a: number[], b: number[], step: number): number[][]
	{
		const len = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
		const steps = Math.max(1, Math.ceil(len / step));
		const out: number[][] = [];
		for (let k = 0; k <= steps; k++) out.push([lerp(a[0], b[0], k / steps), lerp(a[1], b[1], k / steps)]);
		return out;
	}

	function addRoad(name: string, kind: string, width: number, ctrl: number[][], curved: boolean): void
	{
		let pts2: number[][] = [];
		if (curved) pts2 = catmull(ctrl, 4);
		else
		{
			for (let i = 0; i < ctrl.length - 1; i++)
			{
				const seg = straight(ctrl[i], ctrl[i + 1], 8);
				if (i > 0) seg.shift();
				pts2 = pts2.concat(seg);
			}
		}
		const pts: RoadPoint[] = [];
		let s = 0;
		for (let i = 0; i < pts2.length; i++)
		{
			if (i > 0) s += Math.sqrt((pts2[i][0] - pts2[i - 1][0]) * (pts2[i][0] - pts2[i - 1][0]) + (pts2[i][1] - pts2[i - 1][1]) * (pts2[i][1] - pts2[i - 1][1]));
			pts.push({ x: pts2[i][0], z: pts2[i][1], y: 0, s: s });
		}
		roads.push({ name: name, kind: kind, width: width, pts: pts, layer: LAYER[kind] || 0 });
	}

	// Main arterials
	addRoad('Pacific Coast Highway', 'highway', 16, [[-980, 600], [-820, 655], [-640, 745], [-400, 768], [-160, 768], [100, 768], [360, 768], [470, 768]], true);
	addRoad('Route 9', 'highway', 16, [[470, 768], [470, 560], [470, 360], [470, 250], [445, 60], [420, -100], [300, -300], [150, -450], [60, -600], [40, -800], [40, -1000]], true);
	addRoad('Grand Avenue', 'avenue', 16, [[128, 768], [128, -70]], false);
	addRoad('Lakeview Road', 'rural', 8, [[-980, -160], [-760, -190], [-600, -200], [-420, -140], [-250, -70], [0, -70], [128, -70], [300, -90], [420, -100]], true);
	addRoad('Airport Boulevard', 'avenue', 12, [[-160, 320], [-260, 240], [-420, 120], [-560, -20], [-600, -200], [-600, -420]], true);
	addRoad('Summit Road', 'rural', 8, [[420, -100], [520, -180], [615, -250], [645, -320], [580, -375], [430, -372], [335, -415], [318, -470], [380, -480], [LOOKOUT.x, LOOKOUT.z]], true);
	roads[roads.length - 1].grade = 0.15;
	addRoad('Old Mill Road', 'rural', 7, [[-760, -190], [-800, 0], [-780, 250], [-820, 450], [-820, 655]], true);
	addRoad('Prison Road', 'rural', 7, [[-600, -420], [-200, -430], [-170, -650], [-260, -860], [-560, -900], [-704, -880]], true);
	addRoad('Harbor Road', 'avenue', 12, [[470, 360], [845, 360]], false);

	// Downtown grid
	const dtX = [-160, -64, 32, 128, 224, 320, 416, 470];
	const dtXhw = [6, 6, 6, 8, 6, 6, 6, 8];
	const dtZ = [320, 400, 480, 560, 640, 720, 768];
	const dtZhw = [5, 5, 5, 5, 5, 5, 8];
	const avenueNames = ['1st Avenue', '2nd Avenue', '3rd Avenue', '', '5th Avenue', '6th Avenue', '7th Avenue'];
	const streetNames = ['Pine Street', 'Oak Street', 'Main Street', 'Market Street', 'Mission Street', 'Bay Street'];
	for (let i = 0; i < 7; i++)
	{
		if (dtX[i] === 128) continue;
		addRoad(avenueNames[i], 'avenue', 12, [[dtX[i], 320], [dtX[i], 768]], false);
	}
	for (let j = 0; j < 6; j++) addRoad(streetNames[j], 'street', 10, [[-160, dtZ[j]], [470, dtZ[j]]], false);

	// Port grid
	const portX = [560, 680, 800];
	const portZ = [470, 600, 720];
	for (let i = 0; i < portX.length; i++) addRoad('Dock Road ' + (i + 1), 'street', 12, [[portX[i], 360], [portX[i], 800]], false);
	for (let j = 0; j < portZ.length; j++) addRoad('Pier Street ' + (j + 1), 'street', 12, [[470, portZ[j]], [855, portZ[j]]], false);

	// West suburbs
	const wsZ = [320, 390, 460, 530, 600, 670];
	const wsX = [-620, -420, -220];
	for (let j = 0; j < wsZ.length; j++) addRoad('Willow Lane ' + (j + 1), 'street', 9, [[-620, wsZ[j]], [-160, wsZ[j]]], false);
	for (let i = 0; i < wsX.length; i++) addRoad('Cedar Drive ' + (i + 1), 'street', 9, [[wsX[i], 320], [wsX[i], 768]], false);

	// North suburbs
	const nsZ = [0, 70, 140, 210];
	const nsX = [-120, 300];
	for (let j = 0; j < nsZ.length; j++) addRoad('Hillcrest Road ' + (j + 1), 'street', 9, [[-120, nsZ[j]], [470, nsZ[j]]], false);
	for (let i = 0; i < nsX.length; i++) addRoad('Ridge Way ' + (i + 1), 'street', 9, [[nsX[i], -70], [nsX[i], 320]], false);

	// Airport
	const RWY_Z = -620;
	addRoad('Runway 09/27', 'runway', 45, [[-930, RWY_Z], [-250, RWY_Z]], false);
	addRoad('Taxiway A', 'taxiway', 18, [[-900, -565], [-280, -565]], false);
	addRoad('Taxiway B1', 'taxiway', 18, [[-900, -565], [-900, RWY_Z]], false);
	addRoad('Taxiway B2', 'taxiway', 18, [[-590, -565], [-590, RWY_Z]], false);
	addRoad('Taxiway B3', 'taxiway', 18, [[-280, -565], [-280, RWY_Z]], false);
	addRoad('Taxiway C1', 'taxiway', 18, [[-700, -500], [-700, -565]], false);
	addRoad('Taxiway C2', 'taxiway', 18, [[-500, -500], [-500, -565]], false);
	addRoad('Apron', 'apron', 60, [[-780, -500], [-450, -500]], false);
	addRoad('Hangar Apron', 'apron', 30, [[-910, -545], [-790, -545]], false);
	addRoad('Terminal Drive', 'avenue', 12, [[-700, -428], [-480, -428]], false);

	// --- Road elevations ---------------------------------------------------
	for (let r = 0; r < roads.length; r++)
	{
		const road = roads[r];
		const raw: number[] = [];
		for (let i = 0; i < road.pts.length; i++) raw.push(preRoadHeight(road.pts[i].x, road.pts[i].z));
		const spacing = road.pts.length > 1 ? road.pts[road.pts.length - 1].s / (road.pts.length - 1) : 4;
		const k = Math.max(1, Math.round((SMOOTH[road.kind] || 24) / spacing));
		let cur = raw;
		for (let pass = 0; pass < 3; pass++)
		{
			const next: number[] = [];
			for (let i = 0; i < cur.length; i++)
			{
				let sum = 0, cnt = 0;
				for (let o = -k; o <= k; o++)
				{
					const idx = clamp(i + o, 0, cur.length - 1);
					sum += cur[idx]; cnt++;
				}
				next.push(sum / cnt);
			}
			cur = next;
		}
		// Limit the grade so cars (and walkers) can actually use the road
		const g = road.grade || GRADE[road.kind] || 0.1;
		// Both ends are junctions or destinations: keep them at terrain level and let the
		// middle of the road climb early (embankments) or late (cuttings) as needed.
		const tStart = cur[0], tEnd = cur[cur.length - 1];
		for (let it = 0; it < 6; it++)
		{
			cur[cur.length - 1] = tEnd;
			for (let i = cur.length - 2; i >= 0; i--)
			{
				const ds = road.pts[i + 1].s - road.pts[i].s;
				cur[i] = clamp(cur[i], cur[i + 1] - g * ds, cur[i + 1] + g * ds);
			}
			cur[0] = tStart;
			for (let i = 1; i < cur.length; i++)
			{
				const ds = road.pts[i].s - road.pts[i - 1].s;
				cur[i] = clamp(cur[i], cur[i - 1] - g * ds, cur[i - 1] + g * ds);
			}
		}
		for (let i = 0; i < road.pts.length; i++) road.pts[i].y = Math.max(1.4, cur[i]);
	}

	// --- Road spatial hash ---------------------------------------------------
	const HASH = 32;
	const HN = WORLD_SIZE / HASH;
	const roadHash: number[][] = [];
	for (let i = 0; i < HN * HN; i++) roadHash.push([]);
	const segRoad: number[] = [];
	const segIdx: number[] = [];
	const MAX_BLEND = 55;

	for (let r = 0; r < roads.length; r++)
	{
		const road = roads[r];
		const margin = road.width / 2 + 1.5 + MAX_BLEND;
		for (let i = 0; i < road.pts.length - 1; i++)
		{
			const a = road.pts[i], b = road.pts[i + 1];
			const id = segRoad.length;
			segRoad.push(r); segIdx.push(i);
			const cx0 = clamp(Math.floor((Math.min(a.x, b.x) - margin + HALF) / HASH), 0, HN - 1);
			const cx1 = clamp(Math.floor((Math.max(a.x, b.x) + margin + HALF) / HASH), 0, HN - 1);
			const cz0 = clamp(Math.floor((Math.min(a.z, b.z) - margin + HALF) / HASH), 0, HN - 1);
			const cz1 = clamp(Math.floor((Math.max(a.z, b.z) + margin + HALF) / HASH), 0, HN - 1);
			for (let cz = cz0; cz <= cz1; cz++)
				for (let cx = cx0; cx <= cx1; cx++) roadHash[cz * HN + cx].push(id);
		}
	}

	// Closest-road query. Returns signed distance to the road edge (negative = on the road).
	const q = { clearance: 1e9, roadY: 0, dist: 1e9, road: -1 };
	function queryRoads(x: number, z: number, wantBlend: boolean, h1: number): number
	{
		q.clearance = 1e9; q.road = -1;
		let bestW = 0, bestD = 1e9, bestY = h1;
		const cx = Math.floor((x + HALF) / HASH), cz = Math.floor((z + HALF) / HASH);
		if (cx < 0 || cz < 0 || cx >= HN || cz >= HN) return 0;
		const list = roadHash[cz * HN + cx];
		for (let n = 0; n < list.length; n++)
		{
			const id = list[n];
			const road = roads[segRoad[id]];
			const a = road.pts[segIdx[id]], b = road.pts[segIdx[id] + 1];
			const dx = b.x - a.x, dz = b.z - a.z;
			const len2 = dx * dx + dz * dz;
			let t = len2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
			t = clamp(t, 0, 1);
			const px = a.x + dx * t, pz = a.z + dz * t;
			const d = Math.sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
			const hw = road.width / 2;
			const clr = d - hw;
			if (clr < q.clearance) { q.clearance = clr; q.road = segRoad[id]; }
			if (wantBlend)
			{
				const ry = lerp(a.y, b.y, t);
				const edge = hw + 1.5;
				const blend = clamp(Math.max(road.kind === 'highway' ? 22 : 12, Math.abs(ry - h1) * 1.7), 6, MAX_BLEND);
				const w = d <= edge ? 1 : 1 - smoothstep(edge, edge + blend, d);
				if (w > bestW + 1e-4 || (w > 0 && Math.abs(w - bestW) <= 1e-4 && d < bestD))
				{
					bestW = w; bestD = d; bestY = ry;
				}
			}
		}
		if (wantBlend) return lerp(h1, bestY, bestW);
		return q.clearance;
	}

	function roadClearance(x: number, z: number): number
	{
		queryRoads(x, z, false, 0);
		return q.clearance;
	}

	// --- Final heightfield ---------------------------------------------------
	const heights = new Float32Array(VERTS * VERTS);
	for (let gz = 0; gz < VERTS; gz++)
	{
		const z = -HALF + gz * CELL;
		for (let gx = 0; gx < VERTS; gx++)
		{
			const x = -HALF + gx * CELL;
			const h1 = preRoadHeight(x, z);
			heights[gz * VERTS + gx] = queryRoads(x, z, true, h1);
		}
	}

	function heightAt(x: number, z: number): number
	{
		const fx = clamp((x + HALF) / CELL, 0, GRID_RES - 1e-6);
		const fz = clamp((z + HALF) / CELL, 0, GRID_RES - 1e-6);
		const gx = Math.floor(fx), gz = Math.floor(fz);
		const tx = fx - gx, tz = fz - gz;
		const h00 = heights[gz * VERTS + gx], h10 = heights[gz * VERTS + gx + 1];
		const h01 = heights[(gz + 1) * VERTS + gx], h11 = heights[(gz + 1) * VERTS + gx + 1];
		// Same triangle split as the physics heightfield: diagonal (gx,gz)-(gx+1,gz+1)
		if (tx >= tz) return h00 + (h10 - h00) * tx + (h11 - h10) * tz;
		return h00 + (h11 - h01) * tx + (h01 - h00) * tz;
	}

	function slopeAt(gx: number, gz: number): number
	{
		const xa = heights[gz * VERTS + Math.max(gx - 1, 0)], xb = heights[gz * VERTS + Math.min(gx + 1, VERTS - 1)];
		const za = heights[Math.max(gz - 1, 0) * VERTS + gx], zb = heights[Math.min(gz + 1, VERTS - 1) * VERTS + gx];
		const sx = (xb - xa) / (2 * CELL), sz = (zb - za) / (2 * CELL);
		return Math.sqrt(sx * sx + sz * sz);
	}

	// --- Buildings ------------------------------------------------------------
	const buildings: Building[] = [];
	const BH = 32;
	const bHash: number[][] = [];
	for (let i = 0; i < HN * HN; i++) bHash.push([]);

	function footprintCorners(cx: number, cz: number, w: number, d: number, rot: number): number[][]
	{
		const c = Math.cos(rot), s = Math.sin(rot);
		const out: number[][] = [];
		const lx = [-w / 2, w / 2, w / 2, -w / 2], lz = [-d / 2, -d / 2, d / 2, d / 2];
		for (let i = 0; i < 4; i++) out.push([cx + lx[i] * c + lz[i] * s, cz - lx[i] * s + lz[i] * c]);
		return out;
	}

	function pointInBuilding(x: number, z: number, margin: number): boolean
	{
		const cx = Math.floor((x + HALF) / BH), cz = Math.floor((z + HALF) / BH);
		if (cx < 0 || cz < 0 || cx >= HN || cz >= HN) return false;
		const list = bHash[cz * HN + cx];
		for (let n = 0; n < list.length; n++)
		{
			const b = buildings[list[n]];
			const c = Math.cos(b.rot), s = Math.sin(b.rot);
			const dx = x - b.x, dz = z - b.z;
			const lx = dx * c - dz * s, lz = dx * s + dz * c;
			if (Math.abs(lx) <= b.w / 2 + margin && Math.abs(lz) <= b.d / 2 + margin) return true;
		}
		return false;
	}

	function rectFree(cx: number, cz: number, w: number, d: number, rot: number, roadMargin: number, bMargin: number): boolean
	{
		const c = Math.cos(rot), s = Math.sin(rot);
		const nx = Math.max(2, Math.ceil(w / 5)), nz = Math.max(2, Math.ceil(d / 5));
		for (let i = 0; i <= nx; i++)
		{
			for (let j = 0; j <= nz; j++)
			{
				if (i > 0 && i < nx && j > 0 && j < nz && !(i === Math.floor(nx / 2) && j === Math.floor(nz / 2))) continue;
				const lx = -w / 2 + w * i / nx, lz = -d / 2 + d * j / nz;
				const x = cx + lx * c + lz * s, z = cz - lx * s + lz * c;
				if (Math.abs(x) > HALF - 8 || Math.abs(z) > HALF - 8) return false;
				if (roadMargin > -100 && roadClearance(x, z) < roadMargin) return false;
				if (bMargin > -100 && pointInBuilding(x, z, bMargin)) return false;
			}
		}
		return true;
	}

	function groundRange(cx: number, cz: number, w: number, d: number, rot: number): number[]
	{
		const pts = footprintCorners(cx, cz, w, d, rot);
		pts.push([cx, cz]);
		let lo = 1e9, hi = -1e9;
		for (let i = 0; i < pts.length; i++)
		{
			const h = heightAt(pts[i][0], pts[i][1]);
			if (h < lo) lo = h; if (h > hi) hi = h;
		}
		return [lo, hi];
	}

	interface BOpts { style: string; tint: number[]; roof?: string; roofTint?: number[]; label?: string; collide?: boolean; baseY?: number; kind?: string; sub?: string; custom?: string; role?: string; floors?: number; }

	function addBuilding(cx: number, cz: number, w: number, d: number, h: number, rot: number, o: BOpts): Building
	{
		let baseY: number, total: number, groundY: number;
		if (o.baseY !== undefined) { baseY = o.baseY; total = h; groundY = heightAt(cx, cz); }
		else
		{
			const gr = groundRange(cx, cz, w, d, rot);
			baseY = gr[0] - 0.8;
			total = (gr[1] - baseY) + h;
			groundY = gr[1];
		}
		const b: Building = {
			x: cx, z: cz, w: w, d: d, h: total, rot: rot, baseY: baseY,
			style: o.style, tint: o.tint, roof: o.roof || 'flat',
			roofTint: o.roofTint || [0.32, 0.32, 0.33],
			label: o.label, collide: o.collide !== false, groundY: groundY,
		};
		if (o.baseY !== undefined) (b as any).fixedBase = true;
		if (o.kind) b.kind = o.kind;
		if (o.sub) b.sub = o.sub;
		if (o.custom) { b.custom = o.custom; b.role = o.role; }
		if (o.floors) b.floors = o.floors;
		const id = buildings.length;
		b.id = id;
		buildings.push(b);
		const corners = footprintCorners(cx, cz, w, d, rot);
		let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
		for (let i = 0; i < 4; i++)
		{
			x0 = Math.min(x0, corners[i][0]); x1 = Math.max(x1, corners[i][0]);
			z0 = Math.min(z0, corners[i][1]); z1 = Math.max(z1, corners[i][1]);
		}
		const m = 4;
		for (let gz = clamp(Math.floor((z0 - m + HALF) / BH), 0, HN - 1); gz <= clamp(Math.floor((z1 + m + HALF) / BH), 0, HN - 1); gz++)
			for (let gx = clamp(Math.floor((x0 - m + HALF) / BH), 0, HN - 1); gx <= clamp(Math.floor((x1 + m + HALF) / BH), 0, HN - 1); gx++)
				bHash[gz * HN + gx].push(id);
		return b;
	}

	function pick<T>(arr: T[]): T { return arr[Math.floor(rnd() * arr.length)]; }
	function jitterTint(c: number[], amt: number): number[]
	{
		const k = 1 + (rnd() - 0.5) * amt;
		return [clamp(c[0] * k, 0, 1), clamp(c[1] * k, 0, 1), clamp(c[2] * k, 0, 1)];
	}

	const landmarks: Landmark[] = [];
	const lamps: Lamp[] = [];
	const trees: Tree[] = [];
	const scenarios: ScenarioDef[] = [];

	function block(i: number, j: number): Rect
	{
		return { x0: dtX[i] + dtXhw[i] + 4, x1: dtX[i + 1] - dtXhw[i + 1] - 4, z0: dtZ[j] + dtZhw[j] + 4, z1: dtZ[j + 1] - dtZhw[j + 1] - 4 };
	}
	function rc(r: Rect): number[] { return [(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2]; }

	const FACE_S = 0, FACE_E = Math.PI / 2, FACE_N = Math.PI, FACE_W = -Math.PI / 2;
	const WHITE = [0.93, 0.93, 0.92], CONCRETE = [0.68, 0.67, 0.64];

	// ---- Downtown landmarks (whole blocks) ----
	const reserved: { [key: string]: boolean } = {};

	// City Hall, block (3,2): civic plaza facing Grand Avenue
	{
		const r = block(3, 2); reserved['3,2'] = true;
		const c = rc(r);
		addBuilding(c[0] + 18, c[1], 34, 56, 18, FACE_W, { style: 'concrete', tint: [0.9, 0.88, 0.82], label: 'CITY HALL' });
		addBuilding(c[0] + 18, c[1], 12, 12, 34, FACE_W, { style: 'concrete', tint: [0.9, 0.88, 0.82], roof: 'flat' });  // clock tower
		landmarks.push({ name: 'City Hall', x: c[0], z: c[1], kind: 'civic' });
	}
	// Central Park, block (1,2)
	{
		reserved['1,2'] = true;
		const r = block(1, 2);
		landmarks.push({ name: 'Central Park', x: rc(r)[0], z: rc(r)[1], kind: 'park' });
		for (let k = 0; k < 70; k++)
		{
			const x = lerp(r.x0 + 3, r.x1 - 3, rnd()), z = lerp(r.z0 + 3, r.z1 - 3, rnd());
			if (Math.abs(x - rc(r)[0]) < 6 || Math.abs(z - rc(r)[1]) < 6) continue;  // footpaths
			trees.push({ x: x, z: z, y: 0, s: 0.8 + rnd() * 0.5, r: rnd() * 6.28, type: 1 });
		}
	}
	// Police Department, block (4,3)
	{
		reserved['4,3'] = true;
		const r = block(4, 3);
		const b = addBuilding(r.x1 - 30, (r.z0 + r.z1) / 2 - 6, 50, 44, 16, FACE_W, { style: 'office', tint: [0.62, 0.7, 0.85], label: 'POLICE DEPARTMENT', custom: 'police', role: 'station' });
		addBuilding(b.x, b.z, 18, 18, 0.25, 0, { style: 'plain', tint: [0.25, 0.25, 0.27], baseY: b.baseY + b.h, collide: true, custom: 'police', role: 'helipad' });  // helipad
		landmarks.push({ name: 'Police Department (Mission Precinct)', x: b.x, z: b.z, kind: 'police' });
	}
	// Hospital, block (2,0)
	{
		reserved['2,0'] = true;
		const r = block(2, 0);
		const c = rc(r);
		const b = addBuilding(c[0], c[1] + 4, 62, 42, 24, FACE_N, { style: 'office', tint: WHITE, label: 'ST. MARY MEDICAL CENTER' });
		const top = b.baseY + b.h;
		addBuilding(b.x, b.z, 18, 18, 0.25, 0, { style: 'plain', tint: [0.22, 0.22, 0.24], baseY: top, collide: true });
		addBuilding(b.x, b.z, 2.5, 10, 0.1, 0, { style: 'plain', tint: [0.85, 0.1, 0.1], baseY: top + 0.25, collide: false });
		addBuilding(b.x, b.z, 10, 2.5, 0.1, 0, { style: 'plain', tint: [0.85, 0.1, 0.1], baseY: top + 0.25, collide: false });
		landmarks.push({ name: 'St. Mary Medical Center', x: b.x, z: b.z, kind: 'hospital' });
	}
	// Courthouse, block (2,2)
	{
		reserved['2,2'] = true;
		const c = rc(block(2, 2));
		addBuilding(c[0], c[1], 54, 40, 20, FACE_E, { style: 'concrete', tint: [0.86, 0.84, 0.78], label: 'COUNTY COURTHOUSE' });
		landmarks.push({ name: 'County Courthouse', x: c[0], z: c[1], kind: 'civic' });
	}
	// Bank tower, block (4,2)
	{
		reserved['4,2'] = true;
		const c = rc(block(4, 2));
		addBuilding(c[0], c[1], 44, 44, 150, FACE_W, { style: 'glass', tint: [0.75, 0.85, 0.95], label: 'MERIDIAN TRUST BANK' });
		landmarks.push({ name: 'Meridian Trust Bank Tower', x: c[0], z: c[1], kind: 'bank' });
	}
	// Fire Station, block (5,4)
	{
		reserved['5,4'] = true;
		const r = block(5, 4);
		addBuilding((r.x0 + r.x1) / 2, r.z1 - 18, 40, 28, 10, FACE_S, { style: 'brick', tint: [0.75, 0.32, 0.26], label: 'FIRE STATION 1' });
		landmarks.push({ name: 'Fire Station 1', x: (r.x0 + r.x1) / 2, z: r.z1 - 18, kind: 'fire' });
	}

	// ---- Downtown fill ----
	const CBD = { x: 260, z: 520 };
	for (let i = 0; i < 7; i++)
	{
		for (let j = 0; j < 6; j++)
		{
			if (reserved[i + ',' + j]) continue;
			const r = block(i, j);
			const bw = r.x1 - r.x0, bd = r.z1 - r.z0;
			if (bw < 12 || bd < 12) continue;
			const nx = bw > 60 ? (rnd() < 0.5 ? 2 : 3) : (bw > 30 ? 2 : 1);
			const nz = bd > 50 ? 2 : 1;
			const gap = 4;
			const cw = (bw - gap * (nx - 1)) / nx, cd = (bd - gap * (nz - 1)) / nz;
			const dist = Math.sqrt((r.x0 + bw / 2 - CBD.x) * (r.x0 + bw / 2 - CBD.x) + (r.z0 + bd / 2 - CBD.z) * (r.z0 + bd / 2 - CBD.z));
			const core = clamp(1 - dist / 380, 0, 1);
			const edgeRow = j === 5;  // boardwalk shops south of Bay Street
			for (let a = 0; a < nx; a++)
			{
				for (let b = 0; b < nz; b++)
				{
					const w = cw * (0.82 + rnd() * 0.18), d = cd * (0.82 + rnd() * 0.18);
					const cx = r.x0 + a * (cw + gap) + cw / 2, cz = r.z0 + b * (cd + gap) + cd / 2;
					let h: number, style: string, tint: number[];
					if (edgeRow) { h = 4 + Math.floor(rnd() * 2) * 3.5; style = 'brick'; tint = jitterTint(pick([[0.95, 0.85, 0.7], [0.85, 0.9, 0.95], [0.95, 0.78, 0.72]]), 0.15); }
					else
					{
						h = 10 + Math.pow(core, 1.6) * 150 * (0.35 + rnd() * 0.65) + rnd() * 8;
						h = Math.round(h / 3.5) * 3.5;
						if (h > 60) { style = 'glass'; tint = jitterTint(pick([[0.7, 0.82, 0.95], [0.6, 0.75, 0.8], [0.8, 0.85, 0.9], [0.55, 0.65, 0.75]]), 0.2); }
						else if (h > 25) { style = 'office'; tint = jitterTint(pick([[0.86, 0.82, 0.74], [0.75, 0.75, 0.75], [0.9, 0.87, 0.8], [0.7, 0.72, 0.78]]), 0.15); }
						else { style = 'brick'; tint = jitterTint(pick([[0.72, 0.38, 0.3], [0.62, 0.42, 0.35], [0.8, 0.7, 0.55], [0.55, 0.5, 0.48]]), 0.15); }
					}
					if (!rectFree(cx, cz, w, d, 0, 3.5, 1)) continue;
					addBuilding(cx, cz, w, d, h, 0, { style: style, tint: tint });
				}
			}
		}
	}

	// Street trees and lamps along downtown avenues/streets
	for (let r = 0; r < roads.length; r++)
	{
		const road = roads[r];
		const inDT = inRect(road.pts[0].x, road.pts[0].z, REGIONS.downtown, 2) && inRect(road.pts[road.pts.length - 1].x, road.pts[road.pts.length - 1].z, REGIONS.downtown, 2);
		const isMain = road.kind === 'highway' || road.name === 'Grand Avenue';
		if (!inDT && !isMain) continue;
		const total = road.pts[road.pts.length - 1].s;
		const step = isMain && !inDT ? 40 : 30;
		for (let s = 10; s < total - 10; s += step)
		{
			// locate point at arc length s
			let i = 0;
			while (i < road.pts.length - 2 && road.pts[i + 1].s < s) i++;
			const a = road.pts[i], b = road.pts[i + 1];
			const t = (s - a.s) / Math.max(b.s - a.s, 1e-6);
			const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
			const tx = b.x - a.x, tz = b.z - a.z, tl = Math.sqrt(tx * tx + tz * tz) || 1;
			const nx = -tz / tl, nz = tx / tl;
			const sides = isMain && !inDT ? [1] : [1, -1];
			for (let k = 0; k < sides.length; k++)
			{
				const off = road.width / 2 + 1.2;
				const lx = x + nx * off * sides[k], lz = z + nz * off * sides[k];
				if (roadClearance(lx, lz) < 0.8 || pointInBuilding(lx, lz, 0.5)) continue;
				lamps.push({ x: lx, y: 0, z: lz, r: Math.atan2(-nx * sides[k], -nz * sides[k]) });
				if (inDT && road.kind !== 'highway')
				{
					const toff = road.width / 2 + 2.6;
					const tx2 = x + nx * toff * sides[k] + (tx / tl) * 15, tz2 = z + nz * toff * sides[k] + (tz / tl) * 15;
					if (roadClearance(tx2, tz2) > 1.5 && !pointInBuilding(tx2, tz2, 1)) trees.push({ x: tx2, y: 0, z: tz2, s: 0.65 + rnd() * 0.25, r: rnd() * 6.28, type: 1 });
				}
			}
		}
	}

	// ---- Verano Pier (south of downtown) ----
	{
		const px = -40, z0 = 772, z1 = 905;
		addBuilding(px, (z0 + z1) / 2, 12, z1 - z0, 0.6, 0, { style: 'wood', tint: [0.55, 0.42, 0.3], baseY: 2.6, collide: true, roof: 'none' });
		for (let z = z0 + 10; z < z1; z += 12)
		{
			addBuilding(px - 5.4, z, 0.6, 0.6, 2.6 + 14, 0, { style: 'wood', tint: [0.4, 0.3, 0.22], baseY: -14, collide: true, roof: 'none' });
			addBuilding(px + 5.4, z, 0.6, 0.6, 2.6 + 14, 0, { style: 'wood', tint: [0.4, 0.3, 0.22], baseY: -14, collide: true, roof: 'none' });
		}
		addBuilding(px, z1 - 10, 10, 8, 4, FACE_N, { style: 'wood', tint: [0.85, 0.75, 0.6], baseY: 3.2, label: 'PIER CAFE', roof: 'gable', roofTint: [0.6, 0.2, 0.15] });
		landmarks.push({ name: 'Verano Pier & Beach', x: px, z: 840, kind: 'leisure' });
	}

	// ---- Eastside commercial strip (Harbor Road) ----
	{
		const g = addBuilding(530, 334, 22, 14, 1, 0, { style: 'plain', tint: [0.9, 0.9, 0.9], baseY: heightAt(530, 334) + 5, label: 'GAS', roofTint: [0.8, 0.15, 0.1] });
		const gy = heightAt(530, 334);
		const pumpsX = [522, 530, 538];
		for (let k = 0; k < 3; k++) addBuilding(pumpsX[k], 334, 1.2, 0.8, 1.6, 0, { style: 'plain', tint: [0.8, 0.15, 0.1] });
		addBuilding(522, 334, 0.5, 0.5, 5.2, 0, { style: 'plain', tint: [0.8, 0.8, 0.8], baseY: gy - 0.2 });
		addBuilding(538, 334, 0.5, 0.5, 5.2, 0, { style: 'plain', tint: [0.8, 0.8, 0.8], baseY: gy - 0.2 });
		addBuilding(530, 312, 18, 10, 4, FACE_S, { style: 'brick', tint: [0.9, 0.9, 0.88], label: '24/7 MARKET' });
		addBuilding(650, 318, 44, 24, 7, FACE_S, { style: 'glass', tint: [0.85, 0.9, 0.95], label: 'VERANO MOTORS' });
		addBuilding(725, 396, 30, 22, 7, FACE_N, { style: 'warehouse', tint: [0.75, 0.75, 0.72], label: 'MECHANIC & BODY SHOP' });
		addBuilding(590, 394, 26, 18, 5, FACE_N, { style: 'brick', tint: [0.85, 0.8, 0.7], label: 'DINER' });
		addBuilding(800, 318, 30, 20, 9, FACE_S, { style: 'office', tint: [0.8, 0.82, 0.86], label: 'MOTEL' });
		landmarks.push({ name: 'Gas station + 24/7 Market (Harbor Rd)', x: 530, z: 330, kind: 'gas' });
		landmarks.push({ name: 'Verano Motors (car dealer)', x: 650, z: 318, kind: 'dealer' });
		landmarks.push({ name: 'Mechanic & Body Shop', x: 725, z: 396, kind: 'mechanic' });
		void g;
	}

	// ---- Port of Verano ----
	{
		const colsX = [470, 560, 680, 800];
		const rowsZ = [470, 600, 720, 800];
		const containerTints = [[0.75, 0.2, 0.15], [0.15, 0.35, 0.65], [0.2, 0.55, 0.3], [0.85, 0.6, 0.15], [0.6, 0.6, 0.62], [0.55, 0.25, 0.5], [0.9, 0.9, 0.88]];
		for (let i = 0; i < colsX.length; i++)
		{
			for (let j = 0; j < rowsZ.length - 1; j++)
			{
				const x0 = colsX[i] + (i === 0 ? 8 : 6) + 4;
				const x1 = (i + 1 < colsX.length ? colsX[i + 1] - 6 : coastX(rowsZ[j]) - 30) - 4;
				const z0 = rowsZ[j] + 6 + 4, z1 = rowsZ[j + 1] - 6 - 4;
				if (x1 - x0 < 20) continue;
				if (i <= 1)
				{
					// warehouses
					const n = Math.max(1, Math.floor((z1 - z0) / 48));
					const dd = (z1 - z0) / n;
					for (let k = 0; k < n; k++)
					{
						const cz = z0 + dd * (k + 0.5);
						if (!rectFree((x0 + x1) / 2, cz, x1 - x0 - 4, dd - 6, 0, 2, 1)) continue;
						addBuilding((x0 + x1) / 2, cz, x1 - x0 - 4, dd - 6, 9 + rnd() * 5, 0, { style: 'warehouse', tint: jitterTint(pick([[0.7, 0.72, 0.75], [0.75, 0.7, 0.6], [0.6, 0.66, 0.72]]), 0.1), roofTint: [0.45, 0.47, 0.5] });
					}
				}
				else
				{
					// container stacks (12.2 x 2.44, stacked 2.6 m)
					for (let cz = z0 + 4; cz < z1 - 4; cz += 16)
					{
						for (let cx = x0 + 2; cx < x1 - 2; cx += 3.2)
						{
							if (rnd() < 0.18) continue;
							const stack = 1 + Math.floor(rnd() * 4);
							if (!rectFree(cx, cz, 2.44, 12.2, 0, 2, 0.3)) continue;
							addBuilding(cx, cz, 2.44, 12.2, stack * 2.6, 0, { style: 'steel', tint: pick(containerTints), roofTint: [0.4, 0.4, 0.42], baseY: heightAt(cx, cz) - 0.1 });
						}
					}
				}
			}
		}
		// Quay cranes along the seawall
		for (let z = 480; z < 800; z += 70)
		{
			const qx = coastX(z) - 14;
			const gy = heightAt(qx, z);
			const steel = [0.85, 0.35, 0.12];
			addBuilding(qx - 9, z - 7, 1.4, 1.4, 42, 0, { style: 'steel', tint: steel, baseY: gy });
			addBuilding(qx + 9, z - 7, 1.4, 1.4, 42, 0, { style: 'steel', tint: steel, baseY: gy });
			addBuilding(qx - 9, z + 7, 1.4, 1.4, 42, 0, { style: 'steel', tint: steel, baseY: gy });
			addBuilding(qx + 9, z + 7, 1.4, 1.4, 42, 0, { style: 'steel', tint: steel, baseY: gy });
			addBuilding(qx + 10, z, 70, 4, 3, 0, { style: 'steel', tint: steel, baseY: gy + 42, collide: false });
		}
		landmarks.push({ name: 'Port of Verano (container terminal)', x: 700, z: 620, kind: 'industrial' });
	}

	// ---- Suburb houses ----
	const houseWalls = [[0.95, 0.94, 0.9], [0.9, 0.85, 0.72], [0.75, 0.82, 0.88], [0.85, 0.78, 0.7], [0.92, 0.9, 0.82], [0.7, 0.75, 0.68]];
	const roofTints = [[0.3, 0.28, 0.27], [0.45, 0.25, 0.2], [0.35, 0.36, 0.4], [0.5, 0.42, 0.35]];
	function houseRow(z: number, x0: number, x1: number, hw: number): void
	{
		for (let side = -1; side <= 1; side += 2)
		{
			for (let x = x0 + 14; x < x1 - 10; x += 19 + rnd() * 4)
			{
				const w = 10 + rnd() * 5, d = 9 + rnd() * 4;
				const cz = z + side * (hw + 7 + d / 2);
				const rot = side < 0 ? FACE_S : FACE_N;
				if (rnd() < 0.08) continue;   // empty lot
				if (!rectFree(x, cz, w, d, rot, 4, 2)) continue;
				const floors = rnd() < 0.45 ? 2 : 1;
				addBuilding(x, cz, w, d, floors * 3, rot, { style: 'house', tint: pick(houseWalls), roof: 'gable', roofTint: pick(roofTints), floors: floors });
				if (rnd() < 0.6)
				{
					const tx = x + (rnd() - 0.5) * 10, tz = cz + side * (d / 2 + 5 + rnd() * 6);
					if (!pointInBuilding(tx, tz, 1.5) && roadClearance(tx, tz) > 2) trees.push({ x: tx, y: 0, z: tz, s: 0.7 + rnd() * 0.5, r: rnd() * 6.28, type: 1 });
				}
			}
		}
	}
	for (let j = 0; j < wsZ.length; j++) houseRow(wsZ[j], -620, -160, 4.5);
	for (let j = 0; j < nsZ.length; j++) houseRow(nsZ[j], -120, 470, 4.5);
	landmarks.push({ name: 'West Suburbs (Willow Park)', x: -400, z: 500, kind: 'residential' });
	landmarks.push({ name: 'North Suburbs (Hillcrest)', x: 170, z: 100, kind: 'residential' });

	// A second gas station + store by the Airport Boulevard / Lakeview junction
	{
		const gx = -560, gz = -150;
		const gy = heightAt(gx, gz);
		addBuilding(gx, gz, 22, 14, 1, FACE_E, { style: 'plain', tint: [0.9, 0.9, 0.9], baseY: gy + 5, label: 'GAS' });
		addBuilding(gx - 6, gz, 0.5, 0.5, 5.2, 0, { style: 'plain', tint: [0.8, 0.8, 0.8], baseY: gy - 0.2 });
		addBuilding(gx + 6, gz, 0.5, 0.5, 5.2, 0, { style: 'plain', tint: [0.8, 0.8, 0.8], baseY: gy - 0.2 });
		addBuilding(gx - 22, gz, 10, 16, 4, FACE_E, { style: 'brick', tint: [0.9, 0.88, 0.85], label: '24/7' });
		landmarks.push({ name: 'Lakeview Gas & 24/7', x: gx, z: gz, kind: 'gas' });
	}

	// ---- Airport ----
	{
		const ty = heightAt(-590, -455);
		addBuilding(-590, -452, 170, 28, 14, FACE_S, { style: 'glass', tint: [0.8, 0.88, 0.95], label: 'SAN VERANO INTERNATIONAL AIRPORT', baseY: ty - 0.8 });
		addBuilding(-420, -478, 8, 8, 30, 0, { style: 'concrete', tint: CONCRETE });
		addBuilding(-420, -478, 12, 12, 5, 0, { style: 'glass', tint: [0.5, 0.65, 0.7], baseY: heightAt(-420, -478) + 30 });
		addBuilding(-880, -505, 50, 40, 14, FACE_N, { style: 'warehouse', tint: [0.8, 0.82, 0.85], label: 'HANGAR 1' });
		addBuilding(-820, -505, 50, 40, 14, FACE_N, { style: 'warehouse', tint: [0.8, 0.82, 0.85], label: 'HANGAR 2' });
		landmarks.push({ name: 'San Verano International Airport', x: -590, z: -560, kind: 'airport' });
	}

	// ---- State Prison ----
	{
		const r = { x0: -925, x1: -715, z0: -955, z1: -805 };
		const gy = heightAt((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
		const wall: BOpts = { style: 'concrete', tint: [0.7, 0.69, 0.66], custom: 'prison', role: 'wall' };
		const wh = 6, wt = 1.2, gateZ = -880, gate = 12;
		addBuilding((r.x0 + r.x1) / 2, r.z0, r.x1 - r.x0, wt, wh, 0, wall);
		addBuilding((r.x0 + r.x1) / 2, r.z1, r.x1 - r.x0, wt, wh, 0, wall);
		addBuilding(r.x0, (r.z0 + r.z1) / 2, wt, r.z1 - r.z0, wh, 0, wall);
		const nLen = (gateZ - gate / 2) - r.z0, sLen = r.z1 - (gateZ + gate / 2);
		addBuilding(r.x1, r.z0 + nLen / 2, wt, nLen, wh, 0, wall);
		addBuilding(r.x1, r.z1 - sLen / 2, wt, sLen, wh, 0, wall);
		const corners = [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1], [r.x1, gateZ - gate / 2 - 3], [r.x1, gateZ + gate / 2 + 3]];
		for (let k = 0; k < corners.length; k++) addBuilding(corners[k][0], corners[k][1], 4.5, 4.5, 13, 0, { style: 'concrete', tint: [0.6, 0.6, 0.58], custom: 'prison', role: 'tower' });
		addBuilding(-850, -925, 90, 20, 10, FACE_S, { style: 'concrete', tint: [0.78, 0.76, 0.7], custom: 'prison', role: 'cellblock' });
		addBuilding(-850, -885, 90, 20, 10, FACE_S, { style: 'concrete', tint: [0.78, 0.76, 0.7], custom: 'prison', role: 'cellblock' });
		addBuilding(-850, -840, 90, 20, 10, FACE_S, { style: 'concrete', tint: [0.78, 0.76, 0.7], custom: 'prison', role: 'cellblock' });
		addBuilding(-745, -905, 22, 16, 7, FACE_E, { style: 'office', tint: [0.75, 0.75, 0.72], label: 'SAN VERANO STATE PRISON', custom: 'prison', role: 'admin' });
		void gy;
		landmarks.push({ name: 'San Verano State Prison', x: -820, z: -880, kind: 'prison' });
	}

	// ---- Farmsteads along Old Mill Road ----
	{
		const farms = [[-860, 60], [-880, 330], [-740, 520], [-720, -40], [-900, -250]];
		for (let k = 0; k < farms.length; k++)
		{
			let fx = farms[k][0], fz = farms[k][1];
			// nudge away from the road
			for (let tries = 0; tries < 10 && roadClearance(fx, fz) < 30; tries++) fx += (fx < -800 ? -8 : 8);
			addBuilding(fx, fz, 12, 10, 6, FACE_E, { style: 'house', tint: [0.95, 0.93, 0.88], roof: 'gable', roofTint: [0.35, 0.3, 0.28], floors: 2 });
			addBuilding(fx - 4, fz + 28, 26, 16, 8, FACE_E, { style: 'wood', tint: [0.62, 0.16, 0.12], roof: 'gable', roofTint: [0.3, 0.3, 0.32], label: k === 0 ? 'VERANO FARMS' : undefined });
			addBuilding(fx + 16, fz + 30, 8, 8, 16, 0, { style: 'silo', tint: [0.78, 0.78, 0.8], roof: 'none' });
		}
		landmarks.push({ name: 'Farmland (Old Mill Road)', x: -840, z: 200, kind: 'farm' });
	}

	// ---- Verano Peak ----
	{
		const ty = heightAt(LOOKOUT.x + 40, LOOKOUT.z - 40);
		addBuilding(LOOKOUT.x + 40, LOOKOUT.z - 40, 1.6, 1.6, 45, 0, { style: 'steel', tint: [0.8, 0.8, 0.82], baseY: ty - 1, custom: 'lookout', role: 'mast' });
		addBuilding(LOOKOUT.x - 14, LOOKOUT.z - 16, 8, 6, 3.5, FACE_S, { style: 'wood', tint: [0.6, 0.48, 0.35], roof: 'gable', roofTint: [0.3, 0.25, 0.2], label: 'VERANO PEAK LOOKOUT', kind: 'house', sub: 'cabin', floors: 1, custom: 'lookout', role: 'cabin' });
		landmarks.push({ name: 'Verano Peak Lookout', x: LOOKOUT.x, z: LOOKOUT.z, kind: 'leisure' });
	}

	landmarks.push({ name: 'Lake Verano', x: LAKE.x, z: LAKE.z, kind: 'water' });

	// --- Natural trees ----------------------------------------------------------
	const TSTEP = 9;
	for (let z = -HALF + 6; z < HALF - 6; z += TSTEP)
	{
		for (let x = -HALF + 6; x < HALF - 6; x += TSTEP)
		{
			const px = x + (rnd() - 0.5) * TSTEP * 0.9, pz = z + (rnd() - 0.5) * TSTEP * 0.9;
			if (inRect(px, pz, REGIONS.downtown) || inRect(px, pz, REGIONS.port) || inRect(px, pz, REGIONS.airport, 20) || inRect(px, pz, REGIONS.prison, 15) || inRect(px, pz, REGIONS.eastside)) continue;
			const h = heightAt(px, pz);
			if (h < 2.2 || h > 195) continue;
			const ld = ((px - LAKE.x) / LAKE.rx) * ((px - LAKE.x) / LAKE.rx) + ((pz - LAKE.z) / LAKE.rz) * ((pz - LAKE.z) / LAKE.rz);
			if (ld < 1.15) continue;
			const f = fbm(n2, px / 260, pz / 260, 3);
			let dens = smoothstep(-0.1, 0.35, f) * 0.8 + mountainMask(px, pz) * 0.55 + smoothstep(860, 980, Math.max(-px, -pz)) * 0.6;
			if (inRect(px, pz, REGIONS.farmland)) dens *= 0.08;
			if (inRect(px, pz, REGIONS.westSuburbs) || inRect(px, pz, REGIONS.northSuburbs)) dens = 0.06;
			dens *= 1 - smoothstep(150, 195, h);
			dens = clamp(dens, 0, 0.92);
			if (rnd() > dens) continue;
			const gx = clamp(Math.round((px + HALF) / CELL), 0, GRID_RES), gz = clamp(Math.round((pz + HALF) / CELL), 0, GRID_RES);
			if (slopeAt(gx, gz) > 0.9) continue;
			if (roadClearance(px, pz) < 4) continue;
			if (pointInBuilding(px, pz, 3)) continue;
			const pine = h > 55 || pz < -300 || fbm(n1, px / 150, pz / 150, 2) > 0.25;
			trees.push({ x: px, y: 0, z: pz, s: 0.75 + rnd() * 0.6, r: rnd() * 6.28, type: pine ? 0 : 1 });
		}
	}
	for (let k = 0; k < trees.length; k++) trees[k].y = heightAt(trees[k].x, trees[k].z) - 0.15;
	for (let k = 0; k < lamps.length; k++) lamps[k].y = heightAt(lamps[k].x, lamps[k].z) - 0.1;

	// =====================================================================================
	// v2 additions: gang neighbourhoods, county sheriff, junction control, street furniture.
	// Uses its own random stream so everything generated above stays exactly the same.
	// =====================================================================================
	const rnd2 = mulberry32(seed * 13 + 77);
	function pick2<T>(arr: T[]): T { return arr[Math.floor(rnd2() * arr.length)]; }
	const props: Prop[] = [];
	const addedBuildings: Building[] = [];
	const hoods: Hood[] = [
		{ name: 'The Flats', x0: -630, x1: -400, z0: 560, z1: 772 },
		{ name: 'Hillcrest Projects', x0: 250, x1: 478, z0: -45, z1: 235 },
		{ name: 'Harbor Row', x0: 478, x1: 862, z0: 250, z1: 445 },
	];
	function hoodAt(x: number, z: number): Hood
	{
		for (let i = 0; i < hoods.length; i++) if (inRect(x, z, hoods[i])) return hoods[i];
		return null;
	}
	function addB2(cx: number, cz: number, w: number, d: number, h: number, rot: number, o: BOpts): Building
	{
		const b = addBuilding(cx, cz, w, d, h, rot, o);
		addedBuildings.push(b);
		return b;
	}
	function addProp(type: string, x: number, z: number, r: number, extra?: { len?: number, color?: number[] }): Prop
	{
		const p: Prop = { type: type, x: x, y: heightAt(x, z), z: z, r: r };
		if (extra && extra.len !== undefined) p.len = extra.len;
		if (extra && extra.color) p.color = extra.color;
		props.push(p);
		return p;
	}
	const rundown = (c: number[]) => { const g = (c[0] + c[1] + c[2]) / 3; return [clamp((c[0] * 0.55 + g * 0.45) * 0.78, 0, 1), clamp((c[1] * 0.55 + g * 0.45) * 0.74, 0, 1), clamp((c[2] * 0.55 + g * 0.45) * 0.7, 0, 1)]; };
	const hoodTints = [[0.62, 0.58, 0.5], [0.55, 0.5, 0.46], [0.6, 0.55, 0.42], [0.5, 0.52, 0.5], [0.58, 0.47, 0.42], [0.47, 0.5, 0.55]];

	// ---- Harbor Row: rowhouses on Harbor Road and project blocks behind them ----
	{
		const roadZ = 360, hw = 6;
		const rowSpans = [[676, 782, -1], [608, 704, 1], [746, 848, 1], [486, 512, 1]];
		for (let k = 0; k < rowSpans.length; k++)
		{
			const side = rowSpans[k][2];
			for (let x = rowSpans[k][0] + 5; x < rowSpans[k][1] - 4; x += 10.5)
			{
				const w = 9.5, d = 10 + rnd2() * 2;
				const cz = roadZ + side * (hw + 4.5 + d / 2);
				const rot = side < 0 ? FACE_S : FACE_N;
				if (!rectFree(x, cz, w, d, rot, 3, 1.2)) continue;
				const b = addB2(x, cz, w, d, 6, rot, { style: 'house', tint: pick2(hoodTints), roof: 'flat', roofTint: [0.25, 0.25, 0.26], kind: 'house', floors: 2 });
				b.district = 'hood';
			}
		}
		const blocks = [[590, 282], [680, 276], [770, 284], [560, 420]];
		for (let k = 0; k < blocks.length; k++)
		{
			const bx = blocks[k][0], bz = blocks[k][1];
			const rot = bz > 400 ? FACE_N : FACE_S;
			if (!rectFree(bx, bz, 30, 14, rot, 4, 3)) continue;
			const b = addB2(bx, bz, 30, 14, 12, rot, { style: 'brick', tint: rundown([0.7, 0.42, 0.34]), roofTint: [0.3, 0.3, 0.3], kind: 'apartment', sub: 'apartment', label: k === 0 ? 'HARBOR ROW HOMES' : undefined });
			b.district = 'hood';
		}
	}
	// ---- Hillcrest Projects / The Flats: a few apartment blocks in free lots ----
	{
		const hp = [hoods[1], hoods[0]];
		for (let h = 0; h < hp.length; h++)
		{
			let placed = 0;
			for (let tries = 0; tries < 400 && placed < 3; tries++)
			{
				const x = lerp(hp[h].x0 + 18, hp[h].x1 - 18, rnd2()), z = lerp(hp[h].z0 + 12, hp[h].z1 - 12, rnd2());
				const rot = rnd2() < 0.5 ? FACE_S : FACE_N;
				if (!rectFree(x, z, 26, 12, rot, 4, 3)) continue;
				const gr = groundRange(x, z, 26, 12, rot);
				if (gr[1] - gr[0] > 2.5) continue;
				const b = addB2(x, z, 26, 12, 9, rot, { style: 'brick', tint: rundown(pick2([[0.72, 0.38, 0.3], [0.62, 0.42, 0.35], [0.8, 0.7, 0.55]])), roofTint: [0.3, 0.3, 0.3], kind: 'apartment', sub: 'apartment' });
				b.district = 'hood';
				placed++;
			}
		}
	}

	// ---- San Verano County Sheriff (second police station, on Lakeview Road) ----
	let sheriff: Building = null;
	{
		const cands = [[40, -122], [-40, -122], [200, -135], [-150, -118], [-260, -118], [250, -150]];
		for (let k = 0; k < cands.length && !sheriff; k++)
		{
			const x = cands[k][0], z = cands[k][1];
			const ld = ((x - LAKE.x) / LAKE.rx) * ((x - LAKE.x) / LAKE.rx) + ((z - LAKE.z) / LAKE.rz) * ((z - LAKE.z) / LAKE.rz);
			if (ld < 1.8) continue;
			if (!rectFree(x, z, 66, 52, FACE_S, 4, 3)) continue;
			const gr = groundRange(x, z, 40, 28, FACE_S);
			if (gr[1] - gr[0] > 3) continue;
			sheriff = addB2(x, z - 6, 40, 26, 9, FACE_S, { style: 'office', tint: [0.86, 0.8, 0.66], roofTint: [0.32, 0.3, 0.28], label: 'COUNTY SHERIFF', custom: 'sheriff', role: 'station', kind: 'civic', sub: 'police' });
			landmarks.push({ name: 'San Verano County Sheriff Station', x: x, z: z, kind: 'police' });
		}
	}

	// ---- Classification (exterior/interior type of every building) ----
	const LABEL_SUB: { [label: string]: string[] } = {
		'CITY HALL': ['civic', 'cityhall'], 'COUNTY COURTHOUSE': ['civic', 'court'], 'MERIDIAN TRUST BANK': ['tower', 'bank'],
		'ST. MARY MEDICAL CENTER': ['civic', 'hospital'], 'FIRE STATION 1': ['civic', 'fire'], 'POLICE DEPARTMENT': ['civic', 'police'],
		'24/7 MARKET': ['shop', 'market'], '24/7': ['shop', 'market'], 'VERANO MOTORS': ['shop', 'dealer'], 'MECHANIC & BODY SHOP': ['shop', 'mechanic'],
		'DINER': ['shop', 'diner'], 'MOTEL': ['shop', 'motel'], 'PIER CAFE': ['shop', 'cafe'], 'SAN VERANO INTERNATIONAL AIRPORT': ['civic', 'terminal'],
		'HANGAR 1': ['warehouse', 'hangar'], 'HANGAR 2': ['warehouse', 'hangar'], 'VERANO FARMS': ['barn', 'barn'], 'SAN VERANO STATE PRISON': ['civic', 'prisonadmin'],
		'HARBOR ROW HOMES': ['apartment', 'apartment'], 'COUNTY SHERIFF': ['civic', 'police'],
	};
	const SHOP_SUBS = ['convenience', 'clothing', 'restaurant', 'barber', 'laundromat', 'restaurant', 'clothing', 'pharmacy'];
	for (let i = 0; i < buildings.length; i++)
	{
		const b = buildings[i];
		const gy = b.groundY !== undefined ? b.groundY : b.baseY;
		const above = b.baseY + b.h - gy;
		const elevated = b.baseY > gy + 1.2;
		if (b.role === 'cellblock') { b.kind = 'civic'; b.sub = 'cellblock'; }
		if (b.label && LABEL_SUB[b.label] && !b.kind) { b.kind = LABEL_SUB[b.label][0]; b.sub = LABEL_SUB[b.label][1]; }
		if (!b.kind)
		{
			if (b.style === 'house') b.kind = 'house';
			else if (b.style === 'steel' || b.style === 'silo' || b.style === 'plain' || b.style === 'wood') b.kind = 'prop';
			else if (b.style === 'warehouse') { b.kind = 'warehouse'; b.sub = 'warehouse'; }
			else if (b.style === 'glass') { b.kind = 'tower'; b.sub = 'lobby'; }
			else if (b.style === 'office') { b.kind = 'office'; b.sub = 'lobby'; }
			else if (b.style === 'brick') { b.kind = 'shop'; b.sub = SHOP_SUBS[(i * 7 + 3) % SHOP_SUBS.length]; }
			else if (b.style === 'concrete') { b.kind = 'office'; b.sub = 'lobby'; }
			else b.kind = 'prop';
		}
		if (b.kind === 'house' && !b.sub) b.sub = 'living';
		if (b.kind === 'house' && !b.floors) b.floors = Math.max(1, Math.min(2, Math.round(above / 3)));
		const big = b.w >= 6 && b.d >= 6 && above >= 2.8;
		b.enterable = b.kind !== 'prop' && big && !elevated && b.role !== 'wall' && b.role !== 'tower';
		// buildings standing on a deck (pier cafe): floor is the deck itself
		if (elevated && b.kind !== 'prop' && !b.custom && b.w >= 6 && b.d >= 6 && b.h >= 2.8 && b.baseY - (b.groundY === undefined ? b.baseY : b.groundY) < 12)
		{
			b.groundY = b.baseY + 0.05;
			b.enterable = true;
		}
		// gang neighbourhoods
		if (b.kind === 'house' && hoodAt(b.x, b.z))
		{
			b.district = 'hood';
			if (addedBuildings.indexOf(b) < 0) b.tint = rundown(b.tint);
			b.roofTint = [b.roofTint[0] * 0.75, b.roofTint[1] * 0.75, b.roofTint[2] * 0.75];
		}
		if (b.district === 'hood')
		{
			const hs = ((i * 2654435761) >>> 0) % 1000 / 1000;
			b.condition = 0.1 + hs * 0.35;
			b.boarded = b.kind === 'house' && hs > 0.84;
		}
		else b.condition = 1;
	}

	// ---- Closed / boarded-up businesses and homes ----
	// About 8-12 % of ordinary shops, offices and houses are closed (roughly a quarter inside the
	// gang neighbourhoods). Own random stream, so nothing generated above or below changes.
	{
		const rndC = mulberry32(seed * 31 + 911);
		for (let i = 0; i < buildings.length; i++)
		{
			const b = buildings[i];
			const roll = rndC();     // drawn for every building so the stream stays aligned
			if (b.custom || b.label || b.role) continue;
			if (b.kind !== 'shop' && b.kind !== 'office' && b.kind !== 'house') continue;
			const hood = b.district === 'hood';
			const chance = hood ? 0.13 : 0.075;
			if (b.boarded || roll < chance)
			{
				b.closed = true;
				if (b.kind === 'house') b.boarded = true;
			}
		}
	}

	// ---- Face every building towards the road ----
	// A building's front (local +Z, where the door, shop window and sign go) must look at a
	// street, never at the side or back wall of a neighbour. For each building we cast a ray
	// out of the middle of each of its 4 walls: a wall whose ray reaches a road before hitting
	// another building is a candidate front; the nearest road wins. Turning by 90 degrees swaps
	// width and depth, so the footprint (and everything already placed around it) stays the same.
	const FRONT_RAY = 70;
	function frontScore(b: Building, r: number, halfDepth: number): number
	{
		const dx = Math.sin(r), dz = Math.cos(r);
		for (let t = halfDepth + 0.6; t < halfDepth + FRONT_RAY; t += 1)
		{
			const x = b.x + dx * t, z = b.z + dz * t;
			if (roadClearance(x, z) <= 0.5) return t - halfDepth;          // reached a street
			if (pointInBuilding(x, z, 0.2)) return 1000 + (t - halfDepth);  // looks at another building
		}
		return 500;                                                        // open ground, no street in reach
	}
	let reoriented = 0; // how many buildings were turned (handy when debugging)
	for (let i = 0; i < buildings.length; i++)
	{
		const b = buildings[i];
		if (b.custom || b.kind === 'prop' || b.kind === 'civic' || b.sub === 'terminal' || b.sub === 'hangar') continue;
		if (b.groundY !== undefined && b.groundY > b.baseY && b.groundY - b.baseY < 0.1) continue; // on a deck (pier cafe)
		const cur = frontScore(b, b.rot, b.d / 2);
		let best = 0, bestScore = cur;
		for (let k = 1; k < 4; k++)
		{
			const sc = frontScore(b, b.rot + k * Math.PI / 2, (k % 2 === 1 ? b.w : b.d) / 2);
			// keep the designed front unless it is blocked / has no street, or another side is clearly closer
			const better = cur >= 500 ? sc < bestScore : (sc < 500 && sc + 4 < bestScore);
			if (better) { best = k; bestScore = sc; }
		}
		if (best === 0) continue;
		b.rot = b.rot + best * Math.PI / 2;
		if (b.rot > Math.PI) b.rot -= Math.PI * 2;
		if (best % 2 === 1) { const t = b.w; b.w = b.d; b.d = t; }
		reoriented++;
	}

	// ---- Keep buildings out of the roads ----
	// A few lots (City Hall's plaza, the odd corner store) were laid out before the final road
	// curves were known, so part of the building sat on the asphalt. Push any building that
	// reaches into a road (plus a sidewalk strip) straight back off it; if it is boxed in by roads on
	// both sides, shrink it instead. Smaller buildings standing inside it (towers, annexes) move too.
	{
		const CLEAR = 2.5;
		const segs: number[][] = [];   // ax, az, bx, bz, halfWidth
		for (let r = 0; r < roads.length; r++)
		{
			const rd = roads[r];
			if (rd.kind === 'runway' || rd.kind === 'taxiway' || rd.kind === 'apron') continue;
			for (let k = 0; k + 1 < rd.pts.length; k++) segs.push([rd.pts[k].x, rd.pts[k].z, rd.pts[k + 1].x, rd.pts[k + 1].z, rd.width / 2]);
		}
		const worst = (b: Building, near: number[][]): number[] =>
		{
			const c = Math.cos(b.rot), sn = Math.sin(b.rot);
			const nx = Math.max(2, Math.ceil(b.w / 2.5)), nz = Math.max(2, Math.ceil(b.d / 2.5));
			let best = 0, bx = 0, bz = 0;
			for (let i = 0; i <= nx; i++)
				for (let j = 0; j <= nz; j++)
				{
					const lx = -b.w / 2 + b.w * i / nx, lz = -b.d / 2 + b.d * j / nz;
					const x = b.x + lx * c + lz * sn, z = b.z - lx * sn + lz * c;
					for (let k = 0; k < near.length; k++)
					{
						const g = near[k];
						const vx = g[2] - g[0], vz = g[3] - g[1];
						const L = vx * vx + vz * vz;
						let t = L > 0 ? ((x - g[0]) * vx + (z - g[1]) * vz) / L : 0;
						t = Math.max(0, Math.min(1, t));
						const px = g[0] + vx * t, pz = g[1] + vz * t;
						const dx = x - px, dz = z - pz;
						const d = Math.sqrt(dx * dx + dz * dz);
						const pen = g[4] + CLEAR - d;
						if (pen > best)
						{
							best = pen;
							// push direction: away from the road centreline (towards the building centre if on it)
							let ux = dx, uz = dz;
							if (d < 0.01) { ux = b.x - px; uz = b.z - pz; }
							const ul = Math.sqrt(ux * ux + uz * uz) || 1;
							bx = ux / ul; bz = uz / ul;
						}
					}
				}
			return [best, bx, bz];
		};
		const insideOf = (o: Building, b: Building, x: number, z: number): boolean =>
		{
			const c = Math.cos(b.rot), sn = Math.sin(b.rot);
			const dx = x - b.x, dz = z - b.z;
			const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
			return Math.abs(lx) <= b.w / 2 + 0.5 && Math.abs(lz) <= b.d / 2 + 0.5;
		};
		let moved = 0;   // count, handy when debugging
		for (let i = 0; i < buildings.length; i++)
		{
			const b = buildings[i];
			if (b.kind === 'prop') continue;
			const R = Math.sqrt(b.w * b.w + b.d * b.d) / 2 + CLEAR + 30;
			const near: number[][] = [];
			for (let k = 0; k < segs.length; k++)
			{
				const g = segs[k];
				if (Math.min(g[0], g[2]) > b.x + R || Math.max(g[0], g[2]) < b.x - R || Math.min(g[1], g[3]) > b.z + R || Math.max(g[1], g[3]) < b.z - R) continue;
				near.push(g);
			}
			if (near.length === 0) continue;
			let wv = worst(b, near);
			if (wv[0] <= 0.05) continue;
			const x0 = b.x, z0 = b.z, w0 = b.w, d0 = b.d;
			const kids: Building[] = [];
			for (let j = 0; j < buildings.length; j++)
			{
				const o = buildings[j];
				if (o !== b && o.kind !== 'prop' && o.w * o.d < b.w * b.d && insideOf(o, b, o.x, o.z)) kids.push(o);
			}
			let tx = 0, tz = 0;
			for (let it = 0; it < 12 && wv[0] > 0.05; it++)
			{
				const step = Math.min(wv[0] + 0.1, 4);
				if (it >= 6 || Math.sqrt(tx * tx + tz * tz) > 14)
				{
					// boxed in: shrink towards the centre instead of sliding further
					b.w = Math.max(6, b.w - step); b.d = Math.max(6, b.d - step);
				}
				else
				{
					b.x += wv[1] * step; b.z += wv[2] * step;
					tx += wv[1] * step; tz += wv[2] * step;
				}
				wv = worst(b, near);
			}
			if (b.x === x0 && b.z === z0 && b.w === w0 && b.d === d0) continue;
			moved++;
			for (let j = 0; j < kids.length; j++) { kids[j].x += tx; kids[j].z += tz; }
			// re-register in the spatial hash at the new spot
			const moveSet = [b].concat(kids);
			for (let m = 0; m < moveSet.length; m++)
			{
				const o = moveSet[m];
				const corners = footprintCorners(o.x, o.z, o.w, o.d, o.rot);
				let ax0 = 1e9, ax1 = -1e9, az0 = 1e9, az1 = -1e9;
				for (let q = 0; q < 4; q++) { ax0 = Math.min(ax0, corners[q][0]); ax1 = Math.max(ax1, corners[q][0]); az0 = Math.min(az0, corners[q][1]); az1 = Math.max(az1, corners[q][1]); }
				for (let gz = clamp(Math.floor((az0 - 4 + HALF) / BH), 0, HN - 1); gz <= clamp(Math.floor((az1 + 4 + HALF) / BH), 0, HN - 1); gz++)
					for (let gx = clamp(Math.floor((ax0 - 4 + HALF) / BH), 0, HN - 1); gx <= clamp(Math.floor((ax1 + 4 + HALF) / BH), 0, HN - 1); gx++)
						if (bHash[gz * HN + gx].indexOf(o.id) < 0) bHash[gz * HN + gx].push(o.id);
			}
			// clear trees, lamps and props the building now stands on
			const clearList = (arr: { x: number; z: number }[]) =>
			{
				for (let k = arr.length - 1; k >= 0; k--) if (insideOf(b, b, arr[k].x, arr[k].z)) arr.splice(k, 1);
			};
			clearList(trees); clearList(lamps); clearList(props);
		}
	}

	// ---- Level the ground under every building ----
	// Buildings used to sit at the HIGHEST ground under their footprint, so on any slope the
	// floor floated 1 to 3 m above the street: a tall dark foundation band (half a house in the
	// hood) and long flights of steps. Now the ground under each building is levelled to the
	// height of the street in front of its door, blended back to the old slope over a few metres.
	{
		const SKIRT = 4, PAD = 1.2;
		const oldH = heights.slice(0);
		const wgt = new Float32Array(VERTS * VERTS);
		const tgt = new Float32Array(VERTS * VERTS);
		const locked = new Uint8Array(VERTS * VERTS);
		const forEachVertex = (b: Building, margin: number, fn: (v: number, dist: number) => void) =>
		{
			const c = Math.cos(b.rot), sn = Math.sin(b.rot);
			const R = Math.sqrt(b.w * b.w + b.d * b.d) / 2 + margin;
			const gx0 = clamp(Math.floor((b.x - R + HALF) / CELL), 0, GRID_RES), gx1 = clamp(Math.ceil((b.x + R + HALF) / CELL), 0, GRID_RES);
			const gz0 = clamp(Math.floor((b.z - R + HALF) / CELL), 0, GRID_RES), gz1 = clamp(Math.ceil((b.z + R + HALF) / CELL), 0, GRID_RES);
			for (let gz = gz0; gz <= gz1; gz++)
				for (let gx = gx0; gx <= gx1; gx++)
				{
					const dx = -HALF + gx * CELL - b.x, dz = -HALF + gz * CELL - b.z;
					const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
					const ex = Math.max(Math.abs(lx) - b.w / 2, 0), ez = Math.max(Math.abs(lz) - b.d / 2, 0);
					const dist = Math.sqrt(ex * ex + ez * ez);
					if (dist <= margin) fn(gz * VERTS + gx, dist);
				}
		};
		const levelled: { b: Building; target: number }[] = [];
		for (let i = 0; i < buildings.length; i++)
		{
			const b = buildings[i];
			const skip = (b.custom && b.role !== 'station') || b.kind === 'prop' || (b as any).fixedBase || b.sub === 'terminal' || b.sub === 'hangar'
				|| (b.groundY !== undefined && b.groundY > b.baseY && b.groundY - b.baseY < 0.1);
			if (skip) { forEachVertex(b, 1.5, (v) => { locked[v] = 1; }); continue; }
			const gr = groundRange(b.x, b.z, b.w, b.d, b.rot);
			const fx = b.x + Math.sin(b.rot) * (b.d / 2 + 2.5), fz = b.z + Math.cos(b.rot) * (b.d / 2 + 2.5);
			const front = heightAt(fx, fz);
			const target = clamp(front, gr[0] - 2.5, gr[1]);
			levelled.push({ b: b, target: target });
			forEachVertex(b, PAD + SKIRT, (v, dist) =>
			{
				const w = dist <= PAD ? 1 : 1 - smoothstep(PAD, PAD + SKIRT, dist);
				if (w > wgt[v]) { wgt[v] = w; tgt[v] = target - 0.03; }
			});
		}
		for (let v = 0; v < wgt.length; v++)
		{
			if (wgt[v] <= 0 || locked[v]) continue;
			const x = -HALF + (v % VERTS) * CELL, z = -HALF + Math.floor(v / VERTS) * CELL;
			if (roadClearance(x, z) < 0.8) continue;      // never move the ground the roads sit on
			heights[v] = lerp(oldH[v], tgt[v], wgt[v]);
		}
		for (let i = 0; i < levelled.length; i++)
		{
			const b = levelled[i].b, t = levelled[i].target;
			const top = b.baseY + b.h;
			const above = top - (b.groundY !== undefined ? b.groundY : b.baseY + 0.8);
			const gr = groundRange(b.x, b.z, b.w, b.d, b.rot);
			b.groundY = Math.max(t, gr[1]);                // a road vertex under a corner can stay a bit higher
			b.baseY = Math.min(gr[0], t) - 0.8;
			b.h = b.groundY + above - b.baseY;
		}
		for (let k = 0; k < trees.length; k++) trees[k].y = heightAt(trees[k].x, trees[k].z) - 0.15;
		for (let k = 0; k < lamps.length; k++) lamps[k].y = heightAt(lamps[k].x, lamps[k].z) - 0.1;
		for (let k = 0; k < props.length; k++) props[k].y = heightAt(props[k].x, props[k].z);
	}

	// ---- Junctions: traffic signals in town, stop signs in the suburbs ----
	const intersections: Intersection[] = [];
	{
		const CTRL: { [k: string]: number } = { highway: 3, avenue: 2, street: 1, rural: 1 };
		interface Cand { x: number; z: number; roads: number[]; }
		const cands: Cand[] = [];
		const addCand = (x: number, z: number, r1: number, r2: number) =>
		{
			for (let k = 0; k < cands.length; k++)
			{
				const c = cands[k];
				if ((c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) < 14 * 14)
				{
					if (c.roads.indexOf(r1) < 0) c.roads.push(r1);
					if (c.roads.indexOf(r2) < 0) c.roads.push(r2);
					return;
				}
			}
			cands.push({ x: x, z: z, roads: [r1, r2] });
		};
		// crossings
		for (let r1 = 0; r1 < roads.length; r1++)
		{
			if (!CTRL[roads[r1].kind]) continue;
			for (let r2 = r1 + 1; r2 < roads.length; r2++)
			{
				if (!CTRL[roads[r2].kind]) continue;
				const A = roads[r1].pts, B = roads[r2].pts;
				for (let i = 0; i < A.length - 1; i++)
				{
					const ax = A[i].x, az = A[i].z, bx = A[i + 1].x, bz = A[i + 1].z;
					const minx = Math.min(ax, bx) - 1, maxx = Math.max(ax, bx) + 1, minz = Math.min(az, bz) - 1, maxz = Math.max(az, bz) + 1;
					for (let j = 0; j < B.length - 1; j++)
					{
						const cx = B[j].x, cz = B[j].z, dx = B[j + 1].x, dz = B[j + 1].z;
						if (Math.max(cx, dx) < minx || Math.min(cx, dx) > maxx || Math.max(cz, dz) < minz || Math.min(cz, dz) > maxz) continue;
						const ex = bx - ax, ez = bz - az, fx = dx - cx, fz = dz - cz;
						const den = ex * fz - ez * fx;
						if (Math.abs(den) < 1e-9) continue;
						const t = ((cx - ax) * fz - (cz - az) * fx) / den;
						const u = ((cx - ax) * ez - (cz - az) * ex) / den;
						if (t >= -0.001 && t <= 1.001 && u >= -0.001 && u <= 1.001) addCand(ax + ex * t, az + ez * t, r1, r2);
					}
				}
			}
		}
		// T-junctions (a road ending on another road)
		for (let r1 = 0; r1 < roads.length; r1++)
		{
			if (!CTRL[roads[r1].kind]) continue;
			const ends = [roads[r1].pts[0], roads[r1].pts[roads[r1].pts.length - 1]];
			for (let e = 0; e < 2; e++)
			{
				for (let r2 = 0; r2 < roads.length; r2++)
				{
					if (r2 === r1 || !CTRL[roads[r2].kind]) continue;
					const B = roads[r2].pts;
					let best = 1e9, bx = 0, bz = 0;
					for (let j = 0; j < B.length - 1; j++)
					{
						const dx = B[j + 1].x - B[j].x, dz = B[j + 1].z - B[j].z;
						const l2 = dx * dx + dz * dz;
						let t = l2 > 0 ? ((ends[e].x - B[j].x) * dx + (ends[e].z - B[j].z) * dz) / l2 : 0;
						t = clamp(t, 0, 1);
						const px = B[j].x + dx * t, pz = B[j].z + dz * t;
						const d = Math.sqrt((px - ends[e].x) * (px - ends[e].x) + (pz - ends[e].z) * (pz - ends[e].z));
						if (d < best) { best = d; bx = px; bz = pz; }
					}
					if (best < roads[r2].width / 2 + 3) addCand(bx, bz, r1, r2);
				}
			}
		}
		const city = (x: number, z: number) => inRect(x, z, REGIONS.downtown, 8) || inRect(x, z, REGIONS.eastside, 8) || inRect(x, z, REGIONS.port, 8);
		const suburb = (x: number, z: number) => inRect(x, z, REGIONS.westSuburbs, 12) || inRect(x, z, REGIONS.northSuburbs, 12);
		for (let k = 0; k < cands.length; k++)
		{
			const c = cands[k];
			const arms: { dx: number; dz: number; hw: number; group: number; rank: number }[] = [];
			let crossHW = 0;
			for (let n = 0; n < c.roads.length; n++)
			{
				const road = roads[c.roads[n]];
				const P = road.pts;
				// nearest station on this road
				let best = 1e9, bs = 0;
				for (let j = 0; j < P.length - 1; j++)
				{
					const dx = P[j + 1].x - P[j].x, dz = P[j + 1].z - P[j].z;
					const l2 = dx * dx + dz * dz;
					let t = l2 > 0 ? ((c.x - P[j].x) * dx + (c.z - P[j].z) * dz) / l2 : 0;
					t = clamp(t, 0, 1);
					const px = P[j].x + dx * t, pz = P[j].z + dz * t;
					const d = (px - c.x) * (px - c.x) + (pz - c.z) * (pz - c.z);
					if (d < best) { best = d; bs = P[j].s + (P[j + 1].s - P[j].s) * t; }
				}
				const total = P[P.length - 1].s;
				const at = (s: number) =>
				{
					let j = 0;
					while (j < P.length - 2 && P[j + 1].s < s) j++;
					const t = clamp((s - P[j].s) / Math.max(P[j + 1].s - P[j].s, 1e-6), 0, 1);
					return [P[j].x + (P[j + 1].x - P[j].x) * t, P[j].z + (P[j + 1].z - P[j].z) * t];
				};
				const tryArm = (s: number) =>
				{
					const p = at(s);
					let dx = p[0] - c.x, dz = p[1] - c.z;
					const l = Math.sqrt(dx * dx + dz * dz);
					if (l < 4) return;
					dx /= l; dz /= l;
					for (let a = 0; a < arms.length; a++) if (arms[a].dx * dx + arms[a].dz * dz > 0.9) return;
					arms.push({ dx: dx, dz: dz, hw: road.width / 2, group: 0, rank: CTRL[road.kind] });
				};
				if (bs > 10) tryArm(Math.max(0, bs - 16));
				if (bs < total - 10) tryArm(Math.min(total, bs + 16));
				crossHW = Math.max(crossHW, road.width / 2);
			}
			if (arms.length < 3) continue;
			for (let a = 0; a < arms.length; a++) arms[a].group = Math.abs(arms[a].dx * arms[0].dx + arms[a].dz * arms[0].dz) > 0.6 ? 0 : 1;
			let control = '';
			if (city(c.x, c.z)) control = 'signal';
			else if (suburb(c.x, c.z) || hoodAt(c.x, c.z)) control = 'stop';
			else control = 'stop';
			const maxRank = Math.max.apply(null, arms.map((a) => a.rank));
			const outArms: { dx: number; dz: number; hw: number; group: number; stop?: boolean }[] = [];
			for (let a = 0; a < arms.length; a++)
			{
				const arm: any = { dx: arms[a].dx, dz: arms[a].dz, hw: arms[a].hw, group: arms[a].group };
				// outside town only the minor road stops; in the suburbs it is an all-way stop
				if (control === 'stop') arm.stop = suburb(c.x, c.z) || hoodAt(c.x, c.z) ? true : arms[a].rank < maxRank;
				outArms.push(arm);
			}
			intersections.push({ x: c.x, z: c.z, y: heightAt(c.x, c.z), control: control, arms: outArms, crossHW: crossHW, phase: ((c.x * 0.013 + c.z * 0.007) % 1 + 1) % 1 });
		}
	}
	function nearJunction(x: number, z: number, r: number): boolean
	{
		for (let k = 0; k < intersections.length; k++)
		{
			const j = intersections[k];
			if ((j.x - x) * (j.x - x) + (j.z - z) * (j.z - z) < r * r) return true;
		}
		return false;
	}

	// ---- More street lights: suburbs, neighbourhoods, port and Harbor Road ----
	const lampCount0 = lamps.length;
	for (let r = 0; r < roads.length; r++)
	{
		const road = roads[r];
		if (road.kind !== 'street' && road.kind !== 'avenue') continue;
		const p0 = road.pts[0], p1 = road.pts[road.pts.length - 1];
		if (inRect(p0.x, p0.z, REGIONS.downtown, 2) && inRect(p1.x, p1.z, REGIONS.downtown, 2)) continue;   // downtown already lit
		if (road.name === 'Grand Avenue' || road.name === 'Terminal Drive') continue;
		const total = p1.s;
		let side = 1;
		for (let s = 12; s < total - 8; s += 44)
		{
			let i = 0;
			while (i < road.pts.length - 2 && road.pts[i + 1].s < s) i++;
			const a = road.pts[i], b = road.pts[i + 1];
			const t = (s - a.s) / Math.max(b.s - a.s, 1e-6);
			const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
			const tx = b.x - a.x, tz = b.z - a.z, tl = Math.sqrt(tx * tx + tz * tz) || 1;
			const nx = -tz / tl, nz = tx / tl;
			side = -side;
			const off = road.width / 2 + 1.2;
			const lx = x + nx * off * side, lz = z + nz * off * side;
			if (roadClearance(lx, lz) < 0.8 || pointInBuilding(lx, lz, 0.8) || nearJunction(lx, lz, road.width / 2 + 7)) continue;
			const hd = hoodAt(lx, lz);
			lamps.push({ x: lx, y: heightAt(lx, lz) - 0.1, z: lz, r: Math.atan2(-nx * side, -nz * side), broken: hd ? rnd2() < 0.35 : false });
		}
	}

	// ---- Street furniture ----
	const sidewalkPoint = (road: Road, s: number, side: number, off: number) =>
	{
		let i = 0;
		while (i < road.pts.length - 2 && road.pts[i + 1].s < s) i++;
		const a = road.pts[i], b = road.pts[i + 1];
		const t = clamp((s - a.s) / Math.max(b.s - a.s, 1e-6), 0, 1);
		const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
		const tx = b.x - a.x, tz = b.z - a.z, tl = Math.sqrt(tx * tx + tz * tz) || 1;
		const nx = -tz / tl, nz = tx / tl;
		const d = road.width / 2 + off;
		return { x: x + nx * d * side, z: z + nz * d * side, face: Math.atan2(-nx * side, -nz * side) };
	};
	const freeSpot = (x: number, z: number, r: number) => roadClearance(x, z) > 0.4 && !pointInBuilding(x, z, r) && !nearJunction(x, z, 9);
	for (let r = 0; r < roads.length; r++)
	{
		const road = roads[r];
		if (road.kind !== 'street' && road.kind !== 'avenue') continue;
		const p0 = road.pts[0];
		const inDT = inRect(p0.x, p0.z, REGIONS.downtown, 2);
		const inSub = inRect(p0.x, p0.z, REGIONS.westSuburbs, 20) || inRect(p0.x, p0.z, REGIONS.northSuburbs, 20);
		const inHood = !!hoodAt(p0.x, p0.z);
		const total = road.pts[road.pts.length - 1].s;
		for (let s = 20 + rnd2() * 20; s < total - 15; s += inDT ? 38 : 70)
		{
			const side = rnd2() < 0.5 ? 1 : -1;
			const h = sidewalkPoint(road, s, side, 1.6);
			if (!freeSpot(h.x, h.z, 0.8)) continue;
			if (inDT || inSub || inHood) addProp('hydrant', h.x, h.z, h.face);
			if (inDT && rnd2() < 0.75)
			{
				const bp = sidewalkPoint(road, s + 9, -side, 2.4);
				if (freeSpot(bp.x, bp.z, 1.2)) { addProp('bench', bp.x, bp.z, bp.face + Math.PI); const tp = sidewalkPoint(road, s + 11.2, -side, 2.0); if (freeSpot(tp.x, tp.z, 0.6)) addProp('trashCan', tp.x, tp.z, tp.face); }
			}
			else if ((inSub || inHood) && rnd2() < 0.25)
			{
				const tp = sidewalkPoint(road, s + 6, -side, 1.4);
				if (freeSpot(tp.x, tp.z, 0.6)) addProp('trashCan', tp.x, tp.z, tp.face);
			}
		}
	}
	// benches in Central Park along the footpaths
	{
		const pk = block(1, 2), c = rc(pk);
		for (let k = -3; k <= 3; k++)
		{
			if (k === 0) continue;
			addProp('bench', c[0] + k * 9, c[1] + 4, Math.PI);
			addProp('bench', c[0] - 4, c[1] + k * 9, Math.PI / 2);
			if (k % 2 === 0) addProp('trashCan', c[0] + k * 9 + 1.6, c[1] + 4.4, 0);
		}
	}
	// dumpsters behind shops / apartment blocks
	for (let i = 0; i < buildings.length; i++)
	{
		const b = buildings[i];
		if (!(b.kind === 'shop' || b.kind === 'apartment')) continue;
		const want = b.kind === 'apartment' ? 2 : (rnd2() < 0.3 ? 1 : 0);
		for (let n = 0; n < want; n++)
		{
			const c = Math.cos(b.rot), s = Math.sin(b.rot);
			const lx = (n === 0 ? -1 : 1) * b.w * 0.25, lz = -b.d / 2 - 1.8;
			const x = b.x + lx * c + lz * s, z = b.z - lx * s + lz * c;
			if (roadClearance(x, z) > 0.5 && !pointInBuilding(x, z, 0.3)) addProp('dumpster', x, z, b.rot);
		}
	}
	// gang neighbourhood dressing: yard fences, wrecks, trash, mattresses, tyres
	for (let i = 0; i < buildings.length; i++)
	{
		const b = buildings[i];
		if (b.district !== 'hood') continue;
		const c = Math.cos(b.rot), s = Math.sin(b.rot);
		const L = (lx: number, lz: number) => [b.x + lx * c + lz * s, b.z - lx * s + lz * c];
		if (b.kind === 'house' && b.w < 20)
		{
			// chain-link front fence with a gap at the path
			const fz = b.d / 2 + 4.2;
			const segs = [[-b.w / 2 - 1.5, -1.2], [1.2, b.w / 2 + 1.5]];
			for (let k = 0; k < segs.length; k++)
			{
				if (rnd2() < 0.2) continue;   // broken / missing panel
				const mid = (segs[k][0] + segs[k][1]) / 2, len = segs[k][1] - segs[k][0];
				const p = L(mid, fz);
				if (roadClearance(p[0], p[1]) > 0.6) addProp('fence', p[0], p[1], b.rot, { len: len });
			}
			if (rnd2() < 0.55) { const p = L((rnd2() - 0.5) * b.w * 0.8, b.d / 2 + 1.5 + rnd2() * 2); if (!pointInBuilding(p[0], p[1], 0.3)) addProp(pick2(['trashBag', 'trashBag', 'tire', 'mattress']), p[0], p[1], rnd2() * 6.28); }
			if (rnd2() < 0.4) { const p = L((rnd2() - 0.5) * b.w * 0.8, b.d / 2 + 2 + rnd2() * 2); if (!pointInBuilding(p[0], p[1], 0.3)) addProp('trashBag', p[0], p[1], rnd2() * 6.28); }
		}
		if (rnd2() < (b.kind === 'apartment' ? 0.9 : 0.22))
		{
			// a wreck in the yard / kerb
			const p = L((rnd2() - 0.5) * b.w * 0.6, b.d / 2 + 2.6);
			if (roadClearance(p[0], p[1]) > 1.2 && !pointInBuilding(p[0], p[1], 1.5)) addProp('wreckedCar', p[0], p[1], b.rot + Math.PI / 2 + (rnd2() - 0.5) * 0.6, { color: pick2([[0.35, 0.12, 0.1], [0.2, 0.22, 0.25], [0.45, 0.4, 0.3], [0.15, 0.15, 0.17]]) });
		}
	}
	// ---- clear trees that the new buildings and props would sit in ----
	{
		const keep: Tree[] = [];
		for (let k = 0; k < trees.length; k++)
		{
			const t = trees[k];
			let ok = true;
			for (let n = 0; n < addedBuildings.length && ok; n++)
			{
				const b = addedBuildings[n];
				const cc = Math.cos(b.rot), ss = Math.sin(b.rot);
				const dx = t.x - b.x, dz = t.z - b.z;
				const lx = dx * cc - dz * ss, lz = dx * ss + dz * cc;
				const m = b.custom === 'sheriff' ? 16 : 3;
				if (Math.abs(lx) <= b.w / 2 + m && Math.abs(lz) <= b.d / 2 + m + (b.custom === 'sheriff' ? 14 : 0)) ok = false;
			}
			if (ok) keep.push(t);
		}
		trees.length = 0;
		for (let k = 0; k < keep.length; k++) trees.push(keep[k]);
	}
	void lampCount0;

	// --- Surface colours -------------------------------------------------------------
	const colors = new Float32Array(VERTS * VERTS * 3);
	const fieldPalette = [[0.78, 0.68, 0.38], [0.42, 0.56, 0.22], [0.45, 0.34, 0.22], [0.52, 0.62, 0.3], [0.66, 0.6, 0.3]];
	for (let gz = 0; gz < VERTS; gz++)
	{
		const z = -HALF + gz * CELL;
		for (let gx = 0; gx < VERTS; gx++)
		{
			const x = -HALF + gx * CELL;
			const h = heights[gz * VERTS + gx];
			const sl = slopeAt(gx, gz);
			const nn = fbm(n3, x / 60, z / 60, 2);
			let c: number[];
			const dry = clamp(0.5 + fbm(n1, x / 400, z / 400, 3) * 0.6, 0, 1);
			c = [lerp(0.33, 0.6, dry), lerp(0.47, 0.56, dry), lerp(0.2, 0.33, dry)];
			const forest = smoothstep(0.0, 0.45, fbm(n2, x / 260, z / 260, 3)) * 0.75 + mountainMask(x, z) * 0.55;
			if (forest > 0.5 && !inRect(x, z, REGIONS.farmland)) c = [lerp(c[0], 0.24, 0.6), lerp(c[1], 0.35, 0.6), lerp(c[2], 0.15, 0.6)];
			if (inRect(x, z, REGIONS.farmland))
			{
				const fxw = (x + fbm(n1, x / 120, z / 120, 2) * 25) / 95, fzw = (z + fbm(n2, x / 120, z / 120, 2) * 25) / 75;
				const ci = Math.abs(Math.floor(fxw) * 7 + Math.floor(fzw) * 13) % fieldPalette.length;
				c = fieldPalette[ci].slice();
				const ex = Math.abs(fxw - Math.round(fxw)), ez = Math.abs(fzw - Math.round(fzw));
				if (ex < 0.04 || ez < 0.05) c = [0.25, 0.36, 0.16];  // hedgerows
				// crop rows
				const rows = 0.93 + 0.07 * Math.sin(x * 1.6);
				c = [c[0] * rows, c[1] * rows, c[2] * rows];
			}
			if (inRect(x, z, REGIONS.westSuburbs) || inRect(x, z, REGIONS.northSuburbs)) c = [0.34, 0.52, 0.22];
			if (inRect(x, z, REGIONS.airport)) c = [0.46, 0.56, 0.3];
			if (inRect(x, z, REGIONS.downtown) || inRect(x, z, REGIONS.port) || inRect(x, z, REGIONS.eastside) || inRect(x, z, REGIONS.prison))
			{
				const pk = block(1, 2);
				c = inRect(x, z, pk, -1) ? [0.32, 0.5, 0.2] : [0.6, 0.6, 0.58];
			}
			const rock = Math.max(smoothstep(0.75, 1.15, sl), smoothstep(210, 260, h));
			c = [lerp(c[0], 0.47, rock), lerp(c[1], 0.45, rock), lerp(c[2], 0.42, rock)];
			const cd = coastDistance(x, z);
			if (cd > -90 && h < 3.2 && seawallMask(x, z) < 0.5) c = [0.84, 0.78, 0.6];
			if (h < 0) c = [0.62, 0.58, 0.45];
			const ld = ((x - LAKE.x) / LAKE.rx) * ((x - LAKE.x) / LAKE.rx) + ((z - LAKE.z) / LAKE.rz) * ((z - LAKE.z) / LAKE.rz);
			if (ld < 1.25) c = ld < 1 ? [0.4, 0.38, 0.3] : [0.7, 0.66, 0.5];
			const clr = roadClearance(x, z);
			if (clr < 2.5 && clr > -1) c = [0.5, 0.48, 0.44];   // gravel shoulder / kerb
			const k = 1 + nn * 0.06;
			const o = (gz * VERTS + gx) * 3;
			colors[o] = clamp(c[0] * k, 0, 1); colors[o + 1] = clamp(c[1] * k, 0, 1); colors[o + 2] = clamp(c[2] * k, 0, 1);
		}
	}

	// Gang neighbourhoods: patchy dead lawns, dirt and stained concrete
	for (let h = 0; h < hoods.length; h++)
	{
		const hd = hoods[h];
		const gx0 = clamp(Math.floor((hd.x0 + HALF) / CELL), 0, GRID_RES), gx1 = clamp(Math.ceil((hd.x1 + HALF) / CELL), 0, GRID_RES);
		const gz0 = clamp(Math.floor((hd.z0 + HALF) / CELL), 0, GRID_RES), gz1 = clamp(Math.ceil((hd.z1 + HALF) / CELL), 0, GRID_RES);
		for (let gz = gz0; gz <= gz1; gz++)
		{
			for (let gx = gx0; gx <= gx1; gx++)
			{
				const x = -HALF + gx * CELL, z = -HALF + gz * CELL;
				if (roadClearance(x, z) < 2.5) continue;
				const o = (gz * VERTS + gx) * 3;
				const patch = fbm(n1, x / 22, z / 22, 2), spots = fbm(n2, x / 7, z / 7, 1);
				const concrete = colors[o] > 0.5 && Math.abs(colors[o] - colors[o + 1]) < 0.05;
				let c = [colors[o], colors[o + 1], colors[o + 2]];
				if (concrete) { const k = 0.78 + 0.18 * patch; c = [c[0] * k * 0.98, c[1] * k * 0.95, c[2] * k * 0.9]; }
				else
				{
					const dry = smoothstep(-0.35, 0.3, patch);
					c = [lerp(c[0], 0.52, dry), lerp(c[1], 0.47, dry), lerp(c[2], 0.28, dry)];
					if (spots > 0.35) c = [0.42, 0.36, 0.27];
				}
				colors[o] = clamp(c[0], 0, 1); colors[o + 1] = clamp(c[1], 0, 1); colors[o + 2] = clamp(c[2], 0, 1);
			}
		}
	}
	// Sheriff station: paved lot in front
	if (sheriff)
	{
		const gx0 = clamp(Math.floor((sheriff.x - 32 + HALF) / CELL), 0, GRID_RES), gx1 = clamp(Math.ceil((sheriff.x + 32 + HALF) / CELL), 0, GRID_RES);
		const gz0 = clamp(Math.floor((sheriff.z - 16 + HALF) / CELL), 0, GRID_RES), gz1 = clamp(Math.ceil((sheriff.z + 40 + HALF) / CELL), 0, GRID_RES);
		for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++)
		{
			const o = (gz * VERTS + gx) * 3;
			colors[o] = 0.5; colors[o + 1] = 0.5; colors[o + 2] = 0.49;
		}
	}

	// --- Scenarios / spawns (Sketchbook "scenario" format) ------------------------------
	function sp(type: string, x: number, z: number, rot: number, extra: number = 0, driver?: string): Spawn
	{
		const y = heightAt(x, z) + (type === 'player' ? 1.1 : 0.4) + extra;
		const s: Spawn = { type: type, x: x, y: y, z: z, rot: rot };
		if (driver) s.driver = driver;
		return s;
	}
	const cityHall = block(3, 2);
	const pd = buildings.filter((b) => b.label === 'POLICE DEPARTMENT')[0];
	const hosp = buildings.filter((b) => b.label === 'ST. MARY MEDICAL CENTER')[0];

	scenarios.push({
		id: 'downtown', name: 'Downtown (City Hall)', isDefault: true, camAngle: 90,
		title: 'Welcome to San Verano County',
		desc: 'You are standing on the City Hall plaza in downtown Port Verano. Grand Avenue runs north to the suburbs and the lake; the Pacific Coast Highway follows the beach.',
		spawns: [sp('player', cityHall.x0 + 8, (cityHall.z0 + cityHall.z1) / 2, FACE_W), sp('car', cityHall.x0 + 4, cityHall.z0 + 6, FACE_N), sp('car', cityHall.x0 + 4, cityHall.z1 - 6, FACE_S)],
	});
	scenarios.push({
		id: 'police', name: 'Police Department', isDefault: false, camAngle: 90,
		title: 'Mission Precinct', desc: 'Patrol cars are parked out front and the department helicopter is on the roof.',
		spawns: [
			sp('player', pd.x - pd.d / 2 - 6, pd.z + 8, FACE_W),
			sp('car', pd.x - pd.d / 2 - 14, pd.z - 12, FACE_N), sp('car', pd.x - pd.d / 2 - 14, pd.z, FACE_N),
			{ type: 'heli', x: pd.x, y: pd.baseY + pd.h + 0.6, z: pd.z, rot: 0 },
		],
	});
	scenarios.push({
		id: 'hospital', name: 'St. Mary Medical Center', isDefault: false, camAngle: 0,
		title: 'St. Mary Medical Center', desc: 'Air ambulance on the rooftop helipad.',
		spawns: [sp('player', hosp.x - 20, hosp.z - hosp.d / 2 - 5, FACE_N), { type: 'heli', x: hosp.x, y: hosp.baseY + hosp.h + 0.6, z: hosp.z, rot: 0 }],
	});
	scenarios.push({
		id: 'airport', name: 'Airport', isDefault: false, camAngle: 270,
		title: 'San Verano International', desc: 'A plane is lined up on runway 09. 680 m of runway, take off to the east.',
		spawns: [sp('player', -885, RWY_Z + 30, FACE_E), sp('airplane', -890, RWY_Z, FACE_E), sp('heli', -650, -500, 0)],
	});
	scenarios.push({
		id: 'port', name: 'Port of Verano', isDefault: false, camAngle: 0,
		title: 'Port of Verano', desc: 'Container terminal, warehouses and quay cranes.',
		spawns: [sp('player', 620, 600 + 10, FACE_E), sp('car', 620, 586, FACE_E)],
	});
	scenarios.push({
		id: 'dealer', name: 'Verano Motors', isDefault: false, camAngle: 180,
		title: 'Verano Motors', desc: 'Pick a car from the lot. Gas, a 24/7 market and the mechanic are on Harbor Road.',
		spawns: [sp('player', 650, 340, FACE_S), sp('car', 625, 344, FACE_E), sp('car', 650, 346, FACE_E), sp('car', 675, 344, FACE_E)],
	});
	scenarios.push({
		id: 'suburbs', name: 'West Suburbs', isDefault: false, camAngle: 0,
		title: 'Willow Park', desc: 'Quiet residential streets west of downtown.',
		spawns: [sp('player', -400, 460 + 8, FACE_E), sp('car', -380, 460 - 2.5, FACE_E)],
	});
	scenarios.push({
		id: 'lookout', name: 'Verano Peak Lookout', isDefault: false, camAngle: 180,
		title: 'Verano Peak', desc: 'The best view in the county. Summit Road winds back down to Route 9.',
		spawns: [sp('player', LOOKOUT.x, LOOKOUT.z + 6, FACE_S), sp('car', LOOKOUT.x + 8, LOOKOUT.z, FACE_S)],
	});
	scenarios.push({
		id: 'prison', name: 'State Prison', isDefault: false, camAngle: 90,
		title: 'San Verano State Prison', desc: 'Main gate on the east wall, reached by Prison Road.',
		spawns: [sp('player', -700, -890, FACE_W), sp('car', -690, -870, FACE_E)],
	});

	{
		const hr = buildings.filter((b) => b.label === 'HARBOR ROW HOMES')[0];
		const hx = hr ? hr.x : 700, hz = hr ? hr.z + hr.d / 2 + 14 : 300;
		scenarios.push({
			id: 'hood', name: 'Harbor Row (neighbourhood)', isDefault: false, camAngle: 180,
			title: 'Harbor Row', desc: 'Run-down rowhouses and project blocks on Harbor Road, between the port and the car dealer.',
			spawns: [sp('player', hx, hz, FACE_S), sp('car', hx + 10, hz + 4, FACE_E)],
		});
		scenarios.push({
			id: 'flats', name: 'The Flats (neighbourhood)', isDefault: false, camAngle: 90,
			title: 'The Flats', desc: 'The rough south-west corner of Willow Park.',
			spawns: [sp('player', -520, 600 + 8, FACE_E), sp('car', -500, 600 - 2.5, FACE_E)],
		});
		if (sheriff)
		{
			scenarios.push({
				id: 'sheriff', name: 'County Sheriff', isDefault: false, camAngle: 0,
				title: 'San Verano County Sheriff', desc: 'Sheriff station on Lakeview Road, north of Hillcrest.',
				spawns: [sp('player', sheriff.x, sheriff.z + sheriff.d / 2 + 6, FACE_S), sp('car', sheriff.x - 12, sheriff.z + sheriff.d / 2 + 16, FACE_S), sp('car', sheriff.x + 12, sheriff.z + sheriff.d / 2 + 16, FACE_S)],
			});
		}
	}

	const r0 = scenarios[0].spawns[0];
	const stats: { [key: string]: number } = {
		roads: roads.length,
		roadKm: Math.round(roads.reduce((acc, r) => acc + r.pts[r.pts.length - 1].s, 0)) / 1000,
		buildings: buildings.length,
		trees: trees.length,
		lamps: lamps.length,
		props: props.length,
		junctions: intersections.length,
		signals: intersections.filter((j) => j.control === 'signal').length,
		enterable: buildings.filter((b) => b.enterable).length,
		hoodBuildings: buildings.filter((b) => b.district === 'hood').length,
		ms: Date.now() - t0,
	};

	return {
		seed: seed, heights: heights, colors: colors, roads: roads, buildings: buildings, trees: trees, lamps: lamps,
		props: props, intersections: intersections, hoods: hoods,
		scenarios: scenarios, landmarks: landmarks, lake: LAKE,
		respawn: { x: r0.x, y: r0.y + 1, z: r0.z },
		heightAt: heightAt, roadClearance: roadClearance, stats: stats,
	};
}
