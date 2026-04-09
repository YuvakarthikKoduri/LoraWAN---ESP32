import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Colors } from '../constants/config';
import { useApp } from '../services/AppStateContext';
import { AppMode } from '../services/appMode';
import { gpsTracker } from '../services/gpsTracker';
import { getActiveHost, setActiveHost } from '../services/nodeEndpoint';

const LIVE_NODE_PRESETS = ['192.168.4.1', '192.168.0.1', '192.168.1.1'];

export default function LoginScreen() {
  const [name, setName] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [gpsStatus, setGpsStatus] = useState<'waiting' | 'active' | 'denied'>('waiting');
  const [liveHost, setLiveHost] = useState(getActiveHost());

  const router = useRouter();
  const orbAnim = useRef(new Animated.Value(0)).current;
  const { appMode, login, session, setAppMode } = useApp();

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(orbAnim, { toValue: 1, duration: 4000, useNativeDriver: true }),
        Animated.timing(orbAnim, { toValue: 0, duration: 4000, useNativeDriver: true }),
      ])
    ).start();
  }, [orbAnim]);

  useEffect(() => {
    const requestGPS = async () => {
      const granted = await gpsTracker.requestPermission();
      setGpsStatus(granted ? 'active' : 'denied');
    };

    void requestGPS();
  }, []);

  useEffect(() => {
    if (session) {
      router.replace('/(tabs)/chat');
    }
  }, [router, session]);

  const handleJoin = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Enter a name');
      return;
    }

    if (trimmedName.length > 20) {
      setError('Name too long (max 20 characters)');
      return;
    }

    setError('');
    setLoading(true);

    try {
      if (appMode === 'live') {
        setActiveHost(liveHost.trim());
      }
      await setAppMode(appMode);
      const success = await login(trimmedName, adminKey.trim());
      if (success) {
        router.replace('/(tabs)/chat');
      }
    } catch {
      setError('Connection failed. Make sure you are on the LoRa WiFi network.');
    } finally {
      setLoading(false);
    }
  };

  const orbTranslate = orbAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-20, 20],
  });

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Animated.View
        style={[styles.orb, styles.orbOne, { transform: [{ translateY: orbTranslate }] }]}
      />
      <Animated.View
        style={[
          styles.orb,
          styles.orbTwo,
          { transform: [{ translateY: Animated.multiply(orbTranslate, -1) }] },
        ]}
      />

      <View style={styles.card}>
        <Text style={styles.logo}>LoRa</Text>
        <Text style={styles.title}>LORA CHAT</Text>

        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>v5.1</Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>MOBILE</Text>
          </View>
        </View>

        <Text style={styles.subtitle}>Encrypted field chat with live GPS and offline map</Text>

        <Text style={styles.label}>APP MODE</Text>
        <View style={styles.modeRow}>
          {(['live', 'test'] as AppMode[]).map((mode) => (
            <TouchableOpacity
              key={mode}
              style={[styles.modeChip, appMode === mode && styles.modeChipActive]}
              onPress={() => void setAppMode(mode)}
            >
              <Text style={[styles.modeChipText, appMode === mode && styles.modeChipTextActive]}>
                {mode === 'test' ? 'TEST APK' : 'LIVE ESP32'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.modeHint}>
          {appMode === 'test'
            ? 'Offline simulation only. TEST mode does not sync with real ESP32 web chat.'
            : 'Connect to the ESP32 hotspot for live chat, LoRa sync, and node tracking.'}
        </Text>
        {appMode === 'live' ? (
          <View style={styles.hostWrap}>
            <Text style={styles.label}>NODE HOST</Text>
            <View style={styles.hostRow}>
              {LIVE_NODE_PRESETS.map((host) => (
                <TouchableOpacity
                  key={host}
                  style={[styles.hostChip, liveHost === host && styles.hostChipActive]}
                  onPress={() => setLiveHost(host)}
                >
                  <Text style={[styles.hostChipText, liveHost === host && styles.hostChipTextActive]}>
                    {host}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              style={styles.hostInput}
              placeholder="Custom host (example: 192.168.2.1)"
              placeholderTextColor={Colors.textSecondary}
              value={liveHost}
              onChangeText={setLiveHost}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numeric"
            />
            <Text style={styles.hostHint}>
              If connection fails, switch host and retry.
            </Text>
          </View>
        ) : null}

        <TextInput
          style={styles.input}
          placeholder="Enter your name"
          placeholderTextColor={Colors.textSecondary}
          value={name}
          onChangeText={setName}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={20}
          returnKeyType="next"
        />

        <Text style={styles.label}>ADMIN KEY (OPTIONAL)</Text>
        <TextInput
          style={styles.input}
          placeholder="Admin key"
          placeholderTextColor={Colors.textSecondary}
          value={adminKey}
          onChangeText={setAdminKey}
          secureTextEntry
          autoCapitalize="none"
          maxLength={32}
          returnKeyType="go"
          onSubmitEditing={handleJoin}
        />

        <TouchableOpacity
          style={[styles.joinButton, loading && styles.joinButtonDisabled]}
          onPress={handleJoin}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <Text style={styles.joinButtonText}>INITIALIZE UPLINK</Text>
          )}
        </TouchableOpacity>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={[styles.gpsStatus, gpsStatus === 'active' && styles.gpsStatusActive]}>
          <View
            style={[
              styles.gpsDot,
              gpsStatus === 'active' && styles.gpsDotActive,
              gpsStatus === 'denied' && styles.gpsDotDenied,
            ]}
          />
          <Text style={styles.gpsText}>
            {gpsStatus === 'waiting' && 'Waiting for GPS permission'}
            {gpsStatus === 'active' && 'GPS permission granted'}
            {gpsStatus === 'denied' && 'GPS permission denied'}
          </Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const mono = Platform.OS === 'ios' ? 'Courier New' : 'monospace';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  orb: {
    position: 'absolute',
    borderRadius: 999,
    opacity: 0.16,
  },
  orbOne: {
    width: 320,
    height: 320,
    top: -120,
    right: -90,
    backgroundColor: Colors.accent,
  },
  orbTwo: {
    width: 420,
    height: 420,
    left: -180,
    bottom: -180,
    backgroundColor: Colors.green,
  },
  card: {
    width: '88%',
    maxWidth: 380,
    padding: 36,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(12,16,24,0.88)',
  },
  logo: {
    fontFamily: mono,
    fontSize: 34,
    fontWeight: '700',
    color: Colors.accent,
    textAlign: 'center',
    letterSpacing: 2,
  },
  title: {
    marginTop: 8,
    marginBottom: 12,
    fontFamily: mono,
    fontSize: 24,
    fontWeight: '700',
    color: '#ffffff',
    textAlign: 'center',
    letterSpacing: 4,
  },
  badgeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 14,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  badgeText: {
    fontFamily: mono,
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: '600',
    letterSpacing: 1,
  },
  subtitle: {
    marginBottom: 28,
    textAlign: 'center',
    color: 'rgba(100,116,139,0.9)',
    fontSize: 12,
    letterSpacing: 0.6,
    lineHeight: 18,
  },
  label: {
    marginBottom: 6,
    paddingLeft: 4,
    fontFamily: mono,
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: '600',
    letterSpacing: 1,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  modeChip: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(0,0,0,0.24)',
    alignItems: 'center',
  },
  modeChipActive: {
    borderColor: 'rgba(91,163,255,0.24)',
    backgroundColor: 'rgba(91,163,255,0.10)',
  },
  modeChipText: {
    fontFamily: mono,
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: '700',
  },
  modeChipTextActive: {
    color: Colors.accent,
  },
  modeHint: {
    marginBottom: 16,
    fontFamily: mono,
    fontSize: 10,
    lineHeight: 16,
    color: Colors.textSecondary,
  },
  hostWrap: {
    marginBottom: 12,
  },
  hostRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  hostChip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(0,0,0,0.24)',
  },
  hostChipActive: {
    borderColor: 'rgba(91,163,255,0.24)',
    backgroundColor: 'rgba(91,163,255,0.10)',
  },
  hostChipText: {
    fontFamily: mono,
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: '700',
  },
  hostChipTextActive: {
    color: Colors.accent,
  },
  hostInput: {
    width: '100%',
    marginBottom: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(0,0,0,0.3)',
    color: Colors.text,
    fontSize: 13,
    fontFamily: mono,
  },
  hostHint: {
    fontFamily: mono,
    fontSize: 9,
    color: Colors.textSecondary,
  },
  input: {
    width: '100%',
    marginBottom: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(0,0,0,0.3)',
    color: Colors.text,
    fontSize: 15,
  },
  joinButton: {
    marginTop: 4,
    borderRadius: 14,
    backgroundColor: Colors.accent,
    paddingVertical: 18,
    alignItems: 'center',
  },
  joinButtonDisabled: {
    opacity: 0.65,
  },
  joinButtonText: {
    fontFamily: mono,
    fontSize: 14,
    color: '#ffffff',
    fontWeight: '700',
    letterSpacing: 2,
  },
  error: {
    marginTop: 12,
    color: Colors.red,
    fontSize: 12,
    fontWeight: '500',
  },
  gpsStatus: {
    marginTop: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    backgroundColor: 'rgba(0,0,0,0.2)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  gpsStatusActive: {
    borderColor: 'rgba(52,211,153,0.18)',
  },
  gpsDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: Colors.warning,
  },
  gpsDotActive: {
    backgroundColor: Colors.green,
  },
  gpsDotDenied: {
    backgroundColor: Colors.red,
  },
  gpsText: {
    fontFamily: mono,
    fontSize: 11,
    color: Colors.textSecondary,
  },
});
