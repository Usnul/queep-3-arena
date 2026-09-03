/*
 * net-loopback.test.ts -- a host and a client, at zero latency.
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
 * The step-3 gate. Everything here would otherwise be checked by playing, which
 * is the method this project has twice shown to be unreliable.
 *
 * Zero latency is the useful case precisely because it removes every excuse: a
 * client whose prediction disagrees with the host when every packet arrives
 * before it is needed is a client whose *simulation* disagrees, not one with a
 * network problem. So the headline measurement is how closely the two agree,
 * and it is reported as a number rather than asserted as a hope -- `NETWORK_PLAN.md`
 * §5 step 3 says bit-exactness is the target and names the fallback gate if
 * D-131's measured 1e-5 shows up, which is exactly what a differently-shaped
 * broadphase does to a sweep.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { NetRig, type RigClient } from './net/rig.ts';
import { EffectKind } from '../src/net/actions.ts';
import {
    MAX_CLIENTS,
    MAX_MISSILES,
    SIMULATION_DELAY_TICKS,
    TICK_HZ,
} from '../src/net/protocol.ts';
import { NetworkIdentity } from '@woosh/meep-engine/src/engine/network/ecs/components/NetworkIdentity.js';
import * as C from '../src/q3/pmove/constants.ts';
import { FORWARDMOVE, RIGHTMOVE, UPMOVE } from '../src/q3/pmove/types.ts';
import { weaponIndex } from '../src/net/components.ts';

/**
 * The seed the fight cases run on, and it is a chosen number rather than an
 * arbitrary one.
 *
 * Every draw a match makes now comes off one seeded generator (D-172), so the
 * same seed is the same match to the last bit -- which is what makes these
 * assertions meaningful and is also what makes the seed matter. Measured over
 * seven seeds at forty seconds with four bots: six produced a rocket and one
 * (seed 7) produced sixteen shots and no projectile at all, because no bot ever
 * walked over a launcher. This one produces 270 shots, 48 projectiles and 1057
 * points of damage, which exercises the missile pool properly.
 *
 * A test that asserted "a bot fires a rocket" on an unseeded match would pass
 * about two runs in three, which is how this was found.
 */
const MATCH_SEED = 23;

/** 16-bit view angles, as `usercmd_t.angles` carries them. */
function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

/**
 * Walk a tight circle, jumping every half second.
 *
 * A circle rather than a straight line, and the reason is the map: four degrees
 * a frame at 320 u/s is a 76-unit radius, so the player stays in the room it
 * spawned in and keeps meeting floor, walls and steps. A straight walk leaves
 * `oa_dm1` within a couple of seconds and falls into the void, which looks like
 * a long run and is really a test of nothing -- a falling player takes no sweep
 * that can disagree with anything.
 */
function circleWalk(cmd: Parameters<NonNullable<RigClient['script']>>[0], frame: number): void {
    cmd.angles[1] = angleToShort(frame * 4);
    cmd.moves[FORWARDMOVE] = 127;
    cmd.moves[UPMOVE] = frame % 30 === 0 ? 127 : 0;
}

