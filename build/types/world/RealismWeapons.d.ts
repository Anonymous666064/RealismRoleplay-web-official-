import * as THREE from 'three';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { WeaponAudio } from './RealismAudio';
export interface WeaponDef {
    id: string;
    kind: string;
    name: string;
    damage: number;
    fireRate: number;
    auto: boolean;
    magazine: number;
    reserve: number;
    reloadTime: number;
    spread: number;
    aimSpread: number;
    range: number;
    recoil: number;
    pellets: number;
    impulse: number;
    flashSize: number;
    model?: string;
    scale?: number | number[];
    rotation?: number[];
    offset?: number[];
    muzzle?: number[];
    sounds?: {
        shot?: string;
        reload?: string;
        empty?: string;
    };
}
/** Defaults. Everything here can be overridden in realism-config.js -> weapons. */
export declare const DEFAULT_WEAPONS: any;
/**
 * First person view model per weapon kind (realism-config.js -> player.viewModel overrides it):
 *   hip: [right, up, forward] metres from the eye to the grip, for a real size gun (x weapon size)
 *   ads: distance from the eye to the rear sight while aiming
 */
export declare const DEFAULT_VIEWMODEL: any;
interface WeaponState {
    mag: number;
    reserve: number;
}
export declare class WeaponSystem implements IUpdatable {
    updateOrder: number;
    settings: any;
    defs: WeaponDef[];
    ammo: WeaponState[];
    current: number;
    audio: WeaponAudio;
    stats: {
        shots: number;
        hits: number;
        npcHits: number;
        reloads: number;
        switches: number;
    };
    private ctx;
    private world;
    private wheel;
    private hud;
    private now;
    private triggerHeld;
    private triggerPressed;
    private aimHeld;
    private wheelWasLocked;
    private wheelToggle;
    private handlers;
    private fireCooldown;
    private equipTimer;
    private reloadTimer;
    private reloadTotal;
    private hipTimer;
    private bloom;
    private recoilDebt;
    private lastShot;
    private kick;
    private armBlend;
    private zoomBlend;
    private camApplied;
    private baseRadius;
    private baseFov;
    private root;
    private visuals;
    private flash;
    private flashTimer;
    private light;
    private decals;
    private decalNext;
    private sparks;
    private sparkList;
    private sparksAlive;
    private tracer;
    private tracerPos;
    private tracerCount;
    private tracerTimer;
    private holdQ;
    private player;
    private fpActive;
    private fpPos;
    private fpTarget;
    private fpGrip;
    private fpQ;
    private fpM;
    private fpPush;
    private fpEuler;
    private v1;
    private v2;
    private v3;
    private camPos;
    private camDir;
    private hand;
    private aimPoint;
    private muzzleW;
    private q1;
    private q2;
    private q3;
    private qId;
    private m1;
    private m2;
    private pa1;
    private pa2;
    private pa3;
    private support;
    private sc;
    private up;
    private zAxis;
    private yAxis;
    private rayResult;
    private rFrom;
    private rTo;
    private aimDir;
    constructor(ctx: RealismCtx);
    private readDefs;
    private get def();
    private isGun;
    private buildVisuals;
    /** Builds (once) the model for weapon slot i. */
    private visualFor;
    private findArms;
    private on;
    private canvas;
    private pointerLocked;
    private blockedByOthers;
    private bindInput;
    private setBlocking;
    private openWheel;
    /** Closes the wheel; `pick` >= 0 equips that slot. */
    closeWheel(pick: number): void;
    private wheelSlots;
    /** The character the user plays (also while in free camera), or null. */
    private findPlayer;
    private onFoot;
    /** True when the user is steering this character (not the free camera). */
    private controls;
    private activePlayer;
    equip(i: number): void;
    /** Equips by weapon id ('rifle'). */
    equipById(id: string): void;
    /** Adds spare ammo to a weapon id. */
    giveAmmo(id: string, rounds: number): void;
    currentWeapon(): {
        id: string;
        name: string;
        mag: number;
        reserve: number;
        reloading: boolean;
        aiming: boolean;
    };
    /** For NPC gunfire: plays a shot of `kind` heard from `pos` (THREE.Vector3). */
    playShotAt(kind: string, pos: THREE.Vector3): void;
    startReload(): void;
    private finishReload;
    private tryFire;
    private shotEnd;
    private hitPoint;
    private hitNormal;
    /** One bullet / pellet. Returns where it ended (for the tracer). */
    private shootRay;
    private punch;
    private broadcastCombatShot;
    private broadcastCombatShots;
    private addDecal;
    private addSparks;
    private updateSparks;
    private muzzleWorld;
    update(timeStep: number, unscaledTimeStep: number): void;
    /** Over-the-shoulder offset, closer camera and narrower view while aiming. */
    private applyCamera;
    /** Puts the weapon in the right hand and points the arms at the aim point. */
    private updatePose;
    /** Size of a character relative to the original boxman (Character.modelScale, 1 when unknown). */
    private sizeOf;
    /** RealismFirstPerson.ts: true while the first person camera is on and it calls updateFirstPersonPose() each frame. */
    setFirstPerson(on: boolean): void;
    get firstPersonActive(): boolean;
    /**
     * First person view model. Called by RealismFirstPerson.ts after it placed the camera (so the gun never
     * lags behind the view). `vm` = per kind { hip: [right, up, forward], ads: distance eye -> sight }, in
     * metres for a real size gun (multiplied by the weapon size). `bob` = walk bob phase (radians),
     * `move` = 0..1 how fast the player walks.
     */
    updateFirstPersonPose(cam: THREE.PerspectiveCamera, vm: any, bob: number, move: number): void;
    /** Rotates the upper arm so its bone axis points at `target`, and straightens the forearm. */
    private pointArm;
    private updateEffects;
    private updateHud;
    dispose(): void;
}
export {};
