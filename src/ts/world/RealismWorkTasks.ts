/*
 * RealismWorkTasks.ts
 * -------------------
 * Shared pieces of the legal jobs (RealismJobsLegal.ts, RealismConstruction.ts):
 *
 *  - ensureEvents(world)   C14 event bus, created on the world if nobody made it yet.
 *  - JobPrompt             C7 prompt wrapper (owner 'jobs'): realismPrompt.set / isActive / progress,
 *                          with a small built-in hint as fallback while realismPrompt is missing.
 *  - TaskMarkers           up to 12 GTA-style translucent cylinders over the task spots (one
 *                          InstancedMesh, its own material, one draw call).
 *  - ObjectiveHud          one line on the right: the current task and its distance.
 *  - Minigames             wire connect, fuse box, diagnostic sequence and the blueprint designer,
 *                          drawn as DOM overlays that release the mouse through
 *                          realismSetUIBlocking('jobsMinigame' | 'blueprint', true).
 *
 * Every minigame is plain state + act(action, arg); the DOM only calls act(), so it can be played
 * headless (tests) and is deterministic for a given random source.
 */

import * as THREE from 'three';
import { RealismCtx } from './RealismContext';

export function esc(s: any): string
{
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' } as any)[c]);
}

// ---------------------------------------------------------------------------------- C14 events

/** Returns world.realismEvents, creating a minimal bus with the C14 API when it is missing. */
export function ensureEvents(world: any): any
{
	const ev = world.realismEvents;
	if (ev && typeof ev.on === 'function' && typeof ev.emit === 'function') return ev;
	const map: { [name: string]: Array<(d: any) => void> } = {};
	const bus = {
		on(name: string, cb: (d: any) => void): void { if (typeof cb !== 'function') return; (map[name] = map[name] || []).push(cb); },
		off(name: string, cb: (d: any) => void): void { const l = map[name]; if (!l) return; const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); },
		emit(name: string, data?: any): void
		{
			const l = map[name];
			if (!l) return;
			const copy = l.slice(0);
			for (let i = 0; i < copy.length; i++) { try { copy[i](data); } catch (e) { console.warn('[Realism] event ' + name + ' listener threw', e); } }
		},
	};
	world.realismEvents = bus;
	return bus;
}

export function emitEvent(world: any, name: string, data: any): void
{
	try { const ev = world.realismEvents; if (ev && typeof ev.emit === 'function') ev.emit(name, data); }
	catch (e) { console.warn('[Realism] emit ' + name + ' failed', e); }
}

// ---------------------------------------------------------------------------------- C7 prompt

export interface PromptItem { key: string; label: string; hold?: number; }

/** One owner's prompt. Only calls realismPrompt.set when the items change. */
export class JobPrompt
{
	public owner: string;
	private world: any;
	private sig = '';
	private el: HTMLElement = null;
	private barEl: HTMLElement = null;
	private textEl: HTMLElement = null;
	private lastProgress = -1;
	public shown: PromptItem[] = null;

	constructor(world: any, owner: string)
	{
		this.world = world;
		this.owner = owner;
	}

	private api(): any
	{
		const p = this.world.realismPrompt;
		return p && typeof p.set === 'function' ? p : null;
	}

	public set(items: PromptItem[] | null, opts?: { priority?: number; anchor?: THREE.Vector3 }): void
	{
		const sig = items && items.length ? items.map((i) => i.key + '|' + i.label + '|' + (i.hold || 0)).join(';') + '#' + (opts && opts.priority || 0) : '';
		if (sig === this.sig) return;
		this.sig = sig;
		this.shown = sig ? items : null;
		this.lastProgress = -1;
		const p = this.api();
		if (p)
		{
			try { p.set(this.owner, sig ? items : null, opts); } catch (e) { console.warn('[Realism] realismPrompt.set failed', e); }
			this.fallback(null);
		}
		else this.fallback(sig ? items : null);
	}

	/** True when this owner's prompt is the one on screen (or nobody runs C7 prompts). */
	public active(): boolean
	{
		if (!this.shown) return false;
		const p = this.api();
		if (!p || typeof p.isActive !== 'function') return true;
		try { return !!p.isActive(this.owner); } catch (e) { return true; }
	}

