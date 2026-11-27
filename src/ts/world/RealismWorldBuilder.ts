/*
 * RealismWorldBuilder.ts  (v2)
 * ----------------------------
 * Turns the San Verano County map data (RealismMapData.ts) into a playable
 * Sketchbook world: terrain, roads, water, buildings with real interiors,
 * furniture, street lights, traffic lights, stop signs, gang neighbourhoods,
 * detailed police / sheriff / prison / lookout, trees, your own .glb assets,
 * vehicle spawns and the performance manager.
 *
 * Usage (index.html):   const world = new Sketchbook.World('realism');
 * Optional seed:        const world = new Sketchbook.World('realism:42');
 * Settings:             realism-config.js  (window.REALISM_CONFIG, see RealismConfig.ts)
 */

import * as THREE from 'three';
import * as CANNON from 'cannon';
import { World } from './World';
import { LoadingManager } from '../core/LoadingManager';
import { Ocean } from './Ocean';
import { IUpdatable } from '../interfaces/IUpdatable';
import { generateRealismMap, MapData, Road, HALF, GRID_RES, CELL, VERTS } from './RealismMapData';
import { loadRealismSettings, resolvePreset, AssetOverride } from './RealismConfig';
import { RealismCtx, RENDER_CHUNK, chunkKey, PhysicsChunks, CullRegistry, addMesh, instMat } from './RealismContext';
import { GeoAccum, AccumSet } from './RealismGeometry';
import { createMaterials } from './RealismMaterials';
import { BuildingBuilder, ensureGlassMaterial } from './RealismBuildings';
import { AssetInstancer, placeExtraModels, loadGLB, bakeParts, overrideMatrix } from './RealismAssets';
import { defineStreetAssets, buildStreet } from './RealismStreet';
import { buildInteriors } from './RealismInteriors';
import { installInteractionSink, InteractionSystem } from './RealismInteractions';
import { RealismNeeds } from './RealismNeeds';
import { RealismSwim } from './RealismSwim';
import { LandmarkBuilder } from './RealismLandmarks';
import { RealismPerformance, WaterSet } from './RealismPerformance';
import { assignHotels, HotelBuilder } from './RealismHotels';
import { buildVegetation } from './RealismVegetation';
import { TreeLOD } from './RealismTreeLOD';
import { VegModelSet, VegEntry, PreparedModel, ChunkInstances, VARIANT_STRIDE, hash01, lateColliders, vegSettings, vegModelStats } from './RealismVegetationModels';
import { buildHoodDetails } from './RealismHoodDetails';
import { DoorSystem } from './RealismDoors';
import { buildNPCs, loadSharedModel } from './RealismNPCs';
import { SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils';
import { attachRealismUI } from './RealismUI';
import { buildCarLights } from './RealismCarLights';
import { buildTraffic } from './RealismTraffic';
import { WeaponSystem } from './RealismWeapons';

import { buildEconomy } from './RealismEconomy';
import { VehicleTuning } from './RealismVehicleTuning';
import { PoliceSystem } from './RealismPolice';
import { ModShop } from './RealismModShop';
import { RealismPlayer } from './RealismPlayer';
import { FirstPersonCamera } from './RealismFirstPerson';
import { ensureEvents } from './RealismEvents';
import { ensurePrompts } from './RealismPrompts';
import { hudSettings } from './RealismGPS';
import { buildHud } from './RealismMinimap';
import { buildInternet } from './RealismLaptop';
import { buildLegalJobs } from './RealismJobsLegal';
import { buildIllegal } from './RealismIllegal';
import { RealismLawEnforcement } from './RealismLawEnforcement';
const PHYS_CHUNK = 128;     // metres, compound static colliders (terrain props, trees, lamps)
const BPHYS_CHUNK = 64;     // metres, building shells (many small boxes)

export const REALISM_VERSION = 'v14';

export function buildRealismWorld(world: World, seed?: number): void
{
	console.log('%c[Realism] San Verano County ' + REALISM_VERSION + ' build loaded', 'color:#2a7;font-weight:bold');
	const loadingManager = new LoadingManager(world);
	// Give the loading screen a frame to appear before the (synchronous) generation runs.
	setTimeout(() =>
	{
		const t0 = Date.now();
		const cfg = loadRealismSettings(seed);
		const preset = resolvePreset(cfg);
		const data = generateRealismMap(cfg.seed);
		assignHotels(data);   // hotels: pick sites, mark custom = 'hotel'
		for (const hb of data.buildings) if (hb.custom === 'hotel') hb.closed = false;
		console.log('[Realism] San Verano County generated (seed ' + cfg.seed + ', preset ' + preset.name + ')', data.stats);

		const w: any = world;
		w.worldBounds = { half: HALF - 4, minY: -40 };
		w.respawnPosition = new CANNON.Vec3(data.respawn.x, data.respawn.y, data.respawn.z);
		w.realismMap = data;
		w.realismSettings = cfg;
		w.realismVehicleTypes = cfg.vehicles.types;
		w.realismLoadPlayerModel = (gender: string, done: (model: any) => void, failed?: () => void): void =>
		{
			const path = gender === 'female' ? 'build/assets/characters/female.glb' : 'build/assets/characters/male.glb';
			loadSharedModel(path, (gltf) =>
			{
				done({ scene: SkeletonUtils.clone(gltf.scene), animations: gltf.animations || [] });
			}, failed);
		};
		w.realismLoadVehicleModel = (type: string, done: (model: THREE.Object3D) => void, failed?: () => void): void =>
		{
			const vehicleTypes: any = cfg.vehicles.types || {};
			const definition = Object.prototype.hasOwnProperty.call(vehicleTypes, type) ? vehicleTypes[type] : null;
			const configuredModel = definition && typeof definition.model === 'string' ? definition.model : '';
			const configuredBase = definition && typeof definition.base === 'string' ? definition.base : type;
			const base = ['car', 'heli', 'airplane'].indexOf(configuredBase) >= 0 ? configuredBase : 'car';
			const basePath = definition && definition.sketchbookFormat !== false && configuredModel
				? configuredModel
				: 'build/assets/' + base + '.glb';
			const cloneScene = (gltf: any): THREE.Object3D =>
			{
				const model = gltf.scene.clone(true);
				model.traverse((node: any) =>
				{
					if (!node.isMesh || !node.material) return;
					node.material = Array.isArray(node.material) ? node.material.map((material: THREE.Material) => material.clone()) : node.material.clone();
				});
				return model;
			};
			loadSharedModel(basePath, (gltf) =>
			{
				const model = cloneScene(gltf);
				if (!definition || definition.sketchbookFormat !== false || !configuredModel)
				{
					done(model);
					return;
				}
				loadSharedModel(configuredModel, (bodyGltf) =>
				{
					const wrapper = new THREE.Group();
					wrapper.applyMatrix4(overrideMatrix(definition));
					wrapper.add(cloneScene(bodyGltf));
					model.add(wrapper);
					done(model);
				}, failed);
			}, failed);
		};

		world.graphicsWorld.fog = new THREE.Fog(0xbccfe0, 380, 1000);

		const ctx: RealismCtx = {
			world: world, data: data, cfg: cfg, preset: preset.p, presetName: preset.name,
			mats: createMaterials(world, preset.p.lighting, cfg.performance.brightness),
			phys: new PhysicsChunks(world, PHYS_CHUNK),
			bphys: new PhysicsChunks(world, BPHYS_CHUNK),
			cull: new CullRegistry(),
			dynamic: [],
			lightSpots: [],
		};
		ensureGlassMaterial(ctx);
		ctx.doors = new DoorSystem(ctx);
		ensureEvents(world);                               // w.realismEvents (C14)
		ensurePrompts(world, hudSettings(ctx).prompts);    // w.realismPrompt (C7), before anyone offers an interaction
		const interactionStore = installInteractionSink(ctx);   // furniture anchors are collected while interiors / hotels build

		const baker = ctx.preset.bakedShadows ? new SunBaker(ctx) : null;
		buildTerrain(ctx, baker);
		const water = buildWater(ctx);
		const roadPhys = new PhysicsChunks(world, 64);
		buildRoads(ctx, roadPhys, baker);
		buildJunctions(ctx, baker);

		// buildings: exteriors + hollow shells with rooms
		const buildings = new BuildingBuilder(ctx);
		buildings.build();

		// street furniture, traffic lights, props
		const city = new AssetInstancer(ctx, cfg.city.props);
		defineStreetAssets(ctx, city);
		const signals = buildStreet(ctx, city);

		// furniture inside every enterable building
		const furniture = new AssetInstancer(ctx, cfg.house.furniture);
		const furnished = buildInteriors(ctx, buildings.plans, furniture);

		// police, sheriff, prison, lookout details
		const landmarks = new LandmarkBuilder(ctx, city, furniture);
		landmarks.build(buildings.plans);
		new HotelBuilder(ctx).build();   // hotels (lobby, stairs, lazy guest floors)
		ctx.doors.finalize();

		city.build();
		furniture.build();
		ctx.dynamic.push(furniture);
		buildTrees(ctx);
		placeExtraModels(ctx, cfg.city.extraModels);
		const hoodDetails = buildHoodDetails(ctx);
		const vegetation = buildVegetation(ctx);

		ctx.phys.commit();
		ctx.bphys.commit();
		roadPhys.commit();
		buildTerrainCollider(ctx);

		if (signals) world.registerUpdatable(signals);
		world.registerUpdatable(ctx.doors);
		w.realismDoors = ctx.doors;
		buildNPCs(ctx, signals);   // pedestrians, NPC homes, parked / stolen cars (RealismNPCs.ts)
		const perf = new RealismPerformance(ctx, water, signals);
		try { buildTraffic(ctx, signals); }   // NPC traffic on the road lanes, carjacking (RealismTraffic.ts); sets w.realismTraffic
		catch (e) { console.warn('[Realism] traffic failed to build', e); }
		world.registerUpdatable(perf);
		w.realismPerformance = perf;
		w.realismCtx = ctx;
		world.registerUpdatable(new RealismPlayer(ctx));       // player.scale on every Character; sets w.realismPlayerScale (C5)
		world.registerUpdatable(new WeaponSystem(ctx));   // weapons, wheel (Tab), aiming, audio; sets w.realismWeapons

		buildEconomy(ctx);   // money, bank card, jobs (RealismEconomy.ts, RealismJobs.ts); sets w.realismEconomy, w.realismJob
		const tuning = new VehicleTuning(ctx);          // paint / suspension / handling / engine / brakes; sets w.realismVehicleTuning
		world.registerUpdatable(tuning);
		const police = new PoliceSystem(ctx, tuning);   // police / sheriff livery, spawnUnit, ELS; sets w.realismPolice
		w.realismPoliceSystem = police;
		world.registerUpdatable(police);
		world.registerUpdatable(new ModShop(ctx, tuning));   // mod shop bay at the mechanic; sets w.realismModShop
		try { buildCarLights(ctx); }   // head / tail / brake / reverse lights, indicators, hazards; sets w.realismCarLights
		catch (e) { console.warn('[Realism] car lights failed to build', e); }
		world.registerUpdatable(new FirstPersonCamera(ctx));   // V first / third person; sets w.realismFirstPerson (C6)
		try { buildHud(ctx, hudSettings(ctx)); }   // GPS + blips (C8), minimap, full-screen map (M)
		catch (e) { console.warn('[Realism] minimap / GPS failed to build', e); }
		world.registerUpdatable(new RealismNeeds(ctx));        // hunger / thirst / energy / hygiene / bladder + HUD (C11)
		world.registerUpdatable(new InteractionSystem(ctx, interactionStore, furniture));   // beds, seats, toilet, shower, fridge, stove, lights, laptop
		world.registerUpdatable(new RealismSwim(ctx));         // swimming in the sea / lake
		buildInternet(ctx);   // laptop OS + websites, social media, properties (C9, C10)
		try { buildLegalJobs(ctx); }   // DOT / construction / electrician / community service, inventory (C13)
		catch (e) { console.warn('[Realism] legal jobs failed to build', e); }
		try { buildIllegal(ctx); }   // hotwire (C12), chop shop, hideouts, Lean / Weed / Coke jobs, clubs
		catch (e) { console.warn('[Realism] illegal content failed to build', e); }
		const summary = {
			ms: Date.now() - t0,
			buildings: buildings.stats,
			interiors: buildings.plans.length,
			furnitureItems: furnished,
			furnitureInstances: furniture.instanceCount,
			streetInstances: city.instanceCount,
			trafficApproaches: signals ? signals.count : 0,
			landmarks: landmarks.stats,
			hoodDetails: hoodDetails,
			vegetation: vegetation,
			doors: ctx.doors.stats,
			lightSpots: ctx.lightSpots.length,
			cullEntries: ctx.cull.entries.length,
			staticShapes: ctx.phys.shapeCount + ctx.bphys.shapeCount + roadPhys.shapeCount,
			roadColliders: roadPhys.shapeCount,
			bakedShadows: !!baker,
			version: REALISM_VERSION,
		};
		w.realismSummary = summary;
		console.log('[Realism] World built', summary);

		attachRealismUI(world, ctx, loadingManager);   // menus, settings, phone, day / night
		new RealismLawEnforcement(ctx);   // local police equipment, reports, radio and dispatch
		buildScenarios(ctx, loadingManager);
	}, 50);
}

// ---------------------------------------------------------------------------

function buildScenarios(ctx: RealismCtx, loadingManager: LoadingManager): void
{
	const data = ctx.data, world = ctx.world;
	const spawns = ctx.cfg.vehicles.spawns || [];
	// Sketchbook scenarios: same structure a Blender scene would export
	const root = new THREE.Group();
	root.name = 'realism_scenarios';
	for (let i = 0; i < data.scenarios.length; i++)
	{
		const sc = data.scenarios[i];
		const node = new THREE.Object3D();
		node.name = sc.id;
		node.userData = {
			data: 'scenario', name: sc.name, desc_title: sc.title, desc_content: sc.desc,
			camera_angle: sc.camAngle, default: sc.isDefault ? 'true' : 'false',
		};
		const addSpawn = (type: string, x: number, y: number, z: number, rot: number, driver?: string) =>
		{
			const sp = new THREE.Object3D();
			sp.name = sc.id + '_spawn_' + node.children.length;
			sp.position.set(x, y, z);
			sp.rotation.y = rot;
			sp.userData = { data: 'spawn', type: type };
			if (driver) sp.userData.driver = driver;
			node.add(sp);
		};
		for (let k = 0; k < sc.spawns.length; k++)
		{
			const s = sc.spawns[k];
			addSpawn(s.type, s.x, s.y, s.z, s.rot, s.driver);
		}
		// your own vehicle spawns (realism-config.js -> vehicles.spawns)
		for (let k = 0; k < spawns.length; k++)
		{
			const vs = spawns[k];
			if (!vs || !vs.vehicle || !vs.position) continue;
			if (vs.scenario !== 'all' && vs.scenario !== sc.id) continue;
			if (!ctx.cfg.vehicles.types[vs.vehicle] && ['car', 'heli', 'airplane'].indexOf(vs.vehicle) < 0)
			{
				if (i === 0) console.warn('[Realism] vehicles.spawns: unknown vehicle "' + vs.vehicle + '"');
				continue;
			}
			const x = vs.position[0], z = vs.position.length > 2 ? vs.position[2] : vs.position[1];
			const y = vs.position.length > 2 ? vs.position[1] : data.heightAt(x, z) + 0.6;
			addSpawn(vs.vehicle, x, y, z, (vs.rotationY || 0) * Math.PI / 180, vs.driver);
		}
		root.add(node);
	}
	root.updateMatrixWorld(true);
	world.loadScene(loadingManager, { scene: root });
}

function buildWater(ctx: RealismCtx): WaterSet
{
	const world = ctx.world, data = ctx.data;
	const out: WaterSet = { meshes: [], shaderMats: [], oceans: [], simple: null };
	const sea = new THREE.Mesh(new THREE.PlaneBufferGeometry(8000, 8000, 1, 1), new THREE.MeshBasicMaterial());
	sea.rotation.x = -Math.PI / 2;
	sea.position.y = 0;
	world.graphicsWorld.add(sea);
	const o1 = new Ocean(sea, world);
	world.registerUpdatable(o1);

	const lake = new THREE.Mesh(new THREE.CircleBufferGeometry(1, 64), new THREE.MeshBasicMaterial());
	lake.rotation.x = -Math.PI / 2;
	lake.scale.set(data.lake.rx * 1.12, data.lake.rz * 1.12, 1);
	lake.position.set(data.lake.x, data.lake.level, data.lake.z);
	world.graphicsWorld.add(lake);
	const o2 = new Ocean(lake, world);
	world.registerUpdatable(o2);

	out.meshes = [sea, lake];
	out.shaderMats = [sea.material as THREE.Material, lake.material as THREE.Material];
	out.oceans = [o1 as IUpdatable, o2 as IUpdatable];
	out.simple = new THREE.MeshPhongMaterial({ color: 0x2f6f86, specular: 0x557788, shininess: 60, transparent: true, opacity: 0.88 });
	world.sky.csm.setupMaterial(out.simple);
	return out;
}

/** Swaps the built-in trees for your own models (city.props.tree / city.props.pineTree). */
function swapTreeModels(ctx: RealismCtx, treeMeshes: { mesh: THREE.InstancedMesh, list: number[], variant: number, user?: number }[], props: { [name: string]: AssetOverride }): void
{
	const names = ['tree', 'pineTree'];
	for (let n = 0; n < names.length; n++)
	{
		const name = names[n];
		const ov = props ? props[name] : undefined;
		if (!ov) continue;
		const mine = treeMeshes.filter((t) => t.mesh.userData.treeGroup === name);
		if (ov.disabled) { mine.forEach((t) => { t.mesh.visible = false; t.mesh.userData.realismRemoved = true; }); continue; }
		if (!ov.model) continue;
		loadGLB(ov.model, (scene) =>
		{
			const parts = bakeParts(ctx, scene, overrideMatrix(ov), ov.castShadow !== false);
			if (parts.length === 0) return;
			const m = new THREE.Matrix4();
			for (let i = 0; i < mine.length; i++)
			{
				const old = mine[i].mesh;
				const bs = old.geometry.boundingSphere;
				for (let k = 0; k < parts.length; k++)
				{
					const mesh = new THREE.InstancedMesh(parts[k].geom.clone(), instMat(ctx, parts[k].mat), old.count);
					for (let j = 0; j < old.count; j++) { old.getMatrixAt(j, m); mesh.setMatrixAt(j, m); }
					mesh.instanceMatrix.needsUpdate = true;
					mesh.geometry.boundingSphere = bs.clone();
					mesh.castShadow = ov.castShadow !== false;
					mesh.receiveShadow = true;
					ctx.world.graphicsWorld.add(mesh);
					ctx.cull.add(mesh, 'tree', bs.center, bs.radius);
				}
				old.visible = false;
				old.userData.realismRemoved = true;
				ctx.world.graphicsWorld.remove(old);
			}
			console.log('[Realism] Using your model for "' + name + '": ' + ov.model);
		});
	}
}

// --- Terrain -------------------------------------------------------------------

function buildTerrain(ctx: RealismCtx, baker: SunBaker): void
{
	const CH = 64;  // cells per chunk
	const data = ctx.data;
	const H = data.heights;
	for (let cz = 0; cz < GRID_RES / CH; cz++)
	{
		for (let cx = 0; cx < GRID_RES / CH; cx++)
		{
			const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
			for (let j = 0; j <= CH; j++)
			{
				for (let i = 0; i <= CH; i++)
				{
					const gx = cx * CH + i, gz = cz * CH + j;
					const x = -HALF + gx * CELL, z = -HALF + gz * CELL;
					const h = H[gz * VERTS + gx];
					const hxa = H[gz * VERTS + Math.max(gx - 1, 0)], hxb = H[gz * VERTS + Math.min(gx + 1, VERTS - 1)];
					const hza = H[Math.max(gz - 1, 0) * VERTS + gx], hzb = H[Math.min(gz + 1, VERTS - 1) * VERTS + gx];
					let nx = -(hxb - hxa) / (2 * CELL), ny = 1, nz = -(hzb - hza) / (2 * CELL);
					const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
					nx /= nl; ny /= nl; nz /= nl;
					pos.push(x, h, z); nor.push(nx, ny, nz); uv.push(x / 6, z / 6);
					const o = (gz * VERTS + gx) * 3;
					col.push(data.colors[o], data.colors[o + 1], data.colors[o + 2]);
				}
			}
			const row = CH + 1;
			for (let j = 0; j < CH; j++)
			{
				for (let i = 0; i < CH; i++)
				{
					const a = j * row + i, b = a + 1, c = a + row + 1, d = a + row;
					// Same diagonal as the cannon.js heightfield so visuals match collisions
					idx.push(a, c, b, a, d, c);
				}
			}
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
			g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
			g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
			g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
			g.setIndex(new THREE.Uint16BufferAttribute(idx, 1));
			g.computeBoundingSphere();
			if (baker) baker.shade(g);
			addMesh(ctx, g, ctx.mats.terrain, false, true);
		}
	}
}

function buildTerrainCollider(ctx: RealismCtx): void
{
	const world = ctx.world, data = ctx.data;
	const C: any = CANNON;
	// cannon.js 0.6 builds broken heightfield pillars when any height is negative
	// (sea floor), so the data is shifted up to start at 1 m and the body is lowered by the same amount.
	let minH = 1e9;
	for (let i = 0; i < data.heights.length; i++) if (data.heights[i] < minH) minH = data.heights[i];
	const shift = Math.max(0, 1 - minH);
	const matrix: number[][] = [];
	for (let i = 0; i < VERTS; i++)
	{
		const col: number[] = [];
		for (let j = 0; j < VERTS; j++)
		{
			// cannon: data[i][j] -> world x = -HALF + i*CELL, world z = HALF - j*CELL
			const gz = GRID_RES - j;
			col.push(data.heights[gz * VERTS + i] + shift);
		}
		matrix.push(col);
	}
	const shape = new C.Heightfield(matrix, { elementSize: CELL });
	const mat = new CANNON.Material('terrainMat');
	mat.friction = 0.3;
	const body = new CANNON.Body({ mass: 0 });
	body.addShape(shape);
	body.position.set(-HALF, -shift, HALF);
	body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
	body.material = mat;
	world.physicsWorld.addBody(body);
}


const ROAD_TILE: { [k: string]: number } = { highway: 12, avenue: 12, street: 10, rural: 14, runway: 60, taxiway: 20, apron: 10 };
const ROAD_LIFT: { [k: string]: number } = { apron: 0.06, street: 0.08, rural: 0.08, taxiway: 0.1, avenue: 0.1, runway: 0.12, highway: 0.12 };

function buildRoads(ctx: RealismCtx, rphys: PhysicsChunks, baker: SunBaker): void
{
	const data = ctx.data;
	const set = new AccumSet();
	const up = [0, 1, 0];
	const white = [1, 1, 1];
	for (let r = 0; r < data.roads.length; r++)
	{
		const road: Road = data.roads[r];
		const hw = road.width / 2;
		const lift = ROAD_LIFT[road.kind] || 0.08;
		const tile = ROAD_TILE[road.kind] || 12;
		const L: number[][] = [], R: number[][] = [];
		const n = road.pts.length;
		for (let i = 0; i < n; i++)
		{
			const a = road.pts[Math.max(i - 1, 0)], b = road.pts[Math.min(i + 1, n - 1)];
			let tx = b.x - a.x, tz = b.z - a.z;
			const tl = Math.sqrt(tx * tx + tz * tz) || 1;
			tx /= tl; tz /= tl;
			const p = road.pts[i];
			const nx = -tz, nz = tx;
			const lx = p.x + nx * hw, lz = p.z + nz * hw, rx = p.x - nx * hw, rz = p.z - nz * hw;
			// Follow the (flattened) terrain across the width so the ribbon never sinks in
			const ly = Math.max(p.y, data.heightAt(lx, lz)) + lift;
			const ry = Math.max(p.y, data.heightAt(rx, rz)) + lift;
			const cy = Math.max(p.y, data.heightAt(p.x, p.z)) + lift;
			L.push([lx, Math.max(ly, cy - 0.05), lz, p.s]);
			R.push([rx, Math.max(ry, cy - 0.05), rz, p.s]);
		}
		for (let i = 0; i < n - 1; i++)
		{
			// Road collider: a thin tilted box under every segment, its top exactly on the road surface,
			// so cars and players drive on the road even where the terrain dips below it.
			{
				const ax = (L[i][0] + R[i][0]) / 2, ay = (L[i][1] + R[i][1]) / 2, az = (L[i][2] + R[i][2]) / 2;
				const bx = (L[i + 1][0] + R[i + 1][0]) / 2, by = (L[i + 1][1] + R[i + 1][1]) / 2, bz = (L[i + 1][2] + R[i + 1][2]) / 2;
				const dx = bx - ax, dy = by - ay, dz = bz - az;
				const hl = Math.sqrt(dx * dx + dz * dz);
				if (hl > 0.05)
				{
					const len = Math.sqrt(hl * hl + dy * dy);
					const rot = Math.atan2(dx, dz), tilt = -Math.atan2(dy, hl);
					const T = 0.35;
					rphys.box((ax + bx) / 2, (ay + by) / 2 - 0.02 - T * Math.cos(tilt), (az + bz) / 2, hw + 0.15, T, len / 2 + 0.35, rot, tilt);
				}
			}
			const mx = (road.pts[i].x + road.pts[i + 1].x) / 2, mz = (road.pts[i].z + road.pts[i + 1].z) / 2;
			const acc = set.get(road.kind + '|' + chunkKey(mx, mz, RENDER_CHUNK));
			const v0 = L[i][3] / tile, v1 = L[i + 1][3] / tile;
			acc.face(
				[[L[i][0], L[i][1], L[i][2]], [R[i][0], R[i][1], R[i][2]], [R[i + 1][0], R[i + 1][1], R[i + 1][2]], [L[i + 1][0], L[i + 1][1], L[i + 1][2]]],
				up, [[0, v0], [1, v0], [1, v1], [0, v1]], white);
		}
	}
	for (let k = 0; k < set.keys.length; k++)
	{
		const key = set.keys[k];
		const kind = key.split('|')[0];
		const g = set.get(key).toGeometry();
		if (baker) baker.shade(g);
		addMesh(ctx, g, ctx.mats['road_' + kind], false, true);
	}
}

/**
 * Junction pads. Two road ribbons overlap at every crossing: their lane lines run across
 * the junction and same-kind roads flicker (z-fighting). A plain asphalt pad drawn on top
 * hides both, and a white stop bar marks where each approach ends.
 */
function buildJunctions(ctx: RealismCtx, baker: SunBaker): void
{
	const data = ctx.data;
	const set = new AccumSet();
	const up = [0, 1, 0];
	const white = [1, 1, 1];
	const lift = 0.13;
	const yAt = (x: number, z: number, J: any) => Math.max(J.y, data.heightAt(x, z)) + lift;
	const uvOf = (x: number, z: number) => [x / 12, z / 12];
	for (let i = 0; i < data.intersections.length; i++)
	{
		const J: any = data.intersections[i];
		const pad = set.get('pad|' + chunkKey(J.x, J.z, RENDER_CHUNK));
		const marks = set.get('mark|' + chunkKey(J.x, J.z, RENDER_CHUNK));
		const reach = J.crossHW + 0.6;
		for (let k = 0; k < J.arms.length; k++)
		{
			const a = J.arms[k];
			const dx = a.dx, dz = a.dz, nx = -dz, nz = dx;
			const hw = a.hw + 0.05;
			// pad: from the centre out to the edge of the widest crossing road, full width of this arm
			const q = [
				[J.x + nx * hw, J.z + nz * hw],
				[J.x - nx * hw, J.z - nz * hw],
				[J.x - nx * hw + dx * reach, J.z - nz * hw + dz * reach],
				[J.x + nx * hw + dx * reach, J.z + nz * hw + dz * reach],
			];
			const pts = q.map((p) => [p[0], yAt(p[0], p[1], J), p[1]]);
			// make sure the quad faces up whatever the arm's winding
			const e1 = [pts[1][0] - pts[0][0], pts[1][2] - pts[0][2]], e2 = [pts[2][0] - pts[0][0], pts[2][2] - pts[0][2]];
			if (e1[0] * e2[1] - e1[1] * e2[0] > 0) pts.reverse();
			pad.face(pts, up, pts.map((p) => uvOf(p[0], p[2])), white);
			// stop bar across the inbound lanes (driver's right of traffic coming in)
			const rx = dz, rz = -dx;
			const d0 = reach - 0.15, d1 = reach + 0.35;
			const bq = [
				[J.x + dx * d0, J.z + dz * d0],
				[J.x + dx * d0 + rx * (a.hw - 0.3), J.z + dz * d0 + rz * (a.hw - 0.3)],
				[J.x + dx * d1 + rx * (a.hw - 0.3), J.z + dz * d1 + rz * (a.hw - 0.3)],
				[J.x + dx * d1, J.z + dz * d1],
			];
			const bp = bq.map((p) => [p[0], yAt(p[0], p[1], J) + 0.01, p[1]]);
			const f1 = [bp[1][0] - bp[0][0], bp[1][2] - bp[0][2]], f2 = [bp[2][0] - bp[0][0], bp[2][2] - bp[0][2]];
			if (f1[0] * f2[1] - f1[1] * f2[0] > 0) bp.reverse();
			marks.face(bp, up, [[0, 0], [0, 0], [0, 0], [0, 0]], [0.92, 0.92, 0.88]);
		}
	}
	for (let k = 0; k < set.keys.length; k++)
	{
		const key = set.keys[k];
		const g = set.get(key).toGeometry();
		const isPad = key.indexOf('pad|') === 0;
		if (baker && isPad) baker.shade(g);
		addMesh(ctx, g, isPad ? ctx.mats.road_junction : ctx.mats.road_marking, false, true, 'street');
	}
}

function cylinder(acc: GeoAccum, y0: number, h: number, r0: number, r1: number, seg: number, c: number[]): void
{
	for (let i = 0; i < seg; i++)
	{
		const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
		const slope = Math.atan2(r0 - r1, h);
		const n = [Math.cos(am) * Math.cos(slope), Math.sin(slope), Math.sin(am) * Math.cos(slope)];
		if (r1 > 0.001)
			acc.face([[Math.cos(a0) * r0, y0, Math.sin(a0) * r0], [Math.cos(a1) * r0, y0, Math.sin(a1) * r0], [Math.cos(a1) * r1, y0 + h, Math.sin(a1) * r1], [Math.cos(a0) * r1, y0 + h, Math.sin(a0) * r1]], n, [[0, 0], [0, 0], [0, 0], [0, 0]], c);
		else
			acc.face([[Math.cos(a0) * r0, y0, Math.sin(a0) * r0], [Math.cos(a1) * r0, y0, Math.sin(a1) * r0], [0, y0 + h, 0]], n, [[0, 0], [0, 0], [0, 0]], c);
	}
	// underside of foliage cones
	if (r0 > 0.6)
	{
		for (let i = 0; i < seg; i++)
		{
			const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
			acc.face([[0, y0, 0], [Math.cos(a1) * r0, y0, Math.sin(a1) * r0], [Math.cos(a0) * r0, y0, Math.sin(a0) * r0]], [0, -1, 0], [[0, 0], [0, 0], [0, 0]], [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6]);
		}
	}
}

function blob(acc: GeoAccum, cy: number, rx: number, ry: number, c: number[]): void
{
	const lat = 5, lon = 8;
	const P = (i: number, j: number) =>
	{
		const th = (i / lat) * Math.PI, ph = (j / lon) * Math.PI * 2;
		const wob = 1 + 0.12 * Math.sin(j * 2.3 + i * 1.7);
		return [Math.sin(th) * Math.cos(ph) * rx * wob, cy + Math.cos(th) * ry, Math.sin(th) * Math.sin(ph) * rx * wob];
	};
	for (let i = 0; i < lat; i++)
	{
		for (let j = 0; j < lon; j++)
		{
			const a = P(i, j), b = P(i, j + 1), cc = P(i + 1, j + 1), d = P(i + 1, j);
			const mx = (a[0] + b[0] + cc[0] + d[0]) / 4, my = (a[1] + b[1] + cc[1] + d[1]) / 4 - cy, mz = (a[2] + b[2] + cc[2] + d[2]) / 4;
			const l = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
			const shade = 0.85 + 0.15 * (my / ry);
			const col = [c[0] * shade, c[1] * shade, c[2] * shade];
			if (i === 0) acc.face([a, cc, d], [mx / l, my / l, mz / l], [[0, 0], [0, 0], [0, 0]], col);
			else if (i === lat - 1) acc.face([a, b, d], [mx / l, my / l, mz / l], [[0, 0], [0, 0], [0, 0]], col);
			else acc.face([a, b, cc, d], [mx / l, my / l, mz / l], [[0, 0], [0, 0], [0, 0], [0, 0]], col);
		}
	}
}

function treeGeometries(): THREE.BufferGeometry[]
{
	const out: THREE.BufferGeometry[] = [];
	const bark = [0.33, 0.24, 0.17];
	const pines = [[0.16, 0.3, 0.15], [0.2, 0.34, 0.17]];
	for (let v = 0; v < 2; v++)
	{
		const a = new GeoAccum();
		cylinder(a, -0.3, 3, 0.28, 0.18, 6, bark);
		cylinder(a, 2.0, 4.2, 2.6, 0, 8, pines[v]);
		cylinder(a, 4.0, 3.8, 2.0, 0, 8, [pines[v][0] * 1.08, pines[v][1] * 1.08, pines[v][2] * 1.08]);
		cylinder(a, 5.9, 3.4, 1.4, 0, 8, [pines[v][0] * 1.15, pines[v][1] * 1.15, pines[v][2] * 1.15]);
		out.push(a.toGeometry());
	}
	const leaves = [[0.25, 0.42, 0.16], [0.33, 0.45, 0.17]];
	for (let v = 0; v < 2; v++)
	{
		const a = new GeoAccum();
		cylinder(a, -0.3, 3.4, 0.32, 0.22, 6, bark);
		blob(a, 4.6, 2.7, 2.2, leaves[v]);
		out.push(a.toGeometry());
	}
	return out;  // [pineA, pineB, broadA, broadB]
}

/**
 * Trees from the map. Built-in models first; your own models (realism-config.js ->
 * vegetation.trees / pineTrees, any number of variants) are swapped in per tree when they load.
 * vegetation.density.trees (0..1) thins the trees out (same trees kept for the same seed).
 */
function buildTrees(ctx: RealismCtx): void
{
	const data = ctx.data, phys = ctx.phys, world = ctx.world;
	const treeOv = ctx.cfg.city.props;
	const vs = vegSettings(ctx);
	const sets: { [name: string]: VegModelSet } = { pineTree: new VegModelSet(ctx, 'pineTree'), tree: new VegModelSet(ctx, 'tree') };
	const density = vs.density.trees;
	const lod = new TreeLOD(ctx, sets);
	const geoms = treeGeometries();
	const groups: { [key: string]: number[] } = {};
	const keys: string[] = [];
	const userOf: number[] = [];
	let thinned = 0;
	for (let i = 0; i < data.trees.length; i++)
	{
		const t = data.trees[i];
		userOf.push(-1);
		if (density < 1 && hash01(t.x, t.z, 53) >= density) { thinned++; continue; }
		const variant = t.type * 2 + (((t.x * 7 + t.z * 13) | 0) & 1);
		// every tree is built with the built-in low-poly model; your models are swapped onto the
		// nearest few at run time (RealismTreeLOD), so far trees always stay low-poly
		const u = -1;
		userOf[i] = u;
		const key = (u < 0 ? variant : variant + VARIANT_STRIDE * u) + '|' + chunkKey(t.x, t.z, RENDER_CHUNK);
		if (groups[key] === undefined) { groups[key] = []; keys.push(key); }
		groups[key].push(i);
		// your models get a trunk collider measured from the model once it has loaded
		if (u < 0) phys.box(t.x, t.y + 2.2, t.z, 0.3 * t.s, 2.2, 0.3 * t.s, 0);
	}
	const treeMeshes: { mesh: THREE.InstancedMesh, list: number[], variant: number, user: number }[] = [];
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
	for (let k = 0; k < keys.length; k++)
	{
		const key = keys[k];
		const list = groups[key];
		const code = parseInt(key.split('|')[0], 10);
		const variant = code % VARIANT_STRIDE, user = code >= VARIANT_STRIDE ? Math.floor(code / VARIANT_STRIDE) : (userOf[list[0]] >= 0 ? 0 : -1);
		const geom = geoms[variant].clone();
		const mesh = new THREE.InstancedMesh(geom, instMat(ctx, ctx.mats.foliage), list.length);
		let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, minY = 1e9, maxY = -1e9;
		for (let i = 0; i < list.length; i++)
		{
			const t = data.trees[list[i]];
			p.set(t.x, t.y, t.z);
			q.setFromAxisAngle(yAxis, t.r);
			s.set(t.s, t.s * (0.9 + ((i * 37) % 20) / 100), t.s);
			m.compose(p, q, s);
			mesh.setMatrixAt(i, m);
			minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x);
			minZ = Math.min(minZ, t.z); maxZ = Math.max(maxZ, t.z);
			minY = Math.min(minY, t.y); maxY = Math.max(maxY, t.y + 12);
		}
		mesh.instanceMatrix.needsUpdate = true;
		const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
		const radius = Math.sqrt((maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY) + (maxZ - minZ) * (maxZ - minZ)) / 2 + 8;
		geom.boundingSphere = new THREE.Sphere(center, radius);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		world.graphicsWorld.add(mesh);
		ctx.cull.add(mesh, 'tree', center, radius);
		mesh.userData.treeGroup = variant < 2 ? 'pineTree' : 'tree';
		for (let i = 0; i < list.length; i++) { const t = data.trees[list[i]]; lod.add(t.x, t.y, t.z, t.r, mesh.userData.treeGroup, mesh, i); }
		treeMeshes.push({ mesh: mesh, list: list, variant: variant, user: user });
	}
	if (thinned > 0) console.log('[Realism] vegetation.density.trees ' + density + ': ' + (data.trees.length - thinned) + ' of ' + data.trees.length + ' trees kept');
	// old city.props.tree / pineTree overrides: only for a kind without models in vegetation
	const legacy: { [name: string]: AssetOverride } = {};
	for (const name in sets) if (sets.hasOwnProperty(name) && !sets[name].custom && treeOv && treeOv[name]) legacy[name] = treeOv[name];
	swapTreeModels(ctx, treeMeshes.filter((t) => t.user < 0), legacy);
	if (lod.active)
	{
		world.registerUpdatable(lod);
		(world as any).realismTreeLOD = lod;
	}
}

