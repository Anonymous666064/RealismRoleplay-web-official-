/*
 * RealismProperties.ts  (A15, contract C10)
 * ----------------------------------------
 * Every buyable building of the county (houses incl. NPC homes, apartment blocks, motels, the four
 * hotels, the bank, shops, offices and warehouses), its price, daily business income, ownership
 * (localStorage 'realism.properties.v1', per seed) and the GPS blips of what you own.
 * The SV Realty website (RealismInternetSites.ts) is the shop window; RealismDoors (A12) reads owns().
 *
 * (world as any).realismProperties = {
 *   list(): Array<{ id, buildingIndex, name, kind, price, owned, income?, sub, district, x, z, floors, area, npcHome, closed }>
 *   owns(buildingIndex: number): boolean
 *   ownedList(): same records, owned only
 *   buy(id: string): boolean          // realismEconomy.spend(price, ..., 'SV Realty'); emits realismEvents 'propertyBought' {id}
 *   sell(id: string): boolean         // pays sellBack * price to the bank; emits 'propertySold' {id}
 *   onChange(cb: () => void): void
 *   get(id: string): record | null
 *   // extras
 *   kinds(): { [kind: string]: number }   counts by kind
 *   dailyIncome(): number                 total of the owned businesses per in-game day
 *   setWaypoint(id: string): boolean      realismGPS.setWaypoint at the building
 *   payDay(day?: number): number          pays one in-game day of income now (tests / sleeping)
 *   lastError: string
 * }
 * id = 'b' + index in ctx.data.buildings (stable per seed). Records are shared: treat them as read-only.
 *
 * Config (realism-config.js -> properties, all optional):
 *   priceScale: 1        multiplies every price
 *   sellBack: 0.7        share of the price you get back when selling
 *   incomeScale: 1       multiplies every business income
 *   taxRate: 0           property tax per in-game day as a share of the price (0 = off, e.g. 0.0005)
 *   blips: true          GPS blips on the properties you own
 *   npcHomes: true       NPC homes are listed for sale too
 */

import { RealismCtx } from './RealismContext';
import { Building, REGIONS } from './RealismMapData';

export const PROPERTIES_KEY = 'realism.properties.v1';
const MERCHANT = 'SV Realty';

export interface PropertyRecord
{
	id: string;
	buildingIndex: number;
	name: string;
	kind: string;        // house | apartment | motel | hotel | bank | shop | office | warehouse
	sub: string;
	price: number;
	owned: boolean;
	income: number;      // $ per in-game day (0 for homes and warehouses)
	district: string;
	region: string;
	x: number;
	z: number;
	floors: number;
	area: number;        // floor area m2
	npcHome: boolean;
	closed: boolean;
	hood: boolean;
	tint: number[];
	label: string;
}

export interface PropertySettings
{
	priceScale: number;
	sellBack: number;
	incomeScale: number;
	taxRate: number;
	blips: boolean;
	npcHomes: boolean;
}

function num(v: any, d: number, lo: number, hi: number): number
{
	const n = typeof v === 'number' && isFinite(v) ? v : d;
	return Math.max(lo, Math.min(hi, n));
}

export function propertySettings(cfg: any): PropertySettings
{
	const raw: any = (cfg && cfg.properties) || {};
	return {
		priceScale: num(raw.priceScale, 1, 0.01, 100),
		sellBack: num(raw.sellBack, 0.7, 0, 1),
		incomeScale: num(raw.incomeScale, 1, 0, 100),
		taxRate: num(raw.taxRate, 0, 0, 0.1),
		blips: raw.blips !== false,
		npcHomes: raw.npcHomes !== false,
	};
}

