/*
 * character-body.test.ts -- players and bots, in the broadphase.
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
 * Phase 9 gives every character an entity with a `Transform`, a `RigidBody` and
 * a `Collider`. Three things have to be true at once and none of them is
 * obvious from the code:
 *
 *  - **Your own body is invisible to you.** meep's queries honour the filter
 *    callback and nothing else -- not `layer`/`mask`, not the sensor flag -- so
 *    the sweep that moves a character will happily find the character's own
 *    collider and refuse to let it out of itself. `MoverHost.moveFilter` is the
 *    only thing standing between the port and a player who cannot move; the
 *    first case here is what says it is standing.
 *
 *  - **Other bodies are not.** Q3 has `CONTENTS_BODY` and this port never did,
 *    because nothing was in the broadphase to block with. It blocks now, and
 *    that is new behaviour, so it is pinned rather than described.
 *
 *  - **The body is where pmove says the character is.** A body that lags, or
 *    that is a box-height out because the feet-at-origin correction was missed,
 *    is a rocket that goes through someone's head -- and nothing else in the
 *    port would notice.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SphereShape3D } from '@woosh/meep-engine/src/core/geom/3d/shape/SphereShape3D.js';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';
import { spawnPoints } from '../src/game/Spawns.ts';
import {
    MeepMove,
    createMoveState,
    type MoveCommand,
    type MoveState,
} from '../src/client/MeepMove.ts';
import { CharacterBodies, type CharacterSlot } from '../src/client/CharacterBody.ts';

const BUILT = join(process.cwd(), 'assets', 'built');
const WORLD_SCALE = 1 / 32;

interface Scene {
    entities: { classname?: string; _originQ3: number[] }[];
}

const raw = readFileSync(join(BUILT, 'oa_dm1', 'collision.bsp'));
const cm = new ClipMap(
    new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 'oa_dm1')
);
const scene = JSON.parse(readFileSync(join(BUILT, 'oa_dm1', 'scene.json'), 'utf8')) as Scene;
const spawns = spawnPoints(scene.entities).points.map((e) => e._originQ3);

function command(over: Partial<MoveCommand> = {}): MoveCommand {
    return { forward: 0, right: 0, up: 0, pitch: 0, yaw: 0, crouch: false, ...over };
}

/** A spawn, lifted the 9 units Q3 lifts a spawning player. */
function spawnAt(index: number): number[] {
    const s = spawns[index % spawns.length]!;
    return [s[0]!, s[1]!, s[2]! + 9];
}

interface Character {
    readonly move: MeepMove;
    readonly state: MoveState;
    readonly slot: CharacterSlot | null;
}

let nextClientId = 1;

/** One character, with or without a body of its own. */
function character(
    physics: HeadlessPhysics,
    bodies: CharacterBodies | null,
    originQ3: number[]
): Character {
    const slot = bodies?.create(nextClientId++) ?? null;
    const state = createMoveState(originQ3);

    slot?.track(() => state.origin);
    bodies?.sync();

    return {
        move: new MeepMove(slot?.host ?? { system: physics.system, ecd: physics.ecd }),
        state,
        slot,
    };
}

function run(
    physics: HeadlessPhysics,
    characters: Character[],
    bodies: CharacterBodies | null,
    frames: number,
    cmdFor: (who: number, frame: number) => MoveCommand
): void {
    const step = physics.entityManager.fixedUpdateStepSize;

    for (let f = 0; f < frames; f++) {
        // The engine's own step first, as the scheduler runs it: every system
        // that references a component sorts ahead of the application's.
        physics.step(step);

        for (let i = 0; i < characters.length; i++) {
            characters[i]!.move.step(characters[i]!.state, cmdFor(i, f), step);
        }

        // What `CharacterBodySystem` does, once per step, after the movement.
        bodies?.sync();
    }
}

