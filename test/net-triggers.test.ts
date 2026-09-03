/*
 * net-triggers.test.ts -- teleporters, jump pads and lava, on a headless host.
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
 * `NETWORK_PLAN.md` step 6 asks for "teleporters and pads through
 * `SetClientViewAngle` and velocity writes on the host", and step 6's own
 * tracking line said it was blocked on GAP-041. It was not, and the reason it
 * looked blocked is worth stating because it will look blocked again to the
 * next reader:
 *
 * **A mover has to be solid and a trigger does not.** GAP-041 is about
 * `HeadlessPhysics` building BSP model 0 and nothing else, so the host has no
 * kinematic body for a `func_door` -- a door there blocks nobody and a plat
 * carries nobody. `MoverSystem.touch` is a box-overlap test against bounds the
 * BSP submodel table already carries, and a `trigger_teleport` never moves and
 * is never solid. So the trigger half needed no physics at all and has been
 * reachable since step 3.
 *
 * **The player is placed inside the trigger rather than walked into it.** There
 * is one teleporter on `oa_dm1` and eight jump pads on `am_thornish`, and
 * getting a scripted client to stand on a specific one depends on the
 * pathfinding, the spawn point and the map -- which is a fixture whose subject
 * appears when the AI cooperates, and this suite has been caught by that three
 * times (D-187). The trigger volume's own bounds come off the host, the origin
 * is written into the middle of it, and what is measured is what the host then
 * does. That is the whole of the mechanism under test; how a player gets there
 * is the movement code's business and is measured elsewhere.
 *
 * **And the origin is written into the replicated component, not into `ps`.**
 * The first version of this wrote `record.slot.ps.origin` and measured nothing:
 * a host frame is `stepSlot` (which is `load` from the components, step, `store`
 * back) and then `worldStep` and then `publish`, so a write to `ps` before the
 * frame is discarded by the `load` at the top of it. `record.state` is the
 * authority between frames; `ps` is scratch inside one. The same mistake read as
 * a teleporter landing 176 units off, pads that did not fire, and a hurt volume
 * that *healed* 24 -- the last being the replicated inventory being restored
 * over the test's own write.
 */

import { describe, expect, it } from 'vitest';

import { NetRig } from './net/rig.ts';
import type { Trigger } from '../src/game/Movers.ts';

/** `PM_CheckDuck`'s standing `mins[2]`: how far below the origin the feet are. */
const FEET = 24;

/**
 * Places inside a trigger a player could plausibly be standing, in order.
 *
 * **The centre is the obvious choice and it does not work**, which took three
 * runs to establish and is worth writing down. A trigger volume is a brush, and
 * where inside it a player can stand is a fact about the map's geometry, not
 * about the box: at the centre of a jump pad's volume the feet are 24 units
 * lower and often inside the world, and the solver spends the next frame
 * ejecting them -- measured at 59 to 64 units of drop and 30 sideways, every
 * frame, so the trigger pass (which runs *after* the movement) never saw the
 * player inside anything.
 *
 * Two candidates cover every trigger in the set and they are complementary,
 * which is the useful part: **feet just above the volume's floor** fires the
 * four thin pads on `am_thornish` and the teleporter and hurt volume on
 * `oa_dm1`, and **head near the volume's ceiling** fires the four thick pads,
 * whose floor is below the level's. Measured: 612 and 470 respectively, on the
 * first frame, against nothing at all from the other candidate.
 *
 * The order matters only for speed; a caller tries them until one fires.
 */
function standingSpots(trigger: Trigger): [number, number, number][] {
    const x = (trigger.mins[0] + trigger.maxs[0]) * 0.5;
    const y = (trigger.mins[1] + trigger.maxs[1]) * 0.5;
    return [
        [x, y, trigger.mins[2] + FEET + 1],
        [x, y, trigger.maxs[2] - FEET - 1],
    ];
}

/** The first of {@link standingSpots}, for a caller that only needs one. */
function standIn(trigger: Trigger): [number, number, number] {
    return standingSpots(trigger)[0]!;
}

/**
 * Hold a slot in one place for a frame, and step.
 *
 * The origin goes into the **replicated component**, because that is what
 * `stepSlot`'s `load` reads at the top of the frame; a write to `ps` before the
 * frame is discarded. Re-written each frame because the trigger pass runs after
 * the movement, so a player put somewhere they cannot stand is somewhere else
 * by the time the trigger looks.
 */
function holdAt(
    rig: NetRig,
    slotIndex: number,
    at: readonly number[],
    options: { zeroVelocity?: boolean } = {}
): void {
    const state = rig.host.slots[slotIndex]!.state;
    state.origin[0] = at[0]!;
    state.origin[1] = at[1]!;
    state.origin[2] = at[2]!;
    if (options.zeroVelocity !== false) {
        state.velocity[0] = 0;
        state.velocity[1] = 0;
        state.velocity[2] = 0;
    }
    rig.step(1);
}

