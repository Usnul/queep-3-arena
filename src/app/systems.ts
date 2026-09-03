/*
 * systems.ts -- the game, as meep systems.
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
 * The port used to run its whole game on one `engine.ticker.onTick` listener: a
 * 153-line closure holding nine named phases, its own per-phase exception guard,
 * and four separate hand-rolled time accumulators. Every one of those is a
 * mechanism `EntityManager` already owns, and running the game outside it meant
 * running the game outside the engine's ordering, its error isolation, and its
 * fixed step.
 *
 * So the frame is systems now, split the way meep splits it:
 *
 *   `fixedUpdate` -- the simulation. Player, combat, pickups, bots, movers, in
 *   that registration order, each advanced by exactly
 *   `EntityManager.fixedUpdateStepSize` however long the frame took. Q3 ran its
 *   own game on a fixed server frame; this is that, on the engine's clock
 *   instead of on a private accumulator.
 *
 *   `update` -- presentation. HUD, view weapon, emitter retirement, item spin.
 *   Variable rate, once per rendered frame, and allowed to be.
 *
 * Two properties of `EntityManager.update` are load-bearing here and worth
 * stating rather than rediscovering:
 *
 * **Every `fixedUpdate` for a step runs before any `update`.** So the whole
 * simulation for a cycle has run before the first presentation system sees it,
 * and `ViewSystem` can blend the two steps either side of the display's clock
 * knowing both are already recorded.
 *
 * **Systems declaring no components tie, and ties keep registration order.**
 * `updateExecutionOrder` scores a system by its declared component access;
 * most of these declare none, so they score zero and `Array.prototype.sort`'s
 * stability decides -- which is a specified guarantee, not an accident. The
 * engine's own systems reference components, score above zero, and therefore
 * run first. That is the arrangement these want: `CameraSystem3` before the
 * presentation pass that reads the camera.
 *
 * **...which is exactly why {@link ViewSystem} does declare some.** The camera
 * pose has to be written *before* `CameraSystem3` copies it, and the only lever
 * on that is the score. It declares `Camera` and `Transform` for write,
 * `CameraSystem3` declares both for read, and a writer outranks a reader --
 * which needs *both* to be writes for a reason that is entirely in the
 * scoring's arithmetic and is written out at the declaration. That is the one
 * place where this port asks the scheduler for an ordering rather than taking
 * the one it is given, and `test/interpolation.test.ts` holds it to it.
 */

import { System } from '@woosh/meep-engine/src/engine/ecs/System.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { Camera } from '@woosh/meep-engine/src/engine/graphics/ecs/camera/Camera.js';
import { ResourceAccessKind } from '@woosh/meep-engine/src/core/model/ResourceAccessKind.js';
import { ResourceAccessSpecification } from '@woosh/meep-engine/src/core/model/ResourceAccessSpecification.js';
import {
    INTERPOLATION_KEY_UNSET,
    Interpolated,
} from '@woosh/meep-engine/src/engine/interpolation/Interpolated.js';
import { InterpolationLog } from '@woosh/meep-engine/src/engine/interpolation/InterpolationLog.js';
import type { InterpolationSystem } from '@woosh/meep-engine/src/engine/interpolation/InterpolationSystem.js';

import type { Arena } from '../client/Arena.ts';
import type { AudioBank, BodyState } from '../client/Audio.ts';
import { BodySounds } from '../client/Audio.ts';
import type { BotRuntime } from '../client/Bots.ts';
import type { CharacterBodies } from '../client/CharacterBody.ts';
import { APP_INTERPOLATION_SOURCE } from '../client/interpolation.ts';
import type { CameraLens, LensSurface } from '../client/lens.ts';
import type { Hud } from '../client/Hud.ts';
import type { ItemsView } from '../client/ItemsView.ts';
import type { MoversView } from '../client/MoversView.ts';
import type { PlayerController, TransformLike } from '../client/PlayerController.ts';
import type { CameraPose, ViewWeapon } from '../client/ViewWeapon.ts';
import { ItemSystem, newInventory } from '../game/Items.ts';
import type { MoverSystem } from '../game/Movers.ts';
import type { WorldEffects } from '../game/WorldEffects.ts';

