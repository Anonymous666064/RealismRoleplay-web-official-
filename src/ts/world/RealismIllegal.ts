/*
 * RealismIllegal.ts
 * -----------------
 * Builds the street-crime side of San Verano County (A17): hotwire (C12), Back Alley Spray / VIN bay /
 * fence, hideouts, the abstract production jobs (Lean, Weed, Coke), nightclubs, guides and blips.
 *
 * Hook (RealismWorldBuilder.ts):  buildIllegal(ctx);
 * Sets (world as any).realismIllegal = { core, hotwire, chop, hideouts, jobs, weed, clubs, stats() }
 *      and (world as any).realismHotwire (C12).
 * Config: realism-config.js sections illegal / clubs / hideouts (defaults in RealismIllegalCore.ts,
 *         RealismClubs.ts, RealismHideouts.ts).
 */

import { RealismCtx } from './RealismContext';
import { IllegalCore, money } from './RealismIllegalCore';
import { Hotwire } from './RealismHotwire';
import { ChopShop } from './RealismChopShop';
import { Hideouts } from './RealismHideouts';
import { IllegalJobs } from './RealismIllegalJobs';
import { WeedGrow } from './RealismIllegalWeed';
import { Clubs } from './RealismClubs';

export function buildIllegal(ctx: RealismCtx): any
{
	const w: any = ctx.world;
	const core = new IllegalCore(ctx);
	if (!core.cfg.enabled)
	{
		const off = { core: core, stats: () => core.stats };
		w.realismIllegal = off;
		return off;
	}
	const part = <T>(name: string, f: () => T): T => { try { return f(); } catch (e) { console.warn('[Realism] illegal: ' + name + ' failed to build', e); return null; } };
	const hotwire = part('hotwire', () => new Hotwire(core));
	const chop = part('chop shop', () => new ChopShop(core));
	const hideouts = part('hideouts', () => new Hideouts(core));
	const jobs = hideouts ? part('jobs', () => new IllegalJobs(core, hideouts)) : null;
	const weed = part('weed', () => new WeedGrow(core));
	const clubs = part('clubs', () => new Clubs(core));
	part('guides', () => addGuides(core, chop, hideouts, jobs, weed, clubs));
	w.registerUpdatable(core);
	const api = {
		core: core,
		hotwire: hotwire ? hotwire.api : null,
		chop: chop ? chop.api : null,
		hideouts: hideouts,
		jobs: jobs ? jobs.api : null,
		weed: weed ? weed.api : null,
		clubs: clubs ? clubs.api : null,
		get heat(): number { return core.heat; },
		stats: () => core.stats,
		revealAll: () => core.revealAll(),
	};
	w.realismIllegal = api;
	console.log('[Realism] Illegal built', {
		spray: chop && chop.spray ? [Math.round(chop.spray.x), Math.round(chop.spray.z)] : null,
		fence: chop && chop.fence ? [Math.round(chop.fence.x), Math.round(chop.fence.z)] : null,
		hideouts: hideouts ? hideouts.list.length : 0,
		contacts: jobs ? jobs.contacts.length : 0,
		clubs: clubs ? clubs.list.length : 0,
	});
	return api;
}

function wp(x: number, z: number, label: string): any { return { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, label: label }; }

