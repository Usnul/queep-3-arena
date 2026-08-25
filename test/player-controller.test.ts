/*
 * player-controller.test.ts -- the frame the browser actually runs.
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
 * Three bugs have now reached the maintainer through the same hole, and none of
 * them was in a solver:
 *
 * - D-072: `ps.groundEntityNum` written with Q3's sentinels inverted.
 * - D-074: `PM_UpdateViewAngles` never called, so the player could not aim.
 * - D-075: `pm.mins` / `pm.maxs` never written, so every trigger, button and
 *   plat in the game tested the player as a zero-size point.
 *
 * Each is a `pmove_t` field that `PmoveSingle` maintained as a side effect and
 * that the replacement did not. `meepmove.test.ts` covers the solver and the
 * bridge; `match.test.ts` covers the bots. Between them they never construct a
 * `PlayerController`, so nothing in the suite ran the code path the person at
 * the keyboard runs.
 *
 * This file does. It drives the real controller through meep's real input
 * device shapes, on real map collision, and asserts against the real consumers
 * of player state -- the camera, `Footsteps`, `Character.legsFor`,
 * `WeaponSystem.fire`, `carryDisplacement`, and the HUD's own fields. Where a
 * property is solver-independent it is asserted on both paths, because "the
 * ported path does this too" is the difference between a port bug and a bridge
 * bug and it is the first thing worth knowing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap } from '../src/q3/cm/ClipMap.ts';
import { HeadlessPhysics } from '../tools/pipeline/headless-physics.ts';
import { spawnPoints } from '../src/game/Spawns.ts';
import {
    PlayerController,
    type InputDevices,
    type PointerMoveHandler,
} from '../src/client/PlayerController.ts';
import { STAND_MAXS, STAND_MINS, CROUCH_MAXS } from '../src/client/MeepMove.ts';
import { Footsteps } from '../src/client/Audio.ts';
import { Character } from '../src/client/Characters.ts';
import { carryDisplacement, type Mover, type Vec3 as MoverVec3 } from '../src/game/Movers.ts';
import { angleVectors, vec3, type Vec3 } from '../src/q3/math.ts';
import * as C from '../src/q3/pmove/constants.ts';

const BUILT = join(process.cwd(), 'assets', 'built');
const WORLD_SCALE = 1 / 32;

/** 125 Hz, matching what `Bot` subdivides to, so runs stay comparable. */
const TICK = 1 / 125;

interface Scene {
    entities: { classname?: string; _originQ3: number[] }[];
}

/* ------------------------------------------------------------------ *
 * Stubs for the three browser things a controller touches
 * ------------------------------------------------------------------ */

class Switch {
    is_down = false;
}

/** meep's `Signal`, reduced to what `PlayerController.attach` uses. */
class Signal<H> {
    readonly handlers: H[] = [];

    add(handler: H): void {
        this.handlers.push(handler);
    }

    remove(handler: H): void {
        const at = this.handlers.indexOf(handler);
        if (at >= 0) this.handlers.splice(at, 1);
    }

    emit(call: (handler: H) => void): void {
        for (const handler of this.handlers.slice()) call(handler);
    }
}

class Devices implements InputDevices {
    readonly keys: Record<string, Switch> = {};

    readonly keyDown = new Signal<(event: KeyboardEvent) => void>();
    readonly pointerMove = new Signal<PointerMoveHandler>();
    readonly pointerDown = new Signal<(position: unknown, event: unknown) => void>();
    readonly wheel = new Signal<(delta: unknown, event: WheelEvent) => void>();

    readonly mouseButtonLeft = new Switch();

    readonly keyboard = {
        keys: this.keys,
        on: { down: this.keyDown },
    };

    readonly pointer = {
        mouseButtonLeft: this.mouseButtonLeft,
        on: { move: this.pointerMove, down: this.pointerDown, wheel: this.wheel },
    };

    /** Hold a meep key name down or let it up. Names are meep's, not DOM's. */
    hold(name: string, down = true): void {
        (this.keys[name] ??= new Switch()).is_down = down;
    }

