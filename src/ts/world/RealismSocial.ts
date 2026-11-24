/*
 * RealismSocial.ts  (A15)
 * -----------------------
 * The county's social media: NPC accounts, Chirp posts (text), Snapgram posts (procedural photos),
 * ViewTube videos (procedural canvas videos, drawn by RealismInternetMedia.ts) and the player's own
 * posts / likes. Content is generated over GAME time by the internet clock (RealismLaptop.ts):
 * a Chirp roughly every 10 game minutes, a Snap every ~40, a video every ~2 game hours, plus reactions
 * to realismEvents ('crime', 'carStolen', 'propertyBought') and car purchases. Saved in localStorage
 * 'realism.social.v1' (capped). Costs nothing per frame: tick() runs on game-minute boundaries only.
 *
 * (world as any).realismSocial = this object: accounts, chirps, snaps, videos, post(text), like(kind, id), ...
 *
 * Config (realism-config.js -> social, all optional):
 *   playerName: 'Riley'    your display name     playerHandle: 'riley'
 *   chirpEvery: 10         game minutes between NPC chirps (average)
 *   snapEvery: 40          game minutes between NPC snaps
 *   videoEvery: 120        game minutes between new videos
 *   maxChirps: 150, maxSnaps: 60, maxVideos: 40    storage caps (your own posts are kept first)
 */

import { RealismCtx } from './RealismContext';
import { mulberry32 } from './RealismMapData';

export const SOCIAL_KEY = 'realism.social.v1';

export interface Account { h: string; n: string; hue: number; bio: string; ch?: string; npc: boolean; }
export interface Comment { h: string; text: string; t: number; }
export interface Chirp { id: string; h: string; text: string; t: number; likes: number; rt: number; liked?: boolean; comments: Comment[]; cc: number; pending?: number[]; player?: boolean; tag?: string; }
export interface Snap { id: string; h: string; kind: string; seed: number; caption: string; t: number; likes: number; liked?: boolean; player?: boolean; hour: number; }
export interface Video { id: string; h: string; title: string; kind: string; dur: number; views: number; likes: number; seed: number; t: number; liked?: boolean; extra?: string; }

export interface SocialSettings
{
	playerName: string; playerHandle: string;
	chirpEvery: number; snapEvery: number; videoEvery: number;
	maxChirps: number; maxSnaps: number; maxVideos: number;
}

function num(v: any, d: number, lo: number, hi: number): number
{
	const n = typeof v === 'number' && isFinite(v) ? v : d;
	return Math.max(lo, Math.min(hi, n));
}

export function socialSettings(cfg: any): SocialSettings
{
	const raw: any = (cfg && cfg.social) || {};
	const name = typeof raw.playerName === 'string' && raw.playerName.trim() ? raw.playerName.trim().slice(0, 24) : 'Riley';
	let handle = typeof raw.playerHandle === 'string' && raw.playerHandle.trim() ? raw.playerHandle.trim() : name;
	handle = handle.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'me';
	return {
		playerName: name, playerHandle: handle,
		chirpEvery: num(raw.chirpEvery, 10, 1, 1440), snapEvery: num(raw.snapEvery, 40, 2, 2880), videoEvery: num(raw.videoEvery, 120, 5, 5760),
		maxChirps: Math.round(num(raw.maxChirps, 150, 20, 1000)), maxSnaps: Math.round(num(raw.maxSnaps, 60, 10, 400)), maxVideos: Math.round(num(raw.maxVideos, 40, 10, 200)),
	};
}

const FIRST = ['Mia', 'Jayden', 'Rosa', 'Marcus', 'Ava', 'Diego', 'Kayla', 'Tyrell', 'Sofia', 'Ethan', 'Imani', 'Luis', 'Chloe', 'Darnell', 'Nina',
	'Omar', 'Bella', 'Trey', 'Lucia', 'Kevin', 'Zoe', 'Andre', 'Hailey', 'Malik', 'Grace', 'Carlos', 'Jade', 'Devin', 'Priya', 'Jamal', 'Elena', 'Noah', 'Tasha', 'Victor'];
const LAST = ['Reyes', 'Johnson', 'Nguyen', 'Carter', 'Lopez', 'Brooks', 'Kim', 'Washington', 'Silva', 'Patel', 'Morgan', 'Hayes', 'Rivera', 'Foster',
	'Ortiz', 'Bennett', 'Coleman', 'Diaz', 'Hughes', 'Price', 'Ramos', 'Jenkins', 'Flores', 'Ward'];
