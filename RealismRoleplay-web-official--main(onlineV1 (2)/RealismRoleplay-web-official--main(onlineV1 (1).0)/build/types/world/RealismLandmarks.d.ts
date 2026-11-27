import { RealismCtx } from './RealismContext';
import { AssetInstancer } from './RealismAssets';
import { InteriorPlan } from './RealismBuildings';
export declare class LandmarkBuilder {
    private ctx;
    private city;
    private furn;
    private set;
    stats: {
        towers: number;
        cells: number;
        cruisers: number;
    };
    constructor(ctx: RealismCtx, city: AssetInstancer, furn: AssetInstancer);
    private acc;
    build(plans: InteriorPlan[]): void;
    private free;
    private floodlight;
    /** Prison / jail cell row along local x (front of the cells faces +z). */
    private cellRow;
    private station;
    private helipad;
    private prisonWall;
    private guardTower;
    private cellBlock;
    private prisonGrounds;
    private radioMast;
    private lookout;
    /** Classic fire-lookout tower: four legs, cross bracing, switch-back stairs and a glass cab on top. */
    private fireTower;
}
