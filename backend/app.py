#!/usr/bin/env python3
"""
API du géoportail — Tourisme, région de Thiès  (Flask + PostgreSQL/PostGIS)

Lancer :   python app.py
Ouvrir :   http://localhost:5000/carte.html      (le même serveur sert le site et l'API)

Routes :
    GET /api/health                                      état de la base
    GET /api/autour?lat=&lon=&rayon=5&categories=…       lieux dans un rayon (km), triés par distance
    GET /api/lieux?categorie=&departement=&commune=&q=   lieux filtrés (GeoJSON)
    GET /api/limites/departements | communes             limites administratives (GeoJSON)
    POST /api/circuit   {"points":[{lat,lon},…],"boucle":false}   ordre de visite optimisé
"""
import os
import pathlib

import psycopg
from dotenv import load_dotenv
from flask import Flask, abort, jsonify, redirect, request, send_from_directory
from flask_cors import CORS
from psycopg.rows import dict_row

from circuit import optimiser as optimiser_circuit

BASE = pathlib.Path(__file__).resolve().parent
SITE = BASE.parent
load_dotenv(BASE / ".env")
DB_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/tourisme_thies")

CATEGORIES = ("hebergement", "restaurant", "site", "prestataire")
DEPARTEMENTS = ("THIES", "MBOUR", "TIVAOUANE")
RAYON_MAX_KM = 50
LIMITE_MAX = 1000
CIRCUIT_MAX_POINTS = 25

app = Flask(__name__)
app.json.ensure_ascii = False                       # accents lisibles dans les réponses
CORS(app, resources={r"/api/*": {"origins": "*"}})  # API en lecture seule


# ------------------------------------------------------------------ outils
def requete_json(sql, params=None):
    """Exécute une requête qui renvoie une seule colonne JSON nommée « fc »."""
    with psycopg.connect(DB_URL, row_factory=dict_row, connect_timeout=5) as conn:
        return conn.execute(sql, params or {}).fetchone()["fc"]


def erreur(message, code=400):
    return jsonify({"error": message}), code


def nombre(nom, defaut=None, mini=None, maxi=None):
    brut = request.args.get(nom)
    if brut is None or brut == "":
        if defaut is None:
            raise ValueError(f"paramètre « {nom} » manquant")
        return defaut
    try:
        v = float(brut.replace(",", "."))
    except ValueError:
        raise ValueError(f"« {nom} » doit être un nombre")
    if (mini is not None and v < mini) or (maxi is not None and v > maxi):
        raise ValueError(f"« {nom} » doit être compris entre {mini} et {maxi}")
    return v


def liste_categories(valeur):
    cats = [c.strip().lower() for c in (valeur or "").split(",") if c.strip()]
    if not cats:
        return list(CATEGORIES[:3])           # par défaut : hébergements, restaurants, sites
    inconnues = [c for c in cats if c not in CATEGORIES]
    if inconnues:
        raise ValueError(f"catégorie inconnue : {', '.join(inconnues)} (valeurs : {', '.join(CATEGORIES)})")
    return cats


# ------------------------------------------------------------------ API
@app.get("/api/health")
def health():
    with psycopg.connect(DB_URL, row_factory=dict_row, connect_timeout=5) as conn:
        postgis = conn.execute("SELECT postgis_version() AS v").fetchone()["v"]
        lignes = conn.execute("SELECT categorie, count(*) AS n FROM lieu GROUP BY 1 ORDER BY 1").fetchall()
        limites = conn.execute(
            "SELECT (SELECT count(*) FROM departement WHERE geom IS NOT NULL) AS d, (SELECT count(*) FROM commune) AS c"
        ).fetchone()
    return jsonify({"status": "ok", "postgis": postgis, "lieux": {r["categorie"]: r["n"] for r in lignes},
                    "limites": {"departements": limites["d"], "communes": limites["c"]}})


@app.get("/api/autour")
def autour():
    """Lieux situés dans un rayon autour d'un point, du plus proche au plus éloigné.
    Distances en mètres calculées sur l'ellipsoïde WGS84 (type geography de PostGIS)."""
    try:
        lat = nombre("lat", mini=-90, maxi=90)
        lon = nombre("lon", mini=-180, maxi=180)
        rayon_km = nombre("rayon", defaut=5, mini=0.1, maxi=RAYON_MAX_KM)
        limite = int(nombre("limite", defaut=500, mini=1, maxi=LIMITE_MAX))
        cats = liste_categories(request.args.get("categories"))
    except ValueError as e:
        return erreur(str(e))

    fc = requete_json(
        """
        WITH centre AS (
            SELECT ST_SetSRID(ST_MakePoint(%(lon)s::float8, %(lat)s::float8), 4326)::geography AS g
        ), proches AS (
            SELECT v.props, v.geom, ST_Distance(v.geom::geography, c.g) AS d
            FROM v_lieu v, centre c
            WHERE v.categorie = ANY(%(cats)s::text[])
              AND v.geom IS NOT NULL
              AND ST_DWithin(v.geom::geography, c.g, %(rayon_m)s::float8)
            ORDER BY d
            LIMIT %(limite)s
        )
        SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'meta', jsonb_build_object('source', 'PostGIS', 'centre', jsonb_build_array(%(lon)s::float8, %(lat)s::float8),
                                       'rayon_km', %(rayon_km)s::float8, 'nombre', count(*)),
            'features', COALESCE(jsonb_agg(jsonb_build_object(
                'type', 'Feature', 'geometry', ST_AsGeoJSON(geom)::jsonb,
                'properties', props || jsonb_build_object('distance_m', round(d))) ORDER BY d), '[]'::jsonb)
        ) AS fc
        FROM proches
        """,
        {"lat": lat, "lon": lon, "rayon_km": rayon_km, "rayon_m": rayon_km * 1000, "cats": cats, "limite": limite},
    )
    return jsonify(fc)


