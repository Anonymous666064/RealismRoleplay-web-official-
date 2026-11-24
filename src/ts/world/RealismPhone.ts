/*
 * RealismPhone.ts
 * ---------------
 * The in-game phone: P opens / closes it (bottom right). While it is open the mouse is free
 * (pointer lock released) and gameplay input is blocked through the 'phone' UI owner.
 * Closing it (P, Esc, the home bar twice, or a click on the game) grabs the mouse again.
 *
 * Apps: Map (roads / landmarks from the county data, player arrow, zoom, a pin from Locate; GPS blips
 * and route from RealismGPS, tap / click the map to set a waypoint, tap it again to clear it),
 * Garage ((world as any).realismOwnedCars: spawn / locate / sell / forget), Settings (pauses and
 * opens the Settings menu), Clock (game time), Contacts and Messages (placeholders), Bank
 * (card, balances, ATM, history), Dealership (buy cars) and Jobs (police / sheriff duty).
 * The money / vehicle / job apps live in RealismPhoneApps.ts.
 * Keys while open: 1-9 open an app, Backspace / Arrow Left = home, + / - zoom the map.
 *
 * Cheap on purpose: no updates while closed; the map's base image is drawn once when the Map
 * app opens and freed when the phone closes.
 */

import * as THREE from 'three';
import { RealismCtx } from './RealismContext';
import { RealismDayNight } from './RealismDayNight';
import { HALF } from './RealismMapData';
import { PhoneApps } from './RealismPhoneApps';
import { blipSprite, strokeRoute, fmtDist } from './RealismMinimap';

const APPS = [
	{ id: 'map', name: 'Map', icon: '&#x1F5FA;&#xFE0F;', color: '#2e8b57' },
	{ id: 'garage', name: 'Garage', icon: '&#x1F697;', color: '#c0392b' },
	{ id: 'settings', name: 'Settings', icon: '&#x2699;&#xFE0F;', color: '#5d6d7e' },
	{ id: 'clock', name: 'Clock', icon: '&#x1F552;', color: '#1f2d3d' },
	{ id: 'contacts', name: 'Contacts', icon: '&#x1F464;', color: '#2874a6' },
	{ id: 'messages', name: 'Messages', icon: '&#x1F4AC;', color: '#27ae60' },
	{ id: 'bank', name: 'Bank', icon: '&#x1F4B3;', color: '#1f6f8b' },
	{ id: 'dealer', name: 'Dealership', icon: '&#x1F3CE;&#xFE0F;', color: '#d35400' },
	{ id: 'jobs', name: 'Jobs', icon: '&#x1F46E;', color: '#2c3e8f' },
];
/** Apps drawn by RealismPhoneApps. */
const EXT_APPS: { [id: string]: boolean } = { garage: true, bank: true, dealer: true, jobs: true };

const ROAD_STYLE: { [kind: string]: string } = {
	highway: '#f3c04f', avenue: '#e9e9e9', street: '#c9c9c9', rural: '#b9a98a', runway: '#8d8d8d', taxiway: '#8d8d8d', apron: '#8d8d8d',
};

/** Metres per map pixel; the last one shows the whole county. */
const ZOOMS = [1, 2, 4, 0];

function esc(s: any): string
{
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' } as any)[c]);
}

export class RealismPhone
{
	public isOpen = false;
	public app = 'home';

	private ui: any;
	public ctx: RealismCtx;
	public world: any;
	private el: HTMLElement;
	private timeEl: HTMLElement;
	private views: { [id: string]: HTMLElement } = {};
	private mapCanvas: HTMLCanvasElement = null;
	private mapBase: HTMLCanvasElement = null;
	private mapBaseScale = 0.5;   // base image pixels per metre
	private zoom = 1;
	private camDir = new THREE.Vector3();
	private lastHome = 0;
	private apps: PhoneApps = null;
	private appTicks = 0;
	/** Last drawn map view (for taps): centre, metres per canvas pixel. */
	public mapView = { cx: 0, cz: 0, mpp: 1, W: 240, H: 300 };
	private routeDash: number[] = [0, 0];
	/** A pin on the map (Locate in the Garage / Bank apps). */
	public marker: { x: number; z: number; label: string } = null;