describe('a client joins a host over a loopback', () => {
    let rig: NetRig;
    let client: RigClient;

    beforeAll(async () => {
        rig = await NetRig.create({ map: 'oa_dm1', bots: 4, clients: 1, seed: 1234 });
        client = rig.clients[0]!;
    });

    it('holds one entity per player who is here, and none for anybody else', () => {
        rig.step(10);

        const net = client.net;

        /*
         **Five, not sixteen**, and that is the whole of D-194.

         There used to be one entity per *slot*: `MAX_CLIENTS` of them built
         before anybody connected, on both peers, in the same order so their
         network ids lined up. Sixteen character bodies parked a million units
         below the map so their collision hit nobody (GAP-044), sixteen entities
         in every INITIAL_SYNC whoever was playing, and a `connected` byte doing
         the work that "the entity exists" should do. **Not sixteen players'
         worth of bandwidth** -- `publishPresence` gated on `connected`, and
         downstream measured 42.9 KB/s per client before the change and 43.2
         after. The win is the failure modes, not the bytes. GAP-038 is why -- nothing is replicated into existence -- and that
         argument holds for a fixed population, which missiles and items are and
         players are not.

         So the count is now the population: one client and four bots. The two
         pools that genuinely cannot grow are still pools, and are asserted
         beside it so the difference is visible rather than implied.
        */
        expect(net.players.length).toBe(rig.host.players.length);
        expect(net.players.length).toBe(5);
        expect(net.missiles.length).toBe(MAX_MISSILES);
        expect(net.items.length).toBe(rig.host.items.items.length);

        // And no entity is left over for an id nobody is using.
        for (let id = 0; id < MAX_CLIENTS; id++) {
            const here = rig.host.playerById(id) !== undefined;
            expect(
                net.playerById(id) !== undefined,
                `the client ${here ? 'is missing' : 'kept'} an entity for player ${id}`
            ).toBe(here);
        }

        /*
         Ownership, which is what decides prediction from interpolation -- and
         which is now how the client knows which player is *itself*. The host
         writes `owner_peer_id` in `admit` before the snapshot goes out, so the
         entity whose identity names this peer is the one the local `PlayerSlot`
         drives. That replaced an array index agreed by both peers building the
         same pool in the same order, and is better for the reason it is
         shorter: the answer is on the wire rather than reconstructed from a
         convention. See GAP-040.
        */
        const own = net.world.getComponent(net.ownSlot.entity, NetworkIdentity) as NetworkIdentity;
        expect(own.owner_peer_id).toBe(net.peerId);
        expect(own.network_id).toBeGreaterThanOrEqual(0);

        // The client's slot is connected on the host, and the host says so.
        expect(rig.host.playerById(net.slotIndex)!.connected).toBe(true);
        expect(rig.host.playerById(net.slotIndex)!.peerId).toBe(net.peerId);

        // Bots took the highest slots, so the client's is not one of them.
        expect(rig.host.playerById(net.slotIndex)!.bot).toBeNull();
        const botSlots = rig.host.players.filter((s) => s.bot !== null);
        expect(botSlots.length).toBe(4);
        expect(botSlots.every((s) => s.index > net.slotIndex)).toBe(true);
    });

    it('moves the client on the host when the client sends input', () => {
        const slotIndex = client.net.slotIndex;
        let previous = [...rig.host.playerById(slotIndex)!.state.origin];
        let walked = 0;

        client.script = circleWalk;
        for (let n = 0; n < 120; n++) {
            rig.step(1);
            const now = [...rig.host.playerById(slotIndex)!.state.origin];
            walked += Math.hypot(now[0]! - previous[0]!, now[1]! - previous[1]!);
            previous = now;
        }

        /*
         Distance walked rather than displacement, because the script walks a
         circle and comes back: two seconds at 320 u/s is about 640 units of
         path and can be nearly zero units of displacement.
        */
        expect(walked, 'the host never saw the client move').toBeGreaterThan(200);

        // And the host is actually receiving, at about the buffer it asked for.
        const depth = rig.host.session.server!.buffer_depth_for_peer(client.net.peerId);
        expect(depth).toBeGreaterThanOrEqual(0);
    });
});

