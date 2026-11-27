# Changelog

## 0.8.0

- **Legends** for rasters shown as single band (the colour map and its values) or paletted (the classes), at the lower right of the map while the raster is in view; **Show legend** (on by default) and **Size** in the Rendering panel. Several legends are titled with their files' names.
- A plain single band image has a legend too (its grey stretch).
- Single band 8-bit images (uint8 and int8, without a colour table) open **paletted**: their values classified and coloured with the *gray* ramp.
- Choosing **Default** in the Preset menu shows the default rendering in the Rendering panel: a preset's variables and expressions no longer stay behind.

## 0.7.0

- **Measure** (status bar, <kbd>R</kbd>), as in QGIS: lines, areas and angles, chosen from the button's ▾ menu, with the results in a Measure panel. Ellipsoidal (WGS 84 geodesics) or Cartesian; in pixels for images without georeferencing.
- **OSM place search** (status bar), as QGIS's OSM place search plugin: Nominatim's places for what you type (on <kbd>Enter</kbd>, or a space after four characters), limited to the map's extent while the view is bounded; choosing one goes there and marks it. Its language is the new `tiffViewer.placeSearch.language` setting (default: VS Code's display language).
- **Take screenshot** (status bar, <kbd>S</kbd>): saves the view as a PNG image.
- **TIFF: Open TIFF Viewer VS Code** (Command Palette): a viewer without a file, for georeferenced data, in EPSG:4326 over Europe, always in unbounded view. Opening TIFF and vector files is unchanged.

## 0.6.0

