import { describe, expect, it } from 'vitest'
import { firstChildIndex, parentIndex, verticalTarget } from './treeNav'

const nodes = [
  { depth: 0, kind: 'folder' as const },
  { depth: 1, kind: 'folder' as const },
  { depth: 2, kind: 'page' as const },
  { depth: 1, kind: 'page' as const }
]

describe('verticalTarget', () => {
  it('clamps moves to the list bounds', () => {
    expect(verticalTarget('ArrowDown', 3, 4)).toBe(3)
    expect(verticalTarget('ArrowUp', 0, 4)).toBe(0)
    expect(verticalTarget('End', 1, 4)).toBe(3)
  })

  it('starts at an end when nothing is focused', () => {
    expect(verticalTarget('ArrowDown', -1, 4)).toBe(0)
    expect(verticalTarget('ArrowUp', -1, 4)).toBe(3)
  })

  it('ignores other keys and empty lists', () => {
    expect(verticalTarget('a', 0, 4)).toBeNull()
    expect(verticalTarget('ArrowDown', -1, 0)).toBeNull()
  })
})

describe('parentIndex / firstChildIndex', () => {
  it('finds the enclosing folder', () => {
    expect(parentIndex(nodes, 2)).toBe(1)
    expect(parentIndex(nodes, 3)).toBe(0)
    expect(parentIndex(nodes, 0)).toBe(-1)
  })

  it('finds the first visible child', () => {
    expect(firstChildIndex(nodes, 1)).toBe(2)
    expect(firstChildIndex(nodes, 2)).toBe(-1)
    expect(firstChildIndex(nodes, 3)).toBe(-1)
  })
})
