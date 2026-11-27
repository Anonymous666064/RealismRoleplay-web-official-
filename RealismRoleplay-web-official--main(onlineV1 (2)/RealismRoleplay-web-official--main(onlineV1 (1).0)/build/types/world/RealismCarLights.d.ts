/**
 * Car lights for every car: headlights, tail lights, brake lights, reverse lights, turn signals
 * and hazards.
 *
 *  - Lens geometry: small quads on the car.glb body (front / rear faces, measured from the body
 *    vertices, not guessed). Parts: 0 left head, 1 right head, 2 tail/brake, 3 reverse,
 *    4 left indicators (front + rear), 5 right indicators. Left = +x (the driver side of car.glb).
 *  - Instanced cars (traffic, parked NPC cars): one InstancedMesh of lenses + one InstancedMesh of
 *    additive glow (halos and a headlight pool on the road), both with a per-instance state
 *    attribute `lstate` (vec3: head 0..1, tail/brake 0 / 0.35 / 1, packed bits reverse 4 + left 1 +
 *    right 2). No real lights. Two draw calls for all traffic.
 *  - Real Sketchbook cars (player, police, pooled parked cars, carjacked cars): the same geometry
 *    as one plain lens Mesh + one glow Mesh per car, with per-car uniforms. The player's car also
 *    drives one pooled SpotLight (medium+ presets, night, headlights on). The SpotLight stays in
 *    the scene with intensity 0 when off, so the light count never changes (no shader recompile).
 *  - Night: realismPerformance.isNight() (set by RealismDayNight), else the sun elevation.
 *  - Player keys (in a car, not UI-blocked): O headlights Auto / On / Off, Comma left signal,
 *    Period right signal, Slash hazards. Signals cancel themselves after the turn.
 *  - Police: in ELS stage 2-3 the headlights wig-wag left / right with the ELS phase.
 *
 * Shared: (world as any).realismCarLights = { mode, setMode(m), signal(car, -1|0|1), hazards(car, on),
 *   stateOf(car), night, stats, layout }.
 * Config: carLights { enabled, playerSpot, spotIntensity, spotDistance, glow, keys }.
 */
import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
export interface LampLayout {
    headX: number;
    headY: number;
    headZ: number;
    headW: number;
    headH: number;
    tailX: number;
    tailY: number;
    tailZ: number;
    tailW: number;
    tailH: number;
    sigX: number;
    halfW: number;
    groundY: number;
    frontZ: number;
    rearZ: number;
}
export interface CarLightSettings {
    enabled: boolean;
    playerSpot: boolean;
    spotIntensity: number;
    spotDistance: number;
    glow: boolean;
    keyHead: string;
    keyLeft: string;
    keyRight: string;
    keyHazard: string;
}
export declare function carLightSettings(ctx: RealismCtx): CarLightSettings;
/** Night as the rest of the game sees it (RealismDayNight -> RealismPerformance). */
export declare function isNightNow(world: any): boolean;
/** Blink phase shared by every indicator (1.4 Hz). */
export declare function blinkOn(clock: number): boolean;
/** Packs the reverse / left / right bits of the state attribute. */
export declare function packBits(reverse: boolean, left: boolean, right: boolean): number;
/**
 * Measures lamp positions on a car body geometry (car space, +z forward): the front / rear face
 * depth is probed at the lamp height and width, so the lenses sit on the paint.
 */
export declare function measureLamps(body: THREE.BufferGeometry, wheels?: THREE.BufferGeometry): LampLayout;
export declare function buildLensGeometry(L: LampLayout): THREE.BufferGeometry;
export declare function buildGlowGeometry(L: LampLayout): THREE.BufferGeometry;
/**
 * Lenses (+ optional glow) for a pool of instanced cars. Write lstate[i*3..] and the matrix of
 * instance i with set(), then commit(count) once per frame.
 */
export declare class InstancedCarLights {
    lens: THREE.InstancedMesh;
    glow: THREE.InstancedMesh;
    state: Float32Array;
    private lensAttr;
    private glowAttr;
    private lensMat;
    private glowMat;
    cap: number;
    constructor(scene: THREE.Object3D, layout: LampLayout, cap: number, name: string, withGlow: boolean);
    set(i: number, m: THREE.Matrix4, head: number, tail: number, bits: number): void;
    /** Returns the draw calls used. */
    commit(count: number, night: boolean, anyLit: boolean): number;
}
interface RealLights {
    car: any;
    lens: THREE.Mesh;
    glow: THREE.Mesh;
    lensMat: THREE.ShaderMaterial;
    glowMat: THREE.ShaderMaterial;
    layout: LampLayout;
    head: number;
    headR: number;
    tail: number;
    brake: boolean;
    reverse: boolean;
    signal: number;
    hazards: boolean;
    sigYaw: number;
    lastYaw: number;
    turned: number;
    prevSpeed: number;
    brakeT: number;
    engine: boolean;
}
export declare class CarLightSystem {
    updateOrder: number;
    settings: CarLightSettings;
    mode: 'auto' | 'on' | 'off';
    stats: {
        [k: string]: number;
    };
    layout: LampLayout;
    night: boolean;
    api: any;
    private ctx;
    private list;
    private clock;
    private spot;
    private spotTarget;
    private tv;
    private tv2;
    private tq;
    private notice;
    private noticeUntil;
    private keyHandler;
    constructor(ctx: RealismCtx);
    /** Player keys. Returns true when handled. */
    onKey(e: any): boolean;
    private player;
    /** The car the player drives (driver seat), or null. */
    playerCar(): any;
    /** Lenses and glow for a real car (once). */
    attach(car: any): RealLights;
    update(timeStep: number, unscaled?: number): void;
    /** The light state machine of one real car. */
    private step;
    private flash;
}
/** Lamp layout of a real car, measured from its own body meshes in car space. */
export declare function measureCarObject(car: any): LampLayout;
export declare function buildCarLights(ctx: RealismCtx): CarLightSystem;
export {};
