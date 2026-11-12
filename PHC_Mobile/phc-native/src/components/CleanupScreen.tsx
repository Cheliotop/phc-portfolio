import React, { useState, useEffect } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { initializeDatabase } from '../db/init';
import { COLORS, SPACING, TYPE } from '../theme/phcTheme';

interface CleanupScreenProps {
  onComplete: () => void;
}

const CleanupScreen: React.FC<CleanupScreenProps> = ({ onComplete }) => {
  const [logs, setLogs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, msg]);
  };

  useEffect(() => {
    const cleanupStartedAt = Date.now();
    console.info(`[StartupTiming] CleanupScreen mounted t=${cleanupStartedAt}`);

    const runCleanupAndInit = async () => {
      try {
        addLog('PHC Native - Inicializando sistema');
        addLog('Preparando base de datos local...');

        const databaseStartedAt = Date.now();
        console.info(`[StartupTiming] SQLite init started t=${databaseStartedAt}`);
        await initializeDatabase();
        console.info(
          `[StartupTiming] SQLite init resolved durationMs=${Date.now() - databaseStartedAt} t=${Date.now()}`,
        );

        addLog('Sistema listo para usar');
        setIsLoading(false);
        setTimeout(() => {
          console.info(
            `[StartupTiming] CleanupScreen complete durationMs=${Date.now() - cleanupStartedAt} t=${Date.now()}`,
          );
          onComplete();
        }, 500);

      } catch (error: any) {
        console.error('Cleanup error:', error);
        addLog(`Error durante inicializacion: ${error?.message || 'Error desconocido'}`);
        addLog('Continuando en modo limitado...');
        setIsLoading(false);
        setTimeout(() => {
          onComplete();
        }, 1000);
      }
    };

    // Start cleanup after a brief delay
    const timer = setTimeout(() => {
      runCleanupAndInit();
    }, 500);

    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>PHC Native</Text>
      <Text style={styles.subtitle}>Sistema de Gestión de Perforación</Text>

      {isLoading && (
        <ActivityIndicator size="large" color={COLORS.primary} style={styles.spinner} />
      )}

      <View style={styles.logContainer}>
        {logs.map((log, index) => (
          <Text key={index} style={styles.logText}>{log}</Text>
        ))}
      </View>

      <Text style={styles.footer}>
        {isLoading ? 'Inicializando...' : 'Listo'}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  title: {
    fontSize: TYPE.h1,
    fontWeight: 'bold',
    color: COLORS.primaryText,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: TYPE.bodyLg,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xxxl,
    textAlign: 'center',
  },
  spinner: {
    marginVertical: SPACING.xl,
  },
  logContainer: {
    marginTop: SPACING.xxxl,
    width: '100%',
    maxHeight: 300,
  },
  logText: {
    color: COLORS.textSecondary,
    fontSize: TYPE.label,
    marginBottom: SPACING.sm,
    fontFamily: 'monospace',
    textAlign: 'left',
  },
  footer: {
    marginTop: SPACING.xl,
    fontSize: TYPE.label,
    color: COLORS.textMuted,
    textAlign: 'center',
  },
});

export default CleanupScreen;
