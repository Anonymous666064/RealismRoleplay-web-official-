import { IllegalCore, PocketRoom, Site } from './RealismIllegalCore';
export declare const HIDEOUT_DEFAULTS: {
    enabled: boolean;
    basement: boolean;
    backroom: boolean;
    container: boolean;
    bedEnergy: number;
};
export interface Hideout {
    id: string;
    name: string;
    entrance: Site;
    room: PocketRoom;
    exit: {
        x: number;
        z: number;
    };
    slots: {
        x: number;
        z: number;
        rot: number;
        used: boolean;
    }[];
    building: number;
}
export declare class Hideouts {
    list: Hideout[];
    cfg: any;
    private core;
    private near;
    private acc;
    private tmp;
    constructor(core: IllegalCore);
    get(id: string): Hideout;
    /** Next free station slot in a hideout (local coords), or null. */
    slot(id: string): {
        x: number;
        z: number;
        rot: number;
    } | null;
    private basement;
    private backroom;
    private container;
    /** Shared interior dressing: lamp strips, crates, an exit door, stash + bed. */
    private finishRoom;
    private register;
    enter(id: string): boolean;
    stash(id: string): {
        items: {
            [k: string]: number;
        };
        cash: number;
    };
    /** Moves items / cash: dir 'in' (pocket -> stash) or 'out'. qty <= 0 = all. */
    moveItem(id: string, item: string, dir: string, qty: number): number;
    moveCash(id: string, dir: string, amount: number): number;
    openStash(id: string): void;
    rested: number;
    rest(): void;
    update(dt: number): void;
    describe(): any[];
}
