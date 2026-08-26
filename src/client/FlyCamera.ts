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
 * A debug camera, on meep's input devices for the same reason the player
 * controller is: the canvas and the view stack above it are `pointer-events:
 * none`, so raw DOM listeners on them receive nothing at all (GAP-017).
 */

import type { InputDevices, PointerMoveHandler } from './PlayerController.ts';
import { takePointerLock } from './pointerLock.ts';

interface TransformLike {
    position: { set(x: number, y: number, z: number): void; x: number; y: number; z: number };
    rotation: { _lookRotation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): unknown };
}

/** meep key names, from `input/devices/KeyCodes.js`. */
const KEY_FORWARD = ['w', 'up_arrow'];
const KEY_BACK = ['s', 'down_arrow'];
const KEY_LEFT = ['a', 'left_arrow'];
const KEY_RIGHT = ['d', 'right_arrow'];
const KEY_UP = ['space'];
const KEY_DOWN = ['ctrl', 'c'];
const KEY_FAST = ['shift'];

/**
 * Metres per second. A Q3 player runs at 320 units/s, which is 10 m/s at the
 * 1/32 scale the pipeline emits; 15 is "fast but still readable".
 */
const BASE_SPEED = 15;
const FAST_MULTIPLIER = 4;

export class FlyCamera {
    private readonly transform: TransformLike;
    private readonly element: HTMLElement;
    private readonly devices: InputDevices;

    /** Radians. Yaw around +Y, pitch around the camera's local X. */
    yaw = 0;
    pitch = 0;

    private attached = false;

    constructor(transform: TransformLike, element: HTMLElement, devices: InputDevices) {
        this.transform = transform;
        this.element = element;
        this.devices = devices;
    }

    attach(): void {
        if (this.attached) return;
        this.attached = true;

        this.devices.keyboard.on.down.add(this.onKeyDown);
        this.devices.pointer.on.down.add(this.onPointerDown);
        this.devices.pointer.on.move.add(this.onPointerMove);
    }

    detach(): void {
        if (!this.attached) return;
        this.attached = false;

        this.devices.keyboard.on.down.remove(this.onKeyDown);
        this.devices.pointer.on.down.remove(this.onPointerDown);
        this.devices.pointer.on.move.remove(this.onPointerMove);
    }

    /** Only to stop space scrolling the page; movement is polled. */
    private readonly onKeyDown = (e: KeyboardEvent): void => {
        if (e.code === 'Space') e.preventDefault();
    };

    private readonly onPointerDown = (): void => {
        if (document.pointerLockElement !== this.element) {
            void takePointerLock(this.element);
        }
    };

    private readonly onPointerMove: PointerMoveHandler = (_position, _event, delta): void => {
        if (document.pointerLockElement !== this.element) return;

        this.yaw -= delta.x * 0.0022;
        this.pitch -= delta.y * 0.0022;

        const limit = Math.PI / 2 - 0.01;
        if (this.pitch > limit) this.pitch = limit;
        if (this.pitch < -limit) this.pitch = -limit;
    };

    private has(names: readonly string[]): boolean {
        const keys = this.devices.keyboard.keys;
        for (const name of names) if (keys[name]?.is_down === true) return true;
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
