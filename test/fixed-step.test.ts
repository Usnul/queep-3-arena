/*
 * fixed-step.test.ts -- the clock the game runs on, and the frame that runs it.
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
 * Phase 9 moved the game off `engine.ticker.onTick` and onto
 * `EntityManager`'s fixed step. Two properties came with that move and neither
 * had anything asserting it:
 *
 * - **The simulation no longer depends on the frame rate.** The same wall-clock
 *   time produces the same simulation whether it arrives as one long frame or
 *   twenty short ones. That is the whole point of a fixed step and it is exactly
 *   the kind of claim that quietly stops being true.
 *
 * - **One system throwing does not delete the rest of the frame.** The old
 *   arrangement had a hand-rolled guard for this, because meep's
 *   `Signal.dispatch` swallows a listener's exception into a `console.error` and
 *   the application was *one* listener holding the whole frame. `EntityManager`
 *   has always done this per system, and by name. The guard is gone; this is
 *   what says the engine's version is really there.
 *
 * The clock is asserted against a real `PlayerController` on real map collision,
 * because the millisecond arithmetic under test lives in the controller and a
 * test of a re-implementation would be a test of the re-implementation.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { System } from '@woosh/meep-engine/src/engine/ecs/System.js';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';
import { spawnPoints } from '../src/game/Spawns.ts';
import {
    PlayerController,
    type InputDevices,
    type PointerMoveHandler,
    type TransformLike,
    type WheelHandler,
} from '../src/client/PlayerController.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

interface Scene {
    entities: { classname?: string; _originQ3: number[] }[];
}

/* ------------------------------------------------------------------ *
 * The smallest input devices a controller will accept
 * ------------------------------------------------------------------ */

class Switch {
    is_down = false;
}

class Signal<H> {
    readonly handlers: H[] = [];

    add(handler: H): void {
        this.handlers.push(handler);
    }

    remove(handler: H): void {
        const at = this.handlers.indexOf(handler);
        if (at >= 0) this.handlers.splice(at, 1);
    }
}

class Devices implements InputDevices {
    readonly keys: Record<string, Switch> = {};

    readonly keyboard = {
        keys: this.keys,
        on: { down: new Signal<(event: KeyboardEvent) => void>() },
    };

    readonly pointer = {
        mouseButtonLeft: new Switch(),
        on: {
            move: new Signal<PointerMoveHandler>(),
            down: new Signal<(position: unknown, event: unknown) => void>(),
            wheel: new Signal<WheelHandler>(),
        },
    };
}

/** `Transform`, reduced to the two things `writeCamera` writes. */
const sink: TransformLike = {
    position: { set: () => {} },
    rotation: { _lookRotation: () => null },
};

let collision: { physics: HeadlessPhysics; spawn: number[] } | null = null;

async function world(): Promise<{ physics: HeadlessPhysics; spawn: number[] }> {
    if (collision !== null) return collision;

    const raw = readFileSync(join(BUILT, 'oa_dm1', 'collision.bsp'));
    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'oa_dm1')
    );
    const scene = JSON.parse(readFileSync(join(BUILT, 'oa_dm1', 'scene.json'), 'utf8')) as Scene;

    collision = {
        physics: await HeadlessPhysics.create(cm),
        spawn: spawnPoints(scene.entities).points[0]!._originQ3,
    };
    return collision;
}

/** `EntityManager.startup` is callback-style; every caller here wants a promise. */
async function started(em: EntityManager): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        em.startup(resolve, reject);
    });
}

/**
 * One player on the engine's fixed step, driven by whatever frame times a case
 * hands it -- which is the arrangement `main.ts` now ships.
 */
async function rig(solver: 'meep' | 'q3' = 'meep'): Promise<{
    em: EntityManager;
    player: PlayerController;
    /** Every value `ps.commandTime` took, one per fixed step. */
    stamps: number[];
}> {
    const { physics, spawn } = await world();

    const em = new EntityManager();
    em.attachDataset(new EntityComponentDataset());

    const player = new PlayerController(
        physics.cm,
        { requestPointerLock: () => Promise.resolve() } as unknown as HTMLElement,
        new Devices(),
        spawn,
        physics,
        solver === 'meep' ? physics : null
    );

    const stamps: number[] = [];

    class Driver extends System<never> {
        override fixedUpdate = (deltaSeconds: number): void => {
            player.update(deltaSeconds, sink);
            stamps.push(player.ps.commandTime);
        };
    }

    await em.addSystem(new Driver());
    await started(em);

    return { em, player, stamps };
}

