// ESP32 LoRa Chat — WebSocket Service

import { ConnectionState } from '../constants/config';
import { appModeManager } from './appMode';
import { mockMesh } from './mockMesh';
import { discoverNodeHost, getWsUrl } from './nodeEndpoint';

type MessageHandler = (data: any) => void;
type StateHandler = (state: ConnectionState) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private mockUnsubscribe: (() => void) | null = null;
  private messageHandlers: MessageHandler[] = [];
  private stateHandlers: StateHandler[] = [];
  private _state: ConnectionState = ConnectionState.DISCONNECTED;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;

  get state(): ConnectionState {
    return this._state;
  }

  private setState(state: ConnectionState) {
    this._state = state;
    this.stateHandlers.forEach(h => h(state));
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (appModeManager.isTestMode) {
      this.shouldReconnect = false;
      this.mockUnsubscribe?.();
      this.mockUnsubscribe = mockMesh.subscribe((event) => {
        this.messageHandlers.forEach((handler) => handler(event));
      });
      this.setState(ConnectionState.CONNECTED);
      return;
    }

    this.shouldReconnect = true;
    this.setState(ConnectionState.CONNECTING);

    void this.connectLive();
  }

  private async connectLive() {
    try {
      await discoverNodeHost();
      this.ws = new WebSocket(getWsUrl());

      this.ws.onopen = () => {
        console.log('[WS] Connected');
        this.setState(ConnectionState.CONNECTED);
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          this.messageHandlers.forEach(h => h(data));
        } catch (e) {
          console.log('[WS] Parse error:', e);
        }
      };

      this.ws.onerror = (error: Event) => {
        console.log('[WS] Error:', error);
      };

      this.ws.onclose = () => {
        console.log('[WS] Disconnected');
        this.setState(ConnectionState.DISCONNECTED);
        this.ws = null;
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };
    } catch (e) {
      console.log('[WS] Connection failed:', e);
      this.setState(ConnectionState.DISCONNECTED);
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.setState(ConnectionState.RECONNECTING);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.connect();
      }
    }, 3000);
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.mockUnsubscribe) {
      this.mockUnsubscribe();
      this.mockUnsubscribe = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState(ConnectionState.DISCONNECTED);
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
    };
  }

  onStateChange(handler: StateHandler) {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter(h => h !== handler);
    };
  }

  send(data: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }
}

export const wsService = new WebSocketService();
