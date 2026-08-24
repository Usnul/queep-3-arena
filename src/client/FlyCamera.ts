/*
 * FlyCamera.ts -- a noclip camera for inspecting converted maps.
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
 * Deliberately not built on meep's input abstraction, and deliberately throwaway.
 * This exists to answer "did the map convert correctly", and is replaced in
 * phase 2 by the real `bg_pmove` controller reading a `usercmd_t`. Wiring it
 * through the engine's input layer would mean writing that integration twice.
 */

interface TransformLike {
    position: { set(x: number, y: number, z: number): void; x: number; y: number; z: number };
    rotation: { _lookRotation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): unknown };
}

const KEY_FORWARD = new Set(['KeyW', 'ArrowUp']);
const KEY_BACK = new Set(['KeyS', 'ArrowDown']);
const KEY_LEFT = new Set(['KeyA', 'ArrowLeft']);
const KEY_RIGHT = new Set(['KeyD', 'ArrowRight']);
const KEY_UP = new Set(['Space']);
const KEY_DOWN = new Set(['ControlLeft', 'KeyC']);
const KEY_FAST = new Set(['ShiftLeft', 'ShiftRight']);

/**
 * Metres per second. A Q3 player runs at 320 units/s, which is 10 m/s at the
 * 1/32 scale the pipeline emits; 15 is "fast but still readable".
 */
const BASE_SPEED = 15;
const FAST_MULTIPLIER = 4;

export class FlyCamera {
    private readonly transform: TransformLike;
    private readonly element: HTMLElement;
    private readonly held = new Set<string>();

    /** Radians. Yaw around +Y, pitch around the camera's local X. */
    yaw = 0;
    pitch = 0;

    private attached = false;

    constructor(transform: TransformLike, element: HTMLElement) {
        this.transform = transform;
        this.element = element;
    }

    attach(): void {
        if (this.attached) return;
        this.attached = true;

        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('blur', this.onBlur);
        this.element.addEventListener('mousedown', this.onMouseDown);
        document.addEventListener('mousemove', this.onMouseMove);
    }

    detach(): void {
        if (!this.attached) return;
        this.attached = false;

        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('blur', this.onBlur);
        this.element.removeEventListener('mousedown', this.onMouseDown);
        document.removeEventListener('mousemove', this.onMouseMove);
    }

    private readonly onKeyDown = (e: KeyboardEvent): void => {
        this.held.add(e.code);
        if (e.code === 'Space') e.preventDefault();
    };

    private readonly onKeyUp = (e: KeyboardEvent): void => {
        this.held.delete(e.code);
    };

    /** Dropping every key on blur stops the camera drifting away while unfocused. */
    private readonly onBlur = (): void => {
        this.held.clear();
    };

    private readonly onMouseDown = (): void => {
        if (document.pointerLockElement !== this.element) {
            void this.element.requestPointerLock();
        }
    };

    private readonly onMouseMove = (e: MouseEvent): void => {
        if (document.pointerLockElement !== this.element) return;

        this.yaw -= e.movementX * 0.0022;
        this.pitch -= e.movementY * 0.0022;

        const limit = Math.PI / 2 - 0.01;
        if (this.pitch > limit) this.pitch = limit;
        if (this.pitch < -limit) this.pitch = -limit;
    };

    private has(codes: ReadonlySet<string>): boolean {
        for (const c of codes) if (this.held.has(c)) return true;
        return false;
    }

    update(deltaSeconds: number): void {
        // meep's ticker reports seconds; clamp so a backgrounded tab that resumes
        // with a huge delta does not teleport the camera across the level.
        const dt = Math.min(deltaSeconds, 0.1);

        const cy = Math.cos(this.yaw);
        const sy = Math.sin(this.yaw);
        const cp = Math.cos(this.pitch);
        const sp = Math.sin(this.pitch);

        // The same forward vector that `applyRotation` hands to `lookRotation`, so
        // walking forward always means walking towards what is on screen.
        const fx = -sy * cp;
        const fy = sp;
        const fz = -cy * cp;

        const rx = cy;
        const rz = -sy;

        let mx = 0;
        let my = 0;
        let mz = 0;

        if (this.has(KEY_FORWARD)) { mx += fx; my += fy; mz += fz; }
        if (this.has(KEY_BACK)) { mx -= fx; my -= fy; mz -= fz; }
        if (this.has(KEY_RIGHT)) { mx += rx; mz += rz; }
        if (this.has(KEY_LEFT)) { mx -= rx; mz -= rz; }
        if (this.has(KEY_UP)) my += 1;
        if (this.has(KEY_DOWN)) my -= 1;

        const len = Math.hypot(mx, my, mz);
        if (len > 1e-6) {
            const speed = (this.has(KEY_FAST) ? BASE_SPEED * FAST_MULTIPLIER : BASE_SPEED) * dt / len;
            const p = this.transform.position;
            p.set(p.x + mx * speed, p.y + my * speed, p.z + mz * speed);
        }

        this.applyRotation();
    }

    /**
     * Orient the transform along the current view direction.
     *
     * Uses `Quaternion._lookRotation` rather than composing a quaternion by
     * hand, because **meep's camera does not use the glTF/three convention**.
     * `camera_sync_from_transform` states it: Shade takes the *object*
     * convention, where an entity's forward is the viewing direction, and the
     * sync performs no inversion. A quaternion built on the assumption that a
     * camera looks down its local -Z points it exactly backwards, which presents
     * as an unlit scene rather than as a reversed one -- you are looking at the
     * outside of the level, and backfaces are culled.
     *
     * Handing the engine the direction vector directly sidesteps the convention
     * entirely: whatever `lookRotation` means by forward, the same vector drives
     * movement, so the two cannot disagree.
     */
    private applyRotation(): void {
        const cp = Math.cos(this.pitch);

        this.transform.rotation._lookRotation(
            -Math.sin(this.yaw) * cp,
            Math.sin(this.pitch),
            -Math.cos(this.yaw) * cp,
            0,
            1,
            0
        );
    }
}
