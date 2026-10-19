// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and option names, the status of
// the integration, the answers of the buttons and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = (suffix) =>
  both(`Mitsubishi air conditioner ${suffix}`, `Climatiseur Mitsubishi ${suffix}`);

export const FEATURE_NAMES = {
  [FEATURES.POWER]: both('On/off', 'Marche/arrêt'),
  [FEATURES.MODE]: both('Mode', 'Mode'),
  [FEATURES.SETPOINT]: both('Setpoint', 'Consigne'),
  [FEATURES.FAN]: both('Fan speed', 'Ventilation'),
  [FEATURES.SWING]: both('Vertical vane', 'Volet vertical'),
  [FEATURES.INDOOR]: both('Indoor temperature', 'Température intérieure'),
  [FEATURES.OUTDOOR]: both('Outdoor temperature', 'Température extérieure'),
  [FEATURES.ERROR]: both('Error code', "Code d'erreur"),
};

export const MODE_NAMES = {
  AUTO: both('Automatic', 'Automatique'),
  COOL: both('Cooling', 'Froid'),
  HEAT: both('Heating', 'Chauffage'),
  DRY: both('Drying', 'Déshumidification'),
  FAN: both('Fan only', 'Ventilation seule'),
};

export const FAN_NAMES = {
  AUTO: both('Automatic', 'Automatique'),
  QUIET: both('Quiet (1)', 'Silencieux (1)'),
  LOW: both('Low (2)', 'Faible (2)'),
  MEDIUM: both('Medium (3)', 'Moyenne (3)'),
  HIGH: both('High (4)', 'Forte (4)'),
};

export const SWING_NAMES = {
  SWING: both('Swing (automatic)', 'Balayage (automatique)'),
  POSITION_1: both('Position 1 (highest)', 'Position 1 (la plus haute)'),
  POSITION_2: both('Position 2', 'Position 2'),
  POSITION_3: both('Position 3', 'Position 3'),
  POSITION_4: both('Position 4 (lowest)', 'Position 4 (la plus basse)'),
};

export const ERROR_TEXTS = {
  none: both('No error', 'Aucune erreur'),
};

