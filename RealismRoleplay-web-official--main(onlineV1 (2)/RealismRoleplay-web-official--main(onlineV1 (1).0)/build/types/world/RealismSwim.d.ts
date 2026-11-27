import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
export declare const DEFAULT_SWIMMING: {
    enabled: boolean;
    enterDepth: number;
    exitDepth: number;
    floatOffset: number;
    speed: number;
    fastSpeed: number;
    diveSpeed: number;
    maxDive: number;
    pitch: number;
    climbHeight: number;
    splashes: boolean;
    sounds: boolean;
};
export declare class RealismSwim implements IUpdatable {
    updateOrder: number;
    settings: any;
    active: boolean;
    level: number;
    ch: any;
    stats: {
        starts: number;
        stops: number;
        climbs: number;
        splashes: number;
    };
    targetY: number;
    private world;
    private ctx;
    private lake;
    private sfx;
    private dive;
    private savedRay;
    private diving;
    private phase;
    private pitchNow;
    private move;
    private lastStroke;
    private climbAcc;
    private climb;
    private prevWeapon;
    private hook;
    private bones;
    private bonesOf;
    private q;
    private ax;
    private az;
    private tmpV;
    private rayRes;
    private rayFrom;
    private rayTo;
    private rayOpts;
    private splash;
    private sv;
    private sLife;
    private splashLive;
    private keyC;
    private handlers;
    constructor(ctx: RealismCtx);
    /** Water surface height at (x, z), or -Infinity where there's no water. */
    waterLevelAt(x: number, z: number): number;
    /** Held C (dive) for tests / other input. */
    setDive(on: boolean): void;
    private player;
    private sc;
    update(timeStep: number, unscaledTimeStep: number): void;
    /** Starts swimming (called when the chest goes under; public for tests). */
    start(ch: any): void;
    /** Stops swimming. stand = put the character on its feet (Idle). */
    stop(stand: boolean): void;
    /** Highest walkable ground under (x, z) between y and minY, or -Infinity. */
    private groundBelow;
    /** Buoyancy: vertical speed towards the float height, every physics step (gravity compensated). */
    private postStep;
    private tryClimb;
    private updateClimb;
    private findBones;
    private turn;
    /** Procedural swim strokes on top of the idle clip (runs after the mixer each frame). */
    private animate;
    private ensureSplash;
    emitSplash(x: number, y: number, z: number, count: number, power: number): void;
    private updateSplash;
}
