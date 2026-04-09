// ESP32 LoRa Chat — GPS Tracking Service

import * as Location from 'expo-location';
import { GPS_INTERVAL_MS, GPS_HIGH_ACCURACY } from '../constants/config';
import { sendGPS } from './api';

type GPSUpdateHandler = (lat: number, lng: number, accuracy: number) => void;

class GPSService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private uid: string = '';
  private currentLat: number | null = null;
  private currentLng: number | null = null;
  private currentAccuracy: number = 0;
  private updateHandlers: GPSUpdateHandler[] = [];
  private locationSubscription: Location.LocationSubscription | null = null;
  private _isActive = false;
  private _hasPermission = false;

  get isActive(): boolean {
    return this._isActive;
  }

  get hasPermission(): boolean {
    return this._hasPermission;
  }

  get latitude(): number | null {
    return this.currentLat;
  }

  get longitude(): number | null {
    return this.currentLng;
  }

  get accuracy(): number {
    return this.currentAccuracy;
  }

  async requestPermission(): Promise<boolean> {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      this._hasPermission = status === 'granted';
      return this._hasPermission;
    } catch (e) {
      console.log('[GPS] Permission error:', e);
      this._hasPermission = false;
      return false;
    }
  }

  async start(uid: string) {
    if (this._isActive) return;

    this.uid = uid;

    if (!this._hasPermission) {
      const granted = await this.requestPermission();
      if (!granted) {
        console.log('[GPS] Permission denied');
        return;
      }
    }

    this._isActive = true;

    // Start watching position
    try {
      this.locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: GPS_HIGH_ACCURACY ? Location.Accuracy.High : Location.Accuracy.Balanced,
          timeInterval: 2000,
          distanceInterval: 1,
        },
        (location) => {
          this.currentLat = location.coords.latitude;
          this.currentLng = location.coords.longitude;
          this.currentAccuracy = Math.round(location.coords.accuracy || 0);
          this.updateHandlers.forEach(h => h(this.currentLat!, this.currentLng!, this.currentAccuracy));
        }
      );
    } catch (e) {
      console.log('[GPS] Watch error:', e);
    }

    // Send GPS to ESP32 every GPS_INTERVAL_MS
    this.intervalId = setInterval(async () => {
      if (this.currentLat !== null && this.currentLng !== null && this.uid) {
        try {
          await sendGPS(this.uid, this.currentLat, this.currentLng);
        } catch (e) {
          console.log('[GPS] Send error:', e);
        }
      }
    }, GPS_INTERVAL_MS);

    console.log(`[GPS] Started — sending every ${GPS_INTERVAL_MS / 1000}s`);
  }

  stop() {
    this._isActive = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.locationSubscription) {
      this.locationSubscription.remove();
      this.locationSubscription = null;
    }

    console.log('[GPS] Stopped');
  }

  onUpdate(handler: GPSUpdateHandler) {
    this.updateHandlers.push(handler);
    return () => {
      this.updateHandlers = this.updateHandlers.filter(h => h !== handler);
    };
  }

  setUid(uid: string) {
    this.uid = uid;
  }
}

export const gpsService = new GPSService();
