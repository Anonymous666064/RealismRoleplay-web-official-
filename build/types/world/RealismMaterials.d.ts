import * as THREE from 'three';
import { World } from './World';
export declare function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, height?: number): THREE.CanvasTexture;
export declare function signTexture(text: string, bg: string, fg: string): THREE.CanvasTexture;
/** Re-tints every Realism material (they remember their original colour in userData.realismBase). */
export declare function applyBrightness(root: THREE.Object3D, v: number): void;
export declare function phong(world: World, params: any): THREE.Material;
export declare function createMaterials(world: World, lighting?: string, brightness?: number): {
    [name: string]: THREE.Material;
};
/** Facade texture tiling per building style (metres per texture repeat). */
export interface StyleDef {
    mat: string;
    tileW: number;
    tileH: number;
}
export declare const STYLES: {
    [style: string]: StyleDef;
};
