import { ISpawnPoint } from '../interfaces/ISpawnPoint';
import * as THREE from 'three';
import { World } from './World';
import { Character } from '../characters/Character';
import { LoadingManager } from '../core/LoadingManager';
import * as Utils from '../core/FunctionLibrary';
import { loadSharedModel } from './RealismNPCs';
import { SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils';

export class CharacterSpawnPoint implements ISpawnPoint
{
	private object: THREE.Object3D;

	constructor(object: THREE.Object3D)
	{
		this.object = object;
	}
	
	public spawn(loadingManager: LoadingManager, world: World): void
	{
		const w: any = world;
		const normalizeGender = (value: any): string => value === 'female' ? 'female' : 'male';
		const modelPath = (gender: string): string => 'build/assets/characters/' + normalizeGender(gender) + '.glb';
		const identity = (window as any).RRMP && (window as any).RRMP.identity;
		const initialGender = normalizeGender(identity && identity.gender || w.realismPlayerGender);
		w.realismPlayerGender = initialGender;
		w.realismSetPlayerGender = (value: string): void =>
		{
			const gender = normalizeGender(value);
			w.realismPlayerGender = gender;
			const input: any = world.inputManager && (world.inputManager as any).inputReceiver;
			const activeCharacter: any = input && (input.controllingCharacter || input);
			const player: any = activeCharacter && typeof activeCharacter.replaceModel === 'function'
				? activeCharacter
				: (world.characters || []).find((character: any) => character && typeof character.replaceModel === 'function' && character.realismGender);
			if (!player) return;
			loadSharedModel(modelPath(gender), (model) =>
			{
				if ((world.characters || []).indexOf(player) < 0) return;
				try
				{
					player.realismGender = gender;
					player.replaceModel({ scene: SkeletonUtils.clone(model.scene), animations: model.animations || [] });
				}
				catch (error) { console.error('[Realism] Could not apply player gender model', error); }
			}, () => console.error('[Realism] Could not load player model: ' + modelPath(gender)));
		};

		const addPlayer = (model: any, gender: string): void =>
		{
			const player = new Character(model);
			player.realismGender = gender;
			const identityState = (window as any).RRMP && (window as any).RRMP.identity;
			if (identityState && identityState.skinColor)
			{
				player.modelContainer.traverse((node: any) =>
				{
					if (!node.isMesh || !node.material) return;
					const materials = Array.isArray(node.material) ? node.material : [node.material];
					for (let i = 0; i < materials.length; i++)
					{
						if (materials[i] && materials[i].color) materials[i].color.set(identityState.skinColor);
					}
				});
			}
			
			let worldPos = new THREE.Vector3();
			this.object.getWorldPosition(worldPos);
			player.setPosition(worldPos.x, worldPos.y, worldPos.z);
			
			let forward = Utils.getForward(this.object);
			player.setOrientation(forward, true);
			
			world.add(player);
			player.takeControl();
			const currentGender = normalizeGender(w.realismPlayerGender);
			if (currentGender !== gender) w.realismSetPlayerGender(currentGender);
		};

		const tracker = loadingManager.addLoadingEntry(modelPath(initialGender));
		loadSharedModel(modelPath(initialGender), (model) =>
		{
			try { addPlayer({ scene: SkeletonUtils.clone(model.scene), animations: model.animations || [] }, initialGender); }
			finally { loadingManager.doneLoading(tracker); }
		}, () =>
		{
			console.error('[Realism] Could not load player model: ' + modelPath(initialGender) + '; using the default character.');
			loadingManager.loadGLTF('build/assets/boxman.glb', (model) => addPlayer(model, 'male'));
			loadingManager.doneLoading(tracker);
		});
	}
}