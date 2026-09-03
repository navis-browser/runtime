/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const TOP_LEVEL_FRAME_MEMORY_WEIGHT = 2;
export const SUBFRAME_MEMORY_WEIGHT = 1;

/**
 * Estimate each tab's share of the processes containing its frames.
 *
 * A top-level frame receives twice the weight of a subframe, matching the
 * allocation model Gecko uses when ranking tabs for memory-pressure unloads.
 * Shared process memory is divided instead of being counted once per tab.
 *
 * @param {Map<object, Map<number, number>>} tabProcessWeights
 *   Frame weights keyed first by tab and then by operating-system process ID.
 * @param {Map<number, number>} processMemory
 *   Process memory in bytes, keyed by operating-system process ID.
 * @returns {Map<object, object>} Per-tab estimated memory snapshots.
 */
export function allocateTabMemory(tabProcessWeights, processMemory) {
  const totalWeights = new Map();
  for (const weights of tabProcessWeights.values()) {
    for (const [pid, weight] of weights) {
      if (
        Number.isInteger(pid) &&
        pid > 0 &&
        Number.isFinite(weight) &&
        weight > 0
      ) {
        totalWeights.set(pid, (totalWeights.get(pid) || 0) + weight);
      }
    }
  }

  const result = new Map();
  for (const [tab, weights] of tabProcessWeights) {
    let bytes = 0;
    let processCount = 0;
    for (const [pid, weight] of weights) {
      const memory = processMemory.get(pid);
      const totalWeight = totalWeights.get(pid);
      if (
        !Number.isFinite(memory) ||
        memory < 0 ||
        !Number.isFinite(weight) ||
        weight <= 0 ||
        !totalWeight
      ) {
        continue;
      }
      bytes += (memory * weight) / totalWeight;
      processCount++;
    }
    result.set(
      tab,
      processCount
        ? Object.freeze({
            available: true,
            bytes: Math.round(bytes),
            processCount,
            estimated: true,
          })
        : Object.freeze({
            available: false,
            bytes: 0,
            processCount: 0,
            estimated: true,
          })
    );
  }
  return result;
}
