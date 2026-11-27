import * as THREE from 'three';
import { IllegalCore, PocketRoom, Site } from './RealismIllegalCore';
export declare const CLUB_DEFAULTS: {
    enabled: boolean;
    count: number;
    openHours: number[];
    entryFee: number;
    volume: number;
    dancers: number;
    bpm: number;
    alwaysOpen: boolean;
};
/** Procedural beat. Pure WebAudio, scheduled on the audio clock; start/stop are idempotent. */
export declare class ClubMusic {
    playing: boolean;
    notes: number;
    live: number;
    bpm: number;
    volume: number;
    private ac;
    private out;
    private next;
    private step;
    private noise;
    constructor(bpm: number, volume: number);
    useAudioContext(ac: any): void;
    private ctx;
    start(): boolean;
    stop(): void;
    /** Schedules notes up to 0.3 s ahead. Call every frame while playing. */
    tick(): void;
    private track;
    private env;
    private kick;
    private noiseBuf;
    private hat;
    private clap;
    private bass;
}
export interface Club {
    index: number;
    name: string;
    color: string;
    building: number;
    site: Site;
    room: PocketRoom;
    tileMats: THREE.MeshLambertMaterial[];
    neon: THREE.Mesh;
    closedPlate: THREE.Mesh;
    paidNight: number;
    dancers: THREE.Object3D[];
}
export declare class Clubs {
    api: any;
    cfg: any;
    list: Club[];
    music: ClubMusic;
    lightSwaps: number;
    drinks: number;
    private core;
    private near;
    private beatT;
    private beat;
    private acc;
    private wasOpen;
    private tmp;
    constructor(core: IllegalCore);
    isOpen(): boolean;
    inside(): Club;
    private place;
    private build;
    private openLabel;
    private night;
    private fee;
    enter(i: number, force: boolean): boolean;
    drink(i: number, id: string): boolean;
    private openBar;
    update(dt: number): void;
    describe(): any[];
}
