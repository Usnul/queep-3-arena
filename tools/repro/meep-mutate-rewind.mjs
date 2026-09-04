/*
 * meep-mutate-rewind.mjs -- a replicated component, published once when it
 * changes, on a link that loses nothing.
 *
 * Depends on `@woosh/meep-engine` and nothing else. Run it with:
 *
 *     node tools/repro/meep-mutate-rewind.mjs
 *
 * PASS/FAIL on stdout, non-zero exit on FAIL.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SHOWS
 * ------------------------------------------------------------------------
 *
 * Two entities, one `LoopbackTransport`, no loss, no jitter, no reordering.
 *
 *   - **The player**, owned by the client. The host sends an AUTH_STATE for it
 *     every tick, because AUTH_STATE goes to an entity's owner.
 *   - **The scoreboard**, owned by the host. Once, at a chosen frame, the host
 *     changes its value and publishes it -- one `net_mutate_component`, the way
 *     a value that changes a handful of times a match is meant to be published.
 *
 * The client receives that mutation and applies it. Then it loses it, and never
 * gets it back, because an AUTH_STATE about **the player** rewinds the whole
 * world past the frame the scoreboard's mutation landed in:
 *
 *   1. `Replicator.unpack_from_peer` applies the host's `ReplaceComponentAction`
 *      through the local executor, which logs it into the client's action log
 *      **with the client's prior state** -- the old value.
 *   2. An AUTH_STATE arrives for the player. `ServerAuthoritativeClient`
 *      `#handle_auth_state` calls `RewindEngine.rewind_to(current, server_frame
 *      - 1)`, which walks every record in that window and writes its prior
 *      state back. The scoreboard's old value is restored.
 *   3. `onApplyAuthState` then deserializes the server's bytes **for the one
 *      network id the AUTH_STATE was about** -- the player. The scoreboard is
 *      not in that payload.
 *   4. The replay re-executes the client's own recorded input actions. The
 *      host's replicated mutations are not among them, so nothing puts the
 *      scoreboard back.
 *   5. The host published on change, so it never sends it again.
 *
 * Net effect: a value with one chance to arrive is undone by a reconciliation
 * about an unrelated entity, and keeps whatever it was rolled back to for ever.
 * Every other entity in the world is collateral damage of one entity's
 * prediction being wrong.
 *
 * **Why the player's own component never shows this**, which is the part that
 * makes the hole easy to miss: a host defaults its scope filter to
 * `OwnerAwareScope`, which keeps an entity OUT of the action stream sent to the
 * peer that owns it. So a client's own entity is carried by AUTH_STATE alone --
 * and AUTH_STATE is applied on the very path that does the rewinding, one step
 * after it. It is clobbered and repaired in the same breath, and looks perfect.
 * Every entity the client does not own has the opposite arrangement: carried by
 * the action stream, clobbered by the rewind, repaired by nothing.
 *
 * ------------------------------------------------------------------------
 * THE CONTROLS, WHICH ARE THE POINT
 * ------------------------------------------------------------------------
 *
 * None of these is a fix. They are here so a reader can watch the mechanism
 * switch on and off rather than take the paragraph above on trust. The
 * measured results on 3.14.6 are in the table `--all` prints.
 *
 *     QUEEP_MISS_EVERY=N        How often the client's no-op short-circuit
 *                               misses, and therefore how often it rewinds.
 *                               `0` (the default) subscribes no short-circuit
 *                               handlers at all, which is the engine's
 *                               documented "game code that doesn't want the
 *                               optimization" configuration and rewinds on
 *                               EVERY AUTH_STATE. `N > 1` subscribes handlers
 *                               that agree except on every Nth frame, which is
 *                               how a real client behaves: queep-3-arena
 *                               short-circuits about five AUTH_STATEs in six,
 *                               so `N=6` is roughly its rate.
 *
 *     QUEEP_SHORTCIRCUIT=1      Handlers that always agree, so
 *                               `#handle_auth_state` returns before the rewind.
 *                               Zero rewinds, and the value holds. This is the
 *                               causal check: stop the rewinds and the loss
 *                               stops with them.
 *
 *     QUEEP_PUBLISH=always      Republish the scoreboard every frame instead of
 *                               once on change, which is the workaround
 *                               `Host.publishInfo` is a bounded version of.
 *
 * **The last two interact, and that is the most useful thing here.** Publishing
 * every frame does NOT save the value when every AUTH_STATE rewinds -- the
 * rewind runs after the apply in the same tick, so each frame's publish is
 * undone by the same frame's rewind and the value never holds for even one
 * frame. It only looks like a fix at a realistic miss rate, where most frames
 * carry no rewind. That is why the workaround in the port appears to work and
 * still leaves a residual: it is not repairing anything, it is racing.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ------------------------------------------------------------------------
 *
 * It is not a claim that the rewind is wrong. Rewinding is what a
 * predict-reconcile client is for. The claim is narrower: the rewind's blast
 * radius is the whole world, and the repair afterwards covers exactly one
 * entity -- so replicated state on every other entity is silently dropped, with
 * nothing counting it and no way for an application to notice.
 *
 * Written against @woosh/meep-engine 3.14.6. The queep-3-arena side of this is
 * REPORT.md GAP-045; `tools/repro/gap045-measure.ts` is the same finding
 * measured in a real match rather than in a fixture.
 */

