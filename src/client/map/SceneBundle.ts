/*
 * SceneBundle.ts -- the shape of what tools/convert-map.ts writes.
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
 * Hand-written rather than generated, and shared between the pipeline and the
 * runtime so a change to the writer that the reader has not caught up with is a
 * type error rather than a blank screen.
 */

export type TransparencyName = 'opaque' | 'mask' | 'blend';

/**
 * The Q3 blend an albedo image was written for; `tools/pipeline/texture-out.ts`
 * has the restatements and `shader-to-pbr.ts` has the reasoning.
 *
 * Spelled out again here rather than imported, for the same reason
 * `TransparencyName` is: the runtime does not read `tools/`, and a bundle field
 * whose type lives in the pipeline would make it look as if it did. The runtime
 * never acts on this one -- the written texture already carries the result -- but
 * a bundle that does not say which blend produced its textures cannot be checked
 * against the shaders it came from.
 */
export type TextureBlendName =
    | 'opaque'
    | 'alpha'
    | 'add'
    | 'addAlpha'
    | 'filter'
    | 'premultiplied';

export interface BundleMaterial {
    readonly name: string;
    /**
     * Key into {@link SceneBundle.textures}, or `null` when nothing on disk
     * backed it. A path most of the time, but a path plus `#<blend>` when the
     * same image had to be written more than one way.
     */
    readonly albedo: string | null;
    readonly albedoBlend: TextureBlendName;
    /**
     * Generated tangent-space normal map, keyed as `<path>#normal`. Absent in
     * bundles written before the material phase; `null` where the generator
     * produced nothing for this texture.
     */
    readonly normal?: string | null;
    /**
     * Generated ORM -- G roughness, B metalness, R 1.0. Keyed as `<path>#orm`.
     * When it is present the material's `roughness` and `metallic` stop being
     * the value and become a multiplier over it; see `buildMaterials`.
     */
    readonly orm?: string | null;
    readonly emissive: string | null;
    readonly emissiveLuminance: number;
    readonly roughness: number;
    readonly metallic: number;
    readonly transparency: TransparencyName;
    readonly alphaCutoff: number;
    readonly doubleSided: boolean;
    readonly surfaceLight: number;
}

export interface BundleMesh {
    readonly material: number;
    readonly vertexOffset: number;
    readonly vertexCount: number;
    readonly indexOffset: number;
    readonly indexCount: number;
}

export interface BundleLight {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    /** Luminous flux. The runtime converts to candela the way meep documents. */
    readonly lumens: number;
    /** Cutoff radius -- how far the light reaches, in scene metres. */
    readonly radius: number;
    /**
     * How big the emitter itself is, in scene metres.
     *
     * A separate quantity from `radius` and not a subdivision of it: this one
     * is the sphere the light *is*, and it decides how hard the light looks
     * rather than how far it carries. Derived from the emitting surface for a
     * surface light and fixed for a fitted one; see `sourceRadiusOf` and
     * `GRID_SOURCE_RADIUS` in the pipeline, and `applyLightVolumes` for why the
     * runtime cannot simply put it on the `Light` component.
     */
    readonly sourceRadius: number;
    /**
     * Linear RGB, brightest channel 1, or absent.
     *
     * Surface lights have no colour of their own -- a `q3map_surfacelight` is a
     * scalar -- so those omit it and the runtime uses its tungsten default.
     * Lightgrid lights do have one, because q3map2 baked the colour of whatever
     * lit each cell, and a room lit red in Q3 should be lit red here.
     */
    readonly color?: readonly [number, number, number] | number[];
    /**
     * Index into `materials` of the surface this light was reconstructed out
     * of, or absent on a light fitted to the lightgrid.
     *
     * The mirror of `color`: between the two, every light says which of the two
     * reconstruction routes made it. The runtime does not read it -- it is here
     * so the bundle can be checked against itself, because a material's
     * emissive luminance is its lights' flux over its area and nothing else
     * records that pairing. See D-093 and D-105.
     */
    readonly material?: number;
}