/**
 * The player: movement, firing, death, and the sounds their own body makes.
 *
 * Registered first, so it runs first, for the reason Q3 runs clients before the
 * rest of the entity list -- everything downstream tests against where the
 * player is *now*.
 */
export class PlayerSystem extends System<never> {
    private readonly player: PlayerController;
    private readonly arena: Arena;
    private readonly audio: AudioBank;
    private readonly spawns: readonly (readonly number[])[];

    private readonly sounds: BodySounds;

    /** Seconds until the player respawns; negative means alive. */
    private respawnIn = -1;

    constructor(options: {
        player: PlayerController;
        arena: Arena;
        audio: AudioBank;
        spawns: readonly (readonly number[])[];
    }) {
        super();

        this.player = options.player;
        this.arena = options.arena;
        this.audio = options.audio;
        this.spawns = options.spawns;
        this.sounds = new BodySounds(options.audio);
    }

    override fixedUpdate = (deltaSeconds: number): void => {
        const player = this.player;

        player.update(deltaSeconds);

        this.mortality(deltaSeconds);
        this.bodySounds();
    };

    /** `player_die` and `ClientSpawn`, minus the spawn-point scoring. */
    private mortality(deltaSeconds: number): void {
        const player = this.player;

        if (player.inventory.health <= 0 && this.respawnIn < 0) {
            this.respawnIn = 2;
            this.arena.deathExplosion(player.ps.origin);
            this.audio.play('impact/flesh', player.ps.origin);
        }

        if (this.respawnIn < 0) return;

        this.respawnIn -= deltaSeconds;
        if (this.respawnIn >= 0) return;

        /*
         `ClientSpawn`, minus the spawn-point selection Q3 does with
         `SelectSpawnPoint` -- which scores every point by distance from the
         nearest enemy so you do not materialise in front of one. A random point
         is the honest simplification.
        */
        const spawnPoint = this.spawns[(Math.random() * this.spawns.length) | 0] ?? [0, 0, 0];

        player.ps.origin[0] = spawnPoint[0]!;
        player.ps.origin[1] = spawnPoint[1]!;
        player.ps.origin[2] = spawnPoint[2]! + 9;
        player.ps.velocity[0] = 0;
        player.ps.velocity[1] = 0;
        player.ps.velocity[2] = 0;

        const fresh = newInventory();
        player.inventory.health = fresh.health;
        player.inventory.armor = 0;
        player.inventory.weapons.clear();
        for (const w of fresh.weapons) player.inventory.weapons.add(w);
        for (const key of Object.keys(player.inventory.ammo)) {
            delete player.inventory.ammo[key];
        }
        Object.assign(player.inventory.ammo, fresh.ammo);
        player.selectWeapon('WP_MACHINEGUN');
    }

    /**
     * Footsteps and the weapon-change click.
     *
     * On the fixed step rather than the render frame because both are edge
     * detectors over `ps.bobCycle`, which only advances on the fixed step: run
     * at render rate they would fire twice for one stride at high frame rates
     * and miss strides at low ones.
     *
     * The detectors themselves moved to `BodySounds` when a joined client turned
     * out to have none of this -- `PlayerSystem` is not registered there, so the
     * player heard everybody's footsteps except their own. Shared rather than
     * copied, because the thing being shared is a pair of edge detectors and two
     * copies of an edge detector drift.
     */
    private bodySounds(): void {
        this.sounds.update(bodyStateOf(this.player));
    }
}

/**
 * `BodyState` off a `PlayerController`, for whichever branch is driving one.
 *
 * Exported because both are: `PlayerSystem` above and `NetClientSystem`, which
 * runs the same call once per session tick. A function rather than a method on
 * the controller because it is a view *for the sound layer*, and the controller
 * already has more surface than it needs.
 */
export function bodyStateOf(player: PlayerController): BodyState {
    return {
        bobCycle: player.ps.bobCycle,
        onGround: player.onGround,
        ducked: player.ducked,
        walking: player.walking,
        originQ3: player.ps.origin,
        weapon: player.weapon,
    };
}

