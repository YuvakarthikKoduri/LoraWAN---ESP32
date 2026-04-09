import React from 'react';
import { Tabs } from 'expo-router';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Colors, SessionState } from '../constants/config';
import { useApp } from '../services/AppStateContext';

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <View style={styles.iconWrap}>
      <Text style={[styles.iconText, focused && styles.iconTextFocused]}>{label}</Text>
    </View>
  );
}

export default function TabLayoutScreen() {
  const { isWifiConnected, session, sessionState } = useApp();

  const isPaused = sessionState === SessionState.PAUSED;

  return (
    <View style={styles.container}>
      {session && !isWifiConnected && !isPaused ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>WiFi disconnected. Reconnect to the LoRa access point.</Text>
        </View>
      ) : null}

      {isPaused ? (
        <View style={styles.pausedBanner}>
          <Text style={styles.pausedTitle}>SESSION PAUSED</Text>
          <Text style={styles.pausedText}>
            WiFi dropped, so chat sync and GPS uploads are temporarily paused.
          </Text>
        </View>
      ) : null}

      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarHideOnKeyboard: true,
          tabBarStyle: {
            backgroundColor: 'rgba(12,16,24,0.95)',
            borderTopColor: Colors.border,
            borderTopWidth: 1,
            height: Platform.OS === 'ios' ? 84 : 62,
            paddingTop: 8,
            paddingBottom: Platform.OS === 'ios' ? 24 : 8,
          },
          tabBarActiveTintColor: Colors.accent,
          tabBarInactiveTintColor: Colors.textSecondary,
          tabBarLabelStyle: {
            fontFamily: mono,
            fontSize: 10,
            fontWeight: '600',
            letterSpacing: 1,
          },
        }}
      >
        <Tabs.Screen
          name="chat"
          options={{
            title: 'CHAT',
            tabBarIcon: ({ focused }) => <TabIcon label="CH" focused={focused} />,
          }}
        />
        <Tabs.Screen
          name="map"
          options={{
            title: 'MAP',
            href: Platform.OS === 'web' ? null : undefined,
            tabBarIcon: ({ focused }) => <TabIcon label="MP" focused={focused} />,
          }}
        />
      </Tabs>
    </View>
  );
}

const mono = Platform.OS === 'ios' ? 'Courier New' : 'monospace';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: {
    fontFamily: mono,
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '700',
  },
  iconTextFocused: {
    color: Colors.accent,
  },
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: 'rgba(239,68,68,0.14)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(239,68,68,0.28)',
  },
  bannerText: {
    fontFamily: mono,
    fontSize: 10,
    color: Colors.text,
    textAlign: 'center',
  },
  pausedBanner: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    backgroundColor: 'rgba(251,191,36,0.08)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(251,191,36,0.22)',
  },
  pausedTitle: {
    fontFamily: mono,
    fontSize: 12,
    color: Colors.warning,
    fontWeight: '700',
    letterSpacing: 1.4,
  },
  pausedText: {
    marginTop: 4,
    fontFamily: mono,
    fontSize: 10,
    color: Colors.textSecondary,
    lineHeight: 15,
  },
});
