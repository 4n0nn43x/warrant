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

### 13:40 — Deux familles de clés, un seul préfixe documenté en évidence

**Ce qu'on a fait** : collé dans `.env` la clé récupérée dans les paramètres du
compte. Elle commence par `wfb_`.

**Ce qui s'est passé** : 401 partout. Sur `/mcp` (`invalid_token`), sur
`/api/user`, sur toute route authentifiée.

**La cause** : KeeperHub a **deux** familles de clés, gérées par **deux**
endpoints différents, et la page « API Keys » présente les deux onglets côte à
côte sans avertissement :

| Préfixe | Scope | Créée dans | Utilisable pour |
|---|---|---|---|
| `kh_` | Organisation | Settings → API Keys → onglet **Organisation** | REST, MCP, plugin Claude Code |
| `wfb_` | Utilisateur | Settings → API Keys | **une seule route** : `POST /api/workflows/{id}/webhook` |

Une clé `wfb_` est donc rejetée par 99 % de la plateforme, et le message d'erreur
(`invalid_token`) ne dit pas pourquoi.

**Correctifs proposés**, par ordre de rendement :
1. Faire dire au 401 *quelle* famille de clé a été présentée :
   « this endpoint requires an organization key (`kh_`); you presented a user
   webhook key (`wfb_`) ». Le préfixe est connu du serveur, l'information est
   gratuite.
2. Renommer l'onglet « User » en « Webhook keys (`wfb_`) » dans l'UI.
3. Mettre le tableau des préfixes en tête de `docs.keeperhub.com/api`, pas
   seulement dans `/api/authentication`.

### 13:45 — Aucune route REST n'est découvrable depuis l'API

**Ce qu'on a fait** : cherché l'endpoint de lecture d'une exécution en sondant
les noms plausibles.

**Ce qui s'est passé** : `/api/executions`, `/api/runs`, `/api/keeper-runs`,
`/api/execute`, `/api/wallets` → tous `404 not_found`. Aucun ne suggère la bonne
forme.

**Les vraies routes**, trouvées seulement en lisant la doc HTML page par page :

| Ce qu'on cherche | Route réelle |
|---|---|
| exécuter un appel de contrat | `POST /api/execute/contract-call` |
| statut d'une exécution directe | `GET /api/execute/{id}/status` |
| statut d'une exécution de workflow | `GET /api/workflows/executions/{id}/status` |
| attendre l'état terminal | `GET /api/workflows/executions/{id}/wait` |
| wallet de l'organisation | `GET /api/user/wallet` |

Les exécutions de workflow vivent sous `/api/workflows/executions/…` et non sous
`/api/executions` : c'est la cause exacte de nos 404.

**Correctif proposé** : une route `GET /api` renvoyant l'index des routes, ou un
`404` qui propose la route la plus proche (« did you mean
`/api/workflows/executions/{id}/status` ? »). Coût : quelques lignes. Gain : la
demi-heure que chaque nouveau builder perd ici.

### 13:50 — Le marketplace entier répond 503

Tous les workflows testés — `helloworld`, `aave-v3-health-check`,
`usdc-yield-rates-aave-vs-compound`, `defi-risk-snapshot` — renvoient
`503 « The workflow owner has disabled this workflow »`, avec **et** sans
authentification.

Le catalogue `GET /api/mcp/workflows` répond pourtant 200 et ne liste plus que
**20** workflows, contre **79** dans l'OpenAPI live consulté deux heures plus tôt
le même jour.

Un builder qui commence par le quickstart marketplace conclut que sa
configuration est en cause et perd son après-midi. **Correctif proposé** : une
page de statut, ou au minimum un message distinguant « ce workflow est désactivé
par son auteur » de « le service est indisponible ».

### 13:55 — `initialize` du MCP ne teste pas l'authentification

`POST /mcp` `initialize` renvoie **toujours** `200` avec
`authentication.required: true`, même sans token, même avec un token invalide.
C'est une annonce de capacité, pas un verdict.

On a donc cru la clé acceptée alors qu'elle ne l'était pas. Le vrai contrôle
n'apparaît que sur `tools/list`.

**Correctif proposé** : le documenter en une phrase dans
`ai-tools/mcp-server` — « pour vérifier vos identifiants, appelez `tools/list`,
pas `initialize` ».

### 14:12 — Première transaction réelle, et deux surprises

`POST /api/execute/contract-call` sur Base Sepolia, `approve(0xdEaD, 0)` sur
l'USDC testnet. **Passée** :
`0xaf65a4e68a3a567729c95c3b2fef324612d70544aae930f2f7ae09a43cb4d315`,
bloc 44736245, `sponsored: true` — alors que le wallet de l'organisation est
**vide sur les 20 chaînes**. Le gas sponsorship fonctionne, au moins en testnet.

**Surprise n°1 — l'API n'accepte pas de calldata brut.**

Le body attend `functionName` et `functionArgs`, et récupère l'ABI du contrat
automatiquement. Il n'existe aucun champ pour passer un calldata pré-encodé :
`data`, `callData` et `calldata` sont tous ignorés, et l'erreur renvoyée parle
de `functionName` sans jamais dire que le calldata brut n'est pas une option.

Pire, `functionArgs` doit être **une chaîne JSON**, pas un tableau :

