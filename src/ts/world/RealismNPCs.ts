/*
 * RealismNPCs.ts
 * --------------
 * Pedestrians for San Verano County.
 *
 *  - Walk graph: both sidewalks of every street / avenue (sampled every ~8 m, 1.7 m outside the
 *    kerb), joined at every junction by corner walks and crosswalks (painted zebra stripes are
 *    added to the junction arms the graph uses). Signal junctions: people wait for the walk phase
 *    (the traffic light of the road they cross is red).
 *  - Who lives in the city (every district gets people):
 *      residents  part of the ordinary houses are NPC homes (doors locked for good for the player,
 *                 "Private residence", RealismDoors.markPrivate). People leave / enter by the front door.
 *      workers    apartments, offices, towers, hotels, the hospital, city hall, the court, the fire
 *                 station, police / sheriff stations, warehouses, the airport terminal and hangars:
 *                 people come and go through the entrance (or the front of the building when it has
 *                 no door), shop, stroll and go back. Buildings with no sidewalk nearby (airport,
 *                 port, hangars) get people walking up and down in front of them instead.
 *      wanderers  people who just walk the sidewalks, some of them jogging.
 *      benches    people sitting on the benches downtown / in the park, and people waiting next to
 *                 them; after a while they get up and walk off, others come.
 *  - Errands: walk to a shop, go inside (despawn for a while), then another shop, a stroll, or home.
 *    At night (world.realismTime.hour, if another system provides it) most people go home.
 *  - Population: every person is a cheap abstract agent (a position along a path). Only the nearest
 *    walking / sitting people inside npcs.radius get a body: a pooled male/female GLB clone with
 *    walk/run animation and per-person skin tone variation. maxVisible bodies at most = maxVisible draw calls.
 *  - Size: people are drawn at the player's scale (contract C5: world.realismPlayerScale when the
 *    player system has set it, else REALISM_CONFIG.player.scale, default 1). Walk speed, stride, hit boxes, colliders and the
 *    "step aside" radius scale with it.
 *  - Reactions: shot (world.realismNPCs.damage) -> falls over and disappears after a while,
 *    people nearby run away. Gunfire (world.realismWeapons.stats.shots going up) scares everyone
 *    within ~45 m of the player. Hit by a moving vehicle -> falls over too. They stop for the
 *    player on foot and step aside; near the player they get a small collider.
 *  - Traffic (RealismTraffic.ts) is told about density changes and panics.
 *
 * API (world as any).realismNPCs:
 *    hitTest(origin, dir, maxDist) -> { distance, point, npc } | null
 *    damage(npc, amount, dir)
 *    panic(point, radius?)          everyone near the point runs away (gunshots, explosions); drivers too
 *    setDensity(0..2), getDensity() also sets the traffic density (world.realismTraffic.setDensity)
 *    addFleeing(x, y, z, fromX, fromZ)  a person appears there and runs away (a car-jacked driver)
 *    countNear(x, z, r)             { walking, visible } people near a point
 *    playerScale                    the scale people are drawn at
 *    stats, counts
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx, chunkKey, RENDER_CHUNK, addMesh } from './RealismContext';
import { AccumSet } from './RealismGeometry';
import { Road, Building, Intersection } from './RealismMapData';
import { NPCVehicles, NPCHome } from './RealismNPCVehicles';

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export interface NPCSettings
{
	enabled: boolean;
	density: number;        // 0..2, multiplies everyone
	residents: number;      // people living in each NPC home at density 1
	workers: number;        // multiplies the people working in each big building (about 2..10 each)
	wanderers: number;      // multiplies the people who just walk the sidewalks (about 1 per 190 m of sidewalk)
	joggers: number;        // 0..1 share of the wanderers who jog
	sitters: number;        // multiplies the people on / next to benches
	maxVisible: number;     // bodies drawn at once
	radius: number;         // metres around the player where people get a body
	homeShare: number;      // 0..1 share of the ordinary houses that are NPC homes
	parkedCars: boolean;
	carShare: number;       // 0..1 share of NPC homes with a car parked out front
	maxRealCars: number;    // drivable cars spawned around the player at once
	carAlarm: boolean;
	crosswalks: boolean;
	gunfirePanic: number;   // metres around the player people run from gunfire (0 = off)
}

export function npcSettings(ctx: RealismCtx): NPCSettings
{
	const w: any = typeof window !== 'undefined' ? window : {};
	const raw: any = (ctx.cfg as any).npcs || (w.REALISM_CONFIG && w.REALISM_CONFIG.npcs) || {};
	const low = ctx.presetName === 'low', high = ctx.presetName === 'high' || ctx.presetName === 'ultra';
	const num = (v: any, d: number, a: number, b: number) => (typeof v === 'number' && isFinite(v) ? Math.max(a, Math.min(b, v)) : d);
	return {
		enabled: raw.enabled !== false,
		density: num(raw.density, 1, 0, 2),
		residents: num(raw.residents, 3, 0.5, 6),
		workers: num(raw.workers, 1, 0, 4),
		wanderers: num(raw.wanderers, 1, 0, 4),
		joggers: num(raw.joggers, 0.15, 0, 1),
		sitters: num(raw.sitters, 1, 0, 3),
		maxVisible: Math.round(num(raw.maxVisible, low ? 16 : (high ? 32 : 24), 0, 60)),
		radius: num(raw.radius, low ? 120 : (high ? 150 : 135), 40, 250),
		homeShare: num(raw.homeShare, 0.55, 0, 1),
		parkedCars: raw.parkedCars !== false,
		carShare: num(raw.carShare, 0.6, 0, 1),
		maxRealCars: Math.round(num(raw.maxRealCars, 3, 1, 6)),
		carAlarm: raw.carAlarm !== false,
		crosswalks: raw.crosswalks !== false,
		gunfirePanic: num(raw.gunfirePanic, 45, 0, 200),
	};
}

/** Contract C5: the scale humans are drawn at: world.realismPlayerScale (the scale A10 actually applied
 *  to the player) when it is set, else config player.scale, else 1. */
export function playerScaleOf(ctx: RealismCtx): number
{
	const w: any = typeof window !== 'undefined' ? window : {};
	const ws = ctx.world ? (ctx.world as any).realismPlayerScale : undefined;
	let s = typeof ws === 'number' && isFinite(ws) && ws > 0 ? ws : NaN;
	if (!isFinite(s))
	{
		const cfgP: any = (ctx.cfg as any).player || (w.REALISM_CONFIG && w.REALISM_CONFIG.player) || null;
		s = cfgP && typeof cfgP.scale === 'number' && isFinite(cfgP.scale) && cfgP.scale > 0 ? cfgP.scale : 1;
	}
	return Math.max(0.3, Math.min(3, s));
}

// ---------------------------------------------------------------------------
// model loading (Sketchbook assets, with the same fallbacks as LoadingManager)
// ---------------------------------------------------------------------------

const modelCache: { [path: string]: { state: string; gltf?: any; waiting: ((g: any) => void)[]; failing: (() => void)[] } } = {};
let npcLoader: GLTFLoader = null;

