/*
 * net-effects.test.ts -- what a joined client sees and hears happen.
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
 * `NETWORK_PLAN.md` step 6's last hole: **a joined client presented no
 * transients at all.** Every `EffectEvent` and `PickupEvent` the host dispatched
 * was counted by a hook in `main.ts` and thrown away, so a networked match had
 * no muzzle flash, no bullet impact, no hitscan trail, no explosion, no death
 * effect and no pickup feedback -- a correct simulation of a silent, invisible
 * fight. `NetTransients` is what replaces the counters, and this is the same
 * claim as a number.
 *
 * **Why it is a recorder rather than a screenshot.** The browser this port is
 * developed in cannot get a WebGPU adapter, so `EngineHarness` throws before
 * `main()` reaches the join at all (GAP-044's note), and a positional sound
 * needs a running `AudioContext` it has no more than it has a GPU. So
 * `NetTransients` is typed against `RemoteEffects` and `RemoteSounds` -- five
 * drawing calls and two sound calls -- for the reason `NetPresentationSystem` is
 * typed against three: against interfaces that narrow it can be driven by a test
 * with a real match, over a real replication path, behind it. What is recorded
 * here is what the browser would have drawn and played.
 *
 * **The client holds the trigger, and that is the load-bearing part of the
 * fixture.** Four networked tests in this suite have been caught measuring
 * nothing because their sample depended on whether the AI happened to meet
 * (D-187), and an effect fixture is the worst case of it: no fight, no events,
 * and every assertion below passes over an empty list. So the subject is
 * generated rather than waited for -- the client is given a rocket launcher and
 * a machinegun through the **replicated** inventory and fires them every frame,
 * which makes flashes, trails, impacts and explosions a property of the script
 * rather than of the pathfinding. The two that a trigger pull cannot produce are
 * produced directly: a death by writing the health the host reads, and a
 * teleport and a pad by standing the client in the volume (`net/triggers.ts`).
 *
 * **What this file does not re-measure** is delivery. Whether an event action
 * survives a lossy, reordering link is `net-delivery.test.ts`'s and
 * `net-latency.test.ts`'s question and they answer it at five links; this runs
 * on a loopback and asks the question after theirs: given that it arrived, is it
 * drawn, is it drawn as the right thing, and is it heard in the right place.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';

import { NetRig, IDLE } from './net/rig.ts';
import { holdAt, standIn, standingSpots } from './net/triggers.ts';
import {
    NetEffectSystem,
    NetTransients,
    type RemoteEffects,
    type RemoteSounds,
} from '../src/app/netSystems.ts';
import { Effects } from '../src/client/Effects.ts';
import { EffectKind, type EffectEventData } from '../src/net/actions.ts';
import { calcMuzzlePoint } from '../src/game/Weapons.ts';
import { vec3 } from '../src/q3/math.ts';
import { HostWeaponEvents } from '../src/server/Host.ts';
import { weaponIndex } from '../src/net/components.ts';
import { FORWARDMOVE, UPMOVE } from '../src/q3/pmove/types.ts';
import type { WeaponId } from '../src/game/Weapons.ts';
import * as C from '../src/q3/pmove/constants.ts';

/** Frames measured. Long enough for a fight, and for the ammunition to matter. */
const FRAMES = 1200;

/** How often the script swaps guns, so both barrels of the wire are exercised. */
const SWAP_EVERY = 60;

/** 16-bit view angles, as `usercmd_t.angles` carries them. */
function angleToShort(degrees: number): number {
    return Math.round((degrees * 65536) / 360) & 65535;
}

/** The circling walk the rest of the networked suite runs, and for its reasons. */
function circleWalk(
    cmd: { angles: Int16Array; moves: Int8Array; buttons: number; weapon: number },
    frame: number
): void {
    cmd.angles[1] = angleToShort(frame * 4);
    cmd.moves[FORWARDMOVE] = 127;
    cmd.moves[UPMOVE] = frame % 30 === 0 ? 127 : 0;
}

/** One recorded drawing call, whichever of the five it was. */
interface Drawn {
    what: 'muzzleFlash' | 'hitscanTrail' | 'bulletImpact' | 'explosion' | 'death';
    origin: number[];
    aux: number[] | null;
    weapon: WeaponId | null;
    mine: boolean;
    radius: number;
}

/** An effect layer that remembers what it was told, instead of drawing it. */
class EffectLog implements RemoteEffects {
    readonly drawn: Drawn[] = [];

    muzzleFlash(
        originQ3: ArrayLike<number>,
        directionQ3: ArrayLike<number>,
        weapon: WeaponId,
        mine: boolean
    ): void {
        this.push('muzzleFlash', originQ3, directionQ3, weapon, mine, 0);
    }

    hitscanTrail(
        startQ3: ArrayLike<number>,
        endQ3: ArrayLike<number>,
        weapon: WeaponId,
        mine: boolean
    ): void {
        this.push('hitscanTrail', startQ3, endQ3, weapon, mine, 0);
    }

    bulletImpact(
        originQ3: ArrayLike<number>,
        normalQ3: ArrayLike<number>,
        weapon: WeaponId
    ): void {
        this.push('bulletImpact', originQ3, normalQ3, weapon, false, 0);
    }

    explosion(
        originQ3: ArrayLike<number>,
        radiusQ3: number,
        weapon: WeaponId,
        normalQ3: ArrayLike<number> | null
    ): void {
        this.push('explosion', originQ3, normalQ3, weapon, false, radiusQ3);
    }

