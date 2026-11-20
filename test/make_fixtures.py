"""Generates TIFF test files covering the formats the viewer supports.

Requires: numpy, tifffile, imagecodecs, Pillow (with libtiff).
Usage: python3 test/make_fixtures.py
"""
import os
import numpy as np
import tifffile
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), 'fixtures')
os.makedirs(OUT, exist_ok=True)


def path(name):
    return os.path.join(OUT, name)


h, w = 300, 400
yy, xx = np.mgrid[0:h, 0:w]
rgb8 = np.stack([(xx * 255 // (w - 1)), (yy * 255 // (h - 1)), ((xx + yy) % 256)], -1).astype(np.uint8)
rgb8[100:200, 150:250] = [255, 0, 0]
gray8 = rgb8[..., 0].copy()

tifffile.imwrite(path('rgb8_strips_none.tif'), rgb8, photometric='rgb')
tifffile.imwrite(path('rgb8_tiled_lzw_pred.tif'), rgb8, photometric='rgb', tile=(64, 64), compression='lzw', predictor=True)
tifffile.imwrite(path('rgb8_deflate_bigendian.tif'), rgb8, photometric='rgb', compression='zlib', byteorder='>')
tifffile.imwrite(path('rgb8_packbits.tif'), rgb8, photometric='rgb', compression='packbits')
tifffile.imwrite(path('rgb8_planar_separate.tif'), np.moveaxis(rgb8, -1, 0), photometric='rgb', planarconfig='separate')
tifffile.imwrite(path('rgb8_zstd.tif'), rgb8, photometric='rgb', compression='zstd', tile=(128, 128))
tifffile.imwrite(path('rgb8_jpeg_rgb.tif'), rgb8, photometric='rgb', compression='jpeg', tile=(128, 128))
tifffile.imwrite(path('bigtiff_rgb8_tiled_jpeg.tif'), rgb8, photometric='rgb', compression='jpeg', tile=(128, 128), bigtiff=True)
tifffile.imwrite(path('bigtiff_gray16_lzw.tif'), (xx * 50 + 1000).astype(np.uint16), bigtiff=True, compression='lzw')

rgba = np.dstack([rgb8, (xx * 255 // (w - 1)).astype(np.uint8)])
tifffile.imwrite(path('rgba8_unassoc_alpha.tif'), rgba, photometric='rgb', extrasamples=['unassalpha'])

gray16 = (yy * 12 + 3000).astype(np.uint16)
tifffile.imwrite(path('gray16_deflate.tif'), gray16, compression='zlib')
tifffile.imwrite(path('int16_signed.tif'), (xx - 200).astype(np.int16) * 100)

f32 = np.sin(xx / 30.0).astype(np.float32) * np.cos(yy / 25.0).astype(np.float32)
f32[0:40, 0:40] = np.nan
tifffile.imwrite(path('float32_nan_zstd_pred.tif'), f32, compression='zstd', predictor=True, tile=(64, 64))
tifffile.imwrite(path('float64_gray.tif'), f32.astype(np.float64))

# GDAL NoData: float32 with the lowest float32 written in shortened form (as older GDAL does),
# and two bands whose NoData masks differ (band 2 has NoData where band 1 is valid).
f32nd = np.linspace(0, 100, 256 * 256, dtype=np.float32).reshape(256, 256)
f32nd[:, :64] = np.float32(-3.4028234663852886e38)
tifffile.imwrite(path('float32_gdal_nodata.tif'), f32nd, tile=(128, 128), extratags=[(42113, 's', 0, '-3.40282346638529e+38', True)])
masks = np.full((2, 256, 256), 1000, dtype=np.uint16)
masks[1, :, 64:128] = 0
masks[:, :, :32] = 0
tifffile.imwrite(path('two_band_nodata_masks.tif'), masks, planarconfig='separate', tile=(128, 128), extratags=[(42113, 's', 0, '0', True)])

# Custom (private) tags of several types, and GDAL metadata items, for the info panel.
tags = np.arange(64 * 64, dtype=np.uint16).reshape(64, 64)
tifffile.imwrite(path('custom_tags.tif'), tags, tile=(32, 32), software='my-pipeline 1.2', extratags=[
    (65000, 's', 0, 'campaign=Mesetas 2019; operator=TM', True),
    (65001, 'd', 3, (1.5, -2.25, 1e-7), True),
    (65002, 'B', 6, bytes([0, 1, 2, 250, 251, 255]), True),
    (65004, 's', 0, 'x' * 5000, True),
    (42112, 's', 0, '<GDALMetadata><Item name="SENSOR">S2B</Item><Item name="CLOUD" domain="QA">12 &amp; less</Item>'
                    '<Item name="DESCRIPTION" sample="0" role="description">B04</Item></GDALMetadata>', True),
])

# Multi-page with different sizes
with tifffile.TiffWriter(path('multipage.tif')) as tw:
    tw.write(rgb8, photometric='rgb')
    tw.write(gray8[:150, :200], photometric='minisblack')
    tw.write(gray16, compression='lzw')

# Pyramid (COG-like): full resolution + reduced-resolution overviews
big = np.tile(rgb8, (8, 8, 1))  # 2400 x 3200
with tifffile.TiffWriter(path('pyramid_bigtiff.tif'), bigtiff=True) as tw:
    tw.write(big, photometric='rgb', tile=(256, 256), compression='zlib', subfiletype=0)
    for f in (2, 4, 8):
        tw.write(big[::f, ::f], photometric='rgb', tile=(256, 256), compression='zlib', subfiletype=1)

# Pillow / libtiff produced variants
pil_rgb = Image.fromarray(rgb8)
pil_rgb.convert('P', palette=Image.ADAPTIVE, colors=64).save(path('palette8.tif'))
pil_rgb.convert('CMYK').save(path('cmyk8.tif'))
pil_rgb.save(path('ycbcr_jpeg.tif'), compression='jpeg')
pil_rgb.convert('LAB').save(path('cielab8.tif'))

doc = Image.new('1', (1700, 2200), 1)
from PIL import ImageDraw
d = ImageDraw.Draw(doc)
for i in range(40):
    d.text((100, 60 + i * 50), f'Line {i}: The quick brown fox jumps over the lazy dog 0123456789', fill=0)
d.rectangle((1200, 1500, 1600, 2000), outline=0, width=9)
d.ellipse((1250, 1550, 1550, 1950), fill=0)
doc.save(path('bilevel_none.tif'))
doc.save(path('bilevel_g4.tif'), compression='group4')
doc.save(path('bilevel_g3.tif'), compression='group3')
doc.save(path('bilevel_packbits.tif'), compression='packbits')
doc.save(path('bilevel_rle.tif'), compression='tiff_ccitt')
np.save(path('bilevel_reference.npy'), np.array(doc, dtype=np.uint8))
np.save(path('rgb8_reference.npy'), rgb8)
# Lossy files are compared with libjpeg's decoding (through tifffile / imagecodecs).
for name in ('rgb8_jpeg_rgb', 'bigtiff_rgb8_tiled_jpeg', 'ycbcr_jpeg'):
    np.save(path(name + '_reference.npy'), tifffile.imread(path(name + '.tif')))
print('fixtures written to', OUT)
