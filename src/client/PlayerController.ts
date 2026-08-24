/*
 * PlayerController.ts -- drive `bg_pmove` from browser input.
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
 * The boundary between the two coordinate systems and the two unit scales.
 *
 * - The **simulation** runs in Q3 units and Q3 axes (Z up), because `bg_pmove`
 *   does and that is oracle-verified.
 * - The **presentation** runs in metres and meep axes (Y up).
 *
 * So this class owns exactly one conversion, in one direction, once per frame:
 * `ps.origin` (Q3) -> camera `Transform.position` (meep). Nothing else in the
 * client needs to know either convention. See DECISIONS.md D-011.
 *
 * Input handling is deliberately minimal and is not built on meep's input
 * abstraction -- see GAP-010 in REPORT.md for why that is a finding rather than
 * laziness.
 */

import { vec3 } from '../q3/math.ts';
import { ClipMap, MASK_PLAYERSOLID } from '../q3/cm/ClipMap.ts';
import { boxTrace, pointContents } from '../q3/cm/trace.ts';
import { Pmove as runPmove } from '../q3/pmove/pmove.ts';
import {
    createPlayerState,
    createUserCmd,
    FORWARDMOVE,
    RIGHTMOVE,
    UPMOVE,
    type Pmove,
    type PlayerState,
} from '../q3/pmove/types.ts';
import * as C from '../q3/pmove/constants.ts';

/** Scene units per Q3 unit; must match the pipeline's `WORLD_SCALE`. */
const WORLD_SCALE = 1 / 32;

interface TransformLike {
    position: { set(x: number, y: number, z: number): void };
    rotation: {
        _lookRotation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): unknown;
    };
}

const KEY_FORWARD = new Set(['KeyW', 'ArrowUp']);
const KEY_BACK = new Set(['KeyS', 'ArrowDown']);
const KEY_LEFT = new Set(['KeyA', 'ArrowLeft']);
const KEY_RIGHT = new Set(['KeyD', 'ArrowRight']);
const KEY_JUMP = new Set(['Space']);
const KEY_CROUCH = new Set(['ControlLeft', 'KeyC', 'ShiftLeft']);

/**
 * Q3 sends view angles as 16-bit fixed point. Keeping the browser's mouse deltas
 * in the same representation means the port's angle handling is exercised the
 * way the game's is, including the wrap that makes yaw circular.
 */
const ANGLE_PER_PIXEL = 12;

export class PlayerController {
    readonly ps: PlayerState;
    private readonly pmove: Pmove;
    private readonly element: HTMLElement;
    private readonly held = new Set<string>();

    /** 16-bit view angles, as `usercmd_t.angles` carries them. */
    private yaw = 0;
    private pitch = 0;

    private time = 0;
    private attached = false;

    /** Set true while the pointer is locked; movement input is ignored otherwise. */
    active = false;

    constructor(cm: ClipMap, element: HTMLElement, spawnQ3: readonly number[]) {
        this.element = element;

        const ps = createPlayerState();
        ps.pm_type = C.PM_NORMAL;
        ps.gravity = 800;
        ps.speed = 320;
        ps.groundEntityNum = C.ENTITYNUM_NONE;
        ps.stats[C.STAT_HEALTH] = 100;
        ps.viewheight = C.DEFAULT_VIEWHEIGHT;
        ps.origin[0] = spawnQ3[0] ?? 0;
        ps.origin[1] = spawnQ3[1] ?? 0;
        // `G_SelectSpawnPoint` lifts the spawn by 9 units before placing a player.
        ps.origin[2] = (spawnQ3[2] ?? 0) + 9;

        this.ps = ps;

        this.pmove = {
            ps,
            cmd: createUserCmd(),
            tracemask: MASK_PLAYERSOLID,
            debugLevel: 0,
            noFootsteps: false,
            gauntletHit: false,
            framecount: 0,
            numtouch: 0,
            touchents: new Int32Array(C.MAXTOUCH),
            mins: vec3(),
            maxs: vec3(),
            watertype: 0,
            waterlevel: 0,
            xyspeed: 0,
            pmove_fixed: 0,
            pmove_msec: 8,
            pmove_float: 0,
            pmove_flags: 0,
            trace(results, start, mins, maxs, end, _passEnt, contentMask) {
                boxTrace(results, cm, start, end, mins, maxs, contentMask);
                // Only the world exists so far; brush entities arrive in phase 3.
                results.entityNum =
                    results.fraction !== 1.0 ? C.ENTITYNUM_WORLD : C.ENTITYNUM_NONE;
            },
            pointcontents(point, _passEnt) {
                return pointContents(cm, point[0]!, point[1]!, point[2]!);
            },
        };
    }

    attach(): void {
        if (this.attached) return;
        this.attached = true;

        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('blur', this.onBlur);
        this.element.addEventListener('mousedown', this.onMouseDown);
        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('pointerlockchange', this.onPointerLockChange);
    }

