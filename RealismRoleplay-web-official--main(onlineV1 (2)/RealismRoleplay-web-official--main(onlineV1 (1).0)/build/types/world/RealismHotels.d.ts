import * as THREE from 'three';
import * as CANNON from 'cannon';
import { Building, MapData } from './RealismMapData';
import { RealismCtx } from './RealismContext';
import { Frame } from './RealismGeometry';
import { IUpdatable } from '../interfaces/IUpdatable';
export interface HotelDef {
    name: string;
    floors: number;
    near?: number[];
    airport?: boolean;
    pal: number;
}
export declare const HOTEL_DEFS: HotelDef[];
interface Palette {
    facade: number[];
    podium: number[];
    trim: number[];
    accent: number[];
    hallCarpet: number[];
    roomCarpet: number[];
    hallWall: number[];
    roomWall: number[];
    bedding: number[];
    throwC: number[];
    headboard: number[];
    wood: number[];
    sofa: number[];
    sign: string[];
}
/**
 * Picks the hotel sites and marks them custom = 'hotel'. Downtown / beach hotels
 * replace an existing office, tower or shop lot (footprint only shrinks, so nothing
 * around them moves); the airport hotel claims a free lot facing a landside road.
 * Safe to call twice (returns the hotels already assigned).
 */
export declare function assignHotels(data: MapData): Building[];
interface Shape {
    x: number;
    y: number;
    z: number;
    hx: number;
    hy: number;
    hz: number;
    rot: number;
}
interface Part {
    geom: THREE.BufferGeometry;
    mat: string;
}
export interface DoorSpec {
    kind: string;
    x: number;
    y: number;
    z: number;
    rot: number;
    width: number;
    height: number;
    thickness?: number;
    color?: number;
    locked?: boolean;
    openAngle?: number;
    group?: string;
}
export interface Hotel {
    b: Building;
    name: string;
    slug: string;
    N: number;
    pal: Palette;
    f: Frame;
    w: number;
    d: number;
    ix0: number;
    ix1: number;
    iz0: number;
    iz1: number;
    sx1: number;
    rx0: number;
    RW: number;
    n: number;
    ex: number;
    xe: number;
    Y: number[];
    floorY: number;
    top: number;
    zA: number;
    zB: number;
    roomsX: number[];
    kitParts: Part[];
    wallParts: Part[];
    kitMeshes: THREE.InstancedMesh[];
    wallMeshes: THREE.InstancedMesh[];
    floorShapes: Shape[];
    bodies: {
        body: CANNON.Body;
        floor: number;
        added: boolean;
    }[];
    key: string;
    rooms: number;
    /** Rooms (by room number) whose lamps are switched off (RealismRoomLights). */
    lightsOff?: {
        [num: number]: boolean;
    };
}
/** Stair flight as built (world-space checks in tests / debugging). */
export interface FlightLog {
    hotel: string;
    level: number;
    lane: string;
    f: Frame;
    x: number;
    zStart: number;
    yStart: number;
    zEnd: number;
    yEnd: number;
}
export declare class HotelBuilder {
    private ctx;
    private S;
    private signAcc;
    private doorQueue;
    hotels: Hotel[];
    flights: FlightLog[];
    runtime: HotelRuntime;
    stats: {
        hotels: number;
        floors: number;
        rooms: number;
        doors: number;
        staticTris: number;
        staticTrisInterior: number;
        kitTrisPerRoom: number;
        floorWallTris: number;
        staticShapes: number;
        lazyShapesPerFloor: number;
        lightSpots: number;
        drawCallsOutside: number;
        drawCallsInside: number;
        gpuBytes: number;
    };
    constructor(ctx: RealismCtx);
    build(): void;
    private ensureMaterials;
    private X;
    private I;
    private layout;
    /** Faces of a wall plane in frame `fr` at local z, spanning local x [x0,x1] and world y [y0,y1], minus openings (local x / world y). */
    private band;
    /** Reveal faces of an opening through a wall between local z0 and z1. */
    private jambs;
    /** Horizontal rectangle at height y in frame fr. */
    private flat;
    /** Static collider from a frame-local centre. */
    private pbox;
    /** Collider by local min / max corners (axis aligned in frame fr). */
    private pminmax;
    /** Flat sign panel with the hotel name (facing local +z when facing = 1). */
    private sign;
    /** Digits / 'L' from the shared atlas, centred at (cx, cy) on local z, facing +z. */
    private text;
    private addDoor;
    private exterior;
    /**
     * Walkable ramp collider whose TOP face runs exactly from (zStart, yStart) to (zEnd, yEnd)
     * in frame fr (centre x, half width hw). tiltX > 0 lowers the box's local +Z end, so a
     * flight climbing towards -z (low end at +z) gets a positive tilt; one climbing towards +z
     * a negative tilt. Verified numerically by raycasting the committed bodies (see test notes).
     */
    private ramp;
    private slabs;
    private core;
    /** One stair flight: visual steps, soffit, handrail and its ramp collider. */
    private flight;
    private lobby;
    private guestStatics;
    /** Room numbers run along the front side, then back along the back side. */
    private roomIndex;
    private roomKit;
    /** Interaction anchors of every guest room (RealismInteractions): bed, lamps, toilet, sink, shower, desk, chairs, switch. */
    private roomAnchors;
    /** Places the room-kit colliders of every room on one floor (floor-relative y). */
    private roomShapes;
    private floorWalls;
    private parts;
    private bed;
    private nightstand;
    private chair;
    private armchair;
    private sofa;
    private coffeeTable;
    private rug;
    private plant;
    private luggageCart;
    private flush;
    private makeInstanced;
}
export declare class HotelRuntime implements IUpdatable {
    updateOrder: number;
    private ctx;
    private hotels;
    private doors;
    private doorsDone;
    private acc;
    private m;
    private q;
    private v;
    private s;
    private yAxis;
    private cam;
    private bodyMat;
    /** Debug / test hook: extra points (world positions) treated like characters. */
    extraPoints: {
        x: number;
        y: number;
        z: number;
    }[];
    activeFloors: {
        [hotel: string]: number[];
    };
    constructor(ctx: RealismCtx, hotels: Hotel[], doors: DoorSpec[]);
    /** Registers the door queue with the door system once it exists (it may be created after the hotels). */
    flushDoors(): void;
    update(timestep: number, unscaledTimeStep: number): void;
    /** One activation pass (also callable directly). */
    tick(): void;
    private wanted;
    private apply;
    private makeBody;
}
export {};
