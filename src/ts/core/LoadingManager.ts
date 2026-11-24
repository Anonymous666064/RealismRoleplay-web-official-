import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { LoadingTrackerEntry } from './LoadingTrackerEntry';
import { UIManager } from './UIManager';
import { Scenario } from '../world/Scenario';
import Swal from 'sweetalert2';
import { World } from '../world/World';

export class LoadingManager
{
	public firstLoad: boolean = true;
	public onFinishedCallback: () => void;
	
	private world: World;
	private gltfLoader: GLTFLoader;
	private loadingTracker: LoadingTrackerEntry[] = [];

	constructor(world: World)
	{
		this.world = world;
		this.gltfLoader = new GLTFLoader();

		this.world.setTimeScale(0);
		UIManager.setUserInterfaceVisible(false);
		UIManager.setLoadingScreenVisible(true);
	}

	/**
	 * Loads a glb. If the file 404s, tries the other places the stock Sketchbook
	 * assets can live before giving up:
	 *   1. the path as given (relative to index.html), e.g. build/assets/boxman.glb
	 *   2. the same path from the site root, e.g. /build/assets/boxman.glb
	 *   3. REALISM_CONFIG.assetFallbackUrl + file name (default: the GitHub repo via jsDelivr CDN)
	 * If everything fails, an on-screen message says which file is missing
	 * instead of the game silently hanging on the loading screen.
	 */
	public loadGLTF(path: string, onLoadingFinished: (gltf: any) => void): void
	{
		let trackerEntry = this.addLoadingEntry(path);
		const candidates = LoadingManager.candidatePaths(path);
		const errors: string[] = [];

		const attempt = (i: number) =>
		{
			const url = candidates[i];
			this.gltfLoader.load(url,
			(gltf) =>
			{
				if (i > 0) console.warn('[Realism] Loaded ' + path + ' from fallback ' + url + '. Put the file at ' + path + ' on your server to load it locally.');
				onLoadingFinished(gltf);
				this.doneLoading(trackerEntry);
			},
			(xhr) =>
			{
				if (xhr.lengthComputable)
				{
					trackerEntry.progress = xhr.loaded / xhr.total;
				}
			},
			(error: any) =>
			{
				const status = error && error.target && error.target.status ? error.target.status : 'network error';
				errors.push(url + ' (' + status + ')');
				if (i + 1 < candidates.length)
				{
					console.warn('[Realism] ' + url + ' failed (' + status + '), trying ' + candidates[i + 1]);
					attempt(i + 1);
				}
				else
				{
					console.error('[Realism] Could not load ' + path + '. Tried: ' + errors.join(', '));
					LoadingManager.showAssetError(path, errors);
					// Don't hang the loading screen forever: let the rest of the world start.
					this.doneLoading(trackerEntry);
				}
			});
		};
		attempt(0);
	}

	private static candidatePaths(path: string): string[]
	{
		const list: string[] = [path];
		if (/^(https?:)?\/\//.test(path)) return list;
		const clean = path.replace(/^\.?\//, '');
		const rooted = '/' + clean;
		if (list.indexOf(rooted) === -1) list.push(rooted);

		const cfg: any = (typeof window !== 'undefined' && (window as any).REALISM_CONFIG) || {};
		let fallback: string = cfg.assetFallbackUrl === undefined
			? 'https://cdn.jsdelivr.net/gh/Anonymous666064/RealismRoleplay@main/Sketchbook-master/'
			: cfg.assetFallbackUrl;
		if (fallback)
		{
			if (fallback.charAt(fallback.length - 1) !== '/') fallback += '/';
			list.push(fallback + clean);
		}
		return list;
	}

	private static showAssetError(path: string, tried: string[]): void
	{
		if (typeof document === 'undefined') return;
		let box = document.getElementById('realism-asset-error');
		if (!box)
		{
			box = document.createElement('div');
			box.id = 'realism-asset-error';
			box.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:99999;max-width:90%;' +
				'background:#b00020;color:#fff;font:13px/1.4 Arial,sans-serif;padding:10px 14px;border-radius:6px;white-space:pre-wrap;';
			document.body.appendChild(box);
		}
		box.textContent += (box.textContent ? '\n' : '') + 'Missing file: ' + path +
			'. Put the build/assets folder next to build/sketchbook.min.js on your server. Tried: ' + tried.join(', ');
	}

	public addLoadingEntry(path: string): LoadingTrackerEntry
	{
		let entry = new LoadingTrackerEntry(path);
		this.loadingTracker.push(entry);

		return entry;
	}

	public doneLoading(trackerEntry: LoadingTrackerEntry): void
	{
		trackerEntry.finished = true;
		trackerEntry.progress = 1;

		if (this.isLoadingDone())
		{
			if (this.onFinishedCallback !== undefined) 
			{
				this.onFinishedCallback();
			}
			else
			{
				UIManager.setUserInterfaceVisible(true);
			}

			UIManager.setLoadingScreenVisible(false);
		}
	}

	public createWelcomeScreenCallback(scenario: Scenario): void
	{
		if (this.onFinishedCallback === undefined)
		{
			this.onFinishedCallback = () =>
			{
				this.world.update(1, 1);
	
				Swal.fire({
					title: scenario.descriptionTitle,
					html: scenario.descriptionContent,
					confirmButtonText: 'Play',
					buttonsStyling: false,
					onClose: () => {
						this.world.setTimeScale(1);
						UIManager.setUserInterfaceVisible(true);
					}
				});
			};
		}
	}

	private getLoadingPercentage(): number
	{
		let done = true;
		let total = 0;
		let finished = 0;

		for (const item of this.loadingTracker)
		{
			total++;
			finished += item.progress;
			if (!item.finished) done = false;
		}

		return (finished / total) * 100;
	}

	private isLoadingDone(): boolean
	{
		for (const entry of this.loadingTracker) {
			if (!entry.finished) return false;
		}
		return true;
	}
}