describe('the prediction against the host, at zero latency', () => {
    it('measures how far the client and the host disagree', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 1, seed: 99 });
        const client = rig.clients[0]!;
        client.net.predictionTrace = new Map();
        client.script = circleWalk;

        rig.step(20); // settle the join

        const slotIndex = client.net.slotIndex;
        let worst = 0;
        let worstFrame = -1;
        let compared = 0;
        let exact = 0;

        for (let n = 0; n < 600; n++) {
            rig.step(1);

            /*
             The host's authority for the frame it has just simulated, against
             what this client predicted **for that same frame**. Comparing the
             two peers' *current* state instead measures the prediction lead:
             the client runs six frames ahead by construction, which at 320 u/s
             is 32 units of "divergence" in a simulation that agrees to the last
             bit.
            */
            const frame = rig.host.currentFrame;
            const predicted = client.net.predictionTrace!.get(frame);
            if (predicted === undefined) continue;

            const hostOrigin = rig.host.playerById(slotIndex)!.state.origin;
            const d = Math.hypot(
                predicted.origin[0]! - hostOrigin[0]!,
                predicted.origin[1]! - hostOrigin[1]!,
                predicted.origin[2]! - hostOrigin[2]!
            );

            compared += 1;
            if (d === 0) exact += 1;
            if (d > worst) {
                worst = d;
                worstFrame = frame;
            }
        }

        const net = client.net;
        const total = net.shortCircuitHits + net.shortCircuitMisses;
        const hitRate = total === 0 ? 0 : net.shortCircuitHits / total;

        // eslint-disable-next-line no-console
        console.log(
            `[net-loopback] frames compared ${compared}; bit-exact ${exact} ` +
                `(${((exact / compared) * 100).toFixed(1)}%); worst position divergence ` +
                `${worst.toFixed(6)} units at frame ${worstFrame}; short-circuit hits ` +
                `${net.shortCircuitHits}/${total} (${(hitRate * 100).toFixed(1)}%), ` +
                `misses ${net.shortCircuitNoRing} unpredicted + ` +
                `${net.shortCircuitDisagreed} disagreed; ` +
                `reconciles ${net.reconcileCount}, replayed frames ${net.replayFrames}`
        );

        /*
         The gate the plan names, with its own fallback. Bit-exactness is the
         target; D-131 measured a differently-shaped broadphase moving one sweep
         in a thousand by 1e-5, and 600 frames of strafe jumping is exactly the
         amplifier that turns 1e-5 into something visible. Whichever it is, the
         number above is in REPORT.md rather than in a comment.
        */
        expect(compared).toBeGreaterThan(500);
        expect(worst, 'the client and the host are not playing the same game').toBeLessThan(1e-3);
        expect(net.reconcileCount / compared, 'the client rewinds too often').toBeLessThan(0.05);
        expect(hitRate, 'the short-circuit is not holding').toBeGreaterThan(0.9);
    });
});

describe('every miss the short-circuit takes is accounted for', () => {
    it('is the health bleed, which is host-only state and cannot be predicted', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 1, seed: 99 });
        const client = rig.clients[0]!;
        client.script = circleWalk;

        const slot = rig.host.playerById(client.net.slotIndex)!;
        const startHealth = slot.slot.inventory.health;

        rig.step(60 * 40);

        const endHealth = slot.slot.inventory.health;
        const bled = startHealth - endHealth;

        // eslint-disable-next-line no-console
        console.log(
            `[net-loopback] 40 s: health ${startHealth} -> ${endHealth} (${bled} bleed ticks); ` +
                `short-circuit misses ${client.net.shortCircuitNoRing} unpredicted + ` +
                `${client.net.shortCircuitDisagreed} disagreed`
        );

        /*
         `ClientTimerActions` bleeds one point a second off health above
         `maxHealth`, and a Q3 player spawns with 125 against a max of 100. That
         is 25 points of host-only state the client has no way to predict, so
         each one costs exactly one AUTH_STATE that does not short-circuit and
         one rewind that corrects it. Measured across three run lengths: 11
         disagreements at 10 s, 23 at 20 s, 31 at 40 s -- rising one per second
         while the bleed runs and **stopping when health reaches 100**, which is
         what says it is the bleed and not a drift.

         The correct fix is to predict the bleed on the client, which means the
         one-second timer becomes shared state; it is step 6's, listed there.
         What matters here is that the misses are bounded and explained rather
         than growing.
        */
        expect(endHealth).toBe(slot.slot.inventory.maxHealth);
        expect(client.net.shortCircuitDisagreed).toBeLessThanOrEqual(bled + 10);
        expect(client.net.shortCircuitDisagreed).toBeGreaterThanOrEqual(bled - 5);

        // And the frames it never predicted are the join, not a continuing gap.
        expect(client.net.shortCircuitNoRing).toBeLessThan(20);
    });
});