export interface BundleSun {
    readonly color: readonly [number, number, number] | number[];
    readonly intensity: number;
    readonly direction: readonly [number, number, number] | number[];
}

/** A BSP entity, with the origin already converted to meep axes. */
export interface BundleEntity extends Record<string, unknown> {
    readonly classname?: string;
    /** meep-space position. */
    readonly _origin: number[];
    /** Original Q3-space position, kept because the simulation runs in Q3 axes. */
    readonly _originQ3: number[];
    readonly _angle: number;
}

/**
 * One BSP model's mesh list.
 *
 * Model 0 is the world. Models 1..n are brush entities -- `func_door`,
 * `func_button`, `trigger_*` -- referenced from an entity's `model` key as the
 * string `*3`. Trigger volumes are `nodraw` and legitimately have no meshes at
 * all, which is why `meshes` being empty is not an error.
 */
export interface BundleSubmodel {
    readonly model: number;
    /** Indices into `SceneBundle.meshes`. */
    readonly meshes: readonly number[];
    readonly minsQ3: readonly number[];
    readonly maxsQ3: readonly number[];
    readonly numBrushes: number;
}

export interface SceneBundle {
    readonly name: string;
    readonly generator: string;
    readonly coordinateSystem: string;
    /** Scene units per Q3 unit. The simulation runs unscaled; this is presentation only. */
    readonly worldScale: number;
    readonly vertexStride: number;
    readonly vertexLayout: readonly string[];
    readonly vertexBytes: number;
    readonly indexBytes: number;
    readonly materials: readonly BundleMaterial[];
    /**
     * Texture key -> filename under `textures/`, or `null` if missing. The key is
     * a virtual path, plus `#<blend>` when the same image was written more than
     * one way; see {@link BundleMaterial.albedo}.
     */
    readonly textures: Readonly<Record<string, string | null>>;
    readonly meshes: readonly BundleMesh[];
    /** Absent in bundles written before movers existed. */
    readonly submodels?: readonly BundleSubmodel[];
    readonly lights: readonly BundleLight[];
    readonly sun: BundleSun | null;
    readonly entities: readonly BundleEntity[];
    readonly stats: Readonly<Record<string, number>>;
}

/* ------------------------------------------------------------------ *
 * Models.
 *
 * `tools/convert-models.ts` writes a single bundle holding every static prop --
 * pickups, ammo boxes, weapon world models. It reuses `BundleMaterial` and
 * `BundleMesh` verbatim so the runtime's geometry and material builders are
 * shared with the map loader rather than duplicated.
 *
 * Positions are in *Q3 units*, not scene metres. The simulation runs unscaled
 * (D-011) and an item's bounding box has to agree with `bg_itemlist`'s pickup
 * radius, so the scale is applied by the entity transform at spawn time.
 * ------------------------------------------------------------------ */

export interface BundleTag {
    readonly name: string;
    /** meep axes, Q3 units. */
    readonly origin: readonly number[];
}

export interface BundleModel {
    /** Virtual path as `bg_itemlist` names it, e.g. `models/powerups/health/medium_cross.md3`. */
    readonly name: string;
    readonly meshes: readonly BundleMesh[];
    readonly mins: readonly number[];
    readonly maxs: readonly number[];
    readonly radius: number;
    /** Frame-0 attachment points. Q3 hangs one model off another with these. */
    readonly tags: readonly BundleTag[];
}

export interface ModelBundle {
    readonly name: string;
    readonly generator: string;
    readonly coordinateSystem: string;
    readonly vertexStride: number;
    readonly vertexLayout: readonly string[];
    readonly vertexBytes: number;
    readonly indexBytes: number;
    readonly materials: readonly BundleMaterial[];
    readonly textures: Readonly<Record<string, string | null>>;
    readonly models: readonly BundleModel[];
    readonly stats: Readonly<Record<string, number>>;
}
