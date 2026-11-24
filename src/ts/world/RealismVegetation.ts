/*
 * RealismVegetation.ts
 * --------------------
 * Hedges and bushes all over San Verano County, placed automatically at build time from
 * the generated map (houses, apartments, shops, offices, Central Park, roadsides). Nothing
 * here changes the map data.
 *
 *  - hedge: clipped box hedge. Placed
 *      * along the FRONT of buildings: across house front yards just inside the sidewalk,
 *        low foundation hedges in front of apartments / offices / civic buildings / towers,
 *        short planters at the corners of shop fronts (shop windows stay visible);
 *      * along the SIDES: house lot lines (with a short return at the front corner) and
 *        beside apartments / offices / shops that have room next to them;
 *      * a border round Central Park with gaps at the footpaths.
 *    Gaps are left automatically at every front door, porch, front path, driveway, back
 *    door, entrance steps / ramp / canopy and fire-escape ladder. Never on a road or the
 *    sidewalk, never inside a footprint. Static colliders: one box per straight, level
 *    stretch of a run (pieces on a slope get their own box so it follows the ground).
 *  - bush: low-poly round shrub (3 looks: green, dark, flowering + a dry one for the
 *    neighbourhoods). Under house windows, at lot corners, in park clusters, along
 *    roadsides. No collider (you walk through them) unless your model says collider: true.
 *
 * Both are GPU-instanced per 128/256 m chunk and distance-culled.
 *
 * Your own models: realism-config.js -> vegetation (hedges / bushes lists, any number of
 * variants, just a path + scale; see RealismVegetationModels.ts). The older
 * city.props.hedge / city.props.bush overrides still work when those lists are empty.
 * Amounts: vegetation.density. Turn everything off with vegetation.enabled = false
 * (or the older city.vegetation = false).
 */

import { RealismCtx } from './RealismContext';
import { GeoAccum, seeded } from './RealismGeometry';
import { AssetPart } from './RealismAssets';
import { Building, REGIONS } from './RealismMapData';
import { MatrixBatcher, ScatterSpace, scatterSpace, houseKeepOut, inKeepOut, local, roadAt, yawX } from './RealismScatter';
import { VegModelSet, VegEntry, PreparedModel, ChunkInstances, VARIANT_STRIDE, hash01, lateColliders, vegSettings, vegModelStats } from './RealismVegetationModels';

const HEDGE_CHUNK = 256, BUSH_CHUNK = 128;

// --- geometry ---------------------------------------------------------------------

function hedgeParts(ctx: RealismCtx, v: number): AssetPart[]
{
	const a = new GeoAccum();
	const base = v === 0 ? [0.2, 0.36, 0.15] : (v === 1 ? [0.17, 0.3, 0.13] : [0.3, 0.33, 0.16]);
	const dark = [base[0] * 0.7, base[1] * 0.7, base[2] * 0.7];
	const top = [base[0] * 1.15, base[1] * 1.15, base[2] * 1.1];
	const Z = [[0, 0], [0, 0], [0, 0], [0, 0]];
	const x0 = -0.5, x1 = 0.5, zf = 0.5, zb = -0.5, yc = 0.86, zt = 0.36;
	// sides: dark at the foot, lighter towards the top
	const side = (z: number, n: number) =>
	{
		a.face([[x0, 0, z], [x1, 0, z], [x1, 0.45, z], [x0, 0.45, z]], [0, 0, n], Z, dark);
		a.face([[x0, 0.45, z], [x1, 0.45, z], [x1, yc, z], [x0, yc, z]], [0, 0, n], Z, base);
	};
	side(zf, 1); side(zb, -1);
	// chamfers + flat top
	a.face([[x0, yc, zf], [x1, yc, zf], [x1, 1, zt], [x0, 1, zt]], [0, 0.7, 0.7], Z, top);
	a.face([[x1, yc, zb], [x0, yc, zb], [x0, 1, -zt], [x1, 1, -zt]], [0, 0.7, -0.7], Z, top);
	a.face([[x0, 1, zt], [x1, 1, zt], [x1, 1, -zt], [x0, 1, -zt]], [0, 1, 0], Z, top);
	// end caps
	for (let e = -1; e <= 1; e += 2)
	{
		const x = e * 0.5;
		a.face([[x, 0, zb], [x, 0, zf], [x, yc, zf], [x, yc, zb]], [e, 0, 0], Z, base);
		a.face([[x, yc, zb], [x, yc, zf], [x, 1, zt], [x, 1, -zt]], [e, 0, 0], Z, top);
	}
	return [{ geom: a.toGeometry(), mat: ctx.mats.foliage, cast: true }];
}