    death(originQ3: ArrayLike<number>): void {
        this.push('death', originQ3, null, null, false, 0);
    }

    of(what: Drawn['what']): Drawn[] {
        return this.drawn.filter((d) => d.what === what);
    }

    private push(
        what: Drawn['what'],
        origin: ArrayLike<number>,
        aux: ArrayLike<number> | null,
        weapon: WeaponId | null,
        mine: boolean,
        radius: number
    ): void {
        this.drawn.push({
            what,
            origin: [origin[0]!, origin[1]!, origin[2]!],
            aux: aux === null ? null : [aux[0]!, aux[1]!, aux[2]!],
            weapon,
            mine,
            radius,
        });
    }
}

/** Every sound asked for, with where it was placed and whether it was dry. */
class SoundLog implements RemoteSounds {
    readonly played: { name: string; originQ3: number[] | null }[] = [];

    play(name: string, originQ3: ArrayLike<number>): void {
        this.played.push({ name, originQ3: [originQ3[0]!, originQ3[1]!, originQ3[2]!] });
    }

    playLocal(name: string): void {
        this.played.push({ name, originQ3: null });
    }

    named(name: string): { name: string; originQ3: number[] | null }[] {
        return this.played.filter((p) => p.name === name);
    }
}

/**
 * The client's own gun, refilled through the component the host reads.
 *
 * **The replicated component rather than `record.slot.inventory`**, which is
 * the same choice `net/triggers.ts` makes for origins and for the same reason:
 * `stepSlot` is `load` from the components, then step, then `store`, so the
 * component is the authority between frames and the `PlayerSlot`'s own
 * inventory is scratch inside one. Writing the scratch happens to survive --
 * measured -- because the `store` at the end of the frame puts it back; writing
 * the component is the version that does not depend on that.
 *
 * **Every frame rather than once**, which is the part that matters here: a
 * client holding the trigger for twenty seconds empties a magazine, and a
 * fixture whose subject stops appearing halfway through is the failure this
 * file's header is about.
 */
function arm(rig: NetRig, slotIndex: number, weapons: readonly WeaponId[]): void {
    const inventory = rig.host.playerById(slotIndex)!.inventory;
    for (const weapon of weapons) {
        const at = weaponIndex(weapon);
        inventory.weapons |= 1 << at;
        inventory.ammo[at] = 200;
    }
}

interface Seen {
    rig: NetRig;
    transients: NetTransients;
    effects: EffectLog;
    sounds: SoundLog;
    /** The arrived stream over the measured window, which is what was fed in. */
    arrived: EffectEventData[];
    /**
     * The live array the rig keeps appending to.
     *
     * Kept beside the slice above rather than instead of it: the counting
     * assertions want a window that does not move under them, and the death
     * below wants the array that grows when the rig is stepped again.
     */
    live: EffectEventData[];
    /** What the host raised after the client had joined and settled. */
    hostRaised: number;
    slotIndex: number;
}

let seen: Seen;

/** Drain everything that has arrived since `from`, and present it. */
function present(
    transients: NetTransients,
    arrived: readonly EffectEventData[],
    from: number
): number {
    for (let i = from; i < arrived.length; i++) transients.effect(arrived[i]!);
    return arrived.length;
}

beforeAll(async () => {
    /*
     Three bots, for a populated world to replicate rather than for their
     trigger fingers: over the 1,200 measured frames on this seed they fire
     **nothing**, which is the fourth time this suite has found that a fixture
     waiting on the AI to produce its own subject is a fixture that does not.
     Everything asserted below is produced by the client's own script or written
     directly, and the bots are here so that the effects are drawn against a
     match with sixteen entities in it rather than two.
    */
    const rig = await NetRig.create({
        map: 'oa_dm1',
        bots: 3,
        clients: 1,
        seed: 23,
        warmup: 40,
    });

    const client = rig.clients[0]!;
    const slotIndex = client.net.slotIndex;

    /*
     Both barrels: the machinegun is the hitscan half (`HitscanTrail` and
     `BulletImpact`) and the rocket launcher the projectile half (`Explosion`),
     and a client holding one of them would leave the other kind untested. The
     swap rides `usercmd_t.weapon`, which is how a networked client changes
     weapon at all (D-182).
    */
    const guns: WeaponId[] = ['WP_MACHINEGUN', 'WP_ROCKET_LAUNCHER'];

    client.script = (cmd, frame) => {
        circleWalk(cmd, frame);
        cmd.weapon = weaponIndex(guns[Math.floor(frame / SWAP_EVERY) % guns.length]!) + 1;
        cmd.buttons |= C.BUTTON_ATTACK;
    };

    const effects = new EffectLog();
    const sounds = new SoundLog();
    const transients = new NetTransients({
        slotIndex,
        effects,
        audio: sounds,
        /*
         The host's item table, because in this harness there is no second one:
         a browser client builds its own `ItemSystem` from the same map and the
         join refuses a host whose item count differs, which is precisely what
         makes a wire index name the same shard on both sides. What is under
         test is the index -> def -> sound-and-label step, and that table is the
         same object either way.
        */
        items: rig.host.items.items,
    });

    /*
     Warm the link, then measure a steady stretch.

     **Both ends of the window are taken at the same instant**, which is the
     whole of why this is two lines rather than one. The client is already
     firing during the warm-up, so its own events are already arriving; a
     measured window that started the *presenter* at zero and the *host* count
     at now would present the warm-up backlog and then compare it against a
     host that had forgotten it -- 660 presented against 543 raised, which reads
     exactly like the duplication this file is here to rule out.
    */
    rig.step(120);
    const hostBase = rig.hostEffects.length;
    const arrivedBase = client.effects.length;

    let drained = arrivedBase;
    for (let n = 0; n < FRAMES; n++) {
        arm(rig, slotIndex, guns);
        rig.step(1);
        drained = present(transients, client.effects, drained);
    }

    /*
     Stop firing and let the tail land, so the arrived stream is not cut off
     mid-flight by the loop simply ending.
    */
    client.script = IDLE;
    for (let n = 0; n < 60; n++) {
        rig.step(1);
        drained = present(transients, client.effects, drained);
    }

    seen = {
        rig,
        transients,
        effects,
        sounds,
        // The slice the presenter was actually fed, so every filter below is
        // over the same window the counts are.
        arrived: client.effects.slice(arrivedBase),
        live: client.effects,
        hostRaised: rig.hostEffects.length - hostBase,
        slotIndex,
    };
}, 180_000);

