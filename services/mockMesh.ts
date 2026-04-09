import {
  MAP_CENTER,
  TEST_ADMIN_KEY,
  TEST_NODE_SEEDS,
} from '../constants/config';
import {
  ChatMessage,
  GPSPosition,
  JoinResponse,
  NodeInfo,
  PingInfo,
  StatsInfo,
  UserInfo,
} from './apiClient';

type MeshEvent =
  | ({ type: 'chat' } & ChatMessage)
  | { type: 'gps'; uid: string; name: string; lat: number; lng: number };

interface MockUserState extends UserInfo {
  lat: number;
  lng: number;
  hasGPS: boolean;
}

function nowLabel() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function seedUserPosition(index: number) {
  return {
    lat: MAP_CENTER.lat + (index % 3) * 0.0038,
    lng: MAP_CENTER.lng - (index % 4) * 0.0032,
  };
}

class MockMesh {
  private users: MockUserState[] = [];
  private messages: ChatMessage[] = [];
  private listeners: Array<(event: MeshEvent) => void> = [];
  private nextUserId = 1;
  private nodeLat: number | null = TEST_NODE_SEEDS[0].lat;
  private nodeLng: number | null = TEST_NODE_SEEDS[0].lng;

  constructor() {
    this.messages.push({
      sender: 'System',
      suid: '',
      text: 'Test mesh active around Amaravati.',
      time: nowLabel(),
      channel: 'system',
      target: '',
      prio: '',
      rssi: 0,
    });
  }

  private emit(event: MeshEvent) {
    this.listeners.forEach((listener) => listener(event));
  }

  private pushMessage(message: ChatMessage) {
    this.messages.push(message);
    this.emit({ type: 'chat', ...message });
  }

  private broadcastNodePosition() {
    if (this.nodeLat == null || this.nodeLng == null) {
      return;
    }

    this.emit({
      type: 'gps',
      uid: 'Node-A',
      name: 'Node-A',
      lat: this.nodeLat,
      lng: this.nodeLng,
    });
  }

