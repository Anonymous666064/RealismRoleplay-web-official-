import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
/** Defaults. realism-config.js -> player overrides them. */
export declare const DEFAULT_PLAYER: any;
/** Height of the original boxman in metres (measured, skinned idle pose). */
export declare const BOXMAN_HEIGHT = 1.024;
export declare class RealismPlayer implements IUpdatable {
    updateOrder: number;
    settings: any;
    scale: number;
    seatedScale: number;
    speedFactor: number;
    applied: number;
    private world;
    private version;
    constructor(ctx: RealismCtx);
    private readSettings;
    update(timeStep: number, unscaledTimeStep: number): void;
}
