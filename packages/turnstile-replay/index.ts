import {
  EventStore,
  Commitable,
  TimeStamped,
  Snapshot,
  Replayable,
  EventStream,
  Positioned
} from '@wrapped-labs/turnstile-types'

export function makeReplayable<
  Event extends Commitable,
  State,
  CustomEventStore extends EventStore<Event, State>
>(
  eventStore: CustomEventStore,
  reducer: (state: State, event: Event & TimeStamped) => State,
  initialState: State,
  salt: string
): CustomEventStore & Replayable<Event, State> {
  const getLatestSnapshot = async (
    aggregateId: string,
    latestSnapshot?: Snapshot<State>
  ): Promise<Snapshot<State>> => {
    let snapshot = latestSnapshot

    if (latestSnapshot == null) {
      snapshot = await eventStore.getSnapshot(aggregateId)
    }

    let fromRevision = 0
    let result = initialState

    if (snapshot != null && snapshot.salt === salt) {
      fromRevision = snapshot.revision
      result = snapshot.state
    }

    return await new Promise((resolve, reject) => {
      const stream = eventStore.getEventStream({
        aggregateId,
        fromRevision
      })

      stream.on('data', (event) => {
        result = reducer(result, event)
        fromRevision = event.metadata.revision
      })

      stream.on('error', reject)

      stream.on('end', () => {
        resolve({ aggregateId, revision: fromRevision, state: result, salt })
      })
    })
  }

  const getPartition = async (
    filter: (id: string) => boolean,
    stream?: EventStream<Event & Positioned>
  ): Promise<Array<Snapshot<State>>> => {
    // we are using a deferred promise style in order
    // to start subscribing to the stream in the same
    // tick

    let resolve: (result: Array<Snapshot<State>>) => void | undefined
    let reject: (error: any) => void | undefined

    if (stream === undefined) {
      stream = eventStore.getReplay()
    }

    const snapshotMap: Map<string, Snapshot<State>> = new Map()

    stream.on('data', (event) => {
      if (filter(event.aggregate.id)) {
        const oldSnapshot = snapshotMap.get(event.aggregate.id)

        snapshotMap.set(event.aggregate.id, {
          aggregateId: event.aggregate.id,
          revision: event.metadata.revision,
          salt,
          state: reducer(oldSnapshot?.state || initialState, event)
        })
      }
    })

    stream.on('error', (error) => {
      if (reject) {
        reject(error)
      } else {
        throw new Error('stream emitted data before Promise tick')
      }
    })

    stream.on('end', () => {
      const snapshots: Array<Snapshot<State>> = Array.from(snapshotMap.values())

      if (resolve) {
        resolve(snapshots)
      } else {
        throw new Error('stream emitted data before Promise tick')
      }
    })

    return await new Promise((innerResolve, innerReject) => {
      resolve = innerResolve
      reject = innerReject
    })
  }

  const getAllLatestSnapshots = async (
    stream?: EventStream<Event & Positioned>
  ): Promise<Array<Snapshot<State>>> => {
    return await getPartition(() => true, stream)
  }

  const replayableEventStore = Object.create(eventStore) as CustomEventStore &
    Replayable<Event, State>

  replayableEventStore.getLatestSnapshot = getLatestSnapshot
  replayableEventStore.getPartition = getPartition
  replayableEventStore.getAllLatestSnapshots = getAllLatestSnapshots

  return replayableEventStore
}
