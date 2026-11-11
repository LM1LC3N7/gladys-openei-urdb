# Tarifs d’électricité américains (OpenEI URDB)

Intégration non officielle, sans lien avec OpenEI, NREL ni aucun fournisseur.
Elle calcule dans Gladys le coût de votre consommation d’électricité avec le
tarif de votre fournisseur américain, lu dans l’**Utility Rate Database**
(URDB) d’OpenEI : la base publique des tarifs d’environ 3 700 fournisseurs des
États-Unis (heures pleines et creuses, saisons, paliers, abonnement, frais de
puissance), tenue pour le département de l’Énergie (données sous CC0).

Elle ajoute des **modèles de contrat** dans Énergie > Contrats (un par fuseau
horaire américain), calculés par l’intégration (mode « délégué » de Gladys) :
vous saisissez l’identifiant de votre tarif URDB dans le contrat, l’intégration
lit ce tarif et renvoie le coût de chaque demi-heure relevée par votre
compteur.

Essayée contre la vraie API URDB (version 7, `DEMO_KEY`) le 2026-11-11 avec
trois vrais tarifs (PG&E E-TOU-C et E-1, APS R-3), avec le faux Gladys du SDK,
et dans un Gladys 5.3 de test sous Docker (un contrat créé sur le tarif
E-TOU-C, son prix actuel lu) ; jamais testée avec un vrai Gladys à la maison,
sur un vrai compteur et une vraie facture.

## Mise en route

