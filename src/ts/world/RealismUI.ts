/*
 * RealismUI.ts
 * ------------
 * Start / home screen, pause menu, Settings (shared by both), Controls help and the shared
 * UI flags other systems use.
 *
 *  - The start screen shows as soon as the page opens (title, loading progress, Play,
 *    Settings, Controls). The world is paused behind it (time scale 0) and not drawn.
 *  - Esc (or losing pointer lock while playing) opens the pause menu: Resume, Settings,
 *    Controls, Quit to title. Play / Resume grab the mouse again.
 *  - Settings apply live through RealismPerformance / RealismDayNight and are saved to
 *    localStorage (RealismSettingsStore), re-applied on the next load.
 *  - P opens the phone (RealismPhone).
 *
 * Shared flags on the world (other developers rely on these, keep them):
 *   (world as any).realismPaused: boolean       start screen or pause menu open (time scale is 0 then)
 *   (world as any).realismUIBlocking: boolean   any UI owner is open: ignore gameplay input
 *   (world as any).realismSetUIBlocking(owner: string, on: boolean)
 *        adds / removes an owner; realismUIBlocking = at least one owner. Built-in owners:
 *        'startScreen', 'pauseMenu', 'settings', 'phone'. (The weapon wheel uses 'weaponWheel'.)
 *   (world as any).realismVolume: number        master volume 0..1
 *   (world as any).realismNPCDensity: number    NPC density 0..2 (also pushed to realismNPCs.setDensity)
 */

import { IUpdatable } from '../interfaces/IUpdatable';
import { UIManager } from '../core/UIManager';
import { RealismCtx } from './RealismContext';
import { RealismDayNight } from './RealismDayNight';
import { RealismPhone } from './RealismPhone';
import { SavedSettings, readSaved, writeSaved, clearSaved } from './RealismSettingsStore';
import { detectPreset } from './RealismConfig';

type UIState = 'start' | 'playing' | 'paused';

interface Row { refresh: () => void; }

const STATIC_CONTROLS = [
	{ keys: ['W', 'A', 'S', 'D'], desc: 'Move' },
	{ keys: ['Shift'], desc: 'Sprint' },
	{ keys: ['Space'], desc: 'Jump' },
	{ keys: ['E'], desc: 'Use / interact' },
	{ keys: ['F', 'or', 'G'], desc: 'Enter vehicle (driver / passenger)' },
	{ keys: ['Mouse'], desc: 'Look around' },
	{ keys: ['Shift', '+', 'C'], desc: 'Free camera' },
	{ keys: ['Shift', '+', 'R'], desc: 'Respawn' },
];
const MENU_CONTROLS = [
	{ keys: ['P'], desc: 'Phone (open / close)' },
	{ keys: ['Esc'], desc: 'Pause menu' },
];

function now(): number { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }

function esc(s: any): string
{
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' } as any)[c]);
}

export function controlsHTML(list: any[]): string
{
	let html = '';
	for (const row of list || [])
	{
		html += '<div class="rr-ctrl-row">';
		for (const key of row.keys || [])
		{
			if (key === '+' || key === 'and' || key === 'or' || key === '&') html += '<span class="rr-ctrl-join">' + esc(key) + '</span>';
			else html += '<span class="rr-key">' + esc(key) + '</span>';
		}
		html += '<span class="rr-ctrl-desc">' + esc(row.desc) + '</span></div>';
	}
	return html;
}

export class RealismUI implements IUpdatable
{
	public updateOrder: number = 1;
	public state: UIState = 'start';
	public world: any;
	public ctx: RealismCtx = null;
	public dayNight: RealismDayNight = null;
	public phone: RealismPhone = null;
	public saved: SavedSettings;

	private owners: { [owner: string]: boolean } = {};
	private loaded = false;
	private loadingManager: any = null;
	private prevTimeScale = 1;
	private contextControls: any[] = [];
	private expectUnlockUntil = 0;
	private pauseOpenedAt = 0;
	private played = false;
	private settingsFrom: string = null;
	private controlsFrom: string = null;
	private rows: Row[] = [];
	private saveTimer: any = null;
	private treeCapacity = 0;
	private uiAcc = 0;

