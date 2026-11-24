/*
 * RealismModShop.ts
 * -----------------
 * Mod shop at the MECHANIC & BODY SHOP (map building with sub 'mechanic', found at runtime).
 *
 *  - A painted bay (floor decal) and a MOD SHOP sign stand in front of the building.
 *  - Drive into the bay (stop or roll slowly): "[E] Mod shop". Your own car keeps what you buy; any other
 *    car can be tuned too but nothing is saved for it.
 *  - E opens the shop (mouse released through realismSetUIBlocking('modShop', true)):
 *      Paint      palette, custom RGB + hue sliders, finish gloss / metallic / matte
 *      Suspension ride height, stiffness (springs + dampers)
 *      Handling   steering speed, max steering angle, tyre grip
 *      Engine     levels 1-4 (power + top speed)
 *      Brakes     levels 1-3
 *    Every choice is previewed live on the car (the camera slowly circles it). Buy charges the total through
 *    (world as any).realismEconomy.spend(total, 'Mod shop: ...', 'Mechanic & Body Shop') (free without an
 *    economy) and saves the tuning on the owned record: realismOwnedCars.update(id, { tuning, rgb }).
 *    Exit (or Esc) puts back everything you did not buy.
 *  - Prices: modShop.prices in realism-config.js, keyed '<group>.<option>' (see the config section).
 *
 * API (world as any).realismModShop = { open(car?), exit(), buy(), select(group, option), setColor(rgb),
 *   setFinish(f), total(), state(), bay, isOpen }
 */

import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
import { VehicleTuning, playerVehicle } from './RealismVehicleTuning';

export interface ShopOption { id: string; name: string; price: number; values: any; }
export interface ShopGroup { id: string; cat: string; name: string; options: ShopOption[]; }

const MERCHANT = 'Mechanic & Body Shop';

export const DEFAULT_PALETTE: { name: string; rgb: number[] }[] = [
	{ name: 'Black', rgb: [0.04, 0.04, 0.045] }, { name: 'White', rgb: [0.95, 0.95, 0.94] }, { name: 'Silver', rgb: [0.66, 0.68, 0.7] },
	{ name: 'Graphite', rgb: [0.25, 0.26, 0.28] }, { name: 'Red', rgb: [0.75, 0.06, 0.05] }, { name: 'Candy Red', rgb: [0.5, 0.02, 0.05] },
	{ name: 'Orange', rgb: [0.95, 0.4, 0.05] }, { name: 'Yellow', rgb: [0.95, 0.78, 0.08] }, { name: 'Lime', rgb: [0.45, 0.8, 0.12] },
	{ name: 'Green', rgb: [0.1, 0.36, 0.18] }, { name: 'Teal', rgb: [0.05, 0.45, 0.48] }, { name: 'Sky Blue', rgb: [0.35, 0.6, 0.9] },
	{ name: 'Blue', rgb: [0.1, 0.22, 0.65] }, { name: 'Navy', rgb: [0.05, 0.08, 0.25] }, { name: 'Purple', rgb: [0.38, 0.12, 0.55] },
	{ name: 'Pink', rgb: [0.95, 0.45, 0.7] }, { name: 'Beige', rgb: [0.8, 0.72, 0.56] }, { name: 'Brown', rgb: [0.32, 0.2, 0.12] },
];

export const DEFAULT_PRICES: { [k: string]: number } = {
	'paint.color': 400, 'paint.gloss': 0, 'paint.metallic': 250, 'paint.matte': 300,
	'ride.stock': 0, 'ride.lifted': 500, 'ride.lowered': 350, 'ride.low': 600, 'ride.slammed': 900,
	'springs.soft': 300, 'springs.stock': 0, 'springs.sport': 700, 'springs.race': 1400,
	'steering.stock': 0, 'steering.quick': 600, 'steering.race': 1200,
	'steerAngle.stock': 0, 'steerAngle.wide': 500, 'steerAngle.drift': 900,
	'grip.stock': 0, 'grip.street': 700, 'grip.sport': 1300, 'grip.race': 2200, 'grip.drift': 500,
	'engine.1': 0, 'engine.2': 1500, 'engine.3': 3500, 'engine.4': 6500,
	'brakes.1': 0, 'brakes.2': 800, 'brakes.3': 1800,
};

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
function near(a: number, b: number): boolean { return Math.abs(a - b) < 1e-3; }
function money(n: number): string { return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function esc(s: string): string { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]); }

function hsvToRgb(h: number, s: number, v: number): number[]
{
	const c = new THREE.Color();
	// HSL from HSV
	const l = v * (1 - s / 2);
	const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
	c.setHSL(((h % 360) + 360) % 360 / 360, sl, l);
	return [c.r, c.g, c.b];
}

