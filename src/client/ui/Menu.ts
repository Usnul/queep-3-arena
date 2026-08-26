/*
 * Menu.ts -- the in-game menu, and the shell the later screens go into.
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
 * A page list down the left, the active page on the right, and Escape to get in
 * and out. The pages are `SettingsPage` values rather than subclasses, so
 * whatever goes in next -- a map picker, a match setup screen -- arrives as data
 * and this file does not change (D-097).
 *
 * The shell has three jobs beyond drawing itself, and each of them is a thing
 * that goes wrong if it is left out:
 *
 *   - **Take the input.** meep's `PointerDevice` and `KeyboardDevice` listen on
 *     the view stack, which is this menu's own ancestor, so every click on a
 *     slider also reaches the game -- and `PlayerController` answers a click by
 *     asking for the pointer lock back, which shuts the menu the frame it
 *     opened. Every pointer and key event is stopped at the menu's root while it
 *     is open. Stopped rather than flagged, because the device also calls
 *     `preventDefault()` on `pointermove`, and a cancelled `pointermove` is a
 *     range input that will not drag.
 *
 *   - **Hand the input back.** The controls inside the menu are focusable, so
 *     closing it while one of them has focus leaves focus on an element that has
 *     just become invisible. The browser moves it to `<body>`, the keyboard
 *     device is listening on the view stack, and the game silently stops
 *     answering the keyboard. `onClosed` is where the application puts it back.
 *
 *   - **Stay out of the way of what it is adjusting.** The game keeps running
 *     and the arena stays visible behind a translucent scrim, because a graphics
 *     setting is judged by what it does to the picture. That is also Q3's own
 *     behaviour -- its menu never paused a deathmatch.
 */

import { button, settingRow, type Row } from './controls.ts';
import { EmptyView, LabelView, type View, type ViewWithElement } from './meep.ts';
import type { Setting, Settings, SettingsPage } from './Settings.ts';

import ObservedString from '@woosh/meep-engine/src/core/model/ObservedString.js';

/** Which gesture closed the menu. See {@link MenuOptions.onClosed}. */
export type CloseCause = 'key' | 'pointer';

export interface MenuOptions {
    readonly settings: Settings;
    /** Shown in the header. Defaults to the game's name. */
    readonly title?: string;
    /** Raised after the menu has opened. Release the pointer lock here. */
    readonly onOpened?: () => void;
    /**
     * Raised after it has closed. Take the pointer lock and focus back here.
     *
     * `cause` is which gesture shut it, and the difference matters for exactly
     * one thing: `requestPointerLock` needs a transient user activation, and
     * Escape does not grant one -- the specification excludes it, because it is
     * the key that *ends* things. Asking for the lock back after an Escape gets
     * a rejected promise and a console error every time; asking after a click on
     * Resume works. So the application is told which it was and can ask only
     * when the answer will be yes.
     */
    readonly onClosed?: (cause: CloseCause) => void;
}

/** Pointer and keyboard events the game must not see while the menu is open. */
const SWALLOWED = [
    'pointerdown',
    'pointerup',
    'pointermove',
    'wheel',
    'keydown',
    'keyup',
] as const;

export class Menu {
    readonly root: ViewWithElement<HTMLElement>;

    private readonly settings: Settings;
    private readonly options: MenuOptions;

    private readonly panel: ViewWithElement<HTMLElement>;
    private readonly rows: Row[] = [];
    private readonly pages = new Map<string, View>();
    private readonly navItems = new Map<string, View>();

    private opened = false;
    private attached = false;

    constructor(options: MenuOptions) {
        this.options = options;
        this.settings = options.settings;

        const first = options.settings.pages[0];
        if (first === undefined) throw new Error('a menu needs at least one page');

        const scrim = new EmptyView({ classList: ['queep-menu__scrim'], tag: 'div' });
        scrim.el.addEventListener('click', () => this.close('pointer'));

        const nav = EmptyView.group(
            options.settings.pages.map((page) => this.buildNavItem(page)),
            { classList: ['queep-menu__nav'], tag: 'div' }
        );

        const pages = EmptyView.group(
            options.settings.pages.map((page) => this.buildPage(page)),
            { classList: ['queep-menu__page'], tag: 'div' }
        );

        /*
         `tabindex="-1"` so the panel can be focused without being in the tab
         order itself. Opening with Escape otherwise leaves focus on `<body>`,
         and the first Tab walks the whole document before it reaches a control
         -- with a modal on screen, which is what `aria-modal` claims is not the
         case.
        */
        const panel = EmptyView.group(
            [
                this.buildHeader(options.title ?? 'queep-3-arena'),
                EmptyView.group([nav, pages], { classList: ['queep-menu__body'], tag: 'div' }),
                this.buildFooter(),
            ],
            { classList: ['queep-menu__panel'], tag: 'div', attr: { tabindex: '-1' } }
        );

        this.panel = panel;

        this.root = EmptyView.group([scrim, panel], {
            classList: ['queep-menu'],
            tag: 'div',
            attr: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Menu' },
        });

        for (const type of SWALLOWED) {
            this.root.el.addEventListener(type, stopIfOpen(this));
        }

        this.showPage(first.id);
    }

