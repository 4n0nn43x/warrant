# Recon — WarrantEscrow

**Commit audité** : `6194b68529d8c73b64a47ee98247bc2640887621`
**Date** : 2026-07-29

## Plateforme

**Aucune.** Ce n'est pas un contest : c'est le contrat du projet lui-même, jamais
audité par un tiers. Conséquence méthodologique : on pondère par
`historic-exploits.md` (perte réelle) et non par la fréquence en contest. Le
contrôle d'accès et la réentrance, qui arrivent en bas des classements de
contest parce que tout le monde les grep en premier, remontent en tête ici :
personne ne les a encore cherchés sur ce code.

## Périmètre

`contracts/src/WarrantEscrow.sol` — 226 lignes. Un seul contrat, pas de proxy,
pas de bibliothèque propre, pas d'héritage hors OpenZeppelin (`IERC20`,
`SafeERC20`).

## Outils déterministes

- **Slither** : 17 résultats, tous du bruit `pragma` sur les dépendances
  OpenZeppelin, sauf un — `owner should be immutable`. C'est exact, et cela dit
  quelque chose : **il n'existe aucun transfert de propriété**.
- **Couverture** : **100 %** lignes, instructions, branches et fonctions. Aucun
  chemin non testé à exploiter comme piste. Ce qui reste est de la logique de
  protocole, que la couverture ne voit pas.
- 65 tests Foundry, dont 11 invariants en fuzzing stateful.

## Invariants déclarés — les assertions à attaquer

Source : `docs/06-contrat-escrow.md` § 3.

| # | Énoncé |
|---|---|
| I1 | `token.balanceOf(this) >= totalLocked` à tout instant |
| I2 | Un mandat quitte `Open` exactement une fois |
| I3 | Depuis `Open`, seuls `Honored`, `Slashed`, `Reclaimed` sont atteignables |
| I4 | `conditionHash` et `actionHash` immuables après `open` |
| I5 | Après `expiry`, `reclaim` réussit **toujours** pour un mandat `Open` |
| I6 | `slash` ne prélève **aucun** frais |
| I7 | `feeBps <= MAX_FEE_BPS` en permanence |
| I8 | `honor(id)` transfère exactement `bond − bond·feeBps/10000` à `agent` |
| I9 | `honor` et `slash` révertent dès que `block.timestamp > expiry` |
| I10 | Seul l'`opener` peut `open`, seul le `settler` peut `honor`/`slash`, et **les deux rôles sont distincts** |

I6 et I9 sont mis en avant devant le jury : les casser coûte double.

## Acteurs et confiance

| Rôle | Peut appeler | Confiance accordée |
|---|---|---|
| `owner` | `setOpener`, `setSettler`, `setFeeBps` | ne pas se réattribuer les rôles. Aucun transfert de propriété, aucune renonciation |
| `opener` | `open` | fournir des paramètres fidèles au mandat payé. En production : le wallet de l'organisation **KeeperHub**, donc un tiers |
| `settler` | `honor`, `slash` | juger honnêtement — seul privilège qui envoie des fonds à un tiers |
| `agent` | rien | destinataire de `honor` et `reclaim` |
| `beneficiary` | rien | destinataire de `slash` |
| `treasury` | rien | destinataire des frais, immuable |
| n'importe qui | `reclaim` | sans permission, par conception |

## Flux de valeur — la surface principale

**Les fonds entrent par un transfert ERC20 nu.** Aucune fonction de dépôt : le
règlement x402 transfère l'USDC directement au contrat, puis l'`opener` appelle
`open`. Le contrat ne vérifie jamais *qui a financé quoi*, seulement un agrégat :

```solidity
totalLocked += bond;
if (token.balanceOf(address(this)) < totalLocked) revert Underfunded();
```

Aucune comptabilité par mandat — choix assumé (« l'USDC est fongible »). C'est là
qu'il faut chercher.

| Sortie | Vers | Montant | Frais |
|---|---|---|---|
| `honor` | `treasury` puis `agent` | `fee`, puis `bond - fee` | oui |
| `slash` | `beneficiary` | `bond` intégral | **non** (I6) |
| `reclaim` | `agent` | `bond` intégral | non |

**Aucune fonction de balayage.** Tout USDC au-delà de `totalLocked` est
irrécupérable par construction.

## Points d'entrée modifiant l'état

| Fonction | Accès | Note |
|---|---|---|
| `open` | `opener` | 8 paramètres, **aucun contrôle d'adresse nulle** |
| `honor` | `settler` | fenêtre fermée après `expiry` |
| `slash` | `settler` | idem, plus une `string reason` non bornée |
| `reclaim` | **aucun** | seulement après `expiry` |
| `setOpener` / `setSettler` | `onlyOwner` | |
| `setFeeBps` | `onlyOwner` | plafonné à `MAX_FEE_BPS` |

## Classes retenues

`protocol-invariants` (dix invariants écrits — c'est le cœur), `access-control`
(trois rôles, I10), `token-integration` (financement nu, pas de balayage),
`dos-griefing` (I5 et I9 sont des propriétés de disponibilité),
`withdrawals-redemptions` (`reclaim` sans permission), `fees` (I6/I7/I8 et le
*moment* où `feeBps` est lu), `reentrancy`, `math-casting`.

Écartées : AMM, parts, oracle, prêt, gouvernance, récompenses, NFT, cross-chain,
upgradeabilité (pas de proxy), signatures (aucune dans ce contrat), Solana.
