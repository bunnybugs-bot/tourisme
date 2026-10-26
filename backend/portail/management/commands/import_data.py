"""
Importe les données du géoportail dans PostgreSQL/PostGIS (port Django du script import_data.py).

    python manage.py import_data                    # efface puis réimporte lieux et limites
    python manage.py import_data --data-dir ..      # dossier du site (par défaut : le dossier parent de backend/)

Sources lues (si présentes) :
    hebergements.geojson, restaurants.geojson, sites.json, data/prestataires.json,
    data/limites_departements.geojson, data/limites_communes.geojson,
    data/transports.json, data/applis_transport.json

La commande est rejouable : elle remplace les lieux, les limites, et recharge les services de transport
(les messages reçus par le formulaire de contact ne sont jamais touchés). Elle affiche un rapport qualité.
Option DEDUIRE_COMMUNE=1 (variable d'environnement) : un lieu sans commune la reçoit de sa position
(à n'utiliser qu'avec une couche communale complète).
"""
import json
import os
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

from django.conf import settings
from django.contrib.gis.geos import GEOSGeometry, MultiPolygon, Polygon
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction

from portail.api.outils import dans_le_rayon
from portail.models import (ApplicationTransport, Commune, Departement, Hebergement, Lieu, Prestataire, Restaurant,
                            ServiceTransport)

DEPARTEMENTS = {"THIES", "MBOUR", "TIVAOUANE"}
TYPES_HEBERGEMENT = {"Chambres d'hôtes": "Chambre d'hôtes"}
CLES_NOM = {
    "departements": ("nom", "NOM", "DEPT", "NAME_2", "ADM2_FR", "admin2Name", "shapeName", "name", "NAME"),
    # CORRECTION ICI : ajout de "communes" en premier
    "communes": ("communes", "nom", "NOM", "NAME_4", "COMMUNE", "CCRCA", "NAME_3", "ADM3_FR", "admin3Name", "shapeName", "name", "NAME"),
}


