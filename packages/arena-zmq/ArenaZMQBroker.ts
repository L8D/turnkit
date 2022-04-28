/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */

import Debug from 'debug'
import PQueue from 'p-queue'
import { v5 as uuidv5, v4 as uuidv4 } from 'uuid'
import * as zmq from 'zeromq'

import {
  Acknowledgement,
  Aggregable,
  ArenaBroker,
  ArenaBrokerOptions,
  Processable,
  ProcessedReply
} from '@wrapped-labs/arena-types'
import { BrokerInput, ClientRequest, HeartbeatReply, WorkerPing, ZMQOptions } from './internal'
import ConsistentHashing from './hashring'
import {
  DEFAULT_BROKER_HEARTRATE,
  DEFAULT_BROKER_HOST,
  DEFAULT_BROKER_RECEIVE_TIMEOUT,
  DEFAULT_BROKER_REQUESTS_PORT,
  DEFAULT_BROKER_RETRY_DELAY,
  DEFAULT_BROKER_SEND_TIMEOUT,
  DEFAULT_BROKER_SERVER_PORT,
  DEFAULT_LINGER
} from './defaults'

const getPartitionName = (msg: string): string => {
  return uuidv5(msg, '00000000-0000-0000-0000-000000000000')
}

interface Aggregate {
  name: string
  hashring?: ConsistentHashing
}

export class ArenaZMQBroker<Request extends Aggregable, Reply> implements ArenaBroker {
  started = false

  close: (error?: unknown) => Promise<void>

  host: string

  ports: { requests: number; server: number }

  zmq: ZMQOptions

  heartrate: number

  retryDelay: number

  onError: (error: unknown) => void

  onRequest: (
    request: Request & { acknowledgement: { type: 'request'; id: string } }
  ) => Promise<void> | void

  onReply: (reply: ProcessedReply<Reply>) => Promise<void> | void

  constructor(options: ArenaBrokerOptions<Request, Reply> & { zmq?: ZMQOptions }) {
    const {
      host = DEFAULT_BROKER_HOST,
      ports = { requests: DEFAULT_BROKER_REQUESTS_PORT, server: DEFAULT_BROKER_SERVER_PORT },
      zmq: zmqOptions = {
        linger: DEFAULT_LINGER,
        sendTimeout: DEFAULT_BROKER_SEND_TIMEOUT,
        receiveTimeout: DEFAULT_BROKER_RECEIVE_TIMEOUT
      },
      heartrate = DEFAULT_BROKER_HEARTRATE,
      retryDelay = DEFAULT_BROKER_RETRY_DELAY,
      onError = (error: unknown): void => {
        void Promise.reject(error)
      },
      onRequest = (): void => {},
      onReply = (): void => {}
    } = options

    this.host = host
    this.ports = ports
    this.close = async (): Promise<void> => await Promise.resolve()
    this.zmq = zmqOptions
    this.heartrate = heartrate
    this.retryDelay = retryDelay
    this.onError = onError
    this.onRequest = onRequest
    this.onReply = onReply
  }

