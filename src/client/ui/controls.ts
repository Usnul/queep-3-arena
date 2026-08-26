/*
 * controls.ts -- one settings row, in each of the three shapes a setting takes.
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
 * Every row is label, optional note, control -- and the control is bound in both
 * directions. Writing into it writes the setting; the setting changing from
 * anywhere else redraws it. Both directions are needed even with one screen:
 * "reset to defaults" moves twenty settings without touching a single control,
 * and a value loaded out of storage arrives after the row has already been
 * built.
 *
 * Two of the three controls are meep's -- `CheckboxView` binding an
 * `ObservedBoolean`, `DropDownSelectionView` binding a `List`. The third is not,
 * because meep's UI kit has no slider (GAP-025): it ships a checkbox, a
 * drop-down, a colour picker, a progress bar and a radial menu, and no bounded
 * numeric input at all. A field of view and a resolution scale are both a range
 * with a step, so this file builds one out of `EmptyView` and an
 * `<input type="range">` -- which is what `CheckboxView` does with an
 * `<input type="checkbox">`, one layer down from where it should have to be.
 */

import ObservedBoolean from '@woosh/meep-engine/src/core/model/ObservedBoolean.js';
import ObservedString from '@woosh/meep-engine/src/core/model/ObservedString.js';
import List from '@woosh/meep-engine/src/core/collection/list/List.js';

import {
    ButtonView,
    CheckboxView,
    DropDownSelectionView,
    EmptyView,
    LabelView,
    type View,
} from './meep.ts';
import type {
    ChoiceOption,
    ChoiceSetting,
    Setting,
    Settings,
    SliderSetting,
    ToggleSetting,
} from './Settings.ts';

/**
 * A built row, and the way to make it agree with the model again.
 *
 * `sync` is idempotent and cheap, so the menu calls it on every row each time it
 * opens rather than tracking which ones went stale while it was shut.
 */
export interface Row {
    readonly view: View;
    readonly sync: () => void;
}

/**
 * A push button.
 *
 * `tag: 'button'` rather than `ButtonView`'s default `div`, so the thing that
 * looks like a button is focusable, reachable by Tab, and pressed by Space and
 * Enter without any of that having to be written here.
 */
export function button(
    label: string,
    action: () => void,
    options: { primary?: boolean; classList?: readonly string[] } = {}
): View {
    const classList = [...(options.classList ?? ['queep-button'])];
    if (options.primary === true) classList.push('queep-button--primary');

    return new ButtonView({ tag: 'button', action, name: label, classList });
}

/** One settings row, dispatched on the setting's shape. */
export function settingRow(settings: Settings, setting: Setting): Row {
    const control =
        setting.kind === 'slider'
            ? sliderControl(settings, setting)
            : setting.kind === 'toggle'
              ? toggleControl(settings, setting)
              : choiceControl(settings, setting);

    const text: View[] = [
        new LabelView(new ObservedString(setting.label), { classList: ['queep-setting__label'] }),
    ];

    if (setting.note !== undefined) {
        text.push(
            new LabelView(new ObservedString(setting.note), { classList: ['queep-setting__note'] })
        );
    }

    const view = EmptyView.group(
        [
            EmptyView.group(text, { classList: ['queep-setting__text'], tag: 'div' }),
            EmptyView.group(control.views, { classList: ['queep-setting__control'], tag: 'div' }),
        ],
        { classList: ['queep-setting'], tag: 'div' }
    );

    const sync = (): void => {
        /*
         `enabled` is the setting's own answer to "would writing me do anything
         right now" -- a frame-rate target with adaptive resolution switched off
         is the case that exists. The row is dimmed and the control is disabled
         rather than removed: a control that vanishes reads as a bug, and one
         that greys out explains itself.
        */
        const enabled = setting.enabled === undefined || setting.enabled();
        view.setClass('is-inert', !enabled);
        control.setEnabled(enabled);
        control.sync();
    };

    /*
     Redraw when *any* value moves, wherever it moved from: another row, the
     reset button, or a value arriving out of storage after the menu was built.

     Any, and not just this row's own id, because `enabled` is a question about
     the page rather than about the row -- the frame-rate target greys out when
     the adaptive-resolution toggle beside it is switched off, and a row that
     only listened for itself would go on looking live until something else
     happened to redraw it. `sync` is a handful of DOM writes and a settings
     change is a person moving a control, so the cost of being right here is not
     measurable.
    */
    settings.onChanged.add(sync);

    sync();

    return { view, sync };
}

