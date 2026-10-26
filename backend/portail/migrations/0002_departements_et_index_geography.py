from django.db import migrations

DEPARTEMENTS = [("THIES", "Thiès"), ("MBOUR", "Mbour"), ("TIVAOUANE", "Tivaouane")]


def creer_departements(apps, schema_editor):
    Departement = apps.get_model("portail", "Departement")
    for code, nom in DEPARTEMENTS:
        Departement.objects.get_or_create(code=code, defaults={"nom": nom})


class Migration(migrations.Migration):
    dependencies = [("portail", "0001_initial")]

    operations = [
        migrations.RunPython(creer_departements, migrations.RunPython.noop),
        # Index GiST sur la conversion en « geography » : accélère les requêtes en mètres (ST_DWithin, ST_Distance)
        migrations.RunSQL(
            "CREATE INDEX IF NOT EXISTS lieu_geog_gix ON portail_lieu USING GIST ((geom::geography));",
            "DROP INDEX IF EXISTS lieu_geog_gix;",
        ),
    ]
