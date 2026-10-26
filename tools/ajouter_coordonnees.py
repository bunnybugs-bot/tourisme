#!/usr/bin/env python3
# tools/ajouter_coordonnees.py
"""
Ajoute latitude/longitude (relevées dans QGIS) à data/prestataires.json.

Entrée : un fichier CSV ou Excel avec les colonnes  id, latitude, longitude
         (par ex. prestataires_thies_nettoye.xlsx une fois les 2 colonnes remplies).
Usage  : python tools/ajouter_coordonnees.py chemin/vers/fichier.xlsx
Les lignes sans coordonnées sont ignorées. Les coordonnées hors de la
région de Thiès sont refusées (signe d'une inversion lat/lon ou d'une faute de frappe).
"""
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
JSON_PATH = ROOT / "data" / "prestataires.json"
# Rectangle englobant approximatif de la région de Thiès (WGS84)
LAT_MIN, LAT_MAX = 14.3, 15.3
LON_MIN, LON_MAX = -17.6, -16.3


def main(chemin):
    chemin = Path(chemin)
    df = pd.read_csv(chemin) if chemin.suffix.lower() == ".csv" else pd.read_excel(chemin)
    df = df.dropna(subset=["latitude", "longitude"])
    coords = {str(r.id): (float(r.latitude), float(r.longitude)) for r in df.itertuples()}

    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    ok, refuses = 0, []
    for p in data:
        if p["id"] not in coords:
            continue
        lat, lon = coords[p["id"]]
        if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
            refuses.append((p["id"], p["nom"], lat, lon))
            continue
        p["latitude"], p["longitude"], p["geolocalise"] = round(lat, 6), round(lon, 6), True
        ok += 1

    JSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{ok} prestataire(s) géolocalisé(s) sur {len(data)}.")
    for r in refuses:
        print(f"REFUSÉ (hors région, à vérifier) : {r}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
