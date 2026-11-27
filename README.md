# TIFF Viewer VS Code

View **TIFF**, **BigTIFF** and - *most importantly* - **GeoTIFF** images directly in VS Code, including files far larger than memory, with band composites for multi-band imagery. The majority of features are **specifically designed for working with GeoTIFFs** (e.g. satellite imagery).

This extension is built on [**TIFF/BigTIFF**](https://github.com/kiu-chan/tiff-bigtiff) by [kiu-chan](https://github.com/kiu-chan), which provides the viewer at its core: the fast, on-demand rendering of huge TIFF and BigTIFF files. TIFF Viewer VS Code started as a fork of it and adds tools for working with GeoTIFFs (loosely inspired by [QGIS](https://www.qgis.org/)). See [Credits](#credits).

Open any `.tif`, `.tiff`, `.btf`, `.tf8` or `.tf2` file and it opens in the viewer.

## Features

- **Classic TIFF and BigTIFF** (64-bit offsets), little- and big-endian.
- **Huge images**: the image is shown as tiles, like a map. Only the tiles in view are read, at the level of detail the zoom needs: a rough overview first, then sharper tiles as they arrive. Multi-gigabyte files are never loaded whole, and tiles already shown are kept for panning and zooming back.
- **Gigapixel images without overviews** (e.g. whole-slide scans): the overview appears within about a second, zooming into any area shows it at full resolution almost immediately, and the zoomed-out view sharpens progressively, starting from the centre.
- **Fast JPEG**: JPEG tiles are decoded by the browser's native decoder, in parallel, and at 1/2, 1/4 or 1/8 size when that is all the zoom needs.
- **Pyramids / overviews** (e.g. Cloud Optimized GeoTIFF): the smallest level that is sharp enough is used automatically.
- **Multi-page** files: switch pages from the toolbar or with <kbd>PageUp</kbd> / <kbd>PageDown</kbd>.
- **Compression**: none, LZW, Deflate, JPEG, PackBits, Zstandard, WebP, LERC, and CCITT fax (modified Huffman RLE, Group 3, Group 4).
- **Pixel formats**: 1 to 64 bits per sample, unsigned and signed integers, 16/32/64-bit floating point, tiled or striped, chunky or planar.
- **Colour models**: grayscale (WhiteIsZero / BlackIsZero), RGB, palette, CMYK, YCbCr, CIE L\*a\*b\*, with alpha (associated or unassociated).
- **High bit depth and float data** are contrast-stretched: by default from the image's minimum to its maximum; in the **Rendering** panel, per channel, *min–max*, *2%–98%*, or the *full range* of the data type. NaN and GDAL NoData pixels are shown as transparent.
- **Band composites** for multi-band imagery (such as satellite imagery): RGB composites and band math with colour maps, saved as presets that can apply automatically (see below).
- **Layers**, as in QGIS: GeoTIFFs (each with its own rendering), vector files (GeoJSON, KML, KMZ, Shapefile, GeoPackage, zips) and online basemaps (raster, vector tiles and WMTS), added with **+ Add layer…** and **+ Add basemap…**, reordered, hidden and made see-through; everything drawn in one coordinate system (a layer's, or any EPSG code); coordinate ticks and a scale bar. Vector files can be opened in the viewer too (**Open With…**).
- **Pixel readout**: the status bar shows the pixel under the cursor (and, for a GeoTIFF, the longitude and latitude of its centre, and the coordinate system). Press <kbd>Space</kbd>, or the status bar's values button, to show the band values and the rendered values in a table next to the cursor, and again to hide it: each band by its name in the file (or b1…bN, if no names are available). The values follow the cursor as it moves.
- **Status bar buttons**, next to the image's size: **Unbounded view** (globe; <kbd>U</kbd>), **Show coordinates & scale** (grid; <kbd>G</kbd>) and **Show band and rendered values on hovering** (pointer and table; <kbd>Space</kbd>). The first two need georeferenced layers.
- **Measure**, as QGIS's measure tools: the status bar's ruler button (<kbd>R</kbd>) measures lines (each segment and the total), areas (and perimeters; a self-intersecting polygon counts every part it encloses, as it is filled on the map) or angles, chosen from its ▾ menu. Click on the map to add points and double-click to finish (an angle finishes at its third point); right-click or <kbd>Backspace</kbd> removes the last point, and <kbd>Esc</kbd> starts over. Results are shown in the Measure panel, in the units you choose: *Ellipsoidal* (along geodesics on the WGS 84 ellipsoid, as QGIS does by default) or *Cartesian* (on the plane of the map's coordinate system). Images without georeferencing are measured in pixels.
- **OSM place search**, as QGIS's *OSM Place Search* plugin: type a place name in the box above the status bar's **OSM** button and press <kbd>Enter</kbd> (or type a space after at least four characters, as in the plugin's locator), then choose a place to go there. While the view is bounded, only places within the map's extent are listed. Places come from [Nominatim](https://nominatim.org), OpenStreetMap's search, asked as the plugin asks it, with data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors; what you search for is sent to it. Nominatim's [usage policy](https://operations.osmfoundation.org/policies/nominatim/) allows no searching at every keystroke and one search a second. Places are named, found and ordered in the language of the `tiffViewer.placeSearch.language` setting (e.g. `it`; empty: VS Code's display language): set it to QGIS's language to get the same places as the plugin.
- **Screenshots**: the status bar's camera button (<kbd>S</kbd>) saves the view as a PNG image (layers, basemaps, ticks, measurements), where and under the name you choose.
- **Info panel**: format, byte order, dimensions, bit depth, compression, tiling, pyramid levels, GDAL metadata items (as `gdalinfo` shows them), GeoTIFF keys, and every TIFF tag, including private and custom ones (by number). Long values expand on click.
- Reloads automatically when the file changes on disk.

## Controls

| Action | Mouse / trackpad | Keyboard |
| --- | --- | --- |
| Zoom | Wheel (around the pointer), pinch | <kbd>+</kbd> / <kbd>-</kbd> |
| Pan | Drag | Arrow keys (<kbd>Shift</kbd> for larger steps) |
| Fit to window | Double-click, **Fit** | <kbd>0</kbd> |
| Actual size (100%) | **1:1** | <kbd>1</kbd> |
| Next / previous page | Page selector | <kbd>PageDown</kbd> / <kbd>PageUp</kbd>, <kbd>]</kbd> / <kbd>[</kbd> |
| Info panel | **Info** | |
| Resize a side panel | Drag its left border (double-click: default width; kept until the viewer is closed) | |
| Rendering panel | **Rendering** | |
| Layers panel (GeoTIFFs) | **Layers** | |
| Pixel values in a table next to the cursor (on / off) | Values button in the status bar | <kbd>Space</kbd> |
| Coordinates & scale (GeoTIFFs, on / off) | Grid button in the status bar | <kbd>G</kbd> |
| Unbounded view (GeoTIFFs, on / off) | Globe button in the status bar | <kbd>U</kbd> |
| Coordinate system (GeoTIFFs) | Click it in the status bar | |
| Measure tool (on / off; ▾: line, area or angle) | Ruler button in the status bar | <kbd>R</kbd> |
| Add a measured point / finish | Click / double-click | |
| Remove the last measured point | Right-click | <kbd>Backspace</kbd> |
| Start the measurement over | | <kbd>Esc</kbd> |
| OSM place search (GeoTIFFs) | **OSM** button in the status bar | |
| Take a screenshot | Camera button in the status bar | <kbd>S</kbd> |

## Band composites and presets

Click **Rendering** in the toolbar to show the data your way:

- **RGB**: one expression per channel, e.g. red `B04 / 3000`, green `B03 / 3000`, blue `B02 / 3000`.
- **Single band**: one expression shown with a colour map, e.g. `(B08 - B04) / (B08 + B04)` with *RdYlGn*.
- **Paletted**: a colour for each value of a band, for classifications and masks, e.g. the Sentinel-2 scene classification `SCL` (see below).

Each channel's **min** and **max** are the values shown respectively as black and white. Leave both empty (as in a new composite) to stretch automatically: **auto =** then lets you choose, per channel, between **Min / Max** (the image's lowest and highest values, the default), **2% / 98%** (ignoring the darkest and brightest 2%), and **Full range** (the whole range of the data type, e.g. 0 to 65535 for 16-bit data). Pixels where every channel is NoData are transparent, and the value table (<kbd>Space</kbd>) shows the computed values below the raw band values under the cursor.

**Brightness**, **contrast**, **saturation** and **gamma** work as in QGIS's raster symbology: brightness from −255 to 255, contrast and saturation from −100 to 100 (0: unchanged; saturation −100: grey), gamma from 0.1 to 10 (1: unchanged; above 1 brightens dark tones).

### Legend

A raster shown as **Single band** or **Paletted** gets a legend at the lower right of the map: its colour map with the values at its ends and middle, or its classes' colours and labels. It is drawn while the raster is visible and at least partly in view, and appears in screenshots. **Show legend** in the Rendering panel turns it off or on for each raster, and **Size** scales it (50–300%). When several legends are shown, each is titled with its file's name.

### Paletted / unique values

Like QGIS's *Paletted/Unique values* renderer: each value listed in the table gets its colour, opacity and label; NoData and values not listed are transparent. Values are taken as they are when zoomed out, never averaged.

A single band of 8-bit integers (uint8 or int8) without a colour table opens paletted: its values are classified, and coloured with the *gray* ramp.

- **Classify** lists every value of the band (or expression) over the whole image. A paletted rendering has at most 256 classes: Classify stops when it finds more (continuous data suits Single band better), and loading a colour table or file with more keeps the first 256. Values already in the table keep their colour and label; new ones get colours from the **Colour ramp** (*Random colors*, as in QGIS, or a colour map).
- **+** adds a value (the next whole number), **−** deletes the selected classes, **Delete all** empties the table.
- Edit a value, colour, opacity or label in the table. Tick several classes to change their colour, opacity or label together. Changing the colour ramp re-colours every class.
- **…** offers **Load classes from layer** (the image's own colour table, for paletted TIFFs), **Load colour map from file…** and **Export colour map to file…** in QGIS's `.clr` format: one class per line, `value red green blue alpha label`.
- The value table (<kbd>Space</kbd>) shows the value under the cursor with its label.

### Band names and expressions

Expressions can use:

- `b1` … `bN`: band numbers, always available.
- The file's band descriptions (as written by GDAL, rasterio, Google Earth Engine, …), e.g. `B04`, `B8A`, `VV`. The panel lists them; click one to insert it.
- Names defined in the preset's `bands` (for files without band descriptions).
- **Variables**: named expressions, listed in the panel's **Variables** section after the bands. **+ Add variable** adds one; edit its name and expression in place; drag **⠿** to change the order (each variable can use the bands and the variables above it, the channels can use them all); **↵** inserts it into the expression being edited; **×** removes it. They are saved with the preset (`variables`).

They support `+ - * / % ^`, comparisons `< <= > >= == !=` (1 or 0), and `abs sqrt exp log log10 log2 pow min max clamp where isnan round floor ceil sin cos tan atan2`, plus `pi` and `nodata`.

`nodata` is a missing value, which is what the file's NoData pixels are inside expressions, whatever number the file uses for them; it works the same in files without a NoData value. Missing results are shown transparent (in RGB, where all three channels are missing) and read *NoData* in the value table. So `where(SCL == 9, nodata, B04)` hides cloudy pixels instead of blacking them out, `x == nodata` is 1 where `x` is missing (like `isnan(x)`) and `x != nodata` the opposite, and `where(B04 == nodata, 0, B04)` fills missing pixels with 0.

### Creating presets

The extension comes with no presets: you make the ones you need, and they appear in the **Preset** menu of the Rendering panel. They are kept in a file in your home folder, **`~/.tiff-viewer-vscode/presets.jsonc`** (on Windows, `%USERPROFILE%\.tiff-viewer-vscode\presets.jsonc`), created when the extension first starts with comments describing the format. With Remote-SSH, WSL or containers, it is in the home folder of the machine the files are on.

There are two ways to create a preset:

- **From the viewer**: set up the rendering in the **Rendering** panel, then click **Save as preset…**. It asks for a name and whether to apply the preset automatically (to files with the same number of bands, or to file names matching a pattern), and adds it to the file. **Delete preset** removes the selected one.
- **By hand**: open the file with **TIFF: Open Rendering Presets File** from the Command Palette, or the link at the bottom of the Rendering panel, and add an entry to `"presets"`. VS Code offers completion and validation while you edit, comments are allowed, and open viewers pick up the changes when you save. If the file has a syntax error, the viewer keeps the last valid presets and tells you the line.

The viewer edits only the entry concerned and keeps your comments and formatting.

| Field | Meaning |
| --- | --- |
| `name` | Name in the Preset menu (required). |
| `red`, `green`, `blue` | An RGB composite: one expression per channel. |
| `value` | Or a single expression, shown with `colormap`. |
| `range` | Values shown as black … full brightness: `[min, max]`, or an automatic stretch: `"auto"` (Min / Max), `"percentile"` (2% / 98%) or `"full"` (the data type's range). One for all channels, or a list with one per channel. Default `[0, 1]`. |
| `paletted`, `classes`, `colorRamp` | Paletted rendering: the band or expression, its classes (`value`, `color` as `#rrggbb` or `#rrggbbaa`, `label`), and the ramp used by Classify (`"random"` or a colour map). |
| `colormap` | For `value`: `gray` (default), `viridis`, `magma`, `inferno`, `plasma`, `turbo`, `RdYlGn`, `RdBu`, `Spectral`, `terrain`; add `_r` to reverse. |
| `brightness`, `contrast`, `saturation`, `gamma` | As in QGIS: brightness −255…255, contrast and saturation −100…100 (default 0), gamma 0.1…10 (default 1). |
| `bands` | Extra band names for files without band descriptions: name → band number, e.g. `{ "B04": 4 }`. |
| `variables` | Named intermediate expressions, in order: each may use the bands and the variables before it, and the channels may use them all. Each is computed once per pixel, which keeps long formulas readable and fast. |
| `match` | Apply automatically to matching files: `{ "bands": 13 }`, `{ "fileName": "S2*_L2A*.tif" }` or a list of patterns (`*` any text, `?` one character, case-insensitive), or both. |

When a file opens, the viewer shows what you last chose for that file, otherwise the first preset whose `match` fits, otherwise the image's own colours.

### Useful presets

Here we provide some example presets for Sentinel-1 and Sentinel-2 imagery.:

```jsonc
{
  "presets": [
    {
      "name": "S2-L2A optimized true colour",    // https://custom-scripts.sentinel-hub.com/custom-scripts/sentinel-2/l2a_optimized/
      "variables": {
        "ar": "clamp((B04 - 1000) / 10000 / 3, 0, 1)",   // remove "- 1000" for data before baseline 04.00
        "ag": "clamp((B03 - 1000) / 10000 / 3, 0, 1)",   // remove "- 1000" for data before baseline 04.00
        "ab": "clamp((B02 - 1000) / 10000 / 3, 0, 1)",   // remove "- 1000" for data before baseline 04.00
        "r": "((ar * (ar * (0.13 / 3) - 1) / (ar * (2 * 0.13 / 3 - 1) - 0.13 / 3) + 0.01) ^ 1.8 - 0.01 ^ 1.8) / (1.01 ^ 1.8 - 0.01 ^ 1.8)",
        "g": "((ag * (ag * (0.13 / 3) - 1) / (ag * (2 * 0.13 / 3 - 1) - 0.13 / 3) + 0.01) ^ 1.8 - 0.01 ^ 1.8) / (1.01 ^ 1.8 - 0.01 ^ 1.8)",
        "b": "((ab * (ab * (0.13 / 3) - 1) / (ab * (2 * 0.13 / 3 - 1) - 0.13 / 3) + 0.01) ^ 1.8 - 0.01 ^ 1.8) / (1.01 ^ 1.8 - 0.01 ^ 1.8)",
        "grey": "(r + g + b) / 3 * (1 - 1.2)",
        "lr": "clamp(grey + 1.2 * r, 0, 1)",
        "lg": "clamp(grey + 1.2 * g, 0, 1)",
        "lb": "clamp(grey + 1.2 * b, 0, 1)"
      },
      "red": "where(lr <= 0.0031308, 12.92 * lr, 1.055 * lr ^ 0.41666666666 - 0.055)",
      "green": "where(lg <= 0.0031308, 12.92 * lg, 1.055 * lg ^ 0.41666666666 - 0.055)",
      "blue": "where(lb <= 0.0031308, 12.92 * lb, 1.055 * lb ^ 0.41666666666 - 0.055)",
    },
    {
      "name": "S2-L2A simple true colour",    // https://custom-scripts.sentinel-hub.com/custom-scripts/sentinel-2/true_color/
      "red": "B04", "green": "B03", "blue": "B02",
      "range": [1000, 5000],    // reflectance 0 … 0.4 with the 1000 offset; [0, 4000] before baseline 04.00
    },
    {
      "name": "S2-L2A NDVI",    // https://custom-scripts.sentinel-hub.com/custom-scripts/sentinel-2/ndvi/
      "value": "(B08 - B04) / (B08 + B04)",
      "range": [-1, 1],
      "colormap": "RdYlGn"
    },
    {
      "name": "S2-L2A scene classification",    // https://custom-scripts.sentinel-hub.com/sentinel-2/scene-classification/
      "paletted": "SCL",
      "classes": [    // colors are in the #rrggbbaa format
        { "value": 0, "color": "#000000", "label": "No Data" },
        { "value": 1, "color": "#ff0000", "label": "Saturated or defective pixel" },
        { "value": 2, "color": "#2f2f2f", "label": "Topographic casted shadows" },
        { "value": 3, "color": "#643200", "label": "Cloud shadow" },
        { "value": 4, "color": "#00a000", "label": "Vegetation" },
        { "value": 5, "color": "#ffe65a", "label": "Not-vegetated" },
        { "value": 6, "color": "#0000ff", "label": "Water" },
        { "value": 7, "color": "#808080", "label": "Unclassified" },
        { "value": 8, "color": "#c0c0c0", "label": "Cloud (medium probability)" },
        { "value": 9, "color": "#ffffff", "label": "Cloud (high probability)" },
        { "value": 10, "color": "#64c8ff", "label": "Thin cirrus" },
        { "value": 11, "color": "#ff96ff", "label": "Snow or ice" }
      ]
    }
  ]
}
```

Add e.g. `"match": { "bands": 13 }` to one of them to apply it automatically to 13-band files.

Useful trick: the SCL can also mask other renderings, since band names work in any expression: `where((SCL == 3) + (SCL == 8) + (SCL == 9) + (SCL == 10), 0, B04)` shows the red band with cloud shadows, clouds and cirrus in black.

## Layers

**Layers** in the toolbar opens a panel that works like QGIS's layer list: rasters (GeoTIFFs) and vector layers, drawn on one canvas in one coordinate system. The button is greyed out for an image without georeferencing, which is shown on its own.

Vector files (GeoJSON, KML, KMZ, Shapefile, GeoPackage, zips of them) can be opened in the viewer too: right-click the file and choose **Open With… → TIFF Viewer (vector layer)** (it is never their default editor). The file is then the first layer, and rasters, other vectors and basemaps can be added to it.

The command **TIFF: Open TIFF Viewer VS Code** (Command Palette) opens a viewer without a file, for georeferenced data: it starts in EPSG:4326 over Europe, its view is always unbounded, and TIFFs without georeferencing cannot be added to it. Its coordinate system can be changed as in any viewer, and removing every layer keeps its canvas.

## Using another editor for TIFF files

This viewer is registered as the default editor for TIFF files. To open a file with something else, right-click it and choose **Open With…**. To change the default, use the `workbench.editorAssociations` setting.

## Limitations

- Layers: File Geodatabases (.gdb) are not supported; NASA GIBS layers delivered as vector tiles are not listed; images whose coordinate system cannot be expressed for proj4 have no layers; a raster layer shows its first page only; the coordinate system is chosen by EPSG code (codes proj4 knows through geotiff-geokeys-to-proj4).

- Not supported: JPEG 2000 (e.g. some Aperio SVS), old-style JPEG (compression 6), LZMA, JPEG XL, and uncompressed chroma-subsampled YCbCr.
- Pyramid levels stored in SubIFDs (as in some OME-TIFF files) are not used; those images are rendered from full resolution.
- A sharp whole-image view of a huge image without pyramid levels needs every tile of the file, so zoomed all the way out it sharpens over a while (about 2 minutes for a 52-gigapixel, 9 GB slide); a rough overview is shown meanwhile. Zooming in only reads the area in view.

## Development

```sh
npm install
npm run build          # bundle into dist/
npm run typecheck
python3 test/make_fixtures.py   # needs numpy, tifffile, imagecodecs, Pillow
npm test               # decoder tests against the fixtures, then composite tests
npm run package        # build tiff-viewer-vscode-<version>.vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

### Publishing

Pushing a version tag runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml): it tests and packages the extension, then publishes it to the Visual Studio Marketplace (Trusted Publishing, no stored token) and to Open VSX (token in the `OVSX_PAT` repository secret).

```sh
npm version patch      # or minor / major: updates package.json and creates the tag
git push --follow-tags
```

### How it works

- `src/tiffEditor.ts`: the custom editor in the extension host. It serves byte ranges of the file with positional reads.
- `src/webview/main.ts`: the viewer UI: canvas, zoom/pan, the display tile pyramid, info panel.
- `src/webview/worker.ts`: a Web Worker that parses and decodes the TIFF with [geotiff.js](https://github.com/geotiffjs/geotiff.js), using a block-cached byte-range source (`messageSource.ts`). A few helper workers (same script) decompress tiles in parallel (`decodePool.ts`).
- `src/webview/lzw.ts`: fast TIFF LZW decoder (Deflate uses the platform's `DecompressionStream`).
- `src/webview/layers.ts`, `rasterLayer.ts`, `grid.ts`, `basemap.ts`, `tilegrid.ts`, `geo.ts`, `vectors.ts`, `georef.ts`: the Layers panel; raster layers (each with its own decoder worker); the canvas grid in the chosen coordinate system; basemaps warped into it; XYZ and WMTS tile grids; projections (proj4); vector file reading; the GeoTIFF's georeferencing.
- `src/shared/measure.ts`, `src/webview/measureTool.ts`, `placeSearch.ts`: the Measure tool (geodesic lengths, areas and angles with GeographicLib) and the OSM place search (Nominatim).
- `src/presetStore.ts`: the presets file in `~/.tiff-viewer-vscode` (created, watched, and edited in place with `jsonc-parser`).
- `src/shared/expression.ts`, `presets.ts`, `colormaps.ts`, `src/webview/composite.ts`: band math (parsed and evaluated over whole tiles, since the webview forbids `eval`), presets, and composite colouring.
- `src/webview/tiff.ts`: page/pyramid discovery, chunked region reading with box-filter or nearest-neighbour downsampling, and colour conversion.
- `src/webview/ccitt.ts`: CCITT T.4 / T.6 fax decoder.
- `src/webview/jpeg.ts`: JPEG tile decoding with the browser's native decoder, optionally at reduced size (geotiff.js' decoder as fallback).

## Credits

TIFF Viewer VS Code is a fork of [TIFF/BigTIFF](https://github.com/kiu-chan/tiff-bigtiff) by [kiu-chan](https://github.com/kiu-chan), and most of what makes it work is their design and code. Many thanks to kiu-chan for building it and releasing it under the MIT licence.

From kiu-chan's TIFF/BigTIFF (version 0.1.0):

- the custom editor and the reading of byte ranges from files of any size;
- the display tile pyramid loaded on demand, with coarse levels first and progressive sharpening, which makes gigapixel images usable;
- TIFF and BigTIFF parsing, pyramid / overview and multi-page support, chunked region reading with box-filter or nearest-neighbour downsampling;
- native JPEG decoding (including reduced-size decoding), the CCITT fax decoder, and support for all the pixel formats and colour models listed above;
- contrast stretching, NoData transparency, the pixel readout and the info panel;
- the pyramid-of-tiles icon.

Added in TIFF Viewer VS Code:

- band composites and band math, colour maps, and presets kept in `~/.tiff-viewer-vscode/presets.jsonc`;
- band names from GDAL band descriptions;
- faster opening: a new LZW decoder, native Deflate, parallel tile decoding, sampled contrast statistics and a band-aware tile cache.

Both use [geotiff.js](https://github.com/geotiffjs/geotiff.js) to parse and decode TIFF files.

The basemaps offered in the Layers panel are the selection of Fan Chengyan's [Basemaps](https://github.com/Fanchengyan/Basemaps) QGIS plugin. Layers use [proj4js](https://github.com/proj4js/proj4js), [geotiff-geokeys-to-proj4](https://github.com/matafokka/geotiff-geokeys-to-proj4), [MapLibre GL JS](https://maplibre.org/), [shapefile-js](https://github.com/calvinmetcalf/shapefile-js), [togeojson](https://github.com/placemark/togeojson), [JSZip](https://stuk.github.io/jszip/) and [sql.js](https://sql.js.org/); measurements use Charles Karney's [GeographicLib](https://geographiclib.sourceforge.io/), and the OSM place search [Nominatim](https://nominatim.org). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for their licences.

## License

[MIT](LICENSE). Original work copyright kiu-chan; changes in this fork copyright Shargus. Bundles [geotiff.js](https://github.com/geotiffjs/geotiff.js) (MIT) and [jsonc-parser](https://github.com/microsoft/node-jsonc-parser) (MIT).
