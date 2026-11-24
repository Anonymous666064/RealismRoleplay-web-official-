/*
 * RealismAudio.ts
 * ---------------
 * Procedural WebAudio sounds for the weapons (no sound files needed):
 *  - gunshots: a noise burst (crack + body) + a low "thump" oscillator + a short tail, tuned per weapon
 *  - dry-fire click, weapon switch click, punch whoosh
 *  - reloads: mag out / mag in / slide or bolt or pump, scheduled across the reload time
 *  - optional sound files per weapon (weapons.<name>.sounds.shot / reload / empty), decoded once and cached
 *
 * The AudioContext is only created / resumed on a user gesture (first key press or click), as browsers require.
 * Volume = (world as any).realismVolume (0..1, default 1) * weapons.volume.
 * Cost: every shot creates ~8 short-lived nodes that the browser frees when they end. One shared 2 s noise buffer.
 */

export interface ShotVoice
{
	crack: number;       // high noise level 0..1
	crackFreq: number;   // highpass cutoff of the crack, Hz
	body: number;        // mid noise level
	bodyFreq: number;    // lowpass cutoff of the body, Hz
	bodyDecay: number;   // seconds
	thump: number;       // low sine level
	thumpFreq: number;   // start pitch, Hz (drops by half)
	thumpDecay: number;  // seconds
	tail: number;        // echo tail level
	tailDecay: number;   // seconds
	gain: number;        // overall
}

/** Built-in voices, per weapon kind. */
export const SHOT_VOICES: { [kind: string]: ShotVoice } = {
	pistol:  { crack: 0.7, crackFreq: 2600, body: 0.9, bodyFreq: 2400, bodyDecay: 0.09, thump: 0.8, thumpFreq: 150, thumpDecay: 0.09, tail: 0.25, tailDecay: 0.35, gain: 0.75 },
	smg:     { crack: 0.6, crackFreq: 3000, body: 0.8, bodyFreq: 3000, bodyDecay: 0.06, thump: 0.6, thumpFreq: 170, thumpDecay: 0.06, tail: 0.18, tailDecay: 0.25, gain: 0.6 },
	shotgun: { crack: 0.5, crackFreq: 1800, body: 1.0, bodyFreq: 1300, bodyDecay: 0.22, thump: 1.0, thumpFreq: 95, thumpDecay: 0.22, tail: 0.45, tailDecay: 0.7, gain: 0.95 },
	rifle:   { crack: 1.0, crackFreq: 3500, body: 0.85, bodyFreq: 3200, bodyDecay: 0.12, thump: 0.85, thumpFreq: 120, thumpDecay: 0.12, tail: 0.35, tailDecay: 0.55, gain: 0.85 },
};

export type ReloadKind = 'pistol' | 'smg' | 'shotgun' | 'rifle';

export class WeaponAudio
{
	public ctx: any = null;
	public enabled = true;
	public volume = 1;                 // weapons.volume from the config
	private master: any = null;
	private noise: any = null;
	private files: { [path: string]: { state: string; buffer?: any } } = {};
	private world: any;
	private unlockHandler: (e: Event) => void;

	constructor(world: any, volume: number)
	{
		this.world = world;
		this.volume = typeof volume === 'number' ? volume : 1;
		const w: any = typeof window !== 'undefined' ? window : null;
		if (!w || !(w.AudioContext || w.webkitAudioContext)) { this.enabled = false; return; }
		this.unlockHandler = () => this.unlock();
		try
		{
			w.addEventListener('keydown', this.unlockHandler, true);
			w.addEventListener('mousedown', this.unlockHandler, true);
			w.addEventListener('touchend', this.unlockHandler, true);
		}
		catch (e) { /* no DOM */ }
	}

	/** Creates / resumes the AudioContext. Call from a user gesture. */
	public unlock(): void
	{
		if (!this.enabled) return;
		try
		{
			if (this.ctx === null)
			{
				const w: any = window;
				const AC = w.AudioContext || w.webkitAudioContext;
				this.ctx = new AC();
				const comp = this.ctx.createDynamicsCompressor();
				comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 6;
				comp.attack.value = 0.002; comp.release.value = 0.15;
				comp.connect(this.ctx.destination);
				this.master = this.ctx.createGain();
				this.master.gain.value = 1;
				this.master.connect(comp);
				const len = Math.floor(this.ctx.sampleRate * 2);
				this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
				const d = this.noise.getChannelData(0);
				for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
			}
			if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
			for (const path in this.files) if (this.files.hasOwnProperty(path) && this.files[path].state === 'idle') this.fileBuffer(path);
		}
		catch (e) { console.warn('[Realism] Web Audio unavailable', e); this.enabled = false; }
	}

	private ready(): boolean
	{
		return this.enabled && this.ctx !== null && this.ctx.state !== 'closed';
	}

