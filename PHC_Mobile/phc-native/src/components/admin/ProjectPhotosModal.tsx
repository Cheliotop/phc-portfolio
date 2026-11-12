import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { photosApi } from '../../api/supabase-photos';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { formatDisplayDateTime } from '../../utils/dateFormat';
import { errorMessage } from '../../utils/errorMessage';

/**
 * The photos an operator took on a well.
 *
 * Until this existed nothing on the admin side displayed a photo at all: an
 * operator could document a shift, the upload would succeed, the row would be
 * written — and the office had no way to look at the result. From the outside
 * that is indistinguishable from the photo never arriving, which is the worst
 * possible failure for the one feature whose entire purpose is evidence.
 *
 * Signed URLs last an hour, so they are fetched when the gallery opens rather
 * than stored. Everything is signed in a single request: one round trip per
 * photo is the difference, on mobile data at a well, between a gallery that
 * opens and one that looks broken.
 */

interface ProjectPhoto {
  id: number;
  storage_path: string;
  caption?: string | null;
  created_at?: string | null;
  evidence_kind?: string | null;
  shift_id?: string | null;
  uploaded_by?: string | null;
  profiles?: { username?: string | null; full_name?: string | null } | null;
}

interface Props {
  visible: boolean;
  projectId: number | null;
  projectName?: string | null;
  onClose: () => void;
}

const KIND_LABELS: Record<string, string> = {
  field: 'Avance',
  water_sample: 'Muestra de agua',
};

// A gallery of full-size JPEGs: load them in pages, not all at once.
export const PHOTO_PAGE_SIZE = 30;

const photographer = (photo: ProjectPhoto): string =>
  photo.profiles?.full_name || photo.profiles?.username || 'Operador';