    release(): void {
        for (const key of Object.values(this.keys)) key.is_down = false;
        this.mouseButtonLeft.is_down = false;
    }
}

/** `Transform`, reduced to the two things `writeCamera` writes. */
class CameraTransform {
    readonly position = {
        x: 0,
        y: 0,
        z: 0,
        set(x: number, y: number, z: number): void {
            this.x = x;
            this.y = y;
            this.z = z;
        },
    };

    /** The last `_lookRotation` arguments: forward then up, meep axes. */
    forward: [number, number, number] = [0, 0, 0];

    readonly rotation = {
        owner: this as CameraTransform,
        _lookRotation(fx: number, fy: number, fz: number, _ux: number, _uy: number, _uz: number): unknown {
            this.owner.forward = [fx, fy, fz];
            return null;
        },
    };
}

/**
 * Pointer lock lives on `document`, and `PlayerController.attach` is the only
 * DOM listener left in the port. Stubbing it is what lets the test take the
 * same route a click does rather than reaching in and setting `active`.
 *
 * One document for the whole file, not one per rig: `document` is a global, and
 * two rigs each installing their own means the second silently unhooks the
 * first -- which reads exactly like a controller that ignores input, and cost
 * twenty minutes of looking at the controller.
 */
const dom = (() => {
    const listeners: (() => void)[] = [];

    const doc = {
        pointerLockElement: null as unknown,
        addEventListener(_type: string, handler: () => void): void {
            listeners.push(handler);
        },
        removeEventListener(_type: string, handler: () => void): void {
            const at = listeners.indexOf(handler);
            if (at >= 0) listeners.splice(at, 1);
        },
    };

    (globalThis as { document?: unknown }).document = doc;

    return {
        /** A fresh lock target, one per controller. */
        element(): HTMLElement {
            return {
                requestPointerLock(): Promise<void> {
                    return Promise.resolve();
                },
            } as unknown as HTMLElement;
        },
        get locked(): HTMLElement | null {
            return doc.pointerLockElement as HTMLElement | null;
        },
        lock(element: HTMLElement | null): void {
            doc.pointerLockElement = element;
            for (const handler of listeners.slice()) handler();
        },
    };
})();

/* ------------------------------------------------------------------ *
 * The rig
 * ------------------------------------------------------------------ */

const maps = new Map<string, { physics: HeadlessPhysics; spawns: number[][] }>();

function world(mapName: string): { physics: HeadlessPhysics; spawns: number[][] } {
    const cached = maps.get(mapName);
    if (cached !== undefined) return cached;

    const raw = readFileSync(join(BUILT, mapName, 'collision.bsp'));
    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), mapName)
    );
    const scene = JSON.parse(readFileSync(join(BUILT, mapName, 'scene.json'), 'utf8')) as Scene;

    const built = {
        physics: new HeadlessPhysics(cm),
        spawns: spawnPoints(scene.entities).points.map((e) => e._originQ3),
    };

    maps.set(mapName, built);
    return built;
}

type Solver = 'meep' | 'q3';

/**
 * One player, wired the way `main.ts` wires it, plus the frame `main.ts` runs.
 *
 * The frame order is `G_RunFrame`'s and `main.ts`'s: move, then audio off the
 * result, then movers, then the world's writes back into `ps`. Getting that
 * order wrong is its own class of bug -- a plat that leaves from under you --
 * so the rig reproduces it rather than inventing a tidier one.
 */
class Rig {
    readonly player: PlayerController;
    readonly camera = new CameraTransform();
    readonly devices = new Devices();
    readonly footsteps = new Footsteps();

    /** Every footstep event the frame loop would have played. */
    readonly steps: ('step' | 'land')[] = [];

    /** Every `onFire` the weapon code would have received. */
    readonly shots: { eye: number[]; angles: number[] }[] = [];

    /** The player's Q3 world box, as `main.ts` computes it for the movers. */
    readonly boxMins: Vec3 = vec3();
    readonly boxMaxs: Vec3 = vec3();

    private readonly element = dom.element();
    private readonly carry: Vec3 = vec3();

