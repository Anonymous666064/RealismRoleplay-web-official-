import * as THREE from 'three';
import * as CANNON from 'cannon';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { NPCVehicles } from './RealismNPCVehicles';
export interface NPCSettings {
    enabled: boolean;
    density: number;
    residents: number;
    workers: number;
    wanderers: number;
    joggers: number;
    sitters: number;
    maxVisible: number;
    radius: number;
    homeShare: number;
    parkedCars: boolean;
    carShare: number;
    maxRealCars: number;
    carAlarm: boolean;
    crosswalks: boolean;
    gunfirePanic: number;
}
export declare function npcSettings(ctx: RealismCtx): NPCSettings;
/** Contract C5: the scale humans are drawn at: world.realismPlayerScale (the scale A10 actually applied
 *  to the player) when it is set, else config player.scale, else 1. */
export declare function playerScaleOf(ctx: RealismCtx): number;
/** Loads a .glb once (shared gltf). Tries the path, /path, then assetFallbackUrl + path. */
export declare function loadSharedModel(path: string, done: (gltf: any) => void, failed?: () => void): void;
/** Hands a parsed gltf to everything waiting for `path` (also used by the headless tests). */
export declare function injectModel(path: string, gltf: any): void;
/** Pedestrian network: nodes on sidewalks, junction corners and building fronts. */
export declare class WalkGraph {
    x: number[];
    y: number[];
    z: number[];
    kind: number[];
    adj: number[][];
    adjJ: number[][];
    comp: Int32Array;
    keep: Uint8Array;
    crossings: {
        j: number;
        arm: number;
        a: number;
        b: number;
    }[];
    private grid;
    private pg;
    private pfrom;
    private pstamp;
    private pclosed;
    private stampNo;
    private heap;
    private hf;
    add(x: number, y: number, z: number, kind: number): number;
    link(a: number, b: number, j?: number): void;
    dist(a: number, b: number): number;
    /** Labels connected pieces; keeps the ones with at least `minSize` nodes and indexes them. */
    finish(minSize: number): void;
    /** Nearest kept sidewalk / corner nodes within r, nearest first. */
    near(x: number, z: number, r: number, max: number): number[];
    /** A* shortest path, node list from a to b (inclusive), or null. */
    path(a: number, b: number, maxExpand?: number): number[];
}
interface Dest {
    kind: number;
    b: number;
    door: number;
    dx: number;
    dy: number;
    dz: number;
    node: number;
    hx: number;
    hz: number;
    cap: number;
    plaza: number[];
}
interface Leg {
    pts: Float32Array;
    cum: Float32Array;
    segJ: Int32Array;
    total: number;
    startDest: number;
    endDest: number;
}
interface Agent {
    id: number;
    role: number;
    home: number;
    seat: number;
    state: number;
    timer: number;
    leg: Leg;
    prog: number;
    seg: number;
    dir: number;
    speed: number;
    baseSpeed: number;
    lane: number;
    laneBoost: number;
    blocked: number;
    waiting: boolean;
    flee: number;
    pendingFlee: number;
    pose: number;
    x: number;
    y: number;
    z: number;
    hx: number;
    hz: number;
    vis: NPCBody;
    health: number;
    at: number;
    look: number;
    scale: number;
    req: {
        from: number;
        to: number;
        startDest: number;
        endDest: number;
        mid: boolean;
    } | null;
    detained: boolean;
    stunTimer: number;
    stunState: number;
    stunAgentTimer: number;
    stunLeg: Leg;
    stunProg: number;
}
interface RosterEntry {
    role: number;
    home: number;
    seat: number;
    key: number;
}
/** A pooled body (what weapons get back from hitTest as `npc`). */
export interface NPCBody {
    root: THREE.Object3D;
    tilt: THREE.Object3D;
    visual: THREE.Group;
    model: THREE.Object3D;
    mixer: THREE.AnimationMixer;
    walk: THREE.AnimationAction;
    idle: THREE.AnimationAction;
    run: THREE.AnimationAction;
    sit: THREE.AnimationAction;
    variantIndex: number;
    modelBaseScale: number;
    modelBaseMinY: number;
    modelFitScale: number;
    modelFitY: number;
    modelSeatedScale: number;
    modelSeatedY: number;
    wWalk: number;
    wRun: number;
    wSit: number;
    agent: Agent;
    geom: THREE.BufferGeometry;
    legs: THREE.Object3D[];
    deadT: number;
    fallAxis: number;
    animAcc: number;
    frame: number;
    body: CANNON.Body;
    alive: boolean;
}
export declare class RealismNPCs implements IUpdatable {
    updateOrder: number;
    settings: NPCSettings;
    graph: WalkGraph;
    dests: Dest[];
    homes: number[];
    shops: number[];
    works: number[];
    benches: number[];
    agents: Agent[];
    extras: Agent[];
    roster: RosterEntry[];
    bodies: NPCBody[];
    vehicles: NPCVehicles;
    stats: {
        [k: string]: number;
    };
    playerScale: number;
    private ctx;
    private signals;
    private free;
    private density;
    private queue;
    private matAcc;
    private frameNo;
    private playerPos;
    private havePlayer;
    private playerOnFoot;
    private gltf;
    private modelState;
    private modelVariants;
    private sharedMat;
    private clips;
    private bodyPool;
    private bodyPoolScale;
    private bodyMat;
    private tmpV;
    private tmpP;
    private nextId;
    private homeSet;
    private walkNodes;
    private lastShots;
    constructor(ctx: RealismCtx, signals: any, settings: NPCSettings);
    build(): void;
    /** A walk line along the front of a building that has no sidewalk near it. */
    private plazaLine;
    private paintCrosswalks;
    /** Everyone who can be out at density 2, mixed so that any first part of the list is a fair sample. */
    private buildRoster;
    getDensity(): number;
    setDensity(n: number): void;
    private makeAgent;
    /** Puts a parked / new agent back into the world. */
    private wake;
    /** Moves an agent to a random kept sidewalk node (at least `minFromPlayer` m from the player). */
    private placeOnSidewalk;
    /** Bench people: sit down (seat 0 / 1) or stand next to the bench (seat 2). */
    private takeSeat;
    private playerNear;
    private night;
    /** Walk line in front of a building without sidewalks: from one end to the other. */
    private plazaLeg;
    /** Picks where to go next and asks for a path. */
    private startErrand;
    private nearestNode;
    private makeLeg;
    private doorPass;
    private dwell;
    private arrive;
    /** Takes a temporary person out of the world. */
    private retire;
    /** Position / heading of an agent from its leg. */
    private locate;
    private canCross;
    private stepAgent;
    /** Back after being knocked down / shot: home, or a sidewalk away from the player. */
    private revive;
    private goHomeFromHere;
    private loadModel;
    private createPoseClip;
    private useCharacterModels;
    private useBoxman;
    private resetBodyPool;
    private newBody;
    private standMat;
    private standInMat;
    /** Paints clothes into the body's own vertex colours (skin / shirt / trousers / shoes by bone). */
    private dress;
    private applyBodyFit;
    private assignBody;
    private releaseBody;
    update(timeStep: number, unscaledTimeStep: number): void;
    /** Gunfire from the player's weapons scares people (and drivers) around the player. */
    private watchGunfire;
    /** Follows the player scale (contract C5) if it changes while playing. */
    private checkScale;
    private findPlayer;
    get player(): any;
    get playerPosition(): THREE.Vector3;
    private visibleCandidate;
    private materialise;
    /** Releases the body farthest from the player if it is farther than sqrt(minD2). */
    private freeFarthest;
    private updateBodies;
    private newCollider;
    private poolCollider;
    /** Ray against the people that have a body. `dir` need not be normalised. */
    hitTest(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): {
        distance: number;
        point: THREE.Vector3;
        npc: any;
    } | null;
    /** Briefly pauses an NPC without applying damage. */
    stun(npc: any, duration?: number): boolean;
    /** Applies or releases temporary in-game custody on an NPC. */
    setDetained(npc: any, detained: boolean): boolean;
    /** Damages a person (the `npc` from hitTest). 100 health; at 0 they fall over. Everyone near runs. */
    damage(npc: any, amount: number, dir?: THREE.Vector3): void;
    /**
     * People with a body (on foot, alive) inside the circle, as x,z pairs pushed into `out`.
     * RealismTraffic uses it so drivers stop for pedestrians on the road / crosswalks.
     */
    peopleNear(x: number, z: number, r: number, out: number[]): number;
    /** People within `radius` of the point run away from it. Drivers react too (RealismTraffic). */
    panic(point: THREE.Vector3, radius?: number): void;
    /** Makes one person run away from (tx, tz) for `time` seconds. */
    private scare;
    /** A walk node 30..90 m from (x, z), as far from the danger (tx, tz) as possible. */
    private awayNode;
    private setFleeDir;
    /**
     * A person appears at (x, y, z) and runs away from (fromX, fromZ), e.g. a driver pulled out of
     * a car. They are not part of the population: they leave the world once they are away.
     */
    addFleeing(x: number, y: number, z: number, fromX: number, fromZ: number): any;
    /** No walk graph near: run in a straight line away. */
    private plainRun;
    /** Bodies currently drawn (for UI / debugging). */
    visible(): NPCBody[];
    /** People near a point: walking or standing ones (abstract) and the ones with a body. */
    countNear(x: number, z: number, r: number): {
        out: number;
        visible: number;
        byRole: {
            [k: string]: number;
        };
    };
    get counts(): {
        agents: number;
        walking: number;
        home: number;
        inside: number;
        standing: number;
        visible: number;
        pending: number;
        extras: number;
        roles: {
            [k: string]: number;
        };
    };
    isNPCHome(buildingIndex: number): boolean;
}
export declare function buildNPCs(ctx: RealismCtx, signals: any): RealismNPCs;
export {};
