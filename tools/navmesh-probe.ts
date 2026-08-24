/*
 * navmesh-probe.ts -- can meep's navmesh take a Quake III level?
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
 * This exists because the answer is "no", and a claim like that in an
 * engineering report should be reproducible in one command rather than
 * asserted.
 *
 * meep ships a real navmesh: `NavigationMesh` builds a walkable surface from a
 * `BinaryTopology` with agent radius, height, step height and climb angle, and
 * `find_path` returns the exact any-angle geodesic across it (Polyanya), turning
 * at corners and subdividing at face boundaries. It is better than the waypoint
 * graph this port ended up with, in every way except the one that matters:
 * getting a Q3 level into it.
 *
 * The builder wants a *manifold* surface -- a mesh whose triangles share
 * vertices along shared edges, so adjacency is a topological fact. A Quake III
 * map offers two representations and neither is one:
 *
 *   brushes   Each solid is a closed convex polyhedron with its own vertices.
 *             Two floor brushes that abut share a plane and a line segment, not
 *             endpoints -- so the topology sees two islands, and every doorway
 *             is a cliff.
 *
 *   surfaces  Render geometry is split per material and per BSP leaf, with
 *             duplicated vertices at every seam. Worse, not better: the seams
 *             are more numerous than the brush boundaries.
 *
 * The step that is missing is voxelise-and-rebuild -- Recast's rasterise,
 * region, contour, polygonise pipeline -- which turns arbitrary soup into a
 * manifold walkable surface. meep's builder begins after that step, and nothing
 * in the package performs it.
 *
 * Usage:  node tools/navmesh-probe.ts [<mapname>...]
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap, MASK_PLAYERSOLID } from '../src/q3/cm/ClipMap.ts';
import { buildHulls } from '../src/q3/cm/brushHull.ts';

import { BinaryTopology } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/BinaryTopology.js';
import { bt_mesh_from_indexed_geometry } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/io/bt_mesh_from_indexed_geometry.js';
import { NavigationMesh } from '@woosh/meep-engine/src/engine/navigation/mesh/NavigationMesh.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = join(ROOT, 'assets', 'built');

/** Q3's own player dimensions, so the agent is the thing that has to fit. */
const AGENT = {
    agent_radius: 15,
    agent_height: 56,
    agent_max_step_height: 18,
    agent_max_step_distance: 8,
    // `MIN_WALK_NORMAL` is 0.7, which is 45.6 degrees.
    agent_max_climb_angle: (45.6 * Math.PI) / 180,
};

interface Geometry {
    readonly positions: number[];
    readonly indices: number[];
    readonly label: string;
}

interface Probe {
    readonly label: string;
    readonly error?: string;
    readonly vertices?: number;
    readonly triangles?: number;
    readonly buildMs?: number;
    readonly routed?: number;
    readonly pairs?: number;
}

/** Solid brush hulls, welded to the given tolerance (0 to disable). */
function brushGeometry(cm: ClipMap, weldTo: number): Geometry {
    const world = cm.models[0];
    const set = buildHulls(cm, MASK_PLAYERSOLID, world.firstBrush, world.numBrushes);

    const positions = [];
    const indices = [];
    const weld = new Map();

    for (const hull of set.hulls) {
        const remap = [];
        const count = hull.vertices.length / 3;

        for (let i = 0; i < count; i++) {
            let x = hull.vertices[i * 3];
            let y = hull.vertices[i * 3 + 1];
            let z = hull.vertices[i * 3 + 2];

            if (weldTo > 0) {
                x = Math.round(x / weldTo) * weldTo;
                y = Math.round(y / weldTo) * weldTo;
                z = Math.round(z / weldTo) * weldTo;
            }

            const key = `${x},${y},${z}`;
            let at = weldTo > 0 ? weld.get(key) : undefined;

            if (at === undefined) {
                at = positions.length / 3;
                positions.push(x, y, z);
                if (weldTo > 0) weld.set(key, at);
            }

            remap.push(at);
        }

        for (const index of hull.indices) indices.push(remap[index]);
    }

    return { positions, indices, label: weldTo > 0 ? `brushes (welded to ${weldTo})` : 'brushes' };
}

