/*
 * oracle.ts -- typed wrapper around the WebAssembly pmove oracle.
 *
 * This file is part of queep-3-arena and is licensed GPLv2 (see LICENSE).
 *
 * ---
 *
 * The oracle is OpenArena's `bg_pmove.c` and ioquake3's `cm_*` compiled
 * unmodified to WASM (`oracle/build.mjs`). This module gives it a JavaScript
 * shape: load a BSP, poke a `playerState_t`, run `Pmove`, read the result.
 *
 * Struct layout is read from the module at load time via `oracle_offsets`
 * rather than hardcoded here, so a change to either upstream's structs shows up
 * as a moved offset rather than as silently misread memory.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORACLE_MJS = join(ROOT, 'oracle', 'build', 'oracle.mjs');

/** Fields in the order `oracle_offsets` emits them. */
const PS_FIELDS = [
    'commandTime', 'pm_type', 'bobCycle', 'pm_flags', 'pm_time',
    'origin', 'velocity', 'weaponTime', 'gravity', 'speed', 'delta_angles',
    'groundEntityNum', 'legsTimer', 'legsAnim', 'torsoTimer', 'torsoAnim',
    'movementDir', 'grapplePoint', 'eFlags', 'eventSequence', 'events',
    'eventParms', 'externalEvent', 'clientNum', 'weapon', 'weaponstate',
    'viewangles', 'viewheight', 'damageEvent', 'damageYaw', 'damagePitch',
    'damageCount', 'stats', 'persistant', 'powerups', 'ammo', 'generic1',
    'loopSound', 'jumppad_ent', 'pmove_framecount', 'jumppad_frame',
    'entityEventSequence',
] as const;

const CMD_FIELDS = [
    'serverTime', 'angles', 'buttons', 'weapon', 'forwardmove', 'rightmove', 'upmove',
] as const;

export type PsField = (typeof PS_FIELDS)[number];
export type CmdField = (typeof CMD_FIELDS)[number];

export interface OracleTrace {
    allsolid: boolean;
    startsolid: boolean;
    fraction: number;
    endpos: [number, number, number];
    planeNormal: [number, number, number];
    planeDist: number;
    surfaceFlags: number;
    contents: number;
    entityNum: number;
}

export interface PmResults {
    numtouch: number;
    watertype: number;
    waterlevel: number;
    framecount: number;
    mins: [number, number, number];
    maxs: [number, number, number];
    xyspeed: number;
}

interface WasmModule {
    HEAP32: Int32Array;
    HEAPU8: Uint8Array;
    HEAPF32: Float32Array;
    _malloc(n: number): number;
    _free(p: number): void;
    _oracle_load_bsp(ptr: number, len: number): number;
    _oracle_num_inline_models(): number;
    _oracle_box_trace(
        fout: number, iout: number, start: number, mins: number, maxs: number,
        end: number, mask: number
    ): void;
    _oracle_point_contents(p: number): number;
    _oracle_ps_ptr(): number;
    _oracle_cmd_ptr(): number;
    _oracle_ps_size(): number;
    _oracle_cmd_size(): number;
    _oracle_offsets(out: number): void;
    _oracle_offset_count(): number;
    _oracle_reset(): void;
    _oracle_pmove(
        tracemask: number, pmove_fixed: number, pmove_msec: number,
        noFootsteps: number, gauntletHit: number, pmove_float: number, pmove_flags: number
    ): void;
    _oracle_pm_results(iout: number, fout: number): void;
    _oracle_update_view_angles(): void;
}

export class Oracle {
    private readonly m: WasmModule;
    private readonly psPtr: number;
    private readonly cmdPtr: number;
    /** Byte offsets keyed by field name. */
    private readonly psOffset: Record<string, number> = {};
    private readonly cmdOffset: Record<string, number> = {};

    /** Scratch buffers, allocated once. */
    private readonly bufTrace: number;
    /** Flag fields, kept out of the float buffer -- see `oracle_box_trace`. */
    private readonly bufTraceI: number;
    private readonly bufV: number[] = [];
    private readonly bufResI: number;
    private readonly bufResF: number;

