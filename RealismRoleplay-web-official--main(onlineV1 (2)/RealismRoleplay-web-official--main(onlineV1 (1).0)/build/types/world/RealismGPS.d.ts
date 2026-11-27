import * as THREE from 'three';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
export interface HudSettings {
    minimap: boolean;
    minimapWidth: number;
    minimapHeight: number;
    minimapFps: number;
    minimapTilt: number;
    minimapZoom: number;
    minimapDetail: number;
    maxTiles: number;
    builtInBlips: boolean;
    shortRange: number;
    prompts: boolean;
    bigMap: boolean;
    gps3D: boolean;
    groundLine: boolean;
    groundLineLength: number;
    arriveDistance: number;
    offRouteDistance: number;
    waypointColor: string;
    routeColor: string;
}
export declare const HUD_DEFAULTS: HudSettings;
export declare function hudSettings(ctx: RealismCtx): HudSettings;
export interface PlayerState {
    pos: THREE.Vector3;
    fx: number;
    fz: number;
    speed: number;
    kind: string;
    obj: any;
}
/** Where the player is and which way they face (no allocations). */
export declare function readPlayer(world: any, out: PlayerState): PlayerState;
export declare function newPlayerState(): PlayerState;
export interface NearestHit {
    seg: number;
    t: number;
    x: number;
    z: number;
    y: number;
    dist: number;
}
export declare class RoadGraph {
    n: number;
    xs: Float32Array;
    zs: Float32Array;
    ys: Float32Array;
    segA: Int32Array;
    segB: Int32Array;
    segLen: Float32Array;
    segCost: Float32Array;
    adjStart: Int32Array;
    adjTo: Int32Array;
    adjSeg: Int32Array;
    buildMs: number;
    private grid;
    private minCost;
    private gScore;
    private came;
    private stamp;
    private closed;
    private run;
    private heap;
    private heapF;
    private heapN;
    lastStats: {
        expanded: number;
        ms: number;
    };
    constructor(roads: any[]);
    get segCount(): number;
    /** Nearest point on any road segment within maxR metres (writes `out`, returns false if none). */
    nearest(x: number, z: number, maxR: number, out: NearestHit): boolean;
    /**
     * A* between two points already projected onto segments. Returns the node path (without the
     * projected end points) in `path`, and the cost, or -1 when unreachable.
     */
    search(s: NearestHit, g: NearestHit, path: number[]): number;
    private h;
    private push;
    private pop;
}
export interface Blip {
    id: string;
    x: number;
    z: number;
    icon: string;
    color: string;
    label: string;
    shortRange: boolean;
    builtin: boolean;
}
export declare class RealismGPS implements IUpdatable {
    updateOrder: number;
    ctx: RealismCtx;
    world: any;
    settings: HudSettings;
    graph: RoadGraph;
    waypoint: {
        x: number;
        z: number;
        label: string;
    };
    /** Route polyline (world xz + road height). Points [roadStart, roadEnd] follow roads; the rest are straight (dashed). */
    rx: Float32Array;
    rz: Float32Array;
    ry: Float32Array;
    rs: Float32Array;
    rn: number;
    roadStart: number;
    roadEnd: number;
    routeVersion: number;
    routeNodes: number;
    progressIdx: number;
    remaining: number;
    blipMap: {
        [id: string]: Blip;
    };
    blipList: Blip[];
    blipVersion: number;
    stats: {
        routes: number;
        recalcs: number;
        lastMs: number;
        lastExpanded: number;
        arrivals: number;
        lineBuilds: number;
    };
    private ps;
    private hitS;
    private hitG;
    private path;
    private recalcCooldown;
    private lineAcc;
    private pendingRoute;
    private beam;
    private line;
    private linePos;
    private lineAttr;
    private toastEl;
    private toastUntil;
    private tmp;
    private tmp2;
    private changeCbs;
    constructor(ctx: RealismCtx, settings?: HudSettings);
    setWaypoint(pos: any, label?: string): void;
    clear(): void;
    addBlip(id: string, b: any): void;
    removeBlip(id: string): void;
    routeInfo(): {
        length: number;
        remaining: number;
        points: number;
        nodes: number;
        ms: number;
    } | null;
    onChange(cb: () => void): void;
    private changed;
    private emit;
    private addBuiltInBlips;
    private near;
    /** Builds the route from the player to the waypoint. */
    computeRoute(): boolean;
    update(timeStep: number, unscaledTimeStep: number): void;
    /** Moves progressIdx to the route segment nearest the player; returns the distance to it. */
    trackProgress(x: number, z: number): number;
    progT: number;
    private ensure3D;
    private hide3D;
    private update3D;
    /** Rebuilds the ribbon along the next groundLineLength metres of route. */
    buildLine(): void;
    lineCount: number;
    toast(text: string): void;
}
export declare function groundY(data: any, x: number, z: number): number;
