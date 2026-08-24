/*
 * movers.test.ts -- the binary-mover state machine and the spawn arithmetic.
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
 * The spawn cases are taken from `oa_dm1`'s actual entities, with the expected
 * `pos2` and duration worked out by hand from `SP_func_door` and `InitMover`.
 * That is deliberate: it makes the test a check on the *port*, not a snapshot of
 * whatever the port currently computes, and a regression shows up as a
 * disagreement with the C rather than as a diff against itself.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    MOVER_1TO2,
    MOVER_2TO1,
    MOVER_POS1,
    MOVER_POS2,
    MoverSystem,
    carryDisplacement,
    moveDir,
    type MoverEntity,
    type MoverEvents,
    type Vec3,
} from '../src/game/Movers.ts';

function silent(): MoverEvents {
    return {
        moverSound: () => {},
        teleport: () => {},
        hurt: () => {},
        push: () => {},
    };
}

/** One brush entity, with a submodel box of the given size at the origin. */
function build(entity: Partial<MoverEntity>, size: [number, number, number]): MoverSystem {
    const system = new MoverSystem(silent());
    system.spawn([{ _originQ3: [0, 0, 0], model: '*1', ...entity } as MoverEntity], [
        { minsQ3: [0, 0, 0], maxsQ3: [0, 0, 0] },
        { minsQ3: [0, 0, 0], maxsQ3: size },
    ]);
    return system;
}

/** Advance in 16 ms steps, as a frame loop would. */
function run(system: MoverSystem, milliseconds: number): void {
    const far = [1e6, 1e6, 1e6];
    for (let t = 0; t < milliseconds; t += 16) {
        system.update(0.016, far, far, true);
    }
}

describe('G_SetMovedir', () => {
    it('treats -1 and -2 as up and down rather than as yaws', () => {
        expect(moveDir(-1)).toEqual([0, 0, 1]);
        expect(moveDir(-2)).toEqual([0, 0, -1]);
    });

    it('is an ordinary yaw otherwise', () => {
        const [x, y, z] = moveDir(180);
        expect(x).toBeCloseTo(-1, 6);
        expect(y).toBeCloseTo(0, 6);
        expect(z).toBe(0);
    });
});

describe('SP_func_door', () => {
    it('throws its own size minus the lip, along the move direction', () => {
        // 240 x 112 x 12, angle 180 -> -X, default lip 8. 240 - 8 = 232.
        const s = build({ classname: 'func_door', angle: '180', speed: '175' }, [240, 112, 12]);
        const door = s.movers[0]!;

        expect(door.pos1).toEqual([0, 0, 0]);
        expect(door.pos2[0]).toBeCloseTo(-232, 4);
        // InitMover: duration = distance * 1000 / speed.
        expect(door.trDuration).toBe(Math.round((232 * 1000) / 175));
    });

    it('swaps pos1 and pos2 for start_open', () => {
        const s = build(
            { classname: 'func_door', angle: '180', speed: '175', spawnflags: '1' },
            [240, 112, 12]
        );
        const door = s.movers[0]!;

        expect(door.pos1[0]).toBeCloseTo(-232, 4);
        expect(door.pos2).toEqual([0, 0, 0]);
        // And it therefore *starts* open, which is the whole point.
        expect(door.origin[0]).toBeCloseTo(-232, 4);
    });

    it('uses a button\'s different defaults: speed 40, lip 4, wait 1', () => {
        // 64 x 64 x 8, angle -2 -> down. 8 - 4 = 4 units of throw at 40 ups.
        const s = build({ classname: 'func_button', angle: '-2', wait: '10' }, [64, 64, 8]);
        const button = s.movers[0]!;

        expect(button.pos2).toEqual([0, 0, -4]);
        expect(button.trDuration).toBe(100);
        expect(button.wait).toBe(10000);
    });

    it('spawns a plat already lowered, since its authored position is the top', () => {
        // height defaults to (maxs.z - mins.z) - lip = 128 - 8 = 120.
        const s = build({ classname: 'func_plat' }, [64, 64, 128]);
        const plat = s.movers[0]!;

        expect(plat.pos1).toEqual([0, 0, -120]);
        expect(plat.pos2).toEqual([0, 0, 0]);
        expect(plat.origin).toEqual([0, 0, -120]);
    });
});

