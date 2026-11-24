/*
 * RealismEconomy.ts
 * -----------------
 * Money for San Verano County: a bank account, cash in your pocket, a San Verano Bank debit
 * card and a transaction history. Saved in the browser (localStorage 'realism.economy.v1').
 *
 * Contract C1, (world as any).realismEconomy:
 *    getBank(): number                    bank balance ($)
 *    getCash(): number                    cash in hand ($)
 *    canAfford(amount): boolean           true if the card (not frozen, enough in the bank) or the cash covers it
 *    spend(amount, description, merchant, method?): boolean
 *                                         method 'card' -> bank via card (fails when frozen / not enough),
 *                                         'cash' -> cash only, omitted -> card, falling back to cash.
 *                                         false (nothing changes) when it can't be paid; a payment is
 *                                         recorded in the history.
 *    earn(amount, description, source, to?: 'bank' | 'cash'): void      (default 'bank')
 *    onChange(cb): void                   called after every change
 *    history(): Tx[]                      copy, newest first (capped at economy.historyCap entries)
 * Extras (not part of C1): deposit(amount) / withdraw(amount) (cash <-> bank, need an ATM unless
 *    economy.atmAnywhere), atATM(): string | null, card(): CardInfo, setFrozen(on), reset(),
 *    lastError, save().
 *
 * Tx = { id, time (Date.now()), gameHour, gameDay, amount (signed: + in, - out), balance (that
 *        account after it), account ('bank' | 'cash'), description, merchant, method
 *        ('card' | 'cash' | 'bank' | 'transfer') }
 *
 * HUD: a small cash / bank readout in the top-right corner, shown for a few seconds whenever
 * the money changes (with the +/- amount). Styles are in src/css/modules/realismPhoneApps.css.
 */

import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
import { RealismJobs } from './RealismJobs';

export const ECONOMY_KEY = 'realism.economy.v1';

export interface Tx
{
	id: string;
	time: number;
	gameHour?: number;
	gameDay?: number;
	amount: number;
	balance: number;
	account: string;
	description: string;
	merchant: string;
	method: string;
}

export interface CardInfo
{
	number: string;      // full 16 digits (shown masked)
	last4: string;
	name: string;
	expiry: string;      // MM/YY
	bank: string;
	frozen: boolean;
}

export interface EconomySettings
{
	startBank: number;
	startCash: number;
	cardName: string;
	bankName: string;
	historyCap: number;
	atmAnywhere: boolean;
	atmRange: number;
	hudSeconds: number;
	showHud: boolean;
}

function num(v: any, d: number, lo: number, hi: number): number
{
	const n = typeof v === 'number' && isFinite(v) ? v : d;
	return Math.max(lo, Math.min(hi, n));
}

export function economySettings(cfg: any): EconomySettings
{
	const raw: any = (cfg && cfg.economy) || {};
	return {
		startBank: num(raw.startBank, 5000, 0, 1e9),
		startCash: num(raw.startCash, 500, 0, 1e9),
		cardName: typeof raw.cardName === 'string' && raw.cardName.trim() ? raw.cardName.trim().toUpperCase().slice(0, 22) : 'RILEY',
		bankName: typeof raw.bankName === 'string' && raw.bankName.trim() ? raw.bankName.trim().slice(0, 30) : 'San Verano Bank',
		historyCap: Math.round(num(raw.historyCap, 500, 20, 5000)),
		atmAnywhere: raw.atmAnywhere === true,
		atmRange: num(raw.atmRange, 25, 5, 200),
		hudSeconds: num(raw.hudSeconds, 4, 0, 60),
		showHud: raw.showHud !== false,
	};
}

export function money(v: number, sign?: boolean): string
{
	const neg = v < 0;
	const a = Math.abs(Math.round(v * 100) / 100);
	const whole = Math.floor(a);
	const cents = Math.round((a - whole) * 100);
	const s = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (cents ? '.' + (cents < 10 ? '0' : '') + cents : '');
	return (neg ? '-' : (sign ? '+' : '')) + '$' + s;
}

function round2(v: number): number { return Math.round(v * 100) / 100; }

