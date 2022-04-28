/* eslint @typescript-eslint/no-use-before-define:0 */
/* eslint no-await-in-loop:0 */
import { PassThrough } from 'stream'

import {
  EventStore,
  EventStream,
  Commitable,
  Positioned,
  Snapshot,
  TimeStamped,
  ValidateFunction
} from '@wrapped-labs/turnstile-types'

import cloneDeep from 'lodash/cloneDeep'
import merge from 'lodash/merge'
import { Db, Collection } from 'mongodb'

// this implementation is built on
// https://github.com/thenativeweb/wolkenkit-eventstore/blob/358f8da/lib/mongodb/Eventstore.js

export class MongoEventStore<Event extends Commitable, State> implements EventStore<Event, State> {
  db: Db

  namespace: string

  salt: string

  collections: {
    events: Collection<Event & Positioned>
    snapshots: Collection<Snapshot<State>>
    counters: Collection<{
      _id: string
      seq: number
    }>
  }

  validateFunction?: ValidateFunction<Event[]>

  constructor(namespace: string, salt: string, db: Db) {
    this.db = db
    this.namespace = `store_${namespace}`
    this.salt = salt
    this.collections = {
      events: this.db.collection(`${namespace}_events`),
      snapshots: this.db.collection(`${namespace}_snapshots`),
      counters: this.db.collection(`${namespace}_counters`)
    }
  }

  setValidateFunction(fn: ValidateFunction<Event[]>): void {
    this.validateFunction = fn
  }

  async initialize(): Promise<void> {
    await this.collections.events.createIndexes([
      {
        key: { 'aggregate.id': 1 },
        name: `${this.namespace}_aggregateId`
      },
      {
        key: { 'aggregate.id': 1, 'metadata.revision': 1 },
        name: `${this.namespace}_aggregateId_revision`,
        unique: true
      },
      {
        key: { 'metadata.position': 1 },
        name: `${this.namespace}_position`,
        unique: true
      }
    ])

    await this.collections.snapshots.createIndexes([
      {
        key: { aggregateId: 1 },
        unique: true
      }
    ])

    try {
      await this.collections.counters.insertOne({ _id: 'events', seq: 0 })
    } catch (error) {
      const ex = error as { code: number; message: string }
      if (ex.code === 11000 && ex.message.includes('_counters index: _id_ dup key')) {
        return
      }

      throw error
    }
  }

  async getNextSequence(name: string): Promise<number> {
    const counter = await this.collections.counters.findOneAndUpdate(
      { _id: name },
      {
        $inc: { seq: 1 }
      },
      { returnNewDocument: true } as Record<string, unknown>
    )

    if (counter.value != null) {
      return counter.value.seq
    }

    throw new Error(`could not find sequence counter: "${name}"`)
  }

  async getLastEvent(aggregateId: string): Promise<(Event & Positioned) | undefined> {
    if (!aggregateId) {
      throw new Error('Aggregate id is missing.')
    }

    const events = await this.collections.events
      .find(
        {
          'aggregate.id': aggregateId
        } as any,
        {
          projection: { _id: 0 },
          sort: { 'metadata.revision': -1 },
          limit: 1
        }
      )
      .toArray()

    if (events.length === 0) {
      return undefined
    }

    return events[0]
  }

