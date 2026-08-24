/*
 * Movers.ts -- doors, plats, buttons and the triggers that drive them.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * Ported in shape from `g_mover.c`, `g_trigger.c` and `g_target.c`. Pure
 * simulation, in Q3 units and Q3 axes, with an integer millisecond clock
 * because `level.time` is an integer and every mover's position is derived from
 * it -- a float clock would make a door's resting position drift by a fraction
 * of a unit over a long match, which sounds harmless right up until the door is
 * a lift and the drift decides whether you clear the ledge.
 *
 * The four-state machine is the whole of it: POS1, 1TO2, POS2, 2TO1. A door
 * interrupted halfway reverses from where it is rather than from its endpoint,
 * which is why `Use_BinaryMover` rewinds `trTime` by the elapsed part rather
 * than restarting the trajectory -- get that wrong and a door caught mid-swing
 * snaps to one end before coming back.
 *
 * Brush entities are BSP submodels: `model` is the string `*3`, meaning "the
 * geometry and the brushes of BSP model 3". The entity's own origin is almost
 * always `0 0 0`, because the geometry already sits where the level designer
 * put it; a mover moves by *offsetting* that geometry, not by placing it.
 */

/* ---- moverState_t ---- */

export const MOVER_POS1 = 0;
export const MOVER_POS2 = 1;
export const MOVER_1TO2 = 2;
export const MOVER_2TO1 = 3;

export type MoverState = 0 | 1 | 2 | 3;

/** `G_SetMovedir`'s two magic angle values. */
const VEC_UP_YAW = -1;
const VEC_DOWN_YAW = -2;

export type Vec3 = [number, number, number];

export interface BrushModel {
    readonly minsQ3: readonly number[];
    readonly maxsQ3: readonly number[];
}

export interface MoverEntity extends Record<string, unknown> {
    readonly classname?: string;
    readonly _originQ3: number[];
}

/** Everything a running mover needs. One per brush entity that actually moves. */
export interface Mover {
    readonly model: number;
    readonly classname: string;
    readonly pos1: Vec3;
    readonly pos2: Vec3;
    /** Current offset from the submodel's authored position, in Q3 units. */
    readonly origin: Vec3;
    /** Where it was at the end of the previous frame, for carrying riders. */
    readonly previousOrigin: Vec3;
    /** Q3 world-space bounds of the submodel at `pos1`. */
    readonly mins: Vec3;
    readonly maxs: Vec3;

    state: MoverState;
    /** `s.pos.trTime`, in milliseconds. */
    trTime: number;
    /** `s.pos.trDuration`, in milliseconds. */
    readonly trDuration: number;
    /** `wait`, in milliseconds. Negative means "never come back". */
    readonly wait: number;
    readonly damage: number;
    readonly targetname: string | null;
    readonly target: string | null;
    /** `think`/`nextthink` collapsed to the one thing movers use it for. */
    returnAt: number;
    /** True once a shootable door or button has been destroyed into motion. */
    readonly takedamage: boolean;
    readonly health: number;
    /** Set while something is standing on a plat, per `Touch_Plat`. */
    holdOpenUntil: number;
}

export type TriggerKind = 'door' | 'plat' | 'multiple' | 'teleport' | 'hurt' | 'push';

export interface Trigger {
    readonly kind: TriggerKind;
    readonly mins: Vec3;
    readonly maxs: Vec3;
    /** Mover this trigger opens, for `door` and `plat`. */
    readonly mover: Mover | null;
    /** `target` for `multiple`, `teleport` and `push`. */
    readonly target: string | null;
    readonly damage: number;
    /** Q3's `wait` between retriggers, in ms. */
    readonly wait: number;
    nextFire: number;
    /** Whether this trigger's brush model is drawn. Triggers are `nodraw`. */
    readonly model: number;
    /** For `push`: the launch velocity `AimAtTarget` solved for. */
    pushVelocity: Vec3 | null;
    /** World-space centre, which `AimAtTarget` launches from. */
    readonly centre: Vec3;
}