function candidates(path: string): string[]
{
	const list = [path];
	if (/^(https?:)?\/\//.test(path)) return list;
	const clean = path.replace(/^\.?\//, '');
	if (list.indexOf('/' + clean) < 0) list.push('/' + clean);
	const cfg: any = (typeof window !== 'undefined' && (window as any).REALISM_CONFIG) || {};
	let fb: string = cfg.assetFallbackUrl === undefined ? 'https://cdn.jsdelivr.net/gh/Anonymous666064/RealismRoleplay@main/Sketchbook-master/' : cfg.assetFallbackUrl;
	if (fb) { if (fb.charAt(fb.length - 1) !== '/') fb += '/'; list.push(fb + clean); }
	return list;
}

/** Loads a .glb once (shared gltf). Tries the path, /path, then assetFallbackUrl + path. */
export function loadSharedModel(path: string, done: (gltf: any) => void, failed?: () => void): void
{
	let e = modelCache[path];
	if (e === undefined)
	{
		e = { state: 'loading', waiting: [], failing: [] };
		modelCache[path] = e;
		const entry = e;
		const list = candidates(path);
		const attempt = (i: number) =>
		{
			if (entry.state !== 'loading') return;
			try
			{
				if (!npcLoader) npcLoader = new GLTFLoader();
				npcLoader.load(list[i], (gltf: any) => injectModel(path, gltf), undefined, () =>
				{
					if (i + 1 < list.length) attempt(i + 1);
					else
					{
						entry.state = 'failed';
						console.warn('[Realism] NPCs: could not load ' + path + ', using a simple stand-in.');
						const f = entry.failing; entry.failing = []; entry.waiting = [];
						for (let k = 0; k < f.length; k++) f[k]();
					}
				});
			}
			catch (err) { entry.state = 'failed'; }
		};
		attempt(0);
	}
	if (e.state === 'ready') done(e.gltf);
	else if (e.state === 'loading') { e.waiting.push(done); if (failed) e.failing.push(failed); }
	else if (failed) failed();
}

/** Hands a parsed gltf to everything waiting for `path` (also used by the headless tests). */
export function injectModel(path: string, gltf: any): void
{
	let e = modelCache[path];
	if (e === undefined) { e = { state: 'loading', waiting: [], failing: [] }; modelCache[path] = e; }
	if (e.state === 'ready') return;
	e.state = 'ready';
	e.gltf = gltf;
	const w = e.waiting; e.waiting = []; e.failing = [];
	for (let k = 0; k < w.length; k++) { try { w[k](gltf); } catch (err) { console.warn('[Realism] NPC model callback failed', err); } }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function hash01(n: number): number
{
	let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
	return x - Math.floor(x);
}

function now(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

const SIDEWALK_OFF = 1.7;     // metres outside the kerb
const STEP = 8;               // sidewalk sample spacing
const CELL = 24;              // node grid

/** Footprints of every building, for "is this point inside a building" tests. */
class Footprints
{
	private grid: { [k: string]: number[] } = {};
	private bs: Building[];
	constructor(bs: Building[])
	{
		this.bs = bs;
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.h < 0.8) continue;
			const r = Math.sqrt(b.w * b.w + b.d * b.d) / 2 + 1;
			for (let gx = Math.floor((b.x - r) / 16); gx <= Math.floor((b.x + r) / 16); gx++)
				for (let gz = Math.floor((b.z - r) / 16); gz <= Math.floor((b.z + r) / 16); gz++)
					(this.grid[gx + '_' + gz] || (this.grid[gx + '_' + gz] = [])).push(i);
		}
	}
	public inside(x: number, z: number, margin: number, skip: number = -1): boolean
	{
		const list = this.grid[Math.floor(x / 16) + '_' + Math.floor(z / 16)];
		if (!list) return false;
		for (let k = 0; k < list.length; k++)
		{
			if (list[k] === skip) continue;
			const b = this.bs[list[k]];
			const dx = x - b.x, dz = z - b.z, c = Math.cos(b.rot), s = Math.sin(b.rot);
			const lx = dx * c - dz * s, lz = dx * s + dz * c;
			if (Math.abs(lx) < b.w / 2 + margin && Math.abs(lz) < b.d / 2 + margin) return true;
		}
		return false;
	}
}

// ---------------------------------------------------------------------------
// walk graph
// ---------------------------------------------------------------------------

/** Pedestrian network: nodes on sidewalks, junction corners and building fronts. */
export class WalkGraph
{
	public x: number[] = []; public y: number[] = []; public z: number[] = [];
	public kind: number[] = [];            // 0 sidewalk, 1 junction corner, 2 building front
	public adj: number[][] = [];
	public adjJ: number[][] = [];          // crosswalk edges: junction index * 2 + group, else -1
	public comp: Int32Array = null;
	public keep: Uint8Array = null;        // node is in a big enough connected piece
	public crossings: { j: number; arm: number; a: number; b: number }[] = [];
	private grid: { [k: string]: number[] } = {};
	private pg: Float32Array = null; private pfrom: Int32Array = null; private pstamp: Int32Array = null; private pclosed: Int32Array = null;
	private stampNo = 0;
	private heap: number[] = []; private hf: number[] = [];

	public add(x: number, y: number, z: number, kind: number): number
	{
		const i = this.x.length;
		this.x.push(x); this.y.push(y); this.z.push(z); this.kind.push(kind);
		this.adj.push([]); this.adjJ.push([]);
		return i;
	}

	public link(a: number, b: number, j: number = -1): void
	{
		if (a === b || a < 0 || b < 0) return;
		if (this.adj[a].indexOf(b) >= 0) return;
		this.adj[a].push(b); this.adjJ[a].push(j);
		this.adj[b].push(a); this.adjJ[b].push(j);
	}

	public dist(a: number, b: number): number
	{
		const dx = this.x[a] - this.x[b], dz = this.z[a] - this.z[b];
		return Math.sqrt(dx * dx + dz * dz);
	}

	/** Labels connected pieces; keeps the ones with at least `minSize` nodes and indexes them. */
	public finish(minSize: number): void
	{
		const n = this.x.length;
		this.comp = new Int32Array(n).fill(-1);
		const sizes: number[] = [];
		const stack: number[] = [];
		for (let i = 0; i < n; i++)
		{
			if (this.comp[i] >= 0) continue;
			const c = sizes.length;
			let size = 0;
			stack.push(i); this.comp[i] = c;
			while (stack.length)
			{
				const v = stack.pop(); size++;
				const a = this.adj[v];
				for (let k = 0; k < a.length; k++) if (this.comp[a[k]] < 0) { this.comp[a[k]] = c; stack.push(a[k]); }
			}
			sizes.push(size);
		}
		this.keep = new Uint8Array(n);
		this.grid = {};
		for (let i = 0; i < n; i++)
		{
			if (sizes[this.comp[i]] < minSize) continue;
			this.keep[i] = 1;
			if (this.kind[i] === 2) continue;
			const k = Math.floor(this.x[i] / CELL) + '_' + Math.floor(this.z[i] / CELL);
			(this.grid[k] || (this.grid[k] = [])).push(i);
		}
	}

	/** Nearest kept sidewalk / corner nodes within r, nearest first. */
	public near(x: number, z: number, r: number, max: number): number[]
	{
		const out: number[] = [], d2: number[] = [];
		for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++)
			for (let gz = Math.floor((z - r) / CELL); gz <= Math.floor((z + r) / CELL); gz++)
			{
				const list = this.grid[gx + '_' + gz];
				if (!list) continue;
				for (let k = 0; k < list.length; k++)
				{
					const i = list[k];
					const dx = this.x[i] - x, dz = this.z[i] - z, dd = dx * dx + dz * dz;
					if (dd > r * r) continue;
					out.push(i); d2.push(dd);
				}
			}
		const idx = out.map((_, k) => k).sort((a, b) => d2[a] - d2[b]);
		return idx.slice(0, max).map((k) => out[k]);
	}

	/** A* shortest path, node list from a to b (inclusive), or null. */
	public path(a: number, b: number, maxExpand: number = 20000): number[]
	{
		if (a < 0 || b < 0) return null;
		if (a === b) return [a];
		if (this.comp[a] !== this.comp[b]) return null;
		const n = this.x.length;
		// scratch arrays are reused between searches (a stamp marks which entries are valid)
		if (!this.pg || this.pg.length < n) { this.pg = new Float32Array(n); this.pfrom = new Int32Array(n); this.pstamp = new Int32Array(n); this.pclosed = new Int32Array(n); }
		this.stampNo++;
		const stamp = this.stampNo, gA = this.pg, fromA = this.pfrom, st = this.pstamp, cl = this.pclosed;
		const G = (i: number) => (st[i] === stamp ? gA[i] : 1e30);
		const heap = this.heap, hf = this.hf;
		heap.length = 0; hf.length = 0;
		const bx = this.x[b], bz = this.z[b];
		const h = (i: number) => { const dx = this.x[i] - bx, dz = this.z[i] - bz; return Math.sqrt(dx * dx + dz * dz); };
		const push = (i: number, f: number) =>
		{
			heap.push(i); hf.push(f);
			let c = heap.length - 1;
			while (c > 0)
			{
				const p = (c - 1) >> 1;
				if (hf[p] <= hf[c]) break;
				const ti = heap[p]; heap[p] = heap[c]; heap[c] = ti;
				const tf = hf[p]; hf[p] = hf[c]; hf[c] = tf;
				c = p;
			}
		};
		const pop = () =>
		{
			const top = heap[0];
			const li = heap.pop(), lf = hf.pop();
			if (heap.length)
			{
				heap[0] = li; hf[0] = lf;
				let c = 0;
				for (;;)
				{
					const l = c * 2 + 1, r = l + 1;
					let m = c;
					if (l < heap.length && hf[l] < hf[m]) m = l;
					if (r < heap.length && hf[r] < hf[m]) m = r;
					if (m === c) break;
					const ti = heap[m]; heap[m] = heap[c]; heap[c] = ti;
					const tf = hf[m]; hf[m] = hf[c]; hf[c] = tf;
					c = m;
				}
			}
			return top;
		};
		st[a] = stamp; gA[a] = 0; fromA[a] = -1; push(a, h(a));
		let expanded = 0, found = false;
		while (heap.length)
		{
			const v = pop();
			if (cl[v] === stamp) continue;
			if (v === b) { found = true; break; }
			cl[v] = stamp;
			if (++expanded > maxExpand) return null;
			const adj = this.adj[v], aj = this.adjJ[v];
			const gv = gA[v];
			for (let k = 0; k < adj.length; k++)
			{
				const u = adj[k];
				if (cl[u] === stamp) continue;
				// building fronts are only entered as the goal (never walked through)
				if (this.kind[u] === 2 && u !== b) continue;
				const cost = gv + this.dist(v, u) * (aj[k] >= 0 ? 1.3 : 1);
				if (cost < G(u)) { st[u] = stamp; gA[u] = cost; fromA[u] = v; push(u, cost + h(u)); }
			}
		}
		if (!found || st[b] !== stamp) return null;
		const out: number[] = [];
		for (let v = b, guard = 0; v >= 0 && guard < n; v = (v === a ? -1 : fromA[v]), guard++) out.push(v);
		out.reverse();
		return out[0] === a ? out : null;
	}
}

interface Dest
{
	kind: number;           // 0 home, 1 shop, 2 workplace, 3 bench
	b: number;              // building index (bench: prop index)
	door: number;           // door index (RealismDoors) or -1
	dx: number; dy: number; dz: number;   // just inside the door / the seat
	node: number;           // graph node in front of the door (-1: not on the walk graph)
	hx: number; hz: number; // bench: the way a sitter faces
	cap: number;            // workplace: people working there at density 1
	plaza: number[];        // no graph link: a walk line in front of the building [ax, ay, az, bx, by, bz]
}

interface Leg
{
	pts: Float32Array;      // x, y, z per point
	cum: Float32Array;      // distance at each point
	segJ: Int32Array;       // per segment: crosswalk (junction * 2 + group) or -1; -2 = door path
	total: number;
	startDest: number;      // leaving this destination's door (-1 = from the street)
	endDest: number;        // entering this destination's door (-1 = stroll, ends on the street)
}

const S_HOME = 0, S_WALK = 1, S_INSIDE = 2, S_DEAD = 3, S_PENDING = 4, S_OFF = 5, S_STAND = 6;
const R_RES = 0, R_WORK = 1, R_WANDER = 2, R_JOG = 3, R_SIT = 4, R_PLAZA = 5, R_TEMP = 6;
const ROLE_NAMES = ['residents', 'workers', 'wanderers', 'joggers', 'benches', 'plaza', 'fleeing'];

interface Agent
{
	id: number;
	role: number;
	home: number;                    // dest index (-1: none)
	seat: number;                    // bench: 0 / 1 sitting, 2 standing next to it
	state: number;
	timer: number;
	leg: Leg;
	prog: number;
	seg: number;
	dir: number;
	speed: number;
	baseSpeed: number;
	lane: number;
	laneBoost: number;
	blocked: number;
	waiting: boolean;
	flee: number;
	pendingFlee: number;
	pose: number;                    // while standing: 0 idle, 1 sitting
	x: number; y: number; z: number;
	hx: number; hz: number;          // heading
	vis: NPCBody;
	health: number;
	at: number;                      // shop they are inside (-1 none)
	look: number;                    // clothing seed
	scale: number;                   // personal size (times the player scale when drawn)
	req: { from: number; to: number; startDest: number; endDest: number; mid: boolean } | null;
	detained: boolean;
	stunTimer: number;
	stunState: number;
	stunAgentTimer: number;
	stunLeg: Leg;
	stunProg: number;
}

interface RosterEntry { role: number; home: number; seat: number; key: number; }

/** A pooled body (what weapons get back from hitTest as `npc`). */
export interface NPCBody
{
	root: THREE.Object3D;
	tilt: THREE.Object3D;
	visual: THREE.Group;
	model: THREE.Object3D;
	mixer: THREE.AnimationMixer;
	walk: THREE.AnimationAction;
	idle: THREE.AnimationAction;
	run: THREE.AnimationAction;
	sit: THREE.AnimationAction;
	variantIndex: number;
	modelBaseScale: number;
	modelBaseMinY: number;
	modelFitScale: number;
	modelFitY: number;
	modelSeatedScale: number;
	modelSeatedY: number;
	wWalk: number; wRun: number; wSit: number;
	agent: Agent;
	geom: THREE.BufferGeometry;      // own copy (clothes colours)
	legs: THREE.Object3D[];          // stand-in only
	deadT: number;                   // > 0 while lying on the ground
	fallAxis: number;
	animAcc: number;
	frame: number;
	body: CANNON.Body;
	alive: boolean;
}

const SKIN = [[0.96, 0.8, 0.66], [0.87, 0.67, 0.5], [0.72, 0.52, 0.36], [0.55, 0.38, 0.26], [0.4, 0.27, 0.18], [0.98, 0.86, 0.74]];
const SHIRT = [[0.85, 0.15, 0.15], [0.15, 0.3, 0.75], [0.95, 0.95, 0.95], [0.12, 0.12, 0.13], [0.2, 0.55, 0.3], [0.95, 0.75, 0.2], [0.55, 0.3, 0.6], [0.5, 0.5, 0.52], [0.9, 0.45, 0.6], [0.3, 0.6, 0.8], [0.45, 0.32, 0.22]];
const PANTS = [[0.2, 0.25, 0.4], [0.12, 0.12, 0.13], [0.45, 0.42, 0.35], [0.3, 0.32, 0.36], [0.55, 0.45, 0.3], [0.25, 0.3, 0.5], [0.6, 0.6, 0.62]];
const WORK_SHIRT = [[0.12, 0.12, 0.13], [0.95, 0.95, 0.95], [0.2, 0.25, 0.4], [0.5, 0.5, 0.52], [0.3, 0.6, 0.8]];

// boxman 'sitting' pose: hips (body_lower) sit 0.07 m above the model origin, 0.06 m behind it
const SIT_HIP_Y = 0.07, SIT_HIP_Z = -0.06, BENCH_SEAT_Y = 0.46, BENCH_SEAT_Z = -0.02;

/** Building kinds whose people come and go all day (sub = interior type). */
function workCapacity(b: Building): number
{
	if (b.closed || b.kind === 'prop' || b.kind === 'house' || b.kind === 'shop' || b.kind === 'barn') return 0;
	if (b.sub === 'cellblock' || b.sub === 'prisonadmin' || b.custom === 'prison' || b.custom === 'lookout') return 0;
	const k = b.kind;
	if (k !== 'office' && k !== 'tower' && k !== 'apartment' && k !== 'hotel' && k !== 'civic' && k !== 'warehouse') return 0;
	const area = Math.max(40, b.w * b.d);
	let n = area / 160 * Math.min(3, Math.max(1, b.h / 10));
	if (b.sub === 'hospital' || b.sub === 'cityhall' || b.sub === 'terminal' || k === 'hotel') n = Math.max(n, 8);
	if (b.sub === 'police' || b.sub === 'court' || b.sub === 'fire') n = Math.max(n, 5);
	if (k === 'warehouse' || b.sub === 'hangar') n = Math.min(n, 3);
	if (k === 'apartment') n *= 1.5;
	return Math.max(2, Math.min(12, Math.round(n)));
}

// ---------------------------------------------------------------------------
// the system
// ---------------------------------------------------------------------------

export class RealismNPCs implements IUpdatable
{
	public updateOrder: number = 8;
	public settings: NPCSettings;
	public graph: WalkGraph;
	public dests: Dest[] = [];
	public homes: number[] = [];       // dest indices
	public shops: number[] = [];
	public works: number[] = [];
	public benches: number[] = [];
	public agents: Agent[] = [];       // agents[i] belongs to roster[i]
	public extras: Agent[] = [];       // people who are not part of the population (fleeing drivers)
	public roster: RosterEntry[] = [];
	public bodies: NPCBody[] = [];
	public vehicles: NPCVehicles = null;
	public stats: { [k: string]: number } = {};
	public playerScale = 1;
	private ctx: RealismCtx;
	private signals: any;
	private free: NPCBody[] = [];
	private density = 1;
	private queue: Agent[] = [];
	private matAcc = 0;
	private frameNo = 0;
	private playerPos = new THREE.Vector3();
	private havePlayer = false;
	private playerOnFoot = false;
	private gltf: any = null;
	private modelState = 0;          // 0 loading, 1 GLB models loaded, 2 stand-in
	private modelVariants: any[] = [];
	private sharedMat: THREE.Material = null;
	private clips: { walk: THREE.AnimationClip; idle: THREE.AnimationClip; run: THREE.AnimationClip; sit: THREE.AnimationClip } = null;
	private bodyPool: CANNON.Body[] = [];
	private bodyPoolScale = 1;
	private bodyMat: CANNON.Material;
	private tmpV = new THREE.Vector3();
	private tmpP = new THREE.Vector3();
	private nextId = 0;
	private homeSet: { [b: number]: boolean } = {};
	private walkNodes: number[] = [];  // kept sidewalk nodes (wanderers start / respawn here)
	private lastShots = -1;

	constructor(ctx: RealismCtx, signals: any, settings: NPCSettings)
	{
		this.ctx = ctx;
		this.signals = signals;
		this.settings = settings;
		this.density = settings.density;
		this.playerScale = playerScaleOf(ctx);
		this.bodyMat = new CANNON.Material('npcMat');
		this.bodyMat.friction = 0.1;
	}

	// -----------------------------------------------------------------------
	// building
	// -----------------------------------------------------------------------

	public build(): void
	{
		const t0 = now();
		const ctx = this.ctx, data = ctx.data;
		const fp = new Footprints(data.buildings);
		const g = new WalkGraph();
		this.graph = g;

		// ---- junction corners + crosswalks
		const J = data.intersections;
		const junctionR: number[] = [];
		const corners: { node: number; j: number }[] = [];
		for (let j = 0; j < J.length; j++)
		{
			const I: Intersection = J[j];
			const R = I.crossHW + 2.7;
			junctionR.push(R);
			// arms sorted by angle so corner k joins arm k's left kerb to arm k+1's right kerb
			const order = I.arms.map((_, k) => k).sort((a, b) => Math.atan2(I.arms[a].dz, I.arms[a].dx) - Math.atan2(I.arms[b].dz, I.arms[b].dx));
			const pp: number[][] = [];
			for (let k = 0; k < I.arms.length; k++) pp.push([-1, -1]);
			for (let oi = 0; oi < order.length; oi++)
			{
				const k = order[oi];
				const a = I.arms[k];
				const nx = -a.dz, nz = a.dx, off = a.hw + SIDEWALK_OFF;
				const mk = (sgn: number) =>
				{
					const x = I.x + a.dx * R + nx * off * sgn, z = I.z + a.dz * R + nz * off * sgn;
					if (fp.inside(x, z, 0.2) || data.heightAt(x, z) < 0.15) return -1;
					const id = g.add(x, data.heightAt(x, z), z, 1);
					corners.push({ node: id, j: j });
					return id;
				};
				pp[k][0] = mk(1); pp[k][1] = mk(-1);
				if (pp[k][0] >= 0 && pp[k][1] >= 0)
				{
					g.link(pp[k][0], pp[k][1], j * 2 + (a.group || 0));
					g.crossings.push({ j: j, arm: k, a: pp[k][0], b: pp[k][1] });
				}
			}
			for (let oi = 0; oi < order.length; oi++)
			{
				const k = order[oi], k2 = order[(oi + 1) % order.length];
				const a = pp[k][0], b = pp[k2][1];
				if (a < 0 || b < 0) continue;
				// the corner walk must stay off the roadway
				const mx = (g.x[a] + g.x[b]) / 2, mz = (g.z[a] + g.z[b]) / 2;
				if (data.roadClearance(mx, mz) > 0.3 && !fp.inside(mx, mz, 0.1)) g.link(a, b);
			}
		}
		const nearJunction = (x: number, z: number) =>
		{
			for (let j = 0; j < J.length; j++)
			{
				const dx = x - J[j].x, dz = z - J[j].z, r = junctionR[j] + 1.2;
				if (dx * dx + dz * dz < r * r) return true;
			}
			return false;
		};

		// ---- sidewalks
		const chainEnds: number[] = [];
		for (let r = 0; r < data.roads.length; r++)
		{
			const road: Road = data.roads[r];
			if (road.kind !== 'street' && road.kind !== 'avenue') continue;
			const total = road.pts[road.pts.length - 1].s;
			for (let side = -1; side <= 1; side += 2)
			{
				let prev = -1;
				const n = Math.max(2, Math.ceil(total / STEP) + 1);
				for (let k = 0; k < n; k++)
				{
					const s = Math.min(total, k * total / (n - 1));
					const p = sidewalkPoint(road, s, side, SIDEWALK_OFF);
					const ground = data.heightAt(p.x, p.z);
					const ok = !nearJunction(p.x, p.z) && data.roadClearance(p.x, p.z) > SIDEWALK_OFF - 0.6 && !fp.inside(p.x, p.z, 0.35)
						&& ground > 0.15 && ground > p.y - 1.4;
					if (!ok) { if (prev >= 0) chainEnds.push(prev); prev = -1; continue; }
					const id = g.add(p.x, ground, p.z, 0);
					if (prev >= 0) g.link(prev, id); else chainEnds.push(id);
					prev = id;
				}
				if (prev >= 0) chainEnds.push(prev);
			}
		}
		// chain ends join the nearest junction corner on the same kerb
		const segClear = (ax: number, az: number, bx: number, bz: number, minClr: number) =>
		{
			const L = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
			const n = Math.max(1, Math.ceil(L / 2));
			for (let k = 1; k < n; k++)
			{
				const t = k / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
				if (data.roadClearance(x, z) < minClr || fp.inside(x, z, 0.05)) return false;
			}
			return true;
		};
		for (let c = 0; c < chainEnds.length; c++)
		{
			const e = chainEnds[c];
			if (g.adj[e].length >= 2) continue;
			let best = -1, bd = 18;
			for (let k = 0; k < corners.length; k++)
			{
				const v = corners[k].node;
				const d = g.dist(e, v);
				if (d < bd && segClear(g.x[e], g.z[e], g.x[v], g.z[v], 0.25)) { bd = d; best = v; }
			}
			if (best >= 0) g.link(e, best);
		}
		g.finish(25);

		// ---- destinations: NPC homes (private), shops, workplaces
		const doors: any = ctx.doors;
		const bs = data.buildings;
		const linkTo = (fx: number, fz: number, fy: number) =>
		{
			const cand = g.near(fx, fz, 45, 6);
			for (let k = 0; k < cand.length; k++)
			{
				const v = cand[k];
				if (segClear(fx, fz, g.x[v], g.z[v], 0.15))
				{
					const node = g.add(fx, fy, fz, 2);
					g.link(node, v);
					return node;
				}
			}
			return -1;
		};
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			let kind = -1, cap = 0;
			if (b.kind === 'house' && !b.custom && !b.closed && b.enterable && hash01(i * 3.7 + data.seed * 0.013) < this.settings.homeShare) kind = 0;
			else if (b.kind === 'shop' && !b.closed && !b.custom && b.enterable) kind = 1;
			else if ((cap = workCapacity(b)) > 0) kind = 2;
			if (kind < 0) continue;
			let door = -1, dx = 0, dy = 0, dz = 0;
			const group = 'b' + i;
			const list: number[] = doors && doors.doorsOfGroup ? doors.doorsOfGroup(group) : [];
			for (let k = 0; k < list.length; k++)
			{
				const info = doors.doorInfo(list[k]);
				if (info && (info.label === 'Front door' || info.label === 'Entrance' || (kind === 2 && info.label !== 'Back door' && info.label !== 'Door')))
				{ door = list[k]; dx = info.x; dy = info.y; dz = info.z; break; }
			}
			const ox = Math.sin(b.rot), oz = Math.cos(b.rot);
			if (door < 0)
			{
				if (kind !== 2) continue;     // replaced by a user model / no door: skip
				// workplace without a door of its own (hotels, custom buildings): the middle of the front
				dx = b.x + ox * (b.d / 2 + 0.3); dz = b.z + oz * (b.d / 2 + 0.3);
				dy = data.heightAt(dx, dz);
				if (dy < 0.15 || fp.inside(dx + ox * 0.8, dz + oz * 0.8, 0.1, -1)) continue;
			}
			const fx = dx + ox * 1.1, fz = dz + oz * 1.1;
			const fy = Math.max(data.heightAt(fx, fz), dy - 0.4);
			const node = linkTo(fx, fz, fy);
			let plaza: number[] = null;
			if (node < 0)
			{
				if (kind !== 2) continue;
				plaza = this.plazaLine(b, dx, dz, fp);
				if (!plaza) continue;
			}
			const d: Dest = { kind: kind, b: i, door: door, dx: dx - ox * 0.5, dy: dy, dz: dz - oz * 0.5, node: node, hx: ox, hz: oz, cap: cap, plaza: plaza };
			this.dests.push(d);
			const di = this.dests.length - 1;
			if (kind === 0) { this.homes.push(di); this.homeSet[i] = true; if (doors.markPrivate) doors.markPrivate(group); }
			else if (kind === 1) this.shops.push(di);
			else this.works.push(di);
		}
		// ---- benches: people sit on them / wait next to them
		const props = data.props;
		for (let i = 0; i < props.length; i++)
		{
			const p = props[i];
			if (p.type !== 'bench') continue;
			const fx = Math.sin(p.r), fz = Math.cos(p.r);
			const node = linkTo(p.x + fx * 0.9, p.z + fz * 0.9, data.heightAt(p.x + fx * 0.9, p.z + fz * 0.9));
			if (node < 0) continue;
			const d: Dest = { kind: 3, b: i, door: -1, dx: p.x, dy: Math.max(p.y, data.heightAt(p.x, p.z)), dz: p.z, node: node, hx: fx, hz: fz, cap: 0, plaza: null };
			this.dests.push(d);
			this.benches.push(this.dests.length - 1);
		}
		g.finish(25);
		for (let i = 0; i < g.x.length; i++) if (g.keep[i] && g.kind[i] === 0) this.walkNodes.push(i);

		// ---- painted crosswalks on the arms people use
		let painted = 0;
		if (this.settings.crosswalks) painted = this.paintCrosswalks();

		this.buildRoster();
		this.stats = {
			nodes: g.x.length, crossings: g.crossings.length, crosswalksPainted: painted,
			homes: this.homes.length, shops: this.shops.length, workplaces: this.works.length,
			plazas: this.works.filter((k) => !!this.dests[k].plaza).length, benches: this.benches.length,
			roster: this.roster.length, buildMs: Math.round(now() - t0),
		};
		this.setDensity(this.density);
		this.loadModel();
	}

	/** A walk line along the front of a building that has no sidewalk near it. */
	private plazaLine(b: Building, dx: number, dz: number, fp: Footprints): number[]
	{
		const data = this.ctx.data;
		const ox = Math.sin(b.rot), oz = Math.cos(b.rot);
		const ax = Math.cos(b.rot), az = -Math.sin(b.rot);      // along the front
		const half = Math.max(3, Math.min(18, b.w / 2 - 1));
		const out = 3.2;
		const pts: number[] = [];
		for (let s = -1; s <= 1; s += 2)
		{
			let L = half;
			for (; L > 2; L -= 1.5)
			{
				const x = dx + ox * out + ax * L * s, z = dz + oz * out + az * L * s;
				if (!fp.inside(x, z, 0.4) && data.heightAt(x, z) > 0.15 && data.roadClearance(x, z) > 0.5) break;
			}
			if (L <= 2) return null;
			const x = dx + ox * out + ax * L * s, z = dz + oz * out + az * L * s;
			pts.push(x, data.heightAt(x, z), z);
		}
		return pts;
	}

	private paintCrosswalks(): number
	{
		const ctx = this.ctx, data = ctx.data, g = this.graph;
		const set = new AccumSet();
		const up = [0, 1, 0], col = [0.92, 0.92, 0.88];
		let n = 0;
		for (let c = 0; c < g.crossings.length; c++)
		{
			const cr = g.crossings[c];
			if (!g.keep[cr.a] || !g.keep[cr.b] || g.adj[cr.a].length < 2 || g.adj[cr.b].length < 2) continue;
			const I = data.intersections[cr.j];
			const a = I.arms[cr.arm];
			const R = I.crossHW + 2.7;
			const nx = -a.dz, nz = a.dx;
			const acc = set.get(chunkKey(I.x, I.z, RENDER_CHUNK));
			for (let l = -a.hw + 0.45; l + 0.5 <= a.hw - 0.35; l += 1.05)
			{
				const q = [[R - 1.4, l], [R - 1.4, l + 0.5], [R + 1.4, l + 0.5], [R + 1.4, l]].map((p) =>
				{
					const x = I.x + a.dx * p[0] + nx * p[1], z = I.z + a.dz * p[0] + nz * p[1];
					return [x, Math.max(I.y, data.heightAt(x, z)) + 0.135, z];
				});
				const e1 = [q[1][0] - q[0][0], q[1][2] - q[0][2]], e2 = [q[2][0] - q[0][0], q[2][2] - q[0][2]];
				if (e1[0] * e2[1] - e1[1] * e2[0] > 0) q.reverse();
				acc.face(q, up, [[0, 0], [0, 0], [0, 0], [0, 0]], col);
			}
			n++;
		}
		for (let k = 0; k < set.keys.length; k++)
		{
			const geom = set.get(set.keys[k]).toGeometry();
			const m = addMesh(ctx, geom, ctx.mats.road_marking, false, true, 'street');
			m.name = 'crosswalks';
		}
		return n;
	}

	// -----------------------------------------------------------------------
	// population
	// -----------------------------------------------------------------------

	/** Everyone who can be out at density 2, mixed so that any first part of the list is a fair sample. */
	private buildRoster(): void
	{
		const st = this.settings, seed = this.ctx.data.seed;
		const R: RosterEntry[] = [];
		let key = 0;
		const add = (role: number, home: number, seat: number) => { R.push({ role: role, home: home, seat: seat, key: hash01(key * 1.618 + seed * 0.37 + 0.5) }); key++; };
		for (let k = 0; k < this.homes.length; k++)
		{
			const n = Math.round(st.residents * 2 * (0.8 + hash01(k * 5.3) * 0.4));
			for (let q = 0; q < n; q++) add(R_RES, this.homes[k], 0);
		}
		for (let k = 0; k < this.works.length; k++)
		{
			const d = this.dests[this.works[k]];
			const n = Math.round(d.cap * st.workers * 2);
			for (let q = 0; q < n; q++) add(d.plaza ? R_PLAZA : R_WORK, this.works[k], 0);
		}
		const nw = Math.round(this.walkNodes.length / 24 * st.wanderers * 2);
		for (let q = 0; q < nw; q++) add(hash01(q * 7.77 + 3.3) < st.joggers ? R_JOG : R_WANDER, -1, 0);
		for (let k = 0; k < this.benches.length; k++)
		{
			const h = hash01(k * 2.71 + seed * 0.11);
			const share = Math.min(1, 0.55 * st.sitters);
			if (h < share) add(R_SIT, this.benches[k], 0);
			if (hash01(k * 4.13 + 0.7) < share * 0.6) add(R_SIT, this.benches[k], 1);
			if (hash01(k * 6.07 + 1.9) < share * 0.45) add(R_SIT, this.benches[k], 2);
		}
		R.sort((a, b) => a.key - b.key);
		if (R.length > 4000) R.length = 4000;
		this.roster = R;
	}

	public getDensity(): number { return this.density; }

	public setDensity(n: number): void
	{
		const d = Math.max(0, Math.min(2, isFinite(n) ? n : 1));
		this.density = d;
		const want = this.settings.enabled ? Math.min(this.roster.length, Math.round(this.roster.length * d / 2)) : 0;
		// park everyone above the new count
		for (let i = want; i < this.agents.length; i++)
		{
			const a = this.agents[i];
			if (a.state !== S_OFF) { this.releaseBody(a); a.state = S_OFF; a.leg = null; a.req = null; }
		}
		for (let i = 0; i < want; i++)
		{
			if (i < this.agents.length)
			{
				const a = this.agents[i];
				if (a.state === S_OFF) this.wake(a, false);
				continue;
			}
			this.agents.push(this.makeAgent(i));
		}
		this.stats.agents = want;
		const t: any = (this.ctx.world as any).realismTraffic;
		if (t && typeof t.setDensity === 'function') { try { t.setDensity(d); } catch (e) { console.warn('[Realism] traffic setDensity failed', e); } }
	}

	private makeAgent(i: number): Agent
	{
		const spec = this.roster[i];
		const r = (k: number) => hash01(i * 13.37 + k * 7.11 + this.ctx.data.seed * 0.1);
		const jog = spec.role === R_JOG;
		const a: Agent = {
			id: this.nextId++, role: spec.role, home: spec.home, seat: spec.seat, state: S_HOME, timer: r(1) * 50, leg: null, prog: 0, seg: 0, dir: 1,
			speed: 0, baseSpeed: jog ? 2.6 + r(2) * 0.6 : 1.2 + r(2) * 0.45, lane: 0.25 + r(3) * 0.35, laneBoost: 0, blocked: 0, waiting: false, flee: 0, pendingFlee: 0, pose: 0,
			x: 0, y: 0, z: 0, hx: 0, hz: 1, vis: null, health: 100, at: -1, look: Math.floor(r(4) * 100000), scale: 0.93 + r(5) * 0.12, req: null,
			detained: false, stunTimer: 0, stunState: S_WALK, stunAgentTimer: 0, stunLeg: null, stunProg: 0,
		};
		this.wake(a, true, r(6));
		return a;
	}

	/** Puts a parked / new agent back into the world. */
	private wake(a: Agent, first: boolean, rnd: number = Math.random()): void
	{
		a.leg = null; a.req = null; a.flee = 0; a.pendingFlee = 0; a.health = 100; a.at = -1;
		if (a.role === R_RES || a.role === R_WORK)
		{
			const hd = this.dests[a.home];
			a.x = hd.dx; a.y = hd.dy; a.z = hd.dz;
			a.state = S_HOME; a.timer = 2 + rnd * 40;
			// some people are already out when the game starts
			if (rnd < (a.role === R_WORK ? 0.6 : 0.5)) this.startErrand(a, true);
		}
		else if (a.role === R_PLAZA)
		{
			if (rnd < 0.7) this.plazaLeg(a, rnd < 0.35, true);
			else { const hd = this.dests[a.home]; a.x = hd.dx; a.y = hd.dy; a.z = hd.dz; a.state = S_HOME; a.timer = 2 + rnd * 30; }
		}
		else if (a.role === R_SIT && rnd < 0.65) this.takeSeat(a);
		else
		{
			this.placeOnSidewalk(a, first ? -1 : 200);
			a.state = S_INSIDE;
			this.startErrand(a, true);
		}
	}

	/** Moves an agent to a random kept sidewalk node (at least `minFromPlayer` m from the player). */
	private placeOnSidewalk(a: Agent, minFromPlayer: number): void
	{
		const g = this.graph, W = this.walkNodes;
		if (!W.length) return;
		let v = W[Math.floor(hash01(a.id * 3.1 + a.look) * W.length) % W.length];
		for (let k = 0; k < 12; k++)
		{
			const c = W[Math.floor(Math.random() * W.length)];
			if (minFromPlayer < 0 || !this.playerNear(g.x[c], g.z[c], minFromPlayer)) { v = c; break; }
		}
		a.x = g.x[v]; a.y = g.y[v]; a.z = g.z[v];
	}

	/** Bench people: sit down (seat 0 / 1) or stand next to the bench (seat 2). */
	private takeSeat(a: Agent): void
	{
		const d = this.dests[a.home];
		const s = a.scale * this.playerScale;
		const ax = d.hz, az = -d.hx;          // along the bench
		if (a.seat < 2)
		{
			const along = a.seat === 0 ? -0.45 : 0.45;
			const back = BENCH_SEAT_Z - SIT_HIP_Z * s;
			a.x = d.dx + ax * along + d.hx * back;
			a.z = d.dz + az * along + d.hz * back;
			a.y = d.dy + BENCH_SEAT_Y - SIT_HIP_Y * s + 0.02;
			a.hx = d.hx; a.hz = d.hz; a.pose = 1;
		}
		else
		{
			// waiting next to the bench, looking at the street behind it
			a.x = d.dx + ax * 1.35 - d.hx * 0.45;
			a.z = d.dz + az * 1.35 - d.hz * 0.45;
			a.y = this.ctx.data.heightAt(a.x, a.z);
			a.hx = -d.hx; a.hz = -d.hz; a.pose = 0;
		}
		a.leg = null;
		a.state = S_STAND;
		a.speed = 0;
		a.timer = 40 + Math.random() * 120;
	}

	private playerNear(x: number, z: number, r: number): boolean
	{
		if (!this.havePlayer) return false;
		const dx = x - this.playerPos.x, dz = z - this.playerPos.z;
		return dx * dx + dz * dz < r * r;
	}

	private night(): boolean
	{
		const t: any = (this.ctx.world as any).realismTime;
		if (!t || typeof t.hour !== 'number') return false;
		return t.hour >= 21 || t.hour < 6;
	}

	/** Walk line in front of a building without sidewalks: from one end to the other. */
	private plazaLeg(a: Agent, reverse: boolean, mid: boolean): void
	{
		const P = this.dests[a.home].plaza;
		const p0 = reverse ? 3 : 0, p1 = reverse ? 0 : 3;
		const pts = new Float32Array([P[p0], P[p0 + 1], P[p0 + 2], P[p1], P[p1 + 1], P[p1 + 2]]);
		const L = Math.sqrt((pts[3] - pts[0]) * (pts[3] - pts[0]) + (pts[5] - pts[2]) * (pts[5] - pts[2]));
		a.leg = { pts: pts, cum: new Float32Array([0, L]), segJ: new Int32Array([-1]), total: L, startDest: -1, endDest: -1 };
		a.prog = mid ? Math.random() * L * 0.8 : 0;
		a.seg = 0; a.dir = 1; a.state = S_WALK; a.waiting = false;
		this.locate(a);
	}

	/** Picks where to go next and asks for a path. */
	private startErrand(a: Agent, mid: boolean = false): void
	{
		const g = this.graph;
		if (a.role === R_PLAZA) { this.plazaLeg(a, Math.random() < 0.5, false); return; }
		const fromDest = a.state === S_HOME ? a.home : (a.state === S_INSIDE ? a.at : (a.state === S_STAND && a.role === R_SIT && !a.leg ? a.home : -1));
		const start = fromDest >= 0 && this.dests[fromDest].node >= 0 ? this.dests[fromDest].node : this.nearestNode(a.x, a.z);
		if (start < 0) { a.state = S_HOME; a.timer = 30; return; }
		let endDest = -1, goal = -1;
		const hasHome = a.role === R_RES || a.role === R_WORK;
		const nightNow = this.night() && hash01(a.id * 1.3 + Math.floor(now() / 60000)) > 0.12;
		const r = Math.random();
		let strollMin = 40, strollMax = 320;
		if (a.role === R_JOG) { strollMin = 150; strollMax = 520; }
		if (hasHome && (nightNow || (fromDest !== a.home && r < 0.4))) { endDest = a.home; }
		else if (a.role === R_SIT && fromDest !== a.home && r < 0.55) { endDest = a.home; }
		else if (a.role !== R_JOG && a.role !== R_TEMP && this.shops.length && (hasHome ? r < 0.82 : r < 0.25))
		{
			// a few random shops, the nearest one wins (people shop near home mostly)
			let best = -1, bd = 1e18;
			const hx = g.x[start], hz = g.z[start];
			for (let k = 0; k < 4; k++)
			{
				const s = this.shops[Math.floor(Math.random() * this.shops.length)];
				const n = this.dests[s].node;
				if (n < 0) continue;
				const d = (g.x[n] - hx) * (g.x[n] - hx) + (g.z[n] - hz) * (g.z[n] - hz);
				if (d < bd && s !== fromDest) { bd = d; best = s; }
			}
			endDest = best;
		}
		if (endDest >= 0) goal = this.dests[endDest].node;
		else
		{
			// stroll to a random sidewalk point
			for (let k = 0; k < 14 && goal < 0; k++)
			{
				const v = this.walkNodes.length ? this.walkNodes[Math.floor(Math.random() * this.walkNodes.length)] : Math.floor(Math.random() * g.x.length);
				if (!g.keep[v] || g.kind[v] === 2 || g.comp[v] !== g.comp[start]) continue;
				const dd = g.dist(v, start);
				if (dd < strollMax && dd > strollMin) goal = v;
			}
			if (goal < 0)
			{
				// nothing in range: a short walk along the nearest nodes
				const nb = g.near(g.x[start], g.z[start], 90, 30);
				for (let k = nb.length - 1; k >= 0 && goal < 0; k--) if (g.comp[nb[k]] === g.comp[start] && nb[k] !== start) goal = nb[k];
				if (goal < 0 && hasHome) { endDest = a.home; goal = this.dests[a.home].node; }
				if (goal < 0) { a.state = S_INSIDE; a.at = -1; a.timer = 20 + Math.random() * 30; this.releaseBody(a); return; }
			}
		}
		a.req = { from: start, to: goal, startDest: fromDest, endDest: endDest, mid: mid };
		a.state = S_PENDING;
		this.queue.push(a);
	}

	private nearestNode(x: number, z: number): number
	{
		const n = this.graph.near(x, z, 60, 1);
		if (n.length) return n[0];
		const m = this.graph.near(x, z, 400, 1);
		return m.length ? m[0] : -1;
	}

	private makeLeg(a: Agent): boolean
	{
		const q = a.req;
		a.req = null;
		const g = this.graph;
		if (!q || q.from < 0 || q.to < 0) return false;
		const path = g.path(q.from, q.to);
		if (!path) return false;
		const P: number[] = [], S: number[] = [];
		const sd = q.startDest >= 0 ? this.dests[q.startDest] : null;
		if (sd && sd.kind !== 3) { P.push(sd.dx, sd.dy, sd.dz); S.push(-2); }
		else if (a.vis || sd) { P.push(a.x, a.y, a.z); S.push(-2); }
		for (let k = 0; k < path.length; k++)
		{
			const v = path[k];
			P.push(g.x[v], g.y[v], g.z[v]);
			let sj = -1;
			if (k + 1 < path.length)
			{
				const ai = g.adj[v].indexOf(path[k + 1]);
				sj = ai >= 0 ? g.adjJ[v][ai] : -1;
				if (g.kind[v] === 2 || g.kind[path[k + 1]] === 2) sj = -2;
			}
			S.push(sj);
		}
		if (q.endDest >= 0)
		{
			const d = this.dests[q.endDest];
			if (d.kind === 3) { const bx = d.dx + d.hx * 0.35, bz = d.dz + d.hz * 0.35; P.push(bx, this.ctx.data.heightAt(bx, bz), bz); }
			else P.push(d.dx, d.dy, d.dz);
			S.push(-2);
		}
		const n = P.length / 3;
		if (n < 2) return false;
		const leg: Leg = { pts: new Float32Array(P), cum: new Float32Array(n), segJ: new Int32Array(Math.max(1, n - 1)), total: 0, startDest: q.startDest, endDest: q.endDest };
		for (let k = 1; k < n; k++)
		{
			const dx = P[k * 3] - P[k * 3 - 3], dz = P[k * 3 + 2] - P[k * 3 - 1];
			leg.cum[k] = leg.cum[k - 1] + Math.sqrt(dx * dx + dz * dz);
			leg.segJ[k - 1] = S[k - 1];
		}
		leg.total = leg.cum[n - 1];
		if (leg.total < 0.5 && q.endDest < 0) return false;
		a.leg = leg;
		a.prog = q.mid ? Math.random() * leg.total * 0.8 : 0;
		a.seg = 0;
		a.dir = 1;
		a.state = S_WALK;
		a.waiting = false;
		a.pose = 0;
		if (a.pendingFlee > 0) { a.flee = a.pendingFlee; a.pendingFlee = 0; }
		this.locate(a);
		if (q.startDest >= 0 && !q.mid) this.doorPass(this.dests[q.startDest]);
		return true;
	}

	private doorPass(d: Dest): void
	{
		if (!d || d.door < 0 || !this.playerNear(d.dx, d.dz, 45)) return;
		const doors: any = this.ctx.doors;
		if (doors && doors.npcPass) doors.npcPass(d.door, 1.5);
	}

	private dwell(a: Agent, base: number, spread: number, x: number, z: number): number
	{
		let t = base + Math.random() * spread;
		// keep the streets around the player lively
		if (this.playerNear(x, z, 260)) t *= 0.35;
		return t;
	}

	private arrive(a: Agent): void
	{
		const leg = a.leg;
		if (a.role === R_TEMP && (!a.vis || !this.playerNear(a.x, a.z, 70))) { this.retire(a); return; }
		if (a.role === R_PLAZA)
		{
			const r = Math.random();
			if (r < 0.2 && !this.night()) { this.releaseBody(a); a.leg = null; a.state = S_INSIDE; a.at = -1; a.timer = this.dwell(a, 10, 40, a.x, a.z); return; }
			if (r < 0.5) { a.leg = null; a.state = S_STAND; a.pose = 0; a.speed = 0; a.timer = 2 + Math.random() * 8; return; }
			const P = this.dests[a.home].plaza;
			const forward = Math.abs(leg.pts[0] - P[0]) < 0.05 && Math.abs(leg.pts[2] - P[2]) < 0.05;
			this.plazaLeg(a, forward, false);
			return;
		}
		if (leg.endDest < 0)
		{
			// stroll over
			a.speed = 0;
			const homeless = a.role === R_WANDER || a.role === R_JOG || a.role === R_SIT;
			if (homeless && this.night() && hash01(a.id * 0.77) > 0.35 && !this.playerNear(a.x, a.z, 90))
			{
				this.releaseBody(a); a.leg = null; a.state = S_INSIDE; a.at = -1; a.timer = 60 + Math.random() * 200;
				return;
			}
			// pick the next errand from where they stand (keeps the body)
			this.startErrand(a);
			return;
		}
		const d = this.dests[leg.endDest];
		if (d.kind === 3)
		{
			// at the bench: sit down / stand and wait (keeps the body)
			this.takeSeat(a);
			return;
		}
		this.releaseBody(a);
		a.leg = null;
		this.doorPass(d);
		a.x = d.dx; a.y = d.dy; a.z = d.dz;
		if (leg.endDest === a.home)
		{
			a.state = S_HOME;
			a.timer = this.night() ? 120 + Math.random() * 240 : this.dwell(a, a.role === R_WORK ? 30 : 25, 70, d.dx, d.dz);
		}
		else
		{
			a.state = S_INSIDE;
			a.at = leg.endDest;
			a.timer = this.dwell(a, 15, 50, d.dx, d.dz);
		}
	}

	/** Takes a temporary person out of the world. */
	private retire(a: Agent): void
	{
		this.releaseBody(a);
		a.leg = null; a.req = null;
		a.state = S_OFF;
	}

	/** Position / heading of an agent from its leg. */
	private locate(a: Agent): void
	{
		const leg = a.leg;
		if (!leg) return;
		const n = leg.cum.length;
		while (a.seg < n - 2 && leg.cum[a.seg + 1] < a.prog) a.seg++;
		while (a.seg > 0 && leg.cum[a.seg] > a.prog) a.seg--;
		const i = a.seg, P = leg.pts;
		const l = Math.max(1e-4, leg.cum[i + 1] - leg.cum[i]);
		const t = Math.max(0, Math.min(1, (a.prog - leg.cum[i]) / l));
		let dx = P[i * 3 + 3] - P[i * 3], dz = P[i * 3 + 5] - P[i * 3 + 2];
		const dl = Math.sqrt(dx * dx + dz * dz) || 1;
		dx /= dl; dz /= dl;
		const hx = dx * a.dir, hz = dz * a.dir;
		// keep to the right of the way you walk (door paths: no offset)
		const lane = leg.segJ[i] === -2 ? 0 : (a.lane + a.laneBoost) * this.playerScale;
		a.x = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * t + (-hz) * lane;
		a.z = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t + hx * lane;
		a.y = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * t;
		if (dl > 1e-3) { a.hx = hx; a.hz = hz; }
	}

	private canCross(code: number): boolean
	{
		if (code < 0) return true;
		const j = code >> 1, group = code & 1;
		const I = this.ctx.data.intersections[j];
		if (!I || I.control !== 'signal' || !this.signals || this.signals.enabled === false) return true;
		const cycle = Math.max(6, this.ctx.cfg.city.trafficCycle || 24);
		let t = ((this.signals.time || 0) / cycle + I.phase) % 1;
		if (group === 1) t = (t + 0.5) % 1;
		return t >= 0.5 && t < 0.93;    // the cars on this road have red
	}

	private stepAgent(a: Agent, dt: number): void
	{
		if (a.detained) return;
		if (a.stunTimer > 0)
		{
			a.stunTimer = Math.max(0, a.stunTimer - dt);
			if (a.stunTimer > 0) return;
			a.state = a.stunState;
			a.timer = a.stunAgentTimer;
			a.leg = a.stunLeg;
			a.prog = a.stunProg;
			a.stunLeg = null;
		}
		if (a.state === S_OFF) return;
		if (a.state === S_HOME || a.state === S_INSIDE || a.state === S_DEAD || a.state === S_STAND)
		{
			a.timer -= dt;
			if (a.timer > 0) return;
			if (a.state === S_DEAD) { this.revive(a); return; }
			if (a.state === S_HOME && this.night() && (a.role === R_RES || a.role === R_PLAZA) && hash01(a.id * 2.9) > 0.12) { a.timer = 60 + Math.random() * 120; return; }
			this.startErrand(a);
			return;
		}
		if (a.state !== S_WALK || !a.leg) return;
		const leg = a.leg;
		const ps = this.playerScale;
		let speed = a.baseSpeed * ps;
		if (a.flee > 0)
		{
			a.flee -= dt;
			speed = 4.4 * ps;
			if (a.flee <= 0) { a.flee = 0; if (a.role !== R_TEMP) { a.dir = 1; this.goHomeFromHere(a); return; } }
		}
		if (a.laneBoost > 0) a.laneBoost = Math.max(0, a.laneBoost - dt * 0.15);
		a.waiting = false;
		if (a.blocked > 0) { a.blocked -= dt; speed = 0; }
		// wait at the kerb for the walk signal
		if (a.dir > 0 && a.flee <= 0 && a.seg + 1 < leg.segJ.length)
		{
			const code = leg.segJ[a.seg + 1];
			if (code >= 0 && leg.cum[a.seg + 1] - a.prog < 0.35 && !this.canCross(code)) { speed = 0; a.waiting = true; }
		}
		a.speed = speed;
		a.prog += speed * dt * a.dir;
		if (a.prog >= leg.total) { a.prog = leg.total; this.locate(a); this.arrive(a); return; }
		if (a.prog <= 0) { a.prog = 0; this.locate(a); if (a.dir < 0) { a.dir = 1; a.flee = 0; this.goHomeFromHere(a); } return; }
		this.locate(a);
	}

	/** Back after being knocked down / shot: home, or a sidewalk away from the player. */
	private revive(a: Agent): void
	{
		a.health = 100; a.flee = 0; a.leg = null;
		if (a.role === R_TEMP) { this.retire(a); return; }
		if (a.role === R_RES || a.role === R_WORK || a.role === R_PLAZA)
		{
			const d = this.dests[a.home]; a.x = d.dx; a.y = d.dy; a.z = d.dz;
			a.state = S_HOME; a.timer = 30 + Math.random() * 60;
			return;
		}
		this.placeOnSidewalk(a, 180);
		a.state = S_INSIDE; a.at = -1; a.timer = 30 + Math.random() * 60;
	}

	private goHomeFromHere(a: Agent): void
	{
		const hasHome = a.role === R_RES || a.role === R_WORK;
		if (!hasHome)
		{
			if (a.role === R_TEMP && (!a.vis || !this.playerNear(a.x, a.z, 70))) { this.retire(a); return; }
			if (a.role === R_PLAZA) { this.releaseBody(a); a.leg = null; a.state = S_HOME; const d = this.dests[a.home]; a.x = d.dx; a.y = d.dy; a.z = d.dz; a.timer = 20 + Math.random() * 30; return; }
			// keep the body: walk on from where they stand
			a.leg = null;
			a.state = S_WALK;
			this.startErrand(a);
			return;
		}
		const from = this.nearestNode(a.x, a.z);
		a.req = { from: from, to: this.dests[a.home].node, startDest: -1, endDest: a.home, mid: false };
		a.state = S_PENDING;
		a.speed = 0;
		// keep the body: it walks on from where it stands once the path is ready
		this.queue.unshift(a);
	}

	// -----------------------------------------------------------------------
	// bodies
	// -----------------------------------------------------------------------

	private loadModel(): void
	{
		const paths = [
			{ key: 'male', path: 'build/assets/characters/male.glb' },
			{ key: 'female', path: 'build/assets/characters/female.glb' },
			{ key: 'femaleAthlete', path: 'build/assets/characters/female-athlete.glb' },
		];
		const loaded: any[] = [];
		let pending = paths.length;
		const finish = (): void =>
		{
			pending--;
			if (pending !== 0) return;
			const models = loaded.filter((model) => !!model);
			try
			{
				if (models.length) this.useCharacterModels(models);
				else loadSharedModel('build/assets/boxman.glb', (gltf) =>
				{
					try { this.useBoxman(gltf); }
					catch (error) { console.warn('[Realism] NPCs: boxman setup failed, using stand-ins', error); this.modelState = 2; }
				}, () => { this.modelState = 2; });
			}
			catch (error)
			{
				console.warn('[Realism] NPC character models could not be initialized', error);
				this.modelState = 2;
			}
		};
		for (let i = 0; i < paths.length; i++)
		{
			loadSharedModel(paths[i].path, (gltf) => { loaded[i] = { key: paths[i].key, gltf }; finish(); }, finish);
		}
	}

	private createPoseClip(scene: THREE.Object3D, name: string, seated: boolean): THREE.AnimationClip
	{
		const bones: { [name: string]: THREE.Bone } = {};
		scene.traverse((node: any) => { if (node.isBone) bones[node.name] = node; });
		const tracks: THREE.KeyframeTrack[] = [];
		const addRotation = (boneName: string, angle: number): void =>
		{
			const bone = bones[boneName];
			if (!bone) return;
			const offset = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle);
			const pose = bone.quaternion.clone().multiply(offset);
			const value = [pose.x, pose.y, pose.z, pose.w];
			tracks.push(new THREE.QuaternionKeyframeTrack(boneName + '.quaternion', [0, 1], value.concat(value)));
		};
		if (seated)
		{
			addRotation('LeftUpLeg', 0.9);
			addRotation('RightUpLeg', 0.9);
			addRotation('LeftLeg', -1.35);
			addRotation('RightLeg', -1.35);
		}
		else
		{
			addRotation('Spine', 0.012);
			addRotation('Head', -0.01);
		}
		return new THREE.AnimationClip(name, 1, tracks);
	}

	private useCharacterModels(gltfs: any[]): void
	{
		this.modelVariants = [];
		for (let i = 0; i < gltfs.length; i++)
		{
			const entry = gltfs[i];
			const gltf = entry.gltf;
			const playerSettings: any = (this.ctx.cfg as any).player || {};
			const modelSettings = playerSettings.models && playerSettings.models[entry.key] || {};
			gltf.scene.updateMatrixWorld(true);
			const bounds = new THREE.Box3().setFromObject(gltf.scene);
			const height = bounds.max.y - bounds.min.y;
			if (!Number.isFinite(height) || height <= 0.001)
			{
				console.warn('[Realism] NPC character GLB has invalid scene bounds; skipping model variant', i, height);
				continue;
			}
			let map: THREE.Texture = null;
			gltf.scene.traverse((node: any) =>
			{
				if (node.isMesh && node.material && node.material.map && !map) map = node.material.map;
			});
			const options: any = { map, skinning: true, vertexColors: THREE.VertexColors };
			const material: any = this.ctx.preset.lighting === 'lambert'
				? new THREE.MeshLambertMaterial(options)
				: new THREE.MeshPhongMaterial(Object.assign({ shininess: 0 }, options));
			material.name = 'npcCharacter_' + i;
			try { this.ctx.world.sky.csm.setupMaterial(material); } catch (e) { /* no csm */ }
			const find = (name: string) => THREE.AnimationClip.findByName(gltf.animations, name);
			const walk = find('walk') || find('run');
			const run = find('run') || walk;
			if (!walk || !run) continue;
			this.modelVariants.push({
				key: entry.key,
				gltf,
				baseScale: Number(modelSettings.height) > 0 ? Number(modelSettings.height) / height : 1.7 / height,
				minY: bounds.min.y,
				scale: Number(modelSettings.scale) > 0 ? Number(modelSettings.scale) : 1,
				y: Number.isFinite(Number(modelSettings.y)) ? Number(modelSettings.y) : 0,
				seatedScale: Number(modelSettings.seatedScale) > 0 ? Number(modelSettings.seatedScale) : 0.72,
				seatedY: Number.isFinite(Number(modelSettings.seatedY)) ? Number(modelSettings.seatedY) : 0,
				material,
				clips: {
					walk,
					run,
					idle: this.createPoseClip(gltf.scene, 'npc_idle_' + i, false),
					sit: this.createPoseClip(gltf.scene, 'npc_sit_' + i, true),
				},
			});
		}
		if (!this.modelVariants.length) throw new Error('No usable male or female NPC GLB models were loaded.');
		this.modelState = 1;
		this.resetBodyPool();
		console.log('[Realism] NPC GLB models ready:', this.modelVariants.length);
	}

	private useBoxman(gltf: any): void
	{
		this.gltf = gltf;
		this.modelVariants = [];
		const find = (name: string) => THREE.AnimationClip.findByName(gltf.animations, name);
		this.clips = { walk: find('run'), idle: find('idle'), run: find('sprint') || find('run'), sit: find('sitting') || find('idle') };
		let map: THREE.Texture = null;
		gltf.scene.traverse((o: any) => { if (o.isMesh && o.material && o.material.map && !map) map = o.material.map; });
		const opts: any = { map: map, skinning: true, vertexColors: THREE.VertexColors };
		const mat: any = this.ctx.preset.lighting === 'lambert' ? new THREE.MeshLambertMaterial(opts) : new THREE.MeshPhongMaterial(Object.assign({ shininess: 0 }, opts));
		mat.name = 'npcPeople';
		try { this.ctx.world.sky.csm.setupMaterial(mat); } catch (e) { /* no csm */ }
		this.sharedMat = mat;
		this.modelState = 1;
		this.resetBodyPool();
	}

	private resetBodyPool(): void
	{
		for (let i = 0; i < this.bodies.length; i++) { const b = this.bodies[i]; if (b.agent) this.releaseBody(b.agent); }
		for (let i = 0; i < this.bodies.length; i++) this.ctx.world.graphicsWorld.remove(this.bodies[i].root);
		this.bodies = []; this.free = [];
	}

	private newBody(variantIndex: number = -1): NPCBody
	{
		const root = new THREE.Group();
		root.name = 'npc';
		const tilt = new THREE.Group();
		root.add(tilt);
		const visual = new THREE.Group();
		tilt.add(visual);
		const cast = !!this.ctx.preset.shadows;
		let model: THREE.Object3D, mixer: THREE.AnimationMixer = null, geom: THREE.BufferGeometry = null;
		const legs: THREE.Object3D[] = [];
		let walk: THREE.AnimationAction = null, idle: THREE.AnimationAction = null, run: THREE.AnimationAction = null, sit: THREE.AnimationAction = null;
		let modelBaseScale = 1, modelBaseMinY = 0, modelFitScale = 1, modelFitY = 0;
		let modelSeatedScale = 1, modelSeatedY = 0;
		const variant = variantIndex >= 0 ? this.modelVariants[variantIndex] : null;
		if (variant)
		{
			model = SkeletonUtils.clone(variant.gltf.scene) as THREE.Object3D;
			modelBaseScale = variant.baseScale;
			modelBaseMinY = variant.minY;
			modelFitScale = variant.scale;
			modelFitY = variant.y;
			modelSeatedScale = variant.seatedScale;
			modelSeatedY = variant.seatedY;
			model.traverse((node: any) =>
			{
				if (!node.isMesh) return;
				node.geometry = (node.geometry as THREE.BufferGeometry).clone();
				if (!geom) geom = node.geometry;
				node.material = variant.material.clone();
				node.castShadow = cast; node.receiveShadow = true;
				node.frustumCulled = false;
			});
			mixer = new THREE.AnimationMixer(model);
			walk = mixer.clipAction(variant.clips.walk);
			idle = mixer.clipAction(variant.clips.idle);
			run = mixer.clipAction(variant.clips.run);
			sit = mixer.clipAction(variant.clips.sit);
			walk.play(); idle.play(); run.play(); sit.play();
			walk.setEffectiveWeight(1); idle.setEffectiveWeight(0); run.setEffectiveWeight(0); sit.setEffectiveWeight(0);
		}
		else if (this.modelState === 1 && this.gltf)
		{
			model = SkeletonUtils.clone(this.gltf.scene) as THREE.Object3D;
			model.traverse((o: any) =>
			{
				if (!o.isMesh) return;
				o.geometry = (o.geometry as THREE.BufferGeometry).clone();
				geom = o.geometry;
				o.material = this.sharedMat;
				o.castShadow = cast; o.receiveShadow = true;
				o.frustumCulled = true;
			});
			mixer = new THREE.AnimationMixer(model);
			walk = mixer.clipAction(this.clips.walk); idle = mixer.clipAction(this.clips.idle); run = mixer.clipAction(this.clips.run); sit = mixer.clipAction(this.clips.sit);
			walk.play(); idle.play(); run.play(); sit.play();
			walk.setEffectiveWeight(1); idle.setEffectiveWeight(0); run.setEffectiveWeight(0); sit.setEffectiveWeight(0);
		}
		else
		{
			// stand-in person (no boxman.glb): torso + head + two swinging legs, vertex coloured
			model = new THREE.Group();
			const mat = this.standInMat();
			const torso = new THREE.Mesh(new THREE.BoxBufferGeometry(0.44, 0.62, 0.24), mat); torso.position.y = 1.12;
			const head = new THREE.Mesh(new THREE.BoxBufferGeometry(0.24, 0.26, 0.24), mat); head.position.y = 1.58;
			model.add(torso); model.add(head);
			for (let s = -1; s <= 1; s += 2)
			{
				const pivot = new THREE.Group(); pivot.position.set(0.11 * s, 0.82, 0);
				const leg = new THREE.Mesh(new THREE.BoxBufferGeometry(0.17, 0.8, 0.19), mat); leg.position.y = -0.4;
				pivot.add(leg); model.add(pivot); legs.push(pivot);
			}
			model.traverse((o: any) => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = true; } });
		}
		visual.add(model);
		root.visible = false;
		this.ctx.world.graphicsWorld.add(root);
		const b: NPCBody = { root: root, tilt: tilt, visual: visual, model: model, mixer: mixer, walk: walk, idle: idle, run: run, sit: sit,
			variantIndex, modelBaseScale, modelBaseMinY, modelFitScale, modelFitY, modelSeatedScale, modelSeatedY,
			wWalk: 1, wRun: 0, wSit: 0, agent: null,
			geom: geom, legs: legs, deadT: 0, fallAxis: 0, animAcc: 0, frame: 0, body: null, alive: false };
		this.bodies.push(b);
		return b;
	}

	private standMat: THREE.Material = null;
	private standInMat(): THREE.Material
	{
		if (!this.standMat)
		{
			this.standMat = new THREE.MeshLambertMaterial({ color: 0xd8c8b8 });
			try { this.ctx.world.sky.csm.setupMaterial(this.standMat); } catch (e) { /* no csm */ }
		}
		return this.standMat;
	}

	/** Paints clothes into the body's own vertex colours (skin / shirt / trousers / shoes by bone). */
	private dress(b: NPCBody, look: number, role: number): void
	{
		const pick = (list: number[][], k: number) => list[Math.floor(hash01(look * 0.37 + k * 11.3) * list.length) % list.length];
		const skin = pick(SKIN, 1), shirt = role === R_WORK && hash01(look + 2.2) < 0.6 ? pick(WORK_SHIRT, 2) : pick(SHIRT, 2), pants = pick(PANTS, 3), shoes = [0.16, 0.14, 0.13];
		const sleeves = role === R_JOG ? false : hash01(look + 5.5) < 0.5;
		if (b.geom)
		{
			let skinned: any = null;
			b.model.traverse((o: any) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
			const pos = b.geom.getAttribute('position') as THREE.BufferAttribute;
			const si = b.geom.getAttribute('skinIndex') as THREE.BufferAttribute;
			const sw = b.geom.getAttribute('skinWeight') as THREE.BufferAttribute;
			const n = pos.count;
			let col = b.geom.getAttribute('color') as THREE.BufferAttribute;
			if (!col) { col = new THREE.BufferAttribute(new Float32Array(n * 3), 3); b.geom.setAttribute('color', col); }
			const bones = skinned && skinned.skeleton ? skinned.skeleton.bones : [];
			const arr = col.array as Float32Array;
			let minY = 1e9, maxY = -1e9;
			for (let v = 0; v < n; v++) { const y = pos.getY(v); if (y < minY) minY = y; if (y > maxY) maxY = y; }
			for (let v = 0; v < n; v++)
			{
				let bi = 0, bw = -1;
				for (let k = 0; k < 4; k++) { const w = sw ? (sw.array as any)[v * sw.itemSize + k] : 0; if (w > bw) { bw = w; bi = si ? (si.array as any)[v * si.itemSize + k] : 0; } }
				const name: string = bones[bi] ? bones[bi].name.toLowerCase() : '';
				let c = [1, 1, 1];
				if (b.variantIndex < 0)
				{
					c = shirt;
					if (name.indexOf('head') >= 0) c = skin;
					else if (name.indexOf('arm_lower') >= 0) c = sleeves ? shirt : skin;
					else if (name.indexOf('leg') >= 0 || name.indexOf('body_lower') >= 0 || name.indexOf('butt') >= 0 || name === 'root') c = pants;
					if (name.indexOf('leg_lower') >= 0 && pos.getY(v) < minY + (maxY - minY) * 0.07) c = shoes;
				}
				else if (name.indexOf('head') >= 0 || name.indexOf('neck') >= 0 || name.indexOf('hand') >= 0 ||
					(!sleeves && (name.indexOf('arm') >= 0 || name.indexOf('forearm') >= 0)))
				{
					c = skin;
				}
				arr[v * 3] = c[0]; arr[v * 3 + 1] = c[1]; arr[v * 3 + 2] = c[2];
			}
			col.needsUpdate = true;
		}
		this.applyBodyFit(b);
	}

	private applyBodyFit(b: NPCBody): void
	{
		const agentScale = b.agent ? b.agent.scale : 1;
		const playerScale = b.variantIndex >= 0 ? 1 : this.playerScale;
		const seatScale = 1 + (b.modelSeatedScale - 1) * b.wSit;
		const fittedScale = agentScale * playerScale * b.modelBaseScale * b.modelFitScale * seatScale;
		b.visual.scale.set(fittedScale, fittedScale, fittedScale);
		const yOffset = b.modelFitY + (b.modelSeatedY - b.modelFitY) * b.wSit;
		b.visual.position.y = -b.modelBaseMinY * fittedScale + yOffset;
	}

	private assignBody(a: Agent): void
	{
		if (this.modelState === 0) return;
		let b = this.free.pop();
		if (b === undefined)
		{
			if (this.bodies.length >= this.settings.maxVisible) return;
			const variantIndex = this.modelVariants.length ? Math.floor(hash01(a.look + 97.31) * this.modelVariants.length) : -1;
			b = this.newBody(variantIndex);
		}
		b.agent = a; a.vis = b;
		b.alive = true; b.deadT = 0;
		b.tilt.rotation.set(0, 0, 0);
		b.root.position.set(a.x, a.y, a.z);
		b.root.rotation.y = Math.atan2(a.hx, a.hz);
		b.root.visible = true;
		b.frame = Math.floor(Math.random() * 4);
		b.wSit = a.state === S_STAND && a.pose === 1 ? 1 : 0;
		this.dress(b, a.look, a.role);
		if (b.mixer) { b.walk.enabled = true; b.idle.enabled = true; b.run.enabled = true; b.sit.enabled = true; b.mixer.update(Math.random()); }
	}

	private releaseBody(a: Agent): void
	{
		const b = a.vis;
		if (!b) return;
		a.vis = null;
		b.agent = null;
		b.alive = false;
		b.root.visible = false;
		if (b.body) { this.ctx.world.physicsWorld.remove(b.body); this.poolCollider(b.body); b.body = null; }
		this.free.push(b);
	}

	// -----------------------------------------------------------------------
	// per frame
	// -----------------------------------------------------------------------

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		const w: any = this.ctx.world;
		if (w.realismPaused === true) return;
		const dt = Math.min(0.1, Math.max(0, timeStep || 0));
		this.frameNo++;
		this.findPlayer();
		this.watchGunfire();

		// paths (a few per frame)
		for (let k = 0; k < 4 && this.queue.length; k++)
		{
			const a = this.queue.shift();
			if (a.state !== S_PENDING) continue;
			if (!this.makeLeg(a))
			{
				if (a.role === R_TEMP) { this.retire(a); continue; }
				// no way there: back home (or off the street) for a while
				this.releaseBody(a);
				a.leg = null; a.flee = 0; a.pendingFlee = 0;
				a.timer = 20 + Math.random() * 40;
				if (a.home >= 0 && (a.role === R_RES || a.role === R_WORK || a.role === R_PLAZA)) { a.state = S_HOME; const d = this.dests[a.home]; a.x = d.dx; a.y = d.dy; a.z = d.dz; }
				else { a.state = S_INSIDE; a.at = -1; this.placeOnSidewalk(a, 150); }
			}
		}
		if (dt <= 0) return;

		for (let i = 0; i < this.agents.length; i++) this.stepAgent(this.agents[i], dt);
		if (this.extras.length)
		{
			for (let i = 0; i < this.extras.length; i++) this.stepAgent(this.extras[i], dt);
			for (let i = this.extras.length - 1; i >= 0; i--) if (this.extras[i].state === S_OFF) this.extras.splice(i, 1);
		}

		this.matAcc += dt;
		if (this.matAcc > 0.4) { this.matAcc = 0; this.checkScale(); this.materialise(); }

		this.updateBodies(dt);
		if (this.vehicles) this.vehicles.tick(dt);
	}

	/** Gunfire from the player's weapons scares people (and drivers) around the player. */
	private watchGunfire(): void
	{
		const wp: any = (this.ctx.world as any).realismWeapons;
		if (!wp || !wp.stats) return;
		const shots = wp.stats.shots | 0;
		if (this.lastShots >= 0 && shots > this.lastShots && this.settings.gunfirePanic > 0 && this.havePlayer)
			this.panic(this.playerPos, this.settings.gunfirePanic);
		this.lastShots = shots;
	}

	/** Follows the player scale (contract C5) if it changes while playing. */
	private checkScale(): void
	{
		const s = playerScaleOf(this.ctx);
		if (Math.abs(s - this.playerScale) < 1e-4) return;
		this.playerScale = s;
		for (let i = 0; i < this.bodies.length; i++)
		{
			const b = this.bodies[i];
			if (!b.agent) continue;
			const k = b.agent.scale * s;
			b.model.scale.set(k, k, k);
			if (b.agent.state === S_STAND && b.agent.role === R_SIT) this.takeSeat(b.agent);
		}
		this.bodyPool.length = 0;
	}

	private findPlayer(): void
	{
		const im: any = this.ctx.world.inputManager;
		const r: any = im ? im.inputReceiver : null;
		this.havePlayer = false; this.playerOnFoot = false;
		let ch: any = null;
		if (r && r.characterCapsule !== undefined && r.position) ch = r;
		else if (r && r.controllingCharacter) ch = r.controllingCharacter;
		if (ch)
		{
			this.havePlayer = true;
			if (ch.occupyingSeat && ch.occupyingSeat.vehicle) this.playerPos.copy((ch.occupyingSeat.vehicle as any).position);
			else this.playerPos.copy(ch.position);
			this.playerOnFoot = !ch.occupyingSeat && ch.controlledObject === undefined && !ch.vehicleEntryInstance;
		}
		else
		{
			// free camera: people still appear around the camera
			const cam = this.ctx.world.camera;
			if (cam) { this.playerPos.copy(cam.position); this.havePlayer = true; }
		}
	}

	public get player(): any
	{
		const im: any = this.ctx.world.inputManager;
		const r: any = im ? im.inputReceiver : null;
		if (r && r.characterCapsule !== undefined && r.position) return r;
		if (r && r.controllingCharacter) return r.controllingCharacter;
		return null;
	}

	public get playerPosition(): THREE.Vector3 { return this.playerPos; }

	private visibleCandidate(a: Agent): boolean
	{
		return a.state === S_WALK || a.state === S_STAND || (a.state === S_PENDING && !!a.vis);
	}

	private materialise(): void
	{
		if (this.modelState === 0 || !this.havePlayer) return;
		const R = this.settings.radius, R2 = R * R, keep2 = (R + 15) * (R + 15);
		const px = this.playerPos.x, pz = this.playerPos.z;
		const cand: Agent[] = [], cd: number[] = [];
		const scan = (list: Agent[]) =>
		{
			for (let i = 0; i < list.length; i++)
			{
				const a = list[i];
				if (!this.visibleCandidate(a)) continue;
				const dx = a.x - px, dz = a.z - pz, d = dx * dx + dz * dz;
				if (a.vis)
				{
					if (d > keep2 && a.vis.alive) this.releaseBody(a);
					continue;
				}
				if (d < R2) { cand.push(a); cd.push(a.role === R_TEMP ? -1 : d); }
			}
		};
		scan(this.extras);
		scan(this.agents);
		if (!cand.length) return;
		const order = cand.map((_, k) => k).sort((x, y) => cd[x] - cd[y]);
		let used = 0;
		for (let i = 0; i < this.bodies.length; i++) if (this.bodies[i].agent) used++;
		for (let k = 0; k < order.length && used < this.settings.maxVisible; k++)
		{
			this.assignBody(cand[order[k]]);
			if (cand[order[k]].vis) used++;
		}
		// swap far bodies for nearer people when the pool is full
		if (used >= this.settings.maxVisible)
		{
			for (let k = 0; k < order.length; k++)
			{
				const a = cand[order[k]];
				if (a.vis || cd[order[k]] > 60 * 60) continue;
				this.freeFarthest(Math.max(0, cd[order[k]]) + 400);
				this.assignBody(a);
				if (!a.vis) break;
			}
		}
	}

	/** Releases the body farthest from the player if it is farther than sqrt(minD2). */
	private freeFarthest(minD2: number): boolean
	{
		const px = this.playerPos.x, pz = this.playerPos.z;
		let far: NPCBody = null, fd = minD2;
		for (let i = 0; i < this.bodies.length; i++)
		{
			const b = this.bodies[i];
			if (!b.agent || !b.alive || b.agent.role === R_TEMP) continue;
			const dx = b.agent.x - px, dz = b.agent.z - pz, d = dx * dx + dz * dz;
			if (d > fd) { fd = d; far = b; }
		}
		if (!far) return false;
		this.releaseBody(far.agent);
		return true;
	}

	private updateBodies(dt: number): void
	{
		const data = this.ctx.data;
		const px = this.playerPos.x, pz = this.playerPos.z;
		const vehicles: any[] = (this.ctx.world as any).vehicles || [];
		const ps = this.playerScale;
		const avoid = 1.25 * ps;
		let colliders = 0;
		let visible = 0;
		for (let i = 0; i < this.bodies.length; i++)
		{
			const b = this.bodies[i];
			const a = b.agent;
			if (!a) continue;
			visible++;
			b.frame++;
			if (!b.alive)
			{
				// lying on the ground
				b.deadT += dt;
				const fall = Math.min(1, b.deadT / 0.55);
				b.tilt.rotation.x = b.fallAxis * (Math.PI / 2) * fall * fall;
				if (b.deadT > 22) { a.state = S_DEAD; a.timer = 60 + Math.random() * 60; this.releaseBody(a); }
				continue;
			}
			const dxp = a.x - px, dzp = a.z - pz;
			const dp = Math.sqrt(dxp * dxp + dzp * dzp);
			// stop for the player on foot, then step aside
			if (this.playerOnFoot && dp < avoid && a.flee <= 0 && a.state === S_WALK)
			{
				const ahead = (-dxp * a.hx - dzp * a.hz) / Math.max(dp, 0.01);
				if (ahead > 0.25) { a.blocked = Math.max(a.blocked, 0.3); a.laneBoost = Math.min(1.1, a.laneBoost + dt * 0.9); }
			}
			// hit by a vehicle
			for (let v = 0; v < vehicles.length; v++)
			{
				const veh = vehicles[v];
				const dx = veh.position.x - a.x, dz = veh.position.z - a.z;
				if (dx * dx + dz * dz > 6.5 || Math.abs(veh.position.y - a.y - 0.8) > 2.2) continue;
				const vel = veh.collision ? veh.collision.velocity : null;
				const sp = vel ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) : 0;
				if (sp < 4.5) continue;
				// close to the body's long axis?
				if (dx * dx + dz * dz < 2.6 * 2.6)
				{
					this.damage(b, 1000, new THREE.Vector3(vel.x / sp, 0, vel.z / sp));
					break;
				}
			}
			if (!b.alive) continue;
			// place
			let y = a.y;
			if (a.state === S_STAND) y = a.pose === 1 ? a.y : Math.max(a.y, data.heightAt(a.x, a.z));
			else if (a.leg && a.leg.segJ[a.seg] !== -2) y = data.heightAt(a.x, a.z) + (a.leg.segJ[a.seg] >= 0 ? 0.13 : 0.03);
			else y = Math.max(y, data.heightAt(a.x, a.z));
			const k = 1 - Math.exp(-dt * 10);
			b.root.position.x += (a.x - b.root.position.x) * k;
			b.root.position.z += (a.z - b.root.position.z) * k;
			b.root.position.y += (y - b.root.position.y) * k;
			if (Math.abs(a.x - b.root.position.x) > 4 || Math.abs(a.z - b.root.position.z) > 4) b.root.position.set(a.x, y, a.z);
			const yaw = Math.atan2(a.hx, a.hz);
			let dy = yaw - b.root.rotation.y;
			while (dy > Math.PI) dy -= Math.PI * 2;
			while (dy < -Math.PI) dy += Math.PI * 2;
			b.root.rotation.y += dy * Math.min(1, dt * 8);
			// animate (far bodies less often)
			const moving = a.speed > 0.1 && a.state === S_WALK;
			const running = moving && (a.flee > 0 || a.role === R_JOG);
			const sitting = a.state === S_STAND && a.pose === 1;
			const every = dp < 40 ? 1 : (dp < 80 ? 2 : 4);
			b.animAcc += dt;
			if (b.frame % every === 0)
			{
				const st = b.animAcc;
				b.animAcc = 0;
				const fade = Math.min(1, st * 6);
				b.wWalk += ((moving && !running ? 1 : 0) - b.wWalk) * fade;
				b.wRun += ((running ? 1 : 0) - b.wRun) * fade;
				b.wSit += ((sitting ? 1 : 0) - b.wSit) * fade;
				if (b.variantIndex >= 0) this.applyBodyFit(b);
				if (b.mixer)
				{
					b.walk.setEffectiveWeight(b.wWalk);
					b.run.setEffectiveWeight(b.wRun);
					b.sit.setEffectiveWeight(b.wSit);
					b.idle.setEffectiveWeight(Math.max(0, 1 - b.wWalk - b.wRun - b.wSit));
					b.walk.timeScale = Math.max(0.75, Math.min(1.25, a.baseSpeed / 1.5));
					b.run.timeScale = a.flee > 0 ? 1.05 : 1;
					b.mixer.update(st);
				}
				else if (b.legs.length)
				{
					const ph = now() * 0.001 * (running ? 11 : 6.5);
					const amp = moving ? (running ? 0.7 : 0.45) : 0;
					b.legs[0].rotation.x = Math.sin(ph) * amp;
					b.legs[1].rotation.x = -Math.sin(ph) * amp;
				}
			}
			// small collider near the player on foot, so you can't walk through people
			if (this.playerOnFoot && dp < 9 * ps && colliders < 6 && !sitting)
			{
				if (!b.body)
				{
					b.body = this.bodyPool.pop() || this.newCollider();
					this.ctx.world.physicsWorld.addBody(b.body);
				}
				b.body.position.set(b.root.position.x, b.root.position.y + 0.9 * ps, b.root.position.z);
				b.body.aabbNeedsUpdate = true;
				colliders++;
			}
			else if (b.body) { this.ctx.world.physicsWorld.remove(b.body); this.poolCollider(b.body); b.body = null; }
		}
		this.stats.visible = visible;
		this.stats.colliders = colliders;
	}

	private newCollider(): CANNON.Body
	{
		const s = this.playerScale;
		const body = new CANNON.Body({ mass: 0 });
		body.addShape(new CANNON.Box(new CANNON.Vec3(0.24 * s, 0.85 * s, 0.24 * s)));
		body.material = this.bodyMat;
		(body as any).realismScale = s;
		return body;
	}

	private poolCollider(body: CANNON.Body): void
	{
		if ((body as any).realismScale === this.playerScale) this.bodyPool.push(body);
	}

	// -----------------------------------------------------------------------
	// weapons API
	// -----------------------------------------------------------------------

	/** Ray against the people that have a body. `dir` need not be normalised. */
	public hitTest(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { distance: number; point: THREE.Vector3; npc: any } | null
	{
		const d = this.tmpV.copy(dir);
		const len = d.length();
		if (len < 1e-6) return null;
		d.multiplyScalar(1 / len);
		let best: NPCBody = null, bt = maxDist;
		for (let i = 0; i < this.bodies.length; i++)
		{
			const b = this.bodies[i];
			if (!b.agent || !b.alive) continue;
			const p = b.root.position;
			const s = b.agent.scale * this.playerScale;
			const sitting = b.agent.state === S_STAND && b.agent.pose === 1;
			const tall = this.modelState === 1 ? 1.05 : 1.78;      // the boxman is about 1 m tall at scale 1
			const r = 0.3 * s, h = (sitting ? tall * 0.62 : tall) * s;
			const wx = origin.x - p.x, wz = origin.z - p.z;
			const A = d.x * d.x + d.z * d.z;
			const B = 2 * (wx * d.x + wz * d.z);
			const C = wx * wx + wz * wz - r * r;
			let t = -1;
			const y0 = p.y, y1 = p.y + h;
			let tin = 0, tout = 1e9;
			if (A < 1e-8) { if (C > 0) continue; }
			else
			{
				const disc = B * B - 4 * A * C;
				if (disc < 0) continue;
				const sq = Math.sqrt(disc);
				tin = (-B - sq) / (2 * A); tout = (-B + sq) / (2 * A);
			}
			// clip the span inside the infinite cylinder by the height range [y0, y1]
			if (Math.abs(d.y) < 1e-8) { if (origin.y < y0 || origin.y > y1) continue; }
			else
			{
				let ta = (y0 - origin.y) / d.y, tb = (y1 - origin.y) / d.y;
				if (ta > tb) { const tt = ta; ta = tb; tb = tt; }
				tin = Math.max(tin, ta); tout = Math.min(tout, tb);
			}
			if (tout < tin || tout < 0) continue;
			t = Math.max(0, tin);
			if (t >= 0 && t < bt) { bt = t; best = b; }
		}
		if (!best) return null;
		return { distance: bt, point: new THREE.Vector3(origin.x + d.x * bt, origin.y + d.y * bt, origin.z + d.z * bt), npc: best };
	}

	/** Briefly pauses an NPC without applying damage. */
	public stun(npc: any, duration: number = 5): boolean
	{
		const b: NPCBody = npc && npc.root ? npc : (npc && npc.vis ? npc.vis : null);
		if (!b || !b.agent || !b.alive || b.agent.detained) return false;
		const a = b.agent;
		if (a.stunTimer <= 0)
		{
			a.stunState = a.state;
			a.stunAgentTimer = a.timer;
			a.stunLeg = a.leg;
			a.stunProg = a.prog;
		}
		a.stunTimer = Math.max(a.stunTimer, Math.max(0.5, Math.min(20, duration)));
		a.state = S_STAND;
		a.pose = 0;
		a.timer = a.stunTimer;
		a.leg = null;
		a.speed = 0;
		return true;
	}

	/** Applies or releases temporary in-game custody on an NPC. */
	public setDetained(npc: any, detained: boolean): boolean
	{
		const b: NPCBody = npc && npc.root ? npc : (npc && npc.vis ? npc.vis : null);
		if (!b || !b.agent || !b.alive) return false;
		const a = b.agent;
		a.detained = detained === true;
		a.stunTimer = 0;
		a.stunLeg = null;
		a.state = S_STAND;
		a.pose = 0;
		a.leg = null;
		a.speed = 0;
		a.timer = detained ? 1e9 : 0;
		return true;
	}

	/** Damages a person (the `npc` from hitTest). 100 health; at 0 they fall over. Everyone near runs. */
	public damage(npc: any, amount: number, dir?: THREE.Vector3): void
	{
		const b: NPCBody = npc && npc.root ? npc : (npc && npc.vis ? npc.vis : null);
		if (!b || !b.agent || !b.alive) return;
		const a = b.agent;
		a.health -= Math.max(0, amount || 0);
		const p = b.root.position;
		if (a.health <= 0)
		{
			b.alive = false;
			b.deadT = 0;
			let fx = dir ? dir.x : -a.hx, fz = dir ? dir.z : -a.hz;
			const fl = Math.sqrt(fx * fx + fz * fz) || 1;
			fx /= fl; fz /= fl;
			// fall the way the hit pushes: face away from the push and tip backwards, or forwards
			const yaw = b.root.rotation.y;
			const fwd = Math.sin(yaw) * fx + Math.cos(yaw) * fz;
			b.fallAxis = fwd >= 0 ? 1 : -1;
			if (b.mixer) { b.walk.setEffectiveWeight(0); b.run.setEffectiveWeight(0); b.sit.setEffectiveWeight(0); b.idle.setEffectiveWeight(1); b.mixer.update(0.01); }
			if (a.state === S_STAND && a.pose === 1) { b.root.position.y = Math.max(this.ctx.data.heightAt(p.x, p.z), p.y - 0.3); }
			a.state = S_DEAD;
			a.timer = 1e9;      // the body releases the agent when it is cleared away
			a.leg = null;
			if (b.body) { this.ctx.world.physicsWorld.remove(b.body); this.poolCollider(b.body); b.body = null; }
		}
		else this.scare(a, p.x, p.z, 9);
		this.panic(p, 30);
	}

	/**
	 * People with a body (on foot, alive) inside the circle, as x,z pairs pushed into `out`.
	 * RealismTraffic uses it so drivers stop for pedestrians on the road / crosswalks.
	 */
	public peopleNear(x: number, z: number, r: number, out: number[]): number
	{
		out.length = 0;
		const r2 = r * r;
		for (let i = 0; i < this.bodies.length; i++)
		{
			const a = this.bodies[i].agent;
			if (!a || !a.vis || !a.vis.alive || a.state === S_STAND) continue;
			const dx = a.x - x, dz = a.z - z;
			if (dx * dx + dz * dz < r2) out.push(a.x, a.z);
		}
		return out.length / 2;
	}

	/** People within `radius` of the point run away from it. Drivers react too (RealismTraffic). */
	public panic(point: THREE.Vector3, radius: number = 30): void
	{
		const r2 = radius * radius;
		const each = (list: Agent[]) =>
		{
			for (let i = 0; i < list.length; i++)
			{
				const a = list[i];
				if ((a.state !== S_WALK && a.state !== S_STAND) || (a.vis && !a.vis.alive)) continue;
				const dx = a.x - point.x, dz = a.z - point.z;
				if (dx * dx + dz * dz > r2) continue;
				if (a.flee <= 0) this.scare(a, point.x, point.z, 8 + Math.random() * 4);
			}
		};
		each(this.agents);
		each(this.extras);
		const t: any = (this.ctx.world as any).realismTraffic;
		if (t && typeof t.panic === 'function') { try { t.panic(point, radius); } catch (e) { /* ignore */ } }
	}

	/** Makes one person run away from (tx, tz) for `time` seconds. */
	private scare(a: Agent, tx: number, tz: number, time: number): void
	{
		if (a.state === S_WALK && a.leg && a.leg.pts.length > 6)
		{
			a.flee = Math.max(a.flee, time);
			this.setFleeDir(a, tx, tz);
			return;
		}
		if (a.state !== S_STAND && a.state !== S_WALK) return;
		// standing / sitting (or on a short plaza line): run to a sidewalk node away from the danger
		const from = this.nearestNode(a.x, a.z);
		const to = this.awayNode(a.x, a.z, tx, tz);
		if (from < 0 || to < 0) { if (a.role === R_PLAZA) this.goHomeFromHere(a); return; }
		a.req = { from: from, to: to, startDest: -1, endDest: -1, mid: false };
		a.pendingFlee = time;
		a.state = S_PENDING;
		a.leg = null;
		a.speed = 0;
		this.queue.unshift(a);
	}

	/** A walk node 30..90 m from (x, z), as far from the danger (tx, tz) as possible. */
	private awayNode(x: number, z: number, tx: number, tz: number): number
	{
		const g = this.graph;
		const list = g.near(x, z, 90, 60);
		let best = -1, bs = -1e9;
		for (let k = 0; k < list.length; k++)
		{
			const v = list[k];
			const d = Math.sqrt((g.x[v] - x) * (g.x[v] - x) + (g.z[v] - z) * (g.z[v] - z));
			if (d < 25) continue;
			const away = Math.sqrt((g.x[v] - tx) * (g.x[v] - tx) + (g.z[v] - tz) * (g.z[v] - tz));
			if (away > bs) { bs = away; best = v; }
		}
		return best;
	}

	private setFleeDir(a: Agent, tx: number, tz: number): void
	{
		if (!a.leg) return;
		const save = a.prog, saveSeg = a.seg, sx = a.x, sz = a.z, shx = a.hx, shz = a.hz;
		a.prog = Math.min(a.leg.total, save + 3); this.locate(a);
		const f = (a.x - tx) * (a.x - tx) + (a.z - tz) * (a.z - tz);
		a.prog = Math.max(0, save - 3); this.locate(a);
		const bk = (a.x - tx) * (a.x - tx) + (a.z - tz) * (a.z - tz);
		a.prog = save; a.seg = saveSeg; a.x = sx; a.z = sz; a.hx = shx; a.hz = shz;
		a.dir = f >= bk ? 1 : -1;
		a.blocked = 0;
		a.waiting = false;
		this.locate(a);
	}

	/**
	 * A person appears at (x, y, z) and runs away from (fromX, fromZ), e.g. a driver pulled out of
	 * a car. They are not part of the population: they leave the world once they are away.
	 */
	public addFleeing(x: number, y: number, z: number, fromX: number, fromZ: number): any
	{
		if (!this.graph || !this.settings.enabled) return null;
		const look = Math.floor(Math.random() * 100000);
		const a: Agent = {
			id: this.nextId++, role: R_TEMP, home: -1, seat: 0, state: S_WALK, timer: 0, leg: null, prog: 0, seg: 0, dir: 1,
			speed: 0, baseSpeed: 1.3, lane: 0.3, laneBoost: 0, blocked: 0, waiting: false, flee: 0, pendingFlee: 0, pose: 0,
			x: x, y: y, z: z, hx: x - fromX, hz: z - fromZ, vis: null, health: 100, at: -1, look: look, scale: 0.95 + Math.random() * 0.1, req: null,
			detained: false, stunTimer: 0, stunState: S_WALK, stunAgentTimer: 0, stunLeg: null, stunProg: 0,
		};
		const hl = Math.sqrt(a.hx * a.hx + a.hz * a.hz) || 1; a.hx /= hl; a.hz /= hl;
		this.extras.push(a);
		if (this.extras.length > 24)
		{
			for (let i = 0; i < this.extras.length && this.extras.length > 24; i++) if (!this.extras[i].vis && this.extras[i] !== a) { this.retire(this.extras[i]); this.extras.splice(i, 1); i--; }
		}
		// a body right away (the nearest far one gives way)
		if (this.modelState !== 0)
		{
			this.assignBody(a);
			if (!a.vis && this.freeFarthest(0)) this.assignBody(a);
		}
		const from = this.nearestNode(x, z), to = this.awayNode(x, z, fromX, fromZ);
		a.pendingFlee = 14;
		a.req = { from: from, to: to >= 0 ? to : from, startDest: -1, endDest: -1, mid: false };
		a.state = S_PENDING;
		if (!this.makeLeg(a)) { a.state = S_WALK; this.plainRun(a, fromX, fromZ); }
		return a;
	}

	/** No walk graph near: run in a straight line away. */
	private plainRun(a: Agent, fromX: number, fromZ: number): void
	{
		let dx = a.x - fromX, dz = a.z - fromZ;
		const l = Math.sqrt(dx * dx + dz * dz) || 1; dx /= l; dz /= l;
		const ex = a.x + dx * 40, ez = a.z + dz * 40;
		a.leg = { pts: new Float32Array([a.x, a.y, a.z, ex, this.ctx.data.heightAt(ex, ez), ez]), cum: new Float32Array([0, 40]), segJ: new Int32Array([-2]), total: 40, startDest: -1, endDest: -1 };
		a.prog = 0; a.seg = 0; a.dir = 1; a.flee = 12; a.state = S_WALK;
	}

	/** Bodies currently drawn (for UI / debugging). */
	public visible(): NPCBody[] { return this.bodies.filter((b) => !!b.agent); }

	/** People near a point: walking or standing ones (abstract) and the ones with a body. */
	public countNear(x: number, z: number, r: number): { out: number; visible: number; byRole: { [k: string]: number } }
	{
		const r2 = r * r;
		let out = 0, vis = 0;
		const byRole: { [k: string]: number } = {};
		const each = (list: Agent[]) =>
		{
			for (let i = 0; i < list.length; i++)
			{
				const a = list[i];
				if (!this.visibleCandidate(a)) continue;
				const dx = a.x - x, dz = a.z - z;
				if (dx * dx + dz * dz > r2) continue;
				out++;
				if (a.vis) { vis++; byRole[ROLE_NAMES[a.role]] = (byRole[ROLE_NAMES[a.role]] || 0) + 1; }
			}
		};
		each(this.agents); each(this.extras);
		return { out: out, visible: vis, byRole: byRole };
	}

	public get counts(): { agents: number; walking: number; home: number; inside: number; standing: number; visible: number; pending: number; extras: number; roles: { [k: string]: number } }
	{
		let walking = 0, home = 0, inside = 0, pending = 0, total = 0, standing = 0;
		const roles: { [k: string]: number } = {};
		for (let i = 0; i < this.agents.length; i++)
		{
			const a = this.agents[i];
			const s = a.state;
			if (s === S_OFF) continue;
			total++;
			roles[ROLE_NAMES[a.role]] = (roles[ROLE_NAMES[a.role]] || 0) + 1;
			if (s === S_WALK) walking++; else if (s === S_HOME) home++; else if (s === S_INSIDE) inside++; else if (s === S_PENDING) pending++; else if (s === S_STAND) standing++;
		}
		return { agents: total, walking: walking, home: home, inside: inside, standing: standing, visible: this.visible().length, pending: pending, extras: this.extras.length, roles: roles };
	}

	public isNPCHome(buildingIndex: number): boolean { return !!this.homeSet[buildingIndex]; }
}