    constructor(mapName: string, solver: Solver, spawnIndex = 0) {
        const { physics, spawns } = world(mapName);
        const spawn = spawns[spawnIndex % spawns.length]!;

        this.player = new PlayerController(
            physics.cm,
            this.element,
            this.devices,
            spawn,
            physics,
            solver === 'meep' ? physics : null
        );

        this.player.onFire = (eye, angles) => {
            this.shots.push({ eye: [...eye as unknown as number[]], angles: [...angles as unknown as number[]] });
        };

        this.player.attach();
    }

    /** The click that takes pointer lock, and the lock event that follows. */
    activate(): void {
        this.devices.pointerDown.emit((h) => h(null, null));
        dom.lock(this.element);
    }

    deactivate(): void {
        dom.lock(null);
    }

    /** A mouse movement, in pixels, through the device the engine would use. */
    look(dx: number, dy: number): void {
        this.devices.pointerMove.emit((h) => h(null, null, { x: dx, y: dy }));
    }

    /**
     * One frame, in `main.ts`'s order.
     *
     * @param movers movers to run `carryDisplacement` against, as the frame loop
     *   does after they have moved.
     */
    frame(dt = TICK, movers: readonly Mover[] = []): void {
        this.player.update(dt, this.camera);

        const step = this.footsteps.update(this.player.speed, this.player.onGround, dt);
        if (step !== null) this.steps.push(step);

        const ps = this.player.ps;
        for (let i = 0; i < 3; i++) {
            this.boxMins[i] = ps.origin[i]! + this.player.mins[i]!;
            this.boxMaxs[i] = ps.origin[i]! + this.player.maxs[i]!;
        }

        if (
            movers.length > 0 &&
            carryDisplacement(movers, this.boxMins, this.boxMaxs, this.carry as unknown as MoverVec3)
        ) {
            ps.origin[0] = ps.origin[0]! + this.carry[0]!;
            ps.origin[1] = ps.origin[1]! + this.carry[1]!;
            ps.origin[2] = ps.origin[2]! + this.carry[2]!;
        }
    }

    run(frames: number, dt = TICK, movers: readonly Mover[] = []): void {
        for (let i = 0; i < frames; i++) this.frame(dt, movers);
    }

    /** Drop to the floor and stop, which is how every case wants to start. */
    settle(): this {
        this.run(250);
        this.steps.length = 0;
        return this;
    }

    /** Point the player at a Q3 yaw, the way a teleporter does. */
    face(degrees: number): this {
        this.player.setYaw(degrees);
        return this;
    }

    get origin(): number[] {
        return [...this.player.ps.origin];
    }
}

/**
 * A yaw from this spawn with room to run.
 *
 * `oa_dm1`'s first spawn faces a wall 25 units away, so "hold forward for a
 * second and check the speed" measures the level rather than the player unless
 * the heading is chosen -- which is the mistake `meepmove.test.ts` records
 * having made once already, at 298 u/s in a corridor. Measured rather than
 * hard-coded so it survives a map or a spawn-ordering change, on the meep path
 * and reused for both, because the two solvers disagree about contact fractions
 * and not about where the walls are.
 */
const headings = new Map<string, number>();

function openHeading(mapName: string, spawnIndex = 0): number {
    const key = `${mapName}:${spawnIndex}`;
    const cached = headings.get(key);
    if (cached !== undefined) return cached;

    /*
     Pointer lock is one global, exactly as it is in a browser: a scratch rig
     taking it drops whoever held it, and the drop reaches the caller's rig
     through its own `pointerlockchange` handler. So the caller's lock is put
     back before returning, or measuring a heading silently deactivates the
     player being measured.
    */
    const held = dom.locked;

    let best = 0;
    let furthest = -1;

    for (const yaw of [0, 45, 90, 135, 180, 225, 270, 315]) {
        const rig = new Rig(mapName, 'meep', spawnIndex).settle();
        rig.activate();
        rig.face(yaw);

        const from = rig.origin;
        rig.devices.hold('w');
        rig.run(125);

        const travelled = Math.hypot(rig.origin[0]! - from[0]!, rig.origin[1]! - from[1]!);
        if (travelled > furthest) {
            furthest = travelled;
            best = yaw;
        }
    }

    dom.lock(held);

    headings.set(key, best);
    return best;
}

