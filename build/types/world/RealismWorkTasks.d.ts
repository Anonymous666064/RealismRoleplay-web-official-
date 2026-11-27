import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
export declare function esc(s: any): string;
/** Returns world.realismEvents, creating a minimal bus with the C14 API when it is missing. */
export declare function ensureEvents(world: any): any;
export declare function emitEvent(world: any, name: string, data: any): void;
export interface PromptItem {
    key: string;
    label: string;
    hold?: number;
}
/** One owner's prompt. Only calls realismPrompt.set when the items change. */
export declare class JobPrompt {
    owner: string;
    private world;
    private sig;
    private el;
    private barEl;
    private textEl;
    private lastProgress;
    shown: PromptItem[];
    constructor(world: any, owner: string);
    private api;
    set(items: PromptItem[] | null, opts?: {
        priority?: number;
        anchor?: THREE.Vector3;
    }): void;
    /** True when this owner's prompt is the one on screen (or nobody runs C7 prompts). */
    active(): boolean;
    progress(t: number): void;
    /** Re-sends the current items (after A12's prompt system appears late). */
    refresh(): void;
    private fallback;
}
/** Translucent yellow cylinders over task spots. One InstancedMesh with its own material. */
export declare class TaskMarkers {
    mesh: THREE.InstancedMesh;
    count: number;
    private pts;
    private m4;
    private t;
    constructor(ctx: RealismCtx);
    /** Flat list x,y,z,... (at most 12 points). */
    setPoints(p: number[]): void;
    update(dt: number): void;
    private write;
}
export declare class ObjectiveHud {
    private el;
    private text;
    set(t: string): void;
    get value(): string;
}
export declare type Rand = () => number;
export interface Minigame {
    kind: string;
    title: string;
    solved: boolean;
    failed: boolean;
    message: string;
    render(): string;
    act(a: string, arg: string): void;
    key?(code: string): boolean;
}
/** Connect each wire on the left to the terminal of the same colour on the right. */
export declare class WireGame implements Minigame {
    kind: string;
    title: string;
    solved: boolean;
    failed: boolean;
    message: string;
    left: number[];
    right: number[];
    links: number[];
    sel: number;
    sparks: number;
    constructor(title: string, n: number, rnd: Rand);
    act(a: string, arg: string): void;
    render(): string;
}
/** Replace the blown fuses (one Fuse item each from the inventory), then reset the breaker. */
export declare class FuseGame implements Minigame {
    kind: string;
    title: string;
    solved: boolean;
    failed: boolean;
    message: string;
    fuses: boolean[];
    replaced: number;
    private inv;
    constructor(title: string, n: number, blown: number, rnd: Rand, inventory: any);
    get blownCount(): number;
    act(a: string, arg: string): void;
    render(): string;
}
/** Read the code on the scanner and enter it (buttons, arrow keys or 1-4). */
export declare class SequenceGame implements Minigame {
    kind: string;
    title: string;
    solved: boolean;
    failed: boolean;
    message: string;
    code: number[];
    input: number[];
    mistakes: number;
    constructor(title: string, len: number, rnd: Rand);
    act(a: string, arg: string): void;
    key(code: string): boolean;
    render(): string;
}
export declare const ROOM_TYPES: {
    [k: string]: {
        name: string;
        css: string;
        min: number;
    };
};
export interface BlueprintBrief {
    client: string;
    rooms: {
        [type: string]: number;
    };
    maxArea: number;
    text: string;
}
export declare function makeBrief(rnd: Rand): BlueprintBrief;
/** Paint rooms on a grid to match a client brief. Scored when submitted. */
export declare class BlueprintGame implements Minigame {
    kind: string;
    title: string;
    solved: boolean;
    failed: boolean;
    message: string;
    W: number;
    H: number;
    grid: string[];
    tool: string;
    brief: BlueprintBrief;
    score: number;
    checks: {
        label: string;
        ok: boolean;
    }[];
    attempts: number;
    passMark: number;
    constructor(brief: BlueprintBrief, passMark: number);
    act(a: string, arg: string): void;
    /** Connected rooms: [{ type, cells[] }]. */
    rooms(): {
        type: string;
        cells: number[];
    }[];
    private touches;
    /** Scores the plan. Public for tests. */
    evaluate(): {
        score: number;
        checks: {
            label: string;
            ok: boolean;
        }[];
    };
    private submit;
    render(): string;
}
/** Shows one minigame at a time. done(success) runs once when it is solved or cancelled. */
export declare class MinigameOverlay {
    current: Minigame;
    private world;
    private el;
    private done;
    private owner;
    private wasLocked;
    private solvedAt;
    constructor(world: any);
    get isOpen(): boolean;
    open(mg: Minigame, done: (ok: boolean, mg: Minigame) => void): void;
    /** Same as a click on a button with data-act / data-arg. */
    act(a: string, arg: string): void;
    onKey(code: string): boolean;
    cancel(): void;
    private finish;
    private ensure;
    private render;
}
