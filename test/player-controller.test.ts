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
    type WheelHandler,
} from '../src/client/PlayerController.ts';
import { STAND_MAXS, STAND_MINS, CROUCH_MAXS } from '../src/client/MeepMove.ts';
import { Footsteps } from '../src/client/Audio.ts';
import { Character } from '../src/client/Characters.ts';
import { type Mover, type Vec3 as MoverVec3 } from '../src/game/Movers.ts';
import { WorldEffects, type MoverWorld } from '../src/game/WorldEffects.ts';
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
    readonly wheel = new Signal<WheelHandler>();

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

    /**
     * ...and the up, which carries the roll.
     *
     * `_lookRotation` orthonormalises, so the up it is handed is not exactly the
     * one a quaternion would hand back -- but the component that matters here is
     * the sideways tilt, and that survives the orthonormalisation because it is
     * perpendicular to the forward by construction.
     */
    up: [number, number, number] = [0, 1, 0];

    readonly rotation = {
        owner: this as CameraTransform,
        _lookRotation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): unknown {
            this.owner.forward = [fx, fy, fz];
            this.owner.up = [ux, uy, uz];
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

/**
 * Load one map's collision and spawns into the cache.
 *
 * Separate from `world` because `HeadlessPhysics.create` is a factory now -- the
 * ECS behind it has to be started before any body is built -- and `Rig`'s
 * constructor cannot await. Every map a case names is warmed at module scope
 * below, which keeps all 24 `new Rig(...)` sites synchronous.
 */
async function warm(mapName: string): Promise<void> {
    if (maps.has(mapName)) return;

    const raw = readFileSync(join(BUILT, mapName, 'collision.bsp'));
    const cm = new ClipMap(
        new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), mapName)
    );
    const scene = JSON.parse(readFileSync(join(BUILT, mapName, 'scene.json'), 'utf8')) as Scene;

    maps.set(mapName, {
        physics: await HeadlessPhysics.create(cm),
        spawns: spawnPoints(scene.entities).points.map((e) => e._originQ3),
    });
}

function world(mapName: string): { physics: HeadlessPhysics; spawns: number[][] } {
    const cached = maps.get(mapName);
    if (cached === undefined) {
        throw new Error(`world('${mapName}') before it was warmed -- add it beside the others`);
    }
    return cached;
}