	private root: HTMLElement = null;
	private startEl: HTMLElement = null;
	private pauseEl: HTMLElement = null;
	private settingsEl: HTMLElement = null;
	private settingsBody: HTMLElement = null;
	private controlsEl: HTMLElement = null;
	private playBtn: HTMLElement = null;
	private settingsBtn: HTMLElement = null;
	private progressBar: HTMLElement = null;
	private progressText: HTMLElement = null;

	constructor(world: any)
	{
		this.world = world;
		this.saved = readSaved();
		world.realismUI = this;
		world.realismPaused = true;
		world.realismUIBlocking = false;
		world.realismSetUIBlocking = (owner: string, on: boolean) => this.setBlocking(owner, on);
		world.realismVolume = typeof this.saved.volume === 'number' ? Math.max(0, Math.min(1, this.saved.volume)) : 0.8;
		world.realismNPCDensity = typeof this.saved.npcDensity === 'number' ? Math.max(0, Math.min(2, this.saved.npcDensity)) : 1;
		world.realismSkipRender = true;   // nothing to draw behind the opaque start screen

		try { this.buildDOM(); }
		catch (e) { console.warn('[Realism] UI could not be built', e); }

		this.setBlocking('startScreen', true);
		this.refreshFlags();
		try { world.setTimeScale(0); } catch (e) { /* params not ready */ }

		try
		{
			window.addEventListener('keydown', (e: KeyboardEvent) => this.onKeyDown(e), true);
			document.addEventListener('pointerlockchange', () => this.onPointerLockChange(), false);
			document.addEventListener('visibilitychange', () =>
			{
				if ((document as any).hidden && this.state === 'playing') this.openPause();
			}, false);
		}
		catch (e) { /* headless */ }

		try { UIManager.setDevPanelVisible(this.saved.devPanel === true); } catch (e) { /* no dat.GUI */ }
		world.registerUpdatable(this);
	}

	// ------------------------------------------------------------------ flags

	public setBlocking(owner: string, on: boolean): void
	{
		const was = !!this.world.realismUIBlocking;
		if (on) this.owners[owner] = true;
		else delete this.owners[owner];
		const blocking = Object.keys(this.owners).length > 0;
		this.world.realismUIBlocking = blocking;
		if (blocking && !was && this.world.inputManager && this.world.inputManager.releaseAll) this.world.inputManager.releaseAll();
	}

	public isBlockedBy(owner: string): boolean { return !!this.owners[owner]; }

	/** True when an owner other than these is blocking (e.g. the weapon wheel). */
	public blockedByOthers(except: string[]): boolean
	{
		for (const k in this.owners) if (this.owners.hasOwnProperty(k) && except.indexOf(k) < 0) return true;
		return false;
	}

	private refreshFlags(): void
	{
		this.world.realismPaused = this.state !== 'playing';
	}

	// ------------------------------------------------------------------ hook from the world builder

	/** Called once the county is built (RealismWorldBuilder). Starts day / night and the phone,
	 *  applies the saved settings and takes over the loading-finished callback (no welcome popup). */
	public attach(ctx: RealismCtx, loadingManager: any): void
	{
		this.ctx = ctx;
		this.loadingManager = loadingManager;
		const w = this.world;
		if (loadingManager)
		{
			loadingManager.onFinishedCallback = () =>
			{
				try { w.update(1, 1); } catch (e) { console.warn('[Realism] first update failed', e); }
				w.setTimeScale(0);
				this.onLoaded();
			};
		}
		this.dayNight = new RealismDayNight(ctx);
		w.registerUpdatable(this.dayNight);

		// saved settings not handled by the config merge
		const sens = this.saved.mouseSensitivity;
		if (typeof sens === 'number' && w.cameraOperator)
		{
			w.params.Mouse_Sensitivity = sens;
			w.cameraOperator.setSensitivity(sens, sens * 0.8);
		}
		const lod = w.realismTreeLOD;
		this.treeCapacity = lod ? Math.max(1, (lod as any).nearCount || 1) : 0;
		this.applyNPCDensity(w.realismNPCDensity);

		try { this.phone = new RealismPhone(this, ctx); }
		catch (e) { console.warn('[Realism] Phone could not be built', e); }
		try { this.buildSettings(); } catch (e) { console.warn('[Realism] Settings could not be built', e); }
		if (this.settingsBtn) this.settingsBtn.removeAttribute('disabled');
		if (this.progressText) this.progressText.textContent = 'Loading characters and vehicles...';
	}

