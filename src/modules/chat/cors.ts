import type { MiddlewareHandler } from 'hono'
import type { Container } from '~/container'
import type { AppEnv } from '~/http/types'
import { allowedOriginsOfPath } from './service'

const METHODS = 'GET, POST, OPTIONS'
const ALLOWED_HEADERS = 'content-type, idempotency-key, authorization'
const EXPOSED_HEADERS = 'retry-after'

/**
 * CORS for the public Chat routes. The widget runs on a customer's site, so the answer names the
 * calling origin only when the site of the key or session in the path allows it (the same list the
 * routes check), never `*`. Any other origin gets no CORS header at all, a preflight included.
 */
export function chatCors(container: Pick<Container, 'chatSites'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header('origin')
    const allowed =
      origin !== undefined &&
      (await allowedOriginsOfPath(container, new URL(c.req.url).pathname)).includes(origin)
    const preflight = c.req.method === 'OPTIONS'
    if (preflight && !allowed) {
      return new Response(null, { status: 204, headers: { vary: 'Origin' } })
    }
    if (!preflight) {
      await next()
    }
    const response = preflight ? new Response(null, { status: 204 }) : c.res
    response.headers.append('vary', 'Origin')
    if (allowed) {
      response.headers.set('access-control-allow-origin', origin)
      response.headers.set('access-control-expose-headers', EXPOSED_HEADERS)
      if (preflight) {
        response.headers.set('access-control-allow-methods', METHODS)
        response.headers.set('access-control-allow-headers', ALLOWED_HEADERS)
        response.headers.set('access-control-max-age', '600')
      }
    }
    return response
  }
}