function bushParts(ctx: RealismCtx, v: number): AssetPart[]
{
	const a = new GeoAccum();
	const cols = [[0.24, 0.4, 0.16], [0.16, 0.29, 0.12], [0.26, 0.42, 0.18], [0.38, 0.36, 0.18]];
	const c = cols[v % cols.length];
	const rnd = seeded(900 + v * 17);
	const lat = 4, lon = 7, rx = 0.7, ry = 0.55, cy = 0.42;
	const wob: number[] = [];
	for (let i = 0; i <= lat; i++) for (let j = 0; j < lon; j++) wob.push(0.82 + rnd() * 0.36);
	const P = (i: number, j: number) =>
	{
		const jj = j % lon;
		const th = (i / lat) * Math.PI, ph = (jj / lon) * Math.PI * 2;
		const w = i === 0 || i === lat ? 1 : wob[i * lon + jj];
		return [Math.sin(th) * Math.cos(ph) * rx * w, cy + Math.cos(th) * ry * (i === lat ? 0.6 : 1), Math.sin(th) * Math.sin(ph) * rx * w];
	};
	for (let i = 0; i < lat; i++)
	{
		for (let j = 0; j < lon; j++)
		{
			const p0 = P(i, j), p1 = P(i, j + 1), p2 = P(i + 1, j + 1), p3 = P(i + 1, j);
			const mx = (p0[0] + p1[0] + p2[0] + p3[0]) / 4, my = (p0[1] + p1[1] + p2[1] + p3[1]) / 4 - cy, mz = (p0[2] + p1[2] + p2[2] + p3[2]) / 4;
			const l = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
			const shade = 0.78 + 0.3 * Math.max(-0.4, my / ry) + (rnd() - 0.5) * 0.1;
			let col = [c[0] * shade, c[1] * shade, c[2] * shade];
			if (v === 2 && i < 3 && rnd() < 0.35) col = rnd() < 0.5 ? [0.85, 0.45, 0.6] : [0.92, 0.9, 0.86];   // flowers
			const n = [mx / l, my / l, mz / l];
			const Z3 = [[0, 0], [0, 0], [0, 0]];
			if (i === 0) a.face([p0, p2, p3], n, Z3, col);
			else if (i === lat - 1) a.face([p0, p1, p3], n, Z3, col);
			else a.face([p0, p1, p2, p3], n, [[0, 0], [0, 0], [0, 0], [0, 0]], col);
		}
	}
	return [{ geom: a.toGeometry(), mat: ctx.mats.foliage, cast: true }];
}

// --- placement ----------------------------------------------------------------------

/** A built hedge piece, kept so your hedge model can be tiled along it once it has loaded. */
interface HedgePiece { ax: number; az: number; bx: number; bz: number; h: number; depth: number; lo: number; hh: number; ry: number; u: number; }
/** A placed bush, kept for your bush model. */
interface BushSpot { x: number; y: number; z: number; ry: number; u: number; }

class VegetationPlacer
{
	private ctx: RealismCtx;
	private sp: ScatterSpace;
	private batch: MatrixBatcher;
	private rnd: () => number;
	private hedgeSet: VegModelSet;
	private bushSet: VegModelSet;
	private dHedge: number;
	private dBush: number;
	private fronts: boolean;
	private sides: boolean;
	public hedgePieces: HedgePiece[] = [];
	public bushSpots: BushSpot[] = [];
	public hedgeMetres = 0;
	public hedgeColliders = 0;
	/** Per kind of hedge: runs that got at least one piece, metres. */
	public tags: { [tag: string]: { runs: number; metres: number; pieces: number } } = {};

	constructor(ctx: RealismCtx, sp: ScatterSpace, batch: MatrixBatcher, hedgeSet: VegModelSet, bushSet: VegModelSet)
	{
		this.ctx = ctx; this.sp = sp; this.batch = batch;
		this.hedgeSet = hedgeSet; this.bushSet = bushSet;
		const vs = vegSettings(ctx);
		this.dHedge = !hedgeSet.custom && batch.isDisabled('hedge') ? 0 : vs.density.hedges;
		this.dBush = vs.density.bushes;
		this.fronts = vs.frontHedges;
		this.sides = vs.sideHedges;
		this.rnd = seeded(ctx.data.seed * 31 + 4049);
	}

	/** A placement chance scaled by vegetation.density.hedges. */
	private hChance(p: number): number
	{
		return Math.min(1, p * this.dHedge);
	}

