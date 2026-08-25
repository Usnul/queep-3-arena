/*
 * meepmove.test.ts -- does Q3's motor still feel like Q3 on meep's solver?
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * The brief made `bg_pmove` fidelity non-negotiable and the maintainer has since
 * reversed that: port Q3 in spirit, not in body (D-071). So the oracle is gone
 * as an acceptance criterion for the shipping movement path -- there is no
 * ground truth for "movement that feels like Q3 but resolves collision meep's
 * way", and a bit-exact test would be testing the thing that was deliberately
 * given up.
 *
 * What replaces it is behavioural, and each assertion names the property of Q3
 * movement it is protecting. These are the things a player would notice going
 * missing; the exact numbers are not.
 *
 * The ported `bg_pmove` is still in the tree and still bit-exact against the C
 * (`pmove.diff.test.ts`, `cm-trace.diff.test.ts`), so where a number here wants
 * a reference, there is one.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';
import { MeepMove, PlayerMovement, createMoveState, type MoveCommand, type MoveState } from '../src/client/MeepMove.ts';
import { spawnPoints } from '../src/game/Spawns.ts';
import { createPmoveHost } from '../src/game/PmoveHost.ts';
import { Pmove as runPmove } from '../src/q3/pmove/pmove.ts';
import { FORWARDMOVE, RIGHTMOVE, UPMOVE } from '../src/q3/pmove/types.ts';
import * as C from '../src/q3/pmove/constants.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

/** Q3's server tick. The mover takes a variable step; this keeps runs comparable. */
const TICK = 1 / 125;

interface Scene {
    entities: { classname?: string; _originQ3: number[] }[];
}

function world(mapName: string): { physics: HeadlessPhysics; spawns: number[][] } {
    const raw = readFileSync(join(BUILT, mapName, 'collision.bsp'));
    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), mapName)
    );
    const scene = JSON.parse(readFileSync(join(BUILT, mapName, 'scene.json'), 'utf8')) as Scene;

    return {
        physics: new HeadlessPhysics(cm),
        spawns: spawnPoints(scene.entities).points.map((e) => e._originQ3),
    };
}

function command(over: Partial<MoveCommand> = {}): MoveCommand {
    return { forward: 0, right: 0, up: 0, pitch: 0, yaw: 0, crouch: false, ...over };
}

/** Run `frames` ticks, returning the state and the peak horizontal speed seen. */
function run(
    move: MeepMove,
    state: MoveState,
    frames: number,
    cmdFor: (frame: number) => MoveCommand
): { peakSpeed: number; landings: number; airFrames: number } {
    let peakSpeed = 0;
    let landings = 0;
    let airFrames = 0;

    for (let f = 0; f < frames; f++) {
        const result = move.step(state, cmdFor(f), TICK);
        const speed = Math.hypot(state.velocity[0]!, state.velocity[1]!);
        if (speed > peakSpeed) peakSpeed = speed;
        if (result.landed) landings += 1;
        if (!state.grounded) airFrames += 1;
    }

    return { peakSpeed, landings, airFrames };
}

