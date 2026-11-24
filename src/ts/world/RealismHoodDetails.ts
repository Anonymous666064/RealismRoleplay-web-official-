/*
 * RealismHoodDetails.ts
 * ---------------------
 * Makes the gang neighbourhoods (The Flats, Hillcrest Projects, Harbor Row) look
 * properly run down. Placed at build time from the generated map; adds to what the
 * map already has there (chain-link fences, wrecks, mattresses, trash bags, tyres,
 * broken street lights, dead lawns) without repeating it:
 *
 *  - wooden utility poles along every neighbourhood street, some leaning hard,
 *    with sagging power / phone lines between them and service drops to the houses
 *  - pairs of sneakers hanging off the lines here and there
 *  - potholes, cracks, alligator cracking and tar patches on the asphalt (decals)
 *  - weeds and overgrown grass tufts along the kerbs, fence lines and yards
 *  - broken wooden side fences (missing boards, leaning panels, gaps)
 *  - abandoned shopping carts (some tipped over), dumped couches, piles of tyres
 *
 * Poles, fences, carts, couches and tyre piles get simple static colliders. All of it
 * is instanced per chunk and distance-culled; lines are one LineSegments per 256 m.
 * Swap any asset for your own .glb in realism-config.js -> city.props.<name>
 * (utilityPole, hangingShoes, woodFence, shoppingCart, couch, tirePile, weeds).
 * Off with city.gangNeighborhoods = false (or city.hoodDetails = false).
 */

import * as THREE from 'three';
import { RealismCtx, chunkKey } from './RealismContext';
import { GeoAccum, Frame, box, boxC, cyl, cylX, cylZ, seeded } from './RealismGeometry';
import { AssetPart, partsFrom } from './RealismAssets';
import { Building, Road, Hood } from './RealismMapData';
import { phong, canvasTexture } from './RealismMaterials';
import { MatrixBatcher, ScatterSpace, scatterSpace, houseKeepOut, inKeepOut, local, roadAt, yawX } from './RealismScatter';

const BIG = 256;
const POLE_H = 9.4;
/** Wire attachment points on a pole, local: left arm, right arm, phone cable. */
const ATTACH = [[-0.9, 8.92, 0], [0.9, 8.92, 0], [0, 6.6, -0.24]];
const ROAD_LIFT: { [k: string]: number } = { street: 0.08, avenue: 0.1, rural: 0.08, highway: 0.12 };

const WOOD = [0.34, 0.27, 0.2], WOOD_D = [0.26, 0.2, 0.15], GREY = [0.45, 0.46, 0.47], DARK = [0.1, 0.1, 0.11];
const Y_AXIS = new THREE.Vector3(0, 1, 0), X_AXIS = new THREE.Vector3(1, 0, 0), Z_AXIS = new THREE.Vector3(0, 0, 1), UP = new THREE.Vector3(0, 1, 0);

// --- assets -----------------------------------------------------------------------------

function poleParts(ctx: RealismCtx, v: number): AssetPart[]
{
	const a = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	cyl(a, f, 0, -0.8, 0, POLE_H + 0.8, 0.17, 0.12, 7, WOOD);
	box(a, f, -1.05, 8.55, -0.06, 1.05, 8.7, 0.06, WOOD_D);
	for (let k = -1; k <= 1; k += 2) boxC(a, f, k * 0.32, 8.3, 0, 0.5, 0.05, 0.04, [0.3, 0.3, 0.3]);
	for (let k = -1; k <= 1; k += 2) cyl(a, f, k * 0.9, 8.7, 0, 0.22, 0.05, 0.04, 6, [0.78, 0.8, 0.76]);
	cyl(a, f, 0, POLE_H, 0, 0.2, 0.05, 0.04, 6, [0.78, 0.8, 0.76]);
	box(a, f, -0.06, 6.5, -0.26, 0.06, 6.7, -0.12, DARK);
	// staples / old flyers / step bolts
	box(a, f, -0.2, 2.2, 0.1, 0.2, 2.6, 0.18, [0.75, 0.72, 0.6]);
	for (let k = 0; k < 6; k++) boxC(a, f, (k % 2 ? 0.2 : -0.2), 3.0 + k * 0.6, 0, 0.18, 0.03, 0.03, [0.25, 0.25, 0.25]);
	if (v === 1)
	{
		// pole-top transformer
		box(a, f, -0.08, 7.0, 0.1, 0.08, 7.9, 0.2, [0.3, 0.3, 0.3]);
		cyl(a, f, 0, 6.9, 0.48, 1.05, 0.3, 0.3, 8, GREY, true);
		cyl(a, f, 0, 7.95, 0.48, 0.08, 0.32, 0.2, 8, [0.4, 0.4, 0.41]);
		cyl(a, f, 0.1, 8.0, 0.48, 0.25, 0.04, 0.03, 5, [0.75, 0.78, 0.74]);
	}
	return partsFrom(ctx, [[a, 'plain']]);
}

function shoesParts(ctx: RealismCtx, v: number): AssetPart[]
{
	const a = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	const cols = [[0.85, 0.85, 0.82], [0.15, 0.15, 0.17], [0.7, 0.15, 0.12]];
	const c = cols[v % cols.length];
	for (let k = -1; k <= 1; k += 2)
	{
		const x = k * 0.07, drop = k < 0 ? 0.42 : 0.5;
		// lace
		box(a, f, x * 0.4 - 0.006, -drop + 0.12, -0.006, x * 0.4 + 0.006, 0.02, 0.006, [0.9, 0.9, 0.88]);
		// shoe hanging toe-down: sole + upper
		box(a, f, x - 0.05, -drop - 0.17, -0.06, x + 0.05, -drop + 0.12, 0.06, c);
		box(a, f, x - 0.052, -drop - 0.19, -0.065, x + 0.052, -drop + 0.13, -0.05, [0.92, 0.92, 0.9]);
	}
	return partsFrom(ctx, [[a, 'plain', false]]);
}

