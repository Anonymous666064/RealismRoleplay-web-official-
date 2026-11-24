/*
 * RealismLaptop.ts  (A15, contract C9)
 * ------------------------------------
 * A full-screen laptop: bezel, desktop wallpaper with icons, a taskbar with the game clock and a
 * browser window (tabs, back / forward / refresh / home, address bar with fake domains) showing the
 * in-game websites of RealismInternetSites.ts. Also the "internet clock" that drives social media
 * posts (RealismSocial.ts) and property income (RealismProperties.ts) over game time.
 *
 * (world as any).realismLaptop = { open(opts?: { onClose?: () => void; location?: string }): void; close(): void; isOpen: boolean }
 *   A14 calls open() after its walk-to-desk animation. For testing: (world as any).realismLaptop.open().
 *   location: a url ('svrealty.sv', 'viewtube.sv/watch?v=v3') or a site name to start on.
 * Also sets (world as any).realismProperties (C10), realismSocial, realismGuides.
 *
 * Input: while open, realismSetUIBlocking('laptop', true) (called before the mouse is released),
 * every key press stays inside the laptop (game keys never fire), Esc or the power button closes it
 * and the mouse is grabbed again if it was before. DOM exists only while open; video canvases and
 * thumbnails are released on close. While closed the cost is one cheap clock check per frame.
 *
 * Config (realism-config.js -> laptop, all optional):
 *   homepage: 'goggle.sv'           first page of the browser
 *   wallpaper: 'coast'              'coast' | 'night' | 'sunset' | 'plain'
 *   clock24: false                  24-hour clock in the taskbar
 *   maxTabs: 6
 */

import { RealismCtx } from './RealismContext';
import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismProperties } from './RealismProperties';
import { RealismSocial } from './RealismSocial';
import { buildSites, Site, GuideRegistry, defaultGuides, LaptopLike, esc, DEALER_NAMES } from './RealismInternetSites';
import { VideoPlayer, MapCache, drawAvatar, drawPhoto, drawFacade, drawMapPreview, drawVideoFrame, fmtTime } from './RealismInternetMedia';

export interface LaptopSettings { homepage: string; wallpaper: string; clock24: boolean; maxTabs: number; }

export function laptopSettings(cfg: any): LaptopSettings
{
	const raw: any = (cfg && cfg.laptop) || {};
	return {
		homepage: typeof raw.homepage === 'string' && raw.homepage.trim() ? raw.homepage.trim() : 'goggle.sv',
		wallpaper: /^(coast|night|sunset|plain)$/.test(raw.wallpaper) ? raw.wallpaper : 'coast',
		clock24: raw.clock24 === true,
		maxTabs: typeof raw.maxTabs === 'number' && raw.maxTabs >= 1 ? Math.min(12, Math.round(raw.maxTabs)) : 6,
	};
}

interface Tab { url: string; back: string[]; fwd: string[]; }

const DESKTOP: { url: string; label: string }[] = [
	{ url: 'goggle.sv', label: 'Browser' }, { url: 'chirp.sv', label: 'Chirp' }, { url: 'snapgram.sv', label: 'Snapgram' }, { url: 'viewtube.sv', label: 'ViewTube' },
	{ url: 'svrealty.sv', label: 'SV Realty' }, { url: 'veranomotors.sv', label: 'Verano Motors' }, { url: 'svbank.sv', label: 'Bank' }, { url: 'svjobs.sv', label: 'SV Jobs' },
	{ url: 'underground.onion', label: 'Onion' },
];

export class RealismLaptop implements IUpdatable, LaptopLike
{
	public updateOrder = 30;
	public world: any;
	public ctx: RealismCtx;
	public settings: LaptopSettings;
	public social: RealismSocial;
	public props: RealismProperties;
	public guides: GuideRegistry;
	public inputs: { [k: string]: string } = {};
	public state: { [k: string]: any } = {};
	public player: VideoPlayer = null;
	public sites: Site[];
	public isOpen = false;
	public winOpen = true;
	public tabs: Tab[] = [];
	public tab = 0;
	public api: any;
	public stats = { opens: 0, renders: 0, canvasesDrawn: 0, socialTicks: 0, payDays: 0 };
	public pageEl: any = null;
	public root: any = null;

