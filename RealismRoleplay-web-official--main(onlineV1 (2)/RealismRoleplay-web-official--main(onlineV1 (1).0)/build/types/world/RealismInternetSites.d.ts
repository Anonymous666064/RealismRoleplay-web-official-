import { RealismSocial } from './RealismSocial';
export interface LaptopLike {
    world: any;
    ctx: any;
    social: RealismSocial;
    props: any;
    guides: GuideRegistry;
    inputs: {
        [k: string]: string;
    };
    state: {
        [k: string]: any;
    };
    go(url: string): void;
    notice(text: string, err?: boolean): void;
    player: any;
}
export interface Site {
    domain: string;
    name: string;
    icon: string;
    color: string;
    desc: string;
    keywords: string;
    render(path: string, q: {
        [k: string]: string;
    }, L: LaptopLike): string;
    act?(a: string, arg: string, L: LaptopLike): boolean;
    theme?: string;
}
export declare function esc(s: any): string;
export interface Guide {
    id: string;
    title: string;
    category: string;
    body: string;
    waypoint?: {
        x: number;
        z: number;
        label: string;
    };
    author?: string;
}
/** (world as any).realismGuides = { add(guide), list(), get(id), remove(id) }. add() replaces a guide with the same id. */
export declare class GuideRegistry {
    guides: Guide[];
    private listeners;
    add(g: Guide): boolean;
    get(id: string): Guide | null;
    list(): Guide[];
    remove(id: string): boolean;
    onChange(cb: () => void): void;
    private changed;
    api(): any;
}
/**
 * Built-in guides. CONTENT RULE: these only explain GAME mechanics (keys, places on the map,
 * prices, heat, timers). No real-world methods, ingredients, quantities or equipment.
 * Other systems (A17) register their own with realismGuides.add(), same id = replace.
 */
export declare function defaultGuides(data: any): Guide[];
export declare const DEALER_NAMES: string[];
export declare function buildSites(): Site[];
/** Same purchase path as the phone Dealership: realismEconomy.spend, then realismOwnedCars.add. */
export declare function buyCar(L: LaptopLike, itemId: string, merchant: string): any;
