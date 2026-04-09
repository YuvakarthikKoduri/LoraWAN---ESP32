import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import {
  BACKGROUND_LOCATION_TASK,
  GPS_HIGH_ACCURACY,
  GPS_INTERVAL_MS,
  GPS_SEND_INTERVAL_MS,
} from '../constants/config';
import { sendGPS } from './apiClient';
import { appModeManager, AppMode } from './appMode';

type GPSUpdateHandler = (lat: number, lng: number, accuracy: number) => void;

const TRACKING_KEYS = {
  UID: 'lora_tracking_uid',
  MODE: 'lora_tracking_mode',
  USERNAME: 'lora_tracking_username',
};

let lastGpsSentAt = 0;

async function forwardLocation(lat: number, lng: number) {
  const now = Date.now();
  if (lastGpsSentAt > 0 && now - lastGpsSentAt < GPS_SEND_INTERVAL_MS) {
    return;
  }

  const uid = await AsyncStorage.getItem(TRACKING_KEYS.UID);
  const storedMode = (await AsyncStorage.getItem(TRACKING_KEYS.MODE)) as AppMode | null;
  const username = (await AsyncStorage.getItem(TRACKING_KEYS.USERNAME)) || '';

  if (!uid) {
    return;
  }

  const effectiveMode = storedMode || appModeManager.mode;
  if (effectiveMode === 'test' || effectiveMode === 'live') {
    lastGpsSentAt = now;
    await sendGPS(uid, lat, lng, username);
  }
}

let backgroundTaskReady = false;
try {
  if (!TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK)) {
    TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
      if (error) {
        console.log('[GPS] Background task error:', error.message);
        return;
      }

      const locations = (data as { locations?: Array<{ coords: { latitude: number; longitude: number } }> } | undefined)?.locations;
      if (!locations?.length) {
        return;
      }

      const latest = locations[locations.length - 1];
      await forwardLocation(latest.coords.latitude, latest.coords.longitude);
    });
  }
  backgroundTaskReady = true;
} catch (error) {
  console.log('[GPS] Background task registration failed:', error);
}

class GPSTracker {
  private locationSubscription: Location.LocationSubscription | null = null;
  private uid = '';
  private username = '';
  private currentLat: number | null = null;
  private currentLng: number | null = null;
  private currentAccuracy = 0;
  private handlers: GPSUpdateHandler[] = [];
  private active = false;
  private permissionGranted = false;

  get isActive() {
    return this.active;
  }

  get latitude() {
    return this.currentLat;
  }

  get longitude() {
    return this.currentLng;
  }

  get accuracy() {
    return this.currentAccuracy;
  }

  async requestPermission() {
    try {
      const foreground = await Location.requestForegroundPermissionsAsync();
      this.permissionGranted = foreground.status === 'granted';

      if (this.permissionGranted && Platform.OS === 'android') {
        await Location.requestBackgroundPermissionsAsync();
      }

      return this.permissionGranted;
    } catch (error) {
      console.log('[GPS] Permission error:', error);
      this.permissionGranted = false;
      return false;
    }
  }

  async start(uid: string, username = '') {
    this.uid = uid;
    this.username = username.trim();

    if (this.active) {
      await AsyncStorage.multiSet([
        [TRACKING_KEYS.UID, uid],
        [TRACKING_KEYS.MODE, appModeManager.mode],
        [TRACKING_KEYS.USERNAME, this.username],
      ]);
      return;
    }

    if (!this.permissionGranted) {
      const granted = await this.requestPermission();
      if (!granted) {
        return;
      }
    }

    this.active = true;
    await AsyncStorage.multiSet([
      [TRACKING_KEYS.UID, uid],
      [TRACKING_KEYS.MODE, appModeManager.mode],
      [TRACKING_KEYS.USERNAME, this.username],
    ]);

    try {
      this.locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: GPS_HIGH_ACCURACY
            ? Location.Accuracy.High
            : Location.Accuracy.Balanced,
          timeInterval: GPS_INTERVAL_MS,
          distanceInterval: 1,
        },
        (location) => {
          this.currentLat = location.coords.latitude;
          this.currentLng = location.coords.longitude;
          this.currentAccuracy = Math.round(location.coords.accuracy || 0);
          this.handlers.forEach((handler) =>
            handler(this.currentLat as number, this.currentLng as number, this.currentAccuracy)
          );
          void forwardLocation(this.currentLat as number, this.currentLng as number);
        }
      );
    } catch (error) {
      console.log('[GPS] Watch error:', error);
      this.active = false;
      return;
    }

    if (backgroundTaskReady) {
      try {
        const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        if (!started) {
          await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
            accuracy: GPS_HIGH_ACCURACY
              ? Location.Accuracy.High
              : Location.Accuracy.Balanced,
            timeInterval: GPS_INTERVAL_MS,
            distanceInterval: 1,
            foregroundService: {
              notificationTitle: 'LoRa Chat tracking active',
              notificationBody: 'Sharing live coordinates in the background.',
            },
          });
        }
      } catch (error) {
        console.log('[GPS] Background start error:', error);
      }
    }
  }

  stop() {
    this.active = false;
    this.uid = '';
    this.username = '';
    lastGpsSentAt = 0;

    if (this.locationSubscription) {
      this.locationSubscription.remove();
      this.locationSubscription = null;
    }

    void AsyncStorage.multiRemove([TRACKING_KEYS.UID, TRACKING_KEYS.MODE, TRACKING_KEYS.USERNAME]);
    if (backgroundTaskReady) {
      void Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).then((started) => {
        if (started) {
          return Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        }
        return undefined;
      });
    }
  }

  onUpdate(handler: GPSUpdateHandler) {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((entry) => entry !== handler);
    };
  }
}

export const gpsTracker = new GPSTracker();
