/*
 * RealismGPS.ts
 * -------------
 * C8: waypoints, GPS routes along the county roads, map blips.
 *
 *   (world as any).realismGPS = {
 *       setWaypoint(pos: THREE.Vector3 | { x: number; z: number }, label?: string): void;
 *       clear(): void;
 *       current(): { x: number; z: number; label: string } | null;
 *       addBlip(id: string, b: { x: number; z: number; icon: string; color?: string; label?: string; shortRange?: boolean }): void;
 *       removeBlip(id: string): void;
 *       // extras
 *       route(): { length: number; remaining: number; points: number; nodes: number } | null;
 *       blips(): Array<{ id: string; x: number; z: number; icon: string; color: string; label: string; shortRange: boolean }>;
 *   }
 *
 *  - Road graph: built once from ctx.data.roads. Every road point is a node; crossings of two
 *    roads and road ends that touch another road (T-junctions) become shared nodes. Edge cost =
 *    length x road-class factor (highways are preferred, runways / taxiways avoided).
 *  - Routing: A* from the nearest road point to the player to the nearest road point to the
 *    waypoint; off-road ends are a straight dashed segment. Re-routes when the player is more than
 *    hud.offRouteDistance (25 m) from the route; arriving within hud.arriveDistance (15 m) clears
 *    the waypoint with an "Arrived" toast.
 *  - 3D: one translucent beam mesh at the waypoint (kept inside the far plane so it is visible from
 *    anywhere) and one ribbon mesh along the next hud.groundLineLength (150 m) of the route,
 *    rebuilt every 0.5 s / on a new route into a preallocated buffer.
 *  - Built-in blips from the map data: police, sheriff, hospital, bank, dealer, mod shop
 *    (mechanic), hotels, 24/7 markets. Shops / hotels / branches are short-range.
 *  - Events (C14): 'waypointSet' {x, z, label}, 'waypointCleared' {}, 'waypointArrived' {x, z, label}.
 */

import * as THREE from 'three';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { HALF } from './RealismMapData';
import { ensureEvents } from './RealismEvents';

// ---------------------------------------------------------------------------- settings

export interface HudSettings
{
	minimap: boolean;
	minimapWidth: number;
	minimapHeight: number;
	minimapFps: number;
	minimapTilt: number;
	minimapZoom: number;
	minimapDetail: number;
	maxTiles: number;
	builtInBlips: boolean;
	shortRange: number;
	prompts: boolean;
	bigMap: boolean;
	gps3D: boolean;
	groundLine: boolean;
	groundLineLength: number;
	arriveDistance: number;
	offRouteDistance: number;
	waypointColor: string;
	routeColor: string;
}

export const HUD_DEFAULTS: HudSettings = {
	minimap: true,
	minimapWidth: 200,
	minimapHeight: 140,
	minimapFps: 24,
	minimapTilt: 0,
	minimapZoom: 1,
	minimapDetail: 2,
	maxTiles: 10,
	builtInBlips: true,
	shortRange: 220,
	prompts: true,
	bigMap: true,
	gps3D: true,
	groundLine: true,
	groundLineLength: 150,
	arriveDistance: 15,
	offRouteDistance: 25,
	waypointColor: '#c45cff',
	routeColor: '#b44dff',
};

export function hudSettings(ctx: RealismCtx): HudSettings
{
	const u: any = (ctx && ctx.cfg && (ctx.cfg as any).hud) || {};
	const out: any = {};
	for (const k in HUD_DEFAULTS)
	{
		if (!HUD_DEFAULTS.hasOwnProperty(k)) continue;
		const d = (HUD_DEFAULTS as any)[k];
		const v = u[k];
		out[k] = (v === undefined || v === null || typeof v !== typeof d || (typeof v === 'number' && !isFinite(v))) ? d : v;
	}
	const s: HudSettings = out;
	s.minimapWidth = clamp(s.minimapWidth, 120, 420);
	s.minimapHeight = clamp(s.minimapHeight, 90, 320);
	s.minimapFps = clamp(s.minimapFps, 5, 60);
	s.minimapZoom = clamp(s.minimapZoom, 0.4, 3);
	s.minimapDetail = clamp(s.minimapDetail, 0.5, 4);
	s.maxTiles = Math.round(clamp(s.maxTiles, 4, 40));
	s.arriveDistance = clamp(s.arriveDistance, 3, 100);
	s.offRouteDistance = clamp(s.offRouteDistance, 8, 200);
	s.groundLineLength = clamp(s.groundLineLength, 20, 400);
	return s;
}

// ---------------------------------------------------------------------------- player

export interface PlayerState
{
	pos: THREE.Vector3;
	fx: number; fz: number;     // facing (xz, unit)
	speed: number;              // m/s (vehicles)
	kind: string;               // 'foot' | 'vehicle' | 'cam' | 'none'
	obj: any;
}

const _fwd = new THREE.Vector3();

/** Where the player is and which way they face (no allocations). */
export function readPlayer(world: any, out: PlayerState): PlayerState
{
	const im = world.inputManager;
	let r: any = im ? im.inputReceiver : null;
	out.kind = 'none'; out.obj = null; out.speed = 0;
	if (r && world.cameraOperator && r === world.cameraOperator)
	{
		const caller = (r as any).characterCaller;
		if (caller && caller.position) r = caller;
		else
		{
			world.camera.getWorldPosition(out.pos);
			world.camera.getWorldDirection(_fwd);
			setFacing(out, _fwd.x, _fwd.z);
			out.kind = 'cam';
			return out;
		}
	}
	if (r && r.characterCapsule !== undefined && r.position)
	{
		out.pos.copy(r.position);
		const o = r.orientation;
		if (o) setFacing(out, o.x, o.z);
		out.kind = 'foot'; out.obj = r;
		return out;
	}
	if (r && r.collision && r.position)
	{
		out.pos.copy(r.position);
		_fwd.set(0, 0, 1).applyQuaternion(r.quaternion);
		setFacing(out, _fwd.x, _fwd.z);
		const v = r.collision.velocity;
		out.speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0;
		out.kind = 'vehicle'; out.obj = r;
		return out;
	}
	if (world.camera)
	{
		world.camera.getWorldPosition(out.pos);
		world.camera.getWorldDirection(_fwd);
		setFacing(out, _fwd.x, _fwd.z);
	}
	return out;
}

