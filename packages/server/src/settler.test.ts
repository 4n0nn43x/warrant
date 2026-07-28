import { describe, expect, it } from 'vitest'
import type { Hex } from '@warrant/core'
import { RpcReadError } from './checks/errors.js'
import type { Execution } from './keeperhub.js'
import {
  SETTLEMENT_MARGIN_SECONDS,
  decide,
  execRef,
  summarizeFailures,
} from './settler.js'

const WARRANT_ID = `0x${'11'.repeat(32)}` as Hex
const TX_HASH = `0x${'22'.repeat(32)}` as Hex

const NOW = 1_785_000_000
const FAR_EXPIRY = NOW + 3600

function execution(over: Partial<Execution> = {}): Execution {
  return {
    executionId: 'exec_abc',
    status: 'success',
    txHash: TX_HASH,
    raw: {},
    ...over,
  }
}

const publicClient = {
  waitForTransactionReceipt: async () => ({ blockNumber: 1234n }) as never,
}

const failingClient = {
  waitForTransactionReceipt: async () => {
    throw new Error('timeout en attente de confirmations')
  },
}

function evaluateTo(verdict: 'honored' | 'slashed', checks = passingChecks()) {
  return async () => ({
    verdict,
    evaluatedAtBlock: '1234',
    checks,
    rpcUrl: 'https://rpc.example',
  })
}

function passingChecks() {
  return [
    { kind: 'erc20_balance', expected: '>=1000', observed: '2000', pass: true },
  ]
}

function failingChecks() {
  return [
    { kind: 'erc20_balance', expected: '>=1000', observed: '0', pass: false },
    {
      kind: 'erc20_balance_delta',
      expected: '>=-500',
      observed: '-9000',
      pass: false,
    },
    { kind: 'no_new_approvals', expected: 'aucune', observed: 'aucune', pass: true },
  ]
}

const base = {
  warrantId: WARRANT_ID,
  expiry: FAR_EXPIRY,
  confirmations: 12,
  publicClient,
  now: () => NOW,
}

describe('decide — une transaction qui échoue n’est pas une post-condition violée', () => {
  it('laisse expirer quand KeeperHub rapporte un échec d’exécution', async () => {
    const d = await decide({
      ...base,
      execution: execution({ status: 'failed', outcome: 'reverted' }),
      evaluate: evaluateTo('slashed', failingChecks()),
    })
    expect(d.action.kind).toBe('let-expire')
    expect(d.evaluation).toBeUndefined()
  })

  it('laisse expirer quand l’exécution n’est pas terminée', async () => {
    const d = await decide({
      ...base,
      execution: execution({ status: 'running' }),
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('let-expire')
  })

  it('laisse expirer quand l’audit trail ne rapporte aucun txHash', async () => {
    const d = await decide({
      ...base,
      execution: { executionId: 'exec_abc', status: 'success', raw: {} },
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('let-expire')
    if (d.action.kind === 'let-expire') {
      expect(d.action.reason).toMatch(/txHash/)
    }
  })

  it('laisse expirer quand les confirmations ne viennent pas', async () => {
    const d = await decide({
      ...base,
      publicClient: failingClient,
      execution: execution(),
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('let-expire')
  })
})

describe('decide — le doute bénéficie à l’agent', () => {
  it('une erreur de lecture RPC ne produit JAMAIS de slash', async () => {
    const d = await decide({
      ...base,
      execution: execution(),
      evaluate: async () => {
        throw new RpcReadError('noeud injoignable')
      },
    })
    expect(d.action.kind).toBe('let-expire')
    expect(d.action.kind).not.toBe('slash')
  })

  it('une erreur non-RPC remonte au lieu d’être avalée', async () => {
    await expect(
      decide({
        ...base,
        execution: execution(),
        evaluate: async () => {
          throw new TypeError('bug de programmation')
        },
      }),
    ).rejects.toBeInstanceOf(TypeError)
  })
})

describe('decide — verdicts', () => {
  it('post-condition tenue → honor, avec execRef', async () => {
    const d = await decide({
      ...base,
      execution: execution(),
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('honor')
    if (d.action.kind === 'honor') {
      expect(d.action.execRef).toBe(execRef('exec_abc', TX_HASH))
    }
    expect(d.evaluation?.checks).toHaveLength(1)
  })

  it('post-condition violée → slash, avec les checks échoués en raison', async () => {
    const d = await decide({
      ...base,
      execution: execution(),
      evaluate: evaluateTo('slashed', failingChecks()),
    })
    expect(d.action.kind).toBe('slash')
    if (d.action.kind === 'slash') {
      expect(d.action.reason).toContain('erc20_balance')
      expect(d.action.reason).toContain('erc20_balance_delta')
      // Les checks passés ne polluent pas la raison.
      expect(d.action.reason).not.toContain('no_new_approvals')
    }
  })

  it('publie checks[] intégralement, y compris les vérifications passées', async () => {
    const d = await decide({
      ...base,
      execution: execution(),
      evaluate: evaluateTo('slashed', failingChecks()),
    })
    expect(d.evaluation?.checks).toHaveLength(3)
    expect(d.evaluation?.checks.filter((c) => c.pass)).toHaveLength(1)
  })
})

describe('decide — fenêtre de règlement (invariant I9)', () => {
  it('s’abstient quand l’expiration est trop proche, même sur un verdict slashed', async () => {
    const d = await decide({
      ...base,
      expiry: NOW + SETTLEMENT_MARGIN_SECONDS - 1,
      execution: execution(),
      evaluate: evaluateTo('slashed', failingChecks()),
    })
    expect(d.action.kind).toBe('let-expire')
    // L'évaluation est tout de même publiée : le verdict reste auditable.
    expect(d.evaluation?.verdict).toBe('slashed')
  })

  it('s’abstient aussi sur un verdict honored trop tardif', async () => {
    const d = await decide({
      ...base,
      expiry: NOW + 1,
      execution: execution(),
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('let-expire')
  })

  it('règle normalement juste au-dessus de la marge', async () => {
    const d = await decide({
      ...base,
      expiry: NOW + SETTLEMENT_MARGIN_SECONDS + 1,
      execution: execution(),
      evaluate: evaluateTo('honored'),
    })
    expect(d.action.kind).toBe('honor')
  })
})

describe('execRef', () => {
  it('est déterministe', () => {
    expect(execRef('exec_abc', TX_HASH)).toBe(execRef('exec_abc', TX_HASH))
  })

  it('sépare deux exécutions différentes sur la même transaction', () => {
    expect(execRef('exec_a', TX_HASH)).not.toBe(execRef('exec_b', TX_HASH))
  })

  it('sépare deux transactions différentes sur la même exécution', () => {
    const other = `0x${'33'.repeat(32)}` as Hex
    expect(execRef('exec_a', TX_HASH)).not.toBe(execRef('exec_a', other))
  })
})

describe('summarizeFailures', () => {
  it('ne liste que les échecs', () => {
    expect(summarizeFailures(failingChecks())).not.toContain('no_new_approvals')
  })

  it('borne la longueur pour tenir dans un event', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      kind: `check_${i}`,
      expected: 'x'.repeat(50),
      observed: 'y'.repeat(50),
      pass: false,
    }))
    expect(summarizeFailures(many).length).toBeLessThanOrEqual(400)
  })

  it('reste explicite quand rien n’a échoué', () => {
    expect(summarizeFailures(passingChecks())).toMatch(/aucune/)
  })
})
