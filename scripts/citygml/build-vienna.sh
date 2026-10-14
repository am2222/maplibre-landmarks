#!/usr/bin/env bash
# Vienna LOD2 CityGML -> 3DCityDB -> 3D MVT tiles in demo/public/vienna-lod2.pmtiles.
#
# usage: scripts/citygml/build-vienna.sh [sheet ...]     (default: 105082, Innere Stadt)
#
# Needs Docker and python3. Sheets are the city's 3-3 digit grid numbers without the dash
# (see https://www.wien.gv.at/ma41datenviewer/public/ -> Geodaten Download -> Generalisiertes Dachmodell).
# Data: Stadt Wien – data.wien.gv.at, CC BY 4.0.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="${CITYGML_WORK:-$root/.citygml}"
db=citydb-vienna
port="${CITYDB_PORT:-5435}"
sheets=("${@:-105082}")

mkdir -p "$work/raw" "$work/out"

if ! docker ps --format '{{.Names}}' | grep -qx "$db"; then
  if docker ps -a --format '{{.Names}}' | grep -qx "$db"; then
    docker start "$db" >/dev/null
  else
    # SRID 31256 = MGI / Austria GK East; heights stay in metres above Wiener Null.
    docker run -d --name "$db" -p "$port:5432" -e POSTGRES_PASSWORD=citydb -e SRID=31256 \
      3dcitydb/3dcitydb-pg:latest >/dev/null
  fi
  until docker exec "$db" psql -U postgres -tAc 'select citydb_pkg.citydb_version()' >/dev/null 2>&1; do
    sleep 2
  done
fi

for sheet in "${sheets[@]}"; do
  zip="$work/raw/${sheet}_lod2_gml.zip"
  [ -f "$zip" ] || curl -fsSL -o "$zip" \
    "https://www.wien.gv.at/ma41datenviewer/downloads/geodaten/lod2_gml/${sheet}_lod2_gml.zip"
done

docker exec "$db" psql -U postgres -qc 'select citydb_pkg.cleanup_schema()' >/dev/null
# citydb-tool reads the zips directly (an unzipped copy next to them would import twice).
docker run --rm --network host -v "$work/raw:/data:ro" 3dcitydb/citydb-tool:latest \
  import citygml /data -H host.docker.internal -P "$port" -d postgres -u postgres -p citydb

{
  echo 'CREATE TEMP VIEW v AS'
  grep -v '^--' "$here/surfaces.sql"
  echo ';'
  echo "SELECT json_build_object('b', building_id, 'k', CASE kind WHEN 'RoofSurface' THEN 'roof' ELSE 'wall' END,"
  echo "  'tx', tx, 'ty', ty, 'g', ST_AsGeoJSON(geom, 3)::json->'coordinates') FROM v ORDER BY tx, ty, building_id, kind;"
} | docker exec -i "$db" psql -U postgres -tAq >"$work/out/surfaces.ndjson"

[ -x "$work/venv/bin/python" ] || { python3 -m venv "$work/venv" && "$work/venv/bin/pip" install -q pmtiles==3.8.1; }
"$work/venv/bin/python" -I "$here/encode3d.py" "$work/out/surfaces.ndjson" "$root/demo/public/vienna-lod2.pmtiles"
node "$here/verify3d.mjs" "$root/demo/public/vienna-lod2.pmtiles" "$work/out/surfaces.ndjson" | tail -2
