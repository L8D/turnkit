/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-loop-func */

import Debug from 'debug'
import * as zmq from 'zeromq'
import { v4 as uuidv4 } from 'uuid'
import { Aggregable, ArenaWorker, ArenaWorkerOptions } from '@wrapped-labs/arena-types'
import {
  DEFAULT_BROKER_HOST,
  DEFAULT_BROKER_REQUESTS_PORT,
  DEFAULT_BROKER_SERVER_PORT,
  DEFAULT_LINGER,
  DEFAULT_WORKER_HOST,
  DEFAULT_WORKER_PING_INTERVAL,
  DEFAULT_WORKER_RECEIVE_TIMEOUT,
  DEFAULT_WORKER_SEND_TIMEOUT
} from './defaults'
import { ZMQOptions } from './internal'
import ConsistentHashing from './hashring'

export class ArenaZMQWorker<Request extends Aggregable, Reply> implements ArenaWorker {
  id: string

  host: string

  broker: {
    host: string
    ports: { requests: number; server: number }
  }

  port: number

  private readonly processor: ArenaWorkerOptions<Request, Reply>['processor']

  public aggregateName: string

  pingInterval: number

  zmq: ZMQOptions

  started = false

  close: (error?: unknown) => Promise<void>

  onError: (error: unknown) => void

  constructor(options: ArenaWorkerOptions<Request, Reply> & { zmq?: ZMQOptions }) {
    const {
      processor,
      workerId = uuidv4(),
      host = DEFAULT_WORKER_HOST,
      port,
      broker = {
        host: DEFAULT_BROKER_HOST,
        ports: { requests: DEFAULT_BROKER_REQUESTS_PORT, server: DEFAULT_BROKER_SERVER_PORT }
      },
      aggregateName,
      zmq: zmqOptions = {
        linger: DEFAULT_LINGER,
        sendTimeout: DEFAULT_WORKER_SEND_TIMEOUT,
        receiveTimeout: DEFAULT_WORKER_RECEIVE_TIMEOUT
      },
      onError = (error: unknown): void => {
        void Promise.reject(error)
      },
      pingInterval = DEFAULT_WORKER_PING_INTERVAL
    } = options

    this.onError = onError
    this.processor = processor
    this.id = workerId
    this.host = host
    this.port = port
    this.broker = broker
    this.close = async (): Promise<void> => await Promise.resolve()
    this.aggregateName = aggregateName
    this.zmq = zmqOptions
    this.pingInterval = pingInterval
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }

    this.started = true

    // TODO: make context.blocky configurable
    const input = new zmq.Subscriber({ linger: this.zmq.linger })
    const inputAddress = `tcp://${this.broker.host}:${this.broker.ports.requests}`
    const output = new zmq.Request({ linger: this.zmq.linger })
    const outputAddress = `tcp://${this.broker.host}:${this.broker.ports.server}`
    const pingOutput = new zmq.Request({ linger: this.zmq.linger })
    const pingOutputAddress = `tcp://${this.broker.host}:${this.broker.ports.server}`
    const workerId = this.id
    const heartbeatAddress = `tcp://${this.host}:${this.port}`
    input.connect(inputAddress)
    output.connect(outputAddress)
    pingOutput.connect(pingOutputAddress)
    input.subscribe('partitions')

    const debug = Debug(`arena:zmq:worker:${workerId}:${heartbeatAddress}`)

    let hashring: ConsistentHashing | undefined
    let partitioningId = ''

    let pingTimeout: ReturnType<typeof setTimeout> | undefined
    let currentPartitionName = ''

    let heartStartedHook: undefined | (() => void)
    const heartbeatServer = new zmq.Reply({ linger: this.zmq.linger })

    this.close = async (error?: unknown): Promise<void> => {
      this.started = false

      if (error) {
        this.onError(error)
      }

      if (pingTimeout != null) {
        clearInterval(pingTimeout)
      }

      if (!input.closed) {
        input.close()
      }

      if (!output.closed) {
        output.close()
      }

      if (!pingOutput.closed) {
        pingOutput.close()
      }

      try {
        await heartbeatServer.unbind(heartbeatAddress)
        heartbeatServer.close()
      } catch (ignorable) {
        debug(
          'error when unbinding heartbeatAddress error.message="%s"',
          (ignorable as Error)?.message
        )
      }
    }

    const { close } = this

    const startPinging = (): void => {
      const ping = (): void => {
        void (async (): Promise<void> => {
          try {
            if (!this.started && !pingOutput.closed) {
              debug('stop-ping')
              pingOutput.close()
            } else if (!pingOutput.closed) {
              await pingOutput.send(
                JSON.stringify({
                  acknowledgement: { type: 'ping', workerId, heartbeatAddress },
                  aggregate: { name: this.aggregateName }
                })
              )

              const rawReply = await pingOutput.receive()

              const reply = JSON.parse(rawReply.toString()) as {
                partitioningId: string
                partitions: Array<{ id: string, workerId: string, aggregateName: string }>
              }

              // TODO: remove duplications
              //       use BrokerState type
              const currentPartition = reply.partitions.find(
                (partition) => partition.workerId === workerId
              )

              if (!input.closed) {
                input.unsubscribe(`requests:${this.aggregateName}:${currentPartitionName}`)
              }
              hashring = new ConsistentHashing(
                reply.partitions
                  .filter((p) => {
                    return p.aggregateName === this.aggregateName
                  })
                  .map((p) => p.id)
              )
              currentPartitionName = currentPartition?.id || ''
              partitioningId = reply.partitioningId

              if (partitioningId !== reply.partitioningId) {
                debug('see partitioning=%s', reply.partitioningId)
              }
              if (currentPartitionName) {
                if (!input.closed) {
                  input.subscribe(`requests:${this.aggregateName}:${currentPartitionName}`)
                }
              }

              pingTimeout = setTimeout(ping, this.pingInterval)
            }
          } catch (error) {
            void close(error)
          }
        })()
      }

      ping()
    }