/** The converted render geometry of BSP model 0, back in Q3 axes. */
function renderGeometry(scene: any, geometryPath: string): Geometry {
    const bin = readFileSync(geometryPath);
    const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);

    const vertices = new Float32Array(buffer, 0, scene.vertexBytes / 4);
    const sourceIndices = new Uint32Array(buffer, scene.vertexBytes, scene.indexBytes / 4);
    const stride = scene.vertexStride;

    const positions = [];
    const indices = [];

    for (const meshIndex of scene.submodels[0].meshes) {
        const mesh = scene.meshes[meshIndex];
        const base = positions.length / 3;

        for (let i = 0; i < mesh.vertexCount; i++) {
            const o = (mesh.vertexOffset + i) * stride;
            // meep (x, z, -y) -> Q3 (x, -z, y).
            positions.push(vertices[o], -vertices[o + 2], vertices[o + 1]);
        }

        for (let i = 0; i < mesh.indexCount; i++) {
            indices.push(base + sourceIndices[mesh.indexOffset + i]);
        }
    }

    return { positions, indices, label: 'render surfaces' };
}

function probe(geometry: Geometry, spawns: number[][]): Probe {
    const source = new BinaryTopology();
    bt_mesh_from_indexed_geometry(
        source,
        new Uint32Array(geometry.indices),
        new Float32Array(geometry.positions)
    );

    const navmesh = new NavigationMesh();

    const t0 = performance.now();
    try {
        /*
         Cast because the generated `.d.ts` types `build`'s *options object* as
         `BinaryTopology` -- the JSDoc puts `@param {BinaryTopology} source` on a
         destructured parameter and the generator hoists that type onto the whole
         object. So the documented call does not typecheck, and `source` is
         reported as an unknown property of the type it is a property of.
         Same defect on `navmesh_build_topology`. GAP-001's family.
        */
        navmesh.build({ source, up: new Vector3(0, 0, 1), ...AGENT } as unknown as BinaryTopology);
    } catch (e) {
        return { label: geometry.label, error: (e as Error).message };
    }
    const buildMs = performance.now() - t0;

    const out = new Float32Array(4096 * 3);
    let routed = 0;
    let pairs = 0;

    for (let i = 0; i < spawns.length; i++) {
        for (let j = 0; j < spawns.length; j++) {
            if (i === j) continue;
            pairs += 1;

            const written = navmesh.find_path(
                out,
                spawns[i][0], spawns[i][1], spawns[i][2],
                spawns[j][0], spawns[j][1], spawns[j][2]
            );

            if (written > 0) routed += 1;
        }
    }

    return {
        label: geometry.label,
        vertices: geometry.positions.length / 3,
        triangles: geometry.indices.length / 3,
        buildMs,
        routed,
        pairs,
    };
}

function main() {
    const maps = process.argv.slice(2);
    const names = maps.length > 0 ? maps : ['oa_dm1', 'aggressor'];

    console.log(
        'Probing meep NavigationMesh with Q3 level geometry.\n' +
        'The measure is spawn-to-spawn routability: every ordered pair of\n' +
        "info_player_deathmatch points that find_path can connect.\n"
    );

    for (const name of names) {
        const dir = join(BUILT, name);
        if (!existsSync(dir)) {
            console.log(`${name}: not built`);
            continue;
        }

        const scene = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8'));
        const raw = readFileSync(join(dir, 'collision.bsp'));
        const cm = new ClipMap(
            new BspFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), name)
        );

        const spawns = scene.entities
            .filter((e: { classname?: string }) => e.classname === 'info_player_deathmatch')
            .map((e: { _originQ3: number[] }) => e._originQ3);

        const attempts = [
            brushGeometry(cm, 0),
            brushGeometry(cm, 1),
            renderGeometry(scene, join(dir, 'geometry.bin')),
        ];

        console.log(`${name} (${spawns.length} spawn points)`);

        for (const geometry of attempts) {
            const result = probe(geometry, spawns);

            if (result.error !== undefined) {
                console.log(`  ${result.label.padEnd(26)} build failed: ${result.error}`);
                continue;
            }

            const routed = result.routed ?? 0;
            const pairs = result.pairs ?? 0;
            const percent = pairs === 0 ? 0 : (100 * routed) / pairs;
            console.log(
                `  ${result.label.padEnd(26)} ${String(result.triangles).padStart(6)} tris, ` +
                `${(result.buildMs ?? 0).toFixed(0).padStart(5)} ms build, ` +
                `${String(routed).padStart(3)}/${pairs} spawn pairs routable ` +
                `(${percent.toFixed(0)}%)`
            );
        }

        console.log('');
    }

    console.log(
        'For comparison, the waypoint graph this port ships routes 85% of\n' +
        'item-to-item pairs on oa_dm1 and 95% on aggressor. See GAP-016.'
    );
}

main();