	/**
	 * Hedge run from (x0,z0) to (x1,z1). Samples every metre and only builds the parts
	 * that are free; each visual piece (<= 4 m) follows the ground. Colliders: one box per
	 * straight, level stretch. keep: building + local rects that must stay clear.
	 * Returns the metres built.
	 */
	public hedgeRun(x0: number, z0: number, x1: number, z1: number, h: number, depth: number, variant: number, roadGap: number, keep?: { b: Building; rects: number[][] }, tag?: string): number
	{
		if (this.dHedge <= 0) return 0;
		const dx = x1 - x0, dz = z1 - z0;
		const L = Math.sqrt(dx * dx + dz * dz);
		if (L < 1.2) return 0;
		// your hedge model: one variant per run, its scale sets height / depth
		let u = -1;
		if (this.hedgeSet.custom)
		{
			u = this.hedgeSet.pick((x0 + x1) / 2, (z0 + z1) / 2, 11);
			const e = this.hedgeSet.entries[u];
			h *= e.scale[1];
			depth *= e.scale[2];
		}
		const n = Math.max(1, Math.round(L));
		const ux = dx / L, uz = dz / L;
		const ok: boolean[] = [];
		for (let i = 0; i < n; i++)
		{
			const t = (i + 0.5) / n * L;
			const x = x0 + ux * t, z = z0 + uz * t;
			let good = this.sp.free(x, z, depth / 2 + 0.1, roadGap, 0.25);
			if (good && keep && inKeepOut(keep.b, keep.rects, x, z, depth / 2)) good = false;
			ok.push(good);
		}
		const seg = L / n;
		const built: HedgePiece[] = [];
		let i = 0;
		while (i < n)
		{
			if (!ok[i]) { i++; continue; }
			let j = i;
			while (j < n && ok[j] && (j - i + 1) * seg <= 4.2) j++;
			const a0 = i * seg, a1 = j * seg;
			if (a1 - a0 >= 0.9) built.push(this.hedgePiece(x0 + ux * a0, z0 + uz * a0, x0 + ux * a1, z0 + uz * a1, h, depth, variant, u));
			i = j;
		}
		if (built.length === 0) return 0;
		if (u < 0 || this.hedgeSet.entries[u].collider) this.colliders(built);
		let m = 0;
		for (let k = 0; k < built.length; k++) { const p = built[k]; m += Math.sqrt((p.bx - p.ax) * (p.bx - p.ax) + (p.bz - p.az) * (p.bz - p.az)); }
		const t = tag || 'other';
		const st = this.tags[t] || (this.tags[t] = { runs: 0, metres: 0, pieces: 0 });
		st.runs++; st.metres += m; st.pieces += built.length;
		return m;
	}

	/** One box collider per stretch of touching pieces whose ground and top stay within ~30 cm. */
	private colliders(ps: HedgePiece[]): void
	{
		let i = 0;
		while (i < ps.length)
		{
			let lo = ps[i].lo, loMax = lo, top = ps[i].lo + ps[i].hh, topMin = top, dep = ps[i].depth;
			let j = i;
			while (j + 1 < ps.length)
			{
				const a = ps[j], q = ps[j + 1];
				if (Math.abs(a.bx - q.ax) + Math.abs(a.bz - q.az) > 0.05) break;
				const nlo = Math.min(lo, q.lo), nloMax = Math.max(loMax, q.lo), ntop = Math.max(top, q.lo + q.hh), ntopMin = Math.min(topMin, q.lo + q.hh);
				if (nloMax - nlo > 0.3 || ntop - ntopMin > 0.35) break;
				const sx = q.bx - ps[i].ax, sz = q.bz - ps[i].az;
				if (sx * sx + sz * sz > 40 * 40) break;
				lo = nlo; loMax = nloMax; top = ntop; topMin = ntopMin; dep = Math.max(dep, q.depth);
				j++;
			}
			const a = ps[i], b = ps[j];
			const dx = b.bx - a.ax, dz = b.bz - a.az;
			const len = Math.sqrt(dx * dx + dz * dz);
			this.ctx.phys.box((a.ax + b.bx) / 2, (lo + top) / 2, (a.az + b.bz) / 2, len / 2, (top - lo) / 2, dep / 2, a.ry);
			this.hedgeColliders++;
			i = j + 1;
		}
	}

	private hedgePiece(ax: number, az: number, bx: number, bz: number, h: number, depth: number, variant: number, u: number): HedgePiece
	{
		const data = this.ctx.data;
		const dx = bx - ax, dz = bz - az;
		const len = Math.sqrt(dx * dx + dz * dz);
		const cx = (ax + bx) / 2, cz = (az + bz) / 2;
		const ha = data.heightAt(ax, az), hb = data.heightAt(bx, bz), hc = data.heightAt(cx, cz);
		const lo = Math.min(ha, hb, hc) - 0.12, hi = Math.max(ha, hb, hc);
		const hh = h + (hi - lo) * 0.6;
		const ry = yawX(dx, dz);
		const sx = len + 0.06, sz = depth * (0.92 + this.rnd() * 0.16);
		this.batch.add('hedge', u < 0 ? variant : variant + VARIANT_STRIDE * u, cx, lo, cz, ry, sx, hh, sz, 'street', HEDGE_CHUNK, true);
		this.hedgeMetres += len;
		// mark as occupied so neighbours' hedges and bushes keep off
		const n = Math.max(1, Math.round(len));
		for (let k = 0; k <= n; k++) this.sp.addCircle(ax + dx * k / n, az + dz * k / n, depth / 2 + 0.15);
		const p: HedgePiece = { ax: ax, az: az, bx: bx, bz: bz, h: h, depth: sz, lo: lo, hh: hh, ry: ry, u: u };
		this.hedgePieces.push(p);
		return p;
	}

