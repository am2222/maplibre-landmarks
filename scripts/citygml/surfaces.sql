-- One row per wall/roof surface, with its building, the building's z15 tile, and 3857 geometry (Z kept).
WITH bldg AS (
  SELECT b.id AS building_id, b.objectid
  FROM citydb.feature b JOIN citydb.objectclass oc ON oc.id = b.objectclass_id
  WHERE oc.classname = 'Building'
),
-- a surface hangs off a Building directly, or off one of its BuildingParts
owner AS (
  SELECT bl.building_id, bl.building_id AS owner_id FROM bldg bl
  UNION ALL
  SELECT bl.building_id, p.val_feature_id FROM bldg bl
  JOIN citydb.property p ON p.feature_id = bl.building_id AND p.name = 'buildingPart'
),
surf AS (
  SELECT o.building_id, oc.classname AS kind, ST_Transform(g.geometry, 3857) AS geom
  FROM owner o
  JOIN citydb.property p ON p.feature_id = o.owner_id AND p.name = 'boundary'
  JOIN citydb.feature s ON s.id = p.val_feature_id
  JOIN citydb.objectclass oc ON oc.id = s.objectclass_id AND oc.classname IN ('WallSurface','RoofSurface')
  JOIN citydb.geometry_data g ON g.feature_id = s.id
),
-- one anchor per building: 2D centre and lowest Z of everything it owns
anchor AS (
  SELECT building_id,
         ST_Centroid(ST_Force2D(ST_Collect(geom))) AS c,
         min(ST_ZMin(geom)) AS zmin
  FROM surf GROUP BY building_id
)
SELECT s.building_id, s.kind, a.zmin,
       floor((ST_X(a.c) + 20037508.342789244) / (40075016.68557849 / 32768))::int AS tx,
       floor((20037508.342789244 - ST_Y(a.c)) / (40075016.68557849 / 32768))::int AS ty,
       s.geom
FROM surf s JOIN anchor a USING (building_id)
