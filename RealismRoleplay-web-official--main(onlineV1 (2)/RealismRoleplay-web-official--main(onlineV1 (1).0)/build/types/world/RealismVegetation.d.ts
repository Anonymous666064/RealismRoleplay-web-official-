import { RealismCtx } from './RealismContext';
export interface VegetationStats {
    hedges: number;
    bushes: number;
    hedgeMetres: number;
    colliders: number;
    meshes: number;
    /** Per kind of hedge (houseFront, houseSide, buildingFront, buildingSide, shopPlanter, park): runs, metres, pieces. */
    hedgeRuns: {
        [tag: string]: {
            runs: number;
            metres: number;
            pieces: number;
        };
    };
    customHedgeModels: number;
    customBushModels: number;
}
/** Places hedges and bushes. Call after buildings/street props, before ctx.phys.commit(). */
export declare function buildVegetation(ctx: RealismCtx): VegetationStats;
