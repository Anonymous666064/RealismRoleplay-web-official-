/*
 * RealismClubs.ts
 * ---------------
 * Nightclubs on existing downtown commercial buildings (placed at runtime, map generation untouched):
 *
 *  - Facade: neon sign (glowing canvas plate, flickers on at night) + a door plate; by day a CLOSED plate.
 *  - "[E] Enter <club> ($fee)" (C7 owner 'illegal') between clubs.openHours (default 9 PM - 4 AM);
 *    by day "Closed, opens 9 PM". The entry fee (clubs.entryFee, cash or card) is paid once per night.
 *  - Interior (pocket room): dance floor of tiles in 4 colour groups whose emissive colours swap on the beat
 *    (4 draw calls), bar with "[E] Bar" (drinks restore thirst via realismNeeds.add('thirst', n)),
 *    DJ booth, lounge sofas, boxman dancers (pooled clones, 'dance' clip or idle + bob).
 *  - Music: procedural WebAudio beat (kick, hat, bass) scheduled ahead on the audio clock while you are
 *    inside; stops on leaving. clubs.volume 0..1 (0 = silent).
 *  - Blips (icon 'club') always shown; a guide (A15) per club.
 *
 * config clubs: { enabled, count: 2, openHours: [21, 4], entryFee: 20, volume: 0.35, dancers: 8, bpm: 124 }
 * API (world as any).realismIllegal.clubs = { list, enter(i), leave(), isOpen(), drink(i, drinkId), music }
 */

import * as THREE from 'three';
import { IllegalCore, PocketRoom, besideBuilding, reserve, textPlane, money, Site, NearSet, mergeCfg, MenuRow } from './RealismIllegalCore';
import { REGIONS } from './RealismMapData';
import { GeoAccum, Frame, boxC } from './RealismGeometry';

export const CLUB_DEFAULTS = { enabled: true, count: 2, openHours: [21, 4], entryFee: 20, volume: 0.35, dancers: 8, bpm: 124, alwaysOpen: false };

const NAMES = [{ name: 'NOVA', color: '#ff3df0' }, { name: 'VELVET ROOM', color: '#38e8ff' }, { name: 'AFTERGLOW', color: '#ffb02e' }];
const DRINKS = [{ id: 'water', name: 'Water', price: 3, thirst: 30 }, { id: 'soda', name: 'Soda', price: 5, thirst: 25 }, { id: 'mocktail', name: 'House special', price: 14, thirst: 40 }];
const PALETTE = [[1, 0.1, 0.8], [0.1, 0.9, 1], [1, 0.75, 0.1], [0.4, 1, 0.25], [0.6, 0.2, 1], [1, 0.2, 0.2]];

/** Procedural beat. Pure WebAudio, scheduled on the audio clock; start/stop are idempotent. */
export class ClubMusic
{
	public playing = false;
	public notes = 0;          // scheduled notes (tests)
	public live = 0;           // nodes currently alive (tests)
	public bpm: number;
	public volume: number;
	private ac: any = null;
	private out: any = null;
	private next = 0;
	private step = 0;
	private noise: any = null;

	constructor(bpm: number, volume: number) { this.bpm = bpm; this.volume = volume; }

	public useAudioContext(ac: any): void { this.ac = ac; this.out = null; this.noise = null; }

	private ctx(): any
	{
		if (this.ac) return this.ac;
		try
		{
			const AC = typeof window !== 'undefined' ? ((window as any).AudioContext || (window as any).webkitAudioContext) : null;
			if (AC) this.ac = new AC();
		}
		catch (e) { this.ac = null; }
		return this.ac;
	}

	public start(): boolean
	{
		if (this.playing || this.volume <= 0) return this.playing;
		const ac = this.ctx();
		if (!ac) return false;
		try { if (ac.state === 'suspended' && ac.resume) ac.resume(); } catch (e) { /* ignore */ }
		this.out = ac.createGain();
		this.out.gain.value = this.volume;
		this.out.connect(ac.destination);
		this.playing = true;
		this.next = ac.currentTime + 0.05;
		this.step = 0;
		this.tick();
		return true;
	}

