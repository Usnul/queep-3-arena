/*
 * patchHull.ts -- turn Quake III patches into convex collision facets.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * A brush is already convex, so `brushHull.ts` is a change of representation
 * and nothing else. A patch is not: it is a curved *sheet*, and it has to
 * become solid volumes before meep can collide against it. This file is that
 * step, and the shape of the problem is set by what the query layer can
 * actually answer.
 *
 * **The pieces have to be convex.** `shape_cast` -- the query behind
 * `pm->trace` -- runs GJK against a shape's support function, and says so in
 * its own source: "this query has never supported concave [targets]". Handing
 * it a whole patch as one `MeshShape3D` does not fail loudly; it collides
 * against the *convex hull* of the sheet, because that is what `MeshShape3D`'s
 * support function returns. For a column that happens to be right. For an arch
 * it fills the archway in, and the corridor underneath silently becomes a wall.
 * `MeshShape3D` also declares `is_convex === false`, which switches
 * `shape_cast` off its tangency path onto the unconditional "solid, blocked at
 * `t = 0`" one -- the case its own comment describes as making a character
 * flush against a wall fall through the floor.
 *
 * So the patch is decomposed into convex facets, which is what `cm_patch.c`
 * does too, and each facet is a `ConvexHullShape3D` exactly as a brush is.
 *
 * **The decomposition is by grid block, not by quad.** One piece per
 * tessellated quad is the obvious answer and it is unaffordable: `am_thornish`
 * would go from 756 static bodies to about 23,000. Instead a block of the
 * control grid is kept whole for as long as it stays convex, and split when it
 * does not. That collapses the 249 flat patches on that map to one piece each
 * and a round column to one piece per segment, while an arch still splits down
 * to near-planar strips because it has to.
 *
 * **A facet is a plane set, not a mesh.** Each block contributes its own cell
 * planes, a border plane per boundary edge (`cm_patch.c` calls these the border
 * and bevel planes), and one closing plane behind. `hullFromPlanes` turns that
 * into the same winding-clipped hull a brush gets, so the facets satisfy
 * `ConvexHullShape3D.from`'s winding contract by construction rather than by a
 * second, parallel argument.
 *
 * Every candidate plane's distance is set to the block's *support* in that
 * direction rather than to the plane's own position. For a genuinely convex
 * block those are the same number. For one that is convex only to within
 * `CONVEX_EPSILON` it pushes the plane out by up to that much, so the error is
 * always a facet that is a hair too big rather than one a player can fall
 * through -- and Q3's own bevel planes err in the same direction.
 *
 * **The shell is centred on the sheet, not hung behind it.** Q3's patch facets
 * are zero-thickness and collide from *both* faces -- `CM_TraceThroughPatchCollide`
 * walks a facet's planes without asking which way it points -- so a mapper has
 * never had a reason to wind a collision patch one way rather than the other.
 * Nothing in the map checks it and nothing in the game reads it. Measured on
 * `am_thornish`, 6,208 of its 11,584 near-horizontal patch cells -- 54% -- put
 * their solid *above* the drawn surface rather than below it. That is not a map
 * full of mistakes: it is a field with no right answer being sampled.
 *
 * A shell hung behind whichever face the winding calls the front is therefore
 * exact on one side of the sheet and a whole `FACET_THICKNESS` out on the other,
 * and which one it gets is a coin flip. That is not a hypothetical: the map's
 * corner jump pads are capped by a `SURF_NODRAW` patch wound downwards, so the
 * four units went *up*, the player stood on the back of the slab four units
 * above the surface the map draws, and the pad's `trigger_push` volume was
 * entirely below their feet.
 *
 * So the shell straddles the surface -- `FACET_STANDOFF` in front and the same
 * behind -- and the winding decides nothing about it. That costs half a unit on
 * the side that used to be exact and saves three and a half on the side that
 * was not, and it reads nothing into the winding that Q3 does not. See
 * DECISIONS.md D-139.
 *
 * The winding still decides the *decomposition*, and there it is load-bearing:
 * `isConvex` reads concavity from the drawn side, which is what keeps an archway
 * open, and there is no second source for that. The difference is that a shape
 * question has no other answer, while "which side is solid" has a better one --
 * don't ask it.
 *
 * **A facet is a shell, not a fill.** A closed patch -- a column -- comes out as
 * a ring of wall facets rather than a solid cylinder, so the space inside it is
 * not solid and `pointContents` there reads empty. That is Q3's behaviour too:
 * `CM_PointContents` consults brushes only, and what stops a player is the
 * surface, not the volume behind it.
 *
 * One consequence is worth knowing before it is rediscovered as a bug. Where
 * two facets meet at a *convex* crease their shells splay apart, leaving a
 * wedge behind the surface that neither covers. It is unreachable -- getting
 * into it means passing through the surface first -- and Q3's own facets have
 * the same gaps for the same reason, but a point test dropped into one will say
 * "not solid" and be right.
 *
 * What this does *not* do is make `boxTrace` in `trace.ts` see patches; that is
 * `cm_patch.c`'s grid walk and is still unported. The physics backend is the
 * one that collides against them. See DECISIONS.md D-017.
 */

