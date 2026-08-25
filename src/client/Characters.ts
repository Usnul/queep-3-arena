/*
 * Characters.ts -- place and animate OpenArena's player models.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * `CG_PlayerAnimation`'s job, on meep's clip player.
 *
 * A Q3 player runs two animations at once and always has: the legs say what the
 * feet are doing and the torso says what the weapon is doing, and they are
 * chosen by different rules from different state. The converter kept them as
 * separate clips over disjoint joint sets (`tools/convert-characters.ts`), so
 * "play both" here is literally two clips in the list rather than a blend tree.
 *
 * What is *not* ported is Q3's animation lerping between two clips, because
 * meep's clip player does its own blending and re-implementing that on top
 * would be two crossfades fighting.
 */

import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import { SGMesh } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/aggregate/SGMesh.js';
import { Animation } from '@woosh/meep-engine/src/engine/ecs/animation/Animation.js';
import { AnimationClip } from '@woosh/meep-engine/src/engine/ecs/animation/AnimationClip.js';

const WORLD_SCALE = 1 / 32;

/** Every character the pipeline converts. `angelyss` ships no `upper.md3`. */
export const CHARACTERS: readonly string[] = [
    'assassin', 'beret', 'gargoyle', 'kyonshi', 'liz', 'major', 'merman', 'neko',
    'penguin', 'sarge', 'sergei', 'skelebot', 'smarine', 'sorceress', 'tony',
];

export type LegsAnimation =
    | 'LEGS_IDLE'
    | 'LEGS_WALK'
    | 'LEGS_RUN'
    | 'LEGS_BACK'
    | 'LEGS_JUMP'
    | 'LEGS_LAND'
    | 'LEGS_IDLECR'
    | 'LEGS_WALKCR'
    | 'LEGS_TURN';

export type TorsoAnimation =
    | 'TORSO_STAND'
    | 'TORSO_STAND2'
    | 'TORSO_ATTACK'
    | 'TORSO_ATTACK2'
    | 'TORSO_GESTURE'
    | 'TORSO_RAISE'
    | 'TORSO_DROP';

interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
}

/** Q3's own repeat rule: a clip with `loopFrames` runs forever, the rest run once. */
const LOOPING = new Set<string>([
    'LEGS_WALKCR', 'LEGS_WALK', 'LEGS_RUN', 'LEGS_BACK', 'LEGS_SWIM',
    'LEGS_IDLE', 'LEGS_IDLECR', 'LEGS_TURN',
    'TORSO_STAND', 'TORSO_STAND2',
]);

/**
 * The JSON one clip in an `Animation`'s list is built from.
 *
 * `new Animation({ clips })` documents its parameter as `List<AnimationClip>`
 * and in fact routes it through `fromJSON`, which builds its own clips from
 * plain objects. Handing it real `AnimationClip` instances therefore *appears*
 * to work -- no error, a list of the right length -- and produces clips whose
 * name is the empty string, so nothing ever matches a clip in the model and the
 * entity plays nothing. Measured, not inferred: constructing both ways and
 * reading the names back gives `''` and `'LEGS_RUN'`. See REPORT.md ergonomics.
 */
function clipJson(name: string): Record<string, unknown> {
    return {
        name,
        // `repeatCount` is a count, not a flag: -1 is "forever".
        repeatCount: LOOPING.has(name) ? -1 : 1,
        weight: 1,
        timeScale: 1,
        flags: 0,
    };
}

/**
 * A Q3 origin in scene coordinates, in metres.
 *
 * Exported and pure because it is half of a claim that has been wrong twice:
 * *where a character's feet end up*. The other half is a property of the built
 * asset -- how far below its own origin the model's feet hang -- and neither
 * half is checkable on its own. `characters.test` composes the two and asserts
 * the feet land on the floor.
 *
 * Q3 is Z-up in units; meep is Y-up in metres: `(x, y, z) -> (x, z, -y) / 32`.
 */
