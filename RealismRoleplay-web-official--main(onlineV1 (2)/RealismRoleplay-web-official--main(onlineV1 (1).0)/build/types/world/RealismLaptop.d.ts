import { RealismCtx } from './RealismContext';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismProperties } from './RealismProperties';
import { RealismSocial } from './RealismSocial';
import { Site, GuideRegistry, LaptopLike } from './RealismInternetSites';
import { VideoPlayer } from './RealismInternetMedia';
export interface LaptopSettings {
    homepage: string;
    wallpaper: string;
    clock24: boolean;
    maxTabs: number;
}
export declare function laptopSettings(cfg: any): LaptopSettings;
interface Tab {
    url: string;
    back: string[];
    fwd: string[];
}
export declare class RealismLaptop implements IUpdatable, LaptopLike {
    updateOrder: number;
    world: any;
    ctx: RealismCtx;
    settings: LaptopSettings;
    social: RealismSocial;
    props: RealismProperties;
    guides: GuideRegistry;
    inputs: {
        [k: string]: string;
    };
    state: {
        [k: string]: any;
    };
    player: VideoPlayer;
    sites: Site[];
    isOpen: boolean;
    winOpen: boolean;
    tabs: Tab[];
    tab: number;
    api: any;
    stats: {
        opens: number;
        renders: number;
        canvasesDrawn: number;
        socialTicks: number;
        payDays: number;
    };
    pageEl: any;
    root: any;
    private siteMap;
    private onCloseCb;
    private wasLocked;
    private desktopEl;
    private winEl;
    private tabsEl;
    private addrEl;
    private clockEl;
    private ppEl;
    private seekEl;
    private timeEl;
    private mapCache;
    private watching;
    private minutes;
    private lastTickMin;
    private lastHour;
    private day;
    private slowAcc;
    private uiAcc;
    private hookedEvents;
    private hookedEco;
    private lastTxId;
    private handlers;
    constructor(ctx: RealismCtx);
    private makeApi;
    open(opts?: {
        onClose?: () => void;
        location?: string;
    }): void;
    close(): void;
    private buildDom;
    private iconHtml;
    private destroyDom;
    private bindDom;
    /** Window capture: Esc closes; while open, keys outside the laptop never reach the game. */
    private bindWindowKeys;
    /** Public for tests. Returns true when the key was consumed. */
    onWindowKey(e: any): boolean;
    parse(url: string): {
        domain: string;
        path: string;
        q: {
            [k: string]: string;
        };
        url: string;
    };
    /** Normalises what was typed: a known domain, a site name, or a search. */
    normal(input: string): string;
    get current(): string;
    go(url: string, noHistory?: boolean): void;
    back(): void;
    forward(): void;
    notice(text: string, err?: boolean): void;
    /** Runs a laptop or site action (data-act). Public for tests. */
    act(a: string, arg: string): void;
    /** Builds the current page as HTML (also used headless). */
    pageHtml(url?: string): {
        title: string;
        html: string;
        theme: string;
    };
    render(): void;
    private lastRendered;
    /** Draws the page's canvases and attaches the video player. */
    private mount;
    /** 'avatar:handle' | 'photo:id' | 'facade:b12' | 'map:b12' | 'thumb:v3'. Public for tests. */
    drawSpec(spec: string, g: any, w: number, h: number): boolean;
    private disposePlayer;
    private updatePlayerUi;
    private updateClock;
    private syncCarNames;
    update(timeStep: number, unscaled: number): void;
    /** Game minutes on the internet clock (tests). */
    get gameMinutes(): number;
    private hookEvents;
    private lastTx;
    /** A car bought at a dealer (phone app or a website) shows up on Chirp. */
    private onMoney;
}
/** RealismWorldBuilder hook. Never throws. */
export declare function buildInternet(ctx: RealismCtx): void;
export {};