export class RealismEconomy
{
	public updateOrder = 9;
	public settings: EconomySettings;
	public bank = 0;
	public cash = 0;
	public cardInfo: CardInfo;
	public txs: Tx[] = [];          // oldest first
	public gameDay = 1;
	public lastError = '';
	public api: any;
	private seq = 0;
	private ctx: RealismCtx;
	private world: any;
	private listeners: (() => void)[] = [];
	private lastHour = -1;
	private atms: { x: number; z: number; r: number; name: string }[] = [];
	private hud: HTMLElement = null;
	private hudCash: HTMLElement = null;
	private hudBank: HTMLElement = null;
	private hudDelta: HTMLElement = null;
	private hudUntil = 0;
	private hudAcc = 0;
	private tmp = new THREE.Vector3();

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		this.settings = economySettings(ctx.cfg);
		this.findATMs();
		if (!this.load()) this.fresh();
		this.api = this.makeApi();
		try
		{
			if (typeof window !== 'undefined' && (window as any).addEventListener) (window as any).addEventListener('beforeunload', () => this.save());
		}
		catch (e) { /* headless */ }
	}

	// ------------------------------------------------------------------ state

	private fresh(): void
	{
		this.bank = this.settings.startBank;
		this.cash = this.settings.startCash;
		this.txs = [];
		this.seq = 0;
		this.gameDay = 1;
		this.cardInfo = this.newCard();
		this.record(this.bank, 'bank', 'Opening balance', this.settings.bankName, 'bank');
		this.save();
	}

	private newCard(): CardInfo
	{
		let n = '4' + String(Math.floor(100 + Math.random() * 899));
		while (n.length < 15) n += String(Math.floor(Math.random() * 10));
		n += String(luhn(n));
		const d = new Date();
		const yy = (d.getFullYear() + 4) % 100, mm = d.getMonth() + 1;
		return { number: n, last4: n.slice(-4), name: this.settings.cardName, expiry: (mm < 10 ? '0' : '') + mm + '/' + (yy < 10 ? '0' : '') + yy, bank: this.settings.bankName, frozen: false };
	}

	private load(): boolean
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			if (!ls) return false;
			const raw = ls.getItem(ECONOMY_KEY);
			if (!raw) return false;
			const d = JSON.parse(raw);
			if (!d || d.v !== 1 || !isFinite(d.bank) || !isFinite(d.cash)) return false;
			this.bank = round2(+d.bank);
			this.cash = round2(Math.max(0, +d.cash));
			this.seq = Math.max(0, Math.floor(+d.seq || 0));
			this.gameDay = Math.max(1, Math.floor(+d.gameDay || 1));
			const c = d.card || {};
			const fresh = this.newCard();
			this.cardInfo = {
				number: /^\d{16}$/.test(c.number) ? c.number : fresh.number,
				last4: '', name: this.settings.cardName, expiry: typeof c.expiry === 'string' ? c.expiry : fresh.expiry,
				bank: this.settings.bankName, frozen: c.frozen === true,
			};
			this.cardInfo.last4 = this.cardInfo.number.slice(-4);
			const list: any[] = d.tx instanceof Array ? d.tx : [];
			this.txs = [];
			for (let i = 0; i < list.length; i++)
			{
				const t = list[i];
				if (!t || !isFinite(t.amount)) continue;
				this.txs.push({ id: String(t.id || ('t' + i)), time: +t.time || 0, gameHour: isFinite(t.gameHour) ? +t.gameHour : undefined, gameDay: isFinite(t.gameDay) ? +t.gameDay : undefined,
					amount: +t.amount, balance: +t.balance || 0, account: t.account === 'cash' ? 'cash' : 'bank', description: String(t.description || ''),
					merchant: String(t.merchant || ''), method: String(t.method || 'bank') });
			}
			if (this.txs.length > this.settings.historyCap) this.txs.splice(0, this.txs.length - this.settings.historyCap);
			return true;
		}
		catch (e) { console.warn('[Realism] Could not read the bank account, starting fresh', e); return false; }
	}

	public save(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			if (!ls) return;
			const c = this.cardInfo;
			ls.setItem(ECONOMY_KEY, JSON.stringify({ v: 1, bank: this.bank, cash: this.cash, seq: this.seq, gameDay: this.gameDay,
				card: { number: c.number, expiry: c.expiry, frozen: c.frozen }, tx: this.txs }));
		}
		catch (e) { /* storage full / private mode */ }
	}

	private record(amount: number, account: string, description: string, merchant: string, method: string): Tx
	{
		const t = this.world.realismTime;
		const tx: Tx = {
			id: 't' + (++this.seq).toString(36),
			time: Date.now(),
			gameHour: t && isFinite(t.hour) ? Math.round(t.hour * 100) / 100 : undefined,
			gameDay: this.gameDay,
			amount: round2(amount),
			balance: account === 'cash' ? this.cash : this.bank,
			account: account,
			description: String(description || '').slice(0, 80),
			merchant: String(merchant || '').slice(0, 40),
			method: method,
		};
		this.txs.push(tx);
		if (this.txs.length > this.settings.historyCap) this.txs.splice(0, this.txs.length - this.settings.historyCap);
		return tx;
	}

	private changed(delta: number): void
	{
		this.save();
		this.showHud(delta);
		for (let i = 0; i < this.listeners.length; i++) { try { this.listeners[i](); } catch (e) { /* ignore */ } }
	}

	// ------------------------------------------------------------------ money

	public canAfford(amount: number, method?: string): boolean
	{
		if (!(amount >= 0) || !isFinite(amount)) return false;
		const cardOk = !this.cardInfo.frozen && this.bank >= amount;
		const cashOk = this.cash >= amount;
		if (method === 'card') return cardOk;
		if (method === 'cash') return cashOk;
		return cardOk || cashOk;
	}

	public spend(amount: number, description: string, merchant: string, method?: string): boolean
	{
		this.lastError = '';
		amount = round2(+amount);
		if (!(amount > 0) || !isFinite(amount)) { this.lastError = 'Invalid amount'; return false; }
		let use = method === 'cash' ? 'cash' : 'card';
		if (use === 'card' && (this.cardInfo.frozen || this.bank < amount))
		{
			if (method === undefined && this.cash >= amount) use = 'cash';
			else
			{
				this.lastError = this.cardInfo.frozen ? 'Card is frozen' : 'Insufficient funds';
				this.flashDeclined(this.lastError);
				return false;
			}
		}
		if (use === 'cash')
		{
			if (this.cash < amount) { this.lastError = 'Not enough cash'; this.flashDeclined(this.lastError); return false; }
			this.cash = round2(this.cash - amount);
			this.record(-amount, 'cash', description, merchant, 'cash');
		}
		else
		{
			this.bank = round2(this.bank - amount);
			this.record(-amount, 'bank', description, merchant, 'card');
		}
		this.changed(-amount);
		return true;
	}

	public earn(amount: number, description: string, source: string, to?: string): void
	{
		amount = round2(+amount);
		if (!(amount > 0) || !isFinite(amount)) return;
		if (to === 'cash')
		{
			this.cash = round2(this.cash + amount);
			this.record(amount, 'cash', description, source, 'cash');
		}
		else
		{
			this.bank = round2(this.bank + amount);
			this.record(amount, 'bank', description, source, 'bank');
		}
		this.changed(amount);
	}

	/** Cash -> bank. */
	public deposit(amount: number): boolean { return this.transfer(amount, true); }
	/** Bank -> cash. */
	public withdraw(amount: number): boolean { return this.transfer(amount, false); }

	private transfer(amount: number, toBank: boolean): boolean
	{
		this.lastError = '';
		amount = round2(Math.floor(+amount * 100) / 100);
		if (!(amount > 0) || !isFinite(amount)) { this.lastError = 'Enter an amount'; return false; }
		const atm = this.atATM();
		if (!atm) { this.lastError = 'Go to an ATM: San Verano Bank or any 24/7 market'; return false; }
		if (toBank)
		{
			if (this.cash < amount) { this.lastError = 'Not enough cash'; return false; }
			this.cash = round2(this.cash - amount);
			this.bank = round2(this.bank + amount);
			this.record(amount, 'bank', 'Cash deposit', atm, 'transfer');
		}
		else
		{
			if (this.cardInfo.frozen) { this.lastError = 'Card is frozen'; return false; }
			if (this.bank < amount) { this.lastError = 'Insufficient funds'; return false; }
			this.bank = round2(this.bank - amount);
			this.cash = round2(this.cash + amount);
			this.record(-amount, 'bank', 'ATM withdrawal', atm, 'transfer');
		}
		this.changed(0);
		return true;
	}

	public setFrozen(on: boolean): void
	{
		if (this.cardInfo.frozen === !!on) return;
		this.cardInfo.frozen = !!on;
		this.changed(0);
	}

	/** Wipes the account back to the starting amounts (new card, empty history). */
	public reset(): void
	{
		this.fresh();
		this.changed(0);
	}

	// ------------------------------------------------------------------ ATMs

	private findATMs(): void
	{
		const b = this.ctx.data.buildings;
		for (let i = 0; i < b.length; i++)
		{
			const s = b[i].sub;
			if (s !== 'bank' && s !== 'market' && s !== 'convenience') continue;
			if (b[i].closed) continue;
			const name = s === 'bank' ? this.settings.bankName + ' ATM' : (b[i].label ? b[i].label + ' ATM' : 'Store ATM');
			this.atms.push({ x: b[i].x, z: b[i].z, r: Math.max(b[i].w, b[i].d) / 2, name: name });
		}
	}

	/** Name of the ATM the player is at (or 'Mobile banking' when atmAnywhere), else null. */
	public atATM(): string | null
	{
		if (this.settings.atmAnywhere) return 'Mobile banking';
		if (!this.playerPos(this.tmp)) return null;
		const p = this.tmp;
		for (let i = 0; i < this.atms.length; i++)
		{
			const a = this.atms[i];
			const r = a.r + this.settings.atmRange;
			if ((a.x - p.x) * (a.x - p.x) + (a.z - p.z) * (a.z - p.z) < r * r) return a.name;
		}
		return null;
	}

	/** The nearest ATM: { name, distance } (for the Bank app). */
	public nearestATM(): { name: string; distance: number; x: number; z: number } | null
	{
		if (!this.playerPos(this.tmp) || this.atms.length === 0) return null;
		const p = this.tmp;
		let best = -1, bd = 1e18;
		for (let i = 0; i < this.atms.length; i++)
		{
			const a = this.atms[i];
			const d = Math.sqrt((a.x - p.x) * (a.x - p.x) + (a.z - p.z) * (a.z - p.z)) - a.r;
			if (d < bd) { bd = d; best = i; }
		}
		const a = this.atms[best];
		return { name: a.name, distance: Math.max(0, bd), x: a.x, z: a.z };
	}

	private playerPos(out: THREE.Vector3): boolean
	{
		const ch = RealismJobs.playerCharacter(this.world);
		if (ch)
		{
			if (ch.occupyingSeat && ch.occupyingSeat.vehicle) out.copy(ch.occupyingSeat.vehicle.position);
			else out.copy(ch.position);
			return true;
		}
		const cam = this.world.camera;
		if (cam) { out.copy(cam.position); return true; }
		return false;
	}

	// ------------------------------------------------------------------ per frame (cheap)

	public update(timeStep: number, unscaled: number): void
	{
		const t = this.world.realismTime;
		if (t && isFinite(t.hour))
		{
			if (this.lastHour >= 0 && t.hour < this.lastHour - 12) { this.gameDay++; }
			this.lastHour = t.hour;
		}
		if (this.hudUntil > 0)
		{
			this.hudAcc += unscaled || 0;
			if (this.hudAcc > 0.25)
			{
				this.hudAcc = 0;
				if (Date.now() > this.hudUntil) { this.hudUntil = 0; if (this.hud) this.hud.classList.remove('rr-money-show'); }
			}
		}
	}

	// ------------------------------------------------------------------ HUD

	private ensureHud(): boolean
	{
		if (this.hud) return true;
		try
		{
			if (typeof document === 'undefined' || !document.body || !document.createElement) return false;
			const h = document.createElement('div');
			h.id = 'rr-money';
			h.innerHTML = '<div class="rr-money-row"><span class="rr-money-cash"></span></div><div class="rr-money-row rr-money-bankrow">&#x1F3E6; <span class="rr-money-bank"></span></div><div class="rr-money-delta"></div>';
			document.body.appendChild(h);
			this.hud = h;
			this.hudCash = h.querySelector('.rr-money-cash') as HTMLElement;
			this.hudBank = h.querySelector('.rr-money-bank') as HTMLElement;
			this.hudDelta = h.querySelector('.rr-money-delta') as HTMLElement;
			return true;
		}
		catch (e) { return false; }
	}

	/** Shows the cash / bank readout for a few seconds (delta 0: no +/- line). */
	public showHud(delta: number, seconds?: number): void
	{
		if (!this.settings.showHud || !this.ensureHud()) return;
		if (this.hudCash) this.hudCash.textContent = money(this.cash);
		if (this.hudBank) this.hudBank.textContent = money(this.bank);
		if (this.hudDelta)
		{
			this.hudDelta.textContent = delta ? money(delta, true) : '';
			this.hudDelta.className = 'rr-money-delta ' + (delta > 0 ? 'rr-pos' : delta < 0 ? 'rr-neg' : '');
		}
		this.hud.classList.add('rr-money-show');
		this.hudUntil = Date.now() + 1000 * (seconds !== undefined ? seconds : this.settings.hudSeconds);
	}

	private flashDeclined(reason: string): void
	{
		if (!this.settings.showHud || !this.ensureHud()) return;
		this.showHud(0);
		if (this.hudDelta) { this.hudDelta.textContent = 'Declined: ' + reason; this.hudDelta.className = 'rr-money-delta rr-neg'; }
	}

	// ------------------------------------------------------------------ API

	public history(): Tx[]
	{
		const out: Tx[] = [];
		for (let i = this.txs.length - 1; i >= 0; i--) out.push(Object.assign({}, this.txs[i]));
		return out;
	}

	public onChange(cb: () => void): void { if (typeof cb === 'function') this.listeners.push(cb); }

	private makeApi(): any
	{
		const self = this;
		return {
			getBank(): number { return self.bank; },
			getCash(): number { return self.cash; },
			canAfford(amount: number, method?: string): boolean { return self.canAfford(amount, method); },
			spend(amount: number, description: string, merchant: string, method?: 'card' | 'cash'): boolean { return self.spend(amount, description, merchant, method); },
			earn(amount: number, description: string, source: string, to?: 'bank' | 'cash'): void { self.earn(amount, description, source, to); },
			onChange(cb: () => void): void { self.onChange(cb); },
			history(): Tx[] { return self.history(); },
			// extras
			deposit(amount: number): boolean { return self.deposit(amount); },
			withdraw(amount: number): boolean { return self.withdraw(amount); },
			atATM(): string | null { return self.atATM(); },
			card(): CardInfo { return Object.assign({}, self.cardInfo); },
			setFrozen(on: boolean): void { self.setFrozen(on); },
			get lastError(): string { return self.lastError; },
			get gameDay(): number { return self.gameDay; },
			save(): void { self.save(); },
			reset(): void { self.reset(); },
		};
	}
}

function luhn(partial: string): number
{
	let sum = 0;
	for (let i = 0; i < partial.length; i++)
	{
		let d = parseInt(partial.charAt(partial.length - 1 - i), 10);
		if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
		sum += d;
	}
	return (10 - sum % 10) % 10;
}

/** RealismWorldBuilder hook: money, bank card, jobs. Safe to call once; never throws. */
export function buildEconomy(ctx: RealismCtx): void
{
	const w: any = ctx.world;
	try
	{
		const eco = new RealismEconomy(ctx);
		w.registerUpdatable(eco);
		w.realismEconomy = eco.api;
		w.realismEconomyImpl = eco;
	}
	catch (e) { console.warn('[Realism] Economy failed to build', e); }
	try
	{
		const jobs = new RealismJobs(ctx);
		w.registerUpdatable(jobs);
		w.realismJobs = jobs;
	}
	catch (e) { console.warn('[Realism] Jobs failed to build', e); }
}
