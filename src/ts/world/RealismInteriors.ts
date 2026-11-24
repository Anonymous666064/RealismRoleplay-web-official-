/*
 * RealismInteriors.ts
 * -------------------
 * Furniture for every enterable building: fridges, stoves, counters, TVs,
 * couches, beds, bathrooms, store shelves, diner booths, office desks...
 *
 * Every piece is a named asset ('fridge', 'tv', 'couch', ...). Give it a .glb in
 * realism-config.js (house.furniture.<name>) and your model replaces the
 * built-in one in every building, scaled the way you set it.
 *
 * Furniture is GPU-instanced per area and hidden beyond the preset's
 * interiorDistance, so a whole city of furnished houses stays cheap.
 */

import { RealismCtx } from './RealismContext';
import { GeoAccum, Frame, boxC, box, cyl, hash01 } from './RealismGeometry';
import { AssetInstancer, partsFrom, AssetPart } from './RealismAssets';
import { InteriorPlan, Room } from './RealismBuildings';

interface Item { w: number; d: number; h: number; solid?: boolean; }

/** Footprints (metres, front of the piece faces local +z). */
export const FURNITURE: { [name: string]: Item } = {
	fridge: { w: 0.78, d: 0.72, h: 1.8, solid: true },
	stove: { w: 0.76, d: 0.65, h: 0.95, solid: true },
	counter: { w: 0.62, d: 0.62, h: 0.92, solid: true },
	sink: { w: 0.62, d: 0.62, h: 0.92, solid: true },
	diningTable: { w: 1.6, d: 0.9, h: 0.76, solid: true },
	chair: { w: 0.45, d: 0.45, h: 0.92 },
	couch: { w: 2.1, d: 0.92, h: 0.85, solid: true },
	armchair: { w: 0.92, d: 0.86, h: 0.85, solid: true },
	coffeeTable: { w: 1.1, d: 0.6, h: 0.42 },
	tvStand: { w: 1.6, d: 0.45, h: 0.5, solid: true },
	tv: { w: 1.3, d: 0.1, h: 0.78 },
	rug: { w: 2.3, d: 1.6, h: 0.01 },
	floorLamp: { w: 0.4, d: 0.4, h: 1.62 },
	bookshelf: { w: 0.9, d: 0.35, h: 1.9, solid: true },
	bed: { w: 1.6, d: 2.05, h: 0.62, solid: true },
	nightstand: { w: 0.46, d: 0.4, h: 0.55 },
	wardrobe: { w: 1.2, d: 0.6, h: 2.0, solid: true },
	dresser: { w: 1.1, d: 0.5, h: 0.85, solid: true },
	toilet: { w: 0.42, d: 0.68, h: 0.8 },
	bathSink: { w: 0.56, d: 0.46, h: 0.86 },
	bathtub: { w: 1.7, d: 0.76, h: 0.56, solid: true },
	desk: { w: 1.4, d: 0.7, h: 0.76, solid: true },
	officeChair: { w: 0.6, d: 0.6, h: 1.05 },
	shelf: { w: 1.8, d: 0.6, h: 1.6, solid: true },
	checkout: { w: 1.8, d: 0.8, h: 1.0, solid: true },
	cooler: { w: 1.25, d: 0.75, h: 2.05, solid: true },
	booth: { w: 1.4, d: 0.65, h: 1.1, solid: true },
	barStool: { w: 0.4, d: 0.4, h: 0.76 },
	bunkBed: { w: 0.95, d: 2.0, h: 1.7, solid: true },
	locker: { w: 0.9, d: 0.5, h: 1.9, solid: true },
	plant: { w: 0.5, d: 0.5, h: 1.1 },
	mattress: { w: 1.4, d: 1.95, h: 0.22 },
	trashBag: { w: 0.55, d: 0.55, h: 0.55 },
	washer: { w: 0.66, d: 0.66, h: 0.95, solid: true },
	rack: { w: 2.7, d: 1.0, h: 3.0, solid: true },
	pallet: { w: 1.2, d: 1.0, h: 1.1, solid: true },
	bench: { w: 2.4, d: 0.55, h: 0.9, solid: true },
	receptionDesk: { w: 2.4, d: 0.85, h: 1.08, solid: true },
	hospitalBed: { w: 1.0, d: 2.1, h: 0.95, solid: true },
	seatRow: { w: 2.5, d: 0.65, h: 0.85, solid: true },
	clothesRack: { w: 1.4, d: 0.55, h: 1.5 },
	barberChair: { w: 0.72, d: 0.85, h: 1.15 },
	carLift: { w: 3.6, d: 5.0, h: 2.2 },
	toolChest: { w: 1.2, d: 0.5, h: 1.05, solid: true },
	hayBale: { w: 1.2, d: 0.6, h: 0.6, solid: true },
	vaultDoor: { w: 2.2, d: 0.4, h: 2.3, solid: true },
	ceilingLight: { w: 0.5, d: 0.5, h: 0.06 },
	boxes: { w: 0.9, d: 0.7, h: 0.8, solid: true },
	judgeBench: { w: 3.2, d: 1.1, h: 1.35, solid: true },
	piano: { w: 1.5, d: 0.6, h: 1.25, solid: true },
	woodStove: { w: 0.6, d: 0.6, h: 0.9, solid: true },
	telescope: { w: 0.6, d: 0.6, h: 1.5 },
	cell: { w: 2.5, d: 3.0, h: 2.8 },
	laptop: { w: 0.36, d: 0.27, h: 0.25 },
};

const WOOD = [0.5, 0.34, 0.22], DARKWOOD = [0.32, 0.21, 0.14], WHITE = [0.94, 0.94, 0.93], STEEL = [0.7, 0.71, 0.73], BLACK = [0.08, 0.08, 0.09];
const COUCH = [[0.35, 0.36, 0.4], [0.55, 0.42, 0.3], [0.25, 0.3, 0.42], [0.6, 0.58, 0.52]];
const WORN = [[0.42, 0.36, 0.28], [0.38, 0.34, 0.3]];
const BEDDING = [[0.85, 0.85, 0.88], [0.4, 0.5, 0.65], [0.7, 0.55, 0.5], [0.55, 0.6, 0.5]];

function m(c: number[], k: number): number[] { return [c[0] * k, c[1] * k, c[2] * k]; }

