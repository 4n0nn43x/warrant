# ═══════════════════════════════════════════════════════════════════════════
# FICHIER GÉNÉRÉ — NE PAS ÉDITER À LA MAIN.
#
# Source : packages/sdk-ts/src/tools.ts et schemas.ts, sérialisés par
#          packages/sdk-ts/src/manifest.ts.
# Régénérer : pnpm tsx packages/sdk-py/codegen/emit.ts
# Vérifier   : pnpm tsx packages/sdk-py/codegen/emit.ts --check
#
# Toute modification manuelle sera écrasée, et `tests/test_codegen_drift.py`
# échouera avant : c'est ce qui garantit que le Python ne peut pas diverger du
# TypeScript. Les descriptions ci-dessous sont recopiées verbatim depuis la
# source unique — les corriger ici les ferait mentir, pas les améliorer.
# ═══════════════════════════════════════════════════════════════════════════
"""Modèles et manifeste générés depuis la source unique TypeScript.

Rien ici n'est écrit à la main. Les modèles Pydantic portent `extra="ignore"`,
ce qui reproduit le nettoyage des clés inconnues fait par Zod : un champ
`category` ou `notional` glissé dans les arguments est **retiré** avant
l'appel, donc il n'atteint ni le Classifieur, ni l'`actionHash`.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

MANIFEST_VERSION = 1
JSON_SCHEMA_DIALECT = "draft-7"

#: sha256 de la forme canonique du manifeste. Identifie la révision de la source
#: unique dont ce fichier est issu ; publié par `warrant tools` et par la skill
#: OpenClaw pour qu'un artefact périmé se repère sans lire le code.
MANIFEST_SHA256 = "sha256:9423096deebe38d11100cea8c730030de4b89d517b43d69ce3a759c34c766a1b"


class ActionSpec(BaseModel):
    """La transaction à exécuter. N'accepte ni catégorie ni notionnel : les deux sont dérivés du calldata, jamais déclarés."""

    model_config = ConfigDict(extra="ignore")

    version: Literal[1]
    chainId: int = Field(gt=0, le=9007199254740991, description="Chain ID EVM de la transaction exécutée.")
    target: str = Field(pattern="^0x[0-9a-fA-F]{40}$", description="Contrat appelé.")
    value: str = Field(pattern="^(?:0|[1-9][0-9]*)$", description="Valeur native envoyée, en wei, en chaîne décimale.")
    calldata: str = Field(pattern="^0x(?:[0-9a-fA-F]{2})*$", description="Calldata exact de la transaction. C'est de lui — et de lui seul — que sont dérivés la catégorie, le notionnel et donc la caution.")
    registryRef: str = Field(pattern="^0x[0-9a-fA-F]{64}$", description="Hash de la version du registre de classification utilisée.")


class QuoteRiskInput(BaseModel):
    """Arguments of the `quote_risk` tool."""

    model_config = ConfigDict(extra="ignore")

    actionSpec: ActionSpec = Field(description="La transaction à exécuter. N'accepte ni catégorie ni notionnel : les deux sont dérivés du calldata, jamais déclarés.")
    beneficiary: str | None = Field(default=None, pattern="^0x[0-9a-fA-F]{40}$", description="Bénéficiaire d'une éventuelle saisie. N'influe pas sur le prix ; sert à construire la post-condition.")


class RequestWarrantInput(BaseModel):
    """Arguments of the `request_warrant` tool."""

    model_config = ConfigDict(extra="ignore")

    actionSpec: ActionSpec = Field(description="La transaction à exécuter. N'accepte ni catégorie ni notionnel : les deux sont dérivés du calldata, jamais déclarés.")
    beneficiary: str = Field(pattern="^0x[0-9a-fA-F]{40}$", description="Adresse qui reçoit la caution si la post-condition est violée — le propriétaire du capital, jamais l'agent.")