	private onLoaded(): void
	{
		this.loaded = true;
		if (this.playBtn)
		{
			this.playBtn.removeAttribute('disabled');
			this.playBtn.textContent = this.played ? 'Continue' : 'Play';
		}
		if (this.progressBar) this.progressBar.style.width = '100%';
		if (this.progressText) this.progressText.textContent = 'Ready';
		// draw a few frames hidden behind the start screen so shaders compile before Play
		this.world.realismSkipRender = false;
		setTimeout(() => { if (this.state === 'start') this.world.realismSkipRender = true; }, 600);
	}

	/** A scenario relaunch (Shift+R respawn, dev panel) finished loading: no welcome popup,
	 *  carry on playing (or stay paused if a menu is open). Set up by World.launchScenario. */
	public onScenarioLoaded(): void
	{
		try { this.world.update(1, 1); } catch (e) { /* ignore */ }
		if (this.state === 'playing') this.world.setTimeScale(this.prevTimeScale > 0 ? this.prevTimeScale : 1);
		else this.world.setTimeScale(0);
	}

	/** Polls the loading progress and keeps the phone clock ticking. */
	public update(timeStep: number, unscaledTimeStep: number): void
	{
		this.uiAcc += unscaledTimeStep || 0;
		if (this.uiAcc < 0.25) return;
		this.uiAcc = 0;
		if (!this.loaded && this.loadingManager && this.progressBar)
		{
			const list: any[] = this.loadingManager.loadingTracker || [];
			if (list.length > 0)
			{
				let f = 0;
				for (const e of list) f += e.progress || 0;
				const pct = Math.round(30 + 70 * f / list.length);
				this.progressBar.style.width = pct + '%';
				if (this.progressText) this.progressText.textContent = 'Loading ' + pct + '%';
			}
		}
		if (this.phone) this.phone.tick();
	}

	// ------------------------------------------------------------------ Sketchbook controls list

	/** World.updateControls lands here: the list is shown in Controls, not on the HUD. */
	public setContextControls(list: any[]): void
	{
		this.contextControls = list || [];
		if (this.controlsEl && this.controlsEl.style.display !== 'none') this.renderControls();
	}

	// ------------------------------------------------------------------ states

	public play(): void
	{
		if (!this.loaded || this.state !== 'start') return;
		this.played = true;
		this.show(this.startEl, false);
		this.closeSubpages();
		this.setBlocking('startScreen', false);
		this.state = 'playing';
		this.refreshFlags();
		this.world.realismSkipRender = false;
		this.world.setTimeScale(this.prevTimeScale > 0 ? this.prevTimeScale : 1);
		this.requestLock();
	}

	public openPause(): void
	{
		if (this.state !== 'playing') return;
		if (this.phone && this.phone.isOpen) this.phone.close(false);
		this.state = 'paused';
		this.refreshFlags();
		this.pauseOpenedAt = now();
		this.prevTimeScale = this.world.timeScaleTarget > 0 ? this.world.timeScaleTarget : 1;
		this.world.setTimeScale(0);
		this.setBlocking('pauseMenu', true);
		this.show(this.pauseEl, true);
		this.exitLock();
	}

	public resume(): void
	{
		if (this.state !== 'paused') return;
		this.closeSubpages();
		this.show(this.pauseEl, false);
		this.setBlocking('pauseMenu', false);
		this.state = 'playing';
		this.refreshFlags();
		this.world.setTimeScale(this.prevTimeScale > 0 ? this.prevTimeScale : 1);
		this.requestLock();
	}

