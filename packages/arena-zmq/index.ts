import {
  Aggregable,
  ArenaBroker,
  ArenaBrokerOptions,
  ArenaClient,
  ArenaClientOptions,
  ArenaWorker,
  ArenaWorkerOptions
} from '@wrapped-labs/arena-types'

import { ZMQOptions } from './internal'
import { ArenaZMQWorker } from './ArenaZMQWorker'
import { ArenaZMQBroker } from './ArenaZMQBroker'
import { ArenaZMQClient } from './ArenaZMQClient'

class Namespace {
  static arena<Request extends Aggregable, Reply>(
    options: ArenaWorkerOptions<Request, Reply> & { zmq?: ZMQOptions }
  ): Promise<ArenaWorker>
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static arena<Request extends Aggregable, Reply>(
    options: ArenaBrokerOptions<Request, Reply> & { zmq?: ZMQOptions }
  ): Promise<ArenaBroker>
  static arena<Request extends Aggregable, Reply>(
    options: ArenaClientOptions & { zmq?: ZMQOptions }
  ): Promise<ArenaClient<Request, Reply>>
  static async arena<Request extends Aggregable, Reply>(
    options: (
      | ArenaWorkerOptions<Request, Reply>
      | ArenaBrokerOptions<Request, Reply>
      | ArenaClientOptions
    ) & {
      zmq?: ZMQOptions
    }
  ): Promise<unknown> {
    const { autoStart = true } = options

    if (options.type === 'worker') {
      const worker = new ArenaZMQWorker<Request, Reply>(options)

      if (autoStart) {
        await worker.start()
      }

      return worker
    }

    if (options.type === 'broker') {
      const broker = new ArenaZMQBroker(options)

      if (autoStart) {
        await broker.start()
      }

      return broker
    }

    if (options.type === 'client') {
      const client = new ArenaZMQClient(options)

      if (autoStart) {
        await client.start()
      }

      return client
    }

    throw new Error('valid types: worker, broker, client')
  }
}

// eslint-disable-next-line @typescript-eslint/unbound-method
export default Namespace.arena

export * from '@wrapped-labs/arena-types'
