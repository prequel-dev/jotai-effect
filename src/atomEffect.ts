import type { Atom, Getter, Setter, WritableAtom } from 'jotai/vanilla'
import { atom } from 'jotai/vanilla'
import type {
  INTERNAL_AtomState as AtomState,
  INTERNAL_buildStoreRev1 as buildStore,
} from 'jotai/vanilla/internals'
import {
  INTERNAL_getBuildingBlocksRev1 as INTERNAL_getBuildingBlocks,
  INTERNAL_hasInitialValue as hasInitialValue,
  INTERNAL_initializeStoreHooks as initializeStoreHooks,
  INTERNAL_isAtomStateInitialized as isAtomStateInitialized,
  INTERNAL_isSelfAtom as isSelfAtom,
  INTERNAL_returnAtomValue as returnAtomValue,
  INTERNAL_setAtomStateValueOrPromise as setAtomStateValueOrPromise,
} from 'jotai/vanilla/internals'
import { isDev } from './env'
import { logDebug } from '@prequel-dev/logger'

function getBuildingBlocks(store: Store) {
  logDebug('getBuildingBlocks called', { store: store.constructor.name }); // DEBUG: Log building blocks access
  const buildingBlocks = INTERNAL_getBuildingBlocks(store)
  return [
    buildingBlocks[1], // mountedAtoms (mountedMap)
    buildingBlocks[3], // changedAtoms
    initializeStoreHooks(buildingBlocks[6]), // storeHooks
    buildingBlocks[10], // ensureAtomState
    buildingBlocks[13], // readAtomState
    buildingBlocks[15], // writeAtomState
    buildingBlocks[16], // mountDependencies
    buildingBlocks[14], // invalidateDependents
    buildingBlocks[12], // recomputeInvalidatedAtoms
    buildingBlocks[11], // flushCallbacks
  ] as const
}

type Store = ReturnType<typeof buildStore>

type AnyAtom = Atom<unknown>

type GetterWithPeek = Getter & { peek: Getter }

type SetterWithRecurse = Setter & { recurse: Setter }

type Cleanup = () => void

export type Effect = (
  get: GetterWithPeek,
  set: SetterWithRecurse
) => void | Cleanup

type Ref = [
  dependencies: Set<AnyAtom>,
  atomState: AtomState<void>,
  mountedAtoms: Map<AnyAtom, AtomState<void>>,
]

