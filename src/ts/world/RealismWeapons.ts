/*
 * RealismWeapons.ts
 * -----------------
 * Weapons for San Verano County.
 *
 *  - 5 slots (default 1 Fists, 2 Pistol, 3 SMG, 4 Shotgun, 5 Rifle), set in realism-config.js -> weapons.slots.
 *    Each weapon: damage, fireRate (rounds / min), auto, magazine, reserve, reloadTime, spread, aimSpread,
 *    range, recoil, pellets, impulse. Your own weapons can be added under any name with `kind` set to one of
 *    pistol / smg / shotgun / rifle / fists and listed in `slots`.
 *  - Tab: weapon wheel (RealismWeaponWheel.ts). Hold Tab, point, release (or click). A quick tap keeps it open
 *    until you click a slot or press Tab again. 1..5 switch directly. Esc / right click closes it.
 *  - Right mouse (hold): aim. Over-the-shoulder camera, slight zoom, the character faces the aim direction and
 *    strafes, arms point the gun at the crosshair. Left mouse: fire (hip fire also works). R: reload.
 *  - Hitscan from the screen centre against the physics world (cannon raycastClosest) and NPCs through
 *    (world as any).realismNPCs.hitTest(origin, dir, maxDist) -> { distance, point, npc } and
 *    .damage(npc, amount, dir) when that system exists.
 *  - Recoil (camera kick + recovery, weapon kick back), muzzle flash (additive quads + 1 pooled point light,
 *    'auto' = only on presets that already use point lights), bullet holes (1 instanced mesh), sparks
 *    (1 instanced mesh), tracers (1 line mesh). Total: 4 extra draw calls at most, nothing allocated per shot.
 *  - Procedural audio (RealismAudio.ts) or your files: weapons.<name>.sounds.{ shot, reload, empty }.
 *  - 3D models: built-in low-poly ones (RealismWeaponModels.ts) or weapons.<name>.model (.glb).
 *    Held in the right hand (boxman bone arm_lower.R), hidden in vehicles.
 *  - Player scale (RealismPlayer.ts, config player.scale): weapon size (weapons.scale is for a scale 1
 *    character), aim camera offsets and punch reach are multiplied by the character's size.
 *  - First person (RealismFirstPerson.ts): a view model in front of the camera (lower right), right mouse
 *    lines the sights up with the screen centre and zooms, recoil kicks the view model and the camera,
 *    reload / swap dip the view model, the arms reach for the gun, muzzle flash and tracers start at the
 *    view model barrel, bullets still go from the camera centre. Per kind settings: player.viewModel.
 *
 * Input rules: nothing reacts while (world as any).realismUIBlocking === true (another menu is open) or
 * (world as any).realismPaused === true. While the wheel is open, the game gets no key presses and
 * (world as any).realismSetUIBlocking('weaponWheel', true) is called when it exists.
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { deepMerge } from './RealismConfig';
import { WeaponAudio, ReloadKind } from './RealismAudio';
import { WeaponWheel, WeaponHud, WheelSlot } from './RealismWeaponWheel';
import { buildWeaponGeometry, weaponMaterial, loadWeaponModel, buildMuzzleFlash, WeaponModelInfo } from './RealismWeaponModels';

const DEG = Math.PI / 180;

export interface WeaponDef
{
	id: string;
	kind: string;            // fists | pistol | smg | shotgun | rifle
	name: string;
	damage: number;          // per bullet / pellet / punch
	fireRate: number;        // rounds per minute
	auto: boolean;           // hold to keep firing
	magazine: number;
	reserve: number;         // spare rounds you start with
	reloadTime: number;      // seconds
	spread: number;          // degrees, hip fire
	aimSpread: number;       // degrees, aiming
	range: number;           // metres
	recoil: number;          // degrees of camera kick per shot
	pellets: number;         // shotgun pellets per shot
	impulse: number;         // push given to loose physics objects
	flashSize: number;       // muzzle flash size, metres
	model?: string;          // your .glb
	scale?: number | number[];
	rotation?: number[];     // degrees
	offset?: number[];       // metres
	muzzle?: number[];       // barrel end for your .glb, weapon space
	sounds?: { shot?: string; reload?: string; empty?: string };
}

/** Defaults. Everything here can be overridden in realism-config.js -> weapons. */
export const DEFAULT_WEAPONS: any = {
	slots: ['fists', 'pistol', 'smg', 'shotgun', 'rifle'],
	scale: 0.62,               // weapon size relative to real size for a scale 1 character (about 1.02 m), x player.scale
	handRotation: [-90, 0, 0], // degrees: how the gun sits in the hand when not aiming (barrel along the forearm)
	handOffset: 0.45,          // where the hand is along the forearm bone (bone units)
	volume: 1,
	infiniteAmmo: false,
	muzzleLight: 'auto',       // true | false | 'auto' (off on presets with no point lights)
	tracers: true,
	decals: 24,                // bullet holes kept at once
	aimFov: 0.82,              // camera field of view multiplier while aiming
	aimDistance: 1.05,         // camera distance while aiming (normal is 1.6)
	shoulder: [0.42, 0.16],    // camera offset while aiming: right, up (metres)
	fists:   { kind: 'fists',   name: 'Fists',   damage: 12, fireRate: 130, auto: false, magazine: 0,  reserve: 0,   reloadTime: 0,   spread: 0,   aimSpread: 0,   range: 1.4, recoil: 0,   pellets: 1, impulse: 30,  flashSize: 0 },
	pistol:  { kind: 'pistol',  name: 'Service Pistol (Glock 19)', damage: 26, fireRate: 360, auto: false, magazine: 15, reserve: 90,  reloadTime: 1.4, spread: 2.2, aimSpread: 0.6, range: 90,  recoil: 2.2, pellets: 1, impulse: 60,  flashSize: 0.13 },
	smg:     { kind: 'smg',     name: 'SMG',     damage: 17, fireRate: 850, auto: true,  magazine: 30, reserve: 180, reloadTime: 1.8, spread: 3.5, aimSpread: 1.3, range: 70,  recoil: 1.1, pellets: 1, impulse: 40,  flashSize: 0.14 },
	shotgun: { kind: 'shotgun', name: 'Shotgun', damage: 14, fireRate: 70,  auto: false, magazine: 6,  reserve: 36,  reloadTime: 2.6, spread: 6.5, aimSpread: 4.5, range: 35,  recoil: 5.5, pellets: 8, impulse: 35,  flashSize: 0.24 },
	rifle:   { kind: 'rifle',   name: 'Rifle',   damage: 34, fireRate: 600, auto: true,  magazine: 30, reserve: 180, reloadTime: 2.2, spread: 2.8, aimSpread: 0.35, range: 220, recoil: 1.6, pellets: 1, impulse: 90,  flashSize: 0.18 },
};

/**
 * First person view model per weapon kind (realism-config.js -> player.viewModel overrides it):
 *   hip: [right, up, forward] metres from the eye to the grip, for a real size gun (x weapon size)
 *   ads: distance from the eye to the rear sight while aiming
 */
export const DEFAULT_VIEWMODEL: any = {
	pistol:  { hip: [0.15, -0.16, 0.40], ads: 0.40 },
	smg:     { hip: [0.14, -0.17, 0.32], ads: 0.20 },
	shotgun: { hip: [0.14, -0.18, 0.30], ads: 0.12 },
	rifle:   { hip: [0.14, -0.18, 0.30], ads: 0.16 },
};

interface WeaponState { mag: number; reserve: number; }
interface Visual { holder: THREE.Group; kick: THREE.Group; info: WeaponModelInfo; }
interface Arms { upperR: THREE.Object3D; lowerR: THREE.Object3D; upperL: THREE.Object3D; lowerL: THREE.Object3D; }
interface Spark { life: number; p: THREE.Vector3; v: THREE.Vector3; }

