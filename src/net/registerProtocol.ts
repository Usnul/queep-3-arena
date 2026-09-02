/*
 * registerProtocol.ts -- the one place the wire order is written.
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
 * Three orderings have to be identical on every peer in a session, and none of
 * them is checked at runtime by anything:
 *
 *  1. **`replicate()` order**, which is component type-id order, which is the
 *     order AUTH_STATE concatenates a slot's components in and the order
 *     INITIAL_SYNC writes them. A host that replicates `NetInventory` before
 *     `NetPlayerState` and a client that does the reverse will exchange packets
 *     of exactly the right length, deserialize each into the wrong class, and
 *     produce a player at coordinates made of health and armour.
 *  2. **`defineAction()` order**, which is action type-id order.
 *  3. **The dataset's component-type registration**, which decides nothing on
 *     the wire but must have happened before `start()` so that
 *     `addComponentToEntity` can find the class.
 *
 * So all three happen here, once, for both roles, and neither the host nor the
 * client is allowed its own list. The test asserts that two independently
 * constructed sessions come out with identical type ids -- which is the only
 * cheap check there is, because the expensive one is a match that desyncs.
 */

import type { NetworkSession } from '@woosh/meep-engine/src/engine/network/NetworkSession.js';
import type { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';

import {
    NetInventoryAdapter,
    NetItemAdapter,
    NetMatchAdapter,
    NetMissileAdapter,
    NetMissileInterpolation,
    NetMoverAdapter,
    NetMoverInterpolation,
    NetPlayerInfoAdapter,
    NetPlayerStateAdapter,
    NetPlayerStateInterpolation,
} from './adapters.ts';
import {
    NetInventory,
    NetItem,
    NetMatch,
    NetMissile,
    NetMover,
    NetPlayerInfo,
    NetPlayerState,
    REPLICATED,
} from './components.ts';
import { makeActions, type ActionContext, type ProtocolActions } from './actions.ts';

/**
 * `NetworkSession`, as much of it as this function drives. The generated
 * declaration types `replicate`'s second parameter as the interpolation base
 * class, which our subclasses satisfy; the reason for the local shape is
 * `defineAction`, whose parameter is `Function` and which our `class`
 * expressions are assignable to only through it.
 */
interface SessionLike {
    replicate(componentClass: Function, interpolator?: unknown): void;
    defineAction(actionClass: Function): void;
    binary_registry: { registerAdapter(adapter: unknown, typeName: string): void };
}

/**
 * Register every replicated component, its adapter, and every action class.
 *
 * Call once per session, after construction and **before** `start()`.
 *
 * @param session the session to configure
 * @param world the dataset the components will be attached to
 * @param ctx how this peer's actions reach its game objects
 * @returns this session's action classes, which the caller instantiates
 */
export function registerProtocol(
    session: NetworkSession,
    world: EntityComponentDataset,
    ctx: ActionContext
): ProtocolActions {
    const s = session as unknown as SessionLike;

    /*
     The dataset has to know the classes before a packet can attach one:
     `#apply_initial_sync` calls `addComponentToEntity` with a fresh instance,
     and an unregistered class has no storage to go into.
    */
    for (const componentClass of REPLICATED) {
        (world as unknown as { registerComponentType(type: Function): void })
            .registerComponentType(componentClass);
    }

    /*
     Adapters first: `start()` verifies that every replicated class has one and
     throws by name if it does not, which is a good error and a late one.
    */
    s.binary_registry.registerAdapter(new NetPlayerStateAdapter(), NetPlayerState.typeName);
    s.binary_registry.registerAdapter(new NetInventoryAdapter(), NetInventory.typeName);
    s.binary_registry.registerAdapter(new NetPlayerInfoAdapter(), NetPlayerInfo.typeName);
    s.binary_registry.registerAdapter(new NetMissileAdapter(), NetMissile.typeName);
    s.binary_registry.registerAdapter(new NetItemAdapter(), NetItem.typeName);
    s.binary_registry.registerAdapter(new NetMoverAdapter(), NetMover.typeName);
    s.binary_registry.registerAdapter(new NetMatchAdapter(), NetMatch.typeName);

    /*
     Wire order. `NetworkIdentity` is auto-replicated and takes type id 0; these
     take 1..7 in this sequence, and the sequence is `REPLICATED`'s.

     Interpolators only on the three that move. A component with no interpolator
     snaps -- which is right for an inventory (health that lerps is health that
     is wrong for eight frames), for a name, for an item's presence and for the
     match clock, and would be wrong for anything drawn in a position.
    */
    s.replicate(NetPlayerState, new NetPlayerStateInterpolation());
    s.replicate(NetInventory);
    s.replicate(NetPlayerInfo);
    s.replicate(NetMissile, new NetMissileInterpolation());
    s.replicate(NetItem);
    s.replicate(NetMover, new NetMoverInterpolation());
    s.replicate(NetMatch);

    const actions = makeActions(ctx, { state: NetPlayerState, inventory: NetInventory });
    for (const actionClass of actions.all) {
        s.defineAction(actionClass);
    }

    return actions;
}