describe('the transients a joined client presents', () => {
    it('presents every event that arrives, and drops none of them', () => {
        const { rig, transients, arrived, effects, hostRaised } = seen;
        const counts = transients.counts;

        const presented =
            counts.muzzleFlashes +
            counts.trails +
            counts.impacts +
            counts.explosions +
            counts.deaths +
            counts.teleports +
            counts.jumpPads;

        // eslint-disable-next-line no-console
        console.log(
            `[net-effects] ${arrived.length} effect actions arrived and ${presented} were ` +
                `presented: ${counts.muzzleFlashes} flashes, ${counts.trails} trails, ` +
                `${counts.impacts} impacts, ${counts.explosions} explosions, ` +
                `${counts.deaths} deaths; ${effects.drawn.length} drawing calls. ` +
                `Host raised ${hostRaised}; ` +
                `${rig.clients[0]!.net.replayedTransients} re-applications were suppressed ` +
                `over ${rig.clients[0]!.net.reconcileCount} reconciliations`
        );

        /*
         The whole of what was broken, as one equality. The hook this replaces
         incremented a counter and returned, so `presented` was zero however
         many arrived.
        */
        expect(presented, 'an event arrived and was not presented').toBe(arrived.length);
        expect(counts.unknown, 'an arrived event had no presentation at all').toBe(0);

        /*
         **And exactly once each**, which is the number the `replaying` gate in
         `NetClient` exists for and is not free since meep 3.15.0: a rewind
         re-executes the records in its window that arrived from a peer, and an
         event action's whole effect is a side effect outside the replicated
         world. Without the gate this reads higher than what the host raised.
         See GAP-048.
        */
        expect(
            arrived.length,
            'more transients were presented than the host ever raised'
        ).toBeLessThanOrEqual(hostRaised);
    });

    it('draws all four of the kinds a trigger pull makes', () => {
        const { effects } = seen;

        /*
         Each of these is a separate `case` in `NetTransients.effect` and a
         separate method on `RemoteEffects`, so a routing mistake shows up as
         one of them being zero rather than as a wrong total. They are asserted
         individually for the reason the fixture arms the client: a suite whose
         effect coverage depends on which gun the AI happened to hold is a suite
         that stops testing three of these without saying so.
        */
        expect(effects.of('muzzleFlash').length, 'no muzzle flash was drawn').toBeGreaterThan(0);
        expect(effects.of('hitscanTrail').length, 'no hitscan trail was drawn').toBeGreaterThan(0);
        expect(effects.of('bulletImpact').length, 'no bullet impact was drawn').toBeGreaterThan(0);
        expect(effects.of('explosion').length, 'no explosion was drawn').toBeGreaterThan(0);
    });

    it('names a real weapon on every effect that has one', () => {
        const { effects } = seen;

        /*
         `weaponAt` is the one crossing an outside byte makes into a `WeaponId`
         (D-114), and everything downstream reads a per-weapon table with it:
         the flash colour, the impact sound, the mark texture, the trail. A tag
         that fell off the end of `NET_WEAPONS` would silently take every one of
         those defaults.
        */
        const tags = new Set<string>();
        for (const drawn of effects.drawn) {
            if (drawn.weapon === null) continue;
            tags.add(drawn.weapon);
        }

        // eslint-disable-next-line no-console
        console.log(`[net-effects] weapons drawn: ${[...tags].sort().join(', ')}`);

        expect(tags.has('WP_MACHINEGUN'), 'the machinegun never reached the effects').toBe(true);
        expect(
            tags.has('WP_ROCKET_LAUNCHER'),
            'the rocket launcher never reached the effects'
        ).toBe(true);
    });

    it('offers the local player its own flash and nobody else theirs', () => {
        const { effects, arrived, slotIndex } = seen;

        const flashes = effects.of('muzzleFlash');
        const mine = flashes.filter((f) => f.mine).length;

        /*
         `mine` is what `Arena` turns into "offer this to the gun on screen",
         and the two number spaces it sits between are the reason
         `RemoteEffects` carries a boolean rather than an owner id: the wire
         names a shooter by slot index and `Arena` asks about Q3 client 0.
         Checked against the *stream's* own owner field rather than against a
         count, so it cannot pass by everything being marked the same way.
        */
        const fromMe = arrived.filter(
            (e) => e.kind === EffectKind.MuzzleFlash && e.owner === slotIndex
        ).length;

        // eslint-disable-next-line no-console
        console.log(
            `[net-effects] slot ${slotIndex}: ${mine} of ${flashes.length} muzzle flashes are ` +
                `this client's own`
        );

        expect(mine, 'the local player never got its own muzzle flash').toBeGreaterThan(0);
        expect(mine, "`mine` does not match the stream's own owner field").toBe(fromMe);

        /*
         And somebody else's, which the match cannot be asked for: the bots on
         this seed never fire (see the fixture), and waiting for one that does
         is how a suite ends up asserting over an empty list. Two events with
         two owners is the same claim without the dependency, and it is the
         claim that matters -- a host that put this client in slot 0 would make
         the two number spaces agree by accident and hide a mapping bug
         completely.
        */
        const log = new EffectLog();
        const transients = new NetTransients({ slotIndex: 3, effects: log });

        for (const owner of [3, 4]) {
            transients.effect({
                kind: EffectKind.MuzzleFlash,
                weapon: weaponIndex('WP_RAILGUN'),
                owner,
                origin: Float32Array.from([1, 2, 3]),
                aux: Float32Array.from([1, 0, 0]),
                radius: 0,
            });
        }

        expect(log.of('muzzleFlash').map((f) => f.mine)).toEqual([true, false]);
    });

    it('draws a trail between two different points, with a blast that has a radius', () => {
        const { effects } = seen;

        /*
         A trail is a *line*, and `origin`/`aux` are its two ends -- the one
         field on `EffectEventData` whose meaning changes per kind. Read as
         anything else it draws a beam of zero length, which is invisible and
         therefore exactly the kind of mistake a count cannot catch.

         **The longest one rather than every one**, because a short trail is a
         real thing: a shot taken with the muzzle against a wall stops where it
         started, and this fixture circles a room firing continuously, so it
         takes plenty of them -- the shortest measured is under a unit. What
         cannot be true if the two ends are being read as one field is that any
         of them crosses a room.
        */
        const lengths = effects
            .of('hitscanTrail')
            .map((t) =>
                Math.hypot(
                    t.aux![0]! - t.origin[0]!,
                    t.aux![1]! - t.origin[1]!,
                    t.aux![2]! - t.origin[2]!
                )
            );

        // eslint-disable-next-line no-console
        console.log(
            `[net-effects] ${lengths.length} trails: shortest ` +
                `${Math.min(...lengths).toFixed(1)}, longest ${Math.max(...lengths).toFixed(1)} ` +
                `units`
        );

        expect(
            Math.max(...lengths),
            'every hitscan trail has both ends in the same place'
        ).toBeGreaterThan(100);

        // And `radius`, which is the field only an explosion uses.
        for (const blast of effects.of('explosion')) {
            expect(blast.radius, 'an explosion arrived with no blast radius').toBeGreaterThan(0);
        }
    });

    it('plays the death of whoever the host says died, where they died', () => {
        const { rig, transients, effects, sounds, live, slotIndex } = seen;

        const before = {
            deaths: transients.counts.deaths,
            flesh: sounds.named('impact/flesh').length,
            drawn: effects.of('death').length,
        };

        /*
         A death, forced rather than waited for. `mortality` reads a human's
         health out of the replicated inventory -- `record.slot.inventory` is
         scratch that `load` overwrites -- so writing a zero there is the
         smallest honest way to make the host raise `EffectKind.Death` on a
         named frame. It is also the case that matters most: this is the
         client's *own* death, and the origin has to be where the host had it
         rather than where this client predicted it.
        */
        const record = rig.host.playerById(slotIndex)!;
        record.inventory.health = 0;

        let drained = live.length;
        for (let n = 0; n < 30; n++) {
            rig.step(1);
            drained = present(transients, live, drained);
        }

        const deaths = effects.of('death').slice(before.drawn);
        const flesh = sounds.named('impact/flesh').length - before.flesh;

        // eslint-disable-next-line no-console
        console.log(
            `[net-effects] forced death: ${deaths.length} death effects drawn, ` +
                `${flesh} flesh impacts played, at ` +
                `[${(deaths[0]?.origin ?? []).map((v) => v.toFixed(0)).join(', ')}]`
        );

        /*
         One death, not two. The client cannot predict its own -- the health
         reaches zero on the host -- so the AUTH_STATE that carries it is also
         the one that forces a reconciliation, and a reconciliation re-executes
         the arrived records in its window. `NetClient`'s `replaying` gate is
         what keeps that from being a second explosion and a second wet noise on
         the same corpse. See GAP-048.
        */
        expect(deaths.length, 'the client was killed and drew nothing').toBe(1);
        /*
         Both halves. `Arena.hit` plays the wet noise beside the death explosion
         in single-player and it is not inside `deathExplosion` there either, so
         a port that called only the drawing half would lose one of the two
         signals that says somebody died.
        */
        expect(flesh, 'a death made no sound').toBe(deaths.length);

        // At a real place, rather than at the origin a reset action would carry.
        const at = deaths[0]!.origin;
        expect(Math.abs(at[0]!) + Math.abs(at[1]!) + Math.abs(at[2]!)).toBeGreaterThan(0);
    });
});

