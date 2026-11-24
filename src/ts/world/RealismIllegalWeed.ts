/*
 * RealismIllegalWeed.ts
 * ---------------------
 * Grow room in a warehouse you own (C10 properties, kind 'warehouse'), game mechanics only:
 *
 *  - Own a warehouse (SV Realty, A15): a GROW ROOM door appears beside it (marker + blip). Without one, the
 *    guide tells you to buy one. illegal.weed.freeWithoutProperties: true lends you the port warehouse
 *    closest to the hood when there is no property system at all (testing / older builds).
 *  - Inside: grow tables (illegal.weed.startTables free, up to maxTables), a terminal and a packing table.
 *      Table: "[E] Plant" (1 Starter pot from Sal) -> the plant grows over in-game time:
 *             illegal.weed.growHours game hours from seedling to ready (x1.5 faster with grow lamps), only
 *             while watered: water lasts waterHours game hours ("[E] Water"; auto-water upgrade keeps it full).
 *             Stages (visible plant meshes): Seedling < 25 % < Growing < 60 % < Flowering < 100 % = Ready.
 *             "[E] Harvest" -> weed.baseYield (+2 with rich soil) Weed (unpackaged).
 *      Terminal: buy tables / grow lamps / rich soil / auto-water (realismEconomy, card or cash).
 *      Packing table: hold E -> every Weed (unpackaged) becomes Weed (bag).
 *  - Sell bags to Big Mo (bulk, 10+) or Dre (street dealer), RealismIllegalJobs.ts.
 *  - Every owned warehouse has its own tables and plants (saved), they share one room interior.
 *
 * API (world as any).realismIllegal.weed = { owned(), enter(pid), state(pid), plant(pid, i), water(pid, i),
 *   harvest(pid, i), pack(), buy(pid, what), stage(pid, i) }
 */

import * as THREE from 'three';
import { IllegalCore, PocketRoom, besideBuilding, reserve, money, textPlane, Site, NearSet, PromptItem, MenuRow, instMatSafe } from './RealismIllegalCore';
import { GeoAccum, Frame, boxC, cyl } from './RealismGeometry';

const TABLE_POS = [[-5.5, -3.2], [0, -3.2], [5.5, -3.2], [-5.5, 2.6], [0, 2.6], [5.5, 2.6], [-5.5, -0.3], [5.5, -0.3]];
const PLANTS_PER_TABLE = 4;
const STAGES = ['Seedling', 'Growing', 'Flowering', 'Ready'];

interface Plant { p: number; on: boolean; water: number; }
interface WeedState { tables: number; lamps: boolean; soil: boolean; autoWater: boolean; plants: Plant[]; harvested: number; }
interface Entrance { pid: string; building: number; site: Site; objs: THREE.Object3D[]; id: string; }

export class WeedGrow
{
	public api: any;
	public room: PocketRoom = null;
	public current: string = null;       // property id of the warehouse you are in
	public entrances: Entrance[] = [];
	public plantMesh: THREE.InstancedMesh = null;
	public tableMesh: THREE.InstancedMesh = null;
	private core: IllegalCore;
	private max: number;
	private acc = 1;
	private visAcc = 0;
	private near = new NearSet();
	private tmp = new THREE.Vector3();
	private tmpM = new THREE.Matrix4();
	private tmpQ = new THREE.Quaternion();
	private tmpS = new THREE.Vector3();
	private tmpP = new THREE.Vector3();
	private freeBuilding = -1;

