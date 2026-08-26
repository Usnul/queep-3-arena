/*
 * Settings.ts -- what a setting is, without a screen to show it on.
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
 * A setting is four things at once -- a value, a description of how to show it,
 * an effect on something in the engine, and an entry in persistent storage --
 * and only one of those needs a DOM. So the value, the description and the
 * effect live here, in a file that runs in Node, and `MenuView` is handed the
 * result.
 *
 * That split is what makes the part most likely to be wrong testable. The screen
 * is a screen; the arithmetic that decides a stored `"1e9"` is not a legal field
 * of view is `coerce`, and it can be checked without a browser.
 *
 * Persistence goes through meep's own `Option` / `OptionGroup`, which serialise
 * to JSON and attach to the engine's `Storage`. It does **not** go through
 * `engine.options`, and that is not a preference -- see D-096 and GAP-026: the
 * engine attaches its root group to storage inside `start()`, binds the save
 * hook by walking the options that exist at that moment, and never walks again.
 * Anything an application adds afterwards -- which is everything an application
 * adds -- is neither loaded nor saved, silently. A group of our own, attached
 * ourselves once it is populated, is the same machinery used in an order that
 * works.
 */

import { Option } from '@woosh/meep-engine/src/engine/options/Option.js';
import { OptionGroup } from '@woosh/meep-engine/src/engine/options/OptionGroup.js';
import Signal from '@woosh/meep-engine/src/core/events/signal/Signal.js';

/** Everything a setting's value is allowed to be, and hence to be stored as. */
export type SettingValue = number | boolean | string;

interface SettingCommon {
    /**
     * Stable, and the storage key. Renaming one drops the stored value back to
     * its default rather than reading somebody else's -- which is the safe
     * direction, and the reason ids are not derived from labels.
     */
    readonly id: string;
    readonly label: string;
    /** One line under the label. For what the setting costs, not what it is. */
    readonly note?: string;
    /** Which section of the page it appears under. */
    readonly section: string;
    /**
     * Whether writing this setting would currently do anything.
     *
     * A frame-rate target with adaptive resolution switched off is the case that
     * exists: the value is still held and still saved, and nothing reads it. The
     * row greys out rather than disappearing -- see `settingRow`.
     *
     * Absent means always.
     */
    readonly enabled?: () => boolean;
}

export interface SliderSetting extends SettingCommon {
    readonly kind: 'slider';
    readonly initial: number;
    readonly min: number;
    readonly max: number;
    readonly step: number;
    /** The readout beside the slider. Carries the unit. */
    readonly format: (value: number) => string;
    readonly apply: (value: number) => void;
}

export interface ToggleSetting extends SettingCommon {
    readonly kind: 'toggle';
    readonly initial: boolean;
    readonly apply: (value: boolean) => void;
}

export interface ChoiceOption {
    readonly value: number | string;
    readonly label: string;
}

export interface ChoiceSetting extends SettingCommon {
    readonly kind: 'choice';
    readonly initial: number | string;
    readonly options: readonly ChoiceOption[];
    readonly apply: (value: number | string) => void;
}

export type Setting = SliderSetting | ToggleSetting | ChoiceSetting;

/**
 * A page of the menu: a title, and the settings on it in the order they appear.
 *
 * Pages are data rather than classes because that is what makes the menu
 * extensible in the direction it is going to be extended. A map picker and a
 * match setup screen are two more entries in this array with two more `build`
 * functions behind them; neither needs the shell to change. See D-097.
 */
export interface SettingsPage {
    readonly id: string;
    readonly title: string;
    readonly settings: readonly Setting[];
    /** Shown under the last section. For what the page as a whole cannot do. */
    readonly note?: string;
}

/**
 * Storage, and only the two calls `OptionGroup.attachToStorage` makes of it.
 *
 * Declared structurally rather than imported: meep's `Storage` is a JSDoc
 * interface with no exported type, and this is the whole of what is used.
 */
export interface SettingsStorage {
    load(key: string, resolve: (v: unknown) => void, reject: (e: unknown) => void): void;
    store(
        key: string,
        value: string,
        resolve: () => void,
        reject: (e: unknown) => void,
        progress: () => void
    ): void;
}

