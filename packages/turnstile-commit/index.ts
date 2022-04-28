/* eslint no-await-in-loop:0 */
/* eslint no-restricted-syntax:0 */

import merge from 'lodash/merge'

import {
  EventStore,
  Commitable,
  Positioned,
  Snapshot,
  Replayable,
  Writable,
  TimeStamped
} from '@wrapped-labs/turnstile-types'

export function makeWritable<
  Event extends Commitable,
  State,
  CustomEventStore extends EventStore<Event, State> & Replayable<Event, State>
>(
  eventStore: CustomEventStore,
  reducer: (state: State, event: Event & TimeStamped) => State,
  salt: string
): CustomEventStore & Writable<Event, State> {
  const commitTransaction = async (
    events: Event[],
    snapshots: Array<Snapshot<State>> = []
  ): Promise<Array<{ event: Event & Positioned; state: State }>> => {
    const uncommittedEvents: Array<{ event: Event & TimeStamped; state: State }> = []
    const oldSnapshotMap: Map<string, Snapshot<State>> = new Map()
    const newSnapshotMap: Map<string, Snapshot<State>> = new Map()

    // only work with latest snapshot, grouped by aggregate id
    snapshots.sort((a, b) => {
      return a.revision - b.revision
    })

    for (const snapshot of snapshots) {
      oldSnapshotMap.set(snapshot.aggregateId, snapshot)
    }

    for (const event of events) {
      let latestSnapshot = newSnapshotMap.get(event.aggregate.id)

      if (latestSnapshot == null) {
        latestSnapshot = oldSnapshotMap.get(event.aggregate.id)
      }

      if (latestSnapshot == null) {
        latestSnapshot = await eventStore.getLatestSnapshot(event.aggregate.id)

        if (latestSnapshot.revision >= event.metadata.revision) {
          throw new Error(
            `local event is outdated. latest revision: ${latestSnapshot.revision}, event revision: ${event.metadata.revision}`
          )
        }
      }

      const timeStampedEvent: Event & TimeStamped = merge(event, {
        metadata: {
          timestamp: Date.now()
        }
      })

      const nextState = reducer(latestSnapshot.state, timeStampedEvent)

      const nextSnapshot = {
        aggregateId: timeStampedEvent.aggregate.id,
        revision: timeStampedEvent.metadata.revision,
        state: nextState,
        salt
      }

      newSnapshotMap.set(timeStampedEvent.aggregate.id, nextSnapshot)

      uncommittedEvents.push({ event: timeStampedEvent, state: nextState })
    }

    const resultEvents = await eventStore.saveEvents({ uncommittedEvents })

    for (const newSnapshot of newSnapshotMap.values()) {
      await eventStore.saveSnapshot(newSnapshot)
    }

    return resultEvents
  }

  const writableEventStore = Object.create(eventStore) as CustomEventStore & Writable<Event, State>

  writableEventStore.commitTransaction = commitTransaction

  return writableEventStore
}