	public progress(t: number): void
	{
		const v = Math.max(0, Math.min(1, t));
		if (Math.abs(v - this.lastProgress) < 0.01 && !(v === 0 && this.lastProgress !== 0)) return;
		this.lastProgress = v;
		const p = this.api();
		if (p && typeof p.progress === 'function') { try { p.progress(this.owner, v); } catch (e) { /* ignore */ } }
		if (this.barEl) this.barEl.style.width = Math.round(v * 100) + '%';
	}

	/** Re-sends the current items (after A12's prompt system appears late). */
	public refresh(): void { const s = this.shown; this.sig = '#'; this.set(s); }

	private fallback(items: PromptItem[] | null): void
	{
		try
		{
			if (!items) { if (this.el) this.el.style.display = 'none'; return; }
			if (typeof document === 'undefined' || !document.body) return;
			if (!this.el)
			{
				const e = document.createElement('div');
				e.style.cssText = 'position:fixed;right:30%;bottom:90px;z-index:9998;font:600 14px sans-serif;color:#fff;pointer-events:none;' +
					'background:rgba(10,12,16,0.62);border-radius:22px;padding:6px 14px 6px 6px;display:none;overflow:hidden';
				const t = document.createElement('span');
				const b = document.createElement('div');
				b.style.cssText = 'position:absolute;left:0;bottom:0;height:3px;background:#f2c230;width:0%';
				e.appendChild(t); e.appendChild(b);
				document.body.appendChild(e);
				this.el = e; this.textEl = t; this.barEl = b;
			}
			this.textEl.innerHTML = items.map((i) => '<span style="display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;border-radius:50%;' +
				'background:rgba(255,255,255,0.16);margin-right:8px">' + esc(i.key) + '</span>' + esc(i.label) + (i.hold ? ' <small style="opacity:.7">(hold)</small>' : '')).join('<br>');
			this.el.style.display = '';
			this.barEl.style.width = '0%';
		}
		catch (e) { /* headless */ }
	}
}

// ---------------------------------------------------------------------------------- markers

const MAX_MARKERS = 12;

/** Translucent yellow cylinders over task spots. One InstancedMesh with its own material. */
export class TaskMarkers
{
	public mesh: THREE.InstancedMesh;
	public count = 0;
	private pts: number[] = [];
	private m4 = new THREE.Matrix4();
	private t = 0;

	constructor(ctx: RealismCtx)
	{
		const g = new THREE.CylinderBufferGeometry(0.75, 0.75, 1.1, 16, 1, true);
		g.translate(0, 0.55, 0);
		const mat = new THREE.MeshBasicMaterial({ color: 0xf2c230, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide });
		mat.name = 'jobMarker';
		this.mesh = new THREE.InstancedMesh(g, mat, MAX_MARKERS);
		this.mesh.count = 0;
		this.mesh.frustumCulled = false;
		this.mesh.castShadow = false;
		this.mesh.receiveShadow = false;
		this.mesh.renderOrder = 3;
		this.mesh.name = 'realismJobMarkers';
		ctx.world.graphicsWorld.add(this.mesh);
	}

	/** Flat list x,y,z,... (at most 12 points). */
	public setPoints(p: number[]): void
	{
		this.pts.length = 0;
		for (let i = 0; i < p.length && i < MAX_MARKERS * 3; i++) this.pts.push(p[i]);
		this.count = Math.floor(this.pts.length / 3);
		this.write(1);
	}

	public update(dt: number): void
	{
		if (this.count === 0) return;
		this.t += dt;
		this.write(1 + Math.sin(this.t * 3) * 0.06);
	}

	private write(s: number): void
	{
		for (let i = 0; i < this.count; i++)
		{
			this.m4.makeScale(s, 1, s);
			this.m4.setPosition(this.pts[i * 3], this.pts[i * 3 + 1], this.pts[i * 3 + 2]);
			this.mesh.setMatrixAt(i, this.m4);
		}
		this.mesh.count = this.count;
		this.mesh.instanceMatrix.needsUpdate = true;
		this.mesh.visible = this.count > 0;
	}
}

// ---------------------------------------------------------------------------------- objective line

export class ObjectiveHud
{
	private el: HTMLElement = null;
	private text = '';

