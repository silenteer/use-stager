import { createRouter } from "radix3"

export type StagesDef<Stage, Event, Context> = {
  stage: Stage
  context: Context
  event?: Event
  nextEvents: Event[]
}

export type StageDef = {
  stage: string
  context: any
}

export type Stage<S extends StageDef> = S

type NoTransition = {
  name: never
  from: never
  to: never
  execution: never
}

type inferValueOrArrayValue<T> = T extends Array<infer V> ? V : T
type valueOrPromiseValue<V> = V | Promise<V>
type valueOrArrayValue<V> = V | Array<V>
type ignoreFirstValue<T> = T extends [any, ...infer R] ? R : T

type Stager<
  S extends StageDef, 
  T extends TransitionInstance<S, any>
> = {
  currentStage: S
  
  _store: { [key in S['stage']]: Extract<S, { stage: key }>}
  
  isLoading: boolean
  on: <N extends S['stage']>(name: N, context: Extract<S, { stage: N }>['context']) => (void | Promise<void>)
  dispatch: <N extends T['name'] | [S['stage'], S['stage']]>(
    ...params: [
      N, 
      ...N extends T['name'] 
        ? ignoreFirstValue<Parameters<Extract<T, { name: N }>['execution']>>
        : any
      ]
  ) => void
}

type TransitionInstance<
  Stages extends StageDef,
  S extends Stager<any, any>,
  Event extends string = any,
  From extends valueOrArrayValue<string> = any,
  To extends valueOrArrayValue<string> = any,
  Params extends Array<any> = any
> = {
  name: Event
  from: From
  to: To
  execution: (
    executionCtx: { 
      context: Extract<Stages, { stage: From }>['context'],
      dispatch: S['dispatch']
    }, 
    ...params: Params
  ) => valueOrPromiseValue<Extract<Stages, { stage: To extends Array<infer T> ? T : To }>> | undefined
}

type StageListener<
  Stages extends StageDef
> = (stage: Stages) => (void | Promise<void>)

class StageBuilder<
  S extends StageDef, 
  T extends TransitionInstance<S, Stager<any, any>> = NoTransition
> {
  transitions: Array<TransitionInstance<S, any>> = []
  listeners: Array<StageListener<S>> = []
  stager: Stager<S, T>

  transition<
    Event extends string, 
    From extends valueOrArrayValue<S['stage']>, 
    To extends valueOrArrayValue<S['stage']>, 
    P extends unknown[]
  >(
    option: TransitionInstance<S, Stager<S, T>, Event, From, To, P>
  ): StageBuilder<S, T | TransitionInstance<S, Stager<S, T>, Event, From, To, P>> {
    this.transitions.push(option)

    return this as any
  }

  on<N extends valueOrArrayValue<S['stage']>>(
    name: N, 
    listener: (stage: Extract<S, { stage: inferValueOrArrayValue<N> }>) => (void | Promise<void>)
  ): StageBuilder<S, T> {
    this.listeners.push(listener)
    return this as any
  }

  build({ 
    initialStage,
    initialStore
  }: StagerOptions & {
    initialStage: S['stage'],
    initialStore: { [key in S['stage']]: Extract<S, { stage: key }>}
  }): Stager<S, T> {
    const transitionRouter = createRouter<TransitionInstance<S, Stager<S, T>>>()
    for (const transition of this.transitions) {
      const froms = Array.isArray(transition.from) ? transition.from : [transition.from]
      const tos = Array.isArray(transition.to) ? transition.to : [transition.to]

      for (const from in froms) {
        for (const to in tos) {
          transitionRouter.insert(`/route/${from}/${to}`, transition)
        }
      }
    }

    const listenerRouters = createRouter<StageListener<S>>()

    // add transitions to listener
    // add ons to listener
    return {
      currentStage: { stage: initialStage, context: initialStore[initialStage] } as any,
      _store: initialStore,
      isLoading: false,
      dispatch(name, ...params) {
        
      },
    }
  }
}

type StagerOptions = {

}

export const create = <S extends StageDef>() => new StageBuilder<S>()