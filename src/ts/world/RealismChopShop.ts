/*
 * RealismChopShop.ts
 * ------------------
 * The stolen-car chain (game mechanics only):
 *
 *  1. Steal + hotwire (RealismHotwire.ts, C12). Stolen owned records carry stolen: true, vin (17 chars),
 *     vinScratched: false, hot: true (A13 sets them; we also keep them in our own save so they survive
 *     reloads, and fill them in for stolen cars that arrive without them).
 *  2. BACK ALLEY SPRAY: a painted bay beside the port warehouse closest to the Harbor Row hood. Drive in,
 *     stop: "[E] Respray". Pick a colour (mouse or 1-9), pay illegal.respray.price in cash. The car is
 *     repainted through realismVehicleTuning.paint(car, rgb) and the owned record updated (rgb, hot: false).
 *  3. VIN station: the bay next to it. Drive in, hold E (illegal.vin.holdSeconds) to scratch the VIN:
 *     realismOwnedCars.update(id, { vinScratched: true }).
 *  4. FENCE: a contact by a port warehouse near the water, with a GTA-style marker. Drive a stolen car into
 *     the marker: "[E] Sell for $X". Price = dealer value x fence.share x condition, x vinBonus if the VIN is
 *     scratched (else x noVinFactor); hot (not resprayed) cars are refused (fence.hotPolicy 'refuse') or
 *     paid x hotFactor ('lowball', default). Police / sheriff cars and legit cars are refused. Selling
 *     gets you out, removes the car (realismOwnedCars.forget(id)) and pays cash (realismEconomy.earn(...,
 *     'cash')), plus a 'crime' event and heat.
 *
 * API (world as any).realismIllegal.chop = { spray, vin, fence (sites), quote(car), respray(car, rgb),
 *   scratchVin(car), sell(car) }
 */

import * as THREE from 'three';
import { IllegalCore, besideBuilding, reserve, bayDecal, inRect, textPlane, money, makeVin, isStolenOrigin, Site, NearSet, PromptItem } from './RealismIllegalCore';
import { DEFAULT_PALETTE } from './RealismModShop';

const SPRAY_W = 5.2, SPRAY_D = 8;
const FENCE_R = 3.4;

export class ChopShop
{
	public api: any;
	public spray: Site = null;
	public vin: Site = null;
	public fence: Site = null;
	public fenceStand: { x: number; y: number; z: number } = null;
	public palette: { name: string; rgb: number[] }[];
	public pendingSale: { id: string; price: number; car: any; t: number } = null;
	public sold: { id: string; price: number }[] = [];
	private core: IllegalCore;
	private near = new NearSet();
	private nearAcc = 1;
	private watchAcc = 0;
	private eventsHooked = false;
	private tmp = new THREE.Vector3();

	constructor(core: IllegalCore)
	{
		this.core = core;
		const pc = core.cfg.respray.colors;
		this.palette = pc instanceof Array && pc.length ? pc.map((p: any, i: number) => p instanceof Array ? { name: 'Colour ' + (i + 1), rgb: p } : p) : DEFAULT_PALETTE.slice(0, 9);
		this.place();
		this.build();
		this.hookCars();
		core.addUpdater(this);
		const self = this;
		this.api = {
			get spray(): Site { return self.spray; },
			get vin(): Site { return self.vin; },
			get fence(): Site { return self.fence; },
			quote(car: any): any { return self.quote(car); },
			respray(car: any, rgb: number[]): boolean { return self.respray(car, rgb); },
			scratchVin(car: any): boolean { return self.scratchVin(car); },
			sell(car: any): boolean { return self.sell(car); },
			get pendingSale(): any { return self.pendingSale; },
			get sold(): any[] { return self.sold; },
			meta(car: any): any { return self.core.carMeta(self.core.recordFor(car)); },
		};
	}

	// ------------------------------------------------------------------ placement

