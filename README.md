# ISA Conseils – Présentation & Références professionnelles

Application web d'ISA Conseils (Mali – Guinée) : présentation du cabinet, fiches de renseignement, personnel, partenaires et références professionnelles.

Hébergement : **Netlify**. Base de données : **Neon** (PostgreSQL).

## Fonctionnalités

- Présentation du cabinet, fiches de renseignement Mali et Guinée, personnel du bureau
- Logos des projets et bailleurs de fonds
- Références professionnelles, avec recherche et filtres par catégorie, pays et financement
- Impression et export Word de chaque onglet
- Espace administrateur : les modifications sont enregistrées en ligne et visibles immédiatement par tous

## Organisation des fichiers

| Fichier | Rôle |
|---|---|
| `public/index.html` | Le site (contenu initial intégré, remplacé par la version en ligne dès qu'elle existe) |
| `netlify/functions/api.mjs` | Le serveur (API) qui lit et écrit dans Neon |
| `netlify.toml` | Configuration Netlify |

## Mise en place (une seule fois)

1. **Neon** : créez un projet sur https://neon.tech et copiez la *connection string*.
2. **Netlify** : *Add new site → Import an existing project → GitHub*, puis choisissez ce dépôt. Laissez les réglages proposés.
3. Dans Netlify, ouvrez *Site configuration → Environment variables* et ajoutez :
   - `DATABASE_URL` : la connection string Neon
   - `ADMIN_INITIAL_PASSWORD` : un mot de passe pour le premier compte `admin`
4. Relancez le déploiement (*Deploys → Trigger deploy*).

Les tables sont créées automatiquement au premier appel.

## Espace administrateur

Ajoutez `#admin` à la fin de l'adresse du site.

- **Première connexion** : identifiant `admin` et le mot de passe `ADMIN_INITIAL_PASSWORD`. Le site demande ensuite d'en choisir un nouveau.
- Les autres administrateurs se créent dans le menu **Administrateurs**. Les comptes fonctionnent depuis n'importe quel ordinateur.
- **Enregistrer** publie immédiatement les modifications pour tous les visiteurs.
- Si deux administrateurs modifient en même temps, le site prévient avant d'écraser quoi que ce soit.
- **Exporter** permet de télécharger une sauvegarde des données (fichier `.json`), et **Importer** de la restaurer.