export interface TeleportDestination {
    readonly origin: Vec3;
    /** Yaw the player is forced to face on arrival. */
    readonly angle: number;
    readonly targetname: string;
}

export interface MoverEvents {
    /** Doors, plats and buttons all have start and stop sounds in Q3. */
    moverSound(mover: Mover, which: 'start' | 'stop'): void;
    teleport(destination: TeleportDestination): void;
    hurt(damage: number): void;
    push(velocityQ3: readonly number[]): void;
}

/* ---- helpers ---- */

/**
 * `G_SetMovedir`.
 *
 * `angle -1` means up and `angle -2` means down. Both are sentinels rather than
 * angles, because a brush entity's `angle` key writes into `angles[YAW]` and
 * there is no way to express "vertical" as a yaw. A converter that treats them
 * as ordinary yaws sends every lift sideways into a wall.
 */
export function moveDir(angleYaw: number): Vec3 {
    if (angleYaw === VEC_UP_YAW) return [0, 0, 1];
    if (angleYaw === VEC_DOWN_YAW) return [0, 0, -1];

    const radians = (angleYaw * Math.PI) / 180;
    return [Math.cos(radians), Math.sin(radians), 0];
}

function num(entity: MoverEntity, key: string, fallback: number): number {
    const raw = entity[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function str(entity: MoverEntity, key: string): string | null {
    const raw = entity[key];
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** `BG_EvaluateTrajectory` for the two trajectory types a mover ever uses. */
export function moverOrigin(mover: Mover, timeMs: number, out: Vec3): void {
    const from = mover.state === MOVER_2TO1 ? mover.pos2 : mover.pos1;
    const to = mover.state === MOVER_2TO1 ? mover.pos1 : mover.pos2;

    if (mover.state === MOVER_POS1) {
        out[0] = mover.pos1[0];
        out[1] = mover.pos1[1];
        out[2] = mover.pos1[2];
        return;
    }
    if (mover.state === MOVER_POS2) {
        out[0] = mover.pos2[0];
        out[1] = mover.pos2[1];
        out[2] = mover.pos2[2];
        return;
    }

    // TR_LINEAR_STOP: clamped at the far end, and never before trTime.
    let elapsed = timeMs - mover.trTime;
    if (elapsed > mover.trDuration) elapsed = mover.trDuration;
    if (elapsed < 0) elapsed = 0;

    const f = mover.trDuration === 0 ? 1 : elapsed / mover.trDuration;

    out[0] = from[0] + (to[0] - from[0]) * f;
    out[1] = from[1] + (to[1] - from[1]) * f;
    out[2] = from[2] + (to[2] - from[2]) * f;
}

function boxesOverlap(
    aMins: ArrayLike<number>,
    aMaxs: ArrayLike<number>,
    bMins: ArrayLike<number>,
    bMaxs: ArrayLike<number>
): boolean {
    return !(
        aMins[0]! > bMaxs[0]! || aMaxs[0]! < bMins[0]! ||
        aMins[1]! > bMaxs[1]! || aMaxs[1]! < bMins[1]! ||
        aMins[2]! > bMaxs[2]! || aMaxs[2]! < bMins[2]!
    );
}

/**
 * `AimAtTarget`: solve for the velocity that lands a player on the target.
 *
 * The classic Q3 jump pad. `time = sqrt(height / (0.5 * gravity))` is the fall
 * time from the apex, so the vertical component is `time * gravity` and the
 * horizontal is however fast you have to travel to cover the ground distance in
 * that time. Q3 frees the trigger outright if there is no target or the target
 * is not above it -- `sqrt` of a negative is a NaN velocity, and a NaN in
 * `ps->velocity` propagates into every subsequent pmove.
 *
 * `g_gravity` is 800 and this port does not expose it as a cvar.
 */
function aimAtTarget(trigger: Trigger, destination: TeleportDestination | null): Vec3 | null {
    if (destination === null) return null;

    const gravity = 800;
    const height = destination.origin[2] - trigger.centre[2];
    if (height <= 0) return null;

    const time = Math.sqrt(height / (0.5 * gravity));
    if (time === 0) return null;

    let dx = destination.origin[0] - trigger.centre[0];
    let dy = destination.origin[1] - trigger.centre[1];
    const distance = Math.hypot(dx, dy);

    if (distance > 0) {
        dx /= distance;
        dy /= distance;
    }

    const forward = distance / time;

    return [dx * forward, dy * forward, time * gravity];
}

/* ---- the system ---- */

export class MoverSystem {
    readonly movers: Mover[] = [];
    readonly triggers: Trigger[] = [];
    readonly destinations: TeleportDestination[] = [];

    /** Classnames seen with a brush model that this port does not implement. */
    readonly unhandled: string[] = [];

    /**
     * Submodels that are solid and never move.
     *
     * `func_static` is the honest member of this list. The rest are brush
     * entities this port does not simulate -- `func_rotating`, `func_bobbing`,
     * `func_train` -- which are treated as stationary rather than dropped.
     * Wrong, but wrong in the direction that keeps the level playable: a fan
     * that does not spin is a cosmetic loss, a fan you can walk through is a
     * hole in the map. Every one is named in `unhandled` so the loss is
     * visible rather than silent.
     */
    readonly statics: number[] = [];

    private readonly events: MoverEvents;
    private readonly byTargetname = new Map<string, Mover[]>();

    /** `level.time`, integer milliseconds. */
    private timeMs = 0;
    private accumulator = 0;

    private readonly scratch: Vec3 = [0, 0, 0];

    private clipCache: readonly { readonly model: number; readonly origin: readonly number[] }[] | null =
        null;

    constructor(events: MoverEvents) {
        this.events = events;
    }

    get now(): number {
        return this.timeMs;
    }

    /**
     * `G_SpawnEntitiesFromString` for the entity classes that move.
     *
     * @param submodels the BSP model table, so `model: "*3"` can be resolved to
     *   the bounds the spawn functions need. Q3 gets these from
     *   `trap_SetBrushModel`, which is the one place a game-side spawn function
     *   reaches into the collision model.
     */
    spawn(entities: readonly MoverEntity[], submodels: readonly BrushModel[]): void {
        for (const entity of entities) {
            const classname = entity.classname ?? '';
            const modelRef = entity['model'];

            if (typeof modelRef !== 'string' || !modelRef.startsWith('*')) {
                if (classname === 'misc_teleporter_dest' || classname === 'target_position') {
                    this.destinations.push({
                        origin: [
                            entity._originQ3[0]!,
                            entity._originQ3[1]!,
                            entity._originQ3[2]!,
                        ],
                        angle: num(entity, 'angle', 0),
                        targetname: str(entity, 'targetname') ?? '',
                    });
                }
                continue;
            }

            const model = Number(modelRef.slice(1));
            const submodel = submodels[model];
            if (submodel === undefined) continue;

            const mins: Vec3 = [
                submodel.minsQ3[0]!,
                submodel.minsQ3[1]!,
                submodel.minsQ3[2]!,
            ];
            const maxs: Vec3 = [
                submodel.maxsQ3[0]!,
                submodel.maxsQ3[1]!,
                submodel.maxsQ3[2]!,
            ];

            switch (classname) {
                case 'func_door':
                    this.spawnDoor(entity, model, mins, maxs);
                    break;
                case 'func_button':
                    this.spawnButton(entity, model, mins, maxs);
                    break;
                case 'func_plat':
                    this.spawnPlat(entity, model, mins, maxs);
                    break;
                case 'trigger_teleport':
                    this.spawnTrigger('teleport', entity, model, mins, maxs);
                    break;
                case 'trigger_hurt':
                    this.spawnTrigger('hurt', entity, model, mins, maxs);
                    break;
                case 'trigger_push':
                    this.spawnTrigger('push', entity, model, mins, maxs);
                    break;
                case 'trigger_multiple':
                    this.spawnTrigger('multiple', entity, model, mins, maxs);
                    break;
                case 'func_static':
                    this.statics.push(model);
                    break;

                default:
                    if (classname.startsWith('trigger_')) {
                        // An unimplemented trigger is non-solid and invisible in
                        // Q3 too, so ignoring it costs a behaviour, not a wall.
                        if (!this.unhandled.includes(classname)) this.unhandled.push(classname);
                    } else {
                        this.statics.push(model);
                        if (!this.unhandled.includes(classname)) this.unhandled.push(classname);
                    }
                    break;
            }
        }

        // Doors that nothing targets get their own trigger, exactly as
        // `Think_SpawnNewDoorTrigger` does after the spawn pass.
        for (const mover of this.movers) {
            if (mover.classname === 'func_door' && mover.targetname === null && !mover.takedamage) {
                this.triggers.push(this.doorTrigger(mover));
            }
            if (mover.classname === 'func_plat') {
                this.triggers.push(this.platTrigger(mover));
            }
        }

        // `AimAtTarget` runs on the frame after spawn, because it needs every
        // `target_position` to exist first.
        for (const trigger of this.triggers) {
            if (trigger.kind !== 'push') continue;
            trigger.pushVelocity = aimAtTarget(trigger, this.destination(trigger.target));
        }
    }

    private register(mover: Mover): void {
        this.movers.push(mover);
        if (mover.targetname !== null) {
            const list = this.byTargetname.get(mover.targetname) ?? [];
            list.push(mover);
            this.byTargetname.set(mover.targetname, list);
        }
    }

    /** `SP_func_door`. */
    private spawnDoor(entity: MoverEntity, model: number, mins: Vec3, maxs: Vec3): void {
        const speed = num(entity, 'speed', 400) || 400;
        const lip = num(entity, 'lip', 8);
        const damage = num(entity, 'dmg', 2);
        const health = num(entity, 'health', 0);
        const spawnflags = num(entity, 'spawnflags', 0) | 0;

        const dir = moveDir(num(entity, 'angle', 0));
        const size: Vec3 = [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]];
        const distance =
            Math.abs(dir[0]) * size[0] + Math.abs(dir[1]) * size[1] + Math.abs(dir[2]) * size[2] - lip;

        let pos1: Vec3 = [0, 0, 0];
        let pos2: Vec3 = [dir[0] * distance, dir[1] * distance, dir[2] * distance];

        // `start_open` swaps the two, so the door is authored in its open state.
        if ((spawnflags & 1) !== 0) [pos1, pos2] = [pos2, pos1];

        this.register(
            this.makeMover(entity, 'func_door', model, mins, maxs, pos1, pos2, speed, {
                waitSeconds: num(entity, 'wait', 2),
                damage,
                health,
            })
        );
    }

    /** `SP_func_button`. Speed 40, lip 4, wait 1 -- all different from a door. */
    private spawnButton(entity: MoverEntity, model: number, mins: Vec3, maxs: Vec3): void {
        const speed = num(entity, 'speed', 40) || 40;
        const lip = num(entity, 'lip', 4);

        const dir = moveDir(num(entity, 'angle', 0));
        const size: Vec3 = [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]];
        const distance =
            Math.abs(dir[0]) * size[0] + Math.abs(dir[1]) * size[1] + Math.abs(dir[2]) * size[2] - lip;

        this.register(
            this.makeMover(
                entity,
                'func_button',
                model,
                mins,
                maxs,
                [0, 0, 0],
                [dir[0] * distance, dir[1] * distance, dir[2] * distance],
                speed,
                {
                    waitSeconds: num(entity, 'wait', 1),
                    damage: 0,
                    health: num(entity, 'health', 0),
                }
            )
        );
    }

    /**
     * `SP_func_plat`.
     *
     * The one mover whose *authored* position is the top: `pos2` is where the
     * brushes are and `pos1` is `height` below, so a plat spawns already sunk
     * into the floor. Reading it the other way up leaves every lift permanently
     * at ceiling height, which looks like the map is broken rather than the
     * spawn function.
     */
    private spawnPlat(entity: MoverEntity, model: number, mins: Vec3, maxs: Vec3): void {
        const speed = num(entity, 'speed', 200) || 200;
        const lip = num(entity, 'lip', 8);
        const height = num(entity, 'height', 0) || maxs[2] - mins[2] - lip;

        this.register(
            this.makeMover(
                entity,
                'func_plat',
                model,
                mins,
                maxs,
                [0, 0, -height],
                [0, 0, 0],
                speed,
                { waitSeconds: num(entity, 'wait', 1), damage: num(entity, 'dmg', 2), health: 0 }
            )
        );
    }

    private makeMover(
        entity: MoverEntity,
        classname: string,
        model: number,
        mins: Vec3,
        maxs: Vec3,
        pos1: Vec3,
        pos2: Vec3,
        speed: number,
        opts: { waitSeconds: number; damage: number; health: number }
    ): Mover {
        const dx = pos2[0] - pos1[0];
        const dy = pos2[1] - pos1[1];
        const dz = pos2[2] - pos1[2];
        const distance = Math.hypot(dx, dy, dz);

        // `InitMover`: duration in ms, floored at 1 so a zero-throw mover still
        // reaches its endpoint rather than dividing by zero.
        const trDuration = Math.max(1, Math.round((distance * 1000) / speed));

        return {
            model,
            classname,
            pos1,
            pos2,
            origin: [pos1[0], pos1[1], pos1[2]],
            previousOrigin: [pos1[0], pos1[1], pos1[2]],
            mins,
            maxs,
            state: MOVER_POS1,
            trTime: 0,
            trDuration,
            wait: Math.round(opts.waitSeconds * 1000),
            damage: opts.damage,
            targetname: str(entity, 'targetname'),
            target: str(entity, 'target'),
            returnAt: -1,
            takedamage: opts.health > 0,
            health: opts.health,
            holdOpenUntil: -1,
        };
    }

    /**
     * `Think_SpawnNewDoorTrigger`: a box around the door, expanded 120 units
     * along its *thinnest* axis.
     *
     * The thinnest axis is the one you walk through, so expanding it is what
     * makes the door open before you reach it rather than as you hit it. Q3
     * builds this from the whole door team's combined bounds; without teaming,
     * each leaf of a double door gets its own, which opens both together
     * anyway because they share a `targetname`.
     */
    private doorTrigger(mover: Mover): Trigger {
        const mins: Vec3 = [...mover.mins];
        const maxs: Vec3 = [...mover.maxs];

        let best = 0;
        for (let i = 1; i < 3; i++) {
            if (maxs[i]! - mins[i]! < maxs[best]! - mins[best]!) best = i;
        }
        mins[best]! -= 120;
        maxs[best]! += 120;

        return {
            kind: 'door',
            mins,
            maxs,
            mover,
            target: null,
            damage: 0,
            wait: 0,
            nextFire: -1,
            model: -1,
            pushVelocity: null,
            centre: [0, 0, 0],
        };
    }

    /**
     * `SpawnPlatTrigger`: a box on top of the plat, from its lowered position
     * up to `pos2[2] + 8`.
     *
     * Q3 insets the box by 25% of the plat's width so standing on the very edge
     * does not trigger it; that inset is here because a plat that fires from
     * beside itself feels broken in a way players notice immediately.
     */
    private platTrigger(mover: Mover): Trigger {
        const insetX = (mover.maxs[0] - mover.mins[0]) * 0.25;
        const insetY = (mover.maxs[1] - mover.mins[1]) * 0.25;

        const mins: Vec3 = [mover.mins[0] + insetX, mover.mins[1] + insetY, mover.mins[2]];
        const maxs: Vec3 = [mover.maxs[0] - insetX, mover.maxs[1] - insetY, mover.maxs[2] + 8];

        // The box spans from the lowered position up, so a player standing on
        // the plat while it is down is inside it.
        mins[2] += mover.pos1[2] - 1;

        return {
            kind: 'plat',
            mins,
            maxs,
            mover,
            target: null,
            damage: 0,
            wait: 0,
            nextFire: -1,
            model: -1,
            pushVelocity: null,
            centre: [0, 0, 0],
        };
    }

    private spawnTrigger(
        kind: TriggerKind,
        entity: MoverEntity,
        model: number,
        mins: Vec3,
        maxs: Vec3
    ): void {
        this.triggers.push({
            kind,
            mins,
            maxs,
            mover: null,
            target: str(entity, 'target'),
            damage: num(entity, 'dmg', 5),
            // `trigger_hurt`'s default is to fire every frame; `trigger_multiple`'s
            // is half a second.
            wait: kind === 'hurt' ? 0 : Math.round(num(entity, 'wait', 0.5) * 1000),
            nextFire: -1,
            model,
            pushVelocity: null,
            centre: [
                (mins[0] + maxs[0]) * 0.5,
                (mins[1] + maxs[1]) * 0.5,
                (mins[2] + maxs[2]) * 0.5,
            ],
        });
    }

    /* ---- runtime ---- */

    /**
     * `Use_BinaryMover`.
     *
     * The two reversal cases are the interesting half. A mover interrupted
     * partway rewinds `trTime` by however much of the trajectory is already
     * behind it, so the reversed move starts from the current position at the
     * same speed. Restarting the trajectory instead would teleport the door.
     */
    use(mover: Mover): void {
        if (mover.state === MOVER_POS1) {
            this.setState(mover, MOVER_1TO2, this.timeMs + 50);
            this.events.moverSound(mover, 'start');
            return;
        }

        if (mover.state === MOVER_POS2) {
            // Already open: just push the close back.
            if (mover.wait >= 0) mover.returnAt = this.timeMs + mover.wait;
            return;
        }

        const total = mover.trDuration;
        let partial = this.timeMs - mover.trTime;
        if (partial > total) partial = total;
        if (partial < 0) partial = 0;

        if (mover.state === MOVER_2TO1) {
            this.setState(mover, MOVER_1TO2, this.timeMs - (total - partial));
        } else {
            this.setState(mover, MOVER_2TO1, this.timeMs - (total - partial));
        }

        this.events.moverSound(mover, 'start');
    }

    /** `SetMoverState`. */
    private setState(mover: Mover, state: MoverState, timeMs: number): void {
        mover.state = state;
        mover.trTime = timeMs;
        mover.returnAt = -1;
        moverOrigin(mover, this.timeMs, mover.origin);
    }

    /** `G_UseTargets`: everything with a matching `targetname` is used. */
    useTargets(target: string | null): void {
        if (target === null) return;

        for (const mover of this.byTargetname.get(target) ?? []) this.use(mover);
    }

    /**
     * Advance the simulation.
     *
     * @param playerMinsQ3 world-space player bounds, for trigger tests.
     * @returns the per-mover displacement since the previous call, which the
     *   caller needs in order to carry a player standing on a plat.
     */
    update(
        deltaSeconds: number,
        playerMinsQ3: ArrayLike<number>,
        playerMaxsQ3: ArrayLike<number>,
        alive: boolean
    ): void {
        /*
         Q3 runs the game at a fixed 50 ms server frame and every mover position
         is derived from an integer `level.time`. Accumulating whole
         milliseconds rather than adding a float keeps a door's endpoints exact:
         `trTime + trDuration` lands on the frame it should, not one either side.
        */
        this.accumulator += deltaSeconds * 1000;
        const steps = Math.floor(this.accumulator);
        this.accumulator -= steps;
        this.timeMs += steps;

        for (const mover of this.movers) {
            // `Reached_BinaryMover`.
            if (mover.state === MOVER_1TO2 && this.timeMs >= mover.trTime + mover.trDuration) {
                this.setState(mover, MOVER_POS2, this.timeMs);
                this.events.moverSound(mover, 'stop');
                this.useTargets(mover.target);
                if (mover.wait >= 0) mover.returnAt = this.timeMs + mover.wait;
            } else if (
                mover.state === MOVER_2TO1 &&
                this.timeMs >= mover.trTime + mover.trDuration
            ) {
                this.setState(mover, MOVER_POS1, this.timeMs);
                this.events.moverSound(mover, 'stop');
            }

            // `ReturnToPos1`, held off while something stands on a plat.
            if (
                mover.state === MOVER_POS2 &&
                mover.returnAt >= 0 &&
                this.timeMs >= mover.returnAt &&
                this.timeMs >= mover.holdOpenUntil
            ) {
                this.setState(mover, MOVER_2TO1, this.timeMs);
                this.events.moverSound(mover, 'start');
            }

            mover.previousOrigin[0] = mover.origin[0];
            mover.previousOrigin[1] = mover.origin[1];
            mover.previousOrigin[2] = mover.origin[2];

            moverOrigin(mover, this.timeMs, mover.origin);
        }

        if (!alive) return;

        for (const trigger of this.triggers) {
            if (!boxesOverlap(playerMinsQ3, playerMaxsQ3, trigger.mins, trigger.maxs)) continue;
            this.fire(trigger);
        }
    }

    private fire(trigger: Trigger): void {
        if (trigger.wait > 0 && this.timeMs < trigger.nextFire) return;
        trigger.nextFire = this.timeMs + trigger.wait;

        switch (trigger.kind) {
            case 'door': {
                const mover = trigger.mover!;
                // `Touch_DoorTrigger`: opening or open is left alone, so a door
                // does not restart every frame you stand in the doorway.
                if (mover.state !== MOVER_1TO2) this.use(mover);
                break;
            }

            case 'plat': {
                const mover = trigger.mover!;
                // `Touch_Plat` holds the plat up while you are on it.
                mover.holdOpenUntil = this.timeMs + 1000;
                if (mover.state === MOVER_POS1 || mover.state === MOVER_2TO1) this.use(mover);
                break;
            }

            case 'teleport': {
                const destination = this.destination(trigger.target);
                if (destination !== null) this.events.teleport(destination);
                break;
            }

            case 'hurt':
                this.events.hurt(trigger.damage);
                break;

            case 'push': {
                if (trigger.pushVelocity !== null) this.events.push(trigger.pushVelocity);
                break;
            }

            case 'multiple':
                this.useTargets(trigger.target);
                break;
        }
    }

    private destination(targetname: string | null): TeleportDestination | null {
        if (targetname === null) return null;
        return this.destinations.find((d) => d.targetname === targetname) ?? null;
    }

    /**
     * Everything the ported clipmap has to clip against: movers at their
     * current offset, plus stationary brush entities at zero.
     *
     * The physics backend needs no equivalent -- movers are kinematic bodies
     * and statics are static ones, so `shape_cast` finds both without being
     * told they exist.
     */
    get clipEntities(): readonly { readonly model: number; readonly origin: readonly number[] }[] {
        if (this.clipCache === null) {
            this.clipCache = [
                ...this.movers,
                ...this.statics.map((model) => ({ model, origin: [0, 0, 0] as const })),
            ];
        }
        return this.clipCache;
    }

    /** A button is used by touching it, per `Touch_Button`. */
    touchButtons(playerMinsQ3: ArrayLike<number>, playerMaxsQ3: ArrayLike<number>): void {
        for (const mover of this.movers) {
            if (mover.classname !== 'func_button') continue;
            if (mover.state !== MOVER_POS1) continue;

            const mins = this.scratch;
            mins[0] = mover.mins[0] + mover.origin[0];
            mins[1] = mover.mins[1] + mover.origin[1];
            mins[2] = mover.mins[2] + mover.origin[2];

            const maxs: Vec3 = [
                mover.maxs[0] + mover.origin[0],
                mover.maxs[1] + mover.origin[1],
                mover.maxs[2] + mover.origin[2],
            ];

            // A button is solid, so a touching player is adjacent rather than
            // overlapping. Q3 gets this from the trace that stopped the move;
            // a one-unit skin is the same test without a second trace.
            mins[0] -= 1; mins[1] -= 1; mins[2] -= 1;
            maxs[0] += 1; maxs[1] += 1; maxs[2] += 1;

            if (boxesOverlap(playerMinsQ3, playerMaxsQ3, mins, maxs)) this.use(mover);
        }
    }
}

/**
 * How far a player standing on or inside a mover should be displaced this frame.
 *
 * A reduction of `G_MoverPush`. Q3 pushes every entity whose `groundEntityNum`
 * is the mover, plus anything the mover's new bounds now intersect, and calls
 * `ent->blocked` if a push cannot be resolved. That machinery needs a server
 * entity list and a `takedamage` model that this port does not have, so the two
 * cases that matter to a single player are handled directly:
 *
 * - **Riding.** Feet within four units of the mover's top surface and
 *   horizontally inside it: carry by the full delta. Four units is Q3's own
 *   ground tolerance in `PM_GroundTrace`, so a player who counts as standing on
 *   a plat is a player the plat carries.
 * - **Being caught.** Box overlapping the mover's new bounds: displace by the
 *   delta, which is what a door closing on you does before Q3 decides whether
 *   to crush or reverse.
 *
 * What is deliberately missing is the crush. A Q3 door that cannot resolve a
 * push either damages the player for `dmg` or reverses; here it simply pushes,
 * so it is possible to be shoved into geometry. Recorded rather than papered
 * over -- the honest version of "movers work" is that riding and being pushed
 * work, and being crushed does not.
 */
export function carryDisplacement(
    movers: readonly Mover[],
    playerMinsQ3: ArrayLike<number>,
    playerMaxsQ3: ArrayLike<number>,
    out: Vec3
): boolean {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;

    let moved = false;

    for (const mover of movers) {
        const dx = mover.origin[0] - mover.previousOrigin[0];
        const dy = mover.origin[1] - mover.previousOrigin[1];
        const dz = mover.origin[2] - mover.previousOrigin[2];

        if (dx === 0 && dy === 0 && dz === 0) continue;

        const mins: Vec3 = [
            mover.mins[0] + mover.previousOrigin[0],
            mover.mins[1] + mover.previousOrigin[1],
            mover.mins[2] + mover.previousOrigin[2],
        ];
        const maxs: Vec3 = [
            mover.maxs[0] + mover.previousOrigin[0],
            mover.maxs[1] + mover.previousOrigin[1],
            mover.maxs[2] + mover.previousOrigin[2],
        ];

        const horizontallyInside =
            playerMaxsQ3[0]! > mins[0] && playerMinsQ3[0]! < maxs[0] &&
            playerMaxsQ3[1]! > mins[1] && playerMinsQ3[1]! < maxs[1];

        const standingOnTop =
            horizontallyInside &&
            playerMinsQ3[2]! >= maxs[2] - 1 &&
            playerMinsQ3[2]! <= maxs[2] + 4;

        if (standingOnTop || boxesOverlap(playerMinsQ3, playerMaxsQ3, mins, maxs)) {
            out[0] += dx;
            out[1] += dy;
            out[2] += dz;
            moved = true;
        }
    }

    return moved;
}
