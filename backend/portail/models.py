"""
Modèle de données du géoportail (PostgreSQL / PostGIS, via GeoDjango).

Généralisation : tout point d'intérêt est un Lieu (attributs communs + géométrie) ; les attributs propres à une
catégorie sont dans une table liée 1–0..1 : Hebergement, Restaurant, Prestataire.
Le rattachement d'un lieu à une commune est une relation spatiale (ST_Within), pas une clé étrangère.
Stockage en WGS84 (SRID 4326) ; les distances en mètres utilisent le type « geography » (voir api/outils.py).
"""
from django.contrib.gis.db import models
from django.contrib.postgres.fields import ArrayField
from django.db.models.functions import Lower


class Departement(models.Model):
    code = models.CharField("code", max_length=20, primary_key=True)          # THIES, MBOUR, TIVAOUANE
    nom = models.CharField("nom", max_length=60)
    geom = models.MultiPolygonField("limite", srid=4326, null=True, blank=True)  # NULL tant que les limites ne sont pas importées

    class Meta:
        verbose_name = "département"
        ordering = ["nom"]

    def __str__(self):
        return self.nom


class Commune(models.Model):
    nom = models.CharField(max_length=120)
    departement = models.ForeignKey(Departement, null=True, blank=True, on_delete=models.SET_NULL, related_name="communes")
    geom = models.MultiPolygonField("limite", srid=4326)

    class Meta:
        ordering = ["nom"]

    def __str__(self):
        return self.nom


