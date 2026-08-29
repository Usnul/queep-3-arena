/*
 * bake-resolution.test.ts -- the two baked volumes are sampled fine enough to
 * tell one place from the place next to it.
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
 * A baked volume that is too coarse does not fail. It loads, it is the right
 * size, it lights and it rings -- it just answers with the room next door,
 * everywhere, and there is nothing downstream that can tell that from a level
 * whose rooms really are that alike. Both volumes here had a version of that
 * defect and neither reported it, so the two claims that replaced it are worth
 * holding down.
 *
 * **The acoustic spacing is measured against the player.** `PROBE_SPACING` is
 * the floor on the initial cover *and* the scale of the two thresholds that
 * decide whether a tunnel is measured at all (see its docblock), so it is the
 * one number that says how small a space this port can hear. Half a character
 * is the grade; four metres was two and a quarter characters.
 *
 * **The lightmap's grade is not the constant that looks like it.**
 * `LIGHTMAP_CELL_SIZE` is a stopping rule, and what comes out is the deepest
 * surviving node's probe pitch -- quantised, and shortened again by a memory
 * purge that happens after the fact. `brick4ProbeSpacing` is what the bake
 * reports instead of the constant, so what it measures is asserted here rather
 * than assumed at the call site.
 */

import { describe, expect, it } from 'vitest';

import { PROBE_SPACING } from '../src/client/Acoustics.ts';
import { CHARACTER_HEIGHT } from '../src/client/CharacterBody.ts';
import { brick4ProbeSpacing } from '../src/client/VolumetricLight.ts';

/** A cube node at `depth`, spanning `[x0, x0 + side]` on the axis that is read. */
function node(depth: number, x0: number, side: number, children?: unknown[]): never {
    return {
        depth,
        bounds: { x0, x1: x0 + side },
        children,
    } as never;
}

describe('the ruler both bakes are cut against', () => {
    it('is the standing player, 56 Q3 units', () => {
        expect(CHARACTER_HEIGHT).toBeCloseTo(1.75, 10);
    });
});

describe('acoustic probe spacing', () => {
    /*
     "About half a character" rather than "at most half": half of 1.75 m is
     0.875 and the constant is the round metre, which is 0.57 of a player. The
     bound is here to catch a slide back toward the four metres this replaced --
     2.3 characters, and a tunnel measured in the hall outside it -- not to
     defend the third decimal place of a judgement.
    */
    it('is about half a character, so a tunnel is its own room', () => {
        expect(PROBE_SPACING / CHARACTER_HEIGHT).toBeLessThanOrEqual(0.6);
    });

    /*
     The other half of the trade, and the reason this is a range rather than a
     minimum: the cover's cost is cubic in the reciprocal of this, and the SDF
     grid it is placed on caps at 256 voxels per axis at `PROBE_SPACING / 2` --
     which `am_thornish` already touches at one metre. Going finer stops buying
     resolution on the largest map and starts costing it.
    */
    it('is not so fine that the SDF grid stops resolving it', () => {
        expect(PROBE_SPACING).toBeGreaterThanOrEqual(0.75);
    });
});

describe('what a brick4 tree was actually sampled at', () => {
    it('is a node side over three, because a node carries a 4x4x4 probe grid', () => {
        expect(brick4ProbeSpacing(node(0, 0, 81))).toBeCloseTo(27, 10);
    });

    it('is the deepest node, not the root', () => {
        const leaf = node(2, 0, 9);
        const middle = node(1, 0, 27, [leaf]);

        expect(brick4ProbeSpacing(node(0, 0, 81, [middle]))).toBeCloseTo(3, 10);
    });

    /*
     `Brick4IntermediateNode.children` is a sparse `new Array(27)`, so most
     slots of most nodes are holes. Walking one as if it held a node is the
     obvious way to write this and throws on the first real tree.
    */
    it('steps over the unexpanded slots, which are most of them', () => {
        const children = new Array(27);
        children[13] = node(1, 0, 27, undefined);

        expect(brick4ProbeSpacing(node(0, 0, 81, children))).toBeCloseTo(9, 10);
    });

    /*
     A purge leaves the tree lopsided rather than uniform -- `purge_partial_depths`
     deletes a whole depth, but the *branch* that reached it is not the branch
     the walk happens to visit first. Taking the first leaf instead of the
     deepest one would report a coarser grade than the map holds.
    */
    it('finds the deepest branch whichever order the walk reaches it in', () => {
        const shallow = node(1, 0, 27, undefined);
        const deep = node(1, 27, 27, [node(2, 27, 9, [node(3, 27, 3)])]);

        expect(brick4ProbeSpacing(node(0, 0, 81, [shallow, deep]))).toBeCloseTo(1, 10);
    });
});
