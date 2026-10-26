#!/usr/bin/env python3
# tools/nettoyer_donnees.py
"""
Nettoie les GeoJSON sources : reclassements, doublons, téléphones, UTF-8.
Usage : python tools/nettoyer_donnees.py
"""
import json
import re
import unicodedata
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

# ---------- Reclassements manuels identifiés ----------
RECLASSEMENTS = {
    # nom -> (nouvelle_categorie, nouveau_type)
    "Restaurant Big Faim": ("restaurant", "Restaurant"),
    "Adjana Resort": ("hebergement", "Résidence hôtelière"),
    "Hôtel": ("restaurant", None),  # Mboro, à retirer si pas de nom réel
}

# ---------- Utilitaires ----------
def slugify(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[^\w\s-]", "", s).strip().lower()
    return re.sub(r"[\s_-]+", "-", s)

def format_tel(tel):
    if not tel:
        return ""
    digits = re.sub(r"\D", "", str(tel))
    # enlever indicatif pays si présent
    if digits.startswith("221") and len(digits) > 9:
        digits = digits[3:]
    if len(digits) == 9:
        return f"+221 {digits[:2]} {digits[2:5]} {digits[5:7]} {digits[7:]}"
    return tel

def clean_string(s):
    if not isinstance(s, str):
        return s
    return re.sub(r"\s+", " ", s).strip()

def distance_approx_m(lat1, lon1, lat2, lon2):
    """Distance approximative en mètres (Haversine simplifiée)."""
    from math import radians, sin, cos, sqrt, atan2
    R = 6371000
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat/2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)**2
    return 2 * R * atan2(sqrt(a), sqrt(1-a))

# ---------- Traitement ----------
def process_file(path, categorie_defaut):
    print(f"\n📂 {path.name}")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    features = data["features"]
    print(f"   Entrées initiales : {len(features)}")

    # 1. Nettoyage propriétés
    for feat in features:
        p = feat["properties"]
        for k in ("nom", "adresse", "commune", "departement", "type", "quartier_village"):
            if k in p and isinstance(p[k], str):
                p[k] = clean_string(p[k])
        if "telephone" in p:
            p["telephone"] = format_tel(p["telephone"])

    # 2. Reclassements
    reclasses = 0
    for feat in features:
        nom = feat["properties"].get("nom", "")
        if nom in RECLASSEMENTS:
            new_cat, new_type = RECLASSEMENTS[nom]
            if feat["properties"].get("categorie") != new_cat:
                feat["properties"]["categorie"] = new_cat
                if new_type:
                    feat["properties"]["type"] = new_type
                reclasses += 1
    print(f"   Reclassements   : {reclasses}")

    # 3. Déduplication (nom identique + < 50 m OU nom identique exact)
    seen = []
    uniques = []
    dupes = 0
    for feat in features:
        p = feat["properties"]
        nom_key = slugify(p.get("nom", ""))
        lon, lat = feat["geometry"]["coordinates"]

        is_dupe = False
        for prev in seen:
            if prev["nom_key"] == nom_key:
                # doublon si même nom exact OU < 80 m
                d = distance_approx_m(lat, lon, prev["lat"], prev["lon"])
                if d < 80:
                    is_dupe = True
                    break
        if is_dupe:
            dupes += 1
            continue
        seen.append({"nom_key": nom_key, "lat": lat, "lon": lon})
        uniques.append(feat)

    print(f"   Doublons retirés: {dupes}")
    print(f"   Entrées finales : {len(uniques)}")

    # 4. Ajout slug + updated_at
    now = datetime.utcnow().isoformat() + "Z"
    for feat in uniques:
        p = feat["properties"]
        p["slug"] = slugify(p.get("nom", ""))
        p["updated_at"] = now

    data["features"] = uniques
    return data

def main():
    files = [
        (ROOT / "hebergements.geojson", "hebergement"),
        (ROOT / "restaurants.geojson", "restaurant"),
    ]
    for path, cat in files:
        if not path.exists():
            print(f"⚠️  Fichier absent : {path}")
            continue
        data = process_file(path, cat)
        out = DATA / path.name
        with open(out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        print(f"   ✅ Écrit : {out}")

    print("\n🎉 Nettoyage terminé.")

if __name__ == "__main__":
    main()