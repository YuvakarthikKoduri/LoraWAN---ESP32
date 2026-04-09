// ESP32 LoRa Chat — Global App Context

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Alert, AppState, AppStateStatus } from 'react-native';
import * as Network from 'expo-network';
import { wsService } from '../services/websocket';
import { gpsService } from '../services/gps';
import { sessionService, SessionData } from '../services/session';
import { ConnectionState, SessionState } from '../constants/config';
import { ChatMessage, UserInfo, joinSession as apiJoin, getMessages, getUsers, getAllGPS, GPSPosition } from '../services/api';

interface AppContextType {
  // Session
  session: SessionData | null;
  sessionState: SessionState;
  login: (name: string, adminKey?: string) => Promise<boolean>;
  logout: () => void;
  startNewSession: () => Promise<boolean>;

  // Connection
  connectionState: ConnectionState;
  isWifiConnected: boolean;

  // Chat
  messages: ChatMessage[];
  users: UserInfo[];
  messageCount: number;

  // GPS
  myLat: number | null;
  myLng: number | null;
  myAccuracy: number;
  gpsPositions: GPSPosition[];
  gpsActive: boolean;

  // Actions
  refreshUsers: () => void;
  refreshMessages: () => void;
}

const AppContext = createContext<AppContextType>({} as AppContextType);

