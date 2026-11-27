import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
import { Building, Road } from './RealismMapData';
import { AssetPart } from './RealismAssets';
/** Point (x, z) inside building `b`'s footprint grown by `m` metres. */
export declare function inBuilding(b: Building, x: number, z: number, m: number): boolean;
/** Highest point of a building (roof ridge included, roughly). */
export declare function buildingTop(b: Building): number;
export declare class ScatterSpace {
    private ctx;
    private bGrid;
    private cGrid;
    private rGrid;
    private kGrid;
    private lake;
    constructor(ctx: RealismCtx);
    private addRectTo;
    private inRects;
    /** Inside a house's door / porch / path / driveway keep-out (see houseKeepOut). */
    inDoorway(x: number, z: number, r: number): boolean;
    addCircle(x: number, z: number, r: number): void;
    /** Oriented rectangle: half extents along its local x / z, yaw `rot` (same convention as buildings). */
    addRect(x: number, z: number, hw: number, hd: number, rot: number): void;
    /** First building whose footprint (grown by m) contains (x, z), or null. */
    buildingAt(x: number, z: number, m: number): Building;
    /** Does anything solid sit above height y at (x, z)? (used for wires) */
    blockedAbove(x: number, y: number, z: number): boolean;
    /** Free of placed objects (circles / rects) within r. */
    clearOfObjects(x: number, z: number, r: number): boolean;
    /** Usable ground: dry land, not in the lake, not too steep. */
    ground(x: number, z: number): boolean;
    /**
     * Full check: on usable ground, at least `roadGap` metres from any road edge,
     * outside every building footprint (grown by r + bMargin), clear of placed objects.
     */
    free(x: number, z: number, r: number, roadGap: number, bMargin?: number): boolean;
}
/** One shared ScatterSpace per world build, so all dressing passes avoid each other. */
export declare function scatterSpace(ctx: RealismCtx): ScatterSpace;
/**
 * Areas around a house that must stay clear (front path to the street, porch, garage
 * driveway, back door), in the house's local frame: [x0, z0, x1, z1].
 * Mirrors RealismBuildings.ts houseExterior()/door placement. If the front door or
 * garage placement changes there, update this function.
 */
export declare function houseKeepOut(b: Building): number[][];
export declare function inKeepOut(b: Building, rects: number[][], x: number, z: number, r: number): boolean;
/** World point from a building's local frame (local +Z = front). */
export declare function local(b: Building, lx: number, lz: number): number[];
/** Point, tangent and left normal on a road at arc length s. */
export declare function roadAt(road: Road, s: number): {
    x: number;
    z: number;
    y: number;
    tx: number;
    tz: number;
    nx: number;
    nz: number;
    i: number;
    t: number;
};
/** Yaw that turns local +X onto the world direction (dx, dz). */
export declare function yawX(dx: number, dz: number): number;
export declare class MatrixBatcher {
    private ctx;
    private overrides;
    private makers;
    private procs;
    private groups;
    private keys;
    private noOverride;
    instanceCount: number;
    meshCount: number;
    counts: {
        [name: string]: number;
    };
    constructor(ctx: RealismCtx);
    /** `overridable: false` keeps the built-in look even if city.props has the name (decals). */
    define(name: string, maker: (variant: number) => AssetPart[], overridable?: boolean): void;
    isDisabled(name: string): boolean;
    /** Adds an instance from a quaternion + scale. `chunk`: grouping size in metres. */
    addQ(name: string, variant: number, x: number, y: number, z: number, q: THREE.Quaternion, sx: number, sy: number, sz: number, cat: string, chunk: number, cast?: boolean): boolean;
    /** Adds an instance turned by yaw only. */
    add(name: string, variant: number, x: number, y: number, z: number, ry: number, sx: number, sy: number, sz: number, cat: string, chunk: number, cast?: boolean): boolean;
    private procParts;
    /**
     * Takes the built-in meshes of `name` whose variant passes `pick` out of the scene for good
     * (used when your own model has loaded for those instances). Returns how many meshes went.
     */
    retire(name: string, pick: (variant: number) => boolean): number;
    build(): void;
    private instantiate;
}
