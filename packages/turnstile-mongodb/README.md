## event-store

This implementation provides tools for storing events and aggregating events over time.

## API

This API documentation is incomplete. See [wolkenkit-eventstore][] for usage examples and API
documentation. This project diverges from the wolkenkit implementation with the usage of the `salt`
parameter, and the additional of the `Replayable` and `Writable` interfaces.

See [../types/EventStore.ts](../types/EventStore.ts) for details about the API implemented by this
package.

### Constructing an event store

`MongoEventStore` is the only constructor available.

```ts
const mongoEventStore: MongoEventStore<Event, State> = new MongoEventStore(
  collectionNamePrefix,
  salt,
  database
)
```

Parameters:

- `collectionNamePrefix`: this is a string that is used when creating collections in MongoDB. For
  example, using the name 'foo' will result in collections named `foo_counters`, `foo_events` and
  `foo_snapshots`

- `salt`: this is a unique string that is used for validating snapshots from the snapshots
  collection. For more information, see "Using salts" in the caveats section below.

- `database`: this is an instance of `Db` from MongoDB. If you are using Mongoose, you can pass
  `mongoose.connection.db` after successfully connecting with `mongoose.connect(...)`

### Constructing `Replayable`

This `Replayable` interface is used for replaying events from the event store.

Parameters (for `makeReplayable`):

- `eventStore`: this is the underlying instance of the event store.

- `reduce`: this is the reducer function that aggregates state.

- `initialState`: this is the first state used for aggregates that have no events.

- `salt`: this is the same salt parameter from the event store constructor. Always use the same
  salt.

### Constructing `Writable`

This `Writable` interface is used for replaying events from the event store.

Parameters (for `makeWritable`):

- `eventStore`: this is the underlying instance of the event store.

- `reduce`: this is the reducer function that aggregates state.

- `salt`: this is the same salt parameter from the other constructors.

## Usage

See [e2e.spec.ts](./e2e.spec.ts) for a living usage example.

## Design

This implementation is based on [wolkenkit-eventstore][]. We provide additional utilities for
reading and writing in a concurrency-safe manner. If two workers are racing to write events for the
same aggregate ID, one of them will encounter a failure. This introduces the possible "down-time"
that is expected for eventually-consistent design. When computing data for new events from the data
of old events, we will never introduce inconsistency and we have "at-most-once" writing semantics.
This enables us to implement idempotent transactions without leaning on heavy-weight tools like
PostgreSQL.

This approach to data consistency currently involves a manual process for tracking event revisions.
See "Working with revision numbers" in the caveats section below for more information.

In the worst-case scenario for aggregating events, we replay all events for a given aggregate ID,
and compute the latest state in memory. In the additional utilities provided by this package, we
utilize snapshots in order to keep the aggregate states cached for later use. This means that 99% of
reads will involve no replaying and should have fast query times.

## Caveats

##### Working with revision numbers

Every time you are supplying an event to `commitTransaction` you will need to define a revision
number that is greater than the last event that shares the same aggregate ID. This usually means
that you will need to use a method like `getLatestSnapshot` or `getLastEvent` before building a
transaction.

If you are committing events for multiple aggregate IDs, be sure to query each aggregate
individually, and calculate the revision according to each.

```
// don't do this
const foo = await eventStore.getLatestSnapshot('foo');

await eventStore.commitTransaction([
  {aggregate: {id: 'foo'}, metadata: {revision: foo.revision + 1}},
  {aggregate: {id: 'bar'}, metadata: {revision: foo.revision + 2}},
])
```

```
// do this
const foo = await eventStore.getLatestSnapshot('foo');
const bar = await eventStore.getLatestSnapshot('bar');

await eventStore.commitTransaction([
  {aggregate: {id: 'foo'}, metadata: {revision: foo.revision + 1}},
  {aggregate: {id: 'bar'}, metadata: {revision: bar.revision + 1}},
])
```

##### Using salts

When initializing the event store, we provide the `salt` parameter to uniquely identify the
implementation of the aggregation strategy. The aggregation strategy includes the reducer and
initial state. The simplest approach is to supply the project's build ID or release number as the
salt, in order to invalidate the snapshots every time a new build is deployed or released.

Example:

```
const package = require('./package.json');

const salt = package.version;

const mongoEventStore: MongoEventStore<Event, State>
  = new MongoEventStore('my_collection', salt, ...);
```

##### Making backward-compatible changes

You can change your aggregation strategy without breaking compatibility with the event history.
However, if you need to make backwards-compatible changes to the event, there are a couple of
type-safe approaches.

1. Write your own migration strategy for rewriting old events.

2. Add optional fields to existing events.

```diff
 export interface EmailAuthenticatedEventData {
   verification: UserEmailVerificationType.auth0 | UserEmailVerificationType.admin;
   email: string;
+  acceptedEULA?: boolean;
 }
```

3. Preserve enum values while renaming old events.

```diff
 export enum EventName {
-  OrderReceived = 'OrderReceived',
+  OrderReceived = 'OrderReceivedNew',
+  OrderReceivedOld = 'OrderReceived',
   OrderCancelled = 'OrderCancelled',
   OrderExecuted = 'OrderExecuted',
 }

-export interface OrderReceivedEventData {
+export interface OrderReceivedOldEventData {
   amount: string;
   fee: OrderFee;
   depositToken: DepositToken;
   withdrawToken: WithdrawToken;
 }

+export interface OrderReceivedOldEvent extends BaseUserEvent {
+  name: UserEventName.OrderReceivedOld;
+  data: OrderReceivedOldEventData;
+}
+
+export interface OrderReceivedEventData extends OrderReceivedOldEventData {
+  public: boolean;
+}
```

##### Using multiple aggregates

The current implementation only supports one event store per aggregate type. This means that we only
ensure atomic transactions for events in the same aggregate type. If two workers are racing to write
on different aggregates, they will not see each other.

##### Defining empty states

To ensure type-safety and cleaner error messages, we do not allow `null` or `undefined` as possible
values for the `State` parameter. Instead, try giving your empty state a name.

```diff
+enum Status { Created = 'created', Empty = 'empty' }

-type State = { name: string; } | null;
+type State = { status: Status.Created; name: string; } | { status: Status.Empty };
```

[wolkenkit-eventstore]: https://github.com/thenativeweb/wolkenkit-eventstore
