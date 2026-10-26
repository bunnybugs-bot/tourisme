"""API REST : formats de réponse, filtres, validations et erreurs (base PostGIS de test)."""
from django.contrib.gis.geos import MultiPolygon, Point, Polygon
from django.test import TestCase

from portail.models import (ApplicationTransport, Departement, Hebergement, Lieu, MessageContact, Prestataire,
                            Restaurant, ServiceTransport)


def pt(lon, lat):
    return Point(lon, lat, srid=4326)


class DonneesDeTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.saly = Lieu.objects.create(categorie="hebergement", code="h-saly", nom="Hôtel Saly", type="Hôtel", commune="SALY PORTUDAL",
                                       departement_id="MBOUR", telephone="+221 33 000 00 01", geom=pt(-17.0, 14.45))
        Hebergement.objects.create(lieu=cls.saly, milieu="URBAIN", piscine=True, wifi=False)
        cls.thies = Lieu.objects.create(categorie="hebergement", code="h-thies", nom="Auberge de Thiès", type="Auberge",
                                        commune="THIES OUEST", departement_id="THIES", geom=pt(-16.93, 14.79))
        Hebergement.objects.create(lieu=cls.thies, milieu="URBAIN")
        cls.resto = Lieu.objects.create(categorie="restaurant", code="r-1", nom="Chez Awa", type="Restaurant", departement_id="MBOUR",
                                        geom=pt(-17.001, 14.451))
        Restaurant.objects.create(lieu=cls.resto, horaires="Lun-Dim 08h-23h")
        cls.site = Lieu.objects.create(categorie="site", code="s-1", nom="Réserve de Bandia", type="naturel", commune="SINDIA",
                                       departement_id="MBOUR", description="Réserve", geom=pt(-17.0, 14.55))
        cls.presta = Lieu.objects.create(categorie="prestataire", code="p-1", nom="Agence Sans Position", departement_id="MBOUR", geom=None)
        Prestataire.objects.create(lieu=cls.presta, famille="agence")
        ServiceTransport.objects.create(nom="Taxi Test", type_service="VTC", zones=["Thiès", "Mbour"], telephone="+221770000000")
        ServiceTransport.objects.create(nom="Inactif", type_service="VTC", zones=["Thiès"], actif=False)
        ApplicationTransport.objects.create(nom="Yango", zones=["Thiès", "Mbour"], site_web="https://yango.com")