/** $ per m2 of floor area. */
const RATE: { [k: string]: number } = { house: 520, apartment: 380, motel: 330, hotel: 420, bank: 650, shop: 560, office: 480, warehouse: 160 };
/** Daily income as a share of the price. */
const INCOME: { [k: string]: number } = { house: 0, apartment: 0.009, motel: 0.012, hotel: 0.01, bank: 0.008, shop: 0.011, office: 0.007, warehouse: 0 };
const MIN_PRICE: { [k: string]: number } = { house: 45000, apartment: 250000, motel: 220000, hotel: 2500000, bank: 3000000, shop: 90000, office: 300000, warehouse: 120000 };
const REGION_MULT: { [k: string]: number } = { downtown: 1.5, northSuburbs: 1.2, westSuburbs: 1.0, eastside: 0.8, port: 0.7, airport: 0.9, farmland: 0.6, prison: 0.5 };
export const REGION_NAME: { [k: string]: string } = {
	downtown: 'Downtown', port: 'Port of Verano', eastside: 'Eastside', westSuburbs: 'Willow Park', northSuburbs: 'Hillcrest',
	airport: 'Airport', prison: 'County', farmland: 'Old Mill Farmland',
};
export const KIND_LABEL: { [k: string]: string } = {
	house: 'House', apartment: 'Apartment block', motel: 'Motel', hotel: 'Hotel', bank: 'Bank', shop: 'Shop', office: 'Office', warehouse: 'Warehouse',
};
export const KIND_ICON: { [k: string]: string } = {
	house: 'house', apartment: 'house', motel: 'hotel', hotel: 'hotel', bank: 'bank', shop: 'shop', office: 'property', warehouse: 'warehouse',
};
const SUB_LABEL: { [k: string]: string } = {
	convenience: 'Corner Store', clothing: 'Boutique', restaurant: 'Restaurant', barber: 'Barbershop', laundromat: 'Laundromat', pharmacy: 'Pharmacy',
	diner: 'Diner', cafe: 'Cafe', market: '24/7 Market', lobby: 'Offices', apartment: 'Apartments', warehouse: 'Warehouse', living: 'Home',
};

/** Which property kind a building is sold as, or null when it isn't for sale. */
export function propertyKind(b: Building): string | null
{
	if (!b) return null;
	if (b.custom === 'hotel') return 'hotel';
	if (b.custom) return null;                                       // police, sheriff, prison, lookout ...
	if (b.role === 'wall' || b.role === 'tower') return null;
	if (!(b.enterable || b.closed) || b.w < 6 || b.d < 6) return null;
	const k = b.kind || '', s = b.sub || '';
	if (k === 'prop' || k === 'civic' || k === 'barn') return null;
	if (s === 'dealer' || s === 'mechanic' || s === 'hangar') return null;   // game systems
	if (s === 'motel') return 'motel';
	if (s === 'bank') return 'bank';
	if (k === 'house') return 'house';
	if (k === 'apartment') return 'apartment';
	if (k === 'shop') return 'shop';
	if (k === 'office' || k === 'tower') return 'office';
	if (k === 'warehouse') return 'warehouse';
	return null;
}

function regionOf(x: number, z: number): string
{
	for (const k in REGIONS)
	{
		if (!REGIONS.hasOwnProperty(k)) continue;
		const r = REGIONS[k];
		if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return k;
	}
	return '';
}

function roundPrice(p: number): number
{
	if (p >= 1000000) return Math.round(p / 50000) * 50000;
	if (p >= 100000) return Math.round(p / 5000) * 5000;
	return Math.round(p / 1000) * 1000;
}

function titleCase(s: string): string
{
	return s.toLowerCase().replace(/(^|[\s\-\/])([a-z])/g, (m, a, c) => a + c.toUpperCase());
}