function fenceParts(ctx: RealismCtx, v: number): AssetPart[]
{
	const a = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	const w = v === 2 ? [0.5, 0.48, 0.44] : [0.42, 0.33, 0.24];
	const wd = [w[0] * 0.8, w[1] * 0.8, w[2] * 0.8];
	const rnd = seeded(77 + v * 13);
	for (let k = -1; k <= 1; k += 2) box(a, f, k * 1.2 - 0.05, -0.3, -0.05, k * 1.2 + 0.05, 1.85, 0.05, wd, 'b');
	box(a, f, -1.15, 0.35, -0.08, 1.15, 0.45, -0.04, wd, 'lr');
	box(a, f, -1.15, 1.4, -0.08, 1.15, 1.5, -0.04, wd, 'lr');
	for (let i = 0; i < 10; i++)
	{
		const x0 = -1.15 + i * 0.23 + 0.01, x1 = x0 + 0.2;
		if (v === 1 && rnd() < 0.3) continue;                    // missing boards
		let top = 1.8 - rnd() * 0.06;
		if (v === 2 && rnd() < 0.35) top = 0.6 + rnd() * 0.9;    // snapped boards
		const sh = 0.85 + rnd() * 0.25;
		box(a, f, x0, 0.05 + rnd() * 0.04, -0.04, x1, top, 0.0, [w[0] * sh, w[1] * sh, w[2] * sh], 'b');
	}
	if (v === 1)
	{
		// one board hanging off a single nail
		const fr = new Frame(0.3, 1.45, 0.02, 0);
		const p = (x: number, y: number) => { const c = Math.cos(0.5), s = Math.sin(0.5); return fr.p(x * c - y * s, x * s + y * c, 0); };
		a.face([p(-0.065, -1.3), p(0.065, -1.3), p(0.065, 0.05), p(-0.065, 0.05)], [0, 0, 1], [[0, 0], [0, 0], [0, 0], [0, 0]], w);
		a.face([p(0.065, -1.3), p(-0.065, -1.3), p(-0.065, 0.05), p(0.065, 0.05)], [0, 0, -1], [[0, 0], [0, 0], [0, 0], [0, 0]], w);
	}
	return partsFrom(ctx, [[a, 'plain']]);
}

function cartParts(ctx: RealismCtx): AssetPart[]
{
	const a = new GeoAccum(), s = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	const M = [0.62, 0.63, 0.65], R = 0.012;
	const bar = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
	{
		const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
		box(s, f, x0, y0, z0, x1, y1, z1, M, dy >= dx && dy >= dz ? 'tb' : (dx >= dz ? 'lr' : 'fk'));
	};
	// basket outline (slightly wider at the back)
	const yb = 0.42, yt = 0.98;
	for (let k = -1; k <= 1; k += 2)
	{
		bar(k * 0.27 - R, yb, -0.45, k * 0.27 + R, yt, -0.45 + 2 * R);          // front corners
		bar(k * 0.3 - R, yb, 0.45 - 2 * R, k * 0.3 + R, yt, 0.45);             // back corners
		for (let y = yb; y <= yt + 0.01; y += 0.14) bar(k * 0.285 - R, y, -0.45, k * 0.285 + R, y + 2 * R, 0.45);   // side rails
		for (let z = -0.3; z < 0.45; z += 0.19) bar(k * 0.285 - R, yb, z, k * 0.285 + R, yt, z + 2 * R);         // side uprights
		bar(k * 0.25 - R, 0.08, -0.4, k * 0.25 + R, 0.12, 0.45);                // chassis
		bar(k * 0.27 - R, 0.1, 0.42, k * 0.27 + R, yb, 0.45);                   // rear legs
		bar(k * 0.25 - R, 0.1, -0.42, k * 0.25 + R, yb, -0.39);                 // front legs
		bar(k * 0.3 - R, yt, 0.45, k * 0.3 + R, yt + 0.12, 0.58);               // handle arms
	}
	for (let y = yb; y <= yt + 0.01; y += 0.14) { bar(-0.27, y, -0.45, 0.27, y + 2 * R, -0.45 + 2 * R); bar(-0.3, y, 0.45 - 2 * R, 0.3, y + 2 * R, 0.45); }
	for (let x = -0.18; x < 0.2; x += 0.18) { bar(x, yb, -0.45, x + 2 * R, yt, -0.45 + 2 * R); bar(x, yb, -0.45, x + 2 * R, yb + 2 * R, 0.45); }
	box(a, f, -0.32, yt + 0.1, 0.56, 0.32, yt + 0.15, 0.61, [0.75, 0.15, 0.12]);   // handle grip
	for (let k = 0; k < 4; k++) cylX(a, f, (k % 2 ? 0.22 : -0.28), (k % 2 ? 0.28 : -0.22), 0.06, k < 2 ? -0.38 : 0.4, 0.06, 6, DARK);
	return partsFrom(ctx, [[a, 'plain'], [s, 'shiny']]);
}

function couchParts(ctx: RealismCtx, v: number): AssetPart[]
{
	const a = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	const cols = [[0.45, 0.36, 0.26], [0.5, 0.25, 0.22]];
	const c = cols[v % cols.length];
	const d = [c[0] * 0.75, c[1] * 0.75, c[2] * 0.75];
	const stain = [c[0] * 0.55, c[1] * 0.5, c[2] * 0.45];
	box(a, f, -1.0, 0.08, -0.45, 1.0, 0.42, 0.45, d);                // base
	box(a, f, -1.0, 0.42, -0.45, 1.0, 0.95, -0.2, c);                // back
	for (let k = -1; k <= 1; k += 2) box(a, f, k * 1.0 - (k > 0 ? 0.22 : 0), 0.42, -0.45, k * 1.0 + (k < 0 ? 0.22 : 0), 0.66, 0.45, c);   // arms
	const cushions = v === 1 ? 1 : 2;   // one cushion gone on the red couch
	for (let i = 0; i < cushions; i++) box(a, f, -0.78 + i * 0.79, 0.42, -0.2, -0.01 + i * 0.79, 0.56, 0.42, i === 0 ? stain : c);
	if (v === 1) box(a, f, 0.0, 0.42, -0.2, 0.78, 0.44, 0.42, [0.6, 0.55, 0.42]);   // exposed foam
	for (let k = 0; k < 4; k++) box(a, f, (k % 2 ? 0.88 : -0.95), 0, (k < 2 ? -0.4 : 0.34), (k % 2 ? 0.95 : -0.88), 0.08, (k < 2 ? -0.34 : 0.4), DARK);
	return partsFrom(ctx, [[a, 'plain']]);
}