	private level(): number
	{
		const v = this.world ? this.world.realismVolume : undefined;
		const g = typeof v === 'number' ? Math.max(0, Math.min(1, v)) : 1;
		return g * this.volume;
	}

	// -----------------------------------------------------------------------
	// building blocks
	// -----------------------------------------------------------------------

	private noiseBurst(t: number, dur: number, level: number, type: string, freq: number, q: number, attack: number, out: any): void
	{
		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		src.playbackRate.value = 0.9 + Math.random() * 0.2;
		const f = this.ctx.createBiquadFilter();
		f.type = type; f.frequency.value = freq; f.Q.value = q;
		const g = this.ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(level, t + attack);
		g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
		src.connect(f); f.connect(g); g.connect(out);
		const off = Math.random() * 0.5;
		src.start(t, off, attack + dur + 0.02);
	}

	private tone(t: number, dur: number, level: number, wave: string, f0: number, f1: number, out: any): void
	{
		const o = this.ctx.createOscillator();
		o.type = wave;
		o.frequency.setValueAtTime(f0, t);
		o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
		const g = this.ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(level, t + 0.004);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		o.connect(g); g.connect(out);
		o.start(t); o.stop(t + dur + 0.02);
	}

	private bus(level: number): any
	{
		const g = this.ctx.createGain();
		g.gain.value = level;
		g.connect(this.master);
		return g;
	}

	/** Metallic click: short highpassed noise + a tiny square blip. */
	private click(t: number, freq: number, level: number, out: any): void
	{
		this.noiseBurst(t, 0.025, level, 'highpass', freq, 0.7, 0.001, out);
		this.tone(t, 0.03, level * 0.35, 'square', freq * 0.6, freq * 0.4, out);
	}

	/** Duller plastic / metal thunk. */
	private thunk(t: number, freq: number, level: number, out: any): void
	{
		this.noiseBurst(t, 0.05, level, 'bandpass', freq, 1.2, 0.002, out);
		this.tone(t, 0.06, level * 0.5, 'triangle', freq * 0.25, freq * 0.15, out);
	}

	/** Sliding scrape (slide / bolt / pump travel). */
	private slide(t: number, dur: number, freq: number, level: number, out: any): void
	{
		const src = this.ctx.createBufferSource();
		src.buffer = this.noise;
		const f = this.ctx.createBiquadFilter();
		f.type = 'bandpass'; f.Q.value = 2;
		f.frequency.setValueAtTime(freq, t);
		f.frequency.linearRampToValueAtTime(freq * 1.6, t + dur);
		const g = this.ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(level, t + dur * 0.3);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		src.connect(f); f.connect(g); g.connect(out);
		src.start(t, Math.random() * 0.5, dur + 0.02);
	}

	// -----------------------------------------------------------------------
	// files
	// -----------------------------------------------------------------------

	/** Starts decoding a sound file (once). */
	public preload(path: string): void
	{
		if (!path || this.files[path] !== undefined) return;
		this.files[path] = { state: 'idle' };
	}

