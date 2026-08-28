/*
 * Acoustics.ts -- the level as a thing sound has to get through.
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
 * meep's acoustic simulation wants two things from a level, and this file is
 * both of them.
 *
 * **Occluders.** `AcousticSimulationSystem` links `AcousticBody + Collider +
 * Transform` and raycasts the collider's shape directly -- so the brush bodies
 * `PhysicsWorld` already builds *are* the acoustic scene, with one extra
 * component on each. Nothing here builds a second copy of the level.
 *
 * **A probe field.** `bakeProbeField` covers the air with probes, measures the
 * reverberation at each one by casting rays into the geometry, and hands back a
 * serializable field. That bake is minutes of work on a Q3 arena, which is why
 * it is `tools/bake-audio.ts` and not a load step; the runtime reads the result
 * back through the same adapter that wrote it.
 *
 * Both halves live in one file on purpose, and neither owns the geometry. A
 * probe field baked against different solids than the runtime occludes with is
 * wrong in a way nothing reports -- the reverberation is simply measured in a
 * room that is not the room -- so the brush conversion is `hullShape.ts`, which
 * the bake here and `PhysicsWorld` both call. This project has paid for that
 * class of duplication already; see D-036.
 */

import { AcousticBody } from '@woosh/meep-engine/src/engine/sound/simulation/ecs/AcousticBody.js';
import { AcousticMaterial } from '@woosh/meep-engine/src/engine/sound/simulation/definition/AcousticMaterial.js';
import { AcousticOccluderIndex } from '@woosh/meep-engine/src/engine/sound/simulation/core/AcousticOccluderIndex.js';
import { AcousticProbeField } from '@woosh/meep-engine/src/engine/sound/simulation/probe/AcousticProbeField.js';
import { AcousticProbeFieldSerializationAdapter } from '@woosh/meep-engine/src/engine/sound/simulation/probe/AcousticProbeFieldSerializationAdapter.js';
import { BinaryBuffer } from '@woosh/meep-engine/src/core/binary/BinaryBuffer.js';
import Entity from '@woosh/meep-engine/src/engine/ecs/Entity.js';

import { CONTENTS, type ClipMap } from '../q3/cm/ClipMap.ts';
import { buildHulls } from '../q3/cm/brushHull.ts';
import { hullShape } from './hullShape.ts';
import { fetchOptionalBinary } from './optionalAsset.ts';

/** What `tools/bake-audio.ts` writes next to `scene.json`. */
export const PROBE_FILE = 'audio-probes.bin';

/**
 * Probe spacing hint, in scene metres.
 *
 * Four metres is 128 Q3 units, which is half the 256-unit grid Q3 levels are
 * built on: a corridor gets probes along it and an ordinary room gets several,
 * without the bake having to resolve anything finer than the geometry has. The
 * bake refines below this on its own wherever connectivity needs it -- that is
 * what `maxRefineFactor` is for -- so this is the spacing of the *open* case,
 * not a floor on the detailed one.
 */
export const PROBE_SPACING = 4;

/**
 * Rays cast per probe when measuring its reverberation.
 *
 * An offline number, paid once per bake. The runtime's own
 * `AcousticSimulator.rayCount` is a different and much smaller budget, spent
 * every frame on occlusion rather than once on reverberation, and the two
 * should not be confused for each other.
 */
export const PROBE_RAYS = 256;

/**
 * Bake RNG seed. Fixed so re-baking unchanged geometry reproduces the file it
 * replaces, on the same reasoning as the material pipeline's
 * `inverse_render.py --seed 1000`.
 */
export const PROBE_SEED = 1000;

/**
 * Longest per-band RT60 a probe is allowed to ship, in seconds.
 *
 * A ceiling on the *measurement*, applied by the bake rather than the runtime,
 * and it is a design decision rather than a correction -- the bake is not
 * wrong. `am_thornish` genuinely measures 7.1 s in its largest volume, which is
 * what Sabine gives for a hall that size behind surfaces as live as
 * {@link Q3_SURFACE}. Two things say not to ship it.
 *
 * **Cost.** `reverbImpulseResponse` synthesises an IR one RT60 long and does it
 * on the main thread every time the listener crosses into a probe cell whose
 * decay differs enough to re-bake. At 7 s and 48 kHz that is a 340,000-sample
 * stereo buffer plus three `Float64Array` scratch bands the same length --
 * about 11 MB allocated and filled mid-match, and a `ConvolverNode` running
 * that IR from then on. At 3 s it is well under half of it.
 *
 * **Legibility.** A seven-second tail smears exactly the thing Quake III uses
 * sound for. Q3 shipped bone dry and hearing where someone is remains a
 * gameplay channel; a reverberation long enough to obscure it has stopped being
 * atmosphere.
 *
 * Three seconds is above every band `oa_dm1` and `aggressor` measure, so it
 * clamps nothing on the maps whose rooms are room-sized -- the bake reports how
 * many probes it caught, so a map that is being reshaped by it says so.
 */
