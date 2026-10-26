#!/usr/bin/env python
"""Point d'entrée des commandes Django (migrate, import_data, runserver, createsuperuser, test…)."""
import os
import sys


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "geoportail.settings")
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Django est introuvable. Activez l'environnement virtuel puis lancez : pip install -r requirements.txt"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