describe('a character body', () => {
    it('is invisible to the character that owns it', async () => {
        const withBody = await HeadlessPhysics.create(cm);
        const without = await HeadlessPhysics.create(cm);

        const origin = spawnAt(0);

        const bodies = new CharacterBodies(
            { system: withBody.system, ecd: withBody.ecd },
            withBody.ecd
        );

        const a = character(withBody, bodies, [...origin]);
        const b = character(without, null, [...origin]);

        const walk = (): MoveCommand => command({ forward: 127 });

        run(withBody, [a], bodies, 200, walk);
        run(without, [b], null, 200, walk);

        /*
         Bit-for-bit, not "close". A body its owner can see does not usually
         stop the owner dead -- it nudges the recover pass, and the run drifts.
         Anything other than an exact match means the filter is leaking.
        */
        expect([...a.state.origin]).toEqual([...b.state.origin]);
        expect([...a.state.velocity]).toEqual([...b.state.velocity]);
        expect(a.state.grounded).toBe(b.state.grounded);
    });

    it('sits where pmove says the character is, feet included', async () => {
        const physics = await HeadlessPhysics.create(cm);
        const bodies = new CharacterBodies({ system: physics.system, ecd: physics.ecd }, physics.ecd);

        const who = character(physics, bodies, spawnAt(0));

        run(physics, [who], bodies, 60, () => command({ forward: 127 }));

        /*
         `overlap` at the character's own feet finds its body. The sphere is
         small and sits at the sole, so this fails if the feet-at-origin lift is
         missed -- which is a 28-unit error in a 56-unit-tall box, and would put
         a character's collision around their knees.
        */
        const found = new Uint32Array(16);
        const at = {
            x: who.state.origin[0]! * WORLD_SCALE,
            y: (who.state.origin[2]! - 24) * WORLD_SCALE,
            z: -who.state.origin[1]! * WORLD_SCALE,
        };

        const count = physics.system.overlap(
            SphereShape3D.from(4 * WORLD_SCALE) as never,
            at,
            { x: 0, y: 0, z: 0, w: 1 },
            found,
            0,
            ((entity: number) => entity === who.slot!.entity) as never
        );

        expect(count, 'the character body is not at the character').toBeGreaterThan(0);
    });

    it('blocks another character, which is CONTENTS_BODY and is new', async () => {
        const physics = await HeadlessPhysics.create(cm);
        const bodies = new CharacterBodies({ system: physics.system, ecd: physics.ecd }, physics.ecd);

        const origin = spawnAt(0);

        /*
         Two characters on the same spot, one shoved 60 units along +x, walking
         at each other along that axis. 60 units is two box-widths, so they
         start clear and meet in the middle.
        */
        const left = character(physics, bodies, [origin[0]! - 30, origin[1]!, origin[2]!]);
        const right = character(physics, bodies, [origin[0]! + 30, origin[1]!, origin[2]!]);

        bodies.sync();

        const gapBefore = right.state.origin[0]! - left.state.origin[0]!;

        run(physics, [left, right], bodies, 250, (who) =>
            // Yaw 0 is +x, yaw 180 is -x.
            command({ forward: 127, yaw: who === 0 ? 0 : 180 })
        );

        const gapAfter = right.state.origin[0]! - left.state.origin[0]!;

        // They closed on each other...
        expect(gapAfter).toBeLessThan(gapBefore);

        /*
         ...and stopped, rather than passing through. Two 30-unit-wide boxes
         cannot have their origins closer than 30 units without overlapping, and
         the solver's skin keeps a little more than that. Before phase 9 this
         number was free to go negative: they walked through each other and out
         the far side.
        */
        expect(gapAfter).toBeGreaterThan(28);
    });

    it('lets a character walk through anything marked to pass through', async () => {
        /*
         The hook a missile body will use: a rocket flying past your face is not
         a wall, and meep's queries have no `layer`/`mask` gate to work that out
         with -- only the filter. Standing a second character in for a missile is
         the smallest way to assert the mechanism before step 6 depends on it.

         Measured against two controls rather than against a guessed number,
         because the walker stops at a wall on `oa_dm1` whether or not anything
         is in its way, and an assertion about where that wall is would be a test
         of the map.
        */
        const walk = (): MoveCommand => command({ forward: 127, yaw: 0 });

        /** Walk one character +x past a second one, configured three ways. */
        async function walkPast(mode: 'solid' | 'through' | 'nobody'): Promise<number> {
            const physics = await HeadlessPhysics.create(cm);
            const bodies = new CharacterBodies(
                { system: physics.system, ecd: physics.ecd },
                physics.ecd
            );

            const origin = spawnAt(0);
            const use = mode === 'nobody' ? null : bodies;

            const left = character(physics, use, [origin[0]! - 30, origin[1]!, origin[2]!]);
            const right = character(physics, use, [origin[0]! + 30, origin[1]!, origin[2]!]);

            if (mode === 'through') bodies.passThrough(right.slot!.entity);

            bodies.sync();
            run(physics, [left], use, 250, walk);

            return left.state.origin[0]!;
        }

        const solid = await walkPast('solid');
        const through = await walkPast('through');
        const nobody = await walkPast('nobody');

        // Marked to pass through, the second character may as well not exist.
        expect(through).toBe(nobody);

        // And it is a real difference: unmarked, the same walk stops short.
        expect(solid).toBeLessThan(through - 20);
    });
});
