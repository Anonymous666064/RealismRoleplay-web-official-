import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
import { VehicleTuning } from './RealismVehicleTuning';
export interface ShopOption {
    id: string;
    name: string;
    price: number;
    values: any;
}
export interface ShopGroup {
    id: string;
    cat: string;
    name: string;
    options: ShopOption[];
}
export declare const DEFAULT_PALETTE: {
    name: string;
    rgb: number[];
}[];
export declare const DEFAULT_PRICES: {
    [k: string]: number;
};
export declare class ModShop {
    updateOrder: number;
    api: any;
    bay: {
        x: number;
        z: number;
        y: number;
        rot: number;
        w: number;
        d: number;
        fx: number;
        fz: number;
        rx: number;
        rz: number;
    };
    isOpen: boolean;
    car: any;
    committed: any;
    preview: any;
    groups: ShopGroup[];
    palette: {
        name: string;
        rgb: number[];
    }[];
    settings: any;
    lastMessage: string;
    hintText: string;
    meshes: THREE.Object3D[];
    private ctx;
    private tuning;
    private prices;
    private cat;
    private hint;
    private overlay;
    private wasLocked;
    private savedRadius;
    private owned;
    private hsv;
    private prevFlags;
    private bought;
    constructor(ctx: RealismCtx, tuning: VehicleTuning);
    private findBay;
    private buildBay;
    private canvas;
    private floorTexture;
    private signTexture;
    inBay(car: any): boolean;
    /** Option groups for this car (engine / steering levels are relative to its stock values). */
    private buildGroups;
    private matchOption;
    private groupChanged;
    private paintChanged;
    /** Items that differ from what the car already has, with prices. */
    cart(): {
        group: string;
        name: string;
        price: number;
    }[];
    total(): number;
    private drivenCar;
    private record;
    open(carIn?: any): boolean;
    private hold;
    /** Preview one option of a group on the car. */
    select(groupId: string, optionId: string): void;
    setColor(rgb: number[]): void;
    setFinish(f: string): void;
    buy(): boolean;
    /** Leaves the shop and puts back everything that was not bought. */
    exit(): void;
    update(timeStep: number, unscaled: number): void;
    private setHint;
    private bindInput;
    /** Public for tests. */
    onKey(e: any): boolean;
    private ensureOverlay;
    private onClick;
    private onInput;
    /** Slider drag: preview without rebuilding the sliders under the mouse; only the cart is refreshed. */
    private setColorQuiet;
    private render;
    private renderCart;
}
