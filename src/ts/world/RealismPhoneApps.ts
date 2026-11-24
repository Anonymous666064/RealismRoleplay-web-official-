/*
 * RealismPhoneApps.ts
 * -------------------
 * The phone's money and vehicle apps (opened from RealismPhone.ts):
 *
 *  Bank        San Verano Bank debit card (freeze / unfreeze), cash + bank balance, deposit /
 *              withdraw at an ATM (the bank or any 24/7 market, economy.atmAnywhere to allow it
 *              everywhere), transaction history with All / Income / Spending filters.
 *  Dealership  Verano Motors catalogue: the sedan in three trims and many paints, every car type
 *              from realism-config.js vehicles.types, and (dealership.aircraft) a helicopter and a
 *              plane. Buying pays with the card (economy.spend) and puts the car in your Garage
 *              (realismOwnedCars.add).
 *  Garage      every car you own (bought or stolen): colour, type, where it is, Spawn (puts it on
 *              the road next to you; again moves it), Locate (Map), Sell (dealership.sellBack of
 *              its price) and Forget.
 *  Jobs        Civilian / Police Officer / Sheriff Deputy and the trades (DOT Road Worker,
 *              Construction Worker, Electrician, Community Service): on / off duty, patrol or work
 *              vehicle, report to station / depot, the current task (GPS, skip), construction
 *              progress, community service hours and the Inventory (RealismJobs.ts,
 *              RealismJobsLegal.ts, RealismInventory.ts).
 *
 * Every system is looked up when used and guarded, so a missing one shows a message instead
 * of breaking the phone. Nothing here runs while the phone is closed.
 */

import { RealismCtx } from './RealismContext';
import { money } from './RealismEconomy';
import { RealismDayNight } from './RealismDayNight';
import { rrToast } from './RealismJobs';

export interface PhoneHost
{
	world: any;
	ctx: RealismCtx;
	isOpen: boolean;
	app: string;
	close(relock: boolean): void;
	locate(x: number, z: number, label: string): void;
}

interface Paint { name: string; rgb: number[]; }
export interface CatalogItem { id: string; type: string; name: string; trim: string; price: number; paints: Paint[]; desc: string; }

const BASIC: Paint[] = [
	{ name: 'White', rgb: [0.95, 0.95, 0.94] }, { name: 'Black', rgb: [0.13, 0.13, 0.14] }, { name: 'Silver', rgb: [0.62, 0.64, 0.66] },
	{ name: 'Red', rgb: [0.72, 0.09, 0.08] }, { name: 'Blue', rgb: [0.14, 0.25, 0.58] }, { name: 'Green', rgb: [0.16, 0.34, 0.22] },
	{ name: 'Beige', rgb: [0.78, 0.7, 0.54] },
];
const LUXE: Paint[] = [
	{ name: 'Pearl White', rgb: [0.97, 0.96, 0.92] }, { name: 'Midnight Blue', rgb: [0.06, 0.09, 0.25] }, { name: 'Graphite', rgb: [0.25, 0.26, 0.28] },
	{ name: 'Champagne', rgb: [0.8, 0.72, 0.55] }, { name: 'Burgundy', rgb: [0.4, 0.05, 0.1] },
];
const SPORT: Paint[] = [
	{ name: 'Racing Red', rgb: [0.85, 0.05, 0.04] }, { name: 'Lime', rgb: [0.45, 0.8, 0.1] }, { name: 'Sunburst', rgb: [0.95, 0.45, 0.05] },
	{ name: 'Electric Blue', rgb: [0.05, 0.35, 0.95] }, { name: 'Jet Black', rgb: [0.05, 0.05, 0.06] }, { name: 'Canary', rgb: [0.95, 0.82, 0.1] },
];

const DEALER = 'Verano Motors';

export function dealershipSettings(cfg: any): { prices: { [k: string]: number }; aircraft: boolean; exclude: string[]; sellBack: number }
{
	const raw: any = (cfg && cfg.dealership) || {};
	const prices: { [k: string]: number } = {};
	if (raw.prices && typeof raw.prices === 'object') for (const k in raw.prices) if (raw.prices.hasOwnProperty(k) && isFinite(raw.prices[k]) && raw.prices[k] >= 0) prices[k] = +raw.prices[k];
	const sb = isFinite(raw.sellBack) ? Math.max(0, Math.min(1, +raw.sellBack)) : 0.5;
	return { prices: prices, aircraft: raw.aircraft !== false, exclude: raw.exclude instanceof Array ? raw.exclude.map(String) : [], sellBack: sb };
}

function esc(s: any): string
{
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' } as any)[c]);
}

function rgbCss(rgb: number[]): string
{
	if (!rgb || rgb.length < 3) return '#888';
	return 'rgb(' + Math.round(rgb[0] * 255) + ',' + Math.round(rgb[1] * 255) + ',' + Math.round(rgb[2] * 255) + ')';
}

