export declare const SETTINGS_KEY = "realismRoleplay.settings.v1";
export interface SavedSettings {
    v?: number;
    /** 'auto' | 'low' | 'medium' | 'high' | 'ultra' */
    preset?: string;
    /** Values changed with the sliders, on top of the preset (any PerformancePreset field). */
    perf?: {
        [key: string]: any;
    };
    brightness?: number;
    targetFps?: number;
    adaptive?: boolean;
    showFps?: boolean;
    treeNearModels?: number;
    treeNearDistance?: number;
    npcDensity?: number;
    dayNight?: {
        enabled?: boolean;
        cycleMinutes?: number;
        hour?: number;
    };
    /** 0..1 */
    volume?: number;
    mouseSensitivity?: number;
    /** Show Sketchbook's dat.GUI developer panel (top right). */
    devPanel?: boolean;
}
export declare function readSaved(): SavedSettings;
export declare function writeSaved(s: SavedSettings): void;
export declare function clearSaved(): void;
/**
 * Merges the saved settings into the loaded config (called by loadRealismSettings, before the
 * world is built, so preset, distances and baked shadows are right from the first frame).
 * The config's own performance.overrides are kept as performance.configOverrides, so picking a
 * preset in the menu can start again from "preset + realism-config.js" without the old sliders.
 */
export declare function applySavedToConfig(s: any, saved?: SavedSettings): void;