	private fileBuffer(path: string): any
	{
		if (!path) return null;
		let e = this.files[path];
		if (e === undefined) { e = { state: 'idle' }; this.files[path] = e; }
		if (e.state === 'ready') return e.buffer;
		if (e.state === 'idle' && this.ctx !== null && typeof fetch === 'function')
		{
			e.state = 'loading';
			const entry = e;
			fetch(path).then((r: any) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then((ab: ArrayBuffer) =>
			{
				this.ctx.decodeAudioData(ab, (buf: any) => { entry.state = 'ready'; entry.buffer = buf; },
					() => { entry.state = 'failed'; console.warn('[Realism] Could not decode sound "' + path + '". The built-in sound is used instead.'); });
			}).catch((err: any) => { entry.state = 'failed'; console.warn('[Realism] Could not load sound "' + path + '". The built-in sound is used instead.', err); });
		}
		return null;
	}

	/** Plays a decoded file now. Returns false if it isn't ready (caller uses the built-in sound). */
	private playFile(path: string, level: number, rate: number = 1): boolean
	{
		const buf = this.fileBuffer(path);
		if (!buf) return false;
		const src = this.ctx.createBufferSource();
		src.buffer = buf;
		src.playbackRate.value = rate;
		const g = this.ctx.createGain();
		g.gain.value = level;
		src.connect(g); g.connect(this.master);
		src.start();
		return true;
	}

	// -----------------------------------------------------------------------
	// public sounds
	// -----------------------------------------------------------------------

	/**
	 * A gunshot. `voice` is a key of SHOT_VOICES (pistol / smg / shotgun / rifle) or a ShotVoice.
	 * `distance` (metres, optional) attenuates and muffles it: for NPC gunfire.
	 */
	public shot(voice: string | ShotVoice, file?: string, distance: number = 0): void
	{
		if (!this.ready()) return;
		const v: ShotVoice = typeof voice === 'string' ? (SHOT_VOICES[voice] || SHOT_VOICES.pistol) : voice;
		const att = distance > 0 ? Math.max(0, 1 - distance / 220) * (1 / (1 + distance * 0.03)) : 1;
		const lvl = this.level() * v.gain * att;
		if (lvl <= 0.001) return;
		if (file && this.playFile(file, lvl, 0.97 + Math.random() * 0.06)) return;
		const t = this.ctx.currentTime + 0.001;
		const out = this.bus(lvl);
		const muffle = distance > 0 ? Math.max(0.25, 1 - distance / 150) : 1;
		const jit = 0.92 + Math.random() * 0.16;
		if (v.crack > 0) this.noiseBurst(t, 0.035, v.crack * muffle, 'highpass', v.crackFreq * jit, 0.8, 0.001, out);
		this.noiseBurst(t, v.bodyDecay, v.body, 'lowpass', v.bodyFreq * muffle * jit, 0.9, 0.002, out);
		this.tone(t, v.thumpDecay, v.thump, 'sine', v.thumpFreq * jit, v.thumpFreq * 0.45, out);
		if (v.tail > 0) this.noiseBurst(t + 0.03, v.tailDecay, v.tail, 'lowpass', 700 * jit, 0.5, 0.03, out);
	}

	/** Trigger pulled on an empty gun. */
	public dryFire(file?: string): void
	{
		if (!this.ready()) return;
		const lvl = this.level() * 0.5;
		if (file && this.playFile(file, lvl)) return;
		const t = this.ctx.currentTime + 0.001;
		const out = this.bus(lvl);
		this.click(t, 3200, 0.8, out);
	}

	/** Weapon switched / drawn. */
	public equip(kind: string): void
	{
		if (!this.ready()) return;
		const t = this.ctx.currentTime + 0.001;
		const out = this.bus(this.level() * 0.35);
		if (kind === 'fists') { this.slide(t, 0.12, 500, 0.4, out); return; }
		this.slide(t, 0.1, 900, 0.5, out);
		this.click(t + 0.1, 2400, 0.7, out);
	}

	/** Punch swing (and a thud when it lands). */
	public punch(hit: boolean): void
	{
		if (!this.ready()) return;
		const t = this.ctx.currentTime + 0.001;
		const out = this.bus(this.level() * 0.6);
		this.slide(t, 0.16, 400, 0.6, out);
		if (hit) this.thunk(t + 0.1, 260, 1.0, out);
	}

	/** Reload sounds, spread over `duration` seconds. */
	public reload(kind: ReloadKind, duration: number, file?: string, shells: number = 1): void
	{
		if (!this.ready()) return;
		const lvl = this.level() * 0.55;
		if (file && this.playFile(file, lvl)) return;
		const t = this.ctx.currentTime + 0.01;
		const D = Math.max(0.4, duration);
		const out = this.bus(lvl);
		if (kind === 'shotgun')
		{
			// shells pushed into the tube, then a pump
			const n = Math.max(1, Math.min(8, shells));
			const span = D * 0.7;
			for (let i = 0; i < n; i++)
			{
				const ti = t + D * 0.08 + (span * i) / n;
				this.slide(ti, 0.07, 1500, 0.4, out);
				this.thunk(ti + 0.07, 1100, 0.8, out);
			}
			this.slide(t + D * 0.82, 0.09, 700, 0.9, out);
			this.thunk(t + D * 0.82 + 0.09, 600, 1.0, out);
			this.slide(t + D * 0.92, 0.07, 900, 0.8, out);
			this.click(t + D * 0.92 + 0.07, 2000, 0.9, out);
			return;
		}
		// magazine weapons
		this.click(t + D * 0.08, 2600, 0.7, out);                       // mag release
		this.slide(t + D * 0.12, 0.12, 1200, 0.5, out);                  // mag out
		this.thunk(t + D * 0.55, kind === 'pistol' ? 1300 : 900, 1.0, out);   // mag in
		this.click(t + D * 0.55 + 0.03, 2200, 0.8, out);
		if (kind === 'rifle' || kind === 'smg')
		{
			this.slide(t + D * 0.8, 0.1, 800, 0.8, out);                 // charging handle back
			this.click(t + D * 0.8 + 0.1, 1900, 1.0, out);               // forward
		}
		else
		{
			this.slide(t + D * 0.82, 0.08, 1400, 0.7, out);              // slide release
			this.click(t + D * 0.82 + 0.08, 2600, 1.0, out);
		}
	}

	public dispose(): void
	{
		try
		{
			const w: any = window;
			w.removeEventListener('keydown', this.unlockHandler, true);
			w.removeEventListener('mousedown', this.unlockHandler, true);
			w.removeEventListener('touchend', this.unlockHandler, true);
			if (this.ctx) this.ctx.close();
		}
		catch (e) { /* ignore */ }
		this.ctx = null;
	}
}
