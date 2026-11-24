/*
 * RealismNeeds.ts
 * ---------------
 * Player needs for San Verano County (contract C11, developer A14).
 *
 *  - hunger, thirst, energy, hygiene, bladder: 0..100 (100 = fully satisfied). They go down slowly with
 *    GAME time (realism-config.js -> needs.rates, points per game hour; one game hour = one real minute with
 *    the default day length). Sleeping (bed) restores energy; eating / drinking (fridge, stove), the toilet,
 *    the shower and the sink restore the others (RealismInteractions.ts).
 *  - Small HUD: 5 round icons with a fill ring, bottom-left just above the minimap (A12, ~200x140 px).
 *  - Toasts when a need gets low, and (world as any).realismEvents?.emit('needLow', { name }).
 *  - No death, no damage. Only optional penalty: slower sprint while energy < 10 (needs.sprintPenalty).
 *  - Saved in localStorage 'realism.needs.v1' as { v: 1, hunger, thirst, energy, hygiene, bladder }.
 *
 * API (C11): (world as any).realismNeeds = { get(name), add(name, delta), onChange(cb) } plus
 *            set(name, value), all(), setEnabled(on), decay(hours, factors?) (used by the bed time skip).
 * Respects realismPaused (no decay while paused). No per-frame allocations: the HUD is touched only when a
 * rounded value changes.
 */

import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { deepMerge } from './RealismConfig';
import { Sprint } from '../characters/character_states/_stateLibrary';

export const NEED_NAMES = ['hunger', 'thirst', 'energy', 'hygiene', 'bladder'];
const STORE_KEY = 'realism.needs.v1';

export const DEFAULT_NEEDS = {
	enabled: true,
	hud: true,              // the 5 small icons above the minimap
	toasts: true,           // "You're hungry" etc. when a need gets low
	lowThreshold: 20,       // a need below this is "low" (toast + needLow event)
	sprintPenalty: true,    // energy < 10: sprint is slower
	rates: {                // points lost per GAME hour (100 = full)
		hunger: 4.5,
		thirst: 6,
		energy: 4,
		hygiene: 3,
		bladder: 7,
	},
	sleepRates: {           // multipliers on the rates while sleeping
		hunger: 0.5, thirst: 0.5, energy: 0, hygiene: 0.5, bladder: 0.4,
	},
	swimEnergyFactor: 2,    // energy goes down this much faster while swimming
	hudBottom: 160,         // HUD position in px from the bottom-left corner (above A12's 200x140 minimap)
	hudLeft: 16,
};

const LABELS: { [k: string]: string } = { hunger: 'Hunger', thirst: 'Thirst', energy: 'Energy', hygiene: 'Hygiene', bladder: 'Bladder' };
const LOW_TEXT: { [k: string]: string } = {
	hunger: "You're hungry. Grab something from a fridge or cook on a stove.",
	thirst: "You're thirsty. Get a drink from a fridge.",
	energy: "You're tired. Find a bed to sleep.",
	hygiene: 'You need a shower.',
	bladder: 'You need a restroom.',
};
// tiny glyphs (SVG path data, 24x24 view box)
const ICONS: { [k: string]: string } = {
	hunger: 'M7 3v7a2 2 0 0 0 2 2v9h2v-9a2 2 0 0 0 2-2V3h-1.5v6h-1V3h-1v6h-1V3zM16 3c-1.7 0-3 2-3 5v5h2v8h2V3z',
	thirst: 'M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11z',
	energy: 'M13 2 5 14h6l-2 8 8-12h-6z',
	hygiene: 'M7 9a3 3 0 1 0 0.01 0zM15 5a2.2 2.2 0 1 0 0.01 0zM14 12a4 4 0 1 0 0.01 0z',
	bladder: 'M6 3h12v6c0 3-2 5-5 5.5V18h3v3H8v-3h3v-3.5C8 14 6 12 6 9z',
};

// ---------------------------------------------------------------------------
// toast (own element; RealismJobs has its own)
// ---------------------------------------------------------------------------

let toastEl: any = null;
let toastTimer: any = null;
export let lastToast = '';

/** Short message at the top centre of the screen. Safe headless. */
export function realismToast(text: string, ms?: number): void
{
	lastToast = text;
	try
	{
		if (typeof document === 'undefined' || !document.body) return;
		if (!toastEl)
		{
			toastEl = document.createElement('div');
			toastEl.id = 'rr-a14-toast';
			const st = toastEl.style;
			st.position = 'fixed'; st.left = '50%'; st.top = '64px'; st.transform = 'translateX(-50%)';
			st.padding = '8px 16px'; st.borderRadius = '18px'; st.background = 'rgba(12,14,20,0.78)';
			st.color = '#fff'; st.font = '600 14px system-ui, sans-serif'; st.zIndex = '60';
			st.pointerEvents = 'none'; st.transition = 'opacity 0.25s'; st.opacity = '0';
			st.boxShadow = '0 2px 10px rgba(0,0,0,0.35)';
			document.body.appendChild(toastEl);
		}
		toastEl.textContent = text;
		toastEl.style.opacity = '1';
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; toastTimer = null; }, ms || 2600);
	}
	catch (e) { /* headless */ }
}