    get isOpen(): boolean {
        return this.opened;
    }

    /**
     * Add to the engine's view stack and start listening for Escape.
     *
     * The whole tree is built and linked once, here, rather than on each open.
     * That is not only cheaper: `DropDownSelectionView` creates its `<option>`
     * elements in `link()` and destroys them in `unlink()`, so a menu that was
     * added and removed would rebuild every drop-down each time and lose the
     * selection with it.
     */
    link(viewStack: { addChild(v: View): void }): void {
        if (this.attached) return;
        this.attached = true;

        viewStack.addChild(this.root);
        document.addEventListener('keydown', this.onKeyDown, true);

        // Now that the tree is linked, the drop-downs have their options and can
        // be told which one is selected.
        this.syncAll();
    }

    detach(): void {
        if (!this.attached) return;
        this.attached = false;

        document.removeEventListener('keydown', this.onKeyDown, true);
    }

    open(): void {
        if (this.opened) return;
        this.opened = true;

        this.syncAll();
        this.root.addClass('is-open');

        /*
         After the class, not before: the panel is `visibility: hidden` while the
         menu is shut, and an invisible element cannot take focus.
        */
        this.panel.el.focus();

        this.options.onOpened?.();
    }

    close(cause: CloseCause = 'pointer'): void {
        if (!this.opened) return;
        this.opened = false;

        this.root.removeClass('is-open');
        this.options.onClosed?.(cause);
    }

    toggle(cause: CloseCause = 'pointer'): void {
        if (this.opened) this.close(cause);
        else this.open();
    }

    /** Re-read every row from the model. Cheap, and never wrong. */
    syncAll(): void {
        for (const row of this.rows) row.sync();
    }

    /**
     * Escape, in the capture phase and on the document.
     *
     * Capture rather than bubble because the menu's own root stops key events
     * from reaching anything above it, and the document is above it -- a bubble
     * listener here would open the menu and never close it.
     *
     * On the document rather than on the view stack because the view stack is
     * only focused while the game has the keyboard. Escape has to work in both
     * directions, and the direction that matters is the one where a control
     * inside the menu is focused.
     */
    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (event.code !== 'Escape' && event.key !== 'Escape') return;

        event.preventDefault();
        this.toggle('key');
    };

    private buildHeader(title: string): View {
        return EmptyView.group(
            [
                new LabelView(new ObservedString(title), {
                    classList: ['queep-menu__title'],
                }),
                new LabelView(new ObservedString('esc'), {
                    classList: ['queep-menu__hint'],
                }),
            ],
            { classList: ['queep-menu__header'], tag: 'div' }
        );
    }

    private buildFooter(): View {
        return EmptyView.group(
            [
                button('Reset to defaults', () => {
                    this.settings.reset();
                    this.syncAll();
                }),
                button('Resume', () => this.close('pointer'), { primary: true }),
            ],
            { classList: ['queep-menu__footer'], tag: 'div' }
        );
    }

    private buildNavItem(page: SettingsPage): View {
        const item = button(page.title, () => this.showPage(page.id), {
            classList: ['queep-menu__nav-item'],
        });

        this.navItems.set(page.id, item);

        return item;
    }

    /**
     * One page: its settings, grouped into sections in the order the sections
     * first appear.
     *
     * Order comes from the settings array rather than from a separate list of
     * section names, so adding a setting cannot put it in a section that does
     * not exist and reordering the array is the whole of reordering the page.
     */
    private buildPage(page: SettingsPage): View {
        const sections = new Map<string, Setting[]>();

        for (const setting of page.settings) {
            const existing = sections.get(setting.section);
            if (existing === undefined) sections.set(setting.section, [setting]);
            else existing.push(setting);
        }

        const blocks: View[] = [];

        for (const [name, settings] of sections) {
            const rows = settings.map((setting) => {
                const row = settingRow(this.settings, setting);
                this.rows.push(row);
                return row.view;
            });

            blocks.push(
                EmptyView.group(
                    [
                        new LabelView(new ObservedString(name), {
                            classList: ['queep-menu__section-title'],
                        }),
                        ...rows,
                    ],
                    { classList: ['queep-menu__section'], tag: 'div' }
                )
            );
        }

        if (page.note !== undefined) {
            blocks.push(
                new LabelView(new ObservedString(page.note), {
                    classList: ['queep-menu__note'],
                })
            );
        }

        const view = EmptyView.group(blocks, {
            classList: ['queep-menu__page-body'],
            tag: 'div',
        });

        this.pages.set(page.id, view);

        return view;
    }

    private showPage(id: string): void {
        for (const [pageId, view] of this.pages) view.visible = pageId === id;
        for (const [pageId, item] of this.navItems) item.setClass('is-active', pageId === id);
    }
}

/**
 * Swallow an event, but only while the menu is open.
 *
 * The root spans the viewport and takes no pointer events while closed, so the
 * pointer half of this is belt and braces; the keyboard half is not, because a
 * key event goes to whatever has focus regardless of what is on top of it.
 */
function stopIfOpen(menu: Menu): (event: Event) => void {
    return (event: Event): void => {
        if (menu.isOpen) event.stopPropagation();
    };
}
