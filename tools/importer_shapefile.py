#!/usr/bin/env python3
# tools/importer_shapefile.py
"""
Met à jour data/prestataires.json à partir du shapefile de points créé dans QGIS.

Usage : python tools/importer_shapefile.py chemin/vers/excursion.shp
Prérequis : pip install pyshp pyproj

- Les points sont reprojetés en WGS84 (EPSG:4326). Si le fichier .prj est absent,
  on suppose UTM 28N (EPSG:32628), puis on affiche un avertissement.
- Le champ numérique « id » du shapefile sert à retrouver le prestataire (ACT01, AGE10…).
- Un id inconnu = nouveau prestataire : il est créé avec les attributs du shapefile.
- Les coordonnées hors de la région de Thiès sont refusées.
"""
import json
import re
import sys
from pathlib import Path

import shapefile
from pyproj import CRS, Transformer

ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / "data" / "prestataires.json"
LAT_MIN, LAT_MAX, LON_MIN, LON_MAX = 14.3, 15.3, -17.6, -16.3
# noms de champs tronqués à 10 caractères par le format shapefile
CHAMPS = {"prestatair": "nom", "prestata_1": "categorie", "prestata_2": "type", "prestata_3": "commune",
          "prestata_4": "departement", "prestata_5": "localisation_texte", "prestata_6": "description",
          "prestata_7": "tarif_annonce", "prestata_8": "contact"}
FAMILLE_ICONE = {"agence": ("agence", "fa-route"), "activite": ("loisirs", "fa-flag-checkered")}


def formater_tel(texte):
    """9 chiffres collés (ex. 775683475) -> +221 77 568 34 75. Le reste est laissé tel quel."""
    t = (texte or "").strip()
    if re.fullmatch(r"\d{9}", t):
        return f"+221 {t[:2]} {t[2:5]} {t[5:7]} {t[7:]}"
    return t


def nettoyer_tarif(texte):
    """Retire les formules publicitaires ; garde l'information de prix."""
    t = (texte or "").strip()
    t = re.sub(r"\s*\((excellents avis[^)]*)\)", "", t, flags=re.I)
    t = re.sub(r"\s+à prix corrects", "", t, flags=re.I)
    return t


def main(chemin):
    shp = Path(chemin)
    prj = shp.with_suffix(".prj")
    if prj.exists():
        crs = CRS.from_wkt(prj.read_text())
    else:
        crs = CRS.from_epsg(32628)
        print("ATTENTION : pas de .prj, on suppose UTM 28N (EPSG:32628).")
    transfo = Transformer.from_crs(crs, 4326, always_xy=True)

    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    par_num = {int(re.sub(r"\D", "", p["id"])): p for p in data}
    maj, crees, refuses = 0, 0, []

    for sr in shapefile.Reader(str(shp)).iterShapeRecords():
        rec = sr.record.as_dict()
        num = int(rec["id"])
        x, y = sr.shape.points[0]
        lon, lat = transfo.transform(x, y)
        nom = rec["prestatair"]
        if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
            refuses.append((num, nom, round(lat, 5), round(lon, 5)))
            continue
        p = par_num.get(num)
        if p is None:                                   # nouveau prestataire
            attrs = {CHAMPS[k]: (v or "").strip() for k, v in rec.items() if k in CHAMPS}
            cat = attrs["categorie"]
            fam, ico = FAMILLE_ICONE.get(cat, ("loisirs", "fa-flag-checkered"))
            attrs["type"] = attrs["type"][:1].upper() + attrs["type"][1:]
            p = {"id": f"{'ACT' if cat == 'activite' else 'AGE'}{num:02d}", **attrs,
                 "source": "Ajout manuel par l'équipe du projet (recherche Google Maps)", "source_url": None,
                 "date_verification": None, "statut_verification": "non vérifié", "note_verification": None,
                 "famille": fam, "icone": ico}
            data.append(p)
            crees += 1
        # Les contacts et tarifs saisis dans QGIS remplacent ceux du JSON (valeurs vides ignorées)
        if (rec.get("prestata_8") or "").strip():
            p["contact"] = rec["prestata_8"].strip()
        if (rec.get("prestata_7") or "").strip():
            p["tarif_annonce"] = rec["prestata_7"].strip()
        p["contact"] = formater_tel(p.get("contact"))
        p["tarif_annonce"] = nettoyer_tarif(p.get("tarif_annonce"))
        p["latitude"], p["longitude"], p["geolocalise"] = round(lat, 6), round(lon, 6), True
        p["source_position"] = "Pointé manuellement sur fond de carte (équipe du projet) ; à confirmer sur le terrain"
        maj += 1

    JSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{maj} point(s) importé(s) dont {crees} nouveau(x) ; {sum(1 for p in data if p.get('geolocalise'))}/{len(data)} géolocalisés.")
    for r in refuses:
        print("REFUSÉ (hors région, à vérifier) :", r)
    print("Sans coordonnées :", [p["nom"] for p in data if not p.get("geolocalise")])


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
