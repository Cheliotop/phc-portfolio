import {
  normalizeStatus,
  statusLabel,
  statusToneFor,
  isActiveStatus,
} from '../src/domain/projectStatus';

describe('projectStatus domain', () => {
  it('normalizes English canonical values', () => {
    expect(normalizeStatus('planning')).toBe('planning');
    expect(normalizeStatus('active')).toBe('active');
    expect(normalizeStatus('completed')).toBe('completed');
    expect(normalizeStatus('closure_submitted')).toBe('closure_submitted');
  });

  it('maps legacy cached Spanish labels (offline compatibility)', () => {
    expect(normalizeStatus('En Progreso')).toBe('active');
    expect(normalizeStatus('Completado')).toBe('completed');
    expect(normalizeStatus('Pausado')).toBe('paused');
    expect(normalizeStatus('Cancelado')).toBe('cancelled');
  });

  it('defaults unknown/empty to active', () => {
    expect(normalizeStatus(undefined)).toBe('active');
    expect(normalizeStatus('')).toBe('active');
    expect(normalizeStatus('something-else')).toBe('active');
  });

  it('produces Spanish display labels', () => {
    expect(statusLabel('active')).toBe('En progreso');
    expect(statusLabel('completed')).toBe('Completado');
    expect(statusLabel('planning')).toBe('Planificado');
  });

  it('maps to semantic tones', () => {
    expect(statusToneFor('completed')).toBe('success');
    expect(statusToneFor('active')).toBe('active');
    expect(statusToneFor('cancelled')).toBe('danger');
    expect(statusToneFor('paused')).toBe('warning');
  });

  it('flags ongoing statuses for dashboard counts', () => {
    expect(isActiveStatus('active')).toBe(true);
    expect(isActiveStatus('planning')).toBe(true);
    expect(isActiveStatus('closure_submitted')).toBe(true);
    expect(isActiveStatus('completed')).toBe(false);
    expect(isActiveStatus('cancelled')).toBe(false);
  });
});
