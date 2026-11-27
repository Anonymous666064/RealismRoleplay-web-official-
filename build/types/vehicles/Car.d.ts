import * as CANNON from 'cannon';
import { Vehicle } from './Vehicle';
import { IControllable } from '../interfaces/IControllable';
import { SpringSimulator } from '../physics/spring_simulation/SpringSimulator';
import { EntityType } from '../enums/EntityType';
export declare class Car extends Vehicle implements IControllable {
    entityType: EntityType;
    drive: string;
    get speed(): number;
    private _speed;
    private steeringWheel;
    private airSpinTimer;
    steeringSimulator: SpringSimulator;
    engineForce: number;
    topSpeedFactor: number;
    maxSteerVal: number;
    /** Realism: true while the engine is off (e.g. during the hotwire minigame): no drive force. */
    engineOff: boolean;
    private engineOffApplied;
    brakeFactor: number;
    handbrakeForce: number;
    steeringMass: number;
    private static readonly GEAR_MAX_SPEEDS;
    private gear;
    private shiftTimer;
    private timeToShift;
    private canTiltForwards;
    private characterWantsToExit;
    constructor(gltf: any);
    noDirectionPressed(): boolean;
    update(timeStep: number): void;
    shiftUp(): void;
    shiftDown(): void;
    physicsPreStep(body: CANNON.Body, car: Car): void;
    onInputChange(): void;
    inputReceiverInit(): void;
    readCarData(gltf: any): void;
}
