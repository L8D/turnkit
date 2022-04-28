import { MongoClient, connect } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'

import {
  Snapshot,
  TimeStamped,
  Commitable,
  EventStore,
  Writable,
  Replayable
} from '@wrapped-labs/turnstile-types'

import { makeReplayable } from '@wrapped-labs/turnstile-replay'
import { makeWritable } from '@wrapped-labs/turnstile-commit'

import { MongoEventStore } from '.'

enum UserStatus {
  created = 'created',
  dormant = 'dormant'
}

type State =
  | { status: UserStatus.created; name: string; created: string }
  | { status: UserStatus.dormant }

enum EventName {
  UserCreated = 'UserCreated',
  UserDeleted = 'UserDeleted'
}

interface BaseEvent extends Commitable {
  aggregate: {
    name: 'user'
    id: string
  }

  name: EventName
}

interface UserCreatedEvent extends BaseEvent {
  name: EventName.UserCreated
  data: {
    name: string
  }
}

interface UserDeletedEvent extends BaseEvent {
  name: EventName.UserDeleted
}

type Event = UserCreatedEvent | UserDeletedEvent

const initialState: State = { status: UserStatus.dormant }

const reduce = (state: State, event: Event & TimeStamped): State => {
  switch (event.name) {
    case EventName.UserCreated:
      return {
        name: event.data.name,
        created: new Date(event.metadata.timestamp).toISOString(),
        status: UserStatus.created
      }

    case EventName.UserDeleted:
      return { status: UserStatus.dormant }

    default:
      return state
  }
}

type BareEventStore = EventStore<Event, State>

export type ConnectedEventStore = BareEventStore & Replayable<Event, State> & Writable<Event, State>

// this suite downloads a copy of mongodb
jest.setTimeout(600 * 1000)

describe('event store', () => {
  let client: MongoClient
  let mongoServer: MongoMemoryServer

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({ binary: { version: '4.0.3' } })
    const uri = mongoServer.getUri()
    client = await connect(uri)
  })

  afterAll(async () => {
    if (client) {
      await client.close()
    }

    if (mongoServer) {
      await mongoServer.stop()
    }
  })

  it('should handle transactions', async () => {
    if (!client) {
      throw new Error('mongodb connection failed')
    }

    // this tracks the version of the implementation used for snapshotting
    const salt = `${Math.random()}`.slice(2)

    // this controls the names of the collections
    // created by the mongo event store.
    //
    // ex. user_events, user_snapshots, user_counters
    const collectionNamePrefix = 'user'

    const mongoEventStore: MongoEventStore<Event, State> = new MongoEventStore(
      collectionNamePrefix,
      salt,
      client.db()
    )

    await mongoEventStore.initialize()

    const replayableEventStore: BareEventStore & Replayable<Event, State> = makeReplayable<
      Event,
      State,
      BareEventStore
    >(mongoEventStore, reduce, initialState, salt)

    const connectedEventStore = makeWritable<
      Event,
      State,
      BareEventStore & Replayable<Event, State>
    >(replayableEventStore, reduce, salt)

    const userId = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'

    const snapshot = await connectedEventStore.getLatestSnapshot(userId)

    // aggregates with no events start at revision 0
    expect(snapshot.revision).toBe(0)

    const userCreatedEvent: UserCreatedEvent = {
      name: EventName.UserCreated,
      aggregate: { name: 'user', id: userId },
      data: { name: 'Person McPersonface' },
      metadata: {
        revision: snapshot.revision + 1
      }
    }

    const [{ event: intermediateEvent, state: intermediateState }] =
      await connectedEventStore.commitTransaction([userCreatedEvent], [snapshot])

    expect(intermediateState).toMatchObject({
      name: 'Person McPersonface'
    })

    const intermediateSnapshot: Snapshot<State> = {
      aggregateId: userId, // or intermediateEvent.aggregate.id
      revision: intermediateEvent.metadata.revision,
      state: intermediateState,
      salt
    }

    const userDeletedEvent: UserDeletedEvent = {
      name: EventName.UserDeleted,
      aggregate: { name: 'user', id: userId },
      metadata: {
        revision: intermediateEvent.metadata.revision + 1
      }
    }

    const [{ state: lastState }] = await connectedEventStore.commitTransaction(
      [userDeletedEvent],
      [intermediateSnapshot]
    )

    expect(lastState).toEqual({ status: UserStatus.dormant })

    const lastSnapshot = await connectedEventStore.getLatestSnapshot(userId)

    expect(lastSnapshot.state).toEqual({ status: UserStatus.dormant })
    expect(lastSnapshot.revision).toBe(2)
  })
})