const ProjectPhotosModal = ({ visible, projectId, projectName, onClose }: Props) => {
  const [photos, setPhotos] = useState<ProjectPhoto[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ProjectPhoto | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Every request gets a number. A reply is applied only if it is still the
  // latest request, so a slow answer for a previous well (or a closed gallery)
  // can never land under the well that is open now.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!projectId) return;
    const isCurrent = () => requestId === requestRef.current;
    setLoading(true);
    setError(null);
    setLoadingMore(false);
    // Nothing from the previous well stays on screen while this one loads.
    setPhotos([]);
    setUrls({});
    setHasMore(false);
    try {
      const rows = (await photosApi.listProjectPhotos(projectId, {
        offset: 0,
        limit: PHOTO_PAGE_SIZE,
      })) as unknown as ProjectPhoto[];
      // A row whose file failed to sign still lists, with a placeholder tile —
      // "the photo is missing" is information the office needs, and silently
      // dropping the row would hide it.
      const signed = await photosApi.getSignedUrls(rows.map((row) => row.storage_path));
      if (!isCurrent()) return;
      setPhotos(rows);
      setUrls(signed);
      setHasMore(rows.length === PHOTO_PAGE_SIZE);
    } catch (loadError) {
      if (!isCurrent()) return;
      setError(errorMessage(loadError) || 'No se pudieron cargar las fotos.');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [projectId]);

  const loadMore = async () => {
    if (!projectId || loadingMore || !hasMore) return;
    const requestId = requestRef.current;
    const offset = photos.length;
    setLoadingMore(true);
    try {
      const rows = (await photosApi.listProjectPhotos(projectId, {
        offset,
        limit: PHOTO_PAGE_SIZE,
      })) as unknown as ProjectPhoto[];
      const signed = await photosApi.getSignedUrls(rows.map((row) => row.storage_path));
      if (requestId !== requestRef.current) return;
      setPhotos((current) => [...current, ...rows]);
      setUrls((current) => ({ ...current, ...signed }));
      setHasMore(rows.length === PHOTO_PAGE_SIZE);
    } catch (moreError) {
      if (requestId !== requestRef.current) return;
      setError(errorMessage(moreError) || 'No se pudieron cargar más fotos.');
    } finally {
      if (requestId === requestRef.current) setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (visible) {
      void load();
    } else {
      // Drop the signed URLs on close: they expire, and holding them would show
      // a grid of broken tiles the next time the gallery opens. Replies still in
      // flight are ignored from now on.
      requestRef.current += 1;
      setPhotos([]);
      setUrls({});
      setExpanded(null);
      setError(null);
      setHasMore(false);
      setLoadingMore(false);
    }
  }, [visible, load]);

  const tileSize = (Dimensions.get('window').width - SPACING.lg * 3) / 2;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>Fotos del pozo</Text>
              {!!projectName && <Text style={styles.subtitle}>{projectName}</Text>}
            </View>
            <TouchableOpacity style={styles.closeButton} onPress={onClose} accessibilityLabel="Cerrar">
              <Text style={styles.closeLabel}>Cerrar</Text>
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.centered}>
              <ActivityIndicator color={COLORS.accent} />
              <Text style={styles.stateText}>Cargando fotos…</Text>
            </View>
          ) : error ? (
            <View style={styles.centered}>
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={() => void load()}>
                <Text style={styles.retryLabel}>Reintentar</Text>
              </TouchableOpacity>
            </View>
          ) : photos.length === 0 ? (
            <View style={styles.centered}>
              <Text style={styles.stateText}>Todavía no hay fotos en este pozo.</Text>
              <Text style={styles.hintText}>
                Las fotos que el operador saca desde Progreso o Muestras aparecen acá.
              </Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.grid} keyboardDismissMode="on-drag">
              {photos.map((photo) => {
                const url = urls[photo.storage_path];
                return (
                  <TouchableOpacity
                    key={photo.id}
                    style={[styles.tile, { width: tileSize }]}
                    onPress={() => url && setExpanded(photo)}
                    disabled={!url}
                    accessibilityLabel={photo.caption || 'Foto del pozo'}
                  >
                    {url ? (
                      <Image
                        source={{ uri: url }}
                        style={[styles.thumb, { width: tileSize, height: tileSize }]}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={[styles.thumb, styles.thumbMissing, { width: tileSize, height: tileSize }]}>
                        <Text style={styles.missingText}>No disponible</Text>
                      </View>
                    )}
                    <Text style={styles.tileKind}>
                      {KIND_LABELS[photo.evidence_kind || ''] || 'Foto'}
                    </Text>
                    <Text style={styles.tileMeta} numberOfLines={1}>
                      {photographer(photo)}
                    </Text>
                    <Text style={styles.tileMeta} numberOfLines={1}>
                      {formatDisplayDateTime(photo.created_at)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              {hasMore ? (
                <TouchableOpacity
                  style={styles.loadMore}
                  onPress={() => void loadMore()}
                  disabled={loadingMore}
                  accessibilityRole="button"
                >
                  <Text style={styles.loadMoreLabel}>
                    {loadingMore ? 'Cargando…' : 'Cargar más'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          )}
        </View>
      </View>

      {/* Full size, because a 150px tile cannot settle a question about a
          casing joint or a soil change. */}
      <Modal visible={!!expanded} transparent animationType="fade" onRequestClose={() => setExpanded(null)}>
        <View style={styles.viewerBackdrop}>
          <TouchableOpacity
            style={styles.viewerDismiss}
            onPress={() => setExpanded(null)}
            accessibilityLabel="Cerrar foto"
          />
          {!!expanded && (
            <View style={styles.viewerContent} pointerEvents="box-none">
              <Image
                source={{ uri: urls[expanded.storage_path] }}
                style={styles.viewerImage}
                resizeMode="contain"
              />
              <View style={styles.viewerCaption}>
                {!!expanded.caption && <Text style={styles.viewerCaptionText}>{expanded.caption}</Text>}
                <Text style={styles.viewerMeta}>
                  {photographer(expanded)} · {formatDisplayDateTime(expanded.created_at)}
                </Text>
                <TouchableOpacity style={styles.viewerClose} onPress={() => setExpanded(null)}>
                  <Text style={styles.viewerCloseLabel}>Cerrar</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: COLORS.backdrop,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: RADIUS.lg,
    borderTopRightRadius: RADIUS.lg,
    maxHeight: '90%',
    paddingBottom: SPACING.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerText: { flex: 1 },
  title: {
    fontSize: TYPE.h2,
    fontWeight: TYPE.bold,
    color: COLORS.text,
  },
  subtitle: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
    marginTop: SPACING.xs,
  },
  closeButton: {
    minHeight: SPACING.huge2,
    minWidth: SPACING.huge2,
    paddingHorizontal: SPACING.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeLabel: {
    fontSize: TYPE.bodyLg,
    fontWeight: TYPE.semibold,
    color: COLORS.primaryText,
  },
  centered: {
    padding: SPACING.huge,
    alignItems: 'center',
    gap: SPACING.sm,
  },
  stateText: {
    fontSize: TYPE.bodyLg,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  hintText: {
    fontSize: TYPE.label,
    color: COLORS.textMuted,
    textAlign: 'center',
  },
  errorText: {
    fontSize: TYPE.bodyLg,
    color: COLORS.errorText,
    textAlign: 'center',
  },
  retryButton: {
    minHeight: SPACING.huge2,
    paddingHorizontal: SPACING.xl,
    justifyContent: 'center',
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    marginTop: SPACING.sm,
  },
  retryLabel: {
    fontSize: TYPE.bodyLg,
    fontWeight: TYPE.semibold,
    color: COLORS.primaryText,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.lg,
    padding: SPACING.lg,
  },
  tile: {
    borderRadius: RADIUS.md,
    overflow: 'hidden',
  },
  loadMore: {
    minHeight: SPACING.huge2,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
  },
  loadMoreLabel: {
    fontSize: TYPE.bodyLg,
    fontWeight: TYPE.semibold,
    color: COLORS.primaryText,
  },
  thumb: {
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.input,
  },
  thumbMissing: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  missingText: {
    fontSize: TYPE.caption,
    color: COLORS.textMuted,
  },
  tileKind: {
    fontSize: TYPE.label,
    fontWeight: TYPE.semibold,
    color: COLORS.text,
    marginTop: SPACING.sm,
  },
  tileMeta: {
    fontSize: TYPE.caption,
    color: COLORS.textMuted,
  },
  viewerBackdrop: {
    flex: 1,
    backgroundColor: COLORS.backdropStrong,
    justifyContent: 'center',
  },
  viewerDismiss: {
    ...StyleSheet.absoluteFillObject,
  },
  viewerContent: {
    paddingHorizontal: SPACING.lg,
    gap: SPACING.lg,
  },
  viewerImage: {
    width: '100%',
    height: '70%',
    minHeight: SPACING.huge5,
  },
  viewerCaption: {
    gap: SPACING.xs,
    alignItems: 'center',
  },
  viewerCaptionText: {
    fontSize: TYPE.bodyLg,
    color: COLORS.text,
    textAlign: 'center',
  },
  viewerMeta: {
    fontSize: TYPE.label,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  viewerClose: {
    minHeight: SPACING.huge2,
    paddingHorizontal: SPACING.xxl,
    justifyContent: 'center',
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.primary,
    marginTop: SPACING.sm,
  },
  viewerCloseLabel: {
    fontSize: TYPE.bodyLg,
    fontWeight: TYPE.semibold,
    color: COLORS.textOnPrimary,
  },
});

export default ProjectPhotosModal;
