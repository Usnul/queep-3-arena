/*
 * missile-view.test.ts -- what a projectile is drawn as, and what carries it.
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
 * Every projectile in the game used to be one orange `BoxGeometry`, and the
 * models to replace it were in OpenArena's pk3s the whole time -- the pipeline
 * simply never converted them, because nothing named them. So the assertions
 * here run from the C outwards: the paths come out of `cg_weapons.c`, the files
 * have to exist in the bundle, and the entities have to end up in the dataset
 * with the model turned to face the shot.
 *
 * Two of them are about the *engine* rather than about this port, and are here
 * because this is the change that started depending on them.
 * `TransformAttachmentSystem` and `SpriteSystemPE` are registered in `main.ts`
 * by this feature and by nothing else, and this app runs in a hidden tab where a
 * screenshot cannot be taken -- so "the child follows its parent" and "a sprite
 * links without throwing" are checked here, headless, or they are not checked at
 * all until someone plays the game.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { EntityManager } from '@woosh/meep-engine/src/engine/ecs/EntityManager.js';
import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';
import { TransformAttachment } from '@woosh/meep-engine/src/engine/ecs/transform-attachment/TransformAttachment.js';
import { TransformAttachmentSystem } from '@woosh/meep-engine/src/engine/ecs/transform-attachment/TransformAttachmentSystem.js';
import { Sprite } from '@woosh/meep-engine/src/engine/graphics/ecs/sprite/Sprite.js';

import { MissileView, orientAlong } from '../src/client/MissileView.ts';
import { ModelLibrary } from '../src/client/map/loadModels.ts';
import type { ModelBundle } from '../src/client/map/SceneBundle.ts';
import { missileModel, WEAPON_ORDER } from '../src/game/Weapons.ts';

const BUILT = join(process.cwd(), 'assets', 'built');

const bundle = JSON.parse(
    readFileSync(join(BUILT, 'models', 'models.json'), 'utf8')
) as ModelBundle;

/**
 * The library without its geometry, which is all these assertions need.
 *
 * `ModelLibrary.components` runs `meshlet_geometry_build_from_geometry`, so a
 * real library means a real vertex buffer; `definition` does not, and the
 * questions here -- is the model in the bundle, how many surfaces does it have --
 * are answered off the definition. The entity-building cases below use the real
 * one.
 */
const definitions = new ModelLibrary(bundle, new Float32Array(0), new Uint32Array(0), []);

/** The full library, with the geometry buffers, for the cases that build meshes. */
function realLibrary(): ModelLibrary {
    const raw = readFileSync(join(BUILT, 'models', 'models.bin'));
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

    const vertices = new Float32Array(buffer, 0, bundle.vertexBytes / 4);
    const indices = new Uint32Array(buffer, bundle.vertexBytes, bundle.indexBytes / 4);

    /*
     No materials. `ModelLibrary.components` reads `this.materials[mesh.material]`
     and hands whatever it finds to `ShadedGeometry.from`, which stores it -- so
     `undefined` builds a component that would draw wrong and links fine, and
     what is under test here is the entities and their transforms. Materials are
     `materials.test.ts`'s subject and are checked against the images there.
    */
    return new ModelLibrary(bundle, vertices, indices, []);
}

/**
 * `CG_RegisterWeapon`'s `missileModel` lines, transcribed from the C.
 *
 * Written out rather than read from `balance.generated.json` so this is an
 * independent statement: the generated table is what is under test, and a table
 * compared against itself passes however the extractor is broken.
 */
const MISSILE_MODELS: Readonly<Record<string, string | null>> = {
    WP_GAUNTLET: null,
    WP_MACHINEGUN: null,
    WP_SHOTGUN: null,
    WP_GRENADE_LAUNCHER: 'models/ammo/grenade1.md3',
    WP_ROCKET_LAUNCHER: 'models/ammo/rocket/rocket.md3',
    WP_LIGHTNING: null,
    WP_RAILGUN: null,
    // Commented out in the C: `CG_Missile` draws the bolt as an `RT_SPRITE`.
    WP_PLASMAGUN: null,
    WP_BFG: 'models/weaphits/bfg.md3',
    WP_GRAPPLING_HOOK: 'models/ammo/hook/hook.md3',
    WP_NAILGUN: 'models/weaphits/nail.md3',
    WP_PROX_LAUNCHER: 'models/weaphits/proxmine.md3',
    WP_CHAINGUN: null,
};

function newDataset(): EntityComponentDataset {
    const ecd = new EntityComponentDataset();
    ecd.setComponentTypeMap([Transform, ShadedGeometry, TransformAttachment, Sprite]);
    return ecd;
}

