import React from 'react';
import { StyleSheet, View } from 'react-native';

export type TabName = 'queue' | 'server' | 'settings';

/**
 * Small geometric icons drawn with views.
 *
 * An icon font or SVG library would be a native dependency and a bundle, for
 * three glyphs. These scale with the tab bar and inherit the active colour.
 */
export function TabIcon({ name, color }: { name: TabName; color: string }) {
  if (name === 'queue') {
    return (
      <View style={styles.box}>
        <View style={[styles.bar, styles.barWide, { backgroundColor: color }]} />
        <View style={[styles.bar, styles.barMid, { backgroundColor: color }]} />
        <View style={[styles.bar, styles.barNarrow, { backgroundColor: color }]} />
      </View>
    );
  }
  if (name === 'server') {
    return (
      <View style={styles.box}>
        <View style={[styles.slab, { borderColor: color }]}>
          <View style={[styles.led, { backgroundColor: color }]} />
        </View>
        <View style={[styles.slab, { borderColor: color }]}>
          <View style={[styles.led, { backgroundColor: color }]} />
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.box, styles.gear]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <View style={[styles.dot, { backgroundColor: color }]} />
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', gap: 3 },
  bar: { height: 2.5, borderRadius: 2 },
  barWide: { width: 18 },
  barMid: { width: 13, opacity: 0.75 },
  barNarrow: { width: 8, opacity: 0.5 },
  slab: {
    width: 20,
    height: 8,
    borderWidth: 1.5,
    borderRadius: 2.5,
    justifyContent: 'center',
    paddingLeft: 2.5,
  },
  led: { width: 2.5, height: 2.5, borderRadius: 1.5 },
  gear: { flexDirection: 'row', gap: 3.5 },
  dot: { width: 4, height: 4, borderRadius: 2 },
});
