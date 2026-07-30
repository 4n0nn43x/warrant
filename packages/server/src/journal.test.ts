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

describe('journal — durabilité', () => {
  it('un mandat écrit survit à la fermeture du processus', () => {
    const path = tempPath()
    fileWarrantStore(path).put(record())

    // Nouveau store : c'est exactement ce que fait un redémarrage du Settler.
    const reopened = fileWarrantStore(path)
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.get(`0x${'11'.repeat(32)}` as Hex)?.executionId).toBe('exec_1')
  })

  it('retrouve un mandat quelle que soit la casse de son identifiant', () => {
    const path = tempPath()
    const store = fileWarrantStore(path)
    store.put(record())
    const upper = `0x${'11'.repeat(32)}`.toUpperCase().replace('0X', '0x') as Hex
    expect(store.get(upper)?.executionId).toBe('exec_1')
  })

  it('la dernière écriture d’un même mandat gagne', () => {
    const path = tempPath()
    const store = fileWarrantStore(path)
    store.put(record({ executionId: 'exec_1' }))
    store.put(record({ executionId: 'exec_2' }))
    expect(fileWarrantStore(path).get(`0x${'11'.repeat(32)}` as Hex)?.executionId).toBe('exec_2')
    // Append-only : les deux lignes sont bien dans le fichier.
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})

describe('journal — suivi d’un fichier alimenté par un autre processus', () => {
  it('refresh() ne lit que ce qui a été ajouté', () => {
    const path = tempPath()
    const settler = fileWarrantStore(path)
    expect(settler.list()).toHaveLength(0)

    // Le Gateway, ailleurs, ajoute une ligne.
    appendFileSync(path, `${serializeRecord(record({ id: `0x${'aa'.repeat(32)}` as Hex }))}\n`)

    expect(settler.refresh()).toBe(1)
    expect(settler.get(`0x${'aa'.repeat(32)}` as Hex)).toBeDefined()
    // Rien de neuf : rien à relire.
    expect(settler.refresh()).toBe(0)
  })

  it('ne voit jamais une ligne en cours d’écriture', () => {
    const path = tempPath()
    const settler = fileWarrantStore(path)

    // Écriture partielle : pas de `\n` final.
    const line = serializeRecord(record({ id: `0x${'bb'.repeat(32)}` as Hex }))
    appendFileSync(path, line.slice(0, 40))
    expect(settler.refresh()).toBe(0)
    expect(settler.list()).toHaveLength(0)

    // L'écrivain termine sa ligne.
    appendFileSync(path, `${line.slice(40)}\n`)
    expect(settler.refresh()).toBe(1)
    expect(settler.get(`0x${'bb'.repeat(32)}` as Hex)).toBeDefined()
  })

  it('repart de zéro si le fichier a été tronqué', () => {
    const path = tempPath()
    const store = fileWarrantStore(path)
    store.put(record())
    store.refresh() // le curseur suit désormais la fin du fichier
    writeFileSync(path, '')
    expect(store.refresh()).toBe(0)
    // Un fichier qui rétrécit est une troncature ou une rotation : le décalage
    // en octets ne veut plus rien dire, on repart de zéro plutôt que de lire au
    // mauvais endroit.
    expect(store.list()).toHaveLength(0)
  })
})

describe('journal — lignes illisibles', () => {
  it('une ligne corrompue est signalée, pas fatale', () => {
    const path = tempPath()
    writeFileSync(
      path,
      ['{ pas du json', serializeRecord(record()), '{"id":"pas-un-hash"}'].join('\n') + '\n',
    )
    const defects: string[] = []
    const store = fileWarrantStore({ path, onDefect: (d) => defects.push(d.error) })

    expect(store.list()).toHaveLength(1)
    expect(defects).toHaveLength(2)
    expect(defects[1]).toMatch(/id absent ou malformé/)
  })

  it('rejette une ligne sans specs : un mandat inévaluable n’a rien à faire en mémoire', () => {
    const path = tempPath()
    writeFileSync(path, `${JSON.stringify({ id: `0x${'11'.repeat(32)}` })}\n`)
    const store = fileWarrantStore({ path, onDefect: () => {} })
    expect(store.list()).toHaveLength(0)
  })
})
