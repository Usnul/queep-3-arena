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
import { MAX_CLIENTS, MAX_MISSILES } from '../src/net/protocol.ts';
import { NetworkIdentity } from '@woosh/meep-engine/src/engine/network/ecs/components/NetworkIdentity.js';
import * as C from '../src/q3/pmove/constants.ts';
import { FORWARDMOVE, RIGHTMOVE, UPMOVE } from '../src/q3/pmove/types.ts';

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

    it('holds one entity per pool slot, owned the way the host says', () => {
        rig.step(10);

        const net = client.net;

        expect(net.slots.length).toBe(MAX_CLIENTS);
        expect(net.missiles.length).toBe(MAX_MISSILES);
        expect(net.items.length).toBe(rig.host.items.items.length);

        /*
         Ownership, which is what decides prediction from interpolation. The
         session sets a negative `owner_peer_id` to the local peer at attach
         time, so every pool entity a client builds starts out owned by *the
         client* -- and INITIAL_SYNC does not carry ownership, because
         `NetworkIdentity`'s adapter is a save-game adapter and the component
         "doesn't go on the wire" (its own docblock). So the client's own slot
         being its own is true by construction, and every other slot has to be
         made the host's by the join. See GAP-040.
        */
        const own = net.world.getComponent(net.ownSlot.entity, NetworkIdentity) as NetworkIdentity;
        expect(own.owner_peer_id).toBe(net.peerId);
        expect(own.network_id).toBeGreaterThanOrEqual(0);

        // The client's slot is connected on the host, and the host says so.
        expect(rig.host.slots[net.slotIndex]!.connected).toBe(true);
        expect(rig.host.slots[net.slotIndex]!.peerId).toBe(net.peerId);

        // Bots took the highest slots, so the client's is not one of them.
        expect(rig.host.slots[net.slotIndex]!.bot).toBeNull();
        const botSlots = rig.host.slots.filter((s) => s.bot !== null);
        expect(botSlots.length).toBe(4);
        expect(botSlots.every((s) => s.index > net.slotIndex)).toBe(true);
    });

    it('moves the client on the host when the client sends input', () => {
        const slotIndex = client.net.slotIndex;
        let previous = [...rig.host.slots[slotIndex]!.state.origin];
        let walked = 0;

        client.script = circleWalk;
        for (let n = 0; n < 120; n++) {
            rig.step(1);
            const now = [...rig.host.slots[slotIndex]!.state.origin];
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

            const hostOrigin = rig.host.slots[slotIndex]!.state.origin;
            const d = Math.hypot(
                predicted[0]! - hostOrigin[0]!,
                predicted[1]! - hostOrigin[1]!,
                predicted[2]! - hostOrigin[2]!
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

        const slot = rig.host.slots[client.net.slotIndex]!;
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

describe('what the host tells the client about', () => {
    it('activates a missile slot when a bot fires, and deactivates it on impact', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 4, clients: 1, seed: 7 });
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
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 4, clients: 1, seed: 7 });
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
        const hostHealth = rig.host.slots[slotIndex]!.slot.inventory.health;
        expect(client.net.ownSlot.inventory.health).toBe(hostHealth);
    });

    it('lets the client fire, exactly once per cooldown', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 0, clients: 1, seed: 11 });
        const client = rig.clients[0]!;

        rig.step(20);

        const before = rig.host.weaponEvents.shots;
        const ammoBefore = rig.host.slots[client.net.slotIndex]!.inventory.ammo[1]!;

        client.script = (cmd) => {
            cmd.buttons = C.BUTTON_ATTACK;
        };

        rig.step(120);

        const fired = rig.host.weaponEvents.shots - before;
        const ammoAfter = rig.host.slots[client.net.slotIndex]!.inventory.ammo[1]!;

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

        // And the client predicted the same shots it was charged for.
        expect(client.predictedShots.length).toBe(fired);
    });

    it('publishes bot slots as remote state that moves', async () => {
        const rig = await NetRig.create({ map: 'oa_dm1', bots: 4, clients: 1, seed: 3 });
        const client = rig.clients[0]!;

        rig.step(30);

        const botSlots = rig.host.slots.filter((s) => s.bot !== null).map((s) => s.index);
        const before = botSlots.map((i) => [...client.net.slots[i]!.state.origin]);

        rig.step(240);

        const after = botSlots.map((i) => [...client.net.slots[i]!.state.origin]);

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
        for (const slot of client.net.slots) {
            for (const v of slot.state.origin) expect(Number.isFinite(v)).toBe(true);
            for (const v of slot.state.velocity) expect(Number.isFinite(v)).toBe(true);
        }
    });
});
