# 01 — L'invariant I10 n'est appliqué ni par le contrat, ni par le test qui le certifie

**Sévérité : Haute.**
**Fichier :** `contracts/src/WarrantEscrow.sol`
**Commit :** `6194b68529d8c73b64a47ee98247bc2640887621`

## Résumé

I10 énonce que l'`opener` et le `settler` sont deux rôles **distincts**, et le
README en tire la garantie de sécurité centrale du projet : *« Compromising the
component that opens must not grant the power to seize. »*

Aucune ligne du contrat ne l'impose. Le constructeur, `setOpener` et `setSettler`
ne comparent jamais les deux adresses. Et le test d'invariant qui prétend le
vérifier est structurellement incapable d'échouer.

## Les lignes défectueuses

```solidity
constructor(address token_, address treasury_, address opener_, address settler_, uint16 feeBps_) {
    if (feeBps_ > MAX_FEE_BPS) revert BadFee();
    // ← aucune comparaison entre opener_ et settler_
    token = IERC20(token_);
    treasury = treasury_;
    opener = opener_;
    settler = settler_;
```

```solidity
function setOpener(address next) external onlyOwner {
    emit OpenerChanged(opener, next);
    opener = next;              // ← aucune comparaison avec `settler`
}

function setSettler(address next) external onlyOwner {
    emit SettlerChanged(settler, next);
    settler = next;             // ← aucune comparaison avec `opener`
}
```

Le seul garde-fou du dépôt est **hors chaîne**, dans `contracts/script/Deploy.s.sol`,
et son commentaire le présente comme « non contournable ». Il l'est : `setOpener`
et `setSettler` ne repassent jamais par le script. **Et le flux de production
documenté emprunte précisément ce chemin** — `docs/transactions.md` § 3 décrit
`setOpener(walletKeeperHub)` exécuté après déploiement pour obtenir le sponsoring
du gas, ce que `deployments/ethereum-sepolia.json` confirme (`openerAtDeploy` ≠
`opener`).

## Le test qui certifie sans tester

`contracts/test/WarrantEscrow.invariant.t.sol` :

```solidity
function invariant_I10_RolesAreDistinctAndEnforced() public {
    assertTrue(opener != settler, "I10 viole : opener == settler");
```

Mais le handler tire chaque rôle dans un vivier séparé :

```solidity
openerPool  = [makeAddr("opener.0"),  makeAddr("opener.1"),  makeAddr("opener.2")];
settlerPool = [makeAddr("settler.0"), makeAddr("settler.1"), makeAddr("settler.2")];
```

Les deux ensembles sont **disjoints par construction**. Le fuzzer ne peut pas
atteindre `opener == settler`. L'assertion passe 256 × 64 fois sans rien tester.
Les deux autres branches du test — le settler ne peut pas ouvrir, l'opener ne
peut ni honorer ni saisir — sont réelles ; c'est la clause « distincts » qui est
creuse.

## Séquence d'attaque

Attaquant : détenteur de la clé `owner`, ou quiconque la compromet. Le contrat
n'a **ni transfert ni renonciation de propriété** : `owner` est écrit une seule
fois, au constructeur.

1. Un agent règle son x402 : 25 USDC arrivent au contrat par transfert nu.
   `totalLocked` vaut encore 0 — c'est le modèle de financement du protocole.
2. `owner → setOpener(X)` puis `owner → setSettler(X)`. Aucune garde. I10 est mort.
3. `X → open(id, agent=X, beneficiary=X, bond=25e6, duration=15 min)` — le
   contrôle `balanceOf(this) >= totalLocked` est satisfait **par les fonds de la
   victime**.
4. `X → slash(id, ...)` dans la même transaction. `bond` intégral part chez X.
5. Le mandat légitime ne peut plus s'ouvrir : `Underfunded()`.

## Impact

| | |
|---|---|
| Extraction immédiate | `balanceOf(escrow) − totalLocked`, soit tout règlement x402 arrivé et non encore lié à un mandat |
| En régime permanent | l'étape 2 gèle l'ouverture légitime, donc **100 % des dépôts suivants** |
| Reçu par la trésorerie | **0** |

Le dernier point est le plus perfide : `slash` ne prélève aucun frais (I6). Le
vol est donc **indiscernable d'une saisie légitime** dans la comptabilité du
protocole — et I6, mis en avant devant le jury comme preuve d'absence
d'incitation perverse, sert ici de camouflage. Une variante par `honor` ne
rapporterait que `bond − fee` et arroserait la trésorerie : **I6 rend le vol 2,5 %
plus rentable que l'usage légitime**.

## Preuve exécutée

```
[PASS] test_constructorAcceptsIdenticalRoles()
  opener == settler accepte au deploiement: 0x9dF0C6b0...

[PASS] test_settersAllowFusingRoles()

[PASS] test_fusedRoleDrainsPendingBond()
  USDC voles a l'agent honnete: 25000000
  recu par la tresorerie du protocole: 0
```

## Correctif, vérifié

```solidity
error RolesMustDiffer();

// constructeur
if (opener_ == settler_) revert RolesMustDiffer();

// setOpener
if (next == settler) revert RolesMustDiffer();

// setSettler
if (next == opener) revert RolesMustDiffer();
```

Après application, les trois tests du PoC échouent tous sur `RolesMustDiffer()`.
La suite existante (65 tests, 11 invariants) reste verte.

**Le test d'invariant doit être corrigé aussi** : tant que les viviers sont
disjoints, il continuera de certifier une propriété qu'il ne teste pas. Faire
tirer les deux rôles dans un **vivier commun** rendrait l'assertion falsifiable.

## Objection anticipée

*« L'`owner` est un rôle de confiance ; qu'il se tire une balle dans le pied
n'est pas une vulnérabilité. »*

Trois éléments l'écartent. Le contrat n'a aucun moyen de révoquer un `owner`
compromis — la compromission est terminale. La fusion est une erreur
d'exploitation **plausible** et non un acte malveillant improbable : une
organisation KeeperHub n'a qu'un seul wallet, ce que le projet documente comme
une contrainte subie, donc la tentation de l'utiliser pour les deux rôles est
structurelle. Et surtout, la garantie annoncée dans le README devient fausse :
ce n'est pas « l'admin abuse de ses droits », c'est « la frontière de sécurité
documentée n'existe pas ».
