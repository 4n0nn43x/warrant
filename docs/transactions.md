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

## Rejouer un verdict soi-même

Chaque verdict publie `evaluatedAtBlock`, `rpcUrl` et le détail `checks[]`, avec
valeur attendue et valeur observée. L'évaluation est une lecture onchain à bloc
figé : n'importe qui peut la refaire et obtenir le même résultat, ou constater
une divergence.

C'est la réponse à « pourquoi vous ferait-on confiance ? » — on ne demande pas de
confiance, on rend le verdict reproductible.