export class ModShop
{
	public updateOrder = 7;
	public api: any;
	public bay: { x: number; z: number; y: number; rot: number; w: number; d: number; fx: number; fz: number; rx: number; rz: number } = null;
	public isOpen = false;
	public car: any = null;
	public committed: any = null;
	public preview: any = null;
	public groups: ShopGroup[] = [];
	public palette: { name: string; rgb: number[] }[];
	public settings: any;
	public lastMessage = '';
	public hintText = '';
	public meshes: THREE.Object3D[] = [];
	private ctx: RealismCtx;
	private tuning: VehicleTuning;
	private prices: { [k: string]: number };
	private cat = 'paint';
	private hint: HTMLElement = null;
	private overlay: HTMLElement = null;
	private wasLocked = false;
	private savedRadius = 3;
	private owned: any = null;
	private hsv = { h: 0, s: 0, v: 1 };
	private prevFlags: { tuned: boolean; rgb: number[] } = null;
	private bought = false;

	constructor(ctx: RealismCtx, tuning: VehicleTuning)
	{
		this.ctx = ctx;
		this.tuning = tuning;
		const c: any = (ctx.cfg as any).modShop || {};
		this.settings = {
			enabled: c.enabled !== false,
			bayOffset: c.bayOffset instanceof Array ? c.bayOffset : [7, 6],
			baySize: c.baySize instanceof Array ? c.baySize : [4.8, 7.5],
			orbit: c.orbit !== false,
			saveUnowned: false,
		};
		this.prices = Object.assign({}, DEFAULT_PRICES, c.prices || {});
		this.palette = c.palette instanceof Array && c.palette.length ? c.palette.map((p: any, i: number) => p instanceof Array ? { name: 'Colour ' + (i + 1), rgb: p } : p) : DEFAULT_PALETTE;
		const self = this;
		this.api = {
			open(car?: any): boolean { return self.open(car); },
			exit(): void { self.exit(); },
			buy(): boolean { return self.buy(); },
			select(group: string, option: string): void { self.select(group, option); },
			setColor(rgb: number[]): void { self.setColor(rgb); },
			setFinish(f: string): void { self.setFinish(f); },
			category(c: string): void { self.cat = c; self.render(); },
			total(): number { return self.total(); },
			cart(): any[] { return self.cart(); },
			state(): any { return { isOpen: self.isOpen, cat: self.cat, preview: self.preview, committed: self.committed, message: self.lastMessage, hint: self.hintText }; },
			get bay(): any { return self.bay; },
			get isOpen(): boolean { return self.isOpen; },
			get groups(): ShopGroup[] { return self.groups; },
			inBay(car: any): boolean { return self.inBay(car); },
		};
		(ctx.world as any).realismModShop = this.api;
		if (!this.settings.enabled) return;
		this.findBay();
		if (this.bay) this.buildBay();
		this.bindInput();
	}

	// ------------------------------------------------------------------ bay

	private findBay(): void
	{
		const bs: any[] = this.ctx.data.buildings || [];
		let b: any = null;
		for (let i = 0; i < bs.length && !b; i++) if (bs[i].sub === 'mechanic') b = bs[i];
		for (let i = 0; i < bs.length && !b; i++) if (String(bs[i].label || '').toUpperCase().indexOf('MECHANIC') >= 0) b = bs[i];
		if (!b) { console.warn('[Realism] Mod shop: no MECHANIC & BODY SHOP building in the map'); return; }
		const fx = Math.sin(b.rot), fz = Math.cos(b.rot);       // building front (local +Z)
		const rx = Math.cos(b.rot), rz = -Math.sin(b.rot);      // building local +X
		const off = this.settings.bayOffset, size = this.settings.baySize;
		const dist = b.d / 2 + Math.max(size[1] / 2 + 0.5, off[1]);
		const x = b.x + fx * dist + rx * off[0], z = b.z + fz * dist + rz * off[0];
		this.bay = { x: x, z: z, y: this.ctx.data.heightAt(x, z), rot: b.rot, w: size[0], d: size[1], fx: fx, fz: fz, rx: rx, rz: rz };
	}

