#!/usr/bin/env python3
"""
Importe les données du géoportail dans PostgreSQL/PostGIS.

    python import_data.py                 # (re)crée les tables puis importe tout
    python import_data.py --data-dir ..   # dossier du site (par défaut : le dossier parent)

Sources lues (si présentes) :
    hebergements.geojson, restaurants.geojson, sites.json, data/prestataires.json,
    data/limites_departements.geojson, data/limites_communes.geojson

Le script est rejouable : il recrée les tables à chaque fois.
À la fin il affiche un rapport qualité (doublons écartés, incohérences de département…).
"""
import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

import psycopg
from dotenv import load_dotenv

BASE = Path(__file__).resolve().parent
load_dotenv(BASE / ".env")
DB_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/tourisme_thies")

SOURCE_RECENSEMENT = "Recensement de terrain, région de Thiès — 2025"
DEPARTEMENTS = {"THIES", "MBOUR", "TIVAOUANE"}
DOUBLON_DISTANCE_M = 200      # même catégorie + même nom à moins de 200 m = doublon


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


def charger_json(chemin):
    if not chemin.exists():
        print(f"  (absent : {chemin.name})")
        return None
    return json.loads(chemin.read_text(encoding="utf-8"))


def parse_date(v):
    try:
        return date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        return None


TYPES_HEBERGEMENT = {"Chambres d'hôtes": "Chambre d'hôtes"}


def normalise_type_restaurant(type_brut):
    """'Restaurant ethiopien' -> ('Restaurant', 'Ethiopien'). 'Restaurant et Bar' est conservé."""
    t = vide(type_brut)
    if not t:
        return None, None
    m = re.match(r"^Restaurant\s+(?!et\b)(.+)$", t, re.I)
    if m:
        return "Restaurant", m.group(1).strip().capitalize()
    return t, None


