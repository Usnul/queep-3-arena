/*
 * lightgrid.ts -- turn q3map2's baked irradiance volume into point lights.
 *
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * The lightgrid records where light *arrived*, not where it came from, and a
 * scene format wants sources. Reconstructing sources from a sampled irradiance
 * field is an inverse problem with no unique answer, so this does not attempt
 * one. It fits.
 *
 * The fit is greedy and it is stated as a deficit:
 *
 *   1. Every cell the grid lit is a *site* with a target illuminance, a colour,
 *      and a direction the light came from.
 *   2. Sites are visited brightest first. At each, the light already reaching it
 *      -- from the surface-light reconstruction, and from grid lights placed
 *      earlier in this same pass -- is measured.
 *   3. If the shortfall is worth a light, one is placed a short way along the
 *      site's own direction, sized so it closes exactly that shortfall.
 *
 * Three properties fall out of that shape and each was a design goal:
 *
 * - **A well-lit map barely moves.** Nothing is gated on "is this map dark"; the
 *   deficit is simply small where the shader lights already meet the grid, so
 *   little is added and what is added is faint. Measured: the three maps the
 *   demo presents shift by 0.4 lux, by 2%, and not at all, while `oa_dm5` goes
 *   from no lighting whatsoever to 10 lux at the places a player stands.
 * - **The light count is self-limiting.** Each placed light satisfies its
 *   neighbourhood, which removes those sites from consideration. Nothing has to
 *   pick a target count, and a big map does not get a big number just for being
 *   big -- it gets one for having many distinct lit places.
 * - **It optimises the thing that is actually measured.** The complaint in
 *   Q-006 is illuminance at the places a player stands, in lux. That is the
 *   quantity this fits, at every cell of the volume those places sit in.
 *
 * What it is not: an estimate of where the mapper's `light` entities were. A
 * light lands one cell toward the source, which for a ceiling fixture is about
 * right and for the sun through a window is nowhere near. See D-078.
 */

import type { LightGrid } from '../../src/q3/bsp/LightGrid.ts';

/** Rec.709 luma, which is what "how bright is this sample" means here. */
/**
 * Lux per byte of sampled lightgrid irradiance.
 *
 * The grid's bytes are q3map2's own scale with no physical unit on them and
 * meep's lights are photometric, so this number bridges two systems that never
 * agreed. It is measured rather than chosen: on each map whose surface-light
 * reconstruction the demo already accepts, take the median illuminance the
 * reconstruction delivers at the places a player stands and divide it by the
 * median grid brightness at those same places.
 *
 *   oa_dm1  8.7 lux / 103.7 = 0.084     aggressor    20.2 / 104.1 = 0.194
 *   oa_dm4 32.6 lux / 160.9 = 0.202     am_thornish  57.6 /  48.3 = 1.193
 *
 * Fourteen times between the ends of that, which is worth saying plainly: the
 * surface-light route is itself only approximately calibrated, and a map with
 * 147 bright shader lights over open ground is not measuring the same thing as
 * one with 22 in corridors. The median of the four, 0.198, is the robust middle
 * and is what ships. It puts the two fitted maps at 9.0 and 31.8 lux median --
 * inside the 8.7 to 32.6 band the accepted maps already span, which is the
 * property that matters. See D-078.
 *
 * It lives here rather than in `convert-map.ts` because it is the lightgrid's
 * own unit, and because `shader-to-pbr.ts` needs it too: a byte of 255 is the
 * brightest this port admits any surface can be lit, which is what an *unlit*
 * Q3 surface has to be worth. See `UNLIT_LUMINANCE`.
 */