	private buildBay(): void
	{
		const B = this.bay;
		const data = this.ctx.data;
		// floor decal following the ground
		const g = new THREE.PlaneBufferGeometry(B.w, B.d, 4, 6);
		g.rotateX(-Math.PI / 2);
		const p = g.attributes.position as THREE.BufferAttribute;
		let maxY = -1e9;
		for (let i = 0; i < p.count; i++)
		{
			const lx = p.getX(i), lz = p.getZ(i);
			const wx = B.x + B.rx * lx + B.fx * -lz, wz = B.z + B.rz * lx + B.fz * -lz;
			const y = data.heightAt(wx, wz) + 0.045;
			p.setXYZ(i, wx, y, wz);
			if (y > maxY) maxY = y;
		}
		g.computeVertexNormals();
		g.computeBoundingSphere();
		const floor = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: this.floorTexture(), alphaTest: 0.35, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
		floor.name = 'modShopBay';
		floor.receiveShadow = true;
		floor.matrixAutoUpdate = false;
		floor.updateMatrix();
		try { this.ctx.world.sky.csm.setupMaterial(floor.material as THREE.Material); } catch (e) { /* no csm */ }
		this.ctx.world.graphicsWorld.add(floor);
		// sign: post + board, beside the bay, facing the street
		const sx = B.x + B.rx * (B.w / 2 + 1.0) + B.fx * (B.d / 2 - 0.5), sz = B.z + B.rz * (B.w / 2 + 1.0) + B.fz * (B.d / 2 - 0.5);
		const gy = data.heightAt(sx, sz);
		const post = new THREE.Mesh(new THREE.BoxBufferGeometry(0.12, 3.2, 0.12), new THREE.MeshLambertMaterial({ color: 0x33363b }));
		post.position.set(sx, gy + 1.6, sz);
		post.rotation.y = B.rot;
		post.castShadow = !!this.ctx.preset.shadows;
		post.name = 'modShopSignPost';
		const boardMat = new THREE.MeshLambertMaterial({ map: this.signTexture(), side: THREE.DoubleSide, emissive: new THREE.Color(0.25, 0.25, 0.25) });
		const board = new THREE.Mesh(new THREE.PlaneBufferGeometry(2.4, 0.9), boardMat);
		board.position.set(sx + B.fx * 0.07, gy + 2.85, sz + B.fz * 0.07);
		board.rotation.y = B.rot;
		board.name = 'modShopSign';
		[post, board].forEach((m) => { m.updateMatrix(); m.matrixAutoUpdate = false; this.ctx.world.graphicsWorld.add(m); });
		try { this.ctx.world.sky.csm.setupMaterial(post.material as THREE.Material); this.ctx.world.sky.csm.setupMaterial(boardMat); } catch (e) { /* no csm */ }
		this.meshes = [floor, post, board];
	}

	private canvas(w: number, h: number): { cv: any; g: any }
	{
		const cv: any = document.createElement('canvas');
		cv.width = w; cv.height = h;
		return { cv: cv, g: cv.getContext('2d') };
	}

	private floorTexture(): THREE.Texture
	{
		const { cv, g } = this.canvas(256, 512);
		if (g)
		{
			g.clearRect(0, 0, 256, 512);
			g.fillStyle = 'rgba(40,44,50,0.55)'; g.fillRect(0, 0, 256, 512);
			g.strokeStyle = '#f2c230'; g.lineWidth = 14; g.strokeRect(9, 9, 238, 494);
			// hatching at the entry (street end = bottom of the texture)
			g.save(); g.beginPath(); g.rect(16, 430, 224, 66); g.clip();
			g.lineWidth = 12;
			for (let x = -80; x < 300; x += 34) { g.beginPath(); g.moveTo(x, 500); g.lineTo(x + 70, 430); g.stroke(); }
			g.restore();
			g.fillStyle = '#f2c230'; g.textAlign = 'center'; g.textBaseline = 'middle';
			g.font = 'bold 46px Arial, sans-serif';
			g.fillText('MOD', 128, 70); g.fillText('SHOP', 128, 122);
			g.font = 'bold 22px Arial, sans-serif';
			g.fillText('STOP HERE  [E]', 128, 175);
		}
		const t = new THREE.CanvasTexture(cv);
		t.anisotropy = 4;
		return t;
	}

	private signTexture(): THREE.Texture
	{
		const { cv, g } = this.canvas(512, 192);
		if (g)
		{
			g.fillStyle = '#14181f'; g.fillRect(0, 0, 512, 192);
			g.strokeStyle = '#f2c230'; g.lineWidth = 8; g.strokeRect(6, 6, 500, 180);
			g.textAlign = 'center'; g.textBaseline = 'middle';
			g.fillStyle = '#f2c230'; g.font = 'bold 76px Arial, sans-serif'; g.fillText('MOD SHOP', 256, 78);
			g.fillStyle = '#ffffff'; g.font = 'bold 26px Arial, sans-serif'; g.fillText('PAINT  \u00b7  SUSPENSION  \u00b7  TUNING', 256, 148);
		}
		return new THREE.CanvasTexture(cv);
	}

	public inBay(car: any): boolean
	{
		const B = this.bay;
		if (!B || !car) return false;
		const p = car.collision ? car.collision.position : car.position;
		const dx = p.x - B.x, dz = p.z - B.z;
		const lx = dx * B.rx + dz * B.rz, lz = dx * B.fx + dz * B.fz;
		return Math.abs(lx) < B.w / 2 + 0.4 && Math.abs(lz) < B.d / 2 + 0.4 && Math.abs(p.y - B.y) < 4;
	}

	// ------------------------------------------------------------------ catalog

