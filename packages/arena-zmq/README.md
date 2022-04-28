<p align="center">
  <img alt="Arena" src="docs/arena-logo.png" width="480">
</p>

<p align="center">
  Application-layer sharding with TypeScript
</p>

TODO: table of contents

## Why

This tool is inspired by [fero](https://github.com/pemrouz/fero), which is in the same
problem-space. Here is a quote from fero’s documentation:

> The request-response paradigm alone architecturally scales poorly across microservices. In
> contrast, the stream processing paradigm allows you to set up a declarative workflow of streams
> across the network, where each step in the reactive chain can be independently scaled.

## Design

Arena provides a model for processing requests with application-layer sharding. It does not provide
a solution for committing events. You will need to incorporate your own solution for persistence.

Arena uses a centralized broker server to coordinate dispatching for workers. Requests are grouped
under aggregates. The broker guarantees that requests under the same aggregate are processed like a
queue. This behavior is similar to Apache Kafka.

Arena ZMQ is an implementation of Arena that uses [ZeroMQ](https://github.com/zeromq/zeromq.js) for
communication over TCP.

## Examples

To build a service with Arena, we need to implement our data model and a processor.

### Example: Data Model

Let's define our request-response model. Arena requires request objects to have an `aggregate`
property for tracking the aggregate name and identifier. This feature is enables Arena to implement
application-layer sharding on requests.

```typescript
// users-types.ts

import { Aggregable } from '@wrapped-labs/arena-zmq';

export interface UsersRequest extends Aggregable {
  aggregate: { name: 'users' };
  name: 'login' | 'allow';
  data: { email: string };
};

export interface UsersReply =
  | { status: 200, message: 'ok' }
  | { status: 403, message: 'forbidden' }
  | { status: 404, message: 'not found' }
```

### Example: Processor

Now we can build the processor, which returns a reply or a promise of a reply. Here we are storing
data in memory for simplicity.

```typescript
// users-processor.ts

import { UsersRequest, UsersReply } from './users-types'

const allowedUsers: string[] = []

export const processor = (req: UsersRequest): UsersReply => {
  if (req.name === 'login') {
    if (!allowedUsers.includes(req.data.email)) {
      return { status: 403, message: 'forbidden' }
    }

    return { status: 200, message: 'ok' }
  }

  if (req.name === 'allow') {
    allowedUsers.push(req.data.email)

    return { status: 200, message: 'ok' }
  }

  return { status: 404, message: 'not found' }
}
```

### Example: Singleton Service

Now we can build a basic service module.

```typescript
// users-service.ts

import arena from '@wrapped-labs/arena-zmq'

import { UsersRequest, UsersReply } from './users-types'
import { processor } from './users-processor'

export const replies: Record<string, UsersReply> = {}

await arena<UsersRequest, UsersReply>({ type: 'broker' })

await arena<UsersRequest, UsersReply>({
  type: 'worker',
  port: 8080,
  aggregateName: 'users',
  processor
})

const client = await arena<UsersRequest, UsersReply>({ type: 'client' })

export default client
```

### Example: HTTP transport

Here is an example of transporting HTTP requests to the singleton service.

```typescript
// users-router.ts

import express from 'express'

import { UsersRequest } from './users-types'
import usersService from './users-service'

const router = express.Router()

export default router
;['login', 'allow'].forEach((name: 'login' | 'allow'): void => {
  router.post(`/users/:userId/${name}`, async (req, res, next): Promise<void> => {
    try {
      const request: UsersRequest = {
        name,
        aggregate: {
          name: 'users',
          id: req.params.userId
        },
        data: req.body as UsersRequest['data']
      }

      const { waitForReply } = await client.send(request)
      const reply = await waitForReply
      res.status(reply.status).send(reply.message)
    } catch (error) {
      next(error)
    }
  })
})
```

### Example: Tying It All Together

Now we can make a server and start a broker. This is everything you need to get started with Arena.

```typescript
// server.ts

import arena from '@wrapped-labs/arena-zmq'
import express from 'express'
import { json } from 'body-parser'

import usersRouter from './users-router'

const app = express()

app.use(json())
app.use(usersRouter)

// we only need to provide types if
// we want to work with broker hooks
await arena<any, any>({ type: 'broker' })

app.listen(9000)
```

## API

### Types

When using TypeScript, Arena requires you to provide a `Req` and `Res` type.

- `Req` must extend `Aggregable { aggregate: { name: string; id: string; } }`.

- `Res` must be an object.

### Worker

- `worker = await arena<Req, Res>({ type: 'worker', ...opts })`

  - `opts`

    - `processor`: `(req: Req & Acknowledgement) => Promise<Res> | Res` - **required**, this is the
      function which handles incoming requests for the worker. The request is decorated with the
      `acknowledgement` property which can be used for tracking the request uniqueness and handling
      replay scenarios.
    - `port`: `number` - **required**, port number for bind. This is used for broker to tracker
      health
    - `aggregateName` - **required**, name used to route requests by `req.aggregate.name`. Use this
      parameter to route requests to different services (exa. `users` and `books` for a book store).
    - `host = '127.0.0.1'`: `string` - host IP or hostname for bind.
    - `broker`: `{ host = '127.0.0.1', ports = { requests = 11050, server = 11051 } }` - broker
      connection details.
    - `workerId = uuidv4()`: `string` - UUID for worker
    - `autoStart = true`: `boolean` - use this parameter if you want to start the worker manually.
    - `pingInterval = 3000`: `number` - determines how frequently the worker pings the broker.
    - `zmq`: `{ sendTimeout = 1000, receiveTimeout = 1000 }` - configures timeouts for ZeroMQ.

### Broker

- `broker = await arena<Req, Res>({ type: 'broker', ...opts })`

  - `opts`

    - `host = '127.0.0.1'`: `string` - host IP or hostname for bind.
    - `ports`: `{ requests = 11050, server = 11051 }` - ports used for inbound and outbound traffic.
    - `autoStart = true`: `boolean` - use this parameter if you want to start the worker manually.
    - `zmq`: `{ sendTimeout = 1000, receiveTimeout = 1000 }` - configures timeouts for ZeroMQ.
    - `heartrate = 1000`: `number` - configures time between heartbeats for workers
    - `retryDelay = 1000`: `number` - configures delay before republishing rejected requests.
    - `onError`: `(error: unknown) => void` - this is for handling fatal errors that occur
      internally within the broker.
    - `onRequest`: `(req: Req & Acknowledgement) => Promise<void> | void` - this is for persisting
      requests before they are broadcast to workers. Without this parameter, the broker will queue
      requests in memory and data will be lost if the broker crashes.
    - `onReply`: `(reply: Res & Acknowledgement & Aggregable) => Promise<void> | void` - this is for
      persisting replies before they are broadcast to clients. This helps with creating auditable
      histories.

### Client

- `client = await arena<Req, Res>({ type: 'client', ...opts })`

  - `opts`

    - `broker`: `{ host = '127.0.0.1', ports = { requests = 11050, server = 11051 } }` - broker
      connection details.
    - `autoStart = true`: `boolean` - use this parameter if you want to start the worker manually.
    - `zmq`: `{ sendTimeout = 1000, receiveTimeout = 1000 }` - configures timeouts for ZeroMQ.
    - `replyTimeout = 120000`: `number` - configures time to wait for a request to be processed
      before timing out.

- `client.send(req: Req): Promise<Acknowledgement & Aggregable & { waitForReply }>`

  - `waitForReply`: `Promise<Res & Acknowledgement & Aggregable>`

    Acknowledgement details are available before the request has been processed. An acknowledgement
    guarantees that your request will eventually become processed. If you want to wait for the
    request to be processed, you can use `waitForReply`.

## Credits

- [@pemrouz](http://twitter.com/pemrouz) -
  [fero: scalable microservices made easy](https://github.com/pemrouz/fero)
- [@martinkl](https://twitter.com/martinkl) -
  ["Turning the Database Inside Out"](https://www.youtube.com/watch?v=fU9hR3kiOK0)
- [@caitie](https://twitter.com/caitie) -
  ["Building Scalable Stateful Services"](https://www.youtube.com/watch?v=H0i_bXKwujQ)
- [@mranney](https://twitter.com/mranney) -
  ["Scaling Uber"](https://www.infoq.com/presentations/uber-scalability-arch)
- [@jaykreps](https://twitter.com/jaykreps) -
  ["The Log: What every software engineer should know about real-time data's unifying abstraction"](https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying)
- [zeromq.js](https://github.com/zeromq/) - for powering this initial implementation of Arena

# Next Steps

- Brokerless design

- Arena gRPC

# License

MIT License © Tenor Biel