	public set(t: string): void
	{
		if (t === this.text) return;
		this.text = t;
		try
		{
			if (!this.el)
			{
				if (!t || typeof document === 'undefined' || !document.body) return;
				const e = document.createElement('div');
				e.id = 'rr-job-objective';
				e.style.cssText = 'position:fixed;right:18px;top:118px;max-width:300px;z-index:9997;font:600 13px sans-serif;color:#fff;pointer-events:none;' +
					'background:rgba(10,12,16,0.6);border-left:3px solid #f2c230;border-radius:4px;padding:7px 10px;line-height:1.35;text-shadow:0 1px 2px #000';
				document.body.appendChild(e);
				this.el = e;
			}
			this.el.textContent = t;
			this.el.style.display = t ? '' : 'none';
		}
		catch (e) { /* headless */ }
	}

	public get value(): string { return this.text; }
}

// ---------------------------------------------------------------------------------- minigames

export type Rand = () => number;

export interface Minigame
{
	kind: string;
	title: string;
	solved: boolean;
	failed: boolean;
	message: string;
	render(): string;
	act(a: string, arg: string): void;
	key?(code: string): boolean;
}

const WIRE_COLORS = [
	{ name: 'Red', css: '#e53935' }, { name: 'Blue', css: '#1e88e5' }, { name: 'Yellow', css: '#fdd835' },
	{ name: 'Green', css: '#43a047' }, { name: 'White', css: '#eeeeee' }, { name: 'Orange', css: '#fb8c00' },
];

function shuffle<T>(a: T[], rnd: Rand): T[]
{
	for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
	return a;
}

/** Connect each wire on the left to the terminal of the same colour on the right. */
export class WireGame implements Minigame
{
	public kind = 'wires';
	public title: string;
	public solved = false;
	public failed = false;
	public message = 'Click a wire, then its matching terminal.';
	public left: number[];
	public right: number[];
	public links: number[];     // left index -> right index, -1 = loose
	public sel = -1;
	public sparks = 0;

	constructor(title: string, n: number, rnd: Rand)
	{
		this.title = title;
		const cols = shuffle([0, 1, 2, 3, 4, 5], rnd).slice(0, Math.max(3, Math.min(6, n)));
		this.left = cols;
		this.right = shuffle(cols.slice(0), rnd);
		if (this.right.every((c, i) => c === this.left[i])) this.right.push(this.right.shift());
		this.links = cols.map(() => -1);
	}

	public act(a: string, arg: string): void
	{
		const i = parseInt(arg, 10);
		if (a === 'L' && i >= 0 && i < this.left.length && this.links[i] < 0) { this.sel = i; this.message = WIRE_COLORS[this.left[i]].name + ' wire: pick its terminal.'; }
		else if (a === 'R' && i >= 0 && i < this.right.length)
		{
			if (this.sel < 0) { this.message = 'Pick a wire on the left first.'; return; }
			if (this.links.indexOf(i) >= 0) { this.message = 'That terminal is already connected.'; return; }
			if (this.right[i] === this.left[this.sel])
			{
				this.links[this.sel] = i;
				this.message = WIRE_COLORS[this.left[this.sel]].name + ' connected.';
				this.sel = -1;
				if (this.links.every((l) => l >= 0)) { this.solved = true; this.message = 'All wires connected. Power restored.'; }
			}
			else { this.sparks++; this.message = 'Zap! Wrong terminal.'; this.sel = -1; }
		}
	}

	public render(): string
	{
		let l = '', r = '';
		for (let i = 0; i < this.left.length; i++)
		{
			const c = WIRE_COLORS[this.left[i]];
			l += '<button class="wk-wire' + (this.sel === i ? ' on' : '') + (this.links[i] >= 0 ? ' done' : '') + '" data-act="L" data-arg="' + i + '" style="background:' + c.css + '">' + c.name + (this.links[i] >= 0 ? ' &#x2714;' : '') + '</button>';
		}
		for (let i = 0; i < this.right.length; i++)
		{
			const c = WIRE_COLORS[this.right[i]];
			r += '<button class="wk-wire' + (this.links.indexOf(i) >= 0 ? ' done' : '') + '" data-act="R" data-arg="' + i + '" style="border-color:' + c.css + '"><span style="color:' + c.css + '">&#x25CF;</span> ' + (i + 1) + '</button>';
		}
		return '<div class="wk-cols"><div>' + l + '</div><div class="wk-mid">&#x26A1;</div><div>' + r + '</div></div>';
	}
}

/** Replace the blown fuses (one Fuse item each from the inventory), then reset the breaker. */
export class FuseGame implements Minigame
{
	public kind = 'fuse';
	public title: string;
	public solved = false;
	public failed = false;
	public message = 'Find the blown fuses (dark), replace them, then reset the breaker.';
	public fuses: boolean[];    // true = good
	public replaced = 0;
	private inv: any;

