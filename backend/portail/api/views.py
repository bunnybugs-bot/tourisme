"""
API REST du géoportail (Django REST Framework + GeoDjango). Les routes, paramètres et formats de réponse sont ceux de
l'ancienne API Flask : le client JavaScript fonctionne sans modification.

    GET  /api/health                                      état de la base
    GET  /api/lieux?categorie=&departement=&commune=&q=   lieux filtrés (GeoJSON)
    GET  /api/autour?lat=&lon=&rayon=5&categories=…       lieux dans un rayon (km), triés par distance
    GET  /api/limites/departements | communes             limites administratives (GeoJSON)
    POST /api/circuit   {"points":[{lat,lon},…],"boucle":false}   ordre de visite optimisé
    GET  /api/transports | /api/applis-transport          services et applications de transport par zone
    POST /api/contact   {"sujet","nom","email","message"} message ou signalement d'erreur
"""
import json

from django.contrib.gis.db.models.functions import AsGeoJSON
from django.db import connection
from django.db.models import Count
from rest_framework import status
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from .. import circuit as moteur_circuit
from ..models import ApplicationTransport, Commune, Departement, Lieu, ServiceTransport
from .erreurs import ErreurParametre
from .outils import (DEPARTEMENTS, dans_le_rayon, distance_m, feature, lieux_avec_details, liste_categories, nombre,
                     reglage)
from .serializers import ContactSerializer


class HealthView(APIView):
    def get(self, request):
        with connection.cursor() as cur:
            cur.execute("SELECT postgis_version()")
            postgis = cur.fetchone()[0]
        par_categorie = {}
        for ligne in Lieu.objects.order_by().values("categorie").annotate(n=Count("id")).order_by("categorie"):
            par_categorie[ligne["categorie"]] = ligne["n"]
        return Response({
            "status": "ok", "postgis": postgis, "lieux": par_categorie,
            "limites": {"departements": Departement.objects.filter(geom__isnull=False).count(),
                        "communes": Commune.objects.count()},
        })


class LieuxView(APIView):
    def get(self, request):
        cats = liste_categories(request.query_params.get("categorie"))
        dept = (request.query_params.get("departement") or "").upper().strip()
        if dept and dept not in DEPARTEMENTS:
            raise ErreurParametre(f"département inconnu (valeurs : {', '.join(DEPARTEMENTS)})")
        commune = (request.query_params.get("commune") or "").strip()
        q = (request.query_params.get("q") or "").strip()
        qs = Lieu.objects.filter(categorie__in=cats, geom__isnull=False)
        if dept:
            qs = qs.filter(departement_id=dept)
        if commune:
            qs = qs.filter(commune__iexact=commune)
        if q:
            qs = qs.filter(nom__icontains=q)
        qs = lieux_avec_details(qs).order_by("nom", "id")      # ordre déterministe même si deux lieux portent le même nom
        return Response({"type": "FeatureCollection", "features": [feature(l) for l in qs]})


class AutourView(APIView):
    """Lieux situés dans un rayon autour d'un point, du plus proche au plus éloigné (distances en mètres, type geography)."""

    def get(self, request):
        p = request.query_params
        lat = nombre(p, "lat", mini=-90, maxi=90)
        lon = nombre(p, "lon", mini=-180, maxi=180)
        rayon_km = nombre(p, "rayon", defaut=5, mini=0.1, maxi=reglage("RAYON_MAX_KM"))
        limite = int(nombre(p, "limite", defaut=500, mini=1, maxi=reglage("LIMITE_MAX")))
        cats = liste_categories(p.get("categories"))
        qs = (lieux_avec_details(Lieu.objects.filter(categorie__in=cats, geom__isnull=False))
              .filter(dans_le_rayon(lon, lat, rayon_km * 1000))
              .annotate(d=distance_m(lon, lat)).order_by("d")[:limite])
        features = [feature(l, distance_m=round(l.d)) for l in qs]
        return Response({
            "type": "FeatureCollection",
            "meta": {"source": "PostGIS", "centre": [lon, lat], "rayon_km": rayon_km, "nombre": len(features)},
            "features": features,
        })


