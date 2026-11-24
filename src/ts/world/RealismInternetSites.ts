/*
 * RealismInternetSites.ts  (A15)
 * ------------------------------
 * The in-game websites shown by the laptop browser (RealismLaptop.ts). No real network requests:
 * every page is rendered from game state.
 *
 *   goggle.sv          Goggle search + links to everything
 *   chirp.sv           Chirp (short text posts, NPC accounts, you can post / like / reply)
 *   snapgram.sv        Snapgram (procedural photo feed, you can share a snap / like)
 *   viewtube.sv        ViewTube (procedural NPC videos with play / pause / seek)
 *   veranomotors.sv    Verano Motors + brand sites veranosport.sv, pacificluxe.sv, skyverano.sv
 *                      (same catalogue + purchase path as the phone Dealership)
 *   svrealty.sv        SV Realty: buy / sell properties (contract C10, RealismProperties.ts)
 *   svbank.sv          San Verano Bank online (realismEconomy)
 *   svjobs.sv          Jobs board (realismJobs)
 *   underground.onion  Underground forum: game-mechanics guides, registry world.realismGuides (CONTENT RULE:
 *                      gameplay tips only, nothing real-world)
 *
 * Pages are HTML strings. Clicks: data-go="url" navigates, data-act / data-arg call the site's act().
 * Inputs: data-input="key" stores the value in L.inputs[key]; data-enter="act" runs act on Enter.
 * Canvases: data-draw="kind:id" are drawn by the laptop after the page is shown.
 */

import { money } from './RealismEconomy';
import { PhoneApps, CatalogItem } from './RealismPhoneApps';
import { KIND_LABEL, PropertyRecord } from './RealismProperties';
import { RealismSocial, Chirp, Snap, Video } from './RealismSocial';
import { fmtTime } from './RealismInternetMedia';

export interface LaptopLike
{
	world: any;
	ctx: any;
	social: RealismSocial;
	props: any;           // RealismProperties (impl)
	guides: GuideRegistry;
	inputs: { [k: string]: string };
	state: { [k: string]: any };
	go(url: string): void;
	notice(text: string, err?: boolean): void;
	player: any;          // VideoPlayer while a video page is open
}

export interface Site
{
	domain: string;
	name: string;
	icon: string;         // short glyph for tiles / tabs
	color: string;
	desc: string;
	keywords: string;
	render(path: string, q: { [k: string]: string }, L: LaptopLike): string;
	act?(a: string, arg: string, L: LaptopLike): boolean;
	theme?: string;       // extra class on the page
}

export function esc(s: any): string
{
	return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' } as any)[c]);
}

function rgbCss(rgb: number[]): string
{
	if (!rgb || rgb.length < 3) return '#888';
	return 'rgb(' + Math.round(rgb[0] * 255) + ',' + Math.round(rgb[1] * 255) + ',' + Math.round(rgb[2] * 255) + ')';
}

function hexToRgb(hex: string): number[] | null
{
	const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => Math.round(v * 1000) / 1000);
}

function compact(n: number): string
{
	if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
	return String(Math.round(n));
}

function av(h: string, size: number): string
{
	return '<canvas class="rr-av" width="' + size + '" height="' + size + '" data-draw="avatar:' + esc(h) + '"></canvas>';
}

function link(url: string, html: string, cls?: string): string
{
	return '<a class="' + (cls || 'rr-ln') + '" data-go="' + esc(url) + '">' + html + '</a>';
}

function btn(act: string, arg: string, label: string, cls?: string, disabled?: boolean): string
{
	return '<button class="rr-wb' + (cls ? ' ' + cls : '') + '" data-act="' + esc(act) + '" data-arg="' + esc(arg) + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
}

function noticeHtml(L: LaptopLike): string
{
	const n = L.state.notice;
	return n && n.text ? '<div class="rr-wnotice' + (n.err ? ' rr-err' : '') + '">' + esc(n.text) + '</div>' : '';
}

// ============================================================================ Guides registry

export interface Guide { id: string; title: string; category: string; body: string; waypoint?: { x: number; z: number; label: string }; author?: string; }

/** (world as any).realismGuides = { add(guide), list(), get(id), remove(id) }. add() replaces a guide with the same id. */
export class GuideRegistry
{
	public guides: Guide[] = [];
	private listeners: (() => void)[] = [];

	public add(g: Guide): boolean
	{
		if (!g || typeof g.id !== 'string' || !g.id || typeof g.title !== 'string') return false;
		// Also accept the illegal-content guide shape: { summary, steps[], waypoints[], onRead }
		const gx: any = g;
		let body = String(g.body || '');
		if (!body && (gx.summary || gx.steps))
		{
			body = String(gx.summary || '');
			if (gx.steps instanceof Array) body += (body ? '\n\n' : '') + gx.steps.map((s: any, i: number) => (i + 1) + '. ' + (typeof s === 'string' ? s : (s && (s.text || s.title)) || '')).join('\n');
		}
		if (!g.waypoint && gx.waypoints instanceof Array && gx.waypoints.length) (g as any).waypoint = gx.waypoints[0];
		const clean: Guide = { id: g.id, title: String(g.title).slice(0, 120), category: String(g.category || 'General').slice(0, 40), body: body.slice(0, 4000), author: g.author ? String(g.author).slice(0, 30) : undefined };
		if (typeof gx.onRead === 'function') (clean as any).onRead = gx.onRead;
		if (g.waypoint && isFinite(g.waypoint.x) && isFinite(g.waypoint.z)) clean.waypoint = { x: +g.waypoint.x, z: +g.waypoint.z, label: String(g.waypoint.label || g.title).slice(0, 60) };
		for (let i = 0; i < this.guides.length; i++) if (this.guides[i].id === g.id) { this.guides[i] = clean; this.changed(); return true; }
		this.guides.push(clean);
		this.changed();
		return true;
	}
	public get(id: string): Guide | null { for (let i = 0; i < this.guides.length; i++) if (this.guides[i].id === id) return this.guides[i]; return null; }
	public list(): Guide[] { return this.guides.slice(0); }
	public remove(id: string): boolean { for (let i = 0; i < this.guides.length; i++) if (this.guides[i].id === id) { this.guides.splice(i, 1); this.changed(); return true; } return false; }
	public onChange(cb: () => void): void { if (typeof cb === 'function') this.listeners.push(cb); }
	private changed(): void { for (let i = 0; i < this.listeners.length; i++) { try { this.listeners[i](); } catch (e) { /* ignore */ } } }

	public api(): any
	{
		const self = this;
		return { add(g: Guide): boolean { return self.add(g); }, list(): Guide[] { return self.list(); }, get(id: string): Guide | null { return self.get(id); }, remove(id: string): boolean { return self.remove(id); }, onChange(cb: () => void): void { self.onChange(cb); } };
	}
}

/**
 * Built-in guides. CONTENT RULE: these only explain GAME mechanics (keys, places on the map,
 * prices, heat, timers). No real-world methods, ingredients, quantities or equipment.
 * Other systems (A17) register their own with realismGuides.add(), same id = replace.
 */