	public stop(): void
	{
		if (!this.playing) return;
		this.playing = false;
		const ac = this.ac;
		try
		{
			this.out.gain.setValueAtTime(this.out.gain.value, ac.currentTime);
			this.out.gain.linearRampToValueAtTime(0, ac.currentTime + 0.15);
			const o = this.out;
			setTimeout(() => { try { o.disconnect(); } catch (e) { /* ignore */ } }, 250);
		}
		catch (e) { /* ignore */ }
		this.out = null;
	}

	/** Schedules notes up to 0.3 s ahead. Call every frame while playing. */
	public tick(): void
	{
		if (!this.playing) return;
		const ac = this.ac;
		const s16 = 60 / this.bpm / 4;
		let guard = 0;
		while (this.next < ac.currentTime + 0.3 && guard++ < 32)
		{
			const st = this.step % 16, t = this.next;
			if (st % 4 === 0) this.kick(t);
			if (st % 4 === 2) this.hat(t, 0.5);
			if (st % 2 === 1) this.hat(t, 0.18);
			if (st === 4 || st === 12) this.clap(t);
			if (st % 4 === 2 || st === 15) this.bass(t, [43.65, 43.65, 51.91, 38.89][Math.floor(this.step / 16) % 4]);
			this.next += s16;
			this.step++;
		}
	}

	private track(n: any, end: number): void
	{
		this.live++; this.notes++;
		const done = () => { this.live = Math.max(0, this.live - 1); };
		try { n.onended = done; n.start(); n.stop(end); } catch (e) { done(); }
	}

	private env(t: number, peak: number, decay: number): any
	{
		const g = this.ac.createGain();
		g.gain.setValueAtTime(peak, t);
		g.gain.exponentialRampToValueAtTime(0.001, t + decay);
		g.connect(this.out);
		return g;
	}

	private kick(t: number): void
	{
		const ac = this.ac;
		const o = ac.createOscillator();
		o.type = 'sine';
		o.frequency.setValueAtTime(140, t);
		o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
		o.connect(this.env(t, 0.9, 0.3));
		try { o.start(t); } catch (e) { /* ignore */ }
		this.track(o, t + 0.32);
	}

	private noiseBuf(): any
	{
		if (this.noise) return this.noise;
		const ac = this.ac;
		const n = Math.floor((ac.sampleRate || 44100) * 0.2);
		const b = ac.createBuffer(1, n, ac.sampleRate || 44100);
		const d = b.getChannelData(0);
		for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
		this.noise = b;
		return b;
	}

	private hat(t: number, level: number): void
	{
		const ac = this.ac;
		const s = ac.createBufferSource();
		s.buffer = this.noiseBuf();
		const f = ac.createBiquadFilter();
		f.type = 'highpass'; f.frequency.value = 7000;
		s.connect(f); f.connect(this.env(t, level * 0.35, 0.05));
		try { s.start(t); } catch (e) { /* ignore */ }
		this.track(s, t + 0.08);
	}

	private clap(t: number): void
	{
		const ac = this.ac;
		const s = ac.createBufferSource();
		s.buffer = this.noiseBuf();
		const f = ac.createBiquadFilter();
		f.type = 'bandpass'; f.frequency.value = 1500;
		s.connect(f); f.connect(this.env(t, 0.4, 0.14));
		try { s.start(t); } catch (e) { /* ignore */ }
		this.track(s, t + 0.16);
	}

	private bass(t: number, hz: number): void
	{
		const ac = this.ac;
		const o = ac.createOscillator();
		o.type = 'sawtooth';
		o.frequency.setValueAtTime(hz * 2, t);
		const f = ac.createBiquadFilter();
		f.type = 'lowpass'; f.frequency.value = 380;
		o.connect(f); f.connect(this.env(t, 0.35, 0.22));
		try { o.start(t); } catch (e) { /* ignore */ }
		this.track(o, t + 0.24);
	}
}

export interface Club
{
	index: number;
	name: string;
	color: string;
	building: number;
	site: Site;
	room: PocketRoom;
	tileMats: THREE.MeshLambertMaterial[];
	neon: THREE.Mesh;
	closedPlate: THREE.Mesh;
	paidNight: number;
	dancers: THREE.Object3D[];
}

