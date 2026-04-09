"""
OpenStreetMap Tile Downloader for VIT-AP / Amaravati Area
Downloads offline map tiles for use in the LoRa Chat mobile app.

Usage:
  python download_tiles.py

Output:
  tiles/{z}/{x}/{y}.png  — ready to bundle into the React Native app

Coverage:
  VIT-AP University campus + Amaravati city surroundings
  Bounding box: 16.44°N – 16.55°N, 80.44°E – 80.55°E
  Zoom levels: 14 – 18
"""

import os
import math
import urllib.request
import time
import sys

# ===== CONFIGURATION =====
# VIT-AP / Amaravati bounding box
MIN_LAT = 16.44
MAX_LAT = 16.55
MIN_LON = 80.44
MAX_LON = 80.55

# Zoom levels to download
MIN_ZOOM = 14
MAX_ZOOM = 18

# Output directory
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'tiles')

# Tile server (OpenStreetMap)
TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

# Rate limiting (be nice to OSM servers!)
DELAY_BETWEEN_REQUESTS = 0.2  # seconds

# User agent (required by OSM usage policy)
USER_AGENT = 'LoRaChatApp/1.0 (offline tile download for educational project)'
# ==========================


def lat_lon_to_tile(lat, lon, zoom):
    """Convert lat/lon to tile x, y coordinates at given zoom level."""
    lat_rad = math.radians(lat)
    n = 2 ** zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return x, y


def download_tile(z, x, y, output_dir):
    """Download a single tile and save it."""
    url = TILE_URL.format(z=z, x=x, y=y)
    tile_dir = os.path.join(output_dir, str(z), str(x))
    tile_path = os.path.join(tile_dir, f'{y}.png')

    # Skip if already downloaded
    if os.path.exists(tile_path):
        return True

    os.makedirs(tile_dir, exist_ok=True)

    try:
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=10) as response:
            with open(tile_path, 'wb') as f:
                f.write(response.read())
        return True
    except Exception as e:
        print(f'  ERROR downloading {url}: {e}')
        return False


def main():
    print('=' * 50)
    print('LoRa Chat — Offline Map Tile Downloader')
    print('=' * 50)
    print(f'Area: VIT-AP / Amaravati')
    print(f'Bounds: {MIN_LAT}°N–{MAX_LAT}°N, {MIN_LON}°E–{MAX_LON}°E')
    print(f'Zoom: {MIN_ZOOM}–{MAX_ZOOM}')
    print(f'Output: {os.path.abspath(OUTPUT_DIR)}')
    print('=' * 50)

    total_tiles = 0
    downloaded = 0
    skipped = 0
    errors = 0

    # Calculate total tiles first
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        x_min, y_max = lat_lon_to_tile(MIN_LAT, MIN_LON, z)
        x_max, y_min = lat_lon_to_tile(MAX_LAT, MAX_LON, z)
        count = (x_max - x_min + 1) * (y_max - y_min + 1)
        total_tiles += count
        print(f'  Zoom {z}: {x_max - x_min + 1}×{y_max - y_min + 1} = {count} tiles')

    print(f'\nTotal tiles to download: {total_tiles}')
    print(f'Estimated size: ~{total_tiles * 30 // 1024} MB')
    print()

    input('Press Enter to start downloading (Ctrl+C to cancel)...\n')

    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        x_min, y_max = lat_lon_to_tile(MIN_LAT, MIN_LON, z)
        x_max, y_min = lat_lon_to_tile(MAX_LAT, MAX_LON, z)

        zoom_count = (x_max - x_min + 1) * (y_max - y_min + 1)
        zoom_done = 0

        print(f'[Zoom {z}] Downloading {zoom_count} tiles...')

        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                tile_path = os.path.join(OUTPUT_DIR, str(z), str(x), f'{y}.png')
                if os.path.exists(tile_path):
                    skipped += 1
                    zoom_done += 1
                    continue

                success = download_tile(z, x, y, OUTPUT_DIR)
                if success:
                    downloaded += 1
                else:
                    errors += 1
                zoom_done += 1

                # Progress
                progress = (downloaded + skipped + errors) / total_tiles * 100
                sys.stdout.write(f'\r  Progress: {zoom_done}/{zoom_count} tiles | Overall: {progress:.1f}%')
                sys.stdout.flush()

                time.sleep(DELAY_BETWEEN_REQUESTS)

        print(f'\n  ✓ Zoom {z} complete')

    print('\n' + '=' * 50)
    print(f'DONE!')
    print(f'  Downloaded: {downloaded}')
    print(f'  Skipped (existing): {skipped}')
    print(f'  Errors: {errors}')
    print(f'  Total: {downloaded + skipped} tiles')
    print(f'  Output: {os.path.abspath(OUTPUT_DIR)}')
    print('=' * 50)


if __name__ == '__main__':
    main()
