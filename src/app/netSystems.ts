/*
 * netSystems.ts -- the client frame of NETWORK_PLAN.md section 3.3, as systems.
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
 * What replaces `PlayerSystem`, `CombatSystem`, `PickupSystem`, `BotSystem` and
 * `WorldEffectSystem` when the browser joins a host instead of running its own
 * match. Everything those five did is the host's now; what is left on this side
 * is a session to drive, a world to copy out of it, and a render pass.
 *
 * The split across `fixedUpdate` and `update` is the same one `systems.ts`
 * describes and relies on the same two guarantees: every `fixedUpdate` for a
 * step runs before any `update`, and systems declaring no components keep their
 * registration order. So the session steps, the world is copied out of it while
 * every replicated component is still canonical, and only then does the render
 * pass blend them for the picture.
 *
 * Missiles are here too, through a second pool. `MissileView.spawn` hangs its
 * model on an entity that already exists in the *render* dataset and already
 * has a `Transform` -- in single-player that is the physics body the missile
 * flies as -- and a joined client has no such body, because the position is
 * replicated and `NetClient`'s pool lives in its own `EntityManager`. So the
 * application keeps one render entity per pool slot and this writes the
 * replicated origin into it. GAP-046 was that gap; this closes it.
 */

import { System } from '@woosh/meep-engine/src/engine/ecs/System.js';

import type { NetClient } from '../client/net/NetClient.ts';
import type { PlayerController } from '../client/PlayerController.ts';
import type { ItemSystem } from '../game/Items.ts';
import { Character, type LegsAnimation, type TorsoAnimation } from '../client/Characters.ts';
import { NET_WEAPONS } from '../net/components.ts';
import { SESSION_TICK_SECONDS } from '../net/protocol.ts';

/**
 * Slack on the accumulator's comparison, and it is not superstition.
 *
 * `EntityManager.fixedUpdateStepSize` is `0.016666666666`, which is *less* than
 * `1 / 60` -- `SESSION_TICK_SECONDS`' own docblock is about this. So two engine
 * steps come to 0.033333333332 against a 30 Hz period of 0.03333333333..., and
 * an exact `>=` would fall short by 3.4e-10 seconds every single time and run
 * the session at nothing at all. A microsecond of slack absorbs an error eight
 * orders of magnitude smaller than itself and is far below anything a frame
 * clock decides.
 */
const CLOCK_EPSILON_SECONDS = 1e-6;

/**
 * Session steps one fixed update may run. Two is the engine-to-session ratio
 * at the shipping rates; four leaves room to catch up from a hitch without
 * letting a long stall turn into a burst that stalls again.
 */
const MAX_SESSION_STEPS_PER_UPDATE = 4;
import * as C from '../q3/pmove/constants.ts';

/**
 * The session's step, paced to real time, and the presentation clock beside it.
 *
 * `NetClient.step` is `session.tick` plus the `normalize_if_dirty` that undoes
 * the previous render pass's blending; the session runs 0 to 3 simulation
 * steps inside it depending on time dilation, and each one that runs samples
 * this player's input, predicts it, records its bytes and sends it.
 *
 * **The accumulator is the whole point of this class, and it was not here.**
 * `fixedUpdate` runs at the *engine's* rate and `NetClient.step` advances the
 * session by exactly one *session* period, so calling it once per fixed update
 * silently asserts that the two rates are the same. They were, at 60 Hz, and
 * the day the session dropped to 30 that call started running the client's
 * simulation at twice real time: permanently ahead of the host, every AUTH_STATE
 * arriving for a frame it had already predicted past, `TimeDilation` fighting a
 * clock it cannot slow down that far, and the constant mis-prediction and
 * resimulation that produces. `WsHost` has paced itself against its own period
 * since step 5; this is the same loop, and its absence here was a bug waiting
 * for a rate change to find it.
 *
 * The rig cannot catch this. `NetRig.step` drives the host and each client one
 * call apiece, so both advance one frame per iteration whatever either rate is
 * -- which is right for measuring the protocol and blind to how it is driven.
 * `test/net-clock.test.ts` is where the pacing is held instead.
 *
 * `updatePresentation` stays outside the loop, once per fixed update rather
 * than once per session tick: it is the view kick, the weapon rack's countdown
 * and the eye-pose history the camera is blended from, all measured in
 * wall-clock milliseconds, and none of them is rolled back by a reconciliation.
 */