describe('a teleporter on the host', () => {
    it('moves the client, turns it, and stops it dead', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 0,
            clients: 1,
            seed: 42,
            warmup: 40,
        });

        rig.step(30);

        const teleport = rig.host.movers.triggers.find((t) => t.kind === 'teleport');
        expect(teleport, 'oa_dm1 has no trigger_teleport, so this measured nothing').toBeDefined();

        /*
         Every destination the teleporter could have chosen, not one of them:
         `G_PickTarget` walks each entity whose `targetname` matches and picks
         **at random**, and `oa_dm1` has twenty-three `target_position`s. A test
         that named one would be asserting the draw.
        */
        const candidates = rig.host.movers.destinations.filter(
            (d) => d.targetname === teleport!.target
        );
        expect(candidates.length, "the teleporter's target does not exist").toBeGreaterThan(0);

        const client = rig.clients[0]!;
        const record = rig.host.slots[client.net.slotIndex]!;
        const state = record.state;

        // Stand the player in the teleporter, moving fast.
        const at = standIn(teleport!);
        state.origin[0] = at[0];
        state.origin[1] = at[1];
        state.origin[2] = at[2];
        state.velocity[0] = 300;
        state.velocity[1] = 0;
        state.velocity[2] = 0;

        const before = [...state.origin];
        const deltaBefore = state.deltaAngles[1]!;

        rig.step(1);

        const travelled = Math.hypot(
            state.origin[0]! - before[0]!,
            state.origin[1]! - before[1]!,
            state.origin[2]! - before[2]!
        );

        const landed = candidates.find(
            (d) =>
                Math.abs(state.origin[0]! - d.origin[0]) < 2 &&
                Math.abs(state.origin[1]! - d.origin[1]) < 2
        );

        // eslint-disable-next-line no-console
        console.log(
            `[net-triggers] teleport: ${travelled.toFixed(0)} units to ` +
                `[${[...state.origin].map((v) => v.toFixed(0)).join(', ')}] ` +
                `(${candidates.length} candidate destinations), ` +
                `delta_angles[1] ${deltaBefore} -> ${state.deltaAngles[1]}, ` +
                `speed ${Math.hypot(state.velocity[0]!, state.velocity[1]!).toFixed(1)}`
        );

        /*
         Landed on one of the marks, and not merely a long way from where it
         started -- "it moved a long way" is also what falling through the floor
         looks like. `TeleportPlayer` drops the player one unit clear of the
         mark, which is why z is a bound and x and y are the mark.
        */
        expect(landed, `no destination is at [${[...state.origin].join(', ')}]`).toBeDefined();
        expect(state.origin[2]).toBeGreaterThanOrEqual(landed!.origin[2]);

        /*
         Velocity zeroed. Q3 stops you dead rather than carrying momentum
         through, which is why you cannot rocket-jump into a teleporter and
         come out flying. One frame of gravity is allowed for: the trigger pass
         runs after the movement, so the zero is the last thing to happen this
         frame, but the *next* frame's step has already fallen by the time a
         reader looks.
        */
        expect(
            Math.hypot(state.velocity[0]!, state.velocity[1]!),
            'momentum survived the teleporter'
        ).toBeLessThan(1);

        /*
         And the client has been turned, which is the half a host cannot do by
         writing `viewangles`: the client owns its aim and overwrites it on the
         next command, so `SetClientViewAngle` writes the *difference* into
         `delta_angles` and `PM_UpdateViewAngles` adds it to everything after.
         `NetPlayerState` has carried the field since step 1 and nothing wrote
         it until now, so this is the assertion that says the field works.

         Asserted as "the view faces the mark" rather than "the delta changed",
         because a destination whose angle happens to match the command's
         current yaw legitimately needs no delta at all -- which is the case on
         `oa_dm1`, where both are zero.
        */
        expect(state.viewangles[1]).toBeCloseTo(landed!.angle, 0);
        expect(
            state.deltaAngles[1],
            'delta_angles is not the offset SetClientViewAngle would write'
        ).toBe((Math.round((landed!.angle * 65536) / 360) & 0xffff) - 0);

        // And it reaches the client, which is what makes it a networked feature.
        rig.step(8);
        const seen = client.net.ownSlot.state.origin;
        expect(
            Math.hypot(seen[0]! - state.origin[0]!, seen[1]! - state.origin[1]!),
            'the client never heard about the teleport'
        ).toBeLessThan(96);
    }, 120_000);
});

