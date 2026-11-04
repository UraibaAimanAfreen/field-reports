import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import { StyleSheet, Text, View, useColorScheme } from 'react-native';
import { summarise } from '../core/selectors';
import { useQueue } from './QueueProvider';
import { TabIcon, type TabName } from './components/TabIcon';
import { ComposeScreen } from './screens/ComposeScreen';
import { ReportDetailScreen } from './screens/ReportDetailScreen';
import { ReportsScreen } from './screens/ReportsScreen';
import { ServerScreen } from './screens/ServerScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { usePalette } from './theme';

export type RootStackParamList = {
  Tabs: undefined;
  Compose: undefined;
  ReportDetail: { reportId: string };
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

const icon = (name: TabName) =>
  function TabBarIcon({ color }: { color: string }) {
    return <TabIcon name={name} color={color} />;
  };

function Tabs() {
  const palette = usePalette();
  const { snapshot } = useQueue();
  const summary = summarise(snapshot.reports, snapshot.online);

  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: palette.bg },
        headerShadowVisible: false,
        headerTitleStyle: { color: palette.text, fontSize: 17, fontWeight: '700' },
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.textFaint,
        tabBarStyle: { backgroundColor: palette.surface, borderTopColor: palette.line },
        tabBarLabelStyle: { fontSize: 11.5, fontWeight: '600' },
      }}>
      <Tab.Screen
        name="Queue"
        component={ReportsScreen}
        options={{
          title: 'Reports',
          tabBarIcon: icon('queue'),
          // The count the user actually cares about: work not yet on the server.
          tabBarBadge: summary.outstanding > 0 ? summary.outstanding : undefined,
          tabBarBadgeStyle: { backgroundColor: palette.accent, color: palette.accentText, fontSize: 11 },
        }}
      />
      <Tab.Screen name="Server" component={ServerScreen} options={{ title: 'On the server', tabBarIcon: icon('server') }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: icon('settings') }} />
    </Tab.Navigator>
  );
}

function StartupGate({ children }: { children: React.ReactNode }) {
  const palette = usePalette();
  const { ready } = useQueue();
  if (ready) return <>{children}</>;
  return (
    <View style={[styles.gate, { backgroundColor: palette.bg }]}>
      <Text style={[styles.gateText, { color: palette.textFaint }]}>Checking for unsent reports…</Text>
    </View>
  );
}

export function Navigation() {
  const scheme = useColorScheme();
  const palette = usePalette();
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;

  return (
    <NavigationContainer
      theme={{
        ...base,
        colors: {
          ...base.colors,
          background: palette.bg,
          card: palette.surface,
          text: palette.text,
          border: palette.line,
          primary: palette.accent,
        },
      }}>
      <StartupGate>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: palette.bg },
            headerShadowVisible: false,
            headerTintColor: palette.accent,
            headerTitleStyle: { color: palette.text, fontSize: 17, fontWeight: '700' },
            contentStyle: { backgroundColor: palette.bg },
          }}>
          <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
          <Stack.Screen
            name="Compose"
            component={ComposeScreen}
            options={{ title: 'New report', presentation: 'modal' }}
          />
          <Stack.Screen name="ReportDetail" component={ReportDetailScreen} options={{ title: 'Report' }} />
        </Stack.Navigator>
      </StartupGate>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  gateText: { fontSize: 14.5 },
});