// ---------------------------------------------------------------------------

export class RealismNeeds implements IUpdatable
{
	public updateOrder: number = 9.5;
	public settings: any;
	public values: { [k: string]: number } = { hunger: 100, thirst: 100, energy: 100, hygiene: 100, bladder: 100 };
	public swimming = false;     // set by RealismSwim (energy goes faster)
	public sleeping = false;     // set while the bed time skip runs
	public stats = { decayHours: 0, lowEvents: 0, hudUpdates: 0 };

	private world: any;
	private listeners: (() => void)[] = [];
	private low: { [k: string]: boolean } = {};
	private lastHour = -1;
	private saveAcc = 0;
	private dirty = false;
	private hud: any = null;
	private rings: { [k: string]: any } = {};
	private shown: { [k: string]: number } = {};
	private penaltyOn = false;

	constructor(ctx: RealismCtx)
	{
		this.world = ctx.world;
		const user = (ctx.cfg as any).needs;
		this.settings = deepMerge(DEFAULT_NEEDS, user && typeof user === 'object' ? user : {});
		this.load();
		for (let i = 0; i < NEED_NAMES.length; i++) this.low[NEED_NAMES[i]] = this.values[NEED_NAMES[i]] < this.settings.lowThreshold;
		const self = this;
		this.world.realismNeeds = {
			get(name: string): number { return self.get(name); },
			add(name: string, delta: number): void { self.add(name, delta); },
			set(name: string, v: number): void { self.set(name, v); },
			onChange(cb: () => void): void { if (typeof cb === 'function') self.listeners.push(cb); },
			all(): { [k: string]: number } { return { hunger: self.values.hunger, thirst: self.values.thirst, energy: self.values.energy, hygiene: self.values.hygiene, bladder: self.values.bladder }; },
			setEnabled(on: boolean): void { self.settings.enabled = !!on; self.showHud(); },
			decay(hours: number, factors?: { [k: string]: number }): void { self.decay(hours, factors); },
			get enabled(): boolean { return self.settings.enabled !== false; },
			system: this,
		};
		this.buildHud();
		this.refreshHud(true);
	}

	public get(name: string): number
	{
		const v = this.values[name];
		return typeof v === 'number' ? v : 100;
	}

	public set(name: string, v: number): void
	{
		if (!(name in this.values)) return;
		const nv = Math.max(0, Math.min(100, Number(v) || 0));
		if (nv === this.values[name]) return;
		this.values[name] = nv;
		this.changed(name);
	}

	public add(name: string, delta: number): void
	{
		if (!(name in this.values)) return;
		this.set(name, this.values[name] + (Number(delta) || 0));
	}

	/** Lowers every need by `hours` game hours of decay (optional per-need multipliers). */
	public decay(hours: number, factors?: { [k: string]: number }): void
	{
		if (!(hours > 0) || this.settings.enabled === false) return;
		const r = this.settings.rates || {};
		this.stats.decayHours += hours;
		for (let i = 0; i < NEED_NAMES.length; i++)
		{
			const n = NEED_NAMES[i];
			let k = factors && typeof factors[n] === 'number' ? factors[n] : 1;
			if (n === 'energy' && this.swimming && !factors) k *= Number(this.settings.swimEnergyFactor) || 1;
			const d = (Number(r[n]) || 0) * k * hours;
			if (d !== 0) this.values[n] = Math.max(0, Math.min(100, this.values[n] - d));
		}
		for (let i = 0; i < NEED_NAMES.length; i++) this.checkLow(NEED_NAMES[i]);
		this.dirty = true;
		this.refreshHud(false);
	}

	private changed(name: string): void
	{
		this.dirty = true;
		this.checkLow(name);
		this.refreshHud(false);
		for (let i = 0; i < this.listeners.length; i++) { try { this.listeners[i](); } catch (e) { console.warn('[Realism] needs listener failed', e); } }
	}

