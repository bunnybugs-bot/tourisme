from django.urls import re_path

from . import views

urlpatterns = [
    re_path(r"^health/?$", views.HealthView.as_view()),
    re_path(r"^lieux/?$", views.LieuxView.as_view()),
    re_path(r"^autour/?$", views.AutourView.as_view()),
    re_path(r"^limites/(?P<niveau>[a-z]+)/?$", views.LimitesView.as_view()),
    re_path(r"^circuit/?$", views.CircuitView.as_view()),
    re_path(r"^transports/?$", views.TransportsView.as_view()),
    re_path(r"^applis-transport/?$", views.ApplisTransportView.as_view()),
    re_path(r"^contact/?$", views.ContactView.as_view()),
    re_path(r"^.*$", views.route_inconnue),                 # toute autre adresse /api/… : erreur JSON, jamais une page HTML
]
