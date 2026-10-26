"""Le site statique est servi, mais jamais le code, les fichiers cachés ni les dossiers privés."""
from django.test import TestCase


class SiteTests(TestCase):
    def test_accueil_redirige_vers_la_carte(self):
        r = self.client.get("/")
        self.assertEqual((r.status_code, r["Location"]), (302, "/carte.html"))

    def test_fichiers_publics(self):
        for chemin in ("/carte.html", "/assets/js/carte.js", "/assets/css/carte.css", "/data/transports.json"):
            r = self.client.get(chemin)
            self.assertEqual(r.status_code, 200, chemin)
            r.close()

    def test_fichiers_et_dossiers_prives_interdits(self):
        for chemin in ("/backend/.env", "/backend/manage.py", "/backend/geoportail/settings.py", "/backend_flask_archive/app.py",
                       "/.env", "/data/../backend/.env", "/tools/x.py", "/carte.py"):
            self.assertEqual(self.client.get(chemin).status_code, 404, chemin)

    def test_admin_est_protege(self):
        r = self.client.get("/admin/portail/lieu/")
        self.assertEqual(r.status_code, 302)
        self.assertIn("/admin/login/", r["Location"])
