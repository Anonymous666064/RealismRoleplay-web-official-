/**
 * Car lights for every car: headlights, tail lights, brake lights, reverse lights, turn signals
 * and hazards.
 *
 *  - Lens geometry: small quads on the car.glb body (front / rear faces, measured from the body
 *    vertices, not guessed). Parts: 0 left head, 1 right head, 2 tail/brake, 3 reverse,
 *    4 left indicators (front + rear), 5 right indicators. Left = +x (the driver side of car.glb).
 *  - Instanced cars (traffic, parked NPC cars): one InstancedMesh of lenses + one InstancedMesh of
 *    additive glow (halos and a headlight pool on the road), both with a per-instance state
 *    attribute `lstate` (vec3: head 0..1, tail/brake 0 / 0.35 / 1, packed bits reverse 4 + left 1 +
 *    right 2). No real lights. Two draw calls for all traffic.
 *  - Real Sketchbook cars (player, police, pooled parked cars, carjacked cars): the same geometry
 *    as one plain lens Mesh + one glow Mesh per car, with per-car uniforms. The player's car also
 *    drives one pooled SpotLight (medium+ presets, night, headlights on). The SpotLight stays in
 *    the scene with intensity 0 when off, so the light count never changes (no shader recompile).
 *  - Night: realismPerformance.isNight() (set by RealismDayNight), else the sun elevation.
 *  - Player keys (in a car, not UI-blocked): O headlights Auto / On / Off, Comma left signal,
 *    Period right signal, Slash hazards. Signals cancel themselves after the turn.
 *  - Police: in ELS stage 2-3 the headlights wig-wag left / right with the ELS phase.
 *
 * Shared: (world as any).realismCarLights = { mode, setMode(m), signal(car, -1|0|1), hazards(car, on),
 *   stateOf(car), night, stats, layout }.
 * Config: carLights { enabled, playerSpot, spotIntensity, spotDistance, glow, keys }.
 */
import * as THREE from 'three';
import { RealismCtx } from './RealismContext';

export interface LampLayout
{
	headX: number; headY: number; headZ: number; headW: number; headH: number;
	tailX: number; tailY: number; tailZ: number; tailW: number; tailH: number;
	sigX: number; halfW: number; groundY: number;
	frontZ: number; rearZ: number;
}

export interface CarLightSettings
{
	enabled: boolean;
	playerSpot: boolean;
	spotIntensity: number;
	spotDistance: number;
	glow: boolean;
	keyHead: string; keyLeft: string; keyRight: string; keyHazard: string;
}

export function carLightSettings(ctx: RealismCtx): CarLightSettings
{
	const w: any = typeof window !== 'undefined' ? window : {};
	const raw: any = (ctx.cfg as any).carLights || (w.REALISM_CONFIG && w.REALISM_CONFIG.carLights) || {};
	const num = (v: any, d: number, a: number, b: number) => (typeof v === 'number' && isFinite(v) ? Math.max(a, Math.min(b, v)) : d);
	const k: any = raw.keys || {};
	const low = ctx.presetName === 'low';
	return {
		enabled: raw.enabled !== false,
		playerSpot: raw.playerSpot === undefined ? !low : (raw.playerSpot === true && !low),
		spotIntensity: num(raw.spotIntensity, 1.6, 0, 10),
		spotDistance: num(raw.spotDistance, 45, 5, 200),
		glow: raw.glow !== false,
		keyHead: typeof k.headlights === 'string' ? k.headlights : 'KeyO',
		keyLeft: typeof k.left === 'string' ? k.left : 'Comma',
		keyRight: typeof k.right === 'string' ? k.right : 'Period',
		keyHazard: typeof k.hazards === 'string' ? k.hazards : 'Slash',
	};
}

/** Night as the rest of the game sees it (RealismDayNight -> RealismPerformance). */
export function isNightNow(world: any): boolean
{
	const perf = world && world.realismPerformance;
	if (perf && typeof perf.isNight === 'function') { try { return !!perf.isNight(); } catch (e) { /* fall through */ } }
	const t = world && world.realismTime;
	if (t && typeof t.hour === 'number') return t.hour < 6.6 || t.hour > 19.4;
	const e = world && world.params ? world.params.Sun_Elevation : 60;
	return e < 12 || e > 168;
}

/** Blink phase shared by every indicator (1.4 Hz). */
export function blinkOn(clock: number): boolean { return (clock % 0.72) < 0.38; }

/** Packs the reverse / left / right bits of the state attribute. */
export function packBits(reverse: boolean, left: boolean, right: boolean): number
{
	return (reverse ? 4 : 0) + (left ? 1 : 0) + (right ? 2 : 0);
}

// ------------------------------------------------------------------------------ layout

/**
 * Measures lamp positions on a car body geometry (car space, +z forward): the front / rear face
 * depth is probed at the lamp height and width, so the lenses sit on the paint.
 */