describe('Use_BinaryMover', () => {
    it('opens, waits, and returns on its own clock', () => {
        const s = build({ classname: 'func_door', angle: '-1', wait: '2' }, [16, 16, 128]);
        const door = s.movers[0]!;
        const throwDistance = 128 - 8;

        expect(door.state).toBe(MOVER_POS1);

        s.use(door);
        run(s, 100);
        expect(door.state).toBe(MOVER_1TO2);
        expect(door.origin[2]).toBeGreaterThan(0);
        expect(door.origin[2]).toBeLessThan(throwDistance);

        // 50 ms lead-in plus 300 ms of travel (120 units at 400 ups).
        run(s, 400);
        expect(door.state).toBe(MOVER_POS2);
        expect(door.origin[2]).toBeCloseTo(throwDistance, 4);

        // Opened at ~350 ms, so the 2-second wait expires at ~2350.
        run(s, 1700);
        expect(door.state).toBe(MOVER_POS2);

        run(s, 200);
        expect(door.state).toBe(MOVER_2TO1);

        run(s, 400);
        expect(door.state).toBe(MOVER_POS1);
        expect(door.origin[2]).toBe(0);
    });

    it('reverses from where it is, not from where it started', () => {
        const s = build({ classname: 'func_door', angle: '-1', wait: '2' }, [16, 16, 128]);
        const door = s.movers[0]!;

        s.use(door);
        run(s, 208); // ~half of the 300 ms travel, after the 50 ms lead-in
        const half = door.origin[2];
        expect(half).toBeGreaterThan(20);
        expect(half).toBeLessThan(100);

        s.use(door); // interrupt
        expect(door.state).toBe(MOVER_2TO1);

        /*
         The critical assertion. `Use_BinaryMover` rewinds trTime by the elapsed
         part of the trajectory, so a reversed mover carries on from its current
         position. Restarting the trajectory instead teleports the door to its
         far end first, which is visible and feels broken.
        */
        s.update(0.001, [1e6, 1e6, 1e6], [1e6, 1e6, 1e6], true);
        expect(Math.abs(door.origin[2] - half)).toBeLessThan(4);
    });

    it('fires its targets when it arrives, not when it is used', () => {
        const system = new MoverSystem(silent());
        system.spawn(
            [
                {
                    classname: 'func_button',
                    model: '*1',
                    target: 'd',
                    // Down, so the throw is the box's *height* minus the lip:
                    // 8 - 4 = 4 units at 40 ups, which is the 100 ms Q3 gives a
                    // switch. Leaving `angle` off would send it 60 units along
                    // +X instead, and the test would be measuring the wrong
                    // mover for a second and a half.
                    angle: '-2',
                    _originQ3: [0, 0, 0],
                },
                { classname: 'func_door', model: '*2', targetname: 'd', angle: '-1', _originQ3: [0, 0, 0] },
            ] as MoverEntity[],
            [
                { minsQ3: [0, 0, 0], maxsQ3: [0, 0, 0] },
                { minsQ3: [0, 0, 0], maxsQ3: [64, 64, 8] },
                { minsQ3: [0, 0, 0], maxsQ3: [16, 16, 128] },
            ]
        );

        const button = system.movers[0]!;
        const door = system.movers[1]!;

        system.use(button);
        run(system, 96); // button is still travelling (50 ms lead-in + 100 ms)
        expect(door.state).toBe(MOVER_POS1);

        run(system, 200);
        expect(button.state).toBe(MOVER_POS2);
        expect(door.state).not.toBe(MOVER_POS1);
    });
});

describe('carrying riders', () => {
    it('carries a player standing on a plat and pushes one caught inside', () => {
        const s = build({ classname: 'func_plat' }, [64, 64, 128]);
        const plat = s.movers[0]!;

        // Move the plat up by 10 units this frame.
        plat.previousOrigin[2] = -120;
        plat.origin[2] = -110;

        const out: Vec3 = [0, 0, 0];

        // Feet resting on the plat's top surface (128 - 120 = 8).
        expect(carryDisplacement([plat], [10, 10, 8], [40, 40, 64], out)).toBe(true);
        expect(out).toEqual([0, 0, 10]);

        // Standing well clear of it: not carried.
        expect(carryDisplacement([plat], [10, 10, 200], [40, 40, 256], out)).toBe(false);

        // Standing beside it: not carried, even at the same height.
        expect(carryDisplacement([plat], [200, 200, 8], [230, 230, 64], out)).toBe(false);
    });

    it('does nothing for a mover that has not moved', () => {
        const s = build({ classname: 'func_plat' }, [64, 64, 128]);
        const out: Vec3 = [0, 0, 0];
        expect(carryDisplacement(s.movers, [10, 10, 8], [40, 40, 64], out)).toBe(false);
    });
});