/**
 * The camera, once per **rendered frame**, ahead of the system that reads it.
 *
 * This exists because of an ordering fact and a rendering one.
 *
 * The rendering one: a fixed-step camera makes the whole world judder. Measured
 * on `am_thornish` at 165 Hz with the pose written from `PlayerSystem.fixedUpdate`,
 * the camera's x held for two or three frames and then moved 0.167 m, forever.
 * Static geometry drawn through that camera steps at 60 Hz; a missile carrying
 * `Interpolated` does not, because meep blends it -- so the one object on screen
 * that moved smoothly was the one being watched, against a world that did not.
 * That is what was reported as "projectiles move with jerks", and the projectile
 * was the messenger.
 *
 * The ordering one: `CameraSystem3` copies the camera entity's `Transform` onto
 * Shade's camera in its own `update`, so a pose written after it is a frame late
 * (D-081's first half). It has to be written *before* it, and meep decides that
 * by declared component access rather than by registration order.
 * `updateExecutionOrder` scores each referenced component by the incoming edges
 * on the component dependency graph, times four for Create, two for Write, one
 * for Read -- so a system that **writes** `Transform` sorts above one that only
 * reads it, which `CameraSystem3` does. Measured rather than assumed:
 * `test/interpolation.test.ts` pins the resulting order, and the declaration
 * here is honest rather than tactical, because writing the camera entity's
 * transform is exactly what this does.
 *
 * `dependencies` stays empty on purpose. Declaring `[Camera, Transform]` would
 * make the engine link every camera entity through `link`, and the one this
 * drives is handed over at construction; `components_used` is the half of the
 * declaration that carries the access, which is the half the scheduler reads.
 */
export class ViewSystem extends System<never> {
    /**
     * Both for write, and both are written: the camera entity's `Transform` is
     * the pose, and `Camera.fov` is `cg_fov` through `CameraLens`.
     *
     * Declaring the second one matters beyond honesty, and it is worth saying
     * why because it is not obvious. `computeSystemComponentDependencyGraph`
     * draws an edge from each component a system *writes* to each one it
     * *reads*, and `scoreSystem` weighs each referenced component by the
     * incoming edges on it. A system that reads both components and writes one
     * contributes an edge in one direction only, so the component it writes can
     * end up with no incoming edges at all -- and then a `Write` on it scores
     * exactly what a `Read` does, twice zero being zero, and the tie falls back
     * to registration order. Writing both puts an edge in each direction, which
     * gives both components an in-degree and makes the write weighting actually
     * bite. Found by writing the ordering test against a rig containing only
     * this system and `CameraSystem3`, where it tied.
     */
    override components_used = [
        ResourceAccessSpecification.from(
            Camera,
            ResourceAccessKind.Read | ResourceAccessKind.Write
        ),
        ResourceAccessSpecification.from(
            Transform,
            ResourceAccessKind.Read | ResourceAccessKind.Write
        ),
    ];

    private readonly player: PlayerController;
    private readonly cameraTransform: TransformLike;
    private readonly lens: CameraLens;
    private readonly surface: LensSurface;
    private readonly alpha: (() => number) | null;

    constructor(options: {
        player: PlayerController;
        cameraTransform: TransformLike;
        lens: CameraLens;
        /** The renderer's own camera, which is where the aspect ratio lives. */
        surface: LensSurface;
        /**
         * How far between the two recorded eye poses to blend, when it is not
         * the engine's own fixed-step fraction.
         *
         * **The two have to describe the same interval or the camera judders**,
         * and on a joined client they do not: the poses are recorded once per
         * *session* step (see `NetClientSystem`), and `getFixedStepAlpha` sweeps
         * over an *engine* step, which is half as long at the shipping rates. An
         * alpha that reaches 1 halfway through the interval it is blending runs
         * the whole camera move in the first half and repeats it in the second.
         *
         * Null on the single-player branch, where the two rates are the same
         * clock and the engine's own fraction is exactly right.
         */
        alpha?: (() => number) | null;
    }) {
        super();

        this.player = options.player;
        this.cameraTransform = options.cameraTransform;
        this.lens = options.lens;
        this.surface = options.surface;
        this.alpha = options.alpha ?? null;
    }