/** The integration status, the buttons and the logs a user may read. */
export const T = {
  noAddress: both(
    'Enter the IP address of the WF-RAC adapter of each air conditioner, then save.',
    "Saisissez l'adresse IP de l'adaptateur WF-RAC de chaque climatiseur, puis enregistrez.",
  ),
  invalid: (typed) =>
    both(
      `Invalid address(es) ignored: ${typed} (an IPv4 address or a host name, optional port).`,
      `Adresse(s) invalide(s) ignorée(s) : ${typed} (une adresse IPv4 ou un nom d'hôte, port facultatif).`,
    ),
  dropped: (count) =>
    both(
      `${count} address(es) ignored: 8 adapters at most.`,
      `${count} adresse(s) ignorée(s) : 8 adaptateurs au plus.`,
    ),
  connecting: both('Reading the adapters…', 'Lecture des adaptateurs…'),
  connected: (count, total) =>
    both(
      `Connected: ${count} of ${total} adapter${total === 1 ? '' : 's'} answering.`,
      `Connecté : ${count} adaptateur${count === 1 ? '' : 's'} sur ${total} répond${count === 1 ? '' : 'ent'}.`,
    ),
  unreachable: (names) => both(`No answer from: ${names}.`, `Pas de réponse de : ${names}.`),
  rateLimited: (names) =>
    both(
      `Paused, the adapter asked to slow down (HTTP 429): ${names}.`,
      `En pause, l'adaptateur a demandé de ralentir (HTTP 429) : ${names}.`,
    ),
  noIds: both(
    'Commands are allowed, but the integration cannot keep its identifier in /data: it does not register on the adapters (each restart would take another of their four slots), so commands will be refused.',
    "Les commandes sont autorisées, mais l'intégration ne peut pas garder son identifiant dans /data : elle ne s'enregistre pas sur les adaptateurs (chaque redémarrage prendrait une autre de leurs quatre places), les commandes seront donc refusées.",
  ),
  idsCorrupt: both(
    'The identifier file of Gladys in /data is unreadable: it was set aside (.corrupt) and Gladys no longer registers on the adapters, so as not to take another of their four slots. To start again with a new identifier, allow the commands and click "Register Gladys on the adapters" (remove the old one in Smart M-Air if you can).',
    "Le fichier d'identifiant de Gladys dans /data est illisible : il a été mis de côté (.corrupt) et Gladys ne s'enregistre plus sur les adaptateurs, pour ne pas prendre une autre de leurs quatre places. Pour repartir avec un nouvel identifiant, autorisez les commandes et cliquez sur « Enregistrer Gladys sur les adaptateurs » (retirez l'ancien dans Smart M-Air si vous le pouvez).",
  ),
  duplicate: (pairs) =>
    both(
      `Same adapter typed twice, read once: ${pairs}.`,
      `Même adaptateur saisi deux fois, lu une seule fois : ${pairs}.`,
    ),
  tableFull: (names) =>
    both(
      `The adapter has no free slot for Gladys (4 apps or controllers registered): ${names}. Remove one in the Smart M-Air app, then click "Register Gladys on the adapters".`,
      `L'adaptateur n'a plus de place pour Gladys (4 applications ou contrôleurs enregistrés) : ${names}. Retirez-en un dans l'application Smart M-Air, puis cliquez sur « Enregistrer Gladys sur les adaptateurs ».`,
    ),
  register: {
    disabled: both(
      'Turn on "Allow the commands" and save first: Gladys only registers on the adapters to send commands.',
      "Activez d'abord « Autoriser les commandes » et enregistrez : Gladys ne s'enregistre sur les adaptateurs que pour envoyer des commandes.",
    ),
    cooldown: both('Tried less than 30 s ago.', 'Essayé il y a moins de 30 s.'),
    none: both(
      'No adapter answered yet: check the addresses, then try again.',
      "Aucun adaptateur n'a encore répondu : vérifiez les adresses, puis réessayez.",
    ),
    newIds: both(
      'New identifier created (the unreadable one was set aside).',
      "Nouvel identifiant créé (l'illisible a été mis de côté).",
    ),
    ok: (name) => both(`${name}: registered.`, `${name} : enregistré.`),
    full: (name) =>
      both(
        `${name}: no free slot (remove an app in Smart M-Air).`,
        `${name} : plus de place (retirez une application dans Smart M-Air).`,
      ),
    failed: (name, reason) => both(`${name}: failed (${reason}).`, `${name} : échec (${reason}).`),
  },
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
    waiting: (name, wait) =>
      both(
        `${name}: failed, next try in ${wait.en} (not read sooner).`,
        `${name} : en échec, nouvel essai dans ${wait.fr} (pas lu plus tôt).`,
      ),
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    "Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l'intégration.",
  ),
  unknownUnit: both(
    'This air conditioner is not read by the integration right now (adapter not answering, or another adapter at its address): not sent.',
    "Ce climatiseur n'est pas lu par l'intégration en ce moment (adaptateur sans réponse, ou autre adaptateur à son adresse) : non envoyée.",
  ),
  badValue: both('Invalid value: not sent.', 'Valeur invalide : non envoyée.'),
  outOfRange: (min, max, mode) =>
    both(
      `The setpoint must be between ${min} and ${max} °C${mode ? ` in ${mode.en.toLowerCase()} mode` : ''}: not sent.`,
      `La consigne doit être entre ${min} et ${max} °C${mode ? ` en mode ${mode.fr.toLowerCase()}` : ''} : non envoyée.`,
    ),
  paused: (wait) =>
    both(
      `The adapter asked to slow down: commands paused for ${wait.en}.`,
      `L'adaptateur a demandé de ralentir : commandes en pause pendant ${wait.fr}.`,
    ),
  stillRunning: both(
    'Another command to this air conditioner is still running: not sent.',
    'Une autre commande vers ce climatiseur est encore en cours : non envoyée.',
  ),
  tooSlow: both(
    'The adapter answered too slowly to send the command in time: not sent. Try again.',
    "L'adaptateur a répondu trop lentement pour envoyer la commande à temps : non envoyée. Réessayez.",
  ),
  unknownState: (reason) =>
    both(
      `The state of the air conditioner could not be read just before (${reason}): command not sent.`,
      `L'état du climatiseur n'a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  incompleteState: both(
    'The adapter gave an incomplete state (a value this integration cannot read): command not sent.',
    "L'adaptateur a donné un état incomplet (une valeur que l'intégration ne sait pas lire) : commande non envoyée.",
  ),
  tableFull: both(
    'The adapter has no free slot for Gladys: remove an app in Smart M-Air, then click "Register Gladys on the adapters". Not sent.',
    "L'adaptateur n'a plus de place pour Gladys : retirez une application dans Smart M-Air, puis cliquez sur « Enregistrer Gladys sur les adaptateurs ». Non envoyée.",
  ),
  noIds: both(
    'The integration cannot keep its identifier in /data, so it is not registered on the adapter: not sent.',
    "L'intégration ne peut pas garder son identifiant dans /data, elle n'est donc pas enregistrée sur l'adaptateur : non envoyée.",
  ),
  notSent: (reason) =>
    both(
      `The adapter could not be reached (${reason}): command not sent.`,
      `L'adaptateur n'a pas pu être joint (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The adapter refused the command (${reason}).`,
      `L'adaptateur a refusé la commande (${reason}).`,
    ),
  locked: both(
    'The adapter declined the command: another app (Smart M-Air, another controller) wrote less than a minute ago, or the unit refused it. Try again in a minute.',
    "L'adaptateur a refusé la commande : une autre application (Smart M-Air, un autre contrôleur) a écrit il y a moins d'une minute, ou l'appareil l'a refusée. Réessayez dans une minute.",
  ),
  unverified: both(
    'Frame not verifiable (its CRC does not match): not sent.',
    'Trame non vérifiable (son CRC ne correspond pas) : non envoyée.',
  ),
  previousPending: both(
    'The previous command is not visible yet: not sent, try again in a few seconds.',
    "La commande précédente n'est pas encore visible : non envoyée, réessayez dans quelques secondes.",
  ),
  notRegistered: both(
    'The adapter does not know Gladys (not registered, or refused): the registration is tried again within the hour, or click "Register Gladys on the adapters". Not applied.',
    "L'adaptateur ne connaît pas Gladys (non enregistrée, ou refus) : l'enregistrement est retenté dans l'heure, ou cliquez sur « Enregistrer Gladys sur les adaptateurs ». Non appliquée.",
  ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the air conditioner in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l'état du climatiseur dans quelques secondes.`,
    ),
};