	public quitToTitle(): void
	{
		if (this.state !== 'paused') return;
		this.closeSubpages();
		this.show(this.pauseEl, false);
		this.setBlocking('pauseMenu', false);
		this.state = 'start';
		this.refreshFlags();
		this.setBlocking('startScreen', true);
		if (this.playBtn) this.playBtn.textContent = 'Continue';
		this.show(this.startEl, true);
		this.world.realismSkipRender = true;
		this.exitLock();
	}

	/** Settings from the phone: pause the game and open Settings on top of the pause menu. */
	public openSettingsFromPhone(): void
	{
		if (this.state === 'playing') this.openPause();
		if (this.state === 'paused') this.openSettings('pause');
	}

	public openSettings(from: string): void
	{
		if (!this.settingsEl || !this.ctx) return;
		this.settingsFrom = from;
		this.refreshSettings();
		this.show(from === 'start' ? this.startEl : this.pauseEl, false);
		this.show(this.settingsEl, true);
		this.setBlocking('settings', true);
	}

	public closeSettings(): void
	{
		if (!this.settingsEl || this.settingsEl.style.display === 'none') return;
		this.show(this.settingsEl, false);
		this.setBlocking('settings', false);
		this.flushSave();
		this.show(this.settingsFrom === 'start' ? this.startEl : this.pauseEl, true);
		this.settingsFrom = null;
	}

	public openControls(from: string): void
	{
		if (!this.controlsEl) return;
		this.controlsFrom = from;
		this.renderControls();
		this.show(from === 'start' ? this.startEl : this.pauseEl, false);
		this.show(this.controlsEl, true);
	}

	public closeControls(): void
	{
		if (!this.controlsEl || this.controlsEl.style.display === 'none') return;
		this.show(this.controlsEl, false);
		this.show(this.controlsFrom === 'start' ? this.startEl : this.pauseEl, true);
		this.controlsFrom = null;
	}

	private closeSubpages(): void
	{
		if (this.settingsEl && this.settingsEl.style.display !== 'none') { this.show(this.settingsEl, false); this.flushSave(); }
		if (this.controlsEl) this.show(this.controlsEl, false);
		this.setBlocking('settings', false);
		this.settingsFrom = null;
		this.controlsFrom = null;
	}

	// ------------------------------------------------------------------ pointer lock / keys

	public requestLock(): void
	{
		try
		{
			const canvas: any = this.world.renderer ? this.world.renderer.domElement : null;
			if (canvas && this.world.params.Pointer_Lock && canvas.requestPointerLock) canvas.requestPointerLock();
		}
		catch (e) { /* the next click on the game grabs the mouse */ }
	}

	public exitLock(): void
	{
		try
		{
			if (document.pointerLockElement)
			{
				this.expectUnlockUntil = now() + 1000;
				document.exitPointerLock();
			}
		}
		catch (e) { /* headless */ }
	}

	private onPointerLockChange(): void
	{
		if (document.pointerLockElement) return;
		// the browser released the mouse (Esc) while playing: pause, unless we released it ourselves
		// (phone) or another UI owner (e.g. the weapon wheel) did
		if (this.state !== 'playing' || now() < this.expectUnlockUntil) return;
		if (this.world.realismUIBlocking) return;
		this.openPause();
	}

	private onKeyDown(e: KeyboardEvent): void
	{
		const t: any = e.target;
		if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text'))) return;
		const consume = () => { e.preventDefault(); e.stopPropagation(); };
		if (e.code === 'Escape')
		{
			consume();
			if (now() - this.pauseOpenedAt < 350) return;   // the same Esc that released the mouse
			if (this.controlsEl && this.controlsEl.style.display !== 'none') this.closeControls();
			else if (this.settingsEl && this.settingsEl.style.display !== 'none') this.closeSettings();
			else if (this.state === 'paused') this.resume();
			else if (this.phone && this.phone.isOpen) this.phone.close(true);
			else if (this.state === 'playing' && !this.blockedByOthers([])) this.openPause();
			return;
		}
		if (this.state !== 'playing') return;
		if (e.code === 'KeyP' && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey)
		{
			if (!this.phone || this.blockedByOthers(['phone'])) return;
			consume();
			this.phone.toggle();
			return;
		}
		if (this.phone && this.phone.isOpen && this.phone.handleKey(e)) consume();
	}

