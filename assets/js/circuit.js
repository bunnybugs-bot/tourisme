/* ============================================================
   CIRCUIT — calcul de l'ordre de visite (problème du voyageur de commerce)
   Utilisable dans le navigateur (window.Circuit) et sous Node (module.exports).

   Méthode : plus proche voisin (solution de départ) puis amélioration 2-opt.
   Les distances sont à vol d'oiseau (formule de Haversine, en mètres).
   Le même algorithme existe côté serveur (backend/circuit.py) avec des
   distances calculées par PostGIS.
   ============================================================ */
(function (root) {
  'use strict';

  const R_TERRE = 6371008.8; // rayon moyen de la Terre (m)

  /** Distance Haversine entre deux points {lat, lon}, en mètres. */
  function haversine(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R_TERRE * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function matriceDistances(points) {
    return points.map(a => points.map(b => haversine(a, b)));
  }

  /** Longueur d'un parcours (liste d'indices). boucle = retour au point de départ. */
  function longueur(ordre, M, boucle) {
    let d = 0;
    for (let i = 1; i < ordre.length; i++) d += M[ordre[i - 1]][ordre[i]];
    if (boucle && ordre.length > 2) d += M[ordre[ordre.length - 1]][ordre[0]];
    return d;
  }

  /** Plus proche voisin à partir de l'indice `depart`. */
  function plusProcheVoisin(M, depart) {
    const n = M.length;
    const vus = new Array(n).fill(false);
    const ordre = [depart];
    vus[depart] = true;
    for (let k = 1; k < n; k++) {
      const cur = ordre[ordre.length - 1];
      let best = -1, bd = Infinity;
      for (let j = 0; j < n; j++) {
        if (!vus[j] && M[cur][j] < bd) { bd = M[cur][j]; best = j; }
      }
      ordre.push(best);
      vus[best] = true;
    }
    return ordre;
  }

  /** Amélioration 2-opt : inverse des segments tant que la longueur diminue. Le 1er point reste fixe. */
  function deuxOpt(ordre, M, boucle) {
    const n = ordre.length;
    let meilleur = ordre.slice();
    let dMeilleur = longueur(meilleur, M, boucle);
    let ameliore = true, passes = 0;
    while (ameliore && passes++ < 100) {
      ameliore = false;
      for (let i = 1; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
          const cand = meilleur.slice(0, i)
            .concat(meilleur.slice(i, j + 1).reverse(), meilleur.slice(j + 1));
          const d = longueur(cand, M, boucle);
          if (d < dMeilleur - 1e-6) { meilleur = cand; dMeilleur = d; ameliore = true; }
        }
      }
    }
    return meilleur;
  }

  /**
   * Optimise l'ordre de visite.
   * @param {{lat:number, lon:number}[]} points  points[0] = point de départ (fixe)
   * @param {{boucle?:boolean}} opts             boucle = revenir au départ
   * @returns {{ordre:number[], distance_m:number, distance_initiale_m:number}}
   *          ordre = indices dans `points`, en commençant par 0
   */
  function optimiser(points, opts) {
    const boucle = !!(opts && opts.boucle);
    const n = points.length;
    const identite = points.map((_, i) => i);
    if (n < 3) {
      const M0 = matriceDistances(points);
      const d0 = longueur(identite, M0, boucle);
      return { ordre: identite, distance_m: d0, distance_initiale_m: d0 };
    }
    const M = matriceDistances(points);
    const initiale = longueur(identite, M, boucle);
    const ordre = deuxOpt(plusProcheVoisin(M, 0), M, boucle);
    return { ordre, distance_m: longueur(ordre, M, boucle), distance_initiale_m: initiale };
  }

  /** Durée estimée (s) : distance à vol d'oiseau × coefficient routier / vitesse moyenne. */
  function dureeEstimee(distance_m, vitesseKmh) {
    const COEF_ROUTE = 1.3;
    return (distance_m * COEF_ROUTE) / ((vitesseKmh || 40) * 1000 / 3600);
  }

  const API = { haversine, matriceDistances, longueur, plusProcheVoisin, deuxOpt, optimiser, dureeEstimee };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.Circuit = API;
})(typeof window !== 'undefined' ? window : globalThis);