	/** A bush, thinned or doubled by vegetation.density.bushes. */
	public bush(x: number, z: number, scale: number, variant: number, roadGap: number, keep?: { b: Building; rects: number[][] }): boolean
	{
		if (this.dBush <= 0) return false;
		if (this.dBush < 1 && hash01(x, z, 29) >= this.dBush) return false;
		const ok = this.bushAt(x, z, scale, variant, roadGap, keep);
		if (ok && this.dBush > 1 && hash01(x, z, 31) < this.dBush - 1)
		{
			const a = hash01(x, z, 37) * Math.PI * 2, d = 0.9 + 1.0 * scale;
			this.bushAt(x + Math.cos(a) * d, z + Math.sin(a) * d, scale * 0.85, variant, roadGap, keep);
		}
		return ok;
	}

	private bushAt(x: number, z: number, scale: number, variant: number, roadGap: number, keep?: { b: Building; rects: number[][] }): boolean
	{
		const r = 0.6 * scale;
		if (!this.sp.free(x, z, r * 0.8, roadGap, 0.15)) return false;
		if (keep && inKeepOut(keep.b, keep.rects, x, z, r * 0.7)) return false;
		const g = this.ctx.data.heightAt(x, z);
		const y = g - 0.08;
		const s = scale, sy = scale * (0.8 + this.rnd() * 0.4);
		const ry = this.rnd() * Math.PI * 2;
		const u = this.bushSet.custom ? this.bushSet.pick(x, z, 13) : -1;
		if (!this.batch.add('bush', u < 0 ? variant : variant + VARIANT_STRIDE * u, x, y, z, ry, s * (0.9 + this.rnd() * 0.2), sy, s, 'detail', BUSH_CHUNK, true)) return false;
		this.sp.addCircle(x, z, r * 0.75);
		if (u >= 0) this.bushSpots.push({ x: x, y: g - 0.05, z: z, ry: ry, u: u });
		return true;
	}

	private pickBush(dry: boolean): number
	{
		if (dry) return this.rnd() < 0.65 ? 3 : 1;
		const r = this.rnd();
		return r < 0.45 ? 0 : (r < 0.8 ? 1 : 2);
	}

	// --- houses ---------------------------------------------------------------------------

	/**
	 * Local z of the street edge (+1.8 m sidewalk) in front of a house, from three probes
	 * across the front. -1 when another building is in the way or no street within 26 m.
	 */
	private frontYardEdge(b: Building): number
	{
		const hw = b.w / 2, hd = b.d / 2;
		let edge = 1e9;
		const probes = [-hw * 0.7, 0, hw * 0.7];
		for (let k = 0; k < probes.length; k++)
		{
			let hit = -1;
			for (let t = hd + 0.6; t < hd + 26; t += 0.6)
			{
				const p = local(b, probes[k], t);
				if (this.ctx.data.roadClearance(p[0], p[1]) < 1.8) { hit = t; break; }
				const o = this.sp.buildingAt(p[0], p[1], 0.2);
				if (o && o !== b) return -1;
			}
			if (hit < 0) return -1;
			edge = Math.min(edge, hit);
		}
		return edge;
	}

	/** Keep-outs for a hedge across the front yard: porch, path, driveway (to the street), back door, both possible door spots. */
	private houseFrontKeep(b: Building, edge: number): number[][]
	{
		const hd = b.d / 2;
		const rects = houseKeepOut(b).map((q) => (q[3] >= hd + 13.9 ? [q[0], q[1], q[2], Math.max(q[3], edge + 3)] : q));
		// a house you can't enter has its (sealed) front door in the middle of the facade
		if (!(b.enterable && b.w >= 6 && b.d >= 6)) rects.push([-1.4, hd - 0.2, 1.4, edge + 3]);
		return rects;
	}

