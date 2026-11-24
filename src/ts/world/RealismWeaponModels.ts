/*
 * RealismWeaponModels.ts
 * ----------------------
 * Built-in low-poly weapon models (one merged, vertex-coloured mesh per weapon, 150..400 triangles)
 * and loading of your own .glb weapon models.
 *
 * Weapon space (built-in models and the convention for your .glb):
 *   origin = where the hand grips, +Z = barrel direction (forward), +Y = up, units = metres (real size).
 *   Your model can be fixed with scale / rotation (degrees) / offset in realism-config.js, and
 *   `muzzle: [x, y, z]` says where the barrel ends (in weapon space, after scale / rotation / offset).
 */

import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
import { loadGLB, bakeParts, overrideMatrix } from './RealismAssets';

const DEG = Math.PI / 180;

class Builder
{
	public pos: number[] = [];
	public nor: number[] = [];
	public col: number[] = [];

	private push(p: THREE.Vector3, n: THREE.Vector3, c: number[]): void
	{
		this.pos.push(p.x, p.y, p.z);
		this.nor.push(n.x, n.y, n.z);
		this.col.push(c[0], c[1], c[2]);
	}

	private quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3, col: number[]): void
	{
		this.push(a, n, col); this.push(b, n, col); this.push(c, n, col);
		this.push(a, n, col); this.push(c, n, col); this.push(d, n, col);
	}

	/** Axis-aligned box centred at (cx, cy, cz), size (sx, sy, sz), optionally tilted about X by `rx` degrees. */
	public box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, col: number[], rx: number = 0): void
	{
		const m = new THREE.Matrix4().makeRotationX(rx * DEG).setPosition(cx, cy, cz);
		const nm = new THREE.Matrix3().getNormalMatrix(m);
		const hx = sx / 2, hy = sy / 2, hz = sz / 2;
		const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
		const N = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix3(nm).normalize();
		const shade = (k: number) => [col[0] * k, col[1] * k, col[2] * k];
		this.quad(P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(hx, hy, hz), N(1, 0, 0), col);
		this.quad(P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz), N(-1, 0, 0), col);
		this.quad(P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz), N(0, 1, 0), shade(1.08));
		this.quad(P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz), N(0, -1, 0), shade(0.8));
		this.quad(P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz), N(0, 0, 1), col);
		this.quad(P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz), N(0, 0, -1), col);
	}

	/** Cylinder along Z, centred at (cx, cy, cz). */
	public cyl(cx: number, cy: number, cz: number, r: number, len: number, col: number[], seg: number = 8): void
	{
		const z0 = cz - len / 2, z1 = cz + len / 2;
		const fz = new THREE.Vector3(0, 0, 1), bz = new THREE.Vector3(0, 0, -1);
		const c0 = new THREE.Vector3(cx, cy, z0), c1 = new THREE.Vector3(cx, cy, z1);
		for (let i = 0; i < seg; i++)
		{
			const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
			const x0 = Math.cos(a0) * r, y0 = Math.sin(a0) * r, x1 = Math.cos(a1) * r, y1 = Math.sin(a1) * r;
			const n0 = new THREE.Vector3(Math.cos(a0), Math.sin(a0), 0), n1 = new THREE.Vector3(Math.cos(a1), Math.sin(a1), 0);
			const p00 = new THREE.Vector3(cx + x0, cy + y0, z0), p10 = new THREE.Vector3(cx + x1, cy + y1, z0);
			const p01 = new THREE.Vector3(cx + x0, cy + y0, z1), p11 = new THREE.Vector3(cx + x1, cy + y1, z1);
			this.push(p00, n0, col); this.push(p10, n1, col); this.push(p11, n1, col);
			this.push(p00, n0, col); this.push(p11, n1, col); this.push(p01, n0, col);
			this.push(c1, fz, col); this.push(p01, fz, col); this.push(p11, fz, col);
			this.push(c0, bz, col); this.push(p10, bz, col); this.push(p00, bz, col);
		}
	}

	public geometry(): THREE.BufferGeometry
	{
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
		g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
		g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
		g.computeBoundingSphere();
		return g;
	}
}

const BLACK = [0.07, 0.07, 0.08];
const STEEL = [0.2, 0.21, 0.23];
const DARK = [0.12, 0.12, 0.13];
const WOOD = [0.42, 0.24, 0.12];
const POLY = [0.16, 0.15, 0.13];
const TAN = [0.55, 0.47, 0.33];

export interface WeaponModelInfo
{
	muzzle: THREE.Vector3;     // barrel end, weapon space (metres)
	support: number;           // distance forward of the grip where the other hand holds, metres
	length: number;
	sight?: THREE.Vector3;     // rear sight / eye line point, weapon space (first person aiming lines this up with the screen centre)
}

