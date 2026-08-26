/*
 * Gauge.ts -- one resource: a name, a number, and a segmented bar.
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
 * The HUD draws three of these -- health, armour, ammo -- and they differ by a
 * word, a colour and where full is. So this is one class used three times rather
 * than three near-identical blocks, and the colour is not in here at all: it is
 * a `--queep-gauge-*` custom property that the modifier class sets, so adding a
 * fourth resource is a constructor call and four lines of SCSS.
 *
 * The bar is meep's `SegmentedResourceBarView`, and the number beside it is a
 * `LabelView` over the **same model**. One `ObservedInteger`, two views: they
 * cannot disagree about what the player's health is, which is the failure a
 * second copy of the value invites.
 */

import ObservedInteger from '@woosh/meep-engine/src/core/model/ObservedInteger.js';

import {
    EmptyView,
    LabelView,
    SegmentedResourceBarView,
    type ViewWithElement,
} from './meep.ts';

export interface GaugeOptions {
    /** The word over the bar. Upper-cased by the stylesheet, not here. */
    readonly label: string;
    /**
     * The BEM modifier, which is the whole of what makes this one different:
     * `.queep-gauge--health` is where its colour is.
     */
    readonly modifier: string;
    /** Where the bar is full. Also what its notch spacing is derived from. */
    readonly max: number;
}

export class Gauge {
    readonly root: ViewWithElement<HTMLElement>;

    /** What the bar fills to and the number reads. One model, both views. */
    private readonly current = new ObservedInteger(0);

    /** Where full is. Observed because the ammo bar's moves with the weapon. */
    private readonly maximum: ObservedInteger;

    constructor(options: GaugeOptions) {
        this.maximum = new ObservedInteger(options.max);

        /*
         A `LabelView` over a bare string for the name and over the model for
         the number. The first of those looks like overkill for text that never
         changes, and it is what stops the two from being different kinds of
         thing: both are views in the hierarchy, and neither is a `textContent`
         write reaching around it.
        */
        const head = EmptyView.group(
            [
                new LabelView(options.label, {
                    classList: ['queep-gauge__label'],
                    tag: 'span',
                }),
                new LabelView(this.current, {
                    classList: ['queep-gauge__value'],
                    tag: 'span',
                }),
            ],
            { classList: ['queep-gauge__head'], tag: 'div' }
        );

        /*
         `values` is an array because the bar can stack several resources into
         one track. One here: health and armour are two bars rather than two
         fills of one, because they are two pools with two ceilings -- stacking
         them would draw 100 armour as though it were 100 more health, which is
         the thing armour is not.
        */
        const bar = new SegmentedResourceBarView({
            values: [this.current],
            max: this.maximum,
            classList: ['queep-gauge__bar'],
        });

        this.root = EmptyView.group([head, bar], {
            classList: ['queep-gauge', `queep-gauge--${options.modifier}`],
            tag: 'div',
        });
    }

    /** Shown or not. The ammo gauge is hidden for a weapon with no count. */
    set visible(v: boolean) {
        this.root.visible = v;
    }

    /**
     * Write the value, and whether it should be alarming.
     *
     * Rounded because `ObservedInteger` asserts on anything that is not a whole
     * number and splash damage divides -- a 37.5-health player is a thrown
     * assertion in the middle of a fight, from a rocket that landed slightly
     * off. Not clamped: the number is Q3's own, and Q3 draws a dead player's
     * health as the negative it is. The bar clamps itself.
     *
     * Called every frame and unguarded, because both of these already are:
     * `ObservedInteger.set` compares before it signals, and `View.setClass` is
     * `classList.toggle` and documented idempotent. A `lastValue` field here
     * would be a second copy of the number this class exists to keep exactly one
     * of.
     */
    set(value: number, low: boolean): void {
        this.current.set(Math.round(value));
        this.root.setClass('is-low', low);
    }

    /**
     * Move where full is. The ammo bar does this on every weapon change.
     *
     * Floored at 1 rather than trusted: a max of zero is a divide by zero in the
     * view's own `updateFill`, and `updateSegments` walks `max / segment` steps
     * to lay the notches out.
     */
    setMax(max: number): void {
        this.maximum.set(Math.max(1, Math.round(max)));
    }
}
