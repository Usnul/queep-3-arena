/*
 * view-offset.test.ts -- the camera's own motion, which the port did not have.
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
 * `CG_OffsetFirstPersonView` and `CG_CalcFov` are the two functions between
 * `ps.origin` and what the player sees, and the port had neither: the camera sat
 * at `origin + viewheight` looking down `ps.viewangles` through a lens set to
 * the wrong axis. Both were reported, and neither is the kind of thing a
 * screenshot settles -- "the gun is too far away" and "the camera feels dead"
 * are both true of a dozen different mistakes.
 *
 * So the numbers are asserted against the C's, which is what these two modules
 * are for: five cvars, six timings and one arctangent, none of them invented
 * here and all of them checkable.
 */

import { describe, expect, it } from 'vitest';

import { verticalFovDegrees } from '../src/client/lens.ts';
import {
    DEAD_VIEW_PITCH,
    DEAD_VIEW_ROLL,
    firstPersonView,
    viewPose,
    ViewKick,
    type ViewInput,
} from '../src/client/viewOffset.ts';
import { vec3 } from '../src/q3/math.ts';

/** `ps`, at rest, facing world yaw zero, standing. */
function input(over: Partial<ViewInput> = {}): ViewInput {
    return {
        originQ3: vec3(0, 0, 0),
        velocityQ3: vec3(0, 0, 0),
        viewanglesQ3: vec3(0, 0, 0),
        viewheight: 26,
        bobCycle: 0,
        ducked: false,
        dead: false,
        ...over,
    };
}

describe('cg_fov is horizontal and meep is not', () => {
    /*
     The whole bug in one number. Q3 computes `fov_y` from `fov_x`, the render
     width and the render height; meep's `Camera.fov` is `fov_y` and the port was
     handing it `fov_x`. At 4:3 that is 90 where Q3 draws 73.74, and at 16:9 it
     is 90 where Q3 draws 58.72 -- a horizontal 121.7 degrees against Q3's 90.
    */
    it('gives Q3 its own vertical angle at 4:3', () => {
        expect(verticalFovDegrees(90, 4 / 3)).toBeCloseTo(73.7398, 3);
    });

    it('narrows vertically as the window widens, which is what vert- means', () => {
        expect(verticalFovDegrees(90, 16 / 9)).toBeCloseTo(58.7155, 3);
        expect(verticalFovDegrees(90, 21 / 9)).toBeCloseTo(46.3972, 3);
    });

    it('round-trips: the horizontal angle out is the one that went in', () => {
        for (const aspect of [4 / 3, 16 / 9, 21 / 9, 1]) {
            for (const fovX of [60, 90, 110, 130]) {
                const fovY = verticalFovDegrees(fovX, aspect);
                const back =
                    (2 * Math.atan(Math.tan((fovY * Math.PI) / 360) * aspect) * 180) / Math.PI;
                expect(back).toBeCloseTo(fovX, 6);
            }
        }
    });

    it('is the identity at 1:1, where the two axes are the same axis', () => {
        expect(verticalFovDegrees(90, 1)).toBeCloseTo(90, 9);
    });
});

describe('the view offset at rest', () => {
    it('is nothing at all, which is what makes a standing player still', () => {
        const out = viewPose();
        firstPersonView(input({ originQ3: vec3(10, 20, 30) }), new ViewKick(), out);

        expect([...out.eyeQ3]).toEqual([10, 20, 56]);
        expect(out.pitch).toBe(0);
        expect(out.roll).toBe(0);
    });
});

describe('the lean, which is `cg_runroll` and the thing that was missing', () => {
    /*
     `delta = DotProduct(velocity, cg.refdef.viewaxis[1]); angles[ROLL] -= delta *
     cg_runroll.value`. `viewaxis[1]` is **left** -- `AnglesToAxis` negates what
     `AngleVectors` returns as its second axis -- and getting that backwards
     leans you out of a strafe instead of into it.
    */
    it('rolls into a right strafe by cg_runroll times the speed', () => {
        const out = viewPose();
        // Facing +x, so `right` is -y in Q3's frame: strafing right is -y.
        firstPersonView(input({ velocityQ3: vec3(0, -320, 0) }), new ViewKick(), out);

        expect(out.roll).toBeCloseTo(320 * 0.005, 4);
    });

    it('rolls the other way for the other strafe', () => {
        const out = viewPose();
        firstPersonView(input({ velocityQ3: vec3(0, 320, 0) }), new ViewKick(), out);

        expect(out.roll).toBeCloseTo(-320 * 0.005, 4);
    });

    it('pitches down as you run forward and up as you back off -- `cg_runpitch`', () => {
        const forward = viewPose();
        firstPersonView(input({ velocityQ3: vec3(400, 0, 0) }), new ViewKick(), forward);
        expect(forward.pitch).toBeCloseTo(400 * 0.002, 4);

        const back = viewPose();
        firstPersonView(input({ velocityQ3: vec3(-400, 0, 0) }), new ViewKick(), back);
        expect(back.pitch).toBeCloseTo(-400 * 0.002, 4);
    });

    it('is a function of where you are looking, not of which way the world is', () => {
        // Same motion, turned 90 degrees: running north while facing north is
        // still running forward.
        const out = viewPose();
        firstPersonView(
            input({ velocityQ3: vec3(0, 400, 0), viewanglesQ3: vec3(0, 90, 0) }),
            new ViewKick(),
            out
        );

        expect(out.pitch).toBeCloseTo(400 * 0.002, 3);
        expect(out.roll).toBeCloseTo(0, 3);
    });
});

