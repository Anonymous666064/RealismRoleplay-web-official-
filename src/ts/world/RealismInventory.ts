/*
 * RealismInventory.ts
 * -------------------
 * The player's pockets / work bag (contract C13, developer A16).
 *
 * (world as any).realismInventory = {
 *    add(id: string, qty: number, meta?: any): void;
 *    remove(id: string, qty: number): boolean;      // false (and nothing removed) when there are fewer than qty
 *    count(id: string): number;
 *    list(): Array<{ id: string; name: string; qty: number }>;   // items with qty > 0, in the order they were first added
 *    onChange(cb: () => void): void;
 *    define(id: string, def: { name: string; icon?: string; legal?: boolean; value?: number }): void;
 * }
 *
 * Saved in localStorage 'realism.inventory.v1' as { v: 1, items: [[id, qty, meta?], ...] }.
 * Item definitions are not saved: systems call define() every load (unknown ids show their id,
 * Title Cased). Quantities are whole numbers, capped at inventory.maxStack (default 999).
 */

import { RealismCtx } from './RealismContext';

export const INVENTORY_KEY = 'realism.inventory.v1';

export interface ItemDef { name: string; icon?: string; legal?: boolean; value?: number; }

/** Items the legal jobs use (RealismJobsLegal.ts). */
const BUILTIN: { [id: string]: ItemDef } = {
	cone: { name: 'Traffic cone', icon: '\u{1F6A7}', legal: true, value: 15 },
	asphalt: { name: 'Cold patch asphalt', icon: '\u{1FAA8}', legal: true, value: 20 },
	roadPaint: { name: 'Road line paint', icon: '\u{1F3A8}', legal: true, value: 25 },
	litterBag: { name: 'Litter bag', icon: '\u{1F5D1}\u{FE0F}', legal: true, value: 0 },
	supplyCrate: { name: 'Building supplies', icon: '\u{1F4E6}', legal: true, value: 60 },
	fuse: { name: 'Fuse', icon: '\u{1F50C}', legal: true, value: 5 },
	wire: { name: 'Wire spool', icon: '\u{1F9F5}', legal: true, value: 12 },
	toolkit: { name: 'Toolkit', icon: '\u{1F9F0}', legal: true, value: 80 },
	multimeter: { name: 'Multimeter', icon: '\u{1F4DF}', legal: true, value: 45 },
	broom: { name: 'Broom', icon: '\u{1F9F9}', legal: true, value: 10 },
	blueprint: { name: 'Approved blueprint', icon: '\u{1F4D0}', legal: true, value: 0 },
};

function cleanId(id: any): string
{
	if (typeof id !== 'string') return '';
	const s = id.trim();
	return s.length > 0 && s.length <= 48 ? s : '';
}

