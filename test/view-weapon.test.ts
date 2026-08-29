/*
 * view-weapon.test.ts -- what switching weapons does to the scene graph.
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
 * Written because the weapon you switched away from stayed in the world, hanging
 * at the pose it was last drawn at, and snapped back into your hands when you
 * selected it again. `ViewWeapon` put a weapon away by clearing
 * `ShadedGeometryFlags.Visible`, which is documented as *"If set to false will
 * not render"* and is read by nothing in the engine (BUG-10) -- the same dead
 * flag `ItemsView` was built on, found a second time in the file nobody thought
 * to re-check (D-088).
 *
 * `first-person.test.ts` owns the arithmetic -- the hands tag, the barrel
 * direction, the sway -- and it passed throughout, because every number the gun
 * is placed with was right. What was wrong was which entities carried a mesh,
 * which is a different question and gets its own file, alongside
 * `items-view.test.ts` for the same reason.
 *
 * A bare `EntityComponentDataset` and stub geometry, no engine boot.
 */

import { describe, expect, it } from 'vitest';

import { EntityComponentDataset } from '@woosh/meep-engine/src/engine/ecs/EntityComponentDataset.js';
import { Transform } from '@woosh/meep-engine/src/engine/ecs/transform/Transform.js';
import Quaternion from '@woosh/meep-engine/src/core/geom/Quaternion.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';
import { ShadedGeometry } from '@woosh/meep-engine/src/engine/graphics/ecs/mesh-v2/ShadedGeometry.js';

import { ViewWeapon, type CameraPose, type ViewWeaponState } from '../src/client/ViewWeapon.ts';
import { weaponItemByTag } from '../src/game/Items.ts';

/** Corrective type for `traverseEntities`; see the note in `first-person.test.ts`. */
type Traverse = (classes: unknown[], visitor: (component: never) => void) => void;

function newDataset(): EntityComponentDataset {
    const ecd = new EntityComponentDataset();
    ecd.setComponentTypeMap([Transform, ShadedGeometry]);
    return ecd;
}

/** Meshes currently attached to an entity, which is what Shade draws. */
function meshCount(ecd: EntityComponentDataset): number {
    let n = 0;
    (ecd.traverseEntities as unknown as Traverse)([ShadedGeometry], () => {
        n += 1;
    });
    return n;
}

/**
 * Pieces per model, chosen so two weapons cannot be mistaken for each other.
 *
 * A count is the only thing this test can read, so a rocket launcher left behind
 * next to a shotgun has to be arithmetically distinguishable from a shotgun on
 * its own -- otherwise the assertion that used to fail would pass.
 */
const PIECES: Readonly<Record<string, number>> = {
    'models/weapons2/shotgun/shotgun.md3': 2,
    'models/weapons2/rocketl/rocketl.md3': 3,
    'models/weapons2/gauntlet/gauntlet.md3': 5,
};

function piecesOf(weapon: string): number {
    return PIECES[weaponItemByTag(weapon)!.models[0]!]!;
}

/**
 * A model library with no models in it.
 *
 * `ViewWeapon` asks for a `tag_weapon` and for `ShadedGeometry` instances, and
 * then only ever writes transforms; bare components are the whole of what it
 * needs. That they carry no triangles is the point -- this is a test about
 * entity membership.
 */
function stubLibrary() {
    return {
        definition(name: string) {
            if (!name.endsWith('_hand.md3')) return null;
            return { tags: [{ name: 'tag_weapon', origin: [8, -4, 12] }] };
        },
        components(name: string): ShadedGeometry[] | null {
            const count = PIECES[name];
            if (count === undefined) return null;
            return Array.from({ length: count }, () => new ShadedGeometry());
        },
    };
}

function pose(eye: [number, number, number]): CameraPose {
    return { position: { x: eye[0], y: eye[1], z: eye[2] }, rotation: new Quaternion() };
}

function held(weapon: string, visible = true, firing = false): ViewWeaponState {
    return { weapon, speed: 0, bobCycle: 0, visible, firing };
}

