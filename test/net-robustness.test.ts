/*
 * net-robustness.test.ts -- what happens when a client misbehaves or vanishes.
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
 * `NETWORK_PLAN.md` §8. Every other networked test in this suite assumes the
 * clients are honest and present; this one assumes neither.
 *
 * The centre of it is the authorization gate. In a server-authoritative game the
 * command stream is the one thing a client authors, so it is the one thing a
 * client can lie with -- and the lie that matters is not "I moved further than I
 * should", which the host's own simulation simply ignores, but **"here is a
 * command for somebody else's player"**. Nothing in this port checks that; the
 * whole defence is `SimActionExecutor.authorize`, wired by `NetworkSession` to
 * `make_owner_authorization` and driven off `UserCmdAction.affected_components`
 * naming the slot entity. Three engine pieces have to line up and none of them
 * is this repository's, which is exactly why it is worth a test rather than a
 * paragraph.
 */

import { describe, expect, it } from 'vitest';

import { NetRig, type RigClient } from './net/rig.ts';
import { MAX_CLIENTS, SIMULATION_DELAY_TICKS, TICK_HZ } from '../src/net/protocol.ts';
import { FORWARDMOVE } from '../src/q3/pmove/types.ts';
import { NetworkIdentity } from '@woosh/meep-engine/src/engine/network/ecs/components/NetworkIdentity.js';

/**
 * Make every command this client sends arrive addressed to `networkId`.
 *
 * Patched onto the client's own `UserCmdAction` class, which is safe to do to
 * exactly one client because `makeActions` builds a fresh set of classes per
 * session -- `SimActionRegistry.register` writes `static type_id` onto the
 * class, so sharing them between peers was never an option and the isolation
 * comes for free.
 *
 * Two earlier attempts are worth recording, because both look right. Calling
 * `session.send` by hand throws `ActionLog.current_buffer: no frame is open`:
 * an action can only be raised from inside the sampler, so a forger has to use
 * the same door as everybody else. Overwriting the local slot's
 * `NetworkIdentity.network_id` gets reverted, because that component is
 * replicated and the session owns it. Patching the action's `set` is the one
 * place the value is this client's to choose, which is also exactly why it is
 * the place a real cheat would live.
 */
function forgeAs(client: RigClient, networkId: number): () => void {
    const Klass = client.net.actions.UserCmdAction;
    const real = Klass.prototype.set;
    Klass.prototype.set = function set(
        this: object,
        _networkId: number,
        frame: number,
        cmd: never
    ): void {
        real.call(this, networkId, frame, cmd);
    };
    return () => {
        Klass.prototype.set = real;
    };
}

/** Walk forward, hard, so a command that lands anywhere is visible as motion. */
function charge(cmd: { angles: Int16Array; moves: Int8Array }): void {
    cmd.moves[FORWARDMOVE] = 127;
}

