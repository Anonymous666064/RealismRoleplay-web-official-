/*
 * RealismIllegalJobs.ts
 * ---------------------
 * Abstract, fictional production jobs (game mechanics only: named stations, timers, minigames):
 *
 *  Contacts (people with a marker over their head, placed at runtime beside existing buildings):
 *    Sal (supplier)      Harbor Row hood    buys: nothing; sells Supplies ($60), Lab kits ($400), cash only
 *    Dre (street dealer) Hillcrest Projects buys Lean (cup) and Weed (bag), at most illegal.dealerMaxPerHour units
 *                                           per in-game hour, refuses while heat >= 80
 *    Big Mo (bulk buyer) The Flats          buys Weed (bag) in bulk only (illegal.bulkMin or more), better price
 *    El Patron's man     Port, by the water buys Coke (brick), only at night (illegal.cartelHours, 8 PM - 5 AM)
 *  Every sale may be noticed (illegal.saleCrimeChance): a 'crime' event { kind: 'drugSale' } + heat.
 *
 *  LEAN (hideout kitchens: The Basement, The Back Room)
 *    "[E] Start batch" takes lean.suppliesPerBatch Supplies and opens the KITCHEN minigame (3 timing stages,
 *    progress bar of lean.seconds). Cups = lean.baseCups + hits. A failed batch is lost.
 *  COKE (Container Lab): three generic stations
 *    Mixing bench  "[E] Start" takes a Lab kit, timing minigame (coke.mixSeconds)       -> Batch tray
 *    Press         hold E (coke.pressHold s), takes a Batch tray                      -> Pressed block
 *    Packaging     "[E] Start" takes a Pressed block, runs coke.packSeconds (game running) -> "[E] Collect"
 *                  coke.bricksPerBatch Coke (brick) (+1 for a perfect mixing run)
 *  WEED: RealismIllegalWeed.ts.
 *
 * API (world as any).realismIllegal.jobs = { contacts, stations, startKitchen(id), startMix(), press(),
 *   startPack(), collect(), sell(contactId, item, qty), buy(item, qty), price(contactId, item) }
 */

import * as THREE from 'three';
import { IllegalCore, besideBuilding, reserve, money, ITEMS, Site, MenuRow, PromptItem, PocketRoom } from './RealismIllegalCore';
import { Hideouts } from './RealismHideouts';
import { REGIONS } from './RealismMapData';

export interface Contact { id: string; name: string; role: string; site: Site; blip: string; color: string; figure: THREE.Object3D; marker: THREE.Object3D; }

export class IllegalJobs
{
	public api: any;
	public contacts: Contact[] = [];
	public stations: { id: string; hideout: string; kind: string; x: number; y: number; z: number }[] = [];
	private core: IllegalCore;
	private hideouts: Hideouts;
	private acc = 0;

	constructor(core: IllegalCore, hideouts: Hideouts)
	{
		this.core = core;
		this.hideouts = hideouts;
		this.placeContacts();
		this.buildStations();
		core.addUpdater(this);
		const self = this;
		this.api = {
			get contacts(): any[] { return self.contacts.map((c) => ({ id: c.id, name: c.name, role: c.role, x: +c.site.x.toFixed(1), z: +c.site.z.toFixed(1) })); },
			get stations(): any[] { return self.stations.slice(0); },
			buy(item: string, qty: number): boolean { return self.buy(item, qty); },
			sell(contact: string, item: string, qty: number): number { return self.sell(contact, item, qty); },
			price(contact: string, item: string): number { return self.price(contact, item); },
			startKitchen(id: string): boolean { return self.startKitchen(id); },
			startMix(): boolean { return self.startMix(); },
			press(): boolean { return self.press(); },
			startPack(): boolean { return self.startPack(); },
			collect(): number { return self.collect(); },
			lab(): any { return self.lab(); },
			present(contact: string): boolean { const c = self.contact(contact); return !!c && self.present(c); },
		};
	}

	// ------------------------------------------------------------------ contacts

	private hoodRect(re: RegExp): any
	{
		const hs: any[] = this.core.ctx.data.hoods || [];
		return hs.filter((h) => re.test(h.name))[0] || null;
	}