/* ------------------------------------------------------------------ *
 * The camera, which is what the player sees
 * ------------------------------------------------------------------ */

describe.each<Solver>(['meep', 'q3'])('PlayerController -> camera [%s]', (solver) => {
    it('puts the eye at ps.origin + viewheight, in metres and meep axes', () => {
        const rig = new Rig('oa_dm1', solver).settle();
        const ps = rig.player.ps;

        expect(rig.camera.position.x).toBeCloseTo(ps.origin[0]! * WORLD_SCALE, 9);
        expect(rig.camera.position.y).toBeCloseTo(
            (ps.origin[2]! + ps.viewheight) * WORLD_SCALE, 9
        );
        expect(rig.camera.position.z).toBeCloseTo(-ps.origin[1]! * WORLD_SCALE, 9);
    });

    it('turns the camera when the mouse moves', () => {
        /*
         D-074 at the level the report described it: "I can't aim with the mouse
         at all". The bridge test proves `ps.viewangles` tracks the command; this
         proves the command tracks the *device* and the camera tracks both, which
         is the whole chain and the only part of it a player experiences.
        */
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();

        const sweep: [number, number][] = [];
        for (let i = 0; i < 8; i++) {
            rig.look(60, 0);
            rig.frame();
            sweep.push([rig.camera.forward[0], rig.camera.forward[2]]);
        }

        // Eight distinct headings, sweeping in one direction.
        const distinct = new Set(sweep.map(([x, z]) => `${x.toFixed(4)},${z.toFixed(4)}`));
        expect(distinct.size, 'distinct camera headings over the sweep').toBe(8);

        // And they agree with `ps.viewangles`, which is what the weapon uses.
        const forward = vec3();
        angleVectors(rig.player.ps.viewangles, forward, vec3(), vec3());
        expect(rig.camera.forward[0]).toBeCloseTo(forward[0]!, 6);
        expect(rig.camera.forward[2]).toBeCloseTo(-forward[1]!, 6);
        expect(rig.camera.forward[1]).toBeCloseTo(forward[2]!, 6);
    });

    it('ignores look and movement until the pointer is locked', () => {
        const rig = new Rig('oa_dm1', solver).settle();

        rig.look(500, 0);
        rig.devices.hold('w');
        const before = rig.origin;
        rig.run(60);

        expect(rig.player.ps.viewangles[1], 'yaw moved without pointer lock').toBe(0);
        expect(
            Math.hypot(rig.origin[0]! - before[0]!, rig.origin[1]! - before[1]!),
            'walked without pointer lock'
        ).toBeLessThan(1);

        // And the same input, once locked, does move.
        rig.activate();
        rig.run(60);
        expect(
            Math.hypot(rig.origin[0]! - before[0]!, rig.origin[1]! - before[1]!)
        ).toBeGreaterThan(20);
    });

    it('lowers the eye when crouching and raises it again', () => {
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();

        const standing = rig.camera.position.y;

        rig.devices.hold('ctrl');
        rig.run(30);
        const crouched = rig.camera.position.y;

        expect(rig.player.ps.viewheight).toBe(C.CROUCH_VIEWHEIGHT);
        expect(standing - crouched).toBeGreaterThan(
            (C.DEFAULT_VIEWHEIGHT - C.CROUCH_VIEWHEIGHT - 2) * WORLD_SCALE
        );

        rig.devices.release();
        rig.run(30);
        expect(rig.player.ps.viewheight).toBe(C.DEFAULT_VIEWHEIGHT);
    });
});

/* ------------------------------------------------------------------ *
 * The collision box, which is what the world sees
 * ------------------------------------------------------------------ */