# ------------------------------------------------------------------ utilitaires
def cle(texte):
    """« Thiès », « THIES », « M'bour » -> THIES, MBOUR."""
    s = unicodedata.normalize("NFD", str(texte or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Z]", "", s.upper())


def slugify(texte):
    s = unicodedata.normalize("NFD", str(texte or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def vide(v):
    """'' -> None (les anciens fichiers mélangent chaîne vide et null)."""
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def parse_date(v):
    try:
        return date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        return None


def normalise_type_restaurant(type_brut):
    """'Restaurant ethiopien' -> ('Restaurant', 'Ethiopien'). 'Restaurant et Bar' est conservé."""
    t = vide(type_brut)
    if not t:
        return None, None
    m = re.match(r"^Restaurant\s+(?!et\b)(.+)$", t, re.I)
    if m:
        return "Restaurant", m.group(1).strip().capitalize()
    return t, None


def charger_json(chemin, sortie):
    if not chemin.exists():
        sortie.write(f"  (absent : {chemin.name})")
        return None
    return json.loads(chemin.read_text(encoding="utf-8"))


# ------------------------------------------------------------------ limites : CRS et géométries
def premiere_coord(geom):
    c = geom["coordinates"]
    while isinstance(c, list) and isinstance(c[0], list):
        c = c[0]
    return c


def mapper(coords, fn):
    return fn(coords) if isinstance(coords[0], (int, float)) else [mapper(c, fn) for c in coords]


def normaliser_crs(fc):
    """Détecte UTM 28N ou lon/lat inversés et renvoie un GeoJSON WGS84 (+ message)."""
    feats = [f for f in fc["features"] if f.get("geometry")]
    x, y = premiere_coord(feats[0]["geometry"])[:2]
    if abs(x) > 1000 or abs(y) > 1000:
        from pyproj import Transformer
        tr = Transformer.from_crs(32628, 4326, always_xy=True)
        fn = lambda c: list(tr.transform(c[0], c[1]))
        msg = "reprojeté depuis UTM 28N"
    elif 10 < x < 18 and -20 < y < -10:
        fn = lambda c: [c[1], c[0]]
        msg = "longitude/latitude inversées, corrigé"
    else:
        return fc, None
    for f in feats:
        f["geometry"]["coordinates"] = mapper(f["geometry"]["coordinates"], fn)
    return fc, msg


def nom_entite(props, niveau="communes"):
    """Nom d'une entité de limite."""
    # Sécurité ajoutée : on cherche d'abord 'communes'
    if niveau == "communes" and props.get("communes"):
        return str(props.get("communes")).strip()
    
    for k in CLES_NOM[niveau]:
        v = props.get(k)
        if v and str(v).strip():
            return str(v).strip()
    return None


def en_multipolygone(geometrie_geojson):
    """GeoJSON -> MultiPolygon valide (équivalent de ST_Multi(ST_CollectionExtract(ST_MakeValid(…), 3)))."""
    g = GEOSGeometry(json.dumps(geometrie_geojson), srid=4326)
    if not g.valid:
        g = g.make_valid()
    polys = []
    for part in (g if g.geom_type == "GeometryCollection" else [g]):
        if part.geom_type == "Polygon":
            polys.append(part)
        elif part.geom_type == "MultiPolygon":
            polys.extend(list(part))
    return MultiPolygon(*polys, srid=4326) if polys else None


# ------------------------------------------------------------------ importeur de lieux
class Importeur:
    def __init__(self):
        self.codes = set()
        self.doublons_ecartes = []     # (catégorie, nom, détail)
        self.compteurs = {}
        self.dernier_doublon = None
        self.distance_doublon = settings.GEOPORTAIL["DOUBLON_DISTANCE_M"]
        self.source = settings.GEOPORTAIL["SOURCE_RECENSEMENT"]

    def code_unique(self, base):
        code, n = base, 2
        while code in self.codes:
            code = f"{base}-{n}"
            n += 1
        self.codes.add(code)
        return code

    def est_doublon(self, categorie, nom, lon, lat):
        return (Lieu.objects.filter(categorie=categorie, nom__iexact=nom, geom__isnull=False)
                .filter(dans_le_rayon(lon, lat, self.distance_doublon)).values_list("id", flat=True).first())

    def lieu(self, *, categorie, code_base, nom, type_, commune, departement, adresse, telephone, site_web,
             description, source, date_verif, statut, lon, lat):
        self.dernier_doublon = None
        existant = self.est_doublon(categorie, nom, lon, lat) if lon is not None else None
        if existant:
            # Fusion : on complète la fiche déjà importée avec les champs qui lui manquent
            l = Lieu.objects.get(pk=existant)
            for champ, valeur in (("type", type_), ("commune", vide(commune)), ("adresse", vide(adresse)),
                                  ("telephone", vide(telephone)), ("site_web", vide(site_web)), ("description", vide(description))):
                if getattr(l, champ) is None and valeur is not None:
                    setattr(l, champ, valeur)
            l.save()
            self.dernier_doublon = existant
            self.doublons_ecartes.append((categorie, nom, f"fiche identique à moins de {self.distance_doublon} m : "
                                                          "fusionnée (champs manquants complétés)"))
            return None
        dept = cle(departement)
        dept = dept if dept in DEPARTEMENTS else None
        lieu = Lieu.objects.create(
            categorie=categorie, code=self.code_unique(code_base or slugify(nom) or "sans-nom"), nom=nom, type=type_,
            commune=vide(commune), departement_id=dept, adresse=vide(adresse), telephone=vide(telephone),
            site_web=vide(site_web), description=vide(description), source=source, date_verification=date_verif,
            statut_verification=statut,
            geom=GEOSGeometry(f"POINT({lon} {lat})", srid=4326) if lon is not None else None)
        self.compteurs[categorie] = self.compteurs.get(categorie, 0) + 1
        return lieu

    def hebergement(self, f):
        p, (lon, lat) = f["properties"], f["geometry"]["coordinates"][:2]
        if p.get("categorie") == "restaurant":           # garde-fou : une fiche « restaurant » rangée dans le fichier des hébergements
            return self.restaurant(f)
        t = vide(p.get("type"))
        lieu = self.lieu(categorie="hebergement", code_base=p.get("slug"), nom=p["nom"].strip(), type_=TYPES_HEBERGEMENT.get(t, t),
                         commune=p.get("commune"), departement=p.get("departement"), adresse=p.get("adresse"),
                         telephone=p.get("telephone"), site_web=p.get("site_web"), description=None, source=self.source,
                         date_verif=None, statut="recensement de terrain", lon=lon, lat=lat)
        if lieu is None:
            return
        milieu = (vide(p.get("milieu")) or "").upper()
        Hebergement.objects.create(
            lieu=lieu, milieu=milieu if milieu in ("URBAIN", "RURAL") else None, quartier_village=vide(p.get("quartier_village")),
            nb_chambres=p.get("nb_chambres"), piscine=p.get("piscine"), wifi=p.get("wifi"), parking=p.get("parking"),
            accessible_handicap=p.get("accessible_handicap"), booking=vide(p.get("booking")), tripadvisor=vide(p.get("tripadvisor")))

    def restaurant(self, f):
        p, (lon, lat) = f["properties"], f["geometry"]["coordinates"][:2]
        type_, specialite = normalise_type_restaurant(p.get("type"))
        lieu = self.lieu(categorie="restaurant", code_base=p.get("slug"), nom=p["nom"].strip(), type_=type_,
                         commune=p.get("commune"), departement=p.get("departement"), adresse=p.get("adresse"),
                         telephone=p.get("telephone"), site_web=p.get("site_web"), description=None, source=self.source,
                         date_verif=None, statut="recensement de terrain", lon=lon, lat=lat)
        if lieu is None:
            if self.dernier_doublon:
                r, _ = Restaurant.objects.get_or_create(lieu_id=self.dernier_doublon)
                r.horaires = r.horaires or vide(p.get("horaires"))
                r.modalite = r.modalite or vide(p.get("modalite"))
                r.specialite = r.specialite or specialite
                r.save()
            return
        Restaurant.objects.create(lieu=lieu, specialite=specialite, modalite=vide(p.get("modalite")), horaires=vide(p.get("horaires")))

    def site(self, f):
        p, (lon, lat) = f["properties"], f["geometry"]["coordinates"][:2]
        self.lieu(categorie="site", code_base="site-" + slugify(p["nom"]), nom=p["nom"].strip(), type_=vide(p.get("type")),
                  commune=p.get("commune"), departement=p.get("departement"), adresse=p.get("adresse"), telephone=p.get("telephone"),
                  site_web=p.get("site_web"), description=vide(p.get("description")), source=None, date_verif=None,
                  statut="non vérifié", lon=lon, lat=lat)

    def prestataire(self, p):
        lat, lon = p.get("latitude"), p.get("longitude")
        localise = bool(lat and lon)
        lieu = self.lieu(categorie="prestataire", code_base=p["id"], nom=p["nom"].strip(), type_=vide(p.get("type")),
                         commune=p.get("commune"), departement=p.get("departement"), adresse=p.get("localisation_texte"),
                         telephone=None, site_web=None, description=vide(p.get("description")), source=vide(p.get("source")),
                         date_verif=parse_date(p.get("date_verification")), statut=vide(p.get("statut_verification")) or "non vérifié",
                         lon=lon if localise else None, lat=lat if localise else None)
        if lieu is None:
            return
        Prestataire.objects.create(
            lieu=lieu, genre=vide(p.get("categorie")), famille=vide(p.get("famille")), icone=vide(p.get("icone")),
            localisation_texte=vide(p.get("localisation_texte")), tarif_annonce=vide(p.get("tarif_annonce")),
            contact=vide(p.get("contact")), source_url=vide(p.get("source_url")), note_verification=vide(p.get("note_verification")),
            source_position=vide(p.get("source_position")))


# ------------------------------------------------------------------ commande
class Command(BaseCommand):
    help = "Importe lieux, limites administratives et services de transport dans PostgreSQL/PostGIS."

    def add_arguments(self, parser):
        parser.add_argument("--data-dir", default=str(settings.SITE_DIR), help="dossier du site (défaut : parent de backend/)")

    def handle(self, *args, **opts):
        data_dir = Path(opts["data_dir"]).resolve()
        if not data_dir.exists():
            raise CommandError(f"dossier introuvable : {data_dir}")
        db = settings.DATABASES["default"]
        self.stdout.write(f"Base : {db['NAME']} sur {db['HOST']}:{db['PORT']}\nDonnées : {data_dir}\n")
        for d in (("THIES", "Thiès"), ("MBOUR", "Mbour"), ("TIVAOUANE", "Tivaouane")):
            Departement.objects.get_or_create(code=d[0], defaults={"nom": d[1]})

        with transaction.atomic():
            self.stdout.write("1. Remise à zéro des lieux et des limites…")
            Lieu.objects.all().delete()                      # supprime aussi les tables de détails (CASCADE)
            Commune.objects.all().delete()
            Departement.objects.update(geom=None)
            imp = Importeur()

            self.stdout.write("2. Import des lieux…")
            for fichier, methode in (("hebergements.geojson", imp.hebergement), ("restaurants.geojson", imp.restaurant), ("sites.json", imp.site)):
                fc = charger_json(data_dir / fichier, self.stdout)
                for f in (fc or {}).get("features", []):
                    methode(f)
            for p in charger_json(data_dir / "data" / "prestataires.json", self.stdout) or []:
                imp.prestataire(p)

            self.stdout.write("3. Import des limites administratives…")
            rapport_limites = self.importer_limites(data_dir)

            self.stdout.write("4. Services et applications de transport…")
            rapport_transport = self.importer_transports(data_dir)

            incoherents, possibles = self.controles()

        self.rapport(imp, rapport_limites, rapport_transport, incoherents, possibles)

    # ---- limites
    def importer_limites(self, data_dir):
        rapport = []
        fc = charger_json(data_dir / "data" / "limites_departements.geojson", self.stdout)
        if fc:
            fc, msg = normaliser_crs(fc)
            n, ignores = 0, []
            for f in fc["features"]:
                nom = nom_entite(f["properties"], "departements")
                code = cle(nom)
                if code not in DEPARTEMENTS:
                    ignores.append(nom)
                    continue
                g = en_multipolygone(f["geometry"])
                if g is not None:
                    n += Departement.objects.filter(code=code).update(geom=g)
            rapport.append(f"départements : {n}/3 importés" + (f" ({msg})" if msg else "")
                           + (f" — {len(ignores)} autre(s) entité(s) du fichier ignorée(s)" if ignores else ""))
        fc = charger_json(data_dir / "data" / "limites_communes.geojson", self.stdout)
        if fc:
            fc, msg = normaliser_crs(fc)
            n, sans_nom = 0, 0
            for f in fc["features"]:
                nom = nom_entite(f["properties"], "communes")
                if not nom:                                   # jamais de commune « ? » : on l'ignore et on le signale
                    sans_nom += 1
                    continue
                g = en_multipolygone(f["geometry"])
                if g is not None:
                    Commune.objects.create(nom=nom, geom=g)
                    n += 1
            rapport.append(f"communes : {n} importées" + (f" ({msg})" if msg else "")
                           + (f" — {sans_nom} entité(s) sans nom ignorée(s) : colonne de nom non reconnue" if sans_nom else ""))
            # Jointure spatiale : département de chaque commune
            for c in Commune.objects.all():
                d = Departement.objects.filter(geom__intersects=c.geom.point_on_surface).first()
                if d:
                    c.departement = d
                    c.save(update_fields=["departement"])
            if os.environ.get("DEDUIRE_COMMUNE") == "1":
                deduits = 0
                for c in Commune.objects.all():
                    affichage = re.sub(r"\s+", " ", "".join(ch for ch in unicodedata.normalize("NFD", c.nom.upper())
                                                            if unicodedata.category(ch) != "Mn")).strip()
                    deduits += Lieu.objects.filter(commune__isnull=True, geom__within=c.geom).update(commune=affichage)
                rapport.append(f"commune déduite de la position pour {deduits} lieu(x) qui n'en avaient pas")
            else:
                rapport.append("commune non déduite de la position (option DEDUIRE_COMMUNE=1, à utiliser avec une couche communale complète)")
            # Contrôle : les communes déclarées dans les données existent-elles dans la couche ?
            dans_couche = {cle(nom) for nom in Commune.objects.values_list("nom", flat=True)}
            from django.db.models import Count
            lignes = list(Lieu.objects.filter(commune__isnull=False).values("commune").annotate(n=Count("id")).order_by("-n"))
            total = sum(l["n"] for l in lignes)
            couverts = sum(l["n"] for l in lignes if cle(l["commune"]) in dans_couche)
            absentes = [(l["commune"], l["n"]) for l in lignes if cle(l["commune"]) not in dans_couche]
            rapport.append(f"couverture de la couche communale : {couverts}/{total} lieux ont leur commune dans le fichier")
            if absentes:
                rapport.append("communes présentes dans vos données mais ABSENTES du fichier de limites : "
                               + ", ".join(f"{k} ({c})" for k, c in absentes[:8]) + (" …" if len(absentes) > 8 else ""))
        return rapport

    # ---- transport
    def importer_transports(self, data_dir):
        rapport = []
        services = charger_json(data_dir / "data" / "transports.json", self.stdout)
        if services is not None:
            ServiceTransport.objects.all().delete()
            for s in services:
                ServiceTransport.objects.create(nom=s["nom"], type_service=s.get("type_service", ""), zones=list(s.get("zones", [])),
                                                telephone=s.get("telephone", "") or "", site_web=s.get("site_web", "") or "")
            rapport.append(f"{len(services)} service(s) de transport")
        apps = charger_json(data_dir / "data" / "applis_transport.json", self.stdout)
        if apps is not None:
            ApplicationTransport.objects.all().delete()
            for a in apps:
                ApplicationTransport.objects.create(nom=a["nom"], zones=list(a.get("zones", [])), site_web=a.get("site_web", "") or "")
            rapport.append(f"{len(apps)} application(s) de transport")
        return rapport

    # ---- contrôles qualité
    def controles(self):
        incoherents = []
        if Departement.objects.filter(geom__isnull=False).count() == 3:
            with connection.cursor() as cur:
                cur.execute("""SELECT l.categorie, l.nom, l.departement_id, d.code
                               FROM portail_lieu l JOIN portail_departement d ON ST_Intersects(d.geom, l.geom)
                               WHERE l.departement_id IS DISTINCT FROM d.code ORDER BY l.categorie, l.nom""")
                incoherents = cur.fetchall()
        with connection.cursor() as cur:
            cur.execute("""SELECT a.categorie, a.nom, b.nom, round(ST_Distance(a.geom::geography, b.geom::geography))
                           FROM portail_lieu a JOIN portail_lieu b ON a.id < b.id AND a.categorie = b.categorie
                            AND a.telephone IS NOT NULL AND a.telephone = b.telephone
                            AND ST_DWithin(a.geom::geography, b.geom::geography, %s)
                           WHERE lower(a.nom) <> lower(b.nom) ORDER BY 1, 2""", [settings.GEOPORTAIL["DOUBLON_DISTANCE_M"]])
            possibles = cur.fetchall()
        return incoherents, possibles

    def rapport(self, imp, rapport_limites, rapport_transport, incoherents, possibles):
        from django.db.models import Count
        w = self.stdout.write
        w("\n================ RAPPORT ================")
        for ligne in Lieu.objects.order_by().values("categorie").annotate(n=Count("id")).order_by("categorie"):
            w(f"  {ligne['categorie']:<13} {ligne['n']:>4}")
        w(f"  (sans position : {Lieu.objects.filter(geom__isnull=True).count()} — sans département : {Lieu.objects.filter(departement__isnull=True).count()})")
        for ligne in rapport_limites:
            w(f"  limites — {ligne}")
        if not rapport_limites:
            w("  limites — aucun fichier trouvé dans data/ (affichage des limites et contrôle spatial désactivés)")
        for ligne in rapport_transport:
            w(f"  transport — {ligne}")
        if imp.doublons_ecartes:
            w(f"\n{len(imp.doublons_ecartes)} doublon(s) fusionné(s) à l'import :")
            for cat, nom, detail in imp.doublons_ecartes:
                w(f"  - [{cat}] {nom} : {detail}")
        if possibles:
            w(f"\n{len(possibles)} doublon(s) possible(s) (noms différents, même téléphone, < {imp.distance_doublon} m) — NON fusionnés :")
            for cat, a, b, d in possibles:
                w(f"  - [{cat}] « {a} » et « {b} » ({int(d)} m)")
        if incoherents:
            w(f"\n{len(incoherents)} lieu(x) dont le département déclaré ≠ département réel (jointure spatiale) :")
            for cat, nom, decl, reel in incoherents[:15]:
                w(f"  - [{cat}] {nom} : déclaré {decl}, situé en {reel}")
            if len(incoherents) > 15:
                w(f"  … et {len(incoherents) - 15} autres")
        w("\nTerminé.")