/** The scene, as positions: one entry per mesh that is actually in it. */
function meshPositions(ecd: EntityComponentDataset): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];

    const traverse = ecd.traverseEntities.bind(ecd) as unknown as (
        classes: unknown[],
        visitor: (geometry: ShadedGeometry, transform: Transform) => void
    ) => void;

    traverse([ShadedGeometry, Transform], (_geometry, transform) => {
        out.push({ x: transform.position.x, y: transform.position.y, z: transform.position.z });
    });

    return out;
}

describe('the weapon you switch away from leaves the world', () => {
    /*
     The bug, stated as the thing it broke. Q3's own `cg.weaponSelect` swap is
     one model out and one model in; what shipped was one model in and one model
     abandoned wherever the player happened to be standing.
    */
    it('draws the weapon in hand and nothing else', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        expect(meshCount(ecd), 'the shotgun, whole').toBe(piecesOf('WP_SHOTGUN'));

        view.update(pose([1, 0, 0]), 0.016, held('WP_ROCKET_LAUNCHER'));
        expect(
            meshCount(ecd),
            'the launcher only -- the shotgun is not still lying where it was'
        ).toBe(piecesOf('WP_ROCKET_LAUNCHER'));

        view.update(pose([2, 0, 0]), 0.016, held('WP_GAUNTLET'));
        expect(meshCount(ecd)).toBe(piecesOf('WP_GAUNTLET'));

        expect(view.drawnWeapon).toBe('WP_GAUNTLET');
    });

    it('keeps the entities, so a weapon is built once however often you cycle', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        const order = ['WP_SHOTGUN', 'WP_ROCKET_LAUNCHER', 'WP_SHOTGUN', 'WP_GAUNTLET'];
        for (const weapon of order) view.update(pose([0, 0, 0]), 0.016, held(weapon));

        // Three distinct weapons ever held, built once each and kept.
        const built =
            piecesOf('WP_SHOTGUN') + piecesOf('WP_ROCKET_LAUNCHER') + piecesOf('WP_GAUNTLET');
        expect(view.pieceCount, 'every weapon held so far is still built').toBe(built);

        // ...but only the one in hand is in the scene.
        expect(meshCount(ecd)).toBe(piecesOf('WP_GAUNTLET'));
    });

    /*
     The second half of the report: "when I switch back to that weapon it gets
     teleported into my hand". It was the same defect -- the abandoned model was
     on screen at a stale pose, so re-selecting it read as a teleport rather than
     as a weapon being drawn. Pinned as an ordering property, because that is
     what makes it impossible for the mesh to be seen anywhere but in the hand:
     `update` places a weapon *before* it hands it to the scene.
    */
    it('is already in the hand on the frame it re-enters the scene', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        const addedAt: { x: number; y: number; z: number }[] = [];
        const add = ecd.addComponentToEntity.bind(ecd);

        (ecd as unknown as Record<string, unknown>).addComponentToEntity = (
            entity: number,
            component: unknown
        ): void => {
            /*
             Meshes only. `Entity.build` routes through this method too, so the
             `Transform` that carries the pose arrives by the same door -- and it
             arrives first, with nothing to read it off yet.
            */
            if (component instanceof ShadedGeometry) {
                const transform = ecd.getComponent(entity, Transform) as Transform;
                addedAt.push({
                    x: transform.position.x,
                    y: transform.position.y,
                    z: transform.position.z,
                });
            }

            add(entity, component);
        };

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        view.update(pose([10, 20, 30]), 0.016, held('WP_ROCKET_LAUNCHER'));

        addedAt.length = 0;

        // Back to the shotgun, from somewhere a long way from where it was left.
        view.update(pose([-40, 5, 60]), 0.016, held('WP_SHOTGUN'));

        expect(addedAt.length, 'every piece of the shotgun re-enters').toBe(
            piecesOf('WP_SHOTGUN')
        );

        const inHand = meshPositions(ecd);
        for (const [i, at] of addedAt.entries()) {
            expect(at.x, `piece ${i} enters at this frame's pose, not the last one`).toBeCloseTo(
                inHand[0]!.x,
                6
            );
            expect(at.y).toBeCloseTo(inHand[0]!.y, 6);
            expect(at.z).toBeCloseTo(inHand[0]!.z, 6);
        }

        // And it is where the eye is now, not where the eye was when it was put away.
        expect(inHand[0]!.x).toBeLessThan(-30);
    });

    it('does not touch the scene while the same weapon stays in hand', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));

        let churn = 0;
        const add = ecd.addComponentToEntity.bind(ecd);
        const remove = ecd.removeComponentFromEntity.bind(ecd);

        const patched = ecd as unknown as Record<string, unknown>;
        patched.addComponentToEntity = (entity: number, component: unknown): void => {
            if (component instanceof ShadedGeometry) churn += 1;
            add(entity, component);
        };
        patched.removeComponentFromEntity = (entity: number, klass: unknown): void => {
            if (klass === ShadedGeometry) churn += 1;
            remove(entity, klass);
        };

        for (let i = 0; i < 30; i++) view.update(pose([i, 0, 0]), 0.016, held('WP_SHOTGUN'));

        expect(churn, 'a held weapon is added once and left alone').toBe(0);
        expect(meshCount(ecd)).toBe(piecesOf('WP_SHOTGUN'));
    });
});

