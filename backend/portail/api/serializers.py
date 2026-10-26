from rest_framework import serializers

from ..models import MessageContact

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
