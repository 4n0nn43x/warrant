/**
 * Tests de `bin/register-agent.ts`.
 *
 * Ce qui est éprouvé ici, c'est exactement ce qui ne peut pas l'être en
 * exécutant l'outil : la résolution du chemin de la table — dont dépend le fait
 * que le Settler la lise ou non —, le refus des chaînes sur lesquelles une
 * identité serait frappée pour rien, et la lecture de l'`agentId` dans un reçu.
 * Le reste de `main()` est un enchaînement d'appels réseau ; le mocker
 * n'éprouverait que le mock.
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
// Où vit la table
// ─────────────────────────────────────────────────────────────────────────────

describe('agentIdsFilePath', () => {
  it('respecte ERC8004_AGENT_IDS_FILE, la variable que lit le Settler', () => {
    const loc = agentIdsFilePath({ ERC8004_AGENT_IDS_FILE: '/srv/warrant/ids.json' }, '/cwd')
    expect(loc).toEqual({ path: '/srv/warrant/ids.json', source: 'ERC8004_AGENT_IDS_FILE' })
  })

  it('résout un chemin relatif contre le répertoire courant', () => {
    const loc = agentIdsFilePath({ ERC8004_AGENT_IDS_FILE: 'ids.json' }, '/cwd')
    expect(loc.path).toBe('/cwd/ids.json')
  })

  it('range la table à côté du journal quand la variable est absente', () => {
    // Le Gateway écrit le journal, le Settler le lit : la table doit vivre au même
    // endroit, sinon elle se résout à deux répertoires selon le process.
    const loc = agentIdsFilePath({ WARRANT_JOURNAL_FILE: '/repo/.warrant/warrants.jsonl' }, '/cwd')
    expect(loc).toEqual({
      path: `/repo/.warrant/${AGENT_IDS_BASENAME}`,
      source: 'WARRANT_JOURNAL_FILE',
    })
  })

  it('ignore une variable vide plutôt que de résoudre le répertoire courant', () => {
    const loc = agentIdsFilePath(
      { ERC8004_AGENT_IDS_FILE: '   ', WARRANT_JOURNAL_FILE: '/repo/.warrant/warrants.jsonl' },
      '/cwd',
    )
    expect(loc.source).toBe('WARRANT_JOURNAL_FILE')
  })

  it('retombe sur .warrant/ du répertoire courant, en absolu', () => {
    const loc = agentIdsFilePath({}, '/cwd')
    expect(loc).toEqual({ path: `/cwd/.warrant/${AGENT_IDS_BASENAME}`, source: 'default' })
  })

  it('rend la ligne .env exacte, sans guillemets ni espace', () => {
    expect(envLineFor('/repo/.warrant/agent-ids.json')).toBe(
      'ERC8004_AGENT_IDS_FILE=/repo/.warrant/agent-ids.json',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Lecture et écriture de la table
// ─────────────────────────────────────────────────────────────────────────────

describe('table des identités', () => {
  it('un fichier absent est une table vide, pas une erreur', () => {
    expect(readAgentIds(join(tempDir(), 'jamais-écrit.json'))).toEqual({})
  })

  it('normalise les clés en minuscules et les valeurs en décimal', () => {
    const path = join(tempDir(), AGENT_IDS_BASENAME)
    writeFileSync(
      path,
      JSON.stringify({ '0xE9D3D40A1E80F1C20A318EDFC70869D61F971567': 8986 }),
      'utf8',
    )
    expect(readAgentIds(path)).toEqual({ [AGENT]: '8986' })
  })

  it('lève sur une valeur qui n’est pas un entier — le Settler lèverait sinon au démarrage', () => {
    const path = join(tempDir(), AGENT_IDS_BASENAME)
    writeFileSync(path, JSON.stringify({ [AGENT]: 'pas-un-entier' }), 'utf8')
    expect(() => readAgentIds(path)).toThrow()
  })

  it('remplace l’entrée de l’agent sans toucher aux autres', () => {
    const other = '0x00000000000000000000000000000000000000a1'
    const table = { [AGENT]: '8986', [other]: '42' }
    expect(upsertAgentId(table, AGENT, 8651n)).toEqual({ [AGENT]: '8651', [other]: '42' })
    // La table d'entrée n'est pas mutée : `main()` s'en sert encore pour
    // journaliser la valeur remplacée.
    expect(table[AGENT]).toBe('8986')
  })

  it('écrit un JSON relisible, indenté et terminé par un retour', () => {
    const path = join(tempDir(), 'sous-dossier', AGENT_IDS_BASENAME)
    writeAgentIds(path, { [AGENT]: '8651' })
    const bytes = readFileSync(path, 'utf8')
    expect(bytes.endsWith('\n')).toBe(true)
    expect(bytes).toContain('\n  "')
    expect(readAgentIds(path)).toEqual({ [AGENT]: '8651' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'`agentId` frappé
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
  it('lit l’agentId de l’event Registered', () => {
    expect(agentIdFromLogs([registeredLog(8651n, AGENT)], IDENTITY)).toBe(8651n)
  })

  it('ignore les logs d’un autre contrat', () => {
    const foreign = '0x00000000000000000000000000000000000000ff' as Address
    expect(() => agentIdFromLogs([registeredLog(1n, AGENT, foreign)], IDENTITY)).toThrow(
      /aucun event Registered/,
    )
  })

  it('ignore les logs qui ne sont pas un Registered — le registre est un ERC-721', () => {
    const transferish = {
      address: IDENTITY,
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex],
      data: '0x' as Hex,
    }
    expect(agentIdFromLogs([transferish, registeredLog(8651n, AGENT)], IDENTITY)).toBe(8651n)
  })

  it('lève plutôt que de deviner quand rien n’a été frappé', () => {
    expect(() => agentIdFromLogs([], IDENTITY)).toThrow(/aucun event Registered/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La chaîne
// ─────────────────────────────────────────────────────────────────────────────

describe('decideChain', () => {
  it('accepte Base Sepolia quand escrow et ERC-8004 sont sur la même chaîne', () => {
    const d = decideChain({ WARRANT_ESCROW_CHAIN_ID: '84532', ERC8004_CHAIN_ID: '84532' })
    expect(d).toEqual({ escrowChainId: 84532, erc8004ChainId: 84532 })
  })

  it('suit la chaîne de l’escrow quand ERC8004_CHAIN_ID est absente', () => {
    const d = decideChain({ WARRANT_ESCROW_CHAIN_ID: '84532' })
    expect(d.erc8004ChainId).toBe(84532)
    expect(d.refusal).toBeUndefined()
  })

  it('refuse une chaîne différente de celle de l’escrow — le cas de l’agentId 8986', () => {
    const d = decideChain({ WARRANT_ESCROW_CHAIN_ID: '84532', ERC8004_CHAIN_ID: '11155111' })
    expect(d.refusal).toMatch(/chaîne de l'escrow 84532/)
  })

  it('refuse un mainnet sans autorisation explicite', () => {
    const d = decideChain({ WARRANT_ESCROW_CHAIN_ID: '8453', ERC8004_CHAIN_ID: '8453' })
    expect(d.refusal).toMatch(/ERC8004_ALLOW_MAINNET/)
  })

  it('accepte un mainnet quand il est explicitement autorisé', () => {
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

  it('refuse une chaîne absente de la table plutôt que de laisser viem deviner un RPC', () => {
    const d = decideChain({ WARRANT_ESCROW_CHAIN_ID: '31337', ERC8004_CHAIN_ID: '31337' })
    expect(d.refusal).toMatch(/inconnue de la table CHAINS/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'URI de la carte d'agent
// ─────────────────────────────────────────────────────────────────────────────

describe('defaultAgentUri', () => {
  it('dérive l’URI de la base publique déjà annoncée par le projet', () => {
    expect(defaultAgentUri(AGENT, 'https://warrant.sh/v/')).toBe(
      `https://warrant.sh/agents/${AGENT}.json`,
    )
  })

  it('tolère une base sans /v et sans barre finale', () => {
    expect(defaultAgentUri(AGENT, 'http://localhost:8403')).toBe(
      `http://localhost:8403/agents/${AGENT}.json`,
    )
  })

  it('ne dépend pas de la casse de l’adresse', () => {
    expect(defaultAgentUri('0xE9D3D40A1E80F1C20A318EDFC70869D61F971567' as Address, 'https://x/v/')).toBe(
      `https://x/agents/${AGENT}.json`,
    )
  })
})