import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { NetworkSession } from '@woosh/meep-engine/src/engine/network/NetworkSession.js';
import { NetworkIdentity } from '@woosh/meep-engine/src/engine/network/ecs/components/NetworkIdentity.js';
import { LoopbackTransport } from '@woosh/meep-engine/src/engine/network/transport/LoopbackTransport.js';
import { BinaryClassSerializationAdapter } from '@woosh/meep-engine/src/engine/ecs/storage/binary/BinaryClassSerializationAdapter.js';

const TICK_HZ = 30;
const TICK_SECONDS = 1 / TICK_HZ;

/** Frames the match runs for. Long enough for many reconciliations. */
const TICKS = 600;

/** Frame at which the host changes the scoreboard, once. */
const CHANGE_AT = 200;

/** Host-side input buffer, in frames. The engine's default, and the port's. */
const SIMULATION_DELAY_TICKS = 4;

/** Action-log ring depth. Comfortably larger than any rewind here. */
const FRAME_CAPACITY = 64;

const PEER_HOST = 0;
const PEER_CLIENT = 1;

const PUBLISH_ALWAYS = process.env.QUEEP_PUBLISH === 'always';
const SHORT_CIRCUIT = process.env.QUEEP_SHORTCIRCUIT === '1';
/** 0 = no short-circuit handlers at all; N > 0 = miss one frame in N. */
const MISS_EVERY = Number(process.env.QUEEP_MISS_EVERY ?? '0') || 0;

/* ------------------------------------------------------------------ *
 * One replicated component. Two fields, so that the player's can move
 * every frame while the scoreboard's moves once.
 * ------------------------------------------------------------------ */

class Value {
    static typeName = 'Value';
    number = 0;
}

class ValueAdapter extends BinaryClassSerializationAdapter {
    klass = Value;
    version = 1;

    serialize(buffer, value) {
        buffer.writeInt32(value.number);
    }

    deserialize(buffer, value) {
        value.number = buffer.readInt32();
    }
}

/**
 * One peer, with the two entities every peer in this session has.
 *
 * Both sides build the same world in the same order, so the network ids line
 * up; the host then declares who owns what, and the client agrees because
 * INITIAL_SYNC carries it.
 */
