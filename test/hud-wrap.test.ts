/*
 * hud-wrap.test.ts -- the HUD's turned corners, as arithmetic rather than as a look.
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
 * The status bar's two corners are turned toward the player under a shared
 * perspective, and the whole of that is three constants and one mixin. What
 * makes it worth a test is that a transform does not move a layout box: flex
 * puts the ammo readout where its box is, the wrap then draws it somewhere else,
 * and **nothing in CSS relates the two**. Every rule that has to hold between a
 * turned cluster and the things around it is arithmetic over `_tokens.scss`,
 * asserted here or asserted nowhere.
 *
 * Three of them, and all three have failed at least once in this port (D-152):
 *
 *   - the weapon rack sits above the ammo cluster and has to clear the height
 *     the shear lifts the cluster's outer end to,
 *   - the cluster has to be pushed back at least as far as the turn brings it
 *     forward, or the projection magnifies it off the edge of a wide screen,
 *   - and the column between the `perspective` and the cluster has to pass the
 *     3D context through, or the turn is projected by no eye at all.
 *
 * The numbers come out of the shipped stylesheet rather than out of a copy of
 * it: the cluster's width is read from the compiled `.queep-gauge`,
 * `.queep-hud__weapon` and `.queep-hud__cluster` rules, so widening the ammo
 * gauge without revisiting the wrap fails here rather than on somebody's screen.
 *
 * This is a geometry test and not a rendering one. That a 24° turn *looks* like
 * a wrapped surface is a judgement no assertion makes; what it can do is refuse
 * the arrangements that are wrong before anyone looks.
 */

import { describe, expect, it } from 'vitest';
import { compile, compileString } from 'sass';

const STYLE_DIR = 'src/style';

/** One flat rule out of compiled CSS: its selector, and what it declares. */
interface Rule {
    readonly selector: string;
    readonly at: string | null;
    readonly decls: Readonly<Record<string, string>>;
}

/**
 * Compiled CSS, as rules.
 *
 * Enough of a parser for output Dart Sass wrote and no more: rules do not nest
 * in it, so one pass tracking brace depth is the whole job. At-rules are kept
 * rather than flattened away because `hud.scss`'s compact layout lives inside a
 * `@container` and is a second cluster width to check.
 */
