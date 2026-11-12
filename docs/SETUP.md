# Ejecutar el sistema completo en un entorno propio

Esta edición incluye Android nativo y recursos, frontend web, funciones de servidor,
58 migraciones, datos sintéticos, suites de base de datos, scripts de build y CI.
Requiere dependencias externas instaladas; no incluye credenciales ni datos del cliente.

## Requisitos

- Node22 para móvil y Node24 para web; npm y Docker.
- Supabase CLI2.117.0 para reproducir el flujo de CI de base de datos.
- Para Android: JDK17, Android SDK/API36, emulador y herramientas de plataforma.
- Para los harnesses opcionales de aceptación: Playwright/Chromium, Deno y adb.

## Backend local aislado

En una máquina/entorno de desarrollo separado, sin otro stack usando los mismos
puertos, desde la raíz:

```bash
supabase start
```

El CLI aplica las migraciones del proyecto local. No usar `db push` contra un
proyecto de producción para probar esta muestra. `supabase/01_schema.sql`,
`02_rls_policies.sql`, `migrations_backup_*` y `rollback/` son referencias históricas;
la instalación actual usa únicamente `supabase/migrations/` en orden.

Para crear los usuarios y proyectos sintéticos, seguir
[supabase/seed/README.md](../supabase/seed/README.md). El seeder rechaza bases con
contenido y destinos que no sean locales; no requiere datos del cliente.
El helper de JWT obtiene la clave del contenedor Auth local en memoria. No contiene
claves privadas fijas. `PHC_LOCAL_AUTH_CONTAINER` permite cambiar el nombre local.

Preparar los clientes después de iniciar el backend:

```bash
python scripts/prepare-local-env.py
```

Esto crea archivos ignorados `.env.local` con una clave **anon** local. Nunca escribe
una clave service-role en el cliente y rechaza sobreescribir configuración existente.

## Web

```bash
cd PHC_Web_Admin
npm ci
npm test
npm run build
npm run dev
```

El modo `VITE_PHC_LOCAL_QA=true` permite exclusivamente el backend HTTP local en
puerto54321. Login de prueba: los usuarios sintéticos documentados en el seeder.

## Android

```bash
cd PHC_Mobile/phc-native
npm ci
npm run typecheck
npm test -- --runInBand --silent
```

Si no existe la clave debug, generar una propia para desarrollo:

```bash
keytool -genkeypair -keystore android/app/debug.keystore -storepass android -alias androiddebugkey -keypass android -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000
```

Luego, desde la raíz:

```bash
bash scripts/build-local-qa-apk.sh
```

El emulador accede al backend del host por `10.0.2.2:54321`. Los APK/AAB generados
van a `releases/`. No se distribuyen claves de firma del cliente ni un APK conectado
a producción. Las firmas de release se configuran con claves del nuevo propietario.

## Proyecto Supabase propio y despliegue

Para un proyecto alojado propio, ejecutar `python scripts/configure-project.py REF`
y definir URL y clave pública en los archivos de entorno del cliente. El script
actualiza los marcadores de host en móvil, validación de release, web y CSP.
Revisar las migraciones en un entorno de prueba antes del despliegue propio.

Las Edge Functions en `supabase/functions/` necesitan los secretos correspondientes
en el servidor. Correo requiere un dominio verificado y configuración de Resend.
El cliente nunca debe recibir claves secretas/service-role. La configuración de
Vercel y el endpoint de mantenimiento están incluidos.

El workflow de backup se conserva como plantilla, pero solo puede ejecutarse en
un repositorio **privado**: los dumps de bases reales no deben ser artifacts de
un repositorio público. No configurar secretos de producción en esta muestra.

## Scripts históricos

`start-local-qa-backend.*`, `run-local-qa-smoke.*` y `smoke-local-qa-backend.js`
corresponden al servidor Express retirado y se conservan como historia. No son el
procedimiento actual. El backend vigente es Supabase. El código del antiguo
servidor no forma parte del software vigente.
