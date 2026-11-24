/*
 * RealismPerformance.ts
 * ---------------------
 * Keeps San Verano County fast on Chromebooks and phones:
 *
 *  - Point lights: a fixed pool of N real lights is moved to the N lamps / rooms nearest the
 *    camera (street lamps only at night). The light count never changes while playing, so
 *    three.js never has to recompile shaders (that is what causes stutters).
 *  - Distance culling: building chunks, props, interiors and trees are hidden past their
 *    distance (set per preset). Hidden meshes cost no draw calls.
 *  - Water: 'shader' uses Sketchbook's animated ocean, 'simple' a flat material (much cheaper).
 *  - Resolution, shadows, FXAA, fog and the camera far plane follow the preset.
 *  - Optional "Realism Graphics" panel in the top-right menu to switch preset live.
 */

import * as THREE from 'three';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx, gpuOnly } from './RealismContext';
import { resolvePreset, PerformancePreset } from './RealismConfig';
import { applyBrightness } from './RealismMaterials';

export interface WaterSet { meshes: THREE.Mesh[]; shaderMats: THREE.Material[]; oceans: IUpdatable[]; simple: THREE.Material; }

export class RealismPerformance implements IUpdatable
{
	public updateOrder: number = 8;
	private ctx: RealismCtx;
	private water: WaterSet;
	private lights: THREE.PointLight[] = [];
	private lightAcc = 1;
	private cullAcc = 1;
	// ---- unloading: GPU buffers of far-away meshes are freed, and uploaded again on return ----
	private unloadGeoms: THREE.BufferGeometry[][] = [];   // per cull entry: geometries under it
	private unloaded: boolean[] = [];                       // per cull entry
	private liveUsers = new Map<THREE.BufferGeometry, number>(); // loaded entries using each geometry
	private oceansOn = true;
	private camPos = new THREE.Vector3();
	public stats = { lightsUsed: 0, visibleMeshes: 0, hiddenMeshes: 0, unloadedMeshes: 0 };
	private trafficSignals: any;
	// frame-rate governor
	private frames = 0;
	private fpsAcc = 0;
	private lastNow = 0;
	public fps = 60;
	public drawCalls = 0;
	public triangles = 0;
	private lowFor = 0;
	private highFor = 0;
	private level = 0;              // 0 = preset as chosen, each step lowers quality a bit
	private base: PerformancePreset;
	private hud: HTMLElement = null;

	constructor(ctx: RealismCtx, water: WaterSet, trafficSignals: any)
	{
		this.ctx = ctx;
		this.water = water;
		this.trafficSignals = trafficSignals;
		this.base = Object.assign({}, ctx.preset);
		this.apply(ctx.preset);
		if (ctx.cfg.performance.showPanel) this.panel();
		this.makeHud();
	}

