/*
 * RealismTraffic.ts
 * -----------------
 * NPC traffic: cars that drive the road lanes near the player.
 *
 *  - Lanes come from the map roads (highway / avenue / street / rural; never runways). Every road is
 *    cut into edges between junctions; each edge gets one lane per direction, offset to the driver's
 *    right (right-hand traffic). At each junction short curved connectors join every incoming lane
 *    to every outgoing lane (straight on, left, right; a U-turn only at a dead end).
 *  - Signals: a car's light is the TrafficSignals light of the junction arm it comes in on, with the
 *    same cycle / group / phase maths (city.trafficCycle, green < 0.42, yellow < 0.5, red after).
 *    Pedestrians in RealismNPCs cross a road only while that road's cars are red.
 *    Stop signs: a full stop at the line, then go when the junction is clear.
 *  - A car never enters a junction while a crossing path is taken, or when there is no room behind
 *    the car it will follow. Car-following on every lane (brakes to keep a gap), speed limits per road.
 *  - Stops for people in front of it (pedestrians on the road / crosswalks), for the player (on foot or
 *    in a car) and for any real car; honks when the player blocks it.
 *  - Only cars within traffic.radius (200 m) of the player exist; beyond it there is no simulation.
 *    New cars appear on lanes between spawnMin and radius metres away; a pool of traffic.maxCars
 *    (12 on medium, 6 on low, 16 on high) times the density (0..2, the settings slider).
 *  - Drawing: car.glb merged into one body + one wheel geometry; one InstancedMesh per paint
 *    colour, one for all wheels, one for all driver silhouettes. So at most 7 + 2 draw calls.
 *  - Cars move kinematically along their lane (no raycast-vehicle physics). Within colliderRange of
 *    the player each car gets a kinematic cannon box body, so the player's car hits it; a hard hit
 *    stops the car for a few seconds and the driver honks.
 *  - Gunfire (RealismNPCs.panic): cars near it either race away (faster, run red lights) or, when slow,
 *    the driver bails out and runs (a fleeing pedestrian) and the car is left standing.
 *  - Carjacking: on foot, press F within ~3 m of a stopped or slow traffic car. The driver gets out and
 *    flees, the car becomes a real Sketchbook Car and the player gets in. Once the player is in the
 *    driver seat the car is made owned with world.realismOwnedCars.claim(car, { origin: 'traffic',
 *    type: 'car', rgb }) when that exists (contract C2); otherwise it is just drivable.
 *
 * API (world as any).realismTraffic:
 *    ready, settings, stats
 *    setDensity(0..2) / getDensity()      (RealismNPCs.setDensity forwards here)
 *    panic(point, radius)                 (RealismNPCs.panic forwards here)
 *    tryCarjack(): boolean                (what the F key does)
 *    debugCars(): [{ id, x, y, z, v, lane, road, light, mode }]
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { RealismCtx } from './RealismContext';
import { Road } from './RealismMapData';
import { Car } from '../vehicles/Car';
import { cheapMaterial } from './RealismAssets';
import { ownGeometry } from './RealismInstanceGeom';
import { InstancedCarLights, measureLamps, carLightSettings, isNightNow, blinkOn, packBits, LampLayout } from './RealismCarLights';
import { loadSharedModel, playerScaleOf } from './RealismNPCs';

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export interface TrafficSettings
{
	enabled: boolean;
	density: number;          // 0..2 (multiplies maxCars)
	maxCars: number;          // cars around the player at density 1
	radius: number;           // metres: cars exist only this close
	spawnMin: number;         // metres: new cars appear at least this far away
	speedScale: number;       // multiplies every speed limit
	speeds: { [kind: string]: number };   // m/s per road kind
	colliders: boolean;       // kinematic boxes so the player's car hits traffic
	colliderRange: number;
	maxColliders: number;
	carjack: boolean;
	jackRange: number;        // metres from the car centre (scaled by the player scale when > 1)
	jackSpeed: number;        // m/s: a car must be this slow to be carjacked
	honk: boolean;
	drivers: boolean;         // draw driver silhouettes
	panic: boolean;           // react to gunfire
	multiLane: boolean;       // 2 lanes each way on avenues and highways
	avoidView: boolean;       // spawn outside the camera view when possible (no pop-in)
	variety: number;          // 0..1 share of taxis / police cruisers in traffic
}

export function trafficSettings(ctx: RealismCtx): TrafficSettings
{
	const w: any = typeof window !== 'undefined' ? window : {};
	const raw: any = (ctx.cfg as any).traffic || (w.REALISM_CONFIG && w.REALISM_CONFIG.traffic) || {};
	const low = ctx.presetName === 'low', high = ctx.presetName === 'high' || ctx.presetName === 'ultra';
	const num = (v: any, d: number, a: number, b: number) => (typeof v === 'number' && isFinite(v) ? Math.max(a, Math.min(b, v)) : d);
	const sp: any = raw.speeds || {};
	return {
		enabled: raw.enabled !== false,
		density: num(raw.density, 1, 0, 2),
		// per preset: low 8, medium 20, high/ultra 28 (maxCars in the config overrides all presets;
		// maxCarsLow / maxCarsMedium / maxCarsHigh override one)
		maxCars: Math.round(num(raw.maxCars, num(low ? raw.maxCarsLow : (high ? raw.maxCarsHigh : raw.maxCarsMedium), low ? 8 : (high ? 28 : 20), 0, 40), 0, 40)),
		multiLane: raw.multiLane !== false,
		avoidView: raw.avoidView !== false,
		variety: num(raw.variety, 0.12, 0, 1),
		radius: num(raw.radius, low ? 160 : (high ? 220 : 200), 60, 400),
		spawnMin: num(raw.spawnMin, low ? 60 : 70, 20, 200),
		speedScale: num(raw.speedScale, 1, 0.2, 2),
		speeds: {
			highway: num(sp.highway, 24, 3, 45), avenue: num(sp.avenue, 14, 3, 40),
			street: num(sp.street, 11, 3, 40), rural: num(sp.rural, 16, 3, 40),
		},
		colliders: raw.colliders !== false,
		colliderRange: num(raw.colliderRange, 70, 10, 200),
		maxColliders: Math.round(num(raw.maxColliders, low ? 6 : 12, 0, 40)),
		carjack: raw.carjack !== false,
		jackRange: num(raw.jackRange, 3.2, 1, 8),
		jackSpeed: num(raw.jackSpeed, 3, 0, 20),
		honk: raw.honk !== false,
		drivers: raw.drivers !== false,
		panic: raw.panic !== false,
	};
}

const DRIVABLE: { [k: string]: boolean } = { highway: true, avenue: true, street: true, rural: true };
const PALETTE: { name: string; rgb: number[] }[] = [
	{ name: 'White', rgb: [0.95, 0.95, 0.94] }, { name: 'Black', rgb: [0.13, 0.13, 0.14] }, { name: 'Silver', rgb: [0.62, 0.64, 0.66] },
	{ name: 'Red', rgb: [0.72, 0.09, 0.08] }, { name: 'Blue', rgb: [0.14, 0.25, 0.58] }, { name: 'Green', rgb: [0.16, 0.34, 0.22] },
	{ name: 'Beige', rgb: [0.78, 0.7, 0.54] },
	{ name: 'Taxi', rgb: [0.93, 0.7, 0.08] },    // traffic.variety: taxis (index TAXI)
];
const TAXI = 7;
const CAR_SAG = 0.16;         // same measured suspension sag as RealismNPCVehicles
const CAR_LEN = 4.5;          // metres, bumper to bumper (refined from car.glb)
const CAR_HALF_W = 0.95;
const MIN_GAP = 2.0;          // metres kept to the car / thing ahead when stopped
const BRAKE = 4.5;            // m/s² comfortable braking used for the safe speed
const ACCEL = 2.6;
const STOP_LINE = 4.8;        // metres behind the junction's crossing half width (behind the crosswalk)

// modes
const M_DRIVE = 0, M_CRASHED = 1, M_ABANDONED = 2;

interface Lane
{
	x: Float32Array; y: Float32Array; z: Float32Array; cum: Float32Array;
	len: number;
	next: number[];           // lanes this one leads into
	nextW: number[];          // pick weights
	limit: number;            // m/s
	conn: boolean;            // a junction connector
	node: number;             // junction index at the end (road lanes) / of the connector; -1 none
	group: number;            // signal group of the arm this lane comes in on
	signal: boolean;          // the end of this lane is a signal stop line
	stop: boolean;            // the end of this lane is a stop sign
	conflicts: number[];      // connectors: other connectors whose paths cross this one
	to: number;               // connectors: the lane it leads into
	from: number;             // connectors: the lane it comes from
	edge: number;             // road lanes: edge id (U-turn check)
	road: number;
	li: number;               // road lanes: 0 = inner (next to the centre line), nl - 1 = kerb lane
	nl: number;               // road lanes: lanes per direction on this edge
	dir: number;              // road lanes: 1 along the road, -1 against
	turn: number;             // connectors: -1 left, 1 right, 0 straight
	mx: number; mz: number; r: number;   // bounding circle
}

interface TCar
{
	id: number;
	lane: number; s: number; v: number; next: number;
	color: number;
	mode: number; modeT: number;
	panicT: number;
	stopDone: number;         // lane whose stop sign was served
	go: number;               // lane whose junction entry is committed
	stopT: number;
	waitT: number;
	honkT: number;
	driver: boolean;
	x: number; y: number; z: number; yaw: number; pitch: number;
	hx: number; hz: number;
	quat: THREE.Quaternion;
	pos: THREE.Vector3;
	body: CANNON.Body;
	blockedByPlayer: boolean;
	// lights
	prevV: number;
	brakeT: number;           // brake lights stay on this long (no flicker)
	sig: number;              // -1 left, 1 right, 0 off
	pullOverS: number;
	pullOverOffset: number;
}

interface Jacked { car: Car; rgb: number[]; claimed: boolean; t: number; pending?: boolean; }

function hash01(n: number): number
{
	const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
	return s - Math.floor(s);
}

export class RealismTraffic
{
	public updateOrder: number = 12;
	public settings: TrafficSettings;
	public ready = false;
	public stats: { [k: string]: number } = { lanes: 0, connectors: 0, junctionsUsed: 0, cars: 0, target: 0, drawn: 0, drawCalls: 0, colliders: 0, updateMs: 0, spawned: 0, released: 0, jacked: 0, claimed: 0, crashes: 0, honks: 0, buildMs: 0 };
	public lanes: Lane[] = [];
	public cars: TCar[] = [];
	public jacked: Jacked[] = [];

	private ctx: RealismCtx;
	private signals: any;
	private density = 1;
	private slider = 1;
	private nextId = 1;
	private roadLanes: number[] = [];
	private nearLanes: number[] = [];
	private manageAcc = 10;
	private pedAcc = 1;
	private peds: number[] = [];
	private obst: number[] = [];       // x, z, halfWidth, isPlayer
	private gltf: any = null;
	private bodyGeom: THREE.BufferGeometry = null;
	private wheelGeom: THREE.BufferGeometry = null;
	private bodyMeshes: THREE.InstancedMesh[] = [];
	private wheelMesh: THREE.InstancedMesh = null;
	private driverMesh: THREE.InstancedMesh = null;
	public lights: InstancedCarLights = null;
	public lampLayout: LampLayout = null;
	private night = false;
	private camDir = new THREE.Vector3();
	private laneCum: number[] = [];
	private boxes: { half: CANNON.Vec3; off: CANNON.Vec3 }[] = [];
	private restY = 0.62;
	private carLen = CAR_LEN;
	private collPool: CANNON.Body[] = [];
	private collMat: CANNON.Material;
	private tmpM = new THREE.Matrix4();
	private one = new THREE.Vector3(1, 1, 1);
	private yAxis = new THREE.Vector3(0, 1, 0);
	private xAxis = new THREE.Vector3(1, 0, 0);
	private tq = new THREE.Quaternion();
	private driverOff = new THREE.Vector3(0.36, 0.25, 0.1);
	private driverMat = new THREE.Matrix4();
	private playerPos = new THREE.Vector3();
	private hint: HTMLElement = null;
	private hintText = '';
	private promptOn = false;
	private lastHonk = 0;
	private clock = 0;
	private firstFill = true;
	private keyHandler: (e: any) => void = null;

	constructor(ctx: RealismCtx, signals: any)
	{
		this.ctx = ctx;
		this.signals = signals;
		this.settings = trafficSettings(ctx);
		this.density = this.settings.density;
		const t0 = Date.now();
		this.collMat = new CANNON.Material('trafficCarMat');
		this.collMat.friction = 0.3;
		if (this.settings.enabled)
		{
			try { this.buildLanes(); }
			catch (e) { console.warn('[Realism] traffic: lane build failed', e); this.lanes = []; }
		}
		this.stats.buildMs = Date.now() - t0;
		if (this.settings.enabled && this.lanes.length)
		{
			loadSharedModel('build/assets/car.glb', (gltf) =>
			{
				try { this.prepare(gltf); }
				catch (e) { console.warn('[Realism] traffic: car.glb setup failed', e); }
			});
		}
		try
		{
			if (typeof document !== 'undefined' && (document as any).addEventListener)
			{
				this.keyHandler = (e: any) =>
				{
					if (!e || e.repeat || (e.code !== 'KeyF' && e.key !== 'f' && e.key !== 'F')) return;
					const w: any = this.ctx.world;
					if (w.realismPaused === true || w.realismUIBlocking === true) return;
					// C7: act only when our prompt is the one shown (fallback: no prompt system)
					const pr = w.realismPrompt;
					if (pr && typeof pr.isActive === 'function') { let on = false; try { on = !!pr.isActive('traffic'); } catch (er) { on = false; } if (!on) return; }
					this.tryCarjack();
				};
				(document as any).addEventListener('keydown', this.keyHandler);
			}
		}
		catch (e) { /* headless */ }
	}

	// -----------------------------------------------------------------------
	// lane graph
	// -----------------------------------------------------------------------

	private buildLanes(): void
	{
		const data = this.ctx.data;
		const roads = data.roads;
		const J = data.intersections;
		const S = this.settings;
		// road end clusters (ends that meet without a junction)
		const ends: { r: number; e: number; x: number; z: number; c: number }[] = [];
		interface Item { s: number; node: number; }   // node >= 0 junction, < 0: -(cluster + 1)
		const items: Item[][] = [];
		for (let r = 0; r < roads.length; r++)
		{
			const road = roads[r];
			items.push([]);
			if (!DRIVABLE[road.kind] || road.pts.length < 2) continue;
			const P = road.pts, total = P[P.length - 1].s;
			const hw = road.width / 2;
			const list: Item[] = [];
			for (let j = 0; j < J.length; j++)
			{
				const I = J[j];
				// quick reject by bounding box
				let best = 1e18, bs = 0;
				for (let k = 0; k < P.length - 1; k++)
				{
					const ax = P[k].x, az = P[k].z, dx = P[k + 1].x - ax, dz = P[k + 1].z - az;
					const l2 = dx * dx + dz * dz;
					let t = l2 > 0 ? ((I.x - ax) * dx + (I.z - az) * dz) / l2 : 0;
					t = t < 0 ? 0 : (t > 1 ? 1 : t);
					const px = ax + dx * t - I.x, pz = az + dz * t - I.z;
					const d = px * px + pz * pz;
					if (d < best) { best = d; bs = P[k].s + (P[k + 1].s - P[k].s) * t; }
				}
				if (best < (hw + 4) * (hw + 4)) list.push({ s: bs, node: j });
			}
			list.sort((a, b) => a.s - b.s);
			const ded: Item[] = [];
			for (let k = 0; k < list.length; k++) if (!ded.length || list[k].s - ded[ded.length - 1].s > 6) ded.push(list[k]);
			if (!ded.length || ded[0].s > 12) { ends.push({ r: r, e: 0, x: P[0].x, z: P[0].z, c: -1 }); ded.unshift({ s: 0, node: -(ends.length) }); }
			if (ded[ded.length - 1].s < total - 12) { ends.push({ r: r, e: 1, x: P[P.length - 1].x, z: P[P.length - 1].z, c: -1 }); ded.push({ s: total, node: -(ends.length) }); }
			items[r] = ded;
		}
		// cluster ends that touch
		let nClusters = 0;
		for (let a = 0; a < ends.length; a++)
		{
			if (ends[a].c >= 0) continue;
			ends[a].c = nClusters;
			for (let b = a + 1; b < ends.length; b++)
				if (ends[b].c < 0 && (ends[a].x - ends[b].x) * (ends[a].x - ends[b].x) + (ends[a].z - ends[b].z) * (ends[a].z - ends[b].z) < 16) ends[b].c = nClusters;
			nClusters++;
		}
		const nodeKey = (node: number) => (node >= 0 ? node : J.length + ends[-node - 1].c);
		const nNodes = J.length + nClusters;
		const incoming: number[][] = [], outgoing: number[][] = [];
		for (let n = 0; n < nNodes; n++) { incoming.push([]); outgoing.push([]); }

		let edgeId = 0;
		for (let r = 0; r < roads.length; r++)
		{
			const list = items[r];
			if (!list || list.length < 2) continue;
			const road = roads[r];
			const hw = road.width / 2;
			// lanes per direction: avenues/highways paint a dashed divider at 0.27/0.73 of the width
			// (RealismMaterials.roadTexture), i.e. 2 lanes each way; lane centres at 0.115 / 0.345 of the width
			const multi = S.multiLane && (road.kind === 'avenue' || road.kind === 'highway') && road.width >= 11;
			const offs = multi ? [road.width * 0.115, road.width * 0.345] : [Math.max(1.6, Math.min(hw * 0.45, hw - 3.4))];
			const limit = (S.speeds[road.kind] || 11) * S.speedScale;
			for (let k = 0; k < list.length - 1; k++)
			{
				const A = list[k], B = list[k + 1];
				const trimA = A.node >= 0 ? J[A.node].crossHW + STOP_LINE : 0;
				const trimB = B.node >= 0 ? J[B.node].crossHW + STOP_LINE : 0;
				const s0 = A.s + trimA, s1 = B.s - trimB;
				if (s1 - s0 < 4) continue;
				const e = edgeId++;
				const kA = nodeKey(A.node), kB = nodeKey(B.node);
				for (let li = 0; li < offs.length; li++)
				{
					const off = offs[li];
					const fwd = this.sampleRoad(road, s0, s1, off, false);
					const back = this.sampleRoad(road, s0, s1, -off, true);
					const lf = this.addLane(fwd, limit, false, e, r);
					const lb = this.addLane(back, limit, false, e, r);
					outgoing[kA].push(lf); incoming[kB].push(lf);
					outgoing[kB].push(lb); incoming[kA].push(lb);
					this.lanes[lf].node = B.node >= 0 ? B.node : -1;
					this.lanes[lb].node = A.node >= 0 ? A.node : -1;
					this.lanes[lf].li = li; this.lanes[lb].li = li;
					this.lanes[lf].nl = offs.length; this.lanes[lb].nl = offs.length;
					this.lanes[lf].dir = 1; this.lanes[lb].dir = -1;
					this.roadLanes.push(lf, lb);
				}
				if (offs.length > 1) this.stats.multiLaneEdges = (this.stats.multiLaneEdges || 0) + 1;
			}
		}
		// signal / stop info on lane ends
		for (let i = 0; i < this.lanes.length; i++)
		{
			const L = this.lanes[i];
			if (L.node < 0) continue;
			const I = J[L.node];
			const n = L.x.length - 1;
			let dx = L.x[n] - L.x[n - 1], dz = L.z[n] - L.z[n - 1];
			const dl = Math.sqrt(dx * dx + dz * dz) || 1; dx /= dl; dz /= dl;
			let best = -2, arm: any = null;
			for (let a = 0; a < I.arms.length; a++)
			{
				const d = -(I.arms[a].dx * dx + I.arms[a].dz * dz);
				if (d > best) { best = d; arm = I.arms[a]; }
			}
			L.group = arm ? (arm.group || 0) : 0;
			L.signal = I.control === 'signal';
			L.stop = I.control === 'stop' && !!(arm && arm.stop);
		}
		// connectors
		let used = 0;
		for (let n = 0; n < nNodes; n++)
		{
			const ins = incoming[n], outs = outgoing[n];
			if (!ins.length || !outs.length) continue;
			const made: number[] = [];
			const node = n < J.length ? n : -1;
			for (let a = 0; a < ins.length; a++)
			{
				const la = this.lanes[ins[a]];
				let options = outs.filter((o) => this.lanes[o].edge !== la.edge);
				if (!options.length) options = outs.filter((o) => this.lanes[o].li === 0);     // dead end: U-turn (inner lanes)
				if (!options.length) options = outs.slice(0);
				let any = 0;
				for (let b = 0; b < options.length; b++)
				{
					const lb = this.lanes[options[b]];
					if (!this.laneFits(la, lb)) continue;
					const c = this.makeConnector(ins[a], options[b], node);
					if (c >= 0) { made.push(c); any++; }
				}
				// no lane rule fits (odd junction): never strand a lane
				if (!any) for (let b = 0; b < options.length; b++)
				{
					const c = this.makeConnector(ins[a], options[b], node);
					if (c >= 0) made.push(c);
				}
			}
			if (node >= 0 && made.length) used++;
			// crossing paths
			for (let a = 0; a < made.length; a++)
			{
				const A = this.lanes[made[a]];
				for (let b = a + 1; b < made.length; b++)
				{
					const B = this.lanes[made[b]];
					if (pathsTouch(A, B, 2.6)) { A.conflicts.push(made[b]); B.conflicts.push(made[a]); }
				}
			}
		}
		this.stats.lanes = this.roadLanes.length;
		this.stats.connectors = this.lanes.length - this.roadLanes.length;
		this.stats.junctionsUsed = used;
	}

	/** Lane points along a road between stations s0..s1, `lat` metres to the right of the road direction. */
	private sampleRoad(road: Road, s0: number, s1: number, lat: number, reverse: boolean): number[][]
	{
		const P = road.pts, data = this.ctx.data;
		const lift = road.kind === 'avenue' || road.kind === 'highway' ? 0.1 : 0.08;
		const stations: number[] = [s0];
		for (let k = 0; k < P.length; k++) if (P[k].s > s0 + 0.5 && P[k].s < s1 - 0.5) stations.push(P[k].s);
		stations.push(s1);
		// densify (max 8 m)
		const st: number[] = [];
		for (let k = 0; k < stations.length; k++)
		{
			if (k > 0)
			{
				const gap = stations[k] - stations[k - 1];
				const n = Math.floor(gap / 8);
				for (let m = 1; m <= n; m++) st.push(stations[k - 1] + gap * m / (n + 1));
			}
			st.push(stations[k]);
		}
		const out: number[][] = [];
		let seg = 0;
		for (let k = 0; k < st.length; k++)
		{
			const s = st[k];
			while (seg < P.length - 2 && P[seg + 1].s < s) seg++;
			const a = P[seg], b = P[seg + 1];
			const t = Math.max(0, Math.min(1, (s - a.s) / Math.max(1e-6, b.s - a.s)));
			let tx = b.x - a.x, tz = b.z - a.z;
			// smooth the tangent at polyline corners
			if (t < 0.15 && seg > 0) { tx += a.x - P[seg - 1].x; tz += a.z - P[seg - 1].z; }
			else if (t > 0.85 && seg < P.length - 2) { tx += P[seg + 2].x - b.x; tz += P[seg + 2].z - b.z; }
			const tl = Math.sqrt(tx * tx + tz * tz) || 1; tx /= tl; tz /= tl;
			const rx = -tz, rz = tx;                     // driver's right
			const cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t, cy = a.y + (b.y - a.y) * t;
			const x = cx + rx * lat, z = cz + rz * lat;
			const y = Math.max(cy, data.heightAt(x, z)) + lift;
			out.push([x, y, z]);
		}
		if (reverse) out.reverse();
		return out;
	}

	private addLane(pts: number[][], limit: number, conn: boolean, edge: number, road: number): number
	{
		const n = pts.length;
		const L: Lane = {
			x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), cum: new Float32Array(n), len: 0,
			next: [], nextW: [], limit: limit, conn: conn, node: -1, group: 0, signal: false, stop: false, conflicts: [], to: -1, from: -1,
			edge: edge, road: road, mx: 0, mz: 0, r: 0, li: 0, nl: 1, dir: 1, turn: 0,
		};
		let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
		for (let i = 0; i < n; i++)
		{
			L.x[i] = pts[i][0]; L.y[i] = pts[i][1]; L.z[i] = pts[i][2];
			if (i > 0) L.cum[i] = L.cum[i - 1] + Math.sqrt((pts[i][0] - pts[i - 1][0]) * (pts[i][0] - pts[i - 1][0]) + (pts[i][2] - pts[i - 1][2]) * (pts[i][2] - pts[i - 1][2]));
			minX = Math.min(minX, pts[i][0]); maxX = Math.max(maxX, pts[i][0]); minZ = Math.min(minZ, pts[i][2]); maxZ = Math.max(maxZ, pts[i][2]);
		}
		L.len = L.cum[n - 1];
		L.mx = (minX + maxX) / 2; L.mz = (minZ + maxZ) / 2;
		L.r = Math.sqrt((maxX - minX) * (maxX - minX) + (maxZ - minZ) * (maxZ - minZ)) / 2;
		this.lanes.push(L);
		return this.lanes.length - 1;
	}

	/**
	 * Which lane may feed which across a junction when roads have 2 lanes each way: straight on
	 * keeps its lane (2 -> 1 merges, 1 -> 2 goes to the kerb lane), left turns go inner -> inner,
	 * right turns kerb -> kerb, U-turns inner -> inner. Single-lane roads accept everything.
	 */
	private laneFits(A: Lane, B: Lane): boolean
	{
		if (A.nl <= 1 && B.nl <= 1) return true;
		const na = A.x.length - 1;
		let dax = A.x[na] - A.x[na - 1], daz = A.z[na] - A.z[na - 1];
		let dl = Math.sqrt(dax * dax + daz * daz) || 1; dax /= dl; daz /= dl;
		let dbx = B.x[1] - B.x[0], dbz = B.z[1] - B.z[0];
		dl = Math.sqrt(dbx * dbx + dbz * dbz) || 1; dbx /= dl; dbz /= dl;
		const dot = dax * dbx + daz * dbz;
		const inA = A.li, inB = B.li, outerA = A.nl - 1, outerB = B.nl - 1;
		if (dot < -0.7) return inB === 0;
		if (dot > 0.8)
		{
			if (A.nl === B.nl) return inA === inB;
			if (B.nl === 1) return true;
			return inB === outerB;           // 1 -> 2: kerb lane
		}
		const left = (dax * dbz - daz * dbx) < 0;
		if (left) return inA === 0 && inB === 0;
		return inA === outerA && inB === outerB;
	}

	private makeConnector(from: number, to: number, node: number): number
	{
		const A = this.lanes[from], B = this.lanes[to];
		const na = A.x.length - 1;
		const p0x = A.x[na], p0y = A.y[na], p0z = A.z[na];
		const p3x = B.x[0], p3y = B.y[0], p3z = B.z[0];
		let dax = A.x[na] - A.x[na - 1], daz = A.z[na] - A.z[na - 1];
		let dl = Math.sqrt(dax * dax + daz * daz) || 1; dax /= dl; daz /= dl;
		let dbx = B.x[1] - B.x[0], dbz = B.z[1] - B.z[0];
		dl = Math.sqrt(dbx * dbx + dbz * dbz) || 1; dbx /= dl; dbz /= dl;
		const dist = Math.sqrt((p3x - p0x) * (p3x - p0x) + (p3z - p0z) * (p3z - p0z));
		const dot = dax * dbx + daz * dbz;
		const uturn = dot < -0.7;
		const k = uturn ? Math.max(4, dist * 1.2) : Math.max(1, dist * 0.42);
		const c1x = p0x + dax * k, c1z = p0z + daz * k, c2x = p3x - dbx * k, c2z = p3z - dbz * k;
		const N = uturn ? 12 : 10;
		const pts: number[][] = [];
		const data = this.ctx.data;
		for (let i = 0; i <= N; i++)
		{
			const t = i / N, u = 1 - t;
			const x = u * u * u * p0x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p3x;
			const z = u * u * u * p0z + 3 * u * u * t * c1z + 3 * u * t * t * c2z + t * t * t * p3z;
			const yl = p0y + (p3y - p0y) * t;
			const y = i === 0 ? p0y : (i === N ? p3y : Math.max(yl, data.heightAt(x, z) + 0.08));
			pts.push([x, y, z]);
		}
		let limit: number;
		if (uturn) limit = 4;
		else if (dot > 0.8) limit = Math.min(A.limit, B.limit);
		else limit = (dax * dbz - daz * dbx) < 0 ? 7 : 5.5;     // negative cross = left turn (wider), else right
		limit = Math.min(limit, Math.min(A.limit, B.limit));
		const c = this.addLane(pts, limit, true, -1, A.road);
		const C = this.lanes[c];
		// turn for the indicators: -1 left, 1 right, 0 straight (a U-turn signals left)
		C.turn = uturn ? -1 : (dot > 0.8 ? 0 : ((dax * dbz - daz * dbx) < 0 ? -1 : 1));
		C.node = node; C.to = to; C.from = from; C.next.push(to); C.nextW.push(1);
		A.next.push(c);
		A.nextW.push(uturn ? 0.05 : (dot > 0.8 ? 1 : 0.5));
		return c;
	}

	// -----------------------------------------------------------------------
	// model
	// -----------------------------------------------------------------------

	private prepare(gltf: any): void
	{
		this.gltf = gltf;
		const scene: THREE.Object3D = gltf.scene;
		scene.updateMatrixWorld(true);
		const body: THREE.BufferGeometry[] = [], wheels: THREE.BufferGeometry[] = [];
		let bodyMat: any = null, wheelMat: any = null;
		let seat: THREE.Vector3 = null;
		scene.traverse((o: any) =>
		{
			const ud = o.userData || {};
			if (ud.data === 'collision' && ud.shape === 'box')
				this.boxes.push({ half: new CANNON.Vec3(o.scale.x, o.scale.y, o.scale.z), off: new CANNON.Vec3(o.position.x, o.position.y, o.position.z) });
			if (ud.data === 'seat' && ud.seat_type === 'driver' && !seat) seat = o.getWorldPosition(new THREE.Vector3());
			if (!o.isMesh || ud.data === 'collision' || ud.data === 'navmesh') return;
			const m = o.material;
			const g = (o.geometry as THREE.BufferGeometry).clone();
			g.applyMatrix4(o.matrixWorld);
			const isWheel = (m && m.name === 'Wheel') || ud.data === 'wheel';
			if (isWheel) { wheels.push(g); if (!wheelMat) wheelMat = m; }
			else { body.push(g); if (!bodyMat) bodyMat = m; }
		});
		this.bodyGeom = mergeSimple(body);
		this.wheelGeom = mergeSimple(wheels);
		this.wheelGeom.computeBoundingBox();
		this.bodyGeom.computeBoundingBox();
		const measured = (window as any).REALISM_CAR_REST_Y;
		const rest = typeof measured === 'number' ? measured : -this.wheelGeom.boundingBox.min.y - CAR_SAG;
		if (isFinite(rest) && rest > 0.1 && rest < 2) this.restY = rest;
		const bb = this.bodyGeom.boundingBox;
		const len = bb.max.z - bb.min.z;
		if (isFinite(len) && len > 2.5 && len < 8) this.carLen = len + 0.1;
		// driver silhouette: torso + head under the roof, on the driver seat
		const roof = bb.max.y;
		const sx = seat ? seat.x : 0.36, sy = seat ? seat.y : 0.1, sz = seat ? seat.z : 0.1;
		const ps = Math.min(1.15, playerScaleOf(this.ctx));
		const torso = new THREE.BoxBufferGeometry(0.34 * ps, 0.42 * ps, 0.22 * ps);
		const torsoY = Math.min(sy + 0.32 * ps, roof - 0.5 * ps);
		torso.translate(0, torsoY, 0);
		const head = new THREE.SphereBufferGeometry(0.11 * ps, 8, 6);
		head.translate(0, Math.min(torsoY + 0.34 * ps, roof - 0.14), 0.02);
		const dg = mergeSimple([torso, head]);
		this.driverOff.set(sx, 0, sz);
		const ctx = this.ctx;
		const mk = (base: any, rgb: number[]) =>
		{
			let m: any = base ? cheapMaterial(ctx, base) : new THREE.MeshLambertMaterial();
			m = m.clone();
			if (rgb && m.color) m.color.setRGB(rgb[0], rgb[1], rgb[2]);
			m.userData = Object.assign({}, m.userData || {}, { instancedCopy: true });
			try { (ctx.world as any).sky.csm.setupMaterial(m); } catch (e) { /* no csm */ }
			return m as THREE.Material;
		};
		const cap = Math.max(4, this.settings.maxCars * 2 + 4);
		for (let c = 0; c < PALETTE.length; c++)
		{
			const mesh = new THREE.InstancedMesh(ownGeometry(this.bodyGeom), mk(bodyMat, PALETTE[c].rgb), cap);
			mesh.count = 0; mesh.visible = false;
			mesh.frustumCulled = false;
			mesh.castShadow = !!ctx.preset.shadows; mesh.receiveShadow = true;
			mesh.name = 'trafficCars_' + PALETTE[c].name;
			ctx.world.graphicsWorld.add(mesh);
			this.bodyMeshes.push(mesh);
		}
		this.wheelMesh = new THREE.InstancedMesh(ownGeometry(this.wheelGeom), mk(wheelMat, null), cap * 2);
		this.wheelMesh.count = 0; this.wheelMesh.visible = false;
		this.wheelMesh.frustumCulled = false;
		this.wheelMesh.name = 'trafficWheels';
		ctx.world.graphicsWorld.add(this.wheelMesh);
		const dm = new THREE.MeshLambertMaterial({ color: 0x23201e });
		dm.userData = { instancedCopy: true };
		this.driverMesh = new THREE.InstancedMesh(ownGeometry(dg), dm, cap * 2);
		this.driverMesh.count = 0; this.driverMesh.visible = false;
		this.driverMesh.frustumCulled = false;
		this.driverMesh.name = 'trafficDrivers';
		ctx.world.graphicsWorld.add(this.driverMesh);
		// head / tail / brake / reverse / indicator lenses + glow (RealismCarLights.ts)
		try
		{
			const ls = carLightSettings(ctx);
			this.lampLayout = measureLamps(this.bodyGeom, this.wheelGeom);
			if (ls.enabled) this.lights = new InstancedCarLights(ctx.world.graphicsWorld, this.lampLayout, cap, 'traffic', ls.glow);
		}
		catch (e) { console.warn('[Realism] traffic: car lights failed', e); }
		this.ready = true;
		this.manageAcc = 10;
	}

	// -----------------------------------------------------------------------
	// per frame
	// -----------------------------------------------------------------------

	public update(timeStep: number, unscaledTimeStep?: number): void
	{
		const w: any = this.ctx.world;
		if (!this.ready || w.realismPaused === true) return;
		const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
		const dt = Math.min(0.1, Math.max(0, timeStep || 0));
		this.clock += dt;
		const player = this.findPlayer();
		this.watchJacked(player);
		this.manageAcc += dt;
		if (this.manageAcc >= 0.5) { this.manageAcc = 0; this.manage(); }
		this.pedAcc += dt;
		const npcs: any = w.realismNPCs;
		if (this.pedAcc >= 0.2)
		{
			this.pedAcc = 0;
			if (npcs && typeof npcs.peopleNear === 'function') npcs.peopleNear(this.playerPos.x, this.playerPos.z, this.settings.radius, this.peds);
			else this.peds.length = 0;
		}
		this.gatherObstacles(player);
		if (dt > 0)
		{
			for (let i = 0; i < this.cars.length; i++) this.drive(this.cars[i], dt);
			for (let i = 0; i < this.cars.length; i++) this.pose(this.cars[i], dt);
			for (let i = 0; i < this.cars.length; i++) this.lightState(this.cars[i], dt);
		}
		this.night = isNightNow(w);
		this.draw();
		this.colliders(dt);
		this.updateHint(player);
		const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
		this.stats.updateMs = this.stats.updateMs * 0.9 + (t1 - t0) * 0.1;
	}

	private findPlayer(): any
	{
		const w: any = this.ctx.world;
		const npcs: any = w.realismNPCs;
		let ch: any = null;
		if (npcs && npcs.player !== undefined) ch = npcs.player;
		else
		{
			const r: any = w.inputManager ? w.inputManager.inputReceiver : null;
			if (r && r.characterCapsule !== undefined) ch = r;
			else if (r && r.controllingCharacter) ch = r.controllingCharacter;
		}
		if (ch)
		{
			if (ch.occupyingSeat && ch.occupyingSeat.vehicle) this.playerPos.copy(ch.occupyingSeat.vehicle.position);
			else this.playerPos.copy(ch.position);
		}
		else if (w.camera) this.playerPos.copy(w.camera.position);
		return ch;
	}

	/** Things cars must not drive into: the player (on foot or in a car) and every real vehicle. */
	private gatherObstacles(player: any): void
	{
		const o = this.obst;
		o.length = 0;
		const w: any = this.ctx.world;
		const R = this.settings.radius + 20, R2 = R * R;
		const vs: any[] = w.vehicles || [];
		for (let i = 0; i < vs.length; i++)
		{
			const p = vs[i].position;
			if (!p) continue;
			const dx = p.x - this.playerPos.x, dz = p.z - this.playerPos.z;
			if (dx * dx + dz * dz > R2) continue;
			const mine = player && player.occupyingSeat && player.occupyingSeat.vehicle === vs[i];
			o.push(p.x, p.z, 1.2, mine ? 1 : 0);
		}
		if (player && !player.occupyingSeat) o.push(player.position.x, player.position.z, 0.5 * Math.max(1, playerScaleOf(this.ctx)), 1);
	}

	private lightAt(L: Lane): number
	{
		// 2 green, 1 yellow, 0 red (TrafficSignals.state / RealismNPCs.canCross maths)
		if (!L.signal || L.node < 0 || !this.signals || this.signals.enabled === false) return 2;
		const I = this.ctx.data.intersections[L.node];
		const cycle = Math.max(6, this.ctx.cfg.city.trafficCycle || 24);
		let t = ((this.signals.time || 0) / cycle + I.phase) % 1;
		if (L.group === 1) t = (t + 0.5) % 1;
		if (t < 0.42) return 2;
		if (t < 0.5) return 1;
		return 0;
	}

	/** May the car leave its lane into the junction connector `c` now? */
	private mayEnter(car: TCar, L: Lane, remaining: number): boolean
	{
		if (car.go === car.lane) return true;
		const c = car.next;
		if (c < 0) return false;
		if (car.panicT <= 0)
		{
			if (L.signal)
			{
				const light = this.lightAt(L);
				if (light === 0) return false;
				if (light === 1 && remaining > (car.v * car.v) / (2 * BRAKE) + 0.5) return false;
			}
			else if (L.stop && car.stopDone !== car.lane) return false;
		}
		// the paths through the junction that cross this one must be free
		const C = this.lanes[c];
		const len = this.carLen;
		for (let i = 0; i < this.cars.length; i++)
		{
			const o = this.cars[i];
			if (o === car) continue;
			if (o.lane === c) { if (o.s < len + MIN_GAP) return false; continue; }
			if (C.conflicts.indexOf(o.lane) >= 0) return false;
			// a car that already committed to a crossing (or the same) path but is not on it yet
			if (o.go === o.lane && o.next >= 0 && !this.lanes[o.lane].conn && (o.next === c || C.conflicts.indexOf(o.next) >= 0)) return false;
			if (o.lane === C.to && o.s < len + MIN_GAP + 1) return false;        // no room behind
		}
		return true;
	}

	private drive(car: TCar, dt: number): void
	{
		const len = this.carLen;
		car.blockedByPlayer = false;
		if (car.panicT > 0) car.panicT -= dt;
		if (car.mode === M_CRASHED || car.mode === M_ABANDONED)
		{
			car.v = Math.max(0, car.v - 9 * dt);
			car.modeT -= dt;
			if (car.modeT <= 0)
			{
				if (car.mode === M_CRASHED) car.mode = M_DRIVE;
				else if (this.dist(car) > 45) { car.mode = M_DRIVE; car.driver = true; }      // the driver came back
				else car.modeT = 5;
			}
			if (car.mode !== M_DRIVE) { this.advance(car, dt); return; }
		}
		const L = this.lanes[car.lane];
		const front = car.s + len / 2;
		const remaining = L.len - front;
		let gap = 1e9;
		if (car.pullOverS >= 0 && car.pullOverOffset >= 1.15)
			gap = Math.min(gap, car.pullOverS - front);
		// cars ahead on this lane, the next lane and the one after
		const n1 = car.next, n2 = n1 >= 0 && this.lanes[n1].next.length === 1 ? this.lanes[n1].next[0] : -1;
		const len1 = n1 >= 0 ? this.lanes[n1].len : 0;
		for (let i = 0; i < this.cars.length; i++)
		{
			const o = this.cars[i];
			if (o === car) continue;
			let g = 1e9;
			if (o.lane === car.lane) { if (o.s > car.s) g = o.s - car.s - len; }
			else if (o.lane === n1) g = remaining + o.s - len / 2;
			else if (o.lane === n2) g = remaining + len1 + o.s - len / 2;
			else if (this.lanes[o.lane].from === car.lane) g = remaining + o.s - len / 2;    // just turned off this lane
			if (g < gap) gap = g;
		}
		// junction control at the end of a road lane
		if (!L.conn && remaining < 45)
		{
			if (L.stop && car.stopDone !== car.lane && remaining < 1.6 && car.v < 0.4)
			{
				car.stopT += dt;
				if (car.stopT > 1.0) car.stopDone = car.lane;
			}
			const may = n1 >= 0 && this.mayEnter(car, L, remaining);
			if (!may) gap = Math.min(gap, remaining - 0.3);
			else if (remaining < Math.max(3, car.v * 0.6)) car.go = car.lane;
		}
		else if (n1 < 0) gap = Math.min(gap, remaining - 0.3);
		if (car.pullOverS >= 0)
		{
			const sideX = car.x + car.hz * 1.15;
			const sideZ = car.z - car.hx * 1.15;
			let clear = true;
			for (let i = 0; i < this.cars.length; i++)
			{
				const other = this.cars[i];
				if (other === car) continue;
				const dx = other.x - sideX, dz = other.z - sideZ;
				if (dx * dx + dz * dz < 9) { clear = false; break; }
			}
			if (clear) car.pullOverOffset = Math.min(1.15, car.pullOverOffset + dt * 0.8);
			car.sig = 1;
		}
		// people, the player and real cars in front
		const look = 7 + car.v * 1.6;
		const rx = -car.hz, rz = car.hx;
		const scan = (x: number, z: number, hw: number) =>
		{
			const dx = x - car.x, dz = z - car.z;
			const fwd = dx * car.hx + dz * car.hz;
			if (fwd <= 0 || fwd > look + len / 2) return 1e9;
			const lat = dx * rx + dz * rz;
			if (Math.abs(lat) > CAR_HALF_W + hw + 0.25) return 1e9;
			return fwd - len / 2 - hw;
		};
		const P = this.peds;
		for (let i = 0; i < P.length; i += 2)
		{
			const g = scan(P[i], P[i + 1], 0.35);
			if (g < gap) gap = g;
		}
		const O = this.obst;
		for (let i = 0; i < O.length; i += 4)
		{
			const g = scan(O[i], O[i + 1], O[i + 2]);
			if (g < gap) { gap = g; car.blockedByPlayer = O[i + 3] === 1; }
		}
		// speed
		const limit = L.limit * (car.panicT > 0 ? 1.5 : 1);
		const vSafe = gap >= 1e8 ? 1e9 : Math.sqrt(Math.max(0, 2 * BRAKE * (gap - MIN_GAP)));
		const target = Math.min(limit, vSafe);
		const pullOverTarget = car.pullOverS >= 0 && car.pullOverOffset < 1.15 ? Math.min(target, 5.5) : target;
		if (pullOverTarget > car.v) car.v = Math.min(pullOverTarget, car.v + ACCEL * (car.panicT > 0 ? 1.6 : 1) * dt);
		else car.v = Math.max(pullOverTarget, car.v - 9 * dt);
		if (vSafe < car.v) car.v = vSafe;
		// never close a gap below the minimum within this step
		if (gap < 1e8 && car.v * dt > gap - MIN_GAP * 0.5) car.v = Math.max(0, (gap - MIN_GAP * 0.5) / Math.max(dt, 1e-4));
		car.waitT = car.v < 0.1 ? car.waitT + dt : 0;
		// honk at a player standing in the way
		if (car.blockedByPlayer && car.v < 0.5)
		{
			car.honkT += dt;
			if (car.honkT > 2.5) { car.honkT = -4; this.honk(car); }
		}
		else if (car.honkT > 0) car.honkT = 0;
		this.advance(car, dt);
	}

	private advance(car: TCar, dt: number): void
	{
		car.s += car.v * dt;
		let guard = 0;
		while (car.s > this.lanes[car.lane].len && guard++ < 4)
		{
			const L = this.lanes[car.lane];
			if (car.next < 0) { car.s = L.len; car.v = 0; break; }
			car.s -= L.len;
			car.lane = car.next;
			car.next = this.pickNext(car.lane);
			car.stopT = 0;
		}
	}

	private pickNext(lane: number): number
	{
		const L = this.lanes[lane];
		if (!L.next.length) return -1;
		if (L.next.length === 1) return L.next[0];
		let sum = 0;
		for (let i = 0; i < L.nextW.length; i++) sum += L.nextW[i];
		let r = Math.random() * sum;
		for (let i = 0; i < L.next.length; i++) { r -= L.nextW[i]; if (r <= 0) return L.next[i]; }
		return L.next[L.next.length - 1];
	}

	/** Position on a lane: writes into out [x, y, z]. */
	private at(lane: number, s: number, out: number[]): void
	{
		let L = this.lanes[lane];
		// look past the lane ends so headings stay smooth across junctions
		if (s < 0) { s = 0; }
		if (s > L.len) s = L.len;
		const C = L.cum;
		let lo = 0, hi = C.length - 1;
		while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] <= s) lo = m; else hi = m; }
		const t = (s - C[lo]) / Math.max(1e-6, C[hi] - C[lo]);
		out[0] = L.x[lo] + (L.x[hi] - L.x[lo]) * t;
		out[1] = L.y[lo] + (L.y[hi] - L.y[lo]) * t;
		out[2] = L.z[lo] + (L.z[hi] - L.z[lo]) * t;
	}

	private pa = [0, 0, 0]; private pb = [0, 0, 0]; private pc = [0, 0, 0];
	private pose(car: TCar, dt: number): void
	{
		const half = 1.4;
		const L = this.lanes[car.lane];
		this.at(car.lane, car.s, this.pc);
		// front sample (into the next lane when near the end)
		if (car.s + half > L.len && car.next >= 0) this.at(car.next, car.s + half - L.len, this.pa);
		else this.at(car.lane, car.s + half, this.pa);
		if (car.s - half < 0) { this.pb[0] = this.pc[0] - (this.pa[0] - this.pc[0]); this.pb[1] = this.pc[1]; this.pb[2] = this.pc[2] - (this.pa[2] - this.pc[2]); }
		else this.at(car.lane, car.s - half, this.pb);
		let hx = this.pa[0] - this.pb[0], hz = this.pa[2] - this.pb[2];
		const hl = Math.sqrt(hx * hx + hz * hz);
		if (hl > 0.05) { hx /= hl; hz /= hl; } else { hx = car.hx; hz = car.hz; }
		const yaw = Math.atan2(hx, hz);
		let d = yaw - car.yaw;
		while (d > Math.PI) d -= Math.PI * 2;
		while (d < -Math.PI) d += Math.PI * 2;
		car.yaw += dt > 0 && Math.abs(d) < 1.2 ? d * Math.min(1, dt * 12) : d;
		car.hx = Math.sin(car.yaw); car.hz = Math.cos(car.yaw);
		car.pitch = hl > 0.05 ? -Math.atan2(this.pa[1] - this.pb[1], hl) : 0;
		car.x = this.pc[0]; car.z = this.pc[2]; car.y = this.pc[1] + this.restY;
		if (car.pullOverOffset > 0)
		{
			car.x += car.hz * car.pullOverOffset;
			car.z -= car.hx * car.pullOverOffset;
		}
		car.pos.set(car.x, car.y, car.z);
		car.quat.setFromAxisAngle(this.yAxis, car.yaw);
		this.tq.setFromAxisAngle(this.xAxis, car.pitch);
		car.quat.multiply(this.tq);
	}

	private dist(car: TCar): number
	{
		const dx = car.x - this.playerPos.x, dz = car.z - this.playerPos.z;
		return Math.sqrt(dx * dx + dz * dz);
	}

	// -----------------------------------------------------------------------
	// population
	// -----------------------------------------------------------------------

	public get target(): number
	{
		if (!this.settings.enabled) return 0;
		return Math.max(0, Math.round(this.settings.maxCars * this.density));
	}

	private manage(): void
	{
		const R = this.settings.radius;
		const target = this.target;
		this.stats.target = target;
		// release far / stuck cars
		for (let i = this.cars.length - 1; i >= 0; i--)
		{
			const car = this.cars[i];
			const d = this.dist(car);
			if (d > R + 30 || (car.waitT > 40 && d > 60) || (car.mode === M_ABANDONED && d > R)) this.release(i);
		}
		// too many (density lowered): the farthest go first
		while (this.cars.length > target)
		{
			let far = 0, fd = -1;
			for (let i = 0; i < this.cars.length; i++) { const d = this.dist(this.cars[i]); if (d > fd) { fd = d; far = i; } }
			this.release(far);
		}
		if (this.cars.length >= target) return;
		// lanes near the player
		const near = this.nearLanes;
		near.length = 0;
		const px = this.playerPos.x, pz = this.playerPos.z;
		for (let k = 0; k < this.roadLanes.length; k++)
		{
			const L = this.lanes[this.roadLanes[k]];
			const dx = L.mx - px, dz = L.mz - pz, r = R + L.r;
			if (dx * dx + dz * dz < r * r) near.push(this.roadLanes[k]);
		}
		if (!near.length) return;
		const minD = this.firstFill ? 22 : this.settings.spawnMin;
		let tries = 0, added = 0;
		const p = [0, 0, 0];
		// pick lanes by length (cars spread evenly over the road network, not bunched on short lanes)
		const cum = this.laneCum;
		cum.length = 0;
		let total = 0;
		for (let k = 0; k < near.length; k++) { total += this.lanes[near[k]].len; cum.push(total); }
		// the camera's view direction: new cars appear behind or far away, not popping in on screen
		const w: any = this.ctx.world;
		let viewX = 0, viewZ = 0;
		if (this.settings.avoidView && !this.firstFill && w.camera && w.camera.getWorldDirection)
		{
			w.camera.getWorldDirection(this.camDir);
			const l = Math.sqrt(this.camDir.x * this.camDir.x + this.camDir.z * this.camDir.z);
			if (l > 1e-3) { viewX = this.camDir.x / l; viewZ = this.camDir.z / l; }
		}
		while (this.cars.length < target && tries++ < 60 && added < (this.firstFill ? 60 : 3))
		{
			const pick = Math.random() * total;
			let lo = 0, hi = cum.length - 1;
			while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < pick) lo = mid + 1; else hi = mid; }
			const lane = near[lo];
			const L = this.lanes[lane];
			if (L.len < this.carLen + 4) continue;
			const s = this.carLen / 2 + Math.random() * (L.len - this.carLen - 1);
			this.at(lane, s, p);
			const dx = p[0] - px, dz = p[2] - pz, d = Math.sqrt(dx * dx + dz * dz);
			if (d < minD || d > R) continue;
			// in view (within ~60 degrees of the view direction) and not near the edge of the radius: try elsewhere
			if ((viewX !== 0 || viewZ !== 0) && d < R * 0.85 && (dx * viewX + dz * viewZ) > d * 0.5 && tries < 50) continue;
			let free = true;
			for (let i = 0; i < this.cars.length && free; i++)
			{
				const o = this.cars[i];
				if ((o.x - p[0]) * (o.x - p[0]) + (o.z - p[2]) * (o.z - p[2]) < 14 * 14) free = false;
			}
			for (let i = 0; i < this.obst.length && free; i += 4)
				if ((this.obst[i] - p[0]) * (this.obst[i] - p[0]) + (this.obst[i + 1] - p[2]) * (this.obst[i + 1] - p[2]) < 10 * 10) free = false;
			if (!free) continue;
			this.spawn(lane, s);
			added++;
		}
		if (this.cars.length >= target || tries >= 60) this.firstFill = false;
	}

	private spawn(lane: number, s: number): TCar
	{
		const L = this.lanes[lane];
		const car: TCar = {
			id: this.nextId++, lane: lane, s: s, v: L.limit * 0.6, next: -1,
			color: Math.random() < this.settings.variety ? TAXI : Math.floor(Math.random() * TAXI) % TAXI,
			mode: M_DRIVE, modeT: 0, panicT: 0, stopDone: -1, go: -1, stopT: 0, waitT: 0, honkT: 0, driver: true,
			x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hx: 0, hz: 1, quat: new THREE.Quaternion(), pos: new THREE.Vector3(), body: null, blockedByPlayer: false,
			prevV: L.limit * 0.6, brakeT: 0, sig: 0, pullOverS: -1, pullOverOffset: 0,
		};
		car.next = this.pickNext(lane);
		this.pose(car, 0);
		this.cars.push(car);
		this.stats.spawned++;
		this.stats.cars = this.cars.length;
		return car;
	}

	private release(i: number): void
	{
		const car = this.cars[i];
		if (car.body) this.freeBody(car);
		this.cars.splice(i, 1);
		this.stats.released++;
		this.stats.cars = this.cars.length;
	}

	/** The settings slider (0..2, via RealismNPCs.setDensity). traffic.density in the config multiplies it. */
	public setDensity(n: number): void
	{
		this.slider = Math.max(0, Math.min(2, isFinite(n) ? n : 1));
		this.density = Math.max(0, Math.min(2, this.slider * this.settings.density));
		this.manageAcc = 10;
	}

	public getDensity(): number { return this.slider; }

	/** Signal the nearest traffic car ahead of a patrol vehicle to pull over gradually. */
	public requestPullOverNear(position: THREE.Vector3, forward: THREE.Vector3, range: number = 80): number
	{
		if (!this.ready || !position || !forward || !this.cars.length) return 0;
		const direction = forward.clone();
		direction.y = 0;
		if (direction.lengthSq() < 0.01) return 0;
		direction.normalize();
		let best: TCar = null;
		let bestDistance = range;
		for (let i = 0; i < this.cars.length; i++)
		{
			const car = this.cars[i];
			if (!car.driver || car.mode !== M_DRIVE || car.pullOverS >= 0) continue;
			const lane = this.lanes[car.lane];
			if (lane.conn || lane.len - car.s < 30) continue;
			const dx = car.x - position.x, dz = car.z - position.z;
			const distance = Math.sqrt(dx * dx + dz * dz);
			const lateral = dx * direction.z - dz * direction.x;
			if (distance >= bestDistance || Math.abs(lateral) > 10 || dx * direction.x + dz * direction.z < 0.55 * distance) continue;
			best = car;
			bestDistance = distance;
		}
		if (!best) return 0;
		best.pullOverS = Math.min(this.lanes[best.lane].len - this.carLen, best.s + Math.max(14, Math.min(26, best.v * 2.4)));
		best.sig = 1;
		return best.id;
	}

	// -----------------------------------------------------------------------
	// drawing + colliders
	// -----------------------------------------------------------------------

	/** Brake lights on deceleration / standing still, indicators before and through turns. */
	private lightState(car: TCar, dt: number): void
	{
		const decel = dt > 0 ? (car.prevV - car.v) / dt : 0;
		car.prevV = car.v;
		const driving = car.mode === M_DRIVE;
		const braking = driving && (decel > 0.7 || (car.v < 0.3 && car.driver));
		car.brakeT = braking ? 0.4 : Math.max(0, car.brakeT - dt);
		car.sig = 0;
		if (!driving) return;
		if (car.pullOverS >= 0) { car.sig = 1; return; }
		const L = this.lanes[car.lane];
		if (L.conn) { if (car.s < L.len * 0.85) car.sig = L.turn; }
		else if (car.next >= 0)
		{
			const N = this.lanes[car.next];
			if (N.conn && L.len - car.s < 38) car.sig = N.turn;
		}
	}

	/** Light state of one traffic car for tests: { brake, signal, hazards, head }. */
	public lightsOf(i: number): any
	{
		const car = this.cars[i];
		if (!car) return null;
		return { brake: car.brakeT > 0, signal: car.sig, hazards: car.mode !== M_DRIVE, head: this.night && car.mode !== M_ABANDONED };
	}

	private draw(): void
	{
		if (!this.ready) return;
		const counts: number[] = [];
		for (let c = 0; c < PALETTE.length; c++) counts.push(0);
		let wheels = 0, drivers = 0, lit = 0, anyLit = false;
		const cap = this.bodyMeshes[0].instanceMatrix.count;
		const night = this.night, blink = blinkOn(this.clock);
		for (let i = 0; i < this.cars.length; i++)
		{
			const car = this.cars[i];
			const c = car.color;
			if (counts[c] >= cap) continue;
			this.tmpM.compose(car.pos, car.quat, this.one);
			this.bodyMeshes[c].setMatrixAt(counts[c]++, this.tmpM);
			this.wheelMesh.setMatrixAt(wheels++, this.tmpM);
			if (this.lights)
			{
				const hazard = car.mode !== M_DRIVE;
				const head = night && car.mode !== M_ABANDONED ? 1 : 0;
				const brake = car.brakeT > 0;
				const left = (hazard || car.sig < 0) && blink, right = (hazard || car.sig > 0) && blink;
				this.lights.set(lit++, this.tmpM, head, brake ? 1 : (head ? 0.35 : 0), packBits(false, left, right));
				if (head || brake || left || right) anyLit = true;
			}
			if (car.driver && this.settings.drivers)
			{
				this.driverMat.makeTranslation(this.driverOff.x, 0, this.driverOff.z);
				this.driverMat.premultiply(this.tmpM);
				this.driverMesh.setMatrixAt(drivers++, this.driverMat);
			}
		}
		let drawn = 0, calls = 0;
		for (let c = 0; c < PALETTE.length; c++)
		{
			const m = this.bodyMeshes[c];
			m.count = counts[c];
			m.visible = counts[c] > 0;
			if (m.visible) { m.instanceMatrix.needsUpdate = true; calls++; }
			drawn += counts[c];
		}
		this.wheelMesh.count = wheels; this.wheelMesh.visible = wheels > 0;
		if (wheels) { this.wheelMesh.instanceMatrix.needsUpdate = true; calls++; }
		this.driverMesh.count = drivers; this.driverMesh.visible = drivers > 0;
		if (drivers) { this.driverMesh.instanceMatrix.needsUpdate = true; calls++; }
		if (this.lights) calls += this.lights.commit(lit, night, anyLit);
		this.stats.drawn = drawn;
		this.stats.drawCalls = calls;
	}

	private colliders(dt: number): void
	{
		if (!this.settings.colliders) return;
		const R2 = this.settings.colliderRange * this.settings.colliderRange;
		let n = 0;
		for (let i = 0; i < this.cars.length; i++)
		{
			const car = this.cars[i];
			const dx = car.x - this.playerPos.x, dz = car.z - this.playerPos.z;
			const want = dx * dx + dz * dz < R2 && n < this.settings.maxColliders;
			if (want)
			{
				if (!car.body) this.addBody(car);
				const b = car.body;
				b.position.set(car.x, car.y, car.z);
				b.quaternion.set(car.quat.x, car.quat.y, car.quat.z, car.quat.w);
				b.velocity.set(car.hx * car.v, 0, car.hz * car.v);
				b.aabbNeedsUpdate = true;
				n++;
			}
			else if (car.body) this.freeBody(car);
		}
		this.stats.colliders = n;
	}

	private addBody(car: TCar): void
	{
		let body = this.collPool.pop();
		if (!body)
		{
			body = new CANNON.Body({ mass: 0 });
			body.type = (CANNON.Body as any).KINEMATIC;
			body.material = this.collMat;
			const list = this.boxes.length ? this.boxes : [{ half: new CANNON.Vec3(0.9, 0.55, 2.1), off: new CANNON.Vec3(0, 0, 0) }];
			for (let k = 0; k < list.length; k++) body.addShape(new CANNON.Box(list[k].half), list[k].off);
			body.addEventListener('collide', (e: any) => this.onCollide(body, e));
		}
		(body as any).realismTraffic = car;
		body.position.set(car.x, car.y, car.z);
		body.quaternion.set(car.quat.x, car.quat.y, car.quat.z, car.quat.w);
		this.ctx.world.physicsWorld.addBody(body);
		car.body = body;
	}

	private freeBody(car: TCar): void
	{
		if (!car.body) return;
		try { this.ctx.world.physicsWorld.remove(car.body); } catch (e) { /* gone */ }
		car.body.velocity.set(0, 0, 0);
		(car.body as any).realismTraffic = null;
		this.collPool.push(car.body);
		car.body = null;
	}

	private onCollide(body: CANNON.Body, e: any): void
	{
		const car: TCar = (body as any).realismTraffic;
		if (!car) return;
		const other: any = e && e.body;
		if (!other || other.mass <= 0) return;
		let impact = 0;
		try { impact = Math.abs(e.contact.getImpactVelocityAlongNormal()); } catch (err) { impact = 0; }
		if (impact < 3.5) return;
		if (car.mode !== M_CRASHED) this.stats.crashes++;
		car.mode = M_CRASHED;
		car.modeT = 4 + Math.random() * 3;
		car.v = Math.min(car.v, 1);
		if (car.driver) this.honk(car);
	}

	// -----------------------------------------------------------------------
	// gunfire
	// -----------------------------------------------------------------------

	public panic(point: THREE.Vector3, radius: number = 30): void
	{
		if (!this.settings.panic || !point) return;
		const r2 = radius * radius;
		const npcs: any = (this.ctx.world as any).realismNPCs;
		for (let i = 0; i < this.cars.length; i++)
		{
			const car = this.cars[i];
			if (!car.driver || car.mode === M_ABANDONED) continue;
			const dx = car.x - point.x, dz = car.z - point.z;
			if (dx * dx + dz * dz > r2) continue;
			if (car.v < 5 && hash01(car.id * 3.7 + this.clock) < 0.4)
			{
				// bail out and run
				car.mode = M_ABANDONED; car.modeT = 25; car.v = 0; car.driver = false;
				this.ejectDriver(car, point.x, point.z, npcs);
			}
			else car.panicT = 10;
		}
	}

	private ejectDriver(car: TCar, fromX: number, fromZ: number, npcs: any): void
	{
		if (!npcs || typeof npcs.addFleeing !== 'function') return;
		const lx = car.hz, lz = -car.hx;          // driver's left
		const x = car.x + lx * 1.5 + car.hx * 0.2, z = car.z + lz * 1.5 + car.hz * 0.2;
		try { npcs.addFleeing(x, car.y - this.restY + 0.05, z, fromX, fromZ); } catch (e) { /* ignore */ }
	}

	// -----------------------------------------------------------------------
	// carjacking
	// -----------------------------------------------------------------------

	/** F on foot next to a stopped / slow traffic car: the driver gets out and the player takes the car. */
	public tryCarjack(): boolean
	{
		if (!this.ready || !this.settings.carjack) return false;
		const w: any = this.ctx.world;
		const npcs: any = w.realismNPCs;
		const player: any = npcs ? npcs.player : null;
		if (!player || player.occupyingSeat || player.vehicleEntryInstance || player.controlledObject !== undefined) return false;
		const range = this.settings.jackRange * Math.max(1, playerScaleOf(this.ctx));
		let best = -1, bd = range;
		for (let i = 0; i < this.cars.length; i++)
		{
			const car = this.cars[i];
			if (car.v > this.settings.jackSpeed) continue;
			const d = Math.sqrt((car.x - player.position.x) * (car.x - player.position.x) + (car.z - player.position.z) * (car.z - player.position.z));
			if (d < bd) { bd = d; best = i; }
		}
		if (best < 0) return false;
		const tc = this.cars[best];
		const rgb = PALETTE[tc.color].rgb.slice(0);
		const real = this.makeRealCar(tc, rgb);
		if (!real) return false;
		if (tc.driver) this.ejectDriver(tc, player.position.x, player.position.z, npcs);
		this.release(best);
		this.jacked.push({ car: real, rgb: rgb, claimed: false, t: 0 });
		this.stats.jacked++;
		try { if (npcs && npcs.panic) npcs.panic(real.position, 16); } catch (e) { /* ignore */ }
		try { if (typeof player.findVehicleToEnter === 'function') player.findVehicleToEnter(true); } catch (e) { console.warn('[Realism] traffic: enter failed', e); }
		return true;
	}

	private makeRealCar(tc: TCar, rgb: number[]): Car
	{
		if (!this.gltf) return null;
		let car: Car;
		try
		{
			car = new Car({ scene: this.gltf.scene.clone(true), animations: [] as any[] });
		}
		catch (e) { console.warn('[Realism] traffic: Car failed', e); return null; }
		car.traverse((o: any) =>
		{
			if (!o.isMesh || !o.material || o.material.name !== 'Car') return;
			o.material = o.material.clone();            // own paint: never repaint a shared material
			if (o.material.color) o.material.color.setRGB(rgb[0], rgb[1], rgb[2]);
		});
		const b: any = car.collision;
		b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0);
		b.position.set(tc.x, tc.y + 0.05, tc.z);
		b.quaternion.set(tc.quat.x, tc.quat.y, tc.quat.z, tc.quat.w);
		if (b.previousPosition) b.previousPosition.copy(b.position);
		if (b.interpolatedPosition) b.interpolatedPosition.copy(b.position);
		if (b.interpolatedQuaternion) b.interpolatedQuaternion.copy(b.quaternion);
		if (b.initPosition) b.initPosition.copy(b.position);
		car.position.set(tc.x, tc.y + 0.05, tc.z);
		car.quaternion.copy(tc.quat);
		const marker = new THREE.Object3D();
		marker.position.set(tc.x, tc.y + 0.5, tc.z);
		marker.quaternion.copy(tc.quat);
		marker.updateMatrixWorld(true);
		car.spawnPoint = marker;
		this.ctx.world.add(car);
		(car as any).realismTrafficCar = true;
		return car;
	}

	/** Claims a carjacked car once the player sits in it; tidies up unused ones. */
	private watchJacked(player: any): void
	{
		const w: any = this.ctx.world;
		for (let i = this.jacked.length - 1; i >= 0; i--)
		{
			const j = this.jacked[i];
			const car = j.car;
			const inside = !!player && (car.controllingCharacter === player || car.seats.some((s) => s.occupiedBy === player));
			if (inside && !j.claimed && !j.pending && !((car as any).realismTheftFailAt && Date.now() - (car as any).realismTheftFailAt < 4000))
			{
				// C12: the hotwire minigame (if any) first, then the car is the player's (stolen)
				const oc = w.realismOwnedCars;
				const claim = () =>
				{
					j.claimed = true;
					if (oc && typeof oc.claim === 'function')
					{
						try { oc.claim(car, { origin: 'traffic', type: 'car', rgb: j.rgb.slice(0), stolen: true }); this.stats.claimed++; }
						catch (e) { console.warn('[Realism] traffic: claim failed', e); }
						const k = this.jacked.indexOf(j);
						if (k >= 0) this.jacked.splice(k, 1);           // the owned-car system looks after it now
					}
				};
				if (oc && typeof oc.beginTheft === 'function')
				{
					j.pending = true;
					oc.beginTheft(car, (ok: boolean) => { j.pending = false; if (ok) claim(); });
				}
				else claim();
				if (j.claimed) continue;
			}
			if (inside) { j.t = 0; continue; }
			j.t += 0.016;
			const used = car.controllingCharacter || car.seats.some((s) => !!s.occupiedBy) || (player && player.vehicleEntryInstance && player.vehicleEntryInstance.targetSeat && player.vehicleEntryInstance.targetSeat.vehicle === car);
			if (used) continue;
			const dx = car.position.x - this.playerPos.x, dz = car.position.z - this.playerPos.z;
			if (dx * dx + dz * dz > 120 * 120)
			{
				try { w.remove(car); } catch (e) { /* ignore */ }
				this.jacked.splice(i, 1);
			}
		}
	}

	private updateHint(player: any): void
	{
		let text = '';
		const w: any = this.ctx.world;
		if (this.settings.carjack && player && !player.occupyingSeat && !player.vehicleEntryInstance && w.realismUIBlocking !== true)
		{
			const range = this.settings.jackRange * Math.max(1, playerScaleOf(this.ctx));
			for (let i = 0; i < this.cars.length; i++)
			{
				const car = this.cars[i];
				if (car.v > this.settings.jackSpeed) continue;
				const dx = car.x - player.position.x, dz = car.z - player.position.z;
				if (dx * dx + dz * dz < range * range) { text = '[F] Take car'; break; }
			}
		}
		const pr = w.realismPrompt;
		if (pr && typeof pr.set === 'function')
		{
			const on = text !== '';
			if (on !== this.promptOn)
			{
				this.promptOn = on;
				try { pr.set('traffic', on ? [{ key: 'F', label: 'Take car' }] : null); } catch (e) { /* ignore */ }
			}
			text = '';      // the prompt replaces the text hint
		}
		if (text === this.hintText) return;
		this.hintText = text;
		try
		{
			if (!this.hint)
			{
				if (typeof document === 'undefined' || !document.body || !document.createElement) return;
				const h = document.createElement('div');
				h.style.cssText = 'position:fixed;left:50%;bottom:164px;transform:translateX(-50%);z-index:9999;font:bold 14px sans-serif;color:#fff;background:rgba(0,0,0,0.5);padding:5px 12px;border-radius:5px;pointer-events:none;display:none';
				document.body.appendChild(h);
				this.hint = h;
			}
			this.hint.textContent = text;
			this.hint.style.display = text ? 'block' : 'none';
		}
		catch (e) { /* headless */ }
	}

	private honk(car: TCar): void
	{
		if (!this.settings.honk) return;
		const now = this.clock;
		if (now - this.lastHonk < 1.5) return;
		this.lastHonk = now;
		this.stats.honks++;
		const d = this.dist(car);
		if (d > 80) return;
		honkSound(Math.max(0.01, 0.07 * (1 - d / 80)));
	}

	// -----------------------------------------------------------------------
	// debug / tests
	// -----------------------------------------------------------------------

	public debugCars(): any[]
	{
		return this.cars.map((c) =>
		{
			const L = this.lanes[c.lane];
			return { id: c.id, x: c.x, y: c.y, z: c.z, hx: c.hx, hz: c.hz, v: c.v, lane: c.lane, s: c.s, conn: L.conn, laneLen: L.len, node: L.node, signal: L.signal, stop: L.stop,
				light: this.lightAt(L), mode: c.mode, next: c.next, driver: c.driver, color: c.color };
		});
	}
}

