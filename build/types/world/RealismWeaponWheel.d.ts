export interface WheelSlot {
    id: string;
    name: string;
    icon: string;
    ammo: string;
    empty: boolean;
}
export declare class WeaponWheel {
    isOpen: boolean;
    hover: number;
    openedAt: number;
    private root;
    private slotEls;
    private center;
    private slots;
    private current;
    private radius;
    private onPick;
    private onCancel;
    constructor(onPick: (index: number) => void, onCancel: () => void);
    private build;
    private onMove;
    /** Picks the sector under a point relative to the screen centre (px). Dead zone in the middle. */
    setHoverFromPoint(dx: number, dy: number): void;
    setHover(i: number): void;
    open(slots: WheelSlot[], current: number, now: number): void;
    close(): void;
    private refresh;
    dispose(): void;
}
/** Ammo counter, crosshair, hit marker and a one-line message. */
export declare class WeaponHud {
    private ammo;
    private cross;
    private dot;
    private hit;
    private msg;
    private lastAmmo;
    private crossGap;
    private crossShown;
    private dotShown;
    private hitUntil;
    private msgUntil;
    private ok;
    constructor();
    setAmmo(text: string): void;
    /** gap: crosshair arm distance from the centre, px. */
    setCrosshair(show: boolean, gap: number, dot: boolean): void;
    hitMarker(now: number, kill: boolean): void;
    message(text: string, now: number, seconds?: number): void;
    update(now: number): void;
    hideAll(): void;
}