import { tessellatePatch, type PatchVertex } from '../bsp/patch.ts';
import { hullFromPlanes, type BrushHull } from './brushHull.ts';
import type { ClipMap, ClipMapPatch } from './ClipMap.ts';

/**
 * Collision subdivision: each 3x3 Bezier patch becomes this many quads a side.
 *
 * Coarser than the renderer's 8, and deliberately. Q3's own collision grid is
 * coarser still -- `cm_patch.c` subdivides until the curve is within
 * `SUBDIVIDE_DISTANCE` (16 units) of flat, which for a 64-unit-radius column
 * is about eight facets around. 4 gives sixteen, so the collision surface is
 * finer than the one the original game shipped while costing a quarter of the
 * decomposition work and half the support-function scan of matching the
 * renderer exactly.
 *
 * The visible consequence is that a facet's midpoint sits inside the drawn
 * surface by the sagitta -- 1.2 units on a 128-unit column. Q3 has the same
 * gap, larger.
 */
export const COLLISION_LEVEL = 4;

/**
 * How far a block may bulge past one of its own cell planes before it splits.
 *
 * This is the convexity test's tolerance, in Q3 units. Zero would split on
 * float noise in a flat grid; too large and a genuinely concave block survives
 * as one piece and over-blocks. A quarter unit is well under
 * `SURFACE_CLIP_EPSILON`'s eighth doubled, and far under anything a player can
 * feel.
 */
const CONVEX_EPSILON = 0.25;

/**
 * How thick a facet is made, in Q3 units, centred on the surface it came from.
 *
 * A patch is a sheet with no thickness and a collider needs volume. Half of this
 * goes on each side; see the header for why it is not all put behind.
 *
 * Every constraint on the number is a floor rather than a ceiling, so it is set
 * to the smallest value that clears them all with room to spare. The two faces
 * have to survive `hullFromPlanes`' winding clip, whose `CHOP_EPSILON` is 0.1,
 * or the front and back are taken for one plane and the facet has no volume at
 * all; and `FACET_STANDOFF` has to be more than `SURFACE_CLIP_EPSILON` so that
 * the eighth of a unit Q3 holds a resting player clear by does not reach through
 * the shell. One unit is ten times the first and four times the second.
 *
 * It was four, so that "the swept query cannot step over the facet in one
 * frame". That is not a risk the query runs. `pm->trace` is `shape_cast` over
 * the whole segment and a missile carries `RigidBodyFlags.CCD`; nothing in this
 * port meets the level with a discrete narrowphase, and a swept query does not
 * step over anything however thin it is. What the extra three units bought was
 * error, and the error is what the header is about.
 *
 * The cost of the half unit that is left is best read against the gap this file
 * already has: at `COLLISION_LEVEL` a facet chord across a 128-unit column sits
 * 1.2 units inside the drawn surface. Standing off by 0.5 is well inside a
 * disagreement between the collision surface and the drawn one that has been
 * there since the decomposition shipped, and Q3's is larger still.
 *
 * A closed patch -- a full cylinder -- needs no closing plane, and gets none:
 * its own cell planes bound it from every side.
 */
