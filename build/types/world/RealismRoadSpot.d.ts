import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
export interface RoadSpot {
    x: number;
    y: number;
    z: number;
    heading: number;
    quat: THREE.Quaternion;
    road: string;
}
export interface RoadSpotOptions {
    /** Clear radius around the vehicle centre in metres (sedan ~3, heli ~8, airplane ~15). */
    clearance?: number;
    /** Search radius around `near` in metres. */
    radius?: number;
    /** Extra obstacle positions (e.g. parked NPC cars), checked with `clearance`. */
    obstacles?: {
        x: number;
        z: number;
    }[];
    /** Vehicles to ignore (e.g. the car being moved). */
    ignore?: any[];
    /** Player position: the spot is at least this far from it (default 3.2 m). */
    player?: THREE.Vector3;
}
export declare function findRoadSpot(ctx: RealismCtx, near: THREE.Vector3, opts?: RoadSpotOptions): RoadSpot | null;