export class RealismProperties
{
	public settings: PropertySettings;
	public lastError = '';
	public api: any;
	private ctx: RealismCtx;
	private world: any;
	private records: PropertyRecord[] = null;
	private byId: { [id: string]: PropertyRecord } = {};
	private byIndex: { [i: number]: PropertyRecord } = {};
	private owned: { [id: string]: { day: number; price: number } } = {};
	private lastDay = -1;
	private listeners: (() => void)[] = [];
	private blipsDone = false;

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		this.settings = propertySettings(ctx.cfg);
		this.load();
		this.api = this.makeApi();
	}

	// ------------------------------------------------------------------ listing

	/** Builds the listing on first use (about 1-3 ms). */
	public all(): PropertyRecord[]
	{
		if (this.records) return this.records;
		const data = this.ctx.data;
		const out: PropertyRecord[] = [];
		const npcs: any = this.world.realismNPCs;
		const homeSet: any = npcs && npcs.homeSet ? npcs.homeSet : null;
		const namer = new StreetNamer(data);
		const hoods: any[] = data.hoods || [];
		for (let i = 0; i < data.buildings.length; i++)
		{
			const b = data.buildings[i];
			const kind = propertyKind(b);
			if (!kind) continue;
			const npcHome = !!(homeSet && homeSet[i]);
			if (npcHome && !this.settings.npcHomes) continue;
			const region = regionOf(b.x, b.z);
			let hood = '';
			if (b.district === 'hood') for (let h = 0; h < hoods.length; h++) { const r = hoods[h]; if (b.x >= r.x0 && b.x <= r.x1 && b.z >= r.z0 && b.z <= r.z1) { hood = r.name; break; } }
			const above = b.h + b.baseY - (b.groundY !== undefined ? b.groundY : b.baseY);
			const floors = kind === 'house' ? Math.max(1, b.floors || 1) : Math.max(1, b.floors || Math.round(above / 3.4));
			const area = Math.round(b.w * b.d * floors);
			let mult = REGION_MULT[region] || 0.85;
			if (b.district === 'hood') mult *= 0.45;
			if (b.closed) mult *= 0.6;
			mult *= 0.6 + 0.4 * (b.condition !== undefined ? b.condition : 1);
			const price = roundPrice(Math.max(MIN_PRICE[kind] * (b.district === 'hood' ? 0.5 : 1), area * RATE[kind] * mult) * this.settings.priceScale);
			const income = Math.round(price * INCOME[kind] * this.settings.incomeScale * (b.closed ? 0.5 : 1));
			const rec: PropertyRecord = {
				id: 'b' + i, buildingIndex: i, name: '', kind: kind, sub: b.sub || '', price: price, owned: !!this.owned['b' + i], income: income,
				district: hood || REGION_NAME[region] || 'San Verano County', region: region, x: b.x, z: b.z, floors: floors, area: area,
				npcHome: npcHome, closed: !!b.closed, hood: b.district === 'hood', tint: b.tint ? b.tint.slice(0, 3) : [0.7, 0.7, 0.7], label: b.label || '',
			};
			rec.name = this.nameFor(b, rec, namer);
			out.push(rec);
			this.byId[rec.id] = rec;
			this.byIndex[i] = rec;
		}
		this.records = out;
		return out;
	}

	private nameFor(b: Building, r: PropertyRecord, namer: StreetNamer): string
	{
		if (r.kind === 'hotel' && b.label) return titleCase(b.label);
		if (r.kind === 'bank' && b.label) return titleCase(b.label);
		const st = namer.nearest(b.x, b.z);
		const no = 100 + ((r.buildingIndex * 37) % 89) * 20 + (r.buildingIndex % 2);
		if (r.kind === 'motel') return (b.label && b.label !== 'MOTEL' ? titleCase(b.label) : st.split(' ')[0] + ' Motor Inn');
		if (b.label && r.kind !== 'house') return titleCase(b.label) + ', ' + st;
		if (r.kind === 'house') return no + ' ' + st;
		if (r.kind === 'apartment') return st + ' Apartments #' + no;
		if (r.kind === 'warehouse') return 'Unit ' + no + ', ' + st;
		if (r.kind === 'shop') return (SUB_LABEL[r.sub] || 'Storefront') + ', ' + no + ' ' + st;
		return no + ' ' + st + (r.kind === 'office' ? ' (offices)' : '');
	}

	public get(id: string): PropertyRecord | null { this.all(); return this.byId[id] || null; }
	public owns(i: number): boolean { return !!this.owned['b' + i]; }
	public ownedList(): PropertyRecord[] { this.all(); const out: PropertyRecord[] = []; for (const id in this.owned) if (this.owned.hasOwnProperty(id) && this.byId[id]) out.push(this.byId[id]); return out; }
	public kinds(): { [k: string]: number } { const c: { [k: string]: number } = {}; const a = this.all(); for (let i = 0; i < a.length; i++) c[a[i].kind] = (c[a[i].kind] || 0) + 1; return c; }
	public dailyIncome(): number { let s = 0; const l = this.ownedList(); for (let i = 0; i < l.length; i++) s += l[i].income; return s; }
	public dailyTax(): number { if (!this.settings.taxRate) return 0; let s = 0; const l = this.ownedList(); for (let i = 0; i < l.length; i++) s += Math.round(l[i].price * this.settings.taxRate); return s; }
	public sellPrice(id: string): number { const r = this.get(id); return r ? Math.round(r.price * this.settings.sellBack) : 0; }

	// ------------------------------------------------------------------ buy / sell

	public buy(id: string): boolean
	{
		this.lastError = '';
		const r = this.get(id);
		const eco = this.world.realismEconomy;
		if (!r) { this.lastError = 'Unknown property'; return false; }
		if (r.owned) { this.lastError = 'You already own it'; return false; }
		if (!eco || typeof eco.spend !== 'function') { this.lastError = 'Banking unavailable'; return false; }
		if (!eco.spend(r.price, 'Property: ' + r.name, MERCHANT))
		{
			this.lastError = eco.lastError || 'Not enough money';
			return false;
		}
		r.owned = true;
		this.owned[id] = { day: Math.max(0, this.lastDay), price: r.price };
		this.save();
		this.blip(r, true);
		this.emit('propertyBought', { id: id, buildingIndex: r.buildingIndex, kind: r.kind, price: r.price, name: r.name });
		this.changed();
		return true;
	}

	public sell(id: string): boolean
	{
		this.lastError = '';
		const r = this.get(id);
		const eco = this.world.realismEconomy;
		if (!r || !r.owned) { this.lastError = 'You don\'t own it'; return false; }
		if (!eco || typeof eco.earn !== 'function') { this.lastError = 'Banking unavailable'; return false; }
		const value = this.sellPrice(id);
		eco.earn(value, 'Sold property: ' + r.name, MERCHANT, 'bank');
		r.owned = false;
		delete this.owned[id];
		this.save();
		this.blip(r, false);
		this.emit('propertySold', { id: id, buildingIndex: r.buildingIndex, kind: r.kind, price: value, name: r.name });
		this.changed();
		return true;
	}

	public setWaypoint(id: string): boolean
	{
		const r = this.get(id);
		const gps = this.world.realismGPS;
		if (!r || !gps || typeof gps.setWaypoint !== 'function') return false;
		try { gps.setWaypoint({ x: r.x, z: r.z }, r.name); return true; }
		catch (e) { return false; }
	}

	// ------------------------------------------------------------------ income (called by the internet clock)

	/** New in-game day index. Pays every day passed since the last payout (max 3 at once). */
	public onDay(day: number): number
	{
		if (this.lastDay < 0) { this.lastDay = day; this.save(); return 0; }
		let paid = 0;
		let n = 0;
		while (this.lastDay < day && n < 3) { this.lastDay++; n++; paid += this.payDay(this.lastDay); }
		this.lastDay = day;
		this.save();
		return paid;
	}

	/** One day of income (and tax) now. Returns the net amount. */
	public payDay(day?: number): number
	{
		const eco = this.world.realismEconomy;
		if (!eco) return 0;
		const inc = this.dailyIncome(), tax = this.dailyTax();
		const label = day !== undefined ? ' (day ' + day + ')' : '';
		if (inc > 0) eco.earn(inc, 'Property income' + label, MERCHANT, 'bank');
		if (tax > 0 && typeof eco.spend === 'function') eco.spend(tax, 'Property tax' + label, 'San Verano County', 'card');
		if (inc > 0 || tax > 0) this.changed();
		return inc - tax;
	}

	/** Adds the blips of owned properties once realismGPS exists (called from the internet clock). */
	public ensureBlips(): void
	{
		if (this.blipsDone || !this.world.realismGPS) return;
		this.blipsDone = true;
		const l = this.ownedList();
		for (let i = 0; i < l.length; i++) this.blip(l[i], true);
	}

	private blip(r: PropertyRecord, on: boolean): void
	{
		const gps = this.world.realismGPS;
		if (!gps || !this.settings.blips) return;
		try
		{
			if (on && typeof gps.addBlip === 'function') gps.addBlip('property_' + r.id, { x: r.x, z: r.z, icon: KIND_ICON[r.kind] || 'property', color: '#4caf50', label: r.name, shortRange: r.kind === 'house' });
			else if (!on && typeof gps.removeBlip === 'function') gps.removeBlip('property_' + r.id);
		}
		catch (e) { /* GPS is optional */ }
	}

	private emit(name: string, data: any): void
	{
		const ev = this.world.realismEvents;
		try { if (ev && typeof ev.emit === 'function') ev.emit(name, data); } catch (e) { console.warn('[Realism] event listener failed', name, e); }
	}

	public onChange(cb: () => void): void { if (typeof cb === 'function') this.listeners.push(cb); }

	private changed(): void
	{
		for (let i = 0; i < this.listeners.length; i++) { try { this.listeners[i](); } catch (e) { console.warn('[Realism] properties listener failed', e); } }
	}

	// ------------------------------------------------------------------ storage

	private load(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			const raw = ls ? ls.getItem(PROPERTIES_KEY) : null;
			if (!raw) return;
			const d = JSON.parse(raw);
			const s = d && d.v === 1 && d.seeds ? d.seeds[String(this.ctx.data.seed)] : null;
			if (!s) return;
			const o = s.owned || {};
			for (const id in o) if (o.hasOwnProperty(id) && /^b\d+$/.test(id)) this.owned[id] = { day: +o[id].day || 0, price: +o[id].price || 0 };
			this.lastDay = isFinite(s.lastDay) ? +s.lastDay : -1;
		}
		catch (e) { console.warn('[Realism] Could not read owned properties', e); }
	}

	public save(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			if (!ls) return;
			let d: any = null;
			try { d = JSON.parse(ls.getItem(PROPERTIES_KEY) || 'null'); } catch (e) { d = null; }
			if (!d || d.v !== 1 || !d.seeds) d = { v: 1, seeds: {} };
			d.seeds[String(this.ctx.data.seed)] = { owned: this.owned, lastDay: this.lastDay };
			ls.setItem(PROPERTIES_KEY, JSON.stringify(d));
		}
		catch (e) { /* storage full or blocked */ }
	}

	private makeApi(): any
	{
		const self = this;
		return {
			list(): PropertyRecord[] { return self.all().slice(0); },
			owns(buildingIndex: number): boolean { return self.owns(buildingIndex); },
			ownedList(): PropertyRecord[] { return self.ownedList(); },
			buy(id: string): boolean { return self.buy(id); },
			sell(id: string): boolean { return self.sell(id); },
			onChange(cb: () => void): void { self.onChange(cb); },
			get(id: string): PropertyRecord | null { return self.get(id); },
			kinds(): { [k: string]: number } { return self.kinds(); },
			dailyIncome(): number { return self.dailyIncome(); },
			setWaypoint(id: string): boolean { return self.setWaypoint(id); },
			payDay(day?: number): number { return self.payDay(day); },
			sellPrice(id: string): number { return self.sellPrice(id); },
			get lastError(): string { return self.lastError; },
		};
	}
}