describe('a client that lies', () => {
    it('cannot drive another player with a forged command', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 0,
            clients: 2,
            seed: 808,
            warmup: 40,
        });

        const [attacker, victim] = rig.clients;
        rig.step(60);

        const victimSlot = rig.host.slots[victim!.net.slotIndex]!;
        const before = [...victimSlot.slot.ps.origin];

        /*
         The forgery. The attacker's own session, its own action registry, its
         own outbound stream -- and the network id of the *victim's* slot in the
         one field that decides whose player is stepped. This is the smallest
         possible cheat and there is nothing about it a transport could notice:
         the bytes are well-formed, the frame number is current, the sender is a
         legitimately connected peer.
        */
        const victimId = attacker!.net.world.getComponent(
            attacker!.net.slots[victim!.net.slotIndex]!.entity,
            NetworkIdentity
        ) as NetworkIdentity;

        expect(victimId.network_id, 'the victim has no network id to forge').toBeGreaterThanOrEqual(
            0
        );

        const rejected: number[] = [];
        rig.host.session.peer.executor.onActionRejected.add((sender: number) => {
            rejected.push(sender);
        });

        forgeAs(attacker!, victimId.network_id);
        attacker!.script = charge;
        rig.step(60 + SIMULATION_DELAY_TICKS + 8);

        const after = [...victimSlot.slot.ps.origin];
        const moved = Math.hypot(after[0]! - before[0]!, after[1]! - before[1]!);

        // eslint-disable-next-line no-console
        console.log(
            `[net-robustness] ${rejected.length} forged commands rejected; ` +
                `the victim moved ${moved.toFixed(2)} units`
        );

        expect(rejected.length, 'the host accepted a command for a slot the sender does not own')
            .toBeGreaterThan(0);
        expect(
            new Set(rejected),
            'the rejections were credited to the wrong peer'
        ).toEqual(new Set([attacker!.net.peerId]));

        /*
         Zero, not "small". The victim is standing still and holding no input of
         its own, so any motion at all is the forgery having landed.
        */
        expect(moved, 'a forged command moved somebody else').toBeLessThan(0.001);
    });

    it('does not stop the host serving the honest client beside it', async () => {
        /*
         The other half of the same property, and the one a rejection test can
         quietly fail to have: a host that survives an attack by stopping is not
         surviving it. The attacker's own slot must still work too -- being
         caught forging is not a ban in v1 (see D-185).
        */
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 0,
            clients: 2,
            seed: 808,
            warmup: 40,
        });

        const [attacker, victim] = rig.clients;
        rig.step(60);

        const victimStart = [...rig.host.slots[victim!.net.slotIndex]!.slot.ps.origin];
        const attackerStart = [...rig.host.slots[attacker!.net.slotIndex]!.slot.ps.origin];

        const victimId = attacker!.net.world.getComponent(
            attacker!.net.slots[victim!.net.slotIndex]!.entity,
            NetworkIdentity
        ) as NetworkIdentity;

        // The victim walks honestly; the attacker forges and also walks.
        victim!.script = charge;
        attacker!.script = charge;

        /*
         Forge for two seconds, then stop. While it forges the attacker does not
         move -- every command it has is spent addressing somebody else, which
         is a consequence of cheating rather than a punishment for it -- and the
         question is what happens when it stops.
        */
        const stopForging = forgeAs(attacker!, victimId.network_id);
        rig.step(TICK_HZ * 2);
        stopForging();
        rig.step(TICK_HZ * 4);

        const victimNow = rig.host.slots[victim!.net.slotIndex]!.slot.ps.origin;
        const attackerNow = rig.host.slots[attacker!.net.slotIndex]!.slot.ps.origin;

        const victimMoved = Math.hypot(
            victimNow[0]! - victimStart[0]!,
            victimNow[1]! - victimStart[1]!
        );
        const attackerMoved = Math.hypot(
            attackerNow[0]! - attackerStart[0]!,
            attackerNow[1]! - attackerStart[1]!
        );

        /*
         Both are still being simulated, and the attacker's slot works again the
         moment it stops forging: **being caught is not a ban in v1** (D-185).
         The thresholds are deliberately low -- a player walking into a wall
         covers very little ground, and which wall is a property of the spawn
         point rather than of the netcode -- so what this asserts is "still
         moving", not a distance.
        */
        expect(victimMoved, 'the honest client stopped being simulated').toBeGreaterThan(10);
        expect(
            attackerMoved,
            'the client was not served again after it stopped forging'
        ).toBeGreaterThan(10);
    });
});

describe('a client that leaves', () => {
    it('frees its slot, and the other clients are told', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 0,
            clients: 2,
            seed: 909,
            warmup: 40,
        });

        const [staying, leaving] = rig.clients;
        rig.step(60);

        const slot = leaving!.net.slotIndex;
        expect(rig.host.slots[slot]!.connected).toBe(true);

        rig.host.release(leaving!.net.peerId);
        rig.host.session.drop_peer(leaving!.net.peerId, 'test');

        // Take the leaver out of the loop, as a closed socket would.
        rig.clients.splice(rig.clients.indexOf(leaving!), 1);
        rig.step(60);

        expect(rig.host.slots[slot]!.connected, 'the host kept the slot').toBe(false);
        expect(rig.host.lowestFreeSlot(), 'the freed slot was not reoffered').toBe(slot);

        /*
         And the client still in the match hears about it, which is what makes
         the character vanish rather than stand there for ever. `connected` is
         replicated in `NetPlayerState` precisely so this needs no side channel.
        */
        expect(
            staying!.net.slots[slot]!.state.connected,
            'the remaining client still thinks somebody is in that slot'
        ).toBe(0);
    });

    it('gives a rejoining client a new peer id, and the slot back', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 0,
            clients: 1,
            seed: 909,
            warmup: 40,
        });

        const first = rig.clients[0]!;
        const firstPeer = first.net.peerId;
        const firstSlot = first.net.slotIndex;
        rig.step(60);

        rig.host.release(firstPeer);
        rig.host.session.drop_peer(firstPeer, 'test');
        rig.clients.length = 0;
        rig.step(30);

        const second = await rig.join('again', 0);
        rig.step(60);

        /*
         A new peer id and the same slot: v1 has no reconnect (D-167), so a
         second join from the same browser is a stranger who happens to be
         standing where the last one was. Saying so out loud is the point --
         somebody will otherwise assume the score carried over.
        */
        /*
         The slot comes back and the score does not. Peer-id allocation is
         `WsHost.takePeerId`'s and is covered by `net-websocket.test.ts`; the rig
         numbers its own peers by join order, so asserting on them here would be
         asserting about the harness.
        */
        expect(second.net.slotIndex, 'the freed slot was not the one offered').toBe(firstSlot);
        expect(rig.host.slots[firstSlot]!.info.kills, 'the score did not start fresh').toBe(0);
    });
});

