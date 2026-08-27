/*
 * acoustics.test.ts -- the two claims the acoustic wiring rests on that nothing
 * else would notice going wrong.
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
 * Both of these fail *quietly*, which is the whole reason they are here. An
 * acoustic simulation has no correct output to compare against -- a room that
 * is wrong just sounds like a different room -- so the failures worth catching
 * are the ones that leave a running game with plausible sound and the wrong
 * model behind it.
 *
 * **Which brushes block sound.** The physics bodies are built for
 * `MASK_PLAYERSOLID`, which includes the `PLAYERCLIP` fences that keep players
 * off ledges and are not there in any visible sense. `occludesSound` is the one
 * line that keeps those from becoming audible walls in open air, and inverting
 * it produces a level that plays correctly and muffles rockets behind nothing.
 *
 * **That the probe field survives the round trip.** meep's serializer
 * deliberately drops the visibility graph and the reflector lobes -- they are
 * functions of the geometry, not of the probes -- so "some of the field is
 * missing after loading" is the *expected* state and cannot be used as the
 * signal that something went wrong. What must survive is every probe's position
 * and per-band RT60, exactly, because a field that reloads with the right count
 * and drifted numbers is indistinguishable from a map that really is that dead.
 */

import { describe, expect, it } from 'vitest';

import { AcousticProbeField } from '@woosh/meep-engine/src/engine/sound/simulation/probe/AcousticProbeField.js';

import { CONTENTS } from '../src/q3/cm/ClipMap.ts';
import {
    PROBE_MAX_RT60,
    Q3_SURFACE,
    decodeProbeField,
    encodeProbeField,
    occludesSound,
} from '../src/client/Acoustics.ts';

describe('what blocks sound', () => {
    it('is a solid brush', () => {
        expect(occludesSound(CONTENTS.SOLID)).toBe(true);
    });

    it('is not a playerclip fence, which a rocket also flies through', () => {
        expect(occludesSound(CONTENTS.PLAYERCLIP)).toBe(false);
    });

    it('is a brush that is both, because it is still a wall', () => {
        expect(occludesSound(CONTENTS.SOLID | CONTENTS.PLAYERCLIP)).toBe(true);
    });

    it('is nothing at all for the volumes that are only gameplay', () => {
        for (const contents of [CONTENTS.WATER, CONTENTS.LAVA, CONTENTS.TRIGGER, 0]) {
            expect(occludesSound(contents)).toBe(false);
        }
    });
});

describe('the acoustic material a Q3 brush gets', () => {
    /*
     Not a taste check -- the number itself is a judgement and the docblock
     argues for it. What is testable is the property the judgement was made to
     hold: a fully occluded source keeps *some* level, because
     `EventInstance.setAcoustic` uses transmission as that floor and Quake III
     has no occlusion at all to lose the information to.
    */
    it('lets a fully occluded sound through, rather than silencing it', () => {
        for (let band = 0; band < 3; band++) {
            expect(Q3_SURFACE.transmission[band]).toBeGreaterThan(0);
        }
    });

    it('lets less of it through the higher the band, so a wall muffles', () => {
        expect(Q3_SURFACE.transmission[0]!).toBeGreaterThan(Q3_SURFACE.transmission[1]!);
        expect(Q3_SURFACE.transmission[1]!).toBeGreaterThan(Q3_SURFACE.transmission[2]!);
    });

    it('absorbs more the higher the band, as a hard surface does', () => {
        expect(Q3_SURFACE.absorption[0]!).toBeLessThan(Q3_SURFACE.absorption[1]!);
        expect(Q3_SURFACE.absorption[1]!).toBeLessThan(Q3_SURFACE.absorption[2]!);
    });
});

describe('a baked probe field', () => {
    /**
     * A field with the awkward values in it: a probe at the origin, one at
     * negative coordinates, a silent probe and a probe at the RT60 ceiling.
     */
    function sample(): AcousticProbeField {
        const field = new AcousticProbeField();

        const probes: readonly (readonly [number, number, number, number, number, number])[] = [
            [0, 0, 0, 0, 0, 0],
            [-12.5, 3.25, -44.75, 1.5, 0.9, 0.4],
            [37, -8, 10.5, PROBE_MAX_RT60, PROBE_MAX_RT60, PROBE_MAX_RT60],
            [1.125, 2.25, 3.375, 0.07, 2.58, 1.4],
        ];

        const directions = new Float32Array(9);

        for (let i = 0; i < probes.length; i++) {
            const [x, y, z, low, mid, high] = probes[i]!;

            field.setProbePosition(i, x, y, z);
            field.setProbeReverbDecay(i, low, mid, high);

            // a distinct unit-ish direction per band, so a band swap is visible
            for (let k = 0; k < 9; k++) directions[k] = (i + 1) * (k + 1) * 0.0625;
            field.setProbeReverbDirections(i, directions);
        }

        return field;
    }

    it('comes back from its own bytes unchanged', () => {
        const baked = sample();
        const bytes = encodeProbeField(baked);

        const reloaded = decodeProbeField(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        );

        expect(reloaded.size).toBe(baked.size);

        const a = new Float32Array(9);
        const b = new Float32Array(9);

        for (let i = 0; i < baked.size; i++) {
            // exactly, not approximately: the format is float32 on both sides,
            // so anything that moves at all has been transformed on the way.
            expect(reloaded.probeX(i)).toBe(baked.probeX(i));
            expect(reloaded.probeY(i)).toBe(baked.probeY(i));
            expect(reloaded.probeZ(i)).toBe(baked.probeZ(i));

            for (let band = 0; band < 3; band++) {
                expect(reloaded.reverbBand(i, band)).toBe(baked.reverbBand(i, band));

                baked.reverbDirection(i, band, a);
                reloaded.reverbDirection(i, band, b);
                expect(Array.from(b)).toEqual(Array.from(a));
            }
        }
    });

    it('writes exactly the bytes it needs and no trailing slack', () => {
        /*
         `encodeProbeField` hands back the buffer's raw bytes after `trim`, and
         those are what get written to disk. An untrimmed buffer would ship its
         geometric growth slack -- harmless to read back, and silently inflating
         every map's file.

         15 float32s per probe (position, per-band RT60, per-band direction)
         plus the leading varint count.
        */
        const field = sample();
        const bytes = encodeProbeField(field);

        expect(bytes.byteLength).toBe(1 + field.size * 15 * 4);
    });

    it('is empty, not broken, when there was nothing to bake', () => {
        const bytes = encodeProbeField(new AcousticProbeField());

        const reloaded = decodeProbeField(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        );

        expect(reloaded.size).toBe(0);
    });

    it('loads without the visibility graph, which is what the runtime expects', () => {
        /*
         Stated as a test because it is a *decision* rather than an omission: the
         graph is what corner-leak pathing walks, re-deriving it costs what the
         whole bake costs, and `AcousticSimulator.apply` gates pathing on
         `hasVisibility` so a field without one is a supported state rather than
         a broken one. If a later meep starts serializing it, this test failing
         is the notice that pathing became affordable.
        */
        const bytes = encodeProbeField(sample());

        const reloaded = decodeProbeField(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        );

        expect(reloaded.hasVisibility).toBe(false);
        expect(reloaded.hasTransfer).toBe(false);
    });
});
