import * as THREE from 'three';
import { RealismCtx, PhysicsChunks } from './RealismContext';
import { AssetPart } from './RealismAssets';
import { VegetationSettings } from './RealismConfig';
export declare type VegKind = 'tree' | 'pineTree' | 'bush' | 'hedge';
/** Built-in variants are encoded as builtin + VARIANT_STRIDE * yourVariant in the instancers. */
export declare const VARIANT_STRIDE = 10;
export interface VegEntry {
    model: string;
    scale: number[];
    rotation: number[];
    offset: number[];
    collider: boolean;
    castShadow: boolean;
    weight: number;
}
/** A loaded, measured and merged model, ready for instancing. Sizes are in metres at instance scale 1. */
export interface PreparedModel {
    parts: AssetPart[];
    size: THREE.Vector3;
    radius: number;
    /** Trunk box (trees): centre offset x / z, half width, height. */
    trunk: {
        x: number;
        z: number;
        hw: number;
        h: number;
    };
    triangles: number;
}
/** realism-config.js -> vegetation, made safe (missing section, `vegetation: false`, bad values). */
export declare function vegSettings(ctx: RealismCtx): VegetationSettings;
/** Position hash in [0, 1): same spot + salt = same number on every load. */
export declare function hash01(x: number, z: number, salt: number): number;
export declare class VegModelSet {
    kind: VegKind;
    entries: VegEntry[];
    private cum;
    private ctx;
    private prepared;
    constructor(ctx: RealismCtx, kind: VegKind);
    /** True when you gave at least one model for this list (the old city.props override is then ignored). */
    get custom(): boolean;
    /** Variant index for something placed at (x, z). */
    pick(x: number, z: number, salt: number): number;
    /** Loads variant i (once), prepares it, then calls ready; failed runs if it can't be loaded or is empty. */
    load(i: number, ready: (m: PreparedModel, e: VegEntry) => void, failed: () => void): void;
}
export declare function prepareModel(ctx: RealismCtx, scene: THREE.Object3D, e: VegEntry, kind: VegKind): PreparedModel;
/** Collects instance matrices per map chunk, then makes one InstancedMesh per chunk and material. */
export declare class ChunkInstances {
    private chunks;
    private keys;
    private size;
    count: number;
    constructor(chunkSize: number);
    add(x: number, y: number, z: number, ry: number, sx: number, sy: number, sz: number): void;
    /** Adds the meshes to the world and the cull registry. Returns how many meshes (draw calls when all visible). */
    emit(ctx: RealismCtx, m: PreparedModel, cat: string, name: string): number;
}
/** Static colliders added after the world was built (a model arrived later): one compound body per 128 m chunk. */
export declare function lateColliders(ctx: RealismCtx, fill: (phys: PhysicsChunks) => void): number;
/** Running totals shown in the console / build summary. */
export declare const vegModelStats: {
    meshes: number;
    colliders: number;
    loaded: string[];
    failed: string[];
};