```jsonc
// rejeté en 400, sans indice sur la vraie forme
{ "functionName": "approve", "args": ["0x…", "0"] }
// rejeté : "functionArgs must be a JSON string when provided"
{ "functionName": "approve", "functionArgs": ["0x…", "0"] }
// accepté
{ "functionName": "approve", "functionArgs": "[\"0x…\",\"0\"]" }
```

Il a fallu sonder six noms de champs pour trouver `functionArgs`, puis
comprendre l'encodage en chaîne. **Correctif proposé** : accepter un tableau JSON
directement (ou au minimum le mentionner dans le message d'erreur), et documenter
qu'un calldata pré-encodé n'est pas supporté — c'est une hypothèse que fait
n'importe qui ayant déjà utilisé `eth_sendTransaction`.

**Surprise n°2 — une transaction sponsorisée n'a ni le `from` ni le `to`
attendus.**

C'est la découverte structurante de la journée. Le record d'exécution le laisse
voir dans `result.executedCall.topLevelTo`, mais rien ne l'explique :

| | Attendu | Réel |
|---|---|---|
| `tx.from` | wallet de l'org `0x1f8547…` | **relayer `0x6331eb45…`** |
| `tx.to` | contrat cible `0x036cbd…` | **forwarder `0x5aF5194B…`** |
| `tx.input` | `approve(0xdEaD,0)` | `execute(address,address,uint256,bytes)` |

Le calldata réel est encapsulé : `execute(wallet, target, value, data)` où `data`
contient une signature de 65 octets, des métadonnées, puis le calldata cible.

**Ce que ça casse, pour n'importe quel projet qui vérifie ses exécutions :**

- toute vérification de la forme `tx.to == contrat_cible` échoue ;
- toute vérification `tx.input == calldata_attendu` échoue ;
- **le nonce du wallet de l'organisation n'avance pas** — c'est le relayer qui
  émet la transaction.

Les vérifications par **effet** (logs `Transfer`/`Approval`, deltas de solde,
lecture d'état au bloc) restent valides : le log `Approval` est bien émis par
l'USDC. C'est la seule base fiable.

**Correctif proposé** : documenter la forme d'une transaction sponsorisée dans
`wallet-management/gas`, avec l'adresse du forwarder par chaîne et l'ABI de
`execute`. Une équipe qui bâtit une preuve d'exécution sur `tx.to` ne le
découvrira qu'en production — ou, pour un hackathon, pendant la démo.

---

## Contradictions relevées dans la documentation

### Gas sponsorship sur Ethereum mainnet

La page du hackathon annonce : *« KeeperHub offers gas sponsorship on mainnet
Ethereum. »*

`docs.keeperhub.com/wallet-management/gas` pose quatre conditions cumulatives,
dont la troisième : *« transactions routed through a private mempool are not
sponsored »*.

Or `GET /api/chains` renvoie `usePrivateMempoolRpc: true` pour **Ethereum
Mainnet (1)** et Sepolia — et pour aucune autre chaîne.

Pris littéralement, Ethereum mainnet est donc **exclu** du sponsoring que le
hackathon met en avant. Soit un override existe pour l'événement, soit
l'annonce devance la configuration. **À faire trancher sur le Discord avant de
bâtir une démo sur l'hypothèse du gas gratuit en L1.**

### Simulation absente de l'audit trail

`docs/08-integration-keeperhub.md` § 4 de ce projet supposait que le résultat de
simulation était lisible dans l'audit trail. Il ne l'est pas : `simulate: true`
n'insère **aucune** ligne d'exécution, et le résultat n'existe que dans la
réponse HTTP synchrone.

Conséquence pour Warrant : la simulation doit être appelée explicitement **avant**
l'ouverture du mandat, et son résultat conservé par nos soins. C'est faisable et
même plus propre, mais la doc de conception doit être corrigée.

### `blockNumber` n'est exposé nulle part

Aucune route ne renvoie le numéro de bloc d'inclusion. Il faut le dériver du
`txHash` via un RPC.

Sans conséquence pour Warrant — le Settler attend de toute façon les
confirmations sur un RPC indépendant, et c'est ce receipt qui fait foi — mais
c'est une surprise pour qui construit un indexeur sur l'audit trail seul.

---

## À vérifier au premier contact avec l'API

Ces points ne peuvent pas être tranchés sans clé API. Ils sont ouverts.

| # | Question | Pourquoi ça bloque |
|---|---|---|
| 1 | **Cap de dépense journalier de l'organisation** : quelle est la valeur par défaut, et où se règle-t-elle ? `GET /api/analytics/spend-cap` le lit, aucune route ne l'écrit | Un dépassement fait échouer les exécutions en 403 jusqu'à minuit UTC |
| 2 | **Gas sponsorship mainnet** : l'override hackathon existe-t-il malgré `usePrivateMempoolRpc: true` ? | Contradiction relevée ci-dessus. Dimensionne toute la démo |
| 6 | Y a-t-il une limite au montant d'un paiement x402 accepté ? | Dimensionne `maxBond` |

**Résolus le 28/07** : la forme du record d'exécution, les routes REST, le format
des clés, l'authentification MCP headless (une clé `kh_` en Bearer suffit, pas
d'OAuth), et les plafonds du wallet agentique — 200 USDC/jour, 100 USDC par
transfert, allowlist Base + Tempo, **non configurables** (« not user-configurable
today », un relèvement demande une action opérateur). Ces plafonds ne concernent
que le **wallet agentique** qui paie les workflows x402, pas le wallet
d'exécution de l'organisation, qui lui couvre les 22 chaînes dont Ethereum
mainnet.
