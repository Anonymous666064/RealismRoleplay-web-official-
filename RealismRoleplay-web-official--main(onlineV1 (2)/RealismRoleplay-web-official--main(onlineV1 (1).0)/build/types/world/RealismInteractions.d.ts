import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { RealismPose } from '../characters/character_states/RealismStates';
import { RealismSfx } from './RealismSfx';
import { RoomLights } from './RealismRoomLights';
export declare const DEFAULT_INTERACTIONS: {
    enabled: boolean;
    reach: number;
    wakeHour: number;
    maxSleepHours: number;
    energyPerSleepHour: number;
    showerSeconds: number;
    washSeconds: number;
    cookSeconds: number;
    toiletSeconds: number;
    laptopZoomSeconds: number;
    fridge: {
        snack: {
            hunger: number;
            thirst: number;
        };
        water: {
            thirst: number;
            bladder: number;
        };
        soda: {
            thirst: number;
            hunger: number;
            energy: number;
            bladder: number;
        };
    };
    cookGain: {
        hunger: number;
        thirst: number;
    };
    sinkGain: number;
};
export interface Anchor {
    type: string;
    name: string;
    x: number;
    z: number;
    y: number;
    ry: number;
    hw: number;
    hd: number;
    room: number;
    pose: string;
    px: number;
    pz: number;
    top: number;
    yaw: number;
    ex: number;
    ez: number;
    sx: number;
    sy: number;
    sz: number;
    nx: number;
    nz: number;
    prio: number;
    paired?: Anchor;
}
export declare class AnchorStore {
    list: Anchor[];
    private grid;
    roomCeil: {
        room: number;
        x: number;
        y: number;
        z: number;
    }[];
    roomSpots: {
        room: number;
        spot: number;
    }[];
    private key;
    add(a: Anchor): void;
    cell(ix: number, iz: number): Anchor[];
    /** World point of local (lx, ly, lz) in a placement frame (same convention as RealismGeometry.Frame). */
    static wp(p: any, lx: number, lz: number, out: number[]): number[];
    /** Builds the anchors of one placed furniture item. dims overrides the item size (hotel kit). */
    fromItem(name: string, p: any, variant: number, dims?: any): void;
    /** Pairs desks / laptops with the nearest chair (sit there, facing the screen). */
    finalize(): void;
    counts(): {
        [type: string]: number;
    };
}
/** Creates the anchor store and the sink the furniture builders call. Hook: before buildInteriors(). */
export declare function installInteractionSink(ctx: RealismCtx): AnchorStore;
interface Session {
    a: Anchor;
    kind: string;
    phase: string;
    t: number;
    dur: number;
    state: RealismPose;
    gained: number;
    prevWeapon: number;
}
export declare class InteractionSystem implements IUpdatable {
    updateOrder: number;
    settings: any;
    store: AnchorStore;
    roomLights: RoomLights;
    nearest: Anchor;
    active: Session;
    sfx: RealismSfx;
    stats: {
        uses: number;
        sleeps: number;
        hoursSlept: number;
        laptopOpens: number;
        laptopCloses: number;
        toggles: number;
        fridge: number;
    };
    private world;
    private ctx;
    private acc;
    private lastItems;
    private ownPrompt;
    private fade;
    private fadeLevel;
    private menu;
    private menuOpen;
    private hadLock;
    private handlers;
    private bones;
    private bonesOf;
    private qx;
    private ax;
    private camFromP;
    private camFromQ;
    private camToP;
    private camToQ;
    private tmpQ;
    private tmpM;
    private tmpV;
    private up;
    camBlend: number;
    private modelHidden;
    private drops;
    private dropV;
    private rayRes;
    private rayFrom;
    private rayTo;
    constructor(ctx: RealismCtx, store: AnchorStore, furniture: any);
    counts(): {
        [type: string]: number;
    };
    private bind;
    private blocked;
    onKey(e: any): void;
    /** E pressed (also callable from tests). */
    pressE(): boolean;
    private promptActive;
    private promptAnchor;
    private lastNear;
    /** `near`: a nearby furniture anchor. v14: same priority as doors, so the closer one wins
     *  the shared [E] key (a light switch beside a door no longer hides the door's prompt). */
    private setPrompt;
    private progress;
    /** Small stand-in prompt, only when A12's realismPrompt doesn't exist. */
    private drawOwnPrompt;
    private player;
    private scale;
    update(timeStep: number, unscaledTimeStep: number): void;
    /** Best anchor in reach that the character roughly faces. */
    find(ch: any): Anchor;
    /** Starts using an anchor (E). */
    use(a: Anchor): boolean;
    private seatedPrompt;
    private startTimed;
    private enterPose;
    private onMoveKey;
    /** Gets up / steps away and ends the current interaction. */
    leave(): void;
    /** Side of the bed that isn't against a wall. */
    private bedExit;
    private putAwayWeapon;
    private restoreWeapon;
    private updateSession;
    /** Gains spread over the timed action (partial when stopped early). */
    private applyGain;
    private finishTimed;
    private doSleep;
    private updateFade;
    private fadeTo;
    get fadeValue(): number;
    private openFridge;
    get fridgeOpen(): boolean;
    /** Fridge menu choice: 0 snack, 1 water, 2 soda, -1 close. */
    fridgeChoice(i: number): void;
    private startZoom;
    /** Camera pose in front of the screen (camToP / camToQ). */
    private screenPose;
    private updateZoom;
    private hideModel;
    private restoreCamera;
    private openLaptop;
    /** Called by the laptop's onClose: zoom back out, still seated. */
    laptopClosed(): void;
    private findBones;
    /** Arms forward over the sink / stove, with a small washing / stirring motion. Runs after the mixer. */
    private armsForward;
    private showerDrops;
    private updateDrops;
    get dropsVisible(): boolean;
}
export {};