function tirePileParts(ctx: RealismCtx, v: number): AssetPart[]
{
	const a = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	const n = v === 0 ? 3 : 4;
	for (let i = 0; i < n; i++)
	{
		const ox = (i % 2) * 0.06 - 0.03, oz = ((i * 7) % 3) * 0.04 - 0.04;
		cyl(a, f, ox, i * 0.24, oz, 0.24, 0.36, 0.36, 10, DARK);
		cyl(a, f, ox, i * 0.24 + 0.24, oz, 0.005, 0.36, 0.2, 10, [0.06, 0.06, 0.06]);
	}
	if (v === 1) { const g = new Frame(0.75, 0.32, 0.1, 0.4); cylZ(a, g, -0.12, 0.12, 0, 0, 0.36, 10, DARK); }   // one leaning against the pile
	return partsFrom(ctx, [[a, 'plain']]);
}

function weedParts(ctx: RealismCtx, v: number): AssetPart[]
{
	const a = new GeoAccum();
	const rnd = seeded(311 + v * 101);
	const base = v === 0 ? [0.34, 0.43, 0.17] : [0.55, 0.5, 0.27];
	const blades = 9;
	for (let i = 0; i < blades; i++)
	{
		const ang = (i / blades) * Math.PI * 2 + rnd() * 0.6;
		const lean = 0.15 + rnd() * 0.35, h = 0.25 + rnd() * 0.4, w = 0.035 + rnd() * 0.03;
		const ox = Math.cos(ang) * 0.06, oz = Math.sin(ang) * 0.06;
		const tx = Math.cos(ang) * lean, tz = Math.sin(ang) * lean;
		const px = -Math.sin(ang) * w, pz = Math.cos(ang) * w;
		const sh = 0.8 + rnd() * 0.4;
		const c = [base[0] * sh, base[1] * sh, base[2] * sh];
		const tip = [ox + tx, h, oz + tz];
		const p0 = [ox - px, 0, oz - pz], p1 = [ox + px, 0, oz + pz];
		const Z3 = [[0, 0], [0, 0], [0, 0]];
		// two-sided blade, normals tipped up so both sides light the same
		a.face([p0, p1, tip], [Math.cos(ang) * 0.4, 0.9, Math.sin(ang) * 0.4], Z3, c);
		a.face([p1, p0, tip], [-Math.cos(ang) * 0.4, 0.9, -Math.sin(ang) * 0.4], Z3, c);
	}
	if (v === 1)
	{
		// a dandelion head or two
		for (let k = 0; k < 2; k++)
		{
			const x = (rnd() - 0.5) * 0.2, z = (rnd() - 0.5) * 0.2, h = 0.45 + rnd() * 0.15;
			const Z3 = [[0, 0], [0, 0], [0, 0]];
			a.face([[x - 0.01, 0, z], [x + 0.01, 0, z], [x, h, z]], [0, 0.6, 0.8], Z3, base);
			a.face([[x - 0.04, h, z - 0.04], [x + 0.04, h, z - 0.04], [x, h + 0.03, z + 0.04]], [0, 1, 0], Z3, [0.9, 0.82, 0.25]);
		}
	}
	return [{ geom: a.toGeometry(), mat: ctx.mats.foliage, cast: false }];
}

// --- road decals ------------------------------------------------------------------------