class Lieu(models.Model):
    class Categorie(models.TextChoices):
        HEBERGEMENT = "hebergement", "Hébergement"
        RESTAURANT = "restaurant", "Restaurant"
        SITE = "site", "Site touristique"
        PRESTATAIRE = "prestataire", "Prestataire (excursion, agence)"

    categorie = models.CharField(max_length=20, choices=Categorie.choices)
    code = models.CharField("identifiant stable", max_length=160, unique=True)
    nom = models.CharField(max_length=255)
    type = models.CharField(max_length=120, null=True, blank=True)
    commune = models.CharField(max_length=120, null=True, blank=True)
    departement = models.ForeignKey(Departement, null=True, blank=True, on_delete=models.SET_NULL, related_name="lieux")
    adresse = models.TextField(null=True, blank=True)
    telephone = models.CharField(max_length=80, null=True, blank=True)
    site_web = models.TextField(null=True, blank=True)
    description = models.TextField(null=True, blank=True)
    source = models.TextField("source de l'information", null=True, blank=True)
    date_verification = models.DateField(null=True, blank=True)
    statut_verification = models.CharField(
        max_length=40, default="non vérifié",
        help_text="non vérifié | partiellement recoupé | recensement de terrain | vérifié")
    geom = models.PointField("position", srid=4326, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "lieu"
        verbose_name_plural = "lieux"
        ordering = ["nom"]
        indexes = [
            models.Index(fields=["categorie"], name="lieu_categorie_idx"),
            models.Index(Lower("commune"), name="lieu_commune_lower_idx"),
        ]
        constraints = [
            models.CheckConstraint(condition=models.Q(categorie__in=["hebergement", "restaurant", "site", "prestataire"]),
                                   name="lieu_categorie_valide"),
            # une position est obligatoire, sauf pour les prestataires dont la position reste à établir
            models.CheckConstraint(condition=models.Q(geom__isnull=False) | models.Q(categorie="prestataire"),
                                   name="lieu_geom_requise"),
        ]

    def __str__(self):
        return f"{self.nom} ({self.get_categorie_display()})"


class Hebergement(models.Model):
    class Milieu(models.TextChoices):
        URBAIN = "URBAIN", "Urbain"
        RURAL = "RURAL", "Rural"

    lieu = models.OneToOneField(Lieu, primary_key=True, on_delete=models.CASCADE, related_name="hebergement")
    milieu = models.CharField(max_length=10, choices=Milieu.choices, null=True, blank=True)
    quartier_village = models.CharField(max_length=160, null=True, blank=True)
    nb_chambres = models.PositiveIntegerField(null=True, blank=True)
    piscine = models.BooleanField(null=True, blank=True, help_text="Vide = non renseigné")
    wifi = models.BooleanField(null=True, blank=True)
    parking = models.BooleanField(null=True, blank=True)
    accessible_handicap = models.BooleanField(null=True, blank=True)
    booking = models.TextField(null=True, blank=True)
    tripadvisor = models.TextField(null=True, blank=True)

    class Meta:
        verbose_name = "détails d'hébergement"
        verbose_name_plural = "détails d'hébergement"


class Restaurant(models.Model):
    lieu = models.OneToOneField(Lieu, primary_key=True, on_delete=models.CASCADE, related_name="restaurant")
    specialite = models.CharField("spécialité", max_length=120, null=True, blank=True)
    modalite = models.CharField("modalité", max_length=120, null=True, blank=True)     # sur place / emporter / livraison
    horaires = models.TextField(null=True, blank=True)

    class Meta:
        verbose_name = "détails de restaurant"
        verbose_name_plural = "détails de restaurant"


class Prestataire(models.Model):
    lieu = models.OneToOneField(Lieu, primary_key=True, on_delete=models.CASCADE, related_name="prestataire")
    genre = models.CharField(max_length=40, null=True, blank=True)       # agence | activite
    famille = models.CharField(max_length=40, null=True, blank=True)     # aventure, nautique, loisirs, agence
    icone = models.CharField(max_length=60, null=True, blank=True)
    localisation_texte = models.TextField(null=True, blank=True)
    tarif_annonce = models.TextField(null=True, blank=True)
    contact = models.TextField(null=True, blank=True)
    source_url = models.TextField(null=True, blank=True)
    note_verification = models.TextField(null=True, blank=True)
    source_position = models.TextField(null=True, blank=True)

    class Meta:
        verbose_name = "détails de prestataire"
        verbose_name_plural = "détails de prestataire"


# ---------------------------------------------------------------- transport (services et applications rattachés à des ZONES)
class ServiceTransport(models.Model):
    nom = models.CharField(max_length=160)
    type_service = models.CharField(max_length=200, help_text="ex. « VTC & Navette Aéroport », « Location de minibus »")
    zones = ArrayField(models.CharField(max_length=60), help_text="Zones desservies, séparées par des virgules : Thiès, Mbour, Saly…")
    telephone = models.CharField(max_length=40, blank=True)
    site_web = models.URLField(blank=True)
    actif = models.BooleanField(default=True)

    class Meta:
        verbose_name = "service de transport"
        verbose_name_plural = "services de transport"
        ordering = ["nom"]

    def __str__(self):
        return self.nom


class ApplicationTransport(models.Model):
    nom = models.CharField(max_length=80, unique=True)
    zones = ArrayField(models.CharField(max_length=60), help_text="Zones où la présence de l'application est CONFIRMÉE (ex. Thiès, Mbour)")
    site_web = models.URLField(blank=True)
    actif = models.BooleanField(default=True)

    class Meta:
        verbose_name = "application de transport"
        verbose_name_plural = "applications de transport"
        ordering = ["nom"]

    def __str__(self):
        return self.nom


# ---------------------------------------------------------------- messages reçus par le formulaire de contact / signalement
class MessageContact(models.Model):
    sujet = models.CharField(max_length=40, blank=True)
    nom = models.CharField(max_length=120, blank=True)
    email = models.EmailField(blank=True)
    telephone = models.CharField(max_length=40, blank=True)
    message = models.TextField(max_length=4000)
    created_at = models.DateTimeField(auto_now_add=True)
    traite = models.BooleanField("traité", default=False)

    class Meta:
        verbose_name = "message reçu"
        verbose_name_plural = "messages reçus"
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.get_sujet() or 'Message'} — {self.created_at:%d/%m/%Y}"

    def get_sujet(self):
        return self.sujet