describe('a jump pad on the host', () => {
    it('launches the client along the vector AimAtTarget solved for', async () => {
        /*
         `am_thornish`, because it has eight `trigger_push` entities and
         `oa_dm1` has none -- and four of the eight target an `info_notnull`,
         which is the case D-139's `G_PickTarget` fix was about. So this is also
         the regression test for that: a pad whose `pushVelocity` is null does
         nothing at all, silently, which is exactly how it was reported.
        */
        const rig = await NetRig.create({
            map: 'am_thornish',
            bots: 0,
            clients: 1,
            seed: 42,
            warmup: 40,
        });

        rig.step(30);

        const pads = rig.host.movers.triggers.filter((t) => t.kind === 'push');
        expect(pads.length, 'am_thornish has no jump pads, so this measured nothing').toBe(8);

        // Every one of them solved for a launch vector, including the four that
        // aim at an `info_notnull`.
        for (const pad of pads) {
            expect(pad.pushVelocity, 'a jump pad has no launch vector').not.toBeNull();
        }

        const client = rig.clients[0]!;
        const record = rig.host.slots[client.net.slotIndex]!;
        const state = record.state;

        const launched: string[] = [];

        for (const pad of pads) {
            const want = pad.pushVelocity!;

            /*
             Both standing places, two frames each. See `standingSpots`: which
             one works is a fact about the pad's brush rather than about the
             trigger, and the four thick pads on this map want the other one
             from the four thin ones.
            */
            let fired = false;
            for (const at of standingSpots(pad)) {
                for (let n = 0; n < 2 && !fired; n++) {
                    holdAt(rig, client.net.slotIndex, at);
                    fired = Math.abs(state.velocity[2]! - want[2]) < 1;
                }
                if (fired) break;
            }

            launched.push(`${state.velocity[2]!.toFixed(0)}/${want[2].toFixed(0)}`);

            /*
             `BG_TouchJumpPad` **overwrites** velocity rather than adding to it,
             which is why a pad launches you the same way however fast you ran
             onto it. The trigger pass runs *after* the movement inside one host
             frame -- `stepSlot`, then `worldStep`, then `publish` -- so the
             published velocity is the pad's vector exactly, with no frame of
             gravity taken off it yet.
            */
            expect(fired, `a jump pad did not launch anybody standing on it`).toBe(true);
            expect(state.velocity[0], 'x of the launch').toBeCloseTo(want[0], 0);
            expect(state.velocity[1], 'y of the launch').toBeCloseTo(want[1], 0);
            expect(state.velocity[2], 'z of the launch').toBeCloseTo(want[2], 0);

            /*
             A pad's `wait` is half a second and `nextFire` is per trigger, so
             the next pad in the loop is a different trigger and fires on its
             own frame. Stepping between them is what keeps that true.
            */
            rig.step(20);
        }

        // eslint-disable-next-line no-console
        console.log(`[net-triggers] jump pads, published z / solved z: ${launched.join(', ')}`);
    }, 120_000);
});

describe('a hurt trigger on the host', () => {
    it('takes health off the client and tells it, so the view kicks', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 0,
            clients: 1,
            seed: 42,
            warmup: 40,
        });

        rig.step(30);

        const hurt = rig.host.movers.triggers.find((t) => t.kind === 'hurt');
        expect(hurt, 'oa_dm1 has no trigger_hurt, so this measured nothing').toBeDefined();

        const client = rig.clients[0]!;
        const record = rig.host.slots[client.net.slotIndex]!;
        const at = standIn(hurt!);

        /*
         Health pinned to 100 through the component, so the once-a-second bleed
         above 100 (D-170) cannot be mistaken for damage. The first version of
         this measured 1 health lost over ten frames and that 1 was the bleed:
         the trigger had not fired at all.
        */
        record.inventory.health = 100;
        const before = 100;
        let hits = 0;

        for (let n = 0; n < 12; n++) {
            const seen = client.hits.length;
            holdAt(rig, client.net.slotIndex, at);
            hits += client.hits.length - seen;
        }

        const lost = before - record.inventory.health;

        // eslint-disable-next-line no-console
        console.log(
            `[net-triggers] hurt: ${lost} health over 12 frames in the volume, ` +
                `${hits} hit events reached the client`
        );

        /*
         `trigger_hurt`'s wait is zero -- it fires every frame you are in it,
         which is what makes lava lava. Ten frames standing in it is ten hits of
         `dmg`, and the number is the map's rather than this test's.
        */
        expect(lost, 'the hurt trigger took no health').toBeGreaterThan(0);

        /*
         And the client is told, so it gets the view kick `EV_DAMAGE` gives you
         in Q3. Without this a player burning to death sees the health bar move
         and feels nothing, which reads as a bug in the health bar.
        */
        expect(hits, 'the client was never told it was being hurt').toBeGreaterThan(0);
    }, 120_000);
});