const FACET_THICKNESS = 1;

/**
 * Half of {@link FACET_THICKNESS}: how far the shell stands off each face.
 *
 * Both the cell planes and the closing plane are pushed out by this. The border
 * planes are not -- they bound the facet *sideways*, where there is no sheet to
 * straddle and growing the plane set would only widen the patch's own footprint.
 */
const FACET_STANDOFF = FACET_THICKNESS / 2;

/**
 * Below this, a block's cell normals are taken to cancel out, meaning the block
 * wraps far enough around to bound itself.
 *
 * The test is the length of the area-weighted mean normal over the total area:
 * 1 for a flat block, 0 for a closed tube. A tube that is *nearly* closed still
 * gets a closing plane, but `supportOf` puts it behind every vertex, so it
 * cannot cut real volume away either way.
 */
const CLOSED_NORMAL_EPSILON = 0.05;

/** Normals within this of each other, and distances within `DEDUPE_DIST`, are one plane. */
const DEDUPE_DOT = 0.9999;
const DEDUPE_DIST = 0.05;

/**
 * A facet whose bounds exceed its block's by more than this, in Q3 units, is
 * rejected as unbounded.
 *
 * The safety net under the argument that cell planes plus border planes plus
 * the closing plane always span every direction. If that argument is ever
 * wrong for some patch in some map, `hullFromPlanes` returns a hull the size of
 * `MAX_MAP_BOUNDS` rather than a facet, and a million-unit invisible box in the
 * middle of a level is not a failure to discover from a bug report.
 *
 * A flat number, and it has to be. This was `4 * FACET_THICKNESS + 1`, which
 * reads as a margin proportional to how far a facet is allowed to stand off its
 * own surface -- but the two are not related. A facet overshoots its block by
 * the standoff and `CONVEX_EPSILON`, which is under a unit; the margin is here
 * to tell a facet from a map-sized box, and anything between those two works.
 * Tying it to the thickness meant that thinning the shell to a unit tightened
 * this to five, and *that* rejected 650 blocks that were in no trouble at all,
 * split them, and left 65 single cells dropped -- holes in the collision, from
 * a change that made every facet smaller. Held at the figure it has always had.
 */
const ESCAPE_MARGIN = 17;

export interface PatchHullSet {
    readonly hulls: readonly BrushHull[];
    /** Patches that produced no usable facet at all. */
    readonly skipped: number;
    /** Blocks rejected by the bounds check and split instead; see `ESCAPE_MARGIN`. */
    readonly unbounded: number;
    /** Single cells given up on, which are holes in the collision surface. */
    readonly dropped: number;
    readonly milliseconds: number;
}

/** A rectangle of the tessellated grid, in *cell* coordinates, inclusive. */
interface Block {
    u0: number;
    v0: number;
    u1: number;
    v1: number;
}

/** Zeroed attributes; collision reads positions and nothing else. */
function controlVertex(x: number, y: number, z: number): PatchVertex {
    return { x, y, z, s: 0, t: 0, lms: 0, lmt: 0, nx: 0, ny: 0, nz: 0, r: 1, g: 1, b: 1, a: 1 };
}

/** What one patch decomposed into. */
export interface PatchFacets {
    readonly hulls: readonly BrushHull[];
    /**
     * Blocks rejected by the bounds check; see `ESCAPE_MARGIN`.
     *
     * Not lost surface: a rejected block splits and its halves are tried again.
     * This counts the rejections, `dropped` counts what was actually given up
     * on, and the two are worth telling apart -- a map with rejections and no
     * drops has holes nowhere, only smaller facets than it might have had.
     */
    readonly unbounded: number;
    /** Single cells that produced no facet, and so are missing from the world. */
    readonly dropped: number;
}

