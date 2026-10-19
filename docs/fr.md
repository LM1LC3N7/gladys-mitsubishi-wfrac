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
en chauffage à 33 °C en froid et déshumidification. En ventilation seule, la
consigne vaut pour le mode suivant : la plage est celle de tous les modes
(16 à 30 °C, 10 à 33 °C sur ZT). Une valeur hors plage est refusée, jamais
envoyée. Un changement de mode ramène la consigne lue dans la plage du
nouveau mode et l'envoie avec lui (par exemple 10 °C en chauffage devient
16 °C en passant en froid).

## Installation

1. Donnez à chaque adaptateur une **adresse IP fixe** dans votre routeur (il
   apparaît souvent sous un nom fait de son adresse MAC).
2. Dans la configuration de l'intégration, saisissez les adresses, séparées
   par des virgules (8 au plus). Le port est 51443 ; l'intégration trouve
   seule si l'adaptateur parle HTTPS (essayé d'abord) ou HTTP. Un même
   adaptateur saisi deux fois (adresse IP et nom) n'est lu qu'une fois.
3. Enregistrez, puis ajoutez les climatiseurs depuis l'onglet **Découverte**.
4. Pour les commander depuis Gladys, activez **Autoriser les commandes**.

Chaque adaptateur est lu toutes les 60 secondes (réglable de 30 s à 10 min),
une requête à la fois, une seconde d'écart au moins : l'adaptateur n'accepte
qu'une connexion à la fois. Après un échec, l'adaptateur est relu après 30 s,
1, 2 puis 5 min, jamais plus tôt que l'intervalle ; le bouton **Tester la
connexion** respecte ce délai et indique le prochain essai.

## Les commandes et l'enregistrement sur l'adaptateur

Lire l'état ne demande rien. **Écrire** demande que Gladys soit enregistrée
sur l'adaptateur, qui n'a que **quatre places** (l'application Smart M-Air de
chaque téléphone en prend une) et n'en libère aucune toute seule. C'est
pourquoi :

- les commandes sont **désactivées par défaut** : sans l'option, rien n'est
  enregistré sur l'adaptateur ;
- Gladys utilise **un seul identifiant** pour toute l'installation, écrit une
  fois dans son propre fichier de `/data` ; s'il ne peut pas y être écrit,
  Gladys ne s'enregistre pas du tout (chaque redémarrage prendrait une autre
  place). Si ce fichier devient illisible, il est mis de côté, Gladys ne s'en
  crée pas un autre toute seule et le statut le dit : le bouton **Enregistrer
  Gladys sur les adaptateurs** en crée un nouveau à votre demande (l'ancienne
  place reste prise, voir « Désinstaller ») ;
- elle s'enregistre **une fois** par adaptateur ; après un refus, elle
  réessaie au plus une fois par heure, jamais en boucle ;
- si les quatre places sont prises (l'adaptateur compte quatre comptes), elle
  ne réessaie plus d'elle-même : le statut le dit. Retirez une application
  ou un téléphone dans Smart M-Air, puis cliquez sur **Enregistrer Gladys sur
  les adaptateurs**.

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
- n'est pas envoyée si le climatiseur est déjà dans l'état demandé ;
- est refusée si la trame lue n'est pas vérifiable (son CRC ne correspond
  pas), ou si l'adaptateur ne donne pas un état frais (résultat 0) ;
- est refusée, sans être envoyée, si la commande précédente sur un autre
  réglage du même climatiseur n'est pas encore visible dans l'état relu
  (« réessayez dans quelques secondes ») : la trame annulerait cette
  commande. Gladys ne complète jamais l'état relu avec sa mémoire.

Une seule commande à la fois par climatiseur : une seconde, pendant qu'une
première est en cours, est refusée.