class ApiTests(DonneesDeTest):
    def test_health(self):
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        j = r.json()
        self.assertEqual(j["status"], "ok")
        self.assertEqual(j["lieux"], {"hebergement": 2, "prestataire": 1, "restaurant": 1, "site": 1})
        self.assertIn("postgis", j)

    def test_lieux_par_defaut_exclut_les_prestataires_et_les_lieux_sans_position(self):
        j = self.client.get("/api/lieux").json()
        self.assertEqual(j["type"], "FeatureCollection")
        self.assertEqual(len(j["features"]), 4)
        self.assertEqual({f["properties"]["categorie"] for f in j["features"]}, {"hebergement", "restaurant", "site"})

    def test_lieux_filtres(self):
        noms = lambda url: [f["properties"]["nom"] for f in self.client.get(url).json()["features"]]
        self.assertEqual(noms("/api/lieux?categorie=hebergement&departement=thies"), ["Auberge de Thiès"])
        self.assertEqual(noms("/api/lieux?categorie=hebergement&commune=saly portudal"), ["Hôtel Saly"])      # insensible à la casse
        self.assertEqual(noms("/api/lieux?q=bandia"), ["Réserve de Bandia"])
        self.assertEqual(noms("/api/lieux?categorie=prestataire"), [])                                       # pas de position : jamais cartographié

    def test_proprietes_sans_valeur_nulle_mais_avec_faux(self):
        f = next(f for f in self.client.get("/api/lieux?categorie=hebergement&commune=SALY PORTUDAL").json()["features"])
        p = f["properties"]
        self.assertIs(p["piscine"], True)
        self.assertIs(p["wifi"], False)                         # False est une vraie valeur : conservée
        self.assertNotIn("parking", p)                          # None : retiré (comme jsonb_strip_nulls)
        self.assertEqual(p["slug"], "h-saly")
        self.assertEqual(p["departement"], "MBOUR")
        self.assertEqual(f["geometry"], {"type": "Point", "coordinates": [-17.0, 14.45]})

    def test_lieux_parametres_invalides(self):
        for url in ("/api/lieux?departement=PARIS", "/api/lieux?categorie=bar"):
            r = self.client.get(url)
            self.assertEqual(r.status_code, 400)
            self.assertIn("error", r.json())

    def test_autour_trie_par_distance_et_filtre_par_rayon(self):
        j = self.client.get("/api/autour?lat=14.45&lon=-17.0&rayon=3").json()
        d = [f["properties"]["distance_m"] for f in j["features"]]
        self.assertEqual(d, sorted(d))
        self.assertEqual(j["features"][0]["properties"]["nom"], "Hôtel Saly")
        self.assertEqual(d[0], 0)
        self.assertNotIn("Auberge de Thiès", [f["properties"]["nom"] for f in j["features"]])     # à plus de 40 km
        self.assertEqual(j["meta"]["source"], "PostGIS")
        self.assertEqual(j["meta"]["nombre"], len(j["features"]))
        self.assertEqual(j["meta"]["centre"], [-17.0, 14.45])

    def test_autour_distance_en_metres(self):
        j = self.client.get("/api/autour?lat=14.45&lon=-17.0&rayon=1&categories=restaurant").json()
        self.assertEqual(len(j["features"]), 1)
        self.assertTrue(120 < j["features"][0]["properties"]["distance_m"] < 200)          # ~0,001° en lon et en lat = environ 157 m

    def test_autour_virgule_decimale_et_erreurs(self):
        self.assertEqual(self.client.get("/api/autour?lat=14,45&lon=-17,0&rayon=1").status_code, 200)
        for url in ("/api/autour?lon=-17", "/api/autour?lat=abc&lon=1", "/api/autour?lat=14&lon=-17&rayon=0.05",
                    "/api/autour?lat=14&lon=-17&rayon=500", "/api/autour?lat=91&lon=0"):
            self.assertEqual(self.client.get(url).status_code, 400, url)

    def test_limites(self):
        r = self.client.get("/api/limites/departements")
        self.assertEqual(r.status_code, 404)                                                # pas encore de géométrie en base
        poly = Polygon(((-17.2, 14.3), (-16.8, 14.3), (-16.8, 14.7), (-17.2, 14.7), (-17.2, 14.3)), srid=4326)
        Departement.objects.filter(code="MBOUR").update(geom=MultiPolygon(poly, srid=4326))
        j = self.client.get("/api/limites/departements").json()
        self.assertEqual([f["properties"] for f in j["features"]], [{"nom": "Mbour", "code": "MBOUR"}])
        self.assertEqual(self.client.get("/api/limites/regions").status_code, 404)

    def test_circuit(self):
        pts = [{"lat": 14.79, "lon": -16.93}, {"lat": 14.45, "lon": -17.0}, {"lat": 14.55, "lon": -17.0}, {"lat": 14.50, "lon": -16.95}]
        r = self.client.post("/api/circuit", pts and {"points": pts}, content_type="application/json")
        self.assertEqual(r.status_code, 200)
        j = r.json()
        self.assertEqual(sorted(j["ordre"]), [0, 1, 2, 3])
        self.assertEqual(j["ordre"][0], 0)
        self.assertLessEqual(j["distance_m"], j["distance_initiale_m"] + 1e-6)
        self.assertEqual(j["source"], "PostGIS")

    def test_circuit_validations(self):
        ok = {"lat": 14.5, "lon": -17.0}
        cas = [{"points": [ok]}, {"points": "x"}, {}, {"points": [ok, {"lat": "a", "lon": 1}]}, {"points": [ok, {"lat": 95, "lon": 0}]},
               {"points": [ok] * 26}]
        for corps in cas:
            r = self.client.post("/api/circuit", corps, content_type="application/json")
            self.assertEqual(r.status_code, 400, corps)
            self.assertIn("error", r.json())

    def test_transports_et_applications(self):
        t = self.client.get("/api/transports").json()
        self.assertEqual([s["nom"] for s in t], ["Taxi Test"])                              # le service inactif est masqué
        self.assertEqual(t[0]["zones"], ["Thiès", "Mbour"])
        a = self.client.get("/api/applis-transport").json()
        self.assertEqual(a[0], {"id": "yango", "nom": "Yango", "zones": ["Thiès", "Mbour"], "site_web": "https://yango.com"})

    def test_contact(self):
        r = self.client.post("/api/contact", {"sujet": "signalement", "nom": "A", "email": "a@exemple.sn", "message": "Numéro de téléphone erroné"},
                             content_type="application/json")
        self.assertEqual(r.status_code, 201)
        self.assertEqual(MessageContact.objects.get().sujet, "signalement")
        bad = self.client.post("/api/contact", {"message": "x"}, content_type="application/json")
        self.assertEqual(bad.status_code, 400)
        mauvais = self.client.post("/api/contact", {"message": "Message assez long", "email": "pas-un-email"}, content_type="application/json")
        self.assertEqual(mauvais.status_code, 400)

    def test_route_inconnue_renvoie_du_json(self):
        r = self.client.get("/api/zzz")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json(), {"error": "route inconnue"})
