"""
Ordre de visite d'un circuit touristique (problème du voyageur de commerce).

Méthode : plus proche voisin (solution de départ), puis amélioration 2-opt.
Les fonctions travaillent sur une matrice de distances M (en mètres) ; dans l'API,
cette matrice est calculée par PostGIS (ST_Distance sur le type geography).
Le point 0 est le point de départ : il reste toujours en premier.
"""
from __future__ import annotations


def longueur(ordre: list[int], M: list[list[float]], boucle: bool = False) -> float:
    d = sum(M[ordre[i - 1]][ordre[i]] for i in range(1, len(ordre)))
    if boucle and len(ordre) > 2:
        d += M[ordre[-1]][ordre[0]]
    return d


def plus_proche_voisin(M: list[list[float]], depart: int = 0) -> list[int]:
    n = len(M)
    vus = {depart}
    ordre = [depart]
    while len(ordre) < n:
        cur = ordre[-1]
        suivant = min((j for j in range(n) if j not in vus), key=lambda j: M[cur][j])
        ordre.append(suivant)
        vus.add(suivant)
    return ordre


def deux_opt(ordre: list[int], M: list[list[float]], boucle: bool = False) -> list[int]:
    n = len(ordre)
    meilleur = ordre[:]
    d_meilleur = longueur(meilleur, M, boucle)
    ameliore, passes = True, 0
    while ameliore and passes < 100:
        ameliore, passes = False, passes + 1
        for i in range(1, n - 1):
            for j in range(i + 1, n):
                cand = meilleur[:i] + meilleur[i:j + 1][::-1] + meilleur[j + 1:]
                d = longueur(cand, M, boucle)
                if d < d_meilleur - 1e-6:
                    meilleur, d_meilleur, ameliore = cand, d, True
    return meilleur


def optimiser(M: list[list[float]], boucle: bool = False) -> dict:
    """Retourne l'ordre (indices, commençant par 0) et les distances en mètres."""
    n = len(M)
    identite = list(range(n))
    initiale = longueur(identite, M, boucle)
    if n < 3:
        return {"ordre": identite, "distance_m": initiale, "distance_initiale_m": initiale}
    ordre = deux_opt(plus_proche_voisin(M, 0), M, boucle)
    return {"ordre": ordre, "distance_m": longueur(ordre, M, boucle), "distance_initiale_m": initiale}
