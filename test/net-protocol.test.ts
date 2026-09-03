/*
 * net-protocol.test.ts -- the wire format, and nothing else.
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
 * No map, no physics, no transport. Every failure this file can catch is one
 * that would otherwise present as a desync in a running match, which is the
 * most expensive place in the project to debug something.
 *
 * Four properties, each of which has a specific way of going wrong:
 *
 *  - **Round trip.** A serialize followed by a deserialize gives the same
 *    component back. Floats are compared against `Math.fround` of the input,
 *    because Float32 is what the wire holds and the test would otherwise be
 *    asserting that 0.1 survives a 32-bit float.
 *  - **Size.** `NetworkSession`'s AUTH_STATE scratch is 1024 bytes and the
 *    session does not check before writing. A component that outgrows it fails
 *    at the send, mid-match, on whichever peer happened to have a long name.
 *  - **Blend.** The interpolation adapter and the serialization adapter are two
 *    hand-written descriptions of one layout, so `t = 0` and `t = 1` have to
 *    return the endpoints *exactly*: anything else means the two disagree about
 *    where a field starts, and a field read at the wrong offset still produces
 *    a number.
 *  - **Order.** Component and action type ids are assigned by registration
 *    order and never checked against the peer's. Two sessions built the same
 *    way have to agree, or every packet is decoded as the wrong class.
 */

import { describe, expect, it } from 'vitest';

import { BinaryBuffer } from '@woosh/meep-engine/src/core/binary/BinaryBuffer.js';
import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import type { NetworkSession } from '@woosh/meep-engine/src/engine/network/NetworkSession.js';

import { INERT_CONTEXT } from '../src/net/actions.ts';
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
    lerpAngle,
    truncateUtf8,
} from '../src/net/adapters.ts';
import {
    MAX_NAME_BYTES,
    NET_WEAPONS,
    NET_WEAPON_COUNT,
    NetInventory,
    NetItem,
    NetMatch,
    NetMissile,
    NetMover,
    NetPlayerInfo,
    NetPlayerState,
    REPLICATED,
    weaponAt,
    weaponIndex,
} from '../src/net/components.ts';
import { registerProtocol } from '../src/net/registerProtocol.ts';
import { createSession } from '../src/net/session.ts';
import { FRAME_CAPACITY, TICK_HZ } from '../src/net/protocol.ts';

/** The session's `SCRATCH_BUFFER_BYTES`. Not exported by the engine; asserted here. */
const SCRATCH_BUFFER_BYTES = 1024;

function buffer(): BinaryBuffer {
    const b = new BinaryBuffer();
    b.setCapacity(4096);
    return b;
}

/** Every float that goes through the wire comes back `fround`ed. */
function f32(v: number): number {
    return Math.fround(v);
}

function f32all(v: ArrayLike<number>): number[] {
    return Array.from(v, f32);
}

/* ------------------------------------------------------------------ *
 * Sample values. Deliberately awkward: negative, fractional, at the
 * edges of each field's range, and never zero -- a layout bug between
 * two zero fields is invisible.
 * ------------------------------------------------------------------ */

function samplePlayerState(): NetPlayerState {
    const v = new NetPlayerState();
    v.connected = 1;
    v.alive = 1;
    v.origin.set([1234.5, -678.25, 90.125]);
    v.velocity.set([-320.75, 0.5, 270.0625]);
    v.viewangles.set([-12.5, 179.75, 3.25]);
    v.deltaAngles.set([-32768, 16384, 32767]);
    v.pmFlags = 0xbeef;
    v.pmTime = -1234;
    v.groundEntityNum = 1022;
    v.viewheight = -12;
    v.bobCycle = 233;
    v.weapon = 7;
    v.weaponTime = -400;
    v.groundNormal.set([0.5, -0.25, 0.828125]);
    v.jumpHeld = 1;
    v.ducked = 1;
    return v;
}

