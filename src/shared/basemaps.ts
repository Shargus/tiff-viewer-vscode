/**
 * Basemaps offered in the Overlays panel: the selection of the Basemaps QGIS
 * plugin (https://github.com/Fanchengyan/Basemaps), as names, tile and style
 * URLs and attributions. WMTS services list their layers in their capabilities,
 * read when chosen.
 */

export interface BasemapItem {
  name: string;
  /** Tile URL with {z}/{x}/{y} or {q} (Bing quadkey); for vector tiles, the tiles of the style's vector source. */
  url: string;
  /** Vector tiles: the MapLibre / Mapbox style. */
  style?: string;
}

export type BasemapProvider =
  | { name: string; attribution: string; kind: 'xyz'; maxZoom: number; items: BasemapItem[] }
  | { name: string; attribution: string; kind: 'vector'; items: BasemapItem[] }
  | {
      name: string;
      attribution: string;
      kind: 'wmts';
      capabilities: string;
      /** Layer chosen first: identifiers matching this pattern, the last in order (e.g. the newest year). */
      defaultLayer?: string;
    };

export const BASEMAP_PROVIDERS: BasemapProvider[] = [
  {
    "name": "Esri Raster",
    "attribution": "© Esri and its licensors. All rights reserved.",
    "kind": "xyz",
    "items": [
      {
        "name": "World Imagery",
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Imagery (Clarity) Beta",
        "url": "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Street Map",
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Boundaries and Places",
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "National Geographic World Map",
        "url": "http://services.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "National Geographic Style Base",
        "url": "https://tiles.arcgis.com/tiles/P3ePLMYs2RVChkJx/arcgis/rest/services/NatGeoStyleBase/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Physical Map",
        "url": "https://services.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Terrain Base",
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Topo Map",
        "url": "http://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Hillshade",
        "url": "http://services.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Hillshade (Dark)",
        "url": "https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade_Dark/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Shaded Relief",
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Ocean",
        "url": "https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "Dark Gray",
        "url": "http://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "Light Gray",
        "url": "http://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "Artificial Sky Brightness",
        "url": "https://tiles.arcgis.com/tiles/b3fMqPOmotX6SV4k/arcgis/rest/services/ArtificialSkyBrightness/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Reference Overlay",
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Reference_Overlay/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Ocean Reference Overlay",
        "url": "https://services.arcgisonline.com/arcgis/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Transportation",
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "World Navigation Charts",
        "url": "http://services.arcgisonline.com/ArcGIS/rest/services/Specialty/World_Navigation_Charts/MapServer/tile/{z}/{y}/{x}"
      }
    ],
    "maxZoom": 19
  },
  {
    "name": "Esri Vector",
    "attribution": "© Esri and its licensors. All rights reserved.",
    "kind": "vector",
    "items": [
      {
        "name": "World Street Map",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/resources/styles/root.json"
      },
      {
        "name": "World Street Map (Night)",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/86f556a2d1fd468181855a35e344567f/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Nova",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/75f4dfdff19e445395653121a95a85db/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Modern Antique",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/effe3475f05a4d608e66fd6eeb2113c0/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Mid-Century",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/7675d44bb1e4428aa2c30a9b68f97822/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Community",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/273bf8d5c8ac400183fc24e109d20bcf/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Colored Pencil",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/4cf7e1fb9f254dcda9c8fbadb15cf0f8/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Newspaper",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/dfb04de5f3144a80bc3f9f336228d24a/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Open Street Map v2",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://basemaps.arcgis.com/arcgis/rest/services/OpenStreetMap_v2/VectorTileServer/resources/styles/root.json"
      },
      {
        "name": "Environment Surface Water and Label",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/6d188135dc814d4ea254440a3dd844df/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Environment Watersheds",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/3bfd1065c1a748c5ae2f9408c3fb1078/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Environment Detail and Label",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/8b8862d9cc894f5db44231a67ee0e41b/resources/styles/root.json?f=pjson"
      },
      {
        "name": "World Contours v2",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Contours_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/51ca3ce6a16d4080ad955dacd6dd2fe2/resources/styles/root.json?f=pjson"
      },
      {
        "name": "National Geographic Style",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/3d1a30626bbc46c582f148b9252676ce/resources/styles/root.json?f=pjson"
      },
      {
        "name": "National Geographic Style (Local Language)",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/684018c92e9b424ca8e900da8dad8b23/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Outdoor",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/659e7c1b1e374f6c8a89eefe17b23380/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Charted Territory",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/1c365daf37a744fbad748b67aa69dac8/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Environment Base",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/005b8960ddd04ae781df8d471b6726b3/resources/styles/root.json?f=pjson"
      },
      {
        "name": "World Topographic Map (with Contours and Hillshade)",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/18d32a699af64bfba4e78eba5a4dd705/resources/styles/root.json?f=pjson"
      },
      {
        "name": "World Hillshade v2",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Hillshade_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/90dd6371b5ba4685aaf8c94abcca099e/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Dark Gray Canvas",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/c11ce4f7801740b2905eb03ddc963ac8/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Dark Gray Canvas Base",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/5e9b3685f4c24d8781073dd928ebda50/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Dark Gray Canvas Reference",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/747cb7a5329c478cbe6981076cc879c5/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Dark Gray Canvas Reference (Local Language)",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/7465191cfa1f425fbe41e4d44450d559/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Enhanced Contrast Base",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/d6e5bfbe9e0b4ad0bd200262bef745b0/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Enhanced Contrast Dark Base",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/4dd826e83b044acfb519a26fc9b20f80/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Enhanced Contrast Dark Reference",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/946b41c44c9549758b89f50ce9d8872d/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Enhanced Contrast Reference",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/c8ec7c62427d484a81397aefb7e59c5f/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Human Geography Base",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/2afe5b807fa74006be6363fd243ffb30/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Human Geography Dark Base",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/d7397603e9274052808839b70812be50/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Human Geography Dark Detail",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/1ddbb25aa29c4811aaadd94de469856a/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Human Geography Dark Label",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/4a3922d6d15f405d8c2b7a448a7fbad2/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Human Geography Detail",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/97fa1365da1e43eabb90d0364326bc2d/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Human Geography Label",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/ba52238d338745b1a355407ec9df6768/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Hybrid Reference Layer",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/30d6b8271e1849cd9c3042060001f425/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Hybrid Reference Layer (Local Language)",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/2a2e806e6e654ea78ecb705149ceae9f/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Light Gray Canvas",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/8a2cba3b0ebf4140b7c0dc5ee149549a/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Light Gray Canvas Base",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/291da5eab3a0412593b66d384379f89f/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Light Gray Canvas Reference",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/1768e8369a214dfab4e2167d5c5f2454/resources/styles/root.json?f=pjson"
      },
      {
        "name": "Light Gray Canvas Reference (Local Language)",
        "url": "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf",
        "style": "https://cdn.arcgis.com/sharing/rest/content/items/3ffec1551cd14606a286622c634b0bb4/resources/styles/root.json?f=pjson"
      }
    ]
  },
  {
    "name": "Google",
    "attribution": "© Google",
    "kind": "xyz",
    "items": [
      {
        "name": "Google Maps",
        "url": "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}"
      },
      {
        "name": "Google Satellite",
        "url": "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
      },
      {
        "name": "Google Satellite Hybrid",
        "url": "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
      },
      {
        "name": "Google Terrain",
        "url": "https://mt1.google.com/vt/lyrs=t&x={x}&y={y}&z={z}"
      },
      {
        "name": "Google Terrain Hybrid",
        "url": "https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}"
      },
      {
        "name": "Google Roads",
        "url": "https://mt1.google.com/vt/lyrs=h&x={x}&y={y}&z={z}"
      }
    ],
    "maxZoom": 20
  },
  {
    "name": "OpenStreetMap",
    "attribution": "© OpenStreetMap contributors",
    "kind": "xyz",
    "items": [
      {
        "name": "Open Street Map",
        "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      },
      {
        "name": "Open Topo Map",
        "url": "https://tile.opentopomap.org/{z}/{x}/{y}.png"
      },
      {
        "name": "Open Topo Map (by Top-O-Map)",
        "url": "https://tile.top-o-map.com/relief/{z}/{x}/{y}.png"
      }
    ],
    "maxZoom": 19
  },
  {
    "name": "OpenFreeMap",
    "attribution": "OpenFreeMap © OpenMapTiles Data from OpenStreetMap",
    "kind": "vector",
    "items": [
      {
        "name": "OpenFreeMap Bright",
        "url": "https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf",
        "style": "https://tiles.openfreemap.org/styles/bright"
      },
      {
        "name": "OpenFreeMap Liberty",
        "url": "https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf",
        "style": "https://tiles.openfreemap.org/styles/liberty"
      },
      {
        "name": "OpenFreeMap Positron",
        "url": "https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf",
        "style": "https://tiles.openfreemap.org/styles/positron"
      },
      {
        "name": "OpenFreeMap Dark",
        "url": "https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf",
        "style": "https://tiles.openfreemap.org/styles/dark"
      },
      {
        "name": "OpenFreeMap Fiord",
        "url": "https://tiles.openfreemap.org/planet/latest/{z}/{x}/{y}.pbf",
        "style": "https://tiles.openfreemap.org/styles/fiord"
      }
    ]
  },
  {
    "name": "OpenRailwayMap",
    "attribution": "Rendering © OpenRailwayMap, Map data © OpenStreetMap contributors",
    "kind": "xyz",
    "items": [
      {
        "name": "Standard",
        "url": "https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png"
      },
      {
        "name": "Max Speed",
        "url": "https://tiles.openrailwaymap.org/maxspeed/{z}/{x}/{y}.png"
      },
      {
        "name": "Signals",
        "url": "https://tiles.openrailwaymap.org/signals/{z}/{x}/{y}.png"
      },
      {
        "name": "Electrified",
        "url": "https://tiles.openrailwaymap.org/electrified/{z}/{x}/{y}.png"
      },
      {
        "name": "Gauge",
        "url": "https://tiles.openrailwaymap.org/gauge/{z}/{x}/{y}.png"
      }
    ],
    "maxZoom": 19
  },
  {
    "name": "Bing",
    "attribution": "© Microsoft",
    "kind": "xyz",
    "items": [
      {
        "name": "Bing Aerial",
        "url": "http://ecn.t3.tiles.virtualearth.net/tiles/a{q}.jpeg?g=1"
      },
      {
        "name": "Bing Aerial Hybrid",
        "url": "http://ecn.t3.tiles.virtualearth.net/tiles/h{q}.jpeg?g=1"
      },
      {
        "name": "Bing Road",
        "url": "http://ecn.t3.tiles.virtualearth.net/tiles/r{q}.png?g=1"
      },
      {
        "name": "Bing Hillshade",
        "url": "http://ecn.t3.tiles.virtualearth.net/tiles/r{q}.png?g=1&shading=hill"
      },
      {
        "name": "Bing Road (Dense Labels)",
        "url": "https://ecn.dynamic.t0.tiles.virtualearth.net/comp/CompositionHandler/{q}?mkt=en-us&it=G,VE,BX,L,LA"
      },
      {
        "name": "Bing Hillshade (Dense Labels)",
        "url": "https://ecn.dynamic.t0.tiles.virtualearth.net/comp/CompositionHandler/{q}?mkt=en-us&it=G,VE,BX,L,LA&shading=hill"
      },
      {
        "name": "Bing Road (No Labels)",
        "url": "https://ecn.dynamic.t0.tiles.virtualearth.net/comp/CompositionHandler/{q}?mkt=en-us&it=G,VE,BX"
      },
      {
        "name": "Bing Hillshade (No Labels)",
        "url": "https://ecn.dynamic.t0.tiles.virtualearth.net/comp/CompositionHandler/{q}?mkt=en-us&it=G,VE,BX&shading=hill"
      }
    ],
    "maxZoom": 19
  },
  {
    "name": "CartoDB",
    "attribution": "© CARTO, © OpenStreetMap contributors",
    "kind": "xyz",
    "items": [
      {
        "name": "CartoDB Light (All)",
        "url": "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
      },
      {
        "name": "CartoDB Dark (All)",
        "url": "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
      },
      {
        "name": "CartoDB Light (No Labels)",
        "url": "https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png"
      },
      {
        "name": "CartoDB Light (Only Labels)",
        "url": "https://basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png"
      },
      {
        "name": "CartoDB Dark (No Labels)",
        "url": "https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png"
      },
      {
        "name": "CartoDB Dark (Only Labels)",
        "url": "https://basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png"
      },
      {
        "name": "CartoDB Voyager",
        "url": "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"
      },
      {
        "name": "CartoDB Voyager (No Labels)",
        "url": "https://basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png"
      },
      {
        "name": "CartoDB Voyager (Only Labels)",
        "url": "https://basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png"
      },
      {
        "name": "CartoDB Voyager (Labels Under)",
        "url": "https://basemaps.cartocdn.com/rastertiles/voyager_labels_under/{z}/{x}/{y}.png"
      }
    ],
    "maxZoom": 20
  },
  {
    "name": "F4map",
    "attribution": "F4map © F4 Map, Data © OpenStreetMap contributors",
    "kind": "xyz",
    "items": [
      {
        "name": "F4map 2D",
        "url": "https://tile1.f4map.com/tiles/f4_2d/{z}/{x}/{y}.png"
      }
    ],
    "maxZoom": 18
  },
  {
    "name": "USGS",
    "attribution": "U.S. Geological Survey, Department of the Interior",
    "kind": "xyz",
    "items": [
      {
        "name": "USGS Topo",
        "url": "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "USGS Imagery",
        "url": "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "USGS Imagery Hybrid",
        "url": "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}"
      },
      {
        "name": "USGS Imagery Plates",
        "url": "https://earthquake.usgs.gov/basemap/tiles/plates/{z}/{x}/{y}.png"
      }
    ],
    "maxZoom": 16
  },
  {
    "name": "EOX Sentinel-2 Cloudless",
    "attribution": "© EOX IT Services GmbH, contains modified Copernicus Sentinel data",
    "kind": "wmts",
    "capabilities": "https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml",
    "defaultLayer": "^s2cloudless-\\d{4}_3857$"
  },
  {
    "name": "ESRI World Imagery Wayback",
    "attribution": "© Esri and its licensors. All rights reserved.",
    "kind": "wmts",
    "capabilities": "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/WMTS/1.0.0/WMTSCapabilities.xml"
  },
  {
    "name": "NASA GIBS",
    "attribution": "NASA",
    "kind": "wmts",
    "capabilities": "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml",
    "defaultLayer": "^MODIS_Terra_CorrectedReflectance_TrueColor$"
  }
];
