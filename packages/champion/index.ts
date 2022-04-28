/* eslint-disable no-restricted-syntax */

import { Aggregable, Acknowledgement } from '@wrapped-labs/arena-types'
import {
  Commitable,
  EventStore,
  Replayable,
  Snapshot,
  Writable
} from '@wrapped-labs/turnstile-types'
import { Champion } from '@wrapped-labs/champion-types'

export function connect<
  Event extends Commitable,
  State,
  Request extends Aggregable,
  Reply,
  Context = Record<string, unknown>
>(options: {
  eventStore: EventStore<Event, State> & Replayable<Event, State> & Writable<Event, State>
  champion: Champion<Event, State, Request, Reply, Context>
  context?: Context
}): (
  request: Request & Acknowledgement,
  isOwner: (id: string) => boolean
) => Promise<Reply & { events: Event[] }> {
  return async (
    request: Request & Acknowledgement,
    isOwner: (id: string) => boolean
  ): Promise<Reply & { events: [] }> => {
    const { eventStore, champion, context = {} } = options

    // TODO: store partition in memory after first request
    const snapshots = await eventStore.getPartition(isOwner)

    const partition: Record<string, Snapshot<State>> = {}

    for (const snapshot of snapshots) {
      partition[snapshot.aggregateId] = snapshot
    }

    const reqContext = Object.create(context) as Context & {
      partition: Record<string, Snapshot<State>>
    }

    reqContext.partition = partition

    // TODO: if fn returns an async generator,
    //       we should return a generator too

    const reply = await champion(request, reqContext)

    const { events } = reply as { events?: Event[] }

    if (events != null) {
      const sequence = await eventStore.commitTransaction(events, Object.values(partition))

      for (const { event, state } of sequence) {
        partition[event.aggregate.id] = {
          aggregateId: event.aggregate.id,
          revision: event.metadata.revision,
          salt: '',
          state
        }
      }
    }

    return {
      events: [],
      ...reply
    }
  }
}