describe('a weapon change on the client', () => {
    /**
     * `usercmd_t.weapon` is the only way a host hears about one.
     *
     * Single-player switches by writing `slot.weapon` and is right to: it is the
     * only machine running the simulation. A networked client that did the same
     * would be telling itself, and nothing else -- the host's copy of that slot
     * would keep firing the machinegun while the player's screen showed a
     * gauntlet, and `NetPlayerState.weapon` would disagree on every frame until
     * a reconcile pulled the client back onto the host's choice. So the request
     * rides the command, and this is the test that it arrives.
     */
    it('reaches the host, and both ends agree about what is in hand', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 1, seed: 31, warmup: 40 });
        const client = rig.clients[0]!;
        const slot = rig.host.playerById(client.net.slotIndex)!;

        // Everyone spawns holding the machinegun, with the gauntlet also in the
        // loadout -- `newInventory` -- so this is a change between two weapons
        // the slot really has.
        rig.step(60);
        expect(slot.slot.weapon, 'the fixture does not start on the machinegun').toBe(
            'WP_MACHINEGUN'
        );

        client.script = (cmd) => {
            cmd.weapon = weaponIndex('WP_GAUNTLET') + 1;
        };
        rig.step(60);

        expect(client.net.slot.weapon, 'the client did not switch').toBe('WP_GAUNTLET');
        expect(slot.slot.weapon, 'the host never heard about the switch').toBe('WP_GAUNTLET');
        expect(
            client.net.ownSlot.state.weapon,
            'the replicated weapon disagrees with the host'
        ).toBe(weaponIndex('WP_GAUNTLET'));
    });

    it('is refused for a weapon the slot does not have, on both ends', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 1, seed: 31, warmup: 40 });
        const client = rig.clients[0]!;
        const slot = rig.host.playerById(client.net.slotIndex)!;

        rig.step(60);

        /*
         Q3 ignores a select of a weapon you do not have rather than beeping or
         switching to the nearest usable one. Here it also matters that the
         *host* ignores it: the command is the one thing in this protocol that
         a client authors, so it is the one thing a client could lie with.
        */
        client.script = (cmd) => {
            cmd.weapon = weaponIndex('WP_ROCKET_LAUNCHER') + 1;
        };
        rig.step(60);

        expect(client.net.slot.weapon, 'the client armed itself with a weapon it has not got').toBe(
            'WP_MACHINEGUN'
        );
        expect(slot.slot.weapon, 'the host believed a client that asked for a rocket launcher').toBe(
            'WP_MACHINEGUN'
        );
    });

    it('does not cost the prediction short-circuit', async () => {
        /*
         The reason the request rides the command rather than being sent beside
         it. A weapon the two ends disagree about is a byte of `NetPlayerState`
         they disagree about, and that is the whole of what the short-circuit
         compares -- so a switch done the wrong way would not merely look wrong,
         it would put the client back to rewinding and replaying its lead sixty
         times a second, exactly as D-178's unbounded cooldown did.
        */
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 1, seed: 31, warmup: 40 });
        const client = rig.clients[0]!;
        const net = client.net;

        let frame = 0;
        client.script = (cmd) => {
            // Switch back and forth every half second, which is faster than
            // anybody plays and is the point.
            frame += 1;
            cmd.weapon =
                weaponIndex(frame % 60 < 30 ? 'WP_GAUNTLET' : 'WP_MACHINEGUN') + 1;
        };

        rig.step(120);
        net.shortCircuitHits = 0;
        net.shortCircuitMisses = 0;
        rig.step(600);

        const total = net.shortCircuitHits + net.shortCircuitMisses;

        // eslint-disable-next-line no-console
        console.log(
            `[net-loopback] switching weapons twice a second: short-circuit ` +
                `${net.shortCircuitHits}/${total}`
        );

        expect(
            net.shortCircuitHits / total,
            'switching weapons collapsed the prediction short-circuit'
        ).toBeGreaterThan(0.9);
    });
});

