/*
 * RealismPlayer.ts
 * ----------------
 * Player size for San Verano County (contract C5).
 *
 *  - realism-config.js -> player.scale: size of the player character relative to the original
 *    Sketchbook boxman (about 1.02 m tall). 1.7 = about 1.74 m, a normal adult in this world
 *    (house doors 2.15 m, room doorways 2.1 m high and 0.95 m wide, car interiors made for scale 1).
 *  - Everything follows the scale (Character.applyPlayerScale): model, physics capsule, ground ray and
 *    step height, walk / run / jump speed (x sqrt(scale) by default, walk cycle slowed so the feet
 *    don't slide), camera distance, vehicle enter / exit positions, weapon size and hold (RealismWeapons).
 *  - In vehicles the character is drawn at player.seatedScale (default 1.2) so it remains visible
 *    while fitting the built-in car / heli / plane interiors; it shrinks while sitting down and
 *    grows back while getting out.
 *  - (world as any).realismPlayerScale = the scale actually applied (NPC code should draw people with it).
 *  - (world as any).realismPlayer = { scale, seatedScale, speedFactor, height, eyeHeight, setScale(s) }.
 *
 * Every Character in the world is scaled (the player, respawned players after Shift+R, drivers spawned
 * by Sketchbook scenarios), checked once per frame with a flag, no allocations.
 */

import { IUpdatable } from '../interfaces/IUpdatable';
import { RealismCtx } from './RealismContext';
import { deepMerge } from './RealismConfig';

/** Defaults. realism-config.js -> player overrides them. */
export const DEFAULT_PLAYER: any = {
	scale: 1.7,            // 1 = original boxman (1.02 m). 2.0 does not fit the doorways (see notes).
	seatedScale: 1.2,      // keep a natural seated body size while fitting vehicle interiors
	models: {
		male: { height: 1.70, scale: 1, y: 0, seatedScale: 0.72, seatedY: 0 },
		female: { height: 1.68, scale: 1, y: 0, seatedScale: 0.72, seatedY: 0 },
		femaleAthlete: { height: 1.70, scale: 1, y: 0, seatedScale: 0.72, seatedY: 0 },
	},
	speed: 'auto',         // 'auto' = sqrt(scale), or a number (1 = original speeds)
	capsuleRadius: 0.32,   // metres, upper limit of the physics capsule radius (doorways are 0.8..0.95 m)
	cameraDistance: 1.6,   // third person camera distance at scale 1 (multiplied by scale)
	firstPerson: false,    // start in first person (V toggles; the last choice is remembered)
	fov: 0,                // first person field of view in degrees, 0 = same as third person
	aimFov: 0.72,          // first person field of view multiplier while aiming down the sights
	headBob: 0.35,         // 0 = steady camera, 1 = follows the head of the walk animation fully
	eyeHeight: 0.87,       // eye height at scale 1 (boxman head is 0.73..1.02 m)
	viewModel: {},         // per weapon kind: { hip: [right, up, forward], ads: distance } (see RealismFirstPerson.ts)
};

/** Height of the original boxman in metres (measured, skinned idle pose). */
export const BOXMAN_HEIGHT = 1.024;

export class RealismPlayer implements IUpdatable
{
	public updateOrder: number = 0.5;   // before the characters (1)
	public settings: any;
	public scale = 1.7;
	public 	seatedScale = 1.2;
	public speedFactor = 1;
	public applied = 0;                 // characters scaled so far

	private world: any;
	private version = 1;

	constructor(ctx: RealismCtx)
	{
		this.world = ctx.world;
		const user = (ctx.cfg as any).player;
		this.settings = deepMerge(DEFAULT_PLAYER, user && typeof user === 'object' ? user : {});
		this.readSettings();
		this.world.realismPlayerModelSettings = this.settings.models;
		const self = this;
		this.world.realismPlayer = {
			get scale(): number { return self.scale; },
			get seatedScale(): number { return self.seatedScale; },
			get speedFactor(): number { return self.speedFactor; },
			get height(): number { return BOXMAN_HEIGHT * self.scale; },
			get eyeHeight(): number { return (Number(self.settings.eyeHeight) || 0.87) * self.scale; },
			setScale(s: number): void { self.settings.scale = s; self.readSettings(); self.version++; },
		};
		console.log('[Realism] Player scale ' + this.scale.toFixed(2) + ' (' + (BOXMAN_HEIGHT * this.scale).toFixed(2) + ' m), seated ' + this.seatedScale + ', speed x' + this.speedFactor.toFixed(2));
	}

	private readSettings(): void
	{
		const s = this.settings;
		let sc = Number(s.scale);
		if (!(sc > 0)) sc = DEFAULT_PLAYER.scale;
		this.scale = Math.max(0.5, Math.min(2.5, sc));
		let ss = Number(s.seatedScale);
		if (!(ss > 0)) ss = 1;
		this.seatedScale = Math.max(0.5, Math.min(2.5, ss));
		const sp = Number(s.speed);
		this.speedFactor = s.speed === 'auto' || !(sp > 0) ? Math.sqrt(this.scale) : Math.max(0.3, Math.min(3, sp));
		this.world.realismPlayerScale = this.scale;
	}

	public update(timeStep: number, unscaledTimeStep: number): void
	{
		const chars: any[] = this.world.characters;
		if (!chars) return;
		for (let i = 0; i < chars.length; i++)
		{
			const ch = chars[i];
			if (ch.__realismScaleVersion === this.version || typeof ch.applyPlayerScale !== 'function') continue;
			ch.__realismScaleVersion = this.version;
			ch.cameraDistanceBase = Number(this.settings.cameraDistance) || 1.6;
			const gender = ch.realismGender === 'female' ? 'female' : 'male';
			ch.setModelFit(this.settings.models && this.settings.models[gender]);
			ch.applyPlayerScale(this.scale, { seatedScale: this.seatedScale, speedFactor: this.speedFactor, capsuleRadius: Number(this.settings.capsuleRadius) || 0 });
			this.applied++;
		}
	}
}
