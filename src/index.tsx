import React, { type ComponentType, type ReactNode, createContext, useContext, useEffect, useMemo } from "react"
import { useSnapshot } from "valtio"
import cloneDeep from "lodash.clonedeep"
import { createRouter } from "radix3"
import { proxy } from "valtio"

export type StagesDef<Stage, Event, Context> = {
  stage: Stage
  context: Context
  event?: Event
  nextEvents: Event[]
}
export type StageDef = { stage: string, context: any }
export type Stage<S extends StageDef> = S

const internal: unique symbol = Symbol.for('$internal')

export type Stager<
  S extends StageDef,
  T extends TransitionInstance<S>
> = {
  [internal]: {}
  start(is: S): void
  stop(): void

  transition: {
    transitioned: Promise<boolean> | undefined
    isTransitioning: boolean
    transitioning: [from: S['stage'], to: Array<S['stage']>] | undefined
    transitioningTo: (to: valueOrArrayValue<S['stage']>) => boolean
    transitioningFrom: (from: valueOrArrayValue<S['stage']>) => boolean
  }

  on: <X extends valueOrArrayValue<S['stage']>>(
    stage: X,
    cb: (stage: Extract<S, { stage: inferValueOrArrayValue<X> }>) => valueOrPromiseValue<void | (() => void)>
  ) => void

  dispatch: <N extends T['name'] | [S['stage'], S['stage']]>(
    ...params: [
      N,
      ...N extends T['name']
      ? ignoreFirstValue<Parameters<Extract<T, { name: N }>['execution']>>
      : any
    ]
  ) => Promise<void>

  withStager: <T extends { key?: string | number | null | undefined }>(Component: ComponentType<T>, initialContext: S) => ComponentType<T>
  Stager: (props: {
    children: ReactNode | ((props: S & { transition: Readonly<Stager<S, T>['transition']>, dispatch: Stager<S, T>['dispatch'] }) => ReactNode),
    initialStage: S
  }) => React.JSX.Element | null
  
  useStage: () => ReturnType<typeof useSnapshot<S>>
  useTransition: () => ReturnType<typeof useSnapshot<Stager<S, T>['transition']>>
  useListen: Stager<S, T>['on']
  
  Stage: <N extends S['stage']>(props: {
    stage: N
    children: ReactNode | ((props: Readonly<Extract<S, { stage: N }>> & {
      transition: Readonly<Stager<S, T>['transition']>,
      dispatch: Stager<S, T>['dispatch']
    }) => ReactNode)
  }) => React.JSX.Element | null
} & ({
  currentStage: undefined
  isRunning: false
} | {
  currentStage: S
  isRunning: true
})

type TransitionInstance<
  Stages extends StageDef,
  Event extends string = any,
  From extends valueOrArrayValue<string> = any,
  To extends valueOrArrayValue<string> = any,
  Params extends Array<any> = any
> = {
  name: Event
  from: From
  to: To
  execution: (
    executionCtx: Extract<Stages, { stage: inferValueOrArrayValue<From> }> & {
      dispatch: (target: string, ...params: any[]) => void
    },
    ...params: Params
  ) => valueOrPromiseValue<Extract<Stages, { stage: To extends Array<infer T> ? T : To }>> | valueOrPromiseValue<undefined> | valueOrPromiseValue<void>
}

export type NoTransition = {
  name: never
  from: never
  to: never
  execution: never
}

type StageListener<
  Stages extends StageDef,
  T extends TransitionInstance<Stages>
> = {
  stage: valueOrArrayValue<Stages['stage']>
  listener: (stage: Stages, dispatch: Stager<Stages, T>['dispatch']) => valueOrPromiseValue<void | (() => void)>
}

function isPromise(value: any): value is Promise<any> {
  return Boolean(value && typeof value.then === 'function');
}

type inferValueOrArrayValue<T> = T extends Array<infer V> ? V : T
type valueOrPromiseValue<V> = V | Promise<V>
type valueOrArrayValue<V> = V | Array<V>
type ignoreFirstValue<T> = T extends [any, ...infer R] ? R : T

export class StageBuilder<
  S extends StageDef,
  T extends TransitionInstance<S> = NoTransition
