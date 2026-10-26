-- ============================================================
-- Géoportail Tourisme — Région de Thiès
-- Schéma PostgreSQL / PostGIS  (SRID 4326 = WGS84)
-- Ce fichier est rejoué à chaque import : il RECRÉE les tables.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS postgis;

DROP VIEW  IF EXISTS v_lieu;
DROP TABLE IF EXISTS prestataire, restaurant, hebergement, lieu, commune, departement CASCADE;

-- ---------- Limites administratives ----------
CREATE TABLE departement (
    code  TEXT PRIMARY KEY,                       -- THIES, MBOUR, TIVAOUANE
    nom   TEXT NOT NULL,
    geom  geometry(MultiPolygon, 4326)            -- NULL tant que les limites ne sont pas importées
);
INSERT INTO departement (code, nom) VALUES
    ('THIES', 'Thiès'), ('MBOUR', 'Mbour'), ('TIVAOUANE', 'Tivaouane');

CREATE TABLE commune (
    id               SERIAL PRIMARY KEY,
    nom              TEXT NOT NULL,
    departement_code TEXT REFERENCES departement(code),   -- déterminé par jointure spatiale
    geom             geometry(MultiPolygon, 4326) NOT NULL
);

-- ---------- Lieux (table principale) ----------
CREATE TABLE lieu (
    id                  SERIAL PRIMARY KEY,
    categorie           TEXT NOT NULL CHECK (categorie IN ('hebergement','restaurant','site','prestataire')),
    code                TEXT NOT NULL UNIQUE,     -- identifiant stable (ancien slug / id)
    nom                 TEXT NOT NULL,
    type                TEXT,
    commune             TEXT,
    departement         TEXT REFERENCES departement(code),
    adresse             TEXT,
    telephone           TEXT,
    site_web            TEXT,
    description         TEXT,
    source              TEXT,                     -- d'où vient l'information
    date_verification   DATE,                     -- quand elle a été vérifiée
    statut_verification TEXT NOT NULL DEFAULT 'non vérifié',
    geom                geometry(Point, 4326),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT lieu_geom_requise CHECK (geom IS NOT NULL OR categorie = 'prestataire')
);

-- ---------- Détails propres à chaque catégorie (1 lieu -> 0 ou 1 ligne) ----------
CREATE TABLE hebergement (
    lieu_id             INTEGER PRIMARY KEY REFERENCES lieu(id) ON DELETE CASCADE,
    milieu              TEXT CHECK (milieu IN ('URBAIN','RURAL')),
    quartier_village    TEXT,
    nb_chambres         INTEGER,
    piscine             BOOLEAN,                  -- NULL = non renseigné
    wifi                BOOLEAN,
    parking             BOOLEAN,
    accessible_handicap BOOLEAN,
    booking             TEXT,
    tripadvisor         TEXT
);

CREATE TABLE restaurant (
    lieu_id     INTEGER PRIMARY KEY REFERENCES lieu(id) ON DELETE CASCADE,
    specialite  TEXT,                             -- ex. « éthiopien », « français »
    modalite    TEXT,                             -- sur place / emporter / livraison
    horaires    TEXT
);

CREATE TABLE prestataire (
    lieu_id            INTEGER PRIMARY KEY REFERENCES lieu(id) ON DELETE CASCADE,
    genre              TEXT,                      -- agence | activite
    famille            TEXT,                      -- aventure, nautique, loisirs, agence
    icone              TEXT,
    localisation_texte TEXT,
    tarif_annonce      TEXT,
    contact            TEXT,
    source_url         TEXT,
    note_verification  TEXT,
    source_position    TEXT
);

-- ---------- Index ----------
CREATE INDEX lieu_geom_gix      ON lieu USING GIST (geom);
CREATE INDEX lieu_geog_gix      ON lieu USING GIST ((geom::geography));   -- requêtes en mètres
CREATE INDEX lieu_categorie_idx ON lieu (categorie);
CREATE INDEX lieu_dept_idx      ON lieu (departement);
CREATE INDEX lieu_commune_idx   ON lieu (lower(commune));
CREATE INDEX commune_geom_gix   ON commune USING GIST (geom);
CREATE INDEX departement_geom_gix ON departement USING GIST (geom);

-- ---------- Vue : un lieu = une géométrie + toutes ses propriétés en JSON ----------
-- Les noms de propriétés sont ceux des anciens fichiers GeoJSON : le frontend n'a rien à changer.
CREATE VIEW v_lieu AS
SELECT l.id, l.categorie, l.departement, l.commune, l.nom, l.geom,
       jsonb_strip_nulls(jsonb_build_object(
           'id', l.id, 'slug', l.code, 'nom', l.nom, 'categorie', l.categorie, 'type', l.type,
           'commune', l.commune, 'departement', l.departement, 'adresse', l.adresse,
           'telephone', l.telephone, 'site_web', l.site_web, 'description', l.description,
           'source', l.source, 'date_verification', l.date_verification,
           'statut_verification', l.statut_verification,
           -- hébergement
           'milieu', h.milieu, 'quartier_village', h.quartier_village, 'nb_chambres', h.nb_chambres,
           'piscine', h.piscine, 'wifi', h.wifi, 'parking', h.parking,
           'accessible_handicap', h.accessible_handicap, 'booking', h.booking, 'tripadvisor', h.tripadvisor,
           -- restaurant
           'specialite', r.specialite, 'modalite', r.modalite, 'horaires', r.horaires,
           -- prestataire
           'genre', p.genre, 'famille', p.famille, 'tarif_annonce', p.tarif_annonce, 'contact', p.contact
       )) AS props
FROM lieu l
LEFT JOIN hebergement h ON h.lieu_id = l.id
LEFT JOIN restaurant  r ON r.lieu_id = l.id
LEFT JOIN prestataire p ON p.lieu_id = l.id;

COMMENT ON TABLE lieu        IS 'Tous les lieux touristiques (hébergements, restaurants, sites, prestataires)';
COMMENT ON TABLE hebergement IS 'Détails des hébergements — 1 ligne par lieu de catégorie hebergement';
COMMENT ON TABLE restaurant  IS 'Détails des restaurants — 1 ligne par lieu de catégorie restaurant';
COMMENT ON TABLE prestataire IS 'Détails des agences et activités — 1 ligne par lieu de catégorie prestataire';
COMMENT ON COLUMN lieu.statut_verification IS 'non vérifié | partiellement recoupé | recensement de terrain | vérifié';
