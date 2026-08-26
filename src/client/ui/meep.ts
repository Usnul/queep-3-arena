/*
 * meep.ts -- meep's view classes, with their constructor types corrected.
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
 * Six of meep's view classes take a destructured options bag, and the generated
 * `.d.ts` gets the type of that bag wrong for every one of them. The failures
 * are all the same shape -- the declaration generator read the JSDoc's several
 * `@param` tags as several parameters, and typed the single real one as the
 * first of them -- and they all produce the same result: correct calls are
 * rejected at compile time.
 *
 *   EmptyView                `constructor({classList, el, tag, tagNamespace, css, attr} = {})`
 *                            emits as `constructor(_?: string[])`.
 *   ButtonView               `constructor({tag, action, name, icon, classList, css})`
 *                            emits as `constructor(_?: string)`.
 *   DropDownSelectionView    `constructor(model, {transform, changeListener} = {})`
 *                            emits its second parameter as `(arg0: T) => string`,
 *                            the type of the `transform` *inside* it.
 *   LabelView                declares `size` and `css` **required**, because
 *                            those two are the ones its JSDoc forgot to mark
 *                            `[optional]`; every field defaults at runtime.
 *   CheckboxView             `constructor({value, invert})` emits as
 *                            `constructor(_: ObservedBoolean)`, so the bag is
 *                            rejected and a bare `ObservedBoolean` is accepted
 *                            -- the one case where the wrong type also compiles
 *                            the wrong call.
 *   SegmentedResourceBarView `constructor({values, max, classList})` emits as
 *                            `constructor(_: (Vector1|ObservedInteger)[])`, the
 *                            type of `values` alone.
 *
 * Per the brief, these are corrected with narrow local types rather than papered
 * over with `any`: each class keeps its real signature at every call site, the
 * correction is stated once instead of in each file that draws something, and
 * the whole set is recorded in GAP-001.
 *
 * Nothing here changes behaviour. Every one of these calls works at runtime
 * today; what does not work is compiling them.
 */

import View from '@woosh/meep-engine/src/view/View.js';
import EmptyViewImpl from '@woosh/meep-engine/src/view/elements/EmptyView.js';
import LabelViewImpl from '@woosh/meep-engine/src/view/common/LabelView.js';
import ButtonViewImpl from '@woosh/meep-engine/src/view/elements/button/ButtonView.js';
import { CheckboxView as CheckboxViewImpl } from '@woosh/meep-engine/src/view/elements/CheckboxView.js';
import DropDownSelectionViewImpl from '@woosh/meep-engine/src/view/elements/DropDownSelectionView.js';
import { SegmentedResourceBarView as SegmentedResourceBarViewImpl }
    from '@woosh/meep-engine/src/view/elements/progress/segmented/SegmentedResourceBarView.js';

export type { View };

export interface EmptyViewOptions {
    classList?: string[];
    el?: Element;
    tag?: string;
    tagNamespace?: string;
    css?: Record<string, string>;
    attr?: Record<string, string>;
}

export interface LabelViewOptions {
    classList?: string[];
    tag?: string;
    transform?: unknown;
    format?: unknown;
    size?: unknown;
    css?: unknown;
}

export interface ButtonViewOptions {
    tag?: string;
    action: (event: Event) => unknown;
    name?: string | object;
    icon?: string;
    classList?: string[];
    css?: Record<string, string>;
}

/**
 * The DOM element a view owns.
 *
 * `View.el` is declared `Element | NodeDescription | null`, which is honest --
 * a view built from a description has not made an element yet -- and useless to
 * a caller that has just constructed one of these six and knows it has. The
 * per-class element types below are the ones each class's own `.d.ts` states.
 */
export type ViewWithElement<T extends Element> = View & { el: T };

type EmptyViewCtor = new (options?: EmptyViewOptions) => ViewWithElement<HTMLElement>;
type LabelViewCtor = new (model: unknown, options?: LabelViewOptions) => ViewWithElement<HTMLElement>;
type ButtonViewCtor = new (options: ButtonViewOptions) => ViewWithElement<HTMLElement>;

/**
 * A number with a change signal: `Vector1`, `ObservedInteger`, a `Stat`.
 *
 * Structural rather than a union of the classes, because that is all any of the
 * views below actually require of one -- `getValue()` for the number and
 * `onChanged` to `bindSignal` against -- and naming the classes would drag their
 * generated declarations in behind them.
 */
export interface ObservedNumber {
    getValue(): number;
    readonly onChanged: unknown;
}

/**
 * `SegmentedResourceBarView`: a fill, a ghost behind it, and notches over it.
 *
 * `values` is an array because the bar can stack several into one track; the
 * ghost is their total, which is what makes a drop visible after the fill has
 * already moved. `max` is where the track is full, and it also decides the notch
 * spacing -- `RESOURCE_BAR_SEGMENTS` picks the largest of 2/10/40/200/1000 that
 * fits, so the notches are a *quantity* rather than a percentage.
 *
 * It ships no stylesheet: the element and its four children (`.fill-container`,
 * `.ghost`, `.notch-overlay`, `.highlights`) have classes and no rules anywhere
 * in the engine, so the port's own `hud.scss` is what makes it a bar at all.
 */
type SegmentedResourceBarCtor = new (options: {
    values: ObservedNumber[];
    max?: ObservedNumber;
    classList?: string[];
}) => ViewWithElement<HTMLDivElement>;

/** `CheckboxView` binds an `ObservedBoolean`; `invert` flips the sense of it. */
type CheckboxViewCtor = new (options: {
    value: { getValue(): boolean; set(v: boolean): unknown; onChanged: unknown };
    invert?: boolean;
}) => ViewWithElement<HTMLInputElement>;

/** A `List<T>`, as far as `DropDownSelectionView` uses one. */
export interface ListLike<T> {
    readonly data: T[];
    add(value: T): void;
    indexOf(value: T): number;
    forEach(visitor: (value: T, index: number) => void, thisArg?: unknown): void;
}

export interface DropDownView<T> extends ViewWithElement<HTMLSelectElement> {
    getSelectedValue(): T;
    setSelectedValue(value: T): void;
}

type DropDownCtor = new <T>(
    model: ListLike<T>,
    options?: {
        transform?: (value: T) => string;
        changeListener?: (value: T) => void;
    }
) => DropDownView<T>;

export const EmptyView = EmptyViewImpl as unknown as EmptyViewCtor & {
    group(elements: View[], options?: EmptyViewOptions): ViewWithElement<HTMLElement>;
};
export const LabelView = LabelViewImpl as unknown as LabelViewCtor;
export const ButtonView = ButtonViewImpl as unknown as ButtonViewCtor;
export const CheckboxView = CheckboxViewImpl as unknown as CheckboxViewCtor;
export const DropDownSelectionView = DropDownSelectionViewImpl as unknown as DropDownCtor;
export const SegmentedResourceBarView =
    SegmentedResourceBarViewImpl as unknown as SegmentedResourceBarCtor;
