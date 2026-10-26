"""
Configuration automatique de GDAL / GEOS / PROJ pour GeoDjango sous Windows.

GeoDjango a besoin des bibliothèques GDAL et GEOS. Sous Linux/macOS elles sont trouvées toutes seules ;
sous Windows il faut les fournir. Les deux sources les plus courantes pour un géomaticien :
  * QGIS (installé avec ses propres DLL) :       C:\\Program Files\\QGIS 3.xx\\bin
  * OSGeo4W (installeur « Express », paquet GDAL) : C:\\OSGeo4W\\bin

Ce module cherche ces dossiers, puis renseigne GDAL_LIBRARY_PATH, GEOS_LIBRARY_PATH et PROJ_DATA.
Rien n'est modifié si vous avez déjà défini GDAL_LIBRARY_PATH dans le fichier .env.
"""
import glob
import os
import re
from pathlib import Path


def _versions_gdal(dossier):
    """[(numéro, chemin)] des gdalNNN.dll d'un dossier, du plus récent au plus ancien."""
    trouves = []
    for dll in glob.glob(os.path.join(dossier, "gdal[0-9]*.dll")):
        m = re.search(r"gdal(\d+)\.dll$", dll, re.I)
        if m:
            trouves.append((int(m.group(1)), dll))
    return sorted(trouves, reverse=True)


def _racines_candidates():
    racines = []
    if os.environ.get("OSGEO4W_ROOT"):
        racines.append(os.environ["OSGEO4W_ROOT"])
    for motif in (r"C:\OSGeo4W*", r"C:\OSGeo4W64*", r"C:\Program Files\QGIS*", r"C:\Program Files (x86)\QGIS*"):
        racines += sorted(glob.glob(motif), reverse=True)        # QGIS le plus récent d'abord
    return racines


def configurer():
    if os.name != "nt":
        return None
    chemin_gdal = os.environ.get("GDAL_LIBRARY_PATH")
    if chemin_gdal and Path(chemin_gdal).exists():
        dossier_bin = str(Path(chemin_gdal).parent)
        racine = Path(dossier_bin).parent
    else:
        dossier_bin = racine = None
        for r in _racines_candidates():
            b = os.path.join(r, "bin")
            versions = _versions_gdal(b)
            if versions:
                dossier_bin, racine = b, Path(r)
                os.environ["GDAL_LIBRARY_PATH"] = versions[0][1]
                break
        if not dossier_bin:
            return None                                          # rien trouvé : Django affichera son message d'erreur habituel
    geos = os.path.join(dossier_bin, "geos_c.dll")
    if os.path.exists(geos):
        os.environ.setdefault("GEOS_LIBRARY_PATH", geos)
    for sous in (r"share\proj", r"apps\proj\share", r"apps\gdal\share\gdal"):
        candidat = Path(racine) / sous
        if (candidat / "proj.db").exists():
            os.environ.setdefault("PROJ_DATA", str(candidat))
            os.environ.setdefault("PROJ_LIB", str(candidat))
            break
    gdal_data = Path(racine) / "share" / "gdal"
    if gdal_data.exists():
        os.environ.setdefault("GDAL_DATA", str(gdal_data))
    os.environ["PATH"] = dossier_bin + os.pathsep + os.environ.get("PATH", "")
    if hasattr(os, "add_dll_directory"):                          # Python 3.8+ : les DLL doivent être déclarées
        os.add_dll_directory(dossier_bin)
    return dossier_bin
