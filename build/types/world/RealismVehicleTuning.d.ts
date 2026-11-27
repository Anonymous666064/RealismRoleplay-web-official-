import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
export declare const STOCK_TUNING: {
    rgb: number[];
    finish: string;
    rgb2: number[];
    split: number;
    rideHeight: number;
    suspensionStiffness: number;
    damping: number;
    steeringSpeed: number;
    maxSteer: number;
    enginePower: number;
    topSpeed: number;
    brakeForce: number;
    grip: number;
    livery: string;
    unit: string;
};
export interface PaintInfo {
    mat: any;
    meshes: THREE.Mesh[];
    stockColor: THREE.Color;
    stockShininess: number;
    stockSpecular: THREE.Color;
    stockRoughness: number;
    stockMetalness: number;
    finish: string;
    twoTone: {
        color2: {
            value: THREE.Color;
        };
        split: {
            value: number;
        };
        carMatrix: {
            value: THREE.Matrix4;
        };
    };
}
/** The car the player is driving, or null. Sketchbook keeps the Character as the input receiver while it
 *  drives (it forwards keys to character.controlledObject); a vehicle can also be the receiver directly. */
export declare function playerVehicle(world: any): any;
/** Gives the car ONE paint material of its own (shared by its body and doors, never by another car
 *  or an InstancedMesh) and returns it. Created once per car. */
export declare function ensurePaint(ctx: RealismCtx, car: any): PaintInfo;
/** Two-tone paint: below `split` (car space height) the body uses color2. Shader patch, no extra draw call. */
export declare function setTwoTone(info: PaintInfo, car: any, rgb2: number[], split: number): void;
export declare function patchTwoTone(shader: any, tt: any): void;
export declare class VehicleTuning {
    updateOrder: number;
    api: any;
    private ctx;
    private acc;
    constructor(ctx: RealismCtx);
    isCar(car: any): boolean;
    /** Snapshot of the car's stock values, taken the first time it is tuned. */
    private stock;
    defaults(car?: any): any;
    read(car: any): any;
    apply(car: any, t: any): void;
    /** Back to stock physics, finish and two-tone (the colour is left to whoever spawns the car). */
    reset(car: any): void;
    update(timeStep: number, unscaled: number): void;
    sync(): void;
}
