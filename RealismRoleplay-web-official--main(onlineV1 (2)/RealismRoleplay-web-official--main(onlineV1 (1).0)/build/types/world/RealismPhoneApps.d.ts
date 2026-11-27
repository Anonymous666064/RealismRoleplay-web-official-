import { RealismCtx } from './RealismContext';
export interface PhoneHost {
    world: any;
    ctx: RealismCtx;
    isOpen: boolean;
    app: string;
    close(relock: boolean): void;
    locate(x: number, z: number, label: string): void;
}
interface Paint {
    name: string;
    rgb: number[];
}
export interface CatalogItem {
    id: string;
    type: string;
    name: string;
    trim: string;
    price: number;
    paints: Paint[];
    desc: string;
}
export declare function dealershipSettings(cfg: any): {
    prices: {
        [k: string]: number;
    };
    aircraft: boolean;
    exclude: string[];
    sellBack: number;
};
export declare class PhoneApps {
    private host;
    private views;
    private msg;
    private txFilter;
    private dealSel;
    private dealConfirm;
    private garageConfirm;
    private garageSig;
    private amount;
    private hooked;
    constructor(host: PhoneHost);
    private get world();
    private get eco();
    private get cars();
    private get jobs();
    private get legal();
    private jobsTab;
    /** The container of an app (RealismPhone builds it). */
    attach(id: string, el: HTMLElement): void;
    /** Called when an app opens. */
    open(id: string): void;
    /** Called about 4 times a second while the phone shows `id`. */
    tick(id: string, n: number): void;
    private hook;
    render(id: string): void;
    private say;
    private msgHtml;
    private playerSeat;
    private playerXZ;
    private act;
    private renderBank;
    private renderBankStatus;
    catalog(): CatalogItem[];
    private renderDealer;
    /** Buys a catalogue item with the selected paint. Returns the new record or null. */
    buy(itemId: string, paintIndex?: number): any;
    private renderGarage;
    sellValue(r: any): number;
    private garageYes;
    /** Old-style list (a plain array / object in world.realismOwnedCars). */
    private legacyGarage;
    private jobsSig;
    /** Changes whenever something shown by the trades part of the Jobs app changes. */
    private legalSig;
    private renderJobs;
    private taskHtml;
    private renderTaskDistance;
    private tradeInfoHtml;
    private inventoryHtml;
}
export {};