	public houses(): void
	{
		const bs = this.ctx.data.buildings;
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.kind !== 'house' || b.custom || b.w > 22) continue;
			const hood = b.district === 'hood' && this.ctx.cfg.city.gangNeighborhoods !== false;
			const keep = { b: b, rects: houseKeepOut(b) };
			const hw = b.w / 2, hd = b.d / 2;
			const r = seeded(i * 7919 + this.ctx.data.seed);
			if (!hood)
			{
				// SIDE hedges along the lot lines, from behind the house to the front yard
				if (r() < this.hChance(0.6))
				{
					const h = 0.95 + r() * 0.5, dep = 0.75 + r() * 0.2, v = r() < 0.7 ? 0 : 1;
					const zBack = -hd - 1.5 - r() * 2, zFront = hd + 3.0 + r() * 1.5;
					for (let side = -1; side <= 1; side += 2)
					{
						if (r() < 0.15) continue;
						const lx = side * (hw + 1.45);   // clear of the AC unit on the right wall
						const p0 = local(b, lx, zBack), p1 = local(b, lx, zFront);
						const wantReturn = r() < 0.6, retLen = 1.6 + r() * 1.0;
						if (!this.sides) continue;
						this.hedgeRun(p0[0], p0[1], p1[0], p1[1], h, dep, v, 1.2, keep, 'houseSide');
						// short return along the front corner
						if (wantReturn)
						{
							const q0 = local(b, lx, zFront), q1 = local(b, lx - side * retLen, zFront);
							this.hedgeRun(q0[0], q0[1], q1[0], q1[1], h * 0.85, dep, v, 1.2, keep, 'houseSide');
						}
					}
				}
				// foundation planting under the front windows
				for (let lx = -hw + 0.6; lx <= hw - 0.6; lx += 1.5 + r() * 0.4)
				{
					if (r() < 0.3) continue;
					const p = local(b, lx, hd + 0.75 + r() * 0.25);
					this.bush(p[0], p[1], 0.55 + r() * 0.3, this.pickBush(false), 1.0, keep);
				}
				// corner shrubs (back and front corners)
				const corners = [[-hw - 0.9, -hd - 0.9], [hw + 0.9, -hd - 0.9], [-hw - 0.9, hd + 1.0], [hw + 0.9, hd + 1.0]];
				for (let k = 0; k < corners.length; k++)
				{
					if (r() < 0.45) continue;
					const p = local(b, corners[k][0], corners[k][1]);
					this.bush(p[0], p[1], 0.8 + r() * 0.5, this.pickBush(false), 1.2, keep);
				}
				// front yard shrub group
				if (r() < 0.35)
				{
					const cxl = (r() < 0.5 ? -1 : 1) * hw * (0.4 + r() * 0.5), czl = hd + 3 + r() * 2.5;
					const n = 2 + Math.floor(r() * 3);
					for (let k = 0; k < n; k++) { const p = local(b, cxl + (r() - 0.5) * 2.4, czl + (r() - 0.5) * 1.6); this.bush(p[0], p[1], 0.6 + r() * 0.5, this.pickBush(false), 1.2, keep); }
				}
			}
			else
			{
				// neighbourhood lots: a few overgrown, dried-out shrubs
				const n = Math.floor(r() * 3);
				for (let k = 0; k < n; k++)
				{
					const p = local(b, (r() - 0.5) * (b.w + 2), r() < 0.5 ? hd + 1 + r() * 2.5 : -hd - 1 - r() * 2.5);
					this.bush(p[0], p[1], 0.8 + r() * 0.7, this.pickBush(true), 1.0, keep);
				}
			}
			// FRONT hedge across the front yard, just inside the sidewalk, with gaps at the
			// front path and driveway (own random stream: the layout above stays as it was)
			if (this.fronts)
			{
				const rf = seeded(i * 6151 + this.ctx.data.seed * 3 + 17);
				if (rf() < this.hChance(hood ? 0.12 : 0.45))
				{
					const edge = this.frontYardEdge(b);
					if (edge > 0 && edge - hd >= 4.2)
					{
						const zF = edge - 0.95;
						const h = hood ? 0.7 + rf() * 0.5 : 0.75 + rf() * 0.3, dep = 0.65 + rf() * 0.15;
						const v = hood ? 2 : (rf() < 0.7 ? 0 : 1);
						const ext = hw + 1.45;
						const p0 = local(b, -ext, zF), p1 = local(b, ext, zF);
						this.hedgeRun(p0[0], p0[1], p1[0], p1[1], h, dep, v, 1.8, { b: b, rects: this.houseFrontKeep(b, edge) }, 'houseFront');
					}
				}
			}
		}
	}

	// --- apartments / offices / shops / civic ------------------------------------------------

	/**
	 * FRONT: low foundation hedge either side of the entrance (apartments, offices, civic,
	 * towers) or short planters at the corners of shop fronts, so shop windows stay visible.
	 * SIDES: a taller hedge beside apartments / offices / civic / shops with room next to them.
	 * The entrance (door, steps / ramp, canopy, the path out to the street) and fire-escape
	 * ladders stay clear; sidewalks and neighbouring buildings are never touched.
	 */
	public buildingHedges(): void
	{
		const bs = this.ctx.data.buildings;
		const kinds: { [k: string]: boolean } = { shop: true, office: true, apartment: true, civic: true, tower: true };
		for (let i = 0; i < bs.length; i++)
		{
			const b = bs[i];
			if (b.custom || b.district === 'hood' || !kinds[b.kind || '']) continue;
			if (b.w < 6 || b.d < 5 || b.h < 3) continue;
			const r = seeded(i * 104729 + 7);
			const hw = b.w / 2, hd = b.d / 2;
			// the entrance is in the middle of the front (RealismBuildings cityExterior / outerDoors);
			// fire stations / garages / hangars have a big roll-up door and a vehicle apron there
			const garage = b.sub === 'fire' || b.sub === 'mechanic' || b.sub === 'hangar';
			const doorW = garage ? Math.min(26, b.w * 0.5) : Math.min(2.2, b.w * 0.3);
			const gapHalf = doorW / 2 + 1.6;
			const rects = [[-gapHalf, hd - 0.3, gapHalf, hd + 40]];
			if (b.style === 'brick' && b.h > 9 && b.h < 32 && b.w > 8) rects.push([hw - 0.2, -2.4, hw + 1.8, 2.4]);   // fire escape
			const keep = { b: b, rects: rects };
			if (this.fronts && !garage)
			{
				if (b.kind === 'shop')
				{
					if (r() < this.hChance(0.45))
					{
						const h = 0.6 + r() * 0.15, v = r() < 0.5 ? 0 : 1;
						const inner = Math.max(gapHalf, hw - 0.4 - 2.8);
						if (hw - 0.4 - inner >= 1.2) for (let side = -1; side <= 1; side += 2)
						{
							const p0 = local(b, side * (hw - 0.4), hd + 0.75), p1 = local(b, side * inner, hd + 0.75);
							this.hedgeRun(p0[0], p0[1], p1[0], p1[1], h, 0.6, v, 2.0, keep, 'shopPlanter');
						}
					}
				}
				else if (r() < this.hChance(b.kind === 'office' || b.kind === 'tower' ? 0.45 : 0.55))
				{
					const h = 0.7 + r() * 0.25, v = r() < 0.6 ? 0 : 1;
					if (hw - 0.3 - gapHalf >= 1.2) for (let side = -1; side <= 1; side += 2)
					{
						const p0 = local(b, side * (hw - 0.3), hd + 0.85), p1 = local(b, side * gapHalf, hd + 0.85);
						this.hedgeRun(p0[0], p0[1], p1[0], p1[1], h, 0.7, v, 2.0, keep, 'buildingFront');
					}
				}
			}
			if (this.sides && b.kind !== 'tower')
			{
				const rs = seeded(i * 7349 + this.ctx.data.seed + 101);
				if (rs() < this.hChance(b.kind === 'shop' ? 0.25 : 0.4))
				{
					const h = 1.0 + rs() * 0.4, dep = 0.75 + rs() * 0.15, v = rs() < 0.7 ? 0 : 1;
					for (let side = -1; side <= 1; side += 2)
					{
						if (rs() < 0.2) continue;
						const lx = side * (hw + 0.95);
						const p0 = local(b, lx, -hd - 0.3), p1 = local(b, lx, hd + 0.3);
						this.hedgeRun(p0[0], p0[1], p1[0], p1[1], h, dep, v, 2.0, keep, 'buildingSide');
					}
				}
			}
		}
	}

	// --- Central Park ---------------------------------------------------------------------------

	public parks(): void
	{
		const data = this.ctx.data;
		for (let li = 0; li < data.landmarks.length; li++)
		{
			const lm = data.landmarks[li];
			if (lm.kind !== 'park') continue;
			const cx = lm.x, cz = lm.z;
			// find the block edges by walking out to the surrounding streets
			const reach = (dx: number, dz: number) =>
			{
				let t = 2;
				while (t < 220 && data.roadClearance(cx + dx * t, cz + dz * t) > 1.5) t += 1;
				return t;
			};
			const x0 = cx - reach(-1, 0) + 2.2, x1 = cx + reach(1, 0) - 2.2;
			const z0 = cz - reach(0, -1) + 2.2, z1 = cz + reach(0, 1) - 2.2;
			if (x1 - x0 < 20 || z1 - z0 < 20) continue;
			const gap = 5;   // footpath entrances on the centre lines
			const runs = [
				[x0 + 2, z0, cx - gap, z0], [cx + gap, z0, x1 - 2, z0],
				[x0 + 2, z1, cx - gap, z1], [cx + gap, z1, x1 - 2, z1],
				[x0, z0 + 2, x0, cz - gap], [x0, cz + gap, x0, z1 - 2],
				[x1, z0 + 2, x1, cz - gap], [x1, cz + gap, x1, z1 - 2],
			];
			if (this.dHedge >= 0.5) for (let k = 0; k < runs.length; k++) this.hedgeRun(runs[k][0], runs[k][1], runs[k][2], runs[k][3], 0.9, 0.8, 0, 0.8, undefined, 'park');
			// shrub clusters, off the footpaths
			const area = (x1 - x0) * (z1 - z0);
			const clusters = Math.min(40, Math.round(area / 450));
			for (let c = 0; c < clusters; c++)
			{
				const px = x0 + 3 + this.rnd() * (x1 - x0 - 6), pz = z0 + 3 + this.rnd() * (z1 - z0 - 6);
				if (Math.abs(px - cx) < 5 || Math.abs(pz - cz) < 5) continue;
				const n = 3 + Math.floor(this.rnd() * 3);
				for (let k = 0; k < n; k++)
				{
					const bx = px + (this.rnd() - 0.5) * 3.5, bz = pz + (this.rnd() - 0.5) * 3.5;
					if (Math.abs(bx - cx) < 4.5 || Math.abs(bz - cz) < 4.5) continue;
					this.bush(bx, bz, 0.7 + this.rnd() * 0.6, this.pickBush(false), 0.8);
				}
			}
			// flower beds at the four entrances
			const ent = [[cx - gap - 1.2, z0 + 1.4], [cx + gap + 1.2, z0 + 1.4], [cx - gap - 1.2, z1 - 1.4], [cx + gap + 1.2, z1 - 1.4],
				[x0 + 1.4, cz - gap - 1.2], [x0 + 1.4, cz + gap + 1.2], [x1 - 1.4, cz - gap - 1.2], [x1 - 1.4, cz + gap + 1.2]];
			for (let k = 0; k < ent.length; k++) this.bush(ent[k][0], ent[k][1], 0.6, 2, 0.6);
		}
	}

	// --- roadsides -------------------------------------------------------------------------------

	public roadsides(): void
	{
		const data = this.ctx.data;
		const dt = REGIONS.downtown, ap = REGIONS.airport;
		const inR = (x: number, z: number, q: { x0: number; x1: number; z0: number; z1: number }) => x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1;
		const inHood = (x: number, z: number) => { for (let h = 0; h < data.hoods.length; h++) if (inR(x, z, data.hoods[h])) return true; return false; };
		for (let ri = 0; ri < data.roads.length; ri++)
		{
			const road = data.roads[ri];
			if (road.kind !== 'street' && road.kind !== 'avenue' && road.kind !== 'rural' && road.kind !== 'highway') continue;
			const total = road.pts[road.pts.length - 1].s;
			const step = road.kind === 'highway' ? 34 : (road.kind === 'rural' ? 30 : 24);
			for (let s = 8 + this.rnd() * step; s < total - 8; s += step * (0.7 + this.rnd() * 0.6))
			{
				const p = roadAt(road, s);
				if (inR(p.x, p.z, dt) || inR(p.x, p.z, ap)) continue;
				const hood = inHood(p.x, p.z);
				if (this.rnd() > (hood ? 0.25 : 0.55)) continue;
				const side = this.rnd() < 0.5 ? 1 : -1;
				const off = road.width / 2 + (road.kind === 'highway' ? 4 + this.rnd() * 5 : 2.4 + this.rnd() * 3);
				const cx = p.x + p.nx * off * side, cz = p.z + p.nz * off * side;
				const n = 1 + Math.floor(this.rnd() * 3);
				for (let k = 0; k < n; k++)
				{
					const along = (k - (n - 1) / 2) * (1.3 + this.rnd() * 0.6);
					this.bush(cx + p.tx * along + (this.rnd() - 0.5) * 0.8, cz + p.tz * along + (this.rnd() - 0.5) * 0.8, 0.7 + this.rnd() * 0.6, this.pickBush(hood), 1.6);
				}
			}
		}
	}
}