/** Built-in procedural furniture. Returns [[accum, material], ...] lists per piece. */
function makeFurniture(ctx: RealismCtx, name: string, v: number): AssetPart[]
{
	const a = new GeoAccum(), s = new GeoAccum(), g = new GeoAccum(), f = new Frame(0, 0, 0, 0);
	const it = FURNITURE[name];
	const W = it.w, D = it.d, H = it.h;
	switch (name)
	{
		case 'fridge':
			boxC(s, f, 0, H / 2, 0, W, H, D, v ? [0.75, 0.76, 0.78] : WHITE);
			box(a, f, -W / 2 + 0.02, 1.1, D / 2, W / 2 - 0.02, 1.11, D / 2 + 0.005, [0.6, 0.6, 0.6]);
			boxC(a, f, W / 2 - 0.1, 1.45, D / 2 + 0.03, 0.03, 0.4, 0.04, STEEL);
			boxC(a, f, W / 2 - 0.1, 0.75, D / 2 + 0.03, 0.03, 0.4, 0.04, STEEL);
			break;
		case 'stove':
			boxC(a, f, 0, 0.45, 0, W, 0.9, D, v ? [0.2, 0.2, 0.21] : WHITE);
			boxC(s, f, 0, 0.91, 0, W, 0.02, D, BLACK);
			for (let i = 0; i < 4; i++) cyl(a, f, (i % 2 ? 0.18 : -0.18), 0.92, (i < 2 ? 0.15 : -0.12), 0.015, 0.1, 0.1, 10, [0.15, 0.15, 0.15], true);
			boxC(s, f, 0, 0.45, D / 2 + 0.005, W - 0.12, 0.4, 0.01, [0.1, 0.1, 0.12]);
			boxC(a, f, 0, 0.95, -D / 2 + 0.05, W, 0.1, 0.05, [0.3, 0.3, 0.3]);
			break;
		case 'counter':
		case 'sink':
			boxC(a, f, 0, 0.45, -0.02, W, 0.86, D - 0.04, v ? [0.25, 0.35, 0.3] : [0.85, 0.83, 0.78]);
			boxC(s, f, 0, 0.9, 0, W + 0.01, 0.04, D, v ? [0.15, 0.15, 0.15] : [0.62, 0.6, 0.57]);
			boxC(a, f, 0, 0.5, D / 2 - 0.03, 0.12, 0.02, 0.02, STEEL);
			if (name === 'sink')
			{
				boxC(s, f, 0, 0.9, 0, 0.45, 0.045, 0.38, [0.4, 0.42, 0.45]);
				cyl(s, f, 0, 0.92, -0.22, 0.28, 0.02, 0.02, 6, STEEL);
				boxC(s, f, 0, 1.19, -0.15, 0.03, 0.03, 0.15, STEEL);
			}
			break;
		case 'diningTable':
			boxC(a, f, 0, H - 0.03, 0, W, 0.05, D, v ? DARKWOOD : WOOD);
			for (let i = 0; i < 4; i++) boxC(a, f, (i % 2 ? 1 : -1) * (W / 2 - 0.08), (H - 0.05) / 2, (i < 2 ? 1 : -1) * (D / 2 - 0.08), 0.06, H - 0.05, 0.06, v ? DARKWOOD : WOOD);
			break;
		case 'chair':
			boxC(a, f, 0, 0.46, 0, 0.44, 0.05, 0.44, WOOD);
			boxC(a, f, 0, 0.7, -0.2, 0.44, 0.45, 0.04, WOOD);
			for (let i = 0; i < 4; i++) boxC(a, f, (i % 2 ? 1 : -1) * 0.19, 0.22, (i < 2 ? 1 : -1) * 0.19, 0.04, 0.44, 0.04, WOOD);
			break;
		case 'couch':
		case 'armchair':
		{
			const c = v >= 10 ? WORN[(v - 10) % WORN.length] : COUCH[v % COUCH.length];
			boxC(a, f, 0, 0.22, 0, W, 0.3, D, m(c, 0.85));
			boxC(a, f, 0, 0.42, 0.06, W - 0.36, 0.14, D - 0.2, c);
			boxC(a, f, 0, 0.62, -D / 2 + 0.12, W, 0.55, 0.24, c);
			boxC(a, f, -W / 2 + 0.09, 0.5, 0, 0.18, 0.3, D, m(c, 0.9));
			boxC(a, f, W / 2 - 0.09, 0.5, 0, 0.18, 0.3, D, m(c, 0.9));
			if (name === 'couch') boxC(a, f, 0, 0.42, 0.06, 0.02, 0.15, D - 0.2, m(c, 0.7));
			break;
		}
		case 'coffeeTable':
			boxC(a, f, 0, H - 0.03, 0, W, 0.05, D, v ? DARKWOOD : WOOD);
			boxC(a, f, 0, 0.12, 0, W - 0.1, 0.03, D - 0.1, v ? DARKWOOD : WOOD);
			for (let i = 0; i < 4; i++) boxC(a, f, (i % 2 ? 1 : -1) * (W / 2 - 0.05), H / 2, (i < 2 ? 1 : -1) * (D / 2 - 0.05), 0.05, H, 0.05, DARKWOOD);
			break;
		case 'tvStand':
			boxC(a, f, 0, H / 2, 0, W, H, D, v ? [0.15, 0.15, 0.15] : DARKWOOD);
			box(a, f, -W / 2 + 0.05, 0.08, D / 2, W / 2 - 0.05, H - 0.08, D / 2 + 0.005, m(DARKWOOD, 0.6));
			break;
		case 'tv':
			boxC(a, f, 0, 0.05, 0, 0.35, 0.02, 0.2, BLACK);
			boxC(a, f, 0, 0.12, -0.02, 0.06, 0.14, 0.04, BLACK);
			boxC(a, f, 0, 0.5, 0, W, 0.72, 0.05, BLACK);
			box(s, f, -W / 2 + 0.03, 0.17, 0.026, W / 2 - 0.03, 0.83, 0.03, v ? [0.12, 0.25, 0.35] : [0.05, 0.06, 0.08]);
			break;
		case 'rug':
		{
			const c = [[0.55, 0.2, 0.18], [0.3, 0.35, 0.5], [0.7, 0.65, 0.55], [0.35, 0.3, 0.25]][v % 4];
			box(a, f, -W / 2, 0, -D / 2, W / 2, 0.012, D / 2, c, 'b');
			box(a, f, -W / 2 + 0.15, 0.013, -D / 2 + 0.15, W / 2 - 0.15, 0.014, D / 2 - 0.15, m(c, 1.25), 'bfklr');
			break;
		}
		case 'floorLamp':
			cyl(a, f, 0, 0, 0, 0.03, 0.18, 0.18, 10, BLACK, true);
			cyl(a, f, 0, 0.03, 0, 1.3, 0.015, 0.015, 6, BLACK);
			cyl(g, f, 0, 1.3, 0, 0.3, 0.2, 0.13, 10, [1, 1, 1], true);
			break;
		case 'bookshelf':
			box(a, f, -W / 2, 0, -D / 2, -W / 2 + 0.03, H, D / 2, WOOD); box(a, f, W / 2 - 0.03, 0, -D / 2, W / 2, H, D / 2, WOOD);
			box(a, f, -W / 2, 0, -D / 2, W / 2, H, -D / 2 + 0.02, m(WOOD, 0.8));
			for (let i = 0; i < 5; i++)
			{
				box(a, f, -W / 2, i * 0.45, -D / 2, W / 2, i * 0.45 + 0.03, D / 2, WOOD);
				if (i < 4) for (let k = 0; k < 8; k++)
				{
					const bc = [[0.6, 0.15, 0.12], [0.15, 0.3, 0.5], [0.2, 0.4, 0.25], [0.8, 0.7, 0.4], [0.3, 0.3, 0.3]][(k + i * 3) % 5];
					const bh = 0.25 + ((k * 7 + i) % 4) * 0.035;
					box(a, f, -W / 2 + 0.05 + k * 0.1, i * 0.45 + 0.03, -D / 2 + 0.05, -W / 2 + 0.13 + k * 0.1, i * 0.45 + 0.03 + bh, D / 2 - 0.05, bc);
				}
			}
			box(a, f, -W / 2, H - 0.03, -D / 2, W / 2, H, D / 2, WOOD);
			break;
		case 'bed':
		{
			const c = BEDDING[v % BEDDING.length];
			boxC(a, f, 0, 0.17, 0, W, 0.24, D, v >= 2 ? DARKWOOD : WOOD);
			boxC(a, f, 0, 0.4, 0.02, W - 0.06, 0.22, D - 0.1, WHITE);
			boxC(a, f, 0, 0.53, 0.25, W - 0.02, 0.06, D - 0.55, c);
			boxC(a, f, -W / 4, 0.57, -D / 2 + 0.3, W / 2 - 0.2, 0.12, 0.35, WHITE);
			boxC(a, f, W / 4, 0.57, -D / 2 + 0.3, W / 2 - 0.2, 0.12, 0.35, WHITE);
			boxC(a, f, 0, 0.55, -D / 2 + 0.03, W + 0.06, 1.1, 0.06, v >= 2 ? DARKWOOD : WOOD);
			break;
		}
		case 'nightstand':
			boxC(a, f, 0, H / 2, 0, W, H, D, WOOD);
			box(a, f, -W / 2 + 0.03, 0.3, D / 2, W / 2 - 0.03, 0.5, D / 2 + 0.005, m(WOOD, 0.8));
			cyl(a, f, 0.08, H, -0.05, 0.25, 0.04, 0.04, 6, [0.8, 0.75, 0.6]);
			cyl(g, f, 0.08, H + 0.25, -0.05, 0.15, 0.11, 0.07, 8, [1, 1, 1], true);
			break;
		case 'wardrobe':
			boxC(a, f, 0, H / 2, 0, W, H, D, v ? WHITE : WOOD);
			box(a, f, -0.004, 0.05, D / 2, 0.004, H - 0.05, D / 2 + 0.005, BLACK);
			boxC(a, f, -0.07, 1.05, D / 2 + 0.02, 0.02, 0.25, 0.03, STEEL); boxC(a, f, 0.07, 1.05, D / 2 + 0.02, 0.02, 0.25, 0.03, STEEL);
			break;
		case 'dresser':
			boxC(a, f, 0, H / 2, 0, W, H, D, WOOD);
			for (let i = 0; i < 3; i++) { box(a, f, -W / 2 + 0.04, 0.06 + i * 0.26, D / 2, W / 2 - 0.04, 0.28 + i * 0.26, D / 2 + 0.01, m(WOOD, 1.1)); boxC(a, f, 0, 0.17 + i * 0.26, D / 2 + 0.02, 0.2, 0.025, 0.02, STEEL); }
			box(s, f, -0.3, H, -D / 2 + 0.02, 0.3, H + 0.7, -D / 2 + 0.05, [0.7, 0.8, 0.85]);
			break;
		case 'toilet':
			boxC(s, f, 0, 0.2, 0.08, 0.36, 0.4, 0.45, WHITE);
			boxC(s, f, 0, 0.41, 0.1, 0.4, 0.04, 0.5, WHITE);
			boxC(s, f, 0, 0.6, -0.25, 0.42, 0.4, 0.18, WHITE);
			break;
		case 'bathSink':
			cyl(s, f, 0, 0, -0.05, 0.75, 0.09, 0.12, 8, WHITE);
			boxC(s, f, 0, 0.8, 0, W, 0.12, D, WHITE);
			cyl(s, f, 0, 0.86, -0.17, 0.15, 0.015, 0.015, 6, STEEL);
			box(s, f, -0.3, 1.1, -D / 2, 0.3, 1.8, -D / 2 + 0.02, [0.75, 0.85, 0.9]);
			break;
		case 'bathtub':
			box(s, f, -W / 2, 0, -D / 2, W / 2, H, -D / 2 + 0.08, WHITE); box(s, f, -W / 2, 0, D / 2 - 0.08, W / 2, H, D / 2, WHITE);
			box(s, f, -W / 2, 0, -D / 2, -W / 2 + 0.08, H, D / 2, WHITE); box(s, f, W / 2 - 0.08, 0, -D / 2, W / 2, H, D / 2, WHITE);
			box(s, f, -W / 2 + 0.08, 0, -D / 2 + 0.08, W / 2 - 0.08, 0.12, D / 2 - 0.08, [0.85, 0.88, 0.9]);
			cyl(s, f, -W / 2 + 0.15, H, 0, 0.12, 0.02, 0.02, 6, STEEL);
			// shower riser + head over the tap end (RealismInteractions: shower)
			box(s, f, -W / 2 + 0.1, H, -D / 2 + 0.02, -W / 2 + 0.14, 1.98, -D / 2 + 0.06, STEEL);
			box(s, f, -W / 2 + 0.07, 1.94, -D / 2 + 0.06, -W / 2 + 0.17, 1.98, -D / 2 + 0.3, STEEL);
			cyl(s, f, -W / 2 + 0.12, 1.9, -D / 2 + 0.3, 0.05, 0.07, 0.05, 8, STEEL);
			break;
		case 'laptop':
			boxC(a, f, 0, 0.01, 0.0, 0.34, 0.02, 0.24, [0.22, 0.23, 0.25]);
			box(a, f, -0.15, 0.02, -0.07, 0.15, 0.022, 0.06, [0.1, 0.1, 0.11]);
			box(a, f, -0.17, 0.02, -0.125, 0.17, 0.25, -0.11, [0.22, 0.23, 0.25]);
			box(s, f, -0.155, 0.035, -0.11, 0.155, 0.235, -0.106, [0.14, 0.3, 0.48]);
			break;
		case 'desk':
			boxC(a, f, 0, H - 0.02, 0, W, 0.04, D, v === 1 ? [0.85, 0.85, 0.83] : WOOD);
			boxC(a, f, -W / 2 + 0.22, (H - 0.04) / 2, 0, 0.4, H - 0.04, D - 0.04, v === 1 ? [0.5, 0.5, 0.52] : m(WOOD, 0.85));
			boxC(a, f, W / 2 - 0.03, (H - 0.04) / 2, 0, 0.04, H - 0.04, D - 0.04, v === 1 ? [0.5, 0.5, 0.52] : m(WOOD, 0.85));
			if (v === 2) break;   // home desk: the laptop is its own item (RealismInteractions)
			boxC(a, f, 0.1, H + 0.22, -0.15, 0.55, 0.35, 0.03, BLACK);
			boxC(a, f, 0.1, H + 0.02, -0.15, 0.15, 0.04, 0.12, BLACK);
			boxC(a, f, 0.1, H + 0.01, 0.12, 0.42, 0.02, 0.14, [0.2, 0.2, 0.2]);
			break;
		case 'officeChair':
			cyl(a, f, 0, 0.05, 0, 0.4, 0.03, 0.03, 6, BLACK);
			boxC(a, f, 0, 0.06, 0, 0.55, 0.04, 0.06, BLACK); boxC(a, f, 0, 0.06, 0, 0.06, 0.04, 0.55, BLACK);
			boxC(a, f, 0, 0.48, 0, 0.5, 0.08, 0.5, [0.15, 0.15, 0.17]);
			boxC(a, f, 0, 0.78, -0.23, 0.46, 0.55, 0.06, [0.15, 0.15, 0.17]);
			break;
		case 'shelf':
			boxC(a, f, 0, H / 2, 0, W, H, 0.06, [0.85, 0.85, 0.85]);
			for (let i = 0; i < 4; i++)
			{
				const y = 0.1 + i * 0.45;
				boxC(a, f, 0, y, 0, W, 0.03, D, [0.8, 0.8, 0.8]);
				for (let k = 0; k < 9; k++)
				{
					const pc = [[0.85, 0.2, 0.15], [0.95, 0.75, 0.15], [0.2, 0.45, 0.8], [0.3, 0.65, 0.25], [0.95, 0.95, 0.9], [0.55, 0.3, 0.15]][(k + i * 2 + v) % 6];
					const ph = 0.18 + ((k + i) % 3) * 0.06;
					box(a, f, -W / 2 + 0.04 + k * 0.195, y + 0.015, 0.05, -W / 2 + 0.2 + k * 0.195, y + 0.015 + ph, D / 2 - 0.02, pc);
					box(a, f, -W / 2 + 0.04 + k * 0.195, y + 0.015, -D / 2 + 0.02, -W / 2 + 0.2 + k * 0.195, y + 0.015 + ph, -0.05, pc);
				}
			}
			break;
		case 'checkout':
			boxC(a, f, 0, 0.45, 0, W, 0.9, D, [0.3, 0.32, 0.36]);
			boxC(s, f, 0, 0.92, 0, W, 0.04, D, [0.2, 0.2, 0.2]);
			boxC(a, f, 0.5, 1.05, -0.1, 0.4, 0.22, 0.35, BLACK);
			boxC(s, f, 0.5, 1.3, -0.12, 0.35, 0.25, 0.04, [0.1, 0.2, 0.3]);
			break;
		case 'cooler':
			boxC(a, f, 0, H / 2, 0, W, H, D, [0.85, 0.85, 0.85]);
			box(g, f, -W / 2 + 0.05, 0.1, D / 2, W / 2 - 0.05, H - 0.15, D / 2 + 0.005, [1, 1, 1]);
			for (let i = 0; i < 4; i++) for (let k = 0; k < 5; k++)
			{
				const pc = [[0.8, 0.1, 0.1], [0.1, 0.5, 0.2], [0.9, 0.8, 0.2], [0.2, 0.3, 0.8]][(i + k) % 4];
				box(a, f, -W / 2 + 0.1 + k * 0.22, 0.15 + i * 0.45, D / 2 - 0.25, -W / 2 + 0.25 + k * 0.22, 0.45 + i * 0.45, D / 2 + 0.008, pc);
			}
			box(a, f, -0.01, 0.1, D / 2, 0.01, H - 0.15, D / 2 + 0.012, STEEL);
			break;
		case 'booth':
		{
			const c = v ? [0.15, 0.4, 0.55] : [0.7, 0.12, 0.12];
			boxC(a, f, 0, 0.22, 0, W, 0.44, D, m(c, 0.8));
			boxC(a, f, 0, 0.47, 0.05, W, 0.08, D - 0.1, c);
			boxC(a, f, 0, 0.8, -D / 2 + 0.1, W, 0.6, 0.2, c);
			break;
		}
		case 'barStool':
			cyl(a, f, 0, 0, 0, 0.02, 0.2, 0.2, 8, STEEL, true);
			cyl(a, f, 0, 0.02, 0, 0.68, 0.03, 0.03, 6, STEEL);
			cyl(a, f, 0, 0.7, 0, 0.07, 0.19, 0.19, 10, [0.7, 0.12, 0.12], true);
			break;
		case 'bunkBed':
			for (let i = 0; i < 4; i++) boxC(a, f, (i % 2 ? 1 : -1) * (W / 2 - 0.03), H / 2, (i < 2 ? 1 : -1) * (D / 2 - 0.03), 0.05, H, 0.05, [0.45, 0.47, 0.5]);
			boxC(a, f, 0, 0.35, 0, W, 0.06, D, [0.45, 0.47, 0.5]); boxC(a, f, 0, 0.44, 0, W - 0.1, 0.12, D - 0.1, [0.8, 0.8, 0.75]);
			boxC(a, f, 0, 1.35, 0, W, 0.06, D, [0.45, 0.47, 0.5]); boxC(a, f, 0, 1.44, 0, W - 0.1, 0.12, D - 0.1, [0.8, 0.8, 0.75]);
			break;
		case 'locker':
			boxC(a, f, 0, H / 2, 0, W, H, D, v ? [0.6, 0.15, 0.12] : [0.35, 0.45, 0.55]);
			for (let i = 1; i < 3; i++) box(a, f, -W / 2 + i * W / 3 - 0.005, 0.02, D / 2, -W / 2 + i * W / 3 + 0.005, H - 0.02, D / 2 + 0.005, BLACK);
			for (let i = 0; i < 3; i++) for (let k = 0; k < 4; k++) box(a, f, -W / 2 + i * W / 3 + 0.08, H - 0.2 - k * 0.04, D / 2, -W / 2 + i * W / 3 + 0.22, H - 0.18 - k * 0.04, D / 2 + 0.008, BLACK);
			break;
		case 'plant':
			cyl(a, f, 0, 0, 0, 0.35, 0.17, 0.22, 8, [0.6, 0.35, 0.22]);
			for (let i = 0; i < 6; i++)
			{
				const ang = i * 1.05;
				cyl(a, f, Math.cos(ang) * 0.08, 0.35, Math.sin(ang) * 0.08, 0.55 + (i % 3) * 0.15, 0.16, 0, 5, [0.18 + (i % 2) * 0.05, 0.45, 0.18]);
			}
			break;
		case 'mattress':
			boxC(a, f, 0, 0.11, 0, W, 0.22, D, [0.72, 0.68, 0.58]);
			boxC(a, f, 0.2, 0.225, 0.3, 0.8, 0.01, 0.6, [0.55, 0.48, 0.38]);
			break;
		case 'trashBag':
			cyl(a, f, 0, 0, 0, 0.35, 0.22, 0.27, 7, BLACK);
			cyl(a, f, 0, 0.35, 0, 0.18, 0.27, 0.03, 7, BLACK);
			break;
		case 'washer':
			boxC(a, f, 0, H / 2, 0, W, H, D, WHITE);
			cyl(s, f, 0, 0.42, D / 2 - 0.01, 0.02, 0.22, 0.22, 12, [0.3, 0.35, 0.4], true);
			box(a, f, -W / 2, H - 0.12, D / 2 - 0.02, W / 2, H, D / 2 + 0.005, [0.75, 0.75, 0.75]);
			break;
		case 'rack':
			for (let i = 0; i < 4; i++) boxC(a, f, (i % 2 ? 1 : -1) * (W / 2 - 0.05), H / 2, (i < 2 ? 1 : -1) * (D / 2 - 0.05), 0.08, H, 0.08, [0.15, 0.3, 0.6]);
			for (let k = 0; k < 3; k++)
			{
				boxC(a, f, 0, 0.1 + k * 1.2, D / 2 - 0.05, W, 0.1, 0.06, [0.9, 0.5, 0.1]); boxC(a, f, 0, 0.1 + k * 1.2, -D / 2 + 0.05, W, 0.1, 0.06, [0.9, 0.5, 0.1]);
				for (let p = 0; p < 2; p++) if ((k + p + v) % 3 !== 2)
				{
					boxC(a, f, (p ? 0.65 : -0.65), 0.2 + k * 1.2, 0, 1.1, 0.12, 0.9, [0.6, 0.45, 0.3]);
					boxC(a, f, (p ? 0.65 : -0.65), 0.6 + k * 1.2, 0, 1.0, 0.7, 0.85, [0.72, 0.58, 0.4]);
				}
			}
			break;
		case 'pallet':
			boxC(a, f, 0, 0.07, 0, W, 0.14, D, [0.6, 0.45, 0.3]);
			boxC(a, f, 0, 0.6, 0, W - 0.1, 0.9, D - 0.1, v ? [0.3, 0.45, 0.6] : [0.72, 0.58, 0.4]);
			break;
		case 'boxes':
			boxC(a, f, -0.15, 0.25, 0, 0.55, 0.5, 0.6, [0.72, 0.58, 0.4]);
			boxC(a, f, 0.25, 0.2, 0.05, 0.4, 0.4, 0.45, [0.68, 0.55, 0.38]);
			boxC(a, f, -0.1, 0.65, 0, 0.45, 0.3, 0.45, [0.75, 0.6, 0.42]);
			break;
		case 'bench':
			boxC(a, f, 0, 0.45, 0.05, W, 0.06, 0.45, v ? DARKWOOD : WOOD);
			boxC(a, f, 0, 0.72, -0.22, W, 0.4, 0.05, v ? DARKWOOD : WOOD);
			boxC(a, f, -W / 2 + 0.05, 0.22, 0, 0.06, 0.45, 0.5, DARKWOOD); boxC(a, f, W / 2 - 0.05, 0.22, 0, 0.06, 0.45, 0.5, DARKWOOD);
			break;
		case 'receptionDesk':
			boxC(a, f, 0, 0.52, -0.1, W, 1.04, 0.2, v ? [0.2, 0.25, 0.35] : DARKWOOD);
			boxC(a, f, 0, 0.74, 0.1, W, 0.04, 0.6, [0.85, 0.85, 0.83]);
			boxC(a, f, -W / 2 + 0.05, 0.37, 0.15, 0.1, 0.74, 0.5, DARKWOOD); boxC(a, f, W / 2 - 0.05, 0.37, 0.15, 0.1, 0.74, 0.5, DARKWOOD);
			boxC(s, f, 0.4, 0.98, 0.15, 0.5, 0.35, 0.03, BLACK);
			break;
		case 'hospitalBed':
			for (let i = 0; i < 4; i++) cyl(a, f, (i % 2 ? 1 : -1) * 0.42, 0, (i < 2 ? 1 : -1) * 0.95, 0.5, 0.025, 0.025, 6, STEEL);
			boxC(a, f, 0, 0.55, 0, W, 0.1, D, STEEL);
			boxC(a, f, 0, 0.68, 0, W - 0.1, 0.16, D - 0.1, [0.85, 0.9, 0.95]);
			boxC(a, f, 0, 0.75, -D / 2 + 0.25, 0.6, 0.12, 0.3, WHITE);
			boxC(a, f, 0, 0.85, -D / 2 + 0.02, W, 0.6, 0.04, [0.6, 0.65, 0.7]);
			cyl(a, f, W / 2 + 0.15, 0, -D / 2 + 0.2, 1.8, 0.015, 0.015, 6, STEEL);
			boxC(s, f, W / 2 + 0.15, 1.65, -D / 2 + 0.2, 0.12, 0.2, 0.04, [0.8, 0.9, 1.0]);
			break;
		case 'seatRow':
			for (let i = 0; i < 4; i++)
			{
				const x = -W / 2 + 0.31 + i * 0.62;
				boxC(a, f, x, 0.45, 0.05, 0.52, 0.06, 0.48, v ? [0.15, 0.35, 0.6] : [0.25, 0.25, 0.28]);
				boxC(a, f, x, 0.72, -0.2, 0.52, 0.5, 0.05, v ? [0.15, 0.35, 0.6] : [0.25, 0.25, 0.28]);
			}
			boxC(a, f, 0, 0.38, 0, W, 0.05, 0.08, STEEL);
			boxC(a, f, -W / 2 + 0.1, 0.19, 0, 0.06, 0.38, 0.5, STEEL); boxC(a, f, W / 2 - 0.1, 0.19, 0, 0.06, 0.38, 0.5, STEEL);
			break;
		case 'clothesRack':
			boxC(a, f, -W / 2, 0.75, 0, 0.04, 1.5, 0.04, STEEL); boxC(a, f, W / 2, 0.75, 0, 0.04, 1.5, 0.04, STEEL);
			boxC(a, f, 0, 1.48, 0, W, 0.03, 0.03, STEEL);
			boxC(a, f, 0, 0.02, 0, W + 0.2, 0.04, D, STEEL);
			for (let k = 0; k < 10; k++)
			{
				const c = [[0.1, 0.1, 0.12], [0.85, 0.85, 0.85], [0.6, 0.1, 0.1], [0.2, 0.3, 0.6], [0.5, 0.5, 0.45]][(k + v) % 5];
				boxC(a, f, -W / 2 + 0.15 + k * 0.12, 1.1, 0, 0.05, 0.7, 0.45, c);
			}
			break;
		case 'barberChair':
			cyl(a, f, 0, 0, 0, 0.05, 0.3, 0.3, 10, STEEL, true);
			cyl(a, f, 0, 0.05, 0, 0.35, 0.06, 0.06, 6, STEEL);
			boxC(a, f, 0, 0.5, 0.05, 0.6, 0.15, 0.55, [0.12, 0.12, 0.12]);
			boxC(a, f, 0, 0.9, -0.24, 0.55, 0.7, 0.1, [0.12, 0.12, 0.12]);
			boxC(a, f, 0, 0.35, 0.42, 0.4, 0.05, 0.25, STEEL);
			break;
		case 'carLift':
			boxC(a, f, -W / 2 + 0.15, 1.1, 0, 0.3, 2.2, 0.3, [0.85, 0.15, 0.1]); boxC(a, f, W / 2 - 0.15, 1.1, 0, 0.3, 2.2, 0.3, [0.85, 0.15, 0.1]);
			boxC(a, f, 0, 2.15, 0, W, 0.12, 0.25, [0.85, 0.15, 0.1]);
			boxC(a, f, -0.9, 0.08, 0, 0.5, 0.06, 1.6, [0.3, 0.3, 0.3]); boxC(a, f, 0.9, 0.08, 0, 0.5, 0.06, 1.6, [0.3, 0.3, 0.3]);
			break;
		case 'toolChest':
			boxC(a, f, 0, H / 2, 0, W, H, D, [0.75, 0.1, 0.08]);
			for (let i = 0; i < 6; i++) boxC(s, f, 0, 0.15 + i * 0.15, D / 2 + 0.01, W - 0.2, 0.02, 0.02, STEEL);
			break;
		case 'hayBale':
			boxC(a, f, 0, H / 2, 0, W, H, D, [0.82, 0.7, 0.38]);
			box(a, f, -0.3, 0, -D / 2 - 0.005, -0.27, H + 0.005, D / 2 + 0.005, [0.6, 0.5, 0.25], 'b');
			box(a, f, 0.27, 0, -D / 2 - 0.005, 0.3, H + 0.005, D / 2 + 0.005, [0.6, 0.5, 0.25], 'b');
			break;
		case 'vaultDoor':
			boxC(s, f, 0, H / 2, 0, W, H, D, [0.55, 0.56, 0.58]);
			cyl(s, f, 0, 0.3, D / 2, 0.0, 0, 0, 3, STEEL);
			for (let i = 0; i < 12; i++)
			{
				const an = i * Math.PI / 6;
				box(s, f, Math.cos(an) * 0.75 - 0.05, 1.15 + Math.sin(an) * 0.75 - 0.05, D / 2, Math.cos(an) * 0.75 + 0.05, 1.15 + Math.sin(an) * 0.75 + 0.05, D / 2 + 0.06, STEEL);
			}
			boxC(s, f, 0, 1.15, D / 2 + 0.1, 0.9, 0.06, 0.06, STEEL); boxC(s, f, 0, 1.15, D / 2 + 0.1, 0.06, 0.9, 0.06, STEEL);
			break;
		case 'ceilingLight':
			cyl(a, f, 0, -0.02, 0, 0.02, 0.26, 0.26, 12, WHITE, true);
			cyl(g, f, 0, -0.07, 0, 0.05, 0.22, 0.24, 12, [1, 1, 1], true);
			break;
		case 'judgeBench':
			boxC(a, f, 0, 0.6, 0, W, 1.2, D, DARKWOOD);
			boxC(a, f, 0, 1.25, 0.05, W + 0.1, 0.06, D + 0.1, m(DARKWOOD, 1.2));
			boxC(a, f, 0, 0.12, -D / 2 - 0.4, W, 0.24, 0.8, DARKWOOD);
			break;
		case 'piano':
			boxC(a, f, 0, 0.65, -0.05, W, 1.3, 0.45, BLACK);
			boxC(a, f, 0, 0.72, 0.2, W - 0.1, 0.06, 0.2, WHITE);
			boxC(a, f, 0, 0.3, 0.6, 0.8, 0.45, 0.35, BLACK);
			break;
		case 'woodStove':
			boxC(a, f, 0, 0.35, 0, W, 0.5, D, [0.12, 0.12, 0.12]);
			for (let i = 0; i < 4; i++) boxC(a, f, (i % 2 ? 1 : -1) * 0.25, 0.05, (i < 2 ? 1 : -1) * 0.25, 0.05, 0.1, 0.05, [0.12, 0.12, 0.12]);
			cyl(a, f, 0, 0.6, -0.1, 1.9, 0.08, 0.08, 8, [0.15, 0.15, 0.15]);
			box(g, f, -0.15, 0.2, D / 2, 0.15, 0.4, D / 2 + 0.005, [1, 0.6, 0.3]);
			break;
		case 'telescope':
			for (let i = 0; i < 3; i++) { const an = i * 2.1; cyl(a, f, Math.cos(an) * 0.2, 0, Math.sin(an) * 0.2, 1.1, 0.025, 0.02, 5, [0.2, 0.2, 0.22]); }
			boxC(a, f, 0, 1.15, 0, 0.12, 0.12, 0.12, [0.2, 0.2, 0.22]);
			boxC(a, f, 0, 1.25, 0.1, 0.14, 0.14, 0.7, [0.85, 0.85, 0.85]);
			break;
		case 'cell':
			break;
	}
	return partsFrom(ctx, [[a, 'plain'], [s, 'shiny'], [g, 'lampGlow', false]]);
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface Placed { x0: number; z0: number; x1: number; z1: number; cx?: number; cz?: number; rot?: number; wall?: string; }

class RoomFiller
{
	private ctx: RealismCtx;
	private inst: AssetInstancer;
	private plan: InteriorPlan;
	private room: Room;
	private placed: Placed[] = [];
	private rnd: (k: number) => number;
	public count = 0;
	/** Room key for the lights of this room (RealismRoomLights), -1 = none. */
	public roomKey = -1;

	constructor(ctx: RealismCtx, inst: AssetInstancer, plan: InteriorPlan, room: Room, ri: number)
	{
		this.ctx = ctx; this.inst = inst; this.plan = plan; this.room = room;
		const seed = plan.seed + ri * 977;
		this.rnd = (k) => hash01(seed + k * 31);
		// keep doorways clear
		for (let i = 0; i < room.doors.length; i++)
		{
			const d = room.doors[i];
			this.placed.push({ x0: d[0] - 0.85, z0: d[1] - 0.95, x1: d[0] + 0.85, z1: d[1] + 0.95 });
		}
	}

	private free(r: Placed): boolean
	{
		const R = this.room;
		if (r.x0 < R.x0 - 0.001 || r.x1 > R.x1 + 0.001 || r.z0 < R.z0 - 0.001 || r.z1 > R.z1 + 0.001) return false;
		for (let i = 0; i < this.placed.length; i++)
		{
			const p = this.placed[i];
			if (r.x0 < p.x1 && r.x1 > p.x0 && r.z0 < p.z1 && r.z1 > p.z0) return false;
		}
		return true;
	}

	private blocksWindow(r: Placed, h: number): boolean
	{
		if (h < 1.0 || !this.room.windows) return false;
		for (let i = 0; i < this.room.windows.length; i++)
		{
			const w = this.room.windows[i];
			if (w[0] > r.x0 - 0.8 && w[0] < r.x1 + 0.8 && w[1] > r.z0 - 0.8 && w[1] < r.z1 + 0.8) return true;
		}
		return false;
	}

	/** Puts the instance in the world. lx/lz is the item centre in building space, rot its yaw in building space. */
	public put(name: string, lx: number, lz: number, rot: number, variant?: number, y?: number): void
	{
		const it = FURNITURE[name];
		const wp = this.plan.f.p(lx, y === undefined ? this.room.y : y, lz);
		const ry = this.plan.b.rot + rot;
		this.inst.add(name, { x: wp[0], y: wp[1], z: wp[2], ry: ry, room: this.roomKey }, 'interior', variant || 0, it.h > 0.5);
		this.count++;
		if (it.solid && this.ctx.cfg.house.interiors)
		{
			const sw = Math.abs(Math.cos(rot)) > 0.5;
			const hx = (sw ? it.w : it.d) / 2, hz = (sw ? it.d : it.w) / 2;
			this.ctx.bphys.box(wp[0], wp[1] + it.h / 2, wp[2], hx * 0.95, it.h / 2, hz * 0.95, this.plan.b.rot);
		}
	}

	/**
	 * Against a wall. walls: 'n' (z0, faces +z), 's' (z1, faces -z), 'w' (x0, faces +x), 'e' (x1, faces -x).
	 * at: preferred position along the wall 0..1 (-1 = anywhere).
	 */
	public wall(name: string, walls: string, at: number, variant?: number, gap?: number): Placed
	{
		const it = FURNITURE[name];
		const R = this.room;
		const g = gap === undefined ? 0.02 : gap;
		const tries = at >= 0 ? [at, at + 0.15, at - 0.15, at + 0.3, at - 0.3, 0.5, 0.15, 0.85] : [0.5, 0.2, 0.8, 0.35, 0.65, 0.05, 0.95];
		for (let wi = 0; wi < walls.length; wi++)
		{
			const wch = walls.charAt(wi);
			for (let t = 0; t < tries.length; t++)
			{
				const fr = Math.max(0, Math.min(1, tries[t]));
				let r: Placed, rot: number, cx: number, cz: number;
				if (wch === 'n' || wch === 's')
				{
					const span = R.x1 - R.x0 - it.w;
					if (span < 0) break;
					cx = R.x0 + it.w / 2 + span * fr;
					cz = wch === 'n' ? R.z0 + g + it.d / 2 : R.z1 - g - it.d / 2;
					rot = wch === 'n' ? 0 : Math.PI;
					r = { x0: cx - it.w / 2, x1: cx + it.w / 2, z0: cz - it.d / 2, z1: cz + it.d / 2 };
				}
				else
				{
					const span = R.z1 - R.z0 - it.w;
					if (span < 0) break;
					cz = R.z0 + it.w / 2 + span * fr;
					cx = wch === 'w' ? R.x0 + g + it.d / 2 : R.x1 - g - it.d / 2;
					rot = wch === 'w' ? Math.PI / 2 : -Math.PI / 2;
					r = { x0: cx - it.d / 2, x1: cx + it.d / 2, z0: cz - it.w / 2, z1: cz + it.w / 2 };
				}
				if (!this.free(r) || this.blocksWindow(r, it.h)) continue;
				this.placed.push(r);
				this.put(name, cx, cz, rot, variant);
				r.wall = wch; r.cx = cx; r.cz = cz; r.rot = rot;
				return r;
			}
		}
		return null;
	}

	/** Free-standing at a point (building space), with rotation. */
	public at(name: string, cx: number, cz: number, rot: number, variant?: number, ignoreOverlap?: boolean, y?: number): boolean
	{
		const it = FURNITURE[name];
		const sw = Math.abs(Math.cos(rot)) > 0.5;
		const hw = (sw ? it.w : it.d) / 2, hd = (sw ? it.d : it.w) / 2;
		const r = { x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd };
		if (!ignoreOverlap && !this.free(r)) return false;
		if (!ignoreOverlap) this.placed.push(r);
		this.put(name, cx, cz, rot, variant, y);
		return true;
	}

	/** A run of counters along a wall, with a sink and stove in it and a fridge at the end. */
	public kitchenRun(walls: string, hood: boolean): void
	{
		const R = this.room;
		for (let wi = 0; wi < walls.length; wi++)
		{
			const w = walls.charAt(wi);
			const alongX = w === 'n' || w === 's';
			const len = alongX ? R.x1 - R.x0 : R.z1 - R.z0;
			const n = Math.min(7, Math.floor((len - 0.8) / 0.62));
			if (n < 3) continue;
			const fridge = this.wall('fridge', w, 0, hood ? 1 : 0, 0.03);
			if (!fridge) continue;
			let placed = 0;
			const startFr = 0;
			for (let k = 0; k < n; k++)
			{
				const name = k === 1 ? 'sink' : (k === n - 2 ? 'stove' : 'counter');
				const at = (k + 1.4) / (n + 0.5);
				if (this.wall(name, w, Math.min(1, startFr + at), hood ? 1 : 0, 0.0)) placed++;
			}
			if (placed > 0) return;
		}
	}

	/** Wall light switch beside the first doorway, for RealismInteractions (no mesh, no physics). */
	public lightSwitch(): void
	{
		const sink = (this.ctx as any).interactionSink;
		const R = this.room;
		if (!sink || !R.doors || R.doors.length === 0) return;
		const d = R.doors[0];
		const e = [Math.abs(d[1] - R.z0), Math.abs(d[1] - R.z1), Math.abs(d[0] - R.x0), Math.abs(d[0] - R.x1)];
		let k = 0;
		for (let i = 1; i < 4; i++) if (e[i] < e[k]) k = i;
		const nx = k === 2 ? 1 : k === 3 ? -1 : 0, nz = k === 0 ? 1 : k === 1 ? -1 : 0;   // into the room
		const tx = nz !== 0 ? 1 : 0, tz = nx !== 0 ? 1 : 0;
		let side = 0.8;
		const fits = (sd: number) => { const x = d[0] + tx * sd, z = d[1] + tz * sd; return x > R.x0 + 0.1 && x < R.x1 - 0.1 && z > R.z0 + 0.1 && z < R.z1 - 0.1; };
		if (!fits(side)) side = -0.8;
		if (!fits(side)) side = 0;
		const lx = (k === 2 ? R.x0 : k === 3 ? R.x1 : d[0] + tx * side) + nx * 0.06;
		const lz = (k === 0 ? R.z0 : k === 1 ? R.z1 : d[1] + tz * side) + nz * 0.06;
		const wp = this.plan.f.p(lx, R.y + 1.2, lz);
		sink('lightSwitch', { x: wp[0], y: R.y, z: wp[2], ry: this.plan.b.rot + Math.atan2(nx, nz), room: this.roomKey }, 0);
	}

	/** Desk + office chair + laptop by a window (home office corner), placed after everything else in the room. */
	public deskSet(): boolean
	{
		const R = this.room;
		let order = 'nsew';
		if (R.windows && R.windows.length)
		{
			const w = R.windows[0];
			const e = [Math.abs(w[1] - R.z0), Math.abs(w[1] - R.z1), Math.abs(w[0] - R.x0), Math.abs(w[0] - R.x1)];
			let k = 0;
			for (let i = 1; i < 4; i++) if (e[i] < e[k]) k = i;
			order = ['nswe', 'snew', 'wens', 'ewns'][k];
		}
		const desk = this.wall('desk', order, -1, 2, 0.03);
		if (!desk) return false;
		const dx = Math.sin(desk.rot), dz = Math.cos(desk.rot);
		const it = FURNITURE.desk;
		this.at('officeChair', desk.cx + dx * (it.d / 2 + 0.38), desk.cz + dz * (it.d / 2 + 0.38), desk.rot + Math.PI, 0, true);
		this.put('laptop', desk.cx + dx * 0.04 - dz * 0.1, desk.cz + dz * 0.04 + dx * 0.1, desk.rot, 0, R.y + it.h);
		return true;
	}

	public center(): number[] { return [(this.room.x0 + this.room.x1) / 2, (this.room.z0 + this.room.z1) / 2]; }
	public size(): number[] { return [this.room.x1 - this.room.x0, this.room.z1 - this.room.z0]; }
	public r(k: number): number { return this.rnd(k); }
}

/** Opposite wall letter. */
function opp(w: string): string { return w === 'n' ? 's' : w === 's' ? 'n' : w === 'w' ? 'e' : 'w'; }

export function buildInteriors(ctx: RealismCtx, plans: InteriorPlan[], inst: AssetInstancer): number
{
	for (const name in FURNITURE) if (FURNITURE.hasOwnProperty(name)) inst.define(name, (v) => makeFurniture(ctx, name, v));
	let total = 0;
	if (!ctx.cfg.house.interiors) return 0;
	for (let p = 0; p < plans.length; p++)
	{
		const plan = plans[p];
		const b = plan.b;
		for (let ri = 0; ri < plan.rooms.length; ri++)
		{
			const room = plan.rooms[ri];
			const F = new RoomFiller(ctx, inst, plan, room, ri);
			F.roomKey = p * 64 + ri;
			const hood = plan.hood;
			const abandoned = !!b.boarded;
			F.lightSwitch();
			// ceiling light (always)
			const c = F.center();
			F.at('ceilingLight', c[0], c[1], 0, 0, true, room.y + room.h - 0.01);
			if (abandoned) { fillAbandoned(F, room); total += F.count; continue; }
			if (b.kind === 'house' || b.style === 'house') fillHouseRoom(F, room, hood, b.sub || 'living');
			else fillCityRoom(F, room, hood, b.sub || b.kind || 'lobby', b.kind || '');
			total += F.count;
		}
	}
	return total;
}

function fillAbandoned(F: RoomFiller, room: Room): void
{
	const s = F.size(), c = F.center();
	if (F.r(1) < 0.6) F.at('mattress', c[0] + (F.r(2) - 0.5) * s[0] * 0.3, c[1] + (F.r(3) - 0.5) * s[1] * 0.3, F.r(4) * 3);
	for (let k = 0; k < 4; k++) F.at('trashBag', room.x0 + 0.4 + F.r(10 + k) * (s[0] - 0.8), room.z0 + 0.4 + F.r(20 + k) * (s[1] - 0.8), F.r(30 + k) * 6);
	if (F.r(5) < 0.5) F.wall('boxes', 'nswe', -1);
	if (F.r(6) < 0.4) F.wall('armchair', 'nswe', -1, 10);
}

function fillHouseRoom(F: RoomFiller, room: Room, hood: boolean, sub: string): void
{
	const s = F.size(), c = F.center();
	const worn = hood ? 10 + Math.floor(F.r(1) * 2) : Math.floor(F.r(1) * 4);
	if (sub === 'cabin')
	{
		F.wall('woodStove', 'n', 0.8);
		F.wall('bed', 'w', 0.3, 2);
		F.wall('bookshelf', 'n', 0.2);
		F.at('diningTable', c[0] + 0.6, c[1] + 0.4, 0, 1);
		F.at('chair', c[0] + 0.6, c[1] + 1.05, Math.PI);
		F.at('chair', c[0] + 0.6, c[1] - 0.25, 0);
		F.wall('telescope', 'se', 0.8);
		F.at('rug', c[0], c[1], 0, 3, true);
		return;
	}
	switch (room.type)
	{
		case 'living':
		{
			// TV on one wall, couch facing it
			const long = s[0] >= s[1];
			const tvWalls = long ? 'nsew' : 'ewns';
			let tv: Placed = null;
			for (let i = 0; i < tvWalls.length && !tv; i++)
			{
				const w = tvWalls.charAt(i);
				tv = F.wall('tvStand', w, 0.5, hood ? 1 : 0);
				if (tv)
				{
					F.put('tv', tv.cx, tv.cz, tv.rot, hood ? 0 : 1, room.y + 0.5);
					const ow = opp(w);
					const couch: Placed = F.wall('couch', ow, 0.5, worn, 0.15);
					// coffee table + rug between them
					const mx = couch ? (tv.cx + couch.cx) / 2 : c[0], mz = couch ? (tv.cz + couch.cz) / 2 : c[1];
					F.at('rug', mx, mz, tv.rot, Math.floor(F.r(3) * 4), true, room.y + 0.002);
					F.at('coffeeTable', mx, mz, tv.rot, hood ? 1 : 0);
					const sideW = w === 'n' || w === 's' ? 'ew' : 'ns';
					F.wall('armchair', sideW, 0.5, worn, 0.2);
				}
			}
			if (!tv) F.wall('couch', 'nswe', -1, worn, 0.1);
			if (!hood || F.r(4) < 0.5) F.wall('bookshelf', 'nsew', 0.1);
			F.wall('floorLamp', 'nsew', 0.95);
			if (!hood) F.wall('plant', 'snwe', 0.02);
			if (hood) F.at('trashBag', room.x0 + 0.4, room.z0 + 0.4, 0.3);
			if (!hood && s[0] > 6 && F.r(5) < 0.25) F.wall('piano', 'nswe', 0.15);
			break;
		}
		case 'kitchen':
		case 'kitchen_dining':
		{
			F.kitchenRun(s[0] >= s[1] ? 'nswe' : 'wens', hood);
			if (s[0] > 2.8 && s[1] > 2.6)
			{
				const ok = F.at('diningTable', c[0], c[1] + (room.type === 'kitchen_dining' ? 0.3 : 0.2), 0, hood ? 1 : 0);
				if (ok)
				{
					F.at('chair', c[0] - 0.45, c[1] + 0.95, Math.PI, 0, true);
					F.at('chair', c[0] + 0.45, c[1] + 0.95, Math.PI, 0, true);
					F.at('chair', c[0] - 0.45, c[1] - 0.35, 0, 0, true);
					if (!hood) F.at('chair', c[0] + 0.45, c[1] - 0.35, 0, 0, true);
				}
				else if (F.at('diningTable', c[0], c[1], Math.PI / 2, hood ? 1 : 0))
				{
					F.at('chair', c[0] - 0.75, c[1], Math.PI / 2, 0, true);
					F.at('chair', c[0] + 0.75, c[1], -Math.PI / 2, 0, true);
				}
			}
			if (hood) { F.at('trashBag', room.x1 - 0.4, room.z1 - 0.4, 0); F.at('trashBag', room.x1 - 0.9, room.z1 - 0.35, 1); }
			break;
		}
		case 'bedroom':
		case 'bedroom_bath':
		{
			const bedWall = s[0] >= s[1] ? 'nswe' : 'wens';
			let bed: any = null;
			if (hood && F.r(7) < 0.35) bed = F.wall('mattress', bedWall, 0.5, 0, 0.1);
			else bed = F.wall('bed', bedWall, 0.5, Math.floor(F.r(2) * 4), 0.02);
			if (bed && bed.wall)
			{
				const along = bed.wall === 'n' || bed.wall === 's';
				const off = FURNITURE.bed.w / 2 + 0.3;
				const dz = bed.wall === 'n' ? -FURNITURE.bed.d / 2 + 0.22 : bed.wall === 's' ? FURNITURE.bed.d / 2 - 0.22 : 0;
				const dx = bed.wall === 'w' ? -FURNITURE.bed.d / 2 + 0.22 : bed.wall === 'e' ? FURNITURE.bed.d / 2 - 0.22 : 0;
				if (along) { F.at('nightstand', bed.cx - off, bed.cz + dz, bed.rot); F.at('nightstand', bed.cx + off, bed.cz + dz, bed.rot); }
				else { F.at('nightstand', bed.cx + dx, bed.cz - off, bed.rot); F.at('nightstand', bed.cx + dx, bed.cz + off, bed.rot); }
				F.at('rug', bed.cx + (bed.wall === 'w' ? 1.1 : bed.wall === 'e' ? -1.1 : 0), bed.cz + (bed.wall === 'n' ? 1.1 : bed.wall === 's' ? -1.1 : 0), bed.rot, 1, true, room.y + 0.003);
			}
			F.wall('wardrobe', 'ewns', 0.85);
			F.wall('dresser', 'snew', 0.5);
			if (!hood && F.r(9) < 0.5) { const st = F.wall('tvStand', 'snew', 0.5); if (st) F.put('tv', (st as any).cx, (st as any).cz, (st as any).rot, 1, room.y + 0.5); }
			if (room.type === 'bedroom_bath') { F.wall('toilet', 'ewn', 0.95); F.wall('bathSink', 'ewn', 0.75); }
			if (hood) F.at('trashBag', room.x0 + 0.35, room.z1 - 0.35, 2);
			// home office corner: desk + chair + laptop by the window (added last: the rest of the room is unchanged)
			if (F.r(41) < (hood ? 0.3 : 0.6)) F.deskSet();
			break;
		}
		case 'bath':
			F.wall('bathtub', s[0] >= s[1] ? 'ns' : 'we', 0.5);
			F.wall('toilet', 'ewns', 0.2);
			F.wall('bathSink', 'ewns', 0.7);
			break;
		case 'hall':
			F.wall('plant', 'snew', 0.9);
			F.wall('dresser', 'ens', 0.5);
			break;
	}
}

function fillCityRoom(F: RoomFiller, room: Room, hood: boolean, sub: string, kind: string): void
{
	const s = F.size(), c = F.center();
	if (room.type === 'back')
	{
		F.wall('shelf', 'n', 0.25, 1);
		F.wall('desk', 'n', 0.8, 1);
		F.at('officeChair', room.x1 - 1.0, room.z0 + 1.2, Math.PI);
		F.wall('boxes', 'we', 0.5);
		F.wall('boxes', 'ew', 0.2);
		F.wall('locker', 'ew', 0.8);
		return;
	}
	const rows = (name: string, gapZ: number, rot: number, v: number, xMargin: number) =>
	{
		const it = FURNITURE[name];
		for (let z = room.z0 + 1.6; z < room.z1 - 2.2; z += gapZ)
			for (let x = room.x0 + xMargin + it.w / 2; x < room.x1 - xMargin - it.w / 2 + 0.01; x += it.w + 0.3)
				F.at(name, x, z, rot, v);
	};
	switch (sub)
	{
		case 'market':
		case 'convenience':
		case 'gas':
			F.wall('cooler', 'n', 0.2); F.wall('cooler', 'n', 0.45); F.wall('cooler', 'n', 0.7); F.wall('cooler', 'w', 0.5);
			F.at('checkout', room.x1 - 1.3, room.z1 - 1.4, Math.PI, 0);
			for (let x = room.x0 + 2.2; x < room.x1 - 3.0; x += 2.4)
				for (let z = room.z0 + 2.2; z < room.z1 - 2.6; z += 2.2) F.at('shelf', x, z, Math.PI / 2, Math.floor(x + z) & 3);
			if (hood) F.at('trashBag', room.x0 + 0.5, room.z1 - 0.5, 0);
			break;
		case 'diner':
		case 'restaurant':
		case 'cafe':
		{
			// counter with stools along the back, booths along the side walls, tables between
			const back = F.wall('receptionDesk', 'n', 0.5, 1, 0.9);
			if (back) for (let k = -2; k <= 2; k++) F.at('barStool', (back as any).cx + k * 0.55, (back as any).cz + 1.0, 0, 0, true);
			for (let z = room.z0 + 3.2; z < room.z1 - 1.6; z += 1.55)
			{
				F.at('booth', room.x0 + 0.4, z, Math.PI / 2, sub === 'diner' ? 0 : 1);
				F.at('booth', room.x1 - 0.4, z, -Math.PI / 2, sub === 'diner' ? 0 : 1);
			}
			for (let z = room.z0 + 3.4; z < room.z1 - 2.0; z += 2.2)
				for (let x = c[0] - s[0] * 0.2; x <= c[0] + s[0] * 0.2 + 0.01; x += Math.max(1.8, s[0] * 0.2))
				{
					if (F.at('coffeeTable', x, z, 0, 1)) { F.at('chair', x, z + 0.55, Math.PI, 0, true); F.at('chair', x, z - 0.55, 0, 0, true); }
				}
			F.wall('fridge', 'we', 0.05, 1);
			F.wall('stove', 'we', 0.15, 1);
			F.wall('plant', 's', 0.05);
			break;
		}
		case 'barber':
			for (let x = room.x0 + 1.0; x < room.x1 - 0.8; x += 1.6) F.at('barberChair', x, room.z0 + 1.4, 0);
			F.wall('dresser', 'n', 0.5);
			rows('seatRow', 99, Math.PI, 0, 0.6);
			F.at('seatRow', c[0], room.z1 - 1.0, Math.PI, 0);
			break;
		case 'laundromat':
			for (let x = room.x0 + 0.5; x < room.x1 - 0.5; x += 0.72) { F.at('washer', x, room.z0 + 0.4, 0); }
			for (let x = room.x0 + 1.0; x < room.x1 - 1.0; x += 0.72) { F.at('washer', x, c[1] - 0.35, Math.PI); F.at('washer', x, c[1] + 0.35, 0); }
			F.at('seatRow', c[0], room.z1 - 1.1, Math.PI, 1);
			break;
		case 'clothing':
			for (let z = room.z0 + 1.8; z < room.z1 - 2.2; z += 1.8) for (let x = room.x0 + 1.4; x < room.x1 - 1.4; x += 2.2) F.at('clothesRack', x, z, 0, Math.floor(x * 3 + z) & 3);
			F.at('checkout', room.x1 - 1.3, room.z1 - 1.6, Math.PI, 0);
			F.wall('shelf', 'w', 0.4, 2);
			break;
		case 'mechanic':
			F.at('carLift', c[0] - s[0] * 0.15, c[1] - 0.5, 0);
			F.wall('toolChest', 'n', 0.85); F.wall('toolChest', 'e', 0.3); F.wall('rack', 'w', 0.4, 2);
			F.wall('desk', 'e', 0.8, 1);
			break;
		case 'dealer':
			F.wall('receptionDesk', 'n', 0.5, 1, 0.6);
			F.at('desk', room.x0 + 2.0, room.z0 + 2.2, 0, 1); F.at('officeChair', room.x0 + 2.0, room.z0 + 1.5, 0);
			F.at('desk', room.x1 - 2.0, room.z0 + 2.2, 0, 1); F.at('officeChair', room.x1 - 2.0, room.z0 + 1.5, 0);
			F.wall('plant', 's', 0.02); F.wall('plant', 's', 0.98); F.wall('couch', 'w', 0.7, 0);
			break;
		case 'motel':
			F.wall('receptionDesk', 'n', 0.5, 0, 0.8);
			F.wall('couch', 'w', 0.6, worn(hood)); F.wall('plant', 'e', 0.9); F.wall('cooler', 'e', 0.3);
			break;
		case 'bank':
			for (let x = room.x0 + 1.6; x < room.x1 - 1.4; x += 2.6) F.at('receptionDesk', x, room.z0 + 2.2, Math.PI, 1);
			F.wall('vaultDoor', 'n', 0.85);
			F.at('desk', room.x0 + 2.0, room.z1 - 3.0, 0, 1); F.at('desk', room.x1 - 2.0, room.z1 - 3.0, 0, 1);
			F.wall('plant', 's', 0.02); F.wall('plant', 's', 0.98);
			break;
		case 'cityhall':
		case 'court':
			if (sub === 'court') F.wall('judgeBench', 'n', 0.5, 0, 0.6);
			else F.wall('receptionDesk', 'n', 0.5, 0, 0.8);
			for (let z = room.z0 + 4.0; z < room.z1 - 2.0; z += 1.3) { F.at('bench', c[0] - 1.6, z, Math.PI, 1); F.at('bench', c[0] + 1.6, z, Math.PI, 1); }
			F.wall('plant', 's', 0.02); F.wall('plant', 's', 0.98);
			break;
		case 'hospital':
			F.wall('receptionDesk', 'n', 0.25, 0, 0.6);
			for (let x = room.x0 + 1.2; x < room.x1 - 1.0; x += 2.0) F.at('hospitalBed', x, room.z0 + 1.3, 0, 0);
			F.at('seatRow', c[0], room.z1 - 1.2, Math.PI, 1); F.at('seatRow', c[0], room.z1 - 2.4, Math.PI, 1);
			break;
		case 'fire':
			for (let x = room.x0 + 0.6; x < room.x1 - 0.6; x += 1.0) F.at('locker', x, room.z0 + 0.3, 0, 1);
			F.wall('toolChest', 'e', 0.5); F.wall('rack', 'w', 0.5, 1);
			break;
		case 'terminal':
			for (let x = room.x0 + 3; x < room.x1 - 3; x += 3.4) F.at('receptionDesk', x, room.z0 + 2.0, Math.PI, 1);
			for (let z = room.z0 + 5; z < room.z1 - 2; z += 1.5) for (let x = room.x0 + 3; x < room.x1 - 3; x += 3.2) F.at('seatRow', x, z, Math.PI, 1);
			break;
		case 'police':
			F.wall('receptionDesk', 'n', 0.5, 1, 1.0);
			for (let x = room.x0 + 1.6; x < room.x1 - 1.6; x += 2.6) { F.at('desk', x, c[1] - 1, 0, 1); F.at('officeChair', x, c[1] - 1.6, 0); }
			F.wall('locker', 'we', 0.2); F.wall('seatRow', 's', 0.3);
			break;
		case 'cellblock':
			break;   // cells, tables and guard post come from RealismLandmarks
		case 'hangar':
		case 'barn':
		default:
			if (kind === 'warehouse' || sub === 'hangar')
			{
				for (let z = room.z0 + 1.5; z < room.z1 - 6; z += 3.4) for (let x = room.x0 + 1.8; x < room.x1 - 1.8; x += 3.0)
				{
					if (Math.abs(x - c[0]) < 2.8) continue;
					F.at('rack', x, z, 0, Math.floor(x + z) & 3);
				}
				F.wall('pallet', 'ew', 0.8); F.wall('pallet', 'we', 0.6, 1); F.wall('toolChest', 'n', 0.5);
			}
			else if (kind === 'barn' || sub === 'barn')
			{
				for (let k = 0; k < 8; k++) F.at('hayBale', room.x0 + 1 + F.r(k) * (s[0] - 2), room.z0 + 1 + F.r(k + 10) * (s[1] - 2), Math.floor(F.r(k + 20) * 4) * Math.PI / 2);
			}
			else if (kind === 'apartment' || sub === 'apartment')
			{
				F.wall('couch', 'we', 0.5, worn(hood)); F.wall('plant', 'n', 0.1); F.wall('locker', 'n', 0.6, 1); F.at('rug', c[0], c[1], 0, 1, true, room.y + 0.002);
				if (hood) { F.at('trashBag', room.x0 + 0.5, room.z0 + 0.5, 0); F.at('mattress', c[0] + 1.2, c[1] - 0.5, 0.4); }
			}
			else
			{
				// office / lobby
				F.wall('receptionDesk', 'n', 0.5, 1, 1.2);
				F.wall('couch', 'w', 0.65, 0); F.wall('couch', 'e', 0.65, 2);
				F.at('coffeeTable', c[0], c[1] + 0.6, 0, 1);
				F.wall('plant', 's', 0.02); F.wall('plant', 's', 0.98); F.wall('plant', 'n', 0.02);
				if (s[0] > 10) for (let x = room.x0 + 1.6; x < room.x1 - 1.6; x += 2.4) { F.at('desk', x, room.z0 + 3.4, 0, 1); }
			}
	}
}

function worn(hood: boolean): number { return hood ? 10 : 0; }
