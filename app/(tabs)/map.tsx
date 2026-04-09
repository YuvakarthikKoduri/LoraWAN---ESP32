import React from 'react';
import { Redirect } from 'expo-router';
import { Platform } from 'react-native';
import MapScreen from '../../screens/MapScreen';

export default function MapRoute() {
  if (Platform.OS === 'web') {
    return <Redirect href="/chat" />;
  }

  return <MapScreen />;
}
