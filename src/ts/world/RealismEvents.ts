/*
 * RealismEvents.ts
 * ----------------
 * C14: a tiny event bus shared by every Realism system.
 *
 *   (world as any).realismEvents = {
 *       on(name: string, cb: (data: any) => void): void;
 *       off(name: string, cb: (data: any) => void): void;
 *       emit(name: string, data?: any): void;
 *   }
 *
 * ensureEvents(world) creates it once (or returns the one another system already made), so it is
 * safe to call from anywhere, in any order. A listener that throws is logged and skipped; the
 * other listeners still run. Listeners added / removed while an event is being emitted take
 * effect from the next emit.
 *
 * Known events: 'carStolen' {car, record}, 'propertyBought' {id}, 'jobCompleted' {job, pay},
 * 'needLow' {name}, 'crime' {kind, position}; from the GPS (RealismGPS.ts): 'waypointSet'
 * {x, z, label}, 'waypointCleared' {}, 'waypointArrived' {x, z, label}.
 */

export interface RealismEventBus
{
	on(name: string, cb: (data: any) => void): void;
	off(name: string, cb: (data: any) => void): void;
	emit(name: string, data?: any): void;
}

export function ensureEvents(world: any): RealismEventBus
{
	const w: any = world;
	const have = w.realismEvents;
	if (have && typeof have.on === 'function' && typeof have.emit === 'function') return have;
	const listeners: { [name: string]: ((data: any) => void)[] } = {};
	const bus: RealismEventBus = {
		on(name: string, cb: (data: any) => void): void
		{
			if (typeof cb !== 'function' || !name) return;
			const list = listeners[name] || (listeners[name] = []);
			if (list.indexOf(cb) < 0) list.push(cb);
		},
		off(name: string, cb: (data: any) => void): void
		{
			const list = listeners[name];
			if (!list) return;
			const i = list.indexOf(cb);
			if (i >= 0) list.splice(i, 1);
		},
		emit(name: string, data?: any): void
		{
			const list = listeners[name];
			if (!list || list.length === 0) return;
			const copy = list.slice();
			for (let i = 0; i < copy.length; i++)
			{
				try { copy[i](data); }
				catch (e) { console.warn('[Realism] event listener for "' + name + '" failed', e); }
			}
		},
	};
	w.realismEvents = bus;
	return bus;
}
