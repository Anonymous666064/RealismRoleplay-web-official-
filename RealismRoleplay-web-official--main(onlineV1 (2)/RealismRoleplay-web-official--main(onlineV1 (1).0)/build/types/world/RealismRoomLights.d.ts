import { RealismCtx } from './RealismContext';
export declare class RoomLights {
    private ctx;
    private furniture;
    private off;
    private spots;
    private savedY;
    toggles: number;
    constructor(ctx: RealismCtx, store: any, furniture: any);
    private addSpot;
    isOn(room: number): boolean;
    toggle(room: number): boolean;
    set(room: number, on: boolean): void;
    /** Light spot indices of a room (tests). */
    spotsOf(room: number): number[];
}