  getEventStream(params: {
    aggregateId: string
    fromRevision?: number
    toRevision?: number
  }): EventStream<Event & Positioned> {
    const { aggregateId, fromRevision = 1, toRevision = 2 ** 31 - 1 } = params

    if (!aggregateId) {
      throw new Error('Aggregate id is missing.')
    }
    if (fromRevision > toRevision) {
      throw new Error('From revision is greater than to revision.')
    }

    const passThrough = new PassThrough({ objectMode: true })
    const eventStream = this.collections.events
      .find(
        {
          $and: [
            { 'aggregate.id': aggregateId },
            { 'metadata.revision': { $gte: fromRevision } },
            { 'metadata.revision': { $lte: toRevision } }
          ]
        } as any,
        {
          projection: { _id: 0 },
          sort: { 'metadata.revision': 1 }
        }
      )
      .stream()

    function unsubscribe(): void {
      eventStream.removeListener('data', onData)
      eventStream.removeListener('end', onEnd)
      eventStream.removeListener('error', onError)
    }

    const onData = (data: Event & Positioned): void => {
      passThrough.write(data)
    }

    const onEnd = (): void => {
      unsubscribe()
      passThrough.end()

      // In the PostgreSQL eventstore, we call eventStream.end() here. In MongoDB,
      // this function apparently is not implemented. This note is just for
      // informational purposes to ensure that you are aware that the two
      // implementations differ here.
    }

    const onError = (err: Error): void => {
      unsubscribe()
      passThrough.emit('error', err)
      passThrough.end()

      // In the PostgreSQL eventstore, we call eventStream.end() here. In MongoDB,
      // this function apparently is not implemented. This note is just for
      // informational purposes to ensure that you are aware that the two
      // implementations differ here.
    }

    eventStream.on('data', onData)
    eventStream.on('end', onEnd)
    eventStream.on('error', onError)

    return passThrough
  }

  getUnpublishedEventStream(): EventStream<Event & Positioned> {
    const passThrough = new PassThrough({ objectMode: true })
    const eventStream = this.collections.events
      .find(
        {
          'metadata.published': false
        } as any,
        {
          projection: { _id: 0 },
          sort: { 'metadata.position': 1 }
        }
      )
      .stream()

    function unsubscribe(): void {
      eventStream.removeListener('data', onData)
      eventStream.removeListener('end', onEnd)
      eventStream.removeListener('error', onError)
    }

    const onData = (data: Event & Positioned): void => {
      passThrough.write(data)
    }

    const onEnd = (): void => {
      unsubscribe()
      passThrough.end()

      // In the PostgreSQL eventstore, we call eventStream.end() here. In MongoDB,
      // this function apparently is not implemented. This note is just for
      // informational purposes to ensure that you are aware that the two
      // implementations differ here.
    }

    const onError = (err: Error): void => {
      unsubscribe()
      passThrough.emit('error', err)
      passThrough.end()

      // In the PostgreSQL eventstore, we call eventStream.end() here. In MongoDB,
      // this function apparently is not implemented. This note is just for
      // informational purposes to ensure that you are aware that the two
      // implementations differ here.
    }

    eventStream.on('data', onData)
    eventStream.on('end', onEnd)
    eventStream.on('error', onError)

    return passThrough
  }

  async saveEvents(params: {
    uncommittedEvents: Array<{ event: Event & TimeStamped; state: State }>
  }): Promise<Array<{ event: Event & Positioned; state: State }>> {
    const { uncommittedEvents } = params
    if (!uncommittedEvents || uncommittedEvents.length === 0) {
      return []
    }

    if (this.validateFunction != null) {
      const events = uncommittedEvents.map(({ event }) => event)
      if (!this.validateFunction(events)) {
        const errors = this.validateFunction.errors == null ? [] : this.validateFunction.errors
        const context = JSON.stringify({ events, errors })

        throw new Error(`failed to validate: ${context}`)
      }
    }

    const committedEvents: Array<{ event: Event & Positioned; state: State }> = []

    try {
      for (let i = 0; i < uncommittedEvents.length; i++) {
        const { event } = uncommittedEvents[i]

        if (!event.metadata) {
          throw new Error('Metadata are missing.')
        }
        if (event.metadata.revision === undefined) {
          throw new Error('Revision is missing.')
        }
        if (event.metadata.revision < 1) {
          throw new Error('Revision must not be less than 1.')
        }

        const seq = await this.getNextSequence('events')

        const publishableEvent: Event & Positioned = merge(event, {
          metadata: {
            position: seq
          }
        })

        // Use cloned events here to hinder MongoDB from adding an _id property
        // to the original event objects.
        await this.collections.events.insertOne(cloneDeep(publishableEvent) as any)

        committedEvents.push({ event: publishableEvent, state: uncommittedEvents[i].state })
      }
    } catch (error) {
      const ex = error as { code: number; message: string }
      if (ex.code === 11000 && ex.message.includes('_aggregateId_revision')) {
        throw new Error('Aggregate id and revision already exist.')
      }

      throw error
    }

    const indexForSnapshot = committedEvents.findIndex(
      (committedEvent) => committedEvent.event.metadata.revision % 100 === 0
    )

    if (indexForSnapshot !== -1) {
      const aggregateId = committedEvents[indexForSnapshot].event.aggregate.id

      const {
        event: {
          metadata: { revision }
        },

        state
      } = committedEvents[indexForSnapshot]

      await this.saveSnapshot({ aggregateId, revision, state })
    }

    return committedEvents
  }