- **Layers**, as in QGIS (the Layers panel replaces Overlays): GeoTIFFs (**R**), vector layers (**V**) and online basemaps (**B**) in one list, with **+ Add layer…** and **+ Add basemap…**. Drag **⠿** to reorder, click it to select a layer; each layer has its visibility, opacity, *zoom to layer* and remove. The TIFF the viewer was opened on is a layer like the others; removing every layer leaves an empty canvas, ready for new layers. Files with several layers (KML folders, GeoPackage tables, zips) ask which to load.
- **Raster layers**: other GeoTIFFs, each decoded on its own (large, tiled and pyramidal files included) and drawn at the resolution the zoom needs, exactly in the same coordinate system, warped otherwise.
- **Basemaps** are layers, added at the bottom of the list; several can be stacked. Their rendering is their localisation: label language and region for Google and Bing, label language for OpenFreeMap.
- **Coordinate system**: click it in the status bar to draw everything in WGS 84, Web Mercator, a layer's coordinate system or any EPSG code; rasters and basemaps are warped, vector layers projected, ticks and scale bar follow.
- **Unbounded view** (globe in the status bar, or <kbd>U</kbd>): pan and zoom over the whole world, on an empty chequered canvas, and add layers anywhere. Otherwise the view is bounded by the extent of the file the viewer was opened on: layers outside it are refused, and those already added are struck through in the list.
- **Rendering panel** for every layer: a **Layer** menu (or click a layer's name) chooses what it edits. Rasters have the raster view, with the **Preset** menu (moved from the toolbar), the layer's own **Bands**, and a new **Variables** section (**+ Add variable**, edit in place, drag to reorder, saved with the preset); vector layers have colour, line width and fill opacity; basemaps their language and region.
- **Status bar**: the pixel and its longitude / latitude (of the selected raster), and three icon buttons: Unbounded view, Show coordinates & scale (<kbd>G</kbd>), and Show band and rendered values on hovering (<kbd>Space</kbd>). Band and rendered values are only in that table, which lists every layer under the pointer: each raster's pixel and the attributes of the vector features there. The Info panel describes the selected raster.
- **Vector files** open in the viewer with **Open With… → TIFF Viewer (vector layer)**: the file is the first layer.
- The **mouse wheel zooms** around the pointer; the view is panned by dragging, or with the arrow keys.
- Side panels have a **×** to close them, and can be resized by dragging their left border (double-click: default width); sizes last until the viewer is closed.
- Fixed: lines and blurred blobs along the image's border when it is drawn in another coordinate system.

## 0.5.0

- Press <kbd>Space</kbd> to show the pixel readout as a table next to the cursor, with each band's name and value; press it again to go back to the status bar.
- The pixel readout follows the cursor while it moves, instead of waiting for it to stop.
- The status bar separates band values with a vertical bar.
- For GeoTIFFs, the status bar and the value table show the longitude and latitude of the pixel under the cursor, and the status bar shows the coordinate system (e.g. EPSG:32723).
- Many band values no longer push the right side of the status bar out of view: they end in … instead.
- Ctrl+scroll zoom refreshes the readout straight away.
- `nodata` in band expressions: a missing value (shown transparent), e.g. `where(SCL == 9, nodata, B04)`; `x == nodata` tests whether `x` is missing.
- <kbd>G</kbd> shows or hides the coordinates, grid and scale bar of GeoTIFFs (**Show coordinates & scale**).
- The <kbd>I</kbd> and <kbd>B</kbd> keys no longer open the Info and Rendering panels: use the toolbar buttons.
- After a preset is chosen, a button clicked or a slider moved, the keyboard goes back to the image (so Space and the other keys act on the viewer), and the Rendering panel no longer puts the cursor in the first expression when it opens.
- The README's example presets are now four for Sentinel-2 L2A: optimized and simple true colour, NDVI and scene classification (SCL), each explained.

## 0.4.0

- **Overlays** for GeoTIFFs (the button is greyed out for other images), reprojected into the image's coordinate system and clipped to its extent:
  - **Basemaps**: the Basemaps QGIS plugin's selection: raster tiles (Esri, Google, OpenStreetMap, Bing, CARTO, …), vector tiles (Esri, OpenFreeMap; drawn with MapLibre) and WMTS services (EOX Sentinel-2 cloudless, Esri Wayback, NASA GIBS with dates), above or below the image, with their own opacity.
  - **Vector layers** from GeoJSON, KML, KMZ, Shapefile, GeoPackage and zips, by path (absolute or relative to the workspace folder) or Browse (choosing which layers to load when a file has several), each with colour, width, opacity, visibility and zoom-to, and a warning when none of its features fall within the image.
  - **Show coordinates & scale**: x and y ticks along the image's lower and left borders, a thin grid at the ticks, and a scale bar, following the zoom.
  - **Image opacity**. Double-click any opacity slider to set it back to 100%.
- Third-party licences are in THIRD_PARTY_NOTICES.md.

## 0.3.0

- **Paletted / unique values** rendering, as in QGIS: a colour, opacity and label per value (up to 256 classes), with Classify (unique values of the whole band), colour ramps (including QGIS's random colours), editing several classes at once, loading the image's own colour table, and loading/exporting QGIS colour map files (`.clr`). Class values are never averaged when zoomed out.
- The **Composite** button and panel are now **Rendering** / **Band rendering**; the command is **TIFF: Open Rendering Presets File**.
- The **Info panel** lists every TIFF tag, including private and custom ones, the GDAL metadata items (e.g. custom items written by GDAL or rasterio) and the GeoTIFF keys; long values expand on click.

- **Brightness, contrast, saturation and gamma** in the Rendering panel, computed as in QGIS, each with a slider and a box to type a value (and in presets).
- **Automatic stretch per channel**: a channel with empty min and max shows "auto =" with Min / Max (default), 2% / 98% or Full range. The toolbar's Contrast menu is gone: the plain image is stretched min to max, and the Rendering panel offers the other stretches. New composites start with every channel on auto.
- RGB and Single band each keep their own settings while the image is open; choosing **Default** (formerly "Image colours": the file's own rendering) no longer resets the panel. Unsaved composites are no longer remembered after the image is closed: presets are the way to keep settings.
- The status bar shows the file size, at the right.
- Changing settings only re-colours tiles already computed, without evaluating the expressions again.
- The pixel readout shows "NoData" for NoData values.
- Fixed: float32 images whose GDAL NoData is written in shortened form (e.g. `-3.40282346638529e+38`) showed NoData pixels as data, which also spoiled the contrast stretch.
- Fixed: when zoomed out, bands whose NoData areas differ could average the NoData value of one band into its valid pixels; each band now leaves out its own NoData.
- Fixed: after changing visualization settings, parts of the image could keep the old rendering for good (sharper tiles left from zooming in were drawn over the new ones).
- Fixed: after using the viewer for a while, the image could stay blurry at every zoom level (the tile cache miscounted its size and dropped every new tile).

- **No built-in presets**: the extension starts with an empty presets file; the README explains how to create presets, from the viewer or by hand, with examples.
- **Variables** in presets: named intermediate expressions, computed once and usable by later variables and the channels. Enough to reproduce the Copernicus Browser's Sentinel-2 L2A true colour exactly (example in the README, for products from processing baseline 04.00 onwards, with a note for older ones). The README also shows Sentinel Hub's simpler and faster true colour as a preset.
- With gamma 1, composites map values to colours exactly (no 4096-step quantisation).
- **TIFF: Open Rendering Presets File** and the panel's link open the presets file in its own tab instead of replacing the viewer's preview tab.

## 0.2.0

- Renamed to **TIFF Viewer VS Code** (`tiff-viewer-vscode`): a separate extension built on [TIFF/BigTIFF](https://github.com/kiu-chan/tiff-bigtiff) 0.1.0 by kiu-chan, whose release notes follow below. The viewer's ID is now `tiffViewer.viewer`: update any `workbench.editorAssociations` entry that names `tiffBigtiff.viewer`.

- **Band composites** for multi-band imagery (Sentinel-2, Sentinel-1, …): choose a preset from the **Bands** menu, or open the **Composite** panel (<kbd>B</kbd>) to write an expression per red/green/blue channel (`B04 / 3000`), or a single expression with a colour map (`(B08 - B04) / (B08 + B04)` with RdYlGn). Per-channel display ranges or automatic stretching, gamma, and the computed values in the pixel readout.
- **Presets**: built-in Sentinel-2 (true colour, false colour, SWIR, NDVI, NDWI) and Sentinel-1 (VV/VH in dB or linear power) presets; save your own from the panel. Your presets live in `~/.tiff-viewer-vscode/presets.jsonc`, created on first start with documentation, editable by hand (with completion and validation), and reloaded when it changes; command **TIFF: Open Band Composite Presets File**. Presets can apply automatically by band count and/or file name. The viewer remembers the choice made for each file.
- Band names come from the file's band descriptions (GDAL metadata), so `B04` or `VV` work without configuration; they also label the pixel readout.
- **Faster opening**, especially of LZW and Deflate GeoTIFFs without overviews (a 57 MB, 13-band Sentinel-2 file: 8.9 s → 1.3 s until fully sharp):
  - a new LZW decoder, 8× faster than geotiff.js';
  - Deflate through the platform's zlib (`DecompressionStream`), about 2× faster than pako;
  - tiles are decoded on several cores by helper workers;
  - contrast statistics come from a sample of tiles instead of a full decode before the first tile is shown;
  - the tile cache keeps only the bands being displayed, so multi-band tiles no longer push each other out.

## 0.1.0 (TIFF/BigTIFF by kiu-chan)

- Tiled rendering: only the tiles in view are read, at the level of detail the zoom needs, coarse levels first; rendered tiles are kept for panning and zooming back.
- Huge single-level images (e.g. whole-slide scans) show an overview within about a second, and zooming into any area shows it at full resolution almost immediately.
- JPEG tiles are decoded with the browser's native decoder, many times faster, and at reduced size for zoomed-out views.
- Values are read directly from decoded tiles, only where they are needed.
- Loading progress is shown as a percentage in the status bar.

- First release: TIFF/BigTIFF viewer with on-demand reading of large files, pyramid support, multi-page navigation, contrast stretching for high bit depth and float data, pixel readout, info panel, and CCITT fax decoding.
