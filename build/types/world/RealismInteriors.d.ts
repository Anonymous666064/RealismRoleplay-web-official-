import { RealismCtx } from './RealismContext';
import { AssetInstancer } from './RealismAssets';
import { InteriorPlan } from './RealismBuildings';
interface Item {
    w: number;
    d: number;
    h: number;
    solid?: boolean;
}
/** Footprints (metres, front of the piece faces local +z). */
export declare const FURNITURE: {
    [name: string]: Item;
};
export declare function buildInteriors(ctx: RealismCtx, plans: InteriorPlan[], inst: AssetInstancer): number;
export {};