	private place(): void
	{
		const ctx = this.core.ctx;
		const bs: any[] = ctx.data.buildings;
		const hoods: any[] = ctx.data.hoods || [];
		const hood = hoods.filter((h) => /harbor/i.test(h.name))[0] || hoods[hoods.length - 1] || { x0: 478, x1: 862, z0: 250, z1: 445 };
		const hx = (hood.x0 + hood.x1) / 2, hz = (hood.z0 + hood.z1) / 2;
		const wh: number[] = [];
		for (let i = 0; i < bs.length; i++) if (bs[i].kind === 'warehouse' && bs[i].sub !== 'hangar' && !bs[i].custom) wh.push(i);
		const rectDist = (b: any) => { const dx = Math.max(hood.x0 - b.x, 0, b.x - hood.x1), dz = Math.max(hood.z0 - b.z, 0, b.z - hood.z1); return Math.sqrt(dx * dx + dz * dz); };
		wh.sort((a, b) => rectDist(bs[a]) - rectDist(bs[b]));
		// spray + VIN bays side by side at the warehouse closest to the hood
		for (let k = 0; k < wh.length && !this.spray; k++)
		{
			const s = besideBuilding(ctx, wh[k], SPRAY_W, SPRAY_D, { road: 'near' });
			if (!s) continue;
			reserve(s.x, s.z, 5, 'spray');
			const v = besideBuilding(ctx, wh[k], SPRAY_W, SPRAY_D, { road: 'near', faces: [s.face] }) || besideBuilding(ctx, wh[k], SPRAY_W, SPRAY_D, { road: 'near' });
			if (!v) { continue; }
			reserve(v.x, v.z, 5, 'vin');
			this.spray = s; this.vin = v;
		}
		// fence: the warehouse furthest from the hood (by the water)
		for (let k = wh.length - 1; k >= 0 && !this.fence; k--)
		{
			const f = besideBuilding(ctx, wh[k], 7, 7, { road: 'near' });
			if (!f) continue;
			reserve(f.x, f.z, 5, 'fence');
			this.fence = f;
		}
		if (!this.spray) console.warn('[Realism] Illegal: no spot for Back Alley Spray');
		if (!this.fence) console.warn('[Realism] Illegal: no spot for the fence');
		void hx; void hz;
	}

	private build(): void
	{
		const core = this.core;
		const ctx = core.ctx;
		const shadows = !!ctx.preset.shadows;
		if (this.spray)
		{
			const s = this.spray;
			const a = bayDecal(core, s.x, s.z, s.rot, SPRAY_W, SPRAY_D, 'BACK ALLEY SPRAY', 'STOP HERE  [E]', '#ff4fa8');
			this.near.add(a, s.x, s.z, 220);
			const sign = textPlane('BACK ALLEY SPRAY', 3.4, '#ff4fa8', '#120814', true);
			// on the warehouse wall behind the bay
			const back = SPRAY_D / 2 + 0.55;
			sign.position.set(s.x - Math.sin(s.rot) * back, s.y + 4.2, s.z - Math.cos(s.rot) * back);
			sign.rotation.y = s.rot;
			core.w.graphicsWorld.add(sign);
			this.near.add(sign, s.x, s.z, 260);
			core.addBlip('ill_spray', { x: s.x, z: s.z, icon: 'modshop', color: '#ff4fa8', label: 'Back Alley Spray' });
			core.add({ id: 'spray', x: s.x, y: s.y, z: s.z, r: 6, mode: 'car', blip: 'ill_spray', items: () => this.sprayItems(), act: (k) => this.sprayAct(k) });
		}
		if (this.vin)
		{
			const v = this.vin;
			const a = bayDecal(core, v.x, v.z, v.rot, SPRAY_W, SPRAY_D, 'VIN', 'HOLD [E]', '#ffcc33');
			this.near.add(a, v.x, v.z, 220);
			core.add({ id: 'vin', x: v.x, y: v.y, z: v.z, r: 6, mode: 'car', blip: 'ill_spray', items: () => this.vinItems(), act: (k) => this.vinAct(k) });
		}
		if (this.fence)
		{
			const f = this.fence;
			const m = core.marker(f.x, f.y, f.z, '#33d17a', { radius: FENCE_R, range: 160 });
			void m;
			// the fence stands beside the marker, towards the wall
			const sx = f.x - Math.sin(f.rot) * 3.2 + Math.cos(f.rot) * 2.6, sz = f.z - Math.cos(f.rot) * 3.2 - Math.sin(f.rot) * 2.6;
			this.fenceStand = { x: sx, y: ctx.data.heightAt(sx, sz), z: sz };
			core.figure(sx, this.fenceStand.y, sz, f.rot, [0.2, 0.22, 0.2]);
			core.addBlip('ill_fence', { x: f.x, z: f.z, icon: 'fence', color: '#33d17a', label: 'Fence (stolen cars)' });
			core.add({ id: 'fence', x: f.x, y: f.y, z: f.z, r: FENCE_R + 1.2, mode: 'car', blip: 'ill_fence', items: () => this.fenceItems(), act: (k) => this.fenceAct(k) });
			core.add({ id: 'fenceTalk', x: sx, y: this.fenceStand.y, z: sz, r: 2.5, mode: 'foot', blip: 'ill_fence',
				items: () => [{ key: 'E', label: 'Talk to the fence' }],
				act: () => core.toast('"Bring me a car with a fresh coat and no VIN. Hot cars get lowballed."', 5) });
		}
		void shadows;
	}

