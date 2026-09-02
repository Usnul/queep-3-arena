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
 * Not here, and deliberately: remote characters, missiles and the HUD read off
 * a remote slot. Those are `NetPresentationSystem` and belong to step 6. What
 * this file is enough for is the exit of step 5 -- a client that connects,
 * predicts its own player, collides with the bodies the host says are there,
 * and sees items come and go.
 */

import { System } from '@woosh/meep-engine/src/engine/ecs/System.js';

import type { NetClient } from '../client/net/NetClient.ts';
import type { PlayerController } from '../client/PlayerController.ts';
import type { ItemSystem } from '../game/Items.ts';

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
