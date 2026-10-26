"""Interface d'administration : saisie, correction et validation des données (besoin BF13)."""
from datetime import date

from django.contrib import admin as dj_admin
from django.contrib.gis import admin

from .models import (ApplicationTransport, Commune, Departement, Hebergement, Lieu, MessageContact,
                     Prestataire, Restaurant, ServiceTransport)

dj_admin.site.site_header = "Géoportail touristique — Région de Thiès"
dj_admin.site.site_title = "Géoportail"
dj_admin.site.index_title = "Gestion des données"


class HebergementInline(admin.StackedInline):
    model = Hebergement
    max_num = 1
    can_delete = False


class RestaurantInline(admin.StackedInline):
    model = Restaurant
    max_num = 1
    can_delete = False


class PrestataireInline(admin.StackedInline):
    model = Prestataire
    max_num = 1
    can_delete = False


@admin.register(Lieu)
class LieuAdmin(admin.GISModelAdmin):
    list_display = ("nom", "categorie", "type", "commune", "departement", "statut_verification", "date_verification")
    list_filter = ("categorie", "departement", "statut_verification")
    search_fields = ("nom", "commune", "adresse", "telephone")
    readonly_fields = ("created_at",)
    list_per_page = 50
    actions = ["marquer_verifie", "marquer_non_verifie"]
    _inlines = {"hebergement": HebergementInline, "restaurant": RestaurantInline, "prestataire": PrestataireInline}

    def get_inline_instances(self, request, obj=None):
        """Sur une fiche existante, n'affiche que le bloc de détails de sa catégorie."""
        if obj is None:
            return [i(self.model, self.admin_site) for i in self._inlines.values()]
        classe = self._inlines.get(obj.categorie)
        return [classe(self.model, self.admin_site)] if classe else []

    @admin.action(description="Marquer comme vérifié (date du jour)")
    def marquer_verifie(self, request, queryset):
        n = queryset.update(statut_verification="vérifié", date_verification=date.today())
        self.message_user(request, f"{n} lieu(x) marqué(s) comme vérifié(s).")

    @admin.action(description="Marquer comme non vérifié")
    def marquer_non_verifie(self, request, queryset):
        n = queryset.update(statut_verification="non vérifié", date_verification=None)
        self.message_user(request, f"{n} lieu(x) marqué(s) comme non vérifié(s).")


@admin.register(Departement)
class DepartementAdmin(admin.GISModelAdmin):
    list_display = ("code", "nom")


@admin.register(Commune)
class CommuneAdmin(admin.GISModelAdmin):
    list_display = ("nom", "departement")
    list_filter = ("departement",)
    search_fields = ("nom",)


@admin.register(ServiceTransport)
class ServiceTransportAdmin(dj_admin.ModelAdmin):
    list_display = ("nom", "type_service", "zones", "telephone", "actif")
    list_filter = ("actif",)
    search_fields = ("nom", "type_service")


@admin.register(ApplicationTransport)
class ApplicationTransportAdmin(dj_admin.ModelAdmin):
    list_display = ("nom", "zones", "site_web", "actif")


@admin.register(MessageContact)
class MessageContactAdmin(dj_admin.ModelAdmin):
    list_display = ("created_at", "sujet", "nom", "email", "telephone", "traite")
    list_filter = ("traite", "sujet")
    search_fields = ("nom", "email", "message")
    readonly_fields = ("sujet", "nom", "email", "telephone", "message", "created_at")
    actions = ["marquer_traite"]

    @dj_admin.action(description="Marquer comme traité")
    def marquer_traite(self, request, queryset):
        self.message_user(request, f"{queryset.update(traite=True)} message(s) marqué(s) comme traité(s).")