	constructor(core: IllegalCore)
	{
		this.core = core;
		this.max = Math.max(1, Math.min(TABLE_POS.length, Math.round(core.cfg.weed.maxTables || 6)));
		this.buildRoom();
		core.addUpdater(this);
		const self = this;
		this.api = {
			owned(): any[] { return self.owned(); },
			enter(pid?: string): boolean { return self.enter(pid || (self.entrances[0] ? self.entrances[0].pid : '')); },
			leave(): void { if (self.room) self.room.leave(true); },
			state(pid?: string): WeedState { return self.st(pid || self.current || (self.entrances[0] ? self.entrances[0].pid : '')); },
			plant(pid: string, i: number): boolean { return self.plant(pid, i); },
			water(pid: string, i: number): boolean { return self.water(pid, i); },
			harvest(pid: string, i: number): number { return self.harvest(pid, i); },
			pack(): number { return self.pack(); },
			buy(pid: string, what: string): boolean { return self.buy(pid, what); },
			stage(pid: string, i: number): string { const pl = self.st(pid).plants[i]; return pl && pl.on ? STAGES[stageOf(pl.p)] : 'Empty'; },
			get entrances(): any[] { return self.entrances.map((e) => ({ pid: e.pid, building: e.building, x: +e.site.x.toFixed(1), z: +e.site.z.toFixed(1) })); },
			get visiblePlants(): number { return self.plantMesh ? self.plantMesh.count : 0; },
			refreshEntrances(): void { self.syncEntrances(); },
		};
	}

	// ------------------------------------------------------------------ properties

	public owned(): { id: string; buildingIndex: number; name: string }[]
	{
		const pr = (this.core.w as any).realismProperties;
		if (pr && typeof pr.ownedList === 'function')
		{
			let list: any[] = [];
			try { list = pr.ownedList() || []; } catch (e) { list = []; }
			return list.filter((p) => p && p.kind === 'warehouse' && typeof p.buildingIndex === 'number').map((p) => ({ id: String(p.id), buildingIndex: p.buildingIndex, name: p.name || 'Warehouse' }));
		}
		if (this.core.cfg.weed.freeWithoutProperties)
		{
			if (this.freeBuilding < 0)
			{
				const bs: any[] = this.core.ctx.data.buildings;
				let best = -1, bd = 1e9;
				for (let i = 0; i < bs.length; i++) if (bs[i].kind === 'warehouse' && bs[i].sub !== 'hangar' && !bs[i].custom) { const d = Math.hypot(bs[i].x - 670, bs[i].z - 350); if (d < bd) { bd = d; best = i; } }
				this.freeBuilding = best;
			}
			return this.freeBuilding >= 0 ? [{ id: 'b' + this.freeBuilding, buildingIndex: this.freeBuilding, name: 'Lent warehouse' }] : [];
		}
		return [];
	}

	private syncEntrances(): void
	{
		const own = this.owned();
		const ids: { [id: string]: boolean } = {};
		for (let i = 0; i < own.length; i++)
		{
			ids[own[i].id] = true;
			if (this.entrances.some((e) => e.pid === own[i].id)) continue;
			this.addEntrance(own[i].id, own[i].buildingIndex, own[i].name);
		}
		for (let i = this.entrances.length - 1; i >= 0; i--)
		{
			const e = this.entrances[i];
			if (ids[e.pid]) continue;
			this.core.remove(e.id);
			for (let k = 0; k < e.objs.length; k++) { e.objs[k].visible = false; e.objs[k].userData.hidden = true; if (e.objs[k].parent) e.objs[k].parent.remove(e.objs[k]); }
			this.near.items = this.near.items.filter((it) => e.objs.indexOf(it.o) < 0);
			this.entrances.splice(i, 1);
			const gps = (this.core.w as any).realismGPS;
			try { if (gps && gps.removeBlip) gps.removeBlip('ill_grow_' + e.pid); } catch (x) { /* ignore */ }
			delete this.core.blips['ill_grow_' + e.pid];
			if (this.current === e.pid && this.room && this.room.inside) this.room.leave(true);
		}
	}

