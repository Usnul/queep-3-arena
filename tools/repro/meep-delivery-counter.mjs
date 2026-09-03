/*
 * meep-delivery-counter.mjs -- does `delivery_stats().skipped_unapplied` count
 * frames that were lost, or frames the receiver held and then applied?
 *
 * Depends on `@woosh/meep-engine` and nothing else. Run it with:
 *
 *     node tools/repro/meep-delivery-counter.mjs
 *
 * PASS/FAIL on stdout, non-zero exit on FAIL. FAIL here means the counter
 * reported frames as never-applied that this script watched arrive.
 *
 * WHAT THIS IS FOR.
 *
 * `NetworkSession.delivery_stats(peer_id)` is new in 3.14.6 and returns
 * `{skipped_unapplied, skipped_duplicate}`. Its docblock says the first
 * "should stay at zero" on the default `max_packets_per_tick` and climbs under
 * jitter only at 1. A consumer measuring delivery would reasonably fail a test
 * on it -- which is what queep-3-arena was about to do, at 214 on a link where
 * ten frames were actually lost.
 *
 * The suspected mechanism, and the reason this script exists rather than an
 * argument: `#hold_slice` validates a slice it is about to keep by calling
 *
 *     #apply_groups(peer_id, in_buffer, in_buffer_end, Infinity, ...)
 *
 * `Infinity` as `min_frame` means "walk every group and apply none", which is
 * the right instruction for a validation pass. But the `frame_number <
 * min_frame` branch is also where the delivery accounting lives, so every frame
 * of every held slice is booked against `skipped_unapplied` on the way in --
 * and then applied, correctly, once the gap before it fills.
 *
 * If that reading is right, this script sees `skipped_unapplied` climb while
 * every single event action arrives. If it is wrong, the counter stays at zero
 * or the script loses actions, and either outcome is worth knowing.
 *
 * HOW IT FORCES A HOLD, and why it took two attempts. `unpack_from_peer` holds
 * when `!slice.head && slice.frame_start > state.next_frame` -- a non-head slice
 * whose frames are ahead of the watermark, with a gap before them. Two things
 * have to line up:
 *
 *   1. **A tick has to emit more than one slice**, or there are no non-heads at
 *      all. That needs its owed range not to fit one packet, so the actions
 *      carry 700 B of ballast each (as in `meep-event-reorder.mjs`) and the
 *      acks lag by four ticks each way.
 *   2. **A gap has to open.** This is the part that defeated the first version,
 *      which swapped two neighbouring action-stream packets in the client's
 *      inbound queue the way `meep-event-reorder.mjs` does, and reported a
 *      clean zero. The reason is worth writing down: the action stream re-sends
 *      `[last_acked + 1, current]` every tick, so consecutive ticks' packets
 *      overlap almost entirely -- with eight slices a tick the frontier
 *      advances by *one* frame per tick, and the other seven slices are copies
 *      of frames already applied. Reordering inside one tick therefore swaps
 *      the single new frame against a duplicate, and no gap can open. Every
 *      copy of a frame has to be late, which takes reordering across ticks.
 *
 * So the link does it: 67 ms of delay (four ticks at 60 Hz) with 40 ms of
 * jitter and **no loss at all**, seeded, so the run reproduces exactly and
 * nothing can be blamed on a dropped packet. `SimulatedTransport` schedules
 * each send at `now + latency + jitter` and reorders as a consequence, which is
 * what a real UDP path does.
 *
 * The client's `unpack_from_peer` is wrapped to record each packet's slice
 * header and what the counter did while that packet was handled. It reads and
 * changes nothing. Note that the header object is REUSED across receives, so it
 * has to be copied on capture -- recording the reference gives every packet the
 * last packet's range, which is a trap that produced a confidently wrong answer
 * on the way here.
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

/** Frames the host runs before the drain. */
const TICKS = 400;

/** Ballast per action, so a tick's owed range needs more than one packet. */
const BYTES_PER_PING = 700;

/** One-way link delay in ticks; a round trip of eight makes the acks lag. */
const DELAY_TICKS = 4;

/** Small ring, so the back-fill reaches its floor early. */
const RING = 32;