// --- your models ------------------------------------------------------------------------

/** Tiles your hedge model along every hedge piece of variant u once it has loaded. */
function swapHedges(ctx: RealismCtx, batch: MatrixBatcher, set: VegModelSet, pieces: HedgePiece[]): void
{
	for (let u = 0; u < set.entries.length; u++)
	{
		const mine = pieces.filter((p) => p.u === u);
		if (mine.length === 0) continue;
		const uu = u;
		set.load(u, (m: PreparedModel, e: VegEntry) =>
		{
			const data = ctx.data;
			const inst = new ChunkInstances(HEDGE_CHUNK);
			const Lm = Math.max(m.size.x, 0.05), Hm = Math.max(m.size.y, 0.05), Dm = Math.max(m.size.z, 0.05);
			const tile = Math.max(0.3, Lm * e.scale[0]);
			for (let k = 0; k < mine.length; k++)
			{
				const p = mine[k];
				const dx = p.bx - p.ax, dz = p.bz - p.az;
				const len = Math.sqrt(dx * dx + dz * dz);
				const ux = dx / len, uz = dz / len;
				const n = Math.max(1, Math.round(len / tile));
				const tl = len / n;
				for (let t = 0; t < n; t++)
				{
					const ax = p.ax + ux * t * tl, az = p.az + uz * t * tl, bx = ax + ux * tl, bz = az + uz * tl;
					const cx = (ax + bx) / 2, cz = (az + bz) / 2;
					const ha = data.heightAt(ax, az), hb = data.heightAt(bx, bz), hc = data.heightAt(cx, cz);
					const lo = Math.min(ha, hb, hc) - 0.12, hi = Math.max(ha, hb, hc);
					const hh = p.h + (hi - lo) * 0.6;
					inst.add(cx, lo + e.offset[1], cz, p.ry, (tl + 0.03) / Lm, hh / Hm, p.depth / Dm);
				}
			}
			batch.retire('hedge', (v) => Math.floor(v / VARIANT_STRIDE) === uu);
			vegModelStats.meshes += inst.emit(ctx, m, 'street', 'hedge');
			vegModelStats.loaded.push(e.model);
			console.log('[Realism] Your hedge model "' + e.model + '" is tiled along ' + mine.length + ' hedge pieces (' + inst.count + ' tiles).');
		}, () => { vegModelStats.failed.push(set.entries[uu].model); });
	}
}

