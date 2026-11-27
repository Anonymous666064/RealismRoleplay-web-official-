import { CharacterStateBase } from './_stateLibrary';
import { Character } from '../Character';
export declare type RealismPoseKind = 'sit' | 'lie' | 'stand';
export declare class RealismPose extends CharacterStateBase {
    kind: RealismPoseKind;
    /** Called once when a movement key asks to get up. */
    onLeave: () => void;
    constructor(character: Character, kind: RealismPoseKind);
    update(timeStep: number): void;
    onInputChange(): void;
}
export declare class RealismSwimState extends CharacterStateBase {
    /** Swim speed (local arcade units, x moveSpeed = m/s) for normal / Shift. */
    speed: number;
    fastSpeed: number;
    constructor(character: Character);
    update(timeStep: number): void;
    onInputChange(): void;
}