function rulesOf(source: string): Rule[] {
    const out: Rule[] = [];
    const atStack: string[] = [];

    // The stylesheets are mostly prose, and a `/* */` run in front of a selector
    // is otherwise part of it. Blunt, and safe on this input: nothing in
    // `src/style` puts those two characters inside a string.
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');

    let prelude = '';

    for (let i = 0; i < css.length; i++) {
        const c = css[i]!;

        if (c === '{') {
            const head = prelude.trim();
            prelude = '';

            if (head.startsWith('@')) {
                atStack.push(head);
                continue;
            }

            // A plain rule: everything to the matching brace is its body, and
            // there is nothing nested inside it to account for.
            const end = css.indexOf('}', i);
            const decls: Record<string, string> = {};

            for (const decl of css.slice(i + 1, end).split(';')) {
                const at = decl.indexOf(':');
                if (at < 0) continue;
                decls[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
            }

            out.push({ selector: head, at: atStack.at(-1) ?? null, decls });
            i = end;
            continue;
        }

        if (c === '}') {
            atStack.pop();
            prelude = '';
            continue;
        }

        // A statement at-rule -- `@charset`, `@import` -- ends without a block,
        // and what it leaves behind would otherwise be read as part of the next
        // selector.
        if (c === ';') {
            prelude = '';
            continue;
        }

        prelude += c;
    }

    return out;
}

/** The one rule with this selector, at the top level or inside an at-rule. */
function rule(rules: readonly Rule[], selector: string, inAtRule: boolean): Rule {
    const found = rules.filter(
        (r) => r.selector === selector && (r.at !== null) === inAtRule
    );

    expect(found, `${selector}${inAtRule ? ' (inside an at-rule)' : ''}`).toHaveLength(1);

    return found[0]!;
}

/** `12px` as 12. Fails loudly on anything that is not a plain pixel length. */
function px(value: string): number {
    expect(value, `"${value}" is a pixel length`).toMatch(/^-?[\d.]+px$/);
    return Number.parseFloat(value);
}

/** `24deg` as radians, which is what `Math.sin` wants. */
function rad(value: string): number {
    expect(value, `"${value}" is an angle in degrees`).toMatch(/^-?[\d.]+deg$/);
    return (Number.parseFloat(value) * Math.PI) / 180;
}

/**
 * The wrap's own constants, out of `_tokens.scss` rather than out of this file.
 *
 * A probe stylesheet rather than a parse of the Sass source: the tokens are
 * `!default` and could be overridden, and what the HUD is compiled against is
 * what the assertions below have to be about.
 */
const tokens = (() => {
    const css = compileString(
        `@use 'tokens' as *;
         a {
           --angle: #{$hud-wrap-angle};
           --shear: #{$hud-wrap-shear};
           --depth: #{$hud-wrap-depth};
           --lift: #{$hud-wrap-lift};
         }`,
        { loadPaths: [STYLE_DIR] }
    ).css;

    const probe = rule(rulesOf(css), 'a', false).decls;

    return {
        angle: rad(probe['--angle']!),
        shear: rad(probe['--shear']!),
        depth: px(probe['--depth']!),
        lift: px(probe['--lift']!),
    };
})();

const hud = rulesOf(compile(`${STYLE_DIR}/hud.scss`, { loadPaths: [STYLE_DIR] }).css);

/**
 * How wide a cluster is, at full size and in the compact layout.
 *
 * `.queep-hud__cluster` is a flex row of the ammo gauge and the weapon icon,
 * with its own padding either side -- so its width is those four numbers and
 * they are all in the stylesheet. The right-hand corner is the wider of the two
 * clusters, and therefore the one every constant below is sized from: the
 * left-hand one is a *column* of two gauges, so it is a gauge wide and the ammo
 * corner is a gauge plus an icon.
 */
function clusterWidths(): number[] {
    const cluster = rule(hud, '.queep-hud__cluster', false).decls;

    // `padding: 12px 16px` -- the second number is the one either side.
    const padding = cluster['padding']!.split(/\s+/);
    expect(padding, 'the cluster pads on two axes').toHaveLength(2);

    const side = px(padding[1]!);
    const gap = px(cluster['gap']!);

    const widths: number[] = [];

    for (const compact of [false, true]) {
        const gauge = px(rule(hud, '.queep-gauge', compact).decls['width']!);
        const icon = px(rule(hud, '.queep-hud__weapon', compact).decls['width']!);

        widths.push(side + gauge + gap + icon + side);
    }

    return widths;
}

describe('the HUD wrap', () => {
    const widths = clusterWidths();
    const widest = Math.max(...widths);

    it('has a compact layout that is narrower than the full one', () => {
        // Everything below is sized from the widest cluster, which is only the
        // safe bound for the other one while this holds.
        expect(widths[0]).toBeGreaterThan(widths[1]!);
    });

    it('pushes a cluster back at least as far as the turn brings it forward', () => {
        // `$hud-wrap-depth`: a turn about the inner edge swings the outer end
        // toward the viewer, where the perspective magnifies it -- and about a
        // vanishing point, so the throw grows with the screen. Landing the outer
        // end at or behind the screen plane is what makes that impossible at any
        // width, and it is `width * sin(angle)` of depth.
        expect(tokens.depth).toBeGreaterThanOrEqual(widest * Math.sin(tokens.angle));
    });

    it('sizes the lift from the shear alone, at the widest cluster', () => {
        // With the outer end on the screen plane the projection there is a scale
        // of one, so what leaves the layout box is the shear: `x * tan(shear)`,
        // at the largest `x` a cluster has.
        const lift = widest * Math.tan(tokens.shear);

        expect(tokens.lift).toBeGreaterThanOrEqual(lift);
        // And is that number rounded up, rather than a comfortable guess: a lift
        // that is merely large enough stops recording what it is the size of.
        expect(tokens.lift).toBeLessThan(lift + 1);
    });

    it('holds the weapon rack clear of where the cluster is drawn', () => {
        // The rack is the row above the ammo readout inside the same column.
        // Flex spaces the two by their layout boxes; the cluster's outer end is
        // not in its box, and `gap` is where that is paid for. Strictly greater,
        // because clearing the lift exactly is a rack resting on the readout.
        const gap = px(rule(hud, '.queep-hud__corner', false).decls['gap']!);

        expect(gap).toBeGreaterThan(tokens.lift);
    });

    it('passes the shared perspective through the corner column', () => {
        // `perspective` is declared once, on `.queep-hud`, so that both corners
        // turn about one vanishing point. The right-hand cluster is a
        // *grandchild* of it, and a flat wrapper in between ends the 3D context
        // -- leaving that corner an affine squash where the other is a
        // perspective turn. Two shapes, one claimed surface.
        expect(rule(hud, '.queep-hud__corner', false).decls['transform-style']).toBe(
            'preserve-3d'
        );
    });
});
