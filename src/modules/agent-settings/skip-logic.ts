import type { QualificationQuestion, SkipCondition } from 'tula-closeline-contract'

/**
 * The first skip condition that does not look at an earlier question of the list, or `undefined`
 * when all do. A condition naming an unknown question, the question itself or a later one (which
 * would make a loop) is the offender.
 */
export function firstBadCondition(
  questions: readonly QualificationQuestion[]
): { question: QualificationQuestion; condition: SkipCondition } | undefined {
  const earlier = new Set<string>()
  for (const question of questions) {
    for (const condition of question.skipWhen) {
      if (!earlier.has(condition.questionId)) {
        return { question, condition }
      }
    }
    earlier.add(question.id)
  }
  return undefined
}

/** Renumbers a list 1..n in the order given. */
export function renumber(questions: readonly QualificationQuestion[]): QualificationQuestion[] {
  return questions.map((question, index) => ({ ...question, position: index + 1 }))
}
