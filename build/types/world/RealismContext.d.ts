import * as THREE from 'three';
import { World } from './World';
import { MapData } from './RealismMapData';
import { RealismSettings, PerformancePreset } from './RealismConfig';
import { DoorSystem } from './RealismDoors';
export declare const RENDER_CHUNK = 256;
export declare const DETAIL_CHUNK = 128;
export declare function chunkKey(x: number, z: number, size: number): string;
/** Static colliders merged into one compound body per chunk. */
export declare class PhysicsChunks {
    private world;
    private size;
    private bodies;
    private keys;
    private mat;
    shapeCount: number;
    constructor(world: World, size: number);
    private bodyFor;
    /** Box centred at world (x,y,z), half extents, yaw `rot`, optional tilt about the box's local X (ramps). */
    box(x: number, y: number, z: number, hx: number, hy: number, hz: number, rot: number, tiltX?: number): void;
    commit(): void;
}
export interface CullEntry {
    obj: THREE.Object3D;
    x: number;
    z: number;
    r: number;
    cat: string;
}
/** Meshes registered here are hidden by the performance manager beyond their category's distance. */
export declare class CullRegistry {
    entries: CullEntry[];
    add(obj: THREE.Object3D, cat: string, center?: THREE.Vector3, radius?: number): void;
}
export interface RealismCtx {
    world: World;
    data: MapData;
    cfg: RealismSettings;
    preset: PerformancePreset;
    presetName: string;
    mats: {
        [name: string]: THREE.Material;
    };
    phys: PhysicsChunks;
    bphys: PhysicsChunks;
    cull: CullRegistry;
    /** Instancers whose interior items are uploaded around the camera (see AssetInstancer.refresh). */
    dynamic: {
        refresh(x: number, z: number, limit: number): void;
        drawnInterior: number;
    }[];
    /** Lights the light pool may place: lamps, porch lights, room ceiling lights. */
    lightSpots: {
        x: number;
        y: number;
        z: number;
        color: number;
        range: number;
        night: boolean;
    }[];
    /** Openable doors (RealismDoors.ts). Builders add doors while building; finalize() makes the meshes. */
    doors?: DoorSystem;
}
export declare function instMat(ctx: RealismCtx, mat: THREE.Material): THREE.Material;
/** True when this geometry dropped its JavaScript copy after upload (addMesh): the GPU holds the
 *  only copy, so it must never be disposed (three.js could not upload it again). */
export declare function gpuOnly(geom: THREE.BufferGeometry): boolean;
export declare function addMesh(ctx: RealismCtx, geom: THREE.BufferGeometry, mat: THREE.Material, cast: boolean, receive: boolean, cat?: string): THREE.Mesh;
