/*
 * RealismSfx.ts
 * -------------
 * Tiny procedural WebAudio effects for interactions and swimming (A14): toilet flush, shower and
 * sizzling loops, splashes, swim strokes, fridge / switch clicks. No audio files: one shared 2 s noise
 * buffer, filtered per effect. The AudioContext is created lazily on the first effect (always after a key
 * press, so browsers allow it) and is skipped silently where WebAudio doesn't exist (headless tests).
 * Volume follows (world as any).realismVolume (0..1).
 */

export class RealismSfx
{
	private world: any;
	private ac: any = null;
	private noise: any = null;
	private failed = false;
	private loops: { [id: string]: { src: any; gain: any } } = {};
	public played: { [name: string]: number } = {};   // counters (tests)

	constructor(world: any)
	{
		this.world = world;
	}

	private vol(): number
	{
		const v = Number(this.world && this.world.realismVolume);
		return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8;
	}

	private ctx(): any
	{
		if (this.ac || this.failed) return this.ac;
		try
		{
			const w: any = typeof window !== 'undefined' ? window : null;
			const AC = w && (w.AudioContext || w.webkitAudioContext);
			if (!AC) { this.failed = true; return null; }
			this.ac = new AC();
			const len = Math.floor(this.ac.sampleRate * 2);
			this.noise = this.ac.createBuffer(1, len, this.ac.sampleRate);
			const d = this.noise.getChannelData(0);
			let seed = 12345;
			for (let i = 0; i < len; i++) { seed = (seed * 16807) % 2147483647; d[i] = (seed / 2147483647) * 2 - 1; }
		}
		catch (e) { this.failed = true; this.ac = null; }
		return this.ac;
	}

	/** Filtered noise burst: type 'lowpass' | 'bandpass' | 'highpass', freq from f0 to f1 over dur seconds. */
	private burst(name: string, dur: number, gain: number, type: string, f0: number, f1: number, q?: number): void
	{
		this.played[name] = (this.played[name] || 0) + 1;
		const ac = this.ctx();
		if (!ac || this.vol() <= 0) return;
		try
		{
			if (ac.state === 'suspended' && ac.resume) ac.resume();
			const t = ac.currentTime;
			const src = ac.createBufferSource();
			src.buffer = this.noise;
			src.playbackRate.value = 0.7 + Math.random() * 0.6;
			const flt = ac.createBiquadFilter();
			flt.type = type;
			flt.frequency.setValueAtTime(f0, t);
			flt.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
			flt.Q.value = q || 0.8;
			const g = ac.createGain();
			const peak = gain * this.vol();
			g.gain.setValueAtTime(0.0001, t);
			g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + Math.min(0.08, dur * 0.2));
			g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
			src.connect(flt); flt.connect(g); g.connect(ac.destination);
			src.start(t, Math.random() * 1.5);
			src.stop(t + dur + 0.05);
		}
		catch (e) { /* audio is optional */ }
	}

	public flush(): void { this.burst('flush', 2.2, 0.5, 'lowpass', 2400, 260, 1.2); }
	public splash(strength: number): void { this.burst('splash', 0.45 + 0.4 * strength, 0.25 + 0.45 * strength, 'bandpass', 1800, 500, 0.9); }
	public stroke(): void { this.burst('stroke', 0.35, 0.12, 'bandpass', 1200, 700, 1.4); }
	public click(): void { this.burst('click', 0.06, 0.35, 'highpass', 3000, 2500, 0.7); }
	public fridge(): void { this.burst('fridge', 0.3, 0.2, 'lowpass', 600, 200, 0.7); }
	public drink(): void { this.burst('drink', 0.5, 0.15, 'bandpass', 500, 300, 2.5); }

	/** Starts / stops a looping effect: 'shower' (falling water) or 'sizzle' (pan). */
	public loop(id: string, on: boolean): void
	{
		const cur = this.loops[id];
		if (!on)
		{
			if (cur)
			{
				try { cur.gain.gain.setTargetAtTime(0.0001, this.ac.currentTime, 0.08); cur.src.stop(this.ac.currentTime + 0.4); }
				catch (e) { /* already stopped */ }
				delete this.loops[id];
			}
			return;
		}
		if (cur) return;
		this.played[id] = (this.played[id] || 0) + 1;
		const ac = this.ctx();
		if (!ac || this.vol() <= 0) return;
		try
		{
			if (ac.state === 'suspended' && ac.resume) ac.resume();
			const src = ac.createBufferSource();
			src.buffer = this.noise;
			src.loop = true;
			const flt = ac.createBiquadFilter();
			flt.type = id === 'sizzle' ? 'highpass' : 'bandpass';
			flt.frequency.value = id === 'sizzle' ? 3200 : 1500;
			flt.Q.value = 0.6;
			const g = ac.createGain();
			g.gain.value = 0.0001;
			g.gain.setTargetAtTime((id === 'sizzle' ? 0.12 : 0.22) * this.vol(), ac.currentTime, 0.15);
			src.connect(flt); flt.connect(g); g.connect(ac.destination);
			src.start();
			this.loops[id] = { src: src, gain: g };
		}
		catch (e) { /* audio is optional */ }
	}

	public stopAll(): void
	{
		for (const id in this.loops) if (this.loops.hasOwnProperty(id)) this.loop(id, false);
	}
}

/** One shared instance per world. */
export function sfxFor(world: any): RealismSfx
{
	if (!world.__realismSfx) world.__realismSfx = new RealismSfx(world);
	return world.__realismSfx;
}