	private addEntrance(pid: string, bi: number, name: string): void
	{
		const ctx = this.core.ctx;
		const s = besideBuilding(ctx, bi, 1.6, 1.6, { road: 'near', doorGap: 2.6, gap: 0.05 }) || besideBuilding(ctx, bi, 1.6, 1.6, { road: 'away', doorGap: 1.5, gap: 0.05 });
		if (!s) { console.warn('[Realism] Illegal: no spot for a grow-room door at building ' + bi); return; }
		reserve(s.x, s.z, 2, 'grow ' + pid);
		const back = 0.8 + 0.05 - 0.02;
		const door = new THREE.Mesh(new THREE.BoxBufferGeometry(1.2, 2.3, 0.08), new THREE.MeshLambertMaterial({ color: 0x2f4a33 }));
		door.position.set(s.x - Math.sin(s.rot) * back, s.y + 1.15, s.z - Math.cos(s.rot) * back);
		door.rotation.y = s.rot;
		const plate = textPlane('GROW ROOM', 1.1, '#8cff8c', '#10200f');
		plate.position.set(door.position.x + Math.sin(s.rot) * 0.05, s.y + 2.6, door.position.z + Math.cos(s.rot) * 0.05);
		plate.rotation.y = s.rot;
		this.core.w.graphicsWorld.add(door); this.core.w.graphicsWorld.add(plate);
		this.near.add(door, s.x, s.z, 140); this.near.add(plate, s.x, s.z, 70);
		const marker = this.core.marker(s.x, s.y, s.z, '#7dff6a', { radius: 0.8, range: 60, column: false });
		const id = 'grow_' + pid;
		const e: Entrance = { pid: pid, building: bi, site: s, objs: [door, plate, marker], id: id };
		this.entrances.push(e);
		this.core.addBlip('ill_grow_' + pid, { x: s.x, z: s.z, icon: 'warehouse', color: '#7dff6a', label: 'Grow room (' + name + ')', always: true });
		this.core.add({ id: id, x: s.x, y: s.y, z: s.z, r: 2.2, mode: 'foot', items: () => [{ key: 'E', label: 'Enter grow room' }], act: () => this.enter(pid) });
	}

	public st(pid: string): WeedState
	{
		if (!pid) pid = '_none';
		let s: WeedState = this.core.state.weed[pid];
		if (!s)
		{
			s = { tables: Math.max(0, Math.min(this.max, Math.round(this.core.cfg.weed.startTables))), lamps: false, soil: false, autoWater: false, plants: [], harvested: 0 };
			this.core.state.weed[pid] = s;
		}
		while (s.plants.length < this.max) s.plants.push({ p: 0, on: false, water: 0 });
		return s;
	}

	// ------------------------------------------------------------------ room

