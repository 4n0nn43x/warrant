# 02 — L'`opener` seul dispose d'une autorité de retrait, sans le settler ni l'owner

**Sévérité : Haute.**
**Fichier :** `contracts/src/WarrantEscrow.sol`
**Commit :** `6194b68529d8c73b64a47ee98247bc2640887621`

Trouvée indépendamment par deux chasseurs, puis soumise à un réfuteur chargé de
la détruire par la lentille « atteignabilité et modèle de confiance ». **Elle a
survécu**, avec trois corrections que ce rapport intègre.

## Résumé

`open()` laisse l'`opener` nommer librement l'`agent` et le `beneficiary`, sans
aucun lien vérifié avec qui a réellement payé. Or ces deux champs sont les
destinataires des **trois** sorties de fonds du contrat. L'`opener` peut donc
s'attribuer tout solde libre, seul, sans le `settler`, sans l'`owner`, sans
capital.

En production, l'`opener` est le wallet de l'organisation **KeeperHub** — un
tiers, que `docs/transactions.md` § 3 décrit comme *organization-scoped, not
per-user*, donc partagé.

## Les lignes défectueuses

```solidity
function open(
    bytes32 id,
    address agent,          // ← jamais validé, jamais relié au payeur
    address beneficiary,    // ← jamais validé
    uint256 bond,
    bytes32 conditionHash,
    bytes32 actionHash,
    bytes32 fundingRef,     // ← stocké, émis, JAMAIS RELU par aucune fonction
    uint64 duration
) external {
    if (msg.sender != opener) revert NotOpener();
    ...
    totalLocked += bond;
    if (token.balanceOf(address(this)) < totalLocked) revert Underfunded();
```

`fundingRef` est documenté comme « la trace d'audit reliant la caution au
mandat ». C'est un `bytes32` opaque qu'aucune ligne du contrat ne lit, ne
contraint, ni n'oblige à être unique. Le contrôle de financement est **purement
agrégé** : il est satisfait par l'argent de n'importe qui.

```solidity
function reclaim(bytes32 id) external {
    // volontairement sans permission
    ...
    token.safeTransfer(w.agent, amount);   // ← `agent` choisi par l'opener
}
```

## Séquence d'attaque

Attaquant : porteur de la clé `opener`. Aucune collusion, aucun capital.

1. Un client règle en x402. Le règlement transfère l'USDC **au contrat**
   (`WARRANT_PAY_TO` est l'adresse de l'escrow, imposé par le contrôle
   `balanceOf(this) >= totalLocked`). `totalLocked` vaut encore 0.
2. `opener → open(id, agent=voleur, beneficiary=voleur, bond=<montant déposé>,
   duration=MIN_DURATION)`. Tous les contrôles passent.
3. Le `settler` ne fait rien : aucune exécution KeeperHub ne correspond à ce
   mandat, il n'a rien à juger.
4. `t + 901 s` : **n'importe qui** appelle `reclaim(id)` — le voleur lui-même
   fera l'affaire. `bond` intégral, **sans frais**.

En prime : l'ouverture légitime que ce paiement finançait révèle ensuite
`Underfunded()`. La victime a payé, n'a pas de mandat, et n'a aucun recours — il
n'existe ni sweep, ni remboursement, ni annulation.

## Impact

| | |
|---|---|
| Borne exacte | `balanceOf(escrow) − totalLocked` **à l'instant du `open`** |
| Cautions déjà verrouillées | **protégées** — I1 tient, une unité de plus révèle `Underfunded` |
| En régime permanent | chaque règlement x402 transite par le solde libre avant son `open` : **100 % de chaque paiement entrant**, indéfiniment, jusqu'à rotation de l'`opener` |
| Reçu par la trésorerie | 0 |
| Capital requis | 0 |
| Latence | 901 secondes |

## Ce que le réfuteur a corrigé

**1. « I9 verrouille le vol » est faux.** Le settler *peut* saisir avant
expiration. Ce qui rend la défense inopérante est plus simple et plus grave :
`slash` paie `w.beneficiary`, `honor` et `reclaim` paient `w.agent` — **les trois
sorties paient une adresse choisie par l'opener**. Il n'existe aucun chemin
défensif. Même `setOpener` révoqué, le mandat déjà ouvert part quand même.

**2. « Vide le contrat » était imprécis.** La borne est le solde libre, pas
`totalLocked`. La formulation en régime permanent, elle, reste exacte.

**3. Pas de chemin plus court.** Le voleur ne tient que l'`opener` ; il doit
attendre `MIN_DURATION`. Ces 15 minutes sont un plancher, pas une fenêtre de
défense — voir ci-dessous.

## Pourquoi personne ne verrait passer l'anomalie

`packages/server/src/daemon.ts` traite un mandat onchain absent du journal en
`{kind: 'deferred', reason: "aucune spec au journal…"}`. Aucun chemin ne mène à
`slash`. Et l'opérateur ne peut pas le distinguer d'un cas normal : le Gateway
ouvre onchain **avant** d'écrire le journal, donc « différé, pas de spec » est
l'état transitoire attendu de *tout* mandat légitime. La sortie opérateur n'est
qu'un compteur `différés: N` par tick — pas d'alerte, pas d'identifiant. Un
mandat frauduleux se noie exactement dans le bruit prévu.

## Deux affirmations du projet que ceci falsifie

- `README.md` : *« I10 — Compromising the component that opens must not grant
  the power to seize. »*
- `docs/transactions.md` § 3 : *« le règlement est l'opération sensible : c'est
  le seul privilège qui déplace des fonds vers un tiers. »*

`open` déplace aussi des fonds vers un tiers, avec 15 minutes de latence. Et le
projet a **agi** sur cette croyance : il a délibérément placé l'`opener` sur
l'infrastructure KeeperHub *parce qu'il croyait ce rôle non porteur de fonds*, en
gardant le `settler` « hors de l'infrastructure d'exécution ». La décision
d'architecture repose sur une propriété qui n'existe pas.

Votre propre test `test_NoEmergencyWithdrawExists` affirme qu'aucun retrait
n'existe. `open(agent=soi) + reclaim` **est** une fonction de retrait, à retard.

## Correctif

Aucune garde simple ne le referme — c'est un défaut de conception, pas un
`require` manquant. Deux directions cohérentes avec l'architecture :

1. **Lier `agent` au payeur constaté onchain.** Faire de `fundingRef` autre chose
   qu'un champ décoratif : un mapping `fundingRef → (payeur, montant, consommé)`
   alimenté par une fonction de dépôt, et `open` qui refuse si `agent` ≠ payeur
   ou si le montant ne couvre pas le `bond`.
2. **Exiger la signature de l'agent** sur les paramètres du mandat, vérifiée dans
   `open`. L'opener redevient un simple relais et ne peut plus nommer un
   destinataire que l'agent n'a pas approuvé.

À très court terme et sans redéploiement, une mitigation partielle existe côté
exploitation : surveiller les `WarrantOpened` dont l'`id` est absent du journal
et **saisir avant expiration** vers un bénéficiaire maîtrisé. Cela transforme le
vol en destruction — ce qui est moins pire, sans être bon.