export function measureLamps(body: THREE.BufferGeometry, wheels?: THREE.BufferGeometry): LampLayout
{
	if (!body.boundingBox) body.computeBoundingBox();
	const bb = body.boundingBox;
	const pos = body.getAttribute('position') as THREE.BufferAttribute;
	const halfW = Math.max(0.3, Math.min(-bb.min.x, bb.max.x));
	const H = bb.max.y - bb.min.y;
	const headY = bb.min.y + H * 0.27, tailY = bb.min.y + H * 0.31;
	const headX = halfW * 0.67, tailX = halfW * 0.72;
	// a ray along z through (x, y): the front-most / rear-most triangle it hits (car.glb uses
	// big low-poly faces, so vertices alone don't tell where a face is)
	const idx = body.index;
	const triCount = idx ? idx.count / 3 : pos.count / 3;
	const probe = (x: number, y: number, front: boolean): number =>
	{
		let best = front ? -1e9 : 1e9, found = false;
		for (let t = 0; t < triCount; t++)
		{
			const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
			const ax = pos.getX(i0), ay = pos.getY(i0), bx = pos.getX(i1), by = pos.getY(i1), cx = pos.getX(i2), cy = pos.getY(i2);
			const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
			if (Math.abs(d) < 1e-9) continue;
			const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
			const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
			if (u < -1e-4 || v < -1e-4 || u + v > 1 + 1e-4) continue;
			const z = u * pos.getZ(i0) + v * pos.getZ(i1) + (1 - u - v) * pos.getZ(i2);
			if (front ? z > best : z < best) { best = z; found = true; }
		}
		return found ? best : (front ? bb.max.z : bb.min.z);
	};
	const headW = halfW * 0.34, headH = H * 0.085, tailW = halfW * 0.3, tailH = H * 0.08;
	// the outermost face point under the whole lens (faces can slant), so no lens corner sinks in
	const outer = (x: number, y: number, w: number, h: number, front: boolean): number =>
	{
		let z = probe(x, y, front);
		const xs = [x - w / 2, x + w / 2], ys = [y - h / 2, y + h / 2];
		for (let i = 0; i < 2; i++) for (let k = 0; k < 2; k++) { const q = probe(xs[i], ys[k], front); z = front ? Math.max(z, q) : Math.min(z, q); }
		return z;
	};
	const headZ = outer(headX, headY, headW, headH, true), tailZ = outer(tailX, tailY, tailW, tailH, false);
	let groundY = bb.min.y - 0.2;
	if (wheels)
	{
		if (!wheels.boundingBox) wheels.computeBoundingBox();
		groundY = wheels.boundingBox.min.y;
	}
	return {
		headX: headX, headY: headY, headZ: headZ, headW: headW, headH: headH,
		tailX: tailX, tailY: tailY, tailZ: tailZ, tailW: tailW, tailH: tailH,
		sigX: halfW * 0.9, halfW: halfW, groundY: groundY,
		frontZ: bb.max.z, rearZ: bb.min.z,
	};
}

// ------------------------------------------------------------------------------ geometry

class Quads
{
	public pos: number[] = []; public part: number[] = []; public corner: number[] = []; public dir: number[] = []; public size: number[] = [];
	public idx: number[] = [];
	private n = 0;
	/** Lens quad facing +z (dirZ 1) or -z (-1), centred on cx, cy, cz. */
	public lens(cx: number, cy: number, cz: number, w: number, h: number, dirZ: number, part: number): void
	{
		const b = this.n;
		const xs = [-w / 2, w / 2, w / 2, -w / 2], ys = [-h / 2, -h / 2, h / 2, h / 2];
		for (let i = 0; i < 4; i++)
		{
			this.pos.push(cx + xs[i] * dirZ, cy + ys[i], cz);
			this.part.push(part); this.corner.push(0, 0); this.dir.push(dirZ); this.size.push(0);
		}
		this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
		this.n += 4;
	}
	/** Camera-facing halo (expanded in the vertex shader). */
	public halo(cx: number, cy: number, cz: number, size: number, dirZ: number, part: number): void
	{
		const b = this.n;
		const cs = [-1, -1, 1, -1, 1, 1, -1, 1];
		for (let i = 0; i < 4; i++)
		{
			this.pos.push(cx, cy, cz);
			this.part.push(part); this.corner.push(cs[i * 2], cs[i * 2 + 1]); this.dir.push(dirZ); this.size.push(size);
		}
		this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
		this.n += 4;
	}
	/** Headlight pool on the road: a flat trapezoid ahead of the car (part 6). corner = (across -1..1, along 0..1). */
	public pool(L: LampLayout): void
	{
		const b = this.n;
		const y = L.groundY + 0.06, z0 = L.frontZ + 0.2, z1 = L.frontZ + 11;
		const w0 = L.halfW * 1.1, w1 = 3.4;
		const P = [[-w0, z0, -1, 0], [w0, z0, 1, 0], [w1, z1, 1, 1], [-w1, z1, -1, 1]];
		for (let i = 0; i < 4; i++)
		{
			this.pos.push(P[i][0], y, P[i][1]);
			this.part.push(6); this.corner.push(P[i][2], P[i][3]); this.dir.push(0); this.size.push(-1);
		}
		this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
		this.n += 4;
	}
	public geometry(withGlow: boolean): THREE.BufferGeometry
	{
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
		g.setAttribute('lpart', new THREE.Float32BufferAttribute(this.part, 1));
		if (withGlow)
		{
			g.setAttribute('corner', new THREE.Float32BufferAttribute(this.corner, 2));
			g.setAttribute('ldir', new THREE.Float32BufferAttribute(this.dir, 1));
			g.setAttribute('gsize', new THREE.Float32BufferAttribute(this.size, 1));
		}
		g.setIndex(this.idx);
		g.computeBoundingBox();
		g.computeBoundingSphere();
		return g;
	}
}