describe('the fixed step', () => {
    it('advances the player on the engine step size, whatever the frame took', async () => {
        const { em, stamps } = await rig('q3');

        // Deliberately ragged, and none of them a whole number of steps.
        const frames = [0.004, 0.031, 0.0071, 0.019, 0.0505, 0.0012, 0.0233, 0.041];
        for (const dt of frames) em.update(dt);

        const step = em.fixedUpdateStepSize;
        const total = frames.reduce((a, b) => a + b, 0);

        // Every step that fitted in the elapsed time ran, and no more.
        expect(stamps.length).toBe(Math.floor(total / step));

        // `EntityManager` hands every one of them the same delta.
        expect(em.fixedStepTick).toBe(stamps.length);
    });

    it('reaches the same simulation whether the time arrives coarse or fine', async () => {
        const coarse = await rig();
        const fine = await rig();

        const step = coarse.em.fixedUpdateStepSize;

        // 90 steps' worth, delivered two ways. Neither call is allowed to be
        // long enough to hit the engine's catch-up budget, or the leftovers
        // differ for a reason that has nothing to do with the clock.
        const total = step * 90;

        for (let i = 0; i < 45; i++) coarse.em.update(total / 45);
        for (let i = 0; i < 180; i++) fine.em.update(total / 180);

        expect(coarse.stamps.length).toBe(90);
        expect(fine.stamps.length).toBe(90);

        // Not "close": the same integers, in the same order.
        expect(fine.stamps).toEqual(coarse.stamps);

        // And the same player, to the last bit of every axis.
        expect([...fine.player.ps.origin]).toEqual([...coarse.player.ps.origin]);
        expect([...fine.player.ps.velocity]).toEqual([...coarse.player.ps.velocity]);
    });

    it('spends whole milliseconds, and carries the remainder rather than rounding it', async () => {
        /*
         The ported solver, because `ps.commandTime` is the field `PmoveSingle`
         maintains and the shipping meep path (D-071) retired the function that
         writes it. The millisecond arithmetic under test is the controller's and
         is the same on both paths; this is the path that publishes the result.
        */
        const { em, stamps } = await rig('q3');

        for (let i = 0; i < 600; i++) em.update(em.fixedUpdateStepSize);

        expect(stamps.length).toBe(600);

        /*
         Q3's clock is integer milliseconds and the engine's step is 16.667 of
         them, so a step is 16 or 17 and never anything else. Rounding instead
         of carrying would make every step 17 -- which is what this used to do,
         and it is two percent of clock drift against the movers, for ever.
        */
        const spent = stamps.map((t, i) => t - (i === 0 ? 0 : stamps[i - 1]!));
        expect(new Set(spent.slice(1))).toEqual(new Set([16, 17]));

        const elapsed = stamps[599]! - stamps[0]!;
        expect(elapsed / 599).toBeCloseTo(em.fixedUpdateStepSize * 1000, 2);
    });
});

describe('a system that throws', () => {
    it('does not take the rest of the frame with it, and is named', async () => {
        const em = new EntityManager();
        em.attachDataset(new EntityComponentDataset());

        const ran: string[] = [];

        class BeforeSystem extends System<never> {
            override fixedUpdate = (): void => {
                ran.push('before');
            };
        }

        class UnhappySystem extends System<never> {
            override fixedUpdate = (): void => {
                ran.push('unhappy');
                throw new Error('the pickups stopped spinning');
            };
        }

        class AfterSystem extends System<never> {
            override fixedUpdate = (): void => {
                ran.push('after');
            };
        }

        await em.addSystem(new BeforeSystem());
        await em.addSystem(new UnhappySystem());
        await em.addSystem(new AfterSystem());
        await started(em);

        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        let reported: string;
        try {
            em.update(em.fixedUpdateStepSize);
            // Read before restoring: `mockRestore` clears the recorded calls.
            reported = errors.mock.calls.map((call) => call.map(String).join(' ')).join(' | ');
        } finally {
            errors.mockRestore();
        }

        // The phase that threw is the *only* one that lost its work.
        expect(ran).toEqual(['before', 'unhappy', 'after']);

        /*
         And the report names the system rather than the function. The
         arrangement this replaced could only say "Failed to dispatch handler"
         and point at the one listener that held the entire frame, which is why
         the port grew its own named-phase guard -- 41 lines doing what the
         engine already did per system. See D-086 and `app/systems.ts`.
        */
        expect(reported).toContain('UnhappySystem');
        expect(reported).toContain('fixedUpdate');
    });
});
