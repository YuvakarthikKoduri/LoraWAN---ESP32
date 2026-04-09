import { appModeManager } from './appMode';
import { mockMesh } from './mockMesh';
import {
  discoverNodeHost,
  getActiveHost,
  getBaseUrl,
  getCandidateHosts,
  setActiveHost,
} from './nodeEndpoint';

export interface JoinResponse {
  uid: string;
  admin: boolean;
  error?: string;
}

export interface UserInfo {
  name: string;
  uid: string;
  admin: boolean;
  muted: boolean;
  msgs: number;
}

export interface ChatMessage {
  sender: string;
  suid: string;
  text: string;
  time: string;
  channel: string;
  target: string;
  prio: string;
  rssi: number;
}

export interface NodeInfo {
  node: string;
  freq: string;
  sf: number;
  bw: number;
  cr: number;
  pwr: number;
  test: boolean;
  uptime: string;
  ssid: string;
  ip: string;
}

export interface StatsInfo {
  users: number;
  msgs: number;
  tx: number;
  rx: number;
  heap: number;
}

export interface GPSPosition {
  uid: string;
  name: string;
  lat: number;
  lng: number;
  hasGPS: boolean;
}

export interface PingInfo {
  rssi?: number;
  ms?: number;
  test?: boolean;
  status?: string;
}

export interface ApiActionResult {
  ok: boolean;
  status: number;
  body: string;
}

function encodeForm(values: Record<string, string | number>) {
  return Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchNode(path: string, options: RequestInit = {}, timeoutMs = 5000) {
  const triedHosts = new Set<string>();
  const perHostTimeout = Math.min(timeoutMs, 1800);

  const fetchFromHost = async (host: string) => {
    triedHosts.add(host);
    const response = await fetchWithTimeout(`http://${host}${path}`, options, perHostTimeout);
    setActiveHost(host);
    return response;
  };

  try {
    return await fetchFromHost(getActiveHost());
  } catch {
    if (!appModeManager.isTestMode) {
      await discoverNodeHost(true);
    }
  }

  try {
    return await fetchFromHost(getActiveHost());
  } catch {
    // Continue with brute-force scan.
  }

  const hosts = await getCandidateHosts();
  let lastError: unknown = null;

  for (const host of hosts) {
    if (triedHosts.has(host)) {
      continue;
    }
    try {
      return await fetchFromHost(host);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return fetchWithTimeout(`${getBaseUrl()}${path}`, options, timeoutMs);
}

export async function joinSession(name: string, adminKey = ''): Promise<JoinResponse> {
  if (appModeManager.isTestMode) {
    return mockMesh.joinSession(name, adminKey);
  }
  const response = await fetchNode('/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({ name, key: adminKey }),
  });
  return response.json();
}

export async function sendMessage(
  uid: string,
  msg: string,
  target = '',
  prio = '',
  name = ''
): Promise<ApiActionResult> {
  if (appModeManager.isTestMode) {
    await mockMesh.sendMessage(uid, msg, target, prio);
    return { ok: true, status: 200, body: 'OK' };
  }
  const payload: Record<string, string> = { uid, msg, target, prio };
  if (name.trim().length > 0) {
    payload.name = name.trim();
  }
  const response = await fetchNode('/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm(payload),
  });
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

export async function getMessages(uid: string): Promise<ChatMessage[]> {
  if (appModeManager.isTestMode) {
    return mockMesh.getMessages();
  }
  const response = await fetchNode(`/messages?from=0&uid=${encodeURIComponent(uid)}`);
  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '';
    }
    throw new Error(body || `HTTP ${response.status}`);
  }
  return response.json();
}

export async function getUsers(): Promise<UserInfo[]> {
  if (appModeManager.isTestMode) {
    return mockMesh.getUsers();
  }
  const response = await fetchNode('/users');
  return response.json();
}

export async function getInfo(): Promise<NodeInfo> {
  if (appModeManager.isTestMode) {
    return mockMesh.getInfo();
  }
  const response = await fetchNode('/info');
  return response.json();
}

export async function getStats(): Promise<StatsInfo> {
  if (appModeManager.isTestMode) {
    return mockMesh.getStats();
  }
  const response = await fetchNode('/stats');
  return response.json();
}

export async function sendGPS(uid: string, lat: number, lon: number, name = '') {
  if (appModeManager.isTestMode) {
    return mockMesh.sendGPS(uid, lat, lon);
  }
  const payload: Record<string, string | number> = { uid, lat, lon };
  if (name.trim().length > 0) {
    payload.name = name.trim();
  }
  const response = await fetchNode('/gps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm(payload),
  });
  return response.ok;
}

export async function getAllGPS(): Promise<GPSPosition[]> {
  if (appModeManager.isTestMode) {
    return mockMesh.getAllGPS();
  }
  const response = await fetchNode('/allgps');
  return response.json();
}

export async function checkSession(uid: string) {
  if (appModeManager.isTestMode) {
    return mockMesh.checkSession(uid);
  }
  try {
    const response = await fetchNode(`/session?uid=${encodeURIComponent(uid)}`);
    const payload = await response.json();
    return payload.valid === true;
  } catch {
    return false;
  }
}

export async function pingNode(uid: string): Promise<PingInfo> {
  if (appModeManager.isTestMode) {
    return mockMesh.pingNode();
  }
  const response = await fetchNode(`/ping?uid=${encodeURIComponent(uid)}`);
  return response.json();
}

export async function kickUser(uid: string, target: string) {
  if (appModeManager.isTestMode) {
    return mockMesh.kickUser(uid, target);
  }
  const response = await fetchNode('/kick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({ uid, target }),
  });
  return response.ok;
}

export async function muteUser(uid: string, target: string) {
  if (appModeManager.isTestMode) {
    return mockMesh.muteUser(uid, target);
  }
  const response = await fetchNode('/mute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({ uid, target }),
  });
  return response.ok;
}

export async function clearChat(uid: string) {
  if (appModeManager.isTestMode) {
    return mockMesh.clearChat(uid);
  }
  const response = await fetchNode('/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({ uid }),
  });
  return response.ok;
}

export async function restartNode(uid: string) {
  if (appModeManager.isTestMode) {
    return mockMesh.restartNode(uid);
  }
  const response = await fetchNode('/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({ uid }),
  });
  return response.ok;
}
