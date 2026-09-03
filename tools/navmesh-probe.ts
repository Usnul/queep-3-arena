/*
 * navmesh-probe.ts -- getting a Quake III level into meep's navmesh.
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
 * meep ships a real navmesh: `NavigationMesh` builds a walkable surface from a
 * `BinaryTopology` and `find_path` returns the exact any-angle geodesic across
 * it (Polyanya). This port does not use it. This tool is why, and it is written
 * to be run rather than believed, because my first two answers were both wrong.
 *
 * **First answer, wrong.** I fed the brush solids in, got 5% of spawn pairs
 * routable, grid-snapped the coordinates, got 5% again, and concluded the
 * package had no way to repair arbitrary geometry. It has an extensive one --
 * `bt_merge_vertices_by_distance`, `bt_mesh_fuse_duplicate_edges`,
 * `bt_mesh_resolve_t_junctions`, `bt_mesh_kill_degenerate_faces`,
 * `bt_mesh_compact`, and validation to check the result -- and
 * `bt_mesh_resolve_t_junctions`'s own docblock spells out the order to call
 * them in. My grid-snap was a bad substitute for a tool that was already there.
 *
 * **Second answer, also wrong.** Running the real repair on the brush solids
 * changes nothing: 5% before, 5% after, and `bt_mesh_resolve_t_junctions`
 * reports *zero* splits. That is not a failure of the tool. It splits
 * **boundary** edges -- ones with exactly one face -- and a soup of closed
 * convex solids has none. Every edge already has two faces, because every brush
 * is a sealed box.
 *
 * **What was actually missing** is upstream of any of that: a navmesh wants a
 * *surface* and a Quake III map is a set of interpenetrating *volumes*. A floor
 * brush is not a floor; it is a box whose top happens to be one, with the wall
 * brush beside it buried in its side. Extracting the surface takes two filters,
 * both of them Q3's own numbers -- `MIN_WALK_NORMAL` for "is this a floor" and
 * `pointContents` for "is this buried" -- and it moves the result from 5% to
 * 48%.
 *
 * **What is still missing**, and is the honest gap, is that welding cannot union
 * overlapping coplanar patches. Two floor brushes that overlap contribute two
 * surfaces occupying the same space; they do not abut, so no amount of vertex
 * merging joins them. The extracted surface starts as ~100 islands, and while
 * the builder bridges them well, it cannot invent connectivity that is not
 * there. That step is a boolean union, or the voxel rasterisation Recast uses
 * to sidestep needing one.
 *
 * The baseline at the end is the point. A waypoint graph built by *tracing* --
 * asking the collision system "can a player box get from here to there" -- routes
 * 100% of the same spawn pairs, because a trace does not care whether the world
 * is one surface or a hundred overlapping ones. For brush-based level geometry,
 * the collision query is a better source of navigation connectivity than the
 * geometry is.
 *
 * Usage:  node tools/navmesh-probe.ts [<mapname>...]
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BspFile } from '../src/q3/bsp/BspFile.ts';
import { ClipMap, CONTENTS, MASK_PLAYERSOLID } from '../src/q3/cm/ClipMap.ts';
import { buildHulls } from '../src/q3/cm/brushHull.ts';
import { pointContents, boxTrace, createTrace } from '../src/q3/cm/trace.ts';
import { buildWaypoints, linkMapPortals, type TraceLike } from '../src/game/Waypoints.ts';

import { BinaryTopology } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/BinaryTopology.js';
import { bt_mesh_from_indexed_geometry } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/io/bt_mesh_from_indexed_geometry.js';
import { bt_merge_vertices_by_distance } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/io/vertex/bt_merge_vertices_by_distance.js';
import { bt_mesh_fuse_duplicate_edges } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/io/edge/bt_mesh_fuse_duplicate_edges.js';
import { bt_mesh_resolve_t_junctions } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/io/bt_mesh_resolve_t_junctions.js';
import { bt_mesh_kill_degenerate_faces } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/io/face/bt_mesh_kill_degenerate_faces.js';
import { bt_mesh_triangulate } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/io/bt_mesh_triangulate.js';
import { bt_mesh_compact } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/io/bt_mesh_compact.js';
import { bt_mesh_is_manifold } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/query/bt_mesh_is_manifold.js';
import { bt_mesh_compute_face_islands } from '@woosh/meep-engine/src/core/geom/3d/topology/struct/binary/query/bt_mesh_compute_face_islands.js';
import { NavigationMesh } from '@woosh/meep-engine/src/engine/navigation/mesh/NavigationMesh.js';
import Vector3 from '@woosh/meep-engine/src/core/geom/Vector3.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = join(ROOT, 'assets', 'built');

/** Q3's own player dimensions, so the agent is the thing that has to fit. */
const AGENT = {
    agent_radius: 15,
    agent_height: 56,
    agent_max_step_height: 18,
    // Wider than Q3's own step, because the extracted surface has real gaps at
    // brush boundaries and this is the setting that bridges them. Measured: 8
    // gives 45%, 32 gives 48%, 64 gives 48%.
    agent_max_step_distance: 32,
    // `MIN_WALK_NORMAL` is 0.7, which is 45.6 degrees.
    agent_max_climb_angle: (45.6 * Math.PI) / 180,
};

