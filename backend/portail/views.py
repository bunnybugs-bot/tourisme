"""Site statique (carte.html, assets, data…) servi par Django : pratique en développement, comme l'ancien serveur Flask.
En production, servez ces fichiers avec nginx ou un CDN et ne gardez que /api/ et /admin/ dans Django."""
import pathlib

from django.conf import settings
from django.http import Http404, HttpResponseRedirect
from django.views.static import serve


def accueil(request):
    return HttpResponseRedirect("/carte.html")


def site(request, chemin):
    p = pathlib.PurePosixPath(chemin)
    cfg = settings.GEOPORTAIL
    if (not p.parts or p.parts[0] in cfg["DOSSIERS_PRIVES"] or any(part.startswith(".") for part in p.parts)
            or p.suffix.lower() not in cfg["EXTENSIONS_SERVIES"]):
        raise Http404("introuvable")                         # jamais de .env, de script ni de code source
    return serve(request, chemin, document_root=settings.SITE_DIR)
