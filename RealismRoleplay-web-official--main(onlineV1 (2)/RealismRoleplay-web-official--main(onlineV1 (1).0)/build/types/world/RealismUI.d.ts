import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { RealismDayNight } from './RealismDayNight';
import { RealismPhone } from './RealismPhone';
import { SavedSettings } from './RealismSettingsStore';
declare type UIState = 'start' | 'playing' | 'paused';
export declare function controlsHTML(list: any[]): string;
export declare class RealismUI implements IUpdatable {
    updateOrder: number;
    state: UIState;
    world: any;
    ctx: RealismCtx;
    dayNight: RealismDayNight;
    phone: RealismPhone;
    saved: SavedSettings;
    private owners;
    private loaded;
    private loadingManager;
    private prevTimeScale;
    private contextControls;
    private expectUnlockUntil;
    private pauseOpenedAt;
    private played;
    private settingsFrom;
    private controlsFrom;
    private rows;
    private saveTimer;
    private treeCapacity;
    private uiAcc;
    private root;
    private startEl;
    private pauseEl;
    private settingsEl;
    private settingsBody;
    private controlsEl;
    private playBtn;
    private settingsBtn;
    private progressBar;
    private progressText;
    constructor(world: any);
    setBlocking(owner: string, on: boolean): void;
    isBlockedBy(owner: string): boolean;
    /** True when an owner other than these is blocking (e.g. the weapon wheel). */
    blockedByOthers(except: string[]): boolean;
    private refreshFlags;
    /** Called once the county is built (RealismWorldBuilder). Starts day / night and the phone,
     *  applies the saved settings and takes over the loading-finished callback (no welcome popup). */
    attach(ctx: RealismCtx, loadingManager: any): void;
    private onLoaded;
    /** A scenario relaunch (Shift+R respawn, dev panel) finished loading: no welcome popup,
     *  carry on playing (or stay paused if a menu is open). Set up by World.launchScenario. */
    onScenarioLoaded(): void;
    /** Polls the loading progress and keeps the phone clock ticking. */
    update(timeStep: number, unscaledTimeStep: number): void;
    /** World.updateControls lands here: the list is shown in Controls, not on the HUD. */
    setContextControls(list: any[]): void;
    play(): void;
    openPause(): void;
    resume(): void;
    quitToTitle(): void;
    /** Settings from the phone: pause the game and open Settings on top of the pause menu. */
    openSettingsFromPhone(): void;
    openSettings(from: string): void;
    closeSettings(): void;
    openControls(from: string): void;
    closeControls(): void;
    private closeSubpages;
    requestLock(): void;
    exitLock(): void;
    private onPointerLockChange;
    private onKeyDown;
    private show;
    private buildDOM;
    private renderControls;
    private section;
    private rowEl;
    private slider;
    private toggle;
    private select;
    private button;
    refreshSettings(): void;
    private perfValue;
    private setPerf;
    private applyNPCDensity;
    private buildSettings;
    /** Detailed tree models: fewer works live; more than at load needs a reload (the pools are sized at load). */
    private setTreeLOD;
    private scheduleSave;
    private flushSave;
}
/** RealismWorldBuilder hook: one call once the county is built. */
export declare function attachRealismUI(world: any, ctx: RealismCtx, loadingManager: any): void;
export {};
