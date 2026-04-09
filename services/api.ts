// ESP32 LoRa Chat — HTTP API Service

import { BASE_URL } from '../constants/config';

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

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export async function joinSession(name: string, adminKey: string = ''): Promise<JoinResponse> {
  const response = await fetchWithTimeout(`${BASE_URL}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `name=${encodeURIComponent(name)}&key=${encodeURIComponent(adminKey)}`,
  });
  return response.json();
}

export async function sendMessage(uid: string, msg: string, target: string = '', prio: string = ''): Promise<boolean> {
  const response = await fetchWithTimeout(`${BASE_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `msg=${encodeURIComponent(msg)}&uid=${encodeURIComponent(uid)}&target=${encodeURIComponent(target)}&prio=${prio}`,
  });
  return response.ok;
}

export async function getMessages(from: number, uid: string): Promise<ChatMessage[]> {
  const response = await fetchWithTimeout(`${BASE_URL}/messages?from=${from}&uid=${encodeURIComponent(uid)}`);
  return response.json();
}

export async function getUsers(): Promise<UserInfo[]> {
  const response = await fetchWithTimeout(`${BASE_URL}/users`);
  return response.json();
}

export async function getInfo(): Promise<NodeInfo> {
  const response = await fetchWithTimeout(`${BASE_URL}/info`);
  return response.json();
}

export async function getStats(): Promise<StatsInfo> {
  const response = await fetchWithTimeout(`${BASE_URL}/stats`);
  return response.json();
}

export async function sendGPS(uid: string, lat: number, lon: number): Promise<boolean> {
  const response = await fetchWithTimeout(`${BASE_URL}/gps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `uid=${encodeURIComponent(uid)}&lat=${lat}&lon=${lon}`,
  });
  return response.ok;
}

export async function getAllGPS(): Promise<GPSPosition[]> {
  const response = await fetchWithTimeout(`${BASE_URL}/allgps`);
  return response.json();
}

export async function checkSession(uid: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/session?uid=${encodeURIComponent(uid)}`);
    const data = await response.json();
    return data.valid === true;
  } catch {
    return false;
  }
}

export async function pingNode(uid: string): Promise<any> {
  const response = await fetchWithTimeout(`${BASE_URL}/ping?uid=${encodeURIComponent(uid)}`);
  return response.json();
}

export async function kickUser(uid: string, target: string): Promise<boolean> {
  const response = await fetchWithTimeout(`${BASE_URL}/kick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `uid=${encodeURIComponent(uid)}&target=${encodeURIComponent(target)}`,
  });
  return response.ok;
}

export async function muteUser(uid: string, target: string): Promise<boolean> {
  const response = await fetchWithTimeout(`${BASE_URL}/mute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `uid=${encodeURIComponent(uid)}&target=${encodeURIComponent(target)}`,
  });
  return response.ok;
}

export async function clearChat(uid: string): Promise<boolean> {
  const response = await fetchWithTimeout(`${BASE_URL}/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `uid=${encodeURIComponent(uid)}`,
  });
  return response.ok;
}
