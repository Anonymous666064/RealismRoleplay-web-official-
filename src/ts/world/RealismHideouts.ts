/*
 * RealismHideouts.ts
 * ------------------
 * Secret hideouts (placed at runtime on existing buildings, map generation untouched):
 *
 *   basement   cellar hatch behind a boarded-up house in The Flats      kitchen (Lean), stash, bed
 *   backroom   staff door at the back of a closed downtown shop          kitchen (Lean), stash, bed
 *   container  rusted container door in the Port of Verano yard          lab (Mixing bench / Press / Packaging), stash
 *
 * Each entrance: "[E] Enter <name>" (C7 owner 'illegal'), teleports into a pocket room (RealismIllegalCore);
 * inside, the door marker "[E] Leave" puts you back outside. Stash: store / take illegal items and cash
 * (saved per hideout). Bed: "[E] Rest" adds energy (realismNeeds, C11).
 * Blips (icon 'hideout') appear once discovered (walk within illegal.discoverRange) or once the guide is read.
 * Stations are added by RealismIllegalJobs.ts through slot(hideoutId).
 *
 * config hideouts: { enabled, basement: true, backroom: true, container: true }
 */

import * as THREE from 'three';
import { IllegalCore, PocketRoom, besideBuilding, reserve, textPlane, money, ITEMS, Site, NearSet, mergeCfg, MenuRow } from './RealismIllegalCore';
import { REGIONS } from './RealismMapData';

export const HIDEOUT_DEFAULTS = { enabled: true, basement: true, backroom: true, container: true, bedEnergy: 45 };

export interface Hideout
{
	id: string;
	name: string;
	entrance: Site;            // where you stand outside
	room: PocketRoom;
	exit: { x: number; z: number };   // local, inside
	slots: { x: number; z: number; rot: number; used: boolean }[];
	building: number;
}

export class Hideouts
{
	public list: Hideout[] = [];
	public cfg: any;
	private core: IllegalCore;
	private near = new NearSet();
	private acc = 1;
	private tmp = new THREE.Vector3();

	constructor(core: IllegalCore)
	{
		this.core = core;
		this.cfg = mergeCfg(HIDEOUT_DEFAULTS, (core.ctx.cfg as any).hideouts || ((typeof window !== 'undefined' && (window as any).REALISM_CONFIG) ? (window as any).REALISM_CONFIG.hideouts : null));
		if (!this.cfg.enabled) return;
		if (this.cfg.basement) this.basement();
		if (this.cfg.backroom) this.backroom();
		if (this.cfg.container) this.container();
		core.addUpdater(this);
	}

	public get(id: string): Hideout { for (let i = 0; i < this.list.length; i++) if (this.list[i].id === id) return this.list[i]; return null; }

	/** Next free station slot in a hideout (local coords), or null. */
	public slot(id: string): { x: number; z: number; rot: number } | null
	{
		const h = this.get(id);
		if (!h) return null;
		for (let i = 0; i < h.slots.length; i++) if (!h.slots[i].used) { h.slots[i].used = true; return h.slots[i]; }
		return null;
	}

	// ------------------------------------------------------------------ sites