	// ------------------------------------------------------------------ DOM

	private show(el: HTMLElement, on: boolean): void
	{
		if (el) el.style.display = on ? '' : 'none';
	}

	private buildDOM(): void
	{
		const root = document.createElement('div');
		root.id = 'rr-ui';
		this.root = root;

		const start = document.createElement('div');
		start.className = 'rr-screen rr-start';
		start.innerHTML =
			'<div class="rr-start-bg"></div>' +
			'<div class="rr-start-inner">' +
				'<div class="rr-subtitle">Realism Roleplay</div>' +
				'<h1 class="rr-title">San Verano County</h1>' +
				'<div class="rr-menu">' +
					'<button class="rr-btn rr-primary" data-act="play" disabled>Loading...</button>' +
					'<button class="rr-btn" data-act="settings" disabled>Settings</button>' +
					'<button class="rr-btn" data-act="controls">Controls</button>' +
				'</div>' +
				'<div class="rr-progress"><div class="rr-progress-bar"></div></div>' +
				'<div class="rr-progress-text">Building San Verano County...</div>' +
				'<div class="rr-hint">P: phone &nbsp;|&nbsp; Esc: pause</div>' +
			'</div>';
		root.appendChild(start);
		this.startEl = start;

		const pause = document.createElement('div');
		pause.className = 'rr-screen rr-pause';
		pause.style.display = 'none';
		pause.innerHTML =
			'<div class="rr-card">' +
				'<h2 class="rr-card-title">Paused</h2>' +
				'<div class="rr-menu">' +
					'<button class="rr-btn rr-primary" data-act="resume">Resume</button>' +
					'<button class="rr-btn" data-act="map">Map</button>' +
					'<button class="rr-btn" data-act="settings">Settings</button>' +
					'<button class="rr-btn" data-act="controls">Controls</button>' +
					'<button class="rr-btn rr-danger" data-act="quit">Quit to title</button>' +
				'</div>' +
			'</div>';
		root.appendChild(pause);
		this.pauseEl = pause;

		const settings = document.createElement('div');
		settings.className = 'rr-screen rr-settings';
		settings.style.display = 'none';
		settings.innerHTML =
			'<div class="rr-card rr-wide">' +
				'<div class="rr-card-head"><h2 class="rr-card-title">Settings</h2><button class="rr-btn rr-small" data-act="back">Back</button></div>' +
				'<div class="rr-settings-body"></div>' +
			'</div>';
		root.appendChild(settings);
		this.settingsEl = settings;
		this.settingsBody = settings.querySelector('.rr-settings-body') as HTMLElement;

		const controls = document.createElement('div');
		controls.className = 'rr-screen rr-controls';
		controls.style.display = 'none';
		controls.innerHTML =
			'<div class="rr-card rr-wide">' +
				'<div class="rr-card-head"><h2 class="rr-card-title">Controls</h2><button class="rr-btn rr-small" data-act="back">Back</button></div>' +
				'<div class="rr-controls-body"></div>' +
			'</div>';
		root.appendChild(controls);
		this.controlsEl = controls;

		document.body.appendChild(root);

		this.playBtn = start.querySelector('[data-act="play"]') as HTMLElement;
		this.settingsBtn = start.querySelector('[data-act="settings"]') as HTMLElement;
		this.progressBar = start.querySelector('.rr-progress-bar') as HTMLElement;
		this.progressText = start.querySelector('.rr-progress-text') as HTMLElement;
		if (this.progressBar) this.progressBar.style.width = '8%';

		const on = (parent: HTMLElement, act: string, fn: () => void) =>
		{
			const b = parent.querySelector('[data-act="' + act + '"]');
			if (b) b.addEventListener('click', (ev: Event) => { ev.preventDefault(); fn(); });
		};
		on(start, 'play', () => this.play());
		on(start, 'settings', () => this.openSettings('start'));
		on(start, 'controls', () => this.openControls('start'));
		on(pause, 'resume', () => this.resume());
		on(pause, 'map', () => { this.resume(); const mm = this.world.realismMinimap; if (mm && typeof mm.openBigMap === 'function') mm.openBigMap(true); });   // full-screen map (RealismMinimap)
		on(pause, 'settings', () => this.openSettings('pause'));
		on(pause, 'controls', () => this.openControls('pause'));
		on(pause, 'quit', () => this.quitToTitle());
		on(settings, 'back', () => this.closeSettings());
		on(controls, 'back', () => this.closeControls());
	}

