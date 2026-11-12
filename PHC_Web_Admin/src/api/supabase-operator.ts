import { completionApi } from './supabase-completion';
import { drillingBarsApi } from './supabase-drilling-bars';
import { operatorProjectsApi } from './supabase-operator-projects';
import { createOperatorClientEntryId } from './supabase-operator-session';
import { pedidosApi } from './supabase-pedidos';
import { shiftsApi } from './supabase-shifts';
import { waterSamplesApi } from './supabase-water-samples';

/**
 * The only API surface operator-facing components should import.
 *
 * Deliberately absent: operator directory reads, catalog mutations, pedido
 * decisions/manual close, corrections, reconciliations, discrepancy
 * resolution, Ficha return/sign, and every other admin-only operation.
 */
export const operatorApi = {
  createClientEntryId: createOperatorClientEntryId,
  projects: {
    getAssigned: operatorProjectsApi.getAssigned,
    getById: operatorProjectsApi.getById,
    getMaterials: operatorProjectsApi.getMaterials,
    getClosingAssignments: operatorProjectsApi.getClosingAssignments,
  },
  catalog: {
    getActive: operatorProjectsApi.getActiveCatalog,
  },
  shifts: {
    getMine: shiftsApi.getMine,
    getMyMetrics: shiftsApi.getMyMetrics,
    start: shiftsApi.start,
    confirmHandover: shiftsApi.confirmHandover,
    end: shiftsApi.end,
  },
  bars: {
    getMine: drillingBarsApi.getMine,
    create: drillingBarsApi.create,
  },
  pedidos: {
    getMine: pedidosApi.getMine,
    createV2: pedidosApi.createV2,
    confirmReceipt: pedidosApi.confirmReceipt,
  },
  samples: {
    getHistory: waterSamplesApi.getHistory,
    register: waterSamplesApi.register,
  },
  completion: {
    getMine: completionApi.getMine,
    getPreview: completionApi.getOperatorPreview,
    reportDiscrepancy: completionApi.reportDiscrepancy,
    submitV2: completionApi.submitV2,
    resubmitV2: completionApi.resubmitV2,
  },
} as const;

export type {
  ActiveOperatorCatalog,
  CasingLayoutRow,
  CompletionDiscrepancy,
  CompletionFinalFields,
  ConfirmPedidoReceiptInput,
  ConfirmPedidoReceiptResult,
  CreateDrillingBarInput,
  CreatePedidoV2Input,
  CreatePedidoV2Result,
  DrillingBar,
  OperatorClosingAssignment,
  OperatorCompletionReport,
  OperatorFichaPreview,
  OperatorProject,
  OperatorProjectMaterial,
  PedidoDraftItem,
  RegisterWaterSampleInput,
  ResubmitCompletionV2Input,
  SubmitCompletionV2Input,
  WaterSample,
} from '../types/operatorConsole';
