/*
 * Shadows.ts -- which lights cast, and the one place that decides.
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
 * Four places in this port create a light -- the map's emitters and its sun in
 * `loadMap`, the explosion flash and the muzzle flash in `Effects` -- and until
 * now each of them answered "does this cast a shadow?" for itself, in a comment,
 * permanently. Three said no and the sun said yes.
 *
 * A setting cannot live in four comments, so it lives here. The question is
 * asked in one of two shapes, depending on how long the light lives:
 *
 *   - `casts(role)` for a light that will not outlive the answer. An explosion
 *     flash is 90 ms and a muzzle flash is 50 ms, and a match produces thousands
 *     of them; a registry that held those would be a leak, and a setting changed
 *     while one is on screen cannot matter to something with six frames left.
 *   - `follow(light, role)` for a light that outlives the menu. The map's are
 *     built once at load and live as long as the level does, so they are kept
 *     and rewritten whenever the mode moves. Nothing unregisters, because
 *     nothing unloads a map -- `?map=` is read at startup and changing it means
 *     a reload.
 *
 * ---
 *
 * **Three engine facts this rests on**, each checked in the package rather than
 * assumed, because the failure mode of each is a setting that appears to work
 * and does not.
 *
 * `Light.castShadow` is an `ObservedBoolean`, and `LightSystem3.link` puts it in
 * the `observed_properties` it binds a `refresh` to -- alongside colour,
 * intensity, angle, penumbra and distance. So writing the component copies the
 * flag onto Shade's own light and raises `scene.lights.needsUpdate`, which is
 * what the collection needs in order to re-publish the GPU light table. That is
 * the front door, and it is why the flag is written on the ECS component rather
 * than on Shade's light the way `applyLightVolumes` has to write `radius`
 * (GAP-030): a light changed *there* is overwritten by the next `refresh`.
 *
 * `GPUSceneShadowmapContext.process_lights` runs every frame from
 * `GPULightCollection.update`, "including frames where `LightCollection.version`
 * hasn't moved -- `light.casts_shadow` flips are not tracked by version and are
 * detected here". So a light that starts casting is allocated an atlas rect and
 * its face views on the next frame, and one that stops has them reclaimed.
 * Nothing on this side has to invalidate anything by hand.
 *
 * `Renderer.feature_shadows_enabled` is the master switch, and 3.6.0 is the
 * first version an application can reach it in: `GraphicsEngine3` grew a
 * `renderer` getter -- "Danger zone. Be careful with what you do" -- which is
 * what GAP-024 asked for and did not have when the graphics page was written.
 * With it false the shadow context "treat[s] every map as evictable", so `off`
 * costs nothing rather than merely showing nothing.
 *
 * ---
 *
 * **What `all` costs, since the menu has to say something honest about it.**
 *
 * A directional light is `SHADOWMAP_CSM_CASCADE_COUNT` views and is refreshed
 * unconditionally every frame; a point light is a cube, which is six views, or
 * four on the tetrahedral path. The per-frame refresh budget is 32 views, so the
 * arenas -- 28 lights on `oa_dm1`, 82 on `aggressor`, 325 on `am_thornish` --
 * cannot all refresh in one frame and are not meant to.
 * `compute_shadowmap_update_score` scores a local light by
 * `projected_area_px * (1 + staleness)`: one that is off-screen projects to zero
 * area and is not redrawn at all, one that has just appeared gets a staleness
 * bonus large enough to jump the queue, and the rest take turns by how much of
 * the screen they cover. The atlas is 8192 square against a 128-pixel local map,
 * which is room for far more lights than any of these maps has.
 *
 * So the cost of `all` is not "325 cube maps a frame". It is the handful of
 * lights the player can currently see, refreshed in the order they matter, over
 * a static shadow for everything else that holds until something moves.
 */

/**
 * Which lights cast, cheapest first.
 *
 * Three values rather than a toggle, because the three have genuinely different
 * costs and the middle one is what this port shipped before there was a choice:
 * the shadowing q3map2 baked is already in the lightmaps, so the sun was the one
 * light that had to cast for an arena to read as lit.
 */
export type ShadowMode = 'off' | 'sun' | 'all';

/** In menu order, which is cheapest first. */
export const SHADOW_MODES: readonly ShadowMode[] = ['off', 'sun', 'all'];

/**
 * The sun casts, and the map's own fixtures do not.
 *
 * The middle mode, and it was the expensive one for a while: a converted map's
 * lights are reconstructed fixtures standing where the level's own lamps are,
 * and having them throw shadows is the difference between a room lit by a
 * renderer and a room lit by its light fittings, which is a good enough picture
 * to have been worth defaulting to.
 *
 * What decides it the other way is how many of them there are and what they are.
 * A Q3 arena is lit by dozens of fixtures per room, all local, all of them
 * shadow maps in one atlas whose size is a module-private constant, and the
 * shadows they throw are short and mostly land on the geometry that already
 * occludes them. The sun is the one light whose shadow is a shape a player reads
 * -- the long edge across a courtyard -- and it is one light. So the mode that
 * keeps the shadow worth having and drops the several dozen that mostly cost is
 * the default, and `all` is a click away for anyone with the frame rate to spend
 * on it. See D-128.
 */
