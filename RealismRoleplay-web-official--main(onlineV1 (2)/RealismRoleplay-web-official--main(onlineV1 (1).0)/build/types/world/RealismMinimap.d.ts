import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { RealismGPS, HudSettings } from './RealismGPS';
/** Blip looks: background colour and glyph. */
export declare const BLIP_STYLE: {
    [icon: string]: {
        bg: string;
        g: string;
    };
};
/** A pre-rendered blip icon (cached). radius in device pixels. */
export declare function blipSprite(icon: string, color: string, radius: number): HTMLCanvasElement;
interface Tile {
    key: number;
    tx: number;
    tz: number;
    canvas: HTMLCanvasElement;
    used: number;
}
/** Renders the county map into canvases: the base image and the detail tiles. */
export declare class MapRenderer {
    base: HTMLCanvasElement;
    tiles: {
        [key: number]: Tile;
    };
    tileCount: number;
    stats: {
        tilesRendered: number;
        baseMs: number;
        tileMs: number;
    };
    private data;
    private detail;
    private maxTiles;
    private roadBox;
    private frame;
    private budget;
    constructor(data: any, detail: number, maxTiles: number);
    get detailPPM(): number;
    /** Allows `n` tile renders until the next call (one frame). */
    newFrame(n: number): void;
    ensureBase(): HTMLCanvasElement;
    /** Detail tile covering tile column / row, or null while not rendered yet (within this frame's budget it is rendered now). */
    tile(tx: number, tz: number): HTMLCanvasElement;
    /** Draws the stylised map of the square (x0, z0, size m) at ppm pixels per metre at the canvas origin. */
    private drawArea;
}
/** Draws the GPS route (world coordinates; the caller has set the transform). */
export declare function strokeRoute(g: CanvasRenderingContext2D, gps: RealismGPS, from: number, pxPerUnit: number, widthPx: number, color: string, dash: number[]): void;
export declare class RealismMinimap implements IUpdatable {
    updateOrder: number;
    ctx: RealismCtx;
    world: any;
    gps: RealismGPS;
    settings: HudSettings;
    map: MapRenderer;
    bigMapOpen: boolean;
    stats: {
        draws: number;
        bigDraws: number;
        lastDrawMs: number;
        avgDrawMs: number;
        blipsDrawn: number;
        clamped: number;
        tilesDrawn: number;
    };
    /** Current view (for tests): metres per CSS pixel and rotation (radians). */
    mpp: number;
    rotation: number;
    private frame;
    private canvas;
    private g;
    private W;
    private H;
    private dpr;
    private acc;
    private visible;
    private ps;
    private camDir;
    private dash;
    private clampOut;
    private big;
    private bigCanvas;
    private bigG;
    private bigInfo;
    private bigW;
    private bigH;
    private bigDpr;
    view: {
        x: number;
        z: number;
        ppm: number;
    };
    private bigAcc;
    private bigDirty;
    private wasLocked;
    private drag;
    private keyHandler;
    constructor(ctx: RealismCtx, gps: RealismGPS, settings: HudSettings);
    private buildDom;
    private show;
    update(timeStep: number, unscaledTimeStep: number): void;
    /** One minimap redraw. */
    draw(step?: number): void;
    /** Base image + detail tiles for the world rectangle (canvas transform already set to world units). */
    private drawMapArea;
    /** Keeps a screen point inside the rounded frame (margin m, corner radius rr). */
    private clampRim;
    private arrow;
    private bindKeys;
    /** Keyboard (window, capture). Public for tests. */
    onKey(e: KeyboardEvent): void;
    /** Opens the full-screen map. Returns false when it can't open now (paused, another overlay). */
    openBigMap(relock?: boolean): boolean;
    closeBigMap(): void;
    private centreBig;
    private ensureBig;
    private resizeBig;
    private minPPM;
    /** Screen (CSS px, relative to the canvas) -> world. */
    bigToWorld(sx: number, sy: number, out: {
        x: number;
        z: number;
    }): {
        x: number;
        z: number;
    };
    private zoomBig;
    private clampView;
    private rel;
    private relXY;
    /** Pointer input on the big map (CSS client coordinates). Public for tests. */
    onDown(cx: number, cy: number, button: number): void;
    onMove(cx: number, cy: number): void;
    onUp(cx: number, cy: number, button: number): void;
    private wtmp;
    /** A click at canvas CSS pixel (x, y): blip -> waypoint there, waypoint -> clear, else waypoint here. */
    clickAt(x: number, y: number): void;
    /** Full-screen map redraw (on change and a few times a second while open). */
    drawBig(): void;
}
export declare function fmtDist(m: number): string;
/**
 * Builds the GPS (C8) and the minimap / full-screen map. Call once the county is built.
 * (Events (C14) and prompts (C7) are created earlier with ensureEvents / ensurePrompts.)
 */
export declare function buildHud(ctx: RealismCtx, settings: HudSettings): {
    gps: RealismGPS;
    minimap: RealismMinimap;
};
export {};
