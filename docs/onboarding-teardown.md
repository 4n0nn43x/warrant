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

### 15:20 — `abi` doit être une chaîne JSON, et le message d'erreur le cache

Pour exécuter un appel sur un contrat **non vérifié**, il faut fournir l'ABI. Le
champ existe et s'appelle `abi`. Mais comme `functionArgs`, il attend une
**chaîne JSON**, pas un tableau.

Le piège est dans le message : passer un tableau JSON produit exactement la même
erreur que ne rien passer du tout.

```
{"error":"ABI is required. Could not auto-fetch ABI: Unable to fetch ABI for
 0xadDC… on chain 11155111. Contract may not be verified.","field":"abi"}
```

On conclut donc que le champ n'est pas supporté, et on cherche ailleurs — j'ai
sondé `contractAbi` et `abiJson` avant de repenser à la convention de
`functionArgs`.

**Correctif proposé** : distinguer les deux cas. « ABI is required » quand le
champ est absent ; « `abi` must be a JSON string when provided » quand il est
présent mais mal typé — c'est le message que l'API produit déjà pour
`functionArgs`, il suffit de l'appliquer ici aussi.

### 15:25 — Une organisation n'a qu'un wallet, et ça contraint l'architecture

`GET /api/user/wallet` : *« The wallet is organization-scoped, not per-user. »*

Ce n'est pas un défaut, mais c'est une contrainte d'architecture qui mérite
d'être annoncée en tête de la documentation wallet plutôt que découverte à
l'usage. Tout projet ayant **deux rôles onchain distincts** — ce qui est le cas
dès qu'on sépare un privilège d'écriture d'un privilège de règlement — ne peut en
confier qu'un seul à KeeperHub. L'autre demande une clé propre et du gas, donc un
budget, donc une décision de conception.

Nous l'avons découvert en basculant l'`opener` vers le wallet KeeperHub et en
constatant qu'il faudrait y basculer aussi le `settler`, ce qui aurait détruit
l'invariant qui garantit qu'un composant compromis ne peut pas saisir de fonds.

**Correctif proposé** : une phrase dans `wallet-management` — « une organisation
dispose d'un wallet d'exécution unique ; si votre contrat distingue plusieurs
rôles onchain, un seul peut être tenu par KeeperHub » — et, à terme, la
possibilité de provisionner plusieurs wallets par organisation.

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

---

## 2026-07-29

### Contexte

Journée de mise en œuvre : câblage réel du Gateway et du Settler, migration MCP,
et vérification systématique de ce que la documentation affirmait. Les entrées
ci-dessous sont les frictions rencontrées ce jour-là. Trois d'entre elles sont
des frictions **d'écosystème** plus que de KeeperHub, mais elles frappent
n'importe quelle équipe du hackathon dans le même ordre, et méritent d'être
signalées à ce titre.

### Le serveur MCP de KeeperHub est resté sur l'ère `initialize`

Le 28 juillet 2026 — le jour même de la clôture du hackathon côté inscriptions —
la révision **`2026-07-28`** de MCP a été publiée en finale. Elle supprime le
handshake `initialize` et l'en-tête `Mcp-Session-Id` : le protocole devient
*stateless*. Six SEP y concourent, et les mainteneurs la décrivent comme la
modification la plus substantielle depuis l'ajout de l'autorisation.