	/** Applies a preset (also used by the panel). */
	public apply(p: PerformancePreset): void
	{
		const ctx = this.ctx, world = ctx.world;
		ctx.preset = p;
		// resolution
		const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
		const ratio = Math.max(0.5, Math.min(dpr, p.pixelRatio));
		if (world.renderer && Math.abs(world.renderer.getPixelRatio() - ratio) > 0.01)
		{
			world.renderer.setPixelRatio(ratio);
			try { window.dispatchEvent(new Event('resize')); } catch (e) { /* headless */ }
		}
		// shadows / fxaa
		world.params.Shadows = p.shadows;
		world.params.FXAA = p.fxaa;
		if (world.sky && world.sky.csm) world.sky.csm.lights.forEach((l: THREE.DirectionalLight) =>
		{
			l.castShadow = p.shadows;
			const size = p.shadowMapSize || 1024;
			if (l.shadow.mapSize.x !== size)
			{
				l.shadow.mapSize.set(size, size);
				const sm: any = l.shadow;
				if (sm.map) { sm.map.dispose(); sm.map = null; }
			}
		});
		if (world.renderer) world.renderer.shadowMap.enabled = true;   // keep the shader variant stable; lights decide
		// fog + far plane
		const far = p.viewDistance;
		if (world.graphicsWorld.fog) { const f: any = world.graphicsWorld.fog; f.near = far * 0.38; f.far = far; }
		world.camera.far = far + 10;
		world.camera.updateProjectionMatrix();
		// The sky dome is a 1000 m sphere around the camera. If the far plane is closer than that,
		// the GPU clips the sky away and you see a black circle/hexagon. Shrink the dome to fit.
		const skyMesh: any = world.sky ? (world.sky as any).skyMesh : null;
		if (skyMesh) { skyMesh.scale.setScalar(Math.min(1, (far + 10) * 0.9 / 1000)); skyMesh.updateMatrix(); }
		// water
		const simple = p.water === 'simple';
		for (let i = 0; i < this.water.meshes.length; i++) this.water.meshes[i].material = simple ? this.water.simple : this.water.shaderMats[i];
		if (simple && this.oceansOn) { this.water.oceans.forEach((o) => world.unregisterUpdatable(o)); this.oceansOn = false; }
		if (!simple && !this.oceansOn) { this.water.oceans.forEach((o) => world.registerUpdatable(o)); this.oceansOn = true; }
		// light pool (only rebuilt when the count changes)
		const n = Math.max(0, Math.min(16, Math.round(p.pointLights)));
		if (n !== this.lights.length)
		{
			this.lights.forEach((l) => world.graphicsWorld.remove(l));
			this.lights = [];
			for (let i = 0; i < n; i++)
			{
				const l = new THREE.PointLight(0xffe0b0, 0, 20, 2);
				l.castShadow = false;
				world.graphicsWorld.add(l);
				this.lights.push(l);
			}
		}
		if (this.trafficSignals) this.trafficSignals.enabled = p.trafficLights;
		this.cullAcc = 1; this.lightAcc = 1;
	}

	/** Set by the day / night cycle (RealismDayNight): null = guess from the sun elevation. */
	public nightOverride: boolean = null;

	/** Street lamps / porch lights in the light pool follow this (called by RealismDayNight). */
	public setNight(on: boolean): void
	{
		if (this.nightOverride === on) return;
		this.nightOverride = on;
		this.lightAcc = 1;   // move the pool on the next frame
	}

	public isNight(): boolean
	{
		if (this.nightOverride !== null) return this.nightOverride;
		const e = this.ctx.world.params.Sun_Elevation;
		return e < 12 || e > 168;
	}

	// ---- Settings menu API (RealismUI) ------------------------------------------------

	/** The values the player chose (before the FPS governor lowered anything). */
	public getBase(): PerformancePreset { return Object.assign({}, this.base); }

	/** How many steps the FPS governor is below the chosen settings (0 = none). */
	public get autoLevel(): number { return this.level; }

	/** Switches to a preset ('auto' | 'low' | 'medium' | 'high' | 'ultra'): preset + realism-config.js overrides, slider changes dropped. */
	public setPreset(name: string): PerformancePreset
	{
		const perf: any = this.ctx.cfg.performance;
		const saved = perf.overrides;
		perf.overrides = perf.configOverrides || perf.overrides || {};
		const r = resolvePreset(this.ctx.cfg, name);
		perf.overrides = saved;
		perf.preset = name;
		this.ctx.presetName = r.name;
		this.base = Object.assign({}, r.p);
		this.resetGovernor();
		this.apply(this.stepped());
		return this.getBase();
	}

	/** Changes some values of the current settings live (view distance, point lights, shadows, ...). */
	public setValues(v: { [key: string]: any }): void
	{
		for (const k in v) if (v.hasOwnProperty(k) && v[k] !== undefined) (this.base as any)[k] = v[k];
		this.resetGovernor();
		this.apply(this.stepped());
	}

	public setBrightness(v: number): void
	{
		this.ctx.cfg.performance.brightness = v;
		applyBrightness(this.ctx.world.graphicsWorld, v);
	}

	public setTargetFps(fps: number): void { this.ctx.cfg.performance.targetFps = fps; this.resetGovernor(); }

	/** Auto-adjust: lower quality step by step below the target FPS. Off restores the chosen settings. */
	public setAdaptive(on: boolean): void
	{
		this.ctx.cfg.performance.adaptive = on;
		if (!on && this.level > 0) { this.level = 0; this.apply(this.stepped()); }
		this.resetGovernor();
	}

