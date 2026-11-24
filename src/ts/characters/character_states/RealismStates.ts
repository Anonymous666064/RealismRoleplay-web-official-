/*
 * Realism (A14): character states for furniture interactions and swimming.
 *
 *  - RealismPose: sitting (chairs, couches, toilet, desk), lying (beds) or standing at something (sink,
 *    stove, fridge, shower). Physics is off while in it; RealismInteractions places the character and gets
 *    it up again. W/A/S/D asks to get up (onLeave), E is handled by RealismInteractions.
 *  - RealismSwimState: swimming. Physics stays on; RealismSwim.ts holds the character at the surface
 *    (Character.realismPostStep) and animates the bones procedurally (the boxman has no swim clip).
 *    W/A/S/D swim relative to the camera, Shift faster.
 */

import { CharacterStateBase } from './_stateLibrary';
import { Character } from '../Character';

export type RealismPoseKind = 'sit' | 'lie' | 'stand';

export class RealismPose extends CharacterStateBase
{
	public kind: RealismPoseKind;
	/** Called once when a movement key asks to get up. */
	public onLeave: () => void = null;

	constructor(character: Character, kind: RealismPoseKind)
	{
		super(character);
		this.kind = kind;
		this.canFindVehiclesToEnter = false;
		this.canEnterVehicles = false;
		this.canLeaveVehicles = false;
		this.character.setArcadeVelocityTarget(0);
		this.character.velocitySimulator.init();
		this.playAnimation(kind === 'sit' ? 'sitting' : 'idle', 0.25);
	}

	public update(timeStep: number): void
	{
		super.update(timeStep);
	}

	public onInputChange(): void
	{
		const a = this.character.actions;
		if (this.timer > 0.35 && (a.up.justPressed || a.down.justPressed || a.left.justPressed || a.right.justPressed))
		{
			const cb = this.onLeave;
			this.onLeave = null;
			if (cb) cb();
		}
	}
}

export class RealismSwimState extends CharacterStateBase
{
	/** Swim speed (local arcade units, x moveSpeed = m/s) for normal / Shift. */
	public speed = 0.34;
	public fastSpeed = 0.6;

	constructor(character: Character)
	{
		super(character);
		this.canFindVehiclesToEnter = false;
		this.canEnterVehicles = false;
		this.canLeaveVehicles = false;
		this.character.velocitySimulator.mass = 30;
		this.character.velocitySimulator.damping = 0.82;
		this.character.rotationSimulator.mass = 40;
		this.character.rotationSimulator.damping = 0.8;
		this.character.setArcadeVelocityInfluence(1, 0, 1);
		this.character.setArcadeVelocityTarget(0);
		this.playAnimation('idle', 0.3);
	}

	public update(timeStep: number): void
	{
		super.update(timeStep);
		if (this.anyDirection())
		{
			this.character.setCameraRelativeOrientationTarget();
			this.character.velocityTarget.z = this.character.actions.run.isPressed ? this.fastSpeed : this.speed;
		}
		else this.character.velocityTarget.z = 0;
		this.character.velocityTarget.x = 0;
	}

	public onInputChange(): void
	{
		// no jumping / vehicle finding while swimming; Space and C are read by RealismSwim
	}
}
