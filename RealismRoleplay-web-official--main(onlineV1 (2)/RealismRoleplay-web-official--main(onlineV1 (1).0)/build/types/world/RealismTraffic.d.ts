import * as THREE from 'three';
import * as CANNON from 'cannon';
import { RealismCtx } from './RealismContext';
import { Car } from '../vehicles/Car';
import { InstancedCarLights, LampLayout } from './RealismCarLights';
export interface TrafficSettings {
    enabled: boolean;
    density: number;
    maxCars: number;
    radius: number;
    spawnMin: number;
    speedScale: number;
    speeds: {
        [kind: string]: number;
    };
    colliders: boolean;
    colliderRange: number;
    maxColliders: number;
    carjack: boolean;
    jackRange: number;
    jackSpeed: number;
    honk: boolean;
    drivers: boolean;
    panic: boolean;
    multiLane: boolean;
    avoidView: boolean;
    variety: number;
}
export declare function trafficSettings(ctx: RealismCtx): TrafficSettings;
interface Lane {
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    cum: Float32Array;
    len: number;
    next: number[];
    nextW: number[];
    limit: number;
    conn: boolean;
    node: number;
    group: number;
    signal: boolean;
    stop: boolean;
    conflicts: number[];
    to: number;
    from: number;
    edge: number;
    road: number;
    li: number;
    nl: number;
    dir: number;
    turn: number;
    mx: number;
    mz: number;
    r: number;
}
interface TCar {
    id: number;
    lane: number;
    s: number;
    v: number;
    next: number;
    color: number;
    mode: number;
    modeT: number;
    panicT: number;
    stopDone: number;
    go: number;
    stopT: number;
    waitT: number;
    honkT: number;
    driver: boolean;
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    hx: number;
    hz: number;
    quat: THREE.Quaternion;
    pos: THREE.Vector3;
    body: CANNON.Body;
    blockedByPlayer: boolean;
    prevV: number;
    brakeT: number;
    sig: number;
    pullOverS: number;
    pullOverOffset: number;
}
interface Jacked {
    car: Car;
    rgb: number[];
    claimed: boolean;
    t: number;
    pending?: boolean;
}
export declare class RealismTraffic {
    updateOrder: number;
    settings: TrafficSettings;
    ready: boolean;
    stats: {
        [k: string]: number;
    };
    lanes: Lane[];
    cars: TCar[];
    jacked: Jacked[];
    private ctx;
    private signals;
    private density;
    private slider;
    private nextId;
    private roadLanes;
    private nearLanes;
    private manageAcc;
    private pedAcc;
    private peds;
    private obst;
    private gltf;
    private bodyGeom;
    private wheelGeom;
    private bodyMeshes;
    private wheelMesh;
    private driverMesh;
    lights: InstancedCarLights;
    lampLayout: LampLayout;
    private night;
    private camDir;
    private laneCum;
    private boxes;
    private restY;
    private carLen;
    private collPool;
    private collMat;
    private tmpM;
    private one;
    private yAxis;
    private xAxis;
    private tq;
    private driverOff;
    private driverMat;
    private playerPos;
    private hint;
    private hintText;
    private promptOn;
    private lastHonk;
    private clock;
    private firstFill;
    private keyHandler;
    constructor(ctx: RealismCtx, signals: any);
    private buildLanes;
    /** Lane points along a road between stations s0..s1, `lat` metres to the right of the road direction. */
    private sampleRoad;
    private addLane;
    /**
     * Which lane may feed which across a junction when roads have 2 lanes each way: straight on
     * keeps its lane (2 -> 1 merges, 1 -> 2 goes to the kerb lane), left turns go inner -> inner,
     * right turns kerb -> kerb, U-turns inner -> inner. Single-lane roads accept everything.
     */
    private laneFits;
    private makeConnector;
    private prepare;
    update(timeStep: number, unscaledTimeStep?: number): void;
    private findPlayer;
    /** Things cars must not drive into: the player (on foot or in a car) and every real vehicle. */
    private gatherObstacles;
    private lightAt;
    /** May the car leave its lane into the junction connector `c` now? */
    private mayEnter;
    private drive;
    private advance;
    private pickNext;
    /** Position on a lane: writes into out [x, y, z]. */
    private at;
    private pa;
    private pb;
    private pc;
    private pose;
    private dist;
    get target(): number;
    private manage;
    private spawn;
    private release;
    /** The settings slider (0..2, via RealismNPCs.setDensity). traffic.density in the config multiplies it. */
    setDensity(n: number): void;
    getDensity(): number;
    /** Signal the nearest traffic car ahead of a patrol vehicle to pull over gradually. */
    requestPullOverNear(position: THREE.Vector3, forward: THREE.Vector3, range?: number): number;
    /** Brake lights on deceleration / standing still, indicators before and through turns. */
    private lightState;
    /** Light state of one traffic car for tests: { brake, signal, hazards, head }. */
    lightsOf(i: number): any;
    private draw;
    private colliders;
    private addBody;
    private freeBody;
    private onCollide;
    panic(point: THREE.Vector3, radius?: number): void;
    private ejectDriver;
    /** F on foot next to a stopped / slow traffic car: the driver gets out and the player takes the car. */
    tryCarjack(): boolean;
    private makeRealCar;
    /** Claims a carjacked car once the player sits in it; tidies up unused ones. */
    private watchJacked;
    private updateHint;
    private honk;
    debugCars(): any[];
}
/** Builds the traffic system and exposes it as (world as any).realismTraffic. */
export declare function buildTraffic(ctx: RealismCtx, signals: any): RealismTraffic;
export {};