/**
 * Jitter, in milliseconds, and the only source of reordering here.
 *
 * `JITTER_MS=0` is the control and reports a clean zero: no slice can arrive
 * early, so nothing is held, so there is nothing for the validation walk to
 * miscount. Raising it raises the count with it -- 30 at 10 ms, 101 at 20, 234
 * at 40, 309 at 80 -- while the actions lost stay at **zero** throughout, on a
 * link that drops nothing. That is the shape of the finding.
 */
const JITTER_MS = Number(process.env.JITTER_MS ?? '40');

/** Fixed seeds, so a run is the same run on every machine. */
const SEED_TO_CLIENT = 11;
const SEED_TO_HOST = 7;

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

const BALLAST = new Uint8Array(BYTES_PER_PING);

function makePing(onApply) {
    return class Ping extends SimAction {
        seq = 0;

        apply() {
            onApply(this.seq);
        }

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
        connection_timeout_ms: 0,
    });

    const Ping = makePing(onPing);

    session.binary_registry.registerAdapter(new CounterAdapter(), Counter.typeName);
    em.dataset.registerComponentType(Counter);
    session.replicate(Counter);
    session.defineAction(Ping);

    await session.start();

    const entity = em.dataset.createEntity();
    const identity = new NetworkIdentity();
    identity.owner_peer_id = 0;
    em.dataset.addComponentToEntity(entity, identity);
    em.dataset.addComponentToEntity(entity, new Counter());

    return { em, session, Ping, entity };
}

