import AsyncStorage from '@react-native-async-storage/async-storage';
import { execute, query } from '../db/db';


export type AuditAction =
  | 'LOGIN'
  | 'LOGOUT'
  | 'PROJECT_CREATE'
  | 'PROJECT_UPDATE'
  | 'PROJECT_DELETE'
  | 'MATERIAL_ASSIGN'
  | 'MATERIAL_CONSUME'
  | 'INVENTORY_ADJUST'
  | 'REQUEST_APPROVE'
  | 'REQUEST_REJECT'
  | 'OPERATOR_CREATE'
  | 'OPERATOR_UPDATE'
  | 'PHOTO_UPLOAD'
  | 'DATA_EXPORT'
  | 'SETTINGS_CHANGE';

export interface AuditLogEntry {
  id: string;
  action: AuditAction;
  entity_type: string;
  entity_id: string;
  user_id: string;
  user_role: string;
  details: Record<string, any>;
  ip_address?: string;
  timestamp: string;
}

const now = () => new Date().toISOString();

const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

export const createAuditLog = async (
  action: AuditAction,
  entityType: string,
  entityId: string,
  details: Record<string, any> = {}
): Promise<void> => {
  try {
    const userId = await AsyncStorage.getItem('userId') || 'unknown';
    const userRole = await AsyncStorage.getItem('userRole') || 'unknown';

    await execute(
      `INSERT INTO audit_log (id, action, entity_type, entity_id, user_id, user_role, details, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        action,
        entityType,
        entityId,
        userId,
        userRole,
        JSON.stringify(details),
        now(),
      ]
    );
  } catch (error) {
    console.error('[Audit] Failed to create log:', error);
  }
};

export const auditLogin = (userId: string) =>
  createAuditLog('LOGIN', 'user', userId, { method: 'pin' });

export const auditLogout = (userId: string) =>
  createAuditLog('LOGOUT', 'user', userId, {});

export const auditProjectCreate = (projectId: number, projectName: string) =>
  createAuditLog('PROJECT_CREATE', 'project', projectId.toString(), { name: projectName });

export const auditProjectUpdate = (projectId: number, changes: Record<string, any>) =>
  createAuditLog('PROJECT_UPDATE', 'project', projectId.toString(), changes);

export const auditProjectDelete = (projectId: number, projectName: string) =>
  createAuditLog('PROJECT_DELETE', 'project', projectId.toString(), { name: projectName });

export const auditMaterialAssign = (projectId: number, materialName: string, quantity: number) =>
  createAuditLog('MATERIAL_ASSIGN', 'project', projectId.toString(), {
    material: materialName,
    quantity
  });

export const auditRequestApprove = (requestId: number, material: string) =>
  createAuditLog('REQUEST_APPROVE', 'supply_request', requestId.toString(), { material });

export const auditRequestReject = (requestId: number, reason: string) =>
  createAuditLog('REQUEST_REJECT', 'supply_request', requestId.toString(), { reason });

export const auditDataExport = (exportType: string, recordCount: number) =>
  createAuditLog('DATA_EXPORT', 'report', exportType, { recordCount });

export const getRecentAuditLogs = async (limit: number = 50): Promise<AuditLogEntry[]> => {
  const result = await query<AuditLogEntry>(
    `SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?`,
    [limit]
  );
  return result;
};
