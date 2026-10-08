#!/usr/bin/env bash
# Build an Overture-schema building tileset (buildings + building parts) for a bounding box.
# Usage: scripts/buildings/overture-to-pmtiles.sh <west> <south> <east> <north> <out.pmtiles> [release]
# Needs: duckdb (with network access to Overture's public S3 bucket) and tippecanoe >= 2.17.
set -euo pipefail

if [ "$#" -lt 5 ]; then
  echo "usage: $0 <west> <south> <east> <north> <out.pmtiles> [release]" >&2
  exit 1
fi
W=$1 S=$2 E=$3 N=$4 OUT=$5 REL=${6:-2026-09-23.1}
BASE="s3://overturemaps-us-west-2/release/$REL/theme=buildings"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BBOX="bbox.xmin < $E AND bbox.xmax > $W AND bbox.ymin < $N AND bbox.ymax > $S"
COLUMNS="height, min_height, roof_shape, roof_height, roof_direction, roof_orientation,
  roof_color, roof_material, facade_color, facade_material"

duckdb -c "
INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';
COPY (
  SELECT hash(id) % 9007199254740991 AS fid, $COLUMNS, coalesce(has_parts, false) AS has_parts, geometry
  FROM read_parquet('$BASE/type=building/*', hive_partitioning=1) WHERE $BBOX
  UNION ALL
  SELECT hash(id) % 9007199254740991 AS fid, $COLUMNS, false AS has_parts, geometry
  FROM read_parquet('$BASE/type=building_part/*', hive_partitioning=1) WHERE $BBOX
) TO '$TMP/buildings.geojsonseq' WITH (FORMAT GDAL, DRIVER 'GeoJSONSeq');
"

tippecanoe -o "$OUT" --force -l building -Z13 -z15 \
  --use-attribute-for-id=fid --no-feature-limit --no-tile-size-limit \
  "$TMP/buildings.geojsonseq"
echo "wrote $OUT"