  async start(): Promise<void> {
    const outputAddress = `tcp://${this.host}:${this.ports.requests}`
    const inputAddress = `tcp://${this.host}:${this.ports.server}`
    if (this.started) {
      return
    }

    this.started = true

    const debug = Debug(`arena:zmq:broker:${this.ports.requests}:${this.ports.server}`)

    const output = new zmq.XPublisher({ linger: this.zmq.linger })
    const input = new zmq.Reply({ linger: this.zmq.linger })

    const workers: Record<
      string,
      {
        id: string
        heartbeatAddress: string
        latestPing: number
        healthy: boolean
        partitioningId: string
        aggregateName: string
      }
    > = {}

    let partitioningId = ''
    let partitions: Array<{ id: string, aggregateName: string, workerId: string }> = []
    let aggregates: Record<string, Aggregate> = {}

    const replyHooks: Record<string, () => void> = {}
    const deathHooks: Record<string, () => void> = {}
    const partitionDeathHooks: Record<string, () => void> = {}

    const pendingRequests = new Set<Promise<number>>()
    const publishingRequestsQueue = new PQueue({ concurrency: 1, autoStart: false })
    publishingRequestsQueue.pause()
    const publishingQueue = new PQueue({ concurrency: 1 })
    const repartitionQueue = new PQueue({ concurrency: 1 })

    this.close = async (error?: unknown): Promise<void> => {
      this.started = false

      if (error) {
        this.onError(error)
      }

      try {
        await input.unbind(inputAddress)
        input.close()
      } catch (ignorable) {
        debug('error when unbinding inputAddress error.message="%s"', (ignorable as Error)?.message)
      }

      try {
        await output.unbind(outputAddress)
        output.close()
      } catch (ignorable) {
        debug(
          'error when unbinding outputAddress error.message="%s"',
          (ignorable as Error)?.message
        )
      }

      partitions = []

      publishingRequestsQueue.clear()
      publishingRequestsQueue.pause()
      publishingQueue.clear()
      publishingQueue.pause()
    }

    const publishRequestAndWaitForReply = async (
      request: Request & Processable
    ): Promise<number> => {
      const untilReplyOrDeath: Promise<number> = new Promise((resolve, reject) => {
        void publishingRequestsQueue
          .add(async (): Promise<void> => {
            const aggregatePartitions = partitions.filter((p) => {
              return workers[p.workerId].aggregateName === request.aggregate.name
            })

            if (!aggregates[request.aggregate.name] || aggregatePartitions.length === 0) {
              resolve(503)
              return
            }

            await publishingQueue.add(async (): Promise<void> => {
              try {
                const requestId = (request as Processable).acknowledgement.id

                const aggregate = aggregates[request.aggregate.name]

                if (aggregate.hashring == null) {
                  resolve(503)
                  return
                }

                const partitionName = aggregate.hashring.getNode(request.aggregate.id)

                const targetPartition = partitions.find(
                  (partition) => partition.id === partitionName
                )

                if (targetPartition == null) {
                  debug('partition out of sync partition=%s', partitionName)
                  resolve(503)
                } else if (workers[targetPartition.workerId].partitioningId !== partitioningId) {
                  debug(
                    'worker out of sync request=%s worker=%s',
                    requestId,
                    targetPartition.workerId
                  )
                  resolve(503)
                } else {
                  const cleanup = (): void => {
                    delete replyHooks[requestId]
                    delete deathHooks[requestId]
                  }

                  const makeHook =
                    (result: number): (() => void) =>
                    (): void => {
                      cleanup()
                      resolve(result)
                    }

                  replyHooks[requestId] = makeHook(200)

                  deathHooks[targetPartition.workerId] = (): void => {
                    if (this.started) {
                      debug('death hook worker=%s request=%s', targetPartition.workerId, requestId)
                    }
                    cleanup()
                    resolve(503)
                  }

                  debug(
                    'broadcast request=%s partition=%s worker=%s',
                    requestId,
                    targetPartition.id,
                    targetPartition.workerId
                  )

                  const fullMsg = [
                    `requests:${request.aggregate.name}:${targetPartition.id}`,
                    JSON.stringify(request)
                  ]
                  if (!output.closed) {
                    await output.send(fullMsg)
                  }
                }
              } catch (error) {
                reject(error)
              }
            })
          })
          .catch(reject)
      })

      pendingRequests.add(untilReplyOrDeath)

      const status = await untilReplyOrDeath

      pendingRequests.delete(untilReplyOrDeath)

      return status
    }

    const startMonitoringBrokerHeartbeat = (): void => {
      const socket = new zmq.Request(this.zmq)
      socket.connect(inputAddress)

      const pulse = (): void => {
        void (async (): Promise<void> => {
          try {
            if (!socket.closed) {
              await socket.send('{"acknowledgement":{"type":"heartbeat"}}')
            }
            const reply = await socket.receive()

            if (reply.toString() === '{"healthy":true}') {
              if (this.started) {
                setTimeout(pulse, this.heartrate)
              }
            } else {
              throw new Error(`unknown broker heartbeat reply ${reply.toString()}`)
            }
          } catch (error) {
            if (this.started) {
              debug('broker heartbeat failed')
              void this.close(error)
            }
          }
        })()
      }

      void pulse()
    }

    const repartition = (): void => {
      for (const worker of Object.values(workers)) {
        if (!aggregates[worker.aggregateName]) {
          aggregates[worker.aggregateName] = {
            name: worker.aggregateName,
            hashring: undefined
          }
        }
      }

      const healthyWorkers = Object.values(workers).filter((worker) => worker.healthy)

      const healthyWorkerIds = healthyWorkers
        .map((w) => w.id)
        .sort()
        .join(',')

      const partitionWorkerIds = partitions
        .map((p) => p.workerId)
        .sort()
        .join(',')

      void repartitionQueue.add(async () => {
        if (healthyWorkerIds !== partitionWorkerIds) {
          const newPartitioningId = uuidv4()
          const newPartitions = healthyWorkers.map(
            (workerDetails: { id: string; aggregateName: string }) => ({
              id: getPartitionName(`${newPartitioningId}${workerDetails.id}`),
              workerId: workerDetails.id,
              aggregateName: workerDetails.aggregateName
            })
          )

          publishingRequestsQueue.pause()

          const newAggregates: Record<string, Aggregate> = {}

          for (const aggregate of Object.values(aggregates)) {
            const scopedPartitions = newPartitions.filter((p) => {
              return workers[p.workerId].aggregateName === aggregate.name
            })

            const hashring = new ConsistentHashing(scopedPartitions.map((p) => p.id))

            if (scopedPartitions.length > 0) {
              newAggregates[aggregate.name] = {
                name: aggregate.name,
                hashring
              }
            }
          }

          void publishingQueue.add(async () => {
            for (const oldPartition of partitions) {
              if (partitionDeathHooks[oldPartition.id]) {
                setImmediate(partitionDeathHooks[oldPartition.id])
                debug('scheduled death hook partition=%s', oldPartition.id)
              }
            }

            aggregates = newAggregates

            partitions = newPartitions
            partitioningId = newPartitioningId

            debug('new partitionging=%s', partitioningId)

            // if you want a monitoring view, use this:
            //
            // console.log(
            //   `partitioning=${partitioningId}`,
            //   partitions.map((p) => `partition=${p.id} worker=${p.workerId}`)
            // );

            if (!output.closed) {
              await output.send(['partitions', JSON.stringify({ partitioningId, partitions })])
            }
          })

          await Promise.all(pendingRequests)

          publishingRequestsQueue.start()
        } else {
          await publishingQueue.add(async () => {
            if (!output.closed) {
              await output.send(['partitions', JSON.stringify({ partitioningId, partitions })])
              debug('emitted partitions')
            }
          })
        }
      })
    }

    const startMonitoringWorkerHeartbeat = (id: string): void => {
      // TODO: adjust these numbers
      const socket = new zmq.Request(this.zmq)
      socket.connect(workers[id].heartbeatAddress)

      const pulse = (): void => {
        void (async (): Promise<void> => {
          try {
            if (!socket.closed) {
              await socket.send(JSON.stringify({ partitioningId, partitions }))
            }
            const rawReply = await socket.receive()

            const reply = JSON.parse(rawReply.toString()) as HeartbeatReply

            if (reply.acknowledgement.status === 'healthy') {
              workers[id].partitioningId = reply.acknowledgement.partitioningId

              if (!workers[id].healthy) {
                debug('healthy worker=%s partitioning=%s', id, reply.acknowledgement.partitioningId)
                workers[id].healthy = true
                repartition()
              }

              if (this.started) {
                setTimeout(pulse, this.heartrate)
              }
            } else {
              throw new Error(
                `unknown worker heartbeat status ${
                  reply.acknowledgement.status as unknown as string
                }`
              )
            }
          } catch (error) {
            if (error && (error as { code: string }).code === 'EAGAIN') {
              if (this.started) {
                debug('dead worker=%s', id)
              }
            } else {
              throw error
            }

            delete workers[id]
            if (deathHooks[id]) {
              if (this.started) {
                debug('calling death hook worker=%s', id)
              }
              setImmediate(deathHooks[id])
            }
            if (!socket.closed) {
              socket.close()
            }

            repartition()
          }
        })()
      }

      void pulse()
    }

    const monitorRequest = async (request: Request & Acknowledgement): Promise<void> => {
      let status

      const requestId = (request as Processable).acknowledgement.id

      do {
        status = await publishRequestAndWaitForReply(request)

        if (status === 200) {
          debug('finished monitoring request=%s', requestId)
          break
        } else if (status === 503) {
          debug(`republishing request=${requestId}`)
          await new Promise((resolve) => setTimeout(resolve, this.retryDelay))
        } else {
          throw new Error(`unrecognized status ${status}`)
        }
      } while (this.started)
    }

    const startProcessing = async (): Promise<void> => {
      for await (const [rawMsg] of input) {
        const msg = JSON.parse(rawMsg.toString()) as BrokerInput<Request, Reply>

        if (msg.acknowledgement.type === 'heartbeat') {
          if (!input.closed) {
            await input.send('{"healthy":true}')
          }
        } else if (msg.acknowledgement.type === 'ping') {
          const { workerId } = msg.acknowledgement
          const aggregateName = (msg as WorkerPing).aggregate.name
          const worker = workers[workerId]
          if (worker) {
            workers[workerId].latestPing = Date.now()
            workers[workerId].heartbeatAddress = msg.acknowledgement.heartbeatAddress
          } else {
            workers[workerId] = {
              id: workerId,
              latestPing: Date.now(),
              heartbeatAddress: msg.acknowledgement.heartbeatAddress,
              partitioningId: '',
              healthy: false,
              aggregateName
            }

            void startMonitoringWorkerHeartbeat(workerId)
            repartition()
          }

          if (!input.closed) {
            await input.send(JSON.stringify({ partitioningId, partitions }))
          }
        } else if (msg.acknowledgement.type === 'request') {
          const request = msg as ClientRequest<Request>
          debug('handling %s', rawMsg.toString())

          // TODO: check aggregate partitions not all partitions
          if (partitions.length === 0) {
            if (!input.closed) {
              await input.send(JSON.stringify([503, 'Server Unavailable']))
            }
          } else {
            const requestId =
              (request.acknowledgement.replay && request.acknowledgement.id) || uuidv4()

            const acknowledgedRequest = {
              ...request,
              acknowledgement: { ...request.acknowledgement, id: requestId }
            }

            await this.onRequest(acknowledgedRequest)

            void monitorRequest(acknowledgedRequest).catch(this.close)

            if (!input.closed) {
              await input.send(JSON.stringify([200, requestId]))
            }
          }
        } else if (msg.acknowledgement.type === 'reply') {
          const reply = msg as ProcessedReply<Reply>
          debug('emitting reply=%s', JSON.stringify(msg))

          if (replyHooks[reply.acknowledgement.id]) {
            setImmediate(replyHooks[reply.acknowledgement.id])
            debug('scheduled pending replyHook request=%s', reply.acknowledgement.id)
          } else {
            debug('missing replyHook request=%s', reply.acknowledgement.id)
          }

          await publishingQueue.add(async () => {
            await this.onReply(reply)
            if (!output.closed) {
              await output.send(['replies', JSON.stringify(reply)])
            }
          })

          if (!input.closed) {
            await input.send('{"status":"acknowledged"}')
          }
        } else if (msg.acknowledgement.type === 'client-ping') {
          await input.send('{"status":"acknowledged"}')
        } else {
          debug('unknown message type', JSON.stringify(msg))
        }
      }
    }

    await output.bind(outputAddress)
    await input.bind(inputAddress)

    void startProcessing().catch(this.close)
    void startMonitoringBrokerHeartbeat()
  }
}
