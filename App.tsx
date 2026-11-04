import React from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueueProvider } from './src/app/QueueProvider';
import { Navigation } from './src/app/navigation';

export default function App() {
  const scheme = useColorScheme();
  return (
    <SafeAreaProvider>
      {/* Android is edge-to-edge by default in RN 0.88, so the bar's own
          background is no longer ours to set -- screens handle their insets. */}
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />
      <QueueProvider>
        <Navigation />
      </QueueProvider>
    </SafeAreaProvider>
  );
}