export function defaultGuides(data: any): Guide[]
{
	const hoods: any[] = (data && data.hoods) || [];
	const hood = hoods[0] ? { x: (hoods[0].x0 + hoods[0].x1) / 2, z: (hoods[0].z0 + hoods[0].z1) / 2, label: hoods[0].name } : undefined;
	const harbor = hoods[2] ? { x: (hoods[2].x0 + hoods[2].x1) / 2, z: (hoods[2].z0 + hoods[2].z1) / 2, label: hoods[2].name } : hood;
	return [
		{ id: 'veh-theft-101', category: 'Vehicles', title: 'Car theft 101: the full loop', author: 'gr4nd_th3ft',
			body: 'How it works in San Verano:\n1. Walk up to a parked or stopped car that isn\'t yours and press F.\n2. Beat the hotwire minigame. Fail it and the alarm goes off, so get out of there.\n3. The car is now in your Garage as STOLEN and HOT. Cops notice hot cars.\n4. Respray it at the paint shop to cool it down, scratch the VIN, then either keep it or sell it to the fence for cash.\nTip: hot cars near police stations = bad idea.' },
		{ id: 'veh-hotwire', category: 'Vehicles', title: 'Hotwire minigame tips', author: 'wrenchboi',
			body: 'The hotwire minigame is all timing. Watch the moving marker and hit the key when it is inside the green zone. Each success fills the bar; a miss costs time. Run out of time and the alarm starts.\nSedans are easier than sports cars. Practise on cheap cars before going for the nice ones.' },
		{ id: 'veh-respray', category: 'Vehicles', title: 'Respray: cooling a hot car', author: 'paintjob_pete',
			body: 'A fresh paint job takes the HOT tag off a stolen car. Drive it into the paint bay at the illegal shop (look for its blip on your map, M) and pick a new colour. It costs cash, so bring some. The legal Mechanic & Body Shop only tunes cars you own.' },
		{ id: 'veh-vin', category: 'Vehicles', title: 'Scratching the VIN', author: 'gr4nd_th3ft',
			body: 'A stolen car keeps its VIN on record. At the illegal shop you can scratch the VIN after the respray. Once scratched, the car is just yours in the Garage, and fences pay more for clean cars.' },
		{ id: 'veh-fence', category: 'Vehicles', title: 'Selling to the fence', author: 'quiet_money',
			body: 'The fence buys stolen cars for cash. Drive the car to the fence\'s spot (blip on your map). The price depends on the car and whether it is still hot or the VIN is scratched. Cash goes in your pocket, not the bank: deposit it at an ATM if you want it safe.' },
		{ id: 'product-lean', category: 'Product', title: 'Lean (cup): how the job works in-game', author: 'purple_rain',
			body: 'Game mechanics only:\n- Buy supplies from the supplier (blip on your map).\n- Use your station: a timer runs, then you collect "Lean (cup)" items in your inventory.\n- Sell to buyers. Buyers pay more at night and less when your heat is high.\nIt\'s a simple timer + sell loop. No skills needed.' },
		{ id: 'product-weed', category: 'Product', title: 'Weed (bag): running a grow in a warehouse', author: 'greenthumb_sv',
			body: 'Game mechanics only:\n- Buy a warehouse on svrealty.sv (filter: Warehouses). Port and Eastside units are the cheapest.\n- Set up grow stations inside, water them on the timer, and harvest "Weed (bag)" items.\n- Sell to buyers or the dealer. Bigger warehouses = more stations.' },
		{ id: 'product-coke', category: 'Product', title: 'Coke (brick): high risk, high pay', author: 'quiet_money',
			body: 'Game mechanics only:\n- Bricks come from a supplier run. You pick them up, then deliver them across the county while the timer runs.\n- Pay is the highest of any job, but heat builds fast and the police will search hot players.\n- Use a clean (not stolen) car for deliveries.' },
		{ id: 'heat', category: 'Heat', title: 'Heat: how the police notice you', author: 'svpd_scanner',
			body: 'Crimes raise your heat: stealing cars, shooting, selling product near people. Police get more interested the higher it is. Heat cools off over time if you lie low (sleep at home, stay indoors). Stolen cars that are still HOT add heat while you drive them.' },
		{ id: 'spots-hideouts', category: 'Spots', title: 'Clubs and hideouts', author: 'nightowl',
			body: 'Hoods like ' + (hood ? hood.label : 'The Flats') + ' and ' + (harbor ? harbor.label : 'Harbor Row') + ' are where street buyers hang out at night. Buy a cheap house there on svrealty.sv and you have a hideout with a lockable door (L). Shops, motels and hotels you own pay you every in-game day, so a front business keeps the money coming.', waypoint: hood },
		{ id: 'spots-buyers', category: 'Spots', title: 'Where buyers are', author: 'purple_rain',
			body: 'Buyers mostly wait in the hoods after dark. The dealer and the fence show up on your map once you know them. ' + (harbor ? harbor.label + ' is the busiest at night.' : ''), waypoint: harbor },
		{ id: 'money-clean', category: 'Money', title: 'Cash vs bank', author: 'quiet_money',
			body: 'Illegal jobs pay cash. Cash is spent first at shops when your card is frozen and you lose nothing by depositing it at an ATM. Properties (hotels, motels, shops) pay legal income to your bank every in-game day: check svrealty.sv.' },
	];
}

// ============================================================================ helpers for catalogue

let phoneCatalog: PhoneApps = null;
function catalog(L: LaptopLike): CatalogItem[]
{
	try
	{
		if (!phoneCatalog) phoneCatalog = new PhoneApps({ world: L.world, ctx: L.ctx, isOpen: false, app: '', close: () => { /* none */ }, locate: () => { /* none */ } });
		return phoneCatalog.catalog();
	}
	catch (e) { return []; }
}

const BRANDS: { [domain: string]: { name: string; tag: string; color: string; filter: (i: CatalogItem) => boolean } } = {
	'veranomotors.sv': { name: 'Verano Motors', tag: 'Drive home today.', color: '#c62828', filter: () => true },
	'veranosport.sv': { name: 'Verano Sport', tag: 'Built for the boulevard.', color: '#ff6f00', filter: (i) => i.trim === 'Sport' || (i.type !== 'car' && i.type !== 'heli' && i.type !== 'airplane') },
	'pacificluxe.sv': { name: 'Pacific Luxe', tag: 'Quiet. Comfortable. Yours.', color: '#37474f', filter: (i) => i.type === 'car' && (i.trim === 'LX' || i.trim === 'Base') },
	'skyverano.sv': { name: 'SkyVerano Aviation', tag: 'The county from above.', color: '#0277bd', filter: (i) => i.type === 'heli' || i.type === 'airplane' },
};