    override update = (): void => {
        const em = this.entityManager;

        /*
         The sub-step fraction, which is what turns two recorded poses into a
         smooth one. Defaulting to 1 rather than 0 matters for the frame before
         the first step has run: 1 is "show the newest pose", which is what a
         camera with no history should do.
        */
        const alpha =
            this.alpha?.() ?? (em === null || em === undefined ? 1 : em.getFixedStepAlpha());

        this.player.writeCamera(this.cameraTransform, alpha);

        // `CG_CalcFov`, which needs the aspect of the surface actually drawn to
        // and therefore cannot be answered once at startup. See `lens.ts`.
        this.lens.apply(this.surface);
    };
}

/** Projectiles, hitscan cooldowns, decay of marks, and target respawn. */
export class CombatSystem extends System<never> {
    private readonly arena: Arena;

    constructor(arena: Arena) {
        super();
        this.arena = arena;
    }

    override fixedUpdate = (deltaSeconds: number): void => {
        this.arena.update(deltaSeconds);
    };
}

/**
 * The last thing picked up, as the status bar reads it.
 *
 * Two getters rather than `PickupSystem` itself, because on the networked
 * branch there is no `PickupSystem`: items are the host's, the pickup arrives as
 * a `PickupEvent`, and `NetTransients` is what turns it into a sound and a name.
 * Both satisfy this, and `PresentationSystem` does not need to know which one it
 * was handed.
 */
export interface PickupLabel {
    /** `CG_ItemPickup`'s text: `50 Armor`, `Rocket Launcher`, or empty. */
    readonly pickupLabel: string;
    /** How long it has been up. The status bar fades it out. */
    readonly pickupAgeSeconds: number;
}

/**
 * Item respawn, pickup, and Q3's once-a-second inventory bleed.
 *
 * `ClientTimerActions` runs on a 1000 ms cadence rather than per frame -- health
 * above max bleeds off one point a second, and doing it per frame would drain a
 * 200-health player in three seconds at 60 fps. It used to need an accumulator
 * in `main` to say so; on a fixed step it is a counter of steps.
 */
export class PickupSystem extends System<never> implements PickupLabel {
    private readonly items: ItemSystem;
    private readonly itemsView: ItemsView;
    private readonly player: PlayerController;
    private readonly audio: AudioBank;

    private stepsThisSecond = 0;
    private stepsPerSecond = 0;

    /** Most recent pickup name and its age, which is all the HUD wants. */
    private label = '';
    private age = 99;

    constructor(options: {
        items: ItemSystem;
        itemsView: ItemsView;
        player: PlayerController;
        audio: AudioBank;
    }) {
        super();

        this.items = options.items;
        this.itemsView = options.itemsView;
        this.player = options.player;
        this.audio = options.audio;
    }

    get pickupLabel(): string {
        return this.label;
    }

    get pickupAgeSeconds(): number {
        return this.age;
    }

    override fixedUpdate = (deltaSeconds: number): void => {
        const player = this.player;

        for (const event of this.items.update(
            deltaSeconds,
            player.ps.origin,
            player.inventory,
            true
        )) {
            this.label = event.label;
            this.age = 0;
            // `Touch_Item` plays the pickup sound to the picker only, dry.
            this.audio.playLocal(`item/${event.item.def.classname}`);
            if (event.selectWeapon !== null) {
                player.selectWeapon(event.selectWeapon);
            }
        }

        this.age += deltaSeconds;

        // A whole second of steps, counted rather than accumulated: the step
        // size is exact, so this cannot drift the way a float sum does.
        if (this.stepsPerSecond === 0) {
            this.stepsPerSecond = Math.max(1, Math.round(1 / deltaSeconds));
        }
        this.stepsThisSecond += 1;
        if (this.stepsThisSecond >= this.stepsPerSecond) {
            this.stepsThisSecond = 0;
            ItemSystem.tickSecond(player.inventory);
        }
    };

    /** The spin and the bob are presentation, and run at render rate. */
    override update = (): void => {
        this.itemsView.update(this.items.now);
    };
}

/** Bot perception, planning and movement -- one `usercmd_t` each, per step. */
export class BotSystem extends System<never> {
    private readonly bots: BotRuntime;
    private readonly items: ItemSystem;

    /** Sub-millisecond remainder, carried exactly as `PlayerController` carries it. */
    private msecCarry = 0;