export class NetClientSystem extends System<never> {
    private readonly client: NetClient;
    private readonly player: PlayerController;

    constructor(options: { client: NetClient; player: PlayerController }) {
        super();

        this.client = options.client;
        this.player = options.player;
    }

    override fixedUpdate = (deltaSeconds: number): void => {
        this.accumulator += deltaSeconds;

        let steps = 0;
        while (this.accumulator + CLOCK_EPSILON_SECONDS >= SESSION_TICK_SECONDS) {
            if (steps >= MAX_SESSION_STEPS_PER_UPDATE) {
                /*
                 Behind by more than the catch-up budget. Thrown away rather
                 than carried, for `WsHost`'s reason: carrying arrears means
                 running the cap again next frame and never catching up, while
                 dropping them costs one jump. A tab that was backgrounded is
                 the usual cause.
                */
                this.accumulator = 0;
                this.droppedSteps += 1;
                break;
            }

            this.accumulator -= SESSION_TICK_SECONDS;
            this.client.step();
            steps += 1;
        }

        this.player.updatePresentation(deltaSeconds);
    };

    /** Unspent time, in seconds. See the class docblock. */
    private accumulator = 0;

    /** How often this has had to throw arrears away; read by `window.queep.net`. */
    droppedSteps = 0;
}

/**
 * The replicated world, copied into the objects the rest of the port reads.
 *
 * Two things, and the plan's section 3.3 lists a third this host has not got:
 *
 * **Items.** `NetItem.present` is the host's authority on whether a shard is
 * standing there, and `ItemsView` polls `ItemInstance.present` every render
 * frame -- so one assignment is the whole of item presentation on a client, and
 * the client never runs a respawn timer of its own.
 *
 * **Bodies.** Every slot's `CharacterSlot` follows its replicated origin
 * through a closure `NetClient` installed; `sync()` is what pushes those into
 * the broadphase. Without it a remote player is a position in a component and
 * nothing the local player can walk into.
 *
 * **Movers, which are absent.** `NetMover` and its adapter exist and the host
 * replicates nothing into them, because `HeadlessPhysics` builds model 0 only
 * and a headless host therefore has no kinematic brush entities to move. See
 * GAP-041; when the host grows them this system gains the third loop and the
 * wire format does not change.
 */
export class NetWorldSystem extends System<never> {
    private readonly client: NetClient;
    private readonly items: ItemSystem;

    constructor(options: { client: NetClient; items: ItemSystem }) {
        super();

        this.client = options.client;
        this.items = options.items;
    }

    override fixedUpdate = (): void => {
        const items = this.items.items;

        for (const entry of this.client.items) {
            const item = items[entry.component.index];
            if (item === undefined) continue;
            item.present = entry.component.present === 1;
        }

        this.client.syncBodies();
    };
}

/**
 * The render pass, at render rate.
 *
 * `session.tick(0)` runs no simulation step -- the accumulator is untouched by
 * a zero -- and ends in `#render_interpolated_entities`, which writes blended
 * values into every remote-owned component from the interpolation log, sampled
 * behind `AdaptiveRenderDelay`. That is how a remote player moves smoothly at
 * 144 Hz off a 60 Hz stream without this port interpolating anything itself.
 *
 * It leaves those components holding numbers that are right for a picture and
 * wrong for a simulation, which is why the next `NetClient.step` normalizes
 * before it does anything else.
 */
export class NetRenderSystem extends System<never> {
    private readonly client: NetClient;

    constructor(options: { client: NetClient }) {
        super();

        this.client = options.client;
    }

    override update = (): void => {
        this.client.session.tick(0);
    };
}

