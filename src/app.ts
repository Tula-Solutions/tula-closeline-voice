import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { type AuthedEnv, authenticate } from '~/http/auth'
import { createBaseApp } from '~/http/base'
import { createRouter } from '~/http/router'
import { registerSecuritySchemes } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { createAgentSettingsRouter } from '~/modules/agent-settings/router'
import { createCallRouter } from '~/modules/call/router'
import { createCallTurnsRouter } from '~/modules/call-turns/router'
import { createHealthRouter } from '~/modules/health/router'
import { createLineRouter } from '~/modules/line/router'
import { createSoftphoneRouter } from '~/modules/softphone/router'
import { createTranscriptRouter } from '~/modules/transcript/router'
import { createWebhookRouter } from '~/modules/webhook/router'
import { serveOpenApi } from '~/openapi'

/** Build the HTTP app from a container. Modules are mounted here as they are added. */
export function createApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createBaseApp(container)

  registerSecuritySchemes(app)
  app.route('/', createHealthRouter(container))
  // The provider calls these without an access token; each request proves itself by signature.
  app.route('/', createWebhookRouter(container))

  // Trusted services call these with the shared secret (ADR 0013), not an access token.
  app.route('/', createCallTurnsRouter(container))

  // Everything under /v1 requires a verified access token.
  const publicRoutes = createRouter<AuthedEnv>()
  publicRoutes.use('*', authenticate(container))
  publicRoutes.route('/', createLineRouter(container))
  publicRoutes.route('/', createAgentSettingsRouter(container))
  publicRoutes.route('/', createSoftphoneRouter(container))
  publicRoutes.route('/', createCallRouter(container))
  publicRoutes.route('/', createTranscriptRouter(container))
  app.route('/v1', publicRoutes)
  serveOpenApi(app)

  return app
}
