/*
 * RealismConfig.ts
 * ----------------
 * Every setting the San Verano County world reads at start-up, with defaults.
 *
 * You do NOT need to rebuild the game to change these. Put your overrides in
 * `realism-config.js` (loaded by index.html before build/sketchbook.min.js):
 *
 *     window.REALISM_CONFIG = {
 *         performance: { preset: 'low' },
 *         city: { props: { fireHydrant: { model: 'build/assets/props/hydrant.glb', scale: 1.2 } } },
 *     };
 *
 * Anything you leave out keeps the default below. Your settings are deep-merged on top.
 */

import { applySavedToConfig } from './RealismSettingsStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How to place one of your own .glb models in place of a built-in procedural asset. */
export interface AssetOverride
{
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
export interface PlacedModel
{
	model: string;
	/** World position [x, y, z]. If y is omitted (2 numbers) the model sits on the ground. */
	position: number[];
	rotationY?: number;          // degrees
	scale?: number | number[];
	rotation?: number[];         // extra rotation in degrees [x, y, z]
	offset?: number[];
	/** 'box' (fast, default), 'trimesh' (exact shape, walk-in models; cars drive on it but do not collide with walls) or 'none'. */
	collider?: string;
	castShadow?: boolean;
}

/** Replace generated buildings that match with your own model. */
export interface BuildingModelRule
{
	/** Match on any of these (all given fields must match). */
	match: { label?: string; kind?: string; district?: string; style?: string };
	model: string;
	/** true: stretch the model to the building footprint and height. false: use `scale` as-is. */
	fit?: boolean;
	scale?: number | number[];
	rotation?: number[];
	offset?: number[];
	collider?: string;           // 'box' | 'trimesh' | 'none'
	/** 0..1, chance that each matching building is replaced (default 1). */
	chance?: number;
}

/**
 * One of your vegetation models (realism-config.js -> vegetation.trees / pineTrees / bushes / hedges).
 * Only `model` is needed. The model is measured when it loads: its bottom centre is put on the
 * ground, so it does not matter where the origin was in Blender.
 */
export interface VegetationModel
{
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

export interface VegetationSettings
{
	/** false: no auto-placed hedges / bushes and none of your vegetation models (trees stay built-in). */
	enabled: boolean;
	/** Broad-leaf trees (the round built-in ones). Empty = built-in model. */
	trees: (VegetationModel | string)[];
	/** Conifers (the cone built-in ones). Empty = built-in model. */
	pineTrees: (VegetationModel | string)[];
	bushes: (VegetationModel | string)[];
	hedges: (VegetationModel | string)[];
	/** 0 = none, 1 = default amount, up to 2 = more. Trees can only be thinned (0..1). */
	density: { trees: number; bushes: number; hedges: number };
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

export interface VehicleType
{
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

export interface VehicleSpawn
{
	/** A key from vehicles.types (e.g. 'car', 'policeCruiser'). */
	vehicle: string;
	/** Scenario id: downtown | police | sheriff | hospital | airport | port | dealer | suburbs | hood | lookout | prison, or 'all'. */
	scenario: string;
	/** World position [x, z] or [x, y, z]. */
	position: number[];
	rotationY?: number;          // degrees
	/** 'player' puts you straight in the driver seat. */
	driver?: string;
}

export interface PerformancePreset
{
	pixelRatio: number;          // highest render pixel ratio (never above the screen's own; 0.75 = render below screen resolution)
	shadows: boolean;
	fxaa: boolean;
	viewDistance: number;        // metres (camera far plane and fog)
	treeDistance: number;
	detailDistance: number;      // props, street furniture, exterior trims
	buildingDistance: number;
	pointLights: number;         // real three.js lights shared between the nearest lamps and rooms
	water: string;               // 'simple' | 'shader'
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

export interface RealismSettings
{
	seed: number;
	player?: {
		scale?: number;
		seatedScale?: number;
		models?: { [gender: string]: { height?: number; scale?: number; y?: number; seatedScale?: number; seatedY?: number } };
	};
	performance: {
		/** 'auto' picks low on phones/Chromebooks, medium on typical laptops, high on desktops. */
		preset: string;
		/** Your own overrides on top of the chosen preset (any PerformancePreset field). */
		overrides: { [key: string]: any };
		presets: { [name: string]: PerformancePreset };
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
		props: { [name: string]: AssetOverride };
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
		furniture: { [name: string]: AssetOverride };
		/** Wall colour palettes (rgb 0..1). */
		wallColors: number[][];
		hoodWallColors: number[][];
	};
	vehicles: {
		types: { [name: string]: VehicleType };
		spawns: VehicleSpawn[];
	};
	/** Trees, bushes and hedges: your own models + auto placement (RealismVegetation.ts / RealismVegetationModels.ts). */
	vegetation: VegetationSettings;
	/** Day / night cycle (RealismDayNight.ts). Optional: defaults live in RealismDayNight.ts. */
	dayNight?: { enabled?: boolean; cycleMinutes?: number; startHour?: number; nightBrightness?: number; windowsAtNight?: boolean };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const PRESETS: { [name: string]: PerformancePreset } = {
	low: {
		pixelRatio: 0.75, shadows: false, fxaa: false, viewDistance: 520,
		treeDistance: 260, detailDistance: 90, buildingDistance: 520,
		pointLights: 0, water: 'simple', interiors: true, interiorDistance: 28, trafficLights: true, lighting: 'lambert', shadowMapSize: 512, bakedShadows: true,
	},
	medium: {
		pixelRatio: 1, shadows: false, fxaa: false, viewDistance: 750,
		treeDistance: 420, detailDistance: 160, buildingDistance: 750,
		pointLights: 4, water: 'simple', interiors: true, interiorDistance: 40, trafficLights: true, lighting: 'lambert', shadowMapSize: 1024, bakedShadows: true,
	},
	high: {
		pixelRatio: 1.5, shadows: true, fxaa: true, viewDistance: 1000,
		treeDistance: 650, detailDistance: 260, buildingDistance: 1000,
		pointLights: 8, water: 'shader', interiors: true, interiorDistance: 55, trafficLights: true, lighting: 'phong', shadowMapSize: 1024, bakedShadows: false,
	},
	ultra: {
		pixelRatio: 2, shadows: true, fxaa: true, viewDistance: 1000,
		treeDistance: 1000, detailDistance: 400, buildingDistance: 1000,
		pointLights: 12, water: 'shader', interiors: true, interiorDistance: 70, trafficLights: true, lighting: 'phong', shadowMapSize: 2048, bakedShadows: false,
	},
};

export const DEFAULT_SETTINGS: RealismSettings = {
	seed: 1337,
	performance: { preset: 'auto', overrides: {}, presets: PRESETS, showPanel: false, targetFps: 30, adaptive: true, showFps: true, brightness: 0.55, unloadFar: true, unloadMargin: 80 },
	city: {
		streetLights: true,
		trafficLights: true,
		stopSigns: true,
		hydrants: true,
		benches: true,
		trashCans: true,
		gangNeighborhoods: true,
		trafficCycle: 24,
		props: {
			streetLight: {},
			trafficLight: {},
			stopSign: {},
			fireHydrant: {},
			bench: {},
			trashCan: {},
			dumpster: {},
			mailbox: {},
			chainLinkFence: {},
			wreckedCar: {},
			tree: {},
			pineTree: {},
		},
		buildingModels: [],
		extraModels: [],
	},
	house: {
		interiors: true,
		models: [],
		furniture: {
			fridge: {}, stove: {}, counter: {}, sink: {}, diningTable: {}, chair: {},
			couch: {}, armchair: {}, coffeeTable: {}, tv: {}, tvStand: {}, rug: {}, floorLamp: {}, bookshelf: {},
			bed: {}, nightstand: {}, wardrobe: {}, dresser: {},
			toilet: {}, bathSink: {}, bathtub: {},
			desk: {}, officeChair: {}, shelf: {}, checkout: {}, cooler: {}, booth: {}, barStool: {},
			bunkBed: {}, locker: {}, plant: {}, mattress: {}, trashBag: {},
		},
		wallColors: [[0.95, 0.94, 0.9], [0.9, 0.85, 0.72], [0.75, 0.82, 0.88], [0.85, 0.78, 0.7], [0.92, 0.9, 0.82], [0.7, 0.75, 0.68]],
		hoodWallColors: [[0.62, 0.58, 0.5], [0.55, 0.5, 0.46], [0.6, 0.55, 0.42], [0.5, 0.52, 0.5], [0.58, 0.47, 0.42]],
	},
	vehicles: {
		types: {
			car: { base: 'car', model: 'build/assets/car.glb', sketchbookFormat: true },
			heli: { base: 'heli', model: 'build/assets/heli.glb', sketchbookFormat: true },
			airplane: { base: 'airplane', model: 'build/assets/airplane.glb', sketchbookFormat: true },
		},
		spawns: [],
	},
	vegetation: {
		enabled: true,
		trees: [],
		pineTrees: [],
		bushes: [],
		hedges: [],
		density: { trees: 1, bushes: 1, hedges: 1 },
		frontHedges: true,
		sideHedges: true,
		randomScale: 0.15,
		nearModels: 10,
		nearDistance: 120,
	},
};

// ---------------------------------------------------------------------------
// Merge / resolve
// ---------------------------------------------------------------------------

function isPlainObject(v: any): boolean
{
	return v !== null && typeof v === 'object' && !(v instanceof Array);
}

export function deepMerge(base: any, over: any): any
{
	if (!isPlainObject(over)) return over === undefined ? base : over;
	const out: any = {};
	if (isPlainObject(base)) for (const k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
	for (const k in over)
	{
		if (!over.hasOwnProperty(k)) continue;
		out[k] = isPlainObject(over[k]) && isPlainObject(out[k]) ? deepMerge(out[k], over[k]) : over[k];
	}
	return out;
}

/** Reads window.REALISM_CONFIG (from realism-config.js) and merges it over the defaults. */
export function loadRealismSettings(seedOverride?: number): RealismSettings
{
	let user: any = {};
	try
	{
		const w: any = typeof window !== 'undefined' ? window : {};
		if (w.REALISM_CONFIG && typeof w.REALISM_CONFIG === 'object') user = w.REALISM_CONFIG;
	}
	catch (e) { user = {}; }
	const s: RealismSettings = deepMerge(DEFAULT_SETTINGS, user);
	// the player's Settings menu choices (localStorage) win over realism-config.js
	applySavedToConfig(s);
	if (seedOverride !== undefined && !isNaN(seedOverride)) s.seed = seedOverride;
	return s;
}

/** Picks low / medium / high for 'auto'. */
export function detectPreset(): string
{
	try
	{
		const nav: any = navigator;
		const ua = (nav.userAgent || '').toLowerCase();
		const cores = nav.hardwareConcurrency || 4;
		const mem = nav.deviceMemory || 4;
		const mobile = /android|iphone|ipad|ipod|mobile/.test(ua);
		const chromebook = /cros/.test(ua);
		if (mobile || chromebook || cores <= 2 || mem <= 2) return 'low';
		if (cores <= 4 || mem <= 4) return 'medium';
		return 'high';
	}
	catch (e) { return 'medium'; }
}

export function resolvePreset(s: RealismSettings, name?: string): { name: string, p: PerformancePreset }
{
	let n = name || s.performance.preset || 'auto';
	if (n === 'auto') n = detectPreset();
	if (!s.performance.presets[n]) n = 'medium';
	const p: PerformancePreset = deepMerge(s.performance.presets[n], s.performance.overrides || {});
	return { name: n, p: p };
}

export function scaleVec(s: number | number[] | undefined): number[]
{
	if (s === undefined || s === null) return [1, 1, 1];
	if (typeof s === 'number') return [s, s, s];
	return [s[0] === undefined ? 1 : s[0], s[1] === undefined ? 1 : s[1], s[2] === undefined ? 1 : s[2]];
}
