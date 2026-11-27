import * as THREE from 'three';
import * as CANNON from 'cannon';
import * as _ from 'lodash';
import * as Utils from '../core/FunctionLibrary';

import { KeyBinding } from '../core/KeyBinding';
import { VectorSpringSimulator } from '../physics/spring_simulation/VectorSpringSimulator';
import { RelativeSpringSimulator } from '../physics/spring_simulation/RelativeSpringSimulator';
import { Idle } from './character_states/Idle';
import { EnteringVehicle } from './character_states/vehicles/EnteringVehicle';
import { ExitingVehicle } from './character_states/vehicles/ExitingVehicle';
import { OpenVehicleDoor as OpenVehicleDoor } from './character_states/vehicles/OpenVehicleDoor';
import { Driving } from './character_states/vehicles/Driving';
import { ExitingAirplane } from './character_states/vehicles/ExitingAirplane';
import { ICharacterAI } from '../interfaces/ICharacterAI';
import { World } from '../world/World';
import { IControllable } from '../interfaces/IControllable';
import { ICharacterState } from '../interfaces/ICharacterState';
import { IWorldEntity } from '../interfaces/IWorldEntity';
import { VehicleSeat } from '../vehicles/VehicleSeat';
import { Vehicle } from '../vehicles/Vehicle';
import { CollisionGroups } from '../enums/CollisionGroups';
import { CapsuleCollider } from '../physics/colliders/CapsuleCollider';
import { VehicleEntryInstance } from './VehicleEntryInstance';
import { SeatType } from '../enums/SeatType';
import { GroundImpactData } from './GroundImpactData';
import { ClosestObjectFinder } from '../core/ClosestObjectFinder';
import { Object3D } from 'three';
import { EntityType } from '../enums/EntityType';

export class Character extends THREE.Object3D implements IWorldEntity
{
	public updateOrder: number = 1;
	public entityType: EntityType = EntityType.Character;

	public height: number = 0;
	public tiltContainer: THREE.Group;
	public modelContainer: THREE.Group;
	public materials: THREE.Material[] = [];
	public mixer: THREE.AnimationMixer;
	public animations: any[];

	// Movement
	public acceleration: THREE.Vector3 = new THREE.Vector3();
	public velocity: THREE.Vector3 = new THREE.Vector3();
	public arcadeVelocityInfluence: THREE.Vector3 = new THREE.Vector3();
	public velocityTarget: THREE.Vector3 = new THREE.Vector3();
	/** Realism (A14): called at the end of every physics post step (swimming buoyancy). */
	public realismPostStep: (body: CANNON.Body) => void = null;
	/** Realism (A14): first person eye height change while seated / lying (metres, negative = lower). */
	public realismEyeDrop: number = 0;
	public arcadeVelocityIsAdditive: boolean = false;

	public defaultVelocitySimulatorDamping: number = 0.8;
	public defaultVelocitySimulatorMass: number = 50;
	public velocitySimulator: VectorSpringSimulator;
	public moveSpeed: number = 4;
	public angularVelocity: number = 0;
	public orientation: THREE.Vector3 = new THREE.Vector3(0, 0, 1);
	public orientationTarget: THREE.Vector3 = new THREE.Vector3(0, 0, 1);
	public defaultRotationSimulatorDamping: number = 0.5;
	public defaultRotationSimulatorMass: number = 10;
	public rotationSimulator: RelativeSpringSimulator;
	public viewVector: THREE.Vector3;
	public actions: { [action: string]: KeyBinding };
	public characterCapsule: CapsuleCollider;
	
	// Ray casting
	public rayResult: CANNON.RaycastResult = new CANNON.RaycastResult();
	public rayHasHit: boolean = false;
	public rayCastLength: number = 0.57;
	public raySafeOffset: number = 0.03;
	public wantsToJump: boolean = false;
	public initJumpSpeed: number = -1;
	public groundImpactData: GroundImpactData = new GroundImpactData();
	public raycastBox: THREE.Mesh;
	
	public world: World;
	public charState: ICharacterState;
	public behaviour: ICharacterAI;
	
	// Vehicles
	public controlledObject: IControllable;
	public occupyingSeat: VehicleSeat = null;
	public vehicleEntryInstance: VehicleEntryInstance = null;
	/** Realism weapons: while set (aiming), the character faces this flat direction and strafes. */
	public aimDirection: THREE.Vector3 = null;

	// Realism player scale (RealismPlayer.ts). 1 = the original Sketchbook boxman (about 1.02 m).
	/** Standing size multiplier: visuals, capsule, ray, camera distance. */
	public playerScale: number = 1;
	/** Size while sitting in a vehicle (the built-in vehicles are made for scale 1). */
	public seatedScale: number = 1;
	/** Walk / run / jump speed multiplier that goes with playerScale. */
	public speedFactor: number = 1;
	/** Visual size applied this frame (blends between playerScale and seatedScale). */
	public modelScale: number = 1;
	/** Normalizes imported character models to the original 1.024 m visual height. */
	public modelBaseScale: number = 1;
	public modelBaseMinY: number = 0;
	public modelFitScale: number = 1;
	public modelFitY: number = 0;
	public modelSeatedScale: number = 0.72;
	public modelSeatedY: number = 0;
	public realismGender: string = 'male';
	/** Set by vehicle enter / exit states each frame: 0 = standing size, 1 = seated size. -1 = automatic. */
	public seatBlendOverride: number = -1;
	/** Gait speed multiplier; normalized imported models keep this at 1. */
	public loopAnimRate: number = 1;
	/** Third person camera distance at scale 1 (multiplied by playerScale). */
	public cameraDistanceBase: number = 1.6;
	/** First person (RealismFirstPerson.ts): while set, the body faces this flat direction at once and strafes. */
	public firstPersonLook: THREE.Vector3 = null;
	private fpMoveDir: THREE.Vector3 = new THREE.Vector3();
	
	private physicsEnabled: boolean = true;