export function sceneFromQ3(originQ3: ArrayLike<number>): [number, number, number] {
    return [
        originQ3[0]! * WORLD_SCALE,
        originQ3[2]! * WORLD_SCALE,
        -originQ3[1]! * WORLD_SCALE,
    ];
}

export class Character {
    readonly entity: number;
    readonly transform: Transform;
    readonly name: string;

    readonly animation: Animation;
    private readonly legsClip: AnimationClip;
    private readonly torsoClip: AnimationClip;

    private legs: string;
    private torso: string;

    constructor(
        ecd: EcsDataset,
        name: string,
        legs: LegsAnimation = 'LEGS_IDLE',
        torso: TorsoAnimation = 'TORSO_STAND'
    ) {
        this.name = name;
        this.legs = legs;
        this.torso = torso;

        this.transform = new Transform();
        // The glTF is in Q3 units, like every other converted asset (D-011).
        this.transform.scale.set(WORLD_SCALE, WORLD_SCALE, WORLD_SCALE);

        this.animation = new Animation({ clips: [clipJson(legs), clipJson(torso)] });
        this.animation.isPlaying = true;

        this.legsClip = this.animation.clips.get(0)!;
        this.torsoClip = this.animation.clips.get(1)!;

        const mesh = SGMesh.fromURL(`/assets/built/characters/${name}/${name}.gltf`);

        const builder = new Entity();
        builder.add(this.transform).add(mesh).add(this.animation).build(ecd);

        this.entity = builder.id;
    }

    /**
     * Q3 position and yaw.
     *
     * **No height correction.** A player MD3 is authored with its local origin
     * at `ps.origin` -- 24 units *above* the feet, the same point the collision
     * box measures its `-24` from -- so the model goes where the origin goes.
     * `CG_Player` agrees: it copies `cent->lerpOrigin` straight into
     * `legs.origin` with no adjustment, and `CG_PlayerShadow` looks for the
     * floor by tracing from `origin[2] - 24`.
     *
     * This used to subtract that 24, on the belief that a player model's origin
     * is at its feet, and buried every bot to the waist. The assets say
     * otherwise and are not ambiguous about it: `lower.md3`'s `LEGS_IDLE` frame
     * has `mins[2]` between -25.1 and -19.0 across all sixteen characters, mean
     * -23.9, and `tag_head` lands 20 to 29 units above the origin rather than
     * the 44 to 53 it would if the origin were on the ground. `characters.test`
     * measures the first of those from the converted glTF. See D-062.
     */
    place(originQ3: ArrayLike<number>, yawDegrees: number): void {
        const [x, y, z] = sceneFromQ3(originQ3);
        this.transform.position.set(x, y, z);

        const yaw = (yawDegrees * Math.PI) / 180;
        this.transform.rotation._fromAxisAngle(0, 1, 0, yaw);
    }

    setLegs(animation: LegsAnimation): void {
        if (this.legs === animation) return;
        this.legs = animation;
        this.legsClip.name.set(animation);
        this.legsClip.repeatCount.set(LOOPING.has(animation) ? -1 : 1);
    }

    setTorso(animation: TorsoAnimation): void {
        if (this.torso === animation) return;
        this.torso = animation;
        this.torsoClip.name.set(animation);
        this.torsoClip.repeatCount.set(LOOPING.has(animation) ? -1 : 1);
    }

    /**
     * `CG_PlayerAnimation`'s leg selection, reduced to what this port drives.
     *
     * Q3 picks from `ps.legsAnim`, which the server sets in `ClientThink`.
     * There is no server here, so it is derived from the same quantities the
     * server would have: ground contact, speed, and the sign of the forward
     * component. The thresholds are Q3's -- `PM_Accelerate`'s walk speed is
     * 320 units and `LEGS_WALK` is anything under about two-thirds of it.
     */
    static legsFor(speed: number, onGround: boolean, forward: number): LegsAnimation {
        if (!onGround) return 'LEGS_JUMP';
        if (speed < 20) return 'LEGS_IDLE';
        if (forward < 0) return 'LEGS_BACK';
        return speed < 200 ? 'LEGS_WALK' : 'LEGS_RUN';
    }
}