	private basement(): void
	{
		const ctx = this.core.ctx;
		const bs: any[] = ctx.data.buildings;
		const hood = (ctx.data.hoods || []).filter((h: any) => /flats/i.test(h.name))[0] || (ctx.data.hoods || [])[0];
		if (!hood) return;
		const hx = (hood.x0 + hood.x1) / 2, hz = (hood.z0 + hood.z1) / 2;
		const cand: number[] = [];
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.kind === 'house' && b.boarded && !b.custom && b.x >= hood.x0 && b.x <= hood.x1 && b.z >= hood.z0 && b.z <= hood.z1) cand.push(i);
		}
		cand.sort((a, b) => Math.hypot(bs[a].x - hx, bs[a].z - hz) - Math.hypot(bs[b].x - hx, bs[b].z - hz));
		for (let k = 0; k < cand.length; k++)
		{
			const s = besideBuilding(ctx, cand[k], 1.8, 1.8, { faces: [2, 1, 3], road: 'away', doorGap: 1.6 });
			if (!s) continue;
			reserve(s.x, s.z, 2.5, 'hideout basement');
			// hatch on the ground
			const g = new THREE.Group();
			const frame = new THREE.Mesh(new THREE.BoxBufferGeometry(1.5, 0.12, 1.3), new THREE.MeshLambertMaterial({ color: 0x3b3328 }));
			const lid = new THREE.Mesh(new THREE.BoxBufferGeometry(1.3, 0.08, 1.1), new THREE.MeshLambertMaterial({ color: 0x5a4a35 }));
			frame.position.y = 0.05; lid.position.y = 0.12; lid.rotation.x = -0.05;
			g.add(frame); g.add(lid);
			g.position.set(s.x, s.y, s.z); g.rotation.y = s.rot;
			this.core.w.graphicsWorld.add(g);
			this.near.add(g, s.x, s.z, 120);
			const room = this.core.room('hideout_basement', 14, 10, 3.6, { floor: [0.32, 0.31, 0.29], wall: [0.45, 0.44, 0.41], ceil: [0.3, 0.3, 0.3] });
			this.finishRoom(room, 'basement');
			this.register({ id: 'basement', name: 'The Basement', entrance: s, room: room, exit: { x: -5.6, z: 0 }, building: cand[k],
				slots: [{ x: 2, z: -3.9, rot: 0, used: false }, { x: -1.5, z: -3.9, rot: 0, used: false }, { x: 4.5, z: 3.6, rot: Math.PI, used: false }] }, 'Cellar hatch', 3);
			return;
		}
	}

	private backroom(): void
	{
		const ctx = this.core.ctx;
		const bs: any[] = ctx.data.buildings;
		const dt = REGIONS.downtown;
		const cand: number[] = [];
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.kind === 'shop' && b.closed && !b.custom && b.x >= dt.x0 && b.x <= dt.x1 && b.z >= dt.z0 && b.z <= dt.z1) cand.push(i);
		}
		for (let i = 0; i < bs.length && cand.length === 0; i++) if (bs[i].kind === 'shop' && bs[i].closed && !bs[i].custom) cand.push(i);
		for (let k = 0; k < cand.length; k++)
		{
			const s = besideBuilding(ctx, cand[k], 1.6, 1.4, { faces: [2, 1, 3], road: 'away', doorGap: 2, gap: 0.05 });
			if (!s) continue;
			reserve(s.x, s.z, 2.2, 'hideout backroom');
			// a plain steel door on the back wall
			const door = new THREE.Mesh(new THREE.BoxBufferGeometry(1.1, 2.2, 0.08), new THREE.MeshLambertMaterial({ color: 0x3d4248 }));
			const back = 1.4 / 2 + 0.05 - 0.02;
			door.position.set(s.x - Math.sin(s.rot) * back, s.y + 1.1, s.z - Math.cos(s.rot) * back);
			door.rotation.y = s.rot;
			const plate = textPlane('STAFF ONLY', 0.9, '#d8d8d8', '#202428');
			plate.position.set(door.position.x + Math.sin(s.rot) * 0.05, s.y + 1.7, door.position.z + Math.cos(s.rot) * 0.05);
			plate.rotation.y = s.rot;
			this.core.w.graphicsWorld.add(door); this.core.w.graphicsWorld.add(plate);
			this.near.add(door, s.x, s.z, 140); this.near.add(plate, s.x, s.z, 60);
			const room = this.core.room('hideout_backroom', 12, 9, 3.4, { floor: [0.36, 0.3, 0.26], wall: [0.55, 0.5, 0.44], ceil: [0.4, 0.4, 0.4] });
			this.finishRoom(room, 'backroom');
			this.register({ id: 'backroom', name: 'The Back Room', entrance: s, room: room, exit: { x: -4.8, z: 0 }, building: cand[k],
				slots: [{ x: 1.5, z: -3.4, rot: 0, used: false }, { x: -1.5, z: -3.4, rot: 0, used: false }, { x: 3.8, z: 3.1, rot: Math.PI, used: false }] }, 'Staff door', 2.2);
			return;
		}
	}

	private container(): void
	{
		const ctx = this.core.ctx;
		const bs: any[] = ctx.data.buildings;
		const port = REGIONS.port;
		const cand: number[] = [];
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.kind === 'prop' && b.style === 'steel' && b.h < 3.5 && b.x >= port.x0 && b.x <= port.x1 && b.z >= port.z0 && b.z <= port.z1) cand.push(i);
		}
		// the quietest corner: containers furthest from the warehouses' road side
		cand.sort((a, b) => (bs[b].x + bs[b].z * 0.2) - (bs[a].x + bs[a].z * 0.2));
		for (let k = 0; k < cand.length; k++)
		{
			const b = bs[cand[k]];
			// container doors are on the short end: faces 0 / 2 along its length
			const long = b.d > b.w;
			const s = besideBuilding(ctx, cand[k], 1.6, 1.6, { faces: long ? [0, 2] : [1, 3], road: 'away', doorGap: 1, gap: 0.05 });
			if (!s) continue;
			reserve(s.x, s.z, 2.2, 'hideout container');
			const back = 0.8 + 0.05 - 0.02;
			const door = new THREE.Mesh(new THREE.BoxBufferGeometry(2.2, 2.4, 0.06), new THREE.MeshLambertMaterial({ color: 0x7a3b22 }));
			door.position.set(s.x - Math.sin(s.rot) * back, s.y + 1.25, s.z - Math.cos(s.rot) * back);
			door.rotation.y = s.rot;
			const plate = textPlane('UNIT 7', 0.8, '#e0c060', '#2a1a10');
			plate.position.set(door.position.x + Math.sin(s.rot) * 0.05, s.y + 2.0, door.position.z + Math.cos(s.rot) * 0.05);
			plate.rotation.y = s.rot;
			this.core.w.graphicsWorld.add(door); this.core.w.graphicsWorld.add(plate);
			this.near.add(door, s.x, s.z, 140); this.near.add(plate, s.x, s.z, 60);
			const room = this.core.room('hideout_container', 16, 8, 3.2, { floor: [0.28, 0.3, 0.33], wall: [0.52, 0.32, 0.22], ceil: [0.42, 0.28, 0.2] });
			this.finishRoom(room, 'container');
			this.register({ id: 'container', name: 'Container Lab', entrance: s, room: room, exit: { x: -7.2, z: 0 }, building: cand[k],
				slots: [{ x: -2.5, z: -3.0, rot: 0, used: false }, { x: 1.5, z: -3.0, rot: 0, used: false }, { x: 5.5, z: -3.0, rot: 0, used: false }, { x: 5.5, z: 2.9, rot: Math.PI, used: false }] }, 'Container door', 2.2);
			return;
		}
	}

	/** Shared interior dressing: lamp strips, crates, an exit door, stash + bed. */
	private finishRoom(room: PocketRoom, kind: string): void
	{
		const hw = room.w / 2, hd = room.d / 2;
		// exit door on the -x wall
		room.box(-hw + 0.06, 1.1, 0, 0.1, 2.2, 1.1, [0.25, 0.22, 0.2]);
		room.label('EXIT', -hw + 0.13, 2.5, 0, Math.PI / 2, 0.9, '#7fe08a');
		// ceiling lamps (bright vertex colour, the room material glows a little)
		for (let x = -hw + 3; x < hw - 1; x += 4) room.box(x, room.h - 0.05, 0, 1.4, 0.06, 0.25, [1, 0.97, 0.85]);
		// crates / clutter in the corners
		room.box(-hw + 0.8, 0.45, -hd + 0.8, 0.9, 0.9, 0.9, [0.45, 0.34, 0.2], true);
		room.box(-hw + 0.8, 1.25, -hd + 0.8, 0.7, 0.7, 0.7, [0.5, 0.38, 0.22]);
		room.box(-hw + 1.9, 0.4, -hd + 0.7, 0.8, 0.8, 0.8, [0.42, 0.32, 0.18], true);
		// stash (locker) on the +x wall
		room.box(hw - 0.4, 0.95, -1.2, 0.6, 1.9, 1.2, [0.3, 0.36, 0.33], true);
		room.label('STASH', hw - 0.75, 2.15, -1.2, -Math.PI / 2, 0.9);
		if (kind !== 'container')
		{
			// bed (mattress on the floor) and a table
			room.box(hw - 1.4, 0.18, hd - 1.2, 2.0, 0.36, 1.2, [0.55, 0.52, 0.48], true);
			room.box(hw - 2.3, 0.4, hd - 1.2, 0.3, 0.2, 1.0, [0.8, 0.8, 0.78]);
			room.box(-1, 0.38, 2, 1.4, 0.76, 0.8, [0.36, 0.26, 0.16], true);
		}
		if (kind === 'basement') { room.box(0, 1.6, -hd + 0.15, 1.4, 0.25, 0.3, [0.4, 0.4, 0.42]); }   // pipe run
	}

	private register(h: Hideout, entranceLabel: string, r: number): void
	{
		this.list.push(h);
		const core = this.core;
		const s = h.entrance;
		const blip = 'ill_hideout_' + h.id;
		core.addBlip(blip, { x: s.x, z: s.z, icon: 'hideout', color: '#b58cff', label: h.name });
		core.add({ id: 'enter_' + h.id, x: s.x, y: s.y, z: s.z, r: r, mode: 'foot', blip: blip,
			items: () => [{ key: 'E', label: 'Enter ' + h.name }],
			act: () => this.enter(h.id) });
		const room = h.room;
		const exit = room.p(h.exit.x + 0.8, 0, h.exit.z);
		core.add({ id: 'exit_' + h.id, x: exit.x, y: exit.y, z: exit.z, r: 1.8, mode: 'foot',
			items: () => [{ key: 'E', label: 'Leave (' + entranceLabel.toLowerCase() + ')' }],
			act: () => room.leave(true) });
		const st = room.p(room.w / 2 - 1.1, 0, -1.2);
		core.add({ id: 'stash_' + h.id, x: st.x, y: st.y, z: st.z, r: 1.8, mode: 'foot', items: () => [{ key: 'E', label: 'Stash' }], act: () => this.openStash(h.id) });
		if (h.id !== 'container')
		{
			const bd = room.p(room.w / 2 - 1.4, 0, room.d / 2 - 1.2);
			core.add({ id: 'bed_' + h.id, x: bd.x, y: bd.y, z: bd.z, r: 1.8, mode: 'foot', items: () => [{ key: 'E', label: 'Rest' }], act: () => this.rest() });
		}
	}

	// ------------------------------------------------------------------ actions

	public enter(id: string): boolean
	{
		const h = this.get(id);
		if (!h) return false;
		const s = h.entrance;
		this.core.reveal('ill_hideout_' + h.id);
		return h.room.enter({ x: s.x + Math.sin(s.rot) * 0.6, y: s.y + 1, z: s.z + Math.cos(s.rot) * 0.6, rot: s.rot }, h.exit.x + 1.4, h.exit.z, Math.PI / 2);
	}

	public stash(id: string): { items: { [k: string]: number }; cash: number }
	{
		let s = this.core.state.stash[id];
		if (!s) { s = { items: {}, cash: 0 }; this.core.state.stash[id] = s; }
		return s;
	}

	/** Moves items / cash: dir 'in' (pocket -> stash) or 'out'. qty <= 0 = all. */
	public moveItem(id: string, item: string, dir: string, qty: number): number
	{
		const s = this.stash(id);
		if (dir === 'in')
		{
			const have = this.core.count(item);
			const n = qty > 0 ? Math.min(qty, have) : have;
			if (n <= 0 || !this.core.take(item, n)) return 0;
			s.items[item] = (s.items[item] || 0) + n;
			this.core.markDirty(); this.core.save();
			return n;
		}
		const have = s.items[item] || 0;
		const n = qty > 0 ? Math.min(qty, have) : have;
		if (n <= 0) return 0;
		s.items[item] = have - n;
		if (s.items[item] <= 0) delete s.items[item];
		this.core.give(item, n);
		this.core.markDirty(); this.core.save();
		return n;
	}

	public moveCash(id: string, dir: string, amount: number): number
	{
		const s = this.stash(id);
		if (dir === 'in')
		{
			const n = Math.floor(amount > 0 ? Math.min(amount, this.core.cash()) : this.core.cash());
			if (n <= 0 || !this.core.payCash(n, 'Stashed cash', this.get(id) ? this.get(id).name : 'Stash')) return 0;
			s.cash += n;
			this.core.markDirty(); this.core.save();
			return n;
		}
		const n = Math.floor(amount > 0 ? Math.min(amount, s.cash) : s.cash);
		if (n <= 0) return 0;
		s.cash -= n;
		this.core.earnCash(n, 'Cash from the stash', this.get(id) ? this.get(id).name : 'Stash');
		this.core.markDirty(); this.core.save();
		return n;
	}

	public openStash(id: string): void
	{
		const h = this.get(id);
		if (!h) return;
		this.core.menu({
			title: 'STASH - ' + h.name.toUpperCase(),
			subtitle: 'Stored items stay here. Cash in the stash is safe.',
			rows: () =>
			{
				const s = this.stash(id);
				const rows: MenuRow[] = [];
				for (const it in ITEMS)
				{
					if (!ITEMS.hasOwnProperty(it)) continue;
					const have = this.core.count(it);
					if (have > 0) rows.push({ label: 'Store ' + ITEMS[it].name, right: 'x' + have, action: () => this.moveItem(id, it, 'in', 0) });
				}
				for (const it in s.items)
				{
					if (!s.items.hasOwnProperty(it) || !s.items[it]) continue;
					rows.push({ label: 'Take ' + (ITEMS[it] ? ITEMS[it].name : it), right: 'x' + s.items[it], action: () => this.moveItem(id, it, 'out', 0) });
				}
				const cash = this.core.cash();
				rows.push({ label: 'Store all cash', right: money(cash), disabled: cash <= 0, action: () => this.moveCash(id, 'in', 0) });
				rows.push({ label: 'Take stashed cash', right: money(s.cash), disabled: s.cash <= 0, action: () => this.moveCash(id, 'out', 0) });
				return rows;
			},
		});
	}

	public rested = 0;
	public rest(): void
	{
		this.rested++;
		const n = (this.core.w as any).realismNeeds;
		try { if (n && typeof n.add === 'function') n.add('energy', this.cfg.bedEnergy); } catch (e) { /* ignore */ }
		this.core.toast('You rest for a while. Energy restored.');
	}

	public update(dt: number): void
	{
		this.acc += dt;
		if (this.acc < 0.5) return;
		this.acc = 0;
		if (this.core.playerPos(this.tmp)) this.near.update(this.tmp);
	}

	public describe(): any[]
	{
		return this.list.map((h) => ({ id: h.id, name: h.name, building: h.building, entrance: { x: +h.entrance.x.toFixed(1), z: +h.entrance.z.toFixed(1) }, room: { x: h.room.x, y: h.room.y, z: h.room.z, w: h.room.w, d: h.room.d } }));
	}
}
