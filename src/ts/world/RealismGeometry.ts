/*
 * RealismGeometry.ts
 * ------------------
 * Small geometry kit used by the San Verano builders: a vertex-coloured mesh
 * accumulator, a local coordinate frame (position + yaw) and helpers for boxes,
 * cylinders and walls with openings. Everything ends up merged into a handful
 * of BufferGeometries so thousands of objects cost a few draw calls.
 */

import * as THREE from 'three';

export class GeoAccum
{
	public pos: number[] = [];
	public nor: number[] = [];
	public uv: number[] = [];
	public col: number[] = [];
	public idx: number[] = [];
	public count: number = 0;

	public vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: number[]): number
	{
		this.pos.push(x, y, z);
		this.nor.push(nx, ny, nz);
		this.uv.push(u, v);
		this.col.push(c[0], c[1], c[2]);
		return this.count++;
	}

	/** Adds a flat polygon (3 or 4 points), fixing the winding so it faces `n`. */
	public face(p: number[][], n: number[], uvs: number[][], c: number[]): void
	{
		const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = p[1][2] - p[0][2];
		const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = p[2][2] - p[0][2];
		const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
		const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
		const ids: number[] = [];
		for (let i = 0; i < p.length; i++) ids.push(this.vert(p[i][0], p[i][1], p[i][2], n[0], n[1], n[2], uvs[i][0], uvs[i][1], c));
		if (p.length === 3)
		{
			if (flip) this.idx.push(ids[0], ids[2], ids[1]); else this.idx.push(ids[0], ids[1], ids[2]);
		}
		else
		{
			if (flip) this.idx.push(ids[0], ids[2], ids[1], ids[0], ids[3], ids[2]);
			else this.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
		}
	}

	public get empty(): boolean { return this.count === 0; }

	public toGeometry(): THREE.BufferGeometry
	{
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
		// compact attributes: normals as 8-bit signed, colours as 8-bit (a quarter of the memory of floats)
		const nor = new Int8Array(this.nor.length);
		for (let i = 0; i < nor.length; i++) nor[i] = Math.max(-127, Math.min(127, Math.round(this.nor[i] * 127)));
		g.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
		g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
		const col = new Uint8Array(this.col.length);
		for (let i = 0; i < col.length; i++) col[i] = Math.max(0, Math.min(255, Math.round(this.col[i] * 255)));
		g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
		if (this.count > 65535) g.setIndex(new THREE.Uint32BufferAttribute(this.idx, 1));
		else g.setIndex(new THREE.Uint16BufferAttribute(this.idx, 1));
		g.computeBoundingSphere();
		return g;
	}
}

export class AccumSet
{
	private map: { [key: string]: GeoAccum } = {};
	public keys: string[] = [];

	public get(key: string): GeoAccum
	{
		let a = this.map[key];
		if (a === undefined)
		{
			a = new GeoAccum();
			this.map[key] = a;
			this.keys.push(key);
		}
		return a;
	}
}

const ZUV = [[0, 0], [0, 0], [0, 0], [0, 0]];

/** A local frame: origin + yaw. Local +Z is "front", +X is "right when looking at the front from outside"... */
export class Frame
{
	public x: number; public y: number; public z: number; public rot: number;
	private c: number; private s: number;

	constructor(x: number, y: number, z: number, rot: number)
	{
		this.x = x; this.y = y; this.z = z; this.rot = rot;
		this.c = Math.cos(rot); this.s = Math.sin(rot);
	}

	public p(lx: number, ly: number, lz: number): number[]
	{
		return [this.x + lx * this.c + lz * this.s, this.y + ly, this.z - lx * this.s + lz * this.c];
	}

	public n(nx: number, ny: number, nz: number): number[]
	{
		return [nx * this.c + nz * this.s, ny, -nx * this.s + nz * this.c];
	}

	/** A child frame at local (lx, ly, lz) turned by `rot` more. */
	public sub(lx: number, ly: number, lz: number, rot: number): Frame
	{
		const w = this.p(lx, ly, lz);
		return new Frame(w[0], w[1], w[2], this.rot + rot);
	}
}

/**
 * Axis-aligned (in the frame) box from (x0,y0,z0) to (x1,y1,z1).
 * `skip` is a string of faces to leave out: 't' top, 'b' bottom, 'f' front(+z), 'k' back(-z), 'r' +x, 'l' -x.
 * `uvScale` > 0 gives world-scaled UVs (for textured materials), otherwise UVs are 0.
 */