function setFacing(out: PlayerState, x: number, z: number): void
{
	const l = Math.sqrt(x * x + z * z);
	if (l > 1e-5) { out.fx = x / l; out.fz = z / l; }
}

export function newPlayerState(): PlayerState { return { pos: new THREE.Vector3(), fx: 0, fz: -1, speed: 0, kind: 'none', obj: null }; }

// ---------------------------------------------------------------------------- road graph

const ROAD_COST: { [k: string]: number } = { highway: 0.72, avenue: 0.86, street: 1, rural: 1.08, apron: 1.8, taxiway: 3, runway: 4 };
const GCELL = 64;
const GDIM = Math.ceil((HALF * 2 + 400) / GCELL);
const GOFF = HALF + 200;

export interface NearestHit { seg: number; t: number; x: number; z: number; y: number; dist: number; }

export class RoadGraph
{
	public n = 0;
	public xs: Float32Array;
	public zs: Float32Array;
	public ys: Float32Array;
	public segA: Int32Array;
	public segB: Int32Array;
	public segLen: Float32Array;
	public segCost: Float32Array;
	public adjStart: Int32Array;
	public adjTo: Int32Array;
	public adjSeg: Int32Array;
	public buildMs = 0;
	private grid: { [k: number]: number[] } = {};
	private minCost = 0.72;
	// A* scratch (allocated once)
	private gScore: Float64Array;
	private came: Int32Array;
	private stamp: Uint32Array;
	private closed: Uint32Array;
	private run = 0;
	private heap: Int32Array;
	private heapF: Float64Array;
	private heapN = 0;
	public lastStats = { expanded: 0, ms: 0 };

