/*
 * RealismPrompts.ts
 * -----------------
 * C7: GTA 6 style interaction prompts ("control tips").
 *
 *   (world as any).realismPrompt = {
 *       set(owner: string, items: Array<{ key: string; label: string; hold?: number }> | null,
 *           opts?: { priority?: number; anchor?: THREE.Vector3 }): void;
 *       isActive(owner: string): boolean;
 *       progress(owner: string, t: number): void;
 *   }
 *
 *  - Every system that offers an interaction calls set(owner, items) while the player is in range
 *    and set(owner, null) when not, and only acts on its key while isActive(owner) is true.
 *  - Which prompts show: the owner with the highest priority wins (ties: the one whose anchor is
 *    closer to the player, then the one that asked first). Other owners are shown under it only
 *    when none of their keys is already on screen, so one key press can never trigger two things.
 *    isActive(owner) is true for every owner on screen, false for the rest.
 *  - Nothing is shown (and isActive is false for everybody) while a menu / overlay blocks input
 *    (realismUIBlocking), while paused (realismPaused) or in the free camera.
 *  - hud.prompts: false (realism-config.js) only hides the on-screen prompts; isActive still works.
 *  - An item with key '' (or no key) is an info line without a button, e.g. "Private residence".
 *  - hold > 0 draws a progress ring around the key; the owner feeds it with progress(owner, 0..1).
 *  - Look: dark translucent circle (rounded square for long keys such as Space / Shift / LMB) with
 *    the white key, the action to the right, lower-middle-right of the screen, fade + scale in.
 *
 * Cost: set() with the same items as last time does nothing; the DOM is touched only when what is
 * on screen changes (or a hold ring moves).
 */

import * as THREE from 'three';
import { IUpdatable } from '../interfaces/IUpdatable';

export interface PromptItem { key: string; label: string; hold?: number; }
interface Owner
{
	name: string;
	items: PromptItem[];       // own copy
	priority: number;
	anchor: THREE.Vector3;     // own copy or null
	seq: number;
	progress: number;
	shown: boolean;
}
interface Row
{
	el: HTMLElement;
	keyEl: HTMLElement;
	keyText: HTMLElement;
	labelEl: HTMLElement;
	ring: any;               // svg circle (progress)
	track: any;              // svg circle (track)
	key: string; label: string; wide: boolean; hold: boolean; prog: number;
	used: boolean;
}

const MAX_ROWS = 6;
const RING_C = 2 * Math.PI * 15.5;

export class PromptSystem implements IUpdatable
{
	public updateOrder = 40;
	public stats = { owners: 0, shown: 0, domWrites: 0 };
	private world: any;
	private owners: { [name: string]: Owner } = {};
	private list: Owner[] = [];
	private order: Owner[] = [];
	private seq = 0;
	private dirty = true;
	private hidden = true;
	private root: HTMLElement = null;
	private rows: Row[] = [];
	private shownSig: string = '';
	private keysUsed: string[] = [];
	private pp = new THREE.Vector3();
	private enabled = true;

	constructor(world: any, enabled: boolean = true)
	{
		this.world = world;
		this.enabled = enabled;
		const self = this;
		world.realismPrompt = {
			set(owner: string, items: PromptItem[] | null, opts?: { priority?: number; anchor?: THREE.Vector3 }): void { self.set(owner, items, opts); },
			isActive(owner: string): boolean { return self.isActive(owner); },
			progress(owner: string, t: number): void { self.progress(owner, t); },
		};
	}

	// ------------------------------------------------------------------ API

	public set(name: string, items: PromptItem[] | null, opts?: { priority?: number; anchor?: THREE.Vector3 }): void
	{
		if (!name) return;
		let o = this.owners[name];
		if (!items || items.length === 0)
		{
			if (o === undefined) return;
			delete this.owners[name];
			const i = this.list.indexOf(o);
			if (i >= 0) this.list.splice(i, 1);
			this.dirty = true;
			return;
		}
		const pr = opts && typeof opts.priority === 'number' && isFinite(opts.priority) ? opts.priority : 0;
		const an = opts && opts.anchor && typeof opts.anchor.x === 'number' ? opts.anchor : null;
		if (o === undefined)
		{
			o = { name: name, items: [], priority: pr, anchor: null, seq: ++this.seq, progress: 0, shown: false };
			this.owners[name] = o;
			this.list.push(o);
			this.dirty = true;
		}
		if (o.priority !== pr) { o.priority = pr; this.dirty = true; }
		if (an)
		{
			if (o.anchor === null) { o.anchor = new THREE.Vector3(); this.dirty = true; }
			if (o.anchor.x !== an.x || o.anchor.y !== an.y || o.anchor.z !== an.z) { o.anchor.set(an.x, an.y || 0, an.z); this.dirty = true; }
		}
		else if (o.anchor !== null) { o.anchor = null; this.dirty = true; }
		// copy items only when they differ
		let same = o.items.length === items.length;
		for (let i = 0; same && i < items.length; i++)
		{
			const a = o.items[i], b = items[i];
			if (!b || a.key !== keyOf(b) || a.label !== String(b.label || '') || (a.hold || 0) !== (b.hold > 0 ? b.hold : 0)) same = false;
		}
		if (!same)
		{
			o.items = [];
			for (let i = 0; i < items.length; i++)
			{
				const b = items[i];
				if (!b) continue;
				o.items.push({ key: keyOf(b), label: String(b.label || ''), hold: b.hold > 0 ? b.hold : 0 });
			}
			this.dirty = true;
		}
	}