/** Builds the built-in model for a weapon kind. */
export function buildWeaponGeometry(kind: string): { geom: THREE.BufferGeometry; info: WeaponModelInfo }
{
	const b = new Builder();
	let muzzle = new THREE.Vector3(0, 0.05, 0.2), support = 0.02, length = 0.22;
	let sight = new THREE.Vector3(0, 0.075, 0);
	if (kind === 'pistol')
	{
		b.box(0, 0.055, 0.055, 0.03, 0.032, 0.2, STEEL);           // slide
		b.box(0, 0.03, 0.045, 0.027, 0.022, 0.17, BLACK);          // frame
		b.box(0, -0.035, -0.005, 0.029, 0.11, 0.042, POLY, -12);   // grip
		b.box(0, 0.005, 0.045, 0.006, 0.026, 0.05, BLACK);         // trigger guard (bar)
		b.box(0, 0.074, 0.145, 0.006, 0.008, 0.008, BLACK);        // front sight
		b.box(0, 0.074, -0.035, 0.018, 0.008, 0.008, BLACK);       // rear sight
		b.cyl(0, 0.055, 0.158, 0.007, 0.01, DARK, 6);              // barrel tip
		muzzle = new THREE.Vector3(0, 0.055, 0.165); support = 0.0; length = 0.22;
		sight.set(0, 0.078, -0.035);   // top of the rear notch, front post at the same height
	}
	else if (kind === 'smg')
	{
		b.box(0, 0.05, 0.08, 0.04, 0.055, 0.26, BLACK);            // receiver
		b.cyl(0, 0.055, 0.25, 0.011, 0.09, STEEL, 8);              // barrel
		b.box(0, -0.035, 0.0, 0.032, 0.1, 0.042, POLY, -10);       // grip
		b.box(0, -0.06, 0.1, 0.026, 0.15, 0.035, DARK, 8);         // magazine
		b.box(0, 0.06, -0.13, 0.012, 0.012, 0.18, STEEL);          // wire stock top
		b.box(0, 0.01, -0.13, 0.012, 0.012, 0.18, STEEL);          // wire stock bottom
		b.box(0, 0.035, -0.22, 0.03, 0.07, 0.015, BLACK);          // butt plate
		b.box(0, 0.088, 0.04, 0.012, 0.02, 0.05, BLACK);           // sight
		b.box(0, 0.003, 0.15, 0.03, 0.03, 0.06, POLY);             // fore grip
		muzzle = new THREE.Vector3(0, 0.055, 0.3); support = 0.15; length = 0.5;
		sight.set(0, 0.098, 0.015);
	}
	else if (kind === 'shotgun')
	{
		b.cyl(0, 0.065, 0.32, 0.013, 0.56, STEEL, 8);              // barrel
		b.cyl(0, 0.035, 0.26, 0.011, 0.44, DARK, 8);               // magazine tube
		b.cyl(0, 0.035, 0.3, 0.02, 0.16, WOOD, 8);                 // pump
		b.box(0, 0.05, 0.02, 0.042, 0.065, 0.16, BLACK);           // receiver
		b.box(0, -0.03, -0.07, 0.034, 0.1, 0.045, WOOD, -25);      // grip / wrist
		b.box(0, -0.01, -0.25, 0.04, 0.09, 0.3, WOOD, -6);         // stock
		b.box(0, 0.003, 0.02, 0.006, 0.025, 0.04, BLACK);          // trigger guard
		b.box(0, 0.082, 0.59, 0.005, 0.008, 0.008, [0.8, 0.8, 0.8]); // bead
		muzzle = new THREE.Vector3(0, 0.065, 0.6); support = 0.3; length = 0.95;
		sight.set(0, 0.086, 0.06);     // along the rib to the bead
	}
	else if (kind === 'rifle')
	{
		b.box(0, 0.05, 0.04, 0.038, 0.06, 0.24, BLACK);            // receiver
		b.box(0, 0.05, 0.27, 0.046, 0.05, 0.22, DARK);             // handguard
		b.cyl(0, 0.055, 0.46, 0.009, 0.18, STEEL, 8);              // barrel
		b.cyl(0, 0.055, 0.565, 0.014, 0.035, BLACK, 8);            // flash hider
		b.box(0, 0.1, 0.0, 0.02, 0.035, 0.12, BLACK);              // carry handle / optic base
		b.box(0, 0.1, 0.36, 0.008, 0.05, 0.012, BLACK);            // front sight post
		b.box(0, -0.06, 0.08, 0.03, 0.15, 0.05, TAN, 14);          // magazine (curved look)
		b.box(0, -0.035, -0.05, 0.03, 0.09, 0.04, POLY, -18);      // grip
		b.box(0, 0.04, -0.2, 0.03, 0.025, 0.2, BLACK);             // buffer tube
		b.box(0, 0.02, -0.3, 0.038, 0.08, 0.12, POLY);             // stock
		b.box(0, 0.003, 0.01, 0.006, 0.022, 0.05, BLACK);          // trigger guard
		muzzle = new THREE.Vector3(0, 0.055, 0.585); support = 0.27; length = 0.92;
		sight.set(0, 0.118, -0.05);    // rear aperture on the carry handle, front post top at 0.125
	}
	else
	{
		// unknown kind: generic pistol-like block
		b.box(0, 0.05, 0.06, 0.03, 0.04, 0.2, BLACK);
		b.box(0, -0.03, 0, 0.03, 0.1, 0.04, POLY, -12);
	}
	return { geom: b.geometry(), info: { muzzle: muzzle, support: support, length: length, sight: sight } };
}