function specSheet(L: LaptopLike, it: CatalogItem): string
{
	if (it.type === 'heli' || it.type === 'airplane') return '<table class="rr-spec"><tr><td>Class</td><td>' + (it.type === 'heli' ? 'Helicopter' : 'Single-engine airplane') + '</td></tr><tr><td>Delivery</td><td>Garage app (phone)</td></tr></table>';
	const tun = L.world.realismVehicleTuning;
	let d: any = null;
	try { d = tun && typeof tun.defaults === 'function' ? tun.defaults() : null; } catch (e) { d = null; }
	if (!d) return '<div class="rr-dim">Spec sheet unavailable.</div>';
	const row = (k: string, v: string) => '<tr><td>' + k + '</td><td>' + v + '</td></tr>';
	return '<table class="rr-spec">' + row('Engine force', esc(d.enginePower)) + row('Top speed', 'x' + esc(d.topSpeed)) + row('Brakes', 'x' + esc(d.brakeForce)) +
		row('Tyre grip', esc(d.grip)) + row('Steering lock', Math.round((d.maxSteer || 0) * 57.3) + '&deg;') + row('Suspension', esc(d.suspensionStiffness) + ' / damping ' + esc(d.damping)) +
		row('Trim', esc(it.trim || 'Standard')) + '</table><div class="rr-dim">Stock figures. Tune it at the Mechanic & Body Shop.</div>';
}

// ============================================================================ the sites

export const DEALER_NAMES = Object.keys(BRANDS).map((d) => BRANDS[d].name);

