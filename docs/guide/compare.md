# Compare with OSM2World

[OSM2World](https://osm2world.org) builds 3D scenes from OpenStreetMap, and its roof rules are
the ones the roofs layer follows. This page shows our map (left) beside OSM2World's own 3D viewer
(right) with the cameras kept in step: drag, zoom, turn or tilt either side and the other follows.

<DemoFrame src="/demo/compare.html#17.5/48.847194/2.251772/16.4/51" title="maplibre-landmarks beside OSM2World" />

The start is the Jardin des Serres d'Auteuil in Paris. Change the place in the frame's URL
(`#zoom/lat/lng/bearing/pitch`, as on the demo), or open it full screen and move around. OSM2World's
demo only has tiles for some areas.

What to look for:

- **Roof shapes and heights** come from the same tags (`roof:shape`, `roof:height`,
  `roof:direction`, carried into Overture's `roof_*` fields), so they should match. A building
  mapped as several separate pieces gets a roof per piece, as in OSM2World.
- **Materials differ on purpose**: OSM2World textures glass, tiles and walls; this plugin shades
  roofs in flat colours that sit with the basemap.
- **Trees and landmarks** are made differently: OSM2World places its own tree models and 3D models
  from [3DMR](https://3dmr.eu); this plugin draws instanced low-poly trees and Open Landmarks models.

The right side runs OSM2World's web frontend from osm2world.org, drawing its tiles; © OpenStreetMap
contributors, 3DMR.
