/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */

import {
  Acknowledgement,
  ArenaBroker,
  ArenaClient,
  ArenaWorker,
  ConnectedAcknowledgement,
  ProcessedReply
} from '@wrapped-labs/arena-types'
import Debug from 'debug'
import { v4 as uuidv4 } from 'uuid'
import * as zmq from 'zeromq'

import arena from '.'

zmq.context.blocky = false

interface MyReply {
  data: { status: 'processed' }
}
interface MyRequest {
  aggregate: { name: 'user'; id: string }
}

const WORKER_COUNT = 10
const BATCH_SIZE = 10
const WORKER_PORT_RANGE_BEGIN = 8100

const startWorkers = async ({
  count = 10,
  requestProcessingTime = 2000
}): Promise<{ startedWorkers: ArenaWorker[] }> => {
  const debug = Debug(`${__filename}:startWorkers`)
  const ports = []

  for (let i = 0; i < count; i++) {
    ports.push(WORKER_PORT_RANGE_BEGIN + i)
  }

  debug('starting %s workers, ports.begin=%s', ports.length, WORKER_PORT_RANGE_BEGIN)

  const startedWorkers = []

  let port = ports.pop()

  while (port) {
    const worker = await arena<MyRequest, MyReply>({
      type: 'worker',
      aggregateName: 'user',
      processor: async (request: MyRequest): Promise<MyReply> => {
        debug(
          'processing request=%s',
          (request as unknown as { acknowledgement: { id: string } }).acknowledgement.id
        )
        await new Promise((resolve) => setTimeout(resolve, requestProcessingTime))

        return { data: { status: 'processed' } }
      },
      port
    })

    debug('started worker=%s', worker.id)

    startedWorkers.push(worker)

    port = ports.pop()
  }

  return { startedWorkers }
}

/**
 * TODO: https://github.com/microsoft/TypeScript/pull/47607
 *       just merged three days ago.
 *
 *       when we upgrade typescript, we
 *       can start using this pattern:
 *
 *       import arena from '.';
 *
 *       const myArena = arena<MyRequest, MyReply>;
 *
 *       const broker = await myArena({ type: 'broker' });
 *       const client = await myArena({ type: 'client' });
 *       const worker = await myArena({ type: 'worker', processor });
 */

const startBroker = async (): Promise<ArenaBroker> => {
  const debug = Debug(`${__filename}:broker`)
  const broker = await arena<MyRequest, MyReply>({
    type: 'broker',
    onRequest: (request: MyRequest & Acknowledgement): void => {
      debug('onRequest request=%s', request.acknowledgement.id)
    },
    onReply: (reply: ProcessedReply<MyReply>): void => {
      debug('onRequest request=%s', reply.acknowledgement.id)
    }
  })

  return broker
}

const startClient = async (): Promise<ArenaClient<MyRequest, MyReply>> => {
  const client = await arena<MyRequest, MyReply>({
    type: 'client'
  })

  return client
}

jest.setTimeout(60 * 1000)

describe('example scenario', () => {
  describe(`with ${WORKER_COUNT} workers`, () => {
    let broker: ArenaBroker
    let startedWorkers: ArenaWorker[]
    let client: ArenaClient<MyRequest, MyReply>

    beforeEach(async () => {
      broker = await startBroker()
      client = await startClient()
      ;({ startedWorkers } = await startWorkers({ count: WORKER_COUNT }))
    })

    afterEach(async () => {
      await client.close()

      for (const worker of startedWorkers) {
        await worker.close()
      }

      await broker.close()

      const ARENA_EXIT_DELAY = Number(process.env.ARENA_EXIT_DELAY || 3 * 1000)
      // give time for requests to finish processing
      // otherwise the ports will not unbind
      await new Promise((resolve) => setTimeout(resolve, ARENA_EXIT_DELAY))
    })

    it(`should handle ${BATCH_SIZE} requests`, async () => {
      const debug = Debug(`${__filename}:batch`)
      const batch = []

      const dispatchRequest = async (
        requestCount: number
      ): Promise<ConnectedAcknowledgement<MyReply>> => {
        const id = uuidv4()
        const iter = 87654321000 + requestCount
        debug('sending from client aggregate.id=%s iter=%s', id, iter)

        const sendRequest = async (): Promise<ConnectedAcknowledgement<MyReply>> => {
          const request = await client.send({ aggregate: { name: 'user', id } })
          debug(
            'client got ack request=%s aggregate.id=% iter=%s',
            request.acknowledgement.id,
            id,
            iter
          )
          return request
        }

        return await sendRequest()
      }

      let n = 0
      while (n < BATCH_SIZE) {
        batch.push(dispatchRequest(n))
        n++
      }

      const requests = await Promise.all(batch)
      debug('got all acks')

      for (const request of requests) {
        expect(request.acknowledgement.id).not.toBe('foo')
      }

      await Promise.all(
        requests.map(async (request): Promise<void> => {
          const reply = await request.waitForReply
          debug('got reply request=%s reply=%s', request.acknowledgement.id, JSON.stringify(reply))
        })
      )
    })
  })
})
