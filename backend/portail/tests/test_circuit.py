"""Algorithme d'ordre de visite : plus proche voisin + 2-opt (problème du voyageur de commerce)."""
import math
from itertools import permutations

from django.test import SimpleTestCase

from portail import circuit


def matrice(points):
    return [[math.dist(a, b) for b in points] for a in points]


class CircuitTests(SimpleTestCase):
    POINTS = [(0, 0), (10, 0), (1, 5), (9, 4), (5, 1), (2, 9), (8, 9)]

    def test_ordre_est_une_permutation_qui_commence_au_depart(self):
        res = circuit.optimiser(matrice(self.POINTS))
        self.assertEqual(sorted(res["ordre"]), list(range(len(self.POINTS))))
        self.assertEqual(res["ordre"][0], 0)

    def test_ne_degrade_jamais_l_ordre_initial(self):
        res = circuit.optimiser(matrice(self.POINTS))
        self.assertLessEqual(res["distance_m"], res["distance_initiale_m"] + 1e-6)

    def test_deux_opt_ameliore_le_plus_proche_voisin(self):
        M = matrice(self.POINTS)
        nn = circuit.plus_proche_voisin(M, 0)
        self.assertLessEqual(circuit.longueur(circuit.deux_opt(nn, M), M), circuit.longueur(nn, M) + 1e-9)

    def test_proche_de_l_optimum_sur_petit_cas(self):
        M = matrice(self.POINTS)
        optimum = min(circuit.longueur([0, *p], M) for p in permutations(range(1, len(self.POINTS))))
        res = circuit.optimiser(M)
        self.assertLessEqual(res["distance_m"], optimum * 1.25)       # heuristique : au pire 25 % au-dessus ici

    def test_boucle_ajoute_le_retour(self):
        M = matrice(self.POINTS)
        ouvert = circuit.optimiser(M, boucle=False)
        boucle = circuit.optimiser(M, boucle=True)
        self.assertGreater(boucle["distance_m"], 0)
        self.assertEqual(sorted(boucle["ordre"]), list(range(len(self.POINTS))))
        self.assertGreaterEqual(boucle["distance_m"], ouvert["distance_m"] - 1e-6)

    def test_moins_de_trois_points_inchanges(self):
        self.assertEqual(circuit.optimiser(matrice([(0, 0), (3, 4)]))["ordre"], [0, 1])