    readonly maxStats: number;
    readonly maxPersistant: number;
    readonly maxPowerups: number;
    readonly maxWeapons: number;
    readonly maxPsEvents: number;

    private constructor(m: WasmModule) {
        this.m = m;

        const n = m._oracle_offset_count();
        const op = m._malloc(n * 4);
        m._oracle_offsets(op);
        const offs = Array.from(m.HEAP32.subarray(op >> 2, (op >> 2) + n));
        m._free(op);

        let i = 0;
        for (const f of PS_FIELDS) this.psOffset[f] = offs[i++]!;
        for (const f of CMD_FIELDS) this.cmdOffset[f] = offs[i++]!;

        // Trailing sizes, in the order oracle.c emits them.
        i += 2; // playerState_t, usercmd_t sizes
        this.maxStats = offs[i++]!;
        this.maxPersistant = offs[i++]!;
        this.maxPowerups = offs[i++]!;
        this.maxWeapons = offs[i++]!;
        this.maxPsEvents = offs[i++]!;

        this.psPtr = m._oracle_ps_ptr();
        this.cmdPtr = m._oracle_cmd_ptr();

        this.bufTrace = m._malloc(10 * 4);
        this.bufTraceI = m._malloc(3 * 4);
        for (let k = 0; k < 4; k++) this.bufV.push(m._malloc(3 * 4));
        this.bufResI = m._malloc(36 * 4);
        this.bufResF = m._malloc(8 * 4);
    }

    static available(): boolean {
        return existsSync(ORACLE_MJS);
    }

    static async create(): Promise<Oracle> {
        if (!existsSync(ORACLE_MJS)) {
            throw new Error(
                `oracle not built: ${ORACLE_MJS}\nrun: node oracle/build.mjs`
            );
        }

        const factory = (await import(`file://${ORACLE_MJS.replace(/\\/g, '/')}`)) as {
            default: () => Promise<WasmModule>;
        };

        return new Oracle(await factory.default());
    }

    /** Load a BSP from disk into the collision model. */
    loadBsp(path: string): number {
        const bsp = readFileSync(path);
        const ptr = this.m._malloc(bsp.length);
        this.m.HEAPU8.set(bsp, ptr);
        const checksum = this.m._oracle_load_bsp(ptr, bsp.length);
        this.m._free(ptr);
        return checksum >>> 0;
    }

    get numInlineModels(): number {
        return this.m._oracle_num_inline_models();
    }

    /* ---- playerState_t accessors ---- */

    private psWord(field: PsField, index = 0): number {
        return (this.psPtr + this.psOffset[field]!) / 4 + index;
    }

    getInt(field: PsField, index = 0): number {
        return this.m.HEAP32[this.psWord(field, index)]!;
    }

    setInt(field: PsField, value: number, index = 0): void {
        this.m.HEAP32[this.psWord(field, index)] = value;
    }

    getFloat(field: PsField, index = 0): number {
        return this.m.HEAPF32[this.psWord(field, index)]!;
    }

    setFloat(field: PsField, value: number, index = 0): void {
        this.m.HEAPF32[this.psWord(field, index)] = value;
    }

    getVec(field: PsField): [number, number, number] {
        const w = this.psWord(field);
        return [this.m.HEAPF32[w]!, this.m.HEAPF32[w + 1]!, this.m.HEAPF32[w + 2]!];
    }

    setVec(field: PsField, v: readonly number[]): void {
        const w = this.psWord(field);
        this.m.HEAPF32[w] = v[0]!;
        this.m.HEAPF32[w + 1] = v[1]!;
        this.m.HEAPF32[w + 2] = v[2]!;
    }

    /* ---- usercmd_t accessors ---- */

    setCmdInt(field: CmdField, value: number): void {
        this.m.HEAP32[(this.cmdPtr + this.cmdOffset[field]!) / 4] = value;
    }

