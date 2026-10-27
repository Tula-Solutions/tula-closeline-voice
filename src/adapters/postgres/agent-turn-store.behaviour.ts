import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import type { AgentTurnStore, ConversationRef, NewAgentTurn } from '~/ports/agent-turn-store'

/** A fresh Organization id. */
export const newOrganizationId = (): string => formatId('org', crypto.randomUUID())

/** A fresh try-it session, the conversation kind that needs no parent row. */
export const newTrySession = (): ConversationRef => ({
  kind: 'try',
  id: formatId('try', crypto.randomUUID()),
})

const doc = () => formatId('doc', crypto.randomUUID())

/** A turn to store, with sources only on an Agent turn. */
export function turn(index: number, over: Partial<NewAgentTurn> = {}): NewAgentTurn {
  return {
    index,
    role: index % 2 === 0 ? 'prospect' : 'agent',
    text: `turn ${index}`,
    deferred: false,
    toolName: null,
    sources: [],
    ...over,
  }
}

/** The behaviour every {@link AgentTurnStore} must show, run against each adapter. */
export function agentTurnStoreBehaviour(name: string, make: () => AgentTurnStore): void {
  describe(`AgentTurnStore (${name})`, () => {
    test('stores a turn with its sources in order and reads it back', async () => {
      const store = make()
      const org = newOrganizationId()
      const c = newTrySession()
      const sources = [
        { documentId: doc(), page: 3, passage: 'first' },
        { documentId: doc(), page: null, passage: 'second' },
      ]
      const { turn: stored, created } = await store.append(
        org,
        c,
        turn(1, { sources, toolName: 'hand_off' })
      )
      expect(created).toBe(true)
      expect(stored.sources).toEqual(sources)
      expect(await store.get(org, c, 1)).toEqual(stored)
      expect(stored.toolName).toBe('hand_off')
    })

    test('storing the same index again keeps the first turn and says so', async () => {
      const store = make()
      const org = newOrganizationId()
      const c = newTrySession()
      const first = await store.append(org, c, turn(0, { text: 'original' }))
      const again = await store.append(org, c, turn(0, { text: 'changed' }))
      expect(again.created).toBe(false)
      expect(again.turn).toEqual(first.turn)
      expect(await store.recent(org, c, 10, 10)).toHaveLength(1)
    })

    test('recent stays at the latest turns in a long conversation', async () => {
      const store = make()
      const org = newOrganizationId()
      const c = newTrySession()
      for (let i = 0; i < 260; i += 1) {
        await store.append(org, c, turn(i))
      }
      const recent = await store.recent(org, c, 260, 3)
      expect(recent.map((t) => t.index)).toEqual([257, 258, 259])
    })

    test('recent returns the latest turns below the bound, oldest first', async () => {
      const store = make()
      const org = newOrganizationId()
      const c = newTrySession()
      for (let i = 0; i < 6; i += 1) {
        await store.append(org, c, turn(i))
      }
      const recent = await store.recent(org, c, 5, 3)
      expect(recent.map((t) => t.index)).toEqual([2, 3, 4])
    })

    test('conversations and Organizations do not see each other', async () => {
      const store = make()
      const orgA = newOrganizationId()
      const orgB = newOrganizationId()
      const c = newTrySession()
      await store.append(orgA, c, turn(0))
      await store.append(orgA, newTrySession(), turn(0))
      expect(await store.get(orgB, c, 0)).toBeUndefined()
      expect(await store.recent(orgB, c, 10, 10)).toEqual([])
      expect(await store.recent(orgA, c, 10, 10)).toHaveLength(1)
    })
  })
}