export function atomEffect(effect: Effect): Atom<void> & { effect: Effect } {
  logDebug('atomEffect created', { effect: effect.toString().slice(0, 100) }); // DEBUG: Log effect creation
  
  const refAtom = atom<Partial<Ref>>(() => [])

  const effectAtom = atom(function effectAtomRead(get) {
    logDebug('effectAtomRead called', { effectAtom: effectAtom.debugLabel }); // DEBUG: Log effect read
    const [dependencies, atomState, mountedAtoms] = get(refAtom)
    if (mountedAtoms!.has(effectAtom)) {
      logDebug('effectAtomRead: mounted, getting dependencies', { depsCount: dependencies?.size }); // DEBUG: Log dependency access
      dependencies!.forEach(get)
      ++atomState!.n
    }
  }) as Atom<void> & { effect: Effect }

  effectAtom.effect = effect

  effectAtom.unstable_onInit = (store) => {
    logDebug('unstable_onInit called', { store: store.constructor.name, effectAtom: effectAtom.debugLabel }); // DEBUG: Log init
    const deps = new Set<AnyAtom>()
    let inProgress = 0
    let isRecursing = false
    let hasChanged = false
    let fromCleanup = false
    let runCleanup: (() => void) | undefined

    function runEffect() {
      logDebug('runEffect called', { inProgress, isRecursing, fromCleanup, effectAtom: effectAtom.debugLabel }); // DEBUG: Log effect execution
      if (inProgress) {
        logDebug('runEffect: already in progress, returning'); // DEBUG: Log early return
        return
      }
      deps.clear()
      let isSync = true

      const getter: GetterWithPeek = (a) => {
        logDebug('getter called', { atom: a.debugLabel, fromCleanup, isSync }); // DEBUG: Log getter calls
        if (fromCleanup) {
          return store.get(a)
        }
        if (isSelfAtom(effectAtom, a)) {
          logDebug('getter: self atom access'); // DEBUG: Log self atom access
          const aState = ensureAtomState(a)
          if (!isAtomStateInitialized(aState)) {
            if (hasInitialValue(a)) {
              setAtomStateValueOrPromise(a, a.init, ensureAtomState)
            } else {
              // NOTE invalid derived atoms can reach here
              logDebug('getter: throwing no atom init error'); // DEBUG: Log error case
              throw new Error('no atom init')
            }
          }
          return returnAtomValue(aState)
        }
        // a !== atom
        const aState = readAtomState(a)
        try {
          return returnAtomValue(aState)
        } finally {
          atomState.d.set(a, aState.n)
          mountedAtoms.get(a)?.t.add(effectAtom)
          if (isSync) {
            logDebug('getter: adding sync dependency', { atom: a.debugLabel }); // DEBUG: Log sync dependency
            deps.add(a)
          } else {
            if (mountedAtoms.has(a)) {
              logDebug('getter: async dependency, mounting and recomputing'); // DEBUG: Log async dependency
              mountDependencies(effectAtom)
              recomputeInvalidatedAtoms()
              flushCallbacks()
            }
          }
        }
      }

      getter.peek = store.get

      const setter: SetterWithRecurse = <V, As extends unknown[], R>(
        a: WritableAtom<V, As, R>,
        ...args: As
      ) => {
        logDebug('setter called', { atom: a.debugLabel, args, inProgress, isSync }); // DEBUG: Log setter calls
        const aState = ensureAtomState(a)
        try {
          ++inProgress
          if (isSelfAtom(effectAtom, a)) {
            logDebug('setter: self atom write'); // DEBUG: Log self atom write
            if (!hasInitialValue(a)) {
              // NOTE technically possible but restricted as it may cause bugs
              logDebug('setter: throwing atom not writable error'); // DEBUG: Log error case
              throw new Error('atom not writable')
            }
            const prevEpochNumber = aState.n
            const v = args[0] as V
            setAtomStateValueOrPromise(a, v, ensureAtomState)
            mountDependencies(a)
            if (prevEpochNumber !== aState.n) {
              logDebug('setter: atom changed, invalidating dependents'); // DEBUG: Log atom change
              changedAtoms.add(a)
              storeHooks.c?.(a)
              invalidateDependents(a)
            }
            return undefined as R
          } else {
            logDebug('setter: external atom write'); // DEBUG: Log external atom write
            return writeAtomState(a, ...args)
          }
        } finally {
          if (!isSync) {
            logDebug('setter: async mode, recomputing and flushing'); // DEBUG: Log async cleanup
            recomputeInvalidatedAtoms()
            flushCallbacks()
          }
          --inProgress
        }
      }

      setter.recurse = (a, ...args) => {
        logDebug('setter.recurse called', { atom: a.debugLabel, fromCleanup }); // DEBUG: Log recurse calls
        if (fromCleanup) {
          if (isDev()) {
            logDebug('setter.recurse: throwing error in cleanup'); // DEBUG: Log error case
            throw new Error('set.recurse is not allowed in cleanup')
          }
          return undefined as any
        }
        try {
          isRecursing = true
          mountDependencies(effectAtom)
          return setter(a, ...args)
        } finally {
          recomputeInvalidatedAtoms()
          isRecursing = false
          if (hasChanged) {
            logDebug('setter.recurse: hasChanged, running effect again'); // DEBUG: Log recursive effect
            hasChanged = false
            runEffect()
          }
        }
      }

      try {
        logDebug('runEffect: calling cleanup if exists'); // DEBUG: Log cleanup execution
        runCleanup?.()
        logDebug('runEffect: calling effect function'); // DEBUG: Log effect function call
        const cleanup = effectAtom.effect(getter, setter)
        if (typeof cleanup !== 'function') {
          logDebug('runEffect: no cleanup function returned'); // DEBUG: Log no cleanup
          return
        }
        logDebug('runEffect: cleanup function returned, setting up'); // DEBUG: Log cleanup setup
        runCleanup = () => {
          logDebug('runCleanup called', { inProgress }); // DEBUG: Log cleanup execution
          if (inProgress) {
            logDebug('runCleanup: in progress, returning'); // DEBUG: Log early return
            return
          }
          try {
            isSync = true
            fromCleanup = true
            return cleanup()
          } finally {
            isSync = false
            fromCleanup = false
            runCleanup = undefined
          }
        }
      } finally {
        logDebug('runEffect: finally block, setting up dependencies'); // DEBUG: Log finally block
        isSync = false
        deps.forEach((depAtom) => {
          logDebug('runEffect: setting dependency', { atom: depAtom.debugLabel }); // DEBUG: Log dependency setup
          atomState.d.set(depAtom, ensureAtomState(depAtom).n)
        })
        mountDependencies(effectAtom)
        recomputeInvalidatedAtoms()
      }
    }

    const [
      mountedAtoms,
      changedAtoms,
      storeHooks,
      ensureAtomState,
      readAtomState,
      writeAtomState,
      mountDependencies,
      invalidateDependents,
      recomputeInvalidatedAtoms,
      flushCallbacks,
    ] = getBuildingBlocks(store)
    logDebug('building blocks retrieved', { 
      mountedAtomsSize: mountedAtoms.size,
      changedAtomsSize: changedAtoms.size,
      hasStoreHooks: !!storeHooks
    }); // DEBUG: Log building blocks
    
    const atomEffectChannel = ensureAtomEffectChannel(store)
    const atomState = ensureAtomState(effectAtom)
    // initialize atomState
    atomState.v = undefined

    Object.assign(store.get(refAtom), [deps, atomState, mountedAtoms])

    storeHooks.m.add(effectAtom, function atomOnMount() {
      logDebug('atomOnMount called', { effectAtom: effectAtom.debugLabel }); // DEBUG: Log mount
      // mounted
      atomEffectChannel.add(runEffect)
      if (runCleanup) {
        atomEffectChannel.delete(runCleanup)
      }
    })

    storeHooks.u.add(effectAtom, function atomOnUnmount() {
      logDebug('atomOnUnmount called', { effectAtom: effectAtom.debugLabel }); // DEBUG: Log unmount
      // unmounted
      atomEffectChannel.delete(runEffect)
      if (runCleanup) {
        atomEffectChannel.add(runCleanup)
      }
    })

    storeHooks.c.add(effectAtom, function atomOnUpdate() {
      logDebug('atomOnUpdate called', { effectAtom: effectAtom.debugLabel, isRecursing }); // DEBUG: Log update
      // changed
      if (isRecursing) {
        logDebug('atomOnUpdate: isRecursing, setting hasChanged'); // DEBUG: Log recursive change
        hasChanged = true
      } else {
        logDebug('atomOnUpdate: adding runEffect to channel'); // DEBUG: Log normal update
        atomEffectChannel.add(runEffect)
      }
    })
  }

  if (isDev()) {
    Object.defineProperty(refAtom, 'debugLabel', {
      get: () =>
        effectAtom.debugLabel ? `${effectAtom.debugLabel}:ref` : undefined,
      configurable: true,
      enumerable: true,
    })
    refAtom.debugPrivate = true
  }

  return effectAtom
}

