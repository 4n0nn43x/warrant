/**
 * Tests for `bin/register-agent.ts`.
 *
 * What is exercised here is exactly what cannot be exercised by running the
 * tool: resolving the table's path — on which whether the Settler reads it or not
 * depends —, the refusal of the chains on which an identity would be minted for
 * nothing, and reading the `agentId` out of a receipt. The rest of `main()` is a
 * chain of network calls; mocking it would only exercise the mock.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from '@warrant/core'
import { encodeAbiParameters, encodeEventTopics } from 'viem'
import {
  AGENT_IDS_BASENAME,
  agentIdFromLogs,
  agentIdsFilePath,
  decideChain,
  defaultAgentUri,
  envLineFor,
  readAgentIds,
  upsertAgentId,
  writeAgentIds,
} from './register-agent.js'
import { identityRegistryAbi } from '../reputation.js'

const AGENT = '0xe9d3d40a1e80f1c20a318edfc70869d61f971567' as Address
const IDENTITY = '0x8004a818bfb912233c491871b3d84c89a494bd9e' as Address

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'warrant-agent-ids-'))
}

// ─────────────────────────────────────────────────────────────────────────────
// Where the table lives
// ─────────────────────────────────────────────────────────────────────────────

describe('agentIdsFilePath', () => {
  it('honors ERC8004_AGENT_IDS_FILE, the variable the Settler reads', () => {
    const loc = agentIdsFilePath({ ERC8004_AGENT_IDS_FILE: '/srv/warrant/ids.json' }, '/cwd')
    expect(loc).toEqual({ path: '/srv/warrant/ids.json', source: 'ERC8004_AGENT_IDS_FILE' })
  })

  it('resolves a relative path against the current directory', () => {
    const loc = agentIdsFilePath({ ERC8004_AGENT_IDS_FILE: 'ids.json' }, '/cwd')
    expect(loc.path).toBe('/cwd/ids.json')
  })

  it('puts the table next to the ledger when the variable is absent', () => {
    // The Gateway writes the ledger, the Settler reads it: the table must live in
    // the same place, otherwise it resolves to two directories depending on the
    // process.
    const loc = agentIdsFilePath({ WARRANT_JOURNAL_FILE: '/repo/.warrant/warrants.jsonl' }, '/cwd')
    expect(loc).toEqual({
      path: `/repo/.warrant/${AGENT_IDS_BASENAME}`,
      source: 'WARRANT_JOURNAL_FILE',
    })
  })

  it('ignores an empty variable rather than resolving the current directory', () => {
    const loc = agentIdsFilePath(
      { ERC8004_AGENT_IDS_FILE: '   ', WARRANT_JOURNAL_FILE: '/repo/.warrant/warrants.jsonl' },
      '/cwd',
    )
    expect(loc.source).toBe('WARRANT_JOURNAL_FILE')
  })

  it('falls back to .warrant/ of the current directory, in absolute form', () => {
    const loc = agentIdsFilePath({}, '/cwd')
    expect(loc).toEqual({ path: `/cwd/.warrant/${AGENT_IDS_BASENAME}`, source: 'default' })
  })

  it('returns the exact .env line, with no quotes and no space', () => {
    expect(envLineFor('/repo/.warrant/agent-ids.json')).toBe(
      'ERC8004_AGENT_IDS_FILE=/repo/.warrant/agent-ids.json',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Reading and writing the table
// ─────────────────────────────────────────────────────────────────────────────

describe('identity table', () => {
  it('a missing file is an empty table, not an error', () => {
    expect(readAgentIds(join(tempDir(), 'never-written.json'))).toEqual({})
  })

  it('normalizes keys to lowercase and values to decimal', () => {
    const path = join(tempDir(), AGENT_IDS_BASENAME)
    writeFileSync(
      path,
      JSON.stringify({ '0xE9D3D40A1E80F1C20A318EDFC70869D61F971567': 8986 }),
      'utf8',
    )
    expect(readAgentIds(path)).toEqual({ [AGENT]: '8986' })
  })

  it('throws on a value that is not an integer — the Settler would otherwise throw at startup', () => {
    const path = join(tempDir(), AGENT_IDS_BASENAME)
    writeFileSync(path, JSON.stringify({ [AGENT]: 'not-an-integer' }), 'utf8')
    expect(() => readAgentIds(path)).toThrow()
  })

  it("replaces the agent's entry without touching the others", () => {
    const other = '0x00000000000000000000000000000000000000a1'
    const table = { [AGENT]: '8986', [other]: '42' }
    expect(upsertAgentId(table, AGENT, 8651n)).toEqual({ [AGENT]: '8651', [other]: '42' })
    // The input table is not mutated: `main()` still uses it to log the replaced
    // value.
    expect(table[AGENT]).toBe('8986')
  })

  it('writes re-readable JSON, indented and ending in a newline', () => {
    const path = join(tempDir(), 'subdirectory', AGENT_IDS_BASENAME)
    writeAgentIds(path, { [AGENT]: '8651' })
    const bytes = readFileSync(path, 'utf8')
    expect(bytes.endsWith('\n')).toBe(true)
    expect(bytes).toContain('\n  "')
    expect(readAgentIds(path)).toEqual({ [AGENT]: '8651' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The minted `agentId`
// ─────────────────────────────────────────────────────────────────────────────

function registeredLog(agentId: bigint, owner: Address, address = IDENTITY) {
  return {
    address,
    topics: encodeEventTopics({
      abi: identityRegistryAbi,
      eventName: 'Registered',
      args: { agentId, owner },
    }),
    data: encodeAbiParameters([{ type: 'string' }], ['https://agent.example/card.json']),
  }
}

describe('agentIdFromLogs', () => {
  it('reads the agentId from the Registered event', () => {
    expect(agentIdFromLogs([registeredLog(8651n, AGENT)], IDENTITY)).toBe(8651n)
  })

  it("ignores another contract's logs", () => {
    const foreign = '0x00000000000000000000000000000000000000ff' as Address
    expect(() => agentIdFromLogs([registeredLog(1n, AGENT, foreign)], IDENTITY)).toThrow(
      /no Registered event/,
    )
  })

  it('ignores logs that are not a Registered — the registry is an ERC-721', () => {
    const transferish = {
      address: IDENTITY,
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex],
      data: '0x' as Hex,
    }
    expect(agentIdFromLogs([transferish, registeredLog(8651n, AGENT)], IDENTITY)).toBe(8651n)
  })

  it('throws rather than guess when nothing was minted', () => {
    expect(() => agentIdFromLogs([], IDENTITY)).toThrow(/no Registered event/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The chain
// ─────────────────────────────────────────────────────────────────────────────

describe('decideChain', () => {
  it('accepts Base Sepolia when escrow and ERC-8004 are on the same chain', () => {
    const d = decideChain({ WARRANT_ESCROW_CHAIN_ID: '84532', ERC8004_CHAIN_ID: '84532' })
    expect(d).toEqual({ escrowChainId: 84532, erc8004ChainId: 84532 })
  })

  it("follows the escrow's chain when ERC8004_CHAIN_ID is absent", () => {
    const d = decideChain({ WARRANT_ESCROW_CHAIN_ID: '84532' })
    expect(d.erc8004ChainId).toBe(84532)
    expect(d.refusal).toBeUndefined()
  })

  it("refuses a chain different from the escrow's — the case of agentId 8986", () => {
    const d = decideChain({ WARRANT_ESCROW_CHAIN_ID: '84532', ERC8004_CHAIN_ID: '11155111' })
    expect(d.refusal).toMatch(/escrow chain 84532/)
  })

  it('refuses a mainnet without explicit authorization', () => {
    const d = decideChain({ WARRANT_ESCROW_CHAIN_ID: '8453', ERC8004_CHAIN_ID: '8453' })
    expect(d.refusal).toMatch(/ERC8004_ALLOW_MAINNET/)
  })

  it('accepts a mainnet when it is explicitly authorized', () => {
    expect(
      decideChain({
        WARRANT_ESCROW_CHAIN_ID: '8453',
        ERC8004_CHAIN_ID: '8453',
        ERC8004_ALLOW_MAINNET: '1',
      }).refusal,
    ).toBeUndefined()
    expect(
      decideChain({ WARRANT_ESCROW_CHAIN_ID: '8453', ERC8004_CHAIN_ID: '8453' }, [
        '--allow-mainnet',
      ]).refusal,
    ).toBeUndefined()
  })

  it('refuses a chain absent from the table rather than letting viem guess an RPC', () => {
    const d = decideChain({ WARRANT_ESCROW_CHAIN_ID: '31337', ERC8004_CHAIN_ID: '31337' })
    expect(d.refusal).toMatch(/unknown to the CHAINS table/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The agent card's URI
// ─────────────────────────────────────────────────────────────────────────────

describe('defaultAgentUri', () => {
  it('derives the URI from the public base the project already announces', () => {
    expect(defaultAgentUri(AGENT, 'https://warrant.sh/v/')).toBe(
      `https://warrant.sh/agents/${AGENT}.json`,
    )
  })

  it('tolerates a base with no /v and no trailing slash', () => {
    expect(defaultAgentUri(AGENT, 'http://localhost:8403')).toBe(
      `http://localhost:8403/agents/${AGENT}.json`,
    )
  })

  it("does not depend on the address's case", () => {
    expect(defaultAgentUri('0xE9D3D40A1E80F1C20A318EDFC70869D61F971567' as Address, 'https://x/v/')).toBe(
      `https://x/agents/${AGENT}.json`,
    )
  })
})
