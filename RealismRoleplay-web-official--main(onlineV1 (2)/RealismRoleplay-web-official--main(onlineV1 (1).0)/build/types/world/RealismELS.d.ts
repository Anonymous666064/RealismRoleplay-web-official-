import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
export declare const LED_COUNT = 24;
export declare const ATLAS_W = 1024, ATLAS_H = 256;
/** Quad builder: positions, uvs, colors, normals. A quad faces u x v. uvr = atlas pixel rect. */
export declare class QuadBuilder {
    pos: number[];
    uv: number[];
    col: number[];
    nor: number[];
    count: number;
    quad(cx: number, cy: number, cz: number, u: number[], v: number[], w: number, h: number, uvr?: number[], rgb?: number[]): void;
    /** Axis-aligned box from 6 quads. */
    box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rgb: number[]): void;
    geometry(withUv: boolean, withColor: boolean): THREE.BufferGeometry;
}
/** Where things are on the sedan, in car space. */
export interface CarLayout {
    roofY: number;
    roofZ0: number;
    roofZ1: number;
    roofHalfW: number;
    trunkY: number;
    trunkZ: number;
    frontZ: number;
    grilleY: number;
    headX: number;
    headY: number;
    headZ: number;
    rearZ: number;
    rearY: number;
    halfW: number;
}
/** Lightbar dimensions and segment positions (car space). Position 0 = driver side (+x). */
export declare function barLayout(L: CarLayout): {
    y: number;
    z: number;
    w: number;
    h: number;
    d: number;
    segX: number[];
};
export interface FlashPattern {
    name: string;
    step: number;
    frames: number[];
}
/** Bar patterns: 8-bit masks over bar positions 0..7 (bit i = position i, 0-3 driver side). */
export declare const PATTERNS: FlashPattern[];
/** Traffic advisor patterns (stage 1, rear, amber). */
export declare const TA_PATTERNS: FlashPattern[];
export declare const TONES: string[];
export interface ELSUnit {
    car: any;
    stage: number;
    pattern: number;
    taPattern: number;
    siren: boolean;
    tone: number;
    horn: boolean;
    takedown: boolean;
    alley: boolean;
    t: number;
    lastFrame: number;
    dirty: boolean;
    led: THREE.Mesh;
    colors: Float32Array;
    colorAttr: THREE.BufferAttribute;
    beam: THREE.Mesh;
    beamColors: Float32Array;
    beamAttr: THREE.BufferAttribute;
    beamVerts: number;
    barX: number[];
    barY: number;
    barZ: number;
    frontZ: number;
    sirenNodes: any;
    hornNodes: any;
    litA: boolean;
    litB: boolean;
}
export declare class ELSSystem {
    units: ELSUnit[];
    api: any;
    stats: {
        [k: string]: number;
    };
    settings: any;
    private ctx;
    private police;
    private ledMat;
    private beamMat;
    private colA;
    private colB;
    private amber;
    private white;
    private lights;
    private audio;
    private master;
    private keys;
    private hud;
    private hudKey;
    private driven;
    private tmpV;
    private tmpV2;
    private paused;
    constructor(ctx: RealismCtx, police: any);
    unitOf(car: any): ELSUnit;
    attach(car: any, L: CarLayout): THREE.Mesh[];
    private beamGeometry;
    detach(car: any, dispose?: boolean): void;
    setStage(u: ELSUnit, n: number): void;
    setSiren(u: ELSUnit, on: boolean, fromStage?: boolean): void;
    setPattern(u: ELSUnit, i: number): void;
    update(timeStep: number, unscaled: number): void;
    /** Writes the LED colours for the current flash frame (only when it changed). */
    paint(u: ELSUnit): void;
    private setEl;
    private makeLights;
    private updateLights;
    private ensureAudio;
    private out;
    private startSiren;
    private retone;
    private stopSiren;
    /** Siren loudness: full inside the car, fading with distance outside. */
    private sirenGain;
    private volume;
    private muteAll;
    setHorn(u: ELSUnit, on: boolean): void;
    private drivenUnit;
    private bindInput;
    /** Public for tests. Returns true when the key was used. */
    onKey(e: any, down: boolean): boolean;
    private keyName;
    private updateHud;
    private css;
    private ensureHud;
    get hudText(): string;
}