**Verrou de 60 secondes.** Chaque écriture réussie réserve l'écriture à son
auteur (l'appareil qui l'a envoyée) pendant une minute ; les lectures ne sont
pas concernées. Donc : une commande Gladys envoyée moins d'une minute après
un réglage fait depuis l'application Smart M-Air (ou un autre contrôleur Wi-Fi)
est refusée (« réessayez dans une minute ») ; Gladys n'attend pas et ne
réessaie pas. Dans l'autre sens, l'application est refusée pendant la minute
qui suit chaque commande de Gladys. La télécommande infrarouge ne passe pas
par l'adaptateur et n'est pas concernée.

**Marche/arrêt et « tout éteindre ».** Comme pour MELCloud, la marche/arrêt
est une fonctionnalité de climatisation, pas un interrupteur. Selon ce qui
l'expose (assistant vocal, HomeKit, Google Home, MCP…), un « éteins tout »
peut atteindre le climatiseur : vérifiez vos scènes et assistants si vous ne
le voulez pas.

Changer de mode ne rallume pas un climatiseur éteint : seul le mode change.

## Limites connues

- Pas de volet horizontal, de 3D auto, d'autonettoyage, de mode « absence »
  (Home Leave), de température de pièce externe, de données de
  fonctionnement ni d'énergie dans cette version.
- Sur certains appareils (signature de bus ancienne), l'adaptateur ne
  remonte pas la position du volet horizontal ni le 3D auto : comme
  l'application et pywfrac, chaque commande les renvoie alors en
  automatique / désactivé.
- Une valeur qui ne peut pas être lue (consigne hors de 10 à 33 °C, capteur de
  température absent ou coupé) est laissée inconnue, jamais publiée.
- Si l'adaptateur répond lentement (plus de 2 à 3 secondes), les commandes
  sont refusées sans être envoyées. Réessayez ; dites-nous si cela arrive
  souvent.
- Une seule installation Gladys par adaptateur est prévue.

## Désinstaller

La place prise par Gladys sur chaque adaptateur reste occupée après la
désinstallation : cette version n'a pas encore de bouton pour la libérer.
Avant de désinstaller (ou pour libérer l'ancienne place après un fichier
d'identifiant illisible), retirez l'entrée correspondante dans l'application
Smart M-Air si elle l'affiche (non vérifié : un client enregistré en local
peut ne pas y apparaître). À défaut, une réinitialisation de l'adaptateur
(voir sa notice) devrait vider sa table de comptes (non vérifié) ; les
téléphones devront alors être appairés de nouveau.

## Sécurité

L'API locale n'a **pas de mot de passe** : tout appareil du réseau local peut
lire et, une fois enregistré, commander le climatiseur. Gardez les
adaptateurs sur un **réseau de confiance** (un réseau invités ou un VLAN
dédié est une bonne idée).

Selon son micrologiciel, l'adaptateur parle HTTP ou HTTPS. En HTTPS, son
certificat est auto-signé et sa pile TLS très ancienne : l'intégration n'en
vérifie pas le certificat, accepte TLS 1.0 et plus, le niveau de sécurité 0
d'OpenSSL et l'ancienne renégociation. Cela ne protège pas contre un appareil
qui se ferait passer pour l'adaptateur sur votre réseau. En **HTTP** (les plus
anciens micrologiciels), tout passe en clair sur le réseau, l'identifiant de
Gladys compris.

L'identifiant de Gladys (opérateur et appareil) est gardé dans `/data`,
jamais écrit dans les journaux, et envoyé seulement aux adaptateurs déjà
identifiés : la première requête vers une adresse (qui sert à reconnaître
l'adaptateur) porte un identifiant fictif.

## Crédits

Le protocole est porté en JavaScript depuis
[pywfrac](https://github.com/blues-sechseck/pywfrac) 0.1.10 et
l'intégration Home Assistant
[Mitsubishi-WF-RAC-Integration](https://github.com/blues-sechseck/Mitsubishi-WF-RAC-Integration)
(jeatheak, blues-sechseck, licence MIT), dont la référence du module WF-RAC a
guidé ce travail. Voir `THIRD_PARTY_NOTICES.md`.