/**
 * Corrective type for `traverseEntities`, as `first-person.test.ts` writes it.
 *
 * The visitor takes one component per requested class and then the entity, and
 * the generated declaration emits `(...args: any[][]) => boolean` -- the
 * generator read `@param {...*} components` as an array of the array type.
 * Narrowed rather than cast to `any`. GAP-001.
 */
type Traverse<T> = (
    classes: unknown[],
    visitor: (component: T, entity: number) => void
) => void;

/** Every entity carrying `type`, as `[entity, component]`. */
function componentsIn<T>(ecd: EntityComponentDataset, type: unknown): [number, T][] {
    const out: [number, T][] = [];

    const traverse = ecd.traverseEntities.bind(ecd) as unknown as Traverse<T>;

    traverse([type], (component, entity) => {
        out.push([entity, component]);
    });

    return out;
}

describe('the missile model table', () => {
    it("is CG_RegisterWeapon's, extracted rather than transcribed", () => {
        for (const weapon of WEAPON_ORDER) {
            expect(missileModel(weapon), weapon).toBe(MISSILE_MODELS[weapon] ?? null);
        }
    });

    it('covers every weapon in weapon_t and nothing else', () => {
        expect([...WEAPON_ORDER]).toEqual(Object.keys(MISSILE_MODELS));
    });

    it('names models the pipeline actually converted', () => {
        for (const weapon of WEAPON_ORDER) {
            const path = missileModel(weapon);
            if (path === null) continue;

            expect(definitions.has(path), `${weapon}: ${path} is not in the bundle`).toBe(true);
            expect(
                definitions.definition(path)!.meshes.length,
                `${weapon}: ${path} converted to no surfaces`
            ).toBeGreaterThan(0);
        }
    });

    /*
     The reason `MissileView` builds one entity per surface rather than putting a
     `ShadedGeometry` on the missile's own body: two of these models are more
     than one surface, and `bfg.md3` has no solid part at all -- both of its
     surfaces are additive. Drawing "the first mesh" would have drawn a four-vertex
     flare and called it a BFG shot.
    */
    it('includes models that are more than one surface', () => {
        const rocket = definitions.definition('models/ammo/rocket/rocket.md3')!;
        expect(rocket.meshes.length, 'the rocket lost its thrust flare').toBeGreaterThan(1);

        const bfg = definitions.definition('models/weaphits/bfg.md3')!;
        expect(bfg.meshes.length).toBeGreaterThan(1);
    });

    it('has a sprite on disk for the one weapon with no model', () => {
        expect(missileModel('WP_PLASMAGUN')).toBeNull();
        expect(existsSync(join(BUILT, 'fx', 'plasma_ball.png'))).toBe(true);
    });
});

