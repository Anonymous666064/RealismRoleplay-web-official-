/*
 * RealismWeaponWheel.ts
 * ---------------------
 * The 5-slot radial weapon wheel (HTML/CSS, opened with Tab, picked with the mouse pointer)
 * and the weapon HUD (ammo bottom-right, crosshair, hit marker, short messages).
 *
 * The wheel is a full-screen overlay, so clicks never reach the game canvas while it is open.
 * Slots go clockwise from the top. Hovering a sector highlights it; a click or releasing Tab picks it.
 */

export interface WheelSlot
{
	id: string;          // weapon id, e.g. 'pistol'
	name: string;        // shown name
	icon: string;        // 'fists' | 'pistol' | 'smg' | 'shotgun' | 'rifle' (built-in icon)
	ammo: string;        // e.g. '12 / 72', '' for fists
	empty: boolean;      // no ammo at all
}

/** Small inline SVG silhouettes (facing right), 64 x 32 view box. */
const ICONS: { [k: string]: string } = {
	fists: '<path d="M20 8h18a6 6 0 0 1 6 6v6a8 8 0 0 1-8 8H24a6 6 0 0 1-6-6V10a2 2 0 0 1 2-2zM22 8v8M28 8v8M34 8v8M40 9v7" stroke="#fff" stroke-width="2" fill="rgba(255,255,255,0.15)"/>',
	pistol: '<path d="M14 9h34v6H30l-2 3h-4l-2 9h-7l2-10h-3z" fill="#fff"/>',
	smg: '<path d="M8 10h6v4h6v-5h30v5h4v3H40l-2 2v8h-5v-8h-4l-3 7h-6l2-7h-6l-2 3H8z" fill="#fff"/>',
	shotgun: '<path d="M2 15l14-3h8v-2h38v3H40v3H26l-4 3v4l-9 3-2-3 5-3v-2l-3-1z" fill="#fff"/>',
	rifle: '<path d="M3 12h16l2-2h22v-3h5v3h13v3H50v3h-6l-1 2 2 8h-5l-2-7h-4l-2 6h-5l2-6h-4l-2-2H3z" fill="#fff"/>',
};

let styleAdded = false;

export class WeaponWheel
{
	public isOpen = false;
	public hover = -1;
	public openedAt = 0;
	private root: HTMLElement = null;
	private slotEls: HTMLElement[] = [];
	private center: HTMLElement = null;
	private slots: WheelSlot[] = [];
	private current = 0;
	private radius = 150;
	private onPick: (index: number) => void;
	private onCancel: () => void;

	constructor(onPick: (index: number) => void, onCancel: () => void)
	{
		this.onPick = onPick;
		this.onCancel = onCancel;
	}

	private build(): boolean
	{
		if (this.root !== null) return true;
		if (typeof document === 'undefined' || !document.body || !document.createElement) return false;
		try
		{
			if (!styleAdded)
			{
				const st = document.createElement('style');
				st.id = 'realism-wheel-style';
				st.textContent =
					'.rw-root{position:fixed;left:0;top:0;width:100%;height:100%;z-index:10050;display:none;cursor:default;' +
					'background:radial-gradient(circle at 50% 50%,rgba(0,0,0,0.25) 0,rgba(0,0,0,0.55) 260px,rgba(0,0,0,0.2) 420px);user-select:none;-webkit-user-select:none}' +
					'.rw-ring{position:absolute;left:50%;top:50%;width:0;height:0}' +
					'.rw-slot{position:absolute;width:118px;height:92px;margin:-46px 0 0 -59px;border-radius:14px;background:rgba(20,22,26,0.82);' +
					'border:2px solid rgba(255,255,255,0.18);color:#fff;font:600 13px sans-serif;text-align:center;box-sizing:border-box;padding-top:6px;transition:transform .08s,background .08s,border-color .08s}' +
					'.rw-slot svg{display:block;margin:0 auto;width:64px;height:32px}' +
					'.rw-slot .rw-n{margin-top:4px;letter-spacing:.4px}' +
					'.rw-slot .rw-a{font:500 12px monospace;color:#cfd6df;margin-top:2px}' +
					'.rw-slot .rw-k{position:absolute;left:7px;top:4px;font:700 11px sans-serif;color:rgba(255,255,255,0.5)}' +
					'.rw-slot.rw-cur{border-color:rgba(255,213,74,0.75)}' +
					'.rw-slot.rw-hov{background:rgba(255,213,74,0.92);color:#111;border-color:#fff;transform:scale(1.12)}' +
					'.rw-slot.rw-hov svg path{fill:#111;stroke:#111}' +
					'.rw-slot.rw-hov .rw-a{color:#222}.rw-slot.rw-hov .rw-k{color:rgba(0,0,0,0.5)}' +
					'.rw-slot.rw-empty{opacity:.55}' +
					'.rw-center{position:absolute;left:50%;top:50%;width:150px;margin-left:-75px;margin-top:-24px;text-align:center;color:#fff;font:700 16px sans-serif;text-shadow:0 1px 3px #000;pointer-events:none}' +
					'.rw-center small{display:block;font:500 12px sans-serif;color:#cfd6df;margin-top:4px}';
				document.head.appendChild(st);
				styleAdded = true;
			}
			const root = document.createElement('div');
			root.className = 'rw-root';
			const ring = document.createElement('div');
			ring.className = 'rw-ring';
			root.appendChild(ring);
			const center = document.createElement('div');
			center.className = 'rw-center';
			root.appendChild(center);
			for (let i = 0; i < 5; i++)
			{
				const s = document.createElement('div');
				s.className = 'rw-slot';
				const a = -Math.PI / 2 + (i / 5) * Math.PI * 2;
				s.style.left = Math.round(Math.cos(a) * this.radius) + 'px';
				s.style.top = Math.round(Math.sin(a) * this.radius) + 'px';
				ring.appendChild(s);
				this.slotEls.push(s);
			}
			root.addEventListener('mousemove', (e: MouseEvent) => this.onMove(e), false);
			root.addEventListener('mousedown', (e: MouseEvent) =>
			{
				e.preventDefault(); e.stopPropagation();
				if (e.button === 2) { this.onCancel(); return; }
				this.onMove(e);
				if (this.hover >= 0) this.onPick(this.hover);
				else this.onCancel();
			}, false);
			root.addEventListener('contextmenu', (e: Event) => { e.preventDefault(); e.stopPropagation(); }, false);
			root.addEventListener('wheel', (e: Event) => { e.preventDefault(); e.stopPropagation(); }, false);
			document.body.appendChild(root);
			this.root = root;
			this.center = center;
			return true;
		}
		catch (e) { console.warn('[Realism] weapon wheel UI unavailable', e); this.root = null; return false; }
	}