describe("the muzzle flash of this client's own shot", () => {
    /*
     `EV_FIRE_WEAPON` is a predictable event in Q3 and it is the one transient
     on this branch that must **not** wait for the host: the flash, the fire
     sound and the gun's animation belong on the frame the trigger was pulled.
     Waiting made it a round trip late, which is what the hitscan trail's
     bending was about from the other end (D-200) -- and unlike the trail, the
     flash needs nothing the client does not already have.
    */
    it('is drawn where the host says the same shot was, from one shared rule', () => {
        const { rig, live, slotIndex } = seen;
        const client = rig.clients[0]!;

        /*
         The **whole** arrived stream rather than the measured window: these are
         paired against `predictedFires`, which starts at the client's first
         trigger pull, and a window on one side only would pair shot 1 with shot
         20 and report the distance between two unrelated corners of the map.
        */
        const arrivedMine = live.filter(
            (e) => e.kind === EffectKind.MuzzleFlash && e.owner === slotIndex
        );

        const muzzle = vec3();
        const forward = vec3();

        const predicted = client.predictedFires.map((fired) => {
            calcMuzzlePoint(fired.eye, fired.angles, muzzle, forward);
            return [muzzle[0]!, muzzle[1]!, muzzle[2]!];
        });

        expect(predicted.length, 'the client predicted no shots at all').toBeGreaterThan(20);
        expect(arrivedMine.length, 'the host raised no shots for this client').toBeGreaterThan(
            20
        );

        /*
         **Matched by position rather than by index**, which is not fussiness:
         paired by index the median gap is 32 units and *one* pair in 230 is
         exact, and paired at an offset of one it is 229 in 230 exact with a
         median of zero. The lists really are the same shots and really are
         off by one -- the client predicts a shot at the join that the host never
         raises, which is an ordinary mis-prediction and is counted below rather
         than hidden. Asserting on an index would have been asserting on that
         offset staying exactly one for ever.
        */
        const nearest = (host: ArrayLike<number>): number => {
            let best = Infinity;
            for (const p of predicted) {
                const d = Math.hypot(
                    p[0]! - host[0]!,
                    p[1]! - host[1]!,
                    p[2]! - host[2]!
                );
                if (d < best) best = d;
            }
            return best;
        };

        const gaps = arrivedMine.map((e) => nearest(e.origin));
        const exact = gaps.filter((g) => g < 0.01).length;
        const worst = Math.max(...gaps);

        // eslint-disable-next-line no-console
        console.log(
            `[net-effects] own shots: ${client.predictedFires.length} predicted, ` +
                `${arrivedMine.length} raised by the host, ${exact} of them at a muzzle ` +
                `this client had already computed; worst gap ${worst.toFixed(3)} units`
        );

        /*
         **Every one of the host's flashes is at a muzzle this client had already
         drawn one at**, and the reason it can be exact rather than close is that
         there is one copy of the rule: `calcMuzzlePoint` is `CalcMuzzlePoint` --
         fourteen units forward of the eye along the shooter's forward -- and
         both peers call the same function. Two copies of that sentence would be
         two chances to disagree, and disagreeing looks like a flash that jumps
         at the moment the authoritative one lands.
        */
        expect(
            exact,
            'the host put a shot somewhere this client never predicted one'
        ).toBe(arrivedMine.length);

        /*
         And the client predicts at most a shot or two the host never confirms.
         Q3 has the same property -- a predicted event can turn out not to have
         happened -- and the cost is a flash with no bullet behind it, which is
         what every predicting shooter pays. Bounded rather than asserted to
         zero, because zero is not what a prediction promises.
        */
        expect(
            client.predictedFires.length - arrivedMine.length,
            'the client is predicting shots the host is not taking'
        ).toBeLessThanOrEqual(2);
    });

    it('is dropped when it arrives, because it has already been drawn', () => {
        const log = new EffectLog();
        const transients = new NetTransients({
            slotIndex: 3,
            effects: log,
            predictsOwnFlash: true,
        });

        const flash = (owner: number): void => {
            transients.effect({
                kind: EffectKind.MuzzleFlash,
                weapon: weaponIndex('WP_RAILGUN'),
                owner,
                origin: Float32Array.from([1, 2, 3]),
                aux: Float32Array.from([1, 0, 0]),
                radius: 0,
            });
        };

        flash(3);
        flash(4);

        // And the tracer, which travels the same road for a sharper reason: a
        // beam has two visible ends and a stale one hinges or floats.
        for (const owner of [3, 4]) {
            transients.effect({
                kind: EffectKind.HitscanTrail,
                weapon: weaponIndex('WP_RAILGUN'),
                owner,
                origin: Float32Array.from([1, 2, 3]),
                aux: Float32Array.from([100, 2, 3]),
                radius: 0,
            });
        }

        /*
         Mine drawn once, by the prediction, and not again here; somebody else's
         drawn here, because there is nothing else to draw it. The suppressed one
         is still *counted* -- the arrival ledger in the file's first test is an
         equality and a silently dropped event would break it -- so what the
         count says is "arrived, and was already on screen".
        */
        expect(log.of('muzzleFlash').length, "somebody else's flash was dropped too").toBe(1);
        expect(log.of('muzzleFlash')[0]!.mine).toBe(false);
        expect(log.of('hitscanTrail').length, "somebody else's tracer was dropped too").toBe(1);
        expect(log.of('hitscanTrail')[0]!.mine).toBe(false);
        expect(transients.counts.muzzleFlashes, 'both arrivals are counted').toBe(2);
        expect(transients.counts.trails, 'both arrivals are counted').toBe(2);
        expect(transients.counts.ownFlashesPredicted).toBe(2);
    });

    it('is presented from the wire when nobody is predicting it', () => {
        /*
         The default, and what every headless driver wants: a client that has not
         subscribed to `predictedFire` has drawn nothing, so dropping the host's
         copy would lose the flash entirely rather than de-duplicate it.
        */
        const log = new EffectLog();
        const transients = new NetTransients({ slotIndex: 3, effects: log });

        transients.effect({
            kind: EffectKind.MuzzleFlash,
            weapon: weaponIndex('WP_RAILGUN'),
            owner: 3,
            origin: Float32Array.from([1, 2, 3]),
            aux: Float32Array.from([1, 0, 0]),
            radius: 0,
        });

        expect(log.of('muzzleFlash').length).toBe(1);
        expect(log.of('muzzleFlash')[0]!.mine, 'the gun was not offered its own shot').toBe(true);
        expect(transients.counts.ownFlashesPredicted).toBe(0);
    });
});

