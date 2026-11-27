import { RealismCtx } from './RealismContext';
/** Dresses the gang neighbourhoods. Call after buildings/street props, before ctx.phys.commit(). */
export declare function buildHoodDetails(ctx: RealismCtx): {
    [k: string]: number;
};
