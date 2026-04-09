# LoRa WAN Chat (ESP32 + Android App)

This project provides a **LoRa mesh chat system** with:

- An **ESP32-hosted web chat UI** (runs from the board)
- An **Android app (Expo/React Native)** with chat + live offline map
- LoRa radio forwarding between nodes (Node-A, Node-B, etc.)

The app and web are designed to share the same chat stream through the ESP32 node.

## What Is Included

- **Firmware**: [`firmware/ESP32_LoRa_Chat__1_.ino`](./firmware/ESP32_LoRa_Chat__1_.ino)
- **Mobile app**: Expo Router app in `app/`, `screens/`, `services/`
- **Offline map tiles**: `assets/tiles/` (Amaravati + test coverage)
- **Checklist**: [`CHECKLIST.md`](./CHECKLIST.md)

## Core Features

- Group/DM/Broadcast chat over Wi-Fi clients + LoRa relay
- SOS priority messages
- GPS sharing and node position updates
- Continuous app tracking (configurable interval)
- Captive portal / chooser flow support (`/start`) in firmware
- Offline map rendering in app (no internet needed for tiles)
- Test mode support in app for demo without hardware

## High-Level Flow

1. Phone/laptop connects to ESP32 hotspot (`LoRaChat-*`).
2. ESP32 serves web UI and API (HTTP) + live updates (WebSocket).
3. App and web both call the same node APIs (`/join`, `/send`, `/messages`, `/gps`, etc.).
4. ESP32 forwards/receives LoRa packets to/from other nodes.
5. Incoming node traffic is merged and shown in local web + app.

## Project Structure

```text
LoRaChatApp/
  app/                # Expo Router routes
  screens/            # Main UI screens (chat/map/login)
  services/           # API, websocket, session, GPS logic
  constants/          # Node config + map/test constants
  assets/tiles/       # Bundled offline map tiles
  firmware/           # ESP32 Arduino sketch
  android/            # Native Android project (prebuild output)
```

## Configuration

Main app runtime config is in:

- [`constants/config.ts`](./constants/config.ts)

Important values:

- `ESP32_IP` (default `192.168.4.1`)
- `AUTHORIZED_NODE_NAMES`, `AUTHORIZED_SSID_HINTS` (multi-node allow-list)
- `GPS_SEND_INTERVAL_MS` (currently set for reduced network congestion)
- Map defaults and Amaravati/VIT-AP test regions

## ESP32 Firmware Setup

1. Open [`firmware/ESP32_LoRa_Chat__1_.ino`](./firmware/ESP32_LoRa_Chat__1_.ino) in Arduino IDE.
2. Update per-node identity:
   - `NODE_NAME` (example: `Node-A`, `Node-B`)
   - `AP_SSID` (example: `LoRaChat-A`, `LoRaChat-B`)
3. Select ESP32 board/port and upload.
4. Repeat for each node with unique name + SSID.

Note: Keep LoRa radio parameters aligned across all nodes.

## App Setup (Development)

```bash
npm install
npm run start
```

Android (local run):

```bash
npm run android
```

## APK Build

Debug APK output path:

- `android/app/build/outputs/apk/debug/app-debug.apk`

Build command:

```bash
npm run android
```

For release distribution, generate a signed release APK/AAB from Android Gradle flow.

## Sync Behavior

- Web and app should show the same chat if connected to active node API.
- GPS telemetry is treated separately from regular human chat where configured.
- SOS remains priority traffic.

## Troubleshooting

- If Arduino compile shows many duplicate symbol errors:
  - Ensure only one active `.ino` in sketch folder (backup files should not end with `.ino`).
- If app cannot connect:
  - Verify phone is on ESP32 hotspot.
  - Verify node IP and allow-list settings in `constants/config.ts`.
- If map tiles are missing:
  - Confirm tile assets are present under `assets/tiles/`.

---


