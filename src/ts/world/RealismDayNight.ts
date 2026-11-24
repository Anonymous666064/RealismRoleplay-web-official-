/*
 * RealismDayNight.ts
 * ------------------
 * Day / night cycle for San Verano County.
 *
 *  - A game clock (0..24 h) runs at `cycleMinutes` real minutes per game day. It stops while the
 *    game is paused (it runs on the scaled time step, which is 0 in the menus).
 *  - The clock drives Sketchbook's sky (sun elevation), the sun / moon light (colour, strength,
 *    direction), the ambient (hemisphere) light and the fog colour, all smoothly.
 *  - Night = street lamp heads lit, facade windows glowing, and the point-light pool in
 *    RealismPerformance moved to street lamps / porch lights. Day = all of that off.
 *    Every switch is a material colour change: no extra draw calls, no shader recompiles.
 *  - Nights are never pitch black: a bluish moonlight + ambient floor (`nightBrightness`).
 *
 * realism-config.js:  dayNight: { enabled: true, cycleMinutes: 24, startHour: 12 }
 * Shared state:       (world as any).realismTime = { hour }   (same object, updated in place)
 *                     (world as any).realismDayNight          (this object)
 */

import * as THREE from 'three';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';

export interface DayNightSettings
{
	/** false: the clock stands still at `startHour` (the time slider still works). */
	enabled: boolean;
	/** Real minutes for one full game day. */
	cycleMinutes: number;
	/** Game hour when the world starts, 0..24 (12 = noon). */
	startHour: number;
	/** 0..1, how bright the night is compared to the day (moonlight + ambient). */
	nightBrightness: number;
	/** Facade windows glow at night. */
	windowsAtNight: boolean;
}

export const DAY_NIGHT_DEFAULTS: DayNightSettings = {
	enabled: true,
	cycleMinutes: 24,
	startHour: 12,
	nightBrightness: 0.35,
	windowsAtNight: true,
};

export function dayNightSettings(cfg: any): DayNightSettings
{
	const user = cfg && cfg.dayNight && typeof cfg.dayNight === 'object' ? cfg.dayNight : {};
	const out: DayNightSettings = Object.assign({}, DAY_NIGHT_DEFAULTS);
	if (typeof user.enabled === 'boolean') out.enabled = user.enabled;
	if (typeof user.cycleMinutes === 'number' && user.cycleMinutes > 0) out.cycleMinutes = user.cycleMinutes;
	if (typeof user.startHour === 'number' && isFinite(user.startHour)) out.startHour = ((user.startHour % 24) + 24) % 24;
	if (typeof user.nightBrightness === 'number') out.nightBrightness = Math.max(0.05, Math.min(1, user.nightBrightness));
	if (typeof user.windowsAtNight === 'boolean') out.windowsAtNight = user.windowsAtNight;
	return out;
}

function smooth(a: number, b: number, v: number): number
{
	const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
	return t * t * (3 - 2 * t);
}

const DAY_FOG = new THREE.Color(0xbccfe0);
const DUSK_FOG = new THREE.Color(0xc7a58e);
const NIGHT_FOG = new THREE.Color(0x0e1626);
const SUN_WHITE = new THREE.Color(0xffffff);
const SUN_LOW = new THREE.Color(0xffa860);
const MOON = new THREE.Color(0x9db2ff);
const HEMI_DAY = new THREE.Color().setHSL(0.59, 0.4, 0.6);
const HEMI_DAY_GROUND = new THREE.Color().setHSL(0.095, 0.2, 0.75);
const HEMI_NIGHT = new THREE.Color(0x6d80b0);
const HEMI_NIGHT_GROUND = new THREE.Color(0x2c3240);
const WINDOW_GLOW = new THREE.Color(0xffd890);

export class RealismDayNight implements IUpdatable
{
	/** After Sky (5): overrides the light direction / ambient Sky just set. */
	public updateOrder: number = 6;
	public settings: DayNightSettings;
	/** Shared with other systems as (world as any).realismTime. */
	public time: { hour: number } = { hour: 12 };
	public night = false;