@app.post("/api/circuit")
def circuit():
    """Ordonne des étapes pour minimiser la distance parcourue.
    Corps JSON : {"points": [{"lat":…, "lon":…}, …], "boucle": false}
    Le premier point est le départ. Matrice des distances calculée par PostGIS (geography, mètres)."""
    corps = request.get_json(silent=True) or {}
    pts = corps.get("points")
    if not isinstance(pts, list) or len(pts) < 2:
        return erreur("« points » doit contenir au moins 2 points {lat, lon}")
    if len(pts) > CIRCUIT_MAX_POINTS:
        return erreur(f"{CIRCUIT_MAX_POINTS} points au maximum")
    try:
        lats = [float(p["lat"]) for p in pts]
        lons = [float(p["lon"]) for p in pts]
    except (KeyError, TypeError, ValueError):
        return erreur("chaque point doit avoir « lat » et « lon » numériques")
    if any(not -90 <= v <= 90 for v in lats) or any(not -180 <= v <= 180 for v in lons):
        return erreur("coordonnées hors limites")

    with psycopg.connect(DB_URL, row_factory=dict_row, connect_timeout=5) as conn:
        lignes = conn.execute(
            """
            WITH p AS (
                SELECT i, ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography AS g
                FROM unnest(%(lons)s::float8[], %(lats)s::float8[]) WITH ORDINALITY AS t(lon, lat, i)
            )
            SELECT a.i - 1 AS i, b.i - 1 AS j, ST_Distance(a.g, b.g) AS d FROM p a, p b
            """,
            {"lats": lats, "lons": lons},
        ).fetchall()
    n = len(pts)
    M = [[0.0] * n for _ in range(n)]
    for r in lignes:
        M[r["i"]][r["j"]] = float(r["d"])
    res = optimiser_circuit(M, bool(corps.get("boucle")))
    res["source"] = "PostGIS"
    return jsonify(res)


@app.get("/api/lieux")
def lieux():
    try:
        cats = liste_categories(request.args.get("categorie"))
    except ValueError as e:
        return erreur(str(e))
    dept = (request.args.get("departement") or "").upper().strip()
    if dept and dept not in DEPARTEMENTS:
        return erreur(f"département inconnu (valeurs : {', '.join(DEPARTEMENTS)})")
    commune = (request.args.get("commune") or "").strip()
    q = (request.args.get("q") or "").strip()

    fc = requete_json(
        """
        SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(jsonb_agg(jsonb_build_object(
                'type', 'Feature', 'geometry', ST_AsGeoJSON(geom)::jsonb, 'properties', props) ORDER BY nom), '[]'::jsonb)
        ) AS fc
        FROM v_lieu
        WHERE categorie = ANY(%(cats)s::text[])
          AND geom IS NOT NULL
          AND (%(dept)s = '' OR departement = %(dept)s)
          AND (%(commune)s = '' OR lower(commune) = lower(%(commune)s))
          AND (%(q)s = '' OR nom ILIKE '%%' || %(q)s || '%%')
        """,
        {"cats": cats, "dept": dept, "commune": commune, "q": q},
    )
    return jsonify(fc)


@app.get("/api/limites/<niveau>")
def limites(niveau):
    if niveau == "departements":
        sql = """SELECT jsonb_build_object('type', 'FeatureCollection', 'features', COALESCE(jsonb_agg(jsonb_build_object(
                    'type', 'Feature', 'geometry', ST_AsGeoJSON(geom, 6)::jsonb,
                    'properties', jsonb_build_object('nom', nom, 'code', code))), '[]'::jsonb)) AS fc
                 FROM departement WHERE geom IS NOT NULL"""
    elif niveau == "communes":
        sql = """SELECT jsonb_build_object('type', 'FeatureCollection', 'features', COALESCE(jsonb_agg(jsonb_build_object(
                    'type', 'Feature', 'geometry', ST_AsGeoJSON(geom, 6)::jsonb,
                    'properties', jsonb_build_object('nom', nom, 'departement', departement_code))), '[]'::jsonb)) AS fc
                 FROM commune"""
    else:
        return erreur("niveau inconnu (departements ou communes)", 404)
    fc = requete_json(sql)
    if not fc["features"]:
        return erreur(f"aucune limite « {niveau} » en base — importez les fichiers (python import_data.py)", 404)
    return jsonify(fc)


@app.errorhandler(404)
def introuvable(_):
    if request.path.startswith("/api/"):
        return erreur("route inconnue", 404)
    return "Page introuvable", 404


@app.errorhandler(psycopg.OperationalError)
def base_indisponible(_):
    return erreur("base de données indisponible", 503)


@app.errorhandler(psycopg.errors.UndefinedTable)
def base_vide(_):
    return erreur("tables absentes — lancez d'abord : python import_data.py", 503)


# ------------------------------------------------------------------ site statique (pratique en développement)
EXTENSIONS_OK = {".html", ".css", ".js", ".json", ".geojson", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico"}
DOSSIERS_PRIVES = {"backend", "tools"}          # jamais servis (contiennent .env, scripts, mots de passe)


@app.get("/")
def accueil():
    return redirect("/carte.html")


@app.get("/<path:chemin>")
def site(chemin):
    p = pathlib.PurePosixPath(chemin)
    if (p.parts[0] in DOSSIERS_PRIVES or any(part.startswith(".") for part in p.parts)
            or p.suffix.lower() not in EXTENSIONS_OK):
        abort(404)
    return send_from_directory(SITE, chemin)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.getenv("PORT", "5000")), debug=os.getenv("FLASK_DEBUG") == "1")