  async markEventsAsPublished(params: {
    aggregateId: string
    fromRevision: number
    toRevision: number
  }): Promise<void> {
    const { aggregateId, fromRevision, toRevision } = params

    if (!aggregateId) {
      throw new Error('Aggregate id is missing.')
    }
    if (!fromRevision) {
      throw new Error('From revision is missing.')
    }
    if (!toRevision) {
      throw new Error('To revision is missing.')
    }

    if (fromRevision > toRevision) {
      throw new Error('From revision is greater than to revision.')
    }

    await this.collections.events.updateMany(
      {
        'aggregate.id': aggregateId,
        'metadata.revision': {
          $gte: fromRevision,
          $lte: toRevision
        }
      } as any,
      {
        $set: {
          'metadata.published': true
        }
      } as any
    )
  }

  async getSnapshot(aggregateId: string): Promise<Snapshot<State> | undefined> {
    if (!aggregateId) {
      throw new Error('Aggregate id is missing.')
    }

    const snapshot = await this.collections.snapshots.findOne(
      { aggregateId },
      { projection: { _id: false, revision: true, state: true } }
    )

    if (snapshot == null) {
      return undefined
    }

    return snapshot
  }

  async saveSnapshot(options: {
    aggregateId: string
    revision: number
    state: State
  }): Promise<void> {
    const { aggregateId, revision, state } = options

    if (!aggregateId) {
      throw new Error('Aggregate id is missing.')
    }
    if (!revision) {
      throw new Error('Revision is missing.')
    }
    if (!state) {
      throw new Error('State is missing.')
    }

    await this.collections.snapshots.updateOne(
      { aggregateId },
      { $set: { aggregateId, state, revision, salt: this.salt } },
      { upsert: true }
    )
  }

  getReplay(
    options: { fromPosition?: number; toPosition?: number } = {}
  ): EventStream<Event & Positioned> {
    const fromPosition = options.fromPosition || 1
    const toPosition = options.toPosition || 2 ** 31 - 1

    if (fromPosition > toPosition) {
      throw new Error('From position is greater than to position.')
    }

    const passThrough = new PassThrough({ objectMode: true })
    const replayStream = this.collections.events
      .find(
        {
          $and: [
            { 'metadata.position': { $gte: fromPosition } },
            { 'metadata.position': { $lte: toPosition } }
          ]
        } as any,
        {
          projection: { _id: 0 },
          sort: { 'metadata.position': 1 }
        }
      )
      .stream()

    function unsubscribe(): void {
      replayStream.removeListener('data', onData)
      replayStream.removeListener('end', onEnd)
      replayStream.removeListener('error', onError)
    }

    const onData = (data: Event & Positioned): void => {
      passThrough.write(data)
    }

    const onEnd = (): void => {
      unsubscribe()
      passThrough.end()

      // In the PostgreSQL eventstore, we call replayStream.end() here. In MongoDB,
      // this function apparently is not implemented. This note is just for
      // informational purposes to ensure that you are aware that the two
      // implementations differ here.
    }

    const onError = (err: Error): void => {
      unsubscribe()
      passThrough.emit('error', err)
      passThrough.end()

      // In the PostgreSQL eventstore, we call replayStream.end() here. In MongoDB,
      // this function apparently is not implemented. This note is just for
      // informational purposes to ensure that you are aware that the two
      // implementations differ here.
    }

    replayStream.on('data', onData)
    replayStream.on('end', onEnd)
    replayStream.on('error', onError)

    return passThrough
  }
}