/**
 * Bring a stored or typed-in value into range, or reject it.
 *
 * Every value that reaches a setting has been outside this process: a number
 * from an `<input type="range">`, a string from a `<select>`, JSON out of
 * IndexedDB that a previous build wrote and this one no longer understands.
 * `Option.fromJSON` hands whatever it loaded straight to `write` with no
 * checking at all, so this is the only place a bad value is stopped.
 *
 * Returns `null` for "not a value this setting can take", which the caller
 * treats as "keep what you have" rather than as an error: a settings screen that
 * refuses to open because storage has one stale key in it is worse than one that
 * ignores the key.
 */
export function coerce(setting: Setting, raw: unknown): SettingValue | null {
    switch (setting.kind) {
        case 'toggle':
            return typeof raw === 'boolean' ? raw : null;

        case 'choice': {
            for (const option of setting.options) {
                if (option.value === raw) return option.value;
            }

            /*
             A number that arrived as a string, which is what a `<select>` value
             always is -- `event.target.value` has no type. Compared by string on
             both sides rather than by parsing, so `"04"` does not quietly become
             crosshair 4 and `"1e1"` does not become 10.
            */
            if (typeof raw === 'string' || typeof raw === 'number') {
                const text = String(raw);
                for (const option of setting.options) {
                    if (String(option.value) === text) return option.value;
                }
            }

            return null;
        }

        case 'slider': {
            /*
             An allow-list of two types rather than a deny-list of the values
             that misbehave, because the deny-list is not writable. `Number` is
             far more willing than it looks: `Number(null)`, `Number('')` and
             `Number([])` are all **0**, `Number([7])` is 7, and `Number(true)`
             is 1 -- so four kinds of nothing and a boolean all arrive as a
             perfectly finite number and clamp to whatever `min` happens to be.
             A `<input type="range">` produces a number and JSON produces a
             number or a string; nothing else is a value this can be.
            */
            if (typeof raw !== 'number' && typeof raw !== 'string') return null;
            if (typeof raw === 'string' && raw.trim() === '') return null;

            const value = Number(raw);

            // Rejects NaN and both infinities.
            if (!Number.isFinite(value)) return null;

            return quantize(setting, value);
        }
    }
}

/**
 * Clamp to the range, then snap to the step from `min`.
 *
 * Clamping first and snapping second, because snapping a wildly out-of-range
 * number first would compute a step index in the millions before throwing it
 * away. Clamped again afterwards: `min + round(...) * step` can land one step
 * past `max` when the range is not a whole number of steps.
 */
function quantize(setting: SliderSetting, value: number): number {
    const bounded = Math.min(setting.max, Math.max(setting.min, value));

    if (!(setting.step > 0)) return bounded;

    const steps = Math.round((bounded - setting.min) / setting.step);
    const snapped = setting.min + steps * setting.step;

    /*
     Binary floating point does not hold 0.05, so 0.7 + 5 * 0.05 is
     0.9500000000000001 and the readout beside the slider says so. Six places is
     past any step this port uses and well short of where the rounding itself
     would introduce error.
    */
    const clean = Number(snapped.toFixed(6));

    return Math.min(setting.max, Math.max(setting.min, clean));
}

/**
 * The live value of every setting, and the machinery that keeps it live.
 *
 * One instance for the whole application. It owns the values, pushes them at
 * whatever they configure, and holds the `OptionGroup` that persists them.
 */
export class Settings {
    readonly pages: readonly SettingsPage[];

    /** Fires `(id, value)` after a value has changed and been applied. */
    readonly onChanged = new Signal();

    private readonly byId = new Map<string, Setting>();
    private readonly values = new Map<string, SettingValue>();

    /**
     * meep's own options tree, one `Option` per setting, flat.
     *
     * Flat rather than a group per page: the group path is the storage path, so
     * nesting would mean that moving a setting from the graphics page to a
     * future display page silently forgets its stored value. A page is a
     * presentational grouping and has no business in the save file.
     */
    readonly group = new OptionGroup('queep');

    /** The `Option` behind each setting, so a change can be announced to it. */
    private readonly options = new Map<string, Option>();