function sampleInventory(): NetInventory {
    const v = new NetInventory();
    v.health = 125;
    v.armor = 200;
    v.maxHealth = 100;
    for (let i = 0; i < NET_WEAPON_COUNT; i++) v.ammo[i] = i === 0 ? -1 : i * 17 - 3;
    v.weapons = 0b101010101010;
    v.holdable = 3;
    return v;
}

function samplePlayerInfo(): NetPlayerInfo {
    const v = new NetPlayerInfo();
    v.name = 'Sarge';
    v.character = 9;
    v.isBot = 1;
    v.kills = -3;
    v.deaths = 512;
    v.pingMs = 65000;
    return v;
}

function sampleMissile(): NetMissile {
    const v = new NetMissile();
    v.active = 1;
    v.generation = 254;
    v.weapon = 4;
    v.owner = 15;
    v.origin.set([-1.5, 2048.25, 33.75]);
    v.velocity.set([900.5, -0.125, 12.0625]);
    return v;
}

function sampleItem(): NetItem {
    const v = new NetItem();
    v.index = 40000;
    v.present = 1;
    return v;
}

function sampleMover(): NetMover {
    const v = new NetMover();
    v.index = 61234;
    v.state = 3;
    v.origin.set([0.5, -1024.75, 64.125]);
    return v;
}

function sampleMatch(): NetMatch {
    const v = new NetMatch();
    v.simFrame = 4_000_000_000;
    v.timeMs = 3_600_000;
    v.fragLimit = 25;
    v.phase = 2;
    return v;
}

/* ------------------------------------------------------------------ *
 * Round trip and size
 * ------------------------------------------------------------------ */

describe('every adapter round-trips', () => {
    it('NetPlayerState', () => {
        const a = samplePlayerState();
        const adapter = new NetPlayerStateAdapter();
        const b = buffer();
        adapter.serialize(b, a);
        const size = b.position;
        b.position = 0;
        const out = new NetPlayerState();
        adapter.deserialize(b, out);

        expect(b.position).toBe(size);
        expect(out.connected).toBe(a.connected);
        expect(out.alive).toBe(a.alive);
        expect(f32all(out.origin)).toEqual(f32all(a.origin));
        expect(f32all(out.velocity)).toEqual(f32all(a.velocity));
        expect(f32all(out.viewangles)).toEqual(f32all(a.viewangles));
        expect([...out.deltaAngles]).toEqual([...a.deltaAngles]);
        expect(out.pmFlags).toBe(a.pmFlags);
        expect(out.pmTime).toBe(a.pmTime);
        expect(out.groundEntityNum).toBe(a.groundEntityNum);
        expect(out.viewheight).toBe(a.viewheight);
        expect(out.bobCycle).toBe(a.bobCycle);
        expect(out.weapon).toBe(a.weapon);
        expect(out.weaponTime).toBe(a.weaponTime);
        expect(f32all(out.groundNormal)).toEqual(f32all(a.groundNormal));
        expect(out.jumpHeld).toBe(a.jumpHeld);
        expect(out.ducked).toBe(a.ducked);
        expect(out.equals(a)).toBe(true);
    });

    it('NetInventory', () => {
        const a = sampleInventory();
        const adapter = new NetInventoryAdapter();
        const b = buffer();
        adapter.serialize(b, a);
        b.position = 0;
        const out = new NetInventory();
        adapter.deserialize(b, out);
        expect(out.equals(a)).toBe(true);
        expect([...out.ammo]).toEqual([...a.ammo]);
    });

    it('NetPlayerInfo', () => {
        const a = samplePlayerInfo();
        const adapter = new NetPlayerInfoAdapter();
        const b = buffer();
        adapter.serialize(b, a);
        b.position = 0;
        const out = new NetPlayerInfo();
        adapter.deserialize(b, out);
        expect(out.equals(a)).toBe(true);
    });

    it('NetMissile', () => {
        const a = sampleMissile();
        const adapter = new NetMissileAdapter();
        const b = buffer();
        adapter.serialize(b, a);
        b.position = 0;
        const out = new NetMissile();
        adapter.deserialize(b, out);
        expect(out.equals(a)).toBe(true);
    });

    it('NetItem', () => {
        const a = sampleItem();
        const adapter = new NetItemAdapter();
        const b = buffer();
        adapter.serialize(b, a);
        b.position = 0;
        const out = new NetItem();
        adapter.deserialize(b, out);
        expect(out.equals(a)).toBe(true);
    });

    it('NetMover', () => {
        const a = sampleMover();
        const adapter = new NetMoverAdapter();
        const b = buffer();
        adapter.serialize(b, a);
        b.position = 0;
        const out = new NetMover();
        adapter.deserialize(b, out);
        expect(out.equals(a)).toBe(true);
    });

    it('NetMatch', () => {
        const a = sampleMatch();
        const adapter = new NetMatchAdapter();
        const b = buffer();
        adapter.serialize(b, a);
        b.position = 0;
        const out = new NetMatch();
        adapter.deserialize(b, out);
        expect(out.equals(a)).toBe(true);
    });
});