function title(s: string): string
{
	return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

const TYPE_LABEL: { [t: string]: string } = { car: 'Sedan', heli: 'Helicopter', airplane: 'Airplane', police: 'Police cruiser', sheriff: 'Sheriff cruiser' };

export class PhoneApps
{
	private host: PhoneHost;
	private views: { [id: string]: HTMLElement } = {};
	private msg: { [id: string]: { text: string; err: boolean } } = {};
	private txFilter = 'all';
	private dealSel: { [id: string]: number } = {};
	private dealConfirm: string = null;
	private garageConfirm: { id: string; act: string } = null;
	private garageSig = '';
	private amount = '';
	private hooked = false;

	constructor(host: PhoneHost)
	{
		this.host = host;
	}

	private get world(): any { return this.host.world; }
	private get eco(): any { return this.world.realismEconomy || null; }
	private get cars(): any { const c = this.world.realismOwnedCars; return c && typeof c.list === 'function' ? c : null; }
	private get jobs(): any { return this.world.realismJobs || null; }
	private get legal(): any { return this.world.realismJobsLegal || null; }
	private jobsTab = 'job';

	/** The container of an app (RealismPhone builds it). */
	public attach(id: string, el: HTMLElement): void
	{
		this.views[id] = el;
		el.addEventListener('click', (ev: Event) =>
		{
			let t: any = ev.target;
			while (t && t !== el && !(t.getAttribute && t.getAttribute('data-act'))) t = t.parentNode;
			if (!t || t === el || !t.getAttribute) return;
			ev.preventDefault();
			this.act(id, t.getAttribute('data-act'), t.getAttribute('data-arg') || '');
		});
		el.addEventListener('input', (ev: Event) =>
		{
			const t: any = ev.target;
			if (t && t.getAttribute && t.getAttribute('data-input') === 'amount') this.amount = String(t.value || '');
		});
	}

	/** Called when an app opens. */
	public open(id: string): void
	{
		this.hook();
		if (id === 'dealer') this.dealConfirm = null;
		if (id === 'garage') { this.garageConfirm = null; this.garageSig = ''; }
		this.render(id);
	}

	/** Called about 4 times a second while the phone shows `id`. */
	public tick(id: string, n: number): void
	{
		if (id === 'garage' && n % 4 === 0) this.renderGarage(false);
		else if (id === 'jobs' && n % 2 === 0) this.renderJobs(false);
		else if (id === 'bank' && n % 8 === 0) this.renderBankStatus();
	}

	private hook(): void
	{
		if (this.hooked) return;
		const eco = this.eco;
		if (eco && typeof eco.onChange === 'function')
		{
			this.hooked = true;
			eco.onChange(() => { if (this.host.isOpen && (this.host.app === 'bank' || this.host.app === 'dealer')) this.render(this.host.app); });
		}
		const cars = this.cars;
		if (cars && typeof cars.onChange === 'function') cars.onChange(() => { if (this.host.isOpen && this.host.app === 'garage') this.renderGarage(true); });
	}

	public render(id: string): void
	{
		try
		{
			if (id === 'bank') this.renderBank();
			else if (id === 'dealer') this.renderDealer();
			else if (id === 'garage') this.renderGarage(true);
			else if (id === 'jobs') this.renderJobs(true);
		}
		catch (e) { console.warn('[Realism] phone app ' + id + ' failed', e); }
	}

	private say(id: string, text: string, err?: boolean): void
	{
		this.msg[id] = { text: text, err: !!err };
	}

	private msgHtml(id: string): string
	{
		const m = this.msg[id];
		return '<div class="rr-pa-msg' + (m && m.err ? ' rr-err' : '') + '">' + (m ? esc(m.text) : '') + '</div>';
	}

	private playerSeat(): any
	{
		const im: any = this.world.inputManager;
		const r: any = im ? im.inputReceiver : null;
		const ch = r && r.characterCapsule !== undefined ? r : (r && r.controllingCharacter ? r.controllingCharacter : null);
		return ch;
	}

	private playerXZ(): { x: number; z: number } | null
	{
		const ch = this.playerSeat();
		if (ch)
		{
			const p = ch.occupyingSeat && ch.occupyingSeat.vehicle ? ch.occupyingSeat.vehicle.position : ch.position;
			return { x: p.x, z: p.z };
		}
		const cam = this.world.camera;
		return cam ? { x: cam.position.x, z: cam.position.z } : null;
	}

	// ------------------------------------------------------------------ actions

	private act(id: string, a: string, arg: string): void
	{
		const eco = this.eco, cars = this.cars, jobs = this.jobs;
		switch (a)
		{
			// bank
			case 'freeze':
				if (eco) { eco.setFrozen(!eco.card().frozen); this.say('bank', eco.card().frozen ? 'Card frozen. Card payments will be declined.' : 'Card unfrozen.'); }
				break;
			case 'filter': this.txFilter = arg; break;
			case 'amt':
				if (eco) this.amount = arg === 'all-bank' ? String(Math.floor(eco.getBank())) : arg === 'all-cash' ? String(Math.floor(eco.getCash())) : arg;
				break;
			case 'deposit':
			case 'withdraw':
			{
				if (!eco) break;
				const v = parseFloat(String(this.amount).replace(/[^0-9.]/g, ''));
				const ok = a === 'deposit' ? eco.deposit(v) : eco.withdraw(v);
				if (ok) { this.say('bank', (a === 'deposit' ? 'Deposited ' : 'Withdrew ') + money(v) + '.'); this.amount = ''; }
				else this.say('bank', eco.lastError || 'Failed', true);
				break;
			}
			case 'atm':
			{
				const impl: any = this.world.realismEconomyImpl;
				const near = impl && impl.nearestATM ? impl.nearestATM() : null;
				if (near) { this.host.locate(near.x, near.z, near.name); return; }
				break;
			}
			// dealer
			case 'paint': { const [item, idx] = arg.split(':'); this.dealSel[item] = parseInt(idx, 10) || 0; break; }
			case 'buy': this.dealConfirm = arg; this.say('dealer', ''); break;
			case 'buy-no': this.dealConfirm = null; break;
			case 'buy-yes': this.buy(arg); this.dealConfirm = null; break;
			// garage
			case 'spawn':
			{
				if (!cars) break;
				const car = cars.spawn(arg);
				if (car) { rrToast('Your car is on the road next to you.'); this.host.close(true); return; }
				this.say('garage', cars.lastError || 'Could not bring the car.', true);
				this.garageSig = '';
				break;
			}
			case 'locate':
			{
				const p = cars ? cars.locate(arg) : null;
				const rec = cars && cars.get ? cars.get(arg) : null;
				if (p) { this.host.locate(p.x, p.z, rec ? rec.name : 'Car'); return; }
				this.say('garage', 'That car is stored at Verano Motors. Spawn it first.', true);
				break;
			}
			case 'sell': case 'forget': this.garageConfirm = { id: arg, act: a }; break;
			case 'g-no': this.garageConfirm = null; break;
			case 'g-yes': this.garageYes(); break;
			// jobs
			case 'job': if (jobs) jobs.setJob(arg); break;
			case 'duty': if (jobs) { if (jobs.state.onDuty) jobs.goOffDuty(); else jobs.goOnDuty(); } break;
			case 'patrol':
				if (jobs) { const r = jobs.getPatrolVehicle(); this.say('jobs', r.message, !r.ok); }
				break;
			case 'station':
				if (jobs) { const r = jobs.reportToStation(); this.say('jobs', r.message, !r.ok); if (r.ok) { rrToast(r.message); this.host.close(true); return; } }
				break;
			case 'skip':
				if (this.legal) { const r = this.legal.skipTask(); this.say('jobs', r.message, !r.ok); }
				break;
			case 'jobtab': this.jobsTab = arg === 'inv' ? 'inv' : 'job'; break;
		}
		this.render(id);
	}

	// ------------------------------------------------------------------ Bank

	private renderBank(): void
	{
		const v = this.views.bank;
		if (!v) return;
		const eco = this.eco;
		if (!eco) { v.innerHTML = '<div class="rr-empty">Banking is unavailable.</div>'; return; }
		const c = eco.card();
		const masked = '&bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; &bull;&bull;&bull;&bull; ' + esc(c.last4);
		const all: any[] = eco.history();
		const list = all.filter((t) => this.txFilter === 'all' ? true : this.txFilter === 'in' ? t.amount > 0 && t.method !== 'transfer' : t.amount < 0 && t.method !== 'transfer');
		const max = 80;
		let tx = '';
		for (let i = 0; i < list.length && i < max; i++)
		{
			const t = list[i];
			const when = (t.gameDay ? 'Day ' + t.gameDay + ' ' : '') + (t.gameHour !== undefined ? RealismDayNight.format(t.gameHour) : '');
			const how = t.method === 'card' ? 'Card &bull;&bull;' + esc(c.last4) : t.method === 'cash' ? 'Cash' : t.method === 'transfer' ? 'ATM' : 'Bank';
			tx += '<div class="rr-tx"><div class="rr-tx-d"><div class="rr-tx-t">' + esc(t.description) + '</div><div class="rr-dim">' + esc(t.merchant) + ' &middot; ' + when + ' &middot; ' + how + '</div></div>' +
				'<div class="rr-tx-a ' + (t.amount >= 0 ? 'rr-pos' : 'rr-neg') + '">' + money(t.amount, true) + '<div class="rr-dim">' + (t.account === 'cash' ? 'cash ' : '') + money(t.balance) + '</div></div></div>';
		}
		if (!tx) tx = '<div class="rr-dim" style="padding:8px 2px">No transactions.</div>';
		else if (list.length > max) tx += '<div class="rr-dim" style="padding:6px 2px">Showing the latest ' + max + ' of ' + list.length + '.</div>';
		const tab = (k: string, n: string) => '<button class="rr-pa-btn' + (this.txFilter === k ? ' rr-on' : '') + '" data-act="filter" data-arg="' + k + '">' + n + '</button>';
		v.innerHTML = '<div class="rr-pa">' +
			'<div class="rr-bankcard' + (c.frozen ? ' rr-frozen' : '') + '">' +
				'<div class="rr-bankcard-bank">' + esc(c.bank) + '</div><div class="rr-bankcard-type">DEBIT</div>' +
				'<div class="rr-bankcard-chip"></div><div class="rr-bankcard-num">' + masked + '</div>' +
				'<div class="rr-bankcard-foot"><span>' + esc(c.name) + '</span><span>' + esc(c.expiry) + '</span></div>' +
				(c.frozen ? '<div class="rr-bankcard-ice">&#x2744;&#xFE0F; FROZEN</div>' : '') +
			'</div>' +
			'<div class="rr-pa-btns"><button class="rr-pa-btn' + (c.frozen ? ' rr-on' : '') + '" data-act="freeze">' + (c.frozen ? 'Unfreeze card' : 'Freeze card') + '</button></div>' +
			'<div class="rr-bal"><div><span class="rr-dim">Bank</span><b>' + money(eco.getBank()) + '</b></div><div><span class="rr-dim">Cash</span><b class="rr-pos">' + money(eco.getCash()) + '</b></div></div>' +
			'<h4>ATM</h4><div class="rr-bank-status"></div>' +
			'<input class="rr-pa-input" type="text" inputmode="decimal" placeholder="Amount ($)" data-input="amount" value="' + esc(this.amount) + '">' +
			'<div class="rr-pa-btns"><button class="rr-pa-btn" data-act="amt" data-arg="100">$100</button><button class="rr-pa-btn" data-act="amt" data-arg="500">$500</button>' +
				'<button class="rr-pa-btn" data-act="amt" data-arg="all-cash">All cash</button></div>' +
			'<div class="rr-pa-btns"><button class="rr-pa-btn rr-go" data-act="withdraw">Withdraw</button><button class="rr-pa-btn rr-go" data-act="deposit">Deposit</button></div>' +
			this.msgHtml('bank') +
			'<h4>Transactions</h4><div class="rr-pa-tabs">' + tab('all', 'All') + tab('in', 'Income') + tab('out', 'Spending') + '</div>' + tx +
			'</div>';
		this.renderBankStatus();
	}

	private renderBankStatus(): void
	{
		const v = this.views.bank;
		const st = v ? v.querySelector('.rr-bank-status') as HTMLElement : null;
		const impl: any = this.world.realismEconomyImpl;
		if (!st || !impl) return;
		const here = impl.atATM();
		if (here) { st.innerHTML = '<div class="rr-dim rr-pos">&#x2705; ' + esc(here) + '</div>'; return; }
		const n = impl.nearestATM();
		st.innerHTML = '<div class="rr-pa-row"><span class="rr-dim">Deposit / withdraw at an ATM.' + (n ? ' Nearest: ' + esc(n.name) + ', ' + Math.round(n.distance) + ' m' : '') + '</span>' +
			(n ? '<button class="rr-pa-btn" style="flex:0 0 auto" data-act="atm">Map</button>' : '') + '</div>';
	}

	// ------------------------------------------------------------------ Dealership

	public catalog(): CatalogItem[]
	{
		const cfg: any = this.host.ctx ? this.host.ctx.cfg : {};
		const ds = dealershipSettings(cfg);
		const P = (k: string, d: number) => ds.prices[k] !== undefined ? ds.prices[k] : d;
		const out: CatalogItem[] = [
			{ id: 'sedan', type: 'car', name: 'Verano Sedan', trim: 'Base', price: P('sedan', 18000), paints: BASIC, desc: 'Reliable four-door. Cheap to run.' },
			{ id: 'sedanLX', type: 'car', name: 'Verano Sedan LX', trim: 'LX', price: P('sedanLX', 24500), paints: LUXE, desc: 'Premium paint, leather, chrome.' },
			{ id: 'sedanSport', type: 'car', name: 'Verano Sedan Sport', trim: 'Sport', price: P('sedanSport', 32000), paints: SPORT, desc: 'Loud colours for the boulevard.' },
		];
		const types: any = this.world.realismVehicleTypes || {};
		for (const k in types)
		{
			if (!types.hasOwnProperty(k) || k === 'car' || k === 'heli' || k === 'airplane') continue;
			const vt = types[k];
			if (!vt || (vt.base || k) !== 'car') continue;
			if (ds.exclude.indexOf(k) >= 0) continue;
			if (/police|sheriff|cop|patrol/i.test(k) && ds.prices[k] === undefined) continue;   // department cars are not for sale
			out.push({ id: k, type: k, name: title(k), trim: '', price: P(k, 35000), paints: BASIC, desc: 'Your own model (vehicles.types.' + k + ').' });
		}
		if (ds.aircraft)
		{
			out.push({ id: 'heli', type: 'heli', name: 'Verano H-1 Helicopter', trim: '', price: P('heli', 450000), paints: BASIC.slice(0, 5), desc: 'Lands on any roof with room.' });
			out.push({ id: 'airplane', type: 'airplane', name: 'Verano Skyhawk', trim: '', price: P('airplane', 850000), paints: BASIC.slice(0, 5), desc: 'Needs a runway: San Verano International.' });
		}
		return out;
	}

	private renderDealer(): void
	{
		const v = this.views.dealer;
		if (!v) return;
		const eco = this.eco, cars = this.cars;
		const items = this.catalog();
		let html = '<div class="rr-pa"><div class="rr-pa-row"><b>' + DEALER + '</b><span class="rr-dim">' + (eco ? 'Bank ' + money(eco.getBank()) : '') + '</span></div>';
		if (!cars) html += '<div class="rr-pa-msg rr-err">Garage unavailable: cars can\'t be delivered right now.</div>';
		const conf = this.dealConfirm ? items.filter((i) => i.id === this.dealConfirm)[0] : null;
		if (conf)
		{
			const p = conf.paints[this.dealSel[conf.id] || 0] || conf.paints[0];
			const card = eco ? eco.card() : null;
			html += '<div class="rr-confirm"><div class="rr-deal-name"><span class="rr-sw" style="background:' + rgbCss(p.rgb) + '"></span> ' + esc(p.name + ' ' + conf.name) + '</div>' +
				'<div style="margin:6px 0">Pay <b class="rr-deal-price">' + money(conf.price) + '</b> with ' + (card ? (card.frozen ? 'cash (card frozen)' : 'card &bull;&bull;' + esc(card.last4)) : 'card') + '?</div>' +
				'<div class="rr-pa-btns"><button class="rr-pa-btn rr-go" data-act="buy-yes" data-arg="' + esc(conf.id) + '">Buy</button><button class="rr-pa-btn" data-act="buy-no">Cancel</button></div></div>';
		}
		html += this.msgHtml('dealer');
		for (const it of items)
		{
			const sel = Math.min(this.dealSel[it.id] || 0, it.paints.length - 1);
			let sw = '';
			for (let i = 0; i < it.paints.length; i++)
				sw += '<button class="rr-sw-btn' + (i === sel ? ' rr-sel' : '') + '" title="' + esc(it.paints[i].name) + '" style="background:' + rgbCss(it.paints[i].rgb) + '" data-act="paint" data-arg="' + esc(it.id) + ':' + i + '"></button>';
			const afford = eco ? eco.canAfford(it.price) : false;
			html += '<div class="rr-deal"><div class="rr-pa-row"><span class="rr-deal-name">' + esc(it.name) + '</span><span class="rr-deal-price">' + money(it.price) + '</span></div>' +
				'<div class="rr-dim">' + esc(it.desc) + '</div><div class="rr-deal-sw">' + sw + '</div>' +
				'<div class="rr-pa-row"><span class="rr-dim">' + esc(it.paints[sel].name) + '</span><button class="rr-pa-btn rr-go" style="flex:0 0 auto" data-act="buy" data-arg="' + esc(it.id) + '"' +
				(afford && cars ? '' : ' disabled') + '>' + (afford ? 'Buy' : 'Can\'t afford') + '</button></div></div>';
		}
		v.innerHTML = html + '</div>';
	}

	/** Buys a catalogue item with the selected paint. Returns the new record or null. */
	public buy(itemId: string, paintIndex?: number): any
	{
		const eco = this.eco, cars = this.cars;
		const it = this.catalog().filter((i) => i.id === itemId)[0];
		if (!it) return null;
		if (!eco) { this.say('dealer', 'Banking is unavailable.', true); return null; }
		if (!cars || typeof cars.add !== 'function') { this.say('dealer', 'Garage unavailable.', true); return null; }
		const p = it.paints[paintIndex !== undefined ? paintIndex : (this.dealSel[it.id] || 0)] || it.paints[0];
		const name = p.name + ' ' + it.name;
		if (!eco.spend(it.price, name, DEALER))
		{
			this.say('dealer', 'Payment declined: ' + (eco.lastError || 'not enough money') + '.', true);
			return null;
		}
		let rec: any = null;
		try { rec = cars.add({ type: it.type, rgb: p.rgb.slice(0), name: name, price: it.price, trim: it.trim }); }
		catch (e) { rec = null; }
		if (!rec)
		{
			eco.earn(it.price, 'Refund: ' + name, DEALER);
			this.say('dealer', 'Delivery failed, you were refunded.', true);
			return null;
		}
		this.say('dealer', 'Bought! Your ' + name + ' is waiting in the Garage app.');
		rrToast('Purchased ' + name + ' for ' + money(it.price) + '.');
		return rec;
	}

	// ------------------------------------------------------------------ Garage

	private renderGarage(force: boolean): void
	{
		const v = this.views.garage;
		if (!v) return;
		const raw = this.world.realismOwnedCars;
		const cars = this.cars;
		if (!cars) { this.legacyGarage(v, raw); return; }
		const list: any[] = cars.list();
		const pp = this.playerXZ();
		const current = typeof cars.current === 'function' ? cars.current() : null;
		const rows: string[] = [];
		const sigParts: string[] = [];
		for (const r of list)
		{
			const loc = r.stored ? null : cars.locate(r.id);
			const dist = loc && pp ? Math.round(Math.sqrt((loc.x - pp.x) * (loc.x - pp.x) + (loc.z - pp.z) * (loc.z - pp.z))) : -1;
			const inIt = current && current.id === r.id;
			const status = inIt ? 'You are driving it' : r.stored ? 'Stored at ' + DEALER : dist >= 0 ? (dist < 1000 ? dist + ' m away' : (dist / 1000).toFixed(1) + ' km away') : '';
			sigParts.push(r.id + status + r.name);
			const origin = r.origin === 'dealer' ? 'Bought' : /^h\d+/.test(r.origin) ? 'Stolen' : r.origin ? 'Claimed' : 'Owned';
			const type = TYPE_LABEL[r.type] || title(String(r.type || 'car'));
			let html = '<div class="rr-gcar"><div class="rr-pa-row"><span class="rr-car-name"><span class="rr-sw" style="background:' + rgbCss(r.rgb) + '"></span> ' + esc(r.name) + '</span></div>' +
				'<div class="rr-dim">' + esc(type) + (r.trim ? ' ' + esc(r.trim) : '') + ' &middot; ' + origin + ' &middot; ' + esc(status) + '</div>';
			const gc = this.garageConfirm;
			if (gc && gc.id === r.id)
			{
				const value = this.sellValue(r);
				html += '<div class="rr-confirm">' + (gc.act === 'sell' ? 'Sell it to ' + DEALER + ' for <b class="rr-deal-price">' + money(value) + '</b>?' : 'Forget this car? It will be gone for good.') +
					'<div class="rr-pa-btns"><button class="rr-pa-btn ' + (gc.act === 'sell' ? 'rr-go' : 'rr-bad') + '" data-act="g-yes">' + (gc.act === 'sell' ? 'Sell' : 'Forget') + '</button><button class="rr-pa-btn" data-act="g-no">Cancel</button></div></div>';
			}
			else
			{
				html += '<div class="rr-pa-btns"><button class="rr-pa-btn rr-go" data-act="spawn" data-arg="' + esc(r.id) + '"' + (inIt ? ' disabled' : '') + '>' + (r.stored ? 'Spawn' : 'Bring here') + '</button>' +
					'<button class="rr-pa-btn" data-act="locate" data-arg="' + esc(r.id) + '"' + (r.stored ? ' disabled' : '') + '>Locate</button>' +
					'<button class="rr-pa-btn" data-act="sell" data-arg="' + esc(r.id) + '"' + (inIt ? ' disabled' : '') + '>Sell</button>' +
					'<button class="rr-pa-btn" data-act="forget" data-arg="' + esc(r.id) + '"' + (inIt ? ' disabled' : '') + '>&#x2715;</button></div>';
			}
			rows.push(html + '</div>');
		}
		const sig = sigParts.join('|') + (this.garageConfirm ? this.garageConfirm.id + this.garageConfirm.act : '') + (this.msg.garage ? this.msg.garage.text : '');
		if (!force && sig === this.garageSig) return;
		this.garageSig = sig;
		const body = v.parentNode as HTMLElement;
		const scroll = body && typeof body.scrollTop === 'number' ? body.scrollTop : 0;
		v.innerHTML = '<div class="rr-pa">' + this.msgHtml('garage') +
			(rows.length ? rows.join('') : '<div class="rr-empty">No cars yet.<br>Buy one in the Dealership app, or steal one (F).</div>') + '</div>';
		if (body && scroll) body.scrollTop = scroll;
	}

	public sellValue(r: any): number
	{
		const ds = dealershipSettings(this.host.ctx ? this.host.ctx.cfg : {});
		let base = typeof r.price === 'number' ? r.price : 0;
		if (!base)
		{
			const it = this.catalog().filter((i) => i.type === r.type && (r.type !== 'car' || i.trim === (r.trim || 'Base')))[0];
			base = it ? it.price : 18000;
		}
		return Math.round(base * ds.sellBack);
	}

	private garageYes(): void
	{
		const gc = this.garageConfirm;
		this.garageConfirm = null;
		const cars = this.cars;
		if (!gc || !cars) return;
		const r = cars.get ? cars.get(gc.id) : cars.list().filter((x: any) => x.id === gc.id)[0];
		if (!r) return;
		const value = this.sellValue(r);
		if (!cars.forget(gc.id)) { this.say('garage', 'Step out of the car first.', true); return; }
		if (gc.act === 'sell')
		{
			const eco = this.eco;
			if (eco) eco.earn(value, 'Sold ' + r.name, DEALER, 'bank');
			this.say('garage', 'Sold ' + r.name + ' for ' + money(value) + '.');
		}
		else this.say('garage', r.name + ' forgotten.');
	}

	/** Old-style list (a plain array / object in world.realismOwnedCars). */
	private legacyGarage(v: HTMLElement, raw: any): void
	{
		let cars: any[] = [];
		if (raw instanceof Array) cars = raw;
		else if (raw && typeof raw === 'object') cars = Object.keys(raw).map((k) => raw[k]);
		if (cars.length === 0) { v.innerHTML = '<div class="rr-empty">No cars yet.<br>Cars you own will be listed here.</div>'; return; }
		let html = '';
		for (let i = 0; i < cars.length; i++)
		{
			const c = cars[i];
			const name = typeof c === 'string' ? c : (c && (c.name || c.label || c.model || c.type)) || 'Car ' + (i + 1);
			html += '<div class="rr-car"><div class="rr-car-name">' + esc(name) + '</div></div>';
		}
		v.innerHTML = html;
	}

	// ------------------------------------------------------------------ Jobs

	private jobsSig = '';

	/** Changes whenever something shown by the trades part of the Jobs app changes. */
	private legalSig(): string
	{
		const L = this.legal;
		if (!L) return '';
		const t = L.task;
		let sig = t ? t.id + '.' + t.phase + '.' + t.phases[t.phase >= t.phases.length ? 0 : t.phase].filter((q: any) => q.done).length : '-';
		if (L.site) sig += '|' + L.site.project + '.' + L.site.placed + '.' + L.site.stock;
		sig += '|' + L.serviceHours + '|' + !!L.workVehicle;
		const inv = this.world.realismInventory;
		if (inv && typeof inv.list === 'function') { const l = inv.list(); for (let i = 0; i < l.length; i++) sig += l[i].id + l[i].qty; }
		return sig + this.jobsTab;
	}

	private renderJobs(force: boolean): void
	{
		const v = this.views.jobs;
		if (!v) return;
		const jobs = this.jobs;
		if (!jobs) { v.innerHTML = '<div class="rr-empty">Jobs are unavailable.</div>'; return; }
		const st = jobs.state;
		const d = jobs.department();
		const sig = st.id + st.onDuty + st.unit + jobs.patrolAvailable() + !!jobs.patrol + (this.msg.jobs ? this.msg.jobs.text : '') + this.legalSig();
		if (!force && sig === this.jobsSig)
		{
			const pe = v.querySelector('.rr-pay') as HTMLElement;
			const pay = jobs.minutesToPay();
			if (pe) pe.textContent = st.onDuty && pay >= 0 ? ' \u00b7 next pay in ' + pay + ' min' : '';
			this.renderTaskDistance(v);
			return;
		}
		this.jobsSig = sig;
		const civil = !!(d && d.civil);
		const L = this.legal;
		const opt = (id: string, ic: string, name: string, sub: string) =>
			'<button class="rr-job' + (st.id === id ? ' rr-sel' : '') + '" data-act="job" data-arg="' + id + '"><span class="rr-job-ic">' + ic + '</span><span>' + name + '<small>' + sub + '</small></span></button>';
		const P = jobs.departments.police, S = jobs.departments.sheriff;
		let html = '<div class="rr-pa">';
		html += '<div class="rr-pa-tabs"><button class="rr-pa-btn' + (this.jobsTab === 'job' ? ' rr-on' : '') + '" data-act="jobtab" data-arg="job">Job</button>' +
			'<button class="rr-pa-btn' + (this.jobsTab === 'inv' ? ' rr-on' : '') + '" data-act="jobtab" data-arg="inv">Inventory</button></div>';
		if (this.jobsTab === 'inv') { v.innerHTML = html + this.inventoryHtml() + '</div>'; return; }
		html += '<div class="rr-badge' + (st.onDuty ? ' rr-duty' : '') + '">' + (d
			? '<b>' + esc(d.rank) + '</b> &middot; ' + esc(d.name) + '<br><span class="rr-dim">' + (st.onDuty ? '&#x1F7E2; On duty &middot; ' + (civil ? 'crew ' : 'unit ') + esc(st.unit) : '&#x26AA; Off duty') + '</span>'
			: '<b>Civilian</b><br><span class="rr-dim">No job. Pick one below.</span>') + '</div>';
		if (d)
		{
			const pay = jobs.minutesToPay();
			html += '<div class="rr-pa-btns"><button class="rr-pa-btn ' + (st.onDuty ? 'rr-bad' : 'rr-go') + '" data-act="duty">' + (st.onDuty ? 'Go off duty' : 'Go on duty') + '</button></div>';
			if (civil)
			{
				const perTask = d.id === 'community' ? 'Works off service hours, small pay once none are owed' : (d.salary > 0 ? money(d.salary) + ' per game hour + pay per task' : 'Pay per task');
				html += '<div class="rr-dim" style="margin-top:6px">' + perTask + '<span class="rr-pay">' + (st.onDuty && d.salary > 0 && pay >= 0 ? ' &middot; next pay in ' + pay + ' min' : '') + '</span></div>';
			}
			else html += '<div class="rr-dim" style="margin-top:6px">Salary ' + money(d.salary) + ' per game hour<span class="rr-pay">' + (st.onDuty && pay >= 0 ? ' &middot; next pay in ' + pay + ' min' : '') + '</span></div>';
			if (st.onDuty)
			{
				const avail = jobs.patrolAvailable();
				if (civil)
				{
					html += '<div class="rr-pa-btns"><button class="rr-pa-btn rr-go" data-act="patrol"' + (avail ? '' : ' disabled') + '>' + (avail ? (L && L.workVehicle ? 'New work vehicle' : 'Get work vehicle') : 'Work vehicle unavailable') + '</button></div>';
					html += this.taskHtml();
				}
				else html += '<div class="rr-pa-btns"><button class="rr-pa-btn rr-go" data-act="patrol"' + (avail ? '' : ' disabled') + '>' + (avail ? (jobs.patrol ? 'New patrol vehicle' : 'Get patrol vehicle') : 'Patrol vehicle unavailable') + '</button></div>';
			}
			html += '<div class="rr-pa-btns"><button class="rr-pa-btn" data-act="station">' + (civil ? (d.id === 'construction' ? 'Go to the site (GPS)' : 'Go to the depot (GPS)') : 'Report to station') + '</button></div>';
			if (civil) html += this.tradeInfoHtml(d.id);
		}
		html += this.msgHtml('jobs');
		html += '<h4>Emergency services</h4>' +
			opt('civilian', '&#x1F9D1;', 'Civilian', 'Free roam, no salary') +
			opt('police', '&#x1F46E;', P.title, P.name + ' &middot; ' + money(P.salary) + '/h') +
			opt('sheriff', '&#x2B50;', S.title, S.name + ' &middot; ' + money(S.salary) + '/h');
		let trades = '';
		for (const id of ['dot', 'construction', 'electrician', 'community'])
		{
			const T = jobs.departments[id];
			if (T) trades += opt(id, T.icon || '&#x1F6E0;', esc(T.title), esc(T.name) + ' &middot; ' + esc(T.desc || ''));
		}
		if (trades) html += '<h4>City &amp; trades</h4>' + trades;
		v.innerHTML = html + '</div>';
	}

	private taskHtml(): string
	{
		const L = this.legal;
		if (!L) return '';
		const t = L.task;
		if (!t) return '<div class="rr-confirm"><span class="rr-dim">&#x1F4DF; Waiting for the next call...</span></div>';
		const ph = t.phases[Math.min(t.phase, t.phases.length - 1)] || [];
		const left = ph.filter((q: any) => !q.done).length;
		const f = L.firstOpen();
		const pay = t.job === 'community' && L.serviceHours > 0 ? 'service hours' : money(t.pay);
		return '<div class="rr-confirm"><div><b>' + esc(t.title) + '</b></div><div class="rr-dim">' + esc(t.where || '') + ' &middot; ' + pay + '</div>' +
			(f ? '<div style="margin-top:4px">&#x27A1;&#xFE0F; ' + esc(f.label) + (ph.length > 1 ? ' (' + left + ' left)' : '') + ' <span class="rr-dim rr-task-dist"></span></div>' : '') +
			(t.phases.length > 1 ? '<div class="rr-dim">Step ' + (Math.min(t.phase, t.phases.length - 1) + 1) + ' of ' + t.phases.length + '</div>' : '') +
			'<div class="rr-pa-btns"><button class="rr-pa-btn" data-act="skip">Skip task</button></div></div>';
	}

	private renderTaskDistance(v: HTMLElement): void
	{
		const L = this.legal;
		const el = v.querySelector('.rr-task-dist') as HTMLElement;
		if (!L || !el) return;
		const f = L.firstOpen(), p = this.playerXZ();
		if (!f || !p) return;
		const d = Math.sqrt((f.x - p.x) * (f.x - p.x) + (f.z - p.z) * (f.z - p.z));
		el.textContent = d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km';
	}

	private tradeInfoHtml(id: string): string
	{
		const L = this.legal;
		if (!L) return '';
		if (id === 'construction')
		{
			const s = L.site;
			if (!s) return '';
			if (!s.lot) return '<h4>Construction</h4><div class="rr-dim">All projects are finished. Great work!</div>';
			const si = s.stageInfo();
			const pct = Math.round(si.placed / si.total * 100);
			return '<h4>Project #' + s.project + '</h4><div class="rr-dim">Stage ' + (si.stage + 1) + '/5: ' + esc(si.name) + ' (' + si.inStage + '/' + si.stageSize + ')</div>' +
				'<div style="background:#333;border-radius:4px;height:8px;margin:5px 0"><div style="background:#f2c230;height:8px;border-radius:4px;width:' + pct + '%"></div></div>' +
				'<div class="rr-dim">' + si.placed + ' of ' + si.total + ' pieces &middot; site materials: ' + s.stock + '</div>';
		}
		if (id === 'community')
			return '<h4>Community service</h4><div class="rr-dim">Hours owed: <b>' + L.serviceHours + '</b> &middot; worked: ' + (Math.round(L.serviceDone * 10) / 10) + ' h</div>';
		return '';
	}

	private inventoryHtml(): string
	{
		const inv = this.world.realismInventory;
		if (!inv || typeof inv.list !== 'function') return '<div class="rr-empty">Inventory unavailable.</div>';
		const list: any[] = inv.list();
		if (!list.length) return '<div class="rr-empty">Your bag is empty.<br>Trades hand out supplies when you go on duty.</div>';
		let h = '';
		for (let i = 0; i < list.length; i++)
		{
			const it = list[i];
			const def = typeof inv.def === 'function' ? inv.def(it.id) : null;
			h += '<div class="rr-pa-row" style="padding:5px 2px;border-bottom:1px solid rgba(255,255,255,0.08)"><span>' + (def && def.icon ? esc(def.icon) + ' ' : '') + esc(it.name) +
				(def && def.legal === false ? ' <small class="rr-neg">illegal</small>' : '') + '</span><b>&times;' + it.qty + '</b></div>';
		}
		return h;
	}
}