	/** A spot beside a building inside a rect (closest to its centre first). */
	private siteIn(rect: any, filter: (b: any) => boolean, w: number, d: number, road: string): Site | null
	{
		if (!rect) return null;
		const ctx = this.core.ctx;
		const bs: any[] = ctx.data.buildings;
		const cx = (rect.x0 + rect.x1) / 2, cz = (rect.z0 + rect.z1) / 2;
		const cand: number[] = [];
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.custom || !(b.x >= rect.x0 && b.x <= rect.x1 && b.z >= rect.z0 && b.z <= rect.z1) || !filter(b)) continue;
			cand.push(i);
		}
		cand.sort((a, b) => Math.hypot(bs[a].x - cx, bs[a].z - cz) - Math.hypot(bs[b].x - cx, bs[b].z - cz));
		for (let k = 0; k < cand.length && k < 60; k++)
		{
			const s = besideBuilding(ctx, cand[k], w, d, { road: road });
			if (s) return s;
		}
		return null;
	}

	private placeContacts(): void
	{
		const flats = this.hoodRect(/flats/i), hill = this.hoodRect(/hillcrest/i), harbor = this.hoodRect(/harbor/i);
		const notProp = (b: any) => b.kind !== 'prop';
		this.addContact('supplier', 'Sal', 'Supplier', this.siteIn(harbor, notProp, 2.4, 2.4, 'near'), '#f2a33a', [0.35, 0.3, 0.25]);
		this.addContact('dealer', 'Dre', 'Street dealer', this.siteIn(hill, notProp, 2.4, 2.4, 'near'), '#e04f4f', [0.15, 0.15, 0.18]);
		this.addContact('bulk', 'Big Mo', 'Bulk buyer', this.siteIn(flats, notProp, 2.4, 2.4, 'near'), '#3fa9f5', [0.4, 0.15, 0.15]);
		const port = REGIONS.port;
		const water = { x0: port.x0, x1: port.x1, z0: port.z0 + (port.z1 - port.z0) * 0.55, z1: port.z1 };
		this.addContact('cartel', 'El Patron\'s man', 'Cartel buyer (night)', this.siteIn(water, (b) => b.kind === 'warehouse' || (b.kind === 'prop' && b.style === 'steel'), 2.4, 2.4, 'near'), '#ffd700', [0.85, 0.85, 0.82]);
	}

	private addContact(id: string, name: string, role: string, s: Site, color: string, tint: number[]): void
	{
		if (!s) { console.warn('[Realism] Illegal: no spot for ' + name); return; }
		reserve(s.x, s.z, 2.5, 'contact ' + id);
		const core = this.core;
		const fig = core.figure(s.x, s.y, s.z, s.rot, tint);
		const marker = core.marker(s.x, s.y + 0.0, s.z, color, { radius: 0.7, range: 90, column: false });
		const blip = 'ill_' + id;
		core.addBlip(blip, { x: s.x, z: s.z, icon: id === 'supplier' ? 'shop' : id === 'cartel' ? 'buyer' : 'dealer', color: color, label: name + ' (' + role + ')' });
		const c: Contact = { id: id, name: name, role: role, site: s, blip: blip, color: color, figure: fig, marker: marker };
		this.contacts.push(c);
		core.add({ id: 'contact_' + id, x: s.x, y: s.y, z: s.z, r: 2.6, mode: 'foot', blip: blip,
			items: () => this.present(c) ? [{ key: 'E', label: id === 'supplier' ? 'Buy from ' + name : 'Deal with ' + name }] : null,
			act: () => this.openContact(c) });
	}

	public contact(id: string): Contact { for (let i = 0; i < this.contacts.length; i++) if (this.contacts[i].id === id) return this.contacts[i]; return null; }

	public present(c: Contact): boolean
	{
		if (c.id !== 'cartel') return true;
		const h = this.core.cfg.cartelHours;
		return this.core.isNight(h[0], h[1]);
	}

	// ------------------------------------------------------------------ trading

	public price(contact: string, item: string): number
	{
		const P = this.core.cfg.prices;
		const t = contact === 'dealer' ? P.dealer : contact === 'bulk' ? P.bulk : contact === 'cartel' ? P.cartel : null;
		return t && typeof t[item] === 'number' ? t[item] : 0;
	}

	public buy(item: string, qty: number): boolean
	{
		const p = this.core.cfg.prices[item];
		if (typeof p !== 'number' || qty <= 0) return false;
		const total = p * qty;
		if (!this.core.payCash(total, 'Bought ' + qty + ' x ' + ITEMS[item].name, 'Sal')) { this.core.toast('Not enough cash (' + money(total) + ').'); return false; }
		this.core.give(item, qty);
		this.core.toast('Bought ' + qty + ' x ' + ITEMS[item].name + '.');
		return true;
	}

	private dealerRoom(): number
	{
		const st = this.core.state.dealer;
		const hourKey = Math.floor(this.core.state.clock || 0);
		if (st.hour !== hourKey) { st.hour = hourKey; st.sold = 0; }
		return Math.max(0, this.core.cfg.dealerMaxPerHour - st.sold);
	}

	/** Sells qty (<= 0: as many as allowed) of an item; returns the number sold. */
	public sell(contact: string, item: string, qty: number): number
	{
		const c = this.contact(contact);
		const unit = this.price(contact, item);
		if (!c || unit <= 0 || !this.present(c)) return 0;
		if (this.core.heat >= 80 && contact !== 'cartel') { this.core.toast(c.name + ': "You\'re too hot right now. Lay low."'); return 0; }
		let n = this.core.count(item);
		if (qty > 0) n = Math.min(n, qty);
		if (contact === 'dealer') n = Math.min(n, this.dealerRoom());
		if (contact === 'bulk' && n < this.core.cfg.bulkMin) { this.core.toast(c.name + ': "I only buy ' + this.core.cfg.bulkMin + ' or more."'); return 0; }
		if (n <= 0) return 0;
		if (!this.core.take(item, n)) return 0;
		if (contact === 'dealer') this.core.state.dealer.sold += n;
		const total = unit * n;
		this.core.earnCash(total, 'Sold ' + n + ' x ' + ITEMS[item].name, c.name);
		this.core.toast('Sold ' + n + ' x ' + ITEMS[item].name + ' for ' + money(total) + '.');
		if (this.core.random() < this.core.cfg.saleCrimeChance)
		{
			this.core.crime('drugSale', new THREE.Vector3(c.site.x, c.site.y, c.site.z), this.core.cfg.heat.sale);
			this.core.toast('Someone saw the deal. Heat is up.');
		}
		this.core.markDirty();
		return n;
	}

	private openContact(c: Contact): void
	{
		this.core.reveal(c.blip);
		if (c.id === 'supplier')
		{
			const P = this.core.cfg.prices;
			this.core.menu({
				title: c.name.toUpperCase() + ' - SUPPLIER', subtitle: 'Cash only. Supplies for the kitchen, kits for the lab, pots for a grow room.',
				rows: () => [
					{ label: 'Supplies', detail: 'you have ' + this.core.count('supplies'), right: money(P.supplies), action: () => this.buy('supplies', 1) },
					{ label: '5 x Supplies', right: money(P.supplies * 5), action: () => this.buy('supplies', 5) },
					{ label: 'Lab kit', detail: 'you have ' + this.core.count('lab_kit'), right: money(P.lab_kit), action: () => this.buy('lab_kit', 1) },
					{ label: 'Starter pot', detail: 'you have ' + this.core.count('starter_pot'), right: money(P.starter_pot), action: () => this.buy('starter_pot', 1) },
					{ label: '5 x Starter pot', right: money(P.starter_pot * 5), action: () => this.buy('starter_pot', 5) },
				],
			});
			return;
		}
		const items = c.id === 'dealer' ? ['lean_cup', 'weed_bag'] : c.id === 'bulk' ? ['weed_bag'] : ['coke_brick'];
		this.core.menu({
			title: c.name.toUpperCase() + ' - ' + c.role.toUpperCase(),
			subtitle: c.id === 'dealer' ? 'Takes up to ' + this.core.cfg.dealerMaxPerHour + ' units an hour.' : c.id === 'bulk' ? 'Bulk only: ' + this.core.cfg.bulkMin + '+ bags.' : 'Only at night, only bricks.',
			rows: () =>
			{
				const rows: MenuRow[] = [];
				for (let i = 0; i < items.length; i++)
				{
					const it = items[i];
					const have = this.core.count(it), unit = this.price(c.id, it);
					let n = have;
					if (c.id === 'dealer') n = Math.min(n, this.dealerRoom());
					rows.push({ label: 'Sell ' + ITEMS[it].name, detail: 'you have ' + have + (c.id === 'dealer' ? ', he takes ' + this.dealerRoom() + ' more this hour' : ''), right: money(unit) + ' each',
						disabled: n <= 0 || (c.id === 'bulk' && n < this.core.cfg.bulkMin), action: () => this.sell(c.id, it, 0) });
				}
				return rows;
			},
		});
	}

	// ------------------------------------------------------------------ stations

	private buildStations(): void
	{
		const kitchens = ['basement', 'backroom'];
		for (let i = 0; i < kitchens.length; i++)
		{
			const h = this.hideouts.get(kitchens[i]);
			const sl = h ? this.hideouts.slot(h.id) : null;
			if (!h || !sl) continue;
			const room = h.room;
			this.bench(room, sl, [0.6, 0.6, 0.62], 'KITCHEN', '#ff9ad5');
			room.box(sl.x - 0.5, 0.98, sl.z, 0.5, 0.12, 0.5, [0.2, 0.2, 0.22]);       // hot plate
			room.box(sl.x + 0.45, 1.02, sl.z, 0.18, 0.2, 0.18, [0.75, 0.45, 0.85]);   // cups
			const p = room.p(sl.x, 0, sl.z + 1.0 * Math.cos(sl.rot));
			const id = 'kitchen_' + h.id;
			this.stations.push({ id: id, hideout: h.id, kind: 'kitchen', x: p.x, y: p.y, z: p.z });
			this.core.add({ id: id, x: p.x, y: p.y, z: p.z, r: 1.7, mode: 'foot', items: () => this.kitchenItems(), act: () => this.startKitchen(id) });
		}
		const lab = this.hideouts.get('container');
		if (lab)
		{
			const names = [['mix', 'MIXING BENCH', '#9ad0ff'], ['press', 'PRESS', '#ffd27f'], ['pack', 'PACKAGING', '#b4ff9a']];
			for (let i = 0; i < names.length; i++)
			{
				const sl = this.hideouts.slot('container');
				if (!sl) break;
				const room = lab.room;
				this.bench(room, sl, [0.55, 0.57, 0.6], names[i][1], names[i][2]);
				if (names[i][0] === 'press') room.box(sl.x, 1.4, sl.z, 0.6, 0.9, 0.6, [0.3, 0.32, 0.36]);
				if (names[i][0] === 'pack') room.box(sl.x + 0.4, 1.05, sl.z, 0.6, 0.25, 0.4, [0.7, 0.6, 0.4]);
				if (names[i][0] === 'mix') room.box(sl.x - 0.3, 1.05, sl.z, 0.7, 0.2, 0.45, [0.85, 0.85, 0.88]);
				const p = room.p(sl.x, 0, sl.z + 1.0);
				const id = 'lab_' + names[i][0];
				this.stations.push({ id: id, hideout: 'container', kind: names[i][0], x: p.x, y: p.y, z: p.z });
				const kind = names[i][0];
				this.core.add({ id: id, x: p.x, y: p.y, z: p.z, r: 1.5, mode: 'foot', items: () => this.labItems(kind), act: () => this.labAct(kind) });
			}
		}
	}

	private bench(room: PocketRoom, sl: { x: number; z: number; rot: number }, c: number[], title: string, color: string): void
	{
		room.box(sl.x, 0.46, sl.z, 2.0, 0.92, 0.8, c, true);
		const lz = sl.z + (sl.rot === 0 ? -0.55 : 0.55);
		room.label(title, sl.x, 2.1, sl.rot === 0 ? -room.d / 2 + 0.06 : room.d / 2 - 0.06, sl.rot === 0 ? 0 : Math.PI, 1.5, color);
		void lz;
	}

	private kitchenItems(): PromptItem[]
	{
		const need = this.core.cfg.lean.suppliesPerBatch;
		const have = this.core.count('supplies');
		return [{ key: 'E', label: have >= need ? 'Start batch (' + need + ' Supplies)' : 'Need ' + need + ' Supplies (have ' + have + ')' }];
	}

	public lastBatch: { cups: number; success: boolean } = null;

	public startKitchen(id: string): boolean
	{
		const L = this.core.cfg.lean;
		if (this.core.timing) return false;
		if (!this.core.take('supplies', L.suppliesPerBatch)) { this.core.toast('You need ' + L.suppliesPerBatch + ' Supplies. Sal sells them.'); return false; }
		this.core.startTiming({
			owner: 'illegal', title: 'KITCHEN', stages: ['Heat', 'Stir', 'Pour'], zone: 0.24, speed: 0.55, maxMisses: 3, stageTimeout: 4, duration: L.seconds,
			onFinish: (r) =>
			{
				if (!r.success) { this.lastBatch = { cups: 0, success: false }; this.core.toast('Batch ruined.'); return; }
				const cups = L.baseCups + r.hits;
				this.core.give('lean_cup', cups);
				this.lastBatch = { cups: cups, success: true };
				this.core.toast('Made ' + cups + ' x Lean (cup).');
				this.core.save();
			},
		});
		void id;
		return true;
	}

	public lab(): any
	{
		const s = this.core.state.lab;
		if (s.packT === undefined) { s.packT = -1; s.packBonus = 0; s.perfect = 0; }
		return s;
	}

	private labItems(kind: string): PromptItem[]
	{
		const C = this.core.cfg.coke;
		const L = this.lab();
		if (kind === 'mix')
		{
			const have = this.core.count('lab_kit');
			return [{ key: 'E', label: have >= C.kitsPerBatch ? 'Start mixing (' + C.kitsPerBatch + ' Lab kit)' : 'Need a Lab kit (Sal sells them)' }];
		}
		if (kind === 'press') return this.core.count('batch_tray') > 0 ? [{ key: 'E', label: 'Press a Batch tray', hold: C.pressHold }] : [{ key: 'E', label: 'Needs a Batch tray from the mixing bench' }];
		if (L.packT >= 0) return [{ key: 'E', label: L.packT >= C.packSeconds ? 'Collect bricks' : 'Packaging... ' + Math.ceil(C.packSeconds - L.packT) + 's' }];
		return this.core.count('pressed_block') > 0 ? [{ key: 'E', label: 'Start packaging' }] : [{ key: 'E', label: 'Needs a Pressed block' }];
	}

	private labAct(kind: string): void
	{
		if (kind === 'mix') this.startMix();
		else if (kind === 'press') this.press();
		else
		{
			const L = this.lab();
			if (L.packT >= 0) this.collect(); else this.startPack();
		}
	}

	public startMix(): boolean
	{
		const C = this.core.cfg.coke;
		if (this.core.timing) return false;
		if (!this.core.take('lab_kit', C.kitsPerBatch)) { this.core.toast('You need a Lab kit.'); return false; }
		this.core.startTiming({
			owner: 'illegal', title: 'MIXING BENCH', stages: ['Station A', 'Station B', 'Station C'], zone: 0.2, speed: 0.6, maxMisses: 3, stageTimeout: 4, duration: C.mixSeconds,
			onFinish: (r) =>
			{
				if (!r.success) { this.core.toast('The batch failed.'); return; }
				this.core.give('batch_tray', 1);
				if (r.misses === 0) this.lab().perfect = (this.lab().perfect || 0) + 1;
				this.core.toast(r.misses === 0 ? 'Perfect batch tray.' : 'Batch tray ready. Take it to the press.');
				this.core.markDirty();
			},
		});
		return true;
	}

	public press(): boolean
	{
		if (!this.core.take('batch_tray', 1)) return false;
		this.core.give('pressed_block', 1);
		this.core.toast('Pressed block ready. Take it to packaging.');
		return true;
	}

	public startPack(): boolean
	{
		const L = this.lab();
		if (L.packT >= 0) return false;
		if (!this.core.take('pressed_block', 1)) return false;
		L.packT = 0;
		L.packBonus = L.perfect > 0 ? 1 : 0;
		if (L.perfect > 0) L.perfect--;
		this.core.markDirty();
		this.core.toast('Packaging started.');
		return true;
	}

	public collect(): number
	{
		const C = this.core.cfg.coke;
		const L = this.lab();
		if (L.packT < 0 || L.packT < C.packSeconds) return 0;
		const n = C.bricksPerBatch + (L.packBonus || 0);
		L.packT = -1; L.packBonus = 0;
		this.core.give('coke_brick', n);
		this.core.toast('Collected ' + n + ' x Coke (brick). Sell them at the port at night.');
		this.core.save();
		return n;
	}

	// ------------------------------------------------------------------ frame

	public update(dt: number): void
	{
		const L = this.lab();
		if (L.packT >= 0 && L.packT < this.core.cfg.coke.packSeconds) { L.packT += dt; this.core.markDirty(); }
		this.acc += dt;
		if (this.acc < 1) return;
		this.acc = 0;
		// the cartel buyer is only there at night
		for (let i = 0; i < this.contacts.length; i++)
		{
			const c = this.contacts[i];
			if (c.id !== 'cartel') continue;
			const on = this.present(c);
			c.figure.userData.hidden = !on;
			if (!on) c.figure.visible = false;
			c.marker.userData.hidden = !on;
			if (!on) c.marker.visible = false;
		}
	}
}