describe('an explosion with no surface under it', () => {
    it('is drawn without a mark, because Q3 marks walls and never marks people', () => {
        /*
         The one rule in this file that a match cannot be relied on to produce:
         it needs a rocket to stop on a *body*, which happens when it happens.
         So it is pinned at the seam instead, on both sides of the wire in one
         test -- the host's queue entry and the presenter's call -- because the
         two halves are a single convention and a change to either alone breaks
         it silently.

         What it guards: `HostWeaponEvents.explosion` used to substitute
         straight up for a missing normal, so a direct hit told every client to
         stamp a scorch mark on the floor under the body. `Arena.explosion`
         has always tested whether it was given a normal at all; the wire
         defeated that test by always having one.
        */
        const events = new HostWeaponEvents();
        events.explosion([64, 32, 16], 90, 'WP_ROCKET_LAUNCHER');
        events.explosion([10, 20, 30], 120, 'WP_ROCKET_LAUNCHER', [0, 0, 1]);

        expect(events.pending.length).toBe(2);
        expect([...events.pending[0]!.aux], 'a body hit still carries a normal').toEqual([0, 0, 0]);
        expect([...events.pending[1]!.aux], 'a wall hit lost its normal').toEqual([0, 0, 1]);

        const effects = new EffectLog();
        const transients = new NetTransients({ slotIndex: 0, effects });

        for (const pending of events.pending) {
            transients.effect({
                kind: pending.kind,
                weapon: pending.weapon,
                owner: pending.owner,
                origin: Float32Array.from(pending.origin),
                aux: Float32Array.from(pending.aux),
                radius: pending.radius,
            });
        }

        const blasts = effects.of('explosion');
        expect(blasts.length).toBe(2);
        expect(blasts[0]!.aux, 'a body hit was given a surface to mark').toBeNull();
        expect(blasts[1]!.aux, 'a wall hit lost the surface it landed on').toEqual([0, 0, 1]);
        expect(blasts[0]!.radius).toBe(90);
        expect(blasts[1]!.radius).toBe(120);
    });
});