/**
 * Build the convex facets of one patch.
 *
 * Returns no hulls for a patch that tessellates to nothing usable.
 */
export function patchToHulls(patch: ClipMapPatch): PatchFacets {
    const control: PatchVertex[] = [];
    for (let i = 0; i < patch.width * patch.height; i++) {
        control.push(
            controlVertex(
                patch.control[i * 3]!,
                patch.control[i * 3 + 1]!,
                patch.control[i * 3 + 2]!
            )
        );
    }

    let tess;
    try {
        tess = tessellatePatch(control, patch.width, patch.height, COLLISION_LEVEL);
    } catch {
        return { hulls: [], unbounded: 0, dropped: 0 };
    }

    const width = tess.width;
    const height = tess.height;
    if (width < 2 || height < 2) return { hulls: [], unbounded: 0, dropped: 0 };

    // Positions only, in a Float64Array: every dot product below is a comparison
    // against a tolerance rather than a Q3 trace decision, so unlike the `vec3_t`
    // storage elsewhere in `cm/` there is no reason to narrow these to 32 bits.
    const pos = new Float64Array(width * height * 3);
    for (let i = 0; i < tess.vertices.length; i++) {
        const v = tess.vertices[i]!;
        pos[i * 3] = v.x;
        pos[i * 3 + 1] = v.y;
        pos[i * 3 + 2] = v.z;
    }

    /*
     One plane per cell, oriented by the tessellation's own winding.

     `tessellatePatch` emits `(a, c, b)` for `a = (row, col)`, `b = a + 1`,
     `c = a + width`, so the outward normal is `cross(rowStep, colStep)` -- the
     side the surface is drawn from. What that decides is the *decomposition*:
     `isConvex` asks whether a block bulges past its own cell planes, so a dome
     stays one facet and a bowl splits into the strips that keep an archway
     open. It does not decide which side of the sheet is solid -- the shell
     straddles it, and `FACET_THICKNESS` says why.

     Newell over all four corners rather than one triangle's cross product: a
     tessellated quad is not planar in general, and one triangle's normal tilts
     with which diagonal it happened to use.
    */
    const cellsU = width - 1;
    const cellsV = height - 1;
    const cellNormal = new Float64Array(cellsU * cellsV * 3);
    const cellArea = new Float64Array(cellsU * cellsV);

    for (let v = 0; v < cellsV; v++) {
        for (let u = 0; u < cellsU; u++) {
            // Corners in ring order, so Newell's sum walks the boundary.
            const ring = [
                (v * width + u) * 3,
                (v * width + u + 1) * 3,
                ((v + 1) * width + u + 1) * 3,
                ((v + 1) * width + u) * 3,
            ];

            let nx = 0;
            let ny = 0;
            let nz = 0;
            for (let k = 0; k < 4; k++) {
                const a = ring[k]!;
                const b = ring[(k + 1) % 4]!;
                nx += (pos[a + 1]! - pos[b + 1]!) * (pos[a + 2]! + pos[b + 2]!);
                ny += (pos[a + 2]! - pos[b + 2]!) * (pos[a]! + pos[b]!);
                nz += (pos[a]! - pos[b]!) * (pos[a + 1]! + pos[b + 1]!);
            }

            /*
             Newell's ring above walks `(u,v) -> (u+1,v) -> (u+1,v+1) -> (u,v+1)`,
             which is `cross(colStep, rowStep)` -- the opposite of the
             tessellation's winding. Negated here rather than reordering the
             ring, so the ring stays in the order the corners are named in.
            */
            const len = Math.hypot(nx, ny, nz);
            const c = (v * cellsU + u) * 3;
            if (len < 1e-9) {
                // Degenerate cell -- the seam column of a closed cylinder, where
                // the first and last control points coincide. It contributes no
                // plane; its vertices still bound the block.
                cellNormal[c] = 0;
                cellNormal[c + 1] = 0;
                cellNormal[c + 2] = 0;
                cellArea[v * cellsU + u] = 0;
                continue;
            }

            cellNormal[c] = -nx / len;
            cellNormal[c + 1] = -ny / len;
            cellNormal[c + 2] = -nz / len;
            // Newell's magnitude is twice the polygon's area.
            cellArea[v * cellsU + u] = len * 0.5;
        }
    }


    const hulls: BrushHull[] = [];
    let unbounded = 0;
    let dropped = 0;

    const stack: Block[] = [{ u0: 0, v0: 0, u1: cellsU - 1, v1: cellsV - 1 }];

    while (stack.length > 0) {
        const block = stack.pop()!;
        const cells = (block.u1 - block.u0 + 1) * (block.v1 - block.v0 + 1);

        if (cells > 1 && !isConvex(block)) {
            split(block, stack);
            continue;
        }

        const hull = facet(block);
        if (hull !== null) {
            hulls.push(hull);
            continue;
        }

        /*
         A block that will not close. Splitting is worth one more try -- the
         usual cause is a cell so nearly degenerate that its border planes
         cancel -- but a single cell that still fails is dropped rather than
         recursed on forever.
        */
        if (cells > 1) split(block, stack);
        else dropped += 1;
    }

    return { hulls, unbounded, dropped };

    /** Greatest `dot(n, v)` over the block's vertices. */
    function supportOf(block: Block, nx: number, ny: number, nz: number): number {
        let best = -Infinity;
        for (let v = block.v0; v <= block.v1 + 1; v++) {
            for (let u = block.u0; u <= block.u1 + 1; u++) {
                const p = (v * width + u) * 3;
                const d = pos[p]! * nx + pos[p + 1]! * ny + pos[p + 2]! * nz;
                if (d > best) best = d;
            }
        }
        return best;
    }

    /**
     * Does the block stay behind every one of its own cell planes?
     *
     * This is the convexity test, and it is the whole reason an arch does not
     * end up as a filled-in archway. A cell's plane is anchored at the furthest
     * of that cell's *own* four corners, so a tessellated quad's own
     * non-planarity is not mistaken for the block bending the wrong way.
     */
    function isConvex(block: Block): boolean {
        for (let v = block.v0; v <= block.v1; v++) {
            for (let u = block.u0; u <= block.u1; u++) {
                const c = (v * cellsU + u) * 3;
                const nx = cellNormal[c]!;
                const ny = cellNormal[c + 1]!;
                const nz = cellNormal[c + 2]!;
                if (nx === 0 && ny === 0 && nz === 0) continue;

                let own = -Infinity;
                for (let dv = 0; dv <= 1; dv++) {
                    for (let du = 0; du <= 1; du++) {
                        const p = ((v + dv) * width + u + du) * 3;
                        const d = pos[p]! * nx + pos[p + 1]! * ny + pos[p + 2]! * nz;
                        if (d > own) own = d;
                    }
                }

                if (supportOf(block, nx, ny, nz) - own > CONVEX_EPSILON) return false;
            }
        }
        return true;
    }

    /** Halve the block along whichever axis has more cells. */
    function split(block: Block, out: Block[]): void {
        const du = block.u1 - block.u0;
        const dv = block.v1 - block.v0;

        if (du >= dv) {
            const mid = block.u0 + (du >> 1);
            out.push({ u0: block.u0, v0: block.v0, u1: mid, v1: block.v1 });
            out.push({ u0: mid + 1, v0: block.v0, u1: block.u1, v1: block.v1 });
        } else {
            const mid = block.v0 + (dv >> 1);
            out.push({ u0: block.u0, v0: block.v0, u1: block.u1, v1: mid });
            out.push({ u0: block.u0, v0: mid + 1, u1: block.u1, v1: block.v1 });
        }
    }

    /** Build one convex facet from a block, or `null` if it does not bound one. */
    function facet(block: Block): BrushHull | null {
        const planes: number[] = [];

        /** Add a supporting plane in direction `n`, deduplicated. */
        const addPlane = (nx: number, ny: number, nz: number, dist: number): void => {
            for (let i = 0; i < planes.length; i += 4) {
                const dot = planes[i]! * nx + planes[i + 1]! * ny + planes[i + 2]! * nz;
                if (dot > DEDUPE_DOT && Math.abs(planes[i + 3]! - dist) < DEDUPE_DIST) return;
            }
            planes.push(nx, ny, nz, dist);
        };

        /*
         The block's centroid, used only to decide which way a border plane
         faces. The mean of the vertices rather than the midpoint of the bounds:
         a block that curves has a bounds midpoint out in the empty space the
         curve encloses, and orienting against that flips the borders on exactly
         the blocks -- the strongly curved ones -- where getting it wrong turns
         a column into a hole.
        */
        let cx = 0;
        let cy = 0;
        let cz = 0;
        let n = 0;
        for (let v = block.v0; v <= block.v1 + 1; v++) {
            for (let u = block.u0; u <= block.u1 + 1; u++) {
                const p = (v * width + u) * 3;
                cx += pos[p]!;
                cy += pos[p + 1]!;
                cz += pos[p + 2]!;
                n += 1;
            }
        }
        cx /= n;
        cy /= n;
        cz /= n;

        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        let totalArea = 0;

        for (let v = block.v0; v <= block.v1; v++) {
            for (let u = block.u0; u <= block.u1; u++) {
                const c = (v * cellsU + u) * 3;
                const nx = cellNormal[c]!;
                const ny = cellNormal[c + 1]!;
                const nz = cellNormal[c + 2]!;
                if (nx === 0 && ny === 0 && nz === 0) continue;

                const area = cellArea[v * cellsU + u]!;
                sumX += nx * area;
                sumY += ny * area;
                sumZ += nz * area;
                totalArea += area;

                // Standing off the front by half the thickness; the closing
                // plane below stands off the back by the same.
                addPlane(nx, ny, nz, supportOf(block, nx, ny, nz) + FACET_STANDOFF);
            }
        }

        if (totalArea <= 0) return null;

        /*
         Border planes, one per boundary edge of the block's parameter
         rectangle: through the edge, perpendicular to the adjacent cell's
         surface, facing out of the block. `cm_patch.c` builds the same thing
         and needs it for the same reason -- the cell planes alone bound a prism
         that runs off to infinity sideways.
        */
        for (let v = block.v0; v <= block.v1; v++) {
            border(block, block.u0, v, block.u0, v + 1, block.u0, v, cx, cy, cz, addPlane);
            border(block, block.u1 + 1, v, block.u1 + 1, v + 1, block.u1, v, cx, cy, cz, addPlane);
        }
        for (let u = block.u0; u <= block.u1; u++) {
            border(block, u, block.v0, u + 1, block.v0, u, block.v0, cx, cy, cz, addPlane);
            border(block, u, block.v1 + 1, u + 1, block.v1 + 1, u, block.v1, cx, cy, cz, addPlane);
        }

        /*
         The closing plane, behind the surface. Placed at the block's own
         support in that direction *plus* the standoff -- the same figure the
         cell planes were pushed out by, which is what centres the shell -- so it
         sits behind every vertex of the surface and cannot shave real volume off
         a block that curves away from its own mean normal.
        */
        const meanLength = Math.hypot(sumX, sumY, sumZ) / totalArea;
        if (meanLength > CLOSED_NORMAL_EPSILON) {
            const inv = 1 / Math.hypot(sumX, sumY, sumZ);
            const bx = -sumX * inv;
            const by = -sumY * inv;
            const bz = -sumZ * inv;
            addPlane(bx, by, bz, supportOf(block, bx, by, bz) + FACET_STANDOFF);
        }

        const hull = hullFromPlanes(
            planes,
            planes.length / 4,
            -1,
            patch.contents,
            patch.surfaceFlags
        );
        if (hull === null) return null;

        /*
         `hullFromPlanes` starts every face as a quad a million units across and
         clips it down, so a plane set that fails to bound a volume comes back
         as that quad rather than as an error. A facet that escaped its own
         block is dropped: a million-unit invisible box in the middle of a level
         is not something to learn about from a bug report.
        */
        for (let a = 0; a < 3; a++) {
            let lo = Infinity;
            let hi = -Infinity;
            for (let v = block.v0; v <= block.v1 + 1; v++) {
                for (let u = block.u0; u <= block.u1 + 1; u++) {
                    const d = pos[(v * width + u) * 3 + a]!;
                    if (d < lo) lo = d;
                    if (d > hi) hi = d;
                }
            }
            if (hull.bounds[a]! < lo - ESCAPE_MARGIN || hull.bounds[a + 3]! > hi + ESCAPE_MARGIN) {
                unbounded += 1;
                return null;
            }
        }

        return hull;
    }

    /**
     * One border plane, through the grid edge `(eu0,ev0)-(eu1,ev1)`.
     *
     * `(cu, cv)` is the cell inside the block that the edge belongs to; its
     * normal is borrowed so the border stands perpendicular to the surface
     * rather than to the world.
     */
    function border(
        block: Block,
        eu0: number,
        ev0: number,
        eu1: number,
        ev1: number,
        cu: number,
        cv: number,
        cx: number,
        cy: number,
        cz: number,
        addPlane: (nx: number, ny: number, nz: number, dist: number) => void
    ): void {
        const a = (ev0 * width + eu0) * 3;
        const b = (ev1 * width + eu1) * 3;

        const tx = pos[b]! - pos[a]!;
        const ty = pos[b + 1]! - pos[a + 1]!;
        const tz = pos[b + 2]! - pos[a + 2]!;

        const c = (cv * cellsU + cu) * 3;

        let nx = ty * cellNormal[c + 2]! - tz * cellNormal[c + 1]!;
        let ny = tz * cellNormal[c]! - tx * cellNormal[c + 2]!;
        let nz = tx * cellNormal[c + 1]! - ty * cellNormal[c]!;

        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-9) return;

        nx /= len;
        ny /= len;
        nz /= len;

        // Point it away from the block, not into it.
        if (nx * cx + ny * cy + nz * cz > nx * pos[a]! + ny * pos[a + 1]! + nz * pos[a + 2]!) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }

        addPlane(nx, ny, nz, supportOf(block, nx, ny, nz));
    }
}

