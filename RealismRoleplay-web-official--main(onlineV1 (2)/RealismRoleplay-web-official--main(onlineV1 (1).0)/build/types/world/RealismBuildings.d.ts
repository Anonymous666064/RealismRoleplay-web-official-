import { Building } from './RealismMapData';
import { RealismCtx } from './RealismContext';
import { Frame } from './RealismGeometry';
export interface Room {
    type: string;
    x0: number;
    x1: number;
    z0: number;
    z1: number;
    y: number;
    h: number;
    doors: number[][];
    windows?: number[][];
}
export interface InteriorPlan {
    b: Building;
    f: Frame;
    rooms: Room[];
    hood: boolean;
    seed: number;
}
export declare class BuildingBuilder {
    private ctx;
    private set;
    plans: InteriorPlan[];
    private signBatches;
    stats: {
        shells: number;
        enterable: number;
        houses: number;
        windows: number;
        replaced: number;
    };
    constructor(ctx: RealismCtx);
    private acc;
    build(): void;
    flush(signs?: boolean): void;
    /** A flat sign panel (texture batch keyed by text). */
    sign(f: Frame, text: string, bg: string, fg: string, cx: number, cy: number, cz: number, width: number, facing: number): void;
    private silo;
    building(b: Building, index: number): void;
    private window;
    private houseRooms;
    private cityRooms;
    private houseExterior;
    private cityExterior;
    private roof;
    private labelSign;
    /** Registers real doors for every doorway in the outer walls (front + back). */
    private outerDoors;
    /** Closed / abandoned building: plywood over the door(s) and shop windows, a CLOSED / FOR LEASE sign. */
    private closedUp;
    /**
     * A wall decal (grime, streak, graffiti) on side `s`, cut around every keep-out rectangle
     * (doorways, doors, windows). u is along the side, y is world height; UVs follow the cut.
     */
    private decal;
    private decay;
}
/** Material for see-through window glass (shared, created lazily). */
export declare function ensureGlassMaterial(ctx: RealismCtx): void;