describe('component sizes', () => {
    const sizes: Array<[string, number]> = [];

    it('every component fits the session scratch buffer', () => {
        const cases: Array<[string, { serialize(b: BinaryBuffer, v: never): void }, unknown]> = [
            ['NetPlayerState', new NetPlayerStateAdapter(), samplePlayerState()],
            ['NetInventory', new NetInventoryAdapter(), sampleInventory()],
            ['NetPlayerInfo', new NetPlayerInfoAdapter(), samplePlayerInfo()],
            ['NetMissile', new NetMissileAdapter(), sampleMissile()],
            ['NetItem', new NetItemAdapter(), sampleItem()],
            ['NetMover', new NetMoverAdapter(), sampleMover()],
            ['NetMatch', new NetMatchAdapter(), sampleMatch()],
        ];

        let total = 0;
        for (const [name, adapter, value] of cases) {
            const b = buffer();
            (adapter.serialize as (b: BinaryBuffer, v: unknown) => void)(b, value);
            sizes.push([name, b.position]);
            total += b.position;
            expect(b.position).toBeLessThan(SCRATCH_BUFFER_BYTES);
        }

        /*
         AUTH_STATE concatenates *every* replicated component for one entity
         into that one scratch buffer, so the sum is the number that matters
         and it is not the maximum. `NetworkIdentity`'s own four bytes ride
         along in front of it.
        */
        expect(total + 8).toBeLessThan(SCRATCH_BUFFER_BYTES);
    });

    it('a name at the wire limit does not push the payload over', () => {
        const v = samplePlayerInfo();
        v.name = 'x'.repeat(MAX_NAME_BYTES * 4);
        const b = buffer();
        new NetPlayerInfoAdapter().serialize(b, v);
        expect(b.position).toBeLessThan(SCRATCH_BUFFER_BYTES);

        b.position = 0;
        const out = new NetPlayerInfo();
        new NetPlayerInfoAdapter().deserialize(b, out);
        expect(out.name.length).toBe(MAX_NAME_BYTES);
    });

    it('truncates a multi-byte name at a code-point boundary', () => {
        /*
         Four bytes per rocket. Eight of them fits, the ninth does not, and a
         cut in the middle of one would come back as a different string on the
         far side -- so `NetPlayerInfo.equals` would never settle and the info
         component would republish for ever.
        */
        const cut = truncateUtf8('\u{1F680}'.repeat(20), MAX_NAME_BYTES);
        expect(new TextEncoder().encode(cut).length).toBe(32);
        expect([...cut].length).toBe(8);
        expect(cut).toBe('\u{1F680}'.repeat(8));
    });
});

/* ------------------------------------------------------------------ *
 * Blending
 * ------------------------------------------------------------------ */