describe.each<Solver>(['meep', 'q3'])('PlayerController -> collision box [%s]', (solver) => {
    /*
     D-075. `main.ts` builds the box every trigger, button and plat is tested
     against out of `player.mins` / `player.maxs`, which forward `pm.mins` /
     `pm.maxs`. Those are written by `PM_CheckDuck`, inside `PmoveSingle` -- so
     on the shipping path, which does not call it, they stayed at the `vec3()`
     zero `createPmoveHost` initialised them to.

     A zero-size box at `ps.origin` is not a small error. `ps.origin` sits 24
     units above the soles, so the player was a point floating at chest height:
     door triggers only fired when that point was inside them, buttons could not
     be pressed by walking into them, and `carryDisplacement`'s standing-on-top
     band -- feet within 1 unit above the plat -- could never be entered, so no
     plat in any map carried the player.
    */

    it('is Q3\'s player box, and not a point', () => {
        const rig = new Rig('oa_dm1', solver).settle();

        expect(Array.from(rig.player.mins), 'pm.mins').toEqual(Array.from(STAND_MINS));
        expect(Array.from(rig.player.maxs), 'pm.maxs').toEqual(Array.from(STAND_MAXS));

        // The world box straddles the origin: feet below it, head above.
        expect(rig.boxMins[2]!).toBeLessThan(rig.player.ps.origin[2]!);
        expect(rig.boxMaxs[2]!).toBeGreaterThan(rig.player.ps.origin[2]!);
        expect(rig.boxMaxs[0]! - rig.boxMins[0]!).toBeCloseTo(30, 6);
    });

    it('shortens when the player crouches', () => {
        /*
         The reason `main.ts` reads the box from `pmove` rather than assuming
         Q3's constants: `PM_CheckDuck` shortens `maxs[2]` from 32 to 16, and a
         trigger test against the standing box opens a door you cannot fit
         through.
        */
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();

        rig.devices.hold('ctrl');
        rig.run(30);

        expect(rig.player.maxs[2]).toBe(CROUCH_MAXS[2]);
        expect(rig.boxMaxs[2]! - rig.boxMins[2]!).toBeCloseTo(40, 6);
    });

    it('lets a plat carry the player standing on it', () => {
        /*
         `carryDisplacement` against a synthetic plat placed under the player's
         actual resting feet, driven through the real frame loop in the real
         order -- solve, then movers, then carry.

         Synthetic because the property under test is the seam: does the frame
         loop hand the mover code a box it can recognise a rider in? The mover
         state machine is `movers.test.ts`'s.

         Carried *horizontally*, because the headless collision world has no
         body for this plat. A rising plat is a plat the solver cannot see, so
         it drops the player straight back onto the real floor and the net lift
         measures the ground stick rather than the carry. Sideways there is
         nothing to fight: the floor is still under the player either way, so
         the distance travelled is the carry and nothing else.
        */
        const rig = new Rig('oa_dm1', solver).settle();

        /*
         The plat's top goes at the player's *true* feet -- `ps.origin` plus
         Q3's own `MINS_Z` -- and not at `rig.boxMins[2]`, which is the value
         under test. Positioning the plat by the reported box makes the case
         self-consistent with a wrong box and it passes either way: the first
         version of this test did exactly that and did not fail when the box
         was zeroed to check that it would.
        */
        const feet = rig.player.ps.origin[2]! + STAND_MINS[2]!;
        const start = rig.origin;

        const plat = {
            origin: [start[0]!, start[1]!, 0] as MoverVec3,
            previousOrigin: [start[0]!, start[1]!, 0] as MoverVec3,
            mins: [-64, -64, feet - 16] as MoverVec3,
            maxs: [64, 64, feet] as MoverVec3,
        } as unknown as Mover;

        // Ten frames of a plat sliding 2 units along +X each.
        let slid = 0;
        for (let i = 0; i < 10; i++) {
            (plat.previousOrigin as number[])[0] = plat.origin[0]!;
            (plat.origin as number[])[0] = plat.origin[0]! + 2;
            slid += 2;
            rig.frame(TICK, [plat]);
        }

        const carried = rig.player.ps.origin[0]! - start[0]!;
        expect(carried, `plat slid ${slid}, player moved ${carried.toFixed(2)}`)
            .toBeGreaterThan(slid * 0.5);

        // And a plat somewhere else is not a plat you are standing on.
        const away = new Rig('oa_dm1', solver).settle();
        const elsewhere = {
            origin: [away.origin[0]! + 500, away.origin[1]!, 0] as MoverVec3,
            previousOrigin: [away.origin[0]! + 498, away.origin[1]!, 0] as MoverVec3,
            mins: [-64, -64, away.player.ps.origin[2]! + STAND_MINS[2]! - 16] as MoverVec3,
            maxs: [64, 64, away.player.ps.origin[2]! + STAND_MINS[2]!] as MoverVec3,
        } as unknown as Mover;

        const stood = away.origin;
        away.run(10, TICK, [elsewhere]);

        expect(
            Math.abs(away.player.ps.origin[0]! - stood[0]!),
            'carried by a plat it is nowhere near'
        ).toBeLessThan(1);
    });
});

