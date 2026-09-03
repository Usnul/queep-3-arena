/*
 * session.ts -- constructing a `NetworkSession` with the options it accepts.
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
 * One function, and it exists because of one missing line in a generated
 * declaration.
 *
 * `NetworkSession`'s constructor destructures `frame_capacity` (it is right
 * there in `NetworkSession.d.ts`'s own parameter list, and the docblock two
 * lines above explains what it sizes, and the class declares
 * `readonly frame_capacity: number` further down) -- but the inline object type
 * that parameter is annotated with does not list it. So `tsc` rejects the one
 * option this port most needs to raise, with `TS2353: 'frame_capacity' does not
 * exist in type ...`, while the runtime honours it perfectly.
 *
 * The cast lives here, once, with the reason attached, rather than at every
 * construction site where it would degrade into folklore. When the declaration
 * is fixed, this file's `as` goes away and nothing else changes.
 *
 * See REPORT.md, section 4.
 */

import { NetworkSession } from '@woosh/meep-engine/src/engine/network/NetworkSession.js';
import type { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import type { BinarySerializationRegistry } from '@woosh/meep-engine/src/engine/ecs/storage/binary/BinarySerializationRegistry.js';

/**
 * The options this port passes, as the runtime actually accepts them.
 *
 * Deliberately narrower than the engine's full surface: reconnect, resume and
 * the transport factory are follow-ups (D-167), so nothing here can be set by
 * accident before the step that argues for it.
 */
export interface SessionOptions {
    entity_manager: EntityManager;
    role: 'client' | 'host';
    local_peer_id: number;
    tick_rate_hz: number;
    /** The action-log ring depth. The option the declaration forgets. */
    frame_capacity: number;
    /** Host-side input buffer. Honoured only under `role: 'host'`. */
    simulation_delay_ticks?: number;
    binary_registry?: BinarySerializationRegistry;
    /** Inbound-silence budget before a peer is reaped; 0 disables. */
    connection_timeout_ms?: number;
    /** Host-side: how long a dropped peer's state is retained. */
    server_resume_grace_ms?: number;
    reconnect?: { enabled: boolean };
}

/**
 * Build a session. The only thing this adds to `new NetworkSession(...)` is
 * that `frame_capacity` survives the typechecker.
 */
export function createSession(options: SessionOptions): NetworkSession {
    return new NetworkSession(
        options as unknown as ConstructorParameters<typeof NetworkSession>[0]
    );
}
