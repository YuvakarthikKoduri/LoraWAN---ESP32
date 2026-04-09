"""
OpenStreetMap Tile Downloader for VIT-AP / Amaravati Area
Downloads offline map tiles for bundling into the Android APK.

Usage:
  python download_tiles_auto.py

Output:
  tiles/{z}/{x}/{y}.png — ready to copy into Android assets

Coverage:
  VIT-AP University campus + immediate surroundings
  Bounding box: 16.47°N – 16.52°N, 80.48°E – 80.52°E (tighter focus)
  Zoom levels: 14 – 17 (keeps APK size reasonable, ~5-10MB)
"""

import os
import math
import urllib.request
import time
import sys

# ===== CONFIGURATION =====
# Focused VIT-AP campus area (tighter than full Amaravati)
MIN_LAT = 16.47
MAX_LAT = 16.52
MIN_LON = 80.48
MAX_LON = 80.52

# Zoom levels (14-17 is good detail without huge file count)
MIN_ZOOM = 14
MAX_ZOOM = 17

# Output directory
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'tiles')

# Tile server
TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

# Rate limiting
DELAY_BETWEEN_REQUESTS = 0.15

# User agent
USER_AGENT = 'LoRaChatApp/1.0 (offline tile download for educational project)'
# ==========================


def lat_lon_to_tile(lat, lon, zoom):
    lat_rad = math.radians(lat)
    n = 2 ** zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return x, y


def download_tile(z, x, y, output_dir):
    url = TILE_URL.format(z=z, x=x, y=y)
    tile_dir = os.path.join(output_dir, str(z), str(x))
    tile_path = os.path.join(tile_dir, f'{y}.png')

    if os.path.exists(tile_path):
        return 'skip'

    os.makedirs(tile_dir, exist_ok=True)

    try:
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=10) as response:
            with open(tile_path, 'wb') as f:
                f.write(response.read())
        return 'ok'
    except Exception as e:
        print(f'  ERROR: {url}: {e}')
        return 'error'


def main():
    print('=' * 50)
    print('LoRa Chat — Offline Tile Downloader (Auto)')
    print('=' * 50)
    print(f'Area: VIT-AP Campus Focus')
    print(f'Bounds: {MIN_LAT}°N–{MAX_LAT}°N, {MIN_LON}°E–{MAX_LON}°E')
    print(f'Zoom: {MIN_ZOOM}–{MAX_ZOOM}')
    print(f'Output: {os.path.abspath(OUTPUT_DIR)}')
    print('=' * 50)

    total_tiles = 0
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        x_min, y_max = lat_lon_to_tile(MIN_LAT, MIN_LON, z)
        x_max, y_min = lat_lon_to_tile(MAX_LAT, MAX_LON, z)
        count = (x_max - x_min + 1) * (y_max - y_min + 1)
        total_tiles += count
        print(f'  Zoom {z}: {x_max - x_min + 1}x{y_max - y_min + 1} = {count} tiles')

    print(f'\nTotal: {total_tiles} tiles (~{total_tiles * 25 // 1024} MB)')
    print('Downloading...\n')

    downloaded = 0
    skipped = 0
    errors = 0

    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        x_min, y_max = lat_lon_to_tile(MIN_LAT, MIN_LON, z)
        x_max, y_min = lat_lon_to_tile(MAX_LAT, MAX_LON, z)

        zoom_count = (x_max - x_min + 1) * (y_max - y_min + 1)
        zoom_done = 0

        print(f'[Zoom {z}] {zoom_count} tiles...')

        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                result = download_tile(z, x, y, OUTPUT_DIR)
                if result == 'skip':
                    skipped += 1
                elif result == 'ok':
                    downloaded += 1
                else:
                    errors += 1
                zoom_done += 1

                progress = (downloaded + skipped + errors) / total_tiles * 100
                sys.stdout.write(f'\r  {zoom_done}/{zoom_count} | Overall: {progress:.0f}%')
                sys.stdout.flush()

                if result == 'ok':
                    time.sleep(DELAY_BETWEEN_REQUESTS)

        print(f'\n  Done zoom {z}')

    print(f'\n{"=" * 50}')
    print(f'Downloaded: {downloaded} | Skipped: {skipped} | Errors: {errors}')
    print(f'Total: {downloaded + skipped} tiles')
    print(f'Output: {os.path.abspath(OUTPUT_DIR)}')
    print('=' * 50)


if __name__ == '__main__':
    main()