export function buildSites(): Site[]
{
	const sites: Site[] = [];

	// ------------------------------------------------------------------ Goggle
	sites.push({
		domain: 'goggle.sv', name: 'Goggle', icon: 'G', color: '#4285f4', desc: 'Search the San Verano web', keywords: 'search home start',
		render(path, q, L)
		{
			const logo = '<div class="rr-gg-logo"><span style="color:#4285f4">G</span><span style="color:#ea4335">o</span><span style="color:#fbbc05">g</span><span style="color:#4285f4">g</span><span style="color:#34a853">l</span><span style="color:#ea4335">e</span></div>';
			const box = '<div class="rr-gg-box"><input type="text" class="rr-input" data-input="q" data-enter="search" placeholder="Search San Verano or type a site" value="' + esc(q.q || L.inputs.q || '') + '"><button class="rr-wb rr-go" data-act="search">Search</button></div>';
			if (path.indexOf('/search') === 0) return '<div class="rr-gg rr-gg-res">' + link('goggle.sv', logo) + box + searchResults(q.q || '', L) + '</div>';
			let tiles = '';
			for (const s of sitesRef) if (s.domain !== 'goggle.sv') tiles += '<a class="rr-tile" data-go="' + s.domain + '"><span class="rr-tile-ic" style="background:' + s.color + '">' + esc(s.icon) + '</span><b>' + esc(s.name) + '</b><span class="rr-dim">' + esc(s.desc) + '</span></a>';
			return '<div class="rr-gg">' + logo + box + '<div class="rr-tiles">' + tiles + '</div></div>';
		},
		act(a, arg, L)
		{
			if (a === 'search') { const s = String(L.inputs.q || '').trim(); if (/^[a-z0-9\-]+\.(sv|onion)(\/.*)?$/i.test(s)) L.go(s); else L.go('goggle.sv/search?q=' + encodeURIComponent(s)); return false; }
			return false;
		},
	});

	// ------------------------------------------------------------------ Chirp
	sites.push({
		domain: 'chirp.sv', name: 'Chirp', icon: 'C', color: '#1d9bf0', desc: 'What\'s happening in San Verano', keywords: 'social twitter posts news', theme: 'rr-th-chirp',
		render(path, q, L)
		{
			const S = L.social;
			const head = '<div class="rr-ch-head">' + link('chirp.sv', '<b>Chirp</b>') + '<span class="rr-dim">' + S.chirps.length + ' posts</span></div>';
			const m = /^\/@([a-z0-9_]+)/.exec(path);
			if (m)
			{
				const a = S.account(m[1]);
				const posts = S.chirps.filter((c) => c.h === a.h);
				return head + '<div class="rr-ch-prof">' + av(a.h, 64) + '<div><b>' + esc(a.n) + '</b><div class="rr-dim">@' + esc(a.h) + '</div><div>' + esc(a.bio) + '</div></div></div>' +
					(posts.length ? posts.slice(0, 40).map((c) => chirpHtml(c, L, false)).join('') : '<div class="rr-empty">No posts yet.</div>');
			}
			const pm = /^\/post\/([a-z0-9]+)/.exec(path);
			if (pm)
			{
				const c = S.find('chirp', pm[1]) as Chirp;
				if (!c) return head + '<div class="rr-empty">This post was deleted.</div>';
				let comments = '';
				for (const cm of c.comments) { const a = S.account(cm.h); comments += '<div class="rr-ch-cm">' + av(cm.h, 28) + '<div><b>' + esc(a.n) + '</b> <span class="rr-dim">@' + esc(cm.h) + ' &middot; ' + S.ago(cm.t) + '</span><div>' + esc(cm.text) + '</div></div></div>'; }
				const more = c.cc - c.comments.length;
				return head + chirpHtml(c, L, true) + '<div class="rr-ch-reply"><input type="text" class="rr-input" maxlength="200" data-input="reply" data-enter="reply" data-arg="' + c.id + '" placeholder="Post your reply" value="' + esc(L.inputs.reply || '') + '">' + btn('reply', c.id, 'Reply', 'rr-go') + '</div>' +
					comments + (more > 0 ? '<div class="rr-dim rr-pad">' + more + ' older replies</div>' : '');
			}
			const limit = Math.max(20, +(q.n || 20));
			const compose = '<div class="rr-ch-compose">' + av(S.player.h, 40) + '<div class="rr-grow"><textarea class="rr-input" maxlength="280" data-input="chirp" placeholder="What\'s happening?">' + esc(L.inputs.chirp || '') + '</textarea>' +
				'<div class="rr-row"><span class="rr-dim">' + (280 - String(L.inputs.chirp || '').length) + '</span>' + btn('chirp-post', '', 'Post', 'rr-go') + '</div></div></div>';
			let feed = '';
			for (let i = 0; i < S.chirps.length && i < limit; i++) feed += chirpHtml(S.chirps[i], L, false);
			if (S.chirps.length > limit) feed += '<div class="rr-pad">' + link('chirp.sv/?n=' + (limit + 20), 'Show more') + '</div>';
			return head + noticeHtml(L) + compose + feed;
		},
		act(a, arg, L)
		{
			const S = L.social;
			if (a === 'chirp-post') { const c = S.post(L.inputs.chirp || ''); if (!c) { L.notice('Write something first.', true); return true; } L.inputs.chirp = ''; L.notice('Posted.'); return true; }
			if (a === 'like') { S.like('chirp', arg); return true; }
			if (a === 'reply') { if (S.comment(arg, L.inputs.reply || '')) L.inputs.reply = ''; return true; }
			return false;
		},
	});

	// ------------------------------------------------------------------ Snapgram
	sites.push({
		domain: 'snapgram.sv', name: 'Snapgram', icon: 'S', color: '#d62976', desc: 'Photos from around the county', keywords: 'social photos instagram pictures', theme: 'rr-th-snap',
		render(path, q, L)
		{
			const S = L.social;
			const m = /^\/@([a-z0-9_]+)/.exec(path);
			const list = m ? S.snaps.filter((s) => s.h === m[1]) : S.snaps;
			let html = '<div class="rr-sg-head">' + link('snapgram.sv', '<b class="rr-sg-logo">Snapgram</b>') + '</div>' + noticeHtml(L);
			if (m) { const a = S.account(m[1]); html += '<div class="rr-ch-prof">' + av(a.h, 64) + '<div><b>' + esc(a.n) + '</b><div class="rr-dim">@' + esc(a.h) + ' &middot; ' + list.length + ' posts</div><div>' + esc(a.bio) + '</div></div></div>'; }
			else html += '<div class="rr-sg-compose"><input type="text" class="rr-input" maxlength="140" data-input="snap" data-enter="snap-post" placeholder="Caption for a snap of where you are" value="' + esc(L.inputs.snap || '') + '">' + btn('snap-post', '', 'Share snap', 'rr-go') + '</div>';
			const limit = Math.max(12, +(q.n || 12));
			for (let i = 0; i < list.length && i < limit; i++)
			{
				const s = list[i], a = S.account(s.h);
				html += '<div class="rr-sg-post"><div class="rr-row rr-sg-top">' + av(s.h, 30) + link('snapgram.sv/@' + s.h, '<b>' + esc(s.h) + '</b>') + '<span class="rr-dim">' + S.ago(s.t) + '</span></div>' +
					'<canvas class="rr-sg-photo" width="300" height="300" data-draw="photo:' + s.id + '"></canvas>' +
					'<div class="rr-row">' + btn('snap-like', s.id, (s.liked ? '&#x2665;' : '&#x2661;') + ' ' + compact(s.likes), s.liked ? 'rr-liked' : '') + '</div>' +
					'<div><b>' + esc(a.n) + '</b> ' + esc(s.caption) + '</div></div>';
			}
			if (list.length > limit) html += '<div class="rr-pad">' + link('snapgram.sv/' + (m ? '@' + m[1] : '') + '?n=' + (limit + 12), 'Load more') + '</div>';
			if (!list.length) html += '<div class="rr-empty">No snaps yet.</div>';
			return html;
		},
		act(a, arg, L)
		{
			if (a === 'snap-like') { L.social.like('snap', arg); return true; }
			if (a === 'snap-post') { L.social.postSnap(L.inputs.snap || ''); L.inputs.snap = ''; L.notice('Shared to your profile.'); return true; }
			return false;
		},
	});

	// ------------------------------------------------------------------ ViewTube
	sites.push({
		domain: 'viewtube.sv', name: 'ViewTube', icon: '&#9654;', color: '#ff0000', desc: 'Videos made in San Verano', keywords: 'videos watch youtube channels', theme: 'rr-th-vt',
		render(path, q, L)
		{
			const S = L.social;
			const head = '<div class="rr-vt-head">' + link('viewtube.sv', '<span class="rr-vt-logo">&#9654;</span> <b>ViewTube</b>') + '</div>';
			if (path.indexOf('/watch') === 0)
			{
				const v = S.find('video', q.v || '') as Video;
				if (!v) return head + '<div class="rr-empty">Video unavailable.</div>';
				const ch = S.account(v.h);
				const p = L.player && L.player.video && L.player.video.id === v.id ? L.player : null;
				const t = p ? p.time : 0;
				let next = '';
				for (const o of S.videos) if (o.id !== v.id && next.split('rr-vt-next').length < 7) next += vtCard(o, L, 'rr-vt-next');
				return head + '<div class="rr-vt-watch"><div class="rr-vt-main"><div class="rr-vt-frame"><canvas class="rr-vt-canvas" width="480" height="270" data-player="' + v.id + '"></canvas></div>' +
					'<div class="rr-vt-ctrl">' + btn('vt-play', v.id, p && p.playing ? '&#10074;&#10074;' : '&#9654;', 'rr-vt-pp') +
					'<input type="range" class="rr-vt-seek" min="0" max="' + v.dur + '" step="0.1" value="' + t.toFixed(1) + '" data-input="seek" data-change="vt-seek">' +
					'<span class="rr-vt-time">' + fmtTime(t) + ' / ' + fmtTime(v.dur) + '</span></div>' +
					'<h3>' + esc(v.title) + '</h3><div class="rr-row"><span class="rr-dim">' + compact(v.views) + ' views &middot; ' + S.ago(v.t) + ' ago</span>' + btn('vt-like', v.id, (v.liked ? '&#x1F44D; ' : '&#x1F44D;&#xFE0E; ') + compact(v.likes), v.liked ? 'rr-liked' : '') + '</div>' +
					'<div class="rr-row rr-vt-ch">' + av(v.h, 36) + link('viewtube.sv/@' + v.h, '<b>' + esc(ch.n) + '</b>') + '<span class="rr-dim">' + esc(ch.bio) + '</span></div></div>' +
					'<div class="rr-vt-side">' + next + '</div></div>';
			}
			const m = /^\/@([a-z0-9_]+)/.exec(path);
			const list = m ? S.videos.filter((v) => v.h === m[1]) : S.videos;
			let grid = '';
			for (let i = 0; i < list.length && i < 24; i++) grid += vtCard(list[i], L, 'rr-vt-card');
			return head + (m ? '<div class="rr-ch-prof">' + av(m[1], 56) + '<div><b>' + esc(S.account(m[1]).n) + '</b><div class="rr-dim">' + list.length + ' videos</div></div></div>' : '') +
				'<div class="rr-vt-grid">' + (grid || '<div class="rr-empty">No videos yet.</div>') + '</div>';
		},
		act(a, arg, L)
		{
			const p = L.player;
			if (a === 'vt-play') { if (p) p.toggle(); return false; }
			if (a === 'vt-seek') { if (p) p.seek(parseFloat(arg !== '' ? arg : (L.inputs.seek || '0')) || 0); return false; }
			if (a === 'vt-like') { L.social.like('video', arg); return true; }
			return false;
		},
	});

	// ------------------------------------------------------------------ car sites
	for (const domain in BRANDS)
	{
		if (!BRANDS.hasOwnProperty(domain)) continue;
		const B = BRANDS[domain];
		sites.push({
			domain: domain, name: B.name, icon: B.name.charAt(0), color: B.color, desc: domain === 'veranomotors.sv' ? 'Every car in the county, delivered to your garage' : B.tag,
			keywords: 'cars vehicles buy dealer dealership ' + B.name.toLowerCase(), theme: 'rr-th-car',
			render(path, q, L)
			{
				const items = catalog(L).filter(B.filter);
				const eco = L.world.realismEconomy;
				const head = '<div class="rr-car-head" style="background:' + B.color + '">' + link(domain, '<b>' + esc(B.name) + '</b>') + '<span>' + esc(B.tag) + '</span><span class="rr-car-bal">' + (eco ? 'Bank ' + money(eco.getBank()) : '') + '</span></div>';
				const st = carState(L);
				const m = /^\/car\/([A-Za-z0-9_\-]+)/.exec(path);
				if (m)
				{
					const it = items.filter((i) => i.id === m[1])[0] || catalog(L).filter((i) => i.id === m[1])[0];
					if (!it) return head + '<div class="rr-empty">Model not found.</div>';
					const sel = st.sel[it.id] || { paint: 0 };
					const rgb = sel.rgb || (it.paints[sel.paint] || it.paints[0]).rgb;
					const pname = sel.rgb ? 'Custom' : (it.paints[sel.paint] || it.paints[0]).name;
					let sw = '';
					for (let i = 0; i < it.paints.length; i++) sw += '<button class="rr-sw' + (!sel.rgb && i === sel.paint ? ' rr-sel' : '') + '" title="' + esc(it.paints[i].name) + '" style="background:' + rgbCss(it.paints[i].rgb) + '" data-act="car-paint" data-arg="' + esc(it.id) + ':' + i + '"></button>';
					const afford = eco ? eco.canAfford(it.price) : false;
					let buy = '';
					if (st.confirm === it.id)
					{
						const card = eco && eco.card ? eco.card() : null;
						buy = '<div class="rr-confirm">Pay <b>' + money(it.price) + '</b> for a ' + esc(pname + ' ' + it.name) + ' with ' + (card ? (card.frozen ? 'cash (card frozen)' : 'card &bull;&bull;' + esc(card.last4)) : 'card') + '?' +
							'<div class="rr-row">' + btn('car-buy-yes', it.id, 'Confirm purchase', 'rr-go') + btn('car-buy-no', '', 'Cancel') + '</div></div>';
					}
					else buy = btn('car-buy', it.id, afford ? 'Buy now ' + money(it.price) : 'Can\'t afford', 'rr-go rr-big', !afford);
					return head + noticeHtml(L) + '<div class="rr-car-page"><div class="rr-car-hero" style="--paint:' + rgbCss(rgb) + '"><div class="rr-car-shape" style="background:' + rgbCss(rgb) + '"></div></div>' +
						'<div class="rr-car-info"><h2>' + esc(it.name) + '</h2><div class="rr-car-price">' + money(it.price) + '</div><div>' + esc(it.desc) + '</div>' +
						'<h4>Colour: ' + esc(pname) + '</h4><div class="rr-sws">' + sw + '<label class="rr-sw rr-sw-custom" title="Custom colour"><input type="color" data-input="carcolor" data-change="car-color" data-arg="' + esc(it.id) + '" value="#' + rgbHex(rgb) + '"></label></div>' +
						'<div class="rr-pad">' + buy + '</div><h4>Spec sheet</h4>' + specSheet(L, it) + '</div></div>';
				}
				let cards = '';
				for (const it of items)
				{
					const p = it.paints[0];
					cards += '<a class="rr-car-card" data-go="' + domain + '/car/' + esc(it.id) + '"><div class="rr-car-thumb"><div class="rr-car-shape" style="background:' + rgbCss(p.rgb) + '"></div></div><b>' + esc(it.name) + '</b><span class="rr-car-price">' + money(it.price) + '</span><span class="rr-dim">' + esc(it.desc) + '</span></a>';
				}
				return head + noticeHtml(L) + '<div class="rr-car-grid">' + (cards || '<div class="rr-empty">Nothing in stock right now.</div>') + '</div>' +
					'<div class="rr-dim rr-pad">Bought cars are delivered to your Garage (phone, P). Other dealers: ' + Object.keys(BRANDS).filter((d) => d !== domain).map((d) => link(d, esc(BRANDS[d].name))).join(' &middot; ') + '</div>';
			},
			act(a, arg, L)
			{
				const st = carState(L);
				if (a === 'car-paint') { const p = arg.split(':'); st.sel[p[0]] = { paint: parseInt(p[1], 10) || 0 }; return true; }
				if (a === 'car-color') { const rgb = hexToRgb(L.inputs.carcolor); if (rgb) st.sel[arg] = { paint: 0, rgb: rgb }; return true; }
				if (a === 'car-buy') { st.confirm = arg; return true; }
				if (a === 'car-buy-no') { st.confirm = null; return true; }
				if (a === 'car-buy-yes') { st.confirm = null; buyCar(L, arg, B.name); return true; }
				return false;
			},
		});
	}

	// ------------------------------------------------------------------ SV Realty
	sites.push({
		domain: 'svrealty.sv', name: 'SV Realty', icon: 'R', color: '#2e7d32', desc: 'Houses, motels, hotels, banks and more', keywords: 'real estate property properties house home hotel motel bank buy sell warehouse', theme: 'rr-th-realty',
		render(path, q, L)
		{
			const P = L.props;
			if (!P) return '<div class="rr-empty">SV Realty is offline.</div>';
			const eco = L.world.realismEconomy;
			const st = L.state.realty || (L.state.realty = { confirm: null });
			const head = '<div class="rr-re-head">' + link('svrealty.sv', '<b>SV Realty</b>') + '<span>San Verano County real estate</span>' + link('svrealty.sv/mine', 'My properties (' + P.ownedList().length + ')', 'rr-ln rr-re-mine') + '<span class="rr-dim">' + (eco ? 'Bank ' + money(eco.getBank()) : '') + '</span></div>';
			const pm = /^\/p\/(b\d+)/.exec(path);
			if (pm)
			{
				const r: PropertyRecord = P.get(pm[1]);
				if (!r) return head + '<div class="rr-empty">Listing not found.</div>';
				let actions = '';
				if (st.confirm === 'buy:' + r.id) actions = '<div class="rr-confirm">Buy <b>' + esc(r.name) + '</b> for <b>' + money(r.price) + '</b>?<div class="rr-row">' + btn('prop-buy-yes', r.id, 'Confirm purchase', 'rr-go') + btn('prop-cancel', '', 'Cancel') + '</div></div>';
				else if (st.confirm === 'sell:' + r.id) actions = '<div class="rr-confirm">Sell <b>' + esc(r.name) + '</b> for <b>' + money(P.sellPrice(r.id)) + '</b>?<div class="rr-row">' + btn('prop-sell-yes', r.id, 'Sell', 'rr-bad') + btn('prop-cancel', '', 'Cancel') + '</div></div>';
				else if (r.owned) actions = '<div class="rr-owned">You own this property.</div>' + btn('prop-sell', r.id, 'Sell for ' + money(P.sellPrice(r.id)), 'rr-bad');
				else actions = btn('prop-buy', r.id, eco && eco.canAfford(r.price) ? 'Buy for ' + money(r.price) : 'Can\'t afford ' + money(r.price), 'rr-go rr-big', !(eco && eco.canAfford(r.price)));
				const row = (k: string, v: string) => '<tr><td>' + k + '</td><td>' + v + '</td></tr>';
				return head + noticeHtml(L) + '<div class="rr-re-page"><div class="rr-re-pics"><canvas class="rr-re-facade" width="320" height="220" data-draw="facade:' + r.id + '"></canvas>' +
					'<canvas class="rr-re-map" width="320" height="220" data-draw="map:' + r.id + '"></canvas></div><div class="rr-re-info"><div class="rr-re-kind">' + esc(KIND_LABEL[r.kind] || r.kind) + (r.closed ? ' &middot; fixer-upper' : '') + (r.npcHome ? ' &middot; currently occupied, tenants move out on sale' : '') + '</div>' +
					'<h2>' + esc(r.name) + '</h2><div class="rr-re-price">' + money(r.price) + '</div>' +
					'<table class="rr-spec">' + row('District', esc(r.district)) + row('Floor area', r.area.toLocaleString() + ' m&sup2;') + row('Floors', String(r.floors)) +
					row('Income', r.income > 0 ? money(r.income) + ' per in-game day' : (r.kind === 'warehouse' ? 'Storage / production space' : 'Home, no income')) +
					(P.settings.taxRate > 0 ? row('Property tax', money(Math.round(r.price * P.settings.taxRate)) + ' per day') : '') + '</table>' +
					'<div class="rr-pad">' + actions + '</div><div class="rr-row">' + btn('prop-waypoint', r.id, 'Set waypoint') + link('svrealty.sv', 'Back to listings') + '</div></div></div>';
			}
			if (path.indexOf('/mine') === 0)
			{
				const own: PropertyRecord[] = P.ownedList();
				let rows = '';
				for (const r of own) rows += '<tr><td>' + link('svrealty.sv/p/' + r.id, esc(r.name)) + '</td><td>' + esc(KIND_LABEL[r.kind]) + '</td><td>' + esc(r.district) + '</td><td>' + (r.income ? money(r.income) : '-') + '</td><td>' + btn('prop-waypoint', r.id, 'Waypoint') + '</td></tr>';
				return head + noticeHtml(L) + '<h2 class="rr-pad">My properties</h2><div class="rr-pad">Daily income: <b>' + money(P.dailyIncome()) + '</b> (paid to your bank every in-game day)' + (P.dailyTax() ? ', tax ' + money(P.dailyTax()) : '') + '</div>' +
					(own.length ? '<table class="rr-tbl"><tr><th>Property</th><th>Type</th><th>District</th><th>Income/day</th><th></th></tr>' + rows + '</table>' : '<div class="rr-empty">You don\'t own any property yet.</div>');
			}
			// listings
			const kinds = P.kinds();
			const kind = q.kind || 'all';
			const sort = q.sort || (kind === 'all' ? 'feat' : 'price');
			const page = Math.max(0, parseInt(q.page || '0', 10) || 0);
			let list: PropertyRecord[] = P.all().filter((r: PropertyRecord) => kind === 'all' || r.kind === kind);
			if (q.district) list = list.filter((r) => r.district === q.district);
			if (q.own === '1') list = list.filter((r) => r.owned);
			if (sort === 'price') list = list.slice(0).sort((a, b) => a.price - b.price);
			else if (sort === 'pricedesc') list = list.slice(0).sort((a, b) => b.price - a.price);
			else if (sort === 'income') list = list.slice(0).sort((a, b) => b.income - a.income);
			else list = list.slice(0).sort((a, b) => featured(b) - featured(a));
			const K = ['all', 'house', 'apartment', 'motel', 'hotel', 'bank', 'shop', 'office', 'warehouse'];
			let tabs = '';
			for (const k of K)
			{
				const n = k === 'all' ? P.all().length : (kinds[k] || 0);
				if (k !== 'all' && !n) continue;
				tabs += '<a class="rr-re-tab' + (k === kind ? ' rr-sel' : '') + '" data-go="svrealty.sv/?kind=' + k + '">' + (k === 'all' ? 'All' : esc(KIND_LABEL[k])) + ' <span>' + n + '</span></a>';
			}
			const base = 'svrealty.sv/?kind=' + kind + (q.district ? '&district=' + encodeURIComponent(q.district) : '');
			const sorts = [['feat', 'Featured'], ['price', 'Price: low'], ['pricedesc', 'Price: high'], ['income', 'Income']].map((s) => link(base + '&sort=' + s[0], s[1], 'rr-ln' + (s[0] === sort ? ' rr-b' : ''))).join(' &middot; ');
			const PER = 12;
			const pages = Math.max(1, Math.ceil(list.length / PER));
			let cards = '';
			for (let i = page * PER; i < Math.min(list.length, (page + 1) * PER); i++)
			{
				const r = list[i];
				cards += '<a class="rr-re-card" data-go="svrealty.sv/p/' + r.id + '"><canvas width="200" height="138" data-draw="facade:' + r.id + '"></canvas><div class="rr-re-price">' + money(r.price) + (r.owned ? ' <span class="rr-badge">OWNED</span>' : '') + '</div>' +
					'<b>' + esc(r.name) + '</b><span class="rr-dim">' + esc(KIND_LABEL[r.kind]) + ' &middot; ' + esc(r.district) + (r.income ? ' &middot; ' + money(r.income) + '/day' : '') + '</span></a>';
			}
			let pager = '';
			if (pages > 1) pager = '<div class="rr-pager">' + (page > 0 ? link(base + '&sort=' + sort + '&page=' + (page - 1), '&lsaquo; Prev') : '') + ' Page ' + (page + 1) + ' of ' + pages + ' ' + (page < pages - 1 ? link(base + '&sort=' + sort + '&page=' + (page + 1), 'Next &rsaquo;') : '') + '</div>';
			return head + noticeHtml(L) + '<div class="rr-re-tabs">' + tabs + '</div><div class="rr-pad rr-dim">' + list.length + ' listings &middot; Sort: ' + sorts + '</div><div class="rr-re-grid">' + cards + '</div>' + pager;
		},
		act(a, arg, L)
		{
			const P = L.props;
			const st = L.state.realty || (L.state.realty = { confirm: null });
			if (!P) return false;
			if (a === 'prop-buy') { st.confirm = 'buy:' + arg; return true; }
			if (a === 'prop-sell') { st.confirm = 'sell:' + arg; return true; }
			if (a === 'prop-cancel') { st.confirm = null; return true; }
			if (a === 'prop-buy-yes') { st.confirm = null; if (P.buy(arg)) L.notice('Congratulations! ' + P.get(arg).name + ' is yours. Its doors are now yours to lock (L).'); else L.notice('Purchase failed: ' + P.lastError + '.', true); return true; }
			if (a === 'prop-sell-yes') { st.confirm = null; const v = P.sellPrice(arg); if (P.sell(arg)) L.notice('Sold for ' + money(v) + '.'); else L.notice('Sale failed: ' + P.lastError + '.', true); return true; }
			if (a === 'prop-waypoint') { L.notice(P.setWaypoint(arg) ? 'Waypoint set: ' + P.get(arg).name + '.' : 'GPS unavailable right now.', !L.world.realismGPS); return true; }
			return false;
		},
	});

	// ------------------------------------------------------------------ bank
	sites.push({
		domain: 'svbank.sv', name: 'San Verano Bank', icon: '$', color: '#00695c', desc: 'Online banking', keywords: 'bank money balance history card account', theme: 'rr-th-bank',
		render(path, q, L)
		{
			const eco = L.world.realismEconomy;
			const head = '<div class="rr-bk-head"><b>San Verano Bank</b> <span>online</span></div>';
			if (!eco) return head + '<div class="rr-empty">Online banking is unavailable.</div>';
			const card = eco.card ? eco.card() : null;
			const f = q.f || 'all';
			let hist: any[] = eco.history();
			if (f === 'in') hist = hist.filter((t) => t.amount > 0); else if (f === 'out') hist = hist.filter((t) => t.amount < 0);
			let rows = '';
			for (let i = 0; i < hist.length && i < 40; i++)
			{
				const t = hist[i];
				rows += '<tr><td>' + (t.gameDay ? 'Day ' + t.gameDay : '') + (isFinite(t.gameHour) ? ' ' + fmtHour(t.gameHour) : '') + '</td><td>' + esc(t.description) + '<div class="rr-dim">' + esc(t.merchant) + ' &middot; ' + esc(t.method) + '</div></td><td class="' + (t.amount < 0 ? 'rr-neg' : 'rr-pos') + '">' + money(t.amount, true) + '</td></tr>';
			}
			const tab = (k: string, l: string) => link('svbank.sv/?f=' + k, l, 'rr-ln' + (k === f ? ' rr-b' : ''));
			return head + noticeHtml(L) + '<div class="rr-bk-cards"><div class="rr-bk-card"><span>Checking</span><b>' + money(eco.getBank()) + '</b></div><div class="rr-bk-card"><span>Cash on you</span><b>' + money(eco.getCash()) + '</b></div>' +
				(card ? '<div class="rr-bk-card rr-bk-debit"><span>Debit card</span><b>&bull;&bull;&bull;&bull; ' + esc(card.last4) + '</b><span>' + esc(card.name) + ' &middot; ' + esc(card.expiry) + (card.frozen ? ' &middot; FROZEN' : '') + '</span>' + btn('bank-freeze', '', card.frozen ? 'Unfreeze card' : 'Freeze card') + '</div>' : '') + '</div>' +
				'<div class="rr-pad">' + tab('all', 'All') + ' &middot; ' + tab('in', 'Money in') + ' &middot; ' + tab('out', 'Money out') + '</div>' +
				'<table class="rr-tbl"><tr><th>When</th><th>Description</th><th>Amount</th></tr>' + (rows || '<tr><td colspan="3">No transactions.</td></tr>') + '</table><div class="rr-dim rr-pad">Deposit or withdraw cash at any ATM.</div>';
		},
		act(a, arg, L)
		{
			const eco = L.world.realismEconomy;
			if (a === 'bank-freeze' && eco && eco.card && eco.setFrozen) { eco.setFrozen(!eco.card().frozen); return true; }
			return false;
		},
	});

	// ------------------------------------------------------------------ jobs board
	sites.push({
		domain: 'svjobs.sv', name: 'SV Jobs', icon: 'J', color: '#6a1b9a', desc: 'Legal jobs hiring now', keywords: 'jobs work hiring police sheriff career salary', theme: 'rr-th-jobs',
		render(path, q, L)
		{
			const J = L.world.realismJobs;
			const head = '<div class="rr-jb-head"><b>SV Jobs</b> <span>Find work in San Verano County</span></div>';
			if (!J) return head + '<div class="rr-empty">The jobs board is unavailable.</div>';
			const cur = J.state ? J.state.id : 'civilian';
			let html = head + noticeHtml(L) + '<div class="rr-pad">Current job: <b>' + esc(cur === 'civilian' ? 'Civilian' : (J.departments[cur] ? J.departments[cur].title : cur)) + '</b>' + (J.state && J.state.onDuty ? ' (on duty)' : '') + '</div>';
			const deps = J.departments || {};
			for (const id in deps)
			{
				if (!deps.hasOwnProperty(id)) continue;
				const d = deps[id];
				html += '<div class="rr-jb-job"><div class="rr-row"><b>' + esc(d.title) + '</b><span class="rr-jb-pay">' + money(d.salary) + ' / in-game hour</span></div><div class="rr-dim">' + esc(d.name) + ' &middot; rank ' + esc(d.rank) + '</div>' +
					'<div>Patrol the county, answer calls, drive a marked unit. Go on duty in the phone Jobs app or at the station; pay arrives every in-game hour on duty.</div>' +
					'<div class="rr-row">' + (cur === id ? '<span class="rr-owned">Your current job</span>' : btn('job-apply', id, 'Apply', 'rr-go')) + '</div></div>';
			}
			const extra: any[] = typeof J.listings === 'function' ? (J.listings() || []) : [];
			for (const e of extra) html += '<div class="rr-jb-job"><b>' + esc(e.title || e.name || 'Job') + '</b><div>' + esc(e.desc || '') + '</div></div>';
			html += '<div class="rr-jb-job"><div class="rr-row"><b>Civilian</b><span class="rr-dim">no salary</span></div><div>Your own boss. Earn from properties (svrealty.sv) or whatever else you get up to.</div><div class="rr-row">' + (cur === 'civilian' ? '<span class="rr-owned">Your current job</span>' : btn('job-apply', 'civilian', 'Quit to civilian')) + '</div></div>';
			return html;
		},
		act(a, arg, L)
		{
			const J = L.world.realismJobs;
			if (a === 'job-apply' && J && typeof J.setJob === 'function') { L.notice(J.setJob(arg) ? (arg === 'civilian' ? 'You are a civilian now.' : 'Hired! Go on duty from the phone Jobs app.') : 'Application failed.', false); return true; }
			return false;
		},
	});

	// ------------------------------------------------------------------ Underground forum
	sites.push({
		domain: 'underground.onion', name: 'Underground', icon: '&#9763;', color: '#1b5e20', desc: 'Forum: tips for the other kind of work', keywords: 'guides tips illegal steal car fence lean weed coke heat hideout club underground', theme: 'rr-th-ug',
		render(path, q, L)
		{
			const G = L.guides;
			const head = '<div class="rr-ug-head">' + link('underground.onion', '<b>[ underground ]</b>') + '<span>you didn\'t find this here</span></div><div class="rr-ug-note">// game tips only. stay safe out there.</div>';
			const tm = /^\/t\/([A-Za-z0-9_\-]+)/.exec(path);
			if (tm)
			{
				const g = G.get(tm[1]);
				if (!g) return head + '<div class="rr-empty">thread removed by mods</div>';
				if (typeof (g as any).onRead === 'function') { try { (g as any).onRead(); } catch (e) { /* ignore */ } }   // reveals blips
				const body = esc(g.body).split('\n').join('<br>');
				return head + noticeHtml(L) + '<div class="rr-ug-thread"><div class="rr-ug-cat">' + esc(g.category) + '</div><h3>' + esc(g.title) + '</h3><div class="rr-dim">posted by ' + esc(g.author || 'anon') + '</div><div class="rr-ug-body">' + body + '</div>' +
					(g.waypoint ? btn('guide-waypoint', g.id, 'Set waypoint: ' + esc(g.waypoint.label)) : '') + '<div class="rr-pad">' + link('underground.onion', '&lsaquo; back to board') + '</div></div>';
			}
			const cat = q.c || '';
			const cats: { [c: string]: number } = {};
			for (const g of G.guides) cats[g.category] = (cats[g.category] || 0) + 1;
			let html = head + '<div class="rr-ug-cats">' + link('underground.onion', 'all', 'rr-ln' + (!cat ? ' rr-b' : '')) + Object.keys(cats).map((c) => ' | ' + link('underground.onion/?c=' + encodeURIComponent(c), esc(c.toLowerCase()) + ' (' + cats[c] + ')', 'rr-ln' + (c === cat ? ' rr-b' : ''))).join('') + '</div>';
			for (const g of G.guides)
			{
				if (cat && g.category !== cat) continue;
				html += '<a class="rr-ug-row" data-go="underground.onion/t/' + esc(g.id) + '"><span class="rr-ug-cat">' + esc(g.category) + '</span><b>' + esc(g.title) + '</b><span class="rr-dim">' + esc(g.author || 'anon') + (g.waypoint ? ' &middot; has location' : '') + '</span></a>';
			}
			return html;
		},
		act(a, arg, L)
		{
			if (a !== 'guide-waypoint') return false;
			const g = L.guides.get(arg), gps = L.world.realismGPS;
			if (!g || !g.waypoint) return false;
			if (gps && typeof gps.setWaypoint === 'function') { try { gps.setWaypoint({ x: g.waypoint.x, z: g.waypoint.z }, g.waypoint.label); L.notice('Waypoint set: ' + g.waypoint.label + '.'); } catch (e) { L.notice('GPS error.', true); } }
			else L.notice('GPS unavailable right now.', true);
			return true;
		},
	});

	sitesRef = sites;
	return sites;
}