    constructor(bots: BotRuntime, items: ItemSystem) {
        super();
        this.bots = bots;
        this.items = items;
    }

    override fixedUpdate = (deltaSeconds: number): void => {
        /*
         Whole milliseconds, carried -- the same arithmetic `PlayerController`
         does, from the same fixed step, so the two produce the same sequence.

         That is not tidiness. `Bot.think` adds this straight onto the integer
         `usercmd_t.serverTime`, and its own docblock says the accumulation is in
         whole milliseconds *so that the bot and the player advance on the same
         clock, or a bot's acceleration curve differs from a player's by the
         fractional part of a frame*. `main` used to hand it `deltaSeconds *
         1000` -- a float, varying with the frame rate -- while
         `match.test.ts` handed it exactly 8. So the browser and the test were
         not running the same bots, and the browser was not running the docblock.
        */
        this.msecCarry += deltaSeconds * 1000;
        const msec = Math.floor(this.msecCarry);
        this.msecCarry -= msec;

        this.bots.update(deltaSeconds, msec, this.items.items);
    };
}

/** Doors, plats, buttons, triggers, and everything they do to the player. */
export class WorldEffectSystem extends System<never> {
    private readonly effects: WorldEffects;
    private readonly player: PlayerController;
    private readonly movers: MoverSystem;
    private readonly moversView: MoversView;

    constructor(options: {
        effects: WorldEffects;
        player: PlayerController;
        movers: MoverSystem;
        moversView: MoversView;
    }) {
        super();

        this.effects = options.effects;
        this.player = options.player;
        this.movers = options.movers;
        this.moversView = options.moversView;
    }

    override fixedUpdate = (deltaSeconds: number): void => {
        const world = this.effects.apply(this.player, this.movers, deltaSeconds);

        this.moversView.update();

        if (world.damage > 0) {
            this.player.inventory.health -= world.damage;
            // The other half of `EV_DAMAGE`: a `trigger_hurt` kicks the view
            // the same way a rocket does. See `PlayerController.damaged`.
            this.player.damaged(world.damage);
        }
    };
}

/**
 * Everything the player looks at rather than plays: the gun in their hands, the
 * status bar, and the retirement of finished one-shot emitters.
 *
 * Runs on `update`, so it is once per rendered frame and gets that frame's real
 * delta -- which the view weapon's sway and the pickup fade both want.
 */
export class PresentationSystem extends System<never> {
    private readonly viewWeapon: ViewWeapon;
    private readonly renderCamera: () => CameraPose;
    private readonly player: PlayerController;
    private readonly audio: AudioBank;
    private readonly hud: Hud;
    private readonly pickups: PickupLabel;
    private readonly arena: Arena;
    private readonly describe: () => { map: string; backend: string };

    constructor(options: {
        viewWeapon: ViewWeapon;
        renderCamera: () => CameraPose;
        player: PlayerController;
        audio: AudioBank;
        hud: Hud;
        /**
         * `PickupSystem` in single-player and `NetTransients` on a joined
         * client, which is the only difference between the two status bars.
         */
        pickups: PickupLabel;
        arena: Arena;
        describe: () => { map: string; backend: string };
    }) {
        super();

        this.viewWeapon = options.viewWeapon;
        this.renderCamera = options.renderCamera;
        this.player = options.player;
        this.audio = options.audio;
        this.hud = options.hud;
        this.pickups = options.pickups;
        this.arena = options.arena;
        this.describe = options.describe;
    }

