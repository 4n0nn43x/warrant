# Transactions réelles

Toutes vérifiables. Aucune n'est simulée, aucune n'est un mockup.

> **Statut du déploiement.** Ce qui suit tourne sur **Ethereum Sepolia**, avec un
> USDC de test. C'est un déploiement de **développement** : il prouve que le
> cycle complet fonctionne onchain. La cible de la soumission est **Base (8453)**
> avec l'USDC natif Circle, où le contrat sera redéployé — le hackathon valorise
> explicitement le mainnet, et une soumission finale sur testnet serait une
> faiblesse assumée pour rien.

---

## 1. Exécution via KeeperHub

Le premier appel exécuté par ce projet à travers KeeperHub, sur **Base Sepolia**.
C'est le scénario de révocation d'allowance de la démo : `approve(spender, 0)`.

| | |
|---|---|
| Transaction | [`0xaf65a4e6…4d315`](https://sepolia.basescan.org/tx/0xaf65a4e68a3a567729c95c3b2fef324612d70544aae930f2f7ae09a43cb4d315) |
| `executionId` KeeperHub | `w077usw3ru11uwafb2yd1` |
| Bloc | 44736245 |
| Gas | 97 164, **sponsorisé** |
| Appel | `approve(0x…dEaD, 0)` sur l'USDC Base Sepolia |

**Ce que cette transaction a appris au projet.** Elle est passée alors que le
wallet de l'organisation est vide sur les 20 chaînes — le sponsoring fonctionne.
Mais elle a surtout révélé qu'une transaction sponsorisée **ne ressemble pas à
ce qu'on a demandé** :

| | Attendu | Réel onchain |
|---|---|---|
| `tx.from` | wallet de l'org | relayer `0x6331eb45…` |
| `tx.to` | USDC `0x036cbd…` | forwarder `0x5aF5194B…` |
| `tx.input` | `approve(…)` | `execute(address,address,uint256,bytes)` |

Sans décapsuler cette enveloppe, `calldata_matches_commitment` échouerait sur
**chaque** mandat sponsorisé, et le système saisirait des cautions à tort de
façon systématique. Le correctif est dans
[`packages/server/src/checks/forwarder.ts`](../packages/server/src/checks/forwarder.ts),
et ses tests rejouent les octets exacts de cette transaction.

---

## 2. Cycle de mandat complet — Ethereum Sepolia

Contrat : [`0xadDC715B…de12`](https://sepolia.etherscan.io/address/0xadDC715B79Cb972d3a7f0dce5998CC141CaAde12)
· `feeBps` = 250 (2,5 %) · `MIN_DURATION` = 900 s

### Mandat honoré

| Étape | Transaction |
|---|---|
| Caution versée au coffre | [`0xa62c736c…896d`](https://sepolia.etherscan.io/tx/0xa62c736c2bdffe77575ff8807053d792f1ae39c31ba41fb28afeb2c65f31896d) |
| `open` par l'**opener** | [`0x03a4cd54…4519`](https://sepolia.etherscan.io/tx/0x03a4cd54f97fa66f7f6464f0f4168d8623ad1cda47c1f695d6b9417a1b3d4519) |
| `honor` par le **settler** | [`0x77066307…2721`](https://sepolia.etherscan.io/tx/0x77066307716e5626c57871cc78890713cd4035d6fc34663c6022466cbc682721) |

`warrantId` `0x07b03947…7dc3`. Event `WarrantHonored` décodé :
**`refunded` = 24,375 USDC, `fee` = 0,625 USDC** — exactement `bond − bond·250/10000`.
`totalLocked` revient à 0.

### Mandat saisi

C'est celui qui compte. Un garde-fou qui bloque ne produit aucune transaction,
donc aucune preuve ; ici l'échec devient un artefact onchain vérifiable.

| Étape | Transaction |
|---|---|
| `open` | inclus dans le même lot |
| **`slash`** par le settler | [`0x3cecf857…bb21`](https://sepolia.etherscan.io/tx/0x3cecf857ae09d6bcf85927057cc99bcc4d5b446bb1d4212d2f541686750abb21) |

Raison inscrite onchain, telle qu'elle sera lue par n'importe qui :

```
erc20_balance_delta: attendu >=-1000000000, observé -9000000000 |
erc20_balance(allowed_dest): attendu >=1000000000, observé 0
```

**Invariant I6 vérifié onchain** : le bénéficiaire reçoit **25 USDC intégraux**,
la trésorerie du protocole reçoit **zéro**. Une saisie ne rapporte rien à
Warrant — c'est ce qui élimine l'objection de l'incitation perverse, et ce n'est
pas seulement écrit dans un test, c'est constatable sur la chaîne.

---

## 3. L'escrow piloté par KeeperHub — et la limite qu'on y a trouvée

Question posée : les appels `open` / `honor` / `slash` peuvent-ils passer par
KeeperHub, et donc être sponsorisés ? Cela déciderait du financement de tout le
runner de volume.

**Réponse : oui pour un rôle, et un seul.**

| Étape | Résultat |
|---|---|
| `setOpener(walletKeeperHub)` | [`0x…`](https://sepolia.etherscan.io/address/0xadDC715B79Cb972d3a7f0dce5998CC141CaAde12) — l'opener devient le wallet de l'organisation |
| **`open` via KeeperHub** | [`0x12ad7c02…6374`](https://sepolia.etherscan.io/tx/0x12ad7c029e386fb20e01336d93967ecca431f9917a9204301de3b0b74d2d6374) — **`sponsored: true`**, 275 904 gas, mandat `Open` onchain |
| `honor` par le settler local | [`0x42966aee…d897`](https://sepolia.etherscan.io/tx/0x42966aee484a7655c0d9e673609ebbf9cb0e6e3ca5cdc0855d66747ae8abd897) |

L'ouverture d'un mandat est donc **gratuite en gas**. C'est ce qui rend le volume
atteignable sans budget.

### La contrainte : une organisation KeeperHub n'a qu'un wallet

`GET /api/user/wallet` le dit explicitement — le wallet est *organization-scoped,
not per-user*. Or l'invariant **I10** exige que l'`opener` et le `settler` soient
deux adresses distinctes : compromettre le composant qui ouvre ne doit pas donner
le pouvoir de saisir.

**KeeperHub ne peut donc porter qu'un seul des deux rôles.** L'autre a besoin
d'une clé propre, avec du gas.

Le choix retenu — KeeperHub comme `opener`, clé dédiée pour le `settler` — est le
bon dans les deux sens :

- l'ouverture est l'opération de **volume** (une par mandat), c'est là que le
  sponsoring rapporte ;
- le règlement est l'opération **sensible** : c'est le seul privilège qui déplace
  des fonds vers un tiers. La garder sur une clé qu'on maîtrise, hors de
  l'infrastructure d'exécution, réduit la surface plutôt que de l'élargir.

### Vérifié plutôt qu'affirmé

L'argument « le composant qui ouvre ne peut pas saisir » n'est pas resté une
assertion. KeeperHub, une fois devenu `opener`, a réellement tenté un `slash` :

```
wouldRevert: true, data: 0x05b94333
0x05b94333 = NotSettler()
```

La séparation des rôles a donc été éprouvée contre un appelant réel, pas contre
un mock — et le contrat a refusé.

### Une friction de plus au passage

L'ABI ne peut pas être auto-récupérée pour un contrat non vérifié, ce qui est
attendu. Mais le champ `abi` doit être passé en **chaîne JSON**, exactement comme
`functionArgs` — un tableau JSON est rejeté avec le même message que si le champ
était absent : *« ABI is required. Could not auto-fetch ABI… »*. Le message ne
mentionne jamais que le champ a bien été reçu mais dans le mauvais format.
Reporté dans le teardown d'onboarding.

---

## 4. Le Gateway ouvre un mandat par lui-même

Les mandats de § 2 et § 3 ont été ouverts à la main, pour éprouver le contrat.
Celui-ci l'a été par le **port d'ouverture du Gateway** (`keeperHubEscrow`),
c'est-à-dire par le code qui tournera en production, sur la chaîne réelle.

| Étape | Transaction |
|---|---|
| Financement de la caution (5 USDC au contrat) | [`0x85498ebe…b4f9`](https://sepolia.etherscan.io/tx/0x85498ebe47af72053374797e3b48cf687d0b10bfabc7dad99520a69b0637b4f9) |
| **`open` par `keeperHubEscrow`** | [`0x269d4f4f…7fca`](https://sepolia.etherscan.io/tx/0x269d4f4f9d1803b301c523b573edb0c1188aebf46d04ff04268526c4b817fca7) |

`warrantId` `0x16e86a94…1160`. Relu sur un RPC indépendant, `warrants(id)` rend
`status = 1` (`Open`), `bond = 5 000 000`, et `totalLocked` progresse d'autant.
Le financement va **au contrat lui-même** et non à un coffre intermédiaire :
`open()` exige `token.balanceOf(this) >= totalLocked` (WarrantEscrow.sol:131), ce
qui est aussi la raison pour laquelle `WARRANT_PAY_TO` est l'adresse de l'escrow.

**Ce que cette transaction a appris au projet.** La réponse de
`POST /api/execute/contract-call` ne contient **pas** le hash de la transaction :
un `202` avec `{ executionId, status: "completed" }`, et rien d'autre. Le hash
n'existe que sur la route de statut. Un mandat ouvert sans hash est un mandat que
le Settler ne peut pas juger — il n'a aucun point d'entrée pour lire la chaîne —
alors même que la caution a été prélevée et que le mandat existe onchain. Le
premier essai a d'ailleurs ouvert un mandat bien réel
([`0x1c46340c…6a3f`](https://sepolia.etherscan.io/tx/0x1c46340cb91696d59bff8266d0d58cd8a1ec0c8f680ddc3330003185b72f6a3f),
`sponsored: true`, 236 304 gas) que le client a cru perdu. Le correctif est dans
`KeeperHubClient.executeContractCall`, et il est décrit dans le teardown
d'onboarding.

---

## Rejouer un verdict soi-même

Chaque verdict publie `evaluatedAtBlock`, `rpcUrl` et le détail `checks[]`, avec
valeur attendue et valeur observée. L'évaluation est une lecture onchain à bloc
figé : n'importe qui peut la refaire et obtenir le même résultat, ou constater
une divergence.

C'est la réponse à « pourquoi vous ferait-on confiance ? » — on ne demande pas de
confiance, on rend le verdict reproductible.