let sitesRef: Site[] = [];

function featured(r: PropertyRecord): number
{
	const k: { [k: string]: number } = { hotel: 6, bank: 5, motel: 4, apartment: 3, office: 2, shop: 2, warehouse: 1.5, house: 1 };
	return (k[r.kind] || 1) * 10 + (r.income ? 1 : 0) - (r.closed ? 2 : 0) + (r.buildingIndex % 7) * 0.01;
}

function rgbHex(rgb: number[]): string
{
	let s = '';
	for (let i = 0; i < 3; i++) { const v = Math.max(0, Math.min(255, Math.round((rgb[i] || 0) * 255))); s += (v < 16 ? '0' : '') + v.toString(16); }
	return s;
}

function fmtHour(h: number): string
{
	const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
	return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
}

function carState(L: LaptopLike): { sel: { [id: string]: { paint: number; rgb?: number[] } }; confirm: string } { return L.state.cars || (L.state.cars = { sel: {}, confirm: null }); }

/** Same purchase path as the phone Dealership: realismEconomy.spend, then realismOwnedCars.add. */
export function buyCar(L: LaptopLike, itemId: string, merchant: string): any
{
	const eco = L.world.realismEconomy, cars = L.world.realismOwnedCars;
	const it = catalog(L).filter((i) => i.id === itemId)[0];
	if (!it) { L.notice('Model not found.', true); return null; }
	if (!eco) { L.notice('Banking is unavailable.', true); return null; }
	if (!cars || typeof cars.add !== 'function') { L.notice('Garage unavailable: cars can\'t be delivered right now.', true); return null; }
	const sel = carState(L).sel[it.id] || { paint: 0 };
	const paint = it.paints[sel.paint] || it.paints[0];
	const rgb = sel.rgb ? sel.rgb.slice(0) : paint.rgb.slice(0);
	const name = (sel.rgb ? 'Custom' : paint.name) + ' ' + it.name;
	if (!eco.spend(it.price, name, merchant || 'Verano Motors')) { L.notice('Payment declined: ' + (eco.lastError || 'not enough money') + '.', true); return null; }
	let rec: any = null;
	try { rec = cars.add({ type: it.type, rgb: rgb, name: name, price: it.price, trim: it.trim }); } catch (e) { rec = null; }
	if (!rec) { eco.earn(it.price, 'Refund: ' + name, merchant || 'Verano Motors'); L.notice('Delivery failed, you were refunded.', true); return null; }
	L.notice('Bought! Your ' + name + ' is waiting in the Garage app (phone, P).');
	return rec;
}