describe('a player with no gun to show has none in the scene', () => {
    /*
     `visible: false` is the corpse and the noclip camera. It went through the
     same dead flag, so a dead player's gun hung in the air at the spot they died
     until they respawned and it flew back to them.
    */
    it('takes the gun off screen when the player is dead, and gives it back', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_ROCKET_LAUNCHER'));
        expect(meshCount(ecd)).toBe(piecesOf('WP_ROCKET_LAUNCHER'));

        view.update(pose([0, 0, 0]), 0.016, held('WP_ROCKET_LAUNCHER', false));
        expect(meshCount(ecd), 'no gun for a corpse').toBe(0);
        expect(view.drawnWeapon).toBe('');

        view.update(pose([0, 0, 0]), 0.016, held('WP_ROCKET_LAUNCHER'));
        expect(meshCount(ecd), 'and it is back on respawn').toBe(
            piecesOf('WP_ROCKET_LAUNCHER')
        );
    });

    it('stays out of the scene for as long as it is hidden', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        for (let i = 0; i < 20; i++) {
            view.update(pose([i, 0, 0]), 0.016, held('WP_SHOTGUN', false));
        }

        expect(meshCount(ecd)).toBe(0);
    });

    /*
     A weapon the bundle has no model for draws nothing and must not leave the
     previous one behind either -- the null branch is the one that used to run
     `show(current, false)` against the dead flag and then return.
    */
    it('draws nothing for a weapon with no model, and keeps nothing from before', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, stubLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_SHOTGUN'));
        view.update(pose([0, 0, 0]), 0.016, held('WP_RAILGUN'));

        expect(meshCount(ecd)).toBe(0);
        expect(view.drawnWeapon).toBe('');
        expect(view.unmodelled).toEqual(['WP_RAILGUN']);
    });
});

/*
 * The barrel, which is a second model hung off the first one.
 *
 * Five of the thirteen weapons are two files, and `ViewWeapon` used to draw one
 * of them: the machinegun in your hands had no tube between its sights, and the
 * gauntlet was a handle with no blade. `first-person.test.ts` owns the question
 * of whether the *bundle* has the barrel; this owns whether the gun in hand is
 * built out of it and placed on the tag. See D-141.
 *
 * The tag used here is a real one -- `gauntlet.md3`'s `tag_barrel`, whose basis
 * is a quarter turn -- because the rotation is the half that is wrong in a way
 * you cannot count: a barrel placed at the right point with the wrong basis is
 * still a barrel, pointing across the gun.
 */
