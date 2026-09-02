/*
 * meep-event-reorder.mjs -- regression check for event-action delivery in
 * `engine/network` under a reordering link.
 *
 * Depends on `@woosh/meep-engine` and nothing else. Run it with:
 *
 *     node tools/repro/meep-event-reorder.mjs
 *
 * PASS/FAIL on stdout, non-zero exit on FAIL.
 *
 * HISTORY, because this file's first version tested the wrong thing and saying
 * so is the useful part.
 *
 * It was written to pin a suspected defect: event-style `SimAction`s (no
 * affected components) going missing on links with jitter, at up to 41% on a
 * 150 ms / 40 ms-jitter link. The hypothesis was `Replicator`'s
 * `#applied_through` watermark discarding a late-arriving frame group whole.
 * The script withheld a burst of packets, delivered them newest-first, and
 * **passed** -- which is what got reported, alongside the observation and three
 * other hypotheses.
 *
 * meep's answer (3.14.5) is that the hypothesis was right about the *place* and
 * incomplete about the *conditions*. Three things have to line up:
 *
 *   1. **A throughput ceiling.** `flush_outbound` packed `[last_acked + 1,
 *      current]` into ONE MTU-bounded packet per tick and re-sent that same
 *      range until its ack returned. So the baseline advanced by at most one
 *      packet of frames per round trip while the simulation produced one frame
 *      per tick: with K frames to a packet and a round trip of R ticks, the
 *      owed range grew by R - K frames per round trip whenever K < R. At 60 Hz
 *      and 150 ms, R = 10 and any frame over ~118 bytes of actions makes
 *      K < R.
 *   2. **Pinning.** The pack start is
 *      `max(last_acked + 1, current - frame_capacity + 1)`. Once the owed range
 *      is a ring wide the floor wins, and each frame is then on the wire in
 *      only K consecutive packets -- one, when a frame is more than half a
 *      packet.
 *   3. **The swap.** Two neighbouring packets reorder, the newer is applied
 *      first, and the older falls below the client's watermark and is skipped
 *      for good. Its channel-level ack still returns, so the host credits the
 *      frames as delivered and nothing re-sends them.
 *
 * The original script never left the regime where every packet still carried
 * every owed frame, so its reversed burst was a burst of duplicates and the
 * newest packet applied them all. To fail, the acks have to take longer than a
 * tick for longer than a ring, with frames that do not fit a packet twice.
 * `BYTES_PER_PING` and `DELAY_TICKS` below put it in that regime.
 *
 * Fixed on meep master and released in 3.14.5 as the action stream sending a
 * tick's owed range as several slices (`max_packets_per_tick`, default 8),
 * applied and credited in order -- which raises the ceiling roughly eightfold,
 * to about 940 bytes of actions per frame at 150 ms. meep's own
 * `NetworkPeer.ring_floor_reorder.spec.js` is the authoritative pin; this
 * script is queep's own forward check, so that a future engine bump that
 * regresses it is caught here rather than in a match.
 *
 * Setting `max_packets_per_tick: 1` restores the old behaviour and is the way
 * to watch this fail on purpose.
 */

import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { NetworkSession } from '@woosh/meep-engine/src/engine/network/NetworkSession.js';
import { NetworkIdentity } from '@woosh/meep-engine/src/engine/network/ecs/components/NetworkIdentity.js';
import { SimulatedTransport } from '@woosh/meep-engine/src/engine/network/transport/adapters/SimulatedTransport.js';
import { SimAction } from '@woosh/meep-engine/src/engine/network/sim/SimAction.js';
import { BinaryClassSerializationAdapter } from '@woosh/meep-engine/src/engine/ecs/storage/binary/BinaryClassSerializationAdapter.js';

const TICK_SECONDS = 1 / 60;
const TICK_MS = 1000 / 60;

/** Frames the host runs. Pinning is reached long before the end. */
const TICKS = 400;

