# Comprobaciones locales

La muestra está preparada para lectura del código y ejecución de pruebas. No
incluye el entorno del cliente ni credenciales. Node 24 es una base adecuada para
las pruebas web que ejecutan TypeScript directamente; el pipeline original usa
Node 22 para móvil y 24 para web.

```bash
cd PHC_Mobile/phc-native
npm ci
npm run typecheck
npm test -- --runInBand --silent
```

Desde otra terminal en la raíz:

```bash
cd PHC_Web_Admin
npm ci
npm test
npm run build
```

Las pruebas no constituyen una demostración de un backend configurado. Las URLs
anonimizadas no resuelven al proyecto del cliente. Para una instalación propia
se debe configurar un proyecto Supabase separado, revisar/aplicar las migraciones
en orden, suministrar claves públicas al cliente y secretos únicamente a las
funciones de servidor, y crear datos sintéticos.

Esta edición conserva las comprobaciones de host del producto: sustituir el
marcador `portfolio-project` en la configuración móvil/web por el proyecto propio
requiere una revisión consciente. El modo local móvil existente usa la dirección
`10.0.2.2:54321` del emulador y la configuración `EXPO_PUBLIC_PHC_LOCAL_QA=true`.
No se incluye un backend de demostración listo para usar.

Se conservó configuración nativa textual para revisión y tests. Los recursos nativos
binarios y la firma de producción fueron excluidos. Los scripts
Android conservados explican las validaciones originales, pero una compilación
firmada requiere preparar el proyecto nativo y claves propias. Las pruebas de
release que inspeccionan archivos nativos pueden requerir esos archivos y se
reportan por separado en VERIFICATION.md.