	constructor(roads: any[])
	{
		const t0 = now();
		const X: number[] = [], Z: number[] = [], Y: number[] = [];
		const snap: { [k: string]: number[] } = {};
		const SN = 2;
		const nodeAt = (x: number, z: number, y: number): number =>
		{
			const gx = Math.floor(x / SN), gz = Math.floor(z / SN);
			for (let i = gx - 1; i <= gx + 1; i++)
				for (let j = gz - 1; j <= gz + 1; j++)
				{
					const l = snap[i + '_' + j];
					if (!l) continue;
					for (let k = 0; k < l.length; k++)
					{
						const id = l[k];
						const dx = X[id] - x, dz = Z[id] - z;
						if (dx * dx + dz * dz < 0.8 * 0.8) return id;
					}
				}
			const id = X.length;
			X.push(x); Z.push(z); Y.push(y);
			(snap[gx + '_' + gz] || (snap[gx + '_' + gz] = [])).push(id);
			return id;
		};
		// stations per road: [s, x, z, y]
		const st: number[][][] = [];
		const usable: boolean[] = [];
		for (let r = 0; r < roads.length; r++)
		{
			const P = roads[r].pts;
			usable.push(!!(P && P.length >= 2));
			const list: number[][] = [];
			if (P) for (let i = 0; i < P.length; i++) list.push([P[i].s, P[i].x, P[i].z, P[i].y || 0]);
			st.push(list);
		}
		// temp segment grid for crossings / T-junctions
		const tg: { [k: string]: number[] } = {};
		const TC = 48;
		const segR: number[] = [], segI: number[] = [];
		for (let r = 0; r < roads.length; r++)
		{
			if (!usable[r]) continue;
			const P = roads[r].pts;
			for (let i = 0; i < P.length - 1; i++)
			{
				const id = segR.length;
				segR.push(r); segI.push(i);
				const x0 = Math.floor(Math.min(P[i].x, P[i + 1].x) / TC), x1 = Math.floor(Math.max(P[i].x, P[i + 1].x) / TC);
				const z0 = Math.floor(Math.min(P[i].z, P[i + 1].z) / TC), z1 = Math.floor(Math.max(P[i].z, P[i + 1].z) / TC);
				for (let a = x0; a <= x1; a++) for (let b = z0; b <= z1; b++) (tg[a + '_' + b] || (tg[a + '_' + b] = [])).push(id);
			}
		}
		const pairDone: { [k: string]: boolean } = {};
		const interp = (P: any[], i: number, t: number) => [P[i].s + (P[i + 1].s - P[i].s) * t, P[i].x + (P[i + 1].x - P[i].x) * t, P[i].z + (P[i + 1].z - P[i].z) * t, (P[i].y || 0) + ((P[i + 1].y || 0) - (P[i].y || 0)) * t];
		for (const key in tg)
		{
			if (!tg.hasOwnProperty(key)) continue;
			const l = tg[key];
			for (let a = 0; a < l.length; a++)
				for (let b = a + 1; b < l.length; b++)
				{
					const s1 = l[a], s2 = l[b];
					const r1 = segR[s1], r2 = segR[s2];
					if (r1 === r2) continue;
					const pk = s1 < s2 ? s1 + ':' + s2 : s2 + ':' + s1;
					if (pairDone[pk]) continue;
					pairDone[pk] = true;
					const A = roads[r1].pts, B = roads[r2].pts, i = segI[s1], j = segI[s2];
					const ax = A[i].x, az = A[i].z, ex = A[i + 1].x - ax, ez = A[i + 1].z - az;
					const cx = B[j].x, cz = B[j].z, fx = B[j + 1].x - cx, fz = B[j + 1].z - cz;
					const den = ex * fz - ez * fx;
					if (Math.abs(den) < 1e-9) continue;
					const t = ((cx - ax) * fz - (cz - az) * fx) / den;
					const u = ((cx - ax) * ez - (cz - az) * ex) / den;
					if (t < -0.001 || t > 1.001 || u < -0.001 || u > 1.001) continue;
					const p1 = interp(A, i, clamp(t, 0, 1)), p2 = interp(B, j, clamp(u, 0, 1));
					// same point on both roads (exact x/z so they snap to one node)
					p2[1] = p1[1]; p2[2] = p1[2];
					p1[3] = p2[3] = Math.max(p1[3], p2[3]);
					st[r1].push(p1); st[r2].push(p2);
				}
		}
		// T-junctions: a road end that stops on / near another road
		const links: number[][] = [];   // [x0, z0, y0, x1, z1, y1]
		for (let r = 0; r < roads.length; r++)
		{
			if (!usable[r]) continue;
			const P = roads[r].pts;
			for (let e = 0; e < 2; e++)
			{
				const q = e === 0 ? P[0] : P[P.length - 1];
				const gx = Math.floor(q.x / TC), gz = Math.floor(q.z / TC);
				let best = 1e9, bs = -1, bt = 0;
				for (let a = gx - 1; a <= gx + 1; a++)
					for (let b = gz - 1; b <= gz + 1; b++)
					{
						const l = tg[a + '_' + b];
						if (!l) continue;
						for (let k = 0; k < l.length; k++)
						{
							const s = l[k];
							if (segR[s] === r) continue;
							const B = roads[segR[s]].pts, j = segI[s];
							const dx = B[j + 1].x - B[j].x, dz = B[j + 1].z - B[j].z;
							const L2 = dx * dx + dz * dz;
							const t = L2 > 0 ? clamp(((q.x - B[j].x) * dx + (q.z - B[j].z) * dz) / L2, 0, 1) : 0;
							const px = B[j].x + dx * t, pz = B[j].z + dz * t;
							const d = Math.sqrt((px - q.x) * (px - q.x) + (pz - q.z) * (pz - q.z));
							if (d < best) { best = d; bs = s; bt = t; }
						}
					}
				if (bs < 0) continue;
				const other = roads[segR[bs]];
				if (best > other.width / 2 + roads[r].width / 2 + 6) continue;
				const p = interp(other.pts, segI[bs], bt);
				st[segR[bs]].push(p);
				if (best > 0.5) links.push([q.x, q.z, q.y || 0, p[1], p[2], p[3]]);
			}
		}
		// nodes + segments
		const SA: number[] = [], SB: number[] = [], SL: number[] = [], SC: number[] = [];
		const addSeg = (a: number, b: number, cost: number) =>
		{
			if (a === b) return;
			const dx = X[b] - X[a], dz = Z[b] - Z[a];
			const len = Math.sqrt(dx * dx + dz * dz);
			if (len < 1e-3) return;
			SA.push(a); SB.push(b); SL.push(len); SC.push(cost);
		};
		for (let r = 0; r < roads.length; r++)
		{
			if (!usable[r]) continue;
			const list = st[r];
			list.sort((p, q) => p[0] - q[0]);
			const cost = ROAD_COST[roads[r].kind] || 1.1;
			let prev = -1, prevS = -1e9;
			for (let i = 0; i < list.length; i++)
			{
				const p = list[i];
				if (p[0] - prevS < 0.25 && i !== list.length - 1 && prev >= 0) continue;
				const id = nodeAt(p[1], p[2], p[3]);
				if (prev >= 0) addSeg(prev, id, cost);
				prev = id; prevS = p[0];
			}
		}
		for (let i = 0; i < links.length; i++)
		{
			const L = links[i];
			addSeg(nodeAt(L[0], L[1], L[2]), nodeAt(L[3], L[4], L[5]), 1.2);
		}
		this.n = X.length;
		this.xs = new Float32Array(X); this.zs = new Float32Array(Z); this.ys = new Float32Array(Y);
		const ns = SA.length;
		this.segA = new Int32Array(SA); this.segB = new Int32Array(SB); this.segLen = new Float32Array(SL); this.segCost = new Float32Array(SC);
		// CSR adjacency
		const deg = new Int32Array(this.n + 1);
		for (let s = 0; s < ns; s++) { deg[SA[s]]++; deg[SB[s]]++; }
		this.adjStart = new Int32Array(this.n + 1);
		for (let i = 0; i < this.n; i++) this.adjStart[i + 1] = this.adjStart[i] + deg[i];
		this.adjTo = new Int32Array(ns * 2); this.adjSeg = new Int32Array(ns * 2);
		const fill = new Int32Array(this.n);
		for (let s = 0; s < ns; s++)
		{
			const a = SA[s], b = SB[s];
			let k = this.adjStart[a] + fill[a]++; this.adjTo[k] = b; this.adjSeg[k] = s;
			k = this.adjStart[b] + fill[b]++; this.adjTo[k] = a; this.adjSeg[k] = s;
		}
		// nearest-segment grid
		for (let s = 0; s < ns; s++)
		{
			const a = SA[s], b = SB[s];
			const x0 = cellOf(Math.min(X[a], X[b])), x1 = cellOf(Math.max(X[a], X[b]));
			const z0 = cellOf(Math.min(Z[a], Z[b])), z1 = cellOf(Math.max(Z[a], Z[b]));
			for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) { const k = gx * GDIM + gz; (this.grid[k] || (this.grid[k] = [])).push(s); }
		}
		for (let s = 0; s < ns; s++) this.minCost = Math.min(this.minCost, SC[s]);
		this.gScore = new Float64Array(this.n);
		this.came = new Int32Array(this.n);
		this.stamp = new Uint32Array(this.n);
		this.closed = new Uint32Array(this.n);
		this.heap = new Int32Array(ns * 2 + 16);
		this.heapF = new Float64Array(ns * 2 + 16);
		this.buildMs = now() - t0;
	}

	public get segCount(): number { return this.segA.length; }

	/** Nearest point on any road segment within maxR metres (writes `out`, returns false if none). */
	public nearest(x: number, z: number, maxR: number, out: NearestHit): boolean
	{
		const cx = cellOf(x), cz = cellOf(z);
		let best = maxR * maxR, found = false;
		const rings = Math.ceil(maxR / GCELL) + 1;
		for (let ring = 0; ring <= rings; ring++)
		{
			for (let gx = cx - ring; gx <= cx + ring; gx++)
				for (let gz = cz - ring; gz <= cz + ring; gz++)
				{
					if (Math.max(Math.abs(gx - cx), Math.abs(gz - cz)) !== ring) continue;
					const l = this.grid[gx * GDIM + gz];
					if (!l) continue;
					for (let k = 0; k < l.length; k++)
					{
						const s = l[k];
						const a = this.segA[s], b = this.segB[s];
						const ax = this.xs[a], az = this.zs[a];
						const dx = this.xs[b] - ax, dz = this.zs[b] - az;
						const L2 = dx * dx + dz * dz;
						const t = L2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1) : 0;
						const px = ax + dx * t, pz = az + dz * t;
						const d = (px - x) * (px - x) + (pz - z) * (pz - z);
						if (d < best)
						{
							best = d; found = true;
							out.seg = s; out.t = t; out.x = px; out.z = pz; out.y = this.ys[a] + (this.ys[b] - this.ys[a]) * t;
						}
					}
				}
			// everything in the next ring is at least ring*GCELL away
			if (found && ring * GCELL > Math.sqrt(best) + GCELL) break;
		}
		if (found) out.dist = Math.sqrt(best);
		return found;
	}

	/**
	 * A* between two points already projected onto segments. Returns the node path (without the
	 * projected end points) in `path`, and the cost, or -1 when unreachable.
	 */
	public search(s: NearestHit, g: NearestHit, path: number[]): number
	{
		const t0 = now();
		path.length = 0;
		if (s.seg === g.seg) { this.lastStats.expanded = 0; this.lastStats.ms = now() - t0; return Math.abs(s.t - g.t) * this.segLen[s.seg] * this.segCost[s.seg]; }
		this.run++;
		if (this.run > 0xfffffff0) { this.run = 1; this.stamp.fill(0); this.closed.fill(0); }
		const run = this.run;
		this.heapN = 0;
		const gx = g.x, gz = g.z, mc = this.minCost;
		const ga = this.segA[g.seg], gb = this.segB[g.seg];
		const gl = this.segLen[g.seg] * this.segCost[g.seg];
		const costA = g.t * gl, costB = (1 - g.t) * gl;
		const sl = this.segLen[s.seg] * this.segCost[s.seg];
		const seed = (n: number, c: number) =>
		{
			if (this.stamp[n] === run && this.gScore[n] <= c) return;
			this.stamp[n] = run; this.gScore[n] = c; this.came[n] = -1;
			this.push(n, c + this.h(n, gx, gz, mc));
		};
		seed(this.segA[s.seg], s.t * sl);
		seed(this.segB[s.seg], (1 - s.t) * sl);
		let best = Infinity, bestEnd = -1, expanded = 0;
		while (this.heapN > 0)
		{
			const f = this.heapF[0];
			const u = this.pop();
			if (f >= best) break;
			if (this.closed[u] === run) continue;
			this.closed[u] = run;
			expanded++;
			const gu = this.gScore[u];
			if (u === ga && gu + costA < best) { best = gu + costA; bestEnd = u; }
			if (u === gb && gu + costB < best) { best = gu + costB; bestEnd = u; }
			for (let k = this.adjStart[u], e = this.adjStart[u + 1]; k < e; k++)
			{
				const v = this.adjTo[k];
				if (this.closed[v] === run) continue;
				const sg = this.adjSeg[k];
				const c = gu + this.segLen[sg] * this.segCost[sg];
				if (this.stamp[v] === run && this.gScore[v] <= c) continue;
				this.stamp[v] = run; this.gScore[v] = c; this.came[v] = u;
				this.push(v, c + this.h(v, gx, gz, mc));
			}
		}
		this.lastStats.expanded = expanded;
		this.lastStats.ms = now() - t0;
		if (bestEnd < 0) return -1;
		for (let n = bestEnd; n >= 0; n = this.came[n]) path.push(n);
		path.reverse();
		return best;
	}

	private h(n: number, gx: number, gz: number, mc: number): number
	{
		const dx = this.xs[n] - gx, dz = this.zs[n] - gz;
		return Math.sqrt(dx * dx + dz * dz) * mc;
	}

	private push(n: number, f: number): void
	{
		let i = this.heapN++;
		if (i >= this.heap.length) { this.heapN--; return; }
		const H = this.heap, F = this.heapF;
		while (i > 0)
		{
			const p = (i - 1) >> 1;
			if (F[p] <= f) break;
			H[i] = H[p]; F[i] = F[p]; i = p;
		}
		H[i] = n; F[i] = f;
	}

	private pop(): number
	{
		const H = this.heap, F = this.heapF;
		const top = H[0];
		const n = --this.heapN;
		if (n <= 0) return top;
		const ln = H[n], lf = F[n];
		let i = 0;
		for (;;)
		{
			let c = 2 * i + 1;
			if (c >= n) break;
			if (c + 1 < n && F[c + 1] < F[c]) c++;
			if (F[c] >= lf) break;
			H[i] = H[c]; F[i] = F[c]; i = c;
		}
		H[i] = ln; F[i] = lf;
		return top;
	}
}

