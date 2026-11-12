import { normalizeStatus } from '../../domain/projectStatus';

export interface ClosedWellNotice {
  title: string;
  text: string;
  /** Only a completed well has a signed close report to open. */
  showCloseReport: boolean;
}

/**
 * What the operator reads when a well no longer takes field work (OPA-16).
 * Null for planning and active wells, which keep their actions. Uses the
 * canonical status vocabulary, so Spanish labels from older caches match too.
 */
export const closedWellNotice = (raw?: string | null): ClosedWellNotice | null => {
  switch (normalizeStatus(raw)) {
    case 'paused':
      return {
        title: 'Pozo pausado',
        text: 'La administración pausó este pozo. Por ahora no se puede registrar progreso, materiales ni pedidos. Consultá con la oficina cuándo se retoma.',
        showCloseReport: false,
      };
    case 'cancelled':
      return {
        title: 'Pozo cancelado',
        text: 'La administración canceló este pozo. No se puede registrar progreso, materiales ni pedidos. Consultá con la oficina.',
        showCloseReport: false,
      };
    case 'closure_submitted':
      return {
        title: 'Cierre enviado',
        text: 'El cierre de este pozo ya fue enviado y está en revisión por la administración. No se puede registrar nada más.',
        showCloseReport: false,
      };
    case 'completed':
      return {
        title: 'Pozo completado',
        text: 'Este pozo ya fue completado y firmado por la administración. Ya no se puede registrar progreso, materiales ni pedidos nuevos.',
        showCloseReport: true,
      };
    default:
      return null;
  }
};
