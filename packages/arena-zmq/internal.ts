import { Aggregable, ProcessedReply } from '@wrapped-labs/arena-types'

export interface ClientPing {
  acknowledgement: { type: 'client-ping' }
}

export interface WorkerPing {
  acknowledgement: { type: 'ping'; workerId: string; heartbeatAddress: string }
  aggregate: { name: string }
}

export type ClientRequest<Request extends Aggregable> = Request & {
  acknowledgement: {
    type: 'request'
    replay?: boolean
    id?: string
  }
}

export interface BrokerHeartbeat {
  acknowledgement: { type: 'heartbeat' }
}

export interface HeartbeatReply {
  acknowledgement: { type: 'reply'; status: 'healthy'; partitioningId: string }
}

export type BrokerInput<Request extends Aggregable, Reply> =
  | ClientPing
  | WorkerPing
  | ClientRequest<Request>
  | ProcessedReply<Reply>
  | BrokerHeartbeat

export interface ZMQOptions {
  sendTimeout: number
  receiveTimeout: number
  linger: number
}