describe('the bob', () => {
    /*
     `speed = cg.xyspeed > 200 ? cg.xyspeed : 200` for the *angles*, and the
     unfloored `cg.xyspeed` for the *height*. The two differ on purpose: the head
     turns at a walk and does not rise at a standstill.
    */
    it('nods and sways once per stride, scaled by a speed floored at 200', () => {
        const out = viewPose();
        // Mid-arch: `bobfracsin` is ~1 at 64 of 127.
        firstPersonView(input({ bobCycle: 64 }), new ViewKick(), out);

        const fracSin = Math.abs(Math.sin((64 / 127) * Math.PI));
        expect(out.pitch).toBeCloseTo(fracSin * 0.002 * 200, 5);
        expect(out.roll).toBeCloseTo(fracSin * 0.002 * 200, 5);
    });

    it('flips the sway on alternate strides, which is what makes it a gait', () => {
        const first = viewPose();
        firstPersonView(input({ bobCycle: 64 }), new ViewKick(), first);

        const second = viewPose();
        firstPersonView(input({ bobCycle: 64 + 128 }), new ViewKick(), second);

        // Same arch, opposite foot: the roll inverts and the pitch does not.
        expect(second.roll).toBeCloseTo(-first.roll, 6);
        expect(second.pitch).toBeCloseTo(first.pitch, 6);
    });

    it('triples while crouched, both halves of it', () => {
        const standing = viewPose();
        firstPersonView(input({ bobCycle: 64 }), new ViewKick(), standing);

        const ducked = viewPose();
        firstPersonView(input({ bobCycle: 64, ducked: true }), new ViewKick(), ducked);

        expect(ducked.pitch).toBeCloseTo(standing.pitch * 3, 6);
        expect(ducked.roll).toBeCloseTo(standing.roll * 3, 6);
    });

    it('lifts the eye with the stride, and stops lifting it at six units', () => {
        const fracSin = Math.abs(Math.sin((64 / 127) * Math.PI));

        const walking = viewPose();
        firstPersonView(
            input({ bobCycle: 64, velocityQ3: vec3(320, 0, 0) }),
            new ViewKick(),
            walking
        );
        expect(walking.eyeQ3[2]! - 26).toBeCloseTo(fracSin * 320 * 0.005, 5);

        // `if (bob > 6) bob = 6`, which a strafe-jump chain reaches easily.
        const sprinting = viewPose();
        firstPersonView(
            input({ bobCycle: 64, velocityQ3: vec3(2000, 0, 0) }),
            new ViewKick(),
            sprinting
        );
        expect(sprinting.eyeQ3[2]! - 26).toBeCloseTo(6, 6);
    });

    it('does not lift a standing player, however far through a stride they stopped', () => {
        const out = viewPose();
        firstPersonView(input({ bobCycle: 64 }), new ViewKick(), out);

        // The angles still move -- the 200 floor -- and the eye does not.
        expect(out.eyeQ3[2]).toBe(26);
        expect(out.pitch).not.toBe(0);
    });
});

describe('the dead view', () => {
    it('pins the angles where Q3 pins them and adds no kick at all', () => {
        const kick = new ViewKick();
        kick.land(800);

        const out = viewPose();
        firstPersonView(
            input({ dead: true, velocityQ3: vec3(400, 0, 0), bobCycle: 64 }),
            kick,
            out
        );

        expect(out.dead).toBe(true);
        expect(out.pitch).toBe(DEAD_VIEW_PITCH);
        expect(out.roll).toBe(DEAD_VIEW_ROLL);
        // View height only: no bob, no landing dip, nothing.
        expect(out.eyeQ3[2]).toBe(26);
    });
});