/** Nearest named road for street addresses (coarse 64 m grid of road points). */
class StreetNamer
{
	private grid: { [k: string]: { x: number; z: number; name: string }[] } = {};

	constructor(data: any)
	{
		const roads: any[] = data.roads || [];
		for (let r = 0; r < roads.length; r++)
		{
			const road = roads[r];
			if (!road.name || !/street|avenue|highway|rural/.test(road.kind)) continue;
			const pts = road.pts || [];
			for (let i = 0; i < pts.length; i += 2)
			{
				const p = pts[i];
				const k = Math.floor(p.x / 64) + '_' + Math.floor(p.z / 64);
				(this.grid[k] || (this.grid[k] = [])).push({ x: p.x, z: p.z, name: road.name });
			}
		}
	}

	public nearest(x: number, z: number): string
	{
		const gx = Math.floor(x / 64), gz = Math.floor(z / 64);
		let best = 1e18, name = '';
		for (let ring = 0; ring <= 3 && !name; ring++)
		{
			for (let dx = -ring; dx <= ring; dx++) for (let dz = -ring; dz <= ring; dz++)
			{
				if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
				const cell = this.grid[(gx + dx) + '_' + (gz + dz)];
				if (!cell) continue;
				for (let i = 0; i < cell.length; i++)
				{
					const q = cell[i], d = (q.x - x) * (q.x - x) + (q.z - z) * (q.z - z);
					if (d < best) { best = d; name = q.name; }
				}
			}
		}
		if (!name) return 'County Road';
		return /road|street|avenue|ave|st\b|rd\b|highway|hwy|boulevard|blvd|lane|way|drive|dr\b/i.test(name) ? name : name + ' Street';
	}
}