	private checkLow(name: string): void
	{
		const th = Number(this.settings.lowThreshold) || 20;
		const isLow = this.values[name] < th;
		if (isLow && !this.low[name])
		{
			this.stats.lowEvents++;
			if (this.settings.toasts !== false && this.settings.enabled !== false) realismToast(LOW_TEXT[name] || (LABELS[name] + ' is low'), 3500);
			const ev = this.world.realismEvents;
			if (ev && typeof ev.emit === 'function') { try { ev.emit('needLow', { name: name }); } catch (e) { /* listener error */ } }
		}
		if (!isLow && this.values[name] >= th + 5) this.low[name] = false;
		else if (isLow) this.low[name] = true;
	}

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		const w = this.world;
		const dt = Math.min(0.25, Math.max(0, unscaledTimeStep !== undefined ? unscaledTimeStep : timeStep));
		// game time
		const t = w.realismTime;
		if (w.realismPaused !== true && this.settings.enabled !== false && !this.sleeping)
		{
			let dh = 0;
			if (t && typeof t.hour === 'number')
			{
				if (this.lastHour >= 0)
				{
					dh = t.hour - this.lastHour;
					if (dh < 0) dh += 24;
					if (dh > 1) dh = 0;   // someone set the clock (time slider / sleep): no decay jump
				}
				this.lastHour = t.hour;
			}
			else dh = dt / 60;
			if (dh > 0) this.decay(dh);
		}
		else if (t && typeof t.hour === 'number') this.lastHour = t.hour;
		// sprint penalty
		this.applyPenalty();
		// save every few seconds when something changed
		this.saveAcc += dt;
		if (this.saveAcc > 5) { this.saveAcc = 0; if (this.dirty) this.save(); }
		if (this.hud) this.hud.style.display = this.hudVisible() ? 'flex' : 'none';
	}

	private applyPenalty(): void
	{
		const w = this.world;
		const r = w.inputManager && w.inputManager.inputReceiver;
		const want = this.settings.enabled !== false && this.settings.sprintPenalty !== false && this.values.energy < 10;
		const ch: any = r && r.characterCapsule !== undefined ? r : null;
		if (ch === null) return;
		const st = ch.charState;
		const sprinting = st instanceof Sprint;
		if (want && sprinting && ch.velocityTarget.z > 1.0) { ch.velocityTarget.z = 1.0; this.penaltyOn = true; }
		else if (this.penaltyOn && !want) this.penaltyOn = false;
	}

	private hudVisible(): boolean
	{
		const w = this.world;
		if (this.settings.enabled === false || this.settings.hud === false) return false;
		if (w.realismSkipRender === true) return false;           // start screen
		return true;
	}

	// -------------------------------------------------------------------- HUD

	private buildHud(): void
	{
		try
		{
			if (typeof document === 'undefined' || !document.body) return;
			const el = document.createElement('div');
			el.id = 'rr-needs-hud';
			const st = el.style;
			st.position = 'fixed'; st.left = (Number(this.settings.hudLeft) || 16) + 'px'; st.bottom = (Number(this.settings.hudBottom) || 160) + 'px';
			st.display = 'none'; st.gap = '5px'; st.zIndex = '40'; st.pointerEvents = 'none';
			for (let i = 0; i < NEED_NAMES.length; i++)
			{
				const n = NEED_NAMES[i];
				const box = document.createElement('div');
				box.title = LABELS[n];
				box.style.width = '28px'; box.style.height = '28px'; box.style.position = 'relative';
				box.innerHTML =
					'<svg width="28" height="28" viewBox="0 0 28 28" style="position:absolute;left:0;top:0">' +
					'<circle cx="14" cy="14" r="13" fill="rgba(10,12,16,0.62)"/>' +
					'<circle cx="14" cy="14" r="11.5" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2.5"/>' +
					'<circle class="ring" cx="14" cy="14" r="11.5" fill="none" stroke="#7ee08a" stroke-width="2.5" stroke-linecap="round" ' +
					'stroke-dasharray="72.26" stroke-dashoffset="0" transform="rotate(-90 14 14)"/>' +
					'<g transform="translate(7.4 7.4) scale(0.55)"><path d="' + ICONS[n] + '" fill="#fff"/></g></svg>';
				el.appendChild(box);
				this.rings[n] = box.querySelector('.ring');
			}
			document.body.appendChild(el);
			this.hud = el;
		}
		catch (e) { this.hud = null; }
	}

	private showHud(): void { if (this.hud) this.hud.style.display = this.hudVisible() ? 'flex' : 'none'; }

	private refreshHud(force: boolean): void
	{
		if (!this.hud) return;
		for (let i = 0; i < NEED_NAMES.length; i++)
		{
			const n = NEED_NAMES[i];
			const v = Math.round(this.values[n]);
			if (!force && this.shown[n] === v) continue;
			this.shown[n] = v;
			const ring = this.rings[n];
			if (!ring) continue;
			ring.setAttribute('stroke-dashoffset', String(72.26 * (1 - v / 100)));
			ring.setAttribute('stroke', v < 15 ? '#ff5a4e' : v < 35 ? '#ffc24a' : '#7ee08a');
			this.stats.hudUpdates++;
		}
	}

	// ---------------------------------------------------------------- storage

	private load(): void
	{
		try
		{
			const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
			if (!raw) return;
			const o = JSON.parse(raw);
			if (!o || o.v !== 1) return;
			for (let i = 0; i < NEED_NAMES.length; i++)
			{
				const n = NEED_NAMES[i];
				if (typeof o[n] === 'number' && isFinite(o[n])) this.values[n] = Math.max(0, Math.min(100, o[n]));
			}
		}
		catch (e) { /* corrupt or private mode */ }
	}

	public save(): void
	{
		this.dirty = false;
		try
		{
			if (typeof localStorage === 'undefined') return;
			const v = this.values;
			localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, hunger: Math.round(v.hunger * 10) / 10, thirst: Math.round(v.thirst * 10) / 10, energy: Math.round(v.energy * 10) / 10, hygiene: Math.round(v.hygiene * 10) / 10, bladder: Math.round(v.bladder * 10) / 10 }));
		}
		catch (e) { /* private mode */ }
	}
}
