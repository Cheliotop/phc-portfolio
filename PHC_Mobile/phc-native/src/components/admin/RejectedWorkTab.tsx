import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { rejectedWorkApi, type RejectedWorkDecision } from '../../api/supabase-rejected-work';
import { COLORS, RADIUS, SPACING, TYPE } from '../../theme/phcTheme';
import { formatDisplayDateTime } from '../../utils/dateFormat';
import { adminErrorText } from '../../domain/adminErrors';
import { showSheet } from '../shared/Sheet';
import { SENT_LATER_TEXT, addsToRecord, rejectedWorkDetails, rejectedWorkLabel, rejectionReasonText } from '../../domain/rejectedWork';

const RejectedWorkTab = () => {
  const [items, setItems] = useState<any[]>([]);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setItems(await rejectedWorkApi.listPending());
    } catch (loadError) {
      setError(adminErrorText(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  // Accepting writes a bar or sample into the well for good, so it asks first and names the effect.
  const requestDecide = (item: any, decision: RejectedWorkDecision) => {
    const accepted = decision === 'accepted';
    const wellText = item.project?.name ? ` en ${item.project.name}` : '';
    showSheet(
      accepted ? 'Aceptar registro' : 'Rechazar registro',
      accepted
        ? `Se suma al registro${wellText} como un dato nuevo, con marca de revisión. Hacelo solo si confirmaste el dato. No se puede deshacer desde la app.`
        : `El registro rechazado no entra al pozo${wellText}. Se conserva el motivo.`,
      [
        { text: 'Volver', style: 'cancel' },
        {
          text: accepted ? 'Aceptar' : 'Rechazar',
          style: accepted ? 'default' : 'destructive',
          onPress: () => void decide(item, decision),
        },
      ],
    );
  };

  const decide = async (item: any, decision: RejectedWorkDecision) => {
    setBusyId(item.id);
    try {
      await rejectedWorkApi.decide(item.id, decision, notes[item.id]);
      setNotes((current) => {
        const rest = { ...current };
        delete rest[item.id];
        return rest;
      });
      await load();
    } catch (decideError) {
      showSheet('No se pudo guardar la decisión', adminErrorText(decideError));
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={COLORS.accent} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      refreshControl={(
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load();
          }}
          tintColor={COLORS.accent}
        />
      )}
    >
      <Text style={styles.title}>Revisión</Text>
      <Text style={styles.muted}>
        Trabajo de campo que el servidor rechazó. Aceptá o rechazá cada registro.
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!error && items.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Nada para revisar</Text>
          <Text style={styles.muted}>Acá aparece el trabajo que el servidor no aceptó.</Text>
        </View>
      ) : null}

      {items.map((item) => {
        const automatic = addsToRecord(item.entity);
        const operator = item.operator?.full_name || item.operator?.username || 'Operador desconocido';
        const well = item.project?.well_name || item.project?.name || 'Sin pozo';
        const busy = busyId === item.id;
        return (
          <View key={item.id} style={styles.card}>
            <Text style={styles.cardTitle}>{rejectedWorkLabel(item.entity)}</Text>
            <Text style={styles.line}>{well} · {operator}</Text>
            <Text style={styles.muted}>{formatDisplayDateTime(item.rejected_at || item.created_at)}</Text>
            {rejectedWorkDetails(item.payload).map((detail) => (
              <Text key={detail} style={styles.line}>{detail}</Text>
            ))}
            <Text style={styles.reason}>Motivo: {rejectionReasonText(item.rejection_reason)}</Text>
            {item.sent_later_at ? <Text style={styles.sentLater}>{SENT_LATER_TEXT}</Text> : null}
            {item.reported_by !== item.operator_id ? (
              <Text style={styles.muted}>Lo envió otro integrante del equipo desde el dispositivo de este operador.</Text>
            ) : null}
            <Text style={styles.muted}>
              {automatic
                ? 'Si lo aceptás, se suma al registro del pozo con una marca de revisión.'
                : 'Si lo aceptás, cargalo a mano e indicá qué hiciste en la nota.'}
            </Text>
            <TextInput
              style={styles.input}
              value={notes[item.id] || ''}
              onChangeText={(note) => setNotes((current) => ({ ...current, [item.id]: note }))}
              placeholder={automatic ? 'Nota (obligatoria para rechazar)' : 'Nota obligatoria'}
              placeholderTextColor={COLORS.placeholder}
              multiline
            />
            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.button, styles.reject, busy && styles.disabled]}
                disabled={busy}
                onPress={() => requestDecide(item, 'rejected')}
              >
                <Text style={styles.buttonText}>Rechazar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.accept, busy && styles.disabled]}
                disabled={busy}
                onPress={() => requestDecide(item, 'accepted')}
              >
                <Text style={styles.buttonText}>{busy ? 'Guardando…' : 'Aceptar'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  centered: { justifyContent: 'center', alignItems: 'center' },
  content: { padding: SPACING.xl, paddingBottom: SPACING.huge4 },
  title: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold, marginBottom: SPACING.xs },
  muted: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 18, marginTop: SPACING.xs },
  line: { color: COLORS.text, fontSize: TYPE.label, marginTop: SPACING.xs },
  reason: { color: COLORS.warningText, fontSize: TYPE.caption, lineHeight: 18, marginTop: SPACING.sm },
  sentLater: { color: COLORS.successText, fontSize: TYPE.caption, lineHeight: 18, marginTop: SPACING.xs, fontWeight: '600' },
  error: { color: COLORS.errorText, fontSize: TYPE.caption, marginTop: SPACING.md },
  card: {
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    marginTop: SPACING.lg,
    padding: SPACING.lg,
  },
  cardTitle: { color: COLORS.text, fontSize: TYPE.h2, fontWeight: TYPE.bold },
  input: {
    backgroundColor: COLORS.input,
    borderColor: COLORS.border,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    color: COLORS.text,
    marginTop: SPACING.md,
    minHeight: 56,
    padding: SPACING.md,
    textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
  button: { alignItems: 'center', borderRadius: RADIUS.md, flex: 1, justifyContent: 'center', minHeight: 48, padding: SPACING.md },
  accept: { backgroundColor: COLORS.primary },
  reject: { backgroundColor: COLORS.danger },
  disabled: { opacity: 0.45 },
  buttonText: { color: COLORS.textOnPrimary, fontSize: TYPE.label, fontWeight: TYPE.bold },
});

export default RejectedWorkTab;