	private siteMap: { [d: string]: Site } = {};
	private onCloseCb: () => void = null;
	private wasLocked = false;
	private desktopEl: any = null;
	private winEl: any = null;
	private tabsEl: any = null;
	private addrEl: any = null;
	private clockEl: any = null;
	private ppEl: any = null;
	private seekEl: any = null;
	private timeEl: any = null;
	private mapCache: MapCache = null;
	private watching = '';
	// clock
	private minutes = 0;
	private lastTickMin = 0;
	private lastHour = -1;
	private day = -1;
	private slowAcc = 2;
	private uiAcc = 0;
	private hookedEvents: any = null;
	private hookedEco: any = null;
	private lastTxId = '';
	private handlers: { [k: string]: (e: any) => void } = {};

	constructor(ctx: RealismCtx)
	{
		this.ctx = ctx;
		this.world = ctx.world;
		this.settings = laptopSettings(ctx.cfg);
		this.props = new RealismProperties(ctx);
		this.social = new RealismSocial(ctx);
		this.guides = new GuideRegistry();
		const gl = defaultGuides(ctx.data);
		for (let i = 0; i < gl.length; i++) this.guides.add(gl[i]);
		this.sites = buildSites();
		for (let i = 0; i < this.sites.length; i++) this.siteMap[this.sites[i].domain] = this.sites[i];
		this.tabs.push({ url: this.normal(this.settings.homepage), back: [], fwd: [] });
		this.minutes = this.social.minutes;
		this.lastTickMin = this.minutes;
		this.api = this.makeApi();
		this.bindWindowKeys();
	}

	private makeApi(): any
	{
		const self = this;
		return {
			open(opts?: { onClose?: () => void; location?: string }): void { self.open(opts); },
			close(): void { self.close(); },
			get isOpen(): boolean { return self.isOpen; },
			go(url: string): void { self.go(url); },
		};
	}

	// ------------------------------------------------------------------ open / close

	public open(opts?: { onClose?: () => void; location?: string }): void
	{
		const w = this.world;
		if (this.isOpen)
		{
			if (opts && opts.location) { this.winOpen = true; this.go(opts.location); }
			return;
		}
		this.onCloseCb = opts && typeof opts.onClose === 'function' ? opts.onClose : null;
		try { if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking('laptop', true); } catch (e) { /* ignore */ }
		try
		{
			this.wasLocked = typeof document !== 'undefined' && !!document.pointerLockElement;
			if (this.wasLocked)
			{
				if (w.realismUI && w.realismUI.exitLock) w.realismUI.exitLock(); else document.exitPointerLock();
			}
		}
		catch (e) { this.wasLocked = false; }
		this.isOpen = true;
		this.stats.opens++;
		this.state.notice = null;
		this.syncCarNames();
		this.buildDom();
		if (opts && opts.location) { this.winOpen = true; this.go(opts.location); }
		else this.render();
		this.updateClock();
	}

	public close(): void
	{
		if (!this.isOpen) return;
		const w = this.world;
		this.isOpen = false;
		this.disposePlayer();
		this.destroyDom();
		this.mapCache = null;
		try { if (typeof w.realismSetUIBlocking === 'function') w.realismSetUIBlocking('laptop', false); } catch (e) { /* ignore */ }
		if (this.wasLocked)
		{
			try
			{
				if (w.realismUI && w.realismUI.requestLock) w.realismUI.requestLock();
				else if (w.renderer && w.renderer.domElement.requestPointerLock) w.renderer.domElement.requestPointerLock();
			}
			catch (e) { /* the next click grabs the mouse */ }
		}
		const cb = this.onCloseCb;
		this.onCloseCb = null;
		if (cb) { try { cb(); } catch (e) { console.warn('[Realism] laptop onClose failed', e); } }
	}

	// ------------------------------------------------------------------ DOM