	// ------------------------------------------------------------------ stolen-car meta

	private hookCars(): void
	{
		const oc = (this.core.w as any).realismOwnedCars;
		if (oc && typeof oc.onChange === 'function') oc.onChange(() => this.syncMeta());
		this.syncMeta();
	}

	private syncMeta(): void
	{
		const oc = (this.core.w as any).realismOwnedCars;
		if (!oc || !oc.cars) return;
		let changed = false;
		for (let i = 0; i < oc.cars.length; i++)
		{
			const r = oc.cars[i];
			if (this.core.state.cars[r.id]) continue;
			if (!isStolenOrigin(r) && r.stolen !== true) continue;
			const m = this.core.carMeta(r);
			this.core.state.cars[r.id] = m;
			changed = true;
			// fill in what the record misses (merge + save in the owned-car store)
			const patch: any = {};
			if (r.stolen !== true) patch.stolen = true;
			if (!r.vin) patch.vin = m.vin || makeVin(r.id);
			if (r.vinScratched === undefined) patch.vinScratched = !!m.vinScratched;
			if (r.hot === undefined) patch.hot = m.hot !== false;
			if (Object.keys(patch).length) { try { oc.update(r.id, patch); } catch (e) { /* ignore */ } }
		}
		this.core.pruneCars();
		if (changed) this.core.markDirty();
	}

	private hookEvents(): void
	{
		const ev = (this.core.w as any).realismEvents;
		if (this.eventsHooked || !ev || typeof ev.on !== 'function') return;
		this.eventsHooked = true;
		try { ev.on('carStolen', () => this.syncMeta()); } catch (e) { /* ignore */ }
	}

	// ------------------------------------------------------------------ spray

	private carIn(site: Site): any
	{
		const car = this.core.drivenCar();
		if (!car || !site) return null;
		const p = car.position;
		if (!inRect(p.x, p.z, site.x, site.z, site.rot, SPRAY_W, SPRAY_D) || Math.abs(p.y - site.y) > 4) return null;
		return car;
	}

	private sprayItems(): PromptItem[] | null
	{
		const car = this.carIn(this.spray);
		if (!car) return null;
		if (Math.abs(car.speed || 0) > 3) return [{ key: 'E', label: 'Stop to respray' }];
		return [{ key: 'E', label: 'Respray ' + money(this.core.cfg.respray.price) + ' cash' }];
	}

	private sprayAct(k: string): void
	{
		if (k !== 'E') return;
		const car = this.carIn(this.spray);
		if (!car || Math.abs(car.speed || 0) > 3) return;
		const price = this.core.cfg.respray.price;
		const rec = this.core.recordFor(car);
		const m = this.core.carMeta(rec);
		this.core.menu({
			title: 'BACK ALLEY SPRAY',
			subtitle: (rec ? rec.name + (m.stolen ? (m.hot ? '  -  HOT' : '  -  resprayed') : '') : 'This car') + '   |   ' + money(price) + ' cash, no questions asked',
			rows: () => this.palette.map((p) => ({ label: p.name, right: money(price), action: () => { if (this.respray(car, p.rgb)) this.core.closeMenu(); } })),
		});
	}

