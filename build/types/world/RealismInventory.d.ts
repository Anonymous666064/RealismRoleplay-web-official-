import { RealismCtx } from './RealismContext';
export declare const INVENTORY_KEY = "realism.inventory.v1";
export interface ItemDef {
    name: string;
    icon?: string;
    legal?: boolean;
    value?: number;
}
export declare class RealismInventory {
    api: any;
    private order;
    private qty;
    private meta;
    private defs;
    private listeners;
    private maxStack;
    private saveTimer;
    constructor(ctx: RealismCtx);
    defOf(id: string): ItemDef;
    define(id: string, def: ItemDef): void;
    add(id: string, qty: number, meta?: any): void;
    remove(id: string, qty: number): boolean;
    count(id: string): number;
    list(): Array<{
        id: string;
        name: string;
        qty: number;
    }>;
    private emit;
    private scheduleSave;
    private load;
    save(): void;
}
/** Creates (world as any).realismInventory once. Returns the implementation. */
export declare function buildInventory(ctx: RealismCtx): RealismInventory;
