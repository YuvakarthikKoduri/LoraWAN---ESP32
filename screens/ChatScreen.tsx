import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Audio } from 'expo-av';
import * as Clipboard from 'expo-clipboard';
import { Colors, ConnectionState, PING_INTERVAL_MS, SessionState } from '../constants/config';
import { useApp } from '../services/AppStateContext';
import {
  ChatMessage,
  clearChat,
  kickUser,
  muteUser,
  restartNode,
  sendMessage,
} from '../services/apiClient';
import { sessionManager } from '../services/sessionManager';

type Tab = 'group' | 'broadcast' | 'dm' | 'logs' | 'info';

function isNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatCoord(value: number | null) {
  return isNumber(value) ? value.toFixed(6) : 'Unavailable';
}

function isPingLogMessage(message: ChatMessage) {
  return (
    message.channel === 'system' &&
    /\b(ping|pong|rssi)\b/i.test(message.text)
  );
}

function isGpsTelemetryMessage(message: ChatMessage) {
  return /(?:^|\s)GPS:/i.test(message.text);
}

function isSOSMessage(message: ChatMessage) {
  return (
    message.prio === 'sos' ||
    /(?:^|\s)SOS(?:\s|$)/i.test(message.text) ||
    /🚨/.test(message.text)
  );
}

interface ParsedGPS {
  prefix: string;
  lat: number;
  lng: number;
}

const GPS_COORD_PATTERN = /([\s\S]*?)(?:📍\s*)?GPS:\s*([+\-]?\d+(?:\.\d+)?)\s*,\s*([+\-]?\d+(?:\.\d+)?)/i;