export function box(acc: GeoAccum, f: Frame, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number[], skip?: string, uvScale?: number): void
{
	const sk = skip || '';
	const u = uvScale || 0;
	const uvq = (a: number, b: number, cc: number, d: number) => u > 0 ? [[a * u, cc * u], [b * u, cc * u], [b * u, d * u], [a * u, d * u]] : ZUV;
	if (sk.indexOf('f') < 0) acc.face([f.p(x0, y0, z1), f.p(x1, y0, z1), f.p(x1, y1, z1), f.p(x0, y1, z1)], f.n(0, 0, 1), uvq(x0, x1, y0, y1), c);
	if (sk.indexOf('k') < 0) acc.face([f.p(x1, y0, z0), f.p(x0, y0, z0), f.p(x0, y1, z0), f.p(x1, y1, z0)], f.n(0, 0, -1), uvq(-x1, -x0, y0, y1), c);
	if (sk.indexOf('r') < 0) acc.face([f.p(x1, y0, z1), f.p(x1, y0, z0), f.p(x1, y1, z0), f.p(x1, y1, z1)], f.n(1, 0, 0), uvq(-z1, -z0, y0, y1), c);
	if (sk.indexOf('l') < 0) acc.face([f.p(x0, y0, z0), f.p(x0, y0, z1), f.p(x0, y1, z1), f.p(x0, y1, z0)], f.n(-1, 0, 0), uvq(z0, z1, y0, y1), c);
	const shade = [c[0] * 1.04, c[1] * 1.04, c[2] * 1.04];
	if (sk.indexOf('t') < 0) acc.face([f.p(x0, y1, z0), f.p(x1, y1, z0), f.p(x1, y1, z1), f.p(x0, y1, z1)], [0, 1, 0], uvq(x0, x1, z0, z1), shade);
	if (sk.indexOf('b') < 0) acc.face([f.p(x0, y0, z1), f.p(x1, y0, z1), f.p(x1, y0, z0), f.p(x0, y0, z0)], [0, -1, 0], uvq(x0, x1, z0, z1), c);
}

/** Box by centre and size, convenience for furniture. */
export function boxC(acc: GeoAccum, f: Frame, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, c: number[], skip?: string): void
{
	box(acc, f, cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2, c, skip);
}

/** Vertical cylinder / cone in a frame. */
export function cyl(acc: GeoAccum, f: Frame, cx: number, y0: number, cz: number, h: number, r0: number, r1: number, seg: number, c: number[], caps?: boolean): void
{
	for (let i = 0; i < seg; i++)
	{
		const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
		const slope = Math.atan2(r0 - r1, h);
		const n = f.n(Math.cos(am) * Math.cos(slope), Math.sin(slope), Math.sin(am) * Math.cos(slope));
		if (r1 > 0.0005)
			acc.face([f.p(cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0), f.p(cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0), f.p(cx + Math.cos(a1) * r1, y0 + h, cz + Math.sin(a1) * r1), f.p(cx + Math.cos(a0) * r1, y0 + h, cz + Math.sin(a0) * r1)], n, ZUV, c);
		else
			acc.face([f.p(cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0), f.p(cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0), f.p(cx, y0 + h, cz)], n, ZUV, c);
		if (caps && r1 > 0.0005)
			acc.face([f.p(cx, y0 + h, cz), f.p(cx + Math.cos(a1) * r1, y0 + h, cz + Math.sin(a1) * r1), f.p(cx + Math.cos(a0) * r1, y0 + h, cz + Math.sin(a0) * r1)], [0, 1, 0], ZUV, c);
	}
}

/** Horizontal cylinder along local X (pipes, rails, logs). */
export function cylX(acc: GeoAccum, f: Frame, x0: number, x1: number, cy: number, cz: number, r: number, seg: number, c: number[]): void
{
	for (let i = 0; i < seg; i++)
	{
		const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
		acc.face([f.p(x0, cy + Math.cos(a0) * r, cz + Math.sin(a0) * r), f.p(x1, cy + Math.cos(a0) * r, cz + Math.sin(a0) * r), f.p(x1, cy + Math.cos(a1) * r, cz + Math.sin(a1) * r), f.p(x0, cy + Math.cos(a1) * r, cz + Math.sin(a1) * r)],
			f.n(0, Math.cos(am), Math.sin(am)), ZUV, c);
	}
}

