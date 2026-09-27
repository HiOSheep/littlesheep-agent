// The renderer's one computation of the composer's model availability.
//
// Three surfaces have to agree about it - the picker's trigger and empty menu,
// the send entry, and the empty conversation copy - and they live in two
// different views. Deriving it once here, where the controller already holds the
// inputs, is what keeps them from disagreeing; the rule itself stays in
// `runtime-availability.ts`.

import { useMemo } from 'react'
import type { RuntimeProvider, RuntimeState } from '../../shared/runtime-api-contracts'
import { describeRuntimeAvailability, type RuntimeAvailability } from './runtime-availability'

export interface ModelAvailabilityInput {
  runtime: RuntimeState | null
  /** With a null runtime this means the configuration could not be read. */
  runtimeError: string | null
  selectableProviders: readonly RuntimeProvider[]
  /** The resolved selection, or null when nothing selectable is selected. */
  selectedModel: { ref: string } | null
}

export function useModelAvailability(input: ModelAvailabilityInput): RuntimeAvailability {
  const { runtime, runtimeError, selectableProviders, selectedModel } = input
  return useMemo(() => describeRuntimeAvailability({
    runtime,
    runtimeError,
    selectableProviderCount: selectableProviders.length,
    hasSelectableModel: selectedModel !== null,
  }), [runtime, runtimeError, selectableProviders, selectedModel])
}