let decalMaterial: THREE.Material = null;
function decalMat(ctx: RealismCtx): THREE.Material
{
	if (decalMaterial) return decalMaterial;
	const tex = canvasTexture(256, (g, S) =>
	{
		g.clearRect(0, 0, S, S);
		const T = S / 2;
		const rnd = seeded(4242);
		const blob = (cx: number, cy: number, r: number, jag: number, n: number) =>
		{
			g.beginPath();
			for (let i = 0; i <= n; i++)
			{
				const an = i / n * Math.PI * 2, rr = r * (1 - jag / 2 + rnd() * jag);
				const x = cx + Math.cos(an) * rr, y = cy + Math.sin(an) * rr;
				if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
			}
			g.closePath();
		};
		// 0: pothole
		{
			const cx = T / 2, cy = T / 2;
			g.fillStyle = 'rgba(70,68,64,0.55)'; blob(cx, cy, 50, 0.35, 18); g.fill();
			g.fillStyle = 'rgba(28,27,26,0.95)'; blob(cx, cy, 40, 0.4, 16); g.fill();
			g.fillStyle = 'rgba(12,12,12,0.95)'; blob(cx + 3, cy + 4, 24, 0.5, 12); g.fill();
			for (let i = 0; i < 70; i++) { g.fillStyle = 'rgba(' + (90 + rnd() * 60 | 0) + ',' + (88 + rnd() * 55 | 0) + ',' + (80 + rnd() * 50 | 0) + ',0.9)'; const an = rnd() * 6.28, rr = rnd() * 38; g.fillRect(cx + Math.cos(an) * rr, cy + Math.sin(an) * rr, 1 + rnd() * 2, 1 + rnd() * 2); }
			g.strokeStyle = 'rgba(15,15,15,0.8)'; g.lineWidth = 1.5;
			for (let k = 0; k < 5; k++) { let x = cx, y = cy, an = rnd() * 6.28; g.beginPath(); g.moveTo(x + Math.cos(an) * 40, y + Math.sin(an) * 40); x += Math.cos(an) * 40; y += Math.sin(an) * 40; for (let s = 0; s < 4; s++) { an += (rnd() - 0.5) * 1.2; x += Math.cos(an) * 6; y += Math.sin(an) * 6; g.lineTo(Math.max(4, Math.min(T - 4, x)), Math.max(4, Math.min(T - 4, y))); } g.stroke(); }
		}
		// 1: long cracks
		{
			g.save(); g.translate(T, 0);
			g.strokeStyle = 'rgba(14,14,14,0.9)'; g.lineCap = 'round';
			const crack = (x: number, y: number, an: number, len: number, w: number, depth: number) =>
			{
				g.lineWidth = w; g.beginPath(); g.moveTo(x, y);
				for (let s = 0; s < len; s++)
				{
					an += (rnd() - 0.5) * 0.7;
					x = Math.max(5, Math.min(T - 5, x + Math.cos(an) * 5)); y = Math.max(5, Math.min(T - 5, y + Math.sin(an) * 5));
					g.lineTo(x, y);
					if (depth > 0 && rnd() < 0.12) { g.stroke(); crack(x, y, an + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd() * 0.6), len / 2, w * 0.6, depth - 1); g.lineWidth = w; g.beginPath(); g.moveTo(x, y); }
				}
				g.stroke();
			};
			crack(8, T / 2, 0, 24, 2.6, 2);
			crack(T / 2, 8, Math.PI / 2, 14, 1.8, 1);
			g.restore();
		}
		// 2: tar patch
		{
			g.save(); g.translate(0, T);
			g.fillStyle = 'rgba(22,22,24,0.88)';
			g.beginPath(); g.moveTo(10, 14); g.lineTo(T - 14, 9); g.lineTo(T - 8, T - 16); g.lineTo(16, T - 10); g.closePath(); g.fill();
			g.strokeStyle = 'rgba(8,8,8,0.9)'; g.lineWidth = 3; g.stroke();
			g.fillStyle = 'rgba(40,40,42,0.7)'; g.fillRect(30, 30, 40, 26);
			for (let i = 0; i < 120; i++) { g.fillStyle = 'rgba(50,50,52,0.6)'; g.fillRect(14 + rnd() * (T - 30), 14 + rnd() * (T - 30), 1.5, 1.5); }
			g.restore();
		}
		// 3: alligator cracking
		{
			g.save(); g.translate(T, T);
			const cx = T / 2, cy = T / 2;
			g.fillStyle = 'rgba(40,39,37,0.35)'; blob(cx, cy, 54, 0.3, 14); g.fill();
			g.strokeStyle = 'rgba(14,14,14,0.85)'; g.lineWidth = 1.6;
			const pts: number[][] = [];
			for (let i = 0; i < 26; i++) { const an = rnd() * 6.28, rr = Math.sqrt(rnd()) * 50; pts.push([cx + Math.cos(an) * rr, cy + Math.sin(an) * rr]); }
			for (let i = 0; i < pts.length; i++)
			{
				// connect each point to its two nearest neighbours: a crazed polygon mesh
				const d = pts.map((p, j) => [j, (p[0] - pts[i][0]) * (p[0] - pts[i][0]) + (p[1] - pts[i][1]) * (p[1] - pts[i][1])]).sort((x, y) => x[1] - y[1]);
				for (let k = 1; k <= 3; k++) { const q = pts[d[k][0]]; g.beginPath(); g.moveTo(pts[i][0], pts[i][1]); g.lineTo((pts[i][0] + q[0]) / 2 + (rnd() - 0.5) * 4, (pts[i][1] + q[1]) / 2 + (rnd() - 0.5) * 4); g.lineTo(q[0], q[1]); g.stroke(); }
			}
			g.restore();
		}
	});
	tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
	decalMaterial = phong(ctx.world, { map: tex, transparent: true, depthWrite: false, shininess: 0, specular: 0x000000, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -18 });
	decalMaterial.name = 'roadDecal';
	return decalMaterial;
}

function decalParts(ctx: RealismCtx, v: number): AssetPart[]
{
	const a = new GeoAccum();
	const u0 = (v % 2) * 0.5 + 0.01, u1 = u0 + 0.48;
	// canvas y runs down, texture v runs up (flipY): tile row 0 is the top half
	const v1 = 1 - Math.floor(v / 2) * 0.5 - 0.01, v0 = v1 - 0.48;
	a.face([[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, -0.5], [-0.5, 0, -0.5]], [0, 1, 0], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], [1, 1, 1]);
	return [{ geom: a.toGeometry(), mat: decalMat(ctx), cast: false }];
}

// --- placement ------------------------------------------------------------------------------

interface Pole { x: number; y: number; z: number; q: THREE.Quaternion; att: number[][]; road: number; stretch: number; }

class HoodDresser
{
	private ctx: RealismCtx;
	private sp: ScatterSpace;
	private batch: MatrixBatcher;
	private rnd: () => number;
	private wires: { [key: string]: number[] } = {};
	private wireKeys: string[] = [];
	public poles: Pole[] = [];
	public spans = 0;
	public drops = 0;
	public colliders = 0;
	public wireMeshes = 0;

	constructor(ctx: RealismCtx, sp: ScatterSpace, batch: MatrixBatcher)
	{
		this.ctx = ctx; this.sp = sp; this.batch = batch;
		this.rnd = seeded(ctx.data.seed * 17 + 911);
	}

	private hoodAt(x: number, z: number, m: number): Hood
	{
		const hs = this.ctx.data.hoods;
		for (let i = 0; i < hs.length; i++) if (x >= hs[i].x0 - m && x <= hs[i].x1 + m && z >= hs[i].z0 - m && z <= hs[i].z1 + m) return hs[i];
		return null;
	}

	private nearJunction(x: number, z: number, extra: number): boolean
	{
		const js = this.ctx.data.intersections;
		for (let i = 0; i < js.length; i++)
		{
			const J = js[i];
			const r = J.crossHW + extra;
			if ((J.x - x) * (J.x - x) + (J.z - z) * (J.z - z) < r * r) return true;
		}
		return false;
	}

	private hoodRoads(): number[]
	{
		const out: number[] = [];
		const roads = this.ctx.data.roads;
		for (let r = 0; r < roads.length; r++)
		{
			const road = roads[r];
			if (road.kind !== 'street' && road.kind !== 'avenue') continue;
			for (let i = 0; i < road.pts.length; i += 2) if (this.hoodAt(road.pts[i].x, road.pts[i].z, 0)) { out.push(r); break; }
		}
		return out;
	}

