import { describe, expect, test } from 'bun:test'
import {
  VOICE_CALL_FINAL_STATES,
  VOICE_CALL_STATES,
  type VoiceCallState,
} from 'tula-closeline-contract'
import { CALL_EDGES, canTransition } from './state'

const FINAL: readonly VoiceCallState[] = VOICE_CALL_FINAL_STATES

describe('Call state transitions', () => {
  test('every pair of states is decided, and only the listed edges are allowed', () => {
    for (const from of VOICE_CALL_STATES) {
      for (const to of VOICE_CALL_STATES) {
        const listed = CALL_EDGES[from].includes(to)
        // With a Disclosure stored, an edge is allowed exactly when it is listed.
        expect(canTransition(from, to, 1)).toBe(listed)
      }
    }
  })

  test('a final state has no way out', () => {
    for (const from of FINAL) {
      for (const to of VOICE_CALL_STATES) {
        expect(canTransition(from, to, 1)).toBe(false)
      }
    }
  })

  test('live and ended are never entered without a stored Disclosure version', () => {
    for (const from of VOICE_CALL_STATES) {
      expect(canTransition(from, 'live', null)).toBe(false)
      expect(canTransition(from, 'ended', null)).toBe(false)
    }
  })

  test('live is reachable only through disclosing', () => {
    const into = VOICE_CALL_STATES.filter((from) => canTransition(from, 'live', 1))
    expect(into).toEqual(['disclosing'])
  })

  test('with no Disclosure version, no walk from ringing reaches live or ended', () => {
    const reached = new Set<VoiceCallState>(['ringing'])
    for (const from of reached) {
      for (const to of VOICE_CALL_STATES) {
        if (canTransition(from, to, null)) {
          reached.add(to)
        }
      }
    }
    expect(reached.has('live')).toBe(false)
    expect(reached.has('ended')).toBe(false)
    expect(reached.has('failed')).toBe(true)
  })

  test('with a Disclosure version, a walk from ringing reaches live and ended', () => {
    const reached = new Set<VoiceCallState>(['ringing'])
    for (const from of reached) {
      for (const to of VOICE_CALL_STATES) {
        if (canTransition(from, to, 1)) {
          reached.add(to)
        }
      }
    }
    expect([...reached].sort()).toEqual([...VOICE_CALL_STATES].sort())
  })
})