	constructor(ui: any, ctx: RealismCtx)
	{
		this.ui = ui;
		this.ctx = ctx;
		this.world = ctx.world;
		try { this.apps = new PhoneApps(this); }
		catch (e) { console.warn('[Realism] phone apps failed', e); this.apps = null; }
		this.build();
		try
		{
			// a click on the game while the phone is open closes it and grabs the mouse again
			this.world.renderer.domElement.addEventListener('mousedown', () => { if (this.isOpen) this.close(true); }, false);
		}
		catch (e) { /* headless */ }
	}

	// ------------------------------------------------------------------ open / close

	public toggle(): void { if (this.isOpen) this.close(true); else this.open(); }

	public open(): void
	{
		if (this.isOpen || this.ui.state !== 'playing') return;
		this.isOpen = true;
		this.ui.setBlocking('phone', true);
		this.ui.exitLock();   // free cursor to tap the apps
		this.el.style.display = '';
		// next frame: slide in (the transition needs a frame with the closed position)
		setTimeout(() => { if (this.isOpen) this.el.classList.add('rr-open'); }, 16);
		this.showApp('home');
		this.tick();
	}

	public close(relock: boolean): void
	{
		if (!this.isOpen) return;
		this.isOpen = false;
		this.el.classList.remove('rr-open');
		setTimeout(() => { if (!this.isOpen) this.el.style.display = 'none'; }, 260);
		this.ui.setBlocking('phone', false);
		this.mapBase = null;   // free the map image (drawn again next time)
		if (relock && this.ui.state === 'playing') this.ui.requestLock();
	}

	/** Keys while the phone is open. Returns true when the key was used. */
	public handleKey(e: KeyboardEvent): boolean
	{
		const c = e.code;
		const t: any = e.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return false;   // typing an amount
		if (/^Digit[1-9]$/.test(c) || /^Numpad[1-9]$/.test(c))
		{
			const i = parseInt(c.charAt(c.length - 1), 10) - 1;
			if (APPS[i]) this.launch(APPS[i].id);
			return true;
		}
		if (c === 'Backspace' || c === 'ArrowLeft') { this.showApp('home'); return true; }
		if (this.app === 'map' && (c === 'Equal' || c === 'NumpadAdd')) { this.zoomBy(-1); return true; }
		if (this.app === 'map' && (c === 'Minus' || c === 'NumpadSubtract')) { this.zoomBy(1); return true; }
		return false;
	}

	/** Called by RealismUI about 4 times a second. */
	public tick(): void
	{
		if (!this.isOpen) return;
		const h = this.world.realismTime ? this.world.realismTime.hour : 12;
		if (this.timeEl) this.timeEl.textContent = RealismDayNight.format(h);
		if (this.app === 'map') this.drawMap();
		else if (this.app === 'clock') this.renderClock();
		else if (EXT_APPS[this.app] && this.apps) this.apps.tick(this.app, ++this.appTicks);
	}

	// ------------------------------------------------------------------ DOM

