/*
 * meep-event-reorder.mjs -- minimal reproduction for a suspected defect in
 * `engine/network`'s Replicator: event-style SimActions (no affected
 * components) appear to be dropped when a frame group arrives after a newer
 * one.
 *
 * Depends on `@woosh/meep-engine` and nothing else. No game, no map, no
 * physics, no renderer, no TypeScript. Run it with:
 *
 *     node tools/repro/meep-event-reorder.mjs
 *
 * It prints a PASS/FAIL line and exits non-zero on FAIL, so it can be used as
 * a regression check either way.
 *
 * WHAT IT SETS UP
 *   Two `NetworkSession`s (one host, one client) over a `LoopbackTransport`
 *   pair. Loopback is used deliberately: it queues packets and hands them over
 *   only when `deliver_all()` is called, and exposes `reorder(i, j)`, so this
 *   script controls delivery order exactly and nothing is left to timing.
 *
 *   One replicated component (`Counter`) so the sessions have something to
 *   sync, and one event-style action (`Ping`) carrying a sequence number.
 *   `Ping` declares no affected components, which per `SimAction`'s docblock is
 *   the "pure event-style action" case.
 *
 * WHAT IT DOES
 *   1. Connects, delivers in order until INITIAL_SYNC has landed.
 *   2. Host ticks N times, sending one `Ping` per tick, with delivery withheld
 *      so the packets queue up.
 *   3. Delivers that queue in REVERSE order -- the newest frame group first.
 *   4. Runs a long in-order tail, so any redundancy in the action stream has
 *      every chance to make good.
 *   5. Reports which `Ping` sequence numbers ever reached the client.
 *
 * WHAT WOULD MAKE THIS "NOT A BUG"
 *   See the notes at the bottom of the output. Several readings are possible
 *   and this script does not assume one.
 */

import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { NetworkSession } from '@woosh/meep-engine/src/engine/network/NetworkSession.js';
import { NetworkIdentity } from '@woosh/meep-engine/src/engine/network/ecs/components/NetworkIdentity.js';
import { LoopbackTransport } from '@woosh/meep-engine/src/engine/network/transport/LoopbackTransport.js';
import { SimAction } from '@woosh/meep-engine/src/engine/network/sim/SimAction.js';
import { BinaryClassSerializationAdapter } from '@woosh/meep-engine/src/engine/ecs/storage/binary/BinaryClassSerializationAdapter.js';

const TICK_SECONDS = 1 / 60;

/** How many ticks are held back and then delivered newest-first. */
const HELD_TICKS = 12;

/** In-order ticks after the reordered burst, for redundancy to make good. */
const TAIL_TICKS = 400;

/* ------------------------------------------------------------------ *
 * One replicated component, so the sessions have state to carry.
 * ------------------------------------------------------------------ */

class Counter {
    static typeName = 'Counter';
    value = 0;
}

class CounterAdapter extends BinaryClassSerializationAdapter {
    klass = Counter;
    version = 1;

    serialize(buffer, value) {
        buffer.writeUint32(value.value);
    }

    deserialize(buffer, value) {
        value.value = buffer.readUint32();
    }
}

/* ------------------------------------------------------------------ *
 * One event-style action: no affected components, a sequence number.
 * ------------------------------------------------------------------ */

function makePing(onApply) {
    return class Ping extends SimAction {
        seq = 0;

        apply() {
            onApply(this.seq);
        }

        // Deliberately no `affected_components` override: the base class
        // reports none, which is the "pure event" case the docs describe.

        serialize(buffer) {
            buffer.writeUint32(this.seq);
        }

        deserialize(buffer) {
            this.seq = buffer.readUint32();
        }

        reset() {
            this.seq = 0;
        }
    };
}

async function makeSession(role, localPeerId, onPing) {
    const em = new EntityManager();
    em.attachDataset(new EntityComponentDataset());
    await new Promise((resolve, reject) => em.startup(resolve, reject));

    const session = new NetworkSession({
        entity_manager: em,
        role,
        local_peer_id: localPeerId,
        simulation_delay_ticks: 0,
        tick_rate_hz: 60,
        // Wall-clock reaping would make this script timing-dependent.
        connection_timeout_ms: 0,
    });

    const Ping = makePing(onPing);

    // Registration order must match on both peers: component first, then
    // action. Both sessions run this same function, so they cannot diverge.
    session.binary_registry.registerAdapter(new CounterAdapter(), Counter.typeName);
    em.dataset.registerComponentType(Counter);
    session.replicate(Counter);
    session.defineAction(Ping);

    await session.start();

    // One replicated entity, created after start() so `NetworkSystem` is
    // running and assigns it a network id.
    const entity = em.dataset.createEntity();
    const identity = new NetworkIdentity();
    identity.owner_peer_id = 0; // host-owned on both sides
    em.dataset.addComponentToEntity(entity, identity);
    em.dataset.addComponentToEntity(entity, new Counter());

    return { em, session, Ping, entity };
}