**Conséquence directe sur une entrée précédente de ce journal.** Le point du
28/07 à 13:55 signalait que `POST /mcp` `initialize` répond toujours `200`, même
sans jeton, et que le vrai contrôle d'authentification n'apparaît qu'à
`tools/list`. Le correctif proposé était de le documenter. **Ce correctif est
périmé** : `initialize` n'existe plus dans la révision courante. Le conseil utile
devient celui-ci — planifier la migration du serveur MCP vers `2026-07-28`, où
la question ne se pose plus, puisque chaque requête porte son propre contexte
d'authentification et où la validation est faite en-tête par en-tête
(`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, avec rejet `-32020
HeaderMismatch` en cas de divergence avec le corps).

Le SDK TypeScript a suivi le même jour : le paquet monolithique
`@modelcontextprotocol/sdk` est retiré au profit de `@modelcontextprotocol/server`
et `@modelcontextprotocol/client` en `2.0.0`.

**Correctif proposé** : annoncer sur `docs.keeperhub.com/ai-tools/mcp-server` la
révision de protocole effectivement servie, et la date cible de passage à
`2026-07-28`. Un builder qui migre son propre serveur a besoin de savoir si le
serveur d'en face suivra, parce que les deux ères ne s'interopèrent que par
repli explicite.

### Le facilitateur x402 public ne couvre aucun réseau utilisable en production

`GET https://x402.org/facilitator/supported` renvoie, pour les réseaux EVM :

```
eip155:84532  (Base Sepolia)   ← le seul
base-sepolia                    ← le même, sous son nom hérité
```

Ni `eip155:8453` (Base mainnet), ni `eip155:11155111` (Ethereum Sepolia). Le
reste de la liste est non-EVM : Solana, Aptos, Algorand, Hedera, Stellar, XRPL.

**Pourquoi ça coince ici.** Le hackathon valorise le mainnet, et KeeperHub
exécute sur 22 chaînes. Mais un projet qui encaisse en x402 ne peut le faire, avec
le facilitateur public, que sur **Base Sepolia**. Passer en production impose le
facilitateur CDP (`api.cdp.coinbase.com/platform/v2/x402`), donc un compte
Coinbase Developer Platform et des clés — une étape d'inscription qui n'est
mentionnée dans aucun des quickstarts croisés jusqu'ici.

**Correctif proposé** : dire explicitement, dans la page x402 de la
documentation KeeperHub, que le facilitateur public est un facilitateur de
**testnet Base uniquement**, et que toute cible mainnet suppose un compte CDP.
Deux phrases évitent de découvrir la contrainte après avoir déployé son escrow
sur la mauvaise chaîne.

### Un RPC public répandu ne sait pas servir de lecture à bloc figé

Friction d'écosystème, mais elle mérite d'être ici parce qu'elle est invisible
et que son mode de défaillance est trompeur.

`ethereum-sepolia-rpc.publicnode.com` — un des premiers RPC que l'on colle dans
un `.env` — répond correctement à `eth_blockNumber` et à tout appel au bloc
`latest`, mais refuse **toute** requête d'archive :

```
eth_call    à un bloc passé      -> -32602 "Archive requests require a personal token"
eth_getLogs sur une plage passée -> HTTP 403, même message
```

Or n'importe quel projet du hackathon qui vérifie *après coup* ce qu'une
exécution a produit fait, par définition, une lecture à bloc figé. Le RPC marche
donc pendant tout le développement et se met à échouer exactement au moment où
l'on branche l'évaluation. Pour Warrant, c'était plus grave qu'une panne : chaque
verdict publie le `rpcUrl` utilisé en promettant que n'importe qui peut rejouer
l'évaluation, et sur ce RPC la promesse était invérifiable.

`sepolia.drpc.org` fait le travail sans clé (plafond `eth_getLogs` : 10 000 blocs
par requête).

**Correctif proposé** : une ligne dans le quickstart KeeperHub — « le RPC que
vous utilisez pour vérifier une exécution doit être un nœud d'archive ; les RPC
publics ne le sont pas tous » — avec deux exemples qui fonctionnent.

---

### 17:05 — La réponse d'exécution ne contient pas le hash de la transaction

C'est la friction la plus coûteuse de la journée, parce qu'elle a l'apparence
d'un succès.

`POST /api/execute/contract-call` **bloque** jusqu'à la fin de l'exécution — 23 s
mesurées sur Sepolia — puis répond :

```jsonc
// HTTP 202
{ "executionId": "9z08b35kdd8fwiz14gtr0", "status": "completed" }
```

Une exécution terminée, un statut `completed`, et rien pour aller la vérifier.
Le `transactionHash`, le `sponsored`, le gas consommé et l'`executedCall`
n'existent que sur `GET /api/execute/{id}/status` — où ils sont disponibles
**immédiatement**, sans attente supplémentaire.

Trois choses en font un piège plutôt qu'une simple omission :

1. **Le code de statut ment sur la sémantique.** Un `202 Accepted` annonce un
   traitement asynchrone à venir ; ici le traitement est *déjà fini*. On en
   déduit naturellement que le hash arrivera plus tard, et on écrit une boucle
   d'attente qui ne sert à rien — alors qu'un simple `GET` immédiat suffit.
2. **Rien ne signale l'absence.** Le champ n'est pas à `null`, il est absent.
   Un client qui lit `response.transactionHash` obtient `undefined` et, s'il ne
   vérifie pas, enregistre une exécution réussie sans preuve.
3. **La conséquence est silencieuse et tardive.** Pour Warrant, un mandat ouvert
   sans hash est un mandat que le Settler ne peut plus juger : il n'a aucun point
   d'entrée pour lire la chaîne. La caution est prélevée, le mandat existe
   onchain, et le règlement devient impossible. Le bug ne se voit pas au moment
   où il est commis.

**Correctif proposé** : inclure `transactionHash` et `transactionLink` dans la
réponse de POST — elle est déjà bloquante, l'information est déjà connue au
moment où elle est écrite. À défaut, répondre `200` plutôt que `202`, et
documenter en une phrase que le hash s'obtient sur la route de statut.

### 17:20 — Une organisation n'a qu'un wallet : le corollaire côté configuration

Constat déjà noté à 15:25, mais son effet de bord mérite d'être dit séparément,
parce qu'il ne se manifeste qu'après coup.

Transférer le rôle `opener` au wallet KeeperHub change **l'état onchain sans
rien changer à la configuration locale**. La clé qui était `opener` est toujours
dans le `.env`, toujours valide, toujours capable de signer — elle n'a
simplement plus le droit. Le Gateway continuait donc de démarrer normalement, et
l'erreur ne serait apparue qu'au premier mandat **payant** : caution réglée,
puis `open()` révèrte en `NotOpener()`.

La parade adoptée est un contrôle de cohérence au démarrage : le Gateway lit
`opener()` sur la chaîne et refuse de démarrer si l'adresse qui s'apprête à
signer n'est pas celle-là. Coût nul, et l'erreur devient impossible à ignorer.

**Correctif proposé** : dans `wallet-management`, mentionner que confier un rôle
onchain au wallet de l'organisation crée une dépendance implicite entre l'état
du contrat et la configuration du client, et suggérer le contrôle au démarrage
comme motif.
