# Procedencia de la distribución completa

Fuente: árbol de trabajo local PHC el12 de noviembre de2026. Base confirmada
2ce73e868485, más cambios locales de gestión de cuentas, pruebas, lockfile web y
migración20261112093524. Incluye58 migraciones. El GitHub privado estaba en
afd00c1c304b; el backend inspeccionado tenía55 migraciones hasta20261110100000.
Esta copia no implica despliegue de los cambios locales pendientes.

El inventario SOURCE_INVENTORY.json enumera los archivos de aplicación, backend,
pruebas, scripts y configuración considerados. Incluye código de Android/web,
recursos, Gradle wrapper, funciones, fixtures y soporte de build. Se excluyen
metadata del editor y capturas con datos operativos. Los documentos internos,
credenciales, backups y builds generados no se trasladan a la distribución.
El servidor Express retirado no es parte del sistema vigente.

Adaptaciones de publicación: reemplazo de identificadores/valores de producción;
lectura dinámica de claves del contenedor local para tests; rutas de herramientas
configurables; modo web local explícito; plantilla de backup restringida a repos
privados; helpers de configuración y documentación pública. Los secretos no se
reemplazan por claves funcionales de producción.

El historial público empieza en la muestra anterior, sin el historial privado.
La autorización del propietario permite mostrar el código y marca; no se asignó
una licencia de reutilización adicional.