	private houses(): Building[]
	{
		return this.ctx.data.buildings.filter((b) => b.district === 'hood' && (b.kind === 'house' || b.kind === 'apartment') && !b.custom);
	}

	// --- wires --------------------------------------------------------------------------

	private wire(a: number[], b: number[], sag: number): void
	{
		const mx = (a[0] + b[0]) / 2, mz = (a[2] + b[2]) / 2;
		const key = chunkKey(mx, mz, BIG);
		let arr = this.wires[key];
		if (arr === undefined) { arr = []; this.wires[key] = arr; this.wireKeys.push(key); }
		const n = 10;
		let px = a[0], py = a[1], pz = a[2];
		for (let i = 1; i <= n; i++)
		{
			const t = i / n;
			const x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t;
			const y = a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t);
			arr.push(px, py, pz, x, y, z);
			px = x; py = y; pz = z;
		}
	}

	private wirePoint(a: number[], b: number[], sag: number, t: number): number[]
	{
		return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
	}

	/** Wire path clear of buildings (checked between the ends). */
	private wireClear(a: number[], b: number[], sag: number, t0: number, t1: number): boolean
	{
		const L = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[2] - a[2]) * (b[2] - a[2]));
		const n = Math.max(2, Math.ceil(L / 1.5));
		for (let i = 0; i <= n; i++)
		{
			const t = t0 + (t1 - t0) * i / n;
			const p = this.wirePoint(a, b, sag, t);
			if (this.sp.blockedAbove(p[0], p[1], p[2])) return false;
		}
		return true;
	}

	private buildWires(): void
	{
		const mat = new THREE.LineBasicMaterial({ color: 0x141414 });
		for (let k = 0; k < this.wireKeys.length; k++)
		{
			const arr = this.wires[this.wireKeys[k]];
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
			g.computeBoundingSphere();
			const lines = new THREE.LineSegments(g, mat);
			lines.matrixAutoUpdate = false;
			lines.updateMatrix();
			lines.castShadow = false; lines.receiveShadow = false;
			this.ctx.world.graphicsWorld.add(lines);
			this.ctx.cull.add(lines, 'street', g.boundingSphere.center, g.boundingSphere.radius);
			this.wireMeshes++;
		}
	}

	// --- poles ----------------------------------------------------------------------------

	private placePole(x: number, z: number, nx: number, nz: number, roadIdx: number, stretch: number): Pole
	{
		const data = this.ctx.data;
		const y = data.heightAt(x, z) - 0.05;
		const ry = yawX(nx, nz);   // cross-arm across the road
		const qy = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, ry);
		const r = this.rnd();
		const lean = r < 0.55 ? this.rnd() * 0.035 : (r < 0.85 ? 0.05 + this.rnd() * 0.07 : 0.15 + this.rnd() * 0.11);
		const la = this.rnd() * Math.PI * 2;
		const ql = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(la), 0, Math.sin(la)), lean);
		const q = ql.multiply(qy);
		const v = this.rnd() < 0.25 ? 1 : 0;
		this.batch.addQ('utilityPole', v, x, y, z, q, 1, 1, 1, 'street', BIG, true);
		// collider along the (possibly leaning) pole axis
		const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
		const psi = Math.atan2(axis.x, axis.z), theta = Math.acos(Math.max(-1, Math.min(1, axis.y)));
		const hh = POLE_H / 2;
		this.ctx.phys.box(x + axis.x * hh, y + axis.y * hh, z + axis.z * hh, 0.16, hh, 0.16, psi, theta);
		this.colliders++;
		this.sp.addCircle(x, z, 0.7);
		const att: number[][] = [];
		for (let k = 0; k < ATTACH.length; k++)
		{
			const p = new THREE.Vector3(ATTACH[k][0], ATTACH[k][1], ATTACH[k][2]).applyQuaternion(q);
			att.push([x + p.x, y + p.y, z + p.z]);
		}
		const pole: Pole = { x: x, y: y, z: z, q: q, att: att, road: roadIdx, stretch: stretch };
		this.poles.push(pole);
		return pole;
	}

	public polesAndLines(): void
	{
		const data = this.ctx.data;
		const roads = this.hoodRoads();
		for (let ri = 0; ri < roads.length; ri++)
		{
			const road: Road = data.roads[roads[ri]];
			const total = road.pts[road.pts.length - 1].s;
			const side = (roads[ri] % 2 === 0) ? 1 : -1;
			let prev: Pole = null;
			let stretch = 0;
			for (let s = 6 + this.rnd() * 8; s < total - 4; s += 30 + this.rnd() * 6)
			{
				let placed: Pole = null;
				const shifts = [0, 2.5, -2.5, 5, -5];
				for (let k = 0; k < shifts.length && !placed; k++)
				{
					const p = roadAt(road, Math.max(0, Math.min(total, s + shifts[k])));
					const off = road.width / 2 + 0.9;
					const x = p.x + p.nx * off * side, z = p.z + p.nz * off * side;
					if (!this.hoodAt(x, z, 0)) continue;
					if (this.nearJunction(x, z, 6)) continue;
					if (!this.sp.free(x, z, 0.35, 0.4, 0.4)) continue;
					placed = this.placePole(x, z, p.nx * side, p.nz * side, roads[ri], stretch);
				}
				if (!placed) { prev = null; stretch++; continue; }
				if (prev)
				{
					const dx = placed.x - prev.x, dz = placed.z - prev.z;
					const L = Math.sqrt(dx * dx + dz * dz);
					const sag = 0.35 + L * 0.03;
					if (L < 48 && this.wireClear(prev.att[0], placed.att[0], sag, 0.05, 0.95) && this.wireClear(prev.att[1], placed.att[1], sag, 0.05, 0.95))
					{
						for (let k = 0; k < ATTACH.length; k++) this.wire(prev.att[k], placed.att[k], k === 2 ? sag * 1.25 : sag);
						this.spans++;
						// sneakers thrown over the line
						if (this.rnd() < 0.22)
						{
							const k = Math.floor(this.rnd() * 3);
							const t = 0.3 + this.rnd() * 0.4;
							const wp = this.wirePoint(prev.att[k], placed.att[k], k === 2 ? sag * 1.25 : sag, t);
							this.batch.add('hangingShoes', this.rnd() < 0.6 ? 0 : 1, wp[0], wp[1], wp[2], yawX(dx, dz) + (this.rnd() - 0.5) * 0.3, 1, 1, 1, 'detail', BIG, false);
						}
					}
				}
				prev = placed;
			}
		}
		this.serviceDrops();
	}

	/** Thin drop lines from the poles to the fronts of nearby houses. */
	private serviceDrops(): void
	{
		const hs = this.houses();
		const served: { [i: number]: boolean } = {};
		for (let pi = 0; pi < this.poles.length; pi++)
		{
			const P = this.poles[pi];
			const cand: { i: number; d: number; pt: number[] }[] = [];
			for (let i = 0; i < hs.length; i++)
			{
				if (served[i]) continue;
				const b = hs[i];
				const lp = local(b, b.w * 0.25, b.d / 2 + 0.05);
				const dx = P.x - lp[0], dz = P.z - lp[1];
				const d = Math.sqrt(dx * dx + dz * dz);
				if (d < 5 || d > 26) continue;
				const fx = Math.sin(b.rot), fz = Math.cos(b.rot);
				if (dx * fx + dz * fz < 0.4 * d) continue;      // the house must face the pole
				const top = Math.min(b.baseY + b.h, b.baseY + 6.2) - 0.35;
				cand.push({ i: i, d: d, pt: [lp[0], top, lp[1]] });
			}
			cand.sort((a, b) => a.d - b.d);
			let n = 0;
			for (let k = 0; k < cand.length && n < 2; k++)
			{
				const c = cand[k];
				const sag = 0.25 + c.d * 0.02;
				if (!this.wireClear(P.att[2], c.pt, sag, 0.08, 0.85)) continue;
				this.wire(P.att[2], c.pt, sag);
				served[c.i] = true;
				n++;
				this.drops++;
			}
		}
	}

	// --- road wear ------------------------------------------------------------------------

	/** Point and surface normal on the road ribbon (same construction as buildRoads). */
	private roadSurface(road: Road, i: number, t: number, u: number): { p: number[]; n: THREE.Vector3 }
	{
		const data = this.ctx.data;
		const pts = road.pts, n = pts.length, hw = road.width / 2;
		const lift = ROAD_LIFT[road.kind] || 0.08;
		const edge = (k: number) =>
		{
			const a = pts[Math.max(k - 1, 0)], b = pts[Math.min(k + 1, n - 1)];
			let tx = b.x - a.x, tz = b.z - a.z;
			const tl = Math.sqrt(tx * tx + tz * tz) || 1;
			tx /= tl; tz /= tl;
			const p = pts[k];
			const nx = -tz, nz = tx;
			const lx = p.x + nx * hw, lz = p.z + nz * hw, rx = p.x - nx * hw, rz = p.z - nz * hw;
			const cy = Math.max(p.y, data.heightAt(p.x, p.z)) + lift;
			const ly = Math.max(Math.max(p.y, data.heightAt(lx, lz)) + lift, cy - 0.05);
			const ry = Math.max(Math.max(p.y, data.heightAt(rx, rz)) + lift, cy - 0.05);
			return { L: [lx, ly, lz], R: [rx, ry, rz] };
		};
		const e0 = edge(i), e1 = edge(i + 1);
		const w = (u / hw + 1) / 2;
		const mix = (A: number[], B: number[], f: number) => [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];
		const a = mix(e0.R, e0.L, w), b = mix(e1.R, e1.L, w);
		const p = mix(a, b, t);
		const along = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
		const lc = mix(e0.L, e1.L, t), rc = mix(e0.R, e1.R, t);
		const across = new THREE.Vector3(lc[0] - rc[0], lc[1] - rc[1], lc[2] - rc[2]);
		const nrm = new THREE.Vector3().crossVectors(along, across).normalize();
		if (nrm.y < 0) nrm.negate();
		if (!(nrm.y > 0.5)) nrm.set(0, 1, 0);
		return { p: p, n: nrm };
	}

	public roadWear(): number
	{
		const data = this.ctx.data;
		const roads = this.hoodRoads();
		let count = 0;
		const qa = new THREE.Quaternion(), qy = new THREE.Quaternion();
		for (let ri = 0; ri < roads.length; ri++)
		{
			const road = data.roads[roads[ri]];
			const total = road.pts[road.pts.length - 1].s;
			const hw = road.width / 2;
			for (let s = 3 + this.rnd() * 6; s < total - 3; s += 5 + this.rnd() * 7)
			{
				const p = roadAt(road, s);
				if (!this.hoodAt(p.x, p.z, -2)) continue;
				const r = this.rnd();
				const v = r < 0.3 ? 0 : (r < 0.6 ? 1 : (r < 0.8 ? 2 : 3));
				const size = v === 0 ? 0.8 + this.rnd() * 0.9 : (v === 1 ? 2.5 + this.rnd() * 2.5 : (v === 2 ? 1.4 + this.rnd() * 1.6 : 1.6 + this.rnd() * 1.4));
				const umax = hw - size * 0.55 - 0.25;
				if (umax <= 0) continue;
				const u = (this.rnd() * 2 - 1) * umax;
				const wx = p.x + p.nx * u, wz = p.z + p.nz * u;
				if (this.nearJunction(wx, wz, 4 + size / 2)) continue;
				const surf = this.roadSurface(road, p.i, p.t, u);
				qa.setFromUnitVectors(UP, surf.n);
				const yaw = v === 1 ? yawX(p.tx, p.tz) + (this.rnd() - 0.5) * 0.5 : this.rnd() * Math.PI * 2;
				qy.setFromAxisAngle(Y_AXIS, yaw);
				const q = qa.clone().multiply(qy);
				const sx = size, sz = v === 1 ? size * (0.35 + this.rnd() * 0.3) : size * (0.75 + this.rnd() * 0.4);
				this.batch.addQ('roadDecal', v, surf.p[0], surf.p[1] + 0.02, surf.p[2], q, sx, 1, sz, 'detail', BIG, false);
				count++;
				// grass growing out of the cracks
				if ((v === 1 || v === 3) && this.rnd() < 0.5)
				{
					const g = this.roadSurface(road, p.i, p.t, Math.max(-hw + 0.3, Math.min(hw - 0.3, u + (this.rnd() - 0.5) * 0.6)));
					this.batch.addQ('weeds', 0, g.p[0], g.p[1] - 0.01, g.p[2], qa.clone().multiply(qy), 0.45, 0.4, 0.45, 'detail', BIG, false);
				}
			}
		}
		return count;
	}

	// --- weeds ------------------------------------------------------------------------------

	private weed(x: number, z: number, scale: number): void
	{
		const y = this.ctx.data.heightAt(x, z) - 0.03;
		const v = this.rnd() < 0.55 ? 1 : 0;
		this.batch.add('weeds', v, x, y, z, this.rnd() * Math.PI * 2, scale, scale * (0.8 + this.rnd() * 0.6), scale, 'detail', BIG, false);
	}

	public weeds(): void
	{
		const data = this.ctx.data;
		const roads = this.hoodRoads();
		// along the kerbs
		for (let ri = 0; ri < roads.length; ri++)
		{
			const road = data.roads[roads[ri]];
			const total = road.pts[road.pts.length - 1].s;
			for (let s = 1; s < total - 1; s += 2.2 + this.rnd() * 1.5)
			{
				const p = roadAt(road, s);
				for (let side = -1; side <= 1; side += 2)
				{
					if (this.rnd() > 0.5) continue;
					const off = road.width / 2 + 0.2 + this.rnd() * 0.8;
					const x = p.x + p.nx * off * side + p.tx * (this.rnd() - 0.5), z = p.z + p.nz * off * side + p.tz * (this.rnd() - 0.5);
					if (!this.hoodAt(x, z, 0) || this.nearJunction(x, z, 1)) continue;
					if (data.roadClearance(x, z) < 0.1 || this.sp.buildingAt(x, z, 0.2) || !this.sp.clearOfObjects(x, z, 0.15) || this.sp.inDoorway(x, z, 0)) continue;
					this.weed(x, z, 0.8 + this.rnd() * 0.7);
				}
			}
		}
		// yards and along chain-link fence lines
		const hs = this.houses();
		for (let i = 0; i < hs.length; i++)
		{
			const b = hs[i];
			const n = b.kind === 'apartment' ? 14 : 8;
			for (let k = 0; k < n; k++)
			{
				const p = local(b, (this.rnd() - 0.5) * (b.w + 5), (this.rnd() < 0.6 ? 1 : -1) * (b.d / 2 + 0.5 + this.rnd() * 4));
				if (data.roadClearance(p[0], p[1]) < 0.5 || this.sp.buildingAt(p[0], p[1], 0.15) || !this.sp.clearOfObjects(p[0], p[1], 0.1) || this.sp.inDoorway(p[0], p[1], 0)) continue;
				this.weed(p[0], p[1], 0.9 + this.rnd() * 0.9);
			}
		}
		for (let i = 0; i < data.props.length; i++)
		{
			const pr = data.props[i];
			if (pr.type !== 'fence' || !this.hoodAt(pr.x, pr.z, 0)) continue;
			const len = pr.len || 3;
			const ux = Math.cos(pr.r), uz = -Math.sin(pr.r);
			for (let t = -len / 2 + 0.3; t < len / 2; t += 0.9)
			{
				if (this.rnd() < 0.45) continue;
				const side = this.rnd() < 0.5 ? 0.12 : -0.12;
				this.weed(pr.x + ux * t - uz * side, pr.z + uz * t + ux * side, 1.0 + this.rnd() * 0.8);
			}
		}
	}

	// --- fences and junk ------------------------------------------------------------------

	private fencePanel(x: number, z: number, ry: number): void
	{
		const r = this.rnd();
		const v = r < 0.4 ? 0 : (r < 0.75 ? 1 : 2);
		const y = this.ctx.data.heightAt(x, z) - 0.05;
		const tilt = this.rnd() < 0.22 ? (this.rnd() < 0.5 ? 1 : -1) * (0.12 + this.rnd() * 0.2) : 0;
		const q = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, ry).multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, tilt));
		this.batch.addQ('woodFence', v, x, y, z, q, 1, 1, 1, 'detail', BIG, true);
		const c = new THREE.Vector3(0, 0.9, 0).applyQuaternion(q);
		this.ctx.phys.box(x + c.x, y + c.y, z + c.z, 1.2, 0.9, 0.07, ry, tilt);
		this.colliders++;
		this.sp.addRect(x, z, 1.25, 0.3, ry);
	}

	private fenceRun(b: Building, keep: number[][], lx0: number, lz0: number, lx1: number, lz1: number): void
	{
		const a = local(b, lx0, lz0), c = local(b, lx1, lz1);
		const dx = c[0] - a[0], dz = c[1] - a[1];
		const L = Math.sqrt(dx * dx + dz * dz);
		const n = Math.floor(L / 2.4);
		if (n < 1) return;
		const ux = dx / L, uz = dz / L;
		const ry = yawX(ux, uz);
		const start = (L - n * 2.4) / 2;
		for (let k = 0; k < n; k++)
		{
			const t = start + (k + 0.5) * 2.4;
			const x = a[0] + ux * t, z = a[1] + uz * t;
			if (this.rnd() < 0.12) continue;   // panel gone
			let ok = true;
			for (let e = -1; e <= 1 && ok; e++)
			{
				const px = x + ux * e * 1.1, pz = z + uz * e * 1.1;
				if (!this.sp.free(px, pz, 0.15, 0.8, 0.15) || inKeepOut(b, keep, px, pz, 0.2)) ok = false;
			}
			if (ok) this.fencePanel(x, z, ry);
		}
	}

	/** Spot in front of / beside a house for junk. */
	private junkSpot(b: Building, r: number): number[]
	{
		const keep = houseKeepOut(b);
		for (let tries = 0; tries < 8; tries++)
		{
			const front = this.rnd() < 0.7;
			const lz = front ? b.d / 2 + 1.6 + this.rnd() * 4.5 : -b.d / 2 - 1.5 - this.rnd() * 3;
			const p = local(b, (this.rnd() - 0.5) * (b.w + 2), lz);
			if (!this.sp.free(p[0], p[1], r, 0.6, 0.3)) continue;
			if (b.kind === 'house' && inKeepOut(b, keep, p[0], p[1], r)) continue;
			return p;
		}
		return null;
	}

	public fencesAndJunk(): { fences: number; carts: number; couches: number; tires: number }
	{
		const data = this.ctx.data;
		const hs = this.houses();
		const before = this.batch.counts;
		const f0 = before.woodFence || 0;
		let carts = 0, couches = 0, tires = 0;
		for (let i = 0; i < hs.length; i++)
		{
			const b = hs[i];
			const hw = b.w / 2, hd = b.d / 2;
			if (b.kind === 'house' && b.w < 20)
			{
				const keep = houseKeepOut(b);
				for (let side = -1; side <= 1; side += 2) if (this.rnd() < 0.45) this.fenceRun(b, keep, side * (hw + 1.2), -hd - 2.6, side * (hw + 1.2), hd + 3.7);
				if (this.rnd() < 0.25) this.fenceRun(b, keep, -hw - 1.2, -hd - 2.7, hw + 1.2, -hd - 2.7);
			}
			// abandoned shopping cart
			if (this.rnd() < (b.kind === 'apartment' ? 0.9 : 0.28))
			{
				const p = this.junkSpot(b, 0.6);
				if (p)
				{
					const y = data.heightAt(p[0], p[1]) - 0.03, ry = this.rnd() * Math.PI * 2;
					const tipped = this.rnd() < 0.4;
					const q = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, ry);
					if (tipped) q.multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, Math.PI / 2 * (this.rnd() < 0.5 ? 1 : -1)));
					this.batch.addQ('shoppingCart', 0, p[0], y + (tipped ? 0.3 : 0), p[1], q, 1, 1, 1, 'detail', BIG, true);
					if (tipped) this.ctx.phys.box(p[0], y + 0.3, p[1], 0.5, 0.3, 0.5, ry);
					else this.ctx.phys.box(p[0], y + 0.5, p[1], 0.3, 0.5, 0.48, ry);
					this.colliders++;
					this.sp.addCircle(p[0], p[1], 0.7);
					carts++;
				}
			}
			// dumped couch
			if (this.rnd() < (b.kind === 'apartment' ? 0.7 : 0.16))
			{
				const p = this.junkSpot(b, 1.1);
				if (p)
				{
					const y = data.heightAt(p[0], p[1]) - 0.04, ry = b.rot + (this.rnd() - 0.5) * 1.2 + (this.rnd() < 0.3 ? Math.PI : 0);
					this.batch.add('couch', this.rnd() < 0.5 ? 0 : 1, p[0], y, p[1], ry, 1, 1, 1, 'detail', BIG, true);
					this.ctx.phys.box(p[0], y + 0.45, p[1], 1.0, 0.45, 0.46, ry);
					this.colliders++;
					this.sp.addRect(p[0], p[1], 1.2, 0.6, ry);
					couches++;
				}
			}
			// tyre pile
			if (this.rnd() < (b.kind === 'apartment' ? 0.5 : 0.18))
			{
				const p = this.junkSpot(b, 0.6);
				if (p)
				{
					const y = data.heightAt(p[0], p[1]) - 0.04, v = 1;
					this.batch.add('tirePile', v, p[0], y, p[1], this.rnd() * Math.PI * 2, 1, 1, 1, 'detail', BIG, true);
					this.ctx.phys.box(p[0], y + (v ? 0.48 : 0.36), p[1], 0.4, v ? 0.48 : 0.36, 0.4, 0);
					this.colliders++;
					this.sp.addCircle(p[0], p[1], 0.7);
					tires++;
				}
			}
		}
		return { fences: (this.batch.counts.woodFence || 0) - f0, carts: carts, couches: couches, tires: tires };
	}

	public finish(): void
	{
		this.buildWires();
	}
}

