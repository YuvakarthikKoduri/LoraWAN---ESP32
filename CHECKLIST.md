# LoRa Chat Completion Checklist

This checklist reflects the current app, web, firmware, and APK status in this repo as of 2026-04-04.

## Verified Done

- [x] Replaced the template app flow with dedicated login, chat, and map screens.
- [x] Added app state/session handling with reconnect, pause, and restore behavior.
- [x] Added continuous GPS sharing and faster mesh refresh intervals for the native app.
- [x] Added offline map support for the native app using bundled campus tiles.
- [x] Kept web trimmed down by hiding the map tab in the Expo web route layer.
- [x] Updated the ESP32 browser UI to hide the web map tab while keeping existing GPS/chat access.
- [x] Increased ESP32 SoftAP client capacity so the board can serve more simultaneous clients.
- [x] Generated the Android native project with Expo prebuild.
- [x] Built a debug APK successfully at `android/app/build/outputs/apk/debug/app-debug.apk`.
- [x] Increased the Gradle wrapper network timeout to avoid download timeouts during builds.
- [x] Cleaned duplicate Android permission entries from `app.json`.
- [x] Replaced the generated placeholder Android package id with `com.kodur.lorachatapp`.

## Source Audit

- [x] Checked the app-owned source folders for TODO/FIXME markers.
- [x] No meaningful unfinished TODO markers were found in `app`, `screens`, `services`, or `constants`.
- [x] Ignored generated build/binary output that produced false positives during search.

## Still To Do Outside This Repo

- [ ] Flash the updated ESP32 firmware from `C:/Users/kodur/OneDrive/Documents/Arduino/ESP32_LoRa_Chat__/ESP32_LoRa_Chat__1_/ESP32_LoRa_Chat__1_.ino`.
- [ ] Install `android/app/build/outputs/apk/debug/app-debug.apk` on an Android device.
- [ ] Join the ESP32 hotspot from at least one phone and one browser client at the same time.
- [ ] Confirm that web still shows chat and GPS data without any map UI.
- [ ] Confirm that the Android app keeps showing live node movement on the offline map while users move.
- [ ] Build and sign a release APK or AAB if you want store/distribution-ready output.

## Quick Test Plan

- [ ] Boot the ESP32 and wait for the AP to appear.
- [ ] Open the ESP32 web UI in a browser and verify chat/GPS work.
- [ ] Open the Android app, join the same node, and verify login/chat works.
- [ ] Leave both connected for several minutes and confirm both remain active.
- [ ] Walk with two nodes and confirm the app map updates continuously.