export const PROBE_MAX_RT60 = 3;

/**
 * What a Quake III brush sounds like.
 *
 * Q3 has no acoustic material model at all -- a surface carries a texture and a
 * `surfaceparm`, and the sound code reads neither -- so there is nothing to
 * port here and this is a choice rather than a conversion. Two things decide
 * it.
 *
 * **Absorption rises with frequency**, because every real hard surface does,
 * and an arena of metal and stone is a live room.
 *
 * **Transmission is deliberately not zero.** A fully blocking wall silences
 * whatever is behind it, and in Quake III hearing an enemy through a wall is
 * not a defect -- it is the game's positional-audio channel, since Q3 models no
 * occlusion whatsoever. `EventInstance.setAcoustic` uses transmission as the
 * per-band floor a fully occluded source keeps -- `(1 - occlusion) + occlusion *
 * transmission` -- so this curve makes a sound behind a wall *muffled* rather
 * than gone: the lows carry, the top end does not. Corner-leak pathing is the
 * other way to keep that channel open and is deliberately not used; see
 * `configureAcoustics` in `src/app/main.ts`.
 *
 * One instance, shared by every brush in the level. Nothing writes to an
 * `AcousticMaterial` after it is attached -- `OcclusionSolver` reads its bands
 * at a ray hit and `AcousticBody.fromJSON` replaces the object rather than
 * mutating it -- and a map is thousands of brushes, so a copy each would be
 * thousands of identical objects to no end.
 */
export const Q3_SURFACE: AcousticMaterial = AcousticMaterial.from({
    absorption: [0.06, 0.1, 0.16],
    scattering: 0.5,
    transmission: [0.5, 0.25, 0.08],
});

/**
 * Whether a brush blocks sound.
 *
 * `CONTENTS.SOLID` and nothing else. The physics bodies are built for
 * `MASK_PLAYERSOLID`, which also takes `PLAYERCLIP` -- the invisible fences
 * that keep players off ledges and out of scenery. Those are not walls: a
 * rocket flies through them (see `layers.ts`) and so should the sound of one.
 * Occluding on them would put an audible wall in the middle of open air.
 */
export function occludesSound(contents: number): boolean {
    return (contents & CONTENTS.SOLID) !== 0;
}

export interface OccluderSceneStats {
    /** Solid brushes in the world model. */
    readonly brushes: number;
    readonly bodies: number;
    /** Brushes that produced no usable hull. */
    readonly skipped: number;
    readonly milliseconds: number;
}

export interface OccluderScene {
    readonly index: AcousticOccluderIndex;
    readonly stats: OccluderSceneStats;
}

/**
 * The level as an `AcousticOccluderIndex`, for the offline bake.
 *
 * Model 0 only -- the world. Models 1..n are brush entities, and a door is a
 * thing the *runtime* occludes with (`AcousticSimulationSystem` follows a
 * moving transform) rather than a thing a reverberation time should be measured
 * against: RT60 is a property of the room, and baking a door in at its authored
 * position measures the room in whatever state the level happened to ship.
 *
 * The conversion is `hullShape`, which is also what `PhysicsWorld` builds its
 * bodies from -- so what the bake hears and what the runtime occludes with are
 * the same solids.
 *
 * **Brush solids only.** `PhysicsWorld` also builds bodies from patch facets
 * (`patchHull.ts`) and this does not, so sound passes through a curved wall
 * that a player cannot. The reason is that this is an *offline* bake whose
 * output is committed -- `audio-probes.bin` per map -- and including the facets
 * changes the probes on every map with curves in it. It is a real gap, left
 * open deliberately rather than by omission, and closing it is a re-bake rather
 * than a code change.
 */
