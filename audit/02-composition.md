# Composition et bilan de la chasse

## Ce qui a survécu

| # | Trouvaille | Sévérité | Statut |
|---|---|---|---|
| 01 | I10 n'est appliqué ni par le contrat ni par son test | Haute | prouvé par exécution, **corrigé** |
| 02 | L'`opener` seul dispose d'une autorité de retrait | Haute | réfuteur dédié → **tient**, non corrigé |

## Ce qui est mort, et pourquoi c'est utile de le savoir

| Trouvaille | Trouvée par | Tuée par |
|---|---|---|
| I5 falsifiable — caution piégée à jamais | **les 3 chasseurs** | `reclaim` n'a aucune borne temporelle supérieure et est rejouable indéfiniment ; une blacklist est révocable ; `slash` avant expiration évacue vers le bénéficiaire ; et un agent blacklisté ne peut de toute façon pas bouger ses propres USDC — préjudice marginal nul |
| `feeBps` rétroactif | 2 chasseurs | aucun devis de frais n'est jamais communiqué à l'agent ; `MAX_FEE_BPS` est la seule valeur opposable ; `treasury` est immuable ; et le handler de fuzzing appelle **délibérément** `setFeeBps` entre `open` et `honor` — la lecture au règlement est la sémantique spécifiée |
| `reclaim` plus généreux que `honor` | 1 chasseur | l'agent ne contrôle ni `duration`, ni `confirmations`, ni le moment de l'exécution ; le remboursement intégral est argumenté dans le contrat comme protection anti-séquestration, et la conception inverse serait pire |

**La leçon la plus chère de cette passe** : trois chasseurs indépendants ont
convergé sur une trouvaille fausse. La convergence n'est pas une preuve — c'est
un biais partagé quand tous partent du même recon. Seul un réfuteur mandaté pour
détruire a vu que `reclaim` était rejouable.

## Chaînages tentés

**01 × 02 — confirmé, et 01 est l'accélérateur de 02.** Les deux sont
indépendamment exploitables, mais fusionnés les rôles suppriment l'attente de
`MIN_DURATION` : au lieu d'ouvrir puis d'attendre 901 secondes un `reclaim`, une
clé unique ouvre et saisit **dans la même transaction**. Corriger 01 ne referme
pas 02 ; il en rallonge seulement le délai de 0 à 15 minutes.

**02 × absence de révocation — confirmé, et il aggrave.** `setOpener` permet de
révoquer un opener compromis, mais **les mandats déjà ouverts partent quand
même** : les trois sorties paient une adresse figée à l'ouverture. Et `owner`
n'étant ni transférable ni renonçable, une clé `owner` perdue rend la révocation
impossible. La fenêtre de perte n'est pas bornée par une transaction mais par la
propagation d'une nouvelle adresse de paiement.

**02 × `beneficiary == treasury` — chaînage faible, mais réel.** Le contrat
n'interdit pas au bénéficiaire d'être la trésorerie, et l'outil d'exploitation
`packages/server/src/bin/open-warrant.ts:143` le fait
(`optional('WARRANT_TREASURY', agent)`). Vérifié onchain : le mandat
`0x9d035197a8…`, saisi aujourd'hui, avait `beneficiary == treasury`. Une saisie a
donc réellement versé 100 % de la caution au protocole. I6 reste vrai à la
lettre — aucun frais n'est prélevé — mais l'argument anti-incitation-perverse
qu'il porte devant le jury ne tient plus sur ce chemin. Le mandat de la démo,
lui (`0x23bedc5be1…`, bénéficiaire `0x…bEEF`), est conforme : la documentation
qui le cite est exacte.

**Chaînages cherchés sans succès** : aucun grief exploitable par un inconnu
(`reclaim` ne paie que l'agent enregistré, aucune prime à l'appelant) ; aucune
séquence atomique (toute sortie exige un rôle ou ≥ 15 minutes, donc le flash loan
est inutile) ; aucune réentrance (CEI respecté ligne à ligne, USDC sans hook).

## Piste ouverte, hors périmètre du contrat

`packages/core/src/policy.ts` l'écrit lui-même : un vérificateur qui lève
`UnsupportedCheckError` « n'est pas une garantie, c'est un remboursement
automatique déguisé ». La catégorie d'une action étant **dérivée du calldata**,
la question qui reste est : un agent peut-il orienter son calldata vers une
catégorie dont un vérificateur est non supporté, et s'auto-garantir le
remboursement ? Une partie du problème a été corrigée aujourd'hui — les
post-conditions par défaut ne contiennent plus `nonce_advanced` ni
`native_balance_delta`, indécidables sous exécution sponsorisée. La forme
générale mérite une passe dédiée sur la couverture des vérificateurs.

## Observation de soumission

Les 16 documents de conception — dont celui qui énonce les invariants I1–I10 —
sont dans le répertoire **frère** `../docs/`, hors du dépôt git. Un jury qui
clone le dépôt ne voit que `onboarding-teardown.md` et `transactions.md`. Deux
réfuteurs ont conclu que la source des invariants « n'avait jamais existé ». Si
les invariants sont un argument de soumission, ils doivent être dans le dépôt.