const OUT = 0.012;   // lenses sit this far off the paint

export function buildLensGeometry(L: LampLayout): THREE.BufferGeometry
{
	const q = new Quads();
	const fz = L.headZ + OUT, rz = L.tailZ - OUT;
	q.lens(L.headX, L.headY, fz, L.headW, L.headH, 1, 0);
	q.lens(-L.headX, L.headY, fz, L.headW, L.headH, 1, 1);
	q.lens(L.tailX, L.tailY, rz, L.tailW, L.tailH, -1, 2);
	q.lens(-L.tailX, L.tailY, rz, L.tailW, L.tailH, -1, 2);
	const rx = L.tailX - L.tailW * 0.5 - 0.07;
	q.lens(rx, L.tailY, rz, 0.08, L.tailH * 0.8, -1, 3);
	q.lens(-rx, L.tailY, rz, 0.08, L.tailH * 0.8, -1, 3);
	const sx = Math.min(L.sigX, L.headX + L.headW * 0.5 + 0.06);
	q.lens(sx, L.headY, fz - 0.01, 0.08, L.headH * 0.9, 1, 4);
	q.lens(-sx, L.headY, fz - 0.01, 0.08, L.headH * 0.9, 1, 5);
	const tsx = Math.min(L.sigX, L.tailX + L.tailW * 0.5 + 0.06);
	q.lens(tsx, L.tailY, rz + 0.01, 0.08, L.tailH * 0.9, -1, 4);
	q.lens(-tsx, L.tailY, rz + 0.01, 0.08, L.tailH * 0.9, -1, 5);
	const g = q.geometry(false);
	g.name = 'carLightLenses';
	return g;
}

export function buildGlowGeometry(L: LampLayout): THREE.BufferGeometry
{
	const q = new Quads();
	const fz = L.headZ + 0.05, rz = L.tailZ - 0.05;
	q.halo(L.headX, L.headY, fz, 0.55, 1, 0);
	q.halo(-L.headX, L.headY, fz, 0.55, 1, 1);
	q.halo(L.tailX, L.tailY, rz, 0.4, -1, 2);
	q.halo(-L.tailX, L.tailY, rz, 0.4, -1, 2);
	const rx = L.tailX - L.tailW * 0.5 - 0.07;
	q.halo(rx, L.tailY, rz, 0.3, -1, 3);
	q.halo(-rx, L.tailY, rz, 0.3, -1, 3);
	const sx = Math.min(L.sigX, L.headX + L.headW * 0.5 + 0.06);
	q.halo(sx, L.headY, fz, 0.34, 1, 4);
	q.halo(-sx, L.headY, fz, 0.34, 1, 5);
	const tsx = Math.min(L.sigX, L.tailX + L.tailW * 0.5 + 0.06);
	q.halo(tsx, L.tailY, rz, 0.34, -1, 4);
	q.halo(-tsx, L.tailY, rz, 0.34, -1, 5);
	q.pool(L);
	const g = q.geometry(true);
	g.name = 'carLightGlow';
	return g;
}

// ------------------------------------------------------------------------------ shaders

const DECODE = `
#ifdef USE_INSTANCING
attribute vec3 lstate;
#else
uniform vec3 lstate;
#endif
uniform float uHeadR;
uniform float uNight;
float lampLevel(float part) {
	float bits = lstate.z + 0.25;
	float rev = step(4.0, bits); bits -= rev * 4.0;
	float sr = step(2.0, bits); bits -= sr * 2.0;
	float sl = step(1.0, bits);
	float headR = uHeadR < 0.0 ? lstate.x : uHeadR;
	if (part < 0.5) return lstate.x;
	if (part < 1.5) return headR;
	if (part < 2.5) return lstate.y;
	if (part < 3.5) return rev;
	if (part < 4.5) return sl;
	if (part < 5.5) return sr;
	return max(lstate.x, headR) * uNight;
}
vec3 lampColor(float part) {
	if (part < 1.5) return vec3(1.0, 0.97, 0.86);
	if (part < 2.5) return vec3(1.0, 0.06, 0.04);
	if (part < 3.5) return vec3(1.0, 1.0, 1.0);
	if (part < 5.5) return vec3(1.0, 0.55, 0.05);
	return vec3(1.0, 0.92, 0.72);
}
vec3 lampOff(float part) {
	if (part < 1.5) return vec3(0.62, 0.63, 0.64);
	if (part < 2.5) return vec3(0.34, 0.04, 0.04);
	if (part < 3.5) return vec3(0.7, 0.7, 0.72);
	return vec3(0.5, 0.3, 0.06);
}
`;