describe('the bodies of slots nobody is playing', () => {
    /**
     * The failure this pins is silent, total, and was invisible to every other
     * test in this file.
     *
     * `Host.buildPools` parks an unconnected slot's body a million units below
     * the map, and says why: a body is solid, `MAX_CLIENTS` is 16, and sixteen
     * bodies left wherever their origins happen to sit put collision where no
     * player is. The client built the same pool of sixteen and did not carry
     * the same rule.
     *
     * So the local player's own sweep hit a box the host does not have, and was
     * depenetrated a whole player-width sideways -- 30.16 units in x, measured,
     * standing still on `oa_dm1` with two bots. Its position then disagreed
     * with the host's on every frame for ever: 600 reconciles in 600 frames,
     * with the AUTH_STATE short-circuit missing every time.
     *
     * Nothing else here would have caught it. The clients in the other tests
     * *walk*, and a walking player leaves the parked body behind within a
     * second and agrees from then on; this one stands still, which is both the
     * cheapest case there is and the one a player in a menu is actually in.
     */
    it('are parked below the map, so a client standing still is not shoved off one', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 2, clients: 1, seed: 23, warmup: 40 });
        const client = rig.clients[0]!;
        const net = client.net;

        // Settle, then measure only the steady state.
        rig.step(120);
        net.shortCircuitHits = 0;
        net.shortCircuitMisses = 0;
        net.reconcileCount = 0;
        rig.step(600);

        const own = net.ownSlot;
        const host = rig.host.playerById(net.slotIndex)!;
        const drift = Math.hypot(
            own.state.origin[0]! - host.state.origin[0]!,
            own.state.origin[1]! - host.state.origin[1]!,
            own.state.origin[2]! - host.state.origin[2]!
        );

        const total = net.shortCircuitHits + net.shortCircuitMisses;

        // eslint-disable-next-line no-console
        console.log(
            `[net-loopback] idle beside two bots: short-circuit ${net.shortCircuitHits}/${total}, ` +
                `reconciles ${net.reconcileCount}, drift from the host ${drift.toFixed(3)} units`
        );

        /*
         Zero, not "small". A player who is not moving and is not being pushed
         by anything the host knows about has no reason to be anywhere but where
         the host put it, and the failure this replaces was a clean 30.16.
        */
        expect(drift, 'the client drifted from the host while standing still').toBeLessThan(0.001);

        /*
         The bound rather than an equality because the health bleed is a real,
         documented, unpredictable miss (D-170) and costs about one a second.
         What it must never be again is zero hits.
        */
        expect(
            net.shortCircuitHits / total,
            'the prediction short-circuit collapsed; a body is in the way again'
        ).toBeGreaterThan(0.9);
    });

    it('has no body for a player who is not here, because it has no player', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 2, clients: 1, seed: 23, warmup: 40 });
        rig.step(60);

        const net = rig.clients[0]!.net;

        /*
         **The assertion that replaces the parking, and it is stronger.**

         This test used to check that a slot nobody was in had its body put a
         million units below the map rather than wherever its stale component
         said -- GAP-044, where the client built sixteen bodies and parked none,
         and the local player's own sweep hit one of them and was depenetrated
         30.16 units off the host's position for ever. The workaround was to
         park the unused ones. There are no unused ones: an entity exists for a
         player who is here and for nobody else (D-194), so the failure mode has
         no material to work with rather than being defended against.

         So what is checked is the two ends agreeing about the population, which
         is the property the parking was protecting.
        */
        expect(net.players.length).toBe(rig.host.players.length);

        for (const player of net.players) {
            const host = rig.host.playerById(player.index);
            expect(host, `the client has a player ${player.index} the host does not`).toBeDefined();
            expect(host!.connected, 'the two ends disagree about who is playing').toBe(true);
            expect(player.state.connected, 'a player who is here is marked absent').not.toBe(0);
        }

        for (const host of rig.host.players) {
            expect(
                net.playerById(host.index),
                `the host has a player ${host.index} the client never heard of`
            ).toBeDefined();
        }
    });
});

