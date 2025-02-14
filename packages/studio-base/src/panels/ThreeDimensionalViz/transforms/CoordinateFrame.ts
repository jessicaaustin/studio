// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/* eslint-disable no-underscore-dangle */
/* eslint-disable @foxglove/no-boolean-parameters */

import { mat4 } from "gl-matrix";

import { AVLTree } from "@foxglove/avl";
import {
  Duration,
  Time,
  compare,
  subtract,
  areEqual,
  interpolate,
  percentOf,
  isLessThan,
} from "@foxglove/rostime";
import { MutablePose, Pose } from "@foxglove/studio-base/types/Messages";

import { Transform } from "./Transform";
import { mat4Identity } from "./geometry";

type TimeAndTransform = [time: Time, transform: Transform];

const DEFAULT_MAX_STORAGE_TIME: Duration = { sec: 10, nsec: 0 };

const tempLower: TimeAndTransform = [{ sec: 0, nsec: 0 }, Transform.Identity()];
const tempUpper: TimeAndTransform = [{ sec: 0, nsec: 0 }, Transform.Identity()];
const tempTransform = Transform.Identity();
const tempMatrix = mat4Identity();

/**
 * CoordinateFrame is a named 3D coordinate frame with an optional parent frame
 * and a history of transforms from this frame to its parent. The parent/child
 * hierarchy and transform history allow points to be transformed from one
 * coordinate frame to another while interpolating over time.
 */
export class CoordinateFrame {
  readonly id: string;
  maxStorageTime: Duration;

  private _parent?: CoordinateFrame;
  private _transforms: AVLTree<Time, Transform> = new AVLTree<Time, Transform>(compare);

  constructor(
    id: string,
    parent: CoordinateFrame | undefined,
    maxStorageTime: Duration = DEFAULT_MAX_STORAGE_TIME,
  ) {
    this.id = id;
    this._parent = parent;
    this.maxStorageTime = maxStorageTime;
  }

  parent(): CoordinateFrame | undefined {
    return this._parent;
  }

  /**
   * Returns the top-most frame by walking up each parent frame. If the current
   * frame does not have a parent, the current frame is returned.
   */
  root(): CoordinateFrame {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let root: CoordinateFrame = this;
    while (root._parent) {
      root = root._parent;
    }
    return root;
  }

  /**
   * Set the parent frame for this frame. If the parent frame is already set to
   * a different frame, an error is thrown.
   */
  setParent(parent: CoordinateFrame): void {
    if (this._parent && this._parent !== parent) {
      throw new Error(
        `Cannot reparent frame "${this.id}" from "${this._parent.id}" to "${parent.id}"`,
      );
    }
    this._parent = parent;
  }

  /**
   * Search for an ancestor frame with the given ID by walking up the chain of
   * parent frames, starting at the current frame.
   * @param id Frame ID to search for
   * @returns The ancestor frame, or undefined if not found
   */
  findAncestor(id: string): CoordinateFrame | undefined {
    let ancestor: CoordinateFrame | undefined = this._parent;
    while (ancestor) {
      if (ancestor.id === id) {
        return ancestor;
      }
      ancestor = ancestor._parent;
    }
    return undefined;
  }

  /**
   * Add a transform to the transform history maintained by this frame. The
   * difference between the newest and oldest timestamps cannot be more than
   * `this.maxStorageTime`, so this addition may purge older transforms.
   *
   * If a transform with an identical timestamp already exists, it is replaced.
   */
  addTransform(time: Time, transform: Transform): void {
    this._transforms.set(time, transform);

    // Remove transforms that are too old
    const endTime = this._transforms.maxKey()!;
    const startTime = subtract(endTime, this.maxStorageTime);
    while (this._transforms.size > 1 && isLessThan(this._transforms.minKey()!, startTime)) {
      this._transforms.shift();
    }
  }

