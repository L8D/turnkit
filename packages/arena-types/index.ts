export interface Aggregable {
  aggregate: {
    name: string
    id: string
  }
}

export interface Processable {
  acknowledgement: {
    id: string
  }
}

export type ProcessedReply<Reply> = Reply &
  Aggregable & { acknowledgement: { type: 'reply'; id: string } }

export type Acknowledgement = Aggregable & {
  acknowledgement: { type: 'request'; id: string }
}

// TODO: sort property names alphabetically

export interface ArenaWorker {
  id: string
  started: boolean
  close: () => Promise<void>
  start: () => Promise<void>
}

export interface ArenaBroker {
  started: boolean
  close: () => Promise<void>
  start: () => Promise<void>
}

export type ConnectedAcknowledgement<Reply> = Acknowledgement & {
  waitForReply: Promise<ProcessedReply<Reply>>
}

export interface ArenaClient<Request extends Aggregable, Reply> {
  started: boolean
  close: () => Promise<void>
  start: () => Promise<void>
  send: <ScopedReply = Reply,>(request: Request) => Promise<ConnectedAcknowledgement<ScopedReply>>
}

export interface ArenaWorkerOptions<Request extends Aggregable, Reply> {
  type: 'worker'
  processor: (
    request: Request & { acknowledgement: { type: 'request'; id: string } },
    isOwner: (id: string) => boolean
  ) => Promise<Reply> | Reply
  host?: string
  port: number
  broker?: {
    host: string
    ports: { requests: number; server: number }
  }
  workerId?: string
  aggregateName: string
  autoStart?: boolean
  pingInterval?: number
  onError?: (error: unknown) => void
}

export interface ArenaBrokerOptions<Request extends Aggregable, Reply> {
  type: 'broker'
  host?: string
  ports?: { requests: number; server: number }
  autoStart?: boolean
  heartrate?: number
  retryDelay?: number
  onError?: (error: unknown) => void
  onRequest?: (
    request: Request & { acknowledgement: { type: 'request'; id: string } }
  ) => Promise<void> | void
  onReply?: (reply: ProcessedReply<Reply>) => Promise<void> | void
}

export interface ArenaClientOptions {
  type: 'client'
  broker?: {
    host: string
    ports: { requests: number; server: number }
  }
  autoStart?: boolean
  replyTimeout?: number
  pingInterval?: number
  onError?: (error: unknown) => void
}

export interface Arena<Request extends Aggregable, Reply> {
  (options: ArenaWorkerOptions<Request, Reply>): ArenaWorker
  (options: ArenaBrokerOptions<Request, Reply>): ArenaBroker
  (options: ArenaClientOptions): ArenaClient<Request, Reply>
}