const LENS_VERT = `
attribute float lpart;
varying vec3 vCol;
${DECODE}
#include <fog_pars_vertex>
void main() {
	float lv = clamp(lampLevel(lpart), 0.0, 1.0);
	vec3 off = lampOff(lpart) * mix(1.0, 0.3, uNight);
	vCol = mix(off, lampColor(lpart), lv);
	vec4 mvPosition = vec4(position, 1.0);
	#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
	#endif
	mvPosition = modelViewMatrix * mvPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <fog_vertex>
}
`;

const LENS_FRAG = `
varying vec3 vCol;
#include <fog_pars_fragment>
void main() {
	gl_FragColor = vec4(vCol, 1.0);
	#include <fog_fragment>
}
`;

const GLOW_VERT = `
attribute float lpart;
attribute vec2 corner;
attribute float ldir;
attribute float gsize;
varying vec3 vCol;
varying vec2 vUv;
varying float vPool;
${DECODE}
#include <fog_pars_vertex>
void main() {
	float lv = clamp(lampLevel(lpart), 0.0, 1.0);
	// halos: brighter at night; head halos only exist with the headlights on
	float k = lpart < 1.5 ? mix(0.35, 1.0, uNight) : mix(0.45, 1.0, uNight);
	if (lpart > 1.5 && lpart < 2.5) lv = max(0.0, lv - 0.2) * 1.25;   // tail-only glows dimly, brake fully
	lv *= k;
	vec4 p = vec4(position, 1.0);
	#ifdef USE_INSTANCING
	p = instanceMatrix * p;
	#endif
	vec4 mvPosition = modelViewMatrix * p;
	vPool = gsize < 0.0 ? 1.0 : 0.0;
	if (gsize > 0.0) {
		// fade when the lamp faces away from the camera
		vec3 d = vec3(0.0, 0.0, ldir);
		#ifdef USE_INSTANCING
		d = mat3(instanceMatrix) * d;
		#endif
		vec3 n = normalize(mat3(modelViewMatrix) * d);
		float facing = dot(n, normalize(-mvPosition.xyz));
		lv *= smoothstep(-0.05, 0.45, facing);
		mvPosition.xy += corner * gsize;
		mvPosition.z += 0.1;
	}
	vUv = corner;
	vCol = lampColor(lpart) * lv;
	gl_Position = lv < 0.004 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mvPosition;
	#include <fog_vertex>
}
`;

const GLOW_FRAG = `
varying vec3 vCol;
varying vec2 vUv;
varying float vPool;
#include <fog_pars_fragment>
void main() {
	float a;
	if (vPool > 0.5) {
		float across = 1.0 - vUv.x * vUv.x;
		float along = (1.0 - vUv.y);
		a = across * along * smoothstep(0.0, 0.15, vUv.y + 0.02) * 0.32;
	} else {
		float r = length(vUv);
		a = max(0.0, 1.0 - r);
		a = a * a * 0.85;
	}
	vec3 c = vCol * a;
	#ifdef USE_FOG
	#ifdef FOG_EXP2
	float fogFactor = 1.0 - exp( - fogDensity * fogDensity * fogDepth * fogDepth );
	#else
	float fogFactor = smoothstep( fogNear, fogFar, fogDepth );
	#endif
	c *= 1.0 - fogFactor;
	#endif
	gl_FragColor = vec4(c, 1.0);
}
`;

function lensMaterial(instanced: boolean): THREE.ShaderMaterial
{
	const u: any = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uHeadR: { value: -1 }, uNight: { value: 0 } }]);
	if (!instanced) u.lstate = { value: new THREE.Vector3(0, 0, 0) };
	const m = new THREE.ShaderMaterial({ uniforms: u, vertexShader: LENS_VERT, fragmentShader: LENS_FRAG, fog: true, side: THREE.DoubleSide });
	m.name = 'carLightLens';
	(m as any).toneMapped = false;
	m.userData = { realismCarLights: true, instancedCopy: instanced };
	return m;
}

function glowMaterial(instanced: boolean): THREE.ShaderMaterial
{
	const u: any = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uHeadR: { value: -1 }, uNight: { value: 0 } }]);
	if (!instanced) u.lstate = { value: new THREE.Vector3(0, 0, 0) };
	const m = new THREE.ShaderMaterial({
		uniforms: u, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, fog: true,
		transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
	});
	m.name = 'carLightGlow';
	(m as any).toneMapped = false;
	m.userData = { realismCarLights: true, instancedCopy: instanced };
	return m;
}

