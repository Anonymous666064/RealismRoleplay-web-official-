/*
 * realism-config.js  -  San Verano County settings
 * ================================================
 * Loaded by index.html BEFORE build/sketchbook.min.js. No rebuild needed:
 * edit, save, hard refresh (Ctrl+Shift+R).
 *
 * Everything is optional. Anything you leave out keeps its default.
 * Paths are relative to index.html, e.g. 'build/assets/props/hydrant.glb'.
 *
 * Asset override fields (city.props, house.furniture):
 *   model      : path to your .glb
 *   scale      : 1.5  or  [x, y, z]
 *   rotation   : [x, y, z] degrees, fixes models exported facing the wrong way
 *   offset     : [x, y, z] metres (y = up), e.g. sink a model into the ground
 *   castShadow : true / false (false is faster)
 *   disabled   : true hides that asset everywhere
 *
 * Built-in assets face +Z (towards the road / into the room) and stand on y = 0.
 * Export your model the same way, or fix it with rotation / offset.
 */
window.REALISM_CONFIG = {
	// If a .glb 404s on your server, the game tries /build/assets/... and then this URL + the path.
	// Default is your GitHub repo through the jsDelivr CDN. Set to '' to turn the fallback off.
	assetFallbackUrl: 'https://cdn.jsdelivr.net/gh/Anonymous666064/RealismRoleplay@main/Sketchbook-master/',

	// Optional in-car MDT GLB. Position/rotation are in police-car local space; rotation is degrees.
	// Leave model empty to use the built-in laptop. Adjust position/scale to fit your vehicle model.
	police: {
		mdtLaptop: {
			model: '', // e.g. 'build/assets/police_mdt_laptop.glb'
			position: [0, 0.62, 0.62],
			rotation: [0, 180, 0],
			scale: 0.72,
		},
	},

	// Character model fitting (all measurements are metres in-game; no build required).
	// height is the desired standing model height. scale is an extra visual multiplier.
	// y and seatedY are vertical offsets in metres. seatedScale multiplies the standing
	// visual scale while seated. Tweak each gender independently to fit your supplied GLB.
	player: {
		models: {
			male: {
				height: 1.70,
				scale: 1.0,
				y: 0,
				seatedScale: 0.72,
				seatedY: 0,
			},
			female: {
				height: 1.68,
				scale: 0.01,
				y: 0,
				seatedScale: 0.72,
				seatedY: 0,
			},
			femaleAthlete: {
				height: 1.70,
				scale: 1.0,
				y: 0,
				seatedScale: 0.72,
				seatedY: 0,
			},
		},
	},

	// Same seed = same map. Change it for a different county layout.
	seed: 1337,

	// ---------------------------------------------------------------- performance
	performance: {
		// 'auto' picks low on phones / Chromebooks, medium on laptops, high on desktops.
		// Or force one: 'low' | 'medium' | 'high' | 'ultra'
		preset: 'auto',

		// Tweak any preset value on top of the chosen preset, e.g.
		//   pixelRatio: 1        highest render resolution multiplier (0.75 = faster, blurrier)
		//   shadows: false
		//   fxaa: false
		//   viewDistance: 600    metres (fog + camera far plane)
		//   buildingDistance, treeDistance, detailDistance, interiorDistance: metres
		//   pointLights: 4       real lights moved to the nearest lamps / rooms (0 = none)
		//   water: 'simple'      flat water instead of the animated ocean shader
		//   interiors: false     hide furniture entirely
		//   trafficLights: false stop animating the signals
		//   lighting: 'lambert'  cheap per-vertex lighting (low/medium) | 'phong' per-pixel (high/ultra)
		//   bakedShadows: true   ray-cast sun shadows baked into ground + roads at load (free per frame)
		//   shadowMapSize: 1024  realtime shadow resolution, only when shadows: true
		overrides: {},

		// Frame-rate governor: holds this FPS by lowering shadows, water, lights, resolution
		// and view distance step by step, and restores them when there is headroom.
		targetFps: 30,
		adaptive: true,

		// Small FPS / draw-call readout in the bottom-left corner ("Realism v3" = new build loaded).
		showFps: true,

		// Colour strength of the city, roads and terrain (0.2 to 1.2). Sketchbook's sun is strong,
		// so higher values wash everything out to white. Also a live slider in Realism Graphics.
		brightness: 0.55,

		// Free the graphics memory of everything far past its view distance (buildings, trees,
		// props, your .glb models...). It is uploaded again when you come back.
		unloadFar: true,
		unloadMargin: 80,   // metres past the view distance before unloading (stops flicker at the edge)

		// Old 'Realism Graphics' folder in the top-right developer menu. The in-game Settings menu
		// (start screen / pause menu) replaces it. Settings changed there are saved in the browser
		// (localStorage) and win over the values in this file.
		showPanel: false,
	},

	// ---------------------------------------------------------------- day / night
	dayNight: {
		enabled: true,        // false = the clock stands still at startHour
		cycleMinutes: 24,     // real minutes for one full game day (24 = one game hour per real minute)
		startHour: 12,        // game time when the world starts, 0..24 (12 = noon, 21.5 = 9:30 PM)
		nightBrightness: 0.35, // 0.05..1, moonlight + ambient at night (higher = brighter nights)
		windowsAtNight: true, // office / shop windows glow at night (free: no extra draw calls)
	},

	// ---------------------------------------------------------------- city
	city: {
		streetLights: true,
		trafficLights: true,
		stopSigns: true,
		hydrants: true,
		benches: true,
		trashCans: true,
		gangNeighborhoods: true,
		trafficCycle: 24,          // seconds for a full signal cycle

		// Swap built-in street furniture for your own models.
		// Names: streetLight, trafficLight, stopSign, fireHydrant, bench, trashCan, dumpster,
		//        chainLinkFence, wreckedCar, trashBag, tire, mattress, barrier, picnicTable,
		//        telescope, flagpole, infoBoard, hoop, weightBench, bleacher, policeCar,
		//        tree, pineTree, hedge, bush
		// (For trees / bushes / hedges the 'vegetation' section below is easier and wins
		//  when both are set.)
		props: {
			// fireHydrant:  { model: 'build/assets/props/hydrant.glb', scale: 1.0 },
			// stopSign:     { model: 'build/assets/props/stop_sign.glb', scale: [1, 1.1, 1], rotation: [0, 180, 0] },
			// streetLight:  { model: 'build/assets/props/light_pole.glb', scale: 1.2, castShadow: false },
			// trafficLight: { model: 'build/assets/props/traffic_light.glb', scale: 1 },
			//   (your traffic light model is static; the built-in red/yellow/green lenses still animate on top)
			// wreckedCar:   { disabled: true },
		},

		// Replace generated buildings with your own models.
		// match fields: label (sign text, e.g. 'DINER'), kind (house, shop, office, apartment,
		// warehouse, civic, farm ...), district (e.g. 'hood'), style.
		// fit: true stretches the model to the building's footprint and height.
		// collider: 'box' (fast) | 'trimesh' (walk inside your model) | 'none'
		buildingModels: [
			// { match: { label: 'DINER' }, model: 'build/assets/buildings/diner.glb', fit: true, collider: 'trimesh' },
			// { match: { kind: 'shop', district: 'hood' }, model: 'build/assets/buildings/corner_store.glb', fit: true, chance: 0.5 },
		],

		// Place any model anywhere. position: [x, z] sits on the ground, [x, y, z] is exact.
		extraModels: [
			// { model: 'build/assets/props/billboard.glb', position: [150, 530], rotationY: 90, scale: 2, collider: 'box' },
		],
	},

	// ---------------------------------------------------------------- vegetation
	// Trees, bushes and hedges. Everything is placed for you: hedges go along the FRONT of
	// houses / apartments / offices / shops (gaps left at doors, porches, paths, driveways,
	// entrance steps) and along their SIDES, bushes under windows, in yards, parks and along
	// roads, trees where the map puts them. You never place them one by one.
	//
	// To use YOUR OWN models:
	//   1. Put the .glb files in your project, e.g. build/assets/nature/oak.glb
	//   2. Add the path to a list below:  { model: 'build/assets/nature/oak.glb', scale: 1 }
	//   3. Save and hard refresh (Ctrl+Shift+R). Done.
	// The game measures each model when it loads, stands it on the ground (the origin in
	// Blender doesn't matter), merges its meshes for speed and swaps it in everywhere.
	// Add several entries to a list to mix variants: each tree / bush / hedge picks one, the
	// same one every time for the same seed. An empty list [] keeps the built-in model.
	//
	//   scale      trees / bushes: size x the model's real size (1 = as exported,
	//              0.01 for a model exported in centimetres).
	//              hedges: height / depth x the built-in hedge (1 = about 1 m tall);
	//              the LENGTH is automatic: the model is repeated and stretched to fill
	//              every hedge exactly. [x, y, z] also works (x = length of one hedge tile).
	//   rotation   [x, y, z] degrees, for models exported lying down / facing the wrong way.
	//              (A hedge model made along Z is turned to run along X by itself.)
	//   offset     [x, y, z] metres, e.g. [0, -0.1, 0] sinks it a little into the ground
	//              (hedges only use y).
	//   collider   trees / hedges: true (trunk box / hedge box, default). bushes: false (default).
	//   castShadow true / false (false is faster with realtime shadows on).
	//   weight     how often this variant is picked compared to the others (default 1).
	// Keep vegetation models light (under ~3,000 triangles) for Chromebooks: there are
	// thousands of copies. A model that fails to load falls back to the built-in one
	// (see the browser console, F12, for "[Realism]" messages).
	vegetation: {
		enabled: true,              // false = no hedges / bushes and no custom models

		// Round, leafy trees (parks, yards, street trees downtown)
		trees: [
			{ model: 'build/assets/vegetation/japanese_cherry_tree.glb',   scale: 0.2 }
		],
		// Conifers (hills, countryside)
		pineTrees: [
			{ model: 'build/assets/vegetation/leaf_tree_-_ps1_low_poly.glb', scale: 1.0 }
		],
		bushes: [
			{ model: 'build/assets/vegetation/low_poly_stylized_2d_grass.glb', scale: 70.0}
		],
		hedges: [
			{ model: 'build/assets/vegetation/hedge.glb', scale: 1.0 }
			
		],

		// How much of each: 0 = none, 1 = normal, up to 2 = more. Trees can only go down (0 to 1).
		density: { trees: 1, bushes: 2, hedges: 1 },

		frontHedges: true,          // hedges along building fronts / front yards
		sideHedges: true,           // hedges along building sides / lot lines

		randomScale: 0.15,          // trees and bushes vary +/- 15% in size

		// Level of detail for trees: only the trees NEAREST to you use your .glb model, every other
		// tree uses the built-in low-poly model (that's what you see in the distance). As you move,
		// the nearest trees switch over. A model is only downloaded when one of its trees first gets
		// this close, so pine models load when you reach the pine areas, and a model with no tree
		// near you for 30 s frees its graphics memory.
		nearModels: 10,     // how many trees use your model at once (0 = never use your models)
		nearDistance: 120,  // metres: farther trees always stay low-poly
	},

	// ---------------------------------------------------------------- houses
	house: {
		interiors: true,

		// Replace generated houses with your own (picked per house, use chance to mix).
		models: [
			// { match: { kind: 'house' }, model: 'build/assets/houses/house_a.glb', fit: true, collider: 'trimesh', chance: 0.3 },
			// { match: { kind: 'house', district: 'hood' }, model: 'build/assets/houses/trap_house.glb', fit: true, collider: 'trimesh' },
		],

		// Swap furniture for your own models.
		// Names: fridge, stove, counter, sink, diningTable, chair, couch, armchair, coffeeTable,
		//        tv, tvStand, rug, floorLamp, bookshelf, bed, nightstand, wardrobe, dresser,
		//        toilet, bathSink, bathtub, desk, officeChair, shelf, checkout, cooler, booth,
		//        barStool, bunkBed, locker, plant, mattress, trashBag (and more in RealismInteriors.ts)
		furniture: {
			// fridge: { model: 'build/assets/furniture/fridge.glb', scale: 1 },
			// tv:     { model: 'build/assets/furniture/tv_55.glb', scale: 0.9, rotation: [0, 180, 0] },
			// couch:  { model: 'build/assets/furniture/couch.glb', scale: 1.05 },
		},

		// Wall paint palettes, rgb 0..1
		// wallColors: [[0.95, 0.94, 0.9], [0.9, 0.85, 0.72]],
		// hoodWallColors: [[0.62, 0.58, 0.5]],
	},

	// ---------------------------------------------------------------- vehicles
	vehicles: {
		// car / heli / airplane are the stock Sketchbook vehicles. Add your own:
		//  base:             'car' | 'heli' | 'airplane'  (which handling / seats it uses)
		//  model:            your .glb
		//  sketchbookFormat: true  -> made with Sketchbook's Blender add-on (wheels, seats, collision inside).
		//                    false -> any .glb: the stock vehicle drives, your model is shown on top.
		//  scale / rotation / offset: fit your body over the stock vehicle (sketchbookFormat false only)
		//  keepBaseWheels:   show the stock wheels under your body (default true)
		types: {
			// policeCruiser: { base: 'car', model: 'build/assets/vehicles/cruiser.glb', sketchbookFormat: false, scale: 1.0, rotation: [0, 180, 0], offset: [0, -0.3, 0] },
			// suv:           { base: 'car', model: 'build/assets/vehicles/suv_sketchbook.glb', sketchbookFormat: true },
			// newsHeli:      { base: 'heli', model: 'build/assets/vehicles/news_heli.glb', sketchbookFormat: false, scale: 1.1 },
		},

		// Where they appear. scenario: downtown | police | sheriff | hospital | airport | port |
		// dealer | suburbs | hood | flats | lookout | prison, or 'all'.
		// position: [x, z] on the ground or [x, y, z] (world metres; the map spans -1024..1024).
		spawns: [
			// { vehicle: 'policeCruiser', scenario: 'police', position: [256, 580], rotationY: 90 },
			// { vehicle: 'car', scenario: 'all', position: [150, 530] },
		],
	},

	// ---------------------------------------------------------------- NPCs
	// People walk the sidewalks and crosswalks, shop and go home. NPC homes are private (locked).
	// Their parked cars can be stolen with F; a stolen car is yours and is saved where you leave it.
	npcs: {
		enabled: true,
		density: 1,        // 0..2 (also in the in-game Settings, which wins once changed there)
		maxVisible: 20,    // people drawn at once (default 16 on low, 20 medium, 26 high)
		parkedCars: true,
		// residents: 3,     // people per NPC home at density 1 (raise for busier streets)
		// radius: 135,      // metres around the player where people are drawn
		// homeShare: 0.55,  // share of ordinary houses that become private NPC homes
		// carShare: 0.6,    // share of NPC homes with a car out front
		// maxRealCars: 3,   // drivable cars spawned near the player at once
		// carAlarm: true,
		// crosswalks: true, // paint crosswalk stripes at junctions
	},

	// ---------------------------------------------------------------- weapons
	// Tab: weapon wheel (hold, point with the mouse, release or click; a quick tap keeps it open).
	// 1-5: switch directly. Right mouse: aim. Left mouse: fire. R: reload.
	weapons: {
		// slots: ['fists', 'pistol', 'smg', 'shotgun', 'rifle'],   // up to 5, in wheel order (1 = top, clockwise)
		// scale: 0.62,            // weapon size vs real size (the character is about 1.05 m tall)
		// volume: 1,              // weapon sound volume (also follows the game's master volume)
		// infiniteAmmo: false,
		// muzzleLight: 'auto',    // true | false | 'auto' (no flash light on the 'low' preset)
		// tracers: true,
		// decals: 24,             // bullet holes kept at once (0 = none)
		// aimFov: 0.82,           // zoom while aiming (field of view multiplier)
		// aimDistance: 1.05,      // camera distance while aiming
		// shoulder: [0.42, 0.16], // camera offset while aiming: right, up
		// handRotation: [-90, 0, 0],  // degrees: how the gun sits in the hand when not aiming

		// Per weapon: name, damage, fireRate (rounds per minute), auto, magazine, reserve,
		// reloadTime (s), spread / aimSpread (degrees), range (m), recoil (degrees), pellets, impulse, flashSize (m)
		// Your model: model (.glb, barrel pointing +Z, grip at the origin, real size in metres),
		//             scale, rotation [x, y, z] degrees, offset [x, y, z] metres, muzzle [x, y, z] (barrel end).
		// Your sounds: sounds: { shot: 'x.mp3', reload: 'x.mp3', empty: 'x.mp3' }  (built-in sounds otherwise)
		pistol:  {
			// damage: 26, fireRate: 360, magazine: 12, reserve: 72, reloadTime: 1.4,
			// model: 'build/assets/weapons/pistol.glb', scale: 1, rotation: [0, 0, 0], offset: [0, 0, 0], muzzle: [0, 0.055, 0.165],
			// sounds: { shot: 'build/assets/sounds/pistol_shot.mp3', reload: 'build/assets/sounds/pistol_reload.mp3' },
		},
		smg:     {
			// damage: 17, fireRate: 850, auto: true, magazine: 30, reserve: 180,
			// model: 'build/assets/weapons/smg.glb', scale: 1, rotation: [0, 0, 0], offset: [0, 0, 0],
		},
		shotgun: {
			// damage: 14, pellets: 8, fireRate: 70, magazine: 6, reserve: 36, reloadTime: 2.6,
			// model: 'build/assets/weapons/shotgun.glb', scale: 1, rotation: [0, 0, 0], offset: [0, 0, 0],
		},
		rifle:   {
			// name: 'AR-15', damage: 34, fireRate: 600, auto: true, magazine: 30, reserve: 180, range: 220,
			// model: 'build/assets/weapons/rifle.glb', scale: 1, rotation: [0, 0, 0], offset: [0, 0, 0],
		},
		// Your own weapon: give it a kind (pistol | smg | shotgun | rifle | fists) and put it in slots.
		// revolver: { kind: 'pistol', name: 'Revolver', damage: 45, fireRate: 150, magazine: 6, reserve: 36, recoil: 4 },
	},
};