/** Puts your bush model on every bush of variant u once it has loaded (+ colliders if you asked for them). */
function swapBushes(ctx: RealismCtx, batch: MatrixBatcher, set: VegModelSet, spots: BushSpot[], randomScale: number): void
{
	for (let u = 0; u < set.entries.length; u++)
	{
		const mine = spots.filter((p) => p.u === u);
		if (mine.length === 0) continue;
		const uu = u;
		set.load(u, (m: PreparedModel, e: VegEntry) =>
		{
			const inst = new ChunkInstances(BUSH_CHUNK);
			const sc: number[] = [];
			for (let k = 0; k < mine.length; k++)
			{
				const p = mine[k];
				const s = 1 + randomScale * (2 * hash01(p.x, p.z, 41) - 1);
				sc.push(s);
				inst.add(p.x, p.y, p.z, p.ry, s, s, s);
			}
			batch.retire('bush', (v) => Math.floor(v / VARIANT_STRIDE) === uu);
			vegModelStats.meshes += inst.emit(ctx, m, 'detail', 'bush');
			if (e.collider)
			{
				vegModelStats.colliders += lateColliders(ctx, (phys) =>
				{
					const hw = Math.max(m.size.x, m.size.z) * 0.3;
					for (let k = 0; k < mine.length; k++)
					{
						const p = mine[k], s = sc[k];
						phys.box(p.x, p.y + m.size.y * s / 2, p.z, hw * s, m.size.y * s / 2, hw * s, 0);
					}
				});
			}
			vegModelStats.loaded.push(e.model);
			console.log('[Realism] Your bush model "' + e.model + '" is on ' + mine.length + ' bushes.');
		}, () => { vegModelStats.failed.push(set.entries[uu].model); });
	}
}

