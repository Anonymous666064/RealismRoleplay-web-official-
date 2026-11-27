import * as THREE from 'three';
import * as CANNON from 'cannon';
import { RealismCtx } from './RealismContext';
import { Car } from '../vehicles/Car';
import { InstancedCarLights } from './RealismCarLights';
import { NPCSettings } from './RealismNPCs';
export interface NPCHome {
    building: number;
    doorX: number;
    doorZ: number;
    rot: number;
}
export interface OwnedCar {
    id: string;
    origin: string;
    type: string;
    model: string;
    color: number;
    rgb: number[];
    x: number;
    y: number;
    z: number;
    qx: number;
    qy: number;
    qz: number;
    qw: number;
    stolenAt: number;
    name: string;
    tuning?: any;
    stored?: boolean;
    price?: number;
    trim?: string;
    boughtAt?: number;
    stolen?: boolean;
    vin?: string;
    vinScratched?: boolean;
    hot?: boolean;
}
interface Spot {
    id: string;
    owned: boolean;
    rec: OwnedCar;
    color: number;
    pos: THREE.Vector3;
    quat: THREE.Quaternion;
    car: Car;
    coll: CANNON.Body;
    marker: THREE.Object3D;
    lastSave: number;
    home: number;
    kind: string;
    cache: any;
    theft?: boolean;
}
/** Paints a vehicle's body material ('Car' / 'Heli' / 'Airplane'). */
export declare function paintVehicle(car: any, rgb: number[]): void;
export declare class NPCVehicles {
    spots: Spot[];
    owned: OwnedCar[];
    stats: {
        [k: string]: number;
    };
    api: any;
    private ctx;
    private npcs;
    private settings;
    private gltf;
    private ready;
    private bodyGeom;
    private wheelGeom;
    private bodyMeshes;
    private wheelMesh;
    lights: InstancedCarLights;
    private promptOn;
    private boxes;
    private restY;
    private freeCars;
    private realCount;
    private acc;
    private drawAcc;
    private lastDrawPos;
    private collPool;
    private collMat;
    private listeners;
    private hud;
    private hudText;
    private msg;
    private msgUntil;
    private tmpM;
    private one;
    constructor(ctx: RealismCtx, npcs: any, homes: NPCHome[], settings: NPCSettings);
    private placeParked;
    private ownedSpot;
    private prepare;
    /** Re-seats the never-spawned NPC cars on the measured rest height. */
    private adjustRest;
    private newCar;
    tick(dt: number): void;
    private manage;
    private spawn;
    private despawn;
    /** Copies a spawned car's pose back into its spot (and the owned record). */
    private capture;
    private steal;
    private hasHotwire;
    /**
     * C12: the player sits in a car that isn't theirs. With (world as any).realismHotwire (A17)
     * the engine stays off until its minigame calls done(true); done(false) sounds the alarm and
     * puts the player out. Without it the theft succeeds at once (onDone(true)).
     */
    beginTheft(car: any, onDone: (ok: boolean) => void): void;
    /** C12 fields on a stolen car's record, saved, and the 'carStolen' event (C14). */
    markStolen(rec: OwnedCar, car: any): void;
    /** Makes a spot (NPC parked car) owned. */
    private claimSpot;
    private countsChanged;
    private inUse;
    private applyTuning;
    private models;
    private modelFailed;
    /** Base class + model path of a type: null if unknown. */
    private typeInfo;
    requestModel(type: string): boolean;
    private createSpecial;
    private spawnSpecial;
    /** Puts a live vehicle on the spot's pose (body + mesh), at rest. */
    private place;
    /** Rest height above the road surface for a type. */
    private restFor;
    private clearanceFor;
    lastError: string;
    private spotOf;
    private recOf;
    claim(car: any, info: {
        origin: string;
        type?: string;
        rgb?: number[];
        stolen?: boolean;
    }): OwnedCar | null;
    add(info: {
        type: string;
        rgb?: number[];
        name?: string;
        tuning?: any;
        price?: number;
        trim?: string;
    }): OwnedCar | null;
    /** Spawns (or moves) an owned car onto the nearest free road lane next to `near` / the player. */
    spawnOwned(id: string, near?: THREE.Vector3): any;
    updateRecord(id: string, patch: any): void;
    recordFor(car: any): OwnedCar | null;
    private draw;
    private addCollider;
    private removeCollider;
    private load;
    save(): void;
    private emit;
    private makeApi;
    private ensureHud;
    private showHint;
    private flash;
}
export {};