function sidewalkPoint(road: Road, s: number, side: number, off: number): { x: number; y: number; z: number }
{
	let i = 0;
	while (i < road.pts.length - 2 && road.pts[i + 1].s < s) i++;
	const a = road.pts[i], b = road.pts[i + 1];
	const t = Math.max(0, Math.min(1, (s - a.s) / Math.max(b.s - a.s, 1e-6)));
	const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
	const tx = b.x - a.x, tz = b.z - a.z, tl = Math.sqrt(tx * tx + tz * tz) || 1;
	const nx = -tz / tl, nz = tx / tl;
	const d = road.width / 2 + off;
	return { x: x + nx * d * side, y: a.y + (b.y - a.y) * t, z: z + nz * d * side };
}

// ---------------------------------------------------------------------------
// hook (RealismWorldBuilder): buildNPCs(ctx, signals)
// ---------------------------------------------------------------------------

export function buildNPCs(ctx: RealismCtx, signals: any): RealismNPCs
{
	const settings = npcSettings(ctx);
	const w: any = ctx.world;
	try
	{
		const npcs = new RealismNPCs(ctx, signals, settings);
		npcs.build();
		const homes: NPCHome[] = npcs.homes.map((di) =>
		{
			const d = npcs.dests[di];
			return { building: d.b, doorX: d.dx, doorZ: d.dz, rot: ctx.data.buildings[d.b].rot };
		});
		try
		{
			npcs.vehicles = new NPCVehicles(ctx, npcs, homes, settings);
			w.realismOwnedCars = npcs.vehicles.api;
		}
		catch (e) { console.warn('[Realism] NPC vehicles failed to build', e); }
		ctx.world.registerUpdatable(npcs);
		w.realismNPCs = npcs;
		const vs = npcs.vehicles ? npcs.vehicles.stats : {};
		console.log('[Realism] NPCs', npcs.stats, 'cars', vs);
		return npcs;
	}
	catch (e)
	{
		console.warn('[Realism] NPCs failed to build', e);
		return null;
	}
}