/**
 * Payload bytes per event action.
 *
 * Large on purpose: a frame has to be more than half a packet before pinning
 * strips it down to one copy on the wire. At ~700 B a frame fits a 1200-byte
 * packet once and not twice, which is the condition meep's own reproduction
 * uses.
 */
const BYTES_PER_PING = 700;

/**
 * One-way link delay, in ticks. Pinning needs the acks to lag by longer than a
 * tick for longer than a ring; four each way is a round trip of eight.
 */
const DELAY_TICKS = 4;

/** Small ring, so the back-fill reaches its floor early in the run. */
const RING = 32;

/** Ticks at which two queued packets are swapped. One frame each, if broken. */
const SWAP_AT = [300, 320, 340];

/**
 * Set `QUEEP_SLICES=1` to restore the pre-3.14.5 send path and watch this fail.
 *
 * `max_packets_per_tick` is the knob 3.14.5 added: 8 by default, and 1 is the
 * old one-packet-a-tick behaviour. Running the script both ways is how to tell
 * "the fix is present and working" from "this link never reached the regime".
 */
const SLICES = Number(process.env.QUEEP_SLICES ?? '0') || 0;

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
 * One event-style action: no affected components, a sequence number,
 * and enough ballast that a frame does not fit a packet twice.
 * ------------------------------------------------------------------ */