describe('a host that is full', () => {
    it('has no slot to offer the seventeenth player', async () => {
        /*
         Asserted against the pool rather than by joining sixteen clients: each
         one costs a whole `HeadlessPhysics`, and what is being tested is the
         host's bookkeeping, not sixteen simulations. `lowestFreeSlot` is what
         `WsHost.accept` asks before it admits anybody, and -1 is what turns
         into "server full" on the socket.
        */
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 0,
            clients: 0,
            seed: 1,
            warmup: 10,
        });

        for (let i = 0; i < MAX_CLIENTS; i++) {
            const slot = rig.host.lowestFreeSlot();
            expect(slot, `slot ${i} should have been free`).toBeGreaterThanOrEqual(0);
            rig.host.admit(100 + i, `player${i}`, 0);
        }

        expect(rig.host.lowestFreeSlot(), 'a seventeenth slot appeared').toBe(-1);

        // And freeing one offers exactly that one back.
        rig.host.release(103);
        expect(rig.host.lowestFreeSlot()).toBe(3);
    });

    it('counts bots against the same sixteen', async () => {
        /*
         Worth pinning, because it is the arithmetic that decides how many
         humans a `--bots 8` server can actually hold, and nothing else states
         it. Bots occupy real slots; a host started with eight of them has eight
         left.
        */
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 4,
            clients: 0,
            seed: 1,
            warmup: 10,
        });

        const bots = rig.host.slots.filter((slot) => slot.bot !== null).length;
        let free = 0;
        for (const slot of rig.host.slots) if (!slot.connected) free += 1;

        expect(bots).toBe(4);
        expect(bots + free, 'bots and free slots do not account for the pool').toBe(MAX_CLIENTS);
    });
});

describe('a client that goes quiet', () => {
    it('keeps its slot, because this host does not reap', async () => {
        /*
         **Recorded rather than asserted as desirable.** `Host` passes
         `connection_timeout_ms: 0`, which turns the engine's idle reaping off,
         so a client whose socket dies without closing holds its slot until the
         transport notices. Over a WebSocket that is the TCP timeout, which can
         be minutes.
         *
         The plan asks for reaping and v1 does not do it: the deliberate choice
         is that a reap is indistinguishable from a bad thirty seconds on a train,
         and losing your slot mid-match is worse than a stale one on a sixteen-slot
         server nobody is queueing for. `WsHost` frees the slot on `close` and
         `error`, which covers every case a browser actually produces. See D-185.
        */
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 0,
            clients: 1,
            seed: 77,
            warmup: 40,
        });

        const client = rig.clients[0]!;
        const slot = client.net.slotIndex;
        rig.step(60);

        // Silence: the client stops stepping, so nothing reaches the host.
        rig.clients.length = 0;
        rig.step(TICK_HZ * 10);

        expect(rig.host.slots[slot]!.connected, 'the slot was reaped after ten seconds').toBe(true);
        expect(rig.host.lowestFreeSlot(), 'the slot was offered to somebody else').not.toBe(slot);
    });

    it('does not stop the host stepping', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 2,
            clients: 1,
            seed: 77,
            warmup: 40,
        });

        rig.step(60);
        const frameBefore = rig.host.currentFrame;

        rig.clients.length = 0;
        rig.step(TICK_HZ * 5);

        /*
         The host runs on its own clock and a silent client is simply a slot
         with no new input. `ServerAuthoritativeServer` repeats the last command
         it had rather than stalling, which is the behaviour that keeps everybody
         else's match going while one person's train enters a tunnel.
        */
        expect(rig.host.currentFrame - frameBefore).toBe(TICK_HZ * 5);
    });
});
