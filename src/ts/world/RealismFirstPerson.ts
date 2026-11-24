/*
 * RealismFirstPerson.ts
 * ---------------------
 * First person view for San Verano County (contract C6).
 *
 *  - V toggles first / third person on foot. In a car, heli or plane V is the vehicle's own first person
 *    view (driver's eye point, own body hidden); both stay in sync, so the choice carries over when you
 *    get in or out. The last choice is saved in localStorage 'realism.firstPerson.v1';
 *    realism-config.js -> player.firstPerson is the default before you ever press V.
 *  - On foot: camera at eye height (player.eyeHeight x player scale), steady (smoothed when stepping up
 *    curbs / stairs) with a light head bob taken from the walk animation (player.headBob, 0 = off).
 *    The head is hidden (head bone scaled to zero, so its inside never shows), arms, body and legs stay
 *    visible when looking down. Mouse look with pitch limits; the body turns with the camera at once and
 *    W/A/S/D move relative to the view (sprint forwards only).
 *  - Weapons: RealismWeapons.ts view model (lower right; right mouse aims down the sights with a zoom,
 *    player.aimFov), recoil kicks the view model and camera, flash at the view model barrel, bullets
 *    from the camera centre.
 *  - Near plane 0.05 m while in first person (restored afterwards). The player capsule keeps walls at
 *    least its radius away, so the camera never ends up inside a wall.
 *  - Smooth 0.22 s blend between the third person camera and the eye. Free camera (Shift+C) still works:
 *    the first person override stops at once while it is on.
 *  - (world as any).realismFirstPerson: boolean, true while a first person view is active (on foot or in
 *    a vehicle). (world as any).realismFirstPersonControl = { enabled, set(on), toggle() }.
 *
 * Respects (world as any).realismPaused (no toggling / no animation of the blend, the camera is still
 * held at the eye so the pause menu doesn't jump the view) and realismUIBlocking (V ignored).
 * No allocations per frame.
 */

import * as THREE from 'three';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { deepMerge } from './RealismConfig';
import { DEFAULT_PLAYER } from './RealismPlayer';

const STORE_KEY = 'realism.firstPerson.v1';
const DEG = Math.PI / 180;
const HEAD_BONE_Y = 0.733;    // boxman head bone height above the feet at scale 1 (measured)
const CENTRE_Y = 0.57;        // Character origin (capsule centre) above the feet at scale 1
const FP_NEAR = 0.05;

export class FirstPersonCamera implements IUpdatable
{
	public updateOrder: number = 4.5;   // after CameraOperator (4) placed the third person camera
	public settings: any;
	public enabled = false;
	public blend = 0;                   // 0 = third person camera, 1 = eye
	public stats = { toggles: 0, vehicleSyncs: 0 };

	private world: any;
	private handlers: { target: any; type: string; fn: any }[] = [];
	private lastReceiver: any = null;
	private curVehicle: any = null;
	private vehFP = false;
	private headChar: any = null;
	private headBone: THREE.Object3D = null;
	private headScale = new THREE.Vector3(1, 1, 1);
	private lookChar: any = null;
	private baseNear = 0.1;
	private nearApplied = false;
	private baseFov = 0;
	private fovApplied = false;
	private eyeY = 0;
	private eyeInit = false;
	private bobS = 0;
	private bobPhase = 0;
	private move = 0;

	// temporaries
	private look = new THREE.Vector3();
	private lookFlat = new THREE.Vector3();
	private eye = new THREE.Vector3();
	private v1 = new THREE.Vector3();
	private v2 = new THREE.Vector3();
	private fwd = new THREE.Vector3();

	constructor(ctx: RealismCtx)
	{
		this.world = ctx.world;
		const user = (ctx.cfg as any).player;
		this.settings = deepMerge(DEFAULT_PLAYER, user && typeof user === 'object' ? user : {});
		this.world.realismFirstPersonSettings = this.settings;
		this.enabled = this.load();
		this.world.realismFirstPerson = false;
		const self = this;
		this.world.realismFirstPersonControl = {
			get enabled(): boolean { return self.enabled; },
			set(on: boolean): void { self.setEnabled(!!on); },
			toggle(): void { self.toggle(); },
		};
		this.bindInput();
		console.log('[Realism] First person ready (V toggles, starts ' + (this.enabled ? 'in first person' : 'in third person') + ')');
	}

