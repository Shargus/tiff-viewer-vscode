# Changelog

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
