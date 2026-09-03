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
 * Not here, and recorded rather than forgotten: **missiles**. The plan puts them
 * through `MissileView` on the replicated pool entities, and they cannot go
 * there as things stand -- `MissileView.spawn` hangs a model on an entity in the
 * *render* dataset, and `NetClient`'s pool lives in its own `EntityManager`
 * with no `Transform` on anything. Giving them a picture means a second pool of
 * render entities and a per-frame write of `sceneFromQ3(NetMissile.origin)` into
 * each one's transform. See GAP-046.
 */

import { System } from '@woosh/meep-engine/src/engine/ecs/System.js';

import type { NetClient } from '../client/net/NetClient.ts';
import type { PlayerController } from '../client/PlayerController.ts';
import type { ItemSystem } from '../game/Items.ts';
import { Character, type LegsAnimation, type TorsoAnimation } from '../client/Characters.ts';
import * as C from '../q3/pmove/constants.ts';

/**
 * The session's step, and the presentation clock that rides beside it.
 *
 * `NetClient.step` is `session.tick` plus the `normalize_if_dirty` that undoes
 * the previous render pass's blending; the session runs 0 to 3 simulation
 * steps inside it depending on time dilation, and each one that runs samples
 * this player's input, predicts it, records its bytes and sends it.
 *
 * `updatePresentation` is what is left of `PlayerController.update` once the
 * step is somebody else's: the view kick, the weapon rack's countdown, and the
 * two-step eye-pose history `ViewSystem` blends the camera between. It runs
 * once per fixed step rather than once per session tick because it is measured
 * in wall-clock milliseconds and a dilated tick is not.
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
        this.client.step();
        this.player.updatePresentation(deltaSeconds);
    };
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
    private readonly parked = new Float64Array(3);

    constructor(options: {
        client: NetClient;
        /** The model for a slot, or null where the roster has none. */
        characterFor: (slot: number) => RemoteCharacter | null;
    }) {
        super();

        this.client = options.client;
        this.characterFor = options.characterFor;
    }

    override update = (): void => {
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
    };
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