const BIOS = ['coffee first.', 'San Verano born & raised', 'just vibes', 'car guy. no I won\'t race you.', 'living my best life on the coast', 'night shift survivor',
	'foodie | beach | repeat', 'Hillcrest > everywhere', 'I post traffic updates nobody asked for', 'photographer (amateur)', 'gym. work. sleep.', 'Lake Verano weekends',
	'student @ county college', 'real estate is my love language', 'lo-fi and long drives'];

interface ChannelDef { h: string; n: string; kind: string; bio: string; }
const CHANNELS: ChannelDef[] = [
	{ h: 'veranoautoreview', n: 'Verano Auto Review', kind: 'carReview', bio: 'Honest reviews of every car in the county.' },
	{ h: 'mia_vlogs', n: 'Mia Vlogs', kind: 'vlog', bio: 'Daily vlogs from San Verano.' },
	{ h: 'svtimelapse', n: 'SV Timelapse', kind: 'timelapse', bio: 'The county from above, sped up.' },
	{ h: 'chefrosa', n: 'Chef Rosa Cooks', kind: 'cooking', bio: 'Quick recipes from my Downtown kitchen.' },
	{ h: 'lofiverano', n: 'LoFi Verano', kind: 'music', bio: 'Beats to drive the coast to.' },
	{ h: 'streetwheels', n: 'Street Wheels SV', kind: 'carReview', bio: 'Cars, meets, top speed runs.' },
	{ h: 'jayden_daily', n: 'Jayden Daily', kind: 'vlog', bio: 'pranks, food, and the Flats.' },
];