# ------------------------------------------------------------------ insertion
class Importeur:
    def __init__(self, cur):
        self.cur = cur
        self.codes = set()
        self.doublons_ecartes = []     # (categorie, nom, détail)
        self.compteurs = {}
        self.dernier_doublon = None

    def code_unique(self, base):
        code, n = base, 2
        while code in self.codes:
            code = f"{base}-{n}"
            n += 1
        self.codes.add(code)
        return code

    def est_doublon(self, categorie, nom, lon, lat):
        self.cur.execute(
            """SELECT id FROM lieu
               WHERE categorie = %s AND lower(nom) = lower(%s) AND geom IS NOT NULL
                 AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, %s)
               LIMIT 1""",
            (categorie, nom, lon, lat, DOUBLON_DISTANCE_M),
        )
        r = self.cur.fetchone()
        return r[0] if r else None

    def lieu(self, *, categorie, code_base, nom, type_, commune, departement, adresse, telephone,
             site_web, description, source, date_verif, statut, lon, lat):
        self.dernier_doublon = None
        existant = self.est_doublon(categorie, nom, lon, lat) if lon is not None else None
        if existant:
            # Fusion : on complète la fiche déjà importée avec les champs qui lui manquent
            self.cur.execute(
                """UPDATE lieu SET type = COALESCE(type, %s), commune = COALESCE(commune, %s),
                          adresse = COALESCE(adresse, %s), telephone = COALESCE(telephone, %s),
                          site_web = COALESCE(site_web, %s), description = COALESCE(description, %s)
                   WHERE id = %s""",
                (type_, vide(commune), vide(adresse), vide(telephone), vide(site_web), vide(description), existant))
            self.dernier_doublon = existant
            self.doublons_ecartes.append((categorie, nom, "fiche identique à moins de "
                                          f"{DOUBLON_DISTANCE_M} m : fusionnée (champs manquants complétés)"))
            return None
        dept = cle(departement)
        dept = dept if dept in DEPARTEMENTS else None
        geom = "ST_SetSRID(ST_MakePoint(%s, %s), 4326)" if lon is not None else "NULL"
        params = [categorie, self.code_unique(code_base or slugify(nom) or "sans-nom"), nom, type_,
                  vide(commune), dept, vide(adresse), vide(telephone), vide(site_web), vide(description),
                  source, date_verif, statut]
        if lon is not None:
            params += [lon, lat]
        self.cur.execute(
            f"""INSERT INTO lieu (categorie, code, nom, type, commune, departement, adresse, telephone,
                                  site_web, description, source, date_verification, statut_verification, geom)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,{geom}) RETURNING id""",
            params,
        )
        self.compteurs[categorie] = self.compteurs.get(categorie, 0) + 1
        return self.cur.fetchone()[0]

    # ---- hébergements
    def hebergement(self, f):
        p, (lon, lat) = f["properties"], f["geometry"]["coordinates"][:2]
        # Garde-fou : une fiche « restaurant » rangée dans le fichier des hébergements
        if p.get("categorie") == "restaurant":
            return self.restaurant(f)
        t = vide(p.get("type"))
        lid = self.lieu(categorie="hebergement", code_base=p.get("slug"), nom=p["nom"].strip(),
                        type_=TYPES_HEBERGEMENT.get(t, t), commune=p.get("commune"), departement=p.get("departement"),
                        adresse=p.get("adresse"), telephone=p.get("telephone"), site_web=p.get("site_web"),
                        description=None, source=SOURCE_RECENSEMENT, date_verif=None,
                        statut="recensement de terrain", lon=lon, lat=lat)
        if lid is None:
            return
        milieu = (vide(p.get("milieu")) or "").upper()
        self.cur.execute(
            """INSERT INTO hebergement (lieu_id, milieu, quartier_village, nb_chambres, piscine, wifi, parking,
                                        accessible_handicap, booking, tripadvisor)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (lid, milieu if milieu in ("URBAIN", "RURAL") else None, vide(p.get("quartier_village")),
             p.get("nb_chambres"), p.get("piscine"), p.get("wifi"), p.get("parking"), p.get("accessible_handicap"),
             vide(p.get("booking")), vide(p.get("tripadvisor"))),
        )

    # ---- restaurants
    def restaurant(self, f):
        p, (lon, lat) = f["properties"], f["geometry"]["coordinates"][:2]
        type_, specialite = normalise_type_restaurant(p.get("type"))
        lid = self.lieu(categorie="restaurant", code_base=p.get("slug"), nom=p["nom"].strip(), type_=type_,
                        commune=p.get("commune"), departement=p.get("departement"), adresse=p.get("adresse"),
                        telephone=p.get("telephone"), site_web=p.get("site_web"), description=None,
                        source=SOURCE_RECENSEMENT, date_verif=None, statut="recensement de terrain", lon=lon, lat=lat)
        if lid is None:
            if self.dernier_doublon:
                self.cur.execute("""UPDATE restaurant SET horaires = COALESCE(horaires, %s), modalite = COALESCE(modalite, %s),
                                           specialite = COALESCE(specialite, %s) WHERE lieu_id = %s""",
                                 (vide(p.get("horaires")), vide(p.get("modalite")), specialite, self.dernier_doublon))
            return
        self.cur.execute("INSERT INTO restaurant (lieu_id, specialite, modalite, horaires) VALUES (%s,%s,%s,%s)",
                         (lid, specialite, vide(p.get("modalite")), vide(p.get("horaires"))))

    # ---- sites touristiques
    def site(self, f):
        p, (lon, lat) = f["properties"], f["geometry"]["coordinates"][:2]
        self.lieu(categorie="site", code_base="site-" + slugify(p["nom"]), nom=p["nom"].strip(), type_=vide(p.get("type")),
                  commune=p.get("commune"), departement=p.get("departement"), adresse=None, telephone=p.get("telephone"),
                  site_web=p.get("site_web"), description=vide(p.get("description")), source=None, date_verif=None,
                  statut="non vérifié", lon=lon, lat=lat)

    # ---- prestataires (excursions, agences)
    def prestataire(self, p):
        lat, lon = p.get("latitude"), p.get("longitude")
        lid = self.lieu(categorie="prestataire", code_base=p["id"], nom=p["nom"].strip(), type_=vide(p.get("type")),
                        commune=p.get("commune"), departement=p.get("departement"), adresse=p.get("localisation_texte"),
                        telephone=None, site_web=None, description=vide(p.get("description")), source=vide(p.get("source")),
                        date_verif=parse_date(p.get("date_verification")),
                        statut=vide(p.get("statut_verification")) or "non vérifié",
                        lon=lon if lat and lon else None, lat=lat if lat and lon else None)
        if lid is None:
            return
        self.cur.execute(
            """INSERT INTO prestataire (lieu_id, genre, famille, icone, localisation_texte, tarif_annonce, contact,
                                        source_url, note_verification, source_position)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (lid, vide(p.get("categorie")), vide(p.get("famille")), vide(p.get("icone")), vide(p.get("localisation_texte")),
             vide(p.get("tarif_annonce")), vide(p.get("contact")), vide(p.get("source_url")),
             vide(p.get("note_verification")), vide(p.get("source_position"))),
        )


