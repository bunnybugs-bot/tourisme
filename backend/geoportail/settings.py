"""
Paramètres du géoportail touristique de la région de Thiès (Django + GeoDjango + PostgreSQL/PostGIS).
Tout ce qui varie d'une machine à l'autre vient du fichier .env (voir .env.example).
"""
import os
from pathlib import Path
from urllib.parse import unquote, urlparse

from dotenv import load_dotenv

from . import gdal_windows

BASE_DIR = Path(__file__).resolve().parent.parent          # .../tourisme/backend
SITE_DIR = BASE_DIR.parent                                 # .../tourisme  (le site statique : carte.html, assets, data…)
load_dotenv(BASE_DIR / ".env")
gdal_windows.configurer()                                  # Windows : trouve GDAL/GEOS (QGIS ou OSGeo4W) avant le chargement de GeoDjango

DEBUG = os.getenv("DJANGO_DEBUG", "0") == "1"
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY") or ("dev-only-cle-non-secrete" if DEBUG else None)
if not SECRET_KEY:
    raise RuntimeError("DJANGO_SECRET_KEY est obligatoire quand DJANGO_DEBUG n'est pas 1 (voir .env.example).")
ALLOWED_HOSTS = [h.strip() for h in os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if h.strip()]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.gis",            # GeoDjango : champs géométriques, requêtes spatiales
    "django.contrib.postgres",       # ArrayField (zones desservies des services de transport)
    "rest_framework",
    "corsheaders",
    "portail",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "geoportail.urls"
WSGI_APPLICATION = "geoportail.wsgi.application"
ASGI_APPLICATION = "geoportail.asgi.application"

TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [],
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": [
        "django.template.context_processors.request",
        "django.contrib.auth.context_processors.auth",
        "django.contrib.messages.context_processors.messages",
    ]},
}]


def _base_de_donnees():
    """DATABASE_URL (postgresql://utilisateur:mot_de_passe@hôte:port/base) -> paramètres Django PostGIS."""
    url = urlparse(os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/tourisme_thies"))
    return {
        "ENGINE": "django.contrib.gis.db.backends.postgis",
        "NAME": unquote(url.path.lstrip("/")),
        "USER": unquote(url.username or ""),
        "PASSWORD": unquote(url.password or ""),
        "HOST": url.hostname or "localhost",
        "PORT": str(url.port or 5432),
        "CONN_MAX_AGE": 60,
        "OPTIONS": {"connect_timeout": 5},
    }


DATABASES = {"default": _base_de_donnees()}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "fr-fr"
TIME_ZONE = "Africa/Dakar"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"                                    # fichiers de l'interface d'administration
STATIC_ROOT = BASE_DIR / "staticfiles"                     # destination de « collectstatic » en production

# ---- API REST -------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],   # API publique, en lecture seule (sauf /api/contact)
    "DEFAULT_AUTHENTICATION_CLASSES": [],                    # pas de session : pas de CSRF à gérer pour les appels publics
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.AnonRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {"anon": "600/hour", "contact": "10/hour"},
    "EXCEPTION_HANDLER": "portail.api.erreurs.gestionnaire",
    "UNICODE_JSON": True,
}
CORS_URLS_REGEX = r"^/api/.*$"
CORS_ALLOW_ALL_ORIGINS = True                              # données publiques ; restreindre si l'API est ouverte à des tiers

# ---- Paramètres métier ----------------------------------------------------
GEOPORTAIL = {
    "RAYON_MAX_KM": 50,
    "LIMITE_MAX": 1000,
    "CIRCUIT_MAX_POINTS": 25,
    "DOUBLON_DISTANCE_M": 200,          # même catégorie + même nom à moins de 200 m = doublon à l'import
    "SOURCE_RECENSEMENT": "Recensement de terrain, région de Thiès — 2025",
    "DOSSIERS_PRIVES": {"backend", "backend_flask_archive", "tools"},    # jamais servis par le site statique
    "EXTENSIONS_SERVIES": {".html", ".css", ".js", ".json", ".geojson", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico", ".webmanifest"},
}
# Les serveurs de tuiles OpenStreetMap exigent un Referer ; Django envoie "same-origin" par défaut, ce qui le supprime.
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"