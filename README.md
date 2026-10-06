# Lecteur multipistes (PWA)

Application web installable : lecture synchronisée de pistes Opus depuis Google Drive, boucles par section, cache hors ligne, thèmes sombre / clair / contraste élevé.
Avec les métadonnées du morceau : accords (pop, jazz, Nashville), paroles surlignées mot à mot, carte de structure, mesure et temps, calage des sauts sur la grille.

## Publier sur GitHub Pages
1. Créez un dépôt GitHub (public) et déposez **tout le contenu de ce dossier** à la racine du dépôt.
2. Dépôt > Settings > Pages > « Deploy from a branch » > branche `main`, dossier `/ (root)` > Save.
3. L'adresse sera `https://VOTRE_NOM.github.io/NOM_DU_DEPOT/`.
4. **Clé API Google** : dans « Restrictions relatives aux applications > Sites Web », ajoutez `https://VOTRE_NOM.github.io/*`
   (le navigateur n'envoie que le domaine aux autres sites : une restriction avec le chemin du dépôt risque de bloquer les requêtes).
   Gardez la restriction aux API sur « Google Drive API ».

## Installer
- Android (Chrome) : menu ⋮ > « Installer l'application ».
- iPhone (Safari) : Partager > « Sur l'écran d'accueil ». L'application installée conserve mieux le cache audio.

## Publier une nouvelle version
1. Modifiez le code (ou les fichiers de l'application).
2. Changez le numéro dans **`version.js`** (ex. `1.0.0` -> `1.0.1`). C'est le seul endroit.
3. Si vous avez ajouté un fichier à l'application, ajoutez-le aussi à la liste `SHELL` de `sw.js`.
4. Envoyez sur GitHub. Chez l'utilisateur, une bannière « Une nouvelle version est disponible » apparaît ; la mise à jour se fait quand il clique (pas de coupure en pleine lecture). Réglages > « Vérifier les mises à jour » force la recherche.

## Thèmes
Chaque thème est un objet de variables CSS dans `themes.js` ; aucune couleur n'est écrite en dur dans `styles.css`.
Pour en ajouter un, ajoutez une entrée dans `THEMES` (ou appelez `Themes.register('id', {...})`) : il apparaît automatiquement dans Réglages.
Exemple :
```js
sepia: { label: 'Sépia', scheme: 'light', color: '#f4ecd8', vars: {
  bg: '#f4ecd8', surface: '#fbf6e9', 'surface-2': '#eadfc6', text: '#2b2118', muted: '#5a4a3a', border: '#7a6650',
  accent: '#8a3b12', 'on-accent': '#ffffff', danger: '#a4161a', ok: '#2d6a2d', focus: '#0b5cad', bw: '1px', 'focus-w': '3px' } }
```
Le mode « Automatique » suit le système (sombre, clair, et contraste élevé si le système demande un contraste renforcé).

## Utilisation avec les métadonnées
- **Accords** : accord courant et suivant (avec le nombre de temps avant le changement). Réglages : notation Pop / Jazz / Nashville et niveau Basique / Simple / Complexe.
- **Paroles** : ligne active et mots chantés surlignés ; toucher une ligne saute au début de cette ligne. Source : `lyrics_new_format.json`, sinon `paroles.lrc`.
- **Structure** : carte proportionnelle des sections ; toucher une section règle et active la boucle. « Regrouper les sections identiques » fusionne les tronçons consécutifs de même nom (Chorus, Chorus, Chorus devient Chorus 1) et numérote les répétitions.
- **Calage** (Boucle et calage) : les sauts du curseur se calent sur le temps le plus proche, sur la mesure, ou restent libres. « A ici » / « B ici » règlent la boucle à la position courante (calée de la même façon). ⏮ ⏭ : mesure précédente / suivante.
- **Clavier** : Espace lecture/pause, flèches gauche/droite mesure précédente/suivante.
- Chaque fonctionnalité se masque seule si le fichier correspondant est absent ou illisible.

## Dossiers Drive attendus
`racine/<Artiste - Titre>/` contenant les `.json`, `paroles.lrc`, `original.opus`, un fichier `_termine`, et un sous-dossier `stems/` avec les `.opus` (même commande d'encodage pour tous).

## Fichiers
`index.html`, `styles.css`, `themes.js`, `app.js` (interface + lecteur), `ogg-opus.js` (index Ogg Opus), `drive.js` (Drive + cache IndexedDB), `meta.js` (grille de temps, accords, paroles, sections),
`vendor/opus-decoder.min.js` (décodeur Opus WASM, embarqué pour le hors ligne), `sw.js`, `version.js`, `manifest.webmanifest`, `icons/`.