interface Control {
    readonly views: View[];
    readonly sync: () => void;
    readonly setEnabled: (enabled: boolean) => void;
}

/**
 * A range input and its readout.
 *
 * `input` rather than `change`, so a graphics setting is judged while the slider
 * is being dragged rather than after it is let go -- which is the whole reason
 * the menu leaves the arena visible behind it.
 */
function sliderControl(settings: Settings, setting: SliderSetting): Control {
    const input = new EmptyView({
        tag: 'input',
        classList: ['queep-control__slider'],
        attr: {
            type: 'range',
            min: String(setting.min),
            max: String(setting.max),
            step: String(setting.step),
            'aria-label': setting.label,
        },
    });

    const element = input.el as HTMLInputElement;
    const readout = new ObservedString('');

    element.addEventListener('input', () => {
        settings.set(setting.id, element.valueAsNumber);
    });

    return {
        views: [
            input,
            new LabelView(readout, { classList: ['queep-control__value'] }),
        ],
        sync: (): void => {
            const value = settings.get(setting.id) as number;

            /*
             Only when it differs. Writing `value` on every sync would be
             harmless were the two always in step, and they are not: this fires
             from the `input` handler's own `onChanged`, mid-drag, and assigning
             to a range input's value while the pointer is capturing it snaps the
             thumb back under the cursor.
            */
            if (element.valueAsNumber !== value) element.value = String(value);

            readout.set(setting.format(value));
        },
        setEnabled: (enabled: boolean): void => {
            element.disabled = !enabled;
        },
    };
}

/** meep's checkbox, styled into a switch. */
function toggleControl(settings: Settings, setting: ToggleSetting): Control {
    const model = new ObservedBoolean(settings.get(setting.id) as boolean);

    const view = new CheckboxView({ value: model });
    view.addClass('queep-control__toggle');
    view.el.setAttribute('aria-label', setting.label);

    /*
     One-directional here and one-directional in `sync`, and the two do not
     chase each other: `ObservedBoolean.set` only raises `onChanged` when the
     value actually moves, and `Settings.set` returns without announcing
     anything when it does not.
    */
    model.onChanged.add((value: boolean) => {
        settings.set(setting.id, value);
    });

    return {
        views: [view],
        sync: (): void => {
            model.set(settings.get(setting.id) as boolean);
        },
        setEnabled: (enabled: boolean): void => {
            view.el.disabled = !enabled;
        },
    };
}

/** meep's drop-down, over the setting's own option list. */
function choiceControl(settings: Settings, setting: ChoiceSetting): Control {
    /*
     `DropDownSelectionView` keys its options by object identity -- it builds a
     `Map<T, string>` of value to generated id, and `setSelectedValue` is
     `model.indexOf(v)`. So the array handed to the `List` has to be the array
     the selection is looked up in, and both have to outlive the view.
    */
    const options = [...setting.options];
    const model: List<ChoiceOption> = new List(options);

    const view = new DropDownSelectionView(model, {
        transform: (option: ChoiceOption) => option.label,
        changeListener: (option: ChoiceOption) => {
            /*
             `getValueById` returns `null` when the mapping has no entry for the
             id, which cannot happen for an option the view itself created --
             but it is a `null` the types do not admit to, so it is checked
             rather than trusted.
            */
            if (option !== null && option !== undefined) settings.set(setting.id, option.value);
        },
    });

    view.addClass('queep-control__select');
    view.el.setAttribute('aria-label', setting.label);

    return {
        views: [view],
        sync: (): void => {
            const value = settings.get(setting.id);
            const option = options.find((o) => o.value === value);

            /*
             `setSelectedValue` writes `selectedIndex`, which needs the
             `<option>` elements to exist -- and they are created in the view's
             `link()`, not in its constructor. Every caller of `sync` runs after
             the menu has been added to the view stack, so they do; guarding on
             the element count says that out loud rather than leaving it to
             whoever moves the call next.
            */
            if (option !== undefined && view.el.options.length === options.length) {
                view.setSelectedValue(option);
            }
        },
        setEnabled: (enabled: boolean): void => {
            view.el.disabled = !enabled;
        },
    };
}