describe('the effects a joined client has drawn', () => {
    it('are retired on a clock nothing else on that branch runs', () => {
        /*
         **`Arena.update` cannot be called on the networked branch**, because the
         first thing it does is step the weapons and the weapons are the host's,
         so `CombatSystem` is not registered there. Three of the four things
         inside that call are already accounted for elsewhere; the fourth is
         `Effects.update`, and it is the one that cannot be skipped -- it retires
         a finished emitter, expires a muzzle flash's light, and fades an impact
         mark out over `CG_AddMarks`' ten seconds.

         Nothing ran it. That was invisible while a joined client drew nothing at
         all, and became a few hundred entities a minute the moment it did: a
         match's worth of flashes and scorch marks accumulating in the dataset
         with no path out. `NetEffectSystem` is the one line, and this is the
         leak it closes -- measured as an entity count returning to where it
         started rather than as the registration being present, because a test of
         a registration is a test of a copy of it.
        */
        const ecd = new EntityComponentDataset();
        ecd.setComponentTypeMap([]);

        const effects = new Effects(ecd);
        const system = new NetEffectSystem({ effects });

        const transients = new NetTransients({
            slotIndex: 0,
            effects: {
                muzzleFlash: (o, d, w) => effects.muzzleFlash(o, d, w),
                hitscanTrail: (a, b, w) => effects.hitscanTrail(w, a, b),
                bulletImpact: (o, n, w) => {
                    effects.bulletImpact(o, n);
                    effects.impactMark(w, o, n);
                },
                explosion: (o, r, w, n) => {
                    effects.explosion(o, r, w);
                    if (n !== null) effects.impactMark(w, o, n);
                },
                death: (o) => effects.explosion(o, 90),
            },
        });

        const count = (): number => {
            let n = 0;
            (
                ecd.traverseEntities.bind(ecd) as unknown as (
                    classes: unknown[],
                    visitor: (component: never) => void
                ) => void
            )([Transform], () => {
                n += 1;
            });
            return n;
        };

        const before = count();

        for (let i = 0; i < 20; i++) {
            for (const kind of [
                EffectKind.MuzzleFlash,
                EffectKind.HitscanTrail,
                EffectKind.BulletImpact,
                EffectKind.Explosion,
                EffectKind.Death,
            ]) {
                transients.effect({
                    kind,
                    weapon: weaponIndex('WP_ROCKET_LAUNCHER'),
                    owner: 0,
                    origin: Float32Array.from([i * 10, 0, 0]),
                    aux: Float32Array.from([0, 0, 1]),
                    radius: 120,
                });
            }
        }

        const drawn = count();

        /*
         Past `CG_AddMarks`' ten seconds, which is the longest life anything here
         has -- the lights and emitters are gone within a second, and the marks
         are what would otherwise sit in the dataset for the rest of the match.
        */
        for (let n = 0; n < 12 * 60; n++) system.update(1 / 60);

        const after = count();

        // eslint-disable-next-line no-console
        console.log(
            `[net-effects] entities: ${before} before, ${drawn} after 100 transients, ` +
                `${after} once the clock has run`
        );

        expect(drawn, 'a hundred transients drew nothing at all').toBeGreaterThan(before + 100);
        expect(after, 'the effects a joined client draws are never retired').toBe(before);
    });
});

