import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
export declare const CONSTRUCTION_KEY = "realism.construction.v1";
export interface Lot {
    x: number;
    y: number;
    z: number;
    rot: number;
    w: number;
    d: number;
}
export interface Piece {
    stage: number;
    kind: string;
    x0: number;
    y0: number;
    z0: number;
    x1: number;
    y1: number;
    z1: number;
}
export declare const STAGES: string[];
/** All pieces of the house, in the site frame (y relative to the site ground). */
export declare function housePieces(): Piece[];
/** Coarse grid over buildings, props, trees and lamps for free-spot checks (built once). */
export declare class SpatialIndex {
    private cell;
    private b;
    private o;
    private ctx;
    constructor(ctx: RealismCtx);
    private cells;
    /** Adds an extra round obstacle (runtime content of other systems). */
    addObstacle(x: number, z: number, r: number): void;
    /** Index of a building whose footprint (+ margin) contains the point, else -1. */
    buildingAt(x: number, z: number, margin: number): number;
    /** True when a prop / tree / lamp is within margin of the point. */
    objectNear(x: number, z: number, margin: number): boolean;
    /** Free for something on foot: not in a building, not on a road, nothing standing there. */
    freeSpot(x: number, z: number, margin: number): boolean;
}
export interface ConstructionSettings {
    near: number[] | null;
    crane: boolean;
    startStock: number;
    deliveryStock: number;
    piecesPerTask: number;
    maxProjects: number;
}
export declare function constructionSettings(cfg: any): ConstructionSettings;
export declare class ConstructionSite {
    settings: ConstructionSettings;
    lot: Lot;
    project: number;
    placed: number;
    stock: number;
    done: Lot[];
    pieces: Piece[];
    ghosts: number[];
    stats: {
        searchMs: number;
        candidates: number;
    };
    private ctx;
    private index;
    private siteMesh;
    private pieceMesh;
    private ghostMesh;
    private doneMeshes;
    private body;
    private doneBodies;
    private ghostMat;
    constructor(ctx: RealismCtx, index: SpatialIndex);
    get total(): number;
    get complete(): boolean;
    /** Current stage 0..4, pieces placed in it and its size. */
    stageInfo(): {
        stage: number;
        name: string;
        inStage: number;
        stageSize: number;
        placed: number;
        total: number;
    };
    /** Site frame point to world. */
    toWorld(lx: number, ly: number, lz: number, lot?: Lot): THREE.Vector3;
    /** Where to stand to place piece i (ground level). */
    pieceSpot(i: number): THREE.Vector3;
    /** The next n unplaced pieces of the current stage. */
    nextPieces(n: number): number[];
    showGhosts(ids: number[]): void;
    /** Places the next piece (pieces go in order). Returns false without stock. */
    placeNext(): boolean;
    addStock(n: number): void;
    /** Unload spot just inside the gate. */
    unloadSpot(): THREE.Vector3;
    /** Site office (blueprints). */
    officeSpot(): THREE.Vector3;
    center(): THREE.Vector3;
    private finishProject;
    /** First free lot by distance from construction.near (or the respawn point). */
    findLot(): Lot;
    /** A lot centred at (x, z), facing its nearest road, or null when anything is in the way. */
    tryLot(x: number, z: number): Lot;
    /** Verification for tests: true when nothing of the map overlaps the lot rectangle. */
    verifyLot(L: Lot): {
        buildings: number;
        road: number;
        objects: number;
    };
    private pieceBox;
    private rebuild;
    private rebuildGhosts;
    private swap;
    private disposeSite;
    private siteGeometry;
    private buildDone;
    private addPieceShapes;
    private rebuildBody;
    private load;
    save(): void;
}