type AtomEffectChannel = Set<() => void>
const atomEffectChannelStoreMap = new WeakMap<Store, AtomEffectChannel>()

function ensureAtomEffectChannel(store: Store): AtomEffectChannel {
  logDebug('ensureAtomEffectChannel called', { store: store.constructor.name }); // DEBUG: Log channel creation
  const storeHooks = getBuildingBlocks(store)[2]
  let atomEffectChannel = atomEffectChannelStoreMap.get(store)
  if (!atomEffectChannel) {
    logDebug('creating new atomEffectChannel'); // DEBUG: Log new channel
    atomEffectChannel = new Set()
    atomEffectChannelStoreMap.set(store, atomEffectChannel)
    storeHooks.f.add(function storeOnFlush() {
      logDebug('storeOnFlush called', { channelSize: atomEffectChannel!.size }); // DEBUG: Log flush
      // flush
      for (const fn of atomEffectChannel!) {
        logDebug('storeOnFlush: executing function', { fn: fn.toString().slice(0, 100) }); // DEBUG: Log function execution
        atomEffectChannel!.delete(fn)
        try {
          fn()
        } catch (error) {
          logDebug('storeOnFlush: function execution error', { error }); // DEBUG: Log execution errors
          throw error
        }
      }
    })
  }
  return atomEffectChannel
}
