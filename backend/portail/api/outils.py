"""Outils communs aux vues de l'API : validation des paramètres, construction du GeoJSON, expressions PostGIS (geography)."""
import json

from django.conf import settings
from django.contrib.gis.db.models.functions import AsGeoJSON
from django.db.models import BooleanField, FloatField
from django.db.models.expressions import RawSQL

from ..models import Lieu
from .erreurs import ErreurParametre

CATEGORIES = ("hebergement", "restaurant", "site", "prestataire")
DEPARTEMENTS = ("THIES", "MBOUR", "TIVAOUANE")


def reglage(nom):
    return settings.GEOPORTAIL[nom]


def nombre(params, nom, defaut=None, mini=None, maxi=None):
    brut = params.get(nom)
    if brut is None or brut == "":
        if defaut is None:
            raise ErreurParametre(f"paramètre « {nom} » manquant")
        return defaut
    try:
        v = float(str(brut).replace(",", "."))
    except ValueError:
        raise ErreurParametre(f"« {nom} » doit être un nombre")
    if (mini is not None and v < mini) or (maxi is not None and v > maxi):
        raise ErreurParametre(f"« {nom} » doit être compris entre {mini} et {maxi}")
    return v


def liste_categories(valeur):
    cats = [c.strip().lower() for c in (valeur or "").split(",") if c.strip()]
    if not cats:
        return list(CATEGORIES[:3])                    # par défaut : hébergements, restaurants, sites
    inconnues = [c for c in cats if c not in CATEGORIES]
    if inconnues:
        raise ErreurParametre(f"catégorie inconnue : {', '.join(inconnues)} (valeurs : {', '.join(CATEGORIES)})")
    return cats


# ------------------------------------------------------------------ GeoJSON
def lieux_avec_details(queryset):
    """Jointures vers les tables de détails + géométrie en GeoJSON (9 décimales, comme PostGIS par défaut)."""
    return queryset.select_related("hebergement", "restaurant", "prestataire").annotate(gj=AsGeoJSON("geom", precision=9))


def proprietes(lieu):
    """Propriétés d'un lieu : mêmes noms que les anciens fichiers GeoJSON et que l'ancienne API (le client JavaScript n'a rien à changer)."""
    p = {
        "id": lieu.id, "slug": lieu.code, "nom": lieu.nom, "categorie": lieu.categorie, "type": lieu.type,
        "commune": lieu.commune, "departement": lieu.departement_id, "adresse": lieu.adresse,
        "telephone": lieu.telephone, "site_web": lieu.site_web, "description": lieu.description,
        "source": lieu.source,
        "date_verification": lieu.date_verification.isoformat() if lieu.date_verification else None,
        "statut_verification": lieu.statut_verification,
    }
    h = getattr(lieu, "hebergement", None)
    if h:
        p.update(milieu=h.milieu, quartier_village=h.quartier_village, nb_chambres=h.nb_chambres, piscine=h.piscine,
                 wifi=h.wifi, parking=h.parking, accessible_handicap=h.accessible_handicap, booking=h.booking,
                 tripadvisor=h.tripadvisor)
    r = getattr(lieu, "restaurant", None)
    if r:
        p.update(specialite=r.specialite, modalite=r.modalite, horaires=r.horaires)
    pr = getattr(lieu, "prestataire", None)
    if pr:
        p.update(genre=pr.genre, famille=pr.famille, tarif_annonce=pr.tarif_annonce, contact=pr.contact)
    return {k: v for k, v in p.items() if v is not None}       # équivalent de jsonb_strip_nulls


def feature(lieu, **extra):
    props = proprietes(lieu)
    props.update(extra)
    return {"type": "Feature", "geometry": json.loads(lieu.gj), "properties": props}


# ------------------------------------------------------------------ expressions PostGIS en mètres (type geography)
def _col():
    return f'"{Lieu._meta.db_table}"."geom"'


def distance_m(lon, lat):
    """Distance (mètres, ellipsoïde WGS84) entre chaque lieu et un point."""
    return RawSQL(f"ST_Distance({_col()}::geography, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography)",
                  (lon, lat), output_field=FloatField())


def dans_le_rayon(lon, lat, rayon_m):
    """Condition ST_DWithin sur geography : utilise l'index GiST (geom::geography) créé par la migration."""
    return RawSQL(f"ST_DWithin({_col()}::geography, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)",
                  (lon, lat, rayon_m), output_field=BooleanField())