let sharedMat: THREE.Material = null;

/** One vertex-coloured material shared by every built-in weapon (plain meshes only). */
export function weaponMaterial(ctx: RealismCtx): THREE.Material
{
	if (sharedMat !== null) return sharedMat;
	const VC: any = (THREE as any).VertexColors !== undefined ? (THREE as any).VertexColors : true;
	const params: any = { vertexColors: VC };
	sharedMat = ctx && ctx.preset && ctx.preset.lighting === 'phong'
		? new THREE.MeshPhongMaterial(Object.assign({ shininess: 40, specular: 0x333333 }, params))
		: new THREE.MeshLambertMaterial(params);
	try { (ctx.world as any).sky.csm.setupMaterial(sharedMat); } catch (e) { /* no CSM */ }
	return sharedMat;
}

/**
 * Loads your .glb into `target` (a Group in weapon space). The built-in model stays until it loads,
 * and stays for good if it fails. `done` runs after the swap.
 */
export function loadWeaponModel(ctx: RealismCtx, ov: any, target: THREE.Group, builtIn: THREE.Object3D, done?: () => void): void
{
	if (!ov || !ov.model) return;
	loadGLB(ov.model, (scene) =>
	{
		try
		{
			const parts = bakeParts(ctx, scene, overrideMatrix({ scale: ov.scale, rotation: ov.rotation, offset: ov.offset }), false);
			if (parts.length === 0) return;
			const g = new THREE.Group();
			for (let i = 0; i < parts.length; i++)
			{
				const m = new THREE.Mesh(parts[i].geom, parts[i].mat);
				m.castShadow = false; m.receiveShadow = false;
				g.add(m);
			}
			target.remove(builtIn);
			target.add(g);
			if (done) done();
		}
		catch (e) { console.warn('[Realism] Weapon model "' + ov.model + '" could not be used, keeping the built-in model.', e); }
	}, () => { /* keep the built-in model; loadGLB already warned */ });
}

/** Soft round flash texture (made once). */
let flashTex: THREE.Texture = null;
export function flashTexture(): THREE.Texture
{
	if (flashTex !== null) return flashTex;
	let canvas: any = null;
	try
	{
		canvas = document.createElement('canvas');
		canvas.width = 64; canvas.height = 64;
		const c = canvas.getContext('2d');
		const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
		g.addColorStop(0, 'rgba(255,255,235,1)');
		g.addColorStop(0.25, 'rgba(255,220,120,0.9)');
		g.addColorStop(0.6, 'rgba(255,140,30,0.35)');
		g.addColorStop(1, 'rgba(255,100,0,0)');
		c.fillStyle = g;
		c.fillRect(0, 0, 64, 64);
	}
	catch (e) { canvas = null; }
	flashTex = canvas ? new THREE.CanvasTexture(canvas) : new THREE.Texture();
	return flashTex;
}

/** Muzzle flash: a star of 3 additive quads (6 triangles), barrel along +Z. */
export function buildMuzzleFlash(): THREE.Mesh
{
	const pos: number[] = [], uv: number[] = [];
	const quad = (a: number[], b: number[], c: number[], d: number[]) =>
	{
		pos.push(...a, ...b, ...c, ...a, ...c, ...d);
		uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
	};
	const w = 0.5, L = 1.6;
	quad([-w, 0, 0], [w, 0, 0], [w, 0, L], [-w, 0, L]);        // horizontal blade
	quad([0, -w, 0], [0, w, 0], [0, w, L], [0, -w, L]);        // vertical blade
	quad([-0.7, -0.7, 0.05], [0.7, -0.7, 0.05], [0.7, 0.7, 0.05], [-0.7, 0.7, 0.05]);   // front disc
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
	g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
	g.computeBoundingSphere();
	const m = new THREE.MeshBasicMaterial({
		map: flashTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
		side: THREE.DoubleSide, color: 0xffd9a0, fog: false,
	});
	const mesh = new THREE.Mesh(g, m);
	mesh.renderOrder = 10;
	mesh.visible = false;
	mesh.frustumCulled = false;
	return mesh;
}