	constructor(gltf: any)
	{
		super();

		gltf.scene.updateMatrixWorld(true);
		const modelBounds = new THREE.Box3().setFromObject(gltf.scene);
		this.height = modelBounds.max.y - modelBounds.min.y;
		this.modelBaseMinY = modelBounds.min.y;
		this.modelBaseScale = Number.isFinite(this.height) && this.height > 0 ? 1.024 / this.height : 1;
		this.readCharacterData(gltf);
		this.setAnimations(gltf.animations, gltf.scene);

		// The visuals group is centered for easy character tilting
		this.tiltContainer = new THREE.Group();
		this.add(this.tiltContainer);

		// Model container is used to reliably ground the character, as animation can alter the position of the model itself
		this.modelContainer = new THREE.Group();
		this.modelContainer.position.y = -0.57;
		this.tiltContainer.add(this.modelContainer);
		this.modelContainer.add(gltf.scene);
		this.modelContainer.scale.setScalar(this.modelBaseScale);
		this.modelContainer.position.y = -0.57 - this.modelBaseMinY * this.modelBaseScale;

		this.mixer = new THREE.AnimationMixer(gltf.scene);

		this.velocitySimulator = new VectorSpringSimulator(60, this.defaultVelocitySimulatorMass, this.defaultVelocitySimulatorDamping);
		this.rotationSimulator = new RelativeSpringSimulator(60, this.defaultRotationSimulatorMass, this.defaultRotationSimulatorDamping);

		this.viewVector = new THREE.Vector3();

		// Actions
		this.actions = {
			'up': new KeyBinding('KeyW'),
			'down': new KeyBinding('KeyS'),
			'left': new KeyBinding('KeyA'),
			'right': new KeyBinding('KeyD'),
			'run': new KeyBinding('ShiftLeft'),
			'jump': new KeyBinding('Space'),
			'use': new KeyBinding('KeyE'),
			'enter': new KeyBinding('KeyF'),
			'enter_passenger': new KeyBinding('KeyG'),
			'seat_switch': new KeyBinding('KeyX'),
			'primary': new KeyBinding('Mouse0'),
			'secondary': new KeyBinding('Mouse1'),
		};

		// Physics
		// Player Capsule
		this.characterCapsule = new CapsuleCollider({
			mass: 1,
			position: new CANNON.Vec3(),
			height: 0.5,
			radius: 0.25,
			segments: 8,
			friction: 0.0
		});
		// capsulePhysics.physical.collisionFilterMask = ~CollisionGroups.Trimesh;
		this.characterCapsule.body.shapes.forEach((shape) => {
			// tslint:disable-next-line: no-bitwise
			shape.collisionFilterMask = ~CollisionGroups.TrimeshColliders;
		});
		this.characterCapsule.body.allowSleep = false;

		// Move character to different collision group for raycasting
		this.characterCapsule.body.collisionFilterGroup = 2;

		// Disable character rotation
		this.characterCapsule.body.fixedRotation = true;
		this.characterCapsule.body.updateMassProperties();

		// Ray cast debug
		const boxGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
		const boxMat = new THREE.MeshLambertMaterial({
			color: 0xff0000
		});
		this.raycastBox = new THREE.Mesh(boxGeo, boxMat);
		this.raycastBox.visible = false;

		// Physics pre/post step callback bindings
		this.characterCapsule.body.preStep = (body: CANNON.Body) => { this.physicsPreStep(body, this); };
		this.characterCapsule.body.postStep = (body: CANNON.Body) => { this.physicsPostStep(body, this); };

		// States
		this.setState(new Idle(this));
	}

	public setAnimations(animations: any[] = [], root?: THREE.Object3D): void
	{
		this.animations = (animations || []).slice();
		if (!root) return;

		const bones: { [name: string]: THREE.Bone } = {};
		root.traverse((node: any) => { if (node.isBone) bones[node.name] = node; });
		const times = [0, 0.5, 1];
		const addRotation = (tracks: THREE.KeyframeTrack[], name: string, axis: THREE.Vector3, angle: number, oscillate: boolean): void =>
		{
			const bone = bones[name];
			if (!bone) return;
			const values: number[] = [];
			const phases = oscillate ? [-1, 1, -1] : [1, 1, 1];
			for (let i = 0; i < phases.length; i++)
			{
				const offset = new THREE.Quaternion().setFromAxisAngle(axis, angle * phases[i]);
				const pose = bone.quaternion.clone().multiply(offset);
				values.push(pose.x, pose.y, pose.z, pose.w);
			}
			tracks.push(new THREE.QuaternionKeyframeTrack(name + '.quaternion', times, values));
		};
		const addClip = (name: string, tracks: THREE.KeyframeTrack[]): void =>
		{
			if (!this.animations.some((clip) => clip && String(clip.name).toLowerCase() === name.toLowerCase()))
				this.animations.push(new THREE.AnimationClip(name, 1, tracks));
		};

		const idleTracks: THREE.KeyframeTrack[] = [];
		addRotation(idleTracks, 'Spine', new THREE.Vector3(0, 0, 1), 0.018, true);
		addRotation(idleTracks, 'Head', new THREE.Vector3(0, 0, 1), 0.012, true);
		addClip('idle', idleTracks);

		const seatedTracks: THREE.KeyframeTrack[] = [];
		addRotation(seatedTracks, 'LeftUpLeg', new THREE.Vector3(1, 0, 0), 0.9, false);
		addRotation(seatedTracks, 'RightUpLeg', new THREE.Vector3(1, 0, 0), 0.9, false);
		addRotation(seatedTracks, 'LeftLeg', new THREE.Vector3(1, 0, 0), -1.35, false);
		addRotation(seatedTracks, 'RightLeg', new THREE.Vector3(1, 0, 0), -1.35, false);
		addClip('sitting', seatedTracks);

		const drivingTracks: THREE.KeyframeTrack[] = [];
		addRotation(drivingTracks, 'LeftArm', new THREE.Vector3(0, 0, 1), -0.45, false);
		addRotation(drivingTracks, 'RightArm', new THREE.Vector3(0, 0, 1), 0.45, false);
		addRotation(drivingTracks, 'LeftForeArm', new THREE.Vector3(1, 0, 0), -0.65, false);
		addRotation(drivingTracks, 'RightForeArm', new THREE.Vector3(1, 0, 0), -0.65, false);
		addClip('driving', drivingTracks);

		const talkingTracks: THREE.KeyframeTrack[] = [];
		addRotation(talkingTracks, 'Head', new THREE.Vector3(0, 1, 0), 0.035, true);
		addRotation(talkingTracks, 'LeftArm', new THREE.Vector3(0, 0, 1), 0.12, true);
		addClip('talking', talkingTracks);

		const waveTracks: THREE.KeyframeTrack[] = [];
		addRotation(waveTracks, 'RightArm', new THREE.Vector3(0, 0, 1), 0.75, true);
		addRotation(waveTracks, 'RightForeArm', new THREE.Vector3(0, 1, 0), 0.5, true);
		addClip('wave', waveTracks);
	}

