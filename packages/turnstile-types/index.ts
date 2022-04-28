export interface Snapshot<State> {
  aggregateId: string
  salt: string
  revision: number
  state: State
}

export interface Commitable {
  aggregate: {
    name: string
    id: string
  }

  metadata: {
    revision: number
  }
}

export type TimeStamped = Commitable & {
  metadata: {
    timestamp: number
  }
}

export type Positioned = TimeStamped & {
  metadata: {
    position: number
  }
}

export interface EventStream<T> {
  on: ((event: 'close', listener: () => void) => this) &
    ((event: 'data', listener: (chunk: T) => void) => this) &
    ((event: 'end', listener: () => void) => this) &
    ((event: 'readable', listener: () => void) => this) &
    ((event: 'error', listener: (err: Error) => void) => this)
}

export interface EventStore<Event extends Commitable, State> {
  getLastEvent: (aggregateId: string) => Promise<(Event & Positioned) | undefined>

  getEventStream: (params: {
    aggregateId: string
    fromRevision?: number
    toRevision?: number
  }) => EventStream<Event & Positioned>

  saveEvents: (transaction: {
    uncommittedEvents: Array<{ event: Event & TimeStamped, state: State }>
  }) => Promise<Array<{ event: Event & Positioned, state: State }>>

  getSnapshot: (aggregateId: string) => Promise<Snapshot<State> | undefined>

  saveSnapshot: (snapshot: { aggregateId: string, revision: number, state: State }) => Promise<void>

  getReplay: (options?: {
    fromPosition?: number
    toPosition?: number
  }) => EventStream<Event & Positioned>
}

export interface Writable<Event extends Commitable, State> {
  commitTransaction: (
    events: Event[],
    snapshots?: Array<Snapshot<State>>
  ) => Promise<Array<{ event: Event & Positioned, state: State }>>
}

export interface Replayable<Event extends Commitable, State> {
  getLatestSnapshot: (aggregateId: string, snapshot?: Snapshot<State>) => Promise<Snapshot<State>>
  getAllLatestSnapshots: (
    eventStream?: EventStream<Event & Positioned>
  ) => Promise<Array<Snapshot<State>>>
  getPartition: (
    filter: (id: string) => boolean,
    eventStream?: EventStream<Event & Positioned>
  ) => Promise<Array<Snapshot<State>>>
}

export interface ValidateFunction<T = unknown> {
  (data: any): data is T
  errors?: null | any[]
}