	private buildRoom(): void
	{
		const core = this.core;
		const room = core.room('grow', 20, 14, 5, { floor: [0.3, 0.3, 0.3], wall: [0.82, 0.82, 0.8], ceil: [0.6, 0.6, 0.6] });
		this.room = room;
		const hw = room.w / 2, hd = room.d / 2;
		room.box(-hw + 0.06, 1.15, 0, 0.1, 2.3, 1.2, [0.18, 0.3, 0.2]);
		room.label('EXIT', -hw + 0.13, 2.6, 0, Math.PI / 2, 0.9, '#7fe08a');
		// grow light rails
		for (let i = 0; i < TABLE_POS.length && i < this.max; i++) room.box(TABLE_POS[i][0], 4.2, TABLE_POS[i][1], 3, 0.08, 0.5, [1, 0.88, 0.6]);
		// terminal + packing table near the door
		room.box(-hw + 0.5, 0.75, -hd + 1.6, 0.6, 1.5, 0.9, [0.2, 0.22, 0.26], true);
		room.box(-hw + 0.82, 1.15, -hd + 1.6, 0.05, 0.45, 0.6, [0.2, 0.7, 0.9]);
		room.label('UPGRADES', -hw + 0.85, 2.3, -hd + 1.6, Math.PI / 2, 1.1, '#8cff8c');
		room.box(-hw + 1.2, 0.45, hd - 1.0, 2.2, 0.9, 1.0, [0.5, 0.42, 0.3], true);
		room.label('PACKING', -hw + 1.2, 2.0, hd - 0.06, Math.PI, 1.1, '#8cff8c');
		// fans + ducting
		room.box(hw - 0.3, 3.6, 0, 0.5, 1.2, 1.2, [0.55, 0.57, 0.6]);
		room.box(0, 4.6, 0, room.w - 2, 0.35, 0.5, [0.65, 0.66, 0.68]);
		room.finish();
		// tables (instanced) + plants (instanced)
		const ta = new GeoAccum();
		const f = new Frame(0, 0, 0, 0);
		boxC(ta, f, 0, 0.82, 0, 3.2, 0.1, 1.4, [0.55, 0.56, 0.58]);
		boxC(ta, f, 0, 0.95, 0, 3.0, 0.16, 1.2, [0.25, 0.17, 0.1]);   // soil tray
		for (let sx = -1; sx <= 1; sx += 2) for (let sz = -1; sz <= 1; sz += 2) boxC(ta, f, sx * 1.5, 0.39, sz * 0.6, 0.08, 0.78, 0.08, [0.4, 0.4, 0.42]);
		const matT = new THREE.MeshLambertMaterial({ vertexColors: THREE.VertexColors, emissive: new THREE.Color(0.15, 0.15, 0.15) });
		this.tableMesh = new THREE.InstancedMesh(ta.toGeometry(), instMatSafe(core.ctx, matT), this.max);
		this.tableMesh.name = 'growTables';
		this.tableMesh.frustumCulled = false;
		room.group.add(this.tableMesh);
		const pa = new GeoAccum();
		cyl(pa, f, 0, 0, 0, 0.9, 0.025, 0.02, 5, [0.2, 0.42, 0.15]);
		for (let k = 0; k < 4; k++) cyl(pa, f, 0, 0.18 + k * 0.2, 0, 0.38, 0.32 - k * 0.06, 0.0, 7, [0.16 + k * 0.03, 0.5 + k * 0.05, 0.14]);
		const matP = new THREE.MeshLambertMaterial({ vertexColors: THREE.VertexColors, emissive: new THREE.Color(0.1, 0.18, 0.08) });
		this.plantMesh = new THREE.InstancedMesh(pa.toGeometry(), instMatSafe(core.ctx, matP), this.max * PLANTS_PER_TABLE);
		this.plantMesh.name = 'growPlants';
		this.plantMesh.frustumCulled = false;
		this.plantMesh.count = 0;
		room.group.add(this.plantMesh);
		// interactables
		const term = room.p(-hw + 1.4, 0, -hd + 1.6);
		core.add({ id: 'grow_terminal', x: term.x, y: term.y, z: term.z, r: 1.6, mode: 'foot', items: () => this.current ? [{ key: 'E', label: 'Grow room upgrades' }] : null, act: () => this.openTerminal() });
		const pk = room.p(-hw + 1.2, 0, hd - 2.0);
		core.add({ id: 'grow_pack', x: pk.x, y: pk.y, z: pk.z, r: 1.6, mode: 'foot', items: () => this.packItems(), act: () => this.pack() });
		const ex = room.p(-hw + 0.9, 0, 0);
		core.add({ id: 'grow_exit', x: ex.x, y: ex.y, z: ex.z, r: 1.6, mode: 'foot', items: () => [{ key: 'E', label: 'Leave grow room' }], act: () => room.leave(true) });
		for (let i = 0; i < this.max; i++)
		{
			const tp = room.p(TABLE_POS[i][0], 0, TABLE_POS[i][1] + (TABLE_POS[i][1] < 0 ? 1.1 : -1.1));
			const idx = i;
			core.add({ id: 'grow_table_' + i, x: tp.x, y: tp.y, z: tp.z, r: 1.4, mode: 'foot', items: () => this.tableItems(idx), act: () => this.tableAct(idx) });
		}
		room.onExit = () => { this.current = null; };
	}

	public enter(pid: string): boolean
	{
		const e = this.entrances.filter((x) => x.pid === pid)[0];
		if (!e || !this.room) return false;
		this.current = pid;
		this.st(pid);
		this.layout();
		const s = e.site;
		const ok = this.room.enter({ x: s.x + Math.sin(s.rot) * 0.6, y: s.y + 1, z: s.z + Math.cos(s.rot) * 0.6, rot: s.rot }, -this.room.w / 2 + 1.6, 0, Math.PI / 2);
		if (!ok) this.current = null;
		return ok;
	}

