import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Alert, AppState, AppStateStatus } from 'react-native';
import * as Network from 'expo-network';
import {
  APP_REFRESH_INTERVAL_MS,
  ConnectionState,
  NETWORK_CHECK_INTERVAL_MS,
  PING_INTERVAL_MS,
  SessionState,
} from '../constants/config';
import {
  ChatMessage,
  GPSPosition,
  NodeInfo,
  StatsInfo,
  UserInfo,
  checkSession,
  getAllGPS,
  getInfo,
  getMessages,
  getStats,
  getUsers,
  joinSession,
  pingNode,
} from './apiClient';
import { gpsTracker } from './gpsTracker';
import { appModeManager, AppMode } from './appMode';
import { discoverNodeHost, getBaseUrl } from './nodeEndpoint';
import { SessionData, sessionManager } from './sessionManager';
import { wsService } from './websocket';

interface AppStateContextValue {
  appMode: AppMode;
  session: SessionData | null;
  sessionState: SessionState;
  setAppMode: (mode: AppMode) => Promise<void>;
  login: (name: string, adminKey?: string) => Promise<boolean>;
  logout: () => void;
  startNewSession: () => Promise<boolean>;
  connectionState: ConnectionState;
  isWifiConnected: boolean;
  messages: ChatMessage[];
  users: UserInfo[];
  messageCount: number;
  myLat: number | null;
  myLng: number | null;
  myAccuracy: number;
  gpsPositions: GPSPosition[];
  gpsActive: boolean;
  nodeInfo: NodeInfo | null;
  stats: StatsInfo | null;
  pingStatus: string;
  pingLogs: string[];
  refreshUsers: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  refreshNodeData: () => Promise<void>;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

function sameMessage(left: ChatMessage, right: ChatMessage) {
  return (
    left.sender === right.sender &&
    left.suid === right.suid &&
    left.text === right.text &&
    left.time === right.time &&
    left.channel === right.channel &&
    left.target === right.target &&
    left.prio === right.prio &&
    left.rssi === right.rssi
  );
}

function dedupeMessages(messages: ChatMessage[]) {
  return messages.reduce<ChatMessage[]>((unique, message) => {
    if (!unique.some((entry) => sameMessage(entry, message))) {
      unique.push(message);
    }
    return unique;
  }, []);
}

function mergeGPSPositions(
  current: GPSPosition[],
  incoming: GPSPosition | GPSPosition[]
): GPSPosition[] {
  const merged = [...current];
  const updates = Array.isArray(incoming) ? incoming : [incoming];

  updates.forEach((item) => {
    const index = merged.findIndex((entry) => entry.uid === item.uid);
    if (index >= 0) {
      merged[index] = { ...merged[index], ...item };
    } else {
      merged.push(item);
    }
  });

  return merged;
}

function isWifiStateConnected(state: Network.NetworkState) {
  if (state.isConnected !== true) {
    return false;
  }

  // Some Android builds report ESP32 hotspot as UNKNOWN/OTHER even when connected.
  return (
    state.type === Network.NetworkStateType.WIFI ||
    state.type === Network.NetworkStateType.UNKNOWN ||
    state.type === Network.NetworkStateType.OTHER
  );
}

async function canReachNodeQuick(discoverFirst = false) {
  if (discoverFirst) {
    await discoverNodeHost();
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(`${getBaseUrl()}/info`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

function timestampLabel() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function useApp() {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return context;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [appMode, setAppModeState] = useState<AppMode>(appModeManager.mode);
  const [session, setSession] = useState<SessionData | null>(null);
  const [sessionState, setSessionState] = useState(SessionState.NO_SESSION);
  const [connectionState, setConnectionState] = useState(ConnectionState.DISCONNECTED);
  const [isWifiConnected, setIsWifiConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [myLat, setMyLat] = useState<number | null>(null);
  const [myLng, setMyLng] = useState<number | null>(null);
  const [myAccuracy, setMyAccuracy] = useState(0);
  const [gpsPositions, setGpsPositions] = useState<GPSPosition[]>([]);
  const [gpsActive, setGpsActive] = useState(false);
  const [nodeInfo, setNodeInfo] = useState<NodeInfo | null>(null);
  const [stats, setStats] = useState<StatsInfo | null>(null);
  const [pingStatus, setPingStatus] = useState('Waiting');
  const [pingLogs, setPingLogs] = useState<string[]>([]);

  const sessionRef = useRef<SessionData | null>(null);
  const recoveringRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const networkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setAppMode = useCallback(async (mode: AppMode) => {
    await appModeManager.setMode(mode);
    setAppModeState(mode);
  }, []);

  const appendLog = useCallback((line: string) => {
    setPingLogs((current) => [line, ...current].slice(0, 180));
  }, []);

  useEffect(() => {
    let mounted = true;

    void appModeManager.loadMode().then((mode) => {
      if (mounted) {
        setAppModeState(mode);
      }
    });

    const unsubscribe = appModeManager.onChange((mode) => {
      setAppModeState(mode);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const resetTransientState = useCallback(() => {
    setMessages([]);
    setUsers([]);
    setGpsPositions([]);
    setNodeInfo(null);
    setStats(null);
    setMyLat(null);
    setMyLng(null);
    setMyAccuracy(0);
    setPingStatus('Waiting');
    setPingLogs([]);
  }, []);

  const stopLiveServices = useCallback(() => {
    wsService.disconnect();
    gpsTracker.stop();
    setGpsActive(false);
  }, []);

  const refreshUsers = useCallback(async () => {
    if (!sessionRef.current) {
      return;
    }

    try {
      setUsers(await getUsers());
    } catch {
      // Ignore transient network failures.
    }
  }, []);

  const refreshMessages = useCallback(async () => {
    const activeSession = sessionRef.current;
    if (!activeSession) {
      return;
    }

    try {
      const snapshot = await getMessages(activeSession.uid);
      setMessages(dedupeMessages(snapshot));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/not registered/i.test(text)) {
        sessionManager.promptReconnect();
        setSessionState(SessionState.RECONNECT_PROMPT);
      }
    }
  }, []);

  const refreshGPS = useCallback(async () => {
    if (!sessionRef.current) {
      return;
    }

    try {
      setGpsPositions(await getAllGPS());
    } catch {
      // Ignore transient network failures.
    }
  }, []);

  const refreshNodeData = useCallback(async () => {
    if (!sessionRef.current) {
      return;
    }

    const [infoResult, statsResult] = await Promise.allSettled([getInfo(), getStats()]);

    if (infoResult.status === 'fulfilled') {
      setNodeInfo(infoResult.value);
    }

    if (statsResult.status === 'fulfilled') {
      setStats(statsResult.value);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    if (refreshInFlightRef.current) {
      return;
    }

    refreshInFlightRef.current = true;
    try {
      // Avoid flooding the ESP32 web server with parallel requests.
      await refreshMessages();
      await refreshUsers();
      await refreshGPS();
      await refreshNodeData();
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [refreshMessages, refreshNodeData, refreshUsers, refreshGPS]);

  const activateSession = useCallback(
    async (sessionData: SessionData) => {
      sessionRef.current = sessionData;
      setSession(sessionData);
      sessionManager.resume();
      setSessionState(SessionState.ACTIVE);
      // A successful API session means the selected node host is reachable now.
      setIsWifiConnected(true);
      wsService.connect();
      await gpsTracker.start(sessionData.uid, sessionData.username);
      setGpsActive(gpsTracker.isActive);
      await refreshAll();
    },
    [refreshAll]
  );

  useEffect(() => {
    const unsubscribe = sessionManager.onStateChange((nextState) => {
      setSessionState(nextState);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = wsService.onStateChange((nextState) => {
      setConnectionState(nextState);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = gpsTracker.onUpdate((lat, lng, accuracy) => {
      setMyLat(lat);
      setMyLng(lng);
      setMyAccuracy(accuracy);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = wsService.onMessage((data) => {
      if (data.type === 'chat') {
        void refreshMessages();
        if (data.channel === 'system') {
          void refreshUsers();
          void refreshNodeData();
        }
        return;
      }

      if (
        data.type === 'gps' &&
        typeof data.uid === 'string' &&
        Number.isFinite(data.lat) &&
        Number.isFinite(data.lng)
      ) {
        setGpsPositions((current) =>
          mergeGPSPositions(current, {
            uid: data.uid,
            name: data.name || data.uid,
            lat: Number(data.lat),
            lng: Number(data.lng),
            hasGPS: true,
          })
        );
        const displayName = typeof data.name === 'string' && data.name.length ? data.name : data.uid;
        appendLog(
          `${timestampLabel()}  GPS ${displayName} ${Number(data.lat).toFixed(6)}, ${Number(data.lng).toFixed(6)}`
        );
      }
    });

    return unsubscribe;
  }, [appendLog, refreshMessages, refreshNodeData, refreshUsers]);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      await appModeManager.loadMode();
      const savedSession = await sessionManager.loadSavedSession();
      if (!savedSession || cancelled) {
        return;
      }

      setSession(savedSession);
      sessionRef.current = savedSession;

      try {
        if (appModeManager.isTestMode) {
          setIsWifiConnected(true);
          await activateSession(savedSession);
          return;
        }

        const networkState = await Network.getNetworkStateAsync();
        let wifiConnected = isWifiStateConnected(networkState);
        if (!wifiConnected) {
          wifiConnected = await canReachNodeQuick();
        }
        if (!cancelled) {
          setIsWifiConnected(wifiConnected);
        }

        if (!wifiConnected) {
          sessionManager.pause();
          if (!cancelled) {
            setSessionState(SessionState.PAUSED);
          }
          return;
        }

        const valid = await checkSession(savedSession.uid);
        if (cancelled) {
          return;
        }

        if (valid) {
          await activateSession(savedSession);
        } else {
          sessionManager.promptReconnect();
          setSessionState(SessionState.RECONNECT_PROMPT);
        }
      } catch {
        if (!cancelled) {
          sessionManager.pause();
          setSessionState(SessionState.PAUSED);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [activateSession]);

  useEffect(() => {
    const checkNetwork = async () => {
      try {
        if (appModeManager.isTestMode) {
          setIsWifiConnected(true);
          return;
        }

        const networkState = await Network.getNetworkStateAsync();
        let wifiConnected = isWifiStateConnected(networkState);
        if (!wifiConnected && sessionRef.current) {
          wifiConnected = await canReachNodeQuick();
        }
        setIsWifiConnected(wifiConnected);

        const currentSession = sessionRef.current;
        if (!currentSession) {
          return;
        }

        if (!wifiConnected && sessionState === SessionState.ACTIVE) {
          sessionManager.pause();
          setSessionState(SessionState.PAUSED);
          stopLiveServices();
          return;
        }

        if (
          wifiConnected &&
          sessionState === SessionState.PAUSED &&
          !recoveringRef.current
        ) {
          recoveringRef.current = true;

          try {
            const valid = await checkSession(currentSession.uid);
            if (valid) {
              await activateSession(currentSession);
            } else {
              sessionManager.promptReconnect();
              setSessionState(SessionState.RECONNECT_PROMPT);
            }
          } finally {
            recoveringRef.current = false;
          }
        }
      } catch {
        // Ignore transient network failures.
      }
    };

    void checkNetwork();
    networkTimerRef.current = setInterval(checkNetwork, NETWORK_CHECK_INTERVAL_MS);

    return () => {
      if (networkTimerRef.current) {
        clearInterval(networkTimerRef.current);
        networkTimerRef.current = null;
      }
    };
  }, [activateSession, sessionState, stopLiveServices]);

  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'active' && sessionRef.current && sessionState === SessionState.ACTIVE) {
        void refreshAll();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppState);
    return () => {
      subscription.remove();
    };
  }, [refreshAll, sessionState]);

  useEffect(() => {
    if (sessionState !== SessionState.ACTIVE || !sessionRef.current) {
      return;
    }

    const pushPing = async () => {
      const activeSession = sessionRef.current;
      if (!activeSession) {
        return;
      }

      if (!appModeManager.isTestMode && !isWifiConnected) {
        return;
      }

      try {
        const result = await pingNode(activeSession.uid);
        const stamp = timestampLabel();
        const line =
          typeof result.rssi === 'number'
            ? `${stamp}  RSSI ${result.rssi} dBm${typeof result.ms === 'number' ? `  ${result.ms} ms` : ''}`
            : result.status
              ? `${stamp}  ${result.status}`
              : `${stamp}  Ping sent`;

        setPingStatus(line);
        appendLog(line);
      } catch {
        const stamp = timestampLabel();
        const line = `${stamp}  Ping failed`;
        setPingStatus(line);
        appendLog(line);
      }
    };

    void pushPing();
    const timer = setInterval(() => {
      void pushPing();
    }, PING_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [appendLog, isWifiConnected, sessionState]);

  useEffect(() => {
    if (sessionState !== SessionState.ACTIVE || !sessionRef.current) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    pollTimerRef.current = setInterval(() => {
      void refreshAll();
    }, APP_REFRESH_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [refreshAll, sessionState]);

  const login = useCallback(
    async (name: string, adminKey = '') => {
      try {
        if (appModeManager.isTestMode) {
          // Prevent accidental mock-mode usage when a real ESP32 node is reachable.
          const liveNodeDetected = await canReachNodeQuick(false);
          if (liveNodeDetected) {
            await appModeManager.setMode('live');
            setAppModeState('live');
          }
        }

        if (!appModeManager.isTestMode) {
          // Respect manually selected host first; then fallback to discovery.
          let reachable = await canReachNodeQuick(false);
          if (!reachable) {
            await discoverNodeHost(true);
            reachable = await canReachNodeQuick(false);
          }
          if (!reachable) {
            Alert.alert(
              'ESP32 Not Reachable',
              'Connected WiFi could not reach /info on the selected node host. Try another host in LIVE mode and retry.'
            );
            return false;
          }
        }

        const result = await joinSession(name, adminKey);
        if (result.error) {
          Alert.alert('Error', result.error);
          return false;
        }

        stopLiveServices();
        resetTransientState();

        const nextSession: SessionData = {
          username: name,
          uid: result.uid,
          isAdmin: result.admin,
          adminKey: adminKey.trim() || undefined,
          startedAt: Date.now(),
        };

        await sessionManager.saveSession(nextSession);
        await activateSession(nextSession);
        return true;
      } catch {
        Alert.alert(
          'Connection Error',
          'Cannot reach the ESP32. Connect to the LoRa WiFi access point and try again.'
        );
        return false;
      }
    },
    [activateSession, resetTransientState, stopLiveServices]
  );

  const startNewSession = useCallback(async () => {
    const seed = await sessionManager.prepareNewSession();
    if (!seed) {
      return false;
    }

    return login(seed.username, seed.adminKey || '');
  }, [login]);

  const logout = useCallback(() => {
    stopLiveServices();
    sessionRef.current = null;
    setSession(null);
    setSessionState(SessionState.NO_SESSION);
    setConnectionState(ConnectionState.DISCONNECTED);
    resetTransientState();
    void sessionManager.clearSession();
  }, [resetTransientState, stopLiveServices]);

  const value: AppStateContextValue = {
    appMode,
    session,
    sessionState,
    setAppMode,
    login,
    logout,
    startNewSession,
    connectionState,
    isWifiConnected,
    messages,
    users,
    messageCount: messages.length,
    myLat,
    myLng,
    myAccuracy,
    gpsPositions,
    gpsActive,
    nodeInfo,
    stats,
    pingStatus,
    pingLogs,
    refreshUsers,
    refreshMessages,
    refreshNodeData,
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}