	private build(): void
	{
		const el = document.createElement('div');
		el.id = 'rr-phone';
		el.style.display = 'none';
		let home = '<div class="rr-phone-home" data-view="home"><div class="rr-app-grid">';
		for (let i = 0; i < APPS.length; i++)
		{
			const a = APPS[i];
			home += '<button class="rr-app-icon" data-app="' + a.id + '" title="' + a.name + ' (' + (i + 1) + ')">' +
				'<span class="rr-app-glyph" style="background:' + a.color + '">' + a.icon + '</span><span class="rr-app-name">' + a.name + '</span></button>';
		}
		home += '</div><div class="rr-phone-tip">1-9 open apps &middot; P closes</div></div>';
		const view = (id: string, title: string, body: string) =>
			'<div class="rr-phone-app" data-view="' + id + '" style="display:none">' +
				'<div class="rr-phone-app-head"><button class="rr-phone-back" data-home="1">&#x2039;</button><span>' + title + '</span></div>' +
				'<div class="rr-phone-app-body">' + body + '</div></div>';
		el.innerHTML =
			'<div class="rr-phone-frame">' +
				'<div class="rr-phone-status"><span class="rr-phone-time">12:00</span><span class="rr-phone-carrier">SVC 5G &#x25AE;&#x25AE;&#x25AE;</span></div>' +
				'<div class="rr-phone-screen">' + home +
					view('map', 'Map', '<canvas class="rr-map" width="240" height="300"></canvas><div class="rr-map-tools"><button data-zoom="-1">+</button><button data-zoom="1">&minus;</button></div>') +
					view('garage', 'Garage', '<div class="rr-garage"></div>') +
					view('bank', 'Bank', '<div class="rr-bank"></div>') +
					view('dealer', 'Dealership', '<div class="rr-dealer"></div>') +
					view('jobs', 'Jobs', '<div class="rr-jobs"></div>') +
					view('clock', 'Clock', '<div class="rr-clock"></div>') +
					view('contacts', 'Contacts', '<div class="rr-empty">No contacts yet.<br>People you meet in San Verano County will show up here.</div>') +
					view('messages', 'Messages', '<div class="rr-empty">No messages.</div>') +
				'</div>' +
				'<div class="rr-phone-homebar" title="Home (twice: close)"></div>' +
			'</div>';
		document.body.appendChild(el);
		this.el = el;
		this.timeEl = el.querySelector('.rr-phone-time') as HTMLElement;
		this.views.home = el.querySelector('[data-view="home"]') as HTMLElement;
		for (const a of APPS) this.views[a.id] = el.querySelector('[data-view="' + a.id + '"]') as HTMLElement;
		this.mapCanvas = el.querySelector('canvas.rr-map') as HTMLCanvasElement;
		if (this.mapCanvas && this.mapCanvas.addEventListener)
			this.mapCanvas.addEventListener('click', (ev: MouseEvent) => { ev.preventDefault(); this.mapTapClient(ev.clientX, ev.clientY); }, false);
		if (this.apps)
		{
			const hook = (id: string, sel: string) => { const v = el.querySelector(sel) as HTMLElement; if (v) this.apps.attach(id, v); };
			hook('garage', '.rr-garage'); hook('bank', '.rr-bank'); hook('dealer', '.rr-dealer'); hook('jobs', '.rr-jobs');
		}

		for (const a of APPS)
		{
			const b = el.querySelector('[data-app="' + a.id + '"]');
			if (b) b.addEventListener('click', (ev: Event) => { ev.preventDefault(); this.launch(a.id); });
		}
		const backs = el.querySelectorAll('[data-home]');
		for (let i = 0; i < backs.length; i++) backs[i].addEventListener('click', (ev: Event) => { ev.preventDefault(); this.showApp('home'); });
		const zooms = el.querySelectorAll('[data-zoom]');
		for (let i = 0; i < zooms.length; i++)
		{
			const z = zooms[i] as HTMLElement;
			z.addEventListener('click', (ev: Event) => { ev.preventDefault(); this.zoomBy(parseInt(z.getAttribute('data-zoom'), 10) || 0); });
		}
		const bar = el.querySelector('.rr-phone-homebar');
		if (bar) bar.addEventListener('click', () =>
		{
			const t = Date.now();
			if (this.app === 'home' && t - this.lastHome < 600) this.close(true);
			else this.showApp('home');
			this.lastHome = t;
		});
		// clicks inside the phone must not reach the game
		el.addEventListener('mousedown', (ev: Event) => ev.stopPropagation(), false);
	}

	private launch(id: string): void
	{
		if (id === 'settings') { this.ui.openSettingsFromPhone(); return; }
		this.showApp(id);
	}