function parseGPS(text: string): ParsedGPS | null {
  const match = text.match(GPS_COORD_PATTERN);
  if (!match) {
    return null;
  }
  const lat = Number(match[2]);
  const lng = Number(match[3]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return { prefix: match[1].trim(), lat, lng };
}

export default function ChatScreen() {
  const {
    appMode,
    connectionState,
    gpsActive,
    gpsPositions,
    isWifiConnected,
    logout,
    messages,
    myAccuracy,
    myLat,
    myLng,
    nodeInfo,
    pingLogs,
    pingStatus,
    refreshMessages,
    refreshNodeData,
    refreshUsers,
    session,
    sessionState,
    startNewSession,
    stats,
    users,
  } = useApp();
  const router = useRouter();
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const [tab, setTab] = useState<Tab>('group');
  const [dmTarget, setDmTarget] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [showReconnectModal, setShowReconnectModal] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const sosSoundRef = useRef<Audio.Sound | null>(null);
  const didPrimeSOSAlertRef = useRef(false);
  const lastSOSAlertKeyRef = useRef('');

  const canSend = sessionState === SessionState.ACTIVE && isWifiConnected;
  const isAdmin = session?.isAdmin === true;

  useEffect(() => {
    if (!session && sessionState === SessionState.NO_SESSION) {
      router.replace('/login');
    }
  }, [router, session, sessionState]);

  useEffect(() => {
    if (sessionState === SessionState.RECONNECT_PROMPT && session) {
      setShowReconnectModal(true);
    }
  }, [session, sessionState]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 80);
    return () => clearTimeout(timeoutId);
  }, [messages.length]);

  useEffect(() => {
    void Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
    });

    return () => {
      const sound = sosSoundRef.current;
      sosSoundRef.current = null;
      if (sound) {
        void sound.unloadAsync();
      }
    };
  }, []);

  const playSOSAlert = useCallback(async () => {
    try {
      if (!sosSoundRef.current) {
        const { sound } = await Audio.Sound.createAsync(
          require('../assets/audio/sos-ping.wav'),
          { shouldPlay: false, isLooping: false, volume: 1 }
        );
        sosSoundRef.current = sound;
      }
      await sosSoundRef.current.replayAsync();
    } catch {
      Vibration.vibrate(250);
    }
  }, []);

  useEffect(() => {
    if (!session || messages.length === 0) {
      return;
    }

    const latest = messages[messages.length - 1];
    const key = `${latest.time}|${latest.suid}|${latest.text}|${latest.prio}|${latest.channel}`;

    if (!didPrimeSOSAlertRef.current) {
      didPrimeSOSAlertRef.current = true;
      lastSOSAlertKeyRef.current = key;
      return;
    }
    if (lastSOSAlertKeyRef.current === key) {
      return;
    }
    lastSOSAlertKeyRef.current = key;

    if (isSOSMessage(latest) && latest.suid && latest.suid !== session.uid) {
      Vibration.vibrate([180, 120, 180, 120, 280]);
      void playSOSAlert();
    }
  }, [messages, playSOSAlert, session]);

  const handleOpenMap = useCallback((lat: number, lng: number) => {
    void Linking.openURL(`https://maps.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`);
  }, []);

  const handleCopyCoords = useCallback((lat: number, lng: number) => {
    void Clipboard.setStringAsync(`${lat.toFixed(6)},${lng.toFixed(6)}`);
  }, []);

  if (!session) {
    return null;
  }

  const peers = users.filter((user) => user.uid !== session.uid);
  const targetName = peers.find((user) => user.uid === dmTarget)?.name || 'selected user';
  const filteredMessages = messages.filter((message) => {
    if (isPingLogMessage(message)) {
      return false;
    }
    if (isSOSMessage(message)) {
      return true;
    }
    if (isGpsTelemetryMessage(message)) {
      return false;
    }
    if (tab === 'group') {
      // Match web behavior: group includes normal + broadcast + system.
      return message.channel === 'system' || message.target === '' || message.target === '*';
    }
    if (tab === 'broadcast') {
      return message.target === '*';
    }
    if (tab === 'dm') {
      if (!dmTarget) {
        return (
          message.target !== '' &&
          message.target !== '*' &&
          (message.suid === session.uid || message.target === session.uid)
        );
      }
      return (
        (message.suid === session.uid && message.target === dmTarget) ||
        (message.suid === dmTarget && message.target === session.uid)
      );
    }
    return true;
  });

  const refreshEverything = async () => {
    await Promise.allSettled([refreshUsers(), refreshMessages(), refreshNodeData()]);
  };

  const handleNewSession = async () => {
    setReconnecting(true);
    try {
      const success = await startNewSession();
      if (success) {
        setShowReconnectModal(false);
      }
    } finally {
      setReconnecting(false);
    }
  };

  const handleLogout = () => {
    setShowReconnectModal(false);
    logout();
    router.replace('/login');
  };

  const handleSend = async () => {
    if (!canSend || !text.trim() || sending) {
      return;
    }

    if (tab === 'dm' && !dmTarget) {
      Alert.alert('Choose a user', 'Select a direct-message recipient first.');
      return;
    }

    setSending(true);
    const target = tab === 'dm' ? dmTarget : tab === 'broadcast' ? '*' : '';

    try {
      let result = await sendMessage(session.uid, text.trim(), target, '', session.username);
      if (!result.ok && /not registered/i.test(result.body)) {
        const resumed = await startNewSession();
        if (resumed) {
          const freshUid = sessionManager.data?.uid || session.uid;
          result = await sendMessage(freshUid, text.trim(), target, '', session.username);
        }
      }

      if (result.ok) {
        setText('');
      } else {
        Alert.alert('Send failed', result.body || `ESP32 rejected the message (HTTP ${result.status})`);
      }
    } catch {
      Alert.alert('Send failed', 'Unable to send the message right now.');
    } finally {
      setSending(false);
    }
  };

  const handleShareLocation = async () => {
    if (!canSend) {
      Alert.alert('Reconnect required', 'Reconnect to the LoRa WiFi network before sending.');
      return;
    }
    if (!isNumber(myLat) || !isNumber(myLng)) {
      Alert.alert('GPS unavailable', 'Wait for a location fix before sharing coordinates.');
      return;
    }
    const target = tab === 'dm' ? dmTarget : tab === 'broadcast' ? '*' : '';
    if (tab === 'dm' && !target) {
      Alert.alert('Choose a user', 'Select a direct-message recipient first.');
      return;
    }
    let result = await sendMessage(
      session.uid,
      `GPS:${myLat.toFixed(6)},${myLng.toFixed(6)} (+/-${myAccuracy}m)`,
      target,
      '',
      session.username
    );
    if (!result.ok && /not registered/i.test(result.body)) {
      const resumed = await startNewSession();
      if (resumed) {
        const freshUid = sessionManager.data?.uid || session.uid;
        result = await sendMessage(
          freshUid,
          `GPS:${myLat.toFixed(6)},${myLng.toFixed(6)} (+/-${myAccuracy}m)`,
          target,
          '',
          session.username
        );
      }
    }
    if (!result.ok) {
      Alert.alert('GPS send failed', result.body || `ESP32 rejected GPS message (HTTP ${result.status})`);
    }
  };

  const handleSOS = () => {
    if (!canSend) {
      return;
    }
    Alert.alert('Send SOS', 'Broadcast an SOS alert to every node?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send SOS',
        style: 'destructive',
        onPress: async () => {
          let body = 'SOS EMERGENCY';
          if (isNumber(myLat) && isNumber(myLng)) {
            body += ` GPS:${myLat.toFixed(6)},${myLng.toFixed(6)}`;
          }
          let result = await sendMessage(session.uid, body, '', 'sos', session.username);
          if (!result.ok && /not registered/i.test(result.body)) {
            const resumed = await startNewSession();
            if (resumed) {
              const freshUid = sessionManager.data?.uid || session.uid;
              result = await sendMessage(freshUid, body, '', 'sos', session.username);
            }
          }
          if (!result.ok) {
            Alert.alert('SOS failed', result.body || `ESP32 rejected SOS (HTTP ${result.status})`);
          }
        },
      },
    ]);
  };

  const handleUserActions = (uid: string, name: string, muted: boolean) => {
    if (!isAdmin || uid === session.uid) {
      return;
    }
    Alert.alert(`${name} [${uid}]`, 'Admin actions', [
      {
        text: muted ? 'Unmute' : 'Mute',
        onPress: async () => {
          const ok = await muteUser(session.uid, uid);
          if (ok) {
            await refreshEverything();
          }
        },
      },
      {
        text: 'Kick',
        style: 'destructive',
        onPress: async () => {
          const ok = await kickUser(session.uid, uid);
          if (ok) {
            if (dmTarget === uid) {
              setDmTarget('');
            }
            await refreshEverything();
          }
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleClearChat = () => {
    if (!isAdmin) {
      return;
    }
    Alert.alert('Clear chat', 'Remove the message history from the ESP32 node?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          const ok = await clearChat(session.uid);
          if (ok) {
            await refreshEverything();
          }
        },
      },
    ]);
  };

  const handleRestart = () => {
    if (!isAdmin) {
      return;
    }
    Alert.alert('Restart node', 'Restart the ESP32 node?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restart',
        style: 'destructive',
        onPress: async () => {
          await restartNode(session.uid);
        },
      },
    ]);
  };

  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => {
      const isOwn = item.suid === session.uid;
      const isSOS = isSOSMessage(item);
      const gps = parseGPS(item.text);
      const bodyText = gps ? gps.prefix : item.text;
      const hasBodyText = bodyText.trim().length > 0;
      if (item.channel === 'system') {
        return (
          <View style={styles.systemMsg}>
            <Text style={styles.systemText}>{item.text}</Text>
          </View>
        );
      }

      return (
        <View style={[styles.msgRow, isOwn ? styles.msgOwn : styles.msgOther]}>
          <Text style={[styles.meta, isOwn && styles.metaOwn]}>
            {isOwn ? 'You' : item.sender}
            {item.suid ? ` [${item.suid}]` : ''}
            {item.target === '*' ? ' [broadcast]' : ''}
            {item.target && item.target !== '*' ? ` -> ${item.target}` : ''}
            {isSOS ? '  🚨 SOS' : ''}
            {`  ${item.time}`}
          </Text>
          <View
            style={[
              styles.bubble,
              isOwn ? styles.bubbleOwn : styles.bubbleOther,
              item.target && item.target !== '*' && styles.bubbleDM,
              item.target === '*' && styles.bubbleBroadcast,
              isSOS && styles.bubbleSOS,
            ]}
          >
            {hasBodyText ? (
              <Text style={[styles.bubbleText, isSOS && styles.bubbleTextSOS]}>
                {bodyText}
              </Text>
            ) : null}
            {gps ? (
              <View style={[styles.gpsCard, isSOS && styles.gpsCardSOS]}>
                <Text style={styles.gpsLabel}>📍</Text>
                <Text style={styles.gpsCoords}>
                  {gps.lat.toFixed(6)}, {gps.lng.toFixed(6)}
                </Text>
                <TouchableOpacity
                  style={styles.gpsAction}
                  onPress={() => handleOpenMap(gps.lat, gps.lng)}
                >
                  <Text style={styles.gpsActionText}>MAP</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.gpsAction}
                  onPress={() => handleCopyCoords(gps.lat, gps.lng)}
                >
                  <Text style={styles.gpsActionText}>COPY</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
          {item.channel === 'lora' && item.rssi ? (
            <Text style={styles.rssi}>RSSI {item.rssi} dBm</Text>
          ) : null}
        </View>
      );
    },
    [handleCopyCoords, handleOpenMap, session.uid]
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 14}
    >
      <Modal visible={showReconnectModal} transparent animationType="fade" statusBarTranslucent>
        <View style={styles.modalWrap}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>WiFi Restored</Text>
            <Text style={styles.modalText}>
              Your last session was paused when WiFi dropped. Start a new session to resume sync.
            </Text>
            <TouchableOpacity style={styles.modalPrimary} onPress={handleNewSession}>
              {reconnecting ? (
                <ActivityIndicator color="#ffffff" size="small" />
              ) : (
                <Text style={styles.modalPrimaryText}>START NEW SESSION</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalSecondary} onPress={handleLogout}>
              <Text style={styles.modalSecondaryText}>LOG OUT</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <View style={styles.header}>
        <Text style={styles.title}>LORA WAN</Text>
        <Text style={styles.badge}>AES-128</Text>
        <Text style={styles.badge}>{appMode.toUpperCase()}</Text>
        <Text style={styles.badge}>{connectionState}</Text>
        <Text style={[styles.badge, styles.userBadge]}>
          {session.username}
          {isAdmin ? ' [admin]' : ''}
        </Text>
        <TouchableOpacity onPress={handleLogout}>
          <Text style={styles.logout}>LOG OUT</Text>
        </TouchableOpacity>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.userBar}>
        <View style={styles.userRow}>
          <Text style={styles.userLabel}>ONLINE</Text>
          {users.map((user) => (
            <TouchableOpacity
              key={user.uid}
              style={styles.userChip}
              onPress={() => {
                if (user.uid !== session.uid) {
                  setTab('dm');
                  setDmTarget(user.uid);
                }
              }}
              onLongPress={() => handleUserActions(user.uid, user.name, user.muted)}
            >
              <Text style={styles.userText}>
                {user.name} [{user.uid}]
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      <View style={styles.tabBar}>
        {(['group', 'broadcast', 'dm', 'logs', 'info'] as Tab[]).map((value) => (
          <TouchableOpacity
            key={value}
            style={[styles.tabBtn, tab === value && styles.tabBtnActive]}
            onPress={() => setTab(value)}
          >
            <Text style={[styles.tabText, tab === value && styles.tabTextActive]}>
              {value.toUpperCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'dm' ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dmBar}>
          <View style={styles.userRow}>
            {peers.length > 0 ? (
              peers.map((user) => (
                <TouchableOpacity
                  key={user.uid}
                  style={[styles.dmChip, dmTarget === user.uid && styles.dmChipActive]}
                  onPress={() => setDmTarget(user.uid)}
                >
                  <Text style={[styles.dmText, dmTarget === user.uid && styles.dmTextActive]}>
                    {user.name}
                  </Text>
                </TouchableOpacity>
              ))
            ) : (
              <Text style={styles.userText}>No peer users online yet.</Text>
            )}
          </View>
        </ScrollView>
      ) : null}

      {tab !== 'info' && tab !== 'logs' ? (
        <FlatList
          ref={listRef}
          data={filteredMessages}
          renderItem={renderMessage}
          keyExtractor={(item, index) => `${item.time}-${item.suid}-${index}`}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        />
      ) : tab === 'logs' ? (
        <View style={styles.logsWrap}>
          <Text style={styles.logsTitle}>PING LOGS ({Math.round(PING_INTERVAL_MS / 1000)}s interval)</Text>
          <ScrollView style={styles.logsScroll} contentContainerStyle={styles.logsContent}>
            {pingLogs.length > 0 ? (
              pingLogs.map((line, index) => (
                <Text key={`${line}-${index}`} style={styles.logLine}>
                  {line}
                </Text>
              ))
            ) : (
              <Text style={styles.logLine}>Waiting for ping data...</Text>
            )}
          </ScrollView>
        </View>
      ) : (
        <ScrollView style={styles.infoScroll} contentContainerStyle={styles.infoContent}>
          <InfoRow label="Mode" value={appMode === 'test' ? 'Testing without ESP32' : 'Live ESP32'} />
          <InfoRow label="Node" value={nodeInfo?.node || 'Unavailable'} />
          <InfoRow label="Frequency" value={nodeInfo?.freq || 'Unavailable'} />
          <InfoRow label="Profile" value={nodeInfo ? `SF${nodeInfo.sf} / BW ${nodeInfo.bw}` : 'Unavailable'} />
          <InfoRow label="Power" value={nodeInfo ? `${nodeInfo.pwr} dBm` : 'Unavailable'} />
          <InfoRow label="SSID" value={nodeInfo?.ssid || 'Unavailable'} />
          <InfoRow label="IP" value={nodeInfo?.ip || 'Unavailable'} />
          <InfoRow label="Uptime" value={nodeInfo?.uptime || 'Unavailable'} />
          <InfoRow label="WiFi" value={isWifiConnected ? 'Connected' : 'Disconnected'} />
          <InfoRow label="Socket" value={connectionState} />
          <InfoRow label="Session" value={sessionState} />
          <InfoRow label="Latitude" value={formatCoord(myLat)} />
          <InfoRow label="Longitude" value={formatCoord(myLng)} />
          <InfoRow label="Accuracy" value={myAccuracy > 0 ? `+/-${myAccuracy} m` : 'Waiting'} />
          <InfoRow label="GPS sharing" value={gpsActive ? 'Active' : 'Inactive'} />
          <InfoRow label="Tracked nodes" value={String(gpsPositions.filter((entry) => entry.hasGPS).length)} />
          <InfoRow label="Node users" value={stats ? String(stats.users) : 'Unavailable'} />
          <InfoRow label="Node messages" value={stats ? String(stats.msgs) : 'Unavailable'} />
          <InfoRow label="TX / RX" value={stats ? `${stats.tx} / ${stats.rx}` : 'Unavailable'} />
          <InfoRow label="Heap" value={stats ? `${stats.heap} bytes` : 'Unavailable'} />
          <InfoRow label="Latest ping" value={pingStatus} />

          <View style={styles.actionRow}>
            <ActionButton label="Refresh" onPress={refreshEverything} />
          </View>
          {isAdmin ? (
            <View style={styles.actionRow}>
              <ActionButton label="Clear Chat" onPress={handleClearChat} danger />
              <ActionButton label="Restart Node" onPress={handleRestart} danger />
            </View>
          ) : null}
          {isAdmin ? (
            <Text style={styles.hint}>Long-press a user chip above for mute and kick controls.</Text>
          ) : null}
        </ScrollView>
      )}

      {tab !== 'info' && tab !== 'logs' ? (
        <View style={[styles.inputBar, !canSend && styles.inputBarMuted]}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder={
              !canSend
                ? 'Reconnect to the LoRa WiFi network'
                : tab === 'broadcast'
                  ? 'Broadcast to every node'
                  : tab === 'dm'
                    ? dmTarget
                      ? `Direct message ${targetName}`
                      : 'Choose a direct-message user'
                    : 'Type a message'
            }
            placeholderTextColor={Colors.textSecondary}
            editable={canSend}
            maxLength={180}
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={handleSend}
          />
          <TouchableOpacity style={styles.sideBtn} onPress={handleShareLocation} disabled={!canSend}>
            <Text style={styles.sideBtnText}>GPS</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.sosBtn} onPress={handleSOS} disabled={!canSend}>
            <Text style={styles.sendText}>SOS</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.sendBtn, (!text.trim() || sending || !canSend) && styles.sendBtnOff]}
            onPress={handleSend}
            disabled={!text.trim() || sending || !canSend}
          >
            <Text style={styles.sendText}>SEND</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function ActionButton({
  danger,
  label,
  onPress,
}: {
  danger?: boolean;
  label: string;
  onPress: () => void | Promise<void>;
}) {
  return (
    <TouchableOpacity style={[styles.actionBtn, danger && styles.actionBtnDanger]} onPress={() => void onPress()}>
      <Text style={[styles.actionText, danger && styles.actionTextDanger]}>{label}</Text>
    </TouchableOpacity>
  );
}

const mono = Platform.OS === 'ios' ? 'Courier New' : 'monospace';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  modalWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.72)' },
  modalCard: { width: '100%', maxWidth: 360, padding: 28, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(91,163,255,0.24)', backgroundColor: 'rgba(12,16,24,0.96)' },
  modalTitle: { fontFamily: mono, fontSize: 18, fontWeight: '700', color: Colors.accent, letterSpacing: 1.4 },
  modalText: { marginTop: 10, marginBottom: 20, fontFamily: mono, fontSize: 11, lineHeight: 17, color: Colors.text },
  modalPrimary: { paddingVertical: 16, borderRadius: 14, alignItems: 'center', backgroundColor: Colors.accent },
  modalPrimaryText: { fontFamily: mono, fontSize: 12, fontWeight: '700', color: '#fff', letterSpacing: 1.2 },
  modalSecondary: { marginTop: 10, paddingVertical: 14, borderRadius: 14, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)', backgroundColor: 'rgba(239,68,68,0.08)' },
  modalSecondaryText: { fontFamily: mono, fontSize: 11, fontWeight: '700', color: Colors.red },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: Platform.OS === 'ios' ? 56 : 36, paddingBottom: 10, backgroundColor: 'rgba(12,16,24,0.92)', borderBottomWidth: 1, borderBottomColor: Colors.border },
  title: { fontFamily: mono, fontSize: 13, fontWeight: '700', color: Colors.accent, letterSpacing: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: Colors.border, backgroundColor: 'rgba(255,255,255,0.05)', fontFamily: mono, fontSize: 9, color: Colors.textSecondary },
  userBadge: { marginLeft: 'auto', color: Colors.green, borderColor: 'rgba(52,211,153,0.2)', backgroundColor: 'rgba(52,211,153,0.08)' },
  logout: { fontFamily: mono, fontSize: 8, color: Colors.red, fontWeight: '700' },
  userBar: { maxHeight: 44, backgroundColor: Colors.surface1, borderBottomWidth: 1, borderBottomColor: Colors.border },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 6 },
  userLabel: { fontFamily: mono, fontSize: 9, color: Colors.textSecondary },
  userChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface3 },
  userText: { fontFamily: mono, fontSize: 9, color: Colors.text },
  tabBar: { flexDirection: 'row', gap: 2, paddingHorizontal: 14, backgroundColor: Colors.surface1, borderBottomWidth: 1, borderBottomColor: Colors.border },
  tabBtn: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabBtnActive: { borderBottomColor: Colors.accent },
  tabText: { fontFamily: mono, fontSize: 10, color: Colors.textSecondary, fontWeight: '700' },
  tabTextActive: { color: Colors.accent },
  dmBar: { maxHeight: 40, backgroundColor: Colors.surface1, borderBottomWidth: 1, borderBottomColor: Colors.border },
  dmChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: Colors.border },
  dmChipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(91,163,255,0.08)' },
  dmText: { fontFamily: mono, fontSize: 9, color: Colors.textSecondary },
  dmTextActive: { color: Colors.accent },
  list: { flex: 1 },
  listContent: { padding: 14, gap: 6 },
  systemMsg: { alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: Colors.border, backgroundColor: 'rgba(100,116,139,0.04)' },
  systemText: { fontFamily: mono, fontSize: 9.5, color: Colors.textSecondary },
  msgRow: { maxWidth: '84%' },
  msgOwn: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  msgOther: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  meta: { marginBottom: 4, paddingHorizontal: 6, fontFamily: mono, fontSize: 9, color: Colors.textSecondary },
  metaOwn: { color: 'rgba(91,163,255,0.7)' },
  bubble: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16 },
  bubbleOwn: { backgroundColor: Colors.ownBubble, borderWidth: 1, borderColor: 'rgba(91,163,255,0.12)', borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: Colors.otherBubble, borderWidth: 1, borderColor: Colors.border, borderBottomLeftRadius: 4 },
  bubbleDM: { borderLeftWidth: 3, borderLeftColor: Colors.green },
  bubbleBroadcast: { borderLeftWidth: 3, borderLeftColor: Colors.warning, backgroundColor: 'rgba(50,38,12,0.5)' },
  bubbleSOS: { borderLeftWidth: 3, borderLeftColor: Colors.red, backgroundColor: 'rgba(60,15,15,0.5)' },
  bubbleText: { color: Colors.text, fontSize: 13.5, lineHeight: 20 },
  bubbleTextSOS: { fontWeight: '700' },
  gpsCard: {
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(91,163,255,0.22)',
    backgroundColor: 'rgba(14,22,34,0.9)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  gpsCardSOS: {
    borderColor: 'rgba(239,68,68,0.36)',
    backgroundColor: 'rgba(40,14,18,0.92)',
  },
  gpsLabel: { fontFamily: mono, fontSize: 11, color: Colors.warning },
  gpsCoords: { flex: 1, fontFamily: mono, fontSize: 11, color: '#9CE2FF', fontWeight: '700' },
  gpsAction: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(91,163,255,0.26)',
    backgroundColor: 'rgba(91,163,255,0.08)',
  },
  gpsActionText: { fontFamily: mono, fontSize: 9, color: Colors.accent, fontWeight: '700' },
  rssi: { marginTop: 2, paddingHorizontal: 6, fontFamily: mono, fontSize: 8, color: Colors.textSecondary },
  logsWrap: { flex: 1, paddingHorizontal: 14, paddingVertical: 12 },
  logsTitle: { fontFamily: mono, fontSize: 11, color: Colors.accent, fontWeight: '700', letterSpacing: 1.2 },
  logsScroll: { flex: 1, marginTop: 8, borderWidth: 1, borderColor: Colors.border, borderRadius: 14, backgroundColor: 'rgba(12,16,24,0.84)' },
  logsContent: { padding: 12, gap: 6 },
  logLine: { fontFamily: mono, fontSize: 10, color: Colors.textSecondary, lineHeight: 16 },
  infoScroll: { flex: 1 },
  infoContent: { padding: 18, gap: 8 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: 'rgba(30,45,66,0.28)' },
  infoLabel: { flex: 1, fontFamily: mono, fontSize: 10, color: Colors.textSecondary },
  infoValue: { flex: 1, textAlign: 'right', fontFamily: mono, fontSize: 10, color: Colors.text, fontWeight: '700' },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  actionBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(91,163,255,0.2)', backgroundColor: 'rgba(91,163,255,0.08)', alignItems: 'center' },
  actionBtnDanger: { borderColor: 'rgba(239,68,68,0.2)', backgroundColor: 'rgba(239,68,68,0.08)' },
  actionText: { fontFamily: mono, fontSize: 10, color: Colors.accent, fontWeight: '700' },
  actionTextDanger: { color: Colors.red },
  hint: { marginTop: 10, fontFamily: mono, fontSize: 9, lineHeight: 15, color: Colors.textSecondary },
  inputBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: Colors.border, backgroundColor: 'rgba(12,16,24,0.92)' },
  inputBarMuted: { opacity: 0.62 },
  input: { flex: 1, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1.5, borderColor: Colors.border, backgroundColor: Colors.bg, color: Colors.text, fontSize: 13 },
  sideBtn: { paddingHorizontal: 10, paddingVertical: 11, borderRadius: 12, backgroundColor: 'rgba(91,163,255,0.08)' },
  sideBtnText: { fontFamily: mono, fontSize: 10, color: Colors.accent, fontWeight: '700' },
  sosBtn: { paddingHorizontal: 12, paddingVertical: 11, borderRadius: 12, backgroundColor: Colors.red },
  sendBtn: { paddingHorizontal: 15, paddingVertical: 11, borderRadius: 12, backgroundColor: Colors.accent },
  sendBtnOff: { backgroundColor: Colors.border },
  sendText: { fontFamily: mono, fontSize: 10, color: '#fff', fontWeight: '700' },
});
