import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
export interface DayNightSettings {
    /** false: the clock stands still at `startHour` (the time slider still works). */
    enabled: boolean;
    /** Real minutes for one full game day. */
    cycleMinutes: number;
    /** Game hour when the world starts, 0..24 (12 = noon). */
    startHour: number;
    /** 0..1, how bright the night is compared to the day (moonlight + ambient). */
    nightBrightness: number;
    /** Facade windows glow at night. */
    windowsAtNight: boolean;
}
export declare const DAY_NIGHT_DEFAULTS: DayNightSettings;
export declare function dayNightSettings(cfg: any): DayNightSettings;
export declare class RealismDayNight implements IUpdatable {
    /** After Sky (5): overrides the light direction / ambient Sky just set. */
    updateOrder: number;
    settings: DayNightSettings;
    /** Shared with other systems as (world as any).realismTime. */
    time: {
        hour: number;
    };
    night: boolean;
    private ctx;
    private world;
    private sunBase;
    private lamps;
    private windows;
    private scanned;
    private applied;
    private tmpColor;
    private tmpDir;
    constructor(ctx: RealismCtx);
    setEnabled(on: boolean): void;
    setCycleMinutes(m: number): void;
    setHour(h: number): void;
    get hour(): number;
    /** "13:05" */
    static format(h: number): string;
    update(timeStep: number, unscaledTimeStep: number): void;
    /** Pushes the current hour into the sky, lights, fog and lamps. */
    applyNow(): void;
    /** At night the directional light comes from the moon (opposite the sun) instead of from below. */
    private lightDirection;
    private scan;
    private setNight;
    /** Re-applies the window glow after windowsAtNight changed. */
    refreshLamps(): void;
}