	private showApp(id: string): void
	{
		this.app = id;
		for (const k in this.views)
		{
			if (!this.views.hasOwnProperty(k) || !this.views[k]) continue;
			this.views[k].style.display = k === id ? '' : 'none';
		}
		if (id === 'map') this.drawMap();
		if (id === 'clock') this.renderClock();
		if (id !== 'map') this.marker = id === 'home' ? null : this.marker;
		if (EXT_APPS[id])
		{
			this.appTicks = 0;
			if (this.apps) this.apps.open(id);
			else if (id === 'garage') this.renderGarage();
		}
	}

	/** Shows a pin on the map (Garage / Bank 'Locate') and opens the Map app; the GPS routes there. */
	public locate(x: number, z: number, label: string): void
	{
		this.marker = { x: x, z: z, label: label };
		const gps = this.world.realismGPS;
		if (gps && typeof gps.setWaypoint === 'function') gps.setWaypoint({ x: x, z: z }, label);
		if (this.zoom === 0) this.zoom = 1;
		this.showApp('map');
	}

	// ------------------------------------------------------------------ apps

	private renderClock(): void
	{
		const v = this.views.clock ? this.views.clock.querySelector('.rr-clock') : null;
		if (!v) return;
		const dn: any = this.world.realismDayNight;
		const h = this.world.realismTime ? this.world.realismTime.hour : 12;
		const night = dn ? dn.night : (h < 6 || h >= 18);
		const cycle = dn ? (dn.settings.enabled ? dn.settings.cycleMinutes + ' real minutes per day' : 'Time stopped') : '';
		v.innerHTML = '<div class="rr-clock-time">' + RealismDayNight.format(h) + '</div>' +
			'<div class="rr-clock-sub">' + (night ? '&#x1F319; Night: street lights on' : '&#x2600;&#xFE0F; Day') + '</div>' +
			'<div class="rr-clock-sub rr-dim">' + cycle + '</div>';
	}

	private renderGarage(): void
	{
		const v = this.views.garage ? this.views.garage.querySelector('.rr-garage') : null;
		if (!v) return;
		const raw = this.world.realismOwnedCars;
		let cars: any[] = [];
		if (raw instanceof Array) cars = raw;
		else if (raw && typeof raw === 'object') cars = Object.keys(raw).map((k) => raw[k]);
		if (cars.length === 0) { v.innerHTML = '<div class="rr-empty">No cars yet.<br>Cars you own will be listed here.</div>'; return; }
		let html = '';
		for (let i = 0; i < cars.length; i++)
		{
			const c = cars[i];
			const name = typeof c === 'string' ? c : (c && (c.name || c.label || c.model || c.type)) || 'Car ' + (i + 1);
			const sub = c && typeof c === 'object' ? (c.plate || c.status || c.location || '') : '';
			const canSpawn = c && typeof c === 'object' && (typeof c.spawn === 'function' || typeof this.world.realismSpawnOwnedCar === 'function');
			html += '<div class="rr-car"><div><div class="rr-car-name">' + esc(name) + '</div>' + (sub ? '<div class="rr-dim">' + esc(sub) + '</div>' : '') + '</div>' +
				(canSpawn ? '<button class="rr-btn rr-small" data-car="' + i + '">Bring</button>' : '') + '</div>';
		}
		v.innerHTML = html;
		const btns = v.querySelectorAll('[data-car]');
		for (let i = 0; i < btns.length; i++)
		{
			const b = btns[i] as HTMLElement;
			b.addEventListener('click', (ev: Event) =>
			{
				ev.preventDefault();
				const c = cars[parseInt(b.getAttribute('data-car'), 10)];
				try
				{
					if (c && typeof c.spawn === 'function') c.spawn();
					else if (typeof this.world.realismSpawnOwnedCar === 'function') this.world.realismSpawnOwnedCar(c);
					this.close(true);
				}
				catch (e) { console.warn('[Realism] Could not bring car', e); }
			});
		}
	}

	private zoomBy(d: number): void
	{
		this.zoom = Math.max(0, Math.min(ZOOMS.length - 1, this.zoom + d));
		this.drawMap();
	}

