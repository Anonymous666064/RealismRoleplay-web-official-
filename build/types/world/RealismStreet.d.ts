import { RealismCtx } from './RealismContext';
import { AssetInstancer } from './RealismAssets';
import { IUpdatable } from '../interfaces/IUpdatable';
/** Pole + mast arm toward local -x, signal housings facing +z. Variant 0: 4 m arm, 1: 6.5 m arm. */
export declare const SIGNAL_ARM: number[];
export declare const SIGNAL_HEAD_Y = 5.6;
export declare const SIGNAL_POLE_HEAD_Y = 3;
export declare function defineStreetAssets(ctx: RealismCtx, inst: AssetInstancer): void;
/** Adds a street-furniture instance plus its collider. */
export declare function placeProp(ctx: RealismCtx, inst: AssetInstancer, name: string, x: number, y: number, z: number, r: number, variant?: number, len?: number): void;
export declare function buildStreet(ctx: RealismCtx, inst: AssetInstancer): TrafficSignals;
export declare class TrafficSignals implements IUpdatable {
    updateOrder: number;
    private ctx;
    private list;
    private lens;
    private slots;
    private time;
    private acc;
    enabled: boolean;
    constructor(ctx: RealismCtx);
    addApproach(x: number, y: number, z: number, ry: number, v: number, group: number, phase: number): void;
    build(): void;
    private state;
    private apply;
    update(timeStep: number): void;
    get count(): number;
}