    override update = (deltaSeconds: number): void => {
        const player = this.player;

        /*
         `graphics.camera.camera.transform`, and **not** the camera entity's.

         They hold different poses whenever the player is turning. `CameraSystem3`
         copies the camera entity onto Shade's camera during its own `update`,
         and it references components so it sorts ahead of this one -- so by the
         time this line runs, the renderer's camera is the pose `ViewSystem`
         wrote for *this* frame and is the pose the frame will be drawn with.
         Not the fixed step's: the eye is blended and the angles are the live
         accumulator (D-081, D-155), and the gun inherits both by reading the
         camera rather than `ps`. A gun placed from
         anything else is a tick of mouse movement away from the view it is
         welded to, and swings across the screen by however far you just turned
         (D-081).
        */
        this.viewWeapon.update(this.renderCamera(), deltaSeconds, {
            weapon: player.weapon,
            speed: player.speed,
            // The same counter the footstep sounds read: Q3 has one gait, not two.
            bobCycle: player.ps.bobCycle,
            // No gun for a corpse. Q3 switches to a death camera instead, which
            // this port has no equivalent of.
            visible: !player.dead,
            // `EF_FIRING`, for the barrel spin: the trigger is held, which is
            // not the same question as a shot having been fired.
            firing: player.firing,
        });

        // Retire the emitter entities whose one-shot finished last frame.
        this.audio.update();

        const described = this.describe();

        this.hud.update({
            mode: player.active ? 'play' : 'click-to-play',
            onGround: player.onGround,
            map: described.map,
            weapon: player.weapon,
            damage: this.arena.totalDamage,
            kills: this.arena.kills,
            deaths: this.arena.deaths,
            backend: described.backend,
            health: player.inventory.health,
            armor: player.inventory.armor,
            ammo: player.inventory.ammo[player.weapon] ?? 0,
            pickup: this.pickups.pickupLabel,
            pickupAgeSeconds: this.pickups.pickupAgeSeconds,
            /*
             `CG_DrawWeaponSelect`: the rack, and the ammo each entry has.
             Rebuilt per frame rather than pushed on a change, because both the
             list and the counts move for reasons other than a weapon switch --
             picking a gun up, firing the one in hand -- and a HUD that is only
             told about switches shows a stale rack for the 1.4 seconds it is up.
            */
            weaponSelect: player.weaponSelectVisible,
            weapons: player.ownedWeapons,
            weaponAmmo: player.inventory.ammo,
        });
    };
}

/**
 * `?fly=1`: a noclip camera and the status bar, and no game at all.
 *
 * On `update` rather than the fixed step, and deliberately: this is the tool the
 * conversions are inspected with, so a camera that moves as smoothly as the
 * display allows is worth more than one that is a step fresher. It costs the
 * frame the pose was written for -- `CameraSystem3` sorts ahead of this and has
 * already copied the previous one -- which is exactly what the arrangement it
 * replaces cost, and nothing is being aimed.
 */
export class FlySystem extends System<never> {
    private readonly fly: { update(deltaSeconds: number): void };
    private readonly audio: AudioBank;
    private readonly hud: Hud;
    private readonly map: string;
    private readonly lens: CameraLens;
    private readonly surface: LensSurface;

    constructor(options: {
        fly: { update(deltaSeconds: number): void };
        audio: AudioBank;
        hud: Hud;
        map: string;
        lens: CameraLens;
        surface: LensSurface;
    }) {
        super();

        this.fly = options.fly;
        this.audio = options.audio;
        this.hud = options.hud;
        this.map = options.map;
        this.lens = options.lens;
        this.surface = options.surface;
    }

    override update = (deltaSeconds: number): void => {
        this.fly.update(deltaSeconds);
        this.audio.update();
        this.hud.update({
            mode: 'fly', onGround: false, map: this.map,
            weapon: '', damage: 0, kills: 0, deaths: 0, backend: 'noclip',
            health: 0, armor: 0, ammo: -1, pickup: '', pickupAgeSeconds: 99,
            weaponSelect: false, weapons: [], weaponAmmo: {},
        });

        // The noclip camera is a camera too, and `cg_fov` is still the lens.
        this.lens.apply(this.surface);
    };
}

export { APP_INTERPOLATION_SOURCE, interpolatedBody, interpolatedPose } from '../client/interpolation.ts';

/**
 * The interpolation source for poses this application writes itself.
 *
 * Not {@link INTERPOLATION_SOURCE_LOCAL}: that timeline is `PhysicsSystem`'s,
 * and an `InterpolationLog` admits exactly one producer per tick --
 * `begin_tick` throws while a tick is open, and the metadata pages are built on
 * the assumption that a tick's records are contiguous. So the app gets its own
 * log and registers it as a second source, which is the seam
 * {@link InterpolationSystem.registerSource} exists for. The network layer
 * registers its render-delayed playout the same way; this registers the fixed
 * step it already shares with physics, which makes the two timelines identical
 * in content and separate only in ownership.
 */