	// -----------------------------------------------------------------------
	// settings / input
	// -----------------------------------------------------------------------

	private load(): boolean
	{
		try
		{
			const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
			if (v === '1') return true;
			if (v === '0') return false;
		}
		catch (e) { /* private mode */ }
		return this.settings.firstPerson === true;
	}

	private save(): void
	{
		try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, this.enabled ? '1' : '0'); }
		catch (e) { /* private mode */ }
	}

	public setEnabled(on: boolean): void
	{
		if (this.enabled === on) return;
		this.enabled = on;
		this.stats.toggles++;
		this.save();
		const v = this.curVehicle;
		if (v && typeof v.setFirstPersonView === 'function' && v.firstPerson !== on) { v.setFirstPersonView(on); this.vehFP = on; }
	}

	public toggle(): void { this.setEnabled(!this.enabled); }

	private bindInput(): void
	{
		if (typeof document === 'undefined' || !document.addEventListener) return;
		const fn = (e: KeyboardEvent) =>
		{
			if (e.code !== 'KeyV' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
			const t: any = e.target;
			if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
			const w = this.world;
			if (w.realismUIBlocking === true || w.realismPaused === true) return;
			const r = w.inputManager ? w.inputManager.inputReceiver : null;
			// on foot only: in a vehicle V is the vehicle's own view key (synced in update)
			if (r && r.characterCapsule !== undefined && r.controlledObject === undefined) this.toggle();
		};
		document.addEventListener('keydown', fn, false);
		this.handlers.push({ target: document, type: 'keydown', fn: fn });
	}

	// -----------------------------------------------------------------------
	// per frame
	// -----------------------------------------------------------------------

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		const w = this.world;
		const cam: THREE.PerspectiveCamera = w.camera;
		const co = w.cameraOperator;
		const im = w.inputManager;
		if (!cam || !co || !im) return;
		const paused = w.realismPaused === true;
		const dt = paused ? 0 : Math.min(0.1, Math.max(0, unscaledTimeStep !== undefined ? unscaledTimeStep : timeStep));
		const r: any = im.inputReceiver;
		const changed = r !== this.lastReceiver;
		this.lastReceiver = r;

		// ---- vehicle: keep the vehicle's own first person view in sync with ours
		// Sketchbook keeps the character as the input receiver while driving and forwards input to controlledObject
		const vo: any = r && r.characterCapsule !== undefined && r.controlledObject !== undefined ? r.controlledObject : r;
		const veh = vo && vo.seats !== undefined && vo.controllingCharacter !== undefined && typeof vo.setFirstPersonView === 'function' ? vo : null;
		if (veh !== null)
		{
			if (veh !== this.curVehicle || changed)
			{
				this.curVehicle = veh;
				if (veh.firstPerson !== this.enabled) veh.setFirstPersonView(this.enabled);
				this.vehFP = this.enabled;
				this.stats.vehicleSyncs++;
			}
			else if (veh.firstPerson !== this.vehFP && !paused)
			{
				// V pressed inside the vehicle
				this.vehFP = veh.firstPerson === true;
				if (this.enabled !== this.vehFP) { this.enabled = this.vehFP; this.stats.toggles++; this.save(); }
			}
		}
		else this.curVehicle = null;

		// ---- on foot (also while walking to / opening / climbing into or out of a vehicle)
		const ch: any = r && r.characterCapsule !== undefined && r.controlledObject === undefined && r.world !== undefined ? r : null;
		const onFoot = ch !== null && ch.occupyingSeat === null && ch.vehicleEntryInstance === null && ch.parent === w.graphicsWorld;
		if (ch !== null && ch.modelContainer && !ch.modelContainer.visible && ch.occupyingSeat === null) ch.modelContainer.visible = true;
		const wanted = this.enabled && ch !== null;
		if (ch === null) this.blend = 0;            // free camera, vehicle camera, no player
		else if (!paused) this.blend = approach(this.blend, wanted ? 1 : 0, dt / 0.22);
		const fp = ch !== null && this.blend > 0.5;
		w.realismFirstPerson = fp || (veh !== null && veh.firstPerson === true);

		// body faces the view
		const lookTarget = ch !== null && onFoot && wanted ? ch : null;
		if (this.lookChar !== null && this.lookChar !== lookTarget) this.lookChar.firstPersonLook = null;
		this.lookChar = lookTarget;

		// view direction from the camera operator angles (same convention as third person)
		const th = co.theta * DEG;
		if (fp && co.phi > 82) co.phi = 82;
		if (fp && co.phi < -82) co.phi = -82;
		const ph = co.phi * DEG;
		this.look.set(-Math.sin(th) * Math.cos(ph), -Math.sin(ph), -Math.cos(th) * Math.cos(ph));
		this.lookFlat.set(this.look.x, 0, this.look.z);
		if (this.lookFlat.lengthSq() < 1e-8) this.lookFlat.set(-Math.sin(th), 0, -Math.cos(th));
		this.lookFlat.normalize();
		if (lookTarget !== null) lookTarget.firstPersonLook = this.lookFlat;

		// head
		this.hideHead(fp ? ch : null);

		// near plane / fov
		this.applyNear(this.blend > 0.001 || (veh !== null && veh.firstPerson === true), cam);

		const weapons = w.realismWeapons;
		if (ch === null || this.blend <= 0.0001)
		{
			this.eyeInit = false;
			if (weapons && typeof weapons.setFirstPerson === 'function') weapons.setFirstPerson(false);
			this.applyFov(false, cam, weapons);
			return;
		}

		// ---- eye position
		const ms = Number(ch.modelScale) > 0 ? ch.modelScale : 1;
		const eyeH = Number(this.settings.eyeHeight) > 0 ? Number(this.settings.eyeHeight) : 0.87;
		const bobAmt = Math.max(0, Math.min(1, Number(this.settings.headBob)));
		ch.getWorldPosition(this.v1);
		const bone = this.headBone !== null && this.headChar === ch ? this.headBone : this.findHead(ch);
		if (onFoot)
		{
			// steady eye on the body, plus part of the head movement of the animation
			let target = this.v1.y + (eyeH - CENTRE_Y) * ms + (Number(ch.realismEyeDrop) || 0);   // seated / lying (RealismInteractions)
			if (bone !== null && bobAmt > 0)
			{
				bone.getWorldPosition(this.v2);
				let dl = (this.v2.y - this.v1.y) - (HEAD_BONE_Y - CENTRE_Y) * ms;
				dl = Math.max(-0.25 * ms, Math.min(0.1 * ms, dl));
				this.bobS += (dl * bobAmt - this.bobS) * (1 - Math.exp(-dt * 12));
				target += this.bobS;
			}
			if (!this.eyeInit || Math.abs(target - this.eyeY) > 0.8 * ms) this.eyeY = target;
			else this.eyeY += (target - this.eyeY) * (1 - Math.exp(-dt * 22));   // smooth step-ups
			this.eyeInit = true;
			this.eye.set(this.v1.x, this.eyeY, this.v1.z).addScaledVector(this.lookFlat, 0.06 * ms);
			// walk bob phase for the view model
			const vb = ch.characterCapsule.body.velocity;
			const sp = Math.sqrt(vb.x * vb.x + vb.z * vb.z);
			this.move += (Math.min(1, sp / (3.2 * (ch.speedFactor || 1))) - this.move) * Math.min(1, dt * 8);
			this.bobPhase = (this.bobPhase + dt * sp / (0.7 * ms) * Math.PI) % (Math.PI * 200);
		}
		else
		{
			// getting into / out of a vehicle: follow the head of the animation
			this.eyeInit = false;
			if (bone !== null)
			{
				bone.getWorldPosition(this.eye);
				ch.getWorldDirection(this.fwd);
				this.eye.y += (eyeH - HEAD_BONE_Y) * ms;
				this.eye.addScaledVector(this.fwd, 0.06 * ms);
			}
			else this.eye.set(this.v1.x, this.v1.y + (eyeH - CENTRE_Y) * ms, this.v1.z);
			this.move = 0;
		}

		// ---- camera: blend from the third person position (already set this frame) to the eye
		const b = this.blend * this.blend * (3 - 2 * this.blend);
		cam.position.lerp(this.eye, b);
		this.v2.copy(cam.position).add(this.look);
		cam.lookAt(this.v2);
		cam.updateMatrixWorld();

		this.applyFov(fp, cam, weapons);

		// ---- weapon view model (after the camera moved, so it never lags)
		if (weapons && typeof weapons.setFirstPerson === 'function')
		{
			const vmOn = fp && onFoot && w.inputManager.inputReceiver === ch;
			weapons.setFirstPerson(vmOn);
			if (vmOn) weapons.updateFirstPersonPose(cam, this.settings.viewModel, this.bobPhase, this.move);
		}
	}

	private findHead(ch: any): THREE.Object3D
	{
		if (ch.__realismHead !== undefined) return ch.__realismHead;
		let head: any = null;
		ch.traverse((o: any) => { if (head === null && (o.isBone || o.type === 'Bone') && /^head$/i.test(o.name)) head = o; });
		ch.__realismHead = head;
		return head;
	}

	/** Collapses the head of `ch` (null = restore). Runs after the animation mixer each frame. */
	private hideHead(ch: any): void
	{
		if (this.headChar !== null && this.headChar !== ch)
		{
			if (this.headBone !== null) this.headBone.scale.copy(this.headScale);
			this.headChar = null; this.headBone = null;
		}
		if (ch === null) return;
		if (this.headChar !== ch)
		{
			this.headChar = ch;
			this.headBone = this.findHead(ch);
			if (this.headBone !== null) this.headScale.copy(this.headBone.scale);
		}
		if (this.headBone !== null) this.headBone.scale.set(0.0001, 0.0001, 0.0001);
	}

	private applyNear(on: boolean, cam: THREE.PerspectiveCamera): void
	{
		if (on && !this.nearApplied)
		{
			this.baseNear = cam.near;
			this.nearApplied = true;
			if (cam.near > FP_NEAR) { cam.near = FP_NEAR; cam.updateProjectionMatrix(); }
		}
		else if (!on && this.nearApplied)
		{
			this.nearApplied = false;
			if (cam.near !== this.baseNear) { cam.near = this.baseNear; cam.updateProjectionMatrix(); }
		}
	}

	/** Optional first person field of view (player.fov). Left alone while the weapons zoom. */
	private applyFov(on: boolean, cam: THREE.PerspectiveCamera, weapons: any): void
	{
		const f = Number(this.settings.fov);
		if (!(f > 0)) return;
		const zooming = weapons && typeof weapons.currentWeapon === 'function' && (weapons as any).zoomBlend > 0.001;
		if (zooming) return;
		if (on)
		{
			if (!this.fovApplied) { this.baseFov = cam.fov; this.fovApplied = true; }
			if (cam.fov !== f) { cam.fov = f; cam.updateProjectionMatrix(); }
		}
		else if (this.fovApplied)
		{
			this.fovApplied = false;
			if (cam.fov !== this.baseFov) { cam.fov = this.baseFov; cam.updateProjectionMatrix(); }
		}
	}

	public dispose(): void
	{
		for (let i = 0; i < this.handlers.length; i++)
		{
			const h = this.handlers[i];
			try { h.target.removeEventListener(h.type, h.fn, false); } catch (e) { /* ignore */ }
		}
		this.handlers = [];
		this.hideHead(null);
		if (this.lookChar !== null) this.lookChar.firstPersonLook = null;
	}
}

function approach(v: number, target: number, step: number): number
{
	return v < target ? Math.min(target, v + step) : Math.max(target, v - step);
}
