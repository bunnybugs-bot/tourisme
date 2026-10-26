"""Commande import_data : normalisation, doublons, limites (noms DEPT / NAME_3, UTM), prestataires sans position."""
import json
import tempfile
from io import StringIO
from pathlib import Path

from django.core.management import call_command
from django.test import TestCase
from pyproj import Transformer

from portail.models import Commune, Departement, Hebergement, Lieu, Restaurant, ServiceTransport

TR = Transformer.from_crs(4326, 32628, always_xy=True)


def feat(nom, lon, lat, **props):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": {"nom": nom, **props}}


def carre(x0, y0, x1, y1, utm=False):
    ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
    if utm:
        ring = [list(TR.transform(x, y)) for x, y in ring]
    return {"type": "Polygon", "coordinates": [ring]}


class ImportTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.dossier = Path(tempfile.mkdtemp())
        (cls.dossier / "data").mkdir()
        heb = {"type": "FeatureCollection", "features": [
            feat("Hôtel Alpha", -17.0, 14.45, categorie="hebergement", slug="alpha", type="Chambres d'hôtes", commune="TIVAOUNE",
                 departement="mbour", milieu="urbain", piscine=True),
            feat("Hôtel Alpha", -17.0001, 14.4501, categorie="hebergement", slug="alpha-bis", telephone="+221 33 111 11 11", departement="Mbour"),
            feat("Chez Tonton", -16.93, 14.79, categorie="restaurant", slug="tonton", departement="Thiès", horaires="08h-22h"),   # rangé à tort dans le fichier hébergements
        ]}
        resto = {"type": "FeatureCollection", "features": [
            feat("Le Nil", -16.92, 14.78, categorie="restaurant", slug="nil", type="Restaurant ethiopien", departement="THIES", commune="THIES NORD"),
        ]}
        sites = {"type": "FeatureCollection", "features": [feat("Colline", -16.96, 14.81, type="naturel", commune="THIES NORD", departement="THIES")]}
        presta = [{"id": "p1", "nom": "Agence A", "categorie": "agence", "famille": "agence", "latitude": 14.45, "longitude": -17.0, "departement": "MBOUR"},
                  {"id": "p2", "nom": "Agence B", "categorie": "agence", "famille": "agence", "departement": "MBOUR"}]
        deps = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"DEPT": "MBOUR"}, "geometry": carre(-17.3, 14.0, -16.7, 14.6, utm=True)},
            {"type": "Feature", "properties": {"DEPT": "THIES"}, "geometry": carre(-17.3, 14.6, -16.7, 15.0, utm=True)},
            {"type": "Feature", "properties": {"DEPT": "TIVAOUANE"}, "geometry": carre(-17.3, 15.0, -16.7, 15.4, utm=True)},
            {"type": "Feature", "properties": {"DEPT": "AUTRE"}, "geometry": carre(-17.3, 15.4, -16.7, 15.8, utm=True)}]}
        coms = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"NAME_3": "Thies Nord"}, "geometry": carre(-17.0, 14.7, -16.9, 14.9, utm=True)},
            {"type": "Feature", "properties": {"AUTRE_CHAMP": "x"}, "geometry": carre(-17.0, 14.1, -16.9, 14.2, utm=True)}]}
        for nom, contenu in (("hebergements.geojson", heb), ("restaurants.geojson", resto), ("sites.json", sites),
                             ("data/prestataires.json", presta), ("data/limites_departements.geojson", deps),
                             ("data/limites_communes.geojson", coms),
                             ("data/transports.json", [{"nom": "Taxi", "type_service": "VTC", "zones": ["Thiès"], "telephone": "+221770000000"}]),
                             ("data/applis_transport.json", [{"nom": "Yango", "zones": ["Thiès"], "site_web": "https://yango.com"}])):
            (cls.dossier / nom).write_text(json.dumps(contenu), encoding="utf-8")
        cls.sortie = StringIO()
        call_command("import_data", data_dir=str(cls.dossier), stdout=cls.sortie)

    def test_effectifs_et_garde_fou_restaurant(self):
        self.assertEqual(Lieu.objects.filter(categorie="hebergement").count(), 1)          # le doublon est fusionné
        self.assertEqual(Lieu.objects.filter(categorie="restaurant").count(), 2)           # « Chez Tonton » reclassé en restaurant
        self.assertEqual(Lieu.objects.filter(categorie="site").count(), 1)
        self.assertEqual(Lieu.objects.filter(categorie="prestataire").count(), 2)

    def test_doublon_fusionne_et_champs_completes(self):
        h = Lieu.objects.get(nom="Hôtel Alpha")
        self.assertEqual(h.telephone, "+221 33 111 11 11")                                  # complété depuis la fiche en double
        self.assertIn("1 doublon(s) fusionné(s)", self.sortie.getvalue())

    def test_normalisation(self):
        h = Lieu.objects.get(nom="Hôtel Alpha")
        self.assertEqual(h.type, "Chambre d'hôtes")
        self.assertEqual(h.departement_id, "MBOUR")                                         # « mbour » -> MBOUR
        self.assertEqual(h.hebergement.milieu, "URBAIN")
        nil = Lieu.objects.get(nom="Le Nil")
        self.assertEqual((nil.type, nil.restaurant.specialite), ("Restaurant", "Ethiopien"))

    def test_prestataire_sans_position_est_accepte(self):
        self.assertIsNone(Lieu.objects.get(nom="Agence B").geom)
        self.assertIsNotNone(Lieu.objects.get(nom="Agence A").geom)

    def test_limites_departements_lues_dans_le_champ_DEPT_et_reprojetees(self):
        self.assertEqual(Departement.objects.filter(geom__isnull=False).count(), 3)       # l'entité « AUTRE » est ignorée
        g = Departement.objects.get(code="MBOUR").geom
        self.assertAlmostEqual(g.extent[0], -17.3, places=3)                                # UTM 28N -> WGS84
        self.assertIn("départements : 3/3 importés (reprojeté depuis UTM 28N)", self.sortie.getvalue())

    def test_communes_nom_lu_dans_NAME_3_et_jamais_un_point_d_interrogation(self):
        self.assertEqual(list(Commune.objects.values_list("nom", flat=True)), ["Thies Nord"])
        self.assertIn("1 entité(s) sans nom ignorée(s)", self.sortie.getvalue())
        self.assertEqual(Commune.objects.get().departement_id, "THIES")                    # jointure spatiale

    def test_commune_non_deduite_par_defaut(self):
        self.assertIsNone(Lieu.objects.get(nom="Chez Tonton").commune)

    def test_transports_importes(self):
        self.assertEqual(ServiceTransport.objects.get().zones, ["Thiès"])

    def test_import_rejouable(self):
        sortie = StringIO()
        call_command("import_data", data_dir=str(self.dossier), stdout=sortie)
        self.assertEqual(Lieu.objects.count(), 6)                                           # pas de doublons après un second import