describe('oa_dm1, as converted', () => {
    it('spawns the map\'s six brush entities with the right throws', () => {
        const built = join(process.cwd(), 'assets', 'built', 'oa_dm1');
        const scene = JSON.parse(readFileSync(join(built, 'scene.json'), 'utf8')) as {
            entities: MoverEntity[];
            submodels: { minsQ3: number[]; maxsQ3: number[] }[];
        };

        const system = new MoverSystem(silent());
        system.spawn(scene.entities, scene.submodels);

        const byModel = new Map(system.movers.map((m) => [m.model, m]));

        expect([...byModel.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 8]);

        // *2: the start_open door, 240 wide, angle 180, speed 175.
        const wide = byModel.get(2)!;
        expect(wide.pos1[0]).toBeCloseTo(-232, 3);
        expect(wide.pos2).toEqual([0, 0, 0]);
        expect(wide.trDuration).toBe(1326);

        // *4 and *5: the paired lift doors, 120 tall, dropping 112 at 400 ups.
        for (const model of [4, 5]) {
            const door = byModel.get(model)!;
            expect(door.pos2).toEqual([0, 0, -112]);
            expect(door.trDuration).toBe(280);
            expect(door.targetname).toBe('t2');
        }

        // *8: shootable, so it gets no automatic door trigger.
        expect(byModel.get(8)!.takedamage).toBe(true);

        /*
         Two triggers, both `trigger_*` brush entities. No *automatic* door
         triggers, because every door on this map is either targeted by a button
         or shootable -- which is the branch `SP_func_door` takes on
         `ent->targetname || ent->health`.
        */
        expect(system.triggers.map((t) => t.kind).sort()).toEqual(['hurt', 'teleport']);
        expect(system.unhandled).toEqual([]);
    });
});

describe('oa_dm7, as converted', () => {
    it('solves each jump pad for a velocity that lands on its target', () => {
        const built = join(process.cwd(), 'assets', 'built', 'oa_dm7');
        const scene = JSON.parse(readFileSync(join(built, 'scene.json'), 'utf8')) as {
            entities: MoverEntity[];
            submodels: { minsQ3: number[]; maxsQ3: number[] }[];
        };

        const system = new MoverSystem(silent());
        system.spawn(scene.entities, scene.submodels);

        const pads = system.triggers.filter((t) => t.kind === 'push');
        expect(pads).toHaveLength(4);

        const gravity = 800;

        for (const pad of pads) {
            const velocity = pad.pushVelocity;
            expect(velocity, `${pad.target} has no solution`).not.toBeNull();

            const destination = system.destinations.find((d) => d.targetname === pad.target)!;

            /*
             Integrate the launch forward under Q3's gravity and check it
             arrives. This is the property `AimAtTarget` exists to guarantee,
             and it holds whatever the arithmetic looks like -- which is the
             point of testing it this way rather than against fixed numbers.
            */
            const time = velocity![2] / gravity;
            const x = pad.centre[0] + velocity![0] * time;
            const y = pad.centre[1] + velocity![1] * time;
            const z = pad.centre[2] + velocity![2] * time - 0.5 * gravity * time * time;

            expect(x).toBeCloseTo(destination.origin[0], 2);
            expect(y).toBeCloseTo(destination.origin[1], 2);
            expect(z).toBeCloseTo(destination.origin[2], 2);
        }
    });

    it('spawns its lift lowered, with a 192-unit throw at 200 ups', () => {
        const built = join(process.cwd(), 'assets', 'built', 'oa_dm7');
        const scene = JSON.parse(readFileSync(join(built, 'scene.json'), 'utf8')) as {
            entities: MoverEntity[];
            submodels: { minsQ3: number[]; maxsQ3: number[] }[];
        };

        const system = new MoverSystem(silent());
        system.spawn(scene.entities, scene.submodels);

        const plat = system.movers.find((m) => m.classname === 'func_plat')!;
        expect(plat.pos1).toEqual([0, 0, -192]);
        expect(plat.pos2).toEqual([0, 0, 0]);
        expect(plat.trDuration).toBe(960);

        // And it gets its own trigger, because nothing targets it.
        expect(system.triggers.some((t) => t.kind === 'plat' && t.mover === plat)).toBe(true);
    });
});