/**
 * Weld tolerance, in Q3 units.
 *
 * Q3 brush vertices are reconstructed by a plane clipper, so a corner two
 * brushes share is arrived at by different arithmetic on each side and lands a
 * few ULPs apart -- which is exactly the case `bt_mesh_vertex_merge_distance`
 * warns about, where a tolerance below the float32 step silently degenerates
 * into an exact-bits match and leaves the surface cracked. A tenth of a unit is
 * three millimetres: far below anything a designer placed, far above the noise.
 */
const WELD = 0.1;
const T_JUNCTION = 0.1;

/** `MIN_WALK_NORMAL` from `bg_public.h` -- Q3's own "is this a floor" test. */
const MIN_WALK_NORMAL = 0.7;

interface Built {
    readonly mesh: BinaryTopology;
    readonly triangles: number;
    readonly note?: string;
}

function fromIndexed(positions: number[], indices: number[]): BinaryTopology {
    const mesh = new BinaryTopology();
    bt_mesh_from_indexed_geometry(mesh, new Uint32Array(indices), new Float32Array(positions));
    return mesh;
}

/** Every triangle of every solid brush: the level as sealed boxes. */
function fromBrushes(cm: ClipMap): Built {
    const world = cm.models[0]!;
    const set = buildHulls(cm, MASK_PLAYERSOLID, world.firstBrush, world.numBrushes);

    const positions: number[] = [];
    const indices: number[] = [];

    for (const hull of set.hulls) {
        const base = positions.length / 3;
        for (let i = 0; i < hull.vertices.length; i++) positions.push(hull.vertices[i]!);
        for (const index of hull.indices) indices.push(base + index);
    }

    return { mesh: fromIndexed(positions, indices), triangles: indices.length / 3 };
}

/** The converted render geometry of BSP model 0, back in Q3 axes. */
function fromSurfaces(scene: any, geometryPath: string): Built {
    const bin = readFileSync(geometryPath);
    const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);

    const vertices = new Float32Array(buffer, 0, scene.vertexBytes / 4);
    const sourceIndices = new Uint32Array(buffer, scene.vertexBytes, scene.indexBytes / 4);
    const stride = scene.vertexStride;

    const positions: number[] = [];
    const indices: number[] = [];

    for (const meshIndex of scene.submodels[0].meshes) {
        const mesh = scene.meshes[meshIndex];
        const base = positions.length / 3;

        for (let i = 0; i < mesh.vertexCount; i++) {
            const o = (mesh.vertexOffset + i) * stride;
            // meep (x, z, -y) -> Q3 (x, -z, y).
            positions.push(vertices[o]!, -vertices[o + 2]!, vertices[o + 1]!);
        }

        for (let i = 0; i < mesh.indexCount; i++) {
            indices.push(base + sourceIndices[mesh.indexOffset + i]!);
        }
    }

    return { mesh: fromIndexed(positions, indices), triangles: indices.length / 3 };
}

/**
 * The walkable *surface*, extracted from the solids.
 *
 * Two filters, both Q3's own: a triangle is a floor when its normal's Z clears
 * `MIN_WALK_NORMAL`, the same 0.7 `PM_GroundTrace` uses; and it is real when
 * `pointContents` says the space just above it is not solid, which drops the
 * undersides and the faces buried inside neighbouring brushes.
 */
