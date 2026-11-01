from rest_framework import serializers

from ..models import AvisVisiteur, MessageContact

SUJETS = {"", "signalement", "ajout", "info", "partenariat", "autre"}      # valeurs de la liste du formulaire de contact


class ContactSerializer(serializers.ModelSerializer):
    class Meta:
        model = MessageContact
        fields = ("sujet", "nom", "email", "telephone", "message")
        extra_kwargs = {k: {"required": False} for k in ("sujet", "nom", "email", "telephone")}

    def validate_message(self, v):
        v = v.strip()
        if len(v) < 5:
            raise serializers.ValidationError("le message est trop court")
        return v

    def validate_sujet(self, v):
        return v if v in SUJETS else "autre"


class AvisSerializer(serializers.ModelSerializer):
    """Dépôt d'un avis. « site_web » est un champ piège invisible pour un humain : rempli, il signale un robot."""
    site_web = serializers.CharField(required=False, allow_blank=True, write_only=True)

    class Meta:
        model = AvisVisiteur
        fields = ("page", "nom", "note", "commentaire", "site_web")

    def validate_nom(self, v):
        v = " ".join(v.split())
        if len(v) < 2:
            raise serializers.ValidationError("indiquez un prénom ou un pseudonyme")
        return v

    def validate_commentaire(self, v):
        v = v.strip()
        if len(v) < 10:
            raise serializers.ValidationError("le commentaire est trop court (10 caractères au moins)")
        return v

    def validate_site_web(self, v):
        if v:
            raise serializers.ValidationError("requête refusée")
        return v

    def create(self, data):
        data.pop("site_web", None)
        return super().create(data)


class AvisPublicSerializer(serializers.ModelSerializer):
    date = serializers.DateTimeField(source="created_at", format="%Y-%m-%d")

    class Meta:
        model = AvisVisiteur
        fields = ("nom", "note", "commentaire", "date")
