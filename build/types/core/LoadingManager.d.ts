import { LoadingTrackerEntry } from './LoadingTrackerEntry';
import { Scenario } from '../world/Scenario';
import { World } from '../world/World';
export declare class LoadingManager {
    firstLoad: boolean;
    onFinishedCallback: () => void;
    private world;
    private gltfLoader;
    private loadingTracker;
    constructor(world: World);
    /**
     * Loads a glb. If the file 404s, tries the other places the stock Sketchbook
     * assets can live before giving up:
     *   1. the path as given (relative to index.html), e.g. build/assets/boxman.glb
     *   2. the same path from the site root, e.g. /build/assets/boxman.glb
     *   3. REALISM_CONFIG.assetFallbackUrl + file name (default: the GitHub repo via jsDelivr CDN)
     * If everything fails, an on-screen message says which file is missing
     * instead of the game silently hanging on the loading screen.
     */
    loadGLTF(path: string, onLoadingFinished: (gltf: any) => void): void;
    private static candidatePaths;
    private static showAssetError;
    addLoadingEntry(path: string): LoadingTrackerEntry;
    doneLoading(trackerEntry: LoadingTrackerEntry): void;
    createWelcomeScreenCallback(scenario: Scenario): void;
    private getLoadingPercentage;
    private isLoadingDone;
}
