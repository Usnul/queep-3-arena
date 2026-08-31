/*
 * roster.ts -- who is in this match.
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
 * One bot per spawn point beyond the player's, the world those bots perceive,
 * and the player as something they can shoot back at.
 *
 * Lifted out of `main` when the frame became systems (phase 9). It is a lot of
 * arguments for one function, and that is the honest shape of it: a bot needs
 * the collision, the navigation graph, the item list, the weapon system, a
 * character to wear and the same movement host the player runs on, and passing
 * them is cheaper than a mutable object that pretends otherwise.
 */

import { Bot } from '../game/Bot.ts';
import { BotRuntime, type BotWorld } from '../client/Bots.ts';
import { Character, CHARACTERS, type EcsDataset } from '../client/Characters.ts';
import type { CharacterBodies } from '../client/CharacterBody.ts';
import { interpolatedPose } from './systems.ts';
import type { AudioBank } from '../client/Audio.ts';
import type { Arena } from '../client/Arena.ts';
import type { PhysicsWorld } from '../client/PhysicsWorld.ts';
import type { PlayerController } from '../client/PlayerController.ts';
import type { ItemSystem } from '../game/Items.ts';
import type { MoverSystem } from '../game/Movers.ts';
import type { MoverHost } from '../client/MeepMove.ts';
import type { WaypointGraph } from '../game/Waypoints.ts';
import type { Damageable } from '../game/Weapons.ts';
import { ClipMap } from '../q3/cm/ClipMap.ts';
import { vec3 as q3vec3 } from '../q3/math.ts';

export interface Roster {
    readonly botRuntime: BotRuntime;
    readonly characters: readonly Character[];
    /** Every spawn point in the map, which is also where a dead player comes back. */
    readonly botSpawns: readonly (readonly number[])[];
}

export function buildRoster(options: {
    ecd: EcsDataset & { addComponentToEntity(entity: number, component: unknown): void };
    clipMap: ClipMap;
    physicsWorld: PhysicsWorld | null;
    moverHost: MoverHost | null;
    graph: WaypointGraph;
    items: ItemSystem;
    movers: MoverSystem;
    arena: Arena;
    audio: AudioBank;
    player: PlayerController;
    entrances: { readonly points: readonly { readonly _originQ3: number[] }[] };
    /** Null on the backends with no meep physics to put a body in. */
    bodies: CharacterBodies | null;
}): Roster {
    const {
        ecd, clipMap, physicsWorld, moverHost, graph, items, movers, arena, audio, player,
        entrances, bodies,
    } = options;

    const botSpawns = entrances.points.map((e) => e._originQ3);

    const botWorld: BotWorld = {
        graph,
        items: items.items,
        /*
         The weapon system's own line of sight, so a bot sees exactly as far as
         it can shoot. It also gets the backend split for free -- `raycast` where
         there is a broadphase, the ported point trace where there is not -- which
         is what this closure used to do by hand, with a `createTrace()` per call
         and a zero-size box that `PhysicsTrace` swept as a shape. See D-159.
        */
        visible: (fromQ3, toQ3) => arena.weapons.visible(fromQ3, toQ3),
        playerOrigin: () => player.ps.origin,
        playerAlive: () => player.inventory.health > 0,
        spawns: botSpawns.map((spawn) => {
            const node = graph.nearestInMainBody(spawn);
            return node < 0
                ? spawn
                : [
                      graph.nodes[node]!.origin[0],
                      graph.nodes[node]!.origin[1],
                      graph.nodes[node]!.origin[2] - 9,
                  ];
        }),
        fire: (bot, eye, angles, weapon) => {
            /*
             The bot's own id as `ownerId`, so `hitscanShot` skips it. The
             muzzle is 14 units in front of the eye and a bot's own box is
             15 wide, so a bot firing with `ownerId: 0` shoots itself the
             instant it pulls the trigger.
            */
            arena.weapons.fire(weapon, eye, angles, bot.id, (Math.random() * 0xffff) | 0);
        },
    };

    /*
     The player, as something bots can shoot.
 
     Bots were firing at it for a hundred rounds apiece and doing nothing,
     because `weapons.targets` held only the boxes and the bots. `origin`
     is a live reference to `ps.origin` rather than a copy, so it tracks
     without anything having to remember to update it; `health` and `armor`
     are accessors over the same inventory the HUD reads, so there is one
     number rather than two that can disagree.
    */
    const playerTarget: Damageable = {
        id: 0,
        origin: player.ps.origin,
        mins: q3vec3(-15, -15, -24),
        maxs: q3vec3(15, 15, 32),
        get health(): number {
            return player.inventory.health;
        },
        set health(value: number) {
            player.inventory.health = value;
        },
        get armor(): number {
            return player.inventory.armor;
        },
        set armor(value: number) {
            player.inventory.armor = value;
        },
        get dead(): boolean {
            return player.inventory.health <= 0;
        },
        set dead(_value: boolean) {
            // Death is derived from health; nothing sets it directly.
        },
    };
    arena.weapons.targets.push(playerTarget);

    const botRuntime = new BotRuntime(botWorld, audio);
    const characters: Character[] = [];

    /*
     One bot per spawn point beyond the player's, up to the roster size. Q3
     fills a server from `bot_minplayers`; there is no server here, so the
     map's own spawn count stands in -- a map built for eight players gets
     seven opponents.
    */
    for (let i = 1; i < botSpawns.length && i <= CHARACTERS.length; i++) {
        const name = CHARACTERS[(i - 1) % CHARACTERS.length]!;

        /*
         Snapped to the navigation graph's main body. A spawn point the
         graph cannot route out of produces a bot that stands still for the
         whole match -- see `nearestInMainBody`.
        */
        const snapped = graph.nearestInMainBody(botSpawns[i]!);
        const spawnQ3 =
            snapped < 0
                ? botSpawns[i]!
                : [
                      graph.nodes[snapped]!.origin[0],
                      graph.nodes[snapped]!.origin[1],
                      // Node origins are standing positions and the host
                      // adds Q3's own 9-unit spawn lift, so take it back off.
                      graph.nodes[snapped]!.origin[2] - 9,
                  ];

        const slot = bodies?.create(2000 + i) ?? null;

        const bot = new Bot({
            id: 2000 + i,
            name,
            character: name,
            cm: clipMap,
            spawnQ3,
            physics: physicsWorld,
            movers: () => ({ movers: movers.clipEntities }),
            // The same solver the player runs, which is the whole point of
            // a bot filling a `usercmd_t` rather than steering itself. The host
            // is this bot's own, because the filter on it names this bot's body.
            moverHost: slot?.host ?? moverHost,
        });

        slot?.track(() => bot.origin);

        const character = new Character(ecd, name);

        /*
         A bot's drawn body is placed from `ps.origin` on the fixed step, so
         above the step rate it holds a pose for several frames and then jumps --
         most visible on the thing in the level that moves fastest and is looked
         at hardest. Physics does not own this transform (a character's collision
         is a separate body, because a Q3 player box does not rotate with the
         model that stands in it), so it goes on the application's timeline.
        */
        ecd.addComponentToEntity(character.entity, interpolatedPose());

        characters.push(character);

        botRuntime.spawn(bot, character);
        arena.weapons.targets.push(bot);
    }

    console.log(`[queep] bots: ${botRuntime.bots.length}, ${characters.length} characters`);
    return { botRuntime, characters, botSpawns };
}
