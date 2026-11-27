import * as THREE from 'three';
import { IUpdatable } from '../interfaces/IUpdatable';
export interface PromptItem {
    key: string;
    label: string;
    hold?: number;
}
export declare class PromptSystem implements IUpdatable {
    updateOrder: number;
    stats: {
        owners: number;
        shown: number;
        domWrites: number;
    };
    private world;
    private owners;
    private list;
    private order;
    private seq;
    private dirty;
    private hidden;
    private root;
    private rows;
    private shownSig;
    private keysUsed;
    private pp;
    private enabled;
    constructor(world: any, enabled?: boolean);
    set(name: string, items: PromptItem[] | null, opts?: {
        priority?: number;
        anchor?: THREE.Vector3;
    }): void;
    isActive(name: string): boolean;
    progress(name: string, t: number): void;
    /** Owner names currently on screen (tests / debugging). */
    shownOwners(): string[];
    private computeHidden;
    /** Decides which owners are on screen (cheap; runs when something changed). */
    private resolve;
    private domDirty;
    private havePos;
    private cmp;
    private playerPos;
    update(timeStep: number, unscaledTimeStep: number): void;
    private render;
    private writeRow;
    private hideRow;
    private ensureDom;
}
/** Creates the prompt system once (or returns the existing one). */
export declare function ensurePrompts(world: any, enabled?: boolean): PromptSystem;