describe.each(['oa_dm1', 'aggressor'])('Q3 movement on meep [%s]', (mapName) => {
    const { physics, spawns } = world(mapName);
    const move = new MeepMove(physics);

    /** A spawn, lifted the 9 units Q3 lifts a spawning player. */
    const at = (i: number): MoveState =>
        createMoveState([spawns[i % spawns.length]![0]!, spawns[i % spawns.length]![1]!, spawns[i % spawns.length]![2]! + 9]);

    it('brings a dropped player to rest on the floor, at every spawn point', () => {
        /*
         The failure this exists for is D-064's: a player who overshoots the
         resting height, bounces at landing speed, and never grounds. It was
         invisible to every divergence percentile and total in effect.

         *Resting* is asserted for every spawn; `grounded` is asserted for all
         but a known one. See the next test.
        */
        for (let i = 0; i < spawns.length; i++) {
            const state = at(i);
            run(move, state, 250, () => command());

            expect(Math.abs(state.velocity[2]!), `spawn ${i} is still moving vertically`)
                .toBeLessThan(1);
        }
    });

    it('grounds at every spawn point', () => {
        /*
         A player standing still on a floor is grounded. There is no version of
         this that is allowed to be partially true.

         This assertion was briefly written to expect one failure on
         `aggressor`, because BUG-7 -- meep's `raycast` reporting `t = 0` for a
         ray starting inside a convex hull's AABB but outside the hull -- broke
         `KinematicMover`'s walkability probe above any brush that did not fill
         its bounding box, which in a Q3 level means every wedge and ramp. That
         was the wrong shape for a test: a suite that goes green while a player
         cannot stand on the floor is reporting the opposite of the truth, and
         the comment explaining why does not reach anyone reading a passing run.

         Fixed in meep 3.2.0. The assertion is what it should always have been.
        */
        const failed: number[] = [];

        for (let i = 0; i < spawns.length; i++) {
            const state = at(i);
            run(move, state, 250, () => command());
            if (!state.grounded) failed.push(i);
        }

        expect(failed, `spawns that never grounded: ${failed.join(', ') || 'none'}`).toEqual([]);
    });

    it('stops falling and stays stopped', () => {
        const state = at(0);
        run(move, state, 250, () => command());

        const restZ = state.origin[2]!;
        run(move, state, 125, () => command());

        expect(state.grounded).toBe(true);
        expect(Math.abs(state.origin[2]! - restZ), 'drift while standing still').toBeLessThan(0.5);
        expect(Math.abs(state.velocity[2]!), 'vertical velocity at rest').toBeLessThan(1);
    });

    /**
     * Peak speed holding a command from rest, in each of eight headings.
     *
     * Per-heading, because the first version of this test walked in one
     * direction from one spawn and measured a wall: 298 u/s, which read as a
     * motor 7% slow and was a corridor. Taking eight headings measures the
     * motor; a single heading measures the level.
     */
    const peaksByHeading = (make: (yaw: number) => MoveCommand): number[] =>
        [0, 45, 90, 135, 180, 225, 270, 315].map((yaw) => {
            const state = at(0);
            run(move, state, 250, () => command());
            return run(move, state, 125, () => make(yaw)).peakSpeed;
        });

    it('tops out at exactly ps.speed where there is room to run', () => {
        const peaks = peaksByHeading((yaw) => command({ forward: 127, yaw }));
        const atSpeed = peaks.filter((v) => Math.abs(v - 320) < 320 * 0.01);

        // Headings that run into a wall peak lower; headings that run downhill
        // peak higher, which is Q3's ground-plane projection and is correct.
        // What must hold is that the unobstructed flat ones land on 320.
        expect(
            atSpeed.length,
            `peaks: ${peaks.map((v) => v.toFixed(0)).join(', ')}`
        ).toBeGreaterThanOrEqual(3);
        expect(Math.max(...peaks), 'nothing exceeds a downhill run').toBeLessThan(320 * 1.25);
    });

    it('does not make diagonal movement faster', () => {
        /*
         `PM_CmdScale` divides by the magnitude of the whole command vector.
         Without it, forward+right is sqrt(2) too fast, which is the most
         noticeable movement bug a port can ship.

         Compared per *world heading* rather than per command: holding forward
         at yaw t and forward+right at yaw t+45 travel the same way through the
         same geometry, so any difference is the scale function rather than the
         level.
        */
        const straight = peaksByHeading((yaw) => command({ forward: 127, yaw }));
        const diagonal = peaksByHeading(
            (yaw) => command({ forward: 127, right: 127, yaw: yaw + 45 })
        );

        for (let i = 0; i < straight.length; i++) {
            expect(
                diagonal[i]! / straight[i]!,
                `heading ${i * 45}: straight ${straight[i]!.toFixed(0)}, ` +
                `diagonal ${diagonal[i]!.toFixed(0)}`
            ).toBeLessThan(1.02);
        }
    });

    it('jumps, and only once per press', () => {
        const state = at(0);
        run(move, state, 250, () => command());

        // Holding jump for a second: Q3 gives one jump, not a continuous hover.
        const held = run(move, state, 125, () => command({ up: 127 }));
        expect(held.landings, 'landings while holding jump').toBe(1);

        // The height reached is JUMP_VELOCITY against gravity: 270^2 / (2*800)
        // is ~45.6 units. This checks the player left the ground meaningfully
        // rather than that the number is exact.
        expect(held.airFrames).toBeGreaterThan(40);
    });

    it('strafe-jumps: the whole point of Q3 movement survives the swap', () => {
        /*
         The load-bearing test of this module.

         `PM_Accelerate` caps `addspeed` against the *projection* of current
         velocity onto `wishdir`, so a player moving nearly perpendicular to
         where they are pushing gets the full acceleration on top of the speed
         they already have. Chaining that while airborne is strafe jumping. It
         is entirely velocity-space and involves no trace, which is the reason
         this port could hand collision to meep and keep the movement game.

         The classic input: hold forward and one strafe key, and turn steadily
         in the direction of the strafe.
        */
        const chain = (turnPerFrame: number): number => {
            const state = at(0);
            run(move, state, 250, () => command());

            let yaw = 0;
            return run(move, state, 900, () => {
                yaw += turnPerFrame;
                return command({
                    forward: 127,
                    right: 127,
                    up: state.grounded ? 127 : 0,
                    yaw,
                });
            }).peakSpeed;
        };

        const turning = chain(0.35);

        /*
         One assertion, and the reason there is only one is worth recording.

         The obvious control -- the same chain with no yaw sweep -- is *not* a
         valid baseline in a real level, and asserting against it failed here
         for an instructive reason: on `aggressor` the non-turning chain peaked
         at 399 u/s against the turning chain's 354, because a jump chain that
         does not turn runs off a ledge and gains far more from the drop than
         strafing gains from the projection. Terrain grants speed too, so
         "faster than not turning" measures the map.

         What is left is the absolute claim, and it is the one that matters:
         `ps.speed` is 320 and ground acceleration cannot exceed it, because
         `addspeed = wishspeed - currentspeed` goes to zero there. Sustained
         horizontal speed meaningfully above 320 can only come from `addspeed`
         being measured against a *projection* of velocity onto `wishdir` --
         which is `PM_Accelerate`, unchanged, in velocity space, with no trace
         involved. That is the property this module was built to preserve.

         The isolated proof that terrain is not doing it lives one test up:
         `tops out at exactly ps.speed` shows the flat headings landing on 320.0
         to within 1%.
        */
        expect(
            turning,
            `strafe-jump chain peaked at ${turning.toFixed(0)} u/s against a 320 base`
        ).toBeGreaterThan(320 * 1.05);
    });

    it('never wedges: a player pushed into walls keeps moving', () => {
        /*
         GAP-019's symptom, as a property rather than as a trace comparison. A
         player walking into geometry from many directions must still be
         travelling; the old failure was velocity climbing to 320 against a
         position that never changed.
        */
        for (let i = 0; i < spawns.length; i++) {
            const state = at(i);
            run(move, state, 250, () => command());

            const before: [number, number] = [state.origin[0]!, state.origin[1]!];
            let moved = 0;

            for (let dir = 0; dir < 8; dir++) {
                run(move, state, 60, () => command({ forward: 127, yaw: dir * 45 }));
                const d = Math.hypot(state.origin[0]! - before[0], state.origin[1]! - before[1]);
                if (d > 8) moved += 1;
                before[0] = state.origin[0]!;
                before[1] = state.origin[1]!;
            }

            expect(moved, `spawn ${i} moved in ${moved}/8 directions`).toBeGreaterThanOrEqual(5);
        }
    });

    it('keeps every value finite', () => {
        const state = at(0);
        let yaw = 0;

        run(move, state, 1200, (f) => {
            yaw += 7;
            return command({
                forward: ((f * 37) % 255) - 127,
                right: ((f * 53) % 255) - 127,
                up: f % 17 === 0 ? 127 : 0,
                yaw,
                crouch: f % 23 === 0,
            });
        });

        for (const v of [...state.origin, ...state.velocity, ...state.groundNormal]) {
            expect(Number.isFinite(v)).toBe(true);
        }
        expect(Math.abs(state.origin[2]!), 'fell out of the world').toBeLessThan(65536);
    });

    it('crouches and stands back up', () => {
        const state = at(0);
        run(move, state, 250, () => command());

        run(move, state, 30, () => command({ crouch: true }));
        expect(state.ducked).toBe(true);
        expect(state.viewheight).toBe(12);

        run(move, state, 30, () => command());
        expect(state.ducked).toBe(false);
        expect(state.viewheight).toBe(26);
    });
});