	constructor(title: string, n: number, blown: number, rnd: Rand, inventory: any)
	{
		this.title = title;
		this.inv = inventory;
		this.fuses = [];
		for (let i = 0; i < n; i++) this.fuses.push(true);
		const ids = shuffle(this.fuses.map((_, i) => i), rnd).slice(0, Math.max(1, Math.min(n - 1, blown)));
		for (let i = 0; i < ids.length; i++) this.fuses[ids[i]] = false;
	}

	public get blownCount(): number { return this.fuses.filter((f) => !f).length; }

	public act(a: string, arg: string): void
	{
		if (a === 'F')
		{
			const i = parseInt(arg, 10);
			if (!(i >= 0 && i < this.fuses.length)) return;
			if (this.fuses[i]) { this.message = 'Fuse ' + (i + 1) + ' is fine.'; return; }
			if (this.inv && typeof this.inv.remove === 'function' && !this.inv.remove('fuse', 1))
			{
				this.message = 'You are out of fuses. Restock at your work van.';
				return;
			}
			this.fuses[i] = true;
			this.replaced++;
			this.message = 'Fuse ' + (i + 1) + ' replaced.';
		}
		else if (a === 'breaker')
		{
			if (this.blownCount > 0) { this.message = 'Breaker trips again: a fuse is still blown.'; return; }
			this.solved = true;
			this.message = 'Breaker reset. System online.';
		}
	}

	public render(): string
	{
		let h = '<div class="wk-fuses">';
		for (let i = 0; i < this.fuses.length; i++)
			h += '<button class="wk-fuse' + (this.fuses[i] ? '' : ' blown') + '" data-act="F" data-arg="' + i + '">' + (i + 1) + '<small>' + (this.fuses[i] ? 'OK' : 'BLOWN') + '</small></button>';
		const inv = this.inv && typeof this.inv.count === 'function' ? this.inv.count('fuse') : -1;
		return h + '</div><div class="wk-row"><button class="wk-big" data-act="breaker">Reset breaker</button>' + (inv >= 0 ? '<span class="wk-dim">Fuses in bag: ' + inv + '</span>' : '') + '</div>';
	}
}

const SEQ = ['\u25B2', '\u25B6', '\u25BC', '\u25C0'];
const SEQ_KEYS: { [code: string]: number } = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3, Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3 };

/** Read the code on the scanner and enter it (buttons, arrow keys or 1-4). */
export class SequenceGame implements Minigame
{
	public kind = 'sequence';
	public title: string;
	public solved = false;
	public failed = false;
	public message = 'Enter the code shown on the scanner.';
	public code: number[];
	public input: number[] = [];
	public mistakes = 0;

	constructor(title: string, len: number, rnd: Rand)
	{
		this.title = title;
		this.code = [];
		for (let i = 0; i < Math.max(3, Math.min(8, len)); i++) this.code.push(Math.floor(rnd() * 4));
	}

	public act(a: string, arg: string): void
	{
		if (a !== 'S') return;
		const v = parseInt(arg, 10);
		if (!(v >= 0 && v < 4)) return;
		if (this.code[this.input.length] !== v)
		{
			this.mistakes++;
			this.input.length = 0;
			this.message = 'Wrong input, the scanner reset. Start again.';
			return;
		}
		this.input.push(v);
		if (this.input.length === this.code.length) { this.solved = true; this.message = 'Diagnostics passed.'; }
		else this.message = this.input.length + ' / ' + this.code.length;
	}

	public key(code: string): boolean
	{
		if (SEQ_KEYS[code] === undefined) return false;
		this.act('S', String(SEQ_KEYS[code]));
		return true;
	}

	public render(): string
	{
		let c = '';
		for (let i = 0; i < this.code.length; i++) c += '<span class="wk-sym' + (i < this.input.length ? ' ok' : '') + '">' + SEQ[this.code[i]] + '</span>';
		let b = '';
		for (let i = 0; i < 4; i++) b += '<button class="wk-sb" data-act="S" data-arg="' + i + '">' + SEQ[i] + '<small>' + (i + 1) + '</small></button>';
		return '<div class="wk-scan">SCANNER<div>' + c + '</div></div><div class="wk-row">' + b + '</div>';
	}
}

// ---------------------------------------------------------------------------------- blueprint