describe('a pickup a joined client hears', () => {
    it('names it and plays it dry for the picker, and places it for everyone else', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 0,
            clients: 1,
            seed: 42,
            warmup: 40,
        });

        rig.step(30);

        const client = rig.clients[0]!;
        const slotIndex = client.net.slotIndex;
        const sounds = new SoundLog();
        const transients = new NetTransients({
            slotIndex,
            audio: sounds,
            items: rig.host.items.items,
        });

        expect(transients.pickupLabel, 'a fresh client already names a pickup').toBe('');

        /*
         **The item is chosen by trying, not by naming one.** Which shards a map
         has and which of them a spawning player can take are two different
         questions -- `BG_CanItemBeGrabbed` refuses a health pack to a player at
         full health and armour to one already carrying twice their maximum --
         so a fixture that named `item_armor_shard` would be one map edit away
         from measuring nothing. Standing on each in turn until one is taken is
         the same discipline the trigger fixtures use for standing spots.
        */
        let taken: { index: number; classname: string; pickupName: string } | null = null;

        for (const item of rig.host.items.items) {
            item.present = true;

            const before = client.pickups.length;
            for (let n = 0; n < 3 && client.pickups.length === before; n++) {
                holdAt(rig, slotIndex, item.origin);
            }

            if (client.pickups.length > before) {
                taken = {
                    index: item.index,
                    classname: item.def.classname,
                    pickupName: item.def.pickupName,
                };
                break;
            }
        }

        expect(taken, 'no item on oa_dm1 could be picked up at all').not.toBeNull();

        for (const event of client.pickups) transients.pickup(event);

        // eslint-disable-next-line no-console
        console.log(
            `[net-effects] pickup: ${client.pickups.length} events, ` +
                `"${transients.pickupLabel}" (${taken!.classname}), ` +
                `${sounds.played.length} sounds`
        );

        expect(transients.counts.pickups, 'the pickup was never presented').toBeGreaterThan(0);

        /*
         `Touch_Item` plays the pickup sound and `CG_ItemPickup` writes the name
         across the bottom of the screen. Both are the picker's: this client's
         own pickup is dry, which is what `S_StartLocalSound` means, and the
         status bar names it. Neither happened on this branch before, because
         the `PickupSystem` that does both in single-player is not registered
         when the items are the host's.
        */
        const dry = sounds.named(`item/${taken!.classname}`);
        expect(dry.length, 'the pickup made no sound').toBeGreaterThan(0);
        expect(dry[0]!.originQ3, "the picker's own pickup was placed in the world").toBeNull();
        expect(transients.pickupLabel, 'the status bar was never told').toBe(taken!.pickupName);
        expect(transients.pickupAgeSeconds).toBeLessThan(5);

        /*
         And somebody else taking the same shard, which is the half single-player
         has never had: there was nobody else, so `PickupSystem` plays every
         pickup dry. Over a wire a dry sound is one in the listener's own head,
         and a shard taken across the map would be indistinguishable from one
         taken at their feet.
        */
        const before = sounds.played.length;
        transients.pickup({ slot: slotIndex === 0 ? 1 : 0, item: taken!.index });

        const heard = sounds.played[before]!;
        expect(heard.name).toBe(`item/${taken!.classname}`);
        expect(heard.originQ3, "somebody else's pickup was played dry").not.toBeNull();
        expect(transients.pickupLabel, "somebody else's pickup wrote this client's label").toBe(
            taken!.pickupName
        );
    }, 180_000);
});

