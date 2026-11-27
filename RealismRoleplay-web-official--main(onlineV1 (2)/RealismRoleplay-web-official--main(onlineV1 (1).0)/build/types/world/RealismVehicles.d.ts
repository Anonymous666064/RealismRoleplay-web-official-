import { World } from './World';
export declare function dressVehicle(world: World, vehicle: any, gltf: any, vt: any): void;
/**
 * Called by VehicleSpawnPoint after a scenario / config vehicle is added to the world.
 * Police types ('police', 'sheriff', or 'policeCruiser' without its own model, or any type with
 * livery: 'police' | 'sheriff') get the police livery + ELS (RealismPolice.ts).
 */
export declare function realismVehicleSpawned(world: World, vehicle: any, type: string, vt: any): void;