/**
 * Record the pose of every app-driven `Interpolated` entity, once per fixed step.
 *
 * A bot's drawn body and a door's geometry are written from the simulation on
 * the fixed step, so at any render rate above the step rate they hold the same
 * pose for several frames and then jump. `PhysicsSystem` solves this for its own
 * bodies by recording each step into the interpolation log and letting
 * `InterpolationSystem` blend at render time; this does the same job for the
 * poses physics does not own.
 *
 * **Registered last among the simulation systems**, because it snapshots what
 * they wrote.
 *
 * There is no restore pass to match `PhysicsSystem.__interp_restore`, and that
 * rests on an invariant every producer here has to keep: **a view writes its
 * transform from the simulation on every step, including the steps where the
 * simulation did not move.** Between two steps the transform holds a *blended*
 * pose rather than an authoritative one, so a view that skips a write because
 * its own source has not changed leaves the blend in place -- and the next
 * snapshot records the blend, which feeds the next blend, and a stationary door
 * walks away from where the game says it is. `MoversView.update` used to have
 * exactly that early-out; `test/interpolation.test.ts` holds both halves, the
 * one that stays still and the one that drifts.
 */
export class PoseRecorderSystem extends System<never> {
    readonly log = new InterpolationLog();

    /**
     * Hand the log to `InterpolationSystem` and say how to read it: the window
     * is the last two completed fixed steps at the engine's own sub-step alpha,
     * which is the local timeline's window exactly.
     */
    attachTo(interpolation: InterpolationSystem): void {
        interpolation.registerSource(APP_INTERPOLATION_SOURCE, this.log, () => {
            const em = this.entityManager;
            const tick = em.fixedStepTick;
            return { tick_a: tick - 1, tick_b: tick, t: em.getFixedStepAlpha() };
        });
    }

    /**
     * No `dependencies`, and that is deliberate rather than lazy.
     *
     * Declaring `[Interpolated]` would be the obvious way to get the entity set,
     * and it would put this system *ahead* of the simulation: a system that
     * references a component scores above one that references none, so it would
     * be scheduled to snapshot poses before the step that writes them. The
     * dataset can be asked for the same set directly, which keeps this at zero
     * and therefore in registration order -- last, after everything it records.
     */
    override fixedUpdate = (): void => {
        const em = this.entityManager;
        const dataset = em?.dataset ?? null;
        if (dataset === null) return;

        const log = this.log;
        let open = false;

        dataset.traverseComponents(Interpolated, (interpolated: Interpolated, entity: number) => {
            if (interpolated.sourceId !== APP_INTERPOLATION_SOURCE) return;

            /*
             `InterpolationSystem.link` assigns the entity id when the key is
             unset, and it links the same entities this walks. Nothing orders
             the two, so this does it too rather than depending on which ran.
            */
            if (interpolated.key === INTERPOLATION_KEY_UNSET) interpolated.key = entity;

            // Opened lazily: `begin_tick` reserves a tick's worth of both rings
            // and squashes the oldest to make room, which is not work to do on
            // a frame with nothing on this timeline to record.
            if (!open) {
                log.begin_tick(em.fixedStepTick);
                open = true;
            }

            for (const interpoland of interpolated.interpolands) {
                const target = dataset.getComponent(entity, interpoland.component_class);
                if (target === undefined || target === null) continue;

                const buffer = log.begin_record(interpolated.key, interpoland.type_id);
                interpoland.serialization_adapter.serialize(buffer, target);
                log.end_record();
            }
        });

        if (open) log.end_tick();
    };
}

/**
 * Write every character's collision pose from the simulation that produced it.
 *
 * Registered after the player and the bots have moved, and before anything
 * queries the broadphase for the next step. The staleness that leaves is Q3's
 * own: `G_RunFrame` runs clients in entity order, so a client's move is resolved
 * against where the others were at the end of the previous frame, and the first
 * client in the list has always been a step ahead of the last.
 */
export class CharacterBodySystem extends System<never> {
    private readonly bodies: CharacterBodies;

    constructor(bodies: CharacterBodies) {
        super();
        this.bodies = bodies;
    }

    override fixedUpdate = (): void => {
        this.bodies.sync();
    };
}