/** True when two lane polylines come within `d` metres of each other. */
function pathsTouch(A: Lane, B: Lane, d: number): boolean
{
	const d2 = d * d;
	if ((A.mx - B.mx) * (A.mx - B.mx) + (A.mz - B.mz) * (A.mz - B.mz) > (A.r + B.r + d) * (A.r + B.r + d)) return false;
	for (let i = 0; i < A.x.length; i++)
	{
		for (let k = 0; k < B.x.length - 1; k++)
		{
			const ax = B.x[k], az = B.z[k], dx = B.x[k + 1] - ax, dz = B.z[k + 1] - az;
			const l2 = dx * dx + dz * dz;
			let t = l2 > 0 ? ((A.x[i] - ax) * dx + (A.z[i] - az) * dz) / l2 : 0;
			t = t < 0 ? 0 : (t > 1 ? 1 : t);
			const px = ax + dx * t - A.x[i], pz = az + dz * t - A.z[i];
			if (px * px + pz * pz < d2) return true;
		}
	}
	return false;
}

/** Merges geometries (position / normal / uv) into one non-indexed geometry. */
function mergeSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry
{
	const pos: number[] = [], nor: number[] = [], uv: number[] = [];
	for (let i = 0; i < list.length; i++)
	{
		const g = list[i].index ? list[i].toNonIndexed() : list[i];
		const p = g.getAttribute('position') as THREE.BufferAttribute;
		const n = g.getAttribute('normal') as THREE.BufferAttribute;
		const u = g.getAttribute('uv') as THREE.BufferAttribute;
		if (!p) continue;
		for (let v = 0; v < p.count; v++)
		{
			pos.push(p.getX(v), p.getY(v), p.getZ(v));
			if (n) nor.push(n.getX(v), n.getY(v), n.getZ(v)); else nor.push(0, 1, 0);
			if (u) uv.push(u.getX(v), u.getY(v)); else uv.push(0, 0);
		}
	}
	const out = new THREE.BufferGeometry();
	out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
	out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	out.computeBoundingSphere();
	return out;
}