export function useApp() {
  return useContext(AppContext);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>(SessionState.NO_SESSION);
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [isWifiConnected, setIsWifiConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [messageCount, setMessageCount] = useState(0);
  const [myLat, setMyLat] = useState<number | null>(null);
  const [myLng, setMyLng] = useState<number | null>(null);
  const [myAccuracy, setMyAccuracy] = useState(0);
  const [gpsPositions, setGpsPositions] = useState<GPSPosition[]>([]);
  const [gpsActive, setGpsActive] = useState(false);

  const wasConnected = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const networkCheckTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Network State Monitoring ───────────────────────────────────────
  // Periodically check WiFi connectivity to detect disconnects
  // independent of WebSocket state
  useEffect(() => {
    const checkNetwork = async () => {
      try {
        const state = await Network.getNetworkStateAsync();
        const wifiConnected = state.isConnected === true && state.type === Network.NetworkStateType.WIFI;
        setIsWifiConnected(wifiConnected);

        // If WiFi dropped and we had an active session → pause
        if (!wifiConnected && sessionState === SessionState.ACTIVE) {
          console.log('[Network] WiFi lost — pausing session');
          sessionService.pause();
          setSessionState(SessionState.PAUSED);
          wsService.disconnect();
          gpsService.stop();
          setGpsActive(false);
        }

        // If WiFi came back and session was paused → prompt for new session
        if (wifiConnected && sessionState === SessionState.PAUSED) {
          console.log('[Network] WiFi restored — prompting reconnect');
          sessionService.promptReconnect();
          setSessionState(SessionState.RECONNECT_PROMPT);
        }
      } catch (e) {
        // Network check failed, ignore
      }
    };

    // Check immediately
    checkNetwork();

    // Then check every 3 seconds
    networkCheckTimer.current = setInterval(checkNetwork, 3000);

    return () => {
      if (networkCheckTimer.current) clearInterval(networkCheckTimer.current);
    };
  }, [sessionState]);

  // ─── App State Listener ─────────────────────────────────────────────
  // Detect app going to background/foreground
  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'active' && sessionState === SessionState.ACTIVE) {
        // App came back to foreground — refresh data
        refreshUsers();
        refreshMessages();
        refreshGPS();
      }
    };

    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, [sessionState]);

  // ─── WebSocket State Listener ───────────────────────────────────────
  useEffect(() => {
    const unsub = wsService.onStateChange((state) => {
      setConnectionState(state);

      if (state === ConnectionState.CONNECTED) {
        wasConnected.current = true;
      } else if (state === ConnectionState.DISCONNECTED || state === ConnectionState.RECONNECTING) {
        // WebSocket dropped — if active, let network monitor handle session pause
        // This avoids duplicate handling
      }
    });
    return unsub;
  }, [sessionState]);

  // ─── WebSocket Message Listener ─────────────────────────────────────
  useEffect(() => {
    const unsub = wsService.onMessage((data) => {
      if (data.type === 'chat') {
        const msg: ChatMessage = {
          sender: data.sender || '',
          suid: data.suid || '',
          text: data.text || '',
          time: data.time || '',
          channel: data.channel || '',
          target: data.target || '',
          prio: data.prio || '',
          rssi: data.rssi || 0,
        };
        setMessages(prev => [...prev, msg]);
        setMessageCount(prev => prev + 1);
      } else if (data.type === 'gps') {
        setGpsPositions(prev => {
          const existing = prev.findIndex(p => p.uid === data.uid);
          const updated: GPSPosition = {
            uid: data.uid,
            name: data.name || data.uid,
            lat: data.lat,
            lng: data.lng,
            hasGPS: true,
          };
          if (existing >= 0) {
            const copy = [...prev];
            copy[existing] = updated;
            return copy;
          }
          return [...prev, updated];
        });
      }
    });
    return unsub;
  }, []);

  // ─── GPS Updates Listener ───────────────────────────────────────────
  useEffect(() => {
    const unsub = gpsService.onUpdate((lat, lng, acc) => {
      setMyLat(lat);
      setMyLng(lng);
      setMyAccuracy(acc);
    });
    return unsub;
  }, []);

  // ─── Session State Listener ─────────────────────────────────────────
  useEffect(() => {
    const unsub = sessionService.onStateChange((state) => {
      setSessionState(state);
    });
    return unsub;
  }, []);

  // ─── Periodic Refresh While Active ──────────────────────────────────
  useEffect(() => {
    if (sessionState === SessionState.ACTIVE && session) {
      pollTimer.current = setInterval(() => {
        refreshUsers();
        refreshGPS();
      }, 5000);
      return () => {
        if (pollTimer.current) clearInterval(pollTimer.current);
      };
    } else {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }
  }, [sessionState, session]);

  // ─── Data Refresh Functions ─────────────────────────────────────────
  const refreshUsers = useCallback(async () => {
    try {
      const u = await getUsers();
      setUsers(u);
    } catch (e) { /* silent */ }
  }, []);

  const refreshMessages = useCallback(async () => {
    if (!session) return;
    try {
      const msgs = await getMessages(messageCount, session.uid);
      if (msgs.length > 0) {
        setMessages(prev => [...prev, ...msgs]);
        setMessageCount(prev => prev + msgs.length);
      }
    } catch (e) { /* silent */ }
  }, [session, messageCount]);

  const refreshGPS = useCallback(async () => {
    try {
      const positions = await getAllGPS();
      setGpsPositions(positions);
    } catch (e) { /* silent */ }
  }, []);

  // ─── Login ──────────────────────────────────────────────────────────
  const login = useCallback(async (name: string, adminKey: string = ''): Promise<boolean> => {
    try {
      const result = await apiJoin(name, adminKey);
      if (result.error) {
        Alert.alert('Error', result.error);
        return false;
      }

      const sessionData: SessionData = {
        username: name,
        uid: result.uid,
        isAdmin: result.admin,
        startedAt: Date.now(),
      };

      await sessionService.saveSession(sessionData);
      setSession(sessionData);
      setSessionState(SessionState.ACTIVE);

      // Clear old data for fresh session
      setMessages([]);
      setMessageCount(0);
      setGpsPositions([]);

      // Connect WebSocket
      wsService.connect();

      // Start GPS
      await gpsService.start(result.uid);
      setGpsActive(true);

      // Initial data fetch
      refreshUsers();
      refreshMessages();
      refreshGPS();

      return true;
    } catch (e) {
      Alert.alert('Connection Error', 'Cannot reach ESP32. Make sure you are connected to the LoRa WiFi network.');
      return false;
    }
  }, [refreshUsers, refreshMessages, refreshGPS]);

  // ─── Start New Session (after reconnect) ────────────────────────────
  const startNewSession = useCallback(async (): Promise<boolean> => {
    const username = sessionService.prepareNewSession();
    if (!username) return false;

    // Clear all old data
    setMessages([]);
    setMessageCount(0);
    setGpsPositions([]);
    setMyLat(null);
    setMyLng(null);
    setMyAccuracy(0);
    wasConnected.current = false;

    // Re-login with same username
    return login(username);
  }, [login]);

  // ─── Logout ─────────────────────────────────────────────────────────
  const logout = useCallback(() => {
    wsService.disconnect();
    gpsService.stop();
    setGpsActive(false);
    sessionService.clearSession();
    setSession(null);
    setSessionState(SessionState.NO_SESSION);
    setMessages([]);
    setUsers([]);
    setMessageCount(0);
    setGpsPositions([]);
    setMyLat(null);
    setMyLng(null);
    setMyAccuracy(0);
    wasConnected.current = false;
  }, []);

  return (
    <AppContext.Provider
      value={{
        session,
        sessionState,
        login,
        logout,
        startNewSession,
        connectionState,
        isWifiConnected,
        messages,
        users,
        messageCount,
        myLat,
        myLng,
        myAccuracy,
        gpsPositions,
        gpsActive,
        refreshUsers,
        refreshMessages,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
