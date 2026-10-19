# Mitsubishi Heavy Industries WF-RAC

Cette intégration affiche dans Gladys les climatiseurs **Mitsubishi Heavy
Industries** (MHI) équipés de l'adaptateur Wi-Fi **WF-RAC** (celui de
l'application Smart M-Air), par l'API locale de l'adaptateur, sans cloud.

> **Jamais testé avec un vrai appareil.** Le protocole de l'adaptateur n'est
> pas documenté par le fabricant : l'intégration suit pywfrac et son
> intégration Home Assistant, et n'a été essayée que contre des réponses
> simulées (à partir de trames réelles publiées par ces projets). Vos retours
> sont les bienvenus.

Non officiel, sans lien avec Mitsubishi Heavy Industries.

**Pas pour Mitsubishi Electric** : les climatiseurs Mitsubishi Electric
(MELCloud) sont pris en charge par l'intégration MELCloud du cœur de Gladys.

## Ce que vous obtenez

Un appareil par adaptateur (un par unité intérieure), avec :

| Fonctionnalité                                                             | Type Gladys                           | Commande |
| -------------------------------------------------------------------------- | ------------------------------------- | -------- |
| Marche/arrêt                                                               | climatisation, marche/arrêt           | oui      |
| Mode (automatique, froid, chauffage, déshumidification, ventilation seule) | climatisation, mode                   | oui      |
| Consigne (pas de 0,5 °C)                                                   | climatisation, consigne (°C)          | oui      |
| Ventilation (automatique, 1 à 4)                                           | climatisation, vitesse de ventilation | oui      |
| Volet vertical (balayage, positions 1 à 4)                                 | climatisation, balayage vertical      | oui      |
| Température intérieure                                                     | capteur de température (°C)           | non      |
| Température extérieure                                                     | capteur de température (°C)           | non      |
| Code d'erreur de l'appareil                                                | texte                                 | non      |

La consigne est bornée à la plage de l'appareil pour le mode lu juste avant :
16 à 30 °C en froid, 18 à 30 °C sinon ; les modèles ZT (2025) vont de 10 °C
en chauffage à 33 °C en froid et déshumidification. Une valeur hors plage est
refusée, jamais envoyée.

## Installation

1. Donnez à chaque adaptateur une **adresse IP fixe** dans votre routeur (il
   apparaît souvent sous un nom fait de son adresse MAC).
2. Dans la configuration de l'intégration, saisissez les adresses, séparées
   par des virgules (8 au plus). Le port est 51443 ; l'intégration trouve
   seule si l'adaptateur parle HTTP ou HTTPS.
3. Enregistrez, puis ajoutez les climatiseurs depuis l'onglet **Découverte**.
4. Pour les commander depuis Gladys, activez **Autoriser les commandes**.

Chaque adaptateur est lu toutes les 60 secondes (réglable de 30 s à 10 min),
une requête à la fois, une seconde d'écart au moins : l'adaptateur n'accepte
qu'une connexion à la fois.

## Les commandes et l'enregistrement sur l'adaptateur

Lire l'état ne demande rien. **Écrire** demande que Gladys soit enregistrée
sur l'adaptateur, qui n'a que **quatre places** (l'application Smart M-Air de
chaque téléphone en prend une) et n'en libère aucune toute seule. C'est
pourquoi :

- les commandes sont **désactivées par défaut** : sans l'option, rien n'est
  enregistré sur l'adaptateur ;
- Gladys utilise **un seul identifiant** pour toute l'installation, gardé
  dans son dossier `/data` ; s'il ne peut pas y être gardé, Gladys ne
  s'enregistre pas du tout (chaque redémarrage prendrait une autre place) ;
- elle s'enregistre **une fois** par adaptateur ; après un refus, elle
  réessaie au plus une fois par heure, jamais en boucle ;
- si les quatre places sont prises, elle ne réessaie plus d'elle-même : le
  statut le dit. Retirez une application ou un téléphone dans Smart M-Air,
  puis cliquez sur **Enregistrer Gladys sur les adaptateurs**.

Chaque commande :

- relit l'état du climatiseur juste avant et décide sur cette lecture
  seulement (l'adaptateur reçoit un état complet : une trame faite sur un état
  ancien annulerait ce qui a changé depuis) ;
- part dans les 3,5 secondes après le clic, ou est refusée sans être envoyée
  (« trop lentement : non envoyée ») si l'adaptateur tarde à répondre ;
- vérifie l'option « Autoriser les commandes » à l'arrivée et juste avant
  l'envoi ;
- n'est jamais renvoyée toute seule. Si l'adaptateur ne répond pas après
  l'envoi, le message est « Commande envoyée, sans confirmation » : vérifiez
  l'état quelques secondes plus tard (Gladys relit l'appareil après 5 et 20
  secondes) ;
- n'est pas envoyée si le climatiseur est déjà dans l'état demandé.

Une seule commande à la fois par climatiseur : une seconde, pendant qu'une
première est en cours, est refusée.

**Verrou de 60 secondes.** Après chaque écriture, l'adaptateur réserve
l'écriture à son auteur pendant une minute. Une commande envoyée moins d'une
minute après un usage de l'application Smart M-Air est donc refusée
(« réessayez dans une minute ») ; Gladys n'attend pas et ne réessaie pas.

**Marche/arrêt et « tout éteindre ».** Comme pour MELCloud, la marche/arrêt
est une fonctionnalité de climatisation : une scène ou un assistant vocal qui
« éteint tout » peut éteindre le climatiseur.

Changer de mode ne rallume pas un climatiseur éteint : seul le mode change.

## Limites connues

- Pas de volet horizontal, de 3D auto, d'autonettoyage, de mode « absence »
  (Home Leave), de température de pièce externe, de données de
  fonctionnement ni d'énergie dans cette version.
- Sur certains appareils (signature de bus ancienne), l'adaptateur ne
  remonte pas la position du volet horizontal ni le 3D auto : comme
  l'application et pywfrac, chaque commande les renvoie alors en
  automatique / désactivé.
- Si l'adaptateur répond lentement (plus de 2 à 3 secondes), les commandes
  sont refusées sans être envoyées. Réessayez ; dites-nous si cela arrive
  souvent.
- Une seule installation Gladys par adaptateur est prévue.

## Sécurité

L'API locale n'a **pas de mot de passe** : tout appareil du réseau local peut
lire et, une fois enregistré, commander le climatiseur. Gardez les
adaptateurs sur un **réseau de confiance** (un réseau invités ou un VLAN
dédié est une bonne idée).

Selon son micrologiciel, l'adaptateur parle HTTP ou HTTPS. En HTTPS, son
certificat est auto-signé et sa pile TLS très ancienne : l'intégration
n'en vérifie pas le certificat et accepte les anciennes versions de TLS,
comme pywfrac. Cela ne protège pas contre un appareil qui se ferait passer
pour l'adaptateur sur votre réseau.

L'identifiant de Gladys (opérateur et appareil) est gardé dans `/data`,
jamais écrit dans les journaux, et envoyé seulement aux adaptateurs.

## Crédits

Le protocole est porté en JavaScript depuis
[pywfrac](https://github.com/blues-sechseck/pywfrac) 0.1.10 et
l'intégration Home Assistant
[Mitsubishi-WF-RAC-Integration](https://github.com/blues-sechseck/Mitsubishi-WF-RAC-Integration)
(jeatheak, blues-sechseck, licence MIT), dont la référence du module WF-RAC a
guidé ce travail. Voir `THIRD_PARTY_NOTICES.md`.