# ------------------------------------------------------------------ limites administratives
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
        try:
            from pyproj import Transformer
        except ImportError:
            sys.exit("Les limites semblent être en UTM : installez pyproj (pip install pyproj) ou reprojetez en WGS84 dans QGIS.")
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


def nom_entite(props):
    for k in ("nom", "NOM", "name", "NAME", "ADM2_FR", "ADM3_FR", "admin2Name", "admin3Name"):
        if props.get(k):
            return str(props[k]).strip()
    return None


def importer_limites(cur, data_dir):
    rapport = []
    fc = charger_json(data_dir / "data" / "limites_departements.geojson")
    if fc:
        fc, msg = normaliser_crs(fc)
        n, ignores = 0, []
        for f in fc["features"]:
            nom = nom_entite(f["properties"])
            code = cle(nom)
            if code not in DEPARTEMENTS:
                ignores.append(nom)
                continue
            cur.execute(
                """UPDATE departement SET geom = ST_Multi(ST_CollectionExtract(ST_MakeValid(
                       ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)), 3)) WHERE code = %s""",
                (json.dumps(f["geometry"]), code))
            n += cur.rowcount
        rapport.append(f"départements : {n}/3 importés" + (f" ({msg})" if msg else "")
                       + (f" — {len(ignores)} autre(s) entité(s) du fichier ignorée(s)" if ignores else ""))
    fc = charger_json(data_dir / "data" / "limites_communes.geojson")
    if fc:
        fc, msg = normaliser_crs(fc)
        n = 0
        for f in fc["features"]:
            nom = nom_entite(f["properties"]) or "?"
            cur.execute(
                """INSERT INTO commune (nom, geom) VALUES (%s, ST_Multi(ST_CollectionExtract(ST_MakeValid(
                       ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)), 3)))""",
                (nom, json.dumps(f["geometry"])))
            n += 1
        # Jointure spatiale : département de chaque commune
        cur.execute("""UPDATE commune c SET departement_code = d.code FROM departement d
                       WHERE d.geom IS NOT NULL AND ST_Intersects(d.geom, ST_PointOnSurface(c.geom))""")
        rapport.append(f"communes : {n} importées" + (f" ({msg})" if msg else ""))
        # Les lieux sans commune (ex. les restaurants) la reçoivent de leur position
        cur.execute("""UPDATE lieu l SET commune = c.nom FROM commune c
                       WHERE l.commune IS NULL AND l.geom IS NOT NULL AND ST_Within(l.geom, c.geom)""")
        rapport.append(f"commune déduite de la position pour {cur.rowcount} lieu(x) qui n'en avaient pas")
    return rapport


