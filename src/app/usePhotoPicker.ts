import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, PermissionsAndroid, Platform } from 'react-native';
import { launchCamera, launchImageLibrary, type Asset } from 'react-native-image-picker';
import type { DraftImage } from '../core/types';

export type PickerOutcome =
  | { kind: 'picked'; images: DraftImage[] }
  | { kind: 'cancelled' }
  | { kind: 'blocked'; source: 'camera' | 'library' }
  | { kind: 'failed'; message: string };

const toDraftImages = (assets: Asset[] | undefined): DraftImage[] =>
  (assets ?? [])
    .filter(asset => Boolean(asset.uri))
    .map(asset => ({
      uri: asset.uri as string,
      bytes: asset.fileSize ?? 0,
      width: asset.width ?? 0,
      height: asset.height ?? 0,
    }));

/**
 * Camera and gallery access, including the case the brief tests directly:
 * refuse permission, grant it later in system Settings, and carry on without
 * restarting the app.
 *
 * Two things make that work. Permission is requested at the moment of use
 * rather than at mount, so there is no stale decision cached in a ref. And
 * when the app returns to the foreground we re-check, so the "camera access
 * is off" message disappears by itself the moment it stops being true,
 * instead of lying until the next tap.
 */
export function usePhotoPicker() {
  const [cameraBlocked, setCameraBlocked] = useState(false);
  const [libraryBlocked, setLibraryBlocked] = useState(false);

  useEffect(() => {
    if (!cameraBlocked && !libraryBlocked) return;
    const subscription = AppState.addEventListener('change', async state => {
      if (state !== 'active') return;
      if (cameraBlocked && Platform.OS === 'android') {
        const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
        if (granted) setCameraBlocked(false);
      }
      // The library has no single permission to probe across versions, so we
      // simply clear the warning and let the next attempt be the test.
      if (libraryBlocked) setLibraryBlocked(false);
    });
    return () => subscription.remove();
  }, [cameraBlocked, libraryBlocked]);

  const takePhoto = useCallback(async (): Promise<PickerOutcome> => {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
        title: 'Camera access',
        message: 'Field Reports needs the camera to attach photos to a report.',
        buttonPositive: 'Allow',
        buttonNegative: 'Not now',
      });
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        setCameraBlocked(granted === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
        return { kind: 'blocked', source: 'camera' };
      }
      setCameraBlocked(false);
    }

    const result = await launchCamera({ mediaType: 'photo', quality: 1, saveToPhotos: false });
    if (result.didCancel) return { kind: 'cancelled' };
    if (result.errorCode === 'camera_unavailable') {
      return { kind: 'failed', message: 'No camera is available on this device.' };
    }
    if (result.errorCode === 'permission') {
      setCameraBlocked(true);
      return { kind: 'blocked', source: 'camera' };
    }
    if (result.errorCode) return { kind: 'failed', message: result.errorMessage ?? 'The camera could not be opened.' };
    return { kind: 'picked', images: toDraftImages(result.assets) };
  }, []);

  const pickFromLibrary = useCallback(async (limit: number): Promise<PickerOutcome> => {
    const result = await launchImageLibrary({ mediaType: 'photo', selectionLimit: limit, quality: 1 });
    if (result.didCancel) return { kind: 'cancelled' };
    if (result.errorCode === 'permission') {
      setLibraryBlocked(true);
      return { kind: 'blocked', source: 'library' };
    }
    if (result.errorCode) return { kind: 'failed', message: result.errorMessage ?? 'The gallery could not be opened.' };
    return { kind: 'picked', images: toDraftImages(result.assets) };
  }, []);

  const openSystemSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  return { takePhoto, pickFromLibrary, cameraBlocked, libraryBlocked, openSystemSettings };
}