export function buildOccluderScene(cm: ClipMap): OccluderScene {
    const t0 = performance.now();

    const index = new AcousticOccluderIndex();

    const world = cm.models[0]!;
    const set = buildHulls(cm, CONTENTS.SOLID, world.firstBrush, world.numBrushes);

    let bodies = 0;
    let degenerate = 0;

    for (const hull of set.hulls) {
        const placed = hullShape(hull);

        if (placed === null) {
            degenerate += 1;
            continue;
        }

        /*
         Column-major, translation in [12..14]. There is no rotation to carry:
         the axis swap is already baked into the hull's vertices, which is the
         rigid-transform precondition `AcousticOccluderIndex` states.
        */
        index.addBody(placed.shape, Q3_SURFACE, [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            placed.x, placed.y, placed.z, 1,
        ]);

        bodies += 1;
    }

    return {
        index,
        stats: {
            brushes: set.hulls.length + set.skipped,
            bodies,
            skipped: set.skipped + degenerate,
            milliseconds: performance.now() - t0,
        },
    };
}

/* ------------------------------------------------------------------ *
 * Serialization.
 *
 * meep's own adapter, in both directions -- there is nothing to write here
 * beyond handing it a buffer. What it deliberately leaves out is worth stating,
 * because it decides what the runtime can do with the result: the visibility
 * graph and the reflector lobes are products of the *geometry* rather than of
 * the probes, re-deriving them costs what the bake costs, and so the format
 * carries probe positions and reverberation only. That is exactly the data a
 * run without corner-leak pathing reads.
 * ------------------------------------------------------------------ */

/** The bytes `tools/bake-audio.ts` writes. */
export function encodeProbeField(field: AcousticProbeField): Uint8Array {
    const buffer = new BinaryBuffer();

    new AcousticProbeFieldSerializationAdapter().serialize(buffer, field);
    buffer.trim();

    return buffer.raw_bytes;
}

/** The inverse. `bytes` is the whole file. */
export function decodeProbeField(bytes: ArrayBuffer): AcousticProbeField {
    const field = new AcousticProbeField();

    new AcousticProbeFieldSerializationAdapter().deserialize(
        BinaryBuffer.fromArrayBuffer(bytes),
        field
    );

    return field;
}

/**
 * Load a map's baked probe field, or null if it has none.
 *
 * A missing file is not an error. The bake is a separate tool over an asset
 * tree that is not itself in the repository, so a checkout that has not run it
 * should play with occlusion and no reverberation rather than fail to start --
 * and the caller says which of the two happened. `fetchOptionalBinary` is what
 * decides "missing", and it is not `response.ok`: see its docblock.
 *
 * @param baseUrl e.g. `/assets/built/oa_dm1`
 */
export async function loadProbeField(baseUrl: string): Promise<AcousticProbeField | null> {
    const bytes = await fetchOptionalBinary(`${baseUrl}/${PROBE_FILE}`);
    if (bytes === null) return null;

    return decodeProbeField(bytes);
}

/** The part of `EntityComponentDataset` this file uses. */
interface EcsDataset {
    isComponentTypeRegistered(type: unknown): boolean;
    registerComponentType(type: unknown): void;
    addComponentToEntity(entity: number, component: unknown): void;
}

/**
 * Hang the field on an entity, which is how `AcousticProbeFieldSystem` finds
 * it: the field is a component, so attaching it is both the wiring and the
 * thing that would save with a scene.
 */
export function attachProbeField(ecd: EcsDataset, field: AcousticProbeField): number {
    if (!ecd.isComponentTypeRegistered(AcousticProbeField)) {
        ecd.registerComponentType(AcousticProbeField);
    }

    const entity = new Entity();
    entity.add(field).build(ecd);

    return entity.id;
}

/**
 * Make a brush body an acoustic occluder, if it is the kind that blocks sound.
 *
 * Called from `PhysicsWorld` as each body is built, rather than as a second
 * pass over the dataset afterwards: `AcousticSimulationSystem` links on the
 * triple `AcousticBody + Collider + Transform`, and the place that knows an
 * entity is a solid world brush is the place that made it one.
 *
 * @returns whether the entity became an occluder.
 */
export function addAcousticBody(ecd: EcsDataset, entity: number, contents: number): boolean {
    /*
     Whether anything is listening, asked of the dataset rather than passed down
     from the caller. `EntityManager.addSystem` registers a system's dependency
     component types, so `AcousticBody` is a registered type exactly when
     `AcousticSimulationSystem` is running -- and when it is not, this component
     would be inert, one object per brush and thousands of brushes. The browser
     registers the acoustic systems long before the first body is built
     (`configureAcoustics`), and a run with no `AudioContext` at all, or a
     headless harness, registers neither and pays nothing.
    */
    if (!ecd.isComponentTypeRegistered(AcousticBody)) return false;

    if (!occludesSound(contents)) return false;

    ecd.addComponentToEntity(entity, AcousticBody.from(Q3_SURFACE));

    return true;
}
