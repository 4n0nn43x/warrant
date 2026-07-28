# Teardown d'onboarding — journal horodaté

Journal des frictions rencontrées en partant de zéro sur KeeperHub, tenu **au
fil de l'eau**. Reconstituer ces notes le 12 août serait impossible : on les
aura oubliées, et ça se verrait.

Format d'une entrée : horodatage, ce qu'on essayait de faire, ce qui s'est
passé, ce qui aurait évité le blocage. Une friction sans correctif proposé n'est
qu'une plainte.

Cible : le bounty **Best Onboarding UX Improvement** (1 000 $, deux gagnants,
cumulable avec le Grand Prize). Le hackathon précédent de KeeperHub a produit
197 findings distillés en 47 tickets — c'est un format qu'ils savent exploiter.

---

## 2026-07-28

### 11:09 — Point de départ

Dépôt vide. Aucun compte KeeperHub, aucune clé API. Toute la documentation de
conception est écrite (`../docs/`), rien n'est implémenté.

### 11:12 — Foundry absent de la machine

Pas une friction KeeperHub, notée pour la reproductibilité : `forge` n'était pas
installé. `curl -sL https://foundry.paradigm.xyz | bash && foundryup` a suffi,
version 1.7.1. Installation propre, attestation vérifiée.

### 11:20 — L'OpenAPI live n'est pas la spec de l'API REST

**Ce qu'on cherchait** : un schéma machine pour générer le client REST.

**Ce qu'on a trouvé** : `app.keeperhub.com/api/openapi` sert un document
OpenAPI 3.1 de 79 chemins qui sont **tous** des
`POST /api/mcp/workflows/{slug}/call`. C'est le catalogue de la marketplace, pas
le CRUD REST. Les endpoints d'exécution et d'audit trail — ceux dont dépend
n'importe quel projet du hackathon — n'y figurent pas.

**Conséquence concrète** : le client `packages/server/src/keeperhub.ts` doit
parser le record d'exécution de façon défensive, en acceptant plusieurs
conventions de nommage (`txHash` / `transactionHash` / `tx_hash`), parce qu'on
ne peut pas savoir laquelle est la bonne avant d'avoir appelé l'API en vrai.

**Correctif proposé** : soit publier un second document OpenAPI pour l'API REST,
soit renommer celui-ci en `/api/marketplace/openapi` et le documenter comme tel.
Une ligne dans `docs.keeperhub.com/api` disant « l'OpenAPI live couvre la
marketplace, pas le CRUD » aurait suffi à éviter la confusion.

### 11:22 — `llms.txt` périmé sur le fournisseur de wallet

`docs.keeperhub.com/llms.txt` annonce des **wallets Para MPC**. La documentation
produit (`docs.keeperhub.com/wallet-management`) dit **Turnkey**, et liste Para
comme intégration **discontinuée**.

Le `llms.txt` est précisément le fichier qu'un agent lit en premier. Il est donc
le plus coûteux à laisser dériver : un builder qui s'y fie écrit sa soumission
avec le mauvais nom de fournisseur.

**Correctif proposé** : régénérer `llms.txt` depuis la doc à chaque build, ou au
minimum y dater la dernière synchronisation.

### 11:23 — « Non-custodial » vs « custody is server-side »

Le marketing dit non-custodial ; `docs.keeperhub.com/ai-tools/agentic-wallet`
décrit une sub-organisation Turnkey par wallet avec *« custody is server-side »*.
Les deux affirmations sont défendables séparément mais se contredisent pour un
lecteur pressé, et c'est le genre de nuance qu'un builder recopie de travers dans
sa soumission.

**Correctif proposé** : une phrase canonique unique, réutilisée partout — par
exemple « clés en enclave, jamais sur disque, custody déléguée à Turnkey ».

### 11:24 — « Open source » sans licence OSI

Le dépôt `KeeperHub/keeperhub` est annoncé open source sur le site, dans la page
du hackathon et dans le brief du bounty (« KeeperHub is open source, and the
fastest way to make it better is fresh eyes »). GitHub classe pourtant la licence
en **`NOASSERTION`**.

**Pourquoi ça bloque concrètement** : le bounty demande une PR mergée. Contribuer
du code à un dépôt sans licence claire pose une question de cession de droits
qu'un contributeur prudent se posera avant d'ouvrir la PR — c'est-à-dire au pire
moment.

**Correctif proposé** : ajouter un `LICENSE` explicite à la racine, et le
mentionner dans le brief du bounty.

---

## À vérifier au premier contact avec l'API

Ces points ne peuvent pas être tranchés sans clé API. Ils sont ouverts.

| # | Question | Pourquoi ça bloque |
|---|---|---|
| 1 | **Plafonds du wallet agentique** : 200 USDC/jour, 100 USDC/transfert sont-ils relevables ? | La cible de volume du projet est de ~3 750 USDC/jour de cautions. Sans relèvement, elle est inatteignable |
| 2 | Le record d'exécution expose-t-il `blockNumber` et le résultat de **simulation** via l'API, ou seulement dans l'UI ? | Tout le règlement en dépend |
| 3 | Conditions et **quotas** du gas sponsoring sur Ethereum mainnet | Dimensionne le volume de démo |
| 4 | Le wallet agentique peut-il exécuter sur **Ethereum mainnet** ? L'allowlist par défaut est Base + Tempo | Le plan de démo suppose L1 |
| 5 | Délai et revue de publication d'un workflow sur la marketplace | Jalon J9–J11 |
| 6 | Y a-t-il une limite au montant d'un paiement x402 accepté ? | Dimensionne `maxBond` |