	public isActive(name: string): boolean
	{
		this.resolve();
		const o = this.owners[name];
		return o !== undefined && o.shown && !this.hidden;
	}

	public progress(name: string, t: number): void
	{
		const o = this.owners[name];
		if (o === undefined) return;
		const v = !(t > 0) ? 0 : (t > 1 ? 1 : t);
		if (Math.abs(v - o.progress) < 0.004) return;
		o.progress = v;
		if (o.shown) this.dirty = true;
	}

	/** Owner names currently on screen (tests / debugging). */
	public shownOwners(): string[]
	{
		this.resolve();
		const out: string[] = [];
		if (this.hidden) return out;
		for (let i = 0; i < this.order.length; i++) if (this.order[i].shown) out.push(this.order[i].name);
		return out;
	}

	// ------------------------------------------------------------------ resolve

	private computeHidden(): boolean
	{
		const w = this.world;
		if (w.realismPaused === true || w.realismUIBlocking === true) return true;
		const im = w.inputManager;
		if (im && w.cameraOperator && im.inputReceiver === w.cameraOperator) return true;   // free camera
		return false;
	}

	/** Decides which owners are on screen (cheap; runs when something changed). */
	private resolve(): void
	{
		const hidden = this.computeHidden();
		if (hidden !== this.hidden) { this.hidden = hidden; this.dirty = true; }
		if (!this.dirty) return;
		this.dirty = false;
		this.domDirty = true;
		const order = this.order;
		order.length = 0;
		for (let i = 0; i < this.list.length; i++) order.push(this.list[i]);
		this.havePos = this.playerPos(this.pp);
		if (order.length > 1) order.sort(this.cmp);
		const used = this.keysUsed;
		used.length = 0;
		let rows = 0;
		for (let i = 0; i < order.length; i++)
		{
			const o = order[i];
			o.shown = false;
			let clash = false;
			for (let k = 0; k < o.items.length && !clash; k++) if (o.items[k].key && used.indexOf(o.items[k].key) >= 0) clash = true;
			if (clash || rows + o.items.length > MAX_ROWS) continue;
			o.shown = true;
			rows += o.items.length;
			for (let k = 0; k < o.items.length; k++) if (o.items[k].key) used.push(o.items[k].key);
		}
		this.stats.owners = order.length;
		this.stats.shown = rows;
	}
	private domDirty = true;
	private havePos = false;
	private cmp = (a: Owner, b: Owner): number =>
	{
		if (a.priority !== b.priority) return b.priority - a.priority;
		if (this.havePos && a.anchor && b.anchor)
		{
			const da = a.anchor.distanceToSquared(this.pp), db = b.anchor.distanceToSquared(this.pp);
			if (Math.abs(da - db) > 0.01) return da - db;
		}
		return a.seq - b.seq;
	}

	private playerPos(out: THREE.Vector3): boolean
	{
		const im = this.world.inputManager;
		const r: any = im ? im.inputReceiver : null;
		if (r && r.position && typeof r.position.x === 'number') { out.copy(r.position); return true; }
		return false;
	}