/* ------------------------------------------------------------------ *
 * The HUD, the footsteps and the animation, which all read the same two numbers
 * ------------------------------------------------------------------ */

describe.each<Solver>(['meep', 'q3'])('PlayerController -> readouts [%s]', (solver) => {
    it('reports rest as grounded and still', () => {
        const rig = new Rig('oa_dm1', solver).settle();

        expect(rig.player.onGround, 'HUD ground readout at rest').toBe(true);
        expect(rig.player.speed).toBeLessThan(1);
        expect(rig.player.movementSpeed).toBeCloseTo(rig.player.speed, 9);
        expect(Character.legsFor(rig.player.speed, rig.player.onGround, 1)).toBe('LEGS_IDLE');
    });

    it('reports a run as fast and grounded, and a jump as airborne', () => {
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();
        rig.face(openHeading('oa_dm1'));

        rig.devices.hold('w');
        rig.run(125);

        expect(rig.player.speed, 'HUD speed after a second of running').toBeGreaterThan(200);
        expect(rig.player.onGround).toBe(true);
        expect(Character.legsFor(rig.player.speed, rig.player.onGround, 1)).toBe('LEGS_RUN');

        // `groundEntityNum` is the field, and it must carry Q3's sentinel.
        expect(rig.player.ps.groundEntityNum).toBe(C.ENTITYNUM_WORLD);

        rig.devices.hold('space');
        rig.run(10);

        expect(rig.player.onGround, 'HUD ground readout mid-jump').toBe(false);
        expect(rig.player.ps.groundEntityNum).toBe(C.ENTITYNUM_NONE);
        expect(Character.legsFor(rig.player.speed, rig.player.onGround, 1)).toBe('LEGS_JUMP');
    });

    it('plays a footstep every stride and exactly one landing per jump', () => {
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();
        rig.face(openHeading('oa_dm1'));

        rig.devices.hold('w');
        rig.run(125);

        const walked = Math.hypot(
            rig.player.ps.velocity[0]!, rig.player.ps.velocity[1]!
        );
        expect(walked, 'must be moving for footsteps to mean anything').toBeGreaterThan(100);

        const stepped = rig.steps.filter((s) => s === 'step').length;
        expect(stepped, `footsteps in one second at ~${walked.toFixed(0)} u/s`)
            .toBeGreaterThan(2);
        expect(rig.steps.filter((s) => s === 'land').length, 'landings while running')
            .toBe(0);

        // One jump, one landing -- not one per frame of contact.
        rig.steps.length = 0;
        rig.devices.hold('space');
        rig.run(5);
        rig.devices.hold('space', false);
        rig.run(120);

        expect(rig.steps.filter((s) => s === 'land').length, 'landings from one jump').toBe(1);
    });
});

/* ------------------------------------------------------------------ *
 * The weapon, which fires along the view
 * ------------------------------------------------------------------ */