/*
 * The bridge, against the thing it replaced.
 *
 * `PlayerMovement` stands in for `PmoveSingle`, and everything downstream of
 * movement -- the camera, the weapon, the HUD, the animation, the bots' own
 * command -- reads `playerState_t` fields that `PmoveSingle` maintained as a
 * side effect of running. Replacing it means taking on *all* of them, and twice
 * now a field was quietly dropped:
 *
 *   - `ps.groundEntityNum` was written with Q3's two sentinels inverted, so
 *     everything asking "am I on the ground" got the opposite of the truth
 *     (D-072). Movement itself was correct, so no movement test failed.
 *   - `ps.viewangles` was never written at all, because `PM_UpdateViewAngles`
 *     is the first thing `PmoveSingle` does and the bridge did not do it. The
 *     player could not aim, could not turn, and only ever walked along world
 *     yaw zero (D-074). Reported by a player.
 *
 * Both were invisible to the tests above, which drive `MeepMove` directly with
 * a `MoveCommand` and read `MoveState`. These drive the *bridge* and read the
 * `playerState_t`, and they compare against the ported path frame for frame --
 * not for equal movement, which is deliberately not equal any more, but for
 * equal bookkeeping.
 */
describe('the bridge maintains what PmoveSingle maintained [oa_dm1]', () => {
    const { physics, spawns } = world('oa_dm1');

    /** Both paths, same spawn, same commands. */
    function pair() {
        const spawnQ3 = spawns[0]!;
        const ported = createPmoveHost({ cm: physics.cm, spawnQ3, physics: null });
        const hosted = createPmoveHost({ cm: physics.cm, spawnQ3, physics });
        const movement = new PlayerMovement(physics, hosted.ps.origin);
        return { ported, hosted, movement };
    }

    /** Drive one frame of each with identical 16-bit view angles and moves. */
    function frame(
        ctx: ReturnType<typeof pair>,
        pitch: number,
        yaw: number,
        moves: [number, number, number],
        ms: number
    ): void {
        for (const pm of [ctx.ported, ctx.hosted]) {
            pm.cmd.serverTime += ms;
            pm.cmd.angles[0] = pitch;
            pm.cmd.angles[1] = yaw;
            pm.cmd.angles[2] = 0;
            pm.cmd.moves[FORWARDMOVE] = moves[0];
            pm.cmd.moves[RIGHTMOVE] = moves[1];
            pm.cmd.moves[UPMOVE] = moves[2];
        }

        runPmove(ctx.ported);
        ctx.movement.step(ctx.hosted, false, ms / 1000);
    }

    it('turns the view with the mouse, exactly as the ported path does', () => {
        /*
         The regression. A mouse delta becomes a 16-bit yaw on the command; both
         paths must turn `ps.viewangles` with it. The bridge did not, so the
         camera, the aim and the movement direction were all frozen.
        */
        const ctx = pair();
        const seen = new Set<number>();

        // A quarter turn, in eighths, plus some pitch.
        for (let i = 1; i <= 8; i++) {
            const yaw = ((i * 8192) << 16) >> 16;
            frame(ctx, i * 900, yaw, [0, 0, 0], 8);

            expect(
                ctx.hosted.ps.viewangles[1],
                `frame ${i}: yaw short ${yaw}`
            ).toBeCloseTo(ctx.ported.ps.viewangles[1]!, 6);
            expect(ctx.hosted.ps.viewangles[0]).toBeCloseTo(ctx.ported.ps.viewangles[0]!, 6);

            seen.add(Math.round(ctx.hosted.ps.viewangles[1]!));
        }

        // And it actually moved, rather than agreeing on a constant.
        expect(seen.size, 'distinct yaw values over the sweep').toBeGreaterThan(4);
    });

    it('clamps pitch where Q3 clamps it, and lets yaw wrap', () => {
        const ctx = pair();

        // Far past the +/-16000 limit: Q3 cannot look straight up.
        frame(ctx, 30000, 0, [0, 0, 0], 8);
        expect(ctx.hosted.ps.viewangles[0]).toBeCloseTo(ctx.ported.ps.viewangles[0]!, 6);
        expect(Math.abs(ctx.hosted.ps.viewangles[0]!)).toBeLessThan(90);

        // Yaw is circular because the 16-bit addition wraps.
        frame(ctx, 0, ((40000) << 16) >> 16, [0, 0, 0], 8);
        expect(ctx.hosted.ps.viewangles[1]).toBeCloseTo(ctx.ported.ps.viewangles[1]!, 6);
    });

    it('reports groundEntityNum with Q3\'s own sentinels', () => {
        const ctx = pair();

        for (let i = 0; i < 250; i++) frame(ctx, 0, 0, [0, 0, 0], 8);

        // Standing on a floor, both paths agree it is the world.
        expect(ctx.hosted.ps.groundEntityNum).toBe(C.ENTITYNUM_WORLD);
        expect(ctx.ported.ps.groundEntityNum).toBe(C.ENTITYNUM_WORLD);

        // Jumping, both agree it is nothing.
        frame(ctx, 0, 0, [0, 0, 127], 8);
        expect(ctx.hosted.ps.groundEntityNum).toBe(C.ENTITYNUM_NONE);
    });

    it('walks where it is looking, not where it started', () => {
        /*
         The player-visible half of the same bug: with `ps.viewangles` frozen,
         `wishdir` is built from yaw zero forever, so holding forward always
         walks the same way through the world however you turn.
        */
        const headings: number[][] = [];

        for (const yawShort of [0, 16384, -16384]) {
            const ctx = pair();
            for (let i = 0; i < 250; i++) frame(ctx, 0, yawShort, [0, 0, 0], 8);

            const from: [number, number] = [
                ctx.hosted.ps.origin[0]!, ctx.hosted.ps.origin[1]!,
            ];
            for (let i = 0; i < 60; i++) frame(ctx, 0, yawShort, [127, 0, 0], 8);

            headings.push([
                ctx.hosted.ps.origin[0]! - from[0],
                ctx.hosted.ps.origin[1]! - from[1],
            ]);
        }

        // Three different yaws must produce three different directions of travel.
        for (let a = 0; a < headings.length; a++) {
            const [ax, ay] = headings[a] as [number, number];
            expect(Math.hypot(ax, ay), `heading ${a} did not move`).toBeGreaterThan(20);

            for (let b = a + 1; b < headings.length; b++) {
                const [bx, by] = headings[b] as [number, number];
                const cos =
                    (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
                expect(cos, `headings ${a} and ${b} point the same way`).toBeLessThan(0.9);
            }
        }
    });

    it('keeps viewheight in step with posture', () => {
        const ctx = pair();
        for (let i = 0; i < 250; i++) frame(ctx, 0, 0, [0, 0, 0], 8);

        expect(ctx.hosted.ps.viewheight).toBe(C.DEFAULT_VIEWHEIGHT);

        for (let i = 0; i < 30; i++) ctx.movement.step(ctx.hosted, true, 0.008);
        expect(ctx.hosted.ps.viewheight).toBe(C.CROUCH_VIEWHEIGHT);
    });
});
