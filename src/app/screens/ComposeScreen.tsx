import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ValidationError } from '../../core/errors';
import { LIMITS } from '../../core/limits';
import { UploadQueue } from '../../core/queue';
import { formatBytes } from '../../core/selectors';
import type { DraftImage, ImageRecord } from '../../core/types';
import { draftStore } from '../../platform/draftStore';
import { logger } from '../../platform/logger';
import { useQueue } from '../QueueProvider';
import { Body, Button, Card, Row, SectionLabel } from '../components/ui';
import { radius, spacing, usePalette } from '../theme';
import { usePhotoPicker, type PickerOutcome } from '../usePhotoPicker';

export function ComposeScreen({ navigation }: { navigation: { goBack: () => void } }) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { queue, stageImage, makeThumbnail } = useQueue();
  const { takePhoto, pickFromLibrary, cameraBlocked, libraryBlocked, openSystemSettings } = usePhotoPicker();

  const [draftId, setDraftId] = useState(() => UploadQueue.newDraftId());
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [adding, setAdding] = useState<{ done: number; total: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore a draft abandoned by a crash or a force-quit. The photos are
  // already on disk; only the text and the ordering need recovering.
  useEffect(() => {
    let cancelled = false;
    void draftStore.load().then(saved => {
      if (cancelled || !saved) return;
      setDraftId(saved.id);
      setDescription(saved.description);
      setImages(saved.images);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(
    (next: { description?: string; images?: ImageRecord[] }) => {
      const payload = {
        id: draftId,
        description: next.description ?? description,
        images: next.images ?? images,
      };
      if (!payload.description && payload.images.length === 0) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void draftStore.save(payload), 400);
    },
    [draftId, description, images],
  );

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const remaining = LIMITS.maxImages - images.length;

  /**
   * Add photos one at a time, showing each as soon as its bytes are safe.
   *
   * Staging a 21 MB photo and building its thumbnail takes seconds on real
   * hardware. Doing the whole batch before touching state meant picking three
   * photos left the screen looking dead for the better part of ten seconds,
   * with nothing to say it was working -- which is the stuck-spinner failure
   * the brief calls the most common way this test is failed, just without the
   * spinner.
   *
   * So: adopt the file (a rename, near-instant), show it immediately with its
   * real size, and let the thumbnail arrive afterwards.
   */
  const addImages = useCallback(
    async (picked: DraftImage[]) => {
      if (picked.length === 0) return;
      setError(null);

      const accepted = picked.slice(0, LIMITS.maxImages - images.length);
      setAdding({ done: 0, total: accepted.length });

      let running = images;
      try {
        for (const [index, photo] of accepted.entries()) {
          const staged = await stageImage(draftId, photo);
          running = [...running, staged];
          setImages(running);
          persist({ images: running });
          setAdding({ done: index + 1, total: accepted.length });

          // Fills in behind the photo that is already on screen.
          void makeThumbnail(draftId, staged)
            .then(thumbUri => {
              if (!thumbUri) return;
              setImages(current => {
                const next = current.map(item => (item.id === staged.id ? { ...item, thumbUri } : item));
                persist({ images: next });
                return next;
              });
            })
            .catch(() => undefined);
        }

        if (picked.length > accepted.length) {
          setError(
            `Only ${LIMITS.maxImages} photos fit in one report, so ${picked.length - accepted.length} were left out.`,
          );
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'That photo could not be added.');
      } finally {
        setAdding(null);
      }
    },
    [draftId, images, makeThumbnail, persist, stageImage],
  );

  const handleOutcome = useCallback(
    async (run: () => Promise<PickerOutcome>) => {
      // Every path out of the picker ends somewhere visible. A rejected
      // promise here used to vanish: the sheet closed, no photo appeared, and
      // nothing said why. That is exactly the silent failure the brief warns
      // about, so the catch is not defensive padding -- it is the design.
      try {
        const outcome = await run();
        logger.info(`picker: ${outcome.kind}${outcome.kind === 'picked' ? ` (${outcome.images.length})` : ''}`);
        if (outcome.kind === 'picked') {
          if (outcome.images.length === 0) setError('No photos came back from the picker. Please try again.');
          else await addImages(outcome.images);
        } else if (outcome.kind === 'failed') {
          setError(outcome.message);
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.error(`picker threw: ${message}`);
        setError(`The photo picker failed: ${message}`);
      }
    },
    [addImages],
  );

  const removeImage = useCallback(
    (imageId: string) => {
      const next = images.filter(image => image.id !== imageId);
      setImages(next);
      persist({ images: next });
      setError(null);
    },
    [images, persist],
  );

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      // Returns as soon as the report is durable. No network involved: the
      // user is free to walk away the moment this resolves.
      await queue.enqueue({ id: draftId, description, images });
      await draftStore.clear();
      navigation.goBack();
    } catch (cause) {
      setError(cause instanceof ValidationError ? cause.message : 'This report could not be saved.');
      setSubmitting(false);
    }
  }, [description, draftId, images, navigation, queue]);

  const discard = useCallback(() => {
    Alert.alert('Discard this report?', 'The description and photos will be deleted from this device.', [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: async () => {
          await draftStore.clear();
          await queue.remove(draftId).catch(() => undefined);
          navigation.goBack();
        },
      },
    ]);
  }, [draftId, navigation, queue]);

  const canSubmit = description.trim().length > 0 && images.length >= LIMITS.minImages && !submitting && !adding;
  const addingLabel = adding ? `Adding photo ${Math.min(adding.done + 1, adding.total)} of ${adding.total}` : null;
  const blocked = cameraBlocked || libraryBlocked;

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: palette.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        keyboardShouldPersistTaps="handled">
        <SectionLabel>What did you find?</SectionLabel>
        <Card style={styles.inputCard}>
          <TextInput
            value={description}
            onChangeText={text => {
              setDescription(text);
              persist({ description: text });
            }}
            placeholder="Cracked handrail on the level 3 landing, loose at both brackets."
            placeholderTextColor={palette.textFaint}
            multiline
            maxLength={LIMITS.maxDescriptionChars}
            style={[styles.input, { color: palette.text }]}
            accessibilityLabel="Report description"
          />
          <Text style={[styles.counter, { color: palette.textFaint }]}>
            {description.trim().length === 0
              ? 'Required'
              : `${description.length} / ${LIMITS.maxDescriptionChars}`}
          </Text>
        </Card>

        <View style={styles.photosHeader}>
          <SectionLabel>
            Photos · {images.length} of {LIMITS.maxImages}
            {addingLabel ? ` · ${addingLabel}` : ''}
          </SectionLabel>
        </View>

        {images.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
            {images.map(image => (
              <View key={image.id} style={styles.thumbWrap}>
                {image.thumbUri ? (
                  <Image source={{ uri: image.thumbUri }} style={[styles.thumb, { borderColor: palette.line }]} />
                ) : (
                  <View
                    style={[styles.thumb, styles.thumbPending, { borderColor: palette.line, backgroundColor: palette.surfaceAlt }]}>
                    <Text style={[styles.thumbPendingText, { color: palette.textFaint }]}>saved</Text>
                  </View>
                )}
                <Text style={[styles.thumbMeta, { color: palette.textFaint }]}>{formatBytes(image.source.bytes)}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Remove this photo"
                  hitSlop={10}
                  onPress={() => removeImage(image.id)}
                  style={[styles.remove, { backgroundColor: palette.bad }]}>
                  <Text style={styles.removeGlyph}>×</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : (
          <Card style={styles.placeholder}>
            <Body style={styles.centered}>
              At least one photo is required. Large originals are fine — they are compressed before sending, and the
              compression happens in the background.
            </Body>
          </Card>
        )}

        <Row style={styles.actions}>
          <Button
            label="Take photo"
            variant="secondary"
            style={styles.action}
            disabled={remaining === 0 || adding !== null}
            busy={adding !== null}
            onPress={() => void handleOutcome(takePhoto)}
          />
          <Button
            label="Choose photos"
            variant="secondary"
            style={styles.action}
            disabled={remaining === 0 || adding !== null}
            onPress={() => void handleOutcome(() => pickFromLibrary(remaining))}
          />
        </Row>

        {blocked ? (
          <Card style={[styles.notice, { borderColor: palette.warn, backgroundColor: palette.warnBg }]}>
            <Text style={[styles.noticeTitle, { color: palette.warn }]}>
              {cameraBlocked ? 'Camera access is off' : 'Photo access is off'}
            </Text>
            <Body style={{ color: palette.warn }}>
              Turn it on in system settings. You do not need to restart the app — come back and tap the button again.
            </Body>
            <Button label="Open settings" variant="secondary" style={styles.noticeButton} onPress={openSystemSettings} />
          </Card>
        ) : null}

        {error ? (
          <Card style={[styles.notice, { borderColor: palette.bad, backgroundColor: palette.badBg }]}>
            <Body style={{ color: palette.bad }}>{error}</Body>
          </Card>
        ) : null}

        <Card style={styles.submitCard}>
          <Body style={styles.submitNote}>
            Submitting saves this report on the device straight away. Sending happens on its own afterwards — you do not
            need a signal, and you do not need to keep this screen open.
          </Body>
          <Button
            label={submitting ? 'Saving…' : 'Submit report'}
            variant="primary"
            disabled={!canSubmit}
            busy={submitting}
            onPress={() => void submit()}
          />
          <Button label="Discard" variant="ghost" style={styles.discard} onPress={discard} />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  inputCard: { paddingVertical: spacing.md },
  input: { fontSize: 16, lineHeight: 23, minHeight: 104, textAlignVertical: 'top' },
  counter: { fontSize: 12, textAlign: 'right', marginTop: spacing.sm },
  photosHeader: { marginTop: spacing.sm },
  strip: { gap: spacing.md, paddingVertical: spacing.xs, paddingRight: spacing.lg },
  thumbWrap: { alignItems: 'center' },
  thumb: { width: 92, height: 92, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  thumbMeta: { fontSize: 11, marginTop: spacing.xs },
  remove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeGlyph: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginTop: -2 },
  placeholder: { paddingVertical: spacing.xl },
  centered: { textAlign: 'center' },
  thumbPending: { alignItems: 'center', justifyContent: 'center' },
  thumbPendingText: { fontSize: 11, fontWeight: '600' },
  actions: { gap: spacing.md },
  action: { flex: 1 },
  notice: { gap: spacing.sm },
  noticeTitle: { fontSize: 15, fontWeight: '700' },
  noticeButton: { marginTop: spacing.sm, alignSelf: 'flex-start', paddingHorizontal: spacing.xl },
  submitCard: { marginTop: spacing.sm, gap: spacing.md },
  submitNote: { fontSize: 13.5 },
  discard: { minHeight: 40 },
});
