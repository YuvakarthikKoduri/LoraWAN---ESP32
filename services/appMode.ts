import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_APP_MODE } from '../constants/config';

export type AppMode = 'live' | 'test';

const STORAGE_KEY = 'lora_app_mode';

class AppModeManager {
  private currentMode: AppMode = DEFAULT_APP_MODE;
  private listeners: Array<(mode: AppMode) => void> = [];

  get mode() {
    return this.currentMode;
  }

  get isTestMode() {
    return this.currentMode === 'test';
  }

  async loadMode() {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (stored === 'live' || stored === 'test') {
        this.currentMode = stored;
      }
    } catch (error) {
      console.log('[Mode] Load error:', error);
    }

    return this.currentMode;
  }

  async setMode(mode: AppMode) {
    this.currentMode = mode;
    this.listeners.forEach((listener) => listener(mode));

    try {
      await AsyncStorage.setItem(STORAGE_KEY, mode);
    } catch (error) {
      console.log('[Mode] Save error:', error);
    }
  }

  onChange(listener: (mode: AppMode) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }
}

export const appModeManager = new AppModeManager();
