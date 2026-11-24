/*
 * RealismHotwire.ts
 * -----------------
 * Contract C12 (A17 implements, A13 calls): (world as any).realismHotwire = { start(car, done), active }
 *
 * When the player steals a parked or traffic car that isn't theirs, the vehicle code calls
 * start(car, done) before the car becomes drivable. A timing minigame opens (game mechanics only):
 *   - 3 stages ("Panel", "Wire A to B", "Ignition"); a needle sweeps a bar, press SPACE / E / click
 *     while it is inside the green zone. Each stage times out after hotwire.stageTimeout seconds.
 *   - Nicer cars are harder: tier 1 (value < $20k), 2 (< $40k), 3 (more): narrower zone, faster needle.
 *   - hotwire.maxMisses misses (default 2) = failure. A clean run takes ~5-10 s.
 * The mouse is released through realismSetUIBlocking('hotwire', true) BEFORE exitPointerLock and given
 * back on close. While it runs the car is held with the brakes.
 *   success -> done(true) (the caller makes the car drivable), 'crime' { kind: 'carTheft' } + heat.
 *   failure -> car alarm, 'crime' { kind: 'carTheftFailed' } + heat, NPCs nearby panic, done(false).
 *   Esc gives up (= failure without the alarm). A second start() while one runs answers done(false).
 *
 * Extras for tests: press(), cancel(), state(), difficulty(car).
 */

import * as THREE from 'three';
import { IllegalCore, TimingGame } from './RealismIllegalCore';

export class Hotwire
{
	public api: any;
	public active = false;
	public car: any = null;
	public game: TimingGame = null;
	public last: { success: boolean; hits: number; misses: number; tier: number } = null;
	private core: IllegalCore;
	private done: (ok: boolean) => void = null;
	private audio: any = null;
	private hadWorld = false;

	constructor(core: IllegalCore)
	{
		this.core = core;
		const self = this;
		this.api = {
			start(car: any, done: (success: boolean) => void): void { self.start(car, done); },
			get active(): boolean { return self.active; },
			press(): void { if (self.game) self.game.press(); },
			cancel(): void { if (self.game) self.game.cancel(); },
			difficulty(car: any): any { return self.difficulty(car); },
			state(): any
			{
				const g = self.game;
				return { active: self.active, stage: g ? g.stage : -1, hits: g ? g.hits : 0, misses: g ? g.misses : 0, needle: g ? g.needle : 0, zoneAt: g ? g.zoneAt : 0,
					zone: g ? g.spec.zone : 0, inZone: g ? g.inZone : false, last: self.last };
			},
		};
		(core.w as any).realismHotwire = this.api;
		core.addUpdater(this);
	}

	public difficulty(car: any): { tier: number; zone: number; speed: number; value: number; type: string }
	{
		const c = this.core.cfg.hotwire;
		const type = this.core.carType(car);
		const value = this.core.typeValue(type);
		const tier = value < 20000 ? 1 : value < 40000 ? 2 : 3;
		const pick = (a: any, d: number) => a instanceof Array ? (+a[Math.min(tier - 1, a.length - 1)] || d) : (typeof a === 'number' ? a : d);
		return { tier: tier, zone: pick(c.zone, 0.2), speed: pick(c.speed, 0.7), value: value, type: type };
	}

	public start(car: any, done: (success: boolean) => void): void
	{
		const cb = typeof done === 'function' ? done : (() => { /* none */ });
		if (this.active || !car || this.core.cfg.hotwire.enabled === false)
		{
			// disabled: steal straight away; busy: refuse this one
			setTimeoutSafe(() => cb(!this.active && !!car && this.core.cfg.hotwire.enabled === false));
			return;
		}
		const d = this.difficulty(car);
		const c = this.core.cfg.hotwire;
		this.active = true;
		this.car = car;
		this.hadWorld = !!car.world;
		this.done = cb;
		this.hold(true);
		const stages = ['Panel', 'Wire A to B', 'Ignition'];
		const n = Math.max(1, Math.min(6, Math.round(c.stages || 3)));
		while (stages.length < n) stages.push('Wire ' + String.fromCharCode(65 + stages.length) + ' to ' + String.fromCharCode(66 + stages.length));
		this.game = this.core.startTiming({
			owner: 'hotwire',
			title: 'HOTWIRE' + (d.tier > 1 ? (d.tier === 2 ? '  (tricky)' : '  (high-end, hard)') : ''),
			stages: stages.slice(0, n),
			zone: d.zone, speed: d.speed,
			maxMisses: Math.max(1, Math.round(c.maxMisses || 2)),
			stageTimeout: c.stageTimeout || 3.5,
			onFinish: (r) => this.finish(r.success, r.hits, r.misses, d.tier),
		});
	}