// ------------------------------------------------------------------------------ instanced (traffic / parked)

/**
 * Lenses (+ optional glow) for a pool of instanced cars. Write lstate[i*3..] and the matrix of
 * instance i with set(), then commit(count) once per frame.
 */
export class InstancedCarLights
{
	public lens: THREE.InstancedMesh;
	public glow: THREE.InstancedMesh = null;
	public state: Float32Array;
	private lensAttr: THREE.InstancedBufferAttribute;
	private glowAttr: THREE.InstancedBufferAttribute = null;
	private lensMat: THREE.ShaderMaterial;
	private glowMat: THREE.ShaderMaterial = null;
	public cap: number;

	constructor(scene: THREE.Object3D, layout: LampLayout, cap: number, name: string, withGlow: boolean)
	{
		this.cap = cap;
		this.state = new Float32Array(cap * 3);
		// every InstancedMesh gets its OWN geometry object (see RealismInstanceGeom: r113 binds the
		// instance matrices per geometry id)
		const lg = buildLensGeometry(layout);
		this.lensAttr = new THREE.InstancedBufferAttribute(this.state, 3);
		(this.lensAttr as any).setUsage ? (this.lensAttr as any).setUsage(THREE.DynamicDrawUsage) : 0;
		lg.setAttribute('lstate', this.lensAttr);
		this.lensMat = lensMaterial(true);
		this.lens = new THREE.InstancedMesh(lg, this.lensMat, cap);
		this.lens.count = 0; this.lens.visible = false; this.lens.frustumCulled = false;
		this.lens.castShadow = false; this.lens.receiveShadow = false;
		this.lens.name = name + 'LightLenses';
		this.lens.userData = { data: 'realismLights', realismLights: true };
		scene.add(this.lens);
		if (withGlow)
		{
			const gg = buildGlowGeometry(layout);
			this.glowAttr = new THREE.InstancedBufferAttribute(this.state, 3);
			(this.glowAttr as any).setUsage ? (this.glowAttr as any).setUsage(THREE.DynamicDrawUsage) : 0;
			gg.setAttribute('lstate', this.glowAttr);
			this.glowMat = glowMaterial(true);
			this.glow = new THREE.InstancedMesh(gg, this.glowMat, cap);
			this.glow.count = 0; this.glow.visible = false; this.glow.frustumCulled = false;
			this.glow.castShadow = false; this.glow.receiveShadow = false;
			this.glow.renderOrder = 5;
			this.glow.name = name + 'LightGlow';
			this.glow.userData = { data: 'realismLights', realismLights: true };
			scene.add(this.glow);
		}
	}

	public set(i: number, m: THREE.Matrix4, head: number, tail: number, bits: number): void
	{
		if (i >= this.cap) return;
		this.lens.setMatrixAt(i, m);
		if (this.glow) this.glow.setMatrixAt(i, m);
		this.state[i * 3] = head; this.state[i * 3 + 1] = tail; this.state[i * 3 + 2] = bits;
	}

	/** Returns the draw calls used. */
	public commit(count: number, night: boolean, anyLit: boolean): number
	{
		const n = Math.min(count, this.cap);
		const nv = night ? 1 : 0;
		this.lensMat.uniforms.uNight.value = nv;
		this.lens.count = n; this.lens.visible = n > 0;
		if (n > 0) { this.lens.instanceMatrix.needsUpdate = true; this.lensAttr.needsUpdate = true; }
		let calls = n > 0 ? 1 : 0;
		if (this.glow)
		{
			this.glowMat.uniforms.uNight.value = nv;
			const on = n > 0 && anyLit;
			this.glow.count = on ? n : 0; this.glow.visible = on;
			if (on) { this.glow.instanceMatrix.needsUpdate = true; this.glowAttr.needsUpdate = true; calls++; }
		}
		return calls;
	}
}

// ------------------------------------------------------------------------------ real cars

interface RealLights
{
	car: any;
	lens: THREE.Mesh;
	glow: THREE.Mesh;
	lensMat: THREE.ShaderMaterial;
	glowMat: THREE.ShaderMaterial;
	layout: LampLayout;
	head: number; headR: number; tail: number; brake: boolean; reverse: boolean;
	signal: number;          // -1 left, 1 right, 0 off
	hazards: boolean;
	sigYaw: number; lastYaw: number; turned: number;
	prevSpeed: number; brakeT: number;
	engine: boolean;
}