	// ------------------------------------------------------------------ frame

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		this.resolve();
		if (!this.domDirty) return;
		this.domDirty = false;
		this.render();
	}

	private render(): void
	{
		this.ensureDom();
		if (this.root === null) return;
		let n = 0;
		if (!this.hidden && this.enabled)
		{
			for (let i = 0; i < this.order.length; i++)
			{
				const o = this.order[i];
				if (!o.shown) continue;
				for (let k = 0; k < o.items.length && n < MAX_ROWS; k++) this.writeRow(this.rows[n++], o.items[k], o.progress);
			}
		}
		for (let i = n; i < this.rows.length; i++) this.hideRow(this.rows[i]);
		const vis = n > 0;
		if (vis !== (this.root.className.indexOf('rr-pr-vis') >= 0))
		{
			this.root.className = vis ? 'rr-prompts rr-pr-vis' : 'rr-prompts';
			this.stats.domWrites++;
		}
	}

	private writeRow(r: Row, it: PromptItem, prog: number): void
	{
		if (!r) return;
		const wide = it.key.length > 1;
		const hold = (it.hold || 0) > 0;
		if (!r.used)
		{
			r.used = true;
			r.el.className = 'rr-pr-row';
			// restart the fade / scale-in on the next frame
			const el = r.el;
			setTimeout(() => { if (r.used) el.className = 'rr-pr-row rr-pr-in'; }, 16);
			this.stats.domWrites++;
		}
		if (r.key !== it.key || r.wide !== wide)
		{
			r.key = it.key; r.wide = wide;
			r.keyText.textContent = displayKey(it.key);
			r.keyEl.className = 'rr-pr-key' + (wide ? ' rr-pr-wide' : '') + (it.key ? '' : ' rr-pr-info');
			this.stats.domWrites++;
		}
		if (r.label !== it.label) { r.label = it.label; r.labelEl.textContent = it.label; this.stats.domWrites++; }
		const p = hold ? prog : 0;
		if (r.hold !== hold || Math.abs(r.prog - p) > 0.003)
		{
			r.hold = hold; r.prog = p;
			try
			{
				if (r.track) r.track.setAttribute('opacity', hold && !wide ? '1' : '0');
				if (r.ring)
				{
					r.ring.setAttribute('opacity', hold && !wide ? '1' : '0');
					r.ring.setAttribute('stroke-dashoffset', String(RING_C * (1 - p)));
				}
				if (wide) r.keyEl.style.backgroundSize = Math.round(p * 100) + '% 100%';
			}
			catch (e) { /* headless */ }
			this.stats.domWrites++;
		}
	}

	private hideRow(r: Row): void
	{
		if (!r || !r.used) return;
		r.used = false;
		r.el.className = 'rr-pr-row rr-pr-off';
		this.stats.domWrites++;
	}

	private ensureDom(): void
	{
		if (this.root !== null) return;
		try
		{
			if (typeof document === 'undefined' || !document.body || !document.createElement) return;
			const root = document.createElement('div');
			root.className = 'rr-prompts';
			root.id = 'rr-prompts';
			for (let i = 0; i < MAX_ROWS; i++)
			{
				const el = document.createElement('div');
				el.className = 'rr-pr-row rr-pr-off';
				el.innerHTML =
					'<div class="rr-pr-key">' +
						'<svg class="rr-pr-svg" viewBox="0 0 36 36" width="36" height="36">' +
							'<circle class="rr-pr-track" cx="18" cy="18" r="15.5" opacity="0"></circle>' +
							'<circle class="rr-pr-ring" cx="18" cy="18" r="15.5" opacity="0" stroke-dasharray="' + RING_C.toFixed(2) + '" stroke-dashoffset="' + RING_C.toFixed(2) + '" transform="rotate(-90 18 18)"></circle>' +
						'</svg>' +
						'<span class="rr-pr-k"></span>' +
					'</div>' +
					'<div class="rr-pr-label"></div>';
				root.appendChild(el);
				const keyEl = el.querySelector('.rr-pr-key') as HTMLElement;
				this.rows.push({
					el: el, keyEl: keyEl, keyText: el.querySelector('.rr-pr-k') as HTMLElement, labelEl: el.querySelector('.rr-pr-label') as HTMLElement,
					ring: el.querySelector('.rr-pr-ring'), track: el.querySelector('.rr-pr-track'),
					key: null, label: null, wide: false, hold: false, prog: -1, used: false,
				});
			}
			document.body.appendChild(root);
			this.root = root;
		}
		catch (e) { this.root = null; }
	}
}

function keyOf(it: PromptItem): string
{
	const k = it && it.key !== undefined && it.key !== null ? String(it.key) : '';
	return k.length === 1 ? k.toUpperCase() : k;
}

const KEY_NAMES: { [k: string]: string } = {
	space: 'Space', shift: 'Shift', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', tab: 'Tab', enter: 'Enter', esc: 'Esc', escape: 'Esc',
	lmb: 'LMB', rmb: 'RMB', mouse0: 'LMB', mouse2: 'RMB', backspace: '\u232B', up: '\u2191', down: '\u2193', left: '\u2190', right: '\u2192',
};

function displayKey(k: string): string
{
	if (!k) return '';
	const n = KEY_NAMES[k.toLowerCase()];
	if (n) return n;
	if (/^Key[A-Z]$/.test(k)) return k.charAt(3);
	if (/^Digit[0-9]$/.test(k)) return k.charAt(5);
	return k;
}

/** Creates the prompt system once (or returns the existing one). */
export function ensurePrompts(world: any, enabled: boolean = true): PromptSystem
{
	const w: any = world;
	if (w.realismPromptSystem instanceof PromptSystem) return w.realismPromptSystem;
	const s = new PromptSystem(world, enabled);
	w.realismPromptSystem = s;
	world.registerUpdatable(s);
	return s;
}
