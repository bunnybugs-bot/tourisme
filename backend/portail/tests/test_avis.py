"""Avis des visiteurs : dépôt, modération a priori, validations et protection contre les robots."""
from django.core.cache import cache
from django.test import TestCase

from portail.models import AvisVisiteur


class AvisTests(TestCase):
    def setUp(self):
        cache.clear()                                    # remet à zéro le compteur de limitation de débit

    def poster(self, **donnees):
        base = {"page": "thies", "nom": "Awa", "note": 5, "commentaire": "Très belle visite de la gare et du musée."}
        base.update(donnees)
        return self.client.post("/api/avis", base, content_type="application/json")

    def test_depot_en_attente_de_moderation(self):
        r = self.poster()
        self.assertEqual(r.status_code, 201)
        avis = AvisVisiteur.objects.get()
        self.assertFalse(avis.approuve)
        self.assertEqual(self.client.get("/api/avis?page=thies").json()["nombre"], 0)   # rien de publié avant validation

    def test_seuls_les_avis_valides_sont_publies(self):
        AvisVisiteur.objects.create(page="thies", nom="A", note=4, commentaire="Avis validé par l'équipe", approuve=True)
        AvisVisiteur.objects.create(page="thies", nom="B", note=1, commentaire="Avis encore en attente", approuve=False)
        AvisVisiteur.objects.create(page="mbour", nom="C", note=2, commentaire="Avis d'une autre page", approuve=True)
        d = self.client.get("/api/avis?page=thies").json()
        self.assertEqual(d["nombre"], 1)
        self.assertEqual(d["moyenne"], 4.0)
        self.assertEqual([a["nom"] for a in d["avis"]], ["A"])
        self.assertEqual(set(d["avis"][0]), {"nom", "note", "commentaire", "date"})       # ni identifiant ni statut exposés

    def test_validations(self):
        self.assertEqual(self.poster(note=6).status_code, 400)
        self.assertEqual(self.poster(note=0).status_code, 400)
        self.assertEqual(self.poster(commentaire="court").status_code, 400)
        self.assertEqual(self.poster(nom=" ").status_code, 400)
        self.assertEqual(self.poster(page="dakar").status_code, 400)
        self.assertEqual(AvisVisiteur.objects.count(), 0)

    def test_champ_piege(self):
        self.assertEqual(self.poster(site_web="http://spam.example").status_code, 400)
        self.assertEqual(AvisVisiteur.objects.count(), 0)

    def test_page_obligatoire_en_lecture(self):
        r = self.client.get("/api/avis")
        self.assertEqual(r.status_code, 400)
        self.assertIn("error", r.json())

    def test_limitation_du_depot(self):
        codes = [self.poster().status_code for _ in range(6)]
        self.assertEqual(codes[:5], [201] * 5)
        self.assertEqual(codes[5], 429)
        self.assertEqual(self.client.get("/api/avis?page=thies").status_code, 200)   # la lecture n'est pas limitée de la même façon
