# Backend du géoportail — Django + GeoDjango + PostgreSQL/PostGIS

Ce dossier remplace l'ancien prototype Flask (conservé dans `../backend_flask_archive/`, vous pouvez le supprimer).
Les routes de l'API, leurs paramètres et leurs réponses sont **identiques** à celles de Flask : le site (`carte.html`,
`assets/js/*`) fonctionne sans modification. En plus : une interface d'administration, des modèles versionnés par migrations,
des tests automatiques, des services de transport éditables et un formulaire de contact qui enregistre vraiment les messages.

```
backend/
├── manage.py                  commandes Django
├── requirements.txt           dépendances Python
├── .env.example               à copier en .env (mot de passe de la base, etc.)
├── geoportail/                configuration du projet (settings.py, urls.py, gdal_windows.py)
└── portail/                   l'application
    ├── models.py              Departement, Commune, Lieu (+ Hebergement, Restaurant, Prestataire), transport, messages
    ├── admin.py               interface d'administration
    ├── api/                   vues REST (views.py), outils PostGIS (outils.py), erreurs JSON
    ├── circuit.py             ordre de visite : plus proche voisin + 2-opt
    ├── migrations/            0001 (tables) et 0002 (départements + index GiST sur geography)
    ├── management/commands/import_data.py    import des fichiers GeoJSON/JSON dans la base
    └── tests/                 33 tests automatiques
```

## 1. Prérequis (Windows)

| Élément | Remarque |
|---|---|
| Python 3.10 ou plus | déjà installé chez vous |
| PostgreSQL 14+ avec **PostGIS** | déjà installé (Stack Builder) |
| **GDAL / GEOS** | indispensable à GeoDjango. Le plus simple : **QGIS** (installé avec ses DLL) ou **OSGeo4W** (« Express Install », paquet *gdal*) |

> **GDAL sous Windows.** `geoportail/gdal_windows.py` cherche tout seul GDAL dans `C:\Program Files\QGIS*` et `C:\OSGeo4W*`.
> Si Django répond *« Could not find the GDAL library »*, ajoutez dans `.env` les deux lignes (adaptez le numéro de version) :
> ```
> GDAL_LIBRARY_PATH=C:\Program Files\QGIS 3.34.0\bin\gdal312.dll
> GEOS_LIBRARY_PATH=C:\Program Files\QGIS 3.34.0\bin\geos_c.dll
> ```
> (le fichier `gdalNNN.dll` existe dans le dossier `bin` de QGIS). Cette détection n'a pas pu être testée sur Windows par son auteur.

## 2. Installation, pas à pas (PowerShell)

```powershell
cd C:\Users\DELL\Desktop\TOURISME\PFC_T2\tourisme\backend

python -m venv .venv                       # un seul environnement : ".venv" (avec le « v » final)
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

copy .env.example .env                     # puis ouvrez .env et mettez VOTRE mot de passe PostgreSQL
notepad .env
```

Créez la base (une seule fois) dans **pgAdmin** ou avec `psql` :

```sql
CREATE DATABASE tourisme_thies;            -- si elle existe déjà (ancienne base Flask), gardez-la : les tables Django s'appellent portail_*
```

Puis :

```powershell
.\.venv\Scripts\python.exe manage.py migrate                 # crée l'extension PostGIS, les tables, les 3 départements, les index
.\.venv\Scripts\python.exe manage.py import_data             # importe lieux, limites, transports (affiche un rapport qualité)
.\.venv\Scripts\python.exe manage.py createsuperuser         # votre compte administrateur
.\.venv\Scripts\python.exe manage.py runserver               # http://127.0.0.1:8000
```

> Astuce : écrire `.\.venv\Scripts\python.exe …` évite les confusions avec un autre environnement virtuel activé par l'éditeur.

À ouvrir dans le navigateur :

| Adresse | Contenu |
|---|---|
| http://127.0.0.1:8000/ | le géoportail (redirige vers `carte.html`) |
| http://127.0.0.1:8000/admin/ | administration : lieux, transport, messages reçus |
| http://127.0.0.1:8000/api/health | état de la base |