export interface VegetationStats
{
	hedges: number; bushes: number; hedgeMetres: number; colliders: number; meshes: number;
	/** Per kind of hedge (houseFront, houseSide, buildingFront, buildingSide, shopPlanter, park): runs, metres, pieces. */
	hedgeRuns: { [tag: string]: { runs: number; metres: number; pieces: number } };
	customHedgeModels: number; customBushModels: number;
}

/** Places hedges and bushes. Call after buildings/street props, before ctx.phys.commit(). */
export function buildVegetation(ctx: RealismCtx): VegetationStats
{
	const vs = vegSettings(ctx);
	if (!vs.enabled) return { hedges: 0, bushes: 0, hedgeMetres: 0, colliders: 0, meshes: 0, hedgeRuns: {}, customHedgeModels: 0, customBushModels: 0 };
	const sp = scatterSpace(ctx);
	const hedgeSet = new VegModelSet(ctx, 'hedge');
	const bushSet = new VegModelSet(ctx, 'bush');
	const batch = new MatrixBatcher(ctx);
	// with your own models in vegetation.hedges / bushes the old city.props.hedge / bush override is ignored
	batch.define('hedge', (v) => hedgeParts(ctx, v % VARIANT_STRIDE), !hedgeSet.custom);
	batch.define('bush', (v) => bushParts(ctx, v % VARIANT_STRIDE), !bushSet.custom);
	const veg = new VegetationPlacer(ctx, sp, batch, hedgeSet, bushSet);
	veg.parks();
	veg.buildingHedges();
	veg.houses();
	veg.roadsides();
	batch.build();
	if (hedgeSet.custom) swapHedges(ctx, batch, hedgeSet, veg.hedgePieces);
	if (bushSet.custom) swapBushes(ctx, batch, bushSet, veg.bushSpots, vs.randomScale);
	const runs: { [tag: string]: { runs: number; metres: number; pieces: number } } = {};
	for (const t in veg.tags) if (veg.tags.hasOwnProperty(t)) runs[t] = { runs: veg.tags[t].runs, metres: Math.round(veg.tags[t].metres), pieces: veg.tags[t].pieces };
	const out: VegetationStats = {
		hedges: batch.counts.hedge || 0, bushes: batch.counts.bush || 0, hedgeMetres: Math.round(veg.hedgeMetres), colliders: veg.hedgeColliders, meshes: batch.meshCount,
		hedgeRuns: runs, customHedgeModels: hedgeSet.entries.length, customBushModels: bushSet.entries.length,
	};
	console.log('[Realism] Vegetation', out);
	return out;
}
