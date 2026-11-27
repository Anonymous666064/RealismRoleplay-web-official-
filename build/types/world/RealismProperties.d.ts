import { RealismCtx } from './RealismContext';
import { Building } from './RealismMapData';
export declare const PROPERTIES_KEY = "realism.properties.v1";
export interface PropertyRecord {
    id: string;
    buildingIndex: number;
    name: string;
    kind: string;
    sub: string;
    price: number;
    owned: boolean;
    income: number;
    district: string;
    region: string;
    x: number;
    z: number;
    floors: number;
    area: number;
    npcHome: boolean;
    closed: boolean;
    hood: boolean;
    tint: number[];
    label: string;
}
export interface PropertySettings {
    priceScale: number;
    sellBack: number;
    incomeScale: number;
    taxRate: number;
    blips: boolean;
    npcHomes: boolean;
}
export declare function propertySettings(cfg: any): PropertySettings;
export declare const REGION_NAME: {
    [k: string]: string;
};
export declare const KIND_LABEL: {
    [k: string]: string;
};
export declare const KIND_ICON: {
    [k: string]: string;
};
/** Which property kind a building is sold as, or null when it isn't for sale. */
export declare function propertyKind(b: Building): string | null;
export declare class RealismProperties {
    settings: PropertySettings;
    lastError: string;
    api: any;
    private ctx;
    private world;
    private records;
    private byId;
    private byIndex;
    private owned;
    private lastDay;
    private listeners;
    private blipsDone;
    constructor(ctx: RealismCtx);
    /** Builds the listing on first use (about 1-3 ms). */
    all(): PropertyRecord[];
    private nameFor;
    get(id: string): PropertyRecord | null;
    owns(i: number): boolean;
    ownedList(): PropertyRecord[];
    kinds(): {
        [k: string]: number;
    };
    dailyIncome(): number;
    dailyTax(): number;
    sellPrice(id: string): number;
    buy(id: string): boolean;
    sell(id: string): boolean;
    setWaypoint(id: string): boolean;
    /** New in-game day index. Pays every day passed since the last payout (max 3 at once). */
    onDay(day: number): number;
    /** One day of income (and tax) now. Returns the net amount. */
    payDay(day?: number): number;
    /** Adds the blips of owned properties once realismGPS exists (called from the internet clock). */
    ensureBlips(): void;
    private blip;
    private emit;
    onChange(cb: () => void): void;
    private changed;
    private load;
    save(): void;
    private makeApi;
}