export class CarLightSystem
{
	public updateOrder = 14;
	public settings: CarLightSettings;
	public mode: 'auto' | 'on' | 'off' = 'auto';
	public stats: { [k: string]: number } = { cars: 0, drawCalls: 0, spotOn: 0, updateMs: 0 };
	public layout: LampLayout = null;
	public night = false;
	public api: any;
	private ctx: RealismCtx;
	private list: RealLights[] = [];
	private clock = 0;
	private spot: THREE.SpotLight = null;
	private spotTarget: THREE.Object3D = null;
	private tv = new THREE.Vector3();
	private tv2 = new THREE.Vector3();
	private tq = new THREE.Quaternion();
	private notice: HTMLElement = null;
	private noticeUntil = 0;
	private keyHandler: (e: any) => void = null;

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.settings = carLightSettings(ctx);
		const self = this;
		const w: any = ctx.world;
		if (this.settings.enabled && this.settings.playerSpot)
		{
			const s = new THREE.SpotLight(0xfff1d6, 0, this.settings.spotDistance, 0.52, 0.55, 1.6);
			s.castShadow = false;
			s.name = 'carHeadlightSpot';
			this.spotTarget = new THREE.Object3D();
			s.target = this.spotTarget;
			w.graphicsWorld.add(s);
			w.graphicsWorld.add(this.spotTarget);
			this.spot = s;
		}
		this.api = {
			get mode(): string { return self.mode; },
			setMode(m: string): void { if (m === 'auto' || m === 'on' || m === 'off') self.mode = m; },
			signal(car: any, dir: number): void { const r = self.attach(car); if (r) { r.signal = dir < 0 ? -1 : (dir > 0 ? 1 : 0); r.turned = 0; } },
			hazards(car: any, on: boolean): void { const r = self.attach(car); if (r) r.hazards = !!on; },
			stateOf(car: any): any
			{
				const r: RealLights = car && car.realismLights;
				if (!r) return null;
				return { head: r.head, headR: r.headR, tail: r.tail, brake: r.brake, reverse: r.reverse, signal: r.signal, hazards: r.hazards, engine: r.engine };
			},
			get night(): boolean { return self.night; },
			get stats(): any { return self.stats; },
			get layout(): LampLayout { return self.layout; },
			get spot(): THREE.SpotLight { return self.spot; },
			/** Test hook: a key press (KeyboardEvent.code) as the player. */
			key(code: string): boolean { return self.onKey({ code: code, repeat: false }); },
			/** Test hook: one update with this time step. */
			tick(dt: number): void { self.update(dt, dt); },
		};
		w.realismCarLights = this.api;
		try
		{
			if (typeof document !== 'undefined' && document.addEventListener)
			{
				this.keyHandler = (e: any) => this.onKey(e);
				document.addEventListener('keydown', this.keyHandler);
			}
		}
		catch (e) { /* headless */ }
	}

	/** Player keys. Returns true when handled. */
	public onKey(e: any): boolean
	{
		if (!e || e.repeat || !this.settings.enabled) return false;
		const w: any = this.ctx.world;
		if (w.realismPaused === true || w.realismUIBlocking === true) return false;
		const car = this.playerCar();
		if (!car) return false;
		const code = e.code || '';
		const r = this.attach(car);
		if (!r) return false;
		if (code === this.settings.keyHead)
		{
			this.mode = this.mode === 'auto' ? 'on' : (this.mode === 'on' ? 'off' : 'auto');
			this.flash('Headlights: ' + (this.mode === 'auto' ? 'Auto' : (this.mode === 'on' ? 'On' : 'Off')));
			return true;
		}
		if (code === this.settings.keyLeft || code === this.settings.keyRight)
		{
			const d = code === this.settings.keyLeft ? -1 : 1;
			r.signal = r.signal === d ? 0 : d;
			r.turned = 0;
			return true;
		}
		if (code === this.settings.keyHazard) { r.hazards = !r.hazards; return true; }
		return false;
	}

	private player(): any
	{
		const w: any = this.ctx.world;
		const npcs = w.realismNPCs;
		if (npcs && npcs.player) return npcs.player;
		const r = w.inputManager && w.inputManager.inputReceiver;
		if (r && r.controllingCharacter) return r.controllingCharacter;
		return r && r.isCharacter ? r : null;
	}

	/** The car the player drives (driver seat), or null. */
	public playerCar(): any
	{
		const p = this.player();
		if (!p) return null;
		const v = p.controlledObject;
		if (v && isCar(v)) return v;
		return null;
	}

	/** Lenses and glow for a real car (once). */
	public attach(car: any): RealLights
	{
		if (!car || !isCar(car)) return null;
		if (car.realismLights) return car.realismLights;
		const layout = measureCarObject(car);
		if (!layout) return null;
		if (!this.layout) this.layout = layout;
		const lensMat = lensMaterial(false), glowMat = glowMaterial(false);
		const lens = new THREE.Mesh(buildLensGeometry(layout), lensMat);
		lens.name = 'carLightLenses';
		lens.userData = { data: 'realismLights', realismLights: true };
		lens.castShadow = false; lens.receiveShadow = false;
		const glow = new THREE.Mesh(buildGlowGeometry(layout), glowMat);
		glow.name = 'carLightGlow';
		glow.userData = { data: 'realismLights', realismLights: true };
		glow.castShadow = false; glow.receiveShadow = false;
		glow.renderOrder = 5;
		glow.frustumCulled = false;
		glow.visible = false;
		const parent: THREE.Object3D = car.modelContainer || car;
		parent.add(lens); parent.add(glow);
		const r: RealLights = {
			car: car, lens: lens, glow: glow, lensMat: lensMat, glowMat: glowMat, layout: layout,
			head: 0, headR: -1, tail: 0, brake: false, reverse: false, signal: 0, hazards: false,
			sigYaw: 0, lastYaw: yawOf(car), turned: 0, prevSpeed: 0, brakeT: 0, engine: false,
		};
		car.realismLights = r;
		this.list.push(r);
		return r;
	}

	public update(timeStep: number, unscaled?: number): void
	{
		const w: any = this.ctx.world;
		if (!this.settings.enabled || w.realismPaused === true) return;
		const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
		const dt = Math.min(0.1, Math.max(0, timeStep || 0));
		this.clock += dt;
		this.night = isNightNow(w);
		const blink = blinkOn(this.clock);
		const vehicles: any[] = w.vehicles || [];
		for (let i = 0; i < vehicles.length; i++) if (isCar(vehicles[i]) && !vehicles[i].realismLights) this.attach(vehicles[i]);
		const pcar = this.playerCar();
		const els = w.realismPolice && w.realismPolice.els;
		const wig = !els || els.wigwag !== false;
		let calls = 0, spotCar: RealLights = null;
		for (let i = this.list.length - 1; i >= 0; i--)
		{
			const r = this.list[i];
			const car = r.car;
			if (vehicles.indexOf(car) < 0 || !car.parent)
			{
				// removed from the world: keep the meshes on the car (it may come back), forget it here
				if (vehicles.indexOf(car) < 0) { this.list.splice(i, 1); car.realismLights = undefined; if (r.lens.parent) r.lens.parent.remove(r.lens); if (r.glow.parent) r.glow.parent.remove(r.glow); }
				continue;
			}
			this.step(r, dt, car === pcar, blink, wig);
			r.lensMat.uniforms.lstate.value.set(r.head, r.tail, packBits(r.reverse, (r.signal < 0 || r.hazards) && blink, (r.signal > 0 || r.hazards) && blink));
			r.lensMat.uniforms.uHeadR.value = r.headR;
			r.lensMat.uniforms.uNight.value = this.night ? 1 : 0;
			r.glowMat.uniforms.lstate.value.copy(r.lensMat.uniforms.lstate.value);
			r.glowMat.uniforms.uHeadR.value = r.headR;
			r.glowMat.uniforms.uNight.value = this.night ? 1 : 0;
			const lit = this.settings.glow && (r.head > 0 || r.headR > 0 || r.tail > 0 || r.reverse || r.signal !== 0 || r.hazards);
			r.glow.visible = lit;
			if (car.visible !== false) calls += 1 + (lit ? 1 : 0);
			if (car === pcar && r.head > 0 && this.night) spotCar = r;
		}
		// the player's headlight beam
		if (this.spot)
		{
			if (spotCar)
			{
				const c = spotCar.car, L = spotCar.layout;
				c.updateMatrixWorld();
				this.tv.set(0, L.headY + 0.05, L.headZ + 0.3).applyMatrix4(c.matrixWorld);
				this.tv2.set(0, L.groundY, L.headZ + 18).applyMatrix4(c.matrixWorld);
				this.spot.position.copy(this.tv);
				this.spotTarget.position.copy(this.tv2);
				this.spotTarget.updateMatrixWorld();
				this.spot.intensity = this.settings.spotIntensity;
				this.stats.spotOn = 1;
			}
			else if (this.spot.intensity !== 0) { this.spot.intensity = 0; this.stats.spotOn = 0; }
		}
		this.stats.cars = this.list.length;
		this.stats.drawCalls = calls;
		if (this.notice && this.noticeUntil && Date.now() > this.noticeUntil) { this.notice.style.display = 'none'; this.noticeUntil = 0; }
		const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
		this.stats.updateMs = this.stats.updateMs * 0.9 + (t1 - t0) * 0.1;
	}

	/** The light state machine of one real car. */
	private step(r: RealLights, dt: number, isPlayer: boolean, blink: boolean, wig: boolean): void
	{
		const car = r.car;
		const driver = car.controllingCharacter;
		const u = car.realismELS;
		const policeLit = !!u && u.stage > 0;
		r.engine = !car.engineOff && (!!driver || policeLit || car.realismEngineOn === true);
		const speed = typeof car.speed === 'number' && isFinite(car.speed) ? car.speed : 0;
		const a = car.actions || {};
		const pressed = (k: string) => !!(a[k] && a[k].isPressed);
		// brake: S while rolling forward, W while rolling back, handbrake, or hard deceleration
		const decel = dt > 0 ? (Math.abs(r.prevSpeed) - Math.abs(speed)) / dt : 0;
		r.prevSpeed = speed;
		let braking = false;
		if (r.engine && driver)
		{
			braking = (pressed('reverse') && speed > 0.5) || (pressed('throttle') && speed < -0.5) || pressed('brake')
				|| (decel > 3.5 && Math.abs(speed) > 1.5 && !pressed('throttle'));
		}
		r.brakeT = braking ? 0.25 : Math.max(0, r.brakeT - dt);
		r.brake = r.brakeT > 0;
		r.reverse = r.engine && !!driver && pressed('reverse') && speed < 0.6;
		// headlights
		let head = 0;
		if (r.engine)
		{
			const mode = isPlayer ? this.mode : 'auto';
			head = mode === 'on' || (mode === 'auto' && this.night) ? 1 : 0;
		}
		r.head = head; r.headR = -1;
		if (u && u.stage >= 2 && wig)
		{
			const wi = Math.floor((u.t || 0) / 0.33) % 2;           // same phase as RealismELS paint()
			r.head = wi === 0 ? 1 : 0.08;
			r.headR = wi === 1 ? 1 : 0.08;
		}
		r.tail = r.brake ? 1 : (head > 0 && r.engine ? 0.35 : 0);
		// turn signals cancel themselves once the car has turned and straightened out
		const yaw = yawOf(car);
		let dy = yaw - r.lastYaw;
		if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
		r.lastYaw = yaw;
		if (r.signal !== 0)
		{
			r.turned += dy;
			const steer = car.steeringSimulator ? car.steeringSimulator.position : 0;
			if (Math.abs(r.turned) > 0.55 && Math.abs(steer) < 0.08) { r.signal = 0; r.turned = 0; }
		}
		if (!r.engine && !r.hazards) r.signal = 0;
	}

	private flash(text: string): void
	{
		try
		{
			if (!this.notice)
			{
				if (typeof document === 'undefined' || !document.body || !document.createElement) return;
				const h = document.createElement('div');
				h.style.cssText = 'position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:9999;font:bold 14px sans-serif;color:#fff;background:rgba(0,0,0,0.5);padding:5px 12px;border-radius:5px;pointer-events:none;display:none';
				document.body.appendChild(h);
				this.notice = h;
			}
			this.notice.textContent = text;
			this.notice.style.display = 'block';
			this.noticeUntil = Date.now() + 1400;
		}
		catch (e) { /* headless */ }
	}
}