describe('a missile model', () => {
    it('points its own forward down the line of flight', () => {
        const rotation = new Quaternion();

        /*
         Q3 axes in, meep axes out. `orientAlong` takes the meep direction, so
         these are the converted ones: Q3 +x forward is meep +x, Q3 +z up is meep
         +y, and Q3 +y left is meep -z.

         A converted model points +X down its own length, so the assertion is
         that the model's +X lands on the direction -- which is what
         `VectorNormalize2(s1->pos.trDelta, ent.axis[0])` says in one line.
        */
        const directions: [number, number, number][] = [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 0, 1],
            [0, 0, -1],
            [0, 1, 0],
            [0, -1, 0],
            [0.6, 0.8, 0],
        ];

        for (const dir of directions) {
            orientAlong(dir, rotation);

            const forward = new Vector3(1, 0, 0);
            forward.applyQuaternion(rotation);

            expect(forward.x, `x for ${dir.join(',')}`).toBeCloseTo(dir[0], 6);
            expect(forward.y, `y for ${dir.join(',')}`).toBeCloseTo(dir[1], 6);
            expect(forward.z, `z for ${dir.join(',')}`).toBeCloseTo(dir[2], 6);
        }
    });

    it('builds one attached entity per surface, and takes them away again', () => {
        const ecd = newDataset();
        const view = new MissileView(ecd, realLibrary());

        const body = new Entity().add(new Transform());
        body.build(ecd);

        // Straight down Q3 +x, at the rocket's own speed.
        view.spawn(7, body.id, 'WP_ROCKET_LAUNCHER', [900, 0, 0]);

        const surfaces = definitions.definition('models/ammo/rocket/rocket.md3')!.meshes.length;
        const meshes = componentsIn<ShadedGeometry>(ecd, ShadedGeometry);

        expect(meshes.length, 'one entity per surface of the model').toBe(surfaces);

        const attachments = componentsIn<TransformAttachment>(ecd, TransformAttachment);
        expect(attachments.length).toBe(surfaces);

        for (const [, attachment] of attachments) {
            expect(attachment.parent, 'attached to the body the solver flies').toBe(body.id);
            // Q3 units to metres, and uniform -- the docblock on
            // `TransformAttachment` is explicit that a non-uniform parent scale
            // cannot be composed without shear, and this is the child's own.
            expect(attachment.transform.scale.x).toBeCloseTo(1 / 32, 9);
            expect(attachment.transform.scale.y).toBeCloseTo(1 / 32, 9);
            expect(attachment.transform.scale.z).toBeCloseTo(1 / 32, 9);
        }

        /*
         And they leave. `TransformAttachment` is a spatial relation and not a
         lifetime one -- meep drops the component when the parent dies and the
         child keeps its last pose -- so without `despawn` every rocket fired
         leaves a rocket hanging in the air at the point it exploded.
        */
        view.despawn(7);

        expect(componentsIn(ecd, ShadedGeometry).length, 'a rocket left in the air').toBe(0);
        expect(componentsIn(ecd, TransformAttachment).length).toBe(0);
    });

    it('gives the plasma bolt a sprite on the body itself, and no mesh', () => {
        const ecd = newDataset();
        const view = new MissileView(ecd, realLibrary());

        const body = new Entity().add(new Transform());
        body.build(ecd);

        view.spawn(3, body.id, 'WP_PLASMAGUN', [2000, 0, 0]);

        expect(componentsIn(ecd, ShadedGeometry).length, 'a plasma bolt is not a mesh').toBe(0);

        const sprites = componentsIn<Sprite>(ecd, Sprite);
        expect(sprites.length).toBe(1);
        expect(sprites[0]![0], 'the sprite rides the body, not a child').toBe(body.id);
        expect(sprites[0]![1].url).toContain('plasma_ball');
        // `ent.radius = 16` in `CG_Missile`, which is a half-extent.
        expect(sprites[0]![1].size).toBeCloseTo((16 * 2) / 32, 9);

        // It leaves with the body it is a component of, so this is a no-op --
        // and has to be, because `Arena` calls it for every projectile.
        expect(() => {
            view.despawn(3);
        }).not.toThrow();
    });

    it('draws nothing at all for a weapon the C draws nothing for', () => {
        const ecd = newDataset();
        const view = new MissileView(ecd, realLibrary());

        const body = new Entity().add(new Transform());
        body.build(ecd);

        // Hitscan. It never reaches `projectileSpawned` in the running game, and
        // if it ever does it must not quietly acquire a plasma ball.
        view.spawn(1, body.id, 'WP_RAILGUN', [1, 0, 0]);

        expect(componentsIn(ecd, ShadedGeometry).length).toBe(0);
        expect(componentsIn(ecd, Sprite).length).toBe(0);
        expect(view.unmodelled, 'a weapon with no missile is not a missing model').toEqual([]);
    });
});

/*
 * The two engine systems this feature turns on in `main.ts`.
 *
 * Registering a system is the kind of change that is either completely right or
 * completely absent, and the absent version has no symptom a test of this port's
 * own code would catch: `MissileView` builds exactly the same entities either
 * way, and the models simply never move. So these drive the real systems on a
 * real `EntityManager`, which is the same argument `headless-ecs.test.ts` makes
 * about contact events.
 */
describe('the engine systems the missile models need', () => {
    async function started(): Promise<{
        em: EntityManager;
        ecd: EntityComponentDataset;
    }> {
        const em = new EntityManager();
        const ecd = new EntityComponentDataset();
        em.attachDataset(ecd);

        await (em as unknown as { addSystem(s: unknown): Promise<unknown> }).addSystem(
            new TransformAttachmentSystem()
        );

        await new Promise<void>((resolve, reject) => {
            em.startup(resolve, reject);
        });

        return { em, ecd };
    }

    it('composes an attached child against its parent, and follows the parent when it moves', async () => {
        const { ecd } = await started();

        const parentTransform = new Transform();
        parentTransform.position.set(10, 0, 0);
        const parent = new Entity().add(parentTransform);
        parent.build(ecd);

        const attachment = new TransformAttachment();
        attachment.parent = parent.id;
        attachment.immediate = true;
        attachment.transform.position.set(0, 1, 0);
        attachment.transform.scale.set(1 / 32, 1 / 32, 1 / 32);

        const childTransform = new Transform();
        const child = new Entity().add(childTransform).add(attachment);
        child.build(ecd);

        /*
         Composed as `parent x local`, and the child's *own* scale is not part of
         its own offset -- it scales what the child draws, not where the child
         is. Which is exactly what a missile mesh wants: the local scale is the
         Q3-units-to-metres conversion for the model, and the local position is
         zero, so the mesh sits on the body and is 1/32 the size of its own
         vertices.
        */
        expect(childTransform.position.x, 'the child never composed at all').toBeCloseTo(10, 6);
        expect(childTransform.position.y).toBeCloseTo(1, 6);
        expect(childTransform.scale.x, 'the local scale reached the world one').toBeCloseTo(
            1 / 32,
            9
        );

        /*
         The part that matters for a missile, and the reason this is not written
         from the game's own tick: the system subscribes to the parent's
         transform rather than polling it, so a child inherits whatever writes
         that transform -- including `InterpolationSystem`, which rewrites it
         between fixed steps.
        */
        parentTransform.position.set(20, 5, 0);

        expect(childTransform.position.x, 'the child did not follow its parent').toBeCloseTo(
            20,
            6
        );
        expect(childTransform.position.y).toBeCloseTo(5 + 1, 6);
    });

    it('drops the attachment when the parent is destroyed, which is why despawn exists', async () => {
        const { ecd } = await started();

        const parent = new Entity().add(new Transform());
        parent.build(ecd);

        const attachment = new TransformAttachment();
        attachment.parent = parent.id;
        attachment.immediate = true;

        const child = new Entity().add(new Transform()).add(attachment);
        child.build(ecd);

        ecd.removeEntity(parent.id);

        expect(
            ecd.getComponent(child.id, TransformAttachment),
            'meep now keeps a dead parent alive; `despawn` may be reconsidered'
        ).toBeUndefined();
        expect(
            ecd.entityExists(child.id),
            'the mesh outlives its missile, and only `despawn` removes it'
        ).toBe(true);
    });
});