describe.each<Solver>(['meep', 'q3'])('PlayerController -> weapon [%s]', (solver) => {
    it('fires from the eye, along the direction the camera looks', () => {
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();

        // Look somewhere that is neither of the axes a frozen view would sit on.
        rig.look(37, -11);
        rig.devices.mouseButtonLeft.is_down = true;
        rig.frame();

        expect(rig.shots.length, 'one shot on the first frame of the trigger').toBe(1);

        const shot = rig.shots[0]!;
        const ps = rig.player.ps;

        expect(shot.eye[0]).toBeCloseTo(ps.origin[0]!, 6);
        expect(shot.eye[1]).toBeCloseTo(ps.origin[1]!, 6);
        expect(shot.eye[2]).toBeCloseTo(ps.origin[2]! + ps.viewheight, 6);

        // `WeaponSystem.fire` turns the angles into a direction with
        // `angleVectors`; that direction must be the camera's.
        const forward = vec3();
        angleVectors(shot.angles, forward, vec3(), vec3());

        expect(forward[0]!).toBeCloseTo(rig.camera.forward[0], 6);
        expect(forward[2]!).toBeCloseTo(rig.camera.forward[1], 6);
        expect(-forward[1]!).toBeCloseTo(rig.camera.forward[2], 6);

        // A frozen view is the failure mode; the shot must not be along yaw 0.
        expect(Math.abs(forward[1]!), 'shot direction has no lateral component')
            .toBeGreaterThan(0.01);
    });

    it('turns the aim with the mouse between shots', () => {
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();
        rig.devices.mouseButtonLeft.is_down = true;

        const directions: Vec3[] = [];
        for (let i = 0; i < 3; i++) {
            rig.look(400, 0);
            // The machinegun's cooldown is 100 ms; step past it.
            rig.run(20);
            const shot = rig.shots[rig.shots.length - 1]!;
            const forward = vec3();
            angleVectors(shot.angles, forward, vec3(), vec3());
            directions.push(forward);
        }

        for (let a = 0; a < directions.length; a++) {
            for (let b = a + 1; b < directions.length; b++) {
                const dot =
                    directions[a]![0]! * directions[b]![0]! +
                    directions[a]![1]! * directions[b]![1]! +
                    directions[a]![2]! * directions[b]![2]!;
                expect(dot, `shots ${a} and ${b} went the same way`).toBeLessThan(0.99);
            }
        }
    });

    it('spends ammo and respects the fire rate', () => {
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();

        const before = rig.player.inventory.ammo[rig.player.weapon]!;
        rig.devices.mouseButtonLeft.is_down = true;

        // One second at 125 Hz; the machinegun's `addTime` is 100 ms.
        rig.run(125);

        expect(rig.shots.length, 'shots in one second').toBeGreaterThanOrEqual(9);
        expect(rig.shots.length, 'the trigger is not free').toBeLessThanOrEqual(11);
        expect(before - rig.player.inventory.ammo[rig.player.weapon]!).toBe(rig.shots.length);
    });
});

/* ------------------------------------------------------------------ *
 * What the world writes into `ps` between frames
 * ------------------------------------------------------------------ */