	/** Option groups for this car (engine / steering levels are relative to its stock values). */
	private buildGroups(car: any): void
	{
		const d = this.tuning.defaults(car);
		const P = (k: string) => typeof this.prices[k] === 'number' ? this.prices[k] : (DEFAULT_PRICES[k] || 0);
		const opt = (g: string, id: string, name: string, values: any): ShopOption => ({ id: id, name: name, price: P(g + '.' + id), values: values });
		this.groups = [
			{ id: 'ride', cat: 'suspension', name: 'Ride height', options: [
				opt('ride', 'lifted', 'Lifted +5 cm', { rideHeight: 0.05 }), opt('ride', 'stock', 'Stock', { rideHeight: 0 }),
				opt('ride', 'lowered', 'Lowered -3 cm', { rideHeight: -0.03 }), opt('ride', 'low', 'Low -6 cm', { rideHeight: -0.06 }),
				opt('ride', 'slammed', 'Slammed -9 cm', { rideHeight: -0.09 })] },
			{ id: 'springs', cat: 'suspension', name: 'Stiffness', options: [
				opt('springs', 'soft', 'Soft', { suspensionStiffness: d.suspensionStiffness * 0.7, damping: d.damping * 0.8 }),
				opt('springs', 'stock', 'Stock', { suspensionStiffness: d.suspensionStiffness, damping: d.damping }),
				opt('springs', 'sport', 'Sport', { suspensionStiffness: d.suspensionStiffness * 1.4, damping: d.damping * 1.3 }),
				opt('springs', 'race', 'Race', { suspensionStiffness: d.suspensionStiffness * 1.9, damping: d.damping * 1.6 })] },
			{ id: 'steering', cat: 'handling', name: 'Steering speed', options: [
				opt('steering', 'stock', 'Stock', { steeringSpeed: 1 }), opt('steering', 'quick', 'Quick', { steeringSpeed: 1.35 }),
				opt('steering', 'race', 'Race', { steeringSpeed: 1.7 })] },
			{ id: 'steerAngle', cat: 'handling', name: 'Max steering angle', options: [
				opt('steerAngle', 'stock', 'Stock', { maxSteer: d.maxSteer }), opt('steerAngle', 'wide', 'Wide lock', { maxSteer: d.maxSteer * 1.19 }),
				opt('steerAngle', 'drift', 'Drift lock', { maxSteer: d.maxSteer * 1.375 })] },
			{ id: 'grip', cat: 'handling', name: 'Tyres (grip)', options: [
				opt('grip', 'drift', 'Drift', { grip: d.grip * 0.75 }), opt('grip', 'stock', 'Stock', { grip: d.grip }),
				opt('grip', 'street', 'Street', { grip: d.grip * 1.19 }), opt('grip', 'sport', 'Sport', { grip: d.grip * 1.375 }),
				opt('grip', 'race', 'Race slicks', { grip: d.grip * 1.625 })] },
			{ id: 'engine', cat: 'engine', name: 'Engine', options: [
				opt('engine', '1', 'Level 1 (stock)', { enginePower: d.enginePower, topSpeed: 1 }),
				opt('engine', '2', 'Level 2', { enginePower: d.enginePower * 1.2, topSpeed: 1.08 }),
				opt('engine', '3', 'Level 3', { enginePower: d.enginePower * 1.44, topSpeed: 1.16 }),
				opt('engine', '4', 'Level 4', { enginePower: d.enginePower * 1.72, topSpeed: 1.25 })] },
			{ id: 'brakes', cat: 'brakes', name: 'Brakes', options: [
				opt('brakes', '1', 'Level 1 (stock)', { brakeForce: 1 }), opt('brakes', '2', 'Level 2', { brakeForce: 1.5 }),
				opt('brakes', '3', 'Level 3', { brakeForce: 2.2 })] },
		];
	}

	private matchOption(g: ShopGroup, t: any): ShopOption
	{
		for (let i = 0; i < g.options.length; i++)
		{
			const v = g.options[i].values;
			let ok = true;
			for (const k in v) if (v.hasOwnProperty(k) && !(typeof t[k] === 'number' && Math.abs(t[k] - v[k]) < 1e-3 * Math.max(1, Math.abs(v[k])))) ok = false;
			if (ok) return g.options[i];
		}
		return null;
	}