export const ROOM_TYPES: { [k: string]: { name: string; css: string; min: number } } = {
	bed: { name: 'Bedroom', css: '#5c6bc0', min: 6 },
	bath: { name: 'Bathroom', css: '#26a69a', min: 3 },
	kitchen: { name: 'Kitchen', css: '#ffa726', min: 4 },
	living: { name: 'Living room', css: '#8d6e63', min: 8 },
	office: { name: 'Office', css: '#78909c', min: 4 },
};

export interface BlueprintBrief { client: string; rooms: { [type: string]: number }; maxArea: number; text: string; }

const CLIENTS = ['The Alvarez family', 'Mr. and Mrs. Chen', 'Dr. Patel', 'Jordan Reyes', 'The Okafor family', 'Sam Whitaker'];

export function makeBrief(rnd: Rand): BlueprintBrief
{
	const t = Math.floor(rnd() * 3);
	const rooms: { [k: string]: number } = t === 0 ? { bed: 2, bath: 1, kitchen: 1, living: 1 } : t === 1 ? { bed: 1, bath: 1, kitchen: 1, living: 1, office: 1 } : { bed: 3, bath: 2, kitchen: 1, living: 1 };
	let need = 0;
	for (const k in rooms) if (rooms.hasOwnProperty(k)) need += rooms[k] * ROOM_TYPES[k].min;
	const maxArea = need + 8 + Math.floor(rnd() * 6);
	const client = CLIENTS[Math.floor(rnd() * CLIENTS.length)];
	const parts: string[] = [];
	for (const k in rooms) if (rooms.hasOwnProperty(k)) parts.push(rooms[k] + ' ' + ROOM_TYPES[k].name.toLowerCase() + (rooms[k] > 1 ? 's' : ''));
	return { client: client, rooms: rooms, maxArea: maxArea, text: client + ' want ' + parts.join(', ') + ', at most ' + maxArea + ' squares.' };
}

/** Paint rooms on a grid to match a client brief. Scored when submitted. */
export class BlueprintGame implements Minigame
{
	public kind = 'blueprint';
	public title = 'Blueprint designer';
	public solved = false;
	public failed = false;
	public message = 'Pick a room type, then click squares to paint it. Same-type squares that touch form one room.';
	public W = 10;
	public H = 7;
	public grid: string[];
	public tool = 'bed';
	public brief: BlueprintBrief;
	public score = 0;          // 0..1 after submit
	public checks: { label: string; ok: boolean }[] = [];
	public attempts = 0;
	public passMark: number;

	constructor(brief: BlueprintBrief, passMark: number)
	{
		this.brief = brief;
		this.passMark = passMark;
		this.grid = [];
		for (let i = 0; i < this.W * this.H; i++) this.grid.push('');
	}

	public act(a: string, arg: string): void
	{
		if (a === 'tool' && (ROOM_TYPES[arg] || arg === 'erase')) { this.tool = arg; return; }
		if (a === 'cell')
		{
			const p = arg.split(',');
			const x = parseInt(p[0], 10), y = parseInt(p[1], 10);
			if (!(x >= 0 && x < this.W && y >= 0 && y < this.H)) return;
			const i = y * this.W + x;
			this.grid[i] = this.tool === 'erase' ? '' : (this.grid[i] === this.tool ? '' : this.tool);
			return;
		}
		if (a === 'clear') { for (let i = 0; i < this.grid.length; i++) this.grid[i] = ''; return; }
		if (a === 'submit') this.submit();
	}

	/** Connected rooms: [{ type, cells[] }]. */
	public rooms(): { type: string; cells: number[] }[]
	{
		const seen: boolean[] = this.grid.map(() => false);
		const out: { type: string; cells: number[] }[] = [];
		for (let i = 0; i < this.grid.length; i++)
		{
			if (!this.grid[i] || seen[i]) continue;
			const type = this.grid[i];
			const cells: number[] = [];
			const stack = [i];
			seen[i] = true;
			while (stack.length)
			{
				const c = stack.pop();
				cells.push(c);
				const x = c % this.W, y = Math.floor(c / this.W);
				const nb = [x > 0 ? c - 1 : -1, x < this.W - 1 ? c + 1 : -1, y > 0 ? c - this.W : -1, y < this.H - 1 ? c + this.W : -1];
				for (let k = 0; k < 4; k++) { const n = nb[k]; if (n >= 0 && !seen[n] && this.grid[n] === type) { seen[n] = true; stack.push(n); } }
			}
			out.push({ type: type, cells: cells });
		}
		return out;
	}