> {
  transitions: Array<TransitionInstance<S, any>> = []
  listeners: Array<StageListener<S, T>> = []

  transition<
    Event extends string,
    From extends valueOrArrayValue<S['stage']>,
    To extends valueOrArrayValue<S['stage']>,
    P extends unknown[]
  >(
    option: TransitionInstance<S, Event, From, To, P>
  ) {
    this.transitions.push(option)
    return this as StageBuilder<S, T | TransitionInstance<S, Event, From, To, P>>
  }

  on<N extends valueOrArrayValue<S['stage']>>(
    name: N,
    listener: (
      stage: Extract<S, { stage: inferValueOrArrayValue<N> }>,
      dispatch: Stager<S, T>['dispatch']
    ) => (void | Promise<void>)
  ) {
    const names = typeof name === 'string' ? [name] : [...name]
    this.listeners.push({ stage: names, listener })
    return this
  }

  clone(): StageBuilder<S, T> {
    const builder = cloneDeep(this)
    return builder
  }

  build(opts?: StagerOptions): Stager<S, T> {
    let transitions = cloneDeep(this.transitions)
    let listeners = cloneDeep(this.listeners)

    let transitionRouter = createRouter<TransitionInstance<S>>()
    const registerTransitions = () => {
      for (const transition of transitions) {
        const froms = Array.isArray(transition.from) ? transition.from : [transition.from]
        const tos = Array.isArray(transition.to) ? transition.to : [transition.to]
        transitionRouter.insert(`/event/${transition.name}`, transition)

        for (const from of froms) {
          for (const to of tos) {
            transitionRouter.insert(`/route/${from}/${to}`, transition)
          }
        }
      }
    }

    const registerListener = (register: StageListener<S, T>) => {
      for (const stage of register.stage) {
        let container = listenerRouters.lookup(`/listen/${stage}`)
        if (!container) {
          container = new Set()
          listenerRouters.insert(`/listen/${stage}`, container)
        }

        container.add(register)
      }

      return () => unregisterListener(register)
    }

    const unregisterListener = (register: StageListener<S, T>) => {
      for (const stage of register.stage) {
        let container = listenerRouters.lookup(`/listen/${stage}`)
        if (container) {
          container.delete(register)

          if (container.size === 0) {
            listenerRouters.remove(`/listen/${stage}`)
          }
        }
      }
    }

    let listenerRouters = createRouter<Set<StageListener<S, T>>>()
    const registerListeners = () => {
      for (const listenerRegister of listeners) {
        registerListener(listenerRegister)
      }
    }

    let unlisteners = new Set<() => void | Promise<void>>()
    const triggerUnlisteners = async () => {
      for (const unlistener of unlisteners) {
        await unlistener()
      }

      unlisteners.clear()
    }

    let resolve: (value: unknown) => void = () => { }

    const triggerEventListeners = async (stage: S['stage']) => {
      if (!stager.isRunning) return

      const matches = listenerRouters.lookup(`/listen/${stage}`)

      if (matches) {
        for (const { listener } of matches) {
          const unlistener = await listener(stager.currentStage, stager.dispatch)
          if (typeof unlistener === 'function') {
            unlisteners.add(unlistener)
          }
        }
      }
    }

    const triggerStageChanges = async (nextStage: S) => {
      if (!stager.isRunning) return

      if (nextStage.stage !== stager.currentStage.stage) {
        stager.currentStage.context = nextStage.context
        stager.currentStage.stage = nextStage.stage
        await triggerUnlisteners()
        await triggerEventListeners(nextStage.stage)
      } else {
        stager.currentStage.context = nextStage.context
      }
    }

    const stager: Stager<S, T> = proxy({
      [internal]: {
        transitionRouter, listenerRouters, unlisteners
      },
      isRunning: false,
      start: (is) => {
        stager.currentStage = cloneDeep(is)
        stager.isRunning = true
        registerListeners()
        registerTransitions()
        triggerEventListeners(stager.currentStage.stage)
      },
      stop: () => {
        stager.isRunning = false
      },
      currentStage: undefined,
      transition: {
        transitioned: undefined,
        isTransitioning: false,
        transitioning: undefined,
        transitioningTo(to) {
          if (!stager.isRunning) return false
          if (stager.transition.transitioning === undefined) return false

          const targetTo: string[] = Array.isArray(to)
            ? to
            : [to]
          return !!targetTo.find(to => stager.transition.transitioning?.[1].includes(to))
        },
        transitioningFrom(from) {
          if (!stager.isRunning) return false
          if (stager.transition.transitioning === undefined) return false
          const targetFrom: string[] = Array.isArray(from)
            ? from
            : [from]

          return targetFrom.includes(stager.currentStage.stage)
        },
      },
      async dispatch(name, ...params) {
        if (!stager.isRunning) return

        let transition: TransitionInstance<S> | null

        if (typeof name === 'string') {
          transition = transitionRouter.lookup(`/event/${name}`)
        } else {
          const [from, to] = name as [string, string]
          transition = transitionRouter.lookup(`/route/${from}/${to}`)
        }

        if (!transition) {
          console.log(`cannot find transition for, ${name}`)
          return
        }

        const targetFrom: string[] = Array.isArray(transition.from)
          ? transition.from
          : [transition.from]

        const targetTo: string[] = Array.isArray(transition.to)
          ? transition.to
          : [transition.to]

        if (!targetFrom.includes(stager.currentStage.stage)) {
          console.log(`from condition doesn't match`, transition.from, stager.currentStage.stage)
          return
        }

        if (!targetTo.find(to => transitionRouter.lookup(`/route/${stager.currentStage.stage}/${to}`))) {
          console.log(`to condition doesn't match`, transition.to)
          return
        }

        stager.transition.transitioning = [stager.currentStage.stage, targetTo]
        stager.transition.isTransitioning = stager.transition.transitioning !== undefined
        stager.transition.transitioned = new Promise((resolved) => { resolve = resolved })

        const transitionResult: S | undefined | Promise<S | undefined> = transition.execution.apply(undefined, [{
          ...stager.currentStage,
          dispatch: stager.dispatch
        }, ...params])

        if (isPromise(transitionResult)) {
          const result = await transitionResult
          if (result) {
            await triggerStageChanges(result)
          }
        } else {
          if (transitionResult) {
            await triggerStageChanges(transitionResult)
          }
        }

        stager.transition.transitioning = undefined
        stager.transition.isTransitioning = stager.transition.transitioning !== undefined
        resolve(null)
      },
      on(stage, cb) {
        const names = typeof stage === 'string' ? [stage] : stage
        return registerListener({ stage: names, listener: cb })
      },
      withStager(Component, is) {
        return (props: any) => {
          return (
            <stager.Stager initialStage={is}>
              <Component {...props} />
            </stager.Stager>
          )
        }
      },
      useStage() {
        const stager = useContext(reactContext)
  
        if (!stager) {
          throw new Error('stage context must be used within `withStager`')
        }
  
        if (!stager.isRunning) {
          throw new Error('invalid running state')
        }
  
        return useSnapshot(stager.currentStage)
      },
      useListen(stage, cb) {
        const names = typeof stage === 'string' ? [stage] : stage
  
        useEffect(() => {
          return stager.on(names, cb as any)
        }, [])
      },
      useTransition() {
        const stager = useContext(reactContext)
  
        if (!stager) {
          throw new Error('stage context must be used within `withStager`')
        }
  
        return useSnapshot(stager.transition)
      },
      Stage: ({ stage: name, children }) => {
        const stager = useContext(reactContext)
  
        if (!stager) {
          throw new Error('stage context must be used within `withStager`')
        }
  
        if (!stager.isRunning) {
          throw new Error('invalid running state')
        }
  
        const transition = useSnapshot(stager.transition)
        const { context, stage } = useSnapshot(stager.currentStage)
  
        if (stager.currentStage.stage !== name) return null
        else {
          return <>
            {
              typeof children === 'function'
                ? children({ transition, context, stage, dispatch: stager.dispatch } as any)
                : children
            }
          </>
        }
      },
      Stager: ({ children, initialStage }) => {
        const instance = useMemo(() => {
          stager.start(initialStage)
  
          if (!stager.isRunning) {
            throw new Error('type assertions')
          }
  
          return stager
        }, [initialStage])
  
        useEffect(() => {
          return () => {
            stager.stop()
          }
        }, [initialStage])
  
        const transition = useSnapshot(instance.transition)
        const { context, stage } = useSnapshot(instance.currentStage)
  
        return (
          <reactContext.Provider value={stager}>
            {
              typeof children === 'function'
                ? children({ transition, context, stage, dispatch: stager.dispatch } as any)
                : children
            }
          </reactContext.Provider>
        )
      }
    })
    const reactContext = createContext<Stager<S, T> | undefined>(undefined)
    return stager
  }
}

type StagerOptions = {}
export const create = <S extends StageDef>() => new StageBuilder<S>()