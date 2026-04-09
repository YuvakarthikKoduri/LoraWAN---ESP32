// ESP32 LoRa Chat - App Configuration

export const ESP32_IP = '192.168.4.1';
export const HTTP_PORT = 80;
export const WS_PORT = 81;

export const BASE_URL = `http://${ESP32_IP}`;
export const WS_URL = `ws://${ESP32_IP}:${WS_PORT}`;

// Discovery allow-list (editable for multi-node deployments)
export const AUTHORIZED_NODE_NAMES = ['Node-A', 'Node-B'];
export const AUTHORIZED_NODE_NAME_HINTS = ['Node-'];
export const AUTHORIZED_SSID_HINTS = ['LoRaChat', 'LoraChat'];

export const DEFAULT_APP_MODE = 'live' as const;
export const TEST_ADMIN_KEY = 'admin123';
export const BACKGROUND_LOCATION_TASK = 'lora-background-location';

// GPS configuration
export const GPS_INTERVAL_MS = 2000;
export const GPS_HIGH_ACCURACY = true;
export const GPS_SEND_INTERVAL_MS = 7000;
export const APP_REFRESH_INTERVAL_MS = 2000;
export const NETWORK_CHECK_INTERVAL_MS = 2000;
export const PING_INTERVAL_MS = 7000;

// Amaravati, Andhra Pradesh - city center for APK testing
export const MAP_CENTER = {
  lat: 16.513783,
  lng: 80.515669,
};

export const MAP_BOUNDS = {
  north: 16.59,
  south: 16.46,
  east: 80.58,
  west: 80.45,
};

export const MAP_MIN_ZOOM = 14;
export const MAP_MAX_ZOOM = 18;
export const MAP_DEFAULT_ZOOM = 16;

export const AMARAVATI_POIS = [
  { name: 'Amaravati Center', lat: 16.513783, lng: 80.515669, icon: 'CT' },
  { name: 'Seed Access Road', lat: 16.5221, lng: 80.5098, icon: 'RD' },
  { name: 'Riverfront', lat: 16.5194, lng: 80.5282, icon: 'RV' },
  { name: 'Government Complex', lat: 16.5072, lng: 80.5128, icon: 'GC' },
  { name: 'High Court Zone', lat: 16.5035, lng: 80.5174, icon: 'HC' },
];

// VIT-AP University test area
export const VITAP_MAP_CENTER = {
  lat: 16.4939,
  lng: 80.5034,
};

export const VITAP_MAP_BOUNDS = {
  north: 16.512,
  south: 16.476,
  east: 80.519,
  west: 80.486,
};

export const VITAP_POIS = [
  { name: 'VIT-AP Main Gate', lat: 16.4932, lng: 80.5042, icon: 'GT' },
  { name: 'Academic Block', lat: 16.4945, lng: 80.5029, icon: 'AC' },
  { name: 'Hostels Zone', lat: 16.4924, lng: 80.5058, icon: 'HS' },
  { name: 'Central Lawn', lat: 16.4941, lng: 80.5015, icon: 'LW' },
];

export const TEST_NODE_SEEDS = [
  { uid: 'Node-A', name: 'Node-A', lat: 16.513783, lng: 80.515669 },
  { uid: 'Node-B', name: 'Node-B', lat: 16.5208, lng: 80.5074 },
  { uid: 'Node-C', name: 'Node-C', lat: 16.5042, lng: 80.5251 },
];

export const Colors = {
  bg: '#06090f',
  surface1: '#0c1018',
  surface2: '#121a28',
  surface3: '#182030',
  border: '#1e2d42',
  accent: '#5ba3ff',
  accent2: '#3d8bef',
  green: '#34d399',
  warning: '#fbbf24',
  red: '#ef4444',
  text: '#e2e8f0',
  textSecondary: '#64748b',
  ownBubble: '#0f2847',
  otherBubble: '#0f1724',
};

export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
}

export enum SessionState {
  NO_SESSION = 'no_session',
  ACTIVE = 'active',
  PAUSED = 'paused',
  RECONNECT_PROMPT = 'reconnect_prompt',
}