	private onMove(e: MouseEvent): void
	{
		const w = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 800;
		const h = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 600;
		this.setHoverFromPoint(e.clientX - w / 2, e.clientY - h / 2);
	}

	/** Picks the sector under a point relative to the screen centre (px). Dead zone in the middle. */
	public setHoverFromPoint(dx: number, dy: number): void
	{
		let idx = -1;
		if (dx * dx + dy * dy > 45 * 45)
		{
			// angle clockwise from the top, 0..2pi
			let a = Math.atan2(dy, dx) + Math.PI / 2;
			if (a < 0) a += Math.PI * 2;
			idx = Math.floor((a + Math.PI / 5) / (Math.PI * 2 / 5)) % 5;
		}
		this.setHover(idx);
	}

	public setHover(i: number): void
	{
		if (i === this.hover) return;
		this.hover = i;
		this.refresh();
	}

	public open(slots: WheelSlot[], current: number, now: number): void
	{
		this.slots = slots;
		this.current = current;
		this.hover = -1;
		this.isOpen = true;
		this.openedAt = now;
		if (!this.build()) return;
		this.refresh();
		this.root.style.display = 'block';
	}

	public close(): void
	{
		this.isOpen = false;
		this.hover = -1;
		if (this.root !== null) this.root.style.display = 'none';
	}

	private refresh(): void
	{
		if (this.root === null) return;
		for (let i = 0; i < this.slotEls.length; i++)
		{
			const s = this.slotEls[i], d = this.slots[i];
			if (!d) { s.style.display = 'none'; continue; }
			s.style.display = 'block';
			s.className = 'rw-slot' + (i === this.current ? ' rw-cur' : '') + (i === this.hover ? ' rw-hov' : '') + (d.empty ? ' rw-empty' : '');
			s.innerHTML = '<span class="rw-k">' + (i + 1) + '</span><svg viewBox="0 0 64 32">' + (ICONS[d.icon] || ICONS.pistol) + '</svg>' +
				'<div class="rw-n">' + esc(d.name) + '</div><div class="rw-a">' + esc(d.ammo || '\u00a0') + '</div>';
		}
		const show = this.hover >= 0 ? this.slots[this.hover] : this.slots[this.current];
		if (this.center && show) this.center.innerHTML = esc(show.name) + '<small>' + (this.hover >= 0 ? 'Click or release Tab' : 'Point at a weapon') + '</small>';
	}

	public dispose(): void
	{
		try { if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root); } catch (e) { /* ignore */ }
		this.root = null;
	}
}