function isCar(v: any): boolean
{
	return !!v && !!v.wheels && v.wheels.length >= 4 && !!v.rayCastVehicle && !!v.actions && !!v.actions.throttle;
}

function yawOf(car: any): number
{
	const q = car.quaternion;
	// heading of local +z in the xz plane
	const x = 2 * (q.x * q.z + q.w * q.y), z = 1 - 2 * (q.x * q.x + q.y * q.y);
	return Math.atan2(x, z);
}

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _v = new THREE.Vector3();

/** Lamp layout of a real car, measured from its own body meshes in car space. */
export function measureCarObject(car: any): LampLayout
{
	const parent: THREE.Object3D = car.modelContainer || car;
	car.updateMatrixWorld(true);
	_inv.getInverse(parent.matrixWorld);
	const wheelsSet: any[] = (car.wheels || []).map((w: any) => w.wheelObject);
	const under = (o: THREE.Object3D) => { let p = o; while (p && p !== car) { if (wheelsSet.indexOf(p) >= 0) return true; p = p.parent; } return false; };
	const pts: number[] = [];
	const wpts: number[] = [];
	const paint: number[] = [];     // stock car.glb body (material 'Car'): never measures a light bar or a livery
	car.traverse((o: any) =>
	{
		if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
		const ud = o.userData || {};
		if (ud.realismLights || ud.data === 'collision' || ud.data === 'navmesh' || ud.data === 'realismLights' || ud.realismLivery) return;
		if (o.material && /led|els|lightbar/i.test(String(o.material.name || '') + ' ' + String(o.name || ''))) return;
		if (car.realismELS && (o === car.realismELS.led || o === car.realismELS.beam)) return;
		const wheel = under(o) || (o.material && o.material.name === 'Wheel');
		_m.multiplyMatrices(_inv, o.matrixWorld);
		const p = o.geometry.attributes.position;
		const out = wheel ? wpts : (o.material && o.material.name === 'Car' ? paint : pts);
		for (let i = 0; i < p.count; i++) { _v.fromBufferAttribute(p, i).applyMatrix4(_m); out.push(_v.x, _v.y, _v.z); }
	});
	const body = paint.length >= 30 ? paint : pts.concat(paint);
	if (body.length < 30) return null;
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(body, 3));
	let wg: THREE.BufferGeometry = null;
	if (wpts.length) { wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wpts, 3)); }
	return measureLamps(g, wg);
}

export function buildCarLights(ctx: RealismCtx): CarLightSystem
{
	const sys = new CarLightSystem(ctx);
	ctx.world.registerUpdatable(sys as any);
	return sys;
}