/**
 * Convert every patch in a surface range that matches `contentMask`.
 *
 * The range is the submodel's `firstSurface`/`numSurfaces`, for the same reason
 * `buildHulls` takes a brush range: a brush entity's patches belong to the
 * entity, and converting the whole lump into static bodies welds every door's
 * curved trim permanently into the world at its closed position.
 *
 * @param firstSurface first surface index, from the model lump.
 * @param numSurfaces how many, or `-1` for "to the end".
 */
export function buildPatchHulls(
    cm: ClipMap,
    contentMask: number,
    firstSurface = 0,
    numSurfaces = -1
): PatchHullSet {
    const t0 = performance.now();

    const hulls: BrushHull[] = [];
    let skipped = 0;
    let unbounded = 0;
    let dropped = 0;

    const end = numSurfaces < 0 ? Infinity : firstSurface + numSurfaces;

    for (const patch of cm.patches) {
        if (patch.surface < firstSurface || patch.surface >= end) continue;
        if ((patch.contents & contentMask) === 0) continue;

        const built = patchToHulls(patch);
        unbounded += built.unbounded;
        dropped += built.dropped;

        if (built.hulls.length === 0) {
            skipped += 1;
            continue;
        }

        for (const hull of built.hulls) hulls.push(hull);
    }

    return { hulls, skipped, unbounded, dropped, milliseconds: performance.now() - t0 };
}