function cellOf(v: number): number { return Math.max(0, Math.min(GDIM - 1, Math.floor((v + GOFF) / GCELL))); }

// ---------------------------------------------------------------------------- GPS

export interface Blip { id: string; x: number; z: number; icon: string; color: string; label: string; shortRange: boolean; builtin: boolean; }

const MAX_ROUTE = 4096;
const MAX_LINE = 120;

export class RealismGPS implements IUpdatable
{
	public updateOrder = 42;
	public ctx: RealismCtx;
	public world: any;
	public settings: HudSettings;
	public graph: RoadGraph = null;
	public waypoint: { x: number; z: number; label: string } = null;
	/** Route polyline (world xz + road height). Points [roadStart, roadEnd] follow roads; the rest are straight (dashed). */
	public rx = new Float32Array(MAX_ROUTE);
	public rz = new Float32Array(MAX_ROUTE);
	public ry = new Float32Array(MAX_ROUTE);
	public rs = new Float32Array(MAX_ROUTE);   // cumulative length
	public rn = 0;
	public roadStart = 0;
	public roadEnd = 0;
	public routeVersion = 0;
	public routeNodes = 0;
	public progressIdx = 0;
	public remaining = 0;
	public blipMap: { [id: string]: Blip } = {};
	public blipList: Blip[] = [];
	public blipVersion = 0;
	public stats = { routes: 0, recalcs: 0, lastMs: 0, lastExpanded: 0, arrivals: 0, lineBuilds: 0 };
	private ps: PlayerState = newPlayerState();
	private hitS: NearestHit = { seg: -1, t: 0, x: 0, z: 0, y: 0, dist: 0 };
	private hitG: NearestHit = { seg: -1, t: 0, x: 0, z: 0, y: 0, dist: 0 };
	private path: number[] = [];
	private recalcCooldown = 0;
	private lineAcc = 0;
	private pendingRoute = false;
	private beam: THREE.Mesh = null;
	private line: THREE.Mesh = null;
	private linePos: Float32Array = null;
	private lineAttr: THREE.BufferAttribute = null;
	private toastEl: HTMLElement = null;
	private toastUntil = 0;
	private tmp = new THREE.Vector3();
	private tmp2 = new THREE.Vector3();
	private changeCbs: (() => void)[] = [];