function chirpHtml(c: Chirp, L: LaptopLike, big: boolean): string
{
	const S = L.social, a = S.account(c.h);
	return '<div class="rr-ch-post' + (big ? ' rr-big' : '') + (c.player ? ' rr-mine' : '') + '">' + link('chirp.sv/@' + c.h, av(c.h, big ? 48 : 40), 'rr-ln rr-avl') + '<div class="rr-grow">' +
		'<div>' + link('chirp.sv/@' + c.h, '<b>' + esc(a.n) + '</b>') + ' <span class="rr-dim">@' + esc(c.h) + ' &middot; ' + S.ago(c.t) + '</span>' + (c.tag === 'crime' ? ' <span class="rr-badge rr-red">LIVE</span>' : '') + '</div>' +
		'<div class="rr-ch-text">' + esc(c.text) + '</div><div class="rr-ch-acts">' + link('chirp.sv/post/' + c.id, '&#x1F4AC; ' + compact(c.cc)) + '<span>&#x1F501; ' + compact(c.rt) + '</span>' +
		btn('like', c.id, (c.liked ? '&#x2665; ' : '&#x2661; ') + compact(c.likes), c.liked ? 'rr-liked' : '') + '</div></div></div>';
}

function vtCard(v: Video, L: LaptopLike, cls: string): string
{
	const ch = L.social.account(v.h);
	return '<a class="' + cls + '" data-go="viewtube.sv/watch?v=' + v.id + '"><div class="rr-vt-thumb"><canvas width="192" height="108" data-draw="thumb:' + v.id + '"></canvas><span class="rr-vt-dur">' + fmtTime(v.dur) + '</span></div>' +
		'<b>' + esc(v.title) + '</b><span class="rr-dim">' + esc(ch.n) + '</span><span class="rr-dim">' + compact(v.views) + ' views &middot; ' + L.social.ago(v.t) + ' ago</span></a>';
}