function esc(s: string): string
{
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Ammo counter, crosshair, hit marker and a one-line message. */
export class WeaponHud
{
	private ammo: HTMLElement = null;
	private cross: HTMLElement = null;
	private dot: HTMLElement = null;
	private hit: HTMLElement = null;
	private msg: HTMLElement = null;
	private lastAmmo = '';
	private crossGap = -1;
	private crossShown = false;
	private dotShown = false;
	private hitUntil = 0;
	private msgUntil = 0;
	private ok = false;

	constructor()
	{
		if (typeof document === 'undefined' || !document.body || !document.createElement) return;
		try
		{
			const a = document.createElement('div');
			a.style.cssText = 'position:fixed;right:22px;bottom:22px;z-index:9998;color:#fff;font:700 15px sans-serif;text-shadow:0 1px 3px #000;' +
				'background:rgba(0,0,0,0.38);padding:6px 12px;border-radius:6px;pointer-events:none;display:none;text-align:right;min-width:110px';
			document.body.appendChild(a);
			const c = document.createElement('div');
			c.style.cssText = 'position:fixed;left:50%;top:50%;width:0;height:0;z-index:9998;pointer-events:none;display:none';
			c.innerHTML = ['0,-1', '0,1', '-1,0', '1,0'].map((v) =>
			{
				const p = v.split(',').map(Number);
				const vert = p[0] === 0;
				return '<div data-d="' + v + '" style="position:absolute;background:#fff;box-shadow:0 0 2px #000;' +
					(vert ? 'width:2px;height:8px;margin-left:-1px;' : 'height:2px;width:8px;margin-top:-1px;') + '"></div>';
			}).join('') + '<div style="position:absolute;left:-1px;top:-1px;width:2px;height:2px;background:#fff"></div>';
			document.body.appendChild(c);
			const d = document.createElement('div');
			d.style.cssText = 'position:fixed;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:2px;background:rgba(255,255,255,0.75);box-shadow:0 0 2px #000;z-index:9998;pointer-events:none;display:none';
			document.body.appendChild(d);
			const h = document.createElement('div');
			h.style.cssText = 'position:fixed;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;z-index:9999;pointer-events:none;display:none;' +
				'background:linear-gradient(45deg,transparent 45%,#fff 45%,#fff 55%,transparent 55%),linear-gradient(-45deg,transparent 45%,#fff 45%,#fff 55%,transparent 55%)';
			document.body.appendChild(h);
			const m = document.createElement('div');
			m.style.cssText = 'position:fixed;right:22px;bottom:64px;z-index:9998;color:#ffd54a;font:700 14px sans-serif;text-shadow:0 1px 3px #000;pointer-events:none;display:none';
			document.body.appendChild(m);
			this.ammo = a; this.cross = c; this.dot = d; this.hit = h; this.msg = m;
			this.ok = true;
		}
		catch (e) { this.ok = false; }
	}

	public setAmmo(text: string): void
	{
		if (!this.ok || text === this.lastAmmo) return;
		this.lastAmmo = text;
		this.ammo.style.display = text ? 'block' : 'none';
		this.ammo.innerHTML = text;
	}

	/** gap: crosshair arm distance from the centre, px. */
	public setCrosshair(show: boolean, gap: number, dot: boolean): void
	{
		if (!this.ok) return;
		if (show !== this.crossShown) { this.crossShown = show; this.cross.style.display = show ? 'block' : 'none'; }
		const showDot = dot && !show;
		if (showDot !== this.dotShown) { this.dotShown = showDot; this.dot.style.display = showDot ? 'block' : 'none'; }
		if (!show) return;
		const g = Math.round(gap);
		if (g === this.crossGap) return;
		this.crossGap = g;
		const kids: any = this.cross.children;
		for (let i = 0; i < 4 && i < kids.length; i++)
		{
			const p = String(kids[i].getAttribute('data-d') || '0,0').split(',').map(Number);
			if (p[0] === 0) { kids[i].style.left = '0px'; kids[i].style.top = (p[1] < 0 ? -(g + 8) : g) + 'px'; }
			else { kids[i].style.top = '0px'; kids[i].style.left = (p[0] < 0 ? -(g + 8) : g) + 'px'; }
		}
	}

	public hitMarker(now: number, kill: boolean): void
	{
		if (!this.ok) return;
		this.hitUntil = now + (kill ? 0.35 : 0.15);
		this.hit.style.display = 'block';
		this.hit.style.filter = kill ? 'drop-shadow(0 0 2px #f00) hue-rotate(0deg)' : '';
		this.hit.style.opacity = kill ? '1' : '0.85';
	}

	public message(text: string, now: number, seconds: number = 1.4): void
	{
		if (!this.ok) return;
		this.msg.textContent = text;
		this.msg.style.display = 'block';
		this.msgUntil = now + seconds;
	}

	public update(now: number): void
	{
		if (!this.ok) return;
		if (this.hitUntil > 0 && now > this.hitUntil) { this.hitUntil = 0; this.hit.style.display = 'none'; }
		if (this.msgUntil > 0 && now > this.msgUntil) { this.msgUntil = 0; this.msg.style.display = 'none'; }
	}

	public hideAll(): void
	{
		this.setAmmo('');
		this.setCrosshair(false, 0, false);
	}
}