	private touches(a: number[], b: number[]): boolean
	{
		const set: { [c: number]: boolean } = {};
		for (let i = 0; i < b.length; i++) set[b[i]] = true;
		for (let i = 0; i < a.length; i++)
		{
			const c = a[i], x = c % this.W;
			if ((x > 0 && set[c - 1]) || (x < this.W - 1 && set[c + 1]) || set[c - this.W] || set[c + this.W]) return true;
		}
		return false;
	}

	/** Scores the plan. Public for tests. */
	public evaluate(): { score: number; checks: { label: string; ok: boolean }[] }
	{
		const rooms = this.rooms();
		const checks: { label: string; ok: boolean }[] = [];
		const req = this.brief.rooms;
		for (const t in req)
		{
			if (!req.hasOwnProperty(t)) continue;
			const mine = rooms.filter((r) => r.type === t);
			checks.push({ label: req[t] + ' ' + ROOM_TYPES[t].name.toLowerCase() + (req[t] > 1 ? 's' : '') + ' (have ' + mine.length + ')', ok: mine.length === req[t] });
			checks.push({ label: ROOM_TYPES[t].name + ' at least ' + ROOM_TYPES[t].min + ' squares', ok: mine.length > 0 && mine.every((r) => r.cells.length >= ROOM_TYPES[t].min) });
		}
		const extra = rooms.filter((r) => !req[r.type]);
		checks.push({ label: 'No rooms the client did not ask for', ok: extra.length === 0 });
		let area = 0;
		for (let i = 0; i < this.grid.length; i++) if (this.grid[i]) area++;
		checks.push({ label: 'Area ' + area + ' / ' + this.brief.maxArea + ' squares', ok: area > 0 && area <= this.brief.maxArea });
		// one connected footprint
		let ok = area > 0;
		if (ok)
		{
			const first = this.grid.findIndex((g) => !!g);
			const seen: { [c: number]: boolean } = {};
			const stack = [first]; seen[first] = true; let n = 0;
			while (stack.length)
			{
				const c = stack.pop(); n++;
				const x = c % this.W, y = Math.floor(c / this.W);
				const nb = [x > 0 ? c - 1 : -1, x < this.W - 1 ? c + 1 : -1, y > 0 ? c - this.W : -1, y < this.H - 1 ? c + this.W : -1];
				for (let k = 0; k < 4; k++) { const q = nb[k]; if (q >= 0 && !seen[q] && this.grid[q]) { seen[q] = true; stack.push(q); } }
			}
			ok = n === area;
		}
		checks.push({ label: 'One connected house', ok: ok });
		const baths = rooms.filter((r) => r.type === 'bath'), beds = rooms.filter((r) => r.type === 'bed');
		checks.push({ label: 'Every bathroom next to a bedroom', ok: baths.length > 0 && baths.every((b) => beds.some((d) => this.touches(b.cells, d.cells))) });
		const kit = rooms.filter((r) => r.type === 'kitchen'), liv = rooms.filter((r) => r.type === 'living');
		checks.push({ label: 'Kitchen next to the living room', ok: kit.length > 0 && kit.every((k) => liv.some((l) => this.touches(k.cells, l.cells))) });
		const passed = checks.filter((c) => c.ok).length;
		return { score: checks.length ? passed / checks.length : 0, checks: checks };
	}

	private submit(): void
	{
		const r = this.evaluate();
		this.attempts++;
		this.score = r.score;
		this.checks = r.checks;
		if (r.score >= this.passMark) { this.solved = true; this.message = 'Client approved the plan: ' + Math.round(r.score * 100) + '%.'; }
		else this.message = 'Client wants changes (' + Math.round(r.score * 100) + '%, need ' + Math.round(this.passMark * 100) + '%). Fix the red items and submit again.';
	}