/** Guides only explain game mechanics: where to go, prices, heat, timers, keys. */
function addGuides(core: IllegalCore, chop: ChopShop, hideouts: Hideouts, jobs: IllegalJobs, weed: WeedGrow, clubs: Clubs): void
{
	const C = core.cfg, P = C.prices;
	const contact = (id: string) => jobs ? jobs.contact(id) : null;
	const hide = (id: string) => hideouts ? hideouts.get(id) : null;

	if (chop)
	{
		const pts: any[] = [];
		if (chop.spray) pts.push(wp(chop.spray.x, chop.spray.z, 'Back Alley Spray'));
		if (chop.vin) pts.push(wp(chop.vin.x, chop.vin.z, 'VIN bay'));
		if (chop.fence) pts.push(wp(chop.fence.x, chop.fence.z, 'Fence'));
		core.addGuide({
			id: 'illegal_cars', title: 'Stolen cars', icon: 'car',
			summary: 'Hotwire a car, respray it, scratch the VIN and sell it to the fence at the port.',
			steps: [
				'Get into a parked or traffic car you do not own. A hotwire minigame starts: press SPACE or E (or click) while the needle is in the green zone, 3 stages. Nicer cars have smaller zones. Two misses set off the alarm.',
				'A stolen car is "hot" (+' + C.heat.theft + ' heat). Drive into the Back Alley Spray bay, stop, press E, pick a colour: ' + money(C.respray.price) + ' cash. The car is no longer hot.',
				'Drive into the VIN bay next to it and hold E for ' + C.vin.holdSeconds + ' s to scratch the VIN.',
				'Drive into the fence\'s marker at the port and press E. He pays a share of the car\'s value: more when the VIN is scratched, very little for a hot car. Police cars are refused.',
			],
			waypoints: pts,
			reveals: ['ill_spray', 'ill_fence'],
		});
	}
	const sal = contact('supplier'), dre = contact('dealer'), mo = contact('bulk'), cartel = contact('cartel');
	const b = hide('basement'), br = hide('backroom'), ct = hide('container');
	if (jobs)
	{
		const pts: any[] = [];
		if (sal) pts.push(wp(sal.site.x, sal.site.z, 'Sal (supplier)'));
		if (b) pts.push(wp(b.entrance.x, b.entrance.z, 'The Basement (kitchen)'));
		if (br) pts.push(wp(br.entrance.x, br.entrance.z, 'The Back Room (kitchen)'));
		if (dre) pts.push(wp(dre.site.x, dre.site.z, 'Dre (dealer)'));
		core.addGuide({
			id: 'illegal_lean', title: 'Lean', icon: 'cup',
			summary: 'Buy Supplies from Sal, make Lean (cups) at a hideout kitchen, sell to Dre.',
			steps: [
				'Buy Supplies from Sal in Harbor Row (' + money(P.supplies) + ' each, cash).',
				'At a hideout KITCHEN press E: a batch uses ' + C.lean.suppliesPerBatch + ' Supplies. Hit SPACE or E in the green zone for 3 stages (about ' + C.lean.seconds + ' s). Every hit adds a cup; 3 misses ruin the batch.',
				'Sell cups to Dre in Hillcrest Projects (' + money(P.dealer.lean_cup) + ' each, up to ' + C.dealerMaxPerHour + ' units per game hour). He will not deal while your heat is 80 or more.',
				'Every sale has a chance of being seen (heat). Heat cools down over time.',
			],
			waypoints: pts,
			reveals: ['ill_supplier', 'ill_dealer', 'ill_hideout_basement', 'ill_hideout_backroom'],
		});
		const cpts: any[] = [];
		if (sal) cpts.push(wp(sal.site.x, sal.site.z, 'Sal (supplier)'));
		if (ct) cpts.push(wp(ct.entrance.x, ct.entrance.z, 'Container Lab'));
		if (cartel) cpts.push(wp(cartel.site.x, cartel.site.z, 'Cartel buyer (night)'));
		core.addGuide({
			id: 'illegal_coke', title: 'Coke', icon: 'brick',
			summary: 'Buy a Lab kit, run the three lab stations in the Container Lab, sell bricks at the port at night.',
			steps: [
				'Buy a Lab kit from Sal (' + money(P.lab_kit) + ').',
				'Container Lab, MIXING BENCH: E starts a timing minigame (3 stages) -> Batch tray. No misses = a bonus brick.',
				'PRESS: hold E for ' + C.coke.pressHold + ' s -> Pressed block.',
				'PACKAGING: E starts a ' + C.coke.packSeconds + ' s timer; come back and press E to collect ' + C.coke.bricksPerBatch + ' Coke (brick).',
				'Sell bricks to the cartel buyer by the water at the port, only from ' + C.cartelHours[0] + ':00 to ' + C.cartelHours[1] + ':00 (' + money(P.cartel.coke_brick) + ' each).',
			],
			waypoints: cpts,
			reveals: ['ill_supplier', 'ill_cartel', 'ill_hideout_container'],
		});
	}
	if (weed)
	{
		const pts: any[] = [];
		if (sal) pts.push(wp(sal.site.x, sal.site.z, 'Sal (Starter pots)'));
		for (let i = 0; i < weed.entrances.length; i++) pts.push(wp(weed.entrances[i].site.x, weed.entrances[i].site.z, 'Your grow room'));
		if (mo) pts.push(wp(mo.site.x, mo.site.z, 'Big Mo (bulk buyer)'));
		if (dre) pts.push(wp(dre.site.x, dre.site.z, 'Dre (dealer)'));
		core.addGuide({
			id: 'illegal_weed', title: 'Weed grow room', icon: 'leaf',
			summary: 'Own a warehouse (buy one on SV Realty), grow in its grow room, sell bags in bulk to Big Mo.',
			steps: [
				'You need a warehouse: buy one on SV Realty (laptop or phone). A GROW ROOM door then appears beside it.',
				'Buy Starter pots from Sal (' + money(P.starter_pot) + '). At a table press E to plant.',
				'Plants grow over ' + C.weed.growHours + ' game hours (Seedling, Growing, Flowering, Ready) but only while watered: press E to water every ' + C.weed.waterHours + ' game hours.',
				'Terminal upgrades: more tables (' + money(P.growTable) + '), grow lamps 1.5x faster (' + money(P.lampUpgrade) + '), rich soil +2 per harvest (' + money(P.soilUpgrade) + '), auto water (' + money(P.waterUpgrade) + ').',
				'Harvest (E), then hold E at the packing table to bag it. Big Mo in The Flats buys ' + C.bulkMin + '+ bags (' + money(P.bulk.weed_bag) + ' each); Dre buys a few (' + money(P.dealer.weed_bag) + ').',
			],
			waypoints: pts,
			reveals: ['ill_supplier', 'ill_bulk', 'ill_dealer'],
		});
	}
	if (hideouts && hideouts.list.length)
	{
		core.addGuide({
			id: 'illegal_hideouts', title: 'Hideouts', icon: 'hideout',
			summary: 'Secret places with kitchens, a lab, a stash and a bed.',
			steps: [
				'Walk up to an entrance and press E to go in; press E at the EXIT to leave.',
				'STASH: store items and cash. Cash in a stash is kept safe.',
				'Bed (E): rest to restore energy.',
			],
			waypoints: hideouts.list.map((h) => wp(h.entrance.x, h.entrance.z, h.name)),
			reveals: hideouts.list.map((h) => 'ill_hideout_' + h.id),
		});
	}
	if (clubs && clubs.list.length)
	{
		const cf = clubs.cfg;
		core.addGuide({
			id: 'clubs', title: 'Nightclubs', icon: 'club', category: 'nightlife',
			summary: clubs.list.map((c) => c.name).join(' and ') + ' downtown, open ' + cf.openHours[0] + ':00 to ' + cf.openHours[1] + ':00.',
			steps: [
				'Entry ' + money(cf.entryFee) + ' (once per night). Press E at the door.',
				'Bar (E): drinks restore thirst.',
			],
			waypoints: clubs.list.map((c) => wp(c.site.x, c.site.z, c.name)),
			reveals: [],
		});
	}
}