	public setShowFps(on: boolean): void
	{
		this.ctx.cfg.performance.showFps = on;
		if (on && !this.hud) this.makeHud();
		if (this.hud) this.hud.style.display = on ? 'block' : 'none';
	}

	private resetGovernor(): void { this.level = 0; this.lowFor = 0; this.highFor = 0; }

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		const dt = unscaledTimeStep || timeStep || 0.016;
		const r: any = this.ctx.world.renderer;
		if (r && r.info)
		{
			r.info.autoReset = false;          // count every pass of the frame (scene + FXAA + shadows)
			this.drawCalls = r.info.render.calls;
			this.triangles = r.info.render.triangles;
			r.info.reset();
		}
		this.measure();
		this.lightAcc += dt;
		this.cullAcc += dt;
		this.ctx.world.camera.getWorldPosition(this.camPos);
		if (this.cullAcc >= 0.3) { this.cullAcc = 0; this.cull(); }
		if (this.lightAcc >= 0.2) { this.lightAcc = 0; this.placeLights(); }
	}

	private cull(): void
	{
		const p = this.ctx.preset;
		const cx = this.camPos.x, cz = this.camPos.z;
		const lim: { [cat: string]: number } = {
			building: p.buildingDistance,
			detail: p.detailDistance,
			street: Math.max(p.detailDistance * 1.8, 180),
			interior: p.interiors ? p.interiorDistance : -1,
			tree: p.treeDistance,
		};
		let vis = 0, hid = 0;
		const list = this.ctx.cull.entries;
		const perf: any = this.ctx.cfg.performance;
		const unloadOn = perf.unloadFar !== false;
		const margin = typeof perf.unloadMargin === 'number' ? Math.max(0, perf.unloadMargin) : 80;
		if (unloadOn) this.registerUnloadEntries();
		for (let i = 0; i < list.length; i++)
		{
			const e = list[i];
			if (e.obj.userData.realismRemoved) continue;
			const L = lim[e.cat];
			if (L === undefined) continue;
			const dx = e.x - cx, dz = e.z - cz;
			const d = Math.sqrt(dx * dx + dz * dz) - e.r;
			const show = L >= 0 && d < L;
			if (e.obj.visible !== show) e.obj.visible = show;
			if (show) vis++; else hid++;
			if (unloadOn)
			{
				if (show && this.unloaded[i]) this.markLoaded(i);
				else if (!show && !this.unloaded[i] && (L < 0 || d > L + margin)) this.unload(i);
			}
		}
		this.stats.unloadedMeshes = unloadOn ? this.unloadedCount : 0;
		let drawnInterior = 0;
		for (let i = 0; i < this.ctx.dynamic.length; i++)
		{
			this.ctx.dynamic[i].refresh(cx, cz, p.interiors ? p.interiorDistance : -1);
			drawnInterior += this.ctx.dynamic[i].drawnInterior;
		}
		vis += drawnInterior;
		this.stats.visibleMeshes = vis;
		this.stats.hiddenMeshes = hid;
	}

	private unloadedCount = 0;

	/** Collects the geometries under each new cull entry; an entry counts as loaded to begin with. */
	private registerUnloadEntries(): void
	{
		const list = this.ctx.cull.entries;
		for (let i = this.unloadGeoms.length; i < list.length; i++)
		{
			const gs: THREE.BufferGeometry[] = [];
			list[i].obj.traverse((o: any) =>
			{
				const g = o.geometry;
				// geometry that already dropped its JavaScript copy (city chunks) can't be re-uploaded: leave it
				if (g && g.isBufferGeometry && gs.indexOf(g) < 0 && !gpuOnly(g)) gs.push(g);
			});
			this.unloadGeoms.push(gs);
			this.unloaded.push(false);
			for (let k = 0; k < gs.length; k++) this.liveUsers.set(gs[k], (this.liveUsers.get(gs[k]) || 0) + 1);
		}
	}

	/** Frees the GPU copy of an entry's geometries. A geometry shared with something still
	 *  loaded (one tree model used by many chunks) is kept until its last user goes. The data
	 *  stays in the page, so three.js uploads it again by itself the next time it is drawn. */
	private unload(i: number): void
	{
		const gs = this.unloadGeoms[i];
		for (let k = 0; k < gs.length; k++)
		{
			const n = (this.liveUsers.get(gs[k]) || 1) - 1;
			this.liveUsers.set(gs[k], n);
			if (n <= 0 && !gpuOnly(gs[k])) gs[k].dispose();
		}
		this.unloaded[i] = true;
		this.unloadedCount++;
	}

	private markLoaded(i: number): void
	{
		const gs = this.unloadGeoms[i];
		for (let k = 0; k < gs.length; k++) this.liveUsers.set(gs[k], (this.liveUsers.get(gs[k]) || 0) + 1);
		this.unloaded[i] = false;
		this.unloadedCount--;
	}

	private placeLights(): void
	{
		const n = this.lights.length;
		if (n === 0) return;
		const night = this.isNight();
		const spots = this.ctx.lightSpots;
		const cx = this.camPos.x, cy = this.camPos.y, cz = this.camPos.z;
		// keep the n nearest (simple insertion into a small sorted list)
		const bestD: number[] = [], bestI: number[] = [];
		const maxD = Math.max(60, this.ctx.preset.interiorDistance * 2);
		for (let i = 0; i < spots.length; i++)
		{
			const s = spots[i];
			if (s.night && !night) continue;
			const dx = s.x - cx, dy = s.y - cy, dz = s.z - cz;
			const d = dx * dx + dy * dy * 4 + dz * dz;     // favour lights on your own floor
			if (d > maxD * maxD) continue;
			if (bestD.length === n && d >= bestD[n - 1]) continue;
			let k = bestD.length < n ? bestD.length : n - 1;
			while (k > 0 && bestD[k - 1] > d) { bestD[k] = bestD[k - 1]; bestI[k] = bestI[k - 1]; k--; }
			bestD[k] = d; bestI[k] = i;
		}
		let used = 0;
		for (let j = 0; j < n; j++)
		{
			const l = this.lights[j];
			if (j < bestI.length)
			{
				const s = spots[bestI[j]];
				l.position.set(s.x, s.y, s.z);
				l.color.setHex(s.color);
				l.distance = s.range;
				l.intensity = s.night ? 1.6 : (night ? 1.2 : 0.7);
				used++;
			}
			else l.intensity = 0;
		}
		this.stats.lightsUsed = used;
	}

	/** Real frame time from the wall clock (the game's own timestep is clamped / scaled). */
	private measure(): void
	{
		const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
		if (this.lastNow === 0) { this.lastNow = now; return; }
		const ms = now - this.lastNow;
		this.lastNow = now;
		if (ms > 1000) return;   // tab was hidden
		this.frames++;
		this.fpsAcc += ms;
		if (this.fpsAcc < 1000) return;
		this.fps = this.frames * 1000 / this.fpsAcc;
		this.frames = 0; this.fpsAcc = 0;
		this.govern();
		if (this.hud)
		{
			this.hud.textContent = Math.round(this.fps) + ' FPS | ' + this.ctx.presetName + (this.level ? ' (auto -' + this.level + ')' : '') + ' | ' + this.drawCalls + ' draws | ' + Math.round(this.triangles / 1000) + 'k tris | Realism v14';
		}
	}

	/** Keeps the game at targetFps: steps quality down after 2 slow seconds, back up after 6 fast ones. */
	private govern(): void
	{
		const cfg = this.ctx.cfg.performance;
		if (!cfg.adaptive) return;
		const target = cfg.targetFps || 30;
		if (this.fps < target - 2) { this.lowFor++; this.highFor = 0; }
		else if (this.fps > target * 1.6) { this.highFor++; this.lowFor = 0; }
		else { this.lowFor = 0; this.highFor = 0; }
		if (this.lowFor >= 2 && this.level < 8) { this.level++; this.lowFor = 0; this.apply(this.stepped()); }
		else if (this.highFor >= 6 && this.level > 0) { this.level--; this.highFor = 0; this.apply(this.stepped()); }
	}

	private stepped(): PerformancePreset
	{
		const p: PerformancePreset = Object.assign({}, this.base);
		const L = this.level;
		if (L >= 1) p.shadows = false;
		if (L >= 1) p.fxaa = false;
		if (L >= 2) p.water = 'simple';
		if (L >= 2) p.pointLights = Math.min(p.pointLights, 2);
		if (L >= 3) p.pixelRatio = Math.min(p.pixelRatio, 0.85);
		if (L >= 4) { p.viewDistance = Math.min(p.viewDistance, 600); p.buildingDistance = Math.min(p.buildingDistance, 600); p.treeDistance = Math.min(p.treeDistance, 320); }
		if (L >= 5) { p.detailDistance = Math.min(p.detailDistance, 80); p.interiorDistance = Math.min(p.interiorDistance, 24); p.pointLights = 0; }
		if (L >= 6) p.pixelRatio = Math.min(p.pixelRatio, 0.7);
		if (L >= 7) { p.viewDistance = Math.min(p.viewDistance, 450); p.buildingDistance = Math.min(p.buildingDistance, 450); p.treeDistance = Math.min(p.treeDistance, 220); }
		if (L >= 8) p.pixelRatio = 0.55;
		return p;
	}

	private makeHud(): void
	{
		try
		{
			if (!this.ctx.cfg.performance.showFps || typeof document === 'undefined' || !document.body || !document.createElement) return;
			const el = document.createElement('div');
			el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;font:12px monospace;color:#fff;background:rgba(0,0,0,0.45);padding:3px 7px;border-radius:4px;pointer-events:none';
			el.textContent = 'Realism v14';
			document.body.appendChild(el);
			this.hud = el;
		}
		catch (e) { this.hud = null; }
	}

	private panel(): void
	{
		const gui = this.ctx.world.gui;
		if (!gui || !gui.addFolder) return;
		try
		{
			const folder = gui.addFolder('Realism Graphics');
			const state: any = { Preset: this.ctx.presetName, View_Distance: this.ctx.preset.viewDistance, Point_Lights: this.ctx.preset.pointLights, Interiors: this.ctx.preset.interiors, Simple_Water: this.ctx.preset.water === 'simple' };
			const sync = () =>
			{
				state.View_Distance = this.ctx.preset.viewDistance;
				state.Point_Lights = this.ctx.preset.pointLights;
				state.Interiors = this.ctx.preset.interiors;
				state.Simple_Water = this.ctx.preset.water === 'simple';
			};
			folder.add(state, 'Preset', Object.keys(this.ctx.cfg.performance.presets)).onChange((v: string) =>
			{
				const r = resolvePreset(this.ctx.cfg, v);
				this.ctx.presetName = r.name;
				this.base = Object.assign({}, r.p);
				this.level = 0;
				this.apply(r.p);
				sync();
			});
			folder.add(state, 'View_Distance', 250, 1000).step(50).listen().onChange((v: number) => { const p = Object.assign({}, this.ctx.preset); p.viewDistance = v; p.buildingDistance = v; this.apply(p); });
			folder.add(state, 'Point_Lights', 0, 16).step(1).listen().onChange((v: number) => { const p = Object.assign({}, this.ctx.preset); p.pointLights = v; this.apply(p); });
			folder.add(state, 'Interiors').listen().onChange((v: boolean) => { const p = Object.assign({}, this.ctx.preset); p.interiors = v; this.apply(p); });
			state.Brightness = this.ctx.cfg.performance.brightness || 0.55;
			folder.add(state, 'Brightness', 0.2, 1.2).step(0.05).onChange((v: number) => { this.ctx.cfg.performance.brightness = v; applyBrightness(this.ctx.world.graphicsWorld, v); });
			folder.add(state, 'Simple_Water').listen().onChange((v: boolean) => { const p = Object.assign({}, this.ctx.preset); p.water = v ? 'simple' : 'shader'; this.apply(p); });
		}
		catch (e) { console.warn('[Realism] Graphics panel unavailable', e); }
	}
}