	/** Base image of the county (land / sea, lake, roads), north up, drawn once per phone opening. */
	private baseMap(): HTMLCanvasElement
	{
		if (this.mapBase) return this.mapBase;
		const data = this.ctx.data;
		const size = Math.round(HALF * 2 * this.mapBaseScale);
		const c = document.createElement('canvas');
		c.width = size; c.height = size;
		const g = c.getContext('2d');
		if (!g) return null;
		// land / sea from the height map, sampled coarsely and scaled up
		const N = 96;
		const small = document.createElement('canvas');
		small.width = N; small.height = N;
		const sg = small.getContext('2d');
		if (sg && sg.createImageData)
		{
			const img = sg.createImageData(N, N);
			for (let j = 0; j < N; j++)
				for (let i = 0; i < N; i++)
				{
					const x = -HALF + (i + 0.5) * HALF * 2 / N, z = -HALF + (j + 0.5) * HALF * 2 / N;
					const h = data.heightAt(x, z);
					const o = (j * N + i) * 4;
					if (h < 0.2) { img.data[o] = 38; img.data[o + 1] = 84; img.data[o + 2] = 118; }
					else { const k = Math.min(1, h / 120); img.data[o] = 70 + k * 50; img.data[o + 1] = 98 + k * 30; img.data[o + 2] = 62 + k * 30; }
					img.data[o + 3] = 255;
				}
			sg.putImageData(img, 0, 0);
			g.imageSmoothingEnabled = true;
			g.drawImage(small, 0, 0, size, size);
		}
		const S = this.mapBaseScale;
		const X = (x: number) => (x + HALF) * S, Z = (z: number) => (z + HALF) * S;
		const lake = data.lake;
		if (lake)
		{
			g.fillStyle = '#2f6f96';
			g.beginPath();
			g.ellipse(X(lake.x), Z(lake.z), lake.rx * S, lake.rz * S, 0, 0, Math.PI * 2);
			g.fill();
		}
		g.lineCap = 'round';
		g.lineJoin = 'round';
		const order = ['apron', 'taxiway', 'runway', 'rural', 'street', 'avenue', 'highway'];
		for (const kind of order)
		{
			g.strokeStyle = ROAD_STYLE[kind] || '#cccccc';
			for (const r of data.roads)
			{
				if (r.kind !== kind || r.pts.length < 2) continue;
				g.lineWidth = Math.max(1.2, r.width * S * 1.3);
				g.beginPath();
				g.moveTo(X(r.pts[0].x), Z(r.pts[0].z));
				for (let i = 1; i < r.pts.length; i++) g.lineTo(X(r.pts[i].x), Z(r.pts[i].z));
				g.stroke();
			}
		}
		this.mapBase = c;
		return c;
	}

	/** A tap / click on the map canvas (client coordinates). */
	public mapTapClient(clientX: number, clientY: number): void
	{
		const cv = this.mapCanvas;
		if (!cv) return;
		let l = 0, t = 0, w = cv.width, h = cv.height;
		try { const r = cv.getBoundingClientRect(); l = r.left; t = r.top; if (r.width > 0) w = r.width; if (r.height > 0) h = r.height; } catch (e) { /* headless */ }
		this.mapTap((clientX - l) * cv.width / w, (clientY - t) * cv.height / h);
	}