export const SHADOW_MODE_DEFAULT: ShadowMode = 'sun';

/**
 * What a light is for, which is the whole of what decides whether it casts.
 *
 * `world` is a fixture the map put there, `effect` is a flash a weapon made, and
 * `sun` is the one directional light a map may have.
 */
export type LightRole = 'sun' | 'world' | 'effect';

/**
 * The part of meep's `Light` component this writes.
 *
 * Structural rather than the class, so the policy can be exercised in Node
 * against a stand-in -- the same reason `GraphicsHost` and `ShadeLightLike` are
 * declared this way. Nothing here is optional in the engine.
 */
export interface ShadowCaster {
    readonly castShadow: { set(value: boolean): unknown; getValue(): boolean };
}

/**
 * The part of `GraphicsEngine3` this reaches, and the only part.
 *
 * Read through the facade on every write rather than held, so that a renderer
 * replaced by a `stop()`/`start()` -- which is what recovering a lost GPU
 * context does -- is the one the next write lands on.
 */
export interface ShadowRendererHost {
    readonly renderer: { feature_shadows_enabled: boolean } | null;
}

/** What a light source asks before it sets its own flag. */
export interface ShadowPolicy {
    casts(role: LightRole): boolean;
}

/**
 * The answer a light source gets when nobody has handed it a policy.
 *
 * Which is `false`, because that is the flag every effect light carried before
 * there was a setting: a caller that does not opt in keeps what it had.
 */
export const NO_SHADOWS: ShadowPolicy = { casts: () => false };

/** The mode this is, or null for a string that is not one. */
export function asShadowMode(raw: unknown): ShadowMode | null {
    for (const mode of SHADOW_MODES) {
        if (raw === mode) return mode;
    }

    return null;
}

/**
 * The live shadow mode, and everything that has to be told when it moves.
 *
 * One instance for the whole application, built before the map is loaded so that
 * the map's lights can be handed to it as they are built.
 */
export class Shadows implements ShadowPolicy {
    private readonly host: ShadowRendererHost | null;

    /** The long-lived lights, and what each is for. See the file header. */
    private readonly followed: { light: ShadowCaster; role: LightRole }[] = [];

    private current: ShadowMode;

    /**
     * @param host the graphics facade, for the renderer's master switch. Null is
     *     legal and means the per-light flags are the whole of the policy, which
     *     is the shape a test and a headless run both want.
     */
    constructor(host: ShadowRendererHost | null = null, mode: ShadowMode = SHADOW_MODE_DEFAULT) {
        this.host = host;
        this.current = mode;
    }

    get mode(): ShadowMode {
        return this.current;
    }

    /** How many lights are being kept in step. For the load-time log line. */
    get followedCount(): number {
        return this.followed.length;
    }

    /**
     * Whether a light of this role casts, under the mode as it stands.
     *
     * The sun casts in every mode but `off`: it is one light, its cascades are
     * refreshed unconditionally either way, and it is the one drawing the
     * shadows a Q3 arena reads by.
     */
    casts(role: LightRole): boolean {
        if (this.current === 'off') return false;
        if (role === 'sun') return true;

        return this.current === 'all';
    }

    /**
     * Set this light's flag now, and again on every later change of mode.
     *
     * For lights that outlive the menu. Returns the light, so a caller building
     * one can wrap the call around it.
     */
    follow<T extends ShadowCaster>(light: T, role: LightRole): T {
        this.followed.push({ light, role });
        light.castShadow.set(this.casts(role));

        return light;
    }

    /** `follow` for a collection of lights that share a role. */
    followAll(lights: Iterable<ShadowCaster>, role: LightRole): void {
        for (const light of lights) this.follow(light, role);
    }

    /**
     * Change the mode, and push it at the renderer and at every followed light.
     *
     * Ignores a mode it does not have rather than throwing: this is reached from
     * a `<select>` and from whatever a previous build left in storage, and the
     * rule there is `coerce`'s -- an unreadable stored value means keep what you
     * have, not fail to open the screen. Returns whether anything moved.
     */
    setMode(raw: unknown): boolean {
        const mode = asShadowMode(raw);
        if (mode === null || mode === this.current) return false;

        this.current = mode;
        this.apply();

        return true;
    }

    /** Push the current mode at everything, whether or not it has moved. */
    apply(): void {
        /*
         Through the facade each time -- see `ShadowRendererHost`. `renderer` is
         3.6.0's getter, and although it is *typed* as returning a `Renderer` its
         own docblock says `Renderer|null`, which is what it is before the engine
         has started.
        */
        const renderer = this.host?.renderer ?? null;

        if (renderer !== null) {
            renderer.feature_shadows_enabled = this.current !== 'off';
        }

        for (const entry of this.followed) {
            entry.light.castShadow.set(this.casts(entry.role));
        }
    }
}
