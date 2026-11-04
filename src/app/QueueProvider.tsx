import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { FileSystem } from 'react-native-file-access';
import type { QueuePorts } from '../core/ports';
import { UploadQueue } from '../core/queue';
import type { DraftImage, ImageRecord, QueueSnapshot } from '../core/types';
import { HttpTransport } from '../platform/httpTransport';
import { DeviceImaging } from '../platform/imageProcessor';
import { ensureDir, paths, toFileUri, toPath } from '../platform/files';
import { logger } from '../platform/logger';
import { NetInfoMonitor } from '../platform/netMonitor';
import { AsyncStorageReportStore } from '../platform/reportStore';
import { settings, type Settings } from '../platform/settings';
import { systemClock } from '../platform/systemClock';

interface QueueContextValue {
  queue: UploadQueue;
  transport: HttpTransport;
  snapshot: QueueSnapshot;
  settings: Settings;
  ready: boolean;
  /** Copy a freshly picked photo somewhere the OS will not reclaim it. */
  stageImage: (draftId: string, picked: DraftImage) => Promise<ImageRecord>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
}

const QueueContext = createContext<QueueContextValue | null>(null);

export function QueueProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [current, setCurrent] = useState<Settings>(settings.current);

  // Built once. The transport reads the base URL through a getter, so changing
  // it in Settings takes effect on the next request without rebuilding
  // anything or restarting the queue.
  const { queue, transport, network, imaging } = useMemo(() => {
    const httpTransport = new HttpTransport(() => settings.current.baseUrl);
    const monitor = new NetInfoMonitor();
    const deviceImaging = new DeviceImaging();
    const ports: QueuePorts = {
      store: new AsyncStorageReportStore(),
      imaging: deviceImaging,
      transport: httpTransport,
      network: monitor,
      clock: systemClock,
      logger,
    };
    return { queue: new UploadQueue(ports), transport: httpTransport, network: monitor, imaging: deviceImaging };
  }, []);

  const [snapshot, setSnapshot] = useState<QueueSnapshot>(() => queue.getSnapshot());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const unsubscribeQueue = queue.subscribe(next => {
      if (mounted.current) setSnapshot(next);
    });
    const unsubscribeSettings = settings.subscribe(setCurrent);

    (async () => {
      await settings.load();
      await ensureDir(paths.root);
      network.start();
      await queue.start();
      if (mounted.current) setReady(true);
    })().catch(error => {
      logger.error('failed to start the queue', error);
      if (mounted.current) setReady(true);
    });

    // Returning to the foreground is the clearest signal that the user wants
    // their work to move; Android may have frozen the JS thread mid-wait.
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') queue.poke();
    });

    return () => {
      mounted.current = false;
      appState.remove();
      unsubscribeQueue();
      unsubscribeSettings();
      network.stop();
      void queue.stop();
    };
  }, [queue, network]);

  const value = useMemo<QueueContextValue>(
    () => ({
      queue,
      transport,
      snapshot,
      settings: current,
      ready,
      updateSettings: async patch => {
        await settings.update(patch);
        queue.poke();
      },
      stageImage: async (draftId, picked) => {
        const imageId = UploadQueue.newImageId();
        await ensureDir(paths.reportDir(draftId));
        const target = paths.source(draftId, imageId);
        await adoptFile(picked.uri, target);

        const stat = await FileSystem.stat(target);
        const source = { uri: toFileUri(target), bytes: stat.size, width: picked.width, height: picked.height };
        const record = UploadQueue.rawImage(source, imageId);

        // Make the small copy now, so neither the composer nor the list ever
        // decodes an 18 MB bitmap to draw a 56 px square. The queue will make
        // one too if this fails -- it is an optimisation, not a dependency.
        record.thumbUri = (await imaging.thumbnail(draftId, imageId, source)) ?? undefined;
        return record;
      },
    }),
    [queue, transport, imaging, snapshot, current, ready],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useQueue(): QueueContextValue {
  const value = useContext(QueueContext);
  if (!value) throw new Error('useQueue must be used inside a QueueProvider');
  return value;
}

/**
 * Take ownership of a picked photo.
 *
 * The picker leaves files in the cache directory, which the OS may reclaim at
 * any time, and gallery URIs can stop being readable once the picker session
 * ends. Either would mean a report that looks queued but has no bytes behind
 * it, so this runs before the photo is ever shown in the composer.
 *
 * A move is preferred: cache and documents are on the same filesystem, so it
 * is a rename rather than a second 18 MB on disk. Content URIs cannot be
 * renamed, so those fall back to a copy.
 */
async function adoptFile(sourceUri: string, target: string): Promise<void> {
  const source = toPath(sourceUri);
  try {
    await FileSystem.mv(source, target);
    return;
  } catch {
    await FileSystem.cp(source, target);
  }
}