async function makePeer(role, localPeerId) {
    const em = new EntityManager();
    em.attachDataset(new EntityComponentDataset());
    await new Promise((resolve, reject) => em.startup(resolve, reject));

    const session = new NetworkSession({
        entity_manager: em,
        role,
        local_peer_id: localPeerId,
        simulation_delay_ticks: SIMULATION_DELAY_TICKS,
        tick_rate_hz: TICK_HZ,
        frame_capacity: FRAME_CAPACITY,
        // Wall-clock reaping would make this script timing-dependent.
        connection_timeout_ms: 0,
    });

    session.binary_registry.registerAdapter(new ValueAdapter(), Value.typeName);
    em.dataset.registerComponentType(Value);
    session.replicate(Value);

    await session.start();

    /*
     Created after `start()`, so `NetworkSystem` is running and assigns each a
     network id. Order matters and is the same on both peers.
    */
    const player = em.dataset.createEntity();
    const playerIdentity = new NetworkIdentity();
    playerIdentity.owner_peer_id = PEER_CLIENT;
    em.dataset.addComponentToEntity(player, playerIdentity);
    em.dataset.addComponentToEntity(player, new Value());

    const scoreboard = em.dataset.createEntity();
    const scoreboardIdentity = new NetworkIdentity();
    scoreboardIdentity.owner_peer_id = PEER_HOST;
    em.dataset.addComponentToEntity(scoreboard, scoreboardIdentity);
    em.dataset.addComponentToEntity(scoreboard, new Value());

    return {
        em,
        session,
        player,
        scoreboard,
        playerValue: em.dataset.getComponent(player, Value),
        scoreboardValue: em.dataset.getComponent(scoreboard, Value),
    };
}

/** The one way a replicated component changes on the host. */
function mutate(peer, entity) {
    peer.em.dataset.sendEvent(entity, 'net_mutate_component', { component_type: Value });
}

/**
 * One configuration of the run, end to end.
 *
 * @param {{publishAlways: boolean, shortCircuit: boolean, missEvery: number}} options
 */
async function measure({ publishAlways, shortCircuit, missEvery }) {
    const host = await makePeer('host', PEER_HOST);
    const client = await makePeer('client', PEER_CLIENT);

    const hostSide = new LoopbackTransport();
    const clientSide = new LoopbackTransport();
    LoopbackTransport.bind_pair(hostSide, clientSide);

    host.session.connect(PEER_CLIENT, hostSide);
    client.session.connect(PEER_HOST, clientSide);

    /*
     The optional no-op short-circuit. Without handlers on both signals,
     `ServerAuthoritativeClient.#handle_auth_state` rewinds on every AUTH_STATE
     -- which its own docblock names as the supported "game code that doesn't
     want the optimization" configuration. With them, and with both sides
     answering the same constant, it never rewinds at all.
    */
    let reconciles = 0;
    let rewinds = 0;
    let clientFrame = 0;
    client.session.client.onReconcileComplete.add(() => {
        reconciles += 1;
    });
    if (shortCircuit || missEvery > 0) {
        /*
         `set_expected` and `set_measured` are the orchestrator's own protocol
         for the two scalars it compares. Returning the same number from both
         is an agreement; returning different ones is a miss, and a miss is a
         rewind. Keyed off the frame so a run reproduces.
        */
        const miss = () => !shortCircuit && missEvery > 0 && clientFrame % missEvery === 0;
        client.session.client.onComputeExpected.add(() => {
            client.session.client.set_expected(0);
        });
        client.session.client.onMeasureCurrent.add(() => {
            client.session.client.set_measured(miss() ? 1 : 0);
        });
    }

    /*
     Count the rewinds that actually walk the log, as opposed to the
     reconciliations that decide one is needed -- `rewind_to` is skipped when
     the client is not ahead of the server frame.
    */
    const rewindEngine = client.session.client.rewind_engine;
    const realRewindTo = rewindEngine.rewind_to.bind(rewindEngine);
    rewindEngine.rewind_to = (current, target) => {
        rewinds += 1;
        return realRewindTo(current, target);
    };

    /*
     The host's world step. `onLocalSim` is the only place the action log is
     open, so it is the only place a mutation may be published from -- and it
     re-runs for every frame of a rollback window, which is why the publish
     decision has to be a function of the frame rather than of a counter.
    */
    host.session.server.onLocalSim.add((frame) => {
        // The player moves every frame, the way a position does.
        host.playerValue.number = frame;
        mutate(host, host.player);

        // The scoreboard changes once, and is published when it changes.
        const wanted = frame >= CHANGE_AT ? 1 : 0;
        if (publishAlways) {
            host.scoreboardValue.number = wanted;
            mutate(host, host.scoreboard);
        } else if (host.scoreboardValue.number !== wanted) {
            host.scoreboardValue.number = wanted;
            mutate(host, host.scoreboard);
        }
    });

    /** What the client's copy of the scoreboard read, per frame, after CHANGE_AT. */
    const seen = [];
    /** Frames on which the client's copy held the host's value. */
    let agreed = 0;
    /** Frames on which it did not, after the value had once arrived. */
    let lostAfterArriving = 0;
    let everArrived = false;

    for (let tick = 0; tick < TICKS; tick++) {
        clientFrame = tick;
        host.session.tick(TICK_SECONDS);
        clientSide.deliver_all();
        client.session.tick(TICK_SECONDS);
        hostSide.deliver_all();

        if (tick < CHANGE_AT) continue;

        const mine = client.scoreboardValue.number;
        const theirs = host.scoreboardValue.number;
        seen.push(mine);
        if (mine === theirs) {
            agreed += 1;
            everArrived = true;
        } else if (everArrived) {
            lostAfterArriving += 1;
        }
    }

    const settled = seen.slice(-60);

    return {
        publishAlways,
        shortCircuit,
        missEvery,
        reconciles,
        rewinds,
        host: host.scoreboardValue.number,
        client: client.scoreboardValue.number,
        agreed,
        samples: seen.length,
        lostAfterArriving,
        everArrived,
        settledAgreed: settled.filter((v) => v === host.scoreboardValue.number).length,
        settled: settled.length,
        first: seen.slice(0, 24),
    };
}