	/** Repaints a car, updates its owned record (rgb, hot: false). Charges cash. */
	public respray(car: any, rgb: number[]): boolean
	{
		if (!car || !(rgb instanceof Array)) return false;
		const price = this.core.cfg.respray.price;
		if (!this.core.payCash(price, 'Respray', 'Back Alley Spray')) { this.core.toast('Not enough cash (' + money(price) + ').'); return false; }
		const w: any = this.core.w;
		const T = w.realismVehicleTuning;
		const c = [Math.max(0, Math.min(1, +rgb[0] || 0)), Math.max(0, Math.min(1, +rgb[1] || 0)), Math.max(0, Math.min(1, +rgb[2] || 0))];
		try
		{
			if (T && typeof T.paint === 'function') T.paint(car, c);
			else if (T && typeof T.apply === 'function') T.apply(car, { rgb: c });
		}
		catch (e) { /* ignore */ }
		if (car.realismTuned) car.realismTunedRgb = c.slice(0);     // the tuning sync keeps the new paint
		const rec = this.core.recordFor(car);
		if (rec)
		{
			const patch: any = { rgb: c, hot: false, resprayed: true };
			if (rec.tuning && typeof rec.tuning === 'object') patch.tuning = Object.assign({}, rec.tuning, { rgb: c });
			const m = this.core.carMeta(rec);
			this.core.setCarMeta(rec, m.stolen ? { hot: false, resprayed: true } : { resprayed: true });
			const oc = w.realismOwnedCars;
			try { if (oc && oc.update) oc.update(rec.id, patch); } catch (e) { /* ignore */ }
		}
		this.core.toast(rec && this.core.carMeta(rec).stolen ? 'Fresh paint. The car is no longer hot.' : 'Fresh paint.');
		return true;
	}

	// ------------------------------------------------------------------ VIN

	private vinItems(): PromptItem[] | null
	{
		const car = this.carIn(this.vin);
		if (!car) return null;
		const rec = this.core.recordFor(car);
		const m = this.core.carMeta(rec);
		if (!rec || !m.stolen) return [{ key: 'E', label: 'Nothing to hide on this car' }];
		if (m.vinScratched) return [{ key: 'E', label: 'VIN already scratched' }];
		if (Math.abs(car.speed || 0) > 2) return [{ key: 'E', label: 'Stop to scratch the VIN' }];
		return [{ key: 'E', label: 'Scratch VIN', hold: this.core.cfg.vin.holdSeconds }];
	}

	private vinAct(k: string): void
	{
		if (k !== 'E') return;
		const car = this.carIn(this.vin);
		if (!car || Math.abs(car.speed || 0) > 2) return;
		const rec = this.core.recordFor(car);
		const m = this.core.carMeta(rec);
		if (!rec || !m.stolen || m.vinScratched) return;
		this.scratchVin(car);
	}

	public scratchVin(car: any): boolean
	{
		const rec = this.core.recordFor(car);
		if (!rec) return false;
		const m = this.core.carMeta(rec);
		if (!m.stolen) return false;
		this.core.setCarMeta(rec, { vinScratched: true, vin: m.vin || makeVin(rec.id) });
		this.core.toast('VIN scratched off.');
		return true;
	}

	// ------------------------------------------------------------------ fence

	/** What the fence pays for a car, or why he won't take it. */
	public quote(car: any): { ok: boolean; price: number; reason: string; base?: number; factors?: any }
	{
		if (!car) return { ok: false, price: 0, reason: 'No car' };
		const F = this.core.cfg.fence;
		const rec = this.core.recordFor(car);
		const type = this.core.carType(car);
		if (car.realismDeptVehicle || ((type === 'police' || type === 'sheriff') && F.refusePolice)) return { ok: false, price: 0, reason: 'No cop cars. Too hot.' };
		if (!rec) return { ok: false, price: 0, reason: 'Not yours to sell.' };
		const m = this.core.carMeta(rec);
		if (!m.stolen) return { ok: false, price: 0, reason: 'That car is legit. Sell it at the dealership.' };
		const cond = this.condition(car, rec);
		if (cond < F.minCondition) return { ok: false, price: 0, reason: 'That wreck is worth nothing to me.' };
		const base = this.core.typeValue(type) * F.share;
		const hot = m.hot !== false;
		if (hot && F.hotPolicy === 'refuse') return { ok: false, price: 0, reason: 'It\'s hot. Respray it first.' };
		const fHot = hot ? F.hotFactor : 1;
		const fVin = m.vinScratched ? F.vinBonus : F.noVinFactor;
		const fCond = 0.4 + 0.6 * cond;
		const price = Math.max(50, Math.round(base * fHot * fVin * fCond / 10) * 10);
		return { ok: true, price: price, reason: hot ? 'It\'s hot. Best I can do.' : m.vinScratched ? 'Clean work.' : 'No VIN work? I\'ll pay less.', base: base, factors: { hot: fHot, vin: fVin, condition: fCond } };
	}

