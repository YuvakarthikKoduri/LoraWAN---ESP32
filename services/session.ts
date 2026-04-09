// ESP32 LoRa Chat — Session Management

import AsyncStorage from '@react-native-async-storage/async-storage';
import { SessionState } from '../constants/config';

const STORAGE_KEYS = {
  USERNAME: 'lora_username',
  UID: 'lora_uid',
  IS_ADMIN: 'lora_is_admin',
  SESSION_START: 'lora_session_start',
};

export interface SessionData {
  username: string;
  uid: string;
  isAdmin: boolean;
  startedAt?: number; // timestamp
}

class SessionService {
  private _state: SessionState = SessionState.NO_SESSION;
  private _data: SessionData | null = null;
  private stateHandlers: ((state: SessionState) => void)[] = [];

  get state(): SessionState {
    return this._state;
  }

  get data(): SessionData | null {
    return this._data;
  }

  get isActive(): boolean {
    return this._state === SessionState.ACTIVE;
  }

  get isPaused(): boolean {
    return this._state === SessionState.PAUSED;
  }

  get isReconnectPrompt(): boolean {
    return this._state === SessionState.RECONNECT_PROMPT;
  }

  get sessionDuration(): number {
    if (!this._data?.startedAt) return 0;
    return Date.now() - this._data.startedAt;
  }

  private setState(state: SessionState) {
    this._state = state;
    this.stateHandlers.forEach(h => h(state));
  }

  onStateChange(handler: (state: SessionState) => void) {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter(h => h !== handler);
    };
  }

  async loadSavedSession(): Promise<SessionData | null> {
    try {
      const username = await AsyncStorage.getItem(STORAGE_KEYS.USERNAME);
      const uid = await AsyncStorage.getItem(STORAGE_KEYS.UID);
      const isAdmin = await AsyncStorage.getItem(STORAGE_KEYS.IS_ADMIN);
      const startedAt = await AsyncStorage.getItem(STORAGE_KEYS.SESSION_START);

      if (username && uid) {
        return {
          username,
          uid,
          isAdmin: isAdmin === 'true',
          startedAt: startedAt ? parseInt(startedAt, 10) : Date.now(),
        };
      }
    } catch (e) {
      console.log('[Session] Load error:', e);
    }
    return null;
  }

  async saveSession(data: SessionData) {
    const sessionData = {
      ...data,
      startedAt: data.startedAt || Date.now(),
    };
    this._data = sessionData;
    this.setState(SessionState.ACTIVE);

    try {
      await AsyncStorage.setItem(STORAGE_KEYS.USERNAME, sessionData.username);
      await AsyncStorage.setItem(STORAGE_KEYS.UID, sessionData.uid);
      await AsyncStorage.setItem(STORAGE_KEYS.IS_ADMIN, sessionData.isAdmin ? 'true' : 'false');
      await AsyncStorage.setItem(STORAGE_KEYS.SESSION_START, String(sessionData.startedAt));
    } catch (e) {
      console.log('[Session] Save error:', e);
    }
  }

  pause() {
    if (this._state === SessionState.ACTIVE) {
      console.log('[Session] Paused — WiFi disconnected');
      this.setState(SessionState.PAUSED);
    }
  }

  promptReconnect() {
    console.log('[Session] Reconnect prompt — WiFi restored');
    this.setState(SessionState.RECONNECT_PROMPT);
  }

  async clearSession() {
    this._data = null;
    this.setState(SessionState.NO_SESSION);

    try {
      await AsyncStorage.multiRemove([
        STORAGE_KEYS.USERNAME,
        STORAGE_KEYS.UID,
        STORAGE_KEYS.IS_ADMIN,
        STORAGE_KEYS.SESSION_START,
      ]);
    } catch (e) {
      console.log('[Session] Clear error:', e);
    }
  }

  resume() {
    if (this._data) {
      this.setState(SessionState.ACTIVE);
    }
  }

  /**
   * Prepare for a new session after reconnect.
   * Clears old session data but preserves the username for re-join.
   */
  prepareNewSession(): string | null {
    const username = this._data?.username || null;
    this._data = null;
    return username;
  }
}

export const sessionService = new SessionService();