function fromWalkableFaces(cm: ClipMap): Built {
    const world = cm.models[0]!;
    const set = buildHulls(cm, MASK_PLAYERSOLID, world.firstBrush, world.numBrushes);

    const positions: number[] = [];
    const indices: number[] = [];

    let steep = 0;
    let buried = 0;

    for (const hull of set.hulls) {
        const v = hull.vertices;

        for (let t = 0; t < hull.indices.length; t += 3) {
            const a = hull.indices[t]! * 3;
            const b = hull.indices[t + 1]! * 3;
            const c = hull.indices[t + 2]! * 3;

            const ux = v[b]! - v[a]!, uy = v[b + 1]! - v[a + 1]!, uz = v[b + 2]! - v[a + 2]!;
            const wx = v[c]! - v[a]!, wy = v[c + 1]! - v[a + 1]!, wz = v[c + 2]! - v[a + 2]!;

            const nx = uy * wz - uz * wy;
            const ny = uz * wx - ux * wz;
            const nz = ux * wy - uy * wx;

            const length = Math.hypot(nx, ny, nz);
            if (length < 1e-6) continue;

            if (nz / length < MIN_WALK_NORMAL) { steep += 1; continue; }

            const mx = (v[a]! + v[b]! + v[c]!) / 3;
            const my = (v[a + 1]! + v[b + 1]! + v[c + 1]!) / 3;
            const mz = (v[a + 2]! + v[b + 2]! + v[c + 2]!) / 3;

            if ((pointContents(cm, mx, my, mz + 2) & CONTENTS.SOLID) !== 0) { buried += 1; continue; }

            const base = positions.length / 3;
            positions.push(
                v[a]!, v[a + 1]!, v[a + 2]!,
                v[b]!, v[b + 1]!, v[b + 2]!,
                v[c]!, v[c + 1]!, v[c + 2]!
            );
            indices.push(base, base + 1, base + 2);
        }
    }

    return {
        mesh: fromIndexed(positions, indices),
        triangles: indices.length / 3,
        note: `${steep} too steep, ${buried} buried`,
    };
}

/**
 * The repair sequence, in the order `bt_mesh_resolve_t_junctions` prescribes:
 * merge, fuse, resolve, fuse again. The second fuse does the joining -- a split
 * lands on the offending vertex, leaving two halves that duplicate edges the
 * neighbour already owns, and fusing those is what makes the faces adjacent.
 */
function repair(mesh: BinaryTopology): string[] {
    const lines: string[] = [];

    bt_mesh_triangulate(mesh);
    lines.push(`merged ${bt_merge_vertices_by_distance(mesh, WELD)} vertices at ${WELD}u`);
    lines.push(`fused ${bt_mesh_fuse_duplicate_edges(mesh)} edges`);
    lines.push(`split ${bt_mesh_resolve_t_junctions(mesh, T_JUNCTION)} T-junctions`);
    lines.push(`fused ${bt_mesh_fuse_duplicate_edges(mesh)} more edges`);
    lines.push(`killed ${bt_mesh_kill_degenerate_faces(mesh)} degenerate faces`);

    bt_mesh_compact(mesh);
    lines.push(`manifold: ${bt_mesh_is_manifold(mesh)}`);

    return lines;
}

function islands(mesh: BinaryTopology): string {
    const sizes = bt_mesh_compute_face_islands(mesh).map((i) => i.length).sort((a, b) => b - a);
    const total = sizes.reduce((a, b) => a + b, 0);
    const largest = sizes[0] ?? 0;
    const percent = total === 0 ? 0 : (100 * largest) / total;

    return `${sizes.length} islands over ${total} faces, largest ${largest} (${percent.toFixed(0)}%)`;
}

