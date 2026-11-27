import * as THREE from 'three';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { PerformancePreset } from './RealismConfig';
export interface WaterSet {
    meshes: THREE.Mesh[];
    shaderMats: THREE.Material[];
    oceans: IUpdatable[];
    simple: THREE.Material;
}
export declare class RealismPerformance implements IUpdatable {
    updateOrder: number;
    private ctx;
    private water;
    private lights;
    private lightAcc;
    private cullAcc;
    private unloadGeoms;
    private unloaded;
    private liveUsers;
    private oceansOn;
    private camPos;
    stats: {
        lightsUsed: number;
        visibleMeshes: number;
        hiddenMeshes: number;
        unloadedMeshes: number;
    };
    private trafficSignals;
    private frames;
    private fpsAcc;
    private lastNow;
    fps: number;
    drawCalls: number;
    triangles: number;
    private lowFor;
    private highFor;
    private level;
    private base;
    private hud;
    constructor(ctx: RealismCtx, water: WaterSet, trafficSignals: any);
    /** Applies a preset (also used by the panel). */
    apply(p: PerformancePreset): void;
    /** Set by the day / night cycle (RealismDayNight): null = guess from the sun elevation. */
    nightOverride: boolean;
    /** Street lamps / porch lights in the light pool follow this (called by RealismDayNight). */
    setNight(on: boolean): void;
    isNight(): boolean;
    /** The values the player chose (before the FPS governor lowered anything). */
    getBase(): PerformancePreset;
    /** How many steps the FPS governor is below the chosen settings (0 = none). */
    get autoLevel(): number;
    /** Switches to a preset ('auto' | 'low' | 'medium' | 'high' | 'ultra'): preset + realism-config.js overrides, slider changes dropped. */
    setPreset(name: string): PerformancePreset;
    /** Changes some values of the current settings live (view distance, point lights, shadows, ...). */
    setValues(v: {
        [key: string]: any;
    }): void;
    setBrightness(v: number): void;
    setTargetFps(fps: number): void;
    /** Auto-adjust: lower quality step by step below the target FPS. Off restores the chosen settings. */
    setAdaptive(on: boolean): void;
    setShowFps(on: boolean): void;
    private resetGovernor;
    update(timeStep: number, unscaledTimeStep: number): void;
    private cull;
    private unloadedCount;
    /** Collects the geometries under each new cull entry; an entry counts as loaded to begin with. */
    private registerUnloadEntries;
    /** Frees the GPU copy of an entry's geometries. A geometry shared with something still
     *  loaded (one tree model used by many chunks) is kept until its last user goes. The data
     *  stays in the page, so three.js uploads it again by itself the next time it is drawn. */
    private unload;
    private markLoaded;
    private placeLights;
    /** Real frame time from the wall clock (the game's own timestep is clamped / scaled). */
    private measure;
    /** Keeps the game at targetFps: steps quality down after 2 slow seconds, back up after 6 fast ones. */
    private govern;
    private stepped;
    private makeHud;
    private panel;
}
