# Procedencia y anonimización

Preparado el 12 de noviembre de 2026 para una revisión de trabajo.

| Fuente | Estado observado |
|---|---|
| GitHub privado | `afd00c1c304b` — documentación del release del 10 de noviembre |
| Código local confirmado | `2ce73e868485` — tres commits posteriores, 20 archivos cambiados |
| Cambios locales sin commit | Gestión de cuentas, pruebas y documentación; excluidos de esta muestra |
| Backend inspeccionado en modo lectura | 55 migraciones, última `20261110100000`; 34 tablas ordinarias públicas, todas con RLS habilitado |
| Esta muestra | Fuente confirmada local, 57 migraciones, configuración anonimizada |

Las tres revisiones locales agregan cambios de sesión/cache/autoría en dispositivo
compartido y dos migraciones de seguridad. La copia no implica que esos cambios
se hayan desplegado. La inspección del backend consultó metadatos, no registros
de clientes; habilitar RLS no demuestra por sí solo la corrección de sus políticas.

Se creó una copia nueva sin historial Git. Se excluyeron credenciales, archivos de
entorno reales, claves de firma, paquetes de instalación, capturas operativas,
backups, historial de auditorías, instrucciones internas, binarios nativos de
release y material de despliegue. Se conservaron los gráficos de marca necesarios
para la aplicación con autorización del propietario.

Los valores de conexión son marcadores. Direcciones de ejemplo en tests y el
remitente de pruebas del proveedor de correo son datos sintéticos/de servicio,
no cuentas del cliente. Las funciones de servidor reciben secretos mediante
variables de entorno; sus valores no se incluyen.

No se ha asignado una licencia de reutilización: la autorización para mostrar el
proyecto públicamente no se interpreta como autorización para relicenciarlo.
