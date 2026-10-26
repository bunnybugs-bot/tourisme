from django.contrib import admin
from django.urls import include, path, re_path

from portail import views

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("portail.api.urls")),
    path("", views.accueil),
    re_path(r"^(?P<chemin>.+)$", views.site),               # le site statique, en dernier
]
