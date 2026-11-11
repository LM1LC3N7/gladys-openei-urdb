// -----------------------------------------------------------------------------
// Every text shown to the user (status, buttons), in English and French.
// Never the key, never a raw answer of the source: only codes checked by the
// code and texts cleaned by src/tariff.js.
// -----------------------------------------------------------------------------

const t = (en, fr) => ({ en, fr });

/** What a tariff charges that Gladys does not compute here. */
export const NOT_COMPUTED = {
  demand: t('demand charges ($/kW)', 'frais de puissance appelée ($/kW)'),
  flat_demand: t('monthly demand charges ($/kW)', 'frais de puissance mensuels ($/kW)'),
  coincident: t('coincident demand charges', 'frais de puissance coïncidente'),
  min_charge: t('minimum bill', 'facture minimale'),
};

/** Why a tariff cannot be priced (no cost rather than a wrong one). */
export const PROBLEMS = {
  format: t('unreadable URDB answer', 'réponse URDB illisible'),
  not_found: t('label not found in URDB', 'identifiant absent d’URDB'),
  country: t('tariff outside the USA', 'tarif hors des États-Unis'),
  no_energy: t('no energy charge in this tariff', 'pas de prix de l’énergie dans ce tarif'),
  structure: t('tiers not usable', 'paliers inutilisables'),
  schedule: t('time-of-use schedule not usable', 'grille horaire inutilisable'),
  tier_unit: t(
    'tiers bounded in kWh per kW of demand (not supported)',
    'paliers en kWh par kW de puissance (non pris en charge)',
  ),
  rate_range: t(
    'a rate below 0 or above 10 $/kWh (data error)',
    'un prix sous 0 ou au-dessus de 10 $/kWh (erreur de données)',
  ),
  label: t('the contract has no valid URDB label', 'le contrat n’a pas d’identifiant URDB valide'),
};

/** Why a read failed (codes of src/http.js). */
export const FAILURES = {
  network: t('OpenEI unreachable', 'OpenEI injoignable'),
  timeout: t('OpenEI did not answer in time', 'OpenEI n’a pas répondu à temps'),
  http: t('unexpected answer from OpenEI', 'réponse inattendue d’OpenEI'),
  server: t('OpenEI server error', 'erreur du serveur OpenEI'),
  redirect: t('unexpected redirection', 'redirection inattendue'),
  too_large: t('answer too large', 'réponse trop grande'),
  encoding: t('unreadable answer', 'réponse illisible'),
  aborted: t('read stopped', 'lecture arrêtée'),
  rate_limited: t('OpenEI quota reached', 'quota OpenEI atteint'),
  refused: t('key refused', 'clé refusée'),
};

const join = (parts, lang) => parts.map((p) => (typeof p === 'string' ? p : p[lang])).join('');

/** Builds a multi-language text from parts (strings are the same in both languages). */
export function compose(...parts) {
  return { en: join(parts, 'en'), fr: join(parts, 'fr') };
}

