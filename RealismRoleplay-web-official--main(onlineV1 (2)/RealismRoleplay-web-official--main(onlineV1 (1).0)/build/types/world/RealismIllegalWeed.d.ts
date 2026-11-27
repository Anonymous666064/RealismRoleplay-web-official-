import * as THREE from 'three';
import { IllegalCore, PocketRoom, Site } from './RealismIllegalCore';
interface Plant {
    p: number;
    on: boolean;
    water: number;
}
interface WeedState {
    tables: number;
    lamps: boolean;
    soil: boolean;
    autoWater: boolean;
    plants: Plant[];
    harvested: number;
}
interface Entrance {
    pid: string;
    building: number;
    site: Site;
    objs: THREE.Object3D[];
    id: string;
}
export declare class WeedGrow {
    api: any;
    room: PocketRoom;
    current: string;
    entrances: Entrance[];
    plantMesh: THREE.InstancedMesh;
    tableMesh: THREE.InstancedMesh;
    private core;
    private max;
    private acc;
    private visAcc;
    private near;
    private tmp;
    private tmpM;
    private tmpQ;
    private tmpS;
    private tmpP;
    private freeBuilding;
    constructor(core: IllegalCore);
    owned(): {
        id: string;
        buildingIndex: number;
        name: string;
    }[];
    private syncEntrances;
    private addEntrance;
    st(pid: string): WeedState;
    private buildRoom;
    enter(pid: string): boolean;
    /** Places table + plant instances for the current warehouse. */
    layout(): void;
    private tableItems;
    private tableAct;
    plant(pid: string, i: number): boolean;
    water(pid: string, i: number): boolean;
    harvest(pid: string, i: number): number;
    private packItems;
    pack(): number;
    buy(pid: string, what: string): boolean;
    private openTerminal;
    private grow;
    update(dt: number): void;
}
export {};