/** Dresses the gang neighbourhoods. Call after buildings/street props, before ctx.phys.commit(). */
export function buildHoodDetails(ctx: RealismCtx): { [k: string]: number }
{
	const city: any = ctx.cfg.city;
	if (!city || city.gangNeighborhoods === false || city.hoodDetails === false || !ctx.data.hoods || ctx.data.hoods.length === 0) return {};
	const sp = scatterSpace(ctx);
	const batch = new MatrixBatcher(ctx);
	batch.define('utilityPole', (v) => poleParts(ctx, v));
	batch.define('hangingShoes', (v) => shoesParts(ctx, v));
	batch.define('woodFence', (v) => fenceParts(ctx, v));
	batch.define('shoppingCart', () => cartParts(ctx));
	batch.define('couch', (v) => couchParts(ctx, v));
	batch.define('tirePile', (v) => tirePileParts(ctx, v));
	batch.define('weeds', (v) => weedParts(ctx, v));
	batch.define('roadDecal', (v) => decalParts(ctx, v), false);
	const d = new HoodDresser(ctx, sp, batch);
	d.polesAndLines();
	const junk = d.fencesAndJunk();
	const decals = d.roadWear();
	d.weeds();
	d.finish();
	batch.build();
	const out: { [k: string]: number } = {
		poles: d.poles.length, spans: d.spans, serviceDrops: d.drops, shoes: batch.counts.hangingShoes || 0,
		fencePanels: junk.fences, carts: junk.carts, couches: junk.couches, tirePiles: junk.tires,
		roadDecals: decals, weeds: batch.counts.weeds || 0, colliders: d.colliders,
		instancedMeshes: batch.meshCount, wireMeshes: d.wireMeshes, instances: batch.instanceCount,
	};
	console.log('[Realism] Neighbourhood details', out);
	return out;
}
