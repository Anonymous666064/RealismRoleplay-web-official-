import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
export interface WeaponModelInfo {
    muzzle: THREE.Vector3;
    support: number;
    length: number;
    sight?: THREE.Vector3;
}
/** Builds the built-in model for a weapon kind. */
export declare function buildWeaponGeometry(kind: string): {
    geom: THREE.BufferGeometry;
    info: WeaponModelInfo;
};
/** One vertex-coloured material shared by every built-in weapon (plain meshes only). */
export declare function weaponMaterial(ctx: RealismCtx): THREE.Material;
/**
 * Loads your .glb into `target` (a Group in weapon space). The built-in model stays until it loads,
 * and stays for good if it fails. `done` runs after the swap.
 */
export declare function loadWeaponModel(ctx: RealismCtx, ov: any, target: THREE.Group, builtIn: THREE.Object3D, done?: () => void): void;
export declare function flashTexture(): THREE.Texture;
/** Muzzle flash: a star of 3 additive quads (6 triangles), barrel along +Z. */
export declare function buildMuzzleFlash(): THREE.Mesh;