  subscribe(listener: (event: MeshEvent) => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  async joinSession(name: string, adminKey = ''): Promise<JoinResponse> {
    const trimmed = name.trim();
    const existing = this.users.find((user) => user.name.toLowerCase() === trimmed.toLowerCase());
    const isAdmin = adminKey.trim() === TEST_ADMIN_KEY;

    if (existing) {
      existing.admin = isAdmin;
      return { uid: existing.uid, admin: existing.admin };
    }

    const uid = `T${String(this.nextUserId++).padStart(2, '0')}`;
    const seed = seedUserPosition(this.users.length);
    const user: MockUserState = {
      uid,
      name: trimmed,
      admin: isAdmin,
      muted: false,
      msgs: 0,
      lat: seed.lat,
      lng: seed.lng,
      hasGPS: true,
    };

    this.users.push(user);
    this.pushMessage({
      sender: 'System',
      suid: '',
      text: `${trimmed} (${uid}) joined test mesh`,
      time: nowLabel(),
      channel: 'system',
      target: '',
      prio: '',
      rssi: 0,
    });

    if (isAdmin || this.nodeLat == null || this.nodeLng == null) {
      this.nodeLat = seed.lat;
      this.nodeLng = seed.lng;
      this.broadcastNodePosition();
    }

    return { uid, admin: isAdmin };
  }

  async sendMessage(uid: string, msg: string, target = '', prio = '') {
    const user = this.users.find((entry) => entry.uid === uid);
    if (!user || user.muted) {
      return false;
    }

    user.msgs += 1;
    this.pushMessage({
      sender: user.name,
      suid: user.uid,
      text: msg,
      time: nowLabel(),
      channel: 'wifi',
      target,
      prio,
      rssi: 0,
    });

    if (!target && prio !== 'sos') {
      setTimeout(() => {
        this.pushMessage({
          sender: 'EchoBot@Node-B',
          suid: 'Node-B',
          text: `Relay check from Node-B: ${msg}`,
          time: nowLabel(),
          channel: 'lora',
          target: '',
          prio: '',
          rssi: -58,
        });
      }, 1200);
    }

    return true;
  }

  async getMessages() {
    return [...this.messages];
  }

  async getUsers() {
    return this.users.map(({ lat: _lat, lng: _lng, hasGPS: _hasGPS, ...user }) => ({ ...user }));
  }

  async getInfo(): Promise<NodeInfo> {
    return {
      node: 'Node-A',
      freq: '433 MHz',
      sf: 12,
      bw: 62,
      cr: 8,
      pwr: 20,
      test: true,
      uptime: 'TEST MODE',
      ssid: 'Mock Mesh',
      ip: '127.0.0.1',
    };
  }

  async getStats(): Promise<StatsInfo> {
    return {
      users: this.users.length,
      msgs: this.messages.length,
      tx: this.messages.filter((message) => message.channel === 'wifi').length,
      rx: this.messages.filter((message) => message.channel === 'lora').length,
      heap: 999999,
    };
  }

  async sendGPS(uid: string, lat: number, lng: number) {
    const user = this.users.find((entry) => entry.uid === uid);
    if (!user) {
      return false;
    }

    user.lat = lat;
    user.lng = lng;
    user.hasGPS = true;

    this.emit({ type: 'gps', uid: user.uid, name: user.name, lat, lng });

    if (user.admin || this.nodeLat == null || this.nodeLng == null) {
      this.nodeLat = lat;
      this.nodeLng = lng;
      this.broadcastNodePosition();
    }

    return true;
  }

  async getAllGPS(): Promise<GPSPosition[]> {
    const positions: GPSPosition[] = this.users.map((user) => ({
      uid: user.uid,
      name: user.name,
      lat: user.lat,
      lng: user.lng,
      hasGPS: user.hasGPS,
    }));

    if (this.nodeLat != null && this.nodeLng != null) {
      positions.push({
        uid: 'Node-A',
        name: 'Node-A',
        lat: this.nodeLat,
        lng: this.nodeLng,
        hasGPS: true,
      });
    }

    TEST_NODE_SEEDS.slice(1).forEach((node) => {
      positions.push({
        uid: node.uid,
        name: node.name,
        lat: node.lat,
        lng: node.lng,
        hasGPS: true,
      });
    });

    return positions;
  }

  async checkSession(uid: string) {
    return this.users.some((user) => user.uid === uid);
  }

  async pingNode(): Promise<PingInfo> {
    return { rssi: -42, ms: 120, test: true };
  }

  async kickUser(uid: string, target: string) {
    const admin = this.users.find((user) => user.uid === uid);
    if (!admin?.admin) {
      return false;
    }

    this.users = this.users.filter((user) => user.uid !== target);
    this.pushMessage({
      sender: 'Admin',
      suid: '',
      text: `${target} removed from test mesh`,
      time: nowLabel(),
      channel: 'system',
      target: '',
      prio: '',
      rssi: 0,
    });
    return true;
  }

  async muteUser(uid: string, target: string) {
    const admin = this.users.find((user) => user.uid === uid);
    const targetUser = this.users.find((user) => user.uid === target);
    if (!admin?.admin || !targetUser) {
      return false;
    }
    targetUser.muted = !targetUser.muted;
    return true;
  }

  async clearChat(uid: string) {
    const admin = this.users.find((user) => user.uid === uid);
    if (!admin?.admin) {
      return false;
    }

    this.messages = this.messages.filter((message) => message.channel === 'system');
    this.pushMessage({
      sender: 'Admin',
      suid: '',
      text: 'Chat cleared in test mesh',
      time: nowLabel(),
      channel: 'system',
      target: '',
      prio: '',
      rssi: 0,
    });
    return true;
  }

  async restartNode(uid: string) {
    const admin = this.users.find((user) => user.uid === uid);
    if (!admin?.admin) {
      return false;
    }

    this.pushMessage({
      sender: 'Admin',
      suid: '',
      text: 'Node-A test restart requested',
      time: nowLabel(),
      channel: 'system',
      target: '',
      prio: '',
      rssi: 0,
    });
    return true;
  }
}

export const mockMesh = new MockMesh();
