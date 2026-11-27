import * as THREE from 'three';
import * as CANNON from 'cannon';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
export declare type DoorKind = 'hinged' | 'rollup' | 'hangar';
export interface DoorSpec {
    kind: DoorKind;
    x: number;
    y: number;
    z: number;
    rot: number;
    width: number;
    height: number;
    thickness?: number;
    color?: number[];
    locked?: boolean;
    fixed?: boolean;
    openAngle?: number;
    open?: boolean;
    group?: string;
    interior?: boolean;
    label?: string;
    privateHome?: boolean;
    lawEnforcementOnly?: boolean;
}
interface Door {
    kind: DoorKind;
    x: number;
    y: number;
    z: number;
    rot: number;
    w: number;
    h: number;
    t: number;
    openAngle: number;
    locked: boolean;
    fixed: boolean;
    group: string;
    label: string;
    s: number;
    target: number;
    speed: number;
    batch: DoorBatch;
    v0: number;
    partner: number;
    bodies: CANNON.Body[];
    moving: boolean;
    interior: boolean;
    color: number[];
    privateHome: boolean;
    lawEnforcementOnly: boolean;
    bIndex: number;
    owned: boolean;
    orig: number;
    ax: number;
    az: number;
    bx: number;
    bz: number;
}
interface DoorBatch {
    key: string;
    interior: boolean;
    doors: number[];
    mesh: THREE.Mesh;
    pos: Float32Array;
    nor: Int8Array;
    posAttr: THREE.BufferAttribute;
    norAttr: THREE.BufferAttribute;
    dirtyLo: number;
    dirtyHi: number;
    maxSlide: number;
}
export declare class DoorSystem implements IUpdatable {
    updateOrder: number;
    doors: Door[];
    stats: {
        doors: number;
        interiorDoors: number;
        batches: number;
        colliders: number;
    };
    private ctx;
    private batches;
    private batchList;
    private grid;
    private moving;
    private pool;
    private withBodies;
    private colliderAcc;
    private nearest;
    private finalized;
    private msg;
    private msgUntil;
    private promptKey;
    private ownedSet;
    private groupDoors;
    private ownedAcc;
    private propsHooked;
    private playerPos;
    private keyHandler;
    private bodyMat;
    private tmpQ;
    private yAxis;
    private npcCloses;
    constructor(ctx: RealismCtx);
    /** Registers a door. Returns its index (use with link()). */
    add(spec: DoorSpec): number;
    /** Makes two leaves open and close together (double doors). */
    link(a: number, b: number): void;
    /** Builds the merged door meshes. Call once after every building has been placed. */
    finalize(): void;
    private colorsOf;
    /** Writes one door's 48 vertices for its current open amount. */
    private writeDoor;
    /** Box (x0..x1, y0..y1, z0..z1) in door space, turned by `yaw` about the anchor. */
    private writeBox;
    /** Collider boxes for the current pose: [cx, cy, cz, hx, hy, hz, yaw] (world). */
    private boxesOf;
    update(timeStep: number, unscaledTimeStep: number): void;
    private upload;
    /** Opens / closes door i (and its partner). Returns false if locked. */
    toggle(i: number): boolean;
    private setTarget;
    /** Locks / unlocks door i and every door in its group (a locked door closes). */
    toggleLock(i: number): void;
    /** Turns every outer door of a building group into a private NPC home door: locked for good,
     *  L can't unlock it and the prompt says "Private residence". Returns how many doors changed. */
    markPrivate(group: string): number;
    /** Indices of the outer doors of a building group (front door first). */
    doorsOfGroup(group: string): number[];
    /** Centre of door i's closed opening and its outward facing (local +z of the building). */
    doorInfo(i: number): {
        x: number;
        y: number;
        z: number;
        rot: number;
        width: number;
        label: string;
        locked: boolean;
        privateHome: boolean;
    } | null;
    /** Swings door i (and its partner) open for an NPC walking through, whatever its lock, and closes it after `hold` seconds. */
    npcPass(i: number, hold?: number): void;
    private refreshColliders;
    /** Gives the door's bodies box shapes of the right size (on assignment). */
    private shapeBodies;
    private poseBodies;
    private query;
    private findNearest;
    /** xz distance from a point to the closed door's segment. */
    private dist;
    /** The character the user controls, or null (free camera). */
    private player;
    private onFoot;
    private hasLawEnforcementAccess;
    private bindInput;
    private ensureHud;
    /** Shows / clears the 'doors' prompt for the nearest door (only when it changes). */
    private updatePrompt;
    private anchor;
    private anchorOf;
    /** True when the player owns building `b` (realismProperties.owns). */
    isOwnedBuilding(b: number): boolean;
    /** Re-reads which buildings the player owns and hands their outer doors over / back. */
    refreshOwned(): void;
    private flash;
}
export {};