	private buildDom(): void
	{
		if (this.root) return;
		try
		{
			if (typeof document === 'undefined' || !document.body || !document.createElement) return;
			const root: any = document.createElement('div');
			root.id = 'rr-laptop';
			root.className = 'rr-lt rr-wp-' + this.settings.wallpaper;
			const device = document.createElement('div'); device.className = 'rr-lt-device';
			const bezel = document.createElement('div'); bezel.className = 'rr-lt-bezel';
			bezel.innerHTML = '<span class="rr-lt-cam"></span>';
			const screen = document.createElement('div'); screen.className = 'rr-lt-screen';
			const desk = document.createElement('div'); desk.className = 'rr-lt-desktop';
			const win = document.createElement('div'); win.className = 'rr-lt-win';
			const bar = document.createElement('div'); bar.className = 'rr-lt-titlebar';
			bar.innerHTML = '<span class="rr-lt-dots"><i class="rr-d-close" data-act="lt-win-close" title="Close window"></i><i class="rr-d-min" data-act="lt-win-close" title="Minimise"></i><i class="rr-d-max"></i></span>';
			const tabs = document.createElement('div'); tabs.className = 'rr-lt-tabs';
			bar.appendChild(tabs);
			const tool = document.createElement('div'); tool.className = 'rr-lt-toolbar';
			tool.innerHTML = '<button class="rr-lt-nav" data-act="lt-back" title="Back">&#8592;</button><button class="rr-lt-nav" data-act="lt-fwd" title="Forward">&#8594;</button>' +
				'<button class="rr-lt-nav" data-act="lt-refresh" title="Refresh">&#8635;</button><button class="rr-lt-nav" data-act="lt-home" title="Home">&#8962;</button>';
			const addrWrap = document.createElement('div'); addrWrap.className = 'rr-lt-addr';
			addrWrap.innerHTML = '<span class="rr-lt-lock">&#128274;</span>';
			const addr: any = document.createElement('input');
			addr.type = 'text';
			addr.className = 'rr-lt-addr-in';
			addr.setAttribute('spellcheck', 'false');
			addr.setAttribute('data-addr', '1');
			addrWrap.appendChild(addr);
			tool.appendChild(addrWrap);
			const page = document.createElement('div'); page.className = 'rr-lt-page';
			win.appendChild(bar); win.appendChild(tool); win.appendChild(page);
			const task = document.createElement('div'); task.className = 'rr-lt-taskbar';
			let pins = '<button class="rr-lt-start" data-act="lt-desktop" title="Desktop">&#9638;</button>';
			for (let i = 0; i < DESKTOP.length; i++) pins += this.iconHtml(DESKTOP[i].url, 'rr-lt-pin', '');
			task.innerHTML = '<div class="rr-lt-pins">' + pins + '</div>';
			const tray = document.createElement('div'); tray.className = 'rr-lt-tray';
			tray.innerHTML = '<span class="rr-lt-ico">&#x1F4F6;</span><span class="rr-lt-ico">&#x1F50B;</span>';
			const clock = document.createElement('div'); clock.className = 'rr-lt-clock';
			tray.appendChild(clock);
			const power = document.createElement('button'); power.className = 'rr-lt-power'; power.setAttribute('data-act', 'lt-power'); power.setAttribute('title', 'Shut down (Esc)'); power.innerHTML = '&#x23FB;';
			tray.appendChild(power);
			task.appendChild(tray);
			screen.appendChild(desk); screen.appendChild(win); screen.appendChild(task);
			bezel.appendChild(screen);
			device.appendChild(bezel);
			const base = document.createElement('div'); base.className = 'rr-lt-base'; base.innerHTML = '<span>Esc to close</span>';
			device.appendChild(base);
			root.appendChild(device);
			let icons = '';
			for (let i = 0; i < DESKTOP.length; i++) icons += this.iconHtml(DESKTOP[i].url, 'rr-lt-icon', DESKTOP[i].label);
			desk.innerHTML = icons;
			this.root = root; this.desktopEl = desk; this.winEl = win; this.tabsEl = tabs; this.addrEl = addr; this.pageEl = page; this.clockEl = clock;
			this.bindDom(root);
			document.body.appendChild(root);
		}
		catch (e) { console.warn('[Realism] laptop UI could not be built', e); }
	}

	private iconHtml(url: string, cls: string, label: string): string
	{
		const s = this.siteMap[this.parse(url).domain];
		const color = s ? s.color : '#555';
		const ic = url === 'goggle.sv' ? '&#127760;' : s ? s.icon : '?';
		return '<a class="' + cls + '" data-act="lt-open" data-arg="' + esc(url) + '" title="' + esc(label || (s ? s.name : url)) + '"><span class="rr-lt-ic" style="background:' + color + '">' + ic + '</span>' + (label ? '<span class="rr-lt-lbl">' + esc(label) + '</span>' : '') + '</a>';
	}

