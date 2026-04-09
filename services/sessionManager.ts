import AsyncStorage from '@react-native-async-storage/async-storage';
import { SessionState } from '../constants/config';

const STORAGE_KEYS = {
  USERNAME: 'lora_username',
  UID: 'lora_uid',
  IS_ADMIN: 'lora_is_admin',
  ADMIN_KEY: 'lora_admin_key',
  SESSION_START: 'lora_session_start',
};

export interface SessionData {
  username: string;
  uid: string;
  isAdmin: boolean;
  adminKey?: string;
  startedAt?: number;
}

export interface SessionSeed {
  username: string;
  adminKey?: string;
}

class SessionManager {
  private stateValue: SessionState = SessionState.NO_SESSION;
  private sessionData: SessionData | null = null;
  private listeners: Array<(state: SessionState) => void> = [];

  get state(): SessionState {
    return this.stateValue;
  }

  get data(): SessionData | null {
    return this.sessionData;
  }

  private setState(nextState: SessionState) {
    this.stateValue = nextState;
    this.listeners.forEach((listener) => listener(nextState));
  }

  onStateChange(listener: (state: SessionState) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  async loadSavedSession(): Promise<SessionData | null> {
    try {
      const [username, uid, isAdmin, adminKey, startedAt] = await AsyncStorage.multiGet([
        STORAGE_KEYS.USERNAME,
        STORAGE_KEYS.UID,
        STORAGE_KEYS.IS_ADMIN,
        STORAGE_KEYS.ADMIN_KEY,
        STORAGE_KEYS.SESSION_START,
      ]).then((entries) => entries.map((entry) => entry[1]));

      if (username && uid) {
        this.sessionData = {
          username,
          uid,
          isAdmin: isAdmin === 'true',
          adminKey: adminKey || undefined,
          startedAt: startedAt ? parseInt(startedAt, 10) : Date.now(),
        };
        return this.sessionData;
      }
    } catch (error) {
      console.log('[Session] Load error:', error);
    }

    return null;
  }

  async saveSession(data: SessionData) {
    const nextSession: SessionData = {
      ...data,
      adminKey: data.adminKey?.trim() || undefined,
      startedAt: data.startedAt || Date.now(),
    };

    this.sessionData = nextSession;
    this.setState(SessionState.ACTIVE);

    try {
      await AsyncStorage.multiSet([
        [STORAGE_KEYS.USERNAME, nextSession.username],
        [STORAGE_KEYS.UID, nextSession.uid],
        [STORAGE_KEYS.IS_ADMIN, nextSession.isAdmin ? 'true' : 'false'],
        [STORAGE_KEYS.SESSION_START, String(nextSession.startedAt)],
      ]);

      if (nextSession.adminKey) {
        await AsyncStorage.setItem(STORAGE_KEYS.ADMIN_KEY, nextSession.adminKey);
      } else {
        await AsyncStorage.removeItem(STORAGE_KEYS.ADMIN_KEY);
      }
    } catch (error) {
      console.log('[Session] Save error:', error);
    }
  }

  pause() {
    if (this.sessionData) {
      this.setState(SessionState.PAUSED);
    }
  }

  promptReconnect() {
    if (this.sessionData) {
      this.setState(SessionState.RECONNECT_PROMPT);
    }
  }

  resume() {
    if (this.sessionData) {
      this.setState(SessionState.ACTIVE);
    }
  }

  async clearSession() {
    this.sessionData = null;
    this.setState(SessionState.NO_SESSION);

    try {
      await AsyncStorage.multiRemove([
        STORAGE_KEYS.USERNAME,
        STORAGE_KEYS.UID,
        STORAGE_KEYS.IS_ADMIN,
        STORAGE_KEYS.ADMIN_KEY,
        STORAGE_KEYS.SESSION_START,
      ]);
    } catch (error) {
      console.log('[Session] Clear error:', error);
    }
  }

  async prepareNewSession(): Promise<SessionSeed | null> {
    const username =
      this.sessionData?.username || (await AsyncStorage.getItem(STORAGE_KEYS.USERNAME));

    if (!username) {
      return null;
    }

    const adminKey =
      this.sessionData?.adminKey || (await AsyncStorage.getItem(STORAGE_KEYS.ADMIN_KEY)) || undefined;

    return {
      username,
      adminKey,
    };
  }
}

export const sessionManager = new SessionManager();