class GetWarrantInput(BaseModel):
    """Arguments of the `get_warrant` tool."""

    model_config = ConfigDict(extra="ignore")

    warrantId: str = Field(pattern="^0x[0-9a-fA-F]{64}$", description="Identifiant du mandat, tel que rendu par request_warrant.")


class ListWarrantsInput(BaseModel):
    """Arguments of the `list_warrants` tool."""

    model_config = ConfigDict(extra="ignore")

    agent: str = Field(pattern="^0x[0-9a-fA-F]{40}$", description="Wallet agentique dont on énumère les mandats.")
    status: Literal["open", "honored", "slashed", "reclaimed"] | None = Field(default=None, description="Ne garder que les mandats dans cet état.")
    category: Literal["erc20.transfer", "erc20.approve", "aavev3.repay", "aavev3.supply", "aavev3.withdraw", "aavev3.borrow", "unknown"] | None = Field(default=None, description="Filtre a posteriori sur la catégorie dérivée. Ne peut pas être déclarée à l'ouverture.")
    since: int | None = Field(default=None, ge=0, le=9007199254740991, description="Borne basse sur openedAt, en secondes Unix.")
    until: int | None = Field(default=None, ge=0, le=9007199254740991, description="Borne haute sur openedAt, en secondes Unix.")
    limit: int | None = Field(default=None, ge=1, le=100, description="Nombre maximal de mandats rendus (défaut 20).")
    cursor: str | None = Field(default=None, description="Curseur de pagination rendu par un appel précédent.")


#: Le catalogue d'erreurs, tel que `errors.ts` le pose. Un `hint` est lu par un
#: agent : le réécrire en Python ferait dire deux choses différentes au même code
#: selon le langage de l'adaptateur.
ERROR_CATALOG: dict[str, dict[str, str]] = {
    "invalid_input": {
        "hint": "Vérifie les champs de l'outil contre son inputSchema, puis rappelle-le.",
        "docs": "https://warrant.sh/docs/tools",
    },
    "invalid_action_spec": {
        "hint": "L'actionSpec doit porter version, chainId, target, value, calldata et registryRef. Aucune catégorie ni notionnel : ils sont dérivés du calldata.",
        "docs": "https://warrant.sh/docs/action-spec",
    },
    "invalid_condition_spec": {
        "hint": "Corrige le champ nommé dans `field` puis rouvre le mandat : une post-condition est immuable une fois engagée.",
        "docs": "https://warrant.sh/docs/post-conditions",
    },
    "classification_failed": {
        "hint": "Le couple (target, selector) est absent du registre. Appelle quote_risk d'abord : une action inconnue reste finançable, au tarif le plus strict.",
        "docs": "https://warrant.sh/docs/classification",
    },
    "payment_invalid": {
        "hint": "Reconstruis le PaymentPayload à partir du PaymentRequired renvoyé, sans modifier `accepted`, et rejoue avec _meta[\"x402/payment\"].",
        "docs": "https://warrant.sh/docs/payments#x402",
    },
    "warrant_not_found": {
        "hint": "Vérifie le warrantId (bytes32, 0x + 64 hex). list_warrants({ agent }) énumère les mandats connus.",
        "docs": "https://warrant.sh/docs/warrants#lookup",
    },
    "gateway_unreachable": {
        "hint": "Le Gateway Warrant est injoignable. Réessaie ; aucun mandat ni paiement n'a été engagé.",
        "docs": "https://warrant.sh/docs/troubleshooting#gateway",
    },
    "gateway_error": {
        "hint": "Réessaie ; si cela persiste, le détail est dans `details`.",
        "docs": "https://warrant.sh/docs/troubleshooting#gateway",
    },
}


