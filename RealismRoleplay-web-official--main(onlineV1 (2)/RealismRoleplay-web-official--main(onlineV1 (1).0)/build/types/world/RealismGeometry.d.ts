import * as THREE from 'three';
export declare class GeoAccum {
    pos: number[];
    nor: number[];
    uv: number[];
    col: number[];
    idx: number[];
    count: number;
    vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: number[]): number;
    /** Adds a flat polygon (3 or 4 points), fixing the winding so it faces `n`. */
    face(p: number[][], n: number[], uvs: number[][], c: number[]): void;
    get empty(): boolean;
    toGeometry(): THREE.BufferGeometry;
}
export declare class AccumSet {
    private map;
    keys: string[];
    get(key: string): GeoAccum;
}
/** A local frame: origin + yaw. Local +Z is "front", +X is "right when looking at the front from outside"... */
export declare class Frame {
    x: number;
    y: number;
    z: number;
    rot: number;
    private c;
    private s;
    constructor(x: number, y: number, z: number, rot: number);
    p(lx: number, ly: number, lz: number): number[];
    n(nx: number, ny: number, nz: number): number[];
    /** A child frame at local (lx, ly, lz) turned by `rot` more. */
    sub(lx: number, ly: number, lz: number, rot: number): Frame;
}
/**
 * Axis-aligned (in the frame) box from (x0,y0,z0) to (x1,y1,z1).
 * `skip` is a string of faces to leave out: 't' top, 'b' bottom, 'f' front(+z), 'k' back(-z), 'r' +x, 'l' -x.
 * `uvScale` > 0 gives world-scaled UVs (for textured materials), otherwise UVs are 0.
 */
export declare function box(acc: GeoAccum, f: Frame, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number[], skip?: string, uvScale?: number): void;
/** Box by centre and size, convenience for furniture. */
export declare function boxC(acc: GeoAccum, f: Frame, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, c: number[], skip?: string): void;
/** Vertical cylinder / cone in a frame. */
export declare function cyl(acc: GeoAccum, f: Frame, cx: number, y0: number, cz: number, h: number, r0: number, r1: number, seg: number, c: number[], caps?: boolean): void;
/** Horizontal cylinder along local X (pipes, rails, logs). */
export declare function cylX(acc: GeoAccum, f: Frame, x0: number, x1: number, cy: number, cz: number, r: number, seg: number, c: number[]): void;
/** Horizontal cylinder along local Z. */
export declare function cylZ(acc: GeoAccum, f: Frame, z0: number, z1: number, cx: number, cy: number, r: number, seg: number, c: number[]): void;
/** A flat quad lying on top of something (decals, markings), facing up. */
export declare function flatQuad(acc: GeoAccum, f: Frame, x0: number, z0: number, x1: number, z1: number, y: number, c: number[]): void;
export interface Opening {
    u0: number;
    u1: number;
    v0: number;
    v1: number;
}
/**
 * Splits a rectangle [0,len] x [0,h] around openings into solid pieces (u0,u1,v0,v1).
 * Used for walls with doors (both the visible faces and the physics boxes).
 */
export declare function wallPieces(len: number, h: number, openings: Opening[]): Opening[];
/** Simple string hash -> 0..1 (deterministic per building). */
export declare function hash01(n: number): number;
export declare function seeded(seed: number): () => number;