export class Clubs
{
	public api: any;
	public cfg: any;
	public list: Club[] = [];
	public music: ClubMusic;
	public lightSwaps = 0;
	public drinks = 0;
	private core: IllegalCore;
	private near = new NearSet();
	private beatT = 0;
	private beat = 0;
	private acc = 1;
	private wasOpen: boolean = null;
	private tmp = new THREE.Vector3();

	constructor(core: IllegalCore)
	{
		this.core = core;
		this.cfg = mergeCfg(CLUB_DEFAULTS, (core.ctx.cfg as any).clubs || ((typeof window !== 'undefined' && (window as any).REALISM_CONFIG) ? (window as any).REALISM_CONFIG.clubs : null));
		this.music = new ClubMusic(this.cfg.bpm, this.cfg.volume);
		const self = this;
		this.api = {
			get list(): any[] { return self.describe(); },
			enter(i: number): boolean { return self.enter(i, true); },
			leave(): void { const c = self.inside(); if (c) c.room.leave(true); },
			isOpen(): boolean { return self.isOpen(); },
			drink(i: number, id: string): boolean { return self.drink(i, id); },
			music: this.music,
		};
		if (!this.cfg.enabled) return;
		this.place();
		core.addUpdater(this);
	}

	public isOpen(): boolean
	{
		if (this.cfg.alwaysOpen) return true;
		const h = this.cfg.openHours;
		return this.core.isNight(h[0], h[1]);
	}

	public inside(): Club { for (let i = 0; i < this.list.length; i++) if (this.list[i].room.inside) return this.list[i]; return null; }

	// ------------------------------------------------------------------ placement

