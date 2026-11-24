/*
 * RealismSwim.ts
 * --------------
 * Swimming for San Verano County (developer A14).
 *
 *  - Water: the sea (y = 0, everywhere the terrain is below sea level near the coast) and Lake Verano
 *    (ellipse in ctx.data.lake at its level). waterLevelAt(x, z) returns the surface height or -Infinity.
 *  - The player starts swimming when the chest is under the surface (water deeper than ~0.72 x scale at the
 *    feet). Buoyancy holds the body so the head stays above water (Character.realismPostStep sets the
 *    vertical speed each physics step, gravity compensated); the terrain / sea floor collider still stops
 *    you from sinking through. W/A/S/D swim relative to the camera, Shift faster, Space swims up (and climbs
 *    out at an edge), C dives (hold), release to come back up.
 *  - Animation: the boxman has no swim clip, so the bones are turned after the mixer: front crawl arms
 *    + flutter kick while moving, sculling arms + slow kick while treading water; the body pitches forward
 *    (not in first person).
 *  - Getting out: walking into shallow water (feet touch the ground with water below ~0.62 x scale) or
 *    swimming at a ledge up to ~0.9 x scale above the surface (docks, pool edges, steep banks).
 *  - Splash particles (one small Points mesh, only visible near you while swimming) + WebAudio splashes.
 *  - Weapons: switched to fists and hidden while swimming, restored afterwards.
 *  - Vehicles in deep water: untouched (the player is only checked on foot).
 *
 * API: (world as any).realismSwim = { active, level, waterLevelAt(x, z), start(), stop(), stats, settings }.
 * Config: realism-config.js -> swimming (defaults in DEFAULT_SWIMMING). Respects realismPaused.
 * No per-frame allocations.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { deepMerge } from './RealismConfig';
import { coastDistance, SEA_LEVEL } from './RealismMapData';
import { Idle } from '../characters/character_states/_stateLibrary';
import { RealismSwimState } from '../characters/character_states/RealismStates';
import { sfxFor, RealismSfx } from './RealismSfx';
import { CollisionGroups } from '../enums/CollisionGroups';

export const DEFAULT_SWIMMING = {
	enabled: true,
	enterDepth: 0.72,     // x player scale: water deeper than this at the feet = swim (chest under water)
	exitDepth: 0.62,      // x player scale: feet on the ground and water shallower than this = walk
	floatOffset: -0.1,    // x player scale: body centre relative to the surface while floating (head + shoulders out)
	speed: 0.34,          // swim speed (x the character's move speed), about 1.8 m/s at scale 1.7
	fastSpeed: 0.6,       // with Shift
	diveSpeed: 1.4,       // m/s down while C is held
	maxDive: 6,           // metres below the surface at most
	pitch: 0.9,           // body pitch (radians) while swimming forward
	climbHeight: 0.9,     // x scale: highest ledge above the surface you can climb out on
	splashes: true,
	sounds: true,
};

const N_SPLASH = 48;

export class RealismSwim implements IUpdatable
{
	public updateOrder: number = 4.8;    // after the camera / first person, after the mixer ran (characters: 1)
	public settings: any;
	public active = false;
	public level = -Infinity;
	public ch: any = null;
	public stats = { starts: 0, stops: 0, climbs: 0, splashes: 0 };
	public targetY = 0;

	private world: any;
	private ctx: RealismCtx;
	private lake: any;
	private sfx: RealismSfx;
	private dive = 0;
	private savedRay = 0;
	private diving = false;
	private phase = 0;
	private pitchNow = 0;
	private move = 0;
	private lastStroke = 0;
	private climbAcc = 0;
	private climb: { t: number; fx: number; fy: number; fz: number; tx: number; ty: number; tz: number } = null;
	private prevWeapon = -1;
	private hook: (body: CANNON.Body) => void;
	private bones: { [n: string]: THREE.Bone } = {};
	private bonesOf: any = null;
	private q = new THREE.Quaternion();
	private ax = new THREE.Vector3(1, 0, 0);
	private az = new THREE.Vector3(0, 0, 1);
	private tmpV = new THREE.Vector3();
	private rayRes = new CANNON.RaycastResult();
	private rayFrom = new CANNON.Vec3();
	private rayTo = new CANNON.Vec3();
	private rayOpts = { collisionFilterMask: CollisionGroups.Default, skipBackfaces: true };
	private splash: THREE.Points = null;
	private sv: Float32Array = null;      // velocities x,y,z per particle
	private sLife: Float32Array = null;
	private splashLive = 0;
	private keyC = false;
	private handlers: { target: any; type: string; fn: any }[] = [];

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		this.lake = ctx.data && ctx.data.lake ? ctx.data.lake : null;
		const user = (ctx.cfg as any).swimming;
		this.settings = deepMerge(DEFAULT_SWIMMING, user && typeof user === 'object' ? user : {});
		this.sfx = sfxFor(this.world);
		this.hook = (body: CANNON.Body) => this.postStep(body);
		this.world.realismSwim = this;
		try
		{
			if (typeof window !== 'undefined')
			{
				const down = (e: KeyboardEvent) => { if (e.code === 'KeyC' && !e.shiftKey) this.keyC = true; };
				const up = (e: KeyboardEvent) => { if (e.code === 'KeyC') this.keyC = false; };
				window.addEventListener('keydown', down, false);
				window.addEventListener('keyup', up, false);
				this.handlers.push({ target: window, type: 'keydown', fn: down }, { target: window, type: 'keyup', fn: up });
			}
		}
		catch (e) { /* headless */ }
	}

	/** Water surface height at (x, z), or -Infinity where there's no water. */
	public waterLevelAt(x: number, z: number): number
	{
		const data = this.ctx.data;
		const L = this.lake;
		if (L)
		{
			const dx = (x - L.x) / L.rx, dz = (z - L.z) / L.rz;
			if (dx * dx + dz * dz < 1.12 * 1.12 && data.heightAt(x, z) < L.level - 0.05) return L.level;
		}
		if (coastDistance(x, z) > -60 && data.heightAt(x, z) < SEA_LEVEL - 0.05) return SEA_LEVEL;
		return -Infinity;
	}

	/** Held C (dive) for tests / other input. */
	public setDive(on: boolean): void { this.keyC = on; }

	private player(): any
	{
		const w = this.world;
		const r = w.inputManager && w.inputManager.inputReceiver;
		if (!r || r.characterCapsule === undefined) return null;
		if (r.occupyingSeat || r.controlledObject !== undefined || r.vehicleEntryInstance) return null;
		return r;
	}

	private sc(ch: any): number
	{
		const s = Number(ch && ch.playerScale);
		return s > 0 ? s : 1;
	}

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		const w = this.world;
		if (w.realismPaused === true) return;
		const dt = Math.min(0.1, Math.max(0, unscaledTimeStep !== undefined ? unscaledTimeStep : timeStep));
		this.updateSplash(dt);
		if (this.settings.enabled === false) { if (this.active) this.stop(false); return; }
		const ch = this.player();
		if (this.active && (ch === null || ch !== this.ch || ch.charState === null || !(ch.charState instanceof RealismSwimState)) && this.climb === null)
		{
			// got into a vehicle / another state took over
			this.stop(false);
			return;
		}
		if (ch === null || !ch.physicsEnabled && !this.active) return;
		const s = this.sc(ch);
		const p = ch.position;
		if (this.climb !== null) { this.updateClimb(ch, dt); return; }
		this.level = this.waterLevelAt(p.x, p.z);
		const feet = p.y - 0.57 * s;
		if (!this.active)
		{
			if (this.level === -Infinity) return;
			const ia = w.realismInteractions;
			if (ia && ia.active) return;
			if (this.level - feet > this.settings.enterDepth * s) this.start(ch);
			return;
		}
		// ---- swimming
		if (this.level === -Infinity) { this.stop(true); return; }
		// standing depth reached (walking out up a beach / ramp / stairs)
		if (this.dive < 0.2)
		{
			const ground = this.groundBelow(p.x, p.y, p.z, this.level - this.settings.exitDepth * s - 0.05);
			if (ground > this.level - this.settings.exitDepth * s) { this.stop(true); return; }
		}
		if (feet > this.level + 0.15 * s) { this.stop(true); return; }   // out of the water (jumped / pushed out)
		// input
		const a = ch.actions;
		const moving = a.up.isPressed || a.down.isPressed || a.left.isPressed || a.right.isPressed;
		this.move += ((moving ? 1 : 0) - this.move) * Math.min(1, dt * 4);
		this.diving = this.keyC;
		if (this.diving) this.dive = Math.min(Number(this.settings.maxDive) || 6, this.dive + dt * (Number(this.settings.diveSpeed) || 1.4));
		else this.dive = Math.max(0, this.dive - dt * (a.jump.isPressed ? 2.4 : 1.2));
		const fp = w.realismFirstPerson === true;
		this.targetY = this.level + (Number(this.settings.floatOffset) || -0.1) * s + (fp ? 0 : 0.12 * s * this.move) - this.dive;
		if (a.jump.isPressed && this.dive === 0) this.targetY += 0.18 * s;
		// state speeds from settings
		const st = ch.charState as RealismSwimState;
		st.speed = Number(this.settings.speed) || 0.34;
		st.fastSpeed = Number(this.settings.fastSpeed) || 0.6;
		// climbing out at an edge
		this.climbAcc += dt;
		if (this.climbAcc > 0.12 && (a.up.isPressed || a.jump.isPressed) && this.dive < 0.3)
		{
			this.climbAcc = 0;
			this.tryClimb(ch, s);
		}
		// weapons stay away
		const wp = w.realismWeapons;
		if (wp && wp.root) wp.root.visible = false;
		// animation
		this.animate(ch, dt, fp, s);
		// splashes + strokes
		this.lastStroke += dt * (moving ? (a.run.isPressed ? 1.7 : 1.1) : 0.5);
		if (this.lastStroke > 1 && this.dive < 0.4)
		{
			this.lastStroke = 0;
			if (moving) { this.emitSplash(p.x, this.level, p.z, 6, 0.6); if (this.settings.sounds !== false) this.sfx.stroke(); }
		}
		const needs = w.realismNeeds;
		if (needs && needs.system) needs.system.swimming = true;
	}

	/** Starts swimming (called when the chest goes under; public for tests). */
	public start(ch: any): void
	{
		if (this.active) return;
		const s = this.sc(ch);
		this.active = true;
		this.ch = ch;
		this.dive = 0;
		this.stats.starts++;
		const vy = ch.characterCapsule && ch.characterCapsule.body ? ch.characterCapsule.body.velocity.y : 0;
		ch.realismPostStep = this.hook;
		// the feet ray would snap the capsule onto the floor in chest-deep water: keep it short while swimming
		this.savedRay = ch.rayCastLength;
		ch.rayCastLength = 0.35 * s;
		ch.setState(new RealismSwimState(ch));
		const wp = this.world.realismWeapons;
		if (wp && typeof wp.equipById === 'function')
		{
			this.prevWeapon = typeof wp.current === 'number' ? wp.current : -1;
			try { wp.equipById('fists'); } catch (e) { /* optional */ }
		}
		const strength = Math.min(1, Math.abs(vy) / 8 + 0.25);
		this.emitSplash(ch.position.x, this.level, ch.position.z, Math.round(14 + 24 * strength), 1 + strength);
		if (this.settings.sounds !== false) this.sfx.splash(strength);
		this.targetY = this.level + (Number(this.settings.floatOffset) || -0.1) * s;
	}

	/** Stops swimming. stand = put the character on its feet (Idle). */
	public stop(stand: boolean): void
	{
		if (!this.active) return;
		this.active = false;
		this.stats.stops++;
		const ch = this.ch;
		this.ch = null;
		this.climb = null;
		const needs = this.world.realismNeeds;
		if (needs && needs.system) needs.system.swimming = false;
		if (ch)
		{
			if (ch.realismPostStep === this.hook) ch.realismPostStep = null;
			if (this.savedRay > 0) ch.rayCastLength = this.savedRay;
			ch.tiltContainer.rotation.x = 0;
			if (stand && ch.charState instanceof RealismSwimState) ch.setState(new Idle(ch));
		}
		this.pitchNow = 0;
		const wp = this.world.realismWeapons;
		if (wp && this.prevWeapon >= 0 && typeof wp.equip === 'function') { try { wp.equip(this.prevWeapon); } catch (e) { /* optional */ } }
		this.prevWeapon = -1;
		this.savedRay = 0;
	}

	/** Highest walkable ground under (x, z) between y and minY, or -Infinity. */
	private groundBelow(x: number, y: number, z: number, minY: number): number
	{
		const pw = this.world.physicsWorld;
		if (!pw || typeof pw.raycastClosest !== 'function') return -Infinity;
		this.rayFrom.set(x, y, z);
		this.rayTo.set(x, minY, z);
		this.rayRes.reset();
		if (!pw.raycastClosest(this.rayFrom, this.rayTo, this.rayOpts, this.rayRes)) return -Infinity;
		return this.rayRes.hitNormalWorld.y > 0.5 ? this.rayRes.hitPointWorld.y : -Infinity;
	}

	/** Buoyancy: vertical speed towards the float height, every physics step (gravity compensated). */
	private postStep(body: CANNON.Body): void
	{
		if (!this.active || this.climb !== null) return;
		const dy = this.targetY - body.position.y;
		let vy = dy * 3.2;
		vy = Math.max(-2.6, Math.min(2.2, vy));
		const g = this.world.physicsWorld ? -this.world.physicsWorld.gravity.y : 9.81;
		body.velocity.y = vy + g / (this.world.physicsFrameRate || 60);
	}

	// ---------------------------------------------------------------- climbing

	private tryClimb(ch: any, s: number): void
	{
		const pw = this.world.physicsWorld;
		if (!pw || typeof pw.raycastClosest !== 'function') return;
		const o = ch.orientation;
		const reach = 0.55 * s;
		const x = ch.position.x + o.x * reach, z = ch.position.z + o.z * reach;
		const maxUp = (Number(this.settings.climbHeight) || 0.9) * s;
		this.rayFrom.set(x, this.level + maxUp + 0.3, z);
		this.rayTo.set(x, this.level - 0.35, z);
		this.rayRes.reset();
		if (!pw.raycastClosest(this.rayFrom, this.rayTo, this.rayOpts, this.rayRes)) return;
		const hy = this.rayRes.hitPointWorld.y;
		if (this.rayRes.hitNormalWorld.y < 0.65) return;
		if (hy > this.level + maxUp || hy < this.level - 0.3) return;
		// only a real ledge (above the water or barely under it), and room to stand on it
		if (hy < this.level - 0.05 && this.level - hy < this.settings.exitDepth * s) { /* shallow: walking out handles it */ }
		const fx = ch.position.x, fy = ch.position.y, fz = ch.position.z;
		const tx = x + o.x * 0.25 * s, tz = z + o.z * 0.25 * s, ty = hy + 0.57 * s + 0.04;
		this.climb = { t: 0, fx: fx, fy: fy, fz: fz, tx: tx, ty: ty, tz: tz };
		ch.setPhysicsEnabled(false);
		this.stats.climbs++;
		this.emitSplash(fx, this.level, fz, 10, 0.8);
		if (this.settings.sounds !== false) this.sfx.splash(0.4);
	}

	private updateClimb(ch: any, dt: number): void
	{
		const c = this.climb;
		c.t += dt / 0.55;
		const k = Math.min(1, c.t);
		const up = Math.min(1, k * 1.8);              // first up, then forward
		const fwd = Math.max(0, (k - 0.35) / 0.65);
		ch.setPosition(c.fx + (c.tx - c.fx) * fwd, c.fy + (c.ty - c.fy) * up, c.fz + (c.tz - c.fz) * fwd);
		ch.tiltContainer.rotation.x = this.pitchNow * (1 - k);
		if (k >= 1)
		{
			ch.setPhysicsEnabled(true);
			ch.setPosition(c.tx, c.ty, c.tz);
			ch.resetVelocity();
			this.climb = null;
			this.stop(true);
		}
	}

	// --------------------------------------------------------------- animation

	private findBones(ch: any): void
	{
		if (this.bonesOf === ch) return;
		this.bones = {};
		ch.traverse((o: any) => { if (o.isBone) this.bones[o.name] = o; });
		this.bonesOf = ch;
	}

	private turn(name: string, axis: THREE.Vector3, angle: number): void
	{
		const b = this.bones[name];
		if (!b) return;
		this.q.setFromAxisAngle(axis, angle);
		b.quaternion.multiply(this.q);
	}

	/** Procedural swim strokes on top of the idle clip (runs after the mixer each frame). */
	private animate(ch: any, dt: number, fp: boolean, s: number): void
	{
		this.findBones(ch);
		const fast = ch.actions.run.isPressed ? 1.5 : 1;
		this.phase += dt * Math.PI * 2 * (0.45 + 0.35 * this.move) * fast;
		if (this.phase > Math.PI * 200) this.phase -= Math.PI * 200;
		const ph = this.phase, m = this.move;
		// front crawl (moving): each arm turns a full circle forward, half a turn apart
		// treading (idle): sculling sideways
		const crawlR = -((ph % (Math.PI * 2)));
		const crawlL = -(((ph + Math.PI) % (Math.PI * 2)));
		this.turn('arm_upperR', this.ax, crawlR * m + (1 - m) * (-0.6 + 0.25 * Math.sin(ph)));
		this.turn('arm_upperL', this.ax, crawlL * m + (1 - m) * (-0.6 + 0.25 * Math.sin(ph)));
		this.turn('arm_upperR', this.az, (1 - m) * (0.5 + 0.35 * Math.sin(ph)));
		this.turn('arm_upperL', this.az, -(1 - m) * (0.5 + 0.35 * Math.sin(ph)));
		this.turn('arm_lowerR', this.ax, -0.25 - 0.2 * m);
		this.turn('arm_lowerL', this.ax, -0.25 - 0.2 * m);
		// flutter kick
		const kick = (0.15 + 0.25 * m) * Math.sin(ph * 2 * (1 + m));
		this.turn('leg_upperR', this.ax, kick);
		this.turn('leg_upperL', this.ax, -kick);
		this.turn('leg_lowerR', this.ax, 0.2 + 0.15 * Math.max(0, Math.sin(ph * 2)));
		this.turn('leg_lowerL', this.ax, 0.2 + 0.15 * Math.max(0, -Math.sin(ph * 2)));
		// body pitch (head stays up: the float height rises with it)
		const want = fp ? 0 : (Number(this.settings.pitch) || 0.9) * m + 0.18 * (1 - m) + (this.diving ? 0.5 : 0);
		this.pitchNow += (want - this.pitchNow) * Math.min(1, dt * 3);
		ch.tiltContainer.rotation.x = this.pitchNow;
	}

	// ---------------------------------------------------------------- splashes

	private ensureSplash(): void
	{
		if (this.splash) return;
		const g = new THREE.BufferGeometry();
		const pos = new Float32Array(N_SPLASH * 3);
		for (let i = 0; i < N_SPLASH; i++) pos[i * 3 + 1] = -1e4;
		g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		const m = new THREE.PointsMaterial({ color: 0xeaf6ff, size: 0.07, transparent: true, opacity: 0.85, depthWrite: false });
		this.splash = new THREE.Points(g, m);
		this.splash.frustumCulled = false;
		this.splash.visible = false;
		this.sv = new Float32Array(N_SPLASH * 3);
		this.sLife = new Float32Array(N_SPLASH);
		this.world.graphicsWorld.add(this.splash);
	}

	public emitSplash(x: number, y: number, z: number, count: number, power: number): void
	{
		if (this.settings.splashes === false || !isFinite(y)) return;
		this.ensureSplash();
		this.stats.splashes++;
		const attr = (this.splash.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
		const arr = attr.array as Float32Array;
		let n = 0;
		for (let i = 0; i < N_SPLASH && n < count; i++)
		{
			if (this.sLife[i] > 0) continue;
			const a = Math.random() * Math.PI * 2, r = 0.15 + Math.random() * 0.35;
			arr[i * 3] = x + Math.cos(a) * r; arr[i * 3 + 1] = y + 0.02; arr[i * 3 + 2] = z + Math.sin(a) * r;
			const sp = (0.6 + Math.random() * 1.2) * power;
			this.sv[i * 3] = Math.cos(a) * sp * 0.5; this.sv[i * 3 + 1] = 1.2 * power + Math.random() * 1.6 * power; this.sv[i * 3 + 2] = Math.sin(a) * sp * 0.5;
			this.sLife[i] = 0.5 + Math.random() * 0.5;
			n++;
		}
		this.splashLive += n;
		this.splash.visible = true;
		attr.needsUpdate = true;
	}

	private updateSplash(dt: number): void
	{
		if (!this.splash || !this.splash.visible) return;
		const attr = (this.splash.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
		const arr = attr.array as Float32Array;
		let live = 0;
		for (let i = 0; i < N_SPLASH; i++)
		{
			if (this.sLife[i] <= 0) continue;
			this.sLife[i] -= dt;
			if (this.sLife[i] <= 0) { arr[i * 3 + 1] = -1e4; continue; }
			this.sv[i * 3 + 1] -= 9.8 * dt;
			arr[i * 3] += this.sv[i * 3] * dt; arr[i * 3 + 1] += this.sv[i * 3 + 1] * dt; arr[i * 3 + 2] += this.sv[i * 3 + 2] * dt;
			live++;
		}
		this.splashLive = live;
		if (live === 0) this.splash.visible = false;
		attr.needsUpdate = true;
	}
}
