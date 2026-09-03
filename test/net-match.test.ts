/*
 * net-match.test.ts -- two clients and four bots, playing a real match.
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
 * The other network tests each hold one property still while they measure
 * another: `net-loopback` walks one client in a circle, `net-join-late` joins an
 * old match, `net-latency` shakes the link. This one lets a whole match run and
 * asks whether it was a match -- two humans, four bots, everybody shooting at
 * everybody, for a minute.
 *
 * **Two clients is the point, not a bigger number.** Every bot targeting
 * decision, every scoring rule and every per-slot piece of state is a rule that
 * reads "the player" in single-player and has to read "whichever player" here;
 * one client cannot tell those apart and three do not test anything the second
 * did not. `NETWORK_PLAN.md` §6 is the list.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { NetRig, type RigClient } from './net/rig.ts';
import { MAX_CLIENTS } from '../src/net/protocol.ts';
import * as C from '../src/q3/pmove/constants.ts';
import { FORWARDMOVE, RIGHTMOVE, type UserCmd } from '../src/q3/pmove/types.ts';

/**
 * `usercmd_t.angles`, which are 16-bit.
 *
 * The same three lines as `net-join-late.test.ts`; the port has no shared
 * `ANGLE2SHORT` because nothing in `src/` ever needs one -- the browser
 * accumulates mouse deltas straight into shorts and never converts degrees.
 */
function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

/** Seconds of match. Long enough for both clients to die and respawn. */
const SECONDS = 45;
const FRAMES = SECONDS * 60;

/**
 * Aim at the nearest bot and hold the trigger, walking a little so the walk is
 * not a stand-still edge case and so pickups get taken.
 *
 * The angles are computed from *replicated* state -- this client's own predicted
 * origin and the host's last word on where the bots are -- which is the only
 * information a real client has. That makes the shooting a genuine test of the
 * pipeline rather than of the fixture: if the remote slots were not arriving,
 * the aim would be at (0, 0, 0) and nothing would ever be hit.
 */