function titleOf(id: string): string
{
	return id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export class RealismInventory
{
	public api: any;
	private order: string[] = [];
	private qty: { [id: string]: number } = {};
	private meta: { [id: string]: any } = {};
	private defs: { [id: string]: ItemDef } = {};
	private listeners: Array<() => void> = [];
	private maxStack: number;
	private saveTimer: any = null;

	constructor(ctx: RealismCtx)
	{
		const raw: any = (ctx.cfg as any).inventory || {};
		this.maxStack = typeof raw.maxStack === 'number' && isFinite(raw.maxStack) ? Math.max(1, Math.min(1e6, Math.floor(raw.maxStack))) : 999;
		for (const k in BUILTIN) if (BUILTIN.hasOwnProperty(k)) this.defs[k] = BUILTIN[k];
		this.load();
		const self = this;
		this.api = {
			add(id: string, qty: number, meta?: any): void { self.add(id, qty, meta); },
			remove(id: string, qty: number): boolean { return self.remove(id, qty); },
			count(id: string): number { return self.count(id); },
			list(): Array<{ id: string; name: string; qty: number }> { return self.list(); },
			onChange(cb: () => void): void { if (typeof cb === 'function') self.listeners.push(cb); },
			define(id: string, def: ItemDef): void { self.define(id, def); },
			// extras (not part of C13)
			def(id: string): ItemDef { return self.defOf(id); },
			meta(id: string): any { return self.meta[id]; },
			save(): void { self.save(); },
		};
	}

	public defOf(id: string): ItemDef
	{
		return this.defs[id] || { name: titleOf(id), icon: '\u{1F4E6}', legal: true, value: 0 };
	}

	public define(id: string, def: ItemDef): void
	{
		const k = cleanId(id);
		if (!k || !def || typeof def !== 'object') return;
		this.defs[k] = {
			name: typeof def.name === 'string' && def.name ? def.name : titleOf(k),
			icon: typeof def.icon === 'string' ? def.icon : undefined,
			legal: def.legal !== false,
			value: typeof def.value === 'number' && isFinite(def.value) ? def.value : 0,
		};
		this.emit(false);
	}

	public add(id: string, qty: number, meta?: any): void
	{
		const k = cleanId(id);
		const n = Math.floor(typeof qty === 'number' && isFinite(qty) ? qty : 0);
		if (!k || n <= 0) return;
		if (this.qty[k] === undefined || this.order.indexOf(k) < 0) { this.order.push(k); this.qty[k] = 0; }
		this.qty[k] = Math.min(this.maxStack, this.qty[k] + n);
		if (meta !== undefined) this.meta[k] = meta;
		this.emit(true);
	}

	public remove(id: string, qty: number): boolean
	{
		const k = cleanId(id);
		const n = Math.floor(typeof qty === 'number' && isFinite(qty) ? qty : 0);
		if (!k || n <= 0) return n === 0 && !!k;
		const have = this.qty[k] || 0;
		if (have < n) return false;
		this.qty[k] = have - n;
		if (this.qty[k] <= 0)
		{
			delete this.qty[k];
			delete this.meta[k];
			const i = this.order.indexOf(k);
			if (i >= 0) this.order.splice(i, 1);
		}
		this.emit(true);
		return true;
	}

	public count(id: string): number { const k = cleanId(id); return k ? (this.qty[k] || 0) : 0; }

	public list(): Array<{ id: string; name: string; qty: number }>
	{
		const out: Array<{ id: string; name: string; qty: number }> = [];
		for (let i = 0; i < this.order.length; i++)
		{
			const k = this.order[i];
			const q = this.qty[k] || 0;
			if (q > 0) out.push({ id: k, name: this.defOf(k).name, qty: q });
		}
		return out;
	}

	private emit(changed: boolean): void
	{
		if (changed) this.scheduleSave();
		for (let i = 0; i < this.listeners.length; i++)
		{
			try { this.listeners[i](); }
			catch (e) { console.warn('[Realism] inventory listener threw', e); }
		}
	}

	private scheduleSave(): void
	{
		// several changes in one frame cost one write
		if (this.saveTimer) return;
		try { this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 0); }
		catch (e) { this.save(); }
	}

	private load(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			const raw = ls ? ls.getItem(INVENTORY_KEY) : null;
			if (!raw) return;
			const d = JSON.parse(raw);
			if (!d || d.v !== 1 || !(d.items instanceof Array)) return;
			for (let i = 0; i < d.items.length && i < 500; i++)
			{
				const e = d.items[i];
				if (!(e instanceof Array)) continue;
				const k = cleanId(e[0]);
				const n = Math.floor(+e[1]);
				if (!k || !(n > 0) || this.qty[k] !== undefined) continue;
				this.order.push(k);
				this.qty[k] = Math.min(this.maxStack, n);
				if (e.length > 2 && e[2] !== null && e[2] !== undefined) this.meta[k] = e[2];
			}
		}
		catch (e) { /* corrupt save: start empty */ }
	}

	public save(): void
	{
		if (this.saveTimer) { try { clearTimeout(this.saveTimer); } catch (e) { /* ignore */ } this.saveTimer = null; }
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			if (!ls) return;
			const items: any[] = [];
			for (let i = 0; i < this.order.length; i++)
			{
				const k = this.order[i];
				if (!(this.qty[k] > 0)) continue;
				items.push(this.meta[k] !== undefined ? [k, this.qty[k], this.meta[k]] : [k, this.qty[k]]);
			}
			ls.setItem(INVENTORY_KEY, JSON.stringify({ v: 1, items: items }));
		}
		catch (e) { /* storage full / blocked */ }
	}
}

/** Creates (world as any).realismInventory once. Returns the implementation. */
export function buildInventory(ctx: RealismCtx): RealismInventory
{
	const w: any = ctx.world;
	if (w.realismInventoryImpl) return w.realismInventoryImpl;
	const inv = new RealismInventory(ctx);
	w.realismInventory = inv.api;
	w.realismInventoryImpl = inv;
	try { if (typeof window !== 'undefined' && (window as any).addEventListener) (window as any).addEventListener('beforeunload', () => inv.save()); }
	catch (e) { /* headless */ }
	return inv;
}