    constructor(pages: readonly SettingsPage[]) {
        this.pages = pages;

        for (const page of pages) {
            for (const setting of page.settings) {
                if (this.byId.has(setting.id)) {
                    throw new Error(`duplicate setting id '${setting.id}'`);
                }

                this.byId.set(setting.id, setting);
                this.values.set(setting.id, setting.initial);

                /*
                 `settings` is dat.GUI's shape, and it is filled in properly
                 rather than left empty because meep's own `OptionsView` reads
                 exactly these three keys to decide what control to build. The
                 port draws its own menu, so nothing reads them today; getting
                 them right costs three lines and means the engine's debug view
                 of these settings works if it is ever wanted.
                */
                const meta: Record<string, unknown> = { transient: false };
                if (setting.kind === 'slider') {
                    meta['min'] = setting.min;
                    meta['max'] = setting.max;
                } else if (setting.kind === 'choice') {
                    meta['values'] = setting.options.map((o) => o.value);
                }

                /*
                 The write goes to `store`, not to `set`, and the difference is
                 the whole reason both exist. `Option.write` is a wrapper that
                 raises `on.written` once it returns, and `attachToStorage`
                 hangs the save hook off that signal -- so a write arriving
                 *through* the option (which is how a loaded value arrives) is
                 already going to be announced, and announcing it again here
                 would save twice for one change.
                */
                const option = new Option(
                    setting.id,
                    () => this.values.get(setting.id) as SettingValue,
                    (v: unknown) => this.store(setting, v),
                    meta
                );

                this.options.set(setting.id, option);
                this.group.addChild(option);
            }
        }
    }

    definition(id: string): Setting {
        const setting = this.byId.get(id);
        if (setting === undefined) throw new Error(`no such setting '${id}'`);
        return setting;
    }

    get(id: string): SettingValue {
        const value = this.values.get(id);
        if (value === undefined) throw new Error(`no such setting '${id}'`);
        return value;
    }

    /**
     * Write a value, if it is one this setting can take. The way in from
     * anywhere that is not storage.
     *
     * Returns whether anything moved -- `false` for a rejected value and for one
     * that was already there, which are the same thing to a caller and different
     * only in `coerce`.
     */
    set(id: string, raw: unknown): boolean {
        const setting = this.byId.get(id);
        if (setting === undefined) throw new Error(`no such setting '${id}'`);

        if (!this.store(setting, raw)) return false;

        /*
         Tell the option, so that whatever `attachToStorage` hung off
         `on.written` runs. Without this line a value dragged in the menu would
         apply, redraw and be forgotten on reload -- storage is only ever written
         from that signal.
        */
        this.options.get(id)?.on.written.send1(this.values.get(id));

        return true;
    }

    /** Push every current value at whatever it configures. */
    applyAll(): void {
        for (const setting of this.byId.values()) {
            this.applyOne(setting, this.values.get(setting.id) as SettingValue);
        }
    }

    /**
     * Back to the shipped defaults, applied and announced one at a time.
     *
     * Per setting rather than wholesale so that a listener watching one id --
     * the menu row that has to redraw, the storage hook that has to save -- sees
     * the same event it would see if the value had been dragged there.
     */
    reset(): void {
        for (const setting of this.byId.values()) {
            this.set(setting.id, setting.initial);
        }
    }

    /**
     * Load from storage, and save on every change from here on.
     *
     * Failure is logged and swallowed: storage is a private browsing window
     * away from being unavailable, and a settings screen that cannot remember
     * is still a settings screen. The engine's own attach does the same.
     */
    async attach(storage: SettingsStorage, key = 'queep-3-arena.settings'): Promise<void> {
        try {
            await this.group.attachToStorage(key, storage as never);
        } catch (e) {
            console.warn('[queep] settings could not be attached to storage', e);
        }
    }

    /**
     * Coerce, keep, apply and announce -- everything a write does except tell
     * the `Option`, which is the one step that differs between the two ways in.
     *
     * Returns whether anything moved, which is what stops the round trip:
     * `apply` writes to the engine, the engine may signal, a listener may write
     * back, and a write that always announced itself would turn that into a
     * loop.
     */
    private store(setting: Setting, raw: unknown): boolean {
        const value = coerce(setting, raw);
        if (value === null) return false;
        if (this.values.get(setting.id) === value) return false;

        this.values.set(setting.id, value);
        this.applyOne(setting, value);
        this.onChanged.send2(setting.id, value);

        return true;
    }

    private applyOne(setting: Setting, value: SettingValue): void {
        try {
            switch (setting.kind) {
                case 'slider':
                    setting.apply(value as number);
                    break;
                case 'toggle':
                    setting.apply(value as boolean);
                    break;
                case 'choice':
                    setting.apply(value as number | string);
                    break;
            }
        } catch (e) {
            /*
             One bad setting must not take the rest of the screen with it.
             `applyAll` runs the whole list at startup, and a throw halfway
             through it would leave the second half of the graphics settings
             unapplied with nothing on screen to say so.
            */
            console.error(`[queep] setting '${setting.id}' failed to apply`, e);
        }
    }
}
