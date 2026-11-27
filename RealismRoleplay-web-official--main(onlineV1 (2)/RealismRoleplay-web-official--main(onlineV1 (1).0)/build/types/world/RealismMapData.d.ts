export declare const WORLD_SIZE = 2048;
export declare const HALF: number;
export declare const GRID_RES = 512;
export declare const CELL: number;
export declare const VERTS: number;
export declare const SEA_LEVEL = 0;
export interface RoadPoint {
    x: number;
    z: number;
    y: number;
    s: number;
}
export interface Road {
    name: string;
    kind: string;
    width: number;
    pts: RoadPoint[];
    layer: number;
    grade?: number;
}
export interface Building {
    x: number;
    z: number;
    w: number;
    d: number;
    h: number;
    rot: number;
    baseY: number;
    style: string;
    tint: number[];
    roof: string;
    roofTint: number[];
    label?: string;
    collide: boolean;
    groundY?: number;
    kind?: string;
    sub?: string;
    floors?: number;
    enterable?: boolean;
    district?: string;
    condition?: number;
    boarded?: boolean;
    closed?: boolean;
    custom?: string;
    role?: string;
    id?: number;
}
export interface Tree {
    x: number;
    y: number;
    z: number;
    s: number;
    r: number;
    type: number;
}
export interface Lamp {
    x: number;
    y: number;
    z: number;
    r: number;
    broken?: boolean;
}
/** Street furniture: hydrant, bench, trashCan, dumpster, stopSign, wreckedCar, trashBag, tire, fence, mattress, barrier, picnicTable, telescope, flagpole, infoBoard, hoop, weightBench, bleacher */
export interface Prop {
    type: string;
    x: number;
    y: number;
    z: number;
    r: number;
    len?: number;
    color?: number[];
}
/** A road junction. `arms` are unit vectors pointing out of the junction along each road. */
export interface Intersection {
    x: number;
    z: number;
    y: number;
    control: string;
    arms: {
        dx: number;
        dz: number;
        hw: number;
        group: number;
    }[];
    crossHW: number;
    phase: number;
}
export interface Hood {
    name: string;
    x0: number;
    x1: number;
    z0: number;
    z1: number;
}
export interface Spawn {
    type: string;
    x: number;
    y: number;
    z: number;
    rot: number;
    driver?: string;
}
export interface ScenarioDef {
    id: string;
    name: string;
    title: string;
    desc: string;
    isDefault: boolean;
    camAngle: number;
    spawns: Spawn[];
}
export interface Landmark {
    name: string;
    x: number;
    z: number;
    kind: string;
}
export interface WaterBody {
    x: number;
    z: number;
    rx: number;
    rz: number;
    level: number;
}
export interface MapData {
    seed: number;
    heights: Float32Array;
    colors: Float32Array;
    roads: Road[];
    buildings: Building[];
    trees: Tree[];
    lamps: Lamp[];
    props: Prop[];
    intersections: Intersection[];
    hoods: Hood[];
    scenarios: ScenarioDef[];
    landmarks: Landmark[];
    lake: WaterBody;
    respawn: {
        x: number;
        y: number;
        z: number;
    };
    heightAt: (x: number, z: number) => number;
    roadClearance: (x: number, z: number) => number;
    stats: {
        [key: string]: number;
    };
}
export declare function mulberry32(seed: number): () => number;
interface Rect {
    x0: number;
    x1: number;
    z0: number;
    z1: number;
}
export declare const REGIONS: {
    [name: string]: Rect;
};
/** Signed distance-ish to the coastline. > 0 means sea. */
export declare function coastDistance(x: number, z: number): number;
export declare function generateRealismMap(seed?: number): MapData;
export {};
