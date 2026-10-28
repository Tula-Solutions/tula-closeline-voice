import { expect, test } from 'bun:test'
import { createApp } from './app'
import { SERVICE } from './info'
import { buildOpenApiDocument } from './openapi'
import { createTestDeps } from './testing'

type ServedDocument = {
  openapi: string
  info: { title: string }
  paths: Record<string, { get: { responses: Record<string, unknown> } }>
}

test('the app serves its OpenAPI document describing every route and the error body', async () => {
  const app = createApp(createTestDeps())

  const response = await app.request('/openapi.json')

  expect(response.status).toBe(200)
  const document = (await response.json()) as ServedDocument
  expect(document.openapi).toBe('3.1.0')
  expect(document.info.title).toBe(SERVICE)
  expect(Object.keys(document.paths).sort()).toEqual([
    '/healthz',
    '/internal/v1/agent-calls',
    '/internal/v1/agent-calls/{id}/dial',
    '/internal/v1/calls/{callId}/recording',
    '/internal/v1/calls/{callId}/turns',
    '/readyz',
    '/v1/agent-calls',
    '/v1/agent/question-order',
    '/v1/agent/questions',
    '/v1/agent/questions/{questionId}',
    '/v1/agent/settings',
    '/v1/calls',
    '/v1/calls/{callId}',
    '/v1/calls/{callId}/answer',
    '/v1/calls/{callId}/copilot/cards',
    '/v1/calls/{callId}/copilot/cards/{cardId}',
    '/v1/calls/{callId}/copilot/stream',
    '/v1/calls/{callId}/hangup',
    '/v1/calls/{callId}/recording',
    '/v1/calls/{callId}/transcript',
    '/v1/calls/{callId}/wrap-up',
    '/v1/copilot/settings',
    '/v1/handoffs',
    '/v1/handoffs/{handoffId}',
    '/v1/handoffs/{handoffId}/accept',
    '/v1/handoffs/{handoffId}/decline',
    '/v1/lines',
    '/v1/lines/{lineId}',
    '/v1/lines/{lineId}/assignment',
    '/v1/lines/{lineId}/release',
    '/v1/public/chat/sessions/{sessionToken}/callback-consent',
    '/v1/public/chat/sessions/{sessionToken}/messages',
    '/v1/public/chat/{key}/sessions',
    '/v1/softphone/token',
    '/webhooks/twilio/detection',
    '/webhooks/twilio/inbound',
    '/webhooks/twilio/recording',
    '/webhooks/twilio/status',
  ])
  expect(document.paths['/healthz']?.get.responses['500']).toBeDefined()
  expect(document.paths['/readyz']?.get.responses['503']).toBeDefined()
  expect(JSON.stringify(document.paths['/healthz']?.get.responses['500'])).toContain('code')
})

test('the document written by the script is the document the app serves', async () => {
  const app = createApp(createTestDeps())

  const served = await (await app.request('/openapi.json')).json()

  expect(JSON.parse(JSON.stringify(buildOpenApiDocument(app)))).toEqual(served)
})