	private ctx: RealismCtx;
	private world: any;
	private sunBase = 2.5;
	private lamps: THREE.Material[] = [];
	private windows: THREE.Material[] = [];
	private scanned = false;
	private applied = -1;           // last applied hour (skips work when the clock stands still)
	private tmpColor = new THREE.Color();
	private tmpDir = new THREE.Vector3();

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		this.settings = dayNightSettings(ctx.cfg);
		this.time.hour = this.settings.startHour;
		const csm: any = this.world.sky ? this.world.sky.csm : null;
		if (csm && typeof csm.lightIntensity === 'number') this.sunBase = csm.lightIntensity;
		this.world.realismTime = this.time;
		this.world.realismDayNight = this;
		this.applyNow();
	}

	public setEnabled(on: boolean): void { this.settings.enabled = on; }
	public setCycleMinutes(m: number): void { if (m > 0) this.settings.cycleMinutes = m; }
	public setHour(h: number): void { this.time.hour = ((h % 24) + 24) % 24; this.applyNow(); }
	public get hour(): number { return this.time.hour; }

	/** "13:05" */
	public static format(h: number): string
	{
		const t = Math.floor(((h % 24) + 24) % 24 * 60);
		const hh = Math.floor(t / 60), mm = t % 60;
		return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
	}

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		if (this.settings.enabled && timeStep > 0)
		{
			this.time.hour = (this.time.hour + timeStep * 24 / (this.settings.cycleMinutes * 60)) % 24;
		}
		this.applyNow();
		// Sky.update re-sets the light direction from the sun every frame; at night use the moon.
		this.lightDirection();
	}

	/** Pushes the current hour into the sky, lights, fog and lamps. */
	public applyNow(): void
	{
		const world = this.world;
		if (!world.sky) return;
		const h = this.time.hour;
		const s = Math.sin(2 * Math.PI * (h - 6) / 24);         // sun height, -1 (midnight) .. 1 (noon)
		const phi = 180 * (h - 6) / 12;                          // Sketchbook sun elevation (0 east horizon .. 180 west)
		const sky: any = world.sky;
		if (Math.abs(this.applied - h) > 1e-4)
		{
			world.params.Sun_Elevation = phi;
			sky.phi = phi;                                        // moves the sun on the sky dome
			this.applied = h;
		}
		const nb = this.settings.nightBrightness;
		const day = smooth(-0.1, 0.25, s);                       // 0 night .. 1 day
		const sunUp = smooth(0, 0.45, s);                        // full sun from ~8:00 to ~16:00
		const moonUp = smooth(0, 0.22, -s);

		// sun / moon light (the CSM directional lights)
		const csm: any = sky.csm;
		if (csm && csm.lights)
		{
			let intensity: number;
			if (s >= 0)
			{
				intensity = this.sunBase * sunUp;
				this.tmpColor.copy(SUN_LOW).lerp(SUN_WHITE, smooth(0.05, 0.45, s));
			}
			else
			{
				intensity = this.sunBase * 0.6 * nb * moonUp;
				this.tmpColor.copy(MOON);
			}
			for (let i = 0; i < csm.lights.length; i++)
			{
				csm.lights[i].intensity = intensity;
				csm.lights[i].color.copy(this.tmpColor);
			}
		}

		// ambient (hemisphere light; Sky's own formula breaks below the horizon, so it is set here)
		const hemi: any = sky.hemiLight;
		if (hemi)
		{
			const p = Math.max(0, Math.min(180, phi));
			const dayHemi = 0.3 + Math.pow(Math.max(0, 1 - Math.abs(p - 90) / 90), 0.25) * 0.6;
			const nightHemi = 0.3 + 0.5 * nb;
			hemi.intensity = nightHemi + (dayHemi - nightHemi) * day;
			hemi.color.copy(HEMI_NIGHT).lerp(HEMI_DAY, day);
			hemi.groundColor.copy(HEMI_NIGHT_GROUND).lerp(HEMI_DAY_GROUND, day);
		}

		// fog follows the sky so the horizon never glows white at night
		const fog: any = world.graphicsWorld.fog;
		if (fog && fog.color)
		{
			const dusk = smooth(0.35, 0.0, Math.abs(s)) * day;   // warm band around sunrise / sunset
			fog.color.copy(NIGHT_FOG).lerp(DAY_FOG, day).lerp(DUSK_FOG, dusk * 0.6);
		}

		// lamps on / off (with a little hysteresis so they don't flicker at the threshold)
		const night = this.night ? s < 0.14 : s < 0.1;
		if (night !== this.night || !this.scanned) this.setNight(night);
	}

	/** At night the directional light comes from the moon (opposite the sun) instead of from below. */
	private lightDirection(): void
	{
		const sky: any = this.world.sky;
		if (!sky || !sky.csm || !sky.sunPosition) return;
		const sp: THREE.Vector3 = sky.sunPosition;
		if (sp.y >= 0) return;   // day: Sky already points it from the sun
		this.tmpDir.set(sp.x, sp.y, sp.z).normalize();   // moon at -sun: light travels along +sun
		sky.csm.lightDirection = this.tmpDir;
	}

	private scan(): void
	{
		this.scanned = true;
		const lamps = new Set<THREE.Material>(), windows = new Set<THREE.Material>();
		const add = (m: any) =>
		{
			if (!m || !m.userData) return;
			if (m.userData.realismNightLamp) lamps.add(m);
			if (m.userData.realismNightWindow) windows.add(m);
		};
		const mats: any = this.ctx.mats;
		for (const k in mats) if (mats.hasOwnProperty(k)) add(mats[k]);
		// instanced / chunk copies of those materials (instMat clones keep the userData flags)
		this.world.graphicsWorld.traverse((o: any) =>
		{
			if (!o.material) return;
			if (Array.isArray(o.material)) o.material.forEach(add); else add(o.material);
		});
		this.lamps = Array.from(lamps);
		this.windows = Array.from(windows);
	}

	private setNight(on: boolean): void
	{
		this.night = on;
		this.scan();   // once per switch: catches materials created after the last one
		for (let i = 0; i < this.lamps.length; i++)
		{
			const m: any = this.lamps[i];
			if (m.color) m.color.setHex(on ? m.userData.onColor : m.userData.offColor);
		}
		const glow = on && this.settings.windowsAtNight;
		for (let i = 0; i < this.windows.length; i++)
		{
			const m: any = this.windows[i];
			if (!m.emissive) continue;
			if (glow) m.emissive.copy(WINDOW_GLOW).multiplyScalar(0.85);
			else m.emissive.setHex(0x000000);
		}
		const perf = this.world.realismPerformance;
		if (perf && typeof perf.setNight === 'function') perf.setNight(on);
	}

	/** Re-applies the window glow after windowsAtNight changed. */
	public refreshLamps(): void { this.setNight(this.night); }
}