#: Les quatre outils, dans l'ordre de la source : devis, mandat, lecture,
#: historique. `input_model` est le modèle Pydantic ci-dessus ; `input_schema`
#: est le JSON Schema draft-7 publié tel quel par `tools/list` côté MCP.
TOOL_MANIFEST: tuple[dict[str, Any], ...] = (
    {
        "name": "quote_risk",
        "title": "Quote the bond for an action",
        "description": "Estime la caution exigée pour une action, sans rien engager et sans paiement. Classe le calldata, en dérive le notionnel, puis rend la caution, le taux de risque et la post-condition qui sera engagée. Appelle-le avant request_warrant : c'est gratuit, et c'est le seul moyen de connaître le coût avant de s'engager. La catégorie et le notionnel sont dérivés du calldata ; ils ne peuvent pas être déclarés.",
        "paid": False,
        "read_only": True,
        "input_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "actionSpec": {
                    "type": "object",
                    "properties": {
                        "version": {
                            "type": "number",
                            "const": 1,
                        },
                        "chainId": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991,
                            "description": "Chain ID EVM de la transaction exécutée.",
                        },
                        "target": {
                            "type": "string",
                            "pattern": "^0x[0-9a-fA-F]{40}$",
                            "description": "Contrat appelé.",
                        },
                        "value": {
                            "type": "string",
                            "pattern": "^(?:0|[1-9][0-9]*)$",
                            "description": "Valeur native envoyée, en wei, en chaîne décimale.",
                        },
                        "calldata": {
                            "type": "string",
                            "pattern": "^0x(?:[0-9a-fA-F]{2})*$",
                            "description": "Calldata exact de la transaction. C'est de lui — et de lui seul — que sont dérivés la catégorie, le notionnel et donc la caution.",
                        },
                        "registryRef": {
                            "type": "string",
                            "pattern": "^0x[0-9a-fA-F]{64}$",
                            "description": "Hash de la version du registre de classification utilisée.",
                        },
                    },
                    "required": [
                        "version",
                        "chainId",
                        "target",
                        "value",
                        "calldata",
                        "registryRef",
                    ],
                    "description": "La transaction à exécuter. N'accepte ni catégorie ni notionnel : les deux sont dérivés du calldata, jamais déclarés.",
                },
                "beneficiary": {
                    "description": "Bénéficiaire d'une éventuelle saisie. N'influe pas sur le prix ; sert à construire la post-condition.",
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{40}$",
                },
            },
            "required": [
                "actionSpec",
            ],
        },
        "output_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "description": "Catégorie dérivée du calldata.",
                },
                "bond": {
                    "type": "string",
                    "description": "Caution exigée, en unités atomiques (USDC, 6 décimales).",
                },
                "riskBps": {
                    "type": "number",
                    "description": "Taux de risque appliqué, en points de base.",
                },
                "notionalUSD": {
                    "type": "string",
                    "description": "Notionnel dérivé des arguments décodés.",
                },
                "conditionSpec": {
                    "type": "object",
                    "propertyNames": {
                        "type": "string",
                    },
                    "additionalProperties": {},
                    "description": "Post-condition qui sera engagée sous conditionHash.",
                },
                "rationale": {
                    "type": "string",
                    "description": "Justification du prix, en une phrase.",
                },
            },
            "required": [
                "category",
                "bond",
                "riskBps",
                "notionalUSD",
                "conditionSpec",
                "rationale",
            ],
            "additionalProperties": False,
        },
        "input_model": QuoteRiskInput,
    },
    {
        "name": "request_warrant",
        "title": "Open a bonded warrant",
        "description": "Ouvre un mandat cautionné pour l'action donnée et la fait exécuter par KeeperHub. Payant : la caution doit être financée via x402 avant l'ouverture. Rend le warrantId, l'executionId et les engagements conditionHash / actionHash. Si la post-condition est tenue, la caution revient ; sinon elle va au beneficiary. La caution est dérivée du calldata — elle ne se négocie pas.",
        "paid": True,
        "read_only": False,
        "input_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "actionSpec": {
                    "type": "object",
                    "properties": {
                        "version": {
                            "type": "number",
                            "const": 1,
                        },
                        "chainId": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991,
                            "description": "Chain ID EVM de la transaction exécutée.",
                        },
                        "target": {
                            "type": "string",
                            "pattern": "^0x[0-9a-fA-F]{40}$",
                            "description": "Contrat appelé.",
                        },
                        "value": {
                            "type": "string",
                            "pattern": "^(?:0|[1-9][0-9]*)$",
                            "description": "Valeur native envoyée, en wei, en chaîne décimale.",
                        },
                        "calldata": {
                            "type": "string",
                            "pattern": "^0x(?:[0-9a-fA-F]{2})*$",
                            "description": "Calldata exact de la transaction. C'est de lui — et de lui seul — que sont dérivés la catégorie, le notionnel et donc la caution.",
                        },
                        "registryRef": {
                            "type": "string",
                            "pattern": "^0x[0-9a-fA-F]{64}$",
                            "description": "Hash de la version du registre de classification utilisée.",
                        },
                    },
                    "required": [
                        "version",
                        "chainId",
                        "target",
                        "value",
                        "calldata",
                        "registryRef",
                    ],
                    "description": "La transaction à exécuter. N'accepte ni catégorie ni notionnel : les deux sont dérivés du calldata, jamais déclarés.",
                },
                "beneficiary": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{40}$",
                    "description": "Adresse qui reçoit la caution si la post-condition est violée — le propriétaire du capital, jamais l'agent.",
                },
            },
            "required": [
                "actionSpec",
                "beneficiary",
            ],
        },
        "output_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "warrantId": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                },
                "executionId": {
                    "type": "string",
                    "description": "Identifiant KeeperHub de l'exécution.",
                },
                "conditionHash": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                    "description": "keccak256(JCS(conditionSpec)) — engagement immuable.",
                },
                "actionHash": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                    "description": "keccak256(JCS(actionSpec)) — engagement sur ce qui est demandé.",
                },
                "expiry": {
                    "type": "number",
                    "description": "Au-delà, honor/slash sont fermés et reclaim() est ouvert.",
                },
            },
            "required": [
                "warrantId",
                "executionId",
                "conditionHash",
                "actionHash",
                "expiry",
            ],
            "additionalProperties": False,
        },
        "input_model": RequestWarrantInput,
    },
    {
        "name": "get_warrant",
        "title": "Read a warrant and its verdict",
        "description": "Rend un mandat, son état et — s'il est réglé — le verdict complet avec le détail checks[] : une ligne par vérification, y compris celles qui passent, plus le bloc exact d'évaluation. C'est ce qui rend un verdict rejouable par un tiers plutôt que cru sur parole.",
        "paid": False,
        "read_only": True,
        "input_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "warrantId": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                    "description": "Identifiant du mandat, tel que rendu par request_warrant.",
                },
            },
            "required": [
                "warrantId",
            ],
        },
        "output_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "warrantId": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                },
                "agent": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{40}$",
                },
                "beneficiary": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{40}$",
                },
                "bond": {
                    "type": "string",
                },
                "conditionHash": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                },
                "actionHash": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{64}$",
                },
                "expiry": {
                    "type": "number",
                },
                "openedAt": {
                    "type": "number",
                },
                "status": {
                    "type": "number",
                    "description": "0 None, 1 Open, 2 Honored, 3 Slashed, 4 Reclaimed.",
                },
                "verdict": {
                    "description": "Présent une fois le mandat réglé.",
                    "type": "object",
                    "propertyNames": {
                        "type": "string",
                    },
                    "additionalProperties": {},
                },
                "checks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {
                                "type": "string",
                            },
                            "expected": {
                                "type": "string",
                            },
                            "observed": {
                                "type": "string",
                            },
                            "pass": {
                                "type": "boolean",
                            },
                        },
                        "required": [
                            "kind",
                            "expected",
                            "observed",
                            "pass",
                        ],
                        "additionalProperties": False,
                    },
                    "description": "Une ligne par vérification, y compris celles qui passent — un verdict partiel ne serait pas auditable.",
                },
            },
            "required": [
                "warrantId",
                "agent",
                "beneficiary",
                "bond",
                "conditionHash",
                "actionHash",
                "expiry",
                "openedAt",
                "status",
                "checks",
            ],
            "additionalProperties": False,
        },
        "input_model": GetWarrantInput,
    },
    {
        "name": "list_warrants",
        "title": "List an agent warrants and statistics",
        "description": "Énumère les mandats d'un agent avec leurs statistiques agrégées : nombre honoré, saisi, total cautionné, taux d'honneur. Filtrable par état, catégorie et fenêtre temporelle. Sert à répondre à « quel est le bilan de cet agent ? » sans lire la chaîne.",
        "paid": False,
        "read_only": True,
        "input_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "agent": {
                    "type": "string",
                    "pattern": "^0x[0-9a-fA-F]{40}$",
                    "description": "Wallet agentique dont on énumère les mandats.",
                },
                "status": {
                    "description": "Ne garder que les mandats dans cet état.",
                    "type": "string",
                    "enum": [
                        "open",
                        "honored",
                        "slashed",
                        "reclaimed",
                    ],
                },
                "category": {
                    "description": "Filtre a posteriori sur la catégorie dérivée. Ne peut pas être déclarée à l'ouverture.",
                    "type": "string",
                    "enum": [
                        "erc20.transfer",
                        "erc20.approve",
                        "aavev3.repay",
                        "aavev3.supply",
                        "aavev3.withdraw",
                        "aavev3.borrow",
                        "unknown",
                    ],
                },
                "since": {
                    "description": "Borne basse sur openedAt, en secondes Unix.",
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991,
                },
                "until": {
                    "description": "Borne haute sur openedAt, en secondes Unix.",
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991,
                },
                "limit": {
                    "description": "Nombre maximal de mandats rendus (défaut 20).",
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                },
                "cursor": {
                    "description": "Curseur de pagination rendu par un appel précédent.",
                    "type": "string",
                },
            },
            "required": [
                "agent",
            ],
        },
        "output_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {
                "warrants": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "propertyNames": {
                            "type": "string",
                        },
                        "additionalProperties": {},
                    },
                },
                "stats": {
                    "type": "object",
                    "properties": {
                        "total": {
                            "type": "number",
                        },
                        "open": {
                            "type": "number",
                        },
                        "honored": {
                            "type": "number",
                        },
                        "slashed": {
                            "type": "number",
                        },
                        "reclaimed": {
                            "type": "number",
                        },
                        "bondHonoredTotal": {
                            "type": "string",
                        },
                        "bondSlashedTotal": {
                            "type": "string",
                        },
                        "totalAtRisk": {
                            "type": "string",
                        },
                    },
                    "required": [
                        "total",
                        "open",
                        "honored",
                        "slashed",
                        "reclaimed",
                        "bondHonoredTotal",
                        "bondSlashedTotal",
                        "totalAtRisk",
                    ],
                    "additionalProperties": False,
                },
                "nextCursor": {
                    "type": "string",
                },
            },
            "required": [
                "warrants",
                "stats",
            ],
            "additionalProperties": False,
        },
        "input_model": ListWarrantsInput,
    },
)

TOOL_NAMES: tuple[str, ...] = tuple(spec["name"] for spec in TOOL_MANIFEST)

__all__ = [
    "ERROR_CATALOG",
    "JSON_SCHEMA_DIALECT",
    "MANIFEST_SHA256",
    "MANIFEST_VERSION",
    "TOOL_MANIFEST",
    "TOOL_NAMES",
    "ActionSpec",
    "QuoteRiskInput",
    "RequestWarrantInput",
    "GetWarrantInput",
    "ListWarrantsInput",
]