	private renderControls(): void
	{
		const body = this.controlsEl ? this.controlsEl.querySelector('.rr-controls-body') : null;
		if (!body) return;
		const ctx = this.contextControls && this.contextControls.length ? this.contextControls : STATIC_CONTROLS;
		body.innerHTML =
			'<h3 class="rr-section">On foot / current vehicle</h3>' + controlsHTML(ctx) +
			'<h3 class="rr-section">Menus</h3>' + controlsHTML(MENU_CONTROLS);
	}

	// ------------------------------------------------------------------ settings

	private section(title: string): void
	{
		const h = document.createElement('h3');
		h.className = 'rr-section';
		h.textContent = title;
		this.settingsBody.appendChild(h);
	}

	private rowEl(label: string): { row: HTMLElement, value: HTMLElement }
	{
		const row = document.createElement('div');
		row.className = 'rr-row';
		const l = document.createElement('label');
		l.className = 'rr-label';
		l.textContent = label;
		const v = document.createElement('span');
		v.className = 'rr-value';
		row.appendChild(l);
		row.appendChild(v);
		this.settingsBody.appendChild(row);
		return { row: row, value: v };
	}

	private slider(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt?: (v: number) => string): void
	{
		const r = this.rowEl(label);
		const input: any = document.createElement('input');
		input.type = 'range';
		input.min = String(min); input.max = String(max); input.step = String(step);
		input.className = 'rr-range';
		r.row.insertBefore(input, r.value);
		const show = (v: number) => { r.value.textContent = fmt ? fmt(v) : String(Math.round(v * 100) / 100); };
		input.addEventListener('input', () =>
		{
			const v = parseFloat(input.value);
			if (isNaN(v)) return;
			show(v);
			set(v);
			this.scheduleSave();
		});
		this.rows.push({ refresh: () => { const v = get(); input.value = String(v); show(v); } });
	}

	private toggle(label: string, get: () => boolean, set: (v: boolean) => void): void
	{
		const r = this.rowEl(label);
		const input: any = document.createElement('input');
		input.type = 'checkbox';
		input.className = 'rr-check';
		r.row.insertBefore(input, r.value);
		input.addEventListener('change', () => { set(!!input.checked); this.scheduleSave(); this.refreshSettings(); });
		this.rows.push({ refresh: () => { input.checked = !!get(); } });
	}

	private select(label: string, options: string[][], get: () => string, set: (v: string) => void): void
	{
		const r = this.rowEl(label);
		const sel: any = document.createElement('select');
		sel.className = 'rr-select';
		for (const o of options)
		{
			const opt: any = document.createElement('option');
			opt.value = o[0];
			opt.textContent = o[1];
			sel.appendChild(opt);
		}
		r.row.insertBefore(sel, r.value);
		sel.addEventListener('change', () => { set(sel.value); this.scheduleSave(); this.refreshSettings(); });
		this.rows.push({ refresh: () => { sel.value = get(); } });
	}