	private place(): void
	{
		const ctx = this.core.ctx;
		const bs: any[] = ctx.data.buildings;
		const dt = REGIONS.downtown;
		const cx = (dt.x0 + dt.x1) / 2, cz = (dt.z0 + dt.z1) / 2;
		const cand: number[] = [];
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.custom || b.closed || b.boarded) continue;
			if (!(b.kind === 'shop' || b.kind === 'restaurant' || b.kind === 'office')) continue;
			if (!(b.x >= dt.x0 && b.x <= dt.x1 && b.z >= dt.z0 && b.z <= dt.z1)) continue;
			if (Math.max(b.w, b.d) < 14 || b.h < 6) continue;
			cand.push(i);
		}
		// nightlife strip: restaurants / shops first, then closest to the centre
		cand.sort((a, b) => ((bs[a].kind === 'office' ? 200 : 0) + Math.hypot(bs[a].x - cx, bs[a].z - cz)) - ((bs[b].kind === 'office' ? 200 : 0) + Math.hypot(bs[b].x - cx, bs[b].z - cz)));
		const want = Math.max(0, Math.min(NAMES.length, Math.round(this.cfg.count)));
		for (let k = 0; k < cand.length && this.list.length < want; k++)
		{
			const b = bs[cand[k]];
			if (this.list.some((c) => Math.hypot(bs[c.building].x - b.x, bs[c.building].z - b.z) < 140)) continue;
			const s = besideBuilding(ctx, cand[k], 3, 2, { road: 'near', doorGap: 2.5, gap: 0.05 });
			if (!s) continue;
			reserve(s.x, s.z, 3.5, 'club ' + this.list.length);
			this.build(cand[k], s);
		}
	}

	private build(bi: number, s: Site): void
	{
		const core = this.core;
		const b: any = core.ctx.data.buildings[bi];
		const idx = this.list.length;
		const nm = NAMES[idx];
		const sx = Math.sin(s.rot), sz = Math.cos(s.rot);
		const wallOff = 1 + 0.05 - 0.03;           // site centre is depth/2 + gap from the wall
		const wx = s.x - sx * wallOff, wz = s.z - sz * wallOff;
		// facade: neon sign, door, closed plate, rope posts
		const neonY = s.y + Math.min(Math.max(3.6, b.h - 1.2), 6);
		const neon = textPlane(nm.name, 5, nm.color, 'rgba(8,6,14,0.0)', true);
		(neon.material as THREE.MeshBasicMaterial).transparent = true;
		neon.position.set(wx + sx * 0.12, neonY, wz + sz * 0.12);
		neon.rotation.y = s.rot;
		const door = new THREE.Mesh(new THREE.BoxBufferGeometry(1.8, 2.5, 0.1), new THREE.MeshLambertMaterial({ color: 0x15121c, emissive: new THREE.Color(nm.color).multiplyScalar(0.12) }));
		door.position.set(wx + sx * 0.04, s.y + 1.25, wz + sz * 0.04);
		door.rotation.y = s.rot;
		const closed = textPlane('CLOSED - OPENS 9 PM', 1.6, '#ff5050', '#1a0a0a');
		closed.position.set(wx + sx * 0.11, s.y + 2.75, wz + sz * 0.11);
		closed.rotation.y = s.rot;
		const posts = new GeoAccum();
		const f = new Frame(s.x, s.y, s.z, s.rot);
		boxC(posts, f, -1.6, 0.5, 0.4, 0.08, 1, 0.08, [0.85, 0.7, 0.2]);
		boxC(posts, f, 1.6, 0.5, 0.4, 0.08, 1, 0.08, [0.85, 0.7, 0.2]);
		boxC(posts, f, -2.3, 0.01, 0, 1.2, 0.02, 1.6, [0.45, 0.05, 0.08]);   // red carpet strip
		boxC(posts, f, 0, 0.01, 0.2, 2.6, 0.02, 2.0, [0.45, 0.05, 0.08]);
		const postMesh = new THREE.Mesh(posts.toGeometry(), new THREE.MeshLambertMaterial({ vertexColors: THREE.VertexColors }));
		postMesh.matrixAutoUpdate = false;
		for (const o of [neon, door, closed, postMesh]) { core.w.graphicsWorld.add(o); }
		this.near.add(neon, s.x, s.z, 420); this.near.add(door, s.x, s.z, 160); this.near.add(closed, s.x, s.z, 50); this.near.add(postMesh, s.x, s.z, 90);
		// interior
		const room = core.room('club_' + idx, 22, 18, 6, { floor: [0.08, 0.07, 0.1], wall: [0.14, 0.1, 0.2], ceil: [0.06, 0.05, 0.08] });
		const hw = room.w / 2, hd = room.d / 2;
		room.box(-hw + 0.06, 1.25, 0, 0.1, 2.5, 1.8, [0.1, 0.08, 0.14]);
		room.label('EXIT', -hw + 0.13, 2.8, 0, Math.PI / 2, 0.9, '#7fe08a');
		room.label(nm.name, hw - 0.08, 4.2, 0, -Math.PI / 2, 6, nm.color);
		// bar along the -z wall
		room.box(-2, 0.55, -hd + 1.6, 9, 1.1, 0.8, [0.22, 0.12, 0.08], true);
		room.box(-2, 1.12, -hd + 1.6, 9.2, 0.06, 1.0, [0.75, 0.65, 0.45]);
		room.box(-2, 1.5, -hd + 0.3, 9, 2.2, 0.5, [0.18, 0.14, 0.12]);
		for (let i = 0; i < 8; i++) room.box(-5.8 + i * 1.1, 2.0, -hd + 0.5, 0.12, 0.35, 0.12, [0.3 + (i % 3) * 0.2, 0.6, 0.4 + (i % 2) * 0.3]);
		room.label('BAR', -2, 3.1, -hd + 0.06, 0, 1.4, '#ffd27f');
		// DJ booth on the +x side
		room.box(hw - 2.4, 0.6, 0, 1.4, 1.2, 4, [0.12, 0.12, 0.14], true);
		room.box(hw - 2.4, 1.25, -0.8, 0.7, 0.1, 0.7, [0.3, 0.3, 0.32]);
		room.box(hw - 2.4, 1.25, 0.8, 0.7, 0.1, 0.7, [0.3, 0.3, 0.32]);
		room.box(hw - 0.6, 1.5, -3.5, 1, 3, 1, [0.08, 0.08, 0.09], true);
		room.box(hw - 0.6, 1.5, 3.5, 1, 3, 1, [0.08, 0.08, 0.09], true);
		room.label('DJ', hw - 1.6, 2.2, 0, -Math.PI / 2, 1, nm.color);
		// lounge sofas on the +z wall
		for (let i = 0; i < 3; i++) { room.box(-6 + i * 5, 0.25, hd - 0.9, 3, 0.5, 1.1, [0.35, 0.05, 0.25], true); room.box(-6 + i * 5, 0.7, hd - 0.3, 3, 0.9, 0.3, [0.3, 0.04, 0.22]); }
		room.finish();
		// dance floor: 6 x 5 tiles in 4 colour groups (one merged mesh + material each)
		const groups: GeoAccum[] = [new GeoAccum(), new GeoAccum(), new GeoAccum(), new GeoAccum()];
		const ff = new Frame(room.x, room.y, room.z, 0);
		for (let ix = 0; ix < 6; ix++) for (let iz = 0; iz < 5; iz++)
		{
			const g = groups[(ix + iz * 2 + (ix * iz)) % 4];
			boxC(g, ff, -3 + ix * 1.5 + 0.75 - 1.5, 0.03, -3.75 + iz * 1.5 + 0.75 + 0.5, 1.42, 0.06, 1.42, [0.2, 0.2, 0.22]);
		}
		const tileMats: THREE.MeshLambertMaterial[] = [];
		for (let i = 0; i < 4; i++)
		{
			const c = PALETTE[i];
			const m = new THREE.MeshLambertMaterial({ vertexColors: THREE.VertexColors, emissive: new THREE.Color(c[0], c[1], c[2]) });
			m.name = 'clubTile' + i;
			tileMats.push(m);
			const mesh = new THREE.Mesh(groups[i].toGeometry(), m);
			mesh.matrixAutoUpdate = false;
			mesh.name = 'clubFloor';
			room.group.add(mesh);
		}
		// dancers on the floor
		const dancers: THREE.Object3D[] = [];
		const n = Math.max(0, Math.min(16, Math.round(this.cfg.dancers)));
		for (let i = 0; i < n; i++)
		{
			const a = i / Math.max(1, n) * Math.PI * 2;
			const r = 1.6 + (i % 3) * 0.9;
			const tint = PALETTE[(i + 2) % PALETTE.length].map((v) => v * 0.6);
			dancers.push(core.figure(room.x - 1.5 + Math.cos(a) * r, room.y, room.z + 0.5 + Math.sin(a) * r * 0.8, a + Math.PI, tint, 'dance', room.group));
		}
		const club: Club = { index: idx, name: nm.name, color: nm.color, building: bi, site: s, room: room, tileMats: tileMats, neon: neon, closedPlate: closed, paidNight: -1, dancers: dancers };
		this.list.push(club);
		room.onEnter = () => this.music.start();
		room.onExit = () => this.music.stop();
		// interactables
		const blip = 'ill_club_' + idx;
		core.addBlip(blip, { x: s.x, z: s.z, icon: 'club', color: nm.color, label: nm.name + ' (nightclub)', always: true });
		core.add({ id: 'club_door_' + idx, x: s.x, y: s.y, z: s.z, r: 2.6, mode: 'foot',
			items: () => this.isOpen() ? [{ key: 'E', label: 'Enter ' + nm.name + (this.fee(club) > 0 ? ' (' + money(this.fee(club)) + ')' : '') }] : [{ key: 'E', label: nm.name + ': closed, opens ' + this.openLabel() }],
			act: () => { if (this.isOpen()) this.enter(idx, false); else this.core.toast(nm.name + ' opens at ' + this.openLabel() + '.'); } });
		const ex = room.p(-hw + 0.9, 0, 0);
		core.add({ id: 'club_exit_' + idx, x: ex.x, y: ex.y, z: ex.z, r: 1.6, mode: 'foot', items: () => [{ key: 'E', label: 'Leave ' + nm.name }], act: () => room.leave(true) });
		const bar = room.p(-2, 0, -hd + 2.6);
		core.add({ id: 'club_bar_' + idx, x: bar.x, y: bar.y, z: bar.z, r: 2.4, mode: 'foot', items: () => [{ key: 'E', label: 'Bar' }], act: () => this.openBar(idx) });
	}

	private openLabel(): string { const h = this.cfg.openHours[0]; return (h % 12 || 12) + (h < 12 ? ' AM' : ' PM'); }

	private night(): number { return Math.floor(((this.core.state.clock || 0) + 12) / 24); }

	private fee(c: Club): number { return c.paidNight === this.night() ? 0 : Math.max(0, this.cfg.entryFee || 0); }

	// ------------------------------------------------------------------ actions

	public enter(i: number, force: boolean): boolean
	{
		const c = this.list[i];
		if (!c) return false;
		if (!force && !this.isOpen()) return false;
		const fee = this.fee(c);
		if (fee > 0)
		{
			if (!this.core.pay(fee, c.name + ' entry', c.name)) { this.core.toast('Entry is ' + money(fee) + '.'); return false; }
			c.paidNight = this.night();
		}
		const s = c.site;
		return c.room.enter({ x: s.x + Math.sin(s.rot) * 1.2, y: s.y + 1, z: s.z + Math.cos(s.rot) * 1.2, rot: s.rot }, -c.room.w / 2 + 1.6, 0, Math.PI / 2);
	}

	public drink(i: number, id: string): boolean
	{
		const c = this.list[i];
		const d = DRINKS.filter((x) => x.id === id)[0];
		if (!c || !d) return false;
		if (!this.core.pay(d.price, d.name + ' at ' + c.name, c.name)) { this.core.toast('Not enough money.'); return false; }
		const n = (this.core.w as any).realismNeeds;
		try { if (n && typeof n.add === 'function') n.add('thirst', d.thirst); } catch (e) { /* ignore */ }
		this.drinks++;
		this.core.toast(d.name + '. Refreshing.');
		return true;
	}

	private openBar(i: number): void
	{
		const c = this.list[i];
		this.core.menu({
			title: c.name + ' - BAR', subtitle: 'Drinks restore thirst.',
			rows: () => DRINKS.map((d) => ({ label: d.name, detail: '+' + d.thirst + ' thirst', right: money(d.price), action: () => this.drink(i, d.id) } as MenuRow)),
		});
	}

	// ------------------------------------------------------------------ frame

	public update(dt: number): void
	{
		const c = this.inside();
		if (c)
		{
			this.music.tick();
			this.beatT += dt;
			const beatLen = 60 / this.cfg.bpm;
			if (this.beatT >= beatLen)
			{
				this.beatT -= beatLen;
				if (this.beatT > beatLen) this.beatT = 0;
				this.beat++;
				for (let k = 0; k < c.tileMats.length; k++)
				{
					const p = PALETTE[(k + this.beat) % PALETTE.length];
					const on = ((k + this.beat) % 3) !== 0;
					c.tileMats[k].emissive.setRGB(p[0] * (on ? 1 : 0.15), p[1] * (on ? 1 : 0.15), p[2] * (on ? 1 : 0.15));
				}
				this.lightSwaps++;
			}
		}
		else if (this.music.playing) this.music.stop();
		this.acc += dt;
		if (this.acc < 0.5) return;
		this.acc = 0;
		const open = this.isOpen();
		if (open !== this.wasOpen)
		{
			this.wasOpen = open;
			for (let i = 0; i < this.list.length; i++)
			{
				const cl = this.list[i];
				(cl.neon.material as THREE.MeshBasicMaterial).color.setScalar(open ? 1 : 0.25);
				cl.closedPlate.userData.hidden = open;
			}
		}
		if (this.core.playerPos(this.tmp)) this.near.update(this.tmp);
	}

	public describe(): any[]
	{
		const bs: any[] = this.core.ctx.data.buildings;
		return this.list.map((c) => ({ name: c.name, building: c.building, kind: bs[c.building].kind, label: bs[c.building].label || '', door: { x: +c.site.x.toFixed(1), z: +c.site.z.toFixed(1) }, dancers: c.dancers.length }));
	}
}
