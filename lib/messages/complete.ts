import AggregateError from 'aggregate-error'
import { parse } from 'graphql'
import { CompleteMessage } from 'graphql-ws'
import { buildExecutionContext } from 'graphql/execution/execute'
import { collect } from 'streaming-iterables'
import { SubscribePseudoIterable, MessageHandler, PubSubEvent } from '../types'
import { deleteConnection } from '../utils/deleteConnection'
import { buildContext } from '../utils/buildContext'
import { getResolverAndArgs } from '../utils/getResolverAndArgs'
import { isArray } from '../utils/isArray'

/** Handler function for 'complete' message. */
export const complete: MessageHandler<CompleteMessage> =
  async ({ server, event, message }) => {
    server.log('messages:complete', { connectionId: event.requestContext.connectionId })
    try {
      const topicSubscriptions = await collect(server.mapper.query(server.model.Subscription, {
        id: `${event.requestContext.connectionId}|${message.id}`,
      }))
      if (topicSubscriptions.length === 0) {
        return
      }
      // only call onComplete on the first one as any others are duplicates
      const sub = topicSubscriptions[0]
      const execContext = buildExecutionContext(
        server.schema,
        parse(sub.subscription.query),
        undefined,
        await buildContext({ server, connectionInitPayload: sub.connectionInitPayload, connectionId: sub.connectionId }),
        sub.subscription.variables,
        sub.subscription.operationName,
        undefined,
      )

      if (isArray(execContext)) {
        throw new AggregateError(execContext)
      }

      const [field, root, args, context, info] = getResolverAndArgs(server)(execContext)

      const onComplete = (field?.subscribe as SubscribePseudoIterable<PubSubEvent>)?.onComplete
      server.log('messages:complete:onComplete', { onComplete: !!onComplete })
      await onComplete?.(root, args, context, info)

      await Promise.all(topicSubscriptions.map(sub => server.mapper.delete(sub)))
    } catch (err) {
      server.log('messages:complete:onError', { err, event })
      await server.onError?.(err, { event, message })
      await deleteConnection(server)(event.requestContext)
    }
  }
