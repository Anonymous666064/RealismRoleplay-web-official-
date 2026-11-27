import { RealismCtx } from './RealismContext';
import { VehicleTuning } from './RealismVehicleTuning';
import { ELSSystem, LED_COUNT } from './RealismELS';
export interface PoliceSettings {
    enabled: boolean;
    color: number[];
    finish: string;
    lettering: number[];
    unitPrefix: string;
    firstUnit: number;
    pushBar: boolean;
    lightColors: {
        left: number[];
        right: number[];
    };
    sheriff: {
        color: number[];
        twoTone: boolean;
        upper: number[];
        lower: number[];
        split: number;
        unitPrefix: string;
        firstUnit: number;
        pushBar: boolean;
    };
    mdtLaptop: {
        model: string;
        position: number[];
        rotation: number[];
        scale: number | number[];
    };
    els: any;
}
export declare const POLICE_DEFAULTS: PoliceSettings;
export declare function cleanUnit(u: any): string;
export declare class PoliceSystem {
    updateOrder: number;
    api: any;
    settings: PoliceSettings;
    els: ELSSystem;
    cars: any[];
    stats: {
        [k: string]: number;
    };
    private ctx;
    private tuning;
    private gltf;
    private gltfState;
    private pending;
    private atlas;
    private decalMat;
    private housingMat;
    private unitCounter;
    constructor(ctx: RealismCtx, tuning: VehicleTuning);
    private ensureShared;
    private makeAtlas;
    applyLivery(car: any, dept: string, unitIn?: string): void;
    private ensureMdtLaptop;
    private addMdtLaptopFallback;
    private detachMeshes;
    removeLivery(car: any): void;
    private housingCache;
    private housingGeometry;
    private nextUnit;
    /** Station parking spots of a department: the scenario's car spawns. */
    stationSpots(dept: string): {
        x: number;
        y: number;
        z: number;
        rot: number;
    }[];
    private freeSpot;
    spawnUnit(dept: 'police' | 'sheriff', opts?: any): any;
    /** Called for every scenario / config vehicle spawn (RealismVehicles.realismVehicleSpawned). */
    onSpawned(vehicle: any, type: string, vt: any): void;
    update(timeStep: number, unscaled: number): void;
}
export { LED_COUNT };