/* ------------------------------------------------------------------ *
 * Remote players
 * ------------------------------------------------------------------ */

/**
 * As much of a character as the networked presentation drives.
 *
 * Narrow on purpose, and the reason is not tidiness: the browser this port is
 * developed in cannot start a renderer, so a system typed against `Character`
 * could only ever be read rather than run. Against three methods it can be
 * driven by a test with the real replicated state of a real match behind it,
 * which is the half of "does it work" that is actually in reach.
 */
export interface RemoteCharacter {
    place(originQ3: ArrayLike<number>, yawDegrees: number): void;
    setLegs(animation: LegsAnimation): void;
    setTorso(animation: TorsoAnimation): void;
}

/**
 * One drawn missile per pool slot, addressed by slot rather than by entity.
 *
 * Narrow for the same reason {@link RemoteCharacter} is, and it hides the part
 * that is genuinely awkward: the thing being moved is an entity in the render
 * dataset while the thing saying where to move it is a component in the
 * client's replication dataset, and nothing should have to hold both.
 */
export interface MissilePresenter {
    /** `index`'s model, flying `velocityQ3`. Placed before this is called. */
    spawn(index: number, weapon: string, velocityQ3: ArrayLike<number>): void;
    /** Take `index`'s model away. Safe to call for a slot that has none. */
    despawn(index: number): void;
    /** Move `index` to `originQ3`. */
    place(index: number, originQ3: ArrayLike<number>): void;
    /**
     * Roll every drawn missile about its line of flight, once per frame.
     *
     * `CG_Missile`'s `RotateAroundDirection`, which single-player gets through
     * `Arena.update` -- and `Arena.update` cannot be called on this branch,
     * because the first thing it does is step the weapons, and the weapons are
     * the host's. So the one presentation call inside it that a client still
     * wants comes through here instead.
     */
    advance(deltaSeconds: number): void;
}

/**
 * Where a slot nobody is in keeps its model.
 *
 * The same problem the bodies had (GAP-044) and the same answer, for a
 * different reason: an unoccupied slot's `NetPlayerState` is whatever the host
 * last said, and drawing a character there puts a motionless stranger in the
 * middle of the level. Far below the map, spaced so they do not overlap, and
 * never seen.
 */
const PARKED_CHARACTER_DEPTH = -1e6;
const PARKED_CHARACTER_SPACING = 64;

/**
 * Every other player in the match, drawn from replicated state.
 *
 * On `update` rather than `fixedUpdate`, and that is the whole point of the
 * arrangement: `NetRenderSystem` has just written *blended* values into every
 * remote component, sampled behind `AdaptiveRenderDelay`, so a remote player
 * moves smoothly at the display's rate off a 60 Hz stream without this port
 * interpolating anything itself. Reading them on the fixed step instead would
 * draw the raw 60 Hz snapshots and stutter.
 *
 * Everything it needs is in `NetPlayerState`, which is not an accident -- the
 * component was sized in step 1 by asking what a picture of somebody else
 * requires. The local player is skipped, because Q3 draws no model for the
 * player whose eyes you are behind.
 */
export class NetPresentationSystem extends System<never> {
    private readonly client: NetClient;
    private readonly characterFor: (slot: number) => RemoteCharacter | null;
    private readonly missiles: MissilePresenter | null;
    private readonly parked = new Float64Array(3);

    /** What each missile pool slot was doing last frame. See {@link drawMissiles}. */
    private readonly missileActive: Uint8Array;
    private readonly missileGeneration: Uint16Array;

    constructor(options: {
        client: NetClient;
        /** The model for a slot, or null where the roster has none. */
        characterFor: (slot: number) => RemoteCharacter | null;
        /** Null draws no missiles, which is what the tests without models do. */
        missiles?: MissilePresenter | null;
    }) {
        super();

        this.client = options.client;
        this.characterFor = options.characterFor;
        this.missiles = options.missiles ?? null;
        this.missileActive = new Uint8Array(options.client.missiles.length);
        this.missileGeneration = new Uint16Array(options.client.missiles.length);
    }

