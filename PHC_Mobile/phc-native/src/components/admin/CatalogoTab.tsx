import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { useFocusEffect } from '@react-navigation/native';

import { productV2Api } from '../../api/supabase-product-v2';
import { COLORS, RADIUS, SPACING, STATUS, TYPE } from '../../theme/phcTheme';
import type {
  CatalogMaterial,
  CatalogVariant,
  MaterialType,
  MeasurementMethod,
} from '../../types/productV2';
import { adminErrorText } from '../../domain/adminErrors';
import { adminSharedStyles } from './adminSharedStyles';
import { showSheet } from '../shared/Sheet';

interface MaterialFormState {
  id?: number;
  name: string;
  externalCode: string;
  materialType: MaterialType;
  unit: string;
  measurementMethod: MeasurementMethod;
  active: boolean;
}

interface VariantFormState {
  id?: number;
  materialId: number;
  displayName: string;
  externalCode: string;
  diameter: string;
  lengthM: string;
  dimensionText: string;
  active: boolean;
}

const MATERIAL_TYPES: Array<{ value: MaterialType; label: string }> = [
  { value: 'consumable', label: 'Consumible' },
  { value: 'tool', label: 'Herramienta' },
  { value: 'fuel', label: 'Combustible' },
  { value: 'food', label: 'Alimento' },
  { value: 'pipe', label: 'Cañería' },
  { value: 'cement', label: 'Cemento' },
  { value: 'cable', label: 'Cable' },
  { value: 'other', label: 'Otro' },
];

const MEASUREMENT_METHODS: Array<{ value: MeasurementMethod; label: string }> = [
  { value: 'quantity', label: 'Cantidad' },
  { value: 'volume', label: 'Volumen' },
  { value: 'weight', label: 'Peso' },
  { value: 'length', label: 'Longitud' },
  { value: 'diameter_length', label: 'Diámetro + longitud' },
];

const emptyMaterialForm = (): MaterialFormState => ({
  name: '',
  externalCode: '',
  materialType: 'consumable',
  unit: 'unidad',
  measurementMethod: 'quantity',
  active: true,
});

const formFromMaterial = (material: CatalogMaterial): MaterialFormState => ({
  id: material.id,
  name: material.name,
  externalCode: material.external_code || '',
  materialType: material.material_type,
  unit: material.unit,
  measurementMethod: material.measurement_method,
  active: material.active,
});

const emptyVariantForm = (materialId: number): VariantFormState => ({
  materialId,
  displayName: '',
  externalCode: '',
  diameter: '',
  lengthM: '',
  dimensionText: '',
  active: true,
});

const formFromVariant = (variant: CatalogVariant): VariantFormState => ({
  id: variant.id,
  materialId: variant.material_id,
  displayName: variant.display_name,
  externalCode: variant.external_code || '',
  diameter: variant.diameter || '',
  lengthM: variant.length_m != null ? String(variant.length_m) : '',
  dimensionText: variant.dimension_text || '',
  active: variant.active,
});

const typeLabel = (value: MaterialType) =>
  MATERIAL_TYPES.find((item) => item.value === value)?.label || value;
const methodLabel = (value: MeasurementMethod) =>
  MEASUREMENT_METHODS.find((item) => item.value === value)?.label || value;