	/**
	 * Realism: resizes this character. scale 1 = original. Rebuilds the physics capsule (spheres from
	 * 0.07 * scale to 1.07 * scale above the feet, like the original 0.07..1.07), the ground ray, speeds,
	 * jump and the camera distance. `capsuleRadius` caps the capsule radius (metres) so a big character
	 * still fits through doorways; `speedFactor` defaults to sqrt(scale).
	 */
	public applyPlayerScale(scale: number, opts?: { seatedScale?: number; speedFactor?: number; capsuleRadius?: number }): void
	{
		const s = Math.max(0.3, Math.min(3, Number(scale) || 1));
		const o: any = opts || {};
		this.playerScale = s;
		this.seatedScale = Math.max(0.3, Math.min(3, Number(o.seatedScale) || 1));
		this.speedFactor = Math.max(0.3, Math.min(3, Number(o.speedFactor) || Math.sqrt(s)));
		this.moveSpeed = 4 * this.speedFactor;
		this.loopAnimRate = 1;
		this.rayCastLength = 0.57 * s;
		this.raySafeOffset = 0.03 * s;

		// capsule: bottom 0.07 s, top 1.07 s above the feet, centre 0.57 s (= rayCastLength)
		const maxR = Number(o.capsuleRadius) > 0 ? Number(o.capsuleRadius) : 0.25 * s;
		const r = Math.min(0.25 * s, maxR);
		const half = 0.5 * s - r;                  // centre to the end sphere centres
		const body = this.characterCapsule.body;
		const anyBody: any = body;   // cannon.js 0.6 has no removeShape
		anyBody.shapes.length = 0; anyBody.shapeOffsets.length = 0; anyBody.shapeOrientations.length = 0;
		const n = Math.max(1, Math.ceil(half / (r * 0.75)));   // spheres overlap, no gaps
		const sphere = new CANNON.Sphere(r);
		sphere.collisionFilterMask = ~CollisionGroups.TrimeshColliders; // tslint:disable-line: no-bitwise
		body.addShape(sphere, new CANNON.Vec3(0, 0, 0));
		for (let i = 1; i <= n; i++)
		{
			const y = half * i / n;
			const a = new CANNON.Sphere(r), b = new CANNON.Sphere(r);
			a.collisionFilterMask = b.collisionFilterMask = ~CollisionGroups.TrimeshColliders; // tslint:disable-line: no-bitwise
			body.addShape(a, new CANNON.Vec3(0, y, 0));
			body.addShape(b, new CANNON.Vec3(0, -y, 0));
		}
		body.updateMassProperties();
		body.aabbNeedsUpdate = true;
		this.characterCapsule.options.radius = r;
		this.characterCapsule.options.height = half * 2;
		this.updateModelScale();
		if (!(this as any).__realismFitLogged)
		{
			(this as any).__realismFitLogged = true;
			console.info('[Realism] Player model auto-fit',
				'raw height', this.height.toFixed(3) + 'm',
				'on foot', (this.height * this.modelBaseScale * this.modelFitScale).toFixed(2) + 'm',
				'in vehicle', (this.height * this.modelBaseScale * this.modelFitScale * this.modelSeatedScale).toFixed(2) + 'm');
		}
		if (this.world !== undefined && this.world.inputManager !== undefined && this.world.inputManager.inputReceiver === this)
		{
			this.world.cameraOperator.setRadius(this.cameraDistanceBase * s);
		}
	}

	public setModelFit(settings: any): void
	{
		const fit = settings && typeof settings === 'object' ? settings : {};
		const height = Number(fit.height);
		const scale = Number(fit.scale);
		const seatedScale = Number(fit.seatedScale);
		this.modelBaseScale = Number.isFinite(height) && height > 0 && this.height > 0
			? height / this.height
			: (this.height > 0 ? 1.024 / this.height : 1);
		this.modelFitScale = Number.isFinite(scale) && scale > 0 ? Math.max(0.01, Math.min(5, scale)) : 1;
		this.modelFitY = Number.isFinite(Number(fit.y)) ? Math.max(-3, Math.min(3, Number(fit.y))) : 0;
		this.modelSeatedScale = Number.isFinite(seatedScale) && seatedScale > 0
			? Math.max(0.01, Math.min(5, seatedScale))
			: 0.72;
		this.modelSeatedY = Number.isFinite(Number(fit.seatedY)) ? Math.max(-3, Math.min(3, Number(fit.seatedY))) : 0;
		this.updateModelScale();
		(this as any).__realismFitLogged = false;
	}

	/** Height offset above a vehicle entry / exit point for a STANDING character (original value `base`, made for scale 1). */
	public standOffsetY(base: number): number
	{
		return base + 0.57 * (this.playerScale - 1);
	}

	/** Height offset above a seat point for a SEATED character (original value `base`). Keeps the hips on the seat. */
	public seatOffsetY(base: number): number
	{
		// body centre is 0.57 above the feet, hips 0.36: hips stay at seat + (base - 0.21)
		return base + 0.21 * (this.seatedScale - 1);
	}