describe('a weapon that is two models is drawn as two models', () => {
    const BODY = 'models/weapons2/gauntlet/gauntlet.md3';
    const BARREL = 'models/weapons2/gauntlet/gauntlet_barrel.md3';

    /** `gauntlet.md3`'s own `tag_barrel`, in meep model axes and Q3 units. */
    const TAG_ORIGIN: [number, number, number] = [11.02, -0.59, 0.07];

    /** And its basis: forward becomes -z, up becomes +x, right becomes -y. */
    const TAG_ROTATION: [number, number, number, number] = [0.5, 0.5, -0.5, 0.5];

    /** A weapon that is a single model, for the latch test. */
    const NO_BARREL = 'models/weapons2/shotgun/shotgun.md3';

    const BODY_PIECES = 2;
    const BARREL_PIECES = 1;

    function barrelLibrary() {
        return {
            definition(name: string) {
                if (name.endsWith('_hand.md3')) {
                    return { tags: [{ name: 'tag_weapon', origin: [8, -4, 12], rotation: [0, 0, 0, 1] }] };
                }
                if (name === BODY) {
                    return {
                        tags: [
                            { name: 'tag_barrel', origin: TAG_ORIGIN, rotation: TAG_ROTATION },
                        ],
                    };
                }
                if (name === BARREL || name === NO_BARREL) return { tags: [] };
                return null;
            },
            components(name: string): ShadedGeometry[] | null {
                if (name === BODY) {
                    return Array.from({ length: BODY_PIECES }, () => new ShadedGeometry());
                }
                if (name === BARREL) {
                    return Array.from({ length: BARREL_PIECES }, () => new ShadedGeometry());
                }
                if (name === NO_BARREL) return [new ShadedGeometry()];
                return null;
            },
        };
    }

    /** Every drawn piece's pose, in the order the entities were built. */
    function drawnPoses(ecd: EntityComponentDataset): { position: Vector3; rotation: Quaternion }[] {
        const out: { position: Vector3; rotation: Quaternion }[] = [];

        const traverse = ecd.traverseEntities.bind(ecd) as unknown as (
            classes: unknown[],
            visitor: (geometry: ShadedGeometry, transform: Transform) => void
        ) => void;

        traverse([ShadedGeometry, Transform], (_geometry, transform) => {
            out.push({
                position: transform.position.clone(),
                rotation: transform.rotation.clone(),
            });
        });

        return out;
    }

    it('draws the barrel as well as the body', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, barrelLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET'));

        expect(meshCount(ecd), 'the gauntlet, blade included').toBe(
            BODY_PIECES + BARREL_PIECES
        );
    });

    it('puts the barrel on the tag rather than on the weapon origin', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, barrelLibrary() as never);

        view.update(pose([3, 4, 5]), 0.016, held('WP_GAUNTLET'));

        const poses = drawnPoses(ecd);
        expect(poses.length).toBe(BODY_PIECES + BARREL_PIECES);

        // The body's pieces all share one pose; the barrel's does not.
        const body = poses[0]!;
        for (let i = 1; i < BODY_PIECES; i++) {
            expect(poses[i]!.position.distanceTo(body.position)).toBeCloseTo(0, 9);
        }

        const barrel = poses[BODY_PIECES]!;

        /*
         Distance rather than components, because it is the one thing the view
         direction cannot change: the tag is a point on a rigid model, so however
         the gun is turned the barrel sits |tag| model units from it -- scaled
         into scene metres by the same 1/32 every other piece is drawn at.
        */
        const WORLD_SCALE = 1 / 32;
        const expected = Math.hypot(...TAG_ORIGIN) * WORLD_SCALE;

        expect(barrel.position.distanceTo(body.position), 'the barrel is not on its tag').toBeCloseTo(
            expected,
            6
        );
        expect(expected, 'a tag at the origin would prove nothing').toBeGreaterThan(0.3);
    });

    /*
     The tag basis, asserted in the one way the spin cannot disturb.

     A barrel carries two rotations now -- the tag's basis, which aims it, and
     `CG_MachinegunSpinAngle`'s roll, which turns it about its own length. Roll
     is a rotation about +x and therefore *fixes* +x, so where the barrel's own
     forward direction ends up is the tag's contribution and nothing else. The
     spin gets its own tests below, where it can be read without the basis on
     top of it.
    */
    it('aims the barrel with the tag basis, not just the gun', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, barrelLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET'));

        const poses = drawnPoses(ecd);
        const body = poses[0]!.rotation;
        const barrel = poses[BODY_PIECES]!.rotation;

        const tag = new Quaternion().set(...TAG_ROTATION);

        // `CG_PositionRotatedEntityOnTag`: the child's axis is the tag's,
        // multiplied by the parent's.
        const expected = new Quaternion().multiplyQuaternions(body, tag);

        const along = (q: Quaternion): Vector3 => new Vector3(1, 0, 0).applyQuaternion(q);
        const got = along(barrel);
        const want = along(expected);

        expect(got.x, 'the barrel is not aimed by its tag').toBeCloseTo(want.x, 6);
        expect(got.y).toBeCloseTo(want.y, 6);
        expect(got.z).toBeCloseTo(want.z, 6);

        // And that is a real turn, not an identity dressed up as one: the
        // gauntlet's tag points its blade across the gun, not along it.
        expect(got.distanceTo(along(body)), 'the tag basis went missing').toBeGreaterThan(1);
    });

    /*
     * The spin, which is a latch and not an integration.
     *
     * `CG_MachinegunSpinAngle` records when the trigger last changed and what
     * the angle was then, and derives everything else from the clock. The three
     * things worth pinning are that a barrel nobody is firing does not move,
     * that holding the trigger turns it at Q3's rate, and that letting go coasts
     * it down instead of stopping it dead -- and all three are read off the
     * drawn transform rather than off the state machine, because a spin the
     * renderer never applies is not a spin.
     */
    describe('the barrel spins while the trigger is held', () => {
        /** The barrel's roll, in degrees, recovered from the two drawn poses. */
        function rollDegrees(ecd: EntityComponentDataset): number {
            const poses = drawnPoses(ecd);
            const body = poses[0]!.rotation;
            const barrel = poses[BODY_PIECES]!.rotation;

            // barrel = body * tag * roll, so roll = (body * tag)^-1 * barrel.
            const aimed = new Quaternion().multiplyQuaternions(
                body,
                new Quaternion().set(...TAG_ROTATION)
            );
            const roll = new Quaternion()
                .multiplyQuaternions(aimed.invert(), barrel)
                .normalize();

            // It must be a turn about the barrel's own length, or it is not a
            // roll at all -- that is the half of this a magnitude cannot see.
            const axis = new Vector3();
            const angle = roll.toAxisAngle(axis);
            expect(Math.abs(axis.x), 'the barrel is not turning about its own length').toBeCloseTo(
                1,
                5
            );

            const signed = axis.x > 0 ? angle : -angle;
            return (signed * 180) / Math.PI;
        }

        /** Difference between two angles in degrees, wrapped into (-180, 180]. */
        const turned = (from: number, to: number): number => {
            let d = (to - from) % 360;
            if (d > 180) d -= 360;
            if (d <= -180) d += 360;
            return d;
        };

        it('does not turn a barrel nobody is firing', () => {
            const ecd = newDataset();
            const view = new ViewWeapon(ecd as never, barrelLibrary() as never);

            view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET'));
            const first = rollDegrees(ecd);

            for (let i = 0; i < 60; i++) view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET'));

            /*
             A whole second of standing still. Q3's `centity_t` is memset on map
             load, so its barrel reaches the coast arm with a delta of minutes
             and sits at a constant angle from the first frame; a zero-based
             clock that starts at `barrelTime = 0` instead winds the barrel
             through 450 degrees over the first second with nobody touching the
             trigger, which is the one part of this that would be visible and is
             not in the C. `newBarrelSpin` starts a `COAST_TIME` in the past for
             exactly this assertion.
            */
            expect(turned(first, rollDegrees(ecd)), 'an idle barrel turned').toBeCloseTo(0, 4);
        });

        it('turns at `SPIN_SPEED` while the trigger is down', () => {
            const ecd = newDataset();
            const view = new ViewWeapon(ecd as never, barrelLibrary() as never);

            // Settle first: the latch has to see the trigger go down.
            view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET', true, true));
            const before = rollDegrees(ecd);

            // 100 ms of held trigger, which is 90 degrees at 0.9 deg/ms.
            for (let i = 0; i < 10; i++) {
                view.update(pose([0, 0, 0]), 0.01, held('WP_GAUNTLET', true, true));
            }

            expect(turned(before, rollDegrees(ecd)), 'not Q3\'s 0.9 degrees a millisecond')
                .toBeCloseTo(90, 3);
        });

        it('coasts down when the trigger comes up rather than stopping dead', () => {
            const ecd = newDataset();
            const view = new ViewWeapon(ecd as never, barrelLibrary() as never);

            for (let i = 0; i < 50; i++) {
                view.update(pose([0, 0, 0]), 0.01, held('WP_GAUNTLET', true, true));
            }

            // Let go, then sample the first tenth of a second against the last.
            view.update(pose([0, 0, 0]), 0.01, held('WP_GAUNTLET'));
            const released = rollDegrees(ecd);

            for (let i = 0; i < 10; i++) view.update(pose([0, 0, 0]), 0.01, held('WP_GAUNTLET'));
            const justAfter = rollDegrees(ecd);

            // A second later it must have stopped moving entirely.
            for (let i = 0; i < 120; i++) view.update(pose([0, 0, 0]), 0.01, held('WP_GAUNTLET'));
            const settled = rollDegrees(ecd);

            for (let i = 0; i < 30; i++) view.update(pose([0, 0, 0]), 0.01, held('WP_GAUNTLET'));

            const early = turned(released, justAfter);

            expect(early, 'the barrel stopped dead instead of coasting').toBeGreaterThan(5);
            expect(early, 'the barrel did not slow down at all').toBeLessThan(90);
            expect(turned(settled, rollDegrees(ecd)), 'it never came to rest').toBeCloseTo(0, 4);
        });

        it('keeps the latch on the player, so switching weapons does not reset it', () => {
            const ecd = newDataset();
            const view = new ViewWeapon(ecd as never, barrelLibrary() as never);

            /*
             `cent->pe` belongs to the entity holding the gun, not to the gun. A
             latch kept per weapon would find the blade at rest every time you
             came back to it, and Q3's does not.
            */
            for (let i = 0; i < 50; i++) {
                view.update(pose([0, 0, 0]), 0.01, held('WP_GAUNTLET', true, true));
            }
            const spinning = rollDegrees(ecd);

            // Away to a weapon with no barrel at all, and back, still firing.
            view.update(pose([0, 0, 0]), 0.01, held('WP_SHOTGUN', true, true));
            view.update(pose([0, 0, 0]), 0.01, held('WP_GAUNTLET', true, true));

            // Two frames of 10 ms at 0.9 deg/ms is 18 degrees, not a reset to
            // wherever a fresh latch would start.
            expect(turned(spinning, rollDegrees(ecd)), 'the latch restarted').toBeCloseTo(18, 3);
        });
    });

    it('takes the barrel off screen with the rest of the weapon', () => {
        const ecd = newDataset();
        const view = new ViewWeapon(ecd as never, barrelLibrary() as never);

        view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET'));
        expect(meshCount(ecd)).toBe(BODY_PIECES + BARREL_PIECES);

        view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET', false));
        expect(meshCount(ecd), 'a dead player still has a blade in the air').toBe(0);

        view.update(pose([0, 0, 0]), 0.016, held('WP_GAUNTLET'));
        expect(meshCount(ecd)).toBe(BODY_PIECES + BARREL_PIECES);
        expect(view.pieceCount, 'and it was built once').toBe(BODY_PIECES + BARREL_PIECES);
    });
});