function hunt(cmd: UserCmd, frame: number, self: RigClient): void {
    const net = self.net;
    const me = net.ownSlot.state.origin;

    let bestYaw = 0;
    let bestPitch = 0;
    let bestDistance = Infinity;

    for (const slot of net.players) {
        if (slot.index === net.slotIndex) continue;
        if (slot.info.isBot === 0) continue;
        if (slot.state.alive === 0) continue;

        const dx = slot.state.origin[0]! - me[0]!;
        const dy = slot.state.origin[1]! - me[1]!;
        // Eye to chest, so the shot does not pass over a bot's head.
        const dz = slot.state.origin[2]! + 16 - (me[2]! + 26);

        const distance = Math.hypot(dx, dy, dz);
        if (distance >= bestDistance) continue;

        bestDistance = distance;
        bestYaw = (Math.atan2(dy, dx) * 180) / Math.PI;
        bestPitch = (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI;
    }

    cmd.angles[0] = angleToShort(bestPitch);
    cmd.angles[1] = angleToShort(bestYaw);

    // Forward at all times and sideways on a slow cycle: enough to cross the
    // level and walk over pickups without needing a path finder in a test.
    cmd.moves[FORWARDMOVE] = 96;
    cmd.moves[RIGHTMOVE] = Math.sin(frame / 90) * 80;

    if (bestDistance < Infinity) cmd.buttons |= C.BUTTON_ATTACK;
}

/**
 * Frames of match recorded as "recent", for the scoreboard comparison.
 *
 * Two seconds. A client's copy has to be one of the host's from inside this
 * window; anything older is a client that stopped being told.
 */
const SETTLE_FRAMES = 120;

interface Outcome {
    rig: NetRig;
    /** Damage each slot dealt and took, from a client's own event log. */
    dealt: number[];
    taken: number[];
    droppedActions: { peer: number; frame: number; why: string }[];
    /** Every scoreboard the host held during the settling window. */
    hostBoards: Set<string>;
}

let outcome: Outcome;

beforeAll(async () => {
    const rig = await NetRig.create({
        map: 'oa_dm1',
        bots: 4,
        clients: 2,
        seed: 6006,
        warmup: 40,
    });

    for (const client of rig.clients) client.script = hunt;

    const dealt = new Array<number>(MAX_CLIENTS).fill(0);
    const taken = new Array<number>(MAX_CLIENTS).fill(0);
    const droppedActions: { peer: number; frame: number; why: string }[] = [];

    /*
     `onPendingActionDropped` is the host saying it threw a client's input away
     -- too far in the future, or too far in the past for the ring. Either is a
     player whose shot did not happen, and neither raises anything else, so the
     signal is the only place it can be seen.
    */
    const server = rig.host.session.server;
    server?.onPendingActionDropped.add((peer: number, frame: number, why: string) => {
        droppedActions.push({ peer, frame, why });
    });

    rig.step(FRAMES);

    /*
     Damage is counted from a **client's** `HitEvent` log rather than from the
     host's, for two reasons. The host's `weaponEvents.hits` is a per-frame
     queue, cleared at the top of every world step, so anything read from
     outside the frame that filled it is empty -- which is what the first
     version of this test measured, and it dutifully reported zero damage in a
     match with seven frags in it. And counting from the client also proves the
     events crossed the wire, which is half of what this file is for.
    */
    for (const hit of rig.clients[0]!.hits) {
        if (hit.victim < MAX_CLIENTS) taken[hit.victim] += hit.damage;
        if (hit.attacker < MAX_CLIENTS) dealt[hit.attacker] += hit.damage;
    }

    /*
     Then a settling window, recording every scoreboard the host passes through.

     Asking a client to equal the host *at an instant* is asking the wrong
     question, and the first version of this test asked it: a client is a few
     frames behind by design, and with six fighters the host awards a frag every
     second or two, so the two are legitimately unequal most of the time and
     "wait until they agree" simply never returns.

     The property that is actually true, and worth holding, is that a client's
     scoreboard is **a scoreboard the host really had** -- the host's, delayed.
     So this records the host's for every frame of the window and the assertion
     is set membership.
    */
    const hostBoards = new Set<string>([scoreboardOf(rig.host.players)]);
    for (let n = 0; n < SETTLE_FRAMES; n++) {
        rig.step(1);
        hostBoards.add(scoreboardOf(rig.host.players));
    }

    outcome = { rig, dealt, taken, droppedActions, hostBoards };
}, 180_000);

/** Every slot's `kills/deaths`, as one comparable string. */
function scoreboardOf(slots: readonly { info: { kills: number; deaths: number } }[]): string {
    return slots.map((s) => `${s.info.kills}/${s.info.deaths}`).join(' ');
}

describe('two clients and four bots, over a loopback', () => {
    it('has both clients deal damage and take it', () => {
        const { rig, dealt, taken } = outcome;

        // eslint-disable-next-line no-console
        console.log(
            `[net-match] ${SECONDS} s, 2 clients + 4 bots: ` +
                rig.clients
                    .map((c) => {
                        const i = c.net.slotIndex;
                        const info = rig.host.playerById(i)!.info;
                        return (
                            `client ${i} dealt ${dealt[i]} took ${taken[i]} ` +
                            `${info.kills}/${info.deaths}`
                        );
                    })
                    .join('; ')
        );

        for (const client of rig.clients) {
            const i = client.net.slotIndex;
            expect(dealt[i], `client ${i} never hit anything`).toBeGreaterThan(0);
            expect(taken[i], `client ${i} was never shot at`).toBeGreaterThan(0);
        }
    });

    it('shoots at every human, not just the first one', () => {
        /*
         The step-6 change in one assertion. `BotWorld.playerOrigin()` could
         only ever name one human, so a second client was furniture: visible,
         collidable, and never a target. `targets()` is what makes both of these
         numbers non-zero, and this is the test that fails if it regresses to a
         single origin.
        */
        const { rig, taken } = outcome;

        for (const client of rig.clients) {
            expect(
                taken[client.net.slotIndex],
                `slot ${client.net.slotIndex} took no damage; the bots ignored it`
            ).toBeGreaterThan(0);
        }
    });

    it('shows exactly the host scoreboard, which GAP-045 used to make impossible', () => {
        const { rig, hostBoards } = outcome;

        /*
         Over the host's population rather than over `0..MAX_CLIENTS`: there is
         an entry for a player who is here and none for anybody else (D-194), so
         a loop to sixteen would be dereferencing eleven absences. A client
         missing one of the host's players is itself a failure and is recorded
         as one rather than crashing the comparison.
        */
        const stale: string[] = [];
        for (const client of rig.clients) {
            for (const hostPlayer of rig.host.players) {
                const mine = client.net.playerById(hostPlayer.index);
                if (mine === undefined) {
                    stale.push(
                        `client ${client.net.slotIndex} never heard of player ${hostPlayer.index}`
                    );
                    continue;
                }

                const host = hostPlayer.info;
                if (mine.info.kills === host.kills && mine.info.deaths === host.deaths) continue;
                stale.push(
                    `client ${client.net.slotIndex} player ${hostPlayer.index}: ` +
                        `${mine.info.kills}/${mine.info.deaths} against the host's ` +
                        `${host.kills}/${host.deaths}`
                );
            }

            // And nobody the host does not have.
            for (const mine of client.net.players) {
                if (rig.host.playerById(mine.index) === undefined) {
                    stale.push(`client ${client.net.slotIndex} kept a ghost at ${mine.index}`);
                }
            }
        }

        // eslint-disable-next-line no-console
        console.log(
            `[net-match] host held ${hostBoards.size} scoreboard(s) in the last ` +
                `${SETTLE_FRAMES} frames; ${stale.length} slot(s) stale on the clients` +
                (stale.length > 0 ? ` -- ${stale.join('; ')} -- TARGET IS ZERO` : '')
        );

        /*
         **The target is zero and this is now it**, which it was not for three
         releases.

         `NetPlayerInfo` is published on change, and a change published once used
         to arrive, be applied by the client, and then be **rolled back** -- on a
         loopback with no loss. A reconciliation about the client's own slot
         rewinds the whole world past the frame the update landed in, and
         `ServerAuthoritativeClient` repaired only the entity the AUTH_STATE
         covered and replayed only that client's own input; the host, having
         published on change, never sent it again. That is GAP-045, and
         `Host.publishInfo`'s ten-frame republish raced the rewind and won most
         of the time, leaving one slot in thirty-two stale over 45 seconds.

         **meep 3.15.0 reapplies the records that arrived from a peer** as part of
         the replay, which is the other half of the rule `SimAction` always
         stated -- a record's `sender_id` says whether it arrived, was authored
         or was derived, and a replay reapplies the first two. The residual is
         zero, and the assertion is exact rather than a bound, because a bound is
         what let the last one sit at "nearly right" for three releases. D-193.

         The republish stays for now and is no longer load-bearing here: what it
         still covers is a different failure with its own new signal, measured in
         `net-delivery.test.ts` and recorded in D-193.
        */
        expect(
            stale.length,
            'the scoreboard went stale again; GAP-045 has regressed'
        ).toBe(0);

        expect(
            hostBoards.size,
            'the match was still scoring during the settling window, so this ' +
                'measurement is about lag rather than about loss -- lengthen it'
        ).toBe(1);
    });

    it('knows which slots are bots, on both clients', () => {
        /*
         `isBot` never changes after a slot is filled, so unlike the scores it
         can be compared at an instant -- and it is what a client needs before
         it can draw a scoreboard at all.
        */
        const { rig } = outcome;

        for (const client of rig.clients) {
            expect(
                client.net.players.length,
                `client ${client.net.slotIndex} has a different roster from the host`
            ).toBe(rig.host.players.length);

            for (const hostPlayer of rig.host.players) {
                const mine = client.net.playerById(hostPlayer.index);
                expect(mine, `client never heard of player ${hostPlayer.index}`).toBeDefined();
                expect(
                    mine!.info.isBot,
                    `player ${hostPlayer.index} isBot on client ${client.net.slotIndex}`
                ).toBe(hostPlayer.info.isBot);
            }
        }
    });

    it('scores a frag to whoever fired it, and a suicide against the shooter', () => {
        /*
         `player_die`: the attacker gains a point for somebody else, loses one
         for itself, and the *victim* loses one when there was no attacker at
         all. So the totals are not simply "kills equals deaths" -- what has to
         hold is that the frags handed out never exceed the deaths that happened,
         because every frag came from one.
        */
        const { rig } = outcome;

        let kills = 0;
        let deaths = 0;
        for (const slot of rig.host.players) {
            kills += slot.info.kills;
            deaths += slot.info.deaths;
        }

        expect(deaths, 'nobody died in 45 seconds of six-way combat').toBeGreaterThan(0);
        expect(kills, 'more frags were awarded than there were deaths').toBeLessThanOrEqual(
            deaths
        );
    });

    it('keeps every slot finite, on the host and on both clients', () => {
        const { rig } = outcome;

        for (const host of rig.host.players) {
            const i = host.index;

            for (const v of [...host.slot.ps.origin, ...host.slot.ps.velocity]) {
                expect(Number.isFinite(v), `host player ${i} has a non-finite ${v}`).toBe(true);
            }

            for (const client of rig.clients) {
                const mine = client.net.playerById(i);
                expect(mine, `client never heard of player ${i}`).toBeDefined();
                for (const v of [...mine!.state.origin, ...mine!.state.velocity]) {
                    expect(
                        Number.isFinite(v),
                        `player ${i} on client ${client.net.slotIndex} has a non-finite ${v}`
                    ).toBe(true);
                }
            }
        }
    });

    it('never has the host throw a client input away', () => {
        const { droppedActions } = outcome;

        // eslint-disable-next-line no-console
        if (droppedActions.length > 0) {
            // eslint-disable-next-line no-console
            console.log(
                `[net-match] dropped inputs: ` +
                    droppedActions
                        .slice(0, 5)
                        .map((d) => `peer ${d.peer} frame ${d.frame} (${d.why})`)
                        .join('; ')
            );
        }

        expect(
            droppedActions.length,
            'the host dropped client input; a shot a player took never happened'
        ).toBe(0);
    });

    it('delivers events to both clients', () => {
        const { rig } = outcome;

        for (const client of rig.clients) {
            expect(
                client.effects.length,
                `client ${client.net.slotIndex} saw no effects at all`
            ).toBeGreaterThan(0);
        }
    });
});