/** How a configuration is named in the table and in the header. */
function describe(o) {
    const publish = o.publishAlways ? 'every frame' : 'once, on change';
    const rewind = o.shortCircuit
        ? 'never (short-circuit always agrees)'
        : o.missEvery > 0
          ? `1 frame in ${o.missEvery}`
          : 'every AUTH_STATE (no short-circuit subscribed)';
    return { publish, rewind };
}

function report(r) {
    const { publish, rewind } = describe(r);
    console.log('');
    console.log(`link:                  LoopbackTransport, no loss, no jitter, no reordering`);
    console.log(`tick rate:             ${TICK_HZ} Hz`);
    console.log(`simulation delay:      ${SIMULATION_DELAY_TICKS} frames`);
    console.log(`frames:                ${TICKS}`);
    console.log(`scoreboard published:  ${publish}${r.publishAlways ? '' : `, at frame ${CHANGE_AT}`}`);
    console.log(`client rewinds:        ${rewind}`);
    console.log('');
    console.log(`reconciliations:       ${r.reconciles}`);
    console.log(`rewinds walked:        ${r.rewinds}`);
    console.log('');
    console.log(`host scoreboard:       ${r.host}`);
    console.log(`client scoreboard:     ${r.client}`);
    console.log(`frames agreeing:       ${r.agreed} of ${r.samples} after the change`);
    console.log(`frames lost again:     ${r.lostAfterArriving} (it had arrived, then did not hold)`);
    console.log(`last 60 frames:        ${r.settledAgreed} of ${r.settled} agreeing`);
    console.log(`first 24 values seen:  ${r.first.join(',')}`);
    console.log('');
}

/**
 * The whole matrix, which is the argument rather than any single row.
 *
 * Publishing on change loses the value at every rewind rate above zero.
 * Publishing every frame only survives where most frames carry no rewind --
 * it is racing the rewind, not repairing anything.
 */
