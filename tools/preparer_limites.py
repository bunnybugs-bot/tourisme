#!/usr/bin/env python3
# tools/preparer_limites.py
"""
Convertit un shapefile de limites administratives (QGIS, GéoSénégal, ANSD…) en GeoJSON WGS84
prêt à être affiché comme couche « Limites administratives » du géoportail (carte.html).

Usage : python tools/preparer_limites.py limites.shp champ_nom sortie
        sortie = departements  ->  data/limites_departements.geojson
        sortie = communes      ->  data/limites_communes.geojson
Exemple : python tools/preparer_limites.py departements_senegal.shp NOM departements
Prérequis : pip install pyshp pyproj
Astuce : filtrez avant (QGIS) sur la région de Thiès pour garder un fichier léger.
Utilisez les mêmes noms que dans vos données (THIES, MBOUR, TIVAOUANE pour les départements).
"""
import json
import sys
from pathlib import Path

import shapefile
from pyproj import CRS, Transformer

ROOT = Path(__file__).resolve().parent.parent


def reproj(coords, tr):
    if isinstance(coords[0], (int, float)):
        x, y = tr.transform(coords[0], coords[1])
        return [round(x, 6), round(y, 6)]
    return [reproj(c, tr) for c in coords]


def main(shp, champ, sortie):
    shp = Path(shp)
    prj = shp.with_suffix(".prj")
    crs = CRS.from_wkt(prj.read_text()) if prj.exists() else CRS.from_epsg(4326)
    if not prj.exists():
        print("ATTENTION : pas de .prj, on suppose WGS84 (EPSG:4326).")
    tr = Transformer.from_crs(crs, 4326, always_xy=True)
    feats = []
    for sr in shapefile.Reader(str(shp)).iterShapeRecords():
        geom = sr.shape.__geo_interface__
        geom = {"type": geom["type"], "coordinates": reproj(geom["coordinates"], tr)}
        nom = str(sr.record.as_dict().get(champ, "?")).strip()
        feats.append({"type": "Feature", "properties": {"nom": nom}, "geometry": geom})
    out = ROOT / "data" / f"limites_{sortie}.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False), encoding="utf-8")
    print(f"{len(feats)} entité(s) écrite(s) dans {out} ({out.stat().st_size // 1024} Ko)")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
