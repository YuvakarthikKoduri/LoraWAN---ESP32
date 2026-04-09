import * as Network from 'expo-network';
import {
  AUTHORIZED_NODE_NAMES,
  AUTHORIZED_NODE_NAME_HINTS,
  AUTHORIZED_SSID_HINTS,
  ESP32_IP,
  WS_PORT,
} from '../constants/config';

const DEFAULT_HOSTS = [
  '192.168.4.1',
  ESP32_IP,
  '192.168.0.1',
  '192.168.1.1',
  '192.168.43.1',
  '192.168.137.1',
];
const AUTH_SSID_HINTS = AUTHORIZED_SSID_HINTS.map((entry) => entry.toLowerCase());
const AUTH_NODE_HINTS = [...AUTHORIZED_NODE_NAMES, ...AUTHORIZED_NODE_NAME_HINTS].map((entry) =>
  entry.toLowerCase()
);
const PROBE_TIMEOUT_MS = 2200;

let activeHost = ESP32_IP;

function uniq(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function deriveGatewayHost(localIp: string | null) {
  if (!localIp || localIp === '0.0.0.0') {
    return null;
  }
  const parts = localIp.split('.');
  if (parts.length !== 4) {
    return null;
  }
  parts[3] = '1';
  return parts.join('.');
}

function subnetCandidates(localIp: string | null) {
  if (!localIp || localIp === '0.0.0.0') {
    return [];
  }
  const parts = localIp.split('.');
  if (parts.length !== 4) {
    return [];
  }

  const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  return ['1', '2', '3', '4', '5'].map((tail) => `${prefix}.${tail}`);
}

function isAuthorizedInfo(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const item = payload as Record<string, unknown>;
  const ssid = String(item.ssid || '').toLowerCase();
  const node = String(item.node || '').toLowerCase();

  const ssidOk = AUTH_SSID_HINTS.some((hint) => ssid.includes(hint));
  const nodeOk = AUTH_NODE_HINTS.some((hint) => node.includes(hint));
  return ssidOk || nodeOk;
}

function isNodeInfoLike(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const item = payload as Record<string, unknown>;
  return (
    typeof item.node === 'string' ||
    typeof item.ssid === 'string' ||
    typeof item.freq === 'string'
  );
}

// 2 = authorized node, 1 = valid node info but not in allow-list, 0 = not a node.
async function probeHost(host: string, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const url = `http://${host}/info`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        return 0;
      }

      const payload = await response.json();
      if (isAuthorizedInfo(payload)) {
        return 2;
      }
      if (isNodeInfoLike(payload)) {
        return 1;
      }
      return 0;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return 0;
  }
}

export async function getCandidateHosts() {
  let gatewayHost = '';
  let localIp = '';
  try {
    localIp = await Network.getIpAddressAsync();
    gatewayHost = deriveGatewayHost(localIp) || '';
  } catch {
    localIp = '';
    gatewayHost = '';
  }

  return uniq([activeHost, gatewayHost, ...subnetCandidates(localIp), ...DEFAULT_HOSTS]);
}

export async function discoverNodeHost(force = false) {
  if (!force && (await probeHost(activeHost)) >= 1) {
    return activeHost;
  }

  const hosts = await getCandidateHosts();
  let fallbackHost = '';

  for (const host of hosts) {
    const level = await probeHost(host);
    if (level === 2) {
      activeHost = host;
      return activeHost;
    }
    if (level === 1 && !fallbackHost) {
      fallbackHost = host;
    }
  }

  if (fallbackHost) {
    activeHost = fallbackHost;
  }

  return activeHost;
}

export function getBaseUrl() {
  return `http://${activeHost}`;
}

export function getWsUrl() {
  return `ws://${activeHost}:${WS_PORT}`;
}

export function getActiveHost() {
  return activeHost;
}

export function setActiveHost(host: string) {
  if (host && host.trim().length > 0) {
    activeHost = host.trim();
  }
}
