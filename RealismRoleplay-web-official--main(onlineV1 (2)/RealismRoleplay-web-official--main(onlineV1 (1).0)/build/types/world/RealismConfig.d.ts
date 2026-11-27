/** How to place one of your own .glb models in place of a built-in procedural asset. */
export interface AssetOverride {
    /** Path to a .glb file, relative to index.html. Leave empty to keep the built-in model. */
    model?: string;
    /** One number for uniform scale, or [x, y, z]. */
    scale?: number | number[];
    /** Extra rotation in degrees [x, y, z] applied to your model (fixes models exported facing the wrong way). */
    rotation?: number[];
    /** Offset in metres [x, y, z] in the asset's own space (y = up). */
    offset?: number[];
    /** Cast shadows (costs performance). */
    castShadow?: boolean;
    /** Hide this asset completely. */
    disabled?: boolean;
}
/** A model you want placed somewhere in the world. */
export interface PlacedModel {
    model: string;
    /** World position [x, y, z]. If y is omitted (2 numbers) the model sits on the ground. */
    position: number[];
    rotationY?: number;
    scale?: number | number[];
    rotation?: number[];
    offset?: number[];
    /** 'box' (fast, default), 'trimesh' (exact shape, walk-in models; cars drive on it but do not collide with walls) or 'none'. */
    collider?: string;
    castShadow?: boolean;
}
/** Replace generated buildings that match with your own model. */
export interface BuildingModelRule {
    /** Match on any of these (all given fields must match). */
    match: {
        label?: string;
        kind?: string;
        district?: string;
        style?: string;
    };
    model: string;
    /** true: stretch the model to the building footprint and height. false: use `scale` as-is. */
    fit?: boolean;
    scale?: number | number[];
    rotation?: number[];
    offset?: number[];
    collider?: string;
    /** 0..1, chance that each matching building is replaced (default 1). */
    chance?: number;
}
/**
 * One of your vegetation models (realism-config.js -> vegetation.trees / pineTrees / bushes / hedges).
 * Only `model` is needed. The model is measured when it loads: its bottom centre is put on the
 * ground, so it does not matter where the origin was in Blender.
 */
export interface VegetationModel {
    /** Path to a .glb file, relative to index.html. */
    model: string;
    /**
     * Trees / bushes: size multiplier on the model's real size (1 = as exported).
     * Hedges: multiplier on the built-in hedge height / depth (the length is filled automatically).
     * One number, or [x, y, z].
     */
    scale?: number | number[];
    /** Extra rotation in degrees [x, y, z] (fixes models exported lying down or facing the wrong way). */
    rotation?: number[];
    /** Offset in metres [x, y, z] after scaling (y = up, e.g. -0.1 sinks the model into the ground). */
    offset?: number[];
    /** Physics: trees and hedges default true (trunk / hedge box), bushes default false. */
    collider?: boolean;
    castShadow?: boolean;
    /** How often this variant is picked compared to the others in the same list (default 1). */
    weight?: number;
}
export interface VegetationSettings {
    /** false: no auto-placed hedges / bushes and none of your vegetation models (trees stay built-in). */
    enabled: boolean;
    /** Broad-leaf trees (the round built-in ones). Empty = built-in model. */
    trees: (VegetationModel | string)[];
    /** Conifers (the cone built-in ones). Empty = built-in model. */
    pineTrees: (VegetationModel | string)[];
    bushes: (VegetationModel | string)[];
    hedges: (VegetationModel | string)[];
    /** 0 = none, 1 = default amount, up to 2 = more. Trees can only be thinned (0..1). */
    density: {
        trees: number;
        bushes: number;
        hedges: number;
    };
    /** Hedges along the fronts of houses / apartments / offices / shops (gaps at doors, paths, driveways). */
    frontHedges: boolean;
    /** Hedges along the sides of houses and of apartments / offices / shops with room beside them. */
    sideHedges: boolean;
    /** Random size variation of trees and bushes, +/- (0.15 = 85% to 115%). */
    randomScale: number;
    /** How many of the trees nearest to you use your .glb model at once; every other tree uses the built-in low-poly model. */
    nearModels: number;
    /** Metres: a tree farther than this always uses the built-in low-poly model, even if it is one of the nearest. */
    nearDistance: number;
}
export interface VehicleType {
    /** Which Sketchbook vehicle class drives it: 'car' | 'heli' | 'airplane'. */
    base: string;
    /**
     * Your model. Two modes:
     *  - sketchbookFormat: true  -> the .glb was exported with Sketchbook's Blender add-on data
     *    (seats, wheels, collision). It is used directly.
     *  - sketchbookFormat: false -> any .glb (a car from Sketchfab etc.). The game uses the stock
     *    vehicle for physics, seats and wheels and shows your model on top of it.
     */
    model?: string;
    sketchbookFormat?: boolean;
    /** Stock vehicle used for physics when sketchbookFormat is false. Defaults to build/assets/<base>.glb */
    baseModel?: string;
    scale?: number | number[];
    rotation?: number[];
    offset?: number[];
    /** Keep the stock vehicle's wheels visible under your body model. */
    keepBaseWheels?: boolean;
}
export interface VehicleSpawn {
    /** A key from vehicles.types (e.g. 'car', 'policeCruiser'). */
    vehicle: string;
    /** Scenario id: downtown | police | sheriff | hospital | airport | port | dealer | suburbs | hood | lookout | prison, or 'all'. */
    scenario: string;
    /** World position [x, z] or [x, y, z]. */
    position: number[];
    rotationY?: number;
    /** 'player' puts you straight in the driver seat. */
    driver?: string;
}
export interface PerformancePreset {
    pixelRatio: number;
    shadows: boolean;
    fxaa: boolean;
    viewDistance: number;
    treeDistance: number;
    detailDistance: number;
    buildingDistance: number;
    pointLights: number;
    water: string;
    interiors: boolean;
    interiorDistance: number;
    trafficLights: boolean;
    /** 'lambert' = cheap per-vertex lighting, 'phong' = per-pixel. */
    lighting: string;
    /** Shadow map size for realtime shadows (only used when shadows is true). */
    shadowMapSize: number;
    /** Ray-cast the sun once at load and bake shadows into the ground and roads (free while playing). */
    bakedShadows: boolean;
}
export interface RealismSettings {
    seed: number;
    player?: {
        scale?: number;
        seatedScale?: number;
        models?: {
            [gender: string]: {
                height?: number;
                scale?: number;
                y?: number;
                seatedScale?: number;
                seatedY?: number;
            };
        };
    };
    performance: {
        /** 'auto' picks low on phones/Chromebooks, medium on typical laptops, high on desktops. */
        preset: string;
        /** Your own overrides on top of the chosen preset (any PerformancePreset field). */
        overrides: {
            [key: string]: any;
        };
        presets: {
            [name: string]: PerformancePreset;
        };
        /** Show the old Realism Graphics folder in the top-right dat.GUI (the Settings menu replaces it). */
        showPanel: boolean;
        /** Frames per second the game tries to hold. Below it, resolution, view distance and lights are lowered step by step; they come back when there is headroom. */
        targetFps: number;
        adaptive: boolean;
        /** Show FPS + draw calls in the corner. */
        showFps: boolean;
        /** Multiplies the colour of the city, roads and terrain. Sketchbook's sun is very strong, so 0.55 keeps colours from washing out to white. */
        brightness: number;
        /** Free the GPU memory of everything far beyond its view distance (re-uploaded when you come back). */
        unloadFar: boolean;
        /** Metres past an object's view distance before it is unloaded (stops load/unload flicker at the edge). */
        unloadMargin: number;
    };
    city: {
        streetLights: boolean;
        trafficLights: boolean;
        stopSigns: boolean;
        hydrants: boolean;
        benches: boolean;
        trashCans: boolean;
        gangNeighborhoods: boolean;
        /** Seconds for one full traffic light cycle (green + yellow for each direction). */
        trafficCycle: number;
        /** Built-in street furniture you can swap for your own models. */
        props: {
            [name: string]: AssetOverride;
        };
        /** Replace generated buildings (shops, the diner, etc.) with your own models. */
        buildingModels: BuildingModelRule[];
        /** Extra models placed anywhere. */
        extraModels: PlacedModel[];
    };
    house: {
        interiors: boolean;
        /** Replace generated houses with your own models (picked at random per house). */
        models: BuildingModelRule[];
        /** Furniture you can swap for your own models (fridge, tv, couch, ...). */
        furniture: {
            [name: string]: AssetOverride;
        };
        /** Wall colour palettes (rgb 0..1). */
        wallColors: number[][];
        hoodWallColors: number[][];
    };
    vehicles: {
        types: {
            [name: string]: VehicleType;
        };
        spawns: VehicleSpawn[];
    };
    /** Trees, bushes and hedges: your own models + auto placement (RealismVegetation.ts / RealismVegetationModels.ts). */
    vegetation: VegetationSettings;
    /** Day / night cycle (RealismDayNight.ts). Optional: defaults live in RealismDayNight.ts. */
    dayNight?: {
        enabled?: boolean;
        cycleMinutes?: number;
        startHour?: number;
        nightBrightness?: number;
        windowsAtNight?: boolean;
    };
}
export declare const DEFAULT_SETTINGS: RealismSettings;
export declare function deepMerge(base: any, over: any): any;
/** Reads window.REALISM_CONFIG (from realism-config.js) and merges it over the defaults. */
export declare function loadRealismSettings(seedOverride?: number): RealismSettings;
/** Picks low / medium / high for 'auto'. */
export declare function detectPreset(): string;
export declare function resolvePreset(s: RealismSettings, name?: string): {
    name: string;
    p: PerformancePreset;
};
export declare function scaleVec(s: number | number[] | undefined): number[];
