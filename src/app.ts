import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { type AuthedEnv, authenticate } from '~/http/auth'
import { createBaseApp } from '~/http/base'
import { createRouter } from '~/http/router'
import { registerSecuritySchemes } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { createHealthRouter } from '~/modules/health/router'
import { createLineRouter } from '~/modules/line/router'
import { serveOpenApi } from '~/openapi'

/** Build the HTTP app from a container. Modules are mounted here as they are added. */
export function createApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createBaseApp(container)

  registerSecuritySchemes(app)
  app.route('/', createHealthRouter(container))

  // Everything under /v1 requires a verified access token.
  const publicRoutes = createRouter<AuthedEnv>()
  publicRoutes.use('*', authenticate(container))
  publicRoutes.route('/', createLineRouter(container))
  app.route('/v1', publicRoutes)
  serveOpenApi(app)

  return app
}
