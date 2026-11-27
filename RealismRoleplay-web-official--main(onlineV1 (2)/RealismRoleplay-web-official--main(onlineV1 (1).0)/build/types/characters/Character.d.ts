import * as THREE from 'three';
import * as CANNON from 'cannon';
import { KeyBinding } from '../core/KeyBinding';
import { VectorSpringSimulator } from '../physics/spring_simulation/VectorSpringSimulator';
import { RelativeSpringSimulator } from '../physics/spring_simulation/RelativeSpringSimulator';
import { ICharacterAI } from '../interfaces/ICharacterAI';
import { World } from '../world/World';
import { IControllable } from '../interfaces/IControllable';
import { ICharacterState } from '../interfaces/ICharacterState';
import { IWorldEntity } from '../interfaces/IWorldEntity';
import { VehicleSeat } from '../vehicles/VehicleSeat';
import { Vehicle } from '../vehicles/Vehicle';
import { CapsuleCollider } from '../physics/colliders/CapsuleCollider';
import { VehicleEntryInstance } from './VehicleEntryInstance';
import { GroundImpactData } from './GroundImpactData';
import { EntityType } from '../enums/EntityType';
export declare class Character extends THREE.Object3D implements IWorldEntity {
    updateOrder: number;
    entityType: EntityType;
    height: number;
    tiltContainer: THREE.Group;
    modelContainer: THREE.Group;
    materials: THREE.Material[];
    mixer: THREE.AnimationMixer;
    animations: any[];
    acceleration: THREE.Vector3;
    velocity: THREE.Vector3;
    arcadeVelocityInfluence: THREE.Vector3;
    velocityTarget: THREE.Vector3;
    /** Realism (A14): called at the end of every physics post step (swimming buoyancy). */
    realismPostStep: (body: CANNON.Body) => void;
    /** Realism (A14): first person eye height change while seated / lying (metres, negative = lower). */
    realismEyeDrop: number;
    arcadeVelocityIsAdditive: boolean;
    defaultVelocitySimulatorDamping: number;
    defaultVelocitySimulatorMass: number;
    velocitySimulator: VectorSpringSimulator;
    moveSpeed: number;
    angularVelocity: number;
    orientation: THREE.Vector3;
    orientationTarget: THREE.Vector3;
    defaultRotationSimulatorDamping: number;
    defaultRotationSimulatorMass: number;
    rotationSimulator: RelativeSpringSimulator;
    viewVector: THREE.Vector3;
    actions: {
        [action: string]: KeyBinding;
    };
    characterCapsule: CapsuleCollider;
    rayResult: CANNON.RaycastResult;
    rayHasHit: boolean;
    rayCastLength: number;
    raySafeOffset: number;
    wantsToJump: boolean;
    initJumpSpeed: number;
    groundImpactData: GroundImpactData;
    raycastBox: THREE.Mesh;
    world: World;
    charState: ICharacterState;
    behaviour: ICharacterAI;
    controlledObject: IControllable;
    occupyingSeat: VehicleSeat;
    vehicleEntryInstance: VehicleEntryInstance;
    /** Realism weapons: while set (aiming), the character faces this flat direction and strafes. */
    aimDirection: THREE.Vector3;
    /** Standing size multiplier: visuals, capsule, ray, camera distance. */
    playerScale: number;
    /** Size while sitting in a vehicle (the built-in vehicles are made for scale 1). */
    seatedScale: number;
    /** Walk / run / jump speed multiplier that goes with playerScale. */
    speedFactor: number;
    /** Visual size applied this frame (blends between playerScale and seatedScale). */
    modelScale: number;
    /** Normalizes imported character models to the original 1.024 m visual height. */
    modelBaseScale: number;
    modelBaseMinY: number;
    modelFitScale: number;
    modelFitY: number;
    modelSeatedScale: number;
    modelSeatedY: number;
    realismGender: string;
    /** Set by vehicle enter / exit states each frame: 0 = standing size, 1 = seated size. -1 = automatic. */
    seatBlendOverride: number;
    /** Gait speed multiplier; normalized imported models keep this at 1. */
    loopAnimRate: number;
    /** Third person camera distance at scale 1 (multiplied by playerScale). */
    cameraDistanceBase: number;
    /** First person (RealismFirstPerson.ts): while set, the body faces this flat direction at once and strafes. */
    firstPersonLook: THREE.Vector3;
    private fpMoveDir;
    private physicsEnabled;
    constructor(gltf: any);
    setAnimations(animations?: any[], root?: THREE.Object3D): void;
    /**
     * Realism: resizes this character. scale 1 = original. Rebuilds the physics capsule (spheres from
     * 0.07 * scale to 1.07 * scale above the feet, like the original 0.07..1.07), the ground ray, speeds,
     * jump and the camera distance. `capsuleRadius` caps the capsule radius (metres) so a big character
     * still fits through doorways; `speedFactor` defaults to sqrt(scale).
     */
    applyPlayerScale(scale: number, opts?: {
        seatedScale?: number;
        speedFactor?: number;
        capsuleRadius?: number;
    }): void;
    setModelFit(settings: any): void;
    /** Height offset above a vehicle entry / exit point for a STANDING character (original value `base`, made for scale 1). */
    standOffsetY(base: number): number;
    /** Height offset above a seat point for a SEATED character (original value `base`). Keeps the hips on the seat. */
    seatOffsetY(base: number): number;
    /** Applies the visual size for this frame: standing size, seated size, or the blend a vehicle state asked for. */
    updateModelScale(): void;
    setArcadeVelocityInfluence(x: number, y?: number, z?: number): void;
    setViewVector(vector: THREE.Vector3): void;
    /**
     * Set state to the player. Pass state class (function) name.
     * @param {function} State
     */
    setState(state: ICharacterState): void;
    setPosition(x: number, y: number, z: number): void;
    resetVelocity(): void;
    setArcadeVelocityTarget(velZ: number, velX?: number, velY?: number): void;
    setOrientation(vector: THREE.Vector3, instantly?: boolean): void;
    resetOrientation(): void;
    setBehaviour(behaviour: ICharacterAI): void;
    setPhysicsEnabled(value: boolean): void;
    readCharacterData(gltf: any): void;
    replaceModel(gltf: any): void;
    handleKeyboardEvent(event: KeyboardEvent, code: string, pressed: boolean): void;
    handleMouseButton(event: MouseEvent, code: string, pressed: boolean): void;
    handleMouseMove(event: MouseEvent, deltaX: number, deltaY: number): void;
    handleMouseWheel(event: WheelEvent, value: number): void;
    triggerAction(actionName: string, value: boolean): void;
    takeControl(): void;
    resetControls(): void;
    update(timeStep: number): void;
    inputReceiverInit(): void;
    displayControls(): void;
    inputReceiverUpdate(timeStep: number): void;
    setAnimation(clipName: string, fadeIn: number): number;
    springMovement(timeStep: number): void;
    springRotation(timeStep: number): void;
    getLocalMovementDirection(): THREE.Vector3;
    /** Like getLocalMovementDirection, without allocating. */
    getLocalMovementDirectionInto(out: THREE.Vector3): THREE.Vector3;
    getCameraRelativeMovementVector(): THREE.Vector3;
    setCameraRelativeOrientationTarget(): void;
    rotateModel(): void;
    jump(initJumpSpeed?: number): void;
    findVehicleToEnter(wantsToDrive: boolean): void;
    enterVehicle(seat: VehicleSeat, entryPoint: THREE.Object3D): void;
    teleportToVehicle(vehicle: Vehicle, seat: VehicleSeat): void;
    startControllingVehicle(vehicle: IControllable, seat: VehicleSeat): void;
    transferControls(entity: IControllable): void;
    stopControllingVehicle(): void;
    exitVehicle(): void;
    occupySeat(seat: VehicleSeat): void;
    leaveSeat(): void;
    physicsPreStep(body: CANNON.Body, character: Character): void;
    feetRaycast(): void;
    physicsPostStep(body: CANNON.Body, character: Character): void;
    addToWorld(world: World): void;
    removeFromWorld(world: World): void;
}
