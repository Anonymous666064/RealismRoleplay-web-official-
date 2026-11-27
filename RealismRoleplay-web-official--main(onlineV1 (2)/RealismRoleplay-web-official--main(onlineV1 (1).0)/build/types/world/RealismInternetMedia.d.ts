/** GTA-style minimap palette, shared with the timelapse and the property maps. */
export declare const MINIMAP: {
    land: string;
    land2: string;
    road: string;
    major: string;
    water: string;
    park: string;
    building: string;
    text: string;
};
export declare function hash(n: number): number;
export declare function hsl(h: number, s: number, l: number): string;
export declare const mediaStats: {
    draws: number;
};
export declare function drawAvatar(g: any, size: number, name: string, hue: number): void;
export declare function drawPhoto(g: any, w: number, h: number, kind: string, seed: number, hour: number): void;
export declare function drawFacade(g: any, w: number, h: number, p: {
    kind: string;
    tint: number[];
    floors: number;
    closed: boolean;
    hood: boolean;
    buildingIndex: number;
    label?: string;
}): void;
/** Top-down map around (x, z) in minimap colours with a pin. */
export declare function drawMapPreview(g: any, w: number, h: number, data: any, x: number, z: number, radius: number, buildings?: any[]): void;
export interface VideoInfo {
    id: string;
    title: string;
    kind: string;
    dur: number;
    seed: number;
    h: string;
    extra?: string;
}
/** Road segments of the county in 0..1 coordinates (built once for the timelapse). */
export declare class MapCache {
    segs: Float32Array;
    major: Uint8Array;
    count: number;
    constructor(data: any);
}
/** Draws one frame of a video at time t (seconds). */
export declare function drawVideoFrame(g: any, w: number, h: number, v: VideoInfo, t: number, map: MapCache): void;
/** Plays one video into a canvas. step() is driven by the laptop's update, only while visible. */
export declare class VideoPlayer {
    canvas: any;
    video: VideoInfo;
    time: number;
    playing: boolean;
    frames: number;
    ended: boolean;
    private g;
    private map;
    private acc;
    private w;
    private h;
    constructor(canvas: any, video: VideoInfo, map: MapCache);
    /** Moves the player to a new canvas (the page was re-rendered) keeping time / state. */
    rebind(canvas: any): void;
    play(): void;
    pause(): void;
    toggle(): void;
    seek(t: number): void;
    /** Advances while playing; redraws at most 20 times a second. Returns true when a frame was drawn. */
    step(dt: number): boolean;
    draw(): void;
    dispose(): void;
}
export declare function fmtTime(s: number): string;