const CatalogoTab = () => {
  const [materials, setMaterials] = useState<CatalogMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [materialForm, setMaterialForm] = useState<MaterialFormState | null>(null);
  const [variantForm, setVariantForm] = useState<VariantFormState | null>(null);
  // Errors from the two forms are shown inside the form: the page banner sits behind the modal.
  const [materialFormError, setMaterialFormError] = useState<string | null>(null);
  const [variantFormError, setVariantFormError] = useState<string | null>(null);

  useEffect(() => { setMaterialFormError(null); }, [materialForm === null]);
  useEffect(() => { setVariantFormError(null); }, [variantForm === null]);

  const load = useCallback(async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setMaterials(await productV2Api.getCatalog(true));
    } catch (loadError) {
      setError(adminErrorText(loadError, 'No se pudo cargar el catálogo.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const visibleMaterials = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es');
    return materials.filter((material) => {
      if (!showInactive && !material.active) return false;
      if (!term) return true;
      return [
        material.name,
        material.external_code,
        ...(material.catalog_variants || [])
          .filter((variant) => showInactive || variant.active)
          .flatMap((variant) => [variant.display_name, variant.external_code]),
      ].some((value) => value?.toLocaleLowerCase('es').includes(term));
    });
  }, [materials, search, showInactive]);

  const persistMaterial = async (form: MaterialFormState) => {
    setBusy(true);
    setMaterialFormError(null);
    setNotice(null);
    try {
      const saved = await productV2Api.saveCatalogMaterial({
        id: form.id,
        name: form.name.trim(),
        unit: form.unit.trim(),
        materialType: form.materialType,
        measurementMethod: form.measurementMethod,
        externalCode: form.externalCode.trim() || undefined,
        active: form.active,
      });
      setNotice(form.id
        ? 'Material actualizado.'
        : 'Material creado con su variante Estándar.');
      setExpandedId(saved.id);
      setMaterialForm(null);
      await load();
    } catch (saveError) {
      setMaterialFormError(adminErrorText(saveError, 'No se pudo guardar el material.'));
    } finally {
      setBusy(false);
    }
  };

  const saveMaterial = async () => {
    if (!materialForm) return;
    if (materialForm.name.trim().length < 2 || !materialForm.unit.trim()) {
      setMaterialFormError('Nombre y unidad son obligatorios.');
      return;
    }
    // Existing well allocations keep the unit they were booked in. A new unit
    // only applies to what is assigned from now on, so say so before saving.
    const original = materialForm.id ? materials.find((material) => material.id === materialForm.id) : undefined;
    const newUnit = materialForm.unit.trim();
    if (original && original.unit !== newUnit) {
      showSheet(
        'Cambiar la unidad',
        `Las asignaciones que ya existen en los pozos conservan la unidad "${original.unit}". Solo las nuevas usan "${newUnit}", así que los totales de un mismo material pueden quedar en dos unidades. Revisá los pozos antes de seguir.`,
        [
          { text: 'Volver', style: 'cancel' },
          { text: 'Guardar igual', style: 'destructive', onPress: () => void persistMaterial(materialForm) },
        ],
      );
      return;
    }
    await persistMaterial(materialForm);
  };

  const updateMaterialActive = async (material: CatalogMaterial, active: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await productV2Api.saveCatalogMaterial({
        ...formFromMaterial(material),
        materialType: material.material_type,
        measurementMethod: material.measurement_method,
        externalCode: material.external_code || undefined,
        active,
      });
      setNotice(active ? 'Material reactivado.' : 'Material desactivado sin borrar su historial.');
      await load();
    } catch (toggleError) {
      setError(adminErrorText(toggleError, 'No se pudo cambiar el estado del material.'));
    } finally {
      setBusy(false);
    }
  };

  const toggleMaterial = (material: CatalogMaterial) => {
    if (!material.active) {
      void updateMaterialActive(material, true);
      return;
    }
    showSheet(
      'Desactivar material',
      `¿Desactivar "${material.name}"? Seguirá visible en el historial, pero no podrá elegirse en nuevas asignaciones.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Desactivar', style: 'destructive', onPress: () => void updateMaterialActive(material, false) },
      ],
    );
  };

  const saveVariant = async () => {
    if (!variantForm) return;
    const parsedLength = variantForm.lengthM ? Number(variantForm.lengthM.replace(',', '.')) : undefined;
    if (!variantForm.displayName.trim()) {
      setVariantFormError('El nombre de la variante es obligatorio.');
      return;
    }
    if (parsedLength !== undefined && !(parsedLength > 0)) {
      setVariantFormError('La longitud debe ser mayor que cero.');
      return;
    }
    setBusy(true);
    setVariantFormError(null);
    setNotice(null);
    try {
      await productV2Api.saveCatalogVariant({
        id: variantForm.id,
        materialId: variantForm.materialId,
        displayName: variantForm.displayName.trim(),
        externalCode: variantForm.externalCode.trim() || undefined,
        diameter: variantForm.diameter.trim() || undefined,
        lengthM: parsedLength,
        dimensionText: variantForm.dimensionText.trim() || undefined,
        active: variantForm.active,
      });
      setNotice(variantForm.id ? 'Variante actualizada.' : 'Variante agregada al catálogo.');
      setExpandedId(variantForm.materialId);
      setVariantForm(null);
      await load();
    } catch (saveError) {
      setVariantFormError(adminErrorText(saveError, 'No se pudo guardar la variante.'));
    } finally {
      setBusy(false);
    }
  };

  const updateVariantActive = async (variant: CatalogVariant, active: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await productV2Api.saveCatalogVariant({
        ...formFromVariant(variant),
        materialId: variant.material_id,
        displayName: variant.display_name,
        externalCode: variant.external_code || undefined,
        diameter: variant.diameter || undefined,
        lengthM: variant.length_m ?? undefined,
        dimensionText: variant.dimension_text || undefined,
        active,
      });
      setNotice(active ? 'Variante reactivada.' : 'Variante desactivada.');
      await load();
    } catch (toggleError) {
      setError(adminErrorText(toggleError, 'No se pudo cambiar el estado de la variante.'));
    } finally {
      setBusy(false);
    }
  };

  const toggleVariant = (variant: CatalogVariant) => {
    if (!variant.active) {
      void updateVariantActive(variant, true);
      return;
    }
    showSheet(
      'Desactivar variante',
      `¿Desactivar la variante "${variant.display_name}"?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Desactivar', style: 'destructive', onPress: () => void updateVariantActive(variant, false) },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <ScrollView
      keyboardDismissMode="on-drag"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={COLORS.accent} />}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.toolbar}>
          <View style={styles.toolbarCopy}>
            <Text style={styles.title}>Catálogo de Materiales</Text>
            <Text style={styles.subtitle}>Materiales permanentes, unidades y variantes reutilizables</Text>
          </View>
          <TouchableOpacity
            testID="catalog-new-material"
            style={styles.primaryButton}
            onPress={() => { setMaterialForm(emptyMaterialForm()); setVariantForm(null); }}
          >
            <Text style={styles.primaryButtonText}>+ Nuevo material</Text>
          </TouchableOpacity>
        </View>

        {error && <Text style={styles.errorBanner} accessibilityRole="alert">{error}</Text>}
        {notice && <Text style={styles.noticeBanner} accessibilityRole="summary">{notice}</Text>}

        <View style={styles.card}>
          <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss}
            testID="catalog-search"
            style={styles.input}
            value={search}
            onChangeText={setSearch}
            placeholder="Buscar por material, variante o código"
            placeholderTextColor={COLORS.placeholder}
          />
          <View style={styles.switchRow}>
            <Text style={styles.label}>Mostrar desactivados</Text>
            <Switch
              value={showInactive}
              onValueChange={setShowInactive}
              trackColor={{ false: COLORS.border, true: COLORS.primary }}
              thumbColor={COLORS.text}
            />
          </View>
        </View>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={COLORS.accent} />
            <Text style={styles.loadingText}>Cargando catálogo…</Text>
          </View>
        ) : visibleMaterials.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.emptyStateText}>No hay materiales que coincidan con los filtros.</Text>
          </View>
        ) : visibleMaterials.map((material) => {
          const variants = (material.catalog_variants || []).filter((variant) => showInactive || variant.active);
          const expanded = expandedId === material.id;
          return (
            <View key={material.id} style={[styles.card, !material.active && styles.inactiveCard]}>
              <View style={styles.itemHeader}>
                <View style={styles.itemHeaderCopy}>
                  <View style={styles.titleRow}>
                    <Text style={styles.cardTitle}>{material.name}</Text>
                    <Text style={[styles.badge, material.active ? styles.activeBadge : styles.inactiveBadge]}>
                      {material.active ? 'Activo' : 'Desactivado'}
                    </Text>
                  </View>
                  <Text style={styles.meta}>
                    {typeLabel(material.material_type)} · {material.unit} · {methodLabel(material.measurement_method)}
                    {material.external_code ? ` · Código ${material.external_code}` : ''}
                  </Text>
                </View>
              </View>
              <View style={styles.actions}>
                <TouchableOpacity style={styles.secondaryButton} onPress={() => setExpandedId(expanded ? null : material.id)}>
                  <Text style={styles.secondaryButtonText}>{expanded ? 'Ocultar variantes' : `Variantes (${variants.length})`}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondaryButton} onPress={() => { setMaterialForm(formFromMaterial(material)); setVariantForm(null); }}>
                  <Text style={styles.secondaryButtonText}>Editar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={busy}
                  style={[styles.stateButton, material.active ? styles.dangerButton : styles.successButton]}
                  onPress={() => toggleMaterial(material)}
                >
                  <Text style={styles.stateButtonText}>{material.active ? 'Desactivar' : 'Reactivar'}</Text>
                </TouchableOpacity>
              </View>

              {expanded && (
                <View style={styles.variantSection}>
                  <View style={styles.variantHeader}>
                    <Text style={styles.sectionTitle}>Variantes</Text>
                    <TouchableOpacity
                      disabled={!material.active}
                      style={[styles.smallPrimaryButton, !material.active && styles.disabled]}
                      onPress={() => { setVariantForm(emptyVariantForm(material.id)); setMaterialForm(null); }}
                    >
                      <Text style={styles.primaryButtonText}>+ Agregar variante</Text>
                    </TouchableOpacity>
                  </View>
                  {variants.length === 0 ? (
                    <Text style={styles.meta}>No hay variantes visibles.</Text>
                  ) : variants.map((variant) => (
                    <View key={variant.id} style={[styles.variantRow, !variant.active && styles.inactiveCard]}>
                      <View style={styles.variantCopy}>
                        <Text style={styles.variantName}>{variant.display_name}</Text>
                        <Text style={styles.meta}>
                          {[
                            variant.external_code ? `Código ${variant.external_code}` : '',
                            variant.diameter ? `Ø ${variant.diameter}` : '',
                            variant.length_m != null ? `${variant.length_m} m` : '',
                            variant.dimension_text || '',
                          ].filter(Boolean).join(' · ') || 'Sin dimensiones adicionales'}
                        </Text>
                      </View>
                      <View style={styles.actions}>
                        <TouchableOpacity style={styles.secondaryButton} onPress={() => { setVariantForm(formFromVariant(variant)); setMaterialForm(null); }}>
                          <Text style={styles.secondaryButtonText}>Editar</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          disabled={busy || !material.active}
                          style={[styles.stateButton, variant.active ? styles.dangerButton : styles.successButton, !material.active && styles.disabled]}
                          onPress={() => toggleVariant(variant)}
                        >
                          <Text style={styles.stateButtonText}>{variant.active ? 'Desactivar' : 'Reactivar'}</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>

      <Modal visible={materialForm !== null} transparent animationType="slide" onRequestClose={() => !busy && setMaterialForm(null)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalCard}>
            <ScrollView
      keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalContent}>
              <Text style={styles.modalTitle}>{materialForm?.id ? 'Editar material' : 'Nuevo material'}</Text>
              <Text style={styles.fieldLabel}>Nombre *</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} testID="catalog-material-name" style={styles.input} value={materialForm?.name || ''} onChangeText={(name) => setMaterialForm((form) => form ? { ...form, name } : form)} placeholderTextColor={COLORS.placeholder} />
              <Text style={styles.fieldLabel}>Código externo</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={materialForm?.externalCode || ''} onChangeText={(externalCode) => setMaterialForm((form) => form ? { ...form, externalCode } : form)} placeholderTextColor={COLORS.placeholder} />
              <Text style={styles.fieldLabel}>Tipo *</Text>
              <View style={styles.pickerWrap}>
                <Picker selectedValue={materialForm?.materialType || 'consumable'} onValueChange={(materialType) => setMaterialForm((form) => form ? { ...form, materialType } : form)} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>
                  {MATERIAL_TYPES.map((item) => <Picker.Item key={item.value} label={item.label} value={item.value} />)}
                </Picker>
              </View>
              <Text style={styles.fieldLabel}>Unidad *</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} testID="catalog-material-unit" style={styles.input} value={materialForm?.unit || ''} onChangeText={(unit) => setMaterialForm((form) => form ? { ...form, unit } : form)} placeholder="unidad, kg, L, m…" placeholderTextColor={COLORS.placeholder} />
              <Text style={styles.fieldLabel}>Método de medición *</Text>
              <View style={styles.pickerWrap}>
                <Picker selectedValue={materialForm?.measurementMethod || 'quantity'} onValueChange={(measurementMethod) => setMaterialForm((form) => form ? { ...form, measurementMethod } : form)} style={styles.picker} dropdownIconColor={COLORS.textSecondary}>
                  {MEASUREMENT_METHODS.map((item) => <Picker.Item key={item.value} label={item.label} value={item.value} />)}
                </Picker>
              </View>
              {materialForm?.id && (
                <View style={styles.switchRow}>
                  <Text style={styles.label}>Material activo</Text>
                  <Switch value={materialForm.active} onValueChange={(active) => setMaterialForm((form) => form ? { ...form, active } : form)} trackColor={{ false: COLORS.border, true: COLORS.primary }} thumbColor={COLORS.text} />
                </View>
              )}
              {materialFormError && <Text style={styles.errorBanner} accessibilityRole="alert">{materialFormError}</Text>}
              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.secondaryModalButton} disabled={busy} onPress={() => setMaterialForm(null)}><Text style={styles.secondaryButtonText}>Cancelar</Text></TouchableOpacity>
                <TouchableOpacity testID="catalog-save-material" style={[styles.primaryModalButton, busy && styles.disabled]} disabled={busy} onPress={() => void saveMaterial()}><Text style={styles.primaryButtonText}>{busy ? 'Guardando…' : 'Guardar material'}</Text></TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={variantForm !== null} transparent animationType="slide" onRequestClose={() => !busy && setVariantForm(null)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalCard}>
            <ScrollView
      keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalContent}>
              <Text style={styles.modalTitle}>{variantForm?.id ? 'Editar variante' : 'Nueva variante'}</Text>
              <Text style={styles.fieldLabel}>Nombre de variante *</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} testID="catalog-variant-name" style={styles.input} value={variantForm?.displayName || ''} onChangeText={(displayName) => setVariantForm((form) => form ? { ...form, displayName } : form)} placeholder="Ej: 6 pulgadas x 4 m" placeholderTextColor={COLORS.placeholder} />
              <Text style={styles.fieldLabel}>Código externo</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={variantForm?.externalCode || ''} onChangeText={(externalCode) => setVariantForm((form) => form ? { ...form, externalCode } : form)} placeholderTextColor={COLORS.placeholder} />
              <Text style={styles.fieldLabel}>Diámetro</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={variantForm?.diameter || ''} onChangeText={(diameter) => setVariantForm((form) => form ? { ...form, diameter } : form)} placeholder='Ej: 6"' placeholderTextColor={COLORS.placeholder} />
              <Text style={styles.fieldLabel}>Longitud (m)</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={variantForm?.lengthM || ''} onChangeText={(lengthM) => setVariantForm((form) => form ? { ...form, lengthM } : form)} keyboardType="decimal-pad" placeholderTextColor={COLORS.placeholder} />
              <Text style={styles.fieldLabel}>Dimensiones / detalle</Text>
              <TextInput
      returnKeyType="done"
      onSubmitEditing={Keyboard.dismiss} style={styles.input} value={variantForm?.dimensionText || ''} onChangeText={(dimensionText) => setVariantForm((form) => form ? { ...form, dimensionText } : form)} placeholderTextColor={COLORS.placeholder} />
              {variantForm?.id && (
                <View style={styles.switchRow}>
                  <Text style={styles.label}>Variante activa</Text>
                  <Switch value={variantForm.active} onValueChange={(active) => setVariantForm((form) => form ? { ...form, active } : form)} trackColor={{ false: COLORS.border, true: COLORS.primary }} thumbColor={COLORS.text} />
                </View>
              )}
              {variantFormError && <Text style={styles.errorBanner} accessibilityRole="alert">{variantFormError}</Text>}
              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.secondaryModalButton} disabled={busy} onPress={() => setVariantForm(null)}><Text style={styles.secondaryButtonText}>Cancelar</Text></TouchableOpacity>
                <TouchableOpacity testID="catalog-save-variant" style={[styles.primaryModalButton, busy && styles.disabled]} disabled={busy} onPress={() => void saveVariant()}><Text style={styles.primaryButtonText}>{busy ? 'Guardando…' : 'Guardar variante'}</Text></TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  ...adminSharedStyles,
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.md },
  activeBadge: { backgroundColor: COLORS.successBg, color: COLORS.successText },
  badge: { borderRadius: RADIUS.pill, fontSize: TYPE.micro, fontWeight: TYPE.bold, overflow: 'hidden', paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs },
  card: { backgroundColor: COLORS.card, borderColor: COLORS.border, borderRadius: RADIUS.lg, borderWidth: 1, marginBottom: SPACING.lg, padding: SPACING.lg },
  cardTitle: { color: COLORS.text, flexShrink: 1, fontSize: TYPE.h2, fontWeight: TYPE.bold },
  content: { padding: SPACING.lg, paddingBottom: SPACING.huge5 },
  dangerButton: { backgroundColor: COLORS.error },
  disabled: { opacity: 0.6 },
  emptyStateText: { color: COLORS.textSecondary, fontSize: TYPE.body, textAlign: 'center' },
  errorBanner: { backgroundColor: COLORS.errorBg, borderColor: COLORS.error, borderRadius: RADIUS.md, borderWidth: 1, color: COLORS.text, marginBottom: SPACING.md, padding: SPACING.md },
  fieldLabel: { color: COLORS.textSecondary, fontSize: TYPE.label, fontWeight: TYPE.semibold, marginBottom: SPACING.xs, marginTop: SPACING.md },
  inactiveBadge: { backgroundColor: STATUS.neutralBg, color: STATUS.neutral },
  inactiveCard: { opacity: 0.72 },
  input: { backgroundColor: COLORS.input, borderColor: COLORS.border, borderRadius: RADIUS.md, borderWidth: 1, color: COLORS.text, fontSize: TYPE.body, minHeight: 48, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  itemHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  itemHeaderCopy: { flex: 1 },
  label: { color: COLORS.textSecondary, fontSize: TYPE.label, fontWeight: TYPE.semibold },
  loadingText: { color: COLORS.textSecondary, marginTop: SPACING.md },
  meta: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 18, marginTop: SPACING.xs },
  modalActions: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.xl },
  modalCard: { backgroundColor: COLORS.card, borderColor: COLORS.border, borderRadius: RADIUS.lg, borderWidth: 1, maxHeight: '90%', width: '94%' },
  modalContent: { padding: SPACING.xl },
  modalOverlay: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.7)', flex: 1, justifyContent: 'center' },
  modalTitle: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold },
  noticeBanner: { backgroundColor: COLORS.successBg, borderColor: COLORS.success, borderRadius: RADIUS.md, borderWidth: 1, color: COLORS.text, marginBottom: SPACING.md, padding: SPACING.md },
  picker: { color: COLORS.text },
  pickerWrap: { backgroundColor: COLORS.input, borderColor: COLORS.border, borderRadius: RADIUS.md, borderWidth: 1, overflow: 'hidden' },
  primaryButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.primary, borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md },
  primaryButtonText: { color: COLORS.textOnPrimary, fontSize: TYPE.label, fontWeight: TYPE.bold },
  primaryModalButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.primary, borderRadius: RADIUS.md, flex: 1, padding: SPACING.md },
  secondaryButton: { minHeight: 48, justifyContent: 'center', borderColor: COLORS.border, borderRadius: RADIUS.md, borderWidth: 1, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  secondaryButtonText: { color: COLORS.textSecondary, fontSize: TYPE.caption, fontWeight: TYPE.semibold },
  secondaryModalButton: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderColor: COLORS.border, borderRadius: RADIUS.md, borderWidth: 1, flex: 1, padding: SPACING.md },
  sectionTitle: { color: COLORS.text, fontSize: TYPE.body, fontWeight: TYPE.bold },
  smallPrimaryButton: { minHeight: 48, justifyContent: 'center', backgroundColor: COLORS.primary, borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  stateButton: { minHeight: 48, justifyContent: 'center', borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm },
  stateButtonText: { color: COLORS.text, fontSize: TYPE.caption, fontWeight: TYPE.bold },
  subtitle: { color: COLORS.textSecondary, fontSize: TYPE.caption, lineHeight: 18, marginTop: SPACING.xs },
  successButton: { backgroundColor: COLORS.success },
  switchRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACING.md },
  title: { color: COLORS.text, fontSize: TYPE.title, fontWeight: TYPE.bold },
  titleRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  toolbar: { alignItems: 'flex-start', flexDirection: 'row', gap: SPACING.md, justifyContent: 'space-between', marginBottom: SPACING.lg },
  toolbarCopy: { flex: 1 },
  variantCopy: { flex: 1 },
  variantHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: SPACING.md },
  variantName: { color: COLORS.text, fontSize: TYPE.body, fontWeight: TYPE.semibold },
  variantRow: { backgroundColor: COLORS.surfaceVariant, borderColor: COLORS.borderLight, borderRadius: RADIUS.md, borderWidth: 1, marginTop: SPACING.sm, padding: SPACING.md },
  variantSection: { borderTopColor: COLORS.border, borderTopWidth: 1, marginTop: SPACING.lg, paddingTop: SPACING.lg },
});

export default CatalogoTab;