	/** Applies the visual size for this frame: standing size, seated size, or the blend a vehicle state asked for. */
	public updateModelScale(): void
	{
		let blend = this.seatBlendOverride;
		if (blend < 0) blend = (this.occupyingSeat !== null && !this.physicsEnabled) ? 1 : 0;
		blend = Math.max(0, Math.min(1, blend));
		const sc = this.playerScale + (this.seatedScale - this.playerScale) * blend;
		this.modelScale = sc;
		const seatScale = 1 + (this.modelSeatedScale - 1) * blend;
		const visualScale = this.modelBaseScale * this.modelFitScale * seatScale;
		this.modelContainer.scale.set(visualScale, visualScale, visualScale);
		const yOffset = this.modelFitY + (this.modelSeatedY - this.modelFitY) * blend;
		this.modelContainer.position.y = -0.57 * sc - this.modelBaseMinY * visualScale + yOffset;
	}

	public setArcadeVelocityInfluence(x: number, y: number = x, z: number = x): void
	{
		this.arcadeVelocityInfluence.set(x, y, z);
	}

	public setViewVector(vector: THREE.Vector3): void
	{
		this.viewVector.copy(vector).normalize();
	}

	/**
	 * Set state to the player. Pass state class (function) name.
	 * @param {function} State 
	 */
	public setState(state: ICharacterState): void
	{
		this.seatBlendOverride = -1;
		this.charState = state;
		this.charState.onInputChange();
	}

	public setPosition(x: number, y: number, z: number): void
	{
		if (this.physicsEnabled)
		{
			this.characterCapsule.body.previousPosition = new CANNON.Vec3(x, y, z);
			this.characterCapsule.body.position = new CANNON.Vec3(x, y, z);
			this.characterCapsule.body.interpolatedPosition = new CANNON.Vec3(x, y, z);
		}
		else
		{
			this.position.x = x;
			this.position.y = y;
			this.position.z = z;
		}
	}

	public resetVelocity(): void
	{
		this.velocity.x = 0;
		this.velocity.y = 0;
		this.velocity.z = 0;

		this.characterCapsule.body.velocity.x = 0;
		this.characterCapsule.body.velocity.y = 0;
		this.characterCapsule.body.velocity.z = 0;

		this.velocitySimulator.init();
	}

	public setArcadeVelocityTarget(velZ: number, velX: number = 0, velY: number = 0): void
	{
		this.velocityTarget.z = velZ;
		this.velocityTarget.x = velX;
		this.velocityTarget.y = velY;
	}

	public setOrientation(vector: THREE.Vector3, instantly: boolean = false): void
	{
		let lookVector = new THREE.Vector3().copy(vector).setY(0).normalize();
		this.orientationTarget.copy(lookVector);
		
		if (instantly)
		{
			this.orientation.copy(lookVector);
		}
	}

	public resetOrientation(): void
	{
		const forward = Utils.getForward(this);
		this.setOrientation(forward, true);
	}

	public setBehaviour(behaviour: ICharacterAI): void
	{
		behaviour.character = this;
		this.behaviour = behaviour;
	}

	public setPhysicsEnabled(value: boolean): void {
		this.physicsEnabled = value;

		if (value === true)
		{
			this.world.physicsWorld.addBody(this.characterCapsule.body);
		}
		else
		{
			this.world.physicsWorld.remove(this.characterCapsule.body);
		}
	}

	public readCharacterData(gltf: any): void
	{
		gltf.scene.traverse((child) => {

			if (child.isMesh)
			{
				Utils.setupMeshProperties(child);
				// Skinned meshes keep their bind-pose bounds, so three.js can wrongly frustum-cull
				// the animated player near the screen edge. One character is cheap to always draw.
				child.frustumCulled = false;

				if (child.material !== undefined)
				{
					this.materials.push(child.material);
				}
			}
		});
	}

	public replaceModel(gltf: any): void
	{
		if (!gltf || !gltf.scene) throw new Error('Cannot replace character model: missing scene.');

		if (this.mixer)
		{
			this.mixer.stopAllAction();
			this.mixer.uncacheRoot(this.mixer.getRoot());
		}
		while (this.modelContainer.children.length) this.modelContainer.remove(this.modelContainer.children[0]);
		this.materials = [];
		gltf.scene.updateMatrixWorld(true);
		const bounds = new THREE.Box3().setFromObject(gltf.scene);
		const height = bounds.max.y - bounds.min.y;
		this.height = height;
		this.modelBaseMinY = bounds.min.y;
		this.readCharacterData(gltf);
		this.setAnimations(gltf.animations, gltf.scene);
		this.modelContainer.add(gltf.scene);
		this.mixer = new THREE.AnimationMixer(gltf.scene);
		this.updateModelScale();
		(this as any).__realismScaleVersion = -1;
		(this as any).__rrmpSkin = null;
		this.setAnimation('idle', 0.15);
	}

