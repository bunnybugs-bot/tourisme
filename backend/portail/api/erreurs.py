"""Format d'erreur unique de l'API : {"error": "message"} (identique à l'ancienne API Flask)."""
from django.db import OperationalError, ProgrammingError
from rest_framework import status
from rest_framework.exceptions import APIException
from rest_framework.response import Response
from rest_framework.views import exception_handler


class ErreurParametre(APIException):
    """Paramètre de requête absent ou invalide -> 400."""
    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = "requête invalide"


def gestionnaire(exc, context):
    if isinstance(exc, OperationalError):
        return Response({"error": "base de données indisponible"}, status=503)
    if isinstance(exc, ProgrammingError) and "does not exist" in str(exc):
        return Response({"error": "tables absentes — lancez : python manage.py migrate puis python manage.py import_data"}, status=503)
    reponse = exception_handler(exc, context)
    if reponse is not None and isinstance(reponse.data, dict) and "detail" in reponse.data:
        reponse.data = {"error": str(reponse.data["detail"])}
    elif reponse is not None and isinstance(reponse.data, (dict, list)) and not (isinstance(reponse.data, dict) and "error" in reponse.data):
        reponse.data = {"error": reponse.data}          # erreurs de validation d'un sérialiseur
    return reponse
