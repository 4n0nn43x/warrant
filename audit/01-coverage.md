# Contrôle de couverture OWASP SCS

Barrière obligatoire avant d'écrire le moindre rapport. Pour chacune des dix
catégories : où j'ai regardé, et ce que j'en conclus. Une catégorie à laquelle
on répond « pas regardé » renvoie à l'échelle de `no-false-negatives.md`.

| ID | Catégorie | Où j'ai regardé | Conclusion |
|---|---|---|---|
| **SC01** | Contrôle d'accès | constructeur `:90-103`, `setOpener` `:203-206`, `setSettler` `:208-211`, modificateur `onlyOwner` `:81-84`, gardes de `open`/`honor`/`slash`/`reclaim` | **Deux trouvailles.** I10 (« rôles distincts ») n'est imposé nulle part — prouvé par exécution. Et `open(agent=soi) + reclaim` donne à l'`opener` une autorité de retrait que le modèle de confiance ne lui accorde pas. `owner` n'est ni transférable ni renonçable : une compromission est terminale. |
| **SC02** | Logique métier | les dix invariants déclarés, attaqués un par un | **Quatre cassés ou creux** : I5 (falsifiable), I6 (vrai à la lettre, contournable économiquement), I8 (muet sur *quel* `feeBps`), I10 (inexistant dans le bytecode). **I1, I2, I3, I7 tiennent** et ont résisté à trois passes indépendantes. |
| **SC03** | Manipulation d'oracle | intégralité du contrat | **Sans objet** : aucun prix, aucun oracle, aucune source externe. Le seul prix du système est le `bond`, fixé hors chaîne et figé à l'ouverture. |
| **SC04** | Amplification par flash loan | les trois sorties de fonds | **Aucun levier.** `honor`/`slash` exigent le rôle `settler` ; `reclaim` exige `block.timestamp > expiry`, donc ≥ 15 minutes. Aucune séquence atomique n'existe. Un flash loan déposé sur l'escrow ne ferait qu'offrir un excédent à voler, sans chemin de retour. **La primitive pertinente ici est le front-run**, pas le flash loan : deux trouvailles reposent sur l'ordonnancement mempool. |
| **SC05** | Validation des entrées | les 8 paramètres de `open` `:110-148` | Signalé **par sa conséquence**, jamais à nu. `agent = address(0)` piège la caution à jamais (`honor` et `reclaim` révertent tous deux sur l'USDC réel) ; `beneficiary = address(0)` rend le mandat insaisissable et rembourse le fautif ; `beneficiary = address(escrow)` fabrique un excédent capturable. Le défaut n'est pas le `require` manquant, c'est l'état terminal irrécupérable. |
| **SC06** | Appels externes non vérifiés | les trois `safeTransfer` `:163`, `:164`, `:181`, `:197` | **Le problème est l'inverse du nom de la catégorie.** `SafeERC20` révèle bien en cas d'échec — rien n'est « non vérifié ». Le défaut est qu'un transfert qui révèle **bloque la transition d'état** : le modèle *push* fait dépendre la sortie d'un mandat du bon vouloir du destinataire. Un modèle *pull* rendrait I5 vrai au sens où il est écrit. |
| **SC07** | Erreurs arithmétiques | `fee = (bond * feeBps) / 10_000` `:159`, `totalLocked +=/-=`, `expiry` | **Rien d'exploitable.** La troncature du frais favorise l'agent, jamais le protocole, et plafonne à 1 unité atomique (10⁻⁶ USDC) par mandat. Seuil de frais nul à `bond ≤ 39` unités atomiques, inatteignable : `minBond` vaut 5 000 000 unités. Éluder 1 USDC de frais coûterait ~25 000 mandats. |
| **SC08** | Réentrance | CEI ligne à ligne dans les trois sorties | **Tient.** Le statut est écrit avant chaque transfert (`:157`, `:177`, `:193`) ; une réentrance sur le même `id` meurt sur `NotOpen`. L'USDC n'a pas de hook de réception. Une incohérence **transitoire** existe entre `totalLocked -= bond` et les transferts de `honor`, inexploitable avec l'USDC actuel — mais inverser l'ordre des deux transferts la ferait disparaître gratuitement. |
| **SC09** | Débordements | `uint64 expiry`/`openedAt`, `uint16 feeBps`, `uint256 totalLocked` | **Aucun atteignable.** Solidity 0.8, arithmétique *checked* partout. `uint64(block.timestamp) + duration` : 1,7e9 + ≤ 6,05e5 contre un plafond de 1,8e19. `totalLocked -= bond` ne peut pas passer sous zéro, garanti par I2/I3. |
| **SC10** | Proxy et évolutivité | intégralité du contrat, plus `IERC20 public immutable token` `:34` | **Pas de proxy dans le périmètre** — c'est un choix de conception assumé et il est bon. Mais le risque d'évolutivité est réel et **déplacé** : `immutable` fige l'*adresse* du token, pas son *comportement*, et l'USDC natif est un proxy contrôlé par Circle. Si Circle activait un frais de transfert ou un rebase à la baisse, `balanceOf` tomberait sous `totalLocked` — I1 casse, et le contrat n'a ni détection, ni mode dégradé, ni moyen de correction. |

## Ce que la barrière révèle sur la passe elle-même

Aucune catégorie n'est restée sans réponse. Trois — SC03, SC04, SC10 — sont
sans objet ou sans levier, et c'est un résultat en soi : il n'y aura rien à
trouver en y revenant.

Les deux catégories productives sont **SC01** et **SC02**, ce que le recon
laissait attendre : un escrow à état sans oracle ni AMM concentre ses défauts
dans les rôles et dans les invariants qu'il déclare. C'est aussi ce que
`historic-exploits.md` prédit pour du code jamais audité — le contrôle d'accès
remonte en tête dès que personne n'a encore grep dessus.
