import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
export declare const NEED_NAMES: string[];
export declare const DEFAULT_NEEDS: {
    enabled: boolean;
    hud: boolean;
    toasts: boolean;
    lowThreshold: number;
    sprintPenalty: boolean;
    rates: {
        hunger: number;
        thirst: number;
        energy: number;
        hygiene: number;
        bladder: number;
    };
    sleepRates: {
        hunger: number;
        thirst: number;
        energy: number;
        hygiene: number;
        bladder: number;
    };
    swimEnergyFactor: number;
    hudBottom: number;
    hudLeft: number;
};
export declare let lastToast: string;
/** Short message at the top centre of the screen. Safe headless. */
export declare function realismToast(text: string, ms?: number): void;
export declare class RealismNeeds implements IUpdatable {
    updateOrder: number;
    settings: any;
    values: {
        [k: string]: number;
    };
    swimming: boolean;
    sleeping: boolean;
    stats: {
        decayHours: number;
        lowEvents: number;
        hudUpdates: number;
    };
    private world;
    private listeners;
    private low;
    private lastHour;
    private saveAcc;
    private dirty;
    private hud;
    private rings;
    private shown;
    private penaltyOn;
    constructor(ctx: RealismCtx);
    get(name: string): number;
    set(name: string, v: number): void;
    add(name: string, delta: number): void;
    /** Lowers every need by `hours` game hours of decay (optional per-need multipliers). */
    decay(hours: number, factors?: {
        [k: string]: number;
    }): void;
    private changed;
    private checkLow;
    update(timeStep: number, unscaledTimeStep: number): void;
    private applyPenalty;
    private hudVisible;
    private buildHud;
    private showHud;
    private refreshHud;
    private load;
    save(): void;
}