	/** Places table + plant instances for the current warehouse. */
	public layout(): void
	{
		if (!this.room || !this.tableMesh) return;
		const s = this.st(this.current);
		const r = this.room;
		let n = 0;
		this.tmpQ.set(0, 0, 0, 1);
		for (let i = 0; i < s.tables && i < this.max; i++)
		{
			this.tmpP.set(r.x + TABLE_POS[i][0], r.y, r.z + TABLE_POS[i][1]);
			this.tmpS.set(1, 1, 1);
			this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
			this.tableMesh.setMatrixAt(n++, this.tmpM);
		}
		this.tableMesh.count = n;
		this.tableMesh.instanceMatrix.needsUpdate = true;
		let k = 0;
		for (let i = 0; i < s.tables && i < this.max; i++)
		{
			const pl = s.plants[i];
			if (!pl.on) continue;
			const g = 0.22 + 0.78 * Math.min(1, pl.p);
			const droop = pl.water <= 0 && pl.p < 1 ? 0.75 : 1;
			for (let j = 0; j < PLANTS_PER_TABLE; j++)
			{
				this.tmpP.set(r.x + TABLE_POS[i][0] - 1.1 + j * 0.73, r.y + 1.03, r.z + TABLE_POS[i][1] + (j % 2 ? 0.2 : -0.2));
				this.tmpS.set(g * (0.9 + 0.1 * (j % 2)), g * droop * (pl.p >= 1 ? 1.15 : 1), g);
				this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
				this.plantMesh.setMatrixAt(k++, this.tmpM);
			}
		}
		this.plantMesh.count = k;
		this.plantMesh.instanceMatrix.needsUpdate = true;
	}

	// ------------------------------------------------------------------ actions

	private tableItems(i: number): PromptItem[] | null
	{
		if (!this.current) return null;
		const s = this.st(this.current);
		if (i >= s.tables) return i === s.tables ? [{ key: 'E', label: 'Buy a grow table at the terminal' }] : null;
		const pl = s.plants[i];
		if (!pl.on) return [{ key: 'E', label: this.core.count('starter_pot') > 0 ? 'Plant (1 Starter pot)' : 'Need a Starter pot (Sal)' }];
		if (pl.p >= 1) return [{ key: 'E', label: 'Harvest' }];
		const pct = Math.floor(pl.p * 100);
		if (pl.water < 0.6 && !s.autoWater) return [{ key: 'E', label: 'Water  (' + STAGES[stageOf(pl.p)] + ' ' + pct + '%' + (pl.water <= 0 ? ', dry!' : '') + ')' }];
		return [{ key: 'E', label: STAGES[stageOf(pl.p)] + ' ' + pct + '%' }];
	}

	private tableAct(i: number): void
	{
		const pid = this.current;
		if (!pid) return;
		const s = this.st(pid);
		if (i >= s.tables) return;
		const pl = s.plants[i];
		if (!pl.on) this.plant(pid, i);
		else if (pl.p >= 1) this.harvest(pid, i);
		else if (pl.water < 0.6 && !s.autoWater) this.water(pid, i);
	}

	public plant(pid: string, i: number): boolean
	{
		const s = this.st(pid);
		const pl = s.plants[i];
		if (!pl || i >= s.tables || pl.on) return false;
		if (!this.core.take('starter_pot', 1)) { this.core.toast('You need a Starter pot. Sal sells them.'); return false; }
		pl.on = true; pl.p = 0; pl.water = 1;
		this.core.markDirty();
		if (pid === this.current) this.layout();
		this.core.toast('Planted. Keep it watered.');
		return true;
	}

	public water(pid: string, i: number): boolean
	{
		const s = this.st(pid);
		const pl = s.plants[i];
		if (!pl || !pl.on || pl.p >= 1) return false;
		pl.water = 1;
		this.core.markDirty();
		if (pid === this.current) this.layout();
		return true;
	}

	public harvest(pid: string, i: number): number
	{
		const s = this.st(pid);
		const pl = s.plants[i];
		if (!pl || !pl.on || pl.p < 1) return 0;
		const n = Math.max(1, Math.round(this.core.cfg.weed.baseYield)) + (s.soil ? 2 : 0);
		pl.on = false; pl.p = 0; pl.water = 0;
		s.harvested += n;
		this.core.give('weed_raw', n);
		this.core.markDirty();
		if (pid === this.current) this.layout();
		this.core.toast('Harvested ' + n + ' x Weed (unpackaged). Pack it at the packing table.');
		return n;
	}

	private packItems(): PromptItem[] | null
	{
		if (!this.current) return null;
		const n = this.core.count('weed_raw');
		return n > 0 ? [{ key: 'E', label: 'Package ' + n, hold: 2 }] : [{ key: 'E', label: 'Nothing to package' }];
	}