    /**
     * `usercmd_t.angles` is `int[3]`, `buttons` is `int`, but `weapon`,
     * `forwardmove`, `rightmove` and `upmove` are single bytes. Writing them as
     * words would clobber their neighbours.
     */
    setCmdAngles(a: readonly number[]): void {
        const w = (this.cmdPtr + this.cmdOffset['angles']!) / 4;
        this.m.HEAP32[w] = a[0]! | 0;
        this.m.HEAP32[w + 1] = a[1]! | 0;
        this.m.HEAP32[w + 2] = a[2]! | 0;
    }

    setCmdByte(field: 'weapon' | 'forwardmove' | 'rightmove' | 'upmove', value: number): void {
        this.m.HEAPU8[this.cmdPtr + this.cmdOffset[field]!] = value & 0xff;
    }

    /* ---- operations ---- */

    reset(): void {
        this.m._oracle_reset();
    }

    pmove(opts: {
        tracemask: number;
        pmove_fixed?: number;
        pmove_msec?: number;
        noFootsteps?: number;
        gauntletHit?: number;
        pmove_float?: number;
        pmove_flags?: number;
    }): void {
        this.m._oracle_pmove(
            opts.tracemask,
            opts.pmove_fixed ?? 0,
            opts.pmove_msec ?? 8,
            opts.noFootsteps ?? 0,
            opts.gauntletHit ?? 0,
            opts.pmove_float ?? 0,
            opts.pmove_flags ?? 0
        );
    }

    pmResults(): PmResults {
        this.m._oracle_pm_results(this.bufResI, this.bufResF);
        const I = this.m.HEAP32;
        const F = this.m.HEAPF32;
        const i = this.bufResI >> 2;
        const f = this.bufResF >> 2;
        return {
            numtouch: I[i]!,
            watertype: I[i + 1]!,
            waterlevel: I[i + 2]!,
            framecount: I[i + 3]!,
            mins: [F[f]!, F[f + 1]!, F[f + 2]!],
            maxs: [F[f + 3]!, F[f + 4]!, F[f + 5]!],
            xyspeed: F[f + 6]!,
        };
    }

    boxTrace(
        start: readonly number[],
        mins: readonly number[],
        maxs: readonly number[],
        end: readonly number[],
        mask: number
    ): OracleTrace {
        const F = this.m.HEAPF32;
        const put = (p: number, v: readonly number[]): void => {
            F[p >> 2] = v[0]!;
            F[(p >> 2) + 1] = v[1]!;
            F[(p >> 2) + 2] = v[2]!;
        };

        put(this.bufV[0]!, start);
        put(this.bufV[1]!, mins);
        put(this.bufV[2]!, maxs);
        put(this.bufV[3]!, end);

        this.m._oracle_box_trace(
            this.bufTrace, this.bufTraceI,
            this.bufV[0]!, this.bufV[1]!, this.bufV[2]!, this.bufV[3]!, mask
        );

        const t = this.bufTrace >> 2;
        const ti = this.bufTraceI >> 2;
        const I = this.m.HEAP32;
        return {
            allsolid: F[t]! !== 0,
            startsolid: F[t + 1]! !== 0,
            fraction: F[t + 2]!,
            endpos: [F[t + 3]!, F[t + 4]!, F[t + 5]!],
            planeNormal: [F[t + 6]!, F[t + 7]!, F[t + 8]!],
            planeDist: F[t + 9]!,
            surfaceFlags: I[ti]!,
            contents: I[ti + 1]!,
            entityNum: I[ti + 2]!,
        };
    }

    pointContents(p: readonly number[]): number {
        const F = this.m.HEAPF32;
        F[this.bufV[0]! >> 2] = p[0]!;
        F[(this.bufV[0]! >> 2) + 1] = p[1]!;
        F[(this.bufV[0]! >> 2) + 2] = p[2]!;
        return this.m._oracle_point_contents(this.bufV[0]!);
    }
}