	private button(label: string, text: string, fn: (b: HTMLElement) => void): void
	{
		const r = this.rowEl(label);
		const b = document.createElement('button');
		b.className = 'rr-btn rr-small';
		b.textContent = text;
		b.addEventListener('click', (ev: Event) => { ev.preventDefault(); fn(b); });
		r.row.insertBefore(b, r.value);
	}

	public refreshSettings(): void
	{
		for (const r of this.rows) { try { r.refresh(); } catch (e) { /* headless */ } }
	}

	private perfValue(key: string): any
	{
		const perf = this.world.realismPerformance;
		return perf ? (perf.getBase() as any)[key] : undefined;
	}

	private setPerf(key: string, v: any): void
	{
		const perf = this.world.realismPerformance;
		if (!perf) return;
		const o: any = {};
		o[key] = v;
		perf.setValues(o);
		if (!this.saved.perf) this.saved.perf = {};
		this.saved.perf[key] = v;
	}

	private applyNPCDensity(v: number): void
	{
		this.world.realismNPCDensity = v;
		const npcs = this.world.realismNPCs;
		if (npcs && typeof npcs.setDensity === 'function')
		{
			try { npcs.setDensity(v); } catch (e) { console.warn('[Realism] realismNPCs.setDensity failed', e); }
		}
	}