	public handleKeyboardEvent(event: KeyboardEvent, code: string, pressed: boolean): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.handleKeyboardEvent(event, code, pressed);
		}
		else
		{
			// Free camera
			if (code === 'KeyC' && pressed === true && event.shiftKey === true)
			{
				this.resetControls();
				this.world.cameraOperator.characterCaller = this;
				this.world.inputManager.setInputReceiver(this.world.cameraOperator);
			}
			else if (code === 'KeyR' && pressed === true && event.shiftKey === true)
			{
				this.world.restartScenario();
			}
			else
			{
				for (const action in this.actions) {
					if (this.actions.hasOwnProperty(action)) {
						const binding = this.actions[action];
	
						if (_.includes(binding.eventCodes, code))
						{
							this.triggerAction(action, pressed);
						}
					}
				}
			}
		}
	}

	public handleMouseButton(event: MouseEvent, code: string, pressed: boolean): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.handleMouseButton(event, code, pressed);
		}
		else
		{
			for (const action in this.actions) {
				if (this.actions.hasOwnProperty(action)) {
					const binding = this.actions[action];

					if (_.includes(binding.eventCodes, code))
					{
						this.triggerAction(action, pressed);
					}
				}
			}
		}
	}

	public handleMouseMove(event: MouseEvent, deltaX: number, deltaY: number): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.handleMouseMove(event, deltaX, deltaY);
		}
		else
		{
			this.world.cameraOperator.move(deltaX, deltaY);
		}
	}
	
	public handleMouseWheel(event: WheelEvent, value: number): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.handleMouseWheel(event, value);
		}
		else
		{
			this.world.scrollTheTimeScale(value);
		}
	}

	public triggerAction(actionName: string, value: boolean): void
	{
		// Get action and set it's parameters
		let action = this.actions[actionName];

		if (action.isPressed !== value)
		{
			// Set value
			action.isPressed = value;

			// Reset the 'just' attributes
			action.justPressed = false;
			action.justReleased = false;

			// Set the 'just' attributes
			if (value) action.justPressed = true;
			else action.justReleased = true;

			// Tell player to handle states according to new input
			this.charState.onInputChange();

			// Reset the 'just' attributes
			action.justPressed = false;
			action.justReleased = false;
		}
	}

	public takeControl(): void
	{
		if (this.world !== undefined)
		{
			this.world.inputManager.setInputReceiver(this);
		}
		else
		{
			console.warn('Attempting to take control of a character that doesn\'t belong to a world.');
		}
	}

	public resetControls(): void
	{
		for (const action in this.actions) {
			if (this.actions.hasOwnProperty(action)) {
				this.triggerAction(action, false);
			}
		}
	}

	public update(timeStep: number): void
	{
		this.behaviour?.update(timeStep);
		this.vehicleEntryInstance?.update(timeStep);
		// console.log(this.occupyingSeat);
		this.charState?.update(timeStep);
		const onFoot = this.controlledObject === undefined && this.occupyingSeat === null && this.vehicleEntryInstance === null;
		if (this.firstPersonLook !== null && onFoot && this.physicsEnabled)
		{
			// first person: the body turns with the camera at once (no spring lag between view and body)
			this.orientationTarget.set(this.firstPersonLook.x, 0, this.firstPersonLook.z);
			if (this.orientationTarget.lengthSq() > 1e-8)
			{
				this.orientationTarget.normalize();
				this.orientation.copy(this.orientationTarget);
				const rs = this.rotationSimulator;
				for (let i = 0; i < rs.cache.length; i++) { rs.cache[i].position = 0; rs.cache[i].velocity = 0; }
				rs.position = 0; rs.velocity = 0; rs.lastLerp = 0;
				this.angularVelocity = 0;
			}
		}
		else if (this.aimDirection !== null && this.controlledObject === undefined && this.occupyingSeat === null)
		{
			this.orientationTarget.set(this.aimDirection.x, 0, this.aimDirection.z).normalize();
		}
		this.updateModelScale();

		// this.visuals.position.copy(this.modelOffset);
		if (this.physicsEnabled) this.springMovement(timeStep);
		if (this.physicsEnabled) this.springRotation(timeStep);
		if (this.physicsEnabled) this.rotateModel();
		if (this.mixer !== undefined) this.mixer.update(timeStep * ((this.charState as any)?.scaledLoop === true ? this.loopAnimRate : 1));

		// Sync physics/graphics
		if (this.physicsEnabled)
		{
			this.position.set(
				this.characterCapsule.body.interpolatedPosition.x,
				this.characterCapsule.body.interpolatedPosition.y,
				this.characterCapsule.body.interpolatedPosition.z
			);
		}
		else {
			let newPos = new THREE.Vector3();
			this.getWorldPosition(newPos);

			this.characterCapsule.body.position.copy(Utils.cannonVector(newPos));
			this.characterCapsule.body.interpolatedPosition.copy(Utils.cannonVector(newPos));
		}

		this.updateMatrixWorld();
	}

	public inputReceiverInit(): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.inputReceiverInit();
			return;
		}

		this.world.cameraOperator.setRadius(this.cameraDistanceBase * this.playerScale, true);
		this.world.cameraOperator.followMode = false;
		// this.world.dirLight.target = this;

		this.displayControls();
	}

	public displayControls(): void
	{
		this.world.updateControls([
			{
				keys: ['W', 'A', 'S', 'D'],
				desc: 'Movement'
			},
			{
				keys: ['Shift'],
				desc: 'Sprint'
			},
			{
				keys: ['Space'],
				desc: 'Jump'
			},
			{
				keys: ['F', 'or', 'G'],
				desc: 'Enter vehicle'
			},
			{
				keys: ['Shift', '+', 'R'],
				desc: 'Respawn'
			},
			{
				keys: ['Shift', '+', 'C'],
				desc: 'Free camera'
			},
		]);
	}

	public inputReceiverUpdate(timeStep: number): void
	{
		if (this.controlledObject !== undefined)
		{
			this.controlledObject.inputReceiverUpdate(timeStep);
		}
		else
		{
			// Look in camera's direction (first person: the camera is inside the head, use the view itself)
			if (this.firstPersonLook !== null) this.viewVector.copy(this.firstPersonLook);
			else this.viewVector = new THREE.Vector3().subVectors(this.position, this.world.camera.position);
			this.getWorldPosition(this.world.cameraOperator.target);
		}
		
	}

	public setAnimation(clipName: string, fadeIn: number): number
	{
		if (this.mixer !== undefined)
		{
			const clips = this.animations || [];
			let clip = THREE.AnimationClip.findByName(clips, clipName);
			if (!clip)
			{
				clip = clips.find((item) => item && String(item.name).toLowerCase() === clipName.toLowerCase());
			}
			if (!clip)
			{
				const aliases: { [name: string]: string[] } = {
					sprint: ['run', 'walk'],
					jump_idle: ['run', 'walk'],
					jump_running: ['run', 'walk'],
					falling: ['run', 'walk'],
					talking: ['idle', 'walk'],
					driving: ['sitting', 'idle'],
					sitting: ['idle', 'walk'],
					sit_down_left: ['sitting', 'walk'],
					sit_down_right: ['sitting', 'walk'],
					sitting_shift_left: ['sitting', 'idle'],
					sitting_shift_right: ['sitting', 'idle'],
					stand_up_left: ['walk', 'idle'],
					stand_up_right: ['walk', 'idle'],
					start_back_left: ['walk'],
					start_back_right: ['walk'],
					start_forward: ['walk'],
					start_left: ['walk'],
					start_right: ['walk'],
				};
				const fallbacks = aliases[clipName] || ['walk', 'run'];
				for (let i = 0; i < fallbacks.length && !clip; i++)
				{
					clip = THREE.AnimationClip.findByName(clips, fallbacks[i]) ||
						clips.find((item) => item && String(item.name).toLowerCase() === fallbacks[i]);
				}
			}
			if (!clip) return 0;

			const action = this.mixer.clipAction(clip);
			this.mixer.stopAllAction();
			action.reset();
			action.fadeIn(fadeIn);
			action.play();
			action.setEffectiveTimeScale(1);

			return action.getClip().duration;
		}
	}

	public springMovement(timeStep: number): void
	{
		// Simulator
		this.velocitySimulator.target.copy(this.velocityTarget);
		if (this.firstPersonLook !== null && this.vehicleEntryInstance === null && (this.velocityTarget.x !== 0 || this.velocityTarget.z !== 0))
		{
			// first person: W/A/S/D relative to the view. Sprint only forwards, walk speed while aiming.
			const dir = this.getLocalMovementDirectionInto(this.fpMoveDir);
			const cap = this.aimDirection !== null ? 0.8 : (dir.z > 0.5 ? 1.4 : 0.8);
			const speed = Math.min(cap, this.velocityTarget.length());
			this.velocitySimulator.target.set(dir.x * speed, this.velocityTarget.y, dir.z * speed);
		}
		else if (this.aimDirection !== null && this.vehicleEntryInstance === null && (this.velocityTarget.x !== 0 || this.velocityTarget.z !== 0))
		{
			// aiming: W/A/S/D move relative to the aim direction (strafe), at walking speed at most
			const dir = this.getLocalMovementDirection();
			const speed = Math.min(0.8, this.velocityTarget.length());
			this.velocitySimulator.target.set(dir.x * speed, this.velocityTarget.y, dir.z * speed);
		}
		this.velocitySimulator.simulate(timeStep);

		// Update values
		this.velocity.copy(this.velocitySimulator.position);
		this.acceleration.copy(this.velocitySimulator.velocity);
	}

	public springRotation(timeStep: number): void
	{
		// Spring rotation
		// Figure out angle between current and target orientation
		let angle = Utils.getSignedAngleBetweenVectors(this.orientation, this.orientationTarget);

		// Simulator
		this.rotationSimulator.target = angle;
		this.rotationSimulator.simulate(timeStep);
		let rot = this.rotationSimulator.position;

		// Updating values
		this.orientation.applyAxisAngle(new THREE.Vector3(0, 1, 0), rot);
		this.angularVelocity = this.rotationSimulator.velocity;
	}

	public getLocalMovementDirection(): THREE.Vector3
	{
		const positiveX = this.actions.right.isPressed ? -1 : 0;
		const negativeX = this.actions.left.isPressed ? 1 : 0;
		const positiveZ = this.actions.up.isPressed ? 1 : 0;
		const negativeZ = this.actions.down.isPressed ? -1 : 0;

		return new THREE.Vector3(positiveX + negativeX, 0, positiveZ + negativeZ).normalize();
	}

	/** Like getLocalMovementDirection, without allocating. */
	public getLocalMovementDirectionInto(out: THREE.Vector3): THREE.Vector3
	{
		const x = (this.actions.right.isPressed ? -1 : 0) + (this.actions.left.isPressed ? 1 : 0);
		const z = (this.actions.up.isPressed ? 1 : 0) + (this.actions.down.isPressed ? -1 : 0);
		return out.set(x, 0, z).normalize();
	}

	public getCameraRelativeMovementVector(): THREE.Vector3
	{
		const localDirection = this.getLocalMovementDirection();
		const flatViewVector = new THREE.Vector3(this.viewVector.x, 0, this.viewVector.z).normalize();

		return Utils.appplyVectorMatrixXZ(flatViewVector, localDirection);
	}

	public setCameraRelativeOrientationTarget(): void
	{
		if (this.vehicleEntryInstance === null)
		{
			let moveVector = this.getCameraRelativeMovementVector();
	
			if (moveVector.x === 0 && moveVector.y === 0 && moveVector.z === 0)
			{
				this.setOrientation(this.orientation);
			}
			else
			{
				this.setOrientation(moveVector);
			}
		}
	}

	public rotateModel(): void
	{
		this.lookAt(this.position.x + this.orientation.x, this.position.y + this.orientation.y, this.position.z + this.orientation.z);
		this.tiltContainer.rotation.z = (-this.angularVelocity * 2.3 * this.velocity.length());
		this.tiltContainer.position.setY((Math.cos(Math.abs(this.angularVelocity * 2.3 * this.velocity.length())) / 2) - 0.5);
	}

	public jump(initJumpSpeed: number = -1): void
	{
		this.wantsToJump = true;
		this.initJumpSpeed = initJumpSpeed;
	}

	public findVehicleToEnter(wantsToDrive: boolean): void
	{
		// reusable world position variable
		let worldPos = new THREE.Vector3();

		// Find best vehicle
		let vehicleFinder = new ClosestObjectFinder<Vehicle>(this.position, 10);
		this.world.vehicles.forEach((vehicle) =>
		{
			vehicleFinder.consider(vehicle, vehicle.position);
		});

		if (vehicleFinder.closestObject !== undefined)
		{
			let vehicle = vehicleFinder.closestObject;
			let vehicleEntryInstance = new VehicleEntryInstance(this);
			vehicleEntryInstance.wantsToDrive = wantsToDrive;

			// Find best seat
			let seatFinder = new ClosestObjectFinder<VehicleSeat>(this.position);
			for (const seat of vehicle.seats)
			{
				if (wantsToDrive)
				{
					// Consider driver seats
					if (seat.type === SeatType.Driver)
					{
						seat.seatPointObject.getWorldPosition(worldPos);
						seatFinder.consider(seat, worldPos);
					}
					// Consider passenger seats connected to driver seats
					else if (seat.type === SeatType.Passenger)
					{
						for (const connSeat of seat.connectedSeats)
						{
							if (connSeat.type === SeatType.Driver)
							{
								seat.seatPointObject.getWorldPosition(worldPos);
								seatFinder.consider(seat, worldPos);
								break;
							}
						}
					}
				}
				else
				{
					// Consider passenger seats
					if (seat.type === SeatType.Passenger)
					{
						seat.seatPointObject.getWorldPosition(worldPos);
						seatFinder.consider(seat, worldPos);
					}
				}
			}

			if (seatFinder.closestObject !== undefined)
			{
				let targetSeat = seatFinder.closestObject;
				vehicleEntryInstance.targetSeat = targetSeat;

				let entryPointFinder = new ClosestObjectFinder<Object3D>(this.position);

				for (const point of targetSeat.entryPoints) {
					point.getWorldPosition(worldPos);
					entryPointFinder.consider(point, worldPos);
				}

				if (entryPointFinder.closestObject !== undefined)
				{
					vehicleEntryInstance.entryPoint = entryPointFinder.closestObject;
					this.triggerAction('up', true);
					this.vehicleEntryInstance = vehicleEntryInstance;
				}
			}
		}
	}

	public enterVehicle(seat: VehicleSeat, entryPoint: THREE.Object3D): void
	{
		this.resetControls();

		if (seat.door?.rotation < 0.5)
		{
			this.setState(new OpenVehicleDoor(this, seat, entryPoint));
		}
		else
		{
			this.setState(new EnteringVehicle(this, seat, entryPoint));
		}
	}

	public teleportToVehicle(vehicle: Vehicle, seat: VehicleSeat): void
	{
		this.resetVelocity();
		this.rotateModel();
		this.setPhysicsEnabled(false);
		(vehicle as unknown as THREE.Object3D).attach(this);

		this.setPosition(seat.seatPointObject.position.x, seat.seatPointObject.position.y + this.seatOffsetY(0.6), seat.seatPointObject.position.z);
		this.quaternion.copy(seat.seatPointObject.quaternion);

		this.occupySeat(seat);
		this.setState(new Driving(this, seat));

		this.startControllingVehicle(vehicle, seat);
	}

	public startControllingVehicle(vehicle: IControllable, seat: VehicleSeat): void
	{
		if (this.controlledObject !== vehicle)
		{
			this.transferControls(vehicle);
			this.resetControls();
	
			this.controlledObject = vehicle;
			this.controlledObject.allowSleep(false);
			vehicle.inputReceiverInit();
	
			vehicle.controllingCharacter = this;
		}
	}

	public transferControls(entity: IControllable): void
	{
		// Currently running through all actions of this character and the vehicle,
		// comparing keycodes of actions and based on that triggering vehicle's actions
		// Maybe we should ask input manager what's the current state of the keyboard
		// and read those values... TODO
		for (const action1 in this.actions) {
			if (this.actions.hasOwnProperty(action1)) {
				for (const action2 in entity.actions) {
					if (entity.actions.hasOwnProperty(action2)) {

						let a1 = this.actions[action1];
						let a2 = entity.actions[action2];

						a1.eventCodes.forEach((code1) => {
							a2.eventCodes.forEach((code2) => {
								if (code1 === code2)
								{
									entity.triggerAction(action2, a1.isPressed);
								}
							});
						});
					}
				}
			}
		}
	}

	public stopControllingVehicle(): void
	{
		if (this.controlledObject?.controllingCharacter === this)
		{
			this.controlledObject.allowSleep(true);
			this.controlledObject.controllingCharacter = undefined;
			this.controlledObject.resetControls();
			this.controlledObject = undefined;
			this.inputReceiverInit();
		}
	}

	public exitVehicle(): void
	{
		if (this.occupyingSeat !== null)
		{
			if (this.occupyingSeat.vehicle.entityType === EntityType.Airplane)
			{
				this.setState(new ExitingAirplane(this, this.occupyingSeat));
			}
			else
			{
				this.setState(new ExitingVehicle(this, this.occupyingSeat));
			}
			
			this.stopControllingVehicle();
		}
	}

	public occupySeat(seat: VehicleSeat): void
	{
		this.occupyingSeat = seat;
		seat.occupiedBy = this;
	}

	public leaveSeat(): void
	{
		if (this.occupyingSeat !== null)
		{
			this.occupyingSeat.occupiedBy = null;
			this.occupyingSeat = null;
		}
	}

	public physicsPreStep(body: CANNON.Body, character: Character): void
	{
		character.feetRaycast();

		// Raycast debug
		if (character.rayHasHit)
		{
			if (character.raycastBox.visible) {
				character.raycastBox.position.x = character.rayResult.hitPointWorld.x;
				character.raycastBox.position.y = character.rayResult.hitPointWorld.y;
				character.raycastBox.position.z = character.rayResult.hitPointWorld.z;
			}
		}
		else
		{
			if (character.raycastBox.visible) {
				character.raycastBox.position.set(body.position.x, body.position.y - character.rayCastLength - character.raySafeOffset, body.position.z);
			}
		}
	}

	public feetRaycast(): void
	{
		// Player ray casting
		// Create ray
		let body = this.characterCapsule.body;
		const start = new CANNON.Vec3(body.position.x, body.position.y, body.position.z);
		const end = new CANNON.Vec3(body.position.x, body.position.y - this.rayCastLength - this.raySafeOffset, body.position.z);
		// Raycast options
		const rayCastOptions = {
			collisionFilterMask: CollisionGroups.Default,
			skipBackfaces: true      /* ignore back faces */
		};
		// Cast the ray
		this.rayHasHit = this.world.physicsWorld.raycastClosest(start, end, rayCastOptions, this.rayResult);
	}

	public physicsPostStep(body: CANNON.Body, character: Character): void
	{
		// Get velocities
		let simulatedVelocity = new THREE.Vector3(body.velocity.x, body.velocity.y, body.velocity.z);

		// Take local velocity
		let arcadeVelocity = new THREE.Vector3().copy(character.velocity).multiplyScalar(character.moveSpeed);
		// Turn local into global
		arcadeVelocity = Utils.appplyVectorMatrixXZ(character.orientation, arcadeVelocity);

		let newVelocity = new THREE.Vector3();

		// Additive velocity mode
		if (character.arcadeVelocityIsAdditive)
		{
			newVelocity.copy(simulatedVelocity);

			let globalVelocityTarget = Utils.appplyVectorMatrixXZ(character.orientation, character.velocityTarget);
			let add = new THREE.Vector3().copy(arcadeVelocity).multiply(character.arcadeVelocityInfluence);

			if (Math.abs(simulatedVelocity.x) < Math.abs(globalVelocityTarget.x * character.moveSpeed) || Utils.haveDifferentSigns(simulatedVelocity.x, arcadeVelocity.x)) { newVelocity.x += add.x; }
			if (Math.abs(simulatedVelocity.y) < Math.abs(globalVelocityTarget.y * character.moveSpeed) || Utils.haveDifferentSigns(simulatedVelocity.y, arcadeVelocity.y)) { newVelocity.y += add.y; }
			if (Math.abs(simulatedVelocity.z) < Math.abs(globalVelocityTarget.z * character.moveSpeed) || Utils.haveDifferentSigns(simulatedVelocity.z, arcadeVelocity.z)) { newVelocity.z += add.z; }
		}
		else
		{
			newVelocity = new THREE.Vector3(
				THREE.MathUtils.lerp(simulatedVelocity.x, arcadeVelocity.x, character.arcadeVelocityInfluence.x),
				THREE.MathUtils.lerp(simulatedVelocity.y, arcadeVelocity.y, character.arcadeVelocityInfluence.y),
				THREE.MathUtils.lerp(simulatedVelocity.z, arcadeVelocity.z, character.arcadeVelocityInfluence.z),
			);
		}

		// If we're hitting the ground, stick to ground
		if (character.rayHasHit)
		{
			// Flatten velocity
			newVelocity.y = 0;

			// Move on top of moving objects
			if (character.rayResult.body.mass > 0)
			{
				let pointVelocity = new CANNON.Vec3();
				character.rayResult.body.getVelocityAtWorldPoint(character.rayResult.hitPointWorld, pointVelocity);
				newVelocity.add(Utils.threeVector(pointVelocity));
			}

			// Measure the normal vector offset from direct "up" vector
			// and transform it into a matrix
			let up = new THREE.Vector3(0, 1, 0);
			let normal = new THREE.Vector3(character.rayResult.hitNormalWorld.x, character.rayResult.hitNormalWorld.y, character.rayResult.hitNormalWorld.z);
			let q = new THREE.Quaternion().setFromUnitVectors(up, normal);
			let m = new THREE.Matrix4().makeRotationFromQuaternion(q);

			// Rotate the velocity vector
			newVelocity.applyMatrix4(m);

			// Compensate for gravity
			// newVelocity.y -= body.world.physicsWorld.gravity.y / body.character.world.physicsFrameRate;

			// Apply velocity
			body.velocity.x = newVelocity.x;
			body.velocity.y = newVelocity.y;
			body.velocity.z = newVelocity.z;
			// Ground character
			body.position.y = character.rayResult.hitPointWorld.y + character.rayCastLength + (newVelocity.y / character.world.physicsFrameRate);
		}
		else
		{
			// If we're in air
			body.velocity.x = newVelocity.x;
			body.velocity.y = newVelocity.y;
			body.velocity.z = newVelocity.z;

			// Save last in-air information
			character.groundImpactData.velocity.x = body.velocity.x;
			character.groundImpactData.velocity.y = body.velocity.y;
			character.groundImpactData.velocity.z = body.velocity.z;
		}

		// Jumping
		if (character.wantsToJump)
		{
			// If initJumpSpeed is set
			if (character.initJumpSpeed > -1)
			{
				// Flatten velocity
				body.velocity.y = 0;
				let speed = Math.max(character.velocitySimulator.position.length() * character.moveSpeed, character.initJumpSpeed * character.speedFactor);
				body.velocity = Utils.cannonVector(character.orientation.clone().multiplyScalar(speed));
			}
			else {
				// Moving objects compensation
				let add = new CANNON.Vec3();
				character.rayResult.body.getVelocityAtWorldPoint(character.rayResult.hitPointWorld, add);
				body.velocity.vsub(add, body.velocity);
			}

			// Add positive vertical velocity 
			body.velocity.y += 4 * character.speedFactor;
			// Move above ground by 2x safe offset value
			body.position.y += character.raySafeOffset * 2;
			// Reset flag
			character.wantsToJump = false;
		}

		if (character.realismPostStep !== null) character.realismPostStep(body);
	}

	public addToWorld(world: World): void
	{
		if (_.includes(world.characters, this))
		{
			console.warn('Adding character to a world in which it already exists.');
		}
		else
		{
			// Set world
			this.world = world;

			// Register character
			world.characters.push(this);

			// Register physics
			world.physicsWorld.addBody(this.characterCapsule.body);

			// Add to graphicsWorld
			world.graphicsWorld.add(this);
			world.graphicsWorld.add(this.raycastBox);

			// Shadow cascades
			this.materials.forEach((mat) =>
			{
				world.sky.csm.setupMaterial(mat);
			});
		}
	}

	public removeFromWorld(world: World): void
	{
		if (!_.includes(world.characters, this))
		{
			console.warn('Removing character from a world in which it isn\'t present.');
		}
		else
		{
			if (world.inputManager.inputReceiver === this)
			{
				world.inputManager.inputReceiver = undefined;
			}

			this.world = undefined;

			// Remove from characters
			_.pull(world.characters, this);

			// Remove physics
			world.physicsWorld.remove(this.characterCapsule.body);

			// Remove visuals
			world.graphicsWorld.remove(this);
			world.graphicsWorld.remove(this.raycastBox);
		}
	}
}