const BALLAST = new Uint8Array(BYTES_PER_PING);

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
            buffer.writeBytes(BALLAST, 0, BALLAST.length);
        }

        deserialize(buffer) {
            this.seq = buffer.readUint32();
            buffer.position += BALLAST.length;
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
        frame_capacity: RING,
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

/**
 * Swap the two packets nearest the front of a `SimulatedTransport`'s inbound
 * queue, so the newer of the pair is delivered first.
 *
 * `in_queue` is a documented public field sorted ascending by `deliver_at_ms`;
 * exchanging two entries' bytes reorders them without touching the schedule,
 * which keeps the run deterministic. This is the whole of the "link reorders"
 * condition, applied deliberately rather than sampled from jitter.
 */
const CHANNEL_HEADER_BYTES = 9;
const ACTION_STREAM = 0;

function swapFront(transport) {
    const q = transport.in_queue;

    /*
     Action-stream packets specifically. A tick also puts AUTH_STATE and
     TIME_DILATION on the wire, and swapping two of those proves nothing --
     which is what the first version of this did, and why it passed even with
     the send path forced back to one packet a tick.
    */
    const at = [];
    for (let i = 0; i < q.length && at.length < 2; i++) {
        const b = q[i].bytes;
        if (b.length > CHANNEL_HEADER_BYTES && b[CHANNEL_HEADER_BYTES] === ACTION_STREAM) at.push(i);
    }
    if (at.length < 2) return false;

    const bytes = q[at[0]].bytes;
    q[at[0]].bytes = q[at[1]].bytes;
    q[at[1]].bytes = bytes;
    return true;
}

async function main() {
    const received = [];

    const host = await makeSession('host', 0, () => {});
    const client = await makeSession('client', 1, (seq) => received.push(seq));

    let clockMs = 0;
    const clock = () => clockMs;
    const latency_ms = DELAY_TICKS * TICK_MS;

    const hostSide = new SimulatedTransport({ latency_ms, jitter_ms: 0, loss_pct: 0, clock });
    const clientSide = new SimulatedTransport({ latency_ms, jitter_ms: 0, loss_pct: 0, clock });
    SimulatedTransport.bind_pair(hostSide, clientSide);

    if (SLICES > 0) {
        host.session.peer.max_packets_per_tick = SLICES;
        client.session.peer.max_packets_per_tick = SLICES;
    }

    host.session.connect(1, hostSide);
    client.session.connect(0, clientSide);

    /*
     One Ping per host frame, sent from inside `onLocalSim` because that is the
     only point at which the host's action log frame is open --
     `SimActionExecutor.execute` throws `no frame is open` anywhere else.
    */
    /*
     `onLocalSim` fires once per frame in a replay window, not once per frame,
     so a rollback re-dispatches. A set, not a list: the same seq legitimately
     goes out more than once and the client applies whichever copy lands first.
    */
    const sent = new Set();
    host.session.server.onLocalSim.add((frame) => {
        const action = new host.Ping();
        action.seq = frame;
        host.session.send(action);
        sent.add(frame);
    });

    let swaps = 0;

    for (let tick = 0; tick < TICKS; tick++) {
        clockMs += TICK_MS;

        host.session.tick(TICK_SECONDS);

        if (SWAP_AT.includes(tick) && swapFront(clientSide)) swaps += 1;

        clientSide.tick(clockMs);
        client.session.tick(TICK_SECONDS);
        hostSide.tick(clockMs);
    }

    /*
     The cutoff-frame method, because comparing totals does not work: the host
     keeps dispatching for as long as it runs and the client is permanently a
     link's-worth of frames behind, so the in-flight window would read as loss.
     Freeze what was owed at the end of the swap phase, then keep BOTH peers
     running -- with no more swaps -- until the client has applied a frame at or
     past it.
    */
    const cutoff = Math.max(...sent);
    for (let tick = 0; tick < 1200 && Math.max(-1, ...received) < cutoff; tick++) {
        clockMs += TICK_MS;
        host.session.tick(TICK_SECONDS);
        clientSide.tick(clockMs);
        client.session.tick(TICK_SECONDS);
        hostSide.tick(clockMs);
    }

    const got = new Set(received);
    const caughtUp = Math.max(-1, ...received) >= cutoff;
    const missing = [...sent].filter((s) => s <= cutoff && !got.has(s)).sort((a, b) => a - b);

    console.log('meep', await engineVersion());
    console.log('');
    console.log(`link:               ${DELAY_TICKS} ticks each way, no jitter, no loss`);
    console.log(`action bytes/frame: ${BYTES_PER_PING} (one packet holds one frame, not two)`);
    console.log(`ring:               ${RING} frames`);
    console.log(`max_packets_per_tick: ${SLICES > 0 ? SLICES + ' (forced)' : host.session.peer.max_packets_per_tick + ' (engine default)'}`);
    console.log(`deliberate swaps:   ${swaps}`);
    console.log('');
    console.log(`cutoff frame:             ${cutoff} (client caught up: ${caughtUp ? 'yes' : 'NO'})`);
    console.log(`event actions dispatched: ${sent.size}`);
    console.log(`applied on the client:    ${got.size}`);
    console.log(`never applied:            ${missing.length}`);
    if (missing.length > 0) {
        console.log(`  missing seqs: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' ...' : ''}`);
    }
    console.log('');

    if (!caughtUp) {
        console.log('INCONCLUSIVE -- the client never caught up to the cutoff frame, so the');
        console.log('shortfall above is a measurement artefact rather than a result. Raise the');
        console.log('drain budget.');
        process.exitCode = 2;
        return;
    }

    if (missing.length === 0) {
        console.log('PASS -- every event action arrived, including across the swaps.');
        process.exitCode = 0;
        return;
    }

    console.log('FAIL -- event actions were dispatched by the host and never applied by the');
    console.log('client, and did not arrive afterwards either.');
    console.log('');
    console.log('Expected on 3.14.4 and earlier: with the back-fill pinned to the ring floor a');
    console.log('frame rides only one packet, so a single swap loses it and its channel ack');
    console.log('still credits it. Fixed in 3.14.5 by slicing a tick\'s owed range across up to');
    console.log('`max_packets_per_tick` packets. If this fails on 3.14.5 or later it is a');
    console.log('regression; meep\'s NetworkPeer.ring_floor_reorder.spec.js is the finer pin.');
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