  /**
   * Find the closest transform(s) in the transform history to the given time.
   * Note that if an exact match is found, both `outLower` and `outUpper` will
   * be set to the same transform.
   * @param outLower This will be set to the found transform with the closest
   *   timestamp <= the given time
   * @param outUpper This will be set to the found transform with the closest
   *   timestamp >= the given time
   * @param time Time to search for
   * @param maxDelta The time parameter can exceed the bounds of the transform
   *   history by up to this amount and still clamp to the oldest or newest
   *   transform
   * @returns True if the search was successful
   */
  findClosestTransforms(
    outLower: TimeAndTransform,
    outUpper: TimeAndTransform,
    time: Time,
    maxDelta: Duration,
  ): boolean {
    // perf-sensitive: function params instead of options object to avoid allocations
    if (this._transforms.size === 0) {
      return false;
    }

    // If only a single transform exists, check if it's within the maxDelta
    if (this._transforms.size === 1) {
      const [latestTime, latestTf] = this._transforms.maxEntry()!;
      if (isDiffWithinDelta(time, latestTime, maxDelta)) {
        outLower[0] = outUpper[0] = latestTime;
        outLower[1] = outUpper[1] = latestTf;
        return true;
      }
      return false;
    }

    const lte = this._transforms.findLessThanOrEqual(time);

    // If the time is before the first transform, check if the first transform is within maxDelta
    if (!lte) {
      const [firstTime, firstTf] = this._transforms.minEntry()!;
      if (isDiffWithinDelta(time, firstTime, maxDelta)) {
        outLower[0] = outUpper[0] = firstTime;
        outLower[1] = outUpper[1] = firstTf;
        return true;
      }
      return false;
    }

    const [lteTime, lteTf] = lte;

    // Check if an exact match was found
    if (areEqual(lteTime, time)) {
      outLower[0] = outUpper[0] = lteTime;
      outLower[1] = outUpper[1] = lteTf;
      return true;
    }

    const gt = this._transforms.findGreaterThan(time);

    // If the time is after the last transform, check if the last transform is within maxDelta
    if (!gt) {
      const [lastTime, lastTf] = this._transforms.maxEntry()!;
      if (isDiffWithinDelta(time, lastTime, maxDelta)) {
        outLower[0] = outUpper[0] = lastTime;
        outLower[1] = outUpper[1] = lastTf;
        return true;
      }
      return false;
    }

    // Return the transforms closest to the requested time
    const [gtTime, gtTf] = gt;
    outLower[0] = lteTime;
    outLower[1] = lteTf;
    outUpper[0] = gtTime;
    outUpper[1] = gtTf;
    return true;
  }

  /**
   * Compute the transform from `srcFrame` to this frame at the given time,
   * represented as a pose object. If srcFrame has a transform translation at
   * the given time of <1, 0, 0>, then <1, 0, 0> will be returned. That
   * translation can be applied to a point in `srcFrame` to move it into this
   * frame.
   *
   * Transforms can go up through multiple parents, down through one or more
   * children, or both as long as the transforms share a common ancestor.
   *
   * A common variable naming convention for the returned pose is
   * `thisFrame_T_srcFrame` which is read right-to-left as "the translation that
   * moves a point from `srcFrame` to `thisFrame`".
   * @param out Output pose, this will be modified with the result on success
   * @param input Input pose that exists in `srcFrame`
   * @param srcFrame Coordinate frame we are transforming from
   * @param time Time to compute the transform at
   * @param maxDelta The time parameter can exceed the bounds of the transform
   *   history by up to this amount and still clamp to the oldest or newest
   *   transform
   * @returns A reference to `out` on success, otherwise undefined
   */
  apply(
    out: MutablePose,
    input: Pose,
    srcFrame: CoordinateFrame,
    time: Time,
    maxDelta: Duration = { sec: 1, nsec: 0 },
  ): MutablePose | undefined {
    // perf-sensitive: function params instead of options object to avoid allocations
    if (srcFrame === this) {
      // Identity transform
      out.position = input.position;
      out.orientation = input.orientation;
      return out;
    } else if (srcFrame.findAncestor(this.id)) {
      // This frame is a parent of the source frame
      return CoordinateFrame.Apply(out, input, this, srcFrame, false, time, maxDelta)
        ? out
        : undefined;
    } else if (this.findAncestor(srcFrame.id)) {
      // This frame is a child of the source frame
      return CoordinateFrame.Apply(out, input, srcFrame, this, true, time, maxDelta)
        ? out
        : undefined;
    }

    // Check if the two frames share a common parent
    let curSrcFrame: CoordinateFrame | undefined = srcFrame;
    while (curSrcFrame) {
      const commonParent = this.findAncestor(curSrcFrame.id);
      if (commonParent) {
        // Common parent found. Apply transforms from the source frame to the common parent,
        // then apply transforms from the common parent to this frame
        if (!CoordinateFrame.Apply(out, input, commonParent, srcFrame, false, time, maxDelta)) {
          return undefined;
        }
        return CoordinateFrame.Apply(out, out, commonParent, this, true, time, maxDelta)
          ? out
          : undefined;
      }
      curSrcFrame = curSrcFrame._parent;
    }

    return undefined;
  }