function routable(mesh: BinaryTopology, spawns: number[][]): string {
    const navmesh = new NavigationMesh();

    const t0 = performance.now();
    try {
        /*
         No cast. Until meep 3.14.6 the generated `.d.ts` typed `build`'s
         *options object* as `BinaryTopology` -- the JSDoc put
         `@param {BinaryTopology} source` on a destructured parameter and the
         generator hoisted that type onto the whole object, so the only way to
         call it from TypeScript was to lie about the argument. 3.14.6 emits the
         real object type and the workaround became the error. GAP-001's family,
         one member smaller.
        */
        navmesh.build({ source: mesh, up: new Vector3(0, 0, 1), ...AGENT });
    } catch (e) {
        return `build failed: ${(e as Error).message}`;
    }
    const buildMs = performance.now() - t0;

    const out = new Float32Array(4096 * 3);
    let routed = 0;
    let pairs = 0;
    let threw = 0;

    for (let i = 0; i < spawns.length; i++) {
        for (let j = 0; j < spawns.length; j++) {
            if (i === j) continue;
            pairs += 1;

            try {
                const written = navmesh.find_path(
                    out,
                    spawns[i]![0]!, spawns[i]![1]!, spawns[i]![2]!,
                    spawns[j]![0]!, spawns[j]![1]!, spawns[j]![2]!
                );
                if (written > 0) routed += 1;
            } catch {
                /*
                 An unrepaired mesh can make Polyanya read a released vertex and
                 throw from four frames deep rather than report no path. Counted
                 rather than propagated, so one bad input does not end the run.
                */
                threw += 1;
            }
        }
    }

    const percent = pairs === 0 ? 0 : (100 * routed) / pairs;

    return (
        `${String(routed).padStart(3)}/${pairs} routable (${percent.toFixed(0)}%), ` +
        `built in ${buildMs.toFixed(0)} ms, navmesh ${islands(navmesh.topology)}` +
        (threw > 0 ? `, ${threw} threw` : '')
    );
}

/** The shipped waypoint graph, measured on the identical metric. */
function waypointBaseline(cm: ClipMap, scene: any, spawns: number[][]): string {
    const trace: TraceLike = (start, mins, maxs, end, mask) => {
        const out = createTrace();
        boxTrace(out, cm, start, end, mins, maxs, mask);
        return out;
    };

    const graph = buildWaypoints(scene.submodels[0], trace);
    linkMapPortals(graph, scene.entities, scene.submodels);

    const nodes = spawns.map((s) => graph.nearestReachable(s));

    let routed = 0;
    let pairs = 0;

    for (let i = 0; i < nodes.length; i++) {
        for (let j = 0; j < nodes.length; j++) {
            if (i === j) continue;
            pairs += 1;
            if (graph.path(nodes[i]!, nodes[j]!).length > 0) routed += 1;
        }
    }

    const percent = pairs === 0 ? 0 : (100 * routed) / pairs;
    return `${String(routed).padStart(3)}/${pairs} routable (${percent.toFixed(0)}%)`;
}

function main(): void {
    const maps = process.argv.slice(2);
    const names = maps.length > 0 ? maps : ['oa_dm1', 'aggressor'];

    console.log(
        'Building meep NavigationMesh from Q3 level geometry.\n' +
        'The measure is spawn-to-spawn routability: every ordered pair of\n' +
        'info_player_deathmatch points that find_path can connect.\n'
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

        const spawns: number[][] = scene.entities
            .filter((e: { classname?: string }) => e.classname === 'info_player_deathmatch')
            .map((e: { _originQ3: number[] }) => e._originQ3);

        console.log(`${name} — ${spawns.length} spawn points\n`);

        const sources: [string, () => Built][] = [
            ['solid brushes', () => fromBrushes(cm)],
            ['render surfaces', () => fromSurfaces(scene, join(dir, 'geometry.bin'))],
            ['walkable faces', () => fromWalkableFaces(cm)],
        ];

        for (const [label, make] of sources) {
            const built = make();
            console.log(
                `  ${label} — ${built.triangles} triangles` +
                (built.note === undefined ? '' : ` (${built.note})`)
            );
            console.log(`    as given   ${islands(built.mesh)}`);
            console.log(`               ${routable(built.mesh, spawns)}`);

            const rebuilt = make();
            const lines = repair(rebuilt.mesh);
            console.log(`    repaired   ${lines.join('; ')}`);
            console.log(`               ${islands(rebuilt.mesh)}`);
            console.log(`               ${routable(rebuilt.mesh, spawns)}`);
            console.log('');
        }

        console.log(`  waypoint graph (what this port ships)`);
        console.log(`               ${waypointBaseline(cm, scene, spawns)}\n`);
    }
}

main();