# ------------------------------------------------------------------ programme principal
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default=str(BASE.parent), help="dossier du site (défaut : parent de backend/)")
    data_dir = Path(ap.parse_args().data_dir).resolve()
    print(f"Base : {re.sub(r':[^:@/]*@', ':***@', DB_URL)}\nDonnées : {data_dir}\n")

    with psycopg.connect(DB_URL) as conn, conn.cursor() as cur:
        print("1. Création du schéma…")
        cur.execute((BASE / "schema.sql").read_text(encoding="utf-8"))
        imp = Importeur(cur)

        print("2. Import des lieux…")
        for fichier, methode in (("hebergements.geojson", imp.hebergement), ("restaurants.geojson", imp.restaurant),
                                 ("sites.json", imp.site)):
            fc = charger_json(data_dir / fichier)
            for f in (fc or {}).get("features", []):
                methode(f)
        presta = charger_json(data_dir / "data" / "prestataires.json")
        for p in presta or []:
            imp.prestataire(p)

        print("3. Import des limites administratives…")
        rapport_limites = importer_limites(cur, data_dir)

        # Contrôle qualité : département déclaré vs département réel (jointure spatiale)
        incoherents = []
        cur.execute("SELECT count(*) FROM departement WHERE geom IS NOT NULL")
        if cur.fetchone()[0] == 3:
            cur.execute("""SELECT l.categorie, l.nom, l.departement, d.code
                           FROM lieu l JOIN departement d ON ST_Intersects(d.geom, l.geom)
                           WHERE l.departement IS DISTINCT FROM d.code ORDER BY l.categorie, l.nom""")
            incoherents = cur.fetchall()

        cur.execute("""SELECT a.categorie, a.nom, b.nom, round(ST_Distance(a.geom::geography, b.geom::geography))
                       FROM lieu a JOIN lieu b ON a.id < b.id AND a.categorie = b.categorie
                        AND a.telephone IS NOT NULL AND a.telephone = b.telephone
                        AND ST_DWithin(a.geom::geography, b.geom::geography, %s)
                       WHERE lower(a.nom) <> lower(b.nom) ORDER BY 1, 2""", (DOUBLON_DISTANCE_M,))
        possibles = cur.fetchall()

        cur.execute("SELECT categorie, count(*) FROM lieu GROUP BY 1 ORDER BY 1")
        totaux = cur.fetchall()
        cur.execute("""SELECT count(*) FILTER (WHERE geom IS NULL), count(*) FILTER (WHERE departement IS NULL) FROM lieu""")
        sans_geom, sans_dept = cur.fetchone()
        conn.commit()

    print("\n================ RAPPORT ================")
    for cat, n in totaux:
        print(f"  {cat:<13} {n:>4}")
    print(f"  (sans position : {sans_geom} — sans département : {sans_dept})")
    for ligne in rapport_limites:
        print("  limites —", ligne)
    if not rapport_limites:
        print("  limites — aucun fichier trouvé dans data/ (affichage des limites et contrôle spatial désactivés)")
    if imp.doublons_ecartes:
        print(f"\n{len(imp.doublons_ecartes)} doublon(s) fusionné(s) à l'import :")
        for cat, nom, detail in imp.doublons_ecartes:
            print(f"  - [{cat}] {nom} : {detail}")
    if possibles:
        print(f"\n{len(possibles)} doublon(s) possible(s) (noms différents, même téléphone, < {DOUBLON_DISTANCE_M} m) — NON fusionnés :")
        for cat, a, b, d in possibles:
            print(f"  - [{cat}] « {a} » et « {b} » ({int(d)} m)")
    if incoherents:
        print(f"\n{len(incoherents)} lieu(x) dont le département déclaré ≠ département réel (jointure spatiale) :")
        for cat, nom, decl, reel in incoherents[:15]:
            print(f"  - [{cat}] {nom} : déclaré {decl}, situé en {reel}")
        if len(incoherents) > 15:
            print(f"  … et {len(incoherents) - 15} autres")
    print("\nTerminé.")


if __name__ == "__main__":
    try:
        main()
    except psycopg.OperationalError as e:
        sys.exit(f"Connexion impossible à PostgreSQL : {e}\nVérifiez DATABASE_URL dans backend/.env et que la base existe.")