    override update = (deltaSeconds: number): void => {
        const client = this.client;

        for (const slot of client.slots) {
            if (slot.index === client.slotIndex) continue;

            const character = this.characterFor(slot.index);
            if (character === null) continue;

            const state = slot.state;

            if (state.connected === 0) {
                this.parked[0] = slot.index * PARKED_CHARACTER_SPACING;
                this.parked[1] = 0;
                this.parked[2] = PARKED_CHARACTER_DEPTH;
                character.place(this.parked, 0);
                character.setLegs('LEGS_IDLE');
                character.setTorso('TORSO_STAND');
                continue;
            }

            const yaw = state.viewangles[1]!;
            character.place(state.origin, yaw);

            character.setLegs(state.alive === 0 ? 'LEGS_IDLE' : legsOf(state, yaw));

            /*
             `weaponTime` as `EF_FIRING`. Q3 sets that flag on the server and
             this port has no field for it, but the cooldown is already
             replicated and is non-zero for exactly as long as a shot is being
             recovered from -- which is the interval `CG_AddPlayerWeapon` draws
             the attack torso for. It is a proxy and it is the honest one
             available; the alternative is a bit on the wire that means the same
             thing. See D-181.
            */
            character.setTorso(
                state.alive !== 0 && state.weaponTime > 0 ? 'TORSO_ATTACK' : 'TORSO_STAND'
            );
        }

        this.drawMissiles();
        this.missiles?.advance(deltaSeconds);
    };

    /**
     * Every rocket, grenade and plasma ball in the air, from the pool.
     *
     * A slot's model appears when `active` goes to one and goes away when it
     * returns to zero -- and also when `generation` changes underneath it,
     * which is the case the counter exists for. The host reuses a pool slot as
     * soon as the missile in it dies, so without `generation` a rocket fired
     * into the space a grenade just left would inherit the grenade's model and
     * appear to have been there all along.
     *
     * **Placed before it is spawned**, on the frame it appears. The plan's
     * wording was to hide a reused slot for one frame; placing first is the
     * same idea without the missing frame, because `MissileView`'s child
     * entities are attached to this transform and read it the moment they
     * exist. A model that is put in the right place cannot streak from the
     * wrong one.
     */
    private drawMissiles(): void {
        const missiles = this.missiles;
        if (missiles === null) return;

        const pool = this.client.missiles;

        for (let i = 0; i < pool.length; i++) {
            const m = pool[i]!.component;

            if (m.active === 0) {
                if (this.missileActive[i] === 1) {
                    this.missileActive[i] = 0;
                    missiles.despawn(i);
                }
                continue;
            }

            const fresh =
                this.missileActive[i] === 0 || this.missileGeneration[i] !== m.generation;

            if (!fresh) {
                missiles.place(i, m.origin);
                continue;
            }

            if (this.missileActive[i] === 1) missiles.despawn(i);

            this.missileActive[i] = 1;
            this.missileGeneration[i] = m.generation;

            missiles.place(i, m.origin);
            missiles.spawn(i, NET_WEAPONS[m.weapon] ?? 'WP_ROCKET_LAUNCHER', m.velocity);
        }
    }
}

/**
 * `CG_PlayerAnimation`'s legs, from the three replicated quantities it needs.
 *
 * The same `Character.legsFor` single-player drives bots with, fed from the
 * wire instead of from a live `Bot`: horizontal speed, ground contact, and the
 * sign of the velocity along the way the player is facing -- which is what
 * decides `LEGS_BACK` and is why the yaw is needed at all.
 */
function legsOf(
    state: { velocity: Float32Array; groundEntityNum: number },
    yawDegrees: number
): LegsAnimation {
    const vx = state.velocity[0]!;
    const vy = state.velocity[1]!;
    const speed = Math.hypot(vx, vy);

    const yaw = (yawDegrees * Math.PI) / 180;
    const forward = vx * Math.cos(yaw) + vy * Math.sin(yaw);

    return Character.legsFor(speed, state.groundEntityNum !== C.ENTITYNUM_NONE, forward);
}