export class RealismSocial
{
	public settings: SocialSettings;
	public accounts: Account[] = [];
	public byHandle: { [h: string]: Account } = {};
	public chirps: Chirp[] = [];      // newest first
	public snaps: Snap[] = [];
	public videos: Video[] = [];
	public minutes = 0;               // absolute game minutes (the internet clock)
	public generated = { chirps: 0, snaps: 0, videos: 0, reactions: 0 };
	public player: Account;
	private ctx: RealismCtx;
	private world: any;
	private rnd: () => number;
	private nextId = 1;
	private nextChirp = 0;
	private nextSnap = 0;
	private nextVideo = 0;
	private lastCrimePost = -1e9;
	private listeners: (() => void)[] = [];
	private places: string[] = [];
	private roads: string[] = [];
	private hotels: string[] = [];
	private hoods: string[] = [];
	private dirty = false;
	/** Car names for reviews (set by the laptop from the dealership catalogue). */
	public carNames: string[] = ['Verano Sedan', 'Verano Sedan LX', 'Verano Sedan Sport'];

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		this.settings = socialSettings(ctx.cfg);
		this.rnd = mulberry32((ctx.data.seed * 7919 + 4242) >>> 0);
		this.buildPlaces();
		this.buildAccounts();
		if (!this.load()) this.seed();
		this.scheduleAll();
	}

	// ------------------------------------------------------------------ setup

	private buildPlaces(): void
	{
		const d: any = this.ctx.data;
		const lm: any[] = d.landmarks || [];
		for (let i = 0; i < lm.length; i++) if (lm[i].kind !== 'water' || /Lake/.test(lm[i].name)) this.places.push(String(lm[i].name).replace(/\s*\(.*\)$/, ''));
		const seen: { [n: string]: boolean } = {};
		const roads: any[] = d.roads || [];
		for (let i = 0; i < roads.length; i++)
		{
			const r = roads[i];
			if (!r.name || seen[r.name] || !/avenue|highway|street/.test(r.kind)) continue;
			seen[r.name] = true;
			this.roads.push(r.name);
		}
		const bl: any[] = d.buildings || [];
		for (let i = 0; i < bl.length; i++) if (bl[i].custom === 'hotel' && bl[i].label) this.hotels.push(titleCase(bl[i].label));
		const hoods: any[] = d.hoods || [];
		for (let i = 0; i < hoods.length; i++) this.hoods.push(hoods[i].name);
		if (!this.places.length) this.places.push('Downtown');
		if (!this.roads.length) this.roads.push('Grand Avenue');
		if (!this.hotels.length) this.hotels.push('The Grand Verano');
		if (!this.hoods.length) this.hoods.push('The Flats');
	}

	private buildAccounts(): void
	{
		const r = mulberry32((this.ctx.data.seed * 31 + 17) >>> 0);
		const used: { [h: string]: boolean } = {};
		for (let i = 0; i < 40; i++)
		{
			const f = FIRST[Math.floor(r() * FIRST.length)], l = LAST[Math.floor(r() * LAST.length)];
			const style = Math.floor(r() * 4);
			let h = style === 0 ? (f + '_' + l).toLowerCase() : style === 1 ? (f.toLowerCase() + Math.floor(r() * 99)) : style === 2 ? ('sv' + f.toLowerCase()) : (f.charAt(0) + l).toLowerCase() + '_';
			while (used[h]) h += Math.floor(r() * 9);
			used[h] = true;
			this.addAccount({ h: h, n: f + ' ' + l, hue: Math.floor(r() * 360), bio: BIOS[Math.floor(r() * BIOS.length)], npc: true });
		}
		const news: Account[] = [
			{ h: 'svpd_news', n: 'San Verano PD', hue: 220, bio: 'Official account. Do not report crimes here, call 911.', npc: true },
			{ h: 'veranotraffic', n: 'Verano Traffic', hue: 30, bio: 'Live traffic for San Verano County.', npc: true },
			{ h: 'svrealty', n: 'SV Realty', hue: 140, bio: 'Homes, hotels and everything in between. svrealty.sv', npc: true },
			{ h: 'veranomotors', n: 'Verano Motors', hue: 0, bio: 'Drive home today. veranomotors.sv', npc: true },
		];
		for (let i = 0; i < news.length; i++) this.addAccount(news[i]);
		for (let i = 0; i < CHANNELS.length; i++) this.addAccount({ h: CHANNELS[i].h, n: CHANNELS[i].n, hue: (i * 53 + 11) % 360, bio: CHANNELS[i].bio, ch: CHANNELS[i].kind, npc: true });
		this.player = { h: this.settings.playerHandle, n: this.settings.playerName, hue: 195, bio: 'That\'s you.', npc: false };
		this.byHandle[this.player.h] = this.player;
	}

	private addAccount(a: Account): void
	{
		if (this.byHandle[a.h]) return;
		this.accounts.push(a);
		this.byHandle[a.h] = a;
	}

	public account(h: string): Account
	{
		return this.byHandle[h] || { h: h, n: h, hue: 0, bio: '', npc: true };
	}

	private people(): Account[] { return this.accounts.filter((a) => !a.ch && !/^(svpd_news|veranotraffic|svrealty|veranomotors)$/.test(a.h)); }

	private pick<T>(a: T[]): T { return a[Math.floor(this.rnd() * a.length)]; }

	/** Fresh install: a backdated feed so the sites are not empty. */
	private seed(): void
	{
		this.minutes = this.clockFromWorld(0);
		const t0 = this.minutes;
		for (let i = 0; i < 24; i++) this.addChirp(this.npcChirp(t0 - (24 - i) * 17), true);
		for (let i = 0; i < 12; i++) this.addSnap(this.npcSnap(t0 - (12 - i) * 55), true);
		for (let i = 0; i < 12; i++) this.addVideo(this.npcVideo(t0 - (12 - i) * 140), true);
		this.dirty = true;
	}

	/** The internet clock lined itself up with the game clock: move "now" and reschedule. */
	public setClock(minutes: number): void
	{
		if (!isFinite(minutes)) return;
		this.minutes = minutes;
		this.scheduleAll();
	}

	private scheduleAll(): void
	{
		this.nextChirp = this.minutes + this.gap(this.settings.chirpEvery);
		this.nextSnap = this.minutes + this.gap(this.settings.snapEvery);
		this.nextVideo = this.minutes + this.gap(this.settings.videoEvery);
	}

	private gap(avg: number): number { return Math.max(1, avg * (0.5 + this.rnd())); }

	public clockFromWorld(prev: number): number
	{
		const t = this.world.realismTime;
		const h = t && isFinite(t.hour) ? t.hour : 12;
		const day = Math.floor(prev / 1440);
		let m = day * 1440 + h * 60;
		if (m < prev) m += 1440;
		return m;
	}

	// ------------------------------------------------------------------ clock

	/** Called by the internet clock with the new absolute game minute. Generates due content. */
	public tick(minutes: number): void
	{
		if (!(minutes > this.minutes)) return;
		this.minutes = minutes;
		let budget = 4;   // a long sleep / time skip never floods the feed
		while (this.nextChirp <= minutes && budget-- > 0) { this.addChirp(this.npcChirp(this.nextChirp)); this.nextChirp += this.gap(this.settings.chirpEvery); }
		if (this.nextChirp <= minutes) this.nextChirp = minutes + this.gap(this.settings.chirpEvery);
		if (this.nextSnap <= minutes) { this.addSnap(this.npcSnap(minutes)); this.nextSnap = minutes + this.gap(this.settings.snapEvery); }
		if (this.nextVideo <= minutes) { this.addVideo(this.npcVideo(minutes)); this.nextVideo = minutes + this.gap(this.settings.videoEvery); }
		// replies to the player's posts
		for (let i = 0; i < this.chirps.length; i++)
		{
			const c = this.chirps[i];
			if (!c.pending || !c.pending.length) continue;
			while (c.pending.length && c.pending[0] <= minutes)
			{
				const at = c.pending.shift();
				c.comments.push({ h: this.pick(this.people()).h, text: this.reply(c.text), t: at });
				c.cc++;
				c.likes += 1 + Math.floor(this.rnd() * 4);
				this.dirty = true;
			}
		}
		if (this.dirty) { this.dirty = false; this.save(); this.changed(); }
	}

	// ------------------------------------------------------------------ generators

	private timeOfDay(min: number): string
	{
		const h = ((min / 60) % 24 + 24) % 24;
		return h < 5 ? 'night' : h < 11 ? 'morning' : h < 17 ? 'day' : h < 21 ? 'evening' : 'night';
	}

	private fill(s: string): string
	{
		return s.replace(/\{place\}/g, () => this.pick(this.places)).replace(/\{road\}/g, () => this.pick(this.roads))
			.replace(/\{hotel\}/g, () => this.pick(this.hotels)).replace(/\{hood\}/g, () => this.pick(this.hoods))
			.replace(/\{car\}/g, () => this.pick(this.carNames)).replace(/\{n\}/g, () => String(2 + Math.floor(this.rnd() * 30)));
	}

	private npcChirp(t: number): Chirp
	{
		const tod = this.timeOfDay(t);
		const T: { [k: string]: string[] } = {
			morning: ['Coffee + {road} traffic = my whole personality', 'Morning fog rolling over {place} this morning', 'Why is {road} already backed up at this hour',
				'Early gym, then breakfast near {place}. productive king', 'Sun\'s out in San Verano. Beach later?', 'Bus driver on {road} waved at me. Day made.'],
			day: ['Lunch rush at {place} is no joke', 'Who keeps parking in two spots by {place}', 'Saw the nicest {car} on {road} just now', 'Hot one today. {place} is packed',
				'Thinking about buying a place in {hood}... thoughts?', 'Room service at {hotel} hits different', 'The pier is beautiful today ngl'],
			evening: ['Sunset from {place} right now. No filter needed', 'Traffic on {road} heading home is crazy', 'Dinner downtown, then a drive along the coast',
				'{hotel} lit up at sunset looks unreal', 'Who\'s going out tonight?', 'The street lights on {road} just flicked on. cozy'],
			night: ['Can\'t sleep. {place} is so quiet right now', 'Late night drive down {road}, empty roads hit different', 'Night shift again. Send snacks',
				'Heard sirens over by {hood} again', '3 am thoughts: why is gas so expensive in this county', 'Stars over Lake Verano tonight'],
		};
		let text = this.fill(this.pick(T[tod]));
		let h = this.pick(this.people()).h;
		const traffic = this.world.realismTraffic;
		const roll = this.rnd();
		if (roll < 0.12) { h = 'veranotraffic'; text = this.fill('Heavy traffic on {road}' + (traffic && traffic.stats ? ', ' + Math.max(3, Math.round((traffic.stats.cars || 10) / 3)) + ' cars backed up' : '') + '. Expect delays.'); }
		else if (roll < 0.17) { h = 'svrealty'; text = this.fill('New listing near {place}! Browse homes, motels and hotels on svrealty.sv'); }
		else if (roll < 0.21) { h = 'veranomotors'; text = this.fill('The {car} is in stock at Verano Motors. Drive home today: veranomotors.sv'); }
		return this.mkChirp(h, text, t);
	}

	private mkChirp(h: string, text: string, t: number): Chirp
	{
		const pop = this.rnd();
		return { id: 'c' + (this.nextId++), h: h, text: text, t: t, likes: Math.floor(pop * pop * 400), rt: Math.floor(pop * pop * 60), comments: [], cc: Math.floor(pop * 25) };
	}

	private npcSnap(t: number): Snap
	{
		const tod = this.timeOfDay(t);
		const kinds = tod === 'evening' ? ['sunset', 'sunset', 'skyline', 'beach', 'food', 'car'] : tod === 'night' ? ['skyline', 'skyline', 'car', 'food'] : ['beach', 'food', 'car', 'park', 'skyline'];
		const kind = this.pick(kinds);
		const CAP: { [k: string]: string[] } = {
			sunset: ['golden hour at {place}', 'this sunset tho', 'Pacific sunsets > everything'],
			skyline: ['downtown never sleeps', 'view from the top of {hotel}', 'city lights'],
			beach: ['beach day at Verano Pier', 'sand in my shoes, no regrets', 'salt air'],
			food: ['brunch near {place}', 'tacos from the place on {road}', 'Chef Rosa recipe attempt #3'],
			car: ['new whip who dis ({car})', 'spotted on {road}', 'washed and waxed'],
			park: ['lunch break at Central Park', 'dog walk by {place}', 'touching grass'],
		};
		const pop = this.rnd();
		return { id: 's' + (this.nextId++), h: this.pick(this.people()).h, kind: kind, seed: Math.floor(this.rnd() * 1e9), caption: this.fill(this.pick(CAP[kind])), t: t, likes: Math.floor(pop * pop * 900), hour: ((t / 60) % 24 + 24) % 24 };
	}

	private npcVideo(t: number): Video
	{
		const ch = this.pick(CHANNELS);
		const TT: { [k: string]: string[] } = {
			carReview: ['{car} Review: worth the money?', '{car} top speed run on {road}', 'I bought a {car}... here\'s the truth', '{car} vs the potholes of {hood}'],
			vlog: ['A day in {hood}', 'I stayed at {hotel} for 24 hours', 'Exploring {place}', 'Driving every road in San Verano (part {n})'],
			timelapse: ['San Verano 24h timelapse', 'County traffic from above (timelapse)', 'Sunrise to sunset over the county'],
			cooking: ['5-minute Verano tacos', 'Pier Cafe pancakes at home', 'Chef Rosa\'s late-night noodles', 'Lunchbox ideas ({n} min)'],
			music: ['lofi beats to drive down {road} to', 'Verano Nights (visualiser)', 'coastal chill mix vol. {n}'],
		};
		const title = this.fill(this.pick(TT[ch.kind]));
		const pop = this.rnd();
		let extra = '';
		if (ch.kind === 'carReview') { for (let i = 0; i < this.carNames.length; i++) if (title.indexOf(this.carNames[i]) >= 0 && this.carNames[i].length > extra.length) extra = this.carNames[i]; }
		return { id: 'v' + (this.nextId++), h: ch.h, title: title, kind: ch.kind, dur: 10 + Math.floor(this.rnd() * 21), views: Math.floor(pop * pop * 250000) + 40, likes: Math.floor(pop * pop * 9000), seed: Math.floor(this.rnd() * 1e9), t: t, extra: extra };
	}

	private reply(text: string): string
	{
		const R = ['facts', 'lol same', 'this is so real', 'nah you\'re wild for this', 'W post', 'who asked (jk)', 'need this energy today', 'where is this??', 'say less', 'big if true', 'ratio', 'saw that too!'];
		if (/car|sedan|drive|whip/i.test(text)) R.push('what are you driving these days?', 'clean ride');
		if (/house|hotel|motel|property|bought/i.test(text)) R.push('landlord era', 'congrats on the new place!');
		return this.pick(R);
	}

	// ------------------------------------------------------------------ reactions (events)

	public onCrime(data: any): void
	{
		if (this.minutes - this.lastCrimePost < 5) return;
		this.lastCrimePost = this.minutes;
		const where = this.nearestPlace(data && data.position);
		const kind = data && data.kind ? String(data.kind) : '';
		const T = ['Sirens all over ' + where + ' right now. Stay safe y\'all', 'Cops everywhere near ' + where + '?? what happened', 'Police activity near ' + where + ', avoid the area',
			'Helicopter circling ' + where + ' again'];
		this.addChirp(this.mkChirp(this.pick(this.people()).h, this.pick(T), this.minutes), false, 'crime');
		if (this.rnd() < 0.4) this.addChirp(this.mkChirp('svpd_news', 'Officers are responding to ' + (/shoot|gun/i.test(kind) ? 'reports of shots fired' : 'an incident') + ' near ' + where + '. Please avoid the area.', this.minutes), false, 'crime');
		this.generated.reactions++;
		this.save(); this.changed();
	}

	public onCarStolen(data: any): void
	{
		const p = data && data.car && data.car.position ? data.car.position : null;
		const where = this.nearestPlace(p);
		this.addChirp(this.mkChirp(this.pick(this.people()).h, this.pick(['Somebody just jacked a car near ' + where + '. In broad daylight??', 'Lock your cars near ' + where + ', people', 'Watched someone drive off in a car that wasn\'t theirs near ' + where]), this.minutes), false, 'crime');
		this.generated.reactions++;
		this.save(); this.changed();
	}

	public onPropertyBought(data: any): void
	{
		const name = data && data.name ? String(data.name) : 'a property';
		const big = data && /hotel|bank|motel|office|apartment/.test(String(data.kind));
		this.addChirp(this.mkChirp('svrealty', 'SOLD: ' + name + '. Congratulations to the new owner!', this.minutes), false, 'property');
		if (big) this.addChirp(this.mkChirp(this.pick(this.people()).h, 'Wait, someone just bought ' + name + '?? who has that kind of money', this.minutes), false, 'property');
		this.generated.reactions++;
		this.save(); this.changed();
	}

	public onCarBought(name: string): void
	{
		this.addChirp(this.mkChirp(this.pick(this.people()).h, 'Somebody just rolled off the Verano Motors lot in a brand new ' + name + '. Jealous.', this.minutes), false, 'car');
		this.generated.reactions++;
		this.save(); this.changed();
	}

	private nearestPlace(p: any): string
	{
		const lm: any[] = (this.ctx.data as any).landmarks || [];
		if (!p || !lm.length) return this.pick(this.places);
		let best = 1e18, name = '';
		for (let i = 0; i < lm.length; i++)
		{
			const d = (lm[i].x - p.x) * (lm[i].x - p.x) + (lm[i].z - p.z) * (lm[i].z - p.z);
			if (d < best) { best = d; name = lm[i].name; }
		}
		return String(name).replace(/\s*\(.*\)$/, '');
	}

	// ------------------------------------------------------------------ add / cap

	private addChirp(c: Chirp, quiet?: boolean, tag?: string): void
	{
		if (tag) c.tag = tag;
		this.chirps.unshift(c);
		this.generated.chirps++;
		this.cap(this.chirps, this.settings.maxChirps);
		if (!quiet) this.dirty = true;
	}

	private addSnap(s: Snap, quiet?: boolean): void { this.snaps.unshift(s); this.generated.snaps++; this.cap(this.snaps, this.settings.maxSnaps); if (!quiet) this.dirty = true; }
	private addVideo(v: Video, quiet?: boolean): void { this.videos.unshift(v); this.generated.videos++; this.cap(this.videos, this.settings.maxVideos); if (!quiet) this.dirty = true; }

	/** Drops the oldest NPC items first; the player's own posts go last. */
	private cap(list: any[], max: number): void
	{
		for (let i = list.length - 1; i >= 0 && list.length > max; i--) if (!list[i].player) list.splice(i, 1);
		while (list.length > max) list.pop();
	}

	// ------------------------------------------------------------------ player actions

	public post(text: string): Chirp | null
	{
		const s = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
		if (!s) return null;
		const c: Chirp = { id: 'c' + (this.nextId++), h: this.player.h, text: s, t: this.minutes, likes: 0, rt: 0, comments: [], cc: 0, player: true, pending: [] };
		const n = 1 + Math.floor(this.rnd() * 3);
		for (let i = 0; i < n; i++) c.pending.push(this.minutes + 3 + Math.floor(this.rnd() * 55));
		c.pending.sort((a, b) => a - b);
		this.chirps.unshift(c);
		this.cap(this.chirps, this.settings.maxChirps);
		this.save(); this.changed();
		return c;
	}

	public postSnap(caption: string): Snap
	{
		const hour = ((this.minutes / 60) % 24 + 24) % 24;
		const kind = hour >= 17 && hour < 21 ? 'sunset' : hour >= 21 || hour < 5 ? 'skyline' : this.pick(['beach', 'skyline', 'park', 'car']);
		const s: Snap = { id: 's' + (this.nextId++), h: this.player.h, kind: kind, seed: Math.floor(this.rnd() * 1e9), caption: String(caption || '').trim().slice(0, 140) || 'San Verano', t: this.minutes, likes: 0, player: true, hour: hour };
		this.snaps.unshift(s);
		this.cap(this.snaps, this.settings.maxSnaps);
		this.save(); this.changed();
		return s;
	}

	public comment(id: string, text: string): boolean
	{
		const c = this.find('chirp', id) as Chirp;
		const s = String(text || '').trim().slice(0, 200);
		if (!c || !s) return false;
		c.comments.push({ h: this.player.h, text: s, t: this.minutes });
		c.cc++;
		this.save(); this.changed();
		return true;
	}

	/** Toggles your like on a chirp / snap / video. Returns the new liked state. */
	public like(kind: string, id: string): boolean
	{
		const it: any = this.find(kind, id);
		if (!it) return false;
		it.liked = !it.liked;
		it.likes = Math.max(0, it.likes + (it.liked ? 1 : -1));
		this.save(); this.changed();
		return it.liked;
	}

	public view(id: string): void { const v = this.find('video', id) as Video; if (v) { v.views++; this.save(); } }

	public find(kind: string, id: string): Chirp | Snap | Video | null
	{
		const list: any[] = kind === 'chirp' ? this.chirps : kind === 'snap' ? this.snaps : this.videos;
		for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
		return null;
	}

	public channelKind(h: string): string { const a = this.byHandle[h]; return a && a.ch ? a.ch : ''; }

	public onChange(cb: () => void): void { if (typeof cb === 'function') this.listeners.push(cb); }
	private changed(): void { for (let i = 0; i < this.listeners.length; i++) { try { this.listeners[i](); } catch (e) { /* ignore */ } } }

	/** "5m", "3h", "2d" in game time. */
	public ago(t: number): string
	{
		const d = Math.max(0, this.minutes - t);
		if (d < 1) return 'now';
		if (d < 60) return Math.floor(d) + 'm';
		if (d < 1440) return Math.floor(d / 60) + 'h';
		return Math.floor(d / 1440) + 'd';
	}

	// ------------------------------------------------------------------ storage

	private load(): boolean
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			const raw = ls ? ls.getItem(SOCIAL_KEY) : null;
			if (!raw) return false;
			const d = JSON.parse(raw);
			if (!d || d.v !== 1 || d.seed !== this.ctx.data.seed) return false;
			this.chirps = (d.chirps instanceof Array ? d.chirps : []).filter((c: any) => c && typeof c.text === 'string' && typeof c.h === 'string').map((c: any) => {
				c.comments = c.comments instanceof Array ? c.comments : []; c.cc = +c.cc || c.comments.length; c.likes = +c.likes || 0; c.rt = +c.rt || 0; return c; });
			this.snaps = (d.snaps instanceof Array ? d.snaps : []).filter((s: any) => s && typeof s.kind === 'string');
			this.videos = (d.videos instanceof Array ? d.videos : []).filter((v: any) => v && typeof v.kind === 'string' && v.dur > 0);
			this.minutes = this.clockFromWorld(+d.minutes || 0);
			this.nextId = Math.max(1, +d.nextId || 1);
			return true;
		}
		catch (e) { console.warn('[Realism] Could not read social media, starting fresh', e); return false; }
	}

	public save(): void
	{
		try
		{
			const ls: any = typeof localStorage !== 'undefined' ? localStorage : null;
			if (!ls) return;
			ls.setItem(SOCIAL_KEY, JSON.stringify({ v: 1, seed: this.ctx.data.seed, minutes: Math.round(this.minutes), nextId: this.nextId, chirps: this.chirps, snaps: this.snaps, videos: this.videos }));
		}
		catch (e) { /* storage full */ }
	}
}

export function titleCase(s: string): string
{
	return String(s).toLowerCase().replace(/(^|[\s\-\/])([a-z])/g, (m, a, c) => a + c.toUpperCase());
}
