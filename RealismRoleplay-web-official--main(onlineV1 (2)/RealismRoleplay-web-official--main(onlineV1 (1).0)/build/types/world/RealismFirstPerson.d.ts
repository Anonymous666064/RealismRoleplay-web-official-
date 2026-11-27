import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
export declare class FirstPersonCamera implements IUpdatable {
    updateOrder: number;
    settings: any;
    enabled: boolean;
    blend: number;
    stats: {
        toggles: number;
        vehicleSyncs: number;
    };
    private world;
    private handlers;
    private lastReceiver;
    private curVehicle;
    private vehFP;
    private headChar;
    private headBone;
    private headScale;
    private lookChar;
    private baseNear;
    private nearApplied;
    private baseFov;
    private fovApplied;
    private eyeY;
    private eyeInit;
    private bobS;
    private bobPhase;
    private move;
    private look;
    private lookFlat;
    private eye;
    private v1;
    private v2;
    private fwd;
    constructor(ctx: RealismCtx);
    private load;
    private save;
    setEnabled(on: boolean): void;
    toggle(): void;
    private bindInput;
    update(timeStep: number, unscaledTimeStep: number): void;
    private findHead;
    /** Collapses the head of `ch` (null = restore). Runs after the animation mixer each frame. */
    private hideHead;
    private applyNear;
    /** Optional first person field of view (player.fov). Left alone while the weapons zoom. */
    private applyFov;
    dispose(): void;
}