/** Horizontal cylinder along local Z. */
export function cylZ(acc: GeoAccum, f: Frame, z0: number, z1: number, cx: number, cy: number, r: number, seg: number, c: number[]): void
{
	for (let i = 0; i < seg; i++)
	{
		const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
		acc.face([f.p(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z0), f.p(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z1), f.p(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z1), f.p(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z0)],
			f.n(Math.cos(am), Math.sin(am), 0), ZUV, c);
	}
}

/** A flat quad lying on top of something (decals, markings), facing up. */
export function flatQuad(acc: GeoAccum, f: Frame, x0: number, z0: number, x1: number, z1: number, y: number, c: number[]): void
{
	acc.face([f.p(x0, y, z0), f.p(x1, y, z0), f.p(x1, y, z1), f.p(x0, y, z1)], [0, 1, 0], ZUV, c);
}

export interface Opening { u0: number; u1: number; v0: number; v1: number; }

/**
 * Splits a rectangle [0,len] x [0,h] around openings into solid pieces (u0,u1,v0,v1).
 * Used for walls with doors (both the visible faces and the physics boxes).
 */
export function wallPieces(len: number, h: number, openings: Opening[]): Opening[]
{
	const us = [0, len], vs = [0, h];
	for (let i = 0; i < openings.length; i++)
	{
		const o = openings[i];
		us.push(Math.max(0, Math.min(len, o.u0)), Math.max(0, Math.min(len, o.u1)));
		vs.push(Math.max(0, Math.min(h, o.v0)), Math.max(0, Math.min(h, o.v1)));
	}
	const su = us.sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1] > 1e-4);
	const sv = vs.sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1] > 1e-4);
	// cells
	const solid: boolean[][] = [];
	for (let i = 0; i < su.length - 1; i++)
	{
		solid.push([]);
		for (let j = 0; j < sv.length - 1; j++)
		{
			const cu = (su[i] + su[i + 1]) / 2, cv = (sv[j] + sv[j + 1]) / 2;
			let open = false;
			for (let k = 0; k < openings.length; k++)
			{
				const o = openings[k];
				if (cu > o.u0 && cu < o.u1 && cv > o.v0 && cv < o.v1) { open = true; break; }
			}
			solid[i].push(!open);
		}
	}
	// merge vertically per column, then horizontally where identical
	const cols: Opening[][] = [];
	for (let i = 0; i < su.length - 1; i++)
	{
		const list: Opening[] = [];
		let j = 0;
		while (j < sv.length - 1)
		{
			if (!solid[i][j]) { j++; continue; }
			let k = j;
			while (k + 1 < sv.length - 1 && solid[i][k + 1]) k++;
			list.push({ u0: su[i], u1: su[i + 1], v0: sv[j], v1: sv[k + 1] });
			j = k + 1;
		}
		cols.push(list);
	}
	const out: Opening[] = [];
	for (let i = 0; i < cols.length; i++)
	{
		for (let n = 0; n < cols[i].length; n++)
		{
			const p = cols[i][n];
			if (p.u0 < 0) continue;   // already merged
			let u1 = p.u1;
			for (let i2 = i + 1; i2 < cols.length; i2++)
			{
				let found = -1;
				for (let m = 0; m < cols[i2].length; m++) if (Math.abs(cols[i2][m].v0 - p.v0) < 1e-4 && Math.abs(cols[i2][m].v1 - p.v1) < 1e-4 && cols[i2][m].u0 >= 0) { found = m; break; }
				if (found < 0) break;
				u1 = cols[i2][found].u1;
				cols[i2][found].u0 = -1;
			}
			out.push({ u0: p.u0, u1: u1, v0: p.v0, v1: p.v1 });
		}
	}
	return out;
}

/** Simple string hash -> 0..1 (deterministic per building). */
export function hash01(n: number): number
{
	let x = (n | 0) ^ 0x9e3779b9;
	x = Math.imul ? Math.imul(x ^ (x >>> 16), 0x85ebca6b) : ((x ^ (x >>> 16)) * 0x85ebca6b) | 0;
	x = Math.imul ? Math.imul(x ^ (x >>> 13), 0xc2b2ae35) : ((x ^ (x >>> 13)) * 0xc2b2ae35) | 0;
	x ^= x >>> 16;
	return (x >>> 0) / 4294967296;
}

export function seeded(seed: number): () => number
{
	let a = (seed | 0) + 0x6d2b79f5;
	return () =>
	{
		a = (a + 0x6d2b79f5) | 0;
		let t = a ^ (a >>> 15);
		t = (t * (1 | a)) | 0;   // approximate imul, deterministic enough for decoration
		t = (t + ((t ^ (t >>> 7)) * (61 | t))) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