	private destroyDom(): void
	{
		if (!this.root) return;
		try
		{
			if (this.pageEl) this.pageEl.innerHTML = '';
			if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
			else if (document.body && document.body.removeChild) document.body.removeChild(this.root);
		}
		catch (e) { /* ignore */ }
		this.root = this.desktopEl = this.winEl = this.tabsEl = this.addrEl = this.pageEl = this.clockEl = null;
		this.ppEl = this.seekEl = this.timeEl = null;
	}

	private bindDom(root: any): void
	{
		const stop = (e: any) => { e.stopPropagation(); };
		root.addEventListener('mousedown', stop, false);
		root.addEventListener('mouseup', stop, false);
		root.addEventListener('wheel', stop, false);
		root.addEventListener('contextmenu', (e: any) => { e.stopPropagation(); }, false);
		root.addEventListener('keypress', stop, false);
		root.addEventListener('click', (e: any) =>
		{
			let t: any = e.target;
			while (t && t !== root && !(t.getAttribute && (t.getAttribute('data-act') || t.getAttribute('data-go')))) t = t.parentNode;
			if (!t || t === root || !t.getAttribute) return;
			if (t.disabled) return;
			e.preventDefault();
			const go = t.getAttribute('data-go');
			if (go) this.go(go);
			else this.act(t.getAttribute('data-act'), t.getAttribute('data-arg') || '');
		}, false);
		const onInput = (e: any) =>
		{
			const t: any = e.target;
			if (!t || !t.getAttribute) return;
			const key = t.getAttribute('data-input');
			if (!key) return;
			this.inputs[key] = String(t.value || '');
			const ch = t.getAttribute('data-change');
			if (ch && (e.type === 'change' || key === 'seek')) this.act(ch, key === 'seek' ? String(t.value) : (t.getAttribute('data-arg') || ''));
		};
		root.addEventListener('input', onInput, false);
		root.addEventListener('change', onInput, false);
		root.addEventListener('keydown', (e: any) =>
		{
			e.stopPropagation();     // game keys never see what you type
			if (e.key !== 'Enter' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
			const t: any = e.target;
			if (!t || !t.getAttribute) return;
			if (t.getAttribute('data-addr')) { e.preventDefault(); this.go(String(t.value || '')); return; }
			const ent = t.getAttribute('data-enter');
			if (ent) { e.preventDefault(); const key = t.getAttribute('data-input'); if (key) this.inputs[key] = String(t.value || ''); this.act(ent, t.getAttribute('data-arg') || ''); }
		}, false);
	}

	/** Window capture: Esc closes; while open, keys outside the laptop never reach the game. */
	private bindWindowKeys(): void
	{
		try
		{
			if (typeof window === 'undefined' || !(window as any).addEventListener) return;
			this.handlers.key = (e: any) => this.onWindowKey(e);
			window.addEventListener('keydown', this.handlers.key as any, true);
		}
		catch (e) { /* headless */ }
	}

	/** Public for tests. Returns true when the key was consumed. */
	public onWindowKey(e: any): boolean
	{
		if (!this.isOpen) return false;
		if (e.code === 'Escape' || e.key === 'Escape')
		{
			if (e.preventDefault) e.preventDefault();
			if (e.stopImmediatePropagation) e.stopImmediatePropagation();   // RealismUI must not open the pause menu
			this.close();
			return true;
		}
		const t: any = e.target;
		let inside = false;
		try { inside = !!(this.root && t && this.root.contains && this.root.contains(t)); } catch (x) { inside = false; }
		if (!inside && e.stopImmediatePropagation) e.stopImmediatePropagation();
		return !inside;
	}

	// ------------------------------------------------------------------ navigation

	public parse(url: string): { domain: string; path: string; q: { [k: string]: string }; url: string }
	{
		let u = String(url || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '');
		if (!u) u = this.settings.homepage;
		const slash = u.search(/[\/?]/);
		const domain = (slash < 0 ? u : u.slice(0, slash)).toLowerCase();
		let rest = slash < 0 ? '/' : u.slice(slash);
		if (rest.charAt(0) === '?') rest = '/' + rest;
		const qi = rest.indexOf('?');
		const path = qi < 0 ? rest : rest.slice(0, qi);
		const q: { [k: string]: string } = {};
		if (qi >= 0)
		{
			const parts = rest.slice(qi + 1).split('&');
			for (let i = 0; i < parts.length; i++)
			{
				if (!parts[i]) continue;
				const eq = parts[i].indexOf('=');
				try { q[decodeURIComponent(eq < 0 ? parts[i] : parts[i].slice(0, eq))] = eq < 0 ? '' : decodeURIComponent(parts[i].slice(eq + 1).replace(/\+/g, ' ')); }
				catch (e) { /* bad escape */ }
			}
		}
		return { domain: domain, path: path || '/', q: q, url: domain + (path === '/' && qi < 0 ? '' : rest) };
	}

	/** Normalises what was typed: a known domain, a site name, or a search. */
	public normal(input: string): string
	{
		const s = String(input || '').trim();
		const p = this.parse(s);
		if (this.siteMap[p.domain]) return p.url;
		const low = s.toLowerCase();
		for (let i = 0; i < this.sites.length; i++) if (this.sites[i].name.toLowerCase() === low || this.sites[i].domain.split('.')[0] === low) return this.sites[i].domain;
		if (/^[a-z0-9\-]+\.[a-z]+/i.test(s) && s.indexOf(' ') < 0) return p.url;     // unknown domain: 404 page
		return 'goggle.sv/search?q=' + encodeURIComponent(s);
	}

	public get current(): string { const t = this.tabs[this.tab]; return t ? t.url : this.settings.homepage; }

	public go(url: string, noHistory?: boolean): void
	{
		const t = this.tabs[this.tab] || (this.tabs[0] = { url: this.settings.homepage, back: [], fwd: [] });
		const next = this.normal(url);
		if (!noHistory && next !== t.url) { t.back.push(t.url); if (t.back.length > 30) t.back.shift(); t.fwd.length = 0; }
		if (next !== t.url) this.state.notice = null;
		t.url = next;
		this.winOpen = true;
		this.render();
	}

	public back(): void { const t = this.tabs[this.tab]; if (!t || !t.back.length) return; t.fwd.push(t.url); t.url = t.back.pop(); this.state.notice = null; this.render(); }
	public forward(): void { const t = this.tabs[this.tab]; if (!t || !t.fwd.length) return; t.back.push(t.url); t.url = t.fwd.pop(); this.state.notice = null; this.render(); }

	public notice(text: string, err?: boolean): void { this.state.notice = { text: text, err: !!err }; }

	/** Runs a laptop or site action (data-act). Public for tests. */
	public act(a: string, arg: string): void
	{
		if (!a) return;
		switch (a)
		{
			case 'lt-power': this.close(); return;
			case 'lt-back': this.back(); return;
			case 'lt-fwd': this.forward(); return;
			case 'lt-refresh': this.render(); return;
			case 'lt-home': this.go(this.settings.homepage); return;
			case 'lt-open': this.winOpen = true; if (this.parse(arg).domain !== this.parse(this.current).domain) this.go(arg); else this.render(); return;
			case 'lt-desktop': this.winOpen = !this.winOpen; this.render(); return;
			case 'lt-win-close': this.winOpen = false; this.render(); return;
			case 'lt-tab': this.tab = Math.max(0, Math.min(this.tabs.length - 1, parseInt(arg, 10) || 0)); this.render(); return;
			case 'lt-newtab':
				if (this.tabs.length >= this.settings.maxTabs) return;
				this.tabs.push({ url: this.settings.homepage, back: [], fwd: [] });
				this.tab = this.tabs.length - 1;
				this.render();
				return;
			case 'lt-closetab':
			{
				const i = parseInt(arg, 10) || 0;
				if (this.tabs.length <= 1) { this.winOpen = false; this.render(); return; }
				this.tabs.splice(i, 1);
				if (this.tab >= this.tabs.length) this.tab = this.tabs.length - 1;
				this.render();
				return;
			}
		}
		const s = this.siteMap[this.parse(this.current).domain];
		if (s && s.act)
		{
			let rerender = false;
			try { rerender = s.act(a, arg, this); }
			catch (e) { console.warn('[Realism] site action failed', a, e); }
			if (rerender && this.isOpen && this.parse(this.current).domain === s.domain) this.render();
			if (a === 'vt-play' || a === 'vt-seek') this.updatePlayerUi(true);
		}
	}

	// ------------------------------------------------------------------ rendering

	/** Builds the current page as HTML (also used headless). */
	public pageHtml(url?: string): { title: string; html: string; theme: string }
	{
		const p = this.parse(url || this.current);
		const s = this.siteMap[p.domain];
		if (!s)
		{
			return { title: 'Not found', theme: 'rr-th-err', html: '<div class="rr-404"><h2>This site can\'t be reached</h2><div class="rr-dim">' + esc(p.domain) + '\'s server IP address could not be found.</div>' +
				'<div class="rr-pad"><a class="rr-ln" data-go="goggle.sv/search?q=' + esc(encodeURIComponent(p.domain)) + '">Search Goggle for ' + esc(p.domain) + '</a></div></div>' };
		}
		let html = '';
		try { html = s.render(p.path, p.q, this); }
		catch (e) { console.warn('[Realism] page failed', p.url, e); html = '<div class="rr-empty">This page isn\'t working right now.</div>'; }
		return { title: s.name, html: html, theme: s.theme || '' };
	}

	public render(): void
	{
		this.stats.renders++;
		const pg = this.pageHtml();
		const p = this.parse(this.current);
		// a different page: release the old video player
		const watchId = p.domain === 'viewtube.sv' && p.path.indexOf('/watch') === 0 ? (p.q.v || '') : '';
		if (this.player && (!watchId || this.player.video.id !== watchId || !this.winOpen)) this.disposePlayer();
		if (watchId && watchId !== this.watching) { this.social.view(watchId); }
		this.watching = watchId;
		if (!this.root) return;
		try
		{
			if (this.winEl) this.winEl.style.display = this.winOpen ? '' : 'none';
			let tabs = '';
			for (let i = 0; i < this.tabs.length; i++)
			{
				const tp = this.parse(this.tabs[i].url), ts = this.siteMap[tp.domain];
				tabs += '<span class="rr-lt-tab' + (i === this.tab ? ' rr-sel' : '') + '" data-act="lt-tab" data-arg="' + i + '"><b class="rr-lt-tab-ic" style="background:' + (ts ? ts.color : '#777') + '">' + (ts ? ts.icon : '!') + '</b>' + esc(ts ? ts.name : tp.domain) +
					'<i data-act="lt-closetab" data-arg="' + i + '">&times;</i></span>';
			}
			if (this.tabs.length < this.settings.maxTabs) tabs += '<span class="rr-lt-newtab" data-act="lt-newtab" title="New tab">+</span>';
			if (this.tabsEl) this.tabsEl.innerHTML = tabs;
			if (this.addrEl) this.addrEl.value = (p.domain.slice(-6) === '.onion' ? '' : 'https://') + p.url;
			if (this.pageEl && this.winOpen)
			{
				this.pageEl.className = 'rr-lt-page ' + pg.theme;
				this.pageEl.innerHTML = pg.html;
				if (this.pageEl.scrollTop !== undefined && this.lastRendered !== this.current) this.pageEl.scrollTop = 0;
				this.lastRendered = this.current;
				this.mount();
			}
		}
		catch (e) { console.warn('[Realism] laptop render failed', e); }
	}

	private lastRendered = '';

	/** Draws the page's canvases and attaches the video player. */
	private mount(): void
	{
		const page = this.pageEl;
		if (!page || !page.querySelectorAll) return;
		const list: any = page.querySelectorAll('canvas[data-draw]');
		for (let i = 0; list && i < list.length; i++)
		{
			const c = list[i];
			const g = c.getContext ? c.getContext('2d') : null;
			if (g && this.drawSpec(String(c.getAttribute('data-draw') || ''), g, c.width, c.height)) this.stats.canvasesDrawn++;
		}
		const pc: any = page.querySelector ? page.querySelector('canvas[data-player]') : null;
		if (pc && this.watching)
		{
			if (this.player && this.player.video.id === this.watching) this.player.rebind(pc);
			else
			{
				const v: any = this.social.find('video', this.watching);
				if (v)
				{
					if (!this.mapCache) this.mapCache = new MapCache(this.ctx.data);
					this.player = new VideoPlayer(pc, v, this.mapCache);
				}
			}
			this.ppEl = page.querySelector('.rr-vt-pp');
			this.seekEl = page.querySelector('.rr-vt-seek');
			this.timeEl = page.querySelector('.rr-vt-time');
		}
	}

	/** 'avatar:handle' | 'photo:id' | 'facade:b12' | 'map:b12' | 'thumb:v3'. Public for tests. */
	public drawSpec(spec: string, g: any, w: number, h: number): boolean
	{
		const i = spec.indexOf(':');
		if (i < 0) return false;
		const kind = spec.slice(0, i), id = spec.slice(i + 1);
		try
		{
			if (kind === 'avatar') { const a = this.social.account(id); drawAvatar(g, Math.min(w, h), a.n, a.hue); return true; }
			if (kind === 'photo') { const s: any = this.social.find('snap', id); if (!s) return false; drawPhoto(g, w, h, s.kind, s.seed, s.hour || 12); return true; }
			if (kind === 'thumb') { const v: any = this.social.find('video', id); if (!v) return false; if (v.kind === 'timelapse' && !this.mapCache) this.mapCache = new MapCache(this.ctx.data); drawVideoFrame(g, w, h, v, Math.max(3, v.dur * 0.35), this.mapCache); return true; }
			const r = this.props.get(id);
			if (!r) return false;
			if (kind === 'facade') { drawFacade(g, w, h, r); return true; }
			if (kind === 'map') { drawMapPreview(g, w, h, this.ctx.data, r.x, r.z, 220, this.ctx.data.buildings); return true; }
		}
		catch (e) { /* a broken drawing never breaks the page */ }
		return false;
	}

	private disposePlayer(): void
	{
		if (this.player) this.player.dispose();
		this.player = null;
		this.ppEl = this.seekEl = this.timeEl = null;
	}

	private updatePlayerUi(force?: boolean): void
	{
		const p = this.player;
		if (!p) return;
		try
		{
			if (this.ppEl) this.ppEl.innerHTML = p.playing ? '&#10074;&#10074;' : '&#9654;';
			if (this.seekEl && (force || p.playing)) this.seekEl.value = p.time.toFixed(1);
			if (this.timeEl) this.timeEl.textContent = fmtTime(p.time) + ' / ' + fmtTime(p.video.dur);
		}
		catch (e) { /* ignore */ }
	}

	private updateClock(): void
	{
		if (!this.clockEl) return;
		const t = this.world.realismTime;
		const h = t && isFinite(t.hour) ? t.hour : (this.minutes / 60) % 24;
		const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
		const eco = this.world.realismEconomy;
		const day = eco && eco.gameDay ? eco.gameDay : Math.floor(this.minutes / 1440) + 1;
		let s: string;
		if (this.settings.clock24) s = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
		else s = ((hh + 11) % 12 + 1) + ':' + (mm < 10 ? '0' : '') + mm + (hh < 12 ? ' AM' : ' PM');
		try { this.clockEl.innerHTML = '<b>' + s + '</b><span>Day ' + day + '</span>'; } catch (e) { /* ignore */ }
	}

	private syncCarNames(): void
	{
		try
		{
			const P: any = this.world.realismPhone || (this.world.realismUI ? this.world.realismUI.phone : null);
			const apps = P && P.apps && typeof P.apps.catalog === 'function' ? P.apps : null;
			if (!apps) return;
			const names = apps.catalog().filter((i: any) => i.type !== 'heli' && i.type !== 'airplane').map((i: any) => i.name);
			if (names.length) this.social.carNames = names;
		}
		catch (e) { /* keep defaults */ }
	}

	// ------------------------------------------------------------------ per frame (cheap)

	public update(timeStep: number, unscaled: number): void
	{
		const w = this.world;
		if (w.realismPaused) return;
		const u = unscaled || timeStep || 0;
		const t = w.realismTime;
		if (t && isFinite(t.hour))
		{
			if (this.lastHour < 0)
			{
				// first frame with a game clock: line the social clock up with it (no catch-up)
				this.lastHour = t.hour;
				this.minutes = Math.floor(this.minutes / 1440) * 1440 + t.hour * 60;
				this.social.setClock(this.minutes);
				this.lastTickMin = this.minutes;
			}
			let dh = t.hour - this.lastHour;
			if (dh < -12) dh += 24; else if (dh < 0) dh = 0;
			this.lastHour = t.hour;
			this.minutes += dh * 60;
		}
		else this.minutes += u;      // no day / night: one real second = one game minute
		if (this.minutes - this.lastTickMin >= 1)
		{
			this.lastTickMin = this.minutes;
			this.stats.socialTicks++;
			this.social.tick(this.minutes);
			const day = Math.floor(this.minutes / 1440);
			if (day !== this.day)
			{
				const first = this.day < 0;
				this.day = day;
				if (this.props.onDay(day) !== 0 || !first) this.stats.payDays++;
			}
		}
		this.slowAcc += u;
		if (this.slowAcc >= 2) { this.slowAcc = 0; this.hookEvents(); this.props.ensureBlips(); }
		if (!this.isOpen) return;
		if (this.player && this.winOpen && this.watching)
		{
			if (this.player.step(u)) this.updatePlayerUi(false);
			else if (!this.player.playing && this.player.ended) { this.player.ended = false; this.updatePlayerUi(true); }
		}
		this.uiAcc += u;
		if (this.uiAcc >= 0.5) { this.uiAcc = 0; this.updateClock(); }
	}

	/** Game minutes on the internet clock (tests). */
	public get gameMinutes(): number { return this.minutes; }

	// ------------------------------------------------------------------ events

	private hookEvents(): void
	{
		const w = this.world;
		const ev = w.realismEvents;
		if (ev && ev !== this.hookedEvents && typeof ev.on === 'function')
		{
			if (this.hookedEvents && typeof this.hookedEvents.off === 'function')
			{
				try { this.hookedEvents.off('crime', this.handlers.crime); this.hookedEvents.off('carStolen', this.handlers.stolen); this.hookedEvents.off('propertyBought', this.handlers.prop); } catch (e) { /* ignore */ }
			}
			if (!this.handlers.crime)
			{
				this.handlers.crime = (d: any) => this.social.onCrime(d);
				this.handlers.stolen = (d: any) => this.social.onCarStolen(d);
				this.handlers.prop = (d: any) => this.social.onPropertyBought(d);
			}
			ev.on('crime', this.handlers.crime);
			ev.on('carStolen', this.handlers.stolen);
			ev.on('propertyBought', this.handlers.prop);
			this.hookedEvents = ev;
		}
		const eco = w.realismEconomy;
		if (eco && eco !== this.hookedEco && typeof eco.onChange === 'function')
		{
			this.hookedEco = eco;
			this.lastTxId = this.lastTx() ? this.lastTx().id : '';
			eco.onChange(() => this.onMoney());
		}
	}

	private lastTx(): any
	{
		const impl = this.world.realismEconomyImpl;
		if (impl && impl.txs && impl.txs.length) return impl.txs[impl.txs.length - 1];
		const eco = this.world.realismEconomy;
		const h = eco && typeof eco.history === 'function' ? eco.history() : null;
		return h && h.length ? h[0] : null;
	}

	/** A car bought at a dealer (phone app or a website) shows up on Chirp. */
	private onMoney(): void
	{
		const tx = this.lastTx();
		if (!tx || tx.id === this.lastTxId) return;
		this.lastTxId = tx.id;
		if (tx.amount < 0 && DEALER_NAMES.indexOf(tx.merchant) >= 0 && !/^Refund/.test(tx.description)) this.social.onCarBought(tx.description);
	}
}

/** Minimal realismEvents (C14) when nobody created it yet; A12's version replaces it and we re-hook. */
function ensureEvents(w: any): void
{
	if (w.realismEvents && typeof w.realismEvents.emit === 'function') return;
	const map: { [k: string]: ((d: any) => void)[] } = {};
	w.realismEvents = {
		on(name: string, cb: (d: any) => void): void { if (typeof cb === 'function') (map[name] || (map[name] = [])).push(cb); },
		off(name: string, cb: (d: any) => void): void { const l = map[name]; if (!l) return; const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); },
		emit(name: string, data?: any): void { const l = map[name]; if (!l) return; const c = l.slice(0); for (let i = 0; i < c.length; i++) { try { c[i](data); } catch (e) { console.warn('[Realism] event listener failed', name, e); } } },
	};
}

/** RealismWorldBuilder hook. Never throws. */
export function buildInternet(ctx: RealismCtx): void
{
	const w: any = ctx.world;
	try
	{
		ensureEvents(w);
		const lt = new RealismLaptop(ctx);
		w.registerUpdatable(lt);
		w.realismLaptop = lt.api;
		w.realismLaptopImpl = lt;
		w.realismProperties = lt.props.api;
		w.realismPropertiesImpl = lt.props;
		w.realismSocial = lt.social;
		w.realismGuides = lt.guides.api();
	}
	catch (e) { console.warn('[Realism] Laptop / internet failed to build', e); }
}
