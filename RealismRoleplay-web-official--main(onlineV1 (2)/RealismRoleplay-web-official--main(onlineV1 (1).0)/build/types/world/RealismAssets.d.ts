import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
import { AssetOverride, PlacedModel, BuildingModelRule } from './RealismConfig';
export interface AssetPart {
    geom: THREE.BufferGeometry;
    mat: THREE.Material;
    cast?: boolean;
}
export interface Placement {
    x: number;
    y: number;
    z: number;
    ry: number;
    sx?: number;
    sy?: number;
    sz?: number; /** interior room key (RealismRoomLights), -1 / unset = none */
    room?: number;
}
/** Builds the user transform (offset * rotation * scale) for an override. */
export declare function overrideMatrix(ov: {
    scale?: number | number[];
    rotation?: number[];
    offset?: number[];
}): THREE.Matrix4;
/** Loads (once) and hands over a .glb scene. `failed` (optional) runs if the file can't be loaded. */
export declare function loadGLB(path: string, done: (scene: THREE.Object3D) => void, failed?: () => void): void;
/** On low / medium lighting, swaps your models' PBR (Standard) materials for cheap Lambert ones (same texture and colour). */
export declare function cheapMaterial(ctx: RealismCtx, mat: any): THREE.Material;
/** Flattens a glTF scene into world-baked parts, with the override transform applied. */
export declare function bakeParts(ctx: RealismCtx, scene: THREE.Object3D, extra: THREE.Matrix4, castDefault: boolean): AssetPart[];
export declare class AssetInstancer {
    private ctx;
    private overrides;
    private procs;
    private makers;
    private groups;
    private keys;
    instanceCount: number;
    /** Interior rooms whose lamps are switched off (RealismRoomLights): their lamp-glow instances are drawn collapsed. */
    roomOff: {
        [room: number]: boolean;
    };
    roomOffCount: number;
    constructor(ctx: RealismCtx, overrides: {
        [name: string]: AssetOverride;
    });
    /** Registers how to draw the built-in version of an asset. */
    define(name: string, maker: (variant: number) => AssetPart[]): void;
    isDisabled(name: string): boolean;
    add(name: string, p: Placement, cat: string, variant?: number, cast?: boolean): void;
    private procParts;
    private lastX;
    private lastZ;
    private lastLim;
    drawnInterior: number;
    /** Switches the lamp glow of one interior room on / off (no new meshes: off instances are drawn collapsed). */
    setRoomLight(room: number, on: boolean): void;
    /** Uploads only the interior items within `limit` metres of (x, z). Cheap: called a few times a second. */
    refresh(x: number, z: number, limit: number): void;
    build(): void;
    private instantiate;
}
/** Turns accumulators into asset parts: [[accum, materialName, castShadow?], ...] */
export declare function partsFrom(ctx: RealismCtx, list: any[][]): AssetPart[];
/** Places the config's extraModels. */
export declare function placeExtraModels(ctx: RealismCtx, list: PlacedModel[]): void;
export declare function ruleMatches(rule: BuildingModelRule, b: any, roll: number): boolean;
/** Replaces one generated building with a user model (fit to the footprint or scaled as given). */
export declare function placeBuildingModel(ctx: RealismCtx, rule: BuildingModelRule, b: any): void;