	constructor(ctx: RealismCtx, settings?: HudSettings)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		this.settings = settings || hudSettings(ctx);
		try { this.graph = new RoadGraph(ctx.data.roads); }
		catch (e) { console.warn('[Realism] GPS road graph failed', e); this.graph = null; }
		if (this.settings.builtInBlips) this.addBuiltInBlips();
		const self = this;
		const api = {
			setWaypoint(pos: any, label?: string): void { self.setWaypoint(pos, label); },
			clear(): void { self.clear(); },
			current(): { x: number; z: number; label: string } | null { return self.waypoint ? { x: self.waypoint.x, z: self.waypoint.z, label: self.waypoint.label } : null; },
			addBlip(id: string, b: any): void { self.addBlip(id, b); },
			removeBlip(id: string): void { self.removeBlip(id); },
			route(): any { return self.routeInfo(); },
			blips(): any[] { return self.blipList.map((b) => ({ id: b.id, x: b.x, z: b.z, icon: b.icon, color: b.color, label: b.label, shortRange: b.shortRange })); },
			onChange(cb: () => void): void { if (typeof cb === 'function') self.changeCbs.push(cb); },
		};
		this.world.realismGPS = api;
		ensureEvents(this.world);
	}

	// ------------------------------------------------------------------ API

	public setWaypoint(pos: any, label?: string): void
	{
		if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number' || !isFinite(pos.x) || !isFinite(pos.z)) return;
		const x = clamp(pos.x, -HALF, HALF), z = clamp(pos.z, -HALF, HALF);
		this.waypoint = { x: x, z: z, label: label ? String(label) : 'Waypoint' };
		this.pendingRoute = true;
		this.recalcCooldown = 0;
		this.rn = 0;
		this.routeVersion++;
		this.computeRoute();
		this.emit('waypointSet', { x: x, z: z, label: this.waypoint.label });
		this.changed();
	}

	public clear(): void
	{
		if (!this.waypoint && this.rn === 0) return;
		this.waypoint = null;
		this.rn = 0;
		this.remaining = 0;
		this.routeVersion++;
		this.pendingRoute = false;
		this.hide3D();
		this.emit('waypointCleared', {});
		this.changed();
	}

	public addBlip(id: string, b: any): void
	{
		if (!id || !b || typeof b.x !== 'number' || typeof b.z !== 'number') return;
		let bl = this.blipMap[id];
		if (!bl)
		{
			bl = { id: id, x: 0, z: 0, icon: 'job', color: '', label: '', shortRange: false, builtin: id.indexOf('builtin:') === 0 };
			this.blipMap[id] = bl;
			this.blipList.push(bl);
		}
		bl.x = b.x; bl.z = b.z;
		bl.icon = b.icon ? String(b.icon) : 'job';
		bl.color = b.color ? String(b.color) : '';
		bl.label = b.label ? String(b.label) : '';
		bl.shortRange = !!b.shortRange;
		this.blipVersion++;
	}

	public removeBlip(id: string): void
	{
		const bl = this.blipMap[id];
		if (!bl) return;
		delete this.blipMap[id];
		const i = this.blipList.indexOf(bl);
		if (i >= 0) this.blipList.splice(i, 1);
		this.blipVersion++;
	}

	public routeInfo(): { length: number; remaining: number; points: number; nodes: number; ms: number } | null
	{
		if (!this.waypoint || this.rn < 2) return null;
		return { length: this.rs[this.rn - 1], remaining: this.remaining, points: this.rn, nodes: this.routeNodes, ms: this.stats.lastMs };
	}

	public onChange(cb: () => void): void { this.changeCbs.push(cb); }

	private changed(): void
	{
		for (let i = 0; i < this.changeCbs.length; i++) { try { this.changeCbs[i](); } catch (e) { /* ignore */ } }
	}

	private emit(name: string, data: any): void
	{
		const ev = this.world.realismEvents;
		if (ev && typeof ev.emit === 'function') ev.emit(name, data);
	}

	// ------------------------------------------------------------------ built-in blips

	private addBuiltInBlips(): void
	{
		const data: any = this.ctx.data;
		const lm = data.landmarks || [];
		for (let i = 0; i < lm.length; i++)
		{
			const l = lm[i];
			let icon = '', sr = false;
			if (l.kind === 'police') icon = /sheriff/i.test(l.name) ? 'sheriff' : 'police';
			else if (l.kind === 'hospital') icon = 'hospital';
			else if (l.kind === 'bank') icon = 'bank';
			else if (l.kind === 'dealer') icon = 'dealer';
			else if (l.kind === 'mechanic') icon = 'modshop';
			if (!icon) continue;
			this.addBlip('builtin:lm' + i, { x: l.x, z: l.z, icon: icon, label: cleanName(l.name), shortRange: sr });
		}
		const bs = data.buildings || [];
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			const label = b.label ? String(b.label) : '';
			if (b.custom === 'hotel' && b.role !== 'wing')
			{
				if (this.near('hotel', b.x, b.z, 60)) continue;
				this.addBlip('builtin:b' + i, { x: b.x, z: b.z, icon: 'hotel', label: label ? titleCase(label) : 'Hotel', shortRange: true });
			}
			else if (b.sub === 'bank' && !this.near('bank', b.x, b.z, 80))
				this.addBlip('builtin:b' + i, { x: b.x, z: b.z, icon: 'bank', label: label ? titleCase(label) : 'Bank', shortRange: true });
			else if ((b.sub === 'market' || b.sub === 'convenience' || /24\/7/.test(label)) && !b.closed && !this.near('shop', b.x, b.z, 40))
				this.addBlip('builtin:b' + i, { x: b.x, z: b.z, icon: 'shop', label: '24/7', shortRange: true });
		}
	}

	private near(icon: string, x: number, z: number, r: number): boolean
	{
		for (let i = 0; i < this.blipList.length; i++)
		{
			const b = this.blipList[i];
			if (b.icon === icon && Math.abs(b.x - x) < r && Math.abs(b.z - z) < r) return true;
		}
		return false;
	}

	// ------------------------------------------------------------------ routing

	/** Builds the route from the player to the waypoint. */
	public computeRoute(): boolean
	{
		if (!this.waypoint) return false;
		this.pendingRoute = false;
		readPlayer(this.world, this.ps);
		const p = this.ps.pos;
		const w = this.waypoint;
		const t0 = now();
		let n = 0;
		const put = (x: number, z: number, y: number) =>
		{
			if (n >= MAX_ROUTE) return;
			if (n > 0 && Math.abs(this.rx[n - 1] - x) < 0.05 && Math.abs(this.rz[n - 1] - z) < 0.05) return;
			this.rx[n] = x; this.rz[n] = z; this.ry[n] = y;
			this.rs[n] = n === 0 ? 0 : this.rs[n - 1] + Math.sqrt((x - this.rx[n - 1]) * (x - this.rx[n - 1]) + (z - this.rz[n - 1]) * (z - this.rz[n - 1]));
			n++;
		};
		const data = this.ctx.data;
		const g = this.graph;
		const S = this.hitS, G = this.hitG;
		let ok = false;
		this.routeNodes = 0;
		if (g && g.nearest(p.x, p.z, 900, S) && g.nearest(w.x, w.z, 900, G))
		{
			const cost = g.search(S, G, this.path);
			if (cost >= 0)
			{
				put(p.x, p.z, groundY(data, p.x, p.z));
				this.roadStart = S.dist > 3 ? 1 : 0;
				put(S.x, S.z, S.y);
				if (S.dist <= 3) this.roadStart = 0;
				const path = this.path;
				for (let i = 0; i < path.length; i++) put(g.xs[path[i]], g.zs[path[i]], g.ys[path[i]]);
				put(G.x, G.z, G.y);
				this.roadEnd = n - 1;
				put(w.x, w.z, groundY(data, w.x, w.z));
				this.routeNodes = path.length;
				ok = true;
				this.stats.lastExpanded = g.lastStats.expanded;
			}
		}
		if (!ok)
		{
			put(p.x, p.z, groundY(data, p.x, p.z));
			put(w.x, w.z, groundY(data, w.x, w.z));
			this.roadStart = this.roadEnd = 0;
		}
		this.rn = n;
		this.progressIdx = 0;
		this.remaining = n > 0 ? this.rs[n - 1] : 0;
		this.routeVersion++;
		this.stats.routes++;
		this.stats.lastMs = now() - t0;
		this.lineAcc = 1;   // rebuild the ground line now
		return ok;
	}

	// ------------------------------------------------------------------ frame

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		const w = this.world;
		const dt = Math.min(0.1, unscaledTimeStep || timeStep || 0.016);
		if (this.toastEl && this.toastUntil > 0 && now() > this.toastUntil) { this.toastEl.className = 'rr-gps-toast'; this.toastUntil = 0; }
		if (w.realismPaused) return;
		if (!this.waypoint) return;
		readPlayer(w, this.ps);
		const p = this.ps.pos;
		if (this.pendingRoute) this.computeRoute();
		// arrived?
		const dx = this.waypoint.x - p.x, dz = this.waypoint.z - p.z;
		if (this.ps.kind !== 'cam' && dx * dx + dz * dz < this.settings.arriveDistance * this.settings.arriveDistance)
		{
			const wp = this.waypoint;
			this.stats.arrivals++;
			this.clear();
			this.toast('Arrived');
			this.emit('waypointArrived', { x: wp.x, z: wp.z, label: wp.label });
			return;
		}
		// progress along the route + off-route check
		this.recalcCooldown -= dt;
		const off = this.trackProgress(p.x, p.z);
		if (off > this.settings.offRouteDistance && this.recalcCooldown <= 0 && this.ps.kind !== 'cam')
		{
			this.recalcCooldown = 1.5;
			this.stats.recalcs++;
			this.computeRoute();
		}
		if (this.settings.gps3D) this.update3D(dt);
	}

	/** Moves progressIdx to the route segment nearest the player; returns the distance to it. */
	public trackProgress(x: number, z: number): number
	{
		const n = this.rn;
		if (n < 2) return 0;
		let best = 1e18, bi = this.progressIdx, bt = 0;
		const i0 = Math.max(0, this.progressIdx - 3), i1 = Math.min(n - 2, this.progressIdx + 60);
		for (let i = i0; i <= i1; i++)
		{
			const ax = this.rx[i], az = this.rz[i];
			const ex = this.rx[i + 1] - ax, ez = this.rz[i + 1] - az;
			const L2 = ex * ex + ez * ez;
			const t = L2 > 0 ? clamp(((x - ax) * ex + (z - az) * ez) / L2, 0, 1) : 0;
			const px = ax + ex * t - x, pz = az + ez * t - z;
			const d = px * px + pz * pz;
			if (d < best) { best = d; bi = i; bt = t; }
		}
		this.progressIdx = bi;
		this.remaining = Math.max(0, this.rs[n - 1] - (this.rs[bi] + (this.rs[bi + 1] - this.rs[bi]) * bt));
		this.progT = bt;
		return Math.sqrt(best);
	}
	public progT = 0;

	// ------------------------------------------------------------------ 3D markers

	private ensure3D(): void
	{
		if (this.beam !== null) return;
		const col = new THREE.Color(this.settings.waypointColor);
		// beam: open cylinder, fades out towards the top (alpha map)
		const N = 32;
		const px = new Uint8Array(N * 4);
		for (let i = 0; i < N; i++)
		{
			const v = i / (N - 1);
			const a = Math.round(255 * Math.pow(1 - v, 1.6));
			px[i * 4] = a; px[i * 4 + 1] = a; px[i * 4 + 2] = a; px[i * 4 + 3] = 255;
		}
		const alpha = new THREE.DataTexture(px, 1, N, THREE.RGBAFormat);
		alpha.needsUpdate = true;
		const bg = new THREE.CylinderBufferGeometry(1, 1, 1, 14, 1, true);
		bg.translate(0, 0.5, 0);
		const bm = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, alphaMap: alpha, fog: false });
		const beam = new THREE.Mesh(bg, bm);
		beam.name = 'gpsWaypointBeam';
		beam.frustumCulled = false;
		beam.renderOrder = 5;
		beam.visible = false;
		this.world.graphicsWorld.add(beam);
		this.beam = beam;
		// ground line ribbon
		const lg = new THREE.BufferGeometry();
		this.linePos = new Float32Array(MAX_LINE * 2 * 3);
		this.lineAttr = new THREE.BufferAttribute(this.linePos, 3);
		this.lineAttr.setUsage(THREE.DynamicDrawUsage);
		lg.setAttribute('position', this.lineAttr);
		const idx = new Uint16Array((MAX_LINE - 1) * 6);
		for (let i = 0; i < MAX_LINE - 1; i++)
		{
			const a = i * 2;
			idx[i * 6] = a; idx[i * 6 + 1] = a + 1; idx[i * 6 + 2] = a + 2;
			idx[i * 6 + 3] = a + 1; idx[i * 6 + 4] = a + 3; idx[i * 6 + 5] = a + 2;
		}
		lg.setIndex(new THREE.BufferAttribute(idx, 1));
		lg.setDrawRange(0, 0);
		const lm = new THREE.MeshBasicMaterial({ color: new THREE.Color(this.settings.routeColor), transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
		const line = new THREE.Mesh(lg, lm);
		line.name = 'gpsRouteLine';
		line.frustumCulled = false;
		line.renderOrder = 4;
		line.visible = false;
		this.world.graphicsWorld.add(line);
		this.line = line;
	}

	private hide3D(): void
	{
		if (this.beam) this.beam.visible = false;
		if (this.line) this.line.visible = false;
	}

	private update3D(dt: number): void
	{
		this.ensure3D();
		const w = this.waypoint;
		const cam = this.world.camera;
		// beam: inside the far plane, thinner with distance, so it reads from anywhere
		cam.getWorldPosition(this.tmp);
		const far = cam.far || 500;
		let bx = w.x, bz = w.z;
		const dx = bx - this.tmp.x, dz = bz - this.tmp.z;
		const d = Math.sqrt(dx * dx + dz * dz);
		const lim = far * 0.8;
		let r = 1.4;
		if (d > lim) { const k = lim / d; bx = this.tmp.x + dx * k; bz = this.tmp.z + dz * k; r *= k; }
		const by = groundY(this.ctx.data, bx, bz) - 2;
		this.beam.position.set(bx, by, bz);
		this.beam.scale.set(Math.max(r, 0.35), 160, Math.max(r, 0.35));
		this.beam.updateMatrix();
		this.beam.visible = true;
		// ground line
		this.lineAcc += dt;
		if (this.settings.groundLine && this.lineAcc >= 0.5)
		{
			this.lineAcc = 0;
			this.buildLine();
		}
		if (!this.settings.groundLine) this.line.visible = false;
	}

	/** Rebuilds the ribbon along the next groundLineLength metres of route. */
	public buildLine(): void
	{
		this.ensure3D();
		const n = this.rn;
		if (n < 2) { this.line.visible = false; return; }
		const P = this.linePos;
		const len = this.settings.groundLineLength;
		const data = this.ctx.data;
		const hw = 0.45;
		let count = 0;
		// start at the player's projection on the route
		const i0 = this.progressIdx;
		const sx = this.rx[i0] + (this.rx[i0 + 1] - this.rx[i0]) * this.progT;
		const sz = this.rz[i0] + (this.rz[i0 + 1] - this.rz[i0]) * this.progT;
		const s0 = this.rs[i0] + (this.rs[i0 + 1] - this.rs[i0]) * this.progT;
		const emit = (x: number, z: number, y: number, tx: number, tz: number) =>
		{
			if (count >= MAX_LINE) return;
			const tl = Math.sqrt(tx * tx + tz * tz) || 1;
			const nx = -tz / tl * hw, nz = tx / tl * hw;
			const yy = Math.max(y, data.heightAt(x, z)) + 0.32;
			const o = count * 6;
			P[o] = x + nx; P[o + 1] = yy; P[o + 2] = z + nz;
			P[o + 3] = x - nx; P[o + 4] = yy; P[o + 5] = z - nz;
			count++;
		};
		emit(sx, sz, this.ry[i0], this.rx[i0 + 1] - this.rx[i0], this.rz[i0 + 1] - this.rz[i0]);
		for (let i = i0 + 1; i < n && count < MAX_LINE; i++)
		{
			const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
			if (this.rs[i] - s0 > len)
			{
				// cut the last piece at exactly `len`
				const k = (s0 + len - this.rs[i - 1]) / Math.max(1e-3, this.rs[i] - this.rs[i - 1]);
				emit(this.rx[i - 1] + (this.rx[i] - this.rx[i - 1]) * k, this.rz[i - 1] + (this.rz[i] - this.rz[i - 1]) * k, this.ry[i - 1] + (this.ry[i] - this.ry[i - 1]) * k, this.rx[i] - this.rx[i - 1], this.rz[i] - this.rz[i - 1]);
				break;
			}
			// long straight pieces get intermediate points so the ribbon follows the terrain
			const segL = this.rs[i] - this.rs[i - 1];
			const steps = Math.min(8, Math.floor(segL / 12));
			for (let k = 1; k <= steps && count < MAX_LINE - 1; k++)
			{
				const f = k / (steps + 1);
				emit(this.rx[i - 1] + (this.rx[i] - this.rx[i - 1]) * f, this.rz[i - 1] + (this.rz[i] - this.rz[i - 1]) * f, this.ry[i - 1] + (this.ry[i] - this.ry[i - 1]) * f, this.rx[i] - this.rx[i - 1], this.rz[i] - this.rz[i - 1]);
			}
			emit(this.rx[i], this.rz[i], this.ry[i], this.rx[b] - this.rx[a], this.rz[b] - this.rz[a]);
		}
		const g = this.line.geometry as THREE.BufferGeometry;
		g.setDrawRange(0, Math.max(0, count - 1) * 6);
		const ar: any = this.lineAttr;
		ar.updateRange.offset = 0; ar.updateRange.count = count * 6;
		this.lineAttr.needsUpdate = true;
		this.line.visible = count >= 2;
		this.stats.lineBuilds++;
		this.lineCount = count;
	}
	public lineCount = 0;

	// ------------------------------------------------------------------ toast

	public toast(text: string): void
	{
		try
		{
			if (this.toastEl === null)
			{
				if (typeof document === 'undefined' || !document.body || !document.createElement) return;
				const el = document.createElement('div');
				el.className = 'rr-gps-toast';
				document.body.appendChild(el);
				this.toastEl = el;
			}
			this.toastEl.textContent = text;
			this.toastEl.className = 'rr-gps-toast rr-gps-toast-on';
			this.toastUntil = now() + 2200;
		}
		catch (e) { /* headless */ }
	}
}

export function groundY(data: any, x: number, z: number): number
{
	const h = data.heightAt(x, z);
	return h > 0 ? h : 0;
}

function cleanName(s: string): string { return String(s || '').replace(/\s*\(.*\)\s*$/, ''); }
function titleCase(s: string): string { return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b24\/7\b/i, '24/7'); }
function clamp(v: number, a: number, b: number): number { return v < a ? a : (v > b ? b : v); }
function now(): number { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
