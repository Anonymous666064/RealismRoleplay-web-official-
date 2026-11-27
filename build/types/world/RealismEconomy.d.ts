import { RealismCtx } from './RealismContext';
export declare const ECONOMY_KEY = "realism.economy.v1";
export interface Tx {
    id: string;
    time: number;
    gameHour?: number;
    gameDay?: number;
    amount: number;
    balance: number;
    account: string;
    description: string;
    merchant: string;
    method: string;
}
export interface CardInfo {
    number: string;
    last4: string;
    name: string;
    expiry: string;
    bank: string;
    frozen: boolean;
}
export interface EconomySettings {
    startBank: number;
    startCash: number;
    cardName: string;
    bankName: string;
    historyCap: number;
    atmAnywhere: boolean;
    atmRange: number;
    hudSeconds: number;
    showHud: boolean;
}
export declare function economySettings(cfg: any): EconomySettings;
export declare function money(v: number, sign?: boolean): string;
export declare class RealismEconomy {
    updateOrder: number;
    settings: EconomySettings;
    bank: number;
    cash: number;
    cardInfo: CardInfo;
    txs: Tx[];
    gameDay: number;
    lastError: string;
    api: any;
    private seq;
    private ctx;
    private world;
    private listeners;
    private lastHour;
    private atms;
    private hud;
    private hudCash;
    private hudBank;
    private hudDelta;
    private hudUntil;
    private hudAcc;
    private tmp;
    constructor(ctx: RealismCtx);
    private fresh;
    private newCard;
    private load;
    save(): void;
    private record;
    private changed;
    canAfford(amount: number, method?: string): boolean;
    spend(amount: number, description: string, merchant: string, method?: string): boolean;
    earn(amount: number, description: string, source: string, to?: string): void;
    /** Cash -> bank. */
    deposit(amount: number): boolean;
    /** Bank -> cash. */
    withdraw(amount: number): boolean;
    private transfer;
    setFrozen(on: boolean): void;
    /** Wipes the account back to the starting amounts (new card, empty history). */
    reset(): void;
    private findATMs;
    /** Name of the ATM the player is at (or 'Mobile banking' when atmAnywhere), else null. */
    atATM(): string | null;
    /** The nearest ATM: { name, distance } (for the Bank app). */
    nearestATM(): {
        name: string;
        distance: number;
        x: number;
        z: number;
    } | null;
    private playerPos;
    update(timeStep: number, unscaled: number): void;
    private ensureHud;
    /** Shows the cash / bank readout for a few seconds (delta 0: no +/- line). */
    showHud(delta: number, seconds?: number): void;
    private flashDeclined;
    history(): Tx[];
    onChange(cb: () => void): void;
    private makeApi;
}
/** RealismWorldBuilder hook: money, bank card, jobs. Safe to call once; never throws. */
export declare function buildEconomy(ctx: RealismCtx): void;