function searchResults(query: string, L: LaptopLike): string
{
	const qs = query.toLowerCase().trim();
	if (!qs) return '<div class="rr-empty">Type something to search.</div>';
	const words = qs.split(/\s+/).filter((w) => w.length > 1);
	const hit = (s: string) => { const t = s.toLowerCase(); for (const w of words) if (t.indexOf(w) >= 0) return true; return false; };
	const out: string[] = [];
	for (const s of sitesRef) if (hit(s.name + ' ' + s.keywords + ' ' + s.domain + ' ' + s.desc)) out.push(result(s.domain, s.name, s.desc));
	for (const g of L.guides.guides) if (out.length < 30 && hit(g.title + ' ' + g.category)) out.push(result('underground.onion/t/' + g.id, g.title, 'Underground forum &middot; ' + esc(g.category)));
	for (const v of L.social.videos) if (out.length < 30 && hit(v.title)) out.push(result('viewtube.sv/watch?v=' + v.id, v.title, 'ViewTube &middot; ' + esc(L.social.account(v.h).n)));
	for (const a of L.social.accounts) if (out.length < 30 && hit(a.n + ' ' + a.h)) out.push(result('chirp.sv/@' + a.h, a.n + ' (@' + a.h + ')', 'Chirp profile'));
	if (L.props) { let n = 0; for (const r of L.props.all()) if (n < 8 && hit(r.name + ' ' + r.kind + ' ' + r.district)) { n++; out.push(result('svrealty.sv/p/' + r.id, r.name, 'SV Realty &middot; ' + money(r.price))); } }
	for (const it of catalog(L)) if (out.length < 40 && hit(it.name + ' ' + it.type)) out.push(result('veranomotors.sv/car/' + it.id, it.name, 'Verano Motors &middot; ' + money(it.price)));
	return '<div class="rr-dim rr-pad">About ' + out.length + ' results</div>' + (out.length ? out.join('') : '<div class="rr-empty">No results for "' + esc(query) + '".</div>');
}

function result(url: string, title: string, desc: string): string
{
	return '<div class="rr-gg-hit"><span class="rr-dim">' + esc(url) + '</span>' + link(url, esc(title), 'rr-ln rr-gg-title') + '<div>' + desc + '</div></div>';
}
