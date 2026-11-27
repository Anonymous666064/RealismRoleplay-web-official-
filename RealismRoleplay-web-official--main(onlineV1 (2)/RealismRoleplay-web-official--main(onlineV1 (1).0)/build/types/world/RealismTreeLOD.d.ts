/**
 * Tree LOD: only the trees nearest to you use your .glb tree models
 * (realism-config.js -> vegetation.trees / pineTrees). Every other tree keeps the built-in
 * low-poly model, which is what you see in the distance.
 *
 *  - vegetation.nearModels (default 10): how many trees use your model at once.
 *  - vegetation.nearDistance (default 120 m): never farther than this.
 *  - A model file is only downloaded the first time a tree of its kind comes that close,
 *    so pine models load when you reach the hills and forests where the pines are.
 *  - A model that has had no tree near you for 30 s gives its graphics memory back.
 *  - Trunk colliders are the built-in ones for every tree, so nothing changes when a tree swaps.
 */
import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
import { VegModelSet } from './RealismVegetationModels';
import { IUpdatable } from '../interfaces/IUpdatable';
export declare class TreeLOD implements IUpdatable {
    updateOrder: number;
    stats: {
        near: number;
        loadedModels: number;
    };
    private ctx;
    private trees;
    private grid;
    private sets;
    private pools;
    private near;
    private saved;
    private nearCount;
    private nearDist;
    private acc;
    private time;
    private camPos;
    private tmpM;
    private tmpQ;
    private tmpP;
    private tmpS;
    private yAxis;
    constructor(ctx: RealismCtx, sets: {
        [kind: string]: VegModelSet;
    });
    /** True when at least one kind has your models and the near count is above 0. */
    get active(): boolean;
    /** Registers one built-in tree instance. Only trees whose kind has your models are kept. */
    add(x: number, y: number, z: number, r: number, kind: string, mesh: THREE.InstancedMesh, slot: number): void;
    update(timeStep: number, unscaledTimeStep: number): void;
    /** Picks the nearest trees and moves them between the built-in model and yours. */
    refresh(px: number, pz: number): void;
    /** The pool for a tree's model; starts the download the first time a tree of it is near. */
    private pool;
}