	public pack(): number
	{
		const n = this.core.count('weed_raw');
		if (n <= 0 || !this.core.take('weed_raw', n)) return 0;
		this.core.give('weed_bag', n);
		this.core.toast('Packed ' + n + ' x Weed (bag). Big Mo buys 10+, Dre buys a few.');
		this.core.save();
		return n;
	}

	public buy(pid: string, what: string): boolean
	{
		const P = this.core.cfg.prices;
		const s = this.st(pid);
		let price = 0;
		if (what === 'table') { if (s.tables >= this.max) return false; price = P.growTable; }
		else if (what === 'lamps') { if (s.lamps) return false; price = P.lampUpgrade; }
		else if (what === 'soil') { if (s.soil) return false; price = P.soilUpgrade; }
		else if (what === 'water') { if (s.autoWater) return false; price = P.waterUpgrade; }
		else return false;
		if (!this.core.pay(price, 'Grow room: ' + what, 'Grow supply')) { this.core.toast('Not enough money (' + money(price) + ').'); return false; }
		if (what === 'table') s.tables++;
		else if (what === 'lamps') s.lamps = true;
		else if (what === 'soil') s.soil = true;
		else s.autoWater = true;
		this.core.markDirty(); this.core.save();
		if (pid === this.current) this.layout();
		return true;
	}

	private openTerminal(): void
	{
		const pid = this.current;
		if (!pid) return;
		const P = this.core.cfg.prices;
		this.core.menu({
			title: 'GROW ROOM UPGRADES', subtitle: 'Card or cash.',
			rows: () =>
			{
				const s = this.st(pid);
				const rows: MenuRow[] = [
					{ label: 'Grow table', detail: s.tables + ' / ' + this.max, right: s.tables >= this.max ? 'max' : money(P.growTable), disabled: s.tables >= this.max, action: () => this.buy(pid, 'table') },
					{ label: 'Grow lamps', detail: 'plants grow 1.5x faster', right: s.lamps ? 'owned' : money(P.lampUpgrade), disabled: s.lamps, action: () => this.buy(pid, 'lamps') },
					{ label: 'Rich soil', detail: '+2 per harvest', right: s.soil ? 'owned' : money(P.soilUpgrade), disabled: s.soil, action: () => this.buy(pid, 'soil') },
					{ label: 'Auto water', detail: 'never dry again', right: s.autoWater ? 'owned' : money(P.waterUpgrade), disabled: s.autoWater, action: () => this.buy(pid, 'water') },
				];
				return rows;
			},
		});
	}

	// ------------------------------------------------------------------ growth

	private grow(dh: number): boolean
	{
		if (dh <= 0) return false;
		const W = this.core.cfg.weed;
		let changed = false;
		const all = this.core.state.weed;
		for (const pid in all)
		{
			if (!all.hasOwnProperty(pid)) continue;
			const s: WeedState = all[pid];
			for (let i = 0; i < s.plants.length && i < s.tables; i++)
			{
				const pl = s.plants[i];
				if (!pl.on || pl.p >= 1) continue;
				if (s.autoWater) pl.water = 1;
				if (pl.water <= 0) continue;
				const before = stageOf(pl.p);
				pl.p = Math.min(1, pl.p + dh / Math.max(0.1, W.growHours) * (s.lamps ? 1.5 : 1));
				pl.water = Math.max(0, pl.water - dh / Math.max(0.1, W.waterHours));
				if (stageOf(pl.p) !== before) changed = true;
				this.core.markDirty();
			}
		}
		return changed;
	}

	public update(dt: number): void
	{
		const changed = this.grow(this.core.dh);
		if (this.room && this.room.inside && this.current)
		{
			this.visAcc += dt;
			if (changed || this.visAcc > 1) { this.visAcc = 0; this.layout(); }
		}
		this.acc += dt;
		if (this.acc < 1) return;
		this.acc = 0;
		this.syncEntrances();
		if (this.core.playerPos(this.tmp)) this.near.update(this.tmp);
	}
}

function stageOf(p: number): number { return p >= 1 ? 3 : p >= 0.6 ? 2 : p >= 0.25 ? 1 : 0; }
