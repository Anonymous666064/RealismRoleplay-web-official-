import { RealismCtx } from './RealismContext';
export declare const JOB_KEY = "realism.job.v1";
export interface Department {
    id: string;
    name: string;
    title: string;
    rank: string;
    salary: number;
    uniform: number[];
    unitWords: string[];
    civil?: boolean;
    unitPrefix?: string;
    icon?: string;
    desc?: string;
    vehicleRgb?: number[];
    vehicleRgb2?: number[];
    vehicleName?: string;
    pay?: {
        [task: string]: number;
    };
    kinds?: string[];
    weights?: number[];
}
export declare const CIVIL_IDS: string[];
export interface JobState {
    id: string;
    onDuty: boolean;
    unit: string;
    rank?: string;
}
export declare function jobSettings(cfg: any): {
    departments: {
        [id: string]: Department;
    };
    stationRange: number;
    maxHoursPerTick: number;
};
/** Short message in the upper middle of the screen. */
export declare function rrToast(text: string, ms?: number): void;
export declare class RealismJobs {
    updateOrder: number;
    state: JobState;
    departments: {
        [id: string]: Department;
    };
    stationRange: number;
    /** The current department patrol car (not owned), or null. */
    patrol: any;
    paidHours: number;
    dutyHours: number;
    private units;
    private hourAcc;
    private lastHour;
    private acc;
    private ctx;
    private world;
    private tinted;
    private uniformMaps;
    private oldPatrols;
    private maxHours;
    private tmp;
    constructor(ctx: RealismCtx);
    /** The player's character (on foot or in a vehicle), or null (free camera). */
    static playerCharacter(world: any): any;
    private player;
    private playerPos;
    department(): Department | null;
    salaryFor(id: string): number;
    /** In-game minutes until the next salary payment (on duty), else -1. */
    minutesToPay(): number;
    /** Signs up for a job ('civilian' | 'police' | 'sheriff'). Switching goes off duty first. */
    setJob(id: string): boolean;
    goOnDuty(): boolean;
    goOffDuty(): boolean;
    /** Tells the trades (RealismJobsLegal.ts) about duty changes. */
    private notifyLegal;
    /** True for the civilian trades (dot, construction, electrician, community). */
    isCivil(id?: string): boolean;
    private shiftPaid;
    private paidHoursThisShift;
    private makeUnit;
    /** Where you report for duty: the department's scenario player spawn, else in front of the station. */
    stationSpot(dept: string): {
        x: number;
        y: number;
        z: number;
        name: string;
    } | null;
    patrolAvailable(): boolean;
    /** Spawns your department patrol car. Returns a message for the phone. */
    getPatrolVehicle(): {
        ok: boolean;
        message: string;
    };
    private parkedObstacles;
    private occupied;
    private releasePatrol;
    /** Removes old department cars once nobody sits in them. */
    private cleanPatrols;
    /** Teleports the player (on foot) to the department's station. */
    reportToStation(): {
        ok: boolean;
        message: string;
    };
    private applyUniform;
    private restoreUniform;
    /** A copy of the boxman texture with the clothes (grey / white areas) in the uniform colour;
     *  hands (yellow) and the face card (bottom left) keep their colours. Made once per department. */
    private uniformMap;
    update(timeStep: number, unscaled: number): void;
    /** Adds on-duty game time and pays every full hour. */
    addHours(h: number): void;
    private load;
    save(): void;
}
