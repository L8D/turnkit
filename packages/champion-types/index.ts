/* eslint-disable @typescript-eslint/no-unused-vars */

import { Aggregable, Acknowledgement } from '@wrapped-labs/arena-types'
import { Commitable, Snapshot } from '@wrapped-labs/turnstile-types'

export type Competitor<
  Event extends Commitable,
  State,
  Request extends Aggregable,
  Reply,
  Context = Record<string, unknown>
> = (
  request: Request & Acknowledgement,
  context: { partition: Record<string, Snapshot<State>> } & Context
) => Promise<Reply> | Reply