const MAX_SPARKS = 16;
const MAX_TRACERS = 8;

export class WeaponSystem implements IUpdatable
{
	public updateOrder: number = 3.5;     // after InputManager (3) sets the camera target, before CameraOperator (4)
	public settings: any;
	public defs: WeaponDef[] = [];
	public ammo: WeaponState[] = [];
	public current = 0;
	public audio: WeaponAudio;
	public stats = { shots: 0, hits: 0, npcHits: 0, reloads: 0, switches: 0 };

	private ctx: RealismCtx;
	private world: any;
	private wheel: WeaponWheel;
	private hud: WeaponHud;
	private now = 0;

	// input
	private triggerHeld = false;
	private triggerPressed = false;   // a new click this frame (semi-auto)
	private aimHeld = false;
	private wheelWasLocked = false;
	private wheelToggle = false;
	private handlers: { target: any; type: string; fn: any; capture: boolean }[] = [];

	// weapon state
	private fireCooldown = 0;
	private equipTimer = 0;
	private reloadTimer = 0;
	private reloadTotal = 0;
	private hipTimer = 0;
	private bloom = 0;
	private recoilDebt = 0;
	private lastShot = -10;
	private kick = 0;
	private armBlend = 0;
	private zoomBlend = 0;
	private camApplied = false;
	private baseRadius = 1.6;
	private baseFov = 75;

	// visuals
	private root: THREE.Group;
	private visuals: { [id: string]: Visual } = {};
	private flash: THREE.Mesh;
	private flashTimer = 0;
	private light: THREE.PointLight = null;
	private decals: THREE.InstancedMesh = null;
	private decalNext = 0;
	private sparks: THREE.InstancedMesh = null;
	private sparkList: Spark[] = [];
	private sparksAlive = 0;
	private tracer: THREE.LineSegments = null;
	private tracerPos: Float32Array;
	private tracerCount = 0;
	private tracerTimer = 0;
	private holdQ = new THREE.Quaternion();
	private player: any = null;

	// first person view model (RealismFirstPerson.ts drives it after the camera is placed)
	private fpActive = false;
	private fpPos = new THREE.Vector3(); private fpTarget = new THREE.Vector3(); private fpGrip = new THREE.Vector3();
	private fpQ = new THREE.Quaternion(); private fpM = new THREE.Matrix4(); private fpPush = 0;
	private fpEuler = new THREE.Euler();

	// temporaries
	private v1 = new THREE.Vector3(); private v2 = new THREE.Vector3(); private v3 = new THREE.Vector3();
	private camPos = new THREE.Vector3(); private camDir = new THREE.Vector3();
	private hand = new THREE.Vector3(); private aimPoint = new THREE.Vector3(); private muzzleW = new THREE.Vector3();
	private q1 = new THREE.Quaternion(); private q2 = new THREE.Quaternion(); private q3 = new THREE.Quaternion();
	private qId = new THREE.Quaternion();
	private m1 = new THREE.Matrix4(); private m2 = new THREE.Matrix4();
	private pa1 = new THREE.Vector3(); private pa2 = new THREE.Vector3(); private pa3 = new THREE.Vector3(); private support = new THREE.Vector3(); private sc = new THREE.Vector3();
	private up = new THREE.Vector3(0, 1, 0);
	private zAxis = new THREE.Vector3(0, 0, 1);
	private yAxis = new THREE.Vector3(0, 1, 0);
	private rayResult = new CANNON.RaycastResult();
	private rFrom = new CANNON.Vec3(); private rTo = new CANNON.Vec3();
	private aimDir = new THREE.Vector3();

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		const user = (ctx.cfg as any).weapons;
		this.settings = deepMerge(DEFAULT_WEAPONS, user && typeof user === 'object' ? user : {});
		this.readDefs();
		const hr = this.settings.handRotation || [-90, 0, 0];
		this.holdQ.setFromEuler(new THREE.Euler((hr[0] || 0) * DEG, (hr[1] || 0) * DEG, (hr[2] || 0) * DEG));