	public render(): string
	{
		let tools = '';
		for (const k in ROOM_TYPES)
		{
			if (!ROOM_TYPES.hasOwnProperty(k)) continue;
			tools += '<button class="wk-tool' + (this.tool === k ? ' on' : '') + '" data-act="tool" data-arg="' + k + '"><i style="background:' + ROOM_TYPES[k].css + '"></i>' + ROOM_TYPES[k].name + '</button>';
		}
		tools += '<button class="wk-tool' + (this.tool === 'erase' ? ' on' : '') + '" data-act="tool" data-arg="erase">Erase</button>';
		let g = '<div class="wk-grid" style="grid-template-columns:repeat(' + this.W + ',26px)">';
		for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++)
		{
			const t = this.grid[y * this.W + x];
			g += '<button class="wk-cell" data-act="cell" data-arg="' + x + ',' + y + '" style="background:' + (t ? ROOM_TYPES[t].css : '#1b2a44') + '"></button>';
		}
		g += '</div>';
		let ch = '';
		const live = this.checks.length ? this.checks : this.evaluate().checks;
		for (let i = 0; i < live.length; i++) ch += '<div class="' + (live[i].ok ? 'wk-ok' : 'wk-no') + '">' + (live[i].ok ? '&#x2714; ' : '&#x2716; ') + esc(live[i].label) + '</div>';
		return '<div class="wk-brief">&#x1F4CB; ' + esc(this.brief.text) + '</div><div class="wk-tools">' + tools + '</div><div class="wk-bp">' + g + '<div class="wk-checks">' + ch + '</div></div>' +
			'<div class="wk-row"><button class="wk-big" data-act="submit">Submit to client</button><button data-act="clear">Clear</button></div>';
	}
}

// ---------------------------------------------------------------------------------- overlay

const CSS =
	'#rr-work{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:10001;min-width:360px;max-width:92vw;max-height:90vh;overflow:auto;' +
	'background:rgba(10,13,19,0.94);color:#eee;font:13px sans-serif;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.6);padding:16px 18px;user-select:none}' +
	'#rr-work h2{margin:0 0 4px;font-size:17px;letter-spacing:1px;color:#f2c230}#rr-work .wk-msg{min-height:18px;color:#ffd54a;margin:8px 0}' +
	'#rr-work button{font:12px sans-serif;color:#eee;background:#232933;border:2px solid #39414e;border-radius:6px;padding:6px 9px;cursor:pointer;margin:2px}' +
	'#rr-work button:hover{background:#2e3644}#rr-work .wk-big{background:#2f8a46;border-color:#2f8a46;font-weight:bold;padding:8px 14px}' +
	'#rr-work .wk-cols{display:flex;gap:18px;align-items:center}#rr-work .wk-cols>div{display:flex;flex-direction:column}#rr-work .wk-mid{font-size:30px;opacity:.5}' +
	'#rr-work .wk-wire{min-width:96px;color:#111;font-weight:bold}#rr-work .wk-wire.on{outline:3px solid #fff}#rr-work .wk-wire.done{opacity:.45}' +
	'#rr-work .wk-fuses{display:grid;grid-template-columns:repeat(4,64px);gap:6px}#rr-work .wk-fuse{height:54px;background:#3b4f2e;border-color:#6a8f4e}' +
	'#rr-work .wk-fuse small{display:block;font-size:10px;opacity:.8}#rr-work .wk-fuse.blown{background:#2a1616;border-color:#7a2a2a}' +
	'#rr-work .wk-scan{background:#071b10;color:#4dff88;font:bold 12px monospace;padding:10px;border-radius:6px;margin-bottom:8px;letter-spacing:2px}' +
	'#rr-work .wk-sym{font-size:26px;margin-right:8px;opacity:.9}#rr-work .wk-sym.ok{color:#fff;opacity:.35}#rr-work .wk-sb{font-size:22px;width:58px}' +
	'#rr-work .wk-sb small{display:block;font-size:10px;opacity:.6}#rr-work .wk-row{display:flex;align-items:center;gap:6px;margin-top:8px}' +
	'#rr-work .wk-dim{opacity:.7}#rr-work .wk-brief{background:#1d2633;padding:8px;border-radius:6px;margin-bottom:6px}' +
	'#rr-work .wk-tool i{display:inline-block;width:10px;height:10px;margin-right:4px;border-radius:2px}#rr-work .wk-tool.on{border-color:#f2c230}' +
	'#rr-work .wk-bp{display:flex;gap:14px}#rr-work .wk-grid{display:grid;gap:2px;background:#0d1626;padding:6px;border-radius:6px}' +
	'#rr-work .wk-cell{width:26px;height:26px;padding:0;margin:0;border:1px solid #2c4166;border-radius:2px}' +
	'#rr-work .wk-checks{font-size:12px;line-height:1.6;min-width:220px}#rr-work .wk-ok{color:#7be495}#rr-work .wk-no{color:#ff8a80}' +
	'#rr-work .wk-x{position:absolute;right:10px;top:8px}';