	private finish(success: boolean, hits: number, misses: number, tier: number): void
	{
		const car = this.car;
		const cb = this.done;
		this.hold(false);
		this.active = false;
		this.game = null;
		this.car = null;
		this.done = null;
		this.last = { success: success, hits: hits, misses: misses, tier: tier };
		const pos = car && car.position ? new THREE.Vector3(car.position.x, car.position.y, car.position.z) : null;
		const H = this.core.cfg.heat;
		if (success)
		{
			this.core.crime('carTheft', pos, H.theft);
			this.core.toast('Hotwired. Get a respray and lose the VIN before you sell it.');
		}
		else
		{
			const gaveUp = misses < Math.max(1, Math.round(this.core.cfg.hotwire.maxMisses || 2));
			if (!gaveUp && this.core.cfg.hotwire.alarmOnFail !== false) this.alarm();
			this.core.crime('carTheftFailed', pos, H.failedTheft);
			try { const npcs = (this.core.w as any).realismNPCs; if (npcs && npcs.panic && pos) npcs.panic(pos, 25); } catch (e) { /* ignore */ }
			this.core.toast(gaveUp ? 'You gave up on the wiring.' : 'The alarm went off!');
		}
		try { cb(success); } catch (e) { console.warn('[Realism] hotwire callback failed', e); }
	}

	private hold(on: boolean): void
	{
		const car = this.car;
		if (!car) return;
		try { if (on) { if (car.applyEngineForce) car.applyEngineForce(0); if (car.setBrake) car.setBrake(1000000); } else if (car.setBrake) car.setBrake(0); } catch (e) { /* ignore */ }
	}

	public update(dt: number): void
	{
		if (!this.active) return;
		if (this.car && this.hadWorld && !this.car.world) { if (this.game) this.game.cancel(); return; }
		this.hold(true);
	}

	public alarmCount = 0;
	/** Car alarm: two-tone square wave for ~2.5 s (WebAudio, realismVolume). */
	public alarm(): void
	{
		this.alarmCount++;
		try
		{
			const W: any = typeof window !== 'undefined' ? window : null;
			const AC = W && (W.AudioContext || W.webkitAudioContext);
			if (!this.audio && AC) this.audio = new AC();
			const ac = this.audio;
			if (!ac) return;
			const vol = typeof (this.core.w as any).realismVolume === 'number' ? (this.core.w as any).realismVolume : 0.8;
			const osc = ac.createOscillator(), gain = ac.createGain();
			osc.type = 'square';
			const t0 = ac.currentTime;
			for (let k = 0; k < 10; k++) osc.frequency.setValueAtTime(k % 2 ? 620 : 880, t0 + k * 0.25);
			gain.gain.setValueAtTime(0.0001, t0);
			gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.07 * vol), t0 + 0.05);
			gain.gain.setValueAtTime(Math.max(0.0002, 0.07 * vol), t0 + 2.3);
			gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.5);
			osc.connect(gain); gain.connect(ac.destination);
			osc.start(t0); osc.stop(t0 + 2.55);
		}
		catch (e) { /* no audio */ }
	}

	/** Tests: use a fake AudioContext. */
	public useAudioContext(ac: any): void { this.audio = ac; }
}

function setTimeoutSafe(f: () => void): void
{
	try { setTimeout(f, 0); } catch (e) { f(); }
}