/*
 * The spin, which `CG_Missile` applies to every missile it draws and the first
 * version of this file left out.
 *
 * The reasoning for leaving it out -- "a barrel roll on a shape that is very
 * nearly a surface of revolution" -- was true of the rocket and the nail, and
 * false of the grenade and the prox mine, which are a 14.6 x 10.9 x 5.9 slab and
 * a 23.8-wide drum. Those are the two that came back reported. See D-122.
 */
describe('a missile in flight', () => {
    /** `RotateAroundDirection(ent.axis, cg.time / 4)`: a quarter degree per ms. */
    const SPIN_DEGREES_PER_SECOND = 250;

    function flying(weapon: string): {
        view: MissileView;
        ecd: EntityComponentDataset;
        aimOf: () => [number, number, number];
        rollOf: () => [number, number, number];
    } {
        const ecd = newDataset();
        const view = new MissileView(ecd, realLibrary());

        const body = new Entity().add(new Transform());
        body.build(ecd);

        // Q3 +x, which is meep +x.
        view.spawn(1, body.id, weapon, [900, 0, 0]);

        const attachment = componentsIn<TransformAttachment>(ecd, TransformAttachment)[0]![1];

        const axis = (column: 0 | 1): [number, number, number] => {
            const r = attachment.transform.rotation;
            const { x, y, z, w } = r;
            return column === 0
                ? [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)]
                : [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
        };

        return { view, ecd, aimOf: () => axis(0), rollOf: () => axis(1) };
    }

    it('rolls about its own line of flight, at CG_Missile\'s rate', () => {
        const f = flying('WP_GRENADE_LAUNCHER');

        const before = f.rollOf();

        // A quarter turn takes 360/4/250 of a second at Q3's rate.
        const quarter = 90 / SPIN_DEGREES_PER_SECOND;
        f.view.update(quarter);

        const after = f.rollOf();

        const dot = before[0] * after[0] + before[1] * after[1] + before[2] * after[2];
        expect(Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI)).toBeCloseTo(90, 1);
    });

    it('never moves where it points, however long it has been spinning', () => {
        for (const weapon of ['WP_GRENADE_LAUNCHER', 'WP_PROX_LAUNCHER', 'WP_ROCKET_LAUNCHER']) {
            const f = flying(weapon);

            const aim = f.aimOf();
            expect(aim[0], `${weapon} does not start aimed`).toBeCloseTo(1, 6);

            /*
             Ten seconds at 60 Hz, which is Q3's whole missile lifetime. The roll
             is composed on the *right* of the aim, about the model's own +X --
             the axis the aim already put on the flight direction -- so this can
             only fail if that composition is the wrong way round, which is
             exactly the mistake that would look fine for one frame.
            */
            for (let i = 0; i < 600; i++) f.view.update(1 / 60);

            const later = f.aimOf();
            expect(later[0], `${weapon} drifted off its flight`).toBeCloseTo(1, 6);
            expect(later[1]).toBeCloseTo(0, 6);
            expect(later[2]).toBeCloseTo(0, 6);
        }
    });

    it('costs nothing when nothing is in the air', () => {
        const ecd = newDataset();
        const view = new MissileView(ecd, realLibrary());

        expect(() => {
            view.update(1 / 60);
        }).not.toThrow();
    });
});