/** Lay two snapshots into one buffer and blend them, as `InterpolationLog` does. */
function blend<T>(
    adapter: { serialize(b: BinaryBuffer, v: T): void; deserialize(b: BinaryBuffer, v: T): void },
    interp: { interpolate(o: BinaryBuffer, s: BinaryBuffer, a: number, b: number, t: number): void },
    a: T,
    b: T,
    t: number,
    out: T
): T {
    const source = buffer();
    const offsetA = source.position;
    adapter.serialize(source, a);
    const offsetB = source.position;
    adapter.serialize(source, b);

    const blended = buffer();
    interp.interpolate(blended, source, offsetA, offsetB, t);
    blended.position = 0;
    adapter.deserialize(blended, out);
    return out;
}

describe('the Linear adapters', () => {
    it('NetPlayerState returns each endpoint exactly at t = 0 and t = 1', () => {
        const a = samplePlayerState();
        const b = samplePlayerState();
        b.origin.set([-10, 20, 30]);
        b.velocity.set([1, 2, 3]);
        b.viewangles.set([10, -170, 0]);
        b.groundNormal.set([0, 0, 1]);
        b.weapon = 2;
        b.alive = 0;
        b.bobCycle = 12;

        const adapter = new NetPlayerStateAdapter();
        const interp = new NetPlayerStateInterpolation();

        const at0 = blend(adapter, interp, a, b, 0, new NetPlayerState());
        const at1 = blend(adapter, interp, a, b, 1, new NetPlayerState());

        /*
         t = 0 gives A's *continuous* fields and B's discrete ones, which is the
         design rather than a slip: a death or a weapon change is drawn on the
         frame it happened rather than a frame later.
        */
        expect(f32all(at0.origin)).toEqual(f32all(a.origin));
        expect(f32all(at0.velocity)).toEqual(f32all(a.velocity));
        expect(f32all(at0.groundNormal)).toEqual(f32all(a.groundNormal));
        expect(at0.weapon).toBe(b.weapon);
        expect(at0.alive).toBe(b.alive);
        expect(at0.bobCycle).toBe(b.bobCycle);

        expect(at1.equals(b)).toBe(true);
    });

    it('NetPlayerState lerps the middle', () => {
        const a = samplePlayerState();
        const b = samplePlayerState();
        a.origin.set([0, 0, 0]);
        b.origin.set([100, -40, 8]);
        a.velocity.set([0, 0, 0]);
        b.velocity.set([10, 10, 10]);

        const out = blend(
            new NetPlayerStateAdapter(),
            new NetPlayerStateInterpolation(),
            a,
            b,
            0.5,
            new NetPlayerState()
        );
        expect(f32all(out.origin)).toEqual([50, -20, 4]);
        expect(f32all(out.velocity)).toEqual([5, 5, 5]);
    });

    it('takes a yaw across +/-180 the short way round', () => {
        const a = samplePlayerState();
        const b = samplePlayerState();
        a.viewangles.set([0, 179, 0]);
        b.viewangles.set([0, -179, 0]);

        const out = blend(
            new NetPlayerStateAdapter(),
            new NetPlayerStateInterpolation(),
            a,
            b,
            0.5,
            new NetPlayerState()
        );

        /*
         Two degrees of turn, so the midpoint is 180 (or -180) and never 0 --
         which is what a plain lerp gives, and which draws every character that
         walks past south spinning a full circle.
        */
        expect(Math.abs(out.viewangles[1]!)).toBeCloseTo(180, 5);
    });

    it('lerpAngle is short-path in both directions and lands on the endpoints', () => {
        expect(lerpAngle(179, -179, 0)).toBe(179);
        expect(lerpAngle(179, -179, 1)).toBe(-179);
        expect(lerpAngle(-179, 179, 1)).toBe(179);
        expect(lerpAngle(-179, 179, 0.5)).toBeCloseTo(-180, 10);
        expect(lerpAngle(10, 20, 0.5)).toBeCloseTo(15, 10);

        /*
         Exactly 180 apart is a genuine tie -- both ways round are the same
         distance -- and the rule breaks it positively. Written down because
         "half way between -90 and 90 is 0" is the other reading, and it is
         the reading that puts a character facing the wrong way for one frame
         when it spins on the spot.
        */
        expect(lerpAngle(-90, 90, 0.5)).toBe(0);
        expect(lerpAngle(-90, 90, 1)).toBe(90);
    });

    it('NetMissile blends the flight and snaps the rest', () => {
        const a = sampleMissile();
        const b = sampleMissile();
        a.origin.set([0, 0, 0]);
        b.origin.set([90, 0, -30]);
        a.generation = 3;
        b.generation = 4;
        b.active = 0;

        const adapter = new NetMissileAdapter();
        const interp = new NetMissileInterpolation();

        expect(f32all(blend(adapter, interp, a, b, 0, new NetMissile()).origin)).toEqual([0, 0, 0]);
        expect(f32all(blend(adapter, interp, a, b, 0.5, new NetMissile()).origin)).toEqual([45, 0, -15]);
        expect(blend(adapter, interp, a, b, 1, new NetMissile()).equals(b)).toBe(true);

        // The generation and the active bit come from B at every t.
        for (const t of [0, 0.25, 0.5, 1]) {
            const out = blend(adapter, interp, a, b, t, new NetMissile());
            expect(out.generation).toBe(4);
            expect(out.active).toBe(0);
        }
    });

    it('NetMover blends the origin and snaps index and state', () => {
        const a = sampleMover();
        const b = sampleMover();
        a.origin.set([0, 0, 0]);
        b.origin.set([0, 0, 128]);
        a.state = 1;
        b.state = 2;

        const adapter = new NetMoverAdapter();
        const interp = new NetMoverInterpolation();

        expect(f32all(blend(adapter, interp, a, b, 0, new NetMover()).origin)).toEqual([0, 0, 0]);
        expect(f32all(blend(adapter, interp, a, b, 0.25, new NetMover()).origin)).toEqual([0, 0, 32]);
        expect(blend(adapter, interp, a, b, 1, new NetMover()).equals(b)).toBe(true);
        expect(blend(adapter, interp, a, b, 0, new NetMover()).state).toBe(2);
    });

    it('a degenerate blend of one snapshot against itself is that snapshot', () => {
        /*
         `NetworkSession.normalize_if_dirty` calls `interpolate` with
         `tick_a === tick_b` and `t = 0` to restore canonical form. If an
         adapter got that wrong, every remote component would drift a little
         every time the renderer ran.
        */
        const a = samplePlayerState();
        const out = blend(
            new NetPlayerStateAdapter(),
            new NetPlayerStateInterpolation(),
            a,
            a,
            0,
            new NetPlayerState()
        );
        expect(out.equals(a)).toBe(true);
    });
});

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function makeSession(): Promise<{
    em: EntityManager;
    session: NetworkSession;
    actions: ReturnType<typeof registerProtocol>;
}> {
    const em = new EntityManager();
    const ecd = new EntityComponentDataset();
    em.attachDataset(ecd);
    await new Promise<void>((resolve, reject) => {
        em.startup(resolve, reject);
    });

    const session = createSession({
        entity_manager: em,
        role: 'host',
        local_peer_id: 0,
        simulation_delay_ticks: 0,
        tick_rate_hz: TICK_HZ,
        frame_capacity: FRAME_CAPACITY,
    });
    const actions = registerProtocol(session, ecd, INERT_CONTEXT);
    await session.start();
    return { em, session, actions };
}