/** `HH:MM UTC` of an instant. */
export function utcTime(ms) {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

export const T = {
  noKey: t(
    'Enter your free OpenEI API key in the configuration.',
    'Saisissez votre clé d’API OpenEI gratuite dans la configuration.',
  ),
  badKey: t(
    'The API key typed is not in the expected form (letters and digits, no space): nothing sent.',
    'La clé d’API saisie n’a pas la forme attendue (lettres et chiffres, sans espace) : rien n’est envoyé.',
  ),
  refused: (gateway) =>
    t(
      `OpenEI refused the API key (${gateway}): no request is sent until a new key is saved or the Test button succeeds.`,
      `OpenEI a refusé la clé d’API (${gateway}) : aucune requête ne part avant l’enregistrement d’une nouvelle clé ou un test réussi.`,
    ),
  paused: (until) =>
    t(
      `OpenEI quota reached or server unavailable: paused until ${utcTime(until)}; the stored tariffs keep pricing.`,
      `Quota OpenEI atteint ou serveur indisponible : en pause jusqu’à ${utcTime(until)} ; les tarifs gardés continuent de calculer les coûts.`,
    ),
  configUnread: (ms) =>
    t(
      `The configuration could not be read from Gladys: new try in ${Math.round(ms / 1000)} s.`,
      `La configuration n’a pas pu être lue depuis Gladys : nouvel essai dans ${Math.round(ms / 1000)} s.`,
    ),
  dataUnreadable: t(
    ' /data cannot be read: nothing is saved until it can.',
    ' /data est illisible : rien n’est enregistré tant qu’il le reste.',
  ),
  contractsUnread: t(
    'The contracts could not be read from Gladys (new try in 5 min).',
    'Les contrats n’ont pas pu être lus depuis Gladys (nouvel essai dans 5 min).',
  ),
  noContract: t(
    'Ready. No energy contract uses an OpenEI URDB template yet: create one in Energy > Contracts with the label of your tariff (button “Find tariffs”).',
    'Prêt. Aucun contrat d’énergie n’utilise encore un modèle OpenEI URDB : créez-en un dans Énergie > Contrats avec l’identifiant de votre tarif (bouton « Chercher des tarifs »).',
  ),
  waiting: t('not read yet', 'pas encore lu'),
  colon: t(': ', ' : '),
  semicolon: t('; ', ' ; '),
  starting: t('Starting: reading the contracts.', 'Démarrage : lecture des contrats.'),
  more: (n) => t(` (+${n} more)`, ` (+${n} autres)`),
  since: t('in effect since', 'en vigueur depuis'),
  ended: t('ended', 'terminé le'),
  read: t('read', 'lu le'),
  notComputed: t('not computed by Gladys', 'non calculé par Gladys'),
  fixed: (amount, units) =>
    t(
      `fixed charge ${amount} ${units}: type it in the contract`,
      `abonnement ${amount} ${units} : à saisir dans le contrat`,
    ),
  test: {
    ok: (n) =>
      t(
        `Key accepted by OpenEI.${n ? ` ${n} tariff(s) in use, see the status.` : ''}`,
        `Clé acceptée par OpenEI.${n ? ` ${n} tarif(s) utilisé(s), voir le statut.` : ''}`,
      ),
    recent: (at, n) =>
      t(
        `Key accepted by OpenEI at ${utcTime(at)}; ${n} tariff(s) in use, none due: nothing sent.`,
        `Clé acceptée par OpenEI à ${utcTime(at)} ; ${n} tarif(s) utilisé(s), aucun à relire : rien envoyé.`,
      ),
    failed: (failure) => compose(t('Test failed: ', 'Échec du test : '), failure, '.'),
    refused: (gateway) =>
      t(
        `OpenEI refused the API key (${gateway}). Check it, save it, then test again.`,
        `OpenEI a refusé la clé d’API (${gateway}). Vérifiez-la, enregistrez-la, puis testez de nouveau.`,
      ),
  },
  find: {
    badZip: t('Type a 5-digit US ZIP code.', 'Saisissez un code postal américain à 5 chiffres.'),
    none: (zip) =>
      t(
        `No approved tariff in effect found for ${zip}. Try the Commercial sector or the OpenEI site.`,
        `Aucun tarif approuvé en vigueur trouvé pour ${zip}. Essayez le secteur Commercial ou le site d’OpenEI.`,
      ),
    header: (n, zip, more) =>
      t(
        `${n} tariff(s) in effect for ${zip}${more ? ` (first ${n} shown)` : ''}, label first: `,
        `${n} tarif(s) en vigueur pour ${zip}${more ? ` (les ${n} premiers)` : ''}, identifiant d’abord : `,
      ),
    failed: (failure) => compose(t('Search failed: ', 'Échec de la recherche : '), failure, '.'),
  },
};