class LimitesView(APIView):
    def get(self, request, niveau):
        if niveau == "departements":
            qs = Departement.objects.filter(geom__isnull=False).annotate(gj=AsGeoJSON("geom", precision=6)).order_by("code")
            feats = [{"type": "Feature", "geometry": json.loads(o.gj), "properties": {"nom": o.nom, "code": o.code}} for o in qs]
        elif niveau == "communes":
            qs = Commune.objects.annotate(gj=AsGeoJSON("geom", precision=6)).order_by("id")
            feats = [{"type": "Feature", "geometry": json.loads(o.gj),
                      "properties": {"nom": o.nom, "departement": o.departement_id}} for o in qs]
        else:
            return Response({"error": "niveau inconnu (departements ou communes)"}, status=404)
        if not feats:
            return Response({"error": f"aucune limite « {niveau} » en base — importez les fichiers (python manage.py import_data)"}, status=404)
        return Response({"type": "FeatureCollection", "features": feats})


class CircuitView(APIView):
    """Ordonne des étapes pour minimiser la distance. Le premier point est le départ.
    Matrice des distances calculée par PostGIS (geography, mètres) ; ordre : plus proche voisin + 2-opt."""

    def post(self, request):
        corps = request.data if isinstance(request.data, dict) else {}
        pts = corps.get("points")
        if not isinstance(pts, list) or len(pts) < 2:
            raise ErreurParametre("« points » doit contenir au moins 2 points {lat, lon}")
        maxi = reglage("CIRCUIT_MAX_POINTS")
        if len(pts) > maxi:
            raise ErreurParametre(f"{maxi} points au maximum")
        try:
            lats = [float(p["lat"]) for p in pts]
            lons = [float(p["lon"]) for p in pts]
        except (KeyError, TypeError, ValueError):
            raise ErreurParametre("chaque point doit avoir « lat » et « lon » numériques")
        if any(not -90 <= v <= 90 for v in lats) or any(not -180 <= v <= 180 for v in lons):
            raise ErreurParametre("coordonnées hors limites")
        with connection.cursor() as cur:
            cur.execute(
                """
                WITH p AS (
                    SELECT i, ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography AS g
                    FROM unnest(%s::float8[], %s::float8[]) WITH ORDINALITY AS t(lon, lat, i)
                )
                SELECT a.i - 1, b.i - 1, ST_Distance(a.g, b.g) FROM p a, p b
                """,
                [lons, lats],
            )
            lignes = cur.fetchall()
        n = len(pts)
        M = [[0.0] * n for _ in range(n)]
        for i, j, d in lignes:
            M[i][j] = float(d)
        res = moteur_circuit.optimiser(M, bool(corps.get("boucle")))
        res["source"] = "PostGIS"
        return Response(res)


class TransportsView(APIView):
    """Services de transport (même structure que data/transports.json)."""

    def get(self, request):
        return Response([{"id": s.id, "nom": s.nom, "type_service": s.type_service, "zones": s.zones,
                          "telephone": s.telephone, "site_web": s.site_web}
                         for s in ServiceTransport.objects.filter(actif=True).order_by("id")])


class ApplisTransportView(APIView):
    """Applications de transport et zones où leur présence est confirmée (même structure que data/applis_transport.json)."""

    def get(self, request):
        return Response([{"id": a.nom.lower(), "nom": a.nom, "zones": a.zones, "site_web": a.site_web}
                         for a in ApplicationTransport.objects.filter(actif=True).order_by("id")])


class ContactView(APIView):
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "contact"

    def post(self, request):
        s = ContactSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        s.save()
        return Response({"status": "ok"}, status=status.HTTP_201_CREATED)


def route_inconnue(request, *args, **kwargs):
    from django.http import JsonResponse
    return JsonResponse({"error": "route inconnue"}, status=404, json_dumps_params={"ensure_ascii": False})