describe('UserCmdAction', () => {
    it('round-trips negative moves and wrapped angles', async () => {
        const { session, actions } = await makeSession();

        const a = new actions.UserCmdAction();
        a.networkId = 12;
        a.frame = 6000;
        a.cmd.angles.set([-16000, 32767, -32768]);
        a.cmd.moves.set([-128, 127, -1]);
        a.cmd.buttons = 0b10000001;
        a.cmd.weapon = 11;

        const b = buffer();
        a.serialize(b);
        b.position = 0;

        const out = new actions.UserCmdAction();
        out.deserialize(b);

        expect(out.networkId).toBe(12);
        expect(out.frame).toBe(6000);
        expect([...out.cmd.angles]).toEqual([-16000, 32767, -32768]);
        expect([...out.cmd.moves]).toEqual([-128, 127, -1]);
        expect(out.cmd.buttons).toBe(0b10000001);
        expect(out.cmd.weapon).toBe(11);

        session.stop();
    });

    it('reset clears every field, because the registry pools instances', async () => {
        const { session, actions } = await makeSession();
        const a = new actions.UserCmdAction();
        a.networkId = 5;
        a.frame = 9;
        a.cmd.angles.set([1, 2, 3]);
        a.cmd.moves.set([4, 5, 6]);
        a.cmd.buttons = 7;
        a.cmd.weapon = 8;
        a.reset();
        expect(a.networkId).toBe(0);
        expect(a.frame).toBe(0);
        expect([...a.cmd.angles]).toEqual([0, 0, 0]);
        expect([...a.cmd.moves]).toEqual([0, 0, 0]);
        expect(a.cmd.buttons).toBe(0);
        expect(a.cmd.weapon).toBe(0);
        session.stop();
    });

    it('the event actions round-trip and affect nothing', async () => {
        const { session, actions } = await makeSession();

        const effect = new actions.EffectEvent();
        effect.kind = 3;
        effect.weapon = 4;
        effect.owner = 255;
        effect.origin.set([-1.5, 2.25, 3.125]);
        effect.aux.set([0, 0, 1]);
        effect.radius = 120.5;

        const b = buffer();
        effect.serialize(b);
        b.position = 0;
        const effectOut = new actions.EffectEvent();
        effectOut.deserialize(b);
        expect(effectOut.kind).toBe(3);
        expect(effectOut.owner).toBe(255);
        expect(f32all(effectOut.origin)).toEqual(f32all(effect.origin));
        expect(f32all(effectOut.aux)).toEqual(f32all(effect.aux));
        expect(f32(effectOut.radius)).toBe(f32(120.5));

        const hit = new actions.HitEvent();
        hit.attacker = 3;
        hit.victim = 15;
        hit.damage = 100;
        const hb = buffer();
        hit.serialize(hb);
        hb.position = 0;
        const hitOut = new actions.HitEvent();
        hitOut.deserialize(hb);
        expect([hitOut.attacker, hitOut.victim, hitOut.damage]).toEqual([3, 15, 100]);

        const pickup = new actions.PickupEvent();
        pickup.slot = 7;
        pickup.item = 40000;
        const pb = buffer();
        pickup.serialize(pb);
        pb.position = 0;
        const pickupOut = new actions.PickupEvent();
        pickupOut.deserialize(pb);
        expect([pickupOut.slot, pickupOut.item]).toEqual([7, 40000]);

        /*
         No affected components: this is what makes the replicator always send
         them, the rewind never undo them, and the receiver apply each exactly
         once. Asserted rather than assumed, because the base class's default
         is the behaviour we want and a subclass could quietly acquire one.
        */
        let reported = 0;
        const executor = { slot_table: { entity_for: () => 1 } };
        effectOut.affected_components(() => reported++, executor);
        hitOut.affected_components(() => reported++, executor);
        pickupOut.affected_components(() => reported++, executor);
        expect(reported).toBe(0);

        session.stop();
    });

    it('declares the stepped slot\'s two components as affected', async () => {
        const { session, actions } = await makeSession();
        const a = new actions.UserCmdAction();
        a.networkId = 4;

        const seen: Array<[number, string]> = [];
        a.affected_components(
            (entity, component) =>
                seen.push([entity, (component as unknown as { typeName: string }).typeName]),
            { slot_table: { entity_for: (id: number) => id * 10 } }
        );
        expect(seen).toEqual([
            [40, 'NetPlayerState'],
            [40, 'NetInventory'],
        ]);

        // An id the slot table does not know reports nothing rather than -1.
        const none: unknown[] = [];
        a.affected_components(() => none.push(1), { slot_table: { entity_for: () => -1 } });
        expect(none).toHaveLength(0);

        session.stop();
    });
});