export const LUX_PER_BYTE = 0.2;
export function luma(rgb: readonly [number, number, number]): number {
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** A place the grid says is lit, in scene metres and meep axes. */
export interface GridSite {
    readonly at: readonly [number, number, number];
    /** Unit vector toward the dominant source, meep axes. */
    readonly toward: readonly [number, number, number];
    /** What the grid says arrives here, in lux. */
    readonly lux: number;
    /** Sampled hue, brightest channel normalised to 1. */
    readonly color: readonly [number, number, number];
    /**
     * How far away the source appears to be, in scene metres.
     *
     * Estimated from the grid's own falloff -- see `sourceDistance`. It is what
     * decides whether a fitted light is a bare bulb at arm's length or a
     * fixture across the room, and getting it wrong is not a cosmetic error:
     * a light fitted to deliver the right illuminance at *this* cell from 1 m
     * away delivers a ninth of the truth ten metres out if the real source was
     * 3 m away. The far field is most of the room.
     */
    readonly distance: number;
}

/** The light record `scene.json` carries. Positions in scene metres. */
export interface SceneLight {
    x: number;
    y: number;
    z: number;
    lumens: number;
    /** Cutoff radius -- how far the light reaches. Scene metres. */
    radius: number;
    /** How big the emitter itself is. Scene metres. See {@link SOURCE_EXTENT_FLOOR}. */
    sourceRadius: number;
    color?: [number, number, number];
    /**
     * Which material this light was reconstructed out of, for a surface light.
     *
     * Absent on a light fitted to the lightgrid, which came from no surface --
     * the mirror of `color`, which only a fitted light carries. Between them
     * every light in a bundle says which of the two routes made it.
     *
     * It is here so the fixture's face and the light coming off it stay one
     * emission described twice (D-093): the face's luminance is the material's
     * flux over its area, and since D-105 that flux is whatever the fit settled
     * on rather than anything a shader declared. Without this the two can drift
     * apart again with nothing able to notice.
     */
    material?: number;
}

/**
 * The renderer's own floor on a light's extent, in scene metres.
 *
 * `light_sphere_distance_attenuation` evaluates `1 / max(d, max(r, 1e-2))^2`,
 * so a source with no radius is still not a mathematical delta -- it is a 1 cm
 * one. Mirrored here so the fit's arithmetic and the renderer's agree about the
 * near field; see `perLumen`.
 */
export const SOURCE_EXTENT_FLOOR = 0.01;

/**
 * Radius given to a light fitted to the grid, in scene metres.
 *
 * The fit has no emitter to measure -- it is inferring a source from where the
 * light arrived -- so this is the one light size in the pipeline that is chosen
 * rather than derived. Two things pin it:
 *
 * - The fit already models these as sources standing off a surface by at least
 *   a quarter metre: `d` is floored there, and the comment on that floor calls
 *   it "a bare bulb against the surface". A quarter-metre *radius* is that same
 *   statement made geometrically, so the shape and the arithmetic now say the
 *   same thing.
 * - It is never larger than the `d` a light was sized from, and the renderer's
 *   attenuation is unchanged for `d >= r`. So no fitted site's illuminance
 *   moves: this buys a bounded near field, a finite specular highlight and a
 *   soft terminator, and costs nothing the fit measured.
 */
export const GRID_SOURCE_RADIUS = 0.25;

export interface GridFitOptions {
    /** Sites short by less than this many lux are left to the existing lights. */
    readonly minDeficit: number;
    /**
     * ...and sites short by less than this *fraction* of their own target.
     *
     * An absolute floor alone treats a 2-lux shortfall in a 3-lux cupboard and
     * in a 60-lux atrium as the same problem. The first is the whole room and
     * the second is rounding.
     */
    readonly minDeficitFraction: number;
    /**
     * Where a light stops being worth evaluating, as a fraction of the light
     * that is already there.
     *
     * This replaced an absolute 0.25 lux, and the reason is that no absolute
     * number can be right for two maps at once: a quarter lux is 1% of
     * `oa_dm1`'s median illuminance and 5% of `am_thornish`'s, so one map's
     * lights reached halfway across it while the other's were clipped short.
     * Sixteen of `oa_dm1`'s 33 lights had an influence sphere larger than the
     * entire map, and a third of the light-to-point pairs a shading point
     * evaluated were delivering under half a lux.
     *
     * A fraction asks the question the threshold is actually for -- is this
     * light still changing what a surface here looks like? -- and it asks it
     * against the *local* level rather than a map-wide one. See
     * `referenceLux`.
     */
    readonly cutoffFraction: number;
    /** Hard ceiling on the cutoff radius, in scene metres. */
    readonly maxRadius: number;
    /**
     * True if a light at `to` could not light `from` -- solid in between.
     *
     * Without it the offset walks lights into ceilings and through walls, and a
     * light inside a brush contributes nothing to the room it was meant for
     * while the fit believes it does. Falls back to placing the light at the
     * site itself.
     */
    readonly blocked?: (
        from: readonly [number, number, number],
        to: readonly [number, number, number]
    ) => boolean;
    /** Backstop, so a pathological map cannot emit thousands. */
    readonly maxLights: number;
    /**
     * Relaxation sweeps after placement.
     *
     * Greedy placement overshoots and cannot help it: a light is sized to close
     * the deficit at its own site given the lights placed *before* it, and then
     * every light placed after adds more there. Measured on the six maps, the
     * delivered illuminance came out two to three times the grid's target.
     *
     * The correction is a Gauss-Seidel sweep -- revisit each light, recompute
     * what everything else now delivers at its site, and resize it to close
     * exactly what is left. Zero would ship the overshoot; the alternative of
     * dividing the calibration constant by the measured overshoot would hide a
     * fixable error inside a number that is supposed to mean something.
     */
    readonly sweeps: number;
}

export const DEFAULT_FIT: GridFitOptions = {
    minDeficit: 2,
    minDeficitFraction: 0.34,
    cutoffFraction: 0.03,
    maxRadius: 40,
    maxLights: 256,
    sweeps: 8,
};

/**
 * Illuminance per lumen at squared distance `d2` from a sphere of radius `r`.
 *
 * The renderer's `light_sphere_distance_attenuation`, in the units this file
 * works in: inverse-square in the far field, and capped at `1 / r^2` once the
 * receiver is at or inside the emitter's surface, because a finite source
 * delivers a finite irradiance there rather than an infinite one.
 *
 * It matters that this matches the shader and not merely that it is bounded.
 * The fit *measures* what the existing lights already deliver and only makes up
 * the difference, so a forward model that credits a surface light with more
 * near-field output than the renderer will produce fills the room short.
 */
function perLumen(d2: number, sourceRadius: number): number {
    const rEff = Math.max(sourceRadius, SOURCE_EXTENT_FLOOR);
    // Squared throughout: `max(d, r)^2` is `max(d^2, r^2)`, and the caller has
    // the squared distance already.
    const d2Eff = Math.max(d2, rEff * rEff);

    return 1 / (4 * Math.PI) / d2Eff;
}

/** Illuminance at `p` from one isotropic source, lux. Zero beyond its cutoff. */
function contribution(light: SceneLight, p: readonly [number, number, number]): number {
    const dx = light.x - p[0];
    const dy = light.y - p[1];
    const dz = light.z - p[2];
    const d2 = dx * dx + dy * dy + dz * dz;

    if (d2 > light.radius * light.radius) return 0;

    return light.lumens * perLumen(d2, light.sourceRadius);
}

/**
 * Fit point lights to the shortfall between what the grid measured and what the
 * scene's existing lights deliver.
 *
 * `existing` is read and not modified. The returned lights are new.
 */
export interface GridFitResult {
    readonly lights: SceneLight[];
    /**
     * The lights that were passed in as `existing`, with their output and reach
     * recalibrated against the baked field. New objects; the input is not
     * touched.
     *
     * Same length and same order as `existing`, including any the sweeps drove
     * to nothing, so a caller holding a parallel array -- which material each
     * light came out of, say -- can still index into it. Dropping the dark ones
     * is the caller's to do, after it has read whatever it aligned.
     *
     * These are the `q3map_surfacelight` reconstructions, and until D-105 they
     * were the one part of the lighting solution nothing measured. The fit read
     * them, credited them with whatever their shader's directive said, and
     * optimised only around them -- so a map whose shaders declared numbers too
     * large simply stayed too bright and the fit had nothing to add. They are
     * free variables now, in the same least squares, for the reason given on
     * `relax`.
     */
    readonly surface: SceneLight[];
    /**
     * RMS error of the *whole* lighting solution against the baked field, as a
     * fraction of mean target illuminance, before and after the fit.
     *
     * Reported as a pair because the number alone is misleading. The fit can
     * only add light, so on a map whose surface-light reconstruction already
     * over-delivers against the baked truth -- `am_thornish` delivers 58 lux at
     * player height where the grid says 10 -- the residual stays enormous no
     * matter how well the fit behaves, and the honest statement is that it did
     * not make it worse. `before` is what the surface route alone scores.
     */
    readonly residualBefore: number;
    readonly residualAfter: number;
    /** How many cells the fit was measured against. */
    readonly sites: number;
}

export function fitGridLights(
    sites: readonly GridSite[],
    existing: readonly SceneLight[],
    options: Partial<GridFitOptions> = {}
): GridFitResult {
    const opt = { ...DEFAULT_FIT, ...options };
    /*
     Copied because the caller's array is the scene's, and this function now
     changes what these lights emit. The greedy pass below still reads them at
     the values their shaders declared -- that is the best guess available
     before anything has been measured, and placement only needs to know
     roughly where the map is already lit.
    */
    const surface: SceneLight[] = existing.map((l) => ({ ...l }));
    const placed: SceneLight[] = [];
    /** The site each placed light was fitted to, and how far it sits from it. */
    const fittedTo: { site: GridSite; distance: number }[] = [];

    // Brightest first. A dim site next to a bright one is usually the same room,
    // and visiting the bright one first means the dim one sees that light and
    // asks for nothing.
    const order = sites.slice().sort((a, b) => b.lux - a.lux);

    for (const site of order) {
        if (placed.length >= opt.maxLights) break;

        let have = 0;
        for (const l of surface) have += contribution(l, site.at);
        for (const l of placed) have += contribution(l, site.at);

        const deficit = site.lux - have;
        if (deficit < opt.minDeficit) continue;
        if (deficit < site.lux * opt.minDeficitFraction) continue;

        /*
         Toward the source, as far as the grid's falloff says it is -- and if
         that walks through a wall, not as far.

         Shortened rather than abandoned. Putting the light *on* the sample when
         the step is blocked was the first version and it is degenerate: the fit
         sizes a light from `lumens = deficit * 4pi * d^2` and evaluates it as
         `lumens / 4pi / d^2`, so at `d = 0` the two disagree by whatever epsilon
         guards the division, the least-squares pass drives the light to nothing,
         and a sample against a wall silently gets no light at all. A floor of a
         quarter-metre keeps the geometry consistent and is a bare bulb against
         the surface, which is what a sample flush against an emitter is.
        */
        const step = (fraction: number): [number, number, number] => [
            site.at[0] + site.toward[0] * site.distance * fraction,
            site.at[1] + site.toward[1] * site.distance * fraction,
            site.at[2] + site.toward[2] * site.distance * fraction,
        ];

        const floor = Math.min(1, 0.25 / Math.max(site.distance, 1e-6));
        let to = step(1);

        for (const fraction of [0.5, 0.25, floor]) {
            if (opt.blocked?.(site.at, to) !== true) break;
            to = step(fraction);
        }

        const [px, py, pz] = to;

        // `lux = lumens / 4pi / d^2`, so `lumens = deficit * 4pi * d^2`.
        const d = Math.max(
            0.25,
            Math.hypot(px - site.at[0], py - site.at[1], pz - site.at[2])
        );

        const lumens = deficit * 4 * Math.PI * d * d;

        placed.push({
            x: px,
            y: py,
            z: pz,
            lumens,
            // Where it falls below `cutoff` lux, which is where keeping it in the
            // cluster list stops paying for itself.
            /*
             Where it falls to `cutoffFraction` of what the grid says is at the
             site it was fitted to. Provisional -- the relaxation resizes the
             light and recomputes this from the region it ends up lighting --
             but the site's own baked level is the right local reference to
             start from, and it is already in hand.
            */
            radius: Math.min(
                opt.maxRadius,
                Math.max(
                    d,
                    Math.sqrt(lumens / (4 * Math.PI) / (site.lux * opt.cutoffFraction))
                )
            ),
            // Never larger than the `d` above, which is floored at the same
            // quarter metre. See GRID_SOURCE_RADIUS.
            sourceRadius: Math.min(GRID_SOURCE_RADIUS, d),
            color: [site.color[0], site.color[1], site.color[2]],
        });
        fittedTo.push({ site, distance: d });
    }

    const residualBefore = residualOf(sites, existing);
    relax(surface, placed, fittedTo, sites, opt);

    // A light the sweeps drove to nothing is a light whose neighbours turned out
    // to cover its site. Dropping it is half the point of running them.
    const keep = placed.filter((l) => l.lumens > 1);

    return {
        lights: keep,
        surface,
        residualBefore,
        residualAfter: residualOf(sites, [...surface, ...keep]),
        sites: sites.length,
    };
}

/**
 * Least-squares coordinate descent: choose each light's output so the whole
 * field, not just its own cell, comes out as close to the grid as possible.
 *
 * Greedy placement overshoots and cannot help it. A light is sized to close the
 * deficit at its own site given the lights placed *before* it, and every light
 * placed after adds more there; measured over the six maps, delivered
 * illuminance came out two to three times the grid's target. Constraining only
 * the sites that received a light does not fix it either -- that was the first
 * attempt, and it left `oa_dm1` at 52 lux against a 21 lux target, because the
 * cells *between* the lights are unconstrained and that is most of the map.
 *
 * So the objective is the residual over every site:
 *
 *     minimise  sum_j ( target_j - sum_i lumens_i * c_ij )^2
 *
 * with `c_ij = 1 / (4 pi d_ij^2)` the illuminance per lumen from light `i` at
 * site `j`. Holding every light but one fixed makes that a one-variable least
 * squares with a closed form,
 *
 *     lumens_i = sum_j r_j c_ij / sum_j c_ij^2,     r_j the residual at j
 *
 * clamped at zero because a negative light is not a thing. Sweeping that over
 * the lights is coordinate descent, it is monotone in the objective, and it
 * converges in a handful of passes because the coupling is local.
 *
 * The alternative was to divide the calibration constant by the measured
 * overshoot. That would have produced the same median and hidden a fixable
 * error inside a number that is supposed to mean something.
 *
 * **The surface lights are in it too, and that is D-105.** They used to be held
 * fixed -- `existing`, read into the residual and never adjusted -- which meant
 * the one number nothing measured was the one doing most of the lighting. It is
 * `q3map_surfacelight` passed through as lumens, and that directive is not
 * luminous flux: it is q3map2's own scale, applied per unit area, so reading it
 * as a per-fixture flux makes a 0.2 m2 torch quad on `oa_dm1` emit 3,787 lm
 * while the 38 m2 lava lake beside it emits 666. Ten torches then hold 90% of
 * that map's reconstructed flux over 2% of its emitting area.
 *
 * Measured against the baked field, the error is not a scale factor anyone
 * could divide out. It is scrambled: on `oa_dm4` `ironcrosslt2_20000` ends up
 * at 0.22 of what it declared and `skulllight01` at 5.4 times, on the same map.
 * So the directive stops being a claim about lumens and becomes what it can
 * support -- a starting point for the same least squares that already sizes
 * everything else, against the same baked field, in the same sweeps.
 */
function relax(
    surface: SceneLight[],
    placed: SceneLight[],
    fittedTo: readonly { site: GridSite; distance: number }[],
    sites: readonly GridSite[],
    opt: GridFitOptions
): void {
    const all = [...surface, ...placed];
    if (all.length === 0 || sites.length === 0) return;

    /*
     The near end of a light's range. A fitted light may not reach less far than
     the standoff it was sized from, or it delivers less than the arithmetic
     that placed it says it does; a surface light may not reach less far than
     its own emitter, which is where its falloff even starts.
    */
    const floorOf = (i: number): number =>
        i < surface.length
            ? Math.max(all[i]!.sourceRadius, SOURCE_EXTENT_FLOOR)
            : fittedTo[i - surface.length]!.distance;

    /*
     Output and reach are one problem, so they are solved together.

     The first version of this fitted output over a fixed generous reach and
     then cut each light back to its cutoff radius afterwards. That ships a
     field nobody optimised: every light was sized on the promise of lighting
     cells it is then not evaluated at, and the shortfall is systematic and
     one-directional. Measured on `oa_dm1`, that delivered 0.52 of the baked
     target at the median; coupling the two brought it to 0.63.

     So the loop alternates. Sweeps size the lights against exactly the sites
     each one will actually be evaluated at; the resize then moves the reach to
     match the new output; and the next round measures against that. Reach is
     held still *within* a round, because a neighbour list that moved under the
     optimiser would stop the descent being monotone.

     It ends on a sweep rather than a resize, and that -- not the round count --
     is the part that matters: it is what makes the shipped output one that was
     fitted at the shipped reach.
    */
    let near = influence(all, sites);

    for (let round = 0; round < REACH_ROUNDS; round++) {
        sweep(all, near, sites, opt);
        resize(all, near, sites, opt, floorOf);
        near = influence(all, sites);
    }

    // Ending on a sweep rather than a resize, so what ships is an output fitted
    // at the reach it ships with.
    sweep(all, near, sites, opt);
}

/**
 * How many times output and reach are solved against each other.
 *
 * The outer loop is not the monotone part -- coordinate descent is monotone for
 * a *fixed* neighbour list, and this changes the list between rounds -- so what
 * it does is measured rather than argued.
 *
 * The residual is flat from the first round: 79% on `oa_dm1` and 78% on
 * `am_thornish` at one round, two, three, four and six. Total emitted flux
 * moves by about a percent over that range. What does not fully settle is the
 * individual light -- `oa_dm1`'s median reach wanders between 11.0 m and 13.7 m
 * and its light count between 30 and 26 -- because a light near the one-lumen
 * drop threshold moves in and out of the solution as its reach changes, and
 * each one that leaves redistributes a little. That is a mild limit cycle at
 * the margins, not a divergence, and no round count removes it.
 *
 * So three is not a convergence claim. It is one round for the coupling, which
 * is the part that was actually broken, and two more because they are cheap and
 * the answer is marginally better settled with them.
 */
const REACH_ROUNDS = 3;

/**
 * Which sites each light is evaluated at, and how much a lumen of it is worth
 * there.
 *
 * Frozen for the duration of a sweep. A light's radius moves as its output
 * does, and letting the neighbour list move with it would change the objective
 * under the optimiser -- coordinate descent is only monotone while the thing it
 * descends stays put.
 */
function influence(
    lights: readonly SceneLight[],
    sites: readonly GridSite[]
): { j: number; c: number }[][] {
    return lights.map((light) => {
        const list: { j: number; c: number }[] = [];
        const r2 = light.radius * light.radius;

        /** The closest site, in case nothing is in range. */
        let nearest = -1;
        let nearestD2 = Infinity;

        for (let j = 0; j < sites.length; j++) {
            const at = sites[j]!.at;
            const dx = light.x - at[0];
            const dy = light.y - at[1];
            const dz = light.z - at[2];
            const d2 = dx * dx + dy * dy + dz * dz;

            if (d2 < nearestD2) { nearestD2 = d2; nearest = j; }
            if (d2 > r2) continue;

            list.push({ j, c: perLumen(d2, light.sourceRadius) });
        }

        /*
         A light can shrink until the lattice no longer has a cell inside it --
         cells are 64 units apart and a dim fixture's reach is a couple of
         metres. Measuring it against its nearest cell anyway is what stops the
         resize from making a light unmeasurable and then, because nothing
         measures it, permanent.
        */
        if (list.length === 0 && nearest >= 0) {
            list.push({ j: nearest, c: perLumen(nearestD2, light.sourceRadius) });
        }

        return list;
    });
}

/** One pass of coordinate descent over every light's output. */
function sweep(
    lights: SceneLight[],
    near: readonly { j: number; c: number }[][],
    sites: readonly GridSite[],
    opt: GridFitOptions
): void {
    // Running total at every site, so a step costs one light's neighbourhood
    // rather than a full re-evaluation.
    const delivered = new Float64Array(sites.length);
    for (let i = 0; i < lights.length; i++) {
        for (const { j, c } of near[i]!) delivered[j] += lights[i]!.lumens * c;
    }

    for (let pass = 0; pass < opt.sweeps; pass++) {
        for (let i = 0; i < lights.length; i++) {
            const list = near[i]!;
            if (list.length === 0) continue;

            let num = 0;
            let den = 0;

            for (const { j, c } of list) {
                // Residual with this light's own contribution taken back out.
                const r = sites[j]!.lux - (delivered[j]! - lights[i]!.lumens * c);
                num += r * c;
                den += c * c;
            }

            const next = den > 0 ? Math.max(0, num / den) : 0;
            const change = next - lights[i]!.lumens;
            if (change === 0) continue;

            lights[i]!.lumens = next;
            for (const { j, c } of list) delivered[j] += change * c;
        }
    }
}

/** Move every light's reach to `cutoffFraction` of the level around it. */
function resize(
    lights: SceneLight[],
    near: readonly { j: number; c: number }[][],
    sites: readonly GridSite[],
    opt: GridFitOptions,
    floorOf: (i: number) => number
): void {
    for (let i = 0; i < lights.length; i++) {
        const light = lights[i]!;
        const cutoff = referenceLux(near[i]!, sites) * opt.cutoffFraction;

        // Nothing measured nearby, so there is no local level to be a fraction
        // of, and the reach it arrived with is the only estimate there is.
        if (cutoff <= 0) continue;

        light.radius = Math.min(
            opt.maxRadius,
            Math.max(floorOf(i), Math.sqrt(light.lumens / (4 * Math.PI) / cutoff))
        );
    }
}

/**
 * How much light is already in the region a light works in, in lux.
 *
 * The reference for `cutoffFraction`, and it is weighted by the light's own
 * contribution rather than taken flat over its neighbourhood. A fixture stands
 * a couple of metres from the surfaces it lights and tens of metres from the
 * far end of its reach; an unweighted mean over that sphere is mostly the far
 * end, which is the part the fixture has nothing to do with. Weighting by `c`
 * asks what the places this light actually lights are lit to.
 *
 * So a lamp over a bright atrium is measured against the atrium and one in a
 * dark corridor against the corridor, and the same 3% means the same thing in
 * both -- which is the whole reason for a fraction over a fixed lux value.
 */
function referenceLux(
    list: readonly { j: number; c: number }[],
    sites: readonly GridSite[]
): number {
    let num = 0;
    let den = 0;

    for (const { j, c } of list) {
        num += c * sites[j]!.lux;
        den += c;
    }

    return den > 0 ? num / den : 0;
}

/** RMS illuminance error over the sites, relative to their mean target. */
function residualOf(sites: readonly GridSite[], lights: readonly SceneLight[]): number {
    if (sites.length === 0) return 0;

    let sumSquares = 0;
    let sumTarget = 0;

    for (const site of sites) {
        let have = 0;
        for (const l of lights) have += contribution(l, site.at);

        const e = site.lux - have;
        sumSquares += e * e;
        sumTarget += site.lux;
    }

    const mean = sumTarget / sites.length;
    return mean > 0 ? Math.sqrt(sumSquares / sites.length) / mean : 0;
}

/* ------------------------------------------------------------------ *
 * Grid -> sites
 * ------------------------------------------------------------------ */

export interface SiteOptions {
    /**
     * Lux per byte of sampled irradiance.
     *
     * The grid's bytes are q3map2's own scale with no physical unit attached,
     * and meep's lights are photometric, so something has to bridge them. This
     * number is not chosen, it is measured: see `LUX_PER_BYTE`.
     */
    readonly luxPerByte: number;
    /** Cells dimmer than this many bytes are not worth a site. */
    readonly minBytes: number;
    /** Q3 units and axes -> scene metres and meep axes. */
    toScene(q3: readonly [number, number, number]): [number, number, number];
    /** Metres. Where the falloff estimate is unusable, and its bounds. */
    readonly defaultDistance: number;
    readonly minDistance: number;
    readonly maxDistance: number;
    /**
     * True when the sun already lights this Q3 point.
     *
     * Skipped rather than fitted. The sun is a directional light with no
     * falloff, so no point light can stand in for it and any attempt to fill a
     * courtyard's deficit produces a bright ball hanging in the open air. A
     * site that can see sky is the sun's job.
     */
    litBySun?(q3: readonly [number, number, number]): boolean;
}

/**
 * Every cell the grid lit, as a site the fit can work on.
 *
 * Cells inside solid geometry read `0, 0` and drop out on `minBytes` without
 * needing a separate solidity test -- q3map2 had nothing to sample there. That
 * is most of the lattice: `oa_dm5` has 3,410 cells and 980 with any light in
 * them at all.
 */
export function sitesFromGrid(grid: LightGrid, options: SiteOptions): GridSite[] {
    const sites: GridSite[] = [];
    const [nx, ny] = grid.bounds;
    const strideZ = nx * ny;

    /** Directed luma at a lattice coordinate, or -1 off the edge. */
    const directedAt = (x: number, y: number, z: number): number => {
        if (x < 0 || y < 0 || z < 0) return -1;
        if (x >= grid.bounds[0] || y >= grid.bounds[1] || z >= grid.bounds[2]) return -1;
        return luma(grid.at(x + y * nx + z * strideZ).directed);
    };

    for (let i = 0; i < grid.count; i++) {
        const sample = grid.at(i);

        const brightness = luma(sample.ambient) + luma(sample.directed);
        if (brightness < options.minBytes) continue;

        if (options.litBySun?.(sample.origin) === true) continue;

        const z = Math.floor(i / strideZ);
        const y = Math.floor((i - z * strideZ) / nx);
        const x = i - z * strideZ - y * nx;

        // Q3 axes to meep axes for the direction: (x, y, z) -> (x, z, -y). The
        // same swap the geometry went through, applied to a vector rather than
        // a point, so no translation.
        const d = sample.direction;
        const toward: [number, number, number] = [d[0], d[2], -d[1]];

        const r = sample.ambient[0] + sample.directed[0];
        const g = sample.ambient[1] + sample.directed[1];
        const b = sample.ambient[2] + sample.directed[2];
        const peak = Math.max(r, g, b, 1);

        sites.push({
            at: options.toScene(sample.origin),
            toward,
            lux: brightness * options.luxPerByte,
            color: [r / peak, g / peak, b / peak],
            distance: sourceDistance(grid, [x, y, z], sample.direction, directedAt, options),
        });
    }

    return sites;
}

/**
 * How far away the dominant source is, from the grid's own inverse-square
 * falloff.
 *
 * Two samples on a line through the source determine its distance. Take this
 * cell and its neighbour one step *away* from the source: if the source is a
 * point at distance `d`, illuminance goes as `1/d^2`, so
 *
 *     E0 / E1 = ((d + s) / d)^2   ->   d = s / (sqrt(E0/E1) - 1)
 *
 * where `s` is how much further the neighbour is, which is the cell spacing
 * projected onto the light direction. Everything about that is approximate --
 * the source is not a point, the neighbour may be shadowed by something the
 * cell is not, and q3map2's bytes are quantised and gamma-ish -- so the answer
 * is clamped hard and falls back to a default whenever the two samples do not
 * describe a falloff at all.
 *
 * It earns its place anyway. Without it the fit used a fixed one-metre offset,
 * which sized every light as a bare bulb against the nearest surface: 256
 * lights on `oa_dm1` against the 22 its shaders already give it, each one tiny,
 * each satisfying only the cell it was fitted to. The estimate is what turns a
 * volume of fireflies back into room lighting.
 */
function sourceDistance(
    grid: LightGrid,
    cell: readonly [number, number, number],
    direction: readonly [number, number, number],
    directedAt: (x: number, y: number, z: number) => number,
    options: SiteOptions
): number {
    // Step along whichever axis the direction is most aligned with; the others
    // barely change the distance to the source and their samples are noise.
    let axis = 0;
    for (let i = 1; i < 3; i++) {
        if (Math.abs(direction[i]!) > Math.abs(direction[axis]!)) axis = i;
    }

    const along = Math.abs(direction[axis]!);
    if (along < 1e-3) return options.defaultDistance;

    const back = [cell[0], cell[1], cell[2]];
    back[axis] = back[axis]! - Math.sign(direction[axis]!);

    const near = directedAt(cell[0], cell[1], cell[2]);
    const far = directedAt(back[0]!, back[1]!, back[2]!);

    // Not a falloff: the neighbour is off the lattice, dark, in a wall, or
    // brighter than the cell that is supposed to be closer to the source.
    if (near <= 0 || far <= 0 || far >= near) return options.defaultDistance;

    // Q3 units between the two samples, projected onto the light direction.
    const step = grid.size[axis]! * along;
    const d = step / (Math.sqrt(near / far) - 1);

    if (!Number.isFinite(d) || d <= 0) return options.defaultDistance;

    // Q3 units to scene metres happens through the caller's own conversion, so
    // the bounds are applied there in the same units they are declared in.
    const metres = (d * options.toScene([1, 0, 0])[0]);

    return Math.min(options.maxDistance, Math.max(options.minDistance, metres));
}
