import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WarrantStatus, type Hex } from '@warrant/core'
import type { WarrantRecord } from './gateway.js'
import { fileWarrantStore, serializeRecord } from './journal.js'

function tempPath(name = 'warrants.jsonl'): string {
  return join(mkdtempSync(join(tmpdir(), 'warrant-journal-')), name)
}

function record(over: Partial<WarrantRecord> = {}): WarrantRecord {
  const id = (over.id ?? (`0x${'11'.repeat(32)}` as Hex)) as Hex
  return {
    id,
    agent: '0x00000000000000000000000000000000000000a1',
    beneficiary: '0x00000000000000000000000000000000000000b1',
    bond: '25000000',
    conditionHash: `0x${'22'.repeat(32)}` as Hex,
    actionHash: `0x${'33'.repeat(32)}` as Hex,
    fundingRef: `0x${'44'.repeat(32)}` as Hex,
    expiry: 1_800_000_000,
    openedAt: 1_799_999_000,
    status: WarrantStatus.Open,
    rail: 'x402',
    executionId: 'exec_1',
    actionSpec: {
      version: 1,
      chainId: 11155111,
      target: '0x00000000000000000000000000000000000000cc',
      value: '0',
      calldata: '0xa9059cbb',
      registryRef: `0x${'55'.repeat(32)}` as Hex,
    },
    conditionSpec: {
      version: 1,
      chainId: 11155111,
      evaluateAt: 'tx',
      confirmations: 1,
      checks: [{ kind: 'no_new_approvals', owner: '0x00000000000000000000000000000000000000a1', tokens: [] }],
    },
    classification: {
      category: 'erc20.transfer',
      params: { token: '0x00000000000000000000000000000000000000cc' },
      notionalUSD: '1000000',
      registryRef: `0x${'55'.repeat(32)}` as Hex,
    },
    quote: {
      category: 'erc20.transfer',
      bond: '25000000',
      riskBps: 100,
      notionalUSD: '1000000',
      conditionSpec: {
        version: 1,
        chainId: 11155111,
        evaluateAt: 'tx',
        confirmations: 1,
        checks: [],
      },
      rationale: 'test',
    },
    simulation: { success: true },
    settlement: {
      success: true,
      transaction: `0x${'66'.repeat(32)}` as Hex,
      network: 'eip155:11155111',
      payer: '0x00000000000000000000000000000000000000a1',
    },
    ...over,
  }
}

describe('journal — durability', () => {
  it('a written warrant survives the process shutting down', () => {
    const path = tempPath()
    fileWarrantStore(path).put(record())

    // A fresh store: exactly what a Settler restart does.
    const reopened = fileWarrantStore(path)
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.get(`0x${'11'.repeat(32)}` as Hex)?.executionId).toBe('exec_1')
  })

  it('finds a warrant whatever the case of its identifier', () => {
    const path = tempPath()
    const store = fileWarrantStore(path)
    store.put(record())
    const upper = `0x${'11'.repeat(32)}`.toUpperCase().replace('0X', '0x') as Hex
    expect(store.get(upper)?.executionId).toBe('exec_1')
  })

  it('the last write of a given warrant wins', () => {
    const path = tempPath()
    const store = fileWarrantStore(path)
    store.put(record({ executionId: 'exec_1' }))
    store.put(record({ executionId: 'exec_2' }))
    expect(fileWarrantStore(path).get(`0x${'11'.repeat(32)}` as Hex)?.executionId).toBe('exec_2')
    // Append-only: both lines really are in the file.
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})

describe('journal — following a file fed by another process', () => {
  it('refresh() reads only what was appended', () => {
    const path = tempPath()
    const settler = fileWarrantStore(path)
    expect(settler.list()).toHaveLength(0)

    // The Gateway, elsewhere, appends a line.
    appendFileSync(path, `${serializeRecord(record({ id: `0x${'aa'.repeat(32)}` as Hex }))}\n`)

    expect(settler.refresh()).toBe(1)
    expect(settler.get(`0x${'aa'.repeat(32)}` as Hex)).toBeDefined()
    // Nothing new: nothing to read back.
    expect(settler.refresh()).toBe(0)
  })

  it('never sees a line that is still being written', () => {
    const path = tempPath()
    const settler = fileWarrantStore(path)

    // Partial write: no trailing `\n`.
    const line = serializeRecord(record({ id: `0x${'bb'.repeat(32)}` as Hex }))
    appendFileSync(path, line.slice(0, 40))
    expect(settler.refresh()).toBe(0)
    expect(settler.list()).toHaveLength(0)

    // The writer finishes its line.
    appendFileSync(path, `${line.slice(40)}\n`)
    expect(settler.refresh()).toBe(1)
    expect(settler.get(`0x${'bb'.repeat(32)}` as Hex)).toBeDefined()
  })

  it('starts over if the file was truncated', () => {
    const path = tempPath()
    const store = fileWarrantStore(path)
    store.put(record())
    store.refresh() // the cursor now tracks the end of the file
    writeFileSync(path, '')
    expect(store.refresh()).toBe(0)
    // A file that shrinks means a truncation or a rotation: the byte offset no
    // longer means anything, so we start over rather than read at the wrong
    // place.
    expect(store.list()).toHaveLength(0)
  })
})

describe('journal — unreadable lines', () => {
  it('a corrupted line is reported, not fatal', () => {
    const path = tempPath()
    writeFileSync(
      path,
      ['{ not json', serializeRecord(record()), '{"id":"not-a-hash"}'].join('\n') + '\n',
    )
    const defects: string[] = []
    const store = fileWarrantStore({ path, onDefect: (d) => defects.push(d.error) })

    expect(store.list()).toHaveLength(1)
    expect(defects).toHaveLength(2)
    expect(defects[1]).toMatch(/id missing or malformed/)
  })

  it('rejects a line with no specs: an unevaluable warrant has no business in memory', () => {
    const path = tempPath()
    writeFileSync(path, `${JSON.stringify({ id: `0x${'11'.repeat(32)}` })}\n`)
    const store = fileWarrantStore({ path, onDefect: () => {} })
    expect(store.list()).toHaveLength(0)
  })
})