describe('the timed kicks', () => {
    it('dips on landing by the amount `PM_CrashLand` would have asked for', () => {
        // `delta = speed^2 * 0.0001`: the thresholds are 7, 40 and 60.
        for (const [speed, expected] of [
            [200, 0], // delta 4 -- below `EV_FALL_SHORT`, no dip
            [300, -8], // delta 9
            [700, -16], // delta 49
            [800, -24], // delta 64
        ] as const) {
            const kick = new ViewKick();
            kick.land(speed);
            // The peak of the deflection is at `LAND_DEFLECT_TIME`.
            kick.advance(150);

            expect(kick.originOffset(), `landing at ${speed}`).toBeCloseTo(expected, 6);
        }
    });

    it('recovers from a landing over `LAND_RETURN_TIME` and then stops', () => {
        const kick = new ViewKick();
        kick.land(300);

        expect(kick.originOffset()).toBeCloseTo(0, 6); // f = 0 at the instant
        kick.advance(75);
        expect(kick.originOffset()).toBeCloseTo(-4, 6); // half the deflection
        kick.advance(75);
        expect(kick.originOffset()).toBeCloseTo(-8, 6); // full
        kick.advance(150);
        expect(kick.originOffset()).toBeCloseTo(-4, 6); // half the recovery
        kick.advance(150);
        expect(kick.originOffset()).toBeCloseTo(0, 6);
        kick.advance(1000);
        expect(kick.originOffset()).toBe(0);
    });

    it('holds the eye still through a crouch and lets it down over DUCK_TIME', () => {
        const kick = new ViewKick();
        // `PM_CheckDuck`: 26 standing, 12 crouched.
        kick.duck(12 - 26);

        /*
         The offset exactly cancels the viewheight change at the instant it
         happens, which is the whole point: `origin[2] += viewheight` has already
         dropped the eye 14 units and this puts it back, then lets it go.
        */
        expect(kick.originOffset()).toBeCloseTo(14, 6);
        kick.advance(50);
        expect(kick.originOffset()).toBeCloseTo(7, 6);
        kick.advance(50);
        expect(kick.originOffset()).toBeCloseTo(0, 6);
    });

    it('leaves the eye behind a stair and catches up over STEP_TIME', () => {
        const kick = new ViewKick();
        kick.step(16);

        expect(kick.originOffset()).toBeCloseTo(-16, 6);
        kick.advance(100);
        expect(kick.originOffset()).toBeCloseTo(-8, 6);
        kick.advance(100);
        expect(kick.originOffset()).toBeCloseTo(0, 6);
    });

    it('quantises a step to Q3s four buckets rather than to the riser', () => {
        // `PM_StepSlideMove` raises EV_STEP_4/8/12/16 and `CG_EntityEvent` turns
        // the event back into a multiple of four.
        for (const [rise, expected] of [
            [3, 4],
            [6.9, 4],
            [7, 8],
            [10.9, 8],
            [11, 12],
            [14.9, 12],
            [15, 16],
            [18, 16],
        ] as const) {
            const kick = new ViewKick();
            kick.step(rise);
            expect(kick.originOffset(), `rise ${rise}`).toBeCloseTo(-expected, 6);
        }
    });

    it('accumulates a second stair onto what is left of the first, up to MAX_STEP_CHANGE', () => {
        const kick = new ViewKick();
        kick.step(16);
        kick.advance(100);
        // Half of the first 16 is still owed; the second adds another 16.
        kick.step(16);
        expect(kick.originOffset()).toBeCloseTo(-24, 6);

        // ...and a flight of them saturates rather than running away.
        for (let i = 0; i < 10; i++) kick.step(16);
        expect(kick.originOffset()).toBeCloseTo(-32, 6);
    });

    it('throws the head back on damage, scaled by how hurt you already are', () => {
        // `scale = health < 40 ? 1 : 40 / health`, `kick` clamped to 5..10.
        const light = new ViewKick();
        light.damage(10, 100);
        light.advance(100);
        // 10 * 0.4 = 4, clamped up to the floor of 5.
        expect(light.angleOffset()[0]).toBeCloseTo(-5, 6);

        const heavy = new ViewKick();
        heavy.damage(60, 20);
        heavy.advance(100);
        // scale 1 below 40 health, so 60 -- clamped down to the ceiling of 10.
        expect(heavy.angleOffset()[0]).toBeCloseTo(-10, 6);
    });

    it('recovers from a damage kick over DAMAGE_RETURN_TIME', () => {
        const kick = new ViewKick();
        kick.damage(100, 100);

        expect(kick.angleOffset()[0]).toBeCloseTo(0, 6);
        kick.advance(50);
        expect(kick.angleOffset()[0]).toBeCloseTo(-5, 6);
        kick.advance(50);
        expect(kick.angleOffset()[0]).toBeCloseTo(-10, 6);
        kick.advance(200);
        expect(kick.angleOffset()[0]).toBeCloseTo(-5, 6);
        kick.advance(200);
        expect(kick.angleOffset()).toEqual([0, 0]);
    });

    it('is silent until something happens to it', () => {
        const kick = new ViewKick();
        kick.advance(10_000);

        expect(kick.originOffset()).toBe(0);
        expect(kick.angleOffset()).toEqual([0, 0]);
    });
});