    const startProcessing = async (): Promise<void> => {
      for await (const [rawTopic, rawMsg] of input) {
        if (!this.started) {
          if (!input.closed) {
            input.close()
          }

          if (!output.closed) {
            output.close()
          }
        } else {
          const topic = rawTopic.toString()
          if (topic === 'partitions') {
            if (!input.closed) {
              input.unsubscribe(`requests:${this.aggregateName}:${currentPartitionName}`)
            }
            const msg = JSON.parse(rawMsg.toString()) as {
              partitioningId: string
              partitions: Array<{ id: string, workerId: string, aggregateName: string }>
            }
            const { partitions } = msg
            const currentPartition = partitions.find((partition) => partition.workerId === workerId)
            currentPartitionName = currentPartition?.id || ''
            hashring = new ConsistentHashing(
              partitions
                .filter((p) => {
                  return p.aggregateName === this.aggregateName
                })
                .map((p) => p.id)
            )
            if (partitioningId !== msg.partitioningId) {
              debug('see partitioning=%s', msg.partitioningId)
            }
            partitioningId = msg.partitioningId
            if (currentPartitionName) {
              if (!input.closed) {
                input.subscribe(`requests:${this.aggregateName}:${currentPartitionName}`)
              }
            }
          } else if (topic.startsWith('requests:')) {
            const [, aggregateName, partitionName] = `${topic}`.split(':', 3)

            if (aggregateName === this.aggregateName && partitionName === currentPartitionName) {
              const msg = JSON.parse(rawMsg.toString()) as Request & {
                acknowledgement: { type: 'request'; id: string }
              }
              debug('processing request=%s', msg.acknowledgement.id)

              const isOwner = (id: string): boolean => {
                if (hashring != null) {
                  return hashring.getNode(id) === currentPartitionName
                }

                return false
              }

              let reply

              // TODO: handle async generators to allow
              //       chunked replies with an incrementing
              //       number
              try {
                reply = await this.processor(msg, isOwner)
              } catch (error) {
                // close and allow the broker to
                // assign the request to another
                // worker
                await this.close(error)
              }

              if (reply != null) {
                debug('finished processing request=%s', msg.acknowledgement.id)

                await output.send(
                  JSON.stringify({
                    ...reply,
                    acknowledgement: {
                      type: 'reply',
                      id: msg.acknowledgement.id
                    }
                  })
                )
                debug('sent reply request=%s', msg.acknowledgement.id)

                const replyReceipt = await output.receive()
                if (replyReceipt.toString() !== '{"status":"acknowledged"}') {
                  debug('bad receipt from broker "%s"', replyReceipt.toString())
                }
              }
            } else {
              debug('wrong partition for worker? partition=%s', partitionName)
            }
          } else {
            debug('ignoring topic=%s msg=%s', rawTopic.toString(), rawMsg.toString())
          }
        }
      }
    }

    void (async (): Promise<void> => {
      await heartbeatServer.bind(heartbeatAddress)

      // TODO: investigate this
      //
      // sometimes this fails https://github.com/wrappedfi/app.wrapped.com/runs/5840957835
      for await (const [rawMsg] of heartbeatServer) {
        if (heartStartedHook != null) {
          setImmediate(heartStartedHook)
        }

        if (!this.started && !heartbeatServer.closed) {
          heartbeatServer.close()
        } else {
          const msg = JSON.parse(rawMsg.toString()) as {
            partitioningId: string
            partitions: Array<{ id: string, workerId: string, aggregateName: string }>
          }
          const { partitions } = msg
          const currentPartition = partitions.find((partition) => partition.workerId === workerId)
          if (!input.closed) {
            input.unsubscribe(`requests:${this.aggregateName}:${currentPartitionName}`)
          }
          hashring = new ConsistentHashing(
            partitions
              .filter((p) => {
                return p.aggregateName === this.aggregateName
              })
              .map((p) => p.id)
          )
          currentPartitionName = currentPartition?.id || ''
          partitioningId = msg.partitioningId
          if (partitioningId !== msg.partitioningId) {
            debug('see partitioning=%s', msg.partitioningId)
          }
          if (currentPartitionName) {
            if (!input.closed) {
              input.subscribe(`requests:${this.aggregateName}:${currentPartitionName}`)
            }
          }
          if (!heartbeatServer.closed) {
            await heartbeatServer.send(
              JSON.stringify({ acknowledgement: { status: 'healthy', partitioningId } })
            )
          }
        }
      }
    })().catch(close)

    void startPinging()
    void startProcessing().catch(close)

    await new Promise<void>((resolve) => {
      heartStartedHook = (): void => {
        heartStartedHook = undefined
        resolve()
      }
    })
  }
}