describe('what the host tells the client about', () => {
    it('activates a missile slot when a bot fires, and deactivates it on impact', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 4,
            clients: 1,
            seed: MATCH_SEED,
            warmup: 40,
        });
        const client = rig.clients[0]!;

        /*
         The client walks. A stationary one is not a smaller version of this
         test, it is a different one: `match.test.ts` measured bots getting 0.4
         seconds of line of sight to a fixed point at this spawn over thirty
         seconds, so a standing client produces a match in which the fight
         branch never honestly starts. Same lesson, second time.
        */
        client.script = circleWalk;
        rig.step(60 * 40);

        const anyGeneration = client.net.missiles.some((m) => m.component.generation > 0);

        // eslint-disable-next-line no-console
        console.log(
            `[net-loopback] 40 s with 4 bots: host shots ${rig.host.weaponEvents.shots}, ` +
                `projectiles ${rig.host.weaponEvents.projectiles}, explosions ` +
                `${rig.host.weaponEvents.explosions}, damage ${rig.host.weaponEvents.damage}; ` +
                `client effects ${client.effects.length}, hits ${client.hits.length}, ` +
                `pickups ${client.pickups.length}`
        );

        expect(rig.host.weaponEvents.shots, 'no bot ever fired').toBeGreaterThan(0);
        expect(
            rig.host.weaponEvents.projectiles,
            'no projectile was ever launched'
        ).toBeGreaterThan(0);
        expect(anyGeneration, 'no missile slot was ever used on the client').toBe(true);

        // The host raised effects, and the client heard about them.
        expect(client.effects.length, 'no effect reached the client').toBeGreaterThan(0);

        const kinds = new Set(client.effects.map((e) => e.kind));
        expect(kinds.has(EffectKind.MuzzleFlash)).toBe(true);
        expect(kinds.has(EffectKind.Explosion)).toBe(true);
    });

    it('tells the client when it is hit, and the damage reaches its inventory', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 4,
            clients: 1,
            seed: MATCH_SEED,
            warmup: 40,
        });
        const client = rig.clients[0]!;
        client.script = circleWalk;

        rig.step(60 * 40);

        const slotIndex = client.net.slotIndex;
        const taken = client.hits.filter((h) => h.victim === slotIndex);

        expect(taken.length, 'the client was never told it was hit').toBeGreaterThan(0);

        /*
         And the health the client holds is the host's, not its own guess: a
         hitscan is resolved where the host has everyone *now* (there is no lag
         compensation in v1), so damage is never predicted and arrives entirely
         through AUTH_STATE.
        */
        const hostHealth = rig.host.playerById(slotIndex)!.slot.inventory.health;
        expect(client.net.ownSlot.inventory.health).toBe(hostHealth);
    });

    it('lets the client fire, exactly once per cooldown', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 1, seed: 11 });
        const client = rig.clients[0]!;

        rig.step(20);

        const before = rig.host.weaponEvents.shots;
        const ammoBefore = rig.host.playerById(client.net.slotIndex)!.inventory.ammo[1]!;

        client.script = (cmd) => {
            cmd.buttons = C.BUTTON_ATTACK;
        };

        // Two seconds of held trigger, expressed as seconds. It said 120
        // frames, which meant two seconds at 60 Hz and four at 30.
        rig.step(2 * TICK_HZ);

        const fired = rig.host.weaponEvents.shots - before;
        const ammoAfter = rig.host.playerById(client.net.slotIndex)!.inventory.ammo[1]!;

        /*
         The machinegun's fire rate is 100 ms, so two seconds of held trigger is
         twenty rounds give or take the frame the first one lands on. What this
         is really asserting is that it is *not* sixty: a shot fired once per
         frame would mean the cooldown never survived the round trip through
         `load`/`store`, and a shot fired more than once per frame would mean a
         rollback replayed the command and the frame key did not stop it.
        */
        expect(fired).toBeGreaterThan(10);
        expect(fired).toBeLessThan(30);
        expect(ammoBefore - ammoAfter, 'ammunition and shots disagree').toBe(fired);

        /*
         And the client predicted the same shots it was charged for -- once the
         host has caught up. The client leads by the prediction lead, so at the
         instant the trigger is released it has predicted a shot or two the host
         has not executed yet; comparing there is comparing two different
         moments and was off by one the day the tick rate moved and the window
         stopped happening to align.
        */
        client.script = () => {};
        rig.step(SIMULATION_DELAY_TICKS + 8);

        const settled = rig.host.weaponEvents.shots - before;
        expect(client.predictedShots.length, 'predicted and charged shots disagree').toBe(
            settled
        );
    });

    it('publishes bot slots as remote state that moves', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 4, clients: 1, seed: 3 });
        const client = rig.clients[0]!;

        rig.step(30);

        const botSlots = rig.host.players.filter((s) => s.bot !== null).map((s) => s.index);
        const before = botSlots.map((i) => [...client.net.playerById(i)!.state.origin]);

        rig.step(240);

        const after = botSlots.map((i) => [...client.net.playerById(i)!.state.origin]);

        let moved = 0;
        for (let i = 0; i < botSlots.length; i++) {
            const d = Math.hypot(
                after[i]![0]! - before[i]![0]!,
                after[i]![1]! - before[i]![1]!
            );
            if (d > 32) moved += 1;
        }

        expect(moved, 'no bot moved on the client').toBeGreaterThan(0);

        // Every slot's numbers are finite, connected or not.
        for (const slot of client.net.players) {
            for (const v of slot.state.origin) expect(Number.isFinite(v)).toBe(true);
            for (const v of slot.state.velocity) expect(Number.isFinite(v)).toBe(true);
        }
    });
});