// --- Baked sun shadows (ray cast once at load) ------------------------------------

/**
 * Casts a ray from every terrain / road vertex towards the sun and darkens the vertex colour
 * when a hill or a building is in the way. Done once while loading, so it costs nothing per frame
 * (unlike realtime shadow maps, which redraw the whole scene several times every frame).
 * Uses the default sun (elevation 50, rotation 145).
 */
class SunBaker
{
	private ctx: RealismCtx;
	private dir: number[];
	private grid: { [key: string]: number[] } = {};
	private static CELL = 16;
	public rays = 0;

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		const phi = 50 * Math.PI / 180, theta = 145 * Math.PI / 180;
		const x = Math.sin(theta) * Math.cos(phi), y = Math.sin(phi), z = Math.cos(theta) * Math.cos(phi);
		const l = Math.sqrt(x * x + y * y + z * z);
		this.dir = [x / l, y / l, z / l];
		const bs = ctx.data.buildings;
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.h < 1.5) continue;
			const r = Math.sqrt(b.w * b.w + b.d * b.d) / 2;
			const c = SunBaker.CELL;
			for (let gx = Math.floor((b.x - r) / c); gx <= Math.floor((b.x + r) / c); gx++)
				for (let gz = Math.floor((b.z - r) / c); gz <= Math.floor((b.z + r) / c); gz++)
				{
					const k = gx + '_' + gz;
					(this.grid[k] || (this.grid[k] = [])).push(i);
				}
		}
	}

	private inBuilding(x: number, y: number, z: number): boolean
	{
		const list = this.grid[Math.floor(x / SunBaker.CELL) + '_' + Math.floor(z / SunBaker.CELL)];
		if (!list) return false;
		const bs = this.ctx.data.buildings;
		for (let i = 0; i < list.length; i++)
		{
			const b = bs[list[i]];
			if (y < b.baseY || y > b.baseY + b.h) continue;
			const dx = x - b.x, dz = z - b.z;
			const c = Math.cos(b.rot), s = Math.sin(b.rot);
			const lx = dx * c - dz * s, lz = dx * s + dz * c;
			if (Math.abs(lx) < b.w / 2 && Math.abs(lz) < b.d / 2) return true;
		}
		return false;
	}

	/** 0 = fully in shadow, 1 = lit. */
	public light(x: number, y: number, z: number): number
	{
		this.rays++;
		const d = this.dir, data = this.ctx.data;
		let t = 1.0;
		while (t < 140)
		{
			const px = x + d[0] * t, py = y + 0.3 + d[1] * t, pz = z + d[2] * t;
			if (py > 120) return 1;
			if (data.heightAt(px, pz) > py + 0.4) return 0;
			if (this.inBuilding(px, py, pz)) return 0;
			t += t < 20 ? 1.0 : 2.5;
		}
		return 1;
	}

	public shade(g: THREE.BufferGeometry): void
	{
		const pos = g.getAttribute('position') as THREE.BufferAttribute;
		let col = g.getAttribute('color') as THREE.BufferAttribute;
		if (!pos) return;
		if (!col)
		{
			const arr = new Float32Array(pos.count * 3).fill(1);
			col = new THREE.BufferAttribute(arr, 3);
			g.setAttribute('color', col);
		}
		const a: any = col.array, p = pos.array as Float32Array;
		const max = col.normalized && a instanceof Uint8Array ? 255 : 1e9;
		for (let i = 0; i < pos.count; i++)
		{
			const k = this.light(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) ? 1 : 0.58;
			if (k === 1) continue;
			a[i * 3] = a[i * 3] * k; a[i * 3 + 1] = a[i * 3 + 1] * k; a[i * 3 + 2] = Math.min(max, a[i * 3 + 2] * k * 1.06);
		}
		col.needsUpdate = true;
	}
}