	private condition(car: any, rec: any): number
	{
		const v = rec && typeof rec.condition === 'number' ? rec.condition : typeof car.realismCondition === 'number' ? car.realismCondition : typeof car.health === 'number' ? car.health / 100 : 1;
		return Math.max(0, Math.min(1, v));
	}

	private carInFence(): any
	{
		const car = this.core.drivenCar();
		const f = this.fence;
		if (!car || !f) return null;
		const dx = car.position.x - f.x, dz = car.position.z - f.z;
		return dx * dx + dz * dz < (FENCE_R + 1.2) * (FENCE_R + 1.2) ? car : null;
	}

	private fenceItems(): PromptItem[] | null
	{
		if (this.pendingSale) return null;
		const car = this.carInFence();
		if (!car) return null;
		const q = this.quote(car);
		if (!q.ok) return [{ key: 'E', label: q.reason }];
		if (Math.abs(car.speed || 0) > 2) return [{ key: 'E', label: 'Stop the car' }];
		return [{ key: 'E', label: 'Sell for ' + money(q.price) }];
	}

	private fenceAct(k: string): void
	{
		if (k !== 'E') return;
		const car = this.carInFence();
		if (!car || Math.abs(car.speed || 0) > 2) return;
		const q = this.quote(car);
		if (!q.ok) { this.core.toast(q.reason); return; }
		this.sell(car);
	}

	/** Gets the player out, then removes the car and pays cash. */
	public sell(car: any): boolean
	{
		const q = this.quote(car);
		if (!q.ok || this.pendingSale) return false;
		const rec = this.core.recordFor(car);
		this.pendingSale = { id: rec.id, price: q.price, car: car, t: 0 };
		const ch = this.core.player();
		try { if (ch && ch.occupyingSeat && ch.occupyingSeat.vehicle === car) ch.exitVehicle(); } catch (e) { /* ignore */ }
		this.tryFinishSale();
		return true;
	}

	private tryFinishSale(): void
	{
		const s = this.pendingSale;
		if (!s) return;
		const car = s.car;
		const busy = car && (car.controllingCharacter || (car.seats && car.seats.some((seat: any) => !!seat.occupiedBy)));
		if (busy && s.t < 6) return;
		const oc = (this.core.w as any).realismOwnedCars;
		let ok = false;
		try { ok = oc && oc.forget ? oc.forget(s.id) !== false : false; } catch (e) { ok = false; }
		this.pendingSale = null;
		if (!ok) { this.core.toast('The fence can\'t take it right now.'); return; }
		delete this.core.state.cars[s.id];
		this.core.earnCash(s.price, 'Sold a car to the fence', 'Fence');
		this.sold.push({ id: s.id, price: s.price });
		this.core.crime('carSale', car ? car.position : null, this.core.cfg.heat.carSale);
		this.core.toast('Sold for ' + money(s.price) + ' cash.');
		this.core.save();
	}

	// ------------------------------------------------------------------ frame

	public update(dt: number): void
	{
		if (this.pendingSale) { this.pendingSale.t += dt; this.tryFinishSale(); }
		this.nearAcc += dt;
		if (this.nearAcc > 0.5) { this.nearAcc = 0; if (this.core.playerPos(this.tmp)) this.near.update(this.tmp); }
		this.watchAcc += dt;
		if (this.watchAcc > 2) { this.watchAcc = 0; this.hookEvents(); }
	}
}