describe.each<Solver>(['meep', 'q3'])('the world writes into ps between frames [%s]', (solver) => {
    it('honours a teleporter\'s origin and yaw', () => {
        const rig = new Rig('oa_dm1', 'meep');
        const other = new Rig('oa_dm1', solver, 3).settle();
        rig.settle();
        rig.activate();

        const destination = other.origin;
        const ps = rig.player.ps;

        // `TeleportPlayer`, as `main.ts` performs it.
        ps.origin[0] = destination[0]!;
        ps.origin[1] = destination[1]!;
        ps.origin[2] = destination[2]! + 1;
        ps.velocity[0] = 0;
        ps.velocity[1] = 0;
        ps.velocity[2] = 0;
        rig.player.setYaw(90);

        rig.frame();

        expect(
            Math.hypot(ps.origin[0]! - destination[0]!, ps.origin[1]! - destination[1]!),
            'dragged back to where it was before the teleport'
        ).toBeLessThan(2);

        // And the view went with it, which is the half `setYaw` owns.
        expect(ps.viewangles[1]).toBeCloseTo(90, 1);

        rig.run(125);
        expect(rig.player.onGround, 'never landed after the teleport').toBe(true);
    });

    it('honours a jump pad\'s velocity', () => {
        /*
         `BG_TouchJumpPad` overwrites velocity outright. The write lands between
         two frames, so the solver has to read `ps` on entry rather than trusting
         the velocity it produced last frame -- and if it does not, the pad does
         nothing at all.
        */
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();

        const ps = rig.player.ps;
        ps.velocity[0] = 0;
        ps.velocity[1] = 0;
        ps.velocity[2] = 500;

        const from = ps.origin[2]!;
        rig.run(30);

        expect(ps.origin[2]! - from, 'height gained from a 500 u/s pad').toBeGreaterThan(50);
        expect(rig.player.onGround, 'still grounded after being launched').toBe(false);

        rig.run(220);
        expect(rig.player.onGround, 'never came back down').toBe(true);
    });

    it('honours a respawn', () => {
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();
        rig.devices.hold('w');
        rig.run(60);

        const { spawns } = world('oa_dm1');
        const point = spawns[2]!;
        const ps = rig.player.ps;

        ps.origin[0] = point[0]!;
        ps.origin[1] = point[1]!;
        ps.origin[2] = point[2]! + 9;
        ps.velocity[0] = 0;
        ps.velocity[1] = 0;
        ps.velocity[2] = 0;

        rig.devices.release();
        rig.run(250);

        expect(
            Math.hypot(ps.origin[0]! - point[0]!, ps.origin[1]! - point[1]!),
            'did not stay at the spawn it was moved to'
        ).toBeLessThan(32);
        expect(rig.player.onGround).toBe(true);
    });
});

/* ------------------------------------------------------------------ *
 * The two solvers, side by side on the fields the game reads
 * ------------------------------------------------------------------ */

describe('the two paths agree on the bookkeeping [oa_dm1]', () => {
    /*
     `meepmove.test.ts` compares the bridge against `PmoveSingle` on the fields.
     This compares the two *controllers*, because the controller is what the
     browser builds and it owns state of its own -- the angle accumulators, the
     weapon cooldown, the crouch flag -- that neither solver knows about.

     Positions are deliberately not compared: they are not equal any more and
     that is the point of D-071.
    */
    function pair(): { meep: Rig; q3: Rig } {
        return { meep: new Rig('oa_dm1', 'meep').settle(), q3: new Rig('oa_dm1', 'q3').settle() };
    }

    it('reports the same posture, ground state and box from the same input', () => {
        const { meep, q3 } = pair();

        const script: [string, number][] = [
            ['w', 60], ['space', 5], ['w', 60], ['ctrl', 40], ['w', 60],
        ];

        for (const [key, frames] of script) {
            for (const rig of [meep, q3]) {
                // Pointer lock is one global and the browser gives it to one
                // element; two rigs cannot hold it at once, so each takes it
                // back before its own frames.
                rig.activate();
                rig.devices.release();
                rig.devices.hold(key);
                rig.look(20, 0);
                rig.run(frames);
            }

            expect(Array.from(meep.player.mins), `mins after ${key}`)
                .toEqual(Array.from(q3.player.mins));
            expect(Array.from(meep.player.maxs), `maxs after ${key}`)
                .toEqual(Array.from(q3.player.maxs));
            expect(meep.player.ps.viewheight, `viewheight after ${key}`)
                .toBe(q3.player.ps.viewheight);
            expect(meep.player.ps.viewangles[1], `yaw after ${key}`)
                .toBeCloseTo(q3.player.ps.viewangles[1]!, 6);
            expect(meep.player.onGround, `onGround after ${key}`).toBe(q3.player.onGround);
        }
    });

    it('fires the same number of shots for the same held trigger', () => {
        const { meep, q3 } = pair();

        for (const rig of [meep, q3]) {
            rig.activate();
            rig.devices.mouseButtonLeft.is_down = true;
            rig.run(250);
        }

        expect(meep.shots.length).toBe(q3.shots.length);
    });
});
