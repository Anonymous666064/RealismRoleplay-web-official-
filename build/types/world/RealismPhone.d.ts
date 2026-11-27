import { RealismCtx } from './RealismContext';
export declare class RealismPhone {
    isOpen: boolean;
    app: string;
    private ui;
    ctx: RealismCtx;
    world: any;
    private el;
    private timeEl;
    private views;
    private mapCanvas;
    private mapBase;
    private mapBaseScale;
    private zoom;
    private camDir;
    private lastHome;
    private apps;
    private appTicks;
    /** Last drawn map view (for taps): centre, metres per canvas pixel. */
    mapView: {
        cx: number;
        cz: number;
        mpp: number;
        W: number;
        H: number;
    };
    private routeDash;
    /** A pin on the map (Locate in the Garage / Bank apps). */
    marker: {
        x: number;
        z: number;
        label: string;
    };
    constructor(ui: any, ctx: RealismCtx);
    toggle(): void;
    open(): void;
    close(relock: boolean): void;
    /** Keys while the phone is open. Returns true when the key was used. */
    handleKey(e: KeyboardEvent): boolean;
    /** Called by RealismUI about 4 times a second. */
    tick(): void;
    private build;
    private launch;
    private showApp;
    /** Shows a pin on the map (Garage / Bank 'Locate') and opens the Map app; the GPS routes there. */
    locate(x: number, z: number, label: string): void;
    private renderClock;
    private renderGarage;
    private zoomBy;
    /** Base image of the county (land / sea, lake, roads), north up, drawn once per phone opening. */
    private baseMap;
    /** A tap / click on the map canvas (client coordinates). */
    mapTapClient(clientX: number, clientY: number): void;
    /** A tap at canvas pixel (x, y): on the waypoint clears it, on a blip routes to it, else sets a waypoint there. */
    mapTap(x: number, y: number): void;
    private playerPos;
    private drawMap;
}