describe('a teleporter a joined client hears', () => {
    it('plays telein where the player left and teleout where they arrived', async () => {
        const rig = await NetRig.create({
            map: 'oa_dm1',
            bots: 0,
            clients: 1,
            seed: 42,
            warmup: 40,
        });

        rig.step(30);

        const teleport = rig.host.movers.triggers.find((t) => t.kind === 'teleport');
        expect(teleport, 'oa_dm1 has no trigger_teleport, so this measured nothing').toBeDefined();

        const client = rig.clients[0]!;
        const slotIndex = client.net.slotIndex;
        const sounds = new SoundLog();
        const transients = new NetTransients({ slotIndex, audio: sounds });

        const before = [...rig.host.playerById(slotIndex)!.state.origin];

        /*
         From here on only, because the thirty frames above are the join and
         this client spawns wherever the host put it -- which on another map
         could be inside the volume under test.
        */
        const sinceJoin = client.effects.length;

        holdAt(rig, slotIndex, standIn(teleport!));
        for (let n = 0; n < 20; n++) rig.step(1);

        present(transients, client.effects, sinceJoin);

        const telein = sounds.named('world/telein');
        const teleout = sounds.named('world/teleout');
        const landed = [...rig.host.playerById(slotIndex)!.state.origin];

        // eslint-disable-next-line no-console
        console.log(
            `[net-effects] teleport: ${transients.counts.teleports} events, ` +
                `telein at [${(telein[0]?.originQ3 ?? []).map((v) => v.toFixed(0)).join(', ')}], ` +
                `teleout at [${(teleout[0]?.originQ3 ?? []).map((v) => v.toFixed(0)).join(', ')}], ` +
                `${client.net.replayedTransients} re-application(s) suppressed`
        );

        /*
         D-191 built the teleporter on the host and left it silent, because the
         `effect` hook dropped every transient and a mover sound would have been
         the first one this port presented over the wire. It is not the first
         one any more.
        */
        expect(transients.counts.teleports, 'the teleport never reached the client').toBe(1);
        expect(telein.length, 'no telein was played').toBe(1);
        expect(teleout.length, 'no teleout was played').toBe(1);

        /*
         **One, and this is where the count is load-bearing.** A teleport is the
         sharpest case of GAP-048: the host moves the player 620 units in a frame
         the client did not predict, so the AUTH_STATE that carries it forces the
         reconciliation whose replay re-executes the very event that caused it.
         Measured before `NetClient`'s `replaying` gate: one host-side crossing,
         **two** arrivals, two `world/telein`s. The suppression count is printed
         above rather than asserted, so that an engine which one day stops
         re-executing side-effect-only records makes this file quieter rather
         than red.
        */

        /*
         Both positional, and at *different* points -- which is the whole reason
         `EffectKind.Teleport` needs two vectors rather than one. `origin` is
         read on the host before `settle` moves the player, so it is where they
         left; `aux` is the destination `TeleportPlayer` chose.
        */
        expect(telein[0]!.originQ3, 'telein was played dry').not.toBeNull();
        expect(teleout[0]!.originQ3, 'teleout was played dry').not.toBeNull();

        const from = telein[0]!.originQ3!;
        const to = teleout[0]!.originQ3!;
        expect(
            Math.hypot(to[0]! - from[0]!, to[1]! - from[1]!),
            'both ends of the teleport are in the same place'
        ).toBeGreaterThan(64);

        // The far end is the mark the host actually put the player on.
        expect(Math.abs(to[0]! - landed[0]!), 'teleout is not at the destination').toBeLessThan(4);
        expect(Math.abs(to[1]! - landed[1]!), 'teleout is not at the destination').toBeLessThan(4);

        // And the near end is where they were standing, not where they ended up.
        expect(
            Math.hypot(from[0]! - before[0]!, from[1]! - before[1]!),
            'telein is nowhere near where the player entered'
        ).toBeLessThan(256);
    }, 180_000);
});

describe('a jump pad a joined client hears', () => {
    it('plays it dry for the rider and carries the launch vector', async () => {
        /*
         `am_thornish`, because it has eight `trigger_push` entities and
         `oa_dm1` has none -- the same map and the same reason as
         `net-triggers.test.ts`.
        */
        const rig = await NetRig.create({
            map: 'am_thornish',
            bots: 0,
            clients: 1,
            seed: 42,
            warmup: 40,
        });

        rig.step(30);

        const pad = rig.host.movers.triggers.find((t) => t.kind === 'push');
        expect(pad, 'am_thornish has no jump pads, so this measured nothing').toBeDefined();

        const client = rig.clients[0]!;
        const slotIndex = client.net.slotIndex;
        const sounds = new SoundLog();
        const transients = new NetTransients({ slotIndex, audio: sounds });

        const want = pad!.pushVelocity!;
        const state = rig.host.playerById(slotIndex)!.state;

        let fired = false;
        for (const at of standingSpots(pad!)) {
            for (let n = 0; n < 2 && !fired; n++) {
                holdAt(rig, slotIndex, at);
                fired = Math.abs(state.velocity[2]! - want[2]!) < 1;
            }
            if (fired) break;
        }
        expect(fired, 'no jump pad launched anybody standing on it').toBe(true);

        for (let n = 0; n < 20; n++) rig.step(1);
        present(transients, client.effects, 0);

        const played = sounds.named('world/jumppad');
        const raised = client.effects.filter((e) => e.kind === EffectKind.JumpPad);

        // eslint-disable-next-line no-console
        console.log(
            `[net-effects] jump pad: ${raised.length} events, ${played.length} sounds, ` +
                `aux z ${raised[0]?.aux[2]?.toFixed(0) ?? 'none'} against a solved ` +
                `${want[2]!.toFixed(0)}`
        );

        expect(transients.counts.jumpPads, 'the pad never reached the client').toBeGreaterThan(0);
        expect(played.length, 'the pad made no sound').toBe(transients.counts.jumpPads);

        /*
         Dry, because this client is the one being launched. Q3 plays your own
         pad at the listener; single-player hard-codes that because there was
         never anybody else, and over a wire it becomes a question with two
         answers. See `NetTransients.effect`.
        */
        expect(played[0]!.originQ3, "the rider's own pad was placed in the world").toBeNull();

        /*
         And `aux` is the vector `AimAtTarget` solved for, which is the same
         number `net-triggers.test.ts` measures on the host. It is on the wire
         because a client that wanted to scale the sound, or draw anything at
         all for a pad, would need it -- and because a pad is one of the two
         kinds whose `aux` is neither a direction nor a normal.
        */
        expect(raised[0]!.aux[2], 'the pad sent a launch vector it did not solve for').toBeCloseTo(
            want[2]!,
            0
        );
    }, 180_000);
});
