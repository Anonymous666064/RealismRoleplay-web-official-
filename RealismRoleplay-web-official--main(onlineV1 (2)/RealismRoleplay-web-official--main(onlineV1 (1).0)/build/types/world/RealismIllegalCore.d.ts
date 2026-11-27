import * as THREE from 'three';
import * as CANNON from 'cannon';
import { RealismCtx } from './RealismContext';
import { GeoAccum, Frame } from './RealismGeometry';
export declare const ILLEGAL_KEY = "realism.illegal.v1";
export declare const OWNER = "illegal";
export interface PromptItem {
    key: string;
    label: string;
    hold?: number;
}
export interface Interactable {
    id: string;
    x: number;
    y: number;
    z: number;
    r: number;
    mode?: string;
    items(): PromptItem[] | null;
    act(key: string): void;
    blip?: string;
}
export interface ItemDef {
    name: string;
    icon?: string;
    legal?: boolean;
    value?: number;
}
/** Fictional, generic items (C13 define()). */
export declare const ITEMS: {
    [id: string]: ItemDef;
};
export interface CarMeta {
    stolen?: boolean;
    vin?: string;
    vinScratched?: boolean;
    hot?: boolean;
    resprayed?: boolean;
}
export interface MenuRow {
    label: string;
    detail?: string;
    right?: string;
    disabled?: boolean;
    action?: () => any;
}
export interface MenuSpec {
    title: string;
    subtitle?: string;
    rows: () => MenuRow[];
    owner?: string;
    onClose?: () => void;
}
export interface TimingSpec {
    owner: string;
    title: string;
    stages: string[];
    zone: number;
    speed: number;
    maxMisses: number;
    stageTimeout: number;
    duration?: number;
    onFinish: (r: {
        success: boolean;
        hits: number;
        misses: number;
    }) => void;
}
export declare function money(n: number): string;
export declare function esc(s: string): string;
/** Merges config over defaults (one level of nested objects). */
export declare function mergeCfg(def: any, user: any): any;
export declare const ILLEGAL_DEFAULTS: {
    enabled: boolean;
    revealAll: boolean;
    discoverRange: number;
    heat: {
        hud: boolean;
        decayPerMinute: number;
        theft: number;
        failedTheft: number;
        sale: number;
        carSale: number;
        max: number;
    };
    hotwire: {
        enabled: boolean;
        stages: number;
        maxMisses: number;
        stageTimeout: number;
        zone: number[];
        speed: number[];
        alarmOnFail: boolean;
    };
    respray: {
        price: number;
        colors: any;
    };
    vin: {
        holdSeconds: number;
    };
    fence: {
        share: number;
        hotPolicy: string;
        hotFactor: number;
        vinBonus: number;
        noVinFactor: number;
        refusePolice: boolean;
        minCondition: number;
    };
    prices: {
        supplies: number;
        lab_kit: number;
        starter_pot: number;
        growTable: number;
        lampUpgrade: number;
        soilUpgrade: number;
        waterUpgrade: number;
        dealer: {
            lean_cup: number;
            weed_bag: number;
        };
        bulk: {
            weed_bag: number;
        };
        cartel: {
            coke_brick: number;
        };
    };
    dealerMaxPerHour: number;
    bulkMin: number;
    cartelHours: number[];
    saleCrimeChance: number;
    lean: {
        suppliesPerBatch: number;
        seconds: number;
        baseCups: number;
    };
    coke: {
        kitsPerBatch: number;
        mixSeconds: number;
        pressHold: number;
        packSeconds: number;
        bricksPerBatch: number;
    };
    weed: {
        growHours: number;
        waterHours: number;
        baseYield: number;
        maxTables: number;
        startTables: number;
        freeWithoutProperties: boolean;
    };
};
export declare class IllegalCore {
    updateOrder: number;
    ctx: RealismCtx;
    w: any;
    cfg: any;
    state: any;
    spots: Interactable[];
    current: Interactable;
    items: PromptItem[];
    hint: string;
    lastToast: string;
    events: {
        name: string;
        data: any;
    }[];
    stats: {
        spots: number;
        rooms: number;
        roomsVisible: number;
        markers: number;
        updateMs: number;
        maxUpdateMs: number;
        drawCalls: number;
    };
    rooms: PocketRoom[];
    insideRoom: PocketRoom;
    blips: {
        [id: string]: {
            x: number;
            z: number;
            icon: string;
            color?: string;
            label?: string;
            shortRange?: boolean;
            always?: boolean;
            added?: boolean;
        };
    };
    guides: any[];
    updaters: {
        update: (dt: number) => void;
    }[];
    menuOpen: boolean;
    timing: TimingGame;
    dh: number;
    random: () => number;
    private lastHour;
    private promptSig;
    private holdKey;
    private holdT;
    private holdItem;
    private scanAcc;
    private saveAcc;
    private dirty;
    private lazyAcc;
    private markers;
    private markerAcc;
    private markerMats;
    private markerGeo;
    private hintEl;
    private toastEl;
    private toastT;
    private heatEl;
    private heatShown;
    private menuEl;
    private menuSpec;
    private locks;
    private tmpV;
    private figures;
    private boxman;
    private boxmanState;
    private pendingFigures;
    private guideRegistered;
    private invMigrated;
    private roomSlots;
    constructor(ctx: RealismCtx);
    private load;
    markDirty(): void;
    save(): void;
    player(): any;
    /** The car (any rayCastVehicle) the player is driving, or null. */
    drivenCar(): any;
    onFoot(): boolean;
    playerPos(out: THREE.Vector3): boolean;
    gameHour(): number;
    isNight(from: number, to: number): boolean;
    blocked(): boolean;
    add(s: Interactable): Interactable;
    remove(id: string): void;
    addUpdater(u: {
        update: (dt: number) => void;
    }): void;
    eco(): any;
    cash(): number;
    /** Pays in cash (method 'cash'); free without an economy. */
    payCash(amount: number, desc: string, merchant: string): boolean;
    /** Pays by card, falling back to cash (legal businesses: club entry, drinks, grow upgrades). */
    pay(amount: number, desc: string, merchant: string): boolean;
    earnCash(amount: number, desc: string, source: string): void;
    private inv;
    usingRealInventory(): boolean;
    count(id: string): number;
    give(id: string, qty: number): void;
    take(id: string, qty: number): boolean;
    emit(name: string, data: any): void;
    crime(kind: string, pos?: {
        x: number;
        y: number;
        z: number;
    }, heat?: number): void;
    addHeat(n: number): void;
    get heat(): number;
    /** Stolen-car meta: the owned record's own fields (A13 sets stolen / vin / hot), backed by our save. */
    carMeta(rec: any): CarMeta;
    setCarMeta(rec: any, patch: CarMeta): void;
    /** Drops meta of cars that are no longer owned. */
    pruneCars(): void;
    recordFor(car: any): any;
    /** Dealer value of a vehicle type (dealership prices; 18000 for the sedan, 35000 for config types). */
    typeValue(type: string): number;
    carType(car: any): string;
    grabMouse(owner: string): void;
    releaseMouse(owner: string): void;
    /** Opens a list menu (mouse or number keys). rows() is called again after every action. */
    menu(spec: MenuSpec): void;
    closeMenu(): void;
    /** Test / keyboard access: rows of the open menu. */
    menuRows(): MenuRow[];
    menuTitle(): string;
    menuPick(i: number): boolean;
    private renderMenu;
    /** Starts a timing minigame (one at a time). */
    startTiming(spec: TimingSpec): TimingGame;
    toast(msg: string, seconds?: number): void;
    private updateHud;
    private setHint;
    private setPrompt;
    /** True when our prompt is the one shown (C7), or there is no prompt system. */
    promptActive(): boolean;
    private scan;
    /** Re-evaluates prompts right away (after an action changed what is offered). */
    refresh(): void;
    private bindInput;
    /** Public for tests: e = { code, repeat?, target?, preventDefault? }. */
    onKey(e: any, down: boolean): boolean;
    private fire;
    private progress;
    /** Test helper: presses (and for hold items holds) a key on the current prompt. Returns false if not offered. */
    press(key: string, holdSeconds?: number): boolean;
    addBlip(id: string, b: {
        x: number;
        z: number;
        icon: string;
        color?: string;
        label?: string;
        shortRange?: boolean;
        always?: boolean;
    }): void;
    reveal(id: string): void;
    revealAll(): void;
    isFound(id: string): boolean;
    private syncBlips;
    /** Guide for the A15 guide system; registered as soon as realismGuides exists. */
    addGuide(g: any): void;
    private syncGuides;
    get guidesRegistered(): number;
    /** A ground ring + soft light column + floating chevron. Visible within `range` metres. */
    marker(x: number, y: number, z: number, color: string, opts?: {
        radius?: number;
        range?: number;
        column?: boolean;
    }): THREE.Object3D;
    private updateMarkers;
    private loadBoxman;
    /** A standing person (pooled boxman clone, idle animation) at a spot, facing `rot`. */
    figure(x: number, y: number, z: number, rot: number, tint: number[], pose?: string, parent?: THREE.Object3D): THREE.Group;
    private fillFigure;
    private figMats;
    private figureMat;
    private sMat;
    private standInMat;
    private updateFigures;
    get figureCount(): number;
    /** Allocates a closed room above the sea south of the coast. */
    room(id: string, w: number, d: number, h: number, colors: {
        floor: number[];
        wall: number[];
        ceil: number[];
    }): PocketRoom;
    roomById(id: string): PocketRoom;
    /** Teleports the player (on foot) to a world point, facing yaw `rot` (0 = +Z). */
    teleport(x: number, y: number, z: number, rot: number): boolean;
    update(timeStep: number, unscaled: number): void;
}
export declare class PocketRoom {
    id: string;
    x: number;
    y: number;
    z: number;
    w: number;
    d: number;
    h: number;
    group: THREE.Group;
    acc: GeoAccum;
    inside: boolean;
    body: CANNON.Body;
    returnTo: {
        x: number;
        y: number;
        z: number;
        rot: number;
    };
    onEnter: () => void;
    onExit: () => void;
    frame: Frame;
    private core;
    private furniture;
    private mat;
    constructor(core: IllegalCore, id: string, x: number, y: number, z: number, w: number, d: number, h: number, colors: {
        floor: number[];
        wall: number[];
        ceil: number[];
    });
    /** World point of local (lx, ly, lz), room centre floor = (0, 0, 0). */
    p(lx: number, ly: number, lz: number): THREE.Vector3;
    /** Static furniture box (local coords, centre + size); collide adds a collider box. */
    box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, c: number[], collide?: boolean): void;
    finish(): void;
    /** A label plate (canvas texture) on a wall or above a station. */
    label(text: string, lx: number, ly: number, lz: number, rotY: number, wM: number, color?: string): THREE.Mesh;
    enter(returnTo: {
        x: number;
        y: number;
        z: number;
        rot: number;
    }, lx: number, lz: number, rot: number): boolean;
    /** Back to the entrance (teleport = false: just hide, the player is already elsewhere). */
    leave(teleport?: boolean): void;
    /** Respawned / teleported away by something else: tidy up. */
    watch(): void;
}
export declare class TimingGame {
    spec: TimingSpec;
    stage: number;
    hits: number;
    misses: number;
    needle: number;
    zoneAt: number;
    elapsed: number;
    done: boolean;
    private dir;
    private stageT;
    private core;
    private el;
    private needleEl;
    private zoneEl;
    private textEl;
    private progEl;
    private flash;
    private finished;
    constructor(core: IllegalCore, spec: TimingSpec);
    private newZone;
    get inZone(): boolean;
    /** Space / E / click. */
    press(): void;
    private miss;
    private nextStage;
    update(dt: number): void;
    cancel(): void;
    private finish;
    private build;
    private render;
}
export declare function now(): number;
export declare function isStolenOrigin(rec: any): boolean;
/** 17-character fictional VIN, stable per record id. */
export declare function makeVin(seed: string): string;
export declare function canvas(w: number, h: number): {
    cv: any;
    g: any;
};
/** Unlit text plate (signs, station names). */
export declare function textPlane(text: string, widthM: number, color: string, bg?: string, glow?: boolean): THREE.Mesh;
/** Ground height + free-spot test against buildings / roads (for contacts and markers). */
export declare function spotIsFree(ctx: RealismCtx, x: number, z: number, clearance: number, ignore?: number): boolean;
export interface Site {
    x: number;
    y: number;
    z: number;
    rot: number;
    building: number;
    face: number;
}
/** Places reserved by our builders (so two sites never overlap). */
export declare const RESERVED: {
    x: number;
    z: number;
    r: number;
    what: string;
}[];
export declare function reserve(x: number, z: number, r: number, what: string): void;
export declare function reservedClash(x: number, z: number, r: number): boolean;
/** Distance (xz) from a point to the nearest exterior door segment. */
export declare function doorDistance(ctx: RealismCtx, x: number, z: number): number;
/**
 * Finds a free spot of size width x depth against one face of building `bi` (outside it), facing away
 * from the wall: no other building / prop inside, not deep in a road, clear of doors and of RESERVED,
 * ground fairly flat. road: 'near' prefers spots by a road (bays you drive into), 'away' prefers spots
 * away from roads (hidden entrances). faces: which faces to try (0 front, 1 right, 2 back, 3 left).
 */
export declare function besideBuilding(ctx: RealismCtx, bi: number, width: number, depth: number, opts?: {
    road?: string;
    faces?: number[];
    doorGap?: number;
    gap?: number;
}): Site | null;
/** A painted bay on the ground (decal following the terrain) with a title. rot = yaw of its +Z (towards the street). */
export declare function bayDecal(core: IllegalCore, x: number, z: number, rot: number, w: number, d: number, title: string, sub: string, color: string): THREE.Mesh;
/** World-space rectangle test for a car inside a bay (centre x,z, yaw rot, size w x d). */
export declare function inRect(px: number, pz: number, x: number, z: number, rot: number, w: number, d: number, margin?: number): boolean;
/** Shows objects only within `range` metres of the player (cheap distance check, call ~2x per second). */
export declare class NearSet {
    items: {
        o: THREE.Object3D;
        x: number;
        z: number;
        r: number;
    }[];
    add(o: THREE.Object3D, x: number, z: number, r: number): void;
    update(p: THREE.Vector3): void;
}
/** Instanced-safe material copy (three r113: one program per material). */
export declare function instMatSafe(ctx: RealismCtx, mat: THREE.Material): THREE.Material;
