/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */

import Debug from 'debug'
import * as zmq from 'zeromq'
import PQueue from 'p-queue'

import {
  Aggregable,
  ProcessedReply,
  ArenaClient,
  ArenaClientOptions,
  ConnectedAcknowledgement
} from '@wrapped-labs/arena-types'

import {
  DEFAULT_BROKER_HOST,
  DEFAULT_BROKER_REQUESTS_PORT,
  DEFAULT_BROKER_SERVER_PORT,
  DEFAULT_CLIENT_PING_INTERVAL,
  DEFAULT_CLIENT_RECEIVE_TIMEOUT,
  DEFAULT_CLIENT_REPLY_TIMEOUT,
  DEFAULT_CLIENT_SEND_TIMEOUT,
  DEFAULT_LINGER
} from './defaults'
import { ZMQOptions } from './internal'

export class ArenaZMQClient<Request extends Aggregable, Reply>
  implements ArenaClient<Request, Reply>
{
  broker: {
    host: string
    ports: { requests: number; server: number }
  }

  private readonly requests: zmq.Subscriber

  private readonly server: zmq.Request

  private readonly socketQueue: PQueue = new PQueue({ concurrency: 1 })

  private replyHooks: Record<string, (reply: ProcessedReply<Reply>) => void> = {}

  replyTimeout: number

  zmq: ZMQOptions

  started = false

  pingInterval: number

  onError: (error: unknown) => void

  pingTimeout: ReturnType<typeof setTimeout> | undefined

  constructor(options: ArenaClientOptions & { zmq?: ZMQOptions }) {
    const {
      broker = {
        host: DEFAULT_BROKER_HOST,
        ports: { requests: DEFAULT_BROKER_REQUESTS_PORT, server: DEFAULT_BROKER_SERVER_PORT }
      },
      replyTimeout = DEFAULT_CLIENT_REPLY_TIMEOUT,
      zmq: zmqOptions = {
        linger: DEFAULT_LINGER,
        sendTimeout: DEFAULT_CLIENT_SEND_TIMEOUT,
        receiveTimeout: DEFAULT_CLIENT_RECEIVE_TIMEOUT
      },
      pingInterval = DEFAULT_CLIENT_PING_INTERVAL,
      onError = (error: unknown): void => {
        void Promise.reject(error)
      }
    } = options

    this.requests = new zmq.Subscriber({ linger: zmqOptions.linger })
    this.server = new zmq.Request({ sendHighWaterMark: 1, ...zmqOptions })
    this.server = new zmq.Request({ linger: zmqOptions.linger })
    this.broker = broker
    this.replyTimeout = replyTimeout
    this.zmq = zmqOptions
    this.pingInterval = pingInterval
    this.onError = onError
  }

  async start(): Promise<void> {
    let connected = false
    let onConnected: () => void | undefined
    const debug = Debug(
      `arena:zmq:client:${this.broker.ports.requests}:${this.broker.ports.server}`
    )

    const waitForConnection = new Promise<void>((resolve) => {
      onConnected = resolve
    })

    const startPinging = (): void => {
      const ping = (): void => {
        void (async (): Promise<void> => {
          if (!connected) {
            debug('connecting')
          }

          try {
            if (!this.server.closed) {
              await this.socketQueue.add(async (): Promise<void> => {
                await this.server.send(
                  JSON.stringify({
                    acknowledgement: { type: 'client-ping' }
                  })
                )

                await this.server.receive()

                if (!connected) {
                  debug('connected')
                  connected = true
                  onConnected()
                }
              })

              this.pingTimeout = setTimeout(ping, this.pingInterval)
            }
          } catch (error) {
            if (!connected) {
              debug('not-connected')
              this.pingTimeout = setTimeout(ping, this.pingInterval)
              // TODO: connection timeout
            } else {
              void this.onError(error)
            }
          }
        })()
      }

      ping()
    }

    if (!this.started) {
      void (async (): Promise<void> => {
        this.requests.connect(`tcp://${this.broker.host}:${this.broker.ports.requests}`)
        this.server.connect(`tcp://${this.broker.host}:${this.broker.ports.server}`)
        this.requests.subscribe('replies')

        for await (const [rawTopic, rawRequest] of this.requests) {
          if (this.started) {
            const topic = rawTopic.toString()
            const request = JSON.parse(rawRequest.toString()) as ProcessedReply<Reply>

            if (topic === 'replies') {
              if (this.replyHooks[request.acknowledgement.id]) {
                setImmediate(() => {
                  this.replyHooks[request.acknowledgement.id](request)
                })
              }
            }
          } else {
            break
          }
        }
      })()

      void startPinging()

      await waitForConnection

      this.started = true
    }
  }

  async send<ScopedReply = Reply>(request: Request): Promise<ConnectedAcknowledgement<ScopedReply>> {
    if (!this.started) {
      await this.start()
    }

    let rawAck

    await this.socketQueue.add(async (): Promise<void> => {
      await this.server.send(JSON.stringify({ ...request, acknowledgement: { type: 'request' } }))
      rawAck = await this.server.receive()
    })

    if (!rawAck) {
      throw new Error('failed to get ack')
    }

    const [status, ...body] = JSON.parse((rawAck as Buffer).toString()) as
      | [503, ...any]
      | [200, string]

    if (status === 503) {
      throw new Error('503 broker unavailable')
    }

    const [requestId] = body as string[]

    const waitForReply: Promise<ProcessedReply<ScopedReply>> = new Promise((resolve, reject) => {
      const timeout = setTimeout((): void => {
        delete this.replyHooks[requestId]
        reject(new Error(`timed out after waiting ${this.replyTimeout}ms for reply: ${requestId}`))
      }, this.replyTimeout)

      this.replyHooks[requestId] = (reply: ProcessedReply<Reply>): void => {
        delete this.replyHooks[requestId]
        clearInterval(timeout)
        resolve((reply as unknown) as ProcessedReply<ScopedReply>)
      }
    })

    return {
      aggregate: request.aggregate,
      acknowledgement: {
        type: 'request',
        id: requestId
      },
      waitForReply
    }
  }

  async close(): Promise<void> {
    if (!this.requests.closed) {
      this.requests.close()
    }

    if (!this.server.closed) {
      this.server.close()
    }

    this.started = false

    if (this.pingTimeout != null) {
      clearInterval(this.pingTimeout)
    }

    return await Promise.resolve()
  }
}