let audioCtx: any = null;
/** Short double car horn (WebAudio, silent where unavailable). */
function honkSound(vol: number): void
{
	try
	{
		const W: any = typeof window !== 'undefined' ? window : null;
		const AC = W && (W.AudioContext || W.webkitAudioContext);
		if (!AC) return;
		if (!audioCtx) audioCtx = new AC();
		const ac = audioCtx;
		const t0 = ac.currentTime;
		for (let k = 0; k < 2; k++)
		{
			const osc = ac.createOscillator(), osc2 = ac.createOscillator(), gain = ac.createGain();
			osc.type = 'square'; osc2.type = 'square';
			osc.frequency.setValueAtTime(415, t0); osc2.frequency.setValueAtTime(523, t0);
			const s = t0 + k * 0.32;
			gain.gain.setValueAtTime(0.0001, s);
			gain.gain.exponentialRampToValueAtTime(vol, s + 0.02);
			gain.gain.setValueAtTime(vol, s + 0.2);
			gain.gain.exponentialRampToValueAtTime(0.0001, s + 0.26);
			osc.connect(gain); osc2.connect(gain); gain.connect(ac.destination);
			osc.start(s); osc2.start(s); osc.stop(s + 0.28); osc2.stop(s + 0.28);
		}
	}
	catch (e) { /* no audio */ }
}

/** Builds the traffic system and exposes it as (world as any).realismTraffic. */
export function buildTraffic(ctx: RealismCtx, signals: any): RealismTraffic
{
	const t = new RealismTraffic(ctx, signals);
	(ctx.world as any).realismTraffic = t;
	const npcs: any = (ctx.world as any).realismNPCs;
	t.setDensity(npcs && typeof npcs.getDensity === 'function' ? npcs.getDensity() : 1);
	ctx.world.registerUpdatable(t);
	return t;
}