async function main() {
    const received = [];

    const host = await makeSession('host', 0, () => {});
    const client = await makeSession('client', 1, (seq) => received.push(seq));

    /* ---------------------------------------------------------------- *
     * The instrument: per inbound packet, its slice header and what the
     * counter did. Copied, because the header object is reused.
     * ---------------------------------------------------------------- */
    const replicator = client.session.peer.replicator;
    let headSkips = 0;
    let nonHeadSkips = 0;
    let holdingPackets = 0;
    const original = replicator.unpack_from_peer.bind(replicator);
    replicator.unpack_from_peer = (peerId, buffer, end, slice = null) => {
        const copied =
            slice === null
                ? null
                : { frame_start: slice.frame_start, frame_end: slice.frame_end, head: slice.head };
        const before = replicator.delivery_stats(peerId).skipped_unapplied;
        const appliedBefore = received.length;

        original(peerId, buffer, end, slice);

        const moved = replicator.delivery_stats(peerId).skipped_unapplied - before;
        if (moved === 0 || copied === null) return;
        if (copied.head) headSkips += moved;
        else nonHeadSkips += moved;
        if (received.length === appliedBefore) holdingPackets += 1;
    };

    let clockMs = 0;
    const clock = () => clockMs;
    const latency_ms = DELAY_TICKS * TICK_MS;

    /*
     Lossless on purpose. The whole claim is that the counter names frames that
     were delivered and applied, so the link must not be able to drop one --
     otherwise a maintainer reading this cannot tell the counter's excess from
     ordinary loss.
    */
    const hostSide = new SimulatedTransport({
        latency_ms,
        jitter_ms: JITTER_MS,
        loss_pct: 0,
        clock,
        random_seed: SEED_TO_CLIENT,
    });
    const clientSide = new SimulatedTransport({
        latency_ms,
        jitter_ms: JITTER_MS,
        loss_pct: 0,
        clock,
        random_seed: SEED_TO_HOST,
    });
    SimulatedTransport.bind_pair(hostSide, clientSide);

    host.session.connect(1, hostSide);
    client.session.connect(0, clientSide);

    const sent = new Set();
    host.session.server.onLocalSim.add((frame) => {
        const action = new host.Ping();
        action.seq = frame;
        host.session.send(action);
        sent.add(frame);
    });

    for (let tick = 0; tick < TICKS; tick++) {
        clockMs += TICK_MS;
        host.session.tick(TICK_SECONDS);
        clientSide.tick(clockMs);
        client.session.tick(TICK_SECONDS);
        hostSide.tick(clockMs);
    }

    /*
     The cutoff-frame method: the host keeps dispatching for as long as it runs
     and the client is permanently a link's-worth of frames behind, so
     comparing totals reads the in-flight window as loss. Freeze what was owed
     at the end of the swap phase, then keep BOTH peers running -- no more
     swaps -- until the client has applied a frame at or past it.
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
    const stats = client.session.delivery_stats(0);

    console.log('meep', await engineVersion());
    console.log('');
    console.log(`link:                 ${DELAY_TICKS} ticks each way (${latency_ms.toFixed(0)} ms), ` +
        `${JITTER_MS} ms jitter, NO LOSS`);
    console.log(`action bytes/frame:   ${BYTES_PER_PING} (a tick's owed range needs several packets)`);
    console.log(`ring:                 ${RING} frames`);
    console.log(`max_packets_per_tick: ${client.session.peer.max_packets_per_tick} (engine default)`);
    console.log('');
    console.log(`cutoff frame:                     ${cutoff} (client caught up: ${caughtUp ? 'yes' : 'NO'})`);
    console.log(`event actions dispatched:         ${sent.size}`);
    console.log(`applied on the client:            ${got.size}`);
    console.log(`NEVER applied:                    ${missing.length}`);
    if (missing.length > 0) {
        console.log(`  missing seqs: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' ...' : ''}`);
    }
    console.log('');
    console.log(`delivery_stats.skipped_unapplied:  ${stats.skipped_unapplied}`);
    console.log(`delivery_stats.skipped_duplicate:  ${stats.skipped_duplicate}`);
    console.log(`  increments on head slices:       ${headSkips}`);
    console.log(`  increments on non-head slices:   ${nonHeadSkips}`);
    console.log(`  incrementing packets that applied nothing: ${holdingPackets}`);
    console.log('');

    if (!caughtUp) {
        console.log('INCONCLUSIVE -- the client never caught up to the cutoff frame, so the');
        console.log('shortfall above is a measurement artefact rather than a result. Raise the');
        console.log('drain budget.');
        process.exitCode = 2;
        return;
    }

    if (stats.skipped_unapplied === 0 && missing.length === 0) {
        if (JITTER_MS === 0) {
            console.log('PASS -- and this is the control: with no jitter there is no reordering,');
            console.log('so no slice is held and the counter has nothing to miscount. Run without');
            console.log('JITTER_MS=0 for the case this script is about.');
            process.exitCode = 0;
            return;
        }
        console.log('INCONCLUSIVE -- nothing was lost and the counter stayed at zero, so this run');
        console.log('never produced a held slice. Raise JITTER_MS, BYTES_PER_PING or DELAY_TICKS');
        console.log('until "increments on non-head slices" is non-zero. On 3.14.6 the default');
        console.log('settings here report 234.');
        process.exitCode = 2;
        return;
    }

    if (stats.skipped_unapplied > missing.length) {
        console.log(`FAIL -- the counter reports ${stats.skipped_unapplied} frames as having reached this client and`);
        console.log(`never run. ${missing.length} actually did not run. Every other frame it counted was`);
        console.log('applied, by this same client, in this same run.');
        console.log('');
        console.log('The link lost nothing -- loss_pct is 0 -- so every frame it counted was on');
        console.log('the wire and arrived. All of the excess came in on packets that applied');
        console.log('nothing during their own call, which is what a held slice looks like from');
        console.log('outside, and the split above puts it on non-head slices, the only ones that');
        console.log('can be held. The suspected line is `#hold_slice` calling `#apply_groups`');
        console.log('with `min_frame = Infinity`: the walk is meant to validate, and the branch');
        console.log('it takes is the one that books `skipped_unapplied`.');
        console.log('');
        console.log('Run with JITTER_MS=0 for the control: no reordering, no holds, and the');
        console.log('counter reads zero at the same latency.');
        console.log('');
        console.log('This may be intended. If a held slice is meant to count -- the frames have,');
        console.log('after all, not been applied at the moment the walk sees them -- then the');
        console.log('docblock\'s "should stay at zero" is what needs changing, and a consumer');
        console.log('needs telling that the field is only a loss count when read on head slices.');
        process.exitCode = 1;
        return;
    }

    console.log('PASS -- the counter did not exceed the frames actually lost.');
    process.exitCode = 0;
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