await warm('oa_dm1');

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

    /**
     * The world's writes into `ps`, and the frame that applies them.
     *
     * The same object `main.ts` builds, not a re-creation of it: the ordering
     * inside `apply` is `G_RunFrame`'s and is load-bearing, and a test that
     * copies an ordering is a test of the copy. That is how D-075 lasted -- the
     * seam test D-074 added drove `PlayerMovement` directly and never went near
     * what the app does around it.
     */
    readonly effects = new WorldEffects();

    /** Damage from `trigger_hurt`, which `main.ts` bills to the inventory. */
    damageTaken = 0;

    /** A mover world holding exactly the movers a case hands to `frame`. */
    private readonly world: MoverWorld & { movers: Mover[] } = {
        movers: [],
        update: () => {},
        touchButtons: () => {},
    };

    private readonly element = dom.element();

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
     * One wheel notch, dispatched the way `PointerDevice#eventHandlerWheel`
     * dispatches it: `send3(delta, position, event)`, with the delta already
     * `sign()`ed per axis. `y` is +1 for a scroll down, -1 for up.
     */
    wheel(y: number, x = 0): void {
        this.devices.wheel.emit((h) => h({ x, y, z: 0 }, { x: 0, y: 0 }, new Event('wheel')));
    }

    /**
     * One frame, in `main.ts`'s order.
     *
     * @param movers movers to run `carryDisplacement` against, as the frame loop
     *   does after they have moved.
     */
    frame(dt = TICK, movers: readonly Mover[] = []): void {
        this.player.update(dt);
        // The camera is a render-rate write now; a test frame is one whole step,
        // so it lands on the newest pose. See `PlayerController.writeCamera`.
        this.player.writeCamera(this.camera);

        const step = this.footsteps.update(
            this.player.ps.bobCycle,
            this.player.onGround,
            this.player.ducked,
            this.player.walking
        );
        if (step !== null) this.steps.push(step);

        this.world.movers = movers as Mover[];
        this.damageTaken += this.effects.apply(this.player, this.world, dt).damage;
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

    /** The player's world box, as `WorldEffects` last computed it. */
    get boxMins(): MoverVec3 {
        return this.effects.playerMins;
    }

    get boxMaxs(): MoverVec3 {
        return this.effects.playerMaxs;
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

    it('blends the eye between the last two steps at the sub-step alpha', () => {
        /*
         The camera is written once per *rendered* frame now, not once per fixed
         step, and this is the property that makes that worth doing: at alpha
         zero it sits on the previous step and at one on the latest, so a display
         running faster than the simulation gets a pose per frame instead of the
         same one two or three times. Before this, everything drawn through the
         camera stepped at 60 Hz -- which is what was reported as projectiles
         moving in jerks, the projectile being the one thing on screen that was
         already smooth.
        */
        /*
         Falling rather than walking, so the motion between the two steps is
         gravity's and does not depend on which way `oa_dm1`'s first spawn faces
         or on how far it is from the wall it faces. Lifted well clear of the
         floor first: a player dropped Q3's own nine units is inside the mover's
         stick band and is put straight down on the ground, and a camera that is
         not moving proves nothing about a blend.
        */
        const rig = new Rig('oa_dm1', solver);
        rig.player.ps.origin[2] = rig.player.ps.origin[2]! + 200;
        rig.run(6);

        rig.player.writeCamera(rig.camera, 0);
        const start = [rig.camera.position.x, rig.camera.position.y, rig.camera.position.z];

        rig.player.writeCamera(rig.camera, 1);
        const end = [rig.camera.position.x, rig.camera.position.y, rig.camera.position.z];

        // Read as a distance rather than as one axis: which way yaw zero points
        // is the map's business, and `oa_dm1`'s first spawn faces a wall.
        const travel = Math.hypot(end[0]! - start[0]!, end[1]! - start[1]!, end[2]! - start[2]!);
        expect(travel, 'the player moved between the two steps')
            .toBeGreaterThan(0.05 * WORLD_SCALE);

        for (const alpha of [0.25, 0.5, 0.75]) {
            rig.player.writeCamera(rig.camera, alpha);

            expect(rig.camera.position.x).toBeCloseTo(start[0]! + (end[0]! - start[0]!) * alpha, 9);
            expect(rig.camera.position.y).toBeCloseTo(start[1]! + (end[1]! - start[1]!) * alpha, 9);
            expect(rig.camera.position.z).toBeCloseTo(start[2]! + (end[2]! - start[2]!) * alpha, 9);
        }
    });

    it('does not kick the view on the very first step, or on a respawn', () => {
        /*
         Every view kick is a difference against the previous fixed step, and on
         the first one there is no previous step: the fields start at zero, so
         an ungated `duck` sees the whole viewheight arrive at once and an
         ungated stair test sees the player's absolute altitude as a rise. Both
         land on the frame the game starts, which is not a frame to put a
         camera kick on.

         A respawn is the same shape arriving later: `PlayerSystem.mortality`
         writes `ps.origin` from outside the solver, so the height difference
         across that step is the length of the map. `STEPSIZE` is what rules it
         out -- Q3 cannot step higher than 18 units, so anything taller was not
         a step.
        */
        const rig = new Rig('oa_dm1', solver);

        rig.frame();
        rig.player.writeCamera(rig.camera, 1);
        const ps = rig.player.ps;

        expect(rig.camera.position.y).toBeCloseTo(
            (ps.origin[2]! + ps.viewheight) * WORLD_SCALE,
            9
        );

        // ...and again across a teleport-sized jump in altitude.
        rig.settle();
        ps.origin[2] = ps.origin[2]! + 400;
        rig.frame();
        rig.player.writeCamera(rig.camera, 1);

        expect(rig.camera.position.y).toBeCloseTo(
            (rig.player.ps.origin[2]! + rig.player.ps.viewheight) * WORLD_SCALE,
            6
        );
    });

    it('does not kick the view for health that merely drains away', () => {
        /*
         `ClientTimerActions` bleeds one point a second off health above
         `maxHealth`, and `ClientSpawn` hands you 125 -- so the first
         twenty-five seconds of every life are a health value falling once a
         second for reasons that have nothing to do with being shot.

         The first version of the view kick watched `inventory.health` fall
         between two steps and called any drop damage. `CG_DamageFeedback`
         clamps its kick *up* to five degrees, and one point of bleed is
         otherwise 0.3, so every one of those twenty-five ticks threw the view
         a full five degrees. It was reported as cyclic jerking of the aim on
         spawn that stopped by itself, which is precisely what it was.

         Q3 does not infer it: `CG_DamageFeedback` runs off `ps->damageEvent`,
         which `G_Damage` raises and `ClientTimerActions` does not.
        */
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();

        rig.player.inventory.health = 125;
        rig.player.writeCamera(rig.camera, 1);
        const level = [...rig.camera.forward];

        // Every point of the bleed, as `PickupSystem` applies it.
        for (let i = 0; i < 25; i++) {
            rig.player.inventory.health -= 1;
            rig.run(8); // ~64 ms, inside the kick's own 100 ms deflection
            rig.player.writeCamera(rig.camera, 1);

            expect(rig.camera.forward[1], `bleed ${i + 1} moved the view`)
                .toBeCloseTo(level[1]!, 9);
        }
    });

    it('does kick the view when something actually damages the player', () => {
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();

        rig.player.writeCamera(rig.camera, 1);
        const level = [...rig.camera.forward];

        // What `Arena.hit` and `WorldEffectSystem` call. `CG_DamageFeedback`
        // throws the head back, so the view pitches up.
        rig.player.damaged(40);
        rig.run(12); // ~96 ms: the peak of the deflection
        rig.player.writeCamera(rig.camera, 1);

        expect(rig.camera.forward[1]! - level[1]!).toBeGreaterThan(0.05);

        // ...and it comes back on its own.
        rig.run(80);
        rig.player.writeCamera(rig.camera, 1);
        expect(rig.camera.forward[1]).toBeCloseTo(level[1]!, 6);
    });

    it('leans into a strafe and stands level again', () => {
        /*
         `cg_runroll`, which is the half of `CG_OffsetFirstPersonView` a player
         feels most. Read off the camera's up vector rather than off the pose,
         because the rotation is where it can be lost: `orientToQ3Angles` used to
         build its basis from world-up and threw the roll away silently.
        */
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();

        rig.player.writeCamera(rig.camera, 1);
        const level = rig.camera.up[0];

        rig.devices.hold('d');
        rig.run(60);
        rig.player.writeCamera(rig.camera, 1);
        const right = [...rig.camera.up];

        rig.devices.release();
        rig.devices.hold('a');
        rig.run(60);
        rig.player.writeCamera(rig.camera, 1);
        const left = [...rig.camera.up];

        // Level to start with, and the two strafes tilt the head opposite ways.
        expect(level).toBeCloseTo(0, 6);
        expect(Math.sign(right[2]!)).toBe(-Math.sign(left[2]!));
        expect(Math.abs(right[2]!)).toBeGreaterThan(0.005);
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

        /*
         `PM_Footsteps` fires once per 128 units of `ps->bobCycle`, advanced at
         `bobmove * msec` -- 0.4 running -- so a stride is 320 ms and a second of
         running is three footsteps. Q3's truncation costs a few percent of that
         at any frame rate (`trunc(old + 3.2)` adds 3 at this rig's 8 ms tick),
         which is the difference between 3.1 strides and 2.9.

         Asserted on **both** solvers, which is the point of the range being
         tight: the shipping path retired `PM_Footsteps` and maintains the cycle
         itself, so this case is the only thing standing between the two paths
         and a gait that quietly disagrees. It ran at 6 to 7 a second before
         D-082, which is what "the footsteps are too frequent" was.
        */
        const stepped = rig.steps.filter((s) => s === 'step').length;
        expect(stepped, `footsteps in one second at ~${walked.toFixed(0)} u/s`)
            .toBeGreaterThanOrEqual(2);
        expect(stepped, `footsteps in one second at ~${walked.toFixed(0)} u/s`)
            .toBeLessThanOrEqual(4);
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
 * +speed, which is the shift key
 * ------------------------------------------------------------------ */

/*
 Shift was bound to crouch here, alongside ctrl and c, and Q3 does not do that:
 `cl_run` is on by default, so `+speed` is the *walk* modifier. It is one number
 in `CL_KeyMove` -- the command is filled with 64 rather than 127 -- and three
 consequences the player actually notices: about half the pace, a slower bob,
 and no footfall to be heard by.

 Asserted on both solvers, because the walk arrives at each of them differently:
 the ported path reads `BUTTON_WALKING` in `PM_Footsteps`, and the shipping path
 maintains the same cycle itself in `updateBobCycle`. A walk that is quiet on one
 and audible on the other is exactly the kind of split D-082 was.
*/
describe.each<Solver>(['meep', 'q3'])('PlayerController -> walking [%s]', (solver) => {
    /**
     * Hold forward down an open heading, walking or running.
     *
     * One rig at a time, and never two alive at once: pointer lock is a single
     * global here exactly as it is in a browser, so activating a second rig
     * deactivates the first -- which reads as a player who does not move, and
     * cost this test its first draft.
     */
    function forward(walk: boolean): Rig {
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();
        rig.face(openHeading('oa_dm1'));

        rig.devices.hold('w');
        if (walk) rig.devices.hold('shift');

        return rig;
    }

    /** Total advance of `ps.bobCycle` over `frames`, wraps included. */
    function bobAdvance(rig: Rig, frames: number): number {
        let total = 0;
        let previous = rig.player.ps.bobCycle;

        for (let i = 0; i < frames; i++) {
            rig.frame();
            const now = rig.player.ps.bobCycle;
            total += (now - previous + 256) & 255;
            previous = now;
        }

        return total;
    }

    it('walks at about half the pace, and does not crouch', () => {
        const running = forward(false);
        running.run(125);
        const runSpeed = running.player.speed;

        const walking = forward(true);
        walking.run(125);

        expect(runSpeed, 'a run is still a run').toBeGreaterThan(200);

        /*
         `PM_CmdScale` turns a 64-magnitude command into `ps.speed * 64/127`,
         which is 161 u/s. The band is wide because this is measured through a
         level -- the exact number is pinned on the motor, in meepmove.test.ts.
        */
        expect(walking.player.speed, 'walk speed').toBeGreaterThan(320 * 0.4);
        expect(walking.player.speed, 'walk speed').toBeLessThan(320 * 0.6);

        // And shift is not crouch: it was, and that is the binding this replaces.
        expect(walking.player.walking).toBe(true);
        expect(walking.player.ducked, 'shift ducked the player').toBe(false);
        expect(walking.player.ps.viewheight).toBe(C.DEFAULT_VIEWHEIGHT);
        expect(walking.player.maxs[2], 'the box shortened for a walk').toBe(STAND_MAXS[2]);

        // ...and ctrl still is, on the same rig, so neither key took the other's job.
        walking.devices.hold('ctrl');
        walking.run(30);
        expect(walking.player.ducked, 'ctrl stopped crouching').toBe(true);
    });

    it('gives the pace back when shift comes up', () => {
        /*
         The failure this port has already shipped once: a held modifier that
         never lets go, because the state it sets is latched somewhere instead
         of rebuilt from the key. `buttons` is zeroed and refilled every frame,
         and this is what says so from outside.
        */
        const rig = forward(true);
        rig.run(125);

        expect(rig.player.walking).toBe(true);
        const walked = rig.player.speed;

        rig.devices.hold('shift', false);
        rig.run(125);

        expect(rig.player.walking, 'still walking with shift released').toBe(false);
        expect(rig.player.speed, 'the pace never came back').toBeGreaterThan(walked * 1.5);
    });

    it('crosses the floor without being heard', () => {
        const running = forward(false);
        const ranBob = bobAdvance(running, 125);
        const ranSteps = running.steps.filter((s) => s === 'step').length;

        const walking = forward(true);
        const walkedBob = bobAdvance(walking, 125);

        expect(
            walking.player.speed, 'must be moving for the silence to mean anything'
        ).toBeGreaterThan(100);

        expect(ranSteps, 'a run is audible').toBeGreaterThanOrEqual(2);
        expect(walking.steps.filter((s) => s === 'step').length, 'a walk was heard')
            .toBe(0);

        /*
         Silent, not frozen: `bobmove` drops from 0.4 to 0.3 and the gun keeps
         swaying to it. A cycle that stopped would be silent too, and would be a
         different bug -- the weapon sway reads the same counter.
        */
        expect(walkedBob, 'the bob cycle stopped for a walk').toBeGreaterThan(0);
        expect(walkedBob, 'a walk bobbed as fast as a run').toBeLessThan(ranBob);
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
 * The mouse wheel
 *
 * D-076, and the same hole as the three above: a device signal whose shape the
 * port guessed at. `PointerDevice` dispatches `wheel.send3(delta, position,
 * event)`, the controller was written against `(delta, event)`, so the handler
 * read the pointer position as the event and threw on `preventDefault`. Because
 * meep's `Signal` swallows handler throws into `console.error`, the only symptom
 * in the game was a weapon that would not change.
 *
 * Solver-independent, so it runs once rather than on both paths.
 * ------------------------------------------------------------------ */

describe('PlayerController -> weapon cycling', () => {
    /** Three owned weapons, so that "up" and "down" have different answers. */
    const rigWithThree = (): Rig => {
        const rig = new Rig('oa_dm1', 'meep').settle();
        rig.activate();

        rig.player.inventory.weapons.add('WP_SHOTGUN');
        rig.player.inventory.ammo.WP_SHOTGUN = 10;
        expect(rig.player.weapon, 'the spawn weapon').toBe('WP_MACHINEGUN');

        return rig;
    };

    it('takes the delta the device sends, and does not touch the event', () => {
        const rig = rigWithThree();

        // The throw this covers happened before any weapon changed, so the
        // weapon assertion is the real one -- a green `not.toThrow` on its own
        // would also pass against a handler that did nothing at all.
        expect(() => rig.wheel(1)).not.toThrow();
        expect(rig.player.weapon, 'one notch down').toBe('WP_SHOTGUN');
    });

    it('cycles forward down the weapon order and back up it', () => {
        const rig = rigWithThree();

        rig.wheel(1);
        expect(rig.player.weapon).toBe('WP_SHOTGUN');

        rig.wheel(-1);
        expect(rig.player.weapon).toBe('WP_MACHINEGUN');

        rig.wheel(-1);
        expect(rig.player.weapon).toBe('WP_GAUNTLET');
    });

    it('skips weapons the player does not own, and wraps', () => {
        const rig = rigWithThree();

        // Past the shotgun there is nothing owned until the order wraps.
        rig.wheel(1);
        rig.wheel(1);
        expect(rig.player.weapon, 'wrapped past six unowned weapons').toBe('WP_GAUNTLET');
    });

    it('leaves the weapon alone on a horizontal scroll', () => {
        const rig = rigWithThree();

        rig.wheel(0, 1);
        expect(rig.player.weapon, 'sideways is not a weapon change').toBe('WP_MACHINEGUN');
    });

    it('ignores the wheel until the pointer is locked', () => {
        const rig = rigWithThree();
        rig.deactivate();

        rig.wheel(1);
        expect(rig.player.weapon, 'unlocked').toBe('WP_MACHINEGUN');
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

        // Through the recorder a `trigger_teleport` calls, not by writing `ps`
        // here: the deferral to the end of the frame is the part with a bug in
        // it, and a case that performs the write itself has already skipped it.
        rig.effects.teleport(destination, 90);

        rig.frame();

        expect(
            Math.hypot(ps.origin[0]! - destination[0]!, ps.origin[1]! - destination[1]!),
            'dragged back to where it was before the teleport'
        ).toBeLessThan(2);

        /*
         And the view goes with it, one frame later.

         The effects run after the solve, so `setYaw` lands on the command
         accumulator after this frame's `PM_UpdateViewAngles` has already read
         it. Q3 has the same one-frame structure for the same reason:
         `TeleportPlayer` writes `ps->delta_angles` and the *next* pmove turns
         it into a view angle. Asserted on the following frame rather than
         relaxed to "eventually", so a teleport that silently stopped turning
         the player still fails.
        */
        expect(ps.viewangles[1], 'view angle on the teleport frame').toBe(0);
        rig.frame();
        expect(ps.viewangles[1], 'view angle one frame later').toBeCloseTo(90, 1);

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
        const from = ps.origin[2]!;

        rig.effects.push([0, 0, 500]);
        rig.run(30);

        expect(ps.origin[2]! - from, 'height gained from a 500 u/s pad').toBeGreaterThan(50);
        expect(rig.player.onGround, 'still grounded after being launched').toBe(false);

        rig.run(220);
        expect(rig.player.onGround, 'never came back down').toBe(true);
    });

    it('mirrors health into ps.stats, and a corpse stops playing', () => {
        /*
         `Bot` writes `ps.stats[STAT_HEALTH]` every frame and `PlayerController`
         never did, so the player's copy held its spawn value for the whole
         game and the three places `bg_pmove` reads it never saw a dead player.

         The visible half is `PM_UpdateViewAngles`, which refuses to turn a
         corpse. Asserted on both paths because this one is not a bridge bug --
         it predates D-071 and was wrong on the ported path too.
        */
        const rig = new Rig('oa_dm1', solver).settle();
        rig.activate();
        rig.face(openHeading('oa_dm1'));

        rig.look(200, 0);
        rig.frame();

        expect(rig.player.ps.stats[C.STAT_HEALTH], 'health mirrored while alive')
            .toBe(rig.player.inventory.health);

        const aliveYaw = rig.player.ps.viewangles[1]!;
        expect(aliveYaw).not.toBe(0);

        // Killed by anything -- a rocket, a trigger_hurt, the void.
        rig.player.inventory.health = 0;
        rig.devices.hold('w');
        rig.devices.mouseButtonLeft.is_down = true;
        const restingAt = rig.origin;
        const shotsBefore = rig.shots.length;

        rig.look(400, 100);
        rig.run(60);

        expect(rig.player.ps.stats[C.STAT_HEALTH], 'health mirrored while dead').toBe(0);
        expect(rig.player.ps.viewangles[1], 'a corpse turned with the mouse')
            .toBeCloseTo(aliveYaw, 6);
        expect(rig.shots.length, 'a corpse kept firing').toBe(shotsBefore);
        expect(
            Math.hypot(rig.origin[0]! - restingAt[0]!, rig.origin[1]! - restingAt[1]!),
            'a corpse walked off holding forward'
        ).toBeLessThan(4);

        // And it all comes back on respawn -- at the angle it died at, not at
        // the angle two seconds of unread mouse movement would have produced.
        rig.player.inventory.health = 125;
        rig.devices.release();
        rig.frame();

        expect(rig.player.ps.viewangles[1], 'the view snapped on respawn')
            .toBeCloseTo(aliveYaw, 6);

        rig.look(100, 0);
        rig.frame();
        expect(rig.player.ps.viewangles[1], 'still frozen after respawn')
            .not.toBeCloseTo(aliveYaw, 6);
    });

    it('bills a trigger_hurt to the caller rather than to ps', () => {
        /*
         Damage is the one effect that does not land in `playerState_t`: health
         lives in the inventory, and `apply` returns the number so the caller
         can spend it. Asserted because a return value nobody reads is exactly
         how the mover events went missing in the first place.
        */
        const rig = new Rig('oa_dm1', solver).settle();

        rig.effects.hurt(15);
        rig.effects.hurt(10);
        rig.frame();

        expect(rig.damageTaken, 'damage from two triggers in one frame').toBe(25);

        // And it is not billed again on the next frame.
        rig.frame();
        expect(rig.damageTaken).toBe(25);
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

    it('walks the same gait, though only one of them still runs `PM_Footsteps`', () => {
        /*
         `ps->bobCycle` drives the footstep sounds and the view weapon's sway,
         and the kinematic path retired the function that advances it (D-071).
         `PlayerController` maintains it there instead, with the C's own
         arithmetic and the C's own truncation -- so the two paths are comparable
         tick for tick, and this is what says so. Reconstructing the cycle from
         some other quantity is what D-081 and D-082 were.
        */
        const { meep, q3 } = pair();

        for (const rig of [meep, q3]) {
            rig.activate();
            rig.devices.release();
            rig.devices.hold('w');
            rig.run(200);
        }

        expect(meep.player.ps.bobCycle, 'bobCycle after 200 running frames')
            .toBe(q3.player.ps.bobCycle);
        expect(meep.steps.filter((e) => e === 'step').length, 'footsteps')
            .toBe(q3.steps.filter((e) => e === 'step').length);

        // ...and stopping parks both at the start of a stride, not mid-swing.
        for (const rig of [meep, q3]) {
            rig.activate();
            rig.devices.release();
            rig.run(120);
        }

        expect(meep.player.ps.bobCycle, 'bobCycle at rest').toBe(0);
        expect(q3.player.ps.bobCycle, 'bobCycle at rest').toBe(0);
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

/* ------------------------------------------------------------------ *
 * The weapon rack, which is `CG_DrawWeaponSelect`'s timer
 * ------------------------------------------------------------------ */

describe('PlayerController -> the weapon rack', () => {
    /** Three owned weapons, one of them out of ammunition. */
    const rigWithRack = (): Rig => {
        const rig = new Rig('oa_dm1', 'meep').settle();
        rig.activate();

        rig.player.inventory.weapons.add('WP_SHOTGUN');
        rig.player.inventory.ammo.WP_SHOTGUN = 10;
        rig.player.inventory.weapons.add('WP_RAILGUN');
        rig.player.inventory.ammo.WP_RAILGUN = 0;

        return rig;
    };

    it('lists what you own in weapon_t order, whatever order you picked it up in', () => {
        const rig = rigWithRack();

        /*
         `WEAPON_ORDER`'s own sequence, not the pickup order: the rack is a rack
         and the gauntlet is always on the left. The railgun was added after the
         shotgun above and sits after it here because the enum says so.
        */
        expect(rig.player.ownedWeapons).toEqual([
            'WP_GAUNTLET',
            'WP_MACHINEGUN',
            'WP_SHOTGUN',
            'WP_RAILGUN',
        ]);
    });

    it('goes up on a switch and comes down on its own', () => {
        const rig = rigWithRack();

        // `settle` ran 250 frames, which is well past `WEAPON_SELECT_TIME`.
        expect(rig.player.weaponSelectVisible, 'idle').toBe(false);

        expect(rig.player.selectWeapon('WP_SHOTGUN')).toBe(true);
        expect(rig.player.weaponSelectVisible, 'just switched').toBe(true);

        // Q3's `WEAPON_SELECT_TIME` is 1400 ms. At 8 ms a frame, 150 frames is
        // 1200 -- still up -- and 200 is 1600, which is not.
        rig.run(150);
        expect(rig.player.weaponSelectVisible, 'after 1200 ms').toBe(true);

        rig.run(50);
        expect(rig.player.weaponSelectVisible, 'after 1600 ms').toBe(false);
    });

    it('is put back up by the wheel, which is the other way to switch', () => {
        const rig = rigWithRack();
        rig.run(200);
        expect(rig.player.weaponSelectVisible).toBe(false);

        rig.wheel(1);
        expect(rig.player.weaponSelectVisible).toBe(true);
    });

    it('restarts the timer on every switch rather than running from the first', () => {
        const rig = rigWithRack();

        rig.player.selectWeapon('WP_SHOTGUN');
        rig.run(150);
        rig.player.selectWeapon('WP_MACHINEGUN');

        // 1200 ms into the first switch and 0 into the second: a timer that ran
        // from the first would have 200 ms left, and this has the full 1400.
        rig.run(150);
        expect(rig.player.weaponSelectVisible).toBe(true);
    });

    it('stays down for a switch Q3 refuses -- an empty weapon is not selectable', () => {
        const rig = rigWithRack();
        rig.run(200);

        // `CG_WeaponSelectable`: owned, but no rounds.
        expect(rig.player.selectWeapon('WP_RAILGUN')).toBe(false);
        expect(rig.player.weapon).toBe('WP_MACHINEGUN');
        expect(rig.player.weaponSelectVisible).toBe(false);
    });
});