/** Deliver everything queued, newest packet first. */
function deliverReversed(transport) {
    const n = transport.queued_count();
    for (let i = 0; i < Math.floor(n / 2); i++) transport.reorder(i, n - 1 - i);
    return transport.deliver_all();
}

async function main() {
    const received = [];

    const host = await makeSession('host', 0, () => {
        // The host applies its own event; irrelevant here.
    });
    const client = await makeSession('client', 1, (seq) => received.push(seq));

    const hostSide = new LoopbackTransport();
    const clientSide = new LoopbackTransport();
    LoopbackTransport.bind_pair(hostSide, clientSide);

    host.session.connect(1, hostSide);
    client.session.connect(0, clientSide);

    /*
     One Ping per host frame, sent from inside `onLocalSim` because that is the
     only point at which the host's action log frame is open --
     `SimActionExecutor.execute` throws `no frame is open` anywhere else.
    */
    const sent = [];
    host.session.server.onLocalSim.add((frame) => {
        const action = new host.Ping();
        action.seq = frame;
        host.session.send(action);
        sent.push(frame);
    });

    const step = () => {
        host.session.tick(TICK_SECONDS);
    };
    const pump = () => {
        clientSide.deliver_all();
        client.session.tick(TICK_SECONDS);
        hostSide.deliver_all();
    };

    // 1. Settle: in-order delivery until INITIAL_SYNC has landed.
    for (let i = 0; i < 10; i++) {
        step();
        pump();
    }
    const settled = received.length;

    // 2. Hold a burst back.
    const heldFrom = sent.length;
    for (let i = 0; i < HELD_TICKS; i++) step();
    const queued = clientSide.queued_count();

    // 3. Deliver it newest-first.
    const delivered = deliverReversed(clientSide);
    client.session.tick(TICK_SECONDS);
    hostSide.deliver_all();

    // 4. A long in-order tail, so the action stream's re-send of every unacked
    //    frame has every opportunity to deliver whatever was skipped.
    for (let i = 0; i < TAIL_TICKS; i++) {
        step();
        pump();
    }

    /* ---------------- report ---------------- */

    const sentSet = new Set(sent);
    const gotSet = new Set(received);
    const missing = [...sentSet].filter((s) => !gotSet.has(s)).sort((a, b) => a - b);
    const burst = sent.slice(heldFrom, heldFrom + HELD_TICKS);
    const missingInBurst = burst.filter((s) => !gotSet.has(s));

    console.log('meep', await engineVersion());
    console.log('');
    console.log(`settled before the burst:     ${settled} pings`);
    console.log(`packets held back:            ${queued}`);
    console.log(`packets delivered in reverse: ${delivered}`);
    console.log(`pings sent in total:          ${sentSet.size}`);
    console.log(`pings applied on the client:  ${gotSet.size}`);
    console.log(`pings never applied:          ${missing.length}`);
    console.log(`  of which in the reordered burst: ${missingInBurst.length} of ${burst.length}`);
    if (missing.length > 0) {
        console.log(`  missing seqs: ${missing.slice(0, 40).join(', ')}${missing.length > 40 ? ' ...' : ''}`);
    }
    console.log('');

    if (missing.length === 0) {
        console.log('PASS -- every event action arrived. No defect reproduced by this script.');
        console.log('');
        console.log('If you were sent here expecting a failure, the difference is worth finding:');
        console.log('the reporting application saw losses only with jitter large enough to reorder,');
        console.log('and this script reorders deliberately. A PASS here means the application-level');
        console.log('observation has some other cause and the report should be treated as unproven.');
        process.exitCode = 0;
        return;
    }

    console.log('FAIL -- event actions sent by the host were never applied by the client,');
    console.log('and did not arrive during the in-order tail either.');
    console.log('');
    console.log('Suspected mechanism (to be confirmed or refuted by whoever reads this):');
    console.log('  Replicator#unpack_from_peer keeps a per-peer `#applied_through` watermark and');
    console.log('  skips any frame group at or below it. A group that arrives after a newer one is');
    console.log('  therefore discarded whole, taking its actions with it. Replicated state survives');
    console.log('  that because the next tick re-sends it; an action with no affected components');
    console.log('  has only the one chance.');
    process.exitCode = 1;
}

async function engineVersion() {
    try {
        const { readFileSync } = await import('node:fs');
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        const entry = require.resolve('@woosh/meep-engine/src/engine/network/NetworkSession.js');
        const root = entry.slice(0, entry.indexOf('meep-engine') + 'meep-engine'.length);
        return JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version;
    } catch {
        return '(version unknown)';
    }
}

await main();
