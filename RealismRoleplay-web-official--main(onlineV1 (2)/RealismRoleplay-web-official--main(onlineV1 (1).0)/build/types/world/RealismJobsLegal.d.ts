import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
import { RealismJobs } from './RealismJobs';
import { RealismInventory } from './RealismInventory';
import { ConstructionSite, SpatialIndex } from './RealismConstruction';
import { JobPrompt, TaskMarkers, ObjectiveHud, MinigameOverlay, Minigame } from './RealismWorkTasks';
export declare const SERVICE_KEY = "realism.communityService.v1";
export interface Target {
    x: number;
    y: number;
    z: number;
    r: number;
    label: string;
    hold: number;
    done: boolean;
    vehicle?: boolean;
    consume?: [string, number];
    check?: () => string;
    mg?: () => Minigame;
    onDone?: (t: Target, mg?: Minigame) => void;
    vis?: number;
}
export interface Task {
    id: number;
    job: string;
    kind: string;
    title: string;
    where: string;
    pay: number;
    phases: Target[][];
    phase: number;
    bonus?: number;
    credit?: number;
    cleanup?: () => void;
    finish?: () => void;
}
interface Spot {
    x: number;
    y: number;
    z: number;
    name: string;
    bi: number;
}
export interface LegalSettings {
    dispatchDelay: number;
    minDist: number;
    maxDist: number;
    acUnits: number;
    panels: number;
    blueprintPass: number;
}
export declare function legalSettings(cfg: any): LegalSettings;
export declare class RealismJobsLegal {
    updateOrder: number;
    settings: LegalSettings;
    task: Task;
    site: ConstructionSite;
    index: SpatialIndex;
    inventory: RealismInventory;
    prompt: JobPrompt;
    markers: TaskMarkers;
    hud: ObjectiveHud;
    minigames: MinigameOverlay;
    workVehicle: any;
    supplyTruck: any;
    brokenCar: any;
    acSpots: Spot[];
    panelSpots: Spot[];
    officeSpots: Spot[];
    serviceHours: number;
    serviceDone: number;
    stats: {
        tasks: number;
        paid: number;
        propsMs: number;
        acUnits: number;
        panels: number;
    };
    /** The interaction in range this frame (tests read it). */
    cur: {
        label: string;
        hold: number;
        blocked: string;
        run: () => void;
        t?: Target;
    };
    holdTime: number;
    eHeld: boolean;
    lastPay: number;
    dispatchIn: number;
    private ctx;
    private world;
    private jobs;
    private visuals;
    private oldVehicles;
    private taskSeq;
    private rnd;
    private carState;
    private carGltf;
    private waitingCars;
    private slowAcc;
    private wasOnDuty;
    private lastJob;
    private serviceListeners;
    private blipIds;
    private tmp;
    private markerSig;
    private gpsLabel;
    private hadPromptApi;
    private hudAcc;
    private scanAcc;
    private rescan;
    constructor(ctx: RealismCtx, jobs: RealismJobs);
    private dept;
    onCivilDuty(): boolean;
    private player;
    private playerPos;
    private inVehicle;
    private gps;
    private night;
    private pick;
    addService(h: number): void;
    private loadService;
    private saveService;
    /** Called by RealismJobs on duty changes. */
    onDutyChange(on: boolean): void;
    private endShift;
    /** Tops up the trade's supplies to its kit. Returns how many items were added. */
    topUpKit(job: string): number;
    private kitLow;
    vehicleAvailable(): boolean;
    /** Spawns a stock sedan (when car.glb is loaded) and hands it to cb. */
    private spawnCar;
    private paint;
    private roadSpotNear;
    /** 'Get work vehicle' (via RealismJobs.getPatrolVehicle). */
    getWorkVehicle(): {
        ok: boolean;
        message: string;
    };
    /** 'Go to depot': the GPS marks where tasks start (the site for construction). */
    goToDepot(): {
        ok: boolean;
        message: string;
    };
    /** Nearest warehouse (deliveries, depot). */
    depot(near?: THREE.Vector3, minDist?: number): {
        x: number;
        y: number;
        z: number;
        name: string;
    } | null;
    private occupied;
    private cleanVehicles;
    private buildElectricProps;
    private chooseKind;
    /** Gives the next task now. kind forces a task kind (tests, phone). Returns the task or null. */
    dispatch(kind?: string): Task;
    private newTask;
    private tgt;
    /** A road lane spot at a random distance from p. */
    private taskRoadSpot;
    private nearestOf;
    private needItem;
    private makeTask;
    /** A raised hood on a broken-down car (child mesh, the car's own geometry stays). */
    private hoodUp;
    /** Stops the current task. paid: completion path (no cleanup of rewards). */
    cancelTask(paid: boolean): void;
    /** 'Skip task' in the Jobs app. */
    skipTask(): {
        ok: boolean;
        message: string;
    };
    private completeTask;
    firstOpen(): Target;
    private updateGuidance;
    private clearGuidance;
    private siteBlip;
    private bindInput;
    /** Public for tests: E pressed. Runs a press action when our prompt is the active one. */
    keyDown(code: string): boolean;
    keyUp(code: string): void;
    update(timeStep: number, unscaled: number): void;
    private updateHud;
    /** The interaction in range now: the nearest open task spot, else restocking at the work vehicle. */
    private findInteraction;
    /** Runs a target: minigame first when it has one, else finishes it. */
    private doTarget;
    private finishTarget;
}
/** Builds the trades after RealismJobs (buildEconomy). Sets world.realismJobsLegal, realismInventory, realismCommunityService. */
export declare function buildLegalJobs(ctx: RealismCtx): RealismJobsLegal;
export {};
