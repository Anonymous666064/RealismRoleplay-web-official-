/*
 * RealismRoomLights.ts
 * --------------------
 * Per-room light switches (A14). Lamps of all rooms share instanced meshes, so a room is switched off by
 * drawing its lamp-glow instances collapsed (zero size) in the meshes that already exist: no new meshes,
 * materials or draw calls.
 *
 *  - Houses / city interiors: AssetInstancer.setRoomLight(room, on) (ceiling light, floor lamps and
 *    nightstand lamps of that room).
 *  - Hotel rooms: Hotel.lightsOff[roomNumber] read by HotelRuntime when it places the room kits.
 *  - The room's light spot (ctx.lightSpots, used by RealismPerformance's pooled point lights) is moved far
 *    below the world while off, so no pooled light picks it; its height is put back when switched on.
 *
 * Room keys: houses plan * 64 + room index; hotel rooms 1e7 + hotel * 1e5 + room number.
 * All rooms start with the lights on (nothing is saved).
 */

import { RealismCtx } from './RealismContext';

const OFF_Y = -100000;

export class RoomLights
{
	private ctx: RealismCtx;
	private furniture: any;
	private off: { [room: number]: boolean } = {};
	private spots: { [room: number]: number[] } = {};
	private savedY: { [spot: number]: number } = {};
	public toggles = 0;

	constructor(ctx: RealismCtx, store: any, furniture: any)
	{
		this.ctx = ctx;
		this.furniture = furniture;
		// hotel rooms registered their spot index directly
		for (let i = 0; i < store.roomSpots.length; i++) this.addSpot(store.roomSpots[i].room, store.roomSpots[i].spot);
		// house rooms: match the ceiling light of the room with the light spot 0.24 m under the ceiling
		const spots = ctx.lightSpots;
		const hash: { [k: string]: number[] } = {};
		for (let i = 0; i < spots.length; i++)
		{
			const k = Math.round(spots[i].x * 2) + ',' + Math.round(spots[i].z * 2);
			(hash[k] || (hash[k] = [])).push(i);
		}
		for (let i = 0; i < store.roomCeil.length; i++)
		{
			const c = store.roomCeil[i];
			if (c.room < 0) continue;
			const bx = Math.round(c.x * 2), bz = Math.round(c.z * 2);
			let found = -1;
			for (let dx = -1; dx <= 1 && found < 0; dx++)
				for (let dz = -1; dz <= 1 && found < 0; dz++)
				{
					const l = hash[(bx + dx) + ',' + (bz + dz)];
					if (!l) continue;
					for (let j = 0; j < l.length; j++)
					{
						const s = spots[l[j]];
						if (Math.abs(s.x - c.x) < 0.3 && Math.abs(s.z - c.z) < 0.3 && Math.abs(s.y - c.y) < 0.6) { found = l[j]; break; }
					}
				}
			if (found >= 0) this.addSpot(c.room, found);
		}
	}

	private addSpot(room: number, spot: number): void
	{
		if (!(spot >= 0)) return;
		const l = this.spots[room] || (this.spots[room] = []);
		if (l.indexOf(spot) < 0) l.push(spot);
	}

	public isOn(room: number): boolean { return this.off[room] !== true; }

	public toggle(room: number): boolean
	{
		this.set(room, !this.isOn(room));
		return this.isOn(room);
	}

	public set(room: number, on: boolean): void
	{
		if (room === undefined || room === null || room < 0) return;
		if (this.isOn(room) === on) return;
		this.toggles++;
		if (on) delete this.off[room]; else this.off[room] = true;
		// pooled point light
		const l = this.spots[room];
		if (l)
		{
			for (let i = 0; i < l.length; i++)
			{
				const s = this.ctx.lightSpots[l[i]];
				if (!s) continue;
				if (!on) { if (s.y > OFF_Y / 2) { this.savedY[l[i]] = s.y; s.y = OFF_Y; } }
				else if (this.savedY[l[i]] !== undefined) { s.y = this.savedY[l[i]]; delete this.savedY[l[i]]; }
			}
			const perf = (this.ctx.world as any).realismPerformance;
			if (perf && typeof perf.placeLights === 'function') { try { perf.placeLights(); } catch (e) { /* next tick places them */ } }
		}
		// lamp glow
		if (room >= 1e7)
		{
			const hb = (this.ctx.world as any).realismHotels;
			const hi = Math.floor((room - 1e7) / 1e5), num = (room - 1e7) % 1e5;
			const h = hb && hb.hotels ? hb.hotels[hi] : null;
			if (h)
			{
				if (!h.lightsOff) h.lightsOff = {};
				if (on) delete h.lightsOff[num]; else h.lightsOff[num] = true;
				h.key = '';   // HotelRuntime re-places the kits on its next tick
				if (hb.runtime && typeof hb.runtime.tick === 'function') hb.runtime.tick();
			}
		}
		else if (this.furniture && typeof this.furniture.setRoomLight === 'function') this.furniture.setRoomLight(room, on);
	}

	/** Light spot indices of a room (tests). */
	public spotsOf(room: number): number[] { return this.spots[room] || []; }
}
