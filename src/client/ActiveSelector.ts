/*
 * ActiveSelector.ts -- a selector that keeps asking.
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
 * meep's `SelectorBehavior` is the textbook one: it remembers which child it
 * settled on and ticks *that* child until it fails. That is correct for a
 * selector and wrong for the root of an agent, and the difference is the whole
 * reason this file exists.
 *
 * A plain selector over [Fight, Travel, Plan] does not mean "fight if you can,
 * otherwise travel". It means "decide once, then commit". Once `Travel` reports
 * `Running` the selector never looks at the fight branch again -- so a bot walks
 * its whole route past an enemy in plain sight, and only reconsiders when the
 * route runs out. And once `Fight` is entered, the guard in front of it has
 * already succeeded and its enclosing `Sequence` has moved its cursor past it,
 * so the guard is never asked again either: the bot fights forever, at a corner
 * the enemy left thirty rounds ago. Both of those were live in this port, and
 * the second is exactly the "keeps firing until the ammunition is dry" report
 * that D-162 was opened for.
 *
 * The fix is the composite the literature already has a name for. "The Behavior
 * Tree Starter Kit" -- which meep's own `Behavior` docblock cites -- calls it
 * `ActiveSelector`: each tick it starts again from the highest-priority child,
 * and if a higher-priority child is willing to run it *aborts* the lower one.
 * That is what makes a behaviour tree reactive, as opposed to a plan.
 *
 * Aborting is the part with the bookkeeping, and it is why this is a class
 * rather than a loop at the call site: the child that loses its slot has to be
 * `finalize`d, and the child that takes it has to be `initialize`d, exactly
 * once each. meep's `Behavior` has no lazy initialize -- BTSK's C++ ticks
 * through `Behavior::tick`, which calls `onInitialize` when the status is
 * `Invalid` -- so the state machine is here instead.
 *
 * What this does *not* do is the other half of BTSK's abort machinery: there are
 * no decorators and no parallel here, so "which children may abort which" is not
 * a question the port has to answer. Priority order is the whole policy.
 */

import { Behavior } from '@woosh/meep-engine/src/engine/intelligence/behavior/Behavior.js';
import { BehaviorStatus } from '@woosh/meep-engine/src/engine/intelligence/behavior/BehaviorStatus.js';

export class ActiveSelectorBehavior<CTX> extends Behavior<CTX> {
    private readonly children: readonly Behavior<CTX>[];

    /**
     * The child that was left running by the previous tick, or null.
     *
     * "Left running" and not "current": inside `tick` there is a window where
     * this still names the previous frame's choice while a higher-priority child
     * is being tried, and telling those apart is the only thing that makes the
     * abort land in the right order.
     */
    private running: Behavior<CTX> | null = null;

    constructor(children: readonly Behavior<CTX>[]) {
        super();
        this.children = children;
    }

    /** Constructor alias, spelled like meep's own composites. */
    static from<CTX>(children: readonly Behavior<CTX>[]): ActiveSelectorBehavior<CTX> {
        return new ActiveSelectorBehavior(children);
    }

    override initialize(context?: CTX): void {
        /*
         Children are *not* initialized here, unlike `SelectorBehavior`, which
         initializes its first child eagerly. Which child runs is decided by the
         tick, and initializing one that the tick then walks straight past would
         pair an `initialize` with no `finalize`.
        */
        this.running = null;
        super.initialize(context);
    }

    override tick(timeDelta: number): number {
        /*
         The child the previous tick left running, until it is either continued
         or aborted. Cleared the moment either happens, because the one thing
         this class must not do is `finalize` a child twice -- and a running
         child that fails on its own turn has already been finalized by the time
         a later child claims the slot.
        */
        let stale = this.running;

        for (const child of this.children) {
            /*
             A child that was not running last tick is starting now. One that was
             is continued, which is what lets `Travel` keep a path across frames.
            */
            if (child !== stale) child.initialize(this.context as CTX);

            const status = child.tick(timeDelta);

            if (status === BehaviorStatus.Failed) {
                child.finalize();
                if (child === stale) stale = null;
                continue;
            }

            // A higher-priority child took the slot: the old one is aborted.
            if (stale !== null && stale !== child) stale.finalize();

            if (status === BehaviorStatus.Running) {
                this.running = child;
                return BehaviorStatus.Running;
            }

            child.finalize();
            this.running = null;
            return status;
        }

        this.running = null;
        return BehaviorStatus.Failed;
    }

    override finalize(): void {
        if (this.running !== null) {
            this.running.finalize();
            this.running = null;
        }
        super.finalize();
    }
}