	private buildSettings(): void
	{
		if (!this.settingsBody) return;
		const w = this.world, cfg: any = this.ctx.cfg, sv = this.saved;
		const perf = () => w.realismPerformance;
		const m = (v: number) => Math.round(v) + ' m';
		this.rows = [];
		this.settingsBody.innerHTML = '';

		this.section('Graphics');
		const auto = detectPreset();
		this.select('Quality preset', [['auto', 'Auto (' + auto + ')'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']],
			() => cfg.performance.preset || 'auto',
			(v) => { if (perf()) perf().setPreset(v); sv.preset = v; sv.perf = {}; });
		this.toggle('Auto-adjust to hold target FPS', () => cfg.performance.adaptive !== false, (v) => { if (perf()) perf().setAdaptive(v); sv.adaptive = v; });
		this.slider('Target FPS', 20, 60, 5, () => cfg.performance.targetFps || 30, (v) => { if (perf()) perf().setTargetFps(v); sv.targetFps = v; }, (v) => v + ' fps');
		this.slider('Render scale', 0.5, 2, 0.05, () => this.perfValue('pixelRatio'), (v) => this.setPerf('pixelRatio', v), (v) => Math.round(v * 100) + '%');
		this.slider('Brightness', 0.2, 1.2, 0.05, () => cfg.performance.brightness || 0.55, (v) => { if (perf()) perf().setBrightness(v); sv.brightness = v; });
		this.toggle('Realtime shadows', () => !!this.perfValue('shadows'), (v) => this.setPerf('shadows', v));
		this.toggle('Baked shadows (next load)', () => !!this.perfValue('bakedShadows'), (v) => this.setPerf('bakedShadows', v));
		this.toggle('Anti-aliasing (FXAA)', () => !!this.perfValue('fxaa'), (v) => this.setPerf('fxaa', v));
		this.toggle('Simple water (faster)', () => this.perfValue('water') === 'simple', (v) => this.setPerf('water', v ? 'simple' : 'shader'));
		this.slider('Point lights', 0, 16, 1, () => this.perfValue('pointLights'), (v) => this.setPerf('pointLights', v));
		this.toggle('Show FPS', () => cfg.performance.showFps !== false, (v) => { if (perf()) perf().setShowFps(v); sv.showFps = v; });

		this.section('View distance / LOD');
		this.slider('View distance', 250, 1000, 25, () => this.perfValue('viewDistance'), (v) => this.setPerf('viewDistance', v), m);
		this.slider('Building distance', 100, 1000, 25, () => this.perfValue('buildingDistance'), (v) => this.setPerf('buildingDistance', v), m);
		this.slider('Tree distance', 80, 1000, 20, () => this.perfValue('treeDistance'), (v) => this.setPerf('treeDistance', v), m);
		this.slider('Detail distance (props)', 30, 400, 10, () => this.perfValue('detailDistance'), (v) => this.setPerf('detailDistance', v), m);
		this.toggle('Interiors', () => !!this.perfValue('interiors'), (v) => this.setPerf('interiors', v));
		this.slider('Interior distance', 10, 80, 2, () => this.perfValue('interiorDistance'), (v) => this.setPerf('interiorDistance', v), m);
		this.slider('Detailed tree models nearby', 0, 40, 1, () => cfg.vegetation.nearModels, (v) => this.setTreeLOD(v, undefined));
		this.slider('Detailed tree distance', 20, 300, 10, () => cfg.vegetation.nearDistance, (v) => this.setTreeLOD(undefined, v), m);

		this.section('World');
		this.slider('NPC density', 0, 2, 0.1, () => w.realismNPCDensity, (v) => { this.applyNPCDensity(v); sv.npcDensity = v; }, (v) => Math.round(v * 100) + '%');
		const dn = () => this.dayNight;
		const dnSaved = () => (sv.dayNight || (sv.dayNight = {}));
		this.toggle('Day / night cycle', () => dn() ? dn().settings.enabled : true, (v) => { if (dn()) dn().setEnabled(v); dnSaved().enabled = v; });
		this.slider('Day length', 2, 120, 1, () => dn() ? dn().settings.cycleMinutes : 24, (v) => { if (dn()) dn().setCycleMinutes(v); dnSaved().cycleMinutes = v; }, (v) => v + ' min');
		this.slider('Time of day', 0, 23.75, 0.25, () => dn() ? Math.round(dn().hour * 4) / 4 % 24 : 12, (v) => { if (dn()) dn().setHour(v); dnSaved().hour = v; }, (v) => RealismDayNight.format(v));

		this.section('Audio & controls');
		this.slider('Master volume', 0, 1, 0.05, () => w.realismVolume, (v) => { w.realismVolume = v; sv.volume = v; }, (v) => Math.round(v * 100) + '%');
		this.slider('Mouse sensitivity', 0.05, 1, 0.05, () => w.params.Mouse_Sensitivity, (v) =>
		{
			w.params.Mouse_Sensitivity = v;
			if (w.cameraOperator) w.cameraOperator.setSensitivity(v, v * 0.8);
			sv.mouseSensitivity = v;
		});
		this.toggle('Developer panel (top right)', () => sv.devPanel === true, (v) => { sv.devPanel = v; UIManager.setDevPanelVisible(v); });
		let armed = false;
		this.button('All settings', 'Reset to defaults', (b) =>
		{
			if (!armed) { armed = true; b.textContent = 'Click again to reset + reload'; return; }
			clearSaved();
			try { window.location.reload(); } catch (e) { /* headless */ }
		});
		this.refreshSettings();
	}

	/** Detailed tree models: fewer works live; more than at load needs a reload (the pools are sized at load). */
	private setTreeLOD(count?: number, dist?: number): void
	{
		const cfg: any = this.ctx.cfg;
		if (count !== undefined) { cfg.vegetation.nearModels = count; this.saved.treeNearModels = count; }
		if (dist !== undefined) { cfg.vegetation.nearDistance = dist; this.saved.treeNearDistance = dist; }
		const lod: any = this.world.realismTreeLOD;
		if (!lod) return;
		const n = cfg.vegetation.nearModels;
		lod.nearCount = Math.max(1, Math.min(n, this.treeCapacity));
		lod.nearDist = n <= 0 ? 0 : cfg.vegetation.nearDistance;
		lod.acc = 1;
	}

	private scheduleSave(): void
	{
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.flushSave(), 400);
	}

	private flushSave(): void
	{
		if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
		writeSaved(this.saved);
	}
}

/** RealismWorldBuilder hook: one call once the county is built. */
export function attachRealismUI(world: any, ctx: RealismCtx, loadingManager: any): void
{
	const ui: RealismUI = world.realismUI;
	if (ui) ui.attach(ctx, loadingManager);
}