    detach(): void {
        if (!this.attached) return;
        this.attached = false;

        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('blur', this.onBlur);
        this.element.removeEventListener('mousedown', this.onMouseDown);
        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    }

    private readonly onKeyDown = (e: KeyboardEvent): void => {
        this.held.add(e.code);
        if (e.code === 'Space') e.preventDefault();
    };

    private readonly onKeyUp = (e: KeyboardEvent): void => {
        this.held.delete(e.code);
    };

    private readonly onBlur = (): void => {
        this.held.clear();
    };

    private readonly onMouseDown = (): void => {
        if (document.pointerLockElement !== this.element) {
            void this.element.requestPointerLock();
        }
    };

    private readonly onPointerLockChange = (): void => {
        this.active = document.pointerLockElement === this.element;
        if (!this.active) this.held.clear();
    };

    private readonly onMouseMove = (e: MouseEvent): void => {
        if (!this.active) return;

        // `| 0` after each accumulation so yaw wraps in 32 bits and is then
        // truncated to 16 by `usercmd_t.angles`, exactly as the engine does.
        this.yaw = (this.yaw - e.movementX * ANGLE_PER_PIXEL) | 0;
        this.pitch = (this.pitch + e.movementY * ANGLE_PER_PIXEL) | 0;

        // `PM_UpdateViewAngles` clamps to +/-16000 (87.9 degrees) itself, but
        // clamping the raw command too stops the accumulator drifting far past
        // the limit while the player holds the mouse down.
        if (this.pitch > 16000) this.pitch = 16000;
        if (this.pitch < -16000) this.pitch = -16000;
    };

    private has(codes: ReadonlySet<string>): boolean {
        for (const c of codes) if (this.held.has(c)) return true;
        return false;
    }

    /**
     * Advance the simulation by `deltaSeconds` and write the result to a meep
     * transform.
     */
    update(deltaSeconds: number, cameraTransform: TransformLike): void {
        // Q3 works in integer milliseconds. Clamping matches `PmoveSingle`'s own
        // 200 ms ceiling, so a backgrounded tab resumes without a teleport.
        const msec = Math.min(200, Math.max(1, Math.round(deltaSeconds * 1000)));
        this.time += msec;

        const cmd = this.pmove.cmd;
        cmd.serverTime = this.time;
        cmd.angles[0] = this.pitch;
        cmd.angles[1] = this.yaw;
        cmd.angles[2] = 0;
        cmd.buttons = 0;
        cmd.weapon = 1;

        if (this.active) {
            cmd.moves[FORWARDMOVE] =
                (this.has(KEY_FORWARD) ? 127 : 0) + (this.has(KEY_BACK) ? -127 : 0);
            cmd.moves[RIGHTMOVE] =
                (this.has(KEY_RIGHT) ? 127 : 0) + (this.has(KEY_LEFT) ? -127 : 0);
            cmd.moves[UPMOVE] =
                (this.has(KEY_JUMP) ? 127 : 0) + (this.has(KEY_CROUCH) ? -127 : 0);
        } else {
            cmd.moves[FORWARDMOVE] = 0;
            cmd.moves[RIGHTMOVE] = 0;
            cmd.moves[UPMOVE] = 0;
        }

        runPmove(this.pmove);

        this.writeCamera(cameraTransform);
    }

    /** Q3 (Z-up, units) -> meep (Y-up, metres). The only place this happens. */
    private writeCamera(t: TransformLike): void {
        const ps = this.ps;

        const eyeZ = ps.origin[2]! + ps.viewheight;

        t.position.set(
            ps.origin[0]! * WORLD_SCALE,
            eyeZ * WORLD_SCALE,
            -ps.origin[1]! * WORLD_SCALE
        );

        // `ps.viewangles` is in degrees, Q3 convention: pitch positive is *down*.
        const pitchRad = (ps.viewangles[0]! * Math.PI) / 180;
        const yawRad = (ps.viewangles[1]! * Math.PI) / 180;

        const cp = Math.cos(pitchRad);

        // Q3 forward is (cos(yaw)cos(pitch), sin(yaw)cos(pitch), -sin(pitch)),
        // mapped through the same axis swap the geometry went through.
        const fx = Math.cos(yawRad) * cp;
        const fy = Math.sin(yawRad) * cp;
        const fz = -Math.sin(pitchRad);

        t.rotation._lookRotation(fx, fz, -fy, 0, 1, 0);
    }

    /** Horizontal speed in Q3 units per second, for the debug readout. */
    get speed(): number {
        return Math.hypot(this.ps.velocity[0]!, this.ps.velocity[1]!);
    }

    get onGround(): boolean {
        return this.ps.groundEntityNum !== C.ENTITYNUM_NONE;
    }
}