1. Demandez une clé d’API gratuite sur la page d’inscription d’OpenEI
   (<https://openei.org/services/api/signup/>). Pour un premier essai,
   `DEMO_KEY` fonctionne aussi, mais elle est partagée et limitée à environ
   10 requêtes par heure.
2. Installez l’intégration, saisissez la clé dans sa configuration. La clé est
   gardée par Gladys dans sa base, jamais réaffichée, envoyée seulement à
   `api.openei.org` (dans un en-tête de requête, jamais dans une adresse),
   jamais écrite dans les journaux, le statut ni `/data`.
3. Trouvez l’identifiant de votre tarif : le bouton **Chercher des tarifs**
   liste les tarifs approuvés en vigueur pour un code postal américain à
   5 chiffres (résidentiels par défaut), identifiant d’abord. Vous pouvez aussi
   chercher sur <https://apps.openei.org/USURDB/> : l’identifiant est la fin de
   l’adresse de la page du tarif (24 caractères, par exemple
   `69de6fa62aa9e9994f0ed2bd`) ; l’adresse entière est acceptée aussi. Vérifiez
   le nom sur votre facture : un fournisseur a souvent plusieurs régions et
   offres.
4. Dans **Énergie > Contrats**, créez un contrat sur votre compteur électrique
   avec le modèle **Tarif OpenEI URDB** de votre fuseau (Est, Centre,
   Rocheuses, Arizona sans heure d’été, Pacifique, Alaska, Hawaï), saisissez
   l’identifiant et l’abonnement (ci-dessous). Le fuseau du contrat doit être
   celui de votre fournisseur : les heures des grilles URDB sont ses heures
   locales.
5. Le statut de l’intégration affiche chaque tarif utilisé : son nom, le
   fournisseur, sa date d’entrée en vigueur, la date de lecture, ce que Gladys
   ne calcule pas, et son abonnement.

## Ce qui est calculé

Pour chaque demi-heure, à l’heure locale du contrat :

- **Heures et saisons** : la période de la grille URDB pour ce mois et cette
  heure, la grille du week-end le samedi et le dimanche. Les changements
  d’heure suivent le fuseau du contrat (l’heure répétée de novembre est
  comptée comme cette heure locale, deux fois).
- **Paliers** : jugés sur les kWh de la période de facturation avant cette
  demi-heure (Gladys les envoie ; la période commence le jour fixé dans le
  contrat). Une demi-heure à cheval sur une borne est partagée au prorata. Une
  borne en « kWh daily » (les allocations de base californiennes) est
  multipliée par les jours de la période de facturation, comptés dans la
  validité du contrat (un contrat qui commence en cours de période a les jours
  qu’il couvre). Avec des heures pleines et creuses, les paliers comptent tous
  les kWh de la période, toutes plages confondues.
- **Prix** = prix + ajustement du palier, plus l’ajustement mensuel de
  combustible quand URDB en a un, en $/kWh. Le coût renvoyé à Gladys est
  l’énergie seule.
- **Abonnement** : Gladys le calcule lui-même d’après le contrat. URDB le
  donne par jour, par mois ou par an : le statut l’affiche, saisissez-le dans
  le champ « Abonnement par jour » ou « Abonnement par mois » du contrat (un
  abonnement annuel est affiché divisé par 12).

Le **prix actuel** (tableau de bord, scènes) est le prix de la plage en cours
pour les kWh déjà comptés dans la période de facturation, avec l’heure du
prochain changement de plage et son prix. Il ne peut pas prévoir un changement
de palier dû à la consommation à venir.

## Ce qui n’est pas calculé : dit, jamais imité

Gladys calcule un contrat délégué demi-heure par demi-heure ; certaines parts
d’un tarif américain n’entrent pas dans ce modèle. Elles sont **laissées hors
du coût** et listées dans le statut (« non calculé par Gladys ») :

- **Frais de puissance appelée** ($/kW de pointe : `demandratestructure`,
  `flatdemandstructure` mensuels, puissance coïncidente). Ils dépendent de la
  pointe de toute la période de facturation, qu’une demi-heure calculée seule
  ne peut pas connaître. Votre facture dépassera le coût de Gladys de ces
  frais.
- **Facture minimale** (`mincharge`).
- **Jours fériés** : URDB n’a pas de calendrier des jours fériés ; un jour
  férié est compté comme les autres jours de sa semaine (prix de semaine pour
  un férié en semaine).
- **Revente** (net metering, prix `sell`) : Gladys ne calcule que la
  consommation.
- Les taxes et frais locaux qu’URDB ne liste pas.

Certains tarifs sont **refusés** (aucun coût plutôt qu’un coût faux, avec la
raison dans le statut) : paliers bornés en kWh par kW de puissance
(« kWh/kW »), un prix sous 0 ou au-dessus de 10 $/kWh (erreur de données),
une grille qui ne pointe sur aucune période, un tarif sans prix de l’énergie,
un tarif hors des États-Unis. Gladys affiche alors ces demi-heures sans coût
et redemande plus tard.

## Fraîcheur des données

URDB est tenue à la main : un tarif peut avoir **plusieurs années** ou avoir
été remplacé par un plus récent, sous un autre identifiant. Le statut affiche
la date d’entrée en vigueur de chaque tarif (« en vigueur depuis ») et, quand
URDB en a une, sa date de fin. Quand votre fournisseur change ses prix,
cherchez le nouvel identifiant et créez un nouveau contrat à partir de cette
date.

Chaque tarif est lu quand un contrat en a besoin, puis **une fois par jour au
plus**, et gardé dans `/data` avec sa date de lecture : un redémarrage (avec `/data`
lisible), une panne d’OpenEI ou le quota n’arrêtent jamais le calcul d’un
tarif déjà lu.

## Quota et erreurs

- OpenEI limite les requêtes par clé et par heure (`DEMO_KEY` : environ 10).
  L’intégration envoie une requête à la fois, à 2 secondes d’écart au moins,
  une par tarif et par jour, plus une par clic sur un bouton. Un **429**, une
  réponse « over rate limit » ou un quota à 0 mettent toutes les requêtes en
  pause (une heure, doublée, jusqu’à 6 heures ; `Retry-After` respecté) ; une
  erreur du serveur met en pause une minute, doublée. La pause survit à un
  redémarrage.
- Une **clé refusée** par OpenEI (`API_KEY_INVALID`, `API_KEY_DISABLED`…)
  arrête toutes les requêtes envoyées d’elles-mêmes jusqu’à l’enregistrement
  d’une autre clé ou un **test** réussi. Un autre 403 ou un 401 n’est pas un
  refus. Après un redémarrage, le refus est reconnu par une empreinte de
  8 bits de la clé (jamais la clé) : une clé différente a 1 chance sur 256
  d’être prise pour la clé refusée au redémarrage ; le bouton de test lève le
  refus.
- Un tarif illisible est redemandé 10 minutes plus tard, délai doublé jusqu’à
  6 heures. Son calcul échoue en attendant (Gladys réessaie) ; un tarif déjà lu
  continue d’être calculé.
- Le bouton **Tester** envoie au plus une requête par clic, et aucune quand la
  clé a été acceptée il y a moins de 10 minutes et qu’aucun tarif n’est à
  relire.

## Données et licence

Données des tarifs : Utility Rate Database, OpenEI (NREL, données recueillies
pour le département de l’Énergie des États-Unis), sous **CC0** (dédicace au
domaine public). Cette intégration est sous licence Apache 2.0 ; voir
`THIRD_PARTY_NOTICES.md`.
