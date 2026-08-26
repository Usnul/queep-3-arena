/*
 * pointerLock.ts -- ask for the pointer, and mean it when it is refused.
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
 * Three places want the pointer back -- a click while playing, a click while
 * flying, and closing the menu -- and all three have the same two problems with
 * asking for it.
 *
 * **It is refused routinely, and not exceptionally.** No transient user
 * activation, a re-request too soon after an Escape, an embedding document that
 * does not allow it: all of them are a rejected promise, and none of them is
 * something the game can or should do anything about. The player clicks again
 * and it works.
 *
 * **`void promise` does not handle a rejection.** That is what the two older
 * call sites did, and it is why the console carried an "Uncaught (in promise)
 * WrongDocumentError" for every click in an environment where locking is not
 * allowed at all. `void` discards the value; the rejection is still unhandled.
 *
 * And the return type is not stable either: the method is specified to return a
 * `Promise<void>` and older engines return `undefined`, so `.catch` cannot be
 * called on the result directly. `Promise.resolve` normalises both.
 */

/**
 * Take the pointer lock if the browser will give it, and say nothing if not.
 *
 * @returns whether the request was granted. Nothing currently reads it -- the
 * HUD's "click to play" is what tells the player -- and it is returned rather
 * than swallowed because "did that work" is the only question a caller could
 * have, and the alternative is each of them re-deriving it from
 * `document.pointerLockElement` a frame later.
 */
export async function takePointerLock(element: HTMLElement): Promise<boolean> {
    try {
        await Promise.resolve(element.requestPointerLock());
        return true;
    } catch {
        return false;
    }
}
