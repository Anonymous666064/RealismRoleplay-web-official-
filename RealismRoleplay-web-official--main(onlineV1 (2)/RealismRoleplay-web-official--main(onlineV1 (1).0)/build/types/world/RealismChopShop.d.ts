import { IllegalCore, Site } from './RealismIllegalCore';
export declare class ChopShop {
    api: any;
    spray: Site;
    vin: Site;
    fence: Site;
    fenceStand: {
        x: number;
        y: number;
        z: number;
    };
    palette: {
        name: string;
        rgb: number[];
    }[];
    pendingSale: {
        id: string;
        price: number;
        car: any;
        t: number;
    };
    sold: {
        id: string;
        price: number;
    }[];
    private core;
    private near;
    private nearAcc;
    private watchAcc;
    private eventsHooked;
    private tmp;
    constructor(core: IllegalCore);
    private place;
    private build;
    private hookCars;
    private syncMeta;
    private hookEvents;
    private carIn;
    private sprayItems;
    private sprayAct;
    /** Repaints a car, updates its owned record (rgb, hot: false). Charges cash. */
    respray(car: any, rgb: number[]): boolean;
    private vinItems;
    private vinAct;
    scratchVin(car: any): boolean;
    /** What the fence pays for a car, or why he won't take it. */
    quote(car: any): {
        ok: boolean;
        price: number;
        reason: string;
        base?: number;
        factors?: any;
    };
    private condition;
    private carInFence;
    private fenceItems;
    private fenceAct;
    /** Gets the player out, then removes the car and pays cash. */
    sell(car: any): boolean;
    private tryFinishSale;
    update(dt: number): void;
}