	/** A tap at canvas pixel (x, y): on the waypoint clears it, on a blip routes to it, else sets a waypoint there. */
	public mapTap(x: number, y: number): void
	{
		const gps = this.world.realismGPS, sys: any = this.world.realismGPSSystem;
		if (!gps || this.app !== 'map') return;
		const v = this.mapView;
		const wx = (x - v.W / 2) * v.mpp + v.cx, wz = (y - v.H / 2) * v.mpp + v.cz;
		const wp = gps.current();
		if (wp && Math.abs((wp.x - v.cx) / v.mpp + v.W / 2 - x) < 12 && Math.abs((wp.z - v.cz) / v.mpp + v.H / 2 - y + 6) < 16) gps.clear();
		else
		{
			let best: any = null, bd = 10 * 10;
			const list = sys ? sys.blipList : [];
			for (let i = 0; i < list.length; i++)
			{
				const b = list[i];
				if (b.shortRange && v.mpp > 2.1) continue;
				const dx = (b.x - v.cx) / v.mpp + v.W / 2 - x, dy = (b.z - v.cz) / v.mpp + v.H / 2 - y;
				if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = b; }
			}
			if (best) gps.setWaypoint({ x: best.x, z: best.z }, best.label || 'Waypoint');
			else gps.setWaypoint({ x: wx, z: wz }, 'Waypoint');
		}
		this.marker = null;
		this.drawMap();
	}

	private playerPos(out: THREE.Vector3): void
	{
		const r: any = this.world.inputManager ? this.world.inputManager.inputReceiver : null;
		if (r && r.isObject3D && r.position) out.copy(r.position);
		else this.world.camera.getWorldPosition(out);
	}

	private drawMap(): void
	{
		const cv = this.mapCanvas;
		if (!cv || !cv.getContext) return;
		const g = cv.getContext('2d');
		const base = this.baseMap();
		if (!g || !base) return;
		const W = cv.width, H = cv.height;
		const p = new THREE.Vector3();
		this.playerPos(p);
		const mpp = ZOOMS[this.zoom] || (HALF * 2 / Math.min(W, H));   // metres per map pixel
		const fit = ZOOMS[this.zoom] === 0;
		const cx = fit ? 0 : p.x, cz = fit ? 0 : p.z;
		const S = this.mapBaseScale;
		g.fillStyle = '#26546f';
		g.fillRect(0, 0, W, H);
		// crop of the base image around the centre
		const sw = W * mpp * S, sh = H * mpp * S;
		const sx = (cx + HALF) * S - sw / 2, sy = (cz + HALF) * S - sh / 2;
		g.drawImage(base, sx, sy, sw, sh, 0, 0, W, H);
		const toX = (x: number) => (x - cx) / mpp + W / 2, toY = (z: number) => (z - cz) / mpp + H / 2;
		this.mapView.cx = cx; this.mapView.cz = cz; this.mapView.mpp = mpp; this.mapView.W = W; this.mapView.H = H;
		// GPS route (RealismGPS)
		const gpsSys: any = this.world.realismGPSSystem;
		if (gpsSys && gpsSys.rn >= 2)
		{
			g.save();
			g.setTransform(1 / mpp, 0, 0, 1 / mpp, W / 2 - cx / mpp, H / 2 - cz / mpp);
			strokeRoute(g, gpsSys, 0, 1 / mpp, 3.5, gpsSys.settings.routeColor, this.routeDash);
			g.restore();
		}
		// landmarks
		g.font = '10px Arial, sans-serif';
		g.textAlign = 'center';
		for (const l of this.ctx.data.landmarks || [])
		{
			const x = toX(l.x), y = toY(l.z);
			if (x < -40 || x > W + 40 || y < -10 || y > H + 10) continue;
			g.fillStyle = '#ffdd57';
			g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
			if (!fit || this.ctx.data.landmarks.length < 20)
			{
				g.fillStyle = '#ffffff';
				g.strokeStyle = 'rgba(0,0,0,0.7)';
				g.lineWidth = 3;
				g.strokeText(l.name, x, y - 6);
				g.fillText(l.name, x, y - 6);
			}
		}
		// GPS blips + waypoint
		if (gpsSys)
		{
			const list = gpsSys.blipList || [];
			for (let i = 0; i < list.length; i++)
			{
				const b = list[i];
				if (b.shortRange && mpp > 2.1) continue;
				const x = toX(b.x), y = toY(b.z);
				if (x < -8 || x > W + 8 || y < -8 || y > H + 8) continue;
				const spr = blipSprite(b.icon, b.color, 6);
				if (spr) g.drawImage(spr, x - spr.width / 2, y - spr.height / 2);
			}
			const wp = gpsSys.waypoint;
			if (wp)
			{
				const x = Math.max(8, Math.min(W - 8, toX(wp.x))), y = Math.max(10, Math.min(H - 4, toY(wp.z)));
				const spr = blipSprite('waypoint', gpsSys.settings.waypointColor, 9);
				if (spr) g.drawImage(spr, x - spr.width / 2, y - spr.height / 2 - 6);
				const r = gpsSys.routeInfo ? gpsSys.routeInfo() : null;
				const txt = wp.label + (r ? ' \u00B7 ' + fmtDist(r.remaining) : '');
				g.font = 'bold 11px Arial, sans-serif';
				g.textAlign = 'left';
				g.fillStyle = 'rgba(0,0,0,0.6)';
				g.fillRect(26, 4, Math.min(W - 30, 8 + txt.length * 6.2), 16);
				g.fillStyle = '#e9c8ff';
				g.fillText(txt, 30, 16);
				g.textAlign = 'center';
			}
			else
			{
				g.font = '10px Arial, sans-serif';
				g.textAlign = 'left';
				g.fillStyle = 'rgba(0,0,0,0.55)';
				g.fillRect(4, H - 18, 112, 14);
				g.fillStyle = '#ffffff';
				g.fillText('Tap: set waypoint', 8, H - 8);
				g.textAlign = 'center';
			}
		}
		// pin (Locate)
		if (this.marker)
		{
			let mx = toX(this.marker.x), my = toY(this.marker.z);
			const off = mx < 8 || mx > W - 8 || my < 8 || my > H - 8;
			mx = Math.max(8, Math.min(W - 8, mx)); my = Math.max(8, Math.min(H - 8, my));
			g.fillStyle = off ? '#ffb36b' : '#ff9f1a';
			g.strokeStyle = '#ffffff';
			g.lineWidth = 2;
			g.beginPath(); g.arc(mx, my, 6, 0, Math.PI * 2); g.fill(); g.stroke();
			const dist = Math.round(Math.sqrt((this.marker.x - p.x) * (this.marker.x - p.x) + (this.marker.z - p.z) * (this.marker.z - p.z)));
			const label = this.marker.label + ' (' + (dist < 1000 ? dist + ' m' : (dist / 1000).toFixed(1) + ' km') + ')';
			g.fillStyle = '#ffffff';
			g.strokeStyle = 'rgba(0,0,0,0.75)';
			g.lineWidth = 3;
			const lx = Math.max(40, Math.min(W - 40, mx));
			g.strokeText(label, lx, my < 20 ? my + 18 : my - 9);
			g.fillText(label, lx, my < 20 ? my + 18 : my - 9);
		}
		// player arrow (points where the camera looks)
		this.world.camera.getWorldDirection(this.camDir);
		const ang = Math.atan2(this.camDir.z, this.camDir.x);
		const px = toX(p.x), py = toY(p.z);
		g.save();
		g.translate(px, py);
		g.rotate(ang);
		g.fillStyle = '#ff3b30';
		g.strokeStyle = '#ffffff';
		g.lineWidth = 2;
		g.beginPath();
		g.moveTo(9, 0); g.lineTo(-6, -6); g.lineTo(-3, 0); g.lineTo(-6, 6); g.closePath();
		g.stroke(); g.fill();
		g.restore();
		// north + scale
		g.fillStyle = 'rgba(0,0,0,0.55)';
		g.fillRect(4, 4, 18, 16);
		g.fillStyle = '#ffffff';
		g.fillText('N', 13, 16);
		const label = fit ? 'County' : Math.round(60 * mpp) + ' m';
		g.fillStyle = 'rgba(0,0,0,0.55)';
		g.fillRect(W - 72, H - 18, 68, 14);
		g.fillStyle = '#ffffff';
		g.fillText(label, W - 38, H - 8);
		if (!fit) { g.fillRect(W - 68, H - 22, 60, 2); }
	}
}