		this.audio = new WeaponAudio(this.world, Number(this.settings.volume));
		for (let i = 0; i < this.defs.length; i++)
		{
			const snd = this.defs[i].sounds;
			if (snd) { this.audio.preload(snd.shot); this.audio.preload(snd.reload); this.audio.preload(snd.empty); }
		}
		this.hud = new WeaponHud();
		this.wheel = new WeaponWheel((i) => this.closeWheel(i), () => this.closeWheel(-1));
		this.buildVisuals();
		this.bindInput();
		this.world.realismWeapons = this;
		console.log('[Realism] Weapons ready: ' + this.defs.map((d, i) => (i + 1) + ' ' + d.name).join(', ') + '  (Tab wheel, 1-5, RMB aim, LMB fire, R reload)');
	}

	// -----------------------------------------------------------------------
	// config
	// -----------------------------------------------------------------------

	private readDefs(): void
	{
		const s = this.settings;
		let slots: string[] = Array.isArray(s.slots) ? s.slots.slice(0, 5) : DEFAULT_WEAPONS.slots.slice();
		if (slots.length === 0) slots = DEFAULT_WEAPONS.slots.slice();
		for (let i = 0; i < slots.length; i++)
		{
			const id = String(slots[i]);
			const own = s[id] && typeof s[id] === 'object' ? s[id] : {};
			const kind = own.kind || (DEFAULT_WEAPONS[id] ? DEFAULT_WEAPONS[id].kind : 'pistol');
			const base = DEFAULT_WEAPONS[kind] || DEFAULT_WEAPONS.pistol;
			const d: WeaponDef = deepMerge(base, own);
			d.id = id;
			d.kind = kind;
			if (!d.name) d.name = id;
			d.magazine = Math.max(0, Math.floor(Number(d.magazine) || 0));
			d.reserve = Math.max(0, Math.floor(Number(d.reserve) || 0));
			d.fireRate = Math.max(1, Number(d.fireRate) || 60);
			d.pellets = Math.max(1, Math.floor(Number(d.pellets) || 1));
			this.defs.push(d);
			this.ammo.push({ mag: d.magazine, reserve: d.reserve });
		}
	}

	private get def(): WeaponDef { return this.defs[this.current]; }
	private isGun(d: WeaponDef): boolean { return d.kind !== 'fists'; }

	// -----------------------------------------------------------------------
	// visuals
	// -----------------------------------------------------------------------

	private buildVisuals(): void
	{
		const scene: THREE.Scene = this.world.graphicsWorld;
		this.root = new THREE.Group();
		this.root.name = 'RealismWeapon';
		this.root.visible = false;
		scene.add(this.root);

		this.flash = buildMuzzleFlash();

		// muzzle light (1, pooled). Kept in the scene at intensity 0 so shaders never recompile.
		const ml = this.settings.muzzleLight;
		const presetLights = this.ctx.preset ? Number((this.ctx.preset as any).pointLights) || 0 : 0;
		if (ml === true || (ml === 'auto' && presetLights > 0))
		{
			this.light = new THREE.PointLight(0xffb060, 0, 7, 2);
			this.light.castShadow = false;
			scene.add(this.light);
		}

		// bullet holes
		const nDec = Math.max(0, Math.min(64, Math.floor(Number(this.settings.decals) || 0)));
		if (nDec > 0)
		{
			const g = new THREE.CircleBufferGeometry(0.03, 6);
			const m = new THREE.MeshBasicMaterial({ color: 0x141414, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
			this.decals = new THREE.InstancedMesh(g, m, nDec);
			this.decals.frustumCulled = false;
			const zero = new THREE.Matrix4().makeScale(0, 0, 0);
			for (let i = 0; i < nDec; i++) this.decals.setMatrixAt(i, zero);
			this.decals.instanceMatrix.needsUpdate = true;
			this.decals.visible = false;
			scene.add(this.decals);
		}

		// sparks
		const sg = new THREE.BoxBufferGeometry(0.018, 0.018, 0.05);
		const sm = new THREE.MeshBasicMaterial({ color: 0xffd27a, fog: false });
		this.sparks = new THREE.InstancedMesh(sg, sm, MAX_SPARKS);
		this.sparks.frustumCulled = false;
		this.sparks.visible = false;
		for (let i = 0; i < MAX_SPARKS; i++) this.sparkList.push({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3() });
		scene.add(this.sparks);

		// tracers
		if (this.settings.tracers !== false)
		{
			this.tracerPos = new Float32Array(MAX_TRACERS * 6);
			const tg = new THREE.BufferGeometry();
			tg.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3));
			const tm = new THREE.LineBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0.55, depthWrite: false, fog: false });
			this.tracer = new THREE.LineSegments(tg, tm);
			this.tracer.frustumCulled = false;
			this.tracer.visible = false;
			scene.add(this.tracer);
		}
	}

	/** Builds (once) the model for weapon slot i. */
	private visualFor(i: number): Visual
	{
		const d = this.defs[i];
		if (!this.isGun(d)) return null;
		let v = this.visuals[d.id];
		if (v) return v;
		const built = buildWeaponGeometry(d.kind);
		const holder = new THREE.Group();
		const kick = new THREE.Group();
		holder.add(kick);
		const mesh = new THREE.Mesh(built.geom, weaponMaterial(this.ctx));
		mesh.castShadow = false; mesh.receiveShadow = false;
		kick.add(mesh);
		const info = built.info;
		if (d.model)
		{
			if (Array.isArray(d.muzzle)) info.muzzle.set(Number(d.muzzle[0]) || 0, Number(d.muzzle[1]) || 0, Number(d.muzzle[2]) || 0);
			const sg: any = (d as any).sight;
			if (Array.isArray(sg)) info.sight = new THREE.Vector3(Number(sg[0]) || 0, Number(sg[1]) || 0, Number(sg[2]) || 0);
			else if (Array.isArray(d.muzzle)) info.sight = new THREE.Vector3(info.muzzle.x, info.muzzle.y + 0.02, 0);
			loadWeaponModel(this.ctx, d, kick, mesh);
		}
		holder.visible = false;
		this.root.add(holder);
		v = { holder: holder, kick: kick, info: info };
		this.visuals[d.id] = v;
		return v;
	}

	private findArms(ch: any): Arms
	{
		if (ch.__realismArms !== undefined) return ch.__realismArms;
		const a: any = { upperR: null, lowerR: null, upperL: null, lowerL: null };
		ch.traverse((o: any) =>
		{
			if (!o.isBone && o.type !== 'Bone' && !/arm_/.test(o.name)) return;
			if (o.name === 'arm_upper.R' || o.name === 'arm_upperR') a.upperR = o;
			else if (o.name === 'arm_lower.R' || o.name === 'arm_lowerR') a.lowerR = o;
			else if (o.name === 'arm_upper.L' || o.name === 'arm_upperL') a.upperL = o;
			else if (o.name === 'arm_lower.L' || o.name === 'arm_lowerL') a.lowerL = o;
		});
		const arms: Arms = a.lowerR ? a : null;
		if (!arms) console.warn('[Realism] Weapons: no arm_lower.R bone on the character, the weapon is held at the chest.');
		ch.__realismArms = arms;
		return arms;
	}

	// -----------------------------------------------------------------------
	// input
	// -----------------------------------------------------------------------

	private on(target: any, type: string, fn: any, capture: boolean): void
	{
		if (!target || !target.addEventListener) return;
		target.addEventListener(type, fn, capture);
		this.handlers.push({ target: target, type: type, fn: fn, capture: capture });
	}

	private canvas(): any
	{
		return this.world.renderer ? this.world.renderer.domElement : null;
	}

	private pointerLocked(): boolean
	{
		if (!this.world.params || !this.world.params.Pointer_Lock) return true;   // pointer lock turned off in settings
		return typeof document !== 'undefined' && document.pointerLockElement === this.canvas();
	}

	private blockedByOthers(): boolean
	{
		const w = this.world;
		return (w.realismUIBlocking === true && !this.wheel.isOpen) || w.realismPaused === true;
	}

	private bindInput(): void
	{
		if (typeof window === 'undefined' || typeof document === 'undefined') return;
		const canvas = this.canvas();
		const isTyping = (e: any) =>
		{
			const t = e && e.target;
			return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
		};

		this.on(window, 'keydown', (e: KeyboardEvent) =>
		{
			if (isTyping(e)) return;
			const code = e.code;
			if (this.wheel.isOpen)
			{
				if (code === 'Tab')
				{
					e.preventDefault(); e.stopPropagation();
					if (!e.repeat && this.wheelToggle) this.closeWheel(this.wheel.hover);
					return;
				}
				if (code === 'Escape') { e.stopPropagation(); this.closeWheel(-1); return; }
				const n = digit(code);
				if (n >= 0 && n < this.defs.length) { e.preventDefault(); e.stopPropagation(); this.closeWheel(n); return; }
				e.stopPropagation();   // the game gets nothing while the wheel is open
				return;
			}
			if (code === 'Tab')
			{
				e.preventDefault();    // no browser focus change
				if (!e.repeat && !this.blockedByOthers()) this.openWheel();
				return;
			}
			if (e.repeat || this.blockedByOthers()) return;
			const n = digit(code);
			if (n >= 0 && n < this.defs.length) { if (this.activePlayer() !== null) this.equip(n); return; }
			if (code === 'KeyR' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)
			{
				const law: any = this.world.realismLawEnforcement;
				if (law && typeof law.usesVehicleRadioKey === 'function' && law.usesVehicleRadioKey()) return;
				if (this.activePlayer() !== null) this.startReload();
			}
		}, true);

		this.on(window, 'keyup', (e: KeyboardEvent) =>
		{
			if (e.code !== 'Tab') return;
			e.preventDefault();
			if (!this.wheel.isOpen || this.wheelToggle) return;
			if (this.wheel.hover >= 0) { this.closeWheel(this.wheel.hover); return; }
			if (this.now - this.wheel.openedAt < 0.3) { this.wheelToggle = true; return; }   // quick tap: stays open
			this.closeWheel(-1);
		}, true);

		if (canvas)
		{
			this.on(canvas, 'mousedown', (e: MouseEvent) =>
			{
				// pointerLockElement is still null on the click that asks for the lock, so that click never fires
				if (this.wheel.isOpen || this.blockedByOthers() || !this.pointerLocked()) return;
				if (e.button === 0) { this.triggerHeld = true; this.triggerPressed = true; }
				else if (e.button === 2) this.aimHeld = true;
			}, false);
			this.on(canvas, 'contextmenu', (e: Event) => e.preventDefault(), false);
		}
		this.on(document, 'mouseup', (e: MouseEvent) =>
		{
			if (e.button === 0) this.triggerHeld = false;
			else if (e.button === 2) this.aimHeld = false;
		}, false);
		this.on(document, 'pointerlockchange', () =>
		{
			if (!this.pointerLocked()) { this.triggerHeld = false; this.aimHeld = false; }
		}, false);
		this.on(window, 'blur', () => { this.triggerHeld = false; this.aimHeld = false; if (this.wheel.isOpen) this.closeWheel(-1); }, false);
	}

	private setBlocking(on: boolean): void
	{
		const w = this.world;
		w.realismWeaponWheelOpen = on;
		try { if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking('weaponWheel', on); }
		catch (e) { console.warn('[Realism] realismSetUIBlocking failed', e); }
	}

	private openWheel(): void
	{
		const p = this.activePlayer();
		if (p === null || !this.controls(p)) return;
		this.wheelToggle = false;
		this.triggerHeld = false;
		this.aimHeld = false;
		const canvas = this.canvas();
		this.wheelWasLocked = !!(canvas && typeof document !== 'undefined' && document.pointerLockElement === canvas);
		this.setBlocking(true);   // first, so the pause menu doesn't open when the mouse is released
		if (this.wheelWasLocked) { try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
		try { if (typeof p.resetControls === 'function') p.resetControls(); } catch (e) { /* ignore */ }
		this.wheel.open(this.wheelSlots(), this.current, this.now);
	}

	/** Closes the wheel; `pick` >= 0 equips that slot. */
	public closeWheel(pick: number): void
	{
		if (!this.wheel.isOpen) return;
		this.wheel.close();
		this.wheelToggle = false;
		this.setBlocking(false);
		if (pick >= 0 && pick < this.defs.length) this.equip(pick);
		const canvas = this.canvas();
		if (this.wheelWasLocked && canvas && this.world.params && this.world.params.Pointer_Lock)
		{
			try
			{
				const r: any = canvas.requestPointerLock();
				if (r && typeof r.catch === 'function') r.catch(() => { /* user clicks the game to lock again */ });
			}
			catch (e) { /* user clicks the game to lock again */ }
		}
		this.wheelWasLocked = false;
	}

	private wheelSlots(): WheelSlot[]
	{
		const out: WheelSlot[] = [];
		for (let i = 0; i < this.defs.length; i++)
		{
			const d = this.defs[i], a = this.ammo[i];
			const gun = this.isGun(d);
			out.push({
				id: d.id, name: d.name, icon: ['fists', 'pistol', 'smg', 'shotgun', 'rifle'].indexOf(d.kind) >= 0 ? d.kind : 'pistol',
				ammo: gun ? a.mag + ' / ' + (this.settings.infiniteAmmo ? '\u221e' : a.reserve) : '',
				empty: gun && a.mag === 0 && a.reserve === 0 && !this.settings.infiniteAmmo,
			});
		}
		return out;
	}

	// -----------------------------------------------------------------------
	// player
	// -----------------------------------------------------------------------

	/** The character the user plays (also while in free camera), or null. */
	private findPlayer(): any
	{
		const w = this.world;
		const r: any = w.inputManager ? w.inputManager.inputReceiver : null;
		if (r && r.characterCapsule !== undefined && r.position) return r;
		if (r && r.controllingCharacter) return r.controllingCharacter;
		if (w.cameraOperator && w.cameraOperator.characterCaller) return w.cameraOperator.characterCaller;
		return null;
	}

	private onFoot(ch: any): boolean
	{
		if (!ch || ch.characterCapsule === undefined) return false;
		return !ch.occupyingSeat && ch.controlledObject === undefined && !ch.vehicleEntryInstance;
	}

	/** True when the user is steering this character (not the free camera). */
	private controls(ch: any): boolean
	{
		const im = this.world.inputManager;
		return !!im && im.inputReceiver === ch;
	}

	private activePlayer(): any
	{
		const p = this.findPlayer();
		return p !== null && this.onFoot(p) ? p : null;
	}

	// -----------------------------------------------------------------------
	// actions
	// -----------------------------------------------------------------------

	public equip(i: number): void
	{
		if (i < 0 || i >= this.defs.length || i === this.current) return;
		this.current = i;
		this.reloadTimer = 0;
		this.equipTimer = this.isGun(this.def) ? 0.35 : 0.15;
		this.triggerHeld = false;
		this.bloom = 0;
		this.stats.switches++;
		this.audio.equip(this.def.kind);
		this.hud.message(this.def.name, this.now, 0.9);
	}

	/** Equips by weapon id ('rifle'). */
	public equipById(id: string): void
	{
		for (let i = 0; i < this.defs.length; i++) if (this.defs[i].id === id) { this.equip(i); return; }
	}

	/** Adds spare ammo to a weapon id. */
	public giveAmmo(id: string, rounds: number): void
	{
		for (let i = 0; i < this.defs.length; i++) if (this.defs[i].id === id) this.ammo[i].reserve += Math.max(0, Math.floor(rounds));
	}

	public currentWeapon(): { id: string; name: string; mag: number; reserve: number; reloading: boolean; aiming: boolean }
	{
		const d = this.def, a = this.ammo[this.current];
		return { id: d.id, name: d.name, mag: a.mag, reserve: a.reserve, reloading: this.reloadTimer > 0, aiming: this.zoomBlend > 0.5 };
	}

	/** For NPC gunfire: plays a shot of `kind` heard from `pos` (THREE.Vector3). */
	public playShotAt(kind: string, pos: THREE.Vector3): void
	{
		const cam = this.world.camera;
		const d = cam && pos ? cam.position.distanceTo(pos) : 0;
		this.audio.shot(kind, undefined, d);
	}

	public startReload(): void
	{
		const d = this.def, a = this.ammo[this.current];
		if (!this.isGun(d) || this.reloadTimer > 0 || a.mag >= d.magazine) return;
		if (a.reserve <= 0 && !this.settings.infiniteAmmo) { this.hud.message('No ammo', this.now); return; }
		this.reloadTotal = Math.max(0.2, Number(d.reloadTime) || 1.5);
		this.reloadTimer = this.reloadTotal;
		this.triggerHeld = false;
		this.stats.reloads++;
		this.audio.reload(d.kind as ReloadKind, this.reloadTotal, d.sounds ? d.sounds.reload : undefined, d.magazine - a.mag);
	}

	private finishReload(): void
	{
		const d = this.def, a = this.ammo[this.current];
		const need = d.magazine - a.mag;
		const take = this.settings.infiniteAmmo ? need : Math.min(need, a.reserve);
		a.mag += take;
		if (!this.settings.infiniteAmmo) a.reserve -= take;
	}

	private tryFire(p: any): void
	{
		const d = this.def;
		if (this.fireCooldown > 0 || this.equipTimer > 0 || this.reloadTimer > 0) return;
		const pressed = this.triggerPressed;
		if (!d.auto && !pressed) return;
		this.triggerPressed = false;
		if (pressed) this.fireCooldown = 0;
		this.fireCooldown += 60 / d.fireRate;

		if (!this.isGun(d)) { this.punch(p); return; }

		const a = this.ammo[this.current];
		if (a.mag <= 0)
		{
			if (pressed) this.audio.dryFire(d.sounds ? d.sounds.empty : undefined);
			this.triggerHeld = false;
			if (a.reserve > 0 || this.settings.infiniteAmmo) this.startReload();
			else if (pressed) this.hud.message('No ammo', this.now);
			return;
		}
		a.mag--;
		this.stats.shots++;
		this.lastShot = this.now;
		this.hipTimer = 0.7;

		const aiming = this.zoomBlend > 0.5;
		const spreadDeg = (aiming ? d.aimSpread : d.spread) + this.bloom;
		const cam: THREE.PerspectiveCamera = this.world.camera;
		cam.getWorldPosition(this.camPos);
		cam.getWorldDirection(this.camDir);
		// start the ray level with the player, so walls behind the character are never hit
		const along = Math.max(0, this.v1.copy(p.position).sub(this.camPos).dot(this.camDir));
		const origin = this.v2.copy(this.camPos).addScaledVector(this.camDir, along);

		this.tracerCount = 0;
		const muzzle = this.muzzleWorld();
		const combatShots: any[] = [];
		for (let k = 0; k < d.pellets; k++)
		{
			const dir = this.v3.copy(this.camDir);
			if (spreadDeg > 0) coneJitter(dir, spreadDeg * DEG, this.q1);
			combatShots.push({
				origin: { x: origin.x, y: origin.y, z: origin.z },
				direction: { x: dir.x, y: dir.y, z: dir.z },
				range: Math.max(1, Number(d.range) || 50),
				damage: Number(d.damage) || 0,
			});
			const end = this.shootRay(origin, dir, d);
			if (this.tracer !== null && this.tracerCount < MAX_TRACERS && (k === 0 || d.pellets <= MAX_TRACERS))
			{
				const o = this.tracerCount * 6;
				// tracer starts a little in front of the muzzle, so it never covers the flash
				this.tracerPos[o] = muzzle.x + dir.x * 0.4; this.tracerPos[o + 1] = muzzle.y + dir.y * 0.4; this.tracerPos[o + 2] = muzzle.z + dir.z * 0.4;
				this.tracerPos[o + 3] = end.x; this.tracerPos[o + 4] = end.y; this.tracerPos[o + 5] = end.z;
				this.tracerCount++;
			}
		}
		this.broadcastCombatShots(combatShots);
		if (this.tracer !== null && this.tracerCount > 0)
		{
			const attr = (this.tracer.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
			attr.needsUpdate = true;
			(this.tracer.geometry as THREE.BufferGeometry).setDrawRange(0, this.tracerCount * 2);
			this.tracer.visible = true;
			this.tracerTimer = 0.045;
		}

		// recoil
		const co = this.world.cameraOperator;
		const r = Number(d.recoil) || 0;
		if (co && r > 0 && this.controls(p))
		{
			const up = r * (aiming ? 0.75 : 1) * (0.85 + Math.random() * 0.3);
			co.phi = Math.max(-85, co.phi - up);
			co.theta += (Math.random() - 0.5) * r * 0.5;
			this.recoilDebt += up;
		}
		this.bloom = Math.min(this.bloom + r * 0.35, Math.max(2, d.spread * 1.5));
		this.kick = 1;
		this.flashTimer = 0.05;
		this.flash.rotation.z = Math.random() * Math.PI;
		this.audio.shot(d.kind, d.sounds ? d.sounds.shot : undefined);
	}

	private shotEnd = new THREE.Vector3();
	private hitPoint = new THREE.Vector3();
	private hitNormal = new THREE.Vector3();

	/** One bullet / pellet. Returns where it ended (for the tracer). */
	private shootRay(origin: THREE.Vector3, dir: THREE.Vector3, d: WeaponDef): THREE.Vector3
	{
		const range = Math.max(1, Number(d.range) || 50);
		this.rFrom.set(origin.x, origin.y, origin.z);
		this.rTo.set(origin.x + dir.x * range, origin.y + dir.y * range, origin.z + dir.z * range);
		this.rayResult.reset();
		let physDist = Infinity;
		const pw: any = this.world.physicsWorld;
		try
		{
			// everything except characters (group 2)
			// tslint:disable-next-line: no-bitwise
			if (pw && pw.raycastClosest(this.rFrom, this.rTo, { collisionFilterMask: ~2, skipBackfaces: true }, this.rayResult) && this.rayResult.hasHit)
			{
				physDist = this.rayResult.distance;
			}
		}
		catch (e) { physDist = Infinity; }

		let npcHit: any = null;
		const npcs = this.world.realismNPCs;
		if (npcs && typeof npcs.hitTest === 'function')
		{
			try { npcHit = npcs.hitTest(origin.clone(), dir.clone(), Math.min(range, physDist)); } catch (e) { npcHit = null; }
			if (npcHit && !(typeof npcHit.distance === 'number' && npcHit.distance <= physDist)) npcHit = null;
		}

		const dist = npcHit ? npcHit.distance : physDist;
		const falloff = dist < range * 0.5 ? 1 : 1 - 0.5 * Math.min(1, (dist - range * 0.5) / (range * 0.5));
		const dmg = (Number(d.damage) || 0) * falloff;

		if (npcHit)
		{
			this.stats.npcHits++;
			let killed = false;
			try
			{
				if (typeof npcs.damage === 'function')
				{
					const r = npcs.damage(npcHit.npc, dmg, dir.clone());
					killed = r === true || !!(r && (r.killed || r.dead));
				}
			}
			catch (e) { console.warn('[Realism] realismNPCs.damage threw', e); }
			this.hud.hitMarker(this.now, killed);
			if (npcHit.point && typeof npcHit.point.x === 'number') return this.shotEnd.set(npcHit.point.x, npcHit.point.y, npcHit.point.z);
			return this.shotEnd.copy(origin).addScaledVector(dir, dist);
		}

		if (physDist < Infinity)
		{
			this.stats.hits++;
			const rr = this.rayResult;
			this.hitPoint.set(rr.hitPointWorld.x, rr.hitPointWorld.y, rr.hitPointWorld.z);
			this.hitNormal.set(rr.hitNormalWorld.x, rr.hitNormalWorld.y, rr.hitNormalWorld.z);
			if (this.hitNormal.lengthSq() < 1e-6) this.hitNormal.copy(dir).negate();
			this.hitNormal.normalize();
			const body: any = rr.body;
			if (body && body.mass > 0)
			{
				// push loose objects / vehicles
				try
				{
					const imp = (Number(d.impulse) || 0) * falloff;
					body.applyImpulse(new CANNON.Vec3(dir.x * imp, dir.y * imp, dir.z * imp), rr.hitPointWorld);
					if (body.wakeUp) body.wakeUp();
				}
				catch (e) { /* ignore */ }
			}
			else this.addDecal(this.hitPoint, this.hitNormal);
			this.addSparks(this.hitPoint, this.hitNormal, d.pellets > 1 ? 2 : 4);
			return this.shotEnd.copy(this.hitPoint);
		}
		return this.shotEnd.copy(origin).addScaledVector(dir, range);
	}

	private punch(p: any): void
	{
		const d = this.def;
		this.hipTimer = 0.45;
		const npcs = this.world.realismNPCs;
		let hit = false;
		const cam = this.world.camera;
		cam.getWorldDirection(this.camDir);
		const dir = new THREE.Vector3(this.camDir.x, 0, this.camDir.z);
		if (dir.lengthSq() < 1e-6) dir.set(p.orientation.x, 0, p.orientation.z);
		dir.normalize();
		const ps = this.sizeOf(p);
		const origin = new THREE.Vector3(p.position.x, p.position.y + 0.25 * ps, p.position.z);
		this.broadcastCombatShot(origin, dir, (Number(d.range) || 1.4) * ps, Number(d.damage) || 10);
		if (npcs && typeof npcs.hitTest === 'function')
		{
			try
			{
				const h = npcs.hitTest(origin, dir, (Number(d.range) || 1.4) * ps);
				if (h && h.npc !== undefined)
				{
					hit = true;
					this.stats.npcHits++;
					let killed = false;
					if (typeof npcs.damage === 'function')
					{
						const r = npcs.damage(h.npc, Number(d.damage) || 10, dir);
						killed = r === true || !!(r && (r.killed || r.dead));
					}
					this.hud.hitMarker(this.now, killed);
				}
			}
			catch (e) { console.warn('[Realism] NPC punch failed', e); }
		}
		this.audio.punch(hit);
	}

	private broadcastCombatShot(origin: THREE.Vector3, direction: THREE.Vector3, range: number, damage: number): void
	{
		this.broadcastCombatShots([{
			origin: { x: origin.x, y: origin.y, z: origin.z },
			direction: { x: direction.x, y: direction.y, z: direction.z },
			range: range,
			damage: damage,
		}]);
	}

	private broadcastCombatShots(shots: any[]): void
	{
		const rrmp = (window as any).RRMP;
		if (rrmp && typeof rrmp.broadcastShots === 'function')
		{
			rrmp.broadcastShots(shots);
		}
	}

	// -----------------------------------------------------------------------
	// effects
	// -----------------------------------------------------------------------

	private addDecal(p: THREE.Vector3, n: THREE.Vector3): void
	{
		if (this.decals === null) return;
		this.q2.setFromUnitVectors(this.zAxis, n);
		const s = 0.8 + Math.random() * 0.5;
		this.m1.compose(this.v1.copy(p).addScaledVector(n, 0.008), this.q2, this.sc.set(s, s, s));
		this.decals.setMatrixAt(this.decalNext, this.m1);
		this.decalNext = (this.decalNext + 1) % this.decals.count;
		this.decals.instanceMatrix.needsUpdate = true;
		this.decals.visible = true;
	}

	private addSparks(p: THREE.Vector3, n: THREE.Vector3, count: number): void
	{
		for (let c = 0; c < count; c++)
		{
			let best = 0;
			for (let i = 1; i < MAX_SPARKS; i++) if (this.sparkList[i].life < this.sparkList[best].life) best = i;
			const s = this.sparkList[best];
			s.life = 0.12 + Math.random() * 0.1;
			s.p.copy(p).addScaledVector(n, 0.02);
			s.v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2.2).addScaledVector(n, 2.5 + Math.random() * 2);
		}
		this.sparks.visible = true;
	}

	private updateSparks(dt: number): void
	{
		if (!this.sparks.visible) return;
		let alive = 0;
		const zero = this.m1.makeScale(0, 0, 0);
		const m = this.m2;
		for (let i = 0; i < MAX_SPARKS; i++)
		{
			const s = this.sparkList[i];
			if (s.life <= 0) { this.sparks.setMatrixAt(i, zero); continue; }
			s.life -= dt;
			s.v.y -= 9.8 * dt;
			s.p.addScaledVector(s.v, dt);
			if (s.life <= 0) { this.sparks.setMatrixAt(i, zero); continue; }
			alive++;
			this.q2.setFromUnitVectors(this.zAxis, this.v1.copy(s.v).normalize());
			const k = Math.min(1, s.life * 8);
			m.compose(s.p, this.q2, this.v2.set(k, k, k * 1.5));
			this.sparks.setMatrixAt(i, m);
		}
		this.sparks.instanceMatrix.needsUpdate = true;
		if (alive === 0) this.sparks.visible = false;
	}

	private muzzleWorld(): THREE.Vector3
	{
		const v = this.visuals[this.def.id];
		if (!v || !v.holder.visible) return this.muzzleW.copy(this.hand);
		v.kick.updateMatrixWorld(true);
		return v.kick.localToWorld(this.muzzleW.copy(v.info.muzzle));
	}

	// -----------------------------------------------------------------------
	// per frame
	// -----------------------------------------------------------------------

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		const dt = Math.min(0.1, Math.max(0, unscaledTimeStep !== undefined ? unscaledTimeStep : timeStep));
		this.now += dt;
		const w = this.world;
		if (w.realismPaused === true && this.wheel.isOpen) this.closeWheel(-1);

		const p = this.findPlayer();
		const active = p !== null && this.onFoot(p);
		if (this.player !== null && this.player !== p && this.player.aimDirection !== undefined) this.player.aimDirection = null;
		this.player = p;
		this.hud.update(this.now);

		if (!active)
		{
			if (this.wheel.isOpen) this.closeWheel(-1);
			this.root.visible = false;
			this.triggerHeld = false; this.triggerPressed = false; this.aimHeld = false;
			if (p && p.aimDirection !== undefined) p.aimDirection = null;
			this.armBlend = 0;
			this.applyCamera(p, 0, false);
			this.reloadTimer = 0;
			this.hud.hideAll();
			this.updateEffects(dt);
			return;
		}
		if (this.fpActive && !this.controls(p)) this.fpActive = false;   // free camera: back to the hand pose

		const d = this.def;
		const gun = this.isGun(d);
		const steering = this.controls(p);
		const blocked = this.blockedByOthers() || this.wheel.isOpen;
		if (blocked || !steering) { this.triggerHeld = false; this.triggerPressed = false; this.aimHeld = false; }

		// timers
		this.fireCooldown = Math.max(-0.05, this.fireCooldown - dt);   // small carry keeps full-auto rates right at 30 fps
		this.equipTimer = Math.max(0, this.equipTimer - dt);
		this.hipTimer = Math.max(0, this.hipTimer - dt);
		if (this.reloadTimer > 0)
		{
			this.reloadTimer -= dt;
			if (this.reloadTimer <= 0) { this.reloadTimer = 0; this.finishReload(); }
		}
		this.bloom = Math.max(0, this.bloom - dt * 6);

		// recoil recovery (starts shortly after the last shot)
		const co = w.cameraOperator;
		if (this.recoilDebt > 0.001 && this.now - this.lastShot > 0.06 && co)
		{
			const back = Math.min(this.recoilDebt, this.recoilDebt * Math.min(1, dt * 7) + dt * 0.5);
			co.phi = Math.min(85, co.phi + back);
			this.recoilDebt -= back;
		}

		// aiming
		const aiming = gun && this.aimHeld && steering && !blocked;
		const zoomTarget = aiming ? 1 : 0;
		this.zoomBlend = approach(this.zoomBlend, zoomTarget, dt * 7);
		const armTarget = gun && (aiming || this.hipTimer > 0 || this.fpActive) ? 1 : 0;
		this.armBlend = approach(this.armBlend, armTarget, dt * (armTarget > this.armBlend ? 12 : 5));
		this.applyCamera(p, this.zoomBlend, steering);

		// camera ray (used for facing, arm pose, firing)
		const cam: THREE.PerspectiveCamera = w.camera;
		cam.getWorldPosition(this.camPos);
		cam.getWorldDirection(this.camDir);
		this.aimPoint.copy(this.camPos).addScaledVector(this.camDir, 40);

		// face the aim direction while aiming / just after firing (Character.aimDirection)
		if (p.aimDirection !== undefined)
		{
			if (aiming || this.hipTimer > 0)
			{
				this.aimDir.set(this.camDir.x, 0, this.camDir.z);
				if (this.aimDir.lengthSq() > 1e-6) { this.aimDir.normalize(); p.aimDirection = this.aimDir; }
			}
			else p.aimDirection = null;
		}

		// fire
		if ((this.triggerHeld || this.triggerPressed) && steering && !blocked)
		{
			this.tryFire(p);
			if (this.triggerHeld && d.auto && this.fireCooldown <= 0) this.tryFire(p);   // 2nd round this frame on fast guns
		}
		this.triggerPressed = false;

		if (!this.fpActive) this.updatePose(p);   // in first person updateFirstPersonPose() runs after the camera moved
		this.updateEffects(dt);
		this.updateHud(aiming);
	}

	/** Over-the-shoulder offset, closer camera and narrower view while aiming. */
	private applyCamera(p: any, blend: number, steering: boolean): void
	{
		const co = this.world.cameraOperator;
		const cam: THREE.PerspectiveCamera = this.world.camera;
		if (!co || !cam) return;
		if (blend > 0.001 && steering)
		{
			if (!this.camApplied) { this.baseRadius = co.targetRadius; this.baseFov = cam.fov; this.camApplied = true; }
			let fovMul = Number(this.settings.aimFov) || 0.82;
			if (this.fpActive)
			{
				// first person: the camera stays at the eye, only the view narrows
				const pl = this.world.realismPlayer;
				const pf = this.world.realismFirstPersonSettings;
				fovMul = pf && Number(pf.aimFov) > 0 ? Number(pf.aimFov) : (pl ? 0.72 : fovMul);
			}
			else
			{
				const ps = this.sizeOf(p);
				cam.getWorldDirection(this.v1);
				const right = this.v2.crossVectors(this.v1, this.up);
				right.y = 0;
				if (right.lengthSq() > 1e-6) right.normalize();
				const sh = this.settings.shoulder || [0.42, 0.16];
				co.target.addScaledVector(right, (Number(sh[0]) || 0) * blend * ps);
				co.target.y += (Number(sh[1]) || 0) * blend * ps;
				co.targetRadius = this.baseRadius + ((Number(this.settings.aimDistance) || 1.05) * ps - this.baseRadius) * blend;
			}
			const fov = this.baseFov * (1 + (fovMul - 1) * blend);
			if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
		}
		else if (this.camApplied)
		{
			co.targetRadius = this.baseRadius;
			if (cam.fov !== this.baseFov) { cam.fov = this.baseFov; cam.updateProjectionMatrix(); }
			this.camApplied = false;
		}
	}

	/** Puts the weapon in the right hand and points the arms at the aim point. */
	private updatePose(p: any): void
	{
		const d = this.def;
		const vis = this.visualFor(this.current);
		for (const id in this.visuals) if (this.visuals.hasOwnProperty(id)) this.visuals[id].holder.visible = this.visuals[id] === vis;
		this.root.visible = vis !== null;
		if (vis === null) return;

		const arms = this.findArms(p);
		const ps = this.sizeOf(p);
		const scale = (Number(this.settings.scale) || 0.62) * ps;
		this.root.position.set(0, 0, 0);
		this.root.quaternion.set(0, 0, 0, 1);
		this.root.scale.set(1, 1, 1);
		const blend = this.armBlend;

		if (arms !== null)
		{
			if (blend > 0.001) this.pointArm(arms.upperR, arms.lowerR, this.aimPoint, blend);
			arms.lowerR.localToWorld(this.hand.set(0, Number(this.settings.handOffset) || 0.45, 0));
			// hold orientation: forearm bone * handRotation
			arms.lowerR.getWorldQuaternion(this.q1).multiply(this.holdQ);
		}
		else
		{
			// no bones: in front of the chest
			this.hand.set(p.position.x, p.position.y + 0.15 * ps, p.position.z).addScaledVector(p.orientation, 0.25 * ps);
			this.q1.setFromUnitVectors(this.zAxis, this.v1.set(p.orientation.x, 0, p.orientation.z).normalize());
		}

		if (blend > 0.001)
		{
			// aimed orientation: barrel (+Z) towards the aim point
			this.m1.lookAt(this.aimPoint, this.hand, this.up);
			this.q2.setFromRotationMatrix(this.m1);
			this.q1.slerp(this.q2, blend);
		}
		vis.holder.position.copy(this.hand);
		vis.holder.quaternion.copy(this.q1);
		vis.holder.scale.setScalar(scale);

		// kick back + reload dip
		const k = this.kick;
		vis.kick.position.set(0, 0, -0.045 * k);
		let rx = -0.18 * k;
		if (this.reloadTimer > 0 && this.reloadTotal > 0)
		{
			const t = 1 - this.reloadTimer / this.reloadTotal;
			rx += Math.sin(t * Math.PI) * 0.7;
			vis.kick.rotation.z = Math.sin(t * Math.PI) * 0.4;
		}
		else vis.kick.rotation.z = 0;
		if (this.equipTimer > 0) rx += this.equipTimer * 2.2;
		vis.kick.rotation.x = rx;

		// support hand on the gun
		if (arms !== null && arms.upperL && arms.lowerL && blend > 0.001)
		{
			this.v3.copy(this.aimPoint).sub(this.hand).normalize();
			const sp = this.support.copy(this.hand).addScaledVector(this.v3, (vis.info.support + 0.04) * scale);
			this.pointArm(arms.upperL, arms.lowerL, sp, blend);
		}

		// muzzle flash sits on the barrel end
		if (this.flash.parent !== vis.kick) vis.kick.add(this.flash);
		this.flash.position.copy(vis.info.muzzle);
		const fs = Math.max(0.01, Number(d.flashSize) || 0.12);
		this.flash.scale.set(fs, fs, fs * (0.8 + Math.random() * 0.5));
	}

	/** Size of a character relative to the original boxman (Character.modelScale, 1 when unknown). */
	private sizeOf(p: any): number
	{
		const s = p ? Number(p.modelScale) : 1;
		return s > 0 ? s : 1;
	}

	/** RealismFirstPerson.ts: true while the first person camera is on and it calls updateFirstPersonPose() each frame. */
	public setFirstPerson(on: boolean): void
	{
		if (this.fpActive === on) return;
		this.fpActive = on;
		this.fpPush = 0;
		if (!on)
		{
			// back to the hand pose this frame
			const p = this.activePlayer();
			if (p !== null) this.updatePose(p);
		}
	}

	public get firstPersonActive(): boolean { return this.fpActive; }

	/**
	 * First person view model. Called by RealismFirstPerson.ts after it placed the camera (so the gun never
	 * lags behind the view). `vm` = per kind { hip: [right, up, forward], ads: distance eye -> sight }, in
	 * metres for a real size gun (multiplied by the weapon size). `bob` = walk bob phase (radians),
	 * `move` = 0..1 how fast the player walks.
	 */
	public updateFirstPersonPose(cam: THREE.PerspectiveCamera, vm: any, bob: number, move: number): void
	{
		if (!this.fpActive) return;
		const p = this.activePlayer();
		if (p === null) return;
		const d = this.def;
		const vis = this.visualFor(this.current);
		for (const id in this.visuals) if (this.visuals.hasOwnProperty(id)) this.visuals[id].holder.visible = this.visuals[id] === vis;
		this.root.visible = vis !== null;
		if (vis === null) return;

		const scale = (Number(this.settings.scale) || 0.62) * this.sizeOf(p);
		const k = vm && vm[d.kind] ? vm[d.kind] : (DEFAULT_VIEWMODEL[d.kind] || DEFAULT_VIEWMODEL.pistol);
		const hip = Array.isArray(k.hip) ? k.hip : DEFAULT_VIEWMODEL.pistol.hip;
		const adsDist = Number(k.ads) > 0 ? Number(k.ads) : 0.3;
		const sight = vis.info.sight || this.v1.set(0, vis.info.muzzle.y + 0.02, 0);
		const a = this.zoomBlend * this.zoomBlend * (3 - 2 * this.zoomBlend);   // smoothstep
		const sy = sight.y, sz = sight.z;
		// camera space (x right, y up, -z forward); grip = weapon origin
		let x = (Number(hip[0]) || 0) * scale * (1 - a);
		let y = (Number(hip[1]) || 0) * scale * (1 - a) + (-sy * scale) * a;
		let z = -(Number(hip[2]) || 0) * scale * (1 - a) + (-(adsDist + sz) * scale) * a;

		// walk bob + breathing, less while aiming
		const bobK = (1 - 0.85 * a) * Math.min(1, move);
		x += Math.cos(bob) * 0.011 * scale * bobK;
		y += -Math.abs(Math.sin(bob)) * 0.013 * scale * bobK + Math.sin(this.now * 1.6) * 0.0018 * scale * (1 - a);
		// reload / swap: the gun dips out of view
		let dip = 0;
		if (this.reloadTimer > 0 && this.reloadTotal > 0) dip = Math.sin((1 - this.reloadTimer / this.reloadTotal) * Math.PI);
		if (this.equipTimer > 0) dip = Math.max(dip, Math.min(1, this.equipTimer * 3));
		y -= dip * 0.16 * scale;
		z += dip * 0.04 * scale;
		// kick back
		z += this.kick * 0.05 * scale * (1 - 0.4 * a);

		// don't push the barrel through walls: pull the gun back
		cam.getWorldPosition(this.camPos);
		cam.getWorldDirection(this.camDir);
		const reach = -z + vis.info.muzzle.z * scale;
		let push = 0;
		const pw: any = this.world.physicsWorld;
		if (pw && reach > 0.05)
		{
			this.rFrom.set(this.camPos.x, this.camPos.y, this.camPos.z);
			this.rTo.set(this.camPos.x + this.camDir.x * reach, this.camPos.y + this.camDir.y * reach, this.camPos.z + this.camDir.z * reach);
			this.rayResult.reset();
			try
			{
				// tslint:disable-next-line: no-bitwise
				if (pw.raycastClosest(this.rFrom, this.rTo, { collisionFilterMask: ~2, skipBackfaces: true }, this.rayResult) && this.rayResult.hasHit)
				{
					push = Math.min(reach - this.rayResult.distance, reach * 0.7);
				}
			}
			catch (e) { push = 0; }
		}
		this.fpPush += (Math.max(0, push) - this.fpPush) * 0.35;
		z += this.fpPush;
		y -= this.fpPush * 0.35;

		// orientation in camera space: barrel (+Z) towards a point straight ahead (hip fire converges at 25 m)
		this.fpPos.set(x, y, z);
		this.fpTarget.set(0, 0, -25);
		if (a > 0.999) this.fpTarget.set(x, y, z - 10);
		else if (a > 0.001) this.fpTarget.lerp(this.v2.set(x, y, z - 10), a);
		this.fpM.lookAt(this.fpTarget, this.fpPos, this.up);
		this.fpQ.setFromRotationMatrix(this.fpM);
		// wall: tilt the barrel down; reload: roll
		const tiltX = (reach > 0 ? this.fpPush / reach : 0) * 0.9 + dip * 0.5;
		if (tiltX > 0.0001 || dip > 0)
		{
			this.fpEuler.set(tiltX, 0, dip * 0.35);
			this.q2.setFromEuler(this.fpEuler);
			this.fpQ.multiply(this.q2);
		}

		cam.updateMatrixWorld();
		cam.localToWorld(this.fpGrip.copy(this.fpPos));
		cam.getWorldQuaternion(this.q1);
		vis.holder.position.copy(this.fpGrip);
		vis.holder.quaternion.copy(this.q1).multiply(this.fpQ);
		vis.holder.scale.setScalar(scale);
		vis.kick.position.set(0, 0, 0);
		vis.kick.rotation.set(-0.12 * this.kick * (1 - 0.5 * a), 0, 0);
		vis.holder.updateMatrixWorld(true);

		// arms reach for the gun (right hand on the grip, left hand on the fore grip)
		const arms = this.findArms(p);
		if (arms !== null)
		{
			this.pointArm(arms.upperR, arms.lowerR, this.fpGrip, 1);
			if (arms.upperL && arms.lowerL)
			{
				vis.kick.localToWorld(this.support.set(0, 0, vis.info.support + 0.04));
				this.pointArm(arms.upperL, arms.lowerL, this.support, 1);
			}
		}

		// muzzle flash on the view model barrel
		if (this.flash.parent !== vis.kick) vis.kick.add(this.flash);
		this.flash.position.copy(vis.info.muzzle);
		const fs = Math.max(0.01, Number(d.flashSize) || 0.12);
		this.flash.scale.set(fs, fs, fs * (0.8 + Math.random() * 0.5));
		this.hand.copy(this.fpGrip);
		this.aimPoint.copy(this.camPos).addScaledVector(this.camDir, 40);
	}

	/** Rotates the upper arm so its bone axis points at `target`, and straightens the forearm. */
	private pointArm(upper: THREE.Object3D, lower: THREE.Object3D, target: THREE.Vector3, blend: number): void
	{
		if (!upper || !lower || !upper.parent) return;
		upper.getWorldPosition(this.pa1);
		const dir = this.pa2.copy(target).sub(this.pa1);
		if (dir.lengthSq() < 1e-8) return;
		dir.normalize();
		upper.getWorldQuaternion(this.q2);
		const boneY = this.pa3.copy(this.yAxis).applyQuaternion(this.q2);
		this.q3.setFromUnitVectors(boneY, dir).multiply(this.q2);          // wanted world rotation
		upper.parent.getWorldQuaternion(this.q2);
		this.q3.premultiply(this.q2.inverse());                            // to parent space
		upper.quaternion.slerp(this.q3, blend);
		lower.quaternion.slerp(this.qId, blend);
		upper.updateMatrixWorld(true);
	}

	private updateEffects(dt: number): void
	{
		this.kick = Math.max(0, this.kick - dt * 12);
		if (this.flashTimer > 0)
		{
			this.flashTimer -= dt;
			this.flash.visible = this.flashTimer > 0 && this.root.visible;
		}
		else this.flash.visible = false;
		if (this.light !== null)
		{
			if (this.flash.visible)
			{
				this.flash.parent.updateMatrixWorld(true);
				this.flash.getWorldPosition(this.light.position);
				this.light.intensity = 2.2;
			}
			else if (this.light.intensity !== 0) this.light.intensity = 0;
		}
		if (this.tracer !== null && this.tracerTimer > 0)
		{
			this.tracerTimer -= dt;
			if (this.tracerTimer <= 0) this.tracer.visible = false;
		}
		this.updateSparks(dt);
	}

	private updateHud(aiming: boolean): void
	{
		const d = this.def, a = this.ammo[this.current];
		if (!this.isGun(d)) { this.hud.setAmmo(esc(d.name)); this.hud.setCrosshair(false, 0, false); return; }
		const res = this.settings.infiniteAmmo ? '\u221e' : String(a.reserve);
		const low = a.mag <= Math.ceil(d.magazine * 0.25);
		this.hud.setAmmo('<span style="font-weight:500;opacity:.8">' + esc(d.name) + '</span>&nbsp;&nbsp;<span style="font-size:22px;color:' + (low ? '#ff7a6a' : '#fff') + '">' + a.mag +
			'</span><span style="opacity:.7"> / ' + res + '</span>' + (this.reloadTimer > 0 ? '<div style="font:600 11px sans-serif;color:#ffd54a">RELOADING</div>' : ''));
		const cam: THREE.PerspectiveCamera = this.world.camera;
		const h = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 600;
		const spread = (this.zoomBlend > 0.5 ? d.aimSpread : d.spread) + this.bloom;
		const gap = 3 + Math.tan(spread * DEG) * h / (2 * Math.tan((cam.fov * DEG) / 2));
		if (this.fpActive && aiming && this.zoomBlend > 0.6) this.hud.setCrosshair(false, 0, false);   // looking down the sights
		else this.hud.setCrosshair(aiming && this.zoomBlend > 0.3, Math.min(60, gap), true);
	}

	public dispose(): void
	{
		for (let i = 0; i < this.handlers.length; i++)
		{
			const h = this.handlers[i];
			try { h.target.removeEventListener(h.type, h.fn, h.capture); } catch (e) { /* ignore */ }
		}
		this.handlers = [];
		this.wheel.dispose();
		this.audio.dispose();
		const scene = this.world.graphicsWorld;
		[this.root, this.light, this.decals, this.sparks, this.tracer].forEach((o: any) => { if (o) scene.remove(o); });
	}
}

function approach(v: number, target: number, step: number): number
{
	return v < target ? Math.min(target, v + step) : Math.max(target, v - step);
}

function digit(code: string): number
{
	const m = /^(Digit|Numpad)([1-9])$/.exec(code || '');
	return m ? Number(m[2]) - 1 : -1;
}

/** Random direction inside a cone of half-angle `angle` (radians) around `dir` (in place). */
function coneJitter(dir: THREE.Vector3, angle: number, q: THREE.Quaternion): void
{
	const r = angle * Math.sqrt(Math.random());
	const phi = Math.random() * Math.PI * 2;
	// any axis perpendicular to dir
	const ax = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
	const perp = ax.cross(dir).normalize();
	q.setFromAxisAngle(dir, phi);
	perp.applyQuaternion(q);
	q.setFromAxisAngle(perp, r);
	dir.applyQuaternion(q).normalize();
}

function esc(s: string): string
{
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