/* ------------------------------------------------------------------ *
 * Registration order
 * ------------------------------------------------------------------ */

describe('registerProtocol', () => {
    it('gives two independently built sessions identical type ids', async () => {
        const one = await makeSession();
        const two = await makeSession();

        const idsOf = (s: NetworkSession) => {
            const registry = (s.peer as unknown as {
                component_registry: { type_id_of(k: Function): number; type_count(): number };
            }).component_registry;
            return REPLICATED.map((k) => [k.typeName, registry.type_id_of(k)] as const);
        };

        expect(idsOf(one.session)).toEqual(idsOf(two.session));

        /*
         And they are the sequence `registerProtocol` writes, offset by one:
         `NetworkIdentity` is auto-replicated first and takes zero.
        */
        expect(idsOf(one.session)).toEqual([
            ['NetPlayerState', 1],
            ['NetInventory', 2],
            ['NetPlayerInfo', 3],
            ['NetMissile', 4],
            ['NetItem', 5],
            ['NetMover', 6],
            ['NetMatch', 7],
        ]);

        one.session.stop();
        two.session.stop();
    });

    it('gives two sessions identical action type ids', async () => {
        const one = await makeSession();
        const two = await makeSession();

        const idsOf = (a: ReturnType<typeof registerProtocol>) =>
            a.all.map((k) => (k as unknown as { type_id: number }).type_id);

        expect(idsOf(one.actions)).toEqual(idsOf(two.actions));
        /*
         Five, and the count is asserted rather than the shape, because the
         wire order is the registration order and a new action appended to the
         end leaves every existing id alone -- where one inserted in the middle
         renumbers everything after it and two peers built from different
         source would disagree about what a byte means. `PlayerLeft` was added
         at the end (D-194) and this is the assertion that says so.
        */
        expect(idsOf(one.actions)).toEqual([0, 1, 2, 3, 4]);
        expect(one.actions.all.map((k) => k.name)).toEqual([
            'UserCmdAction',
            'EffectEvent',
            'HitEvent',
            'PickupEvent',
            'PlayerLeft',
        ]);

        /*
         Which is why the classes are built per session rather than shared:
         `SimActionRegistry.register` writes `type_id` onto the class object,
         so one shared class in a two-session process would carry whichever id
         was assigned last. Two sessions holding the same numbers is only
         correct because they are holding *different classes*.
        */
        expect(one.actions.UserCmdAction).not.toBe(two.actions.UserCmdAction);

        one.session.stop();
        two.session.stop();
    });
});

/* ------------------------------------------------------------------ *
 * The weapon list
 * ------------------------------------------------------------------ */

describe('the wire weapon list', () => {
    it('is the weapons a slot can hold, in Q3 order', () => {
        expect(NET_WEAPONS[0]).toBe('WP_GAUNTLET');
        expect(NET_WEAPONS[1]).toBe('WP_MACHINEGUN');
        expect(NET_WEAPONS).not.toContain('WP_GRAPPLING_HOOK');
        expect(NET_WEAPON_COUNT).toBe(NET_WEAPONS.length);
        expect(NET_WEAPON_COUNT).toBeLessThanOrEqual(16); // NetInventory.weapons is a uint16
    });

    it('indexes round-trip, and an unknown tag lands on the gauntlet', () => {
        for (let i = 0; i < NET_WEAPON_COUNT; i++) {
            expect(weaponIndex(weaponAt(i))).toBe(i);
        }
        expect(weaponIndex('WP_GRAPPLING_HOOK')).toBe(0);
        expect(weaponAt(999)).toBe('WP_GAUNTLET');
    });
});