Rapport attendu de `import_data` avec vos données : 212 hébergements, 201 restaurants, 32 sites, 23 prestataires (4 sans position),
3 départements, 13 communes (en réalité des **arrondissements**), 2 doublons fusionnés, 7 services et 2 applications de transport.
La ligne *« couverture de la couche communale : 37/268 »* signale que cette couche ne correspond pas aux communes de vos données.

## 3. L'API

| Méthode et chemin | Rôle | Paramètres |
|---|---|---|
| `GET /api/health` | état de la base, effectifs | — |
| `GET /api/lieux` | lieux (GeoJSON) | `categorie` (liste), `departement`, `commune`, `q` |
| `GET /api/autour` | lieux dans un rayon, triés par distance (mètres) | `lat`, `lon`, `rayon` (km), `categories`, `limite` |
| `GET /api/limites/{departements\|communes}` | limites administratives | — |
| `POST /api/circuit` | ordre de visite optimisé | `{"points":[{"lat","lon"}…], "boucle":false}` |
| `GET /api/transports` | services de transport par zone | — |
| `GET /api/applis-transport` | applications et zones où elles sont confirmées | — |
| `POST /api/contact` | message ou signalement d'erreur (10 par heure et par adresse IP) | `sujet`, `nom`, `email`, `telephone`, `message` |

Erreurs : toujours `{"error": "message"}` (400 paramètre invalide, 404 route inconnue, 503 base indisponible ou tables absentes).

## 4. Administration (besoin « gestion des données »)

Dans `/admin/` : ajouter ou corriger un lieu avec sa **position sur une carte**, renseigner ses détails (hébergement, restaurant, prestataire),
filtrer par statut de vérification, appliquer l'action **« Marquer comme vérifié »** à une sélection, modifier les **services et applications de transport**
(le site les lit via l'API, avec repli sur `data/*.json`), lire et marquer comme traités les **messages reçus** par le formulaire de contact.
Les modifications sont visibles immédiatement dans le géoportail.

> `import_data` **efface et réimporte** les lieux : n'y passez pas après avoir corrigé des fiches dans l'administration (corrigez alors les fichiers sources,
> ou ne relancez pas l'import). Les messages reçus ne sont jamais effacés.

## 5. Tests

```powershell
.\.venv\Scripts\python.exe manage.py test portail
```
33 tests : API (filtres, distances en mètres, erreurs), algorithme de circuit, import (noms `DEPT`/`NAME_3`, UTM, doublons), sécurité du site statique, administration.
Django crée une base temporaire `test_…` (l'utilisateur PostgreSQL doit pouvoir créer des bases).

## 6. Mise en production (résumé)

1. `.env` : `DJANGO_DEBUG=0`, `DJANGO_SECRET_KEY` longue et aléatoire, `DJANGO_ALLOWED_HOSTS=votre-domaine`.
2. `python manage.py collectstatic` ; servir `staticfiles/` et le site statique avec nginx (ou un CDN) ; ne laisser à Django que `/api/` et `/admin/`.
3. Serveur d'application : `gunicorn geoportail.wsgi` (Linux) ou `waitress-serve geoportail.wsgi:application` (Windows) ; HTTPS obligatoire.
4. Le formulaire de contact enregistre des adresses e-mail : prévoir une mention légale et une durée de conservation.

## 7. Dépannage

| Message | Cause et solution |
|---|---|
| `password authentication failed` | mot de passe de `.env` différent de celui de PostgreSQL |
| `Could not find the GDAL library` | voir l'encadré GDAL ci-dessus |
| `permission denied to create extension "postgis"` | se connecter avec un super-utilisateur (`postgres`) pour `migrate` |
| `DJANGO_SECRET_KEY est obligatoire` | mettre `DJANGO_DEBUG=1` en développement ou définir la clé |
| `ModuleNotFoundError` | l'environnement virtuel n'est pas celui où `pip install -r requirements.txt` a été lancé |
| `/api/…` répond 503 « tables absentes » | lancer `migrate` puis `import_data` |