/** Shows one minigame at a time. done(success) runs once when it is solved or cancelled. */
export class MinigameOverlay
{
	public current: Minigame = null;
	private world: any;
	private el: HTMLElement = null;
	private done: (ok: boolean, mg: Minigame) => void = null;
	private owner = '';
	private wasLocked = false;
	private solvedAt = 0;

	constructor(world: any)
	{
		this.world = world;
		try
		{
			if (typeof window !== 'undefined' && (window as any).addEventListener)
				(window as any).addEventListener('keydown', (e: KeyboardEvent) => { if (this.current && this.onKey(e.code)) { e.preventDefault(); } }, true);
		}
		catch (e) { /* headless */ }
	}

	public get isOpen(): boolean { return !!this.current; }

	public open(mg: Minigame, done: (ok: boolean, mg: Minigame) => void): void
	{
		if (this.current) this.finish(false);
		this.current = mg;
		this.done = done;
		this.owner = mg.kind === 'blueprint' ? 'blueprint' : 'jobsMinigame';
		this.solvedAt = 0;
		const w = this.world;
		try { if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking(this.owner, true); } catch (e) { /* ignore */ }
		try
		{
			this.wasLocked = typeof document !== 'undefined' && !!document.pointerLockElement;
			if (this.wasLocked)
			{
				if (w.realismUI && w.realismUI.exitLock) w.realismUI.exitLock(); else document.exitPointerLock();
			}
		}
		catch (e) { /* headless */ }
		this.ensure();
		this.render();
	}

	/** Same as a click on a button with data-act / data-arg. */
	public act(a: string, arg: string): void
	{
		const mg = this.current;
		if (!mg) return;
		if (a === 'close') { this.finish(false); return; }
		mg.act(a, arg || '');
		this.render();
		if (mg.solved) this.finish(true);
	}

	public onKey(code: string): boolean
	{
		const mg = this.current;
		if (!mg) return false;
		if (code === 'Escape') { this.finish(false); return true; }
		if (mg.key && mg.key(code)) { this.render(); if (mg.solved) this.finish(true); return true; }
		return false;
	}

	public cancel(): void { if (this.current) this.finish(false); }

	private finish(ok: boolean): void
	{
		const mg = this.current, cb = this.done;
		this.current = null;
		this.done = null;
		if (this.el) this.el.style.display = 'none';
		const w = this.world;
		try { if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking(this.owner, false); } catch (e) { /* ignore */ }
		if (this.wasLocked)
		{
			try
			{
				if (w.realismUI && w.realismUI.requestLock) w.realismUI.requestLock();
				else if (w.renderer && w.renderer.domElement.requestPointerLock) w.renderer.domElement.requestPointerLock();
			}
			catch (e) { /* next click grabs the mouse */ }
		}
		if (cb) { try { cb(ok, mg); } catch (e) { console.warn('[Realism] minigame callback threw', e); } }
	}

	private ensure(): void
	{
		if (this.el) return;
		try
		{
			if (typeof document === 'undefined' || !document.body) return;
			const st = document.createElement('style');
			st.textContent = CSS;
			document.head.appendChild(st);
			const e = document.createElement('div');
			e.id = 'rr-work';
			e.style.display = 'none';
			e.addEventListener('mousedown', (ev: Event) => ev.stopPropagation(), false);
			e.addEventListener('click', (ev: Event) =>
			{
				let t: any = ev.target;
				while (t && t !== e && !(t.getAttribute && t.getAttribute('data-act'))) t = t.parentNode;
				if (!t || t === e || !t.getAttribute) return;
				ev.preventDefault();
				this.act(t.getAttribute('data-act'), t.getAttribute('data-arg') || '');
			}, false);
			document.body.appendChild(e);
			this.el = e;
		}
		catch (e) { this.el = null; }
	}

	private render(): void
	{
		const mg = this.current;
		if (!mg || !this.el) return;
		try
		{
			this.el.innerHTML = '<button class="wk-x" data-act="close">Esc &#x2715;</button><h2>' + esc(mg.title) + '</h2>' + mg.render() + '<div class="wk-msg">' + esc(mg.message) + '</div>';
			this.el.style.display = '';
		}
		catch (e) { /* headless */ }
	}
}