async function all() {
    const configurations = [
        { publishAlways: false, shortCircuit: false, missEvery: 0 },
        { publishAlways: true, shortCircuit: false, missEvery: 0 },
        { publishAlways: false, shortCircuit: false, missEvery: 6 },
        { publishAlways: true, shortCircuit: false, missEvery: 6 },
        { publishAlways: false, shortCircuit: true, missEvery: 0 },
    ];

    const rows = [];
    for (const configuration of configurations) rows.push(await measure(configuration));

    console.log('meep', await engineVersion());
    console.log('');
    console.log(`LoopbackTransport, no loss, no jitter, no reordering. ${TICK_HZ} Hz, ${TICKS} frames,`);
    console.log(`one change to the scoreboard at frame ${CHANGE_AT}.`);
    console.log('');
    console.log(
        'published         when the client rewinds                        rewinds  holds'
    );
    for (const r of rows) {
        const { publish, rewind } = describe(r);
        console.log(
            `${publish.padEnd(17)} ${rewind.padEnd(46)} ${String(r.rewinds).padStart(7)}  ` +
                `${r.client === r.host ? 'yes' : 'NO'}`
        );
    }
    console.log('');
    console.log('The last row is the causal check: no rewinds, and the single publish holds.');
    console.log('The third row is the port\'s own situation -- rewinds are rare, and a value');
    console.log('published once still does not survive them.');

    const headline = rows[0];
    process.exitCode = headline.client === headline.host ? 3 : 1;
}

async function main() {
    if (process.argv.includes('--all')) {
        await all();
        return;
    }

    const r = await measure({
        publishAlways: PUBLISH_ALWAYS,
        shortCircuit: SHORT_CIRCUIT,
        missEvery: MISS_EVERY,
    });

    console.log('meep', await engineVersion());
    report(r);

    if (!r.everArrived) {
        console.log("INCONCLUSIVE -- the client never held the host's value even once, so this");
        console.log('run does not distinguish "delivered and withdrawn" from "never sent". That is');
        console.log('a different failure from the one this script is for; check that the two peers');
        console.log('registered the same components in the same order and that INITIAL_SYNC');
        console.log('mapped both network ids.');
        process.exitCode = 2;
        return;
    }

    if (r.client === r.host && r.lostAfterArriving === 0) {
        console.log('PASS -- the single mutation arrived and held for the rest of the run.');
        if (!PUBLISH_ALWAYS && !SHORT_CIRCUIT && MISS_EVERY === 0) {
            console.log('');
            console.log('!!! READ THIS BEFORE CONCLUDING THERE IS NO DEFECT !!!');
            console.log('');
            console.log('This is the configuration that is expected to FAIL on 3.14.6. A pass here');
            console.log('means this fixture did not enter the regime that loses the value, NOT that');
            console.log('the reported behaviour does not exist. The regime needs a reconciliation');
            console.log('whose rewind window covers the frame the mutation landed in; if the number');
            console.log('of rewinds above is zero, or if the client never runs ahead of the server');
            console.log('frame, no rewind ever reaches it.');
            console.log('');
            console.log('That is exactly how the standalone case filed with GAP-043 came to pass');
            console.log('while the defect was real, and the report was nearly dismissed for it. The');
            console.log('measurement that does not depend on this fixture is');
            console.log('`tools/repro/gap045-measure.ts`, which runs a real match and reports the');
            console.log('same loss with the rewind attributed frame by frame.');
            process.exitCode = 3;
            return;
        }
        process.exitCode = 0;
        return;
    }

    console.log('FAIL -- a single mutation was applied by the client and then lost, on a link');
    console.log('that dropped nothing and reordered nothing.');
    console.log('');
    console.log('The host published the change once, on the frame it happened, and the client');
    console.log('applied it. A later AUTH_STATE about the OTHER entity -- the one the client owns');
    console.log('and predicts -- rewound the world past that frame, and');
    console.log('`RewindEngine.#restore_prior_state` wrote the old value back. What follows the');
    console.log('rewind repairs only the entity the AUTH_STATE was about, and the replay');
    console.log("re-executes only the client's own recorded input, so nothing puts the scoreboard");
    console.log('back. The host, having published on change, never sends it again.');
    console.log('');
    console.log('Run with --all for the whole matrix: the rewind rate is the variable, and');
    console.log('QUEEP_SHORTCIRCUIT=1 (no rewinds at all) is the row where the loss stops.');
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