	private groupChanged(g: ShopGroup): boolean
	{
		const v = g.options[0].values;
		for (const k in v)
		{
			if (!v.hasOwnProperty(k)) continue;
			const a = this.preview[k], b = this.committed[k];
			if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) > 1e-3 * Math.max(1, Math.abs(b))) return true;
		}
		return false;
	}

	private paintChanged(): { color: boolean; finish: boolean }
	{
		const a = this.preview.rgb || [], b = this.committed.rgb || [];
		let color = false;
		for (let i = 0; i < 3; i++) if (!near(a[i], b[i])) color = true;
		return { color: color, finish: this.preview.finish !== this.committed.finish };
	}

	/** Items that differ from what the car already has, with prices. */
	public cart(): { group: string; name: string; price: number }[]
	{
		if (!this.isOpen) return [];
		const out: { group: string; name: string; price: number }[] = [];
		const pc = this.paintChanged();
		if (pc.color || pc.finish)
		{
			const f = this.preview.finish;
			const fp = f === 'metallic' || f === 'matte' || f === 'gloss' ? (this.prices['paint.' + f] || 0) : 0;
			out.push({ group: 'paint', name: 'Paint' + (f && f !== 'stock' ? ' (' + f + ')' : ''), price: (this.prices['paint.color'] || 0) + fp });
		}
		for (let i = 0; i < this.groups.length; i++)
		{
			const g = this.groups[i];
			if (!this.groupChanged(g)) continue;
			const o = this.matchOption(g, this.preview);
			out.push({ group: g.id, name: g.name + ': ' + (o ? o.name : 'custom'), price: o ? o.price : 0 });
		}
		return out;
	}

	public total(): number
	{
		const c = this.cart();
		let t = 0;
		for (let i = 0; i < c.length; i++) t += c[i].price;
		return t;
	}

	// ------------------------------------------------------------------ open / preview / buy / exit

	private drivenCar(): any
	{
		return playerVehicle(this.ctx.world);
	}

	private record(car: any): any
	{
		const oc = (this.ctx.world as any).realismOwnedCars;
		try
		{
			if (oc && typeof oc.recordFor === 'function') return oc.recordFor(car);
			if (oc && typeof oc.current === 'function' && car === this.drivenCar()) return oc.current();
		}
		catch (e) { /* ignore */ }
		return null;
	}

	public open(carIn?: any): boolean
	{
		if (this.isOpen) return true;
		const car = carIn || this.drivenCar();
		if (!car || !car.rayCastVehicle) return false;
		const w: any = this.ctx.world;
		this.car = car;
		this.owned = this.record(car);
		this.committed = this.tuning.read(car);
		this.preview = JSON.parse(JSON.stringify(this.committed));
		const c = this.preview.rgb || [1, 1, 1];
		const col = new THREE.Color(c[0], c[1], c[2]);
		const hsl = { h: 0, s: 0, l: 0 };
		col.getHSL(hsl);
		const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
		this.hsv.h = hsl.h * 360; this.hsv.v = mx; this.hsv.s = mx > 0 ? (mx - mn) / mx : 0;
		this.prevFlags = { tuned: !!car.realismTuned, rgb: car.realismTunedRgb ? car.realismTunedRgb.slice(0) : null };
		this.bought = false;
		this.buildGroups(car);
		car.realismModShopPreview = true;
		this.isOpen = true;
		this.cat = 'paint';
		this.lastMessage = this.owned ? '' : 'Not your car: you can tune it, but nothing is saved.';
		try { if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking('modShop', true); } catch (e) { /* ignore */ }
		try
		{
			this.wasLocked = typeof document !== 'undefined' && !!document.pointerLockElement;
			if (this.wasLocked)
			{
				if (w.realismUI && w.realismUI.exitLock) w.realismUI.exitLock(); else document.exitPointerLock();
			}
		}
		catch (e) { this.wasLocked = false; }
		try { this.savedRadius = w.cameraOperator.radius || 3; if (this.settings.orbit && !w.realismFirstPerson) w.cameraOperator.setRadius(4.6); } catch (e) { /* no camera */ }
		this.hold(true);
		this.ensureOverlay();
		this.render();
		if (this.overlay) this.overlay.style.display = '';
		this.setHint('');
		return true;
	}

	private hold(on: boolean): void
	{
		const car = this.car;
		if (!car) return;
		try
		{
			if (on) { car.applyEngineForce(0); car.setBrake(1000000); }
			else car.setBrake(0);
		}
		catch (e) { /* ignore */ }
	}

	/** Preview one option of a group on the car. */
	public select(groupId: string, optionId: string): void
	{
		if (!this.isOpen) return;
		const g = this.groups.filter((x) => x.id === groupId)[0];
		if (!g) return;
		const o = g.options.filter((x) => x.id === optionId)[0];
		if (!o) return;
		for (const k in o.values) if (o.values.hasOwnProperty(k)) this.preview[k] = o.values[k];
		this.tuning.apply(this.car, o.values);
		this.lastMessage = '';
		this.render();
	}

	public setColor(rgb: number[]): void
	{
		if (!this.isOpen || !(rgb instanceof Array)) return;
		this.preview.rgb = [clamp(+rgb[0] || 0, 0, 1), clamp(+rgb[1] || 0, 0, 1), clamp(+rgb[2] || 0, 0, 1)];
		this.tuning.apply(this.car, { rgb: this.preview.rgb });
		this.lastMessage = '';
		this.render();
	}

	public setFinish(f: string): void
	{
		if (!this.isOpen) return;
		this.preview.finish = f;
		this.tuning.apply(this.car, { finish: f });
		this.render();
	}

	public buy(): boolean
	{
		if (!this.isOpen) return false;
		const items = this.cart();
		const total = this.total();
		if (items.length === 0) { this.lastMessage = 'Nothing to buy: pick something first.'; this.render(); return false; }
		const w: any = this.ctx.world;
		const eco = w.realismEconomy;
		if (eco && typeof eco.spend === 'function' && total > 0)
		{
			const desc = 'Mod shop: ' + items.map((i) => i.name).join(', ');
			let ok = false;
			try { ok = eco.spend(total, desc.length > 120 ? desc.slice(0, 117) + '...' : desc, MERCHANT) !== false; } catch (e) { ok = false; }
			if (!ok) { this.lastMessage = 'Not enough money (' + money(total) + ').'; this.render(); return false; }
		}
		this.committed = JSON.parse(JSON.stringify(this.preview));
		const live = this.tuning.read(this.car);
		this.car.realismTuned = true;
		this.car.realismTunedRgb = live.rgb ? live.rgb.slice(0) : null;
		this.bought = true;
		const rec = this.owned || this.record(this.car);
		if (rec && rec.id !== undefined)
		{
			const oc = w.realismOwnedCars;
			try
			{
				if (oc && typeof oc.update === 'function') oc.update(rec.id, { tuning: live, rgb: live.rgb ? live.rgb.slice(0) : undefined });
				else { rec.tuning = live; if (live.rgb) rec.rgb = live.rgb.slice(0); if (oc && oc.save) oc.save(); }
			}
			catch (e) { console.warn('[Realism] Mod shop: saving the tuning failed', e); }
			this.lastMessage = 'Bought for ' + money(total) + '. Saved on your car.';
		}
		else this.lastMessage = 'Bought for ' + money(total) + '. Not your car, so it is not saved.';
		this.render();
		return true;
	}

	/** Leaves the shop and puts back everything that was not bought. */
	public exit(): void
	{
		if (!this.isOpen) return;
		const w: any = this.ctx.world;
		const car = this.car;
		const keepLivery = { livery: undefined as any, unit: undefined as any };
		this.tuning.apply(car, Object.assign({}, this.committed, keepLivery));
		if (this.bought) { car.realismTuned = true; car.realismTunedRgb = this.committed.rgb ? this.committed.rgb.slice(0) : null; }
		else if (this.prevFlags) { car.realismTuned = this.prevFlags.tuned; car.realismTunedRgb = this.prevFlags.rgb; }
		car.realismModShopPreview = false;
		this.hold(false);
		this.isOpen = false;
		if (this.overlay) this.overlay.style.display = 'none';
		try { w.cameraOperator.setRadius(this.savedRadius || 3); } catch (e) { /* ignore */ }
		try { if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking('modShop', false); } catch (e) { /* ignore */ }
		if (this.wasLocked)
		{
			try
			{
				if (w.realismUI && w.realismUI.requestLock) w.realismUI.requestLock();
				else if (w.renderer && w.renderer.domElement.requestPointerLock) w.renderer.domElement.requestPointerLock();
			}
			catch (e) { /* next click grabs the mouse */ }
		}
		this.car = null;
		this.owned = null;
	}

	// ------------------------------------------------------------------ per frame

	public update(timeStep: number, unscaled: number): void
	{
		if (!this.bay) return;
		const w: any = this.ctx.world;
		// show the bay only near it
		const cam = w.camera ? w.camera.position : null;
		if (cam)
		{
			const far = (cam.x - this.bay.x) * (cam.x - this.bay.x) + (cam.z - this.bay.z) * (cam.z - this.bay.z) > 260 * 260;
			for (let i = 0; i < this.meshes.length; i++) if (this.meshes[i].visible === far) this.meshes[i].visible = !far;
		}
		if (this.isOpen)
		{
			if (!this.car || !this.car.world) { this.exit(); return; }
			this.hold(true);
			if (this.settings.orbit && !w.realismPaused && !w.realismFirstPerson && w.cameraOperator)
			{
				const co = w.cameraOperator;
				co.theta = (co.theta + 9 * Math.min(unscaled, 0.1)) % 360;
				co.phi += (14 - co.phi) * Math.min(1, unscaled * 2);
			}
			return;
		}
		let text = '';
		if (!w.realismPaused && !w.realismUIBlocking)
		{
			const car = this.drivenCar();
			if (car && this.inBay(car) && Math.abs(car.speed || 0) < 3)
				text = this.record(car) ? '[E] Mod shop' : '[E] Mod shop (not your car: nothing is saved)';
		}
		this.setHint(text);
	}

	private setHint(t: string): void
	{
		if (t === this.hintText) return;
		this.hintText = t;
		if (!this.hint)
		{
			try
			{
				if (typeof document === 'undefined' || !document.body) return;
				const h = document.createElement('div');
				h.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:9999;font:bold 14px sans-serif;color:#fff;background:rgba(0,0,0,0.55);padding:5px 12px;border-radius:5px;pointer-events:none;display:none;letter-spacing:0.5px';
				document.body.appendChild(h);
				this.hint = h;
			}
			catch (e) { return; }
		}
		this.hint.textContent = t;
		this.hint.style.display = t ? '' : 'none';
	}

	private bindInput(): void
	{
		try
		{
			if (typeof window === 'undefined' || !(window as any).addEventListener) return;
			window.addEventListener('keydown', (e: KeyboardEvent) => this.onKey(e), true);
		}
		catch (e) { /* headless */ }
	}

	/** Public for tests. */
	public onKey(e: any): boolean
	{
		const w: any = this.ctx.world;
		if (this.isOpen)
		{
			if (e.code === 'Escape') { if (e.preventDefault) e.preventDefault(); this.exit(); return true; }
			return false;
		}
		if (e.code !== 'KeyE' || e.repeat || w.realismPaused || w.realismUIBlocking || !this.hintText) return false;
		const t: any = e.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false;
		return this.open();
	}

	// ------------------------------------------------------------------ overlay

	private ensureOverlay(): void
	{
		if (this.overlay) return;
		try
		{
			if (typeof document === 'undefined' || !document.body) return;
			const st = document.createElement('style');
			st.textContent =
				'#rr-modshop{position:fixed;left:18px;top:50%;transform:translateY(-50%);width:330px;max-height:86vh;overflow:auto;z-index:10000;' +
				'background:rgba(12,15,21,0.92);color:#eee;font:13px sans-serif;border-radius:10px;box-shadow:0 6px 30px rgba(0,0,0,0.5);padding:14px 16px;user-select:none}' +
				'#rr-modshop h2{margin:0 0 2px;font-size:18px;letter-spacing:1px;color:#f2c230}' +
				'#rr-modshop .ms-sub{opacity:0.7;font-size:12px;margin-bottom:10px}' +
				'#rr-modshop .ms-tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px}' +
				'#rr-modshop button{font:12px sans-serif;color:#eee;background:#232933;border:1px solid #39414e;border-radius:5px;padding:5px 8px;cursor:pointer}' +
				'#rr-modshop button:hover{background:#2e3644}#rr-modshop button.on{background:#f2c230;color:#111;border-color:#f2c230;font-weight:bold}' +
				'#rr-modshop .ms-g{margin:8px 0 4px;font-weight:bold;font-size:12px;opacity:0.85}' +
				'#rr-modshop .ms-opts{display:flex;flex-wrap:wrap;gap:4px}' +
				'#rr-modshop .ms-p{opacity:0.75;font-size:11px;margin-left:4px}' +
				'#rr-modshop .ms-sw{width:26px;height:26px;border-radius:5px;padding:0;border:2px solid #39414e}#rr-modshop .ms-sw.on{border-color:#fff}' +
				'#rr-modshop input[type=range]{width:100%}#rr-modshop label{display:block;font-size:11px;opacity:0.8;margin-top:4px}' +
				'#rr-modshop .ms-cart{margin-top:12px;border-top:1px solid #333;padding-top:8px}' +
				'#rr-modshop .ms-tot{font-size:15px;font-weight:bold;margin:6px 0}' +
				'#rr-modshop .ms-msg{color:#ffd54a;min-height:16px;font-size:12px;margin:4px 0}' +
				'#rr-modshop .ms-act{display:flex;gap:8px;margin-top:6px}#rr-modshop .ms-act button{flex:1;padding:8px;font-size:13px}' +
				'#rr-modshop .ms-buy{background:#2f8a46;border-color:#2f8a46}';
			document.head.appendChild(st);
			const o = document.createElement('div');
			o.id = 'rr-modshop';
			o.style.display = 'none';
			o.addEventListener('mousedown', (ev: Event) => ev.stopPropagation(), false);
			o.addEventListener('click', (ev: Event) => this.onClick(ev), false);
			o.addEventListener('input', (ev: Event) => this.onInput(ev), false);
			document.body.appendChild(o);
			this.overlay = o;
		}
		catch (e) { this.overlay = null; }
	}

	private onClick(ev: Event): void
	{
		let t: any = ev.target;
		while (t && t !== this.overlay && !(t.getAttribute && t.getAttribute('data-act'))) t = t.parentNode;
		if (!t || t === this.overlay || !t.getAttribute) return;
		ev.preventDefault();
		const act = t.getAttribute('data-act'), a = t.getAttribute('data-a'), b = t.getAttribute('data-b');
		if (act === 'cat') { this.cat = a; this.render(); }
		else if (act === 'opt') this.select(a, b);
		else if (act === 'sw') { const p = this.palette[parseInt(a, 10)]; if (p) this.setColor(p.rgb); }
		else if (act === 'fin') this.setFinish(a);
		else if (act === 'buy') this.buy();
		else if (act === 'exit') this.exit();
	}

	private onInput(ev: Event): void
	{
		const t: any = ev.target;
		if (!t || !t.getAttribute) return;
		const k = t.getAttribute('data-in');
		const v = parseFloat(t.value);
		if (!k || !isFinite(v)) return;
		const rgb = (this.preview.rgb || [1, 1, 1]).slice(0);
		if (k === 'r' || k === 'g' || k === 'b') { rgb['rgb'.indexOf(k)] = v / 255; this.setColorQuiet(rgb); }
		else if (k === 'h') { this.hsv.h = v; this.setColorQuiet(hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v)); }
		else if (k === 's') { this.hsv.s = v / 100; this.setColorQuiet(hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v)); }
		else if (k === 'v') { this.hsv.v = v / 100; this.setColorQuiet(hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v)); }
	}

	/** Slider drag: preview without rebuilding the sliders under the mouse; only the cart is refreshed. */
	private setColorQuiet(rgb: number[]): void
	{
		this.preview.rgb = [clamp(rgb[0], 0, 1), clamp(rgb[1], 0, 1), clamp(rgb[2], 0, 1)];
		this.tuning.apply(this.car, { rgb: this.preview.rgb });
		this.renderCart();
	}

	private render(): void
	{
		if (!this.overlay || !this.isOpen) return;
		const cats = [['paint', 'Paint'], ['suspension', 'Suspension'], ['handling', 'Handling'], ['engine', 'Engine'], ['brakes', 'Brakes']];
		let h = '<h2>MOD SHOP</h2><div class="ms-sub">Mechanic &amp; Body Shop' + (this.owned ? ' &middot; ' + esc(this.owned.name || 'your car') : ' &middot; not your car') + '</div>';
		h += '<div class="ms-tabs">' + cats.map((c) => '<button data-act="cat" data-a="' + c[0] + '" class="' + (this.cat === c[0] ? 'on' : '') + '">' + c[1] + '</button>').join('') + '</div>';
		if (this.cat === 'paint')
		{
			const cur = this.preview.rgb || [1, 1, 1];
			h += '<div class="ms-g">Colour <span class="ms-p">' + money(this.prices['paint.color'] || 0) + '</span></div><div class="ms-opts">';
			for (let i = 0; i < this.palette.length; i++)
			{
				const p = this.palette[i];
				const on = near(p.rgb[0], cur[0]) && near(p.rgb[1], cur[1]) && near(p.rgb[2], cur[2]);
				h += '<button class="ms-sw' + (on ? ' on' : '') + '" title="' + esc(p.name) + '" data-act="sw" data-a="' + i + '" style="background:rgb(' +
					Math.round(p.rgb[0] * 255) + ',' + Math.round(p.rgb[1] * 255) + ',' + Math.round(p.rgb[2] * 255) + ')"></button>';
			}
			h += '</div><div class="ms-g">Custom colour</div>';
			h += '<label>Hue</label><input type="range" min="0" max="360" value="' + Math.round(this.hsv.h) + '" data-in="h">';
			h += '<label>Saturation</label><input type="range" min="0" max="100" value="' + Math.round(this.hsv.s * 100) + '" data-in="s">';
			h += '<label>Brightness</label><input type="range" min="0" max="100" value="' + Math.round(this.hsv.v * 100) + '" data-in="v">';
			h += '<label>Red</label><input type="range" min="0" max="255" value="' + Math.round(cur[0] * 255) + '" data-in="r">';
			h += '<label>Green</label><input type="range" min="0" max="255" value="' + Math.round(cur[1] * 255) + '" data-in="g">';
			h += '<label>Blue</label><input type="range" min="0" max="255" value="' + Math.round(cur[2] * 255) + '" data-in="b">';
			h += '<div class="ms-g">Finish</div><div class="ms-opts">';
			[['gloss', 'Gloss'], ['metallic', 'Metallic'], ['matte', 'Matte']].forEach((f) =>
			{
				const pr = this.prices['paint.' + f[0]] || 0;
				h += '<button data-act="fin" data-a="' + f[0] + '" class="' + (this.preview.finish === f[0] ? 'on' : '') + '">' + f[1] + (pr ? '<span class="ms-p">+' + money(pr) + '</span>' : '') + '</button>';
			});
			h += '</div>';
		}
		else
		{
			for (let i = 0; i < this.groups.length; i++)
			{
				const g = this.groups[i];
				if (g.cat !== this.cat) continue;
				const sel = this.matchOption(g, this.preview);
				const owned = this.matchOption(g, this.committed);
				h += '<div class="ms-g">' + esc(g.name) + '</div><div class="ms-opts">';
				for (let k = 0; k < g.options.length; k++)
				{
					const o = g.options[k];
					const tag = owned === o ? 'owned' : o.price ? money(o.price) : 'free';
					h += '<button data-act="opt" data-a="' + g.id + '" data-b="' + o.id + '" class="' + (sel === o ? 'on' : '') + '">' + esc(o.name) + '<span class="ms-p">' + tag + '</span></button>';
				}
				h += '</div>';
			}
		}
		h += '<div class="ms-cart" data-cart="1"></div>';
		this.overlay.innerHTML = h;
		this.renderCart();
	}

	private renderCart(): void
	{
		if (!this.overlay || !this.isOpen) return;
		let box: any = null;
		try { box = this.overlay.querySelector('[data-cart]'); } catch (e) { box = null; }
		if (!box) return;
		const items = this.cart();
		const eco = (this.ctx.world as any).realismEconomy;
		let bal = '';
		try { if (eco && eco.getBank) bal = 'Bank ' + money(eco.getBank()) + (eco.getCash ? ' &middot; Cash ' + money(eco.getCash()) : ''); } catch (e) { bal = ''; }
		let h = items.length ? items.map((i) => '<div>' + esc(i.name) + ' <span class="ms-p">' + money(i.price) + '</span></div>').join('') : '<div class="ms-p">No changes yet. Pick parts to preview them on the car.</div>';
		h += '<div class="ms-tot">Total ' + money(this.total()) + (eco ? '' : ' <span class="ms-p">(free)</span>') + '</div>';
		if (bal) h += '<div class="ms-p">' + bal + '</div>';
		h += '<div class="ms-msg">' + esc(this.lastMessage) + '</div>';
		h += '<div class="ms-act"><button class="ms-buy" data-act="buy">Buy</button><button data-act="exit">Exit (Esc)</button></div>';
		box.innerHTML = h;
	}
}