  /**
   * Interpolate between two [time, transform] pairs.
   * @param outTime Optional output parameter for the interpolated time
   * @param outTf Output parameter for the interpolated transform
   * @param lower Start [time, transform]
   * @param upper End [time, transform]
   * @param time Interpolant in the range [lower[0], upper[0]]
   * @returns
   */
  static Interpolate(
    outTime: Time | undefined,
    outTf: Transform,
    lower: TimeAndTransform,
    upper: TimeAndTransform,
    time: Time,
  ): void {
    // perf-sensitive: function params instead of options object to avoid allocations
    const [lowerTime, lowerTf] = lower;
    const [upperTime, upperTf] = upper;

    if (areEqual(lowerTime, upperTime)) {
      if (outTime) {
        copyTime(outTime, upperTime);
      }
      outTf.copy(upperTf);
      return;
    }

    // Interpolate times and transforms
    const fraction = Math.max(0, Math.min(1, percentOf(lowerTime, upperTime, time)));
    if (outTime) {
      copyTime(outTime, interpolate(lowerTime, upperTime, fraction));
    }
    Transform.Interpolate(outTf, lowerTf, upperTf, fraction);
  }

  /**
   * Get the transform `parentFrame_T_childFrame` (from child to parent) at the
   * given time.
   * @param out Output transform matrix
   * @param parentFrame Parent destination frame
   * @param childFrame Child source frame
   * @param time Time to transform at
   * @param maxDelta The time parameter can exceed the bounds of the transform
   *   history by up to this amount and still clamp to the oldest or newest
   *   transform
   * @returns True on success
   */
  static GetTransformMatrix(
    out: mat4,
    parentFrame: CoordinateFrame,
    childFrame: CoordinateFrame,
    time: Time,
    maxDelta: Duration,
  ): boolean {
    // perf-sensitive: function params instead of options object to avoid allocations
    mat4.identity(out);

    let curFrame = childFrame;
    while (curFrame !== parentFrame) {
      if (!curFrame.findClosestTransforms(tempLower, tempUpper, time, maxDelta)) {
        return false;
      }
      CoordinateFrame.Interpolate(undefined, tempTransform, tempLower, tempUpper, time);
      mat4.multiply(out, tempTransform.matrix(), out);

      if (curFrame._parent == undefined) {
        throw new Error(`Frame "${parentFrame.id}" is not a parent of "${childFrame.id}"`);
      }
      curFrame = curFrame._parent;
    }

    return true;
  }

  /**
   * Apply the transform from `child` to `parent` at the given time to the given
   * input pose. The transform can optionally be inverted, to go from `parent`
   * to `child`.
   * @param out Output pose, this will be modified with the result on success
   * @param input Input pose that exists in `child`, or `parent` if `invert` is
   *   true
   * @param parent Parent frame
   * @param child Child frame
   * @invert Whether to invert the transform (go from parent to child)
   * @param time Time to compute the transform at
   * @param maxDelta The time parameter can exceed the bounds of the transform
   *   history by up to this amount and still clamp to the oldest or newest
   *   transform
   * @returns True on success
   */
  static Apply(
    out: MutablePose,
    input: Pose,
    parent: CoordinateFrame,
    child: CoordinateFrame,
    invert: boolean,
    time: Time,
    maxDelta: Duration,
  ): boolean {
    // perf-sensitive: function params instead of options object to avoid allocations
    if (!CoordinateFrame.GetTransformMatrix(tempMatrix, parent, child, time, maxDelta)) {
      return false;
    }
    if (invert) {
      // Remove the translation component, leaving only a rotation matrix
      const x = tempMatrix[12];
      const y = tempMatrix[13];
      const z = tempMatrix[14];
      tempMatrix[12] = 0;
      tempMatrix[13] = 0;
      tempMatrix[14] = 0;

      // The transpose of a rotation matrix is its inverse
      mat4.transpose(tempMatrix, tempMatrix);

      // The negatation of the translation is its inverse
      tempMatrix[12] = -x;
      tempMatrix[13] = -y;
      tempMatrix[14] = -z;
    }

    tempTransform.setPose(input);
    mat4.multiply(tempMatrix, tempMatrix, tempTransform.matrix());
    tempTransform.setMatrix(tempMatrix);
    tempTransform.toPose(out);
    return true;
  }
}

function copyTime(out: Time, time: Time): void {
  out.sec = time.sec;
  out.nsec = time.nsec;
}

function isDiffWithinDelta(timeA: Time, timeB: Time, delta: Duration): boolean {
  const diff = subtract(timeA, timeB);
  diff.sec = Math.abs(diff.sec);
  return compare(diff, delta) <= 0;